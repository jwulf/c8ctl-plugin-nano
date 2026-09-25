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
//     (`GIT_INDEX_FILE`): `read-tree HEAD` (or the empty tree on an UNBORN HEAD) →
//     `add -A` (honours .gitignore) → drop deny-listed / oversized paths →
//     `write-tree` → `commit-tree -p HEAD` (parentless when unborn).
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
//   - GC: a throttled background sweep deletes WIP refs past a TTL, or whose
//     element instance the engine reports terminal (orphans from cancelled or
//     never-reactivated jobs).
//
// Mode (`NANO_AGENT_CHECKPOINT`): `auto` (default) runs only for provisioned jobs
// that already push an authenticated working branch; `on` forces it for any
// provisioned job; `off` disables. Everything is BEST-EFFORT: any failure is
// logged and degrades to today's behaviour (transcript-only resume). Git runs
// ASYNC here (not spawnSync) so a slow push never blocks the ACP event loop.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHECKPOINT_REF_PREFIX = 'refs/nano/wip/';
export const CHECKPOINT_BASE_TRAILER = 'Nano-Checkpoint-Base';
export const CHECKPOINT_RUN_TRAILER = 'Nano-Checkpoint-Run';
// The symbolic branch HEAD was on when the snapshot was taken. Restore refuses to
// FAST-restore (reset HEAD + recover commits) a snapshot whose branch differs from
// the run's expected working branch, so off-branch commits can never be reset onto
// — and later pushed by finalizeGit to — the wrong branch.
export const CHECKPOINT_BRANCH_TRAILER = 'Nano-Checkpoint-Branch';
// Explicit "HEAD was detached" identity, recorded (instead of an OMITTED trailer)
// when a snapshot is taken off any branch. The `:` makes it an impossible git
// branch name, so it can never equal a real `expectedBranch` and always trips the
// branch-identity guard — a detached snapshot's `parent` may still be an ancestor
// of the run's work-branch tip, so without this it would masquerade as a legacy
// trailerless snapshot and be fast-restored (resetting the work branch onto the
// off-branch commit). Legacy snapshots (created before this trailer existed) carry
// NO trailer at all and keep the prior ancestry-only behaviour.
export const CHECKPOINT_DETACHED_MARKER = 'HEAD:detached';

// Per-run fallback branches provisioning cuts when a job supplies no stable working
// branch: `nano/agent-work/<base>-<runId>`. The `runId` segment makes the name differ
// on EVERY activation, so a checkpoint's branch trailer can never equal the next run's
// expected working branch. That rename is BENIGN — both are ephemeral fallbacks off the
// same base, not a genuine off-branch/detached move — so the restore path treats it
// specially: it still refuses the ancestry-RESET fast path but falls through to the
// non-reset PATCH restore, recovering the fallback job's WIP instead of stranding it.
const FALLBACK_BRANCH_RE = /^nano\/agent-work\//;
// The unique run-token provisioning appends to a generated fallback segment:
// `nano/agent-work/<base>-<runToken>`, where <runToken> is the run's UUID (production)
// or a `run-<token>` workspace basename (the direct-call test fallback). Anchored at the
// END so a <base> that itself contains dashes still parses. Used to validate a benign
// per-run rename on the generated fallback IDENTITY (its <base> AND <runToken>), not
// merely the `nano/agent-work/` namespace prefix — an unrelated or stable branch that
// only lives under that namespace must NOT be mistaken for a per-run fallback rename.
const FALLBACK_UNIQ_RE = /-((?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})|run-[0-9A-Za-z]+)$/;
// Parse a generated per-run fallback branch into { base, token }, or null when `name`
// is not a generated fallback (missing namespace prefix, or no trailing run-token).
function fallbackBranchParts(name) {
  if (typeof name !== 'string' || !FALLBACK_BRANCH_RE.test(name)) return null;
  const m = name.match(FALLBACK_UNIQ_RE);
  if (!m) return null;
  const base = name.slice('nano/agent-work/'.length, name.length - m[0].length);
  if (!base) return null;
  return { base, token: m[1] };
}

// Canonical git branch-segment sanitizer. Provisioning builds a per-run fallback
// branch `nano/agent-work/${sanitizeBranchSegment(base)}-${sanitizeBranchSegment(runId)}`
// (c8ctl-plugin.js), and the restore path reconstructs that generated run-token to
// validate a benign per-run rename — so both MUST share ONE implementation to avoid
// drift. Exported and consumed by the plugin as the single source of truth.
export function sanitizeBranchSegment(s) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[^0-9A-Za-z._-]+/g, '-') // collapse anything unusual to a dash
    .replace(/\.{2,}/g, '.')            // no doubled dots (git forbids "..")
    .replace(/^[-.]+/, '')              // no leading dot or dash
    .slice(0, 60)                       // bound the segment BEFORE the trailing
    .replace(/[-.]+$/g, '')             // checks, so truncating at char 60 can't
    .replace(/\.lock$/i, 'lock');       // re-introduce a trailing dot/dash or ".lock"
  return cleaned || 'base';
}

