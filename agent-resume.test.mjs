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
  resolveEffectiveEnvelope,
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
      assert.deepEqual(filter.elementInstanceKeys, ['42'], 'sends the PLURAL elementInstanceKeys array filter');
      return { items: [{ elementInstanceKeys: ['42'], agentInstanceKey: 'ai-1', history: [textTurn('ASSISTANT', 'prior work here')] }] };
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

test('readPriorTranscript: resolves the instance then reads history via searchAgentInstanceHistory (issue #194)', async () => {
  // `searchAgentInstanceHistory` is keyed by `agentInstanceKey` (NOT an element
  // filter) per the real @camunda8/orchestration-cluster-api surface: the element
  // correlation happens via searchAgentInstances first, then history is read by the
  // resolved agentInstanceKey.
  const calls = [];
  const camunda = {
    searchAgentInstances: async ({ filter }) => {
      calls.push('search');
      assert.deepEqual(filter.elementInstanceKeys, ['99']);
      return { items: [{ elementInstanceKeys: ['99'], agentInstanceKey: 'ai-99' }] };
    },
    searchAgentInstanceHistory: async ({ agentInstanceKey }) => {
      calls.push('history');
      assert.equal(agentInstanceKey, 'ai-99', 'history read is keyed by the resolved agentInstanceKey');
      return { items: [textTurn('ASSISTANT', 'history-search work')] };
    },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: '99' } });
  assert.ok(got, 'resumes via instance-resolve → history-by-key');
  assert.ok(got.text.includes('history-search work'));
  assert.deepEqual(calls, ['search', 'history']);
});

test('readPriorTranscript: a client exposing ONLY searchAgentInstanceHistory cannot resume (needs an instance key)', async () => {
  // Without an instance-resolution surface there is no agentInstanceKey to key the
  // history search on, so resume degrades to a cold rerun rather than mis-calling the
  // API with a bare element key.
  const camunda = {
    searchAgentInstanceHistory: async () => ({ items: [textTurn('ASSISTANT', 'unreachable')] }),
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: '99' } });
  assert.equal(got, null);
});

test('readPriorTranscript: broad search with no exact element match → null (no cross-job transcript)', async () => {
  // A broader/unfiltered search result must NOT seed this job with another
  // element's transcript — an exact elementInstanceKey match is required. The real
  // result carries the PLURAL elementInstanceKeys array.
  const camunda = {
    searchAgentInstances: async () => ({
      items: [{ elementInstanceKeys: ['other-1'], agentInstanceKey: 'ai-x', history: [textTurn('ASSISTANT', 'someone else work')] }],
    }),
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'mine-2' } });
  assert.equal(got, null, 'no exact match → resume from nothing');
});

test('readPriorTranscript: matches an element within the PLURAL elementInstanceKeys array', async () => {
  // An AgentInstance can span several element instances; the exact match must look
  // inside the returned `elementInstanceKeys` array, not a singular scalar. And its
  // embedded history is INSTANCE-granular across those siblings, so it must be SCOPED
  // to THIS element — a sibling's turns must NOT bleed into this job's resume.
  const camunda = {
    searchAgentInstances: async () => ({
      items: [{
        elementInstanceKeys: ['sib-1', 'mine-2', 'sib-3'],
        agentInstanceKey: 'ai-m',
        history: [
          { ...textTurn('ASSISTANT', 'my prior work'), elementInstanceKey: 'mine-2' },
          { ...textTurn('ASSISTANT', 'a SIBLING element secret'), elementInstanceKey: 'sib-1' },
        ],
      }],
    }),
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'mine-2' } });
  assert.ok(got, 'matched via the plural array');
  assert.ok(got.text.includes('my prior work'));
  assert.ok(!got.text.includes('SIBLING element secret'), 'a sibling element\'s turns do not bleed in');
});

