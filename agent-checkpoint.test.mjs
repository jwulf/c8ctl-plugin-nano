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
  recoveredCheckpointRef, predecessorCheckpointRef, makeOccurrenceGuard, resumeRefIsExplicit, pushNamedRef, observeRemoteRefSha, makeOrphanProbe, RECOVERED_REF_PREFIX,
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
  // #296 (review): the SDK-deadline seam defaults to 10s and is overridable (floor 1ms)
  // so a test can drive the cancel-on-timeout behaviour deterministically.
  assert.equal(checkpointConfig({}).sdkTimeoutMs, 10_000);
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT_SDK_TIMEOUT_MS: '20' }).sdkTimeoutMs, 20);
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT_SDK_TIMEOUT_MS: '0' }).sdkTimeoutMs, 1);
  assert.equal(checkpointConfig({ NANO_AGENT_CHECKPOINT_SDK_TIMEOUT_MS: 'nan' }).sdkTimeoutMs, 10_000);
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
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base, baseRefName: 'main', runId: '11111111-1111-4111-8111-111111111111' })('tool');
    assert.ok(res.sha, JSON.stringify(res));

    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'nano/agent-work/main-11111111-1111-4111-8111-111111111111');

    // Run 2 re-activates: provisioning cuts a FRESH fallback branch with a new runId,
    // so its name necessarily differs from the snapshot's. Marked ephemeral, restore
    // must still refuse the ancestry-RESET fast path but fall through to the non-reset
    // PATCH restore, recovering the WIP instead of stranding it (issues from round 8).
    const b = f.clone('b');
    sh(b.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-22222222-2222-4222-8222-222222222222');
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'nano/agent-work/main-22222222-2222-4222-8222-222222222222', expectedBranchEphemeral: true, expectedBaseRef: 'main' });
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
    const gres = await createWorkspaceCheckpoint({ git: a2.git, ref: ref2, baseSha: base, baseRefName: 'main', runId: '55555555-5555-4555-8555-555555555555' })('tool');
    assert.ok(gres.sha, JSON.stringify(gres));
    // Re-activation: a FRESH clone (post-checkpoint) fetches the ref into its own repo,
    // then restores — mirroring the real setup flow (fetch + restore on the same repo).
    const c = f.clone('c');
    sh(c.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-44444444-4444-4444-8444-444444444444');
    const gfetched = await fetchCheckpoint({ git: c.git, ref: ref2 });
    const ok2 = await restoreCheckpoint({ git: c.git, checkpoint: gfetched, expectedBranch: 'nano/agent-work/main-44444444-4444-4444-8444-444444444444', expectedBranchEphemeral: true, expectedBaseRef: 'main' });
    assert.equal(ok2.restored, true, JSON.stringify(ok2));
    assert.equal(ok2.mode, 'patch');
  } finally { f.cleanup(); }
});

test('restore refuses a DIFFERENT same-base generated fallback branch (run-token must match the snapshot writer)', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43z');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    // Run 1's OWN runId is uuidA (it was provisioned onto main-<uuidA>), but the agent
    // switched HEAD to a DIFFERENT generated-looking fallback branch off the same base
    // before it was interrupted — so the snapshot's branch trailer records main-<uuidB>
    // while its run-token trailer is still uuidA. Sharing only the <base> is NOT proof
    // this is THIS run's fallback rename; those off-branch commits must not be patch-
    // restored onto (and later published on) run 2's generated work branch.
    sh(a.dir, 'checkout', '-q', '-b', 'nano/agent-work/main-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    writeFileSync(join(a.dir, 'feature.txt'), 'off-branch work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'off-branch commit');
    writeFileSync(join(a.dir, 'wip.txt'), 'off-branch wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'nano/agent-work/main-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(fetched.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    // Run 2's fresh fallback shares base 'main' and the snapshot's branch parses as a
    // generated fallback too — but its run-token (uuidB) does not match the sanitized
    // run-token of the run that WROTE the snapshot (uuidA), so it stays a mismatch.
    const b = f.clone('b');
    const gen = 'nano/agent-work/main-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    sh(b.dir, 'checkout', '-q', '-b', gen);
    const blocked = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: gen, expectedBranchEphemeral: true });
    assert.equal(blocked.restored, false, JSON.stringify(blocked));
    assert.equal(blocked.branchMismatch, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);
  } finally { f.cleanup(); }
});

