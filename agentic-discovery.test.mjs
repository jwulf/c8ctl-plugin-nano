// Unit tests for zero-config agentic hub auto-discovery (#75). These lock in the
// resolution order Copilot specified: explicit target short-circuits discovery,
// the off-switch never probes, a single discovered app connects to its direct
// loopback port, two+ apps hard-stop with an `ambiguous` error, and a missing /
// non-nano projects API (or a discovery timeout) degrades to a non-fatal
// advisory. The projects-API read and the WS upgrade probe are both injected so
// the tests never touch a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeConfig,
  resolveAgenticTarget,
  discoverAgenticHubs,
  probeAgenticChannel,
  normalizeProjectApps,
  isLoopbackHost,
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

// Run `fn` with an isolated config home and a fully scrubbed agentic env.
async function withEnv(env, cfg, fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-discovery-'));
  const saved = {};
  for (const k of ['C8CTL_NANO_HOME', ...AGENTIC_ENV]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.C8CTL_NANO_HOME = HOME;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    if (cfg) writeConfig(cfg);
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(HOME, { recursive: true, force: true });
  }
}

// A projects-API body in the console's keyed-map shape.
const NANO_WORKFORCE = {
  Nano_Workforce: { appUi: { enabled: true, port: 3000, path: '/', label: 'Nano Workforce' } },
};

// An injected fetch that returns `body` as JSON with a given `ok`/status.
function fetchReturning(body, { ok = true } = {}) {
  return async () => ({ ok, json: async () => body });
}

// An injected WS probe that upgrades only for the given set of ports.
function probeUpgrades(...ports) {
  const set = new Set(ports);
  return async (port) => set.has(port);
}

// ---------------------------------------------------------------------------
// normalizeProjectApps — shape tolerance
// ---------------------------------------------------------------------------

test('normalizeProjectApps keeps only enabled apps with a positive port', () => {
  const apps = normalizeProjectApps({
    Nano_Workforce: { appUi: { enabled: true, port: 3000, label: 'Nano Workforce' } },
    Disabled: { appUi: { enabled: false, port: 3100 } },
    NoPort: { appUi: { enabled: true } },
    ApiOnly: {},
  });
  assert.deepEqual(apps, [{ project: 'Nano_Workforce', port: 3000, label: 'Nano Workforce' }]);
});

test('normalizeProjectApps accepts array and wrapped-array shapes', () => {
  const fromArray = normalizeProjectApps([
    { name: 'A', appUi: { enabled: true, port: 3000 } },
  ]);
  const fromWrapped = normalizeProjectApps({
    projects: [{ name: 'A', appUi: { enabled: true, port: 3000 } }],
  });
  assert.equal(fromArray[0].port, 3000);
  assert.equal(fromWrapped[0].port, 3000);
});

test('normalizeProjectApps returns [] for non-object / Camunda-ish bodies', () => {
  assert.deepEqual(normalizeProjectApps(null), []);
  assert.deepEqual(normalizeProjectApps('nope'), []);
  assert.deepEqual(normalizeProjectApps({ topology: {} }), []);
});

// ---------------------------------------------------------------------------
// discoverAgenticHubs — projects read + WS probe
// ---------------------------------------------------------------------------

test('discoverAgenticHubs returns the single app whose /agentic upgrades', async () => {
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchImpl: fetchReturning(NANO_WORKFORCE),
    wsProbe: probeUpgrades(3000),
  });
  assert.deepEqual(hubs.map((h) => h.port), [3000]);
});

test('discoverAgenticHubs drops apps that advertise a port but do not upgrade', async () => {
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchImpl: fetchReturning(NANO_WORKFORCE),
    wsProbe: probeUpgrades(9999), // 3000 advertised but refuses the upgrade
  });
  assert.deepEqual(hubs, []);
});

test('discoverAgenticHubs fails open to [] when the projects API is absent (non-nano)', async () => {
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchImpl: fetchReturning(null, { ok: false }),
    wsProbe: probeUpgrades(3000),
  });
  assert.deepEqual(hubs, []);
});

test('discoverAgenticHubs fails open to [] when the fetch throws (network/timeout)', async () => {
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchImpl: async () => { throw new Error('aborted'); },
    wsProbe: probeUpgrades(3000),
  });
  assert.deepEqual(hubs, []);
});

// Loopback-only guard (#76): a remote/non-loopback engine must never steer a
// local 127.0.0.1 port probe — discovery short-circuits before it even fetches.
test('discoverAgenticHubs refuses a non-loopback engine host without probing (loopback-only)', async () => {
  let fetched = false;
  let probed = false;
  const hubs = await discoverAgenticHubs('http://remote.example.com:8080', {
    fetchImpl: async () => { fetched = true; return { ok: true, json: async () => NANO_WORKFORCE }; },
    wsProbe: async () => { probed = true; return true; },
  });
  assert.deepEqual(hubs, []);
  assert.equal(fetched, false, 'must not fetch a non-loopback engine');
  assert.equal(probed, false, 'must not probe when the engine host is non-loopback');
});

test('discoverAgenticHubs allows every loopback host form (127.x, ::1)', async () => {
  for (const engine of ['http://127.0.0.1:8080', 'http://127.5.6.7:8080', 'http://[::1]:8080']) {
    const hubs = await discoverAgenticHubs(engine, {
      fetchImpl: fetchReturning(NANO_WORKFORCE),
      wsProbe: probeUpgrades(3000),
    });
    assert.deepEqual(hubs.map((h) => h.port), [3000], `expected discovery for ${engine}`);
  }
});

