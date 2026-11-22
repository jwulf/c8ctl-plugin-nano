// #331 review: the forced quiesce snapshot must fail CLOSED — a failed write
// must never be acked as `quiesced` (the successor would adopt a stale file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./c8ctl-plugin.js', import.meta.url), 'utf8');

test('persist reports write success/failure instead of swallowing it', () => {
  const body = src.slice(src.indexOf('const persist = (force = false) => {'), src.indexOf('const broadcast = (frame) =>'));
  assert.match(body, /return true;/);
  assert.match(body, /return false;/);
});

test('quiesce rolls back and refuses the handoff when the snapshot write fails', () => {
  assert.match(src, /if \(!persist\(true\)\) \{\s*rollbackFromUpgrade\(successorPid,[^)]*\);[\s\S]{0,300}UPGRADE_SNAPSHOT_FAILED/);
  assert.match(src, /err\.code === 'UPGRADE_SNAPSHOT_FAILED'\) \{ sock\.write\(encodeFrame\(\{ ok: false/);
  assert.match(src, /prep\.code === 'UPGRADE_SNAPSHOT_FAILED'/);
});
