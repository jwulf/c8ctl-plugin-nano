// Tests for the engine-native AgentInstance / AgentHistory producer (issue #194).
//
// Deterministic, dependency-injected: a fake SDK client records every
// createAgentInstance / updateAgentInstance call so we can assert the exact wire
// shapes the host `@camunda8/orchestration-cluster-api` client receives, without a
// live engine. A couple of tests exercise the REAL `@nanobpm/agentic` ACP classifier
// on real `session/update` shapes to prove the translation, not just the plumbing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentInstanceProducer,
  isExternalAgentJob,
  deriveAgentDefinition,
  deriveLimits,
  inferProvider,
  describeSdkError,
  leaseTokenLabel,
} from './agent-instance.mjs';

// A logger that records every line per level so observability assertions (#229)
// can inspect exactly what the producer emitted.
function recordingLogger() {
  const lines = { info: [], warn: [], debug: [] };
  return {
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    debug: (m) => lines.debug.push(String(m)),
    lines,
  };
}

// A fake SDK client that records calls and returns a fixed agentInstanceKey.
//
// `enforceContract` mimics the engine's request-model validation of the two
// invariants that matter here — every history item's loopIteration is a positive
// int32 (`LoopIterationId` min 1) — so a body that violates the contract is
// rejected with the same HTTP 400 the live engine returns, rather than silently
// accepted by a permissive mock.
function fakeClient({
  createResult = { agentInstanceKey: 'AGENT-1' },
  failCreate = false,
  failCreateTimes = 0,
  noKeyTimes = 0,
  createError = null,
  enforceContract = false,
} = {}) {
  const calls = { create: [], update: [] };
  const validate = (req) => {
    if (!enforceContract) return;
    for (const item of req.history ?? []) {
      if (!(Number.isInteger(item.loopIteration) && item.loopIteration >= 1)) {
        throw new Error(
          `HTTP 400: body.history[].loop_iteration: Validation error: range [min:1, value:${item.loopIteration}]`,
        );
      }
    }
  };
  return {
    calls,
    createAgentInstance: async (req) => {
      calls.create.push(req);
      if (failCreate) throw createError || new Error('stale lease');
      if (calls.create.length <= failCreateTimes) throw createError || new Error('stale lease');
      // A resolved-but-keyless response for the next `noKeyTimes` attempts: the create
      // succeeds at the transport layer but carries no agentInstanceKey.
      if (calls.create.length <= failCreateTimes + noKeyTimes) return {};
      validate(req);
      return createResult;
    },
    updateAgentInstance: async (req) => {
      calls.update.push(req);
      // Mirror the engine: a successful append echoes the created history entries
      // (the append boundary is one turn per call). A status-only update carries no
      // history, so nothing is created. Tests that model a deduplicated append
      // override this to return an EMPTY createdHistory.
      return { createdHistory: Array.isArray(req.history) ? req.history : [] };
    },
  };
}

const EXTERNAL_JOB = {
  jobKey: '13954',
  type: 'senior:feature',
  leaseToken: '99001',
  elementInstanceKey: 'EIK-7',
  elementId: 'agent-task',
  processInstanceKey: '13951',
};

const PROFILE = { name: 'copilot', model: 'Opus 4.8', rank: 'senior' };
const ENVELOPE = { task: { prompt: 'You are a helpful engineering agent.' } };

// A fixed clock so producedAt is deterministic.
const FIXED = Date.parse('2026-02-03T04:05:06.000Z');
const now = () => FIXED;

const nullLogger = { info() {}, warn() {}, debug() {} };

function makeProducer(client, overrides = {}) {
  return createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Detection + definition derivation
// ---------------------------------------------------------------------------

test('isExternalAgentJob requires both a lease token and an elementInstanceKey', () => {
  assert.equal(isExternalAgentJob(EXTERNAL_JOB), true);
  assert.equal(isExternalAgentJob({ ...EXTERNAL_JOB, leaseToken: undefined }), false);
  assert.equal(isExternalAgentJob({ ...EXTERNAL_JOB, leaseToken: '' }), false);
  assert.equal(isExternalAgentJob({ ...EXTERNAL_JOB, elementInstanceKey: undefined }), false);
  assert.equal(isExternalAgentJob({ jobKey: '1', type: 't' }), false);
  assert.equal(isExternalAgentJob(null), false);
});

test('deriveAgentDefinition seeds model from the profile, infers the provider, and takes systemPrompt from the task', () => {
  const def = deriveAgentDefinition({ profile: PROFILE, envelope: ENVELOPE });
  assert.equal(def.model, 'Opus 4.8');
  assert.equal(def.provider, 'anthropic');
  assert.equal(def.systemPrompt, 'You are a helpful engineering agent.');
});

test('inferProvider maps common model families', () => {
  assert.equal(inferProvider('gpt-4o'), 'openai');
  assert.equal(inferProvider('claude-opus'), 'anthropic');
  assert.equal(inferProvider('gemini-2.0'), 'google');
  assert.equal(inferProvider('something-else'), 'unknown');
});

test('deriveLimits maps task.maxIterations to maxModelCalls, else undefined', () => {
  assert.deepEqual(deriveLimits({ task: { maxIterations: 5 } }), { maxModelCalls: 5, maxToolCalls: -1, maxTokens: -1 });
  assert.equal(deriveLimits({ task: {} }), undefined);
  assert.equal(deriveLimits({}), undefined);
});

// ---------------------------------------------------------------------------
// activate() — mint exactly one AgentInstance, lease-gated
// ---------------------------------------------------------------------------

test('activate mints exactly one AgentInstance, lease-gated, with an opening CONFIGURATION turn', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  const ok = await p.activate();
  assert.equal(ok, true);
  assert.equal(p.agentInstanceKey, 'AGENT-1');
  assert.equal(client.calls.create.length, 1);
  const req = client.calls.create[0];
  // Lease-gated on the activated job.
  assert.equal(req.elementInstanceKey, 'EIK-7');
  assert.equal(req.jobKey, '13954');
  assert.equal(req.jobLease, '99001');
  // Opening CONFIGURATION turn carries the concrete runtime definition.
  assert.equal(req.history.length, 1);
  const cfg = req.history[0];
  assert.equal(cfg.role, 'CONFIGURATION');
  assert.equal(cfg.loopIteration, 1);
  assert.equal(cfg.model, 'Opus 4.8');
  assert.equal(cfg.provider, 'anthropic');
  assert.deepEqual(cfg.systemPrompt, [{ contentType: 'TEXT', text: 'You are a helpful engineering agent.' }]);
  assert.equal(cfg.producedAt, '2026-02-03T04:05:06.000Z');
  // A stable, element-instance-scoped historyItemId so a reactivation dedups it.
  assert.equal(cfg.historyItemId, 'configuration:EIK-7');
});

test('the opening CONFIGURATION turn satisfies the engine loopIteration contract (min 1) — create is not 400-rejected', async () => {
  // Regression for issue #218: a CONFIGURATION turn with loopIteration 0 violates
  // the engine's LoopIterationId contract (positive int32), so createAgentInstance
  // is rejected HTTP 400 and no durable transcript is ever written. The
  // contract-enforcing client rejects any sub-1 loopIteration exactly as the engine
  // does; activate() must still mint the instance.
  const client = fakeClient({ enforceContract: true });
  const p = makeProducer(client);
  const ok = await p.activate();
  assert.equal(ok, true);
  assert.equal(p.agentInstanceKey, 'AGENT-1');
  assert.equal(client.calls.create.length, 1);
  assert.ok(
    client.calls.create[0].history.every((h) => Number.isInteger(h.loopIteration) && h.loopIteration >= 1),
    'every created history item must carry a positive int32 loopIteration',
  );
});

test('activate is idempotent within a single producer (never mints twice)', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  await p.activate();
  assert.equal(client.calls.create.length, 1);
});

test('a reactivation reuses the same elementInstanceKey correlation and a stable CONFIGURATION id', async () => {
  const client = fakeClient();
  // Two separate producers for the SAME element instance (an ask-a-question loop
  // re-dispatch). Both correlate on the same elementInstanceKey and emit the same
  // config historyItemId, so the engine folds them into ONE instance (dedup).
  const a = makeProducer(fakeClient());
  await a.activate();
  const p = makeProducer(client);
  await p.activate();
  assert.equal(client.calls.create[0].elementInstanceKey, 'EIK-7');
  assert.equal(client.calls.create[0].history[0].historyItemId, 'configuration:EIK-7');
});

test('activate omits systemPrompt when the task carries no prompt', async () => {
  const client = fakeClient();
  const p = makeProducer(client, { envelope: { task: {} } });
  await p.activate();
  assert.equal('systemPrompt' in client.calls.create[0].history[0], false);
});

// ---------------------------------------------------------------------------
// ingest() — ACP updates → AgentHistory turn appends
// ---------------------------------------------------------------------------