test('readPriorTranscript: a non-settling read is bounded by the deadline → null', async () => {
  // A read that never settles must not hold the job open before the harness starts.
  const camunda = { searchAgentInstances: () => new Promise(() => {}) };
  const got = await readPriorTranscript({
    camunda,
    job: { elementInstanceKey: '1' },
    read: () => new Promise(() => {}),
    readTimeoutMs: 5,
  });
  assert.equal(got, null, 'timed-out read degrades to a cold rerun');
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
  // A task object with no string prompt (e.g. `task: {}` or a blank prompt) has
  // nothing to continue — must be returned UNCHANGED, not wrapped in a RESUMING
  // preamble around an empty task (which would divert the job from its cold run).
  const emptyTask = { task: {}, repository: { url: 'x' } };
  assert.equal(seedResumeEnvelope(emptyTask, 'transcript'), emptyTask, 'task:{} → unchanged');
  const blankPrompt = { task: { prompt: '   ' } };
  assert.equal(seedResumeEnvelope(blankPrompt, 'transcript'), blankPrompt, 'blank prompt → unchanged');
  const nonStringPrompt = { task: { prompt: 42 } };
  assert.equal(seedResumeEnvelope(nonStringPrompt, 'transcript'), nonStringPrompt, 'non-string prompt → unchanged');
});

test('seedResumeEnvelope: recovery text is conditional on a declared pushed branch', () => {
  // A job that pushes onto a STABLE non-base branch (e.g. the PR head) is told committed
  // work is recoverable from it; a repo-less, push-disabled, base-only, or bare-URL job
  // is told the throwaway workspace is gone and the transcript is the only recoverable
  // state (never pointed at a branch whose prior commits the next clone won't have).
  const pushed = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'feat/thing', baseRef: 'main' }, branch: { push: true } }, 'T');
  assert.ok(pushed.task.prompt.includes('pushed branch'), 'stable non-base branch → branch recovery text');
  assert.ok(pushed.task.prompt.includes('UNCOMMITTED'), 'still documents the uncommitted-loss scope');

  const repoLess = seedResumeEnvelope({ task: { prompt: 'do it' } }, 'T');
  assert.ok(repoLess.task.prompt.includes('ONLY record'), 'repo-less job → transcript-only recovery text');
  assert.ok(!repoLess.task.prompt.includes('check out the'), 'no pushed-branch instruction for a repo-less job');

  const noPush = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'feat/thing' }, branch: { push: false } }, 'T');
  assert.ok(noPush.task.prompt.includes('ONLY record'), 'branch.push=false → transcript-only recovery text');

  // A push with NO stable non-base ref (a bare-URL / base-only clone, or a per-run
  // fallback / `branch.create`) is NOT recoverable: the next activation re-clones the
  // base and never fetches the prior per-run branch, so the commits are gone.
  const noRef = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x' }, branch: { push: true } }, 'T');
  assert.ok(noRef.task.prompt.includes('ONLY record'), 'push but no stable ref → transcript-only recovery text');
  const baseRef = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'main', baseRef: 'main' }, branch: { push: true } }, 'T');
  assert.ok(baseRef.task.prompt.includes('ONLY record'), 'ref === baseRef → transcript-only recovery text');
});

test('readPriorTranscript: passes the mandatory consistency option and scopes history to THIS element', async () => {
  // The real @camunda8 facade THROWS synchronously without `{ consistency }` on these
  // eventually-consistent reads; the fakes mirror that guard so a regression that drops
  // the option is caught here instead of silently cold-running against the real client.
  // The history read also carries the current `elementInstanceKey` filter so a shared
  // AgentInstance spanning siblings never bleeds another element's turns in.
  const guard = (ec) => { if (!ec || !ec.consistency) throw new Error('Missing consistency options'); };
  const camunda = {
    searchAgentInstances: async (_q, ec) => { guard(ec); return { items: [{ elementInstanceKeys: ['77', 'sib-9'], agentInstanceKey: 'ai-77' }] }; },
    searchAgentInstanceHistory: async (q, ec) => {
      guard(ec);
      assert.equal(q.agentInstanceKey, 'ai-77', 'history keyed by the resolved agentInstanceKey');
      assert.equal(q.filter.elementInstanceKey, '77', 'history is scoped to THIS element instance');
      return { items: [textTurn('ASSISTANT', 'scoped work')] };
    },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: '77' } });
  assert.ok(got, 'resumes when the reads receive their consistency option');
  assert.ok(got.text.includes('scoped work'));
});

