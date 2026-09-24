import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkpointConfig, checkpointRef, checkpointEligibility, classifyPushFailure, containsSecret, normalizeSecretValues, shouldSweep, sweepStaleCheckpoints, isDeniedPath, isCheckpointTrigger, createGitRunner,
  snapshotWorktree, pushCheckpoint, fetchCheckpoint, restoreCheckpoint, deleteCheckpointRef, redactUrlUserinfo,
  createWorkspaceCheckpoint, createCheckpointer, withCheckpointNote,
} from './agent-checkpoint.mjs';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-test-'));
  const remote = join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  sh(root, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  writeFileSync(join(seed, '.gitignore'), 'ignored/\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  const clone = (name) => {
    const dir = join(root, name);
    sh(root, 'clone', '-q', remote, dir);
    return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
  };
  return { root, remote, seed, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('config, ref, deny-list, triggers', () => {
  assert.equal(checkpointConfig({}).mode, 'auto');
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT: 'off' }).enabled, false);
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT: '0' }).mode, 'off');
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT: 'true' }).mode, 'on');
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT: 'bogus' }).mode, 'auto');
  const c = checkpointConfig({ NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_MIN_INTERVAL_MS: '10', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' });
  assert.equal(c.enabled, true);
  assert.equal(c.minIntervalMs, 5000);
  assert.equal(c.intervalMs, 0);
  assert.equal(checkpointRef('2251799813685249'), 'refs/nano/wip/2251799813685249');
  assert.equal(checkpointRef('../x'), null);
  assert.equal(checkpointRef(''), null);
  for (const p of ['.env', 'app/.env.local', 'id_rsa', 'k/server.pem', '.npmrc', 'x/.ssh/config']) assert.ok(isDeniedPath(p), p);
  for (const p of ['src/env.ts', 'README.md', 'environment.md']) assert.ok(!isDeniedPath(p), p);
  assert.ok(isCheckpointTrigger({ sessionUpdate: 'tool_call_update', status: 'completed' }));
  assert.ok(isCheckpointTrigger({ sessionUpdate: 'plan', entries: [] }));
  assert.ok(!isCheckpointTrigger({ sessionUpdate: 'tool_call_update', status: 'in_progress' }));
  assert.ok(!isCheckpointTrigger({ sessionUpdate: 'agent_message_chunk' }));
});

test('auto eligibility: only provisioned, authenticated, pushing jobs on a working branch', () => {
  const provisioned = { workspaceDir: '/w', workingBranch: 'feat/x' };
  const envelope = { branch: {} };
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned, envelope, token: 't' }).enabled, true);
  assert.match(checkpointEligibility({ mode: 'auto', provisioned, envelope: { branch: { push: false } }, token: 't' }).reason, /branch\.push=false/);
  assert.match(checkpointEligibility({ mode: 'auto', provisioned, envelope: { branch: { push: 'false' } }, token: 't' }).reason, /branch\.push=false/);
  assert.match(checkpointEligibility({ mode: 'auto', provisioned, envelope, token: null }).reason, /anonymous/);
  assert.match(checkpointEligibility({ mode: 'auto', provisioned: { workspaceDir: '/w' }, envelope, token: 't' }).reason, /detached/);
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned: null, envelope, token: 't' }).enabled, false);
  assert.equal(checkpointEligibility({ mode: 'on', provisioned: { workspaceDir: '/w' }, envelope: { branch: { push: false } }, token: null }).enabled, true);
  assert.equal(checkpointEligibility({ mode: 'off', provisioned, envelope, token: 't' }).enabled, false);
});

