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
  scanAgentTaskLeaves,
  readDeployedAgentJobTypes,
  resolveAutoJobTypes,
  AGENT_TASK_NS,
} from './c8ctl-plugin.js';

// A minimal deployed-model builder: one bpmn:process with the given service
// tasks. Each task is `{ id, type, headers?: [key,...], noTaskDef?: bool }`.
function model(processId, tasks) {
  const body = tasks
    .map((t) => {
      const td = t.noTaskDef ? '' : `<zeebe:taskDefinition type="${t.type}" />`;
      const headers = (t.headers && t.headers.length)
        ? `<zeebe:taskHeaders>${t.headers.map((k) => `<zeebe:header key="${k}" value="x" />`).join('')}</zeebe:taskHeaders>`
        : '';
      return `<bpmn:serviceTask id="${t.id}"><bpmn:extensionElements>${td}${headers}</bpmn:extensionElements></bpmn:serviceTask>`;
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
