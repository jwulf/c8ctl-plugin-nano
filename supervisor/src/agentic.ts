/**
 * Agentic connection management, folded into the same Effect resource graph.
 *
 * The connections the supervisor manages to the agentic visibility hub used to be
 * handled ad-hoc (bespoke reconnect/teardown handlers, the churn tracked in #138).
 * Here they become a first-class **scoped resource**: `acquireRelease` ties the
 * connection's teardown to a `Scope`, so connect / reconnect / teardown share one
 * supervised lifecycle and the finalizer runs on **success, failure, AND
 * interruption** — when the supervisor fiber is interrupted (SIGTERM), the
 * agentic connection is torn down deterministically instead of leaking.
 */
import { Duration, Effect, Fiber, Ref, Schedule } from "effect";
import type { Logger, SupervisorError } from "./ports.ts";

/**
 * An **enrolment** capability — the presence attributes a worker announces on
 * `register` (cognition/weight/family/host…). Deliberately opaque/extensible:
 * these are ENROLMENT attributes, never routing tokens. Job ownership is carried
 * by the explicit {@link OwnershipFrames.claim}/`release` frames, NOT smuggled in
 * here (that snapshot-in-register approach is exactly what goes stale — see #158).
 */
export interface AgenticCapability {
  readonly cognition?: string;
  readonly weight?: number;
  readonly family?: string;
  readonly host?: string;
  readonly [k: string]: unknown;
}

/**
 * The explicit, instance-tagged job-ownership protocol (issue #158). Every frame
 * carries its `instance` **explicitly** — one host connection multiplexes N
 * workers, so identity can no longer be derived from the connection id (the
 * `instanceForConnection` / relay-open correlation that #154 structurally breaks).
 *
 * All frames are **idempotent**: a duplicate `claim`/`release` is a no-op, so the
 * reconnect-resync (`register` + re-`claim` every active job) is safe to replay.
 *
 * Frames are **additive / version-negotiated**: an older endpoint that predates
 * #158 simply does not implement them, so each is optional on {@link AgenticHandle}
 * and the caller degrades gracefully (see `emitFrame` in `ownership.ts`).
 */
export interface OwnershipFrames {
  /** Presence for one worker the supervisor owns (multiple instances per connection). */
  register(instance: string, capability: AgenticCapability): Effect.Effect<void, SupervisorError>;
  /** Emitted at dispatch, held for the agent child's whole life. Drives cockpit `jobKeys`. */
  claim(instance: string, jobKey: string): Effect.Effect<void, SupervisorError>;
  /** Data plane — carries explicit identity (no `conn.id` derivation). Drill-in only. */
  transcript(instance: string, jobKey: string, chunk: Uint8Array): Effect.Effect<void, SupervisorError>;
  /** Emitted on agent-child exit (success/fail/lapse). A late/duplicate release is a no-op. */
  release(instance: string, jobKey: string): Effect.Effect<void, SupervisorError>;
}

export interface AgenticHandle extends Partial<OwnershipFrames> {
  /** Idempotent teardown of this connection. Runs as the scope finalizer. */
  readonly disconnect: Effect.Effect<void>;
  /**
   * Completes when the underlying transport drops mid-life (not a graceful
   * teardown). Drives {@link superviseAgentic}'s reconnect-resync loop. When
   * absent, the connection is treated as never dropping on its own (the initial
   * `connect` retry in {@link acquireAgentic} is the only recovery).
   */
  readonly closed?: Effect.Effect<void>;
}

export interface AgenticEndpoint {
  /** Open a connection to the agentic hub. */
  connect(): Effect.Effect<AgenticHandle, SupervisorError>;
}

export interface AgenticConfig {
  /** Backoff schedule base for reconnect attempts (ms). */
  readonly reconnectBaseMs: number;
  /** Cap on reconnect backoff (ms). */
  readonly reconnectMaxMs: number;
}

export const defaultAgenticConfig: AgenticConfig = {
  reconnectBaseMs: 500,
  reconnectMaxMs: 30_000,
};

/**
 * Jittered exponential reconnect backoff, retried **forever** with each attempt's
 * *delay* capped at `reconnectMaxMs`.
 *
 * `reconnectMaxMs` is a cap on the backoff **delay**, not on total retry time, so
 * we clamp the per-step delay with `Schedule.modifyDelay` and never bound the
 * schedule's recurrence count/duration. Using `Schedule.upTo({ duration })` here
 * would instead limit *total elapsed retry time*, making `Effect.retry` give up
 * after ~`reconnectMaxMs` of downtime — silently breaking the reconnect-forever
 * intent of both the initial connect and mid-life reconnect supervision.
 */
