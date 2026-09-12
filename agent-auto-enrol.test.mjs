// Unit tests for `nano work --auto`: zero-config engine-read enrolment
// (jwulf/c8ctl-plugin-nano#66). Since issue #235, agent-task discovery keys on a
// SINGLE convention — the external-agent marker every external agent task carries,
//
//     <zeebe:agentDefinition agentType="external" />
//
// (preferring a package-supplied `leaf.external` flag when present) — retiring the
// former dual `agentic` prompt-link / legacy `io.nanobpm.agentTask`-header
// detection. A task may additionally OPT OUT of `--auto` with
//
//     <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
//
// (served only by explicit `--job-type`/profile subscription). Plain connectors
// and record-keepers (e.g. `pr.record-plan`) carry no marker and are excluded. The
// engine read is driven through an in-memory C8RestReader seam so no live engine
// is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanAgentTaskLeaves,
  serviceTaskIsExternalAgent,
  externalAgentElementIds,
  serviceTaskOptsOutOfAutoSubscribe,
  autoSubscribeOptOutElementIds,
  readDeployedAgentJobTypes,
  resolveAutoJobTypes,
} from './c8ctl-plugin.js';
import { demand } from './agentic.mjs';

// The published detector this plugin consumes — injected into `scanAgentTaskLeaves`
// exactly as `readDeployedAgentJobTypes` supplies it at runtime.
const { scanTaskDefinitions } = demand;

// A minimal deployed-model builder: one bpmn:process with the given service
// tasks. Each task is `{ id, type, external?, optOut?, agentic?, noTaskDef? }`.
// An `external` task carries the `<zeebe:agentDefinition agentType="external">`
// marker (the single auto-discovery convention); `optOut` adds the
// `io.nanobpm.agentTask.autoSubscribe="false"` property; `agentic` adds a
// `linkName="prompt"` linked resource (proving the prompt link alone is NO LONGER
// sufficient).
function model(processId, tasks) {
  const body = tasks
    .map((t) => {
      const td = t.noTaskDef ? '' : `<zeebe:taskDefinition type="${t.type}" />`;
      const marker = t.external ? '<zeebe:agentDefinition agentType="external" />' : '';
      const optOut = t.optOut
        ? '<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />'
        : '';
      const link = t.agentic
        ? '<zeebe:linkedResources><zeebe:linkedResource resourceId="p" linkName="prompt" /></zeebe:linkedResources>'
        : '';
      return `<bpmn:serviceTask id="${t.id}"><bpmn:extensionElements>${td}${marker}${optOut}${link}</bpmn:extensionElements></bpmn:serviceTask>`;
    })
    .join('');
  return `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://x" xmlns:zeebe="http://y"><bpmn:process id="${processId}" isExecutable="true">${body}</bpmn:process></bpmn:definitions>`;
}

// An in-memory C8RestReader over a { processDefinitionKey → xml } map, matching
// the seam `readDeployedAgentJobTypes` / `resolveAutoJobTypes` consume.
function memReader(defs) {
  return {
    async searchProcessDefinitionKeys() {
      return Object.keys(defs);
    },
    async getProcessDefinitionXml(key) {
      if (!(key in defs)) throw new Error(`no such definition ${key}`);
      return defs[key];
    },
  };
}

test('scanAgentTaskLeaves keeps only external-marked service tasks with a task type', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', external: true },
    { id: 'impl', type: 'senior:feature', external: true },
    // record-keeper: has a task definition but NO external marker → excluded.
    { id: 'record', type: 'pr.record-plan' },
    // external marker but no task definition → excluded (nothing to route).
    { id: 'broken', external: true, noTaskDef: true },
  ]);
  const leaves = scanAgentTaskLeaves(xml, scanTaskDefinitions);
  assert.deepEqual(leaves.map((l) => l.taskType), ['senior:plan', 'senior:feature']);
  assert.equal(leaves[0].process, 'feature');
});

