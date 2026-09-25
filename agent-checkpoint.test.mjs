import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkpointConfig, checkpointRef, checkpointEligibility, classifyPushFailure, containsSecret, normalizeSecretValues, credentialsFromUrl, isAuthenticatedRemote, shouldSweep, sweepStaleCheckpoints, isDeniedPath, isCheckpointTrigger, createGitRunner,
  snapshotWorktree, pushCheckpoint, fetchCheckpoint, restoreCheckpoint, deleteCheckpointRef, redactUrlUserinfo, CHECKPOINT_DETACHED_MARKER,
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
  for (const p of ['.env', 'app/.env.local', '.envrc', 'app/.envlocal', 'id_rsa', 'id_token', 'x/id_ed25519_old', 'id_custom', 'k/server.pem', '.npmrc', 'x/.ssh/config']) assert.ok(isDeniedPath(p), p);
  for (const p of ['src/env.ts', 'README.md', 'environment.md', 'src/identity.ts']) assert.ok(!isDeniedPath(p), p);
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
  // Authentication is not synonymous with a token: an SSH remote or an author-
  // embedded HTTPS-userinfo URL authenticates the push with no token, and
  // provisioning's stamped `authenticated` result is honoured.
  assert.equal(isAuthenticatedRemote('git@github.com:o/r.git'), true);
  assert.equal(isAuthenticatedRemote('ssh://git@github.com/o/r.git'), true);
  assert.equal(isAuthenticatedRemote('https://user:pw@github.com/o/r.git'), true);
  assert.equal(isAuthenticatedRemote('https://github.com/o/r.git'), false);
  assert.equal(isAuthenticatedRemote(''), false);
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned: { ...provisioned, authenticated: true }, envelope, token: null }).enabled, true);
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned, envelope: { branch: {}, repository: { url: 'git@github.com:o/r.git' } }, token: null }).enabled, true);
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned, envelope: { branch: {}, repository: { url: 'https://user:pw@github.com/o/r.git' } }, token: null }).enabled, true);
  assert.equal(checkpointEligibility({ mode: 'auto', provisioned: { ...provisioned, authenticated: false }, envelope: { branch: {}, repository: { url: 'https://github.com/o/r.git' } }, token: null }).enabled, false);
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

test('restore refuses to fast-restore a snapshot taken on a different branch', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43b');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    // The agent wandered off the work branch: it checks out a side branch, commits
    // there (descending from the shared base), and gets interrupted mid-work.
    sh(a.dir, 'checkout', '-q', '-b', 'sidebranch');
    writeFileSync(join(a.dir, 'off.txt'), 'off-branch work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'off-branch commit');
    writeFileSync(join(a.dir, 'wip.txt'), 'wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool');
    assert.ok(res.sha, JSON.stringify(res));

    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'sidebranch');

    // A fresh run whose expected work branch is 'work' must NOT fast-restore the
    // sidebranch snapshot — that would reset 'work' to the off-branch commit and let
    // finalizeGit publish it to the wrong branch. Refuse and retain the ref.
    const b = f.clone('b');
    const mismatch = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'work' });
    assert.equal(mismatch.restored, false, JSON.stringify(mismatch));
    assert.equal(mismatch.branchMismatch, true);
    assert.ok(!existsSync(join(b.dir, 'off.txt')));
    assert.equal(sh(b.dir, 'log', '-1', '--format=%s'), 'init');
    // The checkpoint is retained for explicit recovery.
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);

    // The matching branch (or a legacy caller passing no expectedBranch) restores.
    const c = f.clone('c');
    const match = await restoreCheckpoint({ git: c.git, checkpoint: fetched, expectedBranch: 'sidebranch' });
    assert.equal(match.restored, true, JSON.stringify(match));
    assert.equal(match.mode, 'fast-forward');
    assert.ok(existsSync(join(c.dir, 'off.txt')));

    const d = f.clone('d');
    const legacy = await restoreCheckpoint({ git: d.git, checkpoint: fetched });
    assert.equal(legacy.restored, true, JSON.stringify(legacy));
  } finally { f.cleanup(); }
});

