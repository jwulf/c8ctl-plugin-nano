// Tests for the console links printed by the CLI (nano-bpm #464, revising #413).
//
// The earlier design had `start`/`hire`/`work` spray guided-journey deep links
// (`…/console?tour=<id>`) across their output. That is gone: onboarding is now
// chosen in the console's own startup persona panel. So:
//   - `c8ctl nano start` prints a PLAIN `…/console` URL (no `?tour=`),
//   - `c8ctl nano hire` (and `work`) print NO console link at all.
// The port is non-default throughout, so a hardcoded 8080 would fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { webConsoleUrl, consoleLinkLabel, hireWorker, assignCapabilities, metadata } from './c8ctl-plugin.js';

// A non-default port throughout: if any code path fell back to a hardcoded 8080
// these assertions would fail.
const PORT = 9137;
const BASE = `http://127.0.0.1:${PORT}`;

test('webConsoleUrl is a plain console URL with no ?tour= deep link', () => {
  assert.equal(webConsoleUrl(BASE), `${BASE}/console`);
  // The old signature carried a journey id; assert it no longer leaks one even
  // if a stray argument is passed.
  assert.equal(webConsoleUrl(BASE, 'localdev'), `${BASE}/console`);
});

test('webConsoleUrl uses the real port, never a hardcoded 8080', () => {
  assert.equal(webConsoleUrl('http://127.0.0.1:7001'), 'http://127.0.0.1:7001/console');
});

test('consoleLinkLabel names the studio profile as the web IDE', () => {
  // The default `studio` profile is the full web IDE — users kept missing that
  // when the link was labelled a generic "Web console".
  assert.equal(consoleLinkLabel('studio'), 'Web IDE (Studio)');
  // Non-studio profiles keep the console wording, qualified by profile.
  assert.equal(consoleLinkLabel('observe'), 'Web console (observe)');
  // `off` serves no console, so the helper returns null (callers must guard).
  assert.equal(consoleLinkLabel('off'), null);
});

test('`hire` prints no console link', async () => {
  // Drive the real hire code path non-interactively against an isolated state
  // home holding a cluster on a non-default port, and assert nothing prints a
  // console URL.
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-nano-journey-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    mkdirSync(home, { recursive: true });
    // A running cluster on a non-default port (this process is the alive node).
    writeFileSync(
      join(home, 'cluster.json'),
      JSON.stringify({ nodes: [{ id: 0, url: BASE, pid: process.pid }] }),
    );
    await hireWorker(
      { subcommand: 'hire', positional: [] },
      { name: 'reviewer', rank: 'senior', command: 'copilot' },
    );
  } finally {
    console.log = origLog;
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
  const out = lines.join('\n');
  assert.doesNotMatch(out, /Open the console:/);
  assert.ok(
    !out.includes('/console'),
    `hire output should print no console link; got:\n${out}`,
  );
  // It still tells the user how to put the hire to work — that line stays.
  assert.match(out, /c8ctl nano work reviewer/);
});

test('`assign` does not tell the user to restart workers — they hot-reload', async () => {
  // `work` runs a live watchFile reconciler (issue #30): running workers pick up
  // an assign within ~1.5s with no restart. The success message must not tell the
  // user to re-run `work`, and should say the change is picked up automatically.
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-nano-assign-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    mkdirSync(home, { recursive: true });
    await hireWorker(
      { subcommand: 'hire', positional: [] },
      { name: 'reviewer', rank: 'senior', command: 'copilot', capabilities: 'code-review' },
    );
    lines.length = 0; // isolate assign's output
    // Comma-separated caps, mirroring `hire --capabilities a,b`.
    await assignCapabilities({ subcommand: 'assign', positional: ['reviewer', 'testing,docs'] }, {});
  } finally {
    console.log = origLog;
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
  const out = lines.join('\n');
  // The comma-separated list is honoured (both caps added).
  assert.match(out, /\+docs, testing/);
  // No stale "restart its workers / re-run work" instruction.
  assert.doesNotMatch(out, /Restart its workers/i);
  assert.doesNotMatch(out, /c8ctl nano work reviewer/);
  // It tells the user the running workers pick it up automatically.
  assert.match(out, /automatically/i);
});

test('help lists an `assign` example with comma-separated capabilities', () => {
  const examples = metadata.commands.nano.examples;
  const assignEx = examples.filter((e) => /c8ctl nano assign\b/.test(e.command));
  assert.ok(assignEx.length > 0, 'metadata.commands.nano.examples must include an `assign` example');
  // At least one example shows the comma-separated form, matching `hire`.
  assert.ok(
    assignEx.some((e) => /assign \S+ [\w-]+,[\w-]+/.test(e.command)),
    `assign example should show comma-separated caps; got: ${assignEx.map((e) => e.command).join(' | ')}`,
  );
});
