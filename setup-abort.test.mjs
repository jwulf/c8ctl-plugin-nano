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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSetupAbort, provisionRepo } from './c8ctl-plugin.js';

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
  // The prompt stage runs before any side effect, so it may honestly say so…
  assert.match(warns[0], /no repo work/i);
  assert.match(warns[0], /no settle/i);
  assert.match(warns[0], /yielded for retry/i);
});

test('checkSetupAbort message is stage-aware — it does NOT falsely claim "no repo side effects" at provisioning stages (#222)', () => {
  const ac = new AbortController();
  ac.abort();
  // At prompt: no work has happened, so the "before any side effect" wording is honest.
  {
    const { logger, warns } = collectingLogger();
    checkSetupAbort(ac.signal, { jobType: 't', jobKey: '1', stage: 'prompt', logger });
    assert.match(warns[0], /before any side effect/i);
  }
  // At repo-provisioning / relay-open the clone/config/branch may already exist, so the
  // message must NOT promise "before any side effect" — it only promises no settle and
  // that any partial workspace is left for reaping.
  for (const stage of ['repo-provisioning', 'relay-open']) {
    const { logger, warns } = collectingLogger();
    checkSetupAbort(ac.signal, { jobType: 't', jobKey: '1', stage, logger });
    assert.doesNotMatch(warns[0], /before any side effect/i, `'${stage}' must not claim it stopped before any side effect`);
    assert.doesNotMatch(warns[0], /no repo side effects/i, `'${stage}' must not claim no repo side effects`);
    assert.match(warns[0], /left for reaping/i, `'${stage}' should note the partial workspace is reaped`);
    assert.match(warns[0], /without a settle/i);
  }
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

// ---------------------------------------------------------------------------
// Runner-level coverage for the #222 setup-abort gate at the repo-provisioning
// boundary. `provisionRepo` runs blocking spawnSync git ops that cannot observe
// an AbortSignal mid-call, so it is made signal-aware by rechecking BETWEEN ops.
// These drive `provisionRepo` (the exported runner seam) with a fake git and an
// AbortSignal to prove: (a) an abort that landed before/during the clone stops
// BEFORE the next side effect (the base fetch) and throws so the caller returns
// without settling, and (b) a live signal is a no-op — provisioning proceeds.
// The fake never invokes real git, so these run without a git binary/network.
// ---------------------------------------------------------------------------

const gitOk = () => ({ status: 0, stdout: '', stderr: '', timedOut: false });

function baseFetchEnvelope(origin = 'https://example.com/o/r.git') {
  // A base ref triggers the post-clone base fetch — the next repo side effect the
  // gate must stop before once an abort has won.
  return {
    schemaVersion: 1,
    repository: { provider: 'github', url: origin, baseRef: 'main', singleBranch: true },
    branch: { base: 'main', push: true },
    setup: { commands: [], env: {}, secretRefs: [] },
    task: { allowPr: false },
  };
}

test('#222 provisionRepo bails after the clone when the signal is ALREADY aborted — throws before the base fetch (no side effect past the abort)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'nano-abort-'));
  const ac = new AbortController();
  ac.abort();
  const calls = [];
  const fakeGit = (args) => { calls.push(args); return gitOk(); };
  try {
    assert.throws(
      () => provisionRepo({ envelope: baseFetchEnvelope(), token: null, runDir, abortSignal: ac.signal, _runGit: fakeGit }),
      /provisioning aborted/,
      'an already-aborted signal throws a ProvisionError right after the clone',
    );
    assert.ok(calls.some((a) => a.includes('clone')), 'the clone (the first, dominant blocking op) still ran');
    assert.ok(!calls.some((a) => a.includes('fetch')), 'the base fetch never ran — provisioning stopped at the post-clone gate');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('#222 provisionRepo bails when the abort wins DURING the clone (mid-op race) — no base fetch, throws', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'nano-abort-'));
  const ac = new AbortController(); // live at entry (the pre-call gate passes)…
  const calls = [];
  const fakeGit = (args) => {
    calls.push(args);
    // …the lock-loss race wins DURING the blocking clone; the next between-ops
    // recheck must observe it.
    if (args.includes('clone')) ac.abort();
    return gitOk();
  };
  try {
    assert.throws(
      () => provisionRepo({ envelope: baseFetchEnvelope(), token: null, runDir, abortSignal: ac.signal, _runGit: fakeGit }),
      /provisioning aborted/,
      'an abort that lands during the clone is caught by the post-clone recheck',
    );
    assert.ok(!calls.some((a) => a.includes('fetch')), 'no base fetch after a mid-clone abort');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('#222 provisionRepo does NOT bail for a live (un-aborted) signal — the gate is abort-only; provisioning proceeds to the base fetch', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'nano-live-'));
  const ac = new AbortController(); // never aborted
  const calls = [];
  const SENTINEL = 'reached-base-fetch-sentinel';
  const fakeGit = (args) => {
    calls.push(args);
    // Prove execution reached the base fetch (i.e. the post-clone/pre-base-fetch
    // gates did NOT fire) by throwing a unique marker exactly there.
    if (args.includes('fetch')) throw new Error(SENTINEL);
    return gitOk();
  };
  try {
    assert.throws(
      () => provisionRepo({ envelope: baseFetchEnvelope(), token: null, runDir, abortSignal: ac.signal, _runGit: fakeGit }),
      new RegExp(SENTINEL),
      'a live signal lets provisioning proceed past the clone to the base fetch',
    );
    assert.ok(calls.some((a) => a.includes('clone')), 'the clone ran');
    assert.ok(calls.some((a) => a.includes('fetch')), 'the base fetch was reached — the abort gate stayed inert for a live signal');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// A SHA-pinned checkout runs TWO extra blocking git ops after the clone: `git
// fetch origin <sha>` then `git checkout --detach <sha>`. The post-clone recheck
// alone does not cover them, so an abort that wins while the fetch is blocking
// would still mutate the working tree with the checkout. #222: recheck BETWEEN the
// fetch and the checkout so a mid-fetch abort stops before the checkout.
function shaEnvelope(sha, origin = 'https://example.com/o/r.git') {
  return {
    schemaVersion: 1,
    repository: { provider: 'github', url: origin, sha, singleBranch: true },
    branch: { push: true },
    setup: { commands: [], env: {}, secretRefs: [] },
    task: { allowPr: false },
  };
}

test('#222 provisionRepo (SHA pin) bails when the abort wins DURING the sha fetch — throws before the checkout mutates the tree', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'nano-sha-abort-'));
  const sha = 'a'.repeat(40);
  const ac = new AbortController(); // live at entry and through the clone…
  const calls = [];
  const fakeGit = (args) => {
    calls.push(args);
    // …the lock-loss race wins WHILE `git fetch origin <sha>` is blocking; the
    // between-fetch-and-checkout recheck must observe it.
    if (args.includes('fetch') && args.includes(sha)) ac.abort();
    return gitOk();
  };
  try {
    assert.throws(
      () => provisionRepo({ envelope: shaEnvelope(sha), token: null, runDir, abortSignal: ac.signal, _runGit: fakeGit }),
      /provisioning aborted/,
      'an abort during the sha fetch is caught by the post-sha-fetch recheck',
    );
    assert.ok(calls.some((a) => a.includes('fetch') && a.includes(sha)), 'the sha fetch ran');
    assert.ok(!calls.some((a) => a.includes('checkout')), 'the detached checkout never ran — provisioning stopped before mutating the tree');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
