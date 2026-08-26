# AGENTS.md — c8ctl-plugin-nano

Implementation contract for coding agents working on this plugin.

## What this is

A [c8ctl](https://github.com/camunda/c8ctl) plugin that manages a local
[nanobpmn](https://github.com/jwulf/nano-bpm) cluster via a single `nano`
command (includes `start|status|stop|logs|restart|hire|work`).

## Plugin contract

- Entry point is **`c8ctl-plugin.js`** (plain ESM JavaScript — Node.js does not
  strip TypeScript types inside `node_modules`, so do not introduce a TS build).
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

## ACP harness mode (opt-in)

An agent can be driven over **ACP (Agent Client Protocol)** instead of the
default stdin/scrape pipe: `hire --protocol pipe|acp` (default `pipe`) selects
the harness; `NANO_AGENTIC_PROTOCOL` overrides at work time. `pipe` stays the
default floor — ACP is purely additive. `spawnCaptureAcp` is the third executor
alongside `spawnCaptureOneShot` (pipe) and `spawnCapturePty` (PTY); it returns
the **same** result shape so `buildResultEnvelope` and callers are unchanged.

- **Wire framing is newline-delimited JSON-RPC 2.0 over stdio — NOT LSP
  `Content-Length` headers.** One compact JSON object per line, `\n`-terminated.
  Assuming LSP-style framing is the natural wrong guess and will silently fail
  to parse. Client sequence: `initialize` → `session/new {cwd,mcpServers:[]}` →
  `session/prompt {sessionId, prompt:[{type:text,text}]}`; end-of-turn is the
  `session/prompt` **result** resolving (`stopReason`). Agent→client traffic is
  `session/update` notifications and `session/request_permission` requests.
- **Steering is PTY-free:** a mid-turn steer is just a second `session/prompt`
  on the live session; interrupt is a `session/cancel` notification. The ACP
  path must **not** require `node-pty`. Wire this through `relayTap.attachSteer`.
- **Producer has two modes on the relay lane.** Minimal mode serializes each
  `session/update` to a human-readable text chunk via `relayTap.onData(text)`
  (zero downstream changes). Rich mode publishes typed `nwfTranscriptEvent`
  envelopes (`{type:'nwfTranscriptEvent',v:1,ts,kind,role?,text?,tool?,entries?}`)
  via `relayTap.relayEnvelope` (= `relaySession.relay(JSON+\n)`); unmapped
  updates fall back to the text chunk. Relay **transport** (ring/QoS/offsets/
  jobKey routing) is unchanged — only the payload format differs. Never tee raw
  JSON-RPC onto the relay.
- **Permission policies — only `yolo` is enforced.** `hire --permission
  yolo|escalate|filter` (default `yolo`); `NANO_AGENTIC_PERMISSION` overrides at
  work time. `yolo` auto-allow-always is the *only* fully-implemented policy.
  **`escalate` and `filter` are RESERVED / not yet active** — accepted and
  persisted for forward-compat, but at runtime they fall back to a safe interim
  policy pending companion `nano-workforce#559` (the permission-event +
  escalation bridge). This is security-relevant: do **not** describe, document,
  or assume escalate/filter gate destructive ops today. The fallback must stay
  **non-silent** (a one-time `logger.warn` at hire and per session) so an
  operator is never misled — keep the `// TODO(#559)` seam in the permission
  switch, and keep the switch total.

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

## How a cluster is modelled

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
- The plugin loads and `c8ctl nano` prints usage.
- A multi-node `start` → `status` → `stop` cycle leaves no orphan processes and
  no stale state file.

## Known test flakes (don't chase these)

- **`supervisor-daemon.test.mjs` — "supervisor add --instances N …"** is
  order-dependent: it **fails under the full `npm test` on clean `origin/main`**
  (a spawned child's `--name` doesn't match the supervisor id) but **passes when
  that file is run in isolation** (`node --test supervisor-daemon.test.mjs`).
  This is a pre-existing flake, not caused by any current work. When validating
  a change, treat the suite as green *modulo this one failure*; confirm your work
  in isolation rather than assuming you broke it. (Only genuinely fix it as a
  deliberate, separate task.)
