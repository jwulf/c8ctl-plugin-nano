module.exports = {
  branches: [
    { name: 'main' },
    { name: 'stable/*', range: '${name.replace(/^stable\\//,"")}.x', channel: '${name.replace(/^stable\\//,"")}-stable' },
  ],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Platform packages: pin the root's optionalDependencies and stage one npm
    // package per platform from the downloaded binaries (prepare), then publish
    // them BEFORE the root meta-package (publish). This plugin is listed before
    // @semantic-release/npm so its publish step runs first.
    [
      '@semantic-release/exec',
      {
        prepareCmd:
          'node scripts/stamp-optional-deps.mjs ${nextRelease.version} && ' +
          'node scripts/build-platform-packages.mjs ${nextRelease.version} ./binaries',
        publishCmd: 'node scripts/publish-platform-packages.mjs ${nextRelease.version}',
      },
    ],
    ['@semantic-release/npm', { npmPublish: true }],
    [
      '@semantic-release/git',
      {
        // package.json is intentionally NOT committed: the release-time
        // optionalDependencies are injected into the published tarball only, so
        // the working tree (and package-lock.json) stay free of pinned,
        // per-release platform-package versions and "npm ci" never drifts.
        assets: ['CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
};
