// Regression suite for the cross-process workspace-reaper data-loss defect
// (issue #205). Before the fix, every worker process shared one flat
// `agent-runs/{run,res}-*` root and its age-gated reaper excluded only ITS OWN
// caller's in-flight dirs, so a sibling process (empty live set) deleted another
// worker's aged-but-active checkout and result channel — losing uncommitted work.
//
// The fix isolates each worker PROCESS INCARNATION under its own
// `agent-runs/worker-<incarnation>/` namespace, confines ordinary cleanup to that
// namespace, and makes cross-process orphan reclamation a separate, proof-gated
// operation (owner provably dead + no surviving harness + exclusive lock + final
// recheck; everything uncertain is retained with a diagnostic).
//
// These tests are deterministic — no wall-clock sleeps, no retries, no timing
// inflation. Liveness/harness/clock are injected. On pre-fix `main` the new
// exports below do not exist, so this file fails to import (red); with the fix it
// passes (green).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  agentRunsRoot,
  reapAgentRunDirs,
  reapOwnedNamespace,
  reclaimOrphanNamespaces,
  allocateWorkerNamespace,
  workerNamespaceDir,
  readOwnerRecord,
  incarnationLiveness,
  newIncarnationId,
  writeJobMarker,
  recordHarnessPid,
  removeJobMarker,
  readJobMarkers,
  namespaceHasLiveHarness,
} from './c8ctl-plugin.js';

// ---- helpers ---------------------------------------------------------------

// A fresh, isolated runs root on disk — never a real state home. Every test gets
// its own so nothing here can ever touch a live worker's data.
function freshRoot() {
  const home = mkdtempSync(join(tmpdir(), 'nano-205-'));
  const root = join(home, 'agent-runs');
  mkdirSync(root, { recursive: true });
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const HOUR = 3_600_000;
function ageDir(p, msAgo) {
  const t = Date.now() / 1000 - msAgo / 1000;
  utimesSync(p, t, t);
}

// Stand up a worker incarnation's namespace with an aged, active checkout + result
// dir inside it (simulating a mid-build worker whose enclosing dirs aged out —
// editing files inside a checkout does not refresh the enclosing dir's mtime).
function seedActiveWorker(root, { pid, pidStart, incarnation = newIncarnationId() }) {
  const { nsDir } = allocateWorkerNamespace({ incarnation, worker: 'copilot', pid, pidStart, root });
  const runDir = mkdtempSync(join(nsDir, 'run-'));
  const resDir = mkdtempSync(join(nsDir, 'res-'));
  writeFileSync(join(resDir, 'result.json'), '{"status":"opened"}');
  // Age the namespace and both child dirs well past the one-hour threshold.
  for (const p of [runDir, resDir, nsDir]) ageDir(p, 2 * HOUR);
  return { nsDir, incarnation, runDir, resDir };
}

// ---- 1. The incident: a sibling worker must not delete an active checkout -----

test('#205 incident: worker B never deletes worker A\'s aged-but-active checkout or result channel', () => {
  const { root, cleanup } = freshRoot();
  try {
    // Worker A: alive, its checkout + result dir aged past the 1h threshold.
    const A = seedActiveWorker(root, { pid: 4242, pidStart: 'lx:1111' });
    // Worker B is a *different* live incarnation sharing the same runs root.
    const bInc = newIncarnationId();
    allocateWorkerNamespace({ incarnation: bInc, worker: 'copilot', pid: process.pid, pidStart: 'lx:2222', root });
    const bNs = workerNamespaceDir(bInc, root);

    // Deterministic liveness: A's pid (4242) is alive with a matching start token.
    const liveness = (owner) => (owner.pid === 4242 ? 'alive' : 'dead');

    // B's ordinary startup + periodic cleanup is OWNER-SCOPED to B's namespace: it
    // must not even traverse A's namespace.
    reapOwnedNamespace(bNs, { maxAgeMs: HOUR, liveRunDirs: new Set() });
    // B's cross-process reclamation sees A's owner is alive ⇒ retains.
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: bInc, liveness });

    assert.equal(existsSync(A.runDir), true, 'A active checkout preserved');
    assert.equal(existsSync(A.resDir), true, 'A result channel preserved');
    assert.equal(existsSync(A.nsDir), true, 'A namespace preserved');
    assert.ok(rc.retained.some((r) => basename(A.nsDir) === r.name && /alive/.test(r.reason)), 'A retained with a diagnostic');
    assert.equal(rc.reclaimed.length, 0);

    // A can still write source + its result afterwards.
    writeFileSync(join(A.runDir, 'src.txt'), 'work');
    writeFileSync(join(A.resDir, 'result.json'), '{"status":"opened","pr":"o/r#1"}');
    assert.equal(readFileSync(join(A.resDir, 'result.json'), 'utf-8').includes('opened'), true);
  } finally { cleanup(); }
});

