#!/usr/bin/env node
/**
 * Build the per-platform npm packages from downloaded release assets.
 *
 *   node scripts/build-platform-packages.mjs <version> <binDir>
 *
 * For each platform it creates:
 *   npm-platforms/<pkg>/package.json   (os/cpu-gated, version-stamped)
 *   npm-platforms/<pkg>/<bin>          (the binary, +x)
 *
 * <binDir> must contain one file per platform named exactly PLATFORMS[].asset
 * (these are the assets the Nano BPM CI uploads to this repo's `binaries`
 * release). Missing assets are a hard error so we never publish an empty
 * platform package.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, ROOT_PKG } from '../platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const version = process.argv[2];
const binDir = process.argv[3];

if (!version || !binDir) {
  console.error('usage: build-platform-packages.mjs <version> <binDir>');
  process.exit(1);
}

const outRoot = join(repoRoot, 'npm-platforms');
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const pkgJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

for (const p of PLATFORMS) {
  const src = resolve(binDir, p.asset);
  if (!existsSync(src)) {
    console.error(`missing binary asset for ${p.pkg}: expected ${src}`);
    process.exit(1);
  }

  const dir = join(outRoot, p.pkg);
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: p.pkg,
    version,
    description: `Prebuilt nanobpmn server binary for ${p.os}/${p.cpu} (used by ${ROOT_PKG}).`,
    repository: pkgJson.repository,
    license: pkgJson.license,
    os: [p.os],
    cpu: [p.cpu],
    files: [p.bin],
    // No "main"; consumers resolve the binary path via package.json location.
    preferUnplugged: true,
  };

  copyFileSync(src, join(dir, p.bin));
  if (p.os !== 'win32') chmodSync(join(dir, p.bin), 0o755);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`built ${p.pkg}@${version} (${p.os}/${p.cpu})`);
}

console.log(`\nplatform packages staged under ${outRoot}`);
