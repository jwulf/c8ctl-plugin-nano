#!/usr/bin/env node
// Vendor the Effect source tree under `repos/effect` as **read-only reference**
// for coding agents (per Effect's "one weird git trick" guidance) — agents write
// far better idiomatic Effect from source than from docs. This is reference only:
// application code imports the normal pinned `effect` dependency, never
// `repos/effect` (see AGENTS.md → "Writing Effect (v4)").
//
// The checkout is pinned to the SAME version as the installed `effect` dependency
// and squashed so it never bloats history. `repos/` is git-ignored; run this once
// per clone (or after bumping `effect`) to populate it.
//
//   npm run vendor:effect            # pin to package.json's effect version
//   node scripts/vendor-effect.mjs   # same
//
// Effect publishes git tags as `effect@<version>` (monorepo tag scheme).
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "repos/effect";
const remote = "https://github.com/Effect-TS/effect.git";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = String(pkg.devDependencies?.effect ?? pkg.dependencies?.effect ?? "").replace(/^[^\d]*/, "");
if (!version) {
  console.error("vendor-effect: could not read `effect` version from package.json (dev)dependencies");
  process.exit(1);
}
// `version` flows into shell commands via execSync below, so reject anything that
// isn't a plain semver token (digits, dots, and `-`/`+` pre-release/build parts).
// This fails fast on shell metacharacters, closing the command-injection vector.
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
  console.error(`vendor-effect: refusing to use unexpected effect version string ${JSON.stringify(version)} (must be a plain semver)`);
  process.exit(1);
}
const ref = `effect@${version}`;

const run = (cmd) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
};

const alreadyVendored = existsSync(join(repoRoot, prefix));
if (alreadyVendored) {
  console.log(`vendor-effect: ${prefix} exists — updating to ${ref} via subtree pull`);
  run(`git subtree pull --squash --prefix ${prefix} ${remote} ${ref}`);
} else {
  console.log(`vendor-effect: adding ${prefix} at ${ref} via subtree add`);
  run(`git subtree add --squash --prefix ${prefix} ${remote} ${ref}`);
}
console.log(`vendor-effect: done — ${prefix} pinned to ${ref} (read-only reference; do not import from it).`);
