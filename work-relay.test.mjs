// C3 (#42) — live-terminal relay on the agentic channel's relay lane, with
// steer-in, and per-role PTY-vs-pipe. Unit tests over the decoupled relay core
// (work-relay.mjs) and the PTY spawn/dispatch path (spawnCapturePty / runAgentJob),
// driven with a fake channel and a fake PTY so they run green on stock Node with
// no native build.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  relayStreamName,
  roleTerminalMode,
  parseInboundRelayChunk,
  createRelaySession,
  RELAY_OPEN_CHUNK,
  RELAY_CLOSE_CHUNK,
} from './work-relay.mjs';
import { runAgentJob, spawnCapturePty } from './c8ctl-plugin.js';

// ---- Fakes ----------------------------------------------------------------

// A fake WorkChannel exposing exactly C2's seam: relayLane() -> {relay} sink and
// client.onFrame for inbound frames. Records produced relay frames and lets a
// test emit inbound frames.
function fakeChannel() {
  const produced = [];
  let frameCb = null;
  return {
    relayLane: () => ({ relay: (stream, chunk) => produced.push({ stream, chunk }) }),
    client: {
      onFrame: (cb) => {
        frameCb = cb;
        return () => { if (frameCb === cb) frameCb = null; };
      },
    },
    produced,
    emit: (frame) => { if (frameCb) frameCb(frame); },
    get subscribed() { return frameCb != null; },
  };
}

// A fake node-pty factory: spawn() returns a terminal handle whose onData/onExit
// callbacks the test drives, and whose write() calls are recorded (steer-in +
// stdin payload land here).
function fakePtyFactory() {
  let term = null;
  return {
    spawn(command, args, opts) {
      const writes = [];
      let dataCb = null;
      let exitCb = null;
      let killed = false;
      term = {
        command,
        args,
        opts,
        pid: 4242,
        writes,
        get killed() { return killed; },
        onData: (cb) => { dataCb = cb; },
        onExit: (cb) => { exitCb = cb; },
        write: (d) => { writes.push(d); },
        resize: () => {},
        kill: () => { killed = true; },
        feed: (s) => { if (dataCb) dataCb(s); },
        exit: (exitCode, signal = 0) => { if (exitCb) exitCb({ exitCode, signal }); },
      };
      return term;
    },
    term: () => term,
  };
}

// ---- relayStreamName ------------------------------------------------------

test('relayStreamName derives one stream per job from the jobKey', () => {
  assert.equal(relayStreamName('4856'), 'job:4856');
  assert.equal(relayStreamName(4856), 'job:4856');
});

// ---- roleTerminalMode (vocab per-role opt-in) -----------------------------

test('roleTerminalMode honors the per-role setting, defaulting to pipe', () => {
  assert.equal(roleTerminalMode(undefined), 'pipe');
  assert.equal(roleTerminalMode({}), 'pipe');
  assert.equal(roleTerminalMode({ terminal: 'pty' }), 'pty');
  assert.equal(roleTerminalMode({ terminal: 'PTY' }), 'pty');
  assert.equal(roleTerminalMode({ terminal: 'pipe' }), 'pipe');
  assert.equal(roleTerminalMode({ terminal: 'nonsense' }), 'pipe');
  // boolean shorthand
  assert.equal(roleTerminalMode({ pty: true }), 'pty');
  assert.equal(roleTerminalMode({ pty: false }), 'pipe');
});

// ---- parseInboundRelayChunk ----------------------------------------------

test('parseInboundRelayChunk narrows only relay frames on the matching stream', () => {
  const stream = 'job:7';
  assert.equal(parseInboundRelayChunk({ family: 'relay', payload: { stream, offset: 0, chunk: 'hi' } }, stream), 'hi');
  // wrong stream
  assert.equal(parseInboundRelayChunk({ family: 'relay', payload: { stream: 'job:8', chunk: 'x' } }, stream), null);
  // wrong family
  assert.equal(parseInboundRelayChunk({ family: 'heartbeat', payload: { stream, chunk: 'x' } }, stream), null);
  // non-string chunk
  assert.equal(parseInboundRelayChunk({ family: 'relay', payload: { stream, chunk: 5 } }, stream), null);
  // junk
  assert.equal(parseInboundRelayChunk(null, stream), null);
  assert.equal(parseInboundRelayChunk({ family: 'relay' }, stream), null);
});

