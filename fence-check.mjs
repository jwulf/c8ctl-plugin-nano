#!/usr/bin/env node
// Issue #320: `node "$NANO_FENCE_CHECK"` — exit 0 held, 1 lost (fence written),
// 75 unknown (retry). See nano-fence.mjs.
import { runFenceCheck } from './nano-fence.mjs';

const { code, message } = await runFenceCheck();
(code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
process.exit(code);
