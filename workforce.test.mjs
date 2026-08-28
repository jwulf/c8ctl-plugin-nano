// Unit + integration tests for the declarative workforce manifest feature
// (issue #117): the pure schema/mapping/reconcile helpers, plus the on-disk
// manifest round-trip against an isolated C8CTL_NANO_HOME temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  WORKFORCE_MANIFEST_VERSION,
  DEFAULT_WORKFORCE_MANIFEST,
  isValidManifestName,
  emptyWorkforceManifest,
  parseRolesList,
  rolesToJobTypes,
  manifestEntryToWorkArgs,
  workforceOwnerPrefix,
  workforceWorkerName,
  expandWorkforceDesired,
  reconcileWorkforce,
  normalizeManifestEntry,
  validateWorkforceManifest,
  readWorkforceManifestStrict,
  writeWorkforceManifest,
  listWorkforceManifestNames,
  getWorkforceManifestFile,
  upsertManifestEntry,
  removeManifestEntry,
  buildWorkforceStatus,
  formatWorkforceStatus,
  formatWorkforceManifest,
  workforceManifestName,
} from './c8ctl-plugin.js';

// --- defaults --------------------------------------------------------------

test('DEFAULT_WORKFORCE_MANIFEST is "default" and version is 1', () => {
  assert.equal(DEFAULT_WORKFORCE_MANIFEST, 'default');
  assert.equal(WORKFORCE_MANIFEST_VERSION, 1);
});

test('workforceManifestName resolves --profile, defaulting to "default"', () => {
  assert.equal(workforceManifestName({}), 'default');
  assert.equal(workforceManifestName({ profile: '' }), 'default');
  assert.equal(workforceManifestName({ profile: '  full-fleet ' }), 'full-fleet');
});

test('isValidManifestName accepts profile-charset names, rejects junk', () => {
  assert.equal(isValidManifestName('default'), true);
  assert.equal(isValidManifestName('review-only'), true);
  assert.equal(isValidManifestName('a.b_c-1'), true);
  assert.equal(isValidManifestName(''), false);
  assert.equal(isValidManifestName('-leading'), false);
  assert.equal(isValidManifestName('has/slash'), false);
  assert.equal(isValidManifestName('has space'), false);
});

// --- role → job-type mapping -----------------------------------------------

test('rolesToJobTypes maps each role to <rank>:<role>', () => {
  assert.deepEqual(rolesToJobTypes(['pr-review'], 'senior'), ['senior:pr-review']);
  assert.deepEqual(
    rolesToJobTypes(['pr-review', 'feature'], 'senior'),
    ['senior:pr-review', 'senior:feature'],
  );
  assert.deepEqual(rolesToJobTypes('auto', 'senior'), []); // non-array → none
});

test('parseRolesList dedupes, lowercases, and rejects invalid tokens', () => {
  assert.deepEqual(parseRolesList('pr-review, feature ,PR-REVIEW').roles, ['pr-review', 'feature']);
  assert.deepEqual(parseRolesList(['a', 'b', 'a']).roles, ['a', 'b']);
  const bad = parseRolesList('ok, bad:token');
  assert.deepEqual(bad.roles, ['ok']);
  assert.equal(bad.errors.length, 1);
});

// --- entry → work args -----------------------------------------------------

test('manifestEntryToWorkArgs: auto → --auto [--auto-scope]', () => {
  assert.deepEqual(manifestEntryToWorkArgs({ roles: 'auto' }, 'senior'), ['--auto']);
  assert.deepEqual(
    manifestEntryToWorkArgs({ roles: 'auto', autoScope: 'my-app' }, 'senior'),
    ['--auto', '--auto-scope', 'my-app'],
  );
});

test('manifestEntryToWorkArgs: roles → repeatable --job-type <rank>:<role>', () => {
  assert.deepEqual(
    manifestEntryToWorkArgs({ roles: ['pr-review', 'feature'] }, 'senior'),
    ['--job-type', 'senior:pr-review', '--job-type', 'senior:feature'],
  );
});

