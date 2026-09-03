// The concrete host-connection agentic endpoint (ADR 0056; issue #160).
//
// #158 shipped the host-owned job-ownership protocol as an Effect *interface*
// (`AgenticEndpoint` → `AgenticHandle` implementing `register`/`heartbeat`/
// `deregister`/`claim`/`transcript`/`release`, identity explicit on every frame)
// but no concrete transport — the `0.10.0` `@nanobpm/agentic` had no `claim`/
// `release` presence frames to send. `@nanobpm/agentic` is now `^0.11.0`, which
// lands families 8/9 (`claim`/`release`), the `claim-release`/`multi-instance`
// negotiable features, and the additive negotiation module. This module is the
// concrete wire against that bump: ONE multiplexed WebSocket connection over
// which N supervised workers' presence + ownership + transcript frames ride,
// each frame carrying its `instance` EXPLICITLY (never the connection id — the
// assumption #154 structurally breaks).
//
// It produces a plain, Effect-free `RawEmitClient` (see `supervisor/src/emit.ts`)
// that the supervisor bundle lifts into the Effect `AgenticHandle`. Everything on
// the wire is CONSUMED through this plugin's single import surface (`agentic.mjs`
// → `@nanobpm/agentic` + `@nanobpm/urban-agent-client`); nothing is re-declared.
//
// The supervisor's `superviseAgentic` owns reconnect (it calls the endpoint's
// `connect` again on every drop) and the claim registry owns replay (the resync
// re-`register`s + re-`claim`s before transcript resumes), so this client is thin
// on purpose: one socket, encode-and-send, no buffering or reconnect of its own.

import {
  encodeFrame,
  decodeFrame,
  MAX_SEQ,
  validatePayload,
  negotiate,
  LOCAL_ADVERTISEMENT,
  loadAgenticClient,
} from './agentic.mjs';
import { buildAgenticUrl } from './work-channel.mjs';

// Presence + ownership frames are facts — they ride the CONTROL lane so a
// transcript storm on the bulk lane can never delay a claim/release (the QoS
// ordering contract). Transcript chunks ride BULK.
const CONTROL_LANE = 'control';
const BULK_LANE = 'bulk';

// A transcript stream name that encodes BOTH the owning instance and the jobKey,
// so two workers' (or two jobs') transcript streams over the one connection can
// never collide. `encodeURIComponent` on each segment makes the join
// unambiguous regardless of what characters an instance/jobKey contains.
function composeTranscriptStream(instance, jobKey) {
  return `t/${encodeURIComponent(instance)}/${encodeURIComponent(jobKey)}`;
}

// Reverse of {@link composeTranscriptStream}. Returns null for a stream that is
// not one of ours (a foreign/blackboard stream), so an inbound steer frame for
// an unrecognised stream is dropped rather than misrouted.
function parseTranscriptStream(stream) {
  if (typeof stream !== 'string') return null;
  const parts = stream.split('/');
  if (parts.length !== 3 || parts[0] !== 't') return null;
  try {
    return { instance: decodeURIComponent(parts[1]), jobKey: decodeURIComponent(parts[2]) };
  } catch {
    return null;
  }
}