test('restore refuses to fast-restore a snapshot taken on a DETACHED HEAD', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43d');
    const a = f.clone('a');
    // The agent wandered off onto a detached HEAD: it detaches, commits there
    // (descending from the shared base / work-branch tip), and gets interrupted.
    sh(a.dir, 'checkout', '-q', '--detach');
    writeFileSync(join(a.dir, 'off.txt'), 'detached work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'detached commit');
    const base = sh(a.dir, 'rev-parse', 'HEAD~1');
    writeFileSync(join(a.dir, 'wip.txt'), 'wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool');
    assert.ok(res.sha, JSON.stringify(res));

    // A detached snapshot records an explicit detached marker (NOT an omitted
    // trailer) so restore can tell it apart from a legacy trailerless snapshot.
    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, CHECKPOINT_DETACHED_MARKER);

    // A fresh run on work branch 'main' must NOT fast-restore the detached snapshot
    // even though its parent is an ancestor of HEAD — that would reset 'main' to the
    // off-branch/detached commit and let finalizeGit publish it. Refuse and retain.
    const b = f.clone('b');
    const mismatch = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(mismatch.restored, false, JSON.stringify(mismatch));
    assert.equal(mismatch.branchMismatch, true);
    assert.match(mismatch.reason, /detached HEAD/);
    assert.ok(!existsSync(join(b.dir, 'off.txt')));
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);

    // A legacy caller (no expectedBranch) keeps the prior ancestry-only fast path.
    const c = f.clone('c');
    const legacy = await restoreCheckpoint({ git: c.git, checkpoint: fetched });
    assert.equal(legacy.restored, true, JSON.stringify(legacy));
    assert.equal(legacy.mode, 'fast-forward');
  } finally { f.cleanup(); }
});

test('restore recovers WIP across a per-run fallback branch rename via a non-reset patch', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43f');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    // Run 1 was provisioned onto a PER-RUN fallback branch (the base moved / no stable
    // branch.create), committed work on it, then left uncommitted WIP when interrupted.
    sh(a.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-11111111-1111-4111-8111-111111111111');
    writeFileSync(join(a.dir, 'feature.txt'), 'committed work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'run1 commit');
    writeFileSync(join(a.dir, 'wip.txt'), 'uncommitted wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool');
    assert.ok(res.sha, JSON.stringify(res));

    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'nano/agent-work/main-11111111-1111-4111-8111-111111111111');

    // Run 2 re-activates: provisioning cuts a FRESH fallback branch with a new runId,
    // so its name necessarily differs from the snapshot's. Marked ephemeral, restore
    // must still refuse the ancestry-RESET fast path but fall through to the non-reset
    // PATCH restore, recovering the WIP instead of stranding it (issues from round 8).
    const b = f.clone('b');
    sh(b.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-22222222-2222-4222-8222-222222222222');
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'nano/agent-work/main-22222222-2222-4222-8222-222222222222', expectedBranchEphemeral: true });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'patch');
    assert.equal(readFileSync(join(b.dir, 'feature.txt'), 'utf8'), 'committed work\n');
    assert.equal(readFileSync(join(b.dir, 'wip.txt'), 'utf8'), 'uncommitted wip\n');
    // No branch pointer moved: HEAD is still 'init' and the recovery is uncommitted.
    assert.equal(sh(b.dir, 'log', '-1', '--format=%s'), 'init');
    assert.ok(sh(b.dir, 'status', '--porcelain').length > 0);

    // WITHOUT the ephemeral marker, the same name change is a GENUINE mismatch: a
    // stable-branch job must not silently recover cross-branch. Refuse and retain.
    const c = f.clone('c');
    sh(c.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-22222222-2222-4222-8222-222222222222');
    const blocked = await restoreCheckpoint({ git: c.git, checkpoint: fetched, expectedBranch: 'nano/agent-work/main-22222222-2222-4222-8222-222222222222' });
    assert.equal(blocked.restored, false, JSON.stringify(blocked));
    assert.equal(blocked.branchMismatch, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);
  } finally { f.cleanup(); }
});

