/**
 * Architectural enforcement (PR #180 follow-up): every engine job-mutation in
 * `supervisor-engine.mjs` that has a typed Camunda SDK equivalent MUST prefer the
 * injected `camunda` SDK client, hand-rolling the raw C8 REST `call(...)` only as
 * a standalone / wire-test fallback.
 *
 * WHY a source-scanning test (not ESLint): this repo is build-free raw JS with no
 * linter — the sanctioned gate is `node --check` + `node --test`. This test IS the
 * lint rule. The failure mode it bans is real and recurring: `extendLock` shipped
 * a hand-rolled `PATCH /jobs/{key}/timeout` that 404'd on the nano engine (issue
 * #179), wedging every worker. The cure — prefer the SDK's typed method, which
 * tracks the engine contract — must not silently regress on the settle calls.
 *
 * The rule, mechanically:
 *   - Discover every client method (`async NAME(` inside the returned object).
 *   - Each method is either SDK-BACKED (must contain a
 *     `typeof camunda.<sdkMethod> === "function"` preference guard that precedes
 *     its raw `call(`), or explicitly RAW-ALLOWLISTED with a documented reason.
 *   - A NEW method that hits a raw route but is neither is a hard failure — the
 *     author must classify it (add an SDK preference, or allowlist it here with a
 *     reason). That forced decision is the whole point.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "supervisor-engine.mjs"), "utf8");

/** Engine job-mutation methods that HAVE a typed SDK method → the SDK method they must prefer. */
const SDK_BACKED = {
  extendLock: "updateJob",
  complete: "completeJob",
  fail: "failJob",
};

/**
 * Methods sanctioned to issue a raw REST call with NO SDK preference, each with a
 * reason. `activate` is the one true raw-only call: the SDK job worker models one
 * poller per type with `maxJobsToActivate = maxParallel − active` and structurally
 * cannot express the supervisor's "global capacity S shared across K types" long-
 * poll, so the supervisor rolls its own activation over the raw route.
 */
const RAW_ALLOWLISTED = {
  activate:
    "SDK job worker can't express the supervisor's global-capacity single long-poll; rolls its own raw activation.",
};

/** Return the brace-matched body `{ ... }` of the object method `async NAME(`, or null. */
function methodBody(src, name) {
  const sig = new RegExp(`async\\s+${name}\\s*\\(`);
  const m = sig.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** All client-object method names: `async NAME(` but NOT `async function ...` / arrow. */
function discoverMethods(src) {
  const names = new Set();
  for (const m of src.matchAll(/\basync\s+(\w+)\s*\(/g)) {
    if (m[1] !== "function") names.add(m[1]);
  }
  return [...names];
}

test("every engine method is classified as SDK-backed or explicitly raw-allowlisted", () => {
  const methods = discoverMethods(SRC);
  // Sanity: the four known methods are present (guards against a broken scan).
  for (const known of ["activate", "extendLock", "complete", "fail"]) {
    assert.ok(methods.includes(known), `expected to discover engine method \`${known}\``);
  }
  for (const name of methods) {
    const classified = name in SDK_BACKED || name in RAW_ALLOWLISTED;
    assert.ok(
      classified,
      `engine method \`${name}\` is unclassified: it must PREFER a typed SDK method ` +
        `(add it to SDK_BACKED with its \`camunda.<method>\` guard) or be added to ` +
        `RAW_ALLOWLISTED here with a documented reason. Hand-rolled REST against the ` +
        `nano engine is banned where a typed SDK method exists (PR #180 / issue #179).`,
    );
  }
});

test("each SDK-backed method prefers `camunda.<sdkMethod>` via a typeof guard BEFORE any raw call", () => {
  for (const [name, sdkMethod] of Object.entries(SDK_BACKED)) {
    const body = methodBody(SRC, name);
    assert.ok(body, `could not locate the body of engine method \`${name}\``);

    const guard = `typeof camunda.${sdkMethod} === "function"`;
    const guardAt = body.indexOf(guard);
    assert.ok(
      guardAt !== -1,
      `\`${name}\` must guard the SDK path with \`${guard}\` (prefer the SDK client over raw REST)`,
    );

    const sdkCallAt = body.indexOf(`camunda.${sdkMethod}(`);
    assert.ok(sdkCallAt !== -1, `\`${name}\` must actually invoke \`camunda.${sdkMethod}(...)\` on the guarded path`);

    // The raw fetch fallback (if any) MUST come AFTER the SDK preference — never before.
    const rawCallAt = body.indexOf("await call(");
    if (rawCallAt !== -1) {
      assert.ok(
        guardAt < rawCallAt,
        `\`${name}\` issues a raw \`call(...)\` before its \`${sdkMethod}\` preference — the SDK path must win first`,
      );
    }
  }
});

test("a raw-allowlisted method does NOT smuggle in an ad-hoc SDK preference without being SDK-backed", () => {
  // Guards the inverse drift: if `activate` grows a `camunda.` job call it should be
  // reclassified as SDK-backed (with the ordering assertion above), not left in the
  // raw allowlist. Keeps the two lists mutually exclusive and honest.
  for (const name of Object.keys(RAW_ALLOWLISTED)) {
    const body = methodBody(SRC, name);
    assert.ok(body, `could not locate the body of raw-allowlisted method \`${name}\``);
    assert.ok(
      !/typeof\s+camunda\.\w+\s*===\s*"function"/.test(body),
      `\`${name}\` is raw-allowlisted but contains an SDK preference guard — move it to SDK_BACKED instead`,
    );
  }
});
