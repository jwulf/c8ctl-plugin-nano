// Single-flight (one-job-per-worker) regression tests for `nano work`
// (jwulf/c8ctl-plugin-nano#142).
//
// The bug: `maxParallelJobs = 1` only serializes ONE job-type poller, but a
// single `work` process runs one poller per job type (the rank×capability
// matrix, or every deployed agent type under `--auto`). With no process-wide
// gate a worker serving N job types could lease and RUN up to N agent harnesses
// concurrently — each holding its own PTY + git workspace + broker lock-extender
// — the exact failure the "one job per worker" invariant forbids.
//
// The fix threads a capacity-1 single-flight guard through every per-type
// poller's job handler: the first job to acquire it runs to completion; any
// other poller that finds it held fails its lease FAST so the broker re-queues
// the job (retries preserved) instead of leaving it "claimed but idle".
//
// Two layers of coverage:
//   1. A fast unit test of the exported `createSingleFlight` primitive.
//   2. A full-fidelity integration test that drives the REAL exported
//      `workAgent` in a child process with a stubbed c8ctl runtime, registers
//      pollers on 2+ job types, dispatches jobs on DIFFERENT types at the same
//      instant, and asserts at most one real harness (`runAgentJob`) ever runs
//      concurrently — and that the second job is failed-fast, not parked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSingleFlight } from './c8ctl-plugin.js';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('createSingleFlight: capacity-1 mutual exclusion, release re-arms, busy reflects state', () => {
  const sf = createSingleFlight();
  assert.equal(sf.busy, false);
  assert.equal(sf.tryAcquire(), true, 'first acquire succeeds');
  assert.equal(sf.busy, true);
  assert.equal(sf.tryAcquire(), false, 'a second acquire while held is refused');
  assert.equal(sf.tryAcquire(), false, 'still refused');
  sf.release();
  assert.equal(sf.busy, false, 'release frees the permit');
  assert.equal(sf.tryAcquire(), true, 'permit can be re-acquired after release');
  sf.release();
  sf.release(); // idempotent
  assert.equal(sf.busy, false);
});

