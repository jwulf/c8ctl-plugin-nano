import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import type { AgenticCapability } from "../src/agentic.ts";
import { makeAgenticEndpoint, type RawEmitClient } from "../src/emit.ts";

/**
 * A scriptable {@link RawEmitClient} double: records every emitted frame, lets a
 * test drive the connection lifecycle (open / drop) deterministically, and can
 * be told to reject sends (models a not-open transport throwing synchronously).
 */
interface EmittedFrame {
  readonly kind: string;
  readonly instance: string;
  readonly arg?: unknown;
  readonly chunk?: Uint8Array;
}

class FakeRawClient implements RawEmitClient {
  readonly frames: EmittedFrame[] = [];
  readonly steered: Array<{ instance: string; jobKey: string; chunk: Uint8Array }> = [];
  closedByCaller = false;
  throwOnSend = false;
  private openCb?: () => void;
  private closeCb?: () => void;
  private steerCb?: (instance: string, jobKey: string, chunk: Uint8Array) => void;

  readonly supportsClaimRelease: boolean;
  readonly supportsSteer: boolean;
  constructor(supportsClaimRelease: boolean = true, supportsSteer: boolean = true) {
    this.supportsClaimRelease = supportsClaimRelease;
    this.supportsSteer = supportsSteer;
  }

  private push(frame: EmittedFrame): void {
    if (this.throwOnSend) throw new Error("transport not open");
    this.frames.push(frame);
  }
  register(instance: string, capability: AgenticCapability): void {
    this.push({ kind: "register", instance, arg: capability });
  }
  heartbeat(instance: string): void {
    this.push({ kind: "heartbeat", instance });
  }
  deregister(instance: string, reason?: string): void {
    this.push({ kind: "deregister", instance, arg: reason });
  }
  claim(instance: string, jobKey: string): void {
    this.push({ kind: "claim", instance, arg: jobKey });
  }
  release(instance: string, jobKey: string): void {
    this.push({ kind: "release", instance, arg: jobKey });
  }
  transcript(instance: string, jobKey: string, chunk: Uint8Array): void {
    this.push({ kind: "transcript", instance, arg: jobKey, chunk });
  }
  onSteer(route: (instance: string, jobKey: string, chunk: Uint8Array) => void): void {
    this.steerCb = route;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closedByCaller = true;
  }
  // ---- test drivers ----
  fireOpen(): void {
    this.openCb?.();
  }
  drop(): void {
    this.closeCb?.();
  }
  deliverSteer(instance: string, jobKey: string, chunk: Uint8Array): void {
    this.steerCb?.(instance, jobKey, chunk);
  }
}

test("connect resolves only once the socket opens, then emits per-instance frames", async () => {
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      // The connect Effect blocks until the socket opens.
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      assert.equal(raw.frames.length, 0, "no frame before open");
      raw.fireOpen();
      const handle = yield* Fiber.join(fiber);

      // Every frame carries its instance EXPLICITLY — one connection, N workers.
      yield* handle.register!("worker-a", { cognition: "senior" });
      yield* handle.register!("worker-b", { cognition: "junior" });
      yield* handle.claim!("worker-a", "job-1");
      yield* handle.transcript!("worker-b", "job-2", new Uint8Array([1, 2, 3]));
      yield* handle.heartbeat!("worker-a");
      yield* handle.release!("worker-a", "job-1");
      yield* handle.deregister!("worker-b", "left");

      assert.deepEqual(
        raw.frames.map((f) => `${f.kind}:${f.instance}`),
        [
          "register:worker-a",
          "register:worker-b",
          "claim:worker-a",
          "transcript:worker-b",
          "heartbeat:worker-a",
          "release:worker-a",
          "deregister:worker-b",
        ],
      );
      assert.deepEqual([...raw.frames[3]!.chunk!], [1, 2, 3]);
    }),
  );
});

test("disconnect closes the raw client; a mid-life drop completes `closed`", async () => {
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.fireOpen();
      const handle = yield* Fiber.join(fiber);

      // `closed` is pending while the socket is live…
      const closedFiber = yield* Effect.forkChild(handle.closed!);
      yield* Effect.yieldNow;
      assert.equal(raw.closedByCaller, false);

      // …and completes on a remote drop (drives superviseAgentic's reconnect).
      raw.drop();
      yield* Fiber.join(closedFiber);

      yield* handle.disconnect;
      assert.equal(raw.closedByCaller, true, "disconnect tore the connection down");
    }),
  );
});