test('restore refuses an UNRELATED branch under the fallback namespace (prefix alone is not identity)', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43x');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    // The agent checked out its OWN branch that merely happens to live under the
    // nano/agent-work/ namespace (no generated <base>-<runToken> identity), committed,
    // and left WIP. Its snapshot must NOT be treated as a benign per-run rename of a
    // DIFFERENT-base generated fallback and cross-restored onto it.
    sh(a.dir, 'checkout', '-q', '-b', 'nano/agent-work/my-feature');
    writeFileSync(join(a.dir, 'feature.txt'), 'off-branch work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'off-branch commit');
    writeFileSync(join(a.dir, 'wip.txt'), 'off-branch wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'nano/agent-work/my-feature');

    // Run 2 is on a GENUINE generated fallback with a UUID run-token off base 'main'.
    // The snapshot's branch shares the namespace prefix but is NOT a generated fallback
    // (no run-token) and is a different base, so even marked ephemeral it stays a
    // branch-mismatch refusal rather than a benign rename.
    const b = f.clone('b');
    const gen = 'nano/agent-work/main-33333333-3333-4333-8333-333333333333';
    sh(b.dir, 'checkout', '-q', '-b', gen);
    const blocked = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: gen, expectedBranchEphemeral: true });
    assert.equal(blocked.restored, false, JSON.stringify(blocked));
    assert.equal(blocked.branchMismatch, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);

    // A same-base generated fallback with a DIFFERENT run-token IS a benign rename.
    const a2 = f.clone('a2');
    sh(a2.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-55555555-5555-4555-8555-555555555555');
    writeFileSync(join(a2.dir, 'feature.txt'), 'committed\n');
    sh(a2.dir, 'add', '-A'); sh(a2.dir, 'commit', '-q', '-m', 'gen commit');
    writeFileSync(join(a2.dir, 'wip.txt'), 'gen wip\n');
    const ref2 = checkpointRef('43y');
    const gres = await createWorkspaceCheckpoint({ git: a2.git, ref: ref2, baseSha: base })('tool');
    assert.ok(gres.sha, JSON.stringify(gres));
    // Re-activation: a FRESH clone (post-checkpoint) fetches the ref into its own repo,
    // then restores — mirroring the real setup flow (fetch + restore on the same repo).
    const c = f.clone('c');
    sh(c.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-44444444-4444-4444-8444-444444444444');
    const gfetched = await fetchCheckpoint({ git: c.git, ref: ref2 });
    const ok2 = await restoreCheckpoint({ git: c.git, checkpoint: gfetched, expectedBranch: 'nano/agent-work/main-44444444-4444-4444-8444-444444444444', expectedBranchEphemeral: true });
    assert.equal(ok2.restored, true, JSON.stringify(ok2));
    assert.equal(ok2.mode, 'patch');
  } finally { f.cleanup(); }
});

