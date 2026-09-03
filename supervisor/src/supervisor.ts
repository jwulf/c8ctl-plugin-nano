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
  resyncOwnership,
  type OwnershipContext,
  type OwnershipRegistry,
} from "./ownership.ts";
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
  /** Optional process-id scope narrowing reconcile to one app/network. */
  readonly scope: string;
}

export const defaultSupervisorConfig: SupervisorConfig = {
  activation: defaultActivationConfig,
  dispatch: defaultDispatchConfig,
  reconcileIntervalMs: 30_000,
  idleSpacingMs: 1_000,
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
  /** When set, the whole runtime executes inside this agentic connection's scope. */
  readonly agenticEndpoint?: AgenticEndpoint;
  readonly agenticConfig?: AgenticConfig;
  readonly config?: Partial<SupervisorConfig>;
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
}

export const makeSupervisor = (deps: SupervisorDeps): Effect.Effect<Supervisor> =>
  Effect.gen(function* () {
    const logger = deps.logger ?? noopLogger;
    const cfg: SupervisorConfig = {
      ...defaultSupervisorConfig,
      ...deps.config,
      activation: { ...defaultActivationConfig, ...deps.config?.activation },
      dispatch: { ...defaultDispatchConfig, ...deps.config?.dispatch },
    };
    const parking = yield* makeParkingLot();
    const cacheRef = yield* Ref.make<ReconcileCache>(emptyCache);

    // Ownership plane (issue #158). The registry is the source of truth; the
    // context mirrors mutations onto whichever agentic handle is live now, read
    // from a stable slot that `superviseAgentic` swaps on reconnect.
    const ownership = yield* makeOwnershipRegistry();
    const handleRef = yield* Ref.make<AgenticHandle | null>(null);
    const ownershipContext: OwnershipContext = makeOwnershipContext(
      ownership,
      { currentHandle: Ref.get(handleRef) },
      logger,
    );

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
              ? deps.registry.setTypes(deps.autoWorkerId, res.cache.jobTypes)
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
        return parking.takeFor(typeSet).pipe(
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
      }),
    );

    const run: Effect.Effect<never> = Effect.gen(function* () {
      yield* Effect.forkChild(doReconcile.pipe(Effect.repeat(Schedule.spaced(Duration.millis(cfg.reconcileIntervalMs)))));
      return yield* tick.pipe(Effect.forever);
    });

    const runWithAgentic: Effect.Effect<never> = deps.agenticEndpoint
      ? (superviseAgentic(
          deps.agenticEndpoint,
          logger,
          handleRef,
          // On every (re)connect, replay the full active-claim set before
          // resuming transcript — re-register each worker and re-claim its jobs.
          (handle) => resyncOwnership(handle, ownership, logger),
          run,
          deps.agenticConfig,
        ) as Effect.Effect<never>)
      : run;

    return { tick, reconcileOnce: doReconcile, run: runWithAgentic, parking, ownership };
  });

// Re-export the surface a JS consumer (c8ctl-plugin.js) needs.
export { Clock, Duration, Effect, Fiber, Ref, Schedule };
