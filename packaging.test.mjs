// Guard against the packaging footgun that shipped a broken plugin (v1.54.0): a sidecar the
// monolith imports (`supervisor-log-ring.mjs`, #185) was omitted from `package.json` `files`, so
// npm never published it and the plugin died at load with ERR_MODULE_NOT_FOUND — c8ctl then silently
// drops the plugin and `c8ctl nano` reports "Unknown command: nano". Every local module reachable
// from a published entry MUST itself be published. This walks the local relative-import graph from
// the entry points and asserts each hop is in `files` and exists on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const published = new Set(pkg.files);

// Every `from './x'`, bare `import './x'`, and dynamic `import('./x')` of a LOCAL relative module.
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

function localImports(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

test('every local module reachable from a published entry is itself published', () => {
  // Seed the crawl with the runtime entry plus any published sidecar (so a sidecar-to-sidecar
  // import is covered too). Only `.js`/`.mjs`/`.json` files are code we must publish.
  const seeds = [pkg.main, ...pkg.files].filter((f) => /\.(mjs|js)$/.test(f));
  const seen = new Set();
  const queue = [...new Set(seeds)];
  const missingFromFiles = [];
  const missingOnDisk = [];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(here, rel);
    if (!existsSync(abs)) continue; // a published-but-absent entry is caught by the on-disk pass below
    for (const spec of localImports(readFileSync(abs, 'utf8'))) {
      const target = normalize(join(dirname(rel), spec)).replace(/^\.\//, '');
      if (!/\.(mjs|js|json)$/.test(target)) continue; // skip dir/extensionless (none today)
      if (!published.has(target)) missingFromFiles.push({ importedBy: rel, target });
      if (!existsSync(join(here, target))) missingOnDisk.push({ importedBy: rel, target });
      if (/\.(mjs|js)$/.test(target)) queue.push(target);
    }
  }

  assert.deepEqual(
    missingFromFiles,
    [],
    `Imported local module(s) missing from package.json "files" (npm would drop them, breaking plugin load):\n${missingFromFiles
      .map((x) => `  ${x.target} (imported by ${x.importedBy})`)
      .join('\n')}`,
  );
  assert.deepEqual(
    missingOnDisk,
    [],
    `Imported local module(s) not found on disk:\n${missingOnDisk
      .map((x) => `  ${x.target} (imported by ${x.importedBy})`)
      .join('\n')}`,
  );
});