test('unborn HEAD: pre-first-commit WIP is snapshotted parentless and restored onto a fresh unborn clone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-unborn-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const clone = (name) => {
      const dir = join(root, name);
      sh(root, 'clone', '-q', remote, dir);
      return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
    };
    const ref = checkpointRef('43u');
    const a = clone('a');
    // Fresh clone of an EMPTY repo: HEAD is unborn (no commit yet), yet provisioning
    // treats such a clone as pushable — so pre-first-commit WIP is checkpoint-eligible.
    assert.equal(sh(a.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    writeFileSync(join(a.dir, 'draft.txt'), 'pre-commit wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref })('tool');
    assert.ok(res.sha, JSON.stringify(res));

    // The snapshot is PARENTLESS (there is no HEAD to descend from).
    const fetched = await fetchCheckpoint({ git: clone('probe').git, ref });
    assert.equal(fetched.parent, '');

    // Restore onto a fresh unborn clone lays the tree back as uncommitted work; HEAD
    // stays unborn (no commit materialises) and the file returns to the working tree.
    const b = clone('b');
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'unborn');
    assert.equal(readFileSync(join(b.dir, 'draft.txt'), 'utf8'), 'pre-commit wip\n');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: b.dir, env: ENV }).status, 1);

    // An unborn snapshot must NOT be forced onto a clone that already has commits.
    const c = clone('c');
    writeFileSync(join(c.dir, 'x.txt'), 'x\n');
    sh(c.dir, 'add', '-A');
    sh(c.dir, 'commit', '-q', '-m', 'first');
    const refused = await restoreCheckpoint({ git: c.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(refused.restored, false, JSON.stringify(refused));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty-base run: the first local commit is checkpointed, not skipped as clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-emptybase-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const dir = join(root, 'a');
    sh(root, 'clone', '-q', remote, dir);
    const git = createGitRunner({ cwd: dir, env: ENV });

    // Unborn HEAD, no working-tree changes: genuinely clean (nothing to snapshot).
    assert.deepEqual(await snapshotWorktree({ git, baseSha: '' }), { skipped: 'clean' });

    // The agent lands its FIRST local commit (still unpushed). Even though the working
    // tree now matches HEAD, an empty-base run MUST snapshot it: skipping as "clean"
    // would lose that unpushed commit if the worker dies before the branch push.
    writeFileSync(join(dir, 'first.txt'), 'first commit\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'first');
    const head = sh(dir, 'rev-parse', 'HEAD');
    const snap = await snapshotWorktree({ git, baseSha: '' });
    assert.ok(snap.sha, JSON.stringify(snap));
    assert.equal(snap.head, head);
    // The snapshot carries the committed file, so pushing the WIP ref preserves the
    // unpushed commit's content on the remote (recoverable).
    assert.equal(sh(dir, 'show', `${snap.sha}:first.txt`), 'first commit');
    assert.equal(sh(dir, 'rev-parse', `${snap.sha}^`), head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parentful snapshot on an UNBORN clone: the prior run\'s first local commit + WIP are recovered, not discarded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-unborn-parentful-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const clone = (name) => {
      const dir = join(root, name);
      sh(root, 'clone', '-q', remote, dir);
      return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
    };
    const ref = checkpointRef('43p');
    // Fresh clone of an EMPTY remote (unborn on 'main'). The agent makes its FIRST local
    // commit (never pushed), then leaves uncommitted WIP, and checkpoints. The snapshot
    // is now PARENTFUL (its parent is that first commit).
    const a = clone('a');
    assert.equal(sh(a.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    writeFileSync(join(a.dir, 'first.txt'), 'first commit\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'first');
    const firstSha = sh(a.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(a.dir, 'wip.txt'), 'uncommitted wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: clone('probe').git, ref });
    assert.equal(fetched.parent, firstSha);

    // Next activation re-clones the STILL-empty remote → unborn again. The parentful WIP
    // must be recovered (not discarded as no-head): the branch is born at the first
    // commit and the snapshot's changes return as uncommitted work.
    const b = clone('b');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: b.dir, env: ENV }).status, 1);
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'unborn-parentful');
    assert.equal(restored.commitsRecovered, true);
    // The first local commit is recovered (HEAD is born at it) …
    assert.equal(sh(b.dir, 'rev-parse', 'HEAD'), firstSha);
    assert.equal(readFileSync(join(b.dir, 'first.txt'), 'utf8'), 'first commit\n');
    // … and the WIP returns as an uncommitted change, not a commit.
    assert.equal(readFileSync(join(b.dir, 'wip.txt'), 'utf8'), 'uncommitted wip\n');
    assert.ok(sh(b.dir, 'status', '--porcelain').includes('wip.txt'));

    // A parentful snapshot taken on a DIFFERENT branch is still refused on an unborn
    // clone (branch-identity guard applies): no cross-branch commit recovery.
    const c = clone('c');
    const blocked = await restoreCheckpoint({ git: c.git, checkpoint: fetched, expectedBranch: 'other' });
    assert.equal(blocked.restored, false, JSON.stringify(blocked));
    assert.equal(blocked.branchMismatch, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('ownership: a superseded run\'s late write is PRESERVED, not overwritten by the takeover run', async () => {
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

    // The zombie flushes a NEWER checkpoint (its late abort-flush) AFTER the new run's
    // startup fetch — independent WIP the new run's divergent workspace does not hold.
    writeFileSync(join(z.dir, 'x.txt'), 'z2 (late abort flush)\n');
    const z2 = await takeZ('final');
    assert.ok(z2.sha);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), z2.sha);

    // The new run's push is lease-rejected; re-reading shows the SUPERSEDED run (run-z)
    // owns the ref. It must NOT force-push its older snapshot over the zombie's newer
    // WIP — leave the ref intact and retry (issue: late zombie checkpoints overwritten).
    writeFileSync(join(n.dir, 'x.txt'), 'n1\n');
    const n1 = await takeN('tool');
    assert.ok(n1.rejected, JSON.stringify(n1));
    assert.equal(n1.retryable, true, JSON.stringify(n1));
    assert.ok(!n1.disabled, 'must not disable — retry on a future trigger');
    // The ref still holds the zombie's late-flush snapshot, untouched.
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), z2.sha);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'show', `${ref}:x.txt`), 'z2 (late abort flush)');
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

