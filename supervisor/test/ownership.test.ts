import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Ref } from "effect";
import type { AgenticCapability, AgenticHandle, OwnershipFrames } from "../src/agentic.ts";
import {
  claimJob,
  deregisterWorker,
  emptyOwnership,
  jobKeysForInstance,
  makeOwnershipContext,
  makeOwnershipRegistry,
  registerWorker,
  releaseJob,
  resyncOwnership,
  snapshotOwnership,
  withOwnedJob,
} from "../src/ownership.ts";
import { SupervisorError } from "../src/ports.ts";

// --- A recording fake transport implementing the full ownership protocol. ---

interface FrameLog {
  readonly frames: string[];
  readonly handle: AgenticHandle;
}

const recordingHandle = (opts: { failClaim?: boolean; closed?: Effect.Effect<void> } = {}): FrameLog => {
  const frames: string[] = [];
  const ok = (s: string) => Effect.sync(() => void frames.push(s));
  const proto: OwnershipFrames = {
    register: (instance) => ok(`register:${instance}`),
    claim: (instance, jobKey) =>
      opts.failClaim
        ? Effect.fail(new SupervisorError("claim wire down"))
        : ok(`claim:${instance}:${jobKey}`),
    transcript: (instance, jobKey) => ok(`transcript:${instance}:${jobKey}`),
    release: (instance, jobKey) => ok(`release:${instance}:${jobKey}`),
  };
  return { frames, handle: { disconnect: Effect.void, closed: opts.closed, ...proto } };
};

const supervisedOf = (handle: AgenticHandle | null) => ({ currentHandle: Effect.succeed(handle) });

// --- Pure transitions ---------------------------------------------------------

test("pure: claim/release are idempotent and register preserves existing claims", () => {
  let s = registerWorker(emptyOwnership, "w1", { cognition: "senior" });
  s = claimJob(s, "w1", "J1");
  s = claimJob(s, "w1", "J1"); // duplicate claim — no-op
  s = claimJob(s, "w1", "J2");
  assert.deepEqual([...jobKeysForInstance(s, "w1")].sort(), ["J1", "J2"]);

  // re-register keeps the live jobKeys (presence refresh must not drop ownership)
  s = registerWorker(s, "w1", { cognition: "senior", weight: 2 });
  assert.deepEqual([...jobKeysForInstance(s, "w1")].sort(), ["J1", "J2"]);

  s = releaseJob(s, "w1", "J1");
  s = releaseJob(s, "w1", "J1"); // duplicate release — no-op
  assert.deepEqual(jobKeysForInstance(s, "w1"), ["J2"]);

  const snap = snapshotOwnership(s);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.instance, "w1");
  assert.equal((snap[0]!.capability as AgenticCapability).weight, 2);
});

test("pure: claim auto-registers an unseen instance so ordering can't lose a claim", () => {
  const s = claimJob(emptyOwnership, "w9", "J5");
  assert.deepEqual(jobKeysForInstance(s, "w9"), ["J5"]);
});

test("pure: deregister drops the worker and its claims", () => {
  let s = claimJob(registerWorker(emptyOwnership, "w1", {}), "w1", "J1");
  s = deregisterWorker(s, "w1");
  assert.deepEqual(snapshotOwnership(s), []);
});

// --- Ref-backed registry + context + frame mirroring --------------------------

test("context: claim/release update the registry (source of truth) AND mirror to the live handle", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(rec.handle));

      yield* ctx.register("w1", { cognition: "senior" });
      yield* ctx.claim("w1", "J1");
      // Registry is the truth: the job is owned even before any transcript.
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), ["J1"]);
      // And the wire mirrored it.
      assert.deepEqual(rec.frames, ["register:w1", "claim:w1:J1"]);

      yield* ctx.release("w1", "J1");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), []);
      assert.equal(rec.frames.at(-1), "release:w1:J1");
    }),
  );
});

test("context: a wire failure never corrupts the registry (best-effort mirror)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle({ failClaim: true });
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(rec.handle));

      // Claim frame fails on the wire, but the local registry still records it.
      yield* ctx.claim("w1", "J1");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), ["J1"]);
    }),
  );
});

test("context: with no live handle (dropped connection) the registry still records ownership", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(null));
      yield* ctx.claim("w1", "J1");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), ["J1"]);
    }),
  );
});

test("context: an endpoint without ownership frames (pre-#158) degrades to a no-op mirror", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const legacy: AgenticHandle = { disconnect: Effect.void }; // no register/claim/…
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(legacy));
      yield* ctx.claim("w1", "J1"); // must not throw
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), ["J1"]);
    }),
  );
});

// --- withOwnedJob: claim lifetime == child lifetime ---------------------------

test("withOwnedJob: claim held for the child's whole life; released on normal exit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(rec.handle));

      const seen: ReadonlyArray<string>[] = [];
      yield* withOwnedJob(
        ctx,
        "w1",
        "J1",
        // While the "child" runs, the job reads as claimed with ZERO transcript.
        ownership.jobKeysFor("w1").pipe(Effect.tap((ks) => Effect.sync(() => seen.push(ks)))),
      );
      assert.deepEqual(seen[0], ["J1"], "claimed = working, even with no transcript output");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), [], "released after child exit");
      assert.deepEqual(rec.frames, ["claim:w1:J1", "release:w1:J1"]);
    }),
  );
});

test("withOwnedJob: an unclean kill (interrupt) still releases the claim — no leak", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(rec.handle));

      const gate = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        withOwnedJob(ctx, "w1", "J1", Deferred.succeed(gate, void 0).pipe(Effect.flatMap(() => Effect.never))),
      );
      yield* Deferred.await(gate); // ensure the claim has been taken and the child is live
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), ["J1"]);

      yield* Fiber.interrupt(fiber); // SIGTERM-style unclean kill
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), [], "jobKey cleared on interruption");
      assert.equal(rec.frames.at(-1), "release:w1:J1");
    }),
  );
});

test("withOwnedJob: the claim fails the run through (release still fires) on child failure", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const ctx = makeOwnershipContext(ownership, supervisedOf(rec.handle));

      const exit = yield* withOwnedJob(
        ctx,
        "w1",
        "J1",
        Effect.fail(new SupervisorError("child crashed")),
      ).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(yield* ownership.jobKeysFor("w1"), [], "released on failure too");
      assert.equal(rec.frames.at(-1), "release:w1:J1");
    }),
  );
});

// --- resyncOwnership: replay the full active-claim set ------------------------

test("resyncOwnership: re-registers every worker then re-claims each active job", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ownership = yield* makeOwnershipRegistry();
      yield* ownership.register("w1", { cognition: "senior" });
      yield* ownership.register("w2", { cognition: "junior" });
      yield* ownership.claim("w1", "J1");
      yield* ownership.claim("w1", "J2");
      yield* ownership.claim("w2", "J3");

      const rec = recordingHandle();
      yield* resyncOwnership(rec.handle, ownership);

      // Every worker re-registered; every active job re-claimed. Register for a
      // worker precedes its claims (a claim must land on a known instance).
      assert.ok(rec.frames.includes("register:w1"));
      assert.ok(rec.frames.includes("register:w2"));
      assert.ok(rec.frames.indexOf("register:w1") < rec.frames.indexOf("claim:w1:J1"));
      assert.deepEqual(
        rec.frames.filter((f) => f.startsWith("claim:")).sort(),
        ["claim:w1:J1", "claim:w1:J2", "claim:w2:J3"],
      );
    }),
  );
});
