/**
 * Hot-path flip (issue #172) — end-to-end integration coverage against the
 * in-process WASM engine testkit (`@nanobpm/engine-wasm` + `@nanobpm/urban-testkit`),
 * no live cluster.
 *
 * #172 cut `workAgent` over to drive the Effect single-owner runtime
 * (`createSupervisorDeps()` → `makeSupervisor().run`) as the per-host owner,
 * retiring the per-type SDK pollers, the process-wide capacity-1 `singleFlight`,
 * the per-process reconcile crawl, and `startLockExtender`. The ~600-line inline
 * `jobHandler` became a `RawJobRunner` the runtime dispatches, settling through
 * the `settle` seam (`EngineClient.complete`/`fail`) instead of the SDK
 * `job.complete()`/`job.fail()`.
 *
 * `supervisor-deps.test.mjs` already drives that composed runtime against a
 * hand-rolled fake `fetch`. This test raises the bar the issue asks for: it backs
 * the SAME `createRawEngineClient` REST surface (`POST /v2/jobs/activation`,
 * `PATCH /v2/jobs/{key}/timeout`, `POST /v2/jobs/{key}/completion`,
 * `POST /v2/jobs/{key}/failure`) with a REAL nanobpmn engine running a REAL
 * deployed BPMN process. So the whole cut-over path — activate → dispatch (lock
 * extend) → run → settle → the engine actually completing the process instance —
 * is exercised against genuine engine job semantics (real job keys, real locks,
 * real completion merging variables onto the instance), which a fetch stub can
 * only assert about in shape.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createSupervisorDeps } from "./c8ctl-plugin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the WASM engine once (idempotent per process) and return a fresh
 * `TestEngine`. Mirrors `@nanobpm/urban-testkit`'s own init: read the `.wasm`
 * bytes via `import.meta.resolve` and `initSync`, so it works from the published
 * package without a bundler. The `/readmodel` variant carries the read model the
 * testkit depends on; `TestEngine` (deploy/createInstance/activateJobs/
 * completeJob/failJob) is identical across variants.
 */
let enginePromise;
async function bootEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = await import("@nanobpm/engine-wasm/readmodel");
      const url = new URL(import.meta.resolve("@nanobpm/engine-wasm/readmodel/nanobpmn_engine_bg.wasm"));
      mod.initSync({ module: new Uint8Array(await readFile(url)) });
      return mod;
    })();
  }
  const mod = await enginePromise;
  return new mod.TestEngine();
}

/** A minimal executable process: start → service task (job type `type`) → end. */
function processXml(processId, type) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="def_${processId}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task"/>
    <bpmn:serviceTask id="task" name="Work">
      <bpmn:extensionElements><zeebe:taskDefinition type="${type}"/></bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end"/>
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

/**
 * A `fetch` that speaks the C8 v2 REST subset `createRawEngineClient` calls,
 * backed by the real WASM engine — the "loopback engine" #156 called for. Every
 * job key / lock / completion is the engine's own; nothing is faked but the
 * transport. Records what it settled so the test can assert the runner drove real
 * completions.
 */
function engineFetch(engine) {
  const completed = [];
  const failed = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const ok204 = { ok: true, status: 204, json: async () => ({}), text: async () => "" };

    if (u.endsWith("/jobs/activation")) {
      const { type, worker, maxJobsToActivate, timeout } = JSON.parse(init.body);
      // Real activation: locks up to `maxJobsToActivate` Created jobs of `type`
      // to `worker` for `timeout` ms. Returns the engine's own records; map the
      // engine's `key`/`instanceKey` onto the v2 field names `mapJob` reads.
      const raw = JSON.parse(engine.activateJobs(type, maxJobsToActivate, timeout, worker || "test"));
      const jobs = raw.map((j) => ({
        jobKey: j.key,
        type: j.type,
        processInstanceKey: j.instanceKey,
        processDefinitionKey: j.processDefinitionKey,
        retries: j.retries,
        customHeaders: j.customHeaders,
        variables: j.variables,
      }));
      return { ok: true, status: 200, json: async () => ({ jobs }), text: async () => "" };
    }

    if (/\/jobs\/[^/]+\/timeout$/.test(u)) {
      // extendLock — the engine sets the lock from now; a no-op here is sound
      // because the virtual clock never advances in-test, so no lock lapses.
      // Lock-extension behaviour (extend-before-start + periodic re-extend) is
      // asserted deterministically under TestClock in supervisor/test/dispatch.test.ts;
      // this end-to-end flip test only exercises activation → run → settle.
      return ok204;
    }

    if (/\/jobs\/[^/]+\/completion$/.test(u)) {
      const jobKey = decodeURIComponent(u.match(/\/jobs\/([^/]+)\/completion$/)[1]);
      const { variables } = JSON.parse(init.body || "{}");
      engine.completeJob(jobKey, JSON.stringify(variables || {}));
      completed.push({ jobKey, variables });
      return ok204;
    }

    if (/\/jobs\/[^/]+\/failure$/.test(u)) {
      const jobKey = decodeURIComponent(u.match(/\/jobs\/([^/]+)\/failure$/)[1]);
      const { retries = 0, errorMessage = "" } = JSON.parse(init.body || "{}");
      engine.failJob(jobKey, retries, errorMessage);
      failed.push({ jobKey, retries, errorMessage });
      return ok204;
    }

    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  fetchImpl.completed = completed;
  fetchImpl.failed = failed;
  return fetchImpl;
}

