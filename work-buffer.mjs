// The `work` command's hub-down buffer observability + policy layer
// (ADR 0056 — slice C4, jwulf/c8ctl-plugin-nano#43).
//
// C4 makes a running worker survive hub disconnects: while the app hub is
// unreachable (the worker started before the app, or the hub restarted) the
// worker keeps producing frames, and they drain — bounded and in order — when
// the channel comes back.
//
// DERIVATION OVER DUPLICATION. The bounded local buffer this slice is about
// ALREADY exists as the connected client's built-in `OutboundRing` (in
// `@nanobpm/urban-agent-client`): a QoS-aware, capacity-bounded ring that holds
// every outbound frame while the socket is down and drains in strict lane
// priority (control → interactive → bulk, FIFO within a lane) on reconnect,
// shedding the single least-important frame on overflow. It sits at the
// TRANSPORT seam — below the lanes — so it captures any lane's frames and is
// therefore independent of C3's relay producer. We do NOT re-declare a second
// ring here (that would be a parallel, drift-prone buffer over the same
// frames); we CONSUME the canonical one through C2's `WorkChannel` seam.
//
// What this slice actually adds over C2's client is the two things the built-in
// ring leaves implicit:
//
//   1. The bound is OPERATOR-CONFIGURABLE, not a buried literal — see
//      {@link resolveBufferCapacity} (wired to `NANO_AGENTIC_BUFFER_CAPACITY`
//      in `resolveAgenticConfig`), so a long expected outage can be given more
//      headroom without a code change.
//   2. The drop/backpressure policy is OBSERVABLE. The client sheds overflow
//      frames silently (`relay()` returns void; the evicted frame is dropped
//      inside the ring). {@link createBufferMonitor} turns that silent bound
//      into a visible signal: it watches the buffer depth across C2's
//      connect / disconnect / reconnect lifecycle, records a high-water mark
//      and each outage→flush, and warns when the bound is hit so a hit bound is
//      never silent data loss.
//
// The monitor is driven ENTIRELY by C2's lifecycle events + the client's
// buffer-drained event; it never opens, authenticates, or re-instantiates the
// channel, and it never produces frames of its own. It is pure observation over
// the one connected client.

const DEFAULT_BUFFER_CAPACITY = 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

export { DEFAULT_BUFFER_CAPACITY };

/**
 * Resolve the outbound-buffer bound (in frames) from an operator-supplied value
 * with a sane fallback. The bound MUST be a positive integer — the client's
 * `OutboundRing` throws on a non-positive capacity, so we validate here and fall
 * back rather than let a typo wedge enrolment. Accepts a number or a numeric
 * string (env vars arrive as strings).
 *
 * @param {unknown} raw the operator value (e.g. `process.env.NANO_AGENTIC_BUFFER_CAPACITY`)
 * @param {number} [fallback] the default when `raw` is absent/invalid
 * @returns {number} a positive-integer frame bound
 */
export function resolveBufferCapacity(raw, fallback = DEFAULT_BUFFER_CAPACITY) {
  const base = Number.isInteger(fallback) && fallback > 0 ? fallback : DEFAULT_BUFFER_CAPACITY;
  if (raw === undefined || raw === null || raw === '') return base;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return base;
  return n;
}

/**
 * @typedef {object} BufferHealth
 * @property {number} capacity the configured frame bound
 * @property {number} buffered frames currently held awaiting a live channel
 * @property {boolean} connected whether the channel is currently open
 * @property {number} highWaterMark the deepest buffer depth observed
 * @property {number} outages number of times the channel went from up→down (buffering began)
 * @property {number} reconnects number of times the channel recovered (up again after a drop)
 * @property {number} flushes number of outage backlogs that fully drained on (re)connect
 * @property {number} lastFlushFrames backlog size captured at the (re)connect that drove the last flush
 * @property {number|null} lastFlushAt timestamp (ms) the last flush completed, or null
 * @property {number} atCapacityEvents times a sample found the buffer at/over its bound (overflow shedding)
 * @property {boolean} atCapacity whether the last sample was at/over the bound
 */

/**
 * @typedef {object} BufferMonitor
 * @property {() => BufferHealth} health snapshot of the buffer's current health/metrics
 * @property {() => number} sample take a depth sample now (updates high-water / at-capacity); returns the depth
 * @property {() => void} stop detach all listeners and stop sampling (idempotent)
 */

