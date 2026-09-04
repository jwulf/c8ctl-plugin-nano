// The concrete host-connection agentic endpoint (ADR 0056; issues #160, #186).
//
// #158 shipped the host-owned job-ownership protocol as an Effect *interface*
// (`AgenticEndpoint` → `AgenticHandle` implementing `register`/`heartbeat`/
// `deregister`/`claim`/`transcript`/`release`, identity explicit on every frame)
// but no concrete transport. #160 wired a bespoke one by hand. Since #546 (in
// `@nanobpm/agentic` 0.12.0) the package ships a high-level `@nanobpm/agentic/
// emit` `AgenticEmitClient` that already provides everything this file used to
// hand-roll: multiplexed multi-instance presence, register/heartbeat/deregister,
// idempotent claim/release, transcript emit over QoS lanes, additive
// negotiation, capability shaping, and — critically — reconnect-resync from its
// own write-through shadow of the presence + in-flight-claim maps. #186 retires
// the bespoke emit surface in favour of that client and its injective
// `composeStreamId`/`parseStreamId` stream-id codec.
//
// This module is now a THIN adapter: it lifts one `AgenticEmitClient` into the
// plain, Effect-free `RawEmitClient` port (`supervisor/src/emit.ts`) the
// supervisor bundle lifts into the Effect `AgenticHandle`. Two seams remain the
// adapter's responsibility because the emit client is a pure emitter that holds
// no inbound sub-protocol:
//
//   1. Inbound steer routing — the client ignores inbound frames, so the
//      EmitSocket adapter decodes each inbound relay DELIVERY frame and fans it
//      to the installed steer route, keyed by the package `parseStreamId` codec
//      (a foreign/blackboard stream is dropped, never misrouted).
//   2. Reconnect ownership — the emit client OWNS reconnect and re-emits presence
//      + active claims from its shadow on every reconnect, so the RawEmitClient
//      surfaces a mid-life drop only as a liveness transition (`onConnectionState`)
//      and reserves its single-shot `onClose` for a permanent teardown. That
//      retires the supervisor's manual re-register/re-claim resync (#186): the
//      `ownership.ts` registry stays the authority and the single write path into
//      the client, while the wire-level replay is the client's job.
//
// Everything on the wire is CONSUMED through this plugin's single import surface
// (`agentic.mjs` → `@nanobpm/agentic/emit` + `@nanobpm/urban-agent-client`);
// nothing is re-declared here.

import {
  AgenticEmitClient,
  parseStreamId,
  decodeFrame,
  loadAgenticClient,
} from './agentic.mjs';
import { buildAgenticUrl } from './work-channel.mjs';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Adapt one `@nanobpm/urban-agent-client` websocket transport (the `{ send,
 * close }` value + `{ onOpen, onFrame, onClose, onError }` hook shape) to the
 * `EmitSocket` the {@link AgenticEmitClient} drives (`send`/`close` +
 * `onMessage`/`onOpen`/`onClose` registrations). Opens a fresh transport per
 * call — the emit client invokes its `connect` factory once per (re)connect.
 *
 * Inbound relay DELIVERY frames are decoded HERE and fanned to the current steer
 * route (the emit client ignores inbound frames), keyed by {@link parseStreamId}
 * so a frame for a foreign stream is dropped rather than misrouted.
 *
 * @param {string} url the resolved `ws(s)://…/agentic?token=…` channel URL
 * @param {import('@nanobpm/urban-agent-client').TransportFactory} transportFactory
 * @param {() => (((instance: string, jobKey: string, chunk: Uint8Array) => void) | null)} getSteerRoute
 * @param {{ warn?: Function, debug?: Function }} log
 * @returns {import('@nanobpm/agentic/emit').EmitSocket}
 */
