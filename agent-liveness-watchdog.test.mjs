// Unit tests for the worker-side agentic-channel liveness watchdog
// (jwulf/c8ctl-plugin-nano#144).
//
// The durable half of that bug is a HALF-OPEN drop: after a nano server restart
// / crash / partition, a connected worker's channel client sits `disconnected`
// forever and the worker vanishes from the Nano Workers view until a supervisor
// restart, because neither the client lib's own reconnect nor the cold-start
// self-heal (armed only in `advisory`) ever re-arms. This repo's belt-and-
// suspenders fix is a watchdog: once a channel that HAS connected drops and does
// not recover within a stale threshold, force a full re-discovery + reopen
// instead of trusting the client lib alone.
//
// These tests lock in the two pure/injectable seams the worker wires together:
//   - `agenticChannelIsStale` — the trigger predicate (never fires for a channel
//     still doing its first connect, a healthy channel, or a fresh drop).
//   - `startAgenticChannelWatchdog` — the timer loop (fires `onStale` exactly
//     once per stale episode, guards re-entrancy across a slow heal, ignores a
//     null / healthy / not-yet-stale channel, and stops cleanly).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agenticChannelIsStale,
  startAgenticChannelWatchdog,
} from './c8ctl-plugin.js';

test('agenticChannelIsStale: a channel that never opened is NOT stale (initial connect owns it)', () => {
  assert.equal(agenticChannelIsStale({
    connected: () => false,
    everConnected: () => false,
    disconnectedSince: () => 1,
    now: () => 10_000_000,
    staleAfterMs: 60_000,
  }), false);
});

test('agenticChannelIsStale: a currently-connected channel is NOT stale', () => {
  assert.equal(agenticChannelIsStale({
    connected: () => true,
    everConnected: () => true,
    disconnectedSince: () => null,
    now: () => 10_000_000,
    staleAfterMs: 60_000,
  }), false);
});

test('agenticChannelIsStale: a dropped channel with no recorded drop time is NOT stale', () => {
  assert.equal(agenticChannelIsStale({
    connected: () => false,
    everConnected: () => true,
    disconnectedSince: () => null,
    now: () => 10_000_000,
    staleAfterMs: 60_000,
  }), false);
});

test('agenticChannelIsStale: a recent drop (within the threshold) is NOT yet stale', () => {
  const dropAt = 1_000_000;
  assert.equal(agenticChannelIsStale({
    connected: () => false,
    everConnected: () => true,
    disconnectedSince: () => dropAt,
    now: () => dropAt + 59_999,
    staleAfterMs: 60_000,
  }), false);
});

test('agenticChannelIsStale: a drop that outlives the threshold IS stale', () => {
  const dropAt = 1_000_000;
  assert.equal(agenticChannelIsStale({
    connected: () => false,
    everConnected: () => true,
    disconnectedSince: () => dropAt,
    now: () => dropAt + 60_000,
    staleAfterMs: 60_000,
  }), true);
});

test('agenticChannelIsStale: missing accessors degrade to not-stale (never throws)', () => {
  assert.equal(agenticChannelIsStale({}), false);
});

// A tiny controllable channel double: flip `open`/`ever`/`since` to model the
// lifecycle without a real socket.
function fakeChannel(initial = {}) {
  const state = { open: false, ever: true, since: null, ...initial };
  return {
    state,
    connected: () => state.open,
    everConnected: () => state.ever,
  };
}

// A manual timer harness: setInterval/clearInterval are captured so the test
// drives ticks itself (no real waits), and `now` is a controllable clock.
function timerHarness() {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => clock,
    advance: (ms) => { clock += ms; },
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms, unref() { return this; } });
      // return an object with unref (matches Node's Timeout enough for the code)
      return { id, unref() { return this; } };
    },
    clearIntervalFn: (handle) => { if (handle && handle.id != null) timers.delete(handle.id); },
    // Run every registered interval callback once, as if a tick elapsed.
    fireAll: () => { for (const t of [...timers.values()]) t.fn(); },
    count: () => timers.size,
  };
}

test('startAgenticChannelWatchdog: fires onStale once a connected channel drops past the threshold', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: true, ever: true, since: null });
  let stale = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { stale += 1; },
    staleAfterMs: 60_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });

  // Healthy: a tick does nothing.
  await wd.tick();
  assert.equal(stale, 0);

  // The channel drops (half-open: the client still reports it, no reconnect).
  ch.state.open = false;
  ch.state.since = h.now();

  // Still within the threshold — no heal yet.
  h.advance(59_000);
  await wd.tick();
  assert.equal(stale, 0);

  // Past the threshold — heal fires exactly once.
  h.advance(1_000);
  await wd.tick();
  assert.equal(stale, 1);

  wd.stop();
  assert.equal(h.count(), 0, 'stop() clears the interval');
});