// ---- createRelaySession: produce (framed + jobKey-tagged) -----------------

test('relay() streams framed output tagged with the jobKey stream', () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '4856' });
  assert.equal(session.stream, 'job:4856');

  session.relay('line one\n');
  session.relay(Buffer.from('bytes-two'));
  session.relay(''); // empty is skipped
  session.relay(null); // null is skipped

  assert.deepEqual(ch.produced, [
    { stream: 'job:4856', chunk: RELAY_OPEN_CHUNK },
    { stream: 'job:4856', chunk: 'line one\n' },
    { stream: 'job:4856', chunk: 'bytes-two' },
  ]);
});

test('createRelaySession opens the stream with a lifecycle marker so the app correlates immediately', () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '4856' });
  // The very first produced frame is the open marker on this job's stream —
  // emitted at creation, before any agent output. This is what links
  // worker→jobKey in the app even for a silent agent.
  assert.deepEqual(ch.produced, [{ stream: 'job:4856', chunk: RELAY_OPEN_CHUNK }]);
  const marker = JSON.parse(RELAY_OPEN_CHUNK);
  assert.equal(marker.kind, 'lifecycle');
  assert.equal(marker.phase, 'open');
  session.close();
});

test('createRelaySession requires a channel with relayLane() and a jobKey', () => {
  assert.throws(() => createRelaySession({ channel: {}, jobKey: '1' }), /relayLane/);
  assert.throws(() => createRelaySession({ channel: fakeChannel(), jobKey: '' }), /jobKey/);
});

// ---- createRelaySession: steer-in ----------------------------------------

test('attachSteer routes inbound relay bytes on this stream to the writer', () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '99' });
  const got = [];
  const detach = session.attachSteer((chunk) => got.push(chunk));
  assert.equal(ch.subscribed, true);

  // matching stream → delivered
  ch.emit({ family: 'relay', payload: { stream: 'job:99', offset: 0, chunk: 'up\x1b[A' } });
  // other stream → ignored
  ch.emit({ family: 'relay', payload: { stream: 'job:1', chunk: 'nope' } });
  // other family → ignored
  ch.emit({ family: 'blackboard', payload: { stream: 'job:99', chunk: 'nope' } });

  assert.deepEqual(got, ['up\x1b[A']);

  // detach stops delivery
  detach();
  assert.equal(ch.subscribed, false);
  ch.emit({ family: 'relay', payload: { stream: 'job:99', chunk: 'after-detach' } });
  assert.deepEqual(got, ['up\x1b[A']);
});

test('close() detaches the steer subscription', () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '5' });
  session.attachSteer(() => {});
  assert.equal(ch.subscribed, true);
  session.close();
  assert.equal(ch.subscribed, false);
});

// ---- createRelaySession: close emits phase:close + drains (fixes #150) -----

// A fake WorkChannel that also models C4's outbound buffer via a controllable
// buffered() count, so the drain-before-completion path is exercisable.
function bufferedChannel({ initialBuffered = 0 } = {}) {
  const produced = [];
  let buffered = initialBuffered;
  return {
    relayLane: () => ({ relay: (stream, chunk) => produced.push({ stream, chunk }) }),
    client: { onFrame: () => () => {} },
    produced,
    buffered: () => buffered,
    setBuffered: (n) => { buffered = n; },
    get bufferedValue() { return buffered; },
  };
}

