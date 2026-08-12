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
  autoWorkerName,
  sanitizeNameToken,
  isValidWorkerName,
  randomNameSuffix,
  extractNameFlag,
  parseInstancesCount,
  extractInstancesFlag,
  redactWorkArgs,
  supervisorBackoffMs,
  encodeFrame,
  decodeFrames,
  formatDuration,
  summarizeSupervisorWorker,
  formatSupervisorStatus,
  supervisorStatusSignature,
  supervisorJobCell,
  supervisorWorkerActivityFile,
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

// --- sanitizeNameToken -----------------------------------------------------

test('sanitizeNameToken lowercases nothing but strips unsafe chars and trims separators', () => {
  assert.equal(sanitizeNameToken('reviewer', 'x'), 'reviewer');
  assert.equal(sanitizeNameToken('My Worker!', 'x'), 'My-Worker');
  assert.equal(sanitizeNameToken('  --weird__name--  ', 'x'), 'weird__name');
});

test('sanitizeNameToken falls back when the result would be empty', () => {
  assert.equal(sanitizeNameToken('', 'fallback'), 'fallback');
  assert.equal(sanitizeNameToken('***', 'fallback'), 'fallback');
  assert.equal(sanitizeNameToken(null, 'fallback'), 'fallback');
});

// --- isValidWorkerName -----------------------------------------------------

test('isValidWorkerName accepts safe id tokens (trimmed)', () => {
  assert.equal(isValidWorkerName('reviewer'), true);
  assert.equal(isValidWorkerName('reviewer-eu.2_beta'), true);
  assert.equal(isValidWorkerName('  reviewer  '), true); // trimmed first
});

test('isValidWorkerName rejects blanks, non-strings, and unsafe chars', () => {
  assert.equal(isValidWorkerName(''), false);
  assert.equal(isValidWorkerName('   '), false);
  assert.equal(isValidWorkerName(null), false);
  assert.equal(isValidWorkerName(123), false);
  // `:` would corrupt the broker `‹name›:‹jobType›` form:
  assert.equal(isValidWorkerName('faker:1'), false);
  // path separators / traversal must never reach a log filename:
  assert.equal(isValidWorkerName('a/b'), false);
  assert.equal(isValidWorkerName('../etc'), false);
  assert.equal(isValidWorkerName('has space'), false);
});

test('isValidWorkerName rejects names that would collide on the sanitized log file', () => {
  // `faker:1` and `faker_1` both sanitize to worker-faker_1.log; rejecting the
  // former (`:` unsafe) prevents two distinct workers sharing one log file.
  assert.equal(isValidWorkerName('faker:1'), false);
  assert.equal(isValidWorkerName('faker_1'), true);
});

// --- randomNameSuffix ------------------------------------------------------

test('randomNameSuffix is a lowercase hex string of the requested byte length', () => {
  assert.match(randomNameSuffix(4), /^[0-9a-f]{8}$/);
  assert.match(randomNameSuffix(2), /^[0-9a-f]{4}$/);
});

// --- autoWorkerName --------------------------------------------------------

test('autoWorkerName builds ‹short-host›-‹profile›-‹random› with injected parts', () => {
  assert.equal(
    autoWorkerName('reviewer', { host: 'MBP.local', rand: () => 'abcd' }),
    'mbp-reviewer-abcd',
  );
});

test('autoWorkerName uses the first dot-label of the host, lowercased', () => {
  assert.equal(
    autoWorkerName('coder', { host: 'Build-Box.eu.example.com', rand: () => '01ff' }),
    'build-box-coder-01ff',
  );
});

test('autoWorkerName sanitizes each segment and applies fallbacks', () => {
  assert.equal(autoWorkerName('', { host: '', rand: () => '' }), 'host-worker-0');
});

