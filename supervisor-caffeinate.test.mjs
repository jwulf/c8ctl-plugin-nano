// Unit test for the macOS `caffeinate` wrapper on the detached supervisor
// daemon spawn. On macOS, idle-sleep after an SSH logout tears down the network
// interface and storms the worker fleet with EHOSTUNREACH; wrapping the
// detached daemon in `caffeinate -i -s` holds the system awake for the fleet's
// lifetime. The wrapper is platform-scoped and fail-open, so it must be a no-op
// everywhere else and whenever the stock binary is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const pluginUrl = new URL('./c8ctl-plugin.js', import.meta.url).href;
const { buildSupervisorDaemonSpawn } = await import(pluginUrl);

const EXEC = '/usr/local/bin/node';
const ENTRY = '/opt/c8ctl/index.js';
const DAEMON_ARGS = [ENTRY, 'nano', 'supervisor', '__daemon'];

test('macOS wraps the detached daemon in caffeinate -i -s (present binary)', () => {
  const { command, args } = buildSupervisorDaemonSpawn({
    exec: EXEC,
    entry: ENTRY,
    platform: 'darwin',
    caffeinatePath: '/usr/bin/caffeinate',
    hasCaffeinate: () => true,
  });
  assert.equal(command, '/usr/bin/caffeinate');
  assert.deepEqual(args, ['-i', '-s', EXEC, ...DAEMON_ARGS]);
});

test('macOS without caffeinate falls back to spawning the daemon directly', () => {
  const { command, args } = buildSupervisorDaemonSpawn({
    exec: EXEC,
    entry: ENTRY,
    platform: 'darwin',
    hasCaffeinate: () => false,
  });
  assert.equal(command, EXEC);
  assert.deepEqual(args, DAEMON_ARGS);
});

test('non-macOS never wraps, even if a caffeinate path exists', () => {
  for (const platform of ['linux', 'win32']) {
    const { command, args } = buildSupervisorDaemonSpawn({
      exec: EXEC,
      entry: ENTRY,
      platform,
      hasCaffeinate: () => true,
    });
    assert.equal(command, EXEC, `${platform} must spawn the daemon directly`);
    assert.deepEqual(args, DAEMON_ARGS);
  }
});

test('the checked caffeinate path is threaded to the availability probe', () => {
  const seen = [];
  buildSupervisorDaemonSpawn({
    exec: EXEC,
    entry: ENTRY,
    platform: 'darwin',
    caffeinatePath: '/custom/caffeinate',
    hasCaffeinate: (p) => { seen.push(p); return true; },
  });
  assert.deepEqual(seen, ['/custom/caffeinate']);
});