function makeEmitSocket(url, transportFactory, getSteerRoute, log) {
  let onMessageCb = () => {};
  let onOpenCb = () => {};
  let onCloseCb = () => {};
  let opened = false;
  let closed = false;

  const routeSteer = (bytes) => {
    const route = getSteerRoute();
    if (typeof route !== 'function') return;
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      log.debug?.(`agentic: undecodable inbound frame dropped — ${err?.message || err}`);
      return;
    }
    // Inbound steer rides the relay family as a DELIVERY chunk ({ stream, offset,
    // chunk }, no `op`) whose stream is one of our transcript streams; the stream
    // id carries the target instance + jobKey. A frame for a foreign stream is
    // dropped, never misrouted.
    if (frame.family !== 'relay') return;
    const payload = frame.payload;
    if (!payload || typeof payload !== 'object' || 'op' in payload) return;
    const target = parseStreamId(payload.stream);
    if (target === undefined) return;
    const chunk = typeof payload.chunk === 'string' ? textEncoder.encode(payload.chunk) : new Uint8Array(0);
    try {
      // `target.stream` is `String(jobKey)` by the transcript convention.
      route(target.instance, target.stream, chunk);
    } catch (err) {
      log.debug?.(`agentic: steer route threw — ${err?.message || err}`);
    }
  };

  const transport = transportFactory(url, {
    onOpen() {
      opened = true;
      onOpenCb();
    },
    onFrame(bytes) {
      routeSteer(bytes);
      onMessageCb(bytes);
    },
    onClose() {
      closed = true;
      onCloseCb();
    },
    onError(err) {
      // Non-fatal on its own; a close follows and drives the client's reconnect.
      log.debug?.(`agentic transport error — ${err?.message || err}`);
    },
  });

  return {
    send(bytes) {
      // Drop sends outside the open window: a pre-open send (the client can
      // emit before the transport's onOpen fires) or a post-close send would
      // otherwise hit a transport that throws while connecting/torn down,
      // producing noisy onError logs. The emit client replays presence + active
      // claims on the next open anyway, so a dropped pre-open frame is not lost.
      if (!opened || closed) return;
      transport.send(bytes);
    },
    close() {
      try {
        transport.close();
      } catch {
        /* idempotent best-effort teardown — never throw on close */
      }
    },
    onMessage(listener) {
      if (typeof listener === 'function') onMessageCb = listener;
    },
    onOpen(listener) {
      if (typeof listener !== 'function') return;
      onOpenCb = listener;
      // If the transport already opened before this registered (synchronous
      // injected factories can), fire immediately.
      if (opened) listener();
    },
    onClose(listener) {
      if (typeof listener !== 'function') return;
      onCloseCb = listener;
      // Mirror onOpen: a close-before-registration is observable immediately.
      if (closed) listener();
    },
  };
}

/**
 * Build a {@link import('./supervisor.dist.js').RawEmitClient} backed by ONE
 * {@link AgenticEmitClient}. The client owns reconnect + resync internally; this
 * adapter maps its emitter surface onto the port and installs the inbound-steer
 * seam the client does not carry.
 */