test('scanAgentTaskLeaves preserves the raw colon-named job type verbatim', () => {
  const xml = model('review', [
    { id: 'r', type: 'senior:pr-review', external: true },
  ]);
  assert.deepEqual(
    scanAgentTaskLeaves(xml, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:pr-review'],
  );
});

// Single-convention behaviour change (issue #235): a prompt-bearing task WITHOUT
// the external marker is no longer auto-discovered — the prompt link alone is not
// the auto-discovery signal.
test('scanAgentTaskLeaves ignores a prompt-linked task without the external marker', () => {
  const xml = model('feature', [
    { id: 'impl', type: 'senior:feature', agentic: true },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml, scanTaskDefinitions), []);
});

// Opt-out namespace (issue #235): an external agent task marked
// `autoSubscribe="false"` is excluded from `--auto`; its external sibling stays.
test('scanAgentTaskLeaves excludes an external task marked autoSubscribe=false', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', external: true },
    { id: 'special', type: 'senior:special', external: true, optOut: true },
  ]);
  assert.deepEqual(
    scanAgentTaskLeaves(xml, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:plan'],
  );
});

// Fail-safe: only the literal `value="false"` opts out — any other value (or a
// malformed one) still auto-subscribes.
test('scanAgentTaskLeaves treats an autoSubscribe value other than false as opted-in', () => {
  const withTrue = `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://x" xmlns:zeebe="http://y"><bpmn:process id="feature" isExecutable="true"><bpmn:serviceTask id="a"><bpmn:extensionElements><zeebe:taskDefinition type="senior:a" /><zeebe:agentDefinition agentType="external" /><zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="true" /></bpmn:extensionElements></bpmn:serviceTask></bpmn:process></bpmn:definitions>`;
  assert.deepEqual(
    scanAgentTaskLeaves(withTrue, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:a'],
  );
});

// Reversed attribute order (`value` before `name`) must still opt out.
test('scanAgentTaskLeaves tolerates reversed autoSubscribe property attribute order', () => {
  const reversed = `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://x" xmlns:zeebe="http://y"><bpmn:process id="feature" isExecutable="true"><bpmn:serviceTask id="a"><bpmn:extensionElements><zeebe:taskDefinition type="senior:a" /><zeebe:agentDefinition agentType="external" /><zeebe:property value="false" name="io.nanobpm.agentTask.autoSubscribe" /></bpmn:extensionElements></bpmn:serviceTask></bpmn:process></bpmn:definitions>`;
  assert.deepEqual(scanAgentTaskLeaves(reversed, scanTaskDefinitions), []);
});

// Forward-compatible: a package-supplied `leaf.external` flag is honoured even
// without the local marker scan (the coordination point with `@nanobpm/agentic`).
test('scanAgentTaskLeaves honours a package-supplied leaf.external flag', () => {
  const fakeScan = () => [
    { elementId: 'a', taskType: 'senior:a', process: 'p', external: true },
    { elementId: 'b', taskType: 'plain:worker', process: 'p', external: false },
  ];
  assert.deepEqual(
    scanAgentTaskLeaves('<definitions/>', fakeScan).map((l) => l.taskType),
    ['senior:a'],
  );
});

test('serviceTaskIsExternalAgent matches only agentType="external"', () => {
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition agentType="external" />'), true);
  assert.equal(serviceTaskIsExternalAgent("<zeebe:agentDefinition agentType='external'/>"), true);
  assert.equal(serviceTaskIsExternalAgent('<agentDefinition agentType="external">'), true);
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition agentType="internal" />'), false);
  assert.equal(serviceTaskIsExternalAgent('<zeebe:taskDefinition type="x" />'), false);
  assert.equal(serviceTaskIsExternalAgent(''), false);
  assert.equal(serviceTaskIsExternalAgent(null), false);
});

test('externalAgentElementIds collects the marked service-task ids only', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', external: true },
    { id: 'record', type: 'pr.record-plan' },
    { id: 'impl', type: 'senior:feature', external: true },
  ]);
  assert.deepEqual([...externalAgentElementIds(xml)].sort(), ['impl', 'plan']);
  assert.equal(externalAgentElementIds('<definitions/>').size, 0);
});

