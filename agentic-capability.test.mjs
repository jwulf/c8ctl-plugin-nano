// Focused coverage of the LIVE presence-enrolment capability the worker
// advertises on `register` (issue #272). The `work-channel` /
// `agentic-runtime-integration` suites drive the frame plumbing but inject a
// hand-written `{ harnessProtocol: 1 }` capability, so they cannot catch the
// production assignment in `workAgent` being dropped or misspelled. `workAgent`
// now builds that exact object via the pure `buildAgenticCapability` export, so
// these tests pin the ACTUAL advertised value — including the harness-protocol
// version nano-workforce (#802) freshness-checks — without standing up the
// whole supervisor stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgenticCapability, HARNESS_PROTOCOL_VERSION } from './c8ctl-plugin.js';

test('buildAgenticCapability advertises the harness-protocol version the live worker registers (#272)', () => {
  const cap = buildAgenticCapability({ rank: 'senior', model: 'opus' }, 'ci-box');
  assert.equal(
    cap.harnessProtocol,
    HARNESS_PROTOCOL_VERSION,
    'the advertised protocol tracks the single-source-of-truth constant so nano-workforce does not flag the worker stale',
  );
  assert.equal(cap.cognition, 'senior');
  assert.equal(cap.family, 'opus');
  assert.equal(cap.host, 'ci-box');
});

test('buildAgenticCapability omits family when the profile has no model (no bogus undefined)', () => {
  const cap = buildAgenticCapability({ rank: 'junior' }, 'h1');
  assert.equal('family' in cap, false, 'absent model stays absent rather than being emitted as undefined');
  assert.equal(cap.cognition, 'junior');
  assert.equal(cap.harnessProtocol, HARNESS_PROTOCOL_VERSION);
});

test('buildAgenticCapability defaults the host to this machine when none is given', () => {
  const cap = buildAgenticCapability({ rank: 'senior', model: 'opus' });
  assert.equal(typeof cap.host, 'string');
  assert.ok(cap.host.length > 0, 'a host is always advertised');
});