test('assistant message chunks coalesce into ONE ASSISTANT turn on flush', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
  await p.complete(true);
  // One ASSISTANT append + one COMPLETED status update.
  const appends = client.calls.update.filter((u) => Array.isArray(u.history));
  assert.equal(appends.length, 1);
  const turn = appends[0].history[0];
  assert.equal(turn.role, 'ASSISTANT');
  assert.deepEqual(turn.content, [{ contentType: 'TEXT', text: 'Hello world' }]);
  assert.equal(appends[0].jobKey, '13954');
  assert.equal(appends[0].jobLease, '99001');
  assert.equal(appends[0].elementInstanceKey, 'EIK-7');
  assert.equal(appends[0].agentInstanceKey, 'AGENT-1');
});

test('a role change flushes the previous message into its own turn', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a question' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'an answer' } });
  await p.complete(true);
  const appends = client.calls.update.filter((u) => Array.isArray(u.history));
  assert.equal(appends.length, 2);
  assert.equal(appends[0].history[0].role, 'USER');
  assert.equal(appends[0].history[0].content[0].text, 'a question');
  assert.equal(appends[1].history[0].role, 'ASSISTANT');
  assert.equal(appends[1].history[0].content[0].text, 'an answer');
});

test('a tool_call appends an ASSISTANT turn with a toolCalls entry; a tool result appends a TOOL_RESULT turn', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep', status: 'pending', rawInput: { q: 'x' } });
  p.ingest({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'match' } }] });
  await p.complete(true);
  const appends = client.calls.update.filter((u) => Array.isArray(u.history));
  assert.equal(appends.length, 2);

  const call = appends[0].history[0];
  assert.equal(call.role, 'ASSISTANT');
  assert.equal(call.historyItemId, 'toolcall:t1');
  assert.equal(call.toolCalls.length, 1);
  assert.equal(call.toolCalls[0].toolCallId, 't1');
  assert.equal(call.toolCalls[0].toolName, 'grep');
  assert.equal(call.toolCalls[0].elementId, 'agent-task');
  assert.deepEqual(call.toolCalls[0].arguments, { q: 'x' });
  assert.equal(appends[0].status, 'TOOL_CALLING');

  const res = appends[1].history[0];
  assert.equal(res.role, 'TOOL_RESULT');
  assert.equal(res.historyItemId, 'toolresult:t1');
  // The originating tool name is carried through from the tool_call.
  assert.equal(res.toolCalls[0].toolName, 'grep');
  // The BPMN element attribution is carried through from the activated job.
  assert.equal(res.toolCalls[0].elementId, 'agent-task');
  // A structured (non-string) result becomes an OBJECT content block.
  assert.equal(res.content[0].contentType, 'OBJECT');
});

test('an ignored update (a plan) produces no history append', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'plan', entries: [] });
  await p.drain();
  const appends = client.calls.update.filter((u) => Array.isArray(u.history));
  assert.equal(appends.length, 0);
});

test('a classifier exception elevates the FIRST ingest failure to warn (repeats stay debug) (#229)', async () => {
  // A translation/classification fault must NOT vanish silently: the first ingest
  // failure per instance is elevated to `warn`, later ones stay at `debug`.
  const log = recordingLogger();
  const throwingAcp = { classifyUpdate: () => { throw new Error('boom classify'); } };
  const p = makeProducer(fakeClient(), { logger: log, sessionAcp: throwingAcp });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });
  await p.drain();
  const warns = log.lines.warn.filter((m) => /ingest failed/.test(m));
  const debugs = log.lines.debug.filter((m) => /ingest failed/.test(m));
  assert.equal(warns.length, 1, 'only the first classifier fault is elevated to warn');
  assert.ok(/boom classify/.test(warns[0]), 'the warn carries the classifier error');
  assert.equal(debugs.length, 1, 'the second classifier fault stays at debug');
});

// ---------------------------------------------------------------------------
// historyItemId stability (retry dedup)
// ---------------------------------------------------------------------------

test('identical message content yields the same historyItemId across producers (retry dedups)', async () => {
  const c1 = fakeClient();
  const p1 = makeProducer(c1);
  await p1.activate();
  p1.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stable content' } });
  await p1.complete(true);

  const c2 = fakeClient();
  const p2 = makeProducer(c2);
  await p2.activate();
  p2.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stable content' } });
  await p2.complete(true);

  const id1 = c1.calls.update.find((u) => Array.isArray(u.history)).history[0].historyItemId;
  const id2 = c2.calls.update.find((u) => Array.isArray(u.history)).history[0].historyItemId;
  assert.equal(id1, id2);
});

test('a stable messageId is honoured for the historyItemId', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-42', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  const turn = client.calls.update.find((u) => Array.isArray(u.history)).history[0];
  assert.equal(turn.historyItemId, 'assistant:m-42');
});

// ---------------------------------------------------------------------------
// complete() — status COMPLETED
// ---------------------------------------------------------------------------

test('complete(true) drives the instance status to COMPLETED', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  await p.complete(true);
  const statusUpdates = client.calls.update.filter((u) => u.status === 'COMPLETED');
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0].agentInstanceKey, 'AGENT-1');
  assert.equal(statusUpdates[0].jobKey, '13954');
  assert.equal(statusUpdates[0].jobLease, '99001');
});

test('complete(false) does NOT complete the instance (a retry continues it)', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  await p.complete(false);
  assert.equal(client.calls.update.filter((u) => u.status === 'COMPLETED').length, 0);
});

// ---------------------------------------------------------------------------
// Best-effort: nothing here may throw or mint when preconditions fail
// ---------------------------------------------------------------------------

test('a failed create does NOT permanently disable — it is retried, and never throws (issue #230)', async () => {
  // Every create attempt throws, so no key is ever obtained and no append lands,
  // but the producer must stay retryable (not disabled) and never throw.
  const client = fakeClient({ failCreate: true });
  const p = makeProducer(client);
  const ok = await p.activate();
  assert.equal(ok, false);
  assert.equal(p.active, false);
  // No throw, no updates (there is no instance key to append against).
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  assert.equal(client.calls.update.length, 0);
  // At least the activate() attempt (and complete()'s final attempt) were made.
  assert.ok(client.calls.create.length >= 1);
});

test('the producer is inert for a non-external job (no SDK calls)', async () => {
  const client = fakeClient();
  const p = createAgentInstanceProducer({
    camunda: client,
    job: { jobKey: '1', type: 'ordinary' },
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now,
  });
  const ok = await p.activate();
  assert.equal(ok, false);
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
});

test('the producer is inert when the SDK client lacks the AgentInstance methods', async () => {
  const p = createAgentInstanceProducer({
    camunda: { activateJobs() {} },
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now,
  });
  assert.equal(await p.activate(), false);
});

test('ingest before activate mints nothing and appends nothing', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  // No activate() call.
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.drain();
  // No create (no mint) AND no append: the hot-path retry only arms after an
  // activation attempt, so an ingest before activate() is a no-op (issue #230).
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
});

// ---------------------------------------------------------------------------
// Ordering: appends are serialized in ACP arrival order
// ---------------------------------------------------------------------------

test('appended turns preserve ACP arrival order even though ingest is non-blocking', async () => {
  const order = [];
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async () => ({ agentInstanceKey: 'AGENT-1' }),
    updateAgentInstance: async (req) => {
      if (Array.isArray(req.history)) order.push(req.history[0].content[0]?.text ?? req.history[0].role);
      await new Promise((r) => setTimeout(r, 1));
    },
  };
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'one' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } });
  await p.complete(true);
  assert.deepEqual(order, ['one', 'two']);
});

// ---------------------------------------------------------------------------
// Create retry — a transient failure must not forfeit the run (issue #230)
// ---------------------------------------------------------------------------

test('a create that fails at second 0 then succeeds mid-run resumes the durable transcript', async () => {
  // The first create attempt (from activate) throws; a second attempt — driven by a
  // later ingest once the backoff window has elapsed — succeeds, and from then on
  // turns append to the same instance.
  const client = fakeClient({ failCreateTimes: 1 });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const clock = () => t;
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: clock,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });

  // First attempt fails → no key yet, producer not disabled.
  const ok = await p.activate();
  assert.equal(ok, false);
  assert.equal(p.active, false);
  assert.equal(client.calls.create.length, 1);

  // An ingest before the backoff window elapses does NOT re-attempt — but the update
  // is now buffered for replay rather than dropped (issue #230).
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-early', content: { type: 'text', text: 'early' } });
  await p.drain();
  assert.equal(client.calls.create.length, 1);

  // Advance past the backoff window; the next ingest re-attempts the create, which
  // now succeeds — the instance is minted and subsequent turns append.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-later', content: { type: 'text', text: 'later' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2);
  assert.equal(p.active, true);

  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-captured', content: { type: 'text', text: 'captured' } });
  await p.complete(true);

  const texts = client.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  assert.ok(texts.includes('captured'), 'post-recovery turn is durably appended');
  // The turns emitted while the create was still failing are replayed, not lost.
  assert.ok(texts.includes('early') && texts.includes('later'), 'pre-mint turns are replayed');
  assert.equal(client.calls.update.filter((u) => u.status === 'COMPLETED').length, 1);
});

test('complete() makes a final un-throttled create attempt when the instance never minted', async () => {
  // fail once (activate), then complete()'s final attempt succeeds even inside the
  // backoff window, so at least the config turn + COMPLETED status survive.
  const client = fakeClient({ failCreateTimes: 1 });
  const p = makeProducer(client); // fixed clock
  await p.activate();
  assert.equal(client.calls.create.length, 1);
  assert.equal(p.active, false);
  await p.complete(true);
  assert.equal(client.calls.create.length, 2);
  assert.equal(p.active, true);
  assert.equal(client.calls.update.filter((u) => u.status === 'COMPLETED').length, 1);
});

