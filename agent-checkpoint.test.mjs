import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkpointConfig, checkpointRef, isDeniedPath, isCheckpointTrigger, createGitRunner,
  snapshotWorktree, pushCheckpoint, fetchCheckpoint, restoreCheckpoint, deleteCheckpointRef,
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
  assert.equal(checkpointConfig({}).enabled, false);
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
    mkdirSync(join(dir, 'ignored'));
    writeFileSync(join(dir, 'ignored', 'x'), 'x');
    sh(dir, 'add', 'new.txt'); // agent's own staging must survive
    const statusBefore = sh(dir, 'status', '--porcelain');

    const snap = await snapshotWorktree({ git, baseSha: base, maxFileBytes: 1024 });
    assert.ok(snap.sha, JSON.stringify(snap));
    assert.deepEqual(snap.excluded.map((e) => e.path).sort(), ['.env', 'big.bin']);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), base);
    assert.equal(sh(dir, 'status', '--porcelain'), statusBefore);
    const files = sh(dir, 'ls-tree', '-r', '--name-only', snap.sha).split('\n').sort();
    assert.deepEqual(files, ['.gitignore', 'a.txt', 'new.txt']);
    assert.equal(sh(dir, 'show', `${snap.sha}:a.txt`), 'two');
    assert.equal(sh(dir, 'rev-parse', `${snap.sha}^`), base);
    assert.match(sh(dir, 'log', '-1', '--format=%B', snap.sha), new RegExp(`Nano-Checkpoint-Base: ${base}`));

    assert.deepEqual(await snapshotWorktree({ git, baseSha: base, maxFileBytes: 1024, lastTree: { tree: snap.tree, head: snap.head } }), { skipped: 'unchanged' });
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
  assert.equal(final.reason, 'final');
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

test('setupWorkspaceCheckpoints: off by default and without an elementInstanceKey', async () => {
  const provisioned = { workspaceDir: '/nonexistent' };
  assert.equal(await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '2' }, jobType: 't', runId: 'r', logger: quietLogger(), env: {} }), null);
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
    const s1 = await setupWorkspaceCheckpoints({ provisioned: p1, job, jobType: 't', runId: 'run-1', camunda, logger: quietLogger(), env });
    assert.equal(s1.restored, null);
    writeFileSync(join(p1.workspaceDir, 'wip.txt'), 'half done\n');
    const res = await s1.checkpointer.flush('abort', { timeoutMs: 0 });
    assert.ok(res.sha, JSON.stringify(res));
    assert.equal(vars.length, 1);
    assert.equal(vars[0].elementInstanceKey, '99');
    assert.equal(vars[0].local, true);
    assert.deepEqual({ ...vars[0].variables.agentCheckpoint, at: 'x' }, { ref: 'refs/nano/wip/99', sha: res.sha, head: p1.startSha, at: 'x', reason: 'final', branch: 'nano/agent-work/main-x' });
    assert.equal(sh(f.root, '--git-dir', f.remote, 'log', '-1', '--format=%an', 'refs/nano/wip/99'), 'bot');

    const p2 = provision('run2');
    const logger = quietLogger();
    const s2 = await setupWorkspaceCheckpoints({ provisioned: p2, job, jobType: 't', runId: 'run-2', camunda, logger, env });
    assert.equal(s2.restored?.restored, true);
    assert.match(logger.lines.info.join('\n'), /restored WIP checkpoint refs\/nano\/wip\/99/);
    assert.equal(readFileSync(join(p2.workspaceDir, 'wip.txt'), 'utf8'), 'half done\n');
    await s2.discard();
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
    const s = await setupWorkspaceCheckpoints({ provisioned, job: { jobKey: '1', elementInstanceKey: '5' }, jobType: 't', runId: 'r', camunda, logger, env: { NANO_AGENT_CHECKPOINT: 'on', NANO_AGENT_CHECKPOINT_INTERVAL_MS: '0' } });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    assert.ok((await s.checkpointer.flush('failed', { timeoutMs: 0 })).sha);
    assert.equal(logger.lines.warn.filter((l) => /agentCheckpoint variable/.test(l)).length, 1);
    assert.ok(sh(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/nano/wip/5'));
  } finally { f.cleanup(); }
});

test('job handler wires checkpoints: notify on ACP updates, flush on abort/failure, stop before finalize, discard after', () => {
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const i = (s) => { const at = src.indexOf(s); assert.ok(at >= 0, `missing: ${s}`); return at; };
  const setup = i('await setupWorkspaceCheckpoints({ provisioned, job, jobType, runId, camunda');
  const note = i('effectiveEnvelope = withCheckpointNote(effectiveEnvelope, checkpointing.restored)');
  const notify = i('checkpointer?.notify(u)');
  const abort = i("await checkpointer.flush('abort'");
  const failed = i("await checkpointer.flush('failed'");
  const stop = i('if (checkpointer && result.ok) await checkpointer.stop()');
  const finalize = src.indexOf('gitResult = finalizeGit({', stop);
  const discard = i('await checkpointing.discard()');
  assert.ok(setup < note && note < notify && notify < abort && abort < failed && failed < stop && stop < finalize && finalize < discard);
  assert.ok(src.indexOf('envelope: effectiveEnvelope', setup) > setup, 'the restored note reaches the harness envelope');
});
