// Unit tests for the worker-supervisor pure helpers (see the `supervisor`
// command). These cover the deterministic, side-effect-free pieces: work-flag
// reconstruction, unique worker-id assignment, restart backoff, the control
// socket's newline-delimited JSON framing, the status summariser, and the
// status table renderer. The daemon/socket/attach lifecycle is I/O-bound and is
// exercised separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconstructWorkArgs,
  supervisorWorkerId,
  supervisorBackoffMs,
  encodeFrame,
  decodeFrames,
  formatDuration,
  summarizeSupervisorWorker,
  formatSupervisorStatus,
  WORK_FORWARD_FLAGS,
} from './c8ctl-plugin.js';

// --- reconstructWorkArgs ---------------------------------------------------

test('reconstructWorkArgs emits value flags as --flag value', () => {
  assert.deepEqual(
    reconstructWorkArgs({ 'max-parallel': '2', 'job-timeout': '600000' }),
    ['--max-parallel', '2', '--job-timeout', '600000'],
  );
});

test('reconstructWorkArgs emits boolean flags only when true, with no value', () => {
  assert.deepEqual(reconstructWorkArgs({ stream: true, 'keep-runs': false }), ['--stream']);
  assert.deepEqual(reconstructWorkArgs({ stream: 'true' }), ['--stream']);
});

test('reconstructWorkArgs repeats list flags once per item', () => {
  assert.deepEqual(
    reconstructWorkArgs({ 'job-type': ['a:b', 'c:d'], env: 'X=1' }),
    ['--env', 'X=1', '--job-type', 'a:b', '--job-type', 'c:d'],
  );
});

test('reconstructWorkArgs ignores unknown flags and empty strings', () => {
  assert.deepEqual(reconstructWorkArgs({ nope: 'x', sandbox: '' }), []);
  assert.deepEqual(reconstructWorkArgs(null), []);
  assert.deepEqual(reconstructWorkArgs('not an object'), []);
});

test('reconstructWorkArgs forwards the container sandbox pair', () => {
  assert.deepEqual(
    reconstructWorkArgs({ sandbox: 'docker', image: 'ghcr.io/acme/agent:1' }),
    ['--sandbox', 'docker', '--image', 'ghcr.io/acme/agent:1'],
  );
});

test('WORK_FORWARD_FLAGS never includes non-work flags like port or worker', () => {
  assert.ok(!('port' in WORK_FORWARD_FLAGS));
  assert.ok(!('worker' in WORK_FORWARD_FLAGS));
  assert.ok(!('attach' in WORK_FORWARD_FLAGS));
});

// --- supervisorWorkerId ----------------------------------------------------

test('supervisorWorkerId returns the bare profile when free', () => {
  assert.equal(supervisorWorkerId('reviewer', new Set()), 'reviewer');
});

test('supervisorWorkerId disambiguates duplicates with #N', () => {
  assert.equal(supervisorWorkerId('reviewer', new Set(['reviewer'])), 'reviewer#2');
  assert.equal(supervisorWorkerId('reviewer', new Set(['reviewer', 'reviewer#2'])), 'reviewer#3');
});

test('supervisorWorkerId accepts an array of taken ids and falls back on blanks', () => {
  assert.equal(supervisorWorkerId('coder', ['coder']), 'coder#2');
  assert.equal(supervisorWorkerId('', new Set()), 'worker');
});

// --- supervisorBackoffMs ---------------------------------------------------

test('supervisorBackoffMs grows exponentially and caps', () => {
  assert.equal(supervisorBackoffMs(0), 1000);
  assert.equal(supervisorBackoffMs(1), 2000);
  assert.equal(supervisorBackoffMs(2), 4000);
  assert.equal(supervisorBackoffMs(5), 30000); // 32000 capped to 30000
  assert.equal(supervisorBackoffMs(100), 30000);
  assert.equal(supervisorBackoffMs(-3), 1000);
});

// --- framing ---------------------------------------------------------------

test('encodeFrame terminates each frame with a single newline', () => {
  const s = encodeFrame({ op: 'status' });
  assert.equal(s, '{"op":"status"}\n');
});

test('decodeFrames parses complete frames and keeps the remainder', () => {
  const { frames, rest } = decodeFrames('{"a":1}\n{"b":2}\n{"c":3');
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":3');
});

test('decodeFrames skips blank and malformed lines without throwing', () => {
  const { frames, rest } = decodeFrames('\n{"ok":true}\nnot-json\n');
  assert.deepEqual(frames, [{ ok: true }]);
  assert.equal(rest, '');
});

test('encode → decode round-trips an object', () => {
  const obj = { op: 'add', profile: 'reviewer', args: ['--max-parallel', '2'] };
  const { frames } = decodeFrames(encodeFrame(obj));
  assert.deepEqual(frames[0], obj);
});

// --- formatDuration --------------------------------------------------------

test('formatDuration humanises compactly', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(3_660_000), '1h1m');
  assert.equal(formatDuration(90_000_000), '1d1h');
});

// --- summarizeSupervisorWorker --------------------------------------------

test('summarizeSupervisorWorker marks a dead pid as down with no uptime', () => {
  // pid 1 is init/launchd — alive but not us; use a pid that cannot exist.
  const row = summarizeSupervisorWorker(
    { id: 'reviewer', profile: 'reviewer', pid: 2 ** 30, startedAt: new Date().toISOString(), restarts: 3, lastExit: 'code 1' },
  );
  assert.equal(row.state, 'down');
  assert.equal(row.pid, null);
  assert.equal(row.uptimeMs, 0);
  assert.equal(row.restarts, 3);
  assert.equal(row.lastExit, 'code 1');
});

test('summarizeSupervisorWorker reports a live pid as running with uptime', () => {
  const now = Date.now();
  const row = summarizeSupervisorWorker(
    { id: 'self', profile: 'p', pid: process.pid, startedAt: new Date(now - 5000).toISOString(), restarts: 0 },
    now,
  );
  assert.equal(row.state, 'running');
  assert.equal(row.pid, process.pid);
  assert.ok(row.uptimeMs >= 5000 && row.uptimeMs < 6000);
});

test('summarizeSupervisorWorker reports a stopping worker distinctly', () => {
  const row = summarizeSupervisorWorker({ id: 'x', profile: 'p', pid: process.pid, stopping: true });
  assert.equal(row.state, 'stopping');
});

// --- formatSupervisorStatus ------------------------------------------------

test('formatSupervisorStatus renders a header and a row per worker', () => {
  const now = Date.now();
  const text = formatSupervisorStatus({
    daemon: { pid: process.pid, startedAt: new Date(now).toISOString(), socket: '/tmp/x.sock' },
    workers: [
      summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, startedAt: new Date(now - 1000).toISOString(), restarts: 0 }, now),
      summarizeSupervisorWorker({ id: 'coder', profile: 'coder', pid: 2 ** 30, restarts: 2, lastExit: 'code 1' }, now),
    ],
  });
  assert.match(text, /daemon pid:/);
  assert.match(text, /PROFILE/);
  assert.match(text, /reviewer/);
  assert.match(text, /coder/);
  assert.match(text, /code 1/);
});

test('formatSupervisorStatus guides the operator when there are no workers', () => {
  const text = formatSupervisorStatus({ daemon: { pid: process.pid }, workers: [] });
  assert.match(text, /No workers/);
  assert.match(text, /supervisor add/);
});
