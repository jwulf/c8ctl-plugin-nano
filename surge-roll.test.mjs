// Issue #340: zero-capacity-loss rolling reload — surge-then-drain orchestration
// (`runSurgeRoll`), readiness that requires ≥1 polled job type, surge parsing,
// and the status drain/version visibility lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('./c8ctl-plugin.js');
const { runSurgeRoll, parseReloadSurge, formatSupervisorDrainLines, activityMarkerReadyFor } = mod;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A simulated fleet: each worker has an old child (busy for `jobMs`, or idle)
// and the roll surges a replacement that becomes ready after `bootMs`.
// "Serving capacity" = processes that are leasing new jobs: an old child until
// it is told to drain, plus each replacement once it is ready.
function fleet(spec, { bootMs = 5, neverReady = new Set() } = {}) {
  const st = new Map(Object.entries(spec).map(([id, s]) => [id, { ...s, oldLeasing: true, newReady: false, oldExited: false, drainAt: null, adoptedAt: null }]));
  let minCapacity = Infinity;
  const target = st.size;
  const sample = () => {
    let cap = 0;
    for (const s of st.values()) { if (s.oldLeasing) cap++; if (s.newReady) cap++; }
    minCapacity = Math.min(minCapacity, cap);
  };
  const log = [];
  const t0 = Date.now();
  const ops = {
    isIdle: (id) => st.get(id).jobMs === 0,
    surge: async (id) => { log.push(['surge', id, Date.now() - t0]); sample(); return { id }; },
    waitReady: async (id) => {
      await tick(bootMs);
      if (neverReady.has(id)) { sample(); return false; }
      st.get(id).newReady = true; sample();
      return true;
    },
    abandon: async (id) => { log.push(['abandon', id]); sample(); },
    drainOld: async (id) => {
      const s = st.get(id);
      s.oldLeasing = false; s.drainAt = Date.now() - t0; sample();
      log.push(['drain', id, s.drainAt]);
      await tick(s.jobMs);
      s.oldExited = true; sample();
      log.push(['exited', id, Date.now() - t0]);
    },
    shouldAbort: () => false,
    onAdopted: (id) => { st.get(id).adoptedAt = Date.now() - t0; },
  };
  return { ops, st, log, target, minCapacity: () => minCapacity, t0 };
}

test('#340: 4 workers (2 idle, 2 busy) — idle swap at once, busy drain in parallel, capacity never below 4', async () => {
  const f = fleet({ i1: { jobMs: 0 }, b1: { jobMs: 200 }, i2: { jobMs: 0 }, b2: { jobMs: 200 } });
  const started = Date.now();
  const res = await runSurgeRoll(['b1', 'i1', 'b2', 'i2'], f.ops, { surge: 1 });
  const elapsed = Date.now() - started;
  assert.deepEqual([...res.adopted].sort(), ['b1', 'b2', 'i1', 'i2']);
  assert.deepEqual(res.failed, []);
  assert.equal(res.interrupted, false);
  assert.ok(f.minCapacity() >= 4, `capacity dropped to ${f.minCapacity()}`);
  // Idle workers are adopted before any busy worker.
  const order = f.log.filter((e) => e[0] === 'surge').map((e) => e[1]);
  assert.deepEqual(order.slice(0, 2).sort(), ['i1', 'i2']);
  // Every old child drained only AFTER its replacement was ready (adopted).
  for (const [id, s] of f.st) assert.ok(s.adoptedAt != null && s.drainAt != null && s.newReady, id);
  // Busy drains overlap: both drained before either exited.
  const ev = (k, id) => f.log.find((e) => e[0] === k && e[1] === id)[2];
  assert.ok(ev('drain', 'b2') < ev('exited', 'b1'), 'busy drains must run in parallel, not serially');
  // Roll ends when the longest job does — well under two serial 200ms drains.
  assert.ok(elapsed < 390, `roll took ${elapsed}ms — drains look serial`);
});

