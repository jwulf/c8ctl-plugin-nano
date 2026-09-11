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
      if (failCreate) throw new Error('stale lease');
      validate(req);
      return createResult;
    },
    updateAgentInstance: async (req) => {
      calls.update.push(req);
      return { createdHistory: [] };
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

test('a failed create disables the producer; ingest/complete become no-ops and never throw', async () => {
  const client = fakeClient({ failCreate: true });
  const p = makeProducer(client);
  const ok = await p.activate();
  assert.equal(ok, false);
  assert.equal(p.active, false);
  // No throw, no updates.
  p.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  await p.complete(true);
  assert.equal(client.calls.update.length, 0);
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
  assert.equal(c.status, undefined);
  assert.equal(c.message, 'plain');

  assert.equal(describeSdkError(null).message, 'null');
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
  const line = logger.lines.warn.find((l) => l.includes('createAgentInstance REJECTED'));
  assert.ok(line, 'expected a REJECTED warn line');
  assert.match(line, /status 400/);
  assert.match(line, /jobLease fenced/);
  assert.match(line, /job 13954/);
  assert.match(line, /eik EIK-7/);
  assert.match(line, /pik 13951/);
  assert.match(line, /lease …99001/); // lease present, tail only
  assert.match(line, /Opus 4\.8\/anthropic/);
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
  const appendWarns = logger.lines.warn.filter((l) => l.includes('updateAgentInstance(append) failed'));
  assert.equal(appendWarns.length, 1, 'exactly one append failure elevated to warn');
  assert.match(appendWarns[0], /status 404/);
  assert.ok(calls >= 2, 'multiple append attempts were made');
  const appendDebugs = logger.lines.debug.filter((l) => l.includes('updateAgentInstance(append) failed'));
  assert.ok(appendDebugs.length >= 1, 'subsequent append failures stay at debug');
});
