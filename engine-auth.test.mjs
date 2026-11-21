/**
 * Basic-auth stub coverage for every hand-rolled engine REST call path
 * (issue #315).
 *
 * Every hand-rolled `fetch` to the engine must derive its auth headers from the
 * single `createEngineAuthResolver` / `withEngineAuthFetch` source (so a c8ctl
 * profile using basic auth, OAuth, or a bare REST token works consistently
 * across job activation/extend/complete/fail, reconcile reader, `--auto`
 * startup read, linked prompt fetch, and agentic hub discovery).
 *
 * Each test below runs against a strict basic-auth stub that returns `401
 * Unauthorized` unless the exact `Authorization: Basic …` header is present.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEngineAuthResolver,
  createSupervisorDeps,
  defaultC8RestReader,
  discoverAgenticHubs,
  fetchLinkedResourceContent,
  isEngineAuthError,
  resolveAgenticTarget,
  resolveAutoJobTypes,
  resolveLinkedPromptSource,
  withEngineAuthFetch,
} from "./c8ctl-plugin.js";

const BASIC_USER = "merlin-user";
const BASIC_PASS = "s3cr3t-pass!";
const EXPECTED_BASIC_HEADER = `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}`;

const SAMPLE_AGENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="demo-agent-proc" isExecutable="true">
    <bpmn:serviceTask id="Task_Agent" name="Agent Task">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:code" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

function readAuthHeader(headers) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get("authorization") ?? headers.get("Authorization");
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => String(k).toLowerCase() === "authorization");
    return found ? found[1] : undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") return v;
  }
  return undefined;
}

/**
 * Strict basic-auth engine REST stub: rejects any request without the expected
 * `Authorization: Basic …` header with HTTP 401 Unauthorized, and serves all
 * engine REST endpoints when authenticated.
 */
function makeBasicAuthEngineStub() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    const auth = readAuthHeader(init.headers);
    requests.push({ method, url: u, auth });

    if (auth !== EXPECTED_BASIC_HEADER) {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ title: "Unauthorized", status: 401 }),
        text: async () => "401 Unauthorized",
      };
    }

    if (method === "POST" && u.endsWith("/v2/process-definitions/search")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ items: [{ processDefinitionKey: "2251799813685249" }] }),
        text: async () => "",
      };
    }
    if (method === "GET" && u.endsWith("/v2/process-definitions/2251799813685249/xml")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => SAMPLE_AGENT_BPMN,
      };
    }
    if (method === "POST" && u.endsWith("/v2/jobs/activation")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jobs: [{ jobKey: "job-basic-1", type: "agent:code" }] }),
        text: async () => "",
      };
    }
    if (method === "PATCH" && /\/v2\/jobs\/[^/]+$/.test(u)) {
      return { ok: true, status: 204, statusText: "No Content", json: async () => ({}), text: async () => "" };
    }
    if (method === "POST" && /\/v2\/jobs\/[^/]+\/(?:completion|failure)$/.test(u)) {
      return { ok: true, status: 204, statusText: "No Content", json: async () => ({}), text: async () => "" };
    }
    if (method === "GET" && u.endsWith("/v2/resources/9001/content/binary")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => "# Live Prompt\nHello." };
    }
    if (method === "GET" && u.endsWith("/console/api/projects")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ name: "my-app", appUi: { enabled: true, port: 4321 } }],
        text: async () => "",
      };
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "Not Found" };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

function makeBasicAuthCamunda(baseUrl = "https://merlin.example.com") {
  let calls = 0;
  return {
    get calls() { return calls; },
    getConfig: () => ({ restAddress: `${baseUrl}/v2` }),
    getAuthHeaders: async () => {
      calls += 1;
      return { Authorization: EXPECTED_BASIC_HEADER };
    },
  };
}