test('manifestEntryToWorkArgs appends verbatim escape-hatch args', () => {
  assert.deepEqual(
    manifestEntryToWorkArgs({ roles: 'auto', args: ['--sandbox', 'docker'] }, 'senior'),
    ['--auto', '--sandbox', 'docker'],
  );
});

// --- worker naming ---------------------------------------------------------

test('workforceWorkerName / owner prefix are deterministic', () => {
  assert.equal(workforceOwnerPrefix('default'), 'wf-default-');
  assert.equal(workforceWorkerName('default', 'copilot', 1), 'wf-default-copilot-1');
  assert.equal(workforceWorkerName('default', 'copilot', 5), 'wf-default-copilot-5');
});

test('expandWorkforceDesired flattens entries × instances', () => {
  const m = {
    name: 'default',
    workers: [
      { profile: 'copilot', instances: 2, roles: 'auto' },
      { profile: 'claude', instances: 1, roles: 'auto' },
    ],
  };
  assert.deepEqual(
    expandWorkforceDesired(m).map((d) => d.name),
    ['wf-default-copilot-1', 'wf-default-copilot-2', 'wf-default-claude-1'],
  );
});

// --- reconcile diff (pure) -------------------------------------------------

function desired(names, profile) {
  return names.map((name) => ({ name, profile }));
}

test('reconcile: cold start — everything to start, nothing running', () => {
  const d = desired(['wf-default-copilot-1', 'wf-default-copilot-2'], 'copilot');
  const r = reconcileWorkforce({ desired: d, live: [], manifest: 'default' });
  assert.deepEqual(r.toStart.map((x) => x.name), ['wf-default-copilot-1', 'wf-default-copilot-2']);
  assert.deepEqual(r.toStop, []);
  assert.deepEqual(r.unchanged, []);
});

test('reconcile: no-op re-run — all desired already running', () => {
  const d = desired(['wf-default-copilot-1', 'wf-default-copilot-2'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-copilot-2', profile: 'copilot' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart, []);
  assert.deepEqual(r.toStop, []);
  assert.deepEqual(r.toRestart, []);
  assert.equal(r.unchanged.length, 2);
});

test('reconcile: a down worker is restarted, not counted as unchanged', () => {
  const d = desired(['wf-default-copilot-1', 'wf-default-copilot-2'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot', state: 'running' },
    { id: 'wf-default-copilot-2', profile: 'copilot', state: 'down' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart, []);
  assert.deepEqual(r.toStop, []);
  assert.deepEqual(r.toRestart.map((x) => x.name), ['wf-default-copilot-2']);
  assert.deepEqual(r.unchanged.map((x) => x.name), ['wf-default-copilot-1']);
});

test('reconcile: a worker with no state field is assumed running (unchanged)', () => {
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [{ id: 'wf-default-copilot-1', profile: 'copilot' }];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toRestart, []);
  assert.equal(r.unchanged.length, 1);
});

test('reconcile: scale up starts only the missing instances', () => {
  const d = desired(['wf-default-copilot-1', 'wf-default-copilot-2', 'wf-default-copilot-3'], 'copilot');
  const live = [{ id: 'wf-default-copilot-1', profile: 'copilot' }];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart.map((x) => x.name), ['wf-default-copilot-2', 'wf-default-copilot-3']);
  assert.deepEqual(r.toStop, []);
});

test('reconcile: scale down stops the surplus owned workers', () => {
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-copilot-2', profile: 'copilot' },
    { id: 'wf-default-copilot-3', profile: 'copilot' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart, []);
  assert.deepEqual(r.toStop.sort(), ['wf-default-copilot-2', 'wf-default-copilot-3']);
});

test('reconcile: entry removed stops all of its owned workers', () => {
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-claude-1', profile: 'claude' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStop, ['wf-default-claude-1']);
});

test('reconcile: foreign + other-manifest workers are never touched', () => {
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'myhost-copilot-abcd', profile: 'copilot' }, // hand-added (supervisor add)
    { id: 'wf-other-copilot-1', profile: 'copilot' }, // owned by a DIFFERENT manifest
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart, []);
  assert.deepEqual(r.toStop, []); // neither foreign nor other-manifest worker is ours
  assert.equal(r.unchanged.length, 1);
});