const DEFAULTS = Object.freeze({
  minIntervalMs: 60_000,
  intervalMs: 300_000,
  maxFileBytes: 5 * 1024 * 1024,
  gitTimeoutMs: 60_000,
  // Grace window after SIGTERM before escalating to SIGKILL when a git child (or a
  // transport/credential helper it spawned) ignores the polite terminate on
  // timeout/abort — bounds how long the runner can stay pending past its deadline.
  gitKillGraceMs: 5_000,
  flushTimeoutMs: 20_000,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  gcGraceMs: 60 * 60 * 1000,
  gcEveryMs: 60 * 60 * 1000,
});
const MIN_INTERVAL_FLOOR_MS = 5_000;

// Paths that must never leave the worker even if the agent forgot to gitignore
// them. Matched against the repo-relative path (any directory depth).
export const DENY_PATTERNS = Object.freeze([
  // Any basename beginning with `.env` (the documented `.env*` policy): `.env`,
  // `.env.local`, but also `.envrc`, `.envlocal`, … — not just dot-suffixed names.
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  // The whole `id_` basename family (the documented `id_*` policy): `id_rsa`,
  // `id_ed25519`, but also `id_token`, `id_ed25519_old`, `id_custom`, … so a
  // private key the content scanner does not recognise still never leaves the host.
  /(^|\/)id_[^/]*$/i,
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

// Content patterns for well-known credential formats. A changed file whose text
// matches any of these (or contains a secret value this job was given) is kept
// out of the snapshot.
export const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
]);
export function normalizeSecretValues(values) {
  const out = new Set();
  for (const v of values || []) {
    const s = typeof v === 'string' ? v.trim() : '';
    // Honour EVERY non-empty injected secret value regardless of length. The
    // documented guarantee excludes any changed file whose content contains an
    // injected secret from the checkpoint; dropping short values (the old 8-char
    // floor) would silently let a short `setup.secretRefs` value slip into a WIP
    // ref. Over-excluding a file that merely contains a short secret substring is
    // the safe degradation — leaking a secret is not.
    if (s) out.add(s);
  }
  return [...out];
}

export function containsSecret(text, secretValues = []) {
  const t = String(text ?? '');
  if (!t) return false;
  if (secretValues.some((v) => t.includes(v))) return true;
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(t));
}

// Extract any credentials embedded in a remote URL's userinfo (`user:pass@host`).
// Provisioning deliberately preserves author-supplied userinfo in the origin URL,
// and for such credential-bearing URLs no separate repo token exists — so the URL
// password would otherwise never be in the checkpoint secret-scan set and a changed
// file echoing it could enter the readable WIP ref. Returns the password (and
// username), in BOTH raw and percent-decoded forms, so a file containing either the
// encoded or decoded credential is excluded. Non-HTTP(S) / userinfo-less URLs yield [].
export function credentialsFromUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return [];
  let u;
  try { u = new URL(s); } catch { return []; }
  if (!/^https?:$/i.test(u.protocol)) return [];
  const out = new Set();
  for (const raw of [u.password, u.username]) {
    if (!raw) continue;
    out.add(raw);
    try { const dec = decodeURIComponent(raw); if (dec) out.add(dec); } catch { /* leave raw */ }
  }
  return [...out];
}

const truthy = (v) => /^(1|on|true|yes)$/i.test(String(v ?? '').trim());
const intOr = (v, dflt) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

const MODES = new Set(['auto', 'on', 'off']);
export function checkpointMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  if (MODES.has(v)) return v;
  if (truthy(v)) return 'on';
  if (/^(0|false|no|disabled?)$/.test(v)) return 'off';
  return 'auto';
}

export function checkpointConfig(env = process.env) {
  const mode = checkpointMode(env.NANO_AGENT_CHECKPOINT);
  return {
    mode,
    enabled: mode !== 'off',
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, intOr(env.NANO_AGENT_CHECKPOINT_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs)),
    // 0 disables the safety-net timer (event-driven + final flush only).
    intervalMs: intOr(env.NANO_AGENT_CHECKPOINT_INTERVAL_MS, DEFAULTS.intervalMs),
    maxFileBytes: intOr(env.NANO_AGENT_CHECKPOINT_MAX_FILE_BYTES, DEFAULTS.maxFileBytes),
    ttlMs: intOr(env.NANO_AGENT_CHECKPOINT_TTL_MS, DEFAULTS.ttlMs),
    gcGraceMs: DEFAULTS.gcGraceMs,
    gcEveryMs: DEFAULTS.gcEveryMs,
    gitTimeoutMs: DEFAULTS.gitTimeoutMs,
    flushTimeoutMs: DEFAULTS.flushTimeoutMs,
  };
}

// Does this remote URL carry its OWN push authentication, independent of a
// separately-supplied token? Provisioning preserves author-embedded HTTPS
// userinfo (`https://user:pass@host/…`, kept by `authUrl`) and an SSH remote
// (`git@host:path` or `ssh://…`) authenticates through the host SSH agent/config.
// Either can push with NO `repoToken`, so token presence alone under-detects an
// authenticated clone and would silently skip default-on checkpointing.
export function isAuthenticatedRemote(url) {
  const s = String(url ?? '').trim();
  if (!s) return false;
  // scp-like SSH syntax `[user@]host:path` (no URL scheme).
  if (/^[^/@]+@[^/:]+:/.test(s)) return true;
  try {
    const u = new URL(s);
    if (u.protocol === 'ssh:') return true;
    if ((u.protocol === 'https:' || u.protocol === 'http:') && (u.username || u.password)) return true;
  } catch { /* not a parseable URL — no embedded auth we can recognize */ }
  return false;
}