test('push failures are classified, not lumped together as "rejected"', () => {
  assert.equal(classifyPushFailure(' ! [rejected]        abc -> refs/nano/wip/1 (stale info)'), 'lease');
  assert.equal(classifyPushFailure('remote: error: GH013: Repository rule violations found for refs/nano/wip/1.\n ! [remote rejected] abc -> refs/nano/wip/1 (push declined due to repository rule violations)'), 'policy');
  assert.equal(classifyPushFailure('remote: - GITHUB PUSH PROTECTION\n ! [remote rejected] (push declined due to secret scanning)'), 'policy');
  assert.equal(classifyPushFailure('remote: Permission to o/r.git denied to bot.\nfatal: unable to access: The requested URL returned error: 403'), 'auth');
  assert.equal(classifyPushFailure('fatal: unable to access: Could not resolve host: github.com'), 'transient');
});

test('secret content detection: known values and common formats', () => {
  const vals = normalizeSecretValues(['short', '  s3cr3t-value-123  ', null, 's3cr3t-value-123']);
  assert.deepEqual(vals, ['short', 's3cr3t-value-123']);
  assert.ok(containsSecret('token = s3cr3t-value-123', vals));
  assert.ok(containsSecret('pin is short here', vals), 'short injected secret values are still scanned (no length floor)');
  assert.ok(containsSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'));
  assert.ok(containsSecret(`GH=ghp_${'a'.repeat(36)}`));
  assert.ok(containsSecret('aws AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!containsSecret('const x = process.env.GITHUB_TOKEN;', vals));
});

test('snapshot leaves HEAD/index/branch untouched and honours ignore + deny + size', async () => {
  const f = fixture();
  try {
    const { dir, git } = f.clone('w');
    const base = sh(dir, 'rev-parse', 'HEAD');
    assert.deepEqual(await snapshotWorktree({ git, baseSha: base }), { skipped: 'clean' });

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2048));
    writeFileSync(join(dir, 'config.js'), 'module.exports = { token: "s3cr3t-value-123" };\n');
    writeFileSync(join(dir, 'a-key.txt'), '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n');
    mkdirSync(join(dir, 'ignored'));
    writeFileSync(join(dir, 'ignored', 'x'), 'x');
    sh(dir, 'add', 'new.txt'); // agent's own staging must survive
    const statusBefore = sh(dir, 'status', '--porcelain');

    const snap = await snapshotWorktree({ git, baseSha: base, maxFileBytes: 1024, secretValues: ['s3cr3t-value-123'] });
    assert.ok(snap.sha, JSON.stringify(snap));
    assert.deepEqual(snap.excluded.map((e) => `${e.path}:${e.why}`).sort(), ['.env:denied', 'a-key.txt:secret-content', 'big.bin:too-large', 'config.js:secret-content']);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), base);
    assert.equal(sh(dir, 'status', '--porcelain'), statusBefore);
    const files = sh(dir, 'ls-tree', '-r', '--name-only', snap.sha).split('\n').sort();
    assert.deepEqual(files, ['.gitignore', 'a.txt', 'new.txt']);
    assert.equal(sh(dir, 'show', `${snap.sha}:a.txt`), 'two');
    assert.equal(sh(dir, 'rev-parse', `${snap.sha}^`), base);
    assert.match(sh(dir, 'log', '-1', '--format=%B', snap.sha), new RegExp(`Nano-Checkpoint-Base: ${base}`));

    assert.deepEqual(await snapshotWorktree({ git, baseSha: base, maxFileBytes: 1024, secretValues: ['s3cr3t-value-123'], lastTree: { tree: snap.tree, head: snap.head } }), { skipped: 'unchanged' });
  } finally { f.cleanup(); }
});

