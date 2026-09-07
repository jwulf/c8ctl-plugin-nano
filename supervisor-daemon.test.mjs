// Integration test for the supervisor daemon lifecycle: it spawns the real
// detached daemon, drives it over the control socket, and verifies add /
// status / remove / stop end-to-end — without a broker. A fake "c8ctl entry"
// shim stands in for the CLI: for `nano supervisor __daemon` it runs the real
// exported daemon; for `nano work <profile>` it is an idle worker stand-in
// (so no createClient/broker is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Read the argv a shim child recorded for a given pid (best effort — the file
// is written on the child's first tick after spawn, so retry with real delays).
async function readChildArgv(dir, pid) {
  for (let i = 0; i < 30; i++) {
    try { return JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')); } catch { /* not yet */ }
    // Fall back to scanning the dir in case the reported pid differs — but ONLY
    // when there is a single recorded child, so we never return a *different*
    // worker's argv when several are running (each keyed by its own pid).
    try {
      const files = readdirSync(dir);
      if (files.length === 1) return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    } catch { /* dir not created yet */ }
    await sleep(50);
  }
  return null;
}

// Restore an env var to its prior value (or unset it if it was unset), so a
// test never clobbers a variable the runner/developer set before it ran.
function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

// Build a fake "c8ctl entry" shim: routes `nano supervisor __daemon` to the
// real exported daemon and `nano work` to a dependency-free stand-in. Every
// idle stand-in arms the *real* exported parent-death watchdog (the same one
// workAgent installs for a supervised worker), watching the daemon pid the
// spawn recorded in NANO_SUPERVISOR_DAEMON_PID. On Unix this is what keeps
// these integration tests from leaking workers: if the daemon — or the whole
// test runner — dies ungracefully (SIGKILL / crash / a killed `node --test`, so
// `t.after` never runs), the stand-in self-reaps instead of orphaning to init.
// (The watchdog is a no-op on win32, where these tests do not run the detached
// daemon path.) A fast intervalMs keeps the reap prompt. Options: `recordArgv`
// also records the child's own argv to `<workArgvDir>/<pid>.json` (so tests can
// assert on spawn flags); `ignoreSigterm` traps SIGTERM to force the daemon's
// SIGKILL path on restart; `crash` exits immediately (code 1) with no watchdog.
function writeShim(shimPath, { recordArgv = false, workArgvDir = null, ignoreSigterm = false, crash = false, busy = null } = {}) {
  if (recordArgv && typeof workArgvDir !== 'string') {
    throw new Error('writeShim: recordArgv requires a string workArgvDir path');
  }
  const lines = [];
  if (recordArgv) {
    lines.push(
      `import { writeFileSync, mkdirSync } from 'node:fs';`,
      `import { join } from 'node:path';`,
    );
  }
  lines.push(
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
  );
  if (recordArgv) {
    lines.push(
      `  try { mkdirSync(${JSON.stringify(workArgvDir)}, { recursive: true }); ` +
      `writeFileSync(join(${JSON.stringify(workArgvDir)}, process.pid + '.json'), JSON.stringify(argv)); } catch {}`,
    );
  }
  if (crash) {
    lines.push(`  process.exit(1); // crash immediately`);
  } else if (busy) {
    // A "busy" stand-in reports one in-flight job in its activity file (so
    // `supervisor status` counts it), then models the #202 stop contract:
    //   - SIGUSR2 (graceful drain): after `drainMs`, clear the marker and exit 0.
    //   - SIGTERM (force abort): record and exit at once.
    // It records which signal it received to `sigFile`, so a test can prove a
    // drain finished the job vs a force cut it short.
    const { drainMs = 300, sigFile } = busy;
    lines.push(
      `  const { writeFileSync: wf, rmSync: rm, mkdirSync: mk } = await import('node:fs');`,
      `  const { dirname } = await import('node:path');`,
      `  const actFile = process.env.NANO_SUPERVISOR_ACTIVITY_FILE;`,
      `  try { mk(dirname(actFile), { recursive: true }); wf(actFile, JSON.stringify({ pid: process.pid, jobs: [{ key: 'J1', type: 'faker:senior', since: Date.now() }] })); } catch {}`,
      `  let ending = false;`,
      `  const endWith = (how, delay) => {`,
      `    if (ending && how !== 'forced') return; ending = true;`,
      `    try { wf(${JSON.stringify(sigFile)}, how); } catch {}`,
      `    setTimeout(() => { try { rm(actFile, { force: true }); } catch {} process.exit(0); }, delay);`,
      `  };`,
      `  process.on('SIGUSR2', () => endWith('drained', ${Number(drainMs)}));`,
      `  process.on('SIGTERM', () => endWith('forced', 0));`,
      `  const { installParentDeathWatchdog } = await import(${JSON.stringify(pluginUrl)});`,
      `  const dp = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);`,
      `  installParentDeathWatchdog({ intervalMs: 100, parentPid: Number.isInteger(dp) ? dp : undefined });`,
      `  setInterval(() => {}, 1 << 30);`,
    );
  } else {
    if (ignoreSigterm) lines.push(`  process.on('SIGTERM', () => {}); // force the SIGKILL path on restart`);
    lines.push(
      `  const { installParentDeathWatchdog } = await import(${JSON.stringify(pluginUrl)});`,
      `  const dp = Number.parseInt(process.env.NANO_SUPERVISOR_DAEMON_PID ?? '', 10);`,
      `  installParentDeathWatchdog({ intervalMs: 100, parentPid: Number.isInteger(dp) ? dp : undefined });`,
      `  setInterval(() => {}, 1 << 30); // idle keep-alive until the watchdog fires`,
    );
  }
  lines.push(`}`);
  writeFileSync(shimPath, lines.join('\n'));
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
  // stand-in. The `work` branch records its own argv to `work-argv/<pid>.json`
  // so the test can prove the daemon spawns the child with `--name <w.id>`.
  // Kept dependency-free so it works under `node <shim>`.
  const workArgvDir = join(HOME, 'work-argv');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { recordArgv: true, workArgvDir });
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

  // Add a worker and confirm it comes up running. With no explicit name the
  // daemon auto-assigns ‹short-host›-‹profile›-‹random›; the profile is still
  // `faker` (that's the hire it runs).
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['--job-timeout', '600000'] });
  assert.equal(added.ok, true);
  assert.match(added.worker.id, /^[a-z0-9._-]+-faker-[0-9a-f]+$/);
  assert.equal(added.worker.profile, 'faker');
  const autoId = added.worker.id;

  // Poll briefly for the child to be observed running.
  let running = false;
  for (let i = 0; i < 20 && !running; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    running = s.workers.length === 1 && s.workers[0].state === 'running' && s.workers[0].pid;
    if (!running) await sleep(100);
  }
  assert.ok(running, 'the added worker should be running');

  // The daemon must spawn the child with `--name <w.id>` so the child's broker
  // workerName matches its supervisor id (the core same-profile-distinctness
  // mechanism). The shim recorded its own argv keyed by pid.
  const childArgv = await readChildArgv(workArgvDir, added.worker.pid);
  assert.ok(childArgv, 'the child should have recorded its argv');
  const nameIdx = childArgv.indexOf('--name');
  assert.ok(nameIdx !== -1, `child argv should carry --name: ${JSON.stringify(childArgv)}`);
  assert.equal(childArgv[nameIdx + 1], autoId, 'child --name should equal the supervisor id');
  assert.deepEqual(childArgv.slice(0, 3), ['nano', 'work', 'faker'], 'child runs the positional profile');

  // Adding an unknown profile is rejected.
  const bad = await mod.supervisorRequest({ op: 'add', profile: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no hire/);

  // A top-level `name` names the worker (it runs the positional profile). Add a
  // second same-profile instance under an explicit name to prove co-existence.
  const named = await mod.supervisorRequest({ op: 'add', profile: 'faker', name: 'faker-two' });
  assert.equal(named.ok, true);
  assert.equal(named.worker.id, 'faker-two');
  assert.equal(named.worker.profile, 'faker');

  // Re-using an existing worker name is rejected.
  const dup = await mod.supervisorRequest({ op: 'add', profile: 'faker', name: 'faker-two' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);

  // An explicit name with unsafe chars (here `:`, which would both corrupt the
  // broker `‹name›:‹jobType›` form and collide onto a sanitized log filename) is
  // rejected up-front rather than silently mangled.
  const badName = await mod.supervisorRequest({ op: 'add', profile: 'faker', name: 'faker:1' });
  assert.equal(badName.ok, false);
  assert.match(badName.error, /invalid worker name/);

  // `--name` inside the forwarded work args is rejected: it would fight the
  // supervisor-assigned id. Operators must use the dedicated top-level flag.
  const badArgName = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['--name', 'someone-else'] });
  assert.equal(badArgName.ok, false);
  assert.match(badArgName.error, /not inside its work flags/);
  const badArgShort = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['-n', 'someone-else'] });
  assert.equal(badArgShort.ok, false);
  assert.match(badArgShort.error, /not inside its work flags/);

  // The persisted state file records worker argv — it must be owner-only.
  if (process.platform !== 'win32') {
    const stMode = statSync(mod.getSupervisorStateFile()).mode & 0o777;
    assert.equal(stMode, 0o600, `supervisor state file should be 0600, got ${stMode.toString(8)}`);
  }

  // Removing by profile resolves to every same-profile worker (both instances).
  const removed = await mod.supervisorRequest({ op: 'remove', target: 'faker' });
  assert.equal(removed.ok, true);
  assert.deepEqual([...removed.removed].sort(), [autoId, 'faker-two'].sort());
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
  writeShim(shim, { crash: true });
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
  writeShim(shim, { ignoreSigterm: true });
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
  writeShim(shim, {});
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

