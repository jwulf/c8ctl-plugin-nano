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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  // inside the returned `elementInstanceKeys` array, not a singular scalar. The
  // embedded turn is element-tagged so the scoping keeps it (see the sibling-bleed
  // test for the un-tagged multi-element case).
  const camunda = {
    searchAgentInstances: async () => ({
      items: [{ elementInstanceKeys: ['sib-1', 'mine-2', 'sib-3'], agentInstanceKey: 'ai-m', history: [{ ...textTurn('ASSISTANT', 'my prior work'), elementInstanceKey: 'mine-2' }] }],
    }),
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'mine-2' } });
  assert.ok(got, 'matched via the plural array');
  assert.ok(got.text.includes('my prior work'));
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

test('seedResumeEnvelope: recovery text is conditional on a declared stable pushed branch', () => {
  // Branch recovery is promised ONLY when the envelope names a stable, already-pushed
  // branch the next activation re-clones with its commits — a `repository.ref` naming a
  // NON-base branch. Every other shape (repo-less, push-disabled, base-like ref,
  // explicit branch.create, detached SHA) degrades to transcript-only, and must NOT be
  // pointed at a branch that will not be provisioned.
  const pushed = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'feat/x', baseRef: 'main' }, branch: { push: true } }, 'T');
  assert.ok(pushed.task.prompt.includes('pushed branch'), 'non-base-ref job → branch recovery text');
  assert.ok(pushed.task.prompt.includes('UNCOMMITTED'), 'still documents the uncommitted-loss scope');

  const repoLess = seedResumeEnvelope({ task: { prompt: 'do it' } }, 'T');
  assert.ok(repoLess.task.prompt.includes('ONLY record'), 'repo-less job → transcript-only recovery text');
  assert.ok(!repoLess.task.prompt.includes('check out the'), 'no pushed-branch instruction for a repo-less job');

  const noPush = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'feat/x' }, branch: { push: false } }, 'T');
  assert.ok(noPush.task.prompt.includes('ONLY record'), 'branch.push=false → transcript-only recovery text');

  // branch.create → provisionRepo `checkout -B` off base, prior commits absent → NOT recoverable.
  const created = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'feat/x', baseRef: 'main' }, branch: { push: true, create: 'feat/new' } }, 'T');
  assert.ok(created.task.prompt.includes('ONLY record'), 'branch.create → transcript-only recovery text');

  // base-like ref (ref === baseRef) → fresh per-activation fallback branch → NOT recoverable.
  const baseLike = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'main', baseRef: 'main' }, branch: { push: true } }, 'T');
  assert.ok(baseLike.task.prompt.includes('ONLY record'), 'base-like ref → transcript-only recovery text');

  // raw commit SHA ref → detached HEAD, no branch → NOT recoverable.
  const detached = seedResumeEnvelope({ task: { prompt: 'do it' }, repository: { url: 'x', ref: 'a1b2c3d4e5f6' }, branch: { push: true } }, 'T');
  assert.ok(detached.task.prompt.includes('ONLY record'), 'commit-SHA ref → transcript-only recovery text');
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

test('readPriorTranscript: embedded history on a MULTI-element instance is not used verbatim (sibling bleed)', async () => {
  // The matched instance spans siblings and its embedded history is instance-level
  // (element-tagged). Only THIS element's turns may seed the job — a sibling's turn
  // (with sensitive tool output) must be dropped, not rendered.
  const camunda = {
    searchAgentInstances: async () => ({
      items: [{
        elementInstanceKeys: ['mine-1', 'sib-2'],
        agentInstanceKey: 'ai-multi',
        history: [
          { ...textTurn('ASSISTANT', 'MY prior turn'), elementInstanceKey: 'mine-1' },
          { ...textTurn('ASSISTANT', 'SIBLING secret'), elementInstanceKey: 'sib-2' },
        ],
      }],
    }),
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'mine-1' } });
  assert.ok(got, 'resumes from the element-scoped subset');
  assert.ok(got.text.includes('MY prior turn'), 'keeps this element');
  assert.ok(!got.text.includes('SIBLING secret'), 'drops a sibling element turn');
});

test('readPriorTranscript: multi-element embedded history with UN-tagged turns → falls through to the filtered fetch', async () => {
  // A multi-element instance whose embedded turns carry NO elementInstanceKey is
  // unverifiable, so the embedded history must be IGNORED and the element-filtered
  // searchAgentInstanceHistory fetch used instead.
  const calls = [];
  const camunda = {
    searchAgentInstances: async () => {
      calls.push('search');
      return { items: [{ elementInstanceKeys: ['a', 'b'], agentInstanceKey: 'ai-u', history: [textTurn('ASSISTANT', 'untagged embedded')] }] };
    },
    searchAgentInstanceHistory: async (q) => {
      calls.push('history');
      assert.equal(q.filter.elementInstanceKey, 'a');
      return { items: [textTurn('ASSISTANT', 'filtered fetch work')] };
    },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'a' } });
  assert.ok(got);
  assert.ok(got.text.includes('filtered fetch work'), 'used the filtered fetch');
  assert.ok(!got.text.includes('untagged embedded'), 'ignored the unverifiable embedded history');
  assert.deepEqual(calls, ['search', 'history']);
});

