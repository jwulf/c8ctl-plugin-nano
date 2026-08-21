// Unit tests for `nano work --auto`: zero-config engine-read enrolment
// (jwulf/c8ctl-plugin-nano#66). The demand scanner is extended to read
// `zeebe:taskHeaders` so only *agent* service tasks (those carrying an
// `io.nanobpm.agentTask.` header) are served — plain connectors and
// record-keepers (e.g. `pr.record-plan`) are excluded. The engine read is
// driven through an in-memory C8RestReader seam so no live engine is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serviceTaskHasAgentHeader,
  serviceTaskHasLinkedPrompt,
  serviceTaskIsAgentTask,
  scanAgentTaskLeaves,
  readDeployedAgentJobTypes,
  resolveAutoJobTypes,
  AGENT_TASK_NS,
} from './c8ctl-plugin.js';

// A minimal deployed-model builder: one bpmn:process with the given service
// tasks. Each task is `{ id, type, headers?: [key,...], linkedPrompt?: bool,
// noTaskDef?: bool }`. `linkedPrompt` emits the current canonical agent-task
// marker (`<zeebe:linkedResource … linkName="prompt">`) instead of a header.
function model(processId, tasks) {
  const body = tasks
    .map((t) => {
      const td = t.noTaskDef ? '' : `<zeebe:taskDefinition type="${t.type}" />`;
      const headers = (t.headers && t.headers.length)
        ? `<zeebe:taskHeaders>${t.headers.map((k) => `<zeebe:header key="${k}" value="x" />`).join('')}</zeebe:taskHeaders>`
        : '';
      const linked = t.linkedPrompt
        ? `<zeebe:linkedResources><zeebe:linkedResource resourceId="${t.id}.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" /></zeebe:linkedResources>`
        : '';
      return `<bpmn:serviceTask id="${t.id}"><bpmn:extensionElements>${td}${headers}${linked}</bpmn:extensionElements></bpmn:serviceTask>`;
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

test('serviceTaskHasAgentHeader matches the agent-task namespace, exact or dotted', () => {
  assert.equal(serviceTaskHasAgentHeader(`<zeebe:header key="${AGENT_TASK_NS}.task.prompt" value="x"/>`), true);
  assert.equal(serviceTaskHasAgentHeader(`<zeebe:header key="${AGENT_TASK_NS}" value="{}"/>`), true);
  // A near-miss namespace must NOT match (no dot boundary).
  assert.equal(serviceTaskHasAgentHeader(`<zeebe:header key="${AGENT_TASK_NS}Extra" value="x"/>`), false);
  // A plain record-keeper header is not an agent header.
  assert.equal(serviceTaskHasAgentHeader('<zeebe:header key="recordType" value="plan"/>'), false);
  assert.equal(serviceTaskHasAgentHeader(''), false);
});

test('scanAgentTaskLeaves keeps only agent-headed service tasks with a task type', () => {
  const xml = model('feature', [
    { id: 'plan', type: 'senior:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
    { id: 'impl', type: 'senior:feature', headers: [`${AGENT_TASK_NS}.task.prompt`] },
    // record-keeper: has a task definition but NO agent header → excluded.
    { id: 'record', type: 'pr.record-plan', headers: ['recordType'] },
    // agent header but no task definition → excluded (nothing to route).
    { id: 'broken', headers: [`${AGENT_TASK_NS}.task.prompt`], noTaskDef: true },
  ]);
  const leaves = scanAgentTaskLeaves(xml);
  assert.deepEqual(leaves.map((l) => l.taskType), ['senior:plan', 'senior:feature']);
  assert.equal(leaves[0].process, 'feature');
});

test('scanAgentTaskLeaves preserves the raw colon-named job type verbatim', () => {
  const xml = model('review', [
    { id: 'r', type: 'senior:pr-review', headers: [`${AGENT_TASK_NS}.task.prompt`] },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml).map((l) => l.taskType), ['senior:pr-review']);
});

// jwulf/c8ctl-plugin-nano#95 — the current `@nanobpm/workflow` toolchain marks
// agent tasks with a `<zeebe:linkedResource … linkName="prompt">` binding, NOT an
// `io.nanobpm.agentTask` header, so header-only detection discovered 0 job types
// on every current nano-workforce deployment.
test('serviceTaskHasLinkedPrompt matches the linkName="prompt" binding', () => {
  assert.equal(
    serviceTaskHasLinkedPrompt('<zeebe:linkedResource resourceId="feature.md" resourceType="GenericScript" linkName="prompt" />'),
    true,
  );
  // Attribute order-independent (linkName first).
  assert.equal(serviceTaskHasLinkedPrompt('<zeebe:linkedResource linkName="prompt" resourceType="GenericScript" />'), true);
  // A non-prompt linked resource is not an agent marker.
  assert.equal(serviceTaskHasLinkedPrompt('<zeebe:linkedResource linkName="form" resourceType="Form" />'), false);
  assert.equal(serviceTaskHasLinkedPrompt(''), false);
});

test('serviceTaskIsAgentTask accepts EITHER the legacy header or the linked prompt', () => {
  assert.equal(serviceTaskIsAgentTask(`<zeebe:header key="${AGENT_TASK_NS}.task.prompt" value="x"/>`), true);
  assert.equal(serviceTaskIsAgentTask('<zeebe:linkedResource linkName="prompt" resourceType="GenericScript" />'), true);
  assert.equal(serviceTaskIsAgentTask('<zeebe:header key="recordType" value="plan"/>'), false);
});

test('scanAgentTaskLeaves discovers linked-prompt agent tasks with no agent header (#95)', () => {
  // Mirrors a current nano-workforce deployment: the senior:* task carries a
  // linked prompt and NO io.nanobpm.agentTask header; the record-keeper carries
  // neither and must stay excluded.
  const xml = model('feature', [
    { id: 'implement-task', type: 'senior:feature', linkedPrompt: true },
    { id: 'record', type: 'pr.record-feature' },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml).map((l) => l.taskType), ['senior:feature']);
});

test('scanAgentTaskLeaves discovers a mix of legacy-header and linked-prompt agent tasks', () => {
  const xml = model('mixed', [
    { id: 'legacy', type: 'senior:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
    { id: 'current', type: 'senior:pr-review', linkedPrompt: true },
    { id: 'rec', type: 'pr.record-plan', headers: ['recordType'] },
  ]);
  assert.deepEqual(scanAgentTaskLeaves(xml).map((l) => l.taskType), ['senior:plan', 'senior:pr-review']);
});

test('readDeployedAgentJobTypes reads all defs, distinct + first-occurrence order', async () => {
  const reader = memReader({
    '1': model('feature', [
      { id: 'plan', type: 'senior:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
      { id: 'impl', type: 'senior:feature', headers: [`${AGENT_TASK_NS}.task.prompt`] },
      { id: 'rec', type: 'pr.record-plan', headers: ['recordType'] },
    ]),
    '2': model('review', [
      // duplicate senior:plan across defs → de-duped
      { id: 'plan2', type: 'senior:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
      { id: 'rev', type: 'senior:pr-review', headers: [`${AGENT_TASK_NS}.task.prompt`] },
    ]),
  });
  const types = await readDeployedAgentJobTypes(reader);
  assert.deepEqual(types, ['senior:plan', 'senior:feature', 'senior:pr-review']);
});

test('readDeployedAgentJobTypes with a scope narrows to a process-id prefix', async () => {
  const reader = memReader({
    '1': model('app-a-feature', [
      { id: 'plan', type: 'a:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
    ]),
    '2': model('app-b-feature', [
      { id: 'plan', type: 'b:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
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
        { id: 'plan', type: 'senior:plan', headers: [`${AGENT_TASK_NS}.task.prompt`] },
        { id: 'rec', type: 'pr.record-plan', headers: ['recordType'] },
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
