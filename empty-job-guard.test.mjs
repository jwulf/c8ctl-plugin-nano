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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectEmptyAgentJob,
  detectProtocolMismatch,
  effectiveHarnessProtocol,
  commandLineHasAcpSelector,
  shellWrappedScript,
  stdoutStrippedOfEmptyResult,
  hireWorker,
  buildResultEnvelope,
  sanitizeResultVars,
  AGENT_RESULT_KEY,
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

test('detectEmptyAgentJob ignores a synthetic transcript floor as work (thread 4118913047)', () => {
  // The ACP path synthesises a transcript FLOOR into stdout when the turn resolved
  // but no real session/update arrived. That floor is NOT agent work, so a no-op ACP
  // husk whose ONLY stdout is the floor must still be flagged empty.
  const floorText = 'Agent completed the turn but published no structured/canonical transcript content, so no transcript messages were produced.';
  const hit = detectEmptyAgentJob({
    resultVars: {},
    stdout: floorText,
    gitResult: null,
    hasTurns: false,
    hasPlan: false,
    hasOutcome: false,
    transcriptFloorOnly: true,
  });
  assert.ok(hit, 'a run whose only stdout is the synthetic floor is still empty');
  assert.match(hit.reason, /produced nothing/);
  // Same stdout WITHOUT the floor-only flag (real agent work) is NOT empty.
  assert.equal(
    detectEmptyAgentJob({ resultVars: {}, stdout: floorText, gitResult: null }),
    null,
    'real stdout output is still work',
  );
  // Floor-only does NOT suppress the other work signals.
  assert.equal(
    detectEmptyAgentJob({ resultVars: {}, stdout: floorText, gitResult: null, transcriptFloorOnly: true, hasTurns: true }),
    null,
    'real transcript turns are still work even alongside a floor',
  );
});

test('detectEmptyAgentJob treats stderr-only diagnostics as NON-work (the husk signature)', () => {
  // A protocol-mismatched harness (an ACP-mode binary fed a pipe payload) rejects
  // stdin and prints an ACP parse error to stderr while producing nothing on
  // stdout/result vars/transcript/git — the exact run this detector must fail.
  // stderr is diagnostics, not evidence of work, so the guard must still flag it.
  const acpParseErr = detectEmptyAgentJob({
    resultVars: {},
    stdout: '',
    stderr: 'Error: failed to parse ACP message: unexpected token in JSON at position 0',
    gitResult: null,
    hasTurns: false,
    hasPlan: false,
    hasOutcome: false,
  });
  assert.ok(acpParseErr, 'an ACP parse error on stderr is not work — still an empty job');
  assert.match(acpParseErr.reason, /produced nothing/);

  const hit = detectEmptyAgentJob({ resultVars: {}, stdout: '', stderr: 'a diagnostic', gitResult: null });
  assert.ok(hit, 'stderr-only output carries no work signal');
});

test('detectEmptyAgentJob treats whitespace-only output as empty', () => {
  const hit = detectEmptyAgentJob({ resultVars: {}, stdout: '   \n  ', stderr: '\t', gitResult: null });
  assert.ok(hit, 'whitespace-only output carries no work signal');
});

test('detectEmptyAgentJob flags stdout that is ONLY an empty/value-less result sentinel or fence (thread 4118471796)', () => {
  // `::nano:result:: {}` leaves stdout non-blank but carries no EFFECTIVE vars, so
  // the job would otherwise complete with no usable result — the husk this guard
  // exists to catch. resultVars is `{}` because the empty sentinel yields nothing.
  assert.ok(
    detectEmptyAgentJob({ resultVars: {}, stdout: '::nano:result:: {}', stderr: '', gitResult: null }),
    'an empty-object result sentinel is not work',
  );
  assert.ok(
    detectEmptyAgentJob({ resultVars: {}, stdout: '::nano:result:: {"status":null}', stderr: '', gitResult: null }),
    'a null-valued result sentinel is not work',
  );
  assert.ok(
    detectEmptyAgentJob({ resultVars: {}, stdout: '::nano:result:: {"output":"x"}', stderr: '', gitResult: null }),
    'a reserved-keys-only result sentinel is not work',
  );
  assert.ok(
    detectEmptyAgentJob({ resultVars: {}, stdout: '```json\n{}\n```', stderr: '', gitResult: null }),
    'an empty result FENCE is not work',
  );
  assert.ok(
    detectEmptyAgentJob({ resultVars: {}, stdout: 'noise\n::nano:result:: {}\ntrailer\n', stderr: '', gitResult: null }) === null,
    'substantive prose around an empty sentinel is still work',
  );
  assert.equal(
    detectEmptyAgentJob({ resultVars: { status: 'converged' }, stdout: '::nano:result:: {"status":"converged"}', stderr: '', gitResult: null }),
    null,
    'a sentinel carrying real vars is work',
  );
  assert.equal(
    detectEmptyAgentJob({ resultVars: {}, stdout: 'this is not a result marker at all', stderr: '', gitResult: null }),
    null,
    'ordinary stdout with no result marker still counts as work',
  );
});