test('complete() without a prior activate() is a no-op — it does NOT mint an instance (issue #230)', async () => {
  // A producer that was never activated (createAttempts === 0) must not mint — and
  // therefore not complete — an AgentInstance for a run that never activated. The
  // last-chance create is gated on an activation attempt, matching ingest()'s
  // lifecycle contract, and no misleading "no durable AgentInstance" warning fires.
  const warnings = [];
  const client = fakeClient();
  const p = makeProducer(client, { logger: { info() {}, warn: (m) => warnings.push(m), debug() {} } });
  await p.complete(true);
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
  assert.equal(warnings.length, 0);
});

test('complete()\'s last-chance create is bounded — a hung createAgentInstance cannot block job settlement (issue #230)', async () => {
  // The harness awaits complete() before it settles the job, so a hung final create
  // must NOT block indefinitely (that could expire the job lease). Attempt 1 fails
  // fast (so activate() returns); the last-chance attempt in complete() then hangs
  // forever — complete() must still resolve, bounded by finalizeTimeoutMs.
  const warnings = [];
  let createCall = 0;
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return Promise.reject(new Error('transient'));
      return new Promise(() => {}); // the final attempt never settles
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      return { createdHistory: [] };
    },
  };
  const p = makeProducer(client, {
    finalizeTimeoutMs: 20,
    logger: { info() {}, warn: (m) => warnings.push(m), debug() {} },
  });
  await p.activate();
  assert.equal(client.calls.create.length, 1, 'activate made the first (fast-failing) attempt');
  assert.equal(p.active, false);
  // If complete() awaited the hung create unbounded this would never resolve and the
  // test would time out; the bound makes it return.
  await p.complete(true);
  assert.equal(client.calls.create.length, 2, 'complete() made one final last-chance attempt');
  assert.equal(p.active, false, 'still un-minted — the hung create was abandoned, not awaited');
  assert.equal(
    client.calls.update.filter((u) => u.status === 'COMPLETED').length,
    0,
    'no terminal COMPLETED update without a minted instance',
  );
  assert.ok(
    warnings.some((m) => /no durable AgentInstance/.test(m)),
    'warns that no durable instance was recorded',
  );
});

test('activate() is bounded — a hung create cannot block the harness, and the attempt is retired so a later retry proceeds (issue #230)', async () => {
  // c8ctl-plugin.js awaits activate() before it starts runAgentJob, so a hung
  // createAgentInstance must NOT block activate() forever. The FIRST attempt hangs;
  // activate() must still return (bounded by finalizeTimeoutMs), and the hung attempt
  // must be RETIRED so a later ingest can start a fresh attempt rather than being
  // wedged behind the stuck request. A subsequent attempt that succeeds mints normally.
  let createCall = 0;
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return new Promise(() => {}); // first attempt hangs forever
      return Promise.resolve({ agentInstanceKey: 'AGENT-9' });
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      return { createdHistory: [] };
    },
  };
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    finalizeTimeoutMs: 20,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });
  // If activate() awaited the hung create unbounded this would never resolve.
  await p.activate();
  assert.equal(p.active, false, 'activate() returned without minting — the hung create was retired, not awaited');
  assert.equal(client.calls.create.length, 1, 'one (hung) attempt so far');
  // Past the backoff window, an ingest must be able to start a FRESH attempt — the
  // retired hung attempt must not leave `creating` set and wedge every later retry.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'a later ingest started a fresh attempt despite the hung first one');
  assert.equal(p.active, true, 'the fresh attempt minted the instance');
});

test('a create that succeeds late for a RETIRED/finalized attempt is dropped — no orphaned mint or replay after complete() (issue #230)', async () => {
  // If a bounded wait times out, the underlying create is left running. Should it
  // succeed AFTER complete() has returned (job settled without a COMPLETED update),
  // it must NOT set agentInstanceKey or replay buffered turns — that would resurrect
  // an orphaned, non-terminal AgentInstance receiving late history. Here the final
  // last-chance create is deferred past complete()'s bound, then released.
  const warnings = [];
  let createCall = 0;
  let releaseSecond = null;
  const secondSettled = new Promise((resolve) => { releaseSecond = resolve; });
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return Promise.reject(new Error('transient')); // activate fails fast
      // The final attempt resolves only when the test releases it — AFTER complete().
      return secondSettled.then(() => ({ agentInstanceKey: 'AGENT-LATE' }));
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      return { createdHistory: [] };
    },
  };
  const p = makeProducer(client, {
    finalizeTimeoutMs: 20,
    logger: { info() {}, warn: (m) => warnings.push(m), debug() {} },
  });
  await p.activate();
  assert.equal(p.active, false);
  await p.complete(true); // final attempt is still pending → bounded out + retired/finalized
  assert.equal(p.active, false, 'complete() returned un-minted (the final create had not settled)');
  assert.equal(
    client.calls.update.filter((u) => u.status === 'COMPLETED').length,
    0,
    'no COMPLETED update was sent',
  );
  // Now let the retired create succeed. Its late result MUST be dropped.
  releaseSecond();
  await secondSettled;
  await new Promise((r) => setTimeout(r, 5)); // let the late .then run
  assert.equal(p.active, false, 'the late create did NOT mint an orphaned instance');
  assert.equal(
    client.calls.update.length,
    0,
    'no buffered turns were replayed to a late-minted instance',
  );
});

test('the FINAL last-chance create failure does not promise a retry that cannot happen (issue #230)', async () => {
  // doCreate() is shared by the hot path (which WILL retry) and complete()'s one final
  // attempt (which will NOT — the producer is about to be discarded). The finalization
  // failure diagnostic must not tell operators to wait for a recovery that can't come.
  const warnings = [];
  const client = fakeClient({ failCreate: true }); // every create fails
  const p = makeProducer(client, { logger: { info() {}, warn: (m) => warnings.push(m), debug() {} } });
  await p.activate();
  await p.complete(true);
  const hotPathFailure = warnings.find((m) => /createAgentInstance failed \(attempt 1\)/.test(m));
  const finalFailure = warnings.find((m) => /createAgentInstance failed \(attempt 2\)/.test(m));
  assert.ok(hotPathFailure && /will retry/.test(hotPathFailure), 'the hot-path failure still promises a retry');
  assert.ok(finalFailure, 'the final attempt failure was logged');
  assert.ok(/no further create will be attempted/.test(finalFailure), 'the final failure does not promise a retry');
  assert.ok(!/will retry/.test(finalFailure), 'the final failure does not say "will retry"');
});

test('create backoff is anchored on when the attempt settles, not when it starts (issue #230)', async () => {
  // A create that FAILS SLOWLY must still pace the next attempt from the moment it
  // settled. Anchoring on request START would let a failure that outlasts the backoff
  // window trigger another request immediately, defeating the exponential pacing and
  // risking a retry storm during an outage.
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => {
      client.calls.create.push(req);
      t += 5000; // the failing attempt takes 5s — well past the 1s base backoff window
      throw new Error('slow transient failure');
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      return { createdHistory: [] };
    },
  };
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });
  await p.activate();
  assert.equal(client.calls.create.length, 1, 'one attempt so far');
  // The failure advanced the clock 5s. START-anchored, now-lastCreateAttemptAt would be
  // 5000 >= 1000 and this ingest would immediately re-attempt. SETTLE-anchored, we are
  // back at the window start → throttled.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x' } });
  await p.drain();
  assert.equal(client.calls.create.length, 1, 'settle-anchored backoff throttles the immediate next attempt');
  // Advance past the window measured from settle → the next ingest re-attempts.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'y' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'past the settle-anchored window a new attempt fires');
});

test('a hung HOT-PATH create is bounded and retired so it cannot wedge every later retry, and its timeout paces the backoff (issue #230)', async () => {
  // ingest() → maybeStartCreate() starts a create that NOBODY awaits. If it hangs,
  // `creating` must not stay set forever — that would buffer every later ingest while
  // maybeStartCreate() refuses to launch another retry, deferring recovery to
  // complete(). startCreate self-supervises: after finalizeTimeoutMs the hung attempt
  // is RETIRED, freeing the slot. Retirement also records the attempt time so the next
  // ingest respects the backoff instead of firing a fresh request immediately.
  let createCall = 0;
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return Promise.reject(new Error('transient')); // activate fails fast
      if (createCall === 2) return new Promise(() => {}); // hot-path attempt hangs forever
      return Promise.resolve({ agentInstanceKey: 'AGENT-HOT' });
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger: nullLogger, now: () => t, finalizeTimeoutMs: 20,
    createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  await p.activate(); // attempt 1 fails fast
  assert.equal(client.calls.create.length, 1);
  // Past the backoff window, a hot-path ingest starts attempt 2 (which hangs). Nobody awaits it.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'a' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'the hot path started a second (hung) attempt');
  // While it is still hung and un-retired, a later ingest cannot start a fresh attempt.
  t += 5000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'b' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'no new attempt while the hung one still owns the slot');
  // Let the real-time retirement timer (finalizeTimeoutMs=20) fire.
  await new Promise((r) => setTimeout(r, 45));
  // Retirement recorded lastCreateAttemptAt=now(): an ingest at the SAME clock is still
  // throttled by the backoff, proving the timeout paced the next attempt (issue #230).
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'c' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'retirement anchored the backoff — the immediate next ingest is throttled');
  // Past the backoff window (measured from retirement), the freed slot lets a fresh attempt mint.
  t += 5000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm4', content: { type: 'text', text: 'd' } });
  await p.drain();
  assert.equal(client.calls.create.length, 3, 'a fresh attempt fired after the hung one was retired');
  assert.equal(p.active, true, 'the fresh attempt minted the instance');
});

