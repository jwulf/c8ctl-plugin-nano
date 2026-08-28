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
  formatSupervisorLogsLines,
  reageSupervisorStatus,
  clampToWidth,
  createSupervisorLiveView,
  printSupervisorStatus,
  supervisorStatusSignature,
  supervisorJobCell,
  supervisorEngineCell,
  supervisorAgenticCell,
  agenticStateForTarget,
  normalizeAgenticMessage,
  buildActivityPayload,
  supervisorWorkerActivityFile,
  WORK_FORWARD_FLAGS,
} from './c8ctl-plugin.js';

// --- reconstructWorkArgs ---------------------------------------------------

test('reconstructWorkArgs emits value flags as --flag value', () => {
  assert.deepEqual(
    reconstructWorkArgs({ 'recovery-window': '300000', 'job-timeout': '600000' }),
    ['--job-timeout', '600000', '--recovery-window', '300000'],
  );
});

test('reconstructWorkArgs emits boolean flags only when true, with no value', () => {
  assert.deepEqual(reconstructWorkArgs({ stream: true, 'keep-runs': false }), ['--stream']);
  assert.deepEqual(reconstructWorkArgs({ stream: 'true' }), ['--stream']);
});

test('reconstructWorkArgs parses booleans via coerceBool (string spellings)', () => {
  // c8ctl may pass boolean flags as strings; forwarding must match workAgent's
  // coerceBool semantics so `'1'`/`'yes'`/`'on'` still enable the flag and
  // `'0'`/`'no'`/`'off'` still drop it.
  assert.deepEqual(reconstructWorkArgs({ stream: '1', 'keep-runs': 'yes' }), ['--keep-runs', '--stream']);
  assert.deepEqual(reconstructWorkArgs({ stream: 'on' }), ['--stream']);
  assert.deepEqual(reconstructWorkArgs({ stream: '0', 'keep-runs': 'off' }), []);
  // A truthy string spelling of --auto also gates --auto-scope forwarding.
  assert.deepEqual(
    reconstructWorkArgs({ auto: 'on', 'auto-scope': 'my-app' }),
    ['--auto', '--auto-scope', 'my-app'],
  );
});

test('reconstructWorkArgs repeats list flags once per item', () => {
  assert.deepEqual(
    reconstructWorkArgs({ 'job-type': ['a:b', 'c:d'], env: 'X=1' }),
    ['--env', 'X=1', '--job-type', 'a:b', '--job-type', 'c:d'],
  );
});

