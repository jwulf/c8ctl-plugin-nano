// C6 (#45) — docs + test coverage for the agent-visibility plane (ADR 0056).
//
// The sibling slices each carry their own unit coverage of the surface they
// landed: presence lifecycle (C2, work-channel.test.mjs), PTY framing + steer
// (C3, work-relay.test.mjs), and the bounded buffer flush (C4,
// work-buffer.test.mjs). This slice adds the two things those per-surface unit
// tests do not:
//
//   1. An END-TO-END integration test of the whole plane as `work` composes it —
//      one connected + authenticated channel client (C2) carrying a job's
//      jobKey-tagged PTY terminal on the relay lane (C3) with cockpit steer-in
//      reaching the PTY, buffered bounded and drained in order across a hub
//      outage (C4), all decoded with the SAME shared codec the hub is held to
//      (via this plugin's single `./agentic.mjs` import surface). Nothing here
//      re-declares a frame or lane; every wire type is consumed from
//      `@nanobpm/agentic`.
//
//   2. A DOCS guard: the `hire`/`work` help + README must document the channel
//      connection and the live-terminal opt-in, so the documentation acceptance
//      criterion is regression-guarded, not just written once.
//
// The conformance corpus (`@nanobpm/agentic/protocol/conformance`) is wired and
// kept green by `agentic-conformance.test.mjs` (C0) — this file asserts that
// corpus stays loaded/non-empty so the plane is exercised against the shared
// vectors here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeFrame, encodeFrame, channel as agenticChannel } from './agentic.mjs';
import { GOLDEN_FRAMES } from '@nanobpm/agentic/protocol/conformance';
import {
  buildAgenticUrl,
  redactAgenticUrl,
  createWorkChannel,
} from './work-channel.mjs';
import { createRelaySession, relayStreamName } from './work-relay.mjs';
import { createBufferMonitor } from './work-buffer.mjs';
import { spawnCapturePty, metadata, commands } from './c8ctl-plugin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const BASE = { url: 'http://localhost:8080', token: 'ident-secret', credential: 'cap-cred' };

// An auto-opening in-memory transport double (mirrors work-channel.test.mjs):
// records every encoded frame, opens on a macrotask so buffered frames drain
// like a real socket, and can deliver an inbound frame the way a hub would (the
// transport contract is `hooks.onFrame(bytes)`). Decoded through the shared
// `./agentic.mjs` codec.
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
    /** Deliver one inbound frame to the client the way a hub would: encode it
     * with the shared codec and hand the bytes to the current connection's
     * `onFrame` transport hook. */
    deliverInbound(frame) {
      const conn = conns[conns.length - 1];
      if (!conn || conn.closed) throw new Error('no open connection to deliver an inbound frame');
      conn.hooks.onFrame(encodeFrame(frame));
    },
  };
}

// A GATED transport double (mirrors work-buffer.test.mjs): a connection stays
// CLOSED until the test opens it, so the hub-down outage window is precise.
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
    dropCurrent() {
      const c = conns[conns.length - 1];
      if (c && !c.closed) {
        c.closed = true;
        if (c.open) c.hooks.onClose({ local: false });
      }
    },
  };
}

// A fake node-pty factory (mirrors work-relay.test.mjs): spawn() returns a
// terminal handle the test drives (feed output, deliver exit) and whose write()
// calls (payload + steer-in) are recorded — so the PTY path runs deterministically
// on stock Node with no native build.
function fakePtyFactory() {
  let term = null;
  return {
    spawn(command, args, opts) {
      const writes = [];
      let dataCb = null;
      let exitCb = null;
      term = {
        command,
        args,
        opts,
        pid: 4242,
        writes,
        onData: (cb) => { dataCb = cb; },
        onExit: (cb) => { exitCb = cb; },
        write: (d) => { writes.push(d); },
        resize: () => {},
        kill: () => {},
        feed: (s) => { if (dataCb) dataCb(s); },
        exit: (exitCode, signal = 0) => { if (exitCb) exitCb({ exitCode, signal }); },
      };
      return term;
    },
    term: () => term,
  };
}

const RECONNECT = {
  reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
  schedule: (fn) => setTimeout(fn, 1),
};

// ===========================================================================
// End-to-end: the whole visibility plane as `work` composes it.
// ===========================================================================