test('autoWorkerName varies with the random suffix (distinct rand → distinct name)', () => {
  // Deterministic: inject a rand that yields two distinct suffixes and assert the
  // suffix drives the name apart — the property that keeps two same-profile
  // workers distinct — without relying on probability.
  const seq = ['aaaa', 'bbbb'];
  let i = 0;
  const rand = () => seq[i++];
  const a = autoWorkerName('reviewer', { host: 'h', rand });
  const b = autoWorkerName('reviewer', { host: 'h', rand });
  assert.equal(a, 'h-reviewer-aaaa');
  assert.equal(b, 'h-reviewer-bbbb');
  assert.notEqual(a, b);
});

// --- extractNameFlag -------------------------------------------------------

test('extractNameFlag pulls --name <val> out of the token list', () => {
  assert.deepEqual(
    extractNameFlag(['--name', 'alice', '--max-parallel', '2']),
    { name: 'alice', rest: ['--max-parallel', '2'] },
  );
});

test('extractNameFlag supports --name=val and -n forms', () => {
  assert.deepEqual(extractNameFlag(['--name=bob', '--stream']), { name: 'bob', rest: ['--stream'] });
  assert.deepEqual(extractNameFlag(['-n', 'carol']), { name: 'carol', rest: [] });
  assert.deepEqual(extractNameFlag(['-n=dave']), { name: 'dave', rest: [] });
});

test('extractNameFlag last occurrence wins and blanks yield undefined', () => {
  assert.deepEqual(extractNameFlag(['--name', 'a', '--name', 'b']), { name: 'b', rest: [] });
  assert.deepEqual(extractNameFlag(['--name']), { name: undefined, rest: [] });
  assert.deepEqual(extractNameFlag([]), { name: undefined, rest: [] });
  assert.deepEqual(extractNameFlag(null), { name: undefined, rest: [] });
});

// --- parseInstancesCount ---------------------------------------------------

test('parseInstancesCount defaults to 1 for absent/blank input', () => {
  assert.deepEqual(parseInstancesCount(undefined), { count: 1 });
  assert.deepEqual(parseInstancesCount(null), { count: 1 });
  assert.deepEqual(parseInstancesCount(''), { count: 1 });
  assert.deepEqual(parseInstancesCount('  '), { count: 1 });
});

test('parseInstancesCount accepts a positive whole number (string or number)', () => {
  assert.deepEqual(parseInstancesCount('3'), { count: 3 });
  assert.deepEqual(parseInstancesCount(5), { count: 5 });
  assert.deepEqual(parseInstancesCount(' 2 '), { count: 2 });
});

test('parseInstancesCount takes the last occurrence when repeated (array)', () => {
  assert.deepEqual(parseInstancesCount(['2', '4']), { count: 4 });
});

test('parseInstancesCount rejects non-integers, zero and negatives', () => {
  assert.ok(parseInstancesCount('0').error);
  assert.ok(parseInstancesCount('-1').error);
  assert.ok(parseInstancesCount('1.5').error);
  assert.ok(parseInstancesCount('abc').error);
  assert.ok(parseInstancesCount(true).error); // bare `--instances` with no value
});

test('parseInstancesCount rejects counts over the per-command cap', () => {
  assert.deepEqual(parseInstancesCount('64'), { count: 64 });
  assert.ok(parseInstancesCount('65').error);
});

// --- extractInstancesFlag --------------------------------------------------

test('extractInstancesFlag pulls --instances <val> out of the token list', () => {
  assert.deepEqual(
    extractInstancesFlag(['--instances', '3', '--max-parallel', '2']),
    { count: 3, rest: ['--max-parallel', '2'] },
  );
});

test('extractInstancesFlag supports --instances=val and leaves other flags intact', () => {
  assert.deepEqual(extractInstancesFlag(['--instances=4', '--stream']), { count: 4, rest: ['--stream'] });
});

test('extractInstancesFlag defaults to 1 when absent and forwards a trailing bare flag as absent', () => {
  assert.deepEqual(extractInstancesFlag(['--stream']), { count: 1, rest: ['--stream'] });
  assert.deepEqual(extractInstancesFlag(['--stream', '--instances']), { count: 1, rest: ['--stream'] });
  assert.deepEqual(extractInstancesFlag([]), { count: 1, rest: [] });
  assert.deepEqual(extractInstancesFlag(null), { count: 1, rest: [] });
});