test('reconcile: name collision with a different profile is skipped, not clobbered', () => {
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [{ id: 'wf-default-copilot-1', profile: 'claude' }]; // clashing name, wrong profile
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default' });
  assert.deepEqual(r.toStart, []); // don't start over it
  assert.deepEqual(r.toStop, []); // don't stop it
  assert.equal(r.collisions.length, 1);
  assert.equal(r.collisions[0].name, 'wf-default-copilot-1');
});

// --- entry schema validation -----------------------------------------------

test('normalizeManifestEntry: valid auto entry', () => {
  const { entry, error } = normalizeManifestEntry({ profile: 'copilot', instances: 5, roles: 'auto' });
  assert.equal(error, undefined);
  assert.deepEqual(entry, { profile: 'copilot', instances: 5, roles: 'auto' });
});

test('normalizeManifestEntry: valid roles entry keeps the array', () => {
  const { entry } = normalizeManifestEntry({ profile: 'qwen', instances: 2, roles: ['pr-review', 'feature'] });
  assert.deepEqual(entry.roles, ['pr-review', 'feature']);
});

test('normalizeManifestEntry: bad instances rejected', () => {
  assert.ok(normalizeManifestEntry({ profile: 'copilot', instances: 0 }).error);
  assert.ok(normalizeManifestEntry({ profile: 'copilot', instances: 999 }).error);
  assert.ok(normalizeManifestEntry({ profile: 'copilot', instances: 'abc' }).error);
});

test('normalizeManifestEntry: missing profile rejected', () => {
  assert.ok(normalizeManifestEntry({ instances: 1 }).error);
});

test('normalizeManifestEntry: bad roles shape rejected', () => {
  assert.ok(normalizeManifestEntry({ profile: 'x', roles: 5 }).error);
  assert.ok(normalizeManifestEntry({ profile: 'x', roles: [] }).error);
});

// --- manifest-level validation ---------------------------------------------

test('validateWorkforceManifest refuses an unknown version', () => {
  assert.throws(
    () => validateWorkforceManifest({ version: 2, name: 'default', workers: [] }, '/tmp/x.json'),
    /unsupported version 2/,
  );
});

test('validateWorkforceManifest refuses a non-object', () => {
  assert.throws(() => validateWorkforceManifest([], '/tmp/x.json'), /malformed/);
});

test('validateWorkforceManifest names the file path in entry errors', () => {
  assert.throws(
    () => validateWorkforceManifest({ version: 1, workers: [{ instances: 1 }] }, '/tmp/bad.json'),
    /\/tmp\/bad\.json/,
  );
});

// --- upsert / remove -------------------------------------------------------

test('upsertManifestEntry appends then updates in place by profile', () => {
  let m = emptyWorkforceManifest('default');
  m = upsertManifestEntry(m, { profile: 'copilot', instances: 1, roles: 'auto' });
  m = upsertManifestEntry(m, { profile: 'claude', instances: 1, roles: 'auto' });
  assert.equal(m.workers.length, 2);
  m = upsertManifestEntry(m, { profile: 'copilot', instances: 5, roles: 'auto' });
  assert.equal(m.workers.length, 2); // updated, not appended
  assert.equal(m.workers.find((w) => w.profile === 'copilot').instances, 5);
});

test('removeManifestEntry drops one, and "all" clears', () => {
  let m = emptyWorkforceManifest('default');
  m = upsertManifestEntry(m, { profile: 'copilot', instances: 1, roles: 'auto' });
  m = upsertManifestEntry(m, { profile: 'claude', instances: 1, roles: 'auto' });
  const one = removeManifestEntry(m, 'copilot');
  assert.deepEqual(one.removed, ['copilot']);
  assert.equal(one.manifest.workers.length, 1);
  const none = removeManifestEntry(m, 'nope');
  assert.deepEqual(none.removed, []);
  const cleared = removeManifestEntry(m, 'all');
  assert.deepEqual(cleared.removed.sort(), ['claude', 'copilot']);
  assert.equal(cleared.manifest.workers.length, 0);
});

