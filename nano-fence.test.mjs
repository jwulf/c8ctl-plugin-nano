// Issue #320: NANO_FENCE + fence-check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { createFenceRegistry, runFenceCheck, writeFence, readFence, FENCE_READ_MAX, FENCE_CHECK_SCRIPT } from "./nano-fence.mjs";
import { createSupervisorDeps } from "./c8ctl-plugin.js";

const BASIC = `Basic ${Buffer.from("u:p").toString("base64")}`;
const job = { jobKey: "J1", type: "agent:code", leaseToken: "lease-1" };

// Strict basic-auth engine stub (as engine-auth.test.mjs): 401 without the exact
// header; PATCH /v2/jobs/:key answers with `patchStatus`.
function engineStub(patchStatus) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const h = init.headers || {};
    const auth = typeof h.get === "function" ? h.get("authorization") : (h.Authorization ?? h.authorization);
    requests.push({ method: init.method, url: String(url), auth });
    const res = (status, body = "") => ({ ok: status < 300, status, statusText: String(status), json: async () => ({}), text: async () => body });
    if (auth !== BASIC) return res(401, "Unauthorized");
    if (patchStatus === "network") throw new TypeError("fetch failed");
    return res(patchStatus, patchStatus === 409 ? "Job is not activated" : "");
  };
  return { fetchImpl, requests };
}

async function setup(patchStatus) {
  const stub = engineStub(patchStatus);
  const composed = await createSupervisorDeps({
    runner: { run: async () => {} },
    restConfig: { baseUrl: "https://merlin.example.com" },
    camunda: { getConfig: () => ({ restAddress: "https://merlin.example.com/v2" }), getAuthHeaders: async () => ({ Authorization: BASIC }) },
    worker: "w",
    workers: [{ id: "w", types: [], capacity: 1 }],
    fetchImpl: stub.fetchImpl,
  });
  const fences = createFenceRegistry({ check: composed.checkLease });
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const fencePath = join(dir, "fence");
  const { env } = await fences.register(job, fencePath);
  return { stub, fences, fencePath, env };
}

for (const [status, code, file] of [
  [204, 0, null],
  [404, 1, "job-gone"],
  [409, 1, "lease-lost: 409"],
  [503, 75, null],
  ["network", 75, null],
]) {
  test(`fence-check via basic-auth engine: PATCH ${status} → exit ${code}`, async () => {
    const { stub, fences, fencePath, env } = await setup(status);
    try {
      assert.equal(env.NANO_FENCE, fencePath);
      assert.ok(env.NANO_FENCE_SOCKET && env.NANO_FENCE_TOKEN && env.NANO_FENCE_CHECK);
      const r = await runFenceCheck({ env });
      assert.equal(r.code, code, r.message);
      if (file) assert.equal(readFileSync(fencePath, "utf8").trim(), file);
      else assert.equal(existsSync(fencePath), false, "no fence on held/transient");
      const patches = stub.requests.filter((q) => q.method === "PATCH");
      assert.ok(patches.length >= 1);
      for (const q of patches) assert.equal(q.auth, BASIC);
    } finally {
      fences.close();
    }
  });
}

test("heartbeat leaseLost writes the fence; fence-check then short-circuits to exit 1", async () => {
  const fences = createFenceRegistry({ check: async () => ({ state: "held" }) });
  try {
    const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
    const { env } = await fences.register(job, fencePath);
    fences.leaseLost({ ...job, leaseToken: "other-lease" }, "lease-lost: 409");
    assert.equal(existsSync(fencePath), false, "a different activation does not fence this one");
    fences.leaseLost(job, "lease-lost: 409");
    assert.equal(readFileSync(fencePath, "utf8"), "lease-lost: 409\n");
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
  } finally {
    fences.close();
  }
});

