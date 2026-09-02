# Effect (v4) patterns used by the supervisor runtime

Quick, **verified-against-`effect@4.0.0-rc.112`** reference for the handful of
Effect modules the `supervisor/` runtime leans on. This is a cheat-sheet, not a
substitute for the vendored source — **read `repos/effect/LLMS.md` and the
module's own tests under `repos/effect` before writing Effect code** (populate it
with `npm run vendor:effect`).

> v4 differs from the v3 docs you may have seen. The notes below call out the
> traps that actually bit us.

## Fibers & racing (`Effect`, `Fiber`)

- **Fork** with `Effect.forkChild(effect)` → `Fiber`. Child fibers are interrupted
  when the parent fiber terminates (structured concurrency). There is no bare
  `Effect.fork` in v4 — use `forkChild` / `forkScoped` / `forkIn` / `forkDetach`.
- **Race** with `Effect.raceAll([...])`: the first effect to *complete* wins and
  **all other fibers are interrupted** (their finalizers run). This is how the
  activation loop holds K per-type long-polls and collapses to one winner.
- `Fiber.join(fiber)` awaits a result; `Fiber.interrupt(fiber)` cancels it and
  waits for finalizers.
- Interruption-safety: `Effect.onInterrupt(fin)`, `Effect.ensuring(fin)` (runs on
  success/failure/interrupt), `Effect.acquireRelease(acquire, release)`.

## Error handling

- **`Effect.catch((e) => fallback)`** is v4's "catch all recoverable errors"
  (v3's `catchAll`). `Effect.catchAll` does **not** exist. Also: `catchTag`,
  `catchIf`, `catchCause`, `catchDefect`.
- Inspect an outcome with `Effect.exit` (`{ _tag: "Success" | "Failure" }`) or
  `Effect.result`. There is **no `Effect.either`** in v4.

## Semaphore (capacity slots)

- `const sem = yield* Semaphore.make(n)` — `make` returns an **Effect**, not a raw
  value (`Semaphore.makeUnsafe(n)` for the sync variant).
- `sem.take(k)` (blocking), `sem.takeIfAvailable(k)` → `boolean` (non-blocking,
  the correct primitive for "poll only if a slot is free"), `sem.release(k)`,
  `sem.withPermits(k)(effect)`.

## Schedule (cadences / backoff)

- `Schedule.spaced(Duration.millis(ms))` — fixed cadence (reconcile 30s, extender
  interval). `Schedule.exponential(base, factor?)` + `Schedule.jittered` for
  reconnect backoff.
- **`Schedule.upTo` takes an options object**: `Schedule.upTo({ duration })` /
  `{ times }` — *not* a bare `Duration`. Passing a `Duration` is a type error.
- Drive a repeating effect with `Effect.repeat(effect, schedule)`; retry with
  `Effect.retry(effect, schedule)`.

## Deterministic time (`TestClock`)

- Import from **`effect/testing`**: `import { TestClock } from "effect/testing"`.
- **`TestClock.layer()` is a function** — provide it with
  `program.pipe(Effect.provide(TestClock.layer()))`. Forgetting the `()` throws
  `self.build is not a function`.
- Advance virtual time with `yield* TestClock.adjust(Duration.millis(ms))`; all
  effects scheduled within that window run synchronously. Read the clock with
  `Clock.currentTimeMillis` (an Effect; `0` at test start).

## Node type-stripping gotcha

The `.ts` sources run under Node's strip-only mode (`--experimental-strip-types`
on Node 22). **No non-erasable syntax**: no `enum`, no `namespace` with runtime
members, and **no TypeScript parameter properties** (`constructor(readonly x)`) —
declare the field explicitly and assign in the body instead.