// ---- 2. Owner-scoped ordinary cleanup --------------------------------------

test('reapOwnedNamespace age-gates and skips in-flight dirs, only within its own namespace', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc = newIncarnationId();
    const { nsDir } = allocateWorkerNamespace({ incarnation: inc, pid: process.pid, root });
    const oldRun = mkdtempSync(join(nsDir, 'run-'));
    const oldRes = mkdtempSync(join(nsDir, 'res-'));
    const freshRun = mkdtempSync(join(nsDir, 'run-'));
    const liveRun = mkdtempSync(join(nsDir, 'run-'));
    ageDir(oldRun, 2 * HOUR); ageDir(oldRes, 2 * HOUR); ageDir(liveRun, 2 * HOUR);

    const reaped = [];
    const r = reapOwnedNamespace(nsDir, { maxAgeMs: HOUR, liveRunDirs: new Set([liveRun]), logger: { info: (m) => reaped.push(m) } });
    assert.equal(r.reaped, 2, 'both aged non-live run/res dirs reaped');
    assert.equal(existsSync(oldRun), false);
    assert.equal(existsSync(oldRes), false);
    assert.equal(existsSync(freshRun), true, 'fresh dir under the age gate kept');
    assert.equal(existsSync(liveRun), true, 'in-flight dir never reaped');
    // owner.json and live/ are never reaped by the owner-scoped sweep.
    assert.equal(existsSync(join(nsDir, 'owner.json')), true);
    assert.equal(existsSync(join(nsDir, 'live')), true);
  } finally { cleanup(); }
});

// ---- 3. Positively dead owner IS reclaimable -------------------------------

test('reclaimOrphanNamespaces reclaims a provably-dead owner with no surviving harness', () => {
  const { root, cleanup } = freshRoot();
  try {
    const dead = seedActiveWorker(root, { pid: 999999, pidStart: 'lx:5' });
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead' });
    assert.equal(existsSync(dead.nsDir), false, 'abandoned namespace reclaimed');
    assert.equal(rc.reclaimed.length, 1);
    assert.equal(rc.reclaimed[0].name, basename(dead.nsDir));
  } finally { cleanup(); }
});

// ---- 4. A live orphaned harness blocks reclamation -------------------------

test('reclaimOrphanNamespaces retains a dead-owner namespace whose spawned harness may still be alive', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc = newIncarnationId();
    const { nsDir } = allocateWorkerNamespace({ incarnation: inc, pid: 31337, pidStart: 'lx:9', root });
    writeJobMarker(nsDir, { jobKey: 'job-1', workerPid: 31337, incarnation: inc });
    recordHarnessPid(nsDir, 'job-1', 55555); // an orphaned harness pid
    ageDir(nsDir, 2 * HOUR);

    const rc = reclaimOrphanNamespaces({
      root,
      selfIncarnation: newIncarnationId(),
      liveness: () => 'dead',
      harnessAlive: (pid) => pid === 55555, // the harness is still running
    });
    assert.equal(existsSync(nsDir), true, 'namespace with a live orphaned harness is retained');
    assert.ok(rc.retained.some((r) => /harness/.test(r.reason)));
  } finally { cleanup(); }
});

