import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { activateWinner, batchSizeFor, defaultActivationConfig } from "../src/activation.ts";
import { activateAfter, activateBatchAfter, job, makeEngine } from "./fakes.ts";

test("batchSizeFor clamps the requested batch to [1, maxBatchPerType]", () => {
  const cfg = { ...defaultActivationConfig, maxBatchPerType: 4 };
  assert.equal(batchSizeFor(0, cfg), 1, "a zero free-slot count still asks for at least 1");
  assert.equal(batchSizeFor(1, cfg), 1);
  assert.equal(batchSizeFor(3, cfg), 3, "sized to the type's own free-slot count");
  assert.equal(batchSizeFor(9, cfg), 4, "capped at maxBatchPerType");
});

test("winner is the earliest type to return a batch; the slower type's poll is interrupted (zero traffic)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateAfter({
          a: { job: job("J-a", "a"), delayMs: 10 },
          b: { job: job("J-b", "b"), delayMs: 500 },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(
          engine,
          [
            { type: "a", freeSlots: 1 },
            { type: "b", freeSlots: 1 },
          ],
          defaultActivationConfig,
        ),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winners = yield* Fiber.join(fiber);
      assert.deepEqual(
        winners.map((j) => j.jobKey),
        ["J-a"],
      );
      // "b" never leased a job — its long-poll was cancelled the moment "a" won.
      assert.deepEqual(engine.leased, ["J-a"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("capacity-sized batch: one type with N free slots pulls up to N jobs in a single round", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateBatchAfter({
          a: { jobs: [job("J1", "a"), job("J2", "a"), job("J3", "a")], delayMs: 10 },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 3 }], defaultActivationConfig),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winners = yield* Fiber.join(fiber);
      assert.deepEqual(
        winners.map((j) => j.jobKey),
        ["J1", "J2", "J3"],
        "one activation round filled all 3 free slots",
      );
      assert.equal(engine.activateRequests[0]!.maxJobsToActivate, 3, "requested batch == free-slot count");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("batch respects maxBatchPerType: a hot type with more free slots than the cap only pulls the cap", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateBatchAfter({
          a: {
            jobs: [job("J1", "a"), job("J2", "a"), job("J3", "a"), job("J4", "a"), job("J5", "a")],
            delayMs: 10,
          },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 5 }], {
          ...defaultActivationConfig,
          maxBatchPerType: 2,
        }),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winners = yield* Fiber.join(fiber);
      assert.equal(engine.activateRequests[0]!.maxJobsToActivate, 2, "batch capped at maxBatchPerType");
      assert.deepEqual(
        winners.map((j) => j.jobKey),
        ["J1", "J2"],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("collision: both types return at once → exactly one type's batch wins; the loser's lease is NOT extended (it lapses)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateAfter({
          a: { job: job("J-a", "a"), delayMs: 10 },
          b: { job: job("J-b", "b"), delayMs: 10 },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(
          engine,
          [
            { type: "a", freeSlots: 1 },
            { type: "b", freeSlots: 1 },
          ],
          defaultActivationConfig,
        ),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winners = yield* Fiber.join(fiber);
      // activateWinner surfaces exactly one type's batch.
      assert.equal(winners.length, 1);
      assert.ok(winners[0]!.jobKey === "J-a" || winners[0]!.jobKey === "J-b");
      // The loser is never extended by this layer — dispatch only ever extends the
      // returned winners, so any also-leased loser simply lapses. (No fail/unlock RPC.)
      assert.deepEqual(engine.extended, []);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("empty long-poll re-polls the same type until a job appears", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine = makeEngine({
        activate: (req) =>
          Effect.sleep(Duration.millis(100)).pipe(
            Effect.map(() => {
              calls += 1;
              return calls >= 3 ? [job("J-a", req.type)] : [];
            }),
          ),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 1 }], {
          ...defaultActivationConfig,
          emptyPollBackoffMs: 0,
        }),
      );
      yield* TestClock.adjust(Duration.millis(300));
      const winners = yield* Fiber.join(fiber);
      assert.deepEqual(
        winners.map((j) => j.jobKey),
        ["J-a"],
      );
      assert.equal(calls, 3, "re-polled twice on empty before the third returned a job");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
