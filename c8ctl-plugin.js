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

/** The nanobpmn source/checkout root used to locate a built binary. */
function getRepoRoot() {
  return expandHome(process.env.NANOBPMN_REPO || join(homedir(), 'workspace', 'nanobpmn'));
}

/**
 * Locate the nanobpmn server binary. Resolution order:
 *   1. --binary flag
 *   2. NANOBPMN_BINARY env var
 *   3. release build under the nanobpmn repo
 *   4. debug build under the nanobpmn repo
 */
function findBinary(flags) {
  const explicit = (flags?.binary && String(flags.binary)) || process.env.NANOBPMN_BINARY;
  if (explicit) {
    const p = expandHome(explicit);
    const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
    if (!existsSync(abs)) {
      throw new Error(`Binary not found at ${abs} (from ${flags?.binary ? '--binary' : 'NANOBPMN_BINARY'})`);
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
      `Or point at one with --binary <path> or NANOBPMN_BINARY=<path>.`,
  );
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['start', 'stop', 'status', 'logs', 'log', 'restart'];

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

async function waitForHealthy(url, timeoutMs = READINESS_TIMEOUT_MS) {
  const start = Date.now();
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

  // Pre-flight: make sure the chosen ports are free.
  const ports = Array.from({ length: nodeCount }, (_, i) => basePort + i);
  for (const port of ports) {
    if (await probeHealthy(`http://127.0.0.1:${port}`)) {
      logger.error(`Port ${port} is already serving an HTTP endpoint. Choose another --port base.`);
      process.exit(1);
    }
  }

  const peers = ports.map((p) => `http://127.0.0.1:${p}`);
  const nodesEnv = peers.join(',');

  mkdirSync(getDataDir(), { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });

  logger.info(
    `Starting Nano BPM cluster: ${nodeCount} node(s), ${partitions} partition(s), ` +
      `RF=${rf}${raft ? ', Raft on' : ''}`,
  );
  logger.info(`Binary: ${binary}`);

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
    };
    if (raft) env.NANOBPMN_RAFT = '1';

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
    partitions,
    rf,
    raft,
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

  // Phase 1: polite SIGTERM.
  for (const n of alive) {
    try {
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

async function statusCluster() {
  const state = readState();
  if (!state || !Array.isArray(state.nodes) || state.nodes.length === 0) {
    console.log('Nano cluster status: stopped (no cluster recorded)');
    return;
  }

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
      `${state.raft ? '   raft: on' : ''}`,
  );
  console.log(`  binary:  ${state.binary}`);
  console.log('');
  console.log('  NODE  PORT   PID       PROCESS   HEALTH    URL');
  for (const c of checks) {
    const proc = c.alive ? 'alive' : 'dead';
    const health = c.healthy ? 'healthy' : c.alive ? 'unreachable' : '-';
    console.log(
      `  ${String(c.id).padEnd(4)}  ${String(c.port).padEnd(5)}  ${String(c.pid).padEnd(8)}  ` +
        `${proc.padEnd(8)}  ${health.padEnd(8)}  ${c.url}`,
    );
  }
  console.log('');

  if (overall === 'stopped') {
    console.log('  All recorded nodes are dead. Run "c8ctl nano stop" to clear stale state.');
  } else if (overall === 'degraded') {
    console.log('  Some nodes are not healthy. Check logs in ' + getLogDir());
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
        { command: 'c8ctl nano status', description: 'Show cluster status and per-node health' },
        { command: 'c8ctl nano logs 1 --follow', description: "Stream node 1's log" },
        { command: 'c8ctl nano stop', description: 'Stop the running cluster (keep data)' },
        { command: 'c8ctl nano stop --purge', description: 'Stop the cluster and delete engine data' },
      ],
    },
  },
};

export const commands = {
  nano: {
    flags: {
      nodes: { type: 'string', description: 'Number of nodes to start (alt to positional arg)' },
      port: { type: 'string', description: 'Base HTTP port; node i listens on basePort+i (default 8080)' },
      partitions: { type: 'string', description: 'Total partitions across the cluster (default = node count)' },
      rf: { type: 'string', description: 'Replication factor; >1 enables Raft (default 1)' },
      raft: { type: 'boolean', description: 'Force per-partition Raft on/off (default: on when rf>1)' },
      follow: { type: 'boolean', description: 'logs: stream output (tail -F)', short: 'f' },
      purge: { type: 'boolean', description: 'stop: also delete per-node engine data' },
      force: { type: 'boolean', description: 'start: stop any existing cluster first' },
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
            await statusCluster();
            break;
          case 'log':
          case 'logs':
            logsCluster(req);
            break;
          case 'restart':
            await stopCluster({ purge: false });
            await startCluster({ ...req, force: true });
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
  console.log('  c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>] [--raft] [--binary <path>]');
  console.log('  c8ctl nano status');
  console.log('  c8ctl nano stop [--purge]');
  console.log('  c8ctl nano logs [<nodeId>] [--follow]');
  console.log('  c8ctl nano restart [<nodes>] ...');
  console.log('');
  console.log('Subcommands:');
  console.log('  start    Spawn an N-node local cluster wired to talk to each other on localhost');
  console.log('  status   Show whether the cluster is running and per-node health');
  console.log('  stop     Stop all nodes (add --purge to also delete engine data)');
  console.log('  logs     Show or follow node logs');
  console.log('  restart  Stop then start');
  console.log('');
  console.log('Options:');
  console.log('  <nodes>              Number of nodes to start (default 1)');
  console.log('  --port <basePort>    Base port; node i listens on basePort+i (default 8080)');
  console.log('  --partitions <n>     Total partitions across the cluster (default = node count)');
  console.log('  --rf <n>             Replication factor; >1 enables Raft (default 1)');
  console.log('  --raft               Force Raft on (default: on iff rf>1)');
  console.log('  --binary <path>      Path to the nanobpmn server binary');
  console.log('                       (default: $NANOBPMN_BINARY, else a build under $NANOBPMN_REPO)');
  console.log('  --purge              stop: also delete per-node engine data');
  console.log('  --force              start: stop any existing cluster first');
  console.log('');
  console.log('Examples:');
  console.log('  c8ctl nano start 3            # 3-node cluster on ports 8080..8082');
  console.log('  c8ctl nano start 3 --rf 3     # 3-node Raft-replicated cluster');
  console.log('  c8ctl nano status');
  console.log('  c8ctl nano logs 1 --follow');
  console.log('  c8ctl nano stop --purge');
}
