import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import {
  makeSecretResolver,
  resolveJobSecrets,
  parseSecretsFileContent,
  readSecretsFile,
  writeSecretsFile,
  defaultSecretsFilePath,
  formatMissingSecretsMessage,
  supervisorSecretCmd,
  normalizeTaskEnvelope,
} from './c8ctl-plugin.js';

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nano-secrets-test-'));
  const prev = process.env.C8CTL_NANO_HOME;
  process.env.C8CTL_NANO_HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) delete process.env.C8CTL_NANO_HOME;
      else process.env.C8CTL_NANO_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    });
}

test('parseSecretsFileContent parses dotenv (comments, export, quotes, escapes) and JSON', () => {
  const dotenv = parseSecretsFileContent(`
    # comment
    GITHUB_TOKEN="ghp_abc\\n123"
    export NPM_TOKEN='npm_xyz'
    PLAIN_KEY=plain_val
    EMPTY_KEY=
    123INVALID=skip
  `);
  assert.deepEqual(dotenv, {
    GITHUB_TOKEN: 'ghp_abc\n123',
    NPM_TOKEN: 'npm_xyz',
    PLAIN_KEY: 'plain_val',
  });

  const json = parseSecretsFileContent(JSON.stringify({
    GITHUB_TOKEN: 'ghp_json',
    EMPTY: '',
    NUM: 42,
  }));
  assert.deepEqual(json, { GITHUB_TOKEN: 'ghp_json' });
});

test('makeSecretResolver supports host, file, file:<path> and rejects unknown/empty file:', async () => {
  await withTempHome((dir) => {
    assert.equal(makeSecretResolver('host').kind, 'host');
    assert.equal(makeSecretResolver(undefined).kind, 'host');

    const defaultFile = makeSecretResolver('file');
    assert.ok(defaultFile);
    assert.equal(defaultFile.filePath, join(dir, 'secrets.env'));

    const customPath = join(dir, 'custom.env');
    const customFile = makeSecretResolver(`file:${customPath}`);
    assert.ok(customFile);
    assert.equal(customFile.filePath, customPath);

    assert.equal(makeSecretResolver('file:'), null);
    assert.equal(makeSecretResolver('vault'), null);
  });
});

test('file secret resolver reads dotenv and JSON files, picks up rotations live, and warns once on loose perms', async () => {
  await withTempHome((dir) => {
    const filePath = join(dir, 'custom.env');
    writeFileSync(filePath, 'GITHUB_TOKEN=ghp_first\n', { mode: 0o644 });
    if (process.platform !== 'win32') chmodSync(filePath, 0o644);

    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), info() {}, error() {} };
    const resolver = makeSecretResolver(`file:${filePath}`, { logger });

    assert.equal(resolver.resolve('GITHUB_TOKEN'), 'ghp_first');
    assert.equal(resolver.resolve('MISSING'), undefined);

    // Rotation on disk is picked up without recreating the resolver.
    writeFileSync(filePath, JSON.stringify({ GITHUB_TOKEN: 'ghp_rotated' }), { mode: 0o644 });
    assert.equal(resolver.resolve('GITHUB_TOKEN'), 'ghp_rotated');

    if (process.platform !== 'win32') {
      assert.equal(warnings.filter((w) => w.includes('chmod 600')).length, 1, 'warns once on loose permissions');
    }
  });
});

test('host secret resolver falls back to <stateHome>/secrets.env when process.env is unset (issue #266)', async () => {
  await withTempHome(async () => {
    const prevTok = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const secretsPath = defaultSecretsFilePath();
      writeSecretsFile(secretsPath, { GITHUB_TOKEN: 'ghp_from_file', EXTRA: 'val' });
      if (process.platform !== 'win32') {
        assert.equal(statSync(secretsPath).mode & 0o777, 0o600, 'writeSecretsFile enforces chmod 600');
      }

      const resolver = makeSecretResolver('host');
      const env = normalizeTaskEnvelope({}, {
        'io.nanobpm.agentTask': {
          setup: { secretRefs: ['GITHUB_TOKEN', 'EXTRA'] },
          task: { allowPr: true },
          repository: { url: 'https://github.com/org/repo' },
        },
      });
      const { resolved, missing } = await resolveJobSecrets(resolver, env, {
        ghAuthToken: () => null,
        forceRefreshGhAuthToken: async () => null,
      });
      assert.deepEqual(missing, []);
      assert.equal(resolved.GITHUB_TOKEN, 'ghp_from_file');
      assert.equal(resolved.EXTRA, 'val');

      // process.env still takes precedence over secrets.env when set.
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      assert.equal(resolver.resolve('GITHUB_TOKEN'), 'ghp_from_env');
    } finally {
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
    }
  });
});

test('supervisorSecretCmd supports set (stdin & arg), list (no values leaked), unset, and path', async () => {
  await withTempHome(async (dir) => {
    const filePath = join(dir, 'secrets.env');
    const logs = [];
    const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

    // set via stdin
    const stdin = Readable.from(['ghp_super_secret_token\n']);
    stdin.isTTY = false;
    await supervisorSecretCmd(['set', 'GITHUB_TOKEN'], { filePath, stdin, logger });
    assert.equal(readSecretsFile(filePath).secrets.GITHUB_TOKEN, 'ghp_super_secret_token');

    // set second key via arg
    await supervisorSecretCmd(['set', 'ANOTHER_KEY', 'val_2'], { filePath, logger });

    // list prints names only, never values
    logs.length = 0;
    await supervisorSecretCmd(['list'], { filePath, logger });
    const joined = logs.join('\n');
    assert.match(joined, /GITHUB_TOKEN/);
    assert.match(joined, /ANOTHER_KEY/);
    assert.doesNotMatch(joined, /ghp_super_secret_token/);
    assert.doesNotMatch(joined, /val_2/);

    // path prints filePath
    logs.length = 0;
    await supervisorSecretCmd(['path'], { filePath, logger });
    assert.equal(logs[0], filePath);

    // unset removes key
    await supervisorSecretCmd(['unset', 'GITHUB_TOKEN'], { filePath, logger });
    assert.equal(readSecretsFile(filePath).secrets.GITHUB_TOKEN, undefined);
    assert.equal(readSecretsFile(filePath).secrets.ANOTHER_KEY, 'val_2');
  });
});

test('formatMissingSecretsMessage explains GITHUB_TOKEN failure and gives actionable remediation (#266)', async () => {
  await withTempHome(() => {
    const prevTok = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const resolver = makeSecretResolver('host');
      const msg = formatMissingSecretsMessage(['GITHUB_TOKEN'], resolver);
      assert.match(msg, /missing secret\(s\): GITHUB_TOKEN \(resolver: host\)/);
      assert.match(msg, /GITHUB_TOKEN env unset/);
      assert.match(msg, /gh auth token unavailable\/keyring locked/);
      assert.match(msg, /c8ctl nano supervisor secret set GITHUB_TOKEN/);

      const otherMsg = formatMissingSecretsMessage(['CUSTOM_API_KEY'], resolver);
      assert.equal(otherMsg, 'missing secret(s): CUSTOM_API_KEY (resolver: host)');
    } finally {
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
    }
  });
});
