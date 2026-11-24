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