test('startAgenticChannelWatchdog: never heals a channel that is still doing its first connect', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: false, ever: false, since: null });
  let stale = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { stale += 1; },
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });
  h.advance(1_000_000);
  await wd.tick();
  assert.equal(stale, 0, 'a never-opened channel is the initial-connect path, not the watchdog');
  wd.stop();
});

test('startAgenticChannelWatchdog: a null channel is a no-op (the self-heal loop owns recovery)', async () => {
  const h = timerHarness();
  let stale = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => null,
    disconnectedSince: () => 1,
    onStale: () => { stale += 1; },
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });
  h.advance(1_000_000);
  await wd.tick();
  assert.equal(stale, 0);
  wd.stop();
});

test('startAgenticChannelWatchdog: guards re-entrancy — a slow heal is not stacked by a later tick', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: false, ever: true, since: 0 });
  let inFlight = 0;
  let maxConcurrent = 0;
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: async () => {
      calls += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await gate; // hold the heal open so a second tick lands mid-heal
      inFlight -= 1;
    },
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });

  h.advance(20_000); // well past stale
  const first = wd.tick(); // enters the heal, then awaits the gate
  await Promise.resolve();
  const second = wd.tick(); // should be a no-op while the first heal is in flight
  await second;
  assert.equal(calls, 1, 'the second tick must not start a concurrent heal');
  assert.equal(maxConcurrent, 1);

  release();
  await first;

  // Same stale episode (never recovered) → the per-episode latch holds: a fresh
  // tick must NOT re-heal.
  await wd.tick();
  assert.equal(calls, 1, 'a persistent stale episode heals exactly once');

  // The channel recovers, ending the episode and re-arming the latch…
  ch.state.open = true;
  ch.state.since = null;
  await wd.tick();
  assert.equal(calls, 1, 'a healthy channel does not heal');

  // …then a fresh stale episode heals again.
  ch.state.open = false;
  ch.state.since = h.now();
  h.advance(20_000);
  await wd.tick();
  assert.equal(calls, 2, 'a new stale episode after recovery heals again');
  wd.stop();
});

test('startAgenticChannelWatchdog: a persistent stale episode fires onStale exactly once across many ticks', async () => {
  const h = timerHarness();
  // Stale from the start and it stays stale — onStale does NOT clear the signal.
  const ch = fakeChannel({ open: false, ever: true, since: 0 });
  let calls = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { calls += 1; }, // deliberately does not reset ch.state
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });

  h.advance(20_000); // well past stale
  for (let i = 0; i < 5; i += 1) { h.advance(5_000); await wd.tick(); }
  assert.equal(calls, 1, 'the latch holds onStale to one call per stale episode');
  wd.stop();
});

test('startAgenticChannelWatchdog: fired by its own interval (not just manual tick())', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: false, ever: true, since: 0 });
  let stale = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { stale += 1; },
    staleAfterMs: 10_000,
    intervalMs: 5_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });
  assert.equal(h.count(), 1, 'the watchdog registered exactly one interval');
  h.advance(20_000);
  h.fireAll(); // simulate the interval elapsing
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stale, 1, 'the registered interval callback drives the heal');
  wd.stop();
});

test('startAgenticChannelWatchdog: a heal that throws does not wedge the watchdog', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: false, ever: true, since: 0 });
  let calls = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { calls += 1; throw new Error('boom'); },
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });
  h.advance(20_000);
  await wd.tick(); // throws internally, swallowed
  assert.equal(calls, 1);
  // The guard must have been released despite the throw, so a later tick retries.
  await wd.tick();
  assert.equal(calls, 2, 'the re-entrancy guard is released even when a heal throws');
  wd.stop();
});

test('startAgenticChannelWatchdog: after stop() a tick is a no-op (no heal during teardown)', async () => {
  const h = timerHarness();
  const ch = fakeChannel({ open: false, ever: true, since: 0 });
  let calls = 0;
  const wd = startAgenticChannelWatchdog({
    getChannel: () => ch,
    disconnectedSince: () => ch.state.since,
    onStale: () => { calls += 1; },
    staleAfterMs: 10_000,
    now: h.now,
    setIntervalFn: h.setIntervalFn,
    clearIntervalFn: h.clearIntervalFn,
  });
  // The channel is well past the threshold — a tick would heal…
  h.advance(20_000);
  // …but shutdown has already run, so any in-flight/scheduled tick must no-op
  // and can never re-open the channel mid-teardown.
  wd.stop();
  await wd.tick();
  assert.equal(calls, 0, 'stop() latches the watchdog so a stale tick never reaches onStale');
});
