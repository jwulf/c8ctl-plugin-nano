// The freshness gate (`scripts/check-bundle.mjs`) is a CI acceptance criterion:
// it must fail a stale committed `supervisor.dist.js` AND a missing/untracked
// one, and pass an in-sync bundle. `npm test` only ever runs it against an
// in-sync checkout, so its failure paths (the critical stale/missing branches)
// would otherwise go unexercised. These tests drive the real checker against a
// throwaway git repo (via `CHECK_BUNDLE_ROOT`) with a stub `supervisor/build.mjs`
// that writes a deterministic bundle, and assert exit code + actionable message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'check-bundle.mjs');

// A stub build step: writes a fixed "clean rebuild" so the test is hermetic and
// does not invoke esbuild/Effect. `check-bundle.mjs` runs `supervisor/build.mjs`.
const STUB_BUILD = `import { writeFileSync } from 'node:fs';\n` +
  `import { join, dirname } from 'node:path';\n` +
  `import { fileURLToPath } from 'node:url';\n` +
  `const root = join(dirname(fileURLToPath(import.meta.url)), '..');\n` +
  `writeFileSync(join(root, 'supervisor.dist.js'), 'CLEAN\\n');\n`;

const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'check-bundle-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, 'supervisor'));
  writeFileSync(join(root, 'supervisor', 'build.mjs'), STUB_BUILD);
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker], {
    env: { ...process.env, CHECK_BUNDLE_ROOT: root },
    encoding: 'utf8',
  });
}

test('check-bundle: fails when the committed bundle is stale', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'supervisor.dist.js'), 'STALE\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'stale bundle');

    const res = runChecker(root);
    assert.equal(res.status, 1, 'expected non-zero exit for a stale bundle');
    assert.match(res.stderr, /stale/i);
    // The acceptance criterion is an *actionable* message: it must tell the
    // contributor how to restore the production artifact.
    assert.match(res.stderr, /npm run build:supervisor/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-bundle: fails when the bundle is missing / untracked', () => {
  const root = makeRepo();
  try {
    // Commit without a tracked bundle; the rebuild recreates it untracked, which
    // a bare `git diff` would silently accept.
    writeFileSync(join(root, 'README'), 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'no bundle');

    const res = runChecker(root);
    assert.equal(res.status, 1, 'expected non-zero exit for a missing bundle');
    assert.match(res.stderr, /not tracked/i);
    // As with the stale path, the failure must point at the documented recovery
    // command so a contributor knows how to regenerate the missing artifact.
    assert.match(res.stderr, /npm run build:supervisor/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-bundle: passes when the committed bundle is in sync', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'supervisor.dist.js'), 'CLEAN\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'clean bundle');

    const res = runChecker(root);
    assert.equal(res.status, 0, res.stderr || 'expected zero exit for an in-sync bundle');
    assert.match(res.stdout, /in sync/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
