// The `work` command's live-terminal relay seam (ADR 0056 — slice C3,
// jwulf/c8ctl-plugin-nano#42).
//
// This module streams a running agent harness's terminal on the agentic
// channel's RELAY lane, tagged with the originating `jobKey`, and accepts
// steer-in: bytes an operator's cockpit sends back on the same relay stream are
// written into the harness's PTY so the run can be steered live.
//
// It BUILDS ON C2's merged channel seam (`work-channel.mjs`): the single
// connected + authenticated channel client is instantiated once in `workAgent`,
// and this slice consumes the accessors on that holder — it does NOT open,
// authenticate, or re-instantiate the channel:
//
//   - {@link createRelaySession} publishes framed terminal output through
//     `channel.relayLane().relay(stream, chunk)` (C2's bulk-lane sink), and
//     subscribes to inbound relay frames via `channel.client.onFrame` for
//     steer-in.
//
// Everything on the wire (the `relay` message family + its `{ stream, offset,
// chunk }` payload) is CONSUMED through C2's client — nothing is re-declared
// here. PTY allocation itself is a local concern (see `openTerminal` /
// `spawnCapturePty` in the plugin); this module is transport-agnostic and takes
// a duck-typed terminal handle, so it is unit-testable with a fake terminal and
// a fake channel.

import { transcript as agenticTranscript } from './agentic.mjs';

/** Prefix for a per-job relay stream name. One stream carries a job's terminal. */
export const RELAY_STREAM_PREFIX = 'job:';

/**
 * The canonical relay stream name for a job. Both the worker's produced output
 * frames and the cockpit's steer-in frames ride this one stream, so the two
 * ends agree on routing from the `jobKey` alone (the `jobKey` is available from
 * `activateJobs` when the job is activated). Direction distinguishes them: the
 * worker PRODUCES output frames on it and READS inbound frames on it as steer.
 *
 * @param {string|number} jobKey
 * @returns {string}
 */
export function relayStreamName(jobKey) {
  return `${RELAY_STREAM_PREFIX}${String(jobKey)}`;
}

/**
 * The initial produce frame emitted on a relay stream the instant a session is
 * created: a canonical `@nanobpm/agentic` lifecycle "open" transcript event.
 *
 * It carries no agent output — its sole job is to OPEN the `job:<jobKey>` stream
 * immediately so the app's correlation registry links this worker→jobKey on
 * session creation, INDEPENDENT of whether the agent later emits any transcript
 * bytes. Without it, a quiet ACP agent (one that emits no mappable
 * `session/update`) never produces a `job:` frame, so the app never correlates
 * the job — it renders "—" in the cockpit with no drill-in, even though the job
 * ran and completed (regression since #128 coupled correlation to transcript
 * bytes). Newline-framed to match the transcript-chunk framing the ACP relay
 * path uses, and derived through `encodeTranscriptEvent` (never hand-rolled) so
 * the wire marker stays single-sourced in `@nanobpm/agentic`.
 */
export const RELAY_OPEN_CHUNK = `${agenticTranscript.encodeTranscriptEvent({
  kind: 'lifecycle',
  phase: 'open',
})}\n`;

/**
 * The final produce frame emitted on a relay stream the instant a session is
 * closed: the closing twin of {@link RELAY_OPEN_CHUNK} — a canonical
 * `@nanobpm/agentic` lifecycle "close" transcript event.
 *
 * It carries no agent output — its sole job is to CLOSE the `job:<jobKey>`
 * stream so the app can flush the durable transcript deterministically at job
 * completion (nanobpm/nano-workforce#710), instead of relying only on the
 * supersede/disconnect fallback (which can abandon the tail frames). Without it,
 * a completed job's live-terminal transcript is truncated at the tail. Emitted
 * from {@link RelaySession.close} before the outbound buffer is drained, so the
 * close marker itself rides the same buffered, QoS-ordered relay lane as the
 * agent's output (and survives a brief hub outage via C4's ring where possible).
 * Newline-framed to match `RELAY_OPEN_CHUNK`, and derived through
 * `encodeTranscriptEvent` (never hand-rolled) so the wire marker stays
 * single-sourced in `@nanobpm/agentic`.
 */
export const RELAY_CLOSE_CHUNK = `${agenticTranscript.encodeTranscriptEvent({
  kind: 'lifecycle',
  phase: 'close',
})}\n`;

