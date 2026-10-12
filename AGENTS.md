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
  logs/results — never in argv or the remote URL. When no `GITHUB_TOKEN` is
  exported the token comes from a cached `gh auth token` read (issue #293): the
  cache is a record `{ token, fingerprint, scopes, since, lastCheck }` with a
  TTL (`NANO_GH_TOKEN_TTL_MS`, default 5m), re-read off the job path by a
  worker-lifetime timer (`startGhAuthTokenRefresh`) that DEFERS a tick while a
  job is active, so a `gh auth login` / `refresh` while the fleet runs is adopted
  once the worker is next idle and the following tick runs — bounded by the
  in-flight job's remaining duration plus up to one interval, never a stale
  process-lifetime memo. That defer is itself BOUNDED
  (`NANO_GH_TOKEN_MAX_DEFER_MS`, default 4 intervals): under sustained
  back-to-back load a worker is never idle at a tick, so once a PRIMED cache is
  stale beyond the bound the timer re-reads DESPITE an active job (still async,
  never `spawnSync`, so it can't stall the job), capping staleness at a few
  intervals instead of the worker's whole busy lifetime (an UNSET cache is never
  primed mid-job). A clone/push that fails with an auth/OAuth-scope error
  (`isGitAuthFailure`) forces one re-read and retries once before failing. That
  re-read is **non-destructive** — it does NOT null the cache first, so a
  transiently-failing re-read can't erase a still-valid (possibly newer, from a
  `reload-credentials` swap) cached credential; the retry fires only when the
  re-read yields a token DIFFERENT from the one that failed. The token's
  **fingerprint + scopes** (never the value) are logged at
  startup and on change, ride the activity marker (`ghAuthTokenInfo()`) into a
  `supervisor status` **GH AUTH** column, and `supervisor reload-credentials`
  (SIGUSR1) requests an immediate async forced re-read fleet-wide without
  draining in-flight jobs — it does NOT null the cache first but swaps it
  atomically when the new token lands, so a worker keeps serving the still-valid
  old token (and a job started right after the command may still get it) until
  the re-read settles. A push
  failure is **non-fatal**
  and sets `pushFailed` (the authoritative "work is stranded / workspace
  preserved" flag) so the worker still completes the job and the process model
  drives the merge; a clone/checkout failure sheds (retryable `ProvisionError`).
  When work is stranded the run **workspace is PRESERVED** for recovery (holding
  the `strandedCommits` list — only usable while the clone's objects exist).
  `pushError` accompanies only an **attempted-and-rejected** push; a
  branch-mismatch or incomplete-scan finalize **refuses to push** and sets
  `pushFailed` (+`branchMismatch`/`scanError`) *without* `pushError`. `scanError`
  marks a **best-effort/partial** `strandedCommits` list (a remote-reachability
  scan that could not complete). Otherwise workspaces are reaped like containers
  (age-gated, in-flight skipped) and deleted per-job unless `--keep-runs`.
  Container-side cloning
  (strong isolation) is a later increment; container jobs don't clone yet.
- **Resume on re-activation (issue #239, `agent-resume.mjs`).** A re-activated
  agent job **resumes from the prior agent's state** instead of cold-rerunning, so
  at-least-once re-delivery is a *continuation*, not a duplicate of external side
  effects. Before spawning the harness, `workAgent` calls `readPriorTranscript`
  (best-effort, injected SDK read seam) to fetch the durable engine-native
  `AgentInstance`/`AgentHistory` transcript (#194) for this `elementInstanceKey` —
  **engine-backed, so cross-machine** — and, when it carries real prior work,
  `seedResumeEnvelope` reframes `envelope.task.prompt` as a continuation (rendered
  transcript + recovery-scope contract). Committed work is recovered from the
  pushed branch **only when the envelope alone can PROVE this activation re-checks-out
  the branch the prior run pushed onto** — `repository.ref` names a KNOWN non-base branch
  (base resolved with provisioning's precedence, `branch.base` then `repository.baseRef`,
  required non-blank; a conventional default name `main`/`master` is conservatively
  treated as base-like since provisioning also fallback-branches the resolved remote
  default) with no pinned `repository.sha` and `branch.push !== false`, AND
  `branch.create === ref`. Provisioning re-clones `ref` each activation; with
  `create === ref` its honored `checkout -B <create>` is a no-op keeping the workspace on
  it. The **ref-only** shape (no `branch.create`) is deliberately **transcript-only**
  even though provisioning's #270 `checkedOut && wantPush` arm often DOES push the
  checked-out PR head: that push-vs-fallback decision hinges on provisioning
  **resolving the remote default** (a checked-out branch that IS the default is base-like
  and fallback-branched; an unresolvable default fails closed), and resume gating runs
  **before the clone with no network**, so it can never prove a bare `ref` is not the
  repo's (possibly CUSTOM, e.g. `trunk`) default — it mirrors provisioning's
  fail-closed stance rather than over-claim recovery for a fallback-branched run (issue
  #270 follow-up). The #270 provisioning fix (pushing the PR head) is unaffected — only
  the resume PROMPT wording is conservative.
  Any other shape — a bare-URL / base-only clone, a `branch.create` that names a
  DIFFERENT branch than `ref`, a `ref`/`create` that equals (or cannot be proven distinct
  from) the base, or a per-run fallback branch — is NOT re-fetched, so such a run is
  classified **transcript-only** (the recovery preamble points at the transcript, not a
  branch that isn't there). Unless WIP
  checkpoints (below) restore them, **uncommitted deltas are lost** (workspace is throwaway). Gated to external agent jobs;
  a read failure / no read surface / no prior work / `NANO_AGENT_RESUME=off` falls
  through to the legacy cold rerun (`effectiveEnvelope === envelope`). The prompt
  seed is the only change — repository/setup are untouched, and the AgentInstance
  producer still records the ORIGINAL system prompt.
- **Transcript provenance (issue #243, `agent-instance.mjs`).** The opening
  `CONFIGURATION` turn already carries `model`/`provider`/`systemPrompt`/`limits`.
  Camunda pins that `definition` shape and nanobpmn promises **parity**, so we do
  NOT invent top-level fields; instead `buildProvenanceContent` rides the turn's
  `content[]` — the same `{ contentType:'OBJECT', object }` variant the producer
  already emits for structured tool results — with a marked
  (`kind:'nanobpm.provenance/v1'`) blob: `agentName` (profile name), `runtimeVersion`
  (the plugin `package.json` version == the nano **supervisor** version), best-effort
  `agentCliVersion` (a bounded, once-per-worker `probeAgentCliVersion` of the harness
  `command --version` — HOST execution only, since a container job runs the harness
  inside its image where a same-named host binary would misattribute the version, so
  container workers leave it unset; skipped too when the `NANO_AGENT_INSTANCE=off`
  kill-switch is set (the probe's only consumer is the AgentInstance producer), when
  the host SDK client lacks `createAgentInstance`/`updateAgentInstance` (the producer
  then degrades to a disabled facade, so probing is pure waste — the probe is deferred
  until the FIRST external-agent activation and gated on that capability), or when
  the profile carries extra args (an interpreter-style `node agent.js` would probe the
  interpreter, not the harness) — the field is omitted rather than misattributed; the
  probe further refuses an embedded-argument/compound `command` (and a RELATIVE-path
  `command` like `./harness`, whose resolution against the worker's cwd — not the
  per-job cwd the harness actually launches from — is ambiguous; a bare PATH-resolved
  name is likewise omitted when the resolved `PATH` carries a relative/empty
  (cwd-dependent) entry; only cwd-independent bare PATH names and absolute paths are
  probed) and runs (once, cached)
  under the WORKER-STATIC probe env — `process.env` merged with the profile `env`
  only, NOT the per-job `setup.env`, since the once-per-worker cache would otherwise
  leak one job's `setup.env`-derived reading to every later job on that worker — so
  `${command} --version` can neither execute a script nor resolve
  a different PATH binary than a stable representative run (and a worker that only
  services ordinary jobs never probes at all); a
  bounded `maxBuffer` caps the capture; a probe that returns a non-zero/`error` result
  omits the field rather than record its diagnostics; `NANO_AGENT_CLI_PROBE=off`
  disables it), and `host`/`pid`
  diagnostics. All optional: a turn with no substantive identity emits no block, so
  the wire is byte-unchanged for a bare run. A first-class typed field would need a
  **generic** upstream Camunda extension (an `attributes` map), tracked in #243.
- **AgentInstance preconditions, 409-adopt, permanent-4xx (issue #289,
  `agent-instance.mjs` + `c8ctl-plugin.js`).** Durable transcripts need the HOST c8ctl
  SDK to expose `createAgentInstance`/`updateAgentInstance` (the plugin version is
  irrelevant — the SDK ships with c8ctl). When it doesn't (e.g. `@camunda8/cli`
  4.1.0-alpha.2 bundling `@camunda8/orchestration-cluster-api` 9.1.5), the producer is a
  disabled facade and every job silently records nothing. So: (a) `nano work` **fails
  loudly at worker start** on any agentic profile when the host SDK lacks the verbs,
  naming the host `@camunda8/cli` + `@camunda8/orchestration-cluster-api` versions
  (`probeHostSdkInfo`, resolved by walking an ordered resolver chain rooted at the
  host c8ctl entry (`C8CTL_NANO_ENTRY`/`process.argv[1]`, canonicalized through its
  launcher symlink so a globally installed CLI's nested SDK still resolves) and the
  resolved `@camunda8/cli` package before falling back to the plugin's own module graph —
  the plugin graph alone may not expose the host's nested SDK in a managed
  install layout) and
  the minimum SDK (`>= 10.0.0-alpha.45`); `NANO_AGENT_INSTANCE=off` silences it. (b) The
  per-job "producer unavailable" line reports WHICH precondition failed via the facade's
  `unavailableReason` getter (SDK create, SDK update, ACP classifier, or not-external)
  plus the host SDK versions, instead of merging the causes. (c) A createAgentInstance
  **409 "already associated with agent instance N"** is now **ADOPTED**
  (`parseAssociatedInstanceKey` → latch N, replay the pre-mint buffer, resume appending)
  rather than retried — the retry loop was observed burning up to 79 futile attempts and
  recording no transcript, because a prior interrupted run left the instance open "for a
  retry to continue" and the retry re-created instead of adopting. (d) A **permanent 4xx**
  create rejection (`isPermanentCreateStatus`: 4xx except 429/408; 409 is adopted first)
  now **stops** immediately and disables the producer (a 404 "element instance is not
  active" from a cancelled job, a 400 "invalid agent history") rather than retrying a
  rejection that can never succeed. Both the adopt and the permanent-4xx classification
  read the status/body via `describeSdkError`, which walks a **bounded `cause` chain**
  (first non-null status / non-empty body from the outermost error inward wins) so a
  cause-wrapped SDK 409/404 — a shape this repo already treats as supported
  (`isLeaseLostSettleError`) — is adopted/classified instead of surfacing `status ===
  null` and continuing the retry loop this change exists to stop. **Token metrics (`metrics.inputTokens/outputTokens`)
  stay 0 for ACP-mode runs by design**: ACP's `session/update` stream carries
  context-window occupancy, not per-turn token counts (a documented `@nanobpm/agentic`
  fidelity gap), so the producer records real counts only when an update actually carries
  a `usage` block and never fabricates them. **Still open (tracked follow-up):**
  terminalizing a stuck instance when its job is *cancelled / force-stopped with no
  retry* (the 409-adopt fix resolves the retry-driven stuck case; the no-retry SLA-cancel
  residual needs a reliable cancel signal + the engine's cancel terminal-status
  semantics).
- **Agent plans (`agent-instance.mjs` + `agent-resume.mjs`).** ACP `plan` updates
  are recorded as an ASSISTANT turn (no tool calls) whose `content[]` is a TEXT
  checklist (what the cockpit renders) plus an OBJECT `kind:'nanobpm.plan/v1'` blob
  carrying the ACP `entries` and, when the agent sent one, its full `_meta.plan`
  (dropped past `PLAN_OBJECT_CAP_CHARS`). Parity-safe for the same reason as
  provenance: no invented fields. One turn per DISTINCT plan (content-hash dedup);
  pre-mint only the latest plan is kept, outside the pre-mint caps. On resume,
  `latestPlan` reads it back, `renderPlan` restates it in its own delimited section
  of the resume prompt (budget `RESUME_PLAN_CAP_CHARS`; plan turns are skipped in
  the transcript render), and `resolveEffectiveEnvelope` returns it as `plan`. It is
  sent in `session/new` `_meta.plan` (with `planInPrompt:true`, so the agent does not
  restate it again) ONLY when the agent's `initialize` advertised
  `agentCapabilities._meta.planSeed === true` (`acpSessionNewParams`) — every other
  agent gets byte-identical params. No plan recorded → prompt byte-unchanged.
  `NANO_AGENT_PLAN=off` disables recording and seeding.
- **WIP checkpoints (issue #264, `agent-checkpoint.mjs`).** `NANO_AGENT_CHECKPOINT`
  = `auto` (default) | `on` | `off`; `checkpointEligibility` gates `auto` to provisioned
  jobs on a **symbolic working branch** that **push** (`branch.push !== false`) an
  **authenticated** clone — authentication is NOT token-only: a repo token, an
  author-embedded HTTPS-userinfo remote, or an SSH remote (`isAuthenticatedRemote`,
  or provisioning's own stamped `authenticated`) each qualify, so a credentialed
  non-token clone still checkpoints — and every mode
  needs an `elementInstanceKey`. `setupWorkspaceCheckpoints` (c8ctl-plugin.js) runs after provisioning: it fetches
  `refs/nano/wip/<elementInstanceKey>`, restores it (`restoreCheckpoint`: fast-forward
  to the snapshot's parent + lay the tree down UNCOMMITTED when the fresh HEAD is an
  ancestor; else `git apply --3way` of the `Nano-Checkpoint-Base` → snapshot diff; else
  skip) and appends `withCheckpointNote` to the effective envelope. Snapshots are
  shadow commits through a temp `GIT_INDEX_FILE` (the agent's HEAD/index/refs are never
  written). Paths are reverted to HEAD when deny-listed, oversized, or `containsSecret`
  (the job's resolved secret values + repo token + `SECRET_CONTENT_PATTERNS`). Pushes use
  `--force-with-lease` against the last sha this run owns; `classifyPushFailure` →
  `lease` (take over ONLY if the ref was moved by the run we superseded, per the
  `Nano-Checkpoint-Run` trailer, else stop), `policy`/`auth` (stop, warn), `transient`
  (retry next trigger). Git runs async (never `spawnSync`) so pushes don't block the ACP
  loop. The checkpointer is fed from `onAcpUpdate` (completed/failed
  `tool_call_update`, `plan`), rate-limited, with a safety-net timer; flushed on abort
  and on a failed run, stopped before `finalizeGit`, the ref deleted after a clean
  finalize (kept on any push failure), and `close()` drains in-flight git work before
  the run dir is reaped. A background `sweepStaleCheckpoints` (throttled per remote by
  `shouldSweep`) deletes other WIP refs past `NANO_AGENT_CHECKPOINT_TTL_MS` (7d) or >1h old
  whose element instance `getElementInstance` reports COMPLETED/TERMINATED (an error/404
  is never treated as terminal). `agentCheckpoint` is written via
  `camunda.createElementInstanceVariables` (`local:true`), best-effort, warning once.
  Tests: `agent-checkpoint.test.mjs` (real temp repos + bare remote).
- **SLA-cancel-safe checkpoints (issue #295, `agent-checkpoint.mjs`).** The #264 GC
  treated an element-terminal WIP ref as an orphan, but an SLA **boundary timer**
  cancels the *element* (→ TERMINATED) while its *process* keeps waiting for a human
  to answer the escalation — so the sweep deleted the exact checkpoint a resume needs.
  Four changes close that: (a) **process-instance-aware orphan probe**
  (`makeOrphanProbe`): a WIP ref is an orphan only when its element is terminal **AND**,
  when the host SDK exposes `getProcessInstance`, its process is also
  COMPLETED/TERMINATED/CANCELED; an element terminal inside a still-ACTIVE process is
  **spared** (fail-closed — any missing key / unreachable / thrown lookup spares the ref;
  the 7d TTL stays the backstop). Degrades to the legacy element-only check when the SDK
  lacks `getProcessInstance`. (b) **Predecessor adoption on resume**: a resumed run
  re-enters the task as a NEW element instance (new key), so its deterministic
  `refs/nano/wip/<newKey>` is empty. The interrupted run records its ref in a
  **process-scoped** `resumeFromCheckpoint` variable (written at `processInstanceKey`
  with `local:true`, so it survives element re-entry); on resume
  `predecessorCheckpointRef` reads it and `pushNamedRef` copies the predecessor ref
  under this run's key so restore/ownership/discard run unchanged. Because that
  correlation keys on the **static `elementId`** (not an occurrence id), it is
  AMBIGUOUS under parallel multi-instance of one agent-task element in a single process
  instance — which is **out of scope for resume** (no nano-workforce process fans one
  agent-task element out that way). Because counting ACTIVE occurrences cannot establish
  occurrence identity (index lag can hide a live sibling, and a terminal sibling drops
  out of the ACTIVE result yet may have been the slot's last writer), NO engine query
  makes an elementId-correlated self-record adoption provably safe. So a self-recorded
  (object) predecessor is **never auto-adopted** — `makeOccurrenceGuard` fails closed by
  construction and the restore path starts clean (transcript-only) rather than risk
  restoring a sibling occurrence's state. The ONLY predecessor trusted is the explicit,
  occurrence-authoritative ref the process delivers as a bare **string**:
  `resumeRefIsExplicit` bypasses the correlation when that string is present
  (nano-workforce#891 plugs in with no further plugin change). After a successful
  adoption the process-scoped pointer is **advanced** to this run's newly-copied ref, so
  a no-new-checkpoint completion can't leave a stale predecessor pointer for the next
  activation. (c) **GC-proof
  recovery refs**: on a force-stop/abort or failed (SLA-cancelled) run,
  `preserveRecovery` promotes the latest snapshot to `refs/nano/recovered/<eik>`
  (`recoveredCheckpointRef`) — **outside** the `refs/nano/wip/*` namespace the sweep
  enumerates, so it is never GC-reclaimed. How the recovery point is *reported*
  depends on HOW the run ended. A **non-aborted failed** run (a non-ok result that
  did NOT interrupt the runner — e.g. a harness non-zero exit) settles normally and
  surfaces `recoveryRef`/`recoverySha` in the job outcome (`buildResultEnvelope`).
  But a **force-stopped run OR an SLA lease-loss cancellation** both take the *aborted*
  early return (`settle.fail`, `result.aborted === true`): the supervisor heartbeat
  treats the SLA cancel's lease-loss 404 as terminal and interrupts the runner, so it
  reaches the SAME aborted branch as a force-stop. That branch returns before
  `buildResultEnvelope`, so it produces **no outcome envelope** — `recoveryRef`/
  `recoverySha` are NOT emitted there. Instead it records the recovery point through
  the **process-scoped `resumeFromCheckpoint`** variable (so a resumed element
  re-entry can discover it), and the pushed `refs/nano/recovered/<eik>` ref itself is
  the authoritative, durable recovery handle (recoverable without any job result).
  All recovery-ref writes are **fenced** (Copilot review on #296): predecessor
  adoption is create-only and the recovery promotion leases against the sha it observed
  on `refs/nano/recovered/<eik>`, so a slower/stale activation can never blind-force
  over a newer run's recovery point (`pushNamedRef`/`observeRemoteRefSha`). That lease
  is only a compare-and-swap, so it is **reinforced by run identity** and **fails
  closed** (Copilot review on #296, F7/F10): an existing recovery ref is overwritten
  only when its `Nano-Checkpoint-Run` trailer **positively identifies** it as this run
  or the run it explicitly superseded (`prior.runId`); a foreign (newer/concurrent)
  run's point is kept, and any case where ownership **cannot be established** — the
  ownership fetch threw/failed, or the ref carries no run trailer — **refuses** the
  overwrite rather than falling through to the CAS, so a transient read failure can't
  let a stale activation clobber a newer recovery point. The
  force-stop flush+promote is **bounded** by `FORCE_STOP_RECOVERY_MS` and made genuinely
  **cancellable**: the checkpoint-path git runner is driven by a **dedicated
  recovery-deadline `AbortController`** — NOT the job's `abortSignal` (Copilot review on
  #296, F9). The recovery path (flush + `preserveRecovery`) runs only once
  `result.aborted` is observed, i.e. AFTER the job signal has fired, so binding git to
  that signal made `createGitRunner` fail every recovery command (`[aborted]`) and
  defeated the whole #295 recovery; the dedicated controller keeps git usable after the
  harness abort and is cancelled (`checkpointing.abortRecovery()`, armed from the
  force-stop block) only when the recovery budget expires — tearing the in-flight push
  down (SIGTERM→SIGKILL) so the chain settles promptly instead of running to
  `gitTimeoutMs`. That `abortRecovery()` also aborts the background **GC sweep**, and the
  force-stop path anchors **ONE shared absolute deadline** (`forceStopDeadline`) when the
  recovery block begins: the recover race and the post-abort `close()` drain BOTH bound
  against the *same* deadline (`close()` gets only the REMAINING budget,
  `Math.max(closeFloorMs, forceStopDeadline - Date.now())`, never a fresh full one), so
  recovery **and** the (up to 120s) GC cleanup together fit inside a single
  `FORCE_STOP_RECOVERY_MS` window instead of consuming it twice and being SIGKILLed
  mid-cleanup (Copilot review on #296). The floor is `closeFloorMs` (the git kill grace,
  `gitKillGraceMs`), **not** a bare `1`: `abortRecovery()` is armed to fire
  `gitKillGraceMs` *before* `forceStopDeadline`, so the git SIGKILL lands by the deadline
  and the floor reserves just enough of the remaining window for `close()` to actually
  drain the now-SIGTERMed git process — a `Math.max(1, …)` floor would let `close()`
  abandon the drain after 1 ms while git was still dying, then reap the workspace under a
  live process (Copilot review on #296). The supervisor's `forceStopWorker` waits
  `STOP_GRACE_MS + FORCE_STOP_RECOVERY_MS` before
  its SIGKILL backstop, so a worker can finish writing the recovery ref before it is
  killed (a worker that exits sooner is reaped immediately). (d) The GC reclaim log
  reports `ref@sha [why]`
  (the sweep's `deleted` entries now carry the `sha`). Tests: the `#295 …` cases in
  `agent-checkpoint.test.mjs`.
- **Agent outcomes (`acpOutcomeFrom` / `resultVarsFromAcpOutcome`).** A
  `session/prompt` result may carry `_meta.outcome` `{status:'completed'|'blocked',
  summary}` (rusty-harness's `report_outcome`). `spawnCaptureAcp` surfaces it as
  `result.acpOutcome` (absent otherwise — result shape unchanged), and
  `buildResultEnvelope` records it as `io.nanobpm.agentResult.outcome`. It is a
  LAST-RESORT result: only when the agent wrote no result file / sentinel does
  `blocked` become `{status:'blocked', summary, question}` (the workforce escalation
  arm) and skip the re-emit nudge. `completed` implies no vars (job-specific status
  values can't be guessed), so the normal result / nudge path is unchanged.

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
  reload|stop|logs`) are thin socket clients (`supervisorRequest`) needing no
  interactive surface; the interactive `attach` console streams events and can
  **detach** (Ctrl-D / `detach`, leaving the daemon running) or `stop` the fleet.
- **Hot code reload (rolling drain+respawn).** `supervisor reload [target]` (and
  `workforce reload`) adopt updated on-disk plugin code into the running fleet
  with **zero fleet downtime**: the daemon rolls through the target workers (default
  `all`) **one at a time**, gracefully draining each (the same `SIGUSR2` quiesce
  as stop — finish in-flight jobs, then exit) and respawning it so the new
  `nano work` child re-reads the updated `c8ctl-plugin.js` + sidecars +
  `supervisor.dist.js` from disk. Because each worker is a separate process,
  respawning it is what adopts the new code — so after `nano update`, a rolling
  `reload` picks up all **worker-side** logic (job running, agent instances,
  provisioning, agentic, the Effect runtime workers load) without stopping the
  fleet. The `reload` socket op is **streaming** (draining can take arbitrarily
  long) and ends with a terminal `reloaded` frame; **Ctrl-C detaches** the client
  while the daemon keeps rolling. The drain runs OUTSIDE the op lock (so a
  `stop --force`/`remove`/`restart` can still interrupt it), and the respawn is
  guarded by the same **child-identity check** as `restart` (only respawn if the
  drained child is still the worker's current child) so a concurrent
  force-stop/restart/remove never leaks a duplicate or revives a removed worker;
  a reload is refused while another is in progress, respects `shuttingDown`, and
  **never clears `supervisor.json`** (it is not a stop). To keep the roll
  genuinely **one-at-a-time**, after respawning a worker the daemon waits for the
  replacement to report **ready** — the worker stamps `readyAt` on its activity
  marker once its activation loop is up and leasing (a bare spawn/PID is not
  readiness), so a slow replacement can't leave two workers down at once. That
  wait is **bounded** (`NANO_SUPERVISOR_RELOAD_READY_TIMEOUT_MS`, default 30s): a
  never-ready replacement (e.g. a wedged engine) can't stall the roll — the daemon
  advances anyway on timeout. This "zero downtime" is a **fleet-level, normal-readiness**
  guarantee, NOT unqualified: because a worker is drained **before** its replacement
  spawns, a **single-worker fleet** (or a job type served by only one worker) does lose
  that capacity for the drain+boot window, and on the bounded-timeout fallback path the
  daemon advances while a slow replacement is still unready, so two or more workers can
  be temporarily unavailable (see `README.md` "Hot code reload"). Run more than one
  worker per type for continuous service across a reload. The daemon's OWN
  process-manager code is NOT adopted by `reload` (its workers are its children
  watching its pid, so a daemon re-exec would take the fleet down) — new
  supervisor code needs a full `supervisor stop && supervisor start`. `status`
  surfaces this: the frame carries `pluginVersion` (the version on disk, re-read
  each call) alongside the daemon's running `version`, and the render flags
  "update available — run `supervisor reload`" when they diverge.
- **Graceful drain on stop (issue #202).** `supervisor stop` (and `workforce
  stop`) **drain by default**: the daemon quiesces each `nano work` child with a
  `SIGUSR2` (registry `quiesce()` latches the activation loop so it leases NO new
  job — authoritative over `--auto` reconcile), the child lets its in-flight jobs
  finish and exits, and the streaming stop client live-updates the shrinking
  in-flight count. **Ctrl-C detaches the client** (the daemon keeps draining in
  the background). `--force` aborts instead: `SIGTERM`/`SIGINT` interrupts the
  runtime, whose interruption **cancels** each running job's `AbortSignal` (the
  `makeJobRunner` seam → `runAgentJob` killTree's the harness process group) and
  yields the job (`settle.fail`, retries preserved → immediately retryable); a
  `--force` request also **escalates** a drain already in progress. The drain
  waits INDEFINITELY (a force stop is the only escape hatch); `stop --force`
  keeps the grace-window + SIGKILL backstop on the daemon pid. A daemon-driven
  signal shutdown (its own SIGTERM/SIGINT/SIGHUP) stays a fast force stop. The
  stop socket op streams status and ends with a terminal `stopped` frame, so the
  streaming stop client (which waits indefinitely) sees a clean end-of-response
  instead of a bare socket close; a one-shot `supervisorRequest({op:'stop'})` only
  observes that frame if the drain completes within its fixed 15s response
  deadline, and otherwise times out client-side while the daemon keeps draining.
- **Session-independent service (`install`/`uninstall`, issue #196).** On macOS a
  supervisor started over SSH is bound to the SSH login session's launchd domain;
  on logout macOS tears it down and the fleet **wedges** (activation spins on
  `activateJobs failed: fetch failed`, claims zero jobs) rather than exiting.
  `setsid` is insufficient — the daemon must live in a persistent `gui/$UID`
  launchd domain. `supervisor install`/`uninstall` write + bootstrap a per-user
  **LaunchAgent** (`gui/$UID`, `RunAtLoad`, crash-only `KeepAlive`) on macOS, and a
  `systemd --user` unit + `loginctl enable-linger` on Linux (a no-op with guidance
  where `systemd --user` is absent, since the `setsid` path already survives
  logout there). Label/unit names are hashed off the state home so distinct
  `C8CTL_NANO_HOME`s don't collide; the service inherits only a curated env (never
  the whole SSH env). `supervisor start` over SSH on macOS **without** the service
  auto-reparents into `gui/$UID` (or warns, pointing at `install`, when it can't /
  `C8CTL_NANO_NO_LAUNCHD=1`). Linux is unaffected (KillUserProcesses=no).
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
- **Concrete agentic endpoint (issues #160, #186).** The `AgenticEndpoint` the
  supervisor injects as `deps.agenticEndpoint` is a thin, deterministically-testable
  Effect adapter (`emit.ts`, `makeAgenticEndpoint`) that lifts a plain, Effect-free
  `RawEmitClient` — ONE multiplexed host connection — into the Effect
  `AgenticHandle`. Since #186 the raw client is itself a thin adapter over
  `@nanobpm/agentic/emit`'s `AgenticEmitClient` (the blessed emit client): the
  monolith no longer hand-rolls a parallel emit/ownership layer or its own
  `t/<instance>/<jobKey>` stream id — it adapts the package client and its injective
  `composeStreamId`/`parseStreamId` codec (`stream = String(jobKey)`). The wire is
  CONSUMED through the monolith's single import surface (`agentic-endpoint.mjs` →
  `agentic.mjs` → `@nanobpm/agentic` `^0.13.0`'s `emit` client, `claim`/`release`
  families 8/9 + additive negotiation), so it is NOT bundled into the quarantined
  Effect module. The monolith composes the two via `createAgenticEndpoint()`. Every
  frame carries its `instance` EXPLICITLY (one connection, N workers);
  `claim`/`release`/steer are OMITTED from the handle when the negotiated protocol
  lacks them, so an old hub degrades to a no-op rather than a protocol error.
  **Reconnect + resync is owned by the emit client**: it re-emits presence + active
  claims from its write-through shadow on every reconnect (fed by `ownership.ts`,
  which stays the authority + single write path), so `superviseAgentic` no longer
  drives a manual registry resync — it only re-installs the inbound steer router.
  The adapter still owns the inbound-steer seam (the emit client is a pure emitter):
  it decodes each inbound relay DELIVERY frame and routes it via `parseStreamId`.
- **Concrete engine + deps seam (issue #156).** The same "monolith supplies a
  plain Effect-free client, a TS lift wraps it into an Effect port" pattern extends
  to the remaining edges. `adapters.ts` lifts a raw `RawEngineClient`
  (`activate`/`extendLock`), `RawReconcileReader`, and `RawJobRunner` into their
  Effect ports (`makeEngineClient`/`makeReconcileReader`/`makeJobRunner`), wraps a
  monolith logger with `asLogger`, and assembles them with `makeSupervisorDeps` —
  every promise rejection mapped into the `SupervisorError` channel. The concrete
  engine wire is `supervisor-engine.mjs` (`createRawEngineClient`): direct C8 v2
  REST, Effect-free with an injectable `fetch`, so it stays OUT of the quarantined
  bundle. **SDK-preference convention (PR #180, issue #179):** EVERY engine method
  that has a typed `@camunda8` SDK method PREFERS the injected `camunda` client and
  hand-rolls the raw REST `call(...)` only as a standalone / wire-test fallback —
  `activate`→`activateJobs` (`POST /v2/jobs/activation`), `extendLock`→`updateJob`
  (`PATCH /v2/jobs/{key}`, NOT the drifted `/timeout` sub-route that 404s),
  `complete`→`completeJob` (`POST /v2/jobs/{key}/completion`), `fail`→`failJob`
  (`POST /v2/jobs/{key}/failure`). There is NO sanctioned raw-only method: the SDK's
  managed `createJobWorker` loop can't express the supervisor's global-capacity
  race, but `activate` uses the single-shot `activateJobs` primitive that loop wraps
  — its input body (`JobActivationRequest`) is 1:1 with the raw POST and its returned
  `CancelablePromise.cancel()` aborts the in-flight long-poll, wired to the Effect
  fiber's interruption signal (`makeEngineClient` threads the `tryPromise`
  `AbortSignal` into `raw.activate(req, signal)`) so a losing `raceAll` fiber stops
  its poll at once. This is ENFORCED by
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
  `supervisor/src/**` (CI and `prepublishOnly` rebuild it too). `npm test` runs
  `npm run check:bundle` **first** — it rebuilds the bundle from source and
  `git diff`s it against the committed copy, so a stale `supervisor.dist.js`
  **reddens CI** rather than being silently rebuilt later in the same `npm test`
  run; on failure it tells you to run `npm run build:supervisor` and commit the
  result.

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