test("defaultC8RestReader + resolveAutoJobTypes authenticate with basic-auth camunda.getAuthHeaders() (#315)", async () => {
  const stub = makeBasicAuthEngineStub();
  const camunda = makeBasicAuthCamunda();

  // Without auth, the stub rejects with 401 and isEngineAuthError classifies it.
  await assert.rejects(
    () => resolveAutoJobTypes({
      restConfig: { baseUrl: "https://merlin.example.com" },
      fetchImpl: stub,
    }),
    (err) => {
      assert.match(err.message, /401 Unauthorized/);
      assert.equal(isEngineAuthError(err), true);
      return true;
    },
  );

  // With camunda basic-auth client, both /process-definitions/search and /{key}/xml succeed.
  const types = await resolveAutoJobTypes({
    restConfig: { baseUrl: "https://merlin.example.com" },
    camunda,
    fetchImpl: stub,
  });
  assert.deepEqual(types, ["agent:code"]);
  assert.equal(camunda.calls, 2, "getAuthHeaders() consulted per reconcile REST request (search + xml)");
});

test("createSupervisorDeps: reconcile reader AND raw engine client (activate/extend/complete/fail) all send basic auth (#315)", async () => {
  const stub = makeBasicAuthEngineStub();
  const camunda = makeBasicAuthCamunda();

  const { deps, settle, registry, makeSupervisor, Effect } = await createSupervisorDeps({
    runner: { run: async () => {} },
    restConfig: { baseUrl: "https://merlin.example.com" },
    camunda,
    worker: "basic-auth-worker",
    workers: [{ id: "basic-auth-worker", types: [], capacity: 1 }],
    autoWorkerId: "basic-auth-worker",
    fetchImpl: stub,
  });

  // 1. Reconcile pass via the default (non-stubbed) reconcileReader built by createSupervisorDeps.
  const sup = await Effect.runPromise(makeSupervisor(deps));
  await Effect.runPromise(sup.reconcileOnce);
  const state = await Effect.runPromise(registry.get);
  assert.deepEqual(
    [...state.workers.get("basic-auth-worker").types],
    ["agent:code"],
    "--auto worker populated job types from basic-auth-protected engine",
  );

  // 2. Raw engine REST calls: activate, extendLock, complete, fail.
  const jobs = await Effect.runPromise(
    deps.engine.activate({ type: "agent:code", maxJobsToActivate: 1, requestTimeoutMs: 0, lockMs: 1000 }),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobKey, "job-basic-1");

  await Effect.runPromise(deps.engine.extendLock("job-basic-1", 60_000));
  await settle.complete("job-basic-1", { ok: true });
  await settle.fail("job-basic-1", { retries: 1, errorMessage: "retry" });

  // Every single engine REST request carried the basic-auth header.
  assert.ok(stub.requests.length >= 6);
  for (const req of stub.requests) {
    assert.equal(req.auth, EXPECTED_BASIC_HEADER, `${req.method} ${req.url} carried Basic auth`);
  }
});

test("resolveLinkedPromptSource + fetchLinkedResourceContent send basic auth (#315)", async () => {
  const stub = makeBasicAuthEngineStub();
  const camunda = makeBasicAuthCamunda();

  const src = await resolveLinkedPromptSource(camunda, {});
  const text = await fetchLinkedResourceContent("9001", {
    baseUrl: src.baseUrl,
    authHeaders: src.authHeaders,
    fetchImpl: stub,
  });
  assert.equal(text, "# Live Prompt\nHello.");
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].auth, EXPECTED_BASIC_HEADER);
});

test("discoverAgenticHubs + resolveAgenticTarget send basic auth on /console/api/projects (#315)", async () => {
  const stub = makeBasicAuthEngineStub();
  const camunda = makeBasicAuthCamunda();
  const wsProbe = async () => true;
  const lookupImpl = async () => [{ address: "127.0.0.1", family: 4 }];

  // Without camunda/authHeaders, the 401 stub yields no discovered hubs.
  const unauthed = await discoverAgenticHubs("https://merlin.example.com", {
    fetchImpl: stub,
    wsProbe,
    lookupImpl,
  });
  assert.deepEqual(unauthed, []);

  // With camunda basic-auth client via resolveAgenticTarget, discovery succeeds.
  const target = await resolveAgenticTarget({
    camunda,
    fetchImpl: stub,
    wsProbe,
    lookupImpl,
  });
  assert.equal(target.status, "connect");
  assert.equal(target.config.discovered.project, "my-app");
  const authedReq = stub.requests.find((r) => r.url.endsWith("/console/api/projects") && r.auth === EXPECTED_BASIC_HEADER);
  assert.ok(authedReq, "console/api/projects discovery fetch carried Basic auth");
});

