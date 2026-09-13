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

// Regression (PR #242 review): the retired legacy `io.nanobpm.agentTask.*`
// task-header path is NOT a discovery signal. A task carrying ONLY legacy
// agent-task headers (and NO external marker) must be ignored — proving the
// single-convention switch (issue #235) did not silently keep the old
// header-fallback detection alive.
test('scanAgentTaskLeaves ignores a task with only legacy io.nanobpm.agentTask headers', () => {
  const xml =
    '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://x" xmlns:zeebe="http://y">' +
    '<bpmn:process id="feature" isExecutable="true">' +
    '<bpmn:serviceTask id="legacy"><bpmn:extensionElements>' +
    '<zeebe:taskDefinition type="senior:feature" />' +
    '<zeebe:taskHeaders>' +
    '<zeebe:header key="io.nanobpm.agentTask.prompt" value="do the thing" />' +
    '<zeebe:header key="io.nanobpm.agentTask.rank" value="senior" />' +
    '</zeebe:taskHeaders>' +
    '</bpmn:extensionElements></bpmn:serviceTask>' +
    '</bpmn:process></bpmn:definitions>';
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

// Regression (PR #242 review): a package-supplied `leaf.external === false` is
// AUTHORITATIVE — it must exclude the leaf even when the local XML scan sees the
// external marker, so an explicit non-external classification is not overridden
// by the fallback.
test('scanAgentTaskLeaves treats leaf.external=false as authoritative over a local marker', () => {
  // Local XML carries the external marker for element `a`...
  const xml = model('feature', [{ id: 'a', type: 'senior:a', external: true }]);
  // ...but the package classifies `a` as explicitly non-external.
  const fakeScan = () => [
    { elementId: 'a', taskType: 'senior:a', process: 'feature', external: false },
  ];
  assert.deepEqual(scanAgentTaskLeaves(xml, fakeScan), []);
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

test('serviceTaskIsExternalAgent is case-sensitive on the literal "external" value', () => {
  // XML attribute values are case-sensitive and the convention specifies the
  // literal `external`; a noncanonical spelling must NOT auto-enrol.
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition agentType="External" />'), false);
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition agentType="EXTERNAL" />'), false);
});

test('serviceTaskIsExternalAgent rejects hyphen-suffixed elements and prefixed agentType', () => {
  // Boundaries are XML whitespace / tag termination, NOT `\b`: a foreign element
  // `agentDefinition-extra` or a prefixed attribute `other:agentType` must NOT
  // satisfy the canonical marker and auto-enrol a non-conforming task.
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition-extra agentType="external" />'), false);
  assert.equal(serviceTaskIsExternalAgent('<agentDefinition-extra agentType="external" />'), false);
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition other:agentType="external" />'), false);
  // …but the canonical unqualified `agentType` on the exact element still matches.
  assert.equal(serviceTaskIsExternalAgent('<zeebe:agentDefinition foo="1" agentType="external" />'), true);
});

test('serviceTaskIsExternalAgent ignores agentType nested inside another attribute value', () => {
  // Quote-aware (PR #242 review): `agentType='external'` embedded in a
  // `description` value is NOT a real attribute and must NOT be treated as the
  // canonical marker — otherwise a non-conforming task auto-enrols.
  assert.equal(
    serviceTaskIsExternalAgent(`<zeebe:agentDefinition description="text agentType='external'" />`),
    false,
  );
  // …but a REAL `agentType="external"` alongside such a decoy value still matches.
  assert.equal(
    serviceTaskIsExternalAgent(
      `<zeebe:agentDefinition description="x agentType='nope'" agentType="external" />`,
    ),
    true,
  );
});

test('serviceTaskIsExternalAgent ignores a marker inside an XML comment or CDATA', () => {
  const commented = '<!-- <zeebe:agentDefinition agentType="external" /> -->';
  const cdata = '<![CDATA[ <zeebe:agentDefinition agentType="external" /> ]]>';
  // Raw predicate still matches inert text (it is comment-agnostic); the id scan
  // strips comments/CDATA first, so a commented-out marker never auto-enrols.
  assert.equal(externalAgentElementIds(`<bpmn:serviceTask id="t">${commented}</bpmn:serviceTask>`).size, 0);
  assert.equal(externalAgentElementIds(`<bpmn:serviceTask id="t">${cdata}</bpmn:serviceTask>`).size, 0);
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

test('serviceTaskOptsOutOfAutoSubscribe is not fooled by hyphen-suffixed attributes', () => {
  // `readXmlAttr` must anchor the key at a start/whitespace boundary, NOT a `\b`
  // boundary: `-` is non-word, so a `\b`-based read would treat `other-name`/
  // `other-value` as the canonical `name`/`value` and misclassify the property.
  const decoy = '<zeebe:property other-name="io.nanobpm.agentTask.autoSubscribe" other-value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(decoy), false);
});

test('serviceTaskOptsOutOfAutoSubscribe ignores name/value nested inside another attribute value', () => {
  // Quote-aware (PR #242 review): a decoy attribute whose VALUE contains
  // `name='io.nanobpm.agentTask.autoSubscribe' value='false'` must NOT opt the
  // task out — those are text inside another attribute's value, not real
  // attributes, so the fail-safe (stay auto-subscribed) holds.
  const decoy =
    `<zeebe:property meta="name='io.nanobpm.agentTask.autoSubscribe' value='false'" />`;
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(decoy), false);
  // The real, un-nested attributes still opt out.
  const real = '<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(real), true);
});

test('serviceTaskOptsOutOfAutoSubscribe is not fooled by a hyphen-suffixed property element', () => {
  // The property scan anchors on `property(?=[\s/>])`, NOT `property\b`: a foreign
  // `<zeebe:property-extra …>` carrying the same name/value attributes must NOT
  // opt a task out of `--auto`.
  const decoy =
    '<zeebe:property-extra name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(decoy), false);
  // The exact element still opts out.
  const real = '<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(real), true);
});

test('serviceTaskOptsOutOfAutoSubscribe is case-sensitive on the property element name', () => {
  // The property scan is compiled WITHOUT the `i` flag: XML element names are
  // case-sensitive and the convention specifies the literal `property`, so a
  // non-canonical `<zeebe:Property …>` must NOT opt a task out of `--auto`.
  const upper = '<zeebe:Property name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(upper), false);
  const allCaps = '<zeebe:PROPERTY name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(allCaps), false);
  // The exact lowercase element still opts out.
  const real = '<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />';
  assert.equal(serviceTaskOptsOutOfAutoSubscribe(real), true);
});

test('serviceTaskElementIds is not truncated by an inert </serviceTask> in a comment/CDATA', () => {
  // The task-body capture is non-greedy, so a fake `</serviceTask>` inside a
  // comment or CDATA would truncate the body at that inert close and hide a real
  // marker/property that follows. The whole document is stripped BEFORE matching,
  // so the real marker/property later in the same task is still seen.
  const commentedClose =
    '<bpmn:serviceTask id="t">' +
    '<!-- </bpmn:serviceTask> -->' +
    '<zeebe:agentDefinition agentType="external" />' +
    '</bpmn:serviceTask>';
  assert.deepEqual([...externalAgentElementIds(commentedClose)], ['t']);
  const cdataClose =
    '<bpmn:serviceTask id="t">' +
    '<![CDATA[ </bpmn:serviceTask> ]]>' +
    '<zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />' +
    '</bpmn:serviceTask>';
  assert.deepEqual([...autoSubscribeOptOutElementIds(cdataClose)], ['t']);
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
