// WIP checkpoints for ephemeral agent workers (issue #264).
//
// A host-provisioned agent job runs in a throwaway clone. If the worker dies
// mid-run (crash, OOM, preemption, `stop --force`), every UNCOMMITTED change and
// every unpushed local commit dies with it, and the re-activation (#239) can only
// replay the transcript. This module lets the worker periodically snapshot the
// workspace to a deterministic remote ref WITHOUT touching the agent's HEAD,
// index, or branch, and restore that snapshot on the next activation.
//
//   - Snapshot: a "shadow commit" built through a TEMPORARY index
//     (`GIT_INDEX_FILE`): `read-tree HEAD` → `add -A` (honours .gitignore) →
//     drop deny-listed / oversized paths → `write-tree` → `commit-tree -p HEAD`.
//     The agent's own index and refs are never written.
//   - Push: `refs/nano/wip/<elementInstanceKey>` with `--force-with-lease` against
//     the last sha WE pushed, so a zombie prior owner can't clobber a newer run.
//     The snapshot's ancestry carries any unpushed local commits too.
//   - Restore: fetch the ref; if the fresh clone's HEAD is an ancestor of the
//     snapshot's parent, move the branch to that parent (recovering local commits)
//     and lay the snapshot tree down as UNCOMMITTED changes. Otherwise apply the
//     prior run's base→snapshot diff onto the new HEAD (`--3way`), else skip.
//   - Delete the ref after a successful finalize.
//
// Everything is BEST-EFFORT and opt-in (`NANO_AGENT_CHECKPOINT=on`): any failure
// is logged and degrades to today's behaviour (transcript-only resume). Git runs
// ASYNC here (not spawnSync) so a slow push never blocks the ACP event loop.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHECKPOINT_REF_PREFIX = 'refs/nano/wip/';
export const CHECKPOINT_BASE_TRAILER = 'Nano-Checkpoint-Base';
export const CHECKPOINT_RUN_TRAILER = 'Nano-Checkpoint-Run';

const DEFAULTS = Object.freeze({
  minIntervalMs: 60_000,
  intervalMs: 300_000,
  maxFileBytes: 5 * 1024 * 1024,
  gitTimeoutMs: 60_000,
  flushTimeoutMs: 20_000,
});
const MIN_INTERVAL_FLOOR_MS = 5_000;

// Paths that must never leave the worker even if the agent forgot to gitignore
// them. Matched against the repo-relative path (any directory depth).
export const DENY_PATTERNS = Object.freeze([
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)\.(aws|ssh|gnupg)\//i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
  /(^|\/)\.git-credentials$/i,
]);

export function isDeniedPath(path) {
  const p = String(path ?? '');
  return DENY_PATTERNS.some((re) => re.test(p));
}

const truthy = (v) => /^(1|on|true|yes)$/i.test(String(v ?? '').trim());
const intOr = (v, dflt) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function checkpointConfig(env = process.env) {
  return {
    enabled: truthy(env.NANO_AGENT_CHECKPOINT),
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, intOr(env.NANO_AGENT_CHECKPOINT_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs)),
    // 0 disables the safety-net timer (event-driven + final flush only).
    intervalMs: intOr(env.NANO_AGENT_CHECKPOINT_INTERVAL_MS, DEFAULTS.intervalMs),
    maxFileBytes: intOr(env.NANO_AGENT_CHECKPOINT_MAX_FILE_BYTES, DEFAULTS.maxFileBytes),
    gitTimeoutMs: DEFAULTS.gitTimeoutMs,
    flushTimeoutMs: DEFAULTS.flushTimeoutMs,
  };
}

export function checkpointRef(elementInstanceKey) {
  const key = String(elementInstanceKey ?? '').trim();
  return /^[0-9A-Za-z_-]{1,128}$/.test(key) ? `${CHECKPOINT_REF_PREFIX}${key}` : null;
}

