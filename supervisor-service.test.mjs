// Unit tests for the session-independent supervisor service helpers (issue
// #196): the SSH-session detection, the macOS LaunchAgent plist / Linux
// systemd --user unit builders, the deterministic per-state-home service
// label / paths / targets, and the SSH-logout-teardown warning predicate.
// These are the deterministic, side-effect-free pieces; the launchctl /
// systemctl IO itself is best-effort and exercised only on the target platform,
// but the *decisions* around it (which verbs run, in what order, and when we
// give up) are covered here through an injected runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isSshSession,
  xmlEscape,
  supervisorServiceLabel,
  launchAgentPlistPath,
  systemdUnitName,
  systemdUserUnitPath,
  launchdDomainTarget,
  launchdServiceTarget,
  supervisorServiceEnv,
  buildLaunchAgentPlist,
  buildSystemdUserUnit,
  shouldWarnSshTeardown,
  ensureLaunchAgentStarted,
} from './c8ctl-plugin.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A scripted `runLaunchctl` stand-in: records every argv, replies per verb. */
function fakeLaunchctl(script = {}) {
  const calls = [];
  const ok = { code: 0, stdout: '', stderr: '' };
  const run = (args) => {
    calls.push(args);
    const next = script[args[0]];
    if (Array.isArray(next)) return next.length > 1 ? next.shift() : (next[0] ?? ok);
    return next ?? ok;
  };
  return { run, calls };
}

function fakeLogger() {
  const warns = [];
  return { warns, logger: { info() {}, warn(m) { warns.push(m); }, error() {} } };
}

test('isSshSession: true only when an SSH_* marker is present', () => {
  assert.equal(isSshSession({}), false);
  assert.equal(isSshSession({ TERM: 'xterm' }), false);
  assert.equal(isSshSession({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), true);
  assert.equal(isSshSession({ SSH_CLIENT: '1.2.3.4 5 22' }), true);
  assert.equal(isSshSession({ SSH_TTY: '/dev/ttys000' }), true);
});

test('xmlEscape: escapes the five XML metacharacters', () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  assert.equal(xmlEscape('/usr/local/bin/node'), '/usr/local/bin/node');
});

test('service label / paths are deterministic and hash-suffixed', () => {
  const label = supervisorServiceLabel();
  assert.match(label, /^io\.nanobpm\.c8ctl-nano\.supervisor\.[0-9a-f]{8}$/);
  // Stable across calls for the same state home.
  assert.equal(supervisorServiceLabel(), label);
  assert.ok(launchAgentPlistPath().endsWith(`Library/LaunchAgents/${label}.plist`));
  assert.match(systemdUnitName(), /^c8ctl-nano-supervisor-[0-9a-f]{8}\.service$/);
  assert.ok(systemdUserUnitPath().endsWith(`systemd/user/${systemdUnitName()}`));
});

test('launchd targets compose gui/$UID[/label]', () => {
  assert.equal(launchdDomainTarget(501), 'gui/501');
  assert.equal(launchdServiceTarget(501, 'io.x.y'), 'gui/501/io.x.y');
});