test('push → fetch → fast-forward restore recovers uncommitted work and local commits', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('42');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    sh(a.dir, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(a.dir, 'committed.txt'), 'c\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'local commit (never pushed)');
    writeFileSync(join(a.dir, 'a.txt'), 'edited\n');
    writeFileSync(join(a.dir, 'untracked.txt'), 'u\n');
    rmSync(join(a.dir, '.gitignore'));

    const take = createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base });
    const res = await take('tool');
    assert.ok(res.sha, JSON.stringify(res));
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);

    const b = f.clone('b');
    const fetched = await fetchCheckpoint({ git: b.git, ref });
    assert.equal(fetched.sha, res.sha);
    assert.equal(fetched.base, base);
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'fast-forward');
    assert.equal(restored.commitsRecovered, true);
    assert.equal(readFileSync(join(b.dir, 'a.txt'), 'utf8'), 'edited\n');
    assert.equal(readFileSync(join(b.dir, 'untracked.txt'), 'utf8'), 'u\n');
    assert.ok(existsSync(join(b.dir, 'committed.txt')));
    assert.ok(!existsSync(join(b.dir, '.gitignore')));
    assert.equal(sh(b.dir, 'log', '-1', '--format=%s'), 'local commit (never pushed)');
    const st = sh(b.dir, 'status', '--porcelain');
    assert.match(st, /^ ?M a\.txt$/m);
    assert.match(st, /\?\? untracked\.txt/);
    assert.match(st, /^ ?D \.gitignore$/m);

    assert.deepEqual(await deleteCheckpointRef({ git: b.git, ref }), { ok: true });
    assert.equal(await fetchCheckpoint({ git: f.clone('c').git, ref }), null);
    assert.equal((await deleteCheckpointRef({ git: b.git, ref })).ok, true);
  } finally { f.cleanup(); }
});

test('restore replays as a patch when the base moved on', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(a.dir, 'feature.txt'), 'wip\n');
    assert.ok((await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool')).sha);

    writeFileSync(join(f.seed, 'other.txt'), 'main moved\n');
    sh(f.seed, 'add', '-A');
    sh(f.seed, 'commit', '-q', '-m', 'advance main');
    sh(f.seed, 'push', '-q', 'origin', 'HEAD:main');

    const b = f.clone('b');
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: await fetchCheckpoint({ git: b.git, ref }) });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'patch');
    assert.equal(readFileSync(join(b.dir, 'feature.txt'), 'utf8'), 'wip\n');
    assert.ok(existsSync(join(b.dir, 'other.txt')));
    assert.equal(sh(b.dir, 'log', '-1', '--format=%s'), 'advance main');
  } finally { f.cleanup(); }
});

test('lease: a stale writer is rejected and stops writing', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('44');
    const a = f.clone('a');
    const b = f.clone('b');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(a.dir, 'x.txt'), 'a\n');
    const takeA = createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base });
    assert.ok((await takeA('tool')).sha);
    writeFileSync(join(b.dir, 'x.txt'), 'b\n');
    const snapB = await snapshotWorktree({ git: b.git, baseSha: base });
    assert.equal((await pushCheckpoint({ git: b.git, ref, sha: snapB.sha, expectSha: '' })).ok, false);
    assert.equal((await pushCheckpoint({ git: b.git, ref, sha: snapB.sha, expectSha: sh(f.root, '--git-dir', f.remote, 'rev-parse', ref) })).ok, true);
    writeFileSync(join(a.dir, 'x.txt'), 'a2\n');
    const res = await takeA('tool');
    assert.equal(res.rejected, true);
    assert.match((await takeA('tool')).skipped, /disabled/);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), snapB.sha);
  } finally { f.cleanup(); }
});

test('ownership: a newer run takes over from a superseded run\'s late write; the zombie stops', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('45');
    const z = f.clone('zombie');
    const base = sh(z.dir, 'rev-parse', 'HEAD');
    const takeZ = createWorkspaceCheckpoint({ git: z.git, ref, baseSha: base, runId: 'run-z' });
    writeFileSync(join(z.dir, 'x.txt'), 'z1\n');
    const z1 = await takeZ('tool');
    assert.ok(z1.sha);

    const n = f.clone('new');
    const prior = await fetchCheckpoint({ git: n.git, ref });
    assert.equal(prior.runId, 'run-z');
    assert.equal((await restoreCheckpoint({ git: n.git, checkpoint: prior })).restored, true);
    const takeN = createWorkspaceCheckpoint({ git: n.git, ref, baseSha: base, runId: 'run-n', expectSha: prior.sha, priorRunId: prior.runId });

    writeFileSync(join(z.dir, 'x.txt'), 'z2 (late abort flush)\n');
    assert.ok((await takeZ('final')).sha);

    writeFileSync(join(n.dir, 'x.txt'), 'n1\n');
    const n1 = await takeN('tool');
    assert.ok(n1.sha, JSON.stringify(n1));
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), n1.sha);

    writeFileSync(join(z.dir, 'x.txt'), 'z3\n');
    assert.equal((await takeZ('tool')).rejected, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), n1.sha);
  } finally { f.cleanup(); }
});

