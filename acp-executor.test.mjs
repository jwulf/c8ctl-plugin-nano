// Unit tests for the ACP (Agent Client Protocol) executor (#110, step 1 —
// "minimal mode"): spawnCaptureAcp drives an agent over JSON-RPC 2.0 on stdio,
// serialises session/update notifications to the existing relay/tee lane as
// human-readable TEXT (never tee'ing raw JSON-RPC), answers
// session/request_permission via the `permission` policy switch (yolo enforced;
// escalate/filter warned + interim-handled pending nano-workforce#559), and
// steers/cancels the live turn via attachSteer with NO node-pty.
//
// A tiny fake ACP agent (written to a temp file) speaks the same framing so the
// whole handshake → prompt → update → permission → result-file cycle runs
// end-to-end, mirroring the `runAgentJob (host) ...` tests in
// agent-workers.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  spawnCaptureAcp,
  ensureAcpFlag,
  runAgentJob,
  readAgentResultFile,
  normalizeTaskEnvelope,
} from './c8ctl-plugin.js';

// ---------------------------------------------------------------------------
// Fake ACP agent: newline-delimited JSON-RPC 2.0 over stdio. Behaviour is driven
// entirely by env vars so each test shapes the flow it needs. It NEVER writes
// non-JSON to stdout (that would corrupt the framing).
// ---------------------------------------------------------------------------
const FAKE_AGENT_SRC = `
import { writeFileSync } from 'node:fs';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const permTotal = Number(process.env.FAKE_PERM_COUNT || 0);
const emitUpdate = !!process.env.FAKE_EMIT_UPDATE;
const waitCancel = !!process.env.FAKE_WAIT_CANCEL;
const echoSteer = !!process.env.FAKE_ECHO_STEER;
const resultJson = process.env.FAKE_RESULT_JSON || '{"status":"converged","summary":"acp ok"}';
let promptId = null;
let permAcks = 0;
const chosen = [];

// FAKE_FLOOD: stream N newline-free bytes on stdout and stay alive. Exercises the
// executor's un-terminated-frame cap (it must kill us and fail, not buffer forever).
if (process.env.FAKE_FLOOD) {
  process.stdout.write('x'.repeat(Number(process.env.FAKE_FLOOD)));
  setInterval(() => {}, 3_600_000);
}

function writeResult(extra) {
  try {
    if (process.env.AGENT_RESULT_FILE) {
      const obj = JSON.parse(resultJson);
      if (chosen.length) obj.chosen = chosen;
      if (extra) Object.assign(obj, extra);
      writeFileSync(process.env.AGENT_RESULT_FILE, JSON.stringify(obj));
    }
  } catch { /* ignore */ }
}
function finish(stopReason, extra) {
  writeResult(extra);
  if (promptId != null) send({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
  setTimeout(() => process.exit(0), 10);
}
function nextPermOrFinish() {
  if (permAcks < permTotal) {
    send({ jsonrpc: '2.0', id: 1000 + permAcks, method: 'session/request_permission', params: {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't1', title: 'write file' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    } });
  } else {
    finish('end_turn');
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});

function handle(m) {
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }); return; }
  if (m.method === 'session/new') { send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-1' } }); return; }
  if (m.method === 'session/prompt') {
    if (promptId === null) {
      promptId = m.id;
      if (emitUpdate) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ACP' } } } });
      if (waitCancel) return;        // hold the turn open until session/cancel
      nextPermOrFinish();
    } else {
      // A mid-turn steer prompt (second session/prompt on the live session).
      const txt = (m.params && m.params.prompt && m.params.prompt[0] && m.params.prompt[0].text) || '';
      if (echoSteer) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STEERED:' + txt } } } });
        send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });  // ack the steer request
        finish('end_turn');                                                        // then close the main turn
      } else {
        send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
    }
    return;
  }
  if (m.method === 'session/cancel') {
    finish('cancelled', { cancelled: true, summary: 'acp cancelled' });
    return;
  }
  // A response to one of OUR (agent-issued) permission requests.
  if (m.id !== undefined && m.method === undefined && (m.result !== undefined || m.error !== undefined)) {
    const opt = m.result && m.result.outcome && m.result.outcome.optionId;
    if (opt !== undefined) chosen.push(opt);
    permAcks++;
    nextPermOrFinish();
  }
}
`;

