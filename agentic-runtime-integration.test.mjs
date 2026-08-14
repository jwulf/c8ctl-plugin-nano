// C7 (#72) — the agent-visibility plane wired into the LIVE `nano work` runtime.
//
// The sibling slices each carry unit coverage of their surface, and C6
// (`agentic-visibility.test.mjs`) composes the plane end-to-end using the raw
// `spawnCapturePty` seam. What none of them do is the thing this issue's final
// acceptance calls for:
//
//   > An integration test drives `activateJobs → harness PTY → relay →
//   > supply/cockpit` end-to-end (not just unit tests of the modules in
//   > isolation).
//
// This file closes that gap. It drives the REAL job-activation execution unit —
// `runAgentJob`, the exact function `workAgent`'s `createJobWorker` job handler
// runs on every `activateJobs` result — over the REAL connected channel client
// (`createWorkChannel`, on a transport double), composed exactly the way the
// live `work` runtime composes it:
//
//   - the worker announces presence (C2) with the LIVE jobKey set read from an
//     `activeJobs` map, the same seam `recordJobStart`/`recordJobEnd` drive;
//   - a job activates: `runAgentJob({ terminal:'pty', relaySession, … })` runs
//     the harness on a PTY and its terminal streams on the relay lane tagged
//     with the job's jobKey (C3), with cockpit steer-in reaching the PTY;
//   - the buffered outbound ring survives a hub outage and drains in order (C4);
//   - the worker deregisters cleanly on stop.
//
// Every frame is decoded with the SAME shared codec the hub is held to, through
// this plugin's single `./agentic.mjs` import surface — nothing here re-declares
// a frame, lane, or payload. The `supply/cockpit` view is reconstructed from the
// decoded presence frames exactly as `GET /agentic/supply` reports it
// (`{ count, workers:[{ instance, host, jobs }] }`), so the assertions are about
// the operator-visible surface, not an internal.
//
// Unlike `work-relay.test.mjs` (which drives `runAgentJob` over a FAKE channel)
// and `agentic-visibility.test.mjs` (which drives the REAL channel over raw
// `spawnCapturePty`), this test is the only one that runs the real
// harness-activation function OVER the real connected presence/relay channel —
// the actual `work` integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeFrame, encodeFrame } from './agentic.mjs';
import { createWorkChannel } from './work-channel.mjs';
import { createRelaySession, relayStreamName } from './work-relay.mjs';
import { createBufferMonitor } from './work-buffer.mjs';
import { runAgentJob } from './c8ctl-plugin.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const BASE = { url: 'http://localhost:8080', token: 'ident-secret', credential: 'cap-cred' };
const PROFILE = { name: 'reviewer', rank: 'senior', command: 'agentcmd', args: [], model: 'opus', capabilities: ['feature'] };

// An auto-opening in-memory transport double (mirrors the other visibility
// tests): records every encoded frame, opens on a macrotask so buffered frames
// drain like a real socket, and can deliver an inbound frame the way a hub
// would. Everything is decoded through the shared `./agentic.mjs` codec.
function makeTransportDouble() {
  const sent = [];
  const conns = [];
  const factory = (url, hooks) => {
    const conn = { url, hooks, closed: false };
    conns.push(conn);
    setTimeout(() => {
      if (!conn.closed) hooks.onOpen();
    }, 0);
    return {
      send(bytes) {
        sent.push(bytes);
      },
      close() {
        if (!conn.closed) {
          conn.closed = true;
          conn.hooks.onClose({ local: true });
        }
      },
    };
  };
  return {
    factory,
    frames() {
      return sent.map((b) => decodeFrame(b));
    },
    framesOf(family) {
      return this.frames().filter((f) => f.family === family);
    },
    deliverInbound(frame) {
      const conn = conns[conns.length - 1];
      if (!conn || conn.closed) throw new Error('no open connection to deliver an inbound frame');
      conn.hooks.onFrame(encodeFrame(frame));
    },
  };
}

// A GATED transport double: a connection stays CLOSED until the test opens it,
// so a hub-down outage window is precise (mirrors work-buffer.test.mjs).
function makeGatedTransport() {
  const sent = [];
  const conns = [];
  const factory = (url, hooks) => {
    const conn = { url, hooks, open: false, closed: false };
    conns.push(conn);
    return {
      send(bytes) {
        if (!conn.open || conn.closed) throw new Error('transport not open');
        sent.push(bytes);
      },
      close() {
        if (!conn.closed) {
          conn.closed = true;
          if (conn.open) conn.hooks.onClose({ local: true });
        }
      },
    };
  };
  return {
    factory,
    frames() {
      return sent.map((b) => decodeFrame(b));
    },
    framesOf(family) {
      return this.frames().filter((f) => f.family === family);
    },
    openCurrent() {
      const c = conns[conns.length - 1];
      if (c && !c.open && !c.closed) {
        c.open = true;
        c.hooks.onOpen();
      }
    },
  };
}

