import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  addWorker,
  emptyRegistry,
  freeSlotsFor,
  makeRegistry,
  pickWorkerFor,
  serviceableTypes,
  typesWithCapacity,
} from "../src/registry.ts";

test("capability map: freeSlotsFor sums idle capacity over workers servicing a type", () => {
  let s = emptyRegistry;
  s = addWorker(s, "w1", ["a", "b"], 1);
  s = addWorker(s, "w2", ["b"], 2);
  assert.equal(freeSlotsFor(s, "a"), 1);
  assert.equal(freeSlotsFor(s, "b"), 3); // 1 from w1 + 2 from w2
  assert.equal(freeSlotsFor(s, "c"), 0);
  assert.deepEqual([...serviceableTypes(s)].sort(), ["a", "b"]);
});

test("typesWithCapacity omits a type whose workers are all busy (zero-activation backpressure)", () => {
  let s = emptyRegistry;
  s = addWorker(s, "w1", ["a"], 1);
  s = addWorker(s, "w2", ["b"], 1);
  // Both idle → both polled.
  assert.deepEqual([...typesWithCapacity(s)].sort(), ["a", "b"]);
  // Busy w1 → type "a" drops out of the poll set entirely.
  const busy = { workers: new Map(s.workers).set("w1", { ...s.workers.get("w1")!, active: 1 }) };
  assert.deepEqual(typesWithCapacity(busy), ["b"]);
});

test("pickWorkerFor returns an idle worker or null when all servicing workers are busy", () => {
  let s = emptyRegistry;
  s = addWorker(s, "w1", ["a"], 1);
  assert.equal(pickWorkerFor(s, "a"), "w1");
  const busy = { workers: new Map(s.workers).set("w1", { ...s.workers.get("w1")!, active: 1 }) };
  assert.equal(pickWorkerFor(busy, "a"), null);
});

test("Registry.claim is atomic: a second claim on a capacity-1 worker returns null", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const first = yield* reg.claim("a");
      const second = yield* reg.claim("a");
      assert.equal(first, "w1");
      assert.equal(second, null); // capacity exhausted — no double-lease
      // "a" is no longer a poll candidate while busy.
      assert.deepEqual(yield* reg.pollTypes, []);
      yield* reg.releaseWorker("w1");
      assert.deepEqual(yield* reg.pollTypes, ["a"]);
    }),
  );
});

test("setTypes rewrites an --auto worker's serviceable set (reconcile path)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const reg = yield* makeRegistry();
      yield* reg.add("auto", [], 1);
      assert.deepEqual(yield* reg.pollTypes, []);
      yield* reg.setTypes("auto", ["x", "y"]);
      assert.deepEqual([...(yield* reg.pollTypes)].sort(), ["x", "y"]);
    }),
  );
});
