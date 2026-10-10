// Tests for the host c8ctl / Camunda SDK version probe (issue #289). These back the
// startup "durable transcripts disabled" warning and the per-job "producer unavailable"
// diagnostic, which must name the host package that has to be upgraded.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeHostSdkInfo, formatHostSdkInfo } from './c8ctl-plugin.js';

test('probeHostSdkInfo resolves both package versions via the injected require', () => {
  const fakeRequire = (spec) => {
    if (spec === '@camunda8/cli/package.json') return { version: '4.2.0-alpha.2' };
    if (spec === '@camunda8/orchestration-cluster-api/package.json') return { version: '10.0.0-alpha.45' };
    throw new Error(`unexpected require: ${spec}`);
  };
  const info = probeHostSdkInfo(fakeRequire);
  assert.equal(info.cliVersion, '4.2.0-alpha.2');
  assert.equal(info.sdkVersion, '10.0.0-alpha.45');
});

test('probeHostSdkInfo yields null for an unresolvable package rather than throwing', () => {
  const fakeRequire = (spec) => {
    if (spec === '@camunda8/cli/package.json') throw new Error('Cannot find module');
    if (spec === '@camunda8/orchestration-cluster-api/package.json') return { version: '9.1.5' };
    throw new Error(`unexpected require: ${spec}`);
  };
  const info = probeHostSdkInfo(fakeRequire);
  assert.equal(info.cliVersion, null);
  assert.equal(info.sdkVersion, '9.1.5');
});

test('probeHostSdkInfo treats a blank/missing version as null', () => {
  const fakeRequire = (spec) => {
    if (spec === '@camunda8/cli/package.json') return { version: '   ' };
    if (spec === '@camunda8/orchestration-cluster-api/package.json') return {};
    throw new Error(`unexpected require: ${spec}`);
  };
  const info = probeHostSdkInfo(fakeRequire);
  assert.equal(info.cliVersion, null);
  assert.equal(info.sdkVersion, null);
});

test('formatHostSdkInfo renders both versions, falling back to "version unknown"', () => {
  assert.equal(
    formatHostSdkInfo({ cliVersion: '4.1.0-alpha.2', sdkVersion: '9.1.5' }),
    '@camunda8/cli 4.1.0-alpha.2, @camunda8/orchestration-cluster-api 9.1.5',
  );
  assert.equal(
    formatHostSdkInfo({ cliVersion: null, sdkVersion: null }),
    '@camunda8/cli (version unknown), @camunda8/orchestration-cluster-api (version unknown)',
  );
  assert.equal(
    formatHostSdkInfo(null),
    '@camunda8/cli (version unknown), @camunda8/orchestration-cluster-api (version unknown)',
  );
});
