// The `work` command's agentic-visibility channel seam (ADR 0056 — slice C2,
// jwulf/c8ctl-plugin-nano#41).
//
// This module owns the SINGLE connected + authenticated channel client a
// running worker (`c8ctl nano work <profile>`) uses to appear on the Workforce
// visibility page. It is the wave-1 scaffold the sibling slices build on:
//
//   - C3 (#42, PTY relay) publishes framed terminal output through the
//     relay-lane sink exposed by {@link WorkChannel.relayLane}.
//   - C4 (#43, buffer) subscribes to the connect / disconnect / reconnect
//     lifecycle events exposed by {@link WorkChannel.onConnect} /
//     {@link WorkChannel.onDisconnect} / {@link WorkChannel.onReconnect} to
//     drive its buffer flush at the transport seam.
//
// Both siblings EXTEND this holder; neither opens, authenticates, or
// re-instantiates the channel. The connected client is created in exactly one
// place — {@link createWorkChannel} — alongside the worker's existing
// `camunda.createClient()` wiring.
//
// Everything on the wire (frame codec, lanes, presence payloads) is CONSUMED
// through this plugin's single import surface (`./agentic.mjs`), which in turn
// consumes `@nanobpm/agentic` + `@nanobpm/urban-agent-client`. Nothing is
// re-declared here.
//
// SCOPE (C2): presence + the shared seam only. Capability→SERVE-token
// resolution (REGISTER/SERVE enrolment) is the separate epic #58 and is NOT
// done here — the worker announces presence (identity, host, live jobs),
// heartbeats, and deregisters, and the SERVE handshake is deliberately left
// disabled (`serveTimeoutMs: 0`, the announce is fire-and-forget).

import { loadAgenticClient } from './agentic.mjs';

const DEFAULT_HEARTBEAT_MS = 10_000;
// Outbound ring size (frames) the client buffers while the hub is unreachable.
// C4 (#43) tunes/uses this seam; a sensible default keeps a worker that starts
// before the app from losing its early presence/relay frames.
const DEFAULT_BUFFER_CAPACITY = 1024;

export { DEFAULT_BUFFER_CAPACITY };
/**
 * Build the worker's agentic-channel WebSocket URL from the app's HTTP base URL
 * plus the ADR 0028 identity token and capability credential, carried as query
 * params — the same `?token=…` pattern the blackboard hook uses (and exactly
 * what `sharedSecretAuthenticator` reads on the hub side). `http`→`ws`,
 * `https`→`wss`; the channel is served same-port at `/agentic`.
 *
 * @param {string} baseUrl the app's own HTTP(S) base URL, e.g. `http://localhost:8080`
 * @param {{ token: string, credential: string, path?: string }} auth
 * @returns {string} the `ws(s)://…/agentic?token=…&capability=…` URL
 */
