// Unit tests for issue #293 — the gh auth token cache must not go stale for the
// worker's lifetime: a TTL refresh, invalidation + one retry on a git/gh auth
// failure, fingerprint/scope visibility, and the supervisor `reload-credentials`
// broadcast. All gh/git subprocesses are stubbed (injected `run`/`scopesProbe` /
// the `_runGit` seam), so the suite is hermetic and never touches the host's gh
// login or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  ghAuthTokenFromCli,
  primeGhAuthToken,
  refreshGhAuthToken,
  refreshGhAuthTokenAsync,
  invalidateGhAuthToken,
  recoverGhTokenAfterAuthFailure,
  setGhAuthTokenReader,
  resetGhAuthTokenReader,
  classifyGhAuthRead,
  GH_AUTH_READ_FAILED,
  adoptGhAuthToken,
  adoptGhAuthTokenAsync,
  readGhAuthTokenAsync,
  ghCredentialEnvName,
  applyRotatedGhCredential,
  supervisorStatusSignature,
  reageSupervisorStatus,
  ghAuthTokenInfo,
  describeGhAuthToken,
  ghTokenFingerprint,
  isGitAuthFailure,
  githubCloneToken,
  githubCloneTokenWithSource,
  makeSecretResolver,
  buildActivityPayload,
  summarizeSupervisorWorker,
  supervisorGhAuthCell,
  formatSupervisorStatus,
  provisionRepo,
  finalizeGit,
  startGhAuthTokenRefresh,
  runGit,
  GH_AUTH_TOKEN_TTL_MS,
} from './c8ctl-plugin.js';

