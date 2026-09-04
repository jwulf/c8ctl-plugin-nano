/**
 * Wire-level coverage for the concrete C8 v2 REST engine client (issue #156).
 *
 * No live engine: an injected fake `fetch` records every request and scripts the
 * response, so we assert the exact request shape (method, URL, auth header, body)
 * the supervisor's activation race + lock lifecycle depend on, and the response
 * mapping / error surfacing (`activate` → 0..N `ActivatedJob`; non-2xx → throw).
 * This is the raw-JS analogue of `agentic-endpoint.test.mjs` (fake transport, no
 * live hub).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRawEngineClient, v2Base } from "./supervisor-engine.mjs";

/** A scriptable fake `fetch`: records calls, replies from a queue (or a default). */
function makeFakeFetch(script = []) {
  const calls = [];
  const queue = [...script];
  const fake = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length ? queue.shift() : { status: 200, json: { jobs: [] } };
    if (next.throw) throw next.throw;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json ?? {},
      text: async () => next.text ?? "",
    };
  };
  fake.calls = calls;
  return fake;
}

test("v2Base normalizes with/without a trailing /v2 and slashes", () => {
  assert.equal(v2Base("http://localhost:8080"), "http://localhost:8080/v2");
  assert.equal(v2Base("http://localhost:8080/"), "http://localhost:8080/v2");
  assert.equal(v2Base("http://localhost:8080/v2"), "http://localhost:8080/v2");
  assert.equal(v2Base("http://localhost:8080/v2/"), "http://localhost:8080/v2");
  assert.equal(v2Base("https://cluster.example.com/V2"), "https://cluster.example.com/v2");
});

test("activate: POSTs the correct body/URL and maps the returned batch", async () => {
  const fetchImpl = makeFakeFetch([
    {
      status: 200,
      json: {
        jobs: [
          { jobKey: 111, type: "senior:plan", processDefinitionKey: 222, variables: { a: 1 } },
          { jobKey: "333", type: "senior:plan" },
        ],
      },
    },
  ]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", worker: "host-1", token: "T", fetchImpl });
  const jobs = await engine.activate({ type: "senior:plan", maxJobsToActivate: 5, requestTimeoutMs: 10_000, lockMs: 15_000 });

  assert.deepEqual(jobs, [
    { jobKey: "111", type: "senior:plan", processDefinitionKey: "222", variables: { a: 1 } },
    { jobKey: "333", type: "senior:plan" },
  ]);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://engine:8080/v2/jobs/activation");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer T");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    type: "senior:plan",
    worker: "host-1",
    maxJobsToActivate: 5,
    timeout: 15_000, // lockMs → the short initial lock
    requestTimeout: 10_000, // requestTimeoutMs → the server long-poll window
  });
});

test("activate: maps the settle-path fields (customHeaders/retries/processInstanceKey) through for the runner", async () => {
  // Issue #156: a job activated over this surface must carry the task headers,
  // retry count, and process-instance key so the supervisor's runner can
  // assemble the task envelope and settle via complete()/fail() — the SDK job
  // object's fields, now surfaced on the plain ActivatedJob.
  const fetchImpl = makeFakeFetch([
    {
      status: 200,
      json: {
        jobs: [
          {
            jobKey: 111,
            type: "senior:feature",
            processInstanceKey: 999,
            retries: 3,
            customHeaders: { "io.nanobpm.agentTask": "{}", allowPr: "true" },
            variables: { task: { id: "t1" } },
          },
        ],
      },
    },
  ]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  const [j] = await engine.activate({ type: "senior:feature", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 });
  assert.deepEqual(j, {
    jobKey: "111",
    type: "senior:feature",
    processInstanceKey: "999",
    retries: 3,
    customHeaders: { "io.nanobpm.agentTask": "{}", allowPr: "true" },
    variables: { task: { id: "t1" } },
  });
});

test("activate: omits settle-path fields the engine did not surface", async () => {
  const fetchImpl = makeFakeFetch([{ status: 200, json: { jobs: [{ jobKey: "1", type: "t" }] } }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  const [j] = await engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 });
  assert.deepEqual(Object.keys(j).sort(), ["jobKey", "type"]);
});

test("activate: a non-numeric retries value is dropped rather than coerced to NaN", async () => {
  const fetchImpl = makeFakeFetch([{ status: 200, json: { jobs: [{ jobKey: "1", type: "t", retries: "oops" }] } }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  const [j] = await engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 });
  assert.ok(!("retries" in j), "a non-finite retries is omitted, not surfaced as NaN");
});

test("activate: an empty long-poll return maps to an empty batch (idle)", async () => {
  const fetchImpl = makeFakeFetch([{ status: 200, json: { jobs: [] } }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  const jobs = await engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 15_000 });
  assert.deepEqual(jobs, []);
});

test("activate: a non-2xx response throws with status + endpoint", async () => {
  const fetchImpl = makeFakeFetch([{ status: 503, text: "engine unavailable" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(
    () => engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 1, lockMs: 1 }),
    /HTTP 503.*jobs\/activation.*engine unavailable/s,
  );
});

test("extendLock: without a camunda client, PATCHes /v2/jobs/{key} with {changeset:{timeout}} and 204s cleanly", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080/v2", authHeaders: { Authorization: "Bearer OAUTH" }, fetchImpl });
  await engine.extendLock("job-key-9", 300_000);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://engine:8080/v2/jobs/job-key-9"); // the job resource, NOT a /timeout sub-route
  assert.equal(init.method, "PATCH");
  assert.equal(init.headers.Authorization, "Bearer OAUTH"); // authHeaders wins over token
  assert.deepEqual(JSON.parse(init.body), { changeset: { timeout: 300_000 } });
});

test("extendLock: delegates to the SDK's typed updateJob ({changeset:{timeout},jobKey}) when a camunda client is injected", async () => {
  const calls = [];
  const camunda = { updateJob: async (arg) => { calls.push(arg); } };
  const fetchImpl = makeFakeFetch([]); // must NOT be touched on the SDK path
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080/v2", fetchImpl, camunda });
  await engine.extendLock("job-key-9", 300_000);
  assert.deepEqual(calls, [{ changeset: { timeout: 300_000 }, jobKey: "job-key-9" }]);
  assert.equal(fetchImpl.calls.length, 0); // SDK path never issues a raw request
});

test("extendLock: a 409 (reclaim race) on the raw path throws so dispatch declines to start", async () => {
  const fetchImpl = makeFakeFetch([{ status: 409, text: "job not activated" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.extendLock("j1", 1000), /HTTP 409.*jobs\/j1.*job not activated/s);
});

test("extendLock: an SDK updateJob rejection surfaces so dispatch declines to start", async () => {
  const camunda = { updateJob: async () => { throw new Error("409 job not activated"); } };
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: makeFakeFetch([]), camunda });
  await assert.rejects(() => engine.extendLock("j1", 1000), /extendLock j1: SDK updateJob failed.*409/s);
});

test("complete: POSTs /v2/jobs/{key}/completion with the result variables and 204s cleanly", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", token: "T", fetchImpl });
  await engine.complete("job-7", { status: "opened", summary: "done" });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://engine:8080/v2/jobs/job-7/completion");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer T");
  assert.deepEqual(JSON.parse(init.body), { variables: { status: "opened", summary: "done" } });
});

