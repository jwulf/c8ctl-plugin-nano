// Unit/integration tests for the `set`/`unset` config commands. These drive the
// real config read/write helpers against an isolated C8CTL_NANO_HOME temp dir,
// so they exercise the on-disk config.json round-trip without touching the
// operator's real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  unsetConfig,
  readConfig,
  writeConfig,
  getConfigFile,
  SETTING_ALIASES,
} from './c8ctl-plugin.js';

// Silence the plugin's logger so test output stays clean.
globalThis.c8ctl = {
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
};

function withHome(fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'c8ctl-cfg-'));
  const prevHome = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = HOME;
  try {
    return fn(HOME);
  } finally {
    if (prevHome === undefined) delete process.env.C8CTL_NANO_HOME;
    else process.env.C8CTL_NANO_HOME = prevHome;
    rmSync(HOME, { recursive: true, force: true });
  }
}

test('SETTING_ALIASES maps bin and model-dir to the config fields', () => {
  assert.equal(SETTING_ALIASES.bin, 'binary');
  assert.equal(SETTING_ALIASES.binary, 'binary');
  assert.equal(SETTING_ALIASES['model-dir'], 'workspaceDir');
  assert.equal(SETTING_ALIASES.workspace, 'workspaceDir');
});

test('unset bin removes a configured binary path', () => {
  withHome((HOME) => {
    // Seed a pinned binary that exists on disk (source "configured").
    const bin = join(HOME, 'fake-server');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    writeConfig({ binary: bin });
    assert.equal(readConfig().binary, bin);

    unsetConfig({ positional: ['bin'] });

    assert.equal('binary' in readConfig(), false);
  });
});

test('unset model-dir removes a configured workspace dir', () => {
  withHome((HOME) => {
    writeConfig({ workspaceDir: join(HOME, 'ws') });
    assert.equal(typeof readConfig().workspaceDir, 'string');

    unsetConfig({ positional: ['model-dir'] });

    assert.equal('workspaceDir' in readConfig(), false);
  });
});

test('unset preserves unrelated config fields', () => {
  withHome((HOME) => {
    const bin = join(HOME, 'fake-server');
    writeFileSync(bin, '#!/bin/sh\n');
    writeConfig({ binary: bin, workspaceDir: join(HOME, 'ws') });

    unsetConfig({ positional: ['bin'] });

    const cfg = readConfig();
    assert.equal('binary' in cfg, false);
    assert.equal(cfg.workspaceDir, join(HOME, 'ws'));
  });
});

test('unset is idempotent when the field is not set', () => {
  withHome(() => {
    // No config seeded — nothing to clear, must not throw or write garbage.
    unsetConfig({ positional: ['bin'] });
    assert.deepEqual(readConfig(), {});
  });
});

test('unset with an unknown key exits non-zero and writes nothing', () => {
  withHome(() => {
    writeFileSync(getConfigFile(), JSON.stringify({ binary: '/keep/me' }));
    const prevExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    try {
      assert.throws(() => unsetConfig({ positional: ['bogus'] }), /__exit__/);
    } finally {
      process.exit = prevExit;
    }
    assert.equal(exitCode, 1);
    // Config untouched.
    assert.equal(readConfig().binary, '/keep/me');
  });
});

test('unset with no key exits non-zero', () => {
  withHome(() => {
    const prevExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    try {
      assert.throws(() => unsetConfig({ positional: [] }), /__exit__/);
    } finally {
      process.exit = prevExit;
    }
    assert.equal(exitCode, 1);
  });
});

test('unset rejects inherited object keys (toString / __proto__)', () => {
  withHome(() => {
    writeFileSync(getConfigFile(), JSON.stringify({ binary: '/keep/me' }));
    for (const bogus of ['toString', '__proto__', 'hasOwnProperty']) {
      const prevExit = process.exit;
      let exitCode;
      process.exit = (code) => {
        exitCode = code;
        throw new Error('__exit__');
      };
      try {
        assert.throws(() => unsetConfig({ positional: [bogus] }), /__exit__/, bogus);
      } finally {
        process.exit = prevExit;
      }
      assert.equal(exitCode, 1, `${bogus} should be rejected`);
    }
    assert.equal(readConfig().binary, '/keep/me');
  });
});
