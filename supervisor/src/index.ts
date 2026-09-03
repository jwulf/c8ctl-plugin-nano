/**
 * Public entry for the single-owner supervisor runtime.
 *
 * This is the module esbuild bundles (Effect tree-shaken in) to the shipped
 * `supervisor.dist.js`, which the raw-JS `c8ctl-plugin.js` monolith loads via
 * `await import('./supervisor.dist.js')`. The build step and the `effect`
 * dependency are confined to this TypeScript module; the agent-edited monolith
 * stays raw JS and importable as-is.
 */
export * from "./ports.ts";
export * from "./registry.ts";
export * from "./reconcile.ts";
export * from "./activation.ts";
export * from "./dispatch.ts";
export * from "./parking.ts";
export * from "./agentic.ts";
export * from "./ownership.ts";
export * from "./presence.ts";
export * from "./supervisor.ts";
