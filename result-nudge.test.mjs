// Tests for the Gap-2 result re-emit nudge (#678): a clean agent run that emits
// no machine-readable result gets exactly one bounded re-emit turn before the
// harness accepts an empty result. The re-run is injected so these tests never
// spawn a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildResultNudgePrompt, resolveAgentResultWithNudge, buildAgentStdin } from './c8ctl-plugin.js';

const nudgeFixture = () => ({
  profile: { name: 'copilot', rank: 'senior', model: 'Opus', capabilities: ['pr-review'] },
  job: { jobKey: '1', type: 'senior:pr-review', variables: { prompt: 'original task' } },
  envelope: { task: { prompt: 'original task', allowPr: false }, setup: {} },
});

function tmpResultFile() {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
  return { dir, file: join(dir, 'result.json') };
}

test('buildResultNudgePrompt steers a re-emit, forbids redoing work, echoes prior output', () => {
  const p = buildResultNudgePrompt('...prior transcript: verdict APPROVE...');
  assert.match(p, /AGENT_RESULT_FILE/);
  assert.match(p, /Do NOT redo the work/);
  assert.match(p, /::nano:result::/);
  assert.match(p, /verdict APPROVE/, 'echoes the prior output as context');
});

test('buildResultNudgePrompt caps the echoed transcript', () => {
  const huge = 'x'.repeat(100_000);
  const p = buildResultNudgePrompt(huge);
  // The prompt is the fixed scaffold plus a capped tail of the transcript, never the whole thing.
  assert.ok(p.length < 40_000, `nudge prompt should be capped, got ${p.length}`);
});

test('buildResultNudgePrompt leads with the stdout sentinel when no result file is available', () => {
  const withFile = buildResultNudgePrompt('prior', { hasResultFile: true });
  assert.match(withFile, /> "\$AGENT_RESULT_FILE"/, 'file path is the primary instruction when a file exists');

  const noFile = buildResultNudgePrompt('prior', { hasResultFile: false });
  assert.match(noFile, /::nano:result::/, 'still offers the stdout sentinel');
  assert.match(noFile, /unset\/empty/, 'explains AGENT_RESULT_FILE is unavailable');
  assert.doesNotMatch(noFile, /> "\$AGENT_RESULT_FILE"/, 'does not tell the agent to write an unusable file');
});

