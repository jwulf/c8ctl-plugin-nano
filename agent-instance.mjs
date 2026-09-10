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
  // Coalesce streamed message chunks (same messageId + role) into one turn, flushed
  // on a role/message boundary, a tool event, or completion — the engine dedups on
  // historyItemId (it does NOT merge), so a turn must be appended exactly once, whole.
  let pendingMessage = null;
  // callId → toolName, so a TOOL_RESULT turn can reference the originating call name.
  const toolNames = new Map();

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
      await camunda[SDK_UPDATE](req);
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
          logger?.warn?.('AgentInstance producer: create returned no agentInstanceKey; disabling durable transcript for this job.');
          return false;
        }
        loopIteration = 1;
        logger?.info?.(`AgentInstance ${agentInstanceKey} minted for element instance ${elementInstanceKey} (job ${jobKey}).`);
        return true;
      } catch (err) {
        disabled = true;
        logger?.warn?.(`AgentInstance producer: createAgentInstance failed — ${err?.message || err}; continuing without a durable transcript (job completion unaffected).`);
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
      if (ok) {
        enqueue(async () => {
          await camunda[SDK_UPDATE]({
            agentInstanceKey,
            elementInstanceKey,
            jobKey,
            jobLease: leaseToken,
            status: 'COMPLETED',
          });
        });
      }
      try { await queue; } catch { /* best effort */ }
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
