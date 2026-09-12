// Engine-native AgentInstance / AgentHistory producer (issue #194).
//
// When the harness activates a job whose element carries
// `zeebe:agentDefinition agentType="external"`, this module mints an engine-native
// `AgentInstance` (Camunda 8.10 / nanobpmn) and streams the agent's ACP turns into
// the append-only `AgentHistory` via the host-provided `@camunda8/orchestration-cluster-api`
// SDK client (`createAgentInstance` / `updateAgentInstance`). This is the DURABLE
// historical/metrics producer that replaces the fragile app-side transcript relay
// side-channel — the relay stays as a live overlay; nothing here removes it.
//
// The ACP → AgentHistory translation is a port of the canonical
// `@nanobpm/agentic/session/acp` `classifyUpdate` bridge (the same classifier the
// transcript-chunk producer uses), so a producer and the engine's read model can
// never diverge on the semantic shape of a turn.
//
// Everything at the process edge is injected (the SDK client, the classifier, the
// clock), so the producer is driven deterministically under `node --test` with an
// in-memory fake client. The producer is ENTIRELY best-effort: a failure to mint or
// append an AgentInstance must NEVER crash the harness or change `job.complete`
// behaviour — the AgentInstance lifecycle is orthogonal to job completion.

import { sessionAcp as defaultSessionAcp } from './agentic.mjs';

// The two AgentInstance surfaces we call on the host SDK client. A client missing
// either method (an older SDK) disables the producer rather than throwing.
const SDK_CREATE = 'createAgentInstance';
const SDK_UPDATE = 'updateAgentInstance';

const isNonBlank = (v) => v != null && String(v).trim() !== '';
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// #229: collapse CR/LF (and other line/para separators) to a single space so a
// multiline engine error can't split one correlation record across several
// worker-log lines — that would both dilute the status/body diagnostic and let a
// crafted error body spoof extra log lines. Used by the one-line #229 renderers.
const oneLine = (v) => String(v).replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ');

// Default create-retry backoff (issue #230). A transient createAgentInstance
// rejection at second 0 (e.g. a lease fence that has not yet settled) must NOT
// forfeit the whole run's durable transcript, so a failed/absent create is
// retried — idempotently, correlated on the elementInstanceKey — rather than
// disabling the producer. Retries are paced by exponential backoff (capped) and
// driven lazily by the ACP hot path, so a create that becomes possible mid-run
// is picked up without hammering the engine.
const DEFAULT_CREATE_RETRY_BASE_MS = 1000;
const DEFAULT_CREATE_RETRY_MAX_MS = 30000;

// Bound on the pre-mint replay buffer (issue #230). Until the create succeeds there
// is no agentInstanceKey to append against, so ACP updates that arrive while a create
// is still being retried are buffered and replayed once the instance mints — that is
// what keeps a transient create failure from silently losing the agent's actual work.
// The buffer is capped so a create that never succeeds cannot grow it without bound;
// once full, further updates are dropped (with a one-time warning) rather than
// evicting the earliest turns, so the replayed transcript stays a contiguous prefix.
// The cap is applied on BOTH a slot count and an approximate byte budget: a streamed
// response can emit many token-chunk notifications, so a raw-count cap alone would let
// a chunk storm exhaust the buffer and silently truncate the transcript — the byte
// budget bounds the actual payload, and dropped updates are COUNTED and reported on
// replay so any truncation is visible rather than silent (issue #230).
const DEFAULT_PRE_MINT_BUFFER_MAX = 1000;
const DEFAULT_PRE_MINT_BUFFER_MAX_BYTES = 8_000_000;

// A terminal COMPLETED update is driven directly (not via the best-effort append
// queue) and RETRIED a bounded number of times: on a successful job end the caller
// settles the job the instant complete() returns, so there is no reactivation to
// retry a rejected terminal transition — a single swallowed failure would strand the
// instance non-terminal forever (issue #230).
const DEFAULT_TERMINAL_RETRY_MAX = 3;

// Bound on complete()'s last-chance create attempt (issue #230). The harness awaits
// complete() BEFORE it settles the job (c8ctl-plugin.js), and the final un-throttled
// createAgentInstance attempt awaits the SDK promise, which has no timeout of its own.
// An AgentInstance outage that hangs that request would otherwise block complete()
// indefinitely and could expire the job lease — the opposite of the "best-effort /
// job completion unaffected" contract. So the final attempt is awaited only up to this
// bound; past it we stop awaiting (the idempotent request is left to settle in the
// background) and let the job settle. `0`/non-positive disables the bound.
const DEFAULT_FINALIZE_TIMEOUT_MS = 10_000;

// Circuit-breaker cap on the number of concurrent, still-in-flight createAgentInstance
// requests (issue #230). Retiring a hung create frees the `creating` slot for a fresh
// retry, but the underlying SDK POST is NOT cancellable — it stays outstanding until it
// finally settles (maybe never, during an engine outage). Because the retry backoff
// starts at ~1s while a hung request isn't retired until finalizeTimeoutMs (~10s),
// frequent ACP updates could otherwise launch a new POST every backoff window while the
// earlier retired-but-hung POSTs are all still in flight, accumulating overlapping
// requests and hammering the engine. This bounds the outstanding POSTs: once this many
// are in flight, maybeStartCreate() pauses new attempts until one settles.
const DEFAULT_MAX_INFLIGHT_CREATES = 3;

// Race a best-effort promise against `timeoutMs`, reporting WHICH won, without ever
// rejecting. Used to bound every create attempt so a hung createAgentInstance can
// neither block activate() (which gates whether the harness runs at all) nor
// complete() (which gates job settlement / lease expiry) — issue #230. Resolves `true`
// when the promise settles (success OR failure — both are best-effort) within the
// window, or `false` when the timeout wins. `timeoutMs<=0` waits unbounded (always
// resolves `true` once the promise settles). The underlying attempt is not cancelled
// (the SDK call is not cancellable) but is left to settle in the background; its late
// result is neutralised by the caller's identity guard, and createAgentInstance is
// idempotent per elementInstanceKey.
function settleWithin(promise, timeoutMs, setTimer = setTimeout) {
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true,
  );
  if (!(timeoutMs > 0)) return settled;
  return new Promise((resolve) => {
    // This is a REQUIRED deadline timer, not a hygiene timer: it is the guarantee
    // that lets activate()/complete() return when the SDK promise is hung, so it must
    // keep the event loop alive until it fires (or is cleared on settle). unref()'ing
    // it would let a client-side hang with no other active handle exit the worker
    // before the bound resolves, defeating the guarantee (issue #230). It is always
    // cleared the instant the promise settles, so it never outlives its purpose.
    const timer = setTimer(() => resolve(false), timeoutMs);
    settled.then((won) => {
      clearTimeout(timer);
      resolve(won);
    });
  });
}