test('supervisor add --instances N: spawns N distinct auto-named workers, forwarding work flags (not --instances)', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-inst-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  process.env.C8CTL_NANO_HOME = HOME;
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // Idle `work` stand-in that records its own argv (keyed by pid) so we can prove
  // each spawned child got the forwarded work flag and NOT `--instances`.
  const workArgvDir = join(HOME, 'work-argv');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { recordArgv: true, workArgvDir });
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

  // Drive the real CLI handler path: `supervisor add faker --instances 3 --job-timeout 600000`.
  const req = { subcommand: 'supervisor', positional: ['add', 'faker'] };
  await mod.supervisorAddCmd(req, { instances: '3', 'job-timeout': '600000' });

  // Three distinct workers, all running the `faker` profile, each auto-named.
  let workers = [];
  for (let i = 0; i < 30; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    workers = s.workers;
    if (workers.length === 3 && workers.every((w) => w.state === 'running' && w.pid)) break;
    await sleep(100);
  }
  assert.equal(workers.length, 3, 'should have spawned exactly 3 workers');
  const ids = workers.map((w) => w.id);
  assert.equal(new Set(ids).size, 3, `worker ids must be distinct: ${JSON.stringify(ids)}`);
  for (const w of workers) {
    assert.equal(w.profile, 'faker');
    assert.match(w.id, /^[a-z0-9._-]+-faker-[0-9a-f]+$/, `auto-named id expected, got ${w.id}`);
  }

  // Every child got the forwarded `--job-timeout 600000` and its `--name <id>`, but
  // never the `--instances` flag (that is consumed by the CLI, not `nano work`).
  for (const w of workers) {
    const childArgv = await readChildArgv(workArgvDir, w.pid);
    assert.ok(childArgv, `child argv for ${w.id} should be recorded`);
    assert.deepEqual(childArgv.slice(0, 3), ['nano', 'work', 'faker']);
    assert.ok(!childArgv.includes('--instances'), `child must not receive --instances: ${JSON.stringify(childArgv)}`);
    const jt = childArgv.indexOf('--job-timeout');
    assert.ok(jt !== -1 && childArgv[jt + 1] === '600000', `child should carry --job-timeout 600000: ${JSON.stringify(childArgv)}`);
    const nameIdx = childArgv.indexOf('--name');
    assert.ok(nameIdx !== -1 && childArgv[nameIdx + 1] === w.id, 'child --name should equal its supervisor id');
  }

  await mod.supervisorRequest({ op: 'stop' });
});

