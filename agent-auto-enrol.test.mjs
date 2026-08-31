// Unit tests for `nano work --auto`: zero-config engine-read enrolment
// (jwulf/c8ctl-plugin-nano#66). Agent-task discovery derives agentic-ness
// primarily from `@nanobpm/agentic`'s `demand.scanTaskDefinitions` canonical
// `agentic` flag (issue #102) — a service task is an agent task iff it declares a
// `<zeebe:linkedResource … linkName="prompt">` base-prompt side-car — with a
// legacy fallback for tasks carrying an `io.nanobpm.agentTask` header
// (`serviceTaskHasAgentHeader` / `legacyAgentHeaderElementIds`, issue #120). Plain
// connectors and record-keepers (e.g. `pr.record-plan`) carry neither signal and
// are excluded. The engine read is driven through an in-memory C8RestReader seam
// so no live engine is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanAgentTaskLeaves,
  serviceTaskHasAgentHeader,
  readDeployedAgentJobTypes,
  resolveAutoJobTypes,
} from './c8ctl-plugin.js';
import { demand } from './agentic.mjs';

// The published detector this plugin consumes — injected into `scanAgentTaskLeaves`
// exactly as `readDeployedAgentJobTypes` supplies it at runtime.
const { scanTaskDefinitions } = demand;

// A minimal deployed-model builder: one bpmn:process with the given service
// tasks. Each task is `{ id, type, agentic?: bool, noTaskDef?: bool }`. An
// `agentic` task declares a `linkName="prompt"` linked resource (the canonical
// agent-task marker); a non-agentic task omits it (a plain connector /
// record-keeper).
function model(processId, tasks) {
  const body = tasks
    .map((t) => {
      const td = t.noTaskDef ? '' : `<zeebe:taskDefinition type="${t.type}" />`;
      const link = t.agentic
        ? '<zeebe:linkedResources><zeebe:linkedResource resourceId="p" linkName="prompt" /></zeebe:linkedResources>'
        : '';
      return `<bpmn:serviceTask id="${t.id}"><bpmn:extensionElements>${td}${link}</bpmn:extensionElements></bpmn:serviceTask>`;
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

// A legacy (pre-nano-workforce#203) agent service task: the prompt lived in an
// `io.nanobpm.agentTask.*` <zeebe:header>, NOT a linkName="prompt" linked
// resource. `linkName` other than `prompt` is a non-agent side-car.
function legacyModel(processId, tasks) {
  const body = tasks
    .map((t) => {
      const td = t.noTaskDef ? '' : `<zeebe:taskDefinition type="${t.type}" />`;
      const hdr = t.legacy
        ? '<zeebe:taskHeaders><zeebe:header key="io.nanobpm.agentTask.task.prompt" value="{{feature}}" /></zeebe:taskHeaders>'
        : '';
      const link = t.linkName
        ? `<zeebe:linkedResources><zeebe:linkedResource resourceId="p" linkName="${t.linkName}" /></zeebe:linkedResources>`
        : '';
      return `<bpmn:serviceTask id="${t.id}"><bpmn:extensionElements>${td}${hdr}${link}</bpmn:extensionElements></bpmn:serviceTask>`;
    })
    .join('');
  return `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://x" xmlns:zeebe="http://y"><bpmn:process id="${processId}" isExecutable="true">${body}</bpmn:process></bpmn:definitions>`;
}

test('scanAgentTaskLeaves keeps only prompt-linked service tasks with a task type', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', agentic: true },
    { id: 'impl', type: 'senior:feature', agentic: true },
    // record-keeper: has a task definition but NO prompt link → excluded.
    { id: 'record', type: 'pr.record-plan' },
    // prompt link but no task definition → excluded (nothing to route).
    { id: 'broken', agentic: true, noTaskDef: true },
  ]);
  const leaves = scanAgentTaskLeaves(xml, scanTaskDefinitions);
  assert.deepEqual(leaves.map((l) => l.taskType), ['senior:plan', 'senior:feature']);
  assert.equal(leaves[0].process, 'feature');
});

