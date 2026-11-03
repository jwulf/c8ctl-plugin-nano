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
 * The over-pull bound is therefore **per type** "at most that type's own batch"
 * (`maxBatchPerType`) — never an unbounded grab of one hot type. It is **not**
 * bounded to a single type's batch overall: because activation is genuinely
 * per-type and concurrent, in a timing collision ≥2 racing polls can each hand
 * back (and thus lease) up to their per-type batch before the winner is picked
 * and the losers are interrupted, so the worst-case surplus is the sum of the
 * losing types' leases (each ≤ `maxBatchPerType`). Those **loser leases are not
 * failed** — we simply never extend them, so their short initial lock lapses (the
 * honest no-op release; Zeebe has no unlock RPC, and a `fail`-to-yield risks a
 * fleet-wide fail→republish→reactivate hot-loop under saturation). Dropping the
 * losing types here (returning only the winning type's batch) is exactly that
 * "let it lapse". Any winner in the returned batch that then cannot claim a slot
 * is parked by the caller — also never failed.
 */
import { Clock, Duration, Effect } from "effect";
import type { ActivatedJob, EngineClient, SupervisorError } from "./ports.ts";

export interface ActivationConfig {
  /** Long-poll request timeout per activation call (ms). */
  readonly requestTimeoutMs: number;
  /** Short initial lock applied to any activated job (ms) — the crash-safety net. */
  readonly initialLockMs: number;
  /** Spacing before re-polling a type that returned nothing (ms). 0 relies on the server long-poll. */
  readonly emptyPollBackoffMs: number;
  /**
   * Floor on how often ONE type may be re-polled after an empty answer (ms). An
   * empty poll that returned sooner than this (the engine answered instead of
   * holding the long-poll) waits out the remainder, so a server that stops
   * honouring `requestTimeout` can't turn every type into a hot loop. A normal
   * long-poll takes longer than the floor and is re-issued immediately.
   */
  readonly minEmptyPollIntervalMs: number;
  /** First retry delay after a type's poll fails (ms); doubles per consecutive failure. */
  readonly errorBackoffInitialMs: number;
  /** Cap on the per-type retry delay after consecutive poll failures (ms). */
  readonly errorBackoffMaxMs: number;
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
  minEmptyPollIntervalMs: 1_000,
  errorBackoffInitialMs: 1_000,
  errorBackoffMaxMs: 30_000,
  maxBatchPerType: 10,
};

/** Called each time one type's poll fails and is about to be retried. */
export type PollErrorHandler = (type: string, error: SupervisorError, retryInMs: number) => void;

/** Delay before retry N (1-based) of a failing type: initial × 2^(N-1), capped. */
export const errorBackoffFor = (consecutiveFailures: number, cfg: ActivationConfig): number =>
  Math.min(
    Math.max(0, cfg.errorBackoffMaxMs),
    Math.max(0, cfg.errorBackoffInitialMs) * 2 ** Math.max(0, Math.min(consecutiveFailures - 1, 30)),
  );

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
  onPollError: PollErrorHandler,
): Effect.Effect<ReadonlyArray<ActivatedJob>> =>
  // A poll ERROR must never end this loop. `raceAll` only fails once EVERY branch
  // has failed, so a branch that exits on error silently drops its type from the
  // round: after an engine restart the worker kept polling only the few types
  // whose poll happened to straddle the outage, until one of THEM got a job. So
  // a failed poll is reported and retried with capped exponential backoff — the
  // type stays subscribed, and a dead engine is probed at a falling rate instead
  // of hammered. Interruption (this type lost the race) is not a failure and
  // still ends the loop immediately.
  Effect.gen(function* () {
    let consecutiveFailures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* engine
        .activate({
          type,
          maxJobsToActivate: maxJobs,
          requestTimeoutMs: cfg.requestTimeoutMs,
          lockMs: cfg.initialLockMs,
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        consecutiveFailures += 1;
        const retryInMs = errorBackoffFor(consecutiveFailures, cfg);
        onPollError(type, result.failure, retryInMs);
        yield* Effect.sleep(Duration.millis(retryInMs));
        continue;
      }
      consecutiveFailures = 0;
      const jobs = result.success;
      if (jobs.length > 0) {
        return jobs;
      }
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      const waitMs = Math.max(cfg.emptyPollBackoffMs, cfg.minEmptyPollIntervalMs - elapsedMs);
      if (waitMs > 0) {
        yield* Effect.sleep(Duration.millis(waitMs));
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
  onPollError: PollErrorHandler = () => {},
): Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorError> => {
  if (targets.length === 0) {
    return Effect.die(new Error("activateWinner: no serviceable-with-capacity types to poll"));
  }
  return Effect.raceAll(
    targets.map((t) => activateType(engine, t.type, batchSizeFor(t.freeSlots, cfg), cfg, onPollError)),
  );
};
