// Module-customization RESOLVE hook (Node `module.register`) — the single
// mechanism that makes `@nanobpm/urban-agent-client` loadable under stock Node.
//
// Why this exists (the C0 constraint, jwulf/c8ctl-plugin-nano#39):
// the published worker client funnels the S0 wire contract through
// `dist/protocol.js`, which imports `@nanobpm/agentic/source/protocol` — raw
// TypeScript — on the assumption the consumer runs under a type-stripping
// loader. This repo runs on stock Node (`node --test`, `nano work`), which
// REFUSES to type-strip `.ts` under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a bare `import` of the
// client throws before any of C2's channel code can run.
//
// The redirect below rewrites every `@nanobpm/agentic/source/*` specifier to
// the package's COMPILED `@nanobpm/agentic/*` `dist` export. Source and dist are
// the same S0 contract — both are held to the one shared conformance corpus
// (`agentic-conformance.test.mjs`) — so this is a pure packaging redirect, not a
// behavioural change: the client ends up bound to the exact codec/grammar this
// repo already runs green. When the client is republished to import agentic's
// `dist` directly, this hook becomes a no-op and can be retired.
//
// Registered lazily from `loadAgenticClient()` in `agentic.mjs` (the single
// client swap point) so it is active before the client's module graph loads.

const SOURCE_PREFIX = '@nanobpm/agentic/source/';

/**
 * Node ESM resolve hook. Redirects the client's raw-`.ts` source imports to the
 * compiled dist subpath exports; passes everything else through untouched.
 *
 * @param {string} specifier the requested module specifier
 * @param {import('node:module').ResolveHookContext} context resolution context
 * @param {(s: string, c?: object) => unknown} next the next hook in the chain
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@nanobpm/agentic/source') {
    return next('@nanobpm/agentic', context);
  }
  if (specifier.startsWith(SOURCE_PREFIX)) {
    return next(`@nanobpm/agentic/${specifier.slice(SOURCE_PREFIX.length)}`, context);
  }
  return next(specifier, context);
}