/**
 * Observe the connected client's built-in outbound buffer across C2's channel
 * lifecycle and surface its health + the (otherwise silent) drop policy.
 *
 * The monitor:
 *  - reads live depth via `channel.buffered()` (the client's `OutboundRing`
 *    size) — it does not hold its own buffer;
 *  - on the FIRST connect and every RECONNECT, captures the backlog about to
 *    flush (the client fires `onOpen`/our lifecycle listeners BEFORE it pumps
 *    the ring, so the depth read here is the pre-drain backlog) and, when the
 *    client's `onDrain` then fires (ring emptied after sending), records the
 *    completed flush;
 *  - on DISCONNECT (or immediately, if the worker starts before the app and is
 *    not connected yet), enters an "outage" and samples depth periodically so a
 *    growing backlog that hits the bound is noticed and warned about;
 *  - keeps a high-water mark and an at-capacity counter, warning (once per
 *    transition into the at-capacity state, to avoid log spam) so operators see
 *    that the bound is shedding frames.
 *
 * @param {import('./work-channel.mjs').WorkChannel} channel the C2 seam holder
 * @param {object} [opts]
 * @param {number} [opts.capacity] the configured bound (for health/at-capacity); defaults to DEFAULT_BUFFER_CAPACITY
 * @param {number} [opts.sampleIntervalMs] periodic depth-sample cadence while in an outage; <=0 disables the timer
 * @param {{ warn?: Function, info?: Function, debug?: Function }} [opts.logger] optional logger
 * @param {() => number} [opts.now] injectable clock (tests); defaults to Date.now
 * @param {{ setInterval: Function, clearInterval: Function }} [opts.timers] injectable timers (tests)
 * @returns {BufferMonitor}
 */