// A `run` stub that serves a canned `gh auth token` result, and (for the scopes
// probe) a canned `gh api -i user` header. `calls` records argv so a test can
// assert how many times gh was consulted.
function ghStub({ token = 'gho_testtoken', scopes = 'gist, read:org, repo, workflow', calls = [] } = {}) {
  return (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'auth' && args[1] === 'token') {
      return { status: token ? 0 : 1, stdout: token ? `${token}\n` : '', stderr: '' };
    }
    if (args[0] === 'api') {
      return { status: 0, stdout: `HTTP/2 200\nX-OAuth-Scopes: ${scopes}\n\n{}`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('ghTokenFingerprint is a short non-reversible hash, never the value', () => {
  const fp = ghTokenFingerprint('gho_secret_value_123');
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.notEqual(fp, 'gho_secret_value_123');
  assert.equal(ghTokenFingerprint(''), null);
  assert.equal(ghTokenFingerprint(null), null);
  // Stable + distinct.
  assert.equal(ghTokenFingerprint('gho_secret_value_123'), fp);
  assert.notEqual(ghTokenFingerprint('gho_other'), fp);
});

test('refreshGhAuthToken honours the TTL — a warm cache does not re-spawn gh', () => {
  invalidateGhAuthToken();
  const calls = [];
  const run = ghStub({ token: 'gho_one', calls });
  const first = refreshGhAuthToken({ force: true, run, scopesProbe: () => 'repo' });
  assert.equal(first.token, 'gho_one');
  assert.equal(first.changed, true, 'first populate is a change');
  const afterFirst = calls.filter((c) => c.startsWith('auth token')).length;
  // A second refresh within the TTL is a cache hit — no new gh spawn.
  const second = refreshGhAuthToken({ run, scopesProbe: () => 'repo' });
  assert.equal(second.token, 'gho_one');
  assert.equal(second.changed, false);
  assert.equal(calls.filter((c) => c.startsWith('auth token')).length, afterFirst, 'no re-read inside the TTL');
  invalidateGhAuthToken();
});

test('refreshGhAuthToken reports a token change and re-reads scopes only on change', () => {
  invalidateGhAuthToken();
  const calls = [];
  let token = 'gho_old';
  const run = (cmd, args) => { calls.push(args.join(' ')); return { status: 0, stdout: `${token}\n`, stderr: '' }; };
  let scopeReads = 0;
  const scopesProbe = () => { scopeReads++; return 'repo'; };
  refreshGhAuthToken({ force: true, run, scopesProbe });
  assert.equal(scopeReads, 1, 'scopes read on first populate');
  // Rotate the token, force a re-read → changed, scopes re-read.
  token = 'gho_new';
  const r = refreshGhAuthToken({ force: true, run, scopesProbe });
  assert.equal(r.token, 'gho_new');
  assert.equal(r.changed, true);
  assert.equal(scopeReads, 2, 'scopes re-read when the token value changes');
  // A forced re-read that finds the SAME token is not a change and keeps the
  // prior scopes (no extra ping).
  const r2 = refreshGhAuthToken({ force: true, run, scopesProbe });
  assert.equal(r2.changed, false);
  assert.equal(scopeReads, 2, 'same-token refresh does not re-ping scopes');
  assert.equal(ghAuthTokenInfo().scopes, 'repo');
  invalidateGhAuthToken();
});

test('refreshGhAuthToken re-probes scopes when the cached reading is missing (#293)', () => {
  invalidateGhAuthToken();
  const run = ghStub({ token: 'gho_scope' });
  // First populate: the scopes probe FAILS transiently → scopes cached as null.
  let scopeReads = 0;
  const failingProbe = () => { scopeReads++; return null; };
  refreshGhAuthToken({ force: true, run, scopesProbe: failingProbe });
  assert.equal(scopeReads, 1, 'scopes probed on first populate');
  assert.equal(ghAuthTokenInfo().scopes, null, 'a transient probe failure caches scopes:null');
  // A same-token refresh must RE-PROBE (not carry the null forward forever) so
  // the GH AUTH visibility self-repairs once the probe recovers.
  const healingProbe = () => { scopeReads++; return 'repo, workflow'; };
  const r = refreshGhAuthToken({ force: true, run, scopesProbe: healingProbe });
  assert.equal(r.changed, false, 'same token — not a credential change');
  assert.equal(scopeReads, 2, 're-probed because the cached scope value was missing');
  assert.equal(ghAuthTokenInfo().scopes, 'repo, workflow', 'the healed scopes are now reported');
  // Once a NON-NULL reading is cached, a same-token refresh reuses it (no ping).
  const r2 = refreshGhAuthToken({ force: true, run, scopesProbe: healingProbe });
  assert.equal(r2.changed, false);
  assert.equal(scopeReads, 2, 'a successful cached reading is reused, not re-pinged');
  invalidateGhAuthToken();
});

test('adoptGhAuthTokenAsync re-probes scopes when the cached reading is missing (#293)', async () => {
  invalidateGhAuthToken();
  setGhAuthTokenReader(() => 'gho_async_scope');
  try {
    // Prime with a failing scopes probe → null cached.
    await refreshGhAuthTokenAsync({ force: true, scopesProbe: () => null });
    assert.equal(ghAuthTokenInfo().scopes, null);
    // Same token, probe now heals → must re-probe and record the scopes.
    let reads = 0;
    const r = await adoptGhAuthTokenAsync('gho_async_scope', { scopesProbe: () => { reads++; return 'repo'; } });
    assert.equal(r.changed, false);
    assert.equal(reads, 1, 're-probed on a missing cached scope value');
    assert.equal(ghAuthTokenInfo().scopes, 'repo');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('a same-token scopes self-repair reports snapshotChanged so the marker republishes (#293)', () => {
  invalidateGhAuthToken();
  const run = ghStub({ token: 'gho_snap' });
  // First populate with a failing scopes probe → scopes cached null.
  const first = refreshGhAuthToken({ force: true, run, scopesProbe: () => null });
  assert.equal(first.changed, true, 'first populate is a token change');
  assert.equal(first.snapshotChanged, true, 'first populate always moves the snapshot');
  assert.equal(ghAuthTokenInfo().scopes, null);
  // Same token, probe heals → NOT a token change, but the observable snapshot
  // (scopes null → real) DID move: snapshotChanged must be true so the timer's
  // onChange/log fires and an idle worker stops reporting `?` scopes forever.
  // Gating republishing on `changed` alone (the pre-fix bug) would skip this.
  const healed = refreshGhAuthToken({ force: true, run, scopesProbe: () => 'repo, workflow' });
  assert.equal(healed.changed, false, 'token value unchanged');
  assert.equal(healed.snapshotChanged, true, 'a scopes self-repair moves the observable snapshot');
  assert.equal(ghAuthTokenInfo().scopes, 'repo, workflow');
  // A subsequent same-token, same-scopes refresh is a genuine no-op on both axes.
  const quiet = refreshGhAuthToken({ force: true, run, scopesProbe: () => 'repo, workflow' });
  assert.equal(quiet.changed, false);
  assert.equal(quiet.snapshotChanged, false, 'no token/scope movement → nothing to republish');
  invalidateGhAuthToken();
});

test('adoptGhAuthTokenAsync reports snapshotChanged on a same-token scopes self-repair (#293)', async () => {
  invalidateGhAuthToken();
  setGhAuthTokenReader(() => 'gho_async_snap');
  try {
    await refreshGhAuthTokenAsync({ force: true, scopesProbe: () => null });
    assert.equal(ghAuthTokenInfo().scopes, null);
    const r = await adoptGhAuthTokenAsync('gho_async_snap', { scopesProbe: () => 'repo' });
    assert.equal(r.changed, false, 'same token — not a credential change');
    assert.equal(r.snapshotChanged, true, 'the healed scopes moved the observable snapshot');
    const r2 = await adoptGhAuthTokenAsync('gho_async_snap', { scopesProbe: () => 'repo' });
    assert.equal(r2.snapshotChanged, false, 'a steady-state re-adopt is a no-op on both axes');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('ghAuthTokenInfo exposes fingerprint/scopes/age but never the token value', () => {
  invalidateGhAuthToken();
  const run = ghStub({ token: 'gho_visible' });
  refreshGhAuthToken({ force: true, run, scopesProbe: () => 'repo, workflow' });
  const info = ghAuthTokenInfo();
  assert.equal(info.present, true);
  assert.match(info.fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(info.scopes, 'repo, workflow');
  assert.ok(Number.isFinite(info.ageMs) && info.ageMs >= 0);
  assert.ok(Number.isFinite(info.lastCheckAgoMs) && info.lastCheckAgoMs >= 0);
  assert.ok(!('token' in info), 'no token field on the public snapshot');
  assert.equal(JSON.stringify(info).includes('gho_visible'), false, 'the token value never leaks into the snapshot');
  invalidateGhAuthToken();
  assert.equal(ghAuthTokenInfo(), null, 'an invalidated cache reports null until re-primed');
});

test('invalidateGhAuthToken forces the next lookup to re-read the CLI', () => {
  invalidateGhAuthToken();
  const calls = [];
  let token = 'gho_first';
  const run = (cmd, args) => { calls.push(args.join(' ')); return { status: 0, stdout: `${token}\n`, stderr: '' }; };
  assert.equal(refreshGhAuthToken({ force: true, run, scopesProbe: () => null }).token, 'gho_first');
  token = 'gho_second';
  invalidateGhAuthToken();
  assert.equal(refreshGhAuthToken({ force: true, run, scopesProbe: () => null }).token, 'gho_second', 'post-invalidation read sees the rotated token');
  invalidateGhAuthToken();
});

test('describeGhAuthToken renders a token-free one-liner', () => {
  invalidateGhAuthToken();
  assert.match(describeGhAuthToken(null), /not yet read/);
  const run = ghStub({ token: 'gho_desc' });
  refreshGhAuthToken({ force: true, run, scopesProbe: () => 'repo' });
  const line = describeGhAuthToken(ghAuthTokenInfo());
  assert.match(line, /fingerprint [0-9a-f]{12}/);
  assert.match(line, /scopes: repo/);
  assert.ok(!line.includes('gho_desc'), 'the token value is never rendered');
  invalidateGhAuthToken();
});

test('primeGhAuthToken logs the fingerprint + scopes on populate and on change only', () => {
  invalidateGhAuthToken();
  // Drive the module cache through the reader seam so the exported prime path
  // (which refreshes through the MODULE reader, not a per-call run) is exercised.
  let served = 'gho_a';
  setGhAuthTokenReader(() => served);
  try {
    const logs = [];
    const logger = { info: (m) => logs.push(m) };
    assert.equal(primeGhAuthToken({ logger }), true);
    assert.equal(logs.length, 1, 'the first populate logs the fingerprint line');
    assert.match(logs[0], /fingerprint [0-9a-f]{12}/);
    assert.ok(!logs[0].includes('gho_a'), 'the token value is never logged');
    // A warm-cache prime (same token, within TTL) does NOT re-log.
    primeGhAuthToken({ logger });
    assert.equal(logs.length, 1, 'an unchanged token does not re-log');
    // A rotation logs again.
    served = 'gho_b';
    invalidateGhAuthToken();
    primeGhAuthToken({ logger });
    assert.equal(logs.length, 2, 'a token change logs the new fingerprint');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('isGitAuthFailure matches auth/scope failures, not ordinary git failures', () => {
  // The issue's exact escalation.
  assert.equal(isGitAuthFailure('remote: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope'), true);
  assert.equal(isGitAuthFailure('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), true);
  assert.equal(isGitAuthFailure('fatal: Authentication failed for \'https://github.com/o/r.git/\''), true);
  assert.equal(isGitAuthFailure('remote: Permission to o/r.git denied to bot.'), true);
  assert.equal(isGitAuthFailure('HTTP 401 Unauthorized'), true);
  // Standard git HTTPS smart-transport rejection form (what the git CLI prints,
  // and the exact shape agent-checkpoint.test.mjs uses as an auth example).
  assert.equal(isGitAuthFailure('fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403'), true);
  assert.equal(isGitAuthFailure('fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 401'), true);
  assert.equal(isGitAuthFailure('{"message":"Bad credentials"}'), true);
  assert.equal(isGitAuthFailure('{"message":"Resource not accessible by personal access token"}'), true);
  // NOT auth failures — must not trigger a token drop + retry.
  assert.equal(isGitAuthFailure('error: failed to push some refs (non-fast-forward)'), false);
  assert.equal(isGitAuthFailure('fatal: repository \'https://github.com/o/missing\' not found (404)'), false);
  // A 404 in the same transport form is NOT an auth failure (fail-closed boundary).
  assert.equal(isGitAuthFailure('fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 404'), false);
  assert.equal(isGitAuthFailure('git push timed out after 30s (SIGTERM)'), false);
  assert.equal(isGitAuthFailure(''), false);
  assert.equal(isGitAuthFailure(null), false);
});

test('buildActivityPayload carries the ghAuth identity (never the token)', () => {
  const ghAuth = { present: true, fingerprint: 'ab12cd34ef56', scopes: 'repo', since: 1000, ageMs: 5000, lastCheckAgoMs: 1000 };
  const p = buildActivityPayload({ pid: 123, updatedAt: 6000, jobs: [], engine: null, agentic: { status: 'off' }, readyAt: 1, ghAuth });
  assert.deepEqual(p.ghAuth, ghAuth);
  assert.equal(JSON.stringify(p).includes('gho_'), false);
  // Absent → null (an older worker / not yet primed).
  const bare = buildActivityPayload({ pid: 1, updatedAt: 1, jobs: [], engine: null, agentic: { status: 'off' } });
  assert.equal(bare.ghAuth, null);
});

test('summarizeSupervisorWorker surfaces + re-ages the ghAuth marker field', () => {
  const now = Date.now();
  const w = {
    id: 'w1', profile: 'p', pid: process.pid, state: 'running', restarts: 0,
    startedAt: new Date(now - 60_000).toISOString(),
  };
  // No activity marker → ghAuth null, cell '?'.
  const bare = summarizeSupervisorWorker(w, now);
  assert.equal(bare.ghAuth, null);
  assert.equal(supervisorGhAuthCell(bare), '?');
});

test('supervisorGhAuthCell renders age + scopes, never the token', () => {
  const running = (ghAuth) => ({ state: 'running', activity: { state: 'idle', jobs: [] }, ghAuth });
  assert.equal(supervisorGhAuthCell({ state: 'down', activity: null, ghAuth: null }), '-');
  assert.equal(supervisorGhAuthCell({ state: 'running', activity: null, ghAuth: null }), '?');
  assert.equal(supervisorGhAuthCell(running(null)), '?');
  assert.equal(supervisorGhAuthCell(running({ present: false })), 'none');
  const cell = supervisorGhAuthCell(running({ present: true, fingerprint: 'ab12cd34ef56', scopes: 'gist, read:org, repo, workflow', ageMs: 130_000 }));
  assert.match(cell, /^2m10s \[gist,read:org,repo,workflow\]$/, cell);
  assert.ok(!cell.includes('ab12cd34ef56'), 'the fingerprint stays out of the narrow table cell');
  // Missing scopes → '?' placeholder rather than a crash.
  assert.match(supervisorGhAuthCell(running({ present: true, ageMs: 5000 })), /^5s \[.\]$/);
});

test('formatSupervisorStatus includes a GH AUTH column', () => {
  const now = Date.now();
  const status = {
    daemon: { pid: process.pid, version: '1.0.0', startedAt: new Date(now - 60_000).toISOString(), socket: '/tmp/s' },
    workers: [{
      id: 'w1', profile: 'coder', pid: process.pid, state: 'running', restarts: 0,
      uptimeMs: 60_000, startedAtMs: now - 60_000, lastExit: null, args: [], logFile: null,
      activity: { state: 'idle', jobs: [] }, engine: 'http://localhost:8080', agentic: { status: 'connected' },
      ghAuth: { present: true, fingerprint: 'ab12cd34ef56', scopes: 'repo, workflow', ageMs: 65_000, lastCheckAgoMs: 5000 },
    }],
  };
  const text = formatSupervisorStatus(status);
  assert.match(text, /GH AUTH/);
  assert.match(text, /1m5s \[repo,workflow\]/);
  assert.equal(text.includes('ab12cd34ef56'), false, 'no fingerprint in the table');
});

test('githubCloneToken still prefers the env GITHUB_TOKEN over the gh fallback', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-token';
  try {
    // The gh fallback must not be consulted when the env var is set.
    const tok = githubCloneToken({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => { throw new Error('must not be called'); } });
    assert.equal(tok, 'env-token');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

// --- #293 review: credential SOURCE governs the gh-token fallback retry ------

test('githubCloneTokenWithSource reports the credential source', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  try {
    // env GITHUB_TOKEN → 'env' (gh fallback not consulted).
    process.env.GITHUB_TOKEN = 'env-token';
    let r = githubCloneTokenWithSource({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { token: 'env-token', source: 'env' });
    // No env token, default authRef → the gh cache fallback → 'gh-cache'.
    delete process.env.GITHUB_TOKEN;
    r = githubCloneTokenWithSource({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => 'gho_cached' });
    assert.deepEqual(r, { token: 'gho_cached', source: 'gh-cache' });
    // No env token AND no gh token → a default gh-cache MISS. The source stays
    // 'gh-cache' (token null) so the clone/push auth-failure recovery remains
    // eligible and can still self-heal after `gh auth login` (Copilot review on
    // #293) — it is NOT 'none' (which would make the guards ineligible).
    r = githubCloneTokenWithSource({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => null });
    assert.deepEqual(r, { token: null, source: 'gh-cache' });
    // A custom authRef resolves strictly from the secret resolver → 'custom'.
    process.env.MY_TOKEN = 'custom-tok';
    r = githubCloneTokenWithSource({ provider: 'github', authRef: 'MY_TOKEN', secretResolver: resolver, ghAuthToken: () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { token: 'custom-tok', source: 'custom' });
    // A blank authRef is a misconfiguration → no token, never the gh fallback.
    r = githubCloneTokenWithSource({ provider: 'github', authRef: '   ', secretResolver: resolver, ghAuthToken: () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { token: null, source: 'none' });
    // A non-github provider with no custom ref never borrows the gh login → 'none'.
    r = githubCloneTokenWithSource({ provider: 'gitlab', authRef: undefined, secretResolver: resolver, ghAuthToken: () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { token: null, source: 'none' });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
    delete process.env.MY_TOKEN;
  }
});

test('GH_AUTH_TOKEN_TTL_MS is a positive, bounded default', () => {
  assert.ok(Number.isFinite(GH_AUTH_TOKEN_TTL_MS) && GH_AUTH_TOKEN_TTL_MS >= 0);
});

// --- #293: clone auth-failure invalidation + one fresh-token retry -----------

const gitAvailable = (() => {
  try { return spawnSync('git', ['--version'], { timeout: 10_000 }).status === 0; } catch { return false; }
})();

function makeLocalOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'nano-293-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const run = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  };
  run(['init', '--bare', '-q', origin], undefined);
  run(['init', '-q', seed], undefined);
  run(['config', 'user.name', 'seed'], seed);
  run(['config', 'user.email', 'seed@example.com'], seed);
  writeFileSync(join(seed, 'README.md'), 'x\n');
  run(['add', '-A'], seed);
  run(['commit', '-q', '-m', 'init'], seed);
  run(['push', '-q', `file://${origin}`, 'HEAD:main'], seed);
  return { root, origin: `file://${origin}` };
}

test('provisionRepo retries the clone once with a fresh token on an auth failure (#293)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // The module cache holds the STALE token; the gh login has since been
    // refreshed, so the next forced re-read returns the ROTATED token. The
    // reader seam models exactly that: first serve stale, then fresh.
    let served = 'gho_stale';
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // cache ← 'gho_stale'
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_stale'));

    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        if (cloneAttempts === 1) {
          // First attempt: an auth rejection (the stale token's denial).
          return { status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
        }
        // The retry must run with the ROTATED token in GIT_TOKEN (the askpass
        // hands it to git) — proving the cache was dropped + re-read.
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_fresh', 'the retry runs with the rotated token');
      }
      return runGit(args, opts);
    };
    // Rotate the login BEFORE the job's clone fails (the operator re-logged in
    // after this worker primed). The clone's invalidation + forced refresh then
    // picks up the fresh token. `credentialSource: 'gh-cache'` marks the token
    // as cache-derived, which is what permits the gh-token fallback retry.
    served = 'gho_fresh';
    const prov = provisionRepo({ envelope, token: 'gho_stale', runDir, credentialSource: 'gh-cache', _runGit: seam });
    assert.equal(cloneAttempts, 2, 'the clone was retried once after the auth failure');
    assert.ok(prov.workspaceDir, 'the retry produced a workspace');
    // The cache now holds the rotated token, and the returned provisioning
    // carries the EFFECTIVE (rotated) credential so the caller doesn't keep
    // using the stale one (Copilot review on #293).
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_fresh'));
    assert.equal(prov.effectiveToken, 'gho_fresh', 'the rotated token is propagated to the caller');
    assert.equal(prov.credentialSource, 'gh-cache');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo recovers a default gh-cache MISS (null → fresh token) on an auth failure (#293)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // The worker cached "logged out" (no token) at prime time; the operator has
    // since run `gh auth login`, so the forced re-read after the auth failure
    // returns a FRESH token. Reader seam: null first, then fresh.
    let served = null;
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // cache ← null (logged out)
    assert.equal(ghAuthTokenInfo().present, false);

    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        if (cloneAttempts === 1) {
          // First attempt (anonymous, no token): an auth rejection.
          return { status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
        }
        // The null→fresh recovery must REBUILD the credential plumbing the
        // anonymous path omitted: GIT_TOKEN + a GIT_ASKPASS helper, global git
        // config restored, and the remote re-anchored through authUrl. (The
        // local origin is a file:// URL, which authUrl deliberately leaves
        // username-less — the username embed only applies to https remotes.)
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_fresh', 'the retry runs with the recovered token');
        assert.ok(opts?.env?.GIT_ASKPASS, 'an askpass helper was minted for the fresh token');
        assert.equal(opts?.env?.GIT_CONFIG_GLOBAL, undefined, 'global git config is restored once a token exists');
      }
      return runGit(args, opts);
    };
    // The job resolves NO token (gh-cache MISS) but the source is 'gh-cache', so
    // the auth-failure recovery is eligible and self-heals null → fresh.
    served = 'gho_fresh';
    const prov = provisionRepo({ envelope, token: null, runDir, credentialSource: 'gh-cache', _runGit: seam });
    assert.equal(cloneAttempts, 2, 'the clone was retried once after the auth failure');
    assert.ok(prov.workspaceDir, 'the retry produced a workspace');
    assert.equal(prov.effectiveToken, 'gho_fresh', 'the recovered token is propagated to the caller');
    assert.equal(prov.credentialSource, 'gh-cache');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo does NOT retry when the re-read token is unchanged (#293)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // The re-read returns the SAME token (a genuine permission denial, not a
    // stale cache) — a retry can't help, so it must not fire. (gh-cache source
    // so only the unchanged-token guard is exercised.)
    setGhAuthTokenReader(() => 'gho_same');
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });
    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone') && cloneAttempts++ === 0) {
        return { status: 128, stdout: '', stderr: 'remote: Permission to o/r.git denied to bot.', signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    assert.throws(() => provisionRepo({ envelope, token: 'gho_same', runDir, credentialSource: 'gh-cache', _runGit: seam }), /git clone failed/);
    assert.equal(cloneAttempts, 1, 'no retry when the token did not change');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo does NOT retry a non-auth clone failure (#293)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        // A NON-auth failure (e.g. repo not found) must not trigger a token retry.
        return { status: 128, stdout: '', stderr: 'fatal: repository not found (404)', signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    assert.throws(() => provisionRepo({ envelope, token: 'gho_stale', runDir, _runGit: seam }), /git clone failed/);
    assert.equal(cloneAttempts, 1, 'no retry on a non-auth failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #294 review: the auth-failure re-read is NON-DESTRUCTIVE -----------------
// recoverGhTokenAfterAuthFailure must NOT invalidate the cache before the forced
// re-read: an invalidate-first + a transiently-failing re-read would erase a
// still-valid (possibly newer) cached credential and leave the worker "logged
// out". It forces a fresh read and returns it only when it DIFFERS from the
// token that failed.

test('recoverGhTokenAfterAuthFailure returns a rotated token and retries on it (#294)', () => {
  invalidateGhAuthToken();
  try {
    setGhAuthTokenReader(() => 'gho_stale');
    refreshGhAuthToken({ force: true });             // cache ← gho_stale
    setGhAuthTokenReader(() => 'gho_rotated');       // operator re-logged in
    const fresh = recoverGhTokenAfterAuthFailure('gho_stale');
    assert.equal(fresh, 'gho_rotated', 'the rotated token is returned for the retry');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_rotated'));
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('recoverGhTokenAfterAuthFailure does not retry on a genuine denial (same token) (#294)', () => {
  invalidateGhAuthToken();
  try {
    setGhAuthTokenReader(() => 'gho_same');
    refreshGhAuthToken({ force: true });             // cache ← gho_same
    // The re-read returns the SAME failing token — a retry can't fix a real
    // permission denial, so recovery declines (null).
    assert.equal(recoverGhTokenAfterAuthFailure('gho_same'), null, 'same token → no retry');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_same'), 'cache intact');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('recoverGhTokenAfterAuthFailure preserves a NEWER cached token when the re-read fails transiently (#294)', () => {
  invalidateGhAuthToken();
  try {
    // A reload-credentials swap landed mid-job: the cache now holds gho_newer,
    // but the job captured the older gho_old before the swap and it just failed.
    setGhAuthTokenReader(() => 'gho_newer');
    refreshGhAuthToken({ force: true });             // cache ← gho_newer
    // The forced recovery re-read now hits a TRANSIENT failure (gh momentarily
    // unavailable). It must NOT erase gho_newer — it preserves it and (because
    // gho_newer differs from the failing gho_old) retries on it.
    setGhAuthTokenReader(() => GH_AUTH_READ_FAILED);
    const fresh = recoverGhTokenAfterAuthFailure('gho_old');
    assert.equal(fresh, 'gho_newer', 'the preserved newer token drives the retry');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_newer'), 'the newer cached token was NOT erased by the transient re-read');
    assert.equal(ghAuthTokenInfo().present, true, 'the worker is not left logged out');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('recoverGhTokenAfterAuthFailure recovers a logged-out cache (null → fresh) (#294)', () => {
  invalidateGhAuthToken();
  try {
    setGhAuthTokenReader(() => null);
    refreshGhAuthToken({ force: true });             // cache ← null (logged out)
    assert.equal(ghAuthTokenInfo().present, false);
    setGhAuthTokenReader(() => 'gho_fresh');         // operator ran `gh auth login`
    assert.equal(recoverGhTokenAfterAuthFailure(null), 'gho_fresh', 'null → fresh recovers');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('provisionRepo retries the clone on a NEWER cached token when the recovery re-read fails transiently (#294)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // A reload-credentials swap put gho_newer in the cache after this job had
    // already captured the older gho_old. The clone fails on gho_old, and the
    // forced recovery re-read then fails TRANSIENTLY. The old invalidate-first
    // code would erase gho_newer and leave the cache null (no retry, job shed);
    // the non-destructive recovery preserves gho_newer and retries on it.
    setGhAuthTokenReader(() => 'gho_newer');
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });            // cache ← gho_newer
    setGhAuthTokenReader(() => GH_AUTH_READ_FAILED); // recovery re-read is transiently broken

    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        if (cloneAttempts === 1) {
          return { status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
        }
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_newer', 'the retry runs with the preserved newer token');
      }
      return runGit(args, opts);
    };
    const prov = provisionRepo({ envelope, token: 'gho_old', runDir, credentialSource: 'gh-cache', _runGit: seam });
    assert.equal(cloneAttempts, 2, 'the clone was retried once on the preserved newer token');
    assert.ok(prov.workspaceDir, 'the retry produced a workspace');
    assert.equal(prov.effectiveToken, 'gho_newer', 'the newer token is propagated to the caller');
    // The transient re-read must NOT have erased the cached credential.
    assert.equal(ghAuthTokenInfo().present, true, 'cache not erased by the transient re-read');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_newer'));
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});


// next tick and closes with the given code, so the async gh readers can be
// driven deterministically without spawning a real process.
function fakeChild({ stdout = '', stderr = '', code = 0, emitError = null } = {}) {
  const handlers = { stdout: [], stderr: [], error: [], close: [] };
  const child = {
    stdout: { on: (ev, fn) => { if (ev === 'data') handlers.stdout.push(fn); } },
    stderr: { on: (ev, fn) => { if (ev === 'data') handlers.stderr.push(fn); } },
    on: (ev, fn) => { if (handlers[ev]) handlers[ev].push(fn); },
    kill: () => {},
  };
  queueMicrotask(() => {
    for (const fn of handlers.stdout) fn(Buffer.from(stdout));
    if (stderr) for (const fn of handlers.stderr) fn(Buffer.from(stderr));
    if (emitError) { for (const fn of handlers.error) fn(emitError); return; }
    for (const fn of handlers.close) fn(code);
  });
  return child;
}

// A fake child whose completion is GATED: it stays open (keeping the async
// refresh — and thus `ghAuthRefreshInFlight` — in flight) until the `arm`
// callback hands back a `release(token)` that the test calls to emit the token
// and close with exit 0. Used to hold a refresh mid-read while asserting that
// the synchronous per-job path does NOT start its own blocking re-read.
function pendingChild(arm) {
  const handlers = { stdout: [], stderr: [], error: [], close: [] };
  const child = {
    stdout: { on: (ev, fn) => { if (ev === 'data') handlers.stdout.push(fn); } },
    stderr: { on: (ev, fn) => { if (ev === 'data') handlers.stderr.push(fn); } },
    on: (ev, fn) => { if (handlers[ev]) handlers[ev].push(fn); },
    kill: () => {},
  };
  arm((token) => {
    queueMicrotask(() => {
      for (const fn of handlers.stdout) fn(Buffer.from(`${token}\n`));
      for (const fn of handlers.close) fn(0);
    });
  });
  return child;
}

test('refreshGhAuthTokenAsync reads the token via spawn and folds it into the cache', async () => {
  invalidateGhAuthToken();
  const spawns = [];
  const _spawn = (cmd, args) => {
    spawns.push(args.join(' '));
    if (args[0] === 'auth' && args[1] === 'token') return fakeChild({ stdout: 'gho_async\n', code: 0 });
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  const r = await refreshGhAuthTokenAsync({ force: true, _spawn });
  assert.equal(r.token, 'gho_async');
  assert.equal(r.changed, true);
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_async'));
  assert.equal(ghAuthTokenInfo().scopes, 'repo', 'the async scopes probe populated scopes');
  assert.ok(spawns.some((c) => c.startsWith('auth token')), 'gh auth token was spawned');
  assert.ok(spawns.some((c) => c.startsWith('api')), 'the scopes probe was spawned');
  invalidateGhAuthToken();
});

test('refreshGhAuthTokenAsync honours the module reader seam (no spawn in tests)', async () => {
  invalidateGhAuthToken();
  setGhAuthTokenReader(() => 'gho_seam');
  try {
    const _spawn = () => { throw new Error('must not spawn when a reader is installed'); };
    const r = await refreshGhAuthTokenAsync({ force: true, _spawn });
    assert.equal(r.token, 'gho_seam');
    assert.equal(r.changed, true);
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('startGhAuthTokenRefresh defers while a job is active and refreshes when idle', async () => {
  invalidateGhAuthToken();
  let served = 'gho_one';
  setGhAuthTokenReader(() => served);
  try {
    let idle = false;
    let changes = 0;
    const logs = [];
    // intervalMs 0 → clamped to the 1000ms floor, so ticks fire ~1s apart.
    const t = startGhAuthTokenRefresh({
      logger: { info: (m) => logs.push(m) },
      intervalMs: 0,
      isIdle: () => idle,
      onChange: () => { changes++; },
    });
    try {
      // Rotate the login, then let several ticks fire while BUSY: no refresh.
      // (The cache starts UNSET — a busy tick must NOT populate it either, since
      // the whole point is that no gh read happens while a job is active.)
      served = 'gho_two';
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(ghAuthTokenInfo(), null, 'no refresh while a job is active');
      assert.equal(changes, 0, 'onChange not fired while busy');
      // Now go idle: the next tick adopts the token and republishes.
      idle = true;
      await new Promise((r) => setTimeout(r, 1600));
      assert.equal(ghAuthTokenInfo()?.fingerprint, ghTokenFingerprint('gho_two'), 'the idle tick adopted the token');
      assert.equal(changes, 1, 'onChange fired exactly once on the identity change');
      assert.ok(logs.some((l) => /fingerprint [0-9a-f]{12}/.test(l)), 'the change was logged');
    } finally {
      t.stop();
    }
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('startGhAuthTokenRefresh BOUNDS the busy defer: a primed cache stale beyond maxStaleMs refreshes even while a job is active (#294 review)', () => {
  // Under SUSTAINED saturation the worker is never idle at a tick, so an
  // unbounded isIdle defer would serve an expired non-null cache to every
  // subsequent job for the worker's whole busy lifetime (Copilot review on #294).
  // The bound makes the tick refresh anyway once the PRIMED cache is stale past
  // maxStaleMs — still async, never blocking. Driven in a CHILD with a tiny TTL
  // so the inner (non-forced) re-read isn't short-circuited by the module TTL.
  const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
  const script = `
    import { setGhAuthTokenReader, invalidateGhAuthToken, refreshGhAuthToken, startGhAuthTokenRefresh, ghAuthTokenInfo, ghTokenFingerprint } from ${JSON.stringify(pluginUrl)};
    (async () => {
      let served = 'gho_one';
      let reads = 0;
      setGhAuthTokenReader(() => { reads++; return served; });
      invalidateGhAuthToken();
      refreshGhAuthToken({ force: true }); // prime (read #1)
      const afterPrime = reads;
      served = 'gho_two'; // the login rotated; a refresh must pick this up
      // ALWAYS busy; a tiny maxStaleMs so the primed cache is immediately "stale
      // beyond bound". intervalMs 0 -> clamped to the 1s floor.
      const t = startGhAuthTokenRefresh({ intervalMs: 0, isIdle: () => false, maxStaleMs: 1 });
      await new Promise((r) => setTimeout(r, 2600));
      t.stop();
      if (reads <= afterPrime) { console.error('busy tick never refreshed past the bound:', reads, afterPrime); process.exit(2); }
      const fp = ghAuthTokenInfo()?.fingerprint;
      if (fp !== ghTokenFingerprint('gho_two')) { console.error('bounded refresh did not adopt the rotated token:', fp); process.exit(3); }
      process.exit(0);
    })();
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NANO_GH_TOKEN_TTL_MS: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child asserted the bounded-defer contract: stdout=${r.stdout} stderr=${r.stderr}`);
});

test('startGhAuthTokenRefresh still DEFERS a within-bound primed cache while a job is active (#294 review)', async () => {
  // The bound must not over-trigger: a PRIMED cache that is NOT yet stale beyond
  // maxStaleMs still defers while busy (no mid-job gh read), exactly as before.
  invalidateGhAuthToken();
  let served = 'gho_fresh';
  setGhAuthTokenReader(() => served);
  try {
    refreshGhAuthToken({ force: true }); // prime
    const before = ghAuthTokenInfo().fingerprint;
    served = 'gho_rotated'; // would be adopted ONLY if the tick refreshed
    // Busy, but a HUGE maxStaleMs so the bound never fires: the tick defers as
    // before and the rotated token is NOT adopted while busy.
    const t = startGhAuthTokenRefresh({ intervalMs: 0, isIdle: () => false, maxStaleMs: 60 * 60 * 1000 });
    try {
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(ghAuthTokenInfo().fingerprint, before, 'a within-bound primed cache is not refreshed while busy');
    } finally {
      t.stop();
    }
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('startGhAuthTokenRefresh never overlaps ticks and swallows a tick failure', async () => {
  invalidateGhAuthToken();
  // A reader that throws models a wedged gh; the tick must swallow it and the
  // interval must keep firing (no unhandled rejection, no crash).
  setGhAuthTokenReader(() => { throw new Error('gh wedged'); });
  try {
    const t = startGhAuthTokenRefresh({ intervalMs: 1000 });
    try {
      await new Promise((r) => setTimeout(r, 2600));
      // Reaching here without an unhandled rejection is the assertion.
      assert.ok(true);
    } finally {
      t.stop();
    }
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('startGhAuthTokenRefresh unrefs the maintenance timer so a dead worker can exit (#293 review)', () => {
  // The credential refresh is a background maintenance timer, NOT a serving
  // handle: a REF'd timer would keep the PID alive after the worker runtime has
  // died, masking the dead worker so the daemon never restarts it. It must be
  // unref'd (Node's hasRef() reports the ref state) — unlike the serving --auto
  // poll timer, which stays ref'd.
  const t = startGhAuthTokenRefresh({ intervalMs: 1000 });
  try {
    assert.equal(typeof t.hasRef, 'function', 'the handle should be a real Node Timeout');
    assert.equal(t.hasRef(), false, 'the maintenance refresh timer must be unref\'d');
  } finally {
    t.stop();
  }
});

test('provisionRepo does NOT retry an auth failure for a non-gh-cache credential (#293 review)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // An EXPLICIT GITHUB_TOKEN ('env' source) fails with an auth error: the
    // fallback must NOT silently swap in the operator's gh token.
    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        return { status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    assert.throws(() => provisionRepo({ envelope, token: 'explicit-env-token', runDir, credentialSource: 'env', _runGit: seam }), /git clone failed/);
    assert.equal(cloneAttempts, 1, 'no gh-token retry for an env-sourced credential');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo does NOT retry a gh-cache MISS when the re-read is still logged out (#293)', { skip: !gitAvailable }, () => {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
      branch: { base: 'main', create: 'feat/x', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    // The worker cached "logged out" AND the forced re-read STILL finds no token
    // (the operator has not run `gh auth login`). There is nothing to recover —
    // the clone must fail WITHOUT a retry (a null → null read is not a change).
    setGhAuthTokenReader(() => null);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // cache ← null
    let cloneAttempts = 0;
    const seam = (args, opts) => {
      if (args.includes('clone')) {
        cloneAttempts++;
        return { status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    assert.throws(() => provisionRepo({ envelope, token: null, runDir, credentialSource: 'gh-cache', _runGit: seam }), /git clone failed/);
    assert.equal(cloneAttempts, 1, 'no retry when the forced re-read still finds no token');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

// NOTE: finalizeGit's push-retry shares the SAME source gate
// (`credentialSource === 'gh-cache'`) as provisionRepo's clone-retry above; its
// push + retry now run through the `_pushGit` seam (parallel to the `_runGit`
// late-scan seam), so the central recovery branches are exercised hermetically
// by the four `finalizeGit` tests at the end of this file.

test('an in-flight async refresh suppresses the synchronous per-job re-read (#293 review)', async () => {
  invalidateGhAuthToken();
  // Prime the cache with a known token (sync reader), then DROP the reader so the
  // async refresh goes through the SPAWN path — the only path with an in-flight
  // window — and so the per-job lookup has no reader to fall back on either (its
  // only non-cache source would be a real blocking `gh` spawnSync, which the
  // in-flight guard must prevent).
  setGhAuthTokenReader(() => 'gho_cached');
  refreshGhAuthToken({ force: true });
  resetGhAuthTokenReader();
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_cached'));

  // A gated `gh auth token` child holds the async refresh (and thus
  // ghAuthRefreshInFlight) open until we release it.
  let releaseAuth;
  const gatedAuth = pendingChild((release) => { releaseAuth = release; });
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') return gatedAuth;
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  // Kick off (do NOT await) the async refresh: its synchronous prologue sets
  // ghAuthRefreshInFlight before suspending on the gated read.
  const p = refreshGhAuthTokenAsync({ force: true, _spawn });
  // While the read is still in flight, the synchronous per-job lookup must hand
  // out the CACHED token WITHOUT a blocking re-read (Copilot review on #293:
  // a job activated during the async refresh must not degrade into spawnSync).
  assert.equal(ghAuthTokenFromCli(), 'gho_cached', 'the per-job path served the cache, not a fresh blocking read');
  // Release the gh read with a ROTATED token; the async refresh adopts it.
  releaseAuth('gho_rotated');
  await p;
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_rotated'), 'the async refresh adopted the rotated token once settled');
  invalidateGhAuthToken();
});

test('ghAuthTokenFromCli serves a PRIMED cache without a blocking re-read even past the TTL (#293 review)', () => {
  // The warm-cache per-job hot path must NEVER run `spawnSync('gh auth token')`
  // + the synchronous scopes probe when the cache is already primed — not even
  // once its TTL has lapsed (a timer tick deferred while a job was active). A
  // deferred tick + a job arriving before the next idle tick is exactly the 15s
  // event-loop/lease stall the fix removes. Drive it in a CHILD with TTL=0 (so a
  // pre-fix build re-reads on every lookup): prime with one token, rotate the
  // reader's answer, then prove the per-job lookup still hands out the PRIMED
  // token and never consults the reader again.
  const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
  const script = `
    import { setGhAuthTokenReader, invalidateGhAuthToken, refreshGhAuthToken, ghAuthTokenFromCli } from ${JSON.stringify(pluginUrl)};
    let served = 'gho_primed';
    let reads = 0;
    setGhAuthTokenReader(() => { reads++; return served; });
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // prime (read #1)
    const afterPrime = reads;
    served = 'gho_rotated'; // the reader would now answer differently if consulted
    const a = ghAuthTokenFromCli();
    const b = ghAuthTokenFromCli();
    if (a !== 'gho_primed' || b !== 'gho_primed') { console.error('hot path did not serve the cache:', a, b); process.exit(2); }
    if (reads !== afterPrime) { console.error('hot path re-read gh:', reads, 'vs', afterPrime); process.exit(3); }
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NANO_GH_TOKEN_TTL_MS: '0' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child asserted the hot-path contract: stdout=${r.stdout} stderr=${r.stderr}`);
});

test('a forced async refresh performs a FRESH read after awaiting an in-flight one (#293 review)', async () => {
  // reload-credentials (SIGUSR1) fires a FORCED refresh while a periodic refresh
  // is already in flight. The in-flight read may have captured the OLD token
  // microseconds before the operator ran `gh auth refresh`; a forced caller that
  // merely awaited and returned it would report "reloaded" while caching the
  // stale credential. So after awaiting the in-flight read, a forced caller must
  // start ONE new forced read that reflects the post-signal state.
  invalidateGhAuthToken();
  let authReads = 0;
  let releaseAuth;
  const gatedAuth = pendingChild((release) => { releaseAuth = release; });
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') {
      authReads++;
      // First read is gated (the in-flight periodic refresh, capturing the OLD
      // token); the forced caller's fresh read sees the ROTATED token.
      return authReads === 1 ? gatedAuth : fakeChild({ stdout: 'gho_rotated\n', code: 0 });
    }
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  const inflight = refreshGhAuthTokenAsync({ _spawn });              // periodic (non-forced), gated
  const forced = refreshGhAuthTokenAsync({ force: true, _spawn });   // SIGUSR1: awaits, then re-reads
  releaseAuth('gho_old');                                           // the in-flight read completes with the OLD token
  const [, r] = await Promise.all([inflight, forced]);
  assert.equal(authReads, 2, 'the forced caller performed its OWN fresh read after the in-flight one settled');
  assert.equal(r.token, 'gho_rotated');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_rotated'), 'the reload reflects the rotation that landed after the in-flight read started');
  invalidateGhAuthToken();
});

test('concurrent forced async refreshes serialize — no overlapping reads clobber the in-flight marker (#293 review)', async () => {
  // Two forced callers (e.g. two reload-credentials SIGUSR1 signals) can both
  // await the SAME in-flight periodic refresh. They must NOT fall through together
  // and start overlapping reads: the first to settle would clear ghAuthRefreshInFlight
  // while the other read is still active, re-opening the blocking synchronous hot-path
  // read the marker exists to suppress. Re-checking the marker in a loop keeps at
  // most ONE forced read active at a time, so the reads run strictly sequentially.
  invalidateGhAuthToken();
  let authReads = 0;
  const gates = [];                    // release() for each gated read, in start order
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') {
      authReads++;
      return pendingChild((release) => { gates.push(release); });
    }
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  const inflight = refreshGhAuthTokenAsync({ _spawn });              // periodic, gated (read #1)
  const f1 = refreshGhAuthTokenAsync({ force: true, _spawn });       // forced A: awaits read #1
  const f2 = refreshGhAuthTokenAsync({ force: true, _spawn });       // forced B: awaits read #1
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(authReads, 1, 'only the in-flight periodic read has started; both forced callers await it');
  // Release read #1. Both forced callers fall through — but serialized: exactly ONE
  // starts its fresh read, the other re-checks the marker and awaits THAT read.
  gates[0]('gho_1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(authReads, 2, 'exactly one forced read started after the in-flight settled — the other is awaiting it, not overlapping');
  // Release read #2 → the second forced caller only now starts read #3.
  gates[1]('gho_2');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(authReads, 3, 'the second forced caller performed its OWN read only after the first completed');
  gates[2]('gho_3');
  await Promise.all([inflight, f1, f2]);
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_3'), 'the last forced read wins the cache');
  invalidateGhAuthToken();
});

test('a non-forced async refresh still coalesces onto the in-flight read (no second spawn)', async () => {
  // The periodic-timer path must NOT multiply reads: a non-forced caller that
  // finds a refresh already spawning awaits it and returns its result.
  invalidateGhAuthToken();
  let authReads = 0;
  let releaseAuth;
  const gatedAuth = pendingChild((release) => { releaseAuth = release; });
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') { authReads++; return gatedAuth; }
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  const first = refreshGhAuthTokenAsync({ force: true, _spawn });   // the in-flight read
  const second = refreshGhAuthTokenAsync({ _spawn });              // non-forced: must coalesce
  releaseAuth('gho_once');
  await Promise.all([first, second]);
  assert.equal(authReads, 1, 'only ONE gh read happened — the non-forced caller coalesced');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_once'));
  invalidateGhAuthToken();
});

// --- finalizeGit push-recovery (Copilot review on #293): the central
//     changed-token success path, the unchanged-token guard, the
//     credential-source gate, and the non-auth no-retry path, all driven
//     through the `_pushGit` seam against a real local origin. ---------------

// Build a provisioned workspace with ONE agent commit ready to push.
function provisionWithCommit({ credentialSource = null, token = null } = {}) {
  const { root, origin } = makeLocalOrigin();
  const runDir = mkdtempSync(join(root, 'run-'));
  const envelope = {
    schemaVersion: 1,
    repository: { provider: 'github', url: origin, ref: 'main', submodules: false },
    branch: { base: 'main', create: 'feat/push-recovery', push: true },
    setup: { commands: [], env: {}, secretRefs: [] },
    task: { allowPr: false },
  };
  const prov = provisionRepo({ envelope, token, runDir, credentialSource });
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: prov.workspaceDir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  };
  g(['config', 'user.name', 'agent']);
  g(['config', 'user.email', 'agent@example.com']);
  writeFileSync(join(prov.workspaceDir, 'AGENT.txt'), 'agent change\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'agent: add AGENT.txt']);
  return { root, origin, envelope, prov };
}

const authFail = (opts) => ({ status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs });

test('finalizeGit retries the push once with a fresh token on an auth failure (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_stale' });
  try {
    let served = 'gho_stale';
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // cache ← stale
    let pushes = 0;
    const pushSeam = (args, opts) => {
      if (args.includes('push')) {
        pushes++;
        if (pushes === 1) return authFail(opts); // the stale token's rejection
        // The retry must carry the ROTATED token in GIT_TOKEN, then really push.
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_fresh', 'the retry runs with the rotated token');
        return runGit(args, opts);
      }
      return runGit(args, opts);
    };
    served = 'gho_fresh'; // operator re-logged in since the worker primed
    const out = finalizeGit({ ...prov, envelope, token: 'gho_stale', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam });
    assert.equal(pushes, 2, 'the push was retried once after the auth failure');
    assert.equal(out.pushed, true, 'the retry with the fresh token succeeded');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_fresh'), 'the rotated token was adopted');
    assert.equal(out.rotatedToken, 'gho_fresh', 'the rotation is surfaced so the caller can propagate it to checkpoint cleanup (#293)');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit mints the push-retry askpass in the PARENT run dir, never inside the checked-out repo (#294 review)', { skip: !gitAvailable }, () => {
  // The null → fresh recovery starts from an ANONYMOUS clone (no GIT_ASKPASS),
  // so the retry mints an askpass helper. It must NOT land in workspaceDir: the
  // final commits are already made, so stray askpass.js/.sh files would be
  // untracked and make hasUncommittedChanges() retain the WIP checkpoint and
  // pollute a preserved workspace. Assert workspaceDir stays askpass-free.
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: null });
  try {
    let served = null;
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true }); // cache ← null (anonymous)
    let pushes = 0;
    const pushSeam = (args, opts) => {
      if (args.includes('push')) {
        pushes++;
        if (pushes === 1) return authFail(opts);
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_fresh', 'the retry runs with the recovered token');
        return runGit(args, opts);
      }
      return runGit(args, opts);
    };
    served = 'gho_fresh'; // operator logged in after the anonymous clone
    const out = finalizeGit({ ...prov, envelope, token: null, logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam });
    assert.equal(pushes, 2, 'the anonymous push was retried once with the recovered token');
    assert.equal(out.pushed, true);
    const stray = readdirSync(prov.workspaceDir).filter((f) => /^askpass\./.test(f));
    assert.deepEqual(stray, [], 'no askpass files were written into the checked-out repo');
    const inRunDir = readdirSync(dirname(prov.workspaceDir)).filter((f) => /^askpass\./.test(f));
    assert.ok(inRunDir.length > 0, 'the retry askpass helper lives in the parent run dir');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit does NOT retry the push when the re-read token is unchanged (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_same' });
  try {
    setGhAuthTokenReader(() => 'gho_same'); // a genuine permission denial, not a stale cache
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });
    let pushes = 0;
    const pushSeam = (args, opts) => (args.includes('push') ? (pushes++, authFail(opts)) : runGit(args, opts));
    const out = finalizeGit({ ...prov, envelope, token: 'gho_same', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam });
    assert.equal(pushes, 1, 'no retry when the re-read token did not change');
    assert.equal(out.pushed, false);
    assert.ok(out.pushFailed, 'the unchanged-token push failure strands the commits');
    assert.ok(!('rotatedToken' in out), 'no rotation surfaced when the token did not change (#293)');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit does NOT retry the push for a non-gh-cache credential (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'env', token: 'explicit-env-token' });
  try {
    // A reader is installed to PROVE it is never consulted: the source gate must
    // reject the gh-token fallback before any re-read for an 'env' credential.
    setGhAuthTokenReader(() => { throw new Error('the gh reader must not be consulted for an env credential'); });
    invalidateGhAuthToken();
    let pushes = 0;
    const pushSeam = (args, opts) => (args.includes('push') ? (pushes++, authFail(opts)) : runGit(args, opts));
    const out = finalizeGit({ ...prov, envelope, token: 'explicit-env-token', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam });
    assert.equal(pushes, 1, 'no gh-token retry for an env-sourced credential');
    assert.equal(out.pushed, false);
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit does NOT retry a non-auth push failure (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_cache' });
  try {
    setGhAuthTokenReader(() => { throw new Error('a non-auth failure must not trigger a token re-read'); });
    invalidateGhAuthToken();
    let pushes = 0;
    const nonFf = (opts) => ({ status: 1, stdout: '', stderr: '! [rejected] feat/push-recovery -> feat/push-recovery (non-fast-forward)', signal: null, timedOut: false, timeoutMs: opts?.timeoutMs });
    const pushSeam = (args, opts) => (args.includes('push') ? (pushes++, nonFf(opts)) : runGit(args, opts));
    const out = finalizeGit({ ...prov, envelope, token: 'gho_cache', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam });
    assert.equal(pushes, 1, 'a non-auth push failure is not retried');
    assert.equal(out.pushed, false);
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #293 Copilot "Previously missed" advisories (review 5481797344) --------

// Advisory #1: a transient `gh auth token` read failure must NOT be adopted as a
// real token change — the readers now return a GH_AUTH_READ_FAILED sentinel that
// `adopt*` treats as "preserve the cached credential".

test('classifyGhAuthRead distinguishes token / logout / transient failure (#293)', () => {
  // A real token (clean exit, trimmed).
  assert.equal(classifyGhAuthRead({ status: 0, stdout: 'gho_live\n' }), 'gho_live');
  // Clean exit, no output → DEFINITIVE no-login (null).
  assert.equal(classifyGhAuthRead({ status: 0, stdout: '  \n' }), null);
  // Nonzero with gh's logged-out stderr → DEFINITIVE null.
  assert.equal(classifyGhAuthRead({ status: 1, stderr: 'no oauth token found for github.com' }), null);
  assert.equal(classifyGhAuthRead({ status: 1, stderr: 'You are not logged in to any GitHub hosts.' }), null);
  // Nonzero WITHOUT a logout signal (keychain hiccup) → TRANSIENT sentinel.
  assert.equal(classifyGhAuthRead({ status: 1, stderr: 'error connecting to keychain' }), GH_AUTH_READ_FAILED);
  // spawnSync set `.error` (ENOENT / timeout) → TRANSIENT sentinel.
  assert.equal(classifyGhAuthRead({ error: new Error('spawn ETIMEDOUT') }), GH_AUTH_READ_FAILED);
});

test('adoptGhAuthToken preserves the cached token on a transient read failure and bumps lastCheck (#293)', () => {
  invalidateGhAuthToken();
  setGhAuthTokenReader(() => 'gho_cached');
  try {
    refreshGhAuthToken({ force: true }); // cache ← gho_cached
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_cached'));
    const r = adoptGhAuthToken(GH_AUTH_READ_FAILED);
    assert.equal(r.token, 'gho_cached', 'the cached token is preserved, not wiped');
    assert.equal(r.changed, false, 'a transient failure is not a credential change');
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_cached'));
    assert.ok(ghAuthTokenInfo().lastCheckAgoMs < 1000, 'lastCheck was bumped so the hot path short-circuits');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('adoptGhAuthToken falls back to anonymous on a transient failure with NO prior token (#293)', () => {
  invalidateGhAuthToken();
  const r = adoptGhAuthToken(GH_AUTH_READ_FAILED);
  assert.equal(r.token, null, 'no usable prior credential → anonymous');
  assert.equal(ghAuthTokenInfo().present, false);
  invalidateGhAuthToken();
});

test('adoptGhAuthTokenAsync preserves the cached token on a transient read failure (#293)', async () => {
  invalidateGhAuthToken();
  setGhAuthTokenReader(() => 'gho_async_cached');
  try {
    await refreshGhAuthTokenAsync({ force: true });
    const r = await adoptGhAuthTokenAsync(GH_AUTH_READ_FAILED, { scopesProbe: () => null });
    assert.equal(r.token, 'gho_async_cached');
    assert.equal(r.changed, false);
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_async_cached'));
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
  }
});

test('readGhAuthTokenAsync maps spawn outcomes to token / null / sentinel (#293)', async () => {
  const live = await readGhAuthTokenAsync({ _spawn: () => fakeChild({ stdout: 'gho_x\n', code: 0 }) });
  assert.equal(live, 'gho_x');
  const loggedOut = await readGhAuthTokenAsync({ _spawn: () => fakeChild({ code: 1, stderr: 'no oauth token found for github.com' }) });
  assert.equal(loggedOut, null, 'a definitive logout resolves null');
  const transient = await readGhAuthTokenAsync({ _spawn: () => fakeChild({ code: 1, stderr: 'fatal: keychain locked' }) });
  assert.equal(transient, GH_AUTH_READ_FAILED, 'an unrecognised nonzero exit resolves the sentinel');
  const spawnErr = await readGhAuthTokenAsync({ _spawn: () => fakeChild({ emitError: new Error('ENOENT') }) });
  assert.equal(spawnErr, GH_AUTH_READ_FAILED, 'a spawn error resolves the sentinel');
  const threw = await readGhAuthTokenAsync({ _spawn: () => { throw new Error('spawn threw'); } });
  assert.equal(threw, GH_AUTH_READ_FAILED, 'a synchronous spawn throw resolves the sentinel');
});

test('refreshGhAuthTokenAsync keeps the cached token across a transient failure (no reader) (#293)', async () => {
  invalidateGhAuthToken();
  resetGhAuthTokenReader();
  // Prime the cache with a successful async read.
  await refreshGhAuthTokenAsync({ force: true, _spawn: (cmd, args) => {
    if (args[0] === 'auth') return fakeChild({ stdout: 'gho_primed\n', code: 0 });
    return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
  } });
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_primed'));
  // A later transient failure must not wipe it.
  const r = await refreshGhAuthTokenAsync({ force: true, _spawn: (cmd, args) => {
    if (args[0] === 'auth') return fakeChild({ code: 1, stderr: 'fatal: transient' });
    return fakeChild({ stdout: '', code: 0 });
  } });
  assert.equal(r.token, 'gho_primed', 'the transient failure preserved the primed token');
  assert.equal(r.changed, false);
  // The synchronous hot path still serves it without a blocking re-read.
  assert.equal(ghAuthTokenFromCli(), 'gho_primed');
  invalidateGhAuthToken();
});

// Advisory #3: when clone recovery rotates the gh-cache token, the `resolved`
// secret map forwarded to the harness must be updated too.

test('ghCredentialEnvName mirrors resolveJobSecrets keying (#293)', () => {
  assert.equal(ghCredentialEnvName({ provider: 'github' }), 'GITHUB_TOKEN');
  assert.equal(ghCredentialEnvName({ provider: 'github', authRef: 'MY_PAT' }), 'MY_PAT');
  assert.equal(ghCredentialEnvName({ provider: 'github', authRef: '   ' }), null, 'a blank authRef forwards no credential');
  assert.equal(ghCredentialEnvName({ provider: 'gitlab' }), null, 'a non-github default forwards no credential');
});

test('applyRotatedGhCredential updates ONLY a forwarded gh-cache credential (#293)', () => {
  // gh-cache + default key present → updated in place.
  const def = { GITHUB_TOKEN: 'stale' };
  applyRotatedGhCredential({ resolved: def, provider: 'github', authRef: undefined, source: 'gh-cache', token: 'fresh' });
  assert.equal(def.GITHUB_TOKEN, 'fresh');
  // custom authRef key present → updated.
  const cust = { MY_PAT: 'stale' };
  applyRotatedGhCredential({ resolved: cust, provider: 'github', authRef: 'MY_PAT', source: 'gh-cache', token: 'fresh' });
  assert.equal(cust.MY_PAT, 'fresh');
  // env source is a deliberate identity → never swapped.
  const envd = { GITHUB_TOKEN: 'explicit' };
  applyRotatedGhCredential({ resolved: envd, provider: 'github', authRef: undefined, source: 'env', token: 'fresh' });
  assert.equal(envd.GITHUB_TOKEN, 'explicit');
  // key not forwarded → never injected.
  const empty = {};
  applyRotatedGhCredential({ resolved: empty, provider: 'github', authRef: undefined, source: 'gh-cache', token: 'fresh' });
  assert.deepEqual(empty, {}, 'a credential the job never forwarded is not injected');
  // no token → no-op.
  const keep = { GITHUB_TOKEN: 'stale' };
  applyRotatedGhCredential({ resolved: keep, provider: 'github', authRef: undefined, source: 'gh-cache', token: null });
  assert.equal(keep.GITHUB_TOKEN, 'stale');
});

// Advisory #4: the supervisor status signature must include the gh credential
// identity, and reageSupervisorStatus must re-age ghAuth.ageMs.

test('supervisorStatusSignature folds in the gh credential IDENTITY but not its ticking age (#293)', () => {
  const base = { id: 'w1', profile: 'p', state: 'running', pid: 10, restarts: 0, activity: { state: 'idle', jobs: [] }, engine: 'http://x', agentic: { status: 'connected' } };
  const a = { ...base, ghAuth: { present: true, fingerprint: 'fp-A', scopes: 'repo', since: 1000, ageMs: 5, lastCheckAgoMs: 1 } };
  const sameIdNewerAge = { ...base, ghAuth: { present: true, fingerprint: 'fp-A', scopes: 'repo', since: 1000, ageMs: 99999, lastCheckAgoMs: 42 } };
  const rotated = { ...base, ghAuth: { present: true, fingerprint: 'fp-B', scopes: 'repo', since: 2000, ageMs: 5, lastCheckAgoMs: 1 } };
  assert.equal(supervisorStatusSignature([a]), supervisorStatusSignature([sameIdNewerAge]), 'a mere age tick is not a change');
  assert.notEqual(supervisorStatusSignature([a]), supervisorStatusSignature([rotated]), 'a fingerprint/since rotation IS a change');
});

test('reageSupervisorStatus recomputes ghAuth.ageMs from its since epoch (#293)', () => {
  const now = 1_000_000;
  const status = { workers: [{ id: 'w1', state: 'running', startedAtMs: now - 60_000, ghAuth: { present: true, fingerprint: 'fp', scopes: 'repo', since: now - 120_000, ageMs: 0, lastCheckAgoMs: 7 } }] };
  const reaged = reageSupervisorStatus(status, now);
  assert.equal(reaged.workers[0].ghAuth.ageMs, 120_000, 'the credential age ticks forward from `since`');
  assert.equal(reaged.workers[0].ghAuth.lastCheckAgoMs, 7, 'the relative lastCheckAgoMs is left untouched');
  assert.equal(reaged.workers[0].uptimeMs, 60_000);
});

// Advisory #2: after a nonzero retry push (e.g. a timeout AFTER the server
// accepted the ref), the remote-tip verification must use the FRESH credential,
// not the rejected old one — otherwise a landed push is misreported as stranded.

test('finalizeGit verifies the remote tip with the FRESH env after a nonzero retry (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_stale' });
  try {
    let served = 'gho_stale';
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });
    served = 'gho_fresh';
    let pushes = 0;
    const pushSeam = (args, opts) => {
      if (args.includes('push')) {
        pushes++;
        if (pushes === 1) return authFail(opts); // stale token rejected
        // The retry carries the rotated token AND really lands the ref, but we
        // report nonzero to simulate a client-side timeout after acceptance.
        assert.equal(opts?.env?.GIT_TOKEN, 'gho_fresh', 'the retry runs with the rotated token');
        const real = runGit(args, opts);
        return { ...real, status: 1, timedOut: true, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    let lsRemoteToken;
    const runSeam = (args, opts) => {
      if (args.includes('ls-remote')) lsRemoteToken = opts?.env?.GIT_TOKEN;
      return runGit(args, opts);
    };
    const out = finalizeGit({ ...prov, envelope, token: 'gho_stale', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam, _runGit: runSeam });
    assert.equal(pushes, 2, 'the push was retried once');
    assert.equal(lsRemoteToken, 'gho_fresh', 'remote-tip verification used the FRESH credential, not the rejected one');
    assert.equal(out.pushed, true, 'the landed ref was detected, not misreported as stranded');
    assert.ok(!out.pushFailed, 'a landed-but-timed-out push is not a strand');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

// Advisory (review 5481985995): when the fresh-token retry exits nonzero but the
// server already ACCEPTED the ref (a client-side timeout after acceptance), the
// landed push is verified and `out.pushed` is set — so PR reconciliation and
// attribution run. Those must use the FRESH credential the retry authenticated
// with, not the REJECTED old token; otherwise they fail despite the successful
// push. The original token is preserved only for failure redaction.
test('finalizeGit adopts the FRESH token for PR reconcile/attribution after a nonzero-but-landed retry (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_stale' });
  try {
    envelope.task.allowPr = true;
    let served = 'gho_stale';
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });
    served = 'gho_fresh';
    let pushes = 0;
    const pushSeam = (args, opts) => {
      if (args.includes('push')) {
        pushes++;
        if (pushes === 1) return authFail(opts); // stale token rejected
        // The retry carries the rotated token and lands the ref, but reports
        // nonzero to simulate a client-side timeout after acceptance.
        const real = runGit(args, opts);
        return { ...real, status: 1, timedOut: true, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts);
    };
    let reconcileToken;
    let attributionToken;
    const reconcileSeam = ({ token }) => { reconcileToken = token; return { found: true, number: 7 }; };
    const attributionSeam = ({ token }) => { attributionToken = token; return { ok: true }; };
    const out = finalizeGit({
      ...prov, envelope, token: 'gho_stale',
      logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      _pushGit: pushSeam, _runGit: runGit, _reconcilePr: reconcileSeam, _postAttribution: attributionSeam,
    });
    assert.equal(pushes, 2, 'the push was retried once');
    assert.equal(out.pushed, true, 'the landed ref was detected');
    assert.equal(reconcileToken, 'gho_fresh', 'PR reconcile used the FRESH credential, not the rejected old token');
    assert.equal(attributionToken, 'gho_fresh', 'attribution used the FRESH credential, not the rejected old token');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});

// Advisory (review 5482090625): when the fresh-token retry ALSO fails and the ref
// did NOT land, the original stale-token rejection is already RECOVERED — it is no
// longer the actionable cause. out.pushError must report the RETRY's failure (the
// one that actually stranded the commits), redacted against the credential the
// retry used (`fresh`), not the original rejection.
test('finalizeGit reports the RETRY failure (not the recovered original) when the retry also fails and does not land (#293 review)', { skip: !gitAvailable }, () => {
  const { root, envelope, prov } = provisionWithCommit({ credentialSource: 'gh-cache', token: 'gho_stale' });
  try {
    let served = 'gho_stale';
    setGhAuthTokenReader(() => served);
    invalidateGhAuthToken();
    refreshGhAuthToken({ force: true });
    served = 'gho_fresh';
    let pushes = 0;
    const pushSeam = (args, opts) => {
      if (args.includes('push')) {
        pushes++;
        // #1: the stale token is rejected (auth failure → triggers the re-read+retry).
        if (pushes === 1) return { status: 128, stdout: '', stderr: "ORIGINAL-FAILURE: could not read Username for 'https://github.com': terminal prompts disabled", signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
        // #2: the retry with the FRESH token ALSO fails and never lands the ref.
        // Its stderr carries the fresh token value so we can assert redaction.
        return { status: 128, stdout: '', stderr: 'RETRY-FAILURE token=gho_fresh\nfatal: unable to access: The requested URL returned error: 403', signal: null, timedOut: false, timeoutMs: opts?.timeoutMs };
      }
      return runGit(args, opts); // ls-remote/fetch run for real → ref is NOT on origin
    };
    const out = finalizeGit({ ...prov, envelope, token: 'gho_stale', logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, _pushGit: pushSeam, _runGit: runGit });
    assert.equal(pushes, 2, 'the push was retried once');
    assert.equal(out.pushFailed, true, 'the unlanded retry strands the commits');
    assert.ok(/RETRY-FAILURE/.test(out.pushError), 'out.pushError reports the RETRY failure that actually stranded the commits');
    assert.ok(!/ORIGINAL-FAILURE/.test(out.pushError), 'the already-recovered original rejection is NOT the reported failure');
    assert.ok(!/gho_fresh/.test(out.pushError), 'the retry credential is redacted from the reported failure');
  } finally {
    resetGhAuthTokenReader();
    invalidateGhAuthToken();
    rmSync(root, { recursive: true, force: true });
  }
});


test('a stale async refresh does NOT clobber a newer forced sync recovery (generation fence)', async () => {
  invalidateGhAuthToken();
  // No module reader installed → the async refresh uses the `_spawn` seam. Gate
  // the `gh auth token` read so the refresh stays in flight; the scopes probe
  // (`api`) resolves immediately once the read releases.
  let release = null;
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') return pendingChild((rel) => { release = rel; });
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  // Start the async refresh but do NOT await it — it is now reading `gho_old`.
  const asyncRefresh = refreshGhAuthTokenAsync({ force: true, _spawn });
  await new Promise((r) => setTimeout(r, 5));
  // Forced synchronous recovery lands the ROTATED token while the async read is
  // still gated. `run` injection keeps it hermetic (no real gh, no module reader).
  invalidateGhAuthToken();
  const rec = refreshGhAuthToken({ force: true, run: () => ({ status: 0, stdout: 'gho_new\n' }), scopesProbe: () => 'repo' });
  assert.equal(rec.token, 'gho_new');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_new'));
  // Release the gated async read: it resolves `gho_old`, probes scopes, then the
  // generation fence sees the generation advanced and REFUSES to commit.
  release('gho_old');
  const r = await asyncRefresh;
  assert.equal(r.superseded, true, 'the stale async read reports itself superseded');
  assert.equal(r.token, 'gho_new', 'the superseded refresh returns the newer live token');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_new'), 'the forced recovery credential survived');
  invalidateGhAuthToken();
});

// Sibling of the above on the TRANSIENT-failure branch: an async read that comes
// back GH_AUTH_READ_FAILED would normally preserve the prior token (bumping
// lastCheck). If a newer forced recovery landed meanwhile, even that benign
// re-stamp must be fenced so it cannot touch the newer record. A `generation` of
// -1 can never match the live monotonic counter (it only ever increments from
// 0), so it deterministically models "a newer write has landed since we read".
test('a stale async READ_FAILED preserve is fenced against a newer forced recovery', async () => {
  invalidateGhAuthToken();
  // A live credential is in the cache (the "newer forced recovery" result).
  refreshGhAuthToken({ force: true, run: () => ({ status: 0, stdout: 'gho_live\n' }), scopesProbe: () => 'repo' });
  // An outdated-generation async adopt of READ_FAILED must NOT re-stamp the cache.
  const r = await adoptGhAuthTokenAsync(GH_AUTH_READ_FAILED, { scopesProbe: () => 'repo', generation: -1 });
  assert.equal(r.superseded, true, 'a stale READ_FAILED preserve is reported superseded');
  assert.equal(r.token, 'gho_live', 'the superseded preserve returns the newer live token');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_live'), 'the live record was not re-stamped by the stale preserve');
  invalidateGhAuthToken();
});

// The fence is a no-op when no newer write interleaves: an async adopt whose
// snapshotted generation still matches commits normally.
test('an async adopt whose generation still matches commits normally (fence no-op)', async () => {
  invalidateGhAuthToken();
  // refreshGhAuthTokenAsync snapshots the generation internally; with no
  // interleaving forced recovery the read must land in the cache.
  const _spawn = (cmd, args) => {
    if (args[0] === 'auth' && args[1] === 'token') return fakeChild({ stdout: 'gho_solo\n', code: 0 });
    if (args[0] === 'api') return fakeChild({ stdout: 'HTTP/2 200\nX-OAuth-Scopes: repo\n\n{}', code: 0 });
    return fakeChild({ stdout: '', code: 0 });
  };
  const r = await refreshGhAuthTokenAsync({ force: true, _spawn });
  assert.equal(r.token, 'gho_solo');
  assert.ok(!r.superseded, 'an uncontended refresh is not superseded');
  assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_solo'));
  invalidateGhAuthToken();
});