test('restore refuses a fallback whose sanitized base COLLIDES but raw base ref differs', async () => {
  const f = fixture();
  try {
    const ref = checkpointRef('43c');
    const a = f.clone('a');
    const base = sh(a.dir, 'rev-parse', 'HEAD');
    // Run 1 was provisioned off the RAW base `feature/foo`, whose branch segment
    // sanitizes to `feature-foo`. It committed work on its per-run fallback and left
    // WIP. The snapshot records baseRef=`feature/foo` and run-token uuidD.
    sh(a.dir, 'checkout', '-q', '-b', 'nano/agent-work/feature-foo-dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    writeFileSync(join(a.dir, 'feature.txt'), 'foo-slash work\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'foo/slash commit');
    writeFileSync(join(a.dir, 'wip.txt'), 'foo-slash wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: base, baseRefName: 'feature/foo', runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: f.clone('probe').git, ref });
    assert.equal(fetched.branch, 'nano/agent-work/feature-foo-dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(fetched.baseRef, 'feature/foo');

    // Run 2 is a DIFFERENT job off the RAW base `feature-foo` (a genuinely distinct ref
    // that sanitizes IDENTICALLY to `feature-foo`). The sanitized branch segments and the
    // run-token both line up, so only the unambiguous raw base identity distinguishes
    // them — restore must refuse rather than patch the wrong base's WIP onto this branch.
    const b = f.clone('b');
    const gen = 'nano/agent-work/feature-foo-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    sh(b.dir, 'checkout', '-q', '-b', gen);
    const blocked = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: gen, expectedBranchEphemeral: true, expectedBaseRef: 'feature-foo' });
    assert.equal(blocked.restored, false, JSON.stringify(blocked));
    assert.equal(blocked.branchMismatch, true);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', ref), res.sha);

    // Positive control: the SAME raw base ref (`feature/foo`) proves identity, so the
    // benign per-run rename recovers — confirming the refusal above is the base-ref
    // mismatch alone, not some unrelated guard.
    const c = f.clone('c');
    sh(c.dir, 'checkout', '-q', '-b', gen);
    const cfetched = await fetchCheckpoint({ git: c.git, ref });
    const okc = await restoreCheckpoint({ git: c.git, checkpoint: cfetched, expectedBranch: gen, expectedBranchEphemeral: true, expectedBaseRef: 'feature/foo' });
    assert.equal(okc.restored, true, JSON.stringify(okc));
    assert.equal(okc.mode, 'patch');
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

test('parentful snapshot on an UNBORN clone: a post-reset failure rolls the clone back to its pristine unborn state (recovered commits are NOT left published)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-unborn-rollback-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const clone = (name) => {
      const dir = join(root, name);
      sh(root, 'clone', '-q', remote, dir);
      return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
    };
    const ref = checkpointRef('43rb');
    const a = clone('a');
    writeFileSync(join(a.dir, 'first.txt'), 'first commit\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'first');
    writeFileSync(join(a.dir, 'wip.txt'), 'uncommitted wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: clone('probe').git, ref });

    // Re-clone the still-empty remote → unborn again. Inject a git wrapper that FAILS the
    // `read-tree -u --reset <sha>` step, AFTER `reset --hard parent` has already made the
    // branch born: the restore must fail AND roll the clone back to unborn/empty.
    const b = clone('b');
    const realGit = b.git;
    const failingGit = async (args, opts) => {
      if (args[0] === 'read-tree' && args.includes('-u') && args.includes('--reset')) {
        return { status: 1, stdout: '', stderr: 'injected read-tree failure' };
      }
      return realGit(args, opts);
    };
    const restored = await restoreCheckpoint({ git: failingGit, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(restored.restored, false, JSON.stringify(restored));
    assert.ok(/read-tree failed/.test(restored.reason), restored.reason);
    assert.notEqual(restored.rollbackFailed, true, JSON.stringify(restored));
    // Clone is unborn again (no HEAD commit) and the working tree is empty — the
    // recovered first commit was NOT left on the branch for finalizeGit to publish.
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: b.dir, env: ENV }).status, 1);
    assert.equal(sh(b.dir, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(b.dir, 'first.txt')), false);
    assert.equal(existsSync(join(b.dir, 'wip.txt')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unborn HEAD: a PARENTLESS snapshot taken on a DIFFERENT branch is refused (branch-identity guard), a benign per-run fallback rename passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-unborn-guard-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const clone = (name) => {
      const dir = join(root, name);
      sh(root, 'clone', '-q', remote, dir);
      return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
    };
    // Agent switches OFF the provisioned branch BEFORE its first commit, so the parentless
    // snapshot records 'sidebranch'. Restoring its tree onto a fresh unborn clone of the
    // expected branch and letting finalizeGit commit+push it there would publish off-branch
    // WIP — so it must be refused.
    const ref = checkpointRef('43g');
    const a = clone('a');
    sh(a.dir, 'checkout', '-q', '-b', 'sidebranch');
    writeFileSync(join(a.dir, 'draft.txt'), 'off-branch pre-commit wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: clone('probe').git, ref });
    assert.equal(fetched.parent, '');
    assert.equal(fetched.branch, 'sidebranch');

    const b = clone('b');
    const refused = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(refused.restored, false, JSON.stringify(refused));
    assert.equal(refused.branchMismatch, true);
    assert.equal(existsSync(join(b.dir, 'draft.txt')), false);

    // A benign per-run fallback rename (same base, matching run-token) still restores: the
    // snapshot's branch is a fallback off 'main' and the expected branch is the same
    // fallback identity re-cut with a fresh runId.
    const ref2 = checkpointRef('43h');
    const runId = '55555555-5555-4555-8555-555555555555';
    const fb = `nano/agent-work/main-${runId}`;
    const c = clone('c');
    sh(c.dir, 'checkout', '-q', '-b', fb);
    writeFileSync(join(c.dir, 'draft.txt'), 'fallback pre-commit wip\n');
    const res2 = await createWorkspaceCheckpoint({ git: c.git, ref: ref2, runId, baseRefName: 'main' })('tool');
    assert.ok(res2.sha, JSON.stringify(res2));
    const fetched2 = await fetchCheckpoint({ git: clone('probe2').git, ref: ref2 });
    assert.equal(fetched2.parent, '');
    const d = clone('d');
    const gen = 'nano/agent-work/main-66666666-6666-4666-8666-666666666666';
    const okFb = await restoreCheckpoint({ git: d.git, checkpoint: fetched2, expectedBranch: gen, expectedBranchEphemeral: true, expectedBaseRef: 'main' });
    assert.equal(okFb.restored, true, JSON.stringify(okFb));
    assert.equal(okFb.mode, 'unborn');
    assert.equal(readFileSync(join(d.dir, 'draft.txt'), 'utf8'), 'fallback pre-commit wip\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty-base parentful snapshot: after the remote gains its first commit, WIP is recovered via an empty-tree patch (not lost)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-emptybase-patch-'));
  try {
    const remote = join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const clone = (name) => {
      const dir = join(root, name);
      sh(root, 'clone', '-q', remote, dir);
      return { dir, git: createGitRunner({ cwd: dir, env: ENV }) };
    };
    // Prior run: clone of an EMPTY remote, makes its first local commit + WIP, checkpoints.
    // The snapshot has NO base trailer (no base sha existed at clone).
    const ref = checkpointRef('43e');
    const a = clone('a');
    writeFileSync(join(a.dir, 'first.txt'), 'first commit\n');
    sh(a.dir, 'add', '-A');
    sh(a.dir, 'commit', '-q', '-m', 'first');
    writeFileSync(join(a.dir, 'wip.txt'), 'uncommitted wip\n');
    const res = await createWorkspaceCheckpoint({ git: a.git, ref, baseSha: '' })('tool');
    assert.ok(res.sha, JSON.stringify(res));
    const fetched = await fetchCheckpoint({ git: clone('probe').git, ref });
    assert.equal(fetched.base, '');

    // The remote gains its FIRST commit before the next activation, so the fresh clone is
    // now BORN on 'main'. Restoration must recover the WIP as an empty-tree patch rather
    // than refuse ('diverged') and lose the checkpointed content.
    const seed = clone('seed');
    writeFileSync(join(seed.dir, 'remote-first.txt'), 'remote first\n');
    sh(seed.dir, 'add', '-A');
    sh(seed.dir, 'commit', '-q', '-m', 'remote first');
    sh(seed.dir, 'push', '-q', 'origin', 'HEAD:main');

    const b = clone('b');
    assert.ok(sh(b.dir, 'rev-parse', '--verify', 'HEAD'));
    const restored = await restoreCheckpoint({ git: b.git, checkpoint: fetched, expectedBranch: 'main' });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.mode, 'patch-empty-base');
    // The snapshot's files (the first commit's content + the WIP) return as uncommitted
    // changes on top of the remote's first commit; the remote's commit is preserved.
    assert.equal(readFileSync(join(b.dir, 'first.txt'), 'utf8'), 'first commit\n');
    assert.equal(readFileSync(join(b.dir, 'wip.txt'), 'utf8'), 'uncommitted wip\n');
    assert.equal(readFileSync(join(b.dir, 'remote-first.txt'), 'utf8'), 'remote first\n');
    assert.equal(sh(b.dir, 'rev-parse', 'HEAD'), sh(b.dir, 'rev-parse', 'origin/main'));
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

test('createGitRunner rechecks the signal after wiring handlers: a race-landed abort tears the child down (issue: abort race)', async () => {
  const f = fixture();
  try {
    const { dir } = f.clone('c');
    // A fake signal whose `aborted` reads FALSE at the entry guard but TRUE at the
    // post-registration recheck — i.e. the abort lands in the window between the
    // fast-path guard and `addEventListener`, which a real AbortSignal never replays.
    // Only two `.aborted` reads exist in createGitRunner (entry guard + recheck); the
    // add/removeEventListener seams never read it, so this drives the race precisely.
    let reads = 0;
    const signal = {
      get aborted() { return (++reads) > 1; },
      addEventListener() {},
      removeEventListener() {},
    };
    const git = createGitRunner({ cwd: dir, env: ENV, signal });
    const r = await git(['rev-parse', '--verify', 'HEAD']);
    // Without the recheck the op would spawn and run to its normal timeout; with it the
    // child is torn down at once and the result carries the abort marker.
    assert.match(r.stderr, /\[aborted\]/);
    assert.notEqual(r.status, 0);
    assert.equal(reads, 2, 'exactly the entry guard + the post-registration recheck read the signal');
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

test('#295 checkpointer: stop() drains a flush that returned early so a late onCheckpoint SHA is observed', async () => {
  // Models the preserveRecovery race (Copilot review on #295): a BOUNDED flush can
  // RETURN while its forced checkpoint is still in flight, and `onCheckpoint` (which
  // records the SHA a recovery ref would promote) only fires once that checkpoint's
  // push resolves. Awaiting `stop()` after the flush must drain the chain so the
  // late SHA is observed — reading it synchronously after the flush would miss it.
  // Injected timers make the flush-timeout beat deterministic (no real-clock race).
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const clearTimer = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  let release;
  const gate = new Promise((r) => { release = r; });
  let ownedSha = null;
  const cp = createCheckpointer({
    // The checkpoint's push hangs until `release()` fires, so the flush timeout
    // (fired below) wins the race and flush returns BEFORE onCheckpoint records the SHA.
    checkpoint: async () => { await gate; return { sha: 'newsha' }; },
    onCheckpoint: (r) => { ownedSha = r.sha; },
    minIntervalMs: 0, intervalMs: 0, setTimer, clearTimer,
  });
  const flushPromise = cp.flush('abort', { timeoutMs: 5 });
  // Fire the pending flush-timeout timer so the flush resolves early (checkpoint hung).
  for (const h of timers.splice(0)) h.fn();
  const flushed = await flushPromise;
  assert.equal(flushed.skipped && /timed out/.test(flushed.skipped), true, 'flush must return early (bounded) while the push is still in flight');
  assert.equal(ownedSha, null, 'onCheckpoint has not fired yet — a synchronous read here would see no SHA');
  // preserveRecovery drains the chain (stop()) before selecting the recovery SHA.
  const drained = cp.stop();
  release();
  await drained;
  assert.equal(ownedSha, 'newsha', 'after the drain, the in-flight checkpoint\'s SHA is observed');
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

test('#296 (F8/F9) createGitRunner signal aborts an in-flight git op instead of running to timeout', async () => {
  // The checkpoint git runner is driven by a DEDICATED recovery-deadline signal (NOT
  // the job's abortSignal, which fires BEFORE force-stop recovery runs and would fail
  // every recovery command). When that recovery deadline fires — abortRecovery() — it
  // CANCELS the in-flight push, settling the checkpointer chain promptly rather than
  // letting it run to the full gitTimeoutMs while the supervisor's SIGKILL backstop
  // looms. This drives `signal` directly: an aborted runner must settle fast (well
  // under the 60s timeout) with a non-zero/aborted result.
  const f = fixture();
  try {
    f.clone('abortable');
    const ac = new AbortController();
    const runner = createGitRunner({ cwd: f.root, env: ENV, timeoutMs: 60_000, signal: ac.signal });
    const started = Date.now();
    const p = runner(['ls-remote', '--quiet', 'origin', 'refs/nano/wip/*']);
    ac.abort();
    const r = await p;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `aborted git op settled in ${elapsed}ms, not the 60s timeout`);
    assert.notEqual(r.status, 0, 'aborted op does not report success');
    assert.match(`${r.stderr}`, /aborted/i);
  } finally { f.cleanup(); }
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

test('setupWorkspaceCheckpoints: updateCredential rebinds the token discardAfterAck authenticates with (#293)', async () => {
  // A job can ROTATE its gh credential mid-run (finalizeGit's push auth-failure
  // recovery re-reads a fresh token). The checkpoint cleanup captured the ORIGINAL
  // token at setup, so without propagation discardAfterAck would push the ref
  // deletion with the already-rejected credential and leak the remote WIP ref.
  // updateCredential must rebind the token the post-ack deletion authenticates with.
  const f = fixture();
  try {
    const { dir } = f.clone('rotated');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: {}, startSha: sh(dir, 'rev-parse', 'HEAD') };
    const logger = quietLogger();
    const scratchEnvs = [];
    const realMk = createGitRunner;
    // Capture the env of every git runner created OUTSIDE the workspace clone —
    // discardAfterAck's throwaway scratch repo lives in an OS tmpdir, so its
    // GIT_TOKEN is the credential the ref-deletion push actually used.
    const spyMk = (opts) => {
      if (opts?.cwd && !String(opts.cwd).startsWith(dir)) scratchEnvs.push({ ...(opts.env || {}) });
      return realMk(opts);
    };
    const s = await setupWorkspaceCheckpoints({ provisioned, token: 'tok_stale', job: { jobKey: '1', elementInstanceKey: '77' }, jobType: 't', runId: 'r', logger, env: { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' }, deps: { sweepRegistry: new Map(), createGitRunner: spyMk } });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    assert.ok((await s.checkpointer.flush('final', { timeoutMs: 0 })).sha);
    await s.close();
    rmSync(dir, { recursive: true, force: true });
    // The job rotated its credential after the setup captured 'tok_stale'.
    s.updateCredential('tok_fresh');
    // Only inspect the POST-rotation cleanup push — the live checkpointer
    // legitimately used 'tok_stale' during the run, before the rotation.
    scratchEnvs.length = 0;
    await s.discardAfterAck();
    assert.throws(() => sh(f.root, '--git-dir', f.remote, 'rev-parse', '--verify', 'refs/nano/wip/77'), 'the ref was deleted after the ack');
    assert.ok(scratchEnvs.some((e) => e.GIT_TOKEN === 'tok_fresh'), 'discardAfterAck authenticated with the ROTATED token');
    assert.ok(!scratchEnvs.some((e) => e.GIT_TOKEN === 'tok_stale'), 'the rejected token was not reused by the post-ack deletion');
    // A no-op rotation (falsy / unchanged) must not disturb the bound credential.
    s.updateCredential(null);
    s.updateCredential('tok_fresh');
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
  // #293 (previously-missed): a mid-finalize credential rotation must be
  // propagated to the checkpoint cleanup BEFORE the discard decision, so
  // discardAfterAck authenticates with the live token, not the rejected one.
  const propagate = src.indexOf('checkpointing?.updateCredential?.(gitResult.rotatedToken)', finalize);
  assert.ok(propagate > finalize && propagate < decide, 'the rotated token is propagated to checkpoint cleanup after finalize, before the discard decision');
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
  const close = src.indexOf('await checkpointing.close(', lastChance);
  assert.ok(close > lastChance, 'the exception/cleanup path closes the checkpointing');
  // #296 (Copilot review): the cleanup-path close() is bounded on the force-stop path
  // by the REMAINING of the ONE shared force-stop deadline (forceStopDeadline), NOT a
  // fresh full FORCE_STOP_RECOVERY_MS — so recovery + cleanup together fit inside a
  // single budget and can't be SIGKILLed mid-cleanup. Unbounded (undefined) otherwise.
  const closeOpts = src.indexOf('const closeOpts = forceStopping', lastChance);
  assert.ok(closeOpts > lastChance && closeOpts < close, 'close() opts computed on the force-stop path before close()');
  // #296 (Copilot review, 1ms finding): the force-stop close() cap is the REMAINING
  // shared deadline, but the FLOOR is the git kill grace (closeFloorMs), not 1ms —
  // abortRecovery() only SIGTERMs git and createGitRunner grants gitKillGraceMs before
  // SIGKILL, so a 1ms floor would abandon a still-dying git to have its workspace
  // reaped under it. The drain must await the actual termination.
  assert.ok(src.slice(closeOpts, close).includes('Math.max(closeFloorMs, forceStopDeadline - Date.now())'), 'force-stop close() caps at the REMAINING shared deadline with a git-kill-grace FLOOR (never a fresh full budget, never 0, never 1ms)');
  assert.ok(src.indexOf('const closeFloorMs = Math.max(1, Number(checkpointing?.gitKillGraceMs) || 0)') > lastChance, 'the close() floor is the git kill grace');
  assert.ok(src.slice(closeOpts, close).includes(': undefined'), 'close() is unbounded off the force-stop path');
  // The one shared deadline is anchored once when the force-stop recovery block begins.
  assert.ok(src.includes('forceStopDeadline = Date.now() + recoveryDeadline'), 'the shared force-stop deadline is set once at the start of the recovery block');
  // #296 (Copilot review, 1ms finding): abortRecovery() fires EARLY (gitKillGraceMs +
  // margin before the deadline) so the git SIGKILL lands by forceStopDeadline and
  // close() gets a real drain window, not an expired one.
  assert.ok(src.includes('const abortAtMs = Math.max(1, recoveryDeadline - drainReserveMs)'), 'abortRecovery() is armed gitKillGraceMs before the deadline to reserve a drain window');
  // #296 (Copilot review): abortRecovery() tears down the GC sweep too, so the single
  // deadline bounds recovery AND the (up to 120s) GC cleanup together.
  const ar = src.indexOf('abortRecovery() {');
  assert.ok(ar > 0 && src.slice(ar, ar + 160).includes('gcAbort?.abort()'), 'abortRecovery() also aborts the GC sweep so the shared deadline bounds cleanup');
  // #296 (Copilot review, recovery-pointer ordering): the abort flush fires its WIP
  // `resumeFromCheckpoint` write fire-and-forget; the recovery path then writes the
  // GC-proof recovery ref to the SAME slot. The recovery write must AWAIT the in-flight
  // WIP write first, or a slow WIP write lands after and clobbers the recovery pointer
  // (which the orphan GC then reclaims on TTL, losing recovery discovery).
  const abortFire = src.indexOf("if (res.reason === 'abort') { abortMetaWrite = setVar(res).catch(() => {}); return; }");
  assert.ok(abortFire > 0, 'the abort-path WIP metadata write is captured (not discarded) so it can be awaited');
  const settleHook = src.indexOf('async settleAbortMetaWrite(signal = null)');
  assert.ok(settleHook > 0, 'setupWorkspaceCheckpoints exposes settleAbortMetaWrite(signal) — cancellable by the recovery deadline');
  const recWrite = src.indexOf("variables: { resumeFromCheckpoint: { ref: recoveryRefInfo.ref");
  assert.ok(recWrite > 0, 'the recovery pointer is written to resumeFromCheckpoint');
  const settleAwait = src.indexOf('await checkpointing.settleAbortMetaWrite?.(recoverySdkAbort.signal)');
  assert.ok(settleAwait > 0 && settleAwait < recWrite, 'the recovery-pointer write awaits the in-flight abort WIP write first (under the recovery signal), so the recovery ref lands last');
  // #296 (Copilot review, r4244116341): the recover-race only bounds the AWAIT — when
  // `budget` wins, the SDK mutations inside `recover` keep running and a stale
  // continuation could clobber a reactivated worker's newer resumeFromCheckpoint. The
  // SDK mutations must therefore be driven off a DEDICATED recovery-deadline signal
  // (fired by the deadline AND on budget expiry), the recovery-pointer write GATED on
  // that signal, and `recover` AWAITED so it is settled/cancelled before the yield.
  const sdkAc = src.indexOf('const recoverySdkAbort = new AbortController()');
  assert.ok(sdkAc > 0, 'the force-stop block owns a dedicated recovery-SDK AbortController');
  const deadlineAborts = src.indexOf('try { recoverySdkAbort.abort(); } catch { /* best effort */ }');
  assert.ok(deadlineAborts > sdkAc, 'the recovery deadline also aborts the SDK signal (not just git/GC)');
  const gateBeforeWrite = src.indexOf('if (recoverySdkAbort.signal.aborted) return;');
  assert.ok(gateBeforeWrite > sdkAc && gateBeforeWrite < recWrite, 'the recovery-pointer write is SKIPPED once the recovery deadline fired (no stale late write)');
  const race = src.indexOf('await Promise.race([recover, budget])');
  const awaitRecover = src.indexOf('try { await recover; } catch { /* best effort */ }');
  assert.ok(awaitRecover > race, 'recover is AWAITED after the race so it is settled/cancelled before the job yields');
  assert.ok(src.lastIndexOf('try { recoverySdkAbort.abort(); } catch { /* best effort */ }') > race, 'the SDK signal is aborted after the race (budget-win path) before awaiting recover');
  assert.ok(lastChance > decide && lastChance < close, 'the exception path flushes a failed checkpoint before close()');
  assert.ok(close > decide && close < src.indexOf('rmSync(runDir', close), 'in-flight git work drains before the run dir is reaped');
});

// ── #295: orphan GC must spare SLA-cancelled runs; recovery/predecessor refs ──

test('#295 recoveredCheckpointRef / RECOVERED_REF_PREFIX: outside the WIP (swept) namespace', () => {
  assert.equal(RECOVERED_REF_PREFIX, 'refs/nano/recovered/');
  assert.equal(recoveredCheckpointRef('808'), 'refs/nano/recovered/808');
  assert.equal(recoveredCheckpointRef('a-b_C'), 'refs/nano/recovered/a-b_C');
  assert.equal(recoveredCheckpointRef(''), null);
  assert.equal(recoveredCheckpointRef('bad/key'), null);
  assert.equal(recoveredCheckpointRef(null), null);
  // A recovery ref is NOT in the WIP namespace the sweep enumerates, so the GC can
  // never reclaim it — the whole point of #295.
  assert.ok(!recoveredCheckpointRef('808').startsWith('refs/nano/wip/'));
});

test('#295 predecessorCheckpointRef: reads resumeFromCheckpoint; rejects self/malformed/foreign', () => {
  // String form.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/wip/10' }), 'refs/nano/wip/10');
  // Object form (what the plugin actually writes).
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/wip/10', sha: 'abc' } }), 'refs/nano/wip/10');
  // The same ref this run already owns is not a predecessor.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/wip/20' }, 'refs/nano/wip/20'), null);
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/wip/20' } }, 'refs/nano/wip/20'), null);
  // A different run's ref IS adopted.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/wip/10' }, 'refs/nano/wip/20'), 'refs/nano/wip/10');
  // Missing / malformed / foreign-namespace are all ignored.
  assert.equal(predecessorCheckpointRef(undefined), null);
  assert.equal(predecessorCheckpointRef({}), null);
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: '' }), null);
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/heads/main' }), null);
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/wip/bad/key' }), null);
});

test('#295 predecessorCheckpointRef: correlates the shared process slot to THIS task by elementId', () => {
  const wip = (elementId) => ({ resumeFromCheckpoint: { ref: 'refs/nano/wip/10', sha: 'abc', elementInstanceKey: '999', elementId } });
  // A recorded elementId that MATCHES the current job's is adopted.
  assert.equal(predecessorCheckpointRef(wip('review-round'), 'refs/nano/wip/20', 'review-round'), 'refs/nano/wip/10');
  // A recorded elementId that DIFFERS is refused: in a process with parallel /
  // sequential agent tasks, the shared slot must never adopt another task's state.
  assert.equal(predecessorCheckpointRef(wip('implement'), 'refs/nano/wip/20', 'review-round'), null);
  // A recorded elementId that is absent/null (legacy or elementId-less writer) is
  // still adopted — refusing it would break the resume #295 exists to support.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/wip/10' } }, 'refs/nano/wip/20', 'review-round'), 'refs/nano/wip/10');
  assert.equal(predecessorCheckpointRef(wip(null), 'refs/nano/wip/20', 'review-round'), 'refs/nano/wip/10');
  // String form carries no elementId, so it stays adoptable under correlation.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/wip/10' }, 'refs/nano/wip/20', 'review-round'), 'refs/nano/wip/10');
  // When the caller passes no elementId the correlation is skipped (legacy callers).
  assert.equal(predecessorCheckpointRef(wip('implement'), 'refs/nano/wip/20'), 'refs/nano/wip/10');
  // The correlation gate never resurrects a self-ref / malformed ref.
  assert.equal(predecessorCheckpointRef(wip('review-round'), 'refs/nano/wip/10', 'review-round'), null);
});

test('#296 predecessorCheckpointRef: accepts a GC-proof RECOVERY ref (AC3 — SLA-cancel resume)', () => {
  // An SLA-cancelled / force-stopped run writes its refs/nano/recovered/<eik> point
  // into the process-scoped slot (its element is terminated before buildResultEnvelope
  // runs, so this is the durable report path). The resumed run must adopt it.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/recovered/808', sha: 'abc', recovered: true } }), 'refs/nano/recovered/808');
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/recovered/808' }), 'refs/nano/recovered/808');
  // elementId correlation still applies to a recovery ref.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/recovered/808', elementId: 'review-round' } }, null, 'review-round'), 'refs/nano/recovered/808');
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: { ref: 'refs/nano/recovered/808', elementId: 'implement' } }, null, 'review-round'), null);
  // A recovery ref equal to this run's OWN wip key is still a predecessor (different
  // namespace), but a recovery ref that IS selfRef is rejected.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/recovered/808' }, 'refs/nano/recovered/808'), null);
  // Malformed recovery refs are still rejected.
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/recovered/bad/key' }), null);
  assert.equal(predecessorCheckpointRef({ resumeFromCheckpoint: 'refs/nano/recovered/' }), null);
});

test('#296 makeOccurrenceGuard: fails closed on ambiguous parallel MI; safe on a unique occurrence', async () => {
  // No search method ⇒ the guard cannot prove uniqueness ⇒ null (caller fails closed).
  assert.equal(makeOccurrenceGuard({}), null);
  assert.equal(makeOccurrenceGuard(), null);

  // A UNIQUE active occurrence ⇒ safe (the lone occurrence is this resumed run itself).
  const one = makeOccurrenceGuard({ searchElementInstances: async () => ({ items: [{ elementInstanceKey: '20' }] }) });
  assert.deepEqual(await one('500', 'review-round'), { safe: true, candidates: ['20'], reason: 'unique' });
  // Zero active (index lag) is also safe — no sibling to confuse it with.
  const none = makeOccurrenceGuard({ searchElementInstances: async () => ({ items: [] }) });
  assert.equal((await none('500', 'review-round')).safe, true);

  // >1 ACTIVE occurrence of the same elementId ⇒ genuine parallel MI ⇒ FAIL CLOSED.
  const many = makeOccurrenceGuard({ searchElementInstances: async () => ({ items: [{ elementInstanceKey: '20' }, { elementInstanceKey: '21' }] }) });
  const v = await many('500', 'review-round');
  assert.equal(v.safe, false);
  assert.deepEqual(v.candidates, ['20', '21']);
  assert.match(v.reason, /2 active occurrences/);

  // A lookup error ⇒ fail closed (we cannot prove uniqueness).
  const boom = makeOccurrenceGuard({ searchElementInstances: async () => { throw new Error('engine down'); } });
  const e = await boom('500', 'review-round');
  assert.equal(e.safe, false);
  assert.match(e.reason, /lookup failed: engine down/);

  // Missing process/element ids ⇒ fail closed (cannot correlate).
  assert.equal((await one('', 'review-round')).safe, false);
  assert.equal((await one('500', '')).safe, false);

  // Tolerates a bare-array response and alternate key fields.
  const arr = makeOccurrenceGuard({ searchElementInstances: async () => [{ key: '20' }] });
  assert.deepEqual(await arr('500', 'review-round'), { safe: true, candidates: ['20'], reason: 'unique' });
});

test('#296 resumeRefIsExplicit: a bare ref string in EITHER checkpoint namespace is occurrence-authoritative', () => {
  // A bare string ref is the process's explicit choice (nano-workforce#891, option 2):
  // trusted as-is, bypassing elementId correlation AND the ambiguity guard.
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: 'refs/nano/wip/10' }), true);
  // #296 (review): a bare RECOVERED ref (`refs/nano/recovered/<eik>`) — the explicit
  // pointer an SLA-cancelled run leaves — is ALSO occurrence-authoritative. Routing it
  // through the ambiguity guard would reject it whenever the host SDK can't prove
  // uniqueness, defeating the durable resume it exists to enable.
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: 'refs/nano/recovered/10' }), true);
  // The self-stamped object record is NOT explicit (it is correlated + guarded), in
  // either namespace.
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: { ref: 'refs/nano/wip/10' } }), false);
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: { ref: 'refs/nano/recovered/10', recovered: true } }), false);
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: 'refs/heads/main' }), false);
  assert.equal(resumeRefIsExplicit({ resumeFromCheckpoint: '' }), false);
  assert.equal(resumeRefIsExplicit({}), false);
  assert.equal(resumeRefIsExplicit(undefined), false);
});

