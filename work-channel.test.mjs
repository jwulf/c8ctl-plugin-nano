// Tests for the `work` command's agentic-visibility channel seam (ADR 0056 —
// slice C2, jwulf/c8ctl-plugin-nano#41).
//
// These exercise the worker-side seam WITHOUT a live hub: the channel client
// takes an injectable transport, so we drive connect / presence / heartbeat /
// deregister deterministically and decode the frames it emits with the SAME
// shared codec the hub is held to (via this plugin's `./agentic.mjs` surface).
// The auth gate is proven against the real `sharedSecretAuthenticator` the hub
// uses, fed the exact handshake the worker's URL carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeFrame, loadAgenticClient, channel as agenticChannel } from './agentic.mjs';
import {
  buildAgenticUrl,
  redactAgenticUrl,
  createWorkChannel,
} from './work-channel.mjs';

// An in-memory transport double: records every encoded frame the client sends,
// opens on a macrotask (so buffered frames drain like a real socket), and can
// simulate a remote drop to drive reconnect. One factory can be reconnected —
// the client calls it again per connection attempt.
function makeTransportDouble() {
  const sent = [];
  const conns = [];
  const factory = (url, hooks) => {
    const conn = { url, hooks, closed: false };
    conns.push(conn);
    setTimeout(() => {
      if (!conn.closed) hooks.onOpen();
    }, 0);
    return {
      send(bytes) {
        sent.push(bytes);
      },
      close() {
        if (!conn.closed) {
          conn.closed = true;
          conn.hooks.onClose({ local: true });
        }
      },
    };
  };
  return {
    factory,
    sent,
    conns,
    /** Decode all frames sent so far. */
    frames() {
      return sent.map((b) => decodeFrame(b));
    },
    /** Frames of one family, in send order. */
    framesOf(family) {
      return this.frames().filter((f) => f.family === family);
    },
    /** Simulate the hub dropping the current connection (remote close). */
    dropCurrent() {
      const c = conns[conns.length - 1];
      if (c && !c.closed) {
        c.closed = true;
        c.hooks.onClose({ local: false });
      }
    },
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const BASE = { url: 'http://localhost:8080', token: 'ident-secret', credential: 'cap-cred' };

// ---------------------------------------------------------------------------
// URL construction — same-port /agentic + the `?token=…&capability=…` gate.
// ---------------------------------------------------------------------------

test('buildAgenticUrl serves same-port /agentic and carries token + capability', () => {
  const url = buildAgenticUrl('http://localhost:8080', { token: 't0ken', credential: 'cred1' });
  const u = new URL(url);
  assert.equal(u.protocol, 'ws:');
  assert.equal(u.host, 'localhost:8080');
  assert.equal(u.pathname, '/agentic');
  assert.equal(u.searchParams.get('token'), 't0ken');
  assert.equal(u.searchParams.get('capability'), 'cred1');
});

test('buildAgenticUrl upgrades https→wss and preserves a base path', () => {
  const url = buildAgenticUrl('https://app.example.com/base/', { token: 't', credential: 'c' });
  const u = new URL(url);
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.pathname, '/base/agentic');
});

test('buildAgenticUrl rejects an unsupported protocol and an empty base', () => {
  assert.throws(() => buildAgenticUrl('ftp://x/y', { token: 't', credential: 'c' }), /protocol/);
  assert.throws(() => buildAgenticUrl('', { token: 't', credential: 'c' }), /base URL/);
});

test('redactAgenticUrl hides the token and capability', () => {
  const red = redactAgenticUrl(buildAgenticUrl('http://h:1/', { token: 'sec', credential: 'cc' }));
  assert.match(red, /token=\*\*\*/);
  assert.match(red, /capability=\*\*\*/);
  assert.doesNotMatch(red, /sec|cc/);
});

// ---------------------------------------------------------------------------
// Auth gate — proven against the hub's real authenticator with the exact
// handshake the worker's URL carries.
// ---------------------------------------------------------------------------

function handshakeFromUrl(url) {
  const u = new URL(url);
  return { query: Object.fromEntries(u.searchParams.entries()), remote: '127.0.0.1' };
}

test('a valid identity token + capability credential is accepted by the hub authenticator', () => {
  const auth = agenticChannel.sharedSecretAuthenticator({ secret: 'ident-secret' });
  const url = buildAgenticUrl('http://localhost:8080', { token: 'ident-secret', credential: 'cap-cred' });
  const result = auth(handshakeFromUrl(url));
  assert.equal(result.ok, true);
  assert.equal(result.grant.capability, 'cap-cred');
});

test('a wrong identity token is rejected (unauthorized)', () => {
  const auth = agenticChannel.sharedSecretAuthenticator({ secret: 'ident-secret' });
  const url = buildAgenticUrl('http://localhost:8080', { token: 'WRONG', credential: 'cap-cred' });
  const result = auth(handshakeFromUrl(url));
  assert.equal(result.ok, false);
  assert.equal(result.code, agenticChannel.AUTH_UNAUTHORIZED);
});

test('a missing capability credential is rejected (forbidden)', () => {
  const auth = agenticChannel.sharedSecretAuthenticator({ secret: 'ident-secret' });
  // token only, no capability param
  const url = buildAgenticUrl('http://localhost:8080', { token: 'ident-secret', credential: '' });
  const result = auth(handshakeFromUrl(url));
  assert.equal(result.ok, false);
  assert.equal(result.code, agenticChannel.AUTH_FORBIDDEN);
});

// ---------------------------------------------------------------------------
// Presence lifecycle — connect → announce → heartbeat → deregister.
// ---------------------------------------------------------------------------

test('connect announces presence with identity, host, and live jobs', async () => {
  const t = makeTransportDouble();
  const jobs = ['100', '200'];
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'reviewer-abc',
    host: 'ci-box',
    capability: { cognition: 'senior', family: 'opus' },
    listJobKeys: () => jobs,
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();

  const regs = t.framesOf('register');
  assert.equal(regs.length, 1, 'exactly one register announced on connect');
  const p = regs[0].payload;
  assert.equal(p.instance, 'reviewer-abc');
  assert.equal(regs[0].lane, 'control');
  assert.equal(p.capability.host, 'ci-box');
  assert.equal(p.capability.cognition, 'senior');
  assert.equal(p.capability.family, 'opus');
  assert.deepEqual(p.capability.jobs, ['100', '200']);

  await ch.stop();
});

test('refreshPresence re-announces the current live job set', async () => {
  const t = makeTransportDouble();
  let jobs = [];
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w1',
    host: 'h1',
    listJobKeys: () => jobs,
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();

  jobs = ['500'];
  ch.refreshPresence();
  await tick();

  const regs = t.framesOf('register');
  // The client coalesces buffered registers, but each is a full snapshot; the
  // LAST one the hub sees must carry the current jobs.
  const last = regs[regs.length - 1].payload;
  assert.deepEqual(last.capability.jobs, ['500']);

  await ch.stop();
});

test('heartbeat rides the control lane carrying the instance', async () => {
  const t = makeTransportDouble();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'hb-1',
    host: 'h',
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();
  ch.client.heartbeat();
  await tick();

  const hbs = t.framesOf('heartbeat');
  assert.equal(hbs.length, 1);
  assert.equal(hbs[0].lane, 'control');
  assert.equal(hbs[0].payload.instance, 'hb-1');

  await ch.stop();
});

test('stop() deregisters cleanly so the worker disappears from the page', async () => {
  const t = makeTransportDouble();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'bye-1',
    host: 'h',
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();
  await ch.stop('worker stopped');
  await tick();

  const dereg = t.framesOf('deregister');
  assert.equal(dereg.length, 1);
  assert.equal(dereg[0].lane, 'control');
  assert.equal(dereg[0].payload.instance, 'bye-1');
  assert.equal(dereg[0].payload.reason, 'worker stopped');
  assert.equal(ch.connected(), false);
});

// ---------------------------------------------------------------------------
// Sibling attach points — the seam C3 and C4 build on.
// ---------------------------------------------------------------------------

test('relayLane() is the C3 sink: relay rides the bulk lane, tagged by stream', async () => {
  const t = makeTransportDouble();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'relay-1',
    host: 'h',
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();

  const lane = ch.relayLane();
  lane.relay('stdout', 'hello\n');
  await tick();

  const relays = t.framesOf('relay');
  assert.equal(relays.length, 1);
  assert.equal(relays[0].lane, 'bulk');
  assert.equal(relays[0].payload.stream, 'stdout');
  assert.equal(relays[0].payload.chunk, 'hello\n');

  await ch.stop();
});

test('lifecycle events: onConnect fires once, onDisconnect on close, onReconnect on a later open (C4)', async () => {
  const t = makeTransportDouble();
  let connects = 0;
  let reconnects = 0;
  let disconnects = 0;
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'life-1',
    host: 'h',
    heartbeatIntervalMs: 0,
    transport: t.factory,
    reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
    schedule: (fn) => setTimeout(fn, 1),
  });
  ch.onConnect(() => { connects += 1; });
  ch.onReconnect(() => { reconnects += 1; });
  ch.onDisconnect(() => { disconnects += 1; });
  await tick();
  assert.equal(connects, 1, 'connect fires once on first open');
  assert.equal(reconnects, 0);

  // Hub drops the connection → the client auto-reconnects and re-opens.
  t.dropCurrent();
  await tick(30);
  assert.equal(disconnects >= 1, true, 'disconnect fires on close');
  assert.equal(reconnects >= 1, true, 'reconnect fires on the re-open');
  assert.equal(connects, 1, 'connect stays one-shot across reconnects');

  await ch.stop();
});

test('presence is re-announced after a reconnect so the row survives a hub restart', async () => {
  const t = makeTransportDouble();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'survive-1',
    host: 'h',
    listJobKeys: () => ['777'],
    heartbeatIntervalMs: 0,
    transport: t.factory,
    reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
    schedule: (fn) => setTimeout(fn, 1),
  });
  await tick();
  const before = t.framesOf('register').length;
  t.dropCurrent();
  await tick(30);
  const after = t.framesOf('register').length;
  assert.equal(after > before, true, 're-registered on reconnect');
  const last = t.framesOf('register').pop().payload;
  assert.deepEqual(last.capability.jobs, ['777']);

  await ch.stop();
});

// ---------------------------------------------------------------------------
// The C0 constraint is resolved here: the worker client is loadable under stock
// Node through the single swap point (`loadAgenticClient` registers the
// source→dist resolve hook before importing it).
// ---------------------------------------------------------------------------

test('the worker channel client loads under stock Node via loadAgenticClient()', async () => {
  const client = await loadAgenticClient();
  assert.equal(typeof client.connectAgenticChannel, 'function');
  assert.equal(typeof client.AgenticClient, 'function');
  assert.equal(typeof client.OutboundRing, 'function');
});
