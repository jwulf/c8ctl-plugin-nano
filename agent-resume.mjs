// Engine-transcript resume (issue #239).
//
// Today a re-activated agent job cold-reruns from scratch, which is what makes the
// lost-settlement race (nanobpm/nano-workforce#768) dangerous: a re-run duplicates
// the agent's external side effects. This module lets a re-activated worker instead
// RESUME from the previous agent's state — so at-least-once delivery stops being
// harmful (a re-activation becomes a continuation, not a duplicate).
//
// The durable state we resume from is the engine-native `AgentInstance` /
// `AgentHistory` transcript minted by `agent-instance.mjs` (issue #194, hardened in
// #234). Because it is engine-backed it is CROSS-MACHINE — unlike the local
// settlement journal (#226) it does not depend on `C8CTL_NANO_HOME`, so a resumed
// agent can pick up on a different worker box entirely.
//
// On re-activation, before spawning a cold harness, the worker:
//   1. Fetches the prior `AgentInstance` transcript for this `elementInstanceKey`
//      from the engine (`readPriorTranscript`).
//   2. Seeds the harness prompt with a rendered continuation of that transcript
//      (`buildResumePrompt` / `seedResumeEnvelope`), so the new agent continues
//      rather than restarts and does NOT repeat already-completed steps.
//
// Scope of recovery (documented, initial increment):
//   - COMMITTED work is already durable — it is on the pushed branch, so the resumed
//     agent picks up from the last commit WHEN this activation provisions the SAME
//     branch the prior one pushed. That holds for envelopes carrying a stable branch
//     identity (`repository.ref` / `branch.create` — the real agent-work path). An
//     envelope with neither gets an ephemeral `nano/agent-work/<base>-<runId>`
//     fallback branch that differs per activation, so it degrades to a transcript-only
//     continuation (a full prior-branch resolve+checkout is the later increment).
//   - UNCOMMITTED working-tree state is NOT recoverable unless the workspace/microVM
//     persists across activations (the isolated-context increment). This increment
//     resumes from last-pushed commit + transcript and treats uncommitted deltas as
//     lost. The resume preamble tells the agent this explicitly so it re-derives any
//     uncommitted work rather than assuming it survived.
//
// Everything at the process edge (the SDK read) is injected, so the orchestration is
// driven deterministically under `node --test` with an in-memory fake client. The
// whole module is BEST-EFFORT: a failure to read the prior transcript must NEVER
// crash the harness or change job completion — it degrades to the legacy cold rerun.

const isNonBlank = (v) => v != null && String(v).trim() !== '';
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Cap on the rendered prior transcript we seed back into the harness prompt so a
// huge run can't blow the resume prompt. UTF-16 code-unit (character) cap, matching
// the existing result-nudge context cap convention (`NUDGE_CONTEXT_CAP_CHARS`); with
// multi-byte output the byte size may be larger. Keeps the TAIL (most recent turns)
// since that is where a resumed agent must continue from.
export const RESUME_CONTEXT_CAP_CHARS = 48_000;

// Bound the awaited engine read so a non-settling SDK request can NEVER hold the
// activated job open before the harness starts (matches the producer's `callWithin`
// bound in agent-instance.mjs, which guards this same failure mode). On timeout the
// read degrades to `null` → the legacy cold rerun, exactly like any other read
// failure.
export const RESUME_READ_TIMEOUT_MS = 10_000;

