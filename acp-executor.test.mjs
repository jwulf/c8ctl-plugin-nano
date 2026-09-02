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

// The canonical transcript seams — consumed through the single agentic import
// surface, the SAME `parseTranscriptEvent` / `deriveView` the cockpit uses and
// the SAME `acpUpdateToTranscriptChunk` producer bridge the executor uses. Tests
// assert on the derivation, never on a hand-rolled envelope shape.
import { transcript, sessionAcp } from './agentic.mjs';
// The shared ACP→transcript conformance corpus published by nanobpm/nano-ide#534:
// the pinned {update → chunk → typed event} vectors that hold this repo's producer
// in lock-step with the hub's parser.
import { ACP_TRANSCRIPT_VECTORS } from '@nanobpm/agentic/protocol/conformance';

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
const richUpdates = !!process.env.FAKE_RICH_UPDATES;
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
  // FAKE_HANG_AFTER_TURN: resolve the turn + write the result file, then DON'T
  // exit (ignore stdin EOF). The executor must force-reap us after the post-turn
  // grace and report that honestly (ok:true, but signal SIGKILL + forcedReap),
  // not a fabricated clean exit (code 0 / signal null).
  if (process.env.FAKE_HANG_AFTER_TURN) { setInterval(() => {}, 3_600_000); return; }
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
      // FAKE_RICH_UPDATES: emit one of every modelled update kind PLUS an
      // unmodelled kind, so the canonical transcript-chunk bridge and the
      // text-fallback (for the unmapped kind) can both be asserted.
      if (richUpdates) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'write file', status: 'pending', kind: 'edit' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', title: 'write file', status: 'completed' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'plan', entries: [{ content: 'step 1' }, { content: 'step 2' }] } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'available_commands_update', commands: ['/help'] } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all done' } } } });
      }
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
  // Qwen's ACP mode is a HIDDEN switch (`qwen --experimental-acp`, not in
  // `qwen --help` but present in the shipped cli.js). A switch whose flag name
  // ends in `-acp` selects ACP in ANY position, so it is never doubled — both
  // raw and after buildAgentCommandLine()'s POSIX single-quoting of `--arg`.
  assert.equal(ensureAcpFlag('qwen --experimental-acp'), 'qwen --experimental-acp');
  assert.equal(ensureAcpFlag("qwen '--experimental-acp'"), "qwen '--experimental-acp'");
  assert.equal(ensureAcpFlag('qwen "--experimental-acp"'), 'qwen "--experimental-acp"');
  // A GNU-style `--opt=value` selector names ACP in its option NAME — detected
  // by the option name (value stripped), so it is never doubled.
  assert.equal(ensureAcpFlag('copilot --acp=true'), 'copilot --acp=true');
  assert.equal(ensureAcpFlag('qwen --experimental-acp=true'), 'qwen --experimental-acp=true');
  assert.equal(ensureAcpFlag("qwen '--experimental-acp=1'"), "qwen '--experimental-acp=1'");
  // But a `--opt=value` whose VALUE (not name) ends in `-acp` is not a selector.
  assert.equal(ensureAcpFlag('copilot --model=foo-acp'), 'copilot --model=foo-acp --acp');
  // The adapter's real npm bin is `claude-code-acp` — also a `-acp` command token.
  assert.equal(ensureAcpFlag('claude-code-acp'), 'claude-code-acp');
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
  // A NON-switch token containing `=` must NOT be truncated to `acp` and
  // mis-detected as an ACP selector: a leading env assignment (`ACP=true`) or a
  // bare value (`acp=true`) is not a selector, so still append.
  assert.equal(ensureAcpFlag('ACP=true copilot'), 'ACP=true copilot --acp');
  assert.equal(ensureAcpFlag('copilot acp=true'), 'copilot acp=true --acp');
  assert.equal(ensureAcpFlag("copilot 'acp=true'"), "copilot 'acp=true' --acp");
  // A `*-acp` ADAPTER command preceded by a leading env-assignment prefix is
  // still the command token (not an argument), so ACP is already selected — do
  // NOT append. Env assignments only prefix the command; the adapter check must
  // land on the first non-assignment token, not blindly on token 0.
  assert.equal(ensureAcpFlag('ACP=true claude-code-acp'), 'ACP=true claude-code-acp');
  assert.equal(ensureAcpFlag('FOO=1 BAR=2 claude-agent-acp'), 'FOO=1 BAR=2 claude-agent-acp');
  assert.equal(ensureAcpFlag('DEBUG=1 pi-acp'), 'DEBUG=1 pi-acp');
  // But an env-prefixed NON-adapter command still needs the flag appended, and a
  // later `-acp`-suffixed argument does not count as the command token.
  assert.equal(ensureAcpFlag('ACP=true copilot --model foo-acp'), 'ACP=true copilot --model foo-acp --acp');
  // Regression: an env-assignment prefix whose VALUE is quoted and contains
  // spaces is a SINGLE shell word, so the `*-acp` command that follows must
  // still be detected (not doubled). A `\S+` tokenizer would split `FOO='a b'`
  // into `FOO='a` + `b'`, mis-aligning commandIndex and wrongly appending --acp.
  assert.equal(ensureAcpFlag("FOO='a b' claude-code-acp"), "FOO='a b' claude-code-acp");
  assert.equal(ensureAcpFlag('FOO="a b" claude-agent-acp'), 'FOO="a b" claude-agent-acp');
  assert.equal(ensureAcpFlag("A='x y' B='p q' pi-acp"), "A='x y' B='p q' pi-acp");
  // The same quoted-space env prefix in front of a NON-adapter command still
  // appends the flag (the command isn't an ACP selector).
  assert.equal(ensureAcpFlag("FOO='a b' copilot"), "FOO='a b' copilot --acp");
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

