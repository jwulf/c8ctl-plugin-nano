// Unit tests for the sandboxed agent-worker plumbing (issue #8, increment 1):
// task-envelope normalization, secret resolution, result envelope, profile
// normalization, and (Docker-gated) container execution + disk hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeTaskEnvelope,
  collectEnvelopeFrom,
  coerceBool,
  coerceInt,
  deepMerge,
  resolveJobSecrets,
  makeSecretResolver,
  buildAgentPayload,
  buildResultEnvelope,
  parseEnvPairs,
  normalizeEnvMap,
  reapAgentContainers,
  diskBudgetOk,
  normalizeStoredProfile,
  containerEngineAvailable,
  runAgentJob,
  provisionRepo,
  finalizeGit,
  reconcileAgentPr,
  reapAgentRunDirs,
  authUrl,
  redactToken,
  ProvisionError,
  AGENT_TASK_NS,
  AGENT_RESULT_KEY,
  SANDBOXES,
} from './c8ctl-plugin.js';

test('coerceBool handles strings, bools, and defaults', () => {
  assert.equal(coerceBool('true'), true);
  assert.equal(coerceBool('FALSE'), false);
  assert.equal(coerceBool('1'), true);
  assert.equal(coerceBool('off'), false);
  assert.equal(coerceBool(undefined, true), true);
  assert.equal(coerceBool('nonsense', true), true);
  assert.equal(coerceBool(true), true);
});

test('coerceInt parses ints and falls back', () => {
  assert.equal(coerceInt('42', 0), 42);
  assert.equal(coerceInt('', 7), 7);
  assert.equal(coerceInt(undefined, 7), 7);
  assert.equal(coerceInt('abc', 9), 9);
});

test('deepMerge overrides win and nest', () => {
  const base = { a: 1, nested: { x: 1, y: 2 } };
  const over = { a: 2, nested: { y: 3, z: 4 } };
  assert.deepEqual(deepMerge(base, over), { a: 2, nested: { x: 1, y: 3, z: 4 } });
});

