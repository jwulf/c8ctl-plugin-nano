/**
 * Deterministic coverage for the concrete port-adapter lifts (issue #156).
 *
 * No engine, no sockets: a scriptable plain-async double stands in for the
 * monolith's raw clients so we assert the two behaviours that matter at the
 * seam — (1) a resolved promise passes its value straight through the Effect
 * port, and (2) a rejected promise is mapped into the ports' single tagged
 * {@link SupervisorError} (never a defect, never a raw Error), so the
 * supervisor's error channel stays closed and the activation race / dispatch
 * treat a transient edge failure as a handled outcome rather than a crash.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  asLogger,
  makeEngineClient,
  makeJobRunner,
  makeReconcileReader,
  makeSupervisorDeps,
  type RawEngineClient,
  type RawJobRunner,
  type RawReconcileReader,
} from "../src/adapters.ts";
import { makeRegistry } from "../src/registry.ts";
import { SupervisorError, noopLogger, type ActivatedJob, type Logger } from "../src/ports.ts";

/** Run an effect expected to FAIL and resolve with its error (E) for assertion. */
const errOf = <A, E>(eff: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(eff));

/** Settle stubs so a raw engine literal satisfies the extended RawEngineClient. */
const noSettle = { complete: async () => {}, fail: async () => {} } as const;

test("makeEngineClient: activate passes the job batch through", async () => {
  const seen: unknown[] = [];
  const raw: RawEngineClient = {
    activate: async (req) => {
      seen.push(req);
      return [{ jobKey: "j1", type: req.type }];
    },
    ...noSettle,
    extendLock: async () => {},
  };
  const engine = makeEngineClient(raw);
  const jobs = await Effect.runPromise(
    engine.activate({ type: "senior:plan", maxJobsToActivate: 3, requestTimeoutMs: 10, lockMs: 5 }),
  );
  assert.deepEqual(jobs, [{ jobKey: "j1", type: "senior:plan" }]);
  assert.deepEqual(seen, [
    { type: "senior:plan", maxJobsToActivate: 3, requestTimeoutMs: 10, lockMs: 5 },
  ]);
});

test("makeEngineClient: a rejected activate becomes a SupervisorError (not a defect)", async () => {
  const raw: RawEngineClient = {
    activate: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    ...noSettle,
    extendLock: async () => {},
  };
  const err = await errOf(
    makeEngineClient(raw).activate({
      type: "t",
      maxJobsToActivate: 1,
      requestTimeoutMs: 1,
      lockMs: 1,
    }),
  );
  assert.ok(err instanceof SupervisorError);
  assert.match(err.message, /ECONNREFUSED/);
});

test("makeEngineClient: extendLock resolves void and normalizes a non-void resolution", async () => {
  const calls: Array<{ jobKey: string; ms: number }> = [];
  const raw: RawEngineClient = {
    activate: async () => [],
    // Resolve a truthy non-void value to prove the lift normalizes to `void`.
    ...noSettle,
    extendLock: async (jobKey, ms) => {
      calls.push({ jobKey, ms });
      return "ok" as unknown as void;
    },
  };
  const out = await Effect.runPromise(makeEngineClient(raw).extendLock("j9", 300_000));
  assert.equal(out, undefined);
  assert.deepEqual(calls, [{ jobKey: "j9", ms: 300_000 }]);
});

test("makeEngineClient: a rejected extendLock becomes a SupervisorError", async () => {
  const raw: RawEngineClient = {
    activate: async () => [],
    ...noSettle,
    extendLock: async () => {
      throw new SupervisorError("HTTP 409 job reclaimed");
    },
  };
  const err = await errOf(makeEngineClient(raw).extendLock("j1", 1000));
  // A raw client that already threw a SupervisorError is passed through as-is.
  assert.ok(err instanceof SupervisorError);
  assert.equal(err.message, "HTTP 409 job reclaimed");
});

test("makeEngineClient: complete settles with result variables and normalizes to void", async () => {
  const calls: Array<{ jobKey: string; variables?: Record<string, unknown> }> = [];
  const raw: RawEngineClient = {
    activate: async () => [],
    extendLock: async () => {},
    // Resolve a truthy non-void value to prove the lift normalizes to `void`.
    complete: async (jobKey, variables) => {
      calls.push({ jobKey, variables });
      return "ok" as unknown as void;
    },
    fail: async () => {},
  };
  const out = await Effect.runPromise(makeEngineClient(raw).complete("j1", { status: "opened" }));
  assert.equal(out, undefined);
  assert.deepEqual(calls, [{ jobKey: "j1", variables: { status: "opened" } }]);
});

test("makeEngineClient: a rejected complete becomes a SupervisorError", async () => {
  const raw: RawEngineClient = {
    activate: async () => [],
    extendLock: async () => {},
    complete: async () => {
      throw new Error("HTTP 409 job already reclaimed");
    },
    fail: async () => {},
  };
  const err = await errOf(makeEngineClient(raw).complete("j1"));
  assert.ok(err instanceof SupervisorError);
  assert.match(err.message, /409/);
});

