// Tests for the guided-journey console deep links (ADR 0049 §2, issue #413):
// `c8ctl nano start` prints `…/console?tour=localdev` and `c8ctl nano hire`
// (and `work`) print `…/console?tour=agentic-author`. The journey ids are a
// contract with the console — an unknown `?tour=` is silently ignored — so they
// are asserted verbatim, and on a NON-default port so a hardcoded 8080 fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  webConsoleUrl,
  runningConsoleBaseUrl,
  hireWorker,
  JOURNEY_LOCALDEV,
  JOURNEY_AGENTIC_AUTHOR,
} from './c8ctl-plugin.js';

// A non-default port throughout: if any code path fell back to a hardcoded 8080
// these assertions would fail.
const PORT = 9137;
const BASE = `http://127.0.0.1:${PORT}`;

test('journey ids are the exact console-contract values', () => {
  assert.equal(JOURNEY_LOCALDEV, 'localdev');
  assert.equal(JOURNEY_AGENTIC_AUTHOR, 'agentic-author');
});

test('webConsoleUrl carries the journey on a non-default port', () => {
  // The exact URL `start` prints (localdev) and `hire`/`work` print (agentic-author).
  assert.equal(webConsoleUrl(BASE, JOURNEY_LOCALDEV), `${BASE}/console?tour=localdev`);
  assert.equal(webConsoleUrl(BASE, JOURNEY_AGENTIC_AUTHOR), `${BASE}/console?tour=agentic-author`);
  // No journey → a plain console URL (unchanged behaviour for callers that pass none).
  assert.equal(webConsoleUrl(BASE), `${BASE}/console`);
});

test('runningConsoleBaseUrl uses the real cluster address, never a hardcoded port', () => {
  // Prefer a still-alive node (this test process is definitely alive).
  const deadPid = 2147483646; // not a live pid
  assert.equal(
    runningConsoleBaseUrl({
      nodes: [
        { url: 'http://127.0.0.1:7001', pid: deadPid },
        { url: BASE, pid: process.pid },
      ],
    }),
    BASE,
  );
  // No node is alive → the first recorded node (the one the user would open).
  assert.equal(
    runningConsoleBaseUrl({ nodes: [{ url: BASE, pid: deadPid }] }),
    BASE,
  );
  // No cluster recorded → the default gateway URL.
  assert.equal(runningConsoleBaseUrl(null), 'http://localhost:8080');
});

test('a 3-node start points its console link at node 0 (localdev)', () => {
  // `start` prints `webConsoleUrl(state.nodes[0].url, localdev)`; a 3-node start
  // must therefore point at the node the user would actually open (node 0), on
  // its real port.
  const node0 = { url: BASE };
  assert.equal(
    webConsoleUrl(node0.url, JOURNEY_LOCALDEV),
    `${BASE}/console?tour=localdev`,
  );
});

test('`hire` prints the exact agentic-author console URL on a non-default port', async () => {
  // Drive the real hire code path non-interactively against an isolated state
  // home holding a cluster on a non-default port, and assert the printed line.
  const home = mkdtempSync(join(tmpdir(), 'c8ctl-nano-journey-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = home;
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
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
  assert.match(out, /Open the console:/);
  assert.ok(
    out.includes(`${BASE}/console?tour=agentic-author`),
    `hire output should print the agentic-author console URL on port ${PORT}; got:\n${out}`,
  );
});
