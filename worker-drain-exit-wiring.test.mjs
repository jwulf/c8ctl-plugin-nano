// Issue #339 (review follow-up): drive the REAL `workAgent` wiring against a fake
// engine (raw /v2/jobs HTTP) with a fake c8ctl SDK that exposes the AgentInstance
// verbs, an in-flight agent job, and a leaked ref'd handle. On SIGUSR2 the worker
// must SETTLE the in-flight job (POST /completion) and then EXIT — the backstop
// force-exits despite the leftover handle.
import './test-support/hermetic-service.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('real worker wiring: SIGUSR2 drain settles the in-flight job, then exits despite a leaked handle',
  { skip: process.platform === 'win32' && 'POSIX SIGUSR2 cannot be delivered gracefully on Windows' }, async (t) => {
    const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-drain-wiring-'));
    t.after(() => rmSync(HOME, { recursive: true, force: true }));
    const events = [];
    let served = false;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const url = req.url || '';
        if (url.endsWith('/jobs/activation')) {
          if (served) {
            // Long-poll returning nothing (the drain interrupts it).
            setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jobs":[]}'); }, 200);
            return;
          }
          served = true;
          let type = 'senior';
          try { type = JSON.parse(body).type || type; } catch { /* default */ }
          events.push('activated');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobs: [{
            jobKey: '9001', type, processInstanceKey: '1', elementInstanceKey: '2', elementId: 'task',
            processDefinitionKey: '3', bpmnProcessId: 'p', processDefinitionVersion: 1,
            retries: 3, deadline: Date.now() + 600000, worker: 'w', tenantId: '<default>',
            customHeaders: {}, variables: { prompt: 'hello' },
          }] }));
          return;
        }
        if (/\/jobs\/9001\/completion$/.test(url)) events.push('completed');
        else if (/\/jobs\/9001\/failure$/.test(url)) events.push('failed');
        res.writeHead(204); res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const port = server.address().port;

    // The harness: signals it started, runs ~1.5s, then writes a result.
    const harnessBin = join(HOME, 'harness.sh');
    writeFileSync(harnessBin, '#!/bin/sh\ncat >/dev/null\necho started >&2\nsleep 1.5\nprintf \'{"status":"done"}\' > "$AGENT_RESULT_FILE"\n');
    chmodSync(harnessBin, 0o755);
    writeFileSync(join(HOME, 'config.json'), JSON.stringify({
      hires: { faker: { name: 'faker', rank: 'senior', command: harnessBin, model: '', capabilities: [] } },
    }));
    const driver = join(HOME, 'driver.mjs');
    writeFileSync(driver, [
      `setInterval(() => {}, 1000); // leaked ref'd handle (e.g. a producer flush timer)`,
      `globalThis.c8ctl = {`,
      `  createClient: () => ({`,
      `    getConfig: () => ({ restAddress: 'http://127.0.0.1:${port}/v2' }),`,
      `    getAuthHeaders: async () => ({}),`,
      `    createAgentInstance: async () => { setInterval(() => {}, 1000); return { agentInstanceKey: '77' }; },`,
      `    updateAgentInstance: async () => ({}),`,
      `    createElementInstanceVariables: async () => ({}),`,
      `  }),`,
      `  getLogger: () => ({ info: (...a) => console.log(...a), warn: (...a) => console.log(...a),`,
      `    error: (...a) => console.error(...a), debug: () => {}, output: (m) => console.log(String(m)) }),`,
      `};`,
      `const mod = await import(${JSON.stringify(pluginUrl)});`,
      `await mod.workAgent({ positional: ['faker'] }, {});`,
    ].join('\n'));

    const env = { ...process.env, C8CTL_NANO_HOME: HOME, NANO_AGENTIC: 'off', GITHUB_TOKEN: 'test-token',
      NANO_SUPERVISOR_ACTIVITY_FILE: join(HOME, 'activity.json'), NANO_SUPERVISOR_DAEMON_PID: String(process.pid),
      NANO_WORKER_EXIT_BACKSTOP_MS: '500' };
    const child = spawn(process.execPath, [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exit = null;
    child.on('exit', (code, signal) => { exit = { code, signal }; });
    t.after(() => { if (exit === null) child.kill('SIGKILL'); });

    for (let end = Date.now() + 20_000; Date.now() < end && !events.includes('activated') && exit === null;) await sleep(50);
    assert.ok(events.includes('activated'), `job never activated:\n${out}`);
    await sleep(300); // harness is running
    child.kill('SIGUSR2');
    for (let end = Date.now() + 30_000; Date.now() < end && exit === null;) await sleep(50);
    assert.notEqual(exit, null, `drained worker did not exit:\n${out}`);
    assert.deepEqual(events.filter((e) => e !== 'activated'), ['completed'], out);
    assert.equal(exit.code, 0, out);
    assert.match(out, /open handles/, "the exit backstop (not a natural loop drain) must have ended the leaked-handle process");
  });
