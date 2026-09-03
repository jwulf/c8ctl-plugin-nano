/**
 * Presence projection + steer lane (issue #163).
 *
 * The supervisor owns **one** multiplexed agentic (NWF cockpit) connection for
 * **every** agent it supervises. Where #158 made *job ownership*
 * (`claim`/`release`) explicit and instance-tagged, this module makes *presence*
 * — `register` / `heartbeat` / `deregister` — a first-class projection of the
 * registry over that single connection, replacing the old per-worker fan-out
 * where every `nano work` process opened its own socket and announced a single
 * identity.
 *
 * Design mirrors activation/dispatch: everything derives from the registry (the
 * single source of truth) and is emitted **best-effort** onto whatever handle is
 * live now (the swappable `currentHandle` that `superviseAgentic` reconnects
 * underneath), so a transport blip never corrupts presence — the next cadence
 * tick (and the reconnect resync) re-asserts it.
 */
import { Duration, Effect, Ref, Schedule } from "effect";
import type { AgenticCapability, AgenticHandle, SteerRoute, SupervisedAgentic } from "./agentic.ts";
import { emitFrame, type OwnedWorker, type OwnershipRegistry } from "./ownership.ts";
import type { Logger, SupervisorError } from "./ports.ts";
import { noopLogger } from "./ports.ts";

export interface PresenceConfig {
  /** How often the presence-projection fiber heartbeats every registered instance (ms). */
  readonly heartbeatIntervalMs: number;
}

export const defaultPresenceConfig: PresenceConfig = {
  heartbeatIntervalMs: 10_000,
};

// ---- Wire-only presence emitters (best-effort, additive) -----------------------------

/**
 * The presence frames the projection fiber emits, each mirrored onto the live
 * handle only (no registry mutation — the registry is upstream of this). Every
 * emit is best-effort: a missing frame (legacy endpoint) or a dropped socket is a
 * no-op, so presence projection never crashes the supervisor.
 */
export interface PresenceSink {
  register(instance: string, capability: AgenticCapability): Effect.Effect<void>;
  heartbeat(instance: string): Effect.Effect<void>;
  deregister(instance: string, reason?: string): Effect.Effect<void>;
}

export const makePresenceSink = (
  supervised: SupervisedAgentic,
  logger: Logger = noopLogger,
): PresenceSink => {
  const onHandle = (
    f: (h: AgenticHandle) => Effect.Effect<void, SupervisorError> | undefined,
    name: string,
  ): Effect.Effect<void> =>
    supervised.currentHandle.pipe(
      Effect.flatMap((h) => (h ? emitFrame(f(h), logger, name) : Effect.void)),
    );
  return {
    register: (instance, capability) => onHandle((h) => h.register?.(instance, capability), "register"),
    heartbeat: (instance) => onHandle((h) => h.heartbeat?.(instance), "heartbeat"),
    deregister: (instance, reason) => onHandle((h) => h.deregister?.(instance, reason), "deregister"),
  };
};

// ---- Pure presence diff --------------------------------------------------------------

export interface PresenceDiff {
  /** Registered since the last projection — announce with `register`. */
  readonly appeared: ReadonlyArray<OwnedWorker>;
  /** Still registered — keep alive with `heartbeat`. */
  readonly present: ReadonlyArray<OwnedWorker>;
  /** Gone from the registry since the last projection — drop with `deregister`. */
  readonly departed: ReadonlyArray<string>;
}

/**
 * Diff the set of instances we last projected against the current registry
 * snapshot. Newly-registered instances `appeared`, still-registered ones are
 * `present`, and instances that left the registry `departed`.
 */
export function diffPresence(
  known: ReadonlySet<string>,
  snapshot: ReadonlyArray<OwnedWorker>,
): PresenceDiff {
  const appeared: OwnedWorker[] = [];
  const present: OwnedWorker[] = [];
  const current = new Set<string>();
  for (const w of snapshot) {
    current.add(w.instance);
    (known.has(w.instance) ? present : appeared).push(w);
  }
  const departed: string[] = [];
  for (const instance of known) {
    if (!current.has(instance)) departed.push(instance);
  }
  return { appeared, present, departed };
}

// ---- Projection loop -----------------------------------------------------------------

