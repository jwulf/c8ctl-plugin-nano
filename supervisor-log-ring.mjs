// Bounded per-worker log writer for the supervisor daemon (jwulf/c8ctl-plugin-nano#183).
//
// A supervised `nano work` child is long-lived and chatty: it streams
// stdout/stderr for the entire life of the fleet. The daemon used to hand the
// child a *raw append fd* as its stdio, so the OS wrote straight to
// `logs/supervisor/worker-<id>.log` and the file only ever grew — multi-GB logs
// could fill the disk with no cap and no rotation.
//
// This module lets the daemon OWN the bytes instead. The child is spawned with
// piped stdout/stderr and every chunk is fed through {@link createLogRing},
// which appends to the primary log file and, when it reaches the cap, ROTATES:
// the primary is renamed to `<log>.1` (replacing any previous `.1`) and a fresh
// primary is started. That keeps the newest output always retained (a ring/tail,
// not a hard stop) while bounding on-disk usage to ~2x the cap (the live primary
// plus one rotated file). `nano supervisor logs` tails the primary, so it keeps
// showing the most recent output across a rotation.
//
// The cap is operator-configurable via `NANO_SUPERVISOR_LOG_MAX_BYTES`
// (see {@link resolveLogMaxBytes}); `0`/negative opts out (unbounded), matching
// the existing `NANO_SUPERVISOR_*` env conventions.

import {
  openSync as fsOpenSync,
  writeSync as fsWriteSync,
  closeSync as fsCloseSync,
  fstatSync as fsFstatSync,
  renameSync as fsRenameSync,
} from 'node:fs';

/** Default per-worker log cap: 10 MB. */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Suffix of the single rotated-out file kept alongside the primary log. */
export const ROTATED_SUFFIX = '.1';

/**
 * Resolve the per-worker log byte cap from an operator-supplied value with a
 * sane fallback. Accepts a number or a numeric string (env vars arrive as
 * strings). An unset/blank/non-numeric value falls back to `fallback`
 * (default 10 MB). A value `<= 0` means "unbounded / off" and is returned as `0`
 * so callers can opt out of the ring entirely and keep the legacy direct-fd
 * write.
 *
 * @param {unknown} raw the operator value (e.g. `process.env.NANO_SUPERVISOR_LOG_MAX_BYTES`)
 * @param {number} [fallback] the default when `raw` is absent/invalid
 * @returns {number} a non-negative integer byte cap (`0` == unbounded/off)
 */
export function resolveLogMaxBytes(raw, fallback = DEFAULT_LOG_MAX_BYTES) {
  const base = Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : DEFAULT_LOG_MAX_BYTES;
  if (raw === undefined || raw === null || raw === '') return base;
  const s = typeof raw === 'number' ? raw : String(raw).trim();
  if (s === '') return base; // whitespace-only == unset
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return base;
  if (n <= 0) return 0; // explicit opt-out: unbounded
  return Math.floor(n);
}

/**
 * @typedef {object} LogRing
 * @property {(chunk: Buffer|string) => void} write append a chunk, rotating at the cap
 * @property {() => void} close close the underlying fd (idempotent)
 * @property {() => number} size current byte size of the live primary file
 * @property {() => number} rotations how many times the log has rotated
 */

/**
 * Create a bounded, rotating writer for one worker's log file.
 *
 * Semantics:
 *  - Opens `logFile` in append mode (preserving any existing content — its bytes
 *    count toward the cap, so a reopen of a nearly-full file rotates promptly).
 *  - On each {@link LogRing.write}, if writing the chunk would push the primary
 *    file over `maxBytes` (and the file is non-empty), it ROTATES first: close
 *    the primary, rename it to `<logFile><ROTATED_SUFFIX>` (atomically replacing
 *    any prior rotated file), then open a fresh empty primary. The chunk is then
 *    written to the fresh primary. A single chunk larger than the cap is still
 *    written whole (never split mid-line); it just triggers a rotation on the
 *    following write.
 *  - `maxBytes <= 0` disables rotation entirely (unbounded append). Callers
 *    normally take the legacy direct-fd path instead of constructing a ring in
 *    that case; this is a defensive no-op for symmetry.
 *
 * All IO is synchronous so that, by the time a `write` returns, the bytes are on
 * disk — that is what makes the rotation boundary deterministically testable
 * without wall-clock flushing, and it means the daemon never loses already
 * received bytes if the worker dies.
 *
 * @param {string} logFile absolute path to the primary log file
 * @param {number} maxBytes byte cap (`<= 0` == unbounded); see {@link resolveLogMaxBytes}
 * @param {object} [io] injectable fs surface for deterministic tests
 * @param {typeof fsOpenSync} [io.openSync]
 * @param {typeof fsWriteSync} [io.writeSync]
 * @param {typeof fsCloseSync} [io.closeSync]
 * @param {typeof fsFstatSync} [io.fstatSync]
 * @param {typeof fsRenameSync} [io.renameSync]
 * @returns {LogRing}
 */
export function createLogRing(logFile, maxBytes, io = {}) {
  const openSync = io.openSync || fsOpenSync;
  const writeSync = io.writeSync || fsWriteSync;
  const closeSync = io.closeSync || fsCloseSync;
  const fstatSync = io.fstatSync || fsFstatSync;
  const renameSync = io.renameSync || fsRenameSync;

  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const rotatedFile = `${logFile}${ROTATED_SUFFIX}`;

  let fd = openSync(logFile, 'a');
  // Seed `size` from the existing file so appending to a nearly-full log rotates
  // at the right point rather than starting the count from zero.
  let size = 0;
  try { size = fstatSync(fd).size; } catch { size = 0; }
  let rotations = 0;
  let closed = false;

  const rotate = () => {
    try { closeSync(fd); } catch { /* fd may already be gone */ }
    // Replace any previous rotated file with the just-filled primary. `rename`
    // is atomic, so a concurrent tail reopening the primary never sees a gap.
    renameSync(logFile, rotatedFile);
    fd = openSync(logFile, 'a');
    size = 0;
    rotations += 1;
  };

  return {
    write(chunk) {
      if (closed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buf.length === 0) return;
      // Rotate BEFORE writing when the primary already holds bytes and this
      // chunk would tip it over the cap — this bounds each file at <= cap + the
      // final chunk (pipe chunks are small), and never splits a chunk mid-line.
      if (cap > 0 && size > 0 && size + buf.length > cap) rotate();
      try {
        writeSync(fd, buf);
        size += buf.length;
      } catch { /* a transient write failure must not crash the daemon */ }
    },
    close() {
      if (closed) return;
      closed = true;
      try { closeSync(fd); } catch { /* best effort */ }
    },
    size() { return size; },
    rotations() { return rotations; },
  };
}
