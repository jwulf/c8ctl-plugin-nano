// Unit tests for the #110 wave-0 seam: the two new hire-profile fields
// `protocol` (pipe|acp) and `permission` (yolo|escalate|filter), their tolerant
// normalization, and the hire-time round-trip + reserved-policy warning.
//
// escalate/filter are RESERVED (not yet enforced — pending nano-workforce#559):
// they are accepted, persisted verbatim (never downgraded), and warned about at
// hire time. Only `yolo` is enforced today. These tests lock in the schema/
// plumbing contract that the downstream ACP executor builds on.
//
// Each hire test runs against an isolated C8CTL_NANO_HOME temp dir with a
// captured logger, so it exercises the real config.json round-trip without
// touching the operator's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeStoredProfile, hireWorker, readConfig, resolveAgenticSetting, PROTOCOLS, PERMISSION_MODES } from './c8ctl-plugin.js';

// --- logger capture -------------------------------------------------------
const logs = { info: [], warn: [], error: [] };
function resetLogs() { logs.info = []; logs.warn = []; logs.error = []; }
const prevC8ctl = globalThis.c8ctl;
globalThis.c8ctl = {
  getLogger: () => ({
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
    debug: () => {},
    output: () => {},
  }),
};
process.on('exit', () => {
  if (prevC8ctl === undefined) delete globalThis.c8ctl;
  else globalThis.c8ctl = prevC8ctl;
});

