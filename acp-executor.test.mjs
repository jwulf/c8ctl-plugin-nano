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

// FAKE_BAD_FRAME: write a single non-JSON line to stdout then stay alive. The
// executor must treat this as a framing violation (kill + fail), not silently
// skip it and stall into an idle timeout.
if (process.env.FAKE_BAD_FRAME) {
  process.stdout.write('this is not json\\n');
  setInterval(() => {}, 3_600_000);
}

// FAKE_EARLY_EXIT: exit 0 during the handshake, before any session/prompt turn
// resolves. The executor must report ok:false WITH an explicit error explaining
// the early exit, not a confusing bare "exit code 0".
if (process.env.FAKE_EARLY_EXIT) {
  process.exit(0);
}

// FAKE_STDERR: emit a diagnostic line on stderr during startup, then complete
// the handshake normally. Exercises stderr being FORWARDED to the --stream tee
// and the relay lane (live observability), not merely captured post-hoc.
if (process.env.FAKE_STDERR) {
  process.stderr.write('acp-diag: hello from stderr\\n');
}

// FAKE_SPLIT_MULTIBYTE: emit one JSON-RPC frame carrying a multibyte-heavy text,
// but flush it to stdout as two raw byte writes that DELIBERATELY split a
// multibyte UTF-8 sequence across the chunk boundary. A naive per-chunk
// .toString('utf8') corrupts the code point (U+FFFD); a streaming decoder holds
// the partial sequence back and reassembles it intact.
function emitSplitMultibyte() {
  const frame = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'café ☃ 🚀 done' } } } }) + '\\n';
  const bytes = Buffer.from(frame, 'utf8');
  // Split near the middle, then nudge forward until the boundary lands INSIDE a
  // multibyte sequence (a continuation byte 0x80..0xBF starts the second chunk).
  let cut = Math.floor(bytes.length / 2);
  while (cut < bytes.length - 1 && (bytes[cut] & 0xc0) !== 0x80) cut++;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => { process.stdout.write(bytes.subarray(cut)); finish('end_turn'); }, 15);
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
  // FAKE_TAIL: after the turn resolves, leave a non-newline-terminated tail on
  // stdout, then exit 0. stdout is a pure newline-delimited JSON-RPC stream, so
  // the executor must treat this dangling frame as a framing violation (ok:false)
  // rather than a false success.
  if (process.env.FAKE_TAIL) process.stdout.write('{"jsonrpc":"2.0","dangling":true}');
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
      if (process.env.FAKE_SPLIT_MULTIBYTE) { emitSplitMultibyte(); return; }
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
  // Real dispatch: structured --arg tokens are POSIX single-quoted by
  // buildAgentCommandLine(), so the acp selector arrives quoted. Detection must
  // still see it and NOT double the switch.
  assert.equal(ensureAcpFlag("opencode 'acp'"), "opencode 'acp'");
  assert.equal(ensureAcpFlag("copilot '--acp'"), "copilot '--acp'");
  assert.equal(ensureAcpFlag("node '/x/agent.mjs' 'acp'"), "node '/x/agent.mjs' 'acp'");
  // A legacy profile.command may double-quote the selector instead — also unquote.
  assert.equal(ensureAcpFlag('copilot "--acp"'), 'copilot "--acp"');
  assert.equal(ensureAcpFlag('opencode "acp"'), 'opencode "acp"');
  // The `-acp` adapter suffix only counts on the COMMAND token; an argument that
  // merely ends in `-acp` is not an ACP selector, so still append.
  assert.equal(ensureAcpFlag('copilot --model foo-acp'), 'copilot --model foo-acp --acp');
  assert.equal(ensureAcpFlag("copilot '--model' 'foo-acp'"), "copilot '--model' 'foo-acp' --acp");
  // A path that merely contains `/acp/` is NOT an ACP selector — append.
  assert.equal(ensureAcpFlag('/opt/acp/bin/agent'), '/opt/acp/bin/agent --acp');
  assert.equal(ensureAcpFlag("'/opt/acp/bin/agent'"), "'/opt/acp/bin/agent' --acp");
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

test('spawnCaptureAcp forwards stderr to the --stream tee and the relay lane', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const teeLines = [];
  const relayed = [];
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_STDERR: '1' },
      stdinData: JSON.stringify({ prompt: 'do the thing' }),
      timeoutMs: 20_000,
      permission: 'yolo',
      stream: true,
      onStreamOut: (line) => teeLines.push(line),
      relayTap: { onData: (d) => relayed.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')) },
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // stderr is still captured for the result...
    assert.match(result.stderr, /acp-diag: hello from stderr/);
    // ...AND streamed live on both lanes (like pipe/PTY mode), not just captured.
    assert.ok(teeLines.some((l) => l.includes('acp-diag: hello from stderr')), 'stderr should reach the --stream tee');
    assert.ok(relayed.some((r) => r.includes('acp-diag: hello from stderr')), 'stderr should reach the relay lane');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('spawnCaptureAcp routes stderr to the onStreamErr sink (its own severity), not onStreamOut', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const outLines = [];
  const errLines = [];
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_STDERR: '1' },
      stdinData: JSON.stringify({ prompt: 'do the thing' }),
      timeoutMs: 20_000,
      permission: 'yolo',
      stream: true,
      onStreamOut: (line) => outLines.push(line),
      onStreamErr: (line) => errLines.push(line),
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // stderr must land on the dedicated error sink (warn/error severity)...
    assert.ok(errLines.some((l) => l.includes('acp-diag: hello from stderr')), 'stderr should reach onStreamErr');
    // ...and NOT be flattened onto the stdout sink when both are wired.
    assert.ok(!outLines.some((l) => l.includes('acp-diag: hello from stderr')), 'stderr must not reach onStreamOut when onStreamErr is provided');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('spawnCaptureAcp fails a run that leaves an un-terminated stdout tail at exit', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // Turn resolves, then a dangling non-newline-terminated frame is emitted.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_TAIL: '1' },
      stdinData: JSON.stringify({ prompt: 'do the thing' }),
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, false, 'a dangling stdout tail must not be reported as success');
    assert.equal(result.exitCode, 0);
    assert.ok(/framing violation/i.test(result.error || ''), `expected framing-violation error, got: ${result.error}`);
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

test('spawnCaptureAcp fails an early exit before the session/prompt turn resolves', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EARLY_EXIT: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 0);
    // An early exit must carry an explicit error, not a bare "exit code 0".
    assert.ok(/before the session\/prompt turn completed/i.test(result.error || ''), `expected early-exit error, got: ${result.error}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('spawnCaptureAcp fails fast on a non-JSON stdout line (framing violation)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_BAD_FRAME: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    assert.equal(result.ok, false);
    assert.ok(/framing violation/i.test(result.error || ''), `expected framing-violation error, got: ${result.error}`);
    assert.ok(/non-JSON/i.test(result.error || ''), `expected non-JSON detail, got: ${result.error}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('spawnCaptureAcp reassembles a multibyte UTF-8 sequence split across stdout chunks', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeRecordingTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_SPLIT_MULTIBYTE: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const relayed = rec.chunks.join('');
    // The frame parsed cleanly (a corrupted code point would have failed JSON.parse
    // and dropped the whole update) and the text arrived byte-perfect.
    assert.ok(relayed.includes('café ☃ 🚀 done'), `expected intact multibyte text, got: ${JSON.stringify(rec.chunks)}`);
    assert.ok(!relayed.includes('\uFFFD'), 'no replacement char — the split sequence must be reassembled, not mangled');
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
