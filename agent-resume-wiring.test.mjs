// Runner-level integration test for the engine-transcript resume WIRING
// (issue #248, follow-up from the review of #241 / #239).
//
// `agent-resume.test.mjs` already covers the resume helpers (`resolveEffectiveEnvelope`,
// `seedResumeEnvelope`, `readPriorTranscript`, gating) deterministically in isolation.
// What those unit tests CANNOT catch is a regression in how `workAgent` wires their
// result into the spawned harness: if the harness were handed the ORIGINAL `envelope`
// instead of the seeded one, or the AgentInstance producer were seeded from the SEEDED
// envelope instead of the original, every helper test would stay green while the real
// harness behaved incorrectly.
//
// This test exercises the REAL collaborators `workAgent` glues on its hot path —
// `resolveEffectiveEnvelope` → `createAgentInstanceProducer` (original envelope) →
// `runAgentJob` (effective envelope) — in the EXACT order and with the EXACT option
// keys `workAgent` uses (see c8ctl-plugin.js: the producer is created from `envelope`
// at the `createAgentInstanceProducer({ camunda, job, profile, envelope, logger })`
// call; `resolveEffectiveEnvelope({ envelope, job, camunda, agentInstanceOff,
// producerUnavailable, containerMode, logger })` yields `effectiveEnvelope`; and
// `runAgentJob(profile, job, { envelope: effectiveEnvelope, onAcpUpdate:
// producer.ingest, … })` spawns the harness). Provisioning is avoided with a repo-less
// envelope, spawn is a real dependency-free echo harness that captures its stdin, and
// the AgentInstance producer's SDK is a recording fake. It asserts:
//   - the SEEDED continuation prompt reaches the harness stdin, while
//   - the AgentInstance producer's opening CONFIGURATION turn still carries the
//     ORIGINAL system prompt, and
//   - each gate (NANO_AGENT_INSTANCE=off, producer-unavailable, NANO_AGENT_RESUME=off
//     kill switch, and a non-external job) falls through to the ORIGINAL envelope so
//     the harness stdin carries the original — unseeded — prompt.
//
// LIMIT (honest scope): `driveResumeWiring` reproduces `workAgent`'s ordering against
// the real collaborators rather than invoking the ~1000-line `workAgent` itself (which
// is welded to activation, provisioning, relay, and abort-recheck machinery this test
// deliberately avoids). That means the integration test above proves the COLLABORATORS
// compose correctly, but a regression in `workAgent`'s OWN wiring — handing `runAgentJob`
// the original `envelope` instead of `effectiveEnvelope`, or minting the producer from
// the seeded envelope — would be invisible to it. The `workAgent resume wiring is pinned
// at the source` test below closes exactly that gap: it scans the production source and
// asserts the real runner mints the producer from the ORIGINAL `envelope`, threads
// `resolveEffectiveEnvelope`'s result into `effectiveEnvelope`, and passes
// `envelope: effectiveEnvelope` to `runAgentJob` — so the two together catch both a
// collaborator regression AND a runner-wiring swap (the repo has no ESLint, so a
// source-scanning `node --test` guard is the established pattern; cf.
// supervisor-engine-sdk-preference.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentJob } from './c8ctl-plugin.js';
import { resolveEffectiveEnvelope } from './agent-resume.mjs';
import { createAgentInstanceProducer, isExternalAgentJob } from './agent-instance.mjs';

const nullLogger = { info() {}, warn() {}, debug() {} };

const ORIGINAL_PROMPT = 'You are a senior engineering agent. Implement issue #248 end to end.';
const TRANSCRIPT_TEXT = '[ASSISTANT] I already opened the PR and pushed one commit.';

// A minimal AgentHistory the injected `readPrior` returns — one real work turn, so
// `hasResumableTranscript` treats it as resumable (a CONFIGURATION-only history is not).
const PRIOR = { text: TRANSCRIPT_TEXT, historyCount: 1 };

// An external agent job (lease token + elementInstanceKey → `isExternalAgentJob`), so
// the producer is minted and the resume path is eligible — exactly the shape workAgent
// gates on.
const EXTERNAL_JOB = {
  jobKey: '47814',
  type: 'senior:feature',
  leaseToken: 'FENCE-248',
  elementInstanceKey: 'EIK-248',
  elementId: 'implement-task',
  processInstanceKey: '47811',
  variables: {},
  customHeaders: {},
};

