/**
 * Dispatch + lock lifecycle for the winning job.
 *
 * The winner is activated with only a **short initial lock**. On dispatch we
 * immediately extend it **once** to the recovery window, and only then hand it to
 * the periodic extender + agent runner. The whole lifecycle is bracketed so the
 * worker slot and the heartbeat fiber are released on success, failure, AND
 * interruption.
 *
 * Invariants preserved here:
 *  (a) **extend the winner's lock *before* starting its agent** — if that first
 *      extend races a reclaim (the engine rejects it because another node already
 *      grabbed the job when the short lock lapsed), we DO NOT start: release the
 *      slot and bail. Starting an agent on a job we no longer own is the classic
 *      double-execution / stale 409 bug.
 *  (b) **never touch a parked/lapsed job again** — losers are dropped upstream in
 *      activation and never reach here, so a late complete/fail can't 409.
 */
import { Duration, Effect, Fiber, Schedule } from "effect";
import type { ActivatedJob, EngineClient, JobRunner, Logger, SupervisorError } from "./ports.ts";
import type { Registry } from "./registry.ts";

export interface DispatchConfig {
  /** The window the winner's lock is held to and heartbeated at (ms). */
  readonly recoveryWindowMs: number;
  /** How often to re-extend the winner's lock while it runs (ms). */
  readonly extendIntervalMs: number;
}

export const defaultDispatchConfig: DispatchConfig = {
  recoveryWindowMs: 300_000,
  extendIntervalMs: 60_000,
};

export interface DispatchDeps {
  readonly engine: EngineClient;
  readonly runner: JobRunner;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly config: DispatchConfig;
}

export interface DispatchOutcome {
  readonly started: boolean;
  readonly reason?: "extend-failed";
}

/**
 * Dispatch `job` to already-claimed `workerId`. The slot MUST have been claimed
 * (`registry.claim`) before calling — this owns releasing it again.
 */
export const dispatch = (
  deps: DispatchDeps,
  job: ActivatedJob,
  workerId: string,
): Effect.Effect<DispatchOutcome, never> =>
  Effect.gen(function* () {
    const { engine, runner, registry, logger, config } = deps;

    // (a) Extend the winner FIRST. A failure here means the short lock likely
    // lapsed and the job was reclaimed — do not start; give the slot straight back.
    const extended = yield* engine
      .extendLock(job.jobKey, config.recoveryWindowMs)
      .pipe(
        Effect.as(true),
        Effect.catch((err: SupervisorError) => {
          logger.warn(
            `[${job.type}] job ${job.jobKey}: winner extend failed (${err.message}) — not starting; slot released`,
          );
          return Effect.succeed(false);
        }),
      );

    if (!extended) {
      yield* registry.releaseWorker(workerId);
      return { started: false, reason: "extend-failed" };
    }

    // (b) Heartbeat + run, releasing the slot on every exit path.
    yield* Effect.gen(function* () {
      const heartbeat = yield* Effect.forkChild(
        engine
          .extendLock(job.jobKey, config.recoveryWindowMs)
          .pipe(
            Effect.ignore,
            Effect.repeat(Schedule.spaced(Duration.millis(config.extendIntervalMs))),
          ),
      );
      yield* runner.run(job).pipe(
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => logger.warn(`[${job.type}] job ${job.jobKey}: run failed — ${err.message}`)),
        ),
        Effect.ensuring(Fiber.interrupt(heartbeat)),
      );
    }).pipe(Effect.ensuring(registry.releaseWorker(workerId)));

    return { started: true };
  });
