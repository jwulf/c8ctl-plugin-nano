import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { defaultDispatchConfig, dispatch, isLeaseLostError, isPermanentRenewalError, isTerminalRenewalError } from "../src/dispatch.ts";
import { makeRegistry } from "../src/registry.ts";
import { noopLogger, SupervisorError } from "../src/ports.ts";
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

test("winner extend is lease-fenced: the job's activation leaseToken is threaded to extendLock", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = engineOk();
      const runner = makeRunner(0);
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      yield* dispatch(
        { engine, runner, registry: reg, logger: noopLogger, config: defaultDispatchConfig },
        job("J1", "a", "lease-J1"),
        worker!,
      );

      // The winner extend (invariant a) carries the activation lease so a superseded
      // worker's extend deterministically 409s instead of silently renewing a lock it lost.
      assert.ok(
        engine.extended.some((e) => e.jobKey === "J1" && e.leaseToken === "lease-J1"),
        "winner extend must thread job.leaseToken",
      );
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
          job("J1", "a", "lease-J1"),
          worker!,
        ),
      );

      yield* TestClock.adjust(Duration.millis(130_000)); // ~2 interval fires + first extends
      const j1Extends = engine.extended.filter((e) => e.jobKey === "J1");
      assert.ok(j1Extends.length >= 3, `expected repeated extends, got ${j1Extends.length}`);
      // Every extend — the winner AND each heartbeat beat — must carry the activation
      // lease so a superseded worker's renewal deterministically 409s; a regression
      // dropping job.leaseToken from the heartbeat path (not just the winner) fails here.
      assert.ok(
        j1Extends.every((e) => e.leaseToken === "lease-J1"),
        "every heartbeat extend must thread job.leaseToken",
      );

      yield* TestClock.adjust(Duration.millis(100_000)); // let the agent finish
      yield* Fiber.join(fiber);
      assert.deepEqual(yield* reg.pollTypes, ["a"], "slot released once the agent finished");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("heartbeat is UNKILLABLE: a defect in one beat does not stop lock renewal (retries next interval)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let beats = 0;
      const engine = makeEngine({
        activate: () => Effect.succeed([]),
        extend: () => {
          beats += 1;
          // The 3rd extend (2nd heartbeat beat; the 1st extend is the winner) dies
          // with a raw DEFECT — the deployed `Not a valid effect: [object Promise]`
          // class. A typed-only `Effect.catch` + fire-and-forget fork (the old code)
          // lets it escape and KILLS the heartbeat fiber → the lock lapses at the
          // window → the worker is superseded. It must instead be swallowed & retried.
          if (beats === 3) return Effect.sync(() => { throw new Error("Not a valid effect: [object Promise]"); });
          return Effect.void;
        },
      });
      const runner = makeRunner(400_000); // agent runs 400s, spanning many intervals
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

      yield* TestClock.adjust(Duration.millis(360_000)); // 6 beats fire; #3 defects
      const succeeded = engine.extended.filter((e) => e.jobKey === "J1").length;
      // Beats after the defect still landed → renewal survived the defect.
      assert.ok(succeeded >= 4, `heartbeat kept renewing after a defect; got ${succeeded} successful extends`);

      yield* TestClock.adjust(Duration.millis(100_000)); // let the agent finish
      const outcome = yield* Fiber.join(fiber);
      assert.equal(outcome.started, true);
      assert.equal(outcome.reason, undefined, "a transient defect is not a lease loss");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("lease lost mid-run: a definitive reclaim (409) on a heartbeat INTERRUPTS the agent instead of running to a doomed completion", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let extendCalls = 0;
      let finished = false;
      const engine = makeEngine({
        activate: () => Effect.succeed([]),
        extend: () => {
          extendCalls += 1;
          // Winner extend (call 1) succeeds so the agent STARTS; the first heartbeat
          // beat (call 2) then reports a definitive reclaim.
          return extendCalls === 1
            ? Effect.void
            : failing("extendLock J1: HTTP 409 from http://engine/v2/jobs/J1 — Job 17818 is not activated");
        },
      });
      // A long-running agent: if the lease-loss race works it is INTERRUPTED and
      // never records `finished`.
      const runner = {
        ran: [] as string[],
        run: (j: { jobKey: string }) =>
          Effect.sync(() => runner.ran.push(j.jobKey)).pipe(
            Effect.flatMap(() => Effect.sleep(Duration.millis(10_000_000))),
            Effect.flatMap(() => Effect.sync(() => { finished = true; })),
          ),
      };
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      const fiber = yield* Effect.forkChild(
        dispatch(
          { engine, runner, registry: reg, logger: noopLogger, config: { recoveryWindowMs: 300_000, extendIntervalMs: 60_000 } },
          job("J1", "a", "lease-J1"),
          worker!,
        ),
      );

      yield* TestClock.adjust(Duration.millis(60_000)); // first heartbeat beat → 409 lease-lost
      const outcome = yield* Fiber.join(fiber);

      assert.deepEqual(runner.ran, ["J1"], "agent started");
      assert.equal(finished, false, "agent was INTERRUPTED on lease loss, not run to completion");
      assert.equal(outcome.started, true);
      assert.equal(outcome.reason, "lock-lost");
      assert.deepEqual(yield* reg.pollTypes, ["a"], "slot released after the superseded run stopped");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("isLeaseLostError: definitive ownership-loss signals stop the heartbeat; transient blips do not", () => {
  const lost = [
    "extendLock J1: HTTP 409 from http://engine/v2/jobs/J1 — Job 5 is not activated",
    "extendLock J1: HTTP 404 from http://engine/v2/jobs/J1",
    "extendLock J1: SDK updateJob failed: JobLeaseMismatch",
    "extendLock J1: SDK updateJob failed: job not found",
  ];
  const transient = [
    "extendLock J1: HTTP 503 from http://engine/v2/jobs/J1 — engine unavailable",
    "extendLock J1: HTTP 500 from http://engine/v2/jobs/J1",
    "extendLock J1: SDK updateJob failed: ETIMEDOUT",
    "extendLock J1: SDK updateJob failed: fetch failed",
  ];
  for (const m of lost) assert.equal(isLeaseLostError(new SupervisorError(m)), true, m);
  for (const m of transient) assert.equal(isLeaseLostError(new SupervisorError(m)), false, m);
});

test("renewal permanently impossible mid-run: a persistent 401/403/400 on a heartbeat INTERRUPTS the agent (never retries forever into a reclaim)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let extendCalls = 0;
      let finished = false;
      const engine = makeEngine({
        activate: () => Effect.succeed([]),
        extend: () => {
          extendCalls += 1;
          // Winner extend (call 1) succeeds so the agent STARTS; every heartbeat
          // beat thereafter hits a permanent 403 that retrying can never fix. The
          // OLD behaviour swallowed this as "transient" and retried forever while
          // the lock lapsed → broker reclaim → duplicate run. It must now be
          // terminal and interrupt the agent.
          return extendCalls === 1
            ? Effect.void
            : failing("extendLock J1: HTTP 403 from http://engine/v2/jobs/J1 — forbidden");
        },
      });
      const runner = {
        ran: [] as string[],
        run: (j: { jobKey: string }) =>
          Effect.sync(() => runner.ran.push(j.jobKey)).pipe(
            Effect.flatMap(() => Effect.sleep(Duration.millis(10_000_000))),
            Effect.flatMap(() => Effect.sync(() => { finished = true; })),
          ),
      };
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      const fiber = yield* Effect.forkChild(
        dispatch(
          { engine, runner, registry: reg, logger: noopLogger, config: { recoveryWindowMs: 300_000, extendIntervalMs: 60_000 } },
          job("J1", "a", "lease-J1"),
          worker!,
        ),
      );

      yield* TestClock.adjust(Duration.millis(60_000)); // first heartbeat beat → permanent 403
      const outcome = yield* Fiber.join(fiber);

      assert.deepEqual(runner.ran, ["J1"], "agent started");
      assert.equal(finished, false, "agent was INTERRUPTED once renewal became impossible, not run to completion");
      assert.ok(extendCalls <= 2, `beat must not retry a permanent error forever; got ${extendCalls} extends`);
      assert.equal(outcome.started, true);
      assert.equal(outcome.reason, "lock-lost");
      assert.deepEqual(yield* reg.pollTypes, ["a"], "slot released after the unrenewable run stopped");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("isPermanentRenewalError / isTerminalRenewalError: permanent 4xx are terminal; 429 + 5xx stay transient", () => {
  const permanent = [
    "extendLock J1: HTTP 400 from http://engine/v2/jobs/J1 — bad request",
    "extendLock J1: HTTP 401 from http://engine/v2/jobs/J1 — unauthorized",
    "extendLock J1: HTTP 403 from http://engine/v2/jobs/J1 — forbidden",
    "extendLock J1: HTTP 422 from http://engine/v2/jobs/J1",
  ];
  const transient = [
    "extendLock J1: HTTP 429 from http://engine/v2/jobs/J1 — rate limited",
    "extendLock J1: HTTP 503 from http://engine/v2/jobs/J1 — engine unavailable",
    "extendLock J1: HTTP 500 from http://engine/v2/jobs/J1",
    "extendLock J1: SDK updateJob failed: ETIMEDOUT",
  ];
  for (const m of permanent) {
    assert.equal(isPermanentRenewalError(new SupervisorError(m)), true, m);
    assert.equal(isTerminalRenewalError(new SupervisorError(m)), true, m);
  }
  for (const m of transient) {
    assert.equal(isPermanentRenewalError(new SupervisorError(m)), false, m);
    assert.equal(isTerminalRenewalError(new SupervisorError(m)), false, m);
  }
  // A definitive lease-loss (409/404) is terminal but is NOT a "permanent renewal"
  // error — it is ownership loss, classified by isLeaseLostError.
  const leaseLost = new SupervisorError("extendLock J1: HTTP 409 from http://engine/v2/jobs/J1 — not activated");
  assert.equal(isPermanentRenewalError(leaseLost), false);
  assert.equal(isTerminalRenewalError(leaseLost), true);
});

test("ownership: the job is claimed for the child's whole run and released after (issue #158)", async () => {
  const { makeOwnershipRegistry, makeOwnershipContext } = await import("../src/ownership.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = engineOk();
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, { currentHandle: Effect.succeed(null) });
      const reg = yield* makeRegistry();
      yield* reg.add("w1", ["a"], 1);
      const worker = yield* reg.claim("a");

      // A runner that asserts, mid-run, that its job reads as claimed with zero
      // transcript output — the "green" acceptance for #158.
      let claimedDuringRun: readonly string[] = [];
      const runner = {
        ran: [] as string[],
        run: (j: { jobKey: string }) =>
          ownership.jobKeysFor("w1").pipe(
            Effect.tap((ks) => Effect.sync(() => {
              claimedDuringRun = ks;
              runner.ran.push(j.jobKey);
            })),
            Effect.asVoid,
          ),
      };

      yield* dispatch(
        { engine, runner, registry: reg, logger: noopLogger, config: defaultDispatchConfig, ownership: ctx },
        job("J1", "a"),
        worker!,
      );

      assert.deepEqual(claimedDuringRun, ["J1"], "claimed = working during the child's run");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), [], "released after the child exits");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
