// Unit tests for issue #293 — the gh auth token cache must not go stale for the
// worker's lifetime: a TTL refresh, invalidation + one retry on a git/gh auth
// failure, fingerprint/scope visibility, and the supervisor `reload-credentials`
// broadcast. All gh/git subprocesses are stubbed (injected `run`/`scopesProbe` /
// the `_runGit` seam), so the suite is hermetic and never touches the host's gh
// login or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ghAuthTokenFromCli,
  primeGhAuthToken,
  refreshGhAuthToken,
  invalidateGhAuthToken,
  setGhAuthTokenReader,
  resetGhAuthTokenReader,
  ghAuthTokenInfo,
  describeGhAuthToken,
  ghTokenFingerprint,
  isGitAuthFailure,
  githubCloneToken,
  makeSecretResolver,
  buildActivityPayload,
  summarizeSupervisorWorker,
  supervisorGhAuthCell,
  formatSupervisorStatus,
  provisionRepo,
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
  assert.equal(isGitAuthFailure('{"message":"Bad credentials"}'), true);
  assert.equal(isGitAuthFailure('{"message":"Resource not accessible by personal access token"}'), true);
  // NOT auth failures — must not trigger a token drop + retry.
  assert.equal(isGitAuthFailure('error: failed to push some refs (non-fast-forward)'), false);
  assert.equal(isGitAuthFailure('fatal: repository \'https://github.com/o/missing\' not found (404)'), false);
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
    // picks up the fresh token.
    served = 'gho_fresh';
    const prov = provisionRepo({ envelope, token: 'gho_stale', runDir, _runGit: seam });
    assert.equal(cloneAttempts, 2, 'the clone was retried once after the auth failure');
    assert.ok(prov.workspaceDir, 'the retry produced a workspace');
    // The cache now holds the rotated token.
    assert.equal(ghAuthTokenInfo().fingerprint, ghTokenFingerprint('gho_fresh'));
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
    // stale cache) — a retry can't help, so it must not fire.
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
    assert.throws(() => provisionRepo({ envelope, token: 'gho_same', runDir, _runGit: seam }), /git clone failed/);
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
