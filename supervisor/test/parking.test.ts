import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeParkingLot, prune, takeValidFor } from "../src/parking.ts";
import { job } from "./fakes.ts";

test("takeValidFor picks the oldest live parked job for a serviceable type and prunes expired", () => {
  const parked = [
    { job: job("J1", "a"), lockDeadlineMs: 100 },
    { job: job("J2", "b"), lockDeadlineMs: 50 },
    { job: job("J3", "a"), lockDeadlineMs: 200 },
  ];
  // At now=60, J2 (deadline 50) has lapsed and is pruned.
  const r1 = takeValidFor(parked, new Set(["a"]), 60);
  assert.equal(r1.picked?.job.jobKey, "J1"); // oldest live "a"
  assert.deepEqual(r1.rest.map((p) => p.job.jobKey), ["J3"]); // J2 pruned, J1 taken
  // No serviceable type → nothing picked, but expired still pruned.
  const r2 = takeValidFor(parked, new Set(["z"]), 60);
  assert.equal(r2.picked, null);
  assert.deepEqual(r2.rest.map((p) => p.job.jobKey).sort(), ["J1", "J3"]);
});

test("prune drops entries whose lock lapsed at now", () => {
  const parked = [
    { job: job("J1", "a"), lockDeadlineMs: 100 },
    { job: job("J2", "a"), lockDeadlineMs: 300 },
  ];
  assert.deepEqual(prune(parked, 200).map((p) => p.job.jobKey), ["J2"]);
});

test("ParkingLot: promote-on-slot-free returns a parked job while its lock is live, then nothing once it lapses", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const lot = yield* makeParkingLot();
      yield* lot.park(job("J1", "a"), 15_000); // lock lives 15s from now (t=0)
      assert.equal(yield* lot.size, 1);

      yield* TestClock.adjust(Duration.millis(5_000)); // t=5s, still live
      const promoted = yield* lot.takeFor(new Set(["a"]));
      assert.equal(promoted?.job.jobKey, "J1", "promoted the parked job instead of re-fetching");
      assert.equal(yield* lot.size, 0);

      // Park again, then let the lock lapse — it must NOT be promotable (it lapsed).
      yield* lot.park(job("J2", "a"), 15_000);
      yield* TestClock.adjust(Duration.millis(20_000));
      const lapsed = yield* lot.takeFor(new Set(["a"]));
      assert.equal(lapsed, null, "a lapsed parked job is never promoted");
      assert.equal(yield* lot.size, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("ParkingLot: repark preserves the original lock deadline instead of resetting it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const lot = yield* makeParkingLot();
      yield* lot.park(job("J1", "a"), 15_000); // deadline t=15s (parked at t=0)

      yield* TestClock.adjust(Duration.millis(10_000)); // t=10s, still live
      const promoted = yield* lot.takeFor(new Set(["a"]));
      assert.equal(promoted?.job.jobKey, "J1");

      // Re-park (slot raced away). The deadline must stay t=15s, NOT reset to t=25s.
      yield* lot.repark(promoted!);
      yield* TestClock.adjust(Duration.millis(6_000)); // t=16s — past the original deadline
      const lapsed = yield* lot.takeFor(new Set(["a"]));
      assert.equal(lapsed, null, "reparked job lapses on its original deadline, not a reset one");
      assert.equal(yield* lot.size, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("ParkingLot: repark drops a job whose lock has already lapsed", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const lot = yield* makeParkingLot();
      yield* lot.park(job("J1", "a"), 15_000);
      yield* TestClock.adjust(Duration.millis(10_000));
      const promoted = yield* lot.takeFor(new Set(["a"]));
      assert.equal(promoted?.job.jobKey, "J1");

      yield* TestClock.adjust(Duration.millis(10_000)); // t=20s — deadline (15s) lapsed
      yield* lot.repark(promoted!);
      assert.equal(yield* lot.size, 0, "an already-lapsed job is not re-added");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("ParkingLot: takeFor ignores parked jobs whose type is not currently serviceable", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const lot = yield* makeParkingLot();
      yield* lot.park(job("J1", "a"), 15_000);
      const none = yield* lot.takeFor(new Set(["b"]));
      assert.equal(none, null);
      const some = yield* lot.takeFor(new Set(["a", "b"]));
      assert.equal(some?.job.jobKey, "J1");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
