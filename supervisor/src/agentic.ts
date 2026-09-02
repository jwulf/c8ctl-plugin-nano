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
import { Duration, Effect, Schedule } from "effect";
import type { Logger, SupervisorError } from "./ports.ts";

export interface AgenticHandle {
  /** Idempotent teardown of this connection. Runs as the scope finalizer. */
  readonly disconnect: Effect.Effect<void>;
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
 * Acquire the agentic connection as a scoped resource. The returned Effect
 * requires a `Scope`; when that scope closes (normally or via interruption) the
 * connection's `disconnect` finalizer runs exactly once. Connect failures are
 * retried with jittered, capped exponential backoff.
 */
export const acquireAgentic = (
  endpoint: AgenticEndpoint,
  logger: Logger,
  config: AgenticConfig = defaultAgenticConfig,
): Effect.Effect<AgenticHandle, SupervisorError, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    endpoint.connect().pipe(
      Effect.tap(() => Effect.sync(() => logger.debug?.("agentic: connected"))),
      Effect.retry(
        Schedule.exponential(Duration.millis(config.reconnectBaseMs)).pipe(
          Schedule.jittered,
          Schedule.upTo({ duration: Duration.millis(config.reconnectMaxMs) }),
        ),
      ),
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