test('a hung terminal COMPLETED update is bounded so it cannot hold the lease and block job settlement (issue #230)', async () => {
  // The harness awaits complete() before it settles the job. The terminal update is
  // awaited directly (so its outcome can be observed + retried), so a hung
  // updateAgentInstance must be BOUNDED (finalizeTimeoutMs) — otherwise it holds the
  // lease until expiry and stalls settlement during an AgentInstance outage.
  const warnings = [];
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => { client.calls.create.push(req); return { agentInstanceKey: 'AGENT-T' }; },
    updateAgentInstance: (req) => {
      client.calls.update.push(req);
      if (req.status === 'COMPLETED') return new Promise(() => {}); // the terminal update hangs forever
      return Promise.resolve({ createdHistory: [] });
    },
  };
  const p = makeProducer(client, {
    finalizeTimeoutMs: 20,
    logger: { info() {}, warn: (m) => warnings.push(m), debug() {} },
  });
  await p.activate();
  assert.equal(p.active, true, 'the instance minted');
  // If complete() awaited the hung terminal update unbounded, this would never resolve.
  await p.complete(true);
  assert.ok(
    warnings.some((m) => /terminal status update to COMPLETED timed out/.test(m) && /MANUAL RECONCILIATION REQUIRED/.test(m)),
    'the hung terminal update was bounded out and flagged for manual reconciliation',
  );
});

test('a retired create attempt that FAILS late is reported quietly, not as a misleading "will retry" (issue #230)', async () => {
  // A timed-out attempt keeps running and may reject AFTER it was retired and a newer
  // attempt has minted the instance. That late rejection must not emit the ordinary
  // "will retry" warning (maybeStartCreate won't retry once a key/finalization is
  // latched) — reading the shared attempt counter and promising a retry would mislead.
  const warnings = [];
  const debugs = [];
  let createCall = 0;
  let rejectFirst = null;
  const firstSettled = new Promise((_resolve, reject) => { rejectFirst = () => reject(new Error('late stale lease')); });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return firstSettled; // hangs, then rejects late (after retirement)
      return Promise.resolve({ agentInstanceKey: 'AGENT-R' });
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger: { info() {}, warn: (m) => warnings.push(m), debug: (m) => debugs.push(m) },
    now: () => t, finalizeTimeoutMs: 20, createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  await p.activate(); // attempt 1 hangs → bounded out + retired
  assert.equal(p.active, false);
  // A later ingest mints via a fresh attempt.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x' } });
  await p.drain();
  assert.equal(p.active, true, 'a fresh attempt minted the instance');
  // Now the ORIGINAL (retired) attempt rejects late.
  rejectFirst();
  await firstSettled.catch(() => {});
  await new Promise((r) => setTimeout(r, 5)); // let the late catch run
  const lateWarn = warnings.find((m) => /createAgentInstance failed \(attempt 1\)/.test(m) && /will retry/.test(m));
  assert.equal(lateWarn, undefined, "the retired attempt's late failure did NOT emit a misleading \"will retry\" warning");
  assert.ok(
    debugs.some((m) => /failed late for a retired attempt/.test(m)),
    'the late failure was reported quietly at debug instead',
  );
});

test('a create that resolves with a BLANK/whitespace agentInstanceKey stays retryable — no orphaned mint against an invalid key (issue #230)', async () => {
  // A resolved response carrying agentInstanceKey: '' (or whitespace) is NOT a mint —
  // updates need a usable key. It must take the keyless retry path, not latch state,
  // log a mint, and replay the pre-mint buffer against an invalid key.
  const warnings = [];
  let createCall = 0;
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return { agentInstanceKey: '   ' }; // blank/whitespace-only key
      return { agentInstanceKey: 'AGENT-OK' };
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger: { info() {}, warn: (m) => warnings.push(m), debug() {} },
    now: () => t, createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  await p.activate();
  assert.equal(p.active, false, 'a blank key does not mint — it takes the keyless retry path');
  assert.equal(client.calls.update.length, 0, 'nothing was replayed against the invalid key');
  assert.ok(
    warnings.some((m) => /returned no agentInstanceKey \(attempt 1\)/.test(m) && /will retry/.test(m)),
    'the blank key is reported as a keyless (retryable) result',
  );
  // A later attempt returning a REAL key mints normally.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'a fresh attempt fired past the backoff window');
  assert.equal(p.active, true, 'the valid key minted the instance');
});

test('a keyless create result that arrives late for a retired attempt is dropped, not logged as "will retry" (issue #230)', async () => {
  // The no-key branch sits ABOVE the late-result/finalization guard, so a timed-out
  // create that later resolves with {} must ALSO be recognised as retired — emitting
  // "will retry" after a newer generation (or complete()) has moved on is misleading.
  const warnings = [];
  const debugs = [];
  let createCall = 0;
  let resolveFirst = null;
  const firstSettled = new Promise((resolve) => { resolveFirst = () => resolve({}); }); // resolves keyless, late
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return firstSettled; // hangs, then resolves keyless after retirement
      return Promise.resolve({ agentInstanceKey: 'AGENT-K' });
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger: { info() {}, warn: (m) => warnings.push(m), debug: (m) => debugs.push(m) },
    now: () => t, finalizeTimeoutMs: 20, createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  await p.activate(); // attempt 1 hangs → bounded out + retired
  assert.equal(p.active, false);
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x' } });
  await p.drain();
  assert.equal(p.active, true, 'a fresh attempt minted the instance');
  // Now the ORIGINAL (retired) attempt resolves late with no key.
  resolveFirst();
  await firstSettled;
  await new Promise((r) => setTimeout(r, 5)); // let the late .then run
  const lateNoKeyWarn = warnings.find((m) => /returned no agentInstanceKey \(attempt 1\)/.test(m) && /will retry/.test(m));
  assert.equal(lateNoKeyWarn, undefined, 'the retired attempt\'s late keyless result did NOT emit a misleading "will retry" warning');
  assert.ok(
    debugs.some((m) => /resolved without a usable key late for a retired attempt/.test(m)),
    'the late keyless result was reported quietly at debug instead',
  );
});

test('a retired attempt\'s late settle does not overwrite a newer attempt\'s backoff anchor (issue #230)', async () => {
  // A retired attempt already had its retirement time recorded. If its eventual late
  // settle overwrote the shared lastCreateAttemptAt, a NEWER (failed) attempt's backoff
  // anchor would be pushed forward to the old request's completion time, postponing the
  // next retry. doCreate's finally must only record while its generation is current.
  let createCall = 0;
  let rejectFirst = null;
  const firstSettled = new Promise((_resolve, reject) => { rejectFirst = () => reject(new Error('late stale lease')); });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return firstSettled;               // hangs → retired, rejects late
      if (createCall === 2) return Promise.reject(new Error('fast fail')); // newer attempt fails fast
      return Promise.resolve({ agentInstanceKey: 'AGENT-Z' });  // attempt 3 mints
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger: nullLogger, now: () => t, finalizeTimeoutMs: 20,
    createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  await p.activate();                    // attempt 1 hangs
  await new Promise((r) => setTimeout(r, 45)); // let the retirement timer fire (records anchor at T0)
  t += 2000;                             // T0+2000
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'a' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'attempt 2 fired past the backoff window and failed fast (anchor = T0+2000)');
  // Advance, THEN let the retired attempt 1 reject late. Its finally must NOT re-anchor
  // the backoff to now (T0+3000); the anchor must stay attempt 2's settle (T0+2000).
  t += 1000;                             // T0+3000
  rejectFirst();
  await firstSettled.catch(() => {});
  await new Promise((r) => setTimeout(r, 5)); // let the late catch/finally run
  // At T0+4500: anchor T0+2000 → elapsed 2500 >= backoff(2)=2000 → a fresh attempt fires.
  // Had the late settle re-anchored to T0+3000, elapsed would be 1500 < 2000 → throttled.
  t += 1500;                             // T0+4500
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'b' } });
  await p.drain();
  assert.equal(client.calls.create.length, 3, 'the retired late settle did not postpone the next retry');
  assert.equal(p.active, true, 'attempt 3 minted the instance');
});

