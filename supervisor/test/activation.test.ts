import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { activateWinner, batchSizeFor, defaultActivationConfig, errorBackoffFor } from "../src/activation.ts";
import { SupervisorError } from "../src/ports.ts";
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
          minEmptyPollIntervalMs: 0,
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

test("a type whose poll fails stays in the race: it is retried with backoff, not dropped while other types keep long-polling", async () => {
  // Regression: an engine restart failed some types' in-flight polls. raceAll only
  // fails when EVERY branch fails, so a branch that exited on error silently dropped
  // its type — the worker kept polling only the survivors (observed: 1 of 12 types)
  // until one of THEM got a job.
  await Effect.runPromise(
    Effect.gen(function* () {
      const calls: Record<string, number> = { down: 0, quiet: 0 };
      const engine = makeEngine({
        activate: (req) =>
          Effect.sleep(Duration.millis(100)).pipe(
            Effect.flatMap(() => {
              calls[req.type] = (calls[req.type] ?? 0) + 1;
              if (req.type === "down" && calls.down === 1) {
                return Effect.fail(new SupervisorError("fetch failed"));
              }
              if (req.type === "down") return Effect.succeed([job("J-down", "down")]);
              return Effect.succeed([]); // "quiet" long-polls forever, never gets a job
            }),
          ),
      });
      const errors: Array<[string, string, number]> = [];
      const fiber = yield* Effect.forkChild(
        activateWinner(
          engine,
          [
            { type: "down", freeSlots: 1 },
            { type: "quiet", freeSlots: 1 },
          ],
          { ...defaultActivationConfig, minEmptyPollIntervalMs: 0, errorBackoffInitialMs: 1_000 },
          (type, err, retryInMs) => errors.push([type, err.message, retryInMs]),
        ),
      );
      // t=100 the "down" poll fails; it must wait out its 1s backoff, then re-poll.
      yield* TestClock.adjust(Duration.millis(100));
      assert.deepEqual(errors, [["down", "fetch failed", 1_000]], "the failure is reported with its retry delay");
      yield* TestClock.adjust(Duration.millis(999));
      assert.equal(calls.down, 1, "no retry before the backoff elapses");
      yield* TestClock.adjust(Duration.millis(101));
      const winners = yield* Fiber.join(fiber);
      assert.deepEqual(
        winners.map((j) => j.jobKey),
        ["J-down"],
        "the failed type was re-polled and won the race",
      );
      assert.equal(calls.down, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("when every type's poll keeps failing the race does not fail fast: each type backs off (no hot loop on a dead engine)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine = makeEngine({
        activate: () =>
          Effect.suspend(() => {
            calls += 1;
            return Effect.fail(new SupervisorError("fetch failed"));
          }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 1 }], {
          ...defaultActivationConfig,
          errorBackoffInitialMs: 1_000,
          errorBackoffMaxMs: 4_000,
        }),
      );
      // Immediate failures at t=0, 1s, 3s, 7s, 11s, 15s (delays 1s, 2s, 4s, 4s, 4s).
      yield* TestClock.adjust(Duration.millis(15_000));
      assert.equal(calls, 6, "polled at a capped, backed-off rate rather than spinning");
      assert.equal(fiber.pollUnsafe(), undefined, "the race is still running, waiting for the engine");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("errorBackoffFor doubles per consecutive failure and is capped", () => {
  const cfg = { ...defaultActivationConfig, errorBackoffInitialMs: 1_000, errorBackoffMaxMs: 30_000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 100].map((n) => errorBackoffFor(n, cfg)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
});

test("an empty poll the engine answers immediately is spaced to minEmptyPollIntervalMs (no hot loop if long-polling stops)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine = makeEngine({
        activate: () =>
          Effect.sync(() => {
            calls += 1;
            return [];
          }),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 1 }], {
          ...defaultActivationConfig,
          minEmptyPollIntervalMs: 1_000,
        }),
      );
      yield* TestClock.adjust(Duration.millis(5_500));
      assert.equal(calls, 6, "one poll per second (t=0..5s), not a tight loop");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("a normal long-poll that outlasts minEmptyPollIntervalMs is re-issued immediately (no added latency)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const startedAt: number[] = [];
      let now = 0;
      const engine = makeEngine({
        activate: () =>
          Effect.sync(() => startedAt.push(now)).pipe(
            Effect.flatMap(() => Effect.sleep(Duration.millis(10_000))),
            Effect.map(() => {
              now += 10_000;
              return [];
            }),
          ),
      });
      const fiber = yield* Effect.forkChild(
        activateWinner(engine, [{ type: "a", freeSlots: 1 }], defaultActivationConfig),
      );
      yield* TestClock.adjust(Duration.millis(20_000));
      assert.deepEqual(startedAt, [0, 10_000, 20_000], "each poll starts the moment the previous one ends");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
