// Unit tests for the sandboxed agent-worker plumbing (issue #8, increment 1):
// task-envelope normalization, secret resolution, result envelope, profile
// normalization, and (Docker-gated) container execution + disk hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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
  reapAgentContainers,
  normalizeStoredProfile,
  containerEngineAvailable,
  runAgentJob,
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