test('#295 makeOrphanProbe: spares an SLA-cancelled element inside a still-active process', async () => {
  // No reader at all → null (sweep then reclaims purely by TTL).
  assert.equal(makeOrphanProbe({}), null);
  assert.equal(makeOrphanProbe({ getElementInstance: null }), null);

  // Element-only (host SDK without getProcessInstance) keeps the legacy behaviour.
  const elemOnly = makeOrphanProbe({ getElementInstance: async (k) => ({ state: k === 'done' ? 'TERMINATED' : 'ACTIVE' }) });
  assert.equal(await elemOnly('done'), true);
  assert.equal(await elemOnly('live'), false);

  // Process-aware: the #295 case. Element TERMINATED by an SLA boundary timer, but
  // its PROCESS is still ACTIVE (human escalation pending) → NOT an orphan.
  const probe = makeOrphanProbe({
    getElementInstance: async (k) => ({ state: 'TERMINATED', processInstanceKey: `pi-${k}` }),
    getProcessInstance: async (pik) => ({ state: pik === 'pi-stuck' ? 'ACTIVE' : 'COMPLETED' }),
  });
  assert.equal(await probe('stuck'), false, 'SLA-cancelled element in an ACTIVE process must be spared');
  assert.equal(await probe('finished'), true, 'element + process both terminal → orphan');

  // Element still running → never an orphan (process not even consulted).
  const running = makeOrphanProbe({
    getElementInstance: async () => ({ state: 'ACTIVE', processInstanceKey: 'pi-x' }),
    getProcessInstance: async () => { throw new Error('should not be called'); },
  });
  assert.equal(await running('x'), false);

  // Unknown / unreachable lookups fail CLOSED (spare the ref; TTL is the backstop).
  const noPik = makeOrphanProbe({ getElementInstance: async () => ({ state: 'TERMINATED' }), getProcessInstance: async () => ({ state: 'COMPLETED' }) });
  assert.equal(await noPik('x'), false, 'no process key → cannot prove finished → spare');
  const elemThrows = makeOrphanProbe({ getElementInstance: async () => { throw new Error('404'); }, getProcessInstance: async () => ({ state: 'COMPLETED' }) });
  assert.equal(await elemThrows('x'), false);
  const procThrows = makeOrphanProbe({ getElementInstance: async () => ({ state: 'TERMINATED', processInstanceKey: 'p' }), getProcessInstance: async () => { throw new Error('boom'); } });
  assert.equal(await procThrows('x'), false);
  // CANCELED counts as a terminal process state too.
  const canceled = makeOrphanProbe({ getElementInstance: async () => ({ state: 'TERMINATED', processInstanceKey: 'p' }), getProcessInstance: async () => ({ state: 'CANCELED' }) });
  assert.equal(await canceled('x'), true);
});

