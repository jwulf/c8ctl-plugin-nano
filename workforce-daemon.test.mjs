// Integration test for `workforce start`/`stop` reconcile against a REAL
// supervisor daemon. A fake "c8ctl entry" shim routes `nano supervisor __daemon`
// to the real exported daemon and `nano work <profile>` to a dependency-free
// idle stand-in (so no broker/createClient is needed). This proves the
// convergent reconcile: cold start brings up the deterministic wf-<manifest>-
// workers, a second start with an unchanged manifest is a NO-OP (no churn), a
// scale-down stops the surplus, and `stop` removes the manifest's workers and
// stops the now-empty daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

function writeShim(shimPath) {
  const lines = [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  const { installParentDeathWatchdog } = await import(${JSON.stringify(pluginUrl)});`,
    `  const dp = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);`,
    `  installParentDeathWatchdog({ intervalMs: 100, parentPid: Number.isInteger(dp) ? dp : undefined });`,
    `  setInterval(() => {}, 1 << 30);`,
    `}`,
  ];
  writeFileSync(shimPath, lines.join('\n'));
}

// Poll supervisor status until `n` workers are running (or timeout).
async function waitForWorkers(mod, n, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await mod.supervisorRequest({ op: 'status' });
      const running = (res.workers || []).filter((w) => w.state === 'running');
      if (running.length === n) return running;
    } catch { /* not up yet */ }
    await sleep(50);
  }
  const res = await mod.supervisorRequest({ op: 'status' }).catch(() => ({ workers: [] }));
  return (res.workers || []).filter((w) => w.state === 'running');
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, output: () => {} };

// Poll the control socket until it stops answering — the true "daemon is gone"
// signal. The daemon clears its state file *early* during shutdown, so
// runningSupervisor() can read null while the socket/process is still alive;
// relying on the state file would let the test pass (and cleanup skip its kill)
// with a live daemon. supervisorRequest throws once the socket is gone.
async function waitForSupervisorGone(mod, tries = 280) {
  for (let i = 0; i < tries; i++) {
    try { await mod.supervisorRequest({ op: 'status' }); }
    catch { return true; }
    await sleep(50);
  }
  return false;
}

test('workforce start/stop reconciles a real supervisor', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-wf-it-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  const prevC8ctl = globalThis.c8ctl;
  process.env.C8CTL_NANO_HOME = HOME;

  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { copilot: { name: 'copilot', rank: 'senior', command: 'true', model: '', capabilities: [], sandbox: 'none' } },
  }));
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim);
  process.env.C8CTL_NANO_ENTRY = shim;
  globalThis.c8ctl = { getLogger: () => silentLogger };

  const mod = await import(pluginUrl);

  t.after(async () => {
    // Capture the daemon pid up front: the supervisor clears supervisor.json
    // early during shutdown, so a slow/failed stop can leave the process alive
    // while runningSupervisor() already reads null. Fall back to this snapshot
    // so the SIGKILL still fires and no daemon leaks into later tests.
    const before = mod.runningSupervisor();
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor() || before;
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    if (prevC8ctl === undefined) delete globalThis.c8ctl; else globalThis.c8ctl = prevC8ctl;
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Compose a 2-instance auto manifest.
  mod.writeWorkforceManifest(
    mod.upsertManifestEntry(mod.emptyWorkforceManifest('default'), { profile: 'copilot', instances: 2, roles: 'auto' }),
  );

  // Cold start → two wf-default-copilot-* workers come up.
  await mod.commands.nano.handler(['workforce', 'start'], {});
  let running = await waitForWorkers(mod, 2);
  const names = running.map((w) => w.id).sort();
  assert.deepEqual(names, ['wf-default-copilot-1', 'wf-default-copilot-2']);
  const pidsBefore = new Map(running.map((w) => [w.id, w.pid]));

  // Idempotent re-run → same workers, same pids (nothing started/stopped/restarted).
  await mod.commands.nano.handler(['workforce', 'start'], {});
  running = await waitForWorkers(mod, 2);
  for (const w of running) {
    assert.equal(w.pid, pidsBefore.get(w.id), `worker ${w.id} must not be restarted on a no-op start`);
    assert.equal(w.restarts, 0, `worker ${w.id} must have no restarts`);
  }

  // Scale down to 1 → the surplus instance is stopped, instance 1 untouched.
  mod.writeWorkforceManifest(
    mod.upsertManifestEntry(mod.emptyWorkforceManifest('default'), { profile: 'copilot', instances: 1, roles: 'auto' }),
  );
  await mod.commands.nano.handler(['workforce', 'start'], {});
  running = await waitForWorkers(mod, 1);
  assert.deepEqual(running.map((w) => w.id), ['wf-default-copilot-1']);
  assert.equal(running[0].pid, pidsBefore.get('wf-default-copilot-1'), 'surviving worker must not be restarted');

  // Stop → the manifest's workers are removed and the empty daemon is stopped.
  await mod.commands.nano.handler(['workforce', 'stop'], {});
  // supervisorStopCmd can wait up to STOP_GRACE_MS + 2s for the daemon to exit,
  // so poll the control socket (not the early-cleared state file) well past that
  // (≈14s) to stay robust under CI load.
  const gone = await waitForSupervisorGone(mod);
  assert.ok(gone, 'daemon should stop answering its control socket once no workers remain');
  assert.equal(mod.runningSupervisor(), null, 'daemon state file should be cleared once stopped');
});
