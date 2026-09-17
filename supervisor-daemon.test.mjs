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

// Extract the `--name <id>` value from a recorded argv array (null if absent).
function argvName(argv) {
  if (!Array.isArray(argv)) return null;
  const i = argv.indexOf('--name');
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Read the argv a shim child recorded for a given pid. The file is written on
// the child's first tick after spawn (atomically — temp + rename), so a present
// file is always complete; we poll until it appears.
//
// Under full-suite concurrency several children spawn at once and their argv
// files land staggered, so a pid-keyed read can miss and a naive "scan the dir"
// fallback could return a *different* worker's argv (tripping the `--name`
// assertion). To stay race-free we key on the worker's stable identity: pass
// `expectedId` and we only ever return a record whose `--name` matches it — the
// exact-pid file is preferred, but a scan fallback also validates identity so a
// slow/pid-drifted child is never confused with a sibling. `expectedId` is
// optional; without it (single-child callers) we keep the single-file fallback.
async function readChildArgv(dir, pid, expectedId = null) {
  for (let i = 0; i < 60; i++) {
    // Preferred: the child's own pid-keyed record. Accept it only if it matches
    // the expected identity (guards against stale/pid-reused files).
    try {
      const rec = JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8'));
      if (expectedId == null || argvName(rec) === expectedId) return rec;
    } catch { /* not yet */ }
    // Fallback: scan the dir. With an expected id, return the record whose
    // `--name` matches it (never a sibling's argv). Without one, fall back to
    // the sole recorded child only (the single-worker callers).
    try {
      const files = readdirSync(dir);
      if (expectedId != null) {
        for (const f of files) {
          try {
            const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            if (argvName(rec) === expectedId) return rec;
          } catch { /* partial/absent — skip */ }
        }
      } else if (files.length === 1) {
        return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      }
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
      `import { writeFileSync, mkdirSync, renameSync } from 'node:fs';`,
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
      `const dst = join(${JSON.stringify(workArgvDir)}, process.pid + '.json'); ` +
      `const tmp = dst + '.' + process.pid + '.tmp'; ` +
      `writeFileSync(tmp, JSON.stringify(argv)); renameSync(tmp, dst); } catch {}`,
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
    const { drainMs = 300, sigFile, notReady = false } = busy;
    // A `notReady` stand-in stamps NO `readyAt`, modelling a replacement whose
    // activation loop never comes up — the supervisor's rolling-reload readiness
    // gate must then advance on its bounded timeout rather than wedge the roll.
    const marker = notReady
      ? `{ pid: process.pid, jobs: [{ key: 'J1', type: 'faker:senior', since: Date.now() }] }`
      : `{ pid: process.pid, readyAt: Date.now(), jobs: [{ key: 'J1', type: 'faker:senior', since: Date.now() }] }`;
    lines.push(
      `  const { writeFileSync: wf, rmSync: rm, mkdirSync: mk } = await import('node:fs');`,
      `  const { dirname } = await import('node:path');`,
      `  const actFile = process.env.NANO_SUPERVISOR_ACTIVITY_FILE;`,
      `  try { mk(dirname(actFile), { recursive: true }); wf(actFile, JSON.stringify(${marker})); } catch {}`,
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
      // Stamp a ready activity marker so the supervisor's rolling-reload readiness
      // gate (`waitForWorkerReady`) resolves at once for this idle stand-in instead
      // of waiting out the bounded timeout — the real worker stamps `readyAt` once
      // its activation loop is up.
      `  try { const { writeFileSync: rwf, mkdirSync: rmk } = await import('node:fs'); const { dirname: rdn } = await import('node:path'); const raf = process.env.NANO_SUPERVISOR_ACTIVITY_FILE; if (raf) { rmk(rdn(raf), { recursive: true }); rwf(raf, JSON.stringify({ pid: process.pid, readyAt: Date.now(), jobs: [] })); } } catch {}`,
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
  const childArgv = await readChildArgv(workArgvDir, added.worker.pid, added.worker.id);
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

test('supervisor start forwards c8ctl --profile <conn> to spawned workers', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-prof-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  const prevC8ctl = globalThis.c8ctl;
  process.env.C8CTL_NANO_HOME = HOME;

  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // The `work` stand-in records its own argv so we can prove `supervisor start`
  // threads the ctx `--profile` override all the way into the spawned child.
  const workArgvDir = join(HOME, 'work-argv');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { recordArgv: true, workArgvDir });
  process.env.C8CTL_NANO_ENTRY = shim;

  // Drive the REAL `supervisor start` handler (not just `withConnectionProfileArg`
  // in isolation): it must thread the handler ctx's global `--profile <conn>`
  // override (distinct from the active session profile) through
  // `reconstructWorkArgs`/`withConnectionProfileArg` into the child argv the
  // daemon spawns (jwulf/c8ctl-plugin-nano#189). A quiet logger keeps the suite
  // output clean; the active profile is set to something the override DIFFERS
  // from, so the forward is a genuine per-invocation pin — not a spurious echo.
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, output() {} };
  globalThis.c8ctl = { activeProfile: 'local', getLogger: () => quiet };

  const mod = await import(pluginUrl);

  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    if (prevC8ctl === undefined) delete globalThis.c8ctl; else globalThis.c8ctl = prevC8ctl;
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Pre-start the daemon so the handler's service policy adopts it (Linux path).
  const state = await mod.startSupervisorDaemon();
  assert.ok(state && state.pid, 'daemon should report a pid');

  // `req` is unused by supervisorStartCmd; `flags` carry the worker spec + name,
  // `ctx` carries the global connection-profile override.
  await mod.supervisorStartCmd(
    {},
    { worker: 'faker', name: 'faker-pin' },
    { profile: 'nano-validate' },
  );

  // The named worker should come up running.
  let worker = null;
  for (let i = 0; i < 30 && !worker; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    worker = (s.workers || []).find((w) => w.id === 'faker-pin' && w.state === 'running' && w.pid) || null;
    if (!worker) await sleep(100);
  }
  assert.ok(worker, 'supervisor start should launch the named worker');

  // The child the daemon spawned must carry the forwarded `--profile <conn>`.
  const childArgv = await readChildArgv(workArgvDir, worker.pid, 'faker-pin');
  assert.ok(childArgv, 'the child should have recorded its argv');
  assert.deepEqual(childArgv.slice(0, 3), ['nano', 'work', 'faker'], 'child runs the positional profile');
  const pIdx = childArgv.indexOf('--profile');
  assert.ok(pIdx !== -1, `child argv should forward --profile: ${JSON.stringify(childArgv)}`);
  assert.equal(childArgv[pIdx + 1], 'nano-validate', 'the forwarded --profile must be the ctx override');
});

test('supervisor add forwards c8ctl --profile <conn> to spawned workers', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-addprof-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  const prevC8ctl = globalThis.c8ctl;
  process.env.C8CTL_NANO_HOME = HOME;

  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // The `work` stand-in records its own argv so we can prove `supervisor add`
  // threads the ctx `--profile` override all the way into the spawned child.
  const workArgvDir = join(HOME, 'work-argv');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { recordArgv: true, workArgvDir });
  process.env.C8CTL_NANO_ENTRY = shim;

  // Drive the REAL `supervisor add` handler (not just `withConnectionProfileArg`
  // in isolation): `supervisorAddCmd` is a SEPARATE public path from
  // `supervisorStartCmd`, so it must independently thread the handler ctx's
  // global `--profile <conn>` override (distinct from the active session
  // profile) through `reconstructWorkArgs`/`withConnectionProfileArg` into the
  // child argv the daemon spawns (jwulf/c8ctl-plugin-nano#189). The active
  // profile is set to something the override DIFFERS from, so the forward is a
  // genuine per-invocation pin — not a spurious echo.
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, output() {} };
  globalThis.c8ctl = { activeProfile: 'local', getLogger: () => quiet };

  const mod = await import(pluginUrl);

  t.after(async () => {
    try { await mod.supervisorRequest({ op: 'stop' }); } catch { /* ignore */ }
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } }
    mod.clearSupervisorState();
    if (prevC8ctl === undefined) delete globalThis.c8ctl; else globalThis.c8ctl = prevC8ctl;
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Pre-start the daemon so the handler's service policy adopts it (Linux path).
  const state = await mod.startSupervisorDaemon();
  assert.ok(state && state.pid, 'daemon should report a pid');

  // `req.positional[1]` is the profile that runs; `flags.name` names this
  // worker; `ctx.profile` carries the global connection-profile override.
  await mod.supervisorAddCmd(
    { subcommand: 'supervisor', positional: ['add', 'faker'] },
    { name: 'faker-pin' },
    { profile: 'nano-validate' },
  );

  // The named worker should come up running.
  let worker = null;
  for (let i = 0; i < 30 && !worker; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    worker = (s.workers || []).find((w) => w.id === 'faker-pin' && w.state === 'running' && w.pid) || null;
    if (!worker) await sleep(100);
  }
  assert.ok(worker, 'supervisor add should launch the named worker');

  // The child the daemon spawned must carry the forwarded `--profile <conn>`.
  const childArgv = await readChildArgv(workArgvDir, worker.pid, 'faker-pin');
  assert.ok(childArgv, 'the child should have recorded its argv');
  assert.deepEqual(childArgv.slice(0, 3), ['nano', 'work', 'faker'], 'child runs the positional profile');
  const pIdx = childArgv.indexOf('--profile');
  assert.ok(pIdx !== -1, `child argv should forward --profile: ${JSON.stringify(childArgv)}`);
  assert.equal(childArgv[pIdx + 1], 'nano-validate', 'the forwarded --profile must be the ctx override');
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
    const childArgv = await readChildArgv(workArgvDir, w.pid, w.id);
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

async function bootBusyDaemon(t, { drainMs = 300, notReady = false, readyTimeoutMs = null } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-sup-drain-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  const prevEntry = process.env.C8CTL_NANO_ENTRY;
  const prevMon = process.env.NANO_SUPERVISOR_MONITOR_MS;
  const prevReadyTimeout = process.env.NANO_SUPERVISOR_RELOAD_READY_TIMEOUT_MS;
  process.env.C8CTL_NANO_HOME = HOME;
  process.env.NANO_SUPERVISOR_MONITOR_MS = '80'; // keep status broadcasts prompt
  // The reload readiness timeout is read at plugin load in the spawned daemon,
  // which inherits this env — set it BEFORE startSupervisorDaemon so a never-ready
  // replacement's bounded wait is short in the test.
  if (readyTimeoutMs != null) process.env.NANO_SUPERVISOR_RELOAD_READY_TIMEOUT_MS = String(readyTimeoutMs);
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));
  const sigFile = join(HOME, 'worker-signal.txt');
  const shim = join(HOME, 'fake-entry.mjs');
  writeShim(shim, { busy: { drainMs, sigFile, notReady } });
  process.env.C8CTL_NANO_ENTRY = shim;
  const mod = await import(pluginUrl);
  t.after(async () => {
    const st = mod.runningSupervisor();
    if (st) { try { process.kill(st.pid, 'SIGKILL'); } catch {} }
    mod.clearSupervisorState();
    restoreEnv('C8CTL_NANO_ENTRY', prevEntry);
    restoreEnv('C8CTL_NANO_HOME', prevHome);
    restoreEnv('NANO_SUPERVISOR_MONITOR_MS', prevMon);
    restoreEnv('NANO_SUPERVISOR_RELOAD_READY_TIMEOUT_MS', prevReadyTimeout);
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

// A tiny streaming reload client: opens the control socket, sends `{op:'reload'}`
// (with a target token or targets array), and collects every decoded frame
// until the terminal `reloaded` frame (or the socket closes). Returns the frames
// so a test can assert on the rolling progress + terminal frame.
async function reloadStream(mod, { target = 'all', targets = null } = {}) {
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
      sock.write(encodeFrame(targets ? { op: 'reload', targets } : { op: 'reload', target }));
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const { frames: fr, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of fr) { frames.push(f); if (f && (f.type === 'reloaded' || f.final)) finish(); }
    });
    sock.on('close', () => finish());
    sock.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

test('supervisor reload: gracefully drains and respawns a worker to adopt new code', async (t) => {
  const { mod, sigFile } = await bootBusyDaemon(t, { drainMs: 150 });
  const before = await mod.supervisorRequest({ op: 'status' });
  assert.equal(before.workers.length, 1);
  const id = before.workers[0].id;
  const oldPid = before.workers[0].pid;

  const frames = await reloadStream(mod, { target: 'all' });
  // The daemon announced a rolling reload and ended with a terminal frame that
  // lists the reloaded worker.
  assert.ok(frames.some((f) => f && f.type === 'reloading'), `expected a reloading frame: ${JSON.stringify(frames)}`);
  const term = frames.find((f) => f && f.type === 'reloaded' && f.final);
  assert.ok(term, 'expected a terminal reloaded frame');
  assert.deepEqual(term.reloaded, [id], 'the terminal frame should list the reloaded worker');

  // The worker adopted new code by DRAINING (SIGUSR2 — finished its job), never
  // a force kill.
  assert.equal(readFileSync(sigFile, 'utf8'), 'drained', 'the worker drained (SIGUSR2), not force-killed');

  // Exactly one worker remains (no leaked duplicate), with a NEW pid (respawned
  // → re-read the plugin from disk) and restarts still 0 (a reload is not a
  // crash-restart).
  let after = null;
  for (let i = 0; i < 40; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 1 && s.workers[0].state === 'running' && s.workers[0].pid && s.workers[0].pid !== oldPid) { after = s.workers[0]; break; }
    await sleep(50);
  }
  assert.ok(after, 'the worker should be running again under a new pid after reload');
  assert.equal(after.id, id, 'the worker keeps its id across a reload');
  assert.equal(after.restarts, 0, 'a reload must not be counted as a crash-restart');

  // The daemon itself stays up and its state file is intact — a reload is not a
  // stop.
  assert.ok(mod.runningSupervisor(), 'the daemon should keep running after a reload');
  await mod.supervisorRequest({ op: 'stop', force: true });
});