test("complete: nullish variables POST an empty body (never null variables); an explicit {} sends {variables:{}}", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }, { status: 204 }, { status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await engine.complete("j1");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {});
  await engine.complete("j2", null);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {});
  await engine.complete("j3", {});
  assert.deepEqual(JSON.parse(fetchImpl.calls[2].init.body), { variables: {} });
});

test("complete: a non-2xx (e.g. 409 lock lapsed) throws with status + endpoint", async () => {
  const fetchImpl = makeFakeFetch([{ status: 409, text: "job not activated" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.complete("j9", { a: 1 }), /complete j9: HTTP 409.*completion.*job not activated/s);
});

test("fail: POSTs /v2/jobs/{key}/failure with retries, errorMessage, retryBackOff and variables", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", authHeaders: { Authorization: "Basic dGVzdA==" }, fetchImpl });
  await engine.fail("job-3", { retries: 2, errorMessage: "boom", retryBackOff: 15_000, variables: { io: 1 } });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://engine:8080/v2/jobs/job-3/failure");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Basic dGVzdA=="); // authHeaders wins over token
  assert.deepEqual(JSON.parse(init.body), { retries: 2, errorMessage: "boom", retryBackOff: 15_000, variables: { io: 1 } });
});

test("fail: omits optional fields (errorMessage/retryBackOff/variables) when absent; defaults retries to 0", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }, { status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await engine.fail("j1");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { retries: 0 });
  // A non-positive retryBackOff is dropped (engine applies its own default), not sent as 0.
  await engine.fail("j2", { retries: 1, retryBackOff: 0 });
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { retries: 1 });
});

test("fail: normalizes retries to a non-negative integer (rejects floats/negatives/strings)", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }, { status: 204 }, { status: 204 }, { status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await engine.fail("jf", { retries: 2.9 });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { retries: 2 });
  await engine.fail("jn", { retries: -3 });
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { retries: 0 });
  await engine.fail("js", { retries: "5" });
  assert.deepEqual(JSON.parse(fetchImpl.calls[2].init.body), { retries: 5 });
  await engine.fail("jx", { retries: "oops" });
  assert.deepEqual(JSON.parse(fetchImpl.calls[3].init.body), { retries: 0 });
});