test('deleteCheckpointRef leases the delete so a stale run cannot remove a newer owner\'s WIP', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('46');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(a.dir, 'x.txt'), 'v1\n');
    const s1 = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool');
    assert.ok(s1.sha);
    // A newer run takes over and pushes a new sha over the top.
    const b = f.clone('b');
    writeFileSync(join(b.dir, 'x.txt'), 'v2\n');
    const snapB = await snapshotWorktree({ git: b.git, baseSha: base });
    assert.ok((await pushCheckpoint({ git: b.git, ref, sha: snapB.sha, expectSha: s1.sha })).ok);
    // The stale run's leased delete (expecting its own old sha) is refused; ref intact.
    const stale = await deleteCheckpointRef({ git: a.git, ref, expectSha: s1.sha });
    assert.equal(stale.staleLease, true, JSON.stringify(stale));
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), snapB.sha);
    // The current owner's leased delete (expecting the live sha) removes it.
    assert.equal((await deleteCheckpointRef({ git: b.git, ref, expectSha: snapB.sha })).ok, true);
    assert.equal(await fetchCheckpoint({ git: f.clone('c').git, ref }), null);
  } finally { f.cleanup(); }
});

test('coalesces a synchronous burst of triggers into a single trailing checkpoint', async () => {
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; };
  const clearTimer = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const advance = async (ms) => {
    t += ms;
    for (;;) {
      const due = timers.filter((h) => h.at <= t).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      clearTimer(due);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
  };
  const calls = [];
  const cp = createCheckpointer({
    checkpoint: async (reason) => { calls.push(reason); return { sha: `s${calls.length}`, reason }; },
    minIntervalMs: 60_000, intervalMs: 0, now: () => t, setTimer, clearTimer,
  });
  const done = { sessionUpdate: 'tool_call_update', status: 'completed' };
  // Four triggers land in ONE synchronous tick, before any checkpoint body runs.
  // The run slot is reserved synchronously, so the first fires and the rest coalesce
  // onto a single trailing checkpoint — not one push each.
  cp.notify(done); cp.notify(done); cp.notify(done); cp.notify(done);
  await advance(0);
  assert.deepEqual(calls, ['tool']);
  await advance(60_000);
  assert.deepEqual(calls, ['tool', 'tool']);
  await cp.flush('final', { timeoutMs: 0 });
});

test('a policy rejection stops checkpointing without the takeover path', async () => {
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, stdout: 'h\n', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'treeHead\n', stderr: '' };
    if (args[0] === 'write-tree') return { status: 0, stdout: `t${calls.length}\n`, stderr: '' };
    if (args[0] === 'commit-tree') return { status: 0, stdout: 'c\n', stderr: '' };
    if (args[0] === 'push') return { status: 1, stdout: '', stderr: ' ! [remote rejected] c -> refs/nano/wip/1 (push declined due to repository rule violations)' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const take = createWorkspaceCheckpoint({ git, ref: 'refs/nano/wip/1', baseSha: 'b', expectSha: 'old', priorRunId: 'r0' });
  const res = await take('tool');
  assert.equal(res.kind, 'policy');
  assert.match(res.disabled, /repository rule/);
  assert.ok(!calls.some((c) => c.startsWith('fetch')), 'no takeover fetch on a policy rejection');
  assert.match((await take('tool')).skipped, /^disabled/);
});