test('collectEnvelopeFrom expands dotpath keys and JSON blob', () => {
  const flat = collectEnvelopeFrom({
    [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
    [`${AGENT_TASK_NS}.task.allowPr`]: 'true',
  });
  assert.equal(flat.repository.url, 'https://github.com/o/r.git');
  assert.equal(flat.task.allowPr, 'true');

  const blob = collectEnvelopeFrom({ [AGENT_TASK_NS]: '{"branch":{"push":false}}' });
  assert.equal(blob.branch.push, false);
});

test('normalizeTaskEnvelope: variables override headers, coercion applied', () => {
  const headers = {
    [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
    [`${AGENT_TASK_NS}.repository.provider`]: 'github',
    [`${AGENT_TASK_NS}.branch.push`]: 'true',
    [`${AGENT_TASK_NS}.task.allowPr`]: 'false',
    [`${AGENT_TASK_NS}.task.maxIterations`]: '5',
  };
  const variables = {
    [`${AGENT_TASK_NS}.task.allowPr`]: 'true', // override wins
    prompt: 'do the thing',
  };
  const env = normalizeTaskEnvelope(headers, variables);
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.repository.url, 'https://github.com/o/r.git');
  assert.equal(env.repository.provider, 'github');
  assert.equal(env.repository.submodules, false);
  assert.equal(env.branch.push, true);
  assert.equal(env.task.allowPr, true, 'variable override should win');
  assert.equal(env.task.maxIterations, 5);
  assert.equal(env.task.prompt, 'do the thing');
});

test('normalizeTaskEnvelope: no repository when url absent', () => {
  const env = normalizeTaskEnvelope({}, {});
  assert.equal(env.repository, undefined);
  assert.equal(env.branch.push, true); // default
  assert.deepEqual(env.setup.commands, []);
  assert.equal(env.task.allowPr, false);
});

test('normalizeTaskEnvelope: provider is lowercased so downstream comparisons work', () => {
  const env = normalizeTaskEnvelope(
    {
      [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
      [`${AGENT_TASK_NS}.repository.provider`]: 'GitHub',
    },
    {},
  );
  assert.equal(env.repository.provider, 'github');
});

test('resolveJobSecrets: host resolver reads env, reports missing', () => {
  const resolver = makeSecretResolver('host');
  process.env.__NANO_TEST_SECRET = 'shhh';
  try {
    const env = normalizeTaskEnvelope(
      { [`${AGENT_TASK_NS}.setup.secretRefs`]: undefined },
      {},
    );
    env.setup.secretRefs = ['__NANO_TEST_SECRET', '__NANO_MISSING_SECRET'];
    const { resolved, missing } = resolveJobSecrets(resolver, env);
    assert.equal(resolved.__NANO_TEST_SECRET, 'shhh');
    assert.deepEqual(missing, ['__NANO_MISSING_SECRET']);
  } finally {
    delete process.env.__NANO_TEST_SECRET;
  }
});

test('resolveJobSecrets: allowPr pulls the github default credential', () => {
  const resolver = makeSecretResolver('host');
  process.env.GITHUB_TOKEN = 'ght';
  try {
    const env = normalizeTaskEnvelope(
      {
        [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
        [`${AGENT_TASK_NS}.task.allowPr`]: 'true',
      },
      {},
    );
    const { resolved, names } = resolveJobSecrets(resolver, env);
    assert.ok(names.includes('GITHUB_TOKEN'));
    assert.equal(resolved.GITHUB_TOKEN, 'ght');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('makeSecretResolver rejects unknown kinds', () => {
  assert.equal(makeSecretResolver('host').kind, 'host');
  assert.equal(makeSecretResolver(undefined).kind, 'host');
  assert.equal(makeSecretResolver('vault'), null);
});

test('buildAgentPayload embeds the normalized task envelope + prompt', () => {
  const env = normalizeTaskEnvelope({}, { prompt: 'hello' });
  const payload = buildAgentPayload(
    { name: 'p', rank: 'senior', model: 'm', capabilities: ['a'] },
    { jobKey: '1', type: 'senior', variables: { prompt: 'hello' }, customHeaders: {} },
    env,
  );
  assert.equal(payload.prompt, 'hello');
  assert.equal(payload.task.task.prompt, 'hello');
  assert.equal(payload.profile.name, 'p');
});

test('buildResultEnvelope reflects status/exit/sandbox', () => {
  const ok = buildResultEnvelope({ ok: true, stdout: 'out', exitCode: 0 }, { sandbox: 'docker', image: 'busybox' });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.sandbox, 'docker');
  assert.equal(ok.image, 'busybox');
  assert.equal(ok.output, 'out');

  const timedOut = buildResultEnvelope({ ok: false, timedOut: true, error: 'timed out' }, { sandbox: 'none' });
  assert.equal(timedOut.status, 'timedOut');

  const failed = buildResultEnvelope({ ok: false, exitCode: 1 }, { sandbox: 'none' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
});

test('buildResultEnvelope merges the git block when a repo was provisioned', () => {
  const env = buildResultEnvelope(
    { ok: true, stdout: 'done', exitCode: 0 },
    { sandbox: 'none', git: { branch: 'feat/x', baseSha: 'aaa', headSha: 'bbb', commits: ['bbb'], pushed: true, remote: 'https://github.com/o/r.git', pr: { openedBy: 'agent', found: true, number: 7 } } },
  );
  assert.equal(env.branch, 'feat/x');
  assert.deepEqual(env.commits, ['bbb']);
  assert.equal(env.pushed, true);
  assert.equal(env.remote ?? env.repository, 'https://github.com/o/r.git');
  assert.equal(env.pr.number, 7);

  const noGit = buildResultEnvelope({ ok: true, stdout: '', exitCode: 0 }, { sandbox: 'none' });
  assert.equal('branch' in noGit, false, 'no git block when no repo');

  // A failed job that WAS provisioned must still carry repo context.
  const failed = buildResultEnvelope(
    { ok: false, stdout: '', exitCode: 1, error: 'boom' },
    { sandbox: 'none', git: { remote: 'https://github.com/o/r.git', branch: 'feat/x', baseSha: 'aaa', commits: [], pushed: false, error: 'finalize failed' } },
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.repository, 'https://github.com/o/r.git', 'repository preserved on failure');
  assert.equal(failed.branch, 'feat/x');
  assert.equal(failed.gitError, 'finalize failed');
});

// --- Git provisioning (increment 2a) ----------------------------------------
// These use the real `git` binary against local file:// repos — no network, no
// token — so they run in CI. gh-backed PR reconcile is gated separately.
const gitOk = (() => {
  try { return spawnSync('git', ['--version'], { timeout: 10_000 }).status === 0; } catch { return false; }
})();

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

// Build a bare origin repo with one commit on `main`, return its path + a
// throwaway root to clean up.
function makeOriginRepo() {
  const root = mkdtempSync(join(tmpdir(), 'nano-git-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  g(['init', '-q', src], undefined);
  g(['checkout', '-q', '-B', 'main'], src);
  g(['config', 'user.name', 'seed'], src);
  g(['config', 'user.email', 'seed@example.com'], src);
  writeFileSync(join(src, 'README.md'), '# seed\n');
  g(['add', '-A'], src);
  g(['commit', '-q', '-m', 'seed'], src);
  const origin = join(root, 'origin.git');
  g(['clone', '-q', '--bare', src, origin], undefined);
  return { root, origin };
}

test('provisionRepo clones + creates the working branch', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: 'main', create: 'feat/nano', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.ok(existsSync(join(prov.workspaceDir, 'README.md')), 'clone populated the workspace');
    assert.equal(prov.workingBranch, 'feat/nano');
    assert.equal(prov.ref, 'main', 'effective ref falls back to branch.base when repository.ref is absent');
    assert.match(prov.startSha, /^[0-9a-f]{7,40}$/);
    assert.equal(g(['rev-parse', '--abbrev-ref', 'HEAD'], prov.workspaceDir), 'feat/nano');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo reports detached HEAD (tag ref, no create) and finalizeGit skips push', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  // tag the seed commit on the origin so we can clone --branch <tag>
  const tagClone = mkdtempSync(join(root, 'tag-'));
  g(['clone', '-q', origin, tagClone], undefined);
  g(['tag', 'v1'], tagClone);
  g(['push', '-q', 'origin', 'v1'], tagClone);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'v1', submodules: false },
      branch: { base: '', create: '', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: true },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(prov.workingBranch, null, 'a tag checkout has no branch');
    assert.equal(prov.detached, true);
    assert.equal(prov.ref, 'v1', 'exposes the effective ref for AGENT_REPO_REF');
    const out = finalizeGit({ ...prov, envelope, token: null });
    assert.equal(out.pushed, false, 'never push a detached HEAD');
    assert.equal(out.detached, true);
    assert.equal(out.pushError, undefined, 'no push attempted, so no push error');
    assert.equal(out.pr, null, 'no PR reconcile without a branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo checks out a commit SHA ref (detached, not via --branch)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  // add a second commit so we can pin the FIRST one by SHA
  const wc = mkdtempSync(join(root, 'wc-'));
  g(['clone', '-q', origin, wc], undefined);
  const firstSha = g(['rev-parse', 'HEAD'], wc);
  g(['config', 'user.name', 'seed'], wc);
  g(['config', 'user.email', 'seed@example.com'], wc);
  writeFileSync(join(wc, 'two.txt'), 'two\n');
  g(['add', '-A'], wc);
  g(['commit', '-q', '-m', 'second'], wc);
  g(['push', '-q', 'origin', 'main'], wc);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: firstSha, submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(g(['rev-parse', 'HEAD'], prov.workspaceDir), firstSha, 'HEAD is pinned to the requested SHA');
    assert.equal(prov.workingBranch, null, 'a SHA checkout has no branch');
    assert.equal(prov.detached, true);
    assert.equal(prov.ref, firstSha, 'exposes the effective SHA ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo drops inherited GIT_ASKPASS/SSH_ASKPASS for an anonymous clone', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  const savedGit = process.env.GIT_ASKPASS;
  const savedSsh = process.env.SSH_ASKPASS;
  process.env.GIT_ASKPASS = '/host/echo-secret';
  process.env.SSH_ASKPASS = '/host/echo-secret';
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: '', create: 'feat/x', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(prov.gitEnv.GIT_ASKPASS, undefined, 'host GIT_ASKPASS must not leak into an anonymous clone');
    assert.equal(prov.gitEnv.SSH_ASKPASS, undefined, 'host SSH_ASKPASS must not leak into an anonymous clone');
    assert.ok(prov.gitEnv.GIT_CONFIG_GLOBAL, 'anonymous clone neutralizes global git config');
  } finally {
    if (savedGit === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedGit;
    if (savedSsh === undefined) delete process.env.SSH_ASKPASS; else process.env.SSH_ASKPASS = savedSsh;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo throws a ProvisionError (redacted) on clone failure', { skip: !gitOk }, () => {
  const root = mkdtempSync(join(tmpdir(), 'nano-git-'));
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: join(root, 'does-not-exist'), submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    assert.throws(() => provisionRepo({ envelope, token: 'supersecret', runDir }), (err) => {
      assert.ok(err instanceof ProvisionError);
      assert.equal(err.message.includes('supersecret'), false, 'token must be redacted from errors');
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit enumerates new commits and pushes the branch', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: '', create: 'feat/work', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    // Simulate the harness doing work + committing.
    writeFileSync(join(prov.workspaceDir, 'NEW.txt'), 'agent change\n');
    g(['add', '-A'], prov.workspaceDir);
    g(['commit', '-q', '-m', 'agent: add NEW.txt'], prov.workspaceDir);

    const out = finalizeGit({
      workspaceDir: prov.workspaceDir,
      gitEnv: prov.gitEnv,
      startSha: prov.startSha,
      workingBranch: prov.workingBranch,
      envelope,
      token: null,
    });
    assert.equal(out.commits.length, 1, 'one new commit since start');
    assert.equal(out.pushed, true, out.pushError || 'push should succeed to a bare origin');
    assert.equal(out.branch, 'feat/work');
    // Origin now carries the pushed branch.
    assert.match(g(['--git-dir', origin, 'rev-parse', 'feat/work'], undefined), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeGit does not push when the harness produced no commits', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: '', create: 'feat/empty', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    const out = finalizeGit({ workspaceDir: prov.workspaceDir, gitEnv: prov.gitEnv, startSha: prov.startSha, workingBranch: prov.workingBranch, envelope, token: null });
    assert.equal(out.commits.length, 0);
    assert.equal(out.pushed, false);
    assert.throws(() => g(['--git-dir', origin, 'rev-parse', 'feat/empty'], undefined), 'nothing pushed for an empty branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authUrl embeds a username only when a token is present (https)', () => {
  assert.equal(authUrl('https://github.com/o/r.git', 'github', false), 'https://github.com/o/r.git');
  assert.equal(authUrl('https://github.com/o/r.git', 'github', true), 'https://x-access-token@github.com/o/r.git');
  assert.equal(authUrl('https://gitlab.com/o/r.git', 'gitlab', true), 'https://git@gitlab.com/o/r.git');
  // ssh + author-supplied creds are left untouched.
  assert.equal(authUrl('git@github.com:o/r.git', 'github', true), 'git@github.com:o/r.git');
  assert.equal(authUrl('https://user:pw@github.com/o/r.git', 'github', true), 'https://user:pw@github.com/o/r.git');
});

test('redactToken masks the token and any https userinfo', () => {
  assert.equal(redactToken('cloning https://x-access-token:sekret@github.com/o/r.git', 'sekret'), 'cloning https://github.com/o/r.git');
  assert.equal(redactToken('token is abc123 here', 'abc123'), 'token is *** here');
});

test('reconcileAgentPr reports unsupported provider without shelling out', () => {
  const r = reconcileAgentPr({ workspaceDir: '/tmp', token: null, branch: 'x', provider: 'gitlab' });
  assert.equal(r.openedBy, null);
  assert.equal(r.found, false);
  assert.match(r.error, /unsupported/);
});

// --- Harness env (profile.env + --env) --------------------------------------
test('parseEnvPairs parses NAME=VALUE, keeps = in values, reports bad input', () => {
  const ok = parseEnvPairs(['A=1', 'B=x=y', 'TOKEN_ENABLED=true']);
  assert.deepEqual(ok.env, { A: '1', B: 'x=y', TOKEN_ENABLED: 'true' });
  assert.equal(ok.errors.length, 0);

  const single = parseEnvPairs('ONLY=one'); // c8ctl may hand a scalar for a single flag
  assert.deepEqual(single.env, { ONLY: 'one' });

  const bad = parseEnvPairs(['noequals', '=nokey', '1BAD=x', 'GOOD=y']);
  assert.deepEqual(bad.env, { GOOD: 'y' });
  assert.equal(bad.errors.length, 3);

  // Errors must never echo the value (it may be a secret passed via --env).
  const leak = parseEnvPairs(['BAD NAME=sk-supersecret', 'no-dash=alsosecret']);
  assert.equal(leak.errors.length, 2);
  for (const e of leak.errors) {
    assert.equal(e.includes('supersecret'), false, 'error leaked a secret value');
    assert.equal(e.includes('alsosecret'), false, 'error leaked a secret value');
  }

  assert.deepEqual(parseEnvPairs(undefined).env, {});
});

test('normalizeEnvMap drops invalid names and stringifies values', () => {
  assert.deepEqual(normalizeEnvMap({ OK: 1, FLAG: true, 'bad-name': 'x', GOOD_1: 'v', NIL: null }), { OK: '1', FLAG: 'true', GOOD_1: 'v' });
  assert.deepEqual(normalizeEnvMap(null), {});
});

test('normalizeStoredProfile carries a normalized env map', () => {
  const p = normalizeStoredProfile('coder', { rank: 'senior', command: 'copilot', env: { PERMS: 1, 'bad key': 'x' } });
  assert.deepEqual(p.profile.env, { PERMS: '1' });
  const none = normalizeStoredProfile('coder', { rank: 'senior', command: 'copilot' });
  assert.deepEqual(none.profile.env, {}, 'missing env → empty map');
});

test('runAgentJob (host) injects profileEnv + setup.env into the harness', async () => {
  // The host command runs via shell, so it can echo the injected vars. setup.env
  // (per-job) must win over profileEnv (profile default) for the same key.
  const profile = { name: 'p', rank: 'senior', command: 'printf "%s|%s" "$PERMX" "$TUNE"', model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const envelope = normalizeTaskEnvelope({}, {});
  envelope.setup.env = { PERMX: 'job-wins', TUNE: 'from-setup' };
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope,
    profileEnv: { PERMX: 'profile-loses', OTHER: 'ignored' },
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true, result.error || result.stderr);
  assert.equal(result.stdout, 'job-wins|from-setup');
});

test('runAgentJob (host) reserved AGENT_* cannot be shadowed by profileEnv', async () => {
  const profile = { name: 'shadowy', rank: 'senior', command: 'printf %s "$AGENT_PROFILE"', model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope: normalizeTaskEnvelope({}, {}),
    profileEnv: { AGENT_PROFILE: 'spoofed' },
    timeoutMs: 30_000,
  });
  assert.equal(result.stdout, 'shadowy', 'reserved AGENT_* wins over user env');
});

test('reapAgentRunDirs age-gates and skips in-flight dirs', () => {
  const home = mkdtempSync(join(tmpdir(), 'nano-home-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  try {
    const runs = join(home, 'agent-runs');
    mkdirSync(runs, { recursive: true });
    const oldDir = join(runs, 'run-old');
    const freshDir = join(runs, 'run-fresh');
    const liveDir = join(runs, 'run-live');
    for (const d of [oldDir, freshDir, liveDir]) mkdirSync(d, { recursive: true });
    const old = Date.now() / 1000 - 7200; // 2h ago
    utimesSync(oldDir, old, old);
    utimesSync(liveDir, old, old);

    const r = reapAgentRunDirs({ maxAgeMs: 60 * 60_000, liveRunDirs: new Set([liveDir]) });
    assert.equal(r.reaped, 1, 'only the aged, non-live dir is reaped');
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(freshDir), true, 'fresh dir under the age gate is kept');
    assert.equal(existsSync(liveDir), true, 'in-flight dir is never reaped');
  } finally {
    if (prev === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('reapAgentRunDirs only touches run-* dirs, never unrelated operator files', () => {
  const home = mkdtempSync(join(tmpdir(), 'nano-home-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  try {
    const runs = join(home, 'agent-runs');
    mkdirSync(runs, { recursive: true });
    const runDir = join(runs, 'run-old');
    const foreignDir = join(runs, 'operator-notes');
    for (const d of [runDir, foreignDir]) mkdirSync(d, { recursive: true });
    const foreignFile = join(runs, 'README.txt');
    writeFileSync(foreignFile, 'do not delete');
    const old = Date.now() / 1000 - 7200; // 2h ago
    for (const p of [runDir, foreignDir, foreignFile]) utimesSync(p, old, old);

    const r = reapAgentRunDirs({ maxAgeMs: 60 * 60_000 });
    assert.equal(r.reaped, 1, 'only the run-* dir is reaped');
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(foreignDir), true, 'unrelated dir is never reaped');
    assert.equal(existsSync(foreignFile), true, 'unrelated file is never reaped');
  } finally {
    if (prev === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('normalizeStoredProfile validates sandbox + image', () => {
  const none = normalizeStoredProfile('p', { rank: 'senior', command: 'copilot' });
  assert.equal(none.profile.sandbox, 'none');
  assert.equal(none.profile.image, '');

  const bad = normalizeStoredProfile('p', { rank: 'senior', command: 'copilot', sandbox: 'vm' });
  assert.match(bad.error, /invalid sandbox/);

  const noImage = normalizeStoredProfile('p', { rank: 'senior', command: 'copilot', sandbox: 'docker' });
  assert.match(noImage.error, /no image/);

  const good = normalizeStoredProfile('p', { rank: 'senior', command: 'copilot', sandbox: 'docker', image: 'busybox' });
  assert.equal(good.profile.sandbox, 'docker');
  assert.equal(good.profile.image, 'busybox');
});

test('normalizeTaskEnvelope forces schemaVersion to v1 regardless of input', () => {
  const env = normalizeTaskEnvelope({ 'io.nanobpm.agentTask.schemaVersion': '9' }, {});
  assert.equal(env.schemaVersion, 1);
});

test('SANDBOXES exposes the expected set', () => {
  assert.deepEqual(SANDBOXES, ['none', 'docker', 'podman']);
});

test('diskBudgetOk fails open when the engine root cannot be resolved', () => {
  // A bogus engine binary makes dockerRootDir() return null → must NOT shed
  // (and must never statfs an unrelated path like the OS temp dir).
  const r = diskBudgetOk('definitely-not-a-real-engine-xyz', 1_073_741_824);
  assert.equal(r.ok, true);
  assert.equal(r.free, null);
});

// --- Docker-gated integration tests -----------------------------------------
// Opt-in: these pull a real image (busybox) and run a container, so they need
// BOTH a working Docker daemon AND an explicit opt-in. Gating on the env flag
// keeps them out of CI (release.yml's `test` job), where anonymous Docker Hub
// pulls rate-limit and flake. Run locally with:
//   C8CTL_NANO_DOCKER_TESTS=1 npm test
const dockerOptIn = process.env.C8CTL_NANO_DOCKER_TESTS === '1';
const dockerOk = dockerOptIn && (() => {
  try {
    return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 }).status === 0;
  } catch { return false; }
})();

test('reapAgentContainers is label-scoped and safe with no containers', { skip: !dockerOk }, () => {
  const r = reapAgentContainers('docker', { maxAgeMs: 0, liveRunIds: new Set() });
  assert.ok(typeof r.reaped === 'number');
});

test('runAgentJob (docker): pipes envelope, captures output, reaps container', { skip: !dockerOk }, async () => {
  assert.equal(containerEngineAvailable('docker'), true);
  const runId = `test-${Date.now()}`;
  const profile = { name: 'tester', rank: 'senior', command: 'cat', model: '', capabilities: [] };
  const job = { jobKey: 'jk-1', type: 'senior', variables: { prompt: 'hi' }, customHeaders: {} };
  const envelope = normalizeTaskEnvelope({}, { prompt: 'hi' });
  const result = await runAgentJob(profile, job, {
    timeoutMs: 30_000,
    envelope,
    sandbox: 'docker',
    image: 'busybox',
    runId,
    secretEnv: {},
    passThroughSecretNames: [],
  });
  assert.equal(result.ok, true, result.error || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.prompt, 'hi');
  assert.equal(payload.jobKey, 'jk-1');
  // --rm removes the container on exit; the reaper is a backstop and must not error.
  const reap = reapAgentContainers('docker', { maxAgeMs: 0, liveRunIds: new Set() });
  assert.ok(typeof reap.reaped === 'number');
});