test('spawnCaptureAcp force-reaps a completed-but-hanging agent and reports the reap honestly', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const prevGrace = process.env.NANO_ACP_POST_TURN_GRACE_MS;
  // Shrink the post-turn grace so the reap happens promptly (not after 10s).
  process.env.NANO_ACP_POST_TURN_GRACE_MS = '150';
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // Turn resolves + result file written, but the agent never exits.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_HANG_AFTER_TURN: '1' },
      stdinData: JSON.stringify({ prompt: 'do the thing' }),
      timeoutMs: 20_000,
      permission: 'yolo',
    });
    // The turn completed and the result file is written → still a success...
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.deepEqual(readAgentResultFile(resultFile), { status: 'converged', summary: 'acp ok' });
    // ...but the child did NOT exit on its own, so the reap is reported honestly
    // rather than as a fabricated clean exit (code 0 / signal null).
    assert.equal(result.forcedReap, true, 'a force-reaped agent must set forcedReap');
    assert.equal(result.exitCode, null, 'a force-reaped agent has no natural exit code');
    assert.equal(result.signal, 'SIGKILL', 'a force-reaped agent is killed with SIGKILL');
  } finally {
    if (prevGrace === undefined) delete process.env.NANO_ACP_POST_TURN_GRACE_MS;
    else process.env.NANO_ACP_POST_TURN_GRACE_MS = prevGrace;
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

// ---------------------------------------------------------------------------
// #110 / nanobpm/nano-ide#534 — canonical transcript-chunk producer.
// ---------------------------------------------------------------------------

// A relay tap exposing the canonical transcript-chunk seam (relayTranscriptChunk)
// alongside the human-text lane (onData), mirroring runAgentJob's relaySession
// wiring. It captures the relayed chunk STRINGS and any text-fallback chunks
// separately, and derives a view through the shared parser so a test can assert
// the structured cockpit result (messages / tool cards) each update folds into.
function makeTypedTap() {
  const chunks = [];
  const textChunks = [];
  let steerWrite = null;
  const stored = () => chunks.map((chunk, offset) => ({ offset, chunk }));
  return {
    chunks,
    textChunks,
    // Fold the relayed chunks through the canonical parser + deriveView — exactly
    // what the cockpit does to render a rich transcript from the relay lane.
    derive: () => transcript.deriveViewFromChunks(stored()),
    events: () => stored().map((entry) => transcript.parseTranscriptEvent(entry)),
    getSteer: () => steerWrite,
    tap: {
      relayTranscriptChunk: (chunk) => { chunks.push(chunk); },
      onData: (d) => { textChunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')); },
      attachSteer: (write) => { steerWrite = write; return () => { steerWrite = null; }; },
    },
  };
}

test('red/green: the former {type,v} envelope derives raw-only; the canonical bridge derives structured', () => {
  // RED — the reported defect. The OLD hand-rolled grammar put the marker in
  // `type` and the version in `v`, so the cockpit's parser (`parseTranscriptEvent`)
  // finds no `nwfTranscriptEvent` KEY and retains every envelope as a raw
  // stream-chunk: 0 structured messages, byte-replay only ("No structured events
  // derived — raw replay only").
  const legacyEnvelope = JSON.stringify({ type: 'nwfTranscriptEvent', v: 1, ts: 0, kind: 'message', role: 'agent', text: 'Hello ACP' });
  const legacyView = transcript.deriveViewFromChunks([{ offset: 0, chunk: legacyEnvelope }]);
  assert.equal(legacyView.messages.length, 0, 'the {type,v} envelope must derive NO structured message (the reported defect)');
  assert.equal(legacyView.rawChunkCount, 1, 'the {type,v} envelope falls back to a raw stream-chunk');

  // GREEN — the canonical bridge emits the exact bytes the parser accepts, so the
  // SAME ACP update now derives a structured assistant message, not raw replay.
  const chunk = sessionAcp.acpUpdateToTranscriptChunk({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ACP' } });
  const view = transcript.deriveViewFromChunks([{ offset: 0, chunk }]);
  assert.equal(view.rawChunkCount, 0, 'the canonical chunk must NOT fall back to a raw stream-chunk');
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].role, 'assistant');
  assert.equal(view.messages[0].text, 'Hello ACP');
});

test('ACP transcript conformance vectors: our producer emits the pinned chunk that derives structured (#534)', () => {
  assert.ok(ACP_TRANSCRIPT_VECTORS.length > 0, 'the #534 conformance corpus must ship ACP transcript vectors');
  for (const vec of ACP_TRANSCRIPT_VECTORS) {
    // Our production seam IS `acpUpdateToTranscriptChunk` (via agentic.mjs): for a
    // canonical update it must emit the EXACT pinned chunk; for an `ignored` one, null.
    const chunk = sessionAcp.acpUpdateToTranscriptChunk(vec.update);
    if (vec.chunk == null) {
      assert.equal(chunk, null, `${vec.name}: an ignored update must produce no canonical chunk`);
      continue;
    }
    assert.equal(chunk, vec.chunk, `${vec.name}: producer must emit the pinned canonical chunk`);
    // And the pinned chunk parses back to a typed event — never a raw stream-chunk.
    const event = transcript.parseTranscriptEvent({ offset: vec.offset ?? 0, chunk });
    assert.notEqual(event.kind, 'stream-chunk', `${vec.name}: a canonical chunk must NOT derive raw`);
  }
});

test('session/update relays canonical transcript chunks that derive to structured messages/tool cards (rich cockpit)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_RICH_UPDATES: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);

    // Every canonical update is relayed as a transcript CHUNK carrying the
    // `nwfTranscriptEvent` marker KEY (not a hand-rolled {type,v} envelope).
    assert.ok(rec.chunks.length >= 4, `expected canonical chunks, got: ${JSON.stringify(rec.chunks)}`);
    for (const chunk of rec.chunks) {
      const parsed = JSON.parse(chunk);
      assert.equal(parsed.nwfTranscriptEvent, 1, `chunk must carry the canonical marker key: ${chunk}`);
      assert.ok(!chunk.includes('jsonrpc'), 'chunk must not carry raw JSON-RPC');
      assert.ok(!chunk.includes('session/update'));
    }

    // Folded through the canonical parser + deriveView (what the cockpit does), the
    // relayed chunks derive STRUCTURED messages + tool cards — NOT raw stream-chunk.
    const view = rec.derive();
    assert.equal(view.rawChunkCount, 0, 'no relayed chunk derives as a raw stream-chunk');

    // agent_message_chunk → assistant messages.
    assert.ok(view.messages.some((m) => m.role === 'assistant' && m.text === 'Hello ACP'));
    assert.ok(view.messages.some((m) => m.role === 'assistant' && m.text === 'all done'));
    // agent_thought_chunk folds to an assistant (reasoning) message.
    assert.ok(view.messages.some((m) => m.role === 'assistant' && m.text === 'thinking hard'));

    // tool_call + terminal tool_call_update → ONE tool card, its call paired to a result.
    assert.equal(view.tools.length, 1, `expected one tool card, got: ${JSON.stringify(view.tools)}`);
    const [card] = view.tools;
    assert.equal(card.name, 'write file');
    assert.equal(card.callId, 'tc-1');
    assert.ok(card.result, 'the terminal tool_call_update pairs a result onto the tool card');
    assert.equal(card.result.ok, true);

    // The unmodelled kinds (plan, available_commands_update) are `ignored` by the
    // bridge → no chunk; they take the text-fallback lane instead (nothing dropped).
    assert.ok(rec.textChunks.join('').includes('[available_commands_update]'));
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('an unmapped session/update falls back to the minimal text-chunk path (nothing dropped)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_RICH_UPDATES: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // Every relayed chunk is canonical (parses to a typed event, never raw).
    assert.ok(!rec.events().some((e) => e.kind === 'stream-chunk'), 'relayed chunks are all canonical, never raw');
    // The `ignored` kinds produced NO chunk but WERE emitted on the text-fallback
    // lane — so the update is never silently dropped.
    const fallbackText = rec.textChunks.join('');
    assert.ok(fallbackText.includes('[available_commands_update]'), `expected fallback text for the unmapped kind, got: ${JSON.stringify(rec.textChunks)}`);
    assert.ok(fallbackText.includes('[plan updated]'), 'the plan update takes the text fallback (canonical bridge ignores it)');
    // Mapped kinds did NOT double-emit onto the text lane (they went as chunks).
    assert.ok(!fallbackText.includes('Hello ACP'), 'mapped updates must not also hit the text fallback lane');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('a throwing transcript-chunk seam falls back to the text lane (nothing dropped)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  // A tap whose transcript seam always throws (a misbehaving downstream publisher).
  const textChunks = [];
  const tap = {
    relayTranscriptChunk: () => { throw new Error('boom'); },
    onData: (d) => { textChunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')); },
  };
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_RICH_UPDATES: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // The throwing transcript publish must not crash the worker, and every mapped
    // update must still reach the relay lane via the text fallback.
    const relayed = textChunks.join('');
    assert.ok(relayed.includes('Hello ACP'), `expected text fallback for a throwing transcript seam, got: ${JSON.stringify(textChunks)}`);
    assert.ok(relayed.includes('all done'));
    assert.ok(relayed.includes('thinking hard'));
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('with no transcript-chunk seam, every update falls back to human text (minimal-mode floor preserved)', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  // A PLAIN tap (onData only) — no relayTranscriptChunk. Mirrors a legacy/minimal relay.
  const chunks = [];
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_RICH_UPDATES: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: { onData: (d) => chunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')) },
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    const relayed = chunks.join('');
    // Every update — mapped and unmapped — lands as human text, exactly as step 1.
    assert.ok(relayed.includes('Hello ACP'));
    assert.ok(relayed.includes('all done'));
    assert.ok(relayed.includes('thinking hard'));
    assert.ok(relayed.includes('write file'));
    assert.ok(relayed.includes('[available_commands_update]'));
    // Still TEXT, never raw JSON-RPC.
    assert.ok(!relayed.includes('"jsonrpc"'));
    assert.ok(!relayed.includes('session/update'));
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('canonical transcript publishing leaves the captured result stdout (human text) intact', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1', FAKE_RICH_UPDATES: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // The result envelope's stdout still carries the human transcript (mirrored
    // locally) even though the relay lane carried canonical transcript chunks.
    assert.ok(result.stdout.includes('Hello ACP'), `expected human text in result.stdout, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(result.stdout.includes('thinking hard'));
    // Result-file merge is unchanged.
    assert.deepEqual(readAgentResultFile(resultFile), { status: 'converged', summary: 'acp ok' });
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #137: the transcript FLOOR. Some ACP agents (e.g. copilot 1.0.82 on omarchy/
// macbook) complete a turn without ever emitting a mappable `session/update`, so
// the canonical bridge never fires and the cockpit drill-in would show an empty
// session (only the lifecycle open marker from #136). When a resolved turn
// published zero canonical chunks, the executor synthesises ONE structured floor
// chunk — via the SAME `acpUpdateToTranscriptChunk` bridge — carrying the run's
// outcome (result summary, else stderr diagnostics, else a fixed note), so the
// drill-in shows something useful. The fake agent with NO FAKE_EMIT_UPDATE is
// exactly this "no mappable session/update" shape.
// ---------------------------------------------------------------------------

test('#137 floor: a completed turn that emits no session/update still derives a structured message from the result summary', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // No FAKE_EMIT_UPDATE / FAKE_RICH_UPDATES → the agent resolves the turn
      // WITHOUT emitting any session/update (the copilot 1.0.82 shape).
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_RESULT_JSON: '{"status":"opened","summary":"built the slice","pr":"o/r#7"}' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // Exactly ONE floor chunk reached the transcript-chunk seam (not zero — the
    // whole point — and not a flood; one structured card summarising the run).
    assert.equal(rec.chunks.length, 1, `expected a single floor chunk, got: ${JSON.stringify(rec.chunks)}`);
    // It carries the canonical marker KEY and is NOT raw JSON-RPC.
    const parsed = JSON.parse(rec.chunks[0]);
    assert.equal(parsed.nwfTranscriptEvent, 1, `floor chunk must carry the canonical marker key: ${rec.chunks[0]}`);
    assert.ok(!rec.chunks[0].includes('jsonrpc'));
    // Folded through the cockpit's parser + deriveView it is a STRUCTURED
    // assistant message (never a raw stream-chunk), carrying the run's outcome.
    const view = rec.derive();
    assert.equal(view.rawChunkCount, 0, 'the floor must NOT derive as a raw stream-chunk');
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].role, 'assistant');
    assert.ok(view.messages[0].text.includes('built the slice'), `floor should surface the result summary, got: ${view.messages[0].text}`);
    assert.ok(view.messages[0].text.includes('opened'), 'floor should surface the result status');
    assert.ok(view.messages[0].text.includes('o/r#7'), 'floor should surface the result PR');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('#137 floor: falls back to stderr diagnostics when the result carries no summary', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // Empty result object (no summary/status/pr) + a stderr diagnostic line.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_RESULT_JSON: '{}', FAKE_STDERR: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.equal(rec.chunks.length, 1, `expected a single floor chunk, got: ${JSON.stringify(rec.chunks)}`);
    const view = rec.derive();
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].role, 'assistant');
    assert.ok(view.messages[0].text.includes('acp-diag: hello from stderr'), `floor should surface stderr diagnostics, got: ${view.messages[0].text}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('#137 floor: emits a fixed explanatory note when there is neither a summary nor stderr', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_RESULT_JSON: '{}' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.equal(rec.chunks.length, 1);
    const view = rec.derive();
    assert.equal(view.messages.length, 1);
    assert.ok(/emitted no ACP session\/update/i.test(view.messages[0].text), `floor should carry the explanatory note, got: ${view.messages[0].text}`);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('#137 floor: does NOT fire when the agent already emitted a mappable session/update', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  const rec = makeTypedTap();
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      // A single real update → the canonical bridge fires; the floor must stay quiet.
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile, FAKE_EMIT_UPDATE: '1' },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: rec.tap,
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // Exactly the ONE real update's chunk — no extra synthesised floor.
    assert.equal(rec.chunks.length, 1, `expected only the real update chunk, got: ${JSON.stringify(rec.chunks)}`);
    const view = rec.derive();
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].text, 'Hello ACP', 'the real update, not a synthesised floor');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});

test('#137 floor: inert (no crash, nothing structured) when the relay exposes no transcript-chunk seam', async () => {
  const resDir = mkdtempSync(join(tmpdir(), 'acp-res-'));
  const resultFile = join(resDir, 'result.json');
  // A PLAIN tap (onData only) — no relayTranscriptChunk. The floor requires the
  // transcript-chunk seam, so it must stay inert here (minimal-mode preserved).
  const chunks = [];
  try {
    const result = await spawnCaptureAcp({
      command: 'node',
      args: [FAKE_AGENT],
      cwd: workRoot,
      env: { ...baseEnv(), AGENT_RESULT_FILE: resultFile },
      stdinData: 'prompt',
      timeoutMs: 20_000,
      relayTap: { onData: (d) => chunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')) },
      permission: 'yolo',
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    // No transcript-chunk seam → the floor cannot publish; nothing on the lane.
    assert.equal(chunks.join(''), '', 'a seamless relay stays empty (no floor, no crash)');
  } finally {
    rmSync(resDir, { recursive: true, force: true });
  }
});
