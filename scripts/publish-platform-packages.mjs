#!/usr/bin/env node
/**
 * Publish the staged per-platform packages to npm.
 *
 *   node scripts/publish-platform-packages.mjs <version>
 *
 * Run after build-platform-packages.mjs. Publishes each npm-platforms/<pkg> at
 * <version>. Idempotent: if a package@version is already on the registry it is
 * skipped (so a re-run after a partial failure is safe).
 *
 * Auth:
 *   - OIDC / Trusted Publishing when run in GitHub Actions with id-token (each
 *     platform package must be registered as a trusted publisher on npmjs.com).
 *   - Otherwise falls back to whatever npm auth is configured (e.g. an
 *     NPM_TOKEN-backed ~/.npmrc) for the initial bootstrap publish.
 *
 * Provenance is enabled via NPM_CONFIG_PROVENANCE in the workflow (requires a
 * public repo).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outRoot = join(repoRoot, 'npm-platforms');

const version = process.argv[2];
if (!version) {
  console.error('usage: publish-platform-packages.mjs <version>');
  process.exit(1);
}

// Trusted publishing (OIDC): npm (>=11.5.1) only authenticates via the workflow
// id-token when NO `_authToken` is configured for the registry. `actions/setup-node`
// (registry-url) writes a placeholder `_authToken` line, and @semantic-release/npm
// can write a root-package-scoped OIDC token into the same .npmrc during its own
// flow — either would make these plain `npm publish` calls reuse the wrong/absent
// credential instead of doing a per-package OIDC exchange. Strip any `_authToken`
// line here so each platform publish authenticates via OIDC. No-op locally.
function stripNpmAuthToken() {
  const npmrc = process.env.NPM_CONFIG_USERCONFIG;
  if (!npmrc || !existsSync(npmrc)) return;
  const before = readFileSync(npmrc, 'utf8');
  const after = before
    .split('\n')
    .filter((line) => !/_authToken/.test(line))
    .join('\n');
  if (after !== before) {
    writeFileSync(npmrc, after);
    console.log(`stripped _authToken from ${npmrc} for OIDC trusted publishing`);
  }
}

function alreadyPublished(pkg) {
  try {
    execFileSync('npm', ['view', `${pkg}@${version}`, 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const deferred = [];
stripNpmAuthToken();
for (const p of PLATFORMS) {
  const dir = join(outRoot, p.pkg);
  if (!existsSync(dir)) {
    console.error(`staged package missing: ${dir} (run build-platform-packages.mjs first)`);
    process.exit(1);
  }
  if (alreadyPublished(p.pkg)) {
    console.log(`skip ${p.pkg}@${version} (already published)`);
    continue;
  }
  console.log(`publishing ${p.pkg}@${version} ...`);
  try {
    const out = execFileSync('npm', ['publish', '--access', 'public'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    if (out) process.stdout.write(out);
  } catch (err) {
    const combined = `${err.stdout || ''}${err.stderr || ''}`;
    if (combined) process.stdout.write(combined);
    // npm's spam-detection heuristic (E403 "Package name triggered spam
    // detection") blocks a brand-new package name pending a manual npm support
    // review. Don't fail the whole release over it: publish the platforms npm
    // accepted plus the meta-package, so the plugin works everywhere npm let us
    // in. The meta-package lists every platform as an optionalDependency at this
    // exact version, so once the name is cleared a re-run publishes the deferred
    // package and installs pick it up automatically. Any other error is fatal.
    if (/triggered spam detection/i.test(combined)) {
      console.warn(
        `::warning::deferring ${p.pkg}@${version}: npm rejected the package name (E403 spam detection). ` +
          `Re-run this workflow after npm support clears the name to publish it at the same version.`,
      );
      deferred.push(p.pkg);
      continue;
    }
    throw err;
  }
}

if (deferred.length) {
  console.warn(
    `platform packages published with ${deferred.length} deferred: ${deferred.join(', ')}. ` +
      `Re-run after the npm name(s) are cleared.`,
  );
} else {
  console.log('platform packages published.');
}