test('scanAgentTaskLeaves preserves the raw colon-named job type verbatim', () => {
  const xml = model('review', [
    { id: 'r', type: 'senior:pr-review', agentic: true },
  ]);
  assert.deepEqual(
    scanAgentTaskLeaves(xml, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:pr-review'],
  );
});

// Legacy header backward compatibility (issue #120): a pre-#203 deployment still
// marks agent tasks with an `io.nanobpm.agentTask.*` header instead of a prompt
// linked resource. The package flag reports agentic:false for those, so
// scanAgentTaskLeaves must still detect them via the legacy-header fallback.
test('scanAgentTaskLeaves detects legacy io.nanobpm.agentTask-header agent tasks (backward compat)', () => {
  const xml = legacyModel('feature', [
    { id: 'impl', type: 'senior:feature', legacy: true },
    { id: 'record', type: 'pr.record-plan' },
  ]);
  assert.deepEqual(
    scanAgentTaskLeaves(xml, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:feature'],
  );
});

test('scanAgentTaskLeaves ignores a linked resource whose linkName is not "prompt"', () => {
  const xml = legacyModel('feature', [
    { id: 'x', type: 'senior:feature', linkName: 'other' },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml, scanTaskDefinitions), []);
});

test('scanAgentTaskLeaves skips a legacy-header task that has no task definition', () => {
  const xml = legacyModel('feature', [
    { id: 'broken', legacy: true, noTaskDef: true },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml, scanTaskDefinitions), []);
});

test('scanAgentTaskLeaves emits a task matched by BOTH prompt link and legacy header once', () => {
  const xml = legacyModel('feature', [
    { id: 'impl', type: 'senior:feature', legacy: true, linkName: 'prompt' },
  ]);
  assert.deepEqual(
    scanAgentTaskLeaves(xml, scanTaskDefinitions).map((l) => l.taskType),
    ['senior:feature'],
  );
});

test('serviceTaskHasAgentHeader matches only the io.nanobpm.agentTask header', () => {
  assert.equal(
    serviceTaskHasAgentHeader('<zeebe:header key="io.nanobpm.agentTask.task.prompt" value="x" />'),
    true,
  );
  assert.equal(serviceTaskHasAgentHeader('<zeebe:header key="io.nanobpm.agentTask" value="x" />'), true);
  assert.equal(serviceTaskHasAgentHeader('<zeebe:header key="retryBackoff" value="x" />'), false);
  assert.equal(serviceTaskHasAgentHeader(''), false);
  assert.equal(serviceTaskHasAgentHeader(null), false);
});

test('readDeployedAgentJobTypes reads all defs, distinct + first-occurrence order', async () => {
  const reader = memReader({
    '1': model('feature', [
      { id: 'plan', type: 'senior:plan', agentic: true },
      { id: 'impl', type: 'senior:feature', agentic: true },
      { id: 'rec', type: 'pr.record-plan' },
    ]),
    '2': model('review', [
      // duplicate senior:plan across defs → de-duped
      { id: 'plan2', type: 'senior:plan', agentic: true },
      { id: 'rev', type: 'senior:pr-review', agentic: true },
    ]),
  });
  const types = await readDeployedAgentJobTypes(reader);
  assert.deepEqual(types, ['senior:plan', 'senior:feature', 'senior:pr-review']);
});

test('readDeployedAgentJobTypes with a scope narrows to a process-id prefix', async () => {
  const reader = memReader({
    '1': model('app-a-feature', [
      { id: 'plan', type: 'a:plan', agentic: true },
    ]),
    '2': model('app-b-feature', [
      { id: 'plan', type: 'b:plan', agentic: true },
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
        { id: 'plan', type: 'senior:plan', agentic: true },
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