// Should this job checkpoint? `auto` only when the job already publishes its work:
// a provisioned, authenticated clone on a symbolic working branch that pushes.
export function checkpointEligibility({ mode, provisioned, envelope, token }) {
  if (mode === 'off') return { enabled: false, reason: 'NANO_AGENT_CHECKPOINT=off' };
  if (!provisioned?.workspaceDir) return { enabled: false, reason: 'no provisioned workspace' };
  if (mode === 'on') return { enabled: true, reason: 'NANO_AGENT_CHECKPOINT=on' };
  const push = envelope?.branch?.push;
  if (push === false || /^(false|0|no|off)$/i.test(String(push ?? ''))) return { enabled: false, reason: 'job does not push (branch.push=false)' };
  // Authentication is NOT synonymous with a token: provisioning also authenticates
  // via author-embedded HTTPS userinfo or an SSH remote. Prefer provisioning's own
  // authentication result when it stamped one; else fall back to token presence or
  // recognizing an authenticated remote URL form.
  const authenticated = provisioned?.authenticated === true
    || !!token
    || isAuthenticatedRemote(envelope?.repository?.url);
  if (!authenticated) return { enabled: false, reason: 'anonymous clone (no push credentials)' };
  if (!provisioned.workingBranch) return { enabled: false, reason: 'detached checkout (no working branch)' };
  return { enabled: true, reason: 'auto: job pushes an authenticated working branch' };
}

export function checkpointRef(elementInstanceKey) {
  const key = String(elementInstanceKey ?? '').trim();
  return /^[0-9A-Za-z_-]{1,128}$/.test(key) ? `${CHECKPOINT_REF_PREFIX}${key}` : null;
}

// Never let git invoke the host's configured credential helper for our remote
// checkpoint ops. The job token is delivered ONLY via GIT_ASKPASS; a configured
// helper such as `store` would otherwise reuse or PERSIST that token to disk on a
// push/fetch/delete. Suppress it on EVERY invocation (mirrors the provisioning
// path's `credential.helper=` at clone/fetch/push) — it is a no-op for local ops,
// so baking it into the runner guarantees no remote checkpoint op (main runner,
// scratch-repo delete, or GC sweep) is ever missed. Preserves askpass-only secrets.
const CRED_SUPPRESS = ['-c', 'credential.helper='];