test('a hung history append is bounded so complete()\'s queue drain cannot stall settlement (issue #230)', async () => {
  // Appends are serialized on the queue and complete() drains it before settling the
  // job. A history append that HANGS (rather than rejects) must be bounded
  // (finalizeTimeoutMs) or the drain — and job settlement — blocks until lease expiry.
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => { client.calls.create.push(req); return { agentInstanceKey: 'AGENT-A' }; },
    updateAgentInstance: (req) => {
      client.calls.update.push(req);
      if (req.status === 'COMPLETED') return Promise.resolve({ createdHistory: [] });
      return new Promise(() => {}); // history appends hang forever
    },
  };
  const p = makeProducer(client, { finalizeTimeoutMs: 20 });
  await p.activate();
  assert.equal(p.active, true);
  // Stream a turn whose append hangs. If the append were unbounded, complete()'s drain
  // would never resolve and this test would time out.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } });
  await p.complete(true);
  // complete() returned promptly (the hung append was bounded out) rather than stalling
  // settlement until lease expiry. Because the drain timed out with the append still in
  // flight, the terminal COMPLETED is SERIALIZED behind it (not raced), landing in the
  // background once the bounded append settles.
  const deadline = Date.now() + 2000;
  while (!client.calls.update.some((u) => u.status === 'COMPLETED') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(
    client.calls.update.some((u) => u.status === 'COMPLETED'),
    'the terminal COMPLETED update still ran once the hung append was bounded out',
  );
});

test('retiring a hung create emits a loud (warn-once) timeout diagnostic and caps concurrent in-flight creates so retries cannot overlap (issue #230)', async () => {
  // A hung createAgentInstance is bounded out and RETIRED, freeing the `creating` slot
  // for a retry — but its SDK POST is uncancellable and stays in flight. Two guarantees:
  // (1) retirement is logged at warn (once) so a timed-out create is visible even when a
  // later retry succeeds; (2) maybeStartCreate() will NOT launch a fresh attempt while
  // `maxInFlightCreates` POSTs are still outstanding, so retirement-driven retries can't
  // accumulate overlapping requests against a hung engine. Once an in-flight request
  // settles, the retry path re-opens.
  const warnings = [];
  const logger = { info() {}, warn: (m) => warnings.push(m), debug() {} };
  let createCall = 0;
  let rejectFirst = null;
  const firstHung = new Promise((_resolve, reject) => { rejectFirst = () => reject(new Error('late transport error')); });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => {
      client.calls.create.push(req);
      createCall += 1;
      if (createCall === 1) return firstHung;                    // hangs → bounded → retired, still in flight
      return Promise.resolve({ agentInstanceKey: 'AGENT-CAP' }); // a later retry mints
    },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = createAgentInstanceProducer({
    camunda: client, job: EXTERNAL_JOB, profile: PROFILE, envelope: ENVELOPE,
    logger, now: () => t, finalizeTimeoutMs: 20, maxInFlightCreates: 1,
    createRetryBaseMs: 1000, createRetryMaxMs: 30000,
  });
  // activate() awaits the bounded create; the hung attempt is retired on the deadline.
  await p.activate();
  assert.equal(p.active, false, 'the hung create was retired, not minted');
  assert.equal(client.calls.create.length, 1, 'one (hung, still in-flight) attempt so far');
  assert.equal(
    warnings.filter((m) => /did not settle within 20ms/.test(m)).length,
    1,
    'retirement emitted exactly one warn-level timeout diagnostic',
  );
  // The retired attempt's POST is still in flight (count = 1 = cap), so even well past
  // the backoff window a fresh retry must NOT start — that would overlap the hung POST.
  t += 5000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'a' } });
  await p.drain();
  assert.equal(client.calls.create.length, 1, 'the in-flight cap blocked an overlapping retry while the hung POST is outstanding');
  // Let the hung POST finally settle (transport error): the in-flight slot frees, so a
  // later ingest can start a fresh attempt, which mints the instance.
  rejectFirst();
  await firstHung.catch(() => {});
  await new Promise((r) => setImmediate(r)); // flush the late catch/finally (in-flight decrement)
  t += 5000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'b' } });
  await p.drain();
  assert.equal(client.calls.create.length, 2, 'once the in-flight POST settled, the retry path re-opened');
  assert.equal(p.active, true, 'the fresh attempt minted the instance');
});

test('a hung FINAL last-chance create is retired with the no-further-retry diagnostic, not a promise of a hot-path retry that cannot happen (issue #230)', async () => {
  // retireCreate() is reached for both hot-path attempts (which a later ingest WILL
  // retry) and complete()'s one FINAL last-chance attempt (after which `finalized`
  // latches, so NO retry can follow). The retirement diagnostic must match: the hot-path
  // retirement promises a later mint; the final-attempt retirement must say no further
  // create will be attempted (mirroring doCreate's `final` failure clause).
  const msgs = [];
  const logger = { info() {}, warn: (m) => msgs.push(m), debug: (m) => msgs.push(m) };
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => { client.calls.create.push(req); return new Promise(() => {}); }, // every create hangs
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  // Default maxInFlightCreates (3) leaves room for the final attempt to start.
  const p = makeProducer(client, { logger, finalizeTimeoutMs: 20 });
  await p.activate();               // hot-path attempt 1 hangs → retired (promises a retry)
  await p.complete(true);           // final attempt 2 hangs → retired (no further retry)
  const hotRetire = msgs.find((m) => /did not settle within 20ms \(attempt 1\)/.test(m));
  const finalRetire = msgs.find((m) => /did not settle within 20ms \(attempt 2\)/.test(m));
  assert.ok(hotRetire && /a later hot-path retry will attempt to mint/.test(hotRetire),
    'the hot-path retirement still promises a later retry');
  assert.ok(finalRetire, 'the final-attempt retirement was logged');
  assert.ok(/no further create will be attempted \(final attempt/.test(finalRetire),
    'the final-attempt retirement uses the no-further-retry diagnostic');
  assert.ok(!/a later hot-path retry will attempt to mint/.test(finalRetire),
    'the final-attempt retirement does not promise a hot-path retry that cannot happen');
});

test('complete()\'s FINAL last-chance create honors the maxInFlightCreates cap — it does not launch a request beyond the cap when retired POSTs are still in flight (issue #230)', async () => {
  // The circuit breaker in maybeStartCreate() bounds retirement-driven retries, but the
  // final last-chance attempt calls startCreate() directly. With the cap saturated by a
  // retired-but-hung POST, that direct call would launch one request beyond the cap —
  // the exact outage the cap contains. complete() must honor the cap here too: skip the
  // final attempt (the engine is hung; a final POST would only hang too) and fall through
  // to the un-minted drain/warn path.
  const warnings = [];
  const logger = { info() {}, warn: (m) => warnings.push(m), debug() {} };
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: (req) => { client.calls.create.push(req); return new Promise(() => {}); }, // hangs, stays in flight
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = makeProducer(client, { logger, finalizeTimeoutMs: 20, maxInFlightCreates: 1 });
  await p.activate();               // attempt 1 hangs → retired, but its POST is still in flight (count = 1 = cap)
  assert.equal(client.calls.create.length, 1, 'one (hung, still in-flight) attempt after activate');
  await p.complete(true);
  // The cap was saturated (1 in-flight == cap), so the final attempt was NOT started —
  // otherwise create.length would be 2, one beyond the cap.
  assert.equal(client.calls.create.length, 1, 'the saturated cap blocked the final last-chance attempt');
  assert.equal(p.active, false, 'the instance never minted');
  assert.ok(
    warnings.some((m) => /no durable AgentInstance for this job/.test(m)),
    'complete() fell through to the un-minted drain/warn path',
  );
});

test('complete() bounds the AGGREGATE append drain and SERIALIZES the terminal COMPLETED behind pending appends — it neither waits for every hung append serially nor races the terminal update ahead of them (issue #230)', async () => {
  // Each append is individually bounded, but the queue is serialized: N hung appends
  // would take up to N×finalizeTimeoutMs to drain, holding the lease that whole span
  // before the terminal COMPLETED update even begins. complete() bounds the TOTAL drain
  // at finalizeTimeoutMs. When that bound wins the appends are STILL in flight, so the
  // terminal COMPLETED must NOT be driven directly (a concurrent request could
  // terminalize the instance before a delayed append lands, reordering/losing it).
  // Instead it is ENQUEUED behind the pending appends: bounded, never raced, always
  // ordered last.
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => { client.calls.create.push(req); return { agentInstanceKey: 'AGENT-DR' }; },
    updateAgentInstance: (req) => {
      client.calls.update.push(req);
      if (req.status === 'COMPLETED') return Promise.resolve({ createdHistory: [] });
      return new Promise(() => {}); // every history append hangs forever (bounded per-call)
    },
  };
  const p = makeProducer(client, { finalizeTimeoutMs: 20 });
  await p.activate();
  // Queue six independent turns (distinct messageIds each flush the previous). Their
  // appends all hang; serialized, an UNBOUNDED drain would issue all six SDK calls (one
  // per finalizeTimeoutMs window) before COMPLETED. The bounded drain issues far fewer.
  for (let i = 0; i < 6; i += 1) {
    p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: `m${i}`, content: { type: 'text', text: `t${i}` } });
  }
  await p.complete(true);
  // The aggregate drain was bounded: only a slice of the six hung appends ran before
  // complete() returned (an unbounded drain would have issued all six first).
  const historyAtReturn = client.calls.update.filter((u) => u.status !== 'COMPLETED').length;
  assert.ok(
    historyAtReturn < 6,
    `the aggregate drain was bounded — only ${historyAtReturn} of 6 hung appends were issued before complete() returned`,
  );
  // The terminal COMPLETED was NOT raced ahead of the still-pending appends: at the
  // moment complete() returns it is enqueued behind them, so it has not been issued yet.
  assert.ok(
    !client.calls.update.some((u) => u.status === 'COMPLETED'),
    'the terminal COMPLETED update was serialized behind the pending appends, not raced ahead of them',
  );
  // Let the background queue drain (each hung append is bounded at finalizeTimeoutMs).
  const deadline = Date.now() + 2000;
  while (!client.calls.update.some((u) => u.status === 'COMPLETED') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // The terminal COMPLETED eventually lands, and ORDERING is preserved: it is the final
  // update, after all six history appends were issued (never reordered/lost).
  const completedIdx = client.calls.update.findIndex((u) => u.status === 'COMPLETED');
  assert.ok(completedIdx !== -1, 'the terminal COMPLETED update eventually ran in the background');
  assert.equal(completedIdx, client.calls.update.length - 1, 'COMPLETED is the last update issued');
  assert.equal(
    client.calls.update.slice(0, completedIdx).filter((u) => u.status !== 'COMPLETED').length,
    6,
    'all six history appends were issued before COMPLETED (ordering preserved)',
  );
});