// ---- 5. PID reuse safety ---------------------------------------------------

test('incarnationLiveness is PID-reuse-safe: live pid + mismatched start token ⇒ dead', () => {
  const owner = { pid: 4242, pidStart: 'lx:1111' };
  assert.equal(incarnationLiveness(owner, { isAlive: () => true, startToken: () => 'lx:1111' }), 'alive');
  assert.equal(incarnationLiveness(owner, { isAlive: () => true, startToken: () => 'lx:9999' }), 'dead', 'reused pid ⇒ old incarnation dead');
  assert.equal(incarnationLiveness(owner, { isAlive: () => false }), 'dead');
  // Conservative unknowns never become "dead".
  assert.equal(incarnationLiveness({ pid: 4242, pidStart: null }, { isAlive: () => true }), 'unknown', 'no recorded token ⇒ cannot disprove reuse');
  assert.equal(incarnationLiveness({ pid: 4242, pidStart: 'lx:1' }, { isAlive: () => true, startToken: () => null }), 'unknown', 'cannot re-fingerprint ⇒ conservative');
  assert.equal(incarnationLiveness({}, {}), 'unknown', 'no pid ⇒ unknown');
});

test('reclaimOrphanNamespaces reclaims after a PID reuse (owner pid alive but a different process)', () => {
  const { root, cleanup } = freshRoot();
  try {
    const reused = seedActiveWorker(root, { pid: 4242, pidStart: 'lx:OLD' });
    // The real incarnationLiveness runs; the pid is "alive" but its start token
    // no longer matches ⇒ the recorded incarnation is dead ⇒ reclaimable.
    const rc = reclaimOrphanNamespaces({
      root,
      selfIncarnation: newIncarnationId(),
      liveness: (owner) => incarnationLiveness(owner, { isAlive: () => true, startToken: () => 'lx:NEW' }),
    });
    assert.equal(existsSync(reused.nsDir), false);
    assert.equal(rc.reclaimed.length, 1);
  } finally { cleanup(); }
});

// ---- 6. Missing / malformed ownership metadata is NOT garbage ---------------

test('reclaimOrphanNamespaces retains namespaces with missing or malformed owner records', () => {
  const { root, cleanup } = freshRoot();
  try {
    // A worker-* dir with NO owner record (mid-allocation, or an incomplete write).
    const noOwner = join(root, 'worker-incomplete');
    mkdirSync(noOwner, { recursive: true });
    ageDir(noOwner, 2 * HOUR);
    // A worker-* dir with a corrupt owner record.
    const badOwner = join(root, 'worker-corrupt');
    mkdirSync(badOwner, { recursive: true });
    writeFileSync(join(badOwner, 'owner.json'), '{ not json');
    ageDir(badOwner, 2 * HOUR);

    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead' });
    assert.equal(existsSync(noOwner), true, 'incompletely-registered namespace retained');
    assert.equal(existsSync(badOwner), true, 'malformed owner record retained');
    assert.equal(rc.reclaimed.length, 0);
    assert.ok(rc.retained.some((r) => /owner record/.test(r.reason)));
  } finally { cleanup(); }
});

// ---- 7. Registration race: a job started but its harness pid not yet recorded --

test('reclaimOrphanNamespaces retains a dead owner mid registration race (job marker, no harness pid yet)', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc = newIncarnationId();
    const { nsDir } = allocateWorkerNamespace({ incarnation: inc, pid: 707, pidStart: 'lx:7', root });
    writeJobMarker(nsDir, { jobKey: 'racing', workerPid: 707, incarnation: inc }); // harnessPids: []
    ageDir(nsDir, 2 * HOUR);
    assert.equal(namespaceHasLiveHarness(nsDir, { isAlive: () => false }), true, 'empty harnessPids ⇒ possibly-live (conservative)');
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead', harnessAlive: () => false });
    assert.equal(existsSync(nsDir), true);
    assert.ok(rc.retained.some((r) => /harness/.test(r.reason)));
  } finally { cleanup(); }
});