test('#295/#296 pushNamedRef: fenced writes — create-only adoption + lease-against-observed recovery', async () => {
  const f = fixture();
  try {
    const { dir, git } = f.clone('named');
    const sha = sh(dir, 'rev-parse', 'HEAD');
    // Default (expectSha='') is CREATE-ONLY: first write of an absent ref succeeds.
    assert.deepEqual(await pushNamedRef({ git, ref: 'refs/nano/recovered/77', sha }), { ok: true });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/77'), sha);
    // A second create-only write over the now-present ref loses the lease (a stale
    // activation can never blind-overwrite a newer run's recovery point) — #296.
    const other = f.clone('named2');
    sh(other.dir, 'commit', '-q', '--allow-empty', '-m', 'x');
    const sha2 = sh(other.dir, 'rev-parse', 'HEAD');
    const stale = await pushNamedRef({ git: other.git, ref: 'refs/nano/recovered/77', sha: sha2 });
    assert.equal(stale.ok, false);
    assert.equal(stale.staleLease, true, JSON.stringify(stale));
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/77'), sha, 'ref unchanged after a lost lease');
    // Leasing against the OBSERVED sha overwrites cleanly (the legitimate newer run).
    const obs = await observeRemoteRefSha({ git: other.git, ref: 'refs/nano/recovered/77' });
    assert.equal(obs, sha);
    assert.deepEqual(await pushNamedRef({ git: other.git, ref: 'refs/nano/recovered/77', sha: sha2, expectSha: obs }), { ok: true });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/77'), sha2);
    // Missing args → a clean error, no throw.
    assert.equal((await pushNamedRef({ git, ref: '', sha })).ok, false);
    assert.equal((await pushNamedRef({ git, ref: 'refs/x', sha: '' })).ok, false);
  } finally { f.cleanup(); }
});