const PROFILE = (echoScript) => ({
  name: 'copilot',
  rank: 'senior',
  model: 'Opus 4.8',
  capabilities: ['feature'],
  // A real, dependency-free harness: dump stdin verbatim to the file named by the
  // NANO_TEST_CAPTURE env var, then exit 0. This makes `runAgentJob`'s spawn a genuine
  // process (not a stub) whose stdin we can read back to assert what reached it. The
  // capture path rides an env var (not a structured `--arg`) DELIBERATELY: `runAgentJob`
  // rejects a non-empty `args` on the host path on Windows (c8ctl-plugin.js — POSIX
  // single-quoted `--arg` tokens cmd.exe won't honour), so a structured-args harness
  // would fail every case on Windows before the echo ran. An env var keeps the profile
  // command args-free, so these integration tests run identically on every platform.
  //
  // The command runs through `runAgentJob`'s `shell: true`, so both the executable and
  // the script path are QUOTED: `process.execPath` is the current node binary (not a
  // bare `node` that may be off-PATH), and `JSON.stringify` emits a double-quoted,
  // backslash-escaped token the shell won't word-split — so a `TMPDIR` (or install
  // path) containing spaces, or Windows' backslash separators, can't break the spawn.
  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(echoScript)}`,
});

// A repo-less envelope: `workAgent` computes `hasRepo = !isContainer &&
// envelope.repository?.url`, so with no `repository` block provisioning is skipped and
// the harness runs in the launch cwd — no clone/push. Carries the original task prompt.
const baseEnvelope = () => ({ task: { prompt: ORIGINAL_PROMPT }, setup: {} });

// A recording fake of the host `@camunda8` SDK client the producer mints against, so we
// can inspect the exact CONFIGURATION turn it submits (mirrors agent-instance.test.mjs).
function fakeCamunda() {
  const calls = { create: [], update: [] };
  return {
    calls,
    createAgentInstance: async (req) => { calls.create.push(req); return { agentInstanceKey: 'AGENT-248' }; },
    updateAgentInstance: async (req) => { calls.update.push(req); return { createdHistory: Array.isArray(req.history) ? req.history : [] }; },
  };
}

let TMP;
let ECHO;
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'nano-resume-wiring-'));
  ECHO = join(TMP, 'echo-stdin.cjs');
  // Read all of stdin and write it verbatim to the path in NANO_TEST_CAPTURE, then
  // exit. Node core only (a .cjs file so `require` is available regardless of any
  // ambient package type). The capture path arrives via env (not argv) so the profile
  // command stays args-free — see PROFILE for why (Windows host-args rejection).
  writeFileSync(ECHO, [
    "const fs = require('node:fs');",
    'const out = process.env.NANO_TEST_CAPTURE;',
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    '  try { fs.writeFileSync(out, Buffer.concat(chunks)); } catch (e) { console.error(e); process.exit(1); }',
    '  process.exit(0);',
    '});',
  ].join('\n'));
});
test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// Reproduce `workAgent`'s hot-path resume wiring against the REAL collaborators, with
// the SAME ordering and option keys workAgent uses. Returns the captured harness stdin
// (parsed) plus the producer's recording SDK so a test can assert both ends.
async function driveResumeWiring({
  job = EXTERNAL_JOB,
  envelope = baseEnvelope(),
  agentInstanceOff = false,
  camunda = fakeCamunda(),
  env = {},
  readPrior = async () => PRIOR,
  containerMode = false,
} = {}) {
  const captureFile = join(TMP, `stdin-${Math.random().toString(36).slice(2)}.json`);
  const profile = PROFILE(ECHO);

  // #194: mint the durable AgentInstance producer from the ORIGINAL envelope (its
  // task.prompt seeds the CONFIGURATION turn's systemPrompt). Gated exactly like
  // workAgent: only for an external agent job and not when NANO_AGENT_INSTANCE=off.
  let producer = null;
  if (!agentInstanceOff && isExternalAgentJob(job)) {
    producer = createAgentInstanceProducer({ camunda, job, profile, envelope, logger: nullLogger });
    await producer.activate();
  }

  // The producer-unavailable gate workAgent computes from the live producer state.
  const producerUnavailable = !(producer?.active || producer?.retryPending);

  // #239: resolve the effective (possibly resume-seeded) envelope for the harness.
  const resumed = await resolveEffectiveEnvelope({
    envelope,
    job,
    camunda,
    agentInstanceOff,
    producerUnavailable,
    containerMode,
    env,
    logger: nullLogger,
    readPrior,
  });
  const effectiveEnvelope = resumed.envelope;

  // Spawn the harness with the EFFECTIVE envelope (seeded on a resume) and the
  // producer's ingest as onAcpUpdate — exactly workAgent's runOpts. The capture path
  // rides `extraEnv` (→ harness env), not a structured `--arg`, so the profile command
  // stays args-free and the harness runs identically on Windows (see PROFILE).
  const result = await runAgentJob(profile, job, {
    envelope: effectiveEnvelope,
    onAcpUpdate: producer ? (u) => producer.ingest(u) : undefined,
    timeoutMs: 30_000,
    idleTimeoutMs: 30_000,
    recoveryWindowMs: 5_000,
    extraEnv: { NANO_TEST_CAPTURE: captureFile },
  });

  assert.equal(result.ok, true, `harness should exit 0 (stderr: ${result.stderr})`);
  const stdin = JSON.parse(readFileSync(captureFile, 'utf8'));
  return { stdin, producer, camunda, resumed, effectiveEnvelope };
}

