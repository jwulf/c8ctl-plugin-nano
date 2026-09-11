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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindJobSettle,
  createSupervisorDeps,
  readPendingSettlement,
  recoverPendingSettlement,
  settlementJournalPath,
  settleWithRecovery,
} from "./c8ctl-plugin.js";

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
    if (init?.method === "PATCH" && /\/jobs\/[^/]+$/.test(String(url))) {
      extended.push({ url: String(url), timeout: JSON.parse(init.body).changeset.timeout });
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
  assert.match(fetchImpl.extended[0].url, /\/v2\/jobs\/job-1$/);
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
    if (init?.method === "PATCH" && /\/jobs\/[^/]+$/.test(u)) {
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

test("createSupervisorDeps: the settle seam FENCES complete/fail — the activation leaseToken reaches the completion/failure wire", async () => {
  // The runner binds `settleJob` to its activation's job.leaseToken and calls the
  // seam explicitly (settle.complete(jobKey, vars, leaseToken) / settle.fail(jobKey,
  // {..., leaseToken})). This proves the token survives the seam all the way to the
  // engine wire — a leased job's settle is fenced, so a superseded worker is
  // rejected (JobLeaseMismatch) instead of clobbering the newer activation.
  const completions = [];
  const failures = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (/\/jobs\/.+\/completion$/.test(u)) {
      completions.push(JSON.parse(init.body));
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    if (/\/jobs\/.+\/failure$/.test(u)) {
      failures.push(JSON.parse(init.body));
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
  // As settleJob does: complete carries the token as the 3rd arg; fail carries it in opts.
  await settle.complete("job-c", { status: "opened" }, "lease-c");
  await settle.fail("job-f", { retries: 1, errorMessage: "boom", leaseToken: "lease-f" });
  assert.deepEqual(completions, [{ variables: { status: "opened" }, leaseToken: "lease-c" }]);
  assert.deepEqual(failures, [{ retries: 1, errorMessage: "boom", leaseToken: "lease-f" }]);
});

test("createSupervisorDeps: reclaim uses the activation lease fence and timeout zero", async () => {
  const patches = [];
  const fetchImpl = async (url, init) => {
    if (init?.method === "PATCH") {
      patches.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    if (String(url).endsWith("/jobs/activation")) {
      return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const { settle } = await createSupervisorDeps({
    runner: { run: async () => {} },
    restConfig: { baseUrl: "http://engine:8080", token: "T" },
    worker: "host-under-test",
    fetchImpl,
  });

  await settle.reclaim("job-requeue", "lease-old");
  assert.deepEqual(patches, [{
    url: "http://engine:8080/v2/jobs/job-requeue",
    body: { changeset: { timeout: 0 }, leaseToken: "lease-old" },
  }]);
});

test("bindJobSettle: each bound settler fences with ITS OWN activation's leaseToken — two same-jobKey activations never cross tokens", async () => {
  // Regression guard for the TOCTOU the runner's closure-capture prevents: the
  // token that fences a settlement must come from the activation that ran, not a
  // shared-map re-read that a same-key reactivation could have overwritten. Two
  // activations SHARE jobKey "J" but carry different lease tokens; each bound
  // settler must use its own — a mix-up would let a stale run's completion fence
  // (and clobber) the newer activation.
  const calls = [];
  const settle = {
    complete: (jobKey, variables, leaseToken) => calls.push({ op: "complete", jobKey, variables, leaseToken }),
    fail: (jobKey, opts) => calls.push({ op: "fail", jobKey, ...opts }),
  };
  const older = bindJobSettle(settle, { jobKey: "J", leaseToken: "lease-OLD" });
  const newer = bindJobSettle(settle, { jobKey: "J", leaseToken: "lease-NEW" });

  older.complete({ a: 1 });
  newer.complete({ a: 2 });
  older.fail({ retries: 3, errorMessage: "x" });
  newer.fail();

  assert.deepEqual(calls, [
    { op: "complete", jobKey: "J", variables: { a: 1 }, leaseToken: "lease-OLD" },
    { op: "complete", jobKey: "J", variables: { a: 2 }, leaseToken: "lease-NEW" },
    { op: "fail", jobKey: "J", retries: 3, errorMessage: "x", leaseToken: "lease-OLD" },
    { op: "fail", jobKey: "J", leaseToken: "lease-NEW" },
  ]);
});

test("settlement recovery: a lost completion is replayed on reactivation without rerunning the side effect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "c8ctl-settlement-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const completions = [];
  const reclaims = [];
  let sideEffects = 0;
  const rawSettle = {
    complete: async (jobKey, variables, leaseToken) => {
      completions.push({ jobKey, variables, leaseToken });
      if (leaseToken === "lease-old") throw new Error("HTTP 409 — Job not activated");
    },
    fail: async () => {},
  };
  const reclaim = async (jobKey, leaseToken) => {
    reclaims.push({ jobKey, leaseToken });
  };
  const oldJob = { jobKey: "job-recovered", type: "senior:feature", processInstanceKey: "pi-1", leaseToken: "lease-old" };

  // The harness has already performed its external side effect exactly once.
  sideEffects++;
  await assert.rejects(
    () =>
      settleWithRecovery({
        root,
        job: oldJob,
        operation: "complete",
        payload: { status: "opened", summary: "side effect already applied" },
        settle: bindJobSettle(rawSettle, oldJob),
        reclaim,
      }),
    /409.*not activated/i,
  );

  const pendingPath = settlementJournalPath(root, oldJob.jobKey);
  assert.equal(readFileSync(pendingPath, "utf8").includes("side effect already applied"), true);
  assert.deepEqual(readPendingSettlement(root, oldJob.jobKey)?.operation, "complete");
  assert.deepEqual(reclaims, [{ jobKey: oldJob.jobKey, leaseToken: "lease-old" }]);

  // Model the engine's stale CREATED row: the old worker is gone, but the job
  // remains visible with a future deadline and is later activated again.
  const staleSearchRow = { jobKey: oldJob.jobKey, state: "CREATED", worker: "stale-worker", deadline: "2099-01-01T00:00:00Z" };
  assert.equal(staleSearchRow.state, "CREATED");
  const newJob = { ...oldJob, leaseToken: "lease-new" };
  const replayed = await recoverPendingSettlement({
    root,
    job: newJob,
    settle: bindJobSettle(rawSettle, newJob),
  });

  assert.equal(replayed, true);
  assert.equal(sideEffects, 1, "reactivation must not rerun the external side effect");
  assert.deepEqual(completions, [
    { jobKey: oldJob.jobKey, variables: { status: "opened", summary: "side effect already applied" }, leaseToken: "lease-old" },
    { jobKey: oldJob.jobKey, variables: { status: "opened", summary: "side effect already applied" }, leaseToken: "lease-new" },
  ]);
  assert.equal(readPendingSettlement(root, oldJob.jobKey), null, "successful replay clears the durable handoff");
});

test("settlement recovery: a superseded lease rejects reclaim without an unfenced timeout update", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "c8ctl-settlement-fence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const reclaimCalls = [];
  const job = { jobKey: "job-superseded", type: "senior:feature", leaseToken: "lease-old" };
  await assert.rejects(
    () =>
      settleWithRecovery({
        root,
        job,
        operation: "complete",
        payload: { status: "done" },
        settle: {
          complete: async () => {
            throw new Error("HTTP 409 — Job not activated");
          },
          fail: async () => {},
        },
        reclaim: async (jobKey, leaseToken) => {
          reclaimCalls.push({ jobKey, leaseToken });
          throw new Error("HTTP 409 — JobLeaseMismatch");
        },
      }),
    /409.*not activated/i,
  );

  assert.deepEqual(reclaimCalls, [{ jobKey: job.jobKey, leaseToken: "lease-old" }]);
  assert.notEqual(readPendingSettlement(root, job.jobKey), null, "the handoff remains until a newer activation can replay it");
});

test("settlement recovery: a lost failure is replayed with the original retry decision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "c8ctl-failure-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const failures = [];
  const rawSettle = {
    complete: async () => {},
    fail: async (jobKey, opts) => {
      failures.push({ jobKey, opts });
      if (opts?.leaseToken === "lease-old") throw new Error("HTTP 409 — Job not activated");
    },
  };
  const oldJob = { jobKey: "job-failed", type: "senior:feature", leaseToken: "lease-old" };
  await assert.rejects(
    () =>
      settleWithRecovery({
        root,
        job: oldJob,
        operation: "fail",
        payload: { retries: 2, errorMessage: "agent failed", retryBackOff: 15_000 },
        settle: bindJobSettle(rawSettle, oldJob),
      }),
    /409.*not activated/i,
  );

  const newJob = { ...oldJob, leaseToken: "lease-new" };
  assert.equal(
    await recoverPendingSettlement({
      root,
      job: newJob,
      settle: bindJobSettle(rawSettle, newJob),
    }),
    true,
  );
  assert.deepEqual(failures, [
    { jobKey: oldJob.jobKey, opts: { retries: 2, errorMessage: "agent failed", retryBackOff: 15_000, leaseToken: "lease-old" } },
    { jobKey: oldJob.jobKey, opts: { retries: 2, errorMessage: "agent failed", retryBackOff: 15_000, leaseToken: "lease-new" } },
  ]);
  assert.equal(readPendingSettlement(root, oldJob.jobKey), null);
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