// Async git runner: `git(args, { env?, input? })` → { status, stdout, stderr }.
// An optional `signal` (AbortSignal) makes the runner CANCELLABLE: once it aborts,
// any in-flight child is killed and every subsequent invocation fails fast instead
// of spawning. This lets a bounded background job (e.g. the GC sweep) be TORN DOWN
// deterministically rather than abandoned to keep running git against a workspace
// the caller is about to reap.
export function createGitRunner({ cwd, env = process.env, timeoutMs = DEFAULTS.gitTimeoutMs, killGraceMs = DEFAULTS.gitKillGraceMs, signal } = {}) {
  return (args, opts = {}) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: null, stdout: '', stderr: '[aborted]' });
      return;
    }
    let child;
    try {
      // `detached` makes the child a process-group leader on POSIX, so a timeout or
      // abort can signal the WHOLE group (git plus any transport / credential helper
      // it spawned) via a negative pid — a transport that ignores git's own SIGTERM
      // would otherwise keep the stdio pipes open so `close` never fires, stranding
      // the runner past `gitTimeoutMs`.
      child = spawn('git', [...CRED_SUPPRESS, ...args], {
        cwd,
        env: { ...env, ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: String(err?.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killTimer = null;
    // Signal the child's whole PROCESS GROUP (negative pid, where `detached` made it
    // the leader); fall back to the single pid on Windows or if the group signal
    // fails (e.g. the child already reaped).
    const killGroup = (sig) => {
      const pid = child.pid;
      if (process.platform !== 'win32' && typeof pid === 'number') {
        try { process.kill(-pid, sig); return; } catch { /* fall through */ }
      }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    // Bounded, ESCALATING termination: SIGTERM, then SIGKILL after a grace window if
    // the group is still alive, so the child is guaranteed to exit and `close` fires
    // — the runner settles only once all child I/O has closed, never hangs.
    const terminate = () => {
      killGroup('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => killGroup('SIGKILL'), opts.killGraceMs ?? killGraceMs);
        killTimer.unref?.();
      }
    };
    const timer = setTimeout(() => { stderr += '\n[timed out]'; terminate(); }, opts.timeoutMs ?? timeoutMs);
    timer.unref?.();
    const onAbort = () => { stderr += '\n[aborted]'; terminate(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err?.message || err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ status: code, stdout, stderr });
    });
    // An `AbortSignal` does NOT replay an abort that already fired: one that lands in
    // the window between the fast-path guard at entry and `addEventListener` above is
    // never delivered to `onAbort`, so the child would otherwise run to its normal
    // timeout — holding a workspace the caller is reaping open for up to `timeoutMs`.
    // Recheck now, with all handlers wired, so a race-landed abort still tears the
    // child down immediately. (`onAbort` is idempotent with the `once` listener.)
    if (signal?.aborted) onAbort();
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

const ok = (r) => r && r.status === 0;
const out = (r) => (r?.stdout || '').trim();
// Redact HTTPS/HTTP URL userinfo (`user:pass@host` → `***@host`) before any git
// diagnostic reaches a log or result. Git echoes the origin URL in some failure
// messages, and a provisioned remote can carry the token in its userinfo.
export const redactUrlUserinfo = (s) => String(s).replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
const errText = (r) => redactUrlUserinfo((r?.stderr || r?.stdout || '').trim()).split('\n').slice(-3).join(' | ').slice(0, 400);

// Build a shadow commit of the working tree. Never writes the real index/refs.
// Returns { sha, tree, head, excluded } or { skipped: reason }.
export async function snapshotWorktree({ git, baseSha = '', runId = '', lastTree = null, maxFileBytes = DEFAULTS.maxFileBytes, secretValues = [], message = 'nano: WIP checkpoint' }) {
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD']);
  // An UNBORN HEAD (a fresh clone of an empty repo, or before the agent's first
  // commit) has no HEAD commit, yet provisioning treats such a clone as pushable —
  // so pre-first-commit WIP is checkpoint-ELIGIBLE and must not be silently dropped.
  // We snapshot the working tree as a PARENTLESS shadow commit (diffed against the
  // empty tree) that `restoreCheckpoint` lays back onto a fresh unborn clone.
  const unborn = !ok(head);
  const headSha = unborn ? '' : out(head);
  // The symbolic branch HEAD is on right now. When HEAD is DETACHED there is no
  // branch, so we record an explicit detached marker (not an omitted trailer):
  // that distinguishes a genuinely off-branch snapshot from a legacy trailerless
  // one, so a later restore refuses to fast-restore it onto the run's work branch
  // (which would otherwise reset the work branch to the detached/off-branch commit).
  const symbolicBranch = out(await git(['symbolic-ref', '--short', '-q', 'HEAD'])) || CHECKPOINT_DETACHED_MARKER;
  const dir = mkdtempSync(join(tmpdir(), 'nano-ckpt-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    // For an unborn HEAD there is no HEAD tree to seed from / diff against, so use
    // git's empty tree (computed for the repo's object format). `git read-tree`,
    // `git diff --cached` and the path-limited `git reset` all accept a tree-ish, so
    // the same code path serves born and unborn snapshots with only `baseRef` swapped.
    const emptyTree = out(await git(['hash-object', '-t', 'tree', '--stdin'], { input: '' })) || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const baseRef = unborn ? emptyTree : 'HEAD';
    let r = await git(['read-tree', baseRef], { env });
    if (!ok(r)) return { skipped: `read-tree failed: ${errText(r)}` };
    r = await git(['add', '-A'], { env });
    if (!ok(r)) return { skipped: `add failed: ${errText(r)}` };

    // AMT (added/modified/type-changed), NOT D: a type change (e.g. a tracked
    // symlink/submodule replaced by a regular file) is staged by `add -A` and
    // enters the written tree, so it must be scanned against the deny-list, size
    // limit and secret-content check too — excluding T would let it bypass them.
    const changed = await git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=AMT', baseRef], { env });
    if (!ok(changed)) return { skipped: `diff failed: ${errText(changed)}` };
    const excluded = [];
    for (const path of changed.stdout.split('\0').filter(Boolean)) {
      let why = isDeniedPath(path) ? 'denied' : null;
      if (!why) {
        const size = await git(['cat-file', '-s', `:${path}`], { env });
        if (maxFileBytes > 0 && ok(size) && Number(out(size)) > maxFileBytes) why = 'too-large';
        else {
          const blob = await git(['cat-file', 'blob', `:${path}`], { env });
          if (!ok(blob)) why = 'unreadable';
          else if (containsSecret(blob.stdout, secretValues)) why = 'secret-content';
        }
      }
      if (why) excluded.push({ path, why });
    }
    if (excluded.length) {
      // Revert excluded paths to their base state in the temp index (drops new ones).
      r = await git(['reset', '-q', baseRef, '--', ...excluded.map((e) => e.path)], { env });
      if (!ok(r)) return { skipped: `exclude failed: ${errText(r)}` };
    }

    const tree = await git(['write-tree'], { env });
    if (!ok(tree)) return { skipped: `write-tree failed: ${errText(tree)}` };
    const treeSha = out(tree);
    if (lastTree && treeSha === lastTree.tree && headSha === lastTree.head) return { skipped: 'unchanged' };
    const headTree = unborn ? emptyTree : out(await git(['rev-parse', 'HEAD^{tree}']));
    // "Clean" (nothing worth a WIP ref) means the working tree matches HEAD AND the
    // committed state is already safe on the remote. With a known base that is
    // `headSha === baseSha` (HEAD is the base, no local commits). But an EMPTY-base
    // run (`!baseSha`, a fresh clone of an empty repo) is only clean while HEAD is
    // still UNBORN: once the agent lands its first local commit, `treeSha === headTree`
    // again, yet that commit is unpushed — skipping it would lose it if the worker
    // dies before the branch push, so snapshot it (recoverable via the WIP ref).
    if (treeSha === headTree && (baseSha ? headSha === baseSha : unborn)) return { skipped: 'clean' };

    const trailers = [
      baseSha ? `${CHECKPOINT_BASE_TRAILER}: ${baseSha}` : '',
      runId ? `${CHECKPOINT_RUN_TRAILER}: ${runId}` : '',
      symbolicBranch ? `${CHECKPOINT_BRANCH_TRAILER}: ${symbolicBranch}` : '',
    ].filter(Boolean).join('\n');
    const body = `${message}\n\n${trailers}\n`;
    // A born snapshot descends from HEAD; an unborn one is PARENTLESS (there is no
    // HEAD commit) — `restoreCheckpoint` keys the unborn-restore path off that.
    const commit = await git(unborn ? ['commit-tree', treeSha] : ['commit-tree', treeSha, '-p', headSha], { input: body });
    if (!ok(commit)) return { skipped: `commit-tree failed: ${errText(commit)}` };
    return { sha: out(commit), tree: treeSha, head: headSha, excluded };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Push `sha` to `ref`. `expectSha` is the last sha we believe the remote holds
// ('' = must not exist). Returns { ok, rejected?, error? }.
// Why did a push fail?
//   lease     — our --force-with-lease expectation was stale (another writer moved the ref)
//   policy    — the remote refused it (repository rules, secret push protection, hooks)
//   auth      — no permission / bad credentials
//   transient — anything else (network, timeout); worth retrying later
export function classifyPushFailure(text) {
  const t = String(text ?? '');
  if (/\(stale info\)/i.test(t)) return 'lease';
  if (/remote rejected|GH0\d\d|push protection|repository rule|pre-receive hook|protected ref|declined/i.test(t)) return 'policy';
  if (/permission (to .* )?denied|403|authentication failed|could not read username|invalid username or password|access denied|not authorized/i.test(t)) return 'auth';
  if (/! \[rejected\]/i.test(t)) return 'lease';
  return 'transient';
}

export async function pushCheckpoint({ git, ref, sha, expectSha = '', remote = 'origin' }) {
  const r = await git(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${expectSha}`, remote, `${sha}:${ref}`]);
  if (ok(r)) return { ok: true };
  const kind = classifyPushFailure(`${r.stderr}\n${r.stdout}`);
  return { ok: false, kind, rejected: kind === 'lease', error: errText(r) };
}

// Delete `ref`. When `expectSha` is a non-null string the delete is FENCED with
// `--force-with-lease=<ref>:<expectSha>` so it only removes the ref while it still
// holds the SHA this run owns: an older activation that finishes after a newer one
// took over the same element-instance ref can no longer delete the newer worker's
// recoverable WIP. A lease mismatch (the ref moved on) returns `{ staleLease:true }`
// and leaves the ref intact for its new owner. `expectSha = ''` demands the ref not
// exist. `expectSha = null` (default) is the legacy unconditional delete.
export async function deleteCheckpointRef({ git, ref, remote = 'origin', expectSha = null }) {
  const args = expectSha != null
    ? ['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${expectSha}`, remote, `:${ref}`]
    : ['push', '--quiet', '--no-verify', remote, `:${ref}`];
  const r = await git(args);
  if (ok(r)) return { ok: true };
  const text = `${r.stderr}${r.stdout}`;
  if (/remote ref does not exist|unable to delete .*not found/i.test(text)) return { ok: true, absent: true };
  if (expectSha != null && classifyPushFailure(text) === 'lease') return { ok: false, staleLease: true, error: errText(r) };
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
  return { sha, parent, base: /^[0-9a-f]{7,64}$/.test(base) ? base : '', runId: trailer(CHECKPOINT_RUN_TRAILER), branch: trailer(CHECKPOINT_BRANCH_TRAILER) };
}

// Lay a fetched checkpoint down onto the fresh clone. HEAD stays on the current
// branch; the snapshot's changes become UNCOMMITTED working-tree changes.
// `expectedBranchEphemeral` marks the run's working branch as a per-run fallback
// branch (`nano/agent-work/…-<runId>`), whose name necessarily differs from the
// snapshot's every activation — a benign rename that must still recover WIP.
export async function restoreCheckpoint({ git, checkpoint, expectedBranch = null, expectedBranchEphemeral = false }) {
  const { sha, parent, base, branch, runId: snapshotRunId = '' } = checkpoint || {};
  if (!sha) return { restored: false, reason: 'no-sha' };
  const head = out(await git(['rev-parse', '--verify', '-q', 'HEAD']));
  const status = await git(['status', '--porcelain']);
  if (!ok(status) || out(status)) return { restored: false, reason: 'workspace-dirty' };

  // A PARENTLESS snapshot was taken on an UNBORN HEAD (pre-first-commit WIP). It can
  // only be laid back onto a still-unborn clone: read its tree into the working tree,
  // then empty the index so the files return as uncommitted (untracked) changes on the
  // unborn branch. No branch pointer moves, so the branch-identity guard does not apply.
  if (!parent) {
    if (head) return { restored: false, reason: 'unborn snapshot but clone already has commits' };
    let r = await git(['read-tree', '-u', '--reset', sha]);
    if (!ok(r)) return { restored: false, reason: `read-tree failed: ${errText(r)}` };
    r = await git(['read-tree', '--empty']);
    if (!ok(r)) return { restored: false, reason: `unstage failed: ${errText(r)}` };
    return { restored: true, mode: 'unborn', head: '', priorHead: '', commitsRecovered: false };
  }

  // Branch-identity guard (applies to every PARENTFUL restore below — born OR unborn
  // clone): a snapshot records the symbolic branch HEAD was on (or an explicit detached
  // marker). If it was taken on a DIFFERENT branch — or DETACHED — relative to this run's
  // expected working branch, its `parent` may descend from the work-branch tip yet carry
  // off-branch/detached commits. Recovering it would move the work branch to that commit
  // and let a later `finalizeGit` push it to the wrong branch (bypassing branch-mismatch
  // protection). Refuse cross-identity recovery and retain the checkpoint for explicit
  // recovery. (Legacy snapshots carry no branch trailer — `branch` empty — and keep the
  // prior ancestry-only behaviour; the detached marker never equals a real branch name.)
  const branchMismatch = Boolean(branch) && Boolean(expectedBranch) && branch !== expectedBranch;
  // A per-run fallback branch is re-cut with a fresh runId every activation, so its name
  // never matches the snapshot's trailer even though both are ephemeral fallbacks off the
  // SAME base. Validate that benign rename on the generated fallback IDENTITY — but the
  // shared `<base>` alone is NOT proof: an agent can `git checkout` a DIFFERENT generated
  // branch under the same namespace+base (or a base that sanitizes identically), whose
  // off-branch commits must not be patch-restored onto — and then published on — this
  // run's work branch. Provisioning names the branch `nano/agent-work/<base>-<sanitize(runId)>`,
  // so require BOTH the snapshot's <base> to equal this run's fallback <base> AND the
  // snapshot's branch <runToken> to equal the sanitized run-token of the run that WROTE
  // the snapshot (its own `runId` trailer, returned by `fetchCheckpoint`). That ties the
  // branch to the prior activation's own provisioned fallback, not merely the prefix/base.
  const snapParts = fallbackBranchParts(branch);
  const expParts = fallbackBranchParts(expectedBranch);
  const fallbackRename = branchMismatch && expectedBranchEphemeral === true
    && snapParts !== null && expParts !== null
    && snapParts.base === expParts.base
    && snapParts.token === sanitizeBranchSegment(snapshotRunId);
  const branchGuardRefused = branchMismatch && !fallbackRename;

  // PARENTFUL snapshot on an UNBORN clone: the prior run made its first local commit(s)
  // on a fresh clone of an (empty) remote — never pushed to the base — then checkpointed,
  // so the snapshot is parentful (its parent is that first commit) while a re-clone of the
  // still-empty remote is unborn again. The fetched WIP ref carries those commits as
  // `parent`'s ancestry; recover them by pointing the (unborn) branch at `parent`, then
  // lay the snapshot tree down as uncommitted changes — instead of unconditionally
  // discarding the fetch as `no-head` and losing the first local commit. Subject to the
  // same branch-identity guard (a genuine off-branch/detached snapshot is left on the ref).
  if (!head) {
    if (branchGuardRefused) {
      const where = branch === CHECKPOINT_DETACHED_MARKER ? 'a detached HEAD' : `'${branch}'`;
      return { restored: false, reason: `branch-mismatch (snapshot on ${where}, expected '${expectedBranch}')`, branchMismatch: true };
    }
    let r = await git(['reset', '-q', '--hard', parent]);
    if (!ok(r)) return { restored: false, reason: `reset failed: ${errText(r)}` };
    r = await git(['read-tree', '-u', '--reset', sha]);
    if (!ok(r)) return { restored: false, reason: `read-tree failed: ${errText(r)}` };
    r = await git(['reset', '-q', parent]);
    if (!ok(r)) return { restored: false, reason: `unstage failed: ${errText(r)}` };
    return { restored: true, mode: 'unborn-parentful', head: parent, priorHead: '', commitsRecovered: true };
  }

  const fast = !branchMismatch && ok(await git(['merge-base', '--is-ancestor', head, parent]));
  if (fast) {
    let r = await git(['reset', '-q', '--hard', parent]);
    if (!ok(r)) return { restored: false, reason: `reset failed: ${errText(r)}` };
    r = await git(['read-tree', '-u', '--reset', sha]);
    if (!ok(r)) { await git(['reset', '-q', '--hard', head]); return { restored: false, reason: `read-tree failed: ${errText(r)}` }; }
    r = await git(['reset', '-q', parent]);
    if (!ok(r)) { await git(['reset', '-q', '--hard', head]); return { restored: false, reason: `unstage failed: ${errText(r)}` }; }
    return { restored: true, mode: 'fast-forward', head: parent, priorHead: head, commitsRecovered: head !== parent };
  }

  // A GENUINELY branch-mismatched snapshot (off-branch/detached) must NOT be
  // commit-recovered onto this branch; its work lives only on the ref and is left
  // there for explicit, human recovery. A benign per-run fallback rename instead
  // falls through to the non-reset patch restore below (it never moves the branch).
  if (branchMismatch && !fallbackRename) {
    const where = branch === CHECKPOINT_DETACHED_MARKER ? 'a detached HEAD' : `'${branch}'`;
    return { restored: false, reason: `branch-mismatch (snapshot on ${where}, expected '${expectedBranch}')`, branchMismatch: true };
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
// re-read the ref: if it was moved by THIS run itself (a transient push error
// after the server had already accepted our checkpoint left our `remoteSha`
// stale) we take over from it and re-push. If it was moved by the SAME
// superseded run (`priorRunId` — a zombie's late abort-flush racing our startup)
// we must NOT clobber it: that write is independent, newer WIP our divergent
// workspace does not hold, so we leave the ref intact and retry rather than
// overwriting it. If it was moved by any other run, a newer owner exists and we
// stop writing.
//
// `startupFetchFailed` marks a BLIND START: the setup-time `fetchCheckpoint`
// threw, so we hold no `priorRunId` and could not restore the existing ref. An
// existing ref then rejects our first `--force-with-lease=ref:''` push, but that
// rejection is NOT proof a newer run owns it — it may simply be the ref we failed
// to read. Per the documented retry-on-next-trigger contract, treat that initial
// conflict as RETRYABLE rather than permanently disabling (and never clobber it:
// blind-clobbering could overwrite a genuinely newer run's WIP). Once we prove the
// ref's state (a successful push or a legitimate take-over) the blind window ends
// and a later lease rejection disables normally.
export function createWorkspaceCheckpoint({ git, ref, baseSha = '', runId = '', expectSha = '', priorRunId = '', startupFetchFailed = false, maxFileBytes, secretValues = [], message, now = () => Date.now() }) {
  let lastTree = null;
  let remoteSha = expectSha;
  let disabled = null;
  let established = !startupFetchFailed;
  return async function checkpoint(reason = 'manual') {
    if (disabled) return { skipped: `disabled: ${disabled}` };
    const snap = await snapshotWorktree({ git, baseSha, runId, lastTree, maxFileBytes, secretValues, message: `${message || 'nano: WIP checkpoint'} (${reason})` });
    if (!snap.sha) return snap;
    let pushed = await pushCheckpoint({ git, ref, sha: snap.sha, expectSha: remoteSha });
    if (!pushed.ok && pushed.kind === 'lease') {
      let current = null;
      try { current = await fetchCheckpoint({ git, ref }); } catch { /* treat as foreign */ }
      // Take over ONLY when the ref moved to a checkpoint THIS run itself wrote: a
      // transient push error after the server had already accepted our push leaves our
      // `remoteSha` stale, so re-pushing our own (identical-lineage) snapshot is safe.
      const selfTakeOver = !!(current && runId && current.runId === runId);
      if (selfTakeOver) {
        remoteSha = current?.sha || '';
        pushed = await pushCheckpoint({ git, ref, sha: snap.sha, expectSha: remoteSha });
      } else if (current && priorRunId && current.runId === priorRunId) {
        // The SUPERSEDED run we took over from wrote a NEWER checkpoint after our startup
        // fetch (a zombie's late abort-flush). That ref holds independent, uncommitted WIP
        // (and possibly local commits) our divergent workspace does not contain — a
        // `--force-with-lease` over it would destroy exactly the work this takeover path
        // exists to preserve. Leave the newer ref INTACT and retry on a future trigger
        // rather than overwriting it; never disable (ownership may still legitimately
        // settle, e.g. the zombie finally exits and a later run reconciles).
        return { skipped: `push failed (lease): superseded run ${priorRunId} wrote a newer checkpoint — left intact`, kind: 'lease', rejected: true, retryable: true, disabled: null };
      }
    }
    if (!pushed.ok) {
      // Retrying would fail the same way for everything but a transient error.
      if (pushed.kind === 'lease') {
        if (!established) {
          // Blind start: a transient setup fetch left us unable to read/own the
          // ref. Don't disable — retry on the next trigger (the fetch may recover
          // and a legitimate owner emerge); clobbering could destroy a newer run's WIP.
          return { skipped: `push failed (lease, blind start): ${pushed.error}`, kind: 'lease', rejected: true, retryable: true, disabled: null };
        }
        disabled = 'lease rejected (ref moved by a newer run)';
      }
      else if (pushed.kind === 'policy') disabled = `remote refused the push (repository rule / push protection): ${pushed.error}`;
      else if (pushed.kind === 'auth') disabled = `no permission to push ${ref}: ${pushed.error}`;
      return { skipped: `push failed (${pushed.kind}): ${pushed.error}`, kind: pushed.kind, rejected: pushed.kind === 'lease', disabled: disabled || null };
    }
    lastTree = { tree: snap.tree, head: snap.head };
    remoteSha = snap.sha;
    established = true;
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

  const run = (reason, { force = false } = {}) => {
    // Reserve the run slot SYNCHRONOUSLY, before the async `chain.then` body runs.
    // If several ACP updates arrive in one tick, the first `request()` that lands
    // here flips `running`/`lastRunAt` immediately, so the rest coalesce onto the
    // trailing timer instead of each enqueueing its own checkpoint.
    running = true;
    lastRunAt = now();
    const p = chain.then(async () => {
      if (stopped && !force) { running = false; return null; }
      try {
        const res = await checkpoint(reason);
        if (res?.sha) {
          stats.taken++;
          if (onCheckpoint) { try { await onCheckpoint(res); } catch (err) { logger?.debug?.(`checkpoint onCheckpoint threw: ${err?.message || err}`); } }
        } else {
          stats.skipped++;
          if (res?.disabled) logger?.warn?.(`WIP checkpoints stopped for this job — ${res.disabled}`);
          else if (res?.skipped && !/^(unchanged|clean|disabled: )/.test(res.skipped)) logger?.warn?.(`WIP checkpoint (${reason}) skipped — ${res.skipped}`);
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
      // Force the run past the post-stop guard AND preserve the caller's reason so
      // an abort/failure flush records `abort`/`failed` (not `final`) in the commit
      // message, logs and `agentCheckpoint.reason`.
      const p = run(reason, { force: true }).then((r) => r, () => null);
      if (!timeoutMs) return p;
      let t;
      const timeout = new Promise((resolve) => { t = setTimer(() => resolve({ skipped: `flush timed out after ${timeoutMs}ms (${reason})` }), timeoutMs); t?.unref?.(); });
      try { return await Promise.race([p, timeout]); } finally { clearTimer(t); }
    },
    // Clear timers and wait for any in-flight checkpoint to finish.
    stop() { clearAll(); stopped = true; return chain; },
  };
}

// ── Orphan GC ────────────────────────────────────────────────────────────────
// A WIP ref outlives its job when the job never succeeds again (cancelled
// instance, exhausted retries, deleted definition). Sweep them from any job's
// clone: delete refs whose snapshot is older than `ttlMs`, and refs older than
// `graceMs` whose element instance the engine reports terminal. An unknown /
// unreachable element (404, another engine sharing the repo) is NOT treated as
// terminal — only the TTL reclaims those.
const lastSweepAt = new Map();

export function shouldSweep(key, { everyMs = DEFAULTS.gcEveryMs, now = Date.now(), registry = lastSweepAt } = {}) {
  const last = registry.get(key);
  if (last != null && now - last < everyMs) return false;
  registry.set(key, now);
  return true;
}

export async function sweepStaleCheckpoints({ git, ownRef = null, ttlMs = DEFAULTS.ttlMs, graceMs = DEFAULTS.gcGraceMs, isTerminal = null, now = () => Date.now(), maxDeletes = 50, maxLookups = 20, remote = 'origin', signal = null }) {
  const ls = await git(['ls-remote', '--refs', remote, `${CHECKPOINT_REF_PREFIX}*`]);
  if (!ok(ls)) return { error: errText(ls), deleted: [] };
  const entries = out(ls).split('\n').filter(Boolean).map((l) => { const [sha, ref] = l.split(/\s+/); return { sha, ref }; }).filter((e) => e.ref && e.ref !== ownRef);
  if (!entries.length) return { scanned: 0, deleted: [] };
  const refs = entries.map((e) => e.ref);
  const local = (r) => `refs/nano-gc/${r.slice(CHECKPOINT_REF_PREFIX.length)}`;
  const fetch = await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, ...refs.map((r) => `+${r}:${local(r)}`)]);
  if (!ok(fetch)) return { error: errText(fetch), deleted: [] };
  const doomed = [];
  let lookups = 0;
  try {
    for (const { ref, sha } of entries) {
      if (doomed.length >= maxDeletes) break;
      // The overall GC deadline (the caller's abort signal) bounds the WHOLE sweep, not
      // just its git ops: each `isTerminal` engine lookup carries its own per-call
      // deadline, so up to `maxLookups` sequential hung lookups could otherwise outlast
      // the overall timeout and keep the awaited `close()` (and the job workspace) alive
      // far past it. Stop scheduling any further lookups/git ops once it fires; unreached
      // refs are reclaimed on a later sweep.
      if (signal?.aborted) break;
      const at = Number(out(await git(['log', '-1', '--format=%ct', local(ref)]))) * 1000;
      if (!Number.isFinite(at) || at <= 0) continue;
      const age = now() - at;
      if (ttlMs > 0 && age > ttlMs) { doomed.push({ ref, sha, why: 'ttl' }); continue; }
      if (isTerminal && age > graceMs && lookups < maxLookups && !signal?.aborted) {
        lookups++;
        let terminal = false;
        try { terminal = await isTerminal(ref.slice(CHECKPOINT_REF_PREFIX.length)); } catch { terminal = false; }
        if (terminal) doomed.push({ ref, sha, why: 'element-terminal' });
      }
    }
    if (!doomed.length) return { scanned: refs.length, deleted: [] };
    // Lease each delete against the SHA we observed at ls-remote time so a newer
    // checkpoint another activation pushed in the meantime is left intact (a lease
    // mismatch skips that one ref rather than race-deleting a live recovery point).
    const deleted = [];
    let lastError = null;
    for (const d of doomed) {
      const r = await deleteCheckpointRef({ git, ref: d.ref, remote, expectSha: d.sha });
      if (r.ok) deleted.push({ ref: d.ref, why: d.why });
      else if (r.error) lastError = r.error;
    }
    const result = { scanned: refs.length, deleted };
    if (!deleted.length && lastError) result.error = lastError;
    return result;
  } finally {
    for (const ref of refs) await git(['update-ref', '-d', local(ref)]);
  }
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