test('reconstructWorkArgs forwards --auto and --auto-scope to supervised workers', () => {
  assert.deepEqual(reconstructWorkArgs({ auto: true }), ['--auto']);
  // --auto-scope without --auto is dropped: forwarding the orphan flag would
  // make the supervised worker exit fast ("--auto-scope requires --auto") and
  // wedge the supervisor into a crash/restart loop.
  assert.deepEqual(reconstructWorkArgs({ auto: false, 'auto-scope': 'my-app' }), []);
  assert.deepEqual(reconstructWorkArgs({ 'auto-scope': 'my-app' }), []);
  assert.deepEqual(
    reconstructWorkArgs({ auto: true, 'auto-scope': 'my-app' }),
    ['--auto', '--auto-scope', 'my-app'],
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
    extractNameFlag(['--name', 'alice', '--job-timeout', '600000']),
    { name: 'alice', rest: ['--job-timeout', '600000'] },
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

test('parseInstancesCount over-cap error names the command label', () => {
  // Default label preserves the supervisor-add rerun hint: `supervisor add`
  // accumulates workers, so re-running really does let you add more.
  assert.match(parseInstancesCount('65').error, /run "supervisor add" again/);
  // Workforce entries are updated in place, so the cap is a hard per-entry
  // maximum — the rerun hint would be misleading and is intentionally omitted.
  const wf = parseInstancesCount('65', 'workforce add').error;
  assert.doesNotMatch(wf, /again/);
  assert.match(wf, /per-entry maximum/);
});

// --- extractInstancesFlag --------------------------------------------------

test('extractInstancesFlag pulls --instances <val> out of the token list', () => {
  assert.deepEqual(
    extractInstancesFlag(['--instances', '3', '--job-timeout', '600000']),
    { count: 3, rest: ['--job-timeout', '600000'] },
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
    redactWorkArgs(['--job-timeout', '600000', '--env', 'TOKEN=s3cr3t', '--stream']),
    ['--job-timeout', '600000', '--env', 'TOKEN=***', '--stream'],
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
  const obj = { op: 'add', profile: 'reviewer', args: ['--job-timeout', '600000'] };
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

test('summarizeSupervisorWorker carries the per-worker logFile through', () => {
  const row = summarizeSupervisorWorker({
    id: 'reviewer', profile: 'reviewer', pid: process.pid,
    logFile: '/state/logs/supervisor/worker-reviewer.log',
  });
  assert.equal(row.logFile, '/state/logs/supervisor/worker-reviewer.log');
});

test('summarizeSupervisorWorker logFile is null when the source record has none', () => {
  const row = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid });
  assert.equal(row.logFile, null);
});

// --- formatSupervisorLogsLines / log discoverability -----------------------

test('formatSupervisorLogsLines lists the daemon log, each worker log, and a tail hint', () => {
  const now = Date.now();
  const lines = formatSupervisorLogsLines({
    daemon: { pid: process.pid, logFile: '/state/logs/supervisor/daemon.log' },
    workers: [
      summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, logFile: '/state/logs/supervisor/worker-reviewer.log' }, now),
      summarizeSupervisorWorker({ id: 'coder', profile: 'coder', pid: 2 ** 30, logFile: '/state/logs/supervisor/worker-coder.log' }, now),
    ],
  });
  const text = lines.join('\n');
  assert.match(text, /Logs:/);
  assert.match(text, /daemon\s+\/state\/logs\/supervisor\/daemon\.log/);
  assert.match(text, /reviewer\s+\/state\/logs\/supervisor\/worker-reviewer\.log/);
  assert.match(text, /coder\s+\/state\/logs\/supervisor\/worker-coder\.log/);
  assert.match(text, /c8ctl nano supervisor logs/);
});

test('formatSupervisorLogsLines omits the section when no log path is known', () => {
  const lines = formatSupervisorLogsLines({ daemon: { pid: process.pid }, workers: [] });
  assert.deepEqual(lines, []);
});

test('formatSupervisorStatus surfaces log locations in the populated table', () => {
  const now = Date.now();
  const text = formatSupervisorStatus({
    daemon: { pid: process.pid, logFile: '/state/logs/supervisor/daemon.log' },
    workers: [
      summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, startedAt: new Date(now - 1000).toISOString(), logFile: '/state/logs/supervisor/worker-reviewer.log' }, now),
    ],
  });
  assert.match(text, /Logs:/);
  assert.match(text, /daemon\s+\/state\/logs\/supervisor\/daemon\.log/);
  assert.match(text, /reviewer\s+\/state\/logs\/supervisor\/worker-reviewer\.log/);
});

test('formatSupervisorStatus surfaces the daemon log even with no workers', () => {
  const text = formatSupervisorStatus({
    daemon: { pid: process.pid, logFile: '/state/logs/supervisor/daemon.log' },
    workers: [],
  });
  assert.match(text, /No workers/);
  assert.match(text, /Logs:/);
  assert.match(text, /daemon\s+\/state\/logs\/supervisor\/daemon\.log/);
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

// --- printSupervisorStatus (output-channel regression guard) ----------------
//
// Regression guard for the "literal \n, no line-wrapping" defect: the aligned
// status table was printed via logger.info(), and in `--output json` mode the
// c8ctl host logger JSON-wraps an info message, escaping every real newline to a
// two-character `\n` and collapsing the table onto one line. The fix routes the
// table through logger.output() (verbatim in every mode). These tests fake the
// host logger's real json-mode semantics so a revert to info() fails here.

/** Faithful stand-in for the c8ctl host logger in `--output json` mode. */
function fakeJsonModeLogger() {
  const stdout = [];
  return {
    stdout,
    // info(): host wraps + JSON.stringifies (escapes newlines) — the buggy path.
    info(message) { stdout.push(JSON.stringify({ status: 'info', message })); },
    warn() {},
    error() {},
    debug() {},
    // output(): host writes primary content to stdout as-is in every mode.
    output(content) { stdout.push(String(content)); },
  };
}

const SAMPLE_STATUS = {
  daemon: { pid: process.pid, startedAt: new Date().toISOString(), socket: '/tmp/x.sock' },
  workers: [
    summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, restarts: 0 }, Date.now()),
    summarizeSupervisorWorker({ id: 'coder', profile: 'coder', pid: 2 ** 30, restarts: 1 }, Date.now()),
  ],
};

