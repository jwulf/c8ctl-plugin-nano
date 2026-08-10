// Integration test for the supervisor daemon lifecycle: it spawns the real
// detached daemon, drives it over the control socket, and verifies add /
// status / remove / stop end-to-end — without a broker. A fake "c8ctl entry"
// shim stands in for the CLI: for `nano supervisor __daemon` it runs the real
// exported daemon; for `nano work <profile>` it is an idle worker stand-in
// (so no createClient/broker is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Read the argv a shim child recorded for a given pid (best effort — the file
// is written on the child's first tick after spawn, so retry with real delays).
async function readChildArgv(dir, pid) {
  for (let i = 0; i < 30; i++) {
    try { return JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')); } catch { /* not yet */ }
    // Fall back to scanning the dir in case the reported pid differs.
    try {
      const files = readdirSync(dir);
      if (files.length) return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
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
  writeFileSync(shim, [
    `import { writeFileSync, mkdirSync } from 'node:fs';`,
    `import { join } from 'node:path';`,
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  try { mkdirSync(${JSON.stringify(workArgvDir)}, { recursive: true }); ` +
    `writeFileSync(join(${JSON.stringify(workArgvDir)}, process.pid + '.json'), JSON.stringify(argv)); } catch {}`,
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

  // Add a worker and confirm it comes up running. With no explicit name the
  // daemon auto-assigns ‹short-host›-‹profile›-‹random›; the profile is still
  // `faker` (that's the hire it runs).
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker', args: ['--max-parallel', '1'] });
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
  writeFileSync(shim, [
    `import { writeFileSync, mkdirSync } from 'node:fs';`,
    `import { join } from 'node:path';`,
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'nano' && argv[1] === 'supervisor' && argv[2] === '__daemon') {`,
    `  const mod = await import(${JSON.stringify(pluginUrl)});`,
    `  await mod.runSupervisorDaemon();`,
    `} else if (argv[0] === 'nano' && argv[1] === 'work') {`,
    `  try { mkdirSync(${JSON.stringify(workArgvDir)}, { recursive: true }); ` +
    `writeFileSync(join(${JSON.stringify(workArgvDir)}, process.pid + '.json'), JSON.stringify(argv)); } catch {}`,
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

  // Drive the real CLI handler path: `supervisor add faker --instances 3 --max-parallel 2`.
  const req = { subcommand: 'supervisor', positional: ['add', 'faker'] };
  await mod.supervisorAddCmd(req, { instances: '3', 'max-parallel': '2' });

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

  // Every child got the forwarded `--max-parallel 2` and its `--name <id>`, but
  // never the `--instances` flag (that is consumed by the CLI, not `nano work`).
  for (const w of workers) {
    const childArgv = await readChildArgv(workArgvDir, w.pid);
    assert.ok(childArgv, `child argv for ${w.id} should be recorded`);
    assert.deepEqual(childArgv.slice(0, 3), ['nano', 'work', 'faker']);
    assert.ok(!childArgv.includes('--instances'), `child must not receive --instances: ${JSON.stringify(childArgv)}`);
    const mp = childArgv.indexOf('--max-parallel');
    assert.ok(mp !== -1 && childArgv[mp + 1] === '2', `child should carry --max-parallel 2: ${JSON.stringify(childArgv)}`);
    const nameIdx = childArgv.indexOf('--name');
    assert.ok(nameIdx !== -1 && childArgv[nameIdx + 1] === w.id, 'child --name should equal its supervisor id');
  }

  await mod.supervisorRequest({ op: 'stop' });
});