test('a FINALIZED producer is inert to late ACP frames — nothing appended after COMPLETED (issue #230)', async () => {
  // spawnCaptureAcp can invoke onAcpUpdate (timeout/abort cleanup) after finish()
  // resolved, i.e. after complete() finalized the producer. A late frame must be
  // dropped, not appended after the terminal update nor buffered after finalization.
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => { client.calls.create.push(req); return { agentInstanceKey: 'AGENT-F' }; },
    updateAgentInstance: async (req) => { client.calls.update.push(req); return { createdHistory: [] }; },
  };
  const p = makeProducer(client, { finalizeTimeoutMs: 1000 });
  await p.activate();
  await p.complete(true);
  const updatesAfterComplete = client.calls.update.length;
  // A late frame arriving after finalization must be a no-op.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'zz', content: { type: 'text', text: 'late' } });
  await p.drain();
  assert.equal(client.calls.update.length, updatesAfterComplete, 'the late frame appended nothing');
});

test('pre-mint ACP updates are buffered and replayed once a retried create succeeds (issue #230)', async () => {
  // The create fails on activate; turns then stream in while it is still failing.
  // They must be buffered and durably replayed against the instance once a later
  // retry mints it — a transient create failure must not lose the agent's work.
  const client = fakeClient({ failCreateTimes: 1 });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });

  await p.activate();
  assert.equal(p.active, false);

  // These arrive before the instance mints — throttled within the backoff window, so
  // no re-attempt yet, but they must be retained for replay.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'pre-one' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'pre-two' } });
  await p.drain();
  assert.equal(client.calls.create.length, 1, 'no re-attempt inside the backoff window');
  assert.equal(client.calls.update.length, 0, 'nothing appended before the mint');

  // Advance past the backoff window; the next ingest re-attempts the create, which
  // now succeeds and replays the buffered turns.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'pre-three' } });
  await p.complete(true);

  const texts = client.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  assert.deepEqual(
    texts,
    ['pre-one', 'pre-two', 'pre-three'],
    'every pre-mint turn is replayed in arrival order',
  );
  assert.equal(client.calls.update.filter((u) => u.status === 'COMPLETED').length, 1);
});

test('the pre-mint replay buffer is bounded — overflow drops the newest, keeping a contiguous prefix', async () => {
  // A create that keeps failing must not let the buffer grow without bound.
  const client = fakeClient({ failCreate: true });
  const p = makeProducer(client, { preMintBufferMax: 2 });
  await p.activate();
  assert.equal(p.active, false);
  for (const text of ['a', 'b', 'c', 'd']) {
    p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: `m-${text}`, content: { type: 'text', text } });
  }
  await p.drain();
  // Now let the create succeed and complete; only the first two buffered turns survive.
  const client2 = client;
  // Swap create to succeed for the final attempt.
  client2.createAgentInstance = async (req) => {
    client2.calls.create.push(req);
    return { agentInstanceKey: 'AGENT-1' };
  };
  await p.complete(true);
  const texts = client2.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  assert.deepEqual(texts, ['a', 'b'], 'buffer capped at 2; newest updates dropped');
});

test('a repeated activate() respects the create backoff (no engine hammering) (issue #230)', async () => {
  // Every create fails; calling activate() repeatedly inside the backoff window must
  // NOT fire a fresh create each time — the pacing applies to activate() too.
  const client = fakeClient({ failCreate: true });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });
  await p.activate();
  assert.equal(client.calls.create.length, 1);
  await p.activate(); // inside the backoff window → throttled, no new attempt
  await p.activate();
  assert.equal(client.calls.create.length, 1, 'reactivation inside backoff makes no new create');
  t += 2000; // past the window
  await p.activate();
  assert.equal(client.calls.create.length, 2, 'a reactivation past the window re-attempts');
});

test('complete() does not falsely report status→COMPLETED when the terminal update fails', async () => {
  // The COMPLETED update is rejected; the completion diagnostic must warn and NOT
  // claim a terminal transition (issue #230).
  const lines = { info: [], warn: [] };
  const logger = {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    debug() {},
  };
  let failUpdates = true;
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => {
      client.calls.create.push(req);
      return { agentInstanceKey: 'AGENT-1' };
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      if (failUpdates) throw new Error('HTTP 409: non-terminal');
      return {};
    },
  };
  const p = makeProducer(client, { logger });
  await p.activate();
  await p.complete(true);
  assert.ok(
    lines.warn.some((m) => /terminal status update to COMPLETED failed/.test(m)),
    'a rejected terminal update is warned',
  );
  assert.ok(
    lines.warn.some((m) => /MANUAL RECONCILIATION REQUIRED/.test(m)),
    'a permanently-rejected terminal update flags manual reconciliation (no reactivation retries it)',
  );
  assert.ok(
    !lines.info.some((m) => /status→COMPLETED/.test(m)),
    'the info line does not falsely claim status→COMPLETED',
  );
  assert.ok(
    lines.info.some((m) => /manual reconciliation required/.test(m)),
    'the info line reports the non-terminal, manual-reconciliation outcome',
  );
  // The terminal update is retried (not swallowed once) before giving up.
  assert.ok(
    client.calls.update.filter((u) => u.status === 'COMPLETED').length >= 2,
    'the terminal update is retried before reporting manual reconciliation',
  );
});

test('a create that resolves without an agentInstanceKey stays retryable and mints + replays on a later attempt (issue #230)', async () => {
  // The no-key success path: createAgentInstance resolves but carries no key. The
  // producer must NOT disable or drop the run — it stays retryable, buffers the
  // pre-mint updates, and a later attempt that returns a key mints and replays them.
  const client = fakeClient({ noKeyTimes: 1 });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
  });

  // First attempt resolves without a key → not minted, not disabled, still retryable.
  const ok = await p.activate();
  assert.equal(ok, false);
  assert.equal(p.active, false);
  assert.equal(client.calls.create.length, 1);

  // A turn streams in while un-minted — buffered (not dropped), no append yet.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'nk-1', content: { type: 'text', text: 'buffered' } });
  await p.drain();
  assert.equal(client.calls.update.length, 0, 'nothing appended before the mint');

  // Past the backoff window, the next attempt returns a key → mint + replay.
  t += 2000;
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'nk-2', content: { type: 'text', text: 'after-mint' } });
  await p.complete(true);
  assert.equal(p.active, true, 'a later keyed attempt mints the instance');
  assert.ok(client.calls.create.length >= 2, 'the keyless attempt was retried');

  const texts = client.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  assert.ok(
    texts.includes('buffered') && texts.includes('after-mint'),
    'the update buffered during the keyless window replays once a later attempt mints',
  );
  assert.equal(client.calls.update.filter((u) => u.status === 'COMPLETED').length, 1);
});

