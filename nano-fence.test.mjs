// Issue #320: NANO_FENCE + fence-check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFenceRegistry, runFenceCheck, FENCE_CHECK_SCRIPT } from "./nano-fence.mjs";
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