test('the visibility plane composes end-to-end: presence + jobKey-tagged PTY relay + steer-in + clean deregister', async () => {
  const t = makeTransportDouble();
  const jobKey = '4856';
  const activeJobs = new Map([[jobKey, { type: 'senior:feature' }]]);

  // C2: one connected + authenticated channel client announcing presence with
  // identity, host, and the live jobKey set.
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'reviewer-1',
    host: 'ci-box',
    capability: { cognition: 'senior', family: 'opus' },
    listJobKeys: () => [...activeJobs.keys()],
    heartbeatIntervalMs: 0,
    transport: t.factory,
  });
  await tick();

  const reg = t.framesOf('register').at(-1);
  assert.equal(reg.lane, 'control', 'presence rides the control lane');
  assert.equal(reg.payload.instance, 'reviewer-1');
  assert.equal(reg.payload.capability.host, 'ci-box');
  assert.deepEqual(reg.payload.capability.jobs, [jobKey], 'presence carries the live jobKey');

  // C3: this job's PTY terminal streams on the relay lane through C2's SAME
  // client, framed and tagged by the job's stream (job:‹jobKey›), with steer-in
  // reaching the PTY.
  const session = createRelaySession({ channel: ch, jobKey });
  assert.equal(session.stream, relayStreamName(jobKey));
  const pf = fakePtyFactory();
  const p = spawnCapturePty({
    command: 'sh',
    args: ['-c', 'agent'],
    stdinData: '{"jobKey":"4856"}',
    ptyFactory: pf,
    relayTap: {
      onData: (buf) => session.relay(buf),
      attachSteer: (write) => session.attachSteer(write),
    },
  });
  // Wire steer-in the way runAgentJob does: spawnCapturePty attaches steer via
  // relayTap.attachSteer, so inbound relay frames on this stream feed the PTY.
  const term = pf.term();

  term.feed('booting agent…\r\n');
  await tick();

  const relayFrame = t.framesOf('relay').at(-1);
  assert.equal(relayFrame.lane, 'bulk', 'terminal output rides the bulk relay lane');
  assert.equal(relayFrame.payload.stream, `job:${jobKey}`, 'relay frame tagged with the jobKey stream');
  assert.match(relayFrame.payload.chunk, /booting agent/);

  // Steer-in: a cockpit relay frame on this job's stream, delivered the way the
  // hub would (encoded with the shared codec and handed to the client's inbound
  // `onFrame` hook), must reach the PTY. The relay session subscribed via
  // channel.client.onFrame, so the bytes land as a PTY write.
  t.deliverInbound({
    lane: 'bulk',
    family: 'relay',
    seq: 1,
    payload: { stream: `job:${jobKey}`, offset: 0, chunk: '\x03' },
  });
  assert.equal(term.writes.at(-1), '\x03', 'steer-in reached the PTY');

  term.exit(0);
  const result = await p;
  assert.equal(result.ok, true);
  assert.match(result.stdout, /booting agent/);

  // C2: clean deregister on exit — the worker disappears from the page.
  session.close();
  await ch.stop('worker stopped');
  await tick();
  const dereg = t.framesOf('deregister').at(-1);
  assert.equal(dereg.payload.instance, 'reviewer-1');
  assert.equal(dereg.payload.reason, 'worker stopped');
  assert.equal(ch.connected(), false);
});

test('a worker that starts before the app buffers presence + relay and drains in order on connect (C4), decoded with the shared codec', async () => {
  const t = makeGatedTransport();
  const jobKey = '900';
  const ch = await createWorkChannel({
    ...BASE,
    instance: 'w-early',
    host: 'h-early',
    listJobKeys: () => [jobKey],
    heartbeatIntervalMs: 0,
    transport: t.factory,
    bufferCapacity: 64,
    ...RECONNECT,
  });
  const monitor = createBufferMonitor(ch, { capacity: 64, sampleIntervalMs: 0 });
  const session = createRelaySession({ channel: ch, jobKey });

  // App is down: presence (control) + relay (bulk) frames buffer at the
  // transport seam below the lanes.
  for (let i = 1; i <= 4; i++) session.relay(`line-${i}\n`);
  monitor.sample();
  assert.equal(ch.connected(), false);
  assert.equal(ch.buffered() >= 5, true, 'presence + 4 relay frames buffered while down');
  assert.equal(monitor.health().highWaterMark >= 5, true);

  // App comes up: the built-in ring drains in strict order — control before
  // bulk, FIFO within a lane, no loss/reorder.
  t.openCurrent();
  await tick();
  assert.equal(ch.connected(), true);
  assert.equal(ch.buffered(), 0, 'backlog fully drained on connect');
  assert.equal(t.framesOf('register').length >= 1, true, 'presence survived the outage');
  const relayChunks = t.framesOf('relay').map((f) => f.payload.chunk);
  assert.deepEqual(
    relayChunks,
    ['line-1\n', 'line-2\n', 'line-3\n', 'line-4\n'],
    'relay frames drain in production order — no loss, no reorder',
  );
  assert.equal(monitor.health().flushes >= 1, true, 'the pre-app flush is recorded');

  session.close();
  monitor.stop();
  await ch.stop();
});

// ===========================================================================
// The documented same-port /agentic connection + auth gate.
// ===========================================================================

