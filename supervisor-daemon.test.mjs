// Integration test for the supervisor daemon lifecycle: it spawns the real
// detached daemon, drives it over the control socket, and verifies add /
// status / remove / stop end-to-end — without a broker. A fake "c8ctl entry"
// shim stands in for the CLI: for `nano supervisor __daemon` it runs the real
// exported daemon; for `nano work <profile>` it is an idle worker stand-in
// (so no createClient/broker is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Restore an env var to its prior value (or unset it if it was unset), so a
// test never clobbers a variable the runner/developer set before it ran.
function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

test('supervisor daemon: start → add → status → remove → stop', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-it-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;

  // A profile must exist for `add` to be accepted (the daemon validates against
  // the hires map in config.json).
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // Fake c8ctl entry: routes the daemon to the real code and `work` to an idle
  // stand-in. Kept dependency-free so it works under `node <shim>`.
  const shim = join(HOME, 'fake-entry.mjs');
  writeFileSync(shim, [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  setInterval(() => {}, 1 << 30); // idle worker stand-in until killed`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);

  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Start the detached daemon and confirm it answers on the control socket.
  const state = await mod.startSupervisorDaemon();
  assert.ok(state && state.pid, 'daemon should report a pid');
  const st0 = await mod.supervisorRequest({ op: 'status' });
  assert.equal(st0.ok, true);
  assert.equal(st0.workers.length, 0);

  // The control socket must be owner-only (0600) so other local users can't
  // drive the supervisor. (Named pipes on Windows use ACLs, not mode bits.)
  if (osPlatform() !== 'win32') {
    const mode = statSync(mod.getSupervisorSocketPath()).mode & 0o777;
    assert.equal(mode, 0o600, `control socket should be 0600, got ${mode.toString(8)}`);
  }

  // Add a worker and confirm it comes up running.
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['--max-parallel', '1'] });
  assert.equal(added.ok, true);
  assert.equal(added.worker.id, 'faker');

  // Poll briefly for the child to be observed running.
  let running = false;
  for (let i = 0; i < 20 && !running; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    running = s.workers.length === 1 && s.workers[0].state === 'running' && s.workers[0].pid;
    if (!running) await sleep(100);
  }
  assert.ok(running, 'the added worker should be running');

  // Adding an unknown profile is rejected.
  const bad = await mod.supervisorRequest({ op: 'add', profile: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no hire/);

  // `--name` is rejected: it would run a different hire than the reported
  // profile, desynchronising status/logs from what actually runs.
  const named = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['--name', 'someone-else'] });
  assert.equal(named.ok, false);
  assert.match(named.error, /--name is not allowed/);
  const nameShort = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['-n', 'someone-else'] });
  assert.equal(nameShort.ok, false);
  assert.match(nameShort.error, /--name is not allowed/);

  // The persisted state file records worker argv — it must be owner-only.
  if (process.platform !== 'win32') {
    const stMode = statSync(mod.getSupervisorStateFile()).mode & 0o777;
    assert.equal(stMode, 0o600, `supervisor state file should be 0600, got ${stMode.toString(8)}`);
  }

  // Remove the worker.
  const removed = await mod.supervisorRequest({ op: 'remove', target: 'faker' });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.removed, ['faker']);
  const st1 = await mod.supervisorRequest({ op: 'status' });
  assert.equal(st1.workers.length, 0);

  // Stop the daemon; the state file should be cleared and the pid gone.
  await mod.supervisorRequest({ op: 'stop' });
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    if (!mod.runningSupervisor()) { stopped = true; break; }
    await sleep(100);
  }
  assert.ok(stopped, 'daemon should stop and clear its state');
});

test('supervisor daemon: restarts a crashing worker', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-rt-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { flaky: { name: 'flaky', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // The `work` stand-in exits immediately (code 1) → the daemon must restart it.
  const shim = join(HOME, 'fake-entry.mjs');
  writeFileSync(shim, [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  process.exit(1); // crash immediately`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);
  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await mod.startSupervisorDaemon();
  await mod.supervisorRequest({ op: 'add', profile: 'flaky' });

  // Backoff starts at 1s, so within a few seconds we should see >=1 restart.
  let restarts = 0;
  for (let i = 0; i < 40; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 1) restarts = s.workers[0].restarts;
    if (restarts >= 1) break;
    await sleep(150);
  }
  assert.ok(restarts >= 1, `crashing worker should be restarted (saw ${restarts})`);

  await mod.supervisorRequest({ op: 'stop' });
});

test('supervisor daemon: restart swaps the child without a spurious restart bump', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-rs-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { steady: { name: 'steady', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));
  // Idle worker stand-in that ignores SIGTERM, so `restart` must SIGKILL it and
  // the (late) old-child exit must NOT be misattributed to the new child.
  const shim = join(HOME, 'fake-entry.mjs');
  writeFileSync(shim, [
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  process.on('SIGTERM', () => {}); // force the SIGKILL path on restart`,
    `  setInterval(() => {}, 1 << 30);`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);
  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await mod.startSupervisorDaemon();
  await mod.supervisorRequest({ op: 'add', profile: 'steady' });
  let first = null;
  for (let i = 0; i < 20; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers[0]?.state === 'running') { first = s.workers[0].pid; break; }
    await sleep(100);
  }
  assert.ok(first, 'worker should be running before restart');

  await mod.supervisorRequest({ op: 'restart', target: 'steady' });

  // Give the killed old child's exit event time to (wrongly) fire.
  await sleep(500);
  const s2 = await mod.supervisorRequest({ op: 'status' });
  assert.equal(s2.workers.length, 1, 'exactly one worker after restart (no leaked duplicate)');
  assert.equal(s2.workers[0].state, 'running');
  assert.notEqual(s2.workers[0].pid, first, 'restart should swap in a new child pid');
  assert.equal(s2.workers[0].restarts, 0, 'restart must not be counted as a crash-restart');

  await mod.supervisorRequest({ op: 'stop' });
});

test('supervisor daemon: adopts a live daemon when the state file is missing', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-ad-'));
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
    `  setInterval(() => {}, 1 << 30);`,
    `}`,
  ].join('\n'));
  process.env.C8CTL_NANO_ENTRY = shim;

  const mod = await import(pluginUrl);
  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const first = await mod.startSupervisorDaemon();
  assert.ok(first && first.pid, 'daemon should be up with a pid');

  // Simulate the state file being deleted/cleaned while the daemon still
  // listens on the deterministic socket.
  mod.clearSupervisorState();
  assert.equal(mod.readSupervisorState(), null, 'state file should be gone');

  // A second start must adopt the live daemon over the socket, not spawn another.
  const second = await mod.startSupervisorDaemon();
  assert.equal(second.pid, first.pid, 'should adopt the existing daemon, not spawn a second');

  await mod.supervisorRequest({ op: 'stop' });
});