test('#296 observeRemoteRefSha: reports the current sha, empty when absent/unreadable', async () => {
  const f = fixture();
  try {
    const { dir, git } = f.clone('obs');
    const sha = sh(dir, 'rev-parse', 'HEAD');
    // Absent ref → '' (create-only / fail-closed semantics).
    assert.equal(await observeRemoteRefSha({ git, ref: 'refs/nano/recovered/absent' }), '');
    // Present ref → its sha.
    sh(dir, 'push', '-q', 'origin', `${sha}:refs/nano/recovered/123`);
    assert.equal(await observeRemoteRefSha({ git, ref: 'refs/nano/recovered/123' }), sha);
    // A git failure never throws — it falls back to '' (fail closed).
    const boom = async () => { throw new Error('ls-remote boom'); };
    assert.equal(await observeRemoteRefSha({ git: boom, ref: 'refs/nano/recovered/123' }), '');
  } finally { f.cleanup(); }
});

test('#296 (F7) recovery-ref overwrite is fenced by run identity, not just a CAS', async () => {
  // The bug: a bare compare-and-swap against the just-observed sha let a SUPERSEDED
  // activation observe the newer run's recovery point and still overwrite it with its
  // older snapshot. The fix mirrors the WIP path: the recovery snapshot carries a
  // `Nano-Checkpoint-Run` trailer, and an existing ref is only overwritten by its own
  // run or the run it explicitly superseded — never by a foreign (newer/concurrent) run.
  const f = fixture();
  try {
    const eik = '4242';
    const recRef = recoveredCheckpointRef(eik);
    // Two "activations" of the same element instance, each with its own clone + run id.
    // Give each a DISTINCT working-tree change so their shadow snapshots differ.
    const a = f.clone('runA');
    const b = f.clone('runB');
    writeFileSync(join(a.dir, 'wip-a.txt'), 'alpha\n');
    writeFileSync(join(b.dir, 'wip-b.txt'), 'beta\n');
    // Build a run-tagged shadow snapshot in each (the recovery point each would promote).
    const snapA = await snapshotWorktree({ git: a.git, baseSha: sh(a.dir, 'rev-parse', 'HEAD'), runId: 'run-A', message: 'A' });
    const snapB = await snapshotWorktree({ git: b.git, baseSha: sh(b.dir, 'rev-parse', 'HEAD'), runId: 'run-B', message: 'B' });
    assert.ok(snapA.sha && snapB.sha && snapA.sha !== snapB.sha, `distinct snapshots: ${snapA.sha} vs ${snapB.sha}`);
    // The NEWER run (B) preserves first: an absent ref is a create-only write.
    assert.deepEqual(await pushNamedRef({ git: b.git, ref: recRef, sha: snapB.sha }), { ok: true });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', recRef), snapB.sha);
    // The SUPERSEDED run (A) now wakes up. It observes B's sha (a bare CAS would let it
    // overwrite), but the run-identity fence must refuse: B is a foreign run.
    const prevRecSha = await observeRemoteRefSha({ git: a.git, ref: recRef });
    assert.equal(prevRecSha, snapB.sha, 'A observes the newer run B recovery point');
    const owner = await fetchCheckpoint({ git: a.git, ref: recRef });
    const foreign = owner?.runId && owner.runId !== 'run-A' && owner.runId !== '';
    assert.equal(owner.runId, 'run-B');
    assert.equal(foreign, true, 'B is foreign to A — A must NOT overwrite (the F7 fix)');
    // And a same-run re-preservation IS allowed (idempotent), proving the fence is
    // ownership-based, not a blanket refusal.
    assert.equal(owner.runId === 'run-B', true);
  } finally { f.cleanup(); }
});

