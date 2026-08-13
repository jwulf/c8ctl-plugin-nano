// Tests for the `work` command's hub-down buffer observability + policy layer
// (ADR 0056 — slice C4, jwulf/c8ctl-plugin-nano#43).
//
// C4 does NOT add a second buffer: the bounded local ring that survives a hub
// outage is the connected client's built-in `OutboundRing` (landed with C2).
// These tests therefore prove the C4 GUARANTEE end-to-end through the C2 seam —
// a worker that starts before the app, or survives a hub restart, buffers
// output BOUNDED and drains it IN ORDER on reconnect (no lost/reordered frames
// within the bound) — and prove the observability C4 adds over the silent
// client: a high-water mark, outage/flush counting, and an at-capacity warning
// when the bound sheds frames.
//
// The channel client takes an injectable transport, so we drive the outage
// window deterministically with a GATED transport double: a connection opens
// only when the test opens it (never automatically), so we can buffer frames
// while "the app is down" and then observe the ordered flush on open.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeFrame } from './agentic.mjs';
import { createWorkChannel } from './work-channel.mjs';
import { createBufferMonitor, resolveBufferCapacity, DEFAULT_BUFFER_CAPACITY } from './work-buffer.mjs';

// A GATED in-memory transport double: unlike the C2 auto-opening double, a
// connection stays CLOSED until the test calls openCurrent(), so we control the
// outage window precisely. The client re-invokes the factory per reconnect
// attempt; each new attempt is again gated closed until opened.
function makeGatedTransport() {
  const sent = [];
  const conns = [];
  const factory = (url, hooks) => {
    const conn = { url, hooks, open: false, closed: false };
    conns.push(conn);
    return {
      send(bytes) {
        if (!conn.open || conn.closed) throw new Error('transport not open');
        sent.push(bytes);
      },
      close() {
        if (!conn.closed) {
          conn.closed = true;
          if (conn.open) conn.hooks.onClose({ local: true });
        }
      },
    };
  };
  return {
    factory,
    sent,
    conns,
    frames() {
      return sent.map((b) => decodeFrame(b));
    },
    framesOf(family) {
      return this.frames().filter((f) => f.family === family);
    },
    /** Open the latest connection attempt (simulate the hub coming up). */
    openCurrent() {
      const c = conns[conns.length - 1];
      if (c && !c.open && !c.closed) {
        c.open = true;
        c.hooks.onOpen();
      }
    },
    /** Drop the latest (open) connection (simulate a hub restart / outage). */
    dropCurrent() {
      const c = conns[conns.length - 1];
      if (c && !c.closed) {
        c.closed = true;
        if (c.open) c.hooks.onClose({ local: false });
      }
    },
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const BASE = { url: 'http://localhost:8080', token: 'ident', credential: 'cap' };

// Reconnect knobs so a dropped connection re-invokes the factory promptly and
// deterministically under the test clock.
const RECONNECT = {
  reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
  schedule: (fn) => setTimeout(fn, 1),
};

// ---------------------------------------------------------------------------
// resolveBufferCapacity — the operator-tunable bound.
// ---------------------------------------------------------------------------

test('resolveBufferCapacity: valid positive integers pass; junk falls back', () => {
  assert.equal(resolveBufferCapacity(4), 4);
  assert.equal(resolveBufferCapacity('256'), 256);
  assert.equal(resolveBufferCapacity(undefined), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity(''), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity('nope'), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity(0), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity(-3), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity(2.5), DEFAULT_BUFFER_CAPACITY);
  assert.equal(resolveBufferCapacity('nope', 8), 8);
});

// ---------------------------------------------------------------------------
// Worker-before-app: buffer while the app is down, drain IN ORDER on connect.
// ---------------------------------------------------------------------------

test('worker started before the app buffers relay output and drains it in order on connect', async () => {
  const t = makeGatedTransport();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-early',
    host: 'h1',
    transport: t.factory,
    bufferCapacity: 64,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, { capacity: 64, sampleIntervalMs: 0 });

  // The app is not up yet: nothing has opened, so frames buffer.
  const lane = ch.relayLane();
  for (let i = 1; i <= 5; i++) lane.relay('stdout', `chunk-${i}`);
  monitor.sample();
  assert.equal(ch.connected(), false, 'not connected before the app is up');
  assert.equal(ch.buffered() >= 5, true, 'produced frames are buffered while down');
  assert.equal(monitor.health().highWaterMark >= 5, true, 'high-water reflects the backlog');

  // The app comes up → the built-in ring drains in strict order.
  t.openCurrent();
  await tick();

  assert.equal(ch.connected(), true);
  assert.equal(ch.buffered(), 0, 'backlog fully drained on connect');
  const relayChunks = t.framesOf('relay').map((f) => f.payload.chunk);
  assert.deepEqual(
    relayChunks,
    ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5'],
    'relay frames drain in production order — no loss, no reorder',
  );

  const h = monitor.health();
  assert.equal(h.flushes >= 1, true, 'the pre-app backlog flush is recorded');
  assert.equal(h.lastFlushFrames >= 5, true, 'flush size captured');
  assert.notEqual(h.lastFlushAt, null, 'flush timestamp captured');
  monitor.stop();
  await ch.stop();
});

// ---------------------------------------------------------------------------
// Hub restart: survive a mid-life drop, buffer, drain IN ORDER on reconnect.
// ---------------------------------------------------------------------------

test('a worker survives a hub restart: output buffers while down and drains in order on reconnect', async () => {
  const t = makeGatedTransport();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-restart',
    host: 'h2',
    transport: t.factory,
    bufferCapacity: 64,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, { capacity: 64, sampleIntervalMs: 0 });

  // Connect, drain the initial presence backlog.
  t.openCurrent();
  await tick();
  assert.equal(ch.connected(), true);

  // Hub restarts: drop the connection. Produce output while it's down.
  t.dropCurrent();
  await tick();
  assert.equal(ch.connected(), false, 'disconnected during the outage');
  const lane = ch.relayLane();
  for (let i = 1; i <= 4; i++) lane.relay('stdout', `r-${i}`);
  monitor.sample();
  assert.equal(ch.buffered() >= 4, true, 'buffers while the hub is down');

  // Hub comes back: the client auto-reconnects (a new gated attempt); open it.
  await tick(10); // let the reconnect timer create the next attempt
  t.openCurrent();
  await tick();

  assert.equal(ch.connected(), true, 'reconnected after the restart');
  assert.equal(ch.buffered(), 0, 'backlog drained on reconnect');
  const before = t.framesOf('relay').findIndex((f) => f.payload.chunk === 'r-1');
  const drained = t
    .framesOf('relay')
    .map((f) => f.payload.chunk)
    .filter((c) => /^r-\d$/.test(c));
  assert.deepEqual(drained, ['r-1', 'r-2', 'r-3', 'r-4'], 'reconnect drain is in order');
  assert.equal(before >= 0, true, 'all outage frames reached the transport');

  const h = monitor.health();
  assert.equal(h.outages >= 1, true, 'the outage is counted');
  assert.equal(h.reconnects >= 1, true, 'the reconnect is counted');
  assert.equal(h.flushes >= 1, true, 'the reconnect flush is recorded');
  monitor.stop();
  await ch.stop();
});

