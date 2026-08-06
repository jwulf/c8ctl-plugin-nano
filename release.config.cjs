module.exports = {
  branches: [
    { name: 'main' },
    { name: 'stable/*', range: '${name.replace(/^stable\\//,"")}.x', channel: '${name.replace(/^stable\\//,"")}-stable' },
  ],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    // NOTE: no @semantic-release/changelog or @semantic-release/git plugin here.
    // The `main` branch is protected by a ruleset (added 2026-08-05) that
    // requires every change to go through a pull request. @semantic-release/git
    // pushes the `chore(release): x [skip ci]` commit STRAIGHT to main, which is
    // rejected (GH013 "Changes must be made through a pull request"), failing
    // the whole release. There is no usable bypass for the workflow's
    // GITHUB_TOKEN: GitHub refuses to add the github-actions app as a ruleset
    // bypass actor on a personal (non-org) repo. So we drop the branch commit-
    // back entirely: releases push only the git TAG (by semantic-release core;
    // tags are not covered by this branch ruleset), publish to npm, and record
    // the notes on the GitHub Release (via @semantic-release/github below). The
    // repo therefore no longer carries a committed CHANGELOG.md.
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
    '@semantic-release/github',
  ],
};