test('the pre-mint replay buffer is bounded by an approximate byte budget, and the dropped count is reported (issue #230)', async () => {
  // A raw-count cap alone lets a token-chunk storm exhaust the buffer, so the buffer
  // is ALSO bounded by bytes. Once the byte budget is exceeded, further updates are
  // dropped (keeping a contiguous prefix) and the dropped count is surfaced on replay
  // so the truncation is visible rather than silent.
  const lines = { info: [], warn: [] };
  const logger = { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), debug() {} };
  const client = fakeClient({ failCreateTimes: 1 });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
    // A tiny byte budget so a couple of small updates already overflow it, and a large
    // slot count so it is the BYTE cap (not the count cap) doing the bounding here.
    preMintBufferMax: 1000,
    preMintBufferMaxBytes: 120,
  });

  await p.activate();
  assert.equal(p.active, false);

  // Stream several updates while the create is still failing (inside the backoff
  // window → no re-attempt). The byte budget bounds how many are retained.
  for (const text of ['first', 'second', 'third', 'fourth', 'fifth']) {
    p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: `m-${text}`, content: { type: 'text', text } });
  }
  await p.drain();
  assert.equal(client.calls.create.length, 1, 'no re-attempt inside the backoff window');

  // Past the window, the next attempt succeeds → mint + replay of the retained prefix.
  t += 2000;
  await p.activate();
  assert.equal(p.active, true);
  // A post-mint turn now appends directly (the instance exists).
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-live', content: { type: 'text', text: 'live' } });
  await p.complete(true);

  const texts = client.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  // Some early updates are retained (a contiguous prefix), some are dropped by the
  // byte cap — the buffer neither kept everything nor lost everything.
  assert.ok(texts.includes('first'), 'the earliest pre-mint update is retained');
  assert.ok(texts.length < 6, 'the byte budget dropped at least one buffered update');
  assert.ok(texts.includes('live'), 'the post-mint update is appended');
  // The overflow is reported (once at buffering, once with the dropped count on replay).
  assert.ok(
    lines.warn.some((m) => /pre-mint replay buffer full/.test(m)),
    'the buffer-full overflow is warned',
  );
  assert.ok(
    lines.warn.some((m) => /pre-mint update\(s\) were dropped .* truncated/.test(m)),
    'the dropped count is reported on replay so the truncation is visible',
  );
});

test('the pre-mint buffer only retains updates that persist a turn — a plan/status burst cannot starve it (issue #230)', async () => {
  // Non-history notifications (e.g. `plan`) are ignored on replay, so buffering them
  // would let a plan burst consume the caps during a create outage and drop later
  // message updates. They must be filtered out before buffering.
  const client = fakeClient({ failCreateTimes: 1 });
  let t = Date.parse('2026-02-03T04:05:06.000Z');
  const p = createAgentInstanceProducer({
    camunda: client,
    job: EXTERNAL_JOB,
    profile: PROFILE,
    envelope: ENVELOPE,
    logger: nullLogger,
    now: () => t,
    createRetryBaseMs: 1000,
    createRetryMaxMs: 30000,
    // Only 2 slots: a naive buffer would fill them with the plan burst and drop the
    // real message updates.
    preMintBufferMax: 2,
  });

  await p.activate();
  assert.equal(p.active, false);

  // A burst of ignored plan notifications, then two real message chunks.
  for (let i = 0; i < 5; i += 1) p.ingest({ sessionUpdate: 'plan', entries: [{ content: `step ${i}` }] });
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-a', content: { type: 'text', text: 'msg-a' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-b', content: { type: 'text', text: 'msg-b' } });
  await p.drain();

  // Past the window, the next attempt succeeds → mint + replay.
  t += 2000;
  await p.activate();
  assert.equal(p.active, true);
  await p.complete(true);

  const texts = client.calls.update
    .filter((u) => Array.isArray(u.history))
    .map((u) => u.history[0].content?.[0]?.text)
    .filter(Boolean);
  assert.deepEqual(
    texts,
    ['msg-a', 'msg-b'],
    'the plan burst was filtered out; both real message turns survived the 2-slot buffer',
  );
});

test('a shaped create failure emits status/body, the redacted jobLease, model/provider, and all correlation keys (issue #230)', async () => {
  // The create-failure warning is a core observability acceptance criterion, so assert
  // the producer-level diagnostic (not just describeSdkError in isolation): a shaped SDK
  // error must surface its status + body, the REDACTED lease token, the model/provider,
  // and every correlation key — so an operator can tie the failure to the exact request.
  const lines = { info: [], warn: [], debug: [] };
  const logger = {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    debug: (m) => lines.debug.push(m),
  };
  const createError = Object.assign(new Error('Bad Request'), {
    statusCode: 400,
    body: { detail: 'stale lease fence mismatch' },
  });
  const client = fakeClient({ failCreate: true, createError });
  const p = makeProducer(client, { logger });

  const ok = await p.activate();
  assert.equal(ok, false, 'a failed create does not mint');
  assert.equal(p.active, false);

  const warn = lines.warn.find((m) => /createAgentInstance failed/.test(m));
  assert.ok(warn, 'the shaped create failure is warned');
  assert.match(warn, /status=400/, 'the HTTP status is surfaced');
  assert.match(warn, /stale lease fence mismatch/, 'the response body is surfaced');
  assert.match(warn, /message=Bad Request/, 'the error message is surfaced');
  // The lease token (99001) is redacted to a last-4 tail — never echoed verbatim.
  assert.match(warn, /jobLease=present\(…9001\)/, 'the lease token is redacted, not leaked');
  assert.ok(!warn.includes('99001'), 'the raw lease token never appears verbatim');
  assert.match(warn, /model=Opus 4\.8/, 'the model is surfaced');
  assert.match(warn, /provider=anthropic/, 'the provider is surfaced');
  // Every correlation key ties the failure back to the exact activated job.
  assert.match(warn, /jobKey=13954/, 'the jobKey correlation key is surfaced');
  assert.match(warn, /elementInstanceKey=EIK-7/, 'the elementInstanceKey correlation key is surfaced');
  assert.match(warn, /processInstanceKey=13951/, 'the processInstanceKey correlation key is surfaced');
});

test('the first per-turn append failure is warn, and repeats are debug (issue #230)', async () => {
  // An append storm (e.g. a 400/404 on every updateAgentInstance) must be visible without
  // flooding the log, so ONLY the first per-turn append failure is elevated to `warn`; the
  // rest stay `debug`. Assert that severity contract at the producer level.
  const lines = { info: [], warn: [], debug: [] };
  const logger = {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    debug: (m) => lines.debug.push(m),
  };
  const appendError = Object.assign(new Error('Not Found'), { statusCode: 404, body: 'no such instance' });
  const client = {
    calls: { create: [], update: [] },
    createAgentInstance: async (req) => {
      client.calls.create.push(req);
      return { agentInstanceKey: 'AGENT-1' };
    },
    updateAgentInstance: async (req) => {
      client.calls.update.push(req);
      throw appendError;
    },
  };
  const p = makeProducer(client, { logger });
  await p.activate();
  assert.equal(p.active, true, 'the instance minted (create succeeded)');

  // Two distinct messages → the boundary flushes the first, complete() flushes the second:
  // at least two append attempts, each rejected by the failing updateAgentInstance.
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-a', content: { type: 'text', text: 'alpha' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm-b', content: { type: 'text', text: 'beta' } });
  await p.complete(true);

  const warnAppends = lines.warn.filter((m) => /append failed/.test(m));
  const debugAppends = lines.debug.filter((m) => /append failed/.test(m));
  assert.equal(warnAppends.length, 1, 'exactly the FIRST append failure is elevated to warn');
  assert.ok(debugAppends.length >= 1, 'subsequent append failures stay at debug (no warn flood)');
  // The single warn carries the same shaped diagnostics + correlation keys.
  assert.match(warnAppends[0], /status=404/, 'the append warn surfaces the HTTP status');
  assert.match(warnAppends[0], /no such instance/, 'the append warn surfaces the response body');
  assert.match(warnAppends[0], /jobKey=13954/, 'the append warn carries the correlation keys');
});

test('leaseTokenLabel redacts short tokens to a fixed marker (no verbatim leak) (issue #230)', () => {
  assert.equal(leaseTokenLabel(undefined), 'ABSENT');
  assert.equal(leaseTokenLabel(''), 'ABSENT');
  assert.equal(leaseTokenLabel('   '), 'ABSENT');
  // A short (≤4 char) token must NOT be echoed verbatim — its last-4 tail would be
  // the whole value — so a fixed marker is used instead.
  assert.equal(leaseTokenLabel('ab'), 'present(short)');
  assert.equal(leaseTokenLabel('abcd'), 'present(short)');
  assert.ok(!leaseTokenLabel('abcd').includes('abcd'), 'the short token is not leaked verbatim');
  // A longer token keeps only a redacted last-4 tail for correlation.
  assert.equal(leaseTokenLabel('abcdefgh'), 'present(…efgh)');
});

// ---------------------------------------------------------------------------
// Lease plumbing (issue #230 ask 3): the job's leaseToken is submitted as jobLease
// ---------------------------------------------------------------------------
test('the activation leaseToken is submitted as jobLease on create AND every append', async () => {
  const client = fakeClient();
  const p = makeProducer(client);
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  assert.ok(client.calls.create.length >= 1);
  for (const c of client.calls.create) assert.equal(c.jobLease, EXTERNAL_JOB.leaseToken);
  assert.ok(client.calls.update.length >= 1);
  for (const u of client.calls.update) assert.equal(u.jobLease, EXTERNAL_JOB.leaseToken);
});

// ---------------------------------------------------------------------------
// describeSdkError — status + body extraction for loud, diagnosable failures
// ---------------------------------------------------------------------------

test('describeSdkError reads the statusCode alias and coerces a missing/nullish status to null', () => {
  const a = describeSdkError({ statusCode: 400, body: { detail: 'lease fence mismatch' }, message: 'Bad Request' });
  assert.equal(a.status, 400);
  assert.match(a.body, /lease fence mismatch/);
  assert.equal(a.message, 'Bad Request');

  const b = describeSdkError({ response: { status: 404, data: 'not found' } });
  assert.equal(b.status, 404);
  assert.equal(b.body, 'not found');

  const c = describeSdkError(new Error('network down'));
  assert.equal(c.status, null);
  assert.equal(c.message, 'network down');

  assert.equal(describeSdkError(null).message, 'null');
});