test('GC deletes TTL-expired and terminal-element refs, keeps own/unknown/fresh ones', async () => {
  const f = fixture();
  try {
    const w = f.clone('w');
    const base = sh(w.dir, 'rev-parse', 'HEAD');
    const put = async (key, ageMs) => {
      const date = `${Math.floor((Date.now() - ageMs) / 1000)} +0000`;
      const git = createGitRunner({ cwd: w.dir, env: { ...ENV, GIT_COMMITTER_DATE: date } });
      writeFileSync(join(w.dir, 'x.txt'), key);
      const snap = await snapshotWorktree({ git, baseSha: base });
      assert.ok((await pushCheckpoint({ git, ref: checkpointRef(key), sha: snap.sha })).ok);
    };
    const DAY = 86_400_000;
    await put('1', 8 * DAY); // ttl
    await put('2', 2 * 3_600_000); // terminal
    await put('3', 2 * 3_600_000); // unknown to engine
    await put('4', 60_000); // fresh, terminal but inside grace
    await put('5', 9 * DAY); // own ref, never swept
    const looked = [];
    const isTerminal = async (key) => { looked.push(key); if (key === '3') throw new Error('404'); return key === '2' || key === '4'; };
    const r = await sweepStaleCheckpoints({ git: w.git, ownRef: checkpointRef('5'), ttlMs: 7 * DAY, graceMs: 3_600_000, isTerminal });
    assert.deepEqual(r.deleted.map((d) => `${d.ref}:${d.why}`).sort(), ['refs/nano/wip/1:ttl', 'refs/nano/wip/2:element-terminal']);
    assert.deepEqual(looked.sort(), ['2', '3']);
    const left = sh(f.root, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/nano/wip/').split('\n').sort();
    assert.deepEqual(left, ['refs/nano/wip/3', 'refs/nano/wip/4', 'refs/nano/wip/5']);
    assert.equal(sh(w.dir, 'for-each-ref', 'refs/nano-gc/'), '', 'temporary GC refs are cleaned up');

    const reg = new Map();
    assert.equal(shouldSweep('r', { everyMs: 1000, now: 0, registry: reg }), true);
    assert.equal(shouldSweep('r', { everyMs: 1000, now: 500, registry: reg }), false);
    assert.equal(shouldSweep('r', { everyMs: 1000, now: 1500, registry: reg }), true);
  } finally { f.cleanup(); }
});

test('git diagnostics redact URL userinfo so a token in the remote never reaches a log', () => {
  const msg = "fatal: unable to access 'https://x-access-token:ghp_SECRET@github.com/o/r.git/': The requested URL returned error: 403";
  const red = redactUrlUserinfo(msg);
  assert.ok(!red.includes('ghp_SECRET'), 'the token is stripped');
  assert.ok(!red.includes('x-access-token'), 'the username is stripped');
  assert.ok(red.includes('https://***@github.com/o/r.git'), 'the host/path is preserved');
  // A non-URL '@' (email, scp-like remote) must be left untouched.
  assert.equal(redactUrlUserinfo('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

test('GC delete is leased: a ref moved after the scan is left intact', async () => {
  const f = fixture();
  try {
    const w = f.clone('w');
    const base = sh(w.dir, 'rev-parse', 'HEAD');
    const put = async (key, ageMs, content) => {
      const date = `${Math.floor((Date.now() - ageMs) / 1000)} +0000`;
      const git = createGitRunner({ cwd: w.dir, env: { ...ENV, GIT_COMMITTER_DATE: date } });
      writeFileSync(join(w.dir, 'x.txt'), content);
      const snap = await snapshotWorktree({ git, baseSha: base });
      assert.ok((await pushCheckpoint({ git, ref: checkpointRef(key), sha: snap.sha, expectSha: '' })).ok);
    };
    const DAY = 86_400_000;
    await put('9', 8 * DAY, 'old'); // TTL-expired -> doomed for deletion
    // Prepare a NEWER checkpoint SHA (a different activation's work) but don't push
    // it yet. The wrapper below force-pushes it onto the ref right before the sweep
    // tries its leased delete, moving the ref off the SHA the sweep observed.
    writeFileSync(join(w.dir, 'x.txt'), 'newer');
    const newer = await snapshotWorktree({ git: w.git, baseSha: base });
    let moved = false;
    const git = async (args, opts) => {
      if (!moved && args[0] === 'push' && args.includes(':refs/nano/wip/9')) {
        moved = true;
        await w.git(['push', '--quiet', '--no-verify', '--force', 'origin', `${newer.sha}:refs/nano/wip/9`]);
      }
      return w.git(args, opts);
    };
    const r = await sweepStaleCheckpoints({ git, ttlMs: 7 * DAY, graceMs: 3_600_000, isTerminal: null });
    assert.deepEqual(r.deleted, [], 'a ref that moved after the scan is not race-deleted');
    const left = sh(f.root, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/nano/wip/');
    assert.ok(left.split('\n').includes('refs/nano/wip/9'), 'the newer checkpoint survives the race');
  } finally { f.cleanup(); }
});

test('checkpointer rate-limits, coalesces triggers and flushes', async () => {
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; };
  const clearTimer = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const advance = async (ms) => {
    t += ms;
    for (;;) {
      const due = timers.filter((h) => h.at <= t).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      clearTimer(due);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
  };
  const calls = [];
  const seen = [];
  const cp = createCheckpointer({
    checkpoint: async (reason) => { calls.push(reason); return { sha: `s${calls.length}`, reason }; },
    onCheckpoint: (r) => { seen.push(r.sha); },
    minIntervalMs: 60_000, intervalMs: 300_000, now: () => t, setTimer, clearTimer,
  });
  const done = { sessionUpdate: 'tool_call_update', status: 'completed' };
  cp.notify(done);
  await advance(0);
  assert.deepEqual(calls, ['tool']);
  cp.notify(done); cp.notify({ sessionUpdate: 'plan' }); cp.notify(done);
  await advance(30_000);
  assert.equal(calls.length, 1);
  await advance(30_000);
  assert.deepEqual(calls, ['tool', 'tool']);
  await advance(240_000); // safety-net timer at 300s
  assert.deepEqual(calls, ['tool', 'tool', 'timer']);
  const final = await cp.flush('abort', { timeoutMs: 0 });
  assert.equal(final.reason, 'abort');
  assert.deepEqual(seen, ['s1', 's2', 's3', 's4']);
  cp.notify(done);
  await advance(600_000);
  assert.equal(calls.length, 4);
});

test('withCheckpointNote appends only for a restored checkpoint', () => {
  const env = { task: { prompt: 'do it' }, repository: {} };
  assert.equal(withCheckpointNote(env, { restored: false }), env);
  const seeded = withCheckpointNote(env, { restored: true, commitsRecovered: true });
  assert.match(seeded.task.prompt, /^do it\n/);
  assert.match(seeded.task.prompt, /WIP CHECKPOINT/);
  assert.match(seeded.task.prompt, /git status/);
  assert.equal(withCheckpointNote({ task: {} }, { restored: true }).task.prompt, undefined);
});

// ── c8ctl-plugin.js wiring (setupWorkspaceCheckpoints + job-handler seams) ──
import { setupWorkspaceCheckpoints } from './c8ctl-plugin.js';

const quietLogger = () => {
  const lines = { info: [], warn: [], debug: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), debug: (m) => lines.debug.push(m) };
};

test('setupWorkspaceCheckpoints: auto skips ineligible jobs; off / no elementInstanceKey disable', async () => {
  const provisioned = { workspaceDir: '/nonexistent' };
  const job = { jobKey: '1', elementInstanceKey: '2' };
  const l0 = quietLogger();
  assert.equal(await setupWorkspaceCheckpoints({ provisioned, envelope: {}, token: 't', job, jobType: 't', runId: 'r', logger: l0, env: {} }), null);
  assert.match(l0.lines.debug[0], /detached/);
  assert.equal(await setupWorkspaceCheckpoints({ provisioned: { ...provisioned, workingBranch: 'b' }, envelope: { branch: { push: false } }, token: 't', job, jobType: 't', runId: 'r', logger: quietLogger(), env: {} }), null);
  assert.equal(await setupWorkspaceCheckpoints({ provisioned: { ...provisioned, workingBranch: 'b' }, envelope: {}, token: 't', job, jobType: 't', runId: 'r', logger: quietLogger(), env: { NANO_AGENT_CHECKPOINT: 'off' } }), null);
  const logger = quietLogger();
  assert.equal(await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1' }, jobType: 't', runId: 'r', logger, env: { NANO_AGENT_CHECKPOINT: 'on' } }), null);
  assert.match(logger.lines.warn[0], /no usable elementInstanceKey/);
  assert.equal(await setupWorkspaceCheckpoints({ provisioned: null, job: { jobKey: '1', elementInstanceKey: '2' }, jobType: 't', runId: 'r', logger, env: { NANO_AGENT_CHECKPOINT: 'on' } }), null);
});

test('setupWorkspaceCheckpoints: checkpoint → variable → restore on the next activation → discard', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const job = { jobKey: '7', elementInstanceKey: '99' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      return { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    };
    const vars = [];
    const camunda = { createElementInstanceVariables: async (input) => { vars.push(input); } };

    const p1 = provision('run1');
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job, jobType: 't', runId: 'run-1', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    assert.equal(s1.restored, null);
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'half done\n');
    const res = await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(res.sha, JSON.stringify(res));
    assert.equal(vars.length, 1);
    assert.equal(vars[0].elementInstanceKey, '99');
    assert.equal(vars[0].local, true);
    assert.deepEqual({ ...vars[0].variables.agentCheckpoint, at: 'x' }, { ref: 'refs/nano/wip/99', sha: res.sha, head: p1.startSha, at: 'x', reason: 'abort', branch: 'nano/agent-work/main-x' });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'log', '-1', '--format=%an', 'refs/nano/wip/99'), 'bot');

    const p2 = provision('run2');
    const logger = quietLogger();
    await s1.close();
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job, jobType: 't', runId: 'run-2', camunda, logger, env, deps: { sweepRegistry: new Map() } });
    assert.equal(s2.restored?.restored, true);
    assert.match(logger.lines.info.join('\n'), /restored WIP checkpoint refs\/nano\/wip\/99/);
    assert.equal(readFileSync(join(p2.workspaceDir, 'wip.txt'), 'utf8'), 'half done\n');
    await s2.discard();
    await s2.close();
    assert.throws(() => sh(f.root, '--git-dir', f.remote, 'rev-parse', '--verify', 'refs/nano/wip/99'));
  } finally { f.cleanup(); }
});