test("fence-check script: no socket → 75; worker gone → 75", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const r1 = spawnSync(process.execPath, [FENCE_CHECK_SCRIPT], { env: { NANO_FENCE: join(dir, "fence") } });
  assert.equal(r1.status, 75);
  const r2 = spawnSync(process.execPath, [FENCE_CHECK_SCRIPT], {
    env: { NANO_FENCE: join(dir, "fence"), NANO_FENCE_SOCKET: join(dir, "missing.sock"), NANO_FENCE_TOKEN: "x" },
  });
  assert.equal(r2.status, 75);
});

test("a held answer is not accepted when the fence was written while the check was pending", async () => {
  let fences;
  const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
  fences = createFenceRegistry({
    check: async (j) => { fences.leaseLost(j, "lease-lost: 409"); return { state: "held" }; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
  } finally {
    fences.close();
  }
});

test("a held answer is not accepted when the job was unregistered while the check was pending", async () => {
  let fences; let tok;
  const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
  fences = createFenceRegistry({ check: async () => { fences.unregister(tok); return { state: "held" }; } });
  try {
    const r = await fences.register(job, fencePath);
    tok = r.env.NANO_FENCE_TOKEN;
    assert.equal((await runFenceCheck({ env: r.env })).code, 75);
  } finally {
    fences.close();
  }
});

test("a latched loss beats a delayed held even when the fence write cannot land (missing parent dir)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const fencePath = join(dir, "missing-parent", "fence"); // write fails deterministically (no root/Windows chmod caveats)
  let fences;
  // Delayed successful check: the heartbeat confirms the loss while it is pending.
  fences = createFenceRegistry({
    check: async () => { await new Promise((r) => setTimeout(r, 30)); return { state: "held" }; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    const pending = runFenceCheck({ env });
    fences.leaseLost(job, "lease-lost: 409");
    assert.deepEqual(await pending, { code: 1, message: "lease-lost: 409" });
    assert.equal(existsSync(fencePath), false, "no fence file could be written");
    // The latch also answers subsequent checks without touching the engine.
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
  } finally {
    fences.close();
  }
});

test("a latched loss beats a delayed held even when the fence path is a planted dangling symlink", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const fencePath = join(dir, "fence");
  symlinkSync(join(dir, "nonexistent-target"), fencePath); // dangling: 'wx' write fails with EEXIST
  let fences;
  fences = createFenceRegistry({
    check: async () => { await new Promise((r) => setTimeout(r, 30)); return { state: "held" }; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    const pending = runFenceCheck({ env });
    fences.leaseLost(job, "lease-lost: 409");
    const r = await pending;
    // The file can never be written through the symlink, so the client-side
    // re-read finds nothing; the latched server answer must still be `lost`.
    assert.equal(r.code, 1, r.message);
  } finally {
    fences.close();
  }
});

test("a hung engine renewal is bounded and cancelled (unknown, request aborted)", async () => {
  let aborted = false;
  const fetchImpl = (_url, init = {}) => new Promise((_res, rej) => {
    init.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); });
  });
  const composed = await createSupervisorDeps({
    runner: { run: async () => {} },
    restConfig: { baseUrl: "https://merlin.example.com" },
    camunda: { getConfig: () => ({ restAddress: "https://merlin.example.com/v2" }), getAuthHeaders: async () => ({ Authorization: BASIC }) },
    worker: "w",
    workers: [{ id: "w", types: [], capacity: 1 }],
    fetchImpl,
    fenceCheckTimeoutMs: 100,
  });
  const r = await composed.checkLease(job);
  assert.equal(r.state, "unknown");
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(aborted, true, "the SDK request is cancelled on timeout");
});

test("a latched loss beats a pending transient (unknown) engine result", async () => {
  // The engine check fails transiently, but the heartbeat confirms the loss
  // while that check is still pending: the answer must be `lost`, not `unknown`.
  let fences;
  const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
  fences = createFenceRegistry({
    check: async (j) => { await new Promise((r) => setTimeout(r, 30)); fences.leaseLost(j, "lease-lost: 409"); return { state: "unknown", error: "boom" }; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
  } finally {
    fences.close();
  }
});

test("a latched loss beats a pending unknown even when the fence write cannot land (missing parent dir)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const fencePath = join(dir, "missing-parent", "fence");
  let fences;
  fences = createFenceRegistry({
    // The heartbeat confirms the loss from INSIDE the pending check, so the loss
    // is guaranteed to land while the engine call is in flight (not before the
    // server's handler runs) — the answer must be `lost`, not `unknown`.
    check: async (j) => { fences.leaseLost(j, "lease-lost: 409"); await new Promise((r) => setTimeout(r, 30)); return { state: "unknown", error: "boom" }; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
    assert.equal(existsSync(fencePath), false, "no fence file could be written");
  } finally {
    fences.close();
  }
});

test("client: a fence written before an unknown reply is received wins over exit 75", async () => {
  // The worker queues an `unknown` reply, then the heartbeat writes the fence
  // before the client finishes reading: the client must report the known loss.
  let fences;
  const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
  fences = createFenceRegistry({
    check: async (j) => { const r = { state: "unknown", error: "boom" }; fences.leaseLost(j, "lease-lost: 409"); return r; },
  });
  try {
    const { env } = await fences.register(job, fencePath);
    assert.deepEqual(await runFenceCheck({ env }), { code: 1, message: "lease-lost: 409" });
  } finally {
    fences.close();
  }
});

test("client: a fence written after the connection errors wins over exit 75", async () => {
  // Point the client at a dead socket; write the fence before the error
  // completion is processed: the known loss must win over `worker unreachable`.
  const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
  const fencePath = join(dir, "fence");
  const deadSock = join(dir, "dead.sock");
  const env = { NANO_FENCE: fencePath, NANO_FENCE_SOCKET: deadSock, NANO_FENCE_TOKEN: "x" };
  const pending = runFenceCheck({ env });
  writeFence(fencePath, "lease-lost: 409");
  assert.deepEqual(await pending, { code: 1, message: "lease-lost: 409" });
});

test("an idle fence-check client is dropped and cannot pin the worker", async () => {
  const fences = createFenceRegistry({ check: async () => ({ state: "held" }), idleSocketMs: 100 });
  try {
    const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
    const { env } = await fences.register(job, fencePath);
    const closed = await new Promise((resolve) => {
      const s = connect(env.NANO_FENCE_SOCKET);
      s.on("error", () => {});
      s.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000).unref();
    });
    assert.equal(closed, true, "idle connection destroyed by the server");
  } finally {
    fences.close();
  }
});

// Issue #320 (Copilot critical): agent-controlled fence reads must not pile up
// unbounded concurrent engine calls (memory) nor saturate the worker event loop.
test("concurrent fence-checks for one token share a single engine call (dedup)", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fences = createFenceRegistry({
    check: async () => { calls += 1; await gate; return { state: "held" }; },
  });
  try {
    const fencePath = join(mkdtempSync(join(tmpdir(), "fence-test-")), "fence");
    const { env } = await fences.register(job, fencePath);
    // Fire a burst of concurrent checks for the SAME token while the engine call
    // is still pending. They must all ride the ONE in-flight call, not each spawn
    // a renewal.
    const burst = await Promise.all([
      runFenceCheck({ env }),
      runFenceCheck({ env }),
      runFenceCheck({ env }),
      runFenceCheck({ env }),
      runFenceCheck({ env }),
      (async () => { await new Promise((r) => setTimeout(r, 20)); release(); })(),
    ]);
    const codes = burst.slice(0, 5).map((r) => r.code);
    assert.deepEqual(codes, [0, 0, 0, 0, 0], "all concurrent checks resolve held");
    assert.equal(calls, 1, "concurrent same-token checks share one engine call");
  } finally {
    release();
    fences.close();
  }
});

test("a global in-flight cap fails a new token's check closed to unknown instead of piling up engine work", async () => {
  let calls = 0;
  const gates = [];
  const fences = createFenceRegistry({
    maxInFlight: 2,
    check: async () => { calls += 1; await new Promise((r) => gates.push(r)); return { state: "held" }; },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "fence-test-"));
    // Register maxInFlight distinct tokens and start a (blocked) check for each.
    const envs = [];
    for (let i = 0; i < 2; i += 1) {
      const { env } = await fences.register({ ...job, jobKey: `J-cap-${i}` }, join(dir, `fence-${i}`));
      envs.push(env);
    }
    const pending = envs.map((env) => runFenceCheck({ env }));
    // Let both reach the engine and block.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 2, "both in-flight checks reached the engine");
    // A THIRD distinct token's check must NOT start a third engine call: the cap
    // fails it closed to unknown (the client's retry signal).
    const { env: env3 } = await fences.register({ ...job, jobKey: "J-cap-2" }, join(dir, "fence-2"));
    const third = await runFenceCheck({ env: env3 });
    assert.equal(third.code, 75, `over-cap check fails closed to unknown, got ${third.code}: ${third.message}`);
    assert.match(third.message, /in-flight cap|busy/i);
    assert.equal(calls, 2, "no third engine call was spawned while at the cap");
    // Release the blocked checks; they resolve held.
    for (const g of gates) g();
    const settled = await Promise.all(pending);
    assert.deepEqual(settled.map((r) => r.code), [0, 0]);
  } finally {
    for (const g of gates) g();
    fences.close();
  }
});

test("writeFence never follows a planted (dangling) symlink and keeps the first reason", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nano-fence-sym-"));
  const outside = join(mkdtempSync(join(tmpdir(), "nano-fence-out-")), "escaped");
  const fence = join(dir, "fence");
  symlinkSync(outside, fence);
  writeFence(fence, "lease-lost: 409");
  assert.equal(existsSync(outside), false, "write must not escape through the symlink");
  assert.ok(lstatSync(fence).isSymbolicLink());
  const plain = join(dir, "fence2");
  assert.equal(writeFence(plain, "job-gone"), true);
  assert.equal(writeFence(plain, "other"), true);
  assert.equal(readFileSync(plain, "utf8"), "job-gone\n");
});