// --- status join (pure) ----------------------------------------------------

test('buildWorkforceStatus joins entries against live workers (desired vs actual)', () => {
  const manifest = {
    version: 1,
    name: 'default',
    workers: [{ profile: 'copilot', instances: 3, roles: 'auto' }],
  };
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot', state: 'running', pid: 100, uptimeMs: 1000, restarts: 0 },
    { id: 'wf-default-copilot-2', profile: 'copilot', state: 'running', pid: 101, uptimeMs: 2000, restarts: 1 },
    // instance 3 absent
    { id: 'wf-default-copilot-9', profile: 'copilot', state: 'running', pid: 109, uptimeMs: 5, restarts: 0 }, // extra
    { id: 'myhost-copilot-x', profile: 'copilot', state: 'running', pid: 200 }, // foreign — ignored
  ];
  const report = buildWorkforceStatus(manifest, 'default', live, true);
  assert.equal(report.exists, true);
  assert.equal(report.supervisorRunning, true);
  assert.equal(report.entries[0].desired, 3);
  assert.equal(report.entries[0].running, 2);
  assert.equal(report.entries[0].workers.find((w) => w.name === 'wf-default-copilot-3').present, false);
  assert.deepEqual(report.extra.map((w) => w.name), ['wf-default-copilot-9']);
  // Render must not throw and must mention the workforce name.
  assert.match(formatWorkforceStatus(report), /Workforce "default"/);
});

test('buildWorkforceStatus handles an absent manifest', () => {
  const report = buildWorkforceStatus(null, 'default', [], false);
  assert.equal(report.exists, false);
  assert.match(formatWorkforceStatus(report), /no manifest/);
});

test('formatWorkforceManifest renders entries and empty state', () => {
  assert.match(formatWorkforceManifest(emptyWorkforceManifest('default')), /empty/);
  const m = upsertManifestEntry(emptyWorkforceManifest('default'), { profile: 'copilot', instances: 2, roles: ['pr-review'] });
  const out = formatWorkforceManifest(m);
  assert.match(out, /copilot/);
  assert.match(out, /pr-review/);
});

// --- on-disk round-trip ----------------------------------------------------

function withHome(fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-wf-'));
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

test('manifest read/write round-trip and absent → null', () => {
  withHome(() => {
    assert.equal(readWorkforceManifestStrict('default'), null);
    const m = upsertManifestEntry(emptyWorkforceManifest('default'), { profile: 'copilot', instances: 5, roles: 'auto' });
    writeWorkforceManifest(m);
    const back = readWorkforceManifestStrict('default');
    assert.equal(back.version, 1);
    assert.equal(back.name, 'default');
    assert.deepEqual(back.workers, [{ profile: 'copilot', instances: 5, roles: 'auto' }]);
  });
});

test('listWorkforceManifestNames lists .json manifests', () => {
  withHome(() => {
    assert.deepEqual(listWorkforceManifestNames(), []);
    writeWorkforceManifest(emptyWorkforceManifest('default'));
    writeWorkforceManifest(emptyWorkforceManifest('review-only'));
    assert.deepEqual(listWorkforceManifestNames(), ['default', 'review-only']);
  });
});

test('readWorkforceManifestStrict throws (naming the path) on torn JSON', () => {
  withHome(() => {
    const file = getWorkforceManifestFile('default');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ this is not json');
    assert.throws(() => readWorkforceManifestStrict('default'), (err) => {
      assert.match(err.message, /default\.json/);
      assert.match(err.message, /not valid JSON/);
      return true;
    });
  });
});

test('readWorkforceManifestStrict refuses an unknown version on disk', () => {
  withHome(() => {
    mkdirSync(dirname(getWorkforceManifestFile('default')), { recursive: true });
    writeFileSync(getWorkforceManifestFile('default'), JSON.stringify({ version: 99, name: 'default', workers: [] }));
    assert.throws(() => readWorkforceManifestStrict('default'), /unsupported version 99/);
  });
});