test('serviceTaskOptsOutOfAutoSubscribe only fires on the exact false value', () => {
  const prop = (v) => `<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="${v}" />`;
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(prop('false')), true);
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(prop('true')), false);
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(prop('')), false);
  assert.equal(serviceTaskOptsOutOfAutoSubscribe('<zeebe:property name="other" value="false" />'), false);
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(''), false);
});

test('autoSubscribeOptOutElementIds collects opted-out service-task ids only', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', external: true },
    { id: 'special', type: 'senior:special', external: true, optOut: true },
  ]);
  assert.deepEqual([...autoSubscribeOptOutElementIds(xml)], ['special']);
});

test('readDeployedAgentJobTypes reads all defs, distinct + first-occurrence order', async () => {
  const reader = memReader({
    '1': model('feature', [
      { id: 'plan', type: 'senior:plan', external: true },
      { id: 'impl', type: 'senior:feature', external: true },
      { id: 'rec', type: 'pr.record-plan' },
    ]),
    '2': model('review', [
      // duplicate senior:plan across defs → de-duped
      { id: 'plan2', type: 'senior:plan', external: true },
      { id: 'rev', type: 'senior:pr-review', external: true },
    ]),
  });
  const types = await readDeployedAgentJobTypes(reader);
  assert.deepEqual(types, ['senior:plan', 'senior:feature', 'senior:pr-review']);
});

test('readDeployedAgentJobTypes drops autoSubscribe=false leaves from --auto', async () => {
  const reader = memReader({
    '1': model('feature', [
      { id: 'plan', type: 'senior:plan', external: true },
      { id: 'special', type: 'senior:special', external: true, optOut: true },
    ]),
  });
  assert.deepEqual(await readDeployedAgentJobTypes(reader), ['senior:plan']);
});

test('readDeployedAgentJobTypes with a scope narrows to a process-id prefix', async () => {
  const reader = memReader({
    '1': model('app-a-feature', [
      { id: 'plan', type: 'a:plan', external: true },
    ]),
    '2': model('app-b-feature', [
      { id: 'plan', type: 'b:plan', external: true },
    ]),
  });
  assert.deepEqual(await readDeployedAgentJobTypes(reader, { scope: 'app-a' }), ['a:plan']);
  assert.deepEqual(await readDeployedAgentJobTypes(reader, { scope: 'app-b-feature' }), ['b:plan']);
  assert.deepEqual((await readDeployedAgentJobTypes(reader, { scope: 'app' })).sort(), ['a:plan', 'b:plan']);
});

test('resolveAutoJobTypes drives the read through an injected reader factory (no engine)', async () => {
  let built = 0;
  const readerFactory = () => {
    built += 1;
    return memReader({
      '1': model('feature', [
        { id: 'plan', type: 'senior:plan', external: true },
        { id: 'rec', type: 'pr.record-plan' },
      ]),
    });
  };
  const types = await resolveAutoJobTypes({ readerFactory });
  assert.equal(built, 1);
  assert.deepEqual(types, ['senior:plan']);
});

test('resolveAutoJobTypes surfaces engine-read failure (so the caller can KEEP the running set)', async () => {
  const readerFactory = () => ({
    async searchProcessDefinitionKeys() { throw new Error('engine unreachable'); },
    async getProcessDefinitionXml() { return ''; },
  });
  await assert.rejects(resolveAutoJobTypes({ readerFactory }), /engine unreachable/);
});

test('resolveAutoJobTypes rejects on a stalled engine read (time-bounded so shutdown never hangs)', async () => {
  const readerFactory = () => ({
    // Never settles — models an engine REST call that stalls indefinitely.
    searchProcessDefinitionKeys() { return new Promise(() => {}); },
    async getProcessDefinitionXml() { return ''; },
  });
  await assert.rejects(
    resolveAutoJobTypes({ readerFactory, timeoutMs: 20 }),
    /engine read timed out after 20ms/,
  );
});