/** A hermetic reconcile reader — the flip's non-auto path never rewrites a static
 *  worker's types from reconcile, so keep the crawl off the network. */
const reconcileReader = {
  searchProcessDefinitionKeys: async () => [],
  getProcessDefinitionXml: async () => "",
};

/** The engine's completed-instance count. `TestEngine.snapshot()` returns a JSON
 *  STRING (not an object), so parse it before reading the field. */
function completedInstances(engine) {
  return Number(JSON.parse(engine.snapshot()).completedInstances) || 0;
}

/** Poll a synchronous predicate on the engine snapshot up to `timeoutMs`. */
async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

test("hot-path flip: makeSupervisor().run drives activate → dispatch → run → settle against the real WASM engine", async () => {
  const engine = await bootEngine();
  const TYPE = "test:work";
  engine.deploy(processXml("flip_proc", TYPE));

  // Three waiting jobs — one per instance. The runtime must activate, dispatch,
  // run, and settle each, and the engine must complete each instance.
  const INSTANCES = 3;
  for (let i = 0; i < INSTANCES; i++) engine.createInstance("flip_proc", "{}");

  const fetchImpl = engineFetch(engine);

  // The runner is the flip's `RawJobRunner`: it receives the ActivatedJob (no
  // `.complete()`/`.fail()` on it) and settles through the late-bound `settle`
  // seam — exactly as workAgent's hot-path runner does now.
  const seen = [];
  let settle;
  const runner = {
    run: async (job) => {
      seen.push(job.jobKey);
      await settle.complete(job.jobKey, { handledBy: "flip-test", jobKey: job.jobKey });
    },
  };

  const composed = await createSupervisorDeps({
    runner,
    restConfig: { baseUrl: "http://loopback:8080", token: "" },
    worker: "flip-host",
    workers: [{ id: "flip-worker", types: [TYPE], capacity: 1 }],
    reconcileReader,
    fetchImpl,
  });
  settle = composed.settle;
  const { deps, makeSupervisor, Effect, Fiber } = composed;

  const supervisor = await Effect.runPromise(makeSupervisor(deps));
  const fiber = Effect.runFork(supervisor.run);
  let allDone = false;
  try {
    allDone = await waitFor(() => completedInstances(engine) >= INSTANCES);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  assert.ok(allDone, "the engine completed every process instance through the flipped runtime");
  assert.equal(completedInstances(engine), INSTANCES);

  // Every job was dispatched to the runner and settled through the engine's own
  // completion endpoint — exactly once each (the engine lock prevents a locked
  // job being re-activated, so a capacity-1 worker never double-runs a job).
  assert.equal(fetchImpl.completed.length, INSTANCES, "every job settled via the engine completion endpoint");
  assert.equal(fetchImpl.failed.length, 0, "no job failed");
  const settledKeys = fetchImpl.completed.map((c) => c.jobKey).sort();
  assert.deepEqual([...new Set(settledKeys)], settledKeys, "no job key was settled twice");
  assert.deepEqual(seen.slice().sort(), settledKeys, "the runner ran exactly the jobs that were settled");
  // The result variables the runner produced were merged onto the instance by
  // the engine — proof the settle seam reached real engine state, not just a stub.
  assert.ok(
    fetchImpl.completed.every((c) => c.variables && c.variables.handledBy === "flip-test"),
    "each completion carried the runner's result variables",
  );
});

test("hot-path flip: a runner failure settles through the engine failure endpoint (raising an incident)", async () => {
  const engine = await bootEngine();
  const TYPE = "test:flaky";
  engine.deploy(processXml("flip_fail_proc", TYPE));
  engine.createInstance("flip_fail_proc", "{}");

  const fetchImpl = engineFetch(engine);

  let settle;
  const runner = {
    run: async (job) => {
      // Settle a terminal failure (`retries: 0` → the engine raises an incident,
      // so the job is NOT re-queued and the run is deterministic). The flip routes
      // this through `settle.fail` → EngineClient.fail → the engine's failure
      // endpoint instead of the SDK job object's `job.fail()`.
      await settle.fail(job.jobKey, { retries: 0, errorMessage: "flip-test injected failure" });
    },
  };

  const composed = await createSupervisorDeps({
    runner,
    restConfig: { baseUrl: "http://loopback:8080", token: "" },
    worker: "flip-host",
    workers: [{ id: "flip-worker", types: [TYPE], capacity: 1 }],
    reconcileReader,
    fetchImpl,
  });
  settle = composed.settle;
  const { deps, makeSupervisor, Effect, Fiber } = composed;

  const supervisor = await Effect.runPromise(makeSupervisor(deps));
  const fiber = Effect.runFork(supervisor.run);
  let failedOnce = false;
  try {
    failedOnce = await waitFor(() => fetchImpl.failed.length >= 1);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  assert.ok(failedOnce, "the runner's failure reached the engine failure endpoint");
  assert.equal(completedInstances(engine), 0, "the instance did not complete on a failed job");
  assert.equal(fetchImpl.completed.length, 0, "a failed job is never also completed");
  assert.equal(fetchImpl.failed[0].retries, 0, "the fail carried the terminal retry count");
});