// ---------------------------------------------------------------------------
// #229 observability — root-causable create failures, turn counters, correlation
// ---------------------------------------------------------------------------

test('describeSdkError extracts HTTP status + body from common SDK error shapes', () => {
  const a = describeSdkError({ status: 400, body: { message: 'lease fenced' }, message: 'Bad Request' });
  assert.equal(a.status, 400);
  assert.equal(a.body, JSON.stringify({ message: 'lease fenced' }));
  assert.equal(a.message, 'Bad Request');

  const b = describeSdkError({ response: { status: 404, data: 'not found' }, message: 'Not Found' });
  assert.equal(b.status, 404);
  assert.equal(b.body, 'not found');

  const c = describeSdkError(new Error('plain'));
  // Merge reconciliation (#230 × #232): the unified describeSdkError returns `null`
  // (not undefined) for a missing status — both are nullish and render identically.
  // Under node:assert/strict the two branches' expectations are irreconcilable, so
  // the single kept implementation (issue #230, which also caps/folds the body) wins.
  assert.equal(c.status, null);
  assert.equal(c.message, 'plain');

  assert.equal(describeSdkError(null).message, 'null');
});

test('describeSdkError caps an oversized response body so it cannot flood the log (issue #230)', () => {
  const huge = 'x'.repeat(5000);
  const capped = describeSdkError({ statusCode: 500, body: huge });
  assert.equal(capped.status, 500);
  assert.ok(capped.body.length < huge.length, 'the body is truncated');
  assert.ok(capped.body.startsWith('x'.repeat(500)), 'the first 500 chars are preserved');
  assert.match(capped.body, /\(5000 chars\)/, 'the original length is noted');

  // A serialized (non-string) oversized body is capped too.
  const bigObj = describeSdkError({ status: 400, body: { detail: 'y'.repeat(5000) } });
  assert.ok(bigObj.body.length <= 540, 'a serialized oversized body is bounded');

  // A short body is left intact.
  const small = describeSdkError({ statusCode: 400, body: 'short body' });
  assert.equal(small.body, 'short body');
});

test('describeSdkError folds newlines and caps the message so a multiline error stays one bounded log line (issue #230)', () => {
  // A multiline body/message would split the single correlatable worker-log line, and a
  // message that embeds a large body would bypass the body cap and flood the log.
  const multiline = describeSdkError({ statusCode: 502, body: 'line1\nline2\r\nline3', message: 'oops\nsecond line' });
  assert.ok(!/\n|\r/.test(multiline.body), 'the body has no raw newlines');
  assert.ok(!/\n|\r/.test(multiline.message), 'the message has no raw newlines');
  assert.match(multiline.body, /line1.*line2.*line3/, 'the body content is preserved inline');

  // A message that embeds a huge body must be capped too — it cannot bypass the cap.
  const huge = 'z'.repeat(5000);
  const bigMessage = describeSdkError(new Error(`create failed: ${huge}`));
  assert.ok(bigMessage.message.length < huge.length, 'the message is bounded');
  assert.match(bigMessage.message, /chars\)/, 'the message notes its length when capped');
});

test('activate() rejection logs HTTP status + body + correlation + lease tail at warn (#229)', async () => {
  const client = fakeClient();
  client.createAgentInstance = async (req) => {
    client.calls.create.push(req);
    throw { status: 400, body: { detail: 'jobLease fenced' }, message: 'Bad Request' };
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  const ok = await p.activate();
  assert.equal(ok, false);
  const line = logger.lines.warn.find((l) => l.includes('createAgentInstance failed'));
  assert.ok(line, 'expected a create-failure warn line');
  assert.match(line, /status=400/);
  assert.match(line, /jobLease fenced/);
  assert.match(line, /jobKey=13954/);
  assert.match(line, /elementInstanceKey=EIK-7/);
  assert.match(line, /processInstanceKey=13951/);
  assert.match(line, /jobLease=present\(…/); // short token masked — not printed whole
  assert.match(line, /model=Opus 4\.8/);
  assert.match(line, /provider=anthropic/);
});

test('activate() rejection collapses a multiline error body/message to one log line (#229)', async () => {
  const client = fakeClient();
  client.createAgentInstance = async (req) => {
    client.calls.create.push(req);
    // A pretty-printed / multiline engine error must NOT split the correlation
    // record across several worker-log lines (diagnostic dilution + log spoofing).
    throw { status: 500, body: 'line1\nline2\r\nline3', message: 'boom\ninjected: fake log line' };
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  const ok = await p.activate();
  assert.equal(ok, false);
  const line = logger.lines.warn.find((l) => l.includes('createAgentInstance failed'));
  assert.ok(line, 'expected a create-failure warn line');
  assert.ok(!/[\r\n]/.test(line), 'the rendered SDK error must not contain CR/LF');
  assert.match(line, /body=line1 ⏎ line2 ⏎ line3/);
  assert.match(line, /message=boom ⏎ injected: fake log line/);
});

test('complete() logs a turn counter separating the 0-turns husk from a healthy run (#229)', async () => {
  const client = fakeClient();
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  await p.complete(true);
  const line = logger.lines.info.find((l) => l.includes('turn(s) appended'));
  assert.ok(line, 'expected a turn-counter info line');
  assert.match(line, /0 turn\(s\) appended/);
  assert.match(line, /status→COMPLETED/);
  assert.match(line, /job 13954 eik EIK-7 pik 13951/);
});

test('complete(true) whose status→COMPLETED update is REJECTED reports the failed transition, not COMPLETED (#229)', async () => {
  // The status update rides the best-effort queue whose catch swallows the
  // rejection. Reject ONLY the terminal status update (not per-turn appends) so a
  // 400/404 there can't masquerade as a healthy COMPLETED while the instance stays
  // non-terminal — the exact husk-diagnosis regression the statusResolved gate
  // guards against.
  const client = fakeClient();
  client.updateAgentInstance = async (req) => {
    client.calls.update.push(req);
    if (req.status === 'COMPLETED') throw { status: 409, message: 'lease expired' };
    return { createdHistory: Array.isArray(req.history) ? req.history : [] };
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  await p.complete(true);
  const line = logger.lines.info.find((l) => l.includes('turn(s) appended'));
  assert.ok(line, 'expected a turn-counter info line');
  assert.match(line, /COMPLETED update FAILED — left non-terminal/);
  assert.doesNotMatch(line, /status→COMPLETED\./);
  assert.ok(
    client.calls.update.some((r) => r.status === 'COMPLETED'),
    'the status→COMPLETED update was attempted',
  );
});

test('complete() counts appended turns (#229)', async () => {
  const client = fakeClient();
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
  await p.complete(true);
  const line = logger.lines.info.find((l) => l.includes('turn(s) appended'));
  assert.match(line, /1 turn\(s\) appended/);
});

test('complete() counts only ENGINE-created history — a deduplicated append does not inflate the turn counter (#229/#232)', async () => {
  // updateAgentInstance is deduplicated by historyItemId, so a retry/reactivation
  // can return 200 with an EMPTY createdHistory. The husk/healthy counter must
  // reflect what the engine actually appended, not the attempt — otherwise a
  // deduplicated no-op would masquerade as a healthy turn.
  const client = fakeClient();
  client.updateAgentInstance = async (req) => {
    client.calls.update.push(req);
    return { createdHistory: [] }; // engine deduped: nothing new created
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dup' } });
  await p.complete(true);
  const line = logger.lines.info.find((l) => l.includes('turn(s) appended'));
  assert.match(line, /0 turn\(s\) appended/);
});

test('complete() falls back to +1 per append when the response omits createdHistory (#229/#232)', async () => {
  // An older engine (or a fake) that omits createdHistory must not zero the
  // counter — a genuine append is counted via the +1 fallback.
  const client = fakeClient();
  client.updateAgentInstance = async (req) => {
    client.calls.update.push(req);
    return {}; // no createdHistory field at all
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  const line = logger.lines.info.find((l) => l.includes('turn(s) appended'));
  assert.match(line, /1 turn\(s\) appended/);
});

test('first per-turn append failure is elevated to warn, repeats stay debug (#229)', async () => {
  const client = fakeClient();
  await (async () => {})();
  let calls = 0;
  client.updateAgentInstance = async (req) => {
    client.calls.update.push(req);
    calls += 1;
    throw { status: 404, message: 'gone' };
  };
  const logger = recordingLogger();
  const p = makeProducer(client, { logger });
  await p.activate();
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
  p.ingest({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'b' } });
  // force flush of both messages
  await p.complete(true);
  const appendWarns = logger.lines.warn.filter((l) => l.includes('updateAgentInstance append failed'));
  assert.equal(appendWarns.length, 1, 'exactly one append failure elevated to warn');
  assert.match(appendWarns[0], /status=404/);
  assert.ok(calls >= 2, 'multiple append attempts were made');
  const appendDebugs = logger.lines.debug.filter((l) => l.includes('updateAgentInstance append failed'));
  assert.ok(appendDebugs.length >= 1, 'subsequent append failures stay at debug');
});