test("#320 readFence: FIFO, symlink, directory fail closed without blocking; large file is bounded", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-rd-"));
  const fifo = join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.equal(readFence(fifo), "lease-lost: fence-invalid");
  const link = join(dir, "link");
  symlinkSync(fifo, link);
  assert.equal(readFence(link), "lease-lost: fence-invalid");
  assert.equal(readFence(dir), "lease-lost: fence-invalid");
  assert.equal(readFence(join(dir, "absent")), null);
  const big = join(dir, "big");
  writeFileSync(big, "lease-lost: x" + "y".repeat(FENCE_READ_MAX * 4));
  assert.ok(readFence(big).length <= FENCE_READ_MAX);
});

test("#320 fence socket: extra requests on one connection are not handled", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const reg = createFenceRegistry({ check: async () => { calls++; await gate; return { state: "held" }; } });
  const { token } = await reg.register({ jobKey: "1" }, join(tmpdir(), `nf-${Date.now()}-${Math.random()}`));
  assert.ok(reg.socketPath, "registry exposes its platform-aware socket path");
  const s = connect(reg.socketPath);
  await new Promise((r, j) => { s.on("connect", r); s.on("error", j); });
  for (let i = 0; i < 50; i++) s.write(JSON.stringify({ token }) + "\n");
  let out = "";
  s.setEncoding("utf8");
  s.on("data", (c) => { out += c; });
  await new Promise((r) => setTimeout(r, 100));
  release();
  await new Promise((r) => s.on("close", r));
  assert.equal(calls, 1);
  assert.equal(out.trim().split("\n").length, 1);
  reg.close();
});