// The child harness: injects a fake c8ctl runtime whose createJobWorker simply
// CAPTURES each poller's jobHandler (keyed by job type) on a global, then drives
// the real `workAgent`. Once ≥2 pollers are registered it runs two phases,
// reading each phase's concurrency log itself (the recorder honours the
// NANO_TEST_CONC_LOG env var, which the harness flips between phases), and prints
// machine-readable `@@{…}` result lines the parent asserts on.
function harnessSource({ concConcurrent, concSequential }) {
  return [
    `import { readFileSync, existsSync } from 'node:fs';`,
    `globalThis.__handlers = {};`,
    `globalThis.c8ctl = {`,
    `  createClient: () => ({`,
    `    getConfig: () => ({ restAddress: 'http://127.0.0.1:1/v2' }),`,
    `    getAuthHeaders: async () => ({}),`,
    `    createJobWorker: ({ jobType, jobHandler }) => {`,
    `      globalThis.__handlers[jobType] = jobHandler;`,
    `      return { stop: async () => {}, stopGracefully: async () => {} };`,
    `    },`,
    `  }),`,
    `  getLogger: () => ({`,
    `    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},`,
    `    output: () => {},`,
    `  }),`,
    `};`,
    `const emit = (obj) => process.stdout.write('@@' + JSON.stringify(obj) + '\\n');`,
    `const readLog = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\\n').filter(Boolean) : []);`,
    `const mod = await import(${JSON.stringify(pluginUrl)});`,
    `// Not awaited: workAgent resolves only on a stop signal. Attach a catch so a`,
    `// startup rejection surfaces deterministically instead of as an unhandled rejection.`,
    `mod.workAgent({ positional: ['faker'] }, {}).catch((err) => {`,
    `  emit({ error: 'workAgent failed: ' + (err && err.stack || err) });`,
    `  process.exit(3);`,
    `});`,
    ``,
    `function makeJob(key, sink) {`,
    `  return {`,
    `    jobKey: key, processInstanceKey: key, customHeaders: {}, variables: {}, retries: 3,`,
    `    modifyJobTimeout: async () => {},`,
    `    complete: async () => { sink.push({ key, outcome: 'complete' }); return {}; },`,
    `    fail: async (o) => { sink.push({ key, outcome: 'fail', errorMessage: o && o.errorMessage, retryBackOff: o && o.retryBackOff }); return {}; },`,
    `  };`,
    `}`,
    ``,
    `async function main() {`,
    `  const t0 = Date.now();`,
    `  while (Date.now() - t0 < 15000) {`,
    `    if (globalThis.__handlers['senior:feature'] && globalThis.__handlers['senior:fix']) break;`,
    `    await new Promise((r) => setTimeout(r, 50));`,
    `  }`,
    `  const hFeature = globalThis.__handlers['senior:feature'];`,
    `  const hFix = globalThis.__handlers['senior:fix'];`,
    `  if (!hFeature || !hFix) { emit({ error: 'pollers not registered', keys: Object.keys(globalThis.__handlers) }); process.exit(2); }`,
    ``,
    `  // Phase 1 — CONCURRENT: dispatch a job on two DIFFERENT job types in the`,
    `  // same tick. The single-flight guard must let only one run; the other must`,
    `  // fail fast (worker busy).`,
    `  process.env.NANO_TEST_CONC_LOG = ${JSON.stringify(concConcurrent)};`,
    `  const conc = [];`,
    `  const pA = hFeature(makeJob('A', conc));`,
    `  const pB = hFix(makeJob('B', conc));`,
    `  await Promise.allSettled([pA, pB]);`,
    `  emit({ phase: 'concurrent', outcomes: conc, log: readLog(${JSON.stringify(concConcurrent)}) });`,
    ``,
    `  // Phase 2 — SEQUENTIAL: the permit must release so back-to-back jobs both`,
    `  // run to completion. A fresh log proves no overlap here either.`,
    `  process.env.NANO_TEST_CONC_LOG = ${JSON.stringify(concSequential)};`,
    `  const seq = [];`,
    `  await hFeature(makeJob('C', seq));`,
    `  await hFix(makeJob('D', seq));`,
    `  emit({ phase: 'sequential', outcomes: seq, log: readLog(${JSON.stringify(concSequential)}) });`,
    `  emit({ done: true });`,
    `  process.exit(0);`,
    `}`,
    `main().catch((e) => { emit({ error: String((e && e.stack) || e) }); process.exit(3); });`,
  ].join('\n');
}