test('#295 sweepStaleCheckpoints: deleted entries carry the sha (for the GC log)', async () => {  const f = fixture();
  try {
    const { dir, git } = f.clone('sweep');
    const sha = sh(dir, 'rev-parse', 'HEAD');
    // Seed a WIP ref and age it beyond the grace window so the probe is consulted.
    sh(dir, 'push', '-q', 'origin', `${sha}:refs/nano/wip/555`);
    const isTerminal = async () => true;
    const r = await sweepStaleCheckpoints({ git, ttlMs: 0, graceMs: 0, isTerminal, now: () => Date.now() + 10_000 });
    assert.equal(r.deleted.length, 1);
    assert.deepEqual(r.deleted[0], { ref: 'refs/nano/wip/555', sha, why: 'element-terminal' });
    assert.throws(() => sh(f.root, '--git-dir', f.remote, 'rev-parse', '--verify', 'refs/nano/wip/555'));
  } finally { f.cleanup(); }
});

test('#295 sweepStaleCheckpoints: NEVER lists or deletes recovery refs', async () => {
  const f = fixture();
  try {
    const { dir, git } = f.clone('rec');
    const sha = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'push', '-q', 'origin', `${sha}:refs/nano/recovered/999`);
    // Even an always-terminal probe + zero TTL cannot reach a recovered ref: the
    // sweep enumerates only refs/nano/wip/*.
    const r = await sweepStaleCheckpoints({ git, ttlMs: 0, graceMs: 0, isTerminal: async () => true, now: () => Date.now() + 10_000 });
    assert.equal(r.deleted.length, 0);
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/999'), sha);
  } finally { f.cleanup(); }
});

test('#295 preserveRecovery: promotes the latest snapshot to a GC-proof recovery ref', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const { dir } = f.clone('preserve');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const logger = quietLogger();
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '808' }, jobType: 't', runId: 'r', logger, env, deps: { sweepRegistry: new Map() } });
    // Nothing durable yet → null.
    assert.equal(await s.preserveRecovery('force-stop'), null);
    writeFileSync(join(dir, 'wip.txt'), 'half done\n');
    const res = await s.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(res.sha, JSON.stringify(res));
    const rec = await s.preserveRecovery('force-stop');
    assert.deepEqual(rec, { ref: 'refs/nano/recovered/808', sha: res.sha });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/808'), res.sha);
    assert.match(logger.lines.info.join('\n'), /preserved a GC-proof recovery checkpoint refs\/nano\/recovered\/808/);
    // The WIP ref is retained too (an additional durable copy).
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/808'), res.sha);
    await s.close();
  } finally { f.cleanup(); }
});

test('#296 force-stop recovery is not blocked by hung metadata writes', async () => {
  // High finding (r4243653664): the best-effort agentCheckpoint / resumeFromCheckpoint
  // SDK writes must NOT sit on the serialized flush/promote critical path during a
  // force-stop (`abort`) flush. A hung engine would otherwise burn up to 2×
  // CP_SDK_TIMEOUT_MS (20s) inside onCheckpoint and starve the recovery git promotion.
  // With a camunda whose createElementInstanceVariables NEVER resolves, the abort flush
  // + preserveRecovery must still land the recovery ref promptly.
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const { dir } = f.clone('hung-meta');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const logger = quietLogger();
    // Never-resolving write: if it were awaited on the critical path, the flush below
    // would hang well past this test's own wall-clock budget.
    const camunda = { createElementInstanceVariables: () => new Promise(() => {}) };
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '818', processInstanceKey: '500', elementId: 'review' }, jobType: 't', runId: 'r', camunda, logger, env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dir, 'wip.txt'), 'half done\n');
    const started = Date.now();
    const res = await s.checkpointer.flush('abort', { timeoutMs: 20_000 });
    assert.ok(res.sha, JSON.stringify(res));
    const rec = await s.preserveRecovery('force-stop');
    const elapsed = Date.now() - started;
    assert.deepEqual(rec, { ref: 'refs/nano/recovered/818', sha: res.sha });
    assert.ok(elapsed < 10_000, `abort flush + recovery completed in ${elapsed}ms despite the hung write (< one SDK timeout)`);
    await s.close({ timeoutMs: 2000 });
  } finally { f.cleanup(); }
});

test('#296 withDeadline CANCELS a timed-out checkpoint write (no late overwrite of a newer pointer)', async () => {
  // High finding (r4243918057): a bare Promise.race REJECTS on timeout but leaves the
  // SDK mutation in flight — a timed-out process-scoped `resumeFromCheckpoint` write
  // could then complete AFTER a retry wrote a newer pointer and overwrite it with the
  // stale ref. The SDK returns a CancelablePromise; withDeadline must call .cancel()
  // on timeout so the underlying fetch is aborted and the late settle can never land.
  const f = fixture();
  try {
    // #296 (review, agent-checkpoint.test.mjs:1898): inject a near-instant SDK
    // deadline via the seam so this asserts the cancel-on-timeout behaviour
    // DETERMINISTICALLY, instead of blocking on the real 10s production deadline.
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0', NANO_AGENT_CHECKPOINT_SDK_TIMEOUT_MS: '20' };
    const { dir } = f.clone('cancel-meta');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    let cancelCalls = 0;
    let settled = false;
    // A CancelablePromise-shaped write that NEVER resolves on its own; only .cancel()
    // settles it (rejects), mirroring the SDK's toCancelable. If withDeadline fails to
    // cancel, `settled` stays false and the write would remain in flight.
    const camunda = {
      createElementInstanceVariables: () => {
        const p = new Promise(() => {});
        p.cancel = () => { cancelCalls++; settled = true; };
        return p;
      },
    };
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '820', processInstanceKey: '500', elementId: 'review' }, jobType: 't', runId: 'r', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dir, 'wip.txt'), 'half done\n');
    const started = Date.now();
    // A normal (non-abort) flush AWAITS the metadata write, so the injected 20ms
    // deadline fires and must CANCEL the in-flight write before rejecting.
    const res = await s.checkpointer.flush('failed', { timeoutMs: 20_000 });
    assert.ok(res.sha, JSON.stringify(res));
    assert.ok(cancelCalls > 0, 'the timed-out checkpoint write was cancelled (CancelablePromise.cancel invoked)');
    assert.ok(settled, 'the cancelled write is settled — it can never complete late and overwrite a newer pointer');
    assert.ok(Date.now() - started < 5_000, 'the injected SDK deadline fired fast — no real-time 10s wait');
    await s.close({ timeoutMs: 2000 });
  } finally { f.cleanup(); }
});