test('setupWorkspaceCheckpoints: a variable-write failure warns once and never blocks the push', async () => {
  const f = fixture();
  try {
    const { dir } = f.clone('w');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: {}, startSha: sh(dir, 'rev-parse', 'HEAD') };
    const logger = quietLogger();
    const camunda = { createElementInstanceVariables: async () => { throw new Error('404 not supported'); } };
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '5' }, jobType: 't', runId: 'r', camunda, logger, env: { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' }, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    assert.ok((await s.checkpointer.flush('failed', { timeoutMs: 0 })).sha);
    assert.equal(logger.lines.warn.filter((l) => /agentCheckpoint variable/.test(l)).length, 1);
    assert.ok(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/5'));
    await s.close();
  } finally { f.cleanup(); }
});

test('setupWorkspaceCheckpoints: discardAfterAck deletes the ref after the workspace is reaped', async () => {
  const f = fixture();
  try {
    const { dir } = f.clone('acked');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: {}, startSha: sh(dir, 'rev-parse', 'HEAD') };
    const logger = quietLogger();
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '42' }, jobType: 't', runId: 'r', logger, env: { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' }, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    assert.ok((await s.checkpointer.flush('final', { timeoutMs: 0 })).sha);
    await s.close();
    rmSync(dir, { recursive: true, force: true });
    assert.ok(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/42'), 'kept until the ack');
    await s.discardAfterAck();
    assert.throws(() => sh(f.root, '--git-dir', f.remote, 'rev-parse', '--verify', 'refs/nano/wip/42'));
    assert.deepEqual(logger.lines.warn, []);
  } finally { f.cleanup(); }
});

