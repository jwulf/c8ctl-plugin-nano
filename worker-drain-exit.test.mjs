// Issue #339: a draining worker must EXIT after its last in-flight job completes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createWorkerStopLifecycle, armWorkerExitBackstop, describeOpenHandles,
  workerDrainStuckMs, DEFAULT_WORKER_DRAIN_STUCK_MS, WORKER_DRAIN_STUCK_ENV,
  stoppingWorkerEscalation, supervisorStoppingIdleMs, DEFAULT_SUPERVISOR_STOPPING_IDLE_MS,
} from './c8ctl-plugin.js';

const silent = { info() {}, warn() {}, debug() {} };
const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

test('drain: a leaked registry count does not hold the drain once the worker runs no job', async () => {
  let t = 0;
  const warns = [];
  let exited = false;
  const lc = createWorkerStopLifecycle({
    logger: { info() {}, warn: (m) => warns.push(m) },
    interrupt: async () => {}, pollMs: 5, drainStuckMs: 50, now: () => t,
    inFlightCount: () => 1, // leaked: never decremented
    localInFlightCount: () => 0,
    onExit: () => { exited = true; },
  });
  lc.gracefulDrain('SIGUSR2');
  for (let i = 0; i < 200 && !exited; i++) { t += 10; await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(exited, true);
  assert.ok(warns.some((m) => m.includes('#339')));
});

test('drain: a running local job keeps the drain waiting', async () => {
  let t = 0; let exited = false;
  const lc = createWorkerStopLifecycle({
    logger: silent, interrupt: async () => {}, pollMs: 5, drainStuckMs: 50, now: () => t,
    inFlightCount: () => 1, localInFlightCount: () => 1, onExit: () => { exited = true; },
  });
  lc.gracefulDrain('SIGUSR2');
  for (let i = 0; i < 30; i++) { t += 10; await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(exited, false);
  lc.forceAbort('SIGTERM');
});

test('workerDrainStuckMs / supervisorStoppingIdleMs defaults and overrides', () => {
  assert.equal(workerDrainStuckMs({}), DEFAULT_WORKER_DRAIN_STUCK_MS);
  assert.equal(workerDrainStuckMs({ [WORKER_DRAIN_STUCK_ENV]: '900' }), 900);
  assert.equal(supervisorStoppingIdleMs({}), DEFAULT_SUPERVISOR_STOPPING_IDLE_MS);
});

test('armWorkerExitBackstop logs open handles and force-exits', () => {
  let fn; let code = null; const warns = [];
  armWorkerExitBackstop({ ms: 5, logger: { warn: (m) => warns.push(m) }, exitProcess: (c) => { code = c; }, describe: () => 'Timeout×1', setTimer: (f) => { fn = f; return { unref() {} }; } });
  fn();
  assert.equal(code, process.exitCode ?? 0);
  assert.match(warns[0], /Timeout×1/);
  assert.equal(typeof describeOpenHandles(), 'string');
});

test('end to end: SIGUSR2 drain with an in-flight agent job exits after the job completes, despite a leaked handle', async () => {
  // The child holds a REF'D interval (a leaked producer flush timer) that would
  // keep the loop alive forever after the lifecycle resolves.
  const script = `
    import { createWorkerStopLifecycle, armWorkerExitBackstop } from ${JSON.stringify(pluginUrl)};
    let inFlight = 1;
    setInterval(() => {}, 1000); // leaked handle (e.g. AgentInstance producer)
    setTimeout(() => { inFlight = 0; console.log('job complete'); }, 300);
    await new Promise((resolve) => {
      const lc = createWorkerStopLifecycle({
        logger: console, interrupt: async () => {}, pollMs: 20,
        inFlightCount: () => inFlight, localInFlightCount: () => inFlight,
        onExit: () => { armWorkerExitBackstop({ ms: 300, logger: console }); resolve(); },
      });
      process.on('SIGUSR2', () => lc.gracefulDrain('SIGUSR2'));
      console.log('ready');
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], cwd: fileURLToPath(new URL('.', import.meta.url)) });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    if (out.includes('ready') && !child.signalled) { child.signalled = true; child.kill('SIGUSR2'); }
  });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker did not exit: ${out}`)); }, 20_000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0, out);
  assert.match(out, /job complete/);
  assert.match(out, /Worker stopped/);
  assert.match(out, /open handles/);
});

test('supervisor escalation: a wedged stopping worker gets SIGTERM then SIGKILL', () => {
  const w = { pid: 42, stoppingIdle: null };
  const idle = { pid: 42, jobs: [] };
  let s = stoppingWorkerEscalation({ worker: w, activity: idle, now: 0, idleMs: 100, killGraceMs: 50 });
  assert.equal(s.action, 'none'); w.stoppingIdle = s.state;
  s = stoppingWorkerEscalation({ worker: w, activity: idle, now: 100, idleMs: 100, killGraceMs: 50 });
  assert.equal(s.action, 'term'); w.stoppingIdle = s.state;
  s = stoppingWorkerEscalation({ worker: w, activity: idle, now: 120, idleMs: 100, killGraceMs: 50 });
  assert.equal(s.action, 'none'); w.stoppingIdle = s.state;
  s = stoppingWorkerEscalation({ worker: w, activity: idle, now: 150, idleMs: 100, killGraceMs: 50 });
  assert.equal(s.action, 'kill'); w.stoppingIdle = s.state;
  s = stoppingWorkerEscalation({ worker: w, activity: idle, now: 500, idleMs: 100, killGraceMs: 50 });
  assert.equal(s.action, 'none');
});

test('supervisor escalation: a stopping worker with a running job is never escalated', () => {
  const w = { pid: 42, stoppingIdle: { since: 0 } };
  const busy = { pid: 42, jobs: [{ key: '1', type: 't', since: 0 }] };
  const s = stoppingWorkerEscalation({ worker: w, activity: busy, now: 10_000_000, idleMs: 100, killGraceMs: 50 });
  assert.deepEqual(s, { action: 'none', state: null });
  // a settlementPending ghost does not count as running
  const ghost = { pid: 42, jobs: [{ key: '1', settlementPending: true }] };
  assert.equal(stoppingWorkerEscalation({ worker: { pid: 42, stoppingIdle: { since: 0 } }, activity: ghost, now: 200, idleMs: 100, killGraceMs: 50 }).action, 'term');
});
