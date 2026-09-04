# AGENTS.md — c8ctl-plugin-nano

Implementation contract for coding agents working on this plugin.

## What this is

A [c8ctl](https://github.com/camunda/c8ctl) plugin that manages a local
[nanobpmn](https://github.com/jwulf/nano-bpm) cluster via a single `nano`
command (includes `start|status|stop|logs|restart|hire|work`).

## Plugin contract

- Entry point is **`c8ctl-plugin.js`** (plain ESM JavaScript). Node.js does not
  strip TypeScript types inside `node_modules`, so the **agent-edited monolith
  and the `*.mjs` sidecars stay raw JS** — do not convert them to TypeScript.
  The **one sanctioned exception** is the quarantined `supervisor/` module (see
  "Supervisor runtime (Effect)" below): it is authored in TypeScript and
  esbuild-bundled to a single committed `supervisor.dist.js` that the monolith
  loads via `await import()`. The build step and the `effect` dependency are
  confined to that module; everything else remains build-free raw JS.
- Required export: `commands` (an object keyed by command name).
- Optional export: `metadata` (drives `c8ctl help` text and examples).
- `package.json` `keywords` must include `c8ctl` and `c8ctl-plugin`.
- The command name is `nano`; do not rename it to a built-in (`list`, `get`,
  `create`, `deploy`, …) — built-ins always win.

## Runtime APIs

At runtime c8ctl injects `globalThis.c8ctl`. This plugin uses
`globalThis.c8ctl.getLogger()` (output-mode aware) for all output — always go
through the local `getLogger()` helper, which falls back to `console` when run
outside c8ctl. The `work` command additionally uses
`globalThis.c8ctl.createClient()` to obtain the bundled `@camunda8/orchestration-cluster-api`
SDK client (job workers) — do **not** add the SDK as a dependency or use raw
`fetch`; the client comes from the host runtime.

## CLI agent workers (`hire` / `work`)

- `hire` persists an agent profile (name, rank, command, model, capabilities,
  optional `sandbox`/`image`, and an optional static harness `env` map) to
  `config.json`; `work` registers one job worker per token in the
  rank×capability matrix.
- Each job runs the profile `command` one-shot with the job serialized to
  **stdin** (never interpolated into argv — the trust boundary). The reserved
  **task envelope** (`io.nanobpm.agentTask`, headers=defaults ← variables=overrides,
  coerced/normalized to schema v1) rides in the payload as `task`; the result is
  written back under `io.nanobpm.agentResult`. These envelope field names are a
  **frozen contract** (the nano-ide element-template pack targets them) — extend,
  don't rename.
- Sandboxes: `none` runs on the host; `docker`/`podman` run each job in a
  throwaway `--rm` container labelled `nano.managed=1`/`nano.worker`/`nano.jobKey`/
  `nano.run`, log-capped, force-removed on timeout. Cleanup is **label-scoped**
  (never `system prune`), age-gated, and skips in-flight run ids. Secrets are
  resolved by **name** (pluggable resolver; `host` only) and forwarded as
  `-e NAME` so values never hit argv/`docker inspect`.
- Harness **env** (non-secret startup config, e.g. permission toggles): a static
  `env` map on the profile (`hire --env NAME=VALUE`, repeatable), extended/
  overridden at work time (`work --env`). Applied on host + container; per-job
  `setup.env` layers on top, and reserved `AGENT_*` + resolved secrets always win
  (user env can't shadow them). Secret values go through `secretRefs`, not `--env`.
- Git provisioning (host, `sandbox=none` + `repository.url`): clone into a
  throwaway `<state>/agent-runs/run-*` workspace → checkout/create the branch →
  run the harness with that workspace as `cwd` → push the branch (`branch.push`)
  → reconcile the **agent-opened** PR (`task.allowPr`, via `gh pr list --head`).
  The repo token is delivered via `GIT_ASKPASS` (env) and **redacted** from all
  logs/results — never in argv or the remote URL. A push failure is a
  non-fatal `pushError` (the process model drives the merge); a clone failure
  sheds (retryable). Workspaces are reaped like containers (age-gated, in-flight
  skipped) and deleted per-job unless `--keep-runs`. Container-side cloning
  (strong isolation) is a later increment; container jobs don't clone yet.

## Worker supervisor (`supervisor`)

- Runs/manages a fleet of `nano work` children from one terminal. `nano work`
  needs the host runtime (`createClient`), so worker loops **cannot** run in a
  bare detached process — the supervisor is a **process manager**, not an
  in-process multiplexer.
- A **detached daemon** (`nano supervisor __daemon`, spawned detached+`unref`'d,
  re-invoked via `process.execPath` + the c8ctl entry from `process.argv[1]` /
  `C8CTL_NANO_ENTRY`) spawns one `c8ctl nano work <profile> [flags]` child per
  worker (inheriting `process.env`, so each child gets its own runtime + SDK
  client — all `work` logic is reused unchanged), restarts crashes with capped
  exponential backoff (`supervisorBackoffMs`), and serves a **control socket**
  (Unix socket / Windows named pipe, newline-delimited JSON via `encodeFrame`/
  `decodeFrames`).
- State file `supervisor.json` (`{ pid, socket, logFile, workers:[…] }`); logs
  under `logs/supervisor/`. Management subcommands (`status|add|remove|restart|
  stop|logs`) are thin socket clients (`supervisorRequest`) needing no
  interactive surface; the interactive `attach` console streams events and can
  **detach** (Ctrl-D / `detach`, leaving the daemon running) or `stop` the fleet.
- Invariants: `stop` always clears `supervisor.json` (no stale marker wedges a
  future start); `remove`/`stop` cancel a pending restart; a `restart` swaps the
  child under a **child-identity guard** so a late old-child exit is never
  misattributed to the new child (no spurious restart / duplicate leak); the
  daemon never runs a worker loop itself. Forwarded flags come from
  `WORK_FORWARD_FLAGS` via `reconstructWorkArgs` (only real `work` flags).

## Supervisor runtime (Effect) — `supervisor/`

The **single-owner activation runtime** (issue #154) is a quarantined TypeScript
module under `supervisor/src/`, esbuild-bundled (Effect **tree-shaken in**, pinned
to v4) to a single committed `supervisor.dist.js`. The raw-JS monolith consumes
it lazily via `loadSupervisorRuntime()` (`await import('./supervisor.dist.js')`),
so the ~100 KB Effect surface only loads when the runtime is actually used and
every other code path stays Effect-free.

- **Architecture.** One per-host supervisor owns polling, per-type capacity
  accounting, and dispatch — replacing the old design where every named `work`
  process was a full, independent supervisor (its own 1 + N reconcile crawl **and**
  its own per-type SDK long-polls, all gated by a *process-wide* capacity-1
  `singleFlight`). Pieces: **worker registry + capability map** (`registry.ts`,
  per-type free-slot accounting), **capacity-gated activation** (`activation.ts`,
  one `raceAll` long-poll per serviceable-with-capacity type, `maxJobsToActivate=1`,
  losers interrupted → lapse), **dispatch + lock lifecycle** (`dispatch.ts`, short
  lock → extend-winner-before-start → periodic extender; never touch a lapsed job),
  **cached reconcile** (`reconcile.ts`, fetch only new keys, skip the crawl when the
  key-set hash is unchanged), **parking lot** (`parking.ts`, promote-on-slot-free),
  **agentic connection** (`agentic.ts`, `acquireRelease` teardown on
  interruption; `superviseAgentic` reconnect-resync), the **claim registry +
  ownership frames** (`ownership.ts`, explicit instance-tagged `register`/`claim`/
  `transcript`/`release`, the race-free `instance → jobKeys` source of truth), and
  the **presence projection + steer lane** (`presence.ts`, issue #163 — one
  multiplexed connection carries every supervised agent: a projection fiber derives
  `register`/`heartbeat`/`deregister` from the registry on a `Schedule` cadence, and
  a per-instance `SteerRouter` fans inbound steer bytes back to the right agent so N
  agents' streams never cross). `supervisor.ts` composes them behind `Schedule`
  cadences.
- **Concrete agentic endpoint (issue #160).** The `AgenticEndpoint` the supervisor
  injects as `deps.agenticEndpoint` is a thin, deterministically-testable Effect
  adapter (`emit.ts`, `makeAgenticEndpoint`) that lifts a plain, Effect-free
  `RawEmitClient` — ONE multiplexed host connection — into the Effect
  `AgenticHandle`. The wire itself is CONSUMED through the monolith's single import
  surface (`agentic-endpoint.mjs` → `agentic.mjs` → `@nanobpm/agentic` `^0.11.0`'s
  `claim`/`release` families 8/9 + additive negotiation), so it is NOT bundled into
  the quarantined Effect module. The monolith composes the two via
  `createAgenticEndpoint()`. Every frame carries its `instance` EXPLICITLY (one
  connection, N workers); `claim`/`release`/steer are OMITTED from the handle when
  the negotiated protocol lacks them, so an old hub degrades to a no-op rather than
  a protocol error.
- **Concrete engine + deps seam (issue #156).** The same "monolith supplies a
  plain Effect-free client, a TS lift wraps it into an Effect port" pattern extends
  to the remaining edges. `adapters.ts` lifts a raw `RawEngineClient`
  (`activate`/`extendLock`), `RawReconcileReader`, and `RawJobRunner` into their
  Effect ports (`makeEngineClient`/`makeReconcileReader`/`makeJobRunner`), wraps a
  monolith logger with `asLogger`, and assembles them with `makeSupervisorDeps` —
  every promise rejection mapped into the `SupervisorError` channel. The concrete
  engine wire is `supervisor-engine.mjs` (`createRawEngineClient`): direct C8 v2
  REST, Effect-free with an injectable `fetch`, so it stays OUT of the quarantined
  bundle. **SDK-preference convention (PR #180, issue #179):** every engine
  job-mutation that has a typed `@camunda8` SDK method PREFERS the injected
  `camunda` client and hand-rolls the raw REST `call(...)` only as a standalone /
  wire-test fallback — `extendLock`→`updateJob` (`PATCH /v2/jobs/{key}`, NOT the
  drifted `/timeout` sub-route that 404s), `complete`→`completeJob`
  (`POST /v2/jobs/{key}/completion`), `fail`→`failJob`
  (`POST /v2/jobs/{key}/failure`). `activate` (`POST /v2/jobs/activation`) is the
  SOLE sanctioned raw-only call (the SDK job worker can't express the supervisor's
  global-capacity single long-poll). This is ENFORCED by
  `supervisor-engine-sdk-preference.test.mjs` (a source-scanning `node --test`
  lint, since the repo has no ESLint): a new engine method hitting a raw route
  must either add an SDK-preference guard or be added to that test's raw-only
  allowlist with a reason. The monolith
  composes the whole runtime via `createSupervisorDeps()` → a `makeSupervisor`-ready
  `deps`. NOTE: this lands the composition seam; the hot-path FLIP (retiring the
  per-type SDK pollers / `createSingleFlight` / per-worker reconcile crawl and
  driving `makeSupervisor().run` from `workAgent`) is deferred — it deletes
  crash-safety code and can only be validated against a live engine.
- **Ports, not globals.** Everything at the process edge (engine
  `activate`/`extendLock`, reconcile reader, job runner, agentic endpoint, logger)
  is an injected interface in `ports.ts`, so the runtime is driven deterministically
  under Effect's `TestClock` with in-memory fakes, and the monolith supplies real
  adapters (its keep-alive reader, `createClient()` SDK, `runAgentJob`).
- **Build / test.** `npm run build:supervisor` (esbuild → `supervisor.dist.js`),
  `npm run typecheck:supervisor` (tsc, `--noEmit`), `npm run test:supervisor`
  (`node --experimental-strip-types --test supervisor/test/*.test.ts`). All three
  run in `npm test`, alongside the existing `node --check` + `node --test`. Tests
  are **red-first, deterministic** — drive time via `TestClock`, never wall-clock
  sleeps or `flaky`. Rebuild the committed `supervisor.dist.js` whenever you touch
  `supervisor/src/**` (CI and `prepublishOnly` rebuild it too).

### Writing Effect (v4) — read the vendored source first

This repo is AI-agent-edited, and agents write far better idiomatic Effect from
**source** than from docs. Effect source is vendored (as source, for reference)
under `repos/effect`:

- Treat `repos/effect` as **read-only reference**. Prefer its examples/tests over
  generated guesses, and **read `repos/effect/LLMS.md` before writing any Effect
  code**.
- **Do not import from `repos/effect`.** App code imports the normal pinned
  `effect` dependency; the vendored tree is reference only.
- `repos/**` is excluded from editor auto-import/search/watch (`.vscode/settings.json`)
  and is **git-ignored** — populate it with `npm run vendor:effect` (a thin wrapper
  over `git subtree`, pinned to the same `effect` version). Quick-reference notes
  for the modules we lean on live in `agent-patterns/effect-*.md`.



- Each nanobpmn node is the single server binary, configured by env vars:
  `PORT`, `NANOBPMN_NODE_ID`, `NANOBPMN_NODES`, `NANOBPMN_PARTITIONS`,
  `NANOBPMN_RF`, `NANOBPMN_RAFT` (when RF>1), `NANOBPMN_DATA_DIR`,
  `NANOBPMN_WORKSPACE_DIR`.
- Nodes are spawned **detached + unref'd** so they outlive the CLI invocation.
- A JSON state file (`cluster.json`) records `{ nodes:[{id,port,pid,url,dataDir,logFile}], partitions, rf, raft, binary, workspaceDir, ... }`.
- Persistent user settings live in `config.json` (`binary`, `workspaceDir`),
  set via `nano set bin|model-dir` and shown via `nano config`.
- Health is the binary's always-on `GET /v2/topology` (200 == reachable).
- Liveness is `process.kill(pid, 0)` (ESRCH == dead, EPERM == alive).
- Stop is SIGTERM → grace window → SIGKILL stragglers.

## Persistent vs ephemeral storage

- **Workspace** (`NANOBPMN_WORKSPACE_DIR`, default `<stateHome>/workspace`) holds
  `models/` and `workers/`. Shared by all nodes; the authoring source of truth.
- **Engine data** (`NANOBPMN_DATA_DIR`, `<stateHome>/data/node-<i>`) is per-node and
  ephemeral (journal/snapshots/spill).
- `nano clean` and `stop --purge` delete engine data; **neither touches the
  workspace** (only `nano clean --workspace` does, explicitly).

## Invariants to preserve

- `start` must refuse to run over a live cluster unless `--force`.
- `start` must pre-flight that target ports are free.
- `start` must point every node at the **same** workspace dir (shared models/workers).
- `stop` must always clear the state file (even on partial failure) so a stale
  marker never permanently blocks future starts.
- `stop` keeps `data/` unless `--purge`; the workspace is never removed by `stop`.
- `clean` must refuse while any node is alive, and must preserve the workspace
  unless `--workspace` is given.
- Single-node (`nano start` with no count) must be byte-equivalent to a normal
  single-node nanobpmn launch (no `NANOBPMN_NODES`, RF=1, no Raft) apart from the
  managed data/workspace dirs.

## Local dev loop

```bash
node --check c8ctl-plugin.js                       # syntax
c8ctl load plugin --from file://$(pwd)             # install
c8ctl help | grep nano                             # verify registration
c8ctl nano start 3 && c8ctl nano status            # smoke test
c8ctl nano stop --purge                            # clean up
```

Requires a built nanobpmn binary (see README "Locating the binary").

## Platform binary packages

The server binary ships per platform as `@nanobpm/c8ctl-plugin-nano-<os>-<arch>`
(optionalDependencies of the root meta-package). `platforms.mjs` is the single
source of truth; `scripts/{build,stamp-optional-deps,publish}-platform-packages.mjs`
and runtime resolution (`platformForHost`) all read it, so adding a target is a
one-row edit there plus a matching cross-compile leg in the Nano BPM CI that
uploads an asset named exactly `PLATFORMS[].asset`.

- **32-bit ARM caveat:** `process.arch` is `'arm'` for *both* armv6 and armv7,
  so those two packages share `os:linux`/`cpu:arm` and npm installs both on any
  ARM32 host. `platformForHost` disambiguates at runtime via the host ARM
  version (`process.config.variables.arm_version`), preferring the exact build
  and falling back to armv6 (which also runs on armv7) when unknown.
- **Bootstrapping a NEW platform package (one-time):** OIDC trusted publishing
  needs the package to already exist on npm, so a brand-new package name must be
  published once with a token before CI can take over. From a clean checkout
  with the real binary assets in `./binaries` (download the rolling `binaries`
  release, which only carries the new assets after the Nano BPM CI has run a
  tagged release):
  ```bash
  npm whoami                                     # be logged in (token/2FA)
  node scripts/build-platform-packages.mjs <version> ./binaries
  cd npm-platforms/@nanobpm/c8ctl-plugin-nano-linux-armv7 && npm publish --access public && cd -
  cd npm-platforms/@nanobpm/c8ctl-plugin-nano-linux-armv6 && npm publish --access public && cd -
  ```
  Then on npmjs.com add a **Trusted Publisher** for each new package pointing at
  `jwulf/c8ctl-plugin-nano` → `release.yml`. After that, `release.yml` publishes
  them via OIDC like every other package. Until the Trusted Publisher exists,
  `publish-platform-packages.mjs` records the package as missing and fails the
  run *without* publishing the root meta-package (so installs never point at a
  version whose platform packages are absent).

## Quality bar before considering work done

- `node --check c8ctl-plugin.js` passes.
- For any change under `supervisor/src/**`: `npm run typecheck:supervisor`,
  `npm run build:supervisor`, and `npm run test:supervisor` all pass, and the
  regenerated `supervisor.dist.js` is committed.
- The plugin loads and `c8ctl nano` prints usage.
- A multi-node `start` → `status` → `stop` cycle leaves no orphan processes and
  no stale state file.