test("fail: a non-2xx response throws with status + endpoint", async () => {
  const fetchImpl = makeFakeFetch([{ status: 500, text: "boom" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.fail("j9", { retries: 0 }), /fail j9: HTTP 500.*failure.*boom/s);
});

test("complete: delegates to the SDK's typed completeJob ({jobKey,variables}) when a camunda client is injected", async () => {
  const calls = [];
  const camunda = { completeJob: async (arg) => { calls.push(arg); } };
  const fetchImpl = makeFakeFetch([]); // must NOT be touched on the SDK path
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080/v2", fetchImpl, camunda });
  await engine.complete("job-7", { status: "opened" });
  assert.deepEqual(calls, [{ jobKey: "job-7", variables: { status: "opened" } }]);
  assert.equal(fetchImpl.calls.length, 0); // SDK path never issues a raw request
});

test("complete: SDK path omits `variables` entirely when nullish (never sends variables:null)", async () => {
  const calls = [];
  const camunda = { completeJob: async (arg) => { calls.push(arg); } };
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: makeFakeFetch([]), camunda });
  await engine.complete("j1");
  await engine.complete("j2", null);
  assert.deepEqual(calls, [{ jobKey: "j1" }, { jobKey: "j2" }]);
});

test("complete: an SDK completeJob rejection surfaces so the settle is retried/mapped", async () => {
  const camunda = { completeJob: async () => { throw new Error("409 job not activated"); } };
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: makeFakeFetch([]), camunda });
  await assert.rejects(() => engine.complete("j9", { a: 1 }), /complete j9: SDK completeJob failed.*409/s);
});

test("fail: delegates to the SDK's typed failJob ({jobKey,retries,...}) when a camunda client is injected", async () => {
  const calls = [];
  const camunda = { failJob: async (arg) => { calls.push(arg); } };
  const fetchImpl = makeFakeFetch([]); // must NOT be touched on the SDK path
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl, camunda });
  await engine.fail("job-3", { retries: 2.9, errorMessage: "boom", retryBackOff: 15_000, variables: { io: 1 } });
  // retries normalized identically to the raw path; optional fields carried through.
  assert.deepEqual(calls, [{ jobKey: "job-3", retries: 2, errorMessage: "boom", retryBackOff: 15_000, variables: { io: 1 } }]);
  assert.equal(fetchImpl.calls.length, 0);
});

test("fail: SDK path omits optional fields when absent and defaults retries to 0", async () => {
  const calls = [];
  const camunda = { failJob: async (arg) => { calls.push(arg); } };
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: makeFakeFetch([]), camunda });
  await engine.fail("j1");
  await engine.fail("j2", { retries: 1, retryBackOff: 0 }); // non-positive backOff dropped
  assert.deepEqual(calls, [{ jobKey: "j1", retries: 0 }, { jobKey: "j2", retries: 1 }]);
});

test("fail: an SDK failJob rejection surfaces so the settle is retried/mapped", async () => {
  const camunda = { failJob: async () => { throw new Error("500 boom"); } };
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: makeFakeFetch([]), camunda });
  await assert.rejects(() => engine.fail("j9", { retries: 0 }), /fail j9: SDK failJob failed.*500/s);
});

test("unauthenticated: no Authorization header when neither token nor authHeaders given", async () => {
  const fetchImpl = makeFakeFetch([{ status: 200, json: { jobs: [] } }]);
  const engine = createRawEngineClient({ baseUrl: "http://localhost:8080", fetchImpl });
  await engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).worker, "c8ctl-supervisor"); // default worker id
});

test("a rejected fetch (network error) propagates for the port to map", async () => {
  const fetchImpl = makeFakeFetch([{ throw: new Error("ECONNREFUSED") }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 1, lockMs: 1 }), /ECONNREFUSED/);
});

test("createRawEngineClient rejects a non-function fetchImpl", () => {
  assert.throws(() => createRawEngineClient({ baseUrl: "http://x", fetchImpl: null }), /fetchImpl/);
});

test("createRawEngineClient rejects a missing/empty baseUrl (required)", () => {
  const fetchImpl = makeFakeFetch();
  assert.throws(() => createRawEngineClient({ fetchImpl }), /baseUrl/);
  assert.throws(() => createRawEngineClient({ baseUrl: "", fetchImpl }), /baseUrl/);
  assert.throws(() => createRawEngineClient({ baseUrl: "   ", fetchImpl }), /baseUrl/);
});

test("activate: a whitespace-padded baseUrl is trimmed into a clean request URL", async () => {
  const fetchImpl = makeFakeFetch([{ status: 200, json: { jobs: [] } }]);
  const engine = createRawEngineClient({ baseUrl: "  http://engine:8080  ", fetchImpl });
  await engine.activate({ type: "senior:plan", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 });
  assert.equal(fetchImpl.calls[0].url, "http://engine:8080/v2/jobs/activation");
});

test("activate: a malformed job (missing jobKey/type) throws instead of coercing to empty strings", async () => {
  const missingKey = makeFakeFetch([{ status: 200, json: { jobs: [{ type: "senior:plan" }] } }]);
  const eng1 = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: missingKey });
  await assert.rejects(
    () => eng1.activate({ type: "senior:plan", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 }),
    /malformed activated job.*jobKey/s,
  );

  const missingType = makeFakeFetch([{ status: 200, json: { jobs: [{ jobKey: "42" }] } }]);
  const eng2 = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl: missingType });
  await assert.rejects(
    () => eng2.activate({ type: "t", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1 }),
    /malformed activated job.*type/s,
  );
});
