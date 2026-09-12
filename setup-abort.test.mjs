// Tests for the #222 setup-phase abort gate. #221 makes the dispatch heartbeat
// interrupt the agent on a definitive lease loss, honoured by `runAgentJob` via
// the forwarded AbortSignal. But `workAgent` does prompt/AgentInstance setup,
// repo provisioning, and `relaySessionFor` (which emits `lifecycle/open`, the
// first transcript event) BEFORE it reaches `runAgentJob`. `checkSetupAbort` is
// the gate the runner calls at each of those pre-`runAgentJob` stage boundaries
// so a lock-loss race stops the run before a transcript husk or repo side effect,
// and skips settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSetupAbort } from './c8ctl-plugin.js';

function collectingLogger() {
  const warns = [];
  return { logger: { warn: (m) => warns.push(m) }, warns };
}

test('checkSetupAbort is a no-op (false, no log) when the signal is undefined/null', () => {
  const { logger, warns } = collectingLogger();
  assert.equal(checkSetupAbort(undefined, { jobType: 'senior:feature', jobKey: '1', stage: 'prompt', logger }), false);
  assert.equal(checkSetupAbort(null, { jobType: 'senior:feature', jobKey: '1', stage: 'prompt', logger }), false);
  assert.equal(warns.length, 0, 'a missing signal must not log — the normal path is unchanged');
});

test('checkSetupAbort is a no-op (false, no log) when the signal has NOT aborted', () => {
  const { logger, warns } = collectingLogger();
  const ac = new AbortController();
  assert.equal(checkSetupAbort(ac.signal, { jobType: 'senior:feature', jobKey: '1', stage: 'prompt', logger }), false);
  assert.equal(warns.length, 0, 'a live (un-aborted) signal is the graceful/normal path — no gate, no log');
});

test('checkSetupAbort returns true and logs once when the signal is already aborted', () => {
  const { logger, warns } = collectingLogger();
  const ac = new AbortController();
  ac.abort();
  assert.equal(checkSetupAbort(ac.signal, { jobType: 'senior:feature', jobKey: '42', stage: 'prompt', logger }), true);
  assert.equal(warns.length, 1, 'a single stage abort logs exactly once');
  assert.match(warns[0], /job 42 aborted during setup \(prompt\)/);
  assert.match(warns[0], /no transcript husk/i);
  assert.match(warns[0], /no settle/i);
});

test('checkSetupAbort names the stage it gated so each setup boundary is distinguishable', () => {
  const ac = new AbortController();
  ac.abort();
  for (const stage of ['prompt', 'agent-instance', 'repo-provisioning', 'relay-open']) {
    const { logger, warns } = collectingLogger();
    assert.equal(checkSetupAbort(ac.signal, { jobType: 'senior:feature', jobKey: '7', stage, logger }), true);
    assert.match(warns[0], new RegExp(`\\(${stage}\\)`), `log must name the '${stage}' stage`);
  }
});

test('checkSetupAbort tolerates a logger without warn (best-effort) and a missing ctx', () => {
  const ac = new AbortController();
  ac.abort();
  // No logger / no ctx at all — still reports the abort without throwing.
  assert.equal(checkSetupAbort(ac.signal), true);
  assert.equal(checkSetupAbort(ac.signal, { jobType: 'x', jobKey: '1', stage: 'prompt', logger: {} }), true);
  // A live signal with no logger is still a silent no-op.
  const live = new AbortController();
  assert.equal(checkSetupAbort(live.signal, {}), false);
});