test('printSupervisorStatus renders real newlines in json mode (not escaped literals)', () => {
  const logger = fakeJsonModeLogger();
  printSupervisorStatus(logger, SAMPLE_STATUS);

  const emitted = logger.stdout.join('');
  // The table must survive verbatim: multiple real lines...
  assert.ok(emitted.split('\n').length > 2, 'status table should span multiple real lines');
  assert.match(emitted, /reviewer/);
  assert.match(emitted, /coder/);
  // ...and must NOT be JSON-wrapped nor contain a literal backslash-n sequence.
  assert.doesNotMatch(emitted, /\\n/, 'newlines must not be escaped to literal \\n');
  assert.doesNotMatch(emitted, /"status":"info"/, 'table must not be wrapped in a json info envelope');
});

test('printSupervisorStatus routes preformatted output through logger.output()', () => {
  let outputCalls = 0;
  let infoCalls = 0;
  const logger = {
    info() { infoCalls++; },
    warn() {}, error() {}, debug() {},
    output() { outputCalls++; },
  };
  printSupervisorStatus(logger, SAMPLE_STATUS);
  assert.equal(outputCalls, 1, 'should use output() for preformatted table');
  assert.equal(infoCalls, 0, 'must not use info() for preformatted table');
});

test('printSupervisorStatus falls back to info() for a logger without output()', () => {
  let captured = null;
  const logger = { info(m) { captured = m; }, warn() {}, error() {}, debug() {} };
  printSupervisorStatus(logger, SAMPLE_STATUS);
  assert.match(captured, /reviewer/);
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
const pub = ({ id = 'w', profile = id, state = 'running', pid = 1, restarts = 0, lastExit = null, activity = null, engine = null, agentic = null }) =>
  ({ id, profile, pid, state, restarts, uptimeMs: 0, lastExit, args: [], activity, engine, agentic });

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

// --- summarizeSupervisorWorker carries absolute base epochs -----------------
// The pinned in-place console re-ages durations locally on its own tick, so the
// snapshot must expose the absolute base times (not just the snapshot-time
// durations) for uptime and each in-flight job. (issue #83)

test('summarizeSupervisorWorker exposes startedAtMs for a live worker', () => {
  const now = Date.now();
  const startedAt = new Date(now - 5000).toISOString();
  const w = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, startedAt, restarts: 0 }, now);
  assert.equal(w.startedAtMs, new Date(startedAt).getTime());
  assert.equal(w.uptimeMs, 5000);
});

test('summarizeSupervisorWorker leaves startedAtMs null for a down worker', () => {
  const w = summarizeSupervisorWorker({ id: 'coder', profile: 'coder', pid: 2 ** 30, restarts: 1 }, Date.now());
  assert.equal(w.startedAtMs, null);
  assert.equal(w.uptimeMs, 0);
});

// --- engine + agentic channel visibility (issue #99) -----------------------
// A supervised worker reports which engine it polls and its agentic-visibility
// channel status in its activity marker, so `supervisor status` (and the
// interactive live view, which shares formatSupervisorStatus) show whether
// presence actually reached the Workforce hub — the signal missing behind
// "workers are connected to the engine but the Cockpit is empty".