test('extractInstancesFlag surfaces a validation error while still stripping the flag', () => {
  const r = extractInstancesFlag(['--instances', '0', '--stream']);
  assert.ok(r.error);
  assert.deepEqual(r.rest, ['--stream']);
});

// --- redactWorkArgs --------------------------------------------------------

test('redactWorkArgs masks --env values but preserves the name and other flags', () => {
  assert.deepEqual(
    redactWorkArgs(['--max-parallel', '2', '--env', 'TOKEN=s3cr3t', '--stream']),
    ['--max-parallel', '2', '--env', 'TOKEN=***', '--stream'],
  );
});

test('redactWorkArgs masks multiple --env values and a bare (=-less) value', () => {
  assert.deepEqual(
    redactWorkArgs(['--env', 'A=1', '--env', 'B=2', '--env', 'JUSTNAME']),
    ['--env', 'A=***', '--env', 'B=***', '--env', '***'],
  );
});

test('redactWorkArgs masks the inline --env=NAME=VALUE form', () => {
  assert.deepEqual(
    redactWorkArgs(['--env=TOKEN=s3cr3t', '--stream']),
    ['--env=TOKEN=***', '--stream'],
  );
  assert.deepEqual(redactWorkArgs(['--env=JUSTNAME']), ['--env=***']);
});

test('redactWorkArgs leaves argv without --env untouched and tolerates non-arrays', () => {
  assert.deepEqual(redactWorkArgs(['--sandbox', 'docker']), ['--sandbox', 'docker']);
  assert.deepEqual(redactWorkArgs(undefined), []);
  assert.deepEqual(redactWorkArgs(['--env']), ['--env']); // trailing flag, no value
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

// --- supervisorJobCell (per-job activity rendering) ------------------------

test('supervisorJobCell shows the job key a worker is servicing', () => {
  const row = { state: 'running', activity: { state: 'busy', jobs: [{ key: '2251799813685249', type: 'senior:pr-review', sinceMs: 5000 }] } };
  const cell = supervisorJobCell(row);
  assert.match(cell, /2251799813685249/);
  assert.match(cell, /\(5s\)/); // includes how long it has been on the job
});

test('supervisorJobCell shows idle for a live worker with no in-flight job', () => {
  assert.equal(supervisorJobCell({ state: 'running', activity: { state: 'idle', jobs: [] } }), 'idle');
});

test('supervisorJobCell counts extra concurrent jobs beyond the first', () => {
  const row = { state: 'running', activity: { state: 'busy', jobs: [
    { key: 'A', type: 't', sinceMs: 1000 },
    { key: 'B', type: 't', sinceMs: 2000 },
    { key: 'C', type: 't', sinceMs: 3000 },
  ] } };
  assert.match(supervisorJobCell(row), /^A \+2 \(1s\)$/);
});

test('supervisorJobCell is - for a down worker and ? for an alive non-reporter', () => {
  assert.equal(supervisorJobCell({ state: 'down', activity: null }), '-');
  assert.equal(supervisorJobCell({ state: 'stopping', activity: null }), '-');
  assert.equal(supervisorJobCell({ state: 'running', activity: null }), '?');
});

// --- summarizeSupervisorWorker reads the on-disk activity marker -----------

test('summarizeSupervisorWorker surfaces a live worker\'s serviced job from its marker', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-activity-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // A marker whose pid matches the (live) worker pid → busy on that job.
  const file = supervisorWorkerActivityFile('reviewer');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, busy: true, jobs: [{ key: 'JOB-1', type: 'senior:pr-review', since: Date.now() - 2000 }] }));
  const busy = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid });
  assert.equal(busy.activity.state, 'busy');
  assert.equal(busy.activity.jobs[0].key, 'JOB-1');

  // A stale marker from a previous incarnation (different pid) is ignored.
  writeFileSync(file, JSON.stringify({ pid: 999999999, busy: true, jobs: [{ key: 'STALE', since: Date.now() }] }));
  const guarded = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid });
  assert.equal(guarded.activity, null);

  // No marker at all → idle-with-no-report (null), rendered as '?'.
  const other = summarizeSupervisorWorker({ id: 'never-reported', profile: 'x', pid: process.pid });
  assert.equal(other.activity, null);
});

