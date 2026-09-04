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

test("extendLock: PATCHes /v2/jobs/{key}/timeout with the new timeout and 204s cleanly", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080/v2", authHeaders: { Authorization: "Bearer OAUTH" }, fetchImpl });
  await engine.extendLock("job-key-9", 300_000);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "http://engine:8080/v2/jobs/job-key-9/timeout");
  assert.equal(init.method, "PATCH");
  assert.equal(init.headers.Authorization, "Bearer OAUTH"); // authHeaders wins over token
  assert.deepEqual(JSON.parse(init.body), { timeout: 300_000 });
});

test("extendLock: a 409 (reclaim race) throws so dispatch declines to start", async () => {
  const fetchImpl = makeFakeFetch([{ status: 409, text: "job not activated" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.extendLock("j1", 1000), /HTTP 409.*timeout.*job not activated/s);
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

test("complete: no/empty variables POSTs an empty body object (never null variables)", async () => {
  const fetchImpl = makeFakeFetch([{ status: 204 }, { status: 204 }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await engine.complete("j1");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {});
  await engine.complete("j2", null);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {});
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

test("fail: a non-2xx response throws with status + endpoint", async () => {
  const fetchImpl = makeFakeFetch([{ status: 500, text: "boom" }]);
  const engine = createRawEngineClient({ baseUrl: "http://engine:8080", fetchImpl });
  await assert.rejects(() => engine.fail("j9", { retries: 0 }), /fail j9: HTTP 500.*failure.*boom/s);
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
