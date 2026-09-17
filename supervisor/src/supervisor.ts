/**
 * The single-owner supervisor runtime — composes the registry, reconcile cache,
 * capacity-gated activation, dispatch/lock lifecycle, parking lot, and agentic
 * connection into one Effect program driven by `Schedule` cadences.
 *
 * This is the architectural fix for the duplicated-polling storm: **one process,
 * one event loop** owns polling, per-type capacity accounting, and dispatch, so
 * slot accounting is race-free (unlike K separate `--name` processes each with
 * their own process-wide `singleFlight`).
 *
 * Two concurrent loops run under (optionally) one agentic-connection scope:
 *  - **reconcile** — once per host on a 30s `Schedule.spaced`, rewriting the
 *    `--auto` worker's serviceable types from the cheap cached crawl;
 *  - **activation/dispatch** — compute the serviceable-with-capacity poll set,
 *    promote a parked job if one fits, otherwise race one long-poll per type,
 *    claim a slot for the winner, and fork its dispatch so the loop keeps filling
 *    other free slots while the agent runs.
 */
import { Clock, Duration, Effect, Fiber, Ref, Schedule } from "effect";
import { activateWinner, defaultActivationConfig, type ActivationConfig } from "./activation.ts";
import { defaultDispatchConfig, dispatch, type DispatchConfig } from "./dispatch.ts";
import { makeParkingLot, type ParkingLot } from "./parking.ts";
import { emptyCache, reconcile, type ReconcileCache } from "./reconcile.ts";
import {
  superviseAgentic,
  type AgenticConfig,
  type AgenticEndpoint,
  type AgenticHandle,
} from "./agentic.ts";
import {
  makeOwnershipContext,
  makeOwnershipRegistry,
  type OwnershipContext,
  type OwnershipRegistry,
} from "./ownership.ts";
import {
  defaultPresenceConfig,
  installSteerRoute,
  makePresenceSink,
  makeSteerRouter,
  projectPresence,
  resyncPresenceOnEstablish,
  type PresenceConfig,
  type PresenceSink,
  type SteerRouter,
} from "./presence.ts";
import type {
  EngineClient,
  JobRunner,
  Logger,
  ReconcileReader,
  ScanAgentLeaves,
  ActivatedJob,
} from "./ports.ts";
import { noopLogger } from "./ports.ts";
import type { Registry } from "./registry.ts";

export interface SupervisorConfig {
  readonly activation: ActivationConfig;
  readonly dispatch: DispatchConfig;
  /** Reconcile cadence (ms). Once per host — 30s by default. */
  readonly reconcileIntervalMs: number;
  /** How long to idle when no serviceable type has a free slot (ms). */
  readonly idleSpacingMs: number;
  /** Presence-projection cadence (register/heartbeat/deregister over the multiplexed connection). */
  readonly presence: PresenceConfig;
  /** Optional process-id scope narrowing reconcile to one app/network. */
  readonly scope: string;
}

export const defaultSupervisorConfig: SupervisorConfig = {
  activation: defaultActivationConfig,
  dispatch: defaultDispatchConfig,
  reconcileIntervalMs: 30_000,
  idleSpacingMs: 1_000,
  presence: defaultPresenceConfig,
  scope: "",
};

export interface SupervisorDeps {
  readonly engine: EngineClient;
  readonly runner: JobRunner;
  readonly registry: Registry;
  readonly reconcileReader: ReconcileReader;
  readonly scan: ScanAgentLeaves;
  readonly logger?: Logger;
  /** When set, this worker's serviceable types are rewritten from each reconcile. */
  readonly autoWorkerId?: string;
  /**
   * Explicit `--job-type` extras that must ALWAYS be served in addition to the
   * engine-read auto set. Unioned into every reconcile's `setTypes` write so they
   * survive the reconcile that replaces the worker's set with the scan result
   * (otherwise an explicit subscription silently stops being served after the
   * first successful reconcile).
   */
  readonly autoExtraTypes?: ReadonlyArray<string>;
  /** When set, the whole runtime executes inside this agentic connection's scope. */
  readonly agenticEndpoint?: AgenticEndpoint;
  readonly agenticConfig?: AgenticConfig;
  readonly config?: Partial<SupervisorConfig>;
  /**
   * Fired ONCE, on the runtime fiber, the instant the activation loop is about to
   * begin leasing — after reconcile/presence are forked. Readiness is gated on
   * LEASING, NOT on the agentic connection: under agentic, `superviseAgentic`
   * forks the connect→establish cycle as a CHILD fiber and runs this loop
   * concurrently, so the agentic handle may still be connecting when this fires
   * (see the run-site comment). That is deliberate — the leasing loop does not
   * depend on the connection, so a rolling reload needs only "the replacement is
   * leasing". The plugin uses this as its readiness handshake for
   * rolling reload (#253): a bare `Effect.runFork(run)` only *schedules* this
   * fiber and may return before it has executed at all, so stamping readiness in
   * the JS caller's continuation can report a replacement ready before it is
   * serving. Firing from here runs on the fiber itself, so it cannot. It fires
   * BEFORE the first `tick` because the first activation poll can block for the
   * whole long-poll window. Best-effort — never fails the loop.
   */
  readonly onFirstActivation?: Effect.Effect<void>;
}

