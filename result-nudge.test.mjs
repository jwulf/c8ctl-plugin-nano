// Tests for the Gap-2 result re-emit nudge (#678): a clean agent run that emits
// no machine-readable result gets exactly one bounded re-emit turn before the
// harness accepts an empty result. The re-run is injected so these tests never
// spawn a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildResultNudgePrompt, resolveAgentResultWithNudge } from './c8ctl-plugin.js';

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
