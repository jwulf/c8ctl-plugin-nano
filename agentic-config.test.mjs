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
  'NANO_AGENTIC_TOKEN',
  'NANO_AGENTIC_CREDENTIAL',
  'NANO_AGENTIC_BUFFER_CAPACITY',
  'NANO_BASE_URL',
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

test('SECURE mode: both token + credential are passed through with secure:true', () => {
  const cfg = withEnv(
    { NANO_AGENTIC_TOKEN: 'ident-secret', NANO_AGENTIC_CREDENTIAL: 'cap-cred' },
    null,
    resolveAgenticConfig,
  );
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 'ident-secret');
  assert.equal(cfg.credential, 'cap-cred');
});

test('SECURE half-configured fails closed (only token, or only credential) → null', () => {
  assert.equal(withEnv({ NANO_AGENTIC_TOKEN: 'ident-only' }, null, resolveAgenticConfig), null);
  assert.equal(withEnv({ NANO_AGENTIC_CREDENTIAL: 'cred-only' }, null, resolveAgenticConfig), null);
});

test('persisted agenticToken + agenticCredential also select SECURE mode', () => {
  const cfg = withEnv({}, { agenticToken: 't', agenticCredential: 'c' }, resolveAgenticConfig);
  assert.ok(cfg);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.token, 't');
  assert.equal(cfg.credential, 'c');
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
