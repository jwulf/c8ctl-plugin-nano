// Regression test for the orphan-worker leak: when the supervisor daemon dies
// *ungracefully* (SIGKILL / crash), it can't run its child-reaping shutdown, so
// a supervised `nano work` child must self-terminate via its parent-death
// watchdog instead of surviving forever as an orphan reparented to init.
//
// Reproduction: spawn the real detached daemon, add a worker (an idle stand-in
// that installs the SAME exported watchdog a real worker uses), SIGKILL the
// daemon, and assert the worker child exits on its own within a short window.
// Before the fix the child idled forever and this timed out; after it, the
// watchdog notices the reparent and exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Reparent-to-init (the watchdog's signal) is a POSIX semantic; the watchdog
// no-ops on Windows, so there is nothing to assert there.
test('supervisor: ungraceful daemon death lets a supervised worker self-reap', { skip: osPlatform() === 'win32' }, async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-orphan-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;

  // A profile must exist for `add` to be accepted (validated against config.json).
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // Fake c8ctl entry: routes `nano supervisor __daemon` to the real daemon and
  // `nano work` to an idle stand-in that installs the real exported watchdog on
  // a fast tick (so the test is quick) and then keeps the loop alive — exactly
  // the shape of a supervised worker minus the broker poll loop.
  const shim = join(HOME, 'fake-entry.mjs');
  writeFileSync(shim, [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  // Mirror workAgent's supervised gating: a supervised worker arms the`,
    `  // parent-death watchdog, watching the daemon pid the spawn recorded. The`,
    `  // typeof guard makes this a clean red/green — pre-fix the export is absent,`,
    `  // so the worker just idles and orphans.`,
    `  if (process.env.NANO_SUPERVISOR_ACTIVITY_FILE && typeof mod.installParentDeathWatchdog === 'function') {`,
    `    const dp = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);`,
    `    mod.installParentDeathWatchdog({ intervalMs: 100, parentPid: Number.isInteger(dp) ? dp : undefined });`,
    `  }`,
    `  setInterval(() => {}, 1 << 30); // idle keep-alive until the watchdog fires`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);

  t.after(async () => {
    // Belt-and-braces: kill anything still alive so a test failure can't itself
    // leak the very orphans it is guarding against.
    const st = mod.runningSupervisor();
    if (st && st.pid) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    if (prevEntry === undefined) delete process.env.C8CTL_NANO_ENTRY; else process.env.C8CTL_NANO_ENTRY = prevEntry;
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prevHome;
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Start the detached daemon and add one worker.
  const daemon = await mod.startSupervisorDaemon();
  assert.ok(daemon && daemon.pid, 'daemon should report a pid');
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker' });
  assert.equal(added.ok, true, 'worker add should succeed');

  // Poll for the child to be observed running and capture its pid.
  let workerPid = null;
  for (let i = 0; i < 30 && !workerPid; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 1 && s.workers[0].state === 'running' && s.workers[0].pid) workerPid = s.workers[0].pid;
    else await sleep(100);
  }
  assert.ok(workerPid, 'the added worker should be running with a pid');
  assert.ok(isPidAlive(workerPid), 'sanity: worker is alive before we kill the daemon');

  // Kill the daemon *ungracefully* — SIGKILL can't run shutdown()/stopWorker(),
  // so nothing on the daemon side reaps the child. Only the child's own
  // parent-death watchdog can save it.
  process.kill(daemon.pid, 'SIGKILL');
  for (let i = 0; i < 60 && isPidAlive(daemon.pid); i++) await sleep(50); // let the daemon actually die
  assert.ok(!isPidAlive(daemon.pid), 'daemon should be dead after SIGKILL');

  // The worker must self-exit once reparented. Generous window vs the 100ms tick.
  let workerDied = false;
  for (let i = 0; i < 100 && !workerDied; i++) {
    if (!isPidAlive(workerPid)) { workerDied = true; break; }
    await sleep(100);
  }
  assert.ok(workerDied, `supervised worker (pid ${workerPid}) should self-reap after the daemon dies ungracefully`);
});

// The nastier race: the daemon dies *during the worker's own startup*, before
// the worker has finished its (async) plugin import and armed the watchdog. By
// then the worker is already reparented to init, so a naive "remember ppid at
// arm time" watchdog would watch pid 1 and never fire. The watchdog must instead
// watch the daemon pid the spawn recorded and self-reap immediately when it sees
// it is already orphaned.
test('supervisor: worker orphaned mid-startup still self-reaps', { skip: osPlatform() === 'win32' }, async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-orphan-race-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;

  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  const shim = join(HOME, 'fake-entry.mjs');
  writeFileSync(shim, [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  if (process.env.NANO_SUPERVISOR_ACTIVITY_FILE && typeof mod.installParentDeathWatchdog === 'function') {`,
    `    const dp = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);`,
    `    mod.installParentDeathWatchdog({ intervalMs: 100, parentPid: Number.isInteger(dp) ? dp : undefined });`,
    `  }`,
    `  setInterval(() => {}, 1 << 30);`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);

  t.after(async () => {
    const st = mod.runningSupervisor();
    if (st && st.pid) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    if (prevEntry === undefined) delete process.env.C8CTL_NANO_ENTRY; else process.env.C8CTL_NANO_ENTRY = prevEntry;
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prevHome;
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const daemon = await mod.startSupervisorDaemon();
  assert.ok(daemon && daemon.pid, 'daemon should report a pid');
  // `add` returns as soon as the daemon has spawned the child — the child is
  // very likely still mid-import here. Capture its pid, then kill the daemon
  // immediately to race the worker's startup.
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker' });
  assert.equal(added.ok, true, 'worker add should succeed');
  const workerPid = added.worker.pid;
  assert.ok(workerPid, 'add should report the spawned worker pid');

  process.kill(daemon.pid, 'SIGKILL');
  for (let i = 0; i < 60 && isPidAlive(daemon.pid); i++) await sleep(50);
  assert.ok(!isPidAlive(daemon.pid), 'daemon should be dead after SIGKILL');

  let workerDied = false;
  for (let i = 0; i < 100 && !workerDied; i++) {
    if (!isPidAlive(workerPid)) { workerDied = true; break; }
    await sleep(100);
  }
  assert.ok(workerDied, `worker (pid ${workerPid}) orphaned during startup should still self-reap`);
});
