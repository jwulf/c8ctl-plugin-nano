#!/usr/bin/env node
/**
 * Stamp the root package.json optionalDependencies so each platform package is
 * pinned to the exact release version.
 *
 *   node scripts/stamp-optional-deps.mjs <version>
 *
 * Runs in the semantic-release `prepare` step, before @semantic-release/npm
 * writes the bumped version and before @semantic-release/git commits
 * package.json. Keeps the meta-package and its platform packages in lockstep.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkgPath = join(repoRoot, 'package.json');

const version = process.argv[2];
if (!version) {
  console.error('usage: stamp-optional-deps.mjs <version>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.optionalDependencies = pkg.optionalDependencies || {};
for (const p of PLATFORMS) {
  pkg.optionalDependencies[p.pkg] = version;
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`pinned ${PLATFORMS.length} optionalDependencies to ${version}`);
