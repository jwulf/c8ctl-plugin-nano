# c8ctl-plugin-nano

A [c8ctl](https://github.com/camunda/c8ctl) plugin that starts, inspects, and
stops a local [Nano BPM](https://github.com/jwulf/nano-bpm) (`nanobpmn`) cluster.

It adds a single `nano` command:

```bash
c8ctl nano start|status|stop|logs|restart
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

# Tail a node's log (-f / --follow to stream)
c8ctl nano logs 1 --follow

# Stop the cluster (engine data is retained)
c8ctl nano stop

# Stop the cluster and delete per-node engine data
c8ctl nano stop --purge

# Stop then start fresh
c8ctl nano restart 3
```

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

Partition ownership is deterministic (`partition_id % num_nodes`), so the nodes
agree on the cluster map with no coordinator. With `RF=1` each partition lives on
one node and the others forward to it; with `RF>1` partitions are Raft-replicated
across nodes.

## Locating the binary

The plugin needs a built `nanobpmn` server binary. Resolution order:

1. `--binary <path>`
2. `NANOBPMN_BINARY=<path>`
3. `release` build under the nanobpmn repo
4. `debug` build under the nanobpmn repo

The repo root defaults to `~/workspace/nanobpmn` and can be overridden with
`NANOBPMN_REPO`. Build a binary with:

```bash
cd ~/workspace/nanobpmn && make release-gateway   # API-only gateway
# or
cd ~/workspace/nanobpmn && make release            # includes the web console
```

## State & data locations

State, logs, and per-node data live under a per-user directory (override with
`C8CTL_NANO_HOME`):

- **macOS**: `~/Library/Application Support/c8ctl-nano`
- **Linux**: `$XDG_DATA_HOME/c8ctl-nano` (or `~/.local/share/c8ctl-nano`)
- **Windows**: `%LOCALAPPDATA%\c8ctl-nano`

```
<home>/cluster.json        # tracked cluster: nodes, pids, ports, config
<home>/data/node-<i>/      # per-node engine data (journal, spill, snapshots)
<home>/logs/node-<i>.log   # per-node stdout/stderr
```

`nano stop` removes the state file but keeps `data/` by default so you can stop a
cluster and keep your journals; pass `--purge` to delete engine data too.

## Flags

| Flag           | Applies to | Description                                              |
|----------------|------------|---------------------------------------------------------|
| `--port`       | start      | Base HTTP port; node *i* listens on `basePort+i` (8080)  |
| `--partitions` | start      | Total partitions across the cluster (default node count) |
| `--rf`         | start      | Replication factor; `>1` enables Raft (default `1`)      |
| `--raft`       | start      | Force Raft on (default: on iff `rf>1`)                   |
| `--binary`     | start      | Path to the nanobpmn server binary                       |
| `--force`      | start      | Stop any existing cluster first                          |
| `--purge`      | stop       | Also delete per-node engine data                         |
| `--follow`,`-f`| logs       | Stream log output (`tail -F`)                            |

## Installing

```bash
c8ctl load plugin --from file:///path/to/c8ctl-nano
```

Then verify it shows up:

```bash
c8ctl help | grep nano
```
