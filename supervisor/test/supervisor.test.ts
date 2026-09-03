import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeSupervisor } from "../src/supervisor.ts";
import { makeRegistry } from "../src/registry.ts";
import { noopLogger } from "../src/ports.ts";
import { activateAfter, activateBatchAfter, job, makeEngine, makeReader, makeRunner } from "./fakes.ts";

const scan = (xml: string) =>
  xml.split(",").filter(Boolean).map((taskType) => ({ taskType, process: "p" }));

test("end-to-end: a job is activated, its worker claimed, winner extended, agent run — and a BUSY type generates zero further activation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateAfter({ x: { job: job("Jx", "x"), delayMs: 10 } }),
      });
      const runner = makeRunner(100_000); // agent holds the slot for 100s
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["x"], 1);
      const reader = makeReader([[]], {});

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan,
        logger: noopLogger,
        config: { idleSpacingMs: 1_000, activation: { requestTimeoutMs: 10_000, initialLockMs: 15_000, emptyPollBackoffMs: 0, maxBatchPerType: 10 } },
      });

      const fiber = yield* Effect.forkChild(sup.run);
      yield* TestClock.adjust(Duration.millis(10)); // winning long-poll resolves
      yield* TestClock.adjust(Duration.millis(5)); // let dispatch fork run

      assert.deepEqual(runner.ran, ["Jx"], "the winning job was dispatched to the agent runner");
      assert.ok(engine.extended.some((e) => e.jobKey === "Jx"), "winner extended to the recovery window");
      assert.deepEqual(yield* reg.pollTypes, [], "type x is busy → no free slot");

      // Advance well past the long-poll window: because x is busy, NO new activation
      // is issued for it (per-type capacity gating — the whole point of the rewrite).
      yield* TestClock.adjust(Duration.millis(30_000));
      assert.equal(
        engine.activateCalls.filter((t) => t === "x").length,
        1,
        "exactly one activation while busy — zero over-activation",
      );

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("reconcile wiring: an --auto worker's serviceable types are published from the cached crawl", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({ activate: () => Effect.never as never });
      const runner = makeRunner(0);
      const reg = yield* makeRegistry();
      yield* reg.add("auto", [], 1); // starts servicing nothing
      const reader = makeReader([["k1", "k2"]], { k1: "alpha", k2: "beta" });

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan,
        autoWorkerId: "auto",
        logger: noopLogger,
      });

      assert.deepEqual(yield* reg.pollTypes, []);
      yield* sup.reconcileOnce;
      assert.deepEqual([...(yield* reg.pollTypes)].sort(), ["alpha", "beta"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("homogeneous fan-out: N idle workers on one type fill in a SINGLE activation round", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateBatchAfter({
          x: { jobs: [job("J1", "x"), job("J2", "x"), job("J3", "x")], delayMs: 10 },
        }),
      });
      const runner = makeRunner(100_000); // each agent holds its slot
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["x"], 1);
      yield* reg.add("w2", ["x"], 1);
      yield* reg.add("w3", ["x"], 1);
      const reader = makeReader([[]], {});

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan,
        logger: noopLogger,
      });

      const fiber = yield* Effect.forkChild(sup.run);
      yield* TestClock.adjust(Duration.millis(10)); // the single long-poll resolves with 3 jobs
      yield* TestClock.adjust(Duration.millis(5)); // let the 3 dispatch forks run

      assert.deepEqual(runner.ran.slice().sort(), ["J1", "J2", "J3"], "all 3 slots filled from one round");
      assert.equal(
        engine.activateCalls.filter((t) => t === "x").length,
        1,
        "exactly ONE activation round filled all 3 slots (not 3 max-1 rounds)",
      );
      assert.equal(engine.activateRequests[0]!.maxJobsToActivate, 3, "batch sized to the free-slot count");
      assert.deepEqual(yield* reg.pollTypes, [], "all workers busy");

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("heterogeneous mix: the winning type pulls up to its own free-slot count; each type is polled with its batch size", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateBatchAfter({
          a: { jobs: [job("Ja1", "a"), job("Ja2", "a")], delayMs: 5 },
          b: { jobs: [job("Jb1", "b")], delayMs: 500 },
        }),
      });
      const runner = makeRunner(100_000);
      const reg = yield* makeRegistry();
      yield* reg.add("wa1", ["a"], 1);
      yield* reg.add("wa2", ["a"], 1);
      yield* reg.add("wb1", ["b"], 1);
      const reader = makeReader([[]], {});

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan,
        logger: noopLogger,
      });

      const fiber = yield* Effect.forkChild(sup.run);
      yield* TestClock.adjust(Duration.millis(5)); // "a" wins the race
      yield* TestClock.adjust(Duration.millis(5)); // let both "a" dispatches run

      assert.deepEqual(runner.ran.slice().sort(), ["Ja1", "Ja2"], "type a pulled BOTH its free slots in one round");
      // Each type was polled sized to its own free-slot count (a:2, b:1).
      const reqByType = new Map(engine.activateRequests.map((r) => [r.type, r.maxJobsToActivate]));
      assert.equal(reqByType.get("a"), 2);
      assert.equal(reqByType.get("b"), 1);
      // b's poll was interrupted before it leased — its lease lapses, nothing extended for b.
      assert.ok(!engine.leased.includes("Jb1"), "losing type b never leased");
      assert.ok(!engine.extended.some((e) => e.jobKey === "Jb1"), "losing type b never extended");

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("unplaceable extras go to the parking lot (not failed) and are promoted when a slot frees", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Over-returns 2 jobs for "x" regardless of the requested batch — models a
      // slot raced away between poll and claim, so one job cannot be placed.
      const engine = makeEngine({
        activate: (req) =>
          req.type === "x"
            ? Effect.sleep(Duration.millis(10)).pipe(Effect.as([job("J1", "x"), job("J2", "x")]))
            : (Effect.never as never),
      });
      const runner = makeRunner(100_000);
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["x"], 1);
      yield* reg.add("w2", ["x"], 1);
      // Make w1 busy so only ONE slot is free — J2 will be unplaceable.
      const busyWorker = yield* reg.claim("x");
      assert.ok(busyWorker);
      const reader = makeReader([[]], {});

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan,
        logger: noopLogger,
      });

      const fiber = yield* Effect.forkChild(sup.run);
      yield* TestClock.adjust(Duration.millis(10)); // long-poll resolves with 2 jobs
      yield* TestClock.adjust(Duration.millis(5)); // dispatch J1, park J2

      assert.deepEqual(runner.ran, ["J1"], "J1 dispatched to the one free worker");
      assert.equal(yield* sup.parking.size, 1, "J2 parked (unplaceable), NOT failed");
      assert.deepEqual(engine.extended.filter((e) => e.jobKey === "J2"), [], "parked J2 not extended while waiting");

      // Free the busy worker → a later tick promotes the parked J2 onto it.
      yield* reg.releaseWorker(busyWorker!);
      yield* TestClock.adjust(Duration.millis(1_000)); // wake the idle-spacing tick → promote J2
      yield* TestClock.adjust(Duration.millis(5)); // let the promoted dispatch fork run

      assert.deepEqual(runner.ran.slice().sort(), ["J1", "J2"], "parked J2 promoted onto the freed slot");
      assert.equal(yield* sup.parking.size, 0, "parking lot drained");

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
