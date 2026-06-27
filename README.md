# c8ctl-plugin-nano

A [c8ctl](https://github.com/camunda/c8ctl) plugin that starts, inspects, and
stops a local Nano BPM (`nanobpmn`) cluster.

It adds a single `nano` command:

```bash
c8ctl nano start|status|stop|restart|logs|clean|set|config
```

`nano start N` spawns **N** nanobpmn node processes wired to talk to each other
on `localhost` (round-robin partition ownership), tracks them in a state file,
and waits until every node is reachable.

## Usage

```bash
# Start a single-node cluster (port 8080)
c8ctl nano start

# Start a 3-node cluster (ports 8080, 8081, 8082)
c8ctl nano start 3

# Start a 3-node Raft-replicated cluster (RF=3 enables Raft automatically)
c8ctl nano start 3 --rf 3

# Choose a different base port (nodes -> 9000, 9001, 9002)
c8ctl nano start 3 --port 9000

# Override the partition count (default = node count)
c8ctl nano start 3 --partitions 6

# Show cluster status and per-node health
c8ctl nano status

# Inspect a cluster c8ctl did NOT start (queries /v2/topology on the given port)
c8ctl nano status --port 8080

# Tail a node's log (-f / --follow to stream)
c8ctl nano logs 1 --follow

# Simulate a node failing (freeze it) and recovering (resume it)
c8ctl nano pause 1
c8ctl nano resume 1

# Stop the cluster (engine data is retained)
c8ctl nano stop

# Stop the cluster and delete per-node engine data
c8ctl nano stop --purge

# Stop then start fresh
c8ctl nano restart 3

# Wipe journal/data + logs from disk (keeps models & workers)
c8ctl nano clean

# Persist settings
c8ctl nano set bin   ~/workspace/nanobpmn/server/target/release/nanobpm-gateway-rest-server
c8ctl nano set model-dir ~/bpmn-workspace

# Show current configuration and on-disk locations
c8ctl nano config
```

## Persistent assets: models & workers

Nano BPM separates **persistent authoring assets** (BPMN models and worker code)
from **ephemeral engine data** (journal, snapshots, variable spill):

- **Workspace** (`NANOBPMN_WORKSPACE_DIR`) — holds `models/` and `workers/`. It is
  the authoring source of truth, **shared by every node**, and is **never** deleted
  by `stop` or `clean`.
- **Engine data** (`NANOBPMN_DATA_DIR`) — per-node journal/snapshots/spill. Ephemeral;
  removed by `stop --purge` and `clean`.

The plugin points every node at one shared workspace so a model deployed once is
visible cluster-wide and survives restarts. By default it lives at
`<state home>/workspace`; change it with:

```bash
c8ctl nano set model-dir ~/bpmn-workspace
```

This creates `~/bpmn-workspace/models/` and `~/bpmn-workspace/workers/`. Restart a
running cluster for a workspace change to take effect.

## Cleaning up disk

```bash
c8ctl nano clean              # remove engine data + logs (cluster must be stopped)
c8ctl nano clean --workspace  # ALSO delete models & workers (destructive!)
c8ctl nano stop --purge       # stop and remove engine data in one step
```

`clean` refuses to run while any node is alive.

## Configuration (`set` / `config`)

Persistent settings are stored in `<state home>/config.json`:

| Setting             | Env mapping              | Set with                          |
|---------------------|--------------------------|-----------------------------------|
| Binary path         | (used to launch nodes)   | `c8ctl nano set bin <path>`       |
| Workspace directory | `NANOBPMN_WORKSPACE_DIR` | `c8ctl nano set model-dir <path>` |

Show the effective configuration and all on-disk locations with `c8ctl nano config`.

## Checking status

`c8ctl nano status` queries each node's always-on `GET /v2/topology`, which is the
authoritative cluster view. Because of this it works in three situations:

- **c8ctl-managed cluster** — shows per-node process liveness (PID), reachability,
  and the live topology (partition leadership).
- **External cluster** — a Nano BPM cluster started outside c8ctl (e.g. by hand,
  a script, or another tool). With no recorded state, status probes
  `http://127.0.0.1:<port>/v2/topology` and reports what it finds, labelled
  `(external — not started by c8ctl)`.
- **Nothing running** — reports `stopped`.

Point status at a specific endpoint with `--port`:

```bash
c8ctl nano status            # default: managed cluster, else probe port 8080
c8ctl nano status --port 9000
```

### Camunda vs Nano detection

Nano advertises itself in `GET /v2/topology` with a `nano` object
(`engine: "nanobpmn"`) — a superset of the Camunda Orchestration Cluster API.
A stock Camunda gateway answers the same endpoint without it, so `status` can
tell the two apart and prints a `product:` line (`Nano BPM` or `Camunda`) with
the version. If `status` finds a Camunda gateway on the probed port it says so
explicitly rather than pretending it is a Nano cluster.

For the same reason, `c8ctl nano start` refuses to launch on top of an existing
gateway. If any chosen port is already serving a Camunda (or Nano) endpoint it
reports exactly what is running and exits without starting:

```
✗ Port 8080 is already serving a Camunda gateway (v8.6.0).
✗ Refusing to start Nano on top of a running Camunda instance.
Start on a free base port instead, e.g. "c8ctl nano start 1 --port 8180".
```

To run Nano alongside a local Camunda, give it a different base port
(`--port`); the collision check only applies to the ports Nano would bind.

## Fault injection: pause / resume a node

`c8ctl nano pause <nodeId>` and `c8ctl nano resume <nodeId>` let you simulate a
node failing and coming back online, to exercise Raft failover and recovery on a
local cluster:

```bash
c8ctl nano start 3 --rf 3   # 3-node Raft-replicated cluster
c8ctl nano pause 1          # freeze node 1 (SIGSTOP) — like a hang or partition
c8ctl nano status           # node 1 shows "paused"; the cluster is "degraded"
c8ctl nano resume 1         # unfreeze node 1 (SIGCONT) — it rejoins
```

- **pause** sends `SIGSTOP`, which halts the process instantly and *cannot be
  caught or ignored* — so the node stops responding without losing its PID or its
  on-disk state, faithfully mimicking a hung/partitioned node.
- **resume** sends `SIGCONT`, and the process continues exactly where it left off.
- A paused node is reported as `paused` in `c8ctl nano status` and counts as
  unhealthy, so the cluster shows `degraded`.
- `c8ctl nano stop` automatically resumes any paused node first, so it can shut
  down gracefully rather than being force-killed.

## Trace capture for historical replay (`--capture`)

Start a cluster with `--capture` to record every instance's inputs so runs can be
replayed and analysed later:

```bash
c8ctl nano start 3 --capture
c8ctl nano status            # shows "trace capture: on"
```

`--capture` sets `NANOBPMN_TRACE_STIMULI=1` on **every** node. That single flag
enables the Tier 2 recorded-input (stimuli) log *and* auto-enables Tier 1 variable
capture. It must be set on all nodes because each node's `TraceStore` only sees
instances on its own partitions.

Read a trace back from any node:

```
GET /console/api/traces/{instanceKey}
  → { creationVariables, stimuli[], <per-incident variables> }
```

Optional tuning is done with environment variables, which pass through from your
shell automatically (no dedicated flags):

| Env var                            | Default | Purpose                              |
|------------------------------------|---------|--------------------------------------|
| `NANOBPMN_TRACE_VARIABLES_MAX_BYTES` | 16384 | Max captured variable payload bytes  |
| `NANOBPMN_TRACE_STIMULI_MAX`         | 1024  | Max recorded stimuli per instance    |
| `NANOBPMN_TRACE_CAPACITY`            | 2000  | Max traced instances retained        |

> Setting `NANOBPMN_TRACE_VARIABLES=1` alone enables only Tier 1 (variables); use
> `--capture` for full recorded-input replay.

## How nodes are configured

Each node is the single `nanobpmn` server binary, configured entirely through
environment variables. For `nano start 3` the plugin spawns:

| Node | `PORT` | `NANOBPMN_NODE_ID` | `NANOBPMN_NODES`                                                   |
|------|--------|--------------------|--------------------------------------------------------------------|
| 0    | 8080   | 0                  | `http://127.0.0.1:8080,http://127.0.0.1:8081,http://127.0.0.1:8082` |
| 1    | 8081   | 1                  | (same)                                                             |
| 2    | 8082   | 2                  | (same)                                                             |

Additionally every node gets:

- `NANOBPMN_PARTITIONS` — total partitions (default = node count)
- `NANOBPMN_RF` — replication factor (default `1`)
- `NANOBPMN_RAFT=1` — set automatically when `RF > 1` (or via `--raft`)
- `NANOBPMN_DATA_DIR` — a per-node engine data directory
- `NANOBPMN_DURABILITY=async` — set by default for throughput; override by
  exporting `NANOBPMN_DURABILITY` (e.g. `sync`) before `nano start`
- `NANOBPMN_REPLICATE_ACTIVATION=digest` — set by default so activated-job
  state is observable across the cluster; override by exporting
  `NANOBPMN_REPLICATE_ACTIVATION` before `nano start`
- `NANOBPMN_REPLICATION=leader-durable` — set by default; override by exporting
  `NANOBPMN_REPLICATION` before `nano start`
- `NANOBPMN_WORKSPACE_DIR` — the shared workspace (models & workers)
- `NANOBPMN_TRACE_STIMULI=1` — set on every node when `--capture` is passed

Partition ownership is deterministic (`partition_id % num_nodes`), so the nodes
agree on the cluster map with no coordinator. With `RF=1` each partition lives on
one node and the others forward to it; with `RF>1` partitions are Raft-replicated
across nodes.

## Locating the binary

The plugin needs a built `nanobpmn` server binary. Resolution order:

1. `--binary <path>`
2. configured path (`c8ctl nano set bin <path>`)
3. `NANOBPMN_BINARY=<path>`
4. `release` build under the nanobpmn repo
5. `debug` build under the nanobpmn repo

The repo root defaults to `~/workspace/nanobpmn` and can be overridden with
`NANOBPMN_REPO`. Build a binary with:

```bash
cd ~/workspace/nanobpmn && make release-gateway   # API-only gateway
# or
cd ~/workspace/nanobpmn && make release            # includes the web console
```

## State & data locations

State, config, logs, per-node data, and the workspace live under a per-user
directory (override with `C8CTL_NANO_HOME`):

- **macOS**: `~/Library/Application Support/c8ctl-nano`
- **Linux**: `$XDG_DATA_HOME/c8ctl-nano` (or `~/.local/share/c8ctl-nano`)
- **Windows**: `%LOCALAPPDATA%\c8ctl-nano`

```
<home>/config.json         # persistent settings (binary path, workspace dir)
<home>/cluster.json        # tracked cluster: nodes, pids, ports, config
<home>/data/node-<i>/      # per-node engine data (journal, spill, snapshots) — ephemeral
<home>/logs/node-<i>.log   # per-node stdout/stderr
<home>/workspace/          # default shared workspace (models/, workers/) — persistent
```

`nano stop` removes the state file but keeps `data/` by default so you can stop a
cluster and keep your journals; pass `--purge` to delete engine data too. The
workspace is never removed except by `nano clean --workspace`.

## Flags

| Flag           | Applies to | Description                                              |
|----------------|------------|----------------------------------------------------------|
| `--port`       | start      | Base HTTP port; node *i* listens on `basePort+i` (8080)  |
| `--partitions` | start      | Total partitions across the cluster (default node count) |
| `--rf`         | start      | Replication factor; `>1` enables Raft (default `1`)      |
| `--raft`       | start      | Force Raft on (default: on iff `rf>1`)                   |
| `--capture`    | start      | Enable trace capture (recorded-input replay) on every node |
| `--binary`     | start      | Path to the nanobpmn server binary (overrides `set bin`) |
| `--force`      | start      | Stop any existing cluster first                          |
| `--purge`      | stop       | Also delete per-node engine data                         |
| `--workspace`  | clean      | Also delete the workspace (models + workers)             |
| `--follow`,`-f`| logs       | Stream log output (`tail -F`)                            |

## Installing

```bash
c8ctl load plugin --from file:///path/to/c8ctl-nano
```

Then verify it shows up:

```bash
c8ctl help | grep nano
```