function buildRawEmitClient({ channelUrl, transportFactory, peerAdvertisement, logger, onConnectionState }) {
  const log = logger || {};
  // The inbound-steer route, shared with every socket the client opens across
  // reconnects (each fresh EmitSocket reads it, so steer survives a flap without
  // a per-reconnect re-install).
  const steerHolder = { route: null };

  let firstOpenFired = false;
  let permanentlyClosed = false;
  const openSubs = [];
  const closeSubs = [];

  const notifyState = (state) => {
    if (typeof onConnectionState !== 'function') return;
    try {
      onConnectionState(state);
    } catch (err) {
      log.debug?.(`agentic onConnectionState threw — ${err?.message || err}`);
    }
  };

  const client = new AgenticEmitClient({
    connect: () => makeEmitSocket(channelUrl, transportFactory, () => steerHolder.route, log),
    peerAdvertisement,
    onOpen() {
      // Fires AFTER the client's resync on every (re)connect. Track liveness on
      // each, but resolve the single-shot RawEmitClient `onOpen` (which drives
      // the Effect connect) only once, on the first open.
      notifyState('connected');
      if (firstOpenFired) return;
      firstOpenFired = true;
      for (const cb of openSubs.splice(0)) {
        try {
          cb();
        } catch (err) {
          log.debug?.(`agentic onOpen subscriber threw — ${err?.message || err}`);
        }
      }
    },
    onClose() {
      // A transient mid-life drop: the client reconnects itself and replays
      // presence + claims from its write-through shadow. Surface liveness only —
      // the RawEmitClient's single-shot `onClose` is reserved for a permanent
      // teardown so `superviseAgentic` never double-reconnects underneath it.
      if (permanentlyClosed) return;
      notifyState('disconnected');
    },
    onError(err) {
      log.debug?.(`agentic emit error — ${err?.message || err}`);
    },
  });

  // Negotiated protocol is fixed at construction (additive): a legacy hub that
  // never learned families 8/9 yields a negotiation without claim/release, so the
  // adapter reports them unsupported and the supervisor degrades to a no-op.
  const negotiated = client.protocol;
  const supportsClaimRelease =
    negotiated.supportsFeature('claim-release') &&
    negotiated.supportsFamily('claim') &&
    negotiated.supportsFamily('release');
  const supportsSteer = negotiated.supportsFamily('relay');

  // Open the first socket; the client drives every subsequent reconnect.
  client.open();

  return {
    register(instance, capability) {
      client.register(instance, capability || {});
    },
    heartbeat(instance) {
      client.heartbeat(instance);
    },
    deregister(instance, reason) {
      client.deregister(instance, reason);
    },
    claim(instance, jobKey) {
      client.claim(instance, jobKey);
    },
    release(instance, jobKey) {
      client.release(instance, jobKey);
    },
    transcript(instance, jobKey, chunk) {
      // The transcript convention: stream = String(jobKey); the client composes
      // the injective per-instance stream id via composeStreamId.
      client.transcript({ instance, stream: String(jobKey) }, textDecoder.decode(chunk));
    },
    onSteer(route) {
      steerHolder.route = route;
    },
    onOpen(cb) {
      // If already open (the client can open before this registers), fire now —
      // otherwise the queued callback never runs and connect() hangs.
      if (typeof cb !== 'function') return;
      if (firstOpenFired) {
        cb();
        return;
      }
      openSubs.push(cb);
    },
    onClose(cb) {
      // Mirror onOpen: if already permanently closed, fire immediately so a
      // post-close subscriber still observes the drop.
      if (typeof cb !== 'function') return;
      if (permanentlyClosed) {
        cb();
        return;
      }
      closeSubs.push(cb);
    },
    close() {
      if (permanentlyClosed) return;
      // Mark closed BEFORE teardown so the client's transient onClose observer
      // no-ops and only this permanent path notifies subscribers + liveness.
      permanentlyClosed = true;
      try {
        client.close();
      } catch {
        /* idempotent best-effort teardown — never throw on close */
      }
      for (const cb of closeSubs.splice(0)) {
        try {
          cb();
        } catch (err) {
          log.debug?.(`agentic onClose subscriber threw — ${err?.message || err}`);
        }
      }
      notifyState('disconnected');
    },
    supportsClaimRelease,
    supportsSteer,
  };
}

/**
 * Build the `RawEmitConnect` factory the supervisor's `makeAgenticEndpoint`
 * lifts into `deps.agenticEndpoint`. Each returned `connect()` constructs ONE
 * {@link AgenticEmitClient} over a single multiplexed host connection; the client
 * owns its own reconnect + resync, so — unlike the retired bespoke client —
 * `superviseAgentic` does not re-`connect` or re-emit per drop.
 *
 * The WebSocket transport is loaded once through the plugin's single import
 * surface (`loadAgenticClient()` — which installs the source→dist resolve hook so
 * the client is importable under stock Node); a test injects its own
 * `transportFactory` and never touches the real client.
 *
 * @param {object} opts
 * @param {string} opts.url the app's HTTP(S) base URL (channel served same-port at `/agentic`)
 * @param {string} [opts.token] ADR 0028 identity token (carried as `?token=`)
 * @param {string} [opts.credential] capability credential (carried as `?capability=`)
 * @param {import('@nanobpm/agentic/protocol').ProtocolAdvertisement} [opts.remoteAdvertisement]
 *   the peer's advertised support; omit to assume full support
 * @param {import('@nanobpm/urban-agent-client').TransportFactory} [opts.transportFactory] injectable transport (tests)
 * @param {(state: 'connected'|'disconnected') => void} [opts.onConnectionState] observer fired
 *   when the single host connection opens/drops, so a caller can track its liveness
 * @param {{ warn?: Function, debug?: Function }} [opts.logger]
 * @returns {Promise<() => import('./supervisor.dist.js').RawEmitClient>} a synchronous `connect` factory
 */
export async function createRawEmitConnect(opts) {
  const { url, token, credential, remoteAdvertisement, transportFactory, logger, onConnectionState } = opts || {};
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('createRawEmitConnect requires an agentic channel base url');
  }

  const channelUrl = buildAgenticUrl(url, { token, credential });
  const factory = transportFactory ?? (await loadAgenticClient()).websocketTransport;

  return () =>
    buildRawEmitClient({
      channelUrl,
      transportFactory: factory,
      peerAdvertisement: remoteAdvertisement,
      logger,
      onConnectionState,
    });
}