const reconnectSchedule = (config: AgenticConfig) =>
  Schedule.exponential(Duration.millis(config.reconnectBaseMs)).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(config.reconnectMaxMs))),
    ),
  );

/**
 * Acquire the agentic connection as a scoped resource. The returned Effect
 * requires a `Scope`; when that scope closes (normally or via interruption) the
 * connection's `disconnect` finalizer runs exactly once. Connect failures are
 * retried forever with jittered exponential backoff whose delay is capped at
 * `reconnectMaxMs`.
 */
export const acquireAgentic = (
  endpoint: AgenticEndpoint,
  logger: Logger,
  config: AgenticConfig = defaultAgenticConfig,
): Effect.Effect<AgenticHandle, SupervisorError, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    endpoint.connect().pipe(
      Effect.tap(() => Effect.sync(() => logger.debug?.("agentic: connected"))),
      Effect.retry(reconnectSchedule(config)),
    ),
    (handle) =>
      handle.disconnect.pipe(
        Effect.tap(() => Effect.sync(() => logger.debug?.("agentic: disconnected"))),
        Effect.ignore,
      ),
  );

/**
 * Run `use` with a live agentic connection whose lifecycle is bounded by the
 * `use` effect: the connection is torn down when `use` finishes, fails, or is
 * interrupted.
 */
export const withAgenticConnection = <A, E, R>(
  endpoint: AgenticEndpoint,
  logger: Logger,
  use: (handle: AgenticHandle) => Effect.Effect<A, E, R>,
  config: AgenticConfig = defaultAgenticConfig,
): Effect.Effect<A, E | SupervisorError, R> =>
  Effect.scoped(acquireAgentic(endpoint, logger, config).pipe(Effect.flatMap(use)));

/**
 * A live agentic connection whose physical socket may reconnect **underneath** a
 * long-running `use`, without restarting it.
 *
 * #157's `acquireRelease` only retries the *initial* `connect`; once established
 * there is no mid-life reconnect supervision and — critically — **no replay**, so
 * a channel blip after the first job strands every claim (the "live but
 * unobserved after a blip" failure #158 must not carry forward). This closes that
 * gap:
 *
 *  - A stable {@link SupervisedAgentic.currentHandle} `Ref` exposes the *current*
 *    transport; the ownership frame emitters read it each time, so a reconnect
 *    swaps the socket transparently while the supervisor loop and the claim
 *    registry stay put.
 *  - On every (re)connect, `onEstablished` runs **before** anything resumes — this
 *    is the resync hook: re-`register` all workers and re-`claim` all active jobs
 *    (see `resyncOwnership`) so the cockpit never blanks a still-running job.
 *  - The connect→resync→await-`closed`→teardown cycle repeats forever; it races
 *    against `use`, so when `use` finishes (or fails/interrupts) the supervision
 *    fiber is interrupted and the live socket torn down deterministically.
 */
export interface SupervisedAgentic {
  /** The current transport, or `null` between a drop and the next reconnect. */
  readonly currentHandle: Effect.Effect<AgenticHandle | null>;
}

export const superviseAgentic = <A, E, R>(
  endpoint: AgenticEndpoint,
  logger: Logger,
  handleRef: Ref.Ref<AgenticHandle | null>,
  onEstablished: (handle: AgenticHandle) => Effect.Effect<void>,
  use: Effect.Effect<A, E, R>,
  config: AgenticConfig = defaultAgenticConfig,
): Effect.Effect<A, E | SupervisorError, R> =>
  Effect.gen(function* () {
    // One connect → publish → resync → hold-until-dropped → teardown cycle.
    const cycle = Effect.acquireUseRelease(
      endpoint.connect().pipe(Effect.retry(reconnectSchedule(config))),
      (handle) =>
        Ref.set(handleRef, handle).pipe(
          Effect.tap(() => Effect.sync(() => logger.debug?.("agentic: (re)connected — resyncing"))),
          // Resync BEFORE resuming transcript: re-register + re-claim active jobs.
          Effect.flatMap(() => onEstablished(handle)),
          // Stay live until the transport signals a mid-life drop (or forever).
          Effect.flatMap(() => handle.closed ?? Effect.never),
        ),
      (handle) =>
        Ref.set(handleRef, null).pipe(Effect.flatMap(() => handle.disconnect.pipe(Effect.ignore))),
    );

    // Run the reconnect-forever supervision as a child fiber, and interrupt it
    // (awaiting its teardown finalizer) the moment `use` finishes/fails/interrupts.
    // This gives deterministic teardown without depending on race combinators to
    // interrupt a loser whose completion is itself triggered by the winner.
    const supervision = yield* Effect.forkChild(cycle.pipe(Effect.forever));
    return yield* use.pipe(Effect.ensuring(Fiber.interrupt(supervision)));
  });