const workRoot = mkdtempSync(join(tmpdir(), 'acp-test-'));
const FAKE_AGENT = join(workRoot, 'fake-acp-agent.mjs');
writeFileSync(FAKE_AGENT, FAKE_AGENT_SRC);

// Baseline env for a spawned fake agent. Individual tests layer FAKE_* knobs and
// AGENT_RESULT_FILE on top.
const baseEnv = () => ({ ...process.env });

// A relay tap that records every human text chunk and exposes the steer writer
// (as the cockpit would) so a test can drive steer/cancel with no PTY.
function makeRecordingTap() {
  const chunks = [];
  let steerWrite = null;
  return {
    chunks,
    getSteer: () => steerWrite,
    tap: {
      onData: (d) => { chunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')); },
      attachSteer: (write) => { steerWrite = write; return () => { steerWrite = null; }; },
    },
  };
}

test('ensureAcpFlag appends --acp only when ACP is not already selected', () => {
  assert.equal(ensureAcpFlag('copilot'), 'copilot --acp');
  assert.equal(ensureAcpFlag("node '/x/agent.mjs'"), "node '/x/agent.mjs' --acp");
  // Native / adapter invocations already name ACP — never doubled.
  assert.equal(ensureAcpFlag('copilot --acp'), 'copilot --acp');
  assert.equal(ensureAcpFlag('opencode acp'), 'opencode acp');
  assert.equal(ensureAcpFlag('claude-agent-acp'), 'claude-agent-acp');
  assert.equal(ensureAcpFlag('pi-acp'), 'pi-acp');
});

test('spawnCaptureAcp completes the ACP handshake and merges the result file', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1' },
      stdinData: JSON.stringify({ prompt: 'do the thing' }),
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.equal(result.exitCode, 0);
    // Result-file merge works exactly like the pipe path.
    assert.deepEqual(readAgentResultFile(resultFile), { status: 'converged', summary: 'acp ok' });
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('spawnCaptureAcp fails a run whose stdout frame never terminates (buffer cap)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // Emit >8 MiB with no newline so the cap trips before any frame parses.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_FLOOD: String(9 * 1024 * 1024) },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, false);
    assert.ok(/framing violation/i.test(result.error || ''), `expected framing-violation error, got: ${result.error}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('session/update notifications reach the relay tap as human text (raw JSON-RPC is never tee\'d)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeRecordingTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const relayed = rec.chunks.join('');
    assert.ok(relayed.includes('Hello ACP'), `expected relayed human text, got: ${JSON.stringify(rec.chunks)}`);
    // The relay lane must carry TEXT, not raw JSON-RPC frames.
    assert.ok(!relayed.includes('"jsonrpc"'), 'raw JSON-RPC must never be relayed');
    assert.ok(!relayed.includes('session/update'), 'raw method names must never be relayed');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('permission:yolo auto-allows session/request_permission and the turn proceeds', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_PERM_COUNT: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const merged = readAgentResultFile(resultFile);
    // The agent recorded which option the client selected: allow-always.
    assert.deepEqual(merged.chosen, ['allow_always']);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('interrupt steer (Ctrl-C) drives session/cancel with no PTY', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeRecordingTap();
  // Once the first update arrives (session established + steer attached), send ETX.
  const origOnData = rec.tap.onData;
  rec.tap.onData = (d) => {
    origOnData(d);
    const w = rec.getSteer();
    if (w) { w('\x03'); rec.tap.onData = origOnData; }
  };
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_WAIT_CANCEL: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const merged = readAgentResultFile(resultFile);
    assert.equal(merged.cancelled, true, 'the agent should have taken the session/cancel path');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('mid-turn steer text drives a fresh session/prompt (no PTY)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeRecordingTap();
  const origOnData = rec.tap.onData;
  rec.tap.onData = (d) => {
    origOnData(d);
    const w = rec.getSteer();
    if (w) { w('please refactor X\n'); rec.tap.onData = origOnData; }
  };
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_WAIT_CANCEL: '1', FAKE_ECHO_STEER: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const relayed = rec.chunks.join('');
    assert.ok(relayed.includes('STEERED:please refactor X'), `expected steer echo, got: ${JSON.stringify(rec.chunks)}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('escalate emits a one-time not-yet-enforced warning and still completes via the interim policy', async () => {
  const warnings = [];
  const prevC8ctl = globalThis.c8ctl;
  globalThis.c8ctl = {
    getLogger: () => ({
      info: () => {}, error: () => {}, debug: () => {}, output: () => {},
      warn: (m) => warnings.push(String(m)),
    }),
  };
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  try {
    const resultFile = join(resDir, 'result.json');
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // Two permission requests in one session — the warning must fire exactly once.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_PERM_COUNT: '2' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'escalate',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // Interim policy still allowed the requests (deferral is non-blocking).
    const merged = readAgentResultFile(resultFile);
    assert.deepEqual(merged.chosen, ['allow_always', 'allow_always']);
    // Non-silent: exactly one warning, naming the policy + the gating issue.
    const relevant = warnings.filter((w) => w.includes('not yet enforced'));
    assert.equal(relevant.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(relevant[0].includes("'escalate'"));
    assert.ok(relevant[0].includes('nano-workforce#559'));
  } finally {
    rmSync(resDir, { recursive: true, force: true });
    if (prevC8ctl === undefined) delete globalThis.c8ctl; else globalThis.c8ctl = prevC8ctl;
  }
});

test('filter is likewise warned once and interim-handled', async () => {
  const warnings = [];
  const prevC8ctl = globalThis.c8ctl;
  globalThis.c8ctl = {
    getLogger: () => ({
      info: () => {}, error: () => {}, debug: () => {}, output: () => {},
      warn: (m) => warnings.push(String(m)),
    }),
  };
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  try {
    const resultFile = join(resDir, 'result.json');
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_PERM_COUNT: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'filter',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const relevant = warnings.filter((w) => w.includes('not yet enforced'));
    assert.equal(relevant.length, 1);
    assert.ok(relevant[0].includes("'filter'"));
  } finally {
    rmSync(resDir, { recursive: true, force: true });
    if (prevC8ctl === undefined) delete globalThis.c8ctl; else globalThis.c8ctl = prevC8ctl;
  }
});

test('runAgentJob (host) dispatches protocol:acp end-to-end without node-pty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-job-'));
  try {
    const resultFile = join(dir, 'result.json');
    // The profile command IS the fake ACP agent; ensureAcpFlag appends --acp
    // (the fake ignores argv). No ptyFactory, no terminal:'pty' — proving the
    // ACP path needs no node-pty.
    const profile = { name: 'p', rank: 'senior', command: `node "${FAKE_AGENT}"`, model: '', capabilities: [], protocol: 'acp', permission: 'yolo' };
    const job = { jobKey: 'jk', type: 'senior', variables: {}, customHeaders: {} };
    const result = await runAgentJob(profile, job, {
      sandbox: 'none',
      envelope: normalizeTaskEnvelope({}, {}),
      timeoutMs: 20_000,
      resultFile,
      protocol: 'acp',
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // Result vars merge exactly as in pipe mode.
    assert.deepEqual(readAgentResultFile(resultFile), { status: 'converged', summary: 'acp ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => {
  try { if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
