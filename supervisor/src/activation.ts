/**
 * Capacity-gated activation loop (direct `POST /v2/jobs/activation`, not the SDK).
 *
 * Activation is **per type** — there is no multiplexed poll. For every type that
 * a registered worker can service AND that has a free slot **at request time**,
 * we hold one long-poll with `maxJobsToActivate = 1` (agent jobs run for
 * minutes; minimise over-pull so a collision drops at most K−1, never an
 * unbounded grab of one hot type). We `raceAll` those K polls: the first to hand
 * back a job **wins** and every other in-flight poll is **interrupted** (Effect
 * fiber interruption cancels the pending long-poll — this is the backpressure
 * that collapses the polling storm).
 *
 * Because activation is genuinely per-type and concurrent, ≥2 polls can each
 * lease a job before the winner is picked. Those **loser leases are not failed** —
 * we simply never extend them, so their short initial lock lapses (the honest
 * no-op release; Zeebe has no unlock RPC, and a `fail`-to-yield risks a
 * fleet-wide fail→republish→reactivate hot-loop under saturation). Dropping the
 * loser here (returning only the winner) is exactly that "let it lapse".
 */
import { Duration, Effect } from "effect";
import type { ActivatedJob, EngineClient, SupervisorError } from "./ports.ts";

export interface ActivationConfig {
  /** Long-poll request timeout per activation call (ms). */
  readonly requestTimeoutMs: number;
  /** Short initial lock applied to any activated job (ms) — the crash-safety net. */
  readonly initialLockMs: number;
  /** Spacing before re-polling a type that returned nothing (ms). 0 relies on the server long-poll. */
  readonly emptyPollBackoffMs: number;
}

export const defaultActivationConfig: ActivationConfig = {
  requestTimeoutMs: 10_000,
  initialLockMs: 15_000,
  emptyPollBackoffMs: 0,
};

/** One type's long-poll, repeating on an empty return until it yields a job. */
const activateType = (
  engine: EngineClient,
  type: string,
  cfg: ActivationConfig,
): Effect.Effect<ActivatedJob, SupervisorError> =>
  engine
    .activate({
      type,
      maxJobsToActivate: 1,
      requestTimeoutMs: cfg.requestTimeoutMs,
      lockMs: cfg.initialLockMs,
    })
    .pipe(
      Effect.flatMap((jobs) =>
        jobs.length > 0
          ? Effect.succeed(jobs[0]!)
          : (cfg.emptyPollBackoffMs > 0
              ? Effect.sleep(Duration.millis(cfg.emptyPollBackoffMs))
              : Effect.void
            ).pipe(Effect.flatMap(() => activateType(engine, type, cfg))),
      ),
    );

/**
 * Hold one long-poll per serviceable-with-capacity `type` and race them. Resolves
 * with the single winning job; every losing poll is interrupted and any job a
 * loser already leased is left to lapse (never extended). `types` MUST be
 * non-empty — the caller gates on capacity and only polls when there is a slot.
 */
export const activateWinner = (
  engine: EngineClient,
  types: ReadonlyArray<string>,
  cfg: ActivationConfig,
): Effect.Effect<ActivatedJob, SupervisorError> => {
  if (types.length === 0) {
    return Effect.die(new Error("activateWinner: no serviceable-with-capacity types to poll"));
  }
  return Effect.raceAll(types.map((t) => activateType(engine, t, cfg)));
};
