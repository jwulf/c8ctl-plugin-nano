// #336: each host agent job gets its own TMPDIR inside its run dir, and a host
// whose temp / agent-runs filesystem is nearly full sheds work with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobTmpDirFor, jobTmpEnv, hostTempBudget, JOB_TMP_ENV_KEYS, runAgentJob } from './c8ctl-plugin.js';

test('jobTmpDirFor places TMPDIR inside .git of a clone, else in the run dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'nano-tmpdir-test-'));
  try {
    const clone = join(root, 'workspace');
    mkdirSync(join(clone, '.git'), { recursive: true });
    assert.equal(jobTmpDirFor({ cwd: clone }), join(clone, '.git', 'nano-tmp'));
    assert.equal(jobTmpDirFor({ cwd: root }), join(root, '.nano-tmp'));
    assert.equal(jobTmpDirFor({ resultDir: '/r' }), join('/r', 'tmp'));
    assert.equal(jobTmpDirFor({}), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('jobTmpEnv sets TMPDIR/TMP/TEMP', () => {
  assert.deepEqual(jobTmpEnv(null), {});
  const env = jobTmpEnv('/x');
  for (const k of JOB_TMP_ENV_KEYS) assert.equal(env[k], '/x');
});

test('hostTempBudget reports the first path below the floor and fails open', () => {
  const statfs = (p) => ({ bavail: p === '/' ? 10 : 1_000_000, bsize: 1024 });
  assert.deepEqual(hostTempBudget({ paths: ['/'], minFreeBytes: 0, statfs }).ok, true);
  const low = hostTempBudget({ paths: [tmpdir(), '/'], minFreeBytes: 1_000_000, statfs });
  assert.equal(low.ok, false);
  assert.equal(low.path, '/');
  assert.equal(low.free, 10240);
  assert.equal(hostTempBudget({ paths: ['/'], minFreeBytes: 1, statfs: () => { throw new Error('x'); } }).ok, true);
});

test('runAgentJob (host) hands the harness the per-job TMPDIR', { skip: process.platform === 'win32' }, async () => {
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const envelope = { schemaVersion: 1, setup: { commands: [], env: {}, secretRefs: [] }, task: {} };
  const profile = { name: 'p', rank: 'senior', command: 'printf "%s|%s|%s" "$TMPDIR" "$TMP" "$TEMP"', model: '', capabilities: [] };
  const r = await runAgentJob(profile, job, { sandbox: 'none', envelope, timeoutMs: 30_000, tmpEnv: jobTmpEnv('/job/tmp') });
  assert.equal(r.ok, true, r.error || r.stderr);
  assert.equal(r.stdout, '/job/tmp|/job/tmp|/job/tmp');
});

test('boundJobTmpPath aliases a long TMPDIR so AF_UNIX sockets can bind under it', async () => {
  const { boundJobTmpPath } = await import('./c8ctl-plugin.js');
  const { rmSync: rm, realpathSync } = await import('node:fs');
  const { createServer } = await import('node:net');
  const root = mkdtempSync(join(tmpdir(), 'nano-tmpdir-sock-'));
  const deep = join(root, 'agent-runs', 'worker-12345-miv2abcd-0123456789ab', 'run-ABCDEFGH', 'workspace', '.git', 'nano-tmp');
  mkdirSync(deep, { recursive: true });
  const { path, alias } = boundJobTmpPath(deep);
  try {
    assert.ok(alias, 'long path gets an alias');
    assert.ok(path.length <= 64);
    assert.equal(realpathSync(path), realpathSync(deep));
    const sock = join(path, 'x'.repeat(30) + '.sock');
    await new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(sock, () => s.close(res)); });
    assert.deepEqual(boundJobTmpPath('/short'), { path: '/short', alias: null });
  } finally {
    if (alias) rm(alias, { force: true });
    rm(root, { recursive: true, force: true });
  }
});
