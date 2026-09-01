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
  orderProbeAddresses,
  resolveProbeCandidates,
  raceProbeCandidates,
  isLinkLocalAddress,
  rediscoverAgenticUntilConnected,
  defaultAgenticRediscoveryDelays,
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

// Cross-LAN discovery (#96): a remote/non-loopback engine is discovered against
// the ENGINE's own host (never the worker's loopback), so a worker on another
// box finds the hub. The probe is handed the engine host and the surviving hub
// carries it for the caller to build the URL.
test('discoverAgenticHubs discovers a remote (LAN) engine against the engine host', async () => {
  let fetchedUrl;
  let probedHost;
  const hubs = await discoverAgenticHubs('http://merlin.local:8080', {
    fetchImpl: async (url) => { fetchedUrl = url; return { ok: true, json: async () => NANO_WORKFORCE }; },
    // Deterministic resolver (fix B, #133): the engine host resolves to a single
    // routable address, so the probe/hub carry that address, never the worker's.
    lookupImpl: async () => ([{ address: '192.168.0.21', family: 4 }]),
    wsProbe: async (_port, { host } = {}) => { probedHost = host; return true; },
  });
  assert.deepEqual(hubs, [{ project: 'Nano_Workforce', port: 3000, label: 'Nano Workforce', host: '192.168.0.21' }]);
  assert.equal(fetchedUrl, 'http://merlin.local:8080/console/api/projects', 'reads the remote engine projects API');
  assert.equal(probedHost, '192.168.0.21', 'probes the engine host address, not the worker loopback');
});

test('discoverAgenticHubs normalizes a loopback engine host to 127.0.0.1 in the probe + hub', async () => {
  let probedHost;
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchImpl: fetchReturning(NANO_WORKFORCE),
    wsProbe: async (_port, { host } = {}) => { probedHost = host; return true; },
  });
  assert.equal(probedHost, '127.0.0.1');
  assert.equal(hubs[0].host, '127.0.0.1');
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

// Decoupled budgets (#133, fix C): the projects fetch and each WS probe get
// INDEPENDENT deadlines. A slow fetch that consumed most of one shared window
// used to starve the probe to ~0ms remaining and strand a reachable worker in
// `advisory`; now the probe keeps its own full budget regardless of how long the
// fetch took. The injected probe records the budget it was handed.
test('discoverAgenticHubs gives the probe an independent budget (slow fetch cannot starve it)', async () => {
  let handedTimeout;
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    timeoutMs: 200,
    fetchImpl: async () => {
      await new Promise((r) => setTimeout(r, 120)); // consume >half the fetch window
      return { ok: true, json: async () => NANO_WORKFORCE };
    },
    wsProbe: async (_port, { timeoutMs } = {}) => { handedTimeout = timeoutMs; return true; },
  });
  assert.deepEqual(hubs.map((h) => h.port), [3000]);
  assert.equal(handedTimeout, 200, 'probe keeps its own full budget, not the fetch remainder');
});

test('discoverAgenticHubs honours a separate probeTimeoutMs distinct from the fetch budget', async () => {
  let handedTimeout;
  await discoverAgenticHubs('http://localhost:8080', {
    fetchTimeoutMs: 50,
    probeTimeoutMs: 150,
    fetchImpl: fetchReturning(NANO_WORKFORCE),
    wsProbe: async (_port, { timeoutMs } = {}) => { handedTimeout = timeoutMs; return true; },
  });
  assert.equal(handedTimeout, 150, 'probe uses probeTimeoutMs, independent of the fetch budget');
});

test('discoverAgenticHubs still fails open to [] when the fetch outlasts its own budget', async () => {
  let probed = false;
  // A signal-respecting fake fetch: rejects the moment its own fetch budget
  // aborts (fetchTimeoutMs), proving the fetch is independently bounded.
  const hubs = await discoverAgenticHubs('http://localhost:8080', {
    fetchTimeoutMs: 30,
    fetchImpl: (_url, { signal } = {}) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true, json: async () => NANO_WORKFORCE }), 200);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    }),
    wsProbe: async () => { probed = true; return true; },
  });
  assert.deepEqual(hubs, []);
  assert.equal(probed, false, 'a fetch that blows its own budget never reaches the probe');
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
  assert.deepEqual(res.config.discovered, { project: 'Nano_Workforce', port: 3000, host: '127.0.0.1' });
});