test('resume wiring: the SEEDED continuation prompt reaches the harness while the producer keeps the ORIGINAL system prompt', async () => {
  const { stdin, camunda, resumed } = await driveResumeWiring();

  // The resolver reported a resume with the injected history count.
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.historyCount, PRIOR.historyCount);

  // The harness stdin carries the SEEDED continuation prompt — the RESUMING preamble,
  // the prior transcript, AND the original instruction (as the continued task).
  assert.match(stdin.prompt, /You are RESUMING a job/);
  assert.ok(stdin.prompt.includes(TRANSCRIPT_TEXT), 'the prior transcript is folded into the harness prompt');
  assert.ok(stdin.prompt.includes(ORIGINAL_PROMPT), 'the original instruction is preserved as the continued task');
  assert.notEqual(stdin.prompt, ORIGINAL_PROMPT, 'the harness must NOT receive the bare original prompt on a resume');
  // Both prompt surfaces the harness may dispatch on carry the seeded prompt.
  assert.equal(stdin.task.task.prompt, stdin.prompt);

  // The AgentInstance producer was seeded from the ORIGINAL envelope: its opening
  // CONFIGURATION turn's systemPrompt is the ORIGINAL prompt, NOT the seeded one — so a
  // producer/gating swap (seeding the producer from the continuation) is caught here.
  assert.equal(camunda.calls.create.length, 1);
  const cfg = camunda.calls.create[0].history[0];
  assert.equal(cfg.role, 'CONFIGURATION');
  assert.deepEqual(cfg.systemPrompt, [{ contentType: 'TEXT', text: ORIGINAL_PROMPT }]);
});

test('resume gate: NANO_AGENT_INSTANCE=off falls through to the ORIGINAL envelope (no producer, cold harness prompt)', async () => {
  const { stdin, producer, camunda } = await driveResumeWiring({ agentInstanceOff: true });

  assert.equal(producer, null, 'no producer is minted when NANO_AGENT_INSTANCE=off');
  assert.equal(camunda.calls.create.length, 0);
  // The harness runs cold: the bare original prompt, never the RESUMING preamble.
  assert.equal(stdin.prompt, ORIGINAL_PROMPT);
  assert.doesNotMatch(stdin.prompt, /You are RESUMING a job/);
});

test('resume gate: an unavailable AgentInstance producer falls through to the ORIGINAL envelope', async () => {
  // An SDK client lacking createAgentInstance/updateAgentInstance mints only a disabled
  // producer facade (activate() → false), so `producerUnavailable` is true and resume
  // is gated off — exactly workAgent's round-4 gate.
  const { stdin, producer } = await driveResumeWiring({ camunda: { activateJobs() {} } });

  assert.equal(producer.active, false, 'the producer facade is inert without the SDK methods');
  assert.equal(stdin.prompt, ORIGINAL_PROMPT, 'an inert producer means no resume — cold harness prompt');
  assert.doesNotMatch(stdin.prompt, /You are RESUMING a job/);
});