test('supervisor reload: rolls the whole fleet, giving every worker a fresh pid', async (t) => {
  const { mod } = await bootBusyDaemon(t, { drainMs: 120 });
  // Add a second busy worker so the reload is a genuine rolling pass.
  const added = await mod.supervisorRequest({ op: 'add', profile: 'faker' });
  assert.equal(added.ok, true);
  // Wait for both to be running.
  let before = [];
  for (let i = 0; i < 40; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 2 && s.workers.every((w) => w.state === 'running' && w.pid)) { before = s.workers; break; }
    await sleep(50);
  }
  assert.equal(before.length, 2, 'two workers should be running before reload');
  const oldPids = new Map(before.map((w) => [w.id, w.pid]));

  const frames = await reloadStream(mod, { target: 'all' });
  const term = frames.find((f) => f && f.type === 'reloaded' && f.final);
  assert.ok(term, 'expected a terminal reloaded frame');
  assert.equal(term.reloaded.length, 2, 'both workers should have been reloaded');

  // Both workers survive (count unchanged) with fresh pids.
  let after = [];
  for (let i = 0; i < 60; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 2 && s.workers.every((w) => w.state === 'running' && w.pid && w.pid !== oldPids.get(w.id))) { after = s.workers; break; }
    await sleep(50);
  }
  assert.equal(after.length, 2, 'exactly two workers after a fleet reload (no leaks)');
  for (const w of after) {
    assert.notEqual(w.pid, oldPids.get(w.id), `worker ${w.id} should have a new pid after reload`);
    assert.equal(w.restarts, 0, 'reload is not a crash-restart');
  }
  await mod.supervisorRequest({ op: 'stop', force: true });
});

