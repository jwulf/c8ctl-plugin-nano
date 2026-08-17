// Unit tests for the pre-upgrade read-model backup (issue #85). A
// schema-changing gateway release can reproject and silently drop history, so
// before an upgrade swaps the binary the launcher snapshots each per-node read
// model. These tests drive the real backup/prune helpers against an isolated
// C8CTL_NANO_HOME temp dir so nothing touches the operator's real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backupReadModelsBeforeUpgrade,
  pruneReadModelBackups,
  sanitizeVersionTag,
  READ_MODEL_BACKUP_RING,
} from './c8ctl-plugin.js';

// Silence the plugin logger so test output stays clean; restore on exit.
const prevC8ctl = globalThis.c8ctl;
globalThis.c8ctl = {
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
};
process.on('exit', () => {
  if (prevC8ctl === undefined) delete globalThis.c8ctl;
  else globalThis.c8ctl = prevC8ctl;
});

function withHome(fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-backup-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = HOME;
  try {
    return fn(HOME);
  } finally {
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(HOME, { recursive: true, force: true });
  }
}

function seedNode(HOME, node, files) {
  const dir = join(HOME, 'data', node);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function backupFiles(nodeDir) {
  const dir = join(nodeDir, 'read-model-backups');
  return existsSync(dir) ? readdirSync(dir) : [];
}

test('sanitizeVersionTag makes a filesystem-safe tag', () => {
  assert.equal(sanitizeVersionTag('1.33.0'), '1.33.0');
  assert.equal(sanitizeVersionTag('v2.0.0-rc.1+build'), 'v2.0.0-rc.1-build');
  assert.equal(sanitizeVersionTag(null), 'unknown');
  assert.equal(sanitizeVersionTag('   '), 'unknown');
});

test('backs up read-model.sqlite plus wal/shm and point-in-time set', () => {
  withHome((HOME) => {
    const nodeDir = seedNode(HOME, 'node-0', {
      'read-model.sqlite': 'DB',
      'read-model.sqlite-wal': 'WAL',
      'read-model.sqlite-shm': 'SHM',
      'journal.head': 'HEAD',
      'snapshot.000123.bin': 'SNAP',
      'unrelated.txt': 'skip me',
    });

    const written = backupReadModelsBeforeUpgrade('1.33.0');
    assert.equal(written.length, 1);

    const files = backupFiles(nodeDir).sort();
    const primary = files.find((f) => f.endsWith('.sqlite'));
    assert.ok(primary && primary.startsWith('read-model.pre-upgrade-1.33.0-'), primary);
    const stem = primary.slice(0, -'.sqlite'.length);

    // The sidecars and coherent set travel with the DB; unrelated files do not.
    assert.ok(files.includes(`${stem}.sqlite-wal`));
    assert.ok(files.includes(`${stem}.sqlite-shm`));
    assert.ok(files.includes(`${stem}.journal.head`));
    assert.ok(files.includes(`${stem}.snapshot.000123.bin`));
    assert.ok(!files.some((f) => f.includes('unrelated')));

    // Content is a faithful copy, and the live files are left untouched.
    const bdir = join(nodeDir, 'read-model-backups');
    assert.equal(readFileSync(join(bdir, `${stem}.sqlite`), 'utf8'), 'DB');
    assert.equal(readFileSync(join(bdir, `${stem}.sqlite-wal`), 'utf8'), 'WAL');
    assert.equal(readFileSync(join(nodeDir, 'read-model.sqlite'), 'utf8'), 'DB');
  });
});

test('backs up every node and skips nodes with no read model', () => {
  withHome((HOME) => {
    const n0 = seedNode(HOME, 'node-0', { 'read-model.sqlite': 'A' });
    const n1 = seedNode(HOME, 'node-1', { 'read-model.sqlite': 'B' });
    // In-memory node: no read model on disk -> nothing to back up.
    const n2 = seedNode(HOME, 'node-2', { 'journal.head': 'only head' });

    const written = backupReadModelsBeforeUpgrade('1.0.0');
    assert.equal(written.length, 2);
    assert.equal(backupFiles(n0).filter((f) => f.endsWith('.sqlite')).length, 1);
    assert.equal(backupFiles(n1).filter((f) => f.endsWith('.sqlite')).length, 1);
    assert.equal(backupFiles(n2).length, 0);
  });
});

test('returns nothing when there is no data dir yet', () => {
  withHome(() => {
    const written = backupReadModelsBeforeUpgrade('1.0.0');
    assert.deepEqual(written, []);
  });
});

test('prunes to a bounded ring, keeping the newest sets', () => {
  withHome((HOME) => {
    const nodeDir = join(HOME, 'data', 'node-0');
    const bdir = join(nodeDir, 'read-model-backups');
    mkdirSync(bdir, { recursive: true });

    // Seed 4 backup sets with increasing mtimes; each set is a .sqlite + -wal.
    const base = Date.now() - 10_000;
    for (let i = 0; i < 4; i++) {
      const stem = `read-model.pre-upgrade-1.0.0-set${i}`;
      writeFileSync(join(bdir, `${stem}.sqlite`), `db${i}`);
      writeFileSync(join(bdir, `${stem}.sqlite-wal`), `wal${i}`);
      const t = new Date(base + i * 1000);
      utimesSync(join(bdir, `${stem}.sqlite`), t, t);
    }

    pruneReadModelBackups(bdir, 2);

    const remaining = readdirSync(bdir);
    const sqlites = remaining.filter((f) => f.endsWith('.sqlite')).sort();
    assert.deepEqual(sqlites, [
      'read-model.pre-upgrade-1.0.0-set2.sqlite',
      'read-model.pre-upgrade-1.0.0-set3.sqlite',
    ]);
    // Sidecars of the dropped sets go too.
    assert.ok(!remaining.includes('read-model.pre-upgrade-1.0.0-set0.sqlite-wal'));
    assert.ok(remaining.includes('read-model.pre-upgrade-1.0.0-set3.sqlite-wal'));
  });
});

test('backup enforces the default ring across repeated upgrades', () => {
  withHome((HOME) => {
    const nodeDir = seedNode(HOME, 'node-0', { 'read-model.sqlite': 'DB' });
    // Run more upgrades than the ring; each backup's timestamp includes
    // milliseconds (toISOString) so the sets are uniquely named per iteration —
    // pass an explicit small ring to make the assertion deterministic here.
    for (let i = 0; i < READ_MODEL_BACKUP_RING + 3; i++) {
      backupReadModelsBeforeUpgrade(`1.0.${i}`, 3);
    }
    const sqlites = backupFiles(nodeDir).filter((f) => f.endsWith('.sqlite'));
    assert.ok(sqlites.length <= 3, `expected <=3 kept, got ${sqlites.length}`);
  });
});
