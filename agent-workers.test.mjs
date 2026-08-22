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
  parseLinkedResources,
  pickLinkedResource,
  resolveBrokerRestConfig,
  resolveAutoRestConfig,
  resolveWorkerEngineBase,
  resourceContentUrl,
  fetchLinkedResourceContent,
  resolveLinkedPrompt,
  resolveLinkedPromptSource,
  normalizeRestBase,
  coerceBool,
  coerceInt,
  deepMerge,
  resolveJobSecrets,
  makeSecretResolver,
  buildAgentPayload,
  buildResultEnvelope,
  parseAgentResultObject,
  readAgentResultFile,
  parseResultFromStdout,
  sanitizeResultVars,
  parseEnvPairs,
  parseJobTypeFlags,
  derivePollTimeoutMs,
  normalizeEnvMap,
  normalizeArgList,
  shQuote,
  buildAgentCommandLine,
  reapAgentContainers,
  diskBudgetOk,
  normalizeStoredProfile,
  applyAssign,
  jobTypeMatrix,
  diffJobTypes,
  resolveAssignInputs,
  containerEngineAvailable,
  runAgentJob,
  startLockExtender,
  provisionRepo,
  finalizeGit,
  describeGitFailure,
  boundGitOutput,
  reconcileAgentPr,
  resolveCommitterIdentity,
  isPlaceholderEmail,
  reapAgentRunDirs,
  authUrl,
  githubCloneToken,
  primeGhAuthToken,
  ghAuthTokenFromCli,
  ghAuthEnv,
  redactToken,
  ProvisionError,
  AGENT_TASK_NS,
  AGENT_RESULT_KEY,
  LINKED_RESOURCES_HEADER,
  DEFAULT_PROMPT_LINK_NAME,
  RESULT_SENTINEL,
  RESERVED_RESULT_KEYS,
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

test('normalizeTaskEnvelope: maps branch-scoped/partial clone fields (issue #91)', () => {
  const headers = {
    [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
  };
  const variables = {
    [`${AGENT_TASK_NS}.repository.singleBranch`]: 'true',
    [`${AGENT_TASK_NS}.repository.filter`]: 'blob:none',
    [`${AGENT_TASK_NS}.repository.depth`]: '1',
    [`${AGENT_TASK_NS}.repository.baseRef`]: 'main',
    [`${AGENT_TASK_NS}.repository.baseSha`]: 'deadbeef',
    [`${AGENT_TASK_NS}.repository.sha`]: 'cafebabe',
    [`${AGENT_TASK_NS}.repository.cloneTimeoutMs`]: '600000',
  };
  const env = normalizeTaskEnvelope(headers, variables);
  assert.equal(env.repository.singleBranch, true, 'string "true" coerces to boolean');
  assert.equal(env.repository.filter, 'blob:none');
  assert.equal(env.repository.depth, 1);
  assert.equal(env.repository.baseRef, 'main');
  assert.equal(env.repository.baseSha, 'deadbeef');
  assert.equal(env.repository.sha, 'cafebabe', 'dedicated commit-sha field is carried through');
  assert.equal(env.repository.cloneTimeoutMs, 600000, 'string coerces to int');
});

test('normalizeTaskEnvelope: new clone fields default to today’s behavior when absent', () => {
  const env = normalizeTaskEnvelope({ [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git' }, {});
  assert.equal(env.repository.singleBranch, false, 'absent singleBranch is false');
  assert.equal(env.repository.filter, undefined, 'absent filter is undefined');
  assert.equal(env.repository.baseRef, undefined);
  assert.equal(env.repository.baseSha, undefined);
  assert.equal(env.repository.sha, undefined);
  assert.equal(env.repository.cloneTimeoutMs, undefined);
});

test('normalizeTaskEnvelope: appendPrompt (reserved) is concatenated verbatim onto the header base', () => {
  const headers = { [`${AGENT_TASK_NS}.task.prompt`]: 'BASE PROMPT' };
  const variables = { [`${AGENT_TASK_NS}.task.appendPrompt`]: '\n\n---\n\nEXTRA' };
  const env = normalizeTaskEnvelope(headers, variables);
  assert.equal(env.task.prompt, 'BASE PROMPT\n\n---\n\nEXTRA');
});

test('normalizeTaskEnvelope: a plain appendPrompt variable also appends (no injected separator)', () => {
  const env = normalizeTaskEnvelope(
    { [`${AGENT_TASK_NS}.task.prompt`]: 'BASE' },
    { appendPrompt: 'SUFFIX' },
  );
  // Verbatim concat — the model owns any separator, so none is inserted by the harness.
  assert.equal(env.task.prompt, 'BASESUFFIX');
});

test('normalizeTaskEnvelope: a null/empty appendPrompt leaves the base prompt untouched', () => {
  const base = { [`${AGENT_TASK_NS}.task.prompt`]: 'BASE' };
  assert.equal(normalizeTaskEnvelope(base, { appendPrompt: null }).task.prompt, 'BASE');
  assert.equal(normalizeTaskEnvelope(base, { appendPrompt: '' }).task.prompt, 'BASE');
  assert.equal(normalizeTaskEnvelope(base, {}).task.prompt, 'BASE');
});

test('normalizeTaskEnvelope: appendPrompt also composes onto a base delivered as a plain prompt var', () => {
  const env = normalizeTaskEnvelope({}, { prompt: 'BASE', appendPrompt: '+MORE' });
  assert.equal(env.task.prompt, 'BASE+MORE');
});

// ---- Linked resources → live agent prompt (issue #63) ---------------------

test('normalizeTaskEnvelope: basePromptOverride (linked resource) wins over the header task.prompt', () => {
  const env = normalizeTaskEnvelope(
    { [`${AGENT_TASK_NS}.task.prompt`]: 'BAKED HEADER PROMPT' },
    { [`${AGENT_TASK_NS}.task.appendPrompt`]: '\n\n---\n\nEXTRA' },
    { basePromptOverride: 'LIVE RESOURCE PROMPT' },
  );
  // The override supplies the base; appendPrompt still concatenates verbatim.
  assert.equal(env.task.prompt, 'LIVE RESOURCE PROMPT\n\n---\n\nEXTRA');
});

test('normalizeTaskEnvelope: a null/absent basePromptOverride falls back to the header chain', () => {
  const headers = { [`${AGENT_TASK_NS}.task.prompt`]: 'BAKED' };
  assert.equal(normalizeTaskEnvelope(headers, {}, { basePromptOverride: null }).task.prompt, 'BAKED');
  assert.equal(normalizeTaskEnvelope(headers, {}, {}).task.prompt, 'BAKED');
  assert.equal(normalizeTaskEnvelope(headers, {}).task.prompt, 'BAKED');
});

test('normalizeTaskEnvelope: an empty-string basePromptOverride wins (resource resolved to empty)', () => {
  const env = normalizeTaskEnvelope(
    { [`${AGENT_TASK_NS}.task.prompt`]: 'BAKED' },
    {},
    { basePromptOverride: '' },
  );
  assert.equal(env.task.prompt, '');
});

test('parseLinkedResources: parses a JSON-string header, an array, and tolerates junk', () => {
  const arr = [{ resourceKey: '42', resourceType: 'RESOURCE', linkName: 'prompt' }];
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: JSON.stringify(arr) }), arr);
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: arr }), arr);
  assert.deepEqual(parseLinkedResources({}), []);
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: '' }), []);
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: 'not json' }), []);
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: '{"not":"array"}' }), []);
  // entries without a resourceKey are dropped
  assert.deepEqual(parseLinkedResources({ [LINKED_RESOURCES_HEADER]: '[{"linkName":"prompt"}]' }), []);
});

test('pickLinkedResource: selects the entry whose linkName matches (default prompt)', () => {
  const list = [
    { resourceKey: '1', linkName: 'schema' },
    { resourceKey: '2', linkName: 'prompt' },
    { resourceKey: '3', linkName: 'prompt' },
  ];
  assert.equal(pickLinkedResource(list).resourceKey, '2'); // first match wins
  assert.equal(pickLinkedResource(list, 'schema').resourceKey, '1');
  assert.equal(pickLinkedResource(list, 'absent'), null);
  assert.equal(pickLinkedResource([]), null);
  assert.equal(DEFAULT_PROMPT_LINK_NAME, 'prompt');
});

test('resourceContentUrl: builds the /content/binary endpoint, trimming a trailing slash', () => {
  assert.equal(
    resourceContentUrl('http://localhost:8080/', '42'),
    'http://localhost:8080/v2/resources/42/content/binary',
  );
  assert.equal(
    resourceContentUrl('http://localhost:8080', 'abc'),
    'http://localhost:8080/v2/resources/abc/content/binary',
  );
});

