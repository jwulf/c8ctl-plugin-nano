# AGENTS.md — c8ctl-plugin-nano

Implementation contract for coding agents working on this plugin.

## What this is

A [c8ctl](https://github.com/camunda/c8ctl) plugin that manages a local
[nanobpmn](https://github.com/jwulf/nano-bpm) cluster via a single `nano`
command (`start|status|stop|logs|restart`).

## Plugin contract

- Entry point is **`c8ctl-plugin.js`** (plain ESM JavaScript — Node.js does not
  strip TypeScript types inside `node_modules`, so do not introduce a TS build).
- Required export: `commands` (an object keyed by command name).
- Optional export: `metadata` (drives `c8ctl help` text and examples).
- `package.json` `keywords` must include `c8ctl` and `c8ctl-plugin`.
- The command name is `nano`; do not rename it to a built-in (`list`, `get`,
  `create`, `deploy`, …) — built-ins always win.

## Runtime APIs

At runtime c8ctl injects `globalThis.c8ctl`. This plugin only uses
`globalThis.c8ctl.getLogger()` (output-mode aware). Always go through the local
`getLogger()` helper, which falls back to `console` when run outside c8ctl.

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

## Quality bar before considering work done

- `node --check c8ctl-plugin.js` passes.
- The plugin loads and `c8ctl nano` prints usage.
- A multi-node `start` → `status` → `stop` cycle leaves no orphan processes and
  no stale state file.