test('supervisor reload: a never-ready replacement does not wedge the roll (bounded readiness gate)', async (t) => {
  // The replacement never stamps `readyAt`, so the readiness gate can only clear
  // on its bounded timeout — set short here. The roll must still finish, listing
  // the worker as reloaded (it advanced anyway), not hang forever.
  const { mod } = await bootBusyDaemon(t, { drainMs: 100, notReady: true, readyTimeoutMs: 300 });
  const before = await mod.supervisorRequest({ op: 'status' });
  assert.equal(before.workers.length, 1);
  const id = before.workers[0].id;
  const oldPid = before.workers[0].pid;

  const started = Date.now();
  const frames = await reloadStream(mod, { target: 'all' });
  const elapsed = Date.now() - started;
  const term = frames.find((f) => f && f.type === 'reloaded' && f.final);
  assert.ok(term, 'expected a terminal reloaded frame even when the replacement never reports ready');
  assert.deepEqual(term.reloaded, [id], 'the never-ready worker still counts as reloaded (advanced on timeout)');
  // The bounded gate means the roll completes near the readiness timeout, not
  // indefinitely — generously bounded to stay robust on a slow CI box.
  assert.ok(elapsed < 8000, `reload should complete on the bounded timeout, took ${elapsed}ms`);

  // The worker was genuinely respawned (new pid), just never signalled ready.
  let after = null;
  for (let i = 0; i < 40; i++) {
    const s = await mod.supervisorRequest({ op: 'status' });
    if (s.workers.length === 1 && s.workers[0].state === 'running' && s.workers[0].pid && s.workers[0].pid !== oldPid) { after = s.workers[0]; break; }
    await sleep(50);
  }
  assert.ok(after, 'the worker should be respawned under a new pid even without a readiness signal');
  assert.ok(mod.runningSupervisor(), 'the daemon should keep running after a bounded-timeout reload');
  await mod.supervisorRequest({ op: 'stop', force: true });
});

test('supervisor status: surfaces the on-disk plugin version', async (t) => {
  const { mod } = await bootBusyDaemon(t, { drainMs: 120 });
  const s = await mod.supervisorRequest({ op: 'status' });
  assert.ok(s.ok, 'status should succeed');
  assert.ok(typeof s.pluginVersion === 'string' && s.pluginVersion.length > 0, 'status frame carries the on-disk plugin version');
  assert.equal(s.pluginVersion, s.daemon.version, 'with no update on disk the running daemon and on-disk versions match');
  await mod.supervisorRequest({ op: 'stop', force: true });
});