export interface Supervisor {
  /** One activation/dispatch iteration — exposed for deterministic testing. */
  readonly tick: Effect.Effect<void>;
  /** One reconcile pass — exposed for deterministic testing. */
  readonly reconcileOnce: Effect.Effect<void>;
  /** Run both loops until interrupted. */
  readonly run: Effect.Effect<never>;
  readonly parking: ParkingLot;
  /**
   * The claim registry (issue #158) — the race-free `instance → jobKeys` source
   * of truth that drives the cockpit's `jobKeys` (replacing the fragile
   * relay-transcript correlation). Exposed so the plugin can seed worker presence
   * (`register`) and tests can assert live ownership.
   */
  readonly ownership: OwnershipRegistry;
  /**
   * The inbound steer router (issue #163). Cockpit → agent bytes ride the one
   * multiplexed connection; the plugin registers a per-instance {@link SteerSink}
   * around each dispatched job so N agents' steer streams never cross.
   */
  readonly steerRouter: SteerRouter;
  /**
   * Outbound transcript sink (issue #173). The plugin streams a running agent's
   * terminal bytes over the SAME multiplexed connection, keyed by explicit
   * `instance`/`jobKey` (never a per-process socket). Best-effort: a frame emitted
   * between a drop and the next reconnect is a harmless no-op, and an endpoint that
   * predates the transcript lane degrades to a no-op.
   */
  transcript(instance: string, jobKey: string, chunk: Uint8Array): Effect.Effect<void>;
  /**
   * The presence sink (issue #173). Exposed so the plugin can emit an explicit
   * `deregister` on graceful worker shutdown (the projection otherwise only drops
   * an identity on the next cadence tick after it leaves the registry). Wire-only
   * and best-effort — the registry, seeded via {@link ownership}, stays the source
   * of truth the projection heartbeats.
   */
  readonly presence: PresenceSink;
}