// --- supervisorStatusSignature (live-view change detection) ----------------

// Build a public worker view the way the daemon does, but without touching the
// on-disk activity marker: pass activity inline via a fake summarize input by
// constructing the shape summarizeSupervisorWorker returns.
const pub = ({ id = 'w', profile = id, state = 'running', pid = 1, restarts = 0, lastExit = null, activity = null }) =>
  ({ id, profile, pid, state, restarts, uptimeMs: 0, lastExit, args: [], activity });

test('supervisorStatusSignature is stable across ticking durations', () => {
  const a = pub({ activity: { state: 'busy', jobs: [{ key: 'pr.review', type: 'senior', sinceMs: 1000 }] } });
  const b = pub({ activity: { state: 'busy', jobs: [{ key: 'pr.review', type: 'senior', sinceMs: 99999 }] } });
  // Different uptime / job age must NOT change the signature.
  a.uptimeMs = 5; b.uptimeMs = 500000;
  assert.equal(supervisorStatusSignature([a]), supervisorStatusSignature([b]));
});

test('supervisorStatusSignature changes when a worker goes idle -> busy', () => {
  const idle = pub({ activity: { state: 'idle', jobs: [] } });
  const busy = pub({ activity: { state: 'busy', jobs: [{ key: 'pr.finalize', type: null, sinceMs: 1 }] } });
  assert.notEqual(supervisorStatusSignature([idle]), supervisorStatusSignature([busy]));
});

test('supervisorStatusSignature changes when the serviced job key changes', () => {
  const one = pub({ activity: { state: 'busy', jobs: [{ key: 'pr.review', type: 's', sinceMs: 1 }] } });
  const two = pub({ activity: { state: 'busy', jobs: [{ key: 'pr.persist', type: 's', sinceMs: 1 }] } });
  assert.notEqual(supervisorStatusSignature([one]), supervisorStatusSignature([two]));
});

test('supervisorStatusSignature is order-insensitive for concurrent jobs', () => {
  const j = (keys) => pub({ activity: { state: 'busy', jobs: keys.map((k, i) => ({ key: k, type: null, sinceMs: i })) } });
  assert.equal(
    supervisorStatusSignature([j(['a', 'b'])]),
    supervisorStatusSignature([j(['b', 'a'])]),
  );
});

test('supervisorStatusSignature reflects state, restarts, pid and lastExit changes', () => {
  const base = pub({ pid: 10, restarts: 0, lastExit: null });
  assert.notEqual(supervisorStatusSignature([base]), supervisorStatusSignature([pub({ pid: 11, restarts: 0, lastExit: null })]));
  assert.notEqual(supervisorStatusSignature([base]), supervisorStatusSignature([pub({ pid: 10, restarts: 1, lastExit: null })]));
  assert.notEqual(supervisorStatusSignature([base]), supervisorStatusSignature([pub({ pid: 10, restarts: 0, lastExit: 'code 1' })]));
  assert.notEqual(supervisorStatusSignature([base]), supervisorStatusSignature([pub({ state: 'down', pid: 10 })]));
});

test('supervisorStatusSignature tracks the worker set (add/remove)', () => {
  const a = pub({ id: 'a' });
  const b = pub({ id: 'b' });
  assert.notEqual(supervisorStatusSignature([a]), supervisorStatusSignature([a, b]));
  assert.equal(supervisorStatusSignature([]), supervisorStatusSignature([]));
});

test('supervisorStatusSignature tracks a profile change on the same worker id', () => {
  const before = pub({ id: 'a', profile: 'reviewer' });
  const after = pub({ id: 'a', profile: 'coder' });
  assert.notEqual(supervisorStatusSignature([before]), supervisorStatusSignature([after]));
});

test('supervisorStatusSignature tolerates a non-array input', () => {
  assert.equal(supervisorStatusSignature(null), '[]');
  assert.equal(supervisorStatusSignature(undefined), '[]');
});
