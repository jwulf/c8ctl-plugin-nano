// Tests for engine-transcript resume (issue #239).
//
// Deterministic and dependency-injected: the SDK read seam is injected as a fake so
// the resume orchestration is exercised without a live engine, and the pure
// render/detect/prompt/envelope helpers are asserted directly. Covers:
//   - resumable-transcript detection (real work vs config-only / empty),
//   - AgentHistory turn rendering (text / tool-call / tool-result / truncation),
//   - readPriorTranscript over a fake SDK (search + embedded/looked-up history),
//   - best-effort degradation (read throws, no read method, no prior work),
//   - resume-prompt + envelope seeding (original prompt preserved, no mutation),
//   - the kill switch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESUME_CONTEXT_CAP_CHARS,
  hasResumableTranscript,
  renderHistoryTurns,
  readPriorTranscript,
  buildResumePrompt,
  seedResumeEnvelope,
  isResumeDisabled,
} from './agent-resume.mjs';

// A minimal AgentHistory turn factory mirroring agent-instance.mjs's wire shape.
const textTurn = (role, text) => ({ role, content: [{ contentType: 'TEXT', text }] });
const configTurn = () => ({ role: 'CONFIGURATION', content: [], systemPrompt: [{ contentType: 'TEXT', text: 'sys' }] });
const toolCallTurn = (name, args) => ({ role: 'ASSISTANT', content: [], toolCalls: [{ toolCallId: 'c1', toolName: name, arguments: args }] });
const toolResultTurn = (name, result) => ({ role: 'TOOL_RESULT', content: typeof result === 'string' ? [{ contentType: 'TEXT', text: result }] : [{ contentType: 'OBJECT', object: result }], toolCalls: [{ toolCallId: 'c1', toolName: name }] });

test('hasResumableTranscript: empty / config-only is NOT resumable, real work IS', () => {
  assert.equal(hasResumableTranscript([]), false);
  assert.equal(hasResumableTranscript(null), false);
  assert.equal(hasResumableTranscript([configTurn()]), false);
  assert.equal(hasResumableTranscript([configTurn(), textTurn('ASSISTANT', 'did a thing')]), true);
  assert.equal(hasResumableTranscript([toolCallTurn('grep', { q: 'x' })]), true);
  // A content-less, tool-call-less ASSISTANT turn is not work.
  assert.equal(hasResumableTranscript([{ role: 'ASSISTANT', content: [] }]), false);
});

test('renderHistoryTurns: drops CONFIGURATION, renders roles, tool calls, tool results', () => {
  const turns = [
    configTurn(),
    textTurn('USER', 'please do X'),
    textTurn('ASSISTANT', 'planning'),
    toolCallTurn('grep', { pattern: 'foo' }),
    toolResultTurn('grep', 'match at line 1'),
    toolResultTurn('read', { ok: true }),
  ];
  const out = renderHistoryTurns(turns);
  assert.ok(!out.includes('sys'), 'system prompt / configuration is not rendered');
  assert.ok(out.includes('[USER] please do X'));
  assert.ok(out.includes('[ASSISTANT] planning'));
  assert.ok(out.includes('[tool-call: grep] {"pattern":"foo"}'));
  assert.ok(out.includes('[tool-result: grep] match at line 1'));
  assert.ok(out.includes('[tool-result: read] {"ok":true}'), 'OBJECT tool result rendered as JSON');
});

test('renderHistoryTurns: keeps the TAIL and marks truncation when over the cap', () => {
  const turns = [];
  for (let i = 0; i < 5000; i++) turns.push(textTurn('ASSISTANT', `turn number ${i}`));
  const out = renderHistoryTurns(turns, { capChars: 500 });
  assert.ok(out.length <= 500, 'respects the cap');
  assert.ok(out.startsWith('…[earlier transcript truncated]…'), 'marks the truncation');
  assert.ok(out.includes('turn number 4999'), 'keeps the most recent turn');
  assert.ok(!out.includes('turn number 0]'), 'drops the earliest turns');
});

test('readPriorTranscript: injected read returning work → rendered text + counts', async () => {
  const turns = [configTurn(), textTurn('ASSISTANT', 'already implemented the parser')];
  const read = async ({ elementInstanceKey }) => {
    assert.equal(elementInstanceKey, '9001');
    return turns;
  };
  const got = await readPriorTranscript({ job: { elementInstanceKey: '9001' }, read });
  assert.ok(got);
  assert.equal(got.historyCount, 2);
  assert.ok(got.text.includes('already implemented the parser'));
});