// A tiny streaming stop client: opens the control socket, sends `{op:'stop'}`
// (optionally forced), and collects every decoded frame until the terminal
// `stopped` frame (or the socket closes). Returns the frames so a test can
// assert on the drain progress + terminal frame the daemon streamed.
async function stopStream(mod, { force = false, sendAfter = null } = {}) {
  const socketPath = mod.getSupervisorSocketPath();
  const { encodeFrame, decodeFrames } = mod;
  return await new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const frames = [];
    let buf = '';
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.end(); } catch {} resolve(frames); };
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(encodeFrame({ op: 'stop', force }));
      if (sendAfter) setTimeout(() => { try { sock.write(encodeFrame(sendAfter)); } catch {} }, 150);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const { frames: fr, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of fr) { frames.push(f); if (f && (f.type === 'stopped' || f.final)) finish(); }
    });
    sock.on('close', () => finish());
    sock.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

async function bootBusyDaemon(t, { drainMs = 300 } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-drain-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  const prevMon = process.env.NANO_SUPERVISOR_MONITOR_MS;
  process.env.C8CTL_NANO_HOME = HOME;
  process.env.NANO_SUPERVISOR_MONITOR_MS = '80'; // keep status broadcasts prompt
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));
  const sigFile = join(HOME, 'worker-signal.txt');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { busy: { drainMs, sigFile } });
  process.env.C8CTL_NANO_ENTRY = shim;
  const mod = await import(pluginUrl);
  t.after(async () => {
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch {} }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    restoreEnv('NANO_SUPERVISOR_MONITOR_MS', prevMon);
    try { rmSync(HOME, { recursive: true, force: true }); } catch {}
  });
  const state = await mod.startSupervisorDaemon();
  assert.ok(state && state.pid, 'daemon should report a pid');
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker' });
  assert.equal(added.ok, true);
  // Wait until the busy worker reports its in-flight job.
  let inFlight = 0;
  for (let i = 0; i < 40 && inFlight === 0; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    inFlight = (s.workers || []).reduce((n, w) => n + (w.activity?.jobs?.length || 0), 0);
    if (inFlight === 0) await sleep(50);
  }
  assert.equal(inFlight, 1, 'the busy worker should report one in-flight job');
  return { mod, sigFile };
}

