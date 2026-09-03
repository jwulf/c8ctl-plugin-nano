/**
 * Capacity-gated **batched** activation loop (direct `POST /v2/jobs/activation`,
 * not the SDK).
 *
 * Activation is **per type** — there is no multiplexed poll. For every type that
 * a registered worker can service AND that has a free slot **at request time**,
 * we hold one long-poll sized to that type's own free-slot count
 * (`maxJobsToActivate = clamp(freeSlots, 1, maxBatchPerType)`), so one round can
 * saturate a hot type's idle workers instead of filling them one-per-round by
 * pipelining. We `raceAll` those K polls: the first to hand back a **batch**
 * **wins** and every other in-flight poll is **interrupted** (Effect fiber
 * interruption cancels the pending long-poll — this is the backpressure that
 * collapses the polling storm).
 *
 * The over-pull bound is therefore "at most one type's extra batch", which the
 * `maxBatchPerType` cap limits — it can never be an unbounded grab of one hot
 * type. Because activation is genuinely per-type and concurrent, ≥2 polls can
 * each lease jobs before the winner is picked. Those **loser leases are not
 * failed** — we simply never extend them, so their short initial lock lapses (the
 * honest no-op release; Zeebe has no unlock RPC, and a `fail`-to-yield risks a
 * fleet-wide fail→republish→reactivate hot-loop under saturation). Dropping the
 * losing types here (returning only the winning type's batch) is exactly that
 * "let it lapse". Any winner in the returned batch that then cannot claim a slot
 * is parked by the caller — also never failed.
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
  /**
   * Upper bound on `maxJobsToActivate` for any single type's activation, even
   * when that type has more free slots. Bounds a single hot type's extra batch
   * from starving variety and caps net over-pull per round. Clamped to ≥1.
   */
  readonly maxBatchPerType: number;
}

export const defaultActivationConfig: ActivationConfig = {
  requestTimeoutMs: 10_000,
  initialLockMs: 15_000,
  emptyPollBackoffMs: 0,
  maxBatchPerType: 10,
};

/** One serviceable type with its current free-slot count (the batch size to request). */
export interface PollTarget {
  readonly type: string;
  readonly freeSlots: number;
}

/**
 * One type's long-poll, repeating on an empty return until it yields a non-empty
 * batch. `maxJobs` is the per-type batch size (already clamped by the caller).
 */
const activateType = (
  engine: EngineClient,
  type: string,
  maxJobs: number,
  cfg: ActivationConfig,
): Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorError> =>
  // Explicit constant-space loop (not self-recursion): re-poll on an empty
  // return until jobs are leased, without building an ever-deeper Effect chain.
  Effect.gen(function* () {
    while (true) {
      const jobs = yield* engine.activate({
        type,
        maxJobsToActivate: maxJobs,
        requestTimeoutMs: cfg.requestTimeoutMs,
        lockMs: cfg.initialLockMs,
      });
      if (jobs.length > 0) {
        return jobs;
      }
      if (cfg.emptyPollBackoffMs > 0) {
        yield* Effect.sleep(Duration.millis(cfg.emptyPollBackoffMs));
      }
    }
  });

/** The batch size to request for a target: its free-slot count, clamped to `[1, cap]`. */
export const batchSizeFor = (freeSlots: number, cfg: ActivationConfig): number =>
  Math.min(Math.max(1, freeSlots), Math.max(1, cfg.maxBatchPerType));

/**
 * Hold one long-poll per serviceable-with-capacity target and race them. Resolves
 * with the **winning type's batch** (1..freeSlots jobs, capped by
 * `maxBatchPerType`); every losing poll is interrupted and any job a loser
 * already leased is left to lapse (never extended). `targets` MUST be non-empty —
 * the caller gates on capacity and only polls when there is a slot.
 */
export const activateWinner = (
  engine: EngineClient,
  targets: ReadonlyArray<PollTarget>,
  cfg: ActivationConfig,
): Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorError> => {
  if (targets.length === 0) {
    return Effect.die(new Error("activateWinner: no serviceable-with-capacity types to poll"));
  }
  return Effect.raceAll(
    targets.map((t) => activateType(engine, t.type, batchSizeFor(t.freeSlots, cfg), cfg)),
  );
};