// Await an SDK call up to `timeoutMs`, resolving to its value on success, RE-THROWING
// its rejection, or throwing a synthetic timeout error (tagged `__nanoTimeout`) when
// the deadline wins — the underlying call is left to settle in the background. Unlike
// `settleWithin` (which only reports WHO won) this preserves the call's outcome, so a
// bounded terminal update can still observe success/failure while never blocking job
// settlement on a hung request past its lease (issue #230). `timeoutMs<=0` is unbounded.
async function callWithin(promise, timeoutMs, setTimer = setTimeout) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    // Required deadline timer (see settleWithin) — deliberately NOT unref()'d.
    timer = setTimer(() => {
      const err = new Error(`SDK call timed out after ${timeoutMs}ms`);
      err.__nanoTimeout = true;
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Cap the normalized SDK error body before logging so an oversized/multiline engine
// response can't overwhelm the per-worker log (matches supervisor-engine.mjs).
const SDK_ERROR_BODY_MAX = 500;

// Fold line breaks into a visible inline marker and cap length so a diagnostic stays ONE
// correlatable, volume-bounded log line: a multiline SDK body/message would otherwise
// split the worker log across lines (breaking correlation), and an over-long message
// that embeds a large body would bypass the body cap and flood the log (issue #230).
// Cover the SAME line-separator set as `oneLine` (CR/LF plus U+0085/U+2028/U+2029) so a
// Unicode line separator in an engine body/message can't slip past the guard and split
// the correlation record.
function normalizeSdkText(value, max) {
  let s = String(value).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ⏎ ');
  if (s.length > max) s = `${s.slice(0, max)}… (${s.length} chars)`;
  return s;
}

/**
 * Pull the diagnosable facts out of an SDK/transport rejection so a create/append
 * failure is LOUD and root-causable (issue #230 ask 1 / #229): the HTTP status and
 * the engine's response body distinguish a lease-fence rejection from a schema
 * error — an "SDK status 400" message alone is useless. Tolerant of the various
 * error shapes the `@camunda8/orchestration-cluster-api` client and the underlying
 * transport surface (statusCode / status / nested response / body / data).
 */
export function describeSdkError(err) {
  if (err == null) return { status: null, body: null, message: String(err) };
  const status =
    err.statusCode ??
    err.status ??
    err.response?.status ??
    err.response?.statusCode ??
    (typeof err.code === 'number' ? err.code : null) ??
    null;
  let body =
    err.body ??
    err.responseBody ??
    err.response?.body ??
    err.response?.data ??
    err.data ??
    null;
  if (body != null && typeof body !== 'string') {
    try {
      body = JSON.stringify(body);
    } catch {
      body = String(body);
    }
  }
  // Normalize line breaks and cap BOTH the response body and the error message so a
  // multiline or oversized engine response/error can neither split the single
  // correlatable log line nor bypass the length cap (a message that embeds a large
  // body must not sneak past the body cap) — issue #230. Matches the raw engine
  // adapter's 500-char cap (supervisor-engine.mjs readErrorBody).
  const normalizedBody = body != null ? normalizeSdkText(body, SDK_ERROR_BODY_MAX) : null;
  const rawMessage = isNonBlank(err.message) ? String(err.message) : String(err);
  const message = normalizeSdkText(rawMessage, SDK_ERROR_BODY_MAX);
  return { status: status ?? null, body: normalizedBody, message };
}

// Redact a lease token down to a presence + short tail so it can be logged for
// correlation without leaking the opaque fence value. For a short token a last-4
// tail would reveal most (or all) of the value, so emit a fixed redacted marker
// instead — `isExternalAgentJob` accepts any non-blank token, so a short/custom
// value must never be logged verbatim. The tail is only kept once the token is
// longer than 8 characters, matching the producer's `leaseNote()` threshold so both
// diagnostics disclose the same amount. The presence signal is preserved either way.
export function leaseTokenLabel(leaseToken) {
  if (!isNonBlank(leaseToken)) return 'ABSENT';
  const s = String(leaseToken);
  return s.length > 8 ? `present(…${oneLine(s.slice(-4))})` : 'present(short)';
}

/**
 * Is this activated job an `external` (job-backed) agent job — i.e. one whose
 * element carries `zeebe:agentDefinition agentType="external"`?
 *
 * The engine surfaces exactly this eligibility as the pair of fields it stamps on
 * an external agent job's activation: an opaque per-activation lease token —
 * `leaseToken` on the activated job (Camunda v10 ActivatedJobResult; distinct from
 * the job's `deadline`, nanobpmn #1106) — plus the `elementInstanceKey` the
 * AgentInstance correlates on. The engine-native `aiAgentTask`/`aiAgentSubProcess`
 * variants auto-mint their AgentInstance and never create an activatable job, so any
 * job a worker actually activates that carries a lease token IS an external agent
 * job. Absence of either field means "not an external agent job" → the producer
 * stays fully inert (no behaviour change for ordinary service jobs).
 */
export function isExternalAgentJob(job) {
  if (!isPlainObject(job)) return false;
  return isNonBlank(job.leaseToken) && isNonBlank(job.elementInstanceKey);
}

/** Best-effort provider inference from a model identifier (openai/anthropic/…). */
export function inferProvider(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return 'unknown';
  if (/(gpt|o\d|davinci|openai)/.test(m)) return 'openai';
  if (/(claude|opus|sonnet|haiku|anthropic)/.test(m)) return 'anthropic';
  if (/(gemini|palm|bison|google)/.test(m)) return 'google';
  if (/(llama|meta)/.test(m)) return 'meta';
  if (/(mistral|mixtral)/.test(m)) return 'mistral';
  if (/(deepseek)/.test(m)) return 'deepseek';
  if (/(qwen)/.test(m)) return 'qwen';
  if (/(kimi|moonshot)/.test(m)) return 'moonshot';
  if (/(grok|xai)/.test(m)) return 'xai';
  return 'unknown';
}

/**
 * Seed the concrete agent `definition` (model, provider, systemPrompt) from the
 * actual worker/model that claimed the job. The static `agentDefinition` marker is
 * only the eligibility flag; the concrete definition is runtime — the model comes
 * from the worker profile, the systemPrompt from the resolved base prompt.
 */
export function deriveAgentDefinition({ profile, envelope } = {}) {
  const model = isNonBlank(profile?.model) ? String(profile.model) : 'unknown';
  const provider = isNonBlank(profile?.provider)
    ? String(profile.provider)
    : inferProvider(model);
  const systemPrompt = isNonBlank(envelope?.task?.prompt) ? String(envelope.task.prompt) : '';
  return { model, provider, systemPrompt };
}

// Map the ACP classifier's message role to the AgentHistory role enum. ACP has no
// distinct REASONING role, so a `reasoning` chunk folds into ASSISTANT.
function historyRole(acpRole) {
  return acpRole === 'user' ? 'USER' : 'ASSISTANT';
}

// A short, stable hash for deriving a content-addressed historyItemId when the ACP
// agent omits a messageId (so identical retried content dedups; new content appends).
function shortHash(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Extract per-call metrics from an ACP update when the agent carries them (many
// ACP agents do not — a documented ACP fidelity gap — so this is usually absent).
// Reads the common usage locations and maps to the AgentHistory item metric field
// names. Returns undefined when nothing usable is present.
function extractMetrics(update) {
  const src =
    (isPlainObject(update?.usage) && update.usage) ||
    (isPlainObject(update?.tokenUsage) && update.tokenUsage) ||
    (isPlainObject(update?._meta?.usage) && update._meta.usage) ||
    (isPlainObject(update?.metrics) && update.metrics) ||
    null;
  if (!src) return undefined;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out = {};
  const inputTokens = num(src.inputTokens ?? src.input_tokens ?? src.promptTokens ?? src.prompt_tokens);
  const outputTokens = num(src.outputTokens ?? src.output_tokens ?? src.completionTokens ?? src.completion_tokens);
  const reasoningTokenCount = num(src.reasoningTokenCount ?? src.reasoning_tokens ?? src.reasoningTokens);
  const cacheCreationTokenCount = num(src.cacheCreationTokenCount ?? src.cache_creation_input_tokens ?? src.cacheCreationInputTokens);
  const cacheReadTokenCount = num(src.cacheReadTokenCount ?? src.cache_read_input_tokens ?? src.cacheReadInputTokens);
  const durationMs = num(src.durationMs ?? src.duration_ms ?? src.latencyMs ?? src.latency_ms);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (reasoningTokenCount !== undefined) out.reasoningTokenCount = reasoningTokenCount;
  if (cacheCreationTokenCount !== undefined) out.cacheCreationTokenCount = cacheCreationTokenCount;
  if (cacheReadTokenCount !== undefined) out.cacheReadTokenCount = cacheReadTokenCount;
  if (durationMs !== undefined) out.durationMs = durationMs;
  return Object.keys(out).length ? out : undefined;
}

// A tool-result's `result` becomes an OBJECT content block when it is structured
// JSON, or a TEXT block when it is a plain string. Null/undefined → empty content.
function contentForResult(result) {
  if (result == null) return [];
  if (typeof result === 'string') return [{ contentType: 'TEXT', text: result }];
  return [{ contentType: 'OBJECT', object: result }];
}

/**
 * Create an AgentInstance producer bound to one activated external agent job.
 *
 * Returns a small facade the harness drives:
 *   - `activate()` — mint the AgentInstance (lease-gated on the job) with the
 *     opening CONFIGURATION turn. Idempotent: correlates on the elementInstanceKey,
 *     so a reactivation (ask-a-question loop) folds into the SAME instance and never
 *     creates a second one.
 *   - `ingest(rawUpdate)` — feed one raw ACP `session/update` (non-blocking; the SDK
 *     append is enqueued so the ACP hot path never blocks).
 *   - `complete(ok)` — drain pending appends, then (on a successful job end) update
 *     the instance status to COMPLETED. `job.complete` is unchanged and orthogonal.
 *
 * @param {object} opts
 * @param {object} opts.camunda   Host SDK client (createAgentInstance/updateAgentInstance).
 * @param {object} opts.job       The activated job (jobKey/leaseToken/elementInstanceKey/elementId).
 * @param {object} [opts.profile] The worker profile (model/provider seed the definition).
 * @param {object} [opts.envelope] The normalized task envelope (task.prompt → systemPrompt).
 * @param {object} [opts.logger]  Output-mode-aware logger (warn/info/debug).
 * @param {() => number} [opts.now] Injected clock (ms epoch); defaults to Date.now.
 * @param {object} [opts.sessionAcp] The ACP classifier surface (defaults to the package bridge).
 */
export function createAgentInstanceProducer(opts = {}) {
  const {
    camunda,
    job,
    profile = {},
    envelope = {},
    logger = console,
    now = () => Date.now(),
    sessionAcp = defaultSessionAcp,
    createRetryBaseMs = DEFAULT_CREATE_RETRY_BASE_MS,
    createRetryMaxMs = DEFAULT_CREATE_RETRY_MAX_MS,
    preMintBufferMax = DEFAULT_PRE_MINT_BUFFER_MAX,
    preMintBufferMaxBytes = DEFAULT_PRE_MINT_BUFFER_MAX_BYTES,
    terminalRetryMax = DEFAULT_TERMINAL_RETRY_MAX,
    finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS,
    maxInFlightCreates = DEFAULT_MAX_INFLIGHT_CREATES,
  } = opts;

  const classify = typeof sessionAcp?.classifyUpdate === 'function' ? sessionAcp.classifyUpdate : null;

  const jobKey = job?.jobKey != null ? String(job.jobKey) : '';
  // The activation lease is carried on the job as `leaseToken` (Camunda v10
  // ActivatedJobResult). It is submitted BACK to createAgentInstance/updateAgentInstance
  // as the request-body field `jobLease` (agent-instances.yaml) — the same opaque token,
  // named differently on the two sides of the contract. One internal name here; the
  // translation to `jobLease` happens only at each SDK call below.
  const leaseToken = job?.leaseToken != null ? String(job.leaseToken) : '';
  const elementInstanceKey = job?.elementInstanceKey != null ? String(job.elementInstanceKey) : '';
  const elementId = job?.elementId != null ? String(job.elementId) : null;
  const processInstanceKey = job?.processInstanceKey != null ? String(job.processInstanceKey) : '';
  // #229 cross-channel correlation, compact form. Stamps job/eik/pik so the
  // AgentInstance channel can be joined to the job / relay / git channels. This is the
  // terse rendering used by the observability lines; `correlation()` below is the
  // richer key=value rendering used by the #230 retry diagnostics.
  const corr = () =>
    `job ${jobKey || '?'} eik ${elementInstanceKey || '?'} pik ${processInstanceKey || '?'}`;
  // The lease token is a secret-ish fence token — never log it whole. Only surface a
  // tail when the token is long enough that the tail still hides most of it; otherwise
  // emit a safe digest (presence + length). Enough either way to tell "present" from
  // "absent" and to correlate the activation without exposing the token (#229).
  const leaseNote = () =>
    !leaseToken
      ? 'lease absent'
      : leaseToken.length > 8
        ? `lease …${leaseToken.slice(-4)}`
        : `lease present (len ${leaseToken.length})`;

  // The producer is a no-op unless every precondition holds: a usable SDK client,
  // an external agent job, and the ACP classifier. Any missing piece leaves the
  // harness path byte-for-byte unchanged.
  const usable =
    !!camunda &&
    typeof camunda[SDK_CREATE] === 'function' &&
    typeof camunda[SDK_UPDATE] === 'function' &&
    !!classify &&
    isExternalAgentJob(job);

  // Permanent kill-switch: the producer is inert (no behaviour change for the
  // harness path) unless every precondition holds. This is distinct from a
  // transient create failure — the latter is RETRIED, never permanently disabled
  // (issue #230).
  let disabled = !usable;
  let agentInstanceKey = null;
  // Create-retry bookkeeping. `creating` dedups a concurrent in-flight attempt;
  // `createAttempts` / `lastCreateAttemptAt` pace the exponential backoff so a
  // failing create is re-attempted (idempotently, on the ACP hot path) without
  // hammering the engine. Every attempt carries a monotonic identity (`createGen`);
  // `creatingGen` is the identity of the attempt currently owning the `creating`
  // slot. A bounded await that times out RETIRES its attempt by bumping `createGen`
  // past `creatingGen`, so the hung request's eventual result is dropped by the guard
  // in `doCreate` (it cannot latch a key / replay the buffer late) and the slot is
  // freed for a fresh retry. `finalized` latches once complete() has run its terminal
  // path, hard-stopping any late create from minting an orphaned instance (issue #230).
  let creating = null;
  let creatingGen = 0;
  // True while the attempt owning the `creating` slot is complete()'s one last-chance
  // FINAL attempt. Tracked so retireCreate can emit the correct diagnostic: after the
  // final attempt complete() latches `finalized`, so NO hot-path retry can follow and
  // the timeout message must not promise one (issue #230).
  let creatingFinal = false;
  let createGen = 0;
  // Count of createAgentInstance POSTs currently in flight (started but not yet
  // settled), including RETIRED attempts whose hung request is still outstanding. Caps
  // concurrent uncancellable creates (see `maxInFlightCreates`) so retirement-driven
  // retries can't accumulate against a hung engine (issue #230).
  let createInFlight = 0;
  // Elevate the FIRST create-retirement (bounded-out hung request) to `warn` so a
  // timed-out AgentInstance create is visible even when a later retry succeeds;
  // subsequent retirements stay `debug` to avoid a warn storm during an outage.
  let createTimeoutLogged = false;
  let finalized = false;
  // Latches true while complete() is running its terminal last-chance path. A create
  // retired during that path (via awaitCreateBounded) is NOT followed by a hot-path
  // retry even when it is non-final — complete() latches `finalized` immediately after —
  // so retireCreate must not promise one (issue #230).
  let finalizing = false;
  let createAttempts = 0;
  let lastCreateAttemptAt = 0;
  let loopIteration = 0;
  let queue = Promise.resolve();
  // Coalesce streamed message chunks (same messageId + role) into one turn, flushed
  // on a role/message boundary, a tool event, or completion — the engine dedups on
  // historyItemId (it does NOT merge), so a turn must be appended exactly once, whole.
  let pendingMessage = null;
  // callId → toolName, so a TOOL_RESULT turn can reference the originating call name.
  const toolNames = new Map();
  // Count of AgentHistory turns the ENGINE actually created (via `res.createdHistory`,
  // not the attempt), for the completion diagnostic — separates "create failed" from
  // "created but nothing ingested over a long run", and a deduplicated no-op from a
  // real append (issue #230 / #229 / #232).
  let appendedTurns = 0;
  // Elevate the FIRST per-turn append failure to `warn` (repeats stay `debug`) so a
  // 400/404 append storm is visible without flooding the log (issue #230 / #229).
  let appendFailureLogged = false;
  // #229 first-failure elevation for ingest faults (classifier OR handler): the FIRST
  // per-instance ingest failure logs at `warn`, repeats stay at `debug`.
  let ingestFailureLogged = false;
  // #229 turn accounting: when the instance was minted, so `complete()` can log
  // "N turns over Xm" and separate the 0-turns husk from a healthy run.
  let activatedAt = 0;
  // Pre-mint replay buffer (issue #230): ACP updates that arrive after an activation
  // attempt but before the instance has minted are held here (bounded) and replayed
  // in arrival order once `agentInstanceKey` becomes available, so a create that
  // succeeds on a retry does not lose the turns emitted while it was still failing.
  const preMintBuffer = [];
  let preMintOverflowLogged = false;
  // Approximate byte weight of the buffered updates + a count of updates dropped on
  // overflow, so a truncated pre-mint replay is reported (not silent) at replay time.
  let preMintBufferBytes = 0;
  let preMintDropped = 0;

  const iso = () => new Date(now()).toISOString();

  // Serialize an SDK call onto the queue so appends preserve order and `complete`
  // can drain them. A rejection is swallowed (best-effort) but never breaks the chain.
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      logger?.debug?.(`AgentInstance producer: SDK call failed — ${err?.message || err}`);
    });
    return queue;
  };

  // Append one AgentHistory turn via updateAgentInstance (one turn per call keeps the
  // dedup boundary crisp). Only ever runs once the instance is minted.
  const appendTurn = (turn, status) => {
    if (disabled || !agentInstanceKey) return;
    enqueue(async () => {
      const req = {
        agentInstanceKey,
        elementInstanceKey,
        jobKey,
        jobLease: leaseToken,
        history: [turn],
      };
      if (status) req.status = status;
      try {
        // BOUND the append (finalizeTimeoutMs). Appends are serialized on `queue`, and
        // complete() awaits that queue before settling the job; an append that HANGS
        // (rather than rejects) would otherwise stall the drain and hold the lease
        // until it expires during an AgentInstance outage. A timeout is tagged
        // `__nanoTimeout` and swallowed by the catch below like any other append
        // failure — best-effort, never breaks the chain (issue #230).
        const res = await callWithin(camunda[SDK_UPDATE](req), finalizeTimeoutMs);
        // #229/#232: the engine dedups appends by historyItemId, so a retry or a
        // reactivation can return 200 while creating ZERO new history entries. Count
        // what the engine actually CREATED (`res.createdHistory`) — not the attempt —
        // so the completion counter separates a real append from a deduplicated no-op
        // and keeps the 0-turns husk diagnosis honest. Fall back to +1 only when the
        // response omits the field (older engine), so a genuine append is never
        // under-counted.
        appendedTurns += Array.isArray(res?.createdHistory) ? res.createdHistory.length : 1;
      } catch (err) {
        const d = describeSdkError(err);
        // ONE canonical append-failure diagnostic (issue #230 / #229): the shaped
        // key=value line (status/message/body) plus the correlation keys, so a 400/404
        // append storm is both root-causable and joinable to the job/relay channels.
        // The FIRST per-turn failure elevates to `warn` (with the "repeats stay debug"
        // hint); the rest stay `debug` so the log isn't flooded.
        const line =
          `AgentInstance producer: ${SDK_UPDATE} append failed — ` +
          `status=${d.status ?? 'n/a'} message=${d.message} body=${d.body ?? 'n/a'} ${correlation()}.`;
        if (!appendFailureLogged) {
          appendFailureLogged = true;
          logger?.warn?.(`${line} Further append failures for this instance stay at debug.`);
        } else {
          logger?.debug?.(line);
        }
      }
    });
  };

  const flushMessage = () => {
    if (!pendingMessage) return;
    const text = pendingMessage.texts.join('');
    const hasText = text.trim() !== '';
    const hasMetrics = pendingMessage.metrics !== undefined;
    const msg = pendingMessage;
    pendingMessage = null;
    if (!hasText && !hasMetrics) return;
    const idBasis = isNonBlank(msg.messageId) ? String(msg.messageId) : `h:${shortHash(text)}`;
    const turn = {
      historyItemId: `${msg.role.toLowerCase()}:${idBasis}`,
      loopIteration: msg.loopIteration,
      role: msg.role,
      content: hasText ? [{ contentType: 'TEXT', text }] : [],
      producedAt: msg.producedAt,
    };
    if (msg.role === 'ASSISTANT' && hasMetrics) turn.metrics = msg.metrics;
    appendTurn(turn, msg.role === 'ASSISTANT' ? 'THINKING' : undefined);
    // A completed ASSISTANT response ends one loop iteration.
    if (msg.role === 'ASSISTANT') loopIteration += 1;
  };

  const onToolCall = (c) => {
    flushMessage();
    if (isNonBlank(c.name)) toolNames.set(String(c.callId), String(c.name));
    const turn = {
      historyItemId: `toolcall:${c.callId}`,
      loopIteration,
      role: 'ASSISTANT',
      content: [],
      toolCalls: [
        {
          toolCallId: String(c.callId),
          toolName: isNonBlank(c.name) ? String(c.name) : '',
          elementId,
          arguments: isPlainObject(c.args) ? c.args : null,
        },
      ],
      producedAt: iso(),
    };
    appendTurn(turn, 'TOOL_CALLING');
  };

  const onToolResult = (c) => {
    flushMessage();
    const turn = {
      historyItemId: `toolresult:${c.callId}`,
      loopIteration,
      role: 'TOOL_RESULT',
      content: contentForResult(c.result),
      toolCalls: [
        {
          toolCallId: String(c.callId),
          toolName: toolNames.get(String(c.callId)) || '',
          elementId,
          arguments: null,
        },
      ],
      producedAt: iso(),
    };
    appendTurn(turn);
  };

  const correlation = () =>
    `[jobKey=${jobKey || 'n/a'} elementInstanceKey=${elementInstanceKey || 'n/a'} ` +
    `processInstanceKey=${processInstanceKey || 'n/a'}]`;

  // #229: first-failure elevation for ingest faults (classifier OR handler). The FIRST
  // ingest failure per instance logs at `warn`; repeats stay at `debug` so a
  // persistently-faulting instance doesn't flood the log.
  const noteIngestFailure = (err) => {
    if (!ingestFailureLogged) {
      ingestFailureLogged = true;
      logger?.warn?.(
        `AgentInstance producer: ingest failed (${corr()}) — ${oneLine(err?.message || err)}; further ingest failures for this instance stay at debug.`,
      );
    } else {
      logger?.debug?.(`AgentInstance producer: ingest failed (${corr()}) — ${oneLine(err?.message || err)}`);
    }
  };

  // Build the opening CONFIGURATION turn from the concrete runtime definition.
  const buildConfigTurn = () => {
    const def = deriveAgentDefinition({ profile, envelope });
    const configTurn = {
      historyItemId: `configuration:${elementInstanceKey}`,
      loopIteration: 1,
      role: 'CONFIGURATION',
      content: [],
      producedAt: iso(),
      model: def.model,
      provider: def.provider,
    };
    if (isNonBlank(def.systemPrompt)) {
      configTurn.systemPrompt = [{ contentType: 'TEXT', text: def.systemPrompt }];
    }
    const limits = deriveLimits(envelope);
    if (limits) configTurn.limits = limits;
    return { def, configTurn };
  };

  // Exponential backoff (capped) for the Nth create attempt (1-based).
  const backoffForAttempt = (attempt) =>
    Math.min(createRetryMaxMs, createRetryBaseMs * Math.pow(2, Math.max(0, attempt - 1)));

  // Perform ONE createAgentInstance attempt, tagged with the caller-supplied identity
  // `gen`. On success the instance key is latched (unless the attempt was retired or
  // the producer finalized — see the guard below); on failure it is logged LOUDLY
  // (status + body + lease presence + correlation) and the producer is left retryable
  // — NOT disabled (issue #230). `final` marks complete()'s one last-chance attempt,
  // after which NO further retry happens, so the diagnostic must not promise one.
  const doCreate = async ({ gen = 0, final = false } = {}) => {
    // Capture THIS attempt's number locally. `createAttempts` is a shared mutable
    // counter and timed-out attempts overlap later retries, so reading the global at
    // log time could report a late result from attempt 1 as attempt 2 (with the wrong
    // retry context). All of this attempt's diagnostics use the local `attempt`.
    const attempt = (createAttempts += 1);
    // A failure on the FINAL attempt won't be retried (the producer is about to be
    // discarded), so don't tell operators to wait for a recovery that can't happen.
    const retryClause = final
      ? `no further create will be attempted (final attempt; ` +
        `job completion unaffected).`
      : `will retry (durable transcript resumes once the create succeeds; ` +
        `job completion unaffected).`;
    const { def, configTurn } = buildConfigTurn();
    try {
      const res = await camunda[SDK_CREATE]({
        elementInstanceKey,
        jobKey,
        jobLease: leaseToken,
        history: [configTurn],
      });
      // Treat a blank/whitespace key as "no key". Updates need a usable
      // agentInstanceKey, so an empty ('' or whitespace-only) value must take the
      // keyless retry path rather than latch state, log a mint, and replay the pre-mint
      // buffer against an invalid key (issue #230).
      const rawKey = res && (res.agentInstanceKey ?? res.key);
      const key = isNonBlank(rawKey) ? String(rawKey).trim() : null;
      if (!key) {
        // A RETIRED or post-finalization attempt that resolves late without a usable
        // key must NOT emit the ordinary "will retry" warning: maybeStartCreate() won't
        // retry once a key/finalization is latched, so promising a retry (and reading
        // the mutable global attempt counter) would be a misleading diagnostic after
        // complete() already settled the job. Mirror the throw path's late guard and
        // report it as dropped instead (issue #230).
        if (finalized || gen !== createGen) {
          logger?.debug?.(
            `AgentInstance producer: createAgentInstance resolved without a usable key ` +
              `late for a retired attempt (attempt ${attempt}) ${correlation()}; result ` +
              `dropped (no retry — key/finalization already latched).`,
          );
          return false;
        }
        // createAgentInstance resolved but carried no key — updates need the
        // agentInstanceKey, so we cannot append yet. Idempotent per
        // elementInstanceKey, so keep retrying rather than forfeiting the run. Log the
        // SAME request-context fields the throw path does (with explicit status/body
        // n/a, since the call resolved) so an unexpected success shape is diagnosable
        // against the request that produced it (issue #230).
        logger?.warn?.(
          `AgentInstance producer: createAgentInstance returned no agentInstanceKey ` +
            `(attempt ${attempt}) — status=n/a body=n/a ` +
            `jobLease=${leaseTokenLabel(leaseToken)} model=${oneLine(def.model)} provider=${oneLine(def.provider)} ` +
            `${correlation()}; ${retryClause}`,
        );
        return false;
      }
      // Identity + finalization guard: a RETIRED attempt (its bounded await timed out,
      // so `createGen` was bumped past our `gen`) or a producer that has already
      // finalized (complete() returned) must NOT latch state. A late success would
      // otherwise set agentInstanceKey and replay the pre-mint buffer into an orphaned,
      // non-terminal AgentInstance AFTER the job was settled without a COMPLETED update
      // (issue #230). The mint is idempotent per elementInstanceKey, so dropping the
      // late result is safe — a live retry (or none) owns the state instead.
      if (finalized || gen !== createGen) {
        logger?.debug?.(
          `AgentInstance producer: createAgentInstance succeeded late for a retired ` +
            `attempt (attempt ${attempt}) ${correlation()}; result dropped ` +
            `(idempotent per element instance).`,
        );
        return false;
      }
      agentInstanceKey = key;
      loopIteration = 1;
      activatedAt = now();
      logger?.info?.(
        `AgentInstance ${agentInstanceKey} minted for element instance ${elementInstanceKey} ` +
          `(job ${jobKey}, attempt ${attempt}) ${correlation()} ` +
          `(${leaseNote()}; model ${oneLine(def.model)}/${oneLine(def.provider)}).`,
      );
      replayPreMintBuffer();
      return true;
    } catch (err) {
      // A RETIRED or post-finalization attempt that rejects late must not emit the
      // ordinary "will retry" warning: maybeStartCreate() will not retry once a key or
      // finalization is latched, so promising a retry (and reading the mutable global
      // attempt counter) would be misleading. Report it quietly instead (issue #230).
      if (finalized || gen !== createGen) {
        const d = describeSdkError(err);
        logger?.debug?.(
          `AgentInstance producer: createAgentInstance failed late for a retired ` +
            `attempt (attempt ${attempt}) — status=${d.status ?? 'n/a'} message=${d.message} ` +
            `body=${d.body ?? 'n/a'} jobLease=${leaseTokenLabel(leaseToken)} ` +
            `model=${oneLine(def.model)} provider=${oneLine(def.provider)} ` +
            `${correlation()}; result dropped (no retry — key/finalization already latched).`,
        );
        return false;
      }
      const d = describeSdkError(err);
      // ONE canonical create-failure diagnostic (issue #230 / #229): the shaped
      // key=value line carrying the HTTP status + engine body (a lease fence vs a
      // schema error), the masked lease, model/provider, the correlation keys, and
      // the honest retry clause. First-per-instance elevation is inherent to the
      // retry loop (a distinct attempt number each time).
      logger?.warn?.(
        `AgentInstance producer: createAgentInstance failed (attempt ${attempt}) — ` +
          `status=${d.status ?? 'n/a'} message=${d.message} body=${d.body ?? 'n/a'} ` +
          `jobLease=${leaseTokenLabel(leaseToken)} model=${oneLine(def.model)} provider=${oneLine(def.provider)} ` +
          `${correlation()}; ${retryClause}`,
      );
      return false;
    } finally {
      // Anchor the backoff on when the attempt SETTLES, not when it started: a slow
      // failure (network/timeout) must pace the NEXT attempt from the moment it failed.
      // Recording at request start would let a failure that outlasts the current
      // backoff window trigger another request immediately, defeating the exponential
      // pacing and risking a retry storm during an outage (issue #230). Only record
      // while THIS generation still owns the slot: a retired attempt already had its
      // retirement time recorded (retireCreate), and a stale late settle overwriting it
      // could push the anchor forward and postpone a live attempt's next retry based on
      // the old request's completion rather than the current one (issue #230).
      if (gen === createGen) lastCreateAttemptAt = now();
    }
  };

  // Retire the create attempt that owns the slot at identity `gen`: bump `createGen`
  // past it (so its eventual late result is dropped by doCreate's guard), free the
  // `creating` slot for a fresh retry, and RECORD the retirement as the latest attempt
  // time. Recording the timestamp is essential: a hung attempt's own `finally` won't
  // run until the SDK promise finally settles (maybe never), so without this the next
  // ACP update would see the stale `lastCreateAttemptAt` and fire immediately, letting
  // repeated hung attempts pile up concurrently and defeat the backoff (issue #230).
  // No-op unless `gen` still owns the slot (it may have already settled/been retired).
  const retireCreate = (gen) => {
    if (creatingGen !== gen || creating == null) return false;
    const wasFinal = creatingFinal;
    createGen += 1; // > creatingGen ⇒ the hung attempt's late result is dropped
    creating = null;
    creatingGen = 0;
    creatingFinal = false;
    lastCreateAttemptAt = now();
    // A hung create that is bounded out and retired here would otherwise vanish
    // silently: retireCreate only updates state, and if a later retry succeeds the
    // original timeout leaves no trace — making a stuck AgentInstance request
    // indistinguishable from a run with no ACP traffic. Emit a bounded timeout
    // diagnostic (attempt + correlation) so the timeout is visible. This attempt owns
    // the slot, so `createAttempts` is its number (no newer attempt has started). First
    // retirement is `warn`; the rest are `debug` to avoid a warn storm (issue #230).
    // The FINAL last-chance attempt is followed by `finalized` in complete(), so NO
    // hot-path retry can mint the instance afterwards — its diagnostic must not promise
    // one (matching doCreate's `final` retry clause), or operators would wait for a
    // recovery that can't happen (issue #230). The same holds for a NON-final attempt
    // retired while complete() is finalizing (`finalizing`): complete() latches
    // `finalized` right after awaiting it, so no hot-path retry follows there either.
    const retryClause =
      wasFinal || finalizing
        ? `no further create will be attempted (${
            wasFinal ? 'final attempt' : 'completion in progress'
          }; job completion unaffected).`
        : `a later hot-path retry will attempt to mint the instance (job completion unaffected).`;
    const line =
      `AgentInstance producer: createAgentInstance did not settle within ` +
      `${finalizeTimeoutMs}ms (attempt ${createAttempts}) — request RETIRED and left to ` +
      `settle in the background ${correlation()}; ${retryClause}`;
    if (!createTimeoutLogged) {
      createTimeoutLogged = true;
      logger?.warn?.(line);
    } else {
      logger?.debug?.(line);
    }
    return true;
  };

  // Start ONE create attempt, own the `creating` slot, and track its identity so a
  // retired (timed-out) attempt's late settle can neither clear a newer attempt's slot
  // nor latch orphaned state. EVERY attempt is self-supervised: if it hasn't settled
  // within `finalizeTimeoutMs` it is retired, so a hung createAgentInstance started off
  // the non-awaited ACP hot path (ingest → maybeStartCreate) can't leave `creating`
  // non-null forever — which would buffer every later ingest and refuse all retries
  // until complete() (issue #230). Returns the (wrapped, never-rejecting) promise.
  const startCreate = (opts = {}) => {
    const gen = (createGen += 1);
    creatingGen = gen;
    creatingFinal = opts.final === true;
    createInFlight += 1;
    const p = doCreate({ ...opts, gen })
      .catch(() => false)
      .finally(() => {
        // The POST has finally settled — free its in-flight slot in the concurrency
        // cap regardless of whether this attempt still owns the `creating` slot (a
        // retired attempt no longer owns it but was still counted while hung).
        createInFlight -= 1;
        // Only free the shared slot if THIS attempt still owns it — a retired attempt
        // that settles late must not null a newer attempt's `creating` promise.
        if (creatingGen === gen) {
          creating = null;
          creatingGen = 0;
          creatingFinal = false;
        }
      });
    creating = p;
    // Fire-and-forget retirement supervision (bounds even non-awaited hot-path
    // attempts). Never rejects; a no-op if the attempt settled or was already retired.
    void settleWithin(p, finalizeTimeoutMs).then((settled) => {
      if (!settled) retireCreate(gen);
    });
    return p;
  };

  // Await the in-flight create up to `finalizeTimeoutMs`, reporting nothing but
  // RETIRING the attempt on timeout: a hung createAgentInstance must not block
  // activate() (which gates whether the harness runs) or complete() (which gates job
  // settlement / lease expiry). Retiring bumps the identity past the hung attempt (so
  // its late result is dropped in doCreate) and frees the slot so a later retry isn't
  // wedged behind the stuck request forever (issue #230). Callers that must observe the
  // retirement synchronously on return use this; startCreate's supervision is the
  // backstop for attempts nobody awaits.
  const awaitCreateBounded = async () => {
    const pending = creating;
    const gen = creatingGen;
    if (!pending) return;
    const settled = await settleWithin(pending, finalizeTimeoutMs);
    // Only retire if it genuinely timed out AND still owns the slot (it may have
    // settled in the same tick the timer fired, in which case its finally already
    // freed the slot / started nothing new).
    if (!settled && creating === pending) retireCreate(gen);
  };

  // Kick off a create attempt if one is warranted and the backoff window has
  // elapsed. Non-blocking: dedups a concurrent attempt and never throws. Called
  // from the ACP hot path (`ingest`) so a create that becomes possible mid-run is
  // retried without a dedicated timer.
  const maybeStartCreate = () => {
    if (disabled || agentInstanceKey || creating || finalized) return;
    // Circuit-breaker: don't launch a fresh retry while `maxInFlightCreates` create
    // POSTs are still outstanding. Retiring a hung attempt frees the `creating` slot,
    // but its uncancellable SDK call stays in flight until it settles; without this
    // cap, frequent ACP updates would keep starting new retries (backoff base ~1s)
    // while earlier retired-but-hung POSTs (bounded at finalizeTimeoutMs) remain in
    // flight, accumulating overlapping requests and hammering the engine during an
    // outage. Pausing here until an in-flight create settles bounds the overlap; a
    // recovered engine settles those requests and re-opens the retry path (issue #230).
    if (maxInFlightCreates > 0 && createInFlight >= maxInFlightCreates) return;
    if (createAttempts > 0 && now() - lastCreateAttemptAt < backoffForAttempt(createAttempts)) return;
    startCreate();
  };

  // Classify one raw ACP `session/update` and append the resulting turn(s). Assumes
  // the instance is already minted (an append needs the agentInstanceKey). Malformed
  // or ignored updates are dropped. Never throws. Shared by the hot path (`ingest`)
  // and the pre-mint replay so both translate a turn identically.
  const ingestClassified = (rawUpdate) => {
    let classified;
    try {
      classified = classify(rawUpdate);
    } catch (err) {
      // A classifier/translation fault is an ingest failure too — route it through the
      // same first-failure elevation (#229) instead of returning silently, or the
      // ingest path can still drop every turn with no warning.
      noteIngestFailure(err);
      return;
    }
    if (!classified || typeof classified !== 'object') return;
    try {
      switch (classified.kind) {
        case 'message': {
          const role = historyRole(classified.role);
          if (
            pendingMessage &&
            (pendingMessage.messageId !== classified.messageId || pendingMessage.role !== role)
          ) {
            flushMessage();
          }
          if (!pendingMessage) {
            pendingMessage = {
              role,
              messageId: classified.messageId ?? null,
              texts: [],
              metrics: undefined,
              loopIteration,
              producedAt: iso(),
            };
          }
          if (isNonBlank(classified.text)) pendingMessage.texts.push(String(classified.text));
          const m = extractMetrics(rawUpdate);
          if (m) pendingMessage.metrics = { ...(pendingMessage.metrics || {}), ...m };
          break;
        }
        case 'tool-call':
          onToolCall(classified);
          break;
        case 'tool-result':
          onToolResult(classified);
          break;
        default:
          break;
      }
    } catch (err) {
      // #229: elevate the FIRST ingest failure per instance to `warn` (repeats stay
      // `debug`) so a translation/append fault that silently drops every turn is
      // visible at normal verbosity.
      noteIngestFailure(err);
    }
  };

  // Hold a pre-mint ACP update for later replay, bounded so a create that never
  // succeeds cannot grow the buffer without bound. Bounded by BOTH a slot count and an
  // approximate byte budget — a streamed response can emit many token-chunk
  // notifications, so a raw-count cap alone would let a chunk storm exhaust the buffer.
  // Once either cap is hit, drop the newest update (keeping the buffered prefix
  // contiguous) and COUNT the drop so the truncation is reported (not silent) on
  // replay. The byte cap applies even to the FIRST buffered update: a single oversized
  // update (e.g. a large tool-result) is dropped and counted rather than retained in
  // full, so the buffer stays bounded even in the worst case — an outage that only ever
  // sees oversized updates keeps NO turns but never grows the buffer.
  const sizeOfUpdate = (u) => {
    try {
      return JSON.stringify(u)?.length ?? 0;
    } catch {
      return 0;
    }
  };
  // Would this raw update classify to a persisted history turn (message/tool-call/
  // tool-result)? The replay path (ingestClassified) IGNORES everything else — e.g.
  // `plan`/status notifications — so buffering them would let a plan/status burst
  // consume the count/byte caps during a create outage and starve later message/tool
  // updates. Filter them out before buffering; arrival order is preserved because an
  // ignored update contributes no turn on replay anyway (issue #230).
  const PERSISTED_KINDS = new Set(['message', 'tool-call', 'tool-result']);
  const classifiesToPersistedTurn = (rawUpdate) => {
    if (!classify) return false;
    let classified;
    try {
      classified = classify(rawUpdate);
    } catch (err) {
      // A classifier fault on the pre-mint path would otherwise be swallowed here, so
      // the FIRST per-instance ingest failure during a create outage would never reach
      // noteIngestFailure() and the warn-once diagnostic would be absent exactly when
      // it matters (issue #230). Report it before dropping the update.
      noteIngestFailure(err);
      return false;
    }
    return !!classified && typeof classified === 'object' && PERSISTED_KINDS.has(classified.kind);
  };
  const bufferPreMint = (rawUpdate) => {
    // Skip updates that will not persist a turn on replay so they cannot exhaust the
    // caps (issue #230). Not counted as a drop — dropping an ignored update loses no
    // transcript content.
    if (!classifiesToPersistedTurn(rawUpdate)) return;
    const size = sizeOfUpdate(rawUpdate);
    // The byte cap applies even to the FIRST buffered update: a single persisted ACP
    // update (e.g. an arbitrarily large tool-result) whose JSON alone exceeds
    // preMintBufferMaxBytes would otherwise be retained in full during a prolonged
    // create outage, defeating the memory bound. Drop (and count) it instead of
    // special-casing an empty buffer (issue #230).
    if (
      preMintBuffer.length >= preMintBufferMax ||
      preMintBufferBytes + size > preMintBufferMaxBytes
    ) {
      preMintDropped += 1;
      if (!preMintOverflowLogged) {
        preMintOverflowLogged = true;
        logger?.warn?.(
          `AgentInstance producer: pre-mint replay buffer full ` +
            `(${preMintBuffer.length} update(s), ~${preMintBufferBytes} bytes; caps ` +
            `${preMintBufferMax} updates / ${preMintBufferMaxBytes} bytes); dropping further ` +
            `updates until the create succeeds ${correlation()}.`,
        );
      }
      return;
    }
    preMintBuffer.push(rawUpdate);
    preMintBufferBytes += size;
  };

  // Replay every buffered pre-mint update against the freshly minted instance, in
  // arrival order, then clear the buffer. Called from doCreate on a successful mint.
  // If any updates were dropped on overflow, report the count so a truncated replay is
  // visible rather than silent (issue #230).
  const replayPreMintBuffer = () => {
    const dropped = preMintDropped;
    preMintDropped = 0;
    preMintBufferBytes = 0;
    if (dropped > 0) {
      logger?.warn?.(
        `AgentInstance producer: ${dropped} pre-mint update(s) were dropped before the instance ` +
          `minted (replay buffer overflow) — the replayed transcript is truncated by that many ` +
          `updates ${correlation()}.`,
      );
    }
    if (preMintBuffer.length === 0) return;
    const buffered = preMintBuffer.splice(0, preMintBuffer.length);
    for (const raw of buffered) ingestClassified(raw);
  };

  return {
    /** True once the AgentInstance has been minted. */
    get active() {
      return !!agentInstanceKey && !disabled;
    },
    get agentInstanceKey() {
      return agentInstanceKey;
    },

    /**
     * Mint the AgentInstance (lease-gated) with an opening CONFIGURATION turn that
     * establishes model/provider/systemPrompt/limits. Idempotent per element
     * instance — safe to call once per activation; a reactivation reconciles onto
     * the same instance rather than creating a second one. Best-effort: a rejected
     * create (e.g. a stale lease fence at second 0) does NOT disable the producer —
     * it is retried on the ACP hot path (issue #230), so a transient failure never
     * forfeits the whole run's durable transcript.
     */
    async activate() {
      if (disabled || agentInstanceKey) return this.active;
      // Route through maybeStartCreate so a repeated activation (a reactivation loop)
      // respects the SAME exponential backoff the hot path does, rather than firing a
      // fresh doCreate on every call and hammering the engine (issue #230). The first
      // activation (createAttempts === 0) always attempts immediately; a reactivation
      // still inside the backoff window is throttled and simply returns the current
      // (not-yet-active) state without a new attempt.
      maybeStartCreate();
      // BOUND the wait: c8ctl-plugin.js awaits activate() before it starts
      // runAgentJob, so a hung createAgentInstance must not be able to block the
      // harness from ever running. On timeout the attempt is RETIRED (identity-guarded,
      // so a late success cannot corrupt state) and the create simply resumes on the
      // ACP hot path; activate() returns the current (not-yet-active) state (issue #230).
      await awaitCreateBounded();
      return this.active;
    },

    /**
     * Feed one raw ACP `session/update` (the `params.update`). Non-blocking: the
     * translated turn's SDK append is enqueued. Malformed/ignored updates are
     * dropped. Never throws.
     */
    ingest(rawUpdate) {
      // Treat a FINALIZED producer as inert: once complete() has drained the queue and
      // driven (or bounded out) the terminal COMPLETED update, a late ACP frame — e.g.
      // spawnCaptureAcp's timeout/abort cleanup firing onAcpUpdate after finish()
      // resolved — must not enqueue history after the terminal update or buffer updates
      // after finalization, resurrecting an orphaned instance (issue #230).
      if (disabled || finalized) return;
      // Not minted yet? A create may have failed at second 0 — re-attempt it on the
      // hot path (throttled) so the transcript resumes as soon as the create takes,
      // and BUFFER this update so it is replayed against the instance once the create
      // succeeds (issue #230 — a pre-mint update must not be silently lost). We only
      // do this AFTER an activation attempt (createAttempts > 0): an ingest before
      // activate() neither mints nor buffers, preserving the lifecycle contract.
      if (!agentInstanceKey) {
        if (createAttempts > 0) {
          bufferPreMint(rawUpdate);
          maybeStartCreate();
        }
        return;
      }
      ingestClassified(rawUpdate);
    },

    /** Drain any queued appends without transitioning status. */
    async drain() {
      flushMessage();
      await queue;
    },

    /**
     * End the AgentInstance lifecycle. Flushes any pending message turn, drains the
     * append queue, then — only on a SUCCESSFUL job end (`ok`) — updates the instance
     * status to COMPLETED (there is no separate completeAgentInstance verb). On a
     * failed run the instance is left non-terminal so a retry/reactivation continues
     * the same instance. Best-effort; never throws; `job.complete` is unaffected.
     */
    async complete(ok = true) {
      // Last chance: if the instance never minted (create kept failing) make one
      // final, un-throttled attempt so at least the CONFIGURATION turn + terminal
      // status survive when the create finally becomes possible (issue #230).
      // Only after an activation attempt (createAttempts > 0): if activate() was
      // never called this stays a no-op rather than minting — and potentially
      // completing — an AgentInstance for a run that never activated, preserving the
      // same lifecycle contract as ingest().
      if (!disabled && !agentInstanceKey && createAttempts > 0) {
        // From here we are on the terminal last-chance path: any create retired while
        // we finalize is not followed by a hot-path retry (retireCreate reads this to
        // emit an accurate diagnostic; issue #230).
        finalizing = true;
        // A throttled, ingest-triggered attempt may already be in flight — await it
        // first (bounded) so we don't start a duplicate. If it (or the lack of one)
        // leaves us un-minted, make one explicit, un-throttled FINAL attempt regardless
        // of the backoff window, so a transient failure right before completion doesn't
        // lose the record. Both awaits are BOUNDED (finalizeTimeoutMs): the harness
        // awaits complete() before it settles the job, so a hung createAgentInstance
        // must not block settlement / expire the lease. A timed-out attempt is RETIRED
        // (identity-guarded) so its late success can't mint+replay after we return
        // (issue #230).
        if (creating) {
          await awaitCreateBounded();
        }
        // Honor the `maxInFlightCreates` circuit breaker here too (issue #230): this
        // last-chance attempt calls startCreate() directly (bypassing maybeStartCreate's
        // guard), so without this check it could launch one request beyond the cap when
        // retired-but-hung POSTs are still outstanding — the exact outage the cap is
        // meant to contain. When the cap is already saturated the engine is hung and a
        // final POST would only hang and be retired too, so we skip it and fall through
        // to the un-minted drain/warn path rather than pile on. When there is spare
        // capacity (the common case: earlier attempts settled, so createInFlight is 0)
        // the final attempt proceeds normally.
        const capSaturated = maxInFlightCreates > 0 && createInFlight >= maxInFlightCreates;
        if (!agentInstanceKey && !creating && !capSaturated) {
          startCreate({ final: true });
          await awaitCreateBounded();
        }
      }
      // Point of no return: from here the producer is finalized. Any create still in
      // flight (a retired last-chance attempt, or one that raced the bound) must NOT
      // latch a key or replay the pre-mint buffer later — doing so would resurrect an
      // orphaned, non-terminal AgentInstance after the job is settled without a
      // COMPLETED update (issue #230). doCreate's guard drops any such late success.
      finalized = true;
      if (disabled || !agentInstanceKey) {
        // Still drain any queued appends so a caller awaiting completion settles — but
        // bound the TOTAL drain at finalizeTimeoutMs (settleWithin never rejects). Each
        // append is individually bounded, yet the queue is serialized, so during an
        // AgentInstance outage N queued appends could take up to N×finalizeTimeoutMs and
        // hold the lease for that whole span; the remaining appends drain in the
        // background past the deadline (best-effort) so job settlement isn't blocked.
        await settleWithin(this.drain(), finalizeTimeoutMs);
        // Only warn when we actually attempted to mint (createAttempts > 0). A
        // producer that was never activated is a clean no-op — there is no missing
        // transcript to report.
        if (createAttempts > 0) {
          logger?.warn?.(
            `AgentInstance producer: no durable AgentInstance for this job after ` +
              `${createAttempts} create attempt(s) ${correlation()}; ` +
              `no engine transcript was recorded (job completion unaffected).`,
          );
        }
        return;
      }
      flushMessage();
      // Drain any queued appends first so ordering is preserved, THEN drive the
      // terminal COMPLETED update directly (not via the best-effort append queue) so
      // we can observe its outcome and RETRY it. On a successful job end the caller
      // settles the job the instant complete() returns, so there is no reactivation to
      // retry a rejected terminal transition — a single swallowed failure would strand
      // the instance non-terminal forever (issue #230). BOUND the aggregate drain at
      // finalizeTimeoutMs: each append is individually bounded, but the queue is
      // serialized, so during an outage N queued appends could take up to
      // N×finalizeTimeoutMs and hold the lease that whole span before the terminal
      // update even begins (issue #230).
      const drained = await settleWithin(queue, finalizeTimeoutMs);
      if (ok && !drained) {
        // The aggregate drain timed out: appends are STILL in flight on `queue`.
        // Driving the terminal COMPLETED update directly here would race those pending
        // appends — a concurrent request that could terminalize the instance BEFORE a
        // delayed append lands, reordering or losing that turn (issue #230). Instead,
        // SERIALIZE the terminal transition behind the queue: enqueue it so it runs
        // only after every pending append settles (each is individually bounded, so the
        // queue keeps making progress even under an outage). We can no longer observe /
        // retry its outcome from here, so surface that reconciliation may be needed, and
        // return without blocking job settlement — the terminal update lands in the
        // background once the drain catches up (best-effort, correctly ordered).
        enqueue(async () => {
          try {
            await callWithin(
              camunda[SDK_UPDATE]({
                agentInstanceKey,
                elementInstanceKey,
                jobKey,
                jobLease: leaseToken,
                status: 'COMPLETED',
              }),
              finalizeTimeoutMs,
            );
          } catch (err) {
            // This serialized enqueue IS the terminal transition on the drain-timeout
            // path — the only actor that can still terminalize the instance here. The
            // generic enqueue() catch would swallow it at debug with just err.message,
            // losing the HTTP status/body/correlation on the very path that already
            // warned reconciliation may be needed (issue #230). Emit the SAME shaped
            // status/body/correlation warning the direct terminal-retry path uses
            // (with its manual-reconciliation outcome) before it is swallowed.
            const d = describeSdkError(err);
            logger?.warn?.(
              `AgentInstance ${agentInstanceKey}: serialized terminal COMPLETED update ` +
                `${err?.__nanoTimeout ? `timed out (bounded at ${finalizeTimeoutMs}ms)` : 'failed'} — ` +
                `status=${d.status ?? 'n/a'} body=${d.body ?? 'n/a'} message=${d.message ?? 'n/a'}; ` +
                `MANUAL RECONCILIATION REQUIRED — the drain did not catch up and the job has ` +
                `settled with no reactivation to retry this transition ${correlation()}.`,
            );
          }
        });
        logger?.warn?.(
          `AgentInstance ${agentInstanceKey}: history drain did not settle within ` +
            `${finalizeTimeoutMs}ms — terminal COMPLETED update SERIALIZED behind the ` +
            `pending appends (best-effort, ordered) rather than racing them; its outcome ` +
            `is not observed here, so MANUAL RECONCILIATION may be required if the drain ` +
            `never catches up ${correlation()}.`,
        );
        // Emit the turn counter on this path too (issue #229/#232): the aggregate
        // append timeout is the hardest transcript failure to diagnose, so record how
        // many turns were appended SO FAR — the count is "so far / drain still pending"
        // here because the serialized appends have not been observed to settle.
        {
          const elapsedMs = activatedAt ? Math.max(0, now() - activatedAt) : 0;
          const mins = (elapsedMs / 60000).toFixed(1);
          logger?.info?.(
            `AgentInstance ${agentInstanceKey} (${corr()}): ${appendedTurns} turn(s) appended ` +
              `so far over ${mins}m (drain still pending — count unobserved), ` +
              `terminal COMPLETED update serialized behind pending appends.`,
          );
        }
        return;
      }
      let completedOk = false;
      let terminalErr = null;
      let terminalTimedOut = false;
      const terminalAttempts = Math.max(1, terminalRetryMax);
      if (ok) {
        for (let attempt = 1; attempt <= terminalAttempts; attempt += 1) {
          try {
            // BOUND each terminal update (finalizeTimeoutMs). Like the create calls,
            // the harness awaits complete() before it settles the job, so a hung
            // updateAgentInstance would otherwise hold the lease until it expires and
            // stall settlement during an engine outage (issue #230).
            await callWithin(
              camunda[SDK_UPDATE]({
                agentInstanceKey,
                elementInstanceKey,
                jobKey,
                jobLease: leaseToken,
                status: 'COMPLETED',
              }),
              finalizeTimeoutMs,
            );
            completedOk = true;
            terminalErr = null;
            terminalTimedOut = false;
            break;
          } catch (err) {
            terminalErr = describeSdkError(err);
            // A hung endpoint won't recover within the next attempt and each retry
            // burns another finalizeTimeoutMs against the lease, so STOP retrying on a
            // timeout (the underlying call is left to settle in the background). A
            // plain rejection is potentially transient, so those still retry.
            if (err && err.__nanoTimeout) {
              terminalTimedOut = true;
              break;
            }
          }
        }
      }
      const terminalOk = ok && completedOk;
      if (ok && !completedOk) {
        // The terminal transition never confirmed (every retry rejected, or a hung
        // request was bounded out). The job settles now with no reactivation to try
        // again, so this is NOT self-healing — surface the SDK error details and flag
        // that manual reconciliation is required (issue #230).
        logger?.warn?.(
          `AgentInstance ${agentInstanceKey}: terminal status update to COMPLETED ` +
            `${terminalTimedOut ? `timed out (bounded at ${finalizeTimeoutMs}ms)` : `failed after ${terminalAttempts} attempt(s)`} — ` +
            `status=${terminalErr?.status ?? 'n/a'} ` +
            `body=${terminalErr?.body ?? 'n/a'} message=${terminalErr?.message ?? 'n/a'}; ` +
            `MANUAL RECONCILIATION REQUIRED — the job settles now with no reactivation to retry ` +
            `this transition ${correlation()}.`,
        );
      }
      // #229/#232 turn counter — "N turn(s) appended over Xm, <transition>" — so the
      // 0-turns husk ("created but nothing ingested") is distinguishable from a healthy
      // run at a glance. Render the HONEST terminal transition: only claim
      // `status→COMPLETED` when the terminal update actually confirmed (terminalOk);
      // on a rejected/timed-out update say so (the instance stays non-terminal, so a
      // retry/reactivation still continues it) and flag manual reconciliation; on a
      // failed job end no COMPLETED update was attempted at all.
      const elapsedMs = activatedAt ? Math.max(0, now() - activatedAt) : 0;
      const mins = (elapsedMs / 60000).toFixed(1);
      const transition = !ok
        ? 'left non-terminal (retry/reactivation continues it)'
        : terminalOk
          ? 'status→COMPLETED'
          : 'COMPLETED update FAILED — left non-terminal (retry/reactivation continues it); manual reconciliation required';
      logger?.info?.(
        `AgentInstance ${agentInstanceKey} (${corr()}): ${appendedTurns} turn(s) appended over ${mins}m, ${transition}.`,
      );
    },
  };
}

/**
 * Derive the agent execution `limits` from the task envelope, when present. Maps the
 * envelope's `task.maxIterations` onto `maxModelCalls`; token/tool ceilings are not
 * expressed in the envelope today, so they are left as -1 (no limit). Returns
 * undefined when nothing constrains the run (the create then defaults all to -1).
 */
export function deriveLimits(envelope) {
  const maxIterations = envelope?.task?.maxIterations;
  const n = Number(maxIterations);
  if (Number.isFinite(n) && n > 0) {
    return { maxModelCalls: Math.trunc(n), maxToolCalls: -1, maxTokens: -1 };
  }
  return undefined;
}
