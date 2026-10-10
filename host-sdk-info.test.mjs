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

test('probeHostSdkInfo walks a resolver chain — a later host-graph resolver wins when the plugin graph misses', () => {
  // Issue #289 review: the host SDK lives in the host c8ctl CLI's dependency graph, NOT
  // this plugin's sibling node_modules, so a probe rooted only at the plugin commonly
  // reads null. The probe must try a chain of resolvers and take the FIRST that yields a
  // version. Here the first (plugin-graph) resolver resolves neither package; the second
  // (host-graph) resolver resolves both.
  const pluginGraph = (spec) => {
    throw new Error(`Cannot find module '${spec}' from the plugin graph`);
  };
  const hostGraph = (spec) => {
    if (spec === '@camunda8/cli/package.json') return { version: '4.1.0-alpha.2' };
    if (spec === '@camunda8/orchestration-cluster-api/package.json') return { version: '9.1.5' };
    throw new Error(`unexpected require: ${spec}`);
  };
  const info = probeHostSdkInfo(undefined, [pluginGraph, hostGraph]);
  assert.equal(info.cliVersion, '4.1.0-alpha.2');
  assert.equal(info.sdkVersion, '9.1.5');
});

test('probeHostSdkInfo resolves each package from whichever chain resolver has it', () => {
  // A split layout: the CLI version is only visible from the entry graph, the nested SDK
  // only from a require rooted at the CLI package. The per-package chain walk must find
  // each independently rather than demanding one resolver satisfy both.
  const entryGraph = (spec) => {
    if (spec === '@camunda8/cli/package.json') return { version: '5.0.0' };
    throw new Error(`Cannot find module '${spec}'`);
  };
  const cliGraph = (spec) => {
    if (spec === '@camunda8/orchestration-cluster-api/package.json') return { version: '10.0.0-alpha.45' };
    throw new Error(`Cannot find module '${spec}'`);
  };
  const info = probeHostSdkInfo(undefined, [entryGraph, cliGraph]);
  assert.equal(info.cliVersion, '5.0.0');
  assert.equal(info.sdkVersion, '10.0.0-alpha.45');
});

test('probeHostSdkInfo yields null for both when no chain resolver resolves — never throws', () => {
  const miss = (spec) => { throw new Error(`Cannot find module '${spec}'`); };
  const info = probeHostSdkInfo(undefined, [miss, miss]);
  assert.equal(info.cliVersion, null);
  assert.equal(info.sdkVersion, null);
});