test('nudges once and recovers a dropped result (agent writes the file on the re-emit turn)', async () => {
  const { dir, file } = tmpResultFile();
  try {
    let reruns = 0;
    const result = { ok: true, stdout: 'Round complete — converged (prose only, no JSON emitted).' };
    const rerun = async (text) => {
      reruns++;
      assert.match(text, /AGENT_RESULT_FILE/);
      // Simulate the agent obeying the nudge: write the structured result.
      writeFileSync(file, JSON.stringify({ status: 'converged', summary: 'recovered' }));
      return { ok: true, stdout: '::nano:result:: {"status":"converged"}' };
    };
    const { stdout, nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun });
    assert.equal(nudged, true);
    assert.equal(reruns, 1, 'nudges exactly once');
    // The result file the caller reads afterwards now carries the recovered result.
    const { readAgentResultFile } = await import('./c8ctl-plugin.js');
    assert.deepEqual(readAgentResultFile(file), { status: 'converged', summary: 'recovered' });
    assert.match(stdout, /::nano:result::/, 'nudge stdout is appended for the caller-side parse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT nudge when the first turn already produced a result', async () => {
  const { dir, file } = tmpResultFile();
  try {
    writeFileSync(file, JSON.stringify({ status: 'addressed' }));
    let reruns = 0;
    const result = { ok: true, stdout: 'did the work' };
    const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun: async () => { reruns++; return { ok: true, stdout: '' }; } });
    assert.equal(nudged, false);
    assert.equal(reruns, 0, 'no re-run when a result already exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nudges when the result file is an empty object (no effective vars)', async () => {
  const { dir, file } = tmpResultFile();
  try {
    writeFileSync(file, JSON.stringify({}));
    let reruns = 0;
    const result = { ok: true, stdout: 'did the work but emitted an empty {}' };
    const rerun = async () => { reruns++; writeFileSync(file, JSON.stringify({ status: 'addressed' })); return { ok: true, stdout: '::nano:result:: {"status":"addressed"}' }; };
    const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun });
    assert.equal(nudged, true, 'an empty {} is not a usable result — must nudge');
    assert.equal(reruns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nudges when the result carries only reserved keys (sanitized away to nothing)', async () => {
  const { dir, file } = tmpResultFile();
  try {
    // Reserved / io.nanobpm.* keys are stripped by sanitizeResultVars, leaving no
    // effective vars — downstream sees no status, so this must still nudge.
    writeFileSync(file, JSON.stringify({ 'io.nanobpm.agentResult': { exitCode: 0 } }));
    let reruns = 0;
    const result = { ok: true, stdout: 'did the work but only reserved keys landed' };
    const rerun = async () => { reruns++; writeFileSync(file, JSON.stringify({ status: 'converged' })); return { ok: true, stdout: '::nano:result:: {"status":"converged"}' }; };
    const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun });
    assert.equal(nudged, true, 'reserved-keys-only is not a usable result — must nudge');
    assert.equal(reruns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT nudge a silent run (no stdout) — that is a crash/hang, not a dropped result', async () => {
  const { dir, file } = tmpResultFile();
  try {
    let reruns = 0;
    const result = { ok: true, stdout: '   ' };
    const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun: async () => { reruns++; return { ok: true, stdout: '' }; } });
    assert.equal(nudged, false);
    assert.equal(reruns, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT nudge a failed run', async () => {
  const { dir, file } = tmpResultFile();
  try {
    let reruns = 0;
    const result = { ok: false, stdout: 'boom' };
    const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun: async () => { reruns++; return { ok: true, stdout: '' }; } });
    assert.equal(nudged, false);
    assert.equal(reruns, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nudges and recovers via the stdout sentinel when resultFile is null (temp dir creation failed)', async () => {
  // No result file could be created, so recovery is possible ONLY via the
  // `::nano:result::` stdout sentinel. The nudge must still fire and recover.
  let reruns = 0;
  const result = { ok: true, stdout: 'did the work but dropped the result' };
  const rerun = async () => { reruns++; return { ok: true, stdout: '::nano:result:: {"status":"addressed","summary":"recovered via stdout"}' }; };
  const { stdout, nudged } = await resolveAgentResultWithNudge({ result, resultFile: null, rerun });
  assert.equal(nudged, true, 'nudges even without a result file');
  assert.equal(reruns, 1, 'nudges exactly once');
  assert.match(stdout, /::nano:result:: \{"status":"addressed"/, 'appends the recovered sentinel to stdout');
});

test('does NOT nudge when resultFile is null but stdout already carries a sentinel result', async () => {
  let reruns = 0;
  const result = { ok: true, stdout: '::nano:result:: {"status":"converged","summary":"all done"}' };
  const { nudged } = await resolveAgentResultWithNudge({ result, resultFile: null, rerun: async () => { reruns++; return { ok: true, stdout: '' }; } });
  assert.equal(nudged, false, 'a usable stdout-only result needs no nudge');
  assert.equal(reruns, 0);
});

test('the nudge re-caps combined stdout to MAX_CAPTURE_BYTES, keeping the tail sentinel and flagging truncation', async () => {
  const MAX = 1_048_576; // MAX_CAPTURE_BYTES (1 MiB)
  // First turn already filled the whole capture cap with prose (truncated true),
  // then the nudge appends a recovery sentinel. The combined output must be
  // trimmed back to the cap, keep the trailing sentinel, and report truncation.
  const result = { ok: true, stdout: 'X'.repeat(MAX), truncated: true };
  const sentinel = '::nano:result:: {"status":"addressed","summary":"recovered after a huge first turn"}';
  const rerun = async () => ({ ok: true, stdout: sentinel });
  const { stdout, nudged, truncated } = await resolveAgentResultWithNudge({ result, resultFile: null, rerun });
  assert.equal(nudged, true);
  assert.equal(truncated, true, 'reports truncation when the combined output exceeds the cap');
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= MAX, 'combined stdout is capped to MAX_CAPTURE_BYTES');
  assert.ok(stdout.endsWith(sentinel), 'keeps the tail so the recovery sentinel survives');
});

test('the nudge does NOT flag truncation when the combined output fits under the cap', async () => {
  const result = { ok: true, stdout: 'did work, dropped result' };
  const rerun = async () => ({ ok: true, stdout: '::nano:result:: {"status":"addressed","summary":"ok"}' });
  const { truncated } = await resolveAgentResultWithNudge({ result, resultFile: null, rerun });
  assert.equal(truncated, false, 'small combined output is not marked truncated');
});

test('the no-nudge early return echoes the incoming truncated flag (not a hardcoded false)', async () => {
  // Already-usable result short-circuits the nudge; the returned `stdout` is the
  // incoming (already truncated) stdout, so the returned `truncated` must reflect
  // that instead of a hardcoded false.
  let reruns = 0;
  const result = { ok: true, stdout: '::nano:result:: {"status":"converged","summary":"done"}', truncated: true };
  const { nudged, truncated } = await resolveAgentResultWithNudge({ result, resultFile: null, rerun: async () => { reruns++; return { ok: true, stdout: '' }; } });
  assert.equal(nudged, false, 'a usable result skips the nudge');
  assert.equal(reruns, 0);
  assert.equal(truncated, true, 'early return preserves the incoming truncated flag');
});

test('a throwing / still-empty re-emit turn degrades safely (nudged, but no crash)', async () => {
  const { dir, file } = tmpResultFile();
  try {
    const result = { ok: true, stdout: 'prose only' };
    // rerun throws — must be swallowed; stdout unchanged; still reported as nudged.
    const { stdout, nudged } = await resolveAgentResultWithNudge({ result, resultFile: file, rerun: async () => { throw new Error('nudge run failed'); } });
    assert.equal(nudged, true);
    assert.equal(stdout, 'prose only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-nudge stdin is the plain JSON job envelope for every mode', () => {
  const { profile, job, envelope } = nudgeFixture();
  for (const acp of [false, true]) {
    const stdin = buildAgentStdin(profile, job, envelope, { nudgePayload: null, acp });
    const parsed = JSON.parse(stdin);
    assert.equal(parsed.jobKey, '1');
    assert.equal(parsed.prompt, 'original task');
    assert.equal(parsed.task.task.prompt, 'original task');
  }
});

test('a nudge keeps the JSON envelope for non-ACP and only overrides the prompt fields', () => {
  const { profile, job, envelope } = nudgeFixture();
  const nudge = buildResultNudgePrompt('prior output');
  const stdin = buildAgentStdin(profile, job, envelope, { nudgePayload: nudge, acp: false });
  // Non-ACP harnesses read JSON off stdin — the envelope shape must survive.
  const parsed = JSON.parse(stdin);
  assert.equal(parsed.jobKey, '1', 'still the structured job envelope, not a bare string');
  assert.equal(parsed.prompt, nudge, 'top-level prompt reflects the nudge');
  assert.equal(parsed.task.task.prompt, nudge, 'reserved task.task.prompt reflects the nudge');
  // The shared envelope must not be mutated by the override.
  assert.equal(envelope.task.prompt, 'original task', 'source envelope is left untouched');
});

test('a nudge is delivered as the raw prompt string in ACP mode', () => {
  const { profile, job, envelope } = nudgeFixture();
  const nudge = buildResultNudgePrompt('prior output');
  const stdin = buildAgentStdin(profile, job, envelope, { nudgePayload: nudge, acp: true });
  // ACP writes stdin verbatim as the session/prompt text — it must be the raw nudge.
  assert.equal(stdin, nudge);
});