test('summarizeSupervisorWorker surfaces engine + agentic status from the marker', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-agentic-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.C8CTL_NANO_HOME; else process.env.C8CTL_NANO_HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const file = supervisorWorkerActivityFile('reviewer');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    pid: process.pid,
    busy: false,
    jobs: [],
    engine: 'http://merlin.local:8080',
    agentic: { status: 'connected', mode: 'local', url: 'ws://merlin.local:3000/agentic', discovered: { project: 'Workforce', port: 3000, host: 'merlin.local' } },
  }));
  const row = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid });
  assert.equal(row.engine, 'http://merlin.local:8080');
  assert.equal(row.agentic.status, 'connected');
  assert.equal(row.agentic.mode, 'local');
  assert.equal(row.agentic.discovered.host, 'merlin.local');

  // A stale-pid marker is ignored for engine/agentic too (not just jobs).
  writeFileSync(file, JSON.stringify({ pid: 999999999, engine: 'http://stale:8080', agentic: { status: 'connected' } }));
  const guarded = summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid });
  assert.equal(guarded.engine, null);
  assert.equal(guarded.agentic, null);
});

test('summarizeSupervisorWorker leaves engine/agentic null for a down worker', () => {
  const row = summarizeSupervisorWorker({ id: 'coder', profile: 'coder', pid: 2 ** 30, restarts: 1 });
  assert.equal(row.engine, null);
  assert.equal(row.agentic, null);
});

test('supervisorEngineCell shows the engine authority (host:port), — when down, ? when not reporting', () => {
  assert.equal(supervisorEngineCell({ state: 'running', activity: { state: 'idle', jobs: [] }, engine: 'http://merlin.local:8080' }), 'merlin.local:8080');
  assert.equal(supervisorEngineCell({ state: 'down', activity: null, engine: null }), '-');
  assert.equal(supervisorEngineCell({ state: 'running', activity: null, engine: null }), '?');
  // A reporting worker on an older build (marker without engine) → ?
  assert.equal(supervisorEngineCell({ state: 'running', activity: { state: 'idle', jobs: [] }, engine: null }), '?');
  // A non-URL engine string falls back to the raw value.
  assert.equal(supervisorEngineCell({ state: 'running', activity: { state: 'idle', jobs: [] }, engine: 'localhost:8080' }), 'localhost:8080');
});

test('supervisorAgenticCell shows the channel status word, — when down, ? when not reporting', () => {
  const cell = (agentic, extra = {}) => supervisorAgenticCell({ state: 'running', activity: { state: 'idle', jobs: [] }, agentic, ...extra });
  assert.equal(cell({ status: 'connected' }), 'connected');
  assert.equal(cell({ status: 'connecting' }), 'connecting');
  assert.equal(cell({ status: 'disconnected' }), 'disconnected');
  assert.equal(cell({ status: 'advisory' }), 'advisory');
  assert.equal(cell({ status: 'off' }), 'off');
  assert.equal(supervisorAgenticCell({ state: 'down', activity: null, agentic: null }), '-');
  assert.equal(supervisorAgenticCell({ state: 'running', activity: null, agentic: null }), '?');
  // Reporting worker on an older build (marker without agentic) → ?
  assert.equal(cell(null), '?');
});

test('formatSupervisorStatus renders ENGINE and AGENTIC columns with values', () => {
  const now = Date.now();
  const worker = {
    id: 'rev', profile: 'rev', pid: process.pid, state: 'running', restarts: 0,
    uptimeMs: 1000, lastExit: null, args: [],
    activity: { state: 'idle', jobs: [] },
    engine: 'http://merlin.local:8080',
    agentic: { status: 'connected', mode: 'local' },
  };
  const text = formatSupervisorStatus({ daemon: { pid: process.pid }, workers: [worker] });
  assert.match(text, /ENGINE/);
  assert.match(text, /AGENTIC/);
  assert.match(text, /merlin\.local:8080/);
  assert.match(text, /connected/);
});