test('a type change (symlink → regular file) is scanned, not bypassed', async () => {
  const f = fixture();
  try {
    const { dir, git } = f.clone('w');
    sh(dir, 'config', 'core.symlinks', 'true');
    // Track a symlink at HEAD, then replace it with a regular file carrying a
    // secret — `add -A` stages this as a TYPE change (mode 120000 → 100644).
    symlinkSync('a.txt', join(dir, 'link'));
    sh(dir, 'add', 'link');
    sh(dir, 'commit', '-q', '-m', 'add symlink');
    const base = sh(dir, 'rev-parse', 'HEAD');
    rmSync(join(dir, 'link'));
    writeFileSync(join(dir, 'link'), 'TOKEN=s3cr3t-value-123\n');
    writeFileSync(join(dir, 'a.txt'), 'changed\n'); // a benign change so the tree differs

    const snap = await snapshotWorktree({ git, baseSha: base, secretValues: ['s3cr3t-value-123'] });
    assert.ok(snap.sha, JSON.stringify(snap));
    // The type-changed path is scanned and excluded; the secret never enters the ref.
    assert.deepEqual(snap.excluded.map((e) => `${e.path}:${e.why}`), ['link:secret-content']);
    // The tree keeps the original symlink (reverted to HEAD), not the secret file,
    // while the benign change is captured.
    assert.equal(sh(dir, 'ls-tree', snap.sha, 'link').split(/\s+/)[0], '120000');
    assert.ok(!sh(dir, 'show', `${snap.sha}:link`).includes('s3cr3t-value-123'));
    assert.equal(sh(dir, 'show', `${snap.sha}:a.txt`), 'changed');
  } finally { f.cleanup(); }
});

test('a transient push after the server accepted our checkpoint is recovered via current-run takeover', async () => {
  let n = 0;
  let serverSha = 'old';
  let sawTransient = false;
  const git = async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'HEAD') return { status: 0, stdout: 'h\n', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('HEAD^{tree}')) return { status: 0, stdout: 'treeHead\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (args.some((a) => a.includes('^{commit}'))) return { status: 0, stdout: `${serverSha}\n`, stderr: '' };
      return { status: 0, stdout: 'parent\n', stderr: '' };
    }
    if (args[0] === 'write-tree') return { status: 0, stdout: `t${++n}\n`, stderr: '' };
    if (args[0] === 'commit-tree') return { status: 0, stdout: `c${n}\n`, stderr: '' };
    if (args[0] === 'log') return { status: 0, stdout: `msg\n\nNano-Checkpoint-Run: run-a\n`, stderr: '' };
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'push') {
      const lease = (args.find((a) => a.startsWith('--force-with-lease=')) || '').split(':').pop();
      const target = args[args.length - 1].split(':')[0];
      if (lease !== serverSha) return { status: 1, stdout: '', stderr: ' ! [rejected] (stale info)' };
      serverSha = target; // the server accepts and moves the ref
      if (!sawTransient) { sawTransient = true; return { status: 1, stdout: '', stderr: 'fatal: unable to access remote (transient)' }; }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const take = createWorkspaceCheckpoint({ git, ref: 'refs/nano/wip/1', baseSha: 'b', runId: 'run-a', expectSha: 'old', priorRunId: 'r0' });
  // The server accepted our push but returned a transient error → must NOT disable.
  const r1 = await take('tool');
  assert.equal(r1.kind, 'transient', JSON.stringify(r1));
  assert.ok(!r1.disabled, 'a transient push error must not disable checkpointing');
  // Next push sees a lease mismatch; re-reading shows OUR own run owns the ref,
  // so we take over and re-push instead of wrongly disabling.
  const r2 = await take('tool');
  assert.ok(r2.sha && !r2.skipped, JSON.stringify(r2));
});

