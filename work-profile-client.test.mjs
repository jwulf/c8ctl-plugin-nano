// Integration test for `nano work` honouring c8ctl's global `--profile <name>`
// at the REAL `createClient` call site (jwulf/c8ctl-plugin-nano#189).
//
// The unit tests in supervisor.test.mjs cover `resolveConnectionProfile` in
// isolation, but nothing there drives `workAgent` with a non-active handler
// `ctx.profile` and observes the argument actually handed to `createClient`.
// A regression that dropped the `createClient(resolveConnectionProfile(ctx))`
// wiring — reverting to a no-arg `createClient()` — would still pass those unit
// tests. This closes that gap: it drives the REAL exported `workAgent` in a
// child process with a stubbed c8ctl runtime whose `createClient` records the
// profile argument it was called with, and asserts the ctx override reached it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// A dependency-free harness: injects a fake c8ctl runtime whose `createClient`
// prints the argument it received (with a stable marker) the moment `workAgent`
// calls it, then drives the real exported `workAgent` with a handler `ctx`
// carrying a `--profile` override. The returned client is a minimal stub —
// enough for `workAgent` to proceed past client creation — and the marker line
// is all the test needs, so it kills the child once it appears.
function harnessSource(ctxJson) {
  return [
    `globalThis.c8ctl = {`,
    `  activeProfile: 'local',`,
    `  createClient: (profile) => {`,
    `    process.stdout.write('CREATE_CLIENT_PROFILE:' + JSON.stringify(profile ?? null) + '\\n');`,
    `    return {`,
    `      getConfig: () => ({ restAddress: 'http://127.0.0.1:1/v2' }),`,
    `      getAuthHeaders: async () => ({}),`,
    `    };`,
    `  },`,
    `  getLogger: () => ({`,
    `    info: (...a) => console.log(...a),`,
    `    warn: (...a) => console.log(...a),`,
    `    error: (...a) => console.error(...a),`,
    `    debug: () => {},`,
    `    output: (m) => process.stdout.write(String(m) + '\\n'),`,
    `  }),`,
    `};`,
    `const mod = await import(${JSON.stringify(pluginUrl)});`,
    `// Not awaited: workAgent resolves only on a stop signal. We only need to`,
    `// observe the createClient argument, which happens during startup.`,
    `mod.workAgent({ positional: ['faker'] }, {}, ${JSON.stringify(ctxJson)});`,
  ].join('\n');
}

async function runAndCaptureProfileArg(t, ctxJson) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-work-prof-'));
  t.after(() => rmSync(HOME, { recursive: true, force: true }));

  // A valid hire so workAgent gets past profile validation to the client call.
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: { faker: { name: 'faker', rank: 'senior', command: 'true', model: '', capabilities: [] } },
  }));

  const harness = join(HOME, 'harness.mjs');
  writeFileSync(harness, harnessSource(ctxJson));

  const child = spawn(process.execPath, [harness], {
    env: (() => {
      const e = { ...process.env };
      // Scrub supervisor markers so the child isn't reaped by a parent-death
      // watchdog before it reaches the client call.
      delete e.NANO_SUPERVISOR_ACTIVITY_FILE;
      delete e.NANO_SUPERVISOR_DAEMON_PID;
      e.C8CTL_NANO_HOME = HOME;
      e.NANO_AGENTIC = 'off';
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

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/CREATE_CLIENT_PROFILE:/.test(out) && exit === null) {
    await sleep(100);
  }

  // Stop the worker now that we have (or timed out waiting for) the marker.
  try { child.kill('SIGTERM'); } catch { /* ignore */ }

  const m = out.match(/CREATE_CLIENT_PROFILE:(.*)/);
  assert.ok(m, `createClient should have been called; output:\n${out}`);
  return JSON.parse(m[1]);
}

test('nano work: a non-active ctx.profile is threaded into createClient()', async (t) => {
  const arg = await runAndCaptureProfileArg(t, { profile: 'nano-validate' });
  assert.equal(arg, 'nano-validate', 'the --profile override must reach createClient');
});

test('nano work: no ctx profile leaves createClient() at its active-profile default', async (t) => {
  // ctx-less (undefined) → createClient(undefined), which resolves the active
  // profile itself — byte-identical to the old no-arg call.
  const arg = await runAndCaptureProfileArg(t, {});
  assert.equal(arg, null, 'an absent ctx.profile must not pin createClient to a profile');
});
