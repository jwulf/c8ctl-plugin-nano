import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { superviseAgentic, withAgenticConnection, type AgenticEndpoint, type AgenticHandle } from "../src/agentic.ts";
import { noopLogger, SupervisorError } from "../src/ports.ts";

test("agentic connection is torn down on interruption (finalizer runs on SIGTERM-style interrupt)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events: string[] = [];
      const endpoint: AgenticEndpoint = {
        connect: () =>
          Effect.sync(() => {
            events.push("connect");
            return { disconnect: Effect.sync(() => void events.push("disconnect")) };
          }),
      };

      // `use` blocks forever until the fiber is interrupted.
      const fiber = yield* Effect.forkChild(
        withAgenticConnection(endpoint, noopLogger, () => Effect.never),
      );
      // Let the connection establish, then interrupt (models supervisor SIGTERM).
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      assert.deepEqual(events, ["connect", "disconnect"], "teardown ran exactly once on interruption");
    }),
  );
});

test("agentic connection is torn down when `use` fails", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events: string[] = [];
      const endpoint: AgenticEndpoint = {
        connect: () =>
          Effect.sync(() => {
            events.push("connect");
            return { disconnect: Effect.sync(() => void events.push("disconnect")) };
          }),
      };
      const exit = yield* withAgenticConnection(endpoint, noopLogger, () =>
        Effect.fail(new SupervisorError("boom")),
      ).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(events, ["connect", "disconnect"]);
    }),
  );
});

test("connect is retried on transient failure, then the connection is used", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      const endpoint: AgenticEndpoint = {
        connect: () =>
          Effect.suspend(() => {
            attempts += 1;
            if (attempts < 2) return Effect.fail(new SupervisorError("refused"));
            return Effect.succeed({ disconnect: Effect.void });
          }),
      };
      // Zero base delay keeps the retry path deterministic and wall-clock free:
      // Schedule.exponential(0) yields 0ms delays (jitter*0 == 0), so the retry
      // fires instantly under the live Clock without any real sleeping.
      const used = yield* withAgenticConnection(endpoint, noopLogger, () => Effect.succeed("ok"), {
        reconnectBaseMs: 0,
        reconnectMaxMs: 10,
      });
      assert.equal(used, "ok");
      assert.equal(attempts, 2);
    }),
  );
});

test("superviseAgentic re-runs resync on a mid-life reconnect before resuming work", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const established: string[] = [];
      const handleRef = yield* Ref.make<AgenticHandle | null>(null);
      const drop1 = yield* Deferred.make<void>();
      const secondUp = yield* Deferred.make<void>();
      let connects = 0;

      const endpoint: AgenticEndpoint = {
        connect: () =>
          Effect.sync(() => {
            connects += 1;
            // Connection #1 drops when `drop1` fires; #2 stays up forever.
            const closed = connects === 1 ? Deferred.await(drop1) : Effect.never;
            return { disconnect: Effect.void, closed } satisfies AgenticHandle;
          }),
      };

      // The resync hook: records each (re)connect and, on the first, triggers the
      // mid-life drop so the loop must reconnect and resync a second time.
      const onEstablished = (_handle: AgenticHandle) =>
        Effect.sync(() => established.push(`resync#${established.length + 1}`)).pipe(
          Effect.flatMap(() =>
            established.length === 1 ? Deferred.succeed(drop1, void 0) : Deferred.succeed(secondUp, void 0),
          ),
        );

      // Work resumes only once the *second* connection is established + resynced.
      const use = Deferred.await(secondUp).pipe(Effect.as("resumed"));

      const result = yield* superviseAgentic(endpoint, noopLogger, handleRef, onEstablished, use, {
        reconnectBaseMs: 0,
        reconnectMaxMs: 10,
      });

      assert.equal(result, "resumed");
      assert.equal(connects, 2, "reconnected exactly once after the drop");
      assert.deepEqual(established, ["resync#1", "resync#2"], "resync replayed on every (re)connect");
    }),
  );
});

test("superviseAgentic publishes the live handle and tears it down when work finishes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events: string[] = [];
      const handleRef = yield* Ref.make<AgenticHandle | null>(null);
      const up = yield* Deferred.make<void>();
      const down = yield* Deferred.make<void>();
      const endpoint: AgenticEndpoint = {
        connect: () =>
          Effect.sync(() => {
            events.push("connect");
            return {
              disconnect: Effect.sync(() => void events.push("disconnect")).pipe(
                Effect.flatMap(() => Deferred.succeed(down, void 0)),
                Effect.asVoid,
              ),
            };
          }),
      };
      // Resume only after the connection is established, so reading the slot is
      // deterministic (not racing the connect).
      const use = Deferred.await(up).pipe(
        Effect.flatMap(() => Ref.get(handleRef)),
        Effect.map((h) => {
          assert.notEqual(h, null, "current handle published to the slot");
          return "ok";
        }),
      );
      const out = yield* superviseAgentic(endpoint, noopLogger, handleRef, () => Deferred.succeed(up, void 0).pipe(Effect.asVoid), use, {
        reconnectBaseMs: 0,
        reconnectMaxMs: 10,
      });
      assert.equal(out, "ok");
      // The supervision fiber is interrupted once work finishes — await its
      // teardown finalizer rather than assuming the race returns after it.
      yield* Deferred.await(down);
      assert.deepEqual(events, ["connect", "disconnect"]);
      assert.equal(yield* Ref.get(handleRef), null, "slot cleared on teardown");
    }),
  );
});