test('supervisorStatusSignature changes on an agentic status transition', () => {
  const connecting = pub({ activity: { state: 'idle', jobs: [] }, agentic: { status: 'connecting' } });
  const connected = pub({ activity: { state: 'idle', jobs: [] }, agentic: { status: 'connected' } });
  assert.notEqual(supervisorStatusSignature([connecting]), supervisorStatusSignature([connected]));
});

// --- agenticStateForTarget: the activity-marker PRODUCER (issue #99) --------
// The reader/renderer tests above prove a well-formed marker renders; these
// cover the seam that WRITES it, so a regression that leaves supervised workers
// stuck at `?`/`starting` is caught even though the readers pass.
test('agenticStateForTarget maps off/advisory/connect the way the marker producer writes them', () => {
  // off — the off-switch is set.
  assert.deepEqual(agenticStateForTarget({ status: 'off' }), { status: 'off' });

  // advisory — retains the discovery diagnostic message (missing API / timeout /
  // non-Nano endpoint) so the supervisor can tell them apart, not just `advisory`.
  assert.deepEqual(
    agenticStateForTarget({ status: 'advisory', message: 'projects API absent' }),
    { status: 'advisory', message: 'projects API absent' },
  );
  // advisory with no message still records the key (null), never undefined.
  assert.deepEqual(agenticStateForTarget({ status: 'advisory' }), { status: 'advisory', message: null });

  // connect — 'connecting' until the socket opens, carrying mode/url/discovery.
  const secure = agenticStateForTarget(
    { status: 'connect', config: { secure: true, url: 'wss://hub/agentic', discovered: { project: 'WF', port: 3000, host: 'h' } } },
    (u) => `redacted:${u}`,
  );
  assert.deepEqual(secure, {
    status: 'connecting',
    mode: 'secure',
    url: 'redacted:wss://hub/agentic',
    discovered: { project: 'WF', port: 3000, host: 'h' },
  });
  const local = agenticStateForTarget({ status: 'connect', config: { secure: false, url: 'ws://h/agentic' } });
  assert.equal(local.status, 'connecting');
  assert.equal(local.mode, 'local');
  assert.equal(local.discovered, null);

  // ambiguous is a caller hard-stop that never reaches the marker → degrades to off.
  assert.deepEqual(agenticStateForTarget({ status: 'ambiguous', message: 'x' }), { status: 'off' });
});

test('agenticStateForTarget connect state layers into connect/disconnect transitions', () => {
  // The channel lifecycle merges a status word onto the base state
  // (`{ ...state, status }`); assert connect→disconnect preserves the carried
  // target fields and that a failure message can ride alongside under the
  // contract `agentic.message` field (#99).
  const base = agenticStateForTarget({ status: 'connect', config: { secure: false, url: 'ws://h/agentic', discovered: { project: 'WF' } } });
  const connected = { ...base, status: 'connected' };
  assert.equal(connected.status, 'connected');
  assert.equal(connected.mode, 'local');
  assert.deepEqual(connected.discovered, { project: 'WF' });

  const disconnected = { ...base, status: 'disconnected', message: 'ECONNREFUSED' };
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.message, 'ECONNREFUSED');
  // The carried target fields survive the transition so the cell can still show WHERE.
  assert.deepEqual(disconnected.discovered, { project: 'WF' });
  // The renderer still reduces either transition to the status word.
  assert.equal(supervisorAgenticCell({ state: 'running', activity: { state: 'idle', jobs: [] }, agentic: connected }), 'connected');
  assert.equal(supervisorAgenticCell({ state: 'running', activity: { state: 'idle', jobs: [] }, agentic: disconnected }), 'disconnected');
});

