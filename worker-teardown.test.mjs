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