/**
 * One projection tick: `register` every newly-appeared instance, `heartbeat`
 * every still-present one, `deregister` every departed one, then remember the
 * current instance set for the next diff. `register` precedes `heartbeat` so a
 * fresh instance is announced before it is kept alive.
 */
export const projectPresenceStep = (
  ownership: OwnershipRegistry,
  sink: PresenceSink,
  knownRef: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<void> =>
  ownership.snapshot.pipe(
    Effect.flatMap((snapshot) =>
      Ref.get(knownRef).pipe(
        Effect.flatMap((known) => {
          const { appeared, present, departed } = diffPresence(known, snapshot);
          return Effect.forEach(appeared, (w) => sink.register(w.instance, w.capability), { discard: true })
            .pipe(
              Effect.flatMap(() => Effect.forEach(present, (w) => sink.heartbeat(w.instance), { discard: true })),
              Effect.flatMap(() => Effect.forEach(departed, (i) => sink.deregister(i), { discard: true })),
              Effect.flatMap(() => Ref.set(knownRef, new Set(snapshot.map((w) => w.instance)))),
            );
        }),
      ),
    ),
  );

/**
 * The presence-projection fiber: derive `register`/`heartbeat`/`deregister` from
 * the registry on a `Schedule.spaced` cadence, forever. Runs inside the agentic
 * connection scope so it is interrupted on teardown; emits are best-effort so
 * ticks between a drop and the next reconnect are harmless no-ops (the reconnect
 * resync re-registers + re-claims immediately, and the next tick resumes
 * heartbeats on the fresh handle).
 */
export const projectPresence = (
  ownership: OwnershipRegistry,
  sink: PresenceSink,
  config: PresenceConfig = defaultPresenceConfig,
): Effect.Effect<never> =>
  Ref.make<ReadonlySet<string>>(new Set()).pipe(
    Effect.flatMap((knownRef) =>
      projectPresenceStep(ownership, sink, knownRef).pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(config.heartbeatIntervalMs))),
      ),
    ),
  ) as Effect.Effect<never>;

// ---- Inbound steer lane (keyed by instance) ------------------------------------------

/** A per-instance inbound steer sink — the agent child's steer-in for one job. */
export type SteerSink = (jobKey: string, chunk: Uint8Array) => Effect.Effect<void>;

/**
 * Routes inbound steer frames off the one multiplexed connection to the correct
 * agent, keyed by explicit `instance` (never the connection id) so N agents'
 * steer streams never cross. Sinks are registered/unregistered around each job's
 * lifetime; a frame for an unknown instance is dropped (logged), not misrouted.
 */
export interface SteerRouter {
  /** The `SteerRoute` installed on every (re)connected handle via `onSteer`. */
  readonly route: SteerRoute;
  register(instance: string, sink: SteerSink): Effect.Effect<void>;
  unregister(instance: string): Effect.Effect<void>;
}

export const makeSteerRouter = (logger: Logger = noopLogger): Effect.Effect<SteerRouter> =>
  Ref.make(new Map<string, SteerSink>()).pipe(
    Effect.map((ref) => ({
      route: (instance: string, jobKey: string, chunk: Uint8Array) =>
        Ref.get(ref).pipe(
          Effect.flatMap((sinks) => {
            const sink = sinks.get(instance);
            return sink
              ? sink(jobKey, chunk)
              : Effect.sync(() =>
                  logger.debug?.(`steer: no sink for instance ${instance} — dropped ${chunk.length}B`),
                );
          }),
        ),
      register: (instance: string, sink: SteerSink) =>
        Ref.update(ref, (m) => new Map(m).set(instance, sink)),
      unregister: (instance: string) =>
        Ref.update(ref, (m) => {
          const next = new Map(m);
          next.delete(instance);
          return next;
        }),
    })),
  );

/**
 * Install the steer router onto a freshly (re)connected handle. Best-effort and
 * additive: endpoints without an `onSteer` subscription degrade to no steering.
 * Composed into `superviseAgentic`'s `onEstablished` hook so every reconnect
 * re-installs the router alongside the ownership resync.
 */
export const installSteerRoute = (
  handle: AgenticHandle,
  router: SteerRouter,
  logger: Logger = noopLogger,
): Effect.Effect<void> => emitFrame(handle.onSteer?.(router.route), logger, "onSteer");
