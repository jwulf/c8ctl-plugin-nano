/**
 * The concrete {@link AgenticEndpoint} adapter (issue #160).
 *
 * #158 defined the host-owned ownership protocol as an Effect *interface*
 * ({@link AgenticEndpoint} → {@link AgenticHandle} implementing {@link
 * OwnershipFrames}); #160 wires it to a real transport. The wire itself —
 * `@nanobpm/agentic`'s frame codec, presence/relay families, WebSocket
 * transport, and additive `claim`/`release` negotiation — lives in the raw-JS
 * monolith behind its single import surface (`agentic.mjs`), so it is NOT
 * bundled into this Effect-only, quarantined module (AGENTS.md "one import
 * surface"). This file is the thin, deterministically-testable seam between the
 * two: it lifts a plain, Effect-free {@link RawEmitClient} — one multiplexed
 * host connection the monolith builds against the bumped `@nanobpm/agentic` —
 * into the Effect {@link AgenticHandle} the supervisor consumes.
 *
 * Every frame method is best-effort at the call site (see `emitFrame` in
 * `ownership.ts`): the adapter only maps a raw synchronous throw into a
 * {@link SupervisorError} so a transient send failure is logged-and-swallowed by
 * the caller, never crashing the supervisor. Additivity is honoured by OMITTING
 * a handle method when the negotiated protocol lacks its capability — an old hub
 * that never learned `claim`/`release` (families 8/9) simply sees no such
 * method, and the supervisor degrades to a no-op exactly as it does for a legacy
 * endpoint.
 */
import { Deferred, Effect } from "effect";
import type { AgenticCapability, AgenticEndpoint, AgenticHandle } from "./agentic.ts";
import { SupervisorError } from "./ports.ts";

/**
 * A single multiplexed host connection to the agentic hub, expressed as plain
 * (Effect-free) methods so the monolith can implement it against
 * `@nanobpm/agentic` without importing Effect. Identity is carried EXPLICITLY on
 * every frame — one connection multiplexes N workers — never derived from the
 * connection id (the assumption #154 structurally breaks).
 *
 * Frame methods (`register`/`heartbeat`/`deregister`/`claim`/`release`/
 * `transcript`) MUST throw synchronously if the underlying transport is not open
 * so the adapter can surface the failure as a {@link SupervisorError}; a
 * best-effort caller swallows it and the next resync replays the frame. Lifecycle
 * callbacks are single-shot registrations wired once per connection.
 */
export interface RawEmitClient {
  /** Presence for one worker (register family). */
  register(instance: string, capability: AgenticCapability): void;
  /** Presence keep-alive for one registered worker (heartbeat family). */
  heartbeat(instance: string): void;
  /** Presence removal for one worker (deregister family). */
  deregister(instance: string, reason?: string): void;
  /** Job-ownership open (claim family, code 8). Only called when negotiated. */
  claim(instance: string, jobKey: string): void;
  /** Job-ownership close (release family, code 9). Only called when negotiated. */
  release(instance: string, jobKey: string): void;
  /** Transcript data chunk (relay `produce`, bulk lane), keyed by explicit instance. */
  transcript(instance: string, jobKey: string, chunk: Uint8Array): void;
  /**
   * Install the inbound steer router. The callback is plain and fire-and-forget;
   * the adapter forks the Effect-returning route so an inbound frame never blocks
   * the transport read loop. Only invoked when steer is negotiated.
   */
  onSteer(route: (instance: string, jobKey: string, chunk: Uint8Array) => void): void;
  /** Fires once when the socket opens (drives connect resolution). */
  onOpen(cb: () => void): void;
  /** Fires once when the socket drops (drives {@link AgenticHandle.closed} + reconnect). */
  onClose(cb: () => void): void;
  /** Idempotent teardown of this connection. */
  close(): void;
  /** Whether the negotiated protocol admits `claim`/`release` (the `claim-release` feature). */
  readonly supportsClaimRelease: boolean;
  /** Whether the negotiated protocol admits the inbound steer lane. */
  readonly supportsSteer: boolean;
}

/**
 * Open a fresh {@link RawEmitClient} (one physical socket). Called once per
 * connect attempt — {@link superviseAgentic} calls the endpoint's `connect`
 * again on every reconnect, so this MUST build a new connection each time rather
 * than reuse a torn-down one.
 */
export type RawEmitConnect = () => RawEmitClient;

/**
 * Lift a plain {@link RawEmitConnect} into the Effect {@link AgenticEndpoint} the
 * supervisor injects as `deps.agenticEndpoint`.
 *
 * `connect` resolves the {@link AgenticHandle} only once the socket is OPEN, so
 * the first frame the supervisor emits (the resync) never races a not-yet-open
 * transport. A socket that closes BEFORE it opens fails the connect with a
 * {@link SupervisorError} — which is exactly what {@link superviseAgentic}'s
 * jittered, forever backoff retries. A mid-life drop (close AFTER open) completes
 * {@link AgenticHandle.closed}, driving the reconnect-resync loop.
 */
export const makeAgenticEndpoint = (connect: RawEmitConnect): AgenticEndpoint => ({
  connect: () =>
    Effect.gen(function* () {
      const raw = connect();

      // `closed` completes on a mid-life drop; `opened` unblocks the connect with
      // `true` on the first open, or `false` if the socket closes before opening.
      // Both completions are idempotent (first winner sticks), so the single
      // onOpen/onClose registrations below are safe against either ordering.
      const closed = yield* Deferred.make<void>();
      const opened = yield* Deferred.make<boolean>();

      raw.onOpen(() => {
        Effect.runSync(Deferred.succeed(opened, true));
      });
      raw.onClose(() => {
        Effect.runSync(Deferred.succeed(opened, false));
        Effect.runSync(Deferred.succeed(closed, void 0));
      });

      const didOpen = yield* Deferred.await(opened);
      if (!didOpen) {
        return yield* Effect.fail(new SupervisorError("agentic connection closed before it opened"));
      }

      const wrap = (send: () => void): Effect.Effect<void, SupervisorError> =>
        Effect.try({
          try: send,
          catch: (cause) =>
            new SupervisorError(
              cause instanceof Error ? cause.message : "agentic frame send failed",
              cause,
            ),
        });

      const handle: AgenticHandle = {
        disconnect: Effect.sync(() => raw.close()),
        closed: Deferred.await(closed),
        register: (instance, capability) => wrap(() => raw.register(instance, capability)),
        heartbeat: (instance) => wrap(() => raw.heartbeat(instance)),
        deregister: (instance, reason) => wrap(() => raw.deregister(instance, reason)),
        transcript: (instance, jobKey, chunk) => wrap(() => raw.transcript(instance, jobKey, chunk)),
        // Additive negotiation: omit claim/release/onSteer entirely when the far
        // end can't decode them, so the supervisor degrades to a no-op (never a
        // protocol error) exactly as it does for a pre-#158 endpoint.
        ...(raw.supportsClaimRelease
          ? {
              claim: (instance: string, jobKey: string) => wrap(() => raw.claim(instance, jobKey)),
              release: (instance: string, jobKey: string) => wrap(() => raw.release(instance, jobKey)),
            }
          : {}),
        ...(raw.supportsSteer
          ? {
              onSteer: (route) =>
                wrap(() =>
                  raw.onSteer((instance, jobKey, chunk) => Effect.runFork(route(instance, jobKey, chunk))),
                ),
            }
          : {}),
      };

      return handle;
    }),
});
