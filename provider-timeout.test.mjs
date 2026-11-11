// #305: the harness provider timeout is derived from the worker idle-kill budget
// so a hung model request is retried inside the harness, never idle-killing the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProviderTimeoutSecs,
  providerTimeoutEnv,
  providerTimeoutWarning,
  PROVIDER_TIMEOUT_ENV,
  runAgentJob,
} from './c8ctl-plugin.js';

test('derived provider timeout is always strictly below the idle kill, for any idle budget', () => {
  const budgets = [1, 999, 1000, 1999, 2000, 2001, 3000, 59_999, 300_000, 600_000, 3_600_000, 2 ** 31];
  for (let i = 0; i < 2000; i++) budgets.push(Math.floor(Math.random() * 10_000_000) + 1);
  for (const idle of budgets) {
    const secs = deriveProviderTimeoutSecs(idle);
    if (secs == null) { assert.ok(idle < 2000, `null only for sub-2s budgets (got ${idle})`); continue; }
    assert.ok(Number.isInteger(secs) && secs >= 1);
    assert.ok(secs * 1000 < idle, `${secs}s must be < idle ${idle}ms`);
  }
  assert.equal(deriveProviderTimeoutSecs(300_000), 150);
  assert.equal(deriveProviderTimeoutSecs(0), null);
  assert.equal(deriveProviderTimeoutSecs(-5), null);
  assert.equal(deriveProviderTimeoutSecs(undefined), null);
  assert.deepEqual(providerTimeoutEnv(0), {});
  assert.deepEqual(providerTimeoutEnv(300_000), { [PROVIDER_TIMEOUT_ENV]: '150' });
});

test('startup warning fires when a configured provider timeout is >= the idle budget', () => {
  assert.match(providerTimeoutWarning({ [PROVIDER_TIMEOUT_ENV]: '600' }, 300_000), /idle budget/);
  assert.match(providerTimeoutWarning({ [PROVIDER_TIMEOUT_ENV]: '300' }, 300_000), /idle budget/);
  assert.equal(providerTimeoutWarning({ [PROVIDER_TIMEOUT_ENV]: '299' }, 300_000), null);
  assert.equal(providerTimeoutWarning({}, 300_000), null);
  assert.equal(providerTimeoutWarning({ [PROVIDER_TIMEOUT_ENV]: '600' }, 0), null);
});

const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
const envelope = { schemaVersion: 1, setup: { commands: [], env: {}, secretRefs: [] }, task: {} };
const profile = { name: 'p', rank: 'senior', command: `printf "%s" "$${PROVIDER_TIMEOUT_ENV}"`, model: '', capabilities: [] };

test('runAgentJob (host) passes the derived provider timeout to the harness', { skip: process.platform === 'win32' }, async () => {
  for (const idle of [5_000, 300_000, 1_234_567]) {
    const r = await runAgentJob(profile, job, { sandbox: 'none', envelope, timeoutMs: 30_000, idleTimeoutMs: idle });
    assert.equal(r.ok, true, r.error || r.stderr);
    assert.equal(Number(r.stdout), deriveProviderTimeoutSecs(idle));
    assert.ok(Number(r.stdout) * 1000 < idle);
  }
});

test('runAgentJob (host) lets an operator profile env override the derived timeout', { skip: process.platform === 'win32' }, async () => {
  const r = await runAgentJob(profile, job, { sandbox: 'none', envelope, timeoutMs: 30_000, idleTimeoutMs: 300_000, profileEnv: { [PROVIDER_TIMEOUT_ENV]: '42' } });
  assert.equal(r.stdout, '42');
});
