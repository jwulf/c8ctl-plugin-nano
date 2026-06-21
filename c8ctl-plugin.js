/**
 * c8ctl-plugin-nano
 *
 * Start, inspect, and stop a local Nano BPM (nanobpmn) cluster.
 *
 * A nanobpmn deployment is one or more node *processes*. Each node is a single
 * binary configured entirely through environment variables:
 *
 *   PORT               this node's HTTP listen port
 *   NANOBPMN_NODE_ID   this node's id (index into NANOBPMN_NODES)
 *   NANOBPMN_NODES     comma-separated peer base URLs, index = node id
 *   NANOBPMN_PARTITIONS total partitions across the cluster
 *   NANOBPMN_RF        replication factor (1 = single-homed, no Raft)
 *   NANOBPMN_RAFT      set when RF > 1 to enable per-partition Raft
 *   NANOBPMN_DATA_DIR  this node's engine data directory
 *
 * This plugin spawns N detached node processes wired to talk to each other on
 * localhost, tracks them in a state file, and stops them on request.
 *
 * Usage:
 *   c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>]
 *   c8ctl nano status
 *   c8ctl nano stop [--purge]
 *   c8ctl nano logs [<nodeId>] [--follow]
 *   c8ctl nano restart [<nodes>] ...
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration & paths
// ---------------------------------------------------------------------------

const STATE_FILE = 'cluster.json';
const CONFIG_FILE = 'config.json';
const DEFAULT_BASE_PORT = 8080;
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 1_500;
const STOP_GRACE_MS = 8_000;

function getLogger() {
  if (globalThis.c8ctl) {
    return globalThis.c8ctl.getLogger();
  }
  return {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: () => {},
  };
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Per-user home for this plugin: holds the cluster state file, per-node data
 * directories, and log files. Override with C8CTL_NANO_HOME.
 */
function getStateHome() {
  const env = process.env.C8CTL_NANO_HOME;
  if (env) return expandHome(env);

  const home = homedir();
  switch (osPlatform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'c8ctl-nano');
    case 'win32':
      return join(
        process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
        'c8ctl-nano',
      );
    default:
      return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'c8ctl-nano');
  }
}

function getStateFile() {
  return join(getStateHome(), STATE_FILE);
}

function getDataDir() {
  return join(getStateHome(), 'data');
}

function getLogDir() {
  return join(getStateHome(), 'logs');
}

// ---------------------------------------------------------------------------
// Persistent plugin config (config.json) — user settings that survive across
// clusters: the binary path and the workspace (models/workers) location.
// ---------------------------------------------------------------------------

function getConfigFile() {
  return join(getStateHome(), CONFIG_FILE);
}

function readConfig() {
  const file = getConfigFile();
  if (!existsSync(file)) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf-8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  mkdirSync(getStateHome(), { recursive: true });
  writeFileSync(getConfigFile(), JSON.stringify(cfg, null, 2));
}

/**
 * The workspace root (NANOBPMN_WORKSPACE_DIR): the persistent authoring source
 * of truth holding `models/` and `workers/`. Deliberately separate from the
 * per-node engine data dir so "nano clean" never touches it.
 *
 * Resolution: configured `workspaceDir` → `<stateHome>/workspace` default.
 */
function getWorkspaceDir() {
  const cfg = readConfig();
  if (cfg.workspaceDir) {
    const p = expandHome(String(cfg.workspaceDir));
    return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
  }
  return join(getStateHome(), 'workspace');
}

/** Ensure the workspace and its models/ and workers/ subdirectories exist. */
function ensureWorkspace() {
  const root = getWorkspaceDir();
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'workers'), { recursive: true });
  return root;
}

/** The nanobpmn source/checkout root used to locate a built binary. */
function getRepoRoot() {
  return expandHome(process.env.NANOBPMN_REPO || join(homedir(), 'workspace', 'nanobpmn'));
}

/**
 * Locate the nanobpmn server binary. Resolution order:
 *   1. --binary flag
 *   2. configured binary path ("nano set bin <path>")
 *   3. NANOBPMN_BINARY env var
 *   4. release build under the nanobpmn repo
 *   5. debug build under the nanobpmn repo
 */
