// Unit tests for resolveAgenticConfig() — the local-first agentic visibility
// mode resolver (LOCAL default / SECURE opt-in / OFF switch). These lock in the
// security-relevant branching Copilot flagged as untested: the default LOCAL
// token, both off-switches (NANO_AGENTIC=off and persisted `agentic:false`), the
// fail-closed "token xor credential" case, and env-wins-over-config precedence.
//
// Each test runs against an isolated C8CTL_NANO_HOME temp dir and a scrubbed set
// of NANO_AGENTIC* env vars, so it exercises the real config.json round-trip
// without touching the operator's state or leaking env between cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeConfig,
  resolveAgenticConfig,
  LOCAL_AGENTIC_TOKEN,
} from './c8ctl-plugin.js';

const prevC8ctl = globalThis.c8ctl;
globalThis.c8ctl = {
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
};
process.on('exit', () => {
  if (prevC8ctl === undefined) delete globalThis.c8ctl;
  else globalThis.c8ctl = prevC8ctl;
});

const AGENTIC_ENV = [
  'NANO_AGENTIC',
  'NANO_AGENTIC_URL',
  'NANO_AGENTIC_SECRET',
  'NANO_AGENTIC_TOKEN',
  'NANO_AGENTIC_CREDENTIAL',
  'NANO_AGENTIC_BUFFER_CAPACITY',
  'NANO_BASE_URL',
  // The base now defers to resolveWorkerEngineBase, which also honors the engine
  // override NANO_REST_URL — scrub it so a stray ambient value can't leak in.
  'NANO_REST_URL',
];

// Run `fn` with an isolated config home and a fully scrubbed agentic env, so the
// resolver only sees the env we set inside `fn`. Everything is restored on exit.
function withEnv(env, cfg, fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-agentic-'));
  const saved = {};
  for (const k of ['C8CTL_NANO_HOME', ...AGENTIC_ENV]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.C8CTL_NANO_HOME = HOME;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    if (cfg) writeConfig(cfg);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(HOME, { recursive: true, force: true });
  }
}

test('LOCAL mode is the default: well-known token, no credential, default URL', () => {
  const cfg = withEnv({}, null, resolveAgenticConfig);
  assert.ok(cfg, 'expected a config object in LOCAL mode');
  assert.equal(cfg.secure, false);
  assert.equal(cfg.token, LOCAL_AGENTIC_TOKEN);
  assert.equal(cfg.credential, '');
  assert.equal(cfg.url, 'http://localhost:8080');
});

test('OFF via NANO_AGENTIC=off (and 0/false/no) returns null', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no']) {
    assert.equal(withEnv({ NANO_AGENTIC: v }, null, resolveAgenticConfig), null, `NANO_AGENTIC=${v}`);
  }
});

test('OFF via persisted config agentic:false returns null', () => {
  assert.equal(withEnv({}, { agentic: false }, resolveAgenticConfig), null);
});

test('env NANO_AGENTIC wins over a persisted agentic:false off-switch', () => {
  const cfg = withEnv({ NANO_AGENTIC: 'on' }, { agentic: false }, resolveAgenticConfig);
  assert.ok(cfg, 'env on-switch should re-enable LOCAL visibility over persisted off');
  assert.equal(cfg.secure, false);
  assert.equal(cfg.token, LOCAL_AGENTIC_TOKEN);
});

test('SECURE mode: NANO_AGENTIC_SECRET alone selects secure:true (credential optional)', () => {
  const cfg = withEnv({ NANO_AGENTIC_SECRET: 'shared-secret' }, null, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 'shared-secret');
  assert.equal(cfg.credential, '');
});

test('SECURE mode: legacy NANO_AGENTIC_TOKEN is accepted as a deprecated alias', () => {
  const cfg = withEnv({ NANO_AGENTIC_TOKEN: 'ident-secret' }, null, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 'ident-secret');
});

test('SECURE mode: NANO_AGENTIC_SECRET wins over the legacy NANO_AGENTIC_TOKEN alias', () => {
  const cfg = withEnv(
    { NANO_AGENTIC_SECRET: 'shared-secret', NANO_AGENTIC_TOKEN: 'legacy' },
    null,
    resolveAgenticConfig,
  );
  assert.ok(cfg);
  assert.equal(cfg.token, 'shared-secret');
});

test('SECURE mode: a still-configured credential is forwarded alongside the secret', () => {
  const cfg = withEnv(
    { NANO_AGENTIC_SECRET: 'shared-secret', NANO_AGENTIC_CREDENTIAL: 'cap-cred' },
    null,
    resolveAgenticConfig,
  );
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 'shared-secret');
  assert.equal(cfg.credential, 'cap-cred');
});