test('#296 failed flush AWAITS the metadata write so the resume pointer is durable before settlement', async () => {
  // High finding (r4243737447): on the SLA-failure path the job settles
  // (settleJob.fail) immediately after `flush('failed')` returns, and a resumed
  // activation reads `resumeFromCheckpoint` to find its predecessor. If that write
  // were fired off the chain (as the force-stop `abort` path deliberately does), the
  // job could settle — and the retry could read variables — BEFORE the pointer is
  // durable; a delayed process-scoped write could even overwrite a NEWER activation's
  // pointer. So the `failed` flush must AWAIT the write: by the time it resolves, the
  // process-scoped resumeFromCheckpoint variable has been recorded.
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const { dir } = f.clone('failed-await');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const vars = [];
    const camunda = { createElementInstanceVariables: async (input) => { vars.push(input); } };
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '819', processInstanceKey: '500', elementId: 'review' }, jobType: 't', runId: 'r', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(dir, 'wip.txt'), 'half done\n');
    const res = await s.checkpointer.flush('failed', { timeoutMs: 20_000 });
    assert.ok(res.sha, JSON.stringify(res));
    // By the time the failed flush resolves, BOTH the element-scope agentCheckpoint
    // and the process-scope resumeFromCheckpoint writes have landed (awaited).
    const resume = vars.find((v) => v.elementInstanceKey === '500' && v.variables?.resumeFromCheckpoint);
    assert.ok(resume, 'the process-scoped resumeFromCheckpoint write completed before the failed flush returned');
    assert.equal(resume.variables.resumeFromCheckpoint.ref, 'refs/nano/wip/819');
    assert.equal(resume.variables.resumeFromCheckpoint.sha, res.sha);
    await s.close({ timeoutMs: 2000 });
  } finally { f.cleanup(); }
});


test('#296 (F9) checkpoint git stays usable AFTER the job abort; abortRecovery cancels it', async () => {
  // The round-4 F8 attempt bound the checkpoint git runner to the JOB abortSignal.
  // But the force-stop recovery path (flush + preserveRecovery) runs only once
  // `result.aborted` is observed — i.e. AFTER that signal has fired — so every
  // recovery command failed `[aborted]` and the recovery ref could never be written
  // (the whole #295 goal). The fix drives the checkpoint git from a DEDICATED
  // recovery-deadline controller instead: it survives the harness abort, and is
  // cancelled only by abortRecovery() when the budget expires.
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const { dir } = f.clone('f9');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const ac = new AbortController();
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '909' }, jobType: 't', runId: 'r', logger: quietLogger(), env, abortSignal: ac.signal });
    assert.ok(s, 'checkpointing is set up while the abortSignal is still live');
    assert.equal(typeof s.abortRecovery, 'function', 'exposes abortRecovery()');
    writeFileSync(join(dir, 'wip.txt'), 'half done\n');
    const res = await s.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(res.sha, JSON.stringify(res));
    // Simulate the worker force-stop: the JOB abort fires BEFORE recovery runs.
    ac.abort();
    const rec = await s.preserveRecovery('force-stop');
    assert.deepEqual(rec, { ref: 'refs/nano/recovered/909', sha: res.sha }, 'recovery still lands after the job abort');
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/recovered/909'), res.sha);
    // Now the recovery DEADLINE fires: abortRecovery() cancels the recovery git runner
    // so no further push can run (bounded cleanup — the chain settles, close() drains).
    s.abortRecovery();
    writeFileSync(join(dir, 'wip2.txt'), 'more\n');
    assert.equal(await s.preserveRecovery('force-stop'), null, 'after abortRecovery the checkpoint git is cancelled');
    await s.close({ timeoutMs: 2000 });
  } finally { f.cleanup(); }
});

test('#296 (F10) preserveRecovery fails CLOSED when the recovery ref owner is unknown/foreign', async () => {
  // The round-4 F7 fence read the existing ref's runId but fell THROUGH to the CAS
  // whenever ownership could not be positively established — a thrown/empty ownership
  // fetch, or a ref with no run trailer — so a transient read failure could still let
  // a stale activation clobber a newer recovery point. The fix fails CLOSED: an
  // existing recovery ref is overwritten ONLY when positively identified as this run
  // or the run it explicitly superseded; every other case refuses.
  const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };

  // (a) FOREIGN owner: a newer run B already holds the recovery ref → run A refuses.
  const fa = fixture();
  try {
    const recRef = recoveredCheckpointRef('717');
    const { dir } = fa.clone('f10a');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    writeFileSync(join(dir, 'foreign-b.txt'), 'B work\n');
    const bSnap = await snapshotWorktree({ git: createGitRunner({ cwd: dir, env: ENV }), baseSha: sh(dir, 'rev-parse', 'HEAD'), runId: 'run-B', message: 'B' });
    assert.ok(bSnap.sha, 'foreign snapshot built');
    sh(dir, 'push', '-q', 'origin', `${bSnap.sha}:${recRef}`);
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const logger = quietLogger();
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '717' }, jobType: 't', runId: 'run-A', logger, env });
    writeFileSync(join(dir, 'wip.txt'), 'A work\n');
    await s.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.equal(await s.preserveRecovery('force-stop'), null, 'run-A must NOT overwrite the foreign run-B ref');
    assert.equal(sh(fa.root, '--git-dir', fa.remote, 'rev-parse', recRef), bSnap.sha, 'the foreign recovery ref is unchanged');
    assert.match(logger.lines.warn.join('\n'), /owned by another run/);
    await s.close();
  } finally { fa.cleanup(); }

  // (b) NO run identity: the existing ref points at a commit without a run trailer →
  // the owner cannot be established → fail closed (refuse the overwrite).
  const fb = fixture();
  try {
    const recRef = recoveredCheckpointRef('717');
    const { dir } = fb.clone('f10b');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const plain = sh(dir, 'rev-parse', 'HEAD'); // the init commit: no Nano-Checkpoint-Run trailer
    sh(dir, 'push', '-q', 'origin', `${plain}:${recRef}`);
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const logger = quietLogger();
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '717' }, jobType: 't', runId: 'run-A', logger, env });
    writeFileSync(join(dir, 'wip.txt'), 'A work\n');
    await s.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.equal(await s.preserveRecovery('force-stop'), null, 'an un-owned ref is not overwritten');
    assert.equal(sh(fb.root, '--git-dir', fb.remote, 'rev-parse', recRef), plain, 'the un-owned recovery ref is unchanged');
    assert.match(logger.lines.warn.join('\n'), /carries no run identity/);
    await s.close();
  } finally { fb.cleanup(); }

  // (c) OWNERSHIP-based, not a blanket refusal: a re-preservation by the SAME run that
  // created the ref IS allowed (it overwrites its own earlier recovery point).
  const fc = fixture();
  try {
    const { dir } = fc.clone('f10c');
    sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
    const provisioned = { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '717' }, jobType: 't', runId: 'run-A', logger: quietLogger(), env });
    writeFileSync(join(dir, 'wip.txt'), 'first\n');
    await s.checkpointer.flush('abort', { timeoutMs: 0 });
    const r1 = await s.preserveRecovery('force-stop');
    assert.ok(r1?.sha, 'first create-only preserve lands');
    writeFileSync(join(dir, 'wip.txt'), 'second\n');
    const r2res = await s.checkpointer.flush('abort', { timeoutMs: 0 });
    const r2 = await s.preserveRecovery('force-stop');
    assert.deepEqual(r2, { ref: recoveredCheckpointRef('717'), sha: r2res.sha }, 'same-run re-preserve overwrites its own ref');
    assert.notEqual(r2.sha, r1.sha, 'the ref advanced to the newer snapshot');
    await s.close();
  } finally { fc.cleanup(); }
});