test("makeEngineClient: fail forwards retry/error options and maps a rejection", async () => {
  const calls: Array<{ jobKey: string; opts?: Record<string, unknown> }> = [];
  const raw: RawEngineClient = {
    activate: async () => [],
    extendLock: async () => {},
    complete: async () => {},
    fail: async (jobKey, opts) => {
      calls.push({ jobKey, opts });
    },
  };
  await Effect.runPromise(
    makeEngineClient(raw).fail("j2", { retries: 2, errorMessage: "boom", retryBackOff: 15_000 }),
  );
  assert.deepEqual(calls, [{ jobKey: "j2", opts: { retries: 2, errorMessage: "boom", retryBackOff: 15_000 } }]);

  const boom: RawEngineClient = {
    activate: async () => [],
    extendLock: async () => {},
    complete: async () => {},
    fail: async () => {
      throw new SupervisorError("HTTP 500 failure endpoint");
    },
  };
  const err = await errOf(makeEngineClient(boom).fail("j3", { retries: 0 }));
  assert.ok(err instanceof SupervisorError);
  assert.match(err.message, /500/);
});

test("makeReconcileReader: crawl passes keys + xml through, rejection maps to SupervisorError", async () => {
  const raw: RawReconcileReader = {
    searchProcessDefinitionKeys: async () => ["k1", "k2"],
    getProcessDefinitionXml: async (key) => (key === "k1" ? "<xml1/>" : ""),
  };
  const reader = makeReconcileReader(raw);
  assert.deepEqual(await Effect.runPromise(reader.searchProcessDefinitionKeys()), ["k1", "k2"]);
  assert.equal(await Effect.runPromise(reader.getProcessDefinitionXml("k1")), "<xml1/>");

  const boom: RawReconcileReader = {
    searchProcessDefinitionKeys: async () => {
      throw new Error("engine read timed out");
    },
    getProcessDefinitionXml: async () => "",
  };
  const err = await errOf(makeReconcileReader(boom).searchProcessDefinitionKeys());
  assert.ok(err instanceof SupervisorError);
  assert.match(err.message, /timed out/);
});

test("makeJobRunner: run resolves void; a rejection maps to SupervisorError", async () => {
  const ran: string[] = [];
  const raw: RawJobRunner = { run: async (j) => void ran.push(j.jobKey) };
  await Effect.runPromise(makeJobRunner(raw).run({ jobKey: "jr", type: "t" }));
  assert.deepEqual(ran, ["jr"]);

  const boom: RawJobRunner = {
    run: async () => {
      throw new Error("runAgentJob spawn failed");
    },
  };
  const err = await errOf(makeJobRunner(boom).run({ jobKey: "x", type: "t" }));
  assert.ok(err instanceof SupervisorError);
  assert.match(err.message, /spawn failed/);
});

test("asLogger: coerces a console-shaped object, defaults debug, falls back to noop", () => {
  const lines: string[] = [];
  const raw = { info: (m: string) => lines.push(`i:${m}`), warn: (m: string) => lines.push(`w:${m}`) };
  const logger = asLogger(raw);
  logger.info("a");
  logger.warn("b");
  logger.debug?.("c"); // no debug supplied → safe no-op
  assert.deepEqual(lines, ["i:a", "w:b"]);
  assert.equal(asLogger(null), noopLogger);
  assert.equal(asLogger({ info: () => {} } as Partial<Logger>), noopLogger); // missing warn
});

test("makeSupervisorDeps: omits absent optionals and normalizes the logger", async () => {
  const registry = await Effect.runPromise(makeRegistry());
  const engine = makeEngineClient({ ...noSettle, activate: async () => [], extendLock: async () => {} });
  const runner = makeJobRunner({ run: async () => {} });
  const reconcileReader = makeReconcileReader({
    searchProcessDefinitionKeys: async () => [],
    getProcessDefinitionXml: async () => "",
  });
  const scan = (_xml: string) => [] as ReadonlyArray<{ taskType: string; process: string }>;

  const bare = makeSupervisorDeps({ engine, runner, registry, reconcileReader, scan });
  assert.ok(!("autoWorkerId" in bare));
  assert.ok(!("agenticEndpoint" in bare));
  assert.ok(!("config" in bare));
  assert.equal(bare.logger, noopLogger); // no logger supplied → noop

  const full = makeSupervisorDeps({
    engine,
    runner,
    registry,
    reconcileReader,
    scan,
    logger: { info: () => {}, warn: () => {} },
    autoWorkerId: "host-1",
    config: { reconcileIntervalMs: 5_000 },
  });
  assert.equal(full.autoWorkerId, "host-1");
  assert.deepEqual(full.config, { reconcileIntervalMs: 5_000 });
  assert.notEqual(full.logger, noopLogger);
});

test("lifted ports drive makeRegistry-backed dispatch shape end to end", async () => {
  // A tiny sanity weave: the lifted engine's activate result is a plain
  // ActivatedJob[] the registry/dispatch layer consumes unchanged.
  const jobs: ActivatedJob[] = [{ jobKey: "e2e", type: "senior:plan" }];
  const engine = makeEngineClient({ ...noSettle, activate: async () => jobs, extendLock: async () => {} });
  const got = await Effect.runPromise(
    engine.activate({ type: "senior:plan", maxJobsToActivate: 1, requestTimeoutMs: 1, lockMs: 1 }),
  );
  assert.deepEqual(got, jobs);
});
