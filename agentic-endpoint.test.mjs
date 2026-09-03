// Tests for the concrete host-connection agentic endpoint (issue #160).
//
// A fake transport (implementing the `{ send, close }` contract + driving the
// hooks) stands in for the WebSocket, so these run under stock `node --test` with
// no live hub and no client-lib load. Sent frames are DECODED with the real S0
// codec to assert exact family / lane / per-instance payload — the wire, not a
// mock of it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFrame } from './agentic.mjs';
import {
  createRawEmitConnect,
  composeTranscriptStream,
  parseTranscriptStream,
  negotiatedSupport,
} from './agentic-endpoint.mjs';

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
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory, incarnationBase: 100 });
  const client = connect();
  fake.last().fireOpen();

  client.register('worker-a', { cognition: 'senior', host: 'h1', weight: undefined });
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
  // capability is cleaned (undefined dropped) and jobKey carried explicitly.
  assert.deepEqual(frames[0].payload.capability, { cognition: 'senior', host: 'h1' });
  assert.equal(frames[2].payload.jobKey, 'job-1');
  assert.equal(frames[5].payload.reason, 'left');
});

test('transcript rides the bulk lane as a relay produce, isolated per {instance, jobKey}', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory, incarnationBase: 42 });
  const client = connect();
  fake.last().fireOpen();

  client.transcript('worker-a', 'job-1', new TextEncoder().encode('hello'));
  client.transcript('worker-b', 'job-1', new TextEncoder().encode('world'));

  const frames = fake.last().sentFrames;
  assert.deepEqual(
    frames.map((f) => [f.lane, f.family, f.payload.op, f.payload.stream, f.payload.incarnation, f.payload.chunk]),
    [
      ['bulk', 'relay', 'produce', composeTranscriptStream('worker-a', 'job-1'), 42, 'hello'],
      ['bulk', 'relay', 'produce', composeTranscriptStream('worker-b', 'job-1'), 42, 'world'],
    ],
  );
  // The two instances' streams are distinct even for the same jobKey.
  assert.notEqual(frames[0].payload.stream, frames[1].payload.stream);
});

test('a send before open (or after drop) throws synchronously so the caller can re-buffer', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();

  assert.throws(() => client.register('w', {}), /not open/);
  fake.last().fireOpen();
  assert.doesNotThrow(() => client.register('w', {}));
  fake.last().drop();
  assert.throws(() => client.heartbeat('w'), /not open/);
});

test('successive connections carry strictly increasing transcript incarnations (fences a stale predecessor)', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory, incarnationBase: 7 });

  const first = connect();
  fake.transports[0].fireOpen();
  first.transcript('w', 'j', new TextEncoder().encode('a'));

  const second = connect();
  fake.transports[1].fireOpen();
  second.transcript('w', 'j', new TextEncoder().encode('b'));

  assert.equal(fake.transports[0].sentFrames[0].payload.incarnation, 7);
  assert.equal(fake.transports[1].sentFrames[0].payload.incarnation, 8);
});

test('open/close callbacks fire and close() tears the transport down', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  const events = [];
  client.onOpen(() => events.push('open'));
  client.onClose(() => events.push('close'));

  fake.last().fireOpen();
  fake.last().drop();
  client.close();

  assert.deepEqual(events, ['open', 'close']);
  assert.equal(fake.last().closed, true);
});

test('an inbound relay-delivery frame for our stream is routed to the steer sink by instance/jobKey', async () => {
  const fake = makeFakeTransportFactory();
  const connect = await createRawEmitConnect({ url: URL, transportFactory: fake.factory });
  const client = connect();
  fake.last().fireOpen();

  const routed = [];
  client.onSteer((instance, jobKey, chunk) => routed.push({ instance, jobKey, text: new TextDecoder().decode(chunk) }));

  // Craft an inbound relay DELIVERY chunk (no `op`) for worker-a/job-1.
  const inbound = encodeRelayDelivery(composeTranscriptStream('worker-a', 'job-1'), 3, 'steer-me');
  fake.last().deliver(inbound);
  // …and a foreign stream, which must be dropped (never misrouted).
  fake.last().deliver(encodeRelayDelivery('blackboard/other', 0, 'nope'));

  assert.deepEqual(routed, [{ instance: 'worker-a', jobKey: 'job-1', text: 'steer-me' }]);
});

test('negotiatedSupport degrades claim/release against a hub that never learned families 8/9', () => {
  const legacy = {
    version: 1,
    families: ['register', 'heartbeat', 'deregister', 'serve', 'demand', 'blackboard', 'relay'],
    features: [],
  };
  const legacySupport = negotiatedSupport(legacy);
  assert.equal(legacySupport.claimRelease, false, 'no claim/release against a pre-#158 hub');
  assert.equal(legacySupport.steer, true, 'steer still available (relay negotiated)');

  const full = negotiatedSupport(undefined);
  assert.equal(full.claimRelease, true, 'full support assumed when no remote advertisement is supplied');
});

test('parseTranscriptStream is the exact inverse of composeTranscriptStream (round-trip, collision-free)', () => {
  for (const [instance, jobKey] of [
    ['worker-a', 'job-1'],
    ['a/b', 'c/d'],
    ['inst with spaces', 'jk?&='],
  ]) {
    assert.deepEqual(parseTranscriptStream(composeTranscriptStream(instance, jobKey)), { instance, jobKey });
  }
  assert.equal(parseTranscriptStream('blackboard/x'), null);
  assert.equal(parseTranscriptStream('t/only-two'), null);
});

// ---- helper: encode a relay DELIVERY frame (as the hub would send inbound) ----
import { encodeFrame } from './agentic.mjs';
function encodeRelayDelivery(stream, offset, chunk) {
  return encodeFrame({ lane: 'bulk', family: 'relay', seq: 0, payload: { stream, offset, chunk } });
}