export const makeSupervisor = (deps: SupervisorDeps): Effect.Effect<Supervisor> =>
  Effect.gen(function* () {
    const logger = deps.logger ?? noopLogger;
    const cfg: SupervisorConfig = {
      ...defaultSupervisorConfig,
      ...deps.config,
      activation: { ...defaultActivationConfig, ...deps.config?.activation },
      dispatch: { ...defaultDispatchConfig, ...deps.config?.dispatch },
      presence: { ...defaultPresenceConfig, ...deps.config?.presence },
    };
    const parking = yield* makeParkingLot();
    const cacheRef = yield* Ref.make<ReconcileCache>(emptyCache);

    // Ownership plane (issue #158). The registry is the source of truth; the
    // context mirrors mutations onto whichever agentic handle is live now, read
    // from a stable slot that `superviseAgentic` swaps on reconnect.
    const ownership = yield* makeOwnershipRegistry();
    const handleRef = yield* Ref.make<AgenticHandle | null>(null);
    const supervised = { currentHandle: Ref.get(handleRef) };
    const ownershipContext: OwnershipContext = makeOwnershipContext(ownership, supervised, logger);

    // Presence plane (issue #163). One multiplexed connection carries every
    // supervised agent: the presence-projection fiber derives register/heartbeat/
    // deregister from the registry, and the steer router fans inbound bytes back
    // to the right agent — all keyed by explicit instance over the single socket.
    const presenceSink = makePresenceSink(supervised, logger);
    // The announced-instance set for the presence projection. Owned here (not
    // inside `projectPresence`) so `resyncPresenceOnEstablish` can reset it on
    // every (re)connect, re-`register`ing all owned instances over the fresh
    // handle — closing the connect-after-first-tick race (#192) where the initial
    // register was emitted into a still-null `currentHandle` and silently lost.
    const presenceKnownRef = yield* Ref.make<ReadonlySet<string>>(new Set());
    const steerRouter = yield* makeSteerRouter(logger);

    // Readiness handshake latch (#253). The rolling reload waits for a fresh
    // replacement to stamp `readyAt` before draining the next worker, so readiness
    // must mean "this worker can actually lease" — NOT merely "the loop fiber is
    // scheduled". It fires exactly once, the first time the activation loop has a
    // non-empty poll set (a serviceable-with-capacity type it is about to lease),
    // guarded by this one-shot latch. See `fireReadinessOnce`.
    const readinessFiredRef = yield* Ref.make(false);
    // Fire the readiness handshake at most once. Best-effort: a failure — or a
    // DEFECT thrown by the injected thunk (e.g. the plugin's `writeActivity()`
    // hitting an fs error) — must only delay readiness, never terminate the
    // activation loop, so both are swallowed. `getAndSet` is the atomic one-shot
    // gate: the first caller sees `false` and fires; every later caller sees `true`
    // and no-ops.
    const fireReadinessOnce: Effect.Effect<void> = deps.onFirstActivation
      ? Ref.getAndSet(readinessFiredRef, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : deps.onFirstActivation!.pipe(
                  Effect.catchDefect((defect) =>
                    Effect.sync(() =>
                      logger.warn(`readiness handshake failed (ignored) — ${String(defect)}`),
                    ),
                  ),
                  Effect.ignore,
                ),
          ),
        )
      : Effect.void;

    const dispatchDeps = {
      engine: deps.engine,
      runner: deps.runner,
      registry: deps.registry,
      logger,
      config: cfg.dispatch,
      ownership: ownershipContext,
    };

    // Reconcile against the *current* cache each pass and publish job types.
    const doReconcile = Ref.get(cacheRef).pipe(
      Effect.flatMap((prev) => reconcile(deps.reconcileReader, deps.scan, prev, cfg.scope)),
      Effect.flatMap((res) =>
        Ref.set(cacheRef, res.cache).pipe(
          Effect.flatMap(() =>
            deps.autoWorkerId
              ? deps.registry.setTypes(
                  deps.autoWorkerId,
                  deps.autoExtraTypes && deps.autoExtraTypes.length > 0
                    ? Array.from(new Set([...res.cache.jobTypes, ...deps.autoExtraTypes]))
                    : res.cache.jobTypes,
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.catch((err) =>
        Effect.sync(() =>
          logger.warn(`reconcile skipped — ${err.message} (keeping current job-type set)`),
        ),
      ),
    );

    const tick: Effect.Effect<void> = deps.registry.pollBatch.pipe(
      Effect.flatMap((targets) => {
        if (targets.length === 0) {
          // Zero serviceable-with-capacity types → nothing to lease this tick, so
          // do NOT stamp readiness (#253). An --auto worker whose initial engine
          // read failed starts with zero types and fills them in on a later
          // reconcile; stamping readiness here would let the rolling reload drain
          // the next worker while this replacement has no pollers and cannot lease
          // anything — defeating the one-at-a-time guarantee. It becomes ready on
          // the first tick that actually has a poll set (below).
          return Effect.sleep(Duration.millis(cfg.idleSpacingMs));
        }
        const typeSet = new Set(targets.map((t) => t.type));
        // Claim a worker per returned job and fork its dispatch; a job whose slot
        // was raced away goes to the parking lot (promote-on-slot-free), never failed.
        const dispatchBatch = (jobs: ReadonlyArray<ActivatedJob>): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (const j of jobs) {
              const worker = yield* deps.registry.claim(j.type);
              if (worker) {
                yield* Effect.forkChild(dispatch(dispatchDeps, j, worker));
              } else {
                yield* parking.park(j, cfg.activation.initialLockMs);
              }
            }
          });
        const activate: Effect.Effect<void> = parking.takeFor(typeSet).pipe(
          Effect.flatMap((parked) => {
            if (parked) {
              return deps.registry.claim(parked.job.type).pipe(
                Effect.flatMap((worker) =>
                  worker
                    ? Effect.forkChild(dispatch(dispatchDeps, parked.job, worker)).pipe(Effect.asVoid)
                    : parking.repark(parked),
                ),
              );
            }
            return activateWinner(deps.engine, targets, cfg.activation).pipe(
              Effect.flatMap((winners) => dispatchBatch(winners)),
              Effect.catch((err) =>
                Effect.sync(() => logger.warn(`activation error — ${err.message}`)),
              ),
            );
          }),
        );
        // Readiness is LEASING-gated (#253): the first tick with a non-empty poll
        // set is the moment this worker is genuinely serving, so fire the one-shot
        // handshake here (before the promote/poll), NOT unconditionally at loop
        // entry. Best-effort and one-shot — see `fireReadinessOnce`.
        return Effect.flatMap(fireReadinessOnce, () => activate);
      }),
    );

    const run: Effect.Effect<never> = Effect.gen(function* () {
      yield* Effect.forkChild(doReconcile.pipe(Effect.repeat(Schedule.spaced(Duration.millis(cfg.reconcileIntervalMs)))));
      // Presence projection (issue #163): heartbeat every registered instance over
      // the one multiplexed connection on a Schedule cadence, announcing/dropping
      // identities as workers join/leave the registry. Only meaningful with a live
      // connection, so it is forked alongside the loops inside the agentic scope.
      if (deps.agenticEndpoint) {
        yield* Effect.forkChild(projectPresence(ownership, presenceSink, presenceKnownRef, cfg.presence));
      }
      // The activation loop is about to run ON this fiber — imports and the SDK
      // client were built before `runFork`, and reconcile/presence are forked.
      //
      // Readiness is stamped by `tick` on the first NON-EMPTY poll set, NOT here
      // at loop entry (#253 review). The rolling reload waits for a replacement to
      // report ready before draining the next worker, so readiness must mean "this
      // worker can actually lease" — a serviceable-with-capacity type. An --auto
      // worker whose initial engine read failed enters the loop with ZERO types;
      // stamping readiness unconditionally here would let the reload drain the next
      // worker while this replacement has no activation pollers and cannot lease
      // anything, breaking the one-at-a-time guarantee. Gating on the first
      // non-empty tick fixes that: the worker becomes ready the moment reconcile
      // fills its types and it begins leasing; if types never arrive it never
      // stamps ready and the daemon's bounded ready-timeout advances the roll.
      //
      // Readiness is also deliberately gated on LEASING, NOT on the agentic
      // connection. Under agentic, `superviseAgentic` forks the connect→establish
      // cycle as a CHILD fiber and runs this `run` concurrently, so the agentic
      // handle may still be connecting when the first tick leases. That is correct:
      // the activation/leasing loop does not depend on the agentic connection
      // (presence/steer resync themselves once the handle opens, and a job leased
      // before the connection is up degrades gracefully), so a rolling reload's
      // one-at-a-time guarantee needs only "the replacement is leasing", not "the
      // replacement's agentic socket is up". Gating readiness on `onEstablished`
      // would instead let a slow/failing connect stall the roll (only the bounded
      // ready-timeout would rescue it) for a dependency leasing does not have — so
      // we intentionally do NOT do that (#253 review).
      return yield* tick.pipe(Effect.forever);
    });

    const runWithAgentic: Effect.Effect<never> = deps.agenticEndpoint
      ? (superviseAgentic(
          deps.agenticEndpoint,
          logger,
          handleRef,
          // On establish, install the inbound steer router AND re-assert presence.
          //
          // The AgenticEmitClient owns reconnect + wire-level replay (#186): on a
          // transient socket flap it re-emits presence and re-claims every active
          // job from its write-through shadow, WITHOUT surfacing here — so this
          // hook fires once per live handle, not per physical reconnect, and the
          // steer router (installed once) persists across the client's internal
          // reconnects via the shared route holder.
          //
          // But the shadow only replays what was actually written to it, and the
          // projection's initial `register` is a silent no-op (never reaching the
          // shadow) if it ticks before `currentHandle` is set on the first open
          // (#192). So re-assert presence here — reset the announced set and
          // project one step over the now-live handle — guaranteeing every owned
          // instance is `register`ed once the socket is up. `register` is an
          // idempotent presence-store upsert, so this is safe on every establish.
          (handle) =>
            installSteerRoute(handle, steerRouter, logger).pipe(
              Effect.flatMap(() =>
                resyncPresenceOnEstablish(ownership, presenceSink, presenceKnownRef),
              ),
            ),
          run,
          deps.agenticConfig,
        ) as Effect.Effect<never>)
      : run;

    return { tick, reconcileOnce: doReconcile, run: runWithAgentic, parking, ownership, steerRouter, transcript: ownershipContext.transcript, presence: presenceSink };
  });

// Re-export the surface a JS consumer (c8ctl-plugin.js) needs.
export { Clock, Duration, Effect, Fiber, Ref, Schedule };
