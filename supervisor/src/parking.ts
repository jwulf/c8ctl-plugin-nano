/**
 * Parking lot for promote-on-slot-free.
 *
 * A job we activated but could not immediately dispatch — because the slot we
 * meant it for was raced away by a concurrent dispatch on the same host — is
 * **parked, not failed**. Its short lock is still ours for the lock window, so
 * rather than dropping it (letting it lapse and re-fetching later) we hold it and
 * **promote** it the instant a slot frees within that window. Promotion re-extends
 * the lock first (via the normal dispatch path), so a job whose lock actually
 * lapsed while parked is caught by the winner-extend guard and dropped safely.
 *
 * Entries past their lock deadline are pruned (and thereby lapse — the honest
 * no-op release). Time is read from Effect's `Clock`, so `TestClock` drives it.
 */
import { Clock, Effect, Ref } from "effect";
import type { ActivatedJob } from "./ports.ts";

export interface ParkedJob {
  readonly job: ActivatedJob;
  /** Absolute ms deadline (now + initial lock) after which the lease has lapsed. */
  readonly lockDeadlineMs: number;
}

/** Drop entries whose lock has lapsed at `now`. Pure. */
export function prune(parked: ReadonlyArray<ParkedJob>, now: number): ReadonlyArray<ParkedJob> {
  return parked.filter((p) => p.lockDeadlineMs > now);
}

/**
 * Take the oldest still-valid parked job whose type is in `types` at `now`. Pure;
 * returns the picked job (or null) and the remaining lot (with expired entries pruned).
 */
export function takeValidFor(
  parked: ReadonlyArray<ParkedJob>,
  types: ReadonlySet<string>,
  now: number,
): { picked: ParkedJob | null; rest: ReadonlyArray<ParkedJob> } {
  const live = prune(parked, now);
  const idx = live.findIndex((p) => types.has(p.job.type));
  if (idx === -1) return { picked: null, rest: live };
  const picked = live[idx]!;
  const rest = live.filter((_, i) => i !== idx);
  return { picked, rest };
}

export interface ParkingLot {
  /** Park a job with a lock deadline `lockMs` from now. */
  park(job: ActivatedJob, lockMs: number): Effect.Effect<void>;
  /** Promote the oldest live parked job servicing one of `types`, pruning expired. */
  takeFor(types: ReadonlySet<string>): Effect.Effect<ActivatedJob | null>;
  /** Current parked count after pruning lapsed entries (telemetry/tests). */
  readonly size: Effect.Effect<number>;
}

export const makeParkingLot = (): Effect.Effect<ParkingLot> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyArray<ParkedJob>>([]);
    return {
      park: (job, lockMs) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Ref.update(ref, (lot) => [...prune(lot, now), { job, lockDeadlineMs: now + lockMs }]),
          ),
        ),
      takeFor: (types) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Ref.modify(ref, (lot) => {
              const { picked, rest } = takeValidFor(lot, types, now);
              return [picked ? picked.job : null, rest];
            }),
          ),
        ),
      size: Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.updateAndGet(ref, (lot) => prune(lot, now))),
        Effect.map((lot) => lot.length),
      ),
    };
  });
