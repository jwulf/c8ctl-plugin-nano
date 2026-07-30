// Unit tests for the portable npm invocation used by the self-update / update
// notifier paths. Spawning `npm` directly is not portable on Windows, where npm
// is a `npm.cmd` shim: bare "npm" fails with ENOENT and "npm.cmd" fails with
// EINVAL under the CVE-2024-27980 hardening. buildNpmInvocation() is the single
// source of truth that decides how to spawn npm on each platform; the plugin
// prefers the host's c8ctl.npm() runner and falls back to this locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNpmInvocation } from './c8ctl-plugin.js';

test('POSIX: spawns bare npm without a shell', () => {
  const inv = buildNpmInvocation(['view', 'pkg', 'version'], 'linux');
  assert.deepEqual(inv, {
    command: 'npm',
    args: ['view', 'pkg', 'version'],
    shell: false,
  });
});

test('POSIX: returns a fresh args array (no aliasing of the input)', () => {
  const args = ['view', 'pkg'];
  const inv = buildNpmInvocation(args, 'darwin');
  assert.notStrictEqual(inv.args, args);
  inv.args.push('mutated');
  assert.deepEqual(args, ['view', 'pkg']);
});

test('Windows: runs npm.cmd through a shell with every arg double-quoted', () => {
  const inv = buildNpmInvocation(['view', '@scope/pkg', 'version'], 'win32');
  assert.equal(inv.command, 'npm.cmd');
  assert.equal(inv.shell, true);
  assert.deepEqual(inv.args, ['"view"', '"@scope/pkg"', '"version"']);
});

test('Windows: doubles trailing backslashes so a dir path keeps its closing quote', () => {
  const inv = buildNpmInvocation(
    ['install', 'pkg', '--prefix', 'C:\\Users\\First Last\\c8ctl\\'],
    'win32',
  );
  assert.equal(inv.args.at(-1), '"C:\\Users\\First Last\\c8ctl\\\\"');
});

test('Windows: rejects an argument containing a double quote', () => {
  assert.throws(
    () => buildNpmInvocation(['view', 'pk"g'], 'win32'),
    /cannot be passed safely to cmd\.exe/,
  );
});

test('Windows: rejects an argument containing a line break', () => {
  assert.throws(() => buildNpmInvocation(['view', 'pk\ng'], 'win32'), /quote or line break/);
});

test('Windows: rejects a cmd.exe %VAR% environment-variable reference', () => {
  assert.throws(
    () => buildNpmInvocation(['install', '--prefix', '%APPDATA%\\c8ctl'], 'win32'),
    /environment variable reference/,
  );
});

test('Windows: a percent-encoded URL sequence is not treated as a %VAR% reference', () => {
  // %20 starts with a hex digit, not a letter/underscore, so it is a valid arg.
  const inv = buildNpmInvocation(['view', 'https://example.com/a%20b'], 'win32');
  assert.equal(inv.args.at(-1), '"https://example.com/a%20b"');
});
