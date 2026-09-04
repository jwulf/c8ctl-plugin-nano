/**
 * End-to-end coverage for the monolith's supervisor composition seam (issue
 * #156): `createSupervisorDeps` must assemble the concrete `EngineClient`
 * (over the v2 REST client), `ReconcileReader`, `JobRunner`, and `Logger` into a
 * `makeSupervisor`-ready `deps` and drive a real activation → dispatch → run →
 * lock-extend cycle — all against an injected fake `fetch` and a fake runner, no
 * live engine. This proves the whole runtime is genuinely wired through the
 * plugin's real edges (not just that the lifts type-check).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupervisorDeps } from "./c8ctl-plugin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake `fetch`: serves ONE job on the first activation, then empty; records timeout PATCHes. */
function makeEngineFetch() {
  const extended = [];
  let served = false;
  const fake = async (url, init) => {
    if (String(url).endsWith("/jobs/activation")) {
      // Evaluate the batch EAGERLY (before flipping `served`) so the lazy `json()`
      // closure can't read the already-advanced flag and starve the poll loop.
      const jobs = served ? [] : [{ jobKey: "job-1", type: "senior:plan" }];
      served = true;
      return { ok: true, status: 200, json: async () => ({ jobs }), text: async () => "" };
    }
    if (/\/jobs\/.+\/timeout$/.test(String(url))) {
      extended.push({ url: String(url), timeout: JSON.parse(init.body).timeout });
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  fake.extended = extended;
  return fake;
}

test("createSupervisorDeps: requires a raw runner", async () => {
  await assert.rejects(() => createSupervisorDeps({}), /runner/);
});

test("createSupervisorDeps: composes runnable deps and drives one dispatch cycle", async () => {
  const ran = [];
  const runner = { run: async (job) => void ran.push(job.jobKey) };
  const fetchImpl = makeEngineFetch();
  // A hermetic reconcile reader: the `run` loop kicks off a reconcile crawl, so
  // stub it to keep the test off the network (no real `httpC8RestReader` socket).
  const reconcileReader = {
    searchProcessDefinitionKeys: async () => [],
    getProcessDefinitionXml: async () => "",
  };

  const { deps, registry, makeSupervisor, Effect, Fiber } = await createSupervisorDeps({
    runner,
    restConfig: { baseUrl: "http://engine:8080", token: "T" },
    worker: "host-under-test",
    workers: [{ id: "w-1", types: ["senior:plan"], capacity: 1 }],
    reconcileReader,
    fetchImpl,
  });

  // Deps carry the lifted ports + the seeded registry; no agentic endpoint → the
  // connectionless loop.
  assert.equal(typeof deps.engine.activate, "function");
  assert.equal(typeof deps.runner.run, "function");
  assert.equal(typeof deps.reconcileReader.searchProcessDefinitionKeys, "function");
  assert.ok(!("agenticEndpoint" in deps));
  const state = await Effect.runPromise(registry.get);
  assert.ok(state.workers.has("w-1"));

  const supervisor = await Effect.runPromise(makeSupervisor(deps));

  // Fork the real `run` loop (a single `tick` would interrupt its forked dispatch
  // when the tick's fiber scope closes). The loop polls (fake fetch serves job-1)
  // → claims w-1 → dispatches: extends the lock to the recovery window, then runs
  // the fake runner. Poll for the observable effect, then interrupt the loop.
  const fiber = Effect.runFork(supervisor.run);
  try {
    for (let i = 0; i < 200 && ran.length === 0; i++) await sleep(5);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  assert.deepEqual(ran, ["job-1"], "the composed JobRunner ran the activated job");
  // The winner's lock was extended to the recovery window (300_000ms default)
  // via the composed EngineClient over the v2 REST client.
  assert.ok(fetchImpl.extended.length >= 1, "the lock was extended over the v2 REST client");
  assert.equal(fetchImpl.extended[0].timeout, 300_000);
  assert.match(fetchImpl.extended[0].url, /\/v2\/jobs\/job-1\/timeout$/);
});

test("createSupervisorDeps: activate → dispatch → run → SETTLE — the runner completes via the exposed engine settle seam", async () => {
  // Issue #156 (escalation answer (a)): the plain ActivatedJob has no
  // job.complete()/job.fail(), so the runner settles through the `settle` seam
  // createSupervisorDeps exposes — the SAME engine client (base + auth) that
  // activates/extends. This proves the whole activate → dispatch → run → complete
  // cycle is wired through the plugin's real edges against a fake fetch, and that
  // the runner receives the settle-path fields (customHeaders/retries) it needs.
  const completions = [];
  const seenJobs = [];
  let served = false;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/jobs/activation")) {
      const jobs = served
        ? []
        : [{
            jobKey: "job-9",
            type: "senior:feature",
            processInstanceKey: "7001",
            retries: 3,
            customHeaders: { allowPr: "true" },
            variables: { task: { id: "t9" } },
          }];
      served = true;
      return { ok: true, status: 200, json: async () => ({ jobs }), text: async () => "" };
    }
    if (/\/jobs\/.+\/timeout$/.test(u)) {
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    if (/\/jobs\/.+\/completion$/.test(u)) {
      completions.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };

  const reconcileReader = {
    searchProcessDefinitionKeys: async () => [],
    getProcessDefinitionXml: async () => "",
  };

  // The runner records the job it received and settles it through `settle`,
  // exactly as the workAgent hot path's runner will (replacing the SDK job object).
  let settle;
  const runner = {
    run: async (job) => {
      seenJobs.push(job);
      await settle.complete(job.jobKey, { status: "opened", summary: "did the thing" });
    },
  };

  const composed = await createSupervisorDeps({
    runner,
    restConfig: { baseUrl: "http://engine:8080", token: "T" },
    worker: "host-under-test",
    workers: [{ id: "w-9", types: ["senior:feature"], capacity: 1 }],
    reconcileReader,
    fetchImpl,
  });
  settle = composed.settle;
  const { deps, makeSupervisor, Effect, Fiber } = composed;
  assert.equal(typeof settle.complete, "function");
  assert.equal(typeof settle.fail, "function");

  const supervisor = await Effect.runPromise(makeSupervisor(deps));
  const fiber = Effect.runFork(supervisor.run);
  try {
    for (let i = 0; i < 200 && completions.length === 0; i++) await sleep(5);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  assert.equal(seenJobs.length, 1, "the runner ran exactly one job");
  // The settle-path fields survived activate → mapJob → dispatch → runner.
  assert.equal(seenJobs[0].jobKey, "job-9");
  assert.equal(seenJobs[0].retries, 3);
  assert.deepEqual(seenJobs[0].customHeaders, { allowPr: "true" });
  assert.equal(seenJobs[0].processInstanceKey, "7001");
  // The completion POST hit the right endpoint with the result variables merged.
  assert.equal(completions.length, 1, "the job was settled via the engine completion endpoint");
  assert.match(completions[0].url, /\/v2\/jobs\/job-9\/completion$/);
  assert.deepEqual(completions[0].body, { variables: { status: "opened", summary: "did the thing" } });
});

test("createSupervisorDeps: the settle seam fails a job through the engine failure endpoint", async () => {
  const failures = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (/\/jobs\/.+\/failure$/.test(u)) {
      failures.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    if (u.endsWith("/jobs/activation")) return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const { settle } = await createSupervisorDeps({
    runner: { run: async () => {} },
    restConfig: { baseUrl: "http://engine:8080", token: "T" },
    worker: "host-under-test",
    fetchImpl,
  });
  await settle.fail("job-x", { retries: 1, errorMessage: "harness exited 1", retryBackOff: 15_000 });
  assert.equal(failures.length, 1);
  assert.match(failures[0].url, /\/v2\/jobs\/job-x\/failure$/);
  assert.deepEqual(failures[0].body, { retries: 1, errorMessage: "harness exited 1", retryBackOff: 15_000 });
});

test("createSupervisorDeps: derives engine authHeaders from camunda.getAuthHeaders() when no explicit headers/token", async () => {
  // On OAuth/basic profiles there is no bare REST token, so the engine client
  // must fall back to the SDK client's ready-made header map — otherwise engine
  // activations would go out silently unauthenticated.
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: (init?.headers || {}).Authorization });
    if (String(url).endsWith("/jobs/activation")) {
      return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  let getAuthCalls = 0;
  const camunda = {
    getAuthHeaders: async () => {
      getAuthCalls++;
      return { Authorization: "Bearer derived-token" };
    },
  };

  const { deps, Effect } = await createSupervisorDeps({
    runner: { run: async () => {} },
    // baseUrl only, NO token → derivation must kick in.
    restConfig: { baseUrl: "http://engine:8080" },
    camunda,
    worker: "host-under-test",
    fetchImpl,
  });

  const req = { type: "senior:plan", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1000 };
  await Effect.runPromise(deps.engine.activate(req));
  await Effect.runPromise(deps.engine.activate(req));

  // Per-call, not a cached startup snapshot: a rotating SDK bearer must be
  // re-derived on every engine call, so two activations consult getAuthHeaders() twice.
  assert.equal(getAuthCalls, 2, "getAuthHeaders() is consulted per engine call (not cached at startup)");
  const activation = seen.find((r) => r.url.endsWith("/jobs/activation"));
  assert.ok(activation, "an activation request was issued");
  assert.equal(activation.auth, "Bearer derived-token", "the derived auth header rode on the engine activation");
});
