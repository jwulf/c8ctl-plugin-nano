// Issue #328: a worker's runtime interrupt can hang forever; teardown must be bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  raceTeardown, workerTeardownTimeoutMs,
  WORKER_TEARDOWN_TIMEOUT_ENV, DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS,
} from './c8ctl-plugin.js';

test('raceTeardown times out on a promise that never settles', async () => {
  const t0 = Date.now();
  const r = await raceTeardown(new Promise(() => {}), 50);
  assert.deepEqual(r, { timedOut: true });
  assert.ok(Date.now() - t0 < 2000);
});

test('raceTeardown resolves when the interrupt completes', async () => {
  assert.deepEqual(await raceTeardown(Promise.resolve(1), 10_000), { timedOut: false });
});

test('raceTeardown captures a rejection instead of throwing', async () => {
  const err = new Error('boom');
  const r = await raceTeardown(Promise.reject(err), 10_000);
  assert.equal(r.timedOut, false);
  assert.equal(r.error, err);
});

test('workerTeardownTimeoutMs: default and env override', () => {
  assert.equal(workerTeardownTimeoutMs({}), DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS);
  assert.equal(workerTeardownTimeoutMs({ [WORKER_TEARDOWN_TIMEOUT_ENV]: '1500' }), 1500);
  assert.equal(workerTeardownTimeoutMs({ [WORKER_TEARDOWN_TIMEOUT_ENV]: 'nope' }), DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS);
  assert.equal(workerTeardownTimeoutMs({ [WORKER_TEARDOWN_TIMEOUT_ENV]: '0' }), DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS);
});

// --- worker stop lifecycle (#328 review) ---
import { createWorkerStopLifecycle } from './c8ctl-plugin.js';
const quiet = { info() {}, warn() {} };
function harness(extra = {}) {
  const calls = { exit: 0, processExit: [] };
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  // A live event-loop handle the stuck interrupt "holds".
  const live = setInterval(() => {}, 1000);
  const lc = createWorkerStopLifecycle({
    logger: quiet, teardownMs: 150, backstopMs: 20, pollMs: 5,
    interrupt: () => new Promise(() => {}), // never settles
    onExit: () => { calls.exit++; resolveExit(); },
    exitProcess: (code) => { calls.processExit.push(code); clearInterval(live); },
    ...extra,
  });
  return { lc, calls, exited, live };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lifecycle: stuck graceful drain exits at the teardown timeout and arms the process-exit backstop', async () => {
  const { lc, calls, exited } = harness();
  lc.gracefulDrain('SIGUSR2');
  await exited;
  assert.equal(calls.exit, 1);
  await sleep(60);
  assert.equal(calls.processExit.length, 1);
});

test('lifecycle: SIGUSR2 then SIGTERM before the timeout exits immediately', async () => {
  const { lc, calls, exited } = harness({ teardownMs: 60_000 });
  lc.gracefulDrain('SIGUSR2');
  await sleep(30); // teardown started, interrupt stuck
  const t0 = Date.now();
  lc.forceAbort('SIGTERM');
  await exited;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(calls.exit, 1);
  await sleep(60);
  assert.equal(calls.processExit.length, 1);
});

test('lifecycle: repeated SIGTERM during a stuck force abort exits immediately', async () => {
  let yielded = 0;
  const { lc, calls, exited } = harness({ teardownMs: 60_000, yieldInflight: async () => { yielded++; } });
  lc.forceAbort('SIGTERM');
  await sleep(10);
  assert.equal(calls.exit, 0);
  lc.forceAbort('SIGTERM');
  await exited;
  assert.equal(calls.exit, 1);
  await sleep(60);
  assert.equal(calls.processExit.length, 1);
  assert.equal(yielded, 0); // stuck abort never reached yield; no double exit
});

test('lifecycle: stuck force abort exits at the timeout, yields in-flight work once', async () => {
  const seen = [];
  const { lc, calls, exited } = harness({
    onAbortStart: () => [{ jobKey: 'k1' }],
    yieldInflight: async (inflight) => { seen.push(...inflight.map((j) => j.jobKey)); },
  });
  lc.forceAbort('SIGINT');
  await exited;
  assert.deepEqual(seen, ['k1']);
  assert.equal(calls.exit, 1);
  await sleep(60);
  assert.equal(calls.processExit.length, 1);
});

test('lifecycle: clean drain does not arm the backstop', async () => {
  let n = 1;
  const { lc, calls, exited, live } = harness({ interrupt: async () => {}, inFlightCount: () => n });
  lc.gracefulDrain('SIGUSR2');
  await sleep(20);
  assert.equal(calls.exit, 0);
  n = 0;
  await exited;
  clearInterval(live);
  await sleep(40);
  assert.equal(calls.processExit.length, 0);
  assert.equal(lc.state.backstopArmed, false);
});
