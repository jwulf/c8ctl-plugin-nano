// Tests for issue #275 — the "worker completes empty agent jobs" incident:
//   1. detectEmptyAgentJob — a run that exits 0 with no result vars, no output,
//      no transcript turns, no commits and no push is detected as an empty husk
//      (so the worker FAILS it, preserving retries, instead of completing it).
//   2. detectProtocolMismatch / commandLineHasAcpSelector — a command that runs
//      the harness in ACP mode (`--acp` / `acp` / `*-acp` adapter) paired with
//      `protocol: pipe` is detected (refused at hire and at work startup).
//   3. isPermanentTerminalStatus — a 4xx terminal-update rejection is permanent
//      (stop retrying); a 5xx/timeout is transient (still retried).
//
// The pure detectors are exercised directly; the hire-time refusal is exercised
// through the real hireWorker with process.exit stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectEmptyAgentJob,
  detectProtocolMismatch,
  commandLineHasAcpSelector,
  hireWorker,
} from './c8ctl-plugin.js';
import { isPermanentTerminalStatus } from './agent-instance.mjs';

// --- logger capture (mirrors agentic-protocol-schema.test.mjs) -------------
const logs = { info: [], warn: [], error: [] };
function resetLogs() { logs.info = []; logs.warn = []; logs.error = []; }
const prevC8ctl = globalThis.c8ctl;
globalThis.c8ctl = {
  getLogger: () => ({
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
    debug: () => {},
    output: () => {},
  }),
};
process.on('exit', () => {
  if (prevC8ctl === undefined) delete globalThis.c8ctl;
  else globalThis.c8ctl = prevC8ctl;
});

async function withHome(fn) {
  const prevHome = process.env.C8CTL_NANO_HOME;
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-275-'));
  process.env.C8CTL_NANO_HOME = home;
  resetLogs();
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// --- 1. detectEmptyAgentJob -------------------------------------------------

test('detectEmptyAgentJob flags a total husk (no vars/output/turns/commits/push)', () => {
    const hit = detectEmptyAgentJob({
      resultVars: {},
      stdout: '',
      stderr: '',
      gitResult: null,
      hasTurns: false,
      hasPlan: false,
      hasOutcome: false,
    });
    assert.ok(hit, 'an empty run is detected');
    assert.match(hit.reason, /produced nothing/);
    assert.match(hit.reason, /protocol-mismatched|no-op harness/);
  });

test('detectEmptyAgentJob flags a run whose only result vars are null-valued', () => {
  // `{"status":null}` carries no EFFECTIVE var (sanitizeResultVars keeps the key
  // but hasEffectiveResultVars ignores null values) — still an empty job.
  const hit = detectEmptyAgentJob({ resultVars: { status: null }, stdout: '', stderr: '', gitResult: null });
  assert.ok(hit, 'null-valued vars are not effective — still empty');
});

test('detectEmptyAgentJob passes a run with ANY evidence of real work', () => {
  const base = { resultVars: {}, stdout: '', stderr: '', gitResult: null };
  assert.equal(detectEmptyAgentJob({ ...base, resultVars: { status: 'opened' } }), null, 'result vars');
  assert.equal(detectEmptyAgentJob({ ...base, stdout: 'did work' }), null, 'stdout output');
  assert.equal(detectEmptyAgentJob({ ...base, stderr: 'a diagnostic' }), null, 'stderr output');
  assert.equal(detectEmptyAgentJob({ ...base, hasTurns: true }), null, 'transcript turns');
  assert.equal(detectEmptyAgentJob({ ...base, hasPlan: true }), null, 'a plan');
  assert.equal(detectEmptyAgentJob({ ...base, hasOutcome: true }), null, 'an ACP outcome');
  assert.equal(
    detectEmptyAgentJob({ ...base, gitResult: { commits: ['abc123'], pushed: false } }),
    null,
    'unpushed commits are still work',
  );
  assert.equal(
    detectEmptyAgentJob({ ...base, gitResult: { commits: [], pushed: true } }),
    null,
    'a push is still work',
  );
});

test('detectEmptyAgentJob treats whitespace-only output as empty', () => {
  const hit = detectEmptyAgentJob({ resultVars: {}, stdout: '   \n  ', stderr: '\t', gitResult: null });
  assert.ok(hit, 'whitespace-only output carries no work signal');
});

// --- 2. detectProtocolMismatch / commandLineHasAcpSelector ------------------

test('commandLineHasAcpSelector detects the ACP selector in its various forms', () => {
  assert.equal(commandLineHasAcpSelector('nano-coder --acp'), true, '--acp switch');
  assert.equal(commandLineHasAcpSelector("nano-coder '--acp'"), true, 'POSIX-quoted --acp (buildAgentCommandLine)');
  assert.equal(commandLineHasAcpSelector('nano-coder acp'), true, 'acp subcommand');
  assert.equal(commandLineHasAcpSelector('claude-agent-acp'), true, '*-acp adapter binary');
  assert.equal(commandLineHasAcpSelector('pi-acp --model x'), true, '*-acp adapter with args');
  assert.equal(commandLineHasAcpSelector('qwen --experimental-acp'), true, 'hidden --*-acp switch');
  assert.equal(commandLineHasAcpSelector('copilot'), false, 'plain command');
  assert.equal(commandLineHasAcpSelector('copilot --model foo-acp'), false, 'an argument VALUE ending in -acp is not a selector');
  assert.equal(commandLineHasAcpSelector(''), false, 'empty line');
});

test('detectProtocolMismatch flags an ACP-mode command on protocol pipe', () => {
  const hit = detectProtocolMismatch({ command: 'nano-coder', args: ['--acp'], protocol: 'pipe' });
  assert.ok(hit, 'the incident shape is detected');
  assert.match(hit.reason, /selects ACP mode/);
  assert.match(hit.reason, /protocol is "pipe"/);
  assert.match(hit.reason, /--protocol acp/);
});

test('detectProtocolMismatch flags an ACP selector baked into the command string', () => {
  const hit = detectProtocolMismatch({ command: 'nano-coder --acp', args: [], protocol: 'pipe' });
  assert.ok(hit, 'an embedded --acp is detected');
});

test('detectProtocolMismatch allows the consistent shapes', () => {
  assert.equal(detectProtocolMismatch({ command: 'nano-coder', args: ['--acp'], protocol: 'acp' }), null, 'acp + --acp');
  assert.equal(detectProtocolMismatch({ command: 'copilot', args: [], protocol: 'pipe' }), null, 'pipe + plain');
  // protocol acp with no selector is fine — ensureAcpFlag appends --acp at spawn.
  assert.equal(detectProtocolMismatch({ command: 'copilot', args: [], protocol: 'acp' }), null, 'acp + no selector (auto-appended)');
  assert.equal(detectProtocolMismatch({ command: 'copilot', args: ['--model', 'foo-acp'], protocol: 'pipe' }), null, 'a -acp argument value is not a selector');
});

test('detectProtocolMismatch treats a missing protocol as pipe (the default)', () => {
  const hit = detectProtocolMismatch({ command: 'nano-coder --acp', args: [], protocol: undefined });
  assert.ok(hit, 'no protocol means pipe — still a mismatch');
});

// --- hire-time refusal (through the real hireWorker) ------------------------

test('hire refuses an ACP-mode command with protocol pipe (issue #275)', async () => {
  await withHome(async () => {
    const prevExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`exit ${code}`); };
    try {
      await hireWorker(
        { positional: [] },
        { name: 'coder', rank: 'senior', command: 'nano-coder --acp', protocol: 'pipe' },
      ).catch(() => {});
    } finally {
      process.exit = prevExit;
    }
    assert.equal(exitCode, 1, 'the mismatched hire is refused');
    const err = logs.error.find((m) => /Refusing to hire/.test(m));
    assert.ok(err, 'a loud refusal is logged');
    assert.match(err, /selects ACP mode/);
    assert.match(err, /--protocol acp/);
  });
});