test('resolveBrokerRestConfig: env base URL + optional bearer token', () => {
  const keys = ['NANO_REST_URL', 'NANO_BASE_URL', 'NANO_REST_TOKEN', 'NANO_AGENTIC_URL', 'NANO_AGENTIC_SECRET', 'NANO_AGENTIC_TOKEN'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.NANO_REST_URL = 'http://broker:9999';
    process.env.NANO_REST_TOKEN = 'tok-123';
    const cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.baseUrl, 'http://broker:9999');
    assert.equal(cfg.token, 'tok-123');
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test('resolveBrokerRestConfig: agentic token only forwarded when same-origin as REST URL', () => {
  const keys = ['NANO_REST_URL', 'NANO_BASE_URL', 'NANO_REST_TOKEN', 'NANO_AGENTIC_URL', 'NANO_AGENTIC_SECRET', 'NANO_AGENTIC_TOKEN'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    // Different-origin REST host with only an agentic token set: no leak.
    process.env.NANO_REST_URL = 'http://broker:9999';
    process.env.NANO_AGENTIC_URL = 'http://hub:8080';
    process.env.NANO_AGENTIC_TOKEN = 'identity-tok';
    let cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.baseUrl, 'http://broker:9999');
    assert.equal(cfg.token, '', 'agentic token must not leak to a different-origin REST host');
    // Same-origin single-token deployment: agentic token IS forwarded.
    process.env.NANO_AGENTIC_URL = 'http://broker:9999';
    cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, 'identity-tok');
    // An explicit REST token always wins regardless of origin.
    process.env.NANO_AGENTIC_URL = 'http://hub:8080';
    process.env.NANO_REST_TOKEN = 'rest-tok';
    cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, 'rest-tok');
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test('resolveBrokerRestConfig: NANO_AGENTIC_SECRET honours same-origin gate and outranks legacy token', () => {
  const keys = ['NANO_REST_URL', 'NANO_BASE_URL', 'NANO_REST_TOKEN', 'NANO_AGENTIC_URL', 'NANO_AGENTIC_SECRET', 'NANO_AGENTIC_TOKEN'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    // (1) Different-origin REST host with only the identity secret set: no leak.
    process.env.NANO_REST_URL = 'http://broker:9999';
    process.env.NANO_AGENTIC_URL = 'http://hub:8080';
    process.env.NANO_AGENTIC_SECRET = 'ident-secret';
    let cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, '', 'agentic secret must not leak to a different-origin REST host');
    // (2) Same-origin single-token deployment: the identity secret IS forwarded.
    process.env.NANO_AGENTIC_URL = 'http://broker:9999';
    cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, 'ident-secret', 'agentic secret forwarded same-origin');
    // (3) Secret outranks the legacy NANO_AGENTIC_TOKEN alias when both are set.
    process.env.NANO_AGENTIC_TOKEN = 'legacy-tok';
    cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, 'ident-secret', 'NANO_AGENTIC_SECRET wins over the legacy NANO_AGENTIC_TOKEN alias');
    // An explicit REST token still wins over everything, regardless of origin.
    process.env.NANO_AGENTIC_URL = 'http://hub:8080';
    process.env.NANO_REST_TOKEN = 'rest-tok';
    cfg = resolveBrokerRestConfig(process.env);
    assert.equal(cfg.token, 'rest-tok');
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test('fetchLinkedResourceContent: GETs /content/binary and decodes UTF-8 (with bearer when set)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => 'LIVE PROMPT BODY' };
  };
  const body = await fetchLinkedResourceContent('77', { baseUrl: 'http://b', token: 'T', fetchImpl });
  assert.equal(body, 'LIVE PROMPT BODY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://b/v2/resources/77/content/binary');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer T');
});

test('fetchLinkedResourceContent: no Authorization header when unauthenticated', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init; return { ok: true, status: 200, text: async () => 'x' }; };
  await fetchLinkedResourceContent('1', { baseUrl: 'http://b', token: '', fetchImpl });
  assert.equal(seen.headers.Authorization, undefined);
});

test('fetchLinkedResourceContent: a non-2xx (e.g. 406/404) throws a provisioning error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 406, text: async () => '' });
  await assert.rejects(
    () => fetchLinkedResourceContent('9', { baseUrl: 'http://b', fetchImpl }),
    /prompt resource 9 fetch failed: HTTP 406/,
  );
});

test('fetchLinkedResourceContent: a network error throws a provisioning error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => fetchLinkedResourceContent('9', { baseUrl: 'http://b', fetchImpl }),
    /prompt resource 9 fetch failed: ECONNREFUSED/,
  );
});

test('resolveLinkedPrompt: returns null when the job declares no prompt link (fallback path)', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const out = await resolveLinkedPrompt({}, { baseUrl: 'http://b', fetchImpl });
  assert.equal(out, null);
  const out2 = await resolveLinkedPrompt(
    { [LINKED_RESOURCES_HEADER]: '[{"resourceKey":"5","linkName":"schema"}]' },
    { baseUrl: 'http://b', fetchImpl },
  );
  assert.equal(out2, null);
});

test('resolveLinkedPrompt: fetches the prompt-linked resource and returns its content + key', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://b/v2/resources/42/content/binary');
    return { ok: true, status: 200, text: async () => '# Live prompt' };
  };
  const out = await resolveLinkedPrompt(
    { [LINKED_RESOURCES_HEADER]: JSON.stringify([{ resourceKey: '42', resourceType: 'RESOURCE', linkName: 'prompt' }]) },
    { baseUrl: 'http://b', fetchImpl },
  );
  assert.equal(out.basePrompt, '# Live prompt');
  assert.equal(out.resourceKey, '42');
  assert.equal(out.linkName, 'prompt');
});

test('resolveLinkedPrompt: a declared-but-unfetchable prompt resource propagates the provisioning error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' });
  await assert.rejects(
    () => resolveLinkedPrompt(
      { [LINKED_RESOURCES_HEADER]: JSON.stringify([{ resourceKey: '7', linkName: 'prompt' }]) },
      { baseUrl: 'http://b', fetchImpl },
    ),
    /prompt resource 7 fetch failed: HTTP 404/,
  );
});

test('fetchLinkedResourceContent: authHeaders map wins over token and is forwarded verbatim', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init; return { ok: true, status: 200, text: async () => 'x' }; };
  await fetchLinkedResourceContent('1', {
    baseUrl: 'http://b',
    token: 'IGNORED',
    authHeaders: { Authorization: 'Bearer FROM_CLIENT', 'X-Extra': '1' },
    fetchImpl,
  });
  assert.equal(seen.headers.Authorization, 'Bearer FROM_CLIENT');
  assert.equal(seen.headers['X-Extra'], '1');
});

test('fetchLinkedResourceContent: an empty authHeaders map means unauthenticated (no Authorization)', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init; return { ok: true, status: 200, text: async () => 'x' }; };
  // A NONE-auth client returns {}; it must win over a stray token → no header sent.
  await fetchLinkedResourceContent('1', { baseUrl: 'http://b', token: 'STRAY', authHeaders: {}, fetchImpl });
  assert.equal(seen.headers.Authorization, undefined);
});

test('normalizeRestBase: strips trailing slashes and an optional /v2 so resourceContentUrl re-adds it once', () => {
  assert.equal(normalizeRestBase('http://merlin.local:8080/v2'), 'http://merlin.local:8080');
  assert.equal(normalizeRestBase('http://merlin.local:8080/v2/'), 'http://merlin.local:8080');
  assert.equal(normalizeRestBase('http://merlin.local:8080/'), 'http://merlin.local:8080');
  assert.equal(normalizeRestBase('http://merlin.local:8080'), 'http://merlin.local:8080');
  // Round-trip: the normalized base yields exactly one /v2 in the content URL.
  assert.equal(
    resourceContentUrl(normalizeRestBase('http://merlin.local:8080/v2'), '42'),
    'http://merlin.local:8080/v2/resources/42/content/binary',
  );
});

test('resolveLinkedPromptSource: derives base + auth from the activating client', async () => {
  await withCleanAutoHome(async () => {
      const camunda = {
        getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }),
        getAuthHeaders: async () => ({ Authorization: 'Bearer CLIENT_TOKEN' }),
      };
      const src = await resolveLinkedPromptSource(camunda, {});
      assert.equal(src.baseUrl, 'http://merlin.local:8080');
      assert.deepEqual(src.authHeaders, { Authorization: 'Bearer CLIENT_TOKEN' });
  });
});

test('resolveLinkedPromptSource: NANO_REST_URL / NANO_REST_TOKEN override the client (operator escape hatch)', async () => {
  await withCleanAutoHome(async () => {
      const camunda = {
        getConfig: () => ({ restAddress: 'http://should-not-use:8080' }),
        getAuthHeaders: async () => ({ Authorization: 'Bearer CLIENT' }),
      };
      const src = await resolveLinkedPromptSource(camunda, {
        NANO_REST_URL: 'http://override:9000',
        NANO_REST_TOKEN: 'OP',
      });
      assert.equal(src.baseUrl, 'http://override:9000');
      assert.deepEqual(src.authHeaders, { Authorization: 'Bearer OP' });
  });
});

test('resolveLinkedPromptSource: a client without getConfig/getAuthHeaders degrades gracefully (no throw)', async () => {
  await withCleanAutoHome(async () => {
    // With no explicit override and no usable profile, the shared resolver
    // degrades to the localhost default (never throws); the caller then reuses it
    // in place of the old empty-string sentinel.
    const src = await resolveLinkedPromptSource({}, {});
    assert.equal(src.baseUrl, 'http://localhost:8080');
    assert.equal(src.authHeaders, undefined);
    // A throwing client is swallowed, not propagated.
    const throwing = { getConfig: () => { throw new Error('boom'); }, getAuthHeaders: async () => { throw new Error('boom'); } };
    const src2 = await resolveLinkedPromptSource(throwing, {});
    assert.equal(src2.baseUrl, 'http://localhost:8080');
    assert.equal(src2.authHeaders, undefined);
  });
});

test('resolveLinkedPromptSource: a pre-resolved baseUrl is reused verbatim (no config read) while auth is still resolved per call', async () => {
  await withCleanAutoHome(async () => {
    // The per-job hot path passes the once-at-startup resolveWorkerEngineBase
    // result so the resolver skips its own config.json read. The pre-resolved
    // base must win over what the client's profile would otherwise yield, and
    // auth headers must still come from the (possibly rotating) client.
    const camunda = {
      getConfig: () => ({ restAddress: 'http://should-not-use:8080/v2' }),
      getAuthHeaders: async () => ({ Authorization: '******' }),
    };
    const src = await resolveLinkedPromptSource(camunda, {}, { baseUrl: 'http://pre-resolved:8080' });
    assert.equal(src.baseUrl, 'http://pre-resolved:8080');
    assert.deepEqual(src.authHeaders, { Authorization: '******' });
  });
});

// ---------------------------------------------------------------------------
// resolveAutoRestConfig — the `--auto` engine-read base must follow the ACTIVE
// c8ctl profile (the same client that activates jobs), never a localhost
// default (jwulf/c8ctl-plugin-nano#93). Run each case under a throwaway
// C8CTL_NANO_HOME with no config.json so readConfig() yields {} (no stray
// cfg.nanoUrl), and with the NANO_* env override keys cleared.
// ---------------------------------------------------------------------------
const AUTO_ENV_KEYS = [
  'NANO_REST_URL', 'NANO_BASE_URL', 'NANO_REST_TOKEN',
  'NANO_AGENTIC_URL', 'NANO_AGENTIC_SECRET', 'NANO_AGENTIC_TOKEN',
];

function withCleanAutoHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-auto-route-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEnv = Object.fromEntries(AUTO_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.C8CTL_NANO_HOME = home;
  for (const k of AUTO_ENV_KEYS) delete process.env[k];
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prevHome;
    for (const k of AUTO_ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    rmSync(home, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(home);
  } catch (err) {
    cleanup();
    throw err;
  }
  // Defer cleanup until an async callback settles so its env/home isolation
  // outlives its awaits; a sync callback cleans up immediately.
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(cleanup);
  }
  cleanup();
  return result;
}

// RED (route): with no explicit override, the `--auto` reader base is derived
// from the activating client's profile REST address, NOT http://localhost:8080.
test('resolveAutoRestConfig: derives the base from the active c8ctl profile (not localhost)', () => {
  withCleanAutoHome(() => {
    const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
    const cfg = resolveAutoRestConfig(camunda, process.env);
    assert.equal(cfg.baseUrl, 'http://merlin.local:8080');
    assert.notEqual(cfg.baseUrl, 'http://localhost:8080');
  });
});

// GUARD (parity): the `--auto` job-type reader and the job-activation client
// MUST resolve to the same base URL for a given profile — they must never
// diverge. defaultC8RestReader builds its restAddress as `${baseUrl}/v2`, so
// that reconstructed address must equal the client's own restAddress.
test('resolveAutoRestConfig: reader base matches the job-activation client base (no divergence)', () => {
  withCleanAutoHome(() => {
    const restAddress = 'http://merlin.local:8080/v2';
    const camunda = { getConfig: () => ({ restAddress }) };
    const cfg = resolveAutoRestConfig(camunda, process.env);
    // Mirror defaultC8RestReader's `${base}/v2` construction.
    const readerAddress = `${String(cfg.baseUrl).replace(/\/+$/, '')}/v2`;
    assert.equal(readerAddress, restAddress);
  });
});

// An explicit NANO_REST_URL / NANO_BASE_URL / cfg.nanoUrl override still wins
// over the profile (operator escape hatch) — matching resolveBrokerRestConfig
// precedence and the workaround documented in the issue.
test('resolveAutoRestConfig: explicit NANO_REST_URL overrides the profile', () => {
  withCleanAutoHome(() => {
    process.env.NANO_REST_URL = 'http://override:9000';
    const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
    const cfg = resolveAutoRestConfig(camunda, process.env);
    assert.equal(cfg.baseUrl, 'http://override:9000');
  });
});

test('resolveAutoRestConfig: cfg.nanoUrl override (the documented band-aid) wins over the profile', () => {
  withCleanAutoHome((home) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ nanoUrl: 'http://from-config:8080' }));
    const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
    const cfg = resolveAutoRestConfig(camunda, process.env);
    assert.equal(cfg.baseUrl, 'http://from-config:8080');
  });
});

// A client without getConfig (or one that throws) degrades to the localhost
// default rather than throwing — the reader is still constructed, and the poll
// loop retries.
test('resolveAutoRestConfig: degrades to the localhost default when the client exposes no restAddress', () => {
  withCleanAutoHome(() => {
    assert.equal(resolveAutoRestConfig({}, process.env).baseUrl, 'http://localhost:8080');
    assert.equal(resolveAutoRestConfig(null, process.env).baseUrl, 'http://localhost:8080');
    const throwing = { getConfig: () => { throw new Error('boom'); } };
    assert.equal(resolveAutoRestConfig(throwing, process.env).baseUrl, 'http://localhost:8080');
  });
});

// ---------------------------------------------------------------------------
// resolveWorkerEngineBase — the ONE canonical worker engine-base resolver that
// every site (job read, linked-prompt fetch, status column, agentic channel)
// derives from (jwulf/c8ctl-plugin-nano#107). Precedence:
//   explicit override (NANO_REST_URL → NANO_BASE_URL → cfg.nanoUrl)
//     → active c8ctl profile restAddress → localhost default.
// ---------------------------------------------------------------------------
test('resolveWorkerEngineBase: profile-only (no NANO_*/nanoUrl) resolves to the profile restAddress', () => {
  withCleanAutoHome(() => {
    const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
    assert.equal(resolveWorkerEngineBase(camunda, process.env), 'http://merlin.local:8080');
  });
});

test('resolveWorkerEngineBase: explicit NANO_REST_URL / NANO_BASE_URL / cfg.nanoUrl win over the profile', () => {
  withCleanAutoHome((home) => {
    const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
    assert.equal(
      resolveWorkerEngineBase(camunda, { NANO_REST_URL: 'http://rest-override:9000' }),
      'http://rest-override:9000',
    );
    assert.equal(
      resolveWorkerEngineBase(camunda, { NANO_BASE_URL: 'http://base-override:9100' }),
      'http://base-override:9100',
    );
    writeFileSync(join(home, 'config.json'), JSON.stringify({ nanoUrl: 'http://from-config:8080' }));
    assert.equal(resolveWorkerEngineBase(camunda, {}), 'http://from-config:8080');
  });
});

test('resolveWorkerEngineBase: no override + no usable profile → localhost default (never throws)', () => {
  withCleanAutoHome(() => {
    assert.equal(resolveWorkerEngineBase(undefined, {}), 'http://localhost:8080');
    assert.equal(resolveWorkerEngineBase({}, {}), 'http://localhost:8080');
    const throwing = { getConfig: () => { throw new Error('boom'); } };
    assert.equal(resolveWorkerEngineBase(throwing, {}), 'http://localhost:8080');
  });
});