export function createBufferMonitor(channel, opts = {}) {
  if (!channel || typeof channel.buffered !== 'function') {
    throw new Error('createBufferMonitor requires a WorkChannel with a buffered() accessor');
  }
  const capacity = resolveBufferCapacity(opts.capacity, DEFAULT_BUFFER_CAPACITY);
  const sampleIntervalMs = Number.isFinite(opts.sampleIntervalMs)
    ? opts.sampleIntervalMs
    : DEFAULT_SAMPLE_INTERVAL_MS;
  const log = opts.logger || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const timers = opts.timers || { setInterval, clearInterval };

  const state = {
    highWaterMark: 0,
    outages: 0,
    reconnects: 0,
    flushes: 0,
    lastFlushFrames: 0,
    lastFlushAt: /** @type {number|null} */ (null),
    atCapacityEvents: 0,
    atCapacity: false,
  };

  // `buffering` is true while we believe frames are queued for a hub that is
  // down — set at disconnect (and at creation if we start disconnected), and
  // cleared when the outage's backlog finishes flushing (the client's next
  // onDrain) or when a (re)connect finds nothing was buffered. The client fires
  // our lifecycle connect/reconnect listeners BEFORE it pumps the ring (and thus
  // before its buffer-drained event), so settleOnOpen captures the pre-drain
  // backlog into `outageBacklogPeak` and the subsequent onDrain records it.
  // `outageBacklogPeak` is the deepest the buffer got during the current
  // outage — what we report as the flushed frame count.
  let buffering = false;
  let outageBacklogPeak = 0;
  let sampleTimer = null;
  let stopped = false;

  const depth = () => {
    try {
      return Number(channel.buffered()) || 0;
    } catch {
      return 0;
    }
  };

  /** Take a depth sample: update the high-water mark, the per-outage peak, and
   * the at-capacity signal. */
  const sample = () => {
    const d = depth();
    if (d > state.highWaterMark) state.highWaterMark = d;
    if (buffering && d > outageBacklogPeak) outageBacklogPeak = d;
    const atCap = d >= capacity;
    if (atCap) {
      state.atCapacityEvents += 1;
      if (!state.atCapacity) {
        // Transition into the at-capacity state — warn ONCE so the operator sees
        // the bound is now shedding the least-important frames (bulk relay
        // before interactive before control), but we don't spam every sample.
        try {
          log.warn?.(
            `agentic outbound buffer at capacity (${d}/${capacity} frames): the hub is unreachable and the bound is now shedding the lowest-priority frames. Raise NANO_AGENTIC_BUFFER_CAPACITY for a longer expected outage.`,
          );
        } catch {
          /* a logger failure must never break sampling */
        }
      }
    }
    state.atCapacity = atCap;
    return d;
  };

  const startSampler = () => {
    if (stopped || sampleTimer !== null || sampleIntervalMs <= 0) return;
    sampleTimer = timers.setInterval(() => sample(), sampleIntervalMs);
    // Don't keep the event loop alive just to sample a buffer.
    if (sampleTimer && typeof sampleTimer.unref === 'function') sampleTimer.unref();
  };
  const stopSampler = () => {
    if (sampleTimer !== null) {
      timers.clearInterval(sampleTimer);
      sampleTimer = null;
    }
  };

  // Enter an outage: begin (or continue) buffering and start watching depth.
  const beginOutage = () => {
    buffering = true;
    outageBacklogPeak = 0;
    state.atCapacity = false;
    startSampler();
    sample();
  };

  // A (re)connect happened. The client fires this listener BEFORE it pumps the
  // ring, so depth() here is the pre-drain backlog (captured below); the
  // client's onDrain then fires and records the completed flush. If we are still
  // buffering and the buffer is already empty, the outage carried nothing to
  // flush — just clear it.
  const settleOnOpen = () => {
    stopSampler();
    // Capture the pre-drain backlog. The client fires our connect/reconnect
    // listeners BEFORE it pumps the ring (see the module header), so depth()
    // here is the backlog about to flush. Recording it into the outage peak
    // makes the flush count (onDrain) reflect the real drained depth even when
    // no periodic sample happened to catch the peak — under production
    // timer-based sampling a short outage would otherwise leave the peak at 0
    // and fall back to 1.
    const d = depth();
    if (d > state.highWaterMark) state.highWaterMark = d;
    if (buffering && d > outageBacklogPeak) outageBacklogPeak = d;
    if (buffering && d === 0) {
      buffering = false;
      outageBacklogPeak = 0;
    }
    state.atCapacity = false;
  };

  const unsub = [];

  // First connect (worker-before-app: the pre-app backlog flushes here too).
  unsub.push(
    channel.onConnect(() => {
      settleOnOpen();
    }),
  );
  // Every recovery after a drop (hub restart / transient outage).
  unsub.push(
    channel.onReconnect(() => {
      state.reconnects += 1;
      settleOnOpen();
    }),
  );
  // The channel went down: begin (or continue) buffering; sample the backlog as
  // it grows so a bound hit is noticed even during a long outage.
  unsub.push(
    channel.onDisconnect(() => {
      state.outages += 1;
      beginOutage();
    }),
  );
  // The client's outbound ring emptied after sending: if we were flushing an
  // outage backlog, the drain is now complete.
  if (channel.client && typeof channel.client.onDrain === 'function') {
    unsub.push(
      channel.client.onDrain(() => {
        if (buffering) {
          state.flushes += 1;
          state.lastFlushFrames = Math.max(outageBacklogPeak, 1);
          state.lastFlushAt = now();
          buffering = false;
          outageBacklogPeak = 0;
          stopSampler();
        }
      }),
    );
  }

  // Worker-before-app: if we're created while the channel is still down, we are
  // already buffering — start sampling immediately so a pre-connect bound hit is
  // observed and the first-connect drain is recorded as a flush.
  let connectedNow = false;
  try {
    connectedNow = typeof channel.connected === 'function' ? Boolean(channel.connected()) : false;
  } catch {
    connectedNow = false;
  }
  if (!connectedNow) {
    buffering = true;
    outageBacklogPeak = 0;
    startSampler();
    sample();
  }

  return {
    health() {
      return {
        capacity,
        buffered: depth(),
        connected: (() => {
          try {
            return typeof channel.connected === 'function' ? Boolean(channel.connected()) : false;
          } catch {
            return false;
          }
        })(),
        highWaterMark: state.highWaterMark,
        outages: state.outages,
        reconnects: state.reconnects,
        flushes: state.flushes,
        lastFlushFrames: state.lastFlushFrames,
        lastFlushAt: state.lastFlushAt,
        atCapacityEvents: state.atCapacityEvents,
        atCapacity: state.atCapacity,
      };
    },
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      stopSampler();
      for (const off of unsub) {
        try {
          off?.();
        } catch {
          /* best effort */
        }
      }
      unsub.length = 0;
    },
  };
}