async function withHome(fn) {
  const prevHome = process.env.C8CTL_NANO_HOME;
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-proto-'));
  process.env.C8CTL_NANO_HOME = home;
  resetLogs();
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// --- normalizeStoredProfile ----------------------------------------------
const BASE = { rank: 'senior', command: 'copilot' };

test('normalizeStoredProfile defaults protocol→pipe and permission→yolo when absent', () => {
  const { profile, error } = normalizeStoredProfile('coder', { ...BASE });
  assert.equal(error, undefined);
  assert.equal(profile.protocol, 'pipe');
  assert.equal(profile.permission, 'yolo');
});

test('normalizeStoredProfile tolerates unknown/legacy values by falling back to defaults', () => {
  const { profile, error } = normalizeStoredProfile('coder', {
    ...BASE,
    protocol: 'websocket',
    permission: 'sudo',
  });
  // A bad value must NOT fail the whole profile — it falls back, like `terminal`.
  assert.equal(error, undefined);
  assert.equal(profile.protocol, 'pipe');
  assert.equal(profile.permission, 'yolo');
});

test('normalizeStoredProfile preserves valid acp and escalate/filter (case + whitespace tolerant)', () => {
  const acp = normalizeStoredProfile('a', { ...BASE, protocol: '  ACP ', permission: 'YOLO' }).profile;
  assert.equal(acp.protocol, 'acp');
  assert.equal(acp.permission, 'yolo');

  const esc = normalizeStoredProfile('b', { ...BASE, protocol: 'acp', permission: 'escalate' }).profile;
  assert.equal(esc.permission, 'escalate');

  const filt = normalizeStoredProfile('c', { ...BASE, protocol: 'pipe', permission: 'filter' }).profile;
  assert.equal(filt.permission, 'filter');
});

test('normalizeStoredProfile does not add protocol/permission errors for a valid profile', () => {
  const res = normalizeStoredProfile('coder', { ...BASE, protocol: 'acp', permission: 'yolo' });
  assert.equal(res.error, undefined);
  assert.ok(res.profile);
});

// --- hireWorker round-trip -------------------------------------------------
test('hire round-trips protocol/permission through config.json', async () => {
  await withHome(async () => {
    await hireWorker(
      { positional: [] },
      { name: 'coder', rank: 'senior', command: 'copilot', protocol: 'acp', permission: 'yolo' },
    );
    const hires = readConfig().hires || {};
    assert.ok(hires.coder, 'profile was persisted');
    assert.equal(hires.coder.protocol, 'acp');
    assert.equal(hires.coder.permission, 'yolo');
  });
});

test('hire defaults protocol/permission to pipe/yolo when the flags are omitted', async () => {
  await withHome(async () => {
    await hireWorker(
      { positional: [] },
      { name: 'coder', rank: 'senior', command: 'copilot' },
    );
    const hires = readConfig().hires || {};
    assert.equal(hires.coder.protocol, 'pipe');
    assert.equal(hires.coder.permission, 'yolo');
    // Default (pipe/yolo) hire must NOT emit the reserved-policy warning.
    assert.ok(!logs.warn.some((w) => /RESERVED|not yet enforced/i.test(w)));
  });
});

for (const policy of ['escalate', 'filter']) {
  test(`hire --permission ${policy} persists the value AND warns it is reserved/not-yet-enforced`, async () => {
    await withHome(async () => {
      await hireWorker(
        { positional: [] },
        { name: 'coder', rank: 'senior', command: 'copilot', protocol: 'acp', permission: policy },
      );
      const hires = readConfig().hires || {};
      // Persisted verbatim — never downgraded to yolo.
      assert.equal(hires.coder.permission, policy);
      // A warning naming nano-workforce#559 and the reserved status was emitted.
      const warned = logs.warn.some((w) => w.includes('559') && /reserved|not yet enforced|interim/i.test(w));
      assert.ok(warned, `expected a reserved/not-yet-enforced warning for --permission ${policy}, got: ${JSON.stringify(logs.warn)}`);
    });
  });
}

// --- resolveAgenticSetting: env → profile → default precedence -------------
// The work command resolves each role's protocol/permission with a uniform
// env-override → profile → default precedence, tolerant of invalid values at
// every layer (invalid values are ignored and fall through to the next layer).
// These lock in that contract for both NANO_AGENTIC_PROTOCOL and
// NANO_AGENTIC_PERMISSION so the ACP executor can rely on it.

test('resolveAgenticSetting: env override wins when it names an allowed value', () => {
  assert.equal(resolveAgenticSetting('acp', 'pipe', PROTOCOLS, 'pipe'), 'acp');
  assert.equal(resolveAgenticSetting('filter', 'yolo', PERMISSION_MODES, 'yolo'), 'filter');
});

test('resolveAgenticSetting: profile decides when env is absent/blank', () => {
  assert.equal(resolveAgenticSetting('', 'acp', PROTOCOLS, 'pipe'), 'acp');
  assert.equal(resolveAgenticSetting(undefined, 'escalate', PERMISSION_MODES, 'yolo'), 'escalate');
});

test('resolveAgenticSetting: falls back to default when neither env nor profile is set', () => {
  assert.equal(resolveAgenticSetting('', undefined, PROTOCOLS, 'pipe'), 'pipe');
  assert.equal(resolveAgenticSetting(null, null, PERMISSION_MODES, 'yolo'), 'yolo');
});

test('resolveAgenticSetting: invalid env is ignored and falls through to profile', () => {
  assert.equal(resolveAgenticSetting('bogus', 'acp', PROTOCOLS, 'pipe'), 'acp');
  assert.equal(resolveAgenticSetting('nonsense', 'filter', PERMISSION_MODES, 'yolo'), 'filter');
});

test('resolveAgenticSetting: invalid env AND invalid profile fall through to default', () => {
  assert.equal(resolveAgenticSetting('bogus', 'alsobogus', PROTOCOLS, 'pipe'), 'pipe');
  assert.equal(resolveAgenticSetting('x', 'y', PERMISSION_MODES, 'yolo'), 'yolo');
});

test('resolveAgenticSetting: env is trimmed and lowercased before matching', () => {
  assert.equal(resolveAgenticSetting('  ACP  ', 'pipe', PROTOCOLS, 'pipe'), 'acp');
  assert.equal(resolveAgenticSetting('Escalate', 'yolo', PERMISSION_MODES, 'yolo'), 'escalate');
});

test('resolveAgenticSetting: reserved permission values carry through verbatim', () => {
  for (const policy of ['escalate', 'filter']) {
    assert.equal(resolveAgenticSetting('', policy, PERMISSION_MODES, 'yolo'), policy);
    assert.equal(resolveAgenticSetting(policy, 'yolo', PERMISSION_MODES, 'yolo'), policy);
  }
});
