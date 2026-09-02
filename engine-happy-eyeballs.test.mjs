// Unit test for the engine-client Happy-Eyeballs enabler
// (jwulf/c8ctl-plugin-nano#139).
//
// The worker harness's engine client (`@camunda8` `activateJobs` + the raw-fetch
// `--auto` engine reads) did NOT perform Happy-Eyeballs / dual-stack address
// selection. When the engine host resolved IPv6-first with an unreachable v6
// address (macOS mDNS `fe80::` link-local, a stray AAAA, an IPv6-advertised
// host), the client connected to the dead address and failed with
// `fetch failed` / `write EPIPE` / `UND_ERR_CONNECT_TIMEOUT` instead of falling
// back to IPv4 — even though `curl`/`fetch` reach the same host fine. The
// `--auto` autoscaler then read 0 job types and scaled the whole fleet to zero.
//
// The fix asserts Node's PROCESS-WIDE net default to Happy-Eyeballs
// (`setDefaultAutoSelectFamily(true)` + a bounded attempt timeout) once, before
// the SDK client or any engine read is created, so BOTH transports inherit it.
// These tests pin that contract against an injected `net` seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { enableEngineHappyEyeballs } from './c8ctl-plugin.js';

test('asserts autoSelectFamily true and a bounded attempt timeout', () => {
  const calls = [];
  const fakeNet = {
    setDefaultAutoSelectFamily: (v) => calls.push(['family', v]),
    setDefaultAutoSelectFamilyAttemptTimeout: (v) => calls.push(['timeout', v]),
  };
  const ok = enableEngineHappyEyeballs({ net: fakeNet });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['family', true], ['timeout', 250]]);
});

test('the attempt timeout is overridable', () => {
  const calls = [];
  const fakeNet = {
    setDefaultAutoSelectFamily: () => {},
    setDefaultAutoSelectFamilyAttemptTimeout: (v) => calls.push(v),
  };
  enableEngineHappyEyeballs({ net: fakeNet, attemptTimeoutMs: 500 });
  assert.deepEqual(calls, [500]);
});

test('a non-positive / non-finite attempt timeout skips the timeout setter', () => {
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
    let timeoutCalled = false;
    let familyCalled = false;
    const fakeNet = {
      setDefaultAutoSelectFamily: () => { familyCalled = true; },
      setDefaultAutoSelectFamilyAttemptTimeout: () => { timeoutCalled = true; },
    };
    const ok = enableEngineHappyEyeballs({ net: fakeNet, attemptTimeoutMs: bad });
    // family is still asserted (the primary lever); only the timeout is skipped.
    assert.equal(familyCalled, true, `family for ${String(bad)}`);
    assert.equal(ok, true, `ret for ${String(bad)}`);
    assert.equal(timeoutCalled, false, `timeout skipped for ${String(bad)}`);
  }
});

test('fails open when the runtime lacks the setter (returns false, no throw)', () => {
  assert.equal(enableEngineHappyEyeballs({ net: {} }), false);
  assert.equal(enableEngineHappyEyeballs({ net: null }), false);
  // Only the timeout setter present (family missing) → still a no-op fail-open.
  assert.equal(
    enableEngineHappyEyeballs({ net: { setDefaultAutoSelectFamilyAttemptTimeout: () => {} } }),
    false,
  );
});

test('fails open when a setter throws (never a start gate)', () => {
  const throwingNet = {
    setDefaultAutoSelectFamily: () => { throw new Error('boom'); },
    setDefaultAutoSelectFamilyAttemptTimeout: () => {},
  };
  assert.equal(enableEngineHappyEyeballs({ net: throwingNet }), false);
});

test('missing the timeout setter still asserts the family default (partial API)', () => {
  let familyValue;
  const partialNet = { setDefaultAutoSelectFamily: (v) => { familyValue = v; } };
  assert.equal(enableEngineHappyEyeballs({ net: partialNet }), true);
  assert.equal(familyValue, true);
});

test('a non-object arg (null) fails open instead of throwing', () => {
  // The reviewer's concern was that `null` threw during destructuring. It must
  // now be swallowed like any other bad input: no throw, boolean result.
  assert.doesNotThrow(() => enableEngineHappyEyeballs(null));
  assert.equal(typeof enableEngineHappyEyeballs(null), 'boolean');
});

test('a throwing optional timeout setter does not retract the family default', () => {
  let familyValue;
  const net = {
    setDefaultAutoSelectFamily: (v) => { familyValue = v; },
    setDefaultAutoSelectFamilyAttemptTimeout: () => { throw new Error('boom'); },
  };
  // Primary default was asserted, so the contract holds even though the
  // optional timeout refinement threw.
  assert.equal(enableEngineHappyEyeballs({ net }), true);
  assert.equal(familyValue, true);
});

test('default seam flips the real process-wide net default to Happy-Eyeballs', () => {
  const prev = typeof net.getDefaultAutoSelectFamily === 'function'
    ? net.getDefaultAutoSelectFamily()
    : undefined;
  // Capture the attempt-timeout default too: the helper mutates it as well, and
  // node --test can run files concurrently, so leaking a changed process-wide
  // default here could cause order-dependent failures in other test files.
  const prevTimeout = typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
    ? net.getDefaultAutoSelectFamilyAttemptTimeout()
    : undefined;
  try {
    if (typeof net.setDefaultAutoSelectFamily === 'function') {
      net.setDefaultAutoSelectFamily(false);
      const ok = enableEngineHappyEyeballs();
      assert.equal(ok, true);
      assert.equal(net.getDefaultAutoSelectFamily(), true);
    } else {
      // Runtime without the API: the helper must fail open rather than throw.
      assert.equal(enableEngineHappyEyeballs(), false);
    }
  } finally {
    if (prev !== undefined && typeof net.setDefaultAutoSelectFamily === 'function') {
      net.setDefaultAutoSelectFamily(prev);
    }
    if (prevTimeout !== undefined && typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
      net.setDefaultAutoSelectFamilyAttemptTimeout(prevTimeout);
    }
  }
});
