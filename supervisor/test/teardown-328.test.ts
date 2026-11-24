/**
 * Issue #328 reproduction: a worker's runtime interrupt must complete when the
 * engine/app endpoints are unreachable (activation long-poll that ignores its
 * AbortSignal, reconcile fetches that fail, an agentic hub that never opens).
 * Live clock — the point is real promise/socket-like behaviour, bounded by a
 * wall-clock deadline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { makeSupervisor } from "../src/supervisor.ts";
import { makeRegistry } from "../src/registry.ts";
import { makeEngineClient, makeReconcileReader } from "../src/adapters.ts";
import { makeAgenticEndpoint, type RawEmitClient } from "../src/emit.ts";
import { noopLogger } from "../src/ports.ts";

const never = <T>() => new Promise<T>(() => {});

class NeverOpens implements RawEmitClient {
  closed = 0;
  readonly supportsClaimRelease = true;
  readonly supportsSteer = true;
  private readonly open: boolean;
  constructor(open: boolean) { this.open = open; }
  register() {}
  heartbeat() {}
  deregister() {}
  claim() {}
  release() {}
  transcript() {}
  onSteer() {}
  onOpen(cb: () => void) { if (this.open) cb(); }
  onClose() {}
  close() { this.closed++; }
}

const scenario = async (agentic: "none" | "never-opens" | "open" | "throws") => {
  const engine = makeEngineClient({
    activate: () => never(), // ignores the signal, like a stuck SYN_SENT connect
    extendLock: () => never(),
    complete: () => never(),
    fail: () => never(),
  });
  const reader = makeReconcileReader({
    searchProcessDefinitionKeys: () => Promise.reject(new Error("fetch failed")),
    getProcessDefinitionXml: () => never(),
  });
  const raws: NeverOpens[] = [];
  const endpoint =
    agentic === "none"
      ? undefined
      : makeAgenticEndpoint(() => {
          if (agentic === "throws") throw new Error("connect ECONNREFUSED");
          const r = new NeverOpens(agentic === "open");
          raws.push(r);
          return r;
        });
  const reg = Effect.runSync(makeRegistry());
  Effect.runSync(reg.add("w", ["t"], 1));
  const sup = Effect.runSync(
    makeSupervisor({
      engine,
      runner: { run: () => Effect.never },
      registry: reg,
      reconcileReader: reader,
      scan: () => [],
      autoWorkerId: "w",
      logger: noopLogger,
      ...(endpoint ? { agenticEndpoint: endpoint, agenticConfig: { reconnectBaseMs: 10, reconnectMaxMs: 50 } } : {}),
      config: { reconcileIntervalMs: 20, idleSpacingMs: 20, presence: { heartbeatIntervalMs: 20 } },
    } as never),
  );
  const fiber = Effect.runFork(sup.run);
  await new Promise((r) => setTimeout(r, 300));
  const outcome = await Promise.race([
    Effect.runPromise(Fiber.interrupt(fiber)).then(() => "interrupted"),
    new Promise((r) => setTimeout(() => r("HUNG"), 3_000)),
  ]);
  return { outcome, raws };
};

for (const agentic of ["none", "never-opens", "open", "throws"] as const) {
  test(`#328: runtime interrupt completes with unreachable endpoints (agentic=${agentic})`, async () => {
    const { outcome, raws } = await scenario(agentic);
    assert.equal(outcome, "interrupted");
    for (const r of raws) assert.ok(r.closed > 0, "every raw agentic client is closed");
  });
}
