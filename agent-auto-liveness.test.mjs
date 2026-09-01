// Liveness integration test for `nano work --auto` (jwulf/c8ctl-plugin-nano#93).
//
// Secondary defect: when the INITIAL `--auto` engine read fails (no engine yet,
// or a transient miss) the worker registers 0 pollers and must STAY ALIVE to
// retry "on the next poll" — as its own warning promises. Before the fix the
// `--auto` poll timer was `unref()`'d like the hygiene timers, so with zero
// pollers nothing held the event loop open and the process exited 0 → a
// supervisor restart loop (down / exit 0 / restart, forever).
//
// This drives the REAL exported `workAgent` in a child process with a stubbed
// c8ctl runtime and the visibility channel off, so the ONLY thing that can keep
// the process alive with 0 pollers is the (now REF'd) `--auto` poll timer. The
// engine read is pointed at a dead 127.0.0.1 port, so the initial read fails
// deterministically and the worker takes the 0-poller path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// A dependency-free harness that injects a fake c8ctl runtime (createClient +
// getLogger) and drives the real exported `workAgent` in `--auto` mode. The
// fake client's profile REST address points at a dead port so the initial
// engine read fails; NANO_AGENTIC=off keeps the visibility channel out of the
// picture, so liveness is governed solely by the `--auto` poll timer.
function harnessSource(deadPort) {
  return [
    `globalThis.c8ctl = {`,
    `  createClient: () => ({`,
    `    getConfig: () => ({ restAddress: 'http://127.0.0.1:${deadPort}/v2' }),`,
    `    getAuthHeaders: async () => ({}),`,
    `  }),`,
    `  getLogger: () => ({`,
    `    info: (...a) => console.log(...a),`,
    `    warn: (...a) => console.log(...a),`,
    `    error: (...a) => console.error(...a),`,
    `    debug: () => {},`,
    `    output: (m) => process.stdout.write(String(m) + '\\n'),`,
    `  }),`,
    `};`,
    `const mod = await import(${JSON.stringify(pluginUrl)});`,
    `// Not awaited: workAgent resolves only on a stop signal. If the process`,
    `// stays alive, the (ref'd) --auto poll timer is doing its job.`,
    `mod.workAgent({ positional: ['faker'] }, { auto: true });`,
  ].join('\n');
}

test('nano work --auto: a failed INITIAL engine read keeps the worker alive (no exit 0 crash-loop)', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-auto-live-'));
  t.after(() => rmSync(HOME, { recursive: true, force: true }));

  // A valid hire so workAgent gets past profile validation into the poll loop.
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  // Point the worker's engine read at a CLOSED ephemeral port: bind one to learn
  // a free port number, then close it so the port has no listener. Connecting
  // there fails with a kernel-level ECONNREFUSED in microseconds, deterministically
  // and independent of any userland event loop — which also faithfully models the
  // common real scenario the worker must survive: "no engine listening yet".
  //
  // The earlier design (a listening server whose connection handler calls
  // `sock.destroy()`) was subtly load-dependent and flaky in CI: the destroy
  // callback runs in THIS (parent) process's event loop, so while the parent is
  // busy running the rest of the suite in parallel the kernel still completes the
  // TCP handshake and the child's fetch connects and then blocks waiting for a
  // response that never comes — stalling the engine read until its 15s timeout
  // (which equals this test's own observation window) and starving the assertion
  // of any output. A refused connection removes the parent from the failure path
  // entirely. A fixed well-known port is avoided because it can actually be
  // listening and skip the failure path.
  const portFinder = createServer();
  await new Promise((resolve) => portFinder.listen(0, '127.0.0.1', resolve));
  const deadPort = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));

  const harness = join(HOME, 'harness.mjs');
  writeFileSync(harness, harnessSource(deadPort));

  const child = spawn(process.execPath, [harness], {
    env: (() => {
      const e = { ...process.env };
      // This test process may itself run under the nano supervisor, which sets
      // NANO_SUPERVISOR_* — those would arm the child's parent-death watchdog and
      // make it self-exit. Scrub them so the child's liveness is governed solely
      // by the `--auto` poll timer under test.
      delete e.NANO_SUPERVISOR_ACTIVITY_FILE;
      delete e.NANO_SUPERVISOR_DAEMON_PID;
      e.C8CTL_NANO_HOME = HOME;
      e.NANO_AGENTIC = 'off';
      // Avoid the gh-CLI auth spawn taking a real path during the test.
      e.GITHUB_TOKEN = 'test-token';
      return e;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });

  t.after(() => { try { if (exit === null) child.kill('SIGKILL'); } catch { /* ignore */ } });

  // Wait for the worker to reach the poll loop ("Polling for work" is the last
  // startup line before the keepalive; it implies 0 pollers were registered).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !/Polling for work/.test(out) && exit === null) {
    await sleep(100);
  }

  assert.match(out, /--auto: initial engine read failed/, 'the initial engine read should have failed');
  assert.match(out, /listening on 0 job type\(s\)/, 'the worker should register 0 pollers');
  assert.match(out, /Polling for work/, 'the worker should enter the poll loop');
  assert.equal(exit, null, 'the worker must NOT have exited after the failed initial read');

  // Survive well past when the buggy (unref'd-timer) build would have exited 0.
  await sleep(1_500);
  assert.equal(exit, null, 'a --auto worker with 0 pollers must stay alive to retry on the next poll');

  // A stop signal still shuts it down cleanly (the ref'd timer is cleared).
  child.kill('SIGTERM');
  const stopBy = Date.now() + 10_000;
  while (Date.now() < stopBy && exit === null) await sleep(50);
  assert.notEqual(exit, null, 'SIGTERM should shut the worker down');
});
