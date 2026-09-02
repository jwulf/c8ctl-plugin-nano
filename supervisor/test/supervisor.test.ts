import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeSupervisor } from "../src/supervisor.ts";
import { makeRegistry } from "../src/registry.ts";
import { noopLogger } from "../src/ports.ts";
import { activateAfter, job, makeEngine, makeReader, makeRunner } from "./fakes.ts";

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
        config: { idleSpacingMs: 1_000, activation: { requestTimeoutMs: 10_000, initialLockMs: 15_000, emptyPollBackoffMs: 0 } },
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