test('#340: a replacement that never becomes ready — old worker NOT drained, roll reports the failure', async () => {
  const f = fleet({ a: { jobMs: 50 }, b: { jobMs: 50 }, c: { jobMs: 50 } }, { neverReady: new Set(['b']) });
  const res = await runSurgeRoll(['a', 'b', 'c'], f.ops, { surge: 1 });
  assert.deepEqual(res.adopted, ['a']);
  assert.deepEqual(res.failed.map((x) => x.id), ['b']);
  assert.match(res.failed[0].reason, /never became ready/);
  assert.deepEqual(res.skipped, ['c'], 'no new surge starts after a failure');
  assert.equal(res.interrupted, true);
  assert.equal(f.st.get('b').drainAt, null, 'the old worker of a never-ready replacement is never drained');
  assert.equal(f.st.get('b').oldLeasing, true);
  assert.ok(f.log.some((e) => e[0] === 'abandon' && e[1] === 'b'), 'the never-ready replacement is abandoned (killed)');
  assert.equal(f.st.get('c').drainAt, null);
  assert.ok(f.minCapacity() >= 3);
});

test('#340: surge limit bounds concurrent busy replacements; `all` surges every busy worker at once', async () => {
  const run = async (surge) => {
    let inFlight = 0; let peak = 0;
    const ops = {
      isIdle: () => false,
      surge: async (id) => { inFlight++; peak = Math.max(peak, inFlight); return { id }; },
      waitReady: async () => { await tick(20); inFlight--; return true; },
      abandon: async () => {},
      drainOld: async () => { await tick(5); },
    };
    const res = await runSurgeRoll(['a', 'b', 'c', 'd'], ops, { surge });
    assert.equal(res.adopted.length, 4);
    return peak;
  };
  assert.equal(await run(1), 1);
  assert.equal(await run(2), 2);
  assert.equal(await run(Infinity), 4);
});

test('#340: a replacement that cannot be started aborts without draining', async () => {
  let drained = 0;
  const res = await runSurgeRoll(['a', 'b'], {
    isIdle: () => false, surge: async () => null, waitReady: async () => true, abandon: async () => {}, drainOld: async () => { drained++; },
  });
  assert.equal(drained, 0);
  assert.deepEqual(res.failed.map((x) => x.id), ['a']);
  assert.deepEqual(res.skipped, ['b']);
});

test('#340: parseReloadSurge', () => {
  assert.equal(parseReloadSurge(undefined), 1);
  assert.equal(parseReloadSurge(''), 1);
  assert.equal(parseReloadSurge('3'), 3);
  assert.equal(parseReloadSurge('all'), Infinity);
  assert.equal(parseReloadSurge('ALL'), Infinity);
  assert.equal(parseReloadSurge('0'), Infinity);
  assert.equal(parseReloadSurge('-2'), 1);
  assert.equal(parseReloadSurge('x', 2), 2);
});

test('#340: status shows code version, drain duration and flags a wedged stopping worker', () => {
  const lines = formatSupervisorDrainLines([
    { id: 'w1', state: 'running', version: '2.0.0', retiring: [{ pid: 11, version: '1.0.0', drainingMs: 125_000, stoppingIdleMs: null, jobs: ['J9'] }] },
    { id: 'w2', state: 'stopping', version: '1.0.0', drainingMs: 400_000, stoppingIdleMs: 200_000, activity: { state: 'idle', jobs: [] } },
    { id: 'w3', state: 'running', version: '2.0.0', retiring: [] },
  ]).join('\n');
  assert.match(lines, /retiring:\s+w1 old pid 11 \(code 1\.0\.0\) → new 2\.0\.0 draining for 2m5s — finishing job J9/);
  assert.match(lines, /draining:\s+w2 \(code 1\.0\.0\) for 6m40s — ⚠ stopping with no job for 3m20s/);
  assert.match(lines, /versions:\s+w1=2\.0\.0\s+w2=1\.0\.0\s+w3=2\.0\.0/);
  assert.deepEqual(formatSupervisorDrainLines([{ id: 'a', state: 'running', version: '1', retiring: [] }]), []);
});

test('#340: readiness means really polling — a marker reporting 0 job types is not ready', () => {
  assert.equal(activityMarkerReadyFor({ pid: 5, readyAt: 1, jobTypeCount: 0 }, 5), false);
  assert.equal(activityMarkerReadyFor({ pid: 5, readyAt: 1, jobTypeCount: 2 }, 5), true);
  assert.equal(activityMarkerReadyFor({ pid: 5, readyAt: 1 }, 5), true, 'older markers without the field fall back to readyAt');
  assert.equal(activityMarkerReadyFor({ pid: 5, readyAt: null, jobTypeCount: 2 }, 5), false);
  assert.equal(activityMarkerReadyFor({ pid: 6, readyAt: 1, jobTypeCount: 2 }, 5), false);
});