test('createGitRunner suppresses configured credential helpers so the token is never persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckpt-cred-'));
  try {
    const marker = join(dir, 'helper-invoked');
    const helper = join(dir, 'cred-helper.sh');
    // A credential helper that RECORDS every invocation. If git consults it (as a
    // helper like `store` would), the token could be reused/persisted to disk.
    writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${marker}"\n`, { mode: 0o755 });
    const git = createGitRunner({ cwd: dir, env: ENV });
    assert.equal((await git(['init', '--quiet', '.'])).status, 0);
    // Configure the helper in repo config (an absolute path is exec'd directly).
    assert.equal((await git(['config', 'credential.helper', helper])).status, 0);
    // `git credential fill` consults the helper for a `get`. The runner injects
    // `-c credential.helper=`, which RESETS the helper list, so it must not run.
    await git(['credential', 'fill'], { input: 'protocol=https\nhost=example.invalid\n\n' });
    assert.ok(!existsSync(marker), 'credential helper must be suppressed on checkpoint git ops');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('job handler wires checkpoints: notify on ACP updates, flush on abort/failure, stop before finalize, discard after the complete ack', () => {
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const i = (s) => { const at = src.indexOf(s); assert.ok(at >= 0, `missing: ${s}`); return at; };
  const setup = i('await setupWorkspaceCheckpoints({ provisioned, envelope, token: repoToken, secretValues: Object.values(resolved');
  const note = i('effectiveEnvelope = withCheckpointNote(effectiveEnvelope, checkpointing.restored)');
  const notify = i('checkpointer?.notify(u)');
  const abort = i("await checkpointer.flush('abort'");
  const failed = i("await checkpointer.flush('failed'");
  const stop = i('if (checkpointer && result.ok) { await checkpointer.stop();');
  const finalize = src.indexOf('gitResult = finalizeGit({', stop);
  const decide = i('discardCheckpointOnAck = Boolean(checkpointing && result.ok');
  assert.ok(setup < note && note < notify && notify < abort && abort < failed && failed < stop && stop < finalize && finalize < decide);
  // #264 (review): the ref is discarded only when the branch was ACTUALLY pushed,
  // and the exception path takes a last-chance `failed` flush before close().
  assert.ok(src.slice(decide, decide + 200).includes('gitResult?.pushed'), 'discard requires a successful branch push');
  const lastChance = i("if (checkpointer && !checkpointFinalized) { try { await checkpointer.flush('failed'");
  const complete = src.indexOf('const settled = await settleJob.complete({', decide);
  const discard = src.indexOf('if (discardCheckpointOnAck) await checkpointing.discardAfterAck();', complete);
  assert.ok(complete > decide && discard > complete, 'the WIP ref is deleted only after the engine acks job.complete');
  assert.ok(discard < src.indexOf('return settled;', discard));
  assert.equal(src.indexOf('await checkpointing.discard()'), -1, 'no pre-ack delete remains');
  assert.ok(src.indexOf('envelope: effectiveEnvelope', setup) > setup, 'the restored note reaches the harness envelope');
  const close = i('await checkpointing.close()');
  assert.ok(lastChance > decide && lastChance < close, 'the exception path flushes a failed checkpoint before close()');
  assert.ok(close > decide && close < src.indexOf('rmSync(runDir', close), 'in-flight git work drains before the run dir is reaped');
});
