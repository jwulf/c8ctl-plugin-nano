// Unit tests for the `c8ctl nano update --check` changelog. The authoritative
// source is this plugin's PUBLIC GitHub Releases (semantic-release records the
// generated notes there); `filterReleasesSince` selects the window between the
// installed release and latest, and `renderReleaseBody` flattens one release's
// markdown notes to tight terminal lines. Both are pure so they are tested here
// without a network call; `githubRepoSlug` is derived from the package's own
// `repository` field.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareSemver,
  filterReleasesSince,
  githubRepoSlug,
  renderReleaseBody,
} from './c8ctl-plugin.js';

const REL = (tag, body = '', extra = {}) => ({ tag_name: tag, html_url: `https://x/${tag}`, body, ...extra });

test('filterReleasesSince: keeps only versions newer than installed, up to latest, newest-first', () => {
  const releases = [
    REL('v1.28.0'),
    REL('v1.31.0'),
    REL('v1.29.0'),
    REL('v1.30.0'),
  ];
  const got = filterReleasesSince(releases, '1.29.0', '1.31.0').map((r) => r.version);
  assert.deepEqual(got, ['1.31.0', '1.30.0']); // 1.29.0 excluded (== installed), 1.28.0 too old
});

test('filterReleasesSince: excludes anything newer than latest (a pre-published tag)', () => {
  const releases = [REL('v1.30.0'), REL('v1.32.0'), REL('v1.31.0')];
  const got = filterReleasesSince(releases, '1.29.0', '1.31.0').map((r) => r.version);
  assert.deepEqual(got, ['1.31.0', '1.30.0']);
});

test('filterReleasesSince: skips drafts, pre-releases, and non-semver / malformed tags', () => {
  const releases = [
    REL('v1.31.0'),
    REL('v1.32.0', 'draft', { draft: true }),
    REL('v1.33.0-rc.1'), // pre-release tag → normalised to 1.33.0 but > latest, filtered by window
    REL('nightly'),
    REL(''),
    { name: 'no tag field' },
    null,
  ];
  const got = filterReleasesSince(releases, '1.30.0', '1.31.0').map((r) => r.version);
  assert.deepEqual(got, ['1.31.0']);
});

test('filterReleasesSince: excludes a pre-release even when it falls inside the window', () => {
  const releases = [
    REL('v1.31.0'),
    REL('v1.30.5-rc.1'), // in-window by version, but a pre-release tag → excluded
    REL('v1.30.8', 'flagged', { prerelease: true }), // in-window, but prerelease:true → excluded
  ];
  const got = filterReleasesSince(releases, '1.30.0', '1.31.0').map((r) => r.version);
  assert.deepEqual(got, ['1.31.0']);
});

test('filterReleasesSince: excludes a pre-release inside the window even with no known latest', () => {
  const releases = [
    REL('v2.0.0'),
    REL('v1.9.0-beta.2'), // pre-release tag → excluded despite being newer than installed
    REL('v1.8.5', '', { prerelease: true }), // prerelease:true → excluded
  ];
  const got = filterReleasesSince(releases, '1.8.0', null).map((r) => r.version);
  assert.deepEqual(got, ['2.0.0']);
});

test('filterReleasesSince: with no known latest, returns everything newer than installed', () => {
  const releases = [REL('v2.0.0'), REL('v1.9.0'), REL('v1.8.0')];
  const got = filterReleasesSince(releases, '1.8.0', null).map((r) => r.version);
  assert.deepEqual(got, ['2.0.0', '1.9.0']);
});

test('filterReleasesSince: tolerates a non-array input', () => {
  assert.deepEqual(filterReleasesSince(null, '1.0.0', '2.0.0'), []);
  assert.deepEqual(filterReleasesSince(undefined, '1.0.0', '2.0.0'), []);
  assert.deepEqual(filterReleasesSince({ message: 'Not Found' }, '1.0.0', '2.0.0'), []);
});

test('renderReleaseBody: drops the redundant version header, labels sections, flattens bullets', () => {
  const body = [
    '# [1.31.0](https://github.com/jwulf/c8ctl-plugin-nano/compare/v1.30.0...v1.31.0) (2026-08-13)',
    '',
    '',
    '### Features',
    '',
    '* consume linkedResources header ([#68](https://x/68)) ([abc1234](https://x/c/abc1234)), closes [#60](https://x/60)',
  ].join('\n');
  assert.deepEqual(renderReleaseBody(body), [
    '    Features:',
    '      \u2022 consume linkedResources header, closes #60',
  ]);
});

test('renderReleaseBody: strips **scope** bold and inlines remaining [text](url) links', () => {
  const body = '### Bug Fixes\n\n* **work:** decouple the [broker lock](https://x/lock) ([#24](https://x/24))';
  assert.deepEqual(renderReleaseBody(body), [
    '    Bug Fixes:',
    '      \u2022 work: decouple the broker lock',
  ]);
});

test('renderReleaseBody: handles a body with no bullets gracefully', () => {
  assert.deepEqual(renderReleaseBody('# [1.2.3] just a header'), []);
  assert.deepEqual(renderReleaseBody(''), []);
});

test('githubRepoSlug: resolves owner/repo from this package.json', () => {
  // The plugin's own package.json repository.url is https://github.com/jwulf/c8ctl-plugin-nano
  assert.equal(githubRepoSlug(), 'jwulf/c8ctl-plugin-nano');
});

test('compareSemver: orders the changelog window bounds correctly', () => {
  assert.equal(compareSemver('1.30.0', '1.31.0'), -1);
  assert.equal(compareSemver('1.31.0', '1.31.0'), 0);
  assert.equal(compareSemver('2.0.0', '1.31.0'), 1);
});
