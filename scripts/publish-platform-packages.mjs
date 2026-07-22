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
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outRoot = join(repoRoot, 'npm-platforms');
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

const version = process.argv[2];
if (!version) {
  console.error('usage: publish-platform-packages.mjs <version>');
  process.exit(1);
}

// Trusted publishing (OIDC): npm's built-in auto-OIDC does not fire for these
// plain `npm publish` subprocesses (they exit ENEEDAUTH even with no token and a
// recent npm), so — exactly like @semantic-release/npm does for the root package
// — perform the OIDC token exchange explicitly per platform package: fetch a
// GitHub Actions OIDC JWT for the npm audience, exchange it at the npm registry
// for a short-lived package-scoped publish token, and hand that to `npm publish`.
// Requires `id-token: write` (sets ACTIONS_ID_TOKEN_REQUEST_*) and a Trusted
// Publisher configured for each package on npmjs.com. Returns undefined outside a
// GitHub OIDC context (e.g. local runs), so publishing falls back to ambient auth.
async function githubIdToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) return undefined;
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) {
    console.warn(`::warning::GitHub OIDC id-token request failed: ${res.status}`);
    return undefined;
  }
  const body = await res.json();
  return body.value;
}

async function npmOidcToken(pkgName) {
  const idToken = await githubIdToken('npm:registry.npmjs.org');
  if (!idToken) return undefined;
  const res = await fetch(
    `${OFFICIAL_REGISTRY}-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(pkgName)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } },
  );
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.token) return body.token;
  console.warn(
    `::warning::OIDC token exchange failed for ${pkgName}: ${res.status} ${body.message || ''}. ` +
      `Ensure a Trusted Publisher is configured for ${pkgName} on npmjs.com (repo + release.yml).`,
  );
  return undefined;
}

function npmrcPath() {
  return process.env.NPM_CONFIG_USERCONFIG || join(homedir(), '.npmrc');
}

// Write exactly one `_authToken` line (dropping any prior one) so the next
// `npm publish` authenticates with this package's freshly exchanged OIDC token.
function setAuthToken(token) {
  const npmrc = npmrcPath();
  const lines = existsSync(npmrc)
    ? readFileSync(npmrc, 'utf8').split('\n').filter((l) => !/_authToken/.test(l))
    : [];
  lines.push(`//registry.npmjs.org/:_authToken=${token}`);
  writeFileSync(npmrc, lines.filter((l) => l !== '').join('\n') + '\n');
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
  const oidcToken = await npmOidcToken(p.pkg);
  if (oidcToken) {
    setAuthToken(oidcToken);
    console.log(`  authenticated ${p.pkg} via OIDC trusted publishing`);
  }
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