test('a credential without a shared secret is ignored → LOCAL mode', () => {
  const cfg = withEnv({ NANO_AGENTIC_CREDENTIAL: 'cred-only' }, null, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, false);
  assert.equal(cfg.token, LOCAL_AGENTIC_TOKEN);
  assert.equal(cfg.credential, '');
});

test('persisted agenticSecret selects SECURE mode (credential optional)', () => {
  const cfg = withEnv({}, { agenticSecret: 's', agenticCredential: 'c' }, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 's');
  assert.equal(cfg.credential, 'c');
});

test('persisted legacy agenticToken alias still selects SECURE mode', () => {
  const cfg = withEnv({}, { agenticToken: 'legacy-persisted' }, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 'legacy-persisted');
  assert.equal(cfg.credential, '');
});

test('base URL falls back through env, config, then the default', () => {
  assert.equal(
    withEnv({ NANO_AGENTIC_URL: 'http://host:9000' }, null, resolveAgenticConfig).url,
    'http://host:9000',
  );
  assert.equal(
    withEnv({}, { agenticUrl: 'http://cfg-agentic:1234' }, resolveAgenticConfig).url,
    'http://cfg-agentic:1234',
  );
  assert.equal(
    withEnv({}, { nanoUrl: 'http://cfg-nano:5678' }, resolveAgenticConfig).url,
    'http://cfg-nano:5678',
  );
});

// Regression (jwulf/c8ctl-plugin-nano#107): a profile-only remote worker — active
// c8ctl profile → remote engine, with NO NANO_*/agenticUrl/nanoUrl set — must
// resolve its agentic base to the profile's restAddress (the engine its jobs run
// on), NOT its own localhost:8080. Previously resolveAgenticConfig re-inlined
// `nanoUrl → NANO_BASE_URL → default` and never consulted the profile, so the
// channel silently degraded to loopback → advisory → never enrolled. Now it
// defers to the shared resolveWorkerEngineBase, which is profile-aware.
test('#107: profile-only worker resolves the agentic base to the profile engine, not localhost', () => {
  const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
  const cfg = withEnv({}, null, () => resolveAgenticConfig(camunda));
  assert.equal(cfg.url, 'http://merlin.local:8080');
  assert.notEqual(cfg.url, 'http://localhost:8080');
  // No explicit agentic target → discovery still runs (not short-circuited).
  assert.equal(cfg.explicitUrl, false);
});

// The explicit agentic/engine overrides still win over the profile, verbatim,
// and an explicit agentic target still short-circuits discovery.
test('#107: explicit overrides still win over the profile base', () => {
  const camunda = { getConfig: () => ({ restAddress: 'http://merlin.local:8080/v2' }) };
  // Explicit agentic target — used verbatim, skips discovery.
  const a = withEnv({ NANO_AGENTIC_URL: 'http://explicit-agentic:3000' }, null, () => resolveAgenticConfig(camunda));
  assert.equal(a.url, 'http://explicit-agentic:3000');
  assert.equal(a.explicitUrl, true);
  // Persisted agenticUrl — same.
  const b = withEnv({}, { agenticUrl: 'http://cfg-agentic:1234' }, () => resolveAgenticConfig(camunda));
  assert.equal(b.url, 'http://cfg-agentic:1234');
  assert.equal(b.explicitUrl, true);
  // Engine override (NANO_BASE_URL) wins over the profile as the discovery base,
  // but is NOT an explicit agentic target, so discovery still runs.
  const c = withEnv({ NANO_BASE_URL: 'http://base-override:8080' }, null, () => resolveAgenticConfig(camunda));
  assert.equal(c.url, 'http://base-override:8080');
  assert.equal(c.explicitUrl, false);
  // Persisted nanoUrl engine override — same precedence.
  const d = withEnv({}, { nanoUrl: 'http://cfg-nano:5678' }, () => resolveAgenticConfig(camunda));
  assert.equal(d.url, 'http://cfg-nano:5678');
  assert.equal(d.explicitUrl, false);
});

// No profile and no overrides → the localhost default is unchanged (advisory/off
// paths stay the same when there is nothing reachable to discover).
test('#107: no profile + no overrides still defaults to localhost', () => {
  const cfg = withEnv({}, null, () => resolveAgenticConfig(undefined));
  assert.equal(cfg.url, 'http://localhost:8080');
});