test('readPriorTranscript: null when no prior work, no eik, or read throws', async () => {
  assert.equal(await readPriorTranscript({ job: {}, read: async () => [textTurn('ASSISTANT', 'x')] }), null, 'no elementInstanceKey');
  assert.equal(await readPriorTranscript({ job: { elementInstanceKey: '1' }, read: async () => [configTurn()] }), null, 'config-only is not resumable');
  assert.equal(await readPriorTranscript({ job: { elementInstanceKey: '1' }, read: async () => [] }), null, 'empty history');
  assert.equal(await readPriorTranscript({ job: { elementInstanceKey: '1' }, read: async () => { throw new Error('engine down'); } }), null, 'read throw degrades to null');
});

test('readPriorTranscript: default SDK seam probes searchAgentInstances + embedded history', async () => {
  const camunda = {
    searchAgentInstances: async ({ filter }) => {
      assert.equal(filter.elementInstanceKey, '42');
      return { items: [{ elementInstanceKey: '42', agentInstanceKey: 'ai-1', history: [textTurn('ASSISTANT', 'prior work here')] }] };
    },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: '42' } });
  assert.ok(got);
  assert.ok(got.text.includes('prior work here'));
});

test('readPriorTranscript: default seam falls back to a history-by-key lookup', async () => {
  const calls = [];
  const camunda = {
    searchAgentInstances: async () => { calls.push('search'); return { items: [{ elementInstanceKey: '7', agentInstanceKey: 'ai-7' }] }; },
    getAgentInstanceHistory: async ({ agentInstanceKey }) => { calls.push('history'); assert.equal(agentInstanceKey, 'ai-7'); return { history: [textTurn('ASSISTANT', 'looked-up work')] }; },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: '7' } });
  assert.ok(got);
  assert.ok(got.text.includes('looked-up work'));
  assert.deepEqual(calls, ['search', 'history']);
});

test('readPriorTranscript: an SDK with no read surface → null (legacy cold rerun)', async () => {
  const got = await readPriorTranscript({ camunda: {}, job: { elementInstanceKey: '5' } });
  assert.equal(got, null);
});

test('buildResumePrompt: preserves the original task prompt and adds continuation framing', () => {
  const p = buildResumePrompt({ basePrompt: 'Implement the widget', transcriptText: '[ASSISTANT] started it' });
  assert.ok(p.includes('RESUMING'), 'signals a resume');
  assert.ok(p.includes('do NOT repeat'), 'warns against duplicate work');
  assert.ok(p.includes('UNCOMMITTED'), 'documents the uncommitted-loss scope');
  assert.ok(p.includes('[ASSISTANT] started it'), 'embeds the transcript');
  assert.ok(p.trimEnd().endsWith('Implement the widget'), 'original task prompt is preserved verbatim at the end');
});

test('seedResumeEnvelope: replaces only task.prompt, never mutates the original', () => {
  const envelope = { task: { prompt: 'do the thing', allowPr: true }, repository: { url: 'x' }, setup: { env: { A: '1' } } };
  const seeded = seedResumeEnvelope(envelope, '[ASSISTANT] partial');
  assert.notEqual(seeded, envelope, 'returns a new object');
  assert.equal(envelope.task.prompt, 'do the thing', 'original envelope is not mutated');
  assert.ok(seeded.task.prompt.includes('do the thing'), 'seeded prompt embeds the original');
  assert.ok(seeded.task.prompt.includes('RESUMING'));
  assert.equal(seeded.task.allowPr, true, 'other task fields preserved');
  assert.equal(seeded.repository, envelope.repository, 'repository preserved');
  assert.equal(seeded.setup, envelope.setup, 'setup preserved');
});

test('seedResumeEnvelope: returns the original when there is no task prompt to seed', () => {
  const noTask = { repository: { url: 'x' } };
  assert.equal(seedResumeEnvelope(noTask, 'transcript'), noTask);
});

test('isResumeDisabled: honours the NANO_AGENT_RESUME=off kill switch', () => {
  assert.equal(isResumeDisabled({ NANO_AGENT_RESUME: 'off' }), true);
  assert.equal(isResumeDisabled({ NANO_AGENT_RESUME: 'OFF' }), true);
  assert.equal(isResumeDisabled({ NANO_AGENT_RESUME: 'on' }), false);
  assert.equal(isResumeDisabled({}), false);
});

test('RESUME_CONTEXT_CAP_CHARS is a sane positive cap', () => {
  assert.ok(Number.isInteger(RESUME_CONTEXT_CAP_CHARS) && RESUME_CONTEXT_CAP_CHARS > 1000);
});