test('detectEmptyAgentJob preserves substantive text BEFORE an inline empty-result sentinel (thread 4118560562)', () => {
  // A sentinel can share a line with substantive prose. Dropping the WHOLE line
  // would mis-classify the run as a husk even though the harness produced real
  // output; only the marker itself may be stripped, keeping the prefix.
  assert.equal(
    detectEmptyAgentJob({ resultVars: {}, stdout: 'work done ::nano:result:: {}', stderr: '', gitResult: null }),
    null,
    'inline prose before an empty sentinel is still work',
  );
  assert.equal(
    stdoutStrippedOfEmptyResult('work done ::nano:result:: {}'),
    'work done',
    'strip keeps the inline prefix, drops only the marker',
  );
  // A sentinel-only line still reduces to empty (the husk signature).
  assert.equal(stdoutStrippedOfEmptyResult('::nano:result:: {}'), '', 'sentinel-only line strips to empty');
  assert.equal(
    stdoutStrippedOfEmptyResult('did the thing\n::nano:result:: {}').trim(),
    'did the thing',
    'a prose line survives a following sentinel-only line',
  );
  // A sentinel carrying REAL vars is never stripped.
  assert.equal(
    stdoutStrippedOfEmptyResult('::nano:result:: {"status":"converged"}'),
    '::nano:result:: {"status":"converged"}',
    'a sentinel with effective vars is left intact',
  );
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

test('commandLineHasAcpSelector descends into shell-wrapped commands (thread 4118471822)', () => {
  // A shell wrapper runs its `-c` script through a shell, so an ACP selector
  // inside that script is live even though the top-level tokenizer sees only the
  // wrapper. `ensureAcpFlag` would append `--acp` to the wrapper and miss it.
  assert.equal(commandLineHasAcpSelector("sh -c 'nano-coder --acp'"), true, 'sh -c wrapped --acp');
  assert.equal(commandLineHasAcpSelector("bash -lc 'nano-coder acp'"), true, 'bash -lc wrapped acp subcommand');
  assert.equal(commandLineHasAcpSelector("/bin/sh -c 'claude-agent-acp'"), true, 'absolute shell path + wrapped adapter');
  assert.equal(commandLineHasAcpSelector('bash -c "qwen --experimental-acp"'), true, 'double-quoted wrapped --*-acp switch');
  // A wrapped PLAIN command is not a false positive.
  assert.equal(commandLineHasAcpSelector("sh -c 'copilot --model foo'"), false, 'wrapped plain command is not a selector');
  assert.equal(commandLineHasAcpSelector("sh -c 'copilot --model foo-acp'"), false, 'wrapped -acp VALUE is not a selector');
});

test('commandLineHasAcpSelector descends past leading env assignments and env wrappers (thread 4118560608)', () => {
  // The shell need not be word 0: a profile may prefix it with env assignments
  // (`FOO=1 sh -c …`) or an `env` wrapper (`env FOO=1 sh -c …`). The scan must skip
  // that prefix so the shell lookup lands on the real shell token.
  assert.equal(commandLineHasAcpSelector("FOO=1 sh -c 'nano-coder --acp'"), true, 'leading assignment + sh -c');
  assert.equal(commandLineHasAcpSelector("A=1 B=2 bash -lc 'nano-coder acp'"), true, 'multiple leading assignments');
  assert.equal(commandLineHasAcpSelector("env FOO=1 sh -c 'nano-coder --acp'"), true, 'env wrapper + assignment');
  assert.equal(commandLineHasAcpSelector("env -i FOO=1 sh -c 'nano-coder --acp'"), true, 'env -i + assignment');
  assert.equal(commandLineHasAcpSelector("env -u BAR sh -c 'nano-coder --acp'"), true, 'env -u NAME (option with arg)');
  // shellWrappedScript returns the inner script directly.
  assert.equal(shellWrappedScript("FOO=1 sh -c 'nano-coder --acp'"), 'nano-coder --acp', 'shellWrappedScript skips the assignment');
  assert.equal(shellWrappedScript("env FOO=1 sh -c 'copilot'"), 'copilot', 'shellWrappedScript skips the env wrapper');
  // A leading assignment on a NON-shell command is not a wrapper (no descent).
  assert.equal(shellWrappedScript('FOO=1 plain-harness'), null, 'assignment + non-shell is not a wrapper');
  assert.equal(commandLineHasAcpSelector("env FOO=1 sh -c 'copilot --model foo'"), false, 'env-wrapped plain command is not a selector');
});

test('commandLineHasAcpSelector unwraps an env-wrapped *-acp adapter (thread 4118839851)', () => {
  // A `*-acp` adapter behind a plain `env` wrapper is still an ACP selector: the
  // command-token scan must skip `env` (and its options / assignments) so the
  // adapter check lands on the real command token, not `env` itself. Otherwise a
  // `protocol: pipe` profile with `env claude-agent-acp` would pass validation
  // and reproduce the ACP-over-pipe empty-job failure.
  assert.equal(commandLineHasAcpSelector('env claude-agent-acp'), true, 'env + adapter');
  assert.equal(commandLineHasAcpSelector('env FOO=1 claude-agent-acp'), true, 'env + assignment + adapter');
  assert.equal(commandLineHasAcpSelector('env -i pi-acp'), true, 'env -i + adapter');
  assert.equal(commandLineHasAcpSelector('env -u BAR claude-code-acp'), true, 'env -u NAME + adapter');
  // A plain command behind env is NOT a selector.
  assert.equal(commandLineHasAcpSelector('env FOO=1 copilot'), false, 'env-wrapped plain command');
  // The mismatch detector flags the env-wrapped adapter on protocol pipe.
  const hit = detectProtocolMismatch({ command: 'env', args: ['claude-agent-acp'], protocol: 'pipe' });
  assert.ok(hit, 'env-wrapped adapter on pipe is a mismatch');
  assert.match(hit.reason, /selects ACP mode/);
});

test('detectProtocolMismatch flags a shell-wrapped ACP command on protocol pipe (thread 4118471822)', () => {
  const hit = detectProtocolMismatch({ command: 'sh', args: ['-c', 'nano-coder --acp'], protocol: 'pipe' });
  assert.ok(hit, 'a shell-wrapped ACP selector is detected as a mismatch');
  assert.match(hit.reason, /selects ACP mode/);
  // A shell-wrapped plain command is still fine.
  assert.equal(
    detectProtocolMismatch({ command: 'sh', args: ['-c', 'copilot --model foo'], protocol: 'pipe' }),
    null,
    'a shell-wrapped plain command is not a mismatch',
  );
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

// --- effectiveHarnessProtocol (container pipe-only, thread 4118327651) ------

test('effectiveHarnessProtocol reduces a container protocol to pipe', () => {
  // A container runs pipe-only regardless of the declared protocol (runAgentJob's
  // `void protocol`), so its effective transport is always pipe.
  assert.equal(effectiveHarnessProtocol('acp', true), 'pipe', 'container acp -> pipe');
  assert.equal(effectiveHarnessProtocol('pipe', true), 'pipe', 'container pipe -> pipe');
  // The host honours the declared protocol (normalized/lower-cased).
  assert.equal(effectiveHarnessProtocol('acp', false), 'acp', 'host acp stays acp');
  assert.equal(effectiveHarnessProtocol('  ACP ', false), 'acp', 'host protocol normalized');
  assert.equal(effectiveHarnessProtocol(undefined, false), 'pipe', 'host default is pipe');
});

test('a container ACP-selector command is a mismatch under the effective protocol', () => {
  // The startup refusal composes detectProtocolMismatch with effectiveHarnessProtocol.
  // A container profile with an ACP selector baked into the command but declaring
  // protocol acp still pipes plain JSON to the ACP harness — a husk. Under the
  // container's effective (pipe) protocol the mismatch is detected, so the refusal
  // now covers the container executor too, not just the host.
  const containerAcpCmd = detectProtocolMismatch({
    command: 'nano-coder --acp',
    args: [],
    protocol: effectiveHarnessProtocol('acp', true),
  });
  assert.ok(containerAcpCmd, 'container + ACP-selector command is refused');
  assert.match(containerAcpCmd.reason, /selects ACP mode/);

  // But a plain (non-ACP) container command is NOT a false positive, even when the
  // profile pointlessly declares protocol acp (the container ignores it).
  const containerPlain = detectProtocolMismatch({
    command: 'copilot',
    args: [],
    protocol: effectiveHarnessProtocol('acp', true),
  });
  assert.equal(containerPlain, null, 'a plain container command is not refused');
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

test('hire refuses an ACP-mode command for a container even with protocol acp (thread 4118414685)', async () => {
  await withHome(async () => {
    const prevExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`exit ${code}`); };
    try {
      // A container runs pipe-only regardless of --protocol, so an ACP-selector
      // command is the same empty-husk mismatch even when hired with protocol acp.
      // Rejected at hire time (via the EFFECTIVE protocol), not only at work time.
      await hireWorker(
        { positional: [] },
        { name: 'c-acp', rank: 'senior', command: 'nano-coder --acp', protocol: 'acp', sandbox: 'docker', image: 'ghcr.io/x/y:latest' },
      ).catch(() => {});
    } finally {
      process.exit = prevExit;
    }
    assert.equal(exitCode, 1, 'the container ACP mismatch is refused at hire time');
    const err = logs.error.find((m) => /Refusing to hire/.test(m));
    assert.ok(err, 'a loud refusal is logged');
    assert.match(err, /selects ACP mode/);
  });
});

test('hire accepts a plain container command with protocol acp (no false refusal)', async () => {
  await withHome(async () => {
    const prevExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`exit ${code}`); };
    try {
      // A plain (non-ACP) container command is fine even with a pointless
      // --protocol acp — the container ignores the declared protocol.
      await hireWorker(
        { positional: [] },
        { name: 'c-plain', rank: 'senior', command: 'copilot', protocol: 'acp', sandbox: 'docker', image: 'ghcr.io/x/y:latest' },
      ).catch(() => {});
      assert.equal(exitCode, null, 'a plain container command is accepted');
    } finally {
      process.exit = prevExit;
    }
  });
});

test('isPermanentTerminalStatus: 4xx is permanent, 5xx/timeout/unknown is transient', () => {
  assert.equal(isPermanentTerminalStatus(400), true);
  assert.equal(isPermanentTerminalStatus(409), true);
  assert.equal(isPermanentTerminalStatus(422), true);
  assert.equal(isPermanentTerminalStatus(404), true);
  assert.equal(isPermanentTerminalStatus(429), false, 'a 429 is rate limiting — transient, retried');
  assert.equal(isPermanentTerminalStatus('429'), false, 'a numeric-string 429 is coerced and transient');
  assert.equal(isPermanentTerminalStatus(408), false, 'a 408 is a request timeout — transient, retried');
  assert.equal(isPermanentTerminalStatus('408'), false, 'a numeric-string 408 is coerced and transient');
  assert.equal(isPermanentTerminalStatus(500), false, 'a 5xx is transient — retried');
  assert.equal(isPermanentTerminalStatus(503), false);
  assert.equal(isPermanentTerminalStatus(null), false, 'unknown is transient (fail-safe toward recovery)');
  assert.equal(isPermanentTerminalStatus(undefined), false);
  assert.equal(isPermanentTerminalStatus('422'), true, 'a numeric string is coerced');
  assert.equal(isPermanentTerminalStatus('n/a'), false);
});

// --- Issue #282: a successful job with NO AgentInstance producer must COMPLETE ---
//
// The incident: `preGuardDrainTimedOut` was declared INSIDE the run try block but
// read by the empty-job guard AFTER that block closed. For an external/copilot job
// the AgentInstance producer is unavailable (`agentInstanceProducer` undefined), so
// `appendedTurns` is undefined and the `||` did NOT short-circuit — the out-of-scope
// read threw a ReferenceError that escaped the runner and surfaced only as the
// supervisor's `run failed — …` log, leaving the job to time out and re-activate
// forever. Every successful job's result was dropped.
//
// `settleSuccessfulRun` mirrors the runner's settlement tail (c8ctl-plugin.js: the
// empty-job guard + settleJob.complete) for a SUCCESSFUL run, so the test pins the
// observable contract — a produced result is COMPLETED, never dropped — without
// driving the ~1000-line workAgent. The hoisted-scope fix itself is pinned at the
// source by the structure guard below (the repo has no ESLint; cf.
// supervisor-engine-sdk-preference.test.mjs / agent-resume-wiring.test.mjs).
function settleSuccessfulRun({ result, rawResult, gitResult = null, agentInstanceProducer, preGuardDrainTimedOut = false }) {
  const resultVars = sanitizeResultVars(rawResult);
  const resultEnvelope = buildResultEnvelope(result, { sandbox: 'none', git: gitResult, result: rawResult });
  // Mirror the guard's hasTurns expression EXACTLY (optional-chained producer + the
  // hoisted preGuardDrainTimedOut). With no producer this must NOT throw.
  const emptyJob = detectEmptyAgentJob({
    resultVars,
    stdout: result.stdout,
    gitResult,
    hasTurns: agentInstanceProducer?.appendedTurns > 0 || preGuardDrainTimedOut,
    hasPlan: agentInstanceProducer?.sawPlan === true,
    hasOutcome: result.acpOutcome != null,
    transcriptFloorOnly: result.acpTranscriptFloorOnly === true,
  });
  if (emptyJob) return { settled: 'failed', reason: emptyJob.reason };
  return { settled: 'completed', variables: { ...resultVars, [AGENT_RESULT_KEY]: resultEnvelope, output: result.stdout, exitCode: 0 } };
}

test('#282: a successful job with NO AgentInstance producer is COMPLETED with its result vars (not dropped)', () => {
  // The exact incident shape: external/copilot job, producer unavailable, real result.
  const result = { ok: true, stdout: 'did the work', exitCode: 0 };
  const rawResult = { status: 'opened', summary: 'built the slice', pr: 'owner/repo#1' };
  const out = settleSuccessfulRun({ result, rawResult, agentInstanceProducer: undefined });
  assert.equal(out.settled, 'completed', 'a produced result must COMPLETE, never be dropped');
  assert.equal(out.variables.status, 'opened');
  assert.equal(out.variables.summary, 'built the slice');
  assert.equal(out.variables.exitCode, 0);
  assert.ok(out.variables[AGENT_RESULT_KEY], 'the audit envelope rides the completion');
});

test('#282: the guard short-circuit does not depend on the producer (null producer, real work)', () => {
  // A null producer must behave identically — the hoisted flag defaults false and the
  // result vars / stdout mark the job non-empty regardless.
  const result = { ok: true, stdout: '', exitCode: 0 };
  const out = settleSuccessfulRun({ result, rawResult: { status: 'opened' }, agentInstanceProducer: null });
  assert.equal(out.settled, 'completed');
  assert.equal(out.variables.status, 'opened');
});

test('#282: preGuardDrainTimedOut is hoisted to settlement scope and settlement is wrapped (source guard)', () => {
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');

  // (1) The declaration is hoisted OUT of the run try block: it must appear BEFORE
  // the `try {` that opens the run body, alongside the other settlement-scoped state
  // (runCompleted / discardCheckpointOnAck). Slice from the runner's opening to the
  // empty-job guard and assert ordering: declaration precedes the inner `try`.
  const declIdx = src.indexOf('let preGuardDrainTimedOut = false;');
  assert.ok(declIdx !== -1, 'preGuardDrainTimedOut must be declared (hoisted)');
  const guardIdx = src.indexOf('hasTurns: agentInstanceProducer?.appendedTurns > 0 || preGuardDrainTimedOut');
  assert.ok(guardIdx !== -1, 'the empty-job guard must read preGuardDrainTimedOut');
  // The run-body try opens AFTER the settlement-scoped declarations (resultDir /
  // resultFile are declared just before it). The hoisted declaration must sit BEFORE
  // that try, not inside it.
  const runBodyTryIdx = src.indexOf('let resultDir = null;');
  assert.ok(runBodyTryIdx !== -1, 'the run-body setup (resultDir) must be present');
  assert.ok(
    declIdx < runBodyTryIdx,
    'preGuardDrainTimedOut must be declared BEFORE the run-body try (settlement scope), not inside it',
  );
  assert.ok(declIdx < guardIdx, 'the declaration must precede the guard that reads it');

  // There must be exactly ONE declaration — no shadowing `let` left inside the try.
  const declCount = src.split('let preGuardDrainTimedOut').length - 1;
  assert.equal(declCount, 1, 'preGuardDrainTimedOut must be declared exactly once (no inner shadow)');

  // (2) The class fix: the runner's settlement is wrapped so an unexpected throw FAILS
  // the job instead of escaping to the supervisor's `run failed` log. Pin the catch
  // that fails the job on a settlement-path error.
  assert.match(
    src,
    /settlement-path error — failing job rather than leaving it unsettled/,
    'an unexpected settlement-path throw must FAIL the job (retries preserved), not leave it unsettled',
  );
  assert.match(
    src,
    /settleJob\.fail\(\{\s*errorMessage:\s*`agent "\$\{profile\.name\}" settlement error:/,
    'the settlement-path catch must route through settleJob.fail',
  );
});