test('readPriorTranscript: follows the history cursor across ALL pages (no truncated transcript)', async () => {
  // The history search is cursor-paginated (`items` + `page.endCursor`); consuming
  // only the first page truncates a long transcript. Every page must be aggregated.
  const pages = {
    undefined: { items: [textTurn('ASSISTANT', 'turn-A')], page: { endCursor: 'c1' } },
    c1: { items: [textTurn('ASSISTANT', 'turn-B')], page: { endCursor: 'c2' } },
    c2: { items: [textTurn('ASSISTANT', 'turn-C')], page: { endCursor: null } },
  };
  const seen = [];
  const camunda = {
    searchAgentInstances: async () => ({ items: [{ elementInstanceKeys: ['p'], agentInstanceKey: 'ai-p' }] }),
    searchAgentInstanceHistory: async (q) => {
      const cursor = q.page?.after;
      seen.push(cursor ?? 'first');
      return pages[cursor];
    },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'p' } });
  assert.ok(got, 'aggregates across pages');
  assert.equal(got.historyCount, 3, 'all three pages collected');
  assert.ok(got.text.includes('turn-A') && got.text.includes('turn-B') && got.text.includes('turn-C'));
  assert.deepEqual(seen, ['first', 'c1', 'c2'], 'followed endCursor forward to exhaustion');
});

test('readPriorTranscript: a repeated history cursor does not loop forever', async () => {
  // A mispaginating surface that keeps returning the SAME endCursor must terminate.
  let n = 0;
  const camunda = {
    searchAgentInstances: async () => ({ items: [{ elementInstanceKeys: ['q'], agentInstanceKey: 'ai-q' }] }),
    searchAgentInstanceHistory: async () => { n++; return { items: [textTurn('ASSISTANT', `t${n}`)], page: { endCursor: 'stuck' } }; },
  };
  const got = await readPriorTranscript({ camunda, job: { elementInstanceKey: 'q' } });
  assert.ok(got);
  assert.equal(n, 2, 'stops after the cursor fails to advance (first page + one repeat probe)');
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
  const got = await resolveEffectiveEnvelope({ envelope, job, readPrior });
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
  let called = false;
  const nonExternal = await resolveEffectiveEnvelope({
    envelope, job: { elementInstanceKey: 'eik-1' }, readPrior: async () => { called = true; return withPrior(); },
  });
  assert.equal(nonExternal.envelope, envelope);
  assert.equal(nonExternal.resumed, false);
  assert.equal(called, false, 'ineligible job short-circuits before reading');

  // Kill switch off.
  const disabled = await resolveEffectiveEnvelope({ envelope, job: externalJob, env: { NANO_AGENT_RESUME: 'off' }, readPrior: withPrior });
  assert.equal(disabled.envelope, envelope);
  assert.equal(disabled.resumed, false);

  // AgentInstance producer off.
  const aiOff = await resolveEffectiveEnvelope({ envelope, job: externalJob, agentInstanceOff: true, readPrior: withPrior });
  assert.equal(aiOff.envelope, envelope);
  assert.equal(aiOff.resumed, false);

  // No prior work.
  const noPrior = await resolveEffectiveEnvelope({ envelope, job: externalJob, readPrior: async () => null });
  assert.equal(noPrior.envelope, envelope);
  assert.equal(noPrior.resumed, false);

  // Read throws — best-effort degrade to cold run.
  const threw = await resolveEffectiveEnvelope({ envelope, job: externalJob, readPrior: async () => { throw new Error('engine down'); } });
  assert.equal(threw.envelope, envelope);
  assert.equal(threw.resumed, false);

  // Prior exists but the envelope has no seedable prompt → not resumed, original returned.
  const noPrompt = { task: {} };
  const unseedable = await resolveEffectiveEnvelope({ envelope: noPrompt, job: externalJob, readPrior: withPrior });
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

// #239 wiring guard (source-scan). resolveEffectiveEnvelope is unit-tested above, but
// the VALUE only takes effect if workAgent hands the SEEDED envelope to runAgentJob. A
// regression that passed the ORIGINAL `envelope` (cold-run) into the harness would
// leave every helper test green while the harness silently ignored the resume. workAgent
// is not independently importable (it wires the live SDK job-worker loop), so — mirroring
// the repo's other source-scan lint (supervisor-engine-sdk-preference) — assert the
// handoff wires `effectiveEnvelope`, never a bare `envelope`, into the runAgentJob opts.
test('workAgent hands the resume-seeded envelope (not the original) to runAgentJob (#239 wiring)', () => {
  const src = readFileSync(fileURLToPath(new URL('./c8ctl-plugin.js', import.meta.url)), 'utf8');
  // The runOpts object literal built just before `runAgentJob(profile, job, runOpts)`.
  assert.match(src, /envelope:\s*effectiveEnvelope\b/, 'runAgentJob opts carry the seeded effectiveEnvelope');
  assert.doesNotMatch(src, /\brunOpts\s*=\s*\{[^}]*\benvelope:\s*envelope\b/s, 'the harness handoff must not pass the ORIGINAL envelope');
  // And effectiveEnvelope is actually derived from resolveEffectiveEnvelope, not aliased.
  assert.match(src, /resolveEffectiveEnvelope\(\{[^}]*\}\)/s, 'effectiveEnvelope comes from resolveEffectiveEnvelope');
});