// Drop undefined/empty attributes from a declared capability so the enrolment
// attribute on `register` stays minimal (the S0 validator only requires
// `capability` to be an object and tolerates extra fields).
function cleanCapability(capability) {
  const out = {};
  if (capability && typeof capability === 'object') {
    for (const [k, v] of Object.entries(capability)) {
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
  }
  return out;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// Compute the negotiated protocol against the peer's advertisement. There is no
// wired advertisement-exchange frame in the `0.11.0` protocol yet, so a caller
// that has not learned the peer's support passes nothing and we assume the peer
// matches this build (full support) — additive negotiation still degrades
// correctly the moment a real remote advertisement is supplied (an old hub that
// never learned `claim`/`release` yields a negotiation without them, so those
// methods report unsupported and the adapter omits them).
function negotiatedSupport(remoteAdvertisement) {
  const negotiated = negotiate(LOCAL_ADVERTISEMENT, remoteAdvertisement ?? LOCAL_ADVERTISEMENT);
  return {
    claimRelease:
      negotiated.supportsFeature('claim-release') &&
      negotiated.supportsFamily('claim') &&
      negotiated.supportsFamily('release'),
    // Inbound steer rides the relay lane as a delivery frame keyed by our
    // transcript-stream naming; it is installable whenever relay is negotiated.
    steer: negotiated.supportsFamily('relay'),
  };
}

/**
 * Open one multiplexed host connection and return a {@link RawEmitClient}.
 *
 * @param {object} params
 * @param {string} params.url the resolved `ws(s)://…/agentic?token=…` channel URL
 * @param {import('@nanobpm/urban-agent-client').TransportFactory} params.transportFactory
 * @param {number} params.incarnation producer generation stamped on transcript
 *   frames (strictly higher on each successive connection so a reconnected
 *   producer fences its stale predecessor on the hub's incarnation ring)
 * @param {{ claimRelease: boolean, steer: boolean }} params.support negotiated capabilities
 * @param {{ warn?: Function, debug?: Function }} [params.logger]
 * @returns {import('./supervisor.dist.js').RawEmitClient}
 */
function openHostConnection({ url, transportFactory, incarnation, support, logger }) {
  const log = logger || {};
  const openCbs = [];
  const closeCbs = [];
  let steerRoute = null;
  let open = false;
  let seq = 0;

  // Monotonic uint32 sequence with wraparound — the relay resume-from-offset
  // counter; mirrors the client lib's own seq handling.
  const nextSeq = () => {
    const s = seq;
    seq = seq >= MAX_SEQ ? 0 : seq + 1;
    return s;
  };

  let transport = null;

  const send = (lane, family, payload) => {
    if (!open || transport === null) {
      // Contract: a not-open transport throws synchronously so the adapter can
      // surface a SupervisorError the best-effort caller swallows (the next
      // resync replays it). Guard here too so we never encode into a dead socket.
      throw new Error(`agentic transport not open (cannot send ${family})`);
    }
    const check = validatePayload(family, payload);
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.code}:${e.message}`).join(', ');
      throw new Error(`invalid ${family} payload — ${detail}`);
    }
    transport.send(encodeFrame({ lane, family, seq: nextSeq(), payload }));
  };

  const handleInbound = (bytes) => {
    if (steerRoute === null) return;
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      log.debug?.(`agentic: undecodable inbound frame dropped — ${err?.message || err}`);
      return;
    }
    // Inbound steer rides the relay family as a DELIVERY chunk ({ stream, offset,
    // chunk }, no `op`) whose stream is one of our transcript streams; the stream
    // carries the target instance + jobKey. A frame for a foreign stream is
    // dropped, never misrouted.
    if (frame.family !== 'relay') return;
    const payload = frame.payload;
    if (!payload || typeof payload !== 'object' || 'op' in payload) return;
    const target = parseTranscriptStream(payload.stream);
    if (target === null) return;
    const chunk = typeof payload.chunk === 'string' ? textEncoder.encode(payload.chunk) : new Uint8Array(0);
    try {
      steerRoute(target.instance, target.jobKey, chunk);
    } catch (err) {
      log.debug?.(`agentic: steer route threw — ${err?.message || err}`);
    }
  };

  transport = transportFactory(url, {
    onOpen() {
      open = true;
      for (const cb of openCbs) cb();
    },
    onFrame(bytes) {
      handleInbound(bytes);
    },
    onClose() {
      open = false;
      for (const cb of closeCbs) cb();
    },
    onError(err) {
      // Non-fatal on its own; a close follows and drives the reconnect. Surface
      // it for diagnosis only.
      log.debug?.(`agentic transport error — ${err?.message || err}`);
    },
  });

  return {
    register(instance, capability) {
      send(CONTROL_LANE, 'register', { instance, capability: cleanCapability(capability) });
    },
    heartbeat(instance) {
      send(CONTROL_LANE, 'heartbeat', { instance });
    },
    deregister(instance, reason) {
      send(CONTROL_LANE, 'deregister', reason ? { instance, reason } : { instance });
    },
    claim(instance, jobKey) {
      send(CONTROL_LANE, 'claim', { instance, jobKey });
    },
    release(instance, jobKey) {
      send(CONTROL_LANE, 'release', { instance, jobKey });
    },
    transcript(instance, jobKey, chunk) {
      send(BULK_LANE, 'relay', {
        op: 'produce',
        stream: composeTranscriptStream(instance, jobKey),
        incarnation,
        chunk: textDecoder.decode(chunk),
      });
    },
    onSteer(route) {
      steerRoute = route;
    },
    onOpen(cb) {
      openCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      try {
        transport?.close();
      } catch {
        /* idempotent best-effort teardown — never throw on close */
      }
    },
    supportsClaimRelease: support.claimRelease,
    supportsSteer: support.steer,
  };
}

/**
 * Build the `RawEmitConnect` factory the supervisor's `makeAgenticEndpoint`
 * lifts into `deps.agenticEndpoint`. Each returned `connect()` opens ONE fresh
 * multiplexed host connection (a reconnect calls it again), stamped with a
 * strictly-increasing incarnation so a reconnected transcript producer fences
 * its stale predecessor.
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
 *   the peer's advertised support; omit to assume full support (see {@link negotiatedSupport})
 * @param {number} [opts.incarnationBase] first transcript incarnation (default `Date.now()`)
 * @param {import('@nanobpm/urban-agent-client').TransportFactory} [opts.transportFactory] injectable transport (tests)
 * @param {{ warn?: Function, debug?: Function }} [opts.logger]
 * @returns {Promise<() => import('./supervisor.dist.js').RawEmitClient>} a synchronous `connect` factory
 */
export async function createRawEmitConnect(opts) {
  const { url, token, credential, remoteAdvertisement, incarnationBase, transportFactory, logger } = opts || {};
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('createRawEmitConnect requires an agentic channel base url');
  }

  const channelUrl = buildAgenticUrl(url, { token, credential });
  const factory = transportFactory ?? (await loadAgenticClient()).websocketTransport;
  const support = negotiatedSupport(remoteAdvertisement);

  // Strictly-increasing per-connection incarnation so successive reconnects fence
  // their predecessor on the hub's transcript ring (a monotonic takeover counter,
  // seeded from the clock so a later-started process starts ahead).
  let generation = Number.isInteger(incarnationBase) && incarnationBase >= 0 ? incarnationBase : Date.now();

  return () =>
    openHostConnection({
      url: channelUrl,
      transportFactory: factory,
      incarnation: generation++,
      support,
      logger,
    });
}

// Exposed for unit tests / reuse.
export { composeTranscriptStream, parseTranscriptStream, negotiatedSupport, cleanCapability };