test('close() emits exactly one phase:close marker as the final frame and flushes every relayed chunk (fixes the truncated tail)', async () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '4242' });

  // Relay N chunks (the agent's live terminal), then the agent exits and the job
  // completes → close(). Today (pre-fix) there is no close frame and the tail can
  // be abandoned unsent; the fix emits phase:close and drains before completion.
  const N = 5;
  for (let i = 0; i < N; i += 1) session.relay(`chunk-${i}\n`);

  const res = await session.close();
  assert.equal(res.closeEmitted, true);
  assert.equal(res.drained, true);
  assert.equal(res.timedOut, false);

  // Every relayed chunk was carried on the stream (no truncated tail).
  for (let i = 0; i < N; i += 1) {
    assert.ok(ch.produced.some((f) => f.stream === 'job:4242' && f.chunk === `chunk-${i}\n`), `chunk-${i} flushed`);
  }
  // Exactly one phase:close marker, and it is the final frame on the stream.
  const closeFrames = ch.produced.filter((f) => f.chunk === RELAY_CLOSE_CHUNK);
  assert.equal(closeFrames.length, 1);
  assert.equal(ch.produced.at(-1).chunk, RELAY_CLOSE_CHUNK);
  assert.equal(ch.produced.at(-1).stream, 'job:4242');
  // The marker is a canonical lifecycle/close event (single-sourced encode).
  const marker = JSON.parse(RELAY_CLOSE_CHUNK);
  assert.equal(marker.kind, 'lifecycle');
  assert.equal(marker.phase, 'close');
});

test('close() awaits the outbound buffer draining to zero before it resolves', async () => {
  const ch = bufferedChannel({ initialBuffered: 3 });
  let clock = 0;
  const now = () => clock;
  // Each poll advances the clock and drains one buffered frame — the hub catching up.
  const sleep = async (ms) => { clock += ms; ch.setBuffered(Math.max(0, ch.bufferedValue - 1)); };

  const session = createRelaySession({
    channel: ch, jobKey: '1', drainTimeoutMs: 10_000, drainPollMs: 5, sleep, now,
  });
  const res = await session.close();

  assert.equal(res.drained, true);
  assert.equal(res.timedOut, false);
  assert.equal(ch.bufferedValue, 0);
});

test('close() is bounded: a stalled sink times out and completes anyway rather than wedging the job', async () => {
  const ch = bufferedChannel({ initialBuffered: 5 });
  let clock = 0;
  const now = () => clock;
  // The hub is out: sleeping advances time but never drains the buffer.
  const sleep = async (ms) => { clock += ms; };

  const session = createRelaySession({
    channel: ch, jobKey: '2', drainTimeoutMs: 100, drainPollMs: 10, sleep, now,
  });
  const res = await session.close();

  // Resolves (never hangs) with the timeout signalled; the close marker still went out.
  assert.equal(res.closeEmitted, true);
  assert.equal(res.drained, false);
  assert.equal(res.timedOut, true);
  assert.ok(ch.produced.some((f) => f.chunk === RELAY_CLOSE_CHUNK));
});

test('close() is idempotent: a second call re-emits nothing and does not re-drain', async () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '77' });
  await session.close();
  const afterFirst = ch.produced.length;
  const closeCount = ch.produced.filter((f) => f.chunk === RELAY_CLOSE_CHUNK).length;
  assert.equal(closeCount, 1);

  const res = await session.close();
  assert.equal(res.closeEmitted, true);
  assert.equal(ch.produced.length, afterFirst);
  assert.equal(ch.produced.filter((f) => f.chunk === RELAY_CLOSE_CHUNK).length, 1);
});

test('close() drains without a buffered() accessor (older channel) and never throws', async () => {
  // The bare fakeChannel exposes no buffered() — close() must treat it as already
  // drained rather than block or crash.
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '88' });
  const res = await session.close();
  assert.equal(res.drained, true);
  assert.equal(res.timedOut, false);
});

// ---- spawnCapturePty: PTY allocation + relay + steer ----------------------

test('spawnCapturePty streams terminal output on the relay lane and accepts steer-in', async () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '123' });
  const relayTap = {
    onData: (buf) => session.relay(buf),
    attachSteer: (write) => session.attachSteer(write),
  };
  const pf = fakePtyFactory();

  const p = spawnCapturePty({
    command: 'sh',
    args: ['-c', 'agent'],
    stdinData: '{"payload":true}',
    ptyFactory: pf,
    relayTap,
  });

  const term = pf.term();
  assert.ok(term, 'a PTY was allocated');
  // stdin payload delivered on the PTY, followed by EOT (Ctrl-D)
  assert.equal(term.writes[0], '{"payload":true}');
  assert.equal(term.writes[1], '\x04');

  // terminal output is framed + jobKey-tagged on the relay lane (after the
  // session-open marker emitted at createRelaySession time)
  term.feed('hello from the agent');
  assert.deepEqual(ch.produced, [
    { stream: 'job:123', chunk: RELAY_OPEN_CHUNK },
    { stream: 'job:123', chunk: 'hello from the agent' },
  ]);

  // steer-in: a cockpit relay frame on this job's stream reaches the PTY
  ch.emit({ family: 'relay', payload: { stream: 'job:123', chunk: '\x03' } });
  assert.equal(term.writes.at(-1), '\x03');

  term.exit(0);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello from the agent/);

  session.close();
});

