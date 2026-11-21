// Issue #320: a lease fence the agent can always read, with no app URL and no
// credentials.
//
//   * NANO_FENCE        — a per-job file path. The worker creates it (one-line
//                         reason: `lease-lost: <status>`, `job-gone`, …) the moment
//                         it learns the lease is definitively lost, BEFORE it
//                         interrupts the run. Absent file == lease not known lost.
//   * NANO_FENCE_CHECK  — a script (`node "$NANO_FENCE_CHECK"`, or `c8 nano
//                         fence-check`) the agent runs right before an
//                         irreversible step. It asks the worker (over a local
//                         socket, NANO_FENCE_SOCKET + NANO_FENCE_TOKEN) to do a
//                         FRESH, lease-fenced engine check through the worker's own
//                         authenticated connection.
//
// Exit codes of fence-check: 0 = held; 1 = lost (fence file written);
// 75 (EX_TEMPFAIL) = unknown — transient engine/network error or the worker is
// unreachable; retry briefly, then decide.
import { createServer, connect } from 'node:net';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FENCE_EXIT_HELD = 0;
export const FENCE_EXIT_LOST = 1;
export const FENCE_EXIT_UNKNOWN = 75;

export const FENCE_ENV = 'NANO_FENCE';
export const FENCE_CHECK_ENV = 'NANO_FENCE_CHECK';
export const FENCE_SOCKET_ENV = 'NANO_FENCE_SOCKET';
export const FENCE_TOKEN_ENV = 'NANO_FENCE_TOKEN';

/** Absolute path of the standalone fence-check script shipped with the plugin. */
export const FENCE_CHECK_SCRIPT = fileURLToPath(new URL('./fence-check.mjs', import.meta.url));

