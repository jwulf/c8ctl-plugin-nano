import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { withAgenticConnection, type AgenticEndpoint } from "../src/agentic.ts";
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
      const used = yield* withAgenticConnection(endpoint, noopLogger, () => Effect.succeed("ok"), {
        reconnectBaseMs: 1,
        reconnectMaxMs: 10,
      });
      assert.equal(used, "ok");
      assert.equal(attempts, 2);
    }),
  );
});
