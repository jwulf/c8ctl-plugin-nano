// Deterministic coverage for the bounded per-worker log ring (#183): the byte
// cap resolver and the rotate-at-cap boundary. Uses a real temp dir so the
// rotation (rename + reopen) is exercised end-to-end against the filesystem,
// mirroring the repo's other byte-cap tests. No wall-clock timing is involved —
// the ring's IO is synchronous, so every assertion is on committed bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_MAX_BYTES,
  ROTATED_SUFFIX,
  resolveLogMaxBytes,
  createLogRing,
} from './supervisor-log-ring.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'nano-logring-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveLogMaxBytes: default when unset/blank/invalid', () => {
  assert.equal(resolveLogMaxBytes(undefined), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes(null), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes(''), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes('not-a-number'), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes('   '), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes(NaN), DEFAULT_LOG_MAX_BYTES);
  assert.equal(DEFAULT_LOG_MAX_BYTES, 10 * 1024 * 1024);
});

test('resolveLogMaxBytes: parses numbers and numeric strings; 0/negative == unbounded (0)', () => {
  assert.equal(resolveLogMaxBytes(1024), 1024);
  assert.equal(resolveLogMaxBytes('2048'), 2048);
  assert.equal(resolveLogMaxBytes(' 4096 '), 4096);
  assert.equal(resolveLogMaxBytes(1024.9), 1024); // floored
  assert.equal(resolveLogMaxBytes(0), 0); // explicit opt-out
  assert.equal(resolveLogMaxBytes('0'), 0);
  assert.equal(resolveLogMaxBytes(-5), 0);
  assert.equal(resolveLogMaxBytes('-100'), 0);
});

test('resolveLogMaxBytes: honours a caller fallback, but a bad fallback reverts to the default', () => {
  assert.equal(resolveLogMaxBytes(undefined, 500), 500);
  assert.equal(resolveLogMaxBytes(undefined, 0), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes(undefined, -1), DEFAULT_LOG_MAX_BYTES);
});

test('createLogRing: writes under the cap stay in one file, no rotation', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-a.log');
    const ring = createLogRing(file, 100);
    ring.write('hello ');
    ring.write('world');
    ring.close();
    assert.equal(readFileSync(file, 'utf8'), 'hello world');
    assert.equal(existsSync(`${file}${ROTATED_SUFFIX}`), false, 'no rotated file below the cap');
    assert.equal(ring.rotations(), 0);
  } finally { cleanup(); }
});

test('createLogRing: rotates at the cap, retaining the newest output and bounding on-disk to ~2x', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-b.log');
    const cap = 10; // tiny cap so the boundary is exact and obvious
    const ring = createLogRing(file, cap);
    // Each chunk is 4 bytes. After "aaaa"+"bbbb" (8 bytes) the file is under cap;
    // "cccc" would tip it to 12 > 10, so the ring rotates first: primary → .1,
    // fresh primary gets "cccc". Then "dddd" tips 4+4=8 under cap → same file.
    ring.write('aaaa');
    ring.write('bbbb');
    ring.write('cccc'); // triggers rotation
    ring.write('dddd');
    ring.close();

    const primary = readFileSync(file, 'utf8');
    const rotated = readFileSync(`${file}${ROTATED_SUFFIX}`, 'utf8');
    // Newest output is retained (in the live primary), oldest rolled to .1.
    assert.equal(rotated, 'aaaabbbb', 'oldest bytes rolled to the .1 file');
    assert.equal(primary, 'ccccdddd', 'newest bytes kept in the live primary');
    assert.equal(ring.rotations(), 1);
    // Neither file exceeds the cap by more than a trailing chunk; total is
    // bounded at ~2x the cap.
    assert.ok(statSync(file).size <= cap + 4);
    assert.ok(statSync(`${file}${ROTATED_SUFFIX}`).size <= cap + 4);
  } finally { cleanup(); }
});