test('single-match discovery against a remote LAN engine connects to the engine host (#96)', async () => {
  const res = await withEnv({}, { nanoUrl: 'http://merlin.local:8080' }, () =>
    resolveAgenticTarget({
      fetchImpl: fetchReturning(NANO_WORKFORCE),
      lookupImpl: async () => ([{ address: '192.168.0.21', family: 4 }]),
      wsProbe: probeUpgrades(3000),
    }));
  assert.equal(res.status, 'connect');
  assert.equal(res.config.url, 'http://192.168.0.21:3000');
  assert.deepEqual(res.config.discovered, { project: 'Nano_Workforce', port: 3000, host: '192.168.0.21' });
});

test('single-match discovery brackets an IPv6 engine host in the resolved URL (#96)', async () => {
  const res = await withEnv({}, { nanoUrl: 'http://[2001:db8::1]:8080' }, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(NANO_WORKFORCE), wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'connect');
  assert.equal(res.config.url, 'http://[2001:db8::1]:3000');
  assert.equal(res.config.discovered.host, '[2001:db8::1]');
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

// ---------------------------------------------------------------------------
// (B) Address preference + Happy-Eyeballs — routable wins over link-local (#133)
// ---------------------------------------------------------------------------

test('isLinkLocalAddress flags fe80::/10 and 169.254/16, not routable addresses', () => {
  for (const a of ['fe80::1', 'FE80::f412:e2aa:759f:761b', 'fe80::1%en0', '[fe80::1]', 'fe90::1', 'fea0::1', 'febf::1', 'FEBF::abcd', '169.254.10.20']) {
    assert.equal(isLinkLocalAddress(a), true, `${a} should be link-local`);
  }
  for (const a of ['192.168.0.21', '10.0.0.1', '2001:db8::1', '::1', '127.0.0.1', 'fe7f::1', 'fec0::1', '', undefined]) {
    assert.equal(isLinkLocalAddress(a), false, `${a} should not be link-local`);
  }
});

test('orderProbeAddresses ranks link-local last, stable within a rank', () => {
  const ordered = orderProbeAddresses([
    { address: 'fe80::f412:e2aa:759f:761b', family: 6 },
    { address: '192.168.0.21', family: 4 },
    { address: '169.254.1.2', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ]);
  assert.deepEqual(ordered.map((a) => a.address), [
    '192.168.0.21', // routable, first seen
    '10.0.0.5',     // routable, later
    'fe80::f412:e2aa:759f:761b', // link-local, pushed back (stable order)
    '169.254.1.2',
  ]);
});

test('resolveProbeCandidates returns an IP literal / loopback verbatim (no lookup)', async () => {
  let looked = false;
  const lookupImpl = async () => { looked = true; return []; };
  assert.deepEqual(await resolveProbeCandidates('127.0.0.1', { lookupImpl }), ['127.0.0.1']);
  assert.deepEqual(await resolveProbeCandidates('192.168.0.21', { lookupImpl }), ['192.168.0.21']);
  assert.deepEqual(await resolveProbeCandidates('[2001:db8::1]', { lookupImpl }), ['[2001:db8::1]']);
  assert.equal(looked, false, 'an IP literal / loopback needs no DNS resolution');
});

test('resolveProbeCandidates resolves a hostname routable-first, bracketing IPv6', async () => {
  const lookupImpl = async () => ([
    { address: 'fe80::f412:e2aa:759f:761b', family: 6 }, // link-local first, as Node returns
    { address: '192.168.0.21', family: 4 },
  ]);
  const hosts = await resolveProbeCandidates('merlin.local', { lookupImpl });
  assert.deepEqual(hosts, ['192.168.0.21', '[fe80::f412:e2aa:759f:761b]']);
});

test('resolveProbeCandidates falls back to [host] when the resolver throws', async () => {
  const lookupImpl = async () => { throw new Error('ENOTFOUND'); };
  assert.deepEqual(await resolveProbeCandidates('merlin.local', { lookupImpl }), ['merlin.local']);
});

test('resolveProbeCandidates URL-encodes an IPv6 zone id so the host stays valid', async () => {
  // A resolver can return a scoped link-local address carrying an interface zone
  // id (`fe80::1%en0`); the raw `%` must be percent-encoded so the bracketed host
  // parses as a valid ws:// URL (#133).
  const lookupImpl = async () => ([
    { address: 'fe80::1%en0', family: 6 },
    { address: '192.168.0.21', family: 4 },
  ]);
  const hosts = await resolveProbeCandidates('merlin.local', { lookupImpl });
  assert.deepEqual(hosts, ['192.168.0.21', '[fe80::1%25en0]']);
  // The zone-id delimiter is percent-encoded, not left as a raw `%` (RFC 6874).
  assert.ok(!/[^%]%[^2]/.test(hosts[1]) && hosts[1].includes('%25'), 'zone id is percent-encoded');
});

test('raceProbeCandidates returns the fast routable host even when link-local never opens', async () => {
  // fe80:: never opens (the slow macOS path); the routable IPv4 opens fast.
  const wsProbe = async (_port, { host } = {}) => {
    if (host === '192.168.0.21') return true;
    return new Promise(() => {}); // never resolves — simulates the stalled link-local connect
  };
  const winner = await raceProbeCandidates(3000, {
    hosts: ['192.168.0.21', '[fe80::1]'],
    wsProbe,
    staggerMs: 5,
  });
  assert.equal(winner, '192.168.0.21');
});

test('raceProbeCandidates resolves null when every candidate fails', async () => {
  const winner = await raceProbeCandidates(3000, {
    hosts: ['10.0.0.1', '10.0.0.2'],
    wsProbe: async () => false,
    staggerMs: 1,
  });
  assert.equal(winner, null);
});

// End-to-end discovery: the injected resolver returns link-local-FIRST, and the
// injected probe only upgrades on the routable IPv4 — discovery must still find
// the reachable hub and carry the routable host (proves B fixes the first
// attempt, not just retries).
test('discoverAgenticHubs prefers a routable address when the resolver returns link-local first', async () => {
  const lookupImpl = async () => ([
    { address: 'fe80::f412:e2aa:759f:761b', family: 6 },
    { address: '192.168.0.21', family: 4 },
  ]);
  const wsProbe = async (_port, { host } = {}) => {
    if (host === '192.168.0.21') return true;
    return new Promise(() => {}); // link-local stalls forever
  };
  const hubs = await discoverAgenticHubs('http://merlin.local:8080', {
    fetchImpl: fetchReturning(NANO_WORKFORCE),
    wsProbe,
    lookupImpl,
    probeTimeoutMs: 500,
  });
  assert.deepEqual(hubs, [{ project: 'Nano_Workforce', port: 3000, label: 'Nano Workforce', host: '192.168.0.21' }]);
});

// ---------------------------------------------------------------------------
// (C) Cache the last known-good hub so a blip doesn't drop to advisory (#133)
// ---------------------------------------------------------------------------

test('resolveAgenticTarget reuses a cached hub when a later discovery comes up empty', async () => {
  await withEnv({}, { nanoUrl: 'http://merlin.local:8080' }, async () => {
    const cache = new Map();
    // First: discovery succeeds → connect, and the hub is cached.
    const first = await resolveAgenticTarget({
      cache,
      fetchImpl: fetchReturning(NANO_WORKFORCE),
      lookupImpl: async () => ([{ address: '192.168.0.21', family: 4 }]),
      wsProbe: probeUpgrades(3000),
    });
    assert.equal(first.status, 'connect');
    assert.equal(first.config.url, 'http://192.168.0.21:3000');
    // Then: a transient blip yields zero hubs — but the cache self-heals it to
    // connect rather than dropping the known-good worker to advisory.
    const second = await resolveAgenticTarget({
      cache,
      fetchImpl: fetchReturning(null, { ok: false }),
      wsProbe: probeUpgrades(3000),
    });
    assert.equal(second.status, 'connect');
    assert.equal(second.config.url, 'http://192.168.0.21:3000');
    assert.equal(second.config.fromCache, true);
  });
});

test('resolveAgenticTarget without a cache still drops to advisory on a miss', async () => {
  const res = await withEnv({}, null, () =>
    resolveAgenticTarget({ fetchImpl: fetchReturning(null, { ok: false }), wsProbe: probeUpgrades(3000) }));
  assert.equal(res.status, 'advisory');
});

// ---------------------------------------------------------------------------
// (A) Background re-discovery self-heals advisory → connected (#133)
// ---------------------------------------------------------------------------

test('defaultAgenticRediscoveryDelays grows 2s→…→30s cap and spans several minutes', () => {
  const delays = defaultAgenticRediscoveryDelays({ rng: () => 0.5 }); // no jitter
  assert.equal(delays[0], 2_000);
  assert.equal(delays[1], 4_000);
  assert.equal(delays[2], 8_000);
  assert.ok(delays[delays.length - 1] <= 30_000, 'capped at 30s');
  assert.ok(delays.reduce((a, b) => a + b, 0) >= 4 * 60_000, 'spans several minutes of retries');
});

test('rediscoverAgenticUntilConnected flips advisory → connected on a later attempt', async () => {
  // First two attempts miss (advisory); the third discovers a hub.
  const outcomes = [
    { status: 'advisory' },
    { status: 'advisory' },
    { status: 'connect', config: { url: 'http://192.168.0.21:3000' } },
  ];
  let calls = 0;
  let connectedTarget = null;
  const result = await rediscoverAgenticUntilConnected({
    resolveTarget: async () => outcomes[calls++],
    onConnect: async (target) => { connectedTarget = target; },
    delaysMs: [1, 1, 1, 1],
    sleep: async () => {}, // no real waiting
  });
  assert.equal(calls, 3, 'stopped as soon as a connect target appeared');
  assert.equal(result.status, 'connect');
  assert.equal(connectedTarget.config.url, 'http://192.168.0.21:3000');
});

test('rediscoverAgenticUntilConnected swallows a throwing attempt and keeps trying', async () => {
  let calls = 0;
  const result = await rediscoverAgenticUntilConnected({
    resolveTarget: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { status: 'connect', config: { url: 'http://h:1' } };
    },
    onConnect: async () => {},
    delaysMs: [1, 1, 1],
    sleep: async () => {},
    logger: { debug: () => {} },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'connect');
});

test('rediscoverAgenticUntilConnected keeps retrying when onConnect throws, then stops on success', async () => {
  // A transient channel-open failure in onConnect must NOT prematurely stop the
  // self-heal loop: it should keep re-discovering until a connect callback
  // actually succeeds (#133).
  let attempts = 0;
  let onConnectCalls = 0;
  const result = await rediscoverAgenticUntilConnected({
    resolveTarget: async () => { attempts += 1; return { status: 'connect', config: { url: `http://h:${attempts}` } }; },
    onConnect: async () => {
      onConnectCalls += 1;
      if (onConnectCalls === 1) throw new Error('channel-open transient');
    },
    delaysMs: [1, 1, 1],
    sleep: async () => {},
    logger: { debug: () => {} },
  });
  assert.equal(onConnectCalls, 2, 'retried after the failing onConnect');
  assert.equal(attempts, 2, 're-resolved on the retry');
  assert.equal(result.config.url, 'http://h:2', 'returned the target whose onConnect succeeded');
});

test('rediscoverAgenticUntilConnected stops early when shouldContinue() turns false', async () => {
  let calls = 0;
  const result = await rediscoverAgenticUntilConnected({
    resolveTarget: async () => { calls += 1; return { status: 'advisory' }; },
    onConnect: async () => {},
    delaysMs: [1, 1, 1, 1],
    sleep: async () => {},
    shouldContinue: () => false, // e.g. a channel already came up
  });
  assert.equal(calls, 0, 'never resolves when cancelled up front');
  assert.equal(result, null);
});

test('rediscoverAgenticUntilConnected returns null when the schedule is exhausted with no hit', async () => {
  const result = await rediscoverAgenticUntilConnected({
    resolveTarget: async () => ({ status: 'advisory' }),
    onConnect: async () => { throw new Error('should not be called'); },
    delaysMs: [1, 1],
    sleep: async () => {},
  });
  assert.equal(result, null);
});