/** Write the fence file (best effort, never throws). First reason wins. */
export function writeFence(path, reason) {
  if (!path) return false;
  try {
    // Exclusive create ('wx' = O_CREAT|O_EXCL): never follows a (dangling)
    // symlink an agent planted in a shared mount, and is race-free vs a
    // check-then-write. An existing entry means a fence is already present.
    writeFileSync(path, `${String(reason || 'lease-lost').split('\n')[0]}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return true;
    return false;
  }
}

export function readFence(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8').trim() || 'lease-lost';
  } catch {
    return null;
  }
}

function defaultSocketPath() {
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\nano-fence-${id}` : join(tmpdir(), `nano-fence-${id}.sock`);
}

/**
 * Per-worker fence registry + local check server. `check(job)` must resolve to
 * `{ state: 'held'|'lost'|'unknown', reason?, error? }` using the worker's own
 * authenticated, lease-fenced engine connection.
 */
export function createFenceRegistry({ check, socketPath = defaultSocketPath(), logger = null, idleSocketMs } = {}) {
  const byToken = new Map(); // token -> { job, fencePath }
  let server = null;
  let listening = null;

  const handle = async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return { state: 'unknown', error: 'bad request' }; }
    const entry = req && typeof req.token === 'string' ? byToken.get(req.token) : undefined;
    // An unknown token means this job is no longer running on this worker: its
    // run finished or was interrupted. Not definitive about the engine, so unknown.
    if (!entry) return { state: 'unknown', error: 'no active job for this fence token' };
    const already = readFence(entry.fencePath);
    if (already) return { state: 'lost', reason: already };
    let res;
    try {
      res = await check(entry.job);
    } catch (err) {
      res = { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
    if (res && res.state === 'lost') {
      const reason = res.reason || 'lease-lost';
      writeFence(entry.fencePath, reason);
      return { state: 'lost', reason: readFence(entry.fencePath) || reason };
    }
    if (res && res.state === 'held') {
      // The heartbeat (or a concurrent check) may have written the fence while the
      // engine call was pending — known loss beats a stale success.
      const after = readFence(entry.fencePath);
      if (after) return { state: 'lost', reason: after };
      return { state: 'held' };
    }
    return { state: 'unknown', error: (res && res.error) || 'unknown' };
  };

  const IDLE_SOCKET_MS = Number(idleSocketMs) > 0 ? Number(idleSocketMs) : 60_000;
  const ensureServer = () => {
    if (listening) return listening;
    listening = new Promise((resolve) => {
      if (process.platform !== 'win32') { try { rmSync(socketPath, { force: true }); } catch { /* ignore */ } }
      server = createServer((sock) => {
        let buf = '';
        // An accepted connection must never hold the worker alive past drain:
        // unref it and drop clients that go idle without sending a request.
        try { sock.unref(); } catch { /* ignore */ }
        sock.setTimeout(IDLE_SOCKET_MS, () => sock.destroy());
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        sock.on('data', (chunk) => {
          buf += chunk;
          if (buf.length > 64 * 1024) { sock.destroy(); return; }
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = '';
          sock.setTimeout(0); // request received; the check itself is engine-bounded
          handle(line).then((res) => { try { sock.end(`${JSON.stringify(res)}\n`); } catch { /* ignore */ } });
        });
      });
      server.on('error', (err) => {
        logger?.warn?.(`fence-check socket unavailable (${err.message}) — agents can still read $NANO_FENCE`);
        resolve(false);
      });
      server.listen(socketPath, () => { server.unref(); resolve(true); });
    });
    return listening;
  };

  return {
    socketPath,
    /** Register a running job; returns the env the agent should receive. */
    async register(job, fencePath) {
      const token = randomBytes(16).toString('hex');
      byToken.set(token, { job, fencePath });
      const ok = await ensureServer();
      const env = { [FENCE_ENV]: fencePath, [FENCE_CHECK_ENV]: FENCE_CHECK_SCRIPT };
      if (ok) { env[FENCE_SOCKET_ENV] = socketPath; env[FENCE_TOKEN_ENV] = token; }
      return { token, env };
    },
    unregister(token) { byToken.delete(token); },
    /** Heartbeat lease loss: write the fence of every registration for this activation. */
    leaseLost(job, reason) {
      for (const e of byToken.values()) {
        if (String(e.job.jobKey) === String(job.jobKey) && (e.job.leaseToken ?? null) === (job.leaseToken ?? null)) {
          writeFence(e.fencePath, reason);
        }
      }
    },
    close() {
      byToken.clear();
      try { server?.close(); } catch { /* ignore */ }
      if (process.platform !== 'win32') { try { rmSync(socketPath, { force: true }); } catch { /* ignore */ } }
    },
  };
}

/** Client side: run the check. Resolves `{ code, message }`; never throws. */
export function runFenceCheck({ env = process.env, timeoutMs = 30_000 } = {}) {
  const fencePath = env[FENCE_ENV];
  const pre = readFence(fencePath);
  if (pre) return Promise.resolve({ code: FENCE_EXIT_LOST, message: pre });
  const socketPath = env[FENCE_SOCKET_ENV];
  const token = env[FENCE_TOKEN_ENV];
  if (!socketPath || !token) {
    return Promise.resolve({ code: FENCE_EXIT_UNKNOWN, message: 'no fence-check socket (NANO_FENCE_SOCKET/NANO_FENCE_TOKEN unset) — only $NANO_FENCE is available' });
  }
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } resolve(r); };
    const sock = connect(socketPath);
    const timer = setTimeout(() => finish({ code: FENCE_EXIT_UNKNOWN, message: 'fence-check timed out' }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ op: 'fence-check', token })}\n`));
    sock.on('data', (c) => { buf += c; });
    sock.on('error', (err) => finish({ code: FENCE_EXIT_UNKNOWN, message: `worker unreachable: ${err.message}` }));
    sock.on('close', () => {
      let res = null;
      try { res = JSON.parse(buf.trim()); } catch { /* fallthrough */ }
      if (res?.state === 'held') {
        // Re-read immediately before accepting: a fence written after the worker
        // queued its reply must win over the stale `held`.
        const post = readFence(fencePath);
        if (post) return finish({ code: FENCE_EXIT_LOST, message: post });
        return finish({ code: FENCE_EXIT_HELD, message: 'held' });
      }
      if (res?.state === 'lost') {
        // The worker wrote the fence; make sure it exists from our side too.
        writeFence(fencePath, res.reason || 'lease-lost');
        return finish({ code: FENCE_EXIT_LOST, message: res.reason || 'lease-lost' });
      }
      return finish({ code: FENCE_EXIT_UNKNOWN, message: res?.error || 'no answer from worker' });
    });
  });
}
