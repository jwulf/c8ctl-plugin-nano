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
// crafted error body spoof extra log lines. Used when rendering SDK errors.
const oneLine = (v) => String(v).replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ');

/**
 * Extract the HTTP status + response body from an SDK rejection (#229).
 *
 * A create/append failure logged as an opaque `status 400` is useless — the body
 * is what distinguishes a lease-fence rejection from a schema error from a 404.
 * The host `@camunda8/orchestration-cluster-api` client surfaces these on a few
 * shapes depending on the transport, so probe the common ones defensively and
 * never throw (this runs on the best-effort logging path).
 *
 * @param {*} err
 * @returns {{ status: (number|string|undefined), body: (string|undefined), message: string }}
 */
export function describeSdkError(err) {
  if (err == null) return { status: undefined, body: undefined, message: String(err) };
  const status =
    err.status ??
    err.statusCode ??
    err?.response?.status ??
    err?.response?.statusCode ??
    (typeof err.code === 'number' ? err.code : undefined);
  let body =
    err.body ??
    err.responseBody ??
    err?.response?.data ??
    err?.response?.body ??
    undefined;
  if (body != null && typeof body !== 'string') {
    try {
      body = JSON.stringify(body);
    } catch {
      body = String(body);
    }
  }
  const message = err.message ? String(err.message) : String(err);
  return { status, body, message };
}