test('#340 review: a surge refused because the worker is stopping is skipped, not failed', async () => {
  const res = await runSurgeRoll(['a', 'b'], {
    isIdle: () => true,
    surge: async () => null,
    waitReady: async () => true,
    abandon: async () => {},
    drainOld: async () => {},
    shouldAbort: (() => { let n = 0; return () => n++ > 0; })(),
  });
  assert.deepEqual(res.failed, []);
  assert.ok(res.skipped.includes('a'));
});

test('#340 review: a surge that cannot start (not aborting) is still a failure', async () => {
  const res = await runSurgeRoll(['a'], {
    isIdle: () => true, surge: async () => null, waitReady: async () => true,
    abandon: async () => {}, drainOld: async () => {}, shouldAbort: () => false,
  });
  assert.equal(res.failed.length, 1);
});

test('#340 review: daemon upgrade is refused while old-code children are still draining', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  assert.match(src, /!upgrading && liveRetiringIds\(\)\.length > 0\) \{\s*sock\.write\(encodeFrame\(\{ ok: false, code: 'UPGRADE_RETIRING_BUSY'/);
  assert.match(src, /if \(liveRetiringIds\(\)\.length > 0\) \{\s*rollbackFromUpgrade\(/);
  assert.match(src, /prep\.code === 'UPGRADE_RETIRING_BUSY'/);
});

test('#340 review: removing/stopping a reloading worker covers its retiring children', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  // drain-remove keeps the record until current AND retiring children exit
  assert.match(src, /const finishDrainRemove = \(w\) => \{[\s\S]*?if \(liveRetiring\(w\)\.length > 0\) return;/);
  assert.match(src, /for \(const p of stopRetiringOf\(w, false\)\) p\.catch/);
  assert.match(src, /await Promise\.all\(\[forceStopWorker\(w\), \.\.\.stopRetiringOf\(w, true\)\]\)/);
  assert.match(src, /dlog\(`worker '\$\{w\.id\}' old-code child pid \$\{old\.pid\} exited \(drained\)`\);\s*finishDrainRemove\(w\);/);
});

test('#340 review: rollback is skipped when stop/shutdown owns the worker, and cancels replacement retries', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const abandonSurge ='), src.indexOf('const drainRetiring ='));
  assert.ok(body.indexOf('clearTimeout(w.restartTimer)') < body.indexOf('w.child = old.child'));
  assert.match(body, /if \(w\.stopping \|\| w\.removeOnExit \|\| shuttingDown \|\| upgrading \|\| workers\.get\(id\) !== w\) return;/);
  // an un-adopted surged replacement never arms an automatic restart
  assert.match(src, /if \(w\.surgeChild === child\) \{\s*dlog\(/);
});

test('#340 review: concurrent incarnations share one ref-counted log ring per path', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  assert.match(src, /ring = acquireLogRing\(w\.logFile\);/);
  assert.doesNotMatch(src, /ring = createLogRing\(w\.logFile/);
});

// ---- #340 review round 3 ----
test('#340 review: overlapping surge incarnations get distinct agentic identities', () => {
  const { agenticInstanceName } = mod;
  assert.equal(agenticInstanceName('w1', undefined), 'w1');
  assert.equal(agenticInstanceName('w1', ''), 'w1');
  assert.equal(agenticInstanceName('w1', '$$$'), 'w1', 'an all-invalid incarnation falls back to the bare name');
  assert.equal(agenticInstanceName('w1', 'rabc1'), 'w1~rabc1');
  assert.notEqual(agenticInstanceName('w1', 'ra'), agenticInstanceName('w1', 'rb'));
  assert.equal(agenticInstanceName('w1', 'r/../x y'), 'w1~r..xy', 'sanitised');
  assert.ok(agenticInstanceName('w1', 'x'.repeat(100)).length <= 'w1~'.length + 32, 'bounded');
});

test('#340 review: retiring drain / wedge clocks re-age locally on an attached console', () => {
  const { reageSupervisorStatus } = mod;
  const t0 = 1_000_000;
  const status = { workers: [{ id: 'w1', state: 'stopping', drainingSinceMs: t0, drainingMs: 0, stoppingIdleSinceMs: t0 + 10, stoppingIdleMs: 0,
    retiring: [{ pid: 7, drainingSinceMs: t0, drainingMs: 5, stoppingIdleSinceMs: t0 + 100, stoppingIdleMs: 0, jobs: [] }] }] };
  const r = reageSupervisorStatus(status, t0 + 3_600_000);
  assert.equal(r.workers[0].drainingMs, 3_600_000);
  assert.equal(r.workers[0].stoppingIdleMs, 3_600_000 - 10);
  assert.equal(r.workers[0].retiring[0].drainingMs, 3_600_000);
  assert.equal(r.workers[0].retiring[0].stoppingIdleMs, 3_600_000 - 100);
  assert.equal(status.workers[0].retiring[0].drainingMs, 5, 'input not mutated');
  const lines = mod.formatSupervisorDrainLines(r.workers).join('\n');
  assert.match(lines, /⚠ stopping with no job/, 'wedge warning appears without a re-broadcast');
});

test('#340 review: retiring drain/wedge transitions change the monitor signature; ticking durations do not', () => {
  const { supervisorStatusSignature } = mod;
  const base = { id: 'w1', state: 'running', pid: 2, restarts: 0, retiring: [{ pid: 1, drainingSinceMs: 5, drainingMs: 10, stoppingIdleSinceMs: null, stoppingIdleMs: null, jobs: ['J1'] }] };
  const sig = supervisorStatusSignature([base]);
  const ticked = { ...base, retiring: [{ ...base.retiring[0], drainingMs: 99_999 }] };
  assert.equal(supervisorStatusSignature([ticked]), sig, 'elapsing clock is not a change');
  const idle = { ...base, retiring: [{ ...base.retiring[0], jobs: [], stoppingIdleSinceMs: 50 }] };
  assert.notEqual(supervisorStatusSignature([idle]), sig, 'retiring child going idle (wedge clock armed) repaints');
  const gone = { ...base, retiring: [] };
  assert.notEqual(supervisorStatusSignature([gone]), sig, 'retiring child exit repaints');
  const draining = { ...base, drainingSinceMs: 7 };
  assert.notEqual(supervisorStatusSignature([draining]), sig, 'worker drain start repaints');
});

test('#340 review: a worker with a pending upgrade retarget is never surged (reported skipped)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const surge = src.slice(src.indexOf('const surgeWorker = (id) =>'), src.indexOf('const waitSurgeReady ='));
  assert.match(surge, /if \(retargetPending\.has\(id\)\) return null;/);
  assert.match(src, /shouldAbort: \(id\) => [^\n]*retargetPending\.has\(id\)/);
  // ...and the orchestration reports such a worker skipped, not failed.
  const surged = [];
  const res = await runSurgeRoll(['a'], {
    isIdle: () => true, surge: async (id) => { surged.push(id); return null; },
    waitReady: async () => true, abandon: async () => {}, drainOld: async () => {},
    shouldAbort: () => true,
  }, { surge: 1 });
  assert.deepEqual(surged, []);
  assert.deepEqual(res.skipped, ['a']);
  assert.deepEqual(res.failed, []);
});

test('#347: surge rollback clears the retirement poll and detaches the exit listener', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');
  const surge = src.slice(src.indexOf('const surgeWorker ='), src.indexOf('const waitSurgeReady ='));
  assert.match(surge, /old\.poll = setInterval\(/);
  assert.match(surge, /old\.onExit = done;/);
  const body = src.slice(src.indexOf('const abandonSurge ='), src.indexOf('const drainRetiring ='));
  assert.match(body, /clearInterval\(old\.poll\)/);
  assert.match(body, /old\.child\.removeListener\('exit', old\.onExit\)/);
  // the restored child becomes current again, so its own death handler (auto-restart) is live
  assert.ok(body.indexOf('w.child = old.child') >= 0);
});

test('#347: in-flight count (draining frame) includes retiring children\'s jobs', () => {
  const { countSupervisorInFlight } = mod;
  const workers = [
    { id: 'a', activity: { jobs: [] }, retiring: [{ pid: 1, jobs: ['k1', 'k2'] }] },
    { id: 'b', activity: { jobs: [{ key: 'x' }] }, retiring: [] },
  ];
  assert.equal(countSupervisorInFlight(workers), 3);
});
