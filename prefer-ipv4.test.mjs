// Unit test for the process/harness-wide IPv4-preference hardening
// (jwulf/c8ctl-plugin-nano#151).
//
// A LAN host advertised over mDNS (`*.local`) frequently resolves to an IPv6
// link-local `fe80::…` FIRST, which the engine (bound `0.0.0.0`) never accepts.
// A long-lived worker (or its forked agent) that picks that address and doesn't
// prefer IPv4 wedges — `connect EHOSTUNREACH`, `--auto` reconcile timeouts, a
// hung agent request — until the process is re-forked. This is the class fix:
// force `ipv4first` ordering PROCESS-WIDE (so every outbound the worker + its
// in-process clients make ranks the reachable A record ahead of a dead AAAA) and
// PROPAGATE it into the forked agent via `--dns-result-order=ipv4first` in
// NODE_OPTIONS. These tests pin both seams against injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import {
  preferIpv4Resolution,
  ipv4FirstNodeOptions,
  withIpv4FirstNodeOptions,
  DNS_RESULT_ORDER_IPV4_FIRST,
} from './c8ctl-plugin.js';

test('the exported token is the Node ipv4first ordering', () => {
  assert.equal(DNS_RESULT_ORDER_IPV4_FIRST, 'ipv4first');
});

// --- preferIpv4Resolution: process-wide DNS ordering seam (AC1/AC2) ---

test('asserts setDefaultResultOrder(ipv4first) once', () => {
  const calls = [];
  const fakeDns = { setDefaultResultOrder: (v) => calls.push(v) };
  const ok = preferIpv4Resolution({ dns: fakeDns });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['ipv4first']);
});

test('the order token is overridable (injection seam)', () => {
  const calls = [];
  const fakeDns = { setDefaultResultOrder: (v) => calls.push(v) };
  preferIpv4Resolution({ dns: fakeDns, order: 'verbatim' });
  assert.deepEqual(calls, ['verbatim']);
});

test('fails open when the runtime lacks the setter (returns false, no throw)', () => {
  assert.equal(preferIpv4Resolution({ dns: {} }), false);
  assert.equal(preferIpv4Resolution({ dns: null }), false);
});

test('fails open when the setter throws (never a start gate)', () => {
  const throwingDns = { setDefaultResultOrder: () => { throw new Error('boom'); } };
  assert.equal(preferIpv4Resolution({ dns: throwingDns }), false);
});

test('a non-object arg (null) fails open instead of throwing', () => {
  assert.doesNotThrow(() => preferIpv4Resolution(null));
  assert.equal(typeof preferIpv4Resolution(null), 'boolean');
});

test('default seam flips the real process-wide DNS default to ipv4first', () => {
  const prev = typeof dns.getDefaultResultOrder === 'function'
    ? dns.getDefaultResultOrder()
    : undefined;
  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('verbatim');
      const ok = preferIpv4Resolution();
      assert.equal(ok, true);
      if (typeof dns.getDefaultResultOrder === 'function') {
        assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
      }
    } else {
      assert.equal(preferIpv4Resolution(), false);
    }
  } finally {
    // node --test can run files concurrently; restore the process-wide default
    // so a leaked ordering can't cause order-dependent failures elsewhere.
    if (prev !== undefined && typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder(prev);
    }
  }
});

// --- ipv4FirstNodeOptions: forked-agent inheritance seam (AC3) ---

test('adds the ordering flag to an empty NODE_OPTIONS', () => {
  assert.equal(ipv4FirstNodeOptions(''), '--dns-result-order=ipv4first');
  assert.equal(ipv4FirstNodeOptions(), '--dns-result-order=ipv4first');
  assert.equal(ipv4FirstNodeOptions(undefined), '--dns-result-order=ipv4first');
});

test('appends to (never clobbers) existing options', () => {
  assert.equal(
    ipv4FirstNodeOptions('--max-old-space-size=512'),
    '--max-old-space-size=512 --dns-result-order=ipv4first',
  );
});

test('respects an operator who already pinned a --dns-result-order', () => {
  // A deliberate `verbatim` (or any explicit order) is left untouched — we harden
  // the default, we do not override an explicit choice.
  assert.equal(
    ipv4FirstNodeOptions('--dns-result-order=verbatim'),
    '--dns-result-order=verbatim',
  );
  assert.equal(
    ipv4FirstNodeOptions('--foo --dns-result-order=ipv6first --bar'),
    '--foo --dns-result-order=ipv6first --bar',
  );
});

test('is idempotent (does not double-add its own flag)', () => {
  const once = ipv4FirstNodeOptions('');
  assert.equal(ipv4FirstNodeOptions(once), once);
});

test('trims surrounding whitespace on the incoming value', () => {
  assert.equal(ipv4FirstNodeOptions('   '), '--dns-result-order=ipv4first');
  assert.equal(
    ipv4FirstNodeOptions('  --enable-source-maps  '),
    '--enable-source-maps --dns-result-order=ipv4first',
  );
});

test('a non-string incoming value is coerced to the flag alone', () => {
  assert.equal(ipv4FirstNodeOptions(42), '--dns-result-order=ipv4first');
  assert.equal(ipv4FirstNodeOptions(null), '--dns-result-order=ipv4first');
});

// --- withIpv4FirstNodeOptions: env-map wrapper applied at every spawn site ---

test('returns a NEW env map with NODE_OPTIONS hardened, input untouched', () => {
  const input = { PATH: '/usr/bin', NODE_OPTIONS: '--enable-source-maps' };
  const out = withIpv4FirstNodeOptions(input);
  assert.notEqual(out, input);
  assert.equal(input.NODE_OPTIONS, '--enable-source-maps'); // input not mutated
  assert.equal(out.PATH, '/usr/bin'); // other keys preserved
  assert.equal(out.NODE_OPTIONS, '--enable-source-maps --dns-result-order=ipv4first');
});

test('adds NODE_OPTIONS when the env has none', () => {
  const out = withIpv4FirstNodeOptions({ HOME: '/root' });
  assert.equal(out.NODE_OPTIONS, '--dns-result-order=ipv4first');
  assert.equal(out.HOME, '/root');
});

test('tolerates a non-object env (returns just the flag)', () => {
  assert.equal(withIpv4FirstNodeOptions(null).NODE_OPTIONS, '--dns-result-order=ipv4first');
  assert.equal(withIpv4FirstNodeOptions(undefined).NODE_OPTIONS, '--dns-result-order=ipv4first');
});