test('blind start (setup fetch failed) does not permanently disable on an initial lease conflict', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('99');
    // An earlier activation owns the ref (runId 'run-old').
    const old = f.clone('old');
    const base = sh(old.dir, 'rev-parse', 'HEAD');
    writeFileSync(join(old.dir, 'x.txt'), 'old\n');
    assert.ok((await createWorkspaceCheckpoint({ git: old.git, ref, baseSha: base, runId: 'run-old' })('tool')).sha);
    const ownerSha = sh(f.root, '--git-dir', f.remote, 'rev-parse', ref);

    // A new activation whose SETUP fetch threw: it holds no prior identity
    // (expectSha='' / priorRunId='') and never restored. Its first push is
    // lease-rejected because the ref already exists, and the re-read shows a
    // FOREIGN run owns it — but a blind start must NOT permanently disable.
    const blind = f.clone('blind');
    writeFileSync(join(blind.dir, 'x.txt'), 'new\n');
    const take = createWorkspaceCheckpoint({ git: blind.git, ref, baseSha: base, runId: 'run-new', startupFetchFailed: true });
    const r1 = await take('tool');
    assert.equal(r1.kind, 'lease', JSON.stringify(r1));
    assert.equal(r1.rejected, true);
    assert.equal(r1.retryable, true);
    assert.ok(!r1.disabled, 'a blind-start lease conflict must not disable checkpointing');
    // A later trigger retries (still rejected) rather than short-circuiting on a
    // latched `disabled` — and never clobbers the foreign owner's ref.
    writeFileSync(join(blind.dir, 'x.txt'), 'new2\n');
    const r2 = await take('tool');
    assert.ok(!r2.skipped?.startsWith('disabled'), JSON.stringify(r2));
    assert.equal(r2.retryable, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), ownerSha);
  } finally { f.cleanup(); }
});

test('credentialsFromUrl extracts URL userinfo (raw + decoded), ignores credential-less / non-http URLs', () => {
  assert.deepEqual(credentialsFromUrl('https://user:p%40ss@github.com/o/r.git').sort(), ['p%40ss', 'p@ss', 'user'].sort());
  assert.deepEqual(credentialsFromUrl('https://x-access-token:ghp_abc123@github.com/o/r.git').sort(), ['ghp_abc123', 'x-access-token'].sort());
  assert.deepEqual(credentialsFromUrl('https://github.com/o/r.git'), []);
  assert.deepEqual(credentialsFromUrl('git@github.com:o/r.git'), []);
  assert.deepEqual(credentialsFromUrl(''), []);
  assert.deepEqual(credentialsFromUrl(null), []);
});

test('createGitRunner is cancellable: an aborted signal fails ops fast without touching the workspace', async () => {
  const f = fixture();
  try {
    const { dir } = f.clone('c');
    const ac = new AbortController();
    const git = createGitRunner({ cwd: dir, env: ENV, signal: ac.signal });
    assert.equal((await git(['rev-parse', '--verify', 'HEAD'])).status, 0);
    ac.abort();
    // After abort every op fails fast (never status 0) so a bounded background
    // task unwinds instead of running git against a workspace being reaped.
    const r = await git(['rev-parse', '--verify', 'HEAD']);
    assert.notEqual(r.status, 0);
  } finally { f.cleanup(); }
});