test('buildResultEnvelope: records the resolved promptResourceKey for audit', () => {
  const withKey = buildResultEnvelope({ ok: true, stdout: '' }, { sandbox: 'none', promptResourceKey: '42' });
  assert.equal(withKey.promptResourceKey, '42');
  const without = buildResultEnvelope({ ok: true, stdout: '' }, { sandbox: 'none' });
  assert.equal('promptResourceKey' in without, false);
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

test('resolveJobSecrets: allowPr pulls the github default credential from gh when GITHUB_TOKEN is absent', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const env = normalizeTaskEnvelope(
      {
        [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
        [`${AGENT_TASK_NS}.task.allowPr`]: 'true',
      },
      {},
    );
    const { resolved, missing } = resolveJobSecrets(resolver, env, { ghAuthToken: () => 'gh-cli-tok' });
    assert.equal(resolved.GITHUB_TOKEN, 'gh-cli-tok');
    assert.deepEqual(missing, []);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('resolveJobSecrets: GITHUB_TOKEN in secretRefs is not left in missing when gh fallback resolves it', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const env = normalizeTaskEnvelope(
      {
        [AGENT_TASK_NS]: JSON.stringify({
          repository: { url: 'https://github.com/o/r.git' },
          task: { allowPr: true },
          setup: { secretRefs: ['GITHUB_TOKEN'] },
        }),
      },
      {},
    );
    const { resolved, missing } = resolveJobSecrets(resolver, env, { ghAuthToken: () => 'gh-cli-tok' });
    assert.equal(resolved.GITHUB_TOKEN, 'gh-cli-tok');
    assert.deepEqual(missing, []);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('resolveJobSecrets: a custom github authRef does NOT fall back to gh (stays missing)', () => {
  const resolver = makeSecretResolver('host');
  const env = normalizeTaskEnvelope(
    {
      [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
      [`${AGENT_TASK_NS}.repository.authRef`]: 'MY_PAT',
      [`${AGENT_TASK_NS}.task.allowPr`]: 'true',
    },
    {},
  );
  const { missing } = resolveJobSecrets(resolver, env, { ghAuthToken: () => 'gh-cli-tok' });
  assert.deepEqual(missing, ['MY_PAT']);
});

test('resolveJobSecrets: a present-but-blank authRef is missing, never borrows gh/default', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-tok';
  try {
    const env = normalizeTaskEnvelope(
      {
        [`${AGENT_TASK_NS}.repository.url`]: 'https://github.com/o/r.git',
        [`${AGENT_TASK_NS}.repository.authRef`]: '   ',
        [`${AGENT_TASK_NS}.task.allowPr`]: 'true',
      },
      {},
    );
    const { resolved, missing } = resolveJobSecrets(resolver, env, { ghAuthToken: () => 'gh-cli-tok' });
    assert.deepEqual(missing, ['repository.authRef']);
    assert.equal(resolved.GITHUB_TOKEN, undefined);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('githubCloneToken: env GITHUB_TOKEN wins over gh fallback', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-tok';
  try {
    const tok = githubCloneToken({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => 'gh-tok' });
    assert.equal(tok, 'env-tok');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('githubCloneToken: falls back to gh when the default credential is absent', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const tok = githubCloneToken({ provider: 'github', authRef: undefined, secretResolver: resolver, ghAuthToken: () => 'gh-tok' });
    assert.equal(tok, 'gh-tok');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('githubCloneToken: a custom authRef never borrows the gh login', () => {
  const resolver = makeSecretResolver('host');
  const tok = githubCloneToken({ provider: 'github', authRef: 'MY_PAT', secretResolver: resolver, ghAuthToken: () => 'gh-tok' });
  assert.equal(tok, null);
});

test('githubCloneToken: a present-but-blank authRef never borrows gh/default', () => {
  const resolver = makeSecretResolver('host');
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-tok';
  try {
    const tok = githubCloneToken({ provider: 'github', authRef: '   ', secretResolver: resolver, ghAuthToken: () => 'gh-tok' });
    assert.equal(tok, null);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('primeGhAuthToken warms the cache and is idempotent', () => {
  // Populates the process-lifetime cache (to a token or null, depending on the
  // host's gh state) and always reports the cache as populated afterwards. A
  // second call is a warm cache hit that returns the same result without error.
  assert.equal(primeGhAuthToken(), true);
  const first = ghAuthTokenFromCli();
  assert.equal(primeGhAuthToken(), true);
  assert.equal(ghAuthTokenFromCli(), first);
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

// --- Structured agent result channel ($AGENT_RESULT_FILE + fallback) ---------

test('parseAgentResultObject accepts only plain JSON objects', () => {
  assert.deepEqual(parseAgentResultObject('{"status":"converged"}'), { status: 'converged' });
  assert.equal(parseAgentResultObject(''), null);
  assert.equal(parseAgentResultObject('   '), null);
  assert.equal(parseAgentResultObject('not json'), null);
  assert.equal(parseAgentResultObject('[1,2,3]'), null, 'arrays are not result objects');
  assert.equal(parseAgentResultObject('42'), null);
  assert.equal(parseAgentResultObject('null'), null);
});

test('readAgentResultFile reads the file the agent wrote, tolerating absence/garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'res-'));
  try {
    const p = join(dir, 'result.json');
    assert.equal(readAgentResultFile(p), null, 'missing file → null');
    assert.equal(readAgentResultFile(null), null);
    writeFileSync(p, '{"status":"needs_input","question":"which base branch?"}');
    assert.deepEqual(readAgentResultFile(p), { status: 'needs_input', question: 'which base branch?' });
    writeFileSync(p, 'corrupt {');
    assert.equal(readAgentResultFile(p), null, 'malformed file → null, never throws');
    // Oversized agent output is refused (DoS guard) rather than read into memory.
    writeFileSync(p, `{"status":"${'x'.repeat(1_100_000)}"}`);
    assert.equal(readAgentResultFile(p), null, 'file over the size cap → null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseResultFromStdout prefers the last sentinel line, then the last json fence', () => {
  // Sentinel wins and "last wins" supersedes an earlier draft.
  const withSentinel = [
    'thinking out loud...',
    `${RESULT_SENTINEL} {"status":"addressed"}`,
    'more chatter',
    `${RESULT_SENTINEL} {"status":"converged","summary":"all resolved"}`,
  ].join('\n');
  assert.deepEqual(parseResultFromStdout(withSentinel), { status: 'converged', summary: 'all resolved' });

  // No sentinel → fall back to the last fenced block (CRLF-tolerant, tag optional).
  const withFence = 'prose\r\n```json\r\n{"status":"blocked"}\r\n```\r\ntrailing\r\n';
  assert.deepEqual(parseResultFromStdout(withFence), { status: 'blocked' });
  const untagged = 'prose\n```\n{"status":"converged"}\n```\n';
  assert.deepEqual(parseResultFromStdout(untagged), { status: 'converged' });

  assert.equal(parseResultFromStdout('just a transcript, no result'), null);
  assert.equal(parseResultFromStdout(''), null);
});

test('sanitizeResultVars strips harness-reserved keys and the io.nanobpm namespace', () => {
  const vars = sanitizeResultVars({
    status: 'converged',
    summary: 'ok',
    output: 'agent tried to clobber capture',
    exitCode: 137,
    agent: 'impostor',
    truncated: true,
    branch: 'evil',
    [AGENT_RESULT_KEY]: { forged: true },
    'io.nanobpm.somethingElse': 1,
  });
  assert.deepEqual({ ...vars }, { status: 'converged', summary: 'ok' });
  for (const k of RESERVED_RESULT_KEYS) assert.equal(k in vars, false, `${k} must be stripped`);
  assert.deepEqual(sanitizeResultVars(null), {});
  assert.deepEqual(sanitizeResultVars('nope'), {});
});

test('sanitizeResultVars is prototype-pollution safe with untrusted agent output', () => {
  // A malicious agent returns __proto__/constructor/prototype keys.
  const vars = sanitizeResultVars(JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"status":"ok"}'));
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(Object.getPrototypeOf(vars), null, 'result is a null-prototype object');
  assert.equal('__proto__' in vars, false);
  assert.equal('constructor' in vars, false);
  assert.equal('prototype' in vars, false);
  assert.equal(vars.status, 'ok', 'benign keys survive');
});

test('buildResultEnvelope preserves the parsed agent result for audit', () => {
  const env = buildResultEnvelope(
    { ok: true, stdout: 'transcript', exitCode: 0 },
    { sandbox: 'none', result: { status: 'converged', summary: 'done' } },
  );
  assert.deepEqual(env.result, { status: 'converged', summary: 'done' });
  const none = buildResultEnvelope({ ok: true, stdout: '', exitCode: 0 }, { sandbox: 'none' });
  assert.equal('result' in none, false, 'no result key when the agent returned nothing');
});


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

test('finalizeGit pushes the first commit into an empty repo (no base sha)', { skip: !gitOk }, () => {
  const root = mkdtempSync(join(tmpdir(), 'nano-git-'));
  const origin = join(root, 'origin.git');
  g(['init', '-q', '--bare', origin], undefined);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: '', create: 'feat/first', push: true },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(prov.workingBranch, 'feat/first');
    assert.equal(prov.startSha, '', 'an empty repo has no initial commit');

    // Simulate the harness making the repo's first commit.
    writeFileSync(join(prov.workspaceDir, 'hello.txt'), 'hi\n');
    g(['add', '-A'], prov.workspaceDir);
    g(['-c', 'user.name=nano', '-c', 'user.email=nano@example.com', 'commit', '-q', '-m', 'first'], prov.workspaceDir);

    const out = finalizeGit({ ...prov, envelope, token: null });
    assert.equal(out.commits.length, 1, 'the first commit is enumerated even without a base sha');
    assert.equal(out.pushed, true, 'the branch is pushed');
    assert.equal(out.pushError, undefined);
    // the branch now exists on the origin
    assert.equal(g(['-c', 'safe.bareRepository=all', 'rev-parse', '--verify', 'refs/heads/feat/first'], origin).length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo checks out a commit SHA via repository.sha (detached, not via --branch)', { skip: !gitOk }, () => {
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
      repository: { provider: 'github', url: origin, sha: firstSha, submodules: false },
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

test('provisionRepo rejects a non-hex repository.sha with a ProvisionError (issue #91 review)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    for (const badSha of ['--upload-pack=evil', 'not-a-sha', 'zzzz', 'HEAD~1']) {
      const envelope = {
        schemaVersion: 1,
        repository: { provider: 'github', url: origin, sha: badSha, submodules: false },
        branch: { base: '', create: '', push: false },
        setup: { commands: [], env: {}, secretRefs: [] },
        task: { allowPr: false },
      };
      assert.throws(() => provisionRepo({ envelope, token: null, runDir }), (err) => {
        assert.ok(err instanceof ProvisionError, `${badSha} throws ProvisionError`);
        assert.match(err.message, /repository\.sha/, 'names the offending field');
        return true;
      }, `non-hex sha ${JSON.stringify(badSha)} is rejected fast`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo treats a hex-like ref as a branch, not a SHA (issue #91 review)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  // A legitimately-named branch whose name looks like a hex SHA. The old
  // "any hex-looking ref is a SHA" heuristic would skip `--branch`, then
  // `git fetch origin deadbeef` / `git checkout --detach deadbeef` would fail.
  const hexBranch = 'deadbeef';
  const wc = mkdtempSync(join(root, 'wc-hexref-'));
  g(['clone', '-q', origin, wc], undefined);
  g(['config', 'user.name', 'seed'], wc);
  g(['config', 'user.email', 'seed@example.com'], wc);
  g(['checkout', '-q', '-b', hexBranch], wc);
  writeFileSync(join(wc, 'hexbranch.txt'), 'hex\n');
  g(['add', '-A'], wc);
  g(['commit', '-q', '-m', 'hex branch commit'], wc);
  g(['push', '-q', 'origin', hexBranch], wc);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: hexBranch, submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.ok(existsSync(join(prov.workspaceDir, 'hexbranch.txt')), 'the hex-named branch is checked out via --branch');
    assert.equal(prov.workingBranch, hexBranch, 'HEAD is on the branch, not a detached SHA');
    assert.equal(prov.detached, false, 'a hex-named branch ref is not a detached checkout');
    assert.equal(prov.ref, hexBranch, 'exposes the branch ref, not a raw sha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo honors singleBranch + filter and fetches the base for a base...head diff (issue #91)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  // Add a feature branch with an extra commit on top of main.
  const wc = mkdtempSync(join(root, 'wc2-'));
  g(['clone', '-q', origin, wc], undefined);
  g(['config', 'user.name', 'seed'], wc);
  g(['config', 'user.email', 'seed@example.com'], wc);
  g(['checkout', '-q', '-b', 'feat/x'], wc);
  writeFileSync(join(wc, 'feature.txt'), 'feature\n');
  g(['add', '-A'], wc);
  g(['commit', '-q', '-m', 'feature commit'], wc);
  g(['push', '-q', 'origin', 'feat/x'], wc);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'feat/x', singleBranch: true, filter: 'blob:none', baseRef: 'main', submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.ok(existsSync(join(prov.workspaceDir, 'feature.txt')), 'the feature branch is checked out');
    // singleBranch restricts the fetch refspec to just the ref branch.
    const fetchRefspecs = g(['config', '--get-all', 'remote.origin.fetch'], prov.workspaceDir);
    assert.match(fetchRefspecs, /feat\/x/, 'single-branch clone tracks only the ref branch');
    // filter records a partial-clone filter on the remote.
    assert.equal(g(['config', 'remote.origin.partialclonefilter'], prov.workspaceDir), 'blob:none', 'partial clone filter is set');
    // The base was fetched and is exposed for a base...head diff.
    assert.equal(prov.base, 'origin/main');
    assert.equal(prov.baseFetchError, undefined, 'base fetch succeeded');
    assert.match(g(['rev-parse', 'origin/main'], prov.workspaceDir), /^[0-9a-f]{40}$/, 'origin/main resolves after the base fetch');
    const diff = g(['diff', '--name-only', 'origin/main...HEAD'], prov.workspaceDir);
    assert.equal(diff, 'feature.txt', 'base...head diff computes the feature change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo treats a hex-like baseRef as a branch, not a SHA (issue #91 review)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  // A legitimately-named branch whose name looks like a hex SHA. The heuristic
  // "any hex-looking baseRef is a SHA" would fetch it by id and skip creating
  // refs/remotes/origin/<baseRef>, breaking origin/<base> diffs.
  const hexBranch = 'deadbeef';
  const wc = mkdtempSync(join(root, 'wc-hex-'));
  g(['clone', '-q', origin, wc], undefined);
  g(['config', 'user.name', 'seed'], wc);
  g(['config', 'user.email', 'seed@example.com'], wc);
  g(['checkout', '-q', '-b', hexBranch], wc);
  g(['push', '-q', 'origin', hexBranch], wc);
  g(['checkout', '-q', '-b', 'feat/x', 'main'], wc);
  writeFileSync(join(wc, 'feature.txt'), 'feature\n');
  g(['add', '-A'], wc);
  g(['commit', '-q', '-m', 'feature commit'], wc);
  g(['push', '-q', 'origin', 'feat/x'], wc);
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'feat/x', singleBranch: true, baseRef: hexBranch, submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(prov.baseFetchError, undefined, 'the hex-like branch fetch succeeded');
    assert.equal(prov.base, `origin/${hexBranch}`, 'baseRef maps to origin/<baseRef>, not a raw sha');
    assert.match(g(['rev-parse', `origin/${hexBranch}`], prov.workspaceDir), /^[0-9a-f]{40}$/, 'refs/remotes/origin/<baseRef> was created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('provisionRepo records a non-fatal baseFetchError when the base ref is missing (issue #91)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, ref: 'main', singleBranch: true, baseRef: 'no-such-base', submodules: false },
      branch: { base: '', create: 'feat/y', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.ok(existsSync(join(prov.workspaceDir, 'README.md')), 'the head clone still succeeded');
    assert.equal(prov.base, '', 'no usable base when the base fetch fails');
    assert.ok(prov.baseFetchError, 'a missing base ref is reported, not thrown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo records a non-fatal baseFetchError (and skips the fetch) when both baseRef and baseSha are set (issue #91 review)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    const envelope = {
      schemaVersion: 1,
      // Ambiguous envelope: baseRef and baseSha are mutually exclusive. Rather
      // than silently prefer one (a surprising base...head diff), skip the fetch
      // and surface the ambiguity as a non-fatal diagnostic.
      repository: { provider: 'github', url: origin, ref: 'main', singleBranch: true, baseRef: 'main', baseSha: 'deadbeef', submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.ok(existsSync(join(prov.workspaceDir, 'README.md')), 'the head clone still succeeded');
    assert.equal(prov.base, '', 'no base is chosen when the envelope is ambiguous');
    assert.match(prov.baseFetchError, /ambiguous base.*baseRef.*baseSha/, 'the ambiguity is reported, not thrown');
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

test('describeGitFailure reports a timeout-kill (SIGTERM) with the duration and preserves last output', () => {
  const msg = describeGitFailure('git clone', {
    status: 128,
    signal: 'SIGTERM',
    stdout: "Cloning into '/tmp/ws'...",
    stderr: '',
  }, { token: null, timeoutMs: 120_000 });
  assert.match(msg, /timed out/, 'must say it timed out');
  assert.match(msg, /after 120s/, 'must state how long');
  assert.match(msg, /SIGTERM/, 'must name the kill signal');
  assert.match(msg, /Cloning into/, 'must preserve the last flushed git output');
  assert.doesNotMatch(msg, /failed \(exit/, 'a timeout must not be reported as a plain exit failure');
});

test('describeGitFailure captures BOTH streams so a fatal on stdout survives a noisy stderr', () => {
  // stderr carries only git's useless progress line; the real reason is on stdout.
  const msg = describeGitFailure('git clone', {
    status: 128,
    signal: null,
    stderr: "Cloning into '/tmp/ws'...",
    stdout: 'fatal: could not read Username for https://github.com: terminal prompts disabled',
  }, { token: null, timeoutMs: 120_000 });
  assert.match(msg, /failed \(exit 128\)/, 'a git-reported failure names the exit code');
  assert.match(msg, /fatal: could not read Username/, 'the real reason on stdout must survive');
});

test('describeGitFailure redacts the token from both streams', () => {
  const msg = describeGitFailure('git clone', {
    status: 128,
    signal: null,
    stderr: 'fatal: unable to access https://x-access-token:supersecret@github.com/o/r',
    stdout: 'supersecret leaked here too',
  }, { token: 'supersecret', timeoutMs: 120_000 });
  assert.equal(msg.includes('supersecret'), false, 'token must never appear in the failure reason');
});

test('boundGitOutput keeps head+tail instead of decapitating a long multiline error', () => {
  const head = 'fatal: the real reason is right here at the top';
  const tail = 'hint: and important recovery detail lives at the very bottom';
  const long = head + '\n' + 'x'.repeat(2000) + '\n' + tail;
  const bounded = boundGitOutput(long, 500);
  assert.ok(bounded.length <= 500, 'stays within the bound');
  assert.match(bounded, /the real reason is right here/, 'keeps the head');
  assert.match(bounded, /recovery detail lives at the very bottom/, 'keeps the tail');
  assert.match(bounded, /\[…\]/, 'marks the elision');
});

test('boundGitOutput never exceeds max even when max is smaller than the elision marker', () => {
  const long = 'x'.repeat(2000);
  for (const max of [0, 1, 3, 5, 6, 7]) {
    const bounded = boundGitOutput(long, max);
    assert.ok(bounded.length <= max, `max=${max}: stays within the bound (got ${bounded.length})`);
  }
});

test('describeGitFailure reports a non-timeout signal (e.g. SIGKILL) as a termination, not a timeout', () => {
  const msg = describeGitFailure('git clone', {
    status: 128,
    signal: 'SIGKILL',
    stdout: 'fatal: out of memory',
    stderr: '',
  }, { token: null, timeoutMs: 120_000 });
  assert.match(msg, /terminated by signal SIGKILL/, 'must name the signal');
  assert.doesNotMatch(msg, /timed out/, 'a SIGKILL/OOM kill must not be reported as a timeout');
  assert.match(msg, /out of memory/, 'must preserve the captured output');
});

test('provisionRepo: an anonymous credential-less clone fails fast with a fatal reason (no hang)', { skip: !gitOk }, () => {
  const root = mkdtempSync(join(tmpdir(), 'nano-git-'));
  const runDir = mkdtempSync(join(root, 'run-'));
  try {
    // Deterministic + offline: a non-existent local path (no network). On the
    // anonymous path provisionRepo sets GIT_TERMINAL_PROMPT=0 and strips every
    // askpass helper, so git must emit a `fatal:` at once instead of blocking on
    // a credential prompt to the timeout. Asserting the fail-fast behaviour here
    // (rather than hitting github.com) keeps the test hermetic and CI-stable.
    const missing = join(root, 'does-not-exist.git');
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: missing, submodules: false },
      branch: { base: '', create: '', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const started = Date.now();
    assert.throws(() => provisionRepo({ envelope, token: null, runDir, timeoutMs: 60_000 }), (err) => {
      assert.ok(err instanceof ProvisionError);
      assert.match(err.message, /git clone/);
      assert.doesNotMatch(err.message, /timed out/, 'a credential-less clone must fail fast, not time out');
      return true;
    });
    assert.ok(Date.now() - started < 55_000, 'must fail well before the timeout');
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

test('resolveCommitterIdentity: prefers operator identity over the nano-agent fallback', () => {
  const savedName = process.env.GIT_AUTHOR_NAME;
  const savedEmail = process.env.GIT_AUTHOR_EMAIL;
  try {
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;

    // git global config wins over gh, and gh is not even consulted.
    let ghCalls = 0;
    const gh = () => { ghCalls++; return { name: 'GH User', email: 'gh@example.com' }; };
    const fromGit = resolveCommitterIdentity({
      gitIdentity: () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
      ghIdentity: gh,
    });
    assert.deepEqual({ name: fromGit.name, email: fromGit.email, source: fromGit.source },
      { name: 'Ada Lovelace', email: 'ada@example.com', source: 'git-global' });
    assert.equal(ghCalls, 0, 'gh not consulted when git config supplies both fields');

    // gh fills in fields git config lacks (single lookup).
    ghCalls = 0;
    const fromGh = resolveCommitterIdentity({
      gitIdentity: () => ({ name: '', email: '' }),
      ghIdentity: gh,
    });
    assert.deepEqual({ name: fromGh.name, email: fromGh.email, source: fromGh.source },
      { name: 'GH User', email: 'gh@example.com', source: 'gh' });
    assert.equal(ghCalls, 1, 'gh consulted at most once');

    // Nothing resolvable ⇒ the nano-agent fallback (unsigned bot identity).
    const fallback = resolveCommitterIdentity({
      gitIdentity: () => ({ name: '', email: '' }),
      ghIdentity: () => ({ name: '', email: '' }),
    });
    assert.deepEqual({ name: fallback.name, email: fallback.email, source: fallback.source },
      { name: 'nano-agent', email: 'nano-agent@users.noreply.github.com', source: 'fallback' });

    // Explicit GIT_AUTHOR_* env overrides everything (per field), and neither the
    // git-config nor gh lookups are consulted when env fully supplies both fields.
    process.env.GIT_AUTHOR_NAME = 'Env Name';
    process.env.GIT_AUTHOR_EMAIL = 'env@example.com';
    ghCalls = 0;
    let gitCalls = 0;
    const gitSpy = () => { gitCalls++; return { name: 'Ada', email: 'ada@example.com' }; };
    const fromEnv = resolveCommitterIdentity({
      gitIdentity: gitSpy,
      ghIdentity: gh,
    });
    assert.deepEqual({ name: fromEnv.name, email: fromEnv.email, source: fromEnv.source },
      { name: 'Env Name', email: 'env@example.com', source: 'env' });
    assert.equal(gitCalls, 0, 'git config not consulted when env supplies both fields');
    assert.equal(ghCalls, 0, 'gh not consulted when env supplies both fields');
  } finally {
    if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = savedName;
    if (savedEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = savedEmail;
  }
});

test('isPlaceholderEmail: rejects non-routable placeholders, accepts real addresses', () => {
  // Non-routable / unattributable placeholders → rejected.
  assert.equal(isPlaceholderEmail('trial-merge@nano.local'), true);
  assert.equal(isPlaceholderEmail('agent@foo.local'), true);
  assert.equal(isPlaceholderEmail('x@build.internal'), true);
  assert.equal(isPlaceholderEmail('root@localhost'), true);
  assert.equal(isPlaceholderEmail('no-at-sign'), true);
  assert.equal(isPlaceholderEmail('user@'), true, 'empty domain — not routable');
  assert.equal(isPlaceholderEmail('@example.com'), true, 'empty local part — not attributable');
  assert.equal(isPlaceholderEmail('  bob@nano.local  '), true, 'whitespace-trimmed before matching');
  assert.equal(isPlaceholderEmail('BOB@Nano.Local'), true, 'case-insensitive');
  // Real, routable addresses (incl. GitHub noreply) → accepted.
  assert.equal(isPlaceholderEmail('ada@example.com'), false);
  assert.equal(isPlaceholderEmail('12345+octocat@users.noreply.github.com'), false);
  // Empty is not a "placeholder" — it is an absent field handled by per-field
  // fallthrough, so it must NOT invalidate a source outright.
  assert.equal(isPlaceholderEmail(''), false);
  assert.equal(isPlaceholderEmail(undefined), false);
});

test('resolveCommitterIdentity: a *@nano.local (or non-routable) author is never applied', () => {
  const savedName = process.env.GIT_AUTHOR_NAME;
  const savedEmail = process.env.GIT_AUTHOR_EMAIL;
  try {
    // The exact bug: launcher injects a placeholder GIT_AUTHOR_*. It must NOT be
    // stamped onto a commit — fall through to the gh-authenticated identity.
    process.env.GIT_AUTHOR_NAME = 'trial-merge';
    process.env.GIT_AUTHOR_EMAIL = 'trial-merge@nano.local';
    const fromGh = resolveCommitterIdentity({
      gitIdentity: () => ({ name: '', email: '' }),
      ghIdentity: () => ({ name: 'octocat', email: '12345+octocat@users.noreply.github.com' }),
    });
    assert.deepEqual(
      { name: fromGh.name, email: fromGh.email, source: fromGh.source },
      { name: 'octocat', email: '12345+octocat@users.noreply.github.com', source: 'gh' },
      'placeholder env author is discarded whole (no Frankenstein name), gh identity wins');

    // With no gh identity either, it falls all the way to the marked bot fallback —
    // never the *@nano.local placeholder.
    const fallback = resolveCommitterIdentity({
      gitIdentity: () => ({ name: '', email: '' }),
      ghIdentity: () => ({ name: '', email: '' }),
    });
    assert.equal(fallback.email.endsWith('@nano.local'), false);
    assert.deepEqual(
      { name: fallback.name, email: fallback.email, source: fallback.source },
      { name: 'nano-agent', email: 'nano-agent@users.noreply.github.com', source: 'fallback' });

    // A placeholder coming from git-global config is likewise rejected in favour
    // of the gh identity — the guard secures the whole class, not just env.
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    const overGitPlaceholder = resolveCommitterIdentity({
      gitIdentity: () => ({ name: 'trial-merge', email: 'trial-merge@nano.local' }),
      ghIdentity: () => ({ name: 'octocat', email: '12345+octocat@users.noreply.github.com' }),
    });
    assert.deepEqual(
      { name: overGitPlaceholder.name, email: overGitPlaceholder.email, source: overGitPlaceholder.source },
      { name: 'octocat', email: '12345+octocat@users.noreply.github.com', source: 'gh' });
  } finally {
    if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = savedName;
    if (savedEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = savedEmail;
  }
});

test('resolveCommitterIdentity: whitespace-only name/email fields fall through as absent', () => {
  const savedName = process.env.GIT_AUTHOR_NAME;
  const savedEmail = process.env.GIT_AUTHOR_EMAIL;
  try {
    // A launcher that injects space-padded/whitespace-only GIT_AUTHOR_* must not
    // have that blank value treated as "present" — it would block per-field
    // fallthrough and get stamped as an invalid commit identity. Blank fields
    // behave like absent, so the git-global identity fills them per field.
    process.env.GIT_AUTHOR_NAME = '   ';
    process.env.GIT_AUTHOR_EMAIL = '   ';
    const filled = resolveCommitterIdentity({
      gitIdentity: () => ({ name: 'Grace Hopper', email: 'grace@example.com' }),
      ghIdentity: () => ({ name: 'octocat', email: '12345+octocat@users.noreply.github.com' }),
    });
    assert.deepEqual(
      { name: filled.name, email: filled.email, source: filled.source },
      { name: 'Grace Hopper', email: 'grace@example.com', source: 'git-global' },
      'whitespace-only env fields are treated as absent and filled from git-global');

    // Space-padded but otherwise valid fields are trimmed rather than stamped raw.
    process.env.GIT_AUTHOR_NAME = '  Ada Lovelace  ';
    process.env.GIT_AUTHOR_EMAIL = '  ada@example.com  ';
    const trimmed = resolveCommitterIdentity({
      gitIdentity: () => ({ name: '', email: '' }),
      ghIdentity: () => ({ name: '', email: '' }),
    });
    assert.deepEqual(
      { name: trimmed.name, email: trimmed.email, source: trimmed.source },
      { name: 'Ada Lovelace', email: 'ada@example.com', source: 'env' },
      'space-padded env fields are trimmed, not stamped with surrounding whitespace');
  } finally {
    if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = savedName;
    if (savedEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = savedEmail;
  }
});

test('provisionRepo stamps the operator identity onto the workspace (commits as the human)', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  const savedName = process.env.GIT_AUTHOR_NAME;
  const savedEmail = process.env.GIT_AUTHOR_EMAIL;
  try {
    process.env.GIT_AUTHOR_NAME = 'Grace Hopper';
    process.env.GIT_AUTHOR_EMAIL = 'grace@example.com';
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: 'main', create: 'feat/ident', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    assert.equal(g(['config', 'user.name'], prov.workspaceDir), 'Grace Hopper');
    assert.equal(g(['config', 'user.email'], prov.workspaceDir), 'grace@example.com');
    // A commit the harness would make is authored as the operator, not nano-agent.
    writeFileSync(join(prov.workspaceDir, 'A.txt'), 'x\n');
    g(['add', '-A'], prov.workspaceDir);
    g(['commit', '-q', '-m', 'change'], prov.workspaceDir);
    assert.equal(g(['log', '-1', '--format=%an <%ae>'], prov.workspaceDir), 'Grace Hopper <grace@example.com>');
  } finally {
    if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = savedName;
    if (savedEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = savedEmail;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionRepo pins GIT_AUTHOR_*/GIT_COMMITTER_* env so a placeholder author is never stamped over config', { skip: !gitOk }, () => {
  const { root, origin } = makeOriginRepo();
  const runDir = mkdtempSync(join(root, 'run-'));
  const savedName = process.env.GIT_AUTHOR_NAME;
  const savedEmail = process.env.GIT_AUTHOR_EMAIL;
  const savedCName = process.env.GIT_COMMITTER_NAME;
  const savedCEmail = process.env.GIT_COMMITTER_EMAIL;
  try {
    // The launcher injects a non-routable placeholder author. Git honours
    // GIT_AUTHOR_* over user.name/user.email config, so without pinning it would
    // be stamped onto commits despite the clean identity config carries.
    process.env.GIT_AUTHOR_NAME = 'trial-merge';
    process.env.GIT_AUTHOR_EMAIL = 'trial-merge@nano.local';
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    const envelope = {
      schemaVersion: 1,
      repository: { provider: 'github', url: origin, submodules: false },
      branch: { base: 'main', create: 'feat/pin', push: false },
      setup: { commands: [], env: {}, secretRefs: [] },
      task: { allowPr: false },
    };
    const prov = provisionRepo({ envelope, token: null, runDir });
    // The resolved committer is placeholder-free, and gitEnv pins all four vars to it.
    assert.ok(!isPlaceholderEmail(prov.committer.email), 'resolved committer email is routable');
    assert.equal(prov.gitEnv.GIT_AUTHOR_NAME, prov.committer.name);
    assert.equal(prov.gitEnv.GIT_AUTHOR_EMAIL, prov.committer.email);
    assert.equal(prov.gitEnv.GIT_COMMITTER_NAME, prov.committer.name);
    assert.equal(prov.gitEnv.GIT_COMMITTER_EMAIL, prov.committer.email);
    // A commit made with the provisioned gitEnv (as finalizeGit's rebase would)
    // stamps the resolved identity, NOT the placeholder GIT_AUTHOR_* env.
    const env = { ...prov.gitEnv };
    writeFileSync(join(prov.workspaceDir, 'B.txt'), 'y\n');
    spawnSync('git', ['add', '-A'], { cwd: prov.workspaceDir, env, encoding: 'utf8' });
    spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: prov.workspaceDir, env, encoding: 'utf8' });
    const stamped = spawnSync('git', ['log', '-1', '--format=%ae%n%ce'], { cwd: prov.workspaceDir, env, encoding: 'utf8' }).stdout.trim().split('\n');
    for (const addr of stamped) {
      assert.notEqual(addr, 'trial-merge@nano.local', 'placeholder author/committer email is never stamped');
      assert.ok(!isPlaceholderEmail(addr), `stamped email ${addr} is routable`);
    }
  } finally {
    if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = savedName;
    if (savedEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = savedEmail;
    if (savedCName === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = savedCName;
    if (savedCEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL; else process.env.GIT_COMMITTER_EMAIL = savedCEmail;
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

test('parseJobTypeFlags: validates, dedupes, accepts token delimiters, scalars', () => {
  // Accepts rank:cap tokens, combined caps, and code-first flowId:task tokens.
  const ok = parseJobTypeFlags(['senior:pr-review', 'senior:pr-review+triage', 'convergence-loop:review-round']);
  assert.deepEqual(ok.jobTypes, ['senior:pr-review', 'senior:pr-review+triage', 'convergence-loop:review-round']);
  assert.deepEqual(ok.errors, []);

  // c8ctl may hand a scalar for a single flag occurrence.
  assert.deepEqual(parseJobTypeFlags('senior:pr-review').jobTypes, ['senior:pr-review']);

  // Dedupes repeats (and matrix union in workAgent dedupes again).
  assert.deepEqual(parseJobTypeFlags(['a:b', 'a:b']).jobTypes, ['a:b']);

  // Rejects empties and tokens with illegal characters, keeping the good ones.
  const bad = parseJobTypeFlags(['', '  ', 'has space', 'bad/slash', 'good.token']);
  assert.deepEqual(bad.jobTypes, ['good.token']);
  assert.equal(bad.errors.length, 4);

  // Absent input yields no job types and no errors.
  assert.deepEqual(parseJobTypeFlags(undefined), { jobTypes: [], errors: [] });
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

test('normalizeArgList coerces to a clean string[], dropping empties/nullish', () => {
  assert.deepEqual(normalizeArgList('--allow-all'), ['--allow-all'], 'a bare string is one arg');
  assert.deepEqual(normalizeArgList(['--a', '', null, undefined, '--b']), ['--a', '--b']);
  assert.deepEqual(normalizeArgList([1, true]), ['1', 'true'], 'non-strings are coerced');
  assert.deepEqual(normalizeArgList(undefined), []);
  assert.deepEqual(normalizeArgList('--foo=a b'), ['--foo=a b'], 'interior whitespace is preserved');
});

test('shQuote wraps a value as one shell-safe literal, escaping single quotes', () => {
  assert.equal(shQuote('--allow-all'), `'--allow-all'`);
  assert.equal(shQuote('a b'), `'a b'`, 'spaces stay inside one token');
  assert.equal(shQuote(`it's`), `'it'\\''s'`, 'embedded single quote is escaped');
  assert.equal(shQuote(''), `''`, 'empty string → empty literal');
});

test('buildAgentCommandLine appends shell-quoted args, verbatim when none', () => {
  assert.equal(buildAgentCommandLine('copilot', []), 'copilot', 'no args → command verbatim');
  assert.equal(buildAgentCommandLine('copilot', ['--allow-all']), `copilot '--allow-all'`);
  assert.equal(
    buildAgentCommandLine('copilot', ['--model', 'gpt-5', '--dir', 'a b']),
    `copilot '--model' 'gpt-5' '--dir' 'a b'`,
  );
  // A malicious arg can't break out of its literal (no injection).
  assert.equal(buildAgentCommandLine('copilot', ['; rm -rf /']), `copilot '; rm -rf /'`);
});

test('normalizeStoredProfile normalizes the args list', () => {
  const p = normalizeStoredProfile('coder', { rank: 'senior', command: 'copilot', args: ['--allow-all', '', null] });
  assert.deepEqual(p.profile.args, ['--allow-all']);
  const none = normalizeStoredProfile('coder', { rank: 'senior', command: 'copilot' });
  assert.deepEqual(none.profile.args, [], 'missing args → empty list');
});

test('runAgentJob (host) passes structured --arg switches to the harness', { skip: process.platform === 'win32' }, async () => {
  // The harness echoes its own argv (after the shell/-c script name), proving the
  // profile args are appended as distinct, shell-quoted tokens.
  const profile = { name: 'p', rank: 'senior', command: 'printf "%s|" "$@"', args: ['--allow-all', 'a b'], model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope: normalizeTaskEnvelope({}, {}),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true, result.error || result.stderr);
  // `sh -c 'printf "%s|" "$@"' <script0> --allow-all 'a b'` → "$@" is the args.
  assert.equal(result.stdout, '--allow-all|a b|');
});

test('runAgentJob (host) work-time opts.args override the profile args', { skip: process.platform === 'win32' }, async () => {
  const profile = { name: 'p', rank: 'senior', command: 'printf "%s|" "$@"', args: ['--from-profile'], model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope: normalizeTaskEnvelope({}, {}),
    args: ['--from-profile', '--extra'],
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true, result.error || result.stderr);
  assert.equal(result.stdout, '--from-profile|--extra|');
});

test('runAgentJob (host) rejects --arg on a Windows host (POSIX quoting unsafe under cmd.exe)', async () => {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const profile = { name: 'p', rank: 'senior', command: 'copilot', args: ['--allow-all'], model: '', capabilities: [] };
    const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
    const result = await runAgentJob(profile, job, {
      sandbox: 'none',
      envelope: normalizeTaskEnvelope({}, {}),
      timeoutMs: 30_000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not supported for host execution on Windows/);
  } finally {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
});

test('runAgentJob (host) still runs on a Windows host when there are no --arg switches', async () => {
  // With no args, commandLine === command, so the Windows guard must NOT trip.
  // (We assert the guard is bypassed via buildAgentCommandLine equality rather
  // than spawning, because a stubbed win32 platform would make node spawn the
  // absent cmd.exe here.)
  assert.equal(buildAgentCommandLine('printf ok', []), 'printf ok');
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

test('runAgentJob (host) exports AGENT_RESULT_FILE for the agent to write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'res-'));
  try {
    const resultFile = join(dir, 'result.json');
    // The agent writes its structured result to the handed path.
    const profile = { name: 'p', rank: 'senior', command: 'printf %s \'{"status":"converged","summary":"ok"}\' > "$AGENT_RESULT_FILE"', model: '', capabilities: [] };
    const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
    const result = await runAgentJob(profile, job, {
      sandbox: 'none',
      envelope: normalizeTaskEnvelope({}, {}),
      timeoutMs: 30_000,
      resultFile,
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.deepEqual(readAgentResultFile(resultFile), { status: 'converged', summary: 'ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('reapAgentRunDirs reaps run-* and res-* dirs, never unrelated operator files', () => {
  const home = mkdtempSync(join(tmpdir(), 'nano-home-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  try {
    const runs = join(home, 'agent-runs');
    mkdirSync(runs, { recursive: true });
    const runDir = join(runs, 'run-old');
    const resDir = join(runs, 'res-old'); // structured-result temp dir
    const foreignDir = join(runs, 'operator-notes');
    for (const d of [runDir, resDir, foreignDir]) mkdirSync(d, { recursive: true });
    const foreignFile = join(runs, 'README.txt');
    writeFileSync(foreignFile, 'do not delete');
    const old = Date.now() / 1000 - 7200; // 2h ago
    for (const p of [runDir, resDir, foreignDir, foreignFile]) utimesSync(p, old, old);

    const r = reapAgentRunDirs({ maxAgeMs: 60 * 60_000 });
    assert.equal(r.reaped, 2, 'both the run-* and res-* dirs are reaped');
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(resDir), false, 'leftover result dir is reaped');
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

// The broker activation lock is no longer a hardcoded up-front value. Instead the
// worker keeps it a bounded `recovery-window` ahead of *now* via startLockExtender
// while the harness runs, so a long agent job never has its lock lapse (which
// would re-activate the still-retryable job → a second agent + the stale-fail 409
// race). Each refresh SETS the deadline to now+window (UpdateJobTimeout is a
// duration-from-now, not a delta), so the deadline never creeps unbounded and a
// stop() reclaims within one window.
test('startLockExtender refreshes the lock to the window on an interval, then stop() halts it', async () => {
  const calls = [];
  const job = { jobKey: 'jk', modifyJobTimeout: async ({ newTimeoutMs }) => { calls.push(newTimeoutMs); } };
  const stop = startLockExtender(job, 300_000, 20, 'tag', null);
  await new Promise((r) => setTimeout(r, 200));
  const afterRun = calls.length;
  assert.ok(afterRun >= 2, `expected ≥2 refreshes, got ${afterRun}`);
  assert.ok(calls.every((ms) => ms === 300_000), 'every refresh sets the deadline to now+window (absolute, not cumulative)');
  stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, afterRun, 'stop() halts all further refreshes');
});

test('startLockExtender renews immediately (harness gets a full window regardless of provisioning time)', async () => {
  const calls = [];
  const job = { jobKey: 'jk', modifyJobTimeout: async ({ newTimeoutMs }) => { calls.push(newTimeoutMs); } };
  const stop = startLockExtender(job, 300_000, 100_000, 'tag', null);
  // No interval has elapsed, but the first renewal must already have been queued.
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.ok(calls.length >= 1, 'the first renewal fires immediately, not after one interval');
  assert.equal(calls[0], 300_000, 'the immediate renewal sets the deadline to now+window');
});

test('startLockExtender warns loudly when the SDK cannot extend the timeout', () => {
  const warned = [];
  const stop = startLockExtender({ jobKey: 'jk' }, 300_000, 20, 'tag', { warn: (m) => warned.push(m) });
  stop();
  assert.equal(warned.length, 1, 'a missing modifyJobTimeout is surfaced, not swallowed silently');
  assert.ok(warned[0].includes('will NOT be auto-extended'));
});

test('startLockExtender is a safe no-op when the job cannot extend its timeout', () => {
  // Older SDKs without modifyJobTimeout, or a non-positive window/interval, must
  // degrade to the fixed initial lock rather than throw.
  assert.doesNotThrow(() => startLockExtender({}, 300_000, 20, 'tag', null)());
  assert.doesNotThrow(() => startLockExtender({ modifyJobTimeout() {} }, 0, 20, 'tag', null)());
  assert.doesNotThrow(() => startLockExtender({ modifyJobTimeout() {} }, 300_000, 0, 'tag', null)());
});

test('startLockExtender swallows a failing extend without crashing the handler', async () => {
  const warned = [];
  const job = { jobKey: 'jk', modifyJobTimeout: async () => { throw new Error('network blip'); } };
  const stop = startLockExtender(job, 300_000, 20, 'tag', { warn: (m) => warned.push(m) });
  await new Promise((r) => setTimeout(r, 55));
  stop();
  assert.ok(warned.length >= 1, 'extend failures are logged, not thrown');
  assert.ok(warned[0].includes('lock extend failed'));
});

// The idle-timeout is the liveness gate the lock-extender relies on: a harness
// that goes silent (no stdout/stderr) for longer than the window is killed as
// wedged, which resolves runAgentJob so the worker can fail+reclaim the job.
test('runAgentJob (host) idle-timeout kills a silent harness', { skip: process.platform === 'win32' }, async () => {
  const profile = { name: 'p', rank: 'senior', command: 'sleep 5', args: [], model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const t0 = Date.now();
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope: normalizeTaskEnvelope({}, {}),
    idleTimeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.idle, true, 'silent harness is flagged idle');
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - t0 < 4_000, 'killed on idle, well before the 5s sleep completes');
});

test('runAgentJob (host) idle-timeout does NOT kill a harness that keeps producing output', { skip: process.platform === 'win32' }, async () => {
  // Emits a byte every ~100ms for ~500ms — each gap is under the 400ms idle
  // window, so the run must complete normally rather than be idle-killed.
  const profile = { name: 'p', rank: 'senior', command: 'i=0; while [ $i -lt 5 ]; do printf x; sleep 0.1; i=$((i+1)); done', args: [], model: '', capabilities: [] };
  const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
  const result = await runAgentJob(profile, job, {
    sandbox: 'none',
    envelope: normalizeTaskEnvelope({}, {}),
    idleTimeoutMs: 400,
  });
  assert.equal(result.ok, true, result.error || result.stderr);
  assert.notEqual(result.idle, true);
  assert.equal(result.stdout, 'xxxxx');
});

// derivePollTimeoutMs resolves the broker long-poll window passed to the SDK as
// pollTimeoutMs. Parsing is parseInt-style: only input with no leading integer
// (absent/blank/non-numeric such as 'abc') falls back to the 30s default, while
// a leading integer with trailing junk (e.g. '30000ms') is honoured; 0 (broker
// default) and negative (immediate return) also pass through — the whole point
// of a dedicated helper rather than reusing intFlag's ">0" guard.
test('derivePollTimeoutMs: defaults to 30s but honours 0 and negative', () => {
  // Absent / blank / non-numeric → default.
  assert.equal(derivePollTimeoutMs(undefined), 30_000);
  assert.equal(derivePollTimeoutMs(null), 30_000);
  assert.equal(derivePollTimeoutMs(''), 30_000);
  assert.equal(derivePollTimeoutMs('   '), 30_000);
  assert.equal(derivePollTimeoutMs('abc'), 30_000);
  // Custom default is respected.
  assert.equal(derivePollTimeoutMs(undefined, 5_000), 5_000);
  // Explicit positive window (string, as flags arrive from the CLI).
  assert.equal(derivePollTimeoutMs('60000'), 60_000);
  assert.equal(derivePollTimeoutMs(45_000), 45_000);
  // 0 = broker default, negative = immediate — must pass through, NOT be floored.
  assert.equal(derivePollTimeoutMs('0'), 0);
  assert.equal(derivePollTimeoutMs('-1'), -1);
  assert.equal(derivePollTimeoutMs('-5000'), -5_000);
  // Leading numeric with trailing junk parses like parseInt (best-effort).
  assert.equal(derivePollTimeoutMs('30000ms'), 30_000);
});

test('applyAssign unions new capabilities into an existing profile (canonical, additive)', () => {
  const base = {
    name: 'reviewer',
    rank: 'senior',
    command: 'copilot',
    model: '',
    capabilities: ['code-review', 'testing'],
    sandbox: 'none',
    image: '',
    env: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const { profile, added } = applyAssign(base, 'triage, Refactoring', '2026-02-02T00:00:00.000Z');
  // Union, deduped, lowercased, sorted.
  assert.deepEqual(profile.capabilities, ['code-review', 'refactoring', 'testing', 'triage']);
  // Only the genuinely new roles are reported.
  assert.deepEqual(added, ['refactoring', 'triage']);
  // Existing fields (incl. createdAt) preserved; updatedAt refreshed.
  assert.equal(profile.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(profile.updatedAt, '2026-02-02T00:00:00.000Z');
  assert.equal(profile.rank, 'senior');
  assert.equal(profile.command, 'copilot');
});

test('applyAssign is idempotent: assigning existing capabilities is a no-op (added is empty)', () => {
  const base = { name: 'r', rank: 'senior', command: 'copilot', capabilities: ['code-review', 'testing'] };
  const { profile, added } = applyAssign(base, ['testing', 'code-review']);
  assert.deepEqual(added, []);
  assert.deepEqual(profile.capabilities, ['code-review', 'testing']);
});

test('applyAssign accepts an array of capabilities and adds to an empty set', () => {
  const base = { name: 'r', rank: 'junior', command: 'copilot', capabilities: [] };
  const { profile, added } = applyAssign(base, ['docs']);
  assert.deepEqual(profile.capabilities, ['docs']);
  assert.deepEqual(added, ['docs']);
});

test('diffJobTypes: added-only (capability gained via assign) — no drains', () => {
  const cur = jobTypeMatrix('senior', ['pr-review']);
  const want = jobTypeMatrix('senior', ['pr-review', 'fix-ci']);
  const { added, removed } = diffJobTypes(cur, want);
  assert.deepEqual(removed, []);
  // gains the new single-cap token and the combined token
  assert.deepEqual(added.sort(), ['senior:fix-ci', 'senior:fix-ci+pr-review'].sort());
});

test('diffJobTypes: removed-only (capability revoked) — no spawns', () => {
  const cur = jobTypeMatrix('senior', ['pr-review', 'fix-ci']);
  const want = jobTypeMatrix('senior', ['pr-review']);
  const { added, removed } = diffJobTypes(cur, want);
  assert.deepEqual(added, []);
  assert.deepEqual(removed.sort(), ['senior:fix-ci', 'senior:fix-ci+pr-review'].sort());
});

test('diffJobTypes: no-op when the sets match (unchanged types untouched)', () => {
  const cur = jobTypeMatrix('senior', ['plan', 'feature']);
  const want = jobTypeMatrix('senior', ['feature', 'plan']); // order-insensitive
  const { added, removed } = diffJobTypes(cur, want);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test('diffJobTypes: preserves --job-type extras as unchanged (they live in both sets)', () => {
  const extras = ['custom:one'];
  const cur = [...jobTypeMatrix('senior', ['pr-review']), ...extras];
  const want = [...jobTypeMatrix('senior', ['pr-review', 'plan']), ...extras];
  const { added, removed } = diffJobTypes(cur, want);
  assert.deepEqual(removed, []);
  assert.ok(!added.includes('custom:one'));
  assert.ok(added.includes('senior:plan'));
});

test('resolveAssignInputs: positional name — first positional is the name, rest are capabilities', () => {
  const { name, incomingRaw } = resolveAssignInputs(
    { positional: ['reviewer', 'triage', 'refactoring'] },
    {},
  );
  assert.equal(name, 'reviewer');
  assert.equal(incomingRaw, 'triage,refactoring');
});

test('resolveAssignInputs: --name — every positional is a capability (no first-cap drop)', () => {
  const { name, incomingRaw } = resolveAssignInputs(
    { positional: ['triage', 'refactoring'] },
    { name: 'reviewer' },
  );
  assert.equal(name, 'reviewer');
  assert.equal(incomingRaw, 'triage,refactoring');
});

test('resolveAssignInputs: --name with --capabilities and positionals are all unioned', () => {
  const { name, incomingRaw } = resolveAssignInputs(
    { positional: ['triage'] },
    { name: 'reviewer', capabilities: 'docs,testing' },
  );
  assert.equal(name, 'reviewer');
  assert.equal(incomingRaw, 'triage,docs,testing');
});

test('resolveAssignInputs: positional name with only --capabilities (no capability positionals)', () => {
  const { name, incomingRaw } = resolveAssignInputs(
    { positional: ['reviewer'] },
    { capabilities: 'docs' },
  );
  assert.equal(name, 'reviewer');
  assert.equal(incomingRaw, 'docs');
});

test('ghAuthEnv: token path sets the job token and non-interactive flags', () => {
  const prev = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = 'ambient-operator';
  process.env.GITHUB_TOKEN = 'ambient-operator-2';
  try {
    const env = ghAuthEnv('job-token', '/tmp/does-not-matter');
    assert.equal(env.GH_TOKEN, 'job-token', 'job token takes precedence over ambient');
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.GH_NO_UPDATE_NOTIFIER, '1');
    // A provided token short-circuits, so no anonymous config-dir isolation.
    assert.equal(env.GH_CONFIG_DIR, undefined);
  } finally {
    if (prev.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev.GH_TOKEN;
    if (prev.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev.GITHUB_TOKEN;
  }
});

test('ghAuthEnv: no-token path scrubs ambient credentials and isolates GH_CONFIG_DIR', () => {
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
  };
  process.env.GH_TOKEN = 'ambient-operator';
  process.env.GITHUB_TOKEN = 'ambient-operator-2';
  process.env.GH_ENTERPRISE_TOKEN = 'ambient-ent';
  process.env.GITHUB_ENTERPRISE_TOKEN = 'ambient-ent-2';
  const ws = mkdtempSync(join(tmpdir(), 'nano-ghauth-'));
  try {
    const env = ghAuthEnv(undefined, ws);
    assert.equal(env.GH_TOKEN, undefined, 'GH_TOKEN scrubbed');
    assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN scrubbed');
    assert.equal(env.GH_ENTERPRISE_TOKEN, undefined, 'GH_ENTERPRISE_TOKEN scrubbed');
    assert.equal(env.GITHUB_ENTERPRISE_TOKEN, undefined, 'GITHUB_ENTERPRISE_TOKEN scrubbed');
    assert.equal(env.GH_CONFIG_DIR, join(ws, '.nano-gh-anon'), 'isolated config dir set');
    assert.ok(existsSync(env.GH_CONFIG_DIR), 'isolated config dir created');
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.GH_NO_UPDATE_NOTIFIER, '1');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('ghAuthEnv: no-token path fails closed — GH_CONFIG_DIR is set even when the dir cannot be created', () => {
  // Point the workspace at a *file*, so join(file, .nano-gh-anon) cannot be
  // created (ENOTDIR). GH_CONFIG_DIR must still be set so gh fails closed
  // rather than falling back to the operator's on-disk credentials.
  const base = mkdtempSync(join(tmpdir(), 'nano-ghauth-fc-'));
  const asFile = join(base, 'not-a-dir');
  writeFileSync(asFile, 'x');
  try {
    const env = ghAuthEnv(undefined, asFile);
    const expected = join(asFile, '.nano-gh-anon');
    assert.equal(env.GH_CONFIG_DIR, expected, 'GH_CONFIG_DIR set despite mkdir failure');
    assert.ok(!existsSync(expected), 'dir was genuinely not creatable');
    assert.equal(env.GH_TOKEN, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