// A fake node-pty factory (mirrors work-relay.test.mjs): spawn() returns a
// terminal handle the test drives (feed output, deliver exit) and whose write()
// calls (stdin payload + steer-in) are recorded — so the real `runAgentJob` PTY
// path runs deterministically on stock Node with no native build.
function fakePtyFactory() {
  let term = null;
  return {
    spawn(command, args, opts) {
      const writes = [];
      let dataCb = null;
      let exitCb = null;
      let killed = false;
      term = {
        command,
        args,
        opts,
        pid: 4242,
        writes,
        get killed() { return killed; },
        onData: (cb) => { dataCb = cb; },
        onExit: (cb) => { exitCb = cb; },
        write: (d) => { writes.push(d); },
        resize: () => {},
        kill: () => { killed = true; },
        feed: (s) => { if (dataCb) dataCb(s); },
        exit: (exitCode, signal = 0) => { if (exitCb) exitCb({ exitCode, signal }); },
      };
      return term;
    },
    term: () => term,
  };
}

// Reconstruct the operator-visible `GET /app/api/agentic/supply` view
// (`{ count, workers:[{ instance, host, jobs }] }`) from the decoded presence
// frames the worker sent — register announces/updates a worker, deregister
// removes it. This is exactly the projection the hub's supply endpoint reports,
// so asserting on it asserts on the cockpit surface, not an internal.
function supplyView(frames) {
  const workers = new Map();
  for (const f of frames) {
    if (f.family === 'register') {
      const cap = f.payload?.capability || {};
      workers.set(f.payload.instance, {
        instance: f.payload.instance,
        host: cap.host,
        jobs: Array.isArray(cap.jobs) ? cap.jobs : [],
      });
    } else if (f.family === 'deregister') {
      workers.delete(f.payload.instance);
    }
  }
  return { count: workers.size, workers: [...workers.values()] };
}

// ===========================================================================
// The live `work` runtime: activateJobs → harness PTY → relay → supply/cockpit.
// ===========================================================================

test('the live work runtime: a job activation drives runAgentJob → PTY → relay → supply, with steer-in and clean deregister', async () => {
  const t = makeTransportDouble();

  // The worker's live job set — the SAME `activeJobs` map + refreshPresence seam
  // that `recordJobStart`/`recordJobEnd` drive in `workAgent`.
  const activeJobs = new Map();

  // C2: the single connected + authenticated channel client, announcing presence
  // with identity, host, and the (initially empty) live jobKey set — exactly the
  // createWorkChannel call `workAgent` makes.
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'reviewer-1',
    host: 'ci-box',
    capability: { cognition: 'senior', family: 'opus', host: 'ci-box' },
    listJobKeys: () => [...activeJobs.keys()],
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();

  // Worker is live in the cockpit BEFORE any job is active (the process is
  // long-lived: presence is independent of whether a job is running).
  let supply = supplyView(t.frames());
  assert.equal(supply.count, 1, 'the running worker appears in supply before any job');
  assert.equal(supply.workers[0].instance, 'reviewer-1');
  assert.equal(supply.workers[0].host, 'ci-box');
  assert.deepEqual(supply.workers[0].jobs, [], 'no live jobs yet');

  // activateJobs delivers a job. The runtime records it (updates the live set)
  // and re-announces presence — recordJobStart's exact behaviour.
  const job = { jobKey: '4856', type: 'senior:feature', variables: {} };
  activeJobs.set(String(job.jobKey), { type: job.type, since: Date.now() });
  ch.refreshPresence();
  await tick();

  supply = supplyView(t.frames());
  assert.deepEqual(
    supply.workers[0].jobs,
    ['4856'],
    'the cockpit now shows the worker servicing this jobKey',
  );

  // C3: the per-job relay session, then the REAL harness-activation unit —
  // `runAgentJob` with a PTY role — streaming this job's terminal on the relay
  // lane tagged with its jobKey. This is the exact composition `workAgent`'s job
  // handler builds (createRelaySession → runAgentJob({ terminal, relaySession })).
  const session = createRelaySession({ channel: ch, jobKey: job.jobKey });
  assert.equal(session.stream, relayStreamName(job.jobKey));
  const pf = fakePtyFactory();
  const runP = runAgentJob(PROFILE, job, {
    terminal: 'pty',
    relaySession: session,
    ptyFactory: pf,
    envelope: null,
  });

  const term = pf.term();
  assert.ok(term, 'runAgentJob allocated a PTY for the pty-role harness');
  assert.equal(term.command, 'sh');
  assert.deepEqual(term.args, ['-c', 'agentcmd']);
  // The job payload was written to the PTY on stdin (jobKey-tagged), then EOT.
  assert.match(String(term.writes[0]), /"jobKey":"4856"/);

  // The harness produces terminal output → it rides the bulk relay lane, framed
  // and tagged with the jobKey stream, decoded with the shared codec.
  term.feed('booting agent…\r\n');
  await tick();
  const relayFrame = t.framesOf('relay').at(-1);
  assert.equal(relayFrame.lane, 'bulk', 'terminal output rides the bulk relay lane');
  assert.equal(relayFrame.payload.stream, `job:${job.jobKey}`, 'relay frame tagged with the jobKey stream');
  assert.match(relayFrame.payload.chunk, /booting agent/);

  // Steer-in: a cockpit relay frame on this job's stream, delivered the way the
  // hub would (encoded with the shared codec, handed to the client's inbound
  // onFrame hook), reaches the harness PTY as a write.
  t.deliverInbound({
    lane: 'bulk',
    family: 'relay',
    seq: 1,
    payload: { stream: `job:${job.jobKey}`, offset: 0, chunk: '\x03' },
  });
  assert.equal(term.writes.at(-1), '\x03', 'cockpit steer-in reached the harness PTY');

  // The harness exits: the job completes through the real runAgentJob contract.
  term.exit(0);
  const result = await runP;
  assert.equal(result.ok, true);
  assert.match(result.stdout, /booting agent/);

  // Job complete: stop the stream and drop it from the live set + re-announce —
  // recordJobEnd's exact behaviour. The worker stays live (idle), the job is gone.
  session.close();
  activeJobs.delete(String(job.jobKey));
  ch.refreshPresence();
  await tick();
  supply = supplyView(t.frames());
  assert.equal(supply.count, 1, 'the worker is still live after the job (long-lived process)');
  assert.deepEqual(supply.workers[0].jobs, [], 'the finished job cleared from the cockpit');

  // Worker exits: clean deregister — it disappears from supply/cockpit.
  await ch.stop('worker stopped');
  await tick();
  const dereg = t.framesOf('deregister').at(-1);
  assert.equal(dereg.payload.instance, 'reviewer-1');
  assert.equal(dereg.payload.reason, 'worker stopped');
  assert.equal(supplyView(t.frames()).count, 0, 'the worker is gone from the cockpit after deregister');
  assert.equal(ch.connected(), false);
});