test('normalizeAgenticMessage collapses close-info / errors into the contract message field', () => {
  // The marker's diagnostic field is `agentic.message` (#99) on BOTH the live
  // onDisconnect path (close `info`) and the create-failure catch path (Error),
  // so a hub drop explains WHY. Nothing useful → null (a clean status word).
  assert.equal(normalizeAgenticMessage(null), null);
  assert.equal(normalizeAgenticMessage(undefined), null);
  assert.equal(normalizeAgenticMessage(''), null);
  assert.equal(normalizeAgenticMessage('  boom  '), 'boom');
  assert.equal(normalizeAgenticMessage(new Error('ECONNREFUSED')), 'ECONNREFUSED');
  // Close-info shapes the transport passes to onDisconnect.
  assert.equal(normalizeAgenticMessage({ code: 1006, reason: 'abnormal' }), 'abnormal (code 1006)');
  assert.equal(normalizeAgenticMessage({ reason: 'going away' }), 'going away');
  assert.equal(normalizeAgenticMessage({ code: 1011 }), 'close code 1011');
  assert.equal(normalizeAgenticMessage({ local: true }), 'closed locally');
  assert.equal(normalizeAgenticMessage({ local: false }), 'connection dropped');
  // An info object with nothing to say → null, so the marker just shows the status.
  assert.equal(normalizeAgenticMessage({}), null);
});

// --- buildActivityPayload: the marker payload the producer WRITES ------------
// agenticStateForTarget above covers the agentic-status field; this covers the
// whole marker object writeActivity() serializes, so a regression that dropped
// `engine` or `agentic` (leaving the Engine/Agentic columns stuck at `?`) or
// desynced `busy` from `jobs` is caught even though the reader/renderer tests
// pass on a hand-written marker.
test('buildActivityPayload carries engine + agentic and derives busy from jobs', () => {
  // Idle: no jobs → busy:false, engine + agentic present verbatim.
  const idle = buildActivityPayload({
    pid: 4242,
    updatedAt: 1000,
    jobs: [],
    engine: 'http://localhost:8080',
    agentic: { status: 'connected', mode: 'local' },
  });
  assert.deepEqual(idle, {
    pid: 4242,
    updatedAt: 1000,
    busy: false,
    jobs: [],
    engine: 'http://localhost:8080',
    agentic: { status: 'connected', mode: 'local' },
  });

  // Busy: jobs present → busy:true; the live job list rides through untouched.
  const jobs = [{ key: '99', type: 'senior:pr-review', since: 500 }];
  const busy = buildActivityPayload({
    pid: 7, updatedAt: 2000, jobs, engine: null, agentic: { status: 'starting' },
  });
  assert.equal(busy.busy, true);
  assert.deepEqual(busy.jobs, jobs);
  // engine is always recorded (null, never undefined) so the reader sees the key.
  assert.equal(busy.engine, null);
  assert.ok('engine' in busy);
  assert.deepEqual(busy.agentic, { status: 'starting' });

  // A missing/non-array jobs list degrades to empty + idle, never throws.
  const noJobs = buildActivityPayload({ pid: 1, updatedAt: 3, jobs: undefined, engine: 'e', agentic: { status: 'off' } });
  assert.deepEqual(noJobs.jobs, []);
  assert.equal(noJobs.busy, false);
});

test('supervisorStatusSignature changes when the polled engine changes', () => {
  const a = pub({ engine: 'http://merlin.local:8080' });
  const b = pub({ engine: 'http://omarchy.local:8080' });
  assert.notEqual(supervisorStatusSignature([a]), supervisorStatusSignature([b]));
});



test('reageSupervisorStatus recomputes uptimeMs from startedAtMs at the new now', () => {
  const startedAtMs = 1_000_000;
  const status = { daemon: { pid: 1 }, workers: [{ id: 'a', state: 'running', startedAtMs, uptimeMs: 0, activity: null }] };
  const reaged = reageSupervisorStatus(status, startedAtMs + 42_000);
  assert.equal(reaged.workers[0].uptimeMs, 42_000);
  // Pure: input is untouched.
  assert.equal(status.workers[0].uptimeMs, 0);
});

test('reageSupervisorStatus re-ages each in-flight job from its sinceEpochMs', () => {
  const now0 = 5_000_000;
  const status = {
    workers: [{
      id: 'a', state: 'running', startedAtMs: now0 - 1000, uptimeMs: 1000,
      activity: { state: 'busy', jobs: [{ key: 'job:1', type: 't', sinceMs: 0, sinceEpochMs: now0 }] },
    }],
  };
  const reaged = reageSupervisorStatus(status, now0 + 12_000);
  assert.equal(reaged.workers[0].activity.jobs[0].sinceMs, 12_000);
  assert.equal(status.workers[0].activity.jobs[0].sinceMs, 0); // unmutated
});

