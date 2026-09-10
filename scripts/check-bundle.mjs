// Freshness gate for the committed `supervisor.dist.js` bundle.
//
// The published/production runtime imports the *committed* `supervisor.dist.js`
// (it is in package.json `files`, and c8ctl-plugin.js does
// `await import('./supervisor.dist.js')`). That bundle is generated from
// `supervisor/src/*.ts` by `supervisor/build.mjs`. `npm test` rebuilds the
// bundle mid-run, so a *stale committed* bundle still passes the test suite —
// the drift between the committed file and its source is never detected.
//
// This gate rebuilds the bundle from source and fails when the committed file
// differs from the clean rebuild, so a PR that edits `supervisor/src/*.ts`
// without regenerating `supervisor.dist.js` reddens CI with an actionable
// message. The rebuild is byte-stable (esbuild `minify` output is
// reproducible), so an in-sync bundle passes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// `CHECK_BUNDLE_ROOT` lets the test suite point the gate at a throwaway repo;
// unset, it resolves to this repository's root as it does in CI.
const repoRoot = process.env.CHECK_BUNDLE_ROOT
  ? process.env.CHECK_BUNDLE_ROOT
  : join(here, "..");
const bundle = "supervisor.dist.js";

const fail = (msg) => {
  console.error(`\n\u274c ${msg}\n`);
  process.exit(1);
};

// 0. The committed bundle must be tracked by git. `git diff` only reports
// changes to *tracked* paths, so if the bundle is deleted/absent the rebuild
// below recreates it as an untracked file and the diff stays empty — the gate
// would pass with no production artifact committed. Assert it is tracked first.
try {
  execFileSync("git", ["ls-files", "--error-unmatch", "--", bundle], {
    cwd: repoRoot,
    stdio: "pipe",
  });
} catch {
  fail(
    `${bundle} is not tracked by git — the committed production bundle is ` +
      `missing.\n\n` +
      `   Run \`npm run build:supervisor\` and commit ${bundle}.`,
  );
}

// 1. Clean rebuild from source.
try {
  execFileSync(process.execPath, [join(repoRoot, "supervisor", "build.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch {
  fail("Failed to rebuild supervisor.dist.js — see the build output above.");
}

// 2. Compare the rebuild against the committed bundle.
let diff = "";
try {
  diff = execFileSync("git", ["diff", "--", bundle], {
    cwd: repoRoot,
    encoding: "utf8",
  });
} catch (err) {
  fail(`Failed to run \`git diff\` on ${bundle}: ${err.message}`);
}

if (diff.trim() !== "") {
  console.error(diff);
  fail(
    `The committed ${bundle} is stale — it does not match a clean rebuild ` +
      `from supervisor/src/*.ts.\n\n` +
      `   Run \`npm run build:supervisor\` and commit the regenerated ` +
      `${bundle}.`,
  );
}

console.log(`\u2705 ${bundle} is in sync with supervisor/src/*.ts.`);