test('supervisorServiceEnv: curated allowlist, never the whole environment', () => {
  const env = supervisorServiceEnv({
    PATH: '/usr/bin', HOME: '/home/me', C8CTL_NANO_HOME: '/state',
    AWS_SECRET_ACCESS_KEY: 'shh', GITHUB_TOKEN: 'ghp_x', SSH_AUTH_SOCK: '/tmp/agent',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/me');
  assert.equal(env.C8CTL_NANO_HOME, '/state');
  // Secrets / short-lived session vars must NOT be persisted into the service.
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.equal('SSH_AUTH_SOCK' in env, false);
});

test('buildLaunchAgentPlist: runs __daemon, RunAtLoad, crash-only KeepAlive', () => {
  const plist = buildLaunchAgentPlist({
    label: 'io.test.sup',
    exec: '/usr/local/bin/node',
    entry: '/opt/c8ctl/index.js',
    env: { PATH: '/usr/bin', C8CTL_NANO_HOME: '/state & more' },
    stdoutPath: '/logs/daemon.log',
    stderrPath: '/logs/daemon.log',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.test\.sup<\/string>/);
  // ProgramArguments carries the full argv to `nano supervisor __daemon`.
  for (const a of ['/usr/local/bin/node', '/opt/c8ctl/index.js', 'nano', 'supervisor', '__daemon']) {
    assert.ok(plist.includes(`<string>${a}</string>`), `expected arg ${a}`);
  }
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // KeepAlive must be crash-only ({SuccessfulExit:false}) so a clean stop stays down.
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  // Env values are XML-escaped.
  assert.ok(plist.includes('<string>/state &amp; more</string>'));
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/logs\/daemon\.log<\/string>/);
});

test('buildSystemdUserUnit: __daemon ExecStart, crash-only restart, default.target', () => {
  const unit = buildSystemdUserUnit({
    exec: '/usr/bin/node',
    entry: '/opt/c8ctl/index.js',
    env: { PATH: '/usr/bin', C8CTL_NANO_HOME: '/state' },
  });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/c8ctl\/index\.js nano supervisor __daemon/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Environment=PATH=\/usr\/bin/);
  assert.match(unit, /Environment=C8CTL_NANO_HOME=\/state/);
});

test('buildSystemdUserUnit: quotes/escapes paths and env values with whitespace or specials', () => {
  const unit = buildSystemdUserUnit({
    exec: '/opt/node runtime/bin/node',
    entry: '/opt/c8 ctl/index.js',
    env: { WS: '/home/a b/state', PCT: 'a%b', PATH: '/usr/bin' },
  });
  // ExecStart args with whitespace are double-quoted; the trailing fixed args stay bare.
  assert.match(unit, /ExecStart="\/opt\/node runtime\/bin\/node" "\/opt\/c8 ctl\/index\.js" nano supervisor __daemon/);
  // A value with whitespace quotes the whole KEY=VALUE assignment.
  assert.match(unit, /Environment="WS=\/home\/a b\/state"/);
  // A literal % is doubled so systemd never treats it as a specifier.
  assert.match(unit, /Environment=PCT=a%%b/);
  // Simple values stay unquoted.
  assert.match(unit, /Environment=PATH=\/usr\/bin/);
});

test('shouldWarnSshTeardown: only macOS + SSH + not installed', () => {
  const ssh = { SSH_CONNECTION: 'x' };
  const local = {};
  // Exposed: macOS over SSH with no service.
  assert.equal(shouldWarnSshTeardown({ platform: 'darwin', env: ssh, installed: false }), true);
  // Not exposed: service installed.
  assert.equal(shouldWarnSshTeardown({ platform: 'darwin', env: ssh, installed: true }), false);
  // Not exposed: local login (no SSH teardown).
  assert.equal(shouldWarnSshTeardown({ platform: 'darwin', env: local, installed: false }), false);
  // Not exposed: Linux survives logout under systemd-logind.
  assert.equal(shouldWarnSshTeardown({ platform: 'linux', env: ssh, installed: false }), false);
  assert.equal(shouldWarnSshTeardown({ platform: 'win32', env: ssh, installed: false }), false);
});

test('ensureLaunchAgentStarted: a plain kickstart is enough when launchd has the service', () => {
  const { logger } = fakeLogger();
  const { run, calls } = fakeLaunchctl({ kickstart: { code: 0 } });
  assert.equal(ensureLaunchAgentStarted(logger, { run, uid: 501, label: 'io.test.sup', plistPath: '/p.plist' }), true);
  assert.deepEqual(calls, [['kickstart', 'gui/501/io.test.sup']]);
});

test('ensureLaunchAgentStarted: never passes -k, so a live fleet is not bounced', () => {
  const { logger } = fakeLogger();
  const { run, calls } = fakeLaunchctl({ kickstart: [{ code: 5, stderr: 'Bootstrap failed: 5' }, { code: 0 }] });
  assert.equal(ensureLaunchAgentStarted(logger, { run, uid: 501, label: 'io.test.sup', plistPath: '/p.plist' }), true);
  assert.ok(calls.length > 0);
  for (const argv of calls) assert.ok(!argv.includes('-k'), `must not kill/restart: ${argv.join(' ')}`);
});

test('ensureLaunchAgentStarted: re-bootstraps a service launchd no longer has loaded', () => {
  const { logger, warns } = fakeLogger();
  const { run, calls } = fakeLaunchctl({
    kickstart: [{ code: 113, stderr: 'Could not find service "io.test.sup" in domain for gui/501' }, { code: 0 }],
    bootstrap: { code: 0 },
  });
  assert.equal(ensureLaunchAgentStarted(logger, { run, uid: 501, label: 'io.test.sup', plistPath: '/p.plist' }), true);
  assert.deepEqual(calls, [
    ['kickstart', 'gui/501/io.test.sup'],
    ['bootstrap', 'gui/501', '/p.plist'],
    ['enable', 'gui/501/io.test.sup'],
    ['kickstart', 'gui/501/io.test.sup'],
  ]);
  assert.deepEqual(warns, []);
});

test('ensureLaunchAgentStarted: a failed bootstrap is not the verdict — the retry kickstart is', () => {
  const { logger, warns } = fakeLogger();
  // launchctl reports a non-zero "Input/output error" when the service is already
  // loaded, so gating on bootstrap's status would refuse to start a healthy agent.
  const { run, calls } = fakeLaunchctl({
    kickstart: [{ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, { code: 0 }],
    bootstrap: { code: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' },
  });
  assert.equal(ensureLaunchAgentStarted(logger, { run, uid: 501, label: 'io.test.sup', plistPath: '/p.plist' }), true);
  assert.deepEqual(warns, []);
  assert.equal(calls.filter((argv) => argv[0] === 'kickstart').length, 2);
});

test('ensureLaunchAgentStarted: gives up (false + warn) when launchd will not start it', () => {
  const { logger, warns } = fakeLogger();
  const { run, calls } = fakeLaunchctl({
    kickstart: { code: 113, stderr: 'Could not find service "io.test.sup" in domain for gui/501' },
    bootstrap: { code: 125, stderr: 'Bootstrap failed: 125: Domain does not support specified action' },
  });
  assert.equal(ensureLaunchAgentStarted(logger, { run, uid: 501, label: 'io.test.sup', plistPath: '/p.plist' }), false);
  assert.match(warns.join('\n'), /kickstart failed/);
  // It tried the plist reload path too, then reported the kickstart verdict.
  assert.deepEqual(calls, [
    ['kickstart', 'gui/501/io.test.sup'],
    ['bootstrap', 'gui/501', '/p.plist'],
    ['enable', 'gui/501/io.test.sup'],
    ['kickstart', 'gui/501/io.test.sup'],
  ]);
});

test('every daemon-starting command path goes through the service-policy seam', () => {
  // WHY a source scan: the wedge this PR fixes came from command paths calling
  // `startSupervisorDaemon()` directly (a bare `supervisor`/`attach`, `supervisor
  // add`, `workforce up`), so each spawned a session-bound daemon an SSH logout
  // tore down — or raced the launchd-owned one for the socket. The cure is the
  // single `startSupervisorWithServicePolicy` seam (reparent/kickstart → adopt).
  // This repo has no ESLint, so this test IS the lint: a new direct caller fails it.
  const src = readFileSync(join(HERE, 'c8ctl-plugin.js'), 'utf8');
  const count = (re) => (src.match(re) || []).length;

  // 1 definition + exactly 1 caller (the seam itself).
  assert.equal(count(/startSupervisorDaemon\(/g), 2, 'start the daemon only via startSupervisorWithServicePolicy');
  // 1 definition + 4 callers: `supervisor start`, `supervisor add`, the
  // default/`attach` path, and the workforce reconcile.
  assert.equal(count(/startSupervisorWithServicePolicy\(/g), 5, 'every daemon-starting path must use the seam');

  const seam = src.match(/async function startSupervisorWithServicePolicy\(.*?\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(seam, 'startSupervisorWithServicePolicy must exist');
  assert.match(seam[1], /maybeReparentOrWarnOnStart\(logger\)/);
  assert.match(seam[1], /startSupervisorDaemon\(\{ adoptOnly: serviceOwned \}\)/);
});
