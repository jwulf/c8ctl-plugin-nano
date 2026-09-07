// Unit test for the macOS Local Network Privacy (TCC) block detector.
//
// On macOS 15 Sequoia / 26 Tahoe the supervisor's session-independent
// `gui/$UID` LaunchAgent (installed so the fleet survives SSH logout, #197) is a
// distinct TCC identity that is NOT granted **Local Network** access — an
// interactive SSH/Terminal session inherits that grant, a launchd service does
// not. So a service-owned fleet whose engine is on the LAN wedges with
// `EHOSTUNREACH` to the LAN IP (even the raw IPv4 literal) while internet hosts
// still work — the same "fetch failed" / `0` job types symptom as the IPv6/mDNS
// case (#139/#151) but with a different root cause and remediation.
//
// This detector distinguishes the TCC block from the IPv6/mDNS case so the
// worker can surface an actionable hint instead of a bare "fetch failed". These
// tests pin the classifier against synthetic undici-shaped errors (no Mac, no
// live engine needed), covering the defect *class* — every private range, the
// Tailscale-CGNAT exclusion, WAN, non-launchd, non-darwin, and other codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLikelyLocalNetworkTccBlock,
  isUnderLaunchdSupervisorService,
  isPrivateLanIPv4,
  localNetworkTccHint,
  SUPERVISOR_SERVICE_LABEL_PREFIX,
} from './c8ctl-plugin.js';

// An undici `fetch` connection failure: a TypeError('fetch failed') whose OS-level
// detail (code/address) hangs off `.cause`.
const fetchFailed = (code, address) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code}`), {
      code,
      address,
      port: 8080,
      syscall: 'connect',
    }),
  });

const ehostunreach = (address) => fetchFailed('EHOSTUNREACH', address);
const tccEnv = { XPC_SERVICE_NAME: `${SUPERVISOR_SERVICE_LABEL_PREFIX}1bb77887` };

// --- isUnderLaunchdSupervisorService: the gui/$UID launchd identity signal ---

test('detects the supervisor LaunchAgent via its XPC_SERVICE_NAME prefix', () => {
  assert.equal(isUnderLaunchdSupervisorService(tccEnv), true);
});

test('a non-supervisor / absent XPC_SERVICE_NAME is not the launchd service', () => {
  assert.equal(isUnderLaunchdSupervisorService({ XPC_SERVICE_NAME: '0' }), false);
  assert.equal(isUnderLaunchdSupervisorService({ XPC_SERVICE_NAME: 'com.apple.other' }), false);
  assert.equal(isUnderLaunchdSupervisorService({}), false);
});

// --- isPrivateLanIPv4: the LAN-peer address class the TCC gate blocks ---

test('recognises RFC1918 + link-local IPv4 as LAN', () => {
  for (const a of ['10.0.0.1', '10.255.1.2', '172.16.0.1', '172.31.9.9', '192.168.0.21', '169.254.1.1']) {
    assert.equal(isPrivateLanIPv4(a), true, a);
  }
});

test('excludes Tailscale CGNAT (100.64/10), loopback, and public IPv4', () => {
  for (const a of ['100.119.149.105', '100.64.0.1', '127.0.0.1', '93.184.216.34', '8.8.8.8', '172.32.0.1']) {
    assert.equal(isPrivateLanIPv4(a), false, a);
  }
});

test('is robust to non-address inputs', () => {
  for (const a of [undefined, null, '', 'not-an-ip', '::1', 'fe80::1']) {
    assert.equal(isPrivateLanIPv4(a), false, String(a));
  }
});

// --- isLikelyLocalNetworkTccBlock: the composed heuristic ---

test('classifies EHOSTUNREACH to a private LAN IP under the launchd service as a TCC block', () => {
  for (const a of ['192.168.0.21', '10.1.2.3', '172.20.0.5']) {
    assert.equal(
      isLikelyLocalNetworkTccBlock({ error: ehostunreach(a), platform: 'darwin', env: tccEnv }),
      true,
      a,
    );
  }
});

test('does NOT fire outside the launchd service (interactive SSH keeps its grant)', () => {
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: ehostunreach('192.168.0.21'), platform: 'darwin', env: {} }),
    false,
  );
});

test('does NOT fire on non-darwin platforms', () => {
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: ehostunreach('192.168.0.21'), platform: 'linux', env: tccEnv }),
    false,
  );
});

test('does NOT fire for a Tailscale CGNAT peer (utun is exempt from the TCC gate)', () => {
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: ehostunreach('100.119.149.105'), platform: 'darwin', env: tccEnv }),
    false,
  );
});

test('does NOT fire for a public/WAN address (internet still works from the service)', () => {
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: ehostunreach('93.184.216.34'), platform: 'darwin', env: tccEnv }),
    false,
  );
});

test('does NOT fire for other error codes (ECONNREFUSED / ETIMEDOUT are not the TCC signature)', () => {
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: fetchFailed('ECONNREFUSED', '192.168.0.21'), platform: 'darwin', env: tccEnv }),
    false,
  );
  assert.equal(
    isLikelyLocalNetworkTccBlock({ error: fetchFailed('ETIMEDOUT', '192.168.0.21'), platform: 'darwin', env: tccEnv }),
    false,
  );
});

// --- localNetworkTccHint: the actionable remediation surfaced to the operator ---

test('the remediation hint names all three fixes (grant / Tailscale / SSH session)', () => {
  const h = localNetworkTccHint();
  assert.match(h, /Local Network/i);
  assert.match(h, /Tailscale/i);
  assert.match(h, /supervisor uninstall/);
});