test('hire accepts the consistent shapes (no false refusal)', async () => {
  await withHome(async () => {
    const prevExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`exit ${code}`); };
    try {
      // acp + --acp is consistent.
      await hireWorker({ positional: [] }, { name: 'a', rank: 'senior', command: 'nano-coder --acp', protocol: 'acp' }).catch(() => {});
      assert.equal(exitCode, null, 'acp + --acp is accepted');
      // pipe + plain command is consistent.
      await hireWorker({ positional: [] }, { name: 'b', rank: 'senior', command: 'copilot', protocol: 'pipe' }).catch(() => {});
      assert.equal(exitCode, null, 'pipe + plain is accepted');
      // acp + no selector is fine (ensureAcpFlag appends --acp at spawn).
      await hireWorker({ positional: [] }, { name: 'c', rank: 'senior', command: 'copilot', protocol: 'acp' }).catch(() => {});
      assert.equal(exitCode, null, 'acp + no selector is accepted');
    } finally {
      process.exit = prevExit;
    }
  });
});

// --- 3. isPermanentTerminalStatus -------------------------------------------

test('isPermanentTerminalStatus: 4xx is permanent, 5xx/timeout/unknown is transient', () => {
  assert.equal(isPermanentTerminalStatus(400), true);
  assert.equal(isPermanentTerminalStatus(409), true);
  assert.equal(isPermanentTerminalStatus(422), true);
  assert.equal(isPermanentTerminalStatus(404), true);
  assert.equal(isPermanentTerminalStatus(500), false, 'a 5xx is transient — retried');
  assert.equal(isPermanentTerminalStatus(503), false);
  assert.equal(isPermanentTerminalStatus(null), false, 'unknown is transient (fail-safe toward recovery)');
  assert.equal(isPermanentTerminalStatus(undefined), false);
  assert.equal(isPermanentTerminalStatus('422'), true, 'a numeric string is coerced');
  assert.equal(isPermanentTerminalStatus('n/a'), false);
});
