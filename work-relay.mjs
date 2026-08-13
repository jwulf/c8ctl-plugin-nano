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
 * @property {() => void} close detach any steer subscription
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
 * @returns {RelaySession}
 */
export function createRelaySession({ channel, jobKey, logger } = {}) {
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
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
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

  let detachFrame = null;
  const attachSteer = (write) => {
    if (typeof write !== 'function') return () => {};
    const client = channel.client;
    if (!client || typeof client.onFrame !== 'function') {
      // No inbound frame surface (e.g. a channel without a client) — steer is a
      // no-op rather than a crash; output relay still works.
      return () => {};
    }
    detachFrame = client.onFrame((frame) => {
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
    return () => {
      try {
        detachFrame?.();
      } finally {
        detachFrame = null;
      }
    };
  };

  const close = () => {
    try {
      detachFrame?.();
    } finally {
      detachFrame = null;
    }
  };

  return { stream, relay, attachSteer, close };
}
