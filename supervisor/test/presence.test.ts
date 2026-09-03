import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { AgenticCapability, AgenticHandle, OwnershipFrames, SteerRoute } from "../src/agentic.ts";
import { makeOwnershipRegistry } from "../src/ownership.ts";
import {
  diffPresence,
  installSteerRoute,
  makePresenceSink,
  makeSteerRouter,
  projectPresence,
  projectPresenceStep,
  type PresenceSink,
} from "../src/presence.ts";
import { makeSupervisor } from "../src/supervisor.ts";
import { makeRegistry } from "../src/registry.ts";
import { noopLogger } from "../src/ports.ts";
import { makeReader, makeRunner, makeEngine } from "./fakes.ts";

// --- A recording fake transport implementing presence + steer. ---

interface PresenceLog {
  readonly frames: string[];
  readonly handle: AgenticHandle;
}

const recordingHandle = (
  opts: { steer?: (r: SteerRoute) => void } = {},
): PresenceLog => {
  const frames: string[] = [];
  const ok = (s: string) => Effect.sync(() => void frames.push(s));
  const proto: OwnershipFrames = {
    register: (instance, _c) => ok(`register:${instance}`),
    heartbeat: (instance) => ok(`heartbeat:${instance}`),
    claim: (instance, jobKey) => ok(`claim:${instance}:${jobKey}`),
    transcript: (instance, jobKey, _chunk) => ok(`transcript:${instance}:${jobKey}`),
    release: (instance, jobKey) => ok(`release:${instance}:${jobKey}`),
    deregister: (instance, _reason) => ok(`deregister:${instance}`),
  };
  const handle: AgenticHandle = {
    disconnect: Effect.void,
    ...proto,
    onSteer: (route) => Effect.sync(() => opts.steer?.(route)),
  };
  return { frames, handle };
};

const supervisedOf = (handle: AgenticHandle | null) => ({ currentHandle: Effect.succeed(handle) });

// --- Pure diff ---------------------------------------------------------------

test("diffPresence: newly-seen instances appear, still-seen heartbeat, gone ones depart", () => {
  const snapshot = [
    { instance: "w1", capability: {}, jobKeys: [] },
    { instance: "w2", capability: {}, jobKeys: [] },
  ];
  // First projection: nothing known yet → both appear, none present/depart.
  const first = diffPresence(new Set(), snapshot);
  assert.deepEqual(first.appeared.map((w) => w.instance).sort(), ["w1", "w2"]);
  assert.deepEqual(first.present, []);
  assert.deepEqual(first.departed, []);

  // Next projection with w2 gone and w3 added.
  const second = diffPresence(new Set(["w1", "w2"]), [
    { instance: "w1", capability: {}, jobKeys: [] },
    { instance: "w3", capability: {}, jobKeys: [] },
  ]);
  assert.deepEqual(second.appeared.map((w) => w.instance), ["w3"]);
  assert.deepEqual(second.present.map((w) => w.instance), ["w1"]);
  assert.deepEqual(second.departed, ["w2"]);
});

// --- Presence sink: best-effort wire mirror ----------------------------------

test("presence sink: emits register/heartbeat/deregister to the live handle", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const sink = makePresenceSink(supervisedOf(rec.handle));
      yield* sink.register("w1", { cognition: "senior" });
      yield* sink.heartbeat("w1");
      yield* sink.deregister("w1", "gone");
      assert.deepEqual(rec.frames, ["register:w1", "heartbeat:w1", "deregister:w1"]);
    }),
  );
});

test("presence sink: no live handle → no-op (registry, not the wire, is truth)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = makePresenceSink(supervisedOf(null));
      yield* sink.register("w1", {});
      yield* sink.heartbeat("w1"); // must not throw
    }),
  );
});

test("presence sink: a legacy endpoint without presence frames degrades to a no-op", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const legacy: AgenticHandle = { disconnect: Effect.void };
      const sink = makePresenceSink(supervisedOf(legacy));
      yield* sink.heartbeat("w1"); // no heartbeat frame on the handle → no-op
    }),
  );
});

// --- Projection step: register-then-heartbeat, deregister on departure -------

test("projectPresenceStep: first tick registers, subsequent ticks heartbeat, departure deregisters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const sink = makePresenceSink(supervisedOf(rec.handle));
      const knownRef = yield* Ref.make<ReadonlySet<string>>(new Set());

      yield* ownership.register("w1", { cognition: "senior" });
      yield* ownership.register("w2", { cognition: "junior" });

      yield* projectPresenceStep(ownership, sink, knownRef);
      assert.deepEqual(
        rec.frames.filter((f) => f.startsWith("register:")).sort(),
        ["register:w1", "register:w2"],
        "first tick registers both identities over one connection",
      );

      rec.frames.length = 0;
      yield* projectPresenceStep(ownership, sink, knownRef);
      assert.deepEqual(
        rec.frames.sort(),
        ["heartbeat:w1", "heartbeat:w2"],
        "second tick heartbeats known identities (no re-register)",
      );

      rec.frames.length = 0;
      yield* ownership.deregister("w2");
      yield* projectPresenceStep(ownership, sink, knownRef);
      assert.ok(rec.frames.includes("deregister:w2"), "a worker that left the registry is deregistered");
      assert.ok(rec.frames.includes("heartbeat:w1"), "the remaining worker keeps heartbeating");
      assert.ok(!rec.frames.includes("deregister:w1"));
    }),
  );
});