export function buildAgenticUrl(baseUrl, { token, credential, path = '/agentic' } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('buildAgenticUrl requires a non-empty base URL');
  }
  const u = new URL(baseUrl);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported agentic base URL protocol "${u.protocol}" (expected http/https/ws/wss)`);
  }
  // Preserve any base path, then append the same-port channel path.
  const basePath = u.pathname.replace(/\/+$/, '');
  u.pathname = `${basePath}${path}`;
  if (token !== undefined && token !== null && token !== '') u.searchParams.set('token', String(token));
  if (credential !== undefined && credential !== null && credential !== '') {
    u.searchParams.set('capability', String(credential));
  }
  return u.toString();
}

/**
 * Redact the token/capability query params from a channel URL for logging.
 * @param {string} url
 * @returns {string}
 */
export function redactAgenticUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('token')) u.searchParams.set('token', '***');
    if (u.searchParams.has('capability')) u.searchParams.set('capability', '***');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Normalise a capability object for the `register` presence frame. Drops
 * undefined/empty attributes so the enrolment attribute stays minimal, and
 * carries the worker's live `jobs` (jobKeys) as a forward-compatible nested
 * field — the S0 register validator only requires `capability` to be an object
 * and ignores extra fields ("a later slice may enrich a payload without
 * breaking older peers"), so the visibility page can surface `capability.jobs`
 * without any wire-contract change.
 *
 * @param {{ cognition?: string, weight?: number, family?: string, host?: string }} capability
 * @param {readonly string[]} jobs
 * @returns {object}
 */
function presenceCapability(capability, jobs) {
  const out = {};
  if (capability) {
    if (typeof capability.cognition === 'string' && capability.cognition !== '') out.cognition = capability.cognition;
    if (typeof capability.weight === 'number' && Number.isFinite(capability.weight)) out.weight = capability.weight;
    if (typeof capability.family === 'string' && capability.family !== '') out.family = capability.family;
    if (typeof capability.host === 'string' && capability.host !== '') out.host = capability.host;
  }
  out.jobs = Array.isArray(jobs) ? jobs.map(String) : [];
  return out;
}

/**
 * @typedef {object} WorkChannel
 * @property {import('@nanobpm/urban-agent-client').AgenticClient} client the one connected channel client
 * @property {() => void} refreshPresence re-announce presence (call when the live job set changes)
 * @property {() => { relay: (stream: string, chunk: string) => void }} relayLane C3's relay-lane sink accessor
 * @property {(fn: () => void) => () => void} onConnect subscribe to the first successful connect
 * @property {(fn: (info: object) => void) => () => void} onDisconnect subscribe to channel close
 * @property {(fn: () => void) => () => void} onReconnect subscribe to reconnects (every open after the first)
 * @property {() => boolean} connected whether the channel is currently open
 * @property {() => boolean} everConnected whether the channel has ever opened (stays true after a later close)
 * @property {() => number} buffered outbound frames currently buffered awaiting the channel
 * @property {(reason?: string) => Promise<void>} stop deregister + close cleanly
 */

/**
 * Create the worker's single connected + authenticated agentic channel client
 * and announce presence. The connection begins immediately; because the client
 * buffers outbound frames, presence is announced (and relay is usable) even
 * before the socket is open — it drains on connect.
 *
 * This is the ONLY place the channel client is instantiated in `work`. Sibling
 * slices consume the accessors on the returned holder; they do not connect.
 *
 * @param {object} opts
 * @param {string} opts.instance stable worker instance id (the worker name) carried on every presence frame
 * @param {string} opts.host the worker's host label
 * @param {{ cognition?: string, weight?: number, family?: string, host?: string }} [opts.capability] declared enrolment capability
 * @param {() => readonly string[]} [opts.listJobKeys] reads the live jobKey set from the worker's activeJobs map
 * @param {string} opts.url the app's HTTP(S) base URL (the channel is served same-port at `/agentic`)
 * @param {string} opts.token ADR 0028 identity token
 * @param {string} opts.credential capability credential
 * @param {number} [opts.heartbeatIntervalMs] presence heartbeat cadence (ms)
 * @param {number} [opts.bufferCapacity] outbound ring size in frames
 * @param {import('@nanobpm/urban-agent-client').TransportFactory} [opts.transport] injectable transport (tests)
 * @param {import('@nanobpm/urban-agent-client').ReconnectOptions} [opts.reconnect] reconnect/backoff policy passthrough
 * @param {(fn: () => void, ms: number) => void} [opts.schedule] injectable backoff scheduler (tests)
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger] optional logger
 * @returns {Promise<WorkChannel>}
 */
export async function createWorkChannel(opts) {
  const {
    instance,
    host,
    capability,
    listJobKeys = () => [],
    url,
    token,
    credential,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
    bufferCapacity = DEFAULT_BUFFER_CAPACITY,
    transport,
    reconnect,
    schedule,
    logger,
  } = opts || {};

  if (typeof instance !== 'string' || instance.trim() === '') {
    throw new Error('createWorkChannel requires a non-empty instance id');
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('createWorkChannel requires an agentic channel base url');
  }

  const channelUrl = buildAgenticUrl(url, { token, credential });
  const declaredCapability = { ...(capability || {}) };
  if (typeof host === 'string' && host !== '' && !declaredCapability.host) {
    declaredCapability.host = host;
  }

  const { connectAgenticChannel } = await loadAgenticClient();

  // The single connected client. serveTimeoutMs:0 disables the SERVE handshake
  // wait — SERVE-token resolution is the enrolment epic (#58), out of scope for
  // C2; we only need presence to land, which the REGISTER frame does on its own.
  const client = connectAgenticChannel({
    url: channelUrl,
    instance,
    heartbeatIntervalMs,
    serveTimeoutMs: 0,
    bufferCapacity,
    ...(transport ? { transport } : {}),
    ...(reconnect ? { reconnect } : {}),
    ...(schedule ? { schedule } : {}),
  });

  const log = logger || {};

  /** (Re)announce presence with the current live job set. Fire-and-forget: the
   * REGISTER frame is what makes the worker appear; the returned promise only
   * resolves on a SERVE (disabled here), so we never await it and swallow its
   * rejection so a missing SERVE is not an unhandled rejection. */
  const refreshPresence = () => {
    let jobs = [];
    try {
      jobs = listJobKeys() || [];
    } catch {
      jobs = [];
    }
    const cap = presenceCapability(declaredCapability, jobs);
    // register() enqueues the frame even while the channel is down (it drains on
    // connect); catch guards the deliberately-never-resolving SERVE promise.
    Promise.resolve(client.register({ capability: cap })).catch(() => {});
  };

  // Lifecycle fan-out: the client fires onOpen on the first connect AND on every
  // reconnect. Split that into a one-shot "connect" and a repeated "reconnect"
  // so C4 can distinguish the initial attach from a recovery flush.
  let hasConnected = false;
  const connectListeners = new Set();
  const reconnectListeners = new Set();
  const disconnectListeners = new Set();
  const fan = (set, arg) => {
    for (const fn of set) {
      try {
        fn(arg);
      } catch (err) {
        try {
          log.warn?.(`work-channel listener threw: ${err?.message || err}`);
        } catch {
          /* never let a listener failure escape the lifecycle dispatch */
        }
      }
    }
  };

  client.onOpen(() => {
    if (!hasConnected) {
      hasConnected = true;
      fan(connectListeners);
      // The presence announce buffered before connect drains on this first open,
      // so no re-announce is needed here — avoid a redundant duplicate register.
    } else {
      fan(reconnectListeners);
      // Re-announce presence on RECONNECT so the durable presence row reflects
      // this worker's current identity/host/jobs after a hub restart/outage.
      refreshPresence();
    }
  });
  client.onClose((info) => {
    fan(disconnectListeners, info);
  });

  // Announce presence immediately; the frame buffers and drains on connect.
  refreshPresence();

  const subscribe = (set) => (fn) => {
    if (typeof fn !== 'function') return () => {};
    set.add(fn);
    return () => set.delete(fn);
  };

  /** @type {WorkChannel} */
  const channel = {
    client,
    refreshPresence,
    // C3 (#42): the relay-lane sink. Delegates to the one connected client so
    // relay frames ride the shared, buffered, QoS-ordered outbound path.
    relayLane: () => ({
      relay: (stream, chunk) => client.relay(stream, chunk),
    }),
    onConnect: subscribe(connectListeners),
    onReconnect: subscribe(reconnectListeners),
    onDisconnect: subscribe(disconnectListeners),
    connected: () => client.connected,
    // Whether the channel has ever opened (even if it has since closed). Lets a
    // late subscriber tell "still connecting, never opened" (false) apart from
    // "opened then dropped before I subscribed" (true), so an initial close that
    // fires inside the createWorkChannel() await window is reconciled to
    // `disconnected` rather than left stuck at `connecting`.
    everConnected: () => hasConnected,
    buffered: () => client.buffered,
    async stop(reason = 'worker stopped') {
      try {
        client.deregister(reason);
      } catch (err) {
        try {
          log.warn?.(`agentic deregister failed: ${err?.message || err}`);
          client.close();
        } catch {
          /* best effort — never let shutdown hang on the channel */
        }
      }
    },
  };

  return channel;
}
