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
import { Duration, Effect } from "effect";
import type { ActivatedJob, EngineClient, JobRunner, Logger, SupervisorError } from "./ports.ts";
import type { Registry } from "./registry.ts";
import type { OwnershipContext } from "./ownership.ts";
import { withOwnedJob } from "./ownership.ts";

/**
 * Does this extend/settle rejection mean the worker has DEFINITIVELY lost the job
 * (the lock lapsed and the broker reclaimed it, or the lease was superseded)? Only
 * these unambiguous ownership-loss signals — a 409 (reclaim / `JobLeaseMismatch`),
 * a 404 (job gone), or the engine's "not activated" body — mean the lease is gone.
 * Everything TRANSIENT (a 5xx, a 429, a network blip, a timeout) is NOT ownership
 * loss and must not, on its own, stop lock renewal.
 */
export const isLeaseLostError = (err: SupervisorError): boolean =>
  /HTTP 4(?:09|04)\b|\bnot activated\b|joblease\s*mismatch|lease\s*mismatch|\bnot found\b|\breclaim/i.test(
    err.message,
  );

/**
 * Does this extend rejection mean renewal can NEVER succeed by retrying — a
 * permanent client-side failure (a 400 bad-request / validation, or a 401/403
 * auth failure)? These are not transient: retrying them forever while the agent
 * keeps running would let the finite recovery window lapse with no successful
 * beat, so the broker reclaims and RE-RUNS the job — the exact duplicate-execution
 * this heartbeat exists to prevent. A 429 (rate-limited) and any 5xx are TRANSIENT
 * (the server is asking us to back off / is briefly unhealthy), so they are
 * excluded — only a definitively permanent 4xx counts.
 */
export const isPermanentRenewalError = (err: SupervisorError): boolean =>
  /HTTP 4(?:00|01|03|22)\b|\bunauthori[sz]ed\b|\bforbidden\b/i.test(err.message);

/**
 * A heartbeat beat must END the renewal loop (and so interrupt the run) when the
 * lock can no longer be held: either the lease is already lost
 * ({@link isLeaseLostError}) OR renewal is permanently impossible
 * ({@link isPermanentRenewalError}). Continuing the agent past either is pointless
 * and dangerous — the lock will lapse and the job will be redelivered.
 */
export const isTerminalRenewalError = (err: SupervisorError): boolean =>
  isLeaseLostError(err) || isPermanentRenewalError(err);

const defectText = (defect: unknown): string =>
  defect instanceof Error ? defect.message : String(defect);

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
  /**
   * When set, the job is `claim`ed on this ownership context for the lifetime of
   * the agent child (issue #158): the claim is emitted just before the runner
   * spawns the child and released on every exit path. The `workerId` is the
   * explicit `instance` on every ownership frame.
   */
  readonly ownership?: OwnershipContext;
}

export interface DispatchOutcome {
  readonly started: boolean;
  readonly reason?: "extend-failed" | "lock-lost";
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
    const { engine, runner, registry, logger, config, ownership } = deps;

    // (a) Extend the winner FIRST. A failure here means the short lock likely
    // lapsed and the job was reclaimed — do not start; give the slot straight back.
    const extended = yield* engine
      .extendLock(job.jobKey, config.recoveryWindowMs, job.leaseToken)
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

    // (b) Heartbeat + run. The heartbeat holds the lock for the agent's whole
    // run; the run and the heartbeat RACE so that either terminates the other:
    //   * agent finishes first → the heartbeat is interrupted (loser of the race);
    //   * the lease is definitively lost first → the heartbeat ends the race and
    //     the still-running agent is interrupted — a SUPERSEDED worker must stop,
    //     never run on to a doomed completeJob (which is what left empty transcript
    //     husks and let the broker redeliver the job in a loop).
    // The slot is released on every exit path.
    const lostLock = yield* Effect.gen(function* () {
      // One heartbeat beat: wait an interval, then SET the lock to the recovery
      // window (lease-fenced with `job.leaseToken`). Resilience is the whole point
      // here — this fiber must NOT die silently and stop renewing:
      //   * a TRANSIENT typed failure (5xx / 429 / network blip) is logged and
      //     swallowed so the next beat still fires;
      //   * a DEFECT (e.g. the deployed `Not a valid effect: [object Promise]`,
      //     which a typed-only `Effect.catch` would let escape and KILL the fiber)
      //     is caught via `catchDefect` and swallowed the same way;
      //   * a TERMINAL renewal error (`isTerminalRenewalError`: a definitive
      //     lease-loss OR a permanent 400/401/403 that retrying can never fix) is
      //     re-raised, ending the `forever` loop so the race interrupts the run —
      //     because the lock cannot be held, continuing the agent only invites the
      //     broker to reclaim and re-run the job.
      const beatOnce = Effect.sleep(Duration.millis(config.extendIntervalMs)).pipe(
        Effect.flatMap(() =>
          engine.extendLock(job.jobKey, config.recoveryWindowMs, job.leaseToken).pipe(
            Effect.catch((err: SupervisorError) =>
              isTerminalRenewalError(err)
                ? Effect.fail(err)
                : Effect.sync(() =>
                    logger.warn(
                      `[${job.type}] job ${job.jobKey}: heartbeat extend failed (transient, retrying) — ${err.message}`,
                    ),
                  ),
            ),
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                logger.warn(
                  `[${job.type}] job ${job.jobKey}: heartbeat extend defect (ignored, retrying) — ${defectText(defect)}`,
                ),
              ),
            ),
          ),
        ),
      );
      const heartbeatUntilLost = Effect.forever(beatOnce);

      // The agent child runs under a claim whose lifetime == the child's own
      // (issue #158): claimed just before spawn, released on every exit path so a
      // silent, zero-transcript agent still reads as `claimed = working` and an
      // unclean kill clears the jobKey within one window (no leak).
      const runChild = runner.run(job).pipe(
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => logger.warn(`[${job.type}] job ${job.jobKey}: run failed — ${err.message}`)),
        ),
      );
      const owned = ownership ? withOwnedJob(ownership, workerId, job.jobKey, runChild) : runChild;

      // `raceFirst`: the FIRST side to complete (success OR failure) wins and the
      // loser is interrupted. If a beat hits a TERMINAL renewal error it fails →
      // wins the race → `owned` (the agent) is interrupted; otherwise the agent
      // finishes and the heartbeat is interrupted. The failure is caught here → the
      // run stopped because the lock can no longer be held (superseded, or renewal
      // permanently impossible).
      return yield* Effect.raceFirst(owned, heartbeatUntilLost).pipe(
        Effect.as(false),
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => {
            logger.warn(
              `[${job.type}] job ${job.jobKey}: lock lost mid-run — agent interrupted (lock unrenewable); slot released — ${err.message}`,
            );
            return true;
          }),
        ),
      );
    }).pipe(Effect.ensuring(registry.releaseWorker(workerId)));

    return lostLock ? { started: true, reason: "lock-lost" } : { started: true };
  });
