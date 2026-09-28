// Focused coverage for the LIVE presence-enrolment capability a worker
// advertises on the agentic `register` frame (issue #272).
//
// The worker no longer uses `createWorkChannel` for presence: `workAgent`
// builds this capability and hands it to `supervisor.ownership.register`. So a
// test that injects `{ harnessProtocol: 1 }` into the retired work-channel
// scaffold would still pass if the production assignment were dropped or
// misspelled. These tests instead exercise the exact builder `workAgent`
// calls (`buildAgenticCapability`), pinning the advertised value to the
// single-source-of-truth constant.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgenticCapability, HARNESS_PROTOCOL_VERSION } from './c8ctl-plugin.js';

test('advertises harnessProtocol tracking the single-source-of-truth constant', () => {
  const cap = buildAgenticCapability({ rank: 'senior', model: 'Opus 4.8' }, 'host-a');
  assert.equal(cap.harnessProtocol, HARNESS_PROTOCOL_VERSION);
});

test('carries cognition (rank), family (model) and host', () => {
  const cap = buildAgenticCapability({ rank: 'junior', model: 'Sonnet' }, 'host-b');
  assert.equal(cap.cognition, 'junior');
  assert.equal(cap.family, 'Sonnet');
  assert.equal(cap.host, 'host-b');
});

test('omits family when the profile has no model', () => {
  const cap = buildAgenticCapability({ rank: 'senior' }, 'host-c');
  assert.equal(cap.family, undefined);
  assert.ok(!('family' in cap) || cap.family === undefined);
  // protocol is still advertised even without a model
  assert.equal(cap.harnessProtocol, HARNESS_PROTOCOL_VERSION);
});

test('defaults host to the machine hostname when not supplied', () => {
  const cap = buildAgenticCapability({ rank: 'senior', model: 'm' });
  assert.equal(typeof cap.host, 'string');
  assert.ok(cap.host.length > 0);
});