test('reageSupervisorStatus keeps the snapshot value when no absolute base is present', () => {
  const status = { workers: [{ id: 'a', state: 'running', uptimeMs: 7777, activity: { state: 'busy', jobs: [{ key: 'j', sinceMs: 42 }] } }] };
  const reaged = reageSupervisorStatus(status, Date.now());
  assert.equal(reaged.workers[0].uptimeMs, 7777);
  assert.equal(reaged.workers[0].activity.jobs[0].sinceMs, 42);
});

test('reageSupervisorStatus passes non-object / no-workers frames through untouched', () => {
  assert.equal(reageSupervisorStatus(null, 1), null);
  const noWorkers = { daemon: { pid: 1 } };
  assert.equal(reageSupervisorStatus(noWorkers, 1), noWorkers);
});

test('reageSupervisorStatus output still renders through formatSupervisorStatus', () => {
  const now0 = 9_000_000;
  const status = {
    daemon: { pid: process.pid },
    workers: [summarizeSupervisorWorker({ id: 'reviewer', profile: 'reviewer', pid: process.pid, startedAt: new Date(now0).toISOString(), restarts: 0 }, now0)],
  };
  const text = formatSupervisorStatus(reageSupervisorStatus(status, now0 + 3661_000));
  assert.match(text, /reviewer/);
  assert.match(text, /1h1m/); // 3661s ≈ 1h1m — proof the re-aged uptime rendered
});

// --- clampToWidth (keeps one logical line per terminal row) ------------------

test('clampToWidth truncates with an ellipsis past the width', () => {
  assert.equal(clampToWidth('abcdefgh', 5), 'abcd…');
});

test('clampToWidth leaves a line within the width untouched', () => {
  assert.equal(clampToWidth('abc', 5), 'abc');
  assert.equal(clampToWidth('abcde', 5), 'abcde');
});

test('clampToWidth treats a non-positive / non-finite width as no clamp', () => {
  assert.equal(clampToWidth('abcdef', 0), 'abcdef');
  assert.equal(clampToWidth('abcdef', NaN), 'abcdef');
  assert.equal(clampToWidth('abcdef', Infinity), 'abcdef');
});

test('clampToWidth collapses to a lone ellipsis at width 1', () => {
  assert.equal(clampToWidth('abc', 1), '…');
});

// --- createSupervisorLiveView (pinned in-place block, issue #83) -------------
// A fake stream captures every write so we can assert the render orchestration
// without a real terminal. readline's cursor helpers emit ANSI escapes to the
// stream (they don't require an actual TTY), so the erase sequence is visible.

function fakeStream(cols = 200) {
  const chunks = [];
  return {
    columns: cols,
    write: (s) => { chunks.push(String(s)); return true; },
    all: () => chunks.join(''),
    clear: () => { chunks.length = 0; },
  };
}

function statusFixture(now, { uptimeBaseMs = 1000 } = {}) {
  return {
    daemon: { pid: process.pid, startedAt: new Date(now).toISOString() },
    workers: [
      summarizeSupervisorWorker(
        { id: 'reviewer', profile: 'reviewer', pid: process.pid, startedAt: new Date(now - uptimeBaseMs).toISOString(), restarts: 0 },
        now,
      ),
    ],
  };
}