test('resume gate: NANO_AGENT_RESUME=off kill switch falls through to the ORIGINAL envelope', async () => {
  const { stdin, camunda } = await driveResumeWiring({ env: { NANO_AGENT_RESUME: 'off' } });

  // The producer is still minted (resume off ≠ AgentInstance off), recording the
  // original prompt, but the harness runs cold.
  assert.equal(camunda.calls.create.length, 1);
  assert.equal(stdin.prompt, ORIGINAL_PROMPT);
  assert.doesNotMatch(stdin.prompt, /You are RESUMING a job/);
});

test('resume gate: a non-external job never resumes (falls through to the ORIGINAL envelope)', async () => {
  // A job with no lease token is not an external agent job, so no producer is minted and
  // resume is gated off regardless of the available prior transcript.
  const ordinaryJob = { jobKey: '1', type: 'ordinary', elementInstanceKey: 'EIK-x', variables: {}, customHeaders: {} };
  const { stdin, producer } = await driveResumeWiring({ job: ordinaryJob });

  assert.equal(producer, null, 'no producer for a non-external job');
  assert.equal(stdin.prompt, ORIGINAL_PROMPT);
  assert.doesNotMatch(stdin.prompt, /You are RESUMING a job/);
});

test('resume wiring: a read that yields no prior work cold-runs even for an eligible external job', async () => {
  // `readPrior` returning null (no prior transcript / empty history) means there is
  // nothing to continue — the resolver returns the original envelope unchanged, so the
  // harness runs cold even though the producer was minted.
  const { stdin, resumed, camunda } = await driveResumeWiring({ readPrior: async () => null });

  assert.equal(resumed.resumed, false);
  assert.equal(camunda.calls.create.length, 1, 'the producer is still minted');
  assert.equal(stdin.prompt, ORIGINAL_PROMPT);
  assert.doesNotMatch(stdin.prompt, /You are RESUMING a job/);
});

// The integration cases above drive the resume COLLABORATORS through a reproduced copy
// of workAgent's ordering; they cannot see a regression in workAgent's OWN wiring (e.g.
// handing runAgentJob the original `envelope` instead of `effectiveEnvelope`, or minting
// the producer from the seeded envelope). This source-scanning guard pins that wiring
// directly: workAgent must mint the producer from the ORIGINAL `envelope`, thread
// `resolveEffectiveEnvelope`'s output into `effectiveEnvelope`, and hand runAgentJob
// `envelope: effectiveEnvelope`. It fails the moment the runner swaps either envelope —
// the exact regression class the integration tests are blind to (the repo has no ESLint,
// so a source guard is the established pattern; cf. supervisor-engine-sdk-preference.test.mjs).
test('workAgent resume wiring is pinned at the source (producer←original, harness←effective)', () => {
  const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');

  // The AgentInstance producer is minted from the ORIGINAL envelope — its options object
  // names `envelope`, never the seeded `effectiveEnvelope`.
  const producerCall = src.match(/createAgentInstanceProducer\(\{[^}]*\}\)/);
  assert.ok(producerCall, 'workAgent must call createAgentInstanceProducer({ … })');
  assert.match(producerCall[0], /\benvelope\b/, 'the producer must be minted from the original `envelope`');
  assert.doesNotMatch(
    producerCall[0],
    /effectiveEnvelope/,
    'the producer must NOT be seeded from the resume-seeded `effectiveEnvelope`',
  );

  // `effectiveEnvelope` starts as the original and is (re)assigned from the resolver's
  // result — so the harness gets the seeded envelope on a resume and the original otherwise.
  assert.match(src, /let\s+effectiveEnvelope\s*=\s*envelope\s*;/, 'effectiveEnvelope must default to the original envelope');
  assert.match(src, /effectiveEnvelope\s*=\s*resumed\.envelope\s*;/, 'effectiveEnvelope must be threaded from resolveEffectiveEnvelope');
  assert.match(src, /resolveEffectiveEnvelope\(\{[^}]*\benvelope\b[^}]*\}\)/, 'the resolver must be fed the original envelope');

  // runAgentJob receives the EFFECTIVE (possibly seeded) envelope, never the bare original.
  assert.match(src, /envelope:\s*effectiveEnvelope\b/, 'runAgentJob must be handed `envelope: effectiveEnvelope`');
});
