// Tests for the concrete host-connection agentic endpoint (issues #160, #186).
//
// Since #186 the endpoint is a thin adapter over `@nanobpm/agentic/emit`'s
// `AgenticEmitClient`: it lifts one emit client onto the Effect-free
// `RawEmitClient` port and owns two seams the pure emitter does not — inbound
// steer routing (decoded here, keyed by the package `parseStreamId`) and mapping
// a mid-life drop to a liveness transition (the client owns reconnect + resync).
//
// A fake transport (implementing the `{ send, close }` contract + driving the
// `{ onOpen, onFrame, onClose, onError }` hooks) stands in for the WebSocket, so
// these run under stock `node --test` with no live hub. Sent frames are DECODED
// with the real S0 codec to assert exact family / lane / per-instance payload —
// the wire, not a mock of it. Stream ids are the package `composeStreamId` codec.

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFrame, encodeFrame, composeStreamId, parseStreamId } from './agentic.mjs';
import { createRawEmitConnect } from './agentic-endpoint.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// A minimal in-memory transport double. Records every frame the client sends and
// lets a test drive open / drop / inbound-deliver deterministically.
function makeFakeTransportFactory() {
  const transports = [];
  const factory = (url, hooks) => {
    const t = {
      url,
      hooks,
      sent: [],
      open: false,
      closed: false,
      send(bytes) {
        if (!t.open) throw new Error('not open');
        t.sent.push(bytes);
      },
      close() {
        t.closed = true;
      },
      fireOpen() {
        t.open = true;
        hooks.onOpen();
      },
      drop() {
        t.open = false;
        hooks.onClose({ code: 1006 });
      },
      deliver(bytes) {
        hooks.onFrame(bytes);
      },
      get sentFrames() {
        return t.sent.map((b) => decodeFrame(b));
      },
    };
    transports.push(t);
    return t;
  };
  return { factory, transports, last: () => transports[transports.length - 1] };
}

const URL = 'http://localhost:8080';

test('emits presence + ownership frames with explicit per-instance identity on the control lane', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  fake.last().fireOpen();

  client.register('worker-a', { cognition: 'senior', host: 'h1' });
  client.register('worker-b', { cognition: 'junior' });
  client.claim('worker-a', 'job-1');
  client.heartbeat('worker-a');
  client.release('worker-a', 'job-1');
  client.deregister('worker-b', 'left');

  const frames = fake.last().sentFrames;
  assert.deepEqual(
    frames.map((f) => `${f.lane}/${f.family}/${f.payload.instance}`),
    [
      'control/register/worker-a',
      'control/register/worker-b',
      'control/claim/worker-a',
      'control/heartbeat/worker-a',
      'control/release/worker-a',
      'control/deregister/worker-b',
    ],
  );
  // Capability + jobKey are carried explicitly per frame.
  assert.deepEqual(frames[0].payload.capability, { cognition: 'senior', host: 'h1' });
  assert.equal(frames[2].payload.jobKey, 'job-1');
  assert.equal(frames[5].payload.reason, 'left');
});

test('transcript rides the bulk lane as a relay produce, isolated per {instance, jobKey} via composeStreamId', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  fake.last().fireOpen();

  client.transcript('worker-a', 'job-1', new TextEncoder().encode('hello'));
  client.transcript('worker-b', 'job-1', new TextEncoder().encode('world'));

  const frames = fake.last().sentFrames;
  assert.deepEqual(
    frames.map((f) => [f.lane, f.family, f.payload.op, f.payload.stream, f.payload.incarnation, f.payload.chunk]),
    [
      ['bulk', 'relay', 'produce', composeStreamId('worker-a', 'job-1'), 0, 'hello'],
      ['bulk', 'relay', 'produce', composeStreamId('worker-b', 'job-1'), 0, 'world'],
    ],
  );
  // The two instances' streams are distinct even for the same jobKey.
  assert.notEqual(frames[0].payload.stream, frames[1].payload.stream);
});

test('a send before open is dropped (the emit client buffers state; the next resync replays it), never thrown', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();

  // Not open yet — the emit send degrades to a no-op on the wire (no throw).
  assert.doesNotThrow(() => client.register('w', {}));
  assert.equal(fake.last().sent.length, 0, 'nothing on the wire before open');

  fake.last().fireOpen();
  client.register('w', {});
  assert.equal(fake.last().sentFrames.at(-1).family, 'register');
});

