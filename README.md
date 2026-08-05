# c8ctl-plugin-nano

A [c8ctl](https://github.com/camunda/c8ctl) plugin that starts, inspects, and
stops a local Nano BPM (`nanobpmn`) cluster.

## About Nano BPM

**A Rust research engine exploring high-performance BPMN execution and Camunda 8
compatibility.**

Nano BPM (`nanobpmn`) is a single self-contained binary that runs BPMN processes
behind a **Camunda 8-compatible v2 REST API**. It embeds a deterministic,
event-sourced BPMN engine (`engine-core`), an append-only journal for crash
durability, an SQLite-backed read model, optional multi-node Raft replication,
and a built-in web console — all in one executable with no runtime dependencies.

It is an advanced research prototype: a place to explore what a faster, smaller,
faster-to-iterate-on process engine can do, while staying API-compatible with
existing Camunda 8 clients and tooling. This plugin is the easiest way to run and
manage it — single node or a whole cluster — shipping a prebuilt binary for your
platform so there is nothing to compile.

It adds a single `nano` command:

```bash
c8ctl nano start|status|stop|restart|logs|pause|resume|clean|set|config|update
c8ctl nano hire|assign|work   # hire/assign manage agent profiles; work runs one as a Nano job worker
```

`nano start N` spawns **N** nanobpmn node processes wired to talk to each other
on `localhost` (round-robin partition ownership), tracks them in a state file,
and waits until every node is reachable.

## Installation

This is a plugin for the [Camunda 8 CLI](https://www.npmjs.com/package/@camunda8/cli)
(`c8ctl`). Install the CLI, then load the plugin from npm:

```bash
# 1. Install the Camunda 8 CLI (once); requires Node.js 18+
npm install -g @camunda8/cli

# 2. Load this plugin from the npm registry
c8ctl load plugin c8ctl-plugin-nano

# 3. Verify it's available
c8ctl nano --help
```

The prebuilt Nano BPM server binary for your platform is pulled in automatically
as an npm `optionalDependency`, so there is nothing to compile. To pull a newer
release later, run `c8ctl nano update` (see
[Updating to a new release](#updating-to-a-new-release-update)).

> Loading from a local checkout instead? Use
> `c8ctl load plugin --from file:///path/to/c8ctl-nano`.

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

# Tail a node's log (-f / --follow to stream). Node ids are 0-indexed,
# so a single-node cluster is node 0.
c8ctl nano logs 0 --follow

# Simulate a node failing (freeze it) and recovering (resume it)
c8ctl nano pause 0
c8ctl nano resume 0

# Stop the cluster (engine data is retained)
c8ctl nano stop

# Stop the cluster and delete per-node engine data
c8ctl nano stop --purge

# Stop then start fresh
c8ctl nano restart 3

# Restart from a clean slate (delete engine data, keep models & workers)
c8ctl nano restart --purge

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

## CLI agent workers: `hire` / `work`

Beyond BPMN service-task workers (code in the workspace `workers/` dir), the
plugin can turn an interactive **CLI agent harness** (Copilot CLI, Claude CLI,
`pi`, "little coder", …) into a Nano job worker.

**`hire`** persists an agent *profile* — a name, a **rank**
(`principal|senior|junior|decider`), the **command** that starts the CLI, a
**model** name, and a list of **capabilities**:

```bash
# Interactive
c8ctl nano hire

# Or non-interactively
c8ctl nano hire --name reviewer --rank senior --command copilot \
  --model gpt-5 --capabilities code-review,testing

# Give the harness command-line switches (e.g. run copilot with --allow-all)
c8ctl nano hire --name coder --rank senior --command copilot --arg --allow-all

# List profiles
c8ctl nano hire --list
```

**`assign <name> [capabilities...]`** grants new capabilities (roles) to an
existing hire without re-running `hire`. Capabilities are **added** to (unioned
with) the profile's current set — `assign` never removes a role — and the
updated job-type matrix is printed. Restart the profile's workers so they pick
up the new job types:

```bash
# Give an existing reviewer two more capabilities
c8ctl nano assign reviewer triage refactoring

# --capabilities works too (comma-separated), equivalent to the positionals above
c8ctl nano assign reviewer --capabilities triage,refactoring

# then restart its workers to service the new job types
c8ctl nano work reviewer
```


**`work <name>`** loads the profile, connects with the c8ctl SDK client, and
registers one job worker per token in the **rank × capability matrix**, then
polls for work in the foreground until Ctrl-C. For rank `senior` and
capabilities `code-review, testing` the matrix is:

| Token | Meaning |
| --- | --- |
| `senior` | rank alone |
| `senior:code-review` | rank + one capability (spread) |
| `senior:testing` | rank + one capability (spread) |
| `senior:code-review+testing` | rank + all capabilities, sorted (combined) |

so a BPMN service task can target a worker at any granularity by setting its job
type to the matching token.

To also service a job type the matrix can't express — for example a code-first
[`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow) flow whose
external task type is `<flowId>:<taskName>`, or any bespoke token — add one or
more `--job-type <token>` flags. They are serviced **in addition to** the
rank×capability matrix, so a single hired reviewer can drive both a model-first
`senior:pr-review` task and a code-first flow's task without re-hiring:

```bash
c8ctl nano work reviewer --job-type convergence-loop:review-round
c8ctl nano work reviewer --job-type senior:pr-review --job-type senior:triage
```

```bash
c8ctl nano work reviewer                     # poll for work until Ctrl-C
c8ctl nano work reviewer --max-parallel 2 --job-timeout 600000
```

Each activated job runs the profile's command **once** (one-shot): the job is
serialized to JSON and piped to the CLI's **stdin** —

```json
{ "jobKey": "...", "jobType": "senior:code-review", "processInstanceKey": "...",
  "prompt": "<variables.prompt ?? variables.task>", "variables": {},
  "profile": { "name": "reviewer", "rank": "senior", "model": "gpt-5",
               "capabilities": ["code-review", "testing"] } }
```

and the profile/model are also exported as `AGENT_PROFILE`, `AGENT_RANK`,
`AGENT_MODEL`, `AGENT_CAPABILITIES`, `AGENT_JOB_TYPE` env vars. On exit `0` the
job is **completed** with `{ output: <stdout>, exitCode: 0 }` (captured output is
capped at 1 MiB, with a `truncated` flag when exceeded); any other exit **fails**
the job with a decremented retry count, and a job that outlives `--job-timeout`
is killed. Profiles are stored in the plugin's `config.json` (see `c8ctl nano
config`).

> **Activation lock vs. kill deadline.** `--job-timeout` is the harness *kill*
> deadline. The broker's job-activation lock is derived as `--job-timeout +
> --lock-grace` (grace defaults to `120000`ms) so it strictly outlasts the kill:
> the worker always reports the outcome (complete/fail) before the lock lapses.
> Without that gap a lock expiring exactly as the harness dies lets the broker
> re-activate the still-retryable job (a second agent starts) and the stale
> `fail` is rejected with a 409 "job cannot be failed in the current state".
> Raising `--job-timeout` alone does **not** fix this — it moves both coupled
> deadlines together; widen `--lock-grace` (or keep the default) instead.

> **Long-poll window.** `--poll-timeout` (default `30000`ms) is how long the
> broker holds each `activateJobs` request open waiting for work before returning
> empty. A longer window keeps an idle worker on **one** connection for that whole
> window instead of reconnecting every few seconds — cutting the number of
> connection establishments, and thus the chances of hitting a transient connect
> error (`ECONNREFUSED` / connect-timeout) on a flaky link. It maps straight to
> the SDK's `pollTimeoutMs` → the broker's `requestTimeout`: `0` selects the
> broker's own default (~5s) and a negative value returns immediately when no job
> is available.

> **Trust boundary.** The profile `command` is run through a shell so you can
> write a full invocation (args, pipes, multi-word commands). It is
> **operator-authored** — only what you put in your own `config.json` is
> shell-interpreted. Untrusted job data reaches the harness solely as stdin JSON
> and `AGENT_*` env vars, never interpolated into the command line, so process
> variables cannot inject shell commands.

### Task envelope, sandboxes & disk hygiene

For **agentic** jobs (an agent that clones a repo, works a task, pushes a
branch) the job carries a structured **task envelope** under the reserved
`io.nanobpm.agentTask` namespace. It is assembled from the job's static
`customHeaders` (model-authored defaults) deep-merged with per-instance
`variables` (**overrides win**), then normalized to schema v1 and included in the
stdin payload as `task`:

```jsonc
{
  "io.nanobpm.agentTask.repository.url": "https://github.com/o/r.git", // header
  "io.nanobpm.agentTask.repository.ref": "main",
  "io.nanobpm.agentTask.branch.push":    "true",
  "io.nanobpm.agentTask.task.allowPr":   "false"
}
```

Element templates emit flat dotpath header keys (strings); the plugin expands
them into a nested object and coerces `"true"/"false"` → bool and numeric
strings → int. The normalized shape is
`{ schemaVersion, repository{provider,url,ref,depth,submodules,authRef}, branch{base,create,push}, setup{commands,env,secretRefs}, task{prompt,promptFile,maxIterations,timeoutMs,allowPr,prBase} }`.

**Prompt = base + optional verbatim append.** The agent's prompt resolves to
`task.prompt` (typically a model header filled at deploy time), falling back to a
plain `prompt`/`task` variable. Because a header-delivered base prompt can't be
composed in FEEL, a task may supply per-instance context via **`task.appendPrompt`**
(reserved) or a plain **`appendPrompt`** variable — it is concatenated onto the base
**verbatim, with no injected separator** (the model's ioMapping owns any leading
separator/preamble), so a null/empty append leaves the base untouched. This lets the
static prompt live in a model header/side-car while the dynamic tail (e.g. plan-revision
feedback, a per-task brief) is built per instance.
On completion the plugin writes an **output envelope** back under
`io.nanobpm.agentResult` (`{schemaVersion, status, sandbox, image, output, truncated, stderrTruncated, exitCode, signal, error}`). When a repository was
provisioned (below) it also carries `{repository, branch, baseSha, headSha, commits[], pushed, pushError?, gitError?, pr?}`.

**Git provisioning (host).** When `--sandbox none` (the default) and the envelope
carries a `repository.url`, the plugin provisions a workspace on the host around
the harness:

1. resolve the optional repo credential (`repository.authRef`, or `GITHUB_TOKEN`
   for GitHub) — absent ⇒ anonymous clone;
2. `git clone` (honouring `depth`/`submodules`, and `repository.ref`/`branch.base`
   as the checkout target) into a throwaway workspace under
   `<state>/agent-runs/run-*`;
3. create `branch.create` (if set) off that target;
4. run the harness **in the workspace** (`cwd`), with `AGENT_WORKSPACE`,
   `AGENT_REPO_URL`, `AGENT_REPO_BRANCH`, `AGENT_REPO_REF` exported and the job
   envelope on stdin;
5. on success, enumerate new commits, `git push` the branch when `branch.push`
   (default true), and — when `task.allowPr` — **reconcile the PR the agent
   opened** for the branch (`gh pr list --head <branch>`; `openedBy` reports the
   PR's actual author login, or `null` when none is found).

The token is delivered to git via `GIT_ASKPASS` (env), never on argv or in the
remote URL, and is redacted from all logs/results. Credential helpers are
**always** disabled for the clone/fetch/push (`-c credential.helper=`), even when
a token is present, so a helper like `store`/keychain can never persist the
job's token to disk — `GIT_ASKPASS` supplies the secret directly. When **no**
token is resolved the clone is *additionally* anonymous **for HTTPS remotes**:
inherited `GIT_ASKPASS`/`SSH_ASKPASS` are cleared, and the operator's global git
config is neutralized (`GIT_CONFIG_GLOBAL` → the platform null device,
`/dev/null` or `NUL` on Windows) so knobs like `http.*.extraHeader`
or `url.*.insteadOf` can't silently inject operator credentials. (An **SSH**
remote — `git@…`/`ssh://…` — can still authenticate via the host's SSH
agent/config; use HTTPS URLs if you need a guaranteed-anonymous clone.)
Token-backed jobs keep global config (e.g. `http.proxy`). A push failure is
reported as `pushError` (the job still completes) so a later BPMN step can drive
the merge; a clone/checkout failure sheds the job (retryable). Workspaces are
deleted after each job (keep them with `--keep-runs`).

```bash
# The harness sees a cloned repo at $AGENT_WORKSPACE; branch/push/PR are handled for it.
c8ctl nano work coder            # sandbox=none: repository-bearing jobs are provisioned on the host
```

**Sandbox.** By default the command runs on the host (`--sandbox none`). Pass
`--sandbox docker` (or `podman`) with an `--image` to run **each job in a
throwaway container** instead:

```bash
c8ctl nano hire --name coder --rank senior --command "agent-harness" \
  --sandbox docker --image ghcr.io/acme/agent:1
c8ctl nano work coder                 # uses the profile's sandbox/image
c8ctl nano work coder --sandbox docker --image ghcr.io/acme/agent:1   # or override
```

Containers are labelled (`nano.managed=1`, `nano.worker`, `nano.jobKey`,
`nano.run=<uuid>`), log-capped (`max-size=10m max-file=3`), run with `--rm`, and
a run that outlives `--job-timeout` is force-removed. The envelope is piped on
the container's stdin exactly as on the host. (Container-side git provisioning —
strong isolation — is a later increment; container jobs don't clone yet.)

**Host workers inherit your credentials.** A host worker (`--sandbox none`, the
default) runs as your user and inherits your full environment and `$HOME`, so
your existing `gh` CLI login (from `gh auth login`) or a `GH_TOKEN`/`GITHUB_TOKEN`
env var is available to the harness with **no extra setup** — handy when the
agent command shells out to `gh`. A **container** sandbox is isolated and does
**not** inherit that host login; provide the token explicitly via
`setup.secretRefs` / `--secret-resolver host` (see **Secrets** below) instead.

**Secrets.** Secrets are referenced by **name**, never value. `setup.secretRefs`
(and the repo/PR credential when `task.allowPr` is set — defaulting to
`GITHUB_TOKEN` for GitHub) are resolved via a pluggable `--secret-resolver`
(only `host`, reading `process.env`, is implemented) and forwarded into the
container by name (`-e NAME`) so values never appear in argv or `docker inspect`.
A missing required secret fails the job with a clear provisioning message.

**Harness env (non-secret).** A harness often needs static startup configuration
— e.g. a permission toggle to start a coding CLI with its tools enabled. Persist
these on the profile at hire time and/or add them at work time (repeatable
`--env NAME=VALUE`); work-time values extend/override the profile's:

```bash
c8ctl nano hire --name coder --rank senior --command copilot --env COPILOT_ENABLE_ALL_TOOLS=1
c8ctl nano work coder --env EXTRA_FLAG=on          # extends/overrides the profile env
```

Interactive `hire` (no `--env`) prompts for these one `NAME=VALUE` at a time
(blank to finish), so values may safely contain `=` or `,`.

They apply on both the host and container paths. Per-job `setup.env` from the
envelope layers on top (job-specific tuning wins), and the reserved `AGENT_*`
variables and resolved secrets always win over user-supplied env so they can't be
shadowed. For **secret** values use `secretRefs`, not `--env`.

**Command-line switches.** Some harnesses take switches rather than env vars —
e.g. `copilot --allow-all`. Append them to the harness command with a repeatable
`--arg` (each `--arg` is one argv token). They are persisted on the profile at
hire time and can be extended at work time:

```bash
c8ctl nano hire --name coder --rank senior --command copilot --arg --allow-all
c8ctl nano work coder --arg --verbose            # appends to the profile args
```

The command is spawned through a shell (so `command` still resolves on `PATH`),
but each `--arg` is shell-quoted as a single literal token, so a value with
spaces or shell metacharacters can't break out or inject. They apply on the
container path on any OS, and on the host path on POSIX systems. **On a Windows
host (`sandbox=none`), `--arg` is rejected** with a clear error — the POSIX
quoting isn't honoured by `cmd.exe` — so use a container sandbox
(`--sandbox docker|podman`) or bake the switches into `--command` there.

**Disk hygiene.** Host job **workspaces** and container sandboxes both get
automatic cleanup so leaked artifacts can't fill the disk. Workspaces under
`<state>/agent-runs` are removed after each job and swept at startup + on
`--reap-interval` (leftovers older than `--reap-age`, in-flight dirs skipped).
For container sandboxes a **label-scoped** reaper runs at worker startup
and on an interval (`--reap-interval`, **milliseconds**, default `300000` = 5m),
removing finished/`exited` containers older than `--reap-age` (**milliseconds**,
default `3600000` = 1h) while **skipping any run still in flight** — it never
touches containers it didn't create and never `system prune`s. A **disk-budget
admission shed** fails (retryable) new jobs when the engine data root has less
than `--min-free-mb` MB free (default `1024`).

> Container-side git provisioning (strong isolation) and the
> Vercel/Sandcastle provider are **later increments** — the envelope names above
> are frozen so the [nano-ide element-template pack](https://github.com/jwulf/nano-ide/issues/37)
> can be built against this contract.

## Cleaning up disk

```bash
c8ctl nano clean              # remove engine data + logs (cluster must be stopped)
c8ctl nano clean --workspace  # ALSO delete models & workers (destructive!)
c8ctl nano stop --purge       # stop and remove engine data in one step
```

`clean` refuses to run while any node is alive.

### Stress / throughput runs: bounding disk and RAM

The engine journal (`journal.jsonl`) is **append-only** — there is currently no
compaction or rotation — and the read-model retains every terminal instance by
default. Under sustained high load (tens of thousands of PI/s) this fills the
disk quickly. Two `start` flags keep a long run bounded:

```bash
# Pure throughput: no journal / read-model on disk at all (in-memory engine).
# State is lost on stop/restart, and instances live in RAM — so cap them.
c8ctl nano start --in-memory --history-max 50000

# Exercise the disk path but cap the read model's terminal-instance history.
# (The journal still grows append-only; watch free space.)
c8ctl nano start --history-max 50000
```

- `--in-memory` (alias `--no-journal`) routes the engine to an in-memory journal
  and a `:memory:` read store — nothing is written under `NANOBPMN_DATA_DIR`.
- `--history-max <n>` sets `NANOBPMN_HISTORY_MAX_INSTANCES`, continuously pruning
  all but the most recent *n* terminal instances from the read model (`0`/unset =
  unbounded). Works in both storage modes.

`c8ctl nano status` reports the active storage mode (`in-memory` vs `on-disk`)
and the history cap.

> ⚠️ With `--in-memory`, restart recovers nothing, and Raft/replicated logs are
> not persisted. Use it for stress/throughput testing, not durability testing.

## Console profile (`--console`)

The server ships a browser console. Pick how much of it is exposed at runtime:

```bash
c8ctl nano start                      # studio (default): full IDE + authoring API
c8ctl nano start --console observe    # observability views only; authoring refused (403)
c8ctl nano start --console off        # headless: no console router at all
```

- Values: `studio` (default), `observe`, `off`. An inherited `NANOBPMN_CONSOLE`
  env var is honored when the flag is not passed. The plugin passes the choice
  through as `NANOBPMN_CONSOLE` on every node.

## Configuration (`set` / `config`)

Persistent settings are stored in `<state home>/config.json`:

| Setting             | Env mapping              | Set with                          |
|---------------------|--------------------------|-----------------------------------|
| Binary path         | (used to launch nodes)   | `c8ctl nano set bin <path>`       |
| Workspace directory | `NANOBPMN_WORKSPACE_DIR` | `c8ctl nano set model-dir <path>` |

Show the effective configuration and all on-disk locations with `c8ctl nano config`.

## Updating to a new release (`update`)

The plugin and the bundled server binary (delivered via the matching platform
package) ship together on npm as `c8ctl-plugin-nano`. To pull a new nanobpmn
release onto a machine that already has nano installed:

```bash
c8ctl nano update          # check npm for a newer release and install it
c8ctl nano update --check  # only report whether an update is available
```

`update` compares the installed plugin version against the latest published on
npm. When a newer release exists it reinstalls the package globally
(`npm install -g c8ctl-plugin-nano@latest`), which brings the new server binary
with it. It only ever drives npm — it never touches the private upstream source —
so it works for any npm-installed user. After updating, restart any running
cluster (`c8ctl nano restart`) so it picks up the new binary.

If the plugin is running from a local checkout rather than a global npm install,
`update` prints the manual command instead of reinstalling in place.

### Automatic "update available" notice

You don't have to remember to run `update --check`: any `nano` or `processos`
command also surfaces a one-line notice when a newer release is published. It is
deliberately unobtrusive:

- The registry lookup runs in a **detached background process**, so a command is
  never slowed down — the fresh result is used on the next invocation.
- npm is queried at most **once per day**, and the notice is shown at most **once
  per day** (state is cached under the plugin's state home in `update-check.json`).
- The notice prints to **stderr**, so it never corrupts machine-readable stdout,
  and is suppressed when stdout is not a TTY (piped/scripted) or when `CI` is set.

To turn it off entirely, set `NANO_NO_UPDATE_NOTIFIER=1` (or the conventional
`NO_UPDATE_NOTIFIER=1`). The explicit `c8ctl nano update` command is unaffected.

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
4. the matching **platform package** (`@nanobpm/c8ctl-plugin-nano-<os>-<arch>`),
   installed automatically as an `optionalDependency` when you install the plugin
   from npm
5. `release` build under the nanobpmn repo
6. `debug` build under the nanobpmn repo

Most users never need a local build: installing the plugin from npm pulls in the
prebuilt binary for their platform (step 4). Steps 5–6 are the local-dev path.

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

ProcessOS flags (`processos` command):

| Flag           | Applies to | Description                                              |
|----------------|------------|----------------------------------------------------------|
| `--port`       | start      | ProcessOS listen port (default 8090)                     |
| `--nano-url`   | start      | Target Nano BPM engine URL (default `http://localhost:8080`) |
| `--binary`     | start      | Path to the ProcessOS binary (overrides `set bin`)       |
| `--spawn-nano` | start      | Force spawning a pilot Nano engine (default on when a nano binary is available) |
| `--no-spawn-nano` | start   | Don't spawn a pilot engine; reuse the `--nano-url` engine |
| `--force`      | start      | Stop any existing ProcessOS instance first               |
| `--follow`,`-f`| logs       | Stream log output (`tail -F`)                            |

## Managing ProcessOS (`processos`)

ProcessOS is the optimization-plane server that analyses a running Nano BPM
engine. The plugin can manage a single local ProcessOS instance with the same
start/stop/status/logs lifecycle as `nano`.

> **ProcessOS is a closed beta.** The operational commands (`start`, `stop`,
> `status`, `logs`, `restart`) stay locked with a *"not available yet"* notice
> until you opt in. Only `set` and `config` work before then. Opt in either by
> setting the download URL you were given by the Nano BPM team, or by pointing
> the plugin at a binary you already have.

### Quick install (closed-beta invitees)

If you were given a ProcessOS download URL, this one-liner installs the Camunda 8
CLI (`@camunda8/cli`) and this plugin, then configures the download URL:

```bash
curl -fsSL https://gist.githubusercontent.com/jwulf/9015a7c660b274c568d80e85c3914161/raw/install-processos.sh \
  | bash -s -- "<the download URL you were given>"
```

(Requires Node.js 18+. The canonical script lives at
[`install-processos.sh`](./install-processos.sh).) Then run `c8ctl processos start`.


```bash
# Closed-beta channel: persist the download URL, then start
c8ctl processos set download-url <url you were given>
c8ctl processos start            # fetches processos-<os>-<arch> on first run

# …or point the plugin at a binary you already have
c8ctl processos set bin ~/Downloads/processos
c8ctl processos start
```

The download URL is the prefix the release binaries live under (e.g. the
`…/processos/latest/` bucket URL). Persist it with `c8ctl processos set
download-url <url>`, or set `PROCESSOS_DOWNLOAD_URL` in your environment (the env
var wins when both are present). The plugin appends the per-platform asset name
(`processos-darwin-arm64`, `processos-linux-x64`, `processos-win32-x64.exe`, …),
downloads it to `<stateHome>/bin/`, marks it executable, and runs it. The cached
download is reused on subsequent starts.

```bash
# Start ProcessOS against the local Nano BPM engine (http://localhost:8080)
c8ctl processos start

# Or against a specific engine, on a specific port
c8ctl processos start --nano-url http://localhost:8080 --port 8090

# Inspect / stream logs / stop
c8ctl processos status
c8ctl processos logs --follow
c8ctl processos stop
```

### Automatic update notice

When you're on the closed-beta channel (download URL configured), the
plugin checks for newer ProcessOS builds in the background and prints a short
one-line notice (at most **once per day**) when the published version is newer
than the one you're running. It compares your installed binary's version against
the `version.json` the release pipeline publishes next to the binaries, never
blocks the command (the check runs detached), and is suppressed on
non-interactive shells, in CI, and when `NO_UPDATE_NOTIFIER` /
`NANO_NO_UPDATE_NOTIFIER` is set. To update, stop and start ProcessOS again — a
downloaded binary re-fetches the latest build; a `set bin` binary updates itself.

On a successful `start` the summary leads with the landing page:

```
  Start here   http://127.0.0.1:8090/          (landing)
  Cockpit      http://127.0.0.1:8090/cockpit
  Health       http://127.0.0.1:8090/health
  Target Nano  http://localhost:8080
```

### Pilot engine (spawned by default)

ProcessOS uses a Nano engine in two roles: the **target** engine it analyses
(read-only, set with `--nano-url`), and its **own** internal "pilot" engine where
it runs experiments. **By default ProcessOS spawns its own pilot engine** as a
child process, so it never disturbs the target:

```bash
c8ctl processos start                 # spawns a pilot engine automatically
c8ctl processos start --no-spawn-nano # reuse the --nano-url engine for the pilot too
```

ProcessOS spawns its pilot engine from a Nano gateway binary given in
`PROCESSOS_NANO_BIN`. The plugin **auto-wires `PROCESSOS_NANO_BIN`** from the same
binary `c8ctl nano` uses (`--binary` / `nano set bin` / `$NANOBPMN_BINARY` / the
platform package / a repo build). A console-enabled nano build is required — the
npm-distributed binaries qualify. The spawned engine is torn down when ProcessOS
stops.

If no nano binary can be found, ProcessOS falls back to `--no-spawn-nano`
automatically (using the target engine as the pilot) and prints a warning. Force
the behaviour explicitly with `--spawn-nano` / `--no-spawn-nano`, override the
binary with `c8ctl processos set env PROCESSOS_NANO_BIN=<path>`, or set the mode
persistently with `c8ctl processos set env PROCESSOS_SPAWN_NANO=false`.

### ProcessOS configuration

Settings persist under a `processos` key in the same `config.json` as `nano`.

```bash
c8ctl processos set bin <path>          # path to the downloaded ProcessOS binary
c8ctl processos set download-url <url>  # closed-beta binary download URL (enables ProcessOS)
c8ctl processos set port <n>            # listen port (default 8090)
c8ctl processos set nano-url <url>      # target Nano BPM engine (default http://localhost:8080)
c8ctl processos set data-dir <path>     # PROCESSOS_DATA_DIR (default <stateHome>/processos-data)
c8ctl processos set env KEY=VALUE       # set any passthrough env var (e.g. PROCESSOS_LLM_MODEL)
c8ctl processos set env KEY=            # unset a passthrough env var
c8ctl processos config                  # show current settings and on-disk paths
```

The binary is resolved in this order: `--binary` flag → `set bin` →
`$PROCESSOS_BINARY` → a cached download under `<stateHome>/bin/` → a local
`processos/target/{release,debug}/processos` build → a fresh download from the
configured download URL (`set download-url` / `$PROCESSOS_DOWNLOAD_URL`). Typed
settings (`port`, `nano-url`, `data-dir`) always
win over generic `env` passthrough values when launching.

## Installing from a local checkout (development)

```bash
c8ctl load plugin --from file:///path/to/c8ctl-nano
```

Then verify it shows up:

```bash
c8ctl help | grep nano
```

For the normal npm install, see [Installation](#installation) above.

## Distribution & releasing

Releases are automated with **semantic-release** (`.github/workflows/release.yml`,
`release.config.cjs`). Pushing conventional commits to `main` cuts a version,
publishes to npm, and creates a GitHub Release.

### Platform packages

The server binary is shipped as a set of platform-specific npm packages, one per
target, gated by npm's `os`/`cpu` fields. They are **scoped under `@nanobpm`** (a
scope we own) so the names can never be squatted or npm-security-held:

| package                                    | os     | cpu   |
|--------------------------------------------|--------|-------|
| `@nanobpm/c8ctl-plugin-nano-darwin-arm64`  | darwin | arm64 |
| `@nanobpm/c8ctl-plugin-nano-darwin-x64`    | darwin | x64   |
| `@nanobpm/c8ctl-plugin-nano-linux-x64`     | linux  | x64   |
| `@nanobpm/c8ctl-plugin-nano-linux-arm64`   | linux  | arm64 |
| `@nanobpm/c8ctl-plugin-nano-linux-armv7`   | linux  | arm (v7) |
| `@nanobpm/c8ctl-plugin-nano-linux-armv6`   | linux  | arm (v6) |
| `@nanobpm/c8ctl-plugin-nano-win32-x64`     | win32  | x64   |

The root `c8ctl-plugin-nano` lists all of these as `optionalDependencies` (pinned
to the exact release version, injected into the published tarball at release
time). npm installs only those matching the host, so each user downloads a single
binary — **except on 32-bit ARM**, where npm's `cpu` field is just `arm` for both
armv6 and armv7, so both install and `platformForHost` picks the right one at
runtime via the host's `arm_version` (falling back to the armv6 build, which also
runs on armv7). The mapping lives in `platforms.mjs` — the single source of truth
shared by the build/publish scripts and the plugin's runtime resolution.

### Binary delivery contract (upstream CI)

This repo never builds or references the private Nano BPM source. Instead, the
upstream cross-compile pipeline uploads prebuilt binaries as assets on a rolling
GitHub Release named **`binaries`** in this repo. The release workflow downloads
them (`gh release download binaries`) and packs them into the platform packages.

Each asset must be named exactly (see `PLATFORMS[].asset` in `platforms.mjs`):

```
nanobpm-gateway-rest-server-darwin-arm64
nanobpm-gateway-rest-server-darwin-x64
nanobpm-gateway-rest-server-linux-x64
nanobpm-gateway-rest-server-linux-arm64
nanobpm-gateway-rest-server-linux-armv7
nanobpm-gateway-rest-server-linux-armv6
nanobpm-gateway-rest-server-win32-x64.exe
```

The upstream job needs a token with `contents: write` on this repo and can upload
with e.g. `gh release upload binaries <files> --clobber`.

### What triggers a release

The plugin's npm version is **decoupled** from the nanobpmn binary version, so
uploading new binaries does **not** by itself publish a new npm version —
`semantic-release` only releases on releasable commits to `main`.

To make a binary update ship, the upstream pipeline (after uploading the assets)
rewrites the tracked marker file **`nanobpmn-binary.json`** in this repo with the
new nanobpmn version/commit and pushes it as a `fix(binary): …` commit. That
commit triggers the release workflow, which downloads the just-uploaded binaries
and publishes a patch release. The marker is surfaced to users in `nano config`
(`bundled nano <version>`). The push is a no-op when the marker is unchanged.

```json
// nanobpmn-binary.json — overwritten by upstream CI; "0.0.0-dev" = local checkout
{ "version": "v1.4.2", "commit": "cdeb390", "updated": "2026-06-27T11:00:00Z" }
```

### OIDC / Trusted Publishing

The workflow is set up for npm **Trusted Publishing** (OIDC, `id-token: write`)
with provenance (`NPM_CONFIG_PROVENANCE: true`, requires this repo to be public).
Trusted Publishing is per-package and requires the package to already exist, so:

1. **Bootstrap** the first release with a granular-automation `NPM_TOKEN` secret —
   it is used automatically and creates all six packages. The token must have
   **publish rights to the `@nanobpm` scope** (the platform packages are scoped).
2. On npmjs.com, add a **Trusted Publisher** (this repo + `release.yml`) for the
   root package and each of the five `@nanobpm/c8ctl-plugin-nano-*` platform
   packages.
3. Remove the `NPM_TOKEN` secret; subsequent releases authenticate via OIDC.

> Note: because the platform packages are **scoped** (`@nanobpm/…`), they sidestep
> the unscoped-name squatting/`0.0.1-security` hold that previously blocked
> `c8ctl-plugin-nano-win32-x64`. If you ever add a new platform, its scoped name is
> yours to publish immediately.