// ---- 8. Competing reapers serialize on an exclusive lock --------------------

test('reclaimOrphanNamespaces yields when another reclaimer already holds the lock', () => {
  const { root, cleanup } = freshRoot();
  try {
    const dead = seedActiveWorker(root, { pid: 888, pidStart: 'lx:8' });
    // A competing reclaimer holds the lock.
    mkdirSync(join(dead.nsDir, '.reclaiming'));
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead' });
    assert.equal(existsSync(dead.nsDir), true, 'a locked namespace is left to the lock holder');
    assert.ok(rc.retained.some((r) => /lock/.test(r.reason)));
  } finally { cleanup(); }
});

// ---- 9. Symlinks are never followed; containment holds ----------------------

test('reclaimOrphanNamespaces never follows a symlinked namespace out of the runs root', () => {
  const { root, home, cleanup } = freshRoot();
  try {
    const outside = join(home, 'precious');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'do not delete');
    const link = join(root, 'worker-evil');
    symlinkSync(outside, link);
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead' });
    assert.equal(existsSync(outside), true, 'symlink target outside the root is untouched');
    assert.equal(existsSync(join(outside, 'keep.txt')), true);
    assert.ok(rc.retained.some((r) => r.name === 'worker-evil'));
  } finally { cleanup(); }
});

// ---- 10. Min reclaim age gate ----------------------------------------------

test('reclaimOrphanNamespaces retains a namespace younger than the min reclaim age', () => {
  const { root, cleanup } = freshRoot();
  try {
    const young = seedActiveWorker(root, { pid: 111, pidStart: 'lx:1' });
    ageDir(young.nsDir, 5 * 60_000); // 5 minutes old
    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), minAgeMs: HOUR, liveness: () => 'dead' });
    assert.equal(existsSync(young.nsDir), true);
    assert.ok(rc.retained.some((r) => /younger than min/.test(r.reason)));
  } finally { cleanup(); }
});

// ---- 11. Mixed-version rollout safety --------------------------------------