test('spawnCapturePty reports node-pty absence rather than crashing', async () => {
  const result = await spawnCapturePty({ command: 'sh', args: ['-c', 'true'], ptyFactory: { notAFactory: true } });
  assert.equal(result.ok, false);
  assert.match(result.error, /node-pty is not available/);
});

// ---- runAgentJob dispatch: pty role vs pipe role --------------------------

const PROFILE = { name: 'coder', rank: 'senior', command: 'agentcmd', args: [], model: '', capabilities: [] };

test('runAgentJob(terminal: pty) runs the harness on a PTY and relays tagged output', async () => {
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '777' });
  const pf = fakePtyFactory();
  const job = { jobKey: '777', type: 'senior:feature', variables: {} };

  const p = runAgentJob(PROFILE, job, {
    terminal: 'pty',
    relaySession: session,
    ptyFactory: pf,
    envelope: null,
  });

  const term = pf.term();
  assert.ok(term, 'PTY dispatch allocated a terminal');
  // sh -c <commandLine> was the spawned program
  assert.equal(term.command, 'sh');
  assert.deepEqual(term.args, ['-c', 'agentcmd']);
  // payload + EOT written to the PTY
  assert.match(String(term.writes[0]), /"jobKey":"777"/);
  assert.equal(term.writes[1], '\x04');

  // steer-in reaches the PTY
  ch.emit({ family: 'relay', payload: { stream: 'job:777', chunk: 'steer' } });
  assert.equal(term.writes.at(-1), 'steer');

  // output relayed, tagged with the jobKey stream (after the session-open marker)
  term.feed('working...');
  assert.deepEqual(ch.produced, [
    { stream: 'job:777', chunk: RELAY_OPEN_CHUNK },
    { stream: 'job:777', chunk: 'working...' },
  ]);

  term.exit(0);
  const result = await p;
  assert.equal(result.ok, true);
  assert.match(result.stdout, /working\.\.\./);
  session.close();
});

test('runAgentJob(terminal: pipe) relays output without a PTY', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell required');
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '888' });
  const pf = fakePtyFactory();
  const job = { jobKey: '888', type: 'senior:feature', variables: {} };

  const result = await runAgentJob(
    { ...PROFILE, command: "printf 'pipe-output'" },
    job,
    { terminal: 'pipe', relaySession: session, ptyFactory: pf, envelope: null },
  );

  // the PTY factory was NOT used for a pipe role
  assert.equal(pf.term(), null);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /pipe-output/);
  // output was relayed on the job's stream
  assert.ok(ch.produced.some((f) => f.stream === 'job:888' && /pipe-output/.test(f.chunk)));
  session.close();
});

test('runAgentJob(terminal: pty) falls back to a pipe when node-pty is unavailable', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell required');
  // No ptyFactory injected and node-pty is an (uninstalled) optionalDependency,
  // so the PTY path is unavailable → graceful pipe fallback that still relays.
  const ch = fakeChannel();
  const session = createRelaySession({ channel: ch, jobKey: '901' });
  const job = { jobKey: '901', type: 'senior:feature', variables: {} };

  const result = await runAgentJob(
    { ...PROFILE, command: "printf 'fallback'" },
    job,
    { terminal: 'pty', relaySession: session, envelope: null },
  );

  assert.equal(result.ok, true);
  assert.match(result.stdout, /fallback/);
  assert.ok(ch.produced.some((f) => f.stream === 'job:901' && /fallback/.test(f.chunk)));
  session.close();
});