// Single shared time budget (#76): the fetch and the probes must not each get a
// fresh full timeout. The injected probe records the budget it was handed; after
// a fetch that consumes most of the window, the probe budget must be the small
// remainder — never the full timeoutMs.
test('discoverAgenticHubs shares one deadline across fetch + probes (no 2x budget)', async () => {
  let handedTimeout;
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    timeoutMs: 200,
    fetchImpl: async () => {
      await new Promise((r) => setTimeout(r, 120)); // consume >half the budget
      return { ok: true, json: async () => NANO_WORKFORCE };
    },
    wsProbe: async (_port, { timeoutMs } = {}) => { handedTimeout = timeoutMs; return true; },
  });
  assert.deepEqual(hubs.map((h) => h.port), [3000]);
  assert.ok(handedTimeout < 200, `probe budget ${handedTimeout} should be the remainder, not the full 200`);
  assert.ok(handedTimeout > 0, 'probe budget should still be positive when time remains');
});

test('discoverAgenticHubs skips probing when the fetch exhausts the whole budget', async () => {
  let probed = false;
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    timeoutMs: 40,
    fetchImpl: async () => {
      await new Promise((r) => setTimeout(r, 60)); // outlasts the budget
      return { ok: true, json: async () => NANO_WORKFORCE };
    },
    wsProbe: async () => { probed = true; return true; },
  });
  assert.deepEqual(hubs, []);
  assert.equal(probed, false, 'no budget left → do not probe');
});

// ---------------------------------------------------------------------------
// isLoopbackHost — address classification
// ---------------------------------------------------------------------------

test('isLoopbackHost accepts localhost / 127.0.0.0-8 / ::1 and rejects everything else', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, `${h} should be loopback`);
  }
  for (const h of ['example.com', '10.0.0.1', '192.168.1.5', '128.0.0.1', '', undefined, 'localhost.evil.com']) {
    assert.equal(isLoopbackHost(h), false, `${h} should not be loopback`);
  }
});

// ---------------------------------------------------------------------------
// probeAgenticChannel — outcome mapping
// ---------------------------------------------------------------------------

test('probeAgenticChannel resolves true on open and false on error', async () => {
  class OpenWS {
    constructor() { queueMicrotask(() => this.onopen && this.onopen()); }
    close() {}
  }
  class ErrWS {
    constructor() { queueMicrotask(() => this.onerror && this.onerror(new Error('501'))); }
    close() {}
  }
  assert.equal(await probeAgenticChannel(3000, { WebSocketImpl: OpenWS }), true);
  assert.equal(await probeAgenticChannel(3000, { WebSocketImpl: ErrWS }), false);
});

test('probeAgenticChannel resolves false on timeout without a socket event', async () => {
  class SilentWS { close() {} }
  assert.equal(await probeAgenticChannel(3000, { WebSocketImpl: SilentWS, timeoutMs: 20 }), false);
});

// ---------------------------------------------------------------------------
// resolveAgenticTarget — the full resolution order
// ---------------------------------------------------------------------------

test('explicit NANO_AGENTIC_URL short-circuits discovery (used verbatim)', async () => {
  let probed = false;
  const res = await withEnv({ NANO_AGENTIC_URL: 'http://host:9000' }, null, () =>
    resolveAgenticTarget({
      fetchImpl: async () => { probed = true; return { ok: true, json: async () => NANO_WORKFORCE }; },
      wsProbe: probeUpgrades(3000),
    }));
  assert.equal(res.status, 'connect');
  assert.equal(res.config.url, 'http://host:9000');
  assert.equal(probed, false, 'discovery must not run when a target is explicit');
});

test('persisted agenticUrl also short-circuits discovery', async () => {
  const res = await withEnv({}, { agenticUrl: 'http://cfg:1234' }, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(NANO_WORKFORCE), wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'connect');
  assert.equal(res.config.url, 'http://cfg:1234');
});

test('off-switch returns off and never probes', async () => {
  let probed = false;
  const res = await withEnv({ NANO_AGENTIC: 'off' }, null, () =>
    resolveAgenticTarget({ fetchImpl: async () => { probed = true; return { ok: true, json: async () => ({}) }; } }));
  assert.equal(res.status, 'off');
  assert.equal(probed, false);
});

test('single-match discovery connects to the direct loopback port with the local token', async () => {
  const res = await withEnv({}, null, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(NANO_WORKFORCE), wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'connect');
  assert.equal(res.config.url, 'http://127.0.0.1:3000');
  assert.equal(res.config.token, LOCAL_AGENTIC_TOKEN);
  assert.deepEqual(res.config.discovered, { project: 'Nano_Workforce', port: 3000 });
});

test('two+ discovered apps bail with an ambiguous message naming project→port', async () => {
  const twoApps = {
    Nano_Workforce: { appUi: { enabled: true, port: 3000, label: 'Nano Workforce' } },
    Other_App: { appUi: { enabled: true, port: 3100, label: 'Other' } },
  };
  const res = await withEnv({}, null, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(twoApps), wsProbe: probeUpgrades(3000, 3100) }));
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.candidates.length, 2);
  assert.match(res.message, /Nano_Workforce/);
  assert.match(res.message, /3100/);
  assert.match(res.message, /NANO_AGENTIC_URL/);
});

test('zero matches (non-nano / Camunda target) yields a non-fatal advisory', async () => {
  const res = await withEnv({}, null, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(null, { ok: false }), wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'advisory');
  assert.match(res.message, /NANO_AGENTIC_URL/);
});

test('discovery timeout / error degrades to the zero-match advisory', async () => {
  const res = await withEnv({}, null, () =>
    resolveAgenticTarget({ fetchImpl: async () => { throw new Error('AbortError'); }, wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'advisory');
});