test("withEngineAuthFetch re-resolves rotating auth headers per call and deduplicates authorization casing (#315)", async () => {
  let n = 0;
  const seen = [];
  const baseFetch = async (_url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200 };
  };
  const camunda = {
    getAuthHeaders: async () => ({ Authorization: `Bearer rot-${++n}` }),
  };
  const authed = withEngineAuthFetch(baseFetch, { camunda });

  await authed("https://merlin.example.com/v2/test", { headers: { authorization: "Bearer stale", "content-type": "application/json" } });
  await authed("https://merlin.example.com/v2/test", { headers: { "content-type": "application/json" } });

  assert.equal(seen[0].Authorization, "Bearer rot-1");
  assert.equal("authorization" in seen[0], false, "lowercase duplicate authorization header stripped");
  assert.equal(seen[0]["content-type"], "application/json");
  assert.equal(seen[1].Authorization, "Bearer rot-2");
});

test("createEngineAuthResolver precedence: explicit authHeaders > token > camunda.getAuthHeaders() (#315)", async () => {
  const camunda = makeBasicAuthCamunda();

  const fromExplicit = createEngineAuthResolver({ camunda, token: "T", authHeaders: { Authorization: "Custom X" } });
  assert.deepEqual(await fromExplicit(), { Authorization: "Custom X" });

  const fromToken = createEngineAuthResolver({ camunda, token: "T" });
  assert.deepEqual(await fromToken(), { Authorization: "Bearer T" });

  const fromCamunda = createEngineAuthResolver({ camunda });
  assert.deepEqual(await fromCamunda(), { Authorization: EXPECTED_BASIC_HEADER });

  const none = createEngineAuthResolver({});
  assert.equal(none, undefined);
});

test("defaultC8RestReader respects explicit bare token when no camunda client is passed (#315)", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: readAuthHeader(init?.headers) });
    return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => "" };
  };
  const reader = await defaultC8RestReader({ baseUrl: "http://engine:8080", token: "bare-tok" }, { fetchImpl });
  await reader.searchProcessDefinitionKeys();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer bare-tok");
});

test("createEngineAuthResolver forwards implicit SDK credentials only same-origin as the profile restAddress (PR #316 review)", async () => {
  const camunda = makeBasicAuthCamunda();
  const origin = new URL(camunda.getConfig().restAddress).origin;
  const sameOk = createEngineAuthResolver({ camunda, targetUrl: `${origin}/v2` });
  assert.deepEqual(await sameOk(), { Authorization: EXPECTED_BASIC_HEADER });
  assert.equal(createEngineAuthResolver({ camunda, targetUrl: "https://evil.example.com" }), undefined);
  // explicit destination credentials still apply cross-origin
  assert.deepEqual(await createEngineAuthResolver({ camunda, token: "T", targetUrl: "https://evil.example.com" })(), { Authorization: "Bearer T" });
  // fail closed without a readable restAddress
  assert.equal(createEngineAuthResolver({ camunda: { getAuthHeaders: async () => ({ A: "b" }) }, targetUrl: "http://x" }), undefined);
  assert.equal(createEngineAuthResolver({ camunda: { getConfig: () => { throw new Error("x"); }, getAuthHeaders: async () => ({ A: "b" }) }, targetUrl: "http://x" }), undefined);
});

test("withEngineAuthFetch preserves tuple-array HeadersInit (PR #316 review)", async () => {
  const seen = [];
  const authed = withEngineAuthFetch(async (_u, init) => { seen.push(init.headers); return { ok: true }; }, { token: "T" });
  await authed("http://e/v2", { headers: [["content-type", "application/json"], ["authorization", "old"]] });
  assert.deepEqual(seen[0], { "content-type": "application/json", Authorization: "Bearer T" });
  await authed("http://e/v2", { headers: new Headers({ "x-a": "1" }) });
  assert.equal(seen[1]["x-a"], "1");
});
