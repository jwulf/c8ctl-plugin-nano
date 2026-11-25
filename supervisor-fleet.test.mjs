// Issue #351: the supervised fleet survives a reboot / crash restart. A
// SIGTERM (host shutdown) keeps the desired-fleet record (fleet.json) and the
// next plain daemon start restores it; an explicit `stop` erases it.
import './test-support/hermetic-service.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NANO_TEST_RUNNER_PID = String(process.pid);

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeShim(path) {
  writeFileSync(path, `
const argv = process.argv.slice(2);
if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {
  const rp = Number.parseInt(process.env.NANO_TEST_RUNNER_PID ?? '', 10);
  if (Number.isInteger(rp) && rp > 0) { const t = setInterval(() => { try { process.kill(rp, 0); } catch { process.kill(process.pid, 'SIGTERM'); setTimeout(() => process.exit(1), 15000).unref(); } }, 1000); t.unref(); }
  const mod = await import(${JSON.stringify(pluginUrl)});
  await mod.runSupervisorDaemon();
} else {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGUSR2', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
}

async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
  return null;
}

function setup(t) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-fleet-'));
  const prev = { home: process.env.C8CTL_NANO_HOME, entry: process.env.C8CTL_NANO_ENTRY };
  process.env.C8CTL_NANO_HOME = HOME;
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim);
  process.env.C8CTL_NANO_ENTRY = shim;
  t.after(async () => {
    const mod = await import(pluginUrl);
    try { await mod.supervisorRequest({ op: 'stop', force: true }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(-st.pid, 'SIGKILL'); } catch { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } } }
    try { rmSync(mod.getSupervisorSocketPath(), { force: true }); } catch { /* ignore */ }
    mod.clearSupervisorState();
    if (prev.home === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev.home;
    if (prev.entry === undefined) delete process.env.C8CTL_NANO_ENTRY; else process.env.C8CTL_NANO_ENTRY = prev.entry;
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return HOME;
}

async function runningIds(mod) {
  const s = await mod.supervisorRequest({ op: 'status' });
  return (s.workers || []).filter((w) => w.state === 'running' && w.pid).map((w) => w.id).sort();
}

test('normalizeFleetRecords keeps only well-formed unique records', async () => {
  const mod = await import(pluginUrl);
  assert.deepEqual(mod.normalizeFleetRecords([
    { id: 'a', profile: 'p', args: ['--auto', '--profile', 'merlin', 3] },
    { id: 'a', profile: 'p' },
    { id: 'bad id', profile: 'p' },
    { id: 'b' },
    null,
  ]), [{ id: 'a', profile: 'p', args: ['--auto', '--profile', 'merlin'] }]);
  assert.deepEqual(mod.normalizeFleetRecords('nope'), []);
});

test('#351: SIGTERM keeps the fleet; a fresh daemon start restores the same workers', async (t) => {
  setup(t);
  const mod = await import(pluginUrl);
  const st = await mod.startSupervisorDaemon();
  for (const name of ['w1', 'w2']) {
    const r = await mod.supervisorRequest({ op: 'add', profile: 'faker', name, args: ['--auto', '--profile', 'merlin'] });
    assert.equal(r.ok, true, r.error);
  }
  assert.deepEqual(await waitFor(async () => { const ids = await runningIds(mod); return ids.length === 2 ? ids : null; }), ['w1', 'w2']);
  const fleet = mod.readFleetState();
  assert.deepEqual(fleet.map((w) => w.id).sort(), ['w1', 'w2']);

  process.kill(st.pid, 'SIGTERM');
  assert.ok(await waitFor(() => { try { process.kill(st.pid, 0); return false; } catch { return true; } }, 400), 'daemon exits on SIGTERM');
  assert.ok(existsSync(mod.getSupervisorFleetFile()), 'fleet.json survives SIGTERM');

  await mod.startSupervisorDaemon();
  const ids = await waitFor(async () => { const v = await runningIds(mod); return v.length === 2 ? v : null; });
  assert.deepEqual(ids, ['w1', 'w2'], 'the fleet is restored');
  const s = await mod.supervisorRequest({ op: 'status' });
  for (const w of s.workers) {
    assert.equal(w.profile, 'faker');
  }
  const restored = mod.readFleetState();
  for (const w of restored) assert.deepEqual(w.args, ['--auto', '--profile', 'merlin']);
  assert.match(readFileSync(mod.supervisorDaemonLogFile(), 'utf8'), /restoring 2 worker\(s\) from fleet\.json/);
});

test('#351: an explicit stop clears the fleet; the next start is empty', async (t) => {
  setup(t);
  const mod = await import(pluginUrl);
  const st = await mod.startSupervisorDaemon();
  await mod.supervisorRequest({ op: 'add', profile: 'faker', name: 'w1' });
  await waitFor(async () => (await runningIds(mod)).length === 1);
  await mod.supervisorRequest({ op: 'stop', force: true });
  assert.ok(await waitFor(() => { try { process.kill(st.pid, 0); return false; } catch { return true; } }, 400));
  assert.equal(existsSync(mod.getSupervisorFleetFile()), false);
  await mod.startSupervisorDaemon();
  await sleep(300);
  const s = await mod.supervisorRequest({ op: 'status' });
  assert.equal(s.workers.length, 0);
});

test('#351: stop with keepFleet keeps the record for the next start', async (t) => {
  setup(t);
  const mod = await import(pluginUrl);
  const st = await mod.startSupervisorDaemon();
  await mod.supervisorRequest({ op: 'add', profile: 'faker', name: 'w1' });
  await waitFor(async () => (await runningIds(mod)).length === 1);
  await mod.supervisorRequest({ op: 'stop', force: true, keepFleet: true });
  assert.ok(await waitFor(() => { try { process.kill(st.pid, 0); return false; } catch { return true; } }, 400));
  assert.deepEqual(mod.readFleetState().map((w) => w.id), ['w1']);
  await mod.startSupervisorDaemon();
  assert.deepEqual(await waitFor(async () => { const v = await runningIds(mod); return v.length === 1 ? v : null; }), ['w1']);
});

test('#351: the service stop timeout exceeds the daemon force-stop grace', async () => {
  const mod = await import(pluginUrl);
  assert.ok(mod.SUPERVISOR_SERVICE_STOP_TIMEOUT_SECS * 1000 > mod.FORCE_STOP_DAEMON_GRACE_MS);
  // The pre-abort checkpoint hook runs before the #295 recovery budget is armed,
  // so the worker SIGKILL backstop (and the daemon grace above it) must count it.
  assert.equal(mod.WORKER_FORCE_STOP_BACKSTOP_MS,
    mod.STOP_GRACE_MS + mod.PRE_ABORT_HOOK_MS + mod.FORCE_STOP_RECOVERY_MS);
  assert.ok(mod.PRE_ABORT_HOOK_MS > mod.PRE_ABORT_CHECKPOINT_MS);
  assert.ok(mod.FORCE_STOP_DAEMON_GRACE_MS > mod.WORKER_FORCE_STOP_BACKSTOP_MS);
});

test('#351: a force abort flushes WIP checkpoints BEFORE interrupting the runtime', async () => {
  const mod = await import(pluginUrl);
  const order = [];
  const cp = { flush: async (reason) => { order.push(`flush:${reason}`); return {}; } };
  const quiet = { info() {}, warn() {}, error() {} };
  let done;
  const exited = new Promise((r) => { done = r; });
  const lc = mod.createWorkerStopLifecycle({
    logger: quiet, teardownMs: 500,
    interrupt: async () => { order.push('interrupt'); },
    beforeAbort: () => mod.flushCheckpointersBeforeAbort([cp, { flush: async () => { throw new Error('x'); } }]),
    onExit: () => done(),
    exitProcess: () => {},
  });
  lc.forceAbort('SIGTERM');
  await exited;
  assert.deepEqual(order, ['flush:pre-abort', 'interrupt']);
});

test('#351: a hung pre-abort flush is bounded', async () => {
  const mod = await import(pluginUrl);
  let interrupted = false;
  let done;
  const exited = new Promise((r) => { done = r; });
  const lc = mod.createWorkerStopLifecycle({
    logger: { info() {}, warn() {}, error() {} }, teardownMs: 500, beforeAbortMs: 50,
    interrupt: async () => { interrupted = true; },
    beforeAbort: () => new Promise(() => {}),
    onExit: () => done(),
    exitProcess: () => {},
  });
  lc.forceAbort('SIGTERM');
  await exited;
  assert.equal(interrupted, true);
});
