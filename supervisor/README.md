# `supervisor/` — single-owner activation runtime (Effect v4)

The architectural core of issue #154: **one per-host supervisor** that owns job
polling, per-type capacity accounting, and dispatch — replacing the old design
where every named `nano work` process was a full, independent supervisor running
its own reconcile crawl *and* its own per-job-type SDK long-polls behind a
process-wide capacity-1 `singleFlight`.

Authored in TypeScript, esbuild-bundled (Effect **tree-shaken in**, pinned to v4)
to a single committed **`../supervisor.dist.js`** that the raw-JS
`c8ctl-plugin.js` monolith loads lazily via `loadSupervisorRuntime()`. The build
step and the `effect` dependency are confined to this module.

## Layout

| File | Responsibility |
|------|----------------|
| `src/ports.ts` | Injected port interfaces (engine, reconcile reader, job runner, agentic endpoint, logger) — the seam that makes the runtime `TestClock`-drivable and lets the monolith supply real adapters. |
| `src/registry.ts` | Worker registry & capability map (job type → workers); **per-type** free-slot accounting; `typesWithCapacity` (busy type → zero polling). |
| `src/activation.ts` | Capacity-gated, per-type activation: one `raceAll` long-poll per serviceable-with-capacity type, `maxJobsToActivate=1`; one winner, losers interrupted → lapse. |
| `src/dispatch.ts` | Dispatch + lock lifecycle: short lock → **extend winner before start** (race-loser guard) → periodic extender; slot released on every exit; never touch a lapsed job. |
| `src/reconcile.ts` | Single cached reconcile: fetch **only new keys**, reuse cached immutable XML, **skip the crawl entirely** when the key-set hash is unchanged. |
| `src/parking.ts` | Parking lot: promote a still-locked parked job the instant a slot frees, instead of re-fetching; lapsed entries pruned. |
| `src/agentic.ts` | Agentic connection as a scoped `acquireRelease` resource — teardown on success/failure/**interruption**. |
| `src/supervisor.ts` | Composes the above behind `Schedule` cadences (30s reconcile, activation/dispatch loop). |
| `test/*.test.ts` | Deterministic coverage driven by Effect's `TestClock` — no wall-clock, no `flaky`. |

## Commands

```bash
npm run typecheck:supervisor   # tsc --noEmit
npm run build:supervisor       # esbuild → ../supervisor.dist.js
npm run test:supervisor        # node --experimental-strip-types --test test/*.test.ts
```

All three also run under `npm test`. Rebuild `supervisor.dist.js` whenever you
edit `src/**` (CI + `prepublishOnly` rebuild it too).

## Writing Effect here

Read `agent-patterns/effect-supervisor.md` and the vendored `repos/effect` source
(`npm run vendor:effect`) first. Do **not** import from `repos/effect`; import the
normal pinned `effect` dependency.
