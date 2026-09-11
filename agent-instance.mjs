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
  const message = isNonBlank(err.message) ? String(err.message) : String(err);
  return { status: status ?? null, body: body ?? null, message };
}

// Redact a lease token down to a presence + short tail so it can be logged for
// correlation without leaking the opaque fence value. For a short token (≤ 4 chars)
// a last-4 tail would reveal the ENTIRE token, so emit a fixed redacted marker
// instead — `isExternalAgentJob` accepts any non-blank token, so a short/custom
// value must never be logged verbatim. The presence signal is preserved either way.
export function leaseTokenLabel(leaseToken) {
  if (!isNonBlank(leaseToken)) return 'ABSENT';
  const s = String(leaseToken);
  return s.length > 4 ? `present(…${s.slice(-4)})` : 'present(short)';
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
  // hammering the engine.
  let creating = null;
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
  // Count of AgentHistory turns successfully appended, for the completion diagnostic
  // (separates "create failed" from "created but nothing ingested over a long run").
  let appendedTurns = 0;
  // Elevate the FIRST per-turn append failure to `warn` (repeats stay `debug`) so a
  // 400/404 append storm is visible without flooding the log (issue #230 / #229).
  let appendFailureLogged = false;
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
        await camunda[SDK_UPDATE](req);
        appendedTurns += 1;
      } catch (err) {
        const d = describeSdkError(err);
        const line =
          `AgentInstance producer: ${SDK_UPDATE} append failed — ` +
          `status=${d.status ?? 'n/a'} message=${d.message} body=${d.body ?? 'n/a'} ${correlation()}.`;
        if (!appendFailureLogged) {
          appendFailureLogged = true;
          logger?.warn?.(line);
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

  // Perform ONE createAgentInstance attempt. On success the instance key is
  // latched; on failure it is logged LOUDLY (status + body + lease presence +
  // correlation) and the producer is left retryable — NOT disabled (issue #230).
  const doCreate = async () => {
    createAttempts += 1;
    lastCreateAttemptAt = now();
    const { def, configTurn } = buildConfigTurn();
    try {
      const res = await camunda[SDK_CREATE]({
        elementInstanceKey,
        jobKey,
        jobLease: leaseToken,
        history: [configTurn],
      });
      const key =
        res && (res.agentInstanceKey ?? res.key) != null
          ? String(res.agentInstanceKey ?? res.key)
          : null;
      if (!key) {
        // createAgentInstance resolved but carried no key — updates need the
        // agentInstanceKey, so we cannot append yet. Idempotent per
        // elementInstanceKey, so keep retrying rather than forfeiting the run. Log the
        // SAME request-context fields the throw path does (with explicit status/body
        // n/a, since the call resolved) so an unexpected success shape is diagnosable
        // against the request that produced it (issue #230).
        logger?.warn?.(
          `AgentInstance producer: createAgentInstance returned no agentInstanceKey ` +
            `(attempt ${createAttempts}) — status=n/a body=n/a ` +
            `jobLease=${leaseTokenLabel(leaseToken)} model=${def.model} provider=${def.provider} ` +
            `${correlation()}; will retry.`,
        );
        return false;
      }
      agentInstanceKey = key;
      loopIteration = 1;
      logger?.info?.(
        `AgentInstance ${agentInstanceKey} minted for element instance ${elementInstanceKey} ` +
          `(job ${jobKey}, attempt ${createAttempts}) ${correlation()}.`,
      );
      replayPreMintBuffer();
      return true;
    } catch (err) {
      const d = describeSdkError(err);
      logger?.warn?.(
        `AgentInstance producer: createAgentInstance failed (attempt ${createAttempts}) — ` +
          `status=${d.status ?? 'n/a'} message=${d.message} body=${d.body ?? 'n/a'} ` +
          `jobLease=${leaseTokenLabel(leaseToken)} model=${def.model} provider=${def.provider} ` +
          `${correlation()}; will retry (durable transcript resumes once the create succeeds; ` +
          `job completion unaffected).`,
      );
      return false;
    }
  };

  // Kick off a create attempt if one is warranted and the backoff window has
  // elapsed. Non-blocking: dedups a concurrent attempt and never throws. Called
  // from the ACP hot path (`ingest`) so a create that becomes possible mid-run is
  // retried without a dedicated timer.
  const maybeStartCreate = () => {
    if (disabled || agentInstanceKey || creating) return;
    if (createAttempts > 0 && now() - lastCreateAttemptAt < backoffForAttempt(createAttempts)) return;
    creating = doCreate()
      .catch(() => false)
      .finally(() => {
        creating = null;
      });
  };

  // Classify one raw ACP `session/update` and append the resulting turn(s). Assumes
  // the instance is already minted (an append needs the agentInstanceKey). Malformed
  // or ignored updates are dropped. Never throws. Shared by the hot path (`ingest`)
  // and the pre-mint replay so both translate a turn identically.
  const ingestClassified = (rawUpdate) => {
    let classified;
    try {
      classified = classify(rawUpdate);
    } catch {
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
      logger?.debug?.(`AgentInstance producer: ingest failed — ${err?.message || err}`);
    }
  };

  // Hold a pre-mint ACP update for later replay, bounded so a create that never
  // succeeds cannot grow the buffer without bound. Bounded by BOTH a slot count and an
  // approximate byte budget — a streamed response can emit many token-chunk
  // notifications, so a raw-count cap alone would let a chunk storm exhaust the buffer.
  // Once either cap is hit, drop the newest update (keeping the buffered prefix
  // contiguous) and COUNT the drop so the truncation is reported (not silent) on
  // replay. A single oversized update is still buffered (the byte cap only bites once
  // something is already buffered) so at least one turn always survives.
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
    } catch {
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
    if (
      preMintBuffer.length >= preMintBufferMax ||
      (preMintBuffer.length > 0 && preMintBufferBytes + size > preMintBufferMaxBytes)
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
      if (creating) await creating;
      return this.active;
    },

    /**
     * Feed one raw ACP `session/update` (the `params.update`). Non-blocking: the
     * translated turn's SDK append is enqueued. Malformed/ignored updates are
     * dropped. Never throws.
     */
    ingest(rawUpdate) {
      if (disabled) return;
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
      if (!disabled && !agentInstanceKey) {
        // A throttled, ingest-triggered attempt may already be in flight — await it
        // first so we don't start a duplicate. If it (or the lack of one) leaves us
        // un-minted, make one explicit, un-throttled final attempt regardless of the
        // backoff window, so a transient failure right before completion doesn't lose
        // the record.
        if (creating) {
          try { await creating; } catch { /* best effort */ }
        }
        if (!agentInstanceKey) {
          creating = doCreate()
            .catch(() => false)
            .finally(() => {
              creating = null;
            });
          try { await creating; } catch { /* best effort */ }
        }
      }
      if (disabled || !agentInstanceKey) {
        // Still drain any queued appends so a caller awaiting completion settles.
        try { await this.drain(); } catch { /* best effort */ }
        logger?.warn?.(
          `AgentInstance producer: no durable AgentInstance for this job after ` +
            `${createAttempts} create attempt(s) ${correlation()}; ` +
            `no engine transcript was recorded (job completion unaffected).`,
        );
        return;
      }
      flushMessage();
      // Drain any queued appends first so ordering is preserved, THEN drive the
      // terminal COMPLETED update directly (not via the best-effort append queue) so
      // we can observe its outcome and RETRY it. On a successful job end the caller
      // settles the job the instant complete() returns, so there is no reactivation to
      // retry a rejected terminal transition — a single swallowed failure would strand
      // the instance non-terminal forever (issue #230).
      try { await queue; } catch { /* best effort */ }
      let completedOk = false;
      let terminalErr = null;
      const terminalAttempts = Math.max(1, terminalRetryMax);
      if (ok) {
        for (let attempt = 1; attempt <= terminalAttempts; attempt += 1) {
          try {
            await camunda[SDK_UPDATE]({
              agentInstanceKey,
              elementInstanceKey,
              jobKey,
              jobLease: leaseToken,
              status: 'COMPLETED',
            });
            completedOk = true;
            terminalErr = null;
            break;
          } catch (err) {
            terminalErr = describeSdkError(err);
          }
        }
      }
      const terminalOk = ok && completedOk;
      if (ok && !completedOk) {
        // Every retry of the terminal transition was rejected. The job settles now with
        // no reactivation to try again, so this is NOT self-healing — surface the SDK
        // error details and flag that manual reconciliation is required (issue #230).
        logger?.warn?.(
          `AgentInstance ${agentInstanceKey}: terminal status update to COMPLETED failed after ` +
            `${terminalAttempts} attempt(s) — status=${terminalErr?.status ?? 'n/a'} ` +
            `body=${terminalErr?.body ?? 'n/a'} message=${terminalErr?.message ?? 'n/a'}; ` +
            `MANUAL RECONCILIATION REQUIRED — the job settles now with no reactivation to retry ` +
            `this transition ${correlation()}.`,
        );
      }
      logger?.info?.(
        `AgentInstance ${agentInstanceKey}: ${appendedTurns} turn(s) appended` +
          `${
            terminalOk
              ? ', status→COMPLETED'
              : ok
                ? ' (COMPLETED update rejected — manual reconciliation required)'
                : ' (left non-terminal for retry)'
          } ${correlation()}.`,
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
