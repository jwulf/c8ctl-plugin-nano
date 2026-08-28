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
 *   NANOBPMN_CONSOLE   runtime console profile (off | observe | studio)
 *   NANOBPMN_NODE_BIN  Node path for the server's worker fallback runtime
 *
 * This plugin spawns N detached node processes wired to talk to each other on
 * localhost, tracks them in a state file, and stops them on request.
 *
 * Usage:
 *   c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>]
 *                    [--in-memory] [--history-max <n>] [--console <profile>]
 *   c8ctl nano status
 *   c8ctl nano stop [--purge]
 *   c8ctl nano logs [<nodeId>] [--follow]
 *   c8ctl nano restart [<nodes>] [--purge] ...
 */

import { spawn, spawnSync, execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  copyFileSync,
  statSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  renameSync,
  realpathSync,
  statfsSync,
  lstatSync,
  mkdtempSync,
  closeSync,
  watchFile,
  unwatchFile,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { homedir, platform as osPlatform, devNull, tmpdir, hostname } from 'node:os';
import { join, isAbsolute, resolve as resolvePath, dirname, basename, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { createInterface as createReadline, cursorTo as rlCursorTo, moveCursor as rlMoveCursor, clearScreenDown as rlClearScreenDown } from 'node:readline';
import { platformForHost } from './platforms.mjs';
import { createWorkChannel, redactAgenticUrl, buildAgenticUrl } from './work-channel.mjs';
import { createRelaySession, roleTerminalMode } from './work-relay.mjs';
import { createBufferMonitor, resolveBufferCapacity } from './work-buffer.mjs';

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
// Upper bound on one `--auto` engine-read reconcile (enumerate deployed
// definitions + fetch each BPMN). A read that stalls past this is treated as a
// transient failure so the running poller set is KEPT and, crucially, shutdown
// — which awaits the in-flight reconcile — can never hang on a wedged engine.
const AUTO_ENGINE_READ_TIMEOUT_MS = 15_000;
const PROCESSOS_STATE_FILE = 'processos.json';
const SUPERVISOR_STATE_FILE = 'supervisor.json';
const PROCESSOS_DEFAULT_PORT = 8090;
const DEFAULT_NANO_URL = 'http://localhost:8080';

// The well-known identity token used for LOCAL agentic visibility (security opt-in). Nano is
// local-first: a `nano work` worker joins the visibility channel with zero configuration, so it
// presents this constant, well-known LOCAL token — NOT a secret. The worker does not enforce any
// loopback restriction itself (it presents this token to whatever NANO_AGENTIC_URL is configured);
// the hub honours this well-known token from any origin (matching the open trusted-LAN posture of
// the engine itself). Kept in lock-step with the hub constant in nanobpm/nano-workforce
// (`app/agentic/channel.ts` LOCAL_AGENTIC_TOKEN). In secure mode (a real NANO_AGENTIC_SECRET) this
// is never used.
const LOCAL_AGENTIC_TOKEN = 'nano-local';

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
    // Primary command output, written to stdout as-is (mirrors the c8ctl host
    // logger's `output()`). Used for preformatted, non-structured content such
    // as the supervisor status table, whose newlines must survive verbatim.
    // Uses `process.stdout.write` (not `console.log`) so the content is emitted
    // literally — `console.log` applies `util.format` (mangling stray `%`
    // sequences) and would append its own newline; here we add exactly one
    // trailing newline when the text lacks one.
    output: (msg) => {
      const s = typeof msg === 'string' ? msg : String(msg);
      process.stdout.write(s.endsWith('\n') ? s : s + '\n');
    },
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
// Worker supervisor paths (see the `supervisor` command). The supervisor is a
// detached daemon that manages a fleet of `nano work` child processes; it keeps
// its own state file, a control socket, and per-worker + daemon log files.
// ---------------------------------------------------------------------------

function getSupervisorStateFile() {
  return join(getStateHome(), SUPERVISOR_STATE_FILE);
}

function getSupervisorLogDir() {
  return join(getLogDir(), 'supervisor');
}

/**
 * Per-worker activity directory + file. A supervised `nano work` child writes a
 * small JSON marker here reporting which job(s) it is currently servicing (or
 * that it is idle); the daemon reads it for `supervisor status`. Worker ids are
 * validated (`isValidWorkerName`: letters, digits, . _ -) so they are safe as a
 * filename with no traversal risk.
 */
function getSupervisorActivityDir() {
  return join(getStateHome(), 'supervisor-activity');
}

function supervisorWorkerActivityFile(id) {
  return join(getSupervisorActivityDir(), `${id}.json`);
}

/**
 * Read a worker's activity marker. Returns the parsed object, or `null` when the
 * file is absent (worker not reporting yet, or a standalone/older worker) or
 * unreadable. Pure enough for status rendering (best-effort IO).
 */
function readWorkerActivity(id) {
  try {
    return JSON.parse(readFileSync(supervisorWorkerActivityFile(id), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Deterministic control-socket path shared by the daemon and every client.
 * Derived from a hash of the (possibly overridden) state home so distinct
 * C8CTL_NANO_HOME instances get distinct sockets, and kept SHORT to stay under
 * the ~104-byte AF_UNIX `sun_path` limit on macOS regardless of username. On
 * Windows a named pipe is used instead. The chosen path is also recorded in the
 * state file so clients can prefer the daemon's own reported path.
 */
function getSupervisorSocketPath() {
  const hash = createHash('sha1').update(getStateHome()).digest('hex').slice(0, 8);
  if (osPlatform() === 'win32') return `\\\\.\\pipe\\c8ctl-nano-sup-${hash}`;
  return join(tmpdir(), `c8ctl-nano-sup-${hash}.sock`);
}

// ---------------------------------------------------------------------------
// Persistent plugin config (config.json) — user settings that survive across
// clusters: the binary path and the workspace (models/workers) location.
// ---------------------------------------------------------------------------

function getConfigFile() {
  return join(getStateHome(), CONFIG_FILE);
}

function readConfigStrict() {
  const file = getConfigFile();
  if (!existsSync(file)) return {};
  const cfg = JSON.parse(readFileSync(file, 'utf-8'));
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function readConfig() {
  try {
    return readConfigStrict();
  } catch {
    // A malformed/torn config.json is swallowed here so ordinary callers get an
    // empty map; callers that must tell "absent" from "unreadable" apart use
    // readConfigStrict() directly and handle the throw.
    return {};
  }
}

function writeConfig(cfg) {
  mkdirSync(getStateHome(), { recursive: true });
  // Atomic write: serialize to a temp file in the same dir, then rename over the
  // target. A rename is atomic on a POSIX filesystem, so a concurrent reader
  // (e.g. `work`'s profile watcher, or another `assign`) never observes a
  // half-written config.json and JSON.parse never sees a torn file.
  const target = getConfigFile();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
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

  // This launcher IS a Node runtime, so hand the server a known-good Node path
  // for its worker fallback (Deno-preferred, Node >= 22.6). Avoid pinning an
  // older Node runtime (the plugin supports Node >=18) so the server can still
  // fall back to a newer Node on PATH when available.
  const [nodeMajor, nodeMinor, nodePatch] = process.versions.node
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  const nodeOk =
    nodeMajor > 22 ||
    (nodeMajor === 22 && (nodeMinor > 6 || (nodeMinor === 6 && nodePatch >= 0)));
  if (nodeOk) markers.NANOBPMN_NODE_BIN = process.execPath;
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

const VALID_SUBCOMMANDS = ['start', 'stop', 'status', 'logs', 'log', 'restart', 'pause', 'resume', 'clean', 'set', 'unset', 'config', 'update', 'hire', 'assign', 'work', 'supervisor', 'workforce'];

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
    console: flags?.console,
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

/**
 * Compose a web-console URL for a node's base URL. Never hardcodes a port:
 * `baseUrl` is the real address the node came up on.
 *
 * No longer carries a `?tour=<id>` deep link: onboarding is chosen in the
 * console's own startup persona panel (nano-bpm #464), not sprayed across every
 * command's output.
 */
function webConsoleUrl(baseUrl) {
  return `${baseUrl}/console`;
}

/**
 * Human label for the console link, keyed on the runtime console profile.
 * The default `studio` profile IS the full web IDE, so name it as such — users
 * kept missing that Nano ships a browser IDE when it was labelled "Web console".
 * `observe` is the read-only console. `off` serves no console, so the label is
 * meaningless there; callers must guard `profile !== 'off'` before rendering it,
 * and this helper returns null for `off` to enforce that contract.
 */
function consoleLinkLabel(profile) {
  if (profile === 'off') return null;
  return profile === 'studio' ? 'Web IDE (Studio)' : `Web console (${profile})`;
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

/** Runtime console profiles the server understands (nano-bpm ADR 0035 §C). */
const CONSOLE_PROFILES = ['off', 'observe', 'studio'];

/**
 * Resolves the runtime console profile to pass through as NANOBPMN_CONSOLE.
 * Precedence: --console flag > inherited NANOBPMN_CONSOLE env >
 * 'studio' (the full IDE, our default). Unknown values are rejected so a typo
 * fails fast here rather than silently degrading the console in the server.
 */
function resolveConsoleProfile(reqConsole) {
  const raw = reqConsole ?? process.env.NANOBPMN_CONSOLE ?? 'studio';
  const profile = String(raw).trim().toLowerCase();
  if (!CONSOLE_PROFILES.includes(profile)) {
    throw new Error(
      `invalid console profile "${raw}" (use one of: ${CONSOLE_PROFILES.join(', ')})`,
    );
  }
  return profile;
}

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
  const consoleProfile = resolveConsoleProfile(req.console);

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
      `${historyMax !== undefined ? `, history-max=${historyMax}` : ''}` +
      `${consoleProfile !== 'studio' ? `, console=${consoleProfile}` : ''}`,
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
      // Runtime console profile (off | observe | studio). Default studio (full
      // IDE); pass-through so --console or an inherited NANOBPMN_CONSOLE
      // picks the observability-only or headless surface. See nano-bpm ADR 0035 §C.
      NANOBPMN_CONSOLE: consoleProfile,
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
    consoleProfile,
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
  const profile = state.consoleProfile ?? 'studio';
  // Lead with the web IDE — it is Nano's headline surface and the thing users
  // most often did not realise was there. Only advertise it when this build
  // actually serves a console and the profile is not 'off'.
  if (hasConsole && profile !== 'off') {
    console.log(`  ${consoleLinkLabel(profile)}   ${webConsoleUrl(entry.url)}`);
    const surface = profile === 'studio' ? 'the Nano web IDE' : 'the Nano web console';
    console.log(`    ^ open this in your browser: ${surface}`);
    console.log('');
  }
  if (hasConsole) {
    console.log(`  Landing      ${entry.url}/          (console, user guide & API docs)`);
    console.log(`  User guide   ${entry.url}/docs`);
  }
  console.log(`  REST API     ${entry.url}/v2`);
  console.log(`  Topology     ${entry.url}/v2/topology`);
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

  // Surface the web IDE again here so it stays discoverable long after the
  // initial `start` scrolled off — probe a healthy node so we only advertise a
  // console that is actually served (API-only builds 404 `/`).
  const profile = state.consoleProfile ?? 'studio';
  if (overall !== 'stopped' && profile !== 'off') {
    // Only probe a HEALTHY node: it already answered /v2/topology this run, so
    // GET / returns fast. Falling back to a merely-alive (unreachable) node
    // would add a full probe timeout to every `nano status` in a degraded state.
    const consoleNode = checks.find((c) => c.healthy);
    if (consoleNode && (await probePath(consoleNode.url, '/'))) {
      console.log(`  ${consoleLinkLabel(profile)}   ${webConsoleUrl(consoleNode.url)}`);
      console.log('');
    }
  }

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
    logger.output(`Log files:\n  ${files.join('\n  ')}`);
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

  // pause/resume rely on SIGSTOP/SIGCONT, which are POSIX-only. On Windows
  // Node throws "Unknown signal: SIGSTOP" from process.kill, so fail fast with
  // a clear message instead of a raw crash (see nano-bpm#390).
  if (process.platform === 'win32') {
    logger.error(
      `"c8ctl nano ${verb}" isn't supported on Windows yet — it relies on ` +
        `SIGSTOP/SIGCONT, which Windows doesn't have. To simulate a node ` +
        `failing and recovering, use "c8ctl nano stop <id>" then ` +
        `"c8ctl nano start" instead.`,
    );
    process.exit(1);
  }

  const state = readState();

  if (!state || !Array.isArray(state.nodes) || state.nodes.length === 0) {
    logger.error('No c8ctl-managed cluster is running. Start one with "c8ctl nano start <nodes>".');
    process.exit(1);
  }

  const nodeIds = state.nodes.map((n) => n.id).join(', ');
  const exampleId = state.nodes[0].id;
  const idArg = req.positional[0];
  if (idArg === undefined) {
    logger.error(`Specify a node id, e.g. "c8ctl nano ${verb} ${exampleId}". Running nodes: [${nodeIds}]`);
    process.exit(1);
  }

  const id = Number.parseInt(idArg, 10);
  const node = Number.isFinite(id) ? state.nodes.find((n) => n.id === id) : undefined;
  if (!node) {
    logger.error(`No node "${idArg}" in the running cluster. Running nodes: [${nodeIds}]`);
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

  if (!key || !Object.hasOwn(SETTING_ALIASES, key)) {
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

/**
 * Clear a configured setting so resolution falls back to the default. The
 * headline use is `unset bin`: after `set bin <path>` pins a self-managed
 * binary (source 'configured', which disables self-update), clearing it lets
 * the plugin fall back to the managed npm platform package — i.e. back on the
 * release train. `unset model-dir` returns the workspace to its default.
 */
function unsetConfig(req) {
  const logger = getLogger();
  const key = req.positional[0];

  if (!key || !Object.hasOwn(SETTING_ALIASES, key)) {
    logger.error('Usage: c8ctl nano unset <bin|model-dir>');
    logger.info('Settings:');
    logger.info('  bin        Clear the custom server binary (back to the managed/release binary)');
    logger.info('  model-dir  Clear the custom workspace dir (back to the default)');
    process.exit(1);
  }

  const field = SETTING_ALIASES[key];
  const cfg = readConfig();
  const prev = cfg[field];
  const wasSet = prev !== undefined && prev !== null && prev !== '';
  const label = field === 'binary' ? 'custom binary override' : 'custom workspace override';

  if (!wasSet) {
    logger.info(`No ${label} is configured — nothing to clear.`);
  } else {
    delete cfg[field];
    writeConfig(cfg);
    logger.info(`Cleared ${label} (was ${prev}).`);
  }

  if (field === 'binary') {
    // Report what resolves now, so the operator can see they are back on the
    // managed release train (or what still overrides it).
    try {
      const r = resolveBinary({});
      logger.info(`Now using: ${r.path} (${r.from}).`);
      if (r.source === 'managed-npm') {
        logger.info('Back on the managed release train — "c8ctl nano update" now tracks the published release.');
      } else if (r.source === 'configured') {
        logger.warn('Still pinned by NANOBPMN_BINARY in your environment; unset that to use the managed binary.');
      }
    } catch (err) {
      logger.warn(`No binary resolves now: ${err instanceof Error ? err.message : err}`);
      logger.info('Reinstall the plugin to fetch the managed platform binary, or set one again with "c8ctl nano set bin <path>".');
    }
  } else if (field === 'workspaceDir') {
    logger.info(`Workspace is now the default: ${getWorkspaceDir()}.`);
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
  console.log(`  binary       ${cfg.binary || '(auto-detect: $NANOBPMN_BINARY, managed platform package, or repo build)'}`);
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
  console.log('  Clear with:  c8ctl nano unset bin | c8ctl nano unset model-dir');
}

// ---------------------------------------------------------------------------
// hire / work — CLI agent harness workers.
//
// A "hire" is a persisted agent profile (name, rank, CLI command, model,
// capabilities). "work <name>" turns that profile into a set of Nano job
// workers: one per job-type in the rank×capability matrix. When a job is
// activated, the profile's CLI command is spawned fresh (one-shot), fed the job
// as JSON on stdin, and its stdout is returned as the job's `output` variable.
// ---------------------------------------------------------------------------

const RANKS = ['principal', 'senior', 'junior', 'decider'];

// C3 (#42): a role's live-terminal mode — a full PTY (streamed + steerable) or a
// plain pipe. Default is `pipe` (the safe non-interactive default); `pty` is
// opt-in per role because a TTY changes the harness's I/O semantics.
const TERMINAL_MODES = ['pipe', 'pty'];

// #110: the harness protocol a role drives its agent over — a plain stdin/scrape
// `pipe` (the default floor) or `acp` (Agent Client Protocol, JSON-RPC over
// stdio). Default is `pipe`; `acp` is opt-in per role. The ACP executor lands in
// a downstream task — this seam only carries the schema/plumbing.
const PROTOCOLS = ['pipe', 'acp'];

// #110: the ACP permission policy for a role. Only `yolo` (auto-allow-all) is
// enforced today; `escalate`/`filter` are RESERVED pending nano-workforce#559
// (the permission-event + escalation bridge) and are not yet enforced — they are
// accepted and persisted for forward-compatibility (never downgraded), but today
// effectively behave like `yolo` (auto-allow). Default is `yolo`.
const PERMISSION_MODES = ['yolo', 'escalate', 'filter'];

// #110: resolve a role's agentic setting (protocol/permission) with a uniform
// env-override → profile → default precedence, tolerating invalid values at
// every layer. A one-off worker env var wins if it names an allowed value; else
// the persisted hire profile decides if it holds an allowed value; else the safe
// default. Reserved-but-allowed values (e.g. escalate/filter) carry through
// verbatim; unknown values are ignored and fall through to the next layer.
function resolveAgenticSetting(envValue, profileValue, allowed, dflt) {
  const env = String(envValue || '').trim().toLowerCase();
  if (allowed.includes(env)) return env;
  const profile = String(profileValue || '').trim().toLowerCase();
  if (allowed.includes(profile)) return profile;
  return dflt;
}

/** Normalize a capability list: trim, drop empties, de-dupe, sort (canonical). */
function normalizeCapabilities(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return [...new Set(raw.map((c) => String(c).trim().toLowerCase()).filter(Boolean))].sort();
}

// A conventional (POSIX-ish) environment variable name.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Normalize a stored/model env map into a clean { NAME: "value" } object:
// drops entries with an invalid name, coerces values to strings. Used for the
// profile's static env and the per-job envelope's setup.env.
function normalizeEnvMap(input) {
  const out = {};
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (!ENV_NAME_RE.test(k)) continue;
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

// Parse repeatable `--env NAME=VALUE` CLI input (string | string[]) into a map.
// The value may contain `=`; only the first `=` splits. Returns { env, errors }.
function parseEnvPairs(input) {
  const list = input == null ? [] : (Array.isArray(input) ? input : [input]);
  const env = {};
  const errors = [];
  for (const item of list) {
    const s = String(item);
    const eq = s.indexOf('=');
    // Never echo the value in diagnostics — a user may pass a secret via --env.
    if (eq <= 0) { errors.push(`--env entry ${eq === 0 ? 'has an empty name' : 'must be NAME=VALUE'} (value hidden)`); continue; }
    const name = s.slice(0, eq);
    if (!ENV_NAME_RE.test(name)) { errors.push(`--env name "${name}" is invalid (must match ${ENV_NAME_RE.source})`); continue; }
    env[name] = s.slice(eq + 1);
  }
  return { env, errors };
}

// Normalize a stored/CLI argument list (string | string[]) into a clean string[]:
// each entry is one whole argv token (e.g. "--allow-all"), coerced to a string,
// with null/undefined and empty tokens dropped. Interior whitespace is preserved
// so a single arg may carry a value like "--foo=a b" intact.
function normalizeArgList(input) {
  const list = input == null ? [] : (Array.isArray(input) ? input : [input]);
  const out = [];
  for (const item of list) {
    if (item == null) continue;
    // A value-less string flag (e.g. a bare `--arg` with no following value) is
    // coerced to boolean `true` by the flag layer. That is never a real arg, so
    // drop it rather than persist the misleading literal token "true".
    if (typeof item === 'boolean') continue;
    const s = String(item);
    if (s.length === 0) continue;
    out.push(s);
  }
  return out;
}

// POSIX single-quote a string so it survives `sh -c`/shell:true as one literal
// argv token, no matter what it contains (spaces, $, quotes, globs). Empty
// string → ''. This is what keeps structured `--arg` values injection-safe even
// though the harness is spawned through a shell (for PATH resolution).
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Build the shell command line for the agent harness: the base command followed
// by each structured argument, shell-quoted. With no args the command is used
// verbatim (preserving pre-existing hires that baked switches into the command).
function buildAgentCommandLine(command, args) {
  const list = normalizeArgList(args);
  if (list.length === 0) return command;
  return `${command} ${list.map(shQuote).join(' ')}`;
}

// A worker job-type token: rank/capability tokens use `:` (rank↔cap) and `+`
// (combined caps) as delimiters, and code-first `@nanobpm/workflow` job types
// are `<flowId>:<taskName>` or an explicit override. The first character must be
// a letter, digit, or `_`; the remainder may also include `. : + -`. Mirrors the
// SDK's assertJobType so a token authored on one side is accepted on the other.
const JOB_TYPE_TOKEN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/;

// Parse repeatable `--job-type <token>` CLI input (string | string[]) into a
// deduped, validated list of explicit job types a worker should also service,
// in addition to its rank×capability matrix. Returns { jobTypes, errors }.
function parseJobTypeFlags(input) {
  const list = input == null ? [] : (Array.isArray(input) ? input : [input]);
  const seen = new Set();
  const jobTypes = [];
  const errors = [];
  for (const item of list) {
    const token = String(item).trim();
    if (!token) { errors.push('--job-type must be a non-empty token'); continue; }
    if (!JOB_TYPE_TOKEN_RE.test(token)) {
      errors.push(`--job-type "${token}" is invalid (must match ${JOB_TYPE_TOKEN_RE.source})`);
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    jobTypes.push(token);
  }
  return { jobTypes, errors };
}

/**
 * Resolve the broker long-poll window (ms) each `activateJobs` request is held
 * open before returning empty. A longer window keeps an idle worker on ONE open
 * connection for that whole window instead of reconnecting every few seconds,
 * cutting the number of connection establishments — and thus the number of
 * chances to hit a transient connect failure (ECONNREFUSED / connect-timeout)
 * on a flaky link.
 *
 * The value is passed straight through to the SDK as `pollTimeoutMs` → the
 * broker's `requestTimeout`, so the documented broker semantics apply: `0` =
 * broker default (~5s), a negative value = return immediately when no job is
 * available. Parsing is `parseInt`-style: only a flag with no leading integer
 * (absent, blank, or non-numeric such as `"abc"`) falls back to the default,
 * while a leading integer with trailing junk (e.g. `"30000ms"`) is honoured as
 * that integer. `0` and negatives are honoured too (which is why this cannot
 * reuse `intFlag`, whose "> 0" guard would floor them to the default).
 *
 * @returns {number}
 */
function derivePollTimeoutMs(flagValue, dflt = 30_000) {
  if (flagValue === undefined || flagValue === null || String(flagValue).trim() === '') {
    return dflt;
  }
  const n = Number.parseInt(String(flagValue), 10);
  return Number.isFinite(n) ? n : dflt;
}
function isValidProfileName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(name);
}

/**
 * The job-type matrix a worker subscribes to, from a profile's rank
 * and sorted capabilities [c1, c2, ...]:
 *   - `rank`                 (rank alone)
 *   - `rank:c1`, `rank:c2`   (rank + a single capability, "spread")
 *   - `rank:c1+c2+...`       (rank + all capabilities combined; only when >1 cap)
 * Delimiters: `:` separates rank from capabilities, `+` joins combined caps.
 * Capabilities are sorted so the combined token is canonical/predictable.
 */
function jobTypeMatrix(rank, capabilities) {
  const caps = normalizeCapabilities(capabilities);
  const tokens = [rank];
  for (const c of caps) tokens.push(`${rank}:${c}`);
  if (caps.length > 1) tokens.push(`${rank}:${caps.join('+')}`);
  return [...new Set(tokens)];
}

/**
 * Diff a running set of job-type pollers against a desired set. Pure so the
 * profile-watch reconcile in `work` (which starts pollers for `added` types and
 * gracefully drains pollers for `removed` types) is unit-testable. Order in the
 * returned arrays is stable (desired order for `added`, current order for
 * `removed`) for deterministic logging.
 */
function diffJobTypes(current, desired) {
  const cur = new Set(current);
  const want = new Set(desired);
  const added = [...want].filter((t) => !cur.has(t));
  const removed = [...cur].filter((t) => !want.has(t));
  return { added, removed };
}

/** All persisted hire profiles, keyed by name. */
function readHires() {
  const cfg = readConfig();
  // A JSON array is `typeof === 'object'` but drops string-keyed writes on
  // JSON.stringify, so treat only plain objects as a valid hires map.
  return cfg.hires && typeof cfg.hires === 'object' && !Array.isArray(cfg.hires) ? cfg.hires : {};
}

/**
 * Like readHires(), but propagates a malformed-config parse error instead of
 * swallowing it. Lets a caller distinguish "profile genuinely removed" from
 * "config temporarily unreadable/torn" so it can report an accurate reason.
 */
function readHiresStrict() {
  const cfg = readConfigStrict();
  return cfg.hires && typeof cfg.hires === 'object' && !Array.isArray(cfg.hires) ? cfg.hires : {};
}

/** Persist a single hire profile into config.json under `hires`. */
function writeHire(profile) {
  const cfg = readConfig();
  if (!cfg.hires || typeof cfg.hires !== 'object' || Array.isArray(cfg.hires)) cfg.hires = {};
  cfg.hires[profile.name] = profile;
  writeConfig(cfg);
}

/**
 * Validate and normalize a stored profile before use so a hand-edited or
 * version-skewed config.json can't produce undefined job types or an invalid
 * spawn. Returns the normalized profile, or a { error } describing the problem.
 */
function normalizeStoredProfile(name, profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { error: `profile "${name}" is not an object` };
  }
  const rank = String(profile.rank || '').trim().toLowerCase();
  if (!RANKS.includes(rank)) {
    return { error: `profile "${name}" has an invalid rank "${profile.rank}" (expected one of: ${RANKS.join(', ')})` };
  }
  const command = String(profile.command || '').trim();
  if (!command) {
    return { error: `profile "${name}" has no command to run` };
  }
  const sandbox = String(profile.sandbox || 'none').trim().toLowerCase();
  if (!SANDBOXES.includes(sandbox)) {
    return { error: `profile "${name}" has an invalid sandbox "${profile.sandbox}" (expected one of: ${SANDBOXES.join(', ')})` };
  }
  const image = typeof profile.image === 'string' ? profile.image.trim() : '';
  if (CONTAINER_SANDBOXES.has(sandbox) && !image) {
    return { error: `profile "${name}" uses sandbox "${sandbox}" but has no image` };
  }
  // C3 (#42): live-terminal mode. Tolerant — an unknown/legacy value falls back
  // to the safe `pipe` default rather than failing the whole profile.
  const terminalRaw = typeof profile.terminal === 'string' ? profile.terminal.trim().toLowerCase() : '';
  const terminal = TERMINAL_MODES.includes(terminalRaw) ? terminalRaw : 'pipe';
  // #110: harness protocol + ACP permission policy. Tolerant like `terminal` —
  // an unknown/legacy/missing value falls back to the safe defaults ('pipe' /
  // 'yolo') rather than failing the whole profile. A persisted escalate/filter
  // is preserved verbatim (it is enforced by a downstream task pending
  // nano-workforce#559), never downgraded.
  const protocolRaw = typeof profile.protocol === 'string' ? profile.protocol.trim().toLowerCase() : '';
  const protocol = PROTOCOLS.includes(protocolRaw) ? protocolRaw : 'pipe';
  const permissionRaw = typeof profile.permission === 'string' ? profile.permission.trim().toLowerCase() : '';
  const permission = PERMISSION_MODES.includes(permissionRaw) ? permissionRaw : 'yolo';
  return {
    profile: {
      name,
      rank,
      command,
      args: normalizeArgList(profile.args),
      model: typeof profile.model === 'string' ? profile.model.trim() : '',
      capabilities: normalizeCapabilities(profile.capabilities),
      sandbox,
      image,
      terminal,
      protocol,
      permission,
      env: normalizeEnvMap(profile.env),
    },
  };
}

/**
 * Merge additional capabilities into an already-normalized profile, returning a
 * new profile object with the union of capabilities (canonical order) and a
 * refreshed `updatedAt`. Pure (no config I/O), so it is unit-testable. Existing
 * fields — including `createdAt` — are preserved. `incoming` may be a
 * comma-string or an array. Returns `{ profile, added }`, where `added` lists
 * the newly gained capabilities (empty when the assign is a no-op).
 */
function applyAssign(existing, incoming, now = new Date().toISOString()) {
  const before = new Set(normalizeCapabilities(existing && existing.capabilities));
  const union = normalizeCapabilities([...before, ...normalizeCapabilities(incoming)]);
  const added = union.filter((c) => !before.has(c));
  return {
    profile: { ...existing, capabilities: union, updatedAt: now },
    added,
  };
}

/**
 * Resolve the profile name and the raw comma-joined capability string for an
 * `assign` invocation from parsed positionals + flags. Pure (no I/O) so the
 * positional-slicing rules are unit-testable.
 *
 * When `--name` is supplied the name does NOT consume a positional, so every
 * positional is a capability. Otherwise the first positional is the name and
 * the rest are capabilities. `--capabilities a,b` is always appended.
 */
function resolveAssignInputs(req, flags) {
  const positional = Array.isArray(req?.positional) ? req.positional : [];
  const name = flags?.name ? String(flags.name).trim() : positional[0];
  const positionalCaps = flags?.name ? positional : positional.slice(1);
  const flagCaps = flags?.capabilities !== undefined ? String(flags.capabilities) : '';
  const incomingRaw = [...positionalCaps, flagCaps].filter(Boolean).join(',');
  return { name, incomingRaw };
}

/**
 * assign — grant new capabilities (roles) to an existing hire without
 * re-running `hire`. The profile name is positional[0] (or `--name`);
 * capabilities are the remaining positionals and/or `--capabilities a,b`.
 * Capabilities are unioned with the profile's existing set (additive; assign
 * never removes a role) and the updated rank×capability job-type matrix is
 * printed. Running workers hot-reload the new job types within ~1.5s — no
 * restart needed.
 */
async function assignCapabilities(req, flags) {
  const logger = getLogger();
  const { name, incomingRaw } = resolveAssignInputs(req, flags);
  if (!name) {
    logger.error('Usage: c8ctl nano assign <profileName> <cap[,cap...]> [--name <n>] [--capabilities <a,b>]');
    logger.info('Grant new capabilities to an existing hire. List profiles with: c8ctl nano hire --list');
    process.exit(1);
  }
  if (!isValidProfileName(name)) {
    logger.error(`Invalid profile name "${name}". Use letters, digits, dot, dash or underscore.`);
    process.exit(1);
  }

  if (normalizeCapabilities(incomingRaw).length === 0) {
    logger.error('Provide at least one capability to assign.');
    logger.info(`Example: c8ctl nano assign ${name} code-review,testing`);
    process.exit(1);
  }

  const raw = readHires()[name];
  if (!raw) {
    logger.error(`No hire named "${name}". List profiles with: c8ctl nano hire --list`);
    process.exit(1);
  }
  const normalized = normalizeStoredProfile(name, raw);
  if (normalized.error) {
    logger.error(`Cannot assign to "${name}": ${normalized.error}. Re-create it with: c8ctl nano hire`);
    process.exit(1);
  }

  // Preserve createdAt (normalizeStoredProfile drops it) on the canonical form.
  const base = {
    ...normalized.profile,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
  const { profile, added } = applyAssign(base, incomingRaw);
  if (added.length === 0) {
    logger.info(`"${name}" already has: ${profile.capabilities.join(', ') || '(none)'} — no change.`);
    return;
  }
  writeHire(profile);

  const matrix = jobTypeMatrix(profile.rank, profile.capabilities);
  logger.info(`Assigned to "${name}" [${profile.rank}]: +${added.join(', ')}`);
  logger.info(`  capabilities: ${profile.capabilities.join(', ')}`);
  logger.info(`  job types (${matrix.length}): ${matrix.join('  ')}`);
  logger.info(`Running workers pick this up automatically within ~1.5s — no restart needed.`);
}

/**
 * field can also be supplied via a flag (--name/--rank/--command/--model/
 * --capabilities) for scripting. Prompts only for the fields still missing.
 * `--list` prints existing profiles instead.
 */
async function hireWorker(req, flags) {
  const logger = getLogger();

  if (flags?.list) {
    const hires = readHires();
    const names = Object.keys(hires);
    if (names.length === 0) {
      logger.info('No hires yet. Create one with: c8ctl nano hire');
      return;
    }
    logger.info('Hired agent profiles:');
    for (const name of names.sort()) {
      const p = hires[name];
      const term = String(p.terminal || '').trim().toLowerCase() === 'pty' ? '; terminal: pty' : '';
      const proto = String(p.protocol || '').trim().toLowerCase() === 'acp' ? '; protocol: acp' : '';
      const perm = (() => {
        const v = String(p.permission || '').trim().toLowerCase();
        // Only surface recognized non-default modes; normalizeStoredProfile
        // coerces unknown/legacy values back to yolo at runtime, so showing them
        // here would make --list disagree with actual behavior.
        return v && v !== 'yolo' && PERMISSION_MODES.includes(v) ? `; permission: ${v}` : '';
      })();
      logger.info(`  ${name}  [${p.rank}]  ${buildAgentCommandLine(p.command, p.args)}  (model: ${p.model || '-'}; caps: ${normalizeCapabilities(p.capabilities).join(', ') || '-'}${term}${proto}${perm})`);
    }
    logger.info('');
    logger.info('Put one to work with: c8ctl nano work <name>');
    return;
  }

  // Seed from flags; prompt for anything still missing. Trim string flags so a
  // stray space can't be persisted into config.json or the spawned command.
  let name = flags?.name ? String(flags.name).trim() : req.positional[0];
  let rank = flags?.rank ? String(flags.rank).trim().toLowerCase() : undefined;
  let command = flags?.command !== undefined ? String(flags.command).trim() : undefined;
  let model = flags?.model !== undefined ? String(flags.model).trim() : undefined;
  let capabilities = flags?.capabilities !== undefined ? flags.capabilities : undefined;
  let sandbox = flags?.sandbox !== undefined ? String(flags.sandbox).trim().toLowerCase() : undefined;
  let image = flags?.image !== undefined ? String(flags.image).trim() : undefined;
  let terminal = flags?.terminal !== undefined ? String(flags.terminal).trim().toLowerCase() : undefined;
  let protocol = flags?.protocol !== undefined ? String(flags.protocol).trim().toLowerCase() : undefined;
  let permission = flags?.permission !== undefined ? String(flags.permission).trim().toLowerCase() : undefined;
  // Structured command-line switches appended to the command when spawned, e.g.
  // `--arg --allow-all` for `copilot`. Repeatable; each --arg is one argv token.
  const commandArgs = normalizeArgList(flags?.arg);
  const envFromFlags = flags?.env !== undefined;
  const { env: profileEnv, errors: envErrors } = parseEnvPairs(flags?.env);
  if (envErrors.length > 0) {
    logger.error(envErrors.join('; '));
    logger.info('Example: c8ctl nano hire --name coder --rank senior --command copilot --arg --allow-all --env COPILOT_ENABLE_ALL_TOOLS=1');
    process.exit(1);
  }

  const missingRequired = !name || !rank || !command;
  // NOTE: --env is deliberately NOT part of missingOptional — a fully-specified
  // scripted hire must not be forced into interactive mode just to skip env.
  // The env prompt below is gated separately on !envFromFlags, so it only runs
  // when we're already interactive for another reason.
  const missingOptional = model === undefined || capabilities === undefined;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  // Non-interactively only name/rank/command are required; model and
  // capabilities are optional (they default to empty), matching how the
  // interactive prompts label them.
  if (missingRequired && !interactive) {
    logger.error('Non-interactive: provide at least --name, --rank and --command.');
    logger.info('Example: c8ctl nano hire --name reviewer --rank senior --command copilot --model gpt-5 --capabilities code-review,testing');
    process.exit(1);
  }

  if (interactive && (missingRequired || missingOptional)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('Hire a CLI agent worker. Press Ctrl-C to cancel.');
      console.log('');
      while (!name) {
        const ans = (await rl.question('Profile name: ')).trim();
        if (isValidProfileName(ans)) { name = ans; break; }
        console.log('  Please use letters, digits, dot, dash or underscore.');
      }
      while (!rank) {
        const ans = (await rl.question(`Rank (${RANKS.join('|')}): `)).trim().toLowerCase();
        if (RANKS.includes(ans)) { rank = ans; break; }
        console.log(`  Rank must be one of: ${RANKS.join(', ')}`);
      }
      while (!command) {
        const ans = (await rl.question('CLI command (e.g. copilot, claude, pi): ')).trim();
        if (ans) { command = ans; break; }
        console.log('  A command is required.');
      }
      if (model === undefined) {
        model = (await rl.question('Model name (optional): ')).trim();
      }
      if (capabilities === undefined) {
        capabilities = (await rl.question('Capabilities (comma-separated, optional): ')).trim();
      }
      // Static harness env (permission toggles, etc.). Prompted one NAME=VALUE at
      // a time — blank finishes — so values may safely contain '=' and ','.
      // Skipped when --env was supplied on the command line.
      if (!envFromFlags) {
        console.log('Harness env vars — NAME=VALUE, blank to finish (optional):');
        for (;;) {
          const ans = (await rl.question('  env (NAME=VALUE): ')).trim();
          if (!ans) break;
          const { env: one, errors } = parseEnvPairs([ans]);
          if (errors.length > 0) { console.log(`  ${errors.join('; ')}`); continue; }
          Object.assign(profileEnv, one);
        }
      }
    } finally {
      rl.close();
    }
  }

  // Optional fields default to empty when omitted (e.g. scripted invocations).
  if (model === undefined) model = '';
  if (capabilities === undefined) capabilities = '';
  if (sandbox === undefined || sandbox === '') sandbox = 'none';
  if (image === undefined) image = '';
  if (terminal === undefined || terminal === '') terminal = 'pipe';
  if (protocol === undefined || protocol === '') protocol = 'pipe';
  if (permission === undefined || permission === '') permission = 'yolo';

  if (!SANDBOXES.includes(sandbox)) {
    logger.error(`Invalid --sandbox "${sandbox}". Use one of: ${SANDBOXES.join(', ')}`);
    process.exit(1);
  }
  if (!TERMINAL_MODES.includes(terminal)) {
    logger.error(`Invalid --terminal "${terminal}". Use one of: ${TERMINAL_MODES.join(', ')}`);
    process.exit(1);
  }
  if (!PROTOCOLS.includes(protocol)) {
    logger.error(`Invalid --protocol "${protocol}". Use one of: ${PROTOCOLS.join(', ')}`);
    process.exit(1);
  }
  if (!PERMISSION_MODES.includes(permission)) {
    logger.error(`Invalid --permission "${permission}". Use one of: ${PERMISSION_MODES.join(', ')}`);
    process.exit(1);
  }
  // #110: escalate/filter are accepted and persisted for forward-compatibility,
  // but not yet enforced (pending nano-workforce#559). Warn the operator so a
  // hire is never misread as gating destructive ops today — the value is kept as
  // given (never downgraded to yolo).
  if (permission === 'escalate' || permission === 'filter') {
    logger.warn(`Permission policy "${permission}" is RESERVED and NOT enforced in this build (pending nano-workforce#559): it does not gate anything today and effectively behaves like yolo (auto-allow all permission requests). The value is persisted as-is for forward-compatibility.`);
  }

  if (CONTAINER_SANDBOXES.has(sandbox) && !image) {
    logger.error(`--sandbox ${sandbox} requires --image <ref> (the container image the agent runs in).`);
    process.exit(1);
  }

  if (!isValidProfileName(name)) {
    logger.error(`Invalid profile name "${name}". Use letters, digits, dot, dash or underscore.`);
    process.exit(1);
  }
  if (!RANKS.includes(rank)) {
    logger.error(`Invalid rank "${rank}". Must be one of: ${RANKS.join(', ')}`);
    process.exit(1);
  }
  if (!command) {
    logger.error('A CLI command is required.');
    process.exit(1);
  }

  const existed = Boolean(readHires()[name]);
  const profile = {
    name,
    rank,
    command,
    args: commandArgs,
    model: model || '',
    capabilities: normalizeCapabilities(capabilities),
    sandbox,
    image: image || '',
    terminal,
    protocol,
    permission,
    env: profileEnv,
    createdAt: new Date().toISOString(),
  };
  writeHire(profile);

  const matrix = jobTypeMatrix(profile.rank, profile.capabilities);
  logger.info(`${existed ? 'Updated' : 'Hired'} "${name}" [${profile.rank}] → ${buildAgentCommandLine(profile.command, profile.args)}`);
  logger.info(`  model: ${profile.model || '(none)'}`);
  logger.info(`  capabilities: ${profile.capabilities.join(', ') || '(none)'}`);
  if (profile.args.length > 0) logger.info(`  args: ${profile.args.map(shQuote).join(' ')}`);
  logger.info(`  sandbox: ${profile.sandbox}${CONTAINER_SANDBOXES.has(profile.sandbox) ? ` (image ${profile.image})` : ''}`);
  logger.info(`  live terminal: ${profile.terminal}${profile.terminal === 'pty' ? ' (streamed + steerable on the relay lane)' : ''}`);
  logger.info(`  protocol: ${profile.protocol}${profile.protocol === 'acp' ? ' (Agent Client Protocol — JSON-RPC over stdio; ACTIVE on the host executor (sandbox=none): the harness is driven over ACP. Container sandboxes (docker/podman) do NOT yet run ACP and are pipe-only today (--terminal pty is host-only))' : ''}`);
  logger.info(`  permission: ${profile.permission}${(profile.permission === 'escalate' || profile.permission === 'filter') ? ' (RESERVED — not yet enforced, pending nano-workforce#559)' : ''}`);
  const envKeys = Object.keys(profile.env);
  if (envKeys.length > 0) logger.info(`  env: ${envKeys.join(', ')}`);
  logger.info(`  job types (${matrix.length}): ${matrix.join('  ')}`);
  logger.info(`Put it to work with: c8ctl nano work ${name}`);
}

/**
 * Concatenate captured Buffer chunks into a UTF-8 string, dropping a trailing
 * incomplete multibyte sequence (which the byte cap may have split) so decoding
 * never emits a replacement char or pushes the string over the byte cap.
 */
function joinCapped(chunks) {
  if (!chunks.length) return '';
  let buf = Buffer.concat(chunks);
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80 && cont < 3) { i -= 1; cont += 1; }
  if (i >= 0) {
    const lead = buf[i];
    let needed;
    if ((lead & 0x80) === 0x00) needed = 0;
    else if ((lead & 0xe0) === 0xc0) needed = 1;
    else if ((lead & 0xf0) === 0xe0) needed = 2;
    else if ((lead & 0xf8) === 0xf0) needed = 3;
    else needed = -1;
    if (needed > 0 && cont < needed) buf = buf.subarray(0, i);
  }
  return buf.toString('utf8');
}

/**
 * Kill a spawned child and its whole process tree. With `detached: true` on
 * POSIX the child leads its own process group, so a negative PID signals every
 * process in that group (shell wrapper + the actual harness command). Falls
 * back to a plain child.kill() on Windows or if the group signal fails.
 */
function killTree(child) {
  const pid = child.pid;
  if (process.platform !== 'win32' && typeof pid === 'number') {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// ===========================================================================
// Agent task envelope + sandboxed execution (issue #8, increment 1)
// ===========================================================================

// Reserved namespaces. The INPUT envelope is assembled from the job's static
// customHeaders (model-authored defaults) deep-merged with per-instance
// variables (overrides win), then normalized/coerced to schema v1. The OUTPUT
// envelope is written back on the job's completion variables.
const AGENT_TASK_NS = 'io.nanobpm.agentTask';
const AGENT_RESULT_KEY = 'io.nanobpm.agentResult';
// Zeebe/Camunda-parity linked resources (issue #63). At job activation the
// engine resolves each declared `<zeebe:linkedResource resourceId … linkName>`
// to the LATEST deployed key and delivers this custom header: a JSON array of
// `{ resourceKey, resourceType, linkName }`. The header carries the key, not the
// content — the worker fetches the bytes over the broker REST API. The entry
// whose `linkName` matches DEFAULT_PROMPT_LINK_NAME supplies the agent's base
// prompt (live-updatable by redeploying just the resource).
const LINKED_RESOURCES_HEADER = 'linkedResources';
const DEFAULT_PROMPT_LINK_NAME = 'prompt';
const TASK_ENVELOPE_SCHEMA_VERSION = 1;
// The result-envelope version is intentionally independent of the task-envelope
// version so the two contracts can evolve separately without silently coupling.
const RESULT_ENVELOPE_SCHEMA_VERSION = 1;

// Structured result channel (agent → harness). A coding CLI streams a lot of
// noisy prose/tool output on stdout, so scraping it for the job's structured
// result is fragile. Instead the harness hands the agent a private file path in
// `AGENT_RESULT_FILE`; the agent writes a JSON object of *job result variables*
// there (e.g. `{ "status": "needs_input", "question": "…" }`). The harness reads
// it after the run and merges those variables into the job's completion, so the
// model sees them as first-class outputs. A `::nano:result:: {json}` stdout
// sentinel (or a trailing ```json fence) is honoured as a fallback for agents
// that cannot write the file. The harness stays app-agnostic: it merges whatever
// object the agent returns; the *app's prompt* owns the field vocabulary.
const AGENT_RESULT_FILE_ENV = 'AGENT_RESULT_FILE';
const RESULT_SENTINEL = '::nano:result::';
// Completion keys the harness owns — an agent's returned result can never
// overwrite these (nor anything in the reserved `io.nanobpm.*` namespace), so a
// stray `output`/`exitCode`/git field in the agent's JSON can't corrupt the
// audit envelope or process bookkeeping.
const RESERVED_RESULT_KEYS = new Set([
  AGENT_RESULT_KEY, 'output', 'exitCode', 'agent', 'truncated',
  'branch', 'commits', 'pushed', 'pullRequest', 'forcedReap',
]);

// Parse `text` as a JSON object, returning it only when it is a plain object.
// Never throws — malformed agent output degrades to `null`.
function parseAgentResultObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch { return null; }
}

// Read + parse the agent's result file, if it wrote one. Best-effort; a missing
// or malformed file is treated as "no structured result". The file is
// agent-controlled, so guard against a symlink or an oversized payload (DoS):
// only a regular file no larger than the cap is read. A well-formed result is a
// tiny JSON object, so the cap is generous.
const MAX_RESULT_FILE_BYTES = 1_048_576; // 1 MiB
function readAgentResultFile(path) {
  if (!path) return null;
  try {
    const st = lstatSync(path); // lstat: never follow a symlink the agent planted
    if (!st.isFile() || st.size > MAX_RESULT_FILE_BYTES) return null;
    return parseAgentResultObject(readFileSync(path, 'utf8'));
  } catch { return null; }
}

// Fallback extraction from stdout, robust to the surrounding transcript: prefer
// the LAST `::nano:result:: {json}` sentinel line (cheapest + most explicit),
// else the LAST ```json fenced block. "Last wins" so a re-stated result
// supersedes an earlier draft.
function parseResultFromStdout(stdout) {
  if (typeof stdout !== 'string' || !stdout) return null;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(RESULT_SENTINEL);
    if (idx === -1) continue;
    const obj = parseAgentResultObject(lines[i].slice(idx + RESULT_SENTINEL.length).trim());
    if (obj) return obj;
  }
  // Match the opening fence tolerantly (optional language tag, CRLF or LF) so a
  // Windows agent's `\r\n` output still parses.
  const fences = [...stdout.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const obj = parseAgentResultObject(fences[i][1].trim());
    if (obj) return obj;
  }
  return null;
}

// The domain result variables an agent may return: the parsed object with the
// harness-reserved keys (and the `io.nanobpm.*` namespace) stripped, so it can
// never clobber the audit envelope, transcript, or git facts. The agent's output
// is untrusted, so build the result on a null-prototype object and drop the
// prototype-pollution keys — a merged `__proto__`/`constructor`/`prototype`
// must never mutate object prototypes when spread into the job completion.
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeResultVars(obj) {
  if (!isPlainObject(obj)) return {};
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (RESERVED_RESULT_KEYS.has(k)) continue;
    if (PROTO_POLLUTION_KEYS.has(k)) continue;
    if (k.startsWith('io.nanobpm.')) continue;
    out[k] = v;
  }
  return out;
}

const SANDBOXES = ['none', 'docker', 'podman'];
// Only container-based sandboxes need an image / disk hygiene / a runtime bin.
const CONTAINER_SANDBOXES = new Set(['docker', 'podman']);

function coerceBool(v, dflt = false) {
  if (typeof v === 'boolean') return v;
  if (v == null) return dflt;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  return dflt;
}

function coerceInt(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base)) return isPlainObject(over) ? deepMerge({}, over) : over;
  const out = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

// Collect the reserved namespace out of a flat key→value map (customHeaders or
// variables). Supports both a single `io.nanobpm.agentTask` key whose value is
// a JSON string/object, AND flattened dotpath keys like
// `io.nanobpm.agentTask.repository.ref` (element templates emit the latter).
function collectEnvelopeFrom(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  const whole = source[AGENT_TASK_NS];
  if (whole != null) {
    let val = whole;
    if (typeof whole === 'string') {
      try { val = JSON.parse(whole); } catch { val = undefined; }
    }
    if (isPlainObject(val)) Object.assign(out, deepMerge(out, val));
  }
  const prefix = `${AGENT_TASK_NS}.`;
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    setPath(out, rest.split('.'), value);
  }
  return out;
}

// Normalize the assembled envelope to schema v1, coercing header string values
// (element templates write everything as strings) into bool/int as needed.
//
// `opts.basePromptOverride` (issue #63): when a `linkName: prompt` linked
// resource resolves, its fetched content is passed here and WINS over the
// header-baked `task.prompt` / `variables.prompt` / `variables.task` chain. The
// FEEL-composed `appendPrompt` concatenation is unchanged — it still appends to
// whatever base was resolved.
function normalizeTaskEnvelope(customHeaders, variables, opts = {}) {
  const raw = deepMerge(collectEnvelopeFrom(customHeaders), collectEnvelopeFrom(variables));
  const str = (v) => (v == null ? undefined : String(v));
  const env = {
    // Normalization always emits the v1 shape, so the version is forced to v1
    // (the raw input version is only a hint about how the author authored it).
    schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION,
  };

  const repo = raw.repository;
  if (isPlainObject(repo) && str(repo.url)) {
    env.repository = {
      provider: (str(repo.provider) || 'github').toLowerCase(),
      url: str(repo.url),
      ref: str(repo.ref),
      // Dedicated field for a raw commit SHA to check out (detached), mirroring
      // baseSha/baseRef. `ref` is ALWAYS a branch/tag name — there is no hex
      // heuristic — so a legitimately hex-named branch (e.g. `deadbeef`) is
      // never misread as a commit; pin a commit via `sha` instead.
      sha: str(repo.sha),
      depth: coerceInt(repo.depth, undefined),
      // Scope the fetch to just `ref` (independent of depth) for callers that want
      // full history of one branch but not every branch of a huge monorepo.
      singleBranch: coerceBool(repo.singleBranch, false),
      // Partial/treeless clone spec (e.g. "blob:none"): full commit graph with
      // lazy blob fetch, so `merge-base` / `git diff base...head` still work.
      filter: str(repo.filter),
      // When a base branch/sha is supplied we additionally fetch it so a
      // single-branch/shallow clone can still diff `base...head`.
      baseRef: str(repo.baseRef),
      baseSha: str(repo.baseSha),
      // Per-envelope override of the clone/fetch timeout (ms) — a backstop for
      // repos big enough to approach the default 120s cap even when shallow.
      cloneTimeoutMs: coerceInt(repo.cloneTimeoutMs, undefined),
      submodules: coerceBool(repo.submodules, false),
      authRef: str(repo.authRef),
    };
  }

  const branch = isPlainObject(raw.branch) ? raw.branch : {};
  env.branch = {
    base: str(branch.base),
    create: str(branch.create),
    push: coerceBool(branch.push, true),
  };

  const setup = isPlainObject(raw.setup) ? raw.setup : {};
  env.setup = {
    commands: Array.isArray(setup.commands) ? setup.commands.map(String) : [],
    env: isPlainObject(setup.env) ? setup.env : {},
    secretRefs: Array.isArray(setup.secretRefs) ? setup.secretRefs.map(String) : [],
  };

  const task = isPlainObject(raw.task) ? raw.task : {};
  // Base prompt: an override supplied by a resolved `linkName: prompt` linked
  // resource (issue #63) wins; else the reserved `task.prompt` (typically a model
  // header filled at deploy time), else a plain `prompt`/`task` job variable (the
  // pre-header delivery path).
  const overrideBase = opts && opts.basePromptOverride != null ? String(opts.basePromptOverride) : undefined;
  const basePrompt = overrideBase ?? str(task.prompt) ?? str(variables?.prompt) ?? str(variables?.task);
  // Verbatim dynamic append: a header-delivered base prompt can't be composed in FEEL, so a task
  // may supply per-instance context (e.g. plan-revision feedback, a per-task brief) via the
  // reserved `task.appendPrompt`, or a plain `appendPrompt` variable. It is concatenated onto the
  // base with NO injected separator — the caller (the model's ioMapping) owns any leading
  // separator/preamble — so a null/empty append leaves the base prompt untouched.
  const appendPrompt = str(task.appendPrompt) ?? str(variables?.appendPrompt);
  const prompt =
    appendPrompt != null && appendPrompt !== ''
      ? `${basePrompt ?? ''}${appendPrompt}`
      : basePrompt;
  env.task = {
    prompt,
    promptFile: str(task.promptFile),
    maxIterations: coerceInt(task.maxIterations, undefined),
    timeoutMs: coerceInt(task.timeoutMs, undefined),
    allowPr: coerceBool(task.allowPr, false),
    prBase: str(task.prBase),
  };

  return env;
}

// ---- Linked resources → live agent prompt (issue #63) ----------------------
// A job's `linkedResources` activation header carries KEYS (not content); the
// worker resolves each to the LATEST deployed bytes over the broker REST API, so
// an agent prompt can be updated by redeploying one Markdown resource — no
// process redeploy, no harness restart.

// Parse the `linkedResources` custom header off an activated job. The engine
// delivers a JSON array; element-template/header transport stringifies it. Also
// tolerate an already-parsed array. Anything malformed/absent → [] (fallback
// path). Never throws.
function parseLinkedResources(customHeaders) {
  if (!isPlainObject(customHeaders)) return [];
  const raw = customHeaders[LINKED_RESOURCES_HEADER];
  if (raw == null) return [];
  let val = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { val = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(val)) return [];
  return val.filter((e) => isPlainObject(e) && e.resourceKey != null);
}

// Select the linked resource that supplies the base prompt: the first entry
// whose `linkName` matches (default `prompt`). Returns the entry or null.
function pickLinkedResource(linkedResources, linkName = DEFAULT_PROMPT_LINK_NAME) {
  if (!Array.isArray(linkedResources)) return null;
  return linkedResources.find((e) => isPlainObject(e) && String(e.linkName) === String(linkName)) || null;
}

// The broker REST base URL + optional bearer the harness uses to fetch resource
// content — the SAME nano endpoint the worker already talks to (env wins over
// persisted config, falling back to the default localhost port). A local nano
// cluster is unauthenticated, so the token is optional; when set (e.g. against a
// secured gateway) it is sent as a Bearer credential.
// Same-origin test for two URLs (protocol + host + port). Returns false if
// either string is missing or unparseable, so a token is never forwarded to an
// endpoint we can't positively confirm matches.
function sameOrigin(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function resolveBrokerRestConfig(env = process.env, opts = {}) {
  // readConfig() swallows parse/IO errors and never throws (returns {}), so no
  // local try/catch is needed here.
  const cfg = readConfig() || {};
  // `opts.baseUrl` lets a caller pin the effective base (e.g. the active c8ctl
  // profile's REST address — see resolveAutoRestConfig) while still running it
  // through the SAME token same-origin gate below, so the token logic stays
  // single-sourced (never duplicated per call site).
  const baseUrl =
    opts.baseUrl ||
    env.NANO_REST_URL ||
    env.NANO_BASE_URL ||
    cfg.nanoUrl ||
    DEFAULT_NANO_URL;
  // An explicit REST token always wins. The agentic identity secret is only a
  // fallback for single-token deployments where the broker REST endpoint IS the
  // agentic endpoint — so only forward it when the REST base URL is same-origin
  // as the agentic URL. This prevents leaking the identity secret to a different
  // NANO_REST_URL host when no REST token is set (see resolveAgenticConfig).
  let token = env.NANO_REST_TOKEN || '';
  if (!token) {
    const agenticToken = env.NANO_AGENTIC_SECRET
      || cfg.agenticSecret
      || env.NANO_AGENTIC_TOKEN
      || cfg.agenticToken
      || '';
    const agenticUrl =
      env.NANO_AGENTIC_URL ||
      cfg.agenticUrl ||
      cfg.nanoUrl ||
      env.NANO_BASE_URL ||
      DEFAULT_NANO_URL;
    if (agenticToken && sameOrigin(baseUrl, agenticUrl)) token = agenticToken;
  }
  return { baseUrl, token };
}

// Resolve the C8 REST config the `--auto` engine-read reader is built from.
// This is the job-type-read analogue of resolveLinkedPromptSource: an explicit
// NANO_REST_URL / NANO_BASE_URL / cfg.nanoUrl override still wins (operator
// escape hatch), but with NONE of those set the base is derived from the SAME
// c8ctl client that activates jobs (its getConfig().restAddress) rather than the
// localhost default — so a worker that can activate jobs against a profile
// engine can also read the deployed job types from it. Without this, an `--auto`
// worker on an active remote profile reads from http://localhost:8080, finds no
// engine, discovers 0 job types, and crash-loops (jwulf/c8ctl-plugin-nano#93).
// Falls back to resolveBrokerRestConfig's localhost default only when the client
// exposes no usable restAddress. The token same-origin gate lives in
// resolveBrokerRestConfig (re-run against the profile base), never duplicated.
function resolveAutoRestConfig(camunda, env = process.env) {
  // Derive the base from the single canonical resolver (explicit override →
  // profile restAddress → localhost), then run it through resolveBrokerRestConfig
  // so the token same-origin gate stays single-sourced. resolveWorkerEngineBase
  // always returns a base, so opts.baseUrl always pins it here.
  const baseUrl = resolveWorkerEngineBase(camunda, env);
  return resolveBrokerRestConfig(env, { baseUrl });
}

// ---------------------------------------------------------------------------
// `nano work --auto`: zero-config engine-read enrolment (issue #66).
//
// Subscribe a generic worker to ALL deployed *agent* job types by reading the
// demand straight from the engine (C8 REST) the worker already talks to — no
// capability, no app enrol endpoint, no hub rendezvous. The engine is the
// guaranteed shared rendezvous: if a worker can execute an app's agent jobs at
// all, it and the app are already on the same engine, so "what agent job types
// exist" is answerable from that engine alone.
//
// `@nanobpm/agentic/demand` already reads deployed `taskDefinition` leaves over
// C8 REST (`process-definitions/search` → `/{key}/xml`). As of
// `@nanobpm/agentic@0.4.0` its `scanTaskDefinitions(xml)` tags every leaf with a
// canonical `agentic: boolean` — true iff the service task declares a
// `<zeebe:linkedResource … linkName="prompt">` base-prompt side-car (its internal
// `hasPromptLink`). That flag is the SINGLE SOURCE OF TRUTH for agentic-ness (see
// the package's `demand/taskdef.d.ts` and nano-workforce SPEC "Agent job
// contract"): every external agent task delivers its base prompt through a
// `linkName="prompt"` linked resource, and no in-process worker task does. Not
// every service task is an agent task — plain connectors and record-keepers
// (e.g. `pr.record-plan`) are ordinary workers, and they carry no prompt link.
//
// Per AGENTS.md "Derivation Over Duplication: No Drift Surfaces", this plugin
// CONSUMES that flag rather than re-implementing the scan, so the detector can
// never drift out of lock-step with the package again (as it did in #95, when a
// local copy keyed on the legacy `io.nanobpm.agentTask` header missed the current
// linked-prompt marker). Advertise the raw job-type string the engine matches
// (`senior:plan`) verbatim — colon-named types are NOT forced through the agentic
// dot-grammar.
// ---------------------------------------------------------------------------

// Scan one deployed BPMN document for its *agent* task-definition leaves: the
// subset of `@nanobpm/agentic` `demand.scanTaskDefinitions(xml)` leaves whose
// canonical `agentic` flag is set (i.e. the service task declares a
// `linkName="prompt"` linked resource). Returns `{ taskType, process }` leaves in
// first-occurrence order. The published `scanTaskDefinitions` is INJECTED so this
// stays a pure, synchronous function; `readDeployedAgentJobTypes` supplies the
// real one from the lazily-imported demand surface (`agentic.mjs`).
function scanAgentTaskLeaves(xml, scanTaskDefinitions) {
  if (typeof scanTaskDefinitions !== 'function') {
    throw new TypeError(
      'scanAgentTaskLeaves: `scanTaskDefinitions` must be an injected function ' +
        `(got ${typeof scanTaskDefinitions}); pass demand.scanTaskDefinitions from ./agentic.mjs`
    );
  }
  return scanTaskDefinitions(String(xml || ''))
    .filter((leaf) => leaf.agentic)
    .map((leaf) => ({ taskType: leaf.taskType, process: leaf.process }));
}

// Read the distinct deployed *agent* job types through a demand C8RestReader
// seam: enumerate the deployed definitions, fetch each one's BPMN XML, scan the
// agent leaves, and return the distinct job types in first-occurrence order. An
// optional `scope` narrows to one app/network — kept only when the leaf's
// `bpmn:process` id equals or is prefixed by the scope string.
async function readDeployedAgentJobTypes(reader, { scope = '' } = {}) {
  const { demand } = await import('./agentic.mjs');
  const keys = await reader.searchProcessDefinitionKeys();
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const xml = await reader.getProcessDefinitionXml(key);
    for (const leaf of scanAgentTaskLeaves(xml, demand.scanTaskDefinitions)) {
      if (scope && !(leaf.process === scope || leaf.process.startsWith(scope))) continue;
      if (seen.has(leaf.taskType)) continue;
      seen.add(leaf.taskType);
      out.push(leaf.taskType);
    }
  }
  return out;
}

// Build the live C8 v2 REST reader from the broker REST config. `httpC8RestReader`
// appends `/process-definitions/...` to its `restAddress`, and the C8 v2 API is
// mounted under `/v2` on the broker (same base the linked-resource fetch uses),
// so the reader's address is `<baseUrl>/v2`. The demand module is imported lazily
// through the single agentic surface (`agentic.mjs`) so the whole agentic module
// graph only loads when `--auto` is actually used.
async function defaultC8RestReader(restConfig) {
  const { demand } = await import('./agentic.mjs');
  const base = String(restConfig?.baseUrl || DEFAULT_NANO_URL).replace(/\/+$/, '');
  return demand.httpC8RestReader({
    restAddress: `${base}/v2`,
    token: restConfig?.token ? restConfig.token : undefined,
  });
}

// Resolve the desired job-type set for `--auto`: all deployed agent job types
// read from the engine, optionally scoped to one process-id/prefix. A test may
// inject an in-memory `readerFactory` to drive it without a live engine. The
// whole read is time-bounded (`timeoutMs`, 0 disables) and a timeout rejects
// with a clear error, so a stalled engine read settles the awaited promise
// (KEEP the running set) instead of wedging the reconcile — and, via shutdown's
// `await inFlightReconcile`, wedging `Ctrl-C`/SIGTERM.
async function resolveAutoJobTypes({ restConfig, scope = '', readerFactory, timeoutMs = AUTO_ENGINE_READ_TIMEOUT_MS } = {}) {
  const read = (async () => {
    const reader = readerFactory ? await readerFactory() : await defaultC8RestReader(restConfig);
    return readDeployedAgentJobTypes(reader, { scope });
  })();
  if (!(timeoutMs > 0)) return read;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`engine read timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Build the content endpoint. Per issue #63 / nano-bpm #759 the non-binary
// `/content` variant is deprecated for non-RPA types (Markdown → 406), so the
// worker always fetches `/content/binary`.
function resourceContentUrl(baseUrl, resourceKey) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/v2/resources/${encodeURIComponent(String(resourceKey))}/content/binary`;
}

// Fetch a linked resource's bytes and decode UTF-8. A non-2xx or network error
// is surfaced as a ProvisionError so the caller fails the job with a clear
// provisioning message (never runs an agent with a silently-empty prompt).
async function fetchLinkedResourceContent(resourceKey, opts = {}) {
  const { baseUrl, token, authHeaders, fetchImpl = fetch, timeoutMs = 15_000 } = opts;
  const url = resourceContentUrl(baseUrl, resourceKey);
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    const headers = { Accept: 'application/octet-stream' };
    // A ready-made auth-headers map (from the activating SDK client's
    // getAuthHeaders(), covering OAuth/basic/none) wins over a bare token. An
    // empty map means unauthenticated — deliberately no Authorization header.
    if (authHeaders && typeof authHeaders === 'object') Object.assign(headers, authHeaders);
    else if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
  } catch (err) {
    throw new ProvisionError(`prompt resource ${resourceKey} fetch failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res || !res.ok) {
    const status = res ? res.status : '?';
    throw new ProvisionError(`prompt resource ${resourceKey} fetch failed: HTTP ${status} from ${url}`);
  }
  try {
    return await res.text();
  } catch (err) {
    throw new ProvisionError(`prompt resource ${resourceKey} decode failed: ${err && err.message ? err.message : String(err)}`);
  }
}

// Resolve the base prompt from a `linkName: prompt` linked resource, if the job
// declares one. Returns `{ basePrompt, resourceKey }` when a prompt resource is
// present and fetched, or null when no such entry exists (→ fall back to the
// header-baked task.prompt chain). Throws a ProvisionError when a declared
// prompt resource cannot be fetched — a provisioning failure, not a silent
// empty-prompt run.
async function resolveLinkedPrompt(customHeaders, opts = {}) {
  const { linkName = DEFAULT_PROMPT_LINK_NAME, baseUrl, token, authHeaders, fetchImpl, timeoutMs } = opts;
  const entry = pickLinkedResource(parseLinkedResources(customHeaders), linkName);
  if (!entry) return null;
  const resourceKey = entry.resourceKey;
  const basePrompt = await fetchLinkedResourceContent(resourceKey, { baseUrl, token, authHeaders, fetchImpl, timeoutMs });
  return { basePrompt, resourceKey, resourceType: entry.resourceType ?? null, linkName: String(linkName) };
}

// Normalize a client-configured REST address for use as a linked-resource fetch
// base. The SDK's restAddress may or may not already include the `/v2` API
// prefix (CAMUNDA_REST_ADDRESS accepts either); resourceContentUrl re-adds it,
// so strip a trailing `/v2` (and any trailing slashes) to avoid a double `/v2`.
function normalizeRestBase(addr) {
  return String(addr || '').replace(/\/+$/, '').replace(/\/v2$/i, '');
}

// The ONE place that answers "what engine base does this worker use?" — the
// single source of truth for the worker's engine-base precedence chain:
//
//   explicit override (NANO_REST_URL → NANO_BASE_URL → persisted cfg.nanoUrl)
//     → active c8ctl profile restAddress (the client that activates jobs)
//     → localhost default (DEFAULT_NANO_URL).
//
// Every worker engine reference derives from this (derivation over duplication):
// the `--auto` job-type read (resolveAutoRestConfig, injecting it into the
// resolveBrokerRestConfig token gate), the linked-prompt fetch
// (resolveLinkedPromptSource), the `supervisor status` engine column
// (workerEngine), and the agentic visibility channel base (resolveAgenticConfig).
// Before this existed the chain was hand-copied at each site and the agentic copy
// silently lost the profile fallback, so a profile-only remote worker degraded to
// its own localhost and never enrolled (jwulf/c8ctl-plugin-nano#107, sibling of
// #93/#99). Sharing this resolver fixes that by construction and removes the
// drift surface. The token same-origin gate stays in resolveBrokerRestConfig,
// never duplicated here.
function resolveWorkerEngineBase(camunda, env = process.env) {
  // readConfig() swallows parse/IO errors and returns {} — never throws.
  const cfg = readConfig() || {};
  const explicit = env.NANO_REST_URL || env.NANO_BASE_URL || cfg.nanoUrl;
  if (explicit) return normalizeRestBase(explicit);
  if (camunda && typeof camunda.getConfig === 'function') {
    try {
      const profileBase = normalizeRestBase(camunda.getConfig()?.restAddress);
      if (profileBase) return profileBase;
    } catch {
      // degrade to the localhost default below rather than throw
    }
  }
  return DEFAULT_NANO_URL;
}

// The engine authority reported in the supervisor activity marker's ENGINE
// column (#99): the base the worker actually POLLS JOBS from. The SDK job worker
// (`camunda.createJobWorker`) activates jobs against the client's OWN profile
// restAddress — which is NOT affected by the explicit NANO_REST_URL / NANO_BASE_URL
// / cfg.nanoUrl overrides that resolveWorkerEngineBase prefers for auxiliary REST
// reads (linked prompts, `--auto` reads, agentic channel). Reporting an override
// there would make the ENGINE column claim an engine the worker is not polling,
// violating supervisorEngineCell's "engine this worker polls jobs from" contract.
// So prefer the profile restAddress (the polling engine) and fall back to the
// canonical resolver only when the client exposes no usable base.
function resolveWorkerPollEngineBase(camunda, env = process.env) {
  if (camunda && typeof camunda.getConfig === 'function') {
    try {
      const profileBase = normalizeRestBase(camunda.getConfig()?.restAddress);
      if (profileBase) return profileBase;
    } catch {
      // degrade to the canonical resolver below rather than throw
    }
  }
  return resolveWorkerEngineBase(camunda, env);
}

// The base URL for a linked-prompt fetch. A linked-resource `resourceKey` is
// BROKER-LOCAL: it lives on the engine the SDK client activated this job against
// — the polling engine (its OWN profile restAddress). So the prompt fetch must
// target that same broker, NOT the NANO_BASE_URL / cfg.nanoUrl auxiliary-read
// overrides that resolveWorkerEngineBase prefers. Those overrides steer reads
// that are NOT broker-local; honoring them here makes the base drift from the
// activation broker so a broker-local resourceKey 404s ("prompt resource N fetch
// failed") even while job activation still succeeds. Precedence:
//
//   explicit NANO_REST_URL  (same-broker escape hatch, e.g. a caching proxy in
//                            front of the polling engine)
//     → polling engine base (resolveWorkerPollEngineBase → profile restAddress)
//     → localhost default.
//
// NANO_REST_URL is retained as an explicit escape hatch, but NANO_BASE_URL /
// cfg.nanoUrl are deliberately NOT — steering the prompt fetch to a different
// engine than the one that issued the broker-local resourceKey is the very bug
// this resolves.
function resolveLinkedPromptBase(camunda, env = process.env) {
  const explicit = env.NANO_REST_URL;
  if (explicit) return normalizeRestBase(explicit);
  return resolveWorkerPollEngineBase(camunda, env);
}

// Derive the linked-resource fetch base URL + auth headers from the SAME SDK
// client that activated the job. A linked-resource `resourceKey` is broker-local,
// so prompt content must be fetched from the broker this worker POLLS jobs from
// (the polling engine — its profile restAddress). The base comes from
// resolveLinkedPromptBase (explicit NANO_REST_URL escape hatch → polling engine
// base → localhost); it deliberately does NOT follow the NANO_BASE_URL /
// cfg.nanoUrl auxiliary-read overrides, since those would point the fetch at an
// engine that never issued this broker-local resourceKey (the cause of "prompt
// resource N fetch failed"). getAuthHeaders() is guarded so an older or atypical
// client runtime degrades to the legacy path rather than throw.
//
// The base URL is invariant for a worker's lifetime, so callers on the per-job
// hot path pass the once-at-startup `resolveLinkedPromptBase` result via
// `baseUrl` to skip the synchronous config.json read (existsSync + readFileSync)
// that this resolver would otherwise repeat on every job; only the auth headers
// (which the client may rotate) are resolved per call. When `baseUrl` is omitted
// it falls back to computing the base itself, so standalone callers and tests
// keep the single-argument behaviour.
//
// TODO: once c8ctl bumps @camunda8/orchestration-cluster-api to v10 (10.0.0-alpha
// exposes the typed camunda.getResourceContentBinary({resourceKey}) → Blob), drop
// this raw /content/binary fetch and call that method directly. The pinned ^9.1.0
// SDK only exposes the deprecated getResourceContent, which 406s for generic
// (Markdown) prompt resources — see camunda/orchestration-cluster-api-js.
async function resolveLinkedPromptSource(camunda, env = process.env, { baseUrl: preResolvedBase } = {}) {
  // The fetch base follows resolveLinkedPromptBase (explicit NANO_REST_URL escape
  // hatch → polling engine base → localhost) so it tracks the broker the job was
  // activated against — the resourceKey is broker-local. A caller-supplied
  // pre-resolved base (already normalized at worker startup) is reused verbatim to
  // avoid a per-job config.json read.
  const baseUrl = preResolvedBase ?? resolveLinkedPromptBase(camunda, env);
  let authHeaders;
  if (env.NANO_REST_TOKEN) {
    authHeaders = { Authorization: `Bearer ${env.NANO_REST_TOKEN}` };
  } else if (camunda && typeof camunda.getAuthHeaders === 'function') {
    try {
      authHeaders = await camunda.getAuthHeaders();
    } catch {
      authHeaders = undefined;
    }
  }
  return { baseUrl, authHeaders };
}

// Secrets are referenced by NAME, never by value, in the model. A resolver maps
// a name → value at run time. The wrapper injects them into the child ENV, so
// values never appear in argv or `docker inspect`.
const hostEnvSecretResolver = {
  kind: 'host',
  resolve(name) {
    const v = process.env[name];
    return v == null || v === '' ? undefined : v;
  },
};

function makeSecretResolver(kind) {
  const k = (kind || 'host').trim().toLowerCase();
  if (k === 'host' || k === '') return hostEnvSecretResolver;
  return null; // unknown → caller reports a clear error
}

// Resolve the names a job needs (setup.secretRefs, plus the repo/PR credential
// when allowPr). Returns resolved values + a list of names that were missing so
// the caller can fail the job with a clear provisioning error.
function resolveJobSecrets(resolver, envelope, { ghAuthToken = ghAuthTokenFromCli } = {}) {
  const names = new Set();
  for (const n of envelope.setup?.secretRefs || []) if (n) names.add(n);
  const resolved = {};
  const missing = [];
  for (const name of names) {
    const v = resolver.resolve(name);
    if (v === undefined) missing.push(name);
    else resolved[name] = v;
  }
  // The github clone/push credential is resolved with a gh-CLI fallback so a
  // default GITHUB_TOKEN isn't reported "missing" merely because it isn't in the
  // env when `gh auth login` provides it. A custom authRef stays strict.
  if (envelope.task?.allowPr) {
    const provider = envelope.repository?.provider || 'github';
    const authRef = envelope.repository?.authRef;
    const ref = normalizeAuthRef(authRef);
    if (ref.kind === 'invalid') {
      // A present-but-blank authRef is a misconfiguration: surface it as missing
      // so provisioning sheds rather than silently borrowing the default/gh token.
      if (!missing.includes('repository.authRef')) missing.push('repository.authRef');
    } else {
      const ghAuthRef = ref.kind === 'custom'
        ? ref.name
        : (provider === 'github' ? 'GITHUB_TOKEN' : undefined);
      if (ghAuthRef) {
        names.add(ghAuthRef);
        const token = githubCloneToken({ provider, authRef, secretResolver: resolver, ghAuthToken });
        const missingIdx = missing.indexOf(ghAuthRef);
        if (token) {
          resolved[ghAuthRef] = token;
          if (missingIdx !== -1) missing.splice(missingIdx, 1);
        } else if (missingIdx === -1) {
          missing.push(ghAuthRef);
        }
      }
    }
  }
  return { resolved, missing, names: [...names] };
}

// ---- Disk hygiene (container sandboxes only) -------------------------------
const CONTAINER_LABEL = 'nano.managed=1';

function containerEngineAvailable(engine) {
  try {
    const r = spawnSync(engine, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Resolve the container engine's data root. Returns null when it can't be
// determined so the caller can fail OPEN (never fall back to an unrelated path
// like the OS temp dir, which would shed on the wrong filesystem's free space).
function dockerRootDir(engine) {
  try {
    const r = spawnSync(engine, ['info', '-f', '{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 10_000 });
    const dir = (r.stdout || '').trim();
    if (r.status === 0 && dir) return dir;
  } catch { /* fall through */ }
  return null;
}

// Fail-open disk-budget check: shed work when free space on the engine's data
// root drops below the configured floor (mirrors nano's admission-shed pattern).
function diskBudgetOk(engine, minFreeBytes) {
  if (!minFreeBytes || minFreeBytes <= 0) return { ok: true, free: null };
  try {
    if (typeof statfsSync !== 'function') return { ok: true, free: null };
    const root = dockerRootDir(engine);
    if (!root) return { ok: true, free: null }; // can't resolve the real root → fail open
    const st = statfsSync(root);
    const free = st.bavail * st.bsize;
    return { ok: free >= minFreeBytes, free };
  } catch {
    return { ok: true, free: null }; // never block work on a stat failure
  }
}

// Reap our own leaked/finished containers. Label-scoped (never touches anything
// we didn't create — safe on shared hosts, NEVER `system prune -a`), age-gated,
// and skips any run id still in flight.
function reapAgentContainers(engine, { maxAgeMs = 0, liveRunIds = new Set() } = {}) {
  let reaped = 0;
  try {
    const fmt = '{{.ID}}\t{{.Label "nano.run"}}\t{{.State}}\t{{.CreatedAt}}';
    const r = spawnSync(engine, ['ps', '-a', '--filter', `label=${CONTAINER_LABEL}`, '--format', fmt], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return { reaped, error: (r.stderr || '').trim() || 'ps failed' };
    const now = Date.now();
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      const [id, run, state, created] = line.split('\t');
      if (run && liveRunIds.has(run)) continue; // in-flight; leave it
      if (!/exited|dead|created/i.test(state || '')) continue; // only finished/stuck
      if (maxAgeMs > 0) {
        const createdMs = Date.parse(created || '');
        if (Number.isFinite(createdMs) && now - createdMs < maxAgeMs) continue;
      }
      const rm = spawnSync(engine, ['rm', '-f', id], { timeout: 15_000 });
      if (rm.status === 0) reaped++;
    }
  } catch (err) {
    return { reaped, error: err.message };
  }
  return { reaped };
}

// ---- Git provisioning (issue #8, increment 2a — host harness) --------------
// A repository-bearing task is provisioned on the HOST: clone into a throwaway
// run dir, check out / create the working branch, run the harness with the
// workspace as CWD, then push the branch + reconcile the agent-opened PR.
// Container-side provisioning (strong isolation) is a later increment.

function agentRunsRoot() {
  return join(getStateHome(), 'agent-runs');
}

// Redact a token that may have been embedded in a URL or surfaced in git output,
// plus any https userinfo (x-access-token:secret@host), before it hits a log or
// the result envelope.
function redactToken(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('***');
  return s.replace(/(https?:\/\/)[^@/\s]+@/gi, '$1');
}

// Build an operator-actionable diagnostic from one or more runGit results.
// git splits its output unpredictably across stdout/stderr, so preferring one
// stream (`stderr || stdout`) can drop the only useful line — the root of the
// "stub reason"/"opaque exit 128" incidents. Combine BOTH streams of every
// command, redact the token, and always append status/signal context (from the
// last, i.e. failing, command) so an empty-output failure still says something.
function gitErrorDetail(results, token, limit = 500) {
  const list = Array.isArray(results) ? results : [results];
  const body = redactToken(
    list
      .flatMap((r) => [r?.stderr, r?.stdout])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .join('\n'),
    token,
  ).trim().slice(0, limit);
  const last = list[list.length - 1] || {};
  const ctx = [];
  if (last.status != null) ctx.push(`exit ${last.status}`);
  if (last.signal) ctx.push(`signal ${last.signal}`);
  const ctxStr = ctx.length ? `(${ctx.join(', ')})` : '';
  return [body, ctxStr].filter(Boolean).join(' ') || 'unknown error';
}

function runGit(args, { cwd, env, timeoutMs = 120_000 } = {}) {
  try {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: timeoutMs });
    // spawnSync does not throw on timeout — it returns with `error.code` set to
    // 'ETIMEDOUT' and the child SIGTERM-killed (signal set, status null). Surface
    // that as `timedOut` so callers can report a timeout instead of an
    // uninformative "exit 128" (ties to #89).
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    // A non-timeout spawn failure (e.g. ENOENT when `git` is missing, EACCES)
    // comes back via `r.error` with empty stdout/stderr; discarding
    // `r.error.message` leaves callers reporting an empty/"unknown error"
    // detail. Fold the spawn error (code + message) into stderr so
    // `gitErrorDetail` still surfaces something actionable.
    let stderr = r.stderr || '';
    if (r.error && !timedOut) {
      const spawnMsg = [r.error.code, r.error.message].filter(Boolean).join(': ');
      stderr = [stderr.trim(), spawnMsg].filter(Boolean).join('\n');
    }
    return { status: r.status ?? (r.signal ? 128 : null), stdout: r.stdout || '', stderr, signal: r.signal || null, timedOut, timeoutMs };
  } catch (err) {
    return { status: null, stdout: '', stderr: err.message, signal: null, timedOut: false, timeoutMs };
  }
}

// Bound a git output string without decapitating it: a hard `.slice(0, max)`
// drops the tail, but the real reason can live at either end of a long
// multiline git error (the `fatal:` up top, wrapping/hint detail below). Keep a
// head+tail window joined by an elision marker so both survive.
function boundGitOutput(text, max = 500) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const marker = ' […] ';
  // When max is too small to fit even the elision marker the head+tail budget
  // goes negative, making the slices behave unexpectedly and return MORE than
  // max — so hard-cap to max (never below zero) in that degenerate case.
  if (max <= marker.length) return s.slice(0, Math.max(0, max));
  const budget = max - marker.length;
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${s.slice(0, head)}${marker}${s.slice(s.length - tail)}`;
}

// Build an informative, token-redacted failure reason from a runGit result.
// Two things the old `stderr || stdout`.slice(0,500) message threw away:
//   1. On a timeout Node SIGTERM-kills git (status→128, signal='SIGTERM') — say
//      so, and after how long, instead of surfacing only git's flushed
//      "Cloning into '…'..." progress line as if it were the failure.
//   2. `stderr || stdout` let a non-empty-but-useless stderr mask a real reason
//      on stdout — capture BOTH streams (stderr then stdout) so either survives.
function describeGitFailure(action, result, { token, timeoutMs } = {}) {
  const combined = boundGitOutput(
    redactToken([result && result.stderr, result && result.stdout].filter(Boolean).join('\n'), token),
  );
  // spawnSync's timeout kill lands as SIGTERM (its default killSignal); runGit
  // maps the null status to 128. Only SIGTERM means "timed out" — any OTHER
  // signal (e.g. SIGKILL from an OOM kill) is a distinct termination that we
  // must not misreport as a timeout.
  const signal = result && result.signal;
  if (signal === 'SIGTERM') {
    const secs = timeoutMs ? Math.round(timeoutMs / 1000) : null;
    const dur = secs ? ` after ${secs}s` : '';
    return `${action} timed out${dur} (SIGTERM)${combined ? `; last output: ${combined}` : ''}`;
  }
  if (signal) {
    return `${action} terminated by signal ${signal}${combined ? `: ${combined}` : ''}`;
  }
  const exit = result && result.status != null ? result.status : '?';
  return `${action} failed (exit ${exit})${combined ? `: ${combined}` : ''}`;
}

// Write a GIT_ASKPASS helper that echoes $GIT_TOKEN, so the token reaches git
// via the child's ENV — never on argv or in the remote URL. Uses a Node helper
// (askpass.js reads GIT_TOKEN and writes it verbatim), launched by a per-OS
// shim: git can't exec a POSIX `.sh` on Windows, and a raw `.cmd` would let
// cmd.exe re-parse token metacharacters (&, |, ^). The shim keeps the token in
// env only and never expands it in a shell.
function writeAskpass(dir, token) {
  if (!token) return null;
  const js = join(dir, 'askpass.js');
  writeFileSync(js, 'process.stdout.write(process.env.GIT_TOKEN || "");\n', { mode: 0o600 });
  // Launch via this process's own Node (process.execPath) rather than bare
  // `node`, which may not be on PATH when Node was invoked by absolute path.
  const node = process.execPath;
  if (process.platform === 'win32') {
    const p = join(dir, 'askpass.cmd');
    writeFileSync(p, `@"${node}" "%~dp0askpass.js"\r\n`, { mode: 0o700 });
    return p;
  }
  const p = join(dir, 'askpass.sh');
  writeFileSync(p, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/askpass.js"\n`, { mode: 0o700 });
  try { chmodSync(p, 0o700); } catch { /* best effort */ }
  return p;
}

// For https URLs, embed a username (no secret) so git asks GIT_ASKPASS for the
// password. Non-https URLs and author-supplied credentials are left untouched.
function authUrl(url, provider, hasToken) {
  if (!hasToken) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return url;
    if (u.username || u.password) return url; // author already embedded creds
    u.username = provider === 'github' ? 'x-access-token' : 'git';
    return u.toString();
  } catch {
    return url;
  }
}

class ProvisionError extends Error {}

// Never let git invoke the host's configured credential helper for our clone/
// push. Reset the helper list ("") so no helper runs — even when we DO have a
// token, because helpers like `store`/keychain would persist the job's repo
// token to disk. GIT_ASKPASS supplies the secret directly, so no helper is
// needed. Combined with GIT_TERMINAL_PROMPT=0 this keeps tokens ephemeral and
// an absent-token clone genuinely anonymous.
function credArgs() {
  return ['-c', 'credential.helper='];
}

// Fall back to the `gh` CLI's stored credential when GITHUB_TOKEN is not exported
// to the env. Most interactive setups authenticate with `gh auth login` (keychain)
// rather than an env var, so an env-only secret resolver yields no token and a
// private/internal clone fails with "could not read Username". Best effort: returns
// a trimmed token, or null when gh is missing / not logged in. The token is fed to
// git via GIT_ASKPASS only (never argv/URL/helper), preserving the ephemeral-token
// guarantee.
// Memoized for the process lifetime: this is a synchronous spawnSync (up to a
// 10s timeout) that can be reached per job, so consult the CLI at most once per
// worker run rather than blocking a handler on every job. A sentinel
// distinguishes "not yet computed" from
// a cached null (gh missing / not logged in).
//
// Memoization alone still lets the *first* job pay the synchronous spawn on the
// event loop, stalling any sibling handlers (and lock-extension heartbeats) for
// up to the timeout. So `nano work` primes this cache once at startup via
// `primeGhAuthToken()` — before the poll loop — moving the one unavoidable
// blocking spawn off the job-handling path entirely. Any later call is a warm
// cache hit; the memoization here is the safety net for paths that never primed.
const GH_AUTH_TOKEN_UNSET = Symbol('gh-auth-token-unset');
let ghAuthTokenCache = GH_AUTH_TOKEN_UNSET;
function ghAuthTokenFromCli() {
  if (ghAuthTokenCache !== GH_AUTH_TOKEN_UNSET) return ghAuthTokenCache;
  let token = null;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
    const tok = r.status === 0 ? (r.stdout || '').trim() : '';
    token = tok || null;
  } catch {
    token = null;
  }
  ghAuthTokenCache = token;
  return token;
}

// Warm the gh-token cache once, off the job-handling path. Safe to call any
// number of times: the first call performs the (possibly blocking) lookup, the
// rest are cache hits. Returns true once the cache is populated.
function primeGhAuthToken() {
  ghAuthTokenFromCli();
  return ghAuthTokenCache !== GH_AUTH_TOKEN_UNSET;
}

// Read the operator's own git identity from their GLOBAL config, using the real
// host environment (process.env) rather than a job's sanitized gitEnv — so it
// resolves even on the anonymous clone path, where gitEnv points
// GIT_CONFIG_GLOBAL at /dev/null. Returns { name, email }, each possibly ''.
function hostGitIdentity() {
  const read = (key) => {
    try {
      const r = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', timeout: 5_000 });
      return r.status === 0 ? (r.stdout || '').trim() : '';
    } catch {
      return '';
    }
  };
  return { name: read('user.name'), email: read('user.email') };
}

// Fall back to the gh-authenticated GitHub user for a committer identity. Uses
// the account's public email, or the id+login noreply address when the email is
// private/unset. Returns { name, email }, each possibly ''.
function ghUserIdentity() {
  try {
    const r = spawnSync('gh', ['api', 'user', '--jq', '[.name // "", .login // "", .email // "", (.id // "" | tostring)] | @tsv'],
      { encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    if (r.status !== 0) return { name: '', email: '' };
    const [name = '', login = '', email = '', id = ''] = (r.stdout || '').trim().split('\t');
    const resolvedName = name || login || '';
    const resolvedEmail = email || (id && login ? `${id}+${login}@users.noreply.github.com` : '');
    return { name: resolvedName, email: resolvedEmail };
  } catch {
    return { name: '', email: '' };
  }
}

// Reject a commit-author email that can't be attributed to a real account and
// can't receive mail — a `*@nano.local` (or other non-routable) placeholder
// injected by the launch environment. Such an address produces UNVERIFIED
// commits that look like a person but map to no GitHub user, so the harness must
// never stamp it onto a commit; it falls through to the next identity source
// instead. An EMPTY email is NOT a placeholder — it is an absent field handled
// by ordinary per-field fallthrough, so it does not invalidate its source.
// Matching is trim + case-insensitive.
function isPlaceholderEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false; // absent — handled by per-field fallthrough, not a placeholder
  const at = e.lastIndexOf('@');
  if (at < 0) return true; // no domain at all — not a routable address
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  // Malformed addresses missing a local part (`@example.com`) or a domain
  // (`user@`) can't be routed or attributed either — reject them too.
  if (!local || !domain) return true;
  // Non-routable mDNS/host-local TLDs and the loopback host: unattributable and
  // undeliverable, so never a legitimate commit author.
  return domain === 'localhost'
    || domain.endsWith('.local')
    || domain.endsWith('.internal');
}

// Coerce one identity source into a usable { name, email }. When the source's
// email is a non-routable placeholder we discard the WHOLE candidate (both
// fields) rather than just the email — otherwise a placeholder-derived name
// (e.g. `trial-merge`) would be stitched onto a borrowed email from a lower
// source, forging a Frankenstein author. An empty email is preserved as-is so
// ordinary per-field fill still works (e.g. git supplies a name, gh the email).
// Fields are trimmed so a whitespace-only/space-padded name or email behaves
// like "absent" (empty) rather than a truthy value that would block per-field
// fallthrough and get stamped as an invalid commit identity — this matches
// isPlaceholderEmail, which already normalizes via trim().
function sanitizeIdentity(id) {
  const name = String((id && id.name) || '').trim();
  const email = String((id && id.email) || '').trim();
  if (isPlaceholderEmail(email)) return { name: '', email: '' };
  return { name, email };
}

// Resolve the committer identity the harness stamps onto the cloned workspace.
// Source precedence: explicit GIT_AUTHOR_* env → the operator's global git
// config → the gh-authenticated GitHub user → the `nano-agent` fallback.
// Precedence is per-field only for ABSENT fields (an empty name/email falls
// through to the next source); a source whose email is a non-routable
// placeholder is discarded WHOLE by sanitizeIdentity (name included), so in that
// case its name does not participate in per-field fill (see sanitizeIdentity).
// Preferring the operator's real identity means autonomous commits are authored
// by the human running the fleet (who has signed any CLA) rather than an
// anonymous bot that hasn't; the agent's own authorship is recorded as a PR
// comment (see postAgentAttribution) instead of forged onto the commit. Both the
// git-config and gh lookups are lazy and performed at most once each, and only
// when a higher-precedence source didn't already supply the field — so explicit
// GIT_AUTHOR_* env fully short-circuits them (no `git config`/`gh` spawns, hence
// no added latency or failure modes when the override is present).
// Every candidate source is passed through sanitizeIdentity, so a non-routable
// `*@nano.local` placeholder from ANY source (env, git-global) is discarded and
// falls through to the gh identity / marked bot fallback — never stamped onto a
// commit. `gitIdentity`/`ghIdentity` are injectable for testing.
function resolveCommitterIdentity({ gitIdentity = hostGitIdentity, ghIdentity = ghUserIdentity } = {}) {
  const env = sanitizeIdentity({ name: process.env.GIT_AUTHOR_NAME || '', email: process.env.GIT_AUTHOR_EMAIL || '' });
  let g = null;
  const gitOnce = () => (g ??= sanitizeIdentity(gitIdentity() || {}));
  let gh = null;
  const ghOnce = () => (gh ??= sanitizeIdentity(ghIdentity() || {}));

  const name = env.name || gitOnce().name || ghOnce().name || 'nano-agent';
  const email = env.email || gitOnce().email || ghOnce().email || 'nano-agent@users.noreply.github.com';

  const source =
    (env.name || env.email) ? 'env'
      : (g && (g.name || g.email)) ? 'git-global'
        : (gh && (gh.name || gh.email)) ? 'gh'
          : 'fallback';
  return { name, email, source };
}

// Normalize a repository authRef into one of three intents. Trimming matters so
// a present-but-blank authRef ('' or whitespace) is treated as a misconfiguration
// rather than "absent": absence enables the default/gh fallback, but a blank
// custom ref must NOT silently borrow the operator's gh login.
//   { kind: 'default' }        no custom authRef configured (undefined/null)
//   { kind: 'custom', name }   a non-empty custom authRef (strict)
//   { kind: 'invalid' }        authRef present but blank (config error)
function normalizeAuthRef(authRef) {
  if (authRef === undefined || authRef === null) return { kind: 'default' };
  const trimmed = String(authRef).trim();
  if (trimmed === '') return { kind: 'invalid' };
  return { kind: 'custom', name: trimmed };
}

// Resolve the github clone/push credential. The default credential (env
// GITHUB_TOKEN) falls back to the gh CLI's stored token so `gh auth login`
// setups work without exporting GITHUB_TOKEN. A custom `authRef` is honored
// strictly (env/secret resolver only, no gh fallback) so a misconfigured named
// secret surfaces as missing rather than silently borrowing the operator's gh
// login. An authRef that is present but blank is a misconfiguration and yields no
// token (never the gh fallback). `ghAuthToken` is injectable for testing.
// Returns a token or null.
function githubCloneToken({ provider, authRef, secretResolver, ghAuthToken = ghAuthTokenFromCli }) {
  const prov = provider || 'github';
  const ref = normalizeAuthRef(authRef);
  if (ref.kind === 'invalid') return null;
  const usesDefault = prov === 'github' && ref.kind === 'default';
  const name = ref.kind === 'custom' ? ref.name : (prov === 'github' ? 'GITHUB_TOKEN' : null);
  let token = name ? (secretResolver.resolve(name) || null) : null;
  if (!token && usesDefault) token = ghAuthToken() || null;
  return token;
}

// Clone repo into <runDir>/workspace and check out / create the working branch.
// Returns { workspaceDir, gitEnv, startSha, workingBranch, remote }. Throws a
// ProvisionError (token-redacted) on any git failure so the caller can shed.
function provisionRepo({ envelope, token, runDir, timeoutMs = 120_000 }) {
  const repo = envelope.repository;
  if (!repo || !repo.url) throw new ProvisionError('repository.url is required to provision a workspace');
  const workspaceDir = join(runDir, 'workspace');
  const askpass = writeAskpass(runDir, token);
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  // Drop any inherited askpass helpers so a no-token ("anonymous") clone can't
  // authenticate with host-provided credentials. We re-set GIT_ASKPASS below
  // only when we minted our own token-backed helper.
  delete gitEnv.GIT_ASKPASS;
  delete gitEnv.SSH_ASKPASS;
  if (askpass) {
    gitEnv.GIT_ASKPASS = askpass;
    gitEnv.GIT_TOKEN = token;
  } else {
    // No token ⇒ honor the documented "anonymous" guarantee strictly: neutralize
    // the user's global git config too, so knobs like http.<url>.extraHeader
    // (added by `gh auth setup-git`) or url.<...>.insteadOf can't silently inject
    // operator credentials. Only done on the anonymous path — token-backed jobs
    // keep global config (e.g. http.proxy for reaching the remote).
    gitEnv.GIT_CONFIG_GLOBAL = devNull;
  }

  const branchName = repo.ref || envelope.branch?.base || '';
  // A raw commit is requested ONLY via the dedicated `repository.sha` field —
  // the sole unambiguous way to pin a commit. `ref` (→ `branchName`) is ALWAYS a
  // branch/tag name and is passed to `git clone --branch`; there is no hex
  // heuristic, so a legitimately hex-named branch like `deadbeef` is cloned as a
  // branch, not misread as a SHA. When a `sha` is given we clone `branchName`
  // (if any — the branch that should contain it) then fetch + detach onto it.
  const commitSha = repo.sha || '';
  // `sha` pins a raw commit and is passed to `git fetch origin <sha>` /
  // `git checkout --detach <sha>`. Validate it is a hex commit id (7–40 chars)
  // before use: this fails a misconfigured envelope fast and, because a hex id
  // can never start with `-`, forecloses a value being (mis)parsed as a git
  // option.
  if (commitSha && !/^[0-9a-f]{7,40}$/i.test(commitSha)) {
    throw new ProvisionError(`invalid repository.sha ${JSON.stringify(commitSha)} — expected a hex commit id (7–40 chars)`);
  }
  const isSha = !!commitSha;
  // Per-envelope timeout override (backstop for giant monorepos that approach the
  // default cap even when shallow); falls back to the caller-supplied timeout.
  const effectiveTimeoutMs = (repo.cloneTimeoutMs && repo.cloneTimeoutMs > 0) ? repo.cloneTimeoutMs : timeoutMs;
  const cloneArgs = [...credArgs(), 'clone', '--no-tags'];
  if (repo.depth && repo.depth > 0) cloneArgs.push('--depth', String(repo.depth));
  // `--single-branch` restricts the fetch to just `ref` — a plain `clone --branch`
  // still downloads every branch and all history. `--depth` implies this, but
  // honor it independently for a full-history single-branch clone.
  if (repo.singleBranch) cloneArgs.push('--single-branch');
  // Partial (blob-filtered) clone: full commit graph, lazy blobs — best fit for
  // reviewing a PR on a monorepo where a full checkout blows the timeout.
  if (repo.filter) cloneArgs.push(`--filter=${repo.filter}`);
  if (repo.submodules) cloneArgs.push('--recurse-submodules');
  if (branchName) cloneArgs.push('--branch', branchName);
  const remote = authUrl(repo.url, repo.provider || 'github', !!token);
  cloneArgs.push(remote, workspaceDir);

  const clone = runGit(cloneArgs, { env: gitEnv, timeoutMs: effectiveTimeoutMs });
  if (clone.status !== 0) {
    if (clone.timedOut) {
      // Preserve whatever git managed to print before SIGTERM (plus exit/signal
      // context) so a timeout is still diagnosable, not an opaque wall-clock hit.
      const detail = gitErrorDetail(clone, token);
      const detailNote = detail && detail !== 'unknown error' ? ` — last git output: ${detail}` : '';
      throw new ProvisionError(`git clone timed out after ${effectiveTimeoutMs}ms — the repo may be too large, or the network stalled; raise the timeout (repository.cloneTimeoutMs in the envelope, or the worker's --clone-timeout flag) or scope the clone with filter/singleBranch/depth${detailNote}`);
    }
    throw new ProvisionError(`git clone failed: ${gitErrorDetail(clone, token)}`);
  }

  if (isSha) {
    // The SHA may not be present under a shallow clone of the branch — fetch it
    // explicitly (best effort), then check it out (detached HEAD).
    const fetch = runGit([...credArgs(), 'fetch', '--no-tags', 'origin', commitSha], { cwd: workspaceDir, env: gitEnv, timeoutMs: effectiveTimeoutMs });
    const co = runGit(['checkout', '--detach', commitSha], { cwd: workspaceDir, env: gitEnv });
    if (co.status !== 0) {
      // Combine the fetch + checkout output (the real reason often lives in the
      // fetch), and annotate a fetch timeout explicitly so a slow `git fetch
      // origin <sha>` is not misread as an opaque checkout failure.
      const fetchNote = fetch.timedOut ? ` (preceding git fetch origin ${commitSha} timed out after ${effectiveTimeoutMs}ms)` : '';
      throw new ProvisionError(`git checkout ${commitSha} failed: ${gitErrorDetail([fetch, co], token, 300)}${fetchNote}`);
    }
  }

  // Optional base fetch: with a single-branch/shallow clone the head has no base
  // and no merge-base, so a naive `git diff <base>` fails. When a base branch or
  // sha is supplied, fetch it (respecting depth/filter) into a remote-tracking
  // ref so the harness can compute `git diff origin/<base>...HEAD`. Best-effort:
  // a failed base fetch is recorded, not fatal (the head clone still succeeded).
  let base = '';
  let baseFetchError;
  // `baseRef` (branch/tag) and `baseSha` (raw commit) are mutually exclusive — a
  // caller picks one. If BOTH are set the envelope is ambiguous, so rather than
  // silently preferring one (a surprising `base...head` diff), skip the base
  // fetch and record a non-fatal diagnostic so the misconfiguration is visible.
  if (repo.baseSha && repo.baseRef) {
    baseFetchError = `ambiguous base: both baseRef (${repo.baseRef}) and baseSha (${repo.baseSha}) set — provide only one`;
  } else {
    const baseTarget = repo.baseSha || repo.baseRef;
    if (baseTarget) {
      const isBaseSha = !!repo.baseSha;
      const fetchArgs = [...credArgs(), 'fetch', '--no-tags'];
      if (repo.depth && repo.depth > 0) fetchArgs.push('--depth', String(repo.depth));
      if (repo.filter) fetchArgs.push(`--filter=${repo.filter}`);
      if (isBaseSha) {
        // A raw sha can't be mapped to a stable name — fetch it (updates FETCH_HEAD)
        // and expose the sha itself as the diff base.
        fetchArgs.push('origin', baseTarget);
        base = baseTarget;
      } else {
        // Map the branch onto refs/remotes/origin/<baseRef> so `origin/<base>`
        // resolves for the reviewer even on a single-branch clone.
        fetchArgs.push('origin', `+${baseTarget}:refs/remotes/origin/${baseTarget}`);
        base = `origin/${baseTarget}`;
      }
      const bf = runGit(fetchArgs, { cwd: workspaceDir, env: gitEnv, timeoutMs: effectiveTimeoutMs });
      if (bf.status !== 0) {
        // Name the base target (branch vs sha) so the warning is actionable when
        // multiple refs are in play, and preserve git's output/context in both the
        // timeout and non-timeout paths.
        const baseLabel = `${isBaseSha ? 'sha' : 'branch'} ${baseTarget}`;
        base = '';
        baseFetchError = bf.timedOut
          ? `base fetch (${baseLabel}) timed out after ${effectiveTimeoutMs}ms: ${gitErrorDetail(bf, token, 300)}`
          : `base fetch (${baseLabel}) failed: ${gitErrorDetail(bf, token, 300)}`;
      }
    }
  }

  // Give the harness a committer identity in case it commits (many do). Prefer
  // the operator's real identity (git global / gh user) over the `nano-agent`
  // fallback so autonomous commits are authored by the human running the fleet —
  // who has signed any CLA — instead of an anonymous bot. The agent's authorship
  // is instead recorded as a PR comment (postAgentAttribution). Set via repo-
  // level config, which overrides global, so the identity is deterministic.
  const committer = resolveCommitterIdentity();
  runGit(['config', 'user.name', committer.name], { cwd: workspaceDir, env: gitEnv });
  runGit(['config', 'user.email', committer.email], { cwd: workspaceDir, env: gitEnv });
  // Config alone is not enough: git honours GIT_AUTHOR_*/GIT_COMMITTER_* OVER
  // user.name/user.email config, so a placeholder GIT_AUTHOR_EMAIL inherited from
  // the launch environment (e.g. `trial-merge@nano.local`) would still be stamped
  // onto commits even though we just wrote a clean identity into config. Pin all
  // four env vars to the resolved (already placeholder-sanitized) identity so
  // EVERY commit — finalizeGit's own rebase commits (which run with gitEnv) and
  // the harness's commits (extraEnv below carries these into harnessEnv) — uses
  // it deterministically, and a non-routable `*@nano.local` author can never be
  // written. When GIT_AUTHOR_* already held a real identity, resolveCommitterIdentity
  // returned it verbatim, so this is a no-op in that case.
  gitEnv.GIT_AUTHOR_NAME = committer.name;
  gitEnv.GIT_AUTHOR_EMAIL = committer.email;
  gitEnv.GIT_COMMITTER_NAME = committer.name;
  gitEnv.GIT_COMMITTER_EMAIL = committer.email;

  // Determine the working branch. With branch.create we make a real branch.
  // Otherwise we're on whatever the clone checked out: a branch only if
  // rev-parse resolves a symbolic name — a tag/sha leaves detached HEAD, in
  // which case there is NO branch to push and workingBranch stays null so
  // finalizeGit skips the push/PR reconcile instead of pushing a bogus ref.
  let workingBranch = null;
  if (envelope.branch?.create) {
    const cb = runGit(['checkout', '-B', envelope.branch.create], { cwd: workspaceDir, env: gitEnv, timeoutMs });
    if (cb.status !== 0) throw new ProvisionError(describeGitFailure(`git checkout -B ${envelope.branch.create}`, cb, { token, timeoutMs }));
    workingBranch = envelope.branch.create;
  } else {
    const head = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceDir, env: gitEnv });
    const name = (head.stdout || '').trim();
    workingBranch = (name && name !== 'HEAD') ? name : null; // null ⇒ detached HEAD
  }
  const sha = runGit(['rev-parse', 'HEAD'], { cwd: workspaceDir, env: gitEnv });
  // `git rev-parse HEAD` on an unborn branch (freshly cloned empty repo) exits
  // non-zero and echoes the literal "HEAD" on stdout — treat that as "no base
  // commit" (empty startSha) rather than a bogus revision.
  return { workspaceDir, gitEnv, committer, startSha: sha.status === 0 ? (sha.stdout || '').trim() : '', workingBranch, detached: !workingBranch, ref: commitSha || branchName || '', base, baseFetchError, remote: redactToken(repo.url, token) };
}

// Look up a PR for this branch (2a does NOT open it — the harness does, driven
// by the prompt). Uses gh with the resolved token so it works headless. Reports
// the PR's ACTUAL author login in `openedBy` (null when unknown/not found) —
// gh returns whatever PR is open for the head branch, which may not be ours.
function reconcileAgentPr({ workspaceDir, token, branch, provider }) {
  if (provider && provider !== 'github') return { openedBy: null, found: false, error: `PR reconcile unsupported for provider "${provider}"` };
  const env = ghAuthEnv(token, workspaceDir);
  try {
    const r = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,isDraft,title,author', '--limit', '1'],
      { cwd: workspaceDir, env, encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { openedBy: null, found: false, error: `gh not runnable: ${redactToken(r.error.message, token).trim().slice(0, 200)}` };
    if (r.status !== 0) return { openedBy: null, found: false, error: redactToken(r.stderr, token).trim().slice(0, 200) || `gh pr list failed (exit ${r.status ?? 'null'}${r.signal ? `, signal ${r.signal}` : ''})` };
    const arr = JSON.parse((r.stdout || '[]').trim() || '[]');
    if (!Array.isArray(arr) || arr.length === 0) return { openedBy: null, found: false };
    const pr = arr[0];
    return { openedBy: pr.author?.login || null, found: true, number: pr.number, url: pr.url, state: pr.state, isDraft: !!pr.isDraft, title: pr.title };
  } catch (err) {
    return { openedBy: null, found: false, error: err.message };
  }
}

// Build the gh environment for PR-side calls: inject the resolved job token, or
// (anonymous path) scrub every ambient gh credential so we can only use what we
// were explicitly handed. Scrubbing the token env vars alone is not enough — gh
// will still authenticate from its on-disk config (hosts.yml / OS keychain), so
// in the anonymous path we also point gh at a private, empty GH_CONFIG_DIR
// (created inside the harness-reaped workspace) and disable interactive prompts,
// guaranteeing a token-less job cannot act as the operator via stored creds.
function ghAuthEnv(token, workspaceDir) {
  const env = { ...process.env };
  // These apply on every path: workers are non-interactive, so gh must fail
  // fast rather than block on an auth/update prompt — even a provided token can
  // be invalid/expired, in which case gh would otherwise try to prompt.
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  if (token) {
    env.GH_TOKEN = token;
    return env;
  }
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
  // Fail closed: always point gh at an isolated (empty) config dir so it can
  // never fall back to the operator's on-disk config/keychain. Set GH_CONFIG_DIR
  // unconditionally — even if mkdirSync fails, gh reading a missing/empty dir
  // errors out rather than silently authenticating as the operator, preserving
  // the "token-less job cannot act as the operator" guarantee.
  const dir = join(workspaceDir || tmpdir(), '.nano-gh-anon');
  env.GH_CONFIG_DIR = dir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory couldn't be created; GH_CONFIG_DIR still points at it so gh
    // fails closed rather than using ambient operator credentials.
  }
  return env;
}

// The agent whose authorship we record on the PR. Because commits are now
// authored under the operator's own identity (so they satisfy CLA/DCO), this
// comment preserves the provenance that the change was machine-generated.
const AGENT_ATTRIBUTION_NAME = process.env.NANO_AGENT_NAME || 'nano-agent';
const ATTRIBUTION_MARKER = '<!-- nano-agent-attribution -->';

// Post a one-time attribution comment on the agent-opened PR, recording that the
// change was produced by the autonomous agent even though the commits carry the
// operator's identity. Idempotent via a hidden marker so convergence's repeated
// rounds don't spam the thread. Gated off with NANO_AGENT_ATTRIBUTION=0. Best
// effort: never throws; returns a small status object.
function postAgentAttribution({ workspaceDir, token, number, agentName = AGENT_ATTRIBUTION_NAME }) {
  if (!coerceBool(process.env.NANO_AGENT_ATTRIBUTION, true)) return { posted: false, reason: 'disabled' };
  if (!number) return { posted: false, reason: 'no-pr' };
  const env = ghAuthEnv(token, workspaceDir);
  try {
    // Ask jq for a single boolean ("marker present?") rather than streaming every
    // comment body back through stdout. On PRs with many/large comments the full
    // dump can be slow and can exceed spawnSync's output buffer (maxBuffer),
    // surfacing as existing.error and wedging attribution forever; a lone
    // true/false keeps output tiny while preserving idempotency.
    const markerFilter = `any((.comments // [])[].body; contains(${JSON.stringify(ATTRIBUTION_MARKER)}))`;
    const existing = spawnSync('gh', ['pr', 'view', String(number), '--json', 'comments', '--jq', markerFilter],
      { cwd: workspaceDir, env, encoding: 'utf8', timeout: 30_000 });
    // Idempotency hinges on reliably reading the existing comments: if we cannot
    // verify whether the marker is already present (transient gh failure — rate
    // limit, auth glitch, timeout), do NOT post. Posting blind would let repeated
    // convergence rounds spam duplicate attribution comments. Bail out instead.
    if (existing.error) {
      return { posted: false, error: `gh not runnable: ${redactToken(existing.error.message, token).trim().slice(0, 200)}` };
    }
    if (existing.status !== 0) {
      return { posted: false, error: redactToken(existing.stderr || existing.stdout, token).trim().slice(0, 200) || `gh pr view failed (exit ${existing.status ?? 'null'}${existing.signal ? `, signal ${existing.signal}` : ''})` };
    }
    if ((existing.stdout || '').trim() === 'true') {
      return { posted: false, reason: 'exists' };
    }
    const body = `${ATTRIBUTION_MARKER}\n`
      + `🤖 The changes in this PR were produced by **${agentName}**, an autonomous agent. `
      + `Commits are authored under the operator's own git identity when one is resolvable (the human running the fleet), so they can satisfy CLA/DCO requirements; `
      + `this note records that the work was generated by the agent.`;
    const r = spawnSync('gh', ['pr', 'comment', String(number), '--body', body],
      { cwd: workspaceDir, env, encoding: 'utf8', timeout: 30_000 });
    if (r.error) {
      return { posted: false, error: `gh not runnable: ${redactToken(r.error.message, token).trim().slice(0, 200)}` };
    }
    if (r.status !== 0) {
      return { posted: false, error: redactToken(r.stderr || r.stdout, token).trim().slice(0, 200) || `gh pr comment failed (exit ${r.status ?? 'null'}${r.signal ? `, signal ${r.signal}` : ''})` };
    }
    return { posted: true };
  } catch (err) {
    return { posted: false, error: err.message };
  }
}

// After the harness runs: enumerate new commits, push the branch (when
// branch.push), and reconcile the agent-opened PR (when task.allowPr). A push
// failure is reported (pushError) rather than thrown — the process model decides
// what to do next, and re-running the agent would be non-idempotent.
function finalizeGit({ workspaceDir, gitEnv, startSha, workingBranch, envelope, token }) {
  const out = { branch: workingBranch, baseSha: startSha || null, headSha: null, commits: [], pushed: false, remote: null, pr: null };
  const rem = runGit(['remote', 'get-url', 'origin'], { cwd: workspaceDir, env: gitEnv });
  if (rem.status === 0) out.remote = redactToken(rem.stdout.trim(), token);
  const headNow = runGit(['rev-parse', 'HEAD'], { cwd: workspaceDir, env: gitEnv });
  out.headSha = headNow.status === 0 ? ((headNow.stdout || '').trim() || null) : null;
  if (startSha) {
    const log = runGit(['rev-list', `${startSha}..HEAD`], { cwd: workspaceDir, env: gitEnv });
    if (log.status === 0) out.commits = log.stdout.trim().split('\n').filter(Boolean);
  } else if (out.headSha) {
    // Empty-repo case: provisionRepo found no initial commit (unborn branch), so
    // there is no base to diff against — every commit now on HEAD is new. Without
    // this, a harness that makes the repo's first commit would enumerate as "0
    // commits" and the branch would never be pushed.
    const log = runGit(['rev-list', 'HEAD'], { cwd: workspaceDir, env: gitEnv });
    if (log.status === 0) out.commits = log.stdout.trim().split('\n').filter(Boolean);
  }

  if (!workingBranch) {
    out.detached = true; // clone landed on a tag/sha ⇒ no branch to push
  } else if (coerceBool(envelope.branch?.push, true) && out.commits.length > 0) {
    const pushTimeoutMs = 120_000; // matches runGit's default; surfaced in a timeout reason
    const push = runGit([...credArgs(), 'push', '--set-upstream', 'origin', workingBranch], { cwd: workspaceDir, env: gitEnv, timeoutMs: pushTimeoutMs });
    if (push.status === 0) out.pushed = true;
    else out.pushError = describeGitFailure('git push', push, { token, timeoutMs: pushTimeoutMs });
  }

  if (workingBranch && envelope.task?.allowPr) {
    out.pr = reconcileAgentPr({ workspaceDir, token, branch: workingBranch, provider: envelope.repository?.provider || 'github' });
    // Record the agent's authorship on the PR (commits carry the operator's
    // identity now, so this preserves the machine-generated provenance).
    if (out.pr?.found && out.pr.number && (envelope.repository?.provider || 'github') === 'github') {
      out.attribution = postAgentAttribution({ workspaceDir, token, number: out.pr.number });
    }
  }
  return out;
}

// Reap leftover job workspaces under the runs root. Age-gated, skips in-flight
// run dirs, best-effort, bounded to our own directory (never touches anything we
// did not create).
function reapAgentRunDirs({ maxAgeMs = 0, liveRunDirs = new Set() } = {}) {
  let reaped = 0;
  const root = agentRunsRoot();
  try {
    if (!existsSync(root)) return { reaped };
    const now = Date.now();
    for (const name of readdirSync(root)) {
      // Only reap the throwaway dirs this worker creates under agent-runs: the
      // `run-*` job workspaces and the `res-*` structured-result dirs (see the
      // `mkdtempSync(...)` calls in workAgent). Never touch unrelated files/dirs
      // an operator may have placed under agent-runs.
      if (!name.startsWith('run-') && !name.startsWith('res-')) continue;
      const p = join(root, name);
      if (liveRunDirs.has(p)) continue;
      try {
        const st = lstatSync(p);
        if (!st.isDirectory()) continue; // lstat: a symlink is not a dir ⇒ skipped, never followed
        if (maxAgeMs > 0 && now - st.mtimeMs < maxAgeMs) continue;
        rmSync(p, { recursive: true, force: true });
        reaped++;
      } catch { /* skip */ }
    }
  } catch (err) {
    return { reaped, error: err.message };
  }
  return { reaped };
}

// ---- One-shot capture (shared by host + container executors) ---------------
const MAX_CAPTURE_BYTES = 1_048_576; // 1 MiB per stream

// Spawn a child, pipe `stdinData`, capture byte-capped stdout/stderr, enforce a
// timeout (invoking `onTimeout(child)` to tear the child down), and resolve to a
// uniform result. Used by both the host and container executors.
function spawnCaptureOneShot({ command, args = [], shell = false, detached = false, cwd, env, stdinData, timeoutMs, idleTimeoutMs, onTimeout, stream = false, streamPrefix = '', onStreamOut, onStreamErr, relayTap = null }) {
  return new Promise((resolve) => {
    let child;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timer = null;
    let idleTimer = null;

    // Live "spy" tee (--stream): mirror the child's output line-by-line to a
    // caller-supplied emitter (the worker routes these through c8ctl's
    // output-mode-aware logger so streaming never corrupts a structured/JSON
    // output mode; falling back to a raw console write only when none is given).
    // Each complete line is tagged with the job prefix so interleaved jobs stay
    // legible. A per-stream buffer holds partial lines across chunk boundaries;
    // it is force-flushed once it exceeds STREAM_TEE_LINE_CAP so a newline-less
    // torrent (progress bars, binary output) can't grow it without bound.
    const STREAM_TEE_LINE_CAP = 64 * 1024;
    const makeTee = (emit) => {
      if (!stream) return null;
      const sink = emit || ((line) => process.stdout.write(`${line}\n`));
      let partial = '';
      const flush = (text, final) => {
        partial += text;
        let nl;
        while ((nl = partial.indexOf('\n')) !== -1) {
          sink(`${streamPrefix}${partial.slice(0, nl)}`);
          partial = partial.slice(nl + 1);
        }
        while (partial.length >= STREAM_TEE_LINE_CAP) {
          sink(`${streamPrefix}${partial.slice(0, STREAM_TEE_LINE_CAP)}`);
          partial = partial.slice(STREAM_TEE_LINE_CAP);
        }
        if (final && partial) { sink(`${streamPrefix}${partial}`); partial = ''; }
      };
      return flush;
    };
    const teeOut = makeTee(onStreamOut);
    const teeErr = makeTee(onStreamErr || onStreamOut);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (teeOut) teeOut('', true);
      if (teeErr) teeErr('', true);
      resolve(result);
    };

    try {
      child = spawn(command, args, { shell, detached, cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (err) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: err.message, truncated: false, stderrTruncated: false });
      return;
    }

    timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          try { if (onTimeout) onTimeout(child); } catch { /* best effort */ }
          finish({ ok: false, exitCode: null, stdout: joinCapped(stdoutChunks), stderr: joinCapped(stderrChunks), error: `timed out after ${timeoutMs}ms`, timedOut: true, truncated: stdoutTruncated, stderrTruncated });
        }, timeoutMs)
      : null;

    // Idle-liveness kill: if the child emits no stdout/stderr for `idleTimeoutMs`,
    // treat it as wedged and kill the tree. This is the liveness signal the
    // worker's lock-extender relies on — a silent hang stops producing output, we
    // kill it here, `runAgentJob` resolves, and the worker fails the job
    // (retryable) so the broker reclaims it. Distinct from the absolute `timeoutMs`
    // hard cap: this fires on *silence*, not total runtime. Re-armed on every chunk.
    const armIdle = () => {
      if (settled) return;
      if (!(idleTimeoutMs && idleTimeoutMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { if (onTimeout) onTimeout(child); } catch { /* best effort */ }
        finish({ ok: false, exitCode: null, stdout: joinCapped(stdoutChunks), stderr: joinCapped(stderrChunks), error: `no output for ${idleTimeoutMs}ms (idle)`, timedOut: true, idle: true, truncated: stdoutTruncated, stderrTruncated });
      }, idleTimeoutMs);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (teeOut) teeOut(buf.toString('utf8'), false);
      if (relayTap && typeof relayTap.onData === 'function') relayTap.onData(buf);
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      if (remaining <= 0) { stdoutTruncated = true; return; }
      if (buf.length > remaining) { stdoutChunks.push(buf.subarray(0, remaining)); stdoutBytes = MAX_CAPTURE_BYTES; stdoutTruncated = true; }
      else { stdoutChunks.push(buf); stdoutBytes += buf.length; }
    });
    child.stderr.on('data', (d) => {
      armIdle();
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (teeErr) teeErr(buf.toString('utf8'), false);
      if (relayTap && typeof relayTap.onData === 'function') relayTap.onData(buf);
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (remaining <= 0) { stderrTruncated = true; return; }
      if (buf.length > remaining) { stderrChunks.push(buf.subarray(0, remaining)); stderrBytes = MAX_CAPTURE_BYTES; stderrTruncated = true; }
      else { stderrChunks.push(buf); stderrBytes += buf.length; }
    });

    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, stdout: joinCapped(stdoutChunks), stderr: joinCapped(stderrChunks), error: err.message, truncated: stdoutTruncated, stderrTruncated });
    });
    child.on('close', (code, signal) => {
      finish({ ok: code === 0, exitCode: code, signal: signal ?? null, stdout: joinCapped(stdoutChunks), stderr: joinCapped(stderrChunks), truncated: stdoutTruncated, stderrTruncated });
    });

    child.stdin.on('error', () => {});
    // C3 (#42): pipe mode is one-shot — the job is written to stdin which is then
    // closed (below), so there is no open channel to feed later steer-in frames
    // into. We therefore do NOT attach steer-in here: steer-in requires a PTY
    // (see spawnCapturePty), where stdin stays open for the life of the child.
    // Pipe-mode roles still stream their output on the relay lane via the tee.
    try {
      if (stdinData != null) child.stdin.write(stdinData);
      child.stdin.end();
    } catch { /* 'error' handler resolves on failure */ }
  });
}

// ---- PTY capture (C3 #42 — full terminal for roles opted into `terminal: pty`)
// node-pty is a NATIVE, OPTIONAL dependency: a role that runs its harness on a
// real PTY needs it, but the vast majority of workers run on plain pipes, and we
// must never let a missing/failed native build break `npm install` or the test
// suite on stock Node. It is therefore an optionalDependency, lazily required
// only when a PTY role actually runs, and memoized. Returns null when it is not
// installed so the caller can fall back to a pipe.
let ptyModuleCache; // undefined = not tried; null = unavailable; object = loaded
function loadPtyModule() {
  if (ptyModuleCache !== undefined) return ptyModuleCache;
  try {
    ptyModuleCache = requireFromHere('node-pty');
  } catch {
    ptyModuleCache = null;
  }
  return ptyModuleCache;
}

/**
 * Whether a real PTY can be allocated on this host: node-pty is installed AND we
 * are on a POSIX platform (the PTY path spawns `sh -c <commandLine>`, mirroring
 * the container executor; Windows conpty is out of scope for this slice).
 */
function ptyAvailable(ptyFactory) {
  if (process.platform === 'win32') return false;
  // An injected factory only counts if it actually looks like a node-pty
  // factory (has a spawn()); a bad injection degrades to the pipe fallback
  // rather than routing to the PTY path and failing the job.
  if (ptyFactory) return typeof ptyFactory.spawn === 'function';
  return loadPtyModule() != null;
}

// Spawn the harness on a PTY, capture byte-capped output for the job result,
// tee every chunk to the relay tap (framed + jobKey-tagged by the caller), and
// feed steer-in bytes back into the PTY. Same result contract as
// spawnCaptureOneShot. A PTY merges stdout+stderr into one stream, so stderr is
// always '' here; that is expected for a live terminal. `ptyFactory` is
// injectable for tests (defaults to node-pty).
function spawnCapturePty({ command, args = [], cwd, env, stdinData, timeoutMs, idleTimeoutMs, cols = 120, rows = 30, ptyFactory, relayTap = null, stream = false, streamPrefix = '', onStreamOut }) {
  return new Promise((resolve) => {
    const factory = ptyFactory || loadPtyModule();
    if (!factory || typeof factory.spawn !== 'function') {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: 'node-pty is not available; cannot allocate a PTY (install node-pty or use terminal: pipe)', truncated: false, stderrTruncated: false });
      return;
    }

    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timer = null;
    let idleTimer = null;
    let detachSteer = null;
    let term;

    // Live "spy" tee (--stream), line-buffered, mirroring spawnCaptureOneShot.
    const STREAM_TEE_LINE_CAP = 64 * 1024;
    let teePartial = '';
    const teeSink = stream ? (onStreamOut || ((line) => process.stdout.write(`${line}\n`))) : null;
    const tee = (text, final) => {
      if (!teeSink) return;
      teePartial += text;
      let nl;
      while ((nl = teePartial.indexOf('\n')) !== -1) {
        teeSink(`${streamPrefix}${teePartial.slice(0, nl)}`);
        teePartial = teePartial.slice(nl + 1);
      }
      while (teePartial.length >= STREAM_TEE_LINE_CAP) {
        teeSink(`${streamPrefix}${teePartial.slice(0, STREAM_TEE_LINE_CAP)}`);
        teePartial = teePartial.slice(STREAM_TEE_LINE_CAP);
      }
      if (final && teePartial) { teeSink(`${streamPrefix}${teePartial}`); teePartial = ''; }
    };

    const killTerm = () => {
      try { term?.kill(); } catch { /* already gone */ }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (detachSteer) { try { detachSteer(); } catch { /* best effort */ } detachSteer = null; }
      if (teeSink) tee('', true);
      resolve(result);
    };

    try {
      term = factory.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env });
    } catch (err) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: `pty spawn failed: ${err?.message || err}`, truncated: false, stderrTruncated: false });
      return;
    }

    timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          killTerm();
          finish({ ok: false, exitCode: null, stdout: joinCapped(chunks), stderr: '', error: `timed out after ${timeoutMs}ms`, timedOut: true, truncated, stderrTruncated: false });
        }, timeoutMs)
      : null;

    const armIdle = () => {
      if (settled) return;
      if (!(idleTimeoutMs && idleTimeoutMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killTerm();
        finish({ ok: false, exitCode: null, stdout: joinCapped(chunks), stderr: '', error: `no output for ${idleTimeoutMs}ms (idle)`, timedOut: true, idle: true, truncated, stderrTruncated: false });
      }, idleTimeoutMs);
    };
    armIdle();

    term.onData((d) => {
      armIdle();
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
      if (teeSink) tee(buf.toString('utf8'), false);
      if (relayTap && typeof relayTap.onData === 'function') relayTap.onData(buf);
      const remaining = MAX_CAPTURE_BYTES - bytes;
      if (remaining <= 0) { truncated = true; return; }
      if (buf.length > remaining) { chunks.push(buf.subarray(0, remaining)); bytes = MAX_CAPTURE_BYTES; truncated = true; }
      else { chunks.push(buf); bytes += buf.length; }
    });

    term.onExit(({ exitCode, signal }) => {
      finish({ ok: exitCode === 0, exitCode: typeof exitCode === 'number' ? exitCode : null, signal: signal || null, stdout: joinCapped(chunks), stderr: '', truncated, stderrTruncated: false });
    });

    // Steer-in: write cockpit bytes straight into the PTY so an operator can
    // drive the running agent.
    if (relayTap && typeof relayTap.attachSteer === 'function') {
      detachSteer = relayTap.attachSteer((data) => {
        try { term.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { /* term gone */ }
      });
    }

    // Deliver the task envelope on the PTY, then an EOT (Ctrl-D) so a harness
    // that reads its payload from stdin sees an end-of-input, while the PTY
    // itself stays open for interactive steer-in.
    try {
      if (stdinData != null) term.write(String(stdinData));
      term.write('\x04');
    } catch { /* onExit resolves on failure */ }
  });
}

// ---- ACP capture (C3 #110 — the third harness path, "minimal mode") ---------
// Some ACP agents are native (`copilot --acp`, `qwen --experimental-acp`,
// `opencode acp`), some ride an adapter (`claude-code-acp`, `pi-acp`). In every
// case the profile's command + `--arg`s already assemble the ACP invocation; we
// only append a default `--acp` switch when the assembled line doesn't already
// select ACP, so a native/adapter invocation is never doubled. This mirrors how
// the pipe path spawns the line under a shell.
function ensureAcpFlag(commandLine) {
  // Detection must survive buildAgentCommandLine()'s POSIX single-quoting: a
  // structured `--arg acp` (or `--arg --acp`) lands here as the quoted token
  // 'acp' / '--acp', so a naive `\bacp\b` on the raw line would miss it and
  // wrongly append a second --acp. Tokenise the line, strip the shell quoting
  // (both POSIX single-quotes from buildAgentCommandLine() AND double-quotes a
  // legacy `profile.command` may bake in, e.g. `copilot "--acp"`), and match:
  //   - a native ACP selector `acp`/`-acp`/`--acp` (subcommand or switch) as a
  //     WHOLE token, in ANY position (it may be the command or an argument), or
  //   - an adapter command whose basename ends in `-acp` (claude-agent-acp,
  //     pi-acp) — but ONLY the command token (first token), since an *argument*
  //     that merely ends in `-acp` (e.g. `--model foo-acp`) is not an ACP
  //     selector. Matching whole tokens/basenames (not a substring) also avoids
  //     the false positive of a path that merely contains `/acp/`.
  const tokens = commandLine.match(/'(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*"|\S+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok.length >= 2 && tok.startsWith("'") && tok.endsWith("'")) {
      tok = tok.slice(1, -1).replace(/'\\''/g, "'");
    } else if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) {
      tok = tok.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    }
    const base = tok.replace(/^.*[\\/]/, ''); // basename, for path-form commands
    if (/^-{0,2}acp$/i.test(base)) return commandLine;
    // A switch that NAMES acp, e.g. qwen's hidden `--experimental-acp` (present
    // in the shipped cli.js but not in `qwen --help`) — a long/short option
    // whose flag name ends in `-acp`. Matched in ANY position, since it is an
    // argument to the harness command (not the command token). A bare value that
    // merely ends in `-acp` (e.g. `--model foo-acp`) does NOT start with `-`, so
    // it is not a switch and still (correctly) triggers the append below.
    if (/^--?[a-z0-9][a-z0-9-]*-acp$/i.test(tok)) return commandLine;
    if (i === 0 && /-acp$/i.test(base)) return commandLine;
  }
  return `${commandLine} --acp`;
}

// The steer control byte the cockpit sends to interrupt a live ACP turn: ETX
// (Ctrl-C, 0x03), matching terminal semantics. Any other inbound steer text is
// treated as a mid-turn steer prompt (a fresh `session/prompt` on the live
// session). This keeps the ACP steer surface consistent with the PTY path
// (where Ctrl-C already interrupts) without needing a PTY.
const ACP_INTERRUPT_BYTE = '\x03';

// After the main session/prompt turn resolves we wait for the child's `close`
// event (so $AGENT_RESULT_FILE is fully flushed before the caller reads it). A
// well-behaved agent exits promptly once stdin closes; this bounds how long a
// finished-but-lingering agent may hold the turn open before it is force-reaped,
// so a completed turn is never held hostage to the full run timeout. Resolved at
// call time (see acpPostTurnGraceMs) so tests can shrink it and exercise the
// force-reap path without a 10s wait.
const ACP_POST_TURN_GRACE_DEFAULT_MS = 10_000;
function acpPostTurnGraceMs() {
  const v = Number(process.env.NANO_ACP_POST_TURN_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : ACP_POST_TURN_GRACE_DEFAULT_MS;
}

// Hard cap on a single un-terminated JSON-RPC frame. ACP frames are one compact
// JSON object per `\n`-terminated line; a conformant agent never emits a line
// this large. Without a cap a peer that streams bytes without a newline would
// grow `rxBuf` without bound (and keep re-arming the idle timer), risking memory
// exhaustion — so once the pending (newline-free) tail exceeds this we treat it
// as a framing violation and fail the run rather than buffer forever.
const ACP_MAX_LINE_BYTES = 8 * 1024 * 1024; // 8 MiB

// Drive an ACP (Agent Client Protocol) agent over JSON-RPC 2.0 on stdio.
//
// This executor drives ACP end-to-end. Each `session/update` is mapped to a
// typed `nwfTranscriptEvent` envelope (#110, step 2) and published on the relay
// session's typed publish seam (`relayTap.relayEnvelope`) — the rich cockpit
// format its derive+render consumes. The raw relay TRANSPORT is untouched (still
// `relaySession.relay(text)`); only the payload shape on the lane changes. When
// an update has no typed mapping, or the relay exposes no typed seam (minimal
// mode / a plain tap), it falls back to the step-1 human-TEXT chunk on the same
// lane (`relayTap.onData`) so nothing is dropped. The raw JSON-RPC is never
// tee'd either way.
//
// Framing: ACP frames are newline-delimited JSON-RPC 2.0 messages on stdio (one
// compact JSON object per line, `\n`-terminated). We implement a tiny inline
// framer/parser rather than pull a dependency.
//
// Sequence: initialize → session/new { cwd } → session/prompt { prompt } →
// consume session/update notifications until the prompt request resolves
// (end-of-turn) → end stdin for a clean shutdown → wait for the child's `close`
// to settle the promise. Settling on the real exit (rather than the instant the
// turn resolves) avoids racing the caller's result-file read and surfaces a late
// non-zero/early exit as a failure. The result-file merge is unchanged: the
// agent writes `$AGENT_RESULT_FILE` (already set in `env`) and the caller reads
// it exactly as in pipe mode.
//
// Permission: inbound `session/request_permission` requests are answered by the
// `permission` policy switch — see below. `yolo` auto-allow-always is the only
// policy enforced today; `escalate`/`filter` fall back to a warned safe interim
// policy pending nano-workforce#559.
//
// Same result contract as spawnCaptureOneShot/spawnCapturePty so buildResultEnvelope
// and every caller work unchanged. Because the raw stream is JSON-RPC (not human
// output), `stdout` here is the accumulated human-readable transcript text (what
// we relay), and `stderr` is the child's real stderr (agent diagnostics).
function spawnCaptureAcp({ command, args = [], cwd, env, stdinData, timeoutMs, idleTimeoutMs, relayTap = null, stream = false, streamPrefix = '', onStreamOut, onStreamErr, permission = 'yolo', shell = false }) {
  return new Promise((resolve) => {
    const logger = getLogger();
    const humanChunks = [];
    let humanBytes = 0;
    let humanTruncated = false;
    const stderrChunks = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let timer = null;
    let idleTimer = null;
    let detachSteer = null;
    let child;
    let sessionId = null;
    let nextId = 1;
    const pending = new Map();
    let childClosed = null; // { code, signal } once the child exits
    let promptResolved = false; // the main session/prompt turn sent + resolved
    let settleTimer = null; // post-turn grace before force-reaping a lingering agent
    // One-time warning latch for the reserved escalate/filter policies so the
    // deferral is observable (not silent) but never spams a warning per request.
    let interimWarned = false;

    // Live "spy" tee (--stream), line-buffered, mirroring the other paths.
    // Separate line buffers per lane (stdout-human vs stderr) so a partial line
    // on one lane never interleaves mid-line with the other — matching pipe/PTY.
    // stderr routes through its own sink (`onStreamErr`) so it keeps its warn/
    // error severity instead of being flattened onto the stdout sink; it falls
    // back to the stdout sink (then process.stdout) when no error sink is wired.
    const STREAM_TEE_LINE_CAP = 64 * 1024;
    const defaultTeeOut = (line) => process.stdout.write(`${line}\n`);
    const outSink = stream ? (onStreamOut || defaultTeeOut) : null;
    const errSink = stream ? (onStreamErr || onStreamOut || defaultTeeOut) : null;
    const teeSink = outSink; // truthy iff --stream is on (shared streaming guard)
    const makeTee = (sink) => {
      let partial = '';
      return (text, final) => {
        if (!sink) return;
        partial += text;
        let nl;
        while ((nl = partial.indexOf('\n')) !== -1) {
          sink(`${streamPrefix}${partial.slice(0, nl)}`);
          partial = partial.slice(nl + 1);
        }
        while (partial.length >= STREAM_TEE_LINE_CAP) {
          sink(`${streamPrefix}${partial.slice(0, STREAM_TEE_LINE_CAP)}`);
          partial = partial.slice(STREAM_TEE_LINE_CAP);
        }
        if (final && partial) { sink(`${streamPrefix}${partial}`); partial = ''; }
      };
    };
    const tee = makeTee(outSink);
    const teeErr = makeTee(errSink);

    const humanStdout = () => joinCapped(humanChunks);

    // Local mirrors of a human text chunk: the --stream spy tee and the byte-
    // capped stdout capture (what the result envelope carries). Deliberately does
    // NOT touch the relay lane, so a typed-transcript update can mirror its human
    // text locally (for the result + spy) WITHOUT also re-emitting raw text onto
    // the relay lane — which, in step 2, carries the typed envelope instead.
    const captureHuman = (text) => {
      if (!text) return;
      const buf = Buffer.from(text, 'utf8');
      if (teeSink) tee(text, false);
      const remaining = MAX_CAPTURE_BYTES - humanBytes;
      if (remaining <= 0) { humanTruncated = true; return; }
      if (buf.length > remaining) { humanChunks.push(buf.subarray(0, remaining)); humanBytes = MAX_CAPTURE_BYTES; humanTruncated = true; }
      else { humanChunks.push(buf); humanBytes += buf.length; }
    };

    // Emit a human-meaningful text chunk on the SAME lanes the pipe/pty paths
    // use: the relay tap (framed + jobKey-tagged by the caller) and the local
    // --stream spy tee. Byte-capped like the raw captures. This is the minimal-
    // mode text path — used for stderr, and as the fallback for any session/update
    // that has no typed nwfTranscriptEvent mapping (or when the relay exposes no
    // typed publish seam).
    const emitHuman = (text) => {
      if (!text) return;
      if (relayTap && typeof relayTap.onData === 'function') {
        try { relayTap.onData(text); } catch { /* relay best-effort */ }
      }
      captureHuman(text);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      if (detachSteer) { try { detachSteer(); } catch { /* best effort */ } detachSteer = null; }
      if (teeSink) { tee('', true); teeErr('', true); }
      // Reap the child if it is still alive (turn resolved but agent lingering).
      try { if (child && childClosed === null) killTree(child); } catch { /* best effort */ }
      resolve(result);
    };

    // --- JSON-RPC 2.0 plumbing (newline-delimited framing) -------------------
    const send = (obj) => {
      try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* child gone; close handler settles */ }
    };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ jsonrpc: '2.0', id, method, params });
    });
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
    const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
    const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

    // Pick the "allow-always" option (yolo / safe-interim structural path). ACP
    // permission options carry a `kind` (allow_always|allow_once|reject_*). We
    // prefer allow_always, then allow_once, then the first option; this is the
    // conservative structural default the interim policy also uses.
    const pickAllowOption = (options) => {
      const list = Array.isArray(options) ? options : [];
      return list.find((o) => o && o.kind === 'allow_always')
        || list.find((o) => o && o.kind === 'allow_once')
        || list[0]
        || null;
    };

    const handlePermission = (id, params) => {
      const options = params?.options;
      const allow = pickAllowOption(options);
      const grant = () => {
        if (allow && allow.optionId != null) {
          respond(id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
        } else {
          // No option to select (malformed request) — cancel rather than hang.
          respond(id, { outcome: { outcome: 'cancelled' } });
        }
      };
      switch (permission) {
        case 'yolo':
          // The ONLY fully-enforced policy: auto-allow-always, no human, sub-ms
          // local round-trip.
          grant();
          break;
        // TODO(#559): implement escalate/filter — the real permission-event +
        // escalation bridge (block-until-answered for escalate; auto-allow
        // reads/edits + escalate destructive ops for filter) lands with the
        // companion nano-workforce#559 task. Until then these reserved policies
        // must NOT masquerade as enforced: warn once, then fall through to the
        // safe interim structural policy (same allow-always grant as yolo).
        case 'escalate':
        case 'filter':
        default:
          if (!interimWarned) {
            interimWarned = true;
            logger.warn?.(`ACP permission policy '${permission}' is not yet enforced in this build; requests handled by interim policy pending nano-workforce#559`);
          }
          grant();
          break;
      }
    };

    // Extract plain text from an ACP content value (string, {type,text}, or an
    // array of content blocks). Shared by the typed-envelope mapper and the
    // human-text describer so both agree on what the "text" of an update is.
    const acpTextOf = (content) => {
      if (content == null) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(acpTextOf).join('');
      if (typeof content === 'object') return typeof content.text === 'string' ? content.text : '';
      return '';
    };

    // Serialise an ACP session/update into a short human-readable line. This is
    // the minimal-mode TEXT for the existing cockpit lane (the fallback), not a
    // typed envelope.
    const describeUpdate = (update) => {
      if (!update || typeof update !== 'object') return '';
      const kind = update.sessionUpdate || update.type || 'update';
      switch (kind) {
        case 'agent_message_chunk':
          return acpTextOf(update.content);
        case 'agent_thought_chunk':
          return `\u{1F4AD} ${acpTextOf(update.content)}`;
        case 'user_message_chunk':
          return acpTextOf(update.content);
        case 'tool_call': {
          const title = update.title || update.toolCallId || 'tool';
          return `\u2699 [tool: ${title}${update.status ? ` — ${update.status}` : ''}]\n`;
        }
        case 'tool_call_update': {
          const title = update.title || update.toolCallId || 'tool';
          return `\u2699 [tool: ${title}${update.status ? ` — ${update.status}` : ''}]\n`;
        }
        case 'plan':
          return `\u{1F4CB} [plan updated]\n`;
        default:
          return `[${kind}]\n`;
      }
    };

    // #110 step 2: map an ACP session/update to a typed `nwfTranscriptEvent`
    // envelope — the rich cockpit wire format (the existing downstream
    // derive+render consumes it). Returns null for an update kind we don't model,
    // so the caller falls back to the minimal human-text path (nothing dropped,
    // no regression vs step 1). The `text` field carries the same plain text the
    // fallback would relay, so a lightweight consumer can still render it.
    const TRANSCRIPT_EVENT_TYPE = 'nwfTranscriptEvent';
    const TRANSCRIPT_EVENT_VERSION = 1;
    const mapTranscriptEnvelope = (update) => {
      if (!update || typeof update !== 'object') return null;
      const kind = update.sessionUpdate || update.type;
      if (!kind) return null;
      const base = { type: TRANSCRIPT_EVENT_TYPE, v: TRANSCRIPT_EVENT_VERSION, ts: Date.now() };
      // Optional fields stay `undefined` (JSON encoding omits them) rather than
      // becoming explicit `null`s, and `??` preserves empty strings — so
      // consumers see omitted/optional strings, not coerced nulls. `status`
      // falls through to the kind's default only when genuinely absent.
      const toolOf = (u, defaultStatus) => ({
        id: u.toolCallId ?? undefined,
        title: u.title ?? undefined,
        status: u.status ?? defaultStatus ?? undefined,
        kind: u.kind ?? undefined,
      });
      switch (kind) {
        case 'agent_message_chunk':
          return { ...base, kind: 'message', role: 'agent', text: acpTextOf(update.content) };
        case 'agent_thought_chunk':
          return { ...base, kind: 'thought', role: 'agent', text: acpTextOf(update.content) };
        case 'user_message_chunk':
          return { ...base, kind: 'message', role: 'user', text: acpTextOf(update.content) };
        case 'tool_call':
          // `text` mirrors the fallback's plain text so the typed envelope stays
          // self-contained for lightweight renderers (matches the stated contract).
          return { ...base, kind: 'tool_call', text: describeUpdate(update), tool: toolOf(update, 'pending') };
        case 'tool_call_update':
          return { ...base, kind: 'tool_call_update', text: describeUpdate(update), tool: toolOf(update, undefined) };
        case 'plan':
          // Carry the actual plan entries (rich cockpit renders them), not a
          // count — an absent/malformed payload stays `undefined` (omitted).
          return { ...base, kind: 'plan', entries: Array.isArray(update.entries) ? update.entries : undefined };
        default:
          // Unmodelled kind → no typed envelope; caller uses the text fallback.
          return null;
      }
    };

    // Publish a session/update: prefer the typed nwfTranscriptEvent envelope on
    // the relay's typed publish seam; fall back to the minimal human-text path
    // when the update has no typed mapping OR the relay exposes no typed seam, so
    // nothing is ever dropped (no regression vs minimal mode).
    const emitTranscript = (update) => {
      const env = mapTranscriptEnvelope(update);
      if (env && relayTap && typeof relayTap.relayEnvelope === 'function') {
        // Only skip the text fallback when the typed publish ACTUALLY succeeded.
        // If the seam throws (a downstream tap implementation, not just the
        // built-in best-effort stringify guard), the envelope never reached the
        // relay lane — so we must fall through to the text path or that update
        // would be silently dropped, breaking the "nothing is ever dropped"
        // guarantee.
        let published = false;
        try { relayTap.relayEnvelope(env); published = true; } catch { /* relay best-effort */ }
        if (published) {
          // Mirror the human text locally (spy tee + captured stdout) so the
          // result envelope and --stream spy are unchanged — without re-emitting
          // raw text onto the relay lane, which now carries the typed envelope.
          captureHuman(describeUpdate(update));
          return;
        }
        // Typed publish threw → fall through to the text lane below.
      }
      // Fallback: minimal text-chunk path (relay text + spy tee + capture).
      emitHuman(describeUpdate(update));
    };

    const handleMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      // A response to one of OUR requests.
      if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || `rpc error ${msg.error.code}`));
          else p.res(msg.result);
        }
        return;
      }
      // A request or notification FROM the agent.
      if (typeof msg.method === 'string') {
        if (msg.method === 'session/update') { emitTranscript(msg.params?.update); return; }
        if (msg.method === 'session/request_permission') {
          if (msg.id !== undefined) handlePermission(msg.id, msg.params);
          return;
        }
        // Unknown request → method-not-found; unknown notification → ignore.
        if (msg.id !== undefined) respondError(msg.id, -32601, `method not found: ${msg.method}`);
      }
    };

    // --- spawn ---------------------------------------------------------------
    try {
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, detached: process.platform !== 'win32', shell });
    } catch (err) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: err.message, truncated: false, stderrTruncated: false });
      return;
    }

    timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          try { killTree(child); } catch { /* best effort */ }
          finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: `timed out after ${timeoutMs}ms`, timedOut: true, truncated: humanTruncated, stderrTruncated });
        }, timeoutMs)
      : null;

    const armIdle = () => {
      if (settled) return;
      if (!(idleTimeoutMs && idleTimeoutMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { killTree(child); } catch { /* best effort */ }
        finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: `no output for ${idleTimeoutMs}ms (idle)`, timedOut: true, idle: true, truncated: humanTruncated, stderrTruncated });
      }, idleTimeoutMs);
    };
    armIdle();

    // Newline-delimited JSON-RPC parser over stdout. Progress on stdout re-arms
    // the idle liveness timer (every frame counts as progress). A StringDecoder
    // buffers any multibyte UTF-8 sequence split across chunk boundaries so the
    // assembled JSON text is never corrupted (a partial code point is held back
    // until the continuation byte arrives, rather than emitting U+FFFD).
    let rxBuf = '';
    const rxDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (d) => {
      armIdle();
      rxBuf += rxDecoder.write(Buffer.isBuffer(d) ? d : Buffer.from(d));
      let nl;
      while ((nl = rxBuf.indexOf('\n')) !== -1) {
        const line = rxBuf.slice(0, nl).trim();
        rxBuf = rxBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // stdout is a pure newline-delimited JSON-RPC stream; a line that
          // isn't JSON is a framing/protocol violation, not noise. Silently
          // skipping it would mask a misconfigured agent as an opaque idle
          // timeout (and keep re-arming the idle timer on garbage). Fail fast
          // with an explicit error, mirroring the un-terminated-frame cap below.
          const preview = line.length > 200 ? `${line.slice(0, 200)}…` : line;
          rxBuf = '';
          try { killTree(child); } catch { /* best effort */ }
          finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: `ACP framing violation: non-JSON line on stdout: ${preview}`, truncated: humanTruncated, stderrTruncated });
          return;
        }
        try { handleMessage(msg); } catch { /* one bad frame must not wedge the loop */ }
      }
      // No newline in the (now line-free) tail past the cap → the peer is
      // streaming an unbounded frame. Fail rather than buffer to exhaustion.
      if (Buffer.byteLength(rxBuf, 'utf8') > ACP_MAX_LINE_BYTES) {
        rxBuf = '';
        try { killTree(child); } catch { /* best effort */ }
        finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: `ACP framing violation: un-terminated JSON-RPC frame exceeded ${ACP_MAX_LINE_BYTES} bytes`, truncated: humanTruncated, stderrTruncated });
      }
    });

    child.stderr.on('data', (d) => {
      armIdle();
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      // Forward stderr to the SAME live lanes the pipe/PTY paths use — the
      // --stream spy tee and the relay tap — so agent diagnostics are visible
      // during execution rather than only after it finishes. This is safe
      // precisely because stdout is the pure JSON-RPC channel here: stderr never
      // carries protocol frames, so teeing/relaying it can't corrupt the
      // relayed human stream.
      const text = buf.toString('utf8');
      if (teeSink) teeErr(text, false);
      if (relayTap && typeof relayTap.onData === 'function') {
        try { relayTap.onData(text); } catch { /* relay best-effort */ }
      }
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (remaining <= 0) { stderrTruncated = true; return; }
      if (buf.length > remaining) { stderrChunks.push(buf.subarray(0, remaining)); stderrBytes = MAX_CAPTURE_BYTES; stderrTruncated = true; }
      else { stderrChunks.push(buf); stderrBytes += buf.length; }
    });

    child.stdin.on('error', () => { /* peer may close first; close handler settles */ });

    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: err.message, truncated: humanTruncated, stderrTruncated });
    });
    child.on('close', (code, signal) => {
      childClosed = { code, signal: signal ?? null };
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      // Flush the UTF-8 decoder's held-back bytes (an incomplete multibyte
      // sequence at EOF) and drain any now-complete newline-delimited frames,
      // so a final frame that arrives in the same read as EOF isn't dropped.
      // Whatever remains after that is an un-terminated tail on what is supposed
      // to be a pure newline-delimited JSON-RPC stream — a framing violation we
      // must NOT let masquerade as success.
      let unterminatedTail = '';
      let framingViolation = '';
      try {
        rxBuf += rxDecoder.end();
        let nl;
        while ((nl = rxBuf.indexOf('\n')) !== -1) {
          const line = rxBuf.slice(0, nl).trim();
          rxBuf = rxBuf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            // A final newline-delimited frame that isn't JSON is a framing/
            // protocol violation on what must be a pure JSON-RPC stream — the
            // same rule the `data` handler enforces. Silently swallowing it here
            // would let a malformed shutdown masquerade as a clean success, so
            // record it and fail below instead of ignoring the parse error.
            framingViolation = line;
            break;
          }
          try { handleMessage(msg); } catch { /* one bad frame must not wedge shutdown */ }
        }
        if (!framingViolation) unterminatedTail = rxBuf.trim();
      } catch { /* decoder flush best effort */ }
      rxBuf = '';
      // Settle on the child's ACTUAL exit — this is what avoids racing the
      // caller's $AGENT_RESULT_FILE read: the file's write/flush is guaranteed
      // complete once the process is gone. Success requires BOTH the main
      // session/prompt turn to have resolved AND a clean exit AND no leftover
      // un-terminated frame — an early exit (e.g. code 0 during the handshake,
      // before the turn completes), any non-zero exit, or a dangling tail is a
      // failure, never a false success.
      const ok = promptResolved && code === 0 && !unterminatedTail && !framingViolation;
      // On failure, populate an explicit `error` so callers/logs explain WHY —
      // otherwise an early exit (code 0 before the turn resolved) surfaces as a
      // confusing bare "exit code 0" with no detail.
      let error;
      if (!ok) {
        if (framingViolation && promptResolved && code === 0) {
          const preview = framingViolation.length > 200 ? `${framingViolation.slice(0, 200)}…` : framingViolation;
          error = `ACP framing violation: non-JSON line on stdout at exit: ${preview}`;
        } else if (unterminatedTail && promptResolved && code === 0) {
          const preview = unterminatedTail.length > 200 ? `${unterminatedTail.slice(0, 200)}…` : unterminatedTail;
          error = `ACP framing violation: un-terminated JSON-RPC frame on stdout at exit: ${preview}`;
        } else {
          const how = signal ? `signal ${signal}` : `code ${code}`;
          error = promptResolved
            ? `ACP agent exited with ${how} (session/prompt completed)`
            : `ACP agent exited with ${how} before the session/prompt turn completed`;
        }
      }
      finish({ ok, exitCode: code, signal: signal ?? null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), ...(error ? { error } : {}), truncated: humanTruncated, stderrTruncated });
    });

    // Steer + cancel via the relay tap — NO PTY. Wired once the session exists.
    const attachSteerIfAny = () => {
      if (!relayTap || typeof relayTap.attachSteer !== 'function') return;
      detachSteer = relayTap.attachSteer((data) => {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        if (text.includes(ACP_INTERRUPT_BYTE)) {
          // Ctrl-C / ETX → interrupt the live turn.
          if (sessionId != null) notify('session/cancel', { sessionId });
          return;
        }
        const steer = text.replace(/[\r\n]+$/, '');
        if (!steer) return;
        // Mid-turn steer → a fresh prompt on the live session (fire-and-forget;
        // its own resolution is not part of the main turn sequence).
        if (sessionId != null) {
          request('session/prompt', { sessionId, prompt: [{ type: 'text', text: steer }] }).catch(() => {});
        }
      });
    };

    // --- drive the handshake + turn -----------------------------------------
    (async () => {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const created = await request('session/new', { cwd: cwd || process.cwd(), mcpServers: [] });
      sessionId = created?.sessionId ?? null;
      attachSteerIfAny();
      // Deliver the task envelope as the prompt (from stdinData, matching the
      // pipe/pty paths which write the same payload to stdin).
      await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: String(stdinData ?? '') }],
      });
      // End-of-turn: the main session/prompt request resolved. Mark it so the
      // `close` handler can tell a completed turn from an early/handshake exit.
      promptResolved = true;
      // The agent has written $AGENT_RESULT_FILE; close stdin so it can flush and
      // exit, then let the child's `close` event settle the promise. Settling on
      // the real exit (not here) avoids racing the caller's result-file read and
      // surfaces a late non-zero exit as a failure instead of a false success. A
      // well-behaved agent exits promptly once stdin closes; force-reap a
      // lingering one after a short grace so a finished turn is never held hostage
      // to the full timeout.
      try { child.stdin.end(); } catch { /* already gone */ }
      if (childClosed === null) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          try { if (child && childClosed === null) killTree(child); } catch { /* best effort */ }
          // The turn completed and the result file is already written, so this
          // is still a success — but the child did NOT exit on its own; we just
          // force-reaped it. Report that honestly instead of a fabricated clean
          // exit (code 0 / signal null): killTree sends SIGKILL, so surface the
          // real signal (or the child's actual exit if it slipped in) plus a
          // `forcedReap` flag so audits can spot agents that consistently hang
          // on shutdown rather than seeing a misleading exitCode: 0.
          finish({
            ok: true,
            exitCode: childClosed ? childClosed.code : null,
            signal: childClosed ? childClosed.signal : 'SIGKILL',
            forcedReap: childClosed === null,
            stdout: humanStdout(),
            stderr: joinCapped(stderrChunks),
            truncated: humanTruncated,
            stderrTruncated,
          });
        }, acpPostTurnGraceMs());
        if (typeof settleTimer.unref === 'function') settleTimer.unref();
      }
    })().catch((err) => {
      finish({ ok: false, exitCode: null, stdout: humanStdout(), stderr: joinCapped(stderrChunks), error: `acp: ${err?.message || err}`, truncated: humanTruncated, stderrTruncated });
    });
  });
}

function buildAgentPayload(profile, job, envelope) {
  const variables = job.variables && typeof job.variables === 'object' ? job.variables : {};
  return {
    jobKey: job.jobKey,
    jobType: job.type,
    processInstanceKey: job.processInstanceKey ?? null,
    elementInstanceKey: job.elementInstanceKey ?? null,
    elementId: job.elementId ?? null,
    bpmnProcessId: job.bpmnProcessId ?? job.processDefinitionId ?? null,
    prompt: envelope?.task?.prompt ?? variables.prompt ?? variables.task ?? null,
    task: envelope || null,
    variables,
    customHeaders: job.customHeaders ?? {},
    profile: {
      name: profile.name,
      rank: profile.rank,
      model: profile.model,
      capabilities: profile.capabilities,
    },
  };
}

function baseAgentEnv(profile, job) {
  return {
    AGENT_PROFILE: profile.name,
    AGENT_RANK: profile.rank,
    AGENT_MODEL: profile.model || '',
    AGENT_CAPABILITIES: (profile.capabilities || []).join(','),
    AGENT_JOB_TYPE: String(job.type ?? ''),
  };
}

/**
 * Keep a leased job's broker activation lock ahead of *now* while the harness is
 * running, so a long agent run never has its lock lapse and get re-activated (a
 * second worker starting → the classic stale complete/fail 409). The lock is NOT
 * hardcoded up front: we refresh it to `windowMs` — a duration-from-now, per the
 * UpdateJobTimeout contract ("the duration of the new timeout in ms, starting
 * from the current moment"), so calls SET rather than accumulate — every
 * `intervalMs`. The deadline therefore stays a bounded `windowMs` ahead of now.
 * The instant we stop refreshing (harness exit / idle-kill / hard cap) the lock
 * lapses within `windowMs` and the broker reclaims the job — fast node-loss
 * recovery. Because the harness is always killed locally before we stop, the lock
 * strictly outlives our local run, so a reclaim never races a still-running agent.
 *
 * Returns a stop() to call once the run settles. Extension failures are logged
 * and swallowed — a transient network blip must not crash the job handler. Older
 * SDKs without `modifyJobTimeout` degrade to the fixed initial lock (a no-op stop).
 */
function startLockExtender(job, windowMs, intervalMs, tag, logger) {
  if (!(windowMs > 0) || !(intervalMs > 0)) {
    return () => {};
  }
  if (typeof job?.modifyJobTimeout !== 'function') {
    logger?.warn?.(`${tag}: job.modifyJobTimeout unavailable — activation lock will NOT be auto-extended; a run longer than ${windowMs}ms risks being reclaimed and executed twice`);
    return () => {};
  }
  const extend = () => Promise.resolve()
    .then(() => job.modifyJobTimeout({ newTimeoutMs: windowMs }))
    .catch((err) => logger?.warn?.(`${tag}: lock extend failed — ${err?.message ?? err}`));
  // Renew immediately so the harness starts with a full, fresh window no matter
  // how much of the initial activation lease provisioning (clone/checkout) ate.
  extend();
  const timer = setInterval(extend, intervalMs);
  // Never let the heartbeat keep the process alive on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Run a single activated job through the profile's CLI command (one-shot),
 * dispatching on the profile's sandbox:
 *   - none            → spawn the command on the host (legacy behaviour).
 *   - docker | podman → `run --rm` a labelled, log-capped container, piping the
 *                       task envelope on stdin; a run that outlives the timeout
 *                       is force-removed so it never leaks a slot or disk.
 * Both paths resolve to the same result contract.
 */
function runAgentJob(profile, job, opts = {}) {
  const { timeoutMs, idleTimeoutMs, envelope, sandbox = 'none', image, runId, secretEnv = {}, passThroughSecretNames = [], cwd, extraEnv = {}, profileEnv = {}, resultFile, stream = false, streamPrefix = '', onStreamOut, onStreamErr, args: commandArgs, terminal = 'pipe', protocol = 'pipe', permission = 'yolo', relaySession = null, ptyFactory } = opts;
  // #110: `protocol`/`permission` drive the ACP executor branch below. The
  // pipe/PTY paths are unchanged, so `protocol === 'pipe'` behaviour is identical.
  const payload = JSON.stringify(buildAgentPayload(profile, job, envelope));
  const agentEnv = baseAgentEnv(profile, job);
  // The harness command line: the profile command plus its structured switches
  // (persisted `--arg`s, possibly extended at work time via opts.args), each
  // shell-quoted. Spawned through a shell so `command` still resolves on PATH.
  const commandLine = buildAgentCommandLine(profile.command, commandArgs ?? profile.args);
  // Static, non-secret env for the harness: the worker/profile's env (e.g. a
  // harness's permission toggles) plus the per-job envelope's setup.env
  // (job-specific tuning wins over the profile default). Reserved AGENT_* and
  // resolved secrets are layered on top so user env can never shadow them.
  const staticEnv = { ...normalizeEnvMap(profileEnv), ...normalizeEnvMap(envelope?.setup?.env) };

  // C3 (#42): when a relay session is present, tap the harness terminal onto the
  // relay lane (framed + tagged with this job's jobKey) and accept steer-in. The
  // tap is inert when there is no session, preserving legacy behaviour exactly.
  const relayTap = relaySession
    ? {
        onData: (buf) => relaySession.relay(buf),
        // #110 step 2: typed transcript publish seam. The ACP producer maps each
        // session/update to an `nwfTranscriptEvent` envelope and publishes it
        // here; we JSON-encode it (newline-delimited) onto the SAME relay lane —
        // the raw relay TRANSPORT (ring/QoS/offsets/jobKey routing) is unchanged,
        // still `relaySession.relay(text)`. Consumers (cockpit derive+render)
        // parse the envelope; unmapped updates fall back to the `onData` text path
        // so nothing is dropped (no regression vs the minimal-mode floor).
        // Best-effort: a bad envelope (circular refs / BigInt making
        // JSON.stringify throw) must never crash the worker, so swallow here.
        relayEnvelope: (env) => {
          try { relaySession.relay(`${JSON.stringify(env)}\n`); } catch { /* relay best-effort */ }
        },
        attachSteer: (write) => relaySession.attachSteer(write),
      }
    : null;

  if (!CONTAINER_SANDBOXES.has(sandbox)) {
    // Host: hand the agent the result file by its real path.
    // Defense in depth: --arg tokens are POSIX single-quoted, which cmd.exe on
    // a Windows host does not honour, so args would be mis-parsed under the
    // shell:true spawn. workAgent already rejects this at startup, but guard the
    // spawn site too so the invariant holds for any direct caller of runAgentJob.
    if (commandLine !== profile.command && process.platform === 'win32') {
      return Promise.resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: 'command-line args (--arg) are not supported for host execution on Windows; use a container sandbox or bake switches into the command', truncated: false, stderrTruncated: false });
    }
    const resultEnv = resultFile ? { [AGENT_RESULT_FILE_ENV]: resultFile } : {};
    const harnessEnv = { ...process.env, ...staticEnv, ...secretEnv, ...agentEnv, ...extraEnv, ...resultEnv };

    // A role opted into ACP (`protocol: acp`) drives its harness over the Agent
    // Client Protocol (JSON-RPC 2.0 over stdio) instead of the stdin/scrape pipe
    // or a PTY. Checked BEFORE the PTY branch: ACP owns the process when selected
    // and needs no node-pty at all (steer/cancel ride JSON-RPC, not terminal
    // writes). The ACP switch is appended to the assembled command line only when
    // it isn't already present. `permission` selects the request_permission
    // policy (yolo enforced; escalate/filter warned interim, pending #559).
    if (protocol === 'acp') {
      return spawnCaptureAcp({
        // Route the assembled line through the platform shell (cmd.exe on
        // Windows, /bin/sh elsewhere) exactly like the pipe path, rather than
        // hard-coding `sh -c` which does not exist on Windows hosts. The
        // Windows `--arg` restriction is already enforced by the guard above.
        command: ensureAcpFlag(commandLine),
        shell: true,
        cwd,
        env: harnessEnv,
        stdinData: payload,
        timeoutMs,
        idleTimeoutMs,
        relayTap,
        stream,
        streamPrefix,
        onStreamOut,
        onStreamErr,
        permission,
      });
    }

    // A role opted into a full PTY (`terminal: pty`) runs the harness on a real
    // terminal when one can be allocated — so its live output streams as a true
    // terminal and cockpit steer-in reaches it. Falls back to a pipe (still
    // relayed) when node-pty is unavailable or on Windows.
    if (terminal === 'pty' && ptyAvailable(ptyFactory)) {
      return spawnCapturePty({
        command: 'sh',
        args: ['-c', commandLine],
        cwd,
        env: harnessEnv,
        stdinData: payload,
        timeoutMs,
        idleTimeoutMs,
        ptyFactory,
        relayTap,
        stream,
        streamPrefix,
        onStreamOut,
      });
    }

    return spawnCaptureOneShot({
      command: commandLine,
      shell: true,
      // Own process group so the timeout handler can kill the whole tree.
      detached: process.platform !== 'win32',
      // When a repository was provisioned, run the harness IN the workspace.
      cwd,
      // Reserved harness env (AGENT_* + the result-file path) is layered AFTER
      // resolved secrets so a task-supplied secret NAME can never shadow it.
      env: harnessEnv,
      stdinData: payload,
      timeoutMs,
      idleTimeoutMs,
      onTimeout: (child) => killTree(child),
      stream,
      streamPrefix,
      onStreamOut,
      onStreamErr,
      relayTap,
    });
  }

  const engine = sandbox;
  const containerName = `nano-${runId}`;
  // #110: ACP-in-container is deferred for this slice — a container sandbox runs
  // the harness over the pipe path below regardless of `protocol`, so container
  // pipe mode is never regressed. Host ACP (above) is the minimal-mode surface.
  void protocol;
  // Container: bind-mount the result file's directory read-write at a fixed
  // in-container path and point AGENT_RESULT_FILE at the mounted file, so the
  // agent writes it inside the sandbox and the harness reads it back on the host.
  let resultEnv = {};
  const mountArgs = [];
  if (resultFile) {
    const hostDir = dirname(resultFile);
    const containerPath = `/nano-agent/${basename(resultFile)}`;
    mountArgs.push('-v', `${hostDir}:/nano-agent`);
    resultEnv = { [AGENT_RESULT_FILE_ENV]: containerPath };
  }
  // Forward env by NAME only (`-e NAME`) so secret VALUES stay out of argv and
  // `docker inspect`; docker reads the value from our child's environment.
  const envArgs = [];
  for (const k of Object.keys(agentEnv)) envArgs.push('-e', k);
  for (const k of Object.keys(extraEnv)) envArgs.push('-e', k);
  for (const k of Object.keys(resultEnv)) envArgs.push('-e', k);
  for (const n of passThroughSecretNames) envArgs.push('-e', n);
  for (const k of Object.keys(staticEnv)) envArgs.push('-e', k);

  const args = [
    'run', '--rm', '-i',
    '--name', containerName,
    '--label', CONTAINER_LABEL,
    '--label', `nano.worker=${profile.name}`,
    '--label', `nano.jobKey=${job.jobKey}`,
    '--label', `nano.run=${runId}`,
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
    ...mountArgs,
    ...envArgs,
    image,
    'sh', '-c', commandLine,
  ];

  return spawnCaptureOneShot({
    command: engine,
    args,
    shell: false,
    // Reserved harness env (AGENT_* + the result-file path) is layered AFTER
    // resolved secrets so a task-supplied secret NAME can never shadow it. In
    // container mode docker reads these values from our child env by NAME.
    env: { ...process.env, ...staticEnv, ...secretEnv, ...agentEnv, ...extraEnv, ...resultEnv },
    stdinData: payload,
    timeoutMs,
    idleTimeoutMs,
    stream,
    streamPrefix,
    onStreamOut,
    onStreamErr,
    relayTap,
    onTimeout: (child) => {
      try { spawnSync(engine, ['rm', '-f', containerName], { timeout: 15_000 }); } catch { /* best effort */ }
      try { killTree(child); } catch { /* best effort */ }
    },
  });
}

// Shape the io.nanobpm.agentResult output envelope. When a repository was
// provisioned (increment 2a), the `git` block adds branch/commits/push/PR facts.
function buildResultEnvelope(result, { sandbox, image, git, result: agentResult, promptResourceKey } = {}) {
  const status = result.ok ? 'completed' : (result.timedOut ? 'timedOut' : 'failed');
  const env = {
    schemaVersion: RESULT_ENVELOPE_SCHEMA_VERSION,
    status,
    sandbox,
    image: image || null,
    output: result.stdout ?? '',
    truncated: !!result.truncated,
    stderrTruncated: !!result.stderrTruncated,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
  // Audit: a turn that completed but whose child had to be force-reaped on
  // shutdown (didn't exit on its own within the post-turn grace) — surfaced so
  // consistently-hanging agents are visible rather than hidden behind a success.
  if (result.forcedReap) env.forcedReap = true;
  // Audit (issue #63): record which linked-resource key supplied the base prompt.
  // The engine only keeps `latest` per resourceId (no pinning), so recording the
  // resolved key is the only reproducibility handle for which prompt version ran.
  if (promptResourceKey != null) env.promptResourceKey = String(promptResourceKey);
  // The agent's structured result (as returned via $AGENT_RESULT_FILE / sentinel),
  // preserved verbatim for auditability even when merged into the completion vars.
  if (isPlainObject(agentResult)) env.result = agentResult;
  if (git) {
    env.repository = git.remote ?? null;
    env.branch = git.branch ?? null;
    env.baseSha = git.baseSha ?? null;
    env.headSha = git.headSha ?? null;
    env.commits = git.commits ?? [];
    env.pushed = !!git.pushed;
    if (git.pushError) env.pushError = git.pushError;
    if (git.pr) env.pr = git.pr;
    if (git.error) env.gitError = git.error;
  }
  return env;
}

/**
 * Resolve the agentic-visibility channel connection target + credentials for a
 * worker (ADR 0056 — slice C2). The channel is served same-port on the app's own
 * HTTP base URL at `/agentic`; the identity token + capability credential follow
 * the blackboard's `?token=…` pattern.
 *
 * Local-first (security opt-in). Nano is designed for local use, so visibility is
 * ON BY DEFAULT:
 *   - LOCAL mode (default): no credentials configured — the worker connects with
 *     the well-known LOCAL token ({@link LOCAL_AGENTIC_TOKEN}) and no capability
 *     credential, so it appears live with zero configuration (the hub honours this
 *     well-known token from any origin on a trusted LAN).
 *   - SECURE mode: set NANO_AGENTIC_SECRET — the SAME env var name and value the
 *     server is started with (Tab A → Slot A). The worker presents it as its
 *     identity token and the hub verifies it against its own NANO_AGENTIC_SECRET.
 *     The legacy NANO_AGENTIC_TOKEN name (and persisted `agenticToken`) is still
 *     accepted as a deprecated alias. The capability credential was removed from
 *     the hub contract (it was accept-any, pure friction), so NANO_AGENTIC_CREDENTIAL
 *     is OPTIONAL and forwarded only if still configured; a credential set WITHOUT a
 *     secret is ignored (LOCAL mode).
 *   - OFF: NANO_AGENTIC=off (or 0/false/no), or persisted `agentic:false`.
 *
 * Env wins over persisted config; when no explicit agentic target is set the base
 * URL defers to the shared resolveWorkerEngineBase (explicit engine override →
 * active c8ctl profile restAddress → localhost default), so a profile-only remote
 * worker discovers the agentic channel of the engine its jobs actually run on
 * rather than its own loopback (jwulf/c8ctl-plugin-nano#107). It is never empty.
 * Returns `null` only when disabled (the off-switch).
 *
 * @param {object} [camunda] the SDK client that activates jobs — its
 *   getConfig().restAddress supplies the profile engine base when no explicit
 *   agentic/engine override is set. Threaded from the `work` call site.
 * @returns {{ url: string, token: string, credential: string, bufferCapacity: number, secure: boolean, explicitUrl: boolean } | null}
 */
function resolveAgenticConfig(camunda) {
  const cfg = readConfig();
  // Explicit off-switch (env wins). Lets an operator fully opt out of visibility.
  const offSetting = process.env.NANO_AGENTIC
    ?? (cfg.agentic === false ? 'off' : cfg.agentic);
  if (/^(0|off|false|no)$/i.test(String(offSetting ?? ''))) return null;

  // An explicit agentic target (env NANO_AGENTIC_URL or persisted `agenticUrl`)
  // is used verbatim and short-circuits hub auto-discovery (#75). When neither is
  // set the base defers to the shared worker-engine resolver (explicit engine
  // override → profile restAddress → localhost default) — NOT a re-inlined
  // nanoUrl → NANO_BASE_URL → default chain — so agentic discovery targets the
  // same engine the worker's jobs run on (jwulf/c8ctl-plugin-nano#107).
  const explicitUrl = !!(process.env.NANO_AGENTIC_URL || cfg.agenticUrl);
  const url = process.env.NANO_AGENTIC_URL
    || cfg.agenticUrl
    || resolveWorkerEngineBase(camunda);
  // SECURE-mode shared secret. Named NANO_AGENTIC_SECRET to match the server's env
  // var EXACTLY (Tab A → Slot A): set the same name + value on the server and every
  // worker box. The worker presents it as its identity token; the hub verifies it
  // against its own NANO_AGENTIC_SECRET. NANO_AGENTIC_TOKEN / `agenticToken` remain
  // as a deprecated alias.
  const secret = process.env.NANO_AGENTIC_SECRET
    || cfg.agenticSecret
    || process.env.NANO_AGENTIC_TOKEN
    || cfg.agenticToken
    || '';
  const credential = process.env.NANO_AGENTIC_CREDENTIAL || cfg.agenticCredential || '';
  // Outbound hub-down buffer bound (frames). Operator-tunable (C4, #43) so a
  // long expected outage can be given more headroom; resolveBufferCapacity
  // validates it to a positive integer and falls back to the client default.
  const bufferCapacity = resolveBufferCapacity(
    process.env.NANO_AGENTIC_BUFFER_CAPACITY ?? cfg.agenticBufferCapacity,
  );

  // SECURE mode: an explicit shared secret means the operator opted into a real
  // per-peer secret. The capability credential was removed from the hub contract
  // (accept-any → pure friction), so it is OPTIONAL — forwarded only if still
  // configured. A credential set without a secret is meaningless and falls through
  // to LOCAL mode.
  if (secret) {
    return { url, token: secret, credential, bufferCapacity, secure: true, explicitUrl };
  }

  // LOCAL mode (default): well-known token, no capability credential.
  return { url, token: LOCAL_AGENTIC_TOKEN, credential: '', bufferCapacity, secure: false, explicitUrl };
}

// Total budget for zero-config hub auto-discovery (#75): the projects-API read
// and every WS upgrade probe must degrade to a "not discoverable" advisory
// within this window so discovery never meaningfully delays job polling.
const AGENTIC_DISCOVERY_TIMEOUT_MS = 2_000;

/**
 * Is `hostname` a loopback address? Discovery reads the engine's projects API
 * and then probes `127.0.0.1:<advertised port>`, so it must only run against a
 * loopback engine — otherwise a remote engine's response would steer a local
 * port probe, breaking the loopback-only guarantee (#75/#76). Accepts
 * `localhost`, the IPv4 loopback block `127.0.0.0/8`, and IPv6 `::1` (with or
 * without URL brackets); case-insensitive and trimmed.
 *
 * @param {string} hostname a URL hostname (e.g. `127.0.0.1`, `localhost`, `[::1]`)
 * @returns {boolean}
 */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Format a hostname for the authority component of a `ws://`/`http://` URL:
 * a bare IPv6 literal (contains `:`, not already bracketed) is wrapped in `[…]`,
 * everything else is used verbatim. Idempotent — an already-bracketed host is
 * left as-is. Guards against building an invalid `ws://::1:3000/…` when a raw or
 * normalized IPv6 host (e.g. the `::1` constant) has not been bracketed.
 *
 * @param {string} host a hostname from `URL.hostname` or a normalized loopback
 * @returns {string}
 */
function wsHostPart(host) {
  const h = String(host || '');
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/**
 * Normalise the engine's `GET /console/api/projects` payload into the running
 * embedded apps that advertise an agentic UI port. Accepts the shapes the
 * console may serve — a keyed map (`{ "Nano_Workforce": { appUi } }`), a bare
 * array (`[{ name, appUi }]`), or a wrapped array (`{ projects: [...] }`) — and
 * keeps only apps with `appUi.enabled === true` and a positive integer
 * `appUi.port`. Anything else (a Camunda engine, an API-only gateway, malformed
 * JSON) yields `[]`.
 *
 * @param {unknown} projects the parsed projects-API body
 * @returns {Array<{ project: string, port: number, label?: string }>}
 */
function normalizeProjectApps(projects) {
  if (!projects || typeof projects !== 'object') return [];
  let entries;
  if (Array.isArray(projects)) {
    entries = projects.map((p) => [p?.name ?? p?.project ?? p?.id, p]);
  } else if (Array.isArray(projects.projects)) {
    entries = projects.projects.map((p) => [p?.name ?? p?.project ?? p?.id, p]);
  } else {
    entries = Object.entries(projects);
  }
  const apps = [];
  for (const [name, proj] of entries) {
    const ui = proj?.appUi;
    if (ui && ui.enabled === true && Number.isInteger(ui.port) && ui.port > 0) {
      apps.push({
        project: String(name ?? ui.label ?? ui.port),
        port: ui.port,
        label: ui.label,
      });
    }
  }
  return apps;
}

/**
 * Probe whether an embedded app's `/agentic` endpoint answers a WebSocket
 * upgrade. Connects to `ws://<host>:<port>/agentic?token=…` (host defaults to
 * `127.0.0.1`; a bare IPv6 literal is bracketed for the URL authority) and
 * resolves `true` only if the socket opens within `timeoutMs`; a refused
 * connection, the console proxy's deliberate `501`, a `404`, or a timeout all
 * resolve `false`. Self-cleaning — the probe socket is closed as soon as the
 * outcome is known. Never throws.
 *
 * @param {number} port the app's direct agentic port (`appUi.port`)
 * @param {{ host?: string, token?: string, WebSocketImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
function probeAgenticChannel(port, {
  host = '127.0.0.1',
  token = LOCAL_AGENTIC_TOKEN,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = AGENTIC_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve(false);
  const url = `ws://${wsHostPart(host)}:${port}/agentic?token=${encodeURIComponent(token)}`;
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* best-effort cleanup */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

/**
 * Auto-discover the embedded nwf agentic hub(s) reachable from an engine base
 * URL (#75, #96). Reads `GET <engine>/console/api/projects`, keeps the apps that
 * advertise an agentic UI port, and WS-probes each app's `/agentic` **on the
 * engine's own host** to confirm the channel is actually served there (bypassing
 * the WS-incapable console proxy). Works cross-machine on a trusted LAN: a
 * loopback engine probes `127.0.0.1`, a remote engine (e.g. `merlin.local`)
 * probes that same host — the port is taken from the projects API but the host is
 * always the engine's, so a rogue projects API can never steer a probe at the
 * worker's own loopback (#76). Enforces a single shared time budget across the
 * fetch + probes, and is fail-open: any error — not a nano engine (Camunda),
 * network failure, malformed body, or an overall timeout — degrades to `[]` so
 * the worker's real job is never blocked.
 *
 * @param {string} engineBaseUrl the engine base URL (e.g. `http://merlin.local:8080`)
 * @param {{ token?: string, fetchImpl?: Function, wsProbe?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ project: string, port: number, label?: string, host: string }>>}
 */
async function discoverAgenticHubs(engineBaseUrl, {
  token = LOCAL_AGENTIC_TOKEN,
  fetchImpl = globalThis.fetch,
  wsProbe = probeAgenticChannel,
  timeoutMs = AGENTIC_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof engineBaseUrl !== 'string' || !engineBaseUrl.trim()) {
    return [];
  }
  const base = engineBaseUrl.replace(/\/+$/, '');
  // Discover against the ENGINE's own host — the app is embedded in the engine,
  // so its /agentic port lives on the same host the worker already trusts as its
  // engine (that's where it pulls jobs from). A loopback engine keeps probing
  // 127.0.0.1 (unchanged local behaviour); a remote/LAN engine (e.g.
  // merlin.local) steers the probe back to ITSELF, never at the worker's own
  // loopback services — which was the actual #76 concern (a rogue projects API
  // making the worker probe its own localhost). So the port comes from the
  // engine's projects API, but the HOST is always the engine's, never guessed.
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    return [];
  }
  const probeHost = isLoopbackHost(host) ? '127.0.0.1' : host;
  // Single discovery budget: the projects fetch and the WS probes share ONE
  // deadline, so total discovery can't approach 2× timeoutMs (the fetch could
  // consume ~timeoutMs and then each probe was previously given a fresh full
  // budget). Probes get only the time left after the fetch (#76).
  const deadline = Date.now() + timeoutMs;
  let projects;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/console/api/projects`, { signal: controller.signal });
    if (!res || !res.ok) return [];
    projects = await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  const apps = normalizeProjectApps(projects);
  if (apps.length === 0) return [];
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return [];
  // Probe candidate ports concurrently within the remaining shared budget. Each
  // surviving hub carries the engine host so the caller builds the right URL.
  const settled = await Promise.all(apps.map(async (app) => {
    try {
      return (await wsProbe(app.port, { host: probeHost, token, timeoutMs: remainingMs }))
        ? { ...app, host: probeHost }
        : null;
    } catch {
      return null;
    }
  }));
  return settled.filter(Boolean);
}

/**
 * Resolve the final agentic-channel target for a worker, running zero-config hub
 * auto-discovery when no explicit target is configured (#75). Layered on top of
 * {@link resolveAgenticConfig}:
 *
 *   - `{ status: 'off' }` — visibility disabled (off-switch) or SECURE mode
 *     half-configured. No discovery attempted.
 *   - `{ status: 'connect', config }` — a target to connect to. Either the
 *     explicit `NANO_AGENTIC_URL`/`agenticUrl` verbatim (no discovery), or the
 *     single discovered app's `ws://<engineHost>:<port>/agentic` (loopback for a
 *     local engine, the engine's LAN host for a remote one).
 *   - `{ status: 'ambiguous', message, candidates }` — two+ apps expose a
 *     channel. Hard stop for the worker: it must not silently pick one.
 *   - `{ status: 'advisory', message }` — nothing discoverable (zero matches,
 *     no projects API / not a nano engine, or discovery error/timeout). The
 *     worker continues doing real work with no channel.
 *
 * @param {{ camunda?: object, fetchImpl?: Function, wsProbe?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: string, config?: object, message?: string, candidates?: Array }>}
 */
async function resolveAgenticTarget({ camunda, ...opts } = {}) {
  const base = resolveAgenticConfig(camunda);
  if (!base) return { status: 'off' };
  // Explicit target wins verbatim and skips discovery entirely.
  if (base.explicitUrl) return { status: 'connect', config: base };

  const hubs = await discoverAgenticHubs(base.url, { token: base.token, ...opts });

  // The host to suggest in operator-facing messages: the engine's own host
  // (bracketed if an IPv6 literal, so the suggested URL authority is valid), so a
  // remote-engine advisory names the reachable LAN host rather than 127.0.0.1.
  let suggestHost = '127.0.0.1';
  try {
    const h = new URL(base.url).hostname;
    suggestHost = wsHostPart(isLoopbackHost(h) ? '127.0.0.1' : h);
  } catch { /* keep the loopback default */ }

  if (hubs.length === 1) {
    const { project, port, host } = hubs[0];
    return {
      status: 'connect',
      config: {
        ...base,
        url: `http://${wsHostPart(host)}:${port}`,
        discovered: { project, port, host },
      },
    };
  }
  if (hubs.length > 1) {
    const list = hubs.map((h) => `${h.project} → :${h.port}`).join(', ');
    return {
      status: 'ambiguous',
      candidates: hubs,
      message: `multiple embedded apps expose an agentic channel (${list}); refusing to guess. `
        + `Disambiguate by setting NANO_AGENTIC_URL=http://${suggestHost}:<port> (or persisted agenticUrl) to the one you want.`,
    };
  }
  return {
    status: 'advisory',
    message: `agentic visibility was not discoverable at ${base.url} — the embedded app port could `
      + 'not be found (not a nano engine, or its console projects API is absent). Set '
      + `NANO_AGENTIC_URL=http://${suggestHost}:<appUi.port> to enable the visibility channel. Continuing without it.`,
  };
}

/**
 * Collapse an agentic disconnect/failure detail into the single short string the
 * marker's `agentic.message` field carries (#99 contract). Accepts the close
 * `info` the work channel's onDisconnect passes (transport-dependent shape, e.g.
 * `{ code, reason, local }`), a thrown Error, or a bare string.
 * @param {unknown} x diagnostic input (close info, Error, or string)
 * @returns {string|null} a human-readable reason, or null when nothing useful
 */
function normalizeAgenticMessage(x) {
  // Collapse an agentic disconnect/failure detail into the single short string
  // the marker's `agentic.message` field carries (#99 contract). Accepts the
  // close `info` the work channel's onDisconnect passes (transport-dependent
  // shape, e.g. `{ code, reason, local }`), a thrown Error, or a bare string,
  // and returns a human-readable reason or null when there is nothing useful.
  if (x == null) return null;
  if (typeof x === 'string') return x.trim() || null;
  if (x instanceof Error) return x.message ? String(x.message) : String(x);
  if (typeof x === 'object') {
    const reason = typeof x.reason === 'string' ? x.reason.trim() : '';
    const code = x.code != null && x.code !== '' ? String(x.code) : '';
    if (reason && code) return `${reason} (code ${code})`;
    if (reason) return reason;
    if (code) return `close code ${code}`;
    if (x.message) return String(x.message);
    if (x.local === true) return 'closed locally';
    if (x.local === false) return 'connection dropped';
    return null;
  }
  return String(x);
}

/**
 * Map a resolved `resolveAgenticTarget` result to the INITIAL agentic-channel
 * state persisted on the supervisor activity marker (#99). Pure so the marker
 * producer's state transitions are unit-testable without a live broker/SDK
 * client — a regression here would leave every supervised worker stuck at
 * `?`/`starting`, which the reader/renderer tests can't catch. `connected`/
 * `disconnected` are layered on top of this base by the channel lifecycle
 * (a `{ ...state, status }` merge). The `ambiguous` status is a hard-stop
 * handled by the caller (never reaches the marker), so it degrades to `off`
 * here. `safeUrl` mirrors the caller's defensive display-URL builder.
 * @param {{ status?: string, config?: any, message?: string }} target
 * @param {(u: string) => (string|null)} [safeUrl]
 */
function agenticStateForTarget(target, safeUrl = (u) => u) {
  switch (target?.status) {
    case 'connect': {
      const cfg = target.config || {};
      return {
        status: 'connecting',
        mode: cfg.secure ? 'secure' : 'local',
        url: safeUrl(cfg.url),
        discovered: cfg.discovered || null,
      };
    }
    case 'advisory':
      // Retain the discovery diagnostic so the supervisor can distinguish a
      // missing projects API, a timeout, or a non-Nano endpoint (#99).
      return { status: 'advisory', message: target.message || null };
    case 'off':
    default:
      return { status: 'off' };
  }
}

/**
 * Build the supervisor activity-marker payload the worker atomically writes for
 * `supervisor status`. Pure so the producer's field set is unit-testable without
 * spawning a worker: the reader/renderer tests exercise a hand-written marker and
 * `agenticStateForTarget` in isolation, so a regression that dropped `engine` or
 * `agentic` from THIS payload — leaving every supervised worker's Engine/Agentic
 * column stuck at `?` — would otherwise slip through. `jobs` is the live active-job
 * list; `busy` is derived so callers can't desync it from `jobs`.
 * @param {{ pid:number, updatedAt:number, jobs:Array<{key:string,type:string,since:number}>, engine:(string|null), agentic:object }} fields
 */
function buildActivityPayload({ pid, updatedAt, jobs, engine, agentic }) {
  const jobList = Array.isArray(jobs) ? jobs : [];
  return {
    pid,
    updatedAt,
    busy: jobList.length > 0,
    jobs: jobList,
    engine: engine ?? null,
    agentic,
  };
}

/**
 * work — turn a hire profile into live Nano job workers (one per job-type in
 * the rank×capability matrix) and poll for work in the foreground until Ctrl-C.
 * Uses the c8ctl-provided SDK client (globalThis.c8ctl.createClient()).
 */
async function workAgent(req, flags) {
  const logger = getLogger();
  // The hire to run always comes from the positional profile. `--name` no longer
  // selects the hire (that was a footgun: `work reviewer --name coder` silently
  // ran `coder`); it now names THIS worker instance (see `workerName` below).
  const name = req.positional[0];

  if (!name) {
    const hires = readHires();
    const names = Object.keys(hires).sort();
    logger.error('Usage: c8ctl nano work <profileName>');
    if (names.length > 0) logger.info(`Profiles: ${names.join(', ')}`);
    else logger.info('No hires yet. Create one with: c8ctl nano hire');
    process.exit(1);
  }

  const stored = readHires()[name];
  if (!stored) {
    logger.error(`No hire named "${name}". List profiles with: c8ctl nano hire --list`);
    process.exit(1);
  }
  const normalized = normalizeStoredProfile(name, stored);
  if (normalized.error) {
    logger.error(`Cannot work "${name}": ${normalized.error}. Re-create it with: c8ctl nano hire`);
    process.exit(1);
  }
  const profile = normalized.profile;

  // This worker's identity, surfaced to the broker as the `workerName` on every
  // activateJobs call (`‹workerName›:‹jobType›`). An explicit `--name` wins;
  // otherwise auto-generate `‹host›-‹profile›-‹random›` so two workers of the
  // same profile (e.g. launched by the supervisor) stay distinct at the broker
  // and in logs. A blank/whitespace `--name` falls back to auto (mirrors the
  // supervisor path); a non-blank one must be a safe worker-name token.
  const explicitName = flags?.name ? String(flags.name).trim() : '';
  if (explicitName !== '' && !isValidWorkerName(explicitName)) {
    logger.error(`Invalid --name "${flags.name}": use only letters, digits, and . _ -`);
    process.exit(1);
  }
  const workerName = explicitName !== '' ? explicitName : autoWorkerName(name);

  if (!globalThis.c8ctl || typeof globalThis.c8ctl.createClient !== 'function') {
    logger.error('work requires the c8ctl runtime (createClient). Run it via the c8ctl CLI.');
    process.exit(1);
  }

  // Static env for the harness: the profile's persisted env, extended/overridden
  // by any work-time `--env NAME=VALUE` (repeatable). These carry harness startup
  // config such as permission toggles (e.g. a coder CLI started with tools enabled).
  const { env: workEnv, errors: workEnvErrors } = parseEnvPairs(flags?.env);
  if (workEnvErrors.length > 0) {
    logger.error(workEnvErrors.join('; '));
    process.exit(1);
  }
  const profileEnv = { ...profile.env, ...workEnv };

  // Structured command-line switches: the profile's persisted `--arg`s, extended
  // by any work-time `--arg` (appended). Lets an operator add switches (e.g.
  // `--allow-all`) at dispatch time without re-hiring.
  const effectiveArgs = [...profile.args, ...normalizeArgList(flags?.arg)];

  const intFlag = (v, dflt) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  // One job per worker, hard-wired (there is deliberately no --max-parallel
  // flag): an agent harness holds a PTY + a git workspace for the whole life of
  // a job, so a worker must never lease a second job concurrently. The @camunda8
  // SDK derives maxJobsToActivate = maxParallelJobs - activeJobs, so 1 means
  // "activate one job, then stop polling until it completes".
  const maxParallelJobs = 1;
  // The broker job-activation lock is NOT hardcoded up front. A fixed timeout is
  // impossible to size for an agent: too short reclaims a still-working job (a
  // second agent starts + the stale complete/fail is rejected 409), too long
  // strands a dead worker's job. Instead the worker keeps the lock a bounded
  // `recovery-window` ahead of *now* while the harness runs (see
  // startLockExtender), so long runs never lose their lock, and a dead/killed
  // worker's job is reclaimed within one window. Liveness is enforced by
  // `idle-timeout` (max silence before the harness is killed as wedged), so the
  // lock is held only while the agent is alive AND producing output.
  const recoveryWindowMs = intFlag(flags?.['recovery-window'], 5 * 60_000);
  const idleTimeoutMs = intFlag(flags?.['idle-timeout'], 5 * 60_000);
  // `--job-timeout` is now an OPTIONAL absolute hard cap on total harness runtime
  // (0/absent = unlimited), for operators who still want a ceiling regardless of
  // output. It no longer governs the broker lock. intFlag floors non-positive to
  // the default, so 0/absent both mean "no cap".
  const hardCapMs = intFlag(flags?.['job-timeout'], 0);
  // Refresh the lock well before it lapses: to `recovery-window` every ~1/3 of it,
  // so a couple of missed beats (a slow extend RPC) don't drop the job, while a
  // true stop (exit / idle-kill / hard cap) still reclaims within one window.
  // Floored at 5s so a tiny window can't spin the extender.
  // Refresh interval: ~1/3 of the window so we always renew comfortably before it
  // lapses, floored at 5s (avoid hammering the gateway) and capped strictly below
  // the window so even a tiny recovery window still renews before it expires.
  const lockExtendIntervalMs = Math.min(
    Math.max(5_000, Math.floor(recoveryWindowMs / 3)),
    // Strict upper bound: always renew before the window lapses. `* 0.75` (never
    // floored back up above the window) keeps the interval < recoveryWindowMs even
    // for a tiny window, so the lock can't lapse between beats.
    Math.max(1, Math.floor(recoveryWindowMs * 0.75)),
  );
  // Broker long-poll window: how long each activateJobs request is held open
  // waiting for work. 30s default so idle workers hold one connection open ~30s
  // rather than reconnecting every few seconds — fewer reconnects, fewer chances
  // to hit a transient connect error on a flaky link. Passed to the SDK verbatim.
  const pollTimeoutMs = derivePollTimeoutMs(flags?.['poll-timeout']);

  // Sandbox: flag overrides the stored profile default. `none` runs on the host
  // (legacy); `docker`/`podman` run each job in a throwaway labelled container.
  const sandbox = String(flags?.sandbox ?? profile.sandbox ?? 'none').trim().toLowerCase();
  if (!SANDBOXES.includes(sandbox)) {
    logger.error(`Invalid --sandbox "${sandbox}". Use one of: ${SANDBOXES.join(', ')}`);
    process.exit(1);
  }
  const image = flags?.image ? String(flags.image).trim() : (profile.image || '');
  const isContainer = CONTAINER_SANDBOXES.has(sandbox);
  if (isContainer && !image) {
    logger.error(`--sandbox ${sandbox} requires an --image (or hire the profile with --image).`);
    process.exit(1);
  }
  // Structured --arg tokens are POSIX single-quoted (shQuote) for the harness
  // shell. On the host path that shell is the platform default — cmd.exe on
  // Windows, which does not honour single quotes — so the quoting would leak
  // literal quote characters and mis-parse the switches. The container path
  // always targets the image's `sh`, so it stays correct regardless of host OS.
  // Fail fast with actionable guidance rather than silently corrupting argv.
  if (!isContainer && effectiveArgs.length > 0 && process.platform === 'win32') {
    logger.error('--arg is not supported for host execution on Windows (cmd.exe does not honour POSIX quoting).');
    logger.error('Use a container sandbox (--sandbox docker|podman --image <ref>) or bake the switches into --command.');
    process.exit(1);
  }

  const secretResolver = makeSecretResolver(flags?.['secret-resolver']);
  if (!secretResolver) {
    logger.error(`Unknown --secret-resolver "${flags?.['secret-resolver']}". Only "host" is supported.`);
    process.exit(1);
  }

  // Disk-hygiene knobs (container sandboxes only). Reaper age + interval and the
  // free-space admission floor mirror nano's own disk-budget/reaper patterns.
  const reapAgeMs = intFlag(flags?.['reap-age'], 60 * 60_000); // 1h
  const reapIntervalMs = intFlag(flags?.['reap-interval'], 5 * 60_000); // 5m
  const minFreeBytes = flags?.['min-free-mb'] != null
    ? Math.max(0, intFlag(flags['min-free-mb'], 0)) * 1_048_576
    : 1_073_741_824; // 1 GiB default floor

  // Git provisioning knobs (increment 2a — host harness with a repository).
  const cloneTimeoutMs = intFlag(flags?.['clone-timeout'], 120_000);
  const keepRuns = coerceBool(flags?.['keep-runs'], false);
  // --stream: tee each agent job's live stdout/stderr to this console (spy/debug),
  // in addition to the existing byte-capped capture used for the result envelope.
  const stream = coerceBool(flags?.stream, false);

  // Tracks run ids currently executing so the reaper never removes a live
  // container out from under an in-flight job.
  const liveRunIds = new Set();
  // Tracks per-job workspace dirs currently in use so the run-dir reaper never
  // deletes a workspace out from under an in-flight host job.
  const liveRunDirs = new Set();
  let reaperTimer = null;
  let runDirTimer = null;

  // Run-dir hygiene runs regardless of sandbox: any sandbox=none job that carries
  // a repository clones a throwaway workspace under the runs root, and a crashed
  // worker can leave one behind. Bounded to our own directory, age-gated.
  {
    const initialRuns = reapAgentRunDirs({ maxAgeMs: reapAgeMs, liveRunDirs });
    if (initialRuns.reaped > 0) logger.info(`Reaped ${initialRuns.reaped} leftover job workspace(s) at startup.`);
    runDirTimer = setInterval(() => {
      const r = reapAgentRunDirs({ maxAgeMs: reapAgeMs, liveRunDirs });
      if (r.reaped > 0) logger.info(`Reaper removed ${r.reaped} finished job workspace(s).`);
    }, reapIntervalMs);
    if (typeof runDirTimer.unref === 'function') runDirTimer.unref();
  }

  if (isContainer) {
    if (!containerEngineAvailable(sandbox)) {
      logger.error(`--sandbox ${sandbox} selected but "${sandbox}" is not available/running on this host.`);
      process.exit(1);
    }
    // Age-gate the startup sweep too (not maxAgeMs:0): on a shared host other
    // worker processes may have just-created containers not yet in liveRunIds,
    // so only reap ones older than --reap-age, matching the interval reaper.
    const initial = reapAgentContainers(sandbox, { maxAgeMs: reapAgeMs, liveRunIds });
    if (initial.reaped > 0) logger.info(`Reaped ${initial.reaped} leftover agent container(s) at startup.`);
    if (initial.error) logger.warn(`Startup reap warning: ${initial.error}`);
    reaperTimer = setInterval(() => {
      const r = reapAgentContainers(sandbox, { maxAgeMs: reapAgeMs, liveRunIds });
      if (r.reaped > 0) logger.info(`Reaper removed ${r.reaped} finished agent container(s).`);
    }, reapIntervalMs);
    if (typeof reaperTimer.unref === 'function') reaperTimer.unref();
  }

  const matrix = jobTypeMatrix(profile.rank, profile.capabilities);
  // Optional explicit job types (repeatable `--job-type`), serviced in addition
  // to the rank×capability matrix. This lets a hired profile also drive a pool
  // keyed on a token the matrix can't express — e.g. a code-first
  // `@nanobpm/workflow` flow whose external task type isn't a `rank:cap` token.
  const { jobTypes: extraJobTypes, errors: jobTypeErrors } = parseJobTypeFlags(flags?.['job-type']);
  if (jobTypeErrors.length > 0) {
    logger.error(jobTypeErrors.join('; '));
    process.exit(1);
  }
  // Zero-config engine-read enrolment (issue #66). `--auto` subscribes this
  // worker to ALL deployed *agent* job types read straight from the engine —
  // no capability, no app enrol endpoint, no channel connection. It is the
  // mutually-exclusive counterpart to capability-resolved SERVE: in `--auto`
  // the rank×capability matrix is bypassed entirely (any deployed agent job is
  // served, gated only by the leaf's canonical `agentic` flag — the
  // `linkName="prompt"` linked-resource marker read by
  // `@nanobpm/agentic`'s demand scanner), and the
  // desired set is reconciled by polling the engine rather than watching the
  // profile. `--auto-scope <process-id|prefix>` narrows the blast radius to one
  // app/network; without it, every agent job type on the engine is served.
  //
  // TRUST: engine-read has no capability gate — a `--auto` worker will serve any
  // deployed agent job on its engine. That is the accepted trade for the
  // local/zero-config target; capability-gated serving is the specialised path.
  const autoMode = coerceBool(flags?.auto, false);
  const autoScope = flags?.['auto-scope'] ? String(flags['auto-scope']).trim() : '';
  if (!autoMode && autoScope) {
    logger.error('--auto-scope requires --auto (it narrows the engine-read agent job types).');
    process.exit(1);
  }
  const camunda = globalThis.c8ctl.createClient();

  // Broker REST endpoint for live linked-resource prompts (issue #63) and the
  // C8 REST source for `--auto`'s engine-read enrolment. Derived from the SAME
  // client that activates jobs (its profile REST address) when no explicit
  // NANO_REST_URL/NANO_BASE_URL/cfg.nanoUrl override is set — so a worker that
  // can activate jobs against the active profile engine also reads job types
  // from it, instead of a localhost default that crash-loops when nothing is
  // listening on :8080 (jwulf/c8ctl-plugin-nano#93). Resolved once at startup.
  const restConfig = resolveAutoRestConfig(camunda);

  // The desired job-type set. In `--auto` it is engine-read (∪ any --job-type
  // extras); otherwise it is the rank×capability matrix (∪ extras). The initial
  // engine read is best-effort — a transient failure starts the worker with no
  // auto pollers and the poll reconcile below fills them in on the next pass,
  // rather than refusing to start.
  let jobTypes;
  if (autoMode) {
    try {
      const autoTypes = await resolveAutoJobTypes({ restConfig, scope: autoScope });
      jobTypes = [...new Set([...autoTypes, ...extraJobTypes])];
    } catch (err) {
      logger.warn(`--auto: initial engine read failed (${err?.message || err}); starting with no auto pollers — will retry on the next poll.`);
      jobTypes = [...new Set(extraJobTypes)];
    }
  } else {
    jobTypes = [...new Set([...matrix, ...extraJobTypes])];
  }

  logger.info(`Putting "${name}" [${profile.rank}] to work → ${buildAgentCommandLine(profile.command, effectiveArgs)}`);
  logger.info(`  worker: ${workerName}`);
  logger.info(`  model: ${profile.model || '(none)'}; capabilities: ${profile.capabilities.join(', ') || '(none)'}`);
  logger.info(`  sandbox: ${sandbox}${isContainer ? ` (image ${image})` : ''}`);
  const profileEnvKeys = Object.keys(profileEnv);
  if (profileEnvKeys.length > 0) logger.info(`  harness env: ${profileEnvKeys.join(', ')}`);
  if (autoMode) {
    logger.info(`  enrolment: --auto (zero-config engine read${autoScope ? `, scope "${autoScope}"` : ', all agent job types'}) — no capability gate; serves any deployed agent job on this engine.`);
  }
  const extraNote = extraJobTypes.length > 0 ? ` (${extraJobTypes.length} via --job-type)` : '';
  logger.info(`  listening on ${jobTypes.length} job type(s)${extraNote}: ${jobTypes.join('  ')}`);
  logger.info(`  one job per worker; recovery window: ${recoveryWindowMs}ms; idle timeout: ${idleTimeoutMs}ms; hard cap: ${hardCapMs > 0 ? `${hardCapMs}ms` : 'off'}; poll timeout: ${pollTimeoutMs}ms`);
  // Warm the gh-token cache now, off the job-handling path: githubCloneToken()
  // may consult `gh auth token` (a synchronous spawn, up to 10s) as its default
  // credential fallback, and doing that inside a job handler would block the
  // event loop — stalling the lock heartbeat and delaying the job itself.
  // Priming here pays that cost once at startup so every later lookup is a warm
  // cache hit.
  primeGhAuthToken();
  logger.info('Polling for work — press Ctrl-C to stop.');

  // When launched under the supervisor, report per-job activity — which job(s)
  // this worker is currently servicing, or that it is idle — to a small marker
  // file the supervisor reads for `supervisor status`. The daemon passes the
  // path via NANO_SUPERVISOR_ACTIVITY_FILE; a standalone `nano work` has no such
  // env var and writes nothing (this is entirely advisory).
  const activityFile = process.env.NANO_SUPERVISOR_ACTIVITY_FILE || null;
  // Supervised workers (spawned by the daemon, hence NANO_SUPERVISOR_ACTIVITY_FILE)
  // arm a parent-death watchdog: if the daemon dies *ungracefully* (SIGKILL /
  // crash / its host force-killed) it can't run its child-reaping shutdown, and
  // this worker would otherwise idle forever as an orphan reparented to init.
  // The watchdog makes the child self-exit the moment it is reparented. A
  // standalone `nano work` (no activity file) keeps classic nohup semantics.
  if (activityFile) {
    const daemonPid = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);
    installParentDeathWatchdog({ parentPid: Number.isInteger(daemonPid) ? daemonPid : undefined });
  }
  const activeJobs = new Map(); // jobKey -> { type, since (ms epoch) }
  // Which engine this worker polls jobs from, surfaced to `supervisor status` via
  // the activity marker (#99). Derived from resolveWorkerPollEngineBase — the SDK
  // client's OWN profile restAddress (the base createJobWorker actually activates
  // against), NOT the NANO_* / cfg.nanoUrl override that resolveWorkerEngineBase
  // prefers for auxiliary REST reads. That keeps the ENGINE column honest: it
  // reports the engine the worker truly polls, never an override the job worker
  // ignores. Falls back to the canonical resolver only when the client exposes no
  // usable profile base.
  const workerEngine = resolveWorkerPollEngineBase(camunda);
  // Base URL for the per-job linked-prompt fetch (issue #63). This follows
  // resolveLinkedPromptBase — the polling engine (profile restAddress the SDK
  // activates jobs against), since the linked resourceKey is BROKER-LOCAL and must
  // be fetched from the broker that issued it — with NANO_REST_URL as the only
  // explicit escape hatch. It deliberately does NOT follow the NANO_BASE_URL /
  // cfg.nanoUrl auxiliary-read overrides resolveWorkerEngineBase prefers: pointing
  // the prompt fetch at a different engine than the activation broker would 404 a
  // broker-local resourceKey while job activation still succeeds. Computed ONCE at
  // startup so the per-job hot path skips a config.json read. It coincides with
  // `workerEngine` (the polling engine) unless NANO_REST_URL is set.
  const linkedPromptBase = resolveLinkedPromptBase(camunda);
  // The live agentic-visibility channel status, also surfaced to `supervisor
  // status` via the activity marker (#99). `agenticState` starts 'starting' and
  // is updated once the channel target is resolved and again on each
  // connect/disconnect below.
  let agenticState = { status: 'starting' };
  const writeActivity = () => {
    if (!activityFile) return;
    const jobs = [...activeJobs.entries()].map(([key, v]) => ({ key, type: v.type, since: v.since }));
    const payload = buildActivityPayload({ pid: process.pid, updatedAt: Date.now(), jobs, engine: workerEngine, agentic: agenticState });
    const tmp = `${activityFile}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(activityFile), { recursive: true });
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, activityFile); // atomic swap so a reader never sees a half-write
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      /* best effort — activity is advisory, never fail a job over it */
    }
  };
  // The agentic-visibility channel, wired below. Declared here so the job
  // recorders can refresh presence with the live job set as jobs start/end.
  /** @type {import('./work-channel.mjs').WorkChannel | null} */
  let workChannel = null;
  /** @type {import('./work-buffer.mjs').BufferMonitor | null} */
  let bufferMonitor = null;
  // Maintain `activeJobs` unconditionally: it feeds both the supervisor activity
  // file (gated inside writeActivity) AND the agentic presence frame's live
  // jobKey set, so a standalone worker (no NANO_SUPERVISOR_ACTIVITY_FILE) still
  // reports its current jobs on the visibility page.
  const recordJobStart = (job, jobType) => {
    activeJobs.set(String(job.jobKey), { type: jobType, since: Date.now() });
    writeActivity();
    workChannel?.refreshPresence();
  };
  const recordJobEnd = (job) => {
    activeJobs.delete(String(job.jobKey));
    writeActivity();
    workChannel?.refreshPresence();
  };
  // Seed an initial idle marker so status reports 'idle' immediately after spawn.
  writeActivity();

  // ---- Agentic visibility channel (ADR 0056 — slice C2, #41) ----------------
  // Connect this worker to the app's same-port `/agentic` channel and announce
  // presence (identity, host, live jobs), heartbeat, and deregister on exit, so
  // it appears live on the Workforce visibility page. This is the SINGLE place
  // the connected+authenticated channel client is instantiated in `work`: the
  // sibling slices C3 (PTY relay, #42) and C4 (buffer, #43) attach to the
  // accessors on `workChannel` (relay-lane sink + connect/disconnect/reconnect
  // lifecycle events) rather than opening their own connection.
  //
  // Local-first (security opt-in): visibility is ON BY DEFAULT. In LOCAL mode the
  // worker joins with the well-known LOCAL token and no credential; SECURE mode
  // (NANO_AGENTIC_SECRET) sends a real per-peer shared secret as the identity;
  // NANO_AGENTIC=off disables it (see resolveAgenticConfig).
  const agenticTarget = await resolveAgenticTarget({ camunda, logger });
  let agenticCfg = null;
  // buildAgenticUrl can throw on a malformed/unsupported explicit NANO_AGENTIC_URL.
  // This is only the display URL for the activity marker, so compute it
  // defensively: a bad URL must be recorded as a channel failure (via the
  // createWorkChannel try/catch below), never crash the worker before it — which
  // would violate the best-effort channel contract and cause a restart loop.
  const safeAgenticDisplayUrl = (u) => {
    try { return redactAgenticUrl(buildAgenticUrl(u, {})); }
    catch { return null; }
  };
  switch (agenticTarget.status) {
    case 'connect':
      agenticCfg = agenticTarget.config;
      // 'connecting' until the socket actually opens (wired on the channel
      // lifecycle below). Carry the resolved mode/target/discovery so the
      // supervisor can show WHERE presence is being announced (#99).
      agenticState = agenticStateForTarget(agenticTarget, safeAgenticDisplayUrl);
      break;
    case 'ambiguous':
      // The operator ran with visibility on-by-default but the hub is
      // unresolved — a misconfiguration to fix, not to guess through. Hard stop.
      logger.error(`  agentic visibility is ambiguous: ${agenticTarget.message}`);
      process.exit(1);
      break;
    case 'advisory':
      agenticState = agenticStateForTarget(agenticTarget);
      logger.info(`  agentic channel: ${agenticTarget.message}`);
      break;
    case 'off':
    default:
      agenticState = agenticStateForTarget(agenticTarget);
      logger.info('  agentic channel: disabled — the off-switch is set (NANO_AGENTIC=off or persisted agentic:false). Clear it to use default LOCAL visibility.');
      break;
  }
  // Persist the resolved channel state to the activity marker now, so
  // `supervisor status` reflects connecting/advisory/off immediately, before
  // the socket opens (or without a channel at all).
  writeActivity();
  if (agenticCfg) {
    try {
      workChannel = await createWorkChannel({
        instance: workerName,
        host: hostname(),
        capability: {
          cognition: profile.rank,
          family: profile.model || undefined,
          host: hostname(),
        },
        listJobKeys: () => [...activeJobs.keys()],
        url: agenticCfg.url,
        token: agenticCfg.token,
        credential: agenticCfg.credential,
        bufferCapacity: agenticCfg.bufferCapacity,
        logger,
      });
      const shown = redactAgenticUrl(buildAgenticUrl(agenticCfg.url, {}));
      const mode = agenticCfg.secure ? 'secure' : 'local';
      if (agenticCfg.discovered) {
        const d = agenticCfg.discovered;
        logger.info(`  agentic channel: auto-discovered ${d.project} on the app's /agentic port ${wsHostPart(d.host)}:${d.port} (bypassing the WS-incapable console proxy).`);
      }
      logger.info(`  agentic channel (${mode}): announcing presence as ${workerName} on ${shown}`);
      // Track the live connection state on the activity marker so the
      // supervisor shows connected↔disconnected transitions (#99). onConnect
      // fires only for listeners present at first open, so also reconcile the
      // already-open case synchronously via connected(). If the socket opened
      // and then dropped inside the createWorkChannel() await window (before
      // these listeners existed), connected() is false but everConnected() is
      // true — record that as `disconnected` rather than leaving it stuck at
      // `connecting`. A close carries a normalized diagnostic under the contract
      // `agentic.message` field (not `reason`) so a hub drop explains WHY; a
      // fresh (re)connect clears any stale message.
      const markAgentic = (status, message = null) => { agenticState = { ...agenticState, status, message }; writeActivity(); };
      workChannel.onConnect(() => markAgentic('connected'));
      workChannel.onReconnect(() => markAgentic('connected'));
      workChannel.onDisconnect((info) => markAgentic('disconnected', normalizeAgenticMessage(info)));
      if (workChannel.connected()) markAgentic('connected');
      else if (workChannel.everConnected()) markAgentic('disconnected');
    } catch (err) {
      // Never let a channel failure stop the worker from doing its actual job.
      workChannel = null;
      // Retain the failure reason on the marker so the supervisor can show WHY
      // presence dropped (bad URL, refused socket, …), not just `disconnected`.
      // The contract diagnostic field is `agentic.message` (#99), matching the
      // live-disconnect path above — keep the key consistent, not `reason`.
      agenticState = { ...agenticState, status: 'disconnected', message: normalizeAgenticMessage(err) };
      writeActivity();
      logger.warn(`  agentic channel unavailable (${err?.message || err}); continuing without visibility.`);
    }
    // C4 (#43): observe the client's built-in outbound buffer across the
    // channel lifecycle — surface a high-water mark and warn when the bound
    // is hit so a hub outage that starts shedding frames is never silent. The
    // monitor is observability-only, so keep it OUTSIDE the channel try/catch:
    // a monitor failure must never null out a healthy channel and take down
    // presence/visibility.
    if (workChannel) {
      try {
        bufferMonitor = createBufferMonitor(workChannel, {
          capacity: agenticCfg.bufferCapacity,
          logger,
        });
      } catch (err) {
        bufferMonitor = null;
        logger.warn(`  agentic buffer monitor unavailable (${err?.message || err}); channel presence still active.`);
      }
    }
  }

  // C3 (#42): the role's live-terminal mode — a full PTY (streamed on the relay
  // lane when a relay session exists, steerable) or a plain pipe. Honors the
  // vocab's per-role opt-in read off the hire profile (`terminal: pty|pipe`),
  // with an env override for a one-off worker (`NANO_AGENTIC_TERMINAL`). The PTY
  // itself is allocated locally regardless of enrollment; relay streaming (and
  // steer-in) only engages when the worker is enrolled on the channel, so
  // without the channel there's simply no relay tap — the harness still runs on
  // the chosen local transport.
  const envTerminal = (process.env.NANO_AGENTIC_TERMINAL || '').trim().toLowerCase();
  const roleTerminal = (envTerminal === 'pty' || envTerminal === 'pipe')
    ? envTerminal
    : roleTerminalMode(profile);
  if (workChannel) {
    logger.info(`  live terminal: ${roleTerminal === 'pty' ? 'PTY (streamed + steerable)' : 'pipe (streamed)'} on the relay lane.`);
  }

  // #110: the role's harness protocol (pipe|acp) and ACP permission policy
  // (yolo|escalate|filter), resolved with the same env-override-then-profile
  // precedence as terminal. `NANO_AGENTIC_PROTOCOL`/`NANO_AGENTIC_PERMISSION`
  // override a one-off worker; otherwise the hire profile decides; else the safe
  // defaults (pipe/yolo). escalate/filter are carried through verbatim — the
  // acp-executor task enforces yolo and interim-handles the reserved policies.
  const envProtocol = (process.env.NANO_AGENTIC_PROTOCOL || '').trim().toLowerCase();
  const roleProtocol = resolveAgenticSetting(envProtocol, profile.protocol, PROTOCOLS, 'pipe');
  const envPermission = (process.env.NANO_AGENTIC_PERMISSION || '').trim().toLowerCase();
  const rolePermission = resolveAgenticSetting(envPermission, profile.permission, PERMISSION_MODES, 'yolo');

  // A per-job-type worker factory. Captures all the CLI-local + profile context
  // in closure scope so the profile watcher below can (re)spawn a poller for any
  // job type on demand without re-reading the flags.
  const makeWorker = (jobType) =>
    camunda.createJobWorker({
      jobType,
      workerName: `${workerName}:${jobType}`,
      maxParallelJobs,
      jobTimeoutMs: recoveryWindowMs,
      pollTimeoutMs,
      jobHandler: async (job) => {
        recordJobStart(job, jobType);
        // Auto-extend the broker lock for the whole life of this job (harness run
        // + git finalize + complete/fail), stopped in the outer finally. The lock
        // is held only while the harness stays alive and productive — a silent
        // hang is killed by the idle-timeout, which resolves runAgentJob and stops
        // the extension, so the broker can reclaim the job.
        let stopLockExtender = () => {};
        try {
        logger.info(`[${jobType}] job ${job.jobKey} (instance ${job.processInstanceKey ?? '-'}) → ${buildAgentCommandLine(profile.command, effectiveArgs)}`);

        // Disk-budget admission shed: if the engine data root is below the free
        // floor, don't start a container — fail (retryable) so work sheds until
        // the reaper/host frees space.
        if (isContainer) {
          const budget = diskBudgetOk(sandbox, minFreeBytes);
          if (!budget.ok) {
            const freeMb = budget.free != null ? Math.round(budget.free / 1_048_576) : '?';
            const retries = Math.max(0, (Number(job.retries) || 1) - 1);
            logger.warn(`[${jobType}] job ${job.jobKey} shed — low disk (${freeMb}MB free); retries left ${retries}`);
            return job.fail({ errorMessage: `disk budget exceeded (only ${freeMb}MB free)`, retries, retryBackOff: 30_000 });
          }
        }

        // Live agent prompt (issue #63): if the job declares a `linkName: prompt`
        // linked resource, fetch its LATEST deployed content and use it as the
        // base prompt (it wins over the header-baked task.prompt). A declared
        // prompt resource that can't be fetched is a provisioning failure — fail
        // (retryable) rather than run an agent with an empty prompt.
        let promptResourceKey = null;
        let basePromptOverride;
        try {
          // Fetch the prompt from the broker the SDK client is connected to,
          // deriving base URL + auth from that client (not restConfig, whose base
          // defaults to localhost) — the resourceKey is broker-local. The base is
          // invariant, so reuse the once-at-startup linkedPromptBase and let the
          // resolver only compute per-job auth headers (no per-job config.json read).
          const promptSource = await resolveLinkedPromptSource(camunda, process.env, { baseUrl: linkedPromptBase });
          const linked = await resolveLinkedPrompt(job.customHeaders ?? {}, {
            baseUrl: promptSource.baseUrl || restConfig.baseUrl,
            authHeaders: promptSource.authHeaders,
            token: restConfig.token,
          });
          if (linked) {
            basePromptOverride = linked.basePrompt;
            promptResourceKey = linked.resourceKey;
            logger.info(`[${jobType}] job ${job.jobKey} base prompt from linked resource key ${promptResourceKey} (linkName=${linked.linkName}, ${Buffer.byteLength(String(basePromptOverride), 'utf8')} bytes)`);
          }
        } catch (err) {
          const retries = Math.max(0, (Number(job.retries) || 1) - 1);
          const msg = err instanceof ProvisionError ? err.message : `prompt resource fetch failed: ${err.message}`;
          logger.warn(`[${jobType}] job ${job.jobKey} not provisioned — ${msg}; retries left ${retries}`);
          return job.fail({ errorMessage: msg.slice(0, 2000), retries, retryBackOff: 15_000 });
        }

        // Assemble + normalize the task envelope from headers (defaults) and
        // variables (overrides), then resolve any secrets it references.
        const envelope = normalizeTaskEnvelope(job.customHeaders ?? {}, job.variables ?? {}, { basePromptOverride });
        const { resolved, missing, names } = resolveJobSecrets(secretResolver, envelope);
        if (missing.length > 0) {
          const retries = Math.max(0, (Number(job.retries) || 1) - 1);
          const msg = `missing secret(s): ${missing.join(', ')} (resolver: ${secretResolver.kind})`;
          logger.warn(`[${jobType}] job ${job.jobKey} not provisioned — ${msg}; retries left ${retries}`);
          return job.fail({ errorMessage: msg, retries });
        }

        const runId = randomUUID();
        if (isContainer) liveRunIds.add(runId);

        // Host git provisioning (increment 2a): sandbox=none + a repository →
        // clone into a throwaway workspace, run the harness there, then push +
        // reconcile the agent PR. Container-side cloning is a later increment.
        const hasRepo = !isContainer && !!envelope.repository?.url;
        let runDir = null;
        let provisioned = null;
        // Start refreshing the broker activation lock BEFORE any potentially-long
        // work (host git clone/checkout can outlast the initial window). Starting
        // here — ahead of provisionRepo — guarantees the first renewal is queued
        // before the clone, so the lock can't lapse mid-provision and trigger the
        // duplicate-activation / stale-409 race. The `finally` below stops it.
        stopLockExtender = startLockExtender(job, recoveryWindowMs, lockExtendIntervalMs, `[${jobType}] job ${job.jobKey}`, logger);
        let cwd;
        let extraEnv;
        let repoToken = null;
        if (hasRepo) {
          const provider = envelope.repository.provider || 'github';
          const authRef = envelope.repository.authRef;
          repoToken = githubCloneToken({ provider, authRef, secretResolver }); // absent → anonymous clone
          try {
            mkdirSync(agentRunsRoot(), { recursive: true });
            runDir = mkdtempSync(join(agentRunsRoot(), 'run-'));
            liveRunDirs.add(runDir);
            provisioned = provisionRepo({ envelope, token: repoToken, runDir, timeoutMs: cloneTimeoutMs });
            if (provisioned.baseFetchError) {
              logger.warn(`[${jobType}] job ${job.jobKey} base fetch failed — ${provisioned.baseFetchError}; base...head diffs may be unavailable`);
            }
            cwd = provisioned.workspaceDir;
            extraEnv = {
              AGENT_WORKSPACE: provisioned.workspaceDir,
              AGENT_REPO_URL: provisioned.remote,
              AGENT_REPO_BRANCH: provisioned.workingBranch || '',
              AGENT_REPO_REF: provisioned.ref || '',
              // The fetched base ref (e.g. `origin/main` or a base sha) for
              // computing `git diff <base>...HEAD`; empty when none was requested
              // or the base fetch failed (see provisioned.baseFetchError).
              AGENT_REPO_BASE: provisioned.base || '',
              // Pin the harness's commit identity to the resolved (placeholder-
              // sanitized) committer so the agent's own `git commit` can't be
              // hijacked by a placeholder GIT_AUTHOR_* inherited from process.env
              // (git honours these over user.name/user.email config). Layered via
              // extraEnv so they override any inherited placeholder in harnessEnv.
              GIT_AUTHOR_NAME: provisioned.committer.name,
              GIT_AUTHOR_EMAIL: provisioned.committer.email,
              GIT_COMMITTER_NAME: provisioned.committer.name,
              GIT_COMMITTER_EMAIL: provisioned.committer.email,
            };
          } catch (err) {
            if (runDir) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } liveRunDirs.delete(runDir); }
            if (isContainer) liveRunIds.delete(runId);
            const retries = Math.max(0, (Number(job.retries) || 1) - 1);
            const msg = err instanceof ProvisionError ? err.message : `provisioning error: ${err.message}`;
            logger.warn(`[${jobType}] job ${job.jobKey} not provisioned — ${msg}; retries left ${retries}`);
            return job.fail({ errorMessage: msg.slice(0, 2000), retries, retryBackOff: 15_000 });
          }
        }

        let result;
        let gitResult = null;
        // C3 (#42): the per-job live-terminal relay session. Streams this job's
        // harness terminal on the relay lane tagged with its jobKey, and accepts
        // steer-in. Only when the worker is enrolled on the channel; closed in
        // the finally so its inbound-frame subscription never leaks across jobs.
        let relaySession = null;
        if (workChannel) {
          try {
            relaySession = createRelaySession({ channel: workChannel, jobKey: job.jobKey, logger });
          } catch (err) {
            relaySession = null;
            logger.warn(`[${jobType}] job ${job.jobKey}: relay session unavailable (${err?.message || err}); continuing without live terminal.`);
          }
        }
        // Private structured-result channel: hand the agent a file (outside any
        // repo clone so it can't be `git add`ed) to write its job-result vars to.
        let resultDir = null;
        let resultFile = null;
        try {
          try {
            mkdirSync(agentRunsRoot(), { recursive: true });
            resultDir = mkdtempSync(join(agentRunsRoot(), 'res-'));
            resultFile = join(resultDir, 'result.json');
            // Track it so the run-dir reaper skips it while in-flight and reaps it
            // (as a `res-*` dir) if this worker crashes before the cleanup below.
            liveRunDirs.add(resultDir);
          } catch { resultDir = null; resultFile = null; }

          result = await runAgentJob(profile, job, {
            timeoutMs: hardCapMs,
            idleTimeoutMs,
            envelope,
            sandbox,
            image,
            runId,
            secretEnv: resolved,
            passThroughSecretNames: names,
            cwd,
            extraEnv,
            profileEnv,
            resultFile,
            stream,
            streamPrefix: `[${jobType} ${job.jobKey}] `,
            args: effectiveArgs,
            // C3 (#42): a full PTY for a role that opted in, else a pipe. Both
            // stream on the relay lane when a relay session exists (skipped when
            // relaySession is null); only a PTY is interactively steerable.
            terminal: roleTerminal,
            // #110: harness protocol + ACP permission policy threaded to
            // runAgentJob. Inert in this seam task (pipe/pty dispatch unchanged);
            // the acp-executor task acts on them.
            protocol: roleProtocol,
            permission: rolePermission,
            relaySession,
            // Route the --stream tee through c8ctl's output-mode-aware logger so
            // spying never corrupts a structured/JSON output mode.
            onStreamOut: stream ? (line) => logger.info(line) : undefined,
            onStreamErr: stream ? (line) => logger.warn(line) : undefined,
          });

          // Finalize git only when the harness succeeded — never push a
          // half-finished workspace.
          if (provisioned && result.ok) {
            try {
              gitResult = finalizeGit({
                workspaceDir: provisioned.workspaceDir,
                gitEnv: provisioned.gitEnv,
                startSha: provisioned.startSha,
                workingBranch: provisioned.workingBranch,
                envelope,
                token: repoToken,
              });
            } catch (err) {
              gitResult = { remote: provisioned.remote, branch: provisioned.workingBranch, baseSha: provisioned.startSha || null, commits: [], pushed: false, error: redactToken(err.message, repoToken) };
            }
          } else if (provisioned) {
            gitResult = { remote: provisioned.remote, branch: provisioned.workingBranch, baseSha: provisioned.startSha || null, commits: [], pushed: false };
          }
        } finally {
          if (isContainer) liveRunIds.delete(runId);
          if (runDir && !keepRuns) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } }
          if (runDir) liveRunDirs.delete(runDir);
          // Detach the relay session's inbound-frame subscription so it never
          // outlives the job or leaks a steer listener across jobs.
          if (relaySession) { try { relaySession.close(); } catch { /* best effort */ } }
        }

        // Read the agent's structured result: the file it wrote, else a stdout
        // sentinel/`json fence fallback. The raw object is attached to the audit
        // envelope; the sanitized (reserved-key-stripped) vars are merged into the
        // job completion so the model sees `status`/`summary`/… as first-class
        // outputs. Read before deleting the temp dir.
        const rawResult = readAgentResultFile(resultFile) ?? parseResultFromStdout(result.stdout);
        if (resultDir) { try { rmSync(resultDir, { recursive: true, force: true }); } catch { /* best effort */ } liveRunDirs.delete(resultDir); }
        const resultVars = sanitizeResultVars(rawResult);

        const resultEnvelope = buildResultEnvelope(result, { sandbox, image, git: gitResult, result: rawResult, promptResourceKey });
        if (result.ok) {
          const gitNote = gitResult
            ? ` [${gitResult.branch ? `branch ${gitResult.branch}` : 'detached HEAD'}: ${gitResult.commits.length} commit(s), ${gitResult.branch ? (gitResult.pushed ? 'pushed' : (gitResult.pushError ? 'push FAILED' : 'not pushed')) : 'no branch to push'}${gitResult.pr?.found ? `, PR #${gitResult.pr.number}` : ''}]`
            : '';
          logger.info(`[${jobType}] job ${job.jobKey} complete (exit 0)${result.truncated ? ' [output truncated]' : ''}${gitNote}`);
          if (gitResult?.pushError) logger.warn(`[${jobType}] job ${job.jobKey}: branch push failed — ${gitResult.pushError}`);
          // Guard the operator against silent empty escalations: a success that
          // yields no *effective* result vars (no file/sentinel at all, an empty
          // `{}`, or only reserved keys that were sanitized away) means the
          // model's status/decision vars stay unset and any status gateway will
          // fall through to its default. Warn on the merged-vars emptiness, not
          // just a missing rawResult.
          const resultKeys = Object.keys(resultVars);
          if (resultKeys.length === 0) logger.warn(`[${jobType}] job ${job.jobKey}: agent returned no usable result vars — write a JSON object of result variables to $AGENT_RESULT_FILE (or print a "${RESULT_SENTINEL} {…}" line) so downstream gateways see status/summary/etc.`);
          else logger.info(`[${jobType}] job ${job.jobKey}: merged agent result vars [${resultKeys.join(', ')}]`);
          return await job.complete({
            ...resultVars,
            [AGENT_RESULT_KEY]: resultEnvelope,
            output: result.stdout,
            exitCode: 0,
            agent: profile.name,
            truncated: Boolean(result.truncated),
            ...(gitResult
              ? { branch: gitResult.branch, commits: gitResult.commits, pushed: gitResult.pushed, pullRequest: gitResult.pr || null }
              : {}),
          });
        }
        const retries = Math.max(0, (Number(job.retries) || 1) - 1);
        const detail = result.error
          || (result.stderr || '').trim() + (result.stderrTruncated && (result.stderr || '').trim() ? ' [stderr truncated]' : '')
          || (result.signal ? `terminated by signal ${result.signal}` : `exit code ${result.exitCode}`);
        logger.warn(`[${jobType}] job ${job.jobKey} failed (${detail}); retries left ${retries}`);
        return await job.fail({
          errorMessage: `agent "${profile.name}" failed: ${detail}`.slice(0, 2000),
          retries,
          variables: { [AGENT_RESULT_KEY]: resultEnvelope },
        });
        } finally {
          stopLockExtender();
          recordJobEnd(job);
        }
      },
    });

  // Live worker registry keyed by job type, so the profile watcher can add or
  // drain individual pollers without disturbing the others. `draining` is the
  // shutdown latch (shared with the watcher so a reconcile can't race a stop).
  const workers = new Map();
  let draining = false;

  const drainWorker = async (w) => {
    try {
      if (typeof w.stopGracefully === 'function') {
        await w.stopGracefully({ waitUpToMs: STOP_GRACE_MS });
      } else if (typeof w.stop === 'function') {
        await w.stop();
      }
      return true;
    } catch {
      return false; // best-effort: never let one worker's stop failure hang us
    }
  };

  const spawnJobType = (jobType) => {
    if (workers.has(jobType)) return false;
    workers.set(jobType, makeWorker(jobType));
    return true;
  };

  for (const jobType of jobTypes) spawnJobType(jobType);

  // ---- Live reconcile: keep the poller set in step with the desired job-type
  // set — start pollers for added types, gracefully drain pollers for removed
  // types — without a restart and without disturbing unchanged types' in-flight
  // work. The DESIRED set comes from one of two sources depending on mode:
  //   - default: the watched profile's rank×capability matrix (∪ --job-type),
  //     reconciled when the on-disk profile changes (e.g. `nano assign`);
  //   - --auto:  the engine's deployed *agent* job types, reconciled by polling
  //     the engine (the deployed set changes as apps deploy/undeploy). ----
  const configFile = getConfigFile();
  const WATCH_INTERVAL_MS = 1500;
  // How often `--auto` re-reads the engine's deployed agent job types to pick up
  // newly deployed / undeployed agent processes. Deploys are occasional, so a
  // few seconds of latency is fine; the read is a couple of cheap C8 REST calls.
  const AUTO_POLL_INTERVAL_MS = 5000;
  let reconciling = false;
  // Set when a profile change arrives while a reconcile is already in flight, so
  // we run one more pass after the current drain completes instead of dropping
  // the update until the next change fires.
  let reconcileRequested = false;
  // Handle to the in-flight reconcile so shutdown can wait for it to finish
  // before snapshotting `workers` (avoids double-stops / missed drains).
  let inFlightReconcile = null;

  // Desired job types. In `--auto` this is the engine's deployed agent job types
  // (∪ --job-type extras), read fresh each pass; a transient engine-read failure
  // returns { skip } so the running set is KEPT, never torn down. Otherwise it is
  // the CURRENT on-disk profile's matrix (∪ extras), with { skip } for a
  // transient/torn read, a vanished profile, or an invalid edit — callers must
  // then KEEP the running set, never tear down.
  const desiredJobTypes = async () => {
    if (autoMode) {
      try {
        const autoTypes = await resolveAutoJobTypes({ restConfig, scope: autoScope });
        return { jobTypes: [...new Set([...autoTypes, ...extraJobTypes])] };
      } catch (err) {
        return { skip: `engine read failed: ${err?.message || err}` };
      }
    }
    let stored;
    try {
      stored = readHiresStrict()[name];
    } catch {
      // config.json exists but doesn't parse (e.g. a torn write): the profile is
      // NOT necessarily gone, so don't claim it was deleted — skip this pass.
      return { skip: 'config unreadable' };
    }
    if (!stored) return { skip: 'deleted' };
    const norm = normalizeStoredProfile(name, stored);
    if (norm.error) return { skip: norm.error };
    const m = jobTypeMatrix(norm.profile.rank, norm.profile.capabilities);
    return { jobTypes: [...new Set([...m, ...extraJobTypes])] };
  };

  const reconcile = () => {
    if (draining) return inFlightReconcile || Promise.resolve();
    if (reconciling) {
      // A change landed mid-reconcile — remember it so the current pass loops
      // once more rather than leaving the worker set stale until the next edit.
      // Return the ACTUAL in-flight promise (not a fresh short-lived one) so a
      // caller — including shutdown — waits for the real reconcile to finish.
      reconcileRequested = true;
      return inFlightReconcile || Promise.resolve();
    }
    reconciling = true;
    reconcileRequested = false;
    inFlightReconcile = (async () => {
      try {
        do {
          reconcileRequested = false;
          await runReconcilePass();
        } while (reconcileRequested && !draining);
      } finally {
        reconciling = false;
        inFlightReconcile = null;
      }
    })();
    return inFlightReconcile;
  };

  const runReconcilePass = async () => {
      const desired = await desiredJobTypes();
      if (desired.skip) {
        if (autoMode) {
          logger.warn(`--auto reconcile skipped — ${desired.skip}; keeping the current ${workers.size} worker(s) running.`);
        } else if (desired.skip === 'deleted') {
          logger.warn(`Profile "${name}" is gone from config — keeping the current ${workers.size} worker(s) running.`);
        } else {
          logger.warn(`Profile "${name}" reload skipped — ${desired.skip}; keeping current workers.`);
        }
        return;
      }
      const { added, removed } = diffJobTypes([...workers.keys()], desired.jobTypes);
      if (added.length === 0 && removed.length === 0) return;
      const source = autoMode ? 'engine deployed set' : `Profile "${name}"`;
      logger.info(`${source} changed — reconciling job types (+${added.length} / -${removed.length}).`);
      for (const jt of added) {
        spawnJobType(jt);
        logger.info(`  + now listening on ${jt}`);
      }
      await Promise.all(
        removed.map(async (jt) => {
          const w = workers.get(jt);
          logger.info(`  - draining ${jt} …`);
          const ok = await drainWorker(w);
          if (ok) {
            // Only drop it from the registry once it has actually stopped, so a
            // failed drain stays tracked and gets retried on the next reconcile
            // pass (or on shutdown) instead of leaking an untracked poller.
            workers.delete(jt);
            logger.info(`  - stopped ${jt}`);
          } else {
            logger.warn(`  - ${jt} did not stop cleanly; keeping it tracked so it is retried on the next reconcile or shutdown.`);
          }
        }),
      );
      logger.info(`  now listening on ${workers.size} job type(s): ${[...workers.keys()].join('  ')}`);
  };

  // Reconcile trigger. In `--auto` a periodic engine poll re-reads the deployed
  // agent job types; otherwise a profile-file watch fires on profile edits.
  let autoPollTimer = null;
  if (autoMode) {
    // Self-standing interval poll (not watchFile) since the desired set is
    // derived from the engine, not the on-disk profile. Skip a tick while a
    // reconcile is already in flight: calling reconcile() then would set
    // reconcileRequested and make the in-flight pass loop back-to-back, so an
    // engine read that consistently outlasts AUTO_POLL_INTERVAL_MS would run
    // reconciles as fast as the read completes and hammer the broker. Skipping
    // keeps polling rate-limited to the configured interval regardless of
    // engine-read latency; the next tick re-reads the latest engine state.
    autoPollTimer = setInterval(() => {
      if (inFlightReconcile) return;
      reconcile().catch((err) => logger.warn(`--auto reconcile failed: ${err?.message || err}`));
    }, AUTO_POLL_INTERVAL_MS);
    // Deliberately REF'd (unlike the reaper/run-dir hygiene timers, which are
    // unref'd): in `--auto` this poll IS the retry loop, and it must keep the
    // process alive even with zero pollers. When the INITIAL engine read fails
    // (transient miss, or the engine isn't up yet) the worker registers 0
    // pollers; nothing else holds the event loop open (the SDK client with no
    // job workers doesn't, and the hygiene timers are unref'd), so an unref'd
    // poll timer would let the process exit 0 — the observed crash-loop under a
    // supervisor (jwulf/c8ctl-plugin-nano#93). Keeping it ref'd makes the worker
    // stay up and re-read on the next poll, exactly as the initial-read warning
    // promises. Shutdown clears it (clearInterval), so Ctrl-C/SIGTERM still exit.
  } else {
    // `watchFile` (polling stat) is deliberate over `fs.watch`: it survives the
    // atomic temp+rename that `writeConfig` does (fs.watch would rebind to the old
    // inode and go silent), and it's uniform across platforms. Profile edits are
    // rare + manual, so a ~1.5s poll latency is fine.
    watchFile(configFile, { interval: WATCH_INTERVAL_MS }, (curr, prev) => {
      // Fires each interval; act only on real changes. Compare mtime, ctime and
      // size, not mtime alone: on filesystems with coarse mtime resolution (or two
      // edits within one mtime tick) mtimeMs can be unchanged while size/ctimeMs
      // differ, and an mtime-only guard would skip a genuine profile update.
      if (
        curr.mtimeMs === prev.mtimeMs &&
        curr.ctimeMs === prev.ctimeMs &&
        curr.size === prev.size
      ) return;
      // `reconcile()` owns the `inFlightReconcile` handle: a change arriving while
      // a reconcile is already running coalesces into the current pass and returns
      // that same in-flight promise, so shutdown always waits for the real one.
      reconcile().catch((err) => logger.warn(`profile reload failed: ${err?.message || err}`));
    });
  }

  // Keep the process alive until a stop signal, then drain gracefully.
  await new Promise((resolve) => {
    const stop = async (signal) => {
      if (draining) return;
      draining = true;
      // Stop the reconcile trigger first so no new reconcile can be triggered,
      // then wait for any in-flight reconcile to finish before snapshotting
      // `workers` — this prevents double-stops, missed drains, or a wrong worker
      // count on exit.
      if (autoPollTimer) clearInterval(autoPollTimer);
      else unwatchFile(configFile);
      if (inFlightReconcile) {
        logger.info('Waiting for in-flight reconcile to finish before shutdown…');
        await inFlightReconcile;
      }
      const list = [...workers.values()];
      logger.info(`Received ${signal} — stopping ${list.length} worker(s)...`);
      if (reaperTimer) clearInterval(reaperTimer);
      if (runDirTimer) clearInterval(runDirTimer);
      const results = await Promise.all(list.map(drainWorker));
      const stopFailures = results.filter((ok) => !ok).length;
      if (stopFailures > 0) {
        logger.warn(`${stopFailures} of ${list.length} worker(s) did not stop cleanly; some connections may still be open.`);
      } else {
        logger.info('All workers stopped.');
      }
      // Deregister from the visibility channel LAST, so the worker disappears
      // from the page only once its jobs have drained. Best-effort — a channel
      // teardown must never hang shutdown.
      if (workChannel) {
        // Stop the buffer monitor first so its sampler can't fire mid-teardown.
        try {
          bufferMonitor?.stop();
        } catch { /* best effort */ }
        try {
          await workChannel.stop(`worker stopped (${signal})`);
          logger.info('Deregistered from the agentic visibility channel.');
        } catch (err) {
          logger.warn(`agentic channel deregister failed: ${err?.message || err}`);
        }
      }
      resolve();
    };
    process.once('SIGINT', () => { stop('SIGINT'); });
    process.once('SIGTERM', () => { stop('SIGTERM'); });
  });
}

// ---------------------------------------------------------------------------
// supervisor — run & manage a fleet of `nano work` children from one terminal.
//
// `nano work` needs the c8ctl host runtime (createClient), so worker loops
// cannot run inside a bare detached process. The supervisor is therefore a
// process *manager*: a detached daemon spawns one `c8ctl nano work <profile>`
// child per worker, restarts crashed children with capped backoff, and serves a
// control socket (newline-delimited JSON) used by both the management
// subcommands (status/add/remove/restart/stop/logs — no interactive surface
// needed) and the interactive `attach` console, which can be detached from
// (leaving the daemon running) or used to `stop` the whole fleet.
// ---------------------------------------------------------------------------

const SUPERVISOR_BACKOFF_BASE_MS = 1_000;
const SUPERVISOR_BACKOFF_MAX_MS = 30_000;
// A child that stayed up at least this long before exiting is not crash-looping,
// so its restart backoff is reset to zero.
const SUPERVISOR_HEALTHY_UPTIME_MS = 60_000;
const SUPERVISOR_CONNECT_TIMEOUT_MS = 6_000;
// End-to-end deadline for a single request: once connected, a wedged/incompatible
// daemon that accepts but never sends a `final` frame must not hang the client.
const SUPERVISOR_RESPONSE_TIMEOUT_MS = 15_000;
// Tighter end-to-end deadline for quick liveness probes (status checks used by
// liveSupervisor/ensureSupervisor). Without this, a daemon that accepts the
// connection but never returns a `final` frame would still block the "fast"
// probe for the full SUPERVISOR_RESPONSE_TIMEOUT_MS, hanging stop/remove/restart.
const SUPERVISOR_PROBE_RESPONSE_TIMEOUT_MS = 2_000;
// Hard cap on a single connection's inbound buffer, so a misbehaving client
// can't grow the daemon's memory without bound with a newline-free frame.
const SUPERVISOR_MAX_FRAME_BYTES = 1 << 20; // 1 MiB
// How often the daemon re-samples worker activity to push a refreshed status to
// attached consoles. The push is change-gated (see supervisorStatusSignature),
// so a quiet fleet stays silent; only real transitions (idle↔busy, a new job,
// restart/exit) reprint the table. `NANO_SUPERVISOR_MONITOR_MS=0` disables the
// live refresh (falling back to the attach-time snapshot + lifecycle events).
const SUPERVISOR_MONITOR_INTERVAL_MS = 1_000;

// How often an *attached* console re-ages and repaints its pinned status block
// locally, so UPTIME / job-age advance even while the fleet is quiet and the
// daemon's change-gated push stays silent (issue #83). Pure client-side; no
// extra daemon traffic.
const SUPERVISOR_LIVE_TICK_MS = 5_000;

// The `nano work` flags forwarded to each spawned child (reconstructed and
// normalized by `reconstructWorkArgs`, not passed through byte-for-byte).
// kind: 'value' → `--flag v`; 'boolean' → `--flag`; 'list' → repeated `--flag v`.
const WORK_FORWARD_FLAGS = {
  'job-timeout': 'value',
  'recovery-window': 'value',
  'idle-timeout': 'value',
  'lock-grace': 'value',
  'poll-timeout': 'value',
  sandbox: 'value',
  image: 'value',
  'secret-resolver': 'value',
  'reap-age': 'value',
  'reap-interval': 'value',
  'min-free-mb': 'value',
  'clone-timeout': 'value',
  'keep-runs': 'boolean',
  stream: 'boolean',
  auto: 'boolean',
  'auto-scope': 'value',
  arg: 'list',
  env: 'list',
  'job-type': 'list',
};

/**
 * Reconstruct the `work` argv tail from a parsed flags object, so `supervisor
 * add <profile> [work flags]` forwards those flags to the spawned child. Pure.
 */
function reconstructWorkArgs(flags) {
  const out = [];
  if (!flags || typeof flags !== 'object') return out;
  // `--auto-scope` is meaningless without `--auto` — `workAgent` exits fast with
  // "--auto-scope requires --auto". Forwarding the orphan flag to a supervised
  // worker would guarantee an immediate crash/restart loop, so drop it here at
  // the forwarding boundary when `--auto` is not truthy (mirrors that guard).
  // Parse booleans through `coerceBool()` so forwarding matches `workAgent`'s
  // parsing semantics — c8ctl may pass boolean flags as strings like `'1'`,
  // `'yes'` or `'on'`, and treating only `true`/`'true'` as enabled would
  // silently drop `--auto`/`--keep-runs`/`--stream` for supervised workers.
  const autoOn = coerceBool(flags.auto, false);
  for (const [name, kind] of Object.entries(WORK_FORWARD_FLAGS)) {
    if (name === 'auto-scope' && !autoOn) continue;
    const v = flags[name];
    if (v === undefined || v === null) continue;
    if (kind === 'boolean') {
      if (coerceBool(v, false)) out.push(`--${name}`);
    } else if (kind === 'list') {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (item === undefined || item === null) continue;
        out.push(`--${name}`, String(item));
      }
    } else if (v !== '') {
      out.push(`--${name}`, String(v));
    }
  }
  return out;
}

/**
 * Sanitize one token for use inside a worker name: keep `[A-Za-z0-9._-]`,
 * collapse every other run to a single `-`, and trim leading/trailing
 * separators. Returns `fallback` when nothing survives (e.g. an all-symbol
 * input). Pure.
 */
function sanitizeNameToken(raw, fallback = 'x') {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return s || fallback;
}

/**
 * An explicit worker name (`--name`) is valid iff — after trimming — it is a
 * non-empty run of `[A-Za-z0-9._-]`. That charset is the intersection of what
 * is safe in a broker `workerName` (no `:` to corrupt the `‹name›:‹jobType›`
 * form) and what survives `supervisorWorkerLogFile`'s filename sanitization
 * unchanged (so distinct ids can never collapse onto the same `worker-‹id›.log`
 * or escape the log dir). Auto-generated names are already in this shape;
 * operator-supplied names are validated against it so both invariants hold.
 * Pure.
 */
function isValidWorkerName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  return s !== '' && /^[A-Za-z0-9._-]+$/.test(s);
}

/** A short, lowercase, collision-resistant suffix for auto worker names. */
function randomNameSuffix(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Auto-generated worker name: `‹short-hostname›-‹profile›-‹random›`. The host
 * defaults to this machine's short hostname (the first dot-label, lowercased);
 * the random suffix keeps two same-profile workers on the same host distinct.
 * `host`/`rand` are injectable so tests can assert a deterministic shape. Pure
 * given its options.
 */
function autoWorkerName(profile, { host = hostname(), rand = randomNameSuffix } = {}) {
  const shortHost = sanitizeNameToken(String(host || '').split('.')[0].toLowerCase(), 'host');
  const prof = sanitizeNameToken(profile, 'worker');
  const suffix = sanitizeNameToken(typeof rand === 'function' ? rand() : rand, '0');
  return `${shortHost}-${prof}-${suffix}`;
}

/**
 * Split a supervised-worker name (`--name X`, `--name=X`, `-n X`) out of a raw
 * token list, returning `{ name, rest }` where `rest` is the remaining work
 * flags. Used by the interactive console's `add`, whose tokens aren't parsed by
 * the CLI flag layer. Last occurrence wins; a trailing `--name` with no value
 * yields `name: undefined`. Pure.
 */
function extractNameFlag(parts) {
  const rest = [];
  let name;
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    const tok = String(list[i]);
    const eq = /^(?:--name|-n)=(.*)$/.exec(tok);
    if (eq) { name = eq[1]; continue; }
    if (tok === '--name' || tok === '-n') {
      if (i + 1 < list.length) { name = String(list[i + 1]); i++; }
      continue;
    }
    rest.push(tok);
  }
  return { name: name != null && name.trim() !== '' ? name.trim() : undefined, rest };
}

/**
 * Upper bound on how many workers a single `supervisor add --instances N` may
 * spawn. Not a fleet cap (add again to grow further) — a typo guard, so a
 * fat-fingered `--instances 100000` can't fork-bomb the host in one keystroke.
 */
const MAX_ADD_INSTANCES = 64;

/**
 * Parse the `--instances N` count for `supervisor add` / `workforce add`
 * (the caller passes its own `cmdLabel`, which appears in the over-cap error).
 * Accepts undefined/blank (defaults to 1), and a whole number in
 * `[1, MAX_ADD_INSTANCES]`. Rejects non-integers, zero/negatives, and anything
 * over the cap with a clear message. When a flag is repeated the last
 * occurrence wins (arrays are tolerated). Returns `{ count }` on success or
 * `{ error }` on rejection. Pure.
 */
function parseInstancesCount(raw, cmdLabel = 'supervisor add') {
  const v = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return { count: 1 };
  }
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return { error: `Invalid --instances "${v}": use a whole number between 1 and ${MAX_ADD_INSTANCES}.` };
  const n = Number.parseInt(s, 10);
  if (n < 1) return { error: `Invalid --instances "${v}": use a whole number between 1 and ${MAX_ADD_INSTANCES}.` };
  if (n > MAX_ADD_INSTANCES) {
    // `supervisor add` accumulates workers, so exceeding the cap can be worked
    // around by re-running the command. Workforce entries are updated in place,
    // so the cap is a hard per-entry maximum — the rerun hint would mislead.
    return {
      error: cmdLabel === 'supervisor add'
        ? `--instances ${n} exceeds the ${MAX_ADD_INSTANCES}-per-command cap; run "${cmdLabel}" again to add more.`
        : `--instances ${n} exceeds the ${MAX_ADD_INSTANCES}-per-entry maximum.`,
    };
  }
  return { count: n };
}

/**
 * Split `--instances N` / `--instances=N` out of a raw token list, returning
 * `{ count, rest, error }` where `rest` is the remaining work flags (with the
 * flag removed so it is never forwarded to `nano work`). Used by the interactive
 * console's `add`, whose tokens aren't parsed by the CLI flag layer. Last
 * occurrence wins; a trailing `--instances` with no value is treated as absent
 * (count 1), mirroring `extractNameFlag`. Pure.
 */
function extractInstancesFlag(parts) {
  const rest = [];
  let raw;
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    const tok = String(list[i]);
    const eq = /^--instances=(.*)$/.exec(tok);
    if (eq) { raw = eq[1]; continue; }
    if (tok === '--instances') {
      if (i + 1 < list.length) { raw = String(list[i + 1]); i++; }
      continue;
    }
    rest.push(tok);
  }
  return { ...parseInstancesCount(raw), rest };
}

/** Assign a unique, stable worker id from a profile name (pure). */
function supervisorWorkerId(profile, taken) {
  const base = String(profile || '').trim() || 'worker';
  const set = taken instanceof Set ? taken : new Set(taken || []);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}#${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * Redact sensitive values from a reconstructed `work` argv before logging, so
 * supervisor logs never capture secrets. Both `--env NAME=VALUE` and the
 * inline `--env=NAME=VALUE` form become `NAME=***` (the value passed to
 * `nano work` is untouched). Pure.
 */
function redactWorkArgs(args) {
  const out = [];
  const list = Array.isArray(args) ? args : [];
  const redactPair = (pair) => {
    const eq = pair.indexOf('=');
    return eq === -1 ? '***' : `${pair.slice(0, eq)}=***`;
  };
  for (let i = 0; i < list.length; i++) {
    const tok = String(list[i]);
    if (tok === '--env' && i + 1 < list.length) {
      out.push(tok, redactPair(String(list[i + 1])));
      i++;
    } else if (tok.startsWith('--env=')) {
      out.push(`--env=${redactPair(tok.slice('--env='.length))}`);
    } else {
      out.push(tok);
    }
  }
  return out;
}

/** Capped exponential restart backoff for a crash-looping child (pure). */
function supervisorBackoffMs(restarts, base = SUPERVISOR_BACKOFF_BASE_MS, max = SUPERVISOR_BACKOFF_MAX_MS) {
  const n = Math.max(0, Number(restarts) || 0);
  return Math.min(max, base * 2 ** Math.min(n, 20));
}

/** Newline-delimited JSON framing for the control socket (pure). */
function encodeFrame(obj) {
  return JSON.stringify(obj) + '\n';
}

/** Split a buffered string into complete JSON frames + a remainder (pure). */
function decodeFrames(buffer) {
  const frames = [];
  let rest = String(buffer ?? '');
  let idx;
  while ((idx = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try { frames.push(JSON.parse(line)); } catch { /* skip malformed frame */ }
  }
  return { frames, rest };
}

/** Humanise a millisecond duration compactly (pure). */
function formatDuration(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/** Project a live/stored worker record to a status row (pure w.r.t. `now`). */
function summarizeSupervisorWorker(w, now = Date.now()) {
  const alive = isPidAlive(w.pid);
  // Absolute base epoch (ms) the worker started, so an attached console can
  // re-age `uptimeMs` locally on each tick (see reageSupervisorStatus) without
  // the daemon re-broadcasting. `uptimeMs` is the value at snapshot time; it and
  // `startedAtMs` are kept in lock-step here so a consumer can use either.
  const startedAtEpoch = alive && w.startedAt ? new Date(w.startedAt).getTime() : null;
  const startedAtMs = Number.isFinite(startedAtEpoch) ? startedAtEpoch : null;
  const uptimeMs = startedAtMs != null ? Math.max(0, now - startedAtMs) : 0;
  // Per-job activity (supervised workers only). Guard on pid so a stale marker
  // left by a previous incarnation can't show a dead job as in-flight.
  let activity = null; // { state: 'busy'|'idle', jobs: [{ key, type, sinceMs, sinceEpochMs }] }
  let engine = null; // job-polling engine base URL this worker reported (#99)
  let agentic = null; // { status, mode, url, discovered } agentic-channel state (#99)
  if (alive) {
    const act = readWorkerActivity(w.id);
    if (act && act.pid === w.pid) {
      const jobs = Array.isArray(act.jobs)
        ? act.jobs.map((j) => ({
            key: String(j.key),
            type: j.type ?? null,
            // Both the snapshot-time duration and its absolute base, so the
            // console can re-age the job cell locally (mirrors uptimeMs above).
            sinceMs: Number.isFinite(j.since) ? Math.max(0, now - j.since) : null,
            sinceEpochMs: Number.isFinite(j.since) ? j.since : null,
          }))
        : [];
      activity = { state: jobs.length > 0 ? 'busy' : 'idle', jobs };
      // Engine + agentic-channel status ride the same pid-guarded marker, so a
      // stale incarnation can't show a dead worker as connected to a hub.
      engine = typeof act.engine === 'string' && act.engine ? act.engine : null;
      agentic = act.agentic && typeof act.agentic === 'object' ? act.agentic : null;
    }
    // No marker (or a stale-pid one): leave activity null → rendered as unknown.
  }
  return {
    id: w.id,
    profile: w.profile,
    pid: alive ? w.pid : null,
    state: w.stopping ? 'stopping' : alive ? 'running' : 'down',
    restarts: Number(w.restarts) || 0,
    uptimeMs,
    startedAtMs,
    lastExit: w.lastExit ?? null,
    args: Array.isArray(w.args) ? w.args : [],
    // The per-worker log path (logs/supervisor/worker-<id>.log). Carried through
    // so `supervisor status` can surface it (see formatSupervisorLogsLines);
    // null when the source record predates it (e.g. an older persisted state).
    logFile: w.logFile ?? null,
    activity,
    engine,
    agentic,
  };
}

/**
 * A stable fingerprint of the fleet's *observable* state for change detection.
 * Deliberately excludes ticking durations (uptimeMs, per-job sinceMs) so that a
 * merely-elapsing clock doesn't count as a change — only real transitions (a
 * worker going up/down, idle↔busy, picking up/finishing a job, a restart) alter
 * the signature. The daemon uses this to push a refreshed status to attached
 * consoles only when something actually changed, keeping a quiet fleet silent.
 * `workers` is an array of `summarizeSupervisorWorker` results.
 */
function supervisorStatusSignature(workers) {
  const list = Array.isArray(workers) ? workers : [];
  return JSON.stringify(
    list.map((w) => [
      w.id,
      w.profile ?? '',
      w.state,
      w.pid ?? 0,
      Number(w.restarts) || 0,
      w.lastExit ?? '',
      w.activity ? w.activity.state : null,
      w.activity
        ? w.activity.jobs.map((j) => `${j.key}\u0000${j.type ?? ''}`).sort()
        : null,
      // Engine + agentic-channel status: a connect/disconnect or an engine
      // change is a real transition that must repaint attached consoles (#99).
      w.engine ?? '',
      w.agentic ? (w.agentic.status ?? '') : null,
    ]),
  );
}

/** One-line JOB cell for a status row: the serviced job key, `idle`, or `-`. */
function supervisorJobCell(w) {
  if (w.state !== 'running') return '-';
  const a = w.activity;
  if (!a) return '?'; // alive but not reporting (older worker / marker not yet written)
  if (a.state !== 'busy' || a.jobs.length === 0) return 'idle';
  const [first, ...rest] = a.jobs;
  const dur = first.sinceMs != null ? ` (${formatDuration(first.sinceMs)})` : '';
  const more = rest.length > 0 ? ` +${rest.length}` : '';
  return `${first.key}${more}${dur}`;
}

/**
 * ENGINE cell: the authority (host:port) of the engine this worker polls jobs
 * from, so an operator can see cross-machine fleets at a glance. `-` for a
 * down/stopping worker, `?` for a live worker not (yet) reporting or on an
 * older build whose marker predates this field. A non-URL engine string falls
 * back to the raw value.
 */
function supervisorEngineCell(w) {
  if (w.state !== 'running') return '-';
  if (!w.activity) return '?'; // alive but not reporting
  if (!w.engine) return '?'; // reporting, but marker predates the engine field
  try {
    const host = new URL(w.engine).host;
    return host || String(w.engine); // a scheme-less string parses host-empty
  } catch { return String(w.engine); }
}

/**
 * AGENTIC cell: the visibility-channel status word
 * (`connected`/`connecting`/`disconnected`/`advisory`/`off`/`starting`), so an
 * operator can tell whether presence actually reached the Workforce hub. `-`
 * for a down/stopping worker, `?` for a live worker not (yet) reporting or on an
 * older build whose marker predates this field.
 */
function supervisorAgenticCell(w) {
  if (w.state !== 'running') return '-';
  if (!w.activity) return '?'; // alive but not reporting
  if (!w.agentic || !w.agentic.status) return '?'; // marker predates the agentic field
  return String(w.agentic.status);
}

/**
 * Re-age a supervisor status snapshot to `now`, recomputing the ticking
 * durations (`uptimeMs`, per-job `sinceMs`) from the absolute base epochs the
 * daemon includes (`startedAtMs`, `sinceEpochMs`). This lets an attached
 * console tick UPTIME / job-age locally on its own timer — no re-broadcast —
 * so a quiet-but-busy fleet's clocks still advance. Pure: returns a new object,
 * never mutates its input. Workers whose base epoch is absent (an older daemon,
 * or a down worker with no start) keep their snapshot-time value. Non-array /
 * non-object shapes pass through untouched, so it is safe on any frame.
 */
function reageSupervisorStatus(status, now = Date.now()) {
  if (!status || typeof status !== 'object') return status;
  const workers = Array.isArray(status.workers) ? status.workers : null;
  if (!workers) return status;
  return {
    ...status,
    workers: workers.map((w) => {
      if (!w || typeof w !== 'object') return w;
      const uptimeMs =
        Number.isFinite(w.startedAtMs) ? Math.max(0, now - w.startedAtMs) : w.uptimeMs;
      let activity = w.activity;
      if (activity && Array.isArray(activity.jobs)) {
        activity = {
          ...activity,
          jobs: activity.jobs.map((j) =>
            j && typeof j === 'object' && Number.isFinite(j.sinceEpochMs)
              ? { ...j, sinceMs: Math.max(0, now - j.sinceEpochMs) }
              : j,
          ),
        };
      }
      return { ...w, uptimeMs, activity };
    }),
  };
}

/**
 * Clamp a line to `width` display columns, appending `…` when it is truncated,
 * so a pinned in-place status block keeps one logical line per terminal row —
 * the invariant the console's redraw cursor-math depends on (a wrapped row
 * would desync the up-count). `width < 1` or a non-finite width is treated as
 * "no clamp". Pure.
 */
function clampToWidth(line, width) {
  const s = String(line ?? '');
  if (!Number.isFinite(width) || width < 1 || s.length <= width) return s;
  if (width === 1) return '…';
  return s.slice(0, width - 1) + '…';
}

/**
 * A pinned in-place status "block" for the attached `supervisor>` console
 * (issue #83). Instead of appending a fresh table on every change, it keeps a
 * single block just above the readline prompt and *mutates it in place*:
 * `status()` / `repaint()` erase the previously-painted rows (cursor up N +
 * clear-to-end) and redraw, so the table updates without scrolling a new copy
 * into the backlog. `write()` emits scrolling history (events, command replies)
 * above the block. Durations are re-aged to `now()` on every paint (see
 * reageSupervisorStatus) so a ~5s tick advances UPTIME / job-age with no
 * re-broadcast. On a non-TTY (`isTty === false`) there is no cursor addressing:
 * `status()` appends the table and `write()` is a plain line — the classic
 * behavior. Each block line is clamped to the terminal width so one logical
 * line is exactly one terminal row, keeping the erase cursor-math exact.
 *
 * Dependencies are injected (stream, columns getter, prompt refresh, clock) so
 * the render orchestration is unit-testable against a fake capturing stream.
 */
function createSupervisorLiveView({
  stream,
  isTty,
  columns = () => 80,
  refreshPrompt = () => {},
  now = () => Date.now(),
}) {
  let lastStatus = null;
  let blockLines = 0; // terminal rows the block currently occupies

  const blockText = () => {
    if (!lastStatus) return '';
    const cols = columns();
    return formatSupervisorStatus(reageSupervisorStatus(lastStatus, now()))
      .split('\n')
      .map((l) => clampToWidth(l, cols))
      .join('\n');
  };

  // Erase the painted block (if any) + the prompt line, leaving the cursor at
  // column 0 on the row where the block should restart.
  const erase = () => {
    rlCursorTo(stream, 0);
    if (blockLines > 0) rlMoveCursor(stream, 0, -blockLines);
    rlClearScreenDown(stream);
  };

  // Draw the (re-aged) block, then re-render the prompt below it.
  const draw = () => {
    const text = blockText();
    if (text) { stream.write(text + '\n'); blockLines = text.split('\n').length; }
    else blockLines = 0;
    refreshPrompt();
  };

  return {
    /** New snapshot → mutate the block in place (TTY) or append it (non-TTY). */
    status(frame) {
      lastStatus = frame;
      if (isTty) { erase(); draw(); }
      else { stream.write('\n'); stream.write(formatSupervisorStatus(reageSupervisorStatus(frame, now())) + '\n'); }
    },
    /** Repaint the current snapshot re-aged to now (the ~5s tick / resize). */
    repaint() { if (isTty && lastStatus) { erase(); draw(); } },
    /** Scrolling history above the block; a plain append on a non-TTY. */
    write(text) {
      const s = String(text);
      if (!isTty) { stream.write(s + '\n'); return; }
      erase();
      stream.write(s + '\n');
      draw();
    },
    /** Rows the block currently occupies (test/inspection). */
    blockRows() { return blockLines; },
    /** Whether a snapshot has been received (test/inspection). */
    hasStatus() { return lastStatus != null; },
  };
}

/**
 * The `Logs:` block for `supervisor status`, derived purely from the status
 * payload so it renders identically for a live daemon status and a synthesized
 * one. Lists the daemon log and each worker's log file, plus a hint at the
 * existing tailer. Returns an empty array (no section) when no log path is
 * known — an older persisted state, or a dead daemon whose frame carried none.
 */
function formatSupervisorLogsLines(status) {
  const daemonLog = status?.daemon?.logFile || null;
  const workers = Array.isArray(status?.workers) ? status.workers : [];
  const workerLogs = workers
    .filter((w) => w && w.logFile)
    .map((w) => ({ label: String(w.id), path: String(w.logFile) }));
  const entries = [];
  if (daemonLog) entries.push({ label: 'daemon', path: String(daemonLog) });
  for (const w of workerLogs) entries.push(w);
  if (entries.length === 0) return [];
  const labelWidth = Math.max(...entries.map((e) => e.label.length));
  const out = ['', 'Logs:'];
  for (const e of entries) out.push(`  ${e.label.padEnd(labelWidth)}  ${e.path}`);
  out.push('  View: c8ctl nano supervisor logs [<id>] [--follow]');
  return out;
}

/** Render a supervisor status object as an aligned text table. */
function formatSupervisorStatus(status) {
  const lines = [];
  const d = status.daemon || {};
  const alive = d.pid ? isPidAlive(d.pid) : false;
  lines.push('Supervisor:');
  lines.push(`  daemon pid: ${d.pid ?? '-'} ${alive ? '(alive)' : '(dead — stale state)'}`);
  if (d.startedAt) lines.push(`  started:    ${d.startedAt}`);
  if (d.socket) lines.push(`  control:    ${d.socket}`);
  const workers = Array.isArray(status.workers) ? status.workers : [];
  lines.push('');
  if (workers.length === 0) {
    lines.push('  No workers. Add one with: c8ctl nano supervisor add <profile>');
    lines.push(...formatSupervisorLogsLines(status));
    return lines.join('\n');
  }
  const rows = workers.map((w) => ({
    id: String(w.id),
    profile: String(w.profile),
    state: String(w.state),
    engine: supervisorEngineCell(w),
    agentic: supervisorAgenticCell(w),
    job: supervisorJobCell(w),
    pid: w.pid ? String(w.pid) : '-',
    restarts: String(w.restarts),
    uptime: w.state === 'running' ? formatDuration(w.uptimeMs) : '-',
    last: w.lastExit ? String(w.lastExit) : '-',
  }));
  // ENGINE + AGENTIC sit early (just after STATE) so the pinned live view's
  // width clamp (which trims from the right) drops the least-critical columns
  // (LAST EXIT, UPTIME) first and keeps the visibility diagnostics visible.
  const head = { id: 'ID', profile: 'PROFILE', state: 'STATE', engine: 'ENGINE', agentic: 'AGENTIC', job: 'JOB', pid: 'PID', restarts: 'RESTARTS', uptime: 'UPTIME', last: 'LAST EXIT' };
  const cols = ['id', 'profile', 'state', 'engine', 'agentic', 'job', 'pid', 'restarts', 'uptime', 'last'];
  const width = {};
  for (const c of cols) width[c] = Math.max(head[c].length, ...rows.map((r) => r[c].length));
  const fmt = (r) => '  ' + cols.map((c) => r[c].padEnd(width[c])).join('  ');
  lines.push(fmt(head));
  for (const r of rows) lines.push(fmt(r));
  lines.push(...formatSupervisorLogsLines(status));
  return lines.join('\n');
}

/**
 * Print a preformatted supervisor status table as primary command output.
 *
 * Preformatted, multi-line text MUST go through the logger's `output()`
 * channel, never `info()`. In `--output json` mode the c8ctl host logger wraps
 * an `info()` message in a JSON envelope (`{"status":"info","message":"…"}`),
 * which escapes every newline to a literal `\n` and collapses the aligned table
 * onto a single line — the exact breakage this guards against. `output()` writes
 * the content to stdout verbatim in every output mode (like `raw` command
 * output), so the table renders correctly regardless of mode. Falls back to
 * `info()` for a logger without `output()`, and to `console.log` if `logger`
 * is null/undefined or lacks `info()` (defensive; both the c8ctl host logger
 * and this plugin's fallback logger provide `output()`).
 */
function printSupervisorStatus(logger, status) {
  const text = formatSupervisorStatus(status);
  if (logger && typeof logger.output === 'function') logger.output(text);
  else if (logger && typeof logger.info === 'function') logger.info(text);
  else console.log(text);
}

function readSupervisorState() {
  const file = getSupervisorStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSupervisorState(state) {
  mkdirSync(getStateHome(), { recursive: true });
  // Atomic + owner-only: write to a same-dir temp file (mode 0600) then rename
  // over the target, so a concurrent reader never sees a torn file and the
  // state (which records worker argv) isn't world-readable.
  const target = getSupervisorStateFile();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { renameSync(tmp, target); }
  catch (err) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw err; }
}

function clearSupervisorState() {
  const file = getSupervisorStateFile();
  try { if (existsSync(file)) rmSync(file); } catch { /* best effort */ }
}

/** Running daemon state (pid alive) or null. */
function runningSupervisor() {
  const state = readSupervisorState();
  return state && isPidAlive(state.pid) ? state : null;
}

/** Synthesize a state-file-shaped object from a live `status` response. */
function stateFromStatus(res, socketPath) {
  return {
    pid: res.daemon?.pid,
    startedAt: res.daemon?.startedAt,
    socket: res.daemon?.socket || socketPath,
    logFile: res.daemon?.logFile,
    workers: res.workers || [],
  };
}

/**
 * Resolve a live supervisor, healing a missing/stale state file. Returns the
 * running state (pid alive) if present; otherwise probes the deterministic
 * control socket and, if a daemon answers, re-persists and returns its state so
 * management commands still work when supervisor.json was deleted/cleaned.
 * Returns null when nothing is listening.
 */
async function liveSupervisor() {
  const running = runningSupervisor();
  if (running) return running;
  try {
    const socketPath = getSupervisorSocketPath();
    const res = await supervisorRequest({ op: 'status' }, { socketPath, timeoutMs: 500, responseTimeoutMs: SUPERVISOR_PROBE_RESPONSE_TIMEOUT_MS });
    if (res && res.ok) {
      const state = stateFromStatus(res, socketPath);
      try { writeSupervisorState(state); } catch { /* best effort */ }
      return state;
    }
  } catch { /* no live daemon on the socket */ }
  return null;
}

/** How to re-invoke the c8ctl CLI to spawn the daemon + `work` children. */
function c8ctlInvocation() {
  const entry = process.env.C8CTL_NANO_ENTRY || process.argv[1];
  return { exec: process.execPath, entry };
}

function supervisorDaemonLogFile() {
  return join(getSupervisorLogDir(), 'daemon.log');
}

function supervisorWorkerLogFile(id) {
  return join(getSupervisorLogDir(), `worker-${String(id).replace(/[^\w.#-]/g, '_')}.log`);
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
    const t = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
  });
}

/**
 * Self-terminate a supervised worker if its parent daemon dies *ungracefully*.
 *
 * The daemon reaps its `nano work` children on a clean stop/SIGTERM/SIGINT (see
 * `shutdown`). But a `SIGKILL`, a crash, or the daemon's host process being
 * force-killed cannot run that path, and the children — spawned attached, with
 * no controlling TTY — would otherwise survive forever as orphans reparented to
 * init (ppid 1). That is exactly how a test/agent run that force-kills its
 * supervisor leaks a whole idle worker fleet.
 *
 * The watchdog closes that gap from the child's side. The parent to watch is the
 * daemon pid the spawn recorded (`parentPid`, forwarded via
 * NANO_SUPERVISOR_DAEMON_PID) rather than a late `process.ppid` sample: a worker
 * whose ~async startup (an 8k-line dynamic import) is outrun by the daemon's
 * death is *already* reparented to init by the time it arms, so a bare
 * `process.ppid` read would miss the very race that leaks. Given the known pid,
 * the worker self-reaps whenever it is reparented away from it OR that pid is
 * gone — and does so *immediately* if it was orphaned during its own startup.
 *
 * The poll timer is unref'd so it never keeps an otherwise-idle worker alive;
 * the real work loop (or, in tests, an explicit keep-alive) holds the event loop
 * open while the worker is meant to run.
 *
 * Unix-only: reparent-to-init is a POSIX semantic; Windows job objects are the
 * equivalent lifecycle tie and are out of scope here (matching the daemon's
 * other `win32` guards). Returns a canceller so callers/tests can stop it.
 */
function installParentDeathWatchdog({ intervalMs = 2000, parentPid, onOrphan, readPpid } = {}) {
  if (osPlatform() === 'win32') return () => {};
  // `readPpid` is an injectable seam (defaults to the live value) so the pid-1
  // container case — which a normal test process can't reproduce, since its own
  // ppid is never 1 — is unit-testable.
  const ppid = typeof readPpid === 'function' ? readPpid : () => process.ppid;
  // Prefer the daemon pid the spawn recorded (`explicit`); fall back to the
  // current parent. An explicit pid is authoritative even if it is 1 — the
  // daemon may legitimately run as PID 1 (a container entrypoint) — so we must
  // NOT treat that as "orphaned". A *fallback* ppid of 1, by contrast, means we
  // were already reparented to init with no daemon left to watch.
  const explicit = Number.isInteger(parentPid) && parentPid > 0;
  const watched = explicit ? parentPid : ppid();
  const orphaned = typeof onOrphan === 'function' ? onOrphan : () => process.exit(0);
  const isOrphan = () => {
    // Reparented away from the daemon (typically to init, pid 1) → orphaned.
    if (ppid() !== watched) return true;
    // Defensive: the daemon pid is gone even though ppid still names it (a
    // zombie/racey read). ESRCH ⇒ gone; EPERM ⇒ alive but not ours to signal.
    try { process.kill(watched, 0); return false; } catch (err) { return err.code !== 'EPERM'; }
  };
  // Orphaned already — self-reap now rather than idle forever. Either we fell
  // back to ppid and it is already init (no known parent), or the recorded
  // daemon is verifiably gone/reparented (e.g. it died before we armed).
  if ((!explicit && watched === 1) || isOrphan()) { orphaned(); return () => {}; }
  const timer = setInterval(() => { if (isOrphan()) { clearInterval(timer); orphaned(); } }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => { try { clearInterval(timer); } catch { /* ignore */ } };
}

// --- Daemon ----------------------------------------------------------------

/**
 * The supervisor daemon body. Runs under `c8ctl nano supervisor __daemon`,
 * spawned detached by `startSupervisorDaemon`. Never returns — it runs until a
 * stop request or SIGTERM, then drains children and exits.
 */
async function runSupervisorDaemon() {
  const startedAt = new Date().toISOString();
  const { exec, entry } = c8ctlInvocation();
  const socketPath = getSupervisorSocketPath();
  const daemonLogFile = supervisorDaemonLogFile();
  mkdirSync(getSupervisorLogDir(), { recursive: true });

  const workers = new Map();
  const attachClients = new Set();
  let shuttingDown = false;
  // Live-view monitor: tracks the last-broadcast fleet signature so we push a
  // refreshed status to attached consoles only on real change (see below).
  let monitorTimer = null;
  let lastMonitorSig = null;

  // Daemon-wide mutation serialization: `add`/`remove`/`restart` must not
  // interleave, or two clients racing the same worker could each spawn an
  // untracked child. Every mutation runs to completion before the next starts.
  let opQueue = Promise.resolve();
  const serializeOp = (fn) => {
    const run = opQueue.then(fn, fn);
    opQueue = run.then(() => {}, () => {});
    return run;
  };

  const dlog = (msg) => {
    try { appendFileSync(daemonLogFile, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best effort */ }
  };

  const workerPublic = (w) => summarizeSupervisorWorker(w);

  const persist = () => {
    try {
      writeSupervisorState({
        pid: process.pid,
        startedAt,
        socket: socketPath,
        logFile: daemonLogFile,
        workers: [...workers.values()].map((w) => ({
          id: w.id, profile: w.profile, args: w.args, pid: isPidAlive(w.pid) ? w.pid : null,
          startedAt: w.startedAt || null, restarts: w.restarts, lastExit: w.lastExit ?? null,
          stopping: !!w.stopping, logFile: w.logFile,
        })),
      });
    } catch { /* best effort */ }
  };

  const broadcast = (frame) => {
    const data = encodeFrame(frame);
    for (const sock of attachClients) {
      try { sock.write(data); } catch { /* client gone */ }
    }
  };

  const startWorker = (w) => {
    let fd;
    try { fd = openSync(w.logFile, 'a'); } catch { fd = 'ignore'; }
    // Clear any stale activity marker from a previous incarnation so a freshly
    // (re)started worker never briefly shows a dead job as in-flight.
    const activityFile = supervisorWorkerActivityFile(w.id);
    w.activityFile = activityFile;
    try { rmSync(activityFile, { force: true }); } catch { /* best effort */ }
    // `--name w.id` makes the child's broker workerName match this worker's
    // supervisor id, so the same profile launched twice is distinct end-to-end.
    // NANO_SUPERVISOR_ACTIVITY_FILE tells the child where to report per-job
    // activity for `supervisor status` (idle vs the job key it is servicing).
    // NANO_SUPERVISOR_DAEMON_PID hands the child our pid so its parent-death
    // watchdog can self-reap if we die ungracefully (SIGKILL/crash) and can't
    // run the child-draining shutdown — even if we die mid-startup, before the
    // child reparents to init.
    const child = spawn(exec, [entry, 'nano', 'work', w.profile, '--name', w.id, ...w.args], {
      env: { ...process.env, NANO_SUPERVISOR_ACTIVITY_FILE: activityFile, NANO_SUPERVISOR_DAEMON_PID: String(process.pid) },
      stdio: ['ignore', fd, fd],
    });
    if (typeof fd === 'number') { try { closeSync(fd); } catch { /* dup'd into child */ } }
    w.child = child;
    w.pid = child.pid || null;
    w.startedAt = new Date().toISOString();
    w.spawnedAt = Date.now();
    dlog(`worker '${w.id}' (profile ${w.profile}) started pid ${w.pid}: work ${[w.profile, ...redactWorkArgs(w.args)].join(' ')}`);
    broadcast({ type: 'event', event: 'worker-start', worker: workerPublic(w) });

    // A spawn failure (ENOENT/EMFILE/…) emits only 'error' with no 'exit', so
    // both paths funnel through one death handler that schedules a restart.
    // `settled` guards the error+exit double-fire; the `w.child !== child` check
    // ignores a stale child's late exit after `restart` swapped in a new one
    // (which would otherwise clobber the live pid and leak a duplicate worker).
    let settled = false;
    const handleDeath = (reason) => {
      if (w.child !== child || settled) return;
      settled = true;
      w.pid = null;
      w.lastExit = reason;
      // Drop the activity marker — a dead worker services no job.
      try { rmSync(w.activityFile || supervisorWorkerActivityFile(w.id), { force: true }); } catch { /* best effort */ }
      const ranMs = Date.now() - (w.spawnedAt || Date.now());
      if (ranMs >= SUPERVISOR_HEALTHY_UPTIME_MS) w.restarts = 0;
      if (w.stopping || shuttingDown || !workers.has(w.id)) { persist(); return; }
      const delay = supervisorBackoffMs(w.restarts);
      w.restarts += 1;
      dlog(`worker '${w.id}' down (${reason}); restarting in ${delay}ms (restart #${w.restarts})`);
      broadcast({ type: 'event', event: 'worker-exit', worker: workerPublic(w), restartInMs: delay });
      w.restartTimer = setTimeout(() => {
        w.restartTimer = null;
        if (!w.stopping && !shuttingDown && workers.has(w.id)) startWorker(w);
      }, delay);
      if (typeof w.restartTimer.unref === 'function') w.restartTimer.unref();
      persist();
    };
    child.on('error', (err) => handleDeath(`spawn error: ${err.message}`));
    child.on('exit', (code, signal) => handleDeath(signal ? `signal ${signal}` : `code ${code}`));
    persist();
  };

  const addWorker = (profile, args, name) => {
    const taken = new Set(workers.keys());
    let id;
    if (name != null && String(name).trim() !== '') {
      id = String(name).trim();
      if (!isValidWorkerName(id)) throw new Error(`invalid worker name "${id}": use only letters, digits, and . _ -`);
      if (taken.has(id)) throw new Error(`a worker named "${id}" already exists`);
    } else {
      // No explicit name → auto ‹host›-‹profile›-‹random›. The random suffix is
      // collision-resistant, but never hand back a duplicate id.
      id = autoWorkerName(profile);
      while (taken.has(id)) id = autoWorkerName(profile);
    }
    const w = {
      id, profile: String(profile), args: Array.isArray(args) ? args.map(String) : [],
      restarts: 0, stopping: false, lastExit: null, logFile: supervisorWorkerLogFile(id),
    };
    workers.set(id, w);
    startWorker(w);
    return w;
  };

  const stopWorker = async (id) => {
    const w = workers.get(id);
    if (!w) return false;
    w.stopping = true;
    if (w.restartTimer) { clearTimeout(w.restartTimer); w.restartTimer = null; }
    const pid = w.pid;
    if (w.child && pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await waitForChildExit(w.child, STOP_GRACE_MS);
      if (isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
    }
    return true;
  };

  const removeWorker = async (id) => {
    if (!workers.has(id)) return false;
    await stopWorker(id);
    workers.delete(id);
    try { rmSync(supervisorWorkerActivityFile(id), { force: true }); } catch { /* best effort */ }
    dlog(`worker '${id}' removed`);
    broadcast({ type: 'event', event: 'worker-remove', id });
    persist();
    return true;
  };

  const restartWorker = async (id) => {
    const w = workers.get(id);
    if (!w) return false;
    await stopWorker(id);
    w.stopping = false;
    w.restarts = 0;
    startWorker(w);
    dlog(`worker '${id}' restarted`);
    return true;
  };

  // Resolve a target token to worker ids: exact id, else all with that profile.
  const resolveTargets = (target) => {
    const t = String(target || '').trim();
    if (!t) return [];
    if (t === 'all' || t === '*') return [...workers.keys()];
    if (workers.has(t)) return [t];
    return [...workers.values()].filter((w) => w.profile === t).map((w) => w.id);
  };

  // `pub` lets a caller that has already sampled the fleet (e.g. the monitor
  // tick, which needs the snapshot to compute its change signature) reuse that
  // exact snapshot for the frame — so the broadcast payload is guaranteed to
  // match the signature that decided to send it, with no second re-sample.
  const statusFrame = (final, pub) => ({
    ok: true,
    type: 'status',
    daemon: { pid: process.pid, startedAt, socket: socketPath, logFile: daemonLogFile },
    workers: pub || [...workers.values()].map(workerPublic),
    ...(final ? { final: true } : {}),
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Let any in-flight mutation finish before we snapshot the worker set, so
    // an add/restart racing the shutdown can't leave an orphaned child behind.
    try { await opQueue; } catch { /* mutation already logged */ }
    if (monitorTimer) { try { clearInterval(monitorTimer); } catch { /* ignore */ } monitorTimer = null; }
    dlog(`received ${signal || 'stop'} — stopping ${workers.size} worker(s)`);
    await Promise.all([...workers.keys()].map((id) => stopWorker(id)));
    broadcast({ type: 'event', event: 'daemon-stop' });
    try { server.close(); } catch { /* ignore */ }
    if (osPlatform() !== 'win32') { try { rmSync(socketPath, { force: true }); } catch { /* ignore */ } }
    clearSupervisorState();
    process.exit(0);
  };

  const handleRequest = async (req, sock) => {
    const op = req && req.op;
    try {
      switch (op) {
        case 'status':
          sock.write(encodeFrame(statusFrame(true)));
          break;
        case 'add': {
          if (shuttingDown) { sock.write(encodeFrame({ ok: false, error: 'supervisor is shutting down', final: true })); break; }
          if (!req.profile) { sock.write(encodeFrame({ ok: false, error: 'add requires a profile', final: true })); break; }
          // A supervised worker's name is supplied out-of-band as `req.name`
          // (which the daemon forwards to the child as `nano work … --name`).
          // A bare `--name` inside the forwarded work args is therefore ambiguous
          // — it would fight the supervisor-assigned id — so reject it here and
          // steer the operator to the dedicated flag.
          // `req.args` comes from untrusted JSON and may be non-array (e.g. a
          // string or object). Coerce to an array of string tokens before
          // scanning/forwarding so a malformed payload yields a clean rejection
          // instead of throwing a generic request error.
          const args = Array.isArray(req.args) ? req.args.filter((a) => typeof a === 'string') : [];
          const badName = args.find((a) => a === '--name' || a === '-n' || /^--name=/.test(a) || /^-n=/.test(a));
          if (badName) { sock.write(encodeFrame({ ok: false, error: 'name a supervised worker with `--name` on `supervisor add`, not inside its work flags', final: true })); break; }
          const stored = readHires()[String(req.profile)];
          if (!stored) { sock.write(encodeFrame({ ok: false, error: `no hire named "${req.profile}"`, final: true })); break; }
          const name = typeof req.name === 'string' ? req.name.trim() : '';
          const w = await serializeOp(() => addWorker(req.profile, args, name));
          sock.write(encodeFrame({ ok: true, type: 'added', worker: workerPublic(w), final: true }));
          break;
        }
        case 'remove': {
          if (shuttingDown) { sock.write(encodeFrame({ ok: false, error: 'supervisor is shutting down', final: true })); break; }
          const removed = await serializeOp(async () => {
            const ids = resolveTargets(req.target);
            for (const id of ids) await removeWorker(id);
            return ids;
          });
          sock.write(encodeFrame({ ok: true, type: 'removed', removed, final: true }));
          break;
        }
        case 'restart': {
          if (shuttingDown) { sock.write(encodeFrame({ ok: false, error: 'supervisor is shutting down', final: true })); break; }
          const restarted = await serializeOp(async () => {
            const ids = resolveTargets(req.target);
            for (const id of ids) await restartWorker(id);
            return ids;
          });
          sock.write(encodeFrame({ ok: true, type: 'restarted', restarted, final: true }));
          break;
        }
        case 'attach':
          attachClients.add(sock);
          sock.write(encodeFrame(statusFrame(false)));
          break;
        case 'stop':
          sock.write(encodeFrame({ ok: true, type: 'stopping', final: true }));
          setTimeout(() => shutdown('stop'), 50);
          break;
        default:
          sock.write(encodeFrame({ ok: false, error: `unknown op "${op}"`, final: true }));
      }
    } catch (err) {
      try { sock.write(encodeFrame({ ok: false, error: String(err && err.message || err), final: true })); } catch { /* ignore */ }
    }
  };

  // Bind the control socket. A stale unix socket file from a crashed daemon
  // would make listen() fail with EADDRINUSE even though nobody is listening;
  // remove it first (we already know no live daemon owns our state).
  if (osPlatform() !== 'win32') { try { rmSync(socketPath, { force: true }); } catch { /* ignore */ } }

  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    // Serialize requests per connection: handleRequest is async and mutates the
    // shared workers map, so a second 'data' event arriving mid-await must not
    // interleave add/remove/restart. Chain each frame onto a per-socket queue.
    let queue = Promise.resolve();
    sock.on('data', (chunk) => {
      buf += chunk;
      // Cap by UTF-8 byte length, not string length: buf is a decoded string
      // whose .length counts UTF-16 code units, so multibyte input could hold
      // far more than SUPERVISOR_MAX_FRAME_BYTES in memory before being dropped.
      if (Buffer.byteLength(buf, 'utf8') > SUPERVISOR_MAX_FRAME_BYTES) {
        dlog(`control connection exceeded ${SUPERVISOR_MAX_FRAME_BYTES} bytes without a complete frame — dropping`);
        try { sock.destroy(); } catch { /* ignore */ }
        buf = '';
        return;
      }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const req of frames) {
        queue = queue.then(() => handleRequest(req, sock)).catch((err) => dlog(`request error: ${err?.message || err}`));
      }
    });
    sock.on('close', () => attachClients.delete(sock));
    sock.on('error', () => attachClients.delete(sock));
  });

  // Create the control socket owner-only from the start. The socket file lives
  // in shared tmpdir(); libuv binds it synchronously inside listen(), so a
  // restrictive umask around that call closes the TOCTOU window where another
  // local user could connect before the chmod below lands. Restore the previous
  // umask immediately after — the listen() bind is synchronous, so no unrelated
  // file creation can interleave. Unix only; on Windows umask/mode are no-ops.
  const isWin = osPlatform() === 'win32';
  const prevUmask = isWin ? null : process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (err) {
    dlog(`failed to bind control socket ${socketPath}: ${err.message}`);
    process.exit(1);
  } finally {
    if (!isWin) { try { process.umask(prevUmask); } catch { /* ignore */ } }
  }

  // Lock the control socket to the owner so another local user can't drive the
  // supervisor (stop/add/remove). Unix only — Windows named pipes are secured
  // by their own ACLs, not filesystem mode bits. This chmod is now a backstop
  // for the owner-only umask applied around listen() above.
  if (!isWin) {
    try { chmodSync(socketPath, 0o600); } catch (err) { dlog(`could not chmod control socket: ${err.message}`); }
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  // SIGHUP (controlling terminal/session gone) must also drain children rather
  // than let Node's default terminate the daemon and orphan the fleet. SIGKILL
  // and hard crashes still can't run this — the per-worker parent-death
  // watchdog is the backstop for those.
  process.once('SIGHUP', () => shutdown('SIGHUP'));
  dlog(`supervisor daemon up (pid ${process.pid}) — control ${socketPath}`);
  persist();

  // Live-view refresh: periodically re-sample worker activity and push a fresh
  // status to attached consoles, but only when the fleet's observable state
  // actually changed since the last push (idle↔busy, a new/finished job, a
  // restart/exit). This keeps an attached `supervisor` console current without
  // spamming a quiet fleet. The signature always tracks the latest state (even
  // with no clients attached) so an idle-fleet attach — whose snapshot already
  // matches the tracked signature — won't provoke a redundant reprint for
  // everyone on the next tick. (A change that lands in the sub-tick window
  // *between* a tick and a fresh attach can still yield one extra identical
  // frame to the newcomer; that reprint is required to inform the already-
  // attached clients of the change, and is harmless — same content, re-rendered.)
  // Env-gated: NANO_SUPERVISOR_MONITOR_MS=0 disables; otherwise it's the cadence.
  const monitorMs = (() => {
    const raw = process.env.NANO_SUPERVISOR_MONITOR_MS;
    if (raw == null || raw === '') return SUPERVISOR_MONITOR_INTERVAL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SUPERVISOR_MONITOR_INTERVAL_MS;
  })();
  if (monitorMs > 0) {
    lastMonitorSig = supervisorStatusSignature([...workers.values()].map(workerPublic));
    monitorTimer = setInterval(() => {
      if (shuttingDown) return;
      const pub = [...workers.values()].map(workerPublic);
      const sig = supervisorStatusSignature(pub);
      const changed = sig !== lastMonitorSig;
      lastMonitorSig = sig;
      if (changed && attachClients.size > 0) broadcast(statusFrame(false, pub));
    }, monitorMs);
    if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
  }

  // Keep the event loop alive indefinitely; the server holds it, but add an
  // explicit never-resolving guard so a transient server close can't exit us.
  await new Promise(() => {});
}

// --- Client (management subcommands + attach) ------------------------------

/** Connect to the control socket, resolving with the socket once connected. */
function supervisorConnect(socketPath, { timeoutMs = SUPERVISOR_CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`timed out connecting to supervisor at ${socketPath}`));
    }, timeoutMs);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.setEncoding('utf8');
      resolve(sock);
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Send one request and collect frames until a `final:true` frame arrives. */
function supervisorRequest(req, { socketPath, timeoutMs, responseTimeoutMs = SUPERVISOR_RESPONSE_TIMEOUT_MS } = {}) {
  const path = socketPath || (readSupervisorState()?.socket) || getSupervisorSocketPath();
  return new Promise((resolve, reject) => {
    supervisorConnect(path, { timeoutMs }).then((sock) => {
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.end(); } catch { /* ignore */ } fn(arg); };
      const done = (result) => finish(resolve, result);
      const fail = (err) => finish(reject, err);
      // End-to-end response deadline: a daemon that accepts the connection but
      // never sends a `final` frame must not hang the caller forever.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        reject(new Error(`timed out waiting for supervisor response from ${path}`));
      }, responseTimeoutMs);
      sock.on('data', (chunk) => {
        buf += chunk;
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const frame of frames) {
          if (frame.final) return done(frame);
        }
      });
      sock.on('error', fail);
      sock.on('close', () => done({ ok: false, error: 'connection closed before response' }));
      sock.write(encodeFrame(req));
    }).catch(reject);
  });
}

/**
 * Ensure a daemon is running, spawning it detached if not, and return its
 * running state. Polls the control socket until it answers a status request.
 */
async function startSupervisorDaemon() {
  const existing = runningSupervisor();
  if (existing) return existing;

  const socketPath = getSupervisorSocketPath();
  // The state file may be missing (deleted, cleaned up, or not yet written)
  // while a daemon is still listening on the deterministic socket. Adopt that
  // live daemon instead of spawning a second one that would orphan the
  // original and its workers.
  try {
    const res = await supervisorRequest({ op: 'status' }, { socketPath, timeoutMs: 500, responseTimeoutMs: SUPERVISOR_PROBE_RESPONSE_TIMEOUT_MS });
    if (res && res.ok) {
      // Re-persist the adopted daemon's state so subsequent pid-based checks
      // (runningSupervisor()) work immediately, instead of staying broken until
      // some later command happens to heal supervisor.json.
      const adopted = runningSupervisor() || stateFromStatus(res, socketPath);
      try { writeSupervisorState(adopted); } catch { /* best effort */ }
      return adopted;
    }
  } catch { /* no live daemon on the socket — safe to (re)spawn */ }

  clearSupervisorState(); // clear any stale marker from a dead daemon

  const { exec, entry } = c8ctlInvocation();
  mkdirSync(getSupervisorLogDir(), { recursive: true });
  const logFile = supervisorDaemonLogFile();
  let fd;
  try { fd = openSync(logFile, 'a'); } catch { fd = 'ignore'; }
  const child = spawn(exec, [entry, 'nano', 'supervisor', '__daemon'], {
    env: process.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (typeof fd === 'number') { try { closeSync(fd); } catch { /* ignore */ } }
  if (typeof child.pid !== 'number') throw new Error('failed to spawn supervisor daemon');


  const deadline = Date.now() + SUPERVISOR_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await supervisorRequest({ op: 'status' }, { socketPath, timeoutMs: 750, responseTimeoutMs: SUPERVISOR_PROBE_RESPONSE_TIMEOUT_MS });
      if (res && res.ok) {
        // The daemon can answer `status` on the socket a beat before it has
        // written supervisor.json. Fall back to the live status response so
        // callers always get a state object with a usable pid.
        return runningSupervisor() || readSupervisorState() || stateFromStatus(res, socketPath);
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`supervisor daemon did not become ready (see ${logFile})`);
}

async function supervisorStartCmd(req, flags) {
  const logger = getLogger();
  const state = await startSupervisorDaemon();
  logger.info(`Supervisor daemon running (pid ${state.pid}).`);

  const specs = normalizeArgList(flags?.worker);
  const workArgs = reconstructWorkArgs(flags);
  // `--name` names a single launched worker. With several `--worker` specs a lone
  // name can't apply to all of them, so honour it only for a single spec and let
  // the rest auto-name; warn so the intent isn't silently dropped.
  const explicitName = flags?.name ? String(flags.name).trim() : undefined;
  if (explicitName && specs.length > 1) {
    logger.warn('--name is ignored when starting multiple --worker specs; each is auto-named.');
  }
  const nameFor = (i) => (explicitName && specs.length === 1 ? explicitName : undefined);
  for (let i = 0; i < specs.length; i++) {
    const profile = specs[i];
    const res = await supervisorRequest({ op: 'add', profile, name: nameFor(i), args: workArgs });
    if (res.ok) logger.info(`  + worker "${res.worker.id}" (profile ${profile})`);
    else logger.error(`  ! could not add "${profile}": ${res.error}`);
  }

  if (coerceBool(flags?.attach, false)) {
    await attachSupervisorConsole(runningSupervisor() || state);
    return;
  }
  await supervisorStatusCmd();
  logger.info('');
  logger.info('Attach an interactive console with: c8ctl nano supervisor');
  logger.info('Manage without it:                  c8ctl nano supervisor add|remove|restart|status|stop');
}

async function supervisorStatusCmd() {
  const logger = getLogger();
  const running = runningSupervisor();
  if (!running) {
    // The state file may be missing (deleted/cleaned) while a daemon is still
    // listening on the deterministic socket — same case startSupervisorDaemon
    // adopts. Probe it before declaring the supervisor down, and re-persist so
    // the state file is healed for later pid-based checks.
    try {
      const res = await supervisorRequest({ op: 'status' }, { socketPath: getSupervisorSocketPath(), timeoutMs: 500, responseTimeoutMs: SUPERVISOR_PROBE_RESPONSE_TIMEOUT_MS });
      if (res && res.ok) {
        try { writeSupervisorState(stateFromStatus(res, getSupervisorSocketPath())); } catch { /* best effort */ }
        printSupervisorStatus(logger, res);
        return;
      }
    } catch { /* no live daemon on the socket — genuinely down */ }
    const stale = readSupervisorState();
    if (stale) {
      logger.info('Supervisor: not running (stale state — daemon pid is dead).');
      logger.info('  Start it with: c8ctl nano supervisor start');
    } else {
      logger.info('Supervisor: not running.');
      logger.info('  Start it with: c8ctl nano supervisor start   (or attach: c8ctl nano supervisor)');
    }
    return;
  }
  try {
    const res = await supervisorRequest({ op: 'status' });
    if (res.ok) { printSupervisorStatus(logger, res); return; }
  } catch { /* fall back to state file below */ }
  // Socket unreachable but pid alive — render from the last persisted state.
  printSupervisorStatus(logger, {
    daemon: { pid: running.pid, startedAt: running.startedAt, socket: running.socket },
    workers: (running.workers || []).map((w) => summarizeSupervisorWorker(w)),
  });
}

async function supervisorAddCmd(req, flags) {
  const logger = getLogger();
  // The positional profile is what runs; `--name` names this worker instance
  // (forwarded to the child as `nano work … --name`, and used as its supervisor
  // id). Omit `--name` to auto-generate ‹host›-‹profile›-‹random›. `--instances N`
  // spawns N distinct auto-named workers of the profile in one call.
  const profile = req.positional[1];
  if (!profile) { logger.error('Usage: c8ctl nano supervisor add <profile> [--name <worker>] [--instances <n>] [work flags]'); process.exit(1); }
  const { count, error } = parseInstancesCount(flags?.instances);
  if (error) { logger.error(error); process.exit(1); }
  const name = flags?.name ? String(flags.name).trim() : undefined;
  // A single `--name` can't apply to several distinct workers (each needs its
  // own broker workerName / supervisor id), so reject the combination and steer
  // the operator to auto-naming.
  if (name && count > 1) {
    logger.error('--name cannot be combined with --instances > 1 (each instance needs a distinct name); omit --name to auto-name them.');
    process.exit(1);
  }
  await startSupervisorDaemon();
  const workArgs = reconstructWorkArgs(flags);
  let added = 0;
  let failed = 0;
  for (let i = 0; i < count; i++) {
    const res = await supervisorRequest({ op: 'add', profile, name, args: workArgs });
    if (res.ok) { added++; logger.info(`Added worker "${res.worker.id}" (profile ${profile}); pid ${res.worker.pid ?? 'starting'}.`); }
    else { failed++; logger.error(`Could not add "${profile}": ${res.error}`); }
  }
  if (count > 1) logger.info(`Added ${added}/${count} instance(s) of "${profile}".`);
  if (failed > 0) process.exit(1);
}

async function supervisorRemoveCmd(req) {
  const logger = getLogger();
  const target = req.positional[1];
  if (!target) { logger.error('Usage: c8ctl nano supervisor remove <id|profile|all>'); process.exit(1); }
  if (!await liveSupervisor()) { logger.error('Supervisor is not running.'); process.exit(1); }
  const res = await supervisorRequest({ op: 'remove', target });
  if (res.ok && res.removed.length > 0) logger.info(`Removed worker(s): ${res.removed.join(', ')}.`);
  else if (res.ok) { logger.warn(`No worker matched "${target}".`); }
  else { logger.error(res.error); process.exit(1); }
}

async function supervisorRestartCmd(req) {
  const logger = getLogger();
  const target = req.positional[1];
  if (!target) { logger.error('Usage: c8ctl nano supervisor restart <id|profile|all>'); process.exit(1); }
  if (!await liveSupervisor()) { logger.error('Supervisor is not running.'); process.exit(1); }
  const res = await supervisorRequest({ op: 'restart', target });
  if (res.ok && res.restarted.length > 0) logger.info(`Restarted worker(s): ${res.restarted.join(', ')}.`);
  else if (res.ok) { logger.warn(`No worker matched "${target}".`); }
  else { logger.error(res.error); process.exit(1); }
}

async function supervisorStopCmd() {
  const logger = getLogger();
  const running = await liveSupervisor();
  if (!running) {
    if (readSupervisorState()) { clearSupervisorState(); logger.info('Cleared stale supervisor state.'); }
    else logger.warn('Supervisor is not running — nothing to stop.');
    return;
  }
  try {
    await supervisorRequest({ op: 'stop' });
  } catch {
    // Socket unreachable — fall back to signalling the daemon pid directly.
    try { process.kill(running.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Gate the wait loop and the SIGKILL fallback on the daemon pid we captured,
  // not on runningSupervisor()/the state file: the daemon clears its state file
  // as part of shutting down (and liveSupervisor()/external cleanup can remove
  // it too), so a state-file check can report "gone" while the process is still
  // alive — which would break the loop early and skip the SIGKILL fallback,
  // leaving a wedged daemon and its worker process group running.
  const deadline = Date.now() + STOP_GRACE_MS + 2_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(running.pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (isPidAlive(running.pid)) {
    logger.warn(`Supervisor (pid ${running.pid}) did not stop gracefully — sending SIGKILL.`);
    // The daemon is spawned detached (a process-group leader) and its workers
    // are children in that group, so SIGKILL the whole group to avoid orphaning
    // `nano work` processes. Fall back to the bare pid (e.g. on Windows, or if
    // the daemon isn't a group leader).
    let killedGroup = false;
    if (osPlatform() !== 'win32') {
      try { process.kill(-running.pid, 'SIGKILL'); killedGroup = true; } catch { /* fall back below */ }
    }
    if (!killedGroup) { try { process.kill(running.pid, 'SIGKILL'); } catch { /* ignore */ } }
    clearSupervisorState();
  }
  logger.info('Supervisor stopped.');
}

function supervisorLogsCmd(req) {
  const logger = getLogger();
  const id = req.positional[1];
  const file = id ? supervisorWorkerLogFile(id) : supervisorDaemonLogFile();
  if (!existsSync(file)) {
    logger.error(`No log file at ${file}.${id ? ` (unknown worker "${id}"?)` : ''}`);
    process.exit(1);
  }
  const follow = Boolean(req.follow);
  const tailArgs = follow ? ['-n', '200', '-F', file] : ['-n', '200', file];
  const proc = spawn('tail', tailArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', () => {
    // tail unavailable (e.g. Windows): print the tail ourselves, no follow.
    if (follow) logger.warn('`--follow` is not supported without `tail` on this platform; printing the current tail only.');
    try {
      const lines = readFileSync(file, 'utf-8').split('\n');
      logger.output(lines.slice(-200).join('\n'));
    } catch (err) { logger.error(`Could not read ${file}: ${err.message}`); }
  });
}

/**
 * Interactive attach console. Streams live events from the daemon and accepts
 * line commands. `detach` (or Ctrl-D) disconnects but leaves the daemon
 * running; `stop` tears the fleet down.
 */
async function attachSupervisorConsole(state) {
  const logger = getLogger();
  const socketPath = state?.socket || getSupervisorSocketPath();
  let sock;
  try {
    sock = await supervisorConnect(socketPath);
  } catch (err) {
    logger.error(`Could not attach to supervisor: ${err.message}`);
    process.exit(1);
  }

  const outStream = process.stdout;
  // The pinned in-place block needs cursor addressing; on a non-TTY / dumb
  // terminal we fall back to the classic append-and-scroll behavior.
  const isTty = !!outStream.isTTY && process.env.TERM !== 'dumb';

  let rl = null;
  const termCols = () => (Number.isFinite(outStream.columns) ? outStream.columns : 80);
  const view = createSupervisorLiveView({
    stream: outStream,
    isTty,
    columns: termCols,
    refreshPrompt: () => { if (rl) { try { rl.prompt(true); } catch { /* ignore */ } } },
  });
  // All scrolling output (intro, events, command replies) goes ABOVE the block.
  const out = (s) => view.write(s);

  out('Attached to nano worker supervisor. Type "help" for commands.');
  out('Detach (leave it running) with "detach" or Ctrl-D; tear it down with "stop".');
  sock.write(encodeFrame({ op: 'attach' }));

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    if (frames.length === 0) return;
    for (const frame of frames) {
      if (frame.type === 'status') {
        // Mutate the pinned block in place (TTY) or append (non-TTY) — never a
        // reprinted table stacking up in the scrollback.
        view.status(frame);
      } else if (frame.type === 'event') {
        const w = frame.worker;
        if (frame.event === 'worker-start') out(`• worker ${w.id} started (pid ${w.pid}).`);
        else if (frame.event === 'worker-exit') out(`• worker ${w.id} exited (${w.lastExit}); restarting in ${formatDuration(frame.restartInMs)}.`);
        else if (frame.event === 'worker-remove') out(`• worker ${frame.id} removed.`);
        else if (frame.event === 'daemon-stop') out('• supervisor stopping.');
      } else if (frame.type === 'added') {
        out(`• added worker ${frame.worker.id}.`);
      } else if (frame.type === 'removed') {
        out(`• removed: ${frame.removed.join(', ') || '(none matched)'}.`);
      } else if (frame.type === 'restarted') {
        out(`• restarted: ${frame.restarted.join(', ') || '(none matched)'}.`);
      } else if (frame.ok === false) {
        out(`! ${frame.error}`);
      }
    }
    // Every frame above routes through view.status() or view.write(), each of
    // which already erases+redraws the pinned block and refreshes the prompt in
    // TTY mode — so an extra repaint here would just duplicate that work (and
    // flicker at the ~1s monitor cadence). On a non-TTY there is no block to
    // redraw, so only nudge the prompt so an async push doesn't leave the input
    // line half-rendered.
    if (!isTty && rl) { try { rl.prompt(true); } catch { /* ignore */ } }
  });

  rl = createReadline({ input: process.stdin, output: process.stdout, prompt: 'supervisor> ' });

  // Local ~5s tick: re-age the block so UPTIME / job-age advance even when the
  // fleet is quiet (the daemon's change-gated push stays silent). And reflow the
  // block on terminal resize so a narrower window re-clamps cleanly.
  let tickTimer = null;
  let onResize = null;
  if (isTty) {
    tickTimer = setInterval(() => view.repaint(), SUPERVISOR_LIVE_TICK_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
    onResize = () => view.repaint();
    outStream.on('resize', onResize);
  }
  rl.prompt();

  await new Promise((resolve) => {
    let stopping = false;
    const finish = () => {
      if (tickTimer) { try { clearInterval(tickTimer); } catch { /* ignore */ } tickTimer = null; }
      if (onResize) { try { outStream.off('resize', onResize); } catch { /* ignore */ } onResize = null; }
      try { rl.close(); } catch { /* ignore */ } try { sock.end(); } catch { /* ignore */ } resolve();
    };

    sock.on('close', () => { if (!stopping) out('\nSupervisor connection closed.'); finish(); });

    rl.on('line', (line) => {
      const parts = String(line).trim().split(/\s+/).filter(Boolean);
      const cmd = (parts.shift() || '').toLowerCase();
      switch (cmd) {
        case '': break;
        case 'help':
          out('Commands: status | add <profile> [--name <worker>] [--instances <n>] [work flags] |');
          out('          remove <id|profile|all> | restart <id|profile|all> |');
          out('          logs [id] | detach | stop | help');
          break;
        case 'status': sock.write(encodeFrame({ op: 'status' })); break;
        case 'add': {
          const profile = parts.shift();
          if (!profile) { out('usage: add <profile> [--name <worker>] [--instances <n>] [work flags]'); break; }
          const { name, rest } = extractNameFlag(parts);
          const { count, rest: workArgs, error } = extractInstancesFlag(rest);
          if (error) { out(error); break; }
          if (name && count > 1) { out('--name cannot be combined with --instances > 1; omit --name to auto-name them.'); break; }
          for (let i = 0; i < count; i++) {
            sock.write(encodeFrame({ op: 'add', profile, name, args: workArgs }));
          }
          break;
        }
        case 'remove': case 'rm': {
          const target = parts.shift();
          if (!target) { out('usage: remove <id|profile|all>'); break; }
          sock.write(encodeFrame({ op: 'remove', target }));
          break;
        }
        case 'restart': {
          const target = parts.shift();
          if (!target) { out('usage: restart <id|profile|all>'); break; }
          sock.write(encodeFrame({ op: 'restart', target }));
          break;
        }
        case 'logs': case 'log': {
          const file = parts[0] ? supervisorWorkerLogFile(parts[0]) : supervisorDaemonLogFile();
          try {
            const lines = readFileSync(file, 'utf-8').split('\n');
            out(lines.slice(-30).join('\n'));
          } catch { out(`no log at ${file}`); }
          break;
        }
        case 'detach': case 'quit': case 'exit':
          out('Detaching — supervisor keeps running. Reattach with: c8ctl nano supervisor');
          finish();
          return;
        case 'stop':
          stopping = true;
          out('Stopping supervisor…');
          sock.write(encodeFrame({ op: 'stop' }));
          setTimeout(finish, 500);
          return;
        default:
          out(`unknown command "${cmd}" — type "help"`);
      }
      rl.prompt();
    });

    // Ctrl-D (EOF) detaches, leaving the daemon running.
    rl.on('close', () => {
      if (stopping) return;
      out('\nDetaching — supervisor keeps running. Reattach with: c8ctl nano supervisor');
      finish();
    });
  });
}

/** Dispatch the `supervisor` subcommand's action. */
async function supervisorCommand(req, flags) {
  const action = (req.positional[0] || '').toLowerCase();
  switch (action) {
    case '__daemon':
      await runSupervisorDaemon();
      return;
    case '':
    case 'attach': {
      const state = await startSupervisorDaemon();
      await attachSupervisorConsole(runningSupervisor() || state);
      return;
    }
    case 'start':
      await supervisorStartCmd(req, flags);
      return;
    case 'status':
    case 'list':
    case 'ls':
      await supervisorStatusCmd();
      return;
    case 'add':
      await supervisorAddCmd(req, flags);
      return;
    case 'remove':
    case 'rm':
      await supervisorRemoveCmd(req);
      return;
    case 'restart':
      await supervisorRestartCmd(req);
      return;
    case 'stop':
      await supervisorStopCmd();
      return;
    case 'logs':
    case 'log':
      supervisorLogsCmd(req);
      return;
    default:
      getLogger().error(`Unknown supervisor action "${action}". Use: start|status|add|remove|restart|stop|logs|attach`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// workforce — declarative workforce manifests (issue #117). A manifest is a
// named, user-curated document (`<stateHome>/workforce/<name>.json`) describing
// a fleet of supervised workers you compose once (`workforce add`) and bring up
// convergently with one command (`workforce start`). It is deliberately a
// SEPARATE file per manifest — a portable artifact meant to be read, edited,
// diffed and copied between machines — not a key in `config.json` (plugin
// state). `workforce start` reconciles the running supervisor to the manifest
// using deterministic `wf-<manifest>-<profile>-<index>` worker names, so a
// second start with an unchanged manifest starts/stops/restarts nothing.
// ---------------------------------------------------------------------------

const WORKFORCE_MANIFEST_VERSION = 1;
const DEFAULT_WORKFORCE_MANIFEST = 'default';

/** The directory holding per-name workforce manifests. */
function getWorkforceDir() {
  return join(getStateHome(), 'workforce');
}

/** The manifest file for a given manifest name (`<stateHome>/workforce/<name>.json`). */
function getWorkforceManifestFile(name) {
  return join(getWorkforceDir(), `${name}.json`);
}

/**
 * A manifest name is valid iff it is a non-empty run of `[A-Za-z0-9._-]` (same
 * charset as a profile name). It rides in both a filename and the deterministic
 * `wf-<name>-` worker-name prefix, so this charset keeps it safe on disk and as
 * a broker/supervisor worker id. Pure.
 */
function isValidManifestName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(name);
}

/** An empty v1 manifest with the given name. Pure. */
function emptyWorkforceManifest(name) {
  return { version: WORKFORCE_MANIFEST_VERSION, name: String(name), workers: [] };
}

// A workforce role name (a capability token): starts with a letter/digit, then
// letters/digits/`. _ + -`. No `:` (that delimits rank↔role in the mapped job
// type). Roles are lowercased to match `normalizeCapabilities`.
const WORKFORCE_ROLE_RE = /^[a-z0-9][a-z0-9._+-]*$/i;

/**
 * Parse a `--roles a,b,c` value (string | string[]) into a deduped, validated,
 * lowercased list of role names. Returns `{ roles, errors }`. Pure.
 */
function parseRolesList(raw) {
  const fromArray = Array.isArray(raw);
  const list = fromArray ? raw : String(raw ?? '').split(',');
  const seen = new Set();
  const roles = [];
  const errors = [];
  for (const item of list) {
    if (fromArray && typeof item !== 'string') {
      errors.push(`invalid role ${JSON.stringify(item)} (expected a role-name string)`);
      continue;
    }
    const r = String(item).trim().toLowerCase();
    if (!r) continue;
    if (!WORKFORCE_ROLE_RE.test(r)) { errors.push(`invalid role "${item}" (use letters, digits, and . _ + -)`); continue; }
    if (seen.has(r)) continue;
    seen.add(r);
    roles.push(r);
  }
  return { roles, errors };
}

/**
 * Map an explicit role list to repeatable `--job-type <rank>:<role>` tokens,
 * resolved AT START TIME from the manifest and the hired profile's rank —
 * independent of what the profile was hired with (the install script hires with
 * `--capabilities ""`). `["pr-review"]` × rank `senior` → `["senior:pr-review"]`.
 * Pure and unit-tested.
 */
function rolesToJobTypes(roles, rank) {
  if (!Array.isArray(roles)) return [];
  const r = String(rank || '').trim();
  return roles.map((role) => `${r}:${String(role).trim()}`);
}

/**
 * Translate one manifest entry (+ the resolved hired-profile rank) into the
 * `nano work` argv tail a supervised worker runs with:
 *   - `roles: "auto"` → `--auto [--auto-scope <s>]` (no capability gate; serves
 *     every deployed agent job type — what the install script sets).
 *   - `roles: [...]`  → repeatable `--job-type <rank>:<role>` per role.
 * Then any verbatim `entry.args` escape-hatch flags are appended. Neither form
 * mutates the hired profile. Pure and unit-tested.
 */
function manifestEntryToWorkArgs(entry, rank) {
  const out = [];
  const roles = entry?.roles;
  if (roles === 'auto' || roles == null) {
    out.push('--auto');
    const scope = typeof entry?.autoScope === 'string' ? entry.autoScope.trim() : '';
    if (scope) out.push('--auto-scope', scope);
  } else if (Array.isArray(roles)) {
    for (const jt of rolesToJobTypes(roles, rank)) out.push('--job-type', jt);
  }
  for (const a of normalizeArgList(entry?.args)) out.push(a);
  return out;
}

/** The ownership prefix for a manifest's workforce-owned workers. Pure. */
function workforceOwnerPrefix(manifest) {
  return `wf-${manifest}-`;
}

/** The deterministic worker name for the Nth instance of a profile. Pure. */
function workforceWorkerName(manifest, profile, index) {
  return `${workforceOwnerPrefix(manifest)}${profile}-${index}`;
}

/**
 * Is worker `id` owned by `manifest`? A worker name is
 * `wf-<manifest>-<profile>-<index>`, and BOTH the manifest name and the profile
 * may contain `-` (see `isValidManifestName`), so a bare `wf-<manifest>-` prefix
 * test is ambiguous: manifest `a` would otherwise claim `wf-a-b-...` workers that
 * actually belong to manifest `a-b`, letting `workforce start/stop/status`
 * stop or report another manifest's workers. We disambiguate by LONGEST-prefix
 * ownership against the manifest names that exist on this machine
 * (`manifestNames`): `id` belongs to `manifest` only when no OTHER existing
 * manifest name is a longer `wf-<name>-` prefix of `id`. When `manifestNames` is
 * absent/empty this degrades to the plain prefix test (unchanged behaviour), so
 * a worker whose more-specific owner no longer exists on disk stays claimable as
 * an orphan under its prefix. Pure.
 */
function isWorkforceOwnedWorker(id, manifest, manifestNames) {
  if (typeof id !== 'string' || !id.startsWith(workforceOwnerPrefix(manifest))) return false;
  const names = Array.isArray(manifestNames) ? manifestNames : [];
  for (const other of names) {
    if (other === manifest) continue;
    if (other.length > manifest.length && id.startsWith(workforceOwnerPrefix(other))) return false;
  }
  return true;
}

/**
 * Parse the `<profile>` embedded in a deterministic
 * `wf-<manifest>-<profile>-<index>` worker id, given the owning manifest.
 * Returns the profile string, or `null` when `id` does not carry this manifest's
 * `wf-<manifest>-` prefix or does not end in a `-<index>` counter (a hand-added
 * id that merely shares the prefix). A profile name may itself contain dashes,
 * so we peel the trailing `-<digits>` index and treat the remainder as the
 * profile. Pure — mirrors `workforceWorkerName`'s construction.
 */
function workforceProfileFromWorkerName(manifest, id) {
  const prefix = workforceOwnerPrefix(manifest);
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const m = rest.match(/^(.+)-(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Expand a manifest into the flat list of desired workers it describes:
 * `[{ name, profile, index, entry }]`, one per instance. Pure.
 */
function expandWorkforceDesired(manifest) {
  const name = manifest?.name;
  const entries = Array.isArray(manifest?.workers) ? manifest.workers : [];
  const out = [];
  for (const entry of entries) {
    const profile = entry?.profile;
    const instances = Number(entry?.instances) || 0;
    for (let i = 1; i <= instances; i++) {
      out.push({ name: workforceWorkerName(name, profile, i), profile, index: i, entry });
    }
  }
  return out;
}

/**
 * The convergent reconcile diff for `workforce start`, factored as a PURE
 * function over (desired workers, live supervisor workers, manifest name) so it
 * is unit-testable directly (mirroring how `diffJobTypes` is factored):
 *   - `toStart`   — desired workers not currently running (by exact name).
 *   - `toStop`    — live workers OWNED by this manifest (the `wf-<manifest>-`
 *                   name prefix) that are no longer desired (entry removed or
 *                   `instances` reduced).
 *   - `toRestart` — desired workers present in supervisor status under the same
 *                   profile but NOT actually running (e.g. `state: "down"` while
 *                   crashed / mid-backoff). Restarting them lets `workforce
 *                   start` converge back to the desired *running* fleet instead
 *                   of counting a down worker as "unchanged". A live worker with
 *                   no `state` field (older status payloads) is assumed running.
 *   - `unchanged` — desired workers already running under the same profile.
 *   - `collisions`— a desired name is already taken by a worker running a
 *                   DIFFERENT profile (a hand-added worker that clashes): it is
 *                   neither started (don't clobber) nor stopped (not ours).
 * Workers NOT owned by this manifest (added by hand with `supervisor add`, or
 * owned by another manifest) are never in `toStop`. `desired` is
 * `[{ name, profile, ... }]`; `live` is `[{ id, profile }]`.
 *
 * `skippedProfiles` names manifest entries whose profile could not be resolved
 * this run (a local config error, e.g. a deleted hire). Such an entry produces
 * NO desired workers, so its already-running `wf-<manifest>-<profile>-*` workers
 * would otherwise be swept into `toStop` — turning a validation error into a
 * destructive teardown. We PROTECT those workers instead: they are left running
 * (reported under `protected`) so a config problem never tears down part of the
 * live fleet. Pure.
 */
function reconcileWorkforce({ desired, live, manifest, skippedProfiles, manifestNames }) {
  const liveList = Array.isArray(live) ? live : [];
  const liveById = new Map();
  for (const w of liveList) { if (w && typeof w.id === 'string') liveById.set(w.id, w); }
  const desiredList = Array.isArray(desired) ? desired : [];
  const desiredNames = new Set(desiredList.map((d) => d.name));
  const protectedProfiles = new Set(Array.isArray(skippedProfiles) ? skippedProfiles : []);
  // Compare the worker id's EMBEDDED profile exactly against skippedProfiles.
  // A prefix `startsWith` check would over-match when profile names contain '-'
  // (e.g. skipping "a" must not protect "a-b"'s `wf-<manifest>-a-b-*` workers).
  const isProtected = (id) => protectedProfiles.has(workforceProfileFromWorkerName(manifest, id));
  const toStart = [];
  const toRestart = [];
  const unchanged = [];
  const collisions = [];
  for (const d of desiredList) {
    const existing = liveById.get(d.name);
    if (!existing) { toStart.push(d); continue; }
    if (existing.profile != null && d.profile != null && existing.profile !== d.profile) {
      collisions.push({ name: d.name, wantProfile: d.profile, haveProfile: existing.profile });
      continue;
    }
    // A worker known to the supervisor but NOT running (state present and not
    // "running", e.g. "down" while crashed/mid-backoff) is restarted so `start`
    // converges to the desired *running* fleet. Missing state ⇒ assume running.
    if (existing.state != null && existing.state !== 'running') { toRestart.push(d); continue; }
    unchanged.push(d);
  }
  const toStop = [];
  const protectedWorkers = [];
  for (const w of liveList) {
    if (!w || typeof w.id !== 'string') continue;
    if (!isWorkforceOwnedWorker(w.id, manifest, manifestNames) || desiredNames.has(w.id)) continue;
    if (isProtected(w.id)) { protectedWorkers.push(w.id); continue; }
    toStop.push(w.id);
  }
  return { toStart, toRestart, toStop, unchanged, collisions, protected: protectedWorkers };
}

/**
 * Validate + normalize one stored manifest entry, returning `{ entry }` or
 * `{ error }`. Enforces: a profile string, `instances` in `[1, MAX_ADD_INSTANCES]`,
 * and `roles` being either `"auto"` (with an optional `autoScope`) or a
 * non-empty array of valid role names. Pure — no config/hire I/O (the profile's
 * EXISTENCE is checked at add/start against `hires`, not here). Pure.
 */
function normalizeManifestEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'entry is not an object' };
  const profile = String(entry.profile || '').trim();
  if (!profile) return { error: 'entry is missing a profile' };
  // A manifest is hand-editable, so enforce the same safe charset as a hired
  // profile name here: the profile rides into the deterministic
  // `wf-<manifest>-<profile>-<index>` worker id, and a torn value like "bad
  // name" would otherwise pass and fail later in a less obvious place.
  if (!isValidProfileName(profile)) {
    return { error: `entry "${profile}": invalid profile name (use letters, digits, dot, dash or underscore)` };
  }
  const { count, error } = parseInstancesCount(entry.instances, 'workforce add');
  if (error) return { error: `entry "${profile}": ${error}` };
  let roles;
  let autoScope;
  // Distinguish an ABSENT `roles` field (a legitimate "default to auto") from a
  // field that is PRESENT but malformed — including an explicit `null`, which is
  // a torn value, not "auto". Keying on presence (mirrors the strict `workers:
  // null` rejection above) surfaces the corruption instead of silently
  // broadening the worker to `--auto` serving.
  const rolesAbsent = !('roles' in entry) || entry.roles === undefined;
  if (entry.roles === 'auto' || rolesAbsent) {
    roles = 'auto';
    const scope = typeof entry.autoScope === 'string' ? entry.autoScope.trim() : '';
    if (scope) autoScope = scope;
  } else if (Array.isArray(entry.roles)) {
    const { roles: rs, errors } = parseRolesList(entry.roles);
    if (errors.length) return { error: `entry "${profile}": ${errors.join('; ')}` };
    if (rs.length === 0) return { error: `entry "${profile}": roles array is empty` };
    roles = rs;
  } else {
    return { error: `entry "${profile}": roles must be "auto" or an array of role names` };
  }
  const args = normalizeArgList(entry.args);
  const out = { profile, instances: count, roles };
  if (autoScope) out.autoScope = autoScope;
  if (args.length) out.args = args;
  return { entry: out };
}

/**
 * Validate a parsed manifest object against the v1 schema, THROWING a clear
 * error naming the file path on any problem (mirroring `readConfigStrict()`'s
 * "absent vs unreadable" distinction — a torn/unknown manifest is never silently
 * treated as empty). Refuses an unknown `version` rather than best-effort
 * parsing. Returns the normalized manifest.
 */
function validateWorkforceManifest(parsed, file, expectedName) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`workforce manifest ${file} is malformed (expected a JSON object).`);
  }
  if (parsed.version !== WORKFORCE_MANIFEST_VERSION) {
    throw new Error(`workforce manifest ${file} has unsupported version ${JSON.stringify(parsed.version)} (this build understands version ${WORKFORCE_MANIFEST_VERSION}).`);
  }
  // Distinguish an ABSENT `workers` field (a legitimately empty manifest) from
  // one that is PRESENT but not an array — including an explicit `null`, which
  // is a malformed value, not "empty". `!= null` used to let `null` slip
  // through as empty; keying on presence surfaces the corruption instead.
  if ('workers' in parsed && parsed.workers !== undefined && !Array.isArray(parsed.workers)) {
    throw new Error(`workforce manifest ${file} has a malformed "workers" field (expected an array, got ${parsed.workers === null ? 'null' : typeof parsed.workers}).`);
  }
  const workersRaw = Array.isArray(parsed.workers) ? parsed.workers : [];
  const workers = [];
  const seenProfiles = new Set();
  for (const raw of workersRaw) {
    const norm = normalizeManifestEntry(raw);
    if (norm.error) throw new Error(`workforce manifest ${file}: ${norm.error}.`);
    // Reject duplicate profiles: two entries for the same profile expand to the
    // same deterministic `wf-<manifest>-<profile>-<index>` worker names, so
    // `workforce start` would try `supervisor add` for the same worker id twice
    // and fail non-deterministically. Surface the corruption here (naming the
    // path) — use "instances" to run multiple copies of one profile.
    if (seenProfiles.has(norm.entry.profile)) {
      throw new Error(`workforce manifest ${file} has a duplicate profile ${JSON.stringify(norm.entry.profile)} — each profile may appear at most once (use "instances" to run more than one).`);
    }
    seenProfiles.add(norm.entry.profile);
    workers.push(norm.entry);
  }
  const onDiskName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : '';
  // When loaded by name, the file's identity (its path) is authoritative: a
  // hand-edited `name` that disagrees would make writeWorkforceManifest() target
  // a *different* file, silently corrupting an unrelated manifest. Refuse it
  // rather than trust the field (mirrors the strict "surface corruption" ethos).
  const expected = String(expectedName || '').trim();
  if (expected && onDiskName && onDiskName !== expected) {
    throw new Error(`workforce manifest ${file} declares name ${JSON.stringify(onDiskName)} but was loaded as ${JSON.stringify(expected)} — the manifest name must match its filename.`);
  }
  const name = onDiskName || expected;
  return { version: WORKFORCE_MANIFEST_VERSION, name, workers };
}

/**
 * Read + validate a manifest by name. Returns the normalized manifest, or
 * `null` when the file is absent. THROWS (naming the path) on an unreadable
 * file, torn/non-JSON content, or a schema/version violation — so callers never
 * mistake "unreadable" for "empty".
 */
function readWorkforceManifestStrict(name) {
  const file = getWorkforceManifestFile(name);
  if (!existsSync(file)) return null;
  let raw;
  try { raw = readFileSync(file, 'utf-8'); }
  catch (err) { throw new Error(`could not read workforce manifest ${file}: ${err.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`workforce manifest ${file} is not valid JSON: ${err.message}`); }
  return validateWorkforceManifest(parsed, file, name);
}

/** Atomically persist a manifest to `<stateHome>/workforce/<name>.json`. */
function writeWorkforceManifest(manifest) {
  mkdirSync(getWorkforceDir(), { recursive: true });
  const target = getWorkforceManifestFile(manifest.name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  // Owner-only (0600): manifests record forwarded `work` flags via `args`
  // (e.g. `--env NAME=VALUE`), so keep them out of world-readable view on
  // multi-user machines, consistent with supervisor.json.
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try { renameSync(tmp, target); }
  catch (err) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw err; }
}

/** All manifest names that exist on disk (sorted). Best-effort IO. */
function listWorkforceManifestNames() {
  let entries;
  try { entries = readdirSync(getWorkforceDir()); }
  catch { return []; }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => n && isValidManifestName(n))
    .sort();
}

/**
 * Append or update-in-place a manifest entry, matched by `profile` (idempotent,
 * matching `hire`'s update-in-place semantics). Returns a new manifest. Pure.
 */
function upsertManifestEntry(manifest, entry) {
  const workers = Array.isArray(manifest.workers) ? manifest.workers.slice() : [];
  const idx = workers.findIndex((w) => w && w.profile === entry.profile);
  if (idx >= 0) workers[idx] = entry; else workers.push(entry);
  return { ...manifest, workers };
}

/**
 * Drop a manifest entry by profile, or clear ALL entries when `profile` is
 * `"all"`. Returns `{ manifest, removed }` where `removed` lists the dropped
 * profiles. Pure.
 */
function removeManifestEntry(manifest, profile) {
  const workers = Array.isArray(manifest.workers) ? manifest.workers : [];
  if (profile === 'all') {
    return { manifest: { ...manifest, workers: [] }, removed: workers.map((w) => w && w.profile).filter(Boolean) };
  }
  const kept = [];
  let removed = null;
  for (const w of workers) {
    if (w && w.profile === profile) removed = w.profile;
    else kept.push(w);
  }
  return { manifest: { ...manifest, workers: kept }, removed: removed ? [removed] : [] };
}

/** Human-readable one-line summary of an entry's roles. Pure. */
function describeEntryRoles(entry) {
  if (Array.isArray(entry?.roles)) return entry.roles.join(', ');
  const scope = typeof entry?.autoScope === 'string' && entry.autoScope ? ` (scope ${entry.autoScope})` : '';
  return `auto${scope}`;
}

/** Render a manifest as an aligned text table for `workforce list`. Pure. */
function formatWorkforceManifest(manifest) {
  const lines = [];
  lines.push(`Workforce "${manifest.name}" (v${manifest.version ?? WORKFORCE_MANIFEST_VERSION}):`);
  const entries = Array.isArray(manifest.workers) ? manifest.workers : [];
  if (entries.length === 0) {
    lines.push('  (empty — add workers with: c8ctl nano workforce add <profile> --instances N [--auto|--roles a,b])');
    return lines.join('\n');
  }
  const rows = entries.map((e) => ({
    profile: String(e.profile),
    instances: String(e.instances ?? 1),
    roles: describeEntryRoles(e),
    args: Array.isArray(e.args) && e.args.length ? e.args.join(' ') : '-',
  }));
  const head = { profile: 'PROFILE', instances: 'INSTANCES', roles: 'ROLES', args: 'ARGS' };
  const cols = ['profile', 'instances', 'roles', 'args'];
  const width = {};
  for (const c of cols) width[c] = Math.max(head[c].length, ...rows.map((r) => r[c].length));
  const fmt = (r) => '  ' + cols.map((c) => r[c].padEnd(width[c])).join('  ');
  lines.push(fmt(head));
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n');
}

/**
 * Build the `workforce status` report — the manifest's entries joined against
 * the live supervisor worker set — as a plain data object (also the `--json`
 * shape). For each entry it reports desired vs actual instance counts and the
 * per-instance worker (present/state/pid/uptime/restarts); plus `extra` workers
 * owned by this manifest (the `wf-<name>-` prefix) that no entry desires. Pure
 * over its inputs. `live` is an array of summarized supervisor workers.
 */
function buildWorkforceStatus(manifest, name, live, supervisorRunning, manifestNames) {
  const liveList = Array.isArray(live) ? live : [];
  const liveById = new Map();
  for (const w of liveList) { if (w && typeof w.id === 'string') liveById.set(w.id, w); }
  const entriesRaw = Array.isArray(manifest?.workers) ? manifest.workers : [];
  const desiredNames = new Set();
  const entries = entriesRaw.map((e) => {
    const workers = [];
    let running = 0;
    for (let i = 1; i <= (Number(e.instances) || 0); i++) {
      const wname = workforceWorkerName(name, e.profile, i);
      desiredNames.add(wname);
      const w = liveById.get(wname) || null;
      // Mirror reconcile's collision rule: a live worker occupying the desired
      // NAME but running a DIFFERENT profile does NOT satisfy this instance
      // (workforce start skips such a name collision rather than clobbering it).
      // Treat it as a collision — the desired instance is effectively absent —
      // and surface the intruding profile so status doesn't mask the clash by
      // reporting the instance as "running".
      const collision = w && w.profile != null && e.profile != null && String(w.profile) !== String(e.profile)
        ? String(w.profile)
        : null;
      const eff = collision ? null : w;
      // Mirror reconcile: a live worker with no `state` (older supervisor
      // status payloads) is assumed running, not "undefined".
      const state = eff ? (eff.state != null ? String(eff.state) : 'running') : 'absent';
      if (state === 'running') running++;
      workers.push({
        name: wname,
        present: Boolean(eff),
        state,
        pid: eff && eff.pid != null ? eff.pid : null,
        uptimeMs: eff && Number.isFinite(eff.uptimeMs) ? eff.uptimeMs : null,
        restarts: eff ? Number(eff.restarts) || 0 : 0,
        collision,
      });
    }
    return {
      profile: e.profile,
      roles: e.roles,
      autoScope: e.autoScope ?? null,
      desired: Number(e.instances) || 0,
      running,
      workers,
    };
  });
  const extra = liveList
    .filter((w) => w && typeof w.id === 'string' && isWorkforceOwnedWorker(w.id, name, manifestNames) && !desiredNames.has(w.id))
    .map((w) => ({ name: w.id, profile: w.profile ?? null, state: w.state != null ? String(w.state) : 'running', pid: w.pid ?? null }));
  return {
    name,
    exists: Boolean(manifest),
    supervisorRunning: Boolean(supervisorRunning),
    entries,
    extra,
  };
}

/** Render a `buildWorkforceStatus` report as an aligned text table. Pure. */
function formatWorkforceStatus(report) {
  const lines = [];
  lines.push(`Workforce "${report.name}":`);
  if (!report.exists) {
    lines.push('  (no manifest — create one with: c8ctl nano workforce add <profile> ...)');
    return lines.join('\n');
  }
  lines.push(`  supervisor: ${report.supervisorRunning ? 'running' : 'not running'}`);
  const entries = Array.isArray(report.entries) ? report.entries : [];
  if (entries.length === 0) {
    lines.push('  (empty manifest)');
    return lines.join('\n');
  }
  const rows = [];
  for (const e of entries) {
    for (const w of e.workers) {
      rows.push({
        worker: w.name,
        profile: String(e.profile),
        desired: `${e.running}/${e.desired}`,
        state: w.collision ? `collision(${w.collision})` : w.state,
        pid: w.pid ? String(w.pid) : '-',
        restarts: String(w.restarts),
        uptime: w.state === 'running' && w.uptimeMs != null ? formatDuration(w.uptimeMs) : '-',
      });
    }
  }
  if (rows.length > 0) {
    const head = { worker: 'WORKER', profile: 'PROFILE', desired: 'RUN/WANT', state: 'STATE', pid: 'PID', restarts: 'RESTARTS', uptime: 'UPTIME' };
    const cols = ['worker', 'profile', 'desired', 'state', 'pid', 'restarts', 'uptime'];
    const width = {};
    for (const c of cols) width[c] = Math.max(head[c].length, ...rows.map((r) => r[c].length));
    const fmt = (r) => '  ' + cols.map((c) => r[c].padEnd(width[c])).join('  ');
    lines.push('');
    lines.push(fmt(head));
    for (const r of rows) lines.push(fmt(r));
  }
  const missing = entries.filter((e) => e.running < e.desired);
  if (missing.length > 0) {
    lines.push('');
    lines.push(`  Missing: ${missing.map((e) => `${e.profile} (${e.running}/${e.desired})`).join(', ')} — run: c8ctl nano workforce start${report.name === DEFAULT_WORKFORCE_MANIFEST ? '' : ` --profile ${report.name}`}`);
  }
  if (Array.isArray(report.extra) && report.extra.length > 0) {
    lines.push('');
    lines.push(`  Extra (owned by this workforce, not desired): ${report.extra.map((w) => w.name).join(', ')} — will be stopped on next start.`);
  }
  return lines.join('\n');
}

/** Resolve the manifest name from `--profile` (default `default`). Pure. */
function workforceManifestName(flags) {
  const raw = typeof flags?.profile === 'string' ? flags.profile.trim() : '';
  return raw || DEFAULT_WORKFORCE_MANIFEST;
}

/** Fetch the live supervisor worker set, or `[]` when no daemon is running. */
async function fetchSupervisorWorkers() {
  const running = await liveSupervisor();
  if (!running) return { running: false, reachable: false, workers: [] };
  try {
    const res = await supervisorRequest({ op: 'status' });
    if (res && res.ok) return { running: true, reachable: true, workers: Array.isArray(res.workers) ? res.workers : [] };
  } catch { /* socket unreachable */ }
  return { running: true, reachable: false, workers: [] };
}

async function workforceAddCmd(req, flags, manifestName) {
  const logger = getLogger();
  const profile = req.positional[1];
  if (!profile) {
    logger.error('Usage: c8ctl nano workforce add <profile> [--instances <n>] [--auto [--auto-scope <s>] | --roles a,b,c] [--arg <flag> ...] [--profile <manifest>]');
    process.exit(1);
  }
  if (!isValidProfileName(profile)) {
    logger.error(`Invalid profile name "${profile}". Use letters, digits, dot, dash or underscore.`);
    process.exit(1);
  }
  // The profile must be a hired profile — validated here at `add` and again at
  // `start`. readHiresStrict throws on a torn config (surfaced by the handler).
  const hires = readHiresStrict();
  if (!hires[profile]) {
    logger.error(`No hired profile "${profile}". Create one first with: c8ctl nano hire --name ${profile} --rank <r> --command <cmd>`);
    process.exit(1);
  }
  const { count, error } = parseInstancesCount(flags?.instances, 'workforce add');
  if (error) { logger.error(error); process.exit(1); }
  const auto = coerceBool(flags?.auto, false);
  const rolesFlag = flags?.roles;
  // A bare `--roles` (no value) is parsed as boolean `true` by the flag layer;
  // reject it rather than let `String(true)` create a phantom role named "true"
  // (mirrors how `--instances` rejects a non-numeric value).
  if (rolesFlag === true) {
    logger.error('--roles requires a comma-separated list of role names (e.g. --roles pr-review,fix).');
    process.exit(1);
  }
  // An explicitly provided but empty `--roles` (e.g. `--roles ""`, or an empty
  // array from the flag layer) is a user error, not an implicit "auto": reject
  // it rather than silently defaulting the entry to `roles: "auto"`.
  if (rolesFlag != null && String(rolesFlag).trim() === '') {
    logger.error('--roles requires a comma-separated list of role names (e.g. --roles pr-review,fix).');
    process.exit(1);
  }
  const hasRoles = rolesFlag != null;
  if (flags?.['auto-scope'] === true) {
    logger.error('--auto-scope requires a value.');
    process.exit(1);
  }
  const autoScope = flags?.['auto-scope'] != null ? String(flags['auto-scope']).trim() : '';
  if (auto && hasRoles) {
    logger.error('--auto and --roles are mutually exclusive: an entry is either "auto" (serve all deployed job types) or an explicit role list.');
    process.exit(1);
  }
  if (autoScope && !auto) {
    logger.error('--auto-scope requires --auto.');
    process.exit(1);
  }
  let entry;
  if (hasRoles) {
    const { roles, errors } = parseRolesList(rolesFlag);
    if (errors.length) { logger.error(errors.join('; ')); process.exit(1); }
    if (roles.length === 0) { logger.error('--roles must name at least one role.'); process.exit(1); }
    entry = { profile, instances: count, roles };
  } else {
    // Neither --auto nor --roles → default to "auto" (serve every deployed agent
    // job type), the onboarding/install-script happy path.
    entry = { profile, instances: count, roles: 'auto' };
    if (autoScope) entry.autoScope = autoScope;
  }
  const extraArgs = normalizeArgList(flags?.arg);
  if (extraArgs.length) entry.args = extraArgs;

  let manifest = readWorkforceManifestStrict(manifestName) || emptyWorkforceManifest(manifestName);
  const existed = (manifest.workers || []).some((w) => w && w.profile === profile);
  manifest = upsertManifestEntry(manifest, entry);
  writeWorkforceManifest(manifest);
  logger.info(`${existed ? 'Updated' : 'Added'} "${profile}" in workforce "${manifestName}": instances ${count}, roles ${describeEntryRoles(entry)}${extraArgs.length ? `, args ${extraArgs.join(' ')}` : ''}.`);
  logger.info(`Bring it up with: c8ctl nano workforce start${manifestName === DEFAULT_WORKFORCE_MANIFEST ? '' : ` --profile ${manifestName}`}`);
}

async function workforceRemoveCmd(req, flags, manifestName) {
  const logger = getLogger();
  const profile = req.positional[1];
  if (!profile) {
    logger.error('Usage: c8ctl nano workforce remove <profile|all> [--profile <manifest>]');
    process.exit(1);
  }
  const manifest = readWorkforceManifestStrict(manifestName);
  if (!manifest) { logger.warn(`Workforce "${manifestName}" does not exist — nothing to remove.`); return; }
  const { manifest: next, removed } = removeManifestEntry(manifest, profile);
  if (removed.length === 0) { logger.warn(`No entry for "${profile}" in workforce "${manifestName}".`); return; }
  writeWorkforceManifest(next);
  if (profile === 'all') logger.info(`Cleared workforce "${manifestName}" (${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} removed).`);
  else logger.info(`Removed "${profile}" from workforce "${manifestName}".`);
}

async function workforceListCmd(req, flags, manifestName) {
  const logger = getLogger();
  const json = coerceBool(flags?.json, false);
  const explicitProfile = flags?.profile != null && String(flags.profile).trim() !== '';
  const manifest = readWorkforceManifestStrict(manifestName);
  const others = explicitProfile ? null : listWorkforceManifestNames();
  if (json) {
    const payload = { manifest: manifest || null };
    if (others) payload.manifests = others;
    logger.output(JSON.stringify(payload, null, 2));
    return;
  }
  if (!manifest) {
    logger.info(`Workforce "${manifestName}" does not exist. Create it with: c8ctl nano workforce add <profile> --instances N [--auto|--roles a,b]`);
  } else {
    logger.output(formatWorkforceManifest(manifest));
  }
  if (others && others.length > 0) {
    logger.info('');
    logger.info(`Manifests on this machine: ${others.join(', ')}`);
  }
}

async function workforceStartCmd(req, flags, manifestName) {
  const logger = getLogger();
  const manifest = readWorkforceManifestStrict(manifestName);
  if (!manifest || !Array.isArray(manifest.workers) || manifest.workers.length === 0) {
    logger.info(`Workforce "${manifestName}" is empty — nothing to start. Add workers with: c8ctl nano workforce add <profile> --instances N [--auto|--roles a,b]`);
    return; // friendly, exit 0
  }
  // Resolve each entry's profile → rank and its work args. A profile deleted
  // since it was added yields a clear error, is skipped, and forces a non-zero
  // exit at the end — a partial start never leaves a half-reconciled fleet
  // silently.
  const hires = readHiresStrict();
  const desired = [];
  const skippedProfiles = [];
  let hadError = false;
  for (const entry of manifest.workers) {
    const stored = hires[entry.profile];
    if (!stored) {
      logger.error(`Skipping "${entry.profile}": no such hired profile (create it with c8ctl nano hire --name ${entry.profile} ...).`);
      skippedProfiles.push(entry.profile);
      hadError = true;
      continue;
    }
    const norm = normalizeStoredProfile(entry.profile, stored);
    if (norm.error) {
      logger.error(`Skipping "${entry.profile}": ${norm.error}.`);
      skippedProfiles.push(entry.profile);
      hadError = true;
      continue;
    }
    const args = manifestEntryToWorkArgs(entry, norm.profile.rank);
    for (let i = 1; i <= entry.instances; i++) {
      desired.push({ name: workforceWorkerName(manifestName, entry.profile, i), profile: entry.profile, args });
    }
  }

  const state = await startSupervisorDaemon();
  logger.info(`Supervisor daemon running (pid ${state.pid}).`);
  const { reachable, workers: live } = await fetchSupervisorWorkers();
  // A running daemon with an unreachable status socket reports `live: []`, which
  // would make reconcile think the fleet is empty — duplicating workers it can't
  // see or "stopping" surplus it can't enumerate. Refuse to reconcile blindly
  // and exit non-zero (mirrors `workforce stop`).
  if (!reachable) {
    logger.error('Supervisor daemon is running but its status socket is unreachable — cannot enumerate live workers to reconcile against. Refusing to reconcile blindly; try again once the socket responds.');
    process.exit(1);
  }
  const { toStart, toRestart, toStop, unchanged, collisions, protected: protectedWorkers } = reconcileWorkforce({ desired, live, manifest: manifestName, skippedProfiles, manifestNames: listWorkforceManifestNames() });

  for (const c of collisions) {
    logger.warn(`Skipping "${c.name}": a worker with that name already runs profile "${c.haveProfile}" (manifest wants "${c.wantProfile}") — not clobbering a hand-added worker.`);
    hadError = true;
  }
  for (const id of protectedWorkers) {
    logger.warn(`  = kept "${id}" running (its profile could not be resolved this run — not tearing it down over a config error).`);
  }
  for (const id of toStop) {
    const res = await supervisorRequest({ op: 'remove', target: id });
    if (res && res.ok) logger.info(`  - stopped "${id}" (no longer desired)`);
    else { logger.error(`  ! could not stop "${id}": ${(res && res.error) || 'unknown error'}`); hadError = true; }
  }
  for (const d of toStart) {
    const res = await supervisorRequest({ op: 'add', profile: d.profile, name: d.name, args: d.args });
    if (res && res.ok) logger.info(`  + started "${d.name}" (profile ${d.profile})`);
    else { logger.error(`  ! could not start "${d.name}": ${(res && res.error) || 'unknown error'}`); hadError = true; }
  }
  for (const d of toRestart) {
    const res = await supervisorRequest({ op: 'restart', target: d.name });
    if (res && res.ok) logger.info(`  ↻ restarted "${d.name}" (was not running)`);
    else { logger.error(`  ! could not restart "${d.name}": ${(res && res.error) || 'unknown error'}`); hadError = true; }
  }
  logger.info(`Workforce "${manifestName}" reconciled: ${toStart.length} started, ${toRestart.length} restarted, ${toStop.length} stopped, ${unchanged.length} unchanged${protectedWorkers.length ? `, ${protectedWorkers.length} kept (profile unresolved)` : ''}.`);

  // `--json` is documented for `workforce list/status` only; forcing it off here
  // keeps `workforce start --json` from appending a stray JSON blob to start's
  // human-readable log (which would be neither pure text nor machine-readable).
  await workforceStatusCmd(req, { ...flags, json: false }, manifestName);
  if (hadError) process.exit(1);
}

async function workforceStatusCmd(req, flags, manifestName) {
  const logger = getLogger();
  const json = coerceBool(flags?.json, false);
  const manifest = readWorkforceManifestStrict(manifestName);
  const { running, reachable, workers: live } = await fetchSupervisorWorkers();
  // When the daemon is up but its status socket can't be reached, `live` is
  // empty and the report would falsely show every worker as absent — misleading
  // a human and any automation consuming `--json`. Fail non-zero instead of
  // rendering a phantom "everything down" status (mirrors `workforce stop`).
  if (running && !reachable) {
    logger.error('Supervisor is running but its status socket is unreachable — cannot report worker status. Try again once the socket responds.');
    process.exit(1);
  }
  const report = buildWorkforceStatus(manifest, manifestName, live, running, listWorkforceManifestNames());
  if (json) { logger.output(JSON.stringify(report, null, 2)); return; }
  logger.output(formatWorkforceStatus(report));
}

async function workforceStopCmd(req, flags, manifestName) {
  const logger = getLogger();
  const running = await liveSupervisor();
  if (!running) { logger.warn('Supervisor is not running — nothing to stop.'); return; }
  const manifestNames = listWorkforceManifestNames();
  const { running: stillRunning, reachable, workers: live } = await fetchSupervisorWorkers();
  // The daemon can exit between the liveSupervisor() check above and this call;
  // fetchSupervisorWorkers() then reports running:false (not merely
  // unreachable). Treat that as "nothing to stop" rather than erroring out with
  // a misleading "socket unreachable" message.
  if (!stillRunning) { logger.warn('Supervisor is not running — nothing to stop.'); return; }
  if (!reachable) {
    logger.error('Supervisor is running but its status socket is unreachable — cannot enumerate workers. Leaving the daemon and its workers untouched.');
    process.exit(1);
  }
  const owned = live
    // Ownership is decided by longest-prefix match against the manifests that
    // exist on this machine, so manifest `a` never claims manifest `a-b`'s
    // `wf-a-b-...` workers even though its `wf-a-` prefix technically matches.
    .filter((w) => w && typeof w.id === 'string' && isWorkforceOwnedWorker(w.id, manifestName, manifestNames))
    // A worker id that carries our prefix but whose LIVE profile disagrees with
    // the profile embedded in its deterministic name is a hand-added worker that
    // merely collides on the name (the same case `workforce start` skips): it is
    // NOT ours, so never remove it. Skip only on a positive disagreement — an
    // id we can't parse a profile from, or a live worker with no reported
    // profile, stays owned (unchanged from prior behaviour).
    .filter((w) => {
      const embedded = workforceProfileFromWorkerName(manifestName, w.id);
      if (embedded != null && w.profile != null && w.profile !== embedded) {
        logger.info(`Skipping "${w.id}" — it runs profile "${w.profile}", not the "${embedded}" this manifest owns (name collision); not removing.`);
        return false;
      }
      return true;
    })
    .map((w) => w.id);
  let hadError = false;
  if (owned.length === 0) {
    logger.info(`No workers from workforce "${manifestName}" are running.`);
  } else {
    for (const id of owned) {
      const res = await supervisorRequest({ op: 'remove', target: id });
      if (res && res.ok) logger.info(`Removed worker "${id}".`);
      else { logger.error(`Could not remove "${id}": ${(res && res.error) || 'unknown error'}`); hadError = true; }
    }
  }
  // If no supervised workers remain, stop the daemon too — but only when the
  // status socket actually answered. A `{ workers: [] }` from an *unreachable*
  // socket is ambiguous, and treating it as "empty" would wrongly kill the
  // daemon (and any foreign workers it still supervises).
  const { reachable: stillReachable, workers: remaining } = await fetchSupervisorWorkers();
  if (!stillReachable) {
    logger.warn('Supervisor status socket became unreachable; leaving the daemon running.');
  } else if (remaining.length === 0) {
    logger.info('No supervised workers remain — stopping the supervisor daemon.');
    await supervisorStopCmd();
  } else {
    logger.info(`${remaining.length} other supervised worker(s) remain; leaving the daemon running.`);
  }
  // A worker that could not be removed means the workforce is NOT fully stopped:
  // exit non-zero so automation doesn't mistake a partial stop for success
  // (consistent with `supervisor remove`, which also exits non-zero on failure).
  if (hadError) process.exit(1);
}

async function workforceCommand(req, flags) {
  const logger = getLogger();
  const action = (req.positional[0] || '').toLowerCase();
  // A bare `--profile` (no value) is parsed as boolean `true`; reject it so we
  // fail fast instead of silently operating on the default manifest.
  if (flags?.profile === true) {
    logger.error('--profile requires a manifest name.');
    process.exit(1);
  }
  const manifestName = workforceManifestName(flags);
  if (!isValidManifestName(manifestName)) {
    logger.error(`Invalid --profile "${manifestName}". Use letters, digits, dot, dash or underscore.`);
    process.exit(1);
  }
  switch (action) {
    case 'add':
      await workforceAddCmd(req, flags, manifestName);
      return;
    case 'remove':
    case 'rm':
      await workforceRemoveCmd(req, flags, manifestName);
      return;
    case 'list':
    case 'ls':
      await workforceListCmd(req, flags, manifestName);
      return;
    case 'start':
    case 'up':
      await workforceStartCmd(req, flags, manifestName);
      return;
    case 'status':
      await workforceStatusCmd(req, flags, manifestName);
      return;
    case 'stop':
    case 'down':
      await workforceStopCmd(req, flags, manifestName);
      return;
    default:
      logger.error(`Unknown workforce action "${action}". Use: add|remove|list|start|status|stop`);
      process.exit(1);
  }
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

// ---------------------------------------------------------------------------
// Update changelog. `update --check` (and the pre-pull path of a real update)
// shows what changed between the installed release and latest. The authoritative
// source is this plugin's PUBLIC GitHub Releases — semantic-release records the
// generated notes there (@semantic-release/github). The committed CHANGELOG.md
// is deliberately NOT maintained (the release config dropped the changelog/git
// plugins so it never pushes to the protected `main`) and isn't even in the npm
// `files`, so it can't be the source. Every lookup here is best-effort and
// non-blocking: any failure (offline, rate-limited, private) degrades to a link,
// never to a failed `update`.
// ---------------------------------------------------------------------------

/** `owner/repo` parsed from the plugin package's `repository` field (null if absent). */
function githubRepoSlug() {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    const raw = pkg?.repository?.url ?? (typeof pkg?.repository === 'string' ? pkg.repository : '');
    const m = String(raw).match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?(?:[/#?].*)?$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Keep only the releases strictly newer than `currentVersion` and no newer than
 * `latestVersion` (when known), newest-first. Pure over its `releases` input (an
 * array of GitHub release objects) so it is unit-testable without a network call.
 */
function filterReleasesSince(releases, currentVersion, latestVersion) {
  if (!Array.isArray(releases)) return [];
  const items = [];
  for (const r of releases) {
    if (!r || r.draft || r.prerelease) continue;
    const tag = r.tag_name || r.name || '';
    const norm = String(tag).replace(/^v/, '');
    // Require a plain vX.Y.Z tag: a prerelease/build suffix (e.g. -rc.1, +meta)
    // must exclude the release rather than be normalised away into the window.
    if (!/^\d+\.\d+\.\d+$/.test(norm)) continue;
    const ver = norm;
    if (!currentVersion || compareSemver(ver, currentVersion) <= 0) continue;
    if (latestVersion && compareSemver(ver, latestVersion) > 0) continue;
    items.push({ version: ver, tag, body: r.body || '', url: r.html_url || '' });
  }
  items.sort((a, b) => compareSemver(b.version, a.version));
  return items;
}

/**
 * Render one semantic-release release body to tight terminal lines: drop the
 * redundant `# [x.y.z](…)` header, turn `### Features` into a `Features:` label,
 * flatten `* **scope:** subject ([abc](url))` bullets to `• scope: subject`
 * (stripping any `([label](url))` commit/PR link groups and inlining any
 * remaining `[text](url)` as its text). Returns an array of already-indented lines.
 */
function renderReleaseBody(body) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    if (/^#{1,2}\s+\[?\d+\.\d+\.\d+/.test(line)) continue; // redundant version header
    const heading = line.match(/^#{2,3}\s+(.*\S)\s*$/);
    if (heading) {
      out.push(`    ${heading[1]}:`);
      continue;
    }
    const bullet = line.match(/^\s*[*-]\s+(.*)$/);
    if (bullet) {
      let text = bullet[1]
        .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '') // ([label](url)) commit/PR link groups
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // inline [text](url) -> text
        .replace(/\*\*(.*?)\*\*/g, '$1') // **scope** -> scope
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push(`      \u2022 ${text}`);
    }
  }
  return out;
}

/** Cap on release pages walked, so a repo with a huge history can never hang the walk. */
const RELEASE_PAGE_LIMIT = 20;

/**
 * True once a page contains a published (non-draft/non-prerelease) vX.Y.Z release
 * at or below `current`. Because the releases API returns newest-first, everything
 * after that point is older than the installed version, so the walk can stop.
 */
function reachedInstalledRelease(page, current) {
  if (!current || !Array.isArray(page)) return false;
  for (const r of page) {
    if (!r || r.draft || r.prerelease) continue;
    const norm = String(r.tag_name || r.name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(norm)) continue;
    if (compareSemver(norm, current) <= 0) return true;
  }
  return false;
}

/**
 * Fetch this plugin's GitHub releases newer than `current` (best-effort; null on
 * any failure). Paginates newest-first, stopping as soon as it reaches the
 * installed release (or a bounded page cap), so the window stays accurate even
 * when the installed version is far behind and there are >100 releases since.
 */
async function fetchReleaseNotesSince(slug, current, latest, timeoutMs = 5000) {
  if (!slug) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'c8ctl-plugin-nano',
      'x-github-api-version': '2022-11-28',
    };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const all = [];
      for (let page = 1; page <= RELEASE_PAGE_LIMIT; page++) {
        const res = await fetch(
          `https://api.github.com/repos/${slug}/releases?per_page=100&page=${page}`,
          { headers, redirect: 'follow', signal: ctrl.signal },
        );
        if (!res.ok) return null;
        const arr = await res.json();
        if (!Array.isArray(arr) || arr.length === 0) break;
        all.push(...arr);
        // Newest-first: once we hit the installed release (or a short final
        // page), everything remaining is older than `current` — stop early.
        if (arr.length < 100 || reachedInstalledRelease(arr, current)) break;
      }
      return filterReleasesSince(all, current, latest);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Print the changelog between the installed release and `latest`. Best-effort:
 * on any fetch failure it prints a single line pointing at the releases page and
 * returns, so it can never block or fail an `update`.
 */
async function printChangelogSince(_name, current, latest) {
  const logger = getLogger();
  const slug = githubRepoSlug();
  const releasesUrl = slug ? `https://github.com/${slug}/releases` : null;
  const releases = await fetchReleaseNotesSince(slug, current, latest);

  if (releases === null) {
    if (releasesUrl) logger.info(`See what changed: ${releasesUrl}`);
    logger.info('');
    return;
  }
  if (releases.length === 0) {
    // Nothing resolved between the two (only a build-metadata bump, or a
    // degraded resolution: current is null / tags don't match vX.Y.Z). Point
    // at the releases page so the best-effort feature still leaves a trail.
    if (releasesUrl) logger.info(`See what changed: ${releasesUrl}`);
    logger.info('');
    return;
  }

  logger.info(`What's changed since v${current ?? '?'}:`);
  logger.info('');
  for (const rel of releases) {
    logger.info(`  v${rel.version}`);
    const lines = renderReleaseBody(rel.body);
    if (lines.length === 0) logger.info('      (no notes)');
    else for (const l of lines) logger.info(l);
    logger.info('');
  }
  if (releasesUrl) logger.info(`Full release notes: ${releasesUrl}`);
  logger.info('');
}

/**
 * Resolve how npm must be spawned on the given platform. Spawning `npm`
 * directly is not portable: on Windows npm is a `npm.cmd` shim, so bare
 * `"npm"` fails with ENOENT and `"npm.cmd"` fails with EINVAL under the
 * CVE-2024-27980 hardening. On Windows the shim is therefore run through
 * cmd.exe (`shell: true`) with every argument double-quoted, and the two
 * constructs that survive double quotes — an embedded `"` and a `%VAR%`
 * reference — are rejected rather than escaped.
 *
 * This mirrors the host CLI's own `buildNpmInvocation`; it is the local
 * fallback for `runNpm` when the host runner (`c8ctl.npm`) is unavailable.
 * `platform` is a parameter so the Windows branch is unit-testable on POSIX.
 */
function buildNpmInvocation(args, platform = process.platform) {
  if (platform !== 'win32') {
    return { command: 'npm', args: [...args], shell: false };
  }
  for (const arg of args) {
    if (/["\r\n\0]/.test(arg)) {
      throw new Error(
        `Refusing to run npm: argument contains a quote or line break that cannot be passed safely to cmd.exe: ${JSON.stringify(arg)}`,
      );
    }
    if (/%[A-Z_][^%]*?%/i.test(arg)) {
      throw new Error(
        `Refusing to run npm: argument contains a cmd.exe environment variable reference: ${JSON.stringify(arg)}`,
      );
    }
  }
  return {
    command: 'npm.cmd',
    args: args.map((arg) => `"${arg.replace(/(\\+)$/, '$1$1')}"`),
    shell: true,
  };
}

/** Local, platform-aware npm runner used when the host `c8ctl.npm` is absent. */
function runNpmLocal(args, { stdout = false, stdio } = {}) {
  const { command, args: resolved, shell } = buildNpmInvocation(args);
  if (shell) {
    const cmdLine = [command, ...resolved].join(' ');
    if (stdout) {
      return { stdout: execSync(cmdLine, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }) };
    }
    execSync(cmdLine, { stdio });
    return undefined;
  }
  if (stdout) {
    return {
      stdout: execFileSync(command, resolved, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false }),
    };
  }
  execFileSync(command, resolved, { stdio, shell: false });
  return undefined;
}

/**
 * Run npm portably. Prefers the host CLI's cross-platform runner
 * (`globalThis.c8ctl.npm`, added in c8ctl's plugin runtime); falls back to the
 * local platform-aware invocation for older hosts and for the detached update
 * refresh, which runs without the host runtime. Throws on a nonzero exit.
 */
function runNpm(args, { stdout = false, stdio } = {}) {
  const host = globalThis.c8ctl;
  if (host && typeof host.npm === 'function') {
    return stdout ? host.npm({ args, stdout: true }) : host.npm({ args, stdio });
  }
  return runNpmLocal(args, { stdout, stdio });
}

/** Latest published version of `name` per the npm registry (throws on failure). */
function npmLatestVersion(name) {
  const { stdout } = runNpm(['view', name, 'version'], { stdout: true });
  return stdout.trim();
}

/** True when this plugin lives under npm's global node_modules (so `-g` updates it). */
function isGlobalInstall() {
  let root;
  try {
    root = runNpm(['root', '-g'], { stdout: true }).stdout.trim();
  } catch {
    return false;
  }
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

async function updatePlugin(req) {
  const logger = getLogger();
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

  logger.info(`Installed: ${name} v${current ?? '?'}${nanoNote}`);

  let latest;
  try {
    latest = npmLatestVersion(name);
  } catch (err) {
    logger.info(`Could not check npm for updates: ${err.message}`);
    logger.info('Pull the latest release manually with:');
    logger.info(manual);
    return;
  }
  logger.info(`Latest:    ${name} v${latest}  (npm)`);
  logger.info('');

  if (current && compareSemver(current, latest) >= 0) {
    if (!nanoBin) {
      // Plugin is current but npm never fetched the matching server binary.
      logger.info('Plugin is current, but the nano server binary is not installed for this platform.');
      logger.info('Provision it by reinstalling the plugin so npm fetches the platform package:');
      logger.info('  c8ctl sync plugin');
      return;
    }
    logger.info('Already on the latest release — nothing to do.');
    return;
  }

  logger.info(`Update available: v${current ?? '?'} -> v${latest}`);
  logger.info('');

  await printChangelogSince(name, current, latest);

  if (req.check) {
    logger.info('Run `c8ctl nano update` to pull it (or manually):');
    logger.info(manual);
    return;
  }

  if (info.mode === 'local') {
    logger.info('This plugin runs from a local checkout, so it cannot self-update in place.');
    logger.info('Update it with:');
    logger.info(manual);
    return;
  }

  const installArgs =
    info.mode === 'managed'
      ? ['install', `${name}@${latest}`, '--prefix', info.prefix]
      : ['install', '-g', `${name}@${latest}`];
  const where = info.mode === 'managed' ? 'the c8ctl plugin store' : "npm's global prefix";
  logger.info(`Pulling ${name}@${latest} into ${where}...`);
  logger.info('');
  try {
    runNpm(installArgs, { stdio: 'inherit' });
  } catch (err) {
    let hint;
    if (info.mode === 'managed') {
      hint = `You can also run:\n${manual}`;
    } else if (osPlatform() === 'win32') {
      hint = `You may need to run this command in an elevated terminal (Administrator): ${manual.trim()}`;
    } else {
      hint = `You may need elevated permissions: sudo ${manual.trim()}`;
    }
    const code = typeof err?.status === 'number' ? ` (exit ${err.status})` : '';
    throw new Error(
      `npm ${installArgs.join(' ')} failed${code}. ${hint}`,
    );
  }
  logger.info('');
  if (info.mode === 'managed') {
    logger.info(`Updated to v${latest}. The new plugin and bundled nano server load on your next c8ctl command.`);
  } else {
    logger.info(`Updated to v${latest}.`);
  }
  logger.info('Restart any running cluster to use the new server binary:');
  logger.info('  c8ctl nano restart');
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
  // The refresh runs in a detached bare-node child that has no host runtime, so
  // it cannot use c8ctl.npm. Resolve the portable npm invocation here (single
  // source of truth) and bake the decided command into a generic runner in the
  // child — the child makes no platform decision of its own.
  let inv;
  try {
    inv = buildNpmInvocation(['view', name, 'version']);
  } catch {
    return; /* unsafe argument for cmd.exe; skip this cycle */
  }
  const script =
    'const{execFileSync,execSync}=require("child_process");' +
    'const{readFileSync,writeFileSync}=require("fs");' +
    `const cmd=${JSON.stringify(inv.command)},args=${JSON.stringify(inv.args)},shell=${JSON.stringify(inv.shell)};` +
    `let prev={};try{prev=JSON.parse(readFileSync(${JSON.stringify(cacheFile)},"utf8"))}catch{}` +
    'const out=Object.assign({},prev,{lastCheck:Date.now()});' +
    'try{' +
    'const o=shell' +
    '?execSync([cmd,...args].join(" "),{stdio:["ignore","pipe","pipe"],encoding:"utf8"})' +
    ':execFileSync(cmd,args,{stdio:["ignore","pipe","pipe"],encoding:"utf8",shell:false});' +
    'out.latest=String(o||"").trim()' +
    '}catch{}' +
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

// --- Pre-upgrade read-model backup -----------------------------------------
// A schema-changing gateway release can reproject the SQLite read model and
// silently drop completed process-instance history (see nano-bpm#831). Until
// the engine ships non-destructive migrations, the launcher is the last line of
// defence: before we swap the binary for a different version, snapshot each
// per-node read model so the pre-upgrade state is always recoverable.

/** How many prior pre-upgrade backups to keep per node (bounds disk use). */
const READ_MODEL_BACKUP_RING = 5;

/** Filesystem-safe tag for the version being replaced (for the backup name). */
function sanitizeVersionTag(v) {
  const s = String(v ?? '').trim() || 'unknown';
  return s.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Copy `src` to `dest` when it exists; best-effort (sidecars may be absent).
 * A genuinely absent sidecar is fine and stays silent, but a sidecar that
 * exists yet cannot be copied (permissions/lock) is logged as a warning so an
 * incomplete backup never passes unnoticed — a missing/locked sidecar must
 * still never fail the backup itself.
 */
function copyIfExists(src, dest, logger) {
  if (!existsSync(src)) return false;
  try {
    copyFileSync(src, dest);
    return true;
  } catch (err) {
    logger?.warn?.(
      `Read-model backup: could not copy ${src} (continuing): ${err?.message ?? err}`,
    );
  }
  return false;
}

/**
 * Snapshot every per-node read model before an upgrade swaps the gateway
 * binary. For each `<dataDir>/node-*` that has a `read-model.sqlite`, copy it —
 * plus its `-wal` sidecar (WAL mode keeps uncheckpointed pages there) and the
 * `-shm` shared-memory index — to a timestamped file under a
 * `read-model-backups/` subdir. We also grab the coherent point-in-time set
 * (`snapshot.*.bin` + `journal.head`) when present, and prune to a bounded ring
 * of prior backups. Best-effort: any failure is logged and swallowed so it can
 * never block the upgrade itself.
 *
 * @param {string|null} oldVersion  version being replaced (used in the filename)
 * @param {number} ring             prior backups to keep per node
 * @returns {string[]} paths of the primary `.sqlite` copies written
 */
function backupReadModelsBeforeUpgrade(oldVersion, ring = READ_MODEL_BACKUP_RING) {
  const logger = getLogger();
  const dataDir = getDataDir();
  const written = [];

  let nodeDirs;
  try {
    nodeDirs = readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('node-'))
      .map((d) => d.name);
  } catch {
    return written; // no data dir yet — nothing to back up
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Append a short random token so two backup runs landing in the same
  // millisecond (parallel starts, or a retry loop) can't derive an identical
  // stem and clobber each other's pre-upgrade set.
  const uniq = randomBytes(3).toString('hex');
  const verTag = sanitizeVersionTag(oldVersion);

  for (const node of nodeDirs) {
    const nodeDir = join(dataDir, node);
    const readModel = join(nodeDir, 'read-model.sqlite');
    if (!existsSync(readModel)) continue; // in-memory node, or never projected

    const backupDir = join(nodeDir, 'read-model-backups');
    const stem = `read-model.pre-upgrade-${verTag}-${ts}-${uniq}`;
    try {
      mkdirSync(backupDir, { recursive: true });

      // Primary DB + its WAL/SHM sidecars (uncheckpointed pages live in -wal).
      const destSqlite = join(backupDir, `${stem}.sqlite`);
      copyFileSync(readModel, destSqlite);
      written.push(destSqlite);
      copyIfExists(join(nodeDir, 'read-model.sqlite-wal'), join(backupDir, `${stem}.sqlite-wal`), logger);
      copyIfExists(join(nodeDir, 'read-model.sqlite-shm'), join(backupDir, `${stem}.sqlite-shm`), logger);

      // Coherent point-in-time set: journal head + all snapshot bins.
      copyIfExists(join(nodeDir, 'journal.head'), join(backupDir, `${stem}.journal.head`), logger);
      for (const f of readdirSync(nodeDir)) {
        if (/^snapshot\..*\.bin$/.test(f)) {
          copyIfExists(join(nodeDir, f), join(backupDir, `${stem}.${f}`), logger);
        }
      }

      logger.info(`Backed up read model before upgrade: ${destSqlite}`);
      pruneReadModelBackups(backupDir, ring, logger);
    } catch (err) {
      logger.warn(
        `Read-model backup for ${node} failed (continuing upgrade): ${err?.message ?? err}`,
      );
    }
  }
  return written;
}

/**
 * Keep only the newest `ring` pre-upgrade backup sets in `backupDir`, deleting
 * the oldest. A "set" is all files sharing a `read-model.pre-upgrade-*` stem
 * (the `.sqlite` plus its `-wal`/`-shm`/`journal.head`/`snapshot.*` siblings),
 * identified by the primary `.sqlite` file and ordered by its mtime.
 */
function pruneReadModelBackups(backupDir, ring = READ_MODEL_BACKUP_RING, logger = getLogger()) {
  if (!(ring > 0)) return;
  let entries;
  try {
    entries = readdirSync(backupDir);
  } catch {
    return;
  }

  const stems = entries
    .filter((f) => f.startsWith('read-model.pre-upgrade-') && f.endsWith('.sqlite'))
    .map((f) => f.slice(0, -'.sqlite'.length));
  if (stems.length <= ring) return;

  const withTime = stems.map((stem) => {
    let mtime = 0;
    try {
      mtime = statSync(join(backupDir, `${stem}.sqlite`)).mtimeMs;
    } catch {
      /* fall back to 0 so an unreadable set sorts oldest and is dropped first */
    }
    return { stem, mtime };
  });
  withTime.sort((a, b) => a.mtime - b.mtime);

  for (const { stem } of withTime.slice(0, withTime.length - ring)) {
    for (const f of entries) {
      if (f === `${stem}.sqlite` || f.startsWith(`${stem}.`)) {
        try {
          rmSync(join(backupDir, f), { force: true });
        } catch {
          /* best-effort prune */
        }
      }
    }
    logger.info(`Pruned old read-model backup set: ${join(backupDir, stem)}.*`);
  }
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
      // Before swapping the binary for a different version, snapshot each
      // node's read model so a schema-changing release can never silently
      // destroy completed-instance history (issue #85). First download of a
      // fresh install (no cached copy) is not an upgrade, so it is skipped.
      if (haveCached) {
        try {
          backupReadModelsBeforeUpgrade(haveVer);
        } catch (err) {
          logger.warn(
            `Pre-upgrade read-model backup failed (continuing upgrade): ${err?.message ?? err}`,
          );
        }
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
export {
  backupReadModelsBeforeUpgrade,
  pruneReadModelBackups,
  sanitizeVersionTag,
  READ_MODEL_BACKUP_RING,
};
export { setConfig, unsetConfig, readConfig, writeConfig, getConfigFile, SETTING_ALIASES };
export { buildNpmInvocation };
export { resolveAgenticConfig, LOCAL_AGENTIC_TOKEN };
export { resolveAgenticSetting, PROTOCOLS, PERMISSION_MODES };
export { resolveAgenticTarget, discoverAgenticHubs, probeAgenticChannel, normalizeProjectApps, isLoopbackHost };
export { compareSemver, githubRepoSlug, filterReleasesSince, renderReleaseBody };
export {
  webConsoleUrl,
  consoleLinkLabel,
  hireWorker,
  assignCapabilities,
};
export {
  normalizeTaskEnvelope,
  collectEnvelopeFrom,
  parseLinkedResources,
  pickLinkedResource,
  resolveBrokerRestConfig,
  resolveAutoRestConfig,
  resolveWorkerEngineBase,
  resolveWorkerPollEngineBase,
  resolveLinkedPromptBase,
  resourceContentUrl,
  fetchLinkedResourceContent,
  resolveLinkedPrompt,
  resolveLinkedPromptSource,
  normalizeRestBase,
  coerceBool,
  coerceInt,
  deepMerge,
  resolveJobSecrets,
  makeSecretResolver,
  hostEnvSecretResolver,
  buildAgentPayload,
  buildResultEnvelope,
  parseAgentResultObject,
  readAgentResultFile,
  parseResultFromStdout,
  sanitizeResultVars,
  parseEnvPairs,
  normalizeEnvMap,
  normalizeArgList,
  shQuote,
  buildAgentCommandLine,
  reapAgentContainers,
  diskBudgetOk,
  containerEngineAvailable,
  runAgentJob,
  spawnCapturePty,
  spawnCaptureAcp,
  ensureAcpFlag,
  startLockExtender,
  provisionRepo,
  finalizeGit,
  describeGitFailure,
  boundGitOutput,
  reconcileAgentPr,
  resolveCommitterIdentity,
  isPlaceholderEmail,
  postAgentAttribution,
  reapAgentRunDirs,
  authUrl,
  githubCloneToken,
  ghAuthTokenFromCli,
  primeGhAuthToken,
  ghAuthEnv,
  redactToken,
  agentRunsRoot,
  ProvisionError,
  normalizeStoredProfile,
  applyAssign,
  resolveAssignInputs,
  jobTypeMatrix,
  diffJobTypes,
  parseJobTypeFlags,
  scanAgentTaskLeaves,
  readDeployedAgentJobTypes,
  resolveAutoJobTypes,
  workAgent,
  derivePollTimeoutMs,
  AGENT_TASK_NS,
  AGENT_RESULT_KEY,
  LINKED_RESOURCES_HEADER,
  DEFAULT_PROMPT_LINK_NAME,
  RESULT_SENTINEL,
  RESERVED_RESULT_KEYS,
  SANDBOXES,
};
export {
  reconstructWorkArgs,
  supervisorWorkerId,
  autoWorkerName,
  sanitizeNameToken,
  isValidWorkerName,
  randomNameSuffix,
  extractNameFlag,
  parseInstancesCount,
  extractInstancesFlag,
  redactWorkArgs,
  supervisorBackoffMs,
  encodeFrame,
  decodeFrames,
  formatDuration,
  summarizeSupervisorWorker,
  formatSupervisorStatus,
  formatSupervisorLogsLines,
  reageSupervisorStatus,
  clampToWidth,
  createSupervisorLiveView,
  printSupervisorStatus,
  supervisorStatusSignature,
  supervisorJobCell,
  supervisorEngineCell,
  supervisorAgenticCell,
  agenticStateForTarget,
  normalizeAgenticMessage,
  buildActivityPayload,
  supervisorWorkerActivityFile,
  WORK_FORWARD_FLAGS,
  installParentDeathWatchdog,
  runSupervisorDaemon,
  startSupervisorDaemon,
  supervisorRequest,
  supervisorAddCmd,
  runningSupervisor,
  readSupervisorState,
  clearSupervisorState,
  getSupervisorSocketPath,
  getSupervisorStateFile,
};

export {
  WORKFORCE_MANIFEST_VERSION,
  DEFAULT_WORKFORCE_MANIFEST,
  isValidManifestName,
  emptyWorkforceManifest,
  parseRolesList,
  rolesToJobTypes,
  manifestEntryToWorkArgs,
  workforceOwnerPrefix,
  workforceWorkerName,
  workforceProfileFromWorkerName,
  isWorkforceOwnedWorker,
  expandWorkforceDesired,
  reconcileWorkforce,
  normalizeManifestEntry,
  validateWorkforceManifest,
  readWorkforceManifestStrict,
  writeWorkforceManifest,
  listWorkforceManifestNames,
  getWorkforceDir,
  getWorkforceManifestFile,
  upsertManifestEntry,
  removeManifestEntry,
  describeEntryRoles,
  formatWorkforceManifest,
  buildWorkforceStatus,
  formatWorkforceStatus,
  workforceManifestName,
};

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
        { command: 'c8ctl nano unset bin', description: 'Clear a custom binary path and return to the managed/release binary' },
        { command: 'c8ctl nano set model-dir <path>', description: 'Set the workspace dir (models + workers)' },
        { command: 'c8ctl nano config', description: 'Show current plugin configuration and paths' },
        { command: 'c8ctl nano update', description: 'Pull the latest published nano release (re-installs via npm)' },
        { command: 'c8ctl nano update --check', description: 'Check for a newer nano release and show the changelog since the installed version (no install)' },
        { command: 'c8ctl nano hire', description: 'Interactively create a CLI agent worker profile (name, rank, command, model, capabilities)' },
        { command: 'c8ctl nano hire --name reviewer --rank senior --command copilot --model gpt-5 --capabilities code-review,testing', description: 'Create a profile non-interactively' },
        { command: 'c8ctl nano hire --name coder --rank senior --command copilot --arg --allow-all', description: 'Hire copilot with a command-line switch (copilot --allow-all)' },
        { command: 'c8ctl nano hire --name coder --rank senior --command copilot --env COPILOT_ENABLE_ALL_TOOLS=1', description: 'Persist a harness startup env var (e.g. permissions) on the profile' },
        { command: 'c8ctl nano hire --list', description: 'List hired agent profiles' },
        { command: 'c8ctl nano hire --name coder --rank senior --command "agent-harness" --sandbox docker --image ghcr.io/acme/agent:1', description: 'Create a profile that runs each job in a throwaway Docker container' },
        { command: 'c8ctl nano hire --name coder --rank senior --command copilot --terminal pty', description: 'Opt this role into a full, steerable live terminal (PTY) streamed on the agentic relay lane (default: pipe)' },
        { command: 'c8ctl nano hire --name coder --rank senior --command copilot --protocol acp --permission yolo', description: 'Drive this role over ACP (JSON-RPC/stdio) — ACTIVE on the host executor (sandbox=none); container sandboxes do not yet run ACP (pipe-only today; --terminal pty is host-only). permission yolo is enforced; escalate/filter are reserved (persisted, warned, behave like yolo)' },
        { command: 'c8ctl nano assign reviewer code-review,testing', description: 'Grant more capabilities (comma-separated, like hire) to an existing hire — additive; running workers hot-reload it' },
        { command: 'c8ctl nano work reviewer', description: 'Spawn Nano job workers for the "reviewer" profile and poll for work' },
        { command: 'c8ctl nano work coder --auto', description: 'Zero-config: serve every deployed agent job type read straight from the engine — no capability, no wiring (great for a local single-tenant plane)' },
        { command: 'c8ctl nano work coder --auto --auto-scope my-app', description: 'Zero-config, scoped to one app: serve only agent job types deployed under process ids prefixed "my-app"' },
        { command: 'c8ctl nano work coder --sandbox docker --image ghcr.io/acme/agent:1', description: 'Run jobs in isolated containers with disk-hygiene reaping' },
        { command: 'NANO_AGENTIC_URL=http://localhost:8080 NANO_AGENTIC_SECRET=<shared-secret> c8ctl nano work reviewer', description: 'Enrol the worker on the app\'s same-port /agentic channel in SECURE mode (same NANO_AGENTIC_SECRET as the server) so it appears live (presence + relay terminals) on the Workforce visibility page' },
        { command: 'c8ctl nano supervisor start --worker reviewer --worker coder', description: 'Start a detached supervisor managing several workers from one terminal' },
        { command: 'c8ctl nano supervisor', description: 'Attach an interactive console to the supervisor (detach with Ctrl-D, leaving it running)' },
        { command: 'c8ctl nano supervisor status', description: 'List supervised workers (state, ENGINE + AGENTIC visibility diagnostics, serviced job / idle, pid, restarts, uptime) without the console' },
        { command: 'c8ctl nano supervisor add decider', description: 'Add a supervised worker (forwarding work flags) to the running supervisor' },
        { command: 'c8ctl nano supervisor add reviewer --instances 3', description: 'Add 3 distinct auto-named instances of a profile in one call' },
        { command: 'c8ctl nano supervisor restart reviewer', description: 'Restart a supervised worker by id or profile' },
        { command: 'c8ctl nano supervisor stop', description: 'Stop the supervisor daemon and all its workers' },
        { command: 'c8ctl nano workforce add copilot --instances 5 --auto', description: 'Compose a reusable fleet: 5 copilot workers serving every deployed agent job type (--auto)' },
        { command: 'c8ctl nano workforce add qwen --instances 2 --roles pr-review,feature', description: 'Add an entry mapped to explicit job types (senior:pr-review, senior:feature) at start — does not mutate the hired profile' },
        { command: 'c8ctl nano workforce start', description: "Ensure the daemon is up, then reconcile running workers to the 'default' manifest (idempotent — a second run changes nothing)" },
        { command: 'c8ctl nano workforce start --profile review-only', description: 'Bring up a named manifest (<stateHome>/workforce/review-only.json)' },
        { command: 'c8ctl nano workforce status --json', description: 'Manifest entries joined against live supervisor status (desired vs actual), machine-readable for the install script / CI' },
        { command: 'c8ctl nano workforce list', description: 'Print the default manifest and list the manifests that exist on this machine' },
        { command: 'c8ctl nano workforce stop', description: "Remove this manifest's workers; stop the daemon too if no supervised workers remain" },
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
      console: { type: 'string', description: 'start: runtime console profile off|observe|studio (NANOBPMN_CONSOLE; default studio)' },
      follow: { type: 'boolean', description: 'logs: stream output (tail -F)', short: 'f' },
      purge: { type: 'boolean', description: 'stop/restart: also delete per-node engine data' },
      force: { type: 'boolean', description: 'start: stop any existing cluster first' },
      workspace: { type: 'boolean', description: 'clean: also delete the workspace (models + workers)' },
      check: { type: 'boolean', description: 'update: report whether a new release is available (with the changelog since the installed version); do not install' },
      binary: { type: 'string', description: 'Path to the nanobpmn server binary' },
      name: { type: 'string', description: 'work/supervisor add: worker name (auto ‹host›-‹profile›-‹random› if omitted); hire/assign: agent profile name' },
      rank: { type: 'string', description: 'hire: agent rank (principal|senior|junior|decider)' },
      command: { type: 'string', description: 'hire: CLI command that runs the agent harness (e.g. copilot, claude, pi)' },
      arg: { type: 'string', multiple: true, description: 'hire/work: command-line switch/arg appended to the harness command (repeatable), e.g. --arg --allow-all. Persisted on hire; work appends more.' },
      model: { type: 'string', description: 'hire: model name passed to the harness (AGENT_MODEL)' },
      capabilities: { type: 'string', description: 'hire/assign: comma-separated capability list' },
      sandbox: { type: 'string', description: 'hire/work: execution sandbox none|docker|podman (default none). Containers isolate each job.' },
      image: { type: 'string', description: 'hire/work: container image the agent runs in (required for --sandbox docker|podman)' },
      terminal: { type: 'string', description: 'hire: live-terminal mode for this role — pty (full terminal, streamed + steerable on the relay lane) or pipe (default). NANO_AGENTIC_TERMINAL overrides at work time.' },
      protocol: { type: 'string', description: 'hire: harness protocol pipe|acp (default pipe). acp drives the harness over ACP (JSON-RPC 2.0 over stdio) on the host executor (sandbox=none); container sandboxes (docker/podman) do NOT yet run ACP and are pipe-only today (--terminal pty is host-only; container ACP lands downstream). NANO_AGENTIC_PROTOCOL overrides at work time.' },
      permission: { type: 'string', description: 'hire: ACP permission policy (default yolo). yolo auto-allows all permission requests. escalate|filter are RESERVED/not-yet-active in this build (pending nano-workforce#559): they are persisted but not enforced and effectively behave like yolo (auto-allow). NANO_AGENTIC_PERMISSION overrides at work time.' },
      env: { type: 'string', multiple: true, description: 'hire/work: static env var for the harness as NAME=VALUE (repeatable); persisted on hire, work extends/overrides. E.g. permission toggles.' },
      'secret-resolver': { type: 'string', description: 'work: secret resolver for task secretRefs (host = process env; default host)' },
      'reap-age': { type: 'string', description: 'work: age in ms before a finished agent container or job workspace is reaped (default 3600000)' },
      'reap-interval': { type: 'string', description: 'work: how often to sweep finished agent containers and job workspaces in ms (default 300000)' },
      'min-free-mb': { type: 'string', description: 'work: shed jobs when the engine data root has less than this many MB free (default 1024)' },
      'clone-timeout': { type: 'string', description: 'work: max time in ms for cloning a task repository on the host (default 120000)' },
      'keep-runs': { type: 'boolean', description: 'work: keep per-job workspaces under <state>/agent-runs instead of deleting them after each job (debug)' },
      stream: { type: 'boolean', description: 'work: tee each agent job\'s live stdout/stderr to this console, prefixed with the job type + key (spy/debug)' },
      list: { type: 'boolean', description: 'hire: list existing agent profiles instead of creating one' },
      'job-timeout': { type: 'string', description: 'work: OPTIONAL absolute hard cap on total harness runtime per job in ms; the process is killed past this. Default 0 = unlimited (the broker lock is auto-managed — see --recovery-window / --idle-timeout).' },
      'recovery-window': { type: 'string', description: 'work: broker activation-lock window in ms, auto-refreshed while the agent runs; also the node-loss reclaim time (a dead/killed worker\'s job is re-activated within this). Default 300000.' },
      'idle-timeout': { type: 'string', description: 'work: max ms an agent may produce no stdout/stderr before it is killed as wedged (stops lock extension → job reclaimed). Default 300000.' },
      'lock-grace': { type: 'string', description: 'work: DEPRECATED and ignored — the broker lock is now auto-managed via --recovery-window.' },
      'poll-timeout': { type: 'string', description: 'work: broker long-poll window in ms each activateJobs request is held open (fewer reconnects → fewer transient connect errors); default 30000, 0 = broker default, negative = return immediately' },
      'job-type': { type: 'string', multiple: true, description: 'work: extra job type to service alongside the rank×capability matrix (repeatable)' },
      auto: { type: 'boolean', description: 'work: zero-config enrolment — serve ALL deployed agent job types read straight from the engine (no capability, no app enrol endpoint, no channel). Mutually exclusive with capability-resolved serving; has NO capability gate (serves any deployed agent job on the engine).' },
      'auto-scope': { type: 'string', description: 'work: with --auto, narrow the served agent job types to those whose bpmn:process id equals or is prefixed by this value (one app/network). Default: all agent job types on the engine.' },
      worker: { type: 'string', multiple: true, description: 'supervisor start: profile to launch as a supervised worker (repeatable)' },
      instances: { type: 'string', description: `supervisor add / workforce add: spawn/compose N distinct instances of the profile in one call (default 1, max ${MAX_ADD_INSTANCES}; for supervisor add cannot combine with --name)` },
      attach: { type: 'boolean', description: 'supervisor start: attach the interactive console after starting the daemon' },
      profile: { type: 'string', description: `workforce: manifest name to operate on (default ${DEFAULT_WORKFORCE_MANIFEST}); each subcommand reads/writes <stateHome>/workforce/<name>.json` },
      roles: { type: 'string', description: 'workforce add: comma-separated role list for the entry (→ --job-type <rank>:<role> at start); mutually exclusive with --auto' },
      json: { type: 'boolean', description: 'workforce list/status: emit machine-readable JSON (for the install script / CI)' },
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
          case 'unset':
            unsetConfig(req);
            break;
          case 'config':
            showConfig();
            break;
          case 'update':
            await updatePlugin(req);
            break;
          case 'hire':
            await hireWorker(req, flags);
            break;
          case 'assign':
            await assignCapabilities(req, flags);
            break;
          case 'work':
            await workAgent(req, flags);
            break;
          case 'supervisor':
            await supervisorCommand(req, flags);
            break;
          case 'workforce':
            await workforceCommand(req, flags);
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
  console.log('  c8ctl nano start [<nodes>] [--port <basePort>] [--partitions <n>] [--rf <n>] [--raft] [--capture] [--in-memory] [--history-max <n>] [--console <profile>] [--binary <path>]');
  console.log('  c8ctl nano status [--port <port>]');
  console.log('  c8ctl nano stop [--purge]');
  console.log('  c8ctl nano logs [<nodeId>] [--follow]');
  console.log('  c8ctl nano pause <nodeId>');
  console.log('  c8ctl nano resume <nodeId>');
  console.log('  c8ctl nano restart [<nodes>] [--purge] ...');
  console.log('  c8ctl nano clean [--workspace]');
  console.log('  c8ctl nano set <bin|model-dir> <path>');
  console.log('  c8ctl nano unset <bin|model-dir>');
  console.log('  c8ctl nano config');
  console.log('  c8ctl nano update [--check]');
  console.log('  c8ctl nano hire [--name <n>] [--rank <r>] [--command <c>] [--arg <switch> ...] [--model <m>] [--capabilities <a,b>] [--sandbox none|docker|podman] [--image <ref>] [--terminal pty|pipe] [--protocol pipe|acp] [--permission yolo|escalate|filter] [--env NAME=VALUE ...] [--list]');
  console.log('  c8ctl nano assign <profileName> <cap[,cap...]> [--name <n>] [--capabilities <a,b>]');
  console.log('  c8ctl nano work <profileName> [--auto [--auto-scope <p>]] [--arg <switch> ...] [--recovery-window <ms>] [--idle-timeout <ms>] [--job-timeout <ms>] [--poll-timeout <ms>] [--job-type <token> ...] [--sandbox none|docker|podman] [--image <ref>] [--env NAME=VALUE ...] [--secret-resolver host] [--min-free-mb <n>] [--clone-timeout <ms>] [--keep-runs] [--stream]');
  console.log('  c8ctl nano supervisor [start|status|add|remove|restart|stop|logs|attach] ... (manage many workers from one terminal)');
  console.log('  c8ctl nano workforce [add|remove|list|start|status|stop] ... [--profile <manifest>] (declarative, reusable fleet manifests)');
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
  console.log('  unset    Clear a setting ("bin" or "model-dir") back to its default');
  console.log('  config   Show current configuration and on-disk locations');
  console.log('  update   Pull the latest published nano release (--check to only report)');
  console.log('  hire     Create a CLI agent worker profile (rank + capabilities → job-type matrix)');
  console.log('  assign   Grant new capabilities (roles) to an existing hire (additive; comma-separated; workers hot-reload)');
  console.log('  work     Run a hired profile as Nano job workers, polling for work until Ctrl-C');
  console.log('  supervisor  Run/manage a fleet of workers from one terminal (detachable console + non-interactive control)');
  console.log('  workforce   Compose a reusable, declarative fleet manifest and reconcile it up/down (add|remove|list|start|status|stop)');
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
  console.log('  --console <profile>  start: runtime console profile off|observe|studio (default studio)');
  console.log('  --binary <path>      Path to the nanobpmn server binary (overrides "set bin")');
  console.log('  --purge              stop: also delete per-node engine data');
  console.log('  --force              start: stop any existing cluster first');
  console.log('  --workspace          clean: also delete the workspace (models + workers)');
  console.log('  --name <n>           hire/work/assign: agent profile name (alt to positional arg)');
  console.log('  --rank <r>           hire: agent rank (principal|senior|junior|decider)');
  console.log('  --command <c>        hire: CLI command that runs the agent harness');
  console.log('  --model <m>          hire: model name passed to the harness (AGENT_MODEL)');
  console.log('  --capabilities <a,b> hire/assign: comma-separated capability list');
  console.log('  --sandbox <s>        hire/work: execution sandbox none|docker|podman (default none)');
  console.log('  --image <ref>        hire/work: container image the agent runs in (required for docker|podman)');
  console.log('  --terminal <m>       hire: live-terminal mode pty|pipe (default pipe); pty streams a steerable terminal on the relay lane');
  console.log('  --protocol <p>       hire: harness protocol pipe|acp (default pipe); acp drives the harness over ACP (JSON-RPC/stdio) on the host executor (sandbox=none) — container sandboxes do not yet run ACP (pipe-only today; --terminal pty is host-only). NANO_AGENTIC_PROTOCOL overrides at work time');
  console.log('  --permission <p>     hire: ACP permission policy yolo|escalate|filter (default yolo); yolo auto-allows all requests. escalate|filter are RESERVED/not-yet-active (pending nano-workforce#559) — persisted but not enforced, effectively behave like yolo (auto-allow). NANO_AGENTIC_PERMISSION overrides at work time');
  console.log('  --env NAME=VALUE     hire/work: static env var for the harness (repeatable); persisted on hire, work extends/overrides');
  console.log('  --list               hire: list existing agent profiles instead of creating one');
  console.log('  --job-type <token>   work: extra job type to service alongside the rank×capability matrix (repeatable)');
  console.log('  --auto               work: zero-config enrolment — serve ALL deployed agent job types read from the engine (no capability, no app enrol endpoint, no channel). NO capability gate: serves any deployed agent job on the engine.');
  console.log('  --auto-scope <p>     work: with --auto, narrow to agent job types whose bpmn:process id equals or is prefixed by <p> (one app/network); default all');
  console.log('  --recovery-window <ms> work: broker activation-lock window, auto-refreshed while the agent runs; also the node-loss reclaim time (default 300000)');
  console.log('  --idle-timeout <ms>  work: max silence (no agent stdout/stderr) before the harness is killed as wedged and the job reclaimed (default 300000)');
  console.log('  --job-timeout <ms>   work: OPTIONAL absolute hard cap on total harness runtime; killed past this (default 0 = unlimited)');
  console.log('  --lock-grace <ms>    work: DEPRECATED, ignored — the broker lock is now auto-managed via --recovery-window');
  console.log('  --poll-timeout <ms>  work: broker long-poll window per activateJobs request (default 30000; 0 = broker default, negative = immediate)');
  console.log('  --secret-resolver <r> work: secret resolver for task secretRefs (host; default host)');
  console.log('  --reap-age <ms>      work: age before a finished agent container/workspace is reaped (default 3600000)');
  console.log('  --reap-interval <ms> work: how often to sweep finished agent containers/workspaces (default 300000)');
  console.log('  --min-free-mb <n>    work: shed jobs when the engine data root has < this many MB free (default 1024)');
  console.log('  --clone-timeout <ms> work: max time to clone a task repository on the host (default 120000)');
  console.log('  --keep-runs          work: keep per-job workspaces instead of deleting them (debug)');
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