test('the emit client owns reconnect: on a mid-life drop it re-registers + re-claims from its shadow and bumps the incarnation', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  fake.transports[0].fireOpen();

  client.register('w', { cognition: 'senior' });
  client.claim('w', 'j');
  client.transcript('w', 'j', new TextEncoder().encode('a'));
  assert.equal(fake.transports[0].sentFrames.find((f) => f.family === 'relay').payload.incarnation, 0);

  // Drop → the client schedules its own reconnect (no supervisor involvement).
  fake.transports[0].drop();
  await tick();
  assert.equal(fake.transports.length, 2, 'the client opened a fresh socket itself');
  fake.transports[1].fireOpen();

  // Resync replayed presence + the active claim onto the new socket, before any
  // new transcript — the reconnect re-emit is the client's, from its shadow.
  const families = fake.transports[1].sentFrames.map((f) => `${f.family}/${f.payload.instance ?? ''}`);
  assert.ok(families.includes('register/w'), 're-registered on reconnect');
  assert.ok(families.includes('claim/w'), 're-claimed the active job on reconnect');

  client.transcript('w', 'j', new TextEncoder().encode('b'));
  const relay = fake.transports[1].sentFrames.find((f) => f.family === 'relay');
  assert.equal(relay.payload.incarnation, 1, 'a resumed producer fences its stale predecessor');
});

test('onOpen fires on connect; onClose is reserved for a PERMANENT close (a transient drop does not fire it)', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  const events = [];
  client.onOpen(() => events.push('open'));
  client.onClose(() => events.push('close'));

  fake.last().fireOpen();
  assert.deepEqual(events, ['open']);

  // A transient mid-life drop must NOT complete the supervisor's `closed` (the
  // emit client reconnects underneath) — so no 'close' here.
  fake.last().drop();
  assert.deepEqual(events, ['open'], 'a transient drop is not a permanent close');

  client.close();
  assert.deepEqual(events, ['open', 'close']);

  // And a permanent close on a still-live connection tears its transport down.
  const fake2 = makeFakeTransportFactory();
  const connect2 = await createRawEmitConnect({ url: URL, transportFactory: fake2.factory });
  const live = connect2();
  fake2.last().fireOpen();
  live.close();
  assert.equal(fake2.transports[0].closed, true);
});

test('an inbound relay-delivery frame for our stream is routed to the steer sink by instance/jobKey (parseStreamId)', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  fake.last().fireOpen();

  const routed = [];
  client.onSteer((instance, jobKey, chunk) => routed.push({ instance, jobKey, text: new TextDecoder().decode(chunk) }));

  // Craft an inbound relay DELIVERY chunk (no `op`) for worker-a/job-1.
  const inbound = encodeRelayDelivery(composeStreamId('worker-a', 'job-1'), 3, 'steer-me');
  fake.last().deliver(inbound);
  // …and a foreign stream, which must be dropped (never misrouted).
  fake.last().deliver(encodeRelayDelivery('blackboard/other', 0, 'nope'));

  assert.deepEqual(routed, [{ instance: 'worker-a', jobKey: 'job-1', text: 'steer-me' }]);
});

test('negotiation degrades claim/release against a hub that never learned families 8/9, but keeps steer', async () => {
  const fake = makeFakeTransportFactory();
  const legacy = {
    version: 1,
    families: ['register', 'heartbeat', 'deregister', 'serve', 'demand', 'blackboard', 'relay'],
    features: [],
  };
  const legacyConnect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory, remoteAdvertisement: legacy });
  const legacyClient = legacyConnect();
  assert.equal(legacyClient.supportsClaimRelease, false, 'no claim/release against a pre-#158 hub');
  assert.equal(legacyClient.supportsSteer, true, 'steer still available (relay negotiated)');

  const fullConnect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const fullClient = fullConnect();
  assert.equal(fullClient.supportsClaimRelease, true, 'full support assumed when no remote advertisement is supplied');
});

test('parseStreamId is the exact inverse of composeStreamId (round-trip, collision-free)', () => {
  for (const [instance, stream] of [
    ['worker-a', 'job-1'],
    ['a/b', 'c/d'],
    ['inst with spaces', 'jk?&='],
  ]) {
    assert.deepEqual(parseStreamId(composeStreamId(instance, stream)), { instance, stream });
  }
  // A malformed / foreign id is rejected rather than mistaken for a valid ref.
  assert.equal(parseStreamId('blackboard/x'), undefined);
  assert.equal(parseStreamId('t/only-two'), undefined);
});

// ---- helper: encode a relay DELIVERY frame (as the hub would send inbound) ----
function encodeRelayDelivery(stream, offset, chunk) {
  return encodeFrame({ lane: 'bulk', family: 'relay', seq: 0, payload: { stream, offset, chunk } });
}
