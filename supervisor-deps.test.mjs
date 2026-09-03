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
