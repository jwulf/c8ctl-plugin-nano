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
 *                    [--in-memory] [--history-max <n>]
 *   c8ctl nano status
 *   c8ctl nano stop [--purge]
 *   c8ctl nano logs [<nodeId>] [--follow]
 *   c8ctl nano restart [<nodes>] [--purge] ...
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join, isAbsolute, resolve as resolvePath, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { platformForHost } from './platforms.mjs';

const requireFromHere = createRequire(import.meta.url);
const pluginDir = dirname(fileURLToPath(import.meta.url));

/**
 * Read the bundled-binary marker (nanobpmn-binary.json) written by the upstream
 * release pipeline. Records which nanobpmn build the shipped binaries came from.
 * Best-effort: returns undefined when absent or unset (e.g. local dev checkout).
 */
function readBundledBinaryInfo() {
  try {
    const p = join(pluginDir, 'nanobpmn-binary.json');
    if (!existsSync(p)) return undefined;
    const info = JSON.parse(readFileSync(p, 'utf8'));
    if (!info || !info.version || info.version === '0.0.0-dev') return undefined;
    return info;
  } catch {
    return undefined;
  }
}

/** Run `<binary> --version` and extract a semver-ish token. Null on failure. */
function binaryVersion(binary) {
  if (!binary) return null;
  try {
    const res = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (res.status === 0) {
      const m = String(res.stdout || res.stderr || '').match(/(\d+\.\d+\.\d+[^\s]*)/);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Locate the nanobpmn binary shipped by the matching platform package
 * (an optionalDependency such as @nanobpm/c8ctl-plugin-nano-darwin-arm64).
 * Returns the absolute path, or undefined if the package isn't installed for
 * this host.
 */
function findPlatformPackageBinary() {
  const p = platformForHost();
  if (!p) return undefined;
  try {
    const manifest = requireFromHere.resolve(`${p.pkg}/package.json`);
    const bin = join(dirname(manifest), p.bin);
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

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
const PROCESSOS_STATE_FILE = 'processos.json';
const PROCESSOS_DEFAULT_PORT = 8090;
const DEFAULT_NANO_URL = 'http://localhost:8080';

// Passive update notifier (npm-style): refresh the latest published version
// from the registry in a detached background process at most once per day, and
// surface a one-line "update available" notice at most once per day. Never
// blocks a command and never fails one.
const UPDATE_CACHE_FILE = 'update-check.json';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

// ProcessOS is a closed beta distributed out-of-band: the binary lives in an
// S3 bucket whose base URL is handed to enabled users via PROCESSOS_DOWNLOAD_URL.
// `<base>/processos-<os>-<arch>[.exe]` is the per-platform binary and
// `<base>/version.json` is the {version,commit,updated} metadata the CI writes
// next to it (the analogue of npm's latest-version lookup for the nano plugin).
const PROCESSOS_VERSION_META = 'version.json';
const PROCESSOS_BINARY_META_FILE = 'processos-binary.json';
const PROCESSOS_UPDATE_CACHE_FILE = 'processos-update-check.json';

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
 * Locate the nanobpmn server binary AND report its provenance. Resolution order:
 *   1. --binary flag                         -> source 'flag'        (self-managed)
 *   2. configured binary path ("nano set bin") -> source 'configured' (self-managed)
 *   3. NANOBPMN_BINARY env var               -> source 'configured'  (self-managed)
 *   4. matching platform package (npm)       -> source 'managed-npm' (managed)
 *   5. release build under the nanobpmn repo -> source 'repo-release'(self-managed)
 *   6. debug build under the nanobpmn repo   -> source 'repo-debug'  (self-managed)
 *
 * Returns `{ path, source, from, channel?, updatePkg? }`. Only the npm platform
 * package (source 4) is a plugin-owned "managed" binary the plugin may update in
 * place; for it we also report `channel:'npm'` and `updatePkg` (the plugin
 * package the console/server should `npm view` for the latest version — the
 * update unit, since the platform binary ships pinned to the plugin release).
 * Every other source is a user-configured or dev/repo build: self-managed, so
 * the console must disable self-update and suppress "update available" nags.
 *
 * Throws (with actionable guidance) when no binary can be found.
 */
function resolveBinary(flags) {
  const cfg = readConfig();
  const sources = [
    { val: flags?.binary && String(flags.binary), from: '--binary', source: 'flag' },
    {
      val: cfg.binary && String(cfg.binary),
      from: 'configured bin ("nano set bin")',
      source: 'configured',
    },
    { val: process.env.NANOBPMN_BINARY, from: 'NANOBPMN_BINARY', source: 'configured' },
  ];
  for (const { val, from, source } of sources) {
    if (!val) continue;
    const p = expandHome(val);
    const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
    if (!existsSync(abs)) {
      throw new Error(`Binary not found at ${abs} (from ${from})`);
    }
    return { path: abs, source, from };
  }

  const fromPackage = findPlatformPackageBinary();
  if (fromPackage) {
    return {
      path: fromPackage,
      source: 'managed-npm',
      from: 'platform package (npm)',
      channel: 'npm',
      // The update unit is the plugin meta-package: the platform binary ships
      // pinned to it, so `npm view <plugin> version` is the server's "latest".
      updatePkg: pluginPackage().name,
    };
  }

  const repo = getRepoRoot();
  const name = 'nanobpm-gateway-rest-server';
  const candidates = [
    { path: join(repo, 'server', 'target', 'release', name), source: 'repo-release' },
    { path: join(repo, 'server', 'target', 'debug', name), source: 'repo-debug' },
  ];
  for (const c of candidates) {
    if (existsSync(c.path)) return { path: c.path, source: c.source, from: `repo build (${c.source})` };
  }
  const host = `${process.platform}/${process.arch}`;
  const expectedPkg = platformForHost()?.pkg;
  throw new Error(
    `Could not find the nanobpmn server binary.\n` +
      (expectedPkg
        ? `No platform package installed for ${host} (expected "${expectedPkg}").\n` +
          `Reinstall the plugin so npm can fetch it, or build from source below.\n`
        : `No prebuilt binary is published for this platform (${host}).\n`) +
      `Looked for a local build in:\n  ${candidates.map((c) => c.path).join('\n  ')}\n` +
      `Build it with: (cd ${repo} && make release-gateway)\n` +
      `Or set one with "c8ctl nano set bin <path>", --binary <path>, or NANOBPMN_BINARY=<path>.`,
  );
}

/**
 * Locate the nanobpmn server binary (absolute path). Thin wrapper over
 * [`resolveBinary`] for the many call sites that only need the path.
 */
function findBinary(flags) {
  return resolveBinary(flags).path;
}

/**
 * Launcher-identity + binary-provenance env markers stamped onto every server
 * process this plugin spawns, so the running server (and its console UI) can
 * tell it was launched by us and whether its binary is plugin-managed
 * (self-updatable) vs. self-managed/dev (update disabled, nags suppressed).
 *
 * `resolved` is a [`resolveBinary`] descriptor. Safe to call with `undefined`
 * (e.g. when the binary could not be resolved) — it still stamps the launcher
 * identity, and the server treats an absent source as self-managed/unknown.
 */
function launcherEnvMarkers(resolved) {
  const markers = { NANOBPMN_LAUNCHER: 'c8ctl-plugin-nano' };
  const { version } = pluginPackage();
  // The plugin version is the update unit's "current" in the npm channel's
  // version space (same space as `npm view <plugin> version` -> latest), so the
  // server compares like-for-like instead of against its own git-describe build.
  if (version) markers.NANOBPMN_LAUNCHER_VERSION = version;
  if (resolved?.source) markers.NANOBPMN_BINARY_SOURCE = resolved.source;
  if (resolved?.channel) markers.NANOBPMN_UPDATE_CHANNEL = resolved.channel;
  if (resolved?.updatePkg) markers.NANOBPMN_UPDATE_PKG = resolved.updatePkg;
  return markers;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['start', 'stop', 'status', 'logs', 'log', 'restart', 'pause', 'resume', 'clean', 'set', 'config', 'update'];

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
    inMemory: Boolean(flags?.['in-memory'] || flags?.['no-journal']),
    historyMax: intFlag('history-max'),
    workspace: Boolean(flags?.workspace),
    check: Boolean(flags?.check),
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
 * Probe whether `path` on `url` answers with a 2xx. Used to detect whether this
 * binary was built with the web console (which serves the landing page `/`,
 * `/console`, and the `/docs` user guide); the API-only gateway 404s them.
 */
async function probePath(url, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, { signal: controller.signal });
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
  const inMemory = Boolean(req.inMemory);
  const historyMax = req.historyMax;

  if (partitions < nodeCount) {
    logger.warn(
      `partitions (${partitions}) < nodes (${nodeCount}): some nodes will own no partitions ` +
        `and act as gateways only. Pass --partitions >= ${nodeCount} to spread ownership.`,
    );
  }
  if (req.rf && req.rf > nodeCount) {
    logger.warn(`--rf ${req.rf} clamped to node count (${nodeCount}).`);
  }
  if (inMemory) {
    logger.warn(
      'In-memory mode: no journal or read-model is written to disk. Engine state is ' +
        'lost on stop/restart, and every retained instance lives in RAM' +
        (historyMax === undefined
          ? ' — pair with --history-max <N> to bound RAM under sustained load.'
          : '.'),
    );
    if (raft || rf > 1) {
      logger.warn(
        'In-memory mode with Raft/replication: replicated logs are not persisted; ' +
          'a restarted node recovers nothing.',
      );
    }
  }

  const resolvedBinary = resolveBinary(req);
  const binary = resolvedBinary.path;
  // Launcher-identity + binary-provenance markers, stamped on every node so the
  // server's console can offer (or suppress) a self-update. Computed once here.
  const launcherMarkers = launcherEnvMarkers(resolvedBinary);

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
      `RF=${rf}${raft ? ', Raft on' : ''}${capture ? ', trace capture on' : ''}` +
      `${inMemory ? ', in-memory (no disk)' : ''}` +
      `${historyMax !== undefined ? `, history-max=${historyMax}` : ''}`,
  );
  logger.info(`Binary:    ${binary}`);
  logger.info(`Workspace: ${workspaceDir} (models/, workers/)`);

  const nodes = [];
  for (let id = 0; id < nodeCount; id++) {
    const port = ports[id];
    const dataDir = join(getDataDir(), `node-${id}`);
    const logFile = join(getLogDir(), `node-${id}.log`);
    if (!inMemory) mkdirSync(dataDir, { recursive: true });

    const env = {
      ...process.env,
      // Launcher-identity + binary-provenance markers (after the process.env
      // spread so the launcher's own values win over any inherited stale ones).
      ...launcherMarkers,
      PORT: String(port),
      NANOBPMN_NODE_ID: String(id),
      NANOBPMN_NODES: nodesEnv,
      NANOBPMN_PARTITIONS: String(partitions),
      NANOBPMN_RF: String(rf),
      // Default to async durability (group-commit) for throughput; the user can
      // override per the spread of process.env above by exporting
      // NANOBPMN_DURABILITY (e.g. "sync") before running.
      NANOBPMN_DURABILITY: process.env.NANOBPMN_DURABILITY ?? 'async',
      // Replicate job activation as a digest by default so activated-job state
      // is observable across the cluster; override by exporting
      // NANOBPMN_REPLICATE_ACTIVATION (e.g. "off"/"full") before running.
      NANOBPMN_REPLICATE_ACTIVATION:
        process.env.NANOBPMN_REPLICATE_ACTIVATION ?? 'digest',
      // Acknowledge writes once durable on the leader by default; override by
      // exporting NANOBPMN_REPLICATION before running.
      NANOBPMN_REPLICATION: process.env.NANOBPMN_REPLICATION ?? 'leader-durable',
      // Shared, persistent authoring workspace (models + workers). Lives
      // outside the per-node data dir so "nano clean" never wipes it.
      NANOBPMN_WORKSPACE_DIR: workspaceDir,
    };
    // Storage axis: an on-disk journal + read-model under the per-node data dir
    // (default), or a fully in-memory engine (in-memory journal + :memory: read
    // store) when --in-memory is set. In in-memory mode, scrub any inherited
    // path vars so nothing leaks back to disk.
    if (inMemory) {
      delete env.NANOBPMN_DATA_DIR;
      delete env.NANOBPMN_JOURNAL;
      delete env.NANOBPMN_READ_DB;
    } else {
      env.NANOBPMN_DATA_DIR = dataDir;
    }
    // Bound retained terminal instances in the read model when requested. Works
    // in both storage modes (caps disk growth on-disk; caps RAM in-memory).
    if (historyMax !== undefined) {
      env.NANOBPMN_HISTORY_MAX_INSTANCES = String(historyMax);
    }
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

    nodes.push({ id, port, pid: child.pid, url: peers[id], dataDir: inMemory ? null : dataDir, logFile });
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
    inMemory,
    historyMax: historyMax ?? null,
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

  await printSummary(state);
}

async function printSummary(state) {
  console.log('');
  console.log(
    `Nano BPM cluster is up: ${state.nodes.length} node(s), ${state.partitions} partition(s), ` +
      `RF=${state.rf}${state.raft ? ', Raft on' : ''}${state.inMemory ? ', in-memory (no disk)' : ''}`,
  );
  console.log('');
  for (const n of state.nodes) {
    console.log(`  node ${n.id}  ${n.url}  (pid ${n.pid})`);
  }
  console.log('');
  const entry = state.nodes[0];
  // The landing page (and the /docs user guide + /console) only exist in builds
  // compiled with the web console; probe so we advertise the right entry point.
  const hasConsole = await probePath(entry.url, '/');
  if (hasConsole) {
    console.log(`  Start here   ${entry.url}/          (landing: console, user guide & API docs)`);
  }
  console.log(`  REST API     ${entry.url}/v2`);
  console.log(`  Topology     ${entry.url}/v2/topology`);
  if (hasConsole) {
    console.log(`  Web console  ${entry.url}/console`);
    console.log(`  User guide   ${entry.url}/docs`);
  }
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
    logger.info(
      `Engine data retained under ${getDataDir()} (run "c8ctl nano clean" to delete it now that the server is stopped).`,
    );
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
  console.log(`  version:   ${binaryVersion(state.binary) ?? 'unknown'}`);
  console.log(`  workspace: ${state.workspaceDir || getWorkspaceDir()}`);
  const historyNote =
    state.historyMax != null ? `, history-max ${state.historyMax}` : '';
  if (state.inMemory) {
    console.log(`  storage:   in-memory (no journal/read-model on disk${historyNote})`);
  } else {
    console.log(`  storage:   on-disk${historyNote}`);
    console.log(`  data:      ${getDataDir()}`);
  }
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
  const bundled = readBundledBinaryInfo();
  if (bundled) {
    const at = bundled.commit && bundled.commit !== 'unknown' ? ` (${bundled.commit})` : '';
    console.log(`  bundled nano ${bundled.version}${at}`);
  }
  console.log(`  workspace    ${getWorkspaceDir()}${cfg.workspaceDir ? '' : '  (default)'}`);
  console.log(`  data dir     ${getDataDir()}`);
  console.log(`  log dir      ${getLogDir()}`);
  console.log('');
  console.log(`  config file  ${getConfigFile()}`);
  console.log('');
  console.log('  Change with: c8ctl nano set bin <path> | c8ctl nano set model-dir <path>');
}

// ---------------------------------------------------------------------------
// update — pull a new nanobpmn release onto a machine with an existing install.
// The plugin (and the bundled server binary, shipped via the matching platform
// package) is distributed on npm as c8ctl-plugin-nano, so a release is pulled by
// reinstalling the package globally. We only ever drive npm here — never touch
// the private upstream source — so this works for any npm-installed user.
// ---------------------------------------------------------------------------

/** This plugin package's identity, read from its own package.json. */
function pluginPackage() {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    return { name: pkg.name || 'c8ctl-plugin-nano', version: pkg.version || null };
  } catch {
    return { name: 'c8ctl-plugin-nano', version: null };
  }
}

/**
 * Numeric semver comparison (major.minor.patch), ignoring any pre-release/build
 * suffix. Returns -1 if a<b, 0 if equal, 1 if a>b.
 */
function compareSemver(a, b) {
  const norm = (v) =>
    String(v)
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] || 0;
    const y = bv[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Latest published version of `name` per the npm registry (throws on failure). */
function npmLatestVersion(name) {
  const res = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8' });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) {
    throw new Error((res.stderr || '').trim() || `npm view exited ${res.status}`);
  }
  return res.stdout.trim();
}

/** True when this plugin lives under npm's global node_modules (so `-g` updates it). */
function isGlobalInstall() {
  const res = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (res.status !== 0) return false;
  const root = res.stdout.trim();
  return Boolean(root) && pluginDir.startsWith(root);
}

/**
 * How this plugin is installed, which decides how `nano update` self-updates:
 *   - 'managed': under c8ctl's own plugin store (…/c8ctl/plugins/node_modules),
 *       where `c8ctl load plugin` installed it. Self-update in place by
 *       reinstalling into that same npm --prefix. This is the norm for the
 *       integrated c8ctl plugin architecture, so it takes precedence over a
 *       coincidental global install of the same name.
 *   - 'global': under `npm root -g` (a plain `npm install -g`).
 *   - 'local':  a checkout / `npm link` — self-update isn't safe; tell the user.
 */
function pluginInstallInfo() {
  const rt = globalThis.c8ctl;
  if (rt && typeof rt.getUserDataDir === 'function') {
    try {
      // Node resolves symlinks when computing this module's path, so realpath
      // both sides before comparing (e.g. macOS /var → /private/var, or a
      // C8CTL_DATA_DIR that isn't canonicalized) to avoid a false 'local'.
      const real = (p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const pluginsDir = join(rt.getUserDataDir(), 'plugins');
      const nm = real(join(pluginsDir, 'node_modules'));
      const self = real(pluginDir);
      if (self === nm || self.startsWith(nm + sep)) {
        return { mode: 'managed', prefix: real(pluginsDir) };
      }
    } catch {
      /* fall through to the global/local probes */
    }
  }
  if (isGlobalInstall()) return { mode: 'global' };
  return { mode: 'local' };
}

/** The copy-pasteable command that matches how this plugin is installed. */
function manualUpdateCommand(name, info) {
  if (info.mode === 'managed') return `  c8ctl load plugin ${name}@latest`;
  if (info.mode === 'local') return '  git pull   # in your checkout, then reload the plugin';
  return `  npm install -g ${name}@latest`;
}

function updatePlugin(req) {
  const { name, version: current } = pluginPackage();

  // The nano server binary ships with the plugin as its platform package
  // (an optionalDependency pinned to the plugin version), so a plugin update is
  // what delivers a new server. Surface the resolved binary's version, and flag
  // it when the platform package isn't installed for this host.
  let nanoBin = null;
  try {
    nanoBin = findBinary({});
  } catch {
    nanoBin = null;
  }
  const bundled = readBundledBinaryInfo();
  const nanoVer = nanoBin ? binaryVersion(nanoBin) : null;
  const nanoNote = nanoBin
    ? `  (nano server ${nanoVer ?? bundled?.version ?? 'present'})`
    : '  (nano server: not installed for this platform)';
  const info = pluginInstallInfo();
  const manual = manualUpdateCommand(name, info);

  console.log(`Installed: ${name} v${current ?? '?'}${nanoNote}`);

  let latest;
  try {
    latest = npmLatestVersion(name);
  } catch (err) {
    console.log(`Could not check npm for updates: ${err.message}`);
    console.log('Pull the latest release manually with:');
    console.log(manual);
    return;
  }
  console.log(`Latest:    ${name} v${latest}  (npm)`);
  console.log('');

  if (current && compareSemver(current, latest) >= 0) {
    if (!nanoBin) {
      // Plugin is current but npm never fetched the matching server binary.
      console.log('Plugin is current, but the nano server binary is not installed for this platform.');
      console.log('Provision it by reinstalling the plugin so npm fetches the platform package:');
      console.log('  c8ctl sync plugin');
      return;
    }
    console.log('Already on the latest release — nothing to do.');
    return;
  }

  console.log(`Update available: v${current ?? '?'} -> v${latest}`);

  if (req.check) {
    console.log('Run `c8ctl nano update` to pull it (or manually):');
    console.log(manual);
    return;
  }

  if (info.mode === 'local') {
    console.log('This plugin runs from a local checkout, so it cannot self-update in place.');
    console.log('Update it with:');
    console.log(manual);
    return;
  }

  const installArgs =
    info.mode === 'managed'
      ? ['install', `${name}@${latest}`, '--prefix', info.prefix]
      : ['install', '-g', `${name}@${latest}`];
  const where = info.mode === 'managed' ? 'the c8ctl plugin store' : "npm's global prefix";
  console.log(`Pulling ${name}@${latest} into ${where}...`);
  console.log('');
  const res = spawnSync('npm', installArgs, { stdio: 'inherit' });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) {
    let hint;
    if (info.mode === 'managed') {
      hint = `You can also run:\n${manual}`;
    } else if (osPlatform() === 'win32') {
      hint = `You may need to run this command in an elevated terminal (Administrator): ${manual.trim()}`;
    } else {
      hint = `You may need elevated permissions: sudo ${manual.trim()}`;
    }
    throw new Error(
      `npm ${installArgs.join(' ')} failed (exit ${res.status}). ${hint}`,
    );
  }
  console.log('');
  if (info.mode === 'managed') {
    console.log(`Updated to v${latest}. The new plugin and bundled nano server load on your next c8ctl command.`);
  } else {
    console.log(`Updated to v${latest}.`);
  }
  console.log('Restart any running cluster to use the new server binary:');
  console.log('  c8ctl nano restart');
}

// ---------------------------------------------------------------------------
// Passive "update available" notice. Modelled on npm's update-notifier: the
// actual registry lookup runs in a detached background process (so a command is
// never slowed), and we only print a notice — at most once per day — from a
// cached result. The explicit `c8ctl nano update[ --check]` path is unchanged.
// ---------------------------------------------------------------------------

function getUpdateCacheFile() {
  return join(getStateHome(), UPDATE_CACHE_FILE);
}

function readUpdateCache() {
  try {
    return JSON.parse(readFileSync(getUpdateCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeUpdateCache(obj) {
  try {
    mkdirSync(getStateHome(), { recursive: true });
    writeFileSync(getUpdateCacheFile(), JSON.stringify(obj));
  } catch {
    /* a best-effort cache; ignore write failures */
  }
}

/**
 * True when the notifier should stay silent: an explicit opt-out, CI, or a
 * non-interactive stdout (piped/scripted), so we never pollute machine-read
 * output or nag in automation.
 */
function updateNotifierDisabled() {
  if (process.env.NANO_NO_UPDATE_NOTIFIER || process.env.NO_UPDATE_NOTIFIER) return true;
  if (process.env.CI) return true;
  if (!process.stdout.isTTY) return true;
  return false;
}

/**
 * Refresh the cached latest version in the background. Spawns a detached Node
 * process that runs `npm view <name> version` and writes the result to the
 * cache file, then exits — the current command does not wait on it, so the
 * fresh result is used on the *next* invocation.
 */
function spawnUpdateRefresh(name, cacheFile) {
  const script =
    'const{spawnSync}=require("child_process");' +
    'const{readFileSync,writeFileSync}=require("fs");' +
    `let prev={};try{prev=JSON.parse(readFileSync(${JSON.stringify(cacheFile)},"utf8"))}catch{}` +
    'const out=Object.assign({},prev,{lastCheck:Date.now()});' +
    `const r=spawnSync("npm",["view",${JSON.stringify(name)},"version"],{encoding:"utf8"});` +
    'if(r.status===0){out.latest=String(r.stdout||"").trim()}' +
    `try{writeFileSync(${JSON.stringify(cacheFile)},JSON.stringify(out))}catch{}`;
  try {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* if we can't spawn, just skip this cycle */
  }
}

function printUpdateNotice(name, current, latest) {
  const manual = manualUpdateCommand(name, pluginInstallInfo()).trim();
  const lines = [
    '',
    `╭─ Update available: ${name} v${current} → v${latest}`,
    '│  A newer nano release (plugin + bundled server) is published on npm.',
    '│  Install it:  c8ctl nano update',
    `│  Or manually: ${manual}`,
    '╰─ Then restart any running cluster: c8ctl nano restart',
    '',
  ];
  // stderr so it never corrupts parseable stdout.
  for (const l of lines) console.error(l);
}

/**
 * Best-effort, non-blocking update check run at the end of a command. Triggers
 * a background registry refresh when the cache is stale, and prints a notice
 * (at most once per day) when the cached latest version is newer than installed.
 */
function maybeNotifyUpdate(subcommand) {
  try {
    if (updateNotifierDisabled()) return;
    if (subcommand === 'update') return; // the explicit command reports its own state
    const { name, version: current } = pluginPackage();
    if (!current || current === '0.0.0-dev') return;

    const cacheFile = getUpdateCacheFile();
    const cache = readUpdateCache();
    const now = Date.now();

    if (!cache.lastCheck || now - cache.lastCheck > UPDATE_CHECK_TTL_MS) {
      try {
        mkdirSync(getStateHome(), { recursive: true });
      } catch {
        /* ignore */
      }
      spawnUpdateRefresh(name, cacheFile);
    }

    const latest = cache.latest;
    if (!latest || compareSemver(current, latest) >= 0) return;
    if (cache.lastNotified && now - cache.lastNotified <= UPDATE_NOTIFY_TTL_MS) return;

    printUpdateNotice(name, current, latest);
    writeUpdateCache({ ...cache, lastNotified: now });
  } catch {
    /* the notifier must never break a command */
  }
}

// ---------------------------------------------------------------------------
// processos — manage a single local ProcessOS instance (the optimization-plane
// server that analyses a running Nano BPM engine). Unlike nano, the ProcessOS
// binary is not distributed via npm: the user downloads it and points the
// plugin at it with "c8ctl processos set bin <path>".
// ---------------------------------------------------------------------------

const PROCESSOS_VALID_SUBCOMMANDS = ['start', 'stop', 'status', 'logs', 'log', 'restart', 'set', 'config'];

function getProcessosStateFile() {
  return join(getStateHome(), PROCESSOS_STATE_FILE);
}

function getProcessosLogFile() {
  return join(getLogDir(), 'processos.log');
}

function readProcessosConfig() {
  const cfg = readConfig();
  return cfg.processos && typeof cfg.processos === 'object' ? cfg.processos : {};
}

function writeProcessosConfig(pcfg) {
  const cfg = readConfig();
  cfg.processos = pcfg;
  writeConfig(cfg);
}

/** Resolve a user-supplied path to an absolute path, expanding a leading `~`. */
function toAbsPath(p) {
  const expanded = expandHome(String(p));
  return isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);
}

/** Engine data dir for ProcessOS (PROCESSOS_DATA_DIR). */
function getProcessosDataDir() {
  const cfg = readProcessosConfig();
  if (cfg.dataDir) return toAbsPath(cfg.dataDir);
  return join(getStateHome(), 'processos-data');
}

/** The target Nano BPM URL ProcessOS analyses (NANO_BASE_URL). */
function getProcessosNanoUrl() {
  const cfg = readProcessosConfig();
  return cfg.nanoUrl || process.env.NANO_BASE_URL || DEFAULT_NANO_URL;
}

/**
 * The closed-beta download URL: env var (PROCESSOS_DOWNLOAD_URL) wins, then the
 * persisted `processos set download-url` config value. Null when neither is set.
 */
function getProcessosDownloadUrl() {
  const fromEnv = process.env.PROCESSOS_DOWNLOAD_URL;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const cfg = readProcessosConfig();
  if (cfg.downloadUrl && String(cfg.downloadUrl).trim()) return String(cfg.downloadUrl).trim();
  return null;
}

/** The listen port (flag overrides configured value, which overrides default). */
function getProcessosPort(req) {
  const cfg = readProcessosConfig();
  if (Number.isFinite(req?.port)) return req.port;
  if (Number.isFinite(cfg.port)) return cfg.port;
  return PROCESSOS_DEFAULT_PORT;
}

function readProcessosState() {
  const file = getProcessosStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeProcessosState(state) {
  mkdirSync(getStateHome(), { recursive: true });
  writeFileSync(getProcessosStateFile(), JSON.stringify(state, null, 2));
}

function clearProcessosState() {
  const file = getProcessosStateFile();
  if (existsSync(file)) rmSync(file);
}

/**
 * Locate a ProcessOS binary the user already has, WITHOUT downloading. Order:
 *   1. --binary flag
 *   2. configured path ("processos set bin <path>")
 *   3. PROCESSOS_BINARY env var
 *   4. a previously auto-downloaded binary cached under the state home
 *   5. release / debug build under the nanobpmn repo (local dev)
 * Returns an absolute path, or null when nothing is configured/present. Throws
 * only when an *explicitly* configured source points at a missing file (so the
 * user gets an actionable error rather than a silent fallthrough).
 */
function findConfiguredProcessosBinary(req, { includeCached = true } = {}) {
  const cfg = readProcessosConfig();
  const sources = [
    { val: req?.binary && String(req.binary), from: '--binary' },
    { val: cfg.binary && String(cfg.binary), from: 'configured bin ("processos set bin")' },
    { val: process.env.PROCESSOS_BINARY, from: 'PROCESSOS_BINARY' },
  ];
  for (const { val, from } of sources) {
    if (!val) continue;
    const abs = toAbsPath(val);
    if (!existsSync(abs)) {
      throw new Error(`ProcessOS binary not found at ${abs} (from ${from})`);
    }
    return abs;
  }

  // A local source build wins over a downloaded copy for developers in the repo.
  let repo = null;
  try {
    repo = getRepoRoot();
  } catch {
    repo = null;
  }
  if (repo) {
    const candidates = [
      join(repo, 'processos', 'target', 'release', 'processos'),
      join(repo, 'processos', 'target', 'debug', 'processos'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  // The auto-downloaded copy. The resolver skips it (includeCached:false) so it
  // can manage that copy with a version check and re-fetch newer published
  // builds; all other callers still see it as the installed binary.
  if (includeCached) {
    const cached = getProcessosCachedBinaryPath();
    if (existsSync(cached)) return cached;
  }
  return null;
}

/** The state-home directory that holds an auto-downloaded ProcessOS binary. */
function getProcessosBinDir() {
  return join(getStateHome(), 'bin');
}

function getProcessosCachedBinaryPath() {
  const name = process.platform === 'win32' ? 'processos.exe' : 'processos';
  return join(getProcessosBinDir(), name);
}

/** Sidecar recording the version of the auto-downloaded binary (for update checks). */
function getProcessosBinaryMetaPath() {
  return join(getProcessosBinDir(), PROCESSOS_BINARY_META_FILE);
}

function readProcessosBinaryMeta() {
  try {
    return JSON.parse(readFileSync(getProcessosBinaryMetaPath(), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The S3 asset name for the host platform, matching the names the nanobpmn CI
 * uploads (`processos-<os>-<arch>`, `.exe` on Windows). Null on an unsupported
 * platform.
 */
function processosAssetName(platform = process.platform, arch = process.arch) {
  const map = {
    'darwin:arm64': 'processos-darwin-arm64',
    'darwin:x64': 'processos-darwin-x64',
    'linux:x64': 'processos-linux-x64',
    'linux:arm64': 'processos-linux-arm64',
    'win32:x64': 'processos-win32-x64.exe',
  };
  return map[`${platform}:${arch}`] || null;
}

/**
 * Join a PROCESSOS_DOWNLOAD_URL base with a leaf (`processos-<arch>` or
 * `version.json`). The base is normally a directory/prefix (e.g. the S3
 * `.../processos/latest/` URL); if it already points straight at a binary
 * asset, we treat its parent directory as the base so siblings resolve too.
 */
function processosDownloadBase(rawUrl) {
  const t = String(rawUrl || '').trim();
  if (!t) return '';
  if (t.endsWith('/')) return t.slice(0, -1);
  const lastSeg = t.split('/').pop();
  // A direct link to a binary asset -> use its parent as the base.
  if (lastSeg.startsWith('processos-') || lastSeg === 'processos' || lastSeg.endsWith('.exe')) {
    return t.slice(0, t.length - lastSeg.length - 1);
  }
  return t;
}

function processosBinaryUrl(rawUrl) {
  const asset = processosAssetName();
  if (!asset) {
    throw new Error(
      `No prebuilt ProcessOS binary is published for this platform (${process.platform}/${process.arch}).`,
    );
  }
  return `${processosDownloadBase(rawUrl)}/${asset}`;
}

function processosVersionMetaUrl(rawUrl) {
  return `${processosDownloadBase(rawUrl)}/${PROCESSOS_VERSION_META}`;
}

/** Fetch and parse the remote version.json (best-effort; null on any failure). */
async function fetchProcessosVersionMeta(rawUrl, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(processosVersionMetaUrl(rawUrl), { redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** Download a binary to `dest` (atomic via temp + rename; +x on unix). */
async function downloadProcessosBinary(url, dest) {
  const logger = getLogger();
  logger.info(`Downloading ProcessOS for ${process.platform}/${process.arch} from ${url} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`ProcessOS download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(getProcessosBinDir(), { recursive: true });
  const tmp = `${dest}.download`;
  writeFileSync(tmp, buf);
  if (process.platform !== 'win32') chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  logger.info(`Saved ProcessOS to ${dest} (${(buf.length / 1_000_000).toFixed(1)} MB).`);
  return dest;
}

/**
 * Resolve the ProcessOS binary to run, downloading it on demand when the user
 * has a PROCESSOS_DOWNLOAD_URL but no local copy yet. Resolution:
 *   configured/local binary -> cached download -> fresh download -> error.
 */
async function resolveProcessosBinary(req) {
  // An explicitly configured or local source build wins and is used as-is (no
  // auto-update). The auto-downloaded copy is handled below with a version
  // check so `start` can pull a newer published build.
  const configured = findConfiguredProcessosBinary(req, { includeCached: false });
  if (configured) return configured;

  const dlUrl = getProcessosDownloadUrl();
  const cached = getProcessosCachedBinaryPath();

  if (dlUrl) {
    const meta = await fetchProcessosVersionMeta(dlUrl);
    const have = readProcessosBinaryMeta();
    const remoteVer = meta?.version ?? null;
    const haveVer = have?.version ?? null;
    const haveCached = existsSync(cached);

    // Download when there is no cached copy, or when the published version.json
    // reports a version different from the one recorded for the cached copy.
    // This also covers binaries cached before version tracking (no haveVer).
    const needDownload = !haveCached || (remoteVer && remoteVer !== haveVer);
    if (needDownload) {
      const logger = getLogger();
      if (haveCached && remoteVer) {
        logger.info(`Updating ProcessOS ${haveVer ?? '?'} -> ${remoteVer} ...`);
      }
      await downloadProcessosBinary(processosBinaryUrl(dlUrl), cached);
      // Record what we fetched so the update notifier/status can compare later.
      try {
        mkdirSync(getProcessosBinDir(), { recursive: true });
        writeFileSync(
          getProcessosBinaryMetaPath(),
          JSON.stringify({
            version: meta?.version ?? null,
            commit: meta?.commit ?? null,
            updated: meta?.updated ?? null,
            source: processosDownloadBase(dlUrl),
            downloaded: new Date().toISOString(),
          }),
        );
      } catch {
        /* sidecar is best-effort */
      }
    }
    if (existsSync(cached)) return cached;
  }

  // A previously downloaded copy still runs even if the URL is now unset.
  if (existsSync(cached)) return cached;

  throw new Error(
    `Could not find or download the ProcessOS binary.\n` +
      `Set the download URL you were given (PROCESSOS_DOWNLOAD_URL), point the plugin at a\n` +
      `local binary ("c8ctl processos set bin <path>" / --binary / PROCESSOS_BINARY), or build\n` +
      `from source under the nanobpmn repo.`,
  );
}

/**
 * Whether ProcessOS is enabled for this user. It is a closed beta, so the
 * operational commands stay locked until the user either has the binary on
 * their system (configured path / cached download / local build) or has been
 * given a PROCESSOS_DOWNLOAD_URL to fetch it from.
 */
function processosEnabled(req) {
  if (getProcessosDownloadUrl()) return true;
  try {
    if (findConfiguredProcessosBinary(req)) return true;
  } catch {
    // A configured-but-missing path still means the user opted in; let the real
    // not-found error surface from the command rather than the closed-beta gate.
    return true;
  }
  return false;
}

function printProcessosClosedBeta() {
  const logger = getLogger();
  logger.error(
    'ProcessOS is in closed beta and is not available yet.\n' +
      '\n' +
      'To enable it, set the download URL you were given by the Nano BPM team:\n' +
      '  c8ctl processos set download-url <url>   # persists it for this machine\n' +
      '  c8ctl processos start                    # downloads + runs the matching binary\n' +
      '\n' +
      '(or set PROCESSOS_DOWNLOAD_URL in your environment for the same effect)\n' +
      '\n' +
      'or, if you already have the binary, point the plugin at it:\n' +
      '  c8ctl processos set bin <path>',
  );
}

// --- ProcessOS update notifier ---------------------------------------------
// Mirrors the nano plugin notifier, but the "latest version" comes from the
// version.json the nanobpmn CI publishes next to the S3 binaries rather than
// from npm. Throttled to one background fetch + one notice per day.

function getProcessosUpdateCacheFile() {
  return join(getStateHome(), PROCESSOS_UPDATE_CACHE_FILE);
}

function readProcessosUpdateCache() {
  try {
    return JSON.parse(readFileSync(getProcessosUpdateCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeProcessosUpdateCache(obj) {
  try {
    mkdirSync(getStateHome(), { recursive: true });
    writeFileSync(getProcessosUpdateCacheFile(), JSON.stringify(obj));
  } catch {
    /* best-effort */
  }
}

/**
 * The installed ProcessOS version: the recorded version of an auto-downloaded
 * binary, else `processos --version` against the resolved binary. Null when no
 * binary is present or it can't report a version.
 */
function getInstalledProcessosVersion(req) {
  const meta = readProcessosBinaryMeta();
  if (meta.version) return String(meta.version);
  let binary = null;
  try {
    binary = findConfiguredProcessosBinary(req);
  } catch {
    binary = null;
  }
  return binaryVersion(binary);
}

/**
 * Refresh the cached latest ProcessOS version in a detached background process
 * (fetches version.json), so the current command never waits on the network.
 */
function spawnProcessosVersionRefresh(metaUrl, cacheFile) {
  const script =
    'const{readFileSync,writeFileSync}=require("fs");' +
    `let prev={};try{prev=JSON.parse(readFileSync(${JSON.stringify(cacheFile)},"utf8"))}catch{}` +
    'const out=Object.assign({},prev,{lastCheck:Date.now()});' +
    'const ac=new AbortController();const t=setTimeout(()=>ac.abort(),5000);' +
    `fetch(${JSON.stringify(metaUrl)},{redirect:"follow",signal:ac.signal})` +
    '.then(r=>r.ok?r.json():null).then(j=>{clearTimeout(t);' +
    'if(j&&j.version){out.latest=String(j.version);out.commit=j.commit||null}' +
    `try{writeFileSync(${JSON.stringify(cacheFile)},JSON.stringify(out))}catch{}})` +
    `.catch(()=>{try{writeFileSync(${JSON.stringify(cacheFile)},JSON.stringify(out))}catch{}});`;
  try {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* skip this cycle */
  }
}

function printProcessosUpdateNotice(current, latest) {
  const lines = [
    '',
    `╭─ ProcessOS update available: v${current ?? '?'} → v${latest}`,
    '│  A newer ProcessOS build is published.',
    '│  Get it:  c8ctl processos stop && c8ctl processos start',
    '│           (a configured binary updates itself; a downloaded one re-fetches)',
    '╰─ Pin a specific build instead with: c8ctl processos set bin <path>',
    '',
  ];
  for (const l of lines) console.error(l);
}

/**
 * Best-effort, non-blocking ProcessOS update check. Triggers a background
 * version.json fetch when the cache is stale and prints a notice (at most once
 * per day) when the published version is newer than the installed one. Only
 * meaningful when a download URL is configured (the closed-beta channel).
 */
function maybeNotifyProcessosUpdate(req) {
  try {
    if (updateNotifierDisabled()) return;
    const dlUrl = getProcessosDownloadUrl();
    if (!dlUrl) return; // no published channel to compare against
    const current = getInstalledProcessosVersion(req);
    if (!current) return;

    const cacheFile = getProcessosUpdateCacheFile();
    const cache = readProcessosUpdateCache();
    const now = Date.now();

    if (!cache.lastCheck || now - cache.lastCheck > UPDATE_CHECK_TTL_MS) {
      try {
        mkdirSync(getStateHome(), { recursive: true });
      } catch {
        /* ignore */
      }
      spawnProcessosVersionRefresh(processosVersionMetaUrl(dlUrl), cacheFile);
    }

    const latest = cache.latest;
    if (!latest || compareSemver(current, latest) >= 0) return;
    if (cache.lastNotified && now - cache.lastNotified <= UPDATE_NOTIFY_TTL_MS) return;

    printProcessosUpdateNotice(current, latest);
    writeProcessosUpdateCache({ ...cache, lastNotified: now });
  } catch {
    /* never break a command over the notifier */
  }
}

/** Probe ProcessOS's GET /health endpoint for reachability. */
async function probeProcessosHealthy(url) {
  return probePath(url, '/health');
}

async function waitForProcessosHealthy(url, timeoutMs = READINESS_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeProcessosHealthy(url)) return true;
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
  return false;
}

async function startProcessos(req) {
  const logger = getLogger();

  const existing = readProcessosState();
  if (existing && isPidAlive(existing.pid)) {
    if (!req.force) {
      logger.error(
        `ProcessOS is already running (pid ${existing.pid}) at ${existing.url}. ` +
          `Use --force to restart, or "c8ctl processos stop".`,
      );
      process.exit(1);
    }
    await stopProcessos({});
  }

  const binary = await resolveProcessosBinary(req);
  const port = getProcessosPort(req);
  const url = `http://127.0.0.1:${port}`;
  const nanoUrl = req.nanoUrl || getProcessosNanoUrl();
  const dataDir = getProcessosDataDir();

  // Pre-flight: refuse if something is already serving this port.
  if (await probeProcessosHealthy(url)) {
    logger.error(`Port ${port} is already serving a ProcessOS health endpoint. Choose another --port.`);
    process.exit(1);
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });

  if (!(await probeHealthy(nanoUrl))) {
    logger.warn(
      `Target Nano BPM at ${nanoUrl} is not reachable — ProcessOS will start but cannot analyse ` +
        `an engine until one is up (set with "c8ctl processos set nano-url <url>").`,
    );
  }

  const cfg = readProcessosConfig();
  const env = {
    ...process.env,
    // Generic passthrough first so typed settings below always win.
    ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}),
    PROCESSOS_PORT: String(port),
    NANO_BASE_URL: nanoUrl,
    PROCESSOS_DATA_DIR: dataDir,
  };

  // ProcessOS runs its own internal "pilot" Nano engine, which it spawns as a
  // child process from a console-enabled gateway binary in PROCESSOS_NANO_BIN.
  // The plugin already knows where the nano binary lives, so auto-wire it.
  // Spawning the pilot engine is the DEFAULT; resolve the binary best-effort.
  let nanoBin;
  let resolvedPilot;
  try {
    resolvedPilot = resolveBinary({});
    nanoBin = resolvedPilot.path;
  } catch {
    nanoBin = undefined;
  }
  if (nanoBin && !env.PROCESSOS_NANO_BIN) {
    env.PROCESSOS_NANO_BIN = nanoBin;
  }
  // Stamp launcher-identity + provenance markers so the pilot nano gateway
  // (spawned by ProcessOS from this env) can offer/suppress console self-update
  // the same way a directly-launched `nano start` node does.
  Object.assign(env, launcherEnvMarkers(resolvedPilot));

  // Decide whether to spawn the pilot engine. Precedence:
  //   --no-spawn-nano flag            -> off (explicit)
  //   --spawn-nano flag               -> on  (explicit; hard-fail if no binary)
  //   PROCESSOS_SPAWN_NANO env/config -> honor it (explicit)
  //   otherwise                       -> on by default (soft; fall back to URL
  //                                      mode with a warning if no binary)
  let spawnNano;
  if (req.noSpawnNano) {
    spawnNano = false;
  } else if (req.spawnNano) {
    if (!env.PROCESSOS_NANO_BIN) findBinary({}); // surface the resolver's guidance
    spawnNano = true;
  } else if (env.PROCESSOS_SPAWN_NANO !== undefined && env.PROCESSOS_SPAWN_NANO !== '') {
    spawnNano = ['1', 'true', 'yes', 'on'].includes(String(env.PROCESSOS_SPAWN_NANO).toLowerCase());
    if (spawnNano && !env.PROCESSOS_NANO_BIN) findBinary({});
  } else if (env.PROCESSOS_NANO_BIN) {
    spawnNano = true; // default
  } else {
    spawnNano = false; // default intent, but no nano binary available
    logger.warn(
      'No nano binary found, so ProcessOS will not spawn its own pilot engine; it will use the ' +
        `target engine (${nanoUrl}) for its pilot instead. Point the plugin at a nano binary ` +
        '("c8ctl nano set bin <path>") to enable a dedicated pilot engine.',
    );
  }
  env.PROCESSOS_SPAWN_NANO = spawnNano ? 'true' : 'false';

  logger.info('Starting ProcessOS...');
  logger.info(`Binary:   ${binary}`);
  logger.info(`Target:   ${nanoUrl}`);
  if (spawnNano) {
    logger.info(`Own Nano: spawning pilot engine from ${env.PROCESSOS_NANO_BIN}`);
  }

  const logFile = getProcessosLogFile();
  const out = openSync(logFile, 'a');
  const child = spawn(binary, [], { env, stdio: ['ignore', out, out], detached: true });
  child.unref();

  if (typeof child.pid !== 'number') {
    logger.error('Failed to spawn ProcessOS.');
    process.exit(1);
  }

  const state = {
    pid: child.pid,
    port,
    url,
    binary,
    dataDir,
    logFile,
    nanoUrl,
    spawnNano,
    nanoBin: spawnNano ? env.PROCESSOS_NANO_BIN : undefined,
    startedAt: new Date().toISOString(),
  };
  writeProcessosState(state);

  logger.info(`  pid ${child.pid} — waiting for ${url}/health ...`);
  const ok = await waitForProcessosHealthy(url);
  if (!ok) {
    logger.error(
      `ProcessOS did not become healthy at ${url}/health. Inspect logs with "c8ctl processos logs", ` +
        `then "c8ctl processos stop".`,
    );
    process.exit(1);
  }

  printProcessosSummary(state);
}

async function stopProcessos(req) {
  const logger = getLogger();
  const state = readProcessosState();

  if (!state) {
    logger.warn('No ProcessOS instance state found — nothing to stop.');
    return;
  }
  if (!isPidAlive(state.pid)) {
    logger.warn('ProcessOS is not running (stale state). Cleaning up.');
    clearProcessosState();
    return;
  }

  logger.info(`Stopping ProcessOS (pid ${state.pid})...`);
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }

  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(state.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (isPidAlive(state.pid)) {
    logger.warn(`  ProcessOS (pid ${state.pid}) did not exit gracefully — sending SIGKILL.`);
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }

  clearProcessosState();
  logger.info('ProcessOS stopped.');
}

async function statusProcessos() {
  const state = readProcessosState();
  if (!state) {
    console.log('ProcessOS: not running (no managed instance).');
    console.log('  Start one with: c8ctl processos start');
    return;
  }

  const alive = isPidAlive(state.pid);
  const healthy = alive ? await probeProcessosHealthy(state.url) : false;
  // Prefer the actual running binary's reported version; fall back to the
  // recorded download metadata if the binary can't be probed.
  const version = binaryVersion(state.binary) ?? getInstalledProcessosVersion() ?? 'unknown';

  console.log('ProcessOS status:');
  console.log('');
  console.log(`  pid:       ${state.pid} ${alive ? '(alive)' : '(dead — stale state)'}`);
  console.log(`  version:   ${version}`);
  console.log(`  url:       ${state.url}`);
  console.log(`  health:    ${healthy ? 'ok' : 'unreachable'}  (${state.url}/health)`);
  console.log(`  target:    ${state.nanoUrl}`);
  console.log(`  data dir:  ${state.dataDir}`);
  console.log(`  binary:    ${state.binary}`);
  if (state.spawnNano) {
    console.log(`  own nano:  spawned from ${state.nanoBin}`);
  }
  console.log(`  started:   ${state.startedAt}`);
  if (!alive) {
    console.log('');
    console.log('  The recorded process is gone. Run "c8ctl processos start" to start a fresh instance.');
  }
}

function logsProcessos(req) {
  const logger = getLogger();
  const file = getProcessosLogFile();
  if (!existsSync(file)) {
    logger.warn(`No ProcessOS log file found at ${file}`);
    return;
  }
  const tailArgs = req.follow ? ['-n', '+1', '-F', file] : ['-n', '200', file];
  const proc = spawn('tail', tailArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', (err) => {
    logger.error(`Failed to read logs: ${err.message}`);
    logger.info(`Log file: ${file}`);
  });
}

function printProcessosSummary(state) {
  console.log('');
  console.log(`ProcessOS is up (pid ${state.pid}).`);
  console.log('');
  console.log(`  Start here   ${state.url}/          (landing)`);
  console.log(`  Cockpit      ${state.url}/cockpit`);
  console.log(`  Health       ${state.url}/health`);
  console.log(`  Target Nano  ${state.nanoUrl}`);
  console.log('');
  console.log('  Inspect with: c8ctl processos status');
  console.log('  Stop with:    c8ctl processos stop');
  console.log('');
}

const PROCESSOS_SET_FIELDS = {
  bin: 'binary',
  binary: 'binary',
  port: 'port',
  'nano-url': 'nanoUrl',
  nanourl: 'nanoUrl',
  'download-url': 'downloadUrl',
  downloadurl: 'downloadUrl',
  'data-dir': 'dataDir',
  datadir: 'dataDir',
  env: 'env',
};

function printProcessosSetUsage() {
  const logger = getLogger();
  logger.info('Usage: c8ctl processos set <field> <value>');
  logger.info('  bin <path>          Path to the downloaded ProcessOS binary');
  logger.info('  download-url <url>  Closed-beta binary download URL (enables ProcessOS)');
  logger.info('  port <n>            Listen port (default 8090)');
  logger.info('  nano-url <url>      Target Nano BPM engine URL (default http://localhost:8080)');
  logger.info('  data-dir <path>     ProcessOS data directory');
  logger.info('  env KEY=VALUE       Set a passthrough env var (e.g. PROCESSOS_LLM_MODEL); KEY= unsets it');
}

function setProcessosConfig(req) {
  const logger = getLogger();
  const rawField = req.positional[0];
  if (!rawField) {
    printProcessosSetUsage();
    process.exit(1);
  }
  const field = PROCESSOS_SET_FIELDS[String(rawField).toLowerCase()];
  if (!field) {
    logger.error(`Unknown ProcessOS setting "${rawField}".`);
    printProcessosSetUsage();
    process.exit(1);
  }

  const cfg = readProcessosConfig();

  if (field === 'env') {
    const arg = req.positional[1];
    if (!arg || !arg.includes('=')) {
      logger.error('Usage: c8ctl processos set env KEY=VALUE  (use "KEY=" to unset)');
      process.exit(1);
    }
    const idx = arg.indexOf('=');
    const key = arg.slice(0, idx);
    const val = arg.slice(idx + 1);
    if (!key) {
      logger.error('Missing env var name. Usage: c8ctl processos set env KEY=VALUE');
      process.exit(1);
    }
    cfg.env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
    if (val === '') {
      delete cfg.env[key];
      logger.info(`Unset env ${key}`);
    } else {
      cfg.env[key] = val;
      logger.info(`Set env ${key}=${val}`);
    }
  } else if (field === 'binary') {
    const val = req.positional[1];
    if (!val) {
      logger.error('Usage: c8ctl processos set bin <path>');
      process.exit(1);
    }
    const abs = toAbsPath(val);
    if (!existsSync(abs)) {
      logger.error(`Binary not found at ${abs}`);
      process.exit(1);
    }
    cfg.binary = abs;
    logger.info(`Set binary = ${abs}`);
  } else if (field === 'port') {
    const n = Number.parseInt(String(req.positional[1]), 10);
    if (!Number.isFinite(n) || n <= 0) {
      logger.error('Usage: c8ctl processos set port <n>');
      process.exit(1);
    }
    cfg.port = n;
    logger.info(`Set port = ${n}`);
  } else if (field === 'nanoUrl') {
    const val = req.positional[1];
    if (!val) {
      logger.error('Usage: c8ctl processos set nano-url <url>');
      process.exit(1);
    }
    cfg.nanoUrl = val;
    logger.info(`Set nano-url = ${val}`);
  } else if (field === 'downloadUrl') {
    const val = req.positional[1];
    if (val === undefined || val === '') {
      // Allow clearing with an empty value: c8ctl processos set download-url ""
      delete cfg.downloadUrl;
      logger.info('Cleared download-url');
    } else {
      cfg.downloadUrl = String(val).trim();
      logger.info(`Set download-url = ${cfg.downloadUrl}`);
    }
  } else if (field === 'dataDir') {
    const val = req.positional[1];
    if (!val) {
      logger.error('Usage: c8ctl processos set data-dir <path>');
      process.exit(1);
    }
    cfg.dataDir = toAbsPath(val);
    logger.info(`Set data-dir = ${cfg.dataDir}`);
  }

  writeProcessosConfig(cfg);
}

function showProcessosConfig() {
  const cfg = readProcessosConfig();
  const nanoUrl = cfg.nanoUrl || process.env.NANO_BASE_URL || DEFAULT_NANO_URL;
  console.log('ProcessOS configuration:');
  console.log('');
  console.log(`  binary     ${cfg.binary || '(not set — "processos set bin <path>", $PROCESSOS_BINARY, or repo build)'}`);
  console.log(`  port       ${Number.isFinite(cfg.port) ? cfg.port : PROCESSOS_DEFAULT_PORT}${Number.isFinite(cfg.port) ? '' : '  (default)'}`);
  console.log(`  nano-url   ${nanoUrl}${cfg.nanoUrl ? '' : '  (default)'}`);
  console.log(`  data dir   ${getProcessosDataDir()}${cfg.dataDir ? '' : '  (default)'}`);
  const env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
  const keys = Object.keys(env);
  if (keys.length > 0) {
    console.log('');
    console.log('  env (passthrough):');
    for (const k of keys.sort()) {
      console.log(`    ${k}=${env[k]}`);
    }
  }
  console.log('');
  console.log('  closed-beta channel:');
  const dlUrl = getProcessosDownloadUrl();
  const dlSource = process.env.PROCESSOS_DOWNLOAD_URL && String(process.env.PROCESSOS_DOWNLOAD_URL).trim()
    ? '  (from $PROCESSOS_DOWNLOAD_URL)'
    : cfg.downloadUrl
      ? '  (from "processos set download-url")'
      : '';
  console.log(`    download url   ${dlUrl ? dlUrl + dlSource : '(not set — ProcessOS is a closed beta; "c8ctl processos set download-url <url>" to enable)'}`);
  const cached = getProcessosCachedBinaryPath();
  const meta = readProcessosBinaryMeta();
  console.log(`    cached binary  ${existsSync(cached) ? cached : '(none — downloaded on first "processos start")'}`);
  if (meta.version || meta.commit) {
    console.log(`    version        ${meta.version || '?'}${meta.commit ? ` (${String(meta.commit).slice(0, 8)})` : ''}${meta.downloaded ? `  downloaded ${meta.downloaded}` : ''}`);
  }
  console.log('');
  console.log(`  state file ${getProcessosStateFile()}`);
  console.log(`  log file   ${getProcessosLogFile()}`);
  console.log('');
  console.log('  Change with: c8ctl processos set bin <path> | set download-url <url> | set port <n> | set nano-url <url> | set data-dir <path> | set env KEY=VALUE');
}

function printProcessosUsage() {
  console.log('Manage a local ProcessOS instance (optimization-plane server for Nano BPM).');
  console.log('');
  console.log('Usage:');
  console.log('  c8ctl processos start [--port <n>] [--nano-url <url>] [--binary <path>] [--no-spawn-nano] [--force]');
  console.log('  c8ctl processos status');
  console.log('  c8ctl processos stop');
  console.log('  c8ctl processos restart [...]');
  console.log('  c8ctl processos logs [--follow]');
  console.log('  c8ctl processos set bin <path> | download-url <url> | port <n> | nano-url <url> | data-dir <path> | env KEY=VALUE');
  console.log('  c8ctl processos config');
  console.log('');
  console.log('ProcessOS is a closed beta. Enable it with the download URL you were given:');
  console.log('  c8ctl processos set download-url <url>   # plugin downloads + runs the matching binary');
  console.log('or point the plugin at a binary you already have: "c8ctl processos set bin <path>".');
  console.log('By default ProcessOS spawns its own internal pilot Nano engine (the plugin auto-wires the nano');
  console.log('binary into PROCESSOS_NANO_BIN). Use --no-spawn-nano to instead use the --nano-url engine for');
  console.log('the pilot too. If no nano binary is available, it falls back to --no-spawn-nano automatically.');
}

function parseProcessosRequest(args, flags) {
  const subcommand = args[0];
  const positional = args.slice(1).filter((a) => !String(a).startsWith('-'));
  const portRaw = flags?.port;
  const port =
    portRaw === undefined || portRaw === null || portRaw === ''
      ? undefined
      : Number.parseInt(String(portRaw), 10);
  return {
    subcommand,
    positional,
    port: Number.isFinite(port) ? port : undefined,
    nanoUrl: flags?.['nano-url'] || flags?.nanoUrl,
    binary: flags?.binary,
    spawnNano: Boolean(flags?.['spawn-nano'] || flags?.spawnNano),
    noSpawnNano: Boolean(flags?.['no-spawn-nano'] || flags?.noSpawnNano),
    follow: Boolean(flags?.follow),
    force: Boolean(flags?.force),
  };
}

// ---------------------------------------------------------------------------
// metadata + commands
// ---------------------------------------------------------------------------

// Internal helpers exported for tests/tooling only. c8ctl consumes just
// `metadata` and `commands`; these named exports are inert to it.
export { resolveBinary, findBinary, launcherEnvMarkers };

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
        { command: 'c8ctl nano start --in-memory --history-max 50000', description: 'Stress mode: no disk journal, cap retained instances in RAM' },
        { command: 'c8ctl nano status', description: 'Show cluster status and per-node health' },
        { command: 'c8ctl nano pause 1', description: 'Freeze node 1 (SIGSTOP) to simulate a node failure' },
        { command: 'c8ctl nano resume 1', description: 'Resume node 1 (SIGCONT) to bring it back online' },
        { command: 'c8ctl nano logs 1 --follow', description: "Stream node 1's log" },
        { command: 'c8ctl nano stop', description: 'Stop the running cluster (keep data)' },
        { command: 'c8ctl nano stop --purge', description: 'Stop the cluster and delete engine data' },
        { command: 'c8ctl nano restart', description: 'Stop and start the cluster (keep data)' },
        { command: 'c8ctl nano restart --purge', description: 'Restart the cluster from a clean slate (delete engine data)' },
        { command: 'c8ctl nano clean', description: 'Wipe journal/data + logs on disk (keeps models/workers)' },
        { command: 'c8ctl nano set bin <path>', description: 'Set the nanobpmn server binary path' },
        { command: 'c8ctl nano set model-dir <path>', description: 'Set the workspace dir (models + workers)' },
        { command: 'c8ctl nano config', description: 'Show current plugin configuration and paths' },
        { command: 'c8ctl nano update', description: 'Pull the latest published nano release (re-installs via npm)' },
        { command: 'c8ctl nano update --check', description: 'Check whether a newer nano release is available' },
      ],
    },
    processos: {
      description: 'Manage a local ProcessOS instance — start, status, stop, logs, config',
      examples: [
        { command: 'c8ctl processos set download-url <url>', description: 'Enable the closed beta + auto-download the matching binary' },
        { command: 'c8ctl processos set bin <path>', description: 'Point the plugin at a ProcessOS binary you already have' },
        { command: 'c8ctl processos start', description: 'Start ProcessOS against the local Nano BPM engine' },
        { command: 'c8ctl processos start --nano-url http://localhost:8080', description: 'Start against a specific engine' },
        { command: 'c8ctl processos status', description: 'Show ProcessOS status and health' },
        { command: 'c8ctl processos logs --follow', description: "Stream ProcessOS's log" },
        { command: 'c8ctl processos stop', description: 'Stop the running ProcessOS instance' },
        { command: 'c8ctl processos set port 8090', description: 'Set the listen port' },
        { command: 'c8ctl processos set nano-url <url>', description: 'Set the target Nano BPM engine URL' },
        { command: 'c8ctl processos set env PROCESSOS_LLM_MODEL=...', description: 'Set a passthrough env var' },
        { command: 'c8ctl processos config', description: 'Show current ProcessOS configuration and paths' },
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
      'in-memory': { type: 'boolean', description: 'start: run with NO on-disk journal/read-model (in-memory engine; state lost on restart). Alias: --no-journal' },
      'no-journal': { type: 'boolean', description: 'start: alias for --in-memory' },
      'history-max': { type: 'string', description: 'start: cap retained terminal instances in the read model (NANOBPMN_HISTORY_MAX_INSTANCES; 0/unset = unbounded)' },
      follow: { type: 'boolean', description: 'logs: stream output (tail -F)', short: 'f' },
      purge: { type: 'boolean', description: 'stop/restart: also delete per-node engine data' },
      force: { type: 'boolean', description: 'start: stop any existing cluster first' },
      workspace: { type: 'boolean', description: 'clean: also delete the workspace (models + workers)' },
      check: { type: 'boolean', description: 'update: only report whether a new release is available; do not install' },
      binary: { type: 'string', description: 'Path to the nanobpmn server binary' },
    },
    handler: async (args, flags) => {
      const logger = getLogger();
      const req = parseRequest(args, flags);

      if (!req.subcommand || !VALID_SUBCOMMANDS.includes(req.subcommand)) {
        printUsage();
        return;
      }

      let failed = false;
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
            await stopCluster({ purge: req.purge });
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
          case 'update':
            updatePlugin(req);
            break;
        }
      } catch (error) {
        logger.error(`nano ${req.subcommand} failed: ${error instanceof Error ? error.message : error}`);
        failed = true;
      }
      maybeNotifyUpdate(req.subcommand);
      if (failed) process.exit(1);
    },
  },
  processos: {
    flags: {
      port: { type: 'string', description: 'start: listen port (default 8090)' },
      'nano-url': { type: 'string', description: 'start: target Nano BPM engine URL (default http://localhost:8080)' },
      binary: { type: 'string', description: 'Path to the ProcessOS binary' },
      'spawn-nano': { type: 'boolean', description: 'start: force ProcessOS to spawn its own pilot Nano engine (default on when a nano binary is available)' },
      'no-spawn-nano': { type: 'boolean', description: 'start: do NOT spawn a pilot engine; use the --nano-url engine for the pilot too' },
      follow: { type: 'boolean', description: 'logs: stream output (tail -F)', short: 'f' },
      force: { type: 'boolean', description: 'start: stop any existing instance first' },
    },
    handler: async (args, flags) => {
      const logger = getLogger();
      const req = parseProcessosRequest(args, flags);

      if (!req.subcommand || !PROCESSOS_VALID_SUBCOMMANDS.includes(req.subcommand)) {
        printProcessosUsage();
        return;
      }

      // ProcessOS is a closed beta: gate the operational commands until the
      // user has opted in (download URL set or a binary on their system).
      // `set`/`config` stay open so users can configure/inspect at any time.
      const ungated = req.subcommand === 'set' || req.subcommand === 'config';
      if (!ungated && !processosEnabled(req)) {
        printProcessosClosedBeta();
        process.exit(1);
      }

      let failed = false;
      try {
        switch (req.subcommand) {
          case 'start':
            await startProcessos(req);
            break;
          case 'stop':
            await stopProcessos(req);
            break;
          case 'status':
            await statusProcessos();
            break;
          case 'log':
          case 'logs':
            logsProcessos(req);
            break;
          case 'restart':
            await stopProcessos({});
            await startProcessos({ ...req, force: true });
            break;
          case 'set':
            setProcessosConfig(req);
            break;
          case 'config':
            showProcessosConfig();
            break;
        }
      } catch (error) {
        logger.error(`processos ${req.subcommand} failed: ${error instanceof Error ? error.message : error}`);
        failed = true;
      }
      maybeNotifyUpdate(req.subcommand);
      maybeNotifyProcessosUpdate(req);
      if (failed) process.exit(1);
    },
  },
};

function printUsage() {
  console.log('Usage:');
  console.log('  c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>] [--raft] [--capture] [--in-memory] [--history-max <n>] [--binary <path>]');
  console.log('  c8ctl nano status [--port <port>]');
  console.log('  c8ctl nano stop [--purge]');
  console.log('  c8ctl nano logs [<nodeId>] [--follow]');
  console.log('  c8ctl nano pause <nodeId>');
  console.log('  c8ctl nano resume <nodeId>');
  console.log('  c8ctl nano restart [<nodes>] [--purge] ...');
  console.log('  c8ctl nano clean [--workspace]');
  console.log('  c8ctl nano set <bin|model-dir> <path>');
  console.log('  c8ctl nano config');
  console.log('  c8ctl nano update [--check]');
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
  console.log('  update   Pull the latest published nano release (--check to only report)');
  console.log('');
  console.log('Options:');
  console.log('  <nodes>              Number of nodes to start (default 1)');
  console.log('  --port <basePort>    start: base port (node i = basePort+i); status: port to probe (default 8080)');
  console.log('  --partitions <n>     Total partitions across the cluster (default = node count)');
  console.log('  --rf <n>             Replication factor; >1 enables Raft (default 1)');
  console.log('  --raft               Force Raft on (default: on iff rf>1)');
  console.log('  --capture            start: enable trace capture (recorded-input replay) on every node');
  console.log('  --in-memory          start: run with NO on-disk journal/read-model (alias --no-journal; state lost on restart)');
  console.log('  --history-max <n>    start: cap retained terminal instances in the read model (0/unset = unbounded)');
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
