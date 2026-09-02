import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { defaultDispatchConfig, dispatch } from "../src/dispatch.ts";
import { makeRegistry } from "../src/registry.ts";
import { noopLogger } from "../src/ports.ts";
import { failing, job, makeEngine, makeRunner } from "./fakes.ts";

const engineOk = () => makeEngine({ activate: () => Effect.succeed([]) });

test("happy path: winner is extended to the recovery window before the agent runs; slot released after", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = engineOk();
      const runner = makeRunner(0);
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");
      assert.equal(worker, "w1");

      const outcome = yield* dispatch(
        { engine, runner, registry: reg, logger: noopLogger, config: defaultDispatchConfig },
        job("J1", "a"),
        worker!,
      );

      assert.equal(outcome.started, true);
      assert.equal(runner.ran[0], "J1");
      // Winner was extended to the recovery window (invariant a: extend-before-start).
      assert.ok(engine.extended.some((e) => e.jobKey === "J1" && e.ms === defaultDispatchConfig.recoveryWindowMs));
      // Slot released → the type is pollable again.
      assert.deepEqual(yield* reg.pollTypes, ["a"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("winner-extend races a reclaim: extend fails → do NOT start the agent; slot released", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: () => Effect.succeed([]),
        extend: () => failing("409 job already reclaimed"),
      });
      const runner = makeRunner(0);
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      const outcome = yield* dispatch(
        { engine, runner, registry: reg, logger: noopLogger, config: defaultDispatchConfig },
        job("J1", "a"),
        worker!,
      );

      assert.equal(outcome.started, false);
      assert.equal(outcome.reason, "extend-failed");
      assert.deepEqual(runner.ran, [], "agent never started on a reclaimed job");
      assert.deepEqual(yield* reg.pollTypes, ["a"], "slot given straight back");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("heartbeat: the winner's lock is re-extended on the interval while the agent runs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = engineOk();
      const runner = makeRunner(200_000); // agent runs 200s
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      const fiber = yield* Effect.forkChild(
        dispatch(
          { engine, runner, registry: reg, logger: noopLogger, config: { recoveryWindowMs: 300_000, extendIntervalMs: 60_000 } },
          job("J1", "a"),
          worker!,
        ),
      );

      yield* TestClock.adjust(Duration.millis(130_000)); // ~2 interval fires + first extends
      const extendsSoFar = engine.extended.filter((e) => e.jobKey === "J1").length;
      assert.ok(extendsSoFar >= 3, `expected repeated extends, got ${extendsSoFar}`);

      yield* TestClock.adjust(Duration.millis(100_000)); // let the agent finish
      yield* Fiber.join(fiber);
      assert.deepEqual(yield* reg.pollTypes, ["a"], "slot released once the agent finished");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