test("connect fails when the socket closes before it opens (superviseAgentic then retries)", async () => {
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.drop(); // close before any open
      return yield* Fiber.join(fiber).pipe(
        Effect.map(() => "opened"),
        Effect.catch((err) => Effect.succeed(err.message)),
      );
    }),
  );
  assert.match(result, /closed before it opened/);
});

test("a raw send that never opens is torn down when the connect is INTERRUPTED", async () => {
  // Regression (worker drain wedge): the raw emit client is built — and its
  // internal reconnect timers/sockets started (`client.open()`) — BEFORE the
  // socket opens. When the hub is unreachable it never fires onOpen (and a
  // transient drop just reconnects internally, never firing the single-shot
  // onClose), so `connect` blocks on `opened` forever. If the supervisor fiber
  // is then interrupted (SIGUSR2 drain / SIGTERM abort), `connect` must close
  // the half-open raw client it created; otherwise its live timers keep the
  // worker process alive after teardown and the daemon's drain wedges (0
  // in-flight jobs, yet the child never exits).
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow; // let connect build the raw client and park on `opened`
      assert.equal(raw.closedByCaller, false, "not closed while connecting");
      // Interrupt before any open ever fires (the unreachable-hub case).
      yield* Fiber.interrupt(fiber);
      assert.equal(
        raw.closedByCaller,
        true,
        "an interrupted connect must close the half-open raw client it created",
      );
    }),
  );
});

test("connect closes the raw client when the socket closes before it opens", async () => {
  // The fail-before-open path must ALSO tear the half-open client down (same
  // leak as the interrupt case): `superviseAgentic` retries `connect`, so a
  // leaked client per failed attempt would pile up live sockets/timers.
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.drop(); // close before any open → connect fails
      yield* Fiber.join(fiber).pipe(Effect.catch(() => Effect.void));
      assert.equal(raw.closedByCaller, true, "a connect that fails before open closes the client");
    }),
  );
});

test("a raw send failure surfaces as a SupervisorError the caller can swallow", async () => {
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.fireOpen();
      const handle = yield* Fiber.join(fiber);

      raw.throwOnSend = true;
      const outcome = yield* handle
        .register!("w", {})
        .pipe(Effect.map(() => "ok"), Effect.catch((e) => Effect.succeed(`err:${e._tag}`)));
      assert.equal(outcome, "err:SupervisorError");
    }),
  );
});

test("claim/release and steer are OMITTED when the negotiated protocol lacks them", async () => {
  const raw = new FakeRawClient(false, false);
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.fireOpen();
      const handle = yield* Fiber.join(fiber);

      // Additive degradation: the methods are absent, so `emitFrame` no-ops them.
      assert.equal(handle.claim, undefined);
      assert.equal(handle.release, undefined);
      assert.equal(handle.onSteer, undefined);
      // Presence frames still work against a legacy hub.
      assert.notEqual(handle.register, undefined);
      yield* handle.register!("w", {});
      assert.equal(raw.frames.length, 1);
    }),
  );
});

test("onSteer forks the inbound route so a delivered steer frame reaches its sink", async () => {
  const raw = new FakeRawClient();
  const endpoint = makeAgenticEndpoint(() => raw);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(endpoint.connect());
      yield* Effect.yieldNow;
      raw.fireOpen();
      const handle = yield* Fiber.join(fiber);

      const seen = yield* Deferred.make<{ instance: string; jobKey: string; bytes: number }>();
      yield* handle.onSteer!((instance, jobKey, chunk) =>
        Deferred.succeed(seen, { instance, jobKey, bytes: chunk.length }).pipe(Effect.asVoid),
      );

      raw.deliverSteer("worker-a", "job-9", new Uint8Array([7, 7]));
      const got = yield* Deferred.await(seen);
      assert.deepEqual(got, { instance: "worker-a", jobKey: "job-9", bytes: 2 });
    }),
  );
});