// --- Projection fiber over TestClock: N identities, one connection ----------

test("projectPresence: heartbeats every registered instance on the Schedule cadence", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const ownership = yield* makeOwnershipRegistry();
      const sink = makePresenceSink(supervisedOf(rec.handle));
      yield* ownership.register("w1", {});
      yield* ownership.register("w2", {});
      yield* ownership.register("w3", {});

      const fiber = yield* Effect.forkChild(projectPresence(ownership, sink, { heartbeatIntervalMs: 1_000 }));
      yield* TestClock.adjust(Duration.millis(1)); // first tick → register all three
      assert.deepEqual(
        rec.frames.filter((f) => f.startsWith("register:")).sort(),
        ["register:w1", "register:w2", "register:w3"],
        "three identities registered over a single connection",
      );

      rec.frames.length = 0;
      yield* TestClock.adjust(Duration.millis(1_000)); // one cadence later → heartbeat all three
      assert.deepEqual(
        rec.frames.filter((f) => f.startsWith("heartbeat:")).sort(),
        ["heartbeat:w1", "heartbeat:w2", "heartbeat:w3"],
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

// --- Steer router: per-instance isolation -----------------------------------

test("steer router: inbound frames route by instance and never cross", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* makeSteerRouter();
      const w1: string[] = [];
      const w2: string[] = [];
      yield* router.register("w1", (jobKey, chunk) => Effect.sync(() => void w1.push(`${jobKey}:${chunk.length}`)));
      yield* router.register("w2", (jobKey, chunk) => Effect.sync(() => void w2.push(`${jobKey}:${chunk.length}`)));

      yield* router.route("w1", "J1", new Uint8Array([1, 2, 3]));
      yield* router.route("w2", "J2", new Uint8Array([9]));
      yield* router.route("w1", "J1", new Uint8Array([7, 7]));

      assert.deepEqual(w1, ["J1:3", "J1:2"], "w1 only saw its own steer bytes");
      assert.deepEqual(w2, ["J2:1"], "w2 only saw its own steer bytes");

      // Unknown / unregistered instances are dropped, not misrouted.
      yield* router.route("ghost", "J9", new Uint8Array([0]));
      yield* router.unregister("w1");
      yield* router.route("w1", "J1", new Uint8Array([5]));
      assert.deepEqual(w1, ["J1:3", "J1:2"], "no frame delivered after unregister");
    }),
  );
});

test("installSteerRoute: wires the router's route into the handle's onSteer subscription", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let installed: SteerRoute | null = null;
      const rec = recordingHandle({ steer: (r) => (installed = r) });
      const router = yield* makeSteerRouter();
      const seen: string[] = [];
      yield* router.register("w1", (jobKey, chunk) => Effect.sync(() => void seen.push(`${jobKey}:${chunk.length}`)));

      yield* installSteerRoute(rec.handle, router);
      assert.notEqual(installed, null, "onSteer received the router route");
      yield* installed!("w1", "J1", new Uint8Array([1, 2]));
      assert.deepEqual(seen, ["J1:2"]);
    }),
  );
});

test("installSteerRoute: a legacy handle without onSteer degrades to a no-op", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const legacy: AgenticHandle = { disconnect: Effect.void };
      const router = yield* makeSteerRouter();
      yield* installSteerRoute(legacy, router); // must not throw
    }),
  );
});

// --- Integration: the supervisor projects presence over its agentic connection ---

test("supervisor: a registered worker is announced + heartbeated over the one supervised connection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const rec = recordingHandle();
      const engine = makeEngine({ activate: () => Effect.never as never });
      const runner = makeRunner(0);
      const reg = yield* makeRegistry();
      const reader = makeReader([[]], {});

      const sup = yield* makeSupervisor({
        engine,
        runner,
        registry: reg,
        reconcileReader: reader,
        scan: () => [],
        logger: noopLogger,
        agenticEndpoint: { connect: () => Effect.succeed(rec.handle) },
        agenticConfig: { reconnectBaseMs: 0, reconnectMaxMs: 10 },
        config: { presence: { heartbeatIntervalMs: 1_000 }, idleSpacingMs: 1_000 },
      });

      // Seed presence in the registry (what the plugin does when a worker starts).
      yield* sup.ownership.register("agent-1", { cognition: "senior", family: "copilot" });

      const fiber = yield* Effect.forkChild(sup.run);
      yield* TestClock.adjust(Duration.millis(1)); // connection establishes, first presence tick
      assert.ok(rec.frames.includes("register:agent-1"), "worker announced over the supervised connection");

      rec.frames.length = 0;
      yield* TestClock.adjust(Duration.millis(1_000)); // one cadence later
      assert.ok(rec.frames.includes("heartbeat:agent-1"), "worker heartbeated on the Schedule cadence");

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
