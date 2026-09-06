// Unit tests for the session-independent supervisor service helpers (issue
// #196): the SSH-session detection, the macOS LaunchAgent plist / Linux
// systemd --user unit builders, the deterministic per-state-home service
// label / paths / targets, and the SSH-logout-teardown warning predicate.
// These are the deterministic, side-effect-free pieces; the launchctl /
// systemctl IO is best-effort and exercised only on the target platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
} from './c8ctl-plugin.js';

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
