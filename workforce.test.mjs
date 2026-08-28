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
  workforceProfileFromWorkerName,
  isWorkforceOwnedWorker,
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
  lastProfileValue,
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
  assert.equal(workforceManifestName({ profile: ['a', 'full-fleet'] }), 'full-fleet');
  assert.equal(workforceManifestName({ profile: [] }), 'default');
});

test('lastProfileValue honors the last --profile value, matching manifest selection', () => {
  assert.equal(lastProfileValue({}), '');
  assert.equal(lastProfileValue({ profile: '' }), '');
  assert.equal(lastProfileValue({ profile: '  full-fleet ' }), 'full-fleet');
  assert.equal(lastProfileValue({ profile: ['a', 'full-fleet'] }), 'full-fleet');
  assert.equal(lastProfileValue({ profile: [] }), '');
  // A trailing empty repeat must be treated as "not explicit" so listing stays
  // consistent with the (default) manifest workforceManifestName resolves.
  assert.equal(lastProfileValue({ profile: ['review-only', ''] }), '');
  assert.equal(workforceManifestName({ profile: ['review-only', ''] }), 'default');
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

test('parseRolesList splits comma-separated items inside a repeated-flag array', () => {
  assert.deepEqual(parseRolesList(['pr-review,feature', 'bugfix']).roles, ['pr-review', 'feature', 'bugfix']);
  assert.deepEqual(parseRolesList(['a, b', 'B ,c']).roles, ['a', 'b', 'c']);
});

test('parseRolesList rejects non-string array items instead of coercing them', () => {
  const res = parseRolesList(['pr-review', true, { x: 1 }, 42, null]);
  assert.deepEqual(res.roles, ['pr-review']);
  assert.equal(res.errors.length, 4);
  for (const e of res.errors) assert.match(e, /expected a role-name string/);
});

test('parseRolesList rejects a non-string scalar (value-less flag) but treats nullish as empty', () => {
  const boolRes = parseRolesList(true);
  assert.deepEqual(boolRes.roles, []);
  assert.equal(boolRes.errors.length, 1);
  assert.match(boolRes.errors[0], /expected a role-name string/);
  // A nullish scalar means "no roles supplied": empty, no error.
  assert.deepEqual(parseRolesList(undefined), { roles: [], errors: [] });
  assert.deepEqual(parseRolesList(null), { roles: [], errors: [] });
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

test('reconcile: a skipped profile\'s live workers are protected, not stopped', () => {
  // "claude" could not be resolved this run (missing hire), so it produces no
  // desired workers. Its already-running workers must NOT be torn down.
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-claude-1', profile: 'claude' },
    { id: 'wf-default-claude-2', profile: 'claude' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default', skippedProfiles: ['claude'] });
  assert.deepEqual(r.toStop, []); // config error tears down nothing
  assert.deepEqual(r.protected.sort(), ['wf-default-claude-1', 'wf-default-claude-2']);
  assert.equal(r.unchanged.length, 1);
});

test('reconcile: a skipped profile with a dash prefix does not protect a longer profile\'s workers', () => {
  // "a" is skipped; "a-b" is a genuine removal. A prefix `startsWith` check on
  // `wf-default-a-` would wrongly protect `wf-default-a-b-*`; embedded-profile
  // parsing compares exactly, so only "a"'s workers are protected.
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-a-1', profile: 'a' },
    { id: 'wf-default-a-b-1', profile: 'a-b' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default', skippedProfiles: ['a'] });
  assert.deepEqual(r.protected, ['wf-default-a-1']); // only exact-profile "a"
  assert.deepEqual(r.toStop, ['wf-default-a-b-1']);  // "a-b" is not protected
});

test('reconcile: without skippedProfiles a removed entry\'s workers are still stopped', () => {
  // Guard: protection is scoped to skipped profiles only — a genuine removal
  // (entry gone, profile resolvable) still stops the surplus.
  const d = desired(['wf-default-copilot-1'], 'copilot');
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot' },
    { id: 'wf-default-claude-1', profile: 'claude' },
  ];
  const r = reconcileWorkforce({ desired: d, live, manifest: 'default', skippedProfiles: [] });
  assert.deepEqual(r.toStop, ['wf-default-claude-1']);
  assert.deepEqual(r.protected, []);
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

test('normalizeManifestEntry: invalid profile charset rejected', () => {
  const bad = normalizeManifestEntry({ profile: 'bad name', instances: 1 });
  assert.ok(bad.error, 'a profile with a space must be rejected');
  assert.match(bad.error, /invalid profile name/);
  assert.ok(normalizeManifestEntry({ profile: 'has/slash', instances: 1 }).error);
  // A valid safe-charset profile still passes.
  assert.equal(normalizeManifestEntry({ profile: 'copilot.v2_1-a', instances: 1 }).error, undefined);
});

test('normalizeManifestEntry: bad roles shape rejected', () => {
  assert.ok(normalizeManifestEntry({ profile: 'x', roles: 5 }).error);
  assert.ok(normalizeManifestEntry({ profile: 'x', roles: [] }).error);
});

test('normalizeManifestEntry: absent roles field defaults to auto', () => {
  const { entry, error } = normalizeManifestEntry({ profile: 'copilot', instances: 1 });
  assert.equal(error, undefined);
  assert.equal(entry.roles, 'auto');
});

test('normalizeManifestEntry: explicit null roles rejected as malformed', () => {
  const { entry, error } = normalizeManifestEntry({ profile: 'copilot', instances: 1, roles: null });
  assert.equal(entry, undefined);
  assert.match(error, /roles must be "auto" or an array/);
});

test('normalizeManifestEntry: valid string args are kept', () => {
  const { entry, error } = normalizeManifestEntry({ profile: 'copilot', instances: 1, args: ['--sandbox', 'docker'] });
  assert.equal(error, undefined);
  assert.deepEqual(entry.args, ['--sandbox', 'docker']);
});

test('normalizeManifestEntry: absent args yields no args key', () => {
  const { entry, error } = normalizeManifestEntry({ profile: 'copilot', instances: 1 });
  assert.equal(error, undefined);
  assert.equal('args' in entry, false);
});

test('normalizeManifestEntry: malformed args rejected instead of silently dropped', () => {
  // Non-array args field.
  assert.match(normalizeManifestEntry({ profile: 'copilot', instances: 1, args: '--sandbox' }).error, /args must be an array/);
  // Boolean element (e.g. a value-less flag torn into the manifest) must be
  // refused, not silently dropped by normalizeArgList.
  assert.match(normalizeManifestEntry({ profile: 'copilot', instances: 1, args: [true] }).error, /invalid arg/);
  // Non-string element.
  assert.match(normalizeManifestEntry({ profile: 'copilot', instances: 1, args: ['--flag', 5] }).error, /invalid arg/);
  // Empty-string element is likewise silently dropped by normalizeArgList — refuse it.
  assert.match(normalizeManifestEntry({ profile: 'copilot', instances: 1, args: [''] }).error, /empty string/);
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

test('validateWorkforceManifest refuses a non-array workers field (naming the path)', () => {
  assert.throws(
    () => validateWorkforceManifest({ version: 1, name: 'default', workers: {} }, '/tmp/torn.json'),
    /\/tmp\/torn\.json.*malformed "workers"/,
  );
});

test('validateWorkforceManifest refuses an explicit null workers field', () => {
  assert.throws(
    () => validateWorkforceManifest({ version: 1, name: 'default', workers: null }, '/tmp/torn.json'),
    /\/tmp\/torn\.json.*malformed "workers".*got null/,
  );
});

test('validateWorkforceManifest allows an absent workers field (empty manifest)', () => {
  const m = validateWorkforceManifest({ version: 1, name: 'default' }, '/tmp/ok.json');
  assert.deepEqual(m.workers, []);
});

test('validateWorkforceManifest rejects duplicate profiles (naming the path)', () => {
  assert.throws(
    () => validateWorkforceManifest(
      { version: 1, name: 'default', workers: [{ profile: 'copilot', instances: 1 }, { profile: 'copilot', instances: 2 }] },
      '/tmp/dup.json',
    ),
    /\/tmp\/dup\.json.*duplicate profile.*copilot/,
  );
});

test('validateWorkforceManifest allows one profile with multiple instances', () => {
  const m = validateWorkforceManifest(
    { version: 1, name: 'default', workers: [{ profile: 'copilot', instances: 3 }] },
    '/tmp/ok.json',
  );
  assert.equal(m.workers.length, 1);
  assert.equal(m.workers[0].instances, 3);
});

test('workforceProfileFromWorkerName parses the embedded profile (incl. dashes)', () => {
  assert.equal(workforceProfileFromWorkerName('default', 'wf-default-copilot-1'), 'copilot');
  assert.equal(workforceProfileFromWorkerName('default', 'wf-default-my-agent-12'), 'my-agent');
  // Foreign prefix / no index counter → null (not one of ours to parse).
  assert.equal(workforceProfileFromWorkerName('default', 'other-worker-1'), null);
  assert.equal(workforceProfileFromWorkerName('default', 'wf-default-noindex'), null);
});

test('isWorkforceOwnedWorker: plain prefix match when no other manifests exist', () => {
  assert.equal(isWorkforceOwnedWorker('wf-a-copilot-1', 'a', ['a']), true);
  assert.equal(isWorkforceOwnedWorker('wf-a-copilot-1', 'a', []), true);
  assert.equal(isWorkforceOwnedWorker('wf-a-copilot-1', 'a', undefined), true);
  // A foreign id (no prefix) is never owned.
  assert.equal(isWorkforceOwnedWorker('sup-a-copilot-1', 'a', ['a']), false);
  assert.equal(isWorkforceOwnedWorker(42, 'a', ['a']), false);
});

test('isWorkforceOwnedWorker: longest-prefix disambiguates when a-b also exists', () => {
  // wf-a-b-p-1 belongs to manifest "a-b", NOT manifest "a", even though the
  // "wf-a-" prefix technically matches — "a-b" is a longer existing prefix.
  assert.equal(isWorkforceOwnedWorker('wf-a-b-p-1', 'a', ['a', 'a-b']), false);
  assert.equal(isWorkforceOwnedWorker('wf-a-b-p-1', 'a-b', ['a', 'a-b']), true);
  // Manifest "a" still owns its own non-colliding workers.
  assert.equal(isWorkforceOwnedWorker('wf-a-p-1', 'a', ['a', 'a-b']), true);
  // If the more-specific manifest is gone from disk, its lingering workers fall
  // back to the prefix owner as orphans (degrades to plain prefix behaviour).
  assert.equal(isWorkforceOwnedWorker('wf-a-b-p-1', 'a', ['a']), true);
});

test('reconcileWorkforce: does not stop another manifest\'s prefix-colliding workers', () => {
  // Manifest "a" desires one worker; a live "wf-a-b-..." worker belongs to
  // manifest "a-b" and must NOT be swept into toStop when both manifests exist.
  const desired = [{ name: 'wf-a-copilot-1', profile: 'copilot', args: [] }];
  const live = [
    { id: 'wf-a-copilot-1', profile: 'copilot', state: 'running' },
    { id: 'wf-a-b-copilot-1', profile: 'copilot', state: 'running' },
  ];
  const r = reconcileWorkforce({ desired, live, manifest: 'a', manifestNames: ['a', 'a-b'] });
  assert.deepEqual(r.toStop, []);
  assert.equal(r.unchanged.length, 1);
  // Without the manifest-name set, the old prefix behaviour would claim it.
  const r2 = reconcileWorkforce({ desired, live, manifest: 'a' });
  assert.deepEqual(r2.toStop, ['wf-a-b-copilot-1']);
});

test('buildWorkforceStatus: excludes another manifest\'s prefix-colliding workers from extra', () => {
  const manifest = { version: 1, name: 'a', workers: [{ profile: 'copilot', instances: 1, roles: 'auto' }] };
  const live = [
    { id: 'wf-a-copilot-1', profile: 'copilot', state: 'running' },
    { id: 'wf-a-b-copilot-1', profile: 'copilot', state: 'running' },
  ];
  const report = buildWorkforceStatus(manifest, 'a', live, true, ['a', 'a-b']);
  assert.deepEqual(report.extra, []);
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

test('buildWorkforceStatus treats a live worker with no state field as running', () => {
  const manifest = {
    version: 1,
    name: 'default',
    workers: [{ profile: 'copilot', instances: 1, roles: 'auto' }],
  };
  const live = [
    { id: 'wf-default-copilot-1', profile: 'copilot', pid: 100 }, // no `state` (older payload)
    { id: 'wf-default-copilot-9', profile: 'copilot', pid: 109 }, // extra, no `state`
  ];
  const report = buildWorkforceStatus(manifest, 'default', live, true);
  assert.equal(report.entries[0].running, 1);
  assert.equal(report.entries[0].workers[0].state, 'running');
  assert.equal(report.extra[0].state, 'running');
});

test('buildWorkforceStatus: a name collision with a different profile is not counted as running', () => {
  const manifest = {
    version: 1,
    name: 'default',
    workers: [{ profile: 'copilot', instances: 1, roles: 'auto' }],
  };
  // The desired name is taken by a worker running a DIFFERENT profile — exactly
  // the case `workforce start`/reconcile skips as a collision. It must not
  // satisfy the desired instance nor be counted running.
  const live = [
    { id: 'wf-default-copilot-1', profile: 'claude', state: 'running', pid: 100 },
  ];
  const report = buildWorkforceStatus(manifest, 'default', live, true);
  assert.equal(report.entries[0].running, 0);
  const w = report.entries[0].workers[0];
  assert.equal(w.present, false);
  assert.equal(w.state, 'absent');
  assert.equal(w.collision, 'claude');
  assert.equal(w.pid, null);
  // The desired name is claimed, so the intruder is not "extra" either.
  assert.equal(report.extra.length, 0);
  assert.match(formatWorkforceStatus(report), /collision\(claude\)/);
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

test('listWorkforceManifestNames drops names that --profile could never select', () => {
  withHome(() => {
    writeWorkforceManifest(emptyWorkforceManifest('default'));
    // A hand-dropped file whose stem is not a valid manifest name (has a space).
    mkdirSync(dirname(getWorkforceManifestFile('default')), { recursive: true });
    writeFileSync(join(dirname(getWorkforceManifestFile('default')), 'bad name.json'), '{}');
    assert.deepEqual(listWorkforceManifestNames(), ['default']);
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