/** Default bound on the outbound-buffer drain at session close (ms). A hub
 * outage must never wedge job completion, so the drain is always bounded: on
 * timeout the caller completes anyway and the app's supersede/disconnect
 * fallback still eventually flushes whatever arrived. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
/** Default poll cadence while awaiting `channel.buffered() → 0` (ms). */
export const DEFAULT_DRAIN_POLL_MS = 25;

/**
 * Resolve a role's terminal mode — whether the agent harness for this role gets
 * a full PTY or a plain pipe. Honors the vocab's per-role opt-in: a role may set
 * `terminal: 'pty' | 'pipe'` (preferred) or the boolean shorthand `pty: true`.
 * Defaults to `'pipe'` — a pipe is the safe, non-interactive default; a PTY is
 * opt-in per role because it changes the harness's I/O semantics (a TTY, line
 * discipline, echo).
 *
 * The lookup is deliberately structural so it works whether it is fed a vocab
 * `VocabRole` (forward-compatible: the schema tolerates extra fields) or this
 * repo's local role notion (a hire profile).
 *
 * @param {{ terminal?: unknown, pty?: unknown } | null | undefined} role
 * @returns {'pty' | 'pipe'}
 */
export function roleTerminalMode(role) {
  if (role && typeof role === 'object') {
    const t = role.terminal;
    if (typeof t === 'string') {
      const norm = t.trim().toLowerCase();
      if (norm === 'pty') return 'pty';
      if (norm === 'pipe') return 'pipe';
    }
    if (role.pty === true) return 'pty';
  }
  return 'pipe';
}

/**
 * Narrow an inbound channel {@link Frame} to the steer-in chunk destined for a
 * given relay stream, or `null` when it is not one. Consumes the shared `relay`
 * family payload (`{ stream, offset, chunk }`) — never re-declares it.
 *
 * @param {{ family?: unknown, payload?: unknown } | null | undefined} frame
 * @param {string} stream the relay stream this session listens on
 * @returns {string | null} the steer bytes (as the payload's `chunk` string), or null
 */
export function parseInboundRelayChunk(frame, stream) {
  if (!frame || frame.family !== 'relay') return null;
  const payload = frame.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.stream !== stream) return null;
  const chunk = payload.chunk;
  return typeof chunk === 'string' ? chunk : null;
}

/**
 * @typedef {object} RelaySession
 * @property {string} stream the relay stream name (derived from the jobKey)
 * @property {(chunk: string|Uint8Array) => void} relay publish one framed, jobKey-tagged output chunk on the relay lane
 * @property {(write: (chunk: string) => void) => (() => void)} attachSteer wire inbound steer bytes for this stream to `write`; returns a detach fn
 * @property {() => Promise<{ closeEmitted: boolean, drained: boolean, timedOut: boolean }>} close emit the `phase:close` lifecycle event, detach any steer subscription, then drain the outbound buffer (bounded)
 */

/**
 * Create the live-terminal relay session for one job. Ties C2's connected
 * channel to a single job's terminal:
 *
 *   - {@link RelaySession.relay} frames each stdout/PTY chunk and streams it on
 *     the relay lane tagged with this job's `jobKey` (the stream name), through
 *     C2's `channel.relayLane()` sink — so it rides the shared, buffered,
 *     QoS-ordered outbound path (and survives a hub outage via C4's ring).
 *   - {@link RelaySession.attachSteer} subscribes to inbound relay frames on the
 *     same stream (via C2's `channel.client.onFrame`) and hands their bytes to a
 *     writer that feeds the harness's PTY — the operator's steer-in.
 *
 * @param {object} opts
 * @param {import('./work-channel.mjs').WorkChannel} opts.channel the C2 channel holder (NOT re-instantiated)
 * @param {string|number} opts.jobKey the activated job's key; tags every frame and names the stream
 * @param {{ warn?: Function, debug?: Function }} [opts.logger]
 * @param {number} [opts.drainTimeoutMs] bound on the close-time outbound-buffer drain (ms); a hub outage must never wedge completion
 * @param {number} [opts.drainPollMs] poll cadence while awaiting `channel.buffered() → 0` (ms)
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable delay (tests); defaults to a `setTimeout` promise
 * @param {() => number} [opts.now] injectable clock (tests); defaults to `Date.now`
 * @returns {RelaySession}
 */