test('nano work: a worker serving multiple job types runs at most one harness at a time (single-flight)', async (t) => {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-single-flight-'));
  t.after(() => rmSync(HOME, { recursive: true, force: true }));

  const concConcurrent = join(HOME, 'conc-concurrent.log');
  const concSequential = join(HOME, 'conc-sequential.log');

  // The recording "agent harness" every job runs: it marks a concurrency log the
  // instant it STARTs, holds the slot ~1s, then marks END. Two overlapping runs
  // would interleave two STARTs before an END — the violation the guard prevents.
  // The target log is chosen at run time from NANO_TEST_CONC_LOG so the harness
  // can separate the two phases' evidence.
  const rec = join(HOME, 'rec.sh');
  writeFileSync(rec, [
    '#!/bin/sh',
    `f="\${NANO_TEST_CONC_LOG:-${concConcurrent}}"`,
    'echo START >> "$f"',
    'sleep 1',
    'echo END >> "$f"',
    'echo harness-done',
  ].join('\n'));
  chmodSync(rec, 0o755);

  // A hire whose rank×capability matrix yields several job types (senior,
  // senior:feature, senior:fix, senior:feature+fix) — the multi-poller shape the
  // bug needs — all running the same recorder command.
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    hires: {
      faker: {
        name: 'faker', rank: 'senior', command: `sh ${rec}`, model: '',
        capabilities: ['feature', 'fix'],
      },
    },
  }));

  const harness = join(HOME, 'harness.mjs');
  writeFileSync(harness, harnessSource({ concConcurrent, concSequential }));

  const child = spawn(process.execPath, [harness], {
    env: (() => {
      const e = { ...process.env };
      delete e.NANO_SUPERVISOR_ACTIVITY_FILE;
      delete e.NANO_SUPERVISOR_DAEMON_PID;
      e.C8CTL_NANO_HOME = HOME;
      e.NANO_AGENTIC = 'off';
      e.GITHUB_TOKEN = 'test-token';
      e.NANO_TEST_CONC_LOG = concConcurrent;
      return e;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const events = [];
  const seen = new Set();
  child.stdout.on('data', (d) => {
    out += d.toString();
    for (const line of out.split('\n')) {
      if (line.startsWith('@@') && !seen.has(line)) {
        try { events.push(JSON.parse(line.slice(2))); seen.add(line); } catch { /* partial line */ }
      }
    }
  });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  t.after(() => { try { if (exit === null) child.kill('SIGKILL'); } catch { /* ignore */ } });

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !events.some((e) => e.done) && !events.some((e) => e.error) && exit === null) {
    await sleep(100);
  }

  const errEvent = events.find((e) => e.error);
  assert.ok(!errEvent, `harness errored: ${errEvent ? errEvent.error : ''}\n--- child output ---\n${out}`);

  const concurrent = events.find((e) => e.phase === 'concurrent');
  const sequential = events.find((e) => e.phase === 'sequential');
  assert.ok(concurrent, `no concurrent-phase result\n--- child output ---\n${out}`);
  assert.ok(sequential, `no sequential-phase result\n--- child output ---\n${out}`);

  // --- Phase 1 assertions: exactly one job ran, the other failed fast. --------
  const outcomes = concurrent.outcomes;
  const completed = outcomes.filter((o) => o.outcome === 'complete');
  const failed = outcomes.filter((o) => o.outcome === 'fail');
  assert.equal(completed.length, 1, `exactly one concurrent job should complete, got ${JSON.stringify(outcomes)}`);
  assert.equal(failed.length, 1, `exactly one concurrent job should be failed-fast, got ${JSON.stringify(outcomes)}`);
  assert.match(String(failed[0].errorMessage), /worker busy|one job per worker/i, 'the deferred job should fail with a "worker busy" reason');
  assert.ok(Number(failed[0].retryBackOff) > 0, 'the fail-fast should carry a retry backoff so the lease is re-dispatched, not tight-looped');

  // Ground truth from the harness-side log: exactly one START and never overlap.
  const concLog = concurrent.log || [];
  assert.equal(concLog.filter((l) => l === 'START').length, 1, `exactly one harness should have STARTed in the concurrent phase, log=${JSON.stringify(concLog)}`);
  let active = 0; let maxActive = 0;
  for (const l of concLog) { if (l === 'START') active++; else if (l === 'END') active--; maxActive = Math.max(maxActive, active); }
  assert.equal(maxActive, 1, `at most one harness may run at any instant, log=${JSON.stringify(concLog)}`);

  // --- Phase 2 assertions: the permit released; both jobs ran, serialized. ----
  const seqOutcomes = sequential.outcomes;
  assert.equal(seqOutcomes.filter((o) => o.outcome === 'complete').length, 2, `both sequential jobs should complete, got ${JSON.stringify(seqOutcomes)}`);
  const seqLog = sequential.log || [];
  assert.equal(seqLog.filter((l) => l === 'START').length, 2, `both sequential harnesses should have run, log=${JSON.stringify(seqLog)}`);
  let a2 = 0; let max2 = 0;
  for (const l of seqLog) { if (l === 'START') a2++; else if (l === 'END') a2--; max2 = Math.max(max2, a2); }
  assert.equal(max2, 1, `sequential runs must not overlap either, log=${JSON.stringify(seqLog)}`);

  child.kill('SIGTERM');
});