test('renderHistoryTurns: an empty TOOL_RESULT renders an explicit result, never a re-invocation', () => {
  // A side-effecting tool that returned nothing yields a TOOL_RESULT with empty
  // content but retained toolCalls. It must NOT render as a `[tool-call: ...]` line
  // (which a resumed agent could read as "run it again").
  const emptyResult = { role: 'TOOL_RESULT', content: [], toolCalls: [{ toolCallId: 'c1', toolName: 'deploy' }] };
  const out = renderHistoryTurns([textTurn('USER', 'go'), emptyResult]);
  assert.ok(out.includes('[tool-result: deploy] (no output)'), 'empty tool result is explicit');
  assert.ok(!out.includes('[tool-call: deploy]'), 'never rendered as a fresh invocation');
});

test('resolveEffectiveEnvelope: external job with prior transcript → resume-seeded envelope', async () => {
  const envelope = { task: { prompt: 'original task' } };
  const job = { leaseToken: 'lease-1', elementInstanceKey: 'eik-1' };
  const readPrior = async () => ({ text: '[ASSISTANT] partial', historyCount: 3 });
  // Inject an explicit ENABLED env so an ambient `NANO_AGENT_RESUME=off` in the runner
  // can't turn this positive case into a false pass (the kill switch must not decide it).
  const got = await resolveEffectiveEnvelope({ envelope, job, env: {}, readPrior });
  assert.equal(got.resumed, true);
  assert.equal(got.historyCount, 3);
  assert.notEqual(got.envelope, envelope, 'a new, seeded envelope is returned');
  assert.ok(got.envelope.task.prompt.includes('RESUMING'));
  assert.ok(got.envelope.task.prompt.includes('original task'));
});

test('resolveEffectiveEnvelope: ineligible / disabled / no-prior → original envelope (cold run)', async () => {
  const envelope = { task: { prompt: 'original task' } };
  const externalJob = { leaseToken: 'lease-1', elementInstanceKey: 'eik-1' };
  const withPrior = async () => ({ text: '[ASSISTANT] x', historyCount: 1 });

  // Not an external agent job (no lease / eik) — never reads, returns original.
  // Each sub-case injects an explicit ENABLED env (`env: {}`) so the assertion proves
  // the intended reason (ineligible / no-prior / throw / unseedable) rather than being
  // masked by an ambient `NANO_AGENT_RESUME=off`; the kill-switch case sets env itself.
  let called = false;
  const nonExternal = await resolveEffectiveEnvelope({
    envelope, job: { elementInstanceKey: 'eik-1' }, env: {}, readPrior: async () => { called = true; return withPrior(); },
  });
  assert.equal(nonExternal.envelope, envelope);
  assert.equal(nonExternal.resumed, false);
  assert.equal(called, false, 'ineligible job short-circuits before reading');

  // Kill switch off.
  const disabled = await resolveEffectiveEnvelope({ envelope, job: externalJob, env: { NANO_AGENT_RESUME: 'off' }, readPrior: withPrior });
  assert.equal(disabled.envelope, envelope);
  assert.equal(disabled.resumed, false);

  // AgentInstance producer off.
  const aiOff = await resolveEffectiveEnvelope({ envelope, job: externalJob, env: {}, agentInstanceOff: true, readPrior: withPrior });
  assert.equal(aiOff.envelope, envelope);
  assert.equal(aiOff.resumed, false);

  // No prior work.
  const noPrior = await resolveEffectiveEnvelope({ envelope, job: externalJob, env: {}, readPrior: async () => null });
  assert.equal(noPrior.envelope, envelope);
  assert.equal(noPrior.resumed, false);

  // Read throws — best-effort degrade to cold run.
  const threw = await resolveEffectiveEnvelope({ envelope, job: externalJob, env: {}, readPrior: async () => { throw new Error('engine down'); } });
  assert.equal(threw.envelope, envelope);
  assert.equal(threw.resumed, false);

  // Prior exists but the envelope has no seedable prompt → not resumed, original returned.
  const noPrompt = { task: {} };
  const unseedable = await resolveEffectiveEnvelope({ envelope: noPrompt, job: externalJob, env: {}, readPrior: withPrior });
  assert.equal(unseedable.envelope, noPrompt);
  assert.equal(unseedable.resumed, false);
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