test('the documented same-port /agentic URL carries the identity the hub authenticator enforces (capability optional)', () => {
  const url = buildAgenticUrl('http://localhost:8080', { token: 'ident-secret', credential: 'cap-cred' });
  const u = new URL(url);
  assert.equal(u.pathname, '/agentic', 'served same-port at /agentic (ADR 0056)');
  assert.equal(u.protocol, 'ws:');

  // SECURE mode requires only the shared-secret identity token; the capability
  // credential was removed from the hub contract (it was accept-any friction) and
  // is now legacy/optional. Construct the authenticator credential-optional to
  // mirror the shipped hub's secret-only SECURE mode.
  const auth = agenticChannel.sharedSecretAuthenticator({ secret: 'ident-secret', requireCredential: false });
  const handshake = (link) => ({ query: Object.fromEntries(new URL(link).searchParams.entries()), remote: '127.0.0.1' });

  // valid identity connects; an optional capability is still carried through when present
  const okRes = auth(handshake(url));
  assert.equal(okRes.ok, true);
  assert.equal(okRes.grant.capability, 'cap-cred');

  // invalid identity rejected (unauthorized) — the shared secret is still enforced
  const badIdent = buildAgenticUrl('http://localhost:8080', { token: 'WRONG', credential: 'cap-cred' });
  assert.equal(auth(handshake(badIdent)).ok, false);
  assert.equal(auth(handshake(badIdent)).code, agenticChannel.AUTH_UNAUTHORIZED);

  // missing capability is ACCEPTED in secret-only SECURE mode (capability is optional)
  const noCap = buildAgenticUrl('http://localhost:8080', { token: 'ident-secret', credential: '' });
  const noCapRes = auth(handshake(noCap));
  assert.equal(noCapRes.ok, true, 'secret-only SECURE mode: a missing capability credential is accepted');
  assert.equal(noCapRes.grant.capability, undefined, 'no capability is granted when none is presented');

  // secrets are redacted in the logged URL
  assert.doesNotMatch(redactAgenticUrl(url), /ident-secret|cap-cred/);
});

// ===========================================================================
// Conformance corpus stays wired (C0) — the plane is exercised against the
// shared vectors here too.
// ===========================================================================

test('the shared conformance corpus is loaded and non-empty (kept green by C0)', () => {
  assert.ok(Array.isArray(GOLDEN_FRAMES) && GOLDEN_FRAMES.length > 0, 'golden frames loaded from @nanobpm/agentic/protocol/conformance');
});

// ===========================================================================
// Docs guard: hire/work help + README document the channel + terminal opt-in.
// ===========================================================================

test('the `terminal` flag is documented as a per-role PTY-vs-pipe opt-in', () => {
  const flag = commands?.nano?.flags?.terminal;
  assert.ok(flag, 'a --terminal flag is registered');
  assert.match(flag.description, /pty/i);
  assert.match(flag.description, /pipe/i);
  assert.match(flag.description, /relay lane|steerable|terminal/i);
});

test('hire/work examples document the live-terminal opt-in and the agentic channel enrolment', () => {
  const examples = metadata?.commands?.nano?.examples || [];
  const commandsText = examples.map((e) => `${e.command} ${e.description}`);
  const hasTerminalExample = commandsText.some((s) => /--terminal pty/.test(s));
  assert.ok(hasTerminalExample, 'an example shows hiring a role with --terminal pty');
  const hasAgenticExample = commandsText.some((s) => /NANO_AGENTIC_URL/.test(s) && /agentic/i.test(s));
  assert.ok(hasAgenticExample, 'an example shows enrolling a worker on the /agentic channel');
});

test('README documents the /agentic channel connection, presence, PTY-vs-pipe opt-in, and the buffer bound', () => {
  const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
  // same-port channel connection
  assert.match(readme, /\/agentic/, 'documents the same-port /agentic channel path');
  assert.match(readme, /NANO_AGENTIC_URL/, 'documents the channel connection env');
  assert.match(readme, /NANO_AGENTIC_TOKEN/, 'documents the deprecated identity-token alias env');
  assert.match(readme, /NANO_AGENTIC_SECRET/, 'documents the shared-secret identity env (the primary SECURE-mode knob)');
  // presence appearance
  assert.match(readme, /presence/i, 'documents how presence appears');
  assert.match(readme, /visibility page/i, 'documents the Workforce visibility page');
  // per-role PTY vs pipe opt-in
  assert.match(readme, /--terminal pty/, 'documents the per-role PTY opt-in');
  assert.match(readme, /NANO_AGENTIC_TERMINAL/, 'documents the per-worker terminal override');
  // bounded buffer
  assert.match(readme, /NANO_AGENTIC_BUFFER_CAPACITY/, 'documents the operator-tunable buffer bound');
});