test('live view: a second status MUTATES in place (erase codes), not a reprinted table', () => {
  const stream = fakeStream();
  const view = createSupervisorLiveView({ stream, isTty: true, columns: () => stream.columns, now: () => 1_000_000 });

  view.status(statusFixture(1_000_000));
  const firstRows = view.blockRows();
  assert.ok(firstRows > 0, 'the block occupies at least one row after the first status');

  stream.clear();
  view.status(statusFixture(1_000_000));
  const second = stream.all();
  // In-place repaint issues a cursor-up (moveCursor) + clear-to-end before the
  // redraw — the proof it erased the old block rather than appending a new one.
  assert.match(second, /\x1b\[\d+A/, 'moves the cursor up over the previous block');
  assert.match(second, /\x1b\[0?J/, 'clears from the cursor to the end of screen');
  assert.equal(view.blockRows(), firstRows, 'the block keeps the same height');
});

test('live view: repaint re-ages UPTIME so a quiet fleet still ticks', () => {
  const stream = fakeStream();
  let clock = 5_000_000;
  const view = createSupervisorLiveView({ stream, isTty: true, columns: () => stream.columns, now: () => clock });

  // Worker started 1s before the first snapshot → UPTIME shows 1s.
  view.status(statusFixture(5_000_000, { uptimeBaseMs: 1000 }));
  stream.clear();

  // 1 hour later, a bare repaint (no new frame) must advance UPTIME locally.
  clock += 3_600_000;
  view.repaint();
  assert.match(stream.all(), /1h/, 'UPTIME advanced on a local repaint with no new status');
});

test('live view: write() scrolls history above the block and repaints it', () => {
  const stream = fakeStream();
  const view = createSupervisorLiveView({ stream, isTty: true, columns: () => stream.columns, now: () => 1 });
  view.status(statusFixture(1_000_000));
  stream.clear();

  view.write('• worker reviewer started (pid 42).');
  const out = stream.all();
  assert.match(out, /worker reviewer started/, 'the history line is emitted');
  assert.match(out, /reviewer/, 'the block is redrawn beneath the history line');
  // The history line precedes the redrawn block (block stays pinned at bottom).
  assert.ok(out.indexOf('started (pid 42)') < out.lastIndexOf('PROFILE'), 'history scrolls above the pinned block');
});

test('live view: non-TTY appends the table and never emits cursor escapes', () => {
  const stream = fakeStream();
  const view = createSupervisorLiveView({ stream, isTty: false, columns: () => stream.columns, now: () => 1_000_000 });
  view.status(statusFixture(1_000_000));
  view.status(statusFixture(1_000_000));
  const out = stream.all();
  assert.doesNotMatch(out, /\x1b\[/, 'no ANSI cursor addressing on a non-TTY');
  // Two snapshots → the table rendered twice (classic append behavior).
  assert.equal(out.match(/PROFILE/g).length, 2, 'each non-TTY status appends a fresh table');
});

test('live view: repaint before any status is a no-op', () => {
  const stream = fakeStream();
  const view = createSupervisorLiveView({ stream, isTty: true, columns: () => stream.columns });
  view.repaint();
  assert.equal(stream.all(), '', 'nothing painted before the first snapshot');
  assert.equal(view.hasStatus(), false);
});

test('live view: block lines are clamped to the terminal width', () => {
  const stream = fakeStream(24); // narrow terminal
  const view = createSupervisorLiveView({ stream, isTty: true, columns: () => stream.columns, now: () => 1_000_000 });
  view.status(statusFixture(1_000_000));
  // Every emitted block line (ignoring bare-escape/newline writes) fits the width.
  for (const line of stream.all().split('\n')) {
    const visible = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.ok(visible.length <= 24, `line within width: ${JSON.stringify(visible)}`);
  }
});

test('summarizeSupervisorWorker: an invalid startedAt yields null (not NaN) startedAtMs', () => {
  const row = summarizeSupervisorWorker(
    { id: 'w', profile: 'p', pid: process.pid, startedAt: 'not-a-date', restarts: 0 },
    1_000_000,
  );
  assert.equal(row.startedAtMs, null, 'a non-parseable startedAt normalizes to null');
  assert.equal(row.uptimeMs, 0, 'uptime is 0, never NaN');
});

test('reageSupervisorStatus: a NaN base epoch does not poison uptime', () => {
  const status = { workers: [{ id: 'w', state: 'running', startedAtMs: NaN, uptimeMs: 42 }] };
  const out = reageSupervisorStatus(status, 9_999);
  assert.equal(out.workers[0].uptimeMs, 42, 'falls back to the snapshot uptime when the base is not finite');
});