test('createGitRunner bounds a hung child: a SIGTERM-ignoring group is escalated to SIGKILL and the runner settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckpt-hang-'));
  try {
    sh(dir, 'init', '-q', dir);
    const git = createGitRunner({ cwd: dir, env: ENV });
    // A `!`-shell git alias that TRAPS (ignores) SIGTERM and sleeps: the sleeping
    // shell inherits git's stdout pipe, so without a process-group SIGKILL
    // escalation `close` never fires and the runner hangs forever past its deadline.
    const started = Date.now();
    const r = await git(['-c', "alias.hang=!trap '' TERM; sleep 30", 'hang'], { timeoutMs: 200, killGraceMs: 200 });
    const elapsed = Date.now() - started;
    assert.match(r.stderr, /\[timed out\]/);
    assert.ok(elapsed < 10_000, `runner must settle promptly after SIGKILL escalation, took ${elapsed}ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('GC stops scheduling engine lookups once the overall-deadline signal fires', async () => {
  const f = fixture();
  try {
    const w = f.clone('w');
    const base = sh(w.dir, 'rev-parse', 'HEAD');
    const put = async (key) => {
      const date = `${Math.floor((Date.now() - 2 * 3_600_000) / 1000)} +0000`;
      const git = createGitRunner({ cwd: w.dir, env: { ...ENV, GIT_COMMITTER_DATE: date } });
      writeFileSync(join(w.dir, 'x.txt'), key);
      const snap = await snapshotWorktree({ git, baseSha: base });
      assert.ok((await pushCheckpoint({ git, ref: checkpointRef(key), sha: snap.sha })).ok);
    };
    for (const k of ['1', '2', '3', '4']) await put(k);
    // A hung/slow engine: the overall GC deadline aborts mid-sweep. The sweep must then
    // stop scheduling further per-ref lookups instead of letting up to maxLookups of
    // them each run their own deadline and blow past the overall budget.
    const ac = new AbortController();
    const looked = [];
    const isTerminal = async (key) => { looked.push(key); ac.abort(); return false; };
    const r = await sweepStaleCheckpoints({ git: w.git, ttlMs: 0, graceMs: 0, isTerminal, signal: ac.signal });
    assert.equal(looked.length, 1, `only one lookup before the abort halts the loop: ${JSON.stringify(looked)}`);
    assert.deepEqual(r.deleted, []);
    // All four refs are still present — none were force-scanned/deleted after the abort.
    const left = sh(f.root, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/nano/wip/').split('\n').sort();
    assert.deepEqual(left, ['refs/nano/wip/1', 'refs/nano/wip/2', 'refs/nano/wip/3', 'refs/nano/wip/4']);
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

test('setupWorkspaceCheckpoints: hasUncommittedChanges / priorNotRestored gate ref discard', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      return { workspaceDir: dir, gitEnv: ENV, committer: {}, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    };
    // No prior ref, clean tree → safe to discard (nothing uncommitted, none unrestored).
    const clean = provision('clean');
    const sc = await setupWorkspaceCheckpoints({ provisioned: clean, job: { jobKey: '1', elementInstanceKey: '900' }, jobType: 't', runId: 'r', logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    assert.equal(await sc.hasUncommittedChanges(), false);
    assert.equal(sc.priorNotRestored, false);
    await sc.close();

    // An uncommitted (restored-but-not-committed) working delta → NOT safe: the ref
    // is the only durable copy, so the discard gate must keep it.
    const dirty = provision('dirty');
    const sd = await setupWorkspaceCheckpoints({ provisioned: dirty, job: { jobKey: '2', elementInstanceKey: '901' }, jobType: 't', runId: 'r', logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dirty.workspaceDir, 'restored.txt'), 'recovered but uncommitted\n');
    assert.equal(await sd.hasUncommittedChanges(), true);
    await sd.close();
  } finally { f.cleanup(); }
});

test('setupWorkspaceCheckpoints: an un-restored (branch-mismatch) prior ref is NOT clobbered by the next run', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const job = { jobKey: '8', elementInstanceKey: '808' };
    const provision = (name, branch) => {
      const { dir } = f.clone(name);
      sh(dir, 'checkout', '-q', '-b', branch);
      return { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: branch };
    };
    // run1 checkpoints while on 'sidebranch'.
    const p1 = provision('run1', 'sidebranch');
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job, jobType: 't', runId: 'run-1', logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'sidebranch wip\n');
    const res = await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(res.sha, JSON.stringify(res));
    await s1.close();
    const priorSha = sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/808');
    assert.equal(priorSha, res.sha);

    // run2 is on a DIFFERENT working branch, so restore refuses (branch-mismatch):
    // priorNotRestored. Its checkpointer must NOT be handed prior ownership, so its
    // push cannot force over the ref — the un-restored snapshot survives intact.
    const p2 = provision('run2', 'nano/agent-work/main-x');
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job, jobType: 't', runId: 'run-2', logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    assert.equal(s2.restored, null);
    assert.equal(s2.priorNotRestored, true);
    writeFileSync(join(p2.workspaceDir, 'new.txt'), 'run2 work\n');
    const r2 = await s2.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(r2.skipped, `run2 must not overwrite the ref: ${JSON.stringify(r2)}`);
    await s2.close();
    // The ref still holds run1's snapshot, untouched.
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/808'), priorSha);
  } finally { f.cleanup(); }
});

test('setupWorkspaceCheckpoints: checkpoint → variable → restore on the next activation → discard', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const job = { jobKey: '7', elementInstanceKey: '99' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      // Real provisioning checks out the working branch; reflect that so the
      // snapshot records it and the next activation's restore branch matches.
      sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
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
  // #264 (review thread 4100... previously-missed): setup does cancellable git work
  // and may start GC + a checkpointer, so it takes the runner's abortSignal and is
  // followed by an abort gate before the relay/harness opens.
  assert.ok(src.slice(setup, setup + 400).includes('abortSignal }'), 'setup receives the runner abortSignal');
  const cancelGate = src.indexOf("checkSetupAbort(abortSignal, { jobType, jobKey: job.jobKey, stage: 'relay-open', logger }))", setup);
  assert.ok(cancelGate > setup, 'an abort gate runs after checkpoint setup, before the relay/harness');
  const note = i('effectiveEnvelope = withCheckpointNote(effectiveEnvelope, checkpointing.restored)');
  assert.ok(cancelGate < note, 'the abort gate precedes wiring the restored note into the envelope');
  const notify = i('checkpointer?.notify(u)');
  const abort = i("await checkpointer.flush('abort'");
  const failed = i("await checkpointer.flush('failed'");
  const stop = i("if (checkpointer && result.ok) { await checkpointer.flush('final');");
  const finalize = src.indexOf('gitResult = finalizeGit({', stop);
  const decide = i('discardCheckpointOnAck = Boolean(checkpointing && result.ok');
  assert.ok(setup < note && note < notify && notify < abort && abort < failed && failed < stop && stop < finalize && finalize < decide);
  // #264 (review thread 4099675063): the final flush is timeout-bounded, so the
  // scheduler must be DRAINED (stop() awaits the in-flight checkpoint chain)
  // before finalizeGit touches the workspace — otherwise finalization can race a
  // late snapshot reading the same HEAD/index.
  assert.ok(src.slice(stop, finalize).includes("flush('final'); await checkpointer.stop();"), 'the checkpointer is drained (stop) after the final flush, before finalizeGit');
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
  const close = src.indexOf('await checkpointing.close()', lastChance);
  assert.ok(close > lastChance, 'the exception/cleanup path closes the checkpointing');
  assert.ok(lastChance > decide && lastChance < close, 'the exception path flushes a failed checkpoint before close()');
  assert.ok(close > decide && close < src.indexOf('rmSync(runDir', close), 'in-flight git work drains before the run dir is reaped');
});