// Race a promise against a deadline; rejects with a tagged timeout error so the
// best-effort caller degrades to a cold rerun rather than blocking forever. The
// deadline timer is cleared as soon as the read settles (win or lose), so it never
// keeps the event loop alive past the read.
function callWithin(promise, timeoutMs, setTimer = setTimeout) {
  if (!(timeoutMs > 0)) return Promise.resolve(promise);
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimer(() => {
      const err = new Error(`agent resume: SDK read timed out after ${timeoutMs}ms`);
      err.__nanoTimeout = true;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

// The AgentHistory roles that carry NO continuation-relevant work on their own: the
// opening CONFIGURATION turn is just the definition/system-prompt seed (already
// re-derived from the profile on the fresh activation), so its mere presence does
// NOT make a job "resumable". A transcript is resumable only once it also carries at
// least one real work turn (USER / ASSISTANT / TOOL_RESULT).
const NON_WORK_ROLES = new Set(['CONFIGURATION']);

// Extract the readable text from one AgentHistory content block. TEXT blocks carry
// `.text`; OBJECT blocks carry a structured `.object` (a tool result), rendered as
// compact JSON so a resumed agent can still read it.
function textForContentBlock(block) {
  if (!isPlainObject(block)) return '';
  if (block.contentType === 'TEXT' || typeof block.text === 'string') {
    return typeof block.text === 'string' ? block.text : '';
  }
  if (block.contentType === 'OBJECT' && block.object !== undefined) {
    try { return JSON.stringify(block.object); } catch { return ''; }
  }
  return '';
}

// Join a turn's content blocks into one text blob.
function textForContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(textForContentBlock).filter((s) => s !== '').join('\n');
}

// True when a turn carries continuation-relevant work — used both to decide whether a
// transcript is resumable and to skip pure-configuration noise when rendering.
function isWorkTurn(turn) {
  if (!isPlainObject(turn)) return false;
  const role = isNonBlank(turn.role) ? String(turn.role).toUpperCase() : '';
  if (NON_WORK_ROLES.has(role)) return false;
  const hasText = textForContent(turn.content) !== '';
  const hasToolCalls = Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0;
  return hasText || hasToolCalls;
}

/**
 * Does this history carry a resumable prior run — i.e. at least one real work turn
 * (USER / ASSISTANT / TOOL_RESULT with content or a tool call)? A history that is
 * empty, or holds only the opening CONFIGURATION turn, is NOT a resume: it means the
 * prior activation minted the instance but produced no work, so a fresh cold run is
 * correct (there is nothing to continue).
 */
export function hasResumableTranscript(turns) {
  if (!Array.isArray(turns)) return false;
  return turns.some(isWorkTurn);
}

/**
 * Render an AgentHistory turn list into a compact, human-and-model-readable
 * transcript, keeping only the TAIL within `capChars` (most-recent turns win, since
 * that is where a resumed agent must continue). Pure — no I/O, so it is exhaustively
 * unit-tested. The opening CONFIGURATION turn is dropped (its system prompt is
 * already re-seeded from the profile on the fresh activation).
 */
export function renderHistoryTurns(turns, { capChars = RESUME_CONTEXT_CAP_CHARS } = {}) {
  if (!Array.isArray(turns)) return '';
  const lines = [];
  for (const turn of turns) {
    if (!isPlainObject(turn)) continue;
    const role = isNonBlank(turn.role) ? String(turn.role).toUpperCase() : 'ASSISTANT';
    if (NON_WORK_ROLES.has(role)) continue;
    const text = textForContent(turn.content);
    // TOOL_RESULT is handled FIRST — before the tool-CALL branch below — because an
    // engine TOOL_RESULT can carry EMPTY content (a side-effecting tool that returned
    // nothing) while still RETAINING its `toolCalls`. Falling through to the tool-call
    // branch would render such a completed result as an INVOCATION line, and a resumed
    // agent could read that as an instruction to run the side-effecting tool AGAIN
    // (duplicate side effect). Render it as an explicit (possibly empty) result.
    if (role === 'TOOL_RESULT') {
      const name =
        Array.isArray(turn.toolCalls) && isPlainObject(turn.toolCalls[0]) && isNonBlank(turn.toolCalls[0].toolName)
          ? String(turn.toolCalls[0].toolName)
          : 'tool';
      lines.push(text === '' ? `[tool-result: ${name}] (no output)` : `[tool-result: ${name}] ${text}`);
      continue;
    }
    // A tool CALL turn (ASSISTANT with toolCalls, no text) renders as an invocation
    // line per call, echoing the arguments so a resumed agent knows exactly what ran.
    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0 && text === '') {
      for (const call of turn.toolCalls) {
        if (!isPlainObject(call)) continue;
        const name = isNonBlank(call.toolName) ? String(call.toolName) : 'tool';
        let args = '';
        if (call.arguments != null) {
          try { args = ` ${JSON.stringify(call.arguments)}`; } catch { args = ''; }
        }
        lines.push(`[tool-call: ${name}]${args}`);
      }
      continue;
    }
    if (text === '') continue;
    const label = role === 'USER' ? 'USER' : role === 'ASSISTANT' ? 'ASSISTANT' : role;
    lines.push(`[${label}] ${text}`);
  }
  const rendered = lines.join('\n');
  if (rendered.length <= capChars) return rendered;
  // Keep the tail (most recent turns) and mark the truncation so the agent knows the
  // earlier context was elided rather than that the run started here.
  const marker = '…[earlier transcript truncated]…\n';
  return marker + rendered.slice(rendered.length - (capChars - marker.length));
}

// Candidate SDK read methods, tried in order — the host `@camunda8/orchestration-cluster-api`
// client surface is probed best-effort (a client exposing none of them disables
// resume → legacy cold rerun, exactly like an older SDK disables the durable-transcript
// PRODUCER in agent-instance.mjs) and whatever shape comes back is normalized.
//
// The two-step correlation mirrors the real Camunda 8.10 API:
//   1. SEARCH_METHODS resolve the AgentInstance(s) for an ELEMENT instance. The real
//      `searchAgentInstances` filter keys on the PLURAL `elementInstanceKeys` array and
//      returns instances carrying that same plural array.
//   2. HISTORY_METHODS then read the AgentHistory keyed by the resolved
//      `agentInstanceKey`. NOTE: `searchAgentInstanceHistory` lives HERE, not in a
//      by-element list — its real signature takes an `agentInstanceKey` (the element
//      instance is only an optional history *filter*), so it cannot be correlated with
//      a bare element key and MUST follow an instance resolution.
const SEARCH_METHODS = ['searchAgentInstances', 'queryAgentInstances', 'searchAgentInstance'];
const GET_METHODS = ['getAgentInstanceByElementInstance'];
const HISTORY_METHODS = ['searchAgentInstanceHistory', 'getAgentInstanceHistory', 'getAgentHistory', 'searchAgentHistory'];

// Normalize a variety of list/single response shapes to an array of instance-like
// objects (each of which may embed a `.history` array and/or an `agentInstanceKey`).
function normalizeInstances(res) {
  if (res == null) return [];
  if (Array.isArray(res)) return res.filter(isPlainObject);
  if (isPlainObject(res)) {
    if (Array.isArray(res.items)) return res.items.filter(isPlainObject);
    if (Array.isArray(res.agentInstances)) return res.agentInstances.filter(isPlainObject);
    if (Array.isArray(res.instances)) return res.instances.filter(isPlainObject);
    // A single instance object.
    if (isNonBlank(res.agentInstanceKey) || Array.isArray(res.history)) return [res];
  }
  return [];
}

// Normalize a history response shape to an array of turns.
function normalizeHistory(res) {
  if (Array.isArray(res)) return res.filter(isPlainObject);
  if (isPlainObject(res)) {
    if (Array.isArray(res.history)) return res.history.filter(isPlainObject);
    if (Array.isArray(res.items)) return res.items.filter(isPlainObject);
    if (Array.isArray(res.agentHistory)) return res.agentHistory.filter(isPlainObject);
  }
  return [];
}

// Extract the element-instance keys an instance record is associated with, tolerating
// BOTH the real SDK's plural `elementInstanceKeys` array (an AgentInstance can span
// several element instances) and a singular `elementInstanceKey` scalar (in-memory
// fakes / older shapes). Used for the EXACT element match so a broader/unfiltered
// search result never seeds this job with another element's transcript.
function instanceElementKeys(inst) {
  if (!isPlainObject(inst)) return [];
  const keys = [];
  if (Array.isArray(inst.elementInstanceKeys)) {
    for (const k of inst.elementInstanceKeys) if (k != null) keys.push(String(k));
  }
  if (inst.elementInstanceKey != null) keys.push(String(inst.elementInstanceKey));
  return keys;
}

// The default engine read seam: probe the candidate SDK methods for a prior
// AgentInstance correlated on `elementInstanceKey` and return its history turns.
// Entirely best-effort — ANY rejection/throw resolves to an empty list, never
// propagates. Injected as `read` so tests drive it deterministically.
async function defaultRead({ camunda, elementInstanceKey }) {
  if (!isPlainObject(camunda) || !isNonBlank(elementInstanceKey)) return [];
  const eik = String(elementInstanceKey);

  // 1. Search by element instance → instance record(s). The real
  // `searchAgentInstances` filter keys on the PLURAL `elementInstanceKeys` array
  // (and returns instances carrying that same plural array); we send that documented
  // shape and still tolerate a singular scalar from an in-memory fake in the match.
  let instances = [];
  for (const m of SEARCH_METHODS) {
    if (typeof camunda[m] !== 'function') continue;
    try {
      instances = normalizeInstances(await camunda[m]({ filter: { elementInstanceKeys: [eik] } }));
    } catch { instances = []; }
    if (instances.length) break;
  }
  // 2. Fall back to a direct get-by-element.
  if (!instances.length) {
    for (const m of GET_METHODS) {
      if (typeof camunda[m] !== 'function') continue;
      try {
        instances = normalizeInstances(await camunda[m]({ elementInstanceKey: eik }));
      } catch { instances = []; }
      if (instances.length) break;
    }
  }
  if (!instances.length) return [];

  // Pick the instance for THIS element. Require an EXACT elementInstanceKey match:
  // a search surface may legitimately return a broader/unfiltered result set, and
  // picking an arbitrary non-matching instance would seed this job with ANOTHER
  // element's transcript (cross-job data exposure + wrong continuation). When
  // nothing matches, resume from nothing (the caller cold-runs). Reactivations fold
  // into the same instance, so at most one match is expected; the newest wins.
  const match = instances
    .filter((i) => instanceElementKeys(i).includes(eik))
    .pop();
  if (!match) return [];

  // 3. Prefer an embedded history; else fetch it by agentInstanceKey.
  let turns = normalizeHistory(match.history != null ? match : { history: match.history });
  if (!turns.length && Array.isArray(match.history)) turns = match.history.filter(isPlainObject);
  if (!turns.length) {
    const aik = match.agentInstanceKey ?? match.key;
    if (isNonBlank(aik)) {
      for (const m of HISTORY_METHODS) {
        if (typeof camunda[m] !== 'function') continue;
        try {
          turns = normalizeHistory(await camunda[m]({ agentInstanceKey: String(aik) }));
        } catch { turns = []; }
        if (turns.length) break;
      }
    }
  }
  return turns;
}

/**
 * Fetch the prior AgentInstance transcript for this job's `elementInstanceKey` from
 * the engine and, when it carries real prior work, return the rendered continuation
 * text plus the raw turns. Returns `null` when there is nothing to resume from (no
 * prior work, no read method, or any failure) — the caller then cold-runs as before.
 *
 * BEST-EFFORT: never throws. A read that rejects/throws is swallowed and reported at
 * `debug`, degrading to the legacy cold rerun.
 *
 * @param {object} opts
 * @param {object} opts.camunda  Host SDK client (probed for a read surface).
 * @param {object} opts.job      The activated job (needs `elementInstanceKey`).
 * @param {object} [opts.logger] Output-mode-aware logger.
 * @param {(args:{camunda:object,elementInstanceKey:string,job:object})=>Promise<object[]>} [opts.read]
 *        Injected read seam (defaults to the SDK probe) — the test hook.
 * @param {number} [opts.capChars] Rendered-transcript cap.
 * @param {number} [opts.readTimeoutMs] Deadline (ms) bounding the injected read; on
 *        timeout the read degrades to `null` (legacy cold rerun).
 * @param {typeof setTimeout} [opts.setTimer] Timer factory (test seam).
 * @returns {Promise<{turns: object[], historyCount: number, text: string} | null>}
 */
export async function readPriorTranscript(opts = {}) {
  const {
    camunda,
    job,
    logger,
    read = defaultRead,
    capChars = RESUME_CONTEXT_CAP_CHARS,
    readTimeoutMs = RESUME_READ_TIMEOUT_MS,
    setTimer = setTimeout,
  } = opts;
  const elementInstanceKey = job?.elementInstanceKey != null ? String(job.elementInstanceKey) : '';
  if (!isNonBlank(elementInstanceKey)) return null;
  let turns = [];
  try {
    turns = await callWithin(read({ camunda, elementInstanceKey, job }), readTimeoutMs, setTimer);
  } catch (err) {
    logger?.debug?.(`agent resume: prior-transcript read failed (eik ${elementInstanceKey}) — ${String(err?.message || err)}`);
    return null;
  }
  if (!Array.isArray(turns) || !hasResumableTranscript(turns)) return null;
  const text = renderHistoryTurns(turns, { capChars });
  if (!isNonBlank(text)) return null;
  return { turns, historyCount: turns.length, text };
}

/**
 * Build the resume-seeded prompt: the agent's ORIGINAL task prompt, preceded by a
 * continuation preamble that hands it the prior transcript and the recovery-scope
 * contract (committed work is on the branch; uncommitted deltas are lost). The
 * original instruction is preserved verbatim so the task itself is unchanged — only
 * framed as a continuation.
 */
export function buildResumePrompt({ basePrompt, transcriptText }) {
  const base = typeof basePrompt === 'string' ? basePrompt : '';
  const transcript = typeof transcriptText === 'string' ? transcriptText : '';
  const preamble = [
    'You are RESUMING a job that a previous agent instance already started — this is a',
    'continuation, NOT a fresh start. The engine re-activated the job (at-least-once',
    'delivery); do NOT repeat steps the previous instance already completed, and do NOT',
    'duplicate external side effects (comments, pushes, PRs) it already performed.',
    '',
    'Recovering the previous work:',
    '- COMMITTED work is durable and already on your pushed branch — check out the',
    '  existing branch and continue from its last commit (inspect `git log` / the open',
    '  PR to see what already landed).',
    '- UNCOMMITTED working-tree changes from the previous run were NOT preserved across',
    '  the re-activation — treat them as lost and re-derive anything not yet committed.',
    '',
    'Transcript of the previous instance (most recent turns; earlier context may be',
    'truncated) — use it to understand what was already done and continue from there:',
    '-----',
    transcript,
    '-----',
    '',
    'Now continue the ORIGINAL task below from where the previous instance left off:',
    '',
    base,
  ];
  return preamble.join('\n');
}

/**
 * Return a shallow-cloned task envelope whose task prompt is replaced with the
 * resume-seeded continuation prompt, so the harness (which reads `envelope.task.prompt`
 * / the top-level `prompt`) continues rather than restarts. The original envelope is
 * never mutated. When the envelope has no task prompt to seed, the original is
 * returned unchanged.
 */
export function seedResumeEnvelope(envelope, transcriptText) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.task)) return envelope;
  // Only seed when there is a real task PROMPT to reframe. An envelope whose task
  // carries no string prompt (e.g. `task: {}`) has nothing to continue, so return it
  // UNCHANGED (the documented contract) rather than wrapping a large RESUMING preamble
  // around an empty task — which would wrongly divert such a job from its legacy cold
  // run. Guard on the prompt being a non-blank string, not merely on `task` existing.
  if (typeof envelope.task.prompt !== 'string' || envelope.task.prompt.trim() === '') return envelope;
  const basePrompt = envelope.task.prompt;
  const seeded = buildResumePrompt({ basePrompt, transcriptText });
  return { ...envelope, task: { ...envelope.task, prompt: seeded } };
}