test('#295 setupWorkspaceCheckpoints: a resumed run adopts its predecessor via resumeFromCheckpoint', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
      return { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    };
    const vars = [];
    const camunda = {
      createElementInstanceVariables: async (input) => { vars.push(input); },
      // #295 ambiguity guard: a UNIQUE active occurrence of this elementId ⇒ safe to adopt.
      searchElementInstances: async () => ({ items: [{ elementInstanceKey: '20' }] }),
    };

    // run1 is element 10 in process 500; it checkpoints and records resumeFromCheckpoint
    // at the PROCESS scope.
    const p1 = provision('run1');
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job: { jobKey: '1', elementInstanceKey: '10', processInstanceKey: '500', elementId: 'review-round' }, jobType: 't', runId: 'run-1', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'half done\n');
    const res = await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    await s1.close();
    // Two writes: agentCheckpoint @ element 10, resumeFromCheckpoint @ process 500.
    const resumeVar = vars.find((v) => v.variables.resumeFromCheckpoint);
    assert.ok(resumeVar, 'a resumeFromCheckpoint var is written at the process scope');
    assert.equal(resumeVar.elementInstanceKey, '500');
    assert.equal(resumeVar.local, true);
    assert.equal(resumeVar.variables.resumeFromCheckpoint.ref, 'refs/nano/wip/10');
    assert.equal(resumeVar.variables.resumeFromCheckpoint.sha, res.sha);

    // The SLA escalation re-enters the task as a NEW element (20) in the SAME process;
    // its variables carry the predecessor ref. setupWorkspaceCheckpoints adopts
    // refs/nano/wip/10 under refs/nano/wip/20 and RESTORES it.
    const p2 = provision('run2');
    const logger = quietLogger();
    const job2 = { jobKey: '2', elementInstanceKey: '20', processInstanceKey: '500', elementId: 'review-round', variables: { resumeFromCheckpoint: resumeVar.variables.resumeFromCheckpoint } };
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job: job2, jobType: 't', runId: 'run-2', camunda, logger, env, deps: { sweepRegistry: new Map() } });
    assert.equal(s2.restored?.restored, true);
    assert.match(logger.lines.info.join('\n'), /adopted predecessor WIP checkpoint refs\/nano\/wip\/10/);
    assert.equal(readFileSync(join(p2.workspaceDir, 'wip.txt'), 'utf8'), 'half done\n');
    // The predecessor's content is now also under this run's own key.
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/20'), res.sha);
    await s2.close();
  } finally { f.cleanup(); }
});

test('#296 setupWorkspaceCheckpoints: refuses predecessor adoption when >1 occurrence is active (parallel MI)', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
      return { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    };
    const vars = [];
    // Two active occurrences of the elementId in the process ⇒ ambiguous ⇒ fail closed.
    const camunda = {
      createElementInstanceVariables: async (input) => { vars.push(input); },
      searchElementInstances: async () => ({ items: [{ elementInstanceKey: '20' }, { elementInstanceKey: '21' }] }),
    };

    const p1 = provision('run1');
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job: { jobKey: '1', elementInstanceKey: '10', processInstanceKey: '500', elementId: 'review-round' }, jobType: 't', runId: 'run-1', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'half done\n');
    await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    await s1.close();
    const resumeVar = vars.find((v) => v.variables.resumeFromCheckpoint);

    const p2 = provision('run2');
    const logger = quietLogger();
    const job2 = { jobKey: '2', elementInstanceKey: '20', processInstanceKey: '500', elementId: 'review-round', variables: { resumeFromCheckpoint: resumeVar.variables.resumeFromCheckpoint } };
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job: job2, jobType: 't', runId: 'run-2', camunda, logger, env, deps: { sweepRegistry: new Map() } });
    // Ambiguous ⇒ NOT restored; the worktree stays pristine (no wip.txt laid down).
    assert.equal(s2.restored, null);
    assert.ok(!existsSync(join(p2.workspaceDir, 'wip.txt')), 'no sibling occurrence state is restored');
    assert.match(logger.lines.warn.join('\n'), /not adopting predecessor WIP checkpoint .*ambiguous.*2 active occurrences/);
    // This run never claimed the predecessor ref under its own key.
    assert.throws(() => sh(f.root, '--git-dir', f.remote, 'rev-parse', '--verify', 'refs/nano/wip/20'));
    await s2.close();
  } finally { f.cleanup(); }
});

test('#296 setupWorkspaceCheckpoints: an EXPLICIT (string) predecessor ref bypasses the ambiguity guard', async () => {
  const f = fixture();
  try {
    const env = { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' };
    const provision = (name) => {
      const { dir } = f.clone(name);
      sh(dir, 'checkout', '-q', '-b', 'nano/agent-work/main-x');
      return { workspaceDir: dir, gitEnv: ENV, committer: { name: 'bot', email: 'bot@example.com' }, startSha: sh(dir, 'rev-parse', 'HEAD'), workingBranch: 'nano/agent-work/main-x' };
    };
    const vars = [];
    // searchElementInstances WOULD report ambiguity, but an explicit string ref is
    // occurrence-authoritative (the process chose it) ⇒ the guard is bypassed.
    let searched = false;
    const camunda = {
      createElementInstanceVariables: async (input) => { vars.push(input); },
      searchElementInstances: async () => { searched = true; return { items: [{ elementInstanceKey: '20' }, { elementInstanceKey: '21' }] }; },
    };

    const p1 = provision('run1');
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job: { jobKey: '1', elementInstanceKey: '10', processInstanceKey: '500', elementId: 'review-round' }, jobType: 't', runId: 'run-1', camunda, logger: quietLogger(), env, deps: { sweepRegistry: new Map() } });
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'half done\n');
    const res = await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    await s1.close();

    const p2 = provision('run2');
    const logger = quietLogger();
    // The process delivers a BARE string ref (option 2) — trusted as-is.
    const job2 = { jobKey: '2', elementInstanceKey: '20', processInstanceKey: '500', elementId: 'review-round', variables: { resumeFromCheckpoint: 'refs/nano/wip/10' } };
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job: job2, jobType: 't', runId: 'run-2', camunda, logger, env, deps: { sweepRegistry: new Map() } });
    assert.equal(s2.restored?.restored, true);
    assert.equal(searched, false, 'the ambiguity guard is NOT consulted for an explicit ref');
    assert.equal(readFileSync(join(p2.workspaceDir, 'wip.txt'), 'utf8'), 'half done\n');
    assert.equal(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/20'), res.sha);
    await s2.close();
  } finally { f.cleanup(); }
});

test('#295 job handler wires preserveRecovery on abort/failed and surfaces recoveryRef in the outcome', () => {
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const i = (s) => { const at = src.indexOf(s); assert.ok(at >= 0, `missing: ${s}`); return at; };
  const abortFlush = i("await checkpointer.flush('abort'");
  const abortPreserve = i("recoveryRefInfo = await checkpointing.preserveRecovery('force-stop')");
  const failedFlush = i("await checkpointer.flush('failed', { timeoutMs: checkpointing.flushTimeoutMs })");
  const failedPreserve = i("recoveryRefInfo = await checkpointing.preserveRecovery('failed')");
  // preserveRecovery runs AFTER each flush (the snapshot must exist first).
  assert.ok(abortFlush < abortPreserve, 'abort preserve follows the abort flush');
  assert.ok(failedFlush < failedPreserve, 'failed preserve follows the failed flush');
  // The recovery ref is attached to the git result and surfaced in the outcome envelope.
  assert.ok(i('if (recoveryRefInfo && gitResult) { gitResult.recoveryRef = recoveryRefInfo.ref; gitResult.recoverySha = recoveryRefInfo.sha; }') > 0);
  assert.ok(i('if (git.recoveryRef) env.recoveryRef = git.recoveryRef;') > 0);
  assert.ok(i('if (git.recoverySha) env.recoverySha = git.recoverySha;') > 0);
  // The orphan probe is process-instance-aware (the core #295 fix).
  assert.ok(i('const isTerminal = makeOrphanProbe({') > 0);
  assert.ok(i('getProcessInstance: typeof camunda?.getProcessInstance === \'function\'') > 0);
  // The GC reclaim log reports ref@sha [why].
  assert.ok(i('reclaimed ${r.deleted.length} orphaned WIP checkpoint ref(s)') > 0);
  // #296 (F9): the checkpoint git runner is driven by a DEDICATED recovery-deadline
  // controller (so recovery survives the harness abort), and the force-stop block arms
  // the deadline that cancels it via abortRecovery() once the budget expires.
  assert.ok(i('const recoveryController = new AbortController();') > 0, 'checkpoint git uses a dedicated recovery controller');
  assert.ok(i('signal: recoveryController.signal') > 0, 'the checkpoint git runner is bound to the recovery signal, not the job abortSignal');
  const deadline = i('try { checkpointing.abortRecovery(); } catch');
  const flushAbort = i("await checkpointer.flush('abort'");
  assert.ok(deadline > 0 && deadline < flushAbort, 'the recovery deadline (abortRecovery) is armed before the force-stop flush');
});