// ===========================================================================
// Reconnect buffer (C4) through the live harness path: a hub outage while a job
// is producing must not lose the job's terminal — it drains in order on connect.
// ===========================================================================

test('a hub outage during a live job buffers the harness terminal and drains it in order on reconnect (C4), via runAgentJob', async () => {
  const t = makeGatedTransport();
  const job = { jobKey: '900', type: 'senior:feature', variables: {} };
  const activeJobs = new Map([[String(job.jobKey), { type: job.type, since: Date.now() }]]);

  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-early',
    host: 'h-early',
    listJobKeys: () => [...activeJobs.keys()],
    heartbeatIntervalMs: 0,
    transport: t.factory,
    bufferCapacity: 64,
  });
  const monitor = createBufferMonitor(ch, { capacity: 64, sampleIntervalMs: 0 });
  const session = createRelaySession({ channel: ch, jobKey: job.jobKey });

  // Hub is down (connection not yet opened). Run the harness anyway: its terminal
  // output buffers at the transport seam below the lanes, alongside presence.
  const pf = fakePtyFactory();
  const runP = runAgentJob(PROFILE, job, {
    terminal: 'pty',
    relaySession: session,
    ptyFactory: pf,
    envelope: null,
  });
  const term = pf.term();
  for (let i = 1; i <= 4; i++) term.feed(`line-${i}\n`);
  monitor.sample();

  assert.equal(ch.connected(), false);
  assert.equal(ch.buffered() >= 5, true, 'presence + 4 harness relay frames buffered while the hub is down');
  assert.equal(monitor.health().highWaterMark >= 5, true);

  // Hub comes up: the built-in ring drains in strict order — control (presence)
  // before bulk (relay), FIFO within a lane, with no loss or reorder.
  t.openCurrent();
  await tick();
  assert.equal(ch.connected(), true);
  assert.equal(ch.buffered(), 0, 'backlog fully drained on connect');
  assert.equal(t.framesOf('register').length >= 1, true, 'presence survived the outage');
  const relayChunks = t.framesOf('relay').map((f) => f.payload.chunk);
  assert.deepEqual(
    relayChunks,
    ['line-1\n', 'line-2\n', 'line-3\n', 'line-4\n'],
    'the job terminal drained in production order — no loss, no reorder across the outage',
  );
  assert.equal(monitor.health().flushes >= 1, true, 'the outage flush is recorded');

  term.exit(0);
  const result = await runP;
  assert.equal(result.ok, true);

  session.close();
  monitor.stop();
  await ch.stop();
});