/** Is engine-transcript resume disabled by the kill switch (`NANO_AGENT_RESUME=off`)? */
export function isResumeDisabled(env = process.env) {
  return String(env?.NANO_AGENT_RESUME || '').trim().toLowerCase() === 'off';
}

// Local mirror of agent-instance.mjs's `isExternalAgentJob` eligibility (a job a
// worker actually activated that carries BOTH a lease token and an elementInstanceKey
// is an external agent job with a durable transcript). Inlined — rather than imported
// from agent-instance.mjs — to keep this module free of that module's heavy
// `@nanobpm/agentic` dependency chain, so the resume logic stays deterministically
// unit-testable with no node_modules. Keep in lockstep with the source definition.
function isExternalAgentJob(job) {
  if (!isPlainObject(job)) return false;
  return isNonBlank(job.leaseToken) && isNonBlank(job.elementInstanceKey);
}

/**
 * Resolve the effective task envelope for an activation: the resume-seeded
 * continuation when this is a re-activation of an EXTERNAL agent job carrying a prior
 * engine transcript, else the ORIGINAL envelope unchanged. This is the exact gating +
 * best-effort read/seed the worker (`workAgent`) applies before spawning the harness,
 * factored out so the wiring is unit-testable WITHOUT standing up the whole worker
 * path (issue #239).
 *
 * BEST-EFFORT and non-throwing: a disabled kill switch, an ineligible job (no lease /
 * `elementInstanceKey`, or the AgentInstance producer off), a read failure/timeout, no
 * prior work, or an envelope with no seedable prompt ALL return the original envelope
 * (`resumed:false`) so the caller cold-runs exactly as before.
 *
 * @param {object}  opts
 * @param {object}  opts.envelope           The original task envelope.
 * @param {object}  opts.job                The activated job (needs lease + `elementInstanceKey`).
 * @param {object}  [opts.camunda]          Host SDK client (probed for a read surface).
 * @param {boolean} [opts.agentInstanceOff] The `NANO_AGENT_INSTANCE=off` gate (no durable transcript).
 * @param {object}  [opts.env]              Environment for the kill-switch check.
 * @param {object}  [opts.logger]           Output-mode-aware logger.
 * @param {typeof readPriorTranscript} [opts.readPrior] Injected read seam (test hook).
 * @returns {Promise<{envelope: object, resumed: boolean, historyCount: number}>}
 */
export async function resolveEffectiveEnvelope(opts = {}) {
  const {
    envelope,
    job,
    camunda,
    agentInstanceOff = false,
    env = process.env,
    logger,
    readPrior = readPriorTranscript,
  } = opts;
  if (agentInstanceOff || isResumeDisabled(env) || !isExternalAgentJob(job)) {
    return { envelope, resumed: false, historyCount: 0 };
  }
  try {
    const prior = await readPrior({ camunda, job, logger });
    if (prior) {
      const seeded = seedResumeEnvelope(envelope, prior.text);
      // `seedResumeEnvelope` returns the SAME reference when there was no prompt to
      // seed — treat that as "not resumed" so the caller behaves as a cold run.
      if (seeded !== envelope) {
        return { envelope: seeded, resumed: true, historyCount: prior.historyCount };
      }
    }
  } catch (err) {
    logger?.debug?.(`agent resume: effective-envelope resolution skipped — ${String(err?.message || err)}; cold-running.`);
  }
  return { envelope, resumed: false, historyCount: 0 };
}