// Async git runner: `git(args, { env?, input? })` → { status, stdout, stderr }.
export function createGitRunner({ cwd, env = process.env, timeoutMs = DEFAULTS.gitTimeoutMs } = {}) {
  return (args, opts = {}) => new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: { ...env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: String(err?.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } stderr += '\n[timed out]'; }, opts.timeoutMs ?? timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err?.message || err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

const ok = (r) => r && r.status === 0;
const out = (r) => (r?.stdout || '').trim();
const errText = (r) => (r?.stderr || r?.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);

// Build a shadow commit of the working tree. Never writes the real index/refs.
// Returns { sha, tree, head, excluded } or { skipped: reason }.
export async function snapshotWorktree({ git, baseSha = '', runId = '', lastTree = null, maxFileBytes = DEFAULTS.maxFileBytes, message = 'nano: WIP checkpoint' }) {
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (!ok(head)) return { skipped: 'no-head' };
  const headSha = out(head);
  const dir = mkdtempSync(join(tmpdir(), 'nano-ckpt-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    let r = await git(['read-tree', 'HEAD'], { env });
    if (!ok(r)) return { skipped: `read-tree failed: ${errText(r)}` };
    r = await git(['add', '-A'], { env });
    if (!ok(r)) return { skipped: `add failed: ${errText(r)}` };

    const changed = await git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=AM', 'HEAD'], { env });
    if (!ok(changed)) return { skipped: `diff failed: ${errText(changed)}` };
    const excluded = [];
    for (const path of changed.stdout.split('\0').filter(Boolean)) {
      let why = isDeniedPath(path) ? 'denied' : null;
      if (!why && maxFileBytes > 0) {
        const size = await git(['cat-file', '-s', `:${path}`], { env });
        if (ok(size) && Number(out(size)) > maxFileBytes) why = 'too-large';
      }
      if (why) excluded.push({ path, why });
    }
    if (excluded.length) {
      // Revert excluded paths to their HEAD state in the temp index (drops new ones).
      r = await git(['reset', '-q', 'HEAD', '--', ...excluded.map((e) => e.path)], { env });
      if (!ok(r)) return { skipped: `exclude failed: ${errText(r)}` };
    }

    const tree = await git(['write-tree'], { env });
    if (!ok(tree)) return { skipped: `write-tree failed: ${errText(tree)}` };
    const treeSha = out(tree);
    if (lastTree && treeSha === lastTree.tree && headSha === lastTree.head) return { skipped: 'unchanged' };
    const headTree = out(await git(['rev-parse', 'HEAD^{tree}']));
    if (treeSha === headTree && (!baseSha || headSha === baseSha)) return { skipped: 'clean' };

    const trailers = [
      baseSha ? `${CHECKPOINT_BASE_TRAILER}: ${baseSha}` : '',
      runId ? `${CHECKPOINT_RUN_TRAILER}: ${runId}` : '',
    ].filter(Boolean).join('\n');
    const body = `${message}\n\n${trailers}\n`;
    const commit = await git(['commit-tree', treeSha, '-p', headSha], { input: body });
    if (!ok(commit)) return { skipped: `commit-tree failed: ${errText(commit)}` };
    return { sha: out(commit), tree: treeSha, head: headSha, excluded };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Push `sha` to `ref`. `expectSha` is the last sha we believe the remote holds
// ('' = must not exist). Returns { ok, rejected?, error? }.
export async function pushCheckpoint({ git, ref, sha, expectSha = '', remote = 'origin' }) {
  const r = await git(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${expectSha}`, remote, `${sha}:${ref}`]);
  if (ok(r)) return { ok: true };
  const text = `${r.stderr}\n${r.stdout}`;
  return { ok: false, rejected: /stale info|rejected|fetch first/i.test(text), error: errText(r) };
}

export async function deleteCheckpointRef({ git, ref, remote = 'origin' }) {
  const r = await git(['push', '--quiet', '--no-verify', remote, `:${ref}`]);
  if (ok(r)) return { ok: true };
  if (/remote ref does not exist|unable to delete .*not found/i.test(`${r.stderr}${r.stdout}`)) return { ok: true, absent: true };
  return { ok: false, error: errText(r) };
}

// Fetch the checkpoint ref. Returns { sha, parent, base } or null when absent.
export async function fetchCheckpoint({ git, ref, remote = 'origin' }) {
  const r = await git(['fetch', '--quiet', '--no-tags', remote, `+${ref}:${ref}`]);
  if (!ok(r)) {
    if (/couldn't find remote ref|no such ref|not our ref/i.test(`${r.stderr}${r.stdout}`)) return null;
    throw new Error(`fetch ${ref} failed: ${errText(r)}`);
  }
  const sha = out(await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]));
  if (!sha) return null;
  const parent = out(await git(['rev-parse', '--verify', '-q', `${sha}^1`]));
  const msg = (await git(['log', '-1', '--format=%B', sha])).stdout || '';
  const trailer = (name) => (msg.match(new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*$`, 'mi')) || [])[1] || '';
  const base = trailer(CHECKPOINT_BASE_TRAILER);
  return { sha, parent, base: /^[0-9a-f]{7,64}$/.test(base) ? base : '', runId: trailer(CHECKPOINT_RUN_TRAILER) };
}

// Lay a fetched checkpoint down onto the fresh clone. HEAD stays on the current
// branch; the snapshot's changes become UNCOMMITTED working-tree changes.
export async function restoreCheckpoint({ git, checkpoint }) {
  const { sha, parent, base } = checkpoint || {};
  if (!sha || !parent) return { restored: false, reason: 'no-parent' };
  const head = out(await git(['rev-parse', '--verify', '-q', 'HEAD']));
  if (!head) return { restored: false, reason: 'no-head' };
  const status = await git(['status', '--porcelain']);
  if (!ok(status) || out(status)) return { restored: false, reason: 'workspace-dirty' };

  const fast = await git(['merge-base', '--is-ancestor', head, parent]);
  if (ok(fast)) {
    let r = await git(['reset', '-q', '--hard', parent]);
    if (!ok(r)) return { restored: false, reason: `reset failed: ${errText(r)}` };
    r = await git(['read-tree', '-u', '--reset', sha]);
    if (!ok(r)) { await git(['reset', '-q', '--hard', head]); return { restored: false, reason: `read-tree failed: ${errText(r)}` }; }
    r = await git(['reset', '-q', parent]);
    if (!ok(r)) { await git(['reset', '-q', '--hard', head]); return { restored: false, reason: `unstage failed: ${errText(r)}` }; }
    return { restored: true, mode: 'fast-forward', head: parent, priorHead: head, commitsRecovered: head !== parent };
  }

  // The fresh clone moved past the prior run's base (e.g. main advanced and the
  // job cuts a per-run fallback branch): replay base→snapshot as a patch.
  if (!base) return { restored: false, reason: 'diverged (no base trailer)' };
  const diff = await git(['diff', '--binary', '--full-index', base, sha]);
  if (!ok(diff)) return { restored: false, reason: `diff failed: ${errText(diff)}` };
  if (!diff.stdout.trim()) return { restored: false, reason: 'empty diff' };
  const apply = await git(['apply', '--3way', '--whitespace=nowarn'], { input: diff.stdout });
  if (!ok(apply) || /conflict/i.test(apply.stderr)) {
    await git(['reset', '-q', '--hard', head]);
    await git(['clean', '-fdq']);
    return { restored: false, reason: `patch did not apply cleanly: ${errText(apply)}` };
  }
  await git(['reset', '-q']);
  return { restored: true, mode: 'patch', head, priorHead: head, commitsRecovered: false };
}

// Stateful "take a checkpoint now" function bound to one workspace + ref.
//
// Ownership: `expectSha` is the remote sha this run took over (the restored
// checkpoint) and `priorRunId` the run that wrote it. On a lease rejection we
// re-read the ref: if it was moved by that SAME superseded run (a zombie's
// late abort-flush racing our startup) we take over from it; if it was moved by
// any other run, a newer owner exists and we stop writing.
export function createWorkspaceCheckpoint({ git, ref, baseSha = '', runId = '', expectSha = '', priorRunId = '', maxFileBytes, message, now = () => Date.now() }) {
  let lastTree = null;
  let remoteSha = expectSha;
  let disabled = null;
  return async function checkpoint(reason = 'manual') {
    if (disabled) return { skipped: `disabled: ${disabled}` };
    const snap = await snapshotWorktree({ git, baseSha, runId, lastTree, maxFileBytes, message: `${message || 'nano: WIP checkpoint'} (${reason})` });
    if (!snap.sha) return snap;
    let pushed = await pushCheckpoint({ git, ref, sha: snap.sha, expectSha: remoteSha });
    if (!pushed.ok && pushed.rejected) {
      let current = null;
      try { current = await fetchCheckpoint({ git, ref }); } catch { /* treat as foreign */ }
      const takeOver = !!(current && priorRunId && current.runId === priorRunId);
      if (takeOver) {
        remoteSha = current?.sha || '';
        pushed = await pushCheckpoint({ git, ref, sha: snap.sha, expectSha: remoteSha });
      }
    }
    if (!pushed.ok) {
      if (pushed.rejected) disabled = 'lease rejected (ref moved by a newer run)';
      return { skipped: `push failed: ${pushed.error}`, rejected: !!pushed.rejected };
    }
    lastTree = { tree: snap.tree, head: snap.head };
    remoteSha = snap.sha;
    return { ref, sha: snap.sha, head: snap.head, at: new Date(now()).toISOString(), reason, excluded: snap.excluded };
  };
}

// Is this ACP `session/update` a good moment to snapshot? A completed tool call
// (edits/commands just finished) or a plan change (a step boundary).
export function isCheckpointTrigger(update) {
  if (!update || typeof update !== 'object') return false;
  if (update.sessionUpdate === 'plan') return true;
  return update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed');
}

// Rate-limited, serialized scheduler around a `checkpoint(reason)` function.
//   notify(update)  — feed ACP session/updates; triggers are coalesced so at most
//                     one checkpoint runs per `minIntervalMs` (trailing edge).
//   flush(reason)   — run one now (bounded by timeoutMs), after pending work.
//   stop()          — clear timers; later notify/flush calls are no-ops.
export function createCheckpointer({ checkpoint, minIntervalMs = DEFAULTS.minIntervalMs, intervalMs = DEFAULTS.intervalMs, onCheckpoint = null, logger = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastRunAt = -Infinity;
  let trailing = null;
  let ticker = null;
  let chain = Promise.resolve();
  let running = false;
  let stopped = false;
  const stats = { taken: 0, skipped: 0, failed: 0 };

  const run = (reason) => {
    const p = chain.then(async () => {
      if (stopped && reason !== 'final') return null;
      running = true;
      lastRunAt = now();
      try {
        const res = await checkpoint(reason);
        if (res?.sha) {
          stats.taken++;
          if (onCheckpoint) { try { await onCheckpoint(res); } catch (err) { logger?.debug?.(`checkpoint onCheckpoint threw: ${err?.message || err}`); } }
        } else {
          stats.skipped++;
          if (res?.skipped && !/^(unchanged|clean)$/.test(res.skipped)) logger?.warn?.(`WIP checkpoint (${reason}) skipped — ${res.skipped}`);
        }
        return res;
      } catch (err) {
        stats.failed++;
        logger?.warn?.(`WIP checkpoint (${reason}) failed — ${err?.message || err}`);
        return null;
      } finally {
        running = false;
      }
    });
    chain = p.catch(() => null);
    return p;
  };

  const request = (reason) => {
    if (stopped || trailing) return;
    const wait = lastRunAt + minIntervalMs - now();
    if (wait <= 0 && !running) { run(reason); return; }
    trailing = setTimer(() => { trailing = null; run(reason); }, Math.max(0, wait));
    trailing?.unref?.();
  };

  const scheduleTick = () => {
    if (!intervalMs || stopped) return;
    ticker = setTimer(() => { ticker = null; request('timer'); scheduleTick(); }, intervalMs);
    ticker?.unref?.();
  };
  scheduleTick();

  const clearAll = () => {
    if (trailing) { clearTimer(trailing); trailing = null; }
    if (ticker) { clearTimer(ticker); ticker = null; }
  };

  return {
    stats,
    notify(update) { if (isCheckpointTrigger(update)) request(update.sessionUpdate === 'plan' ? 'plan' : 'tool'); },
    async flush(reason = 'final', { timeoutMs = DEFAULTS.flushTimeoutMs } = {}) {
      clearAll();
      stopped = true;
      const p = run('final').then((r) => r, () => null);
      if (!timeoutMs) return p;
      let t;
      const timeout = new Promise((resolve) => { t = setTimer(() => resolve({ skipped: `flush timed out after ${timeoutMs}ms (${reason})` }), timeoutMs); t?.unref?.(); });
      try { return await Promise.race([p, timeout]); } finally { clearTimer(t); }
    },
    // Clear timers and wait for any in-flight checkpoint to finish.
    stop() { clearAll(); stopped = true; return chain; },
  };
}

// Prompt note appended when a checkpoint was restored into the workspace.
export function checkpointRestoredNote(info) {
  if (!info?.restored) return '';
  const lines = [
    '',
    '---',
    'WORKSPACE RESTORED FROM A WIP CHECKPOINT: a previous attempt at this task was interrupted.',
    'Its in-progress working tree has been restored into this workspace as UNCOMMITTED changes',
    info.commitsRecovered ? '(its local commits were recovered too — they are on the current branch).' : '(on top of the current branch).',
    'Before doing anything else, run `git status` and `git diff` to see what was already done,',
    'then continue from there rather than redoing it. The restored state may include a',
    'partially written file if the interruption happened mid-edit — verify before relying on it.',
    'This supersedes any statement above that uncommitted work from the prior run was lost.',
  ];
  return lines.join('\n');
}

export function withCheckpointNote(envelope, info) {
  const note = checkpointRestoredNote(info);
  if (!note || !envelope || typeof envelope !== 'object' || !envelope.task || typeof envelope.task.prompt !== 'string') return envelope;
  return { ...envelope, task: { ...envelope.task, prompt: `${envelope.task.prompt}\n${note}` } };
}
