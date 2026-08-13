// Guard: the agentic worker channel client has ONE import surface.
//
// Lesson promoted from the agent-visibility epic (jwulf/c8ctl-plugin-nano#38).
// `@nanobpm/urban-agent-client` ships a `dist` that imports raw TypeScript from
// `@nanobpm/agentic/source/*`; stock Node refuses type-stripping under
// `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so importing the
// client anywhere without the source->dist resolve hook throws at runtime. That
// hook is registered exactly once, lazily, from `loadAgenticClient()` in
// `agentic.mjs`. Across the epic, slice after slice had to be told the same
// thing: import the client ONLY through `loadAgenticClient()`, never reach for
// `@nanobpm/urban-agent-client` directly and never re-register the hook. This
// test makes that convention load-bearing so a future contributor cannot
// re-introduce a second, hookless import that is green in isolation but throws
// at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The single module allowed to import the client / register the resolve hook.
const CLIENT_SWAP_POINT = 'agentic.mjs';
const HOOK_MODULE = 'agentic-loader-hook.mjs';

const CLIENT_SPECIFIER = '@nanobpm/urban-agent-client';
const SOURCE_SUBPATH = '@nanobpm/agentic/source';

// Strip block comments (`/* ... */`, incl. JSDoc `@typedef`/`@property` type
// imports) and whole-line `//` comments, so only executable code remains. Type
// annotations like `import('@nanobpm/urban-agent-client').AgenticClient` live in
// comments and are erased at runtime — they are not a real import.
function stripComments(src) {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function sourceFiles() {
  return readdirSync(here)
    .filter((name) => name.endsWith('.mjs') || name.endsWith('.js'))
    .filter((name) => !name.endsWith('.test.mjs') && !name.endsWith('.test.js'));
}

test('only agentic.mjs imports the worker channel client', () => {
  for (const name of sourceFiles()) {
    if (name === CLIENT_SWAP_POINT) continue;
    const code = stripComments(readFileSync(join(here, name), 'utf8'));
    assert.ok(
      !code.includes(CLIENT_SPECIFIER),
      `${name} imports '${CLIENT_SPECIFIER}' directly. Import the client only ` +
        `through loadAgenticClient() in ${CLIENT_SWAP_POINT} — a hookless import ` +
        `throws at runtime under stock Node (see ${CLIENT_SWAP_POINT}).`,
    );
  }
});

test('only agentic.mjs / the hook module reach @nanobpm/agentic/source', () => {
  for (const name of sourceFiles()) {
    if (name === CLIENT_SWAP_POINT || name === HOOK_MODULE) continue;
    const code = stripComments(readFileSync(join(here, name), 'utf8'));
    assert.ok(
      !code.includes(SOURCE_SUBPATH),
      `${name} references '${SOURCE_SUBPATH}/*' (raw TypeScript). The ` +
        `source->dist redirect lives only in ${HOOK_MODULE}, wired once from ` +
        `${CLIENT_SWAP_POINT}; do not re-register the hook elsewhere.`,
    );
  }
});

test('the swap point still owns the client import and hook registration', () => {
  const swap = readFileSync(join(here, CLIENT_SWAP_POINT), 'utf8');
  assert.ok(
    swap.includes(CLIENT_SPECIFIER),
    `${CLIENT_SWAP_POINT} no longer imports '${CLIENT_SPECIFIER}'. If the swap ` +
      `point moved, update this guard to match.`,
  );
  assert.ok(
    swap.includes('loadAgenticClient'),
    `${CLIENT_SWAP_POINT} no longer exposes loadAgenticClient() — the single ` +
      `accessor this guard protects.`,
  );
});