export function createRelaySession({
  channel,
  jobKey,
  logger,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  drainPollMs = DEFAULT_DRAIN_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (!channel || typeof channel.relayLane !== 'function') {
    throw new Error('createRelaySession requires a WorkChannel with a relayLane() accessor');
  }
  if (jobKey === undefined || jobKey === null || String(jobKey) === '') {
    throw new Error('createRelaySession requires a jobKey');
  }
  const stream = relayStreamName(jobKey);
  const log = logger || {};
  // Bind the sink once. C2's relayLane() delegates to the single connected
  // client, so relay frames coalesce onto the one buffered outbound ring.
  const sink = channel.relayLane();

  const relay = (chunk) => {
    if (chunk == null) return;
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : Buffer.from(chunk).toString('utf8');
    if (text === '') return;
    try {
      sink.relay(stream, text);
    } catch (err) {
      try {
        log.warn?.(`relay produce failed for ${stream}: ${err?.message || err}`);
      } catch {
        /* never let a logging failure escape the relay path */
      }
    }
  };

  // Each attachSteer call owns its own subscription + detach fn; close() tears
  // down every one. Tracking them individually (rather than a single shared
  // handle) means a second attachSteer can't clobber an earlier subscription's
  // detach — every returned fn detaches exactly the subscription it created.
  const activeDetaches = new Set();
  const attachSteer = (write) => {
    if (typeof write !== 'function') return () => {};
    const client = channel.client;
    if (!client || typeof client.onFrame !== 'function') {
      // No inbound frame surface (e.g. a channel without a client) — steer is a
      // no-op rather than a crash; output relay still works.
      return () => {};
    }
    const detachFrame = client.onFrame((frame) => {
      const chunk = parseInboundRelayChunk(frame, stream);
      if (chunk === null) return;
      try {
        write(chunk);
      } catch (err) {
        try {
          log.warn?.(`steer-in write failed for ${stream}: ${err?.message || err}`);
        } catch {
          /* swallow */
        }
      }
    });
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      activeDetaches.delete(detach);
      try {
        detachFrame?.();
      } catch {
        /* swallow */
      }
    };
    activeDetaches.add(detach);
    return detach;
  };

  // The outbound-buffer drain: poll `channel.buffered()` down to zero, bounded
  // by drainTimeoutMs. A channel without a buffered() accessor (or one that
  // throws) is treated as already drained — the drain must never block or crash
  // completion. Returns whether the buffer emptied and whether we hit the bound.
  const drain = async () => {
    if (typeof channel.buffered !== 'function') return { drained: true, timedOut: false };
    const deadline = now() + Math.max(0, Number(drainTimeoutMs) || 0);
    for (;;) {
      let pending;
      try {
        pending = channel.buffered();
      } catch {
        return { drained: true, timedOut: false };
      }
      if (!(Number(pending) > 0)) return { drained: true, timedOut: false };
      if (now() >= deadline) {
        try {
          log.warn?.(`relay drain timed out for ${stream}: ${pending} frame(s) still buffered; completing anyway`);
        } catch {
          /* never let a logging failure escape the drain path */
        }
        return { drained: false, timedOut: true };
      }
      await sleep(Math.max(1, Number(drainPollMs) || 1));
    }
  };

  // close() is idempotent: a second call returns the same settled promise
  // without re-emitting the close marker or re-draining.
  let closed = false;
  let closedPromise = Promise.resolve({ closeEmitted: false, drained: true, timedOut: false });
  const close = () => {
    if (closed) return closedPromise;
    closed = true;
    // Emit the closing lifecycle twin of RELAY_OPEN_CHUNK FIRST, so the app can
    // flush the durable transcript deterministically at completion
    // (nanobpm/nano-workforce#710). Routed through the internal relay(), which
    // swallows sink errors, so emitting the close marker never fails the job. It
    // rides the same buffered relay lane as the agent's output, and is included
    // in the drain below.
    relay(RELAY_CLOSE_CHUNK);
    // Detach every steer subscription so none outlives the job.
    for (const detach of [...activeDetaches]) detach();
    // Then drain the outbound buffer — a bounded await until the agent's tail
    // bytes (and the close marker) are actually transmitted before the job
    // settles. The bound is essential: a hub outage must not wedge completion,
    // so on timeout we resolve anyway (the app's supersede/disconnect fallback
    // still eventually flushes what arrived).
    closedPromise = drain().then((res) => ({ closeEmitted: true, ...res }));
    return closedPromise;
  };

  // Open the stream the instant the session exists, so the app correlates
  // worker→jobKey immediately — independent of any later agent transcript bytes
  // (a quiet ACP agent emits none). Routed through the internal relay(), which
  // already swallows sink errors, so opening the stream never fails the job.
  relay(RELAY_OPEN_CHUNK);

  return { stream, relay, attachSteer, close };
}