/** One-line rendering of {@link describeSdkError} for a log line (body capped). */
function formatSdkError(err) {
  const { status, body, message } = describeSdkError(err);
  const parts = [`status ${status ?? 'unknown'}`];
  if (isNonBlank(body)) parts.push(`body ${oneLine(String(body).slice(0, 600))}`);
  parts.push(`msg ${oneLine(message)}`);
  return parts.join('; ');
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
  // #229: cross-channel correlation. Stamp jobKey + elementInstanceKey +
  // processInstanceKey on every producer log so the AgentInstance channel can be
  // joined to the job / relay / git channels (today AgentInstance logs carry no
  // processInstanceKey, so the four channels can't be reconciled).
  const processInstanceKey = job?.processInstanceKey != null ? String(job.processInstanceKey) : '';
  const corr = () =>
    `job ${jobKey || '?'} eik ${elementInstanceKey || '?'} pik ${processInstanceKey || '?'}`;
  // The lease token is a secret-ish fence token — never log it whole. `slice(-6)`
  // would print a short/malformed lease (≤6 chars) IN FULL, so only surface a tail
  // when the token is long enough that the tail still hides most of it; otherwise
  // emit a safe digest (presence + length). Enough either way to tell "present"
  // from "absent" and to correlate the activation without exposing the token.
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

  let disabled = !usable;
  let agentInstanceKey = null;
  let activated = false;
  let loopIteration = 0;
  let queue = Promise.resolve();
  // #229 turn accounting: how many AgentHistory turns were actually appended, and
  // when the instance was minted — so `complete()` can log "N turns over Xm" and
  // separate "created but nothing ingested" (the 0-turns husk) from "create failed".
  let turnsAppended = 0;
  let activatedAt = 0;
  // #229 first-failure elevation: the FIRST per-turn append failure (400/404) for
  // this instance is logged at `warn` (with the SDK verb + status); repeats stay at
  // `debug` so a persistently-rejecting instance doesn't flood the log.
  let appendFailureLogged = false;
  let ingestFailureLogged = false;
  // Coalesce streamed message chunks (same messageId + role) into one turn, flushed
  // on a role/message boundary, a tool event, or completion — the engine dedups on
  // historyItemId (it does NOT merge), so a turn must be appended exactly once, whole.
  let pendingMessage = null;
  // callId → toolName, so a TOOL_RESULT turn can reference the originating call name.
  const toolNames = new Map();

  const iso = () => new Date(now()).toISOString();

  // Serialize an SDK call onto the queue so appends preserve order and `complete`
  // can drain them. A rejection is best-effort (never breaks the chain), but the
  // first append failure per instance is elevated to `warn` with the SDK verb +
  // HTTP status (#229) — per-turn append failures were invisible at `debug`.
  const enqueue = (fn, label = 'updateAgentInstance') => {
    queue = queue.then(fn).catch((err) => {
      const { status, message } = describeSdkError(err);
      // The first-failure elevation is for per-turn APPEND failures ONLY. A
      // completion status update (status→COMPLETED) rides this same queue, so if
      // it were allowed to consume the one-shot flag it would suppress the FIRST
      // real per-turn append failure down to `debug` — the exact regression the
      // #229 warning exists to prevent. Gate the elevation on the append label;
      // completion failures are diagnosed separately in `complete()` (they render
      // a failed/unknown terminal transition), so here they only ever log at debug.
      const isAppend = label.includes('append');
      if (isAppend && !appendFailureLogged) {
        appendFailureLogged = true;
        logger?.warn?.(
          `AgentInstance producer: ${label} failed (${corr()}) — status ${status ?? 'unknown'}: ${oneLine(message)}; further append failures for this instance stay at debug.`,
        );
      } else {
        logger?.debug?.(
          `AgentInstance producer: ${label} failed (${corr()}) — status ${status ?? 'unknown'}: ${oneLine(message)}`,
        );
      }
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
      const res = await camunda[SDK_UPDATE](req);
      // #229/#232: the engine dedups appends by historyItemId, so a retry or a
      // reactivation can return 200 while creating ZERO new history entries. Count
      // what the engine actually CREATED (`res.createdHistory`) — not the attempt —
      // so the completion counter separates a real append from a deduplicated no-op
      // and keeps the 0-turns husk diagnosis honest. Fall back to +1 only when the
      // response omits the field (older engine), so a genuine append is never
      // under-counted.
      turnsAppended += Array.isArray(res?.createdHistory) ? res.createdHistory.length : 1;
    }, 'updateAgentInstance(append)');
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

  // #229: first-failure elevation for ingest faults (classifier OR handler). The
  // FIRST ingest failure per instance logs at `warn`; repeats stay at `debug` so a
  // persistently-faulting instance doesn't flood the log.
  const noteIngestFailure = (err) => {
    if (!ingestFailureLogged) {
      ingestFailureLogged = true;
      logger?.warn?.(`AgentInstance producer: ingest failed (${corr()}) — ${oneLine(err?.message || err)}; further ingest failures for this instance stay at debug.`);
    } else {
      logger?.debug?.(`AgentInstance producer: ingest failed (${corr()}) — ${oneLine(err?.message || err)}`);
    }
  };

  return {
    /** True once the AgentInstance has been minted (or is being minted). */
    get active() {
      return activated && !disabled;
    },
    get agentInstanceKey() {
      return agentInstanceKey;
    },

    /**
     * Mint the AgentInstance (lease-gated) with an opening CONFIGURATION turn that
     * establishes model/provider/systemPrompt/limits. Idempotent per element
     * instance — safe to call once per activation; a reactivation reconciles onto
     * the same instance rather than creating a second one. Best-effort: a rejected
     * create (e.g. a stale lease) disables the producer and returns false.
     */
    async activate() {
      if (disabled || activated) return this.active;
      activated = true;
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
      try {
        const res = await camunda[SDK_CREATE]({
          elementInstanceKey,
          jobKey,
          jobLease: leaseToken,
          history: [configTurn],
        });
        agentInstanceKey =
          (res && (res.agentInstanceKey ?? res.key)) != null
            ? String(res.agentInstanceKey ?? res.key)
            : null;
        if (!agentInstanceKey) {
          // A reactivation reconciles the auto-minted/existing record; if the create
          // result carries no key, fall back to the elementInstanceKey correlation is
          // not possible for updates (they need the agentInstanceKey), so disable.
          disabled = true;
          logger?.warn?.(`AgentInstance producer: create returned no agentInstanceKey (${corr()}); disabling durable transcript for this job.`);
          return false;
        }
        loopIteration = 1;
        activatedAt = now();
        logger?.info?.(`AgentInstance ${agentInstanceKey} minted (${corr()}; ${leaseNote()}; model ${oneLine(def.model)}/${oneLine(def.provider)}).`);
        return true;
      } catch (err) {
        disabled = true;
        // #229: the single line that would have root-caused the 20974 work-loss.
        // Log the engine's HTTP status + response body (a lease-fence 400 vs a
        // schema 400 vs a 404) plus the request correlation actually sent —
        // elementInstanceKey/jobKey/processInstanceKey, whether the lease was
        // present + its tail, and the model/provider. An opaque "status 400" alone
        // is useless.
        logger?.warn?.(`AgentInstance producer: createAgentInstance REJECTED (${corr()}; ${leaseNote()}; model ${oneLine(def.model)}/${oneLine(def.provider)}) — ${formatSdkError(err)}; continuing without a durable transcript (job completion unaffected).`);
        return false;
      }
    },

    /**
     * Feed one raw ACP `session/update` (the `params.update`). Non-blocking: the
     * translated turn's SDK append is enqueued. Malformed/ignored updates are
     * dropped. Never throws.
     */
    ingest(rawUpdate) {
      if (disabled || !agentInstanceKey) return;
      let classified;
      try {
        classified = classify(rawUpdate);
      } catch (err) {
        // A classifier/translation fault is an ingest failure too — route it
        // through the same first-failure elevation (#229) instead of returning
        // silently, or the ingest path can still drop every turn with no warning.
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
        // #229: elevate the FIRST ingest failure per instance to `warn` (repeats
        // stay `debug`) so a translation/append fault that silently drops every
        // turn is visible at normal verbosity.
        noteIngestFailure(err);
      }
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
      if (disabled || !agentInstanceKey) {
        // Still drain any queued appends so a caller awaiting completion settles.
        try { await this.drain(); } catch { /* best effort */ }
        return;
      }
      flushMessage();
      // Track whether the COMPLETED status request actually resolved. The update
      // rides the best-effort queue (whose catch swallows SDK rejections), so we
      // must NOT infer the terminal transition from `ok` alone — a 400/404 on the
      // status update would otherwise be logged as a successful COMPLETED (#229),
      // defeating the husk diagnosis. `null` ⇒ no status update attempted.
      let statusResolved = ok ? false : null;
      if (ok) {
        enqueue(async () => {
          await camunda[SDK_UPDATE]({
            agentInstanceKey,
            elementInstanceKey,
            jobKey,
            jobLease: leaseToken,
            status: 'COMPLETED',
          });
          statusResolved = true;
        }, 'updateAgentInstance(status→COMPLETED)');
      }
      try { await queue; } catch { /* best effort */ }
      // #229: log a turn counter — "N turns appended over Xm, status→…" — so the
      // 0-turns husk ("created but nothing ingested") is distinguishable from a
      // healthy run at a glance, separate from the "create failed" line above.
      const elapsedMs = activatedAt ? Math.max(0, now() - activatedAt) : 0;
      const mins = (elapsedMs / 60000).toFixed(1);
      // Render the ACTUAL terminal transition: COMPLETED only when the status
      // update resolved; on a rejected update say so (the instance stays
      // non-terminal, so a retry/reactivation still continues it); on a failed run
      // no update was attempted at all.
      const transition = ok
        ? (statusResolved
          ? 'COMPLETED'
          : 'COMPLETED update FAILED — left non-terminal (retry/reactivation continues it)')
        : 'left non-terminal (retry/reactivation continues it)';
      logger?.info?.(`AgentInstance ${agentInstanceKey} (${corr()}): ${turnsAppended} turn(s) appended over ${mins}m, status→${transition}.`);
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
