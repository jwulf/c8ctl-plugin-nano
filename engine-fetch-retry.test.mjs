/**
 * Transient engine-fetch retry, cause logging, non-auto reconcile skip and
 * worker log timestamps (issue #323).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSupervisorDeps,
  defaultC8RestReader,
  describeFetchError,
  fetchLinkedResourceContent,
  isTransientFetchError,
  resolveAutoJobTypes,
  syncWorkerLogTimestamps,
  enableWorkerLogTimestamps,
  __getLoggerForTest as getLogger,
  withLogTimestamps,
  withTransientFetchRetry,
} from "./c8ctl-plugin.js";

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:serviceTask id="T"><bpmn:extensionElements>
      <zeebe:taskDefinition type="agent:code" /><zeebe:agentDefinition agentType="external" />
    </bpmn:extensionElements></bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

const resetErr = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "Client network socket disconnected before secure TLS connection was established" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Engine stub: fails the first `failures` calls with ECONNRESET, then serves.
function flakyEngine(failures, { status } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (n++ < failures) throw resetErr();
    if (status) return json({ title: "nope" }, status);
    const u = String(url);
    if (u.endsWith("/process-definitions/search")) {
      return json({ items: [{ processDefinitionKey: "1", processDefinitionId: "p", version: 1 }], page: { totalItems: 1 } });
    }
    if (u.endsWith("/xml")) return new Response(BPMN, { status: 200, headers: { "content-type": "text/xml" } });
    if (u.includes("/resources/")) return new Response("PROMPT", { status: 200 });
    return json({ jobs: [] });
  };
  return { fetchImpl, calls };
}

function captureLogger() {
  const lines = [];
  const logger = { info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]), error: (m) => lines.push(["error", m]), debug: () => {} };
  return { logger, lines };
}

test("withTransientFetchRetry: ECONNRESET twice then success", async () => {
  const { fetchImpl, calls } = flakyEngine(2);
  const f = withTransientFetchRetry(fetchImpl, { sleep: async () => {} });
  const res = await f("http://e/v2/resources/1/content/binary");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test("withTransientFetchRetry: retries 503, never retries 4xx", async () => {
  let n = 0;
  const f503 = withTransientFetchRetry(async () => (n++ < 1 ? new Response("", { status: 503 }) : new Response("ok")), { sleep: async () => {} });
  assert.equal((await f503("x")).status, 200);
  assert.equal(n, 2);
  let m = 0;
  const f401 = withTransientFetchRetry(async () => { m++; return new Response("", { status: 401 }); }, { sleep: async () => {} });
  assert.equal((await f401("x")).status, 401);
  assert.equal(m, 1, "401 is not retried");
});

test("withTransientFetchRetry: gives up after 4 attempts with the cause in the message", async () => {
  const { fetchImpl, calls } = flakyEngine(99);
  const f = withTransientFetchRetry(fetchImpl, { sleep: async () => {} });
  await assert.rejects(() => f("x"), /fetch failed \(ECONNRESET: Client network socket/);
  assert.equal(calls.length, 4);
});

test("withTransientFetchRetry: an aborted signal stops retrying", async () => {
  const { fetchImpl, calls } = flakyEngine(99);
  const ac = new AbortController();
  ac.abort();
  const f = withTransientFetchRetry(fetchImpl, { sleep: async () => {} });
  await assert.rejects(() => f("x", { signal: ac.signal }));
  assert.equal(calls.length, 1);
});

test("isTransientFetchError / describeFetchError", () => {
  assert.equal(isTransientFetchError(resetErr()), true);
  assert.equal(isTransientFetchError(new Error("boom")), false);
  assert.equal(describeFetchError(new Error("boom")), "boom");
  assert.match(describeFetchError(resetErr()), /^fetch failed \(ECONNRESET: /);
});

test("prompt fetch succeeds through two ECONNRESETs", async () => {
  const { fetchImpl, calls } = flakyEngine(2);
  const text = await fetchLinkedResourceContent("7", { baseUrl: "http://e", fetchImpl, retry: { sleep: async () => {} } });
  assert.equal(text, "PROMPT");
  assert.equal(calls.length, 3);
});

test("prompt fetch failure message includes the cause code", async () => {
  const { fetchImpl } = flakyEngine(99);
  await assert.rejects(
    () => fetchLinkedResourceContent("7", { baseUrl: "http://e", fetchImpl, retry: { sleep: async () => {} } }),
    /prompt resource 7 fetch failed: fetch failed \(ECONNRESET/,
  );
});

test("reconcile reader succeeds through two ECONNRESETs", async () => {
  const { fetchImpl } = flakyEngine(2);
  const reader = await defaultC8RestReader({ baseUrl: "http://e" }, { fetchImpl });
  const keys = await reader.searchProcessDefinitionKeys();
  assert.equal(keys.length, 1);
});

async function withLogger(fn) {
  const prev = globalThis.c8ctl;
  const cap = captureLogger();
  globalThis.c8ctl = { getLogger: () => cap.logger };
  try { return await fn(cap); } finally { globalThis.c8ctl = prev; }
}

test("--auto reconcile: ECONNRESET twice then success populates types", async () => {
  await withLogger(async ({ lines }) => {
    const { fetchImpl } = flakyEngine(2);
    const { deps, registry, makeSupervisor, Effect } = await createSupervisorDeps({
      runner: { run: async () => {} }, restConfig: { baseUrl: "http://e" }, worker: "w", env: {},
      workers: [{ id: "w", types: [], capacity: 1 }], autoWorkerId: "w", fetchImpl,
    });
    const sup = await Effect.runPromise(makeSupervisor(deps));
    await Effect.runPromise(sup.reconcileOnce);
    const state = await Effect.runPromise(registry.get);
    assert.deepEqual([...state.workers.get("w").types], ["agent:code"]);
    assert.equal(lines.filter(([l]) => l === "warn").length, 0);
  });
});

test("--auto reconcile: 401 is not retried and still logs RECONCILE AUTH FAILED", async () => {
  await withLogger(async ({ lines }) => {
    const { fetchImpl, calls } = flakyEngine(0, { status: 401 });
    const { deps, makeSupervisor, Effect } = await createSupervisorDeps({
      runner: { run: async () => {} }, restConfig: { baseUrl: "http://e" }, worker: "w", env: {},
      workers: [{ id: "w", types: [], capacity: 1 }], autoWorkerId: "w", fetchImpl,
    });
    const sup = await Effect.runPromise(makeSupervisor(deps));
    await Effect.runPromise(sup.reconcileOnce);
    assert.equal(calls.filter((u) => u.endsWith("/search")).length, 1, "401 not retried");
    assert.ok(lines.some(([l, m]) => l === "warn" && /RECONCILE AUTH FAILED/.test(m)), JSON.stringify(lines));
  });
});

test("--auto reconcile warning includes the cause code when retries are exhausted", async () => {
  await withLogger(async ({ lines }) => {
    const { fetchImpl } = flakyEngine(99);
    const { deps, makeSupervisor, Effect } = await createSupervisorDeps({
      runner: { run: async () => {} }, restConfig: { baseUrl: "http://e" }, worker: "w", env: {},
      workers: [{ id: "w", types: [], capacity: 1 }], autoWorkerId: "w", fetchImpl,
    });
    const sup = await Effect.runPromise(makeSupervisor(deps));
    await Effect.runPromise(sup.reconcileOnce);
    assert.ok(lines.some(([l, m]) => l === "warn" && /reconcile skipped — .*ECONNRESET/.test(m)), JSON.stringify(lines));
  });
});

test("non --auto worker makes no process-definition search/XML requests", async () => {
  await withLogger(async () => {
    let searches = 0;
    const reconcileReader = {
      searchProcessDefinitionKeys: async () => { searches++; return []; },
      getProcessDefinitionXml: async () => { searches++; return ""; },
    };
    const { fetchImpl } = flakyEngine(0);
    const { deps, makeSupervisor, Effect, Fiber } = await createSupervisorDeps({
      runner: { run: async () => {} }, restConfig: { baseUrl: "http://e" }, worker: "w", env: {},
      workers: [{ id: "w", types: ["senior"], capacity: 1 }], reconcileReader, fetchImpl,
      config: { idleSpacingMs: 10, activation: { requestTimeoutMs: 10, emptyPollBackoffMs: 10 } },
    });
    const sup = await Effect.runPromise(makeSupervisor(deps));
    const fiber = Effect.runFork(sup.run);
    await new Promise((r) => setTimeout(r, 200));
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(searches, 0);
  });
});

test("withLogTimestamps prefixes ISO-8601 timestamps", () => {
  const cap = captureLogger();
  cap.logger.mode = "text";
  const l = withLogTimestamps(cap.logger, () => "2026-01-01T00:00:00.000Z");
  l.warn("hello");
  l.info({ obj: 1 });
  assert.deepEqual(cap.lines[0], ["warn", "2026-01-01T00:00:00.000Z hello"]);
  assert.deepEqual(cap.lines[1], ["info", { obj: 1 }]);
  assert.equal(l.mode, "text");
  assert.equal(withLogTimestamps(l), l, "idempotent");
});

test("syncWorkerLogTimestamps resets the flag for JSON output after text mode", () => {
  const prev = globalThis.c8ctl;
  try {
    globalThis.c8ctl = { outputMode: "text" };
    assert.equal(syncWorkerLogTimestamps(), true);
    globalThis.c8ctl = { outputMode: "json" };
    assert.equal(syncWorkerLogTimestamps(), false, "JSON mode must clear the flag");
    globalThis.c8ctl = { getLogger: () => ({ mode: "json" }) };
    assert.equal(syncWorkerLogTimestamps(), false);
  } finally {
    globalThis.c8ctl = prev;
    syncWorkerLogTimestamps();
  }
});

test("getLogger never timestamps JSON-mode logs even with a stale text-mode flag", () => {
  const prev = globalThis.c8ctl;
  try {
    globalThis.c8ctl = { outputMode: "text", getLogger: () => ({ info() {} }) };
    assert.equal(syncWorkerLogTimestamps(), true);
    assert.equal(getLogger().__nanoTimestamped, true);
    const lines = [];
    const jsonLogger = { mode: "json", info: (m) => lines.push(m) };
    globalThis.c8ctl = { outputMode: "json", getLogger: () => jsonLogger };
    const l = getLogger();
    assert.equal(l, jsonLogger, "stale flag must not wrap a JSON-mode logger");
    l.info("hi");
    assert.deepEqual(lines, ["hi"]);
  } finally {
    globalThis.c8ctl = prev;
    syncWorkerLogTimestamps();
  }
});

// Issue #323 (review): the timestamp flag is module-global, so a worker that
// returns or throws must restore the PRIOR flag — otherwise a later text-mode
// command in a reused host process inherits timestamped logs (a text→text leak
// the JSON-mode guard cannot see). `workAgent` itself is not safely unit-testable
// (its early config-error paths call `process.exit`), so this locks the primitive
// invariant its `finally` relies on: capture prior → run lifecycle → restore prior.
test("worker lifecycle restores the prior timestamp flag (text-to-text leak)", () => {
  const prev = globalThis.c8ctl;
  try {
    // Host is in text mode with timestamping OFF (the common default before any
    // worker runs). This is the "prior" state the worker must restore to.
    globalThis.c8ctl = { outputMode: "text", getLogger: () => ({ info() {} }) };
    const prior = false;
    enableWorkerLogTimestamps(prior);
    // Worker lifecycle: sync for THIS worker (text mode → flag on) ...
    syncWorkerLogTimestamps();
    assert.equal(getLogger().__nanoTimestamped, true, "worker text-mode logs are timestamped");
    // ... then the finally restores the prior flag when the lifecycle ends.
    enableWorkerLogTimestamps(prior);
    assert.equal(getLogger().__nanoTimestamped, undefined, "after the lifecycle a later text-mode command is NOT timestamped");
  } finally {
    globalThis.c8ctl = prev;
    syncWorkerLogTimestamps();
  }
});

test("resolveAutoJobTypes aborts the retrying read on timeout: no fetch attempt starts after the deadline", async () => {
  let attempts = 0;
  let timedOutAt = null;
  const fetchImpl = async (_input, init = {}) => {
    attempts++;
    if (timedOutAt !== null) throw new Error("attempt started after the timeout");
    return await new Promise((_resolve, reject) => {
      const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      setTimeout(() => reject(err), 5);
      init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  await assert.rejects(
    resolveAutoJobTypes({ restConfig: { baseUrl: "http://127.0.0.1:1" }, fetchImpl, timeoutMs: 30 }),
    /timed out after 30ms/,
  );
  timedOutAt = Date.now();
  const before = attempts;
  await new Promise((r) => setTimeout(r, 4500)); // > max backoff (4s cap)
  assert.equal(attempts, before, "no retry attempt after the deadline");
});

test("withTransientFetchRetry starts no retry after the signal aborts during backoff", async () => {
  let calls = 0;
  const ac = new AbortController();
  const f = withTransientFetchRetry(
    async () => { calls++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
    { sleep: async () => { ac.abort(new Error("gone")); } },
  );
  await assert.rejects(f("http://x", { signal: ac.signal }), /gone/);
  assert.equal(calls, 1);
});