test('createLogRing: sustained >> cap output leaves the log bounded at ~2x the cap, retaining the tail', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-c.log');
    const cap = 1024; // 1 KB cap
    const ring = createLogRing(file, cap);
    // Emit ~100 KB in 256-byte chunks (>> cap) and tag each chunk with an index
    // so we can prove the tail (newest chunks) survives.
    const total = 400;
    for (let i = 0; i < total; i++) ring.write(String(i).padStart(6, '0') + 'x'.repeat(250));
    ring.close();

    const onDisk = statSync(file).size
      + (existsSync(`${file}${ROTATED_SUFFIX}`) ? statSync(`${file}${ROTATED_SUFFIX}`).size : 0);
    assert.ok(onDisk <= 2 * cap + 256, `on-disk ${onDisk} should be bounded at ~2x cap`);
    assert.ok(ring.rotations() >= 1, 'must have rotated at least once under sustained load');

    // The very last chunk's tag must be present across the two live files.
    const combined = readFileSync(`${file}${ROTATED_SUFFIX}`, 'utf8') + readFileSync(file, 'utf8');
    assert.ok(combined.includes(String(total - 1).padStart(6, '0')), 'newest chunk retained');
    // The oldest chunk must have aged out.
    assert.ok(!combined.includes('000000x'), 'oldest chunk discarded');
  } finally { cleanup(); }
});

test('createLogRing: a single chunk larger than the cap is written whole (never split), rotating next', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-d.log');
    const cap = 8;
    const ring = createLogRing(file, cap);
    const big = 'X'.repeat(50); // one chunk >> cap
    ring.write(big);
    // Written whole to the (empty) primary — no mid-chunk split.
    assert.equal(readFileSync(file, 'utf8'), big);
    assert.equal(ring.rotations(), 0);
    // The next write sees the over-cap primary and rotates first.
    ring.write('tail');
    ring.close();
    assert.equal(readFileSync(`${file}${ROTATED_SUFFIX}`, 'utf8'), big);
    assert.equal(readFileSync(file, 'utf8'), 'tail');
    assert.equal(ring.rotations(), 1);
  } finally { cleanup(); }
});

test('createLogRing: reopening a nearly-full log counts existing bytes toward the cap', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-e.log');
    const cap = 10;
    const first = createLogRing(file, cap);
    first.write('12345678'); // 8 bytes, under cap
    first.close();
    // Reopen: existing 8 bytes are seeded, so a 4-byte chunk tips over → rotate.
    const second = createLogRing(file, cap);
    assert.equal(second.size(), 8, 'seeds size from the existing file');
    second.write('9999');
    second.close();
    assert.equal(readFileSync(`${file}${ROTATED_SUFFIX}`, 'utf8'), '12345678');
    assert.equal(readFileSync(file, 'utf8'), '9999');
    assert.equal(second.rotations(), 1);
  } finally { cleanup(); }
});

test('createLogRing: maxBytes<=0 disables rotation (unbounded append)', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-f.log');
    const ring = createLogRing(file, 0);
    for (let i = 0; i < 50; i++) ring.write('X'.repeat(100));
    ring.close();
    assert.equal(statSync(file).size, 5000, 'no cap → grows unbounded');
    assert.equal(existsSync(`${file}${ROTATED_SUFFIX}`), false);
    assert.equal(ring.rotations(), 0);
  } finally { cleanup(); }
});

test('createLogRing: close is idempotent and post-close writes are no-ops', () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, 'worker-g.log');
    const ring = createLogRing(file, 100);
    ring.write('data');
    ring.close();
    ring.close(); // must not throw
    ring.write('ignored'); // dropped
    assert.equal(readFileSync(file, 'utf8'), 'data');
  } finally { cleanup(); }
});

test('createLogRing: a failing rotate is best-effort — reopens and keeps draining', () => {
  // Inject an fs surface (no real filesystem) where renameSync always throws, so
  // a rotation at the cap fails after the primary fd was already closed. The ring
  // must reopen the primary and keep writing rather than strand itself on a dead
  // fd and silently stop draining (the concern raised in review #185).
  let drained = '';
  let fdSeq = 10;
  let renameAttempts = 0;
  const io = {
    openSync: () => ++fdSeq, // hand out a fresh fd on every (re)open
    writeSync: (_fd, buf) => { drained += buf.toString(); return buf.length; },
    closeSync: () => {},
    fstatSync: () => ({ size: 0 }),
    renameSync: () => { renameAttempts += 1; throw new Error('EACCES: rename not permitted'); },
  };
  const ring = createLogRing('/virtual/worker-h.log', 10, io);
  ring.write('AAAAAAAA'); // 8 bytes, empty primary → no rotation
  ring.write('BBBBBBBB'); // would exceed cap → rotate() attempted, rename throws
  ring.close();
  assert.ok(renameAttempts >= 1, 'a rotation was attempted at the cap');
  assert.equal(drained, 'AAAAAAAABBBBBBBB', 'both chunks were drained despite the failed rotation');
});