test('supervisor stop (default): drains in-flight work, then stops (issue #202)', async (t) => {
  const { mod, sigFile } = await bootBusyDaemon(t, { drainMs: 250 });
  const frames = await stopStream(mod, { force: false });
  // The daemon announced a DRAIN (not a hard stop) and ended with `stopped`.
  assert.ok(frames.some((f) => f && f.type === 'draining'), `expected a draining frame: ${JSON.stringify(frames)}`);
  assert.ok(frames.some((f) => f && f.type === 'stopped' && f.final), 'expected a terminal stopped frame');
  // The worker finished its job via the graceful drain signal — NOT a force kill.
  assert.ok(existsSync(sigFile), 'the worker should have recorded its stop signal');
  assert.equal(readFileSync(sigFile, 'utf8'), 'drained', 'the worker drained (SIGUSR2), not force-killed');
  // The daemon exited and cleared its state.
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) { if (!mod.runningSupervisor()) { stopped = true; break; } await sleep(50); }
  assert.ok(stopped, 'daemon should stop and clear its state after draining');
});

test('supervisor stop --force: aborts in-flight work immediately (issue #202)', async (t) => {
  const { mod, sigFile } = await bootBusyDaemon(t, { drainMs: 10_000 });
  const frames = await stopStream(mod, { force: true });
  assert.ok(frames.some((f) => f && f.type === 'stopping' && f.force), `expected a forced stopping frame: ${JSON.stringify(frames)}`);
  assert.ok(frames.some((f) => f && f.type === 'stopped' && f.final), 'expected a terminal stopped frame');
  assert.equal(readFileSync(sigFile, 'utf8'), 'forced', 'the worker was force-aborted (SIGTERM)');
});

test('supervisor stop: a force request escalates an in-progress drain (issue #202)', async (t) => {
  const { mod, sigFile } = await bootBusyDaemon(t, { drainMs: 10_000 });
  // Start a drain (which would otherwise wait ~10s), then escalate with force.
  const frames = await stopStream(mod, { force: false, sendAfter: { op: 'stop', force: true } });
  assert.ok(frames.some((f) => f && f.type === 'draining'), 'drain started first');
  assert.ok(frames.some((f) => f && f.type === 'stopped' && f.final), 'the escalated stop completed');
  assert.equal(readFileSync(sigFile, 'utf8'), 'forced', 'the escalation force-aborted the draining worker');
});

test('supervisor remove (force:false): drains a worker without killing it (issue #202)', async (t) => {
  const { mod, sigFile } = await bootBusyDaemon(t, { drainMs: 200 });
  const before = await mod.supervisorRequest({ op: 'status' });
  const id = before.workers[0].id;
  // Drain-remove: the daemon acks immediately; the worker finishes its job and
  // then disappears from status once it exits.
  const res = await mod.supervisorRequest({ op: 'remove', target: id, force: false });
  assert.equal(res.ok, true);
  assert.equal(res.draining, true, 'a force:false remove is a drain');
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    gone = !(s.workers || []).some((w) => w.id === id);
    if (!gone) await sleep(50);
  }
  assert.ok(gone, 'the drained worker should be removed from status');
  assert.equal(readFileSync(sigFile, 'utf8'), 'drained', 'the worker drained (SIGUSR2), not force-killed');
  // The daemon itself stays up (only the worker was removed).
  assert.ok(mod.runningSupervisor(), 'the daemon should keep running after a drain-remove');
  await mod.supervisorRequest({ op: 'stop', force: true });
});
