import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { activateWinner, defaultActivationConfig } from "../src/activation.ts";
import { activateAfter, job, makeEngine } from "./fakes.ts";

test("winner is the earliest type to return a job; the slower type's poll is interrupted (zero traffic)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateAfter({
          a: { job: job("J-a", "a"), delayMs: 10 },
          b: { job: job("J-b", "b"), delayMs: 500 },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, ["a", "b"], defaultActivationConfig),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winner = yield* Fiber.join(fiber);
      assert.equal(winner.jobKey, "J-a");
      // "b" never leased a job — its long-poll was cancelled the moment "a" won.
      assert.deepEqual(engine.leased, ["J-a"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("collision: both types return at once → exactly one winner; the loser's lease is NOT extended (it lapses)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = makeEngine({
        activate: activateAfter({
          a: { job: job("J-a", "a"), delayMs: 10 },
          b: { job: job("J-b", "b"), delayMs: 10 },
        }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, ["a", "b"], defaultActivationConfig),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const winner = yield* Fiber.join(fiber);
      // activateWinner surfaces exactly one job.
      assert.ok(winner.jobKey === "J-a" || winner.jobKey === "J-b");
      // The loser is never extended by this layer — dispatch only ever extends the
      // returned winner, so any also-leased loser simply lapses. (No fail/unlock RPC.)
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
        activateWinner(engine, ["a"], { ...defaultActivationConfig, emptyPollBackoffMs: 0 }),
      );
      yield* TestClock.adjust(Duration.millis(300));
      const winner = yield* Fiber.join(fiber);
      assert.equal(winner.jobKey, "J-a");
      assert.equal(calls, 3, "re-polled twice on empty before the third returned a job");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