test('mixed version: the legacy flat reaper never descends into a new worker-* namespace', () => {
  // The legacy reaper reads the real state home, so isolate it via C8CTL_NANO_HOME.
  const { home, cleanup } = freshRoot();
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  try {
    const root = agentRunsRoot();
    // A NEW worker's namespace with an aged active checkout inside it.
    const inc = newIncarnationId();
    const { nsDir } = allocateWorkerNamespace({ incarnation: inc, pid: process.pid, root });
    const active = mkdtempSync(join(nsDir, 'run-'));
    ageDir(active, 2 * HOUR); ageDir(nsDir, 2 * HOUR);
    // A genuine legacy flat run-* at the root (an old worker's leftover).
    const flat = join(root, 'run-legacy');
    mkdirSync(flat, { recursive: true });
    ageDir(flat, 2 * HOUR);

    // The OLD flat sweep (as an old worker still running pre-fix code would run it).
    const r = reapAgentRunDirs({ maxAgeMs: HOUR });
    assert.equal(existsSync(flat), false, 'legacy flat run-* is reaped by the flat sweep');
    assert.equal(existsSync(nsDir), true, 'the flat sweep never enters a worker-* namespace');
    assert.equal(existsSync(active), true, 'the new worker\'s active checkout is invisible to the old reaper');
    assert.equal(r.reaped, 1);
  } finally {
    if (prev === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev;
    cleanup();
  }
});

test('mixed version: the new reclaimer never erases unowned legacy flat run-*/res-* dirs', () => {
  const { root, cleanup } = freshRoot();
  try {
    const flatRun = join(root, 'run-legacy');
    const flatRes = join(root, 'res-legacy');
    for (const d of [flatRun, flatRes]) { mkdirSync(d, { recursive: true }); ageDir(d, 2 * HOUR); }
    const dead = seedActiveWorker(root, { pid: 222, pidStart: 'lx:2' });

    const rc = reclaimOrphanNamespaces({ root, selfIncarnation: newIncarnationId(), liveness: () => 'dead' });
    assert.equal(existsSync(flatRun), true, 'legacy flat run-* is not the new reaper\'s concern');
    assert.equal(existsSync(flatRes), true, 'legacy flat res-* is not the new reaper\'s concern');
    assert.equal(existsSync(dead.nsDir), false, 'only the proven-dead worker-* namespace was reclaimed');
    assert.equal(rc.reclaimed.length, 1);
  } finally { cleanup(); }
});

// ---- 12. Atomic ownership publication --------------------------------------

test('allocateWorkerNamespace publishes an immutable owner record atomically and is idempotent', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc = newIncarnationId();
    const a = allocateWorkerNamespace({ incarnation: inc, worker: 'copilot', pid: 4242, pidStart: 'lx:1', version: '9.9.9', root });
    const rec = readOwnerRecord(a.nsDir);
    assert.equal(rec.schema, 1);
    assert.equal(rec.incarnation, inc);
    assert.equal(rec.pid, 4242);
    assert.equal(rec.pidStart, 'lx:1');
    assert.equal(rec.version, '9.9.9');
    assert.equal(existsSync(join(a.nsDir, 'live')), true, 'live marker dir created');
    // Idempotent: a second allocate does not overwrite the record.
    writeFileSync(join(a.nsDir, 'live', 'x.json'), '{}');
    const b = allocateWorkerNamespace({ incarnation: inc, worker: 'other', pid: 5, pidStart: 'lx:2', root });
    assert.equal(b.nsDir, a.nsDir);
    assert.deepEqual(readOwnerRecord(b.nsDir), rec, 'owner record is immutable across re-allocation');
  } finally { cleanup(); }
});

// ---- 13. Two workers with the SAME configured profile land in DISTINCT namespaces --

test('two processes sharing the same configured worker name get distinct incarnations/namespaces', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc1 = newIncarnationId();
    const inc2 = newIncarnationId();
    assert.notEqual(inc1, inc2, 'incarnation ids are unique per process start');
    const a = allocateWorkerNamespace({ incarnation: inc1, worker: 'copilot', pid: 1, root });
    const b = allocateWorkerNamespace({ incarnation: inc2, worker: 'copilot', pid: 2, root });
    assert.notEqual(a.nsDir, b.nsDir, 'same profile name ⇒ still separate namespaces');
    const dirs = readdirSync(root).filter((n) => n.startsWith('worker-'));
    assert.equal(dirs.length, 2);
  } finally { cleanup(); }
});

// ---- 14. Job-marker lifecycle ----------------------------------------------

test('job marker lifecycle: write → record harness pid → remove clears the surviving-harness signal', () => {
  const { root, cleanup } = freshRoot();
  try {
    const inc = newIncarnationId();
    const { nsDir } = allocateWorkerNamespace({ incarnation: inc, pid: process.pid, root });
    writeJobMarker(nsDir, { jobKey: 'j1', workerPid: process.pid, incarnation: inc });
    recordHarnessPid(nsDir, 'j1', 12345);
    assert.equal(readJobMarkers(nsDir).length, 1);
    assert.equal(namespaceHasLiveHarness(nsDir, { isAlive: (pid) => pid === 12345 }), true);
    assert.equal(namespaceHasLiveHarness(nsDir, { isAlive: () => false }), false, 'a dead recorded harness ⇒ no live harness');
    removeJobMarker(nsDir, 'j1');
    assert.equal(readJobMarkers(nsDir).length, 0);
    assert.equal(namespaceHasLiveHarness(nsDir, { isAlive: () => true }), false, 'no markers ⇒ no surviving harness');
  } finally { cleanup(); }
});