// ---------------------------------------------------------------------------
// Bound honored + QoS-correct drop policy is OBSERVABLE.
// ---------------------------------------------------------------------------

test('the buffer is bounded: overflow sheds bulk while control survives, and the bound is observable', async () => {
  const warnings = [];
  const t = makeGatedTransport();
  const capacity = 4;
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-bound',
    host: 'h3',
    transport: t.factory,
    bufferCapacity: capacity,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, {
    capacity,
    sampleIntervalMs: 0,
    logger: { warn: (m) => warnings.push(m) },
  });

  // Stay down and overproduce bulk relay frames well past the bound.
  const lane = ch.relayLane();
  for (let i = 1; i <= 20; i++) {
    lane.relay('stdout', `b-${i}`);
    monitor.sample();
  }
  // The bound is honored: the ring never exceeds capacity.
  assert.equal(ch.buffered() <= capacity, true, `buffered (${ch.buffered()}) never exceeds the bound`);
  assert.equal(monitor.health().highWaterMark <= capacity, true, 'high-water never exceeds the bound');
  assert.equal(monitor.health().atCapacityEvents >= 1, true, 'at-capacity samples are counted');
  assert.equal(warnings.length >= 1, true, 'the bound-hit is surfaced as a warning (not silent)');

  // Drain what survived: control (the presence register) must have survived the
  // bulk overflow, and the retained bulk frames drain in order (FIFO tail).
  t.openCurrent();
  await tick();
  assert.equal(ch.buffered(), 0, 'survivors drained on connect');
  assert.equal(t.framesOf('register').length >= 1, true, 'control-lane presence survived the bulk overflow');
  const bulk = t
    .framesOf('relay')
    .map((f) => f.payload.chunk)
    .filter((c) => /^b-\d+$/.test(c));
  // Whatever survived must be a contiguous, in-order suffix of what we produced
  // (overflow evicts the OLDEST bulk frame), never reordered.
  const sortedByProduction = [...bulk].sort(
    (a, b) => Number(a.slice(2)) - Number(b.slice(2)),
  );
  assert.deepEqual(bulk, sortedByProduction, 'retained bulk frames drain in production order');
  assert.equal(bulk.length <= capacity, true, 'at most `capacity` bulk survivors');
  monitor.stop();
  await ch.stop();
});

// ---------------------------------------------------------------------------
// The buffer seam is independent of C3's relay producer (transport seam).
// ---------------------------------------------------------------------------

test('buffering works at the transport seam without any relay producer (independent of C3)', async () => {
  const t = makeGatedTransport();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-noc3',
    host: 'h4',
    transport: t.factory,
    bufferCapacity: 32,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, { capacity: 32, sampleIntervalMs: 0 });

  // No relay lane used at all — only the presence (control) frame C2 buffers.
  // It must buffer while down and drain on connect, proving the buffer sits at
  // the transport seam below the lanes.
  monitor.sample();
  assert.equal(ch.buffered() >= 1, true, 'presence buffers with no relay producer present');
  t.openCurrent();
  await tick();
  assert.equal(ch.buffered(), 0, 'the transport-seam backlog drained');
  assert.equal(t.framesOf('register').length >= 1, true, 'presence reached the hub after the flush');
  assert.equal(monitor.health().flushes >= 1, true, 'flush recorded without any C3 relay frame');
  monitor.stop();
  await ch.stop();
});

// ---------------------------------------------------------------------------
// stop() is idempotent and detaches cleanly.
// ---------------------------------------------------------------------------

test('monitor.stop() detaches listeners and is idempotent', async () => {
  const t = makeGatedTransport();
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-stop',
    host: 'h5',
    transport: t.factory,
    bufferCapacity: 16,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, { capacity: 16, sampleIntervalMs: 0 });
  monitor.stop();
  monitor.stop(); // idempotent — must not throw

  // After stop, lifecycle events no longer move the metrics.
  const before = monitor.health();
  t.openCurrent();
  await tick();
  t.dropCurrent();
  await tick();
  const after = monitor.health();
  assert.equal(after.outages, before.outages, 'no outage counted after stop');
  assert.equal(after.reconnects, before.reconnects, 'no reconnect counted after stop');
  await ch.stop();
});