function findBinary(flags) {
  const cfg = readConfig();
  const sources = [
    { val: flags?.binary && String(flags.binary), from: '--binary' },
    { val: cfg.binary && String(cfg.binary), from: 'configured bin ("nano set bin")' },
    { val: process.env.NANOBPMN_BINARY, from: 'NANOBPMN_BINARY' },
  ];
  for (const { val, from } of sources) {
    if (!val) continue;
    const p = expandHome(val);
    const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
    if (!existsSync(abs)) {
      throw new Error(`Binary not found at ${abs} (from ${from})`);
    }
    return abs;
  }

  const repo = getRepoRoot();
  const name = 'nanobpm-gateway-rest-server';
  const candidates = [
    join(repo, 'server', 'target', 'release', name),
    join(repo, 'server', 'target', 'debug', name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not find the nanobpmn server binary.\n` +
      `Looked in:\n  ${candidates.join('\n  ')}\n` +
      `Build it with: (cd ${repo} && make release-gateway)\n` +
      `Or set one with "c8ctl nano set bin <path>", --binary <path>, or NANOBPMN_BINARY=<path>.`,
  );
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['start', 'stop', 'status', 'logs', 'log', 'restart', 'pause', 'resume', 'clean', 'set', 'config'];

/**
 * Parse positional args + flags into a normalized request.
 * Positional 0 = subcommand, positional 1 = node count (start/restart) or
 * node id (logs).
 */
function parseRequest(args, flags) {
  const subcommand = args[0];
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));

  const intFlag = (name) => {
    const v = flags?.[name];
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    subcommand,
    positional,
    nodes: intFlag('nodes'),
    basePort: intFlag('port'),
    partitions: intFlag('partitions'),
    rf: intFlag('rf'),
    raft: flags?.raft,
    follow: Boolean(flags?.follow),
    purge: Boolean(flags?.purge),
    force: Boolean(flags?.force),
    capture: Boolean(flags?.capture),
    workspace: Boolean(flags?.workspace),
    binary: flags?.binary,
  };
}

// ---------------------------------------------------------------------------
// Process / state helpers
// ---------------------------------------------------------------------------

/** True if a process with `pid` is currently alive. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err && err.code === 'EPERM';
  }
}

function readState() {
  const file = getStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(getStateHome(), { recursive: true });
  writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
}

function clearState() {
  const file = getStateFile();
  if (existsSync(file)) rmSync(file);
}

/** How many of a cluster's recorded nodes are still alive. */
function liveNodeCount(state) {
  if (!state || !Array.isArray(state.nodes)) return 0;
  return state.nodes.filter((n) => isPidAlive(n.pid)).length;
}

/** Probe a node's always-on GET /v2/topology endpoint for reachability. */
async function probeHealthy(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/v2/topology`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a node's GET /v2/topology, or null if unreachable / not a
 * Nano BPM endpoint. The topology is the authoritative cluster view, so this
 * lets `nano status` report on a cluster that c8ctl did not start.
 */
async function fetchTopology(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/v2/topology`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && Array.isArray(body.brokers) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a parsed /v2/topology body as Nano BPM vs stock Camunda.
 *
 * Nano advertises itself with a `nano` object (`engine: "nanobpmn"`) in its
 * topology — a superset of the Camunda Orchestration Cluster API. A stock
 * Camunda gateway answers the same /v2/topology shape but without that object,
 * so its absence is the discriminator.
 */
function classifyTopology(topo) {
  const nano = topo && topo.nano;
  if (nano && nano.engine) {
    return {
      product: 'nano',
      label: 'Nano BPM',
      engine: nano.engine,
      version: nano.version ?? topo.gatewayVersion ?? null,
    };
  }
  return {
    product: 'camunda',
    label: 'Camunda',
    engine: null,
    version: (topo && topo.gatewayVersion) ?? null,
  };
}

/**
 * Probe `url` and identify what is answering: returns the classification plus
 * the raw topology, or null if nothing Camunda-compatible is listening.
 */
async function identifyEndpoint(url) {
  const topo = await fetchTopology(url);
  if (!topo) return null;
  return { ...classifyTopology(topo), topo };
}

async function waitForHealthy(url, timeoutMs = READINESS_TIMEOUT_MS) {  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeHealthy(url)) return true;
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startCluster(req) {
  const logger = getLogger();

  // Refuse to start over a live cluster unless forced.
  const existing = readState();
  if (existing && liveNodeCount(existing) > 0) {
    if (!req.force) {
      logger.warn(`A nano cluster is already running (${liveNodeCount(existing)} node(s) alive).`);
      logger.info('Use "c8ctl nano status" to inspect it, "c8ctl nano stop" to stop it,');
      logger.info('or "c8ctl nano start ... --force" to stop it and start fresh.');
      return;
    }
    logger.info('Stopping existing cluster before starting a new one (--force)...');
    await stopCluster({ purge: false });
  } else if (existing) {
    // Stale state — no live processes. Clean it up silently.
    clearState();
  }

  const nodeCount = Math.max(1, req.nodes ?? (Number.parseInt(req.positional[0] ?? '1', 10) || 1));
  const basePort = req.basePort ?? DEFAULT_BASE_PORT;
  const partitions = req.partitions ?? nodeCount;
  const rf = Math.min(Math.max(1, req.rf ?? 1), nodeCount);
  // Raft is required for replication; auto-enable when RF > 1, allow override.
  const raft = req.raft === undefined ? rf > 1 : Boolean(req.raft);
  const capture = Boolean(req.capture);

  if (partitions < nodeCount) {
    logger.warn(
      `partitions (${partitions}) < nodes (${nodeCount}): some nodes will own no partitions ` +
        `and act as gateways only. Pass --partitions >= ${nodeCount} to spread ownership.`,
    );
  }
  if (req.rf && req.rf > nodeCount) {
    logger.warn(`--rf ${req.rf} clamped to node count (${nodeCount}).`);
  }

  const binary = findBinary(req);

  // Pre-flight: make sure the chosen ports are free, and tell the user exactly
  // what is in the way (Camunda vs Nano vs some other HTTP server). We refuse to
  // start on top of an existing gateway — pass a different --port to coexist
  // (e.g. run Nano alongside a local Camunda on 8080).
  const ports = Array.from({ length: nodeCount }, (_, i) => basePort + i);
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    const found = await identifyEndpoint(url);
    if (found) {
      logger.error(
        `Port ${port} is already serving a ${found.label} gateway` +
          `${found.version ? ` (v${found.version})` : ''}.`,
      );
      if (found.product === 'camunda') {
        logger.error('Refusing to start Nano on top of a running Camunda instance.');
      } else {
        logger.error('A Nano node appears to already be bound to this port.');
      }
      logger.info(
        `Start on a free base port instead, e.g. ` +
          `"c8ctl nano start ${nodeCount} --port ${basePort + 100}".`,
      );
      process.exit(1);
    }
    if (await probeHealthy(url)) {
      logger.error(`Port ${port} is already serving an HTTP endpoint. Choose another --port base.`);
      process.exit(1);
    }
  }

  const peers = ports.map((p) => `http://127.0.0.1:${p}`);
  const nodesEnv = peers.join(',');

  mkdirSync(getDataDir(), { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });
  const workspaceDir = ensureWorkspace();

  logger.info(
    `Starting Nano BPM cluster: ${nodeCount} node(s), ${partitions} partition(s), ` +
      `RF=${rf}${raft ? ', Raft on' : ''}${capture ? ', trace capture on' : ''}`,
  );
  logger.info(`Binary:    ${binary}`);
  logger.info(`Workspace: ${workspaceDir} (models/, workers/)`);

  const nodes = [];
  for (let id = 0; id < nodeCount; id++) {
    const port = ports[id];
    const dataDir = join(getDataDir(), `node-${id}`);
    const logFile = join(getLogDir(), `node-${id}.log`);
    mkdirSync(dataDir, { recursive: true });

    const env = {
      ...process.env,
      PORT: String(port),
      NANOBPMN_NODE_ID: String(id),
      NANOBPMN_NODES: nodesEnv,
      NANOBPMN_PARTITIONS: String(partitions),
      NANOBPMN_RF: String(rf),
      NANOBPMN_DATA_DIR: dataDir,
      // Default to async durability (group-commit) for throughput; the user can
      // override per the spread of process.env above by exporting
      // NANOBPMN_DURABILITY (e.g. "sync") before running.
      NANOBPMN_DURABILITY: process.env.NANOBPMN_DURABILITY ?? 'async',
      // Shared, persistent authoring workspace (models + workers). Lives
      // outside the per-node data dir so "nano clean" never wipes it.
      NANOBPMN_WORKSPACE_DIR: workspaceDir,
    };
    if (raft) env.NANOBPMN_RAFT = '1';
    // Trace capture: a single flag enables the Tier 2 recorded-input (stimuli)
    // log AND auto-enables Tier 1 variable capture, so historical replay /
    // analysis can reconstruct each instance. Must be set on every node — each
    // node's TraceStore only sees instances on its own partitions. Optional
    // tuning vars (NANOBPMN_TRACE_VARIABLES_MAX_BYTES / _STIMULI_MAX /
    // _CAPACITY) pass through automatically from the environment if set.
    if (capture) env.NANOBPMN_TRACE_STIMULI = '1';

    const out = openSync(logFile, 'a');
    const child = spawn(binary, [], {
      env,
      stdio: ['ignore', out, out],
      detached: true,
    });
    child.unref();

    if (typeof child.pid !== 'number') {
      logger.error(`Failed to spawn node ${id}.`);
      // Best-effort cleanup of anything already started.
      for (const n of nodes) {
        try {
          process.kill(n.pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
      process.exit(1);
    }

    nodes.push({ id, port, pid: child.pid, url: peers[id], dataDir, logFile });
    logger.info(`  node ${id}: pid ${child.pid} → ${peers[id]} (log: ${logFile})`);
  }

  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    binary,
    workspaceDir,
    partitions,
    rf,
    raft,
    capture,
    basePort,
    nodes,
  };
  writeState(state);

  // Wait for every node to report reachable on /v2/topology.
  logger.info('Waiting for nodes to become reachable...');
  let allHealthy = true;
  for (const n of nodes) {
    // A crashed process won't ever become healthy — bail early with its log.
    if (!isPidAlive(n.pid)) {
      logger.error(`Node ${n.id} (pid ${n.pid}) exited during startup. Check ${n.logFile}`);
      allHealthy = false;
      continue;
    }
    const ok = await waitForHealthy(n.url);
    if (ok) {
      logger.info(`  node ${n.id} ready at ${n.url}`);
    } else {
      allHealthy = false;
      logger.error(`  node ${n.id} did not become ready within timeout (see ${n.logFile})`);
    }
  }

  if (!allHealthy) {
    logger.error('Cluster did not fully start. Inspect logs above, then "c8ctl nano stop".');
    process.exit(1);
  }

  printSummary(state);
}

function printSummary(state) {
  console.log('');
  console.log(
    `Nano BPM cluster is up: ${state.nodes.length} node(s), ${state.partitions} partition(s), ` +
      `RF=${state.rf}${state.raft ? ', Raft on' : ''}`,
  );
  console.log('');
  for (const n of state.nodes) {
    console.log(`  node ${n.id}  ${n.url}  (pid ${n.pid})`);
  }
  console.log('');
  const entry = state.nodes[0];
  console.log(`  REST API     ${entry.url}/v2`);
  console.log(`  Topology     ${entry.url}/v2/topology`);
  console.log(`  Web console  ${entry.url}/console`);
  if (state.workspaceDir) {
    console.log(`  Workspace    ${state.workspaceDir} (models/, workers/)`);
  }
  console.log('');
  console.log('  Inspect with: c8ctl nano status');
  console.log('  Stop with:    c8ctl nano stop');
  console.log('');
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopCluster(req) {
  const logger = getLogger();
  const state = readState();

  if (!state || !Array.isArray(state.nodes) || state.nodes.length === 0) {
    logger.warn('No nano cluster state found — nothing to stop.');
    if (req.purge) purgeData();
    clearState();
    return;
  }

  const alive = state.nodes.filter((n) => isPidAlive(n.pid));
  if (alive.length === 0) {
    logger.warn('No running nano nodes found (stale state). Cleaning up.');
    clearState();
    if (req.purge) purgeData();
    return;
  }

  logger.info(`Stopping ${alive.length} nano node(s)...`);

  // Phase 1: polite SIGTERM. Continue any paused (SIGSTOP'd) node first, else
  // the SIGTERM stays pending and the node can only be force-killed.
  for (const n of alive) {
    try {
      if (n.paused) process.kill(n.pid, 'SIGCONT');
      process.kill(n.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  // Phase 2: wait for graceful exit.
  const deadline = Date.now() + STOP_GRACE_MS;
  let remaining = alive;
  while (Date.now() < deadline) {
    remaining = remaining.filter((n) => isPidAlive(n.pid));
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Phase 3: force-kill stragglers.
  remaining = remaining.filter((n) => isPidAlive(n.pid));
  for (const n of remaining) {
    logger.warn(`  node ${n.id} (pid ${n.pid}) did not exit gracefully — sending SIGKILL.`);
    try {
      process.kill(n.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }

  clearState();
  if (req.purge) purgeData();

  logger.info('Nano cluster stopped.');
  if (!req.purge) {
    logger.info(`Engine data retained under ${getDataDir()} (use "stop --purge" to delete).`);
  }
}

function purgeData() {
  const logger = getLogger();
  const dir = getDataDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    logger.info(`Purged engine data: ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Render a cluster's live topology (brokers + partition roles) as reported by
 * GET /v2/topology. Works for any reachable Nano BPM gateway, whether or not
 * c8ctl started it.
 */
function printTopology(topo, endpoint) {
  const id = classifyTopology(topo);
  console.log(
    `  product:      ${id.label}${id.engine ? ` (${id.engine})` : ''}` +
      `${id.version ? ` ${id.version}` : ''}`,
  );
  console.log(
    `  cluster size: ${topo.clusterSize ?? topo.brokers.length}` +
      `   partitions: ${topo.partitionsCount ?? '?'}` +
      `   RF: ${topo.replicationFactor ?? '?'}` +
      `${topo.gatewayVersion ? `   gateway: ${topo.gatewayVersion}` : ''}`,
  );
  console.log(`  endpoint:     ${endpoint}/v2/topology`);
  console.log('');
  console.log('  NODE  ADDRESS               PARTITIONS (role)            VERSION');
  const sorted = [...topo.brokers].sort((a, b) => (a.nodeId ?? 0) - (b.nodeId ?? 0));
  for (const b of sorted) {
    const addr = `${b.host}:${b.port}`;
    const parts = Array.isArray(b.partitions)
      ? b.partitions.map((p) => `${p.partitionId}:${p.role ?? '?'}`).join(' ')
      : '';
    console.log(
      `  ${String(b.nodeId ?? '?').padEnd(4)}  ${addr.padEnd(20)}  ${parts.padEnd(27)}  ${b.version ?? ''}`,
    );
  }
  console.log('');
}

async function statusCluster(req) {
  const state = readState();

  // Where to look for a live topology: the recorded cluster's nodes if we have
  // them, otherwise a default localhost endpoint (overridable with --port).
  const probePort = req?.basePort ?? state?.basePort ?? DEFAULT_BASE_PORT;
  const probeUrls =
    state && Array.isArray(state.nodes) && state.nodes.length > 0
      ? state.nodes.map((n) => n.url)
      : [`http://127.0.0.1:${probePort}`];

  // Find the first node that answers /v2/topology — the authoritative view.
  let topo = null;
  let topoUrl = null;
  for (const url of probeUrls) {
    topo = await fetchTopology(url);
    if (topo) {
      topoUrl = url;
      break;
    }
  }

  // No cluster recorded by c8ctl: fall back entirely to the topology probe so
  // status still works for an externally started cluster.
  if (!state || !Array.isArray(state.nodes) || state.nodes.length === 0) {
    if (!topo) {
      console.log(
        `Nano cluster status: stopped (no cluster recorded by c8ctl; nothing answering at ` +
          `http://127.0.0.1:${probePort}/v2/topology)`,
      );
      console.log('  Tip: point at a different port with "c8ctl nano status --port <port>".');
      return;
    }
    const id = classifyTopology(topo);
    if (id.product === 'camunda') {
      console.log(`Detected a Camunda gateway (not Nano) at ${topoUrl}.`);
      console.log('  This was not started by c8ctl nano; manage it with Camunda tooling.');
      printTopology(topo, topoUrl);
      return;
    }
    console.log('Nano cluster status: running (external — not started by c8ctl)');
    printTopology(topo, topoUrl);
    return;
  }

  // c8ctl-managed cluster: report process liveness + per-node health.
  const checks = await Promise.all(
    state.nodes.map(async (n) => ({
      ...n,
      alive: isPidAlive(n.pid),
      healthy: await probeHealthy(n.url),
    })),
  );

  const liveCount = checks.filter((c) => c.alive).length;
  const healthyCount = checks.filter((c) => c.healthy).length;
  const overall =
    healthyCount === checks.length ? 'running' : liveCount > 0 ? 'degraded' : 'stopped';

  console.log(`Nano cluster status: ${overall}`);
  console.log(
    `  started: ${state.startedAt}   partitions: ${state.partitions}   RF: ${state.rf}` +
      `${state.raft ? '   raft: on' : ''}${state.capture ? '   trace capture: on' : ''}`,
  );
  console.log(`  binary:    ${state.binary}`);
  console.log(`  workspace: ${state.workspaceDir || getWorkspaceDir()}`);
  console.log(`  data:      ${getDataDir()}`);
  console.log('');
  console.log('  NODE  PORT   PID       PROCESS   HEALTH    URL');
  for (const c of checks) {
    const proc = c.alive ? (c.paused ? 'paused' : 'alive') : 'dead';
    const health = c.healthy ? 'healthy' : c.paused ? 'paused' : c.alive ? 'unreachable' : '-';
    console.log(
      `  ${String(c.id).padEnd(4)}  ${String(c.port).padEnd(5)}  ${String(c.pid).padEnd(8)}  ` +
        `${proc.padEnd(8)}  ${health.padEnd(8)}  ${c.url}`,
    );
  }
  console.log('');

  // Enrich with the live topology when reachable — the authoritative view of
  // partition leadership across the cluster.
  if (topo) {
    console.log('  Live topology:');
    printTopology(topo, topoUrl);
  }

  if (overall === 'stopped') {
    console.log('  All recorded nodes are dead. Run "c8ctl nano stop" to clear stale state.');
  } else if (overall === 'degraded') {
    console.log('  Some nodes are not healthy. Check logs in ' + getLogDir());
  }

  const paused = checks.filter((c) => c.paused && c.alive);
  if (paused.length > 0) {
    console.log(
      `  Paused (SIGSTOP): node(s) ${paused.map((c) => c.id).join(', ')} — ` +
        `resume with "c8ctl nano resume <nodeId>".`,
    );
  }

  if (state.capture) {
    console.log(
      '  Trace capture is ON (recorded-input replay). Read a trace with ' +
        'GET /console/api/traces/{instanceKey} (creationVariables + stimuli[]).',
    );
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function logsCluster(req) {
  const logger = getLogger();
  const state = readState();

  let files;
  const idArg = req.positional[0];
  if (idArg !== undefined) {
    const id = Number.parseInt(idArg, 10);
    const file = join(getLogDir(), `node-${id}.log`);
    if (!existsSync(file)) {
      logger.error(`No log file for node ${id} at ${file}`);
      process.exit(1);
    }
    files = [file];
  } else if (state && Array.isArray(state.nodes) && state.nodes.length > 0) {
    files = state.nodes.map((n) => n.logFile).filter((f) => existsSync(f));
  } else if (existsSync(getLogDir())) {
    files = readdirSync(getLogDir())
      .filter((f) => f.endsWith('.log'))
      .map((f) => join(getLogDir(), f));
  } else {
    files = [];
  }

  if (files.length === 0) {
    logger.warn('No nano log files found.');
    return;
  }

  const tailArgs = req.follow ? ['-n', '+1', '-F', ...files] : ['-n', '200', ...files];
  const proc = spawn('tail', tailArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', (err) => {
    logger.error(`Failed to read logs: ${err.message}`);
    logger.info(`Log files:\n  ${files.join('\n  ')}`);
  });
}

// ---------------------------------------------------------------------------
// pause / resume — freeze or resume a node to simulate a node failing and
// coming back online. SIGSTOP halts the process (uncatchable, like a hang or
// network partition); SIGCONT resumes it. The node keeps its PID and on-disk
// state, so this exercises Raft failover/recovery without a real restart.
// ---------------------------------------------------------------------------

function controlNode(req, { signal, verb, paused }) {
  const logger = getLogger();
  const state = readState();

  if (!state || !Array.isArray(state.nodes) || state.nodes.length === 0) {
    logger.error('No c8ctl-managed cluster is running. Start one with "c8ctl nano start <nodes>".');
    process.exit(1);
  }

  const nodeIds = state.nodes.map((n) => n.id).join(', ');
  const idArg = req.positional[0];
  if (idArg === undefined) {
    logger.error(`Specify a node id, e.g. "c8ctl nano ${verb} 1". Nodes: ${nodeIds}`);
    process.exit(1);
  }

  const id = Number.parseInt(idArg, 10);
  const node = Number.isFinite(id) ? state.nodes.find((n) => n.id === id) : undefined;
  if (!node) {
    logger.error(`No node "${idArg}" in the running cluster. Nodes: ${nodeIds}`);
    process.exit(1);
  }

  if (!isPidAlive(node.pid)) {
    logger.error(`Node ${id} (pid ${node.pid}) is not running — cannot ${verb} it.`);
    process.exit(1);
  }

  if (paused && node.paused) {
    logger.warn(`Node ${id} is already paused.`);
    return;
  }
  if (!paused && !node.paused) {
    logger.warn(`Node ${id} is not paused — nothing to resume.`);
    return;
  }

  try {
    process.kill(node.pid, signal);
  } catch (err) {
    logger.error(`Failed to ${verb} node ${id} (pid ${node.pid}): ${err.message}`);
    process.exit(1);
  }

  node.paused = paused;
  writeState(state);

  if (paused) {
    logger.info(
      `Paused node ${id} (pid ${node.pid}, ${node.url}) — sent SIGSTOP. ` +
        `The process is frozen; resume it with "c8ctl nano resume ${id}".`,
    );
  } else {
    logger.info(`Resumed node ${id} (pid ${node.pid}, ${node.url}) — sent SIGCONT.`);
  }
}

// ---------------------------------------------------------------------------
// clean — wipe engine data (journal/snapshots/spill) + logs from disk. The
// persistent workspace (models/workers) is deliberately preserved.
// ---------------------------------------------------------------------------

function cleanCluster(req) {
  const logger = getLogger();
  const state = readState();

  if (state && liveNodeCount(state) > 0) {
    logger.error(
      `Refusing to clean while ${liveNodeCount(state)} node(s) are running. ` +
        `Stop the cluster first: c8ctl nano stop`,
    );
    process.exit(1);
  }

  // Stopped cluster with leftover state — clear the stale marker too.
  if (state) clearState();

  const dataDir = getDataDir();
  const logDir = getLogDir();
  let removed = 0;

  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    logger.info(`Removed engine data: ${dataDir}`);
    removed++;
  }
  if (existsSync(logDir)) {
    rmSync(logDir, { recursive: true, force: true });
    logger.info(`Removed logs: ${logDir}`);
    removed++;
  }

  if (removed === 0) {
    logger.info('Nothing to clean — no engine data or logs on disk.');
  } else {
    logger.info(`Workspace preserved: ${getWorkspaceDir()} (models/, workers/)`);
  }

  if (req.workspace) {
    const ws = getWorkspaceDir();
    if (existsSync(ws)) {
      rmSync(ws, { recursive: true, force: true });
      logger.warn(`Removed workspace (models + workers): ${ws}`);
    }
  }
}

// ---------------------------------------------------------------------------
// set / config — persistent user settings (binary path, workspace location)
// ---------------------------------------------------------------------------

const SETTING_ALIASES = {
  bin: 'binary',
  binary: 'binary',
  'model-dir': 'workspaceDir',
  'models-dir': 'workspaceDir',
  workspace: 'workspaceDir',
  'workspace-dir': 'workspaceDir',
};

function setConfig(req) {
  const logger = getLogger();
  const key = req.positional[0];
  const value = req.positional[1];

  if (!key || !(key in SETTING_ALIASES)) {
    logger.error('Usage: c8ctl nano set <bin|model-dir> <path>');
    logger.info('Settings:');
    logger.info('  bin <path>        Path to the nanobpmn server binary');
    logger.info('  model-dir <path>  Workspace root holding models/ and workers/');
    process.exit(1);
  }
  if (!value) {
    logger.error(`Please provide a value: c8ctl nano set ${key} <path>`);
    process.exit(1);
  }

  const field = SETTING_ALIASES[key];
  const expanded = expandHome(value);
  const abs = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);

  if (field === 'binary' && !existsSync(abs)) {
    logger.error(`Binary not found at ${abs}`);
    process.exit(1);
  }

  const cfg = readConfig();
  cfg[field] = abs;
  writeConfig(cfg);

  logger.info(`Set ${field} = ${abs}`);
  if (field === 'workspaceDir') {
    ensureWorkspace();
    logger.info('Created models/ and workers/ subdirectories.');
    const running = readState();
    if (running && liveNodeCount(running) > 0) {
      logger.warn('A cluster is running — restart it for the new workspace to take effect.');
    }
  }
}

function showConfig() {
  const cfg = readConfig();
  console.log('Nano plugin configuration:');
  console.log('');
  console.log(`  state home   ${getStateHome()}`);
  console.log(`  binary       ${cfg.binary || '(auto-detect: $NANOBPMN_BINARY or repo build)'}`);
  console.log(`  workspace    ${getWorkspaceDir()}${cfg.workspaceDir ? '' : '  (default)'}`);
  console.log(`  data dir     ${getDataDir()}`);
  console.log(`  log dir      ${getLogDir()}`);
  console.log('');
  console.log(`  config file  ${getConfigFile()}`);
  console.log('');
  console.log('  Change with: c8ctl nano set bin <path> | c8ctl nano set model-dir <path>');
}

// ---------------------------------------------------------------------------
// metadata + commands
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'c8ctl-plugin-nano',
  description: 'Start, inspect, and stop a local Nano BPM (nanobpmn) cluster',
  commands: {
    nano: {
      description: 'Manage a local Nano BPM cluster — start, status, stop, logs',
      examples: [
        { command: 'c8ctl nano start', description: 'Start a single-node Nano BPM cluster' },
        { command: 'c8ctl nano start 3', description: 'Start a 3-node local cluster' },
        {
          command: 'c8ctl nano start 3 --rf 3',
          description: 'Start a 3-node Raft-replicated cluster (RF=3)',
        },
        { command: 'c8ctl nano start 3 --port 9000', description: 'Start 3 nodes on ports 9000..9002' },
        { command: 'c8ctl nano start --capture', description: 'Start with trace capture for historical replay/analysis' },
        { command: 'c8ctl nano status', description: 'Show cluster status and per-node health' },
        { command: 'c8ctl nano pause 1', description: 'Freeze node 1 (SIGSTOP) to simulate a node failure' },
        { command: 'c8ctl nano resume 1', description: 'Resume node 1 (SIGCONT) to bring it back online' },
        { command: 'c8ctl nano logs 1 --follow', description: "Stream node 1's log" },
        { command: 'c8ctl nano stop', description: 'Stop the running cluster (keep data)' },
        { command: 'c8ctl nano stop --purge', description: 'Stop the cluster and delete engine data' },
        { command: 'c8ctl nano clean', description: 'Wipe journal/data + logs on disk (keeps models/workers)' },
        { command: 'c8ctl nano set bin <path>', description: 'Set the nanobpmn server binary path' },
        { command: 'c8ctl nano set model-dir <path>', description: 'Set the workspace dir (models + workers)' },
        { command: 'c8ctl nano config', description: 'Show current plugin configuration and paths' },
      ],
    },
  },
};

export const commands = {
  nano: {
    flags: {
      nodes: { type: 'string', description: 'Number of nodes to start (alt to positional arg)' },
      port: { type: 'string', description: 'start: base port (node i = basePort+i); status: endpoint port to probe (default 8080)' },
      partitions: { type: 'string', description: 'Total partitions across the cluster (default = node count)' },
      rf: { type: 'string', description: 'Replication factor; >1 enables Raft (default 1)' },
      raft: { type: 'boolean', description: 'Force per-partition Raft on/off (default: on when rf>1)' },
      capture: { type: 'boolean', description: 'start: enable trace capture (recorded-input replay) on every node' },
      follow: { type: 'boolean', description: 'logs: stream output (tail -F)', short: 'f' },
      purge: { type: 'boolean', description: 'stop: also delete per-node engine data' },
      force: { type: 'boolean', description: 'start: stop any existing cluster first' },
      workspace: { type: 'boolean', description: 'clean: also delete the workspace (models + workers)' },
      binary: { type: 'string', description: 'Path to the nanobpmn server binary' },
    },
    handler: async (args, flags) => {
      const logger = getLogger();
      const req = parseRequest(args, flags);

      if (!req.subcommand || !VALID_SUBCOMMANDS.includes(req.subcommand)) {
        printUsage();
        return;
      }

      try {
        switch (req.subcommand) {
          case 'start':
            await startCluster(req);
            break;
          case 'stop':
            await stopCluster(req);
            break;
          case 'status':
            await statusCluster(req);
            break;
          case 'log':
          case 'logs':
            logsCluster(req);
            break;
          case 'restart':
            await stopCluster({ purge: false });
            await startCluster({ ...req, force: true });
            break;
          case 'pause':
            controlNode(req, { signal: 'SIGSTOP', verb: 'pause', paused: true });
            break;
          case 'resume':
            controlNode(req, { signal: 'SIGCONT', verb: 'resume', paused: false });
            break;
          case 'clean':
            cleanCluster(req);
            break;
          case 'set':
            setConfig(req);
            break;
          case 'config':
            showConfig();
            break;
        }
      } catch (error) {
        logger.error(`nano ${req.subcommand} failed: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    },
  },
};

function printUsage() {
  console.log('Usage:');
  console.log('  c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>] [--raft] [--capture] [--binary <path>]');
  console.log('  c8ctl nano status [--port <port>]');
  console.log('  c8ctl nano stop [--purge]');
  console.log('  c8ctl nano logs [<nodeId>] [--follow]');
  console.log('  c8ctl nano pause <nodeId>');
  console.log('  c8ctl nano resume <nodeId>');
  console.log('  c8ctl nano restart [<nodes>] ...');
  console.log('  c8ctl nano clean [--workspace]');
  console.log('  c8ctl nano set <bin|model-dir> <path>');
  console.log('  c8ctl nano config');
  console.log('');
  console.log('Subcommands:');
  console.log('  start    Spawn an N-node local cluster wired to talk to each other on localhost');
  console.log('  status   Show cluster status; queries /v2/topology (works for any running node)');
  console.log('  stop     Stop all nodes (add --purge to also delete engine data)');
  console.log('  logs     Show or follow node logs');
  console.log('  pause    Freeze a node (SIGSTOP) to simulate it failing');
  console.log('  resume   Resume a frozen node (SIGCONT) to bring it back online');
  console.log('  restart  Stop then start');
  console.log('  clean    Wipe journal/data + logs on disk (keeps models/workers)');
  console.log('  set      Persist a setting: "bin <path>" or "model-dir <path>"');
  console.log('  config   Show current configuration and on-disk locations');
  console.log('');
  console.log('Options:');
  console.log('  <nodes>              Number of nodes to start (default 1)');
  console.log('  --port <basePort>    start: base port (node i = basePort+i); status: port to probe (default 8080)');
  console.log('  --partitions <n>     Total partitions across the cluster (default = node count)');
  console.log('  --rf <n>             Replication factor; >1 enables Raft (default 1)');
  console.log('  --raft               Force Raft on (default: on iff rf>1)');
  console.log('  --capture            start: enable trace capture (recorded-input replay) on every node');
  console.log('  --binary <path>      Path to the nanobpmn server binary (overrides "set bin")');
  console.log('  --purge              stop: also delete per-node engine data');
  console.log('  --force              start: stop any existing cluster first');
  console.log('  --workspace          clean: also delete the workspace (models + workers)');
  console.log('');
  console.log('Persistent assets:');
  console.log('  Models and workers live in the workspace dir (NANOBPMN_WORKSPACE_DIR),');
  console.log('  shared by all nodes and never touched by "stop" or "clean". Engine data');
  console.log('  (journal/snapshots/spill) is per-node and ephemeral. Set the workspace');
  console.log('  location with "c8ctl nano set model-dir <path>"; see "c8ctl nano config".');
  console.log('');
  console.log('Trace capture (--capture):');
  console.log('  Sets NANOBPMN_TRACE_STIMULI=1 on every node, enabling the recorded-input');
  console.log('  (stimuli) log plus variable capture for historical replay/analysis. Read a');
  console.log('  trace with GET /console/api/traces/{instanceKey} (creationVariables +');
  console.log('  stimuli[] + per-incident variables). Tune via env vars passed through from');
  console.log('  your shell: NANOBPMN_TRACE_VARIABLES_MAX_BYTES (16384), NANOBPMN_TRACE_STIMULI_MAX');
  console.log('  (1024), NANOBPMN_TRACE_CAPACITY (2000).');
  console.log('');
  console.log('Examples:');
  console.log('  c8ctl nano start 3            # 3-node cluster on ports 8080..8082');
  console.log('  c8ctl nano start 3 --rf 3     # 3-node Raft-replicated cluster');
  console.log('  c8ctl nano start --capture    # single node with trace capture for replay');
  console.log('  c8ctl nano status');
  console.log('  c8ctl nano pause 1            # freeze node 1 to simulate a failure');
  console.log('  c8ctl nano resume 1          # bring node 1 back online');
  console.log('  c8ctl nano logs 1 --follow');
  console.log('  c8ctl nano stop --purge');
  console.log('  c8ctl nano clean             # free disk after stopping, keep models/workers');
  console.log('  c8ctl nano set bin ~/workspace/nanobpmn/server/target/release/nanobpm-gateway-rest-server');
  console.log('  c8ctl nano set model-dir ~/bpmn-workspace');
}
