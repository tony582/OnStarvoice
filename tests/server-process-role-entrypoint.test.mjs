import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntrypoint = path.join(repositoryRoot, 'server', 'index.js');
const entrypointGuard = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'process-role-entrypoint-guard.mjs',
);
const unreachableDatabaseUrl =
  'postgresql://p2b-entrypoint:p2b-entrypoint-secret@127.0.0.1:1/onstarvoice_test_p2b_entrypoint';

function runEntrypoint({ processRole, mediaDirectory }) {
  const env = {
    PATH: process.env.PATH || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C',
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    PORT: '0',
    DATABASE_URL: unreachableDatabaseUrl,
    PG_CONNECT_TIMEOUT_MS: '100',
    MEDIA_DIR: mediaDirectory,
  };
  if (processRole === undefined) delete env.PROCESS_ROLE;
  else env.PROCESS_ROLE = processRole;

  return spawnSync(process.execPath, [
    '--import',
    pathToFileURL(entrypointGuard).href,
    serverEntrypoint,
  ], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('production entrypoint rejects unsafe roles before database or background startup', async t => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2b-entrypoint-'));
  const mediaDirectory = path.join(tempDirectory, 'media-must-not-exist');
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));

  const cases = [
    {
      name: 'missing role',
      processRole: undefined,
      message: /PROCESS_ROLE must be explicitly set in production/u,
    },
    {
      name: 'empty role',
      processRole: '   ',
      message: /PROCESS_ROLE must not be empty/u,
    },
    {
      name: 'unknown role',
      processRole: 'worker',
      message: /PROCESS_ROLE is not one of the supported roles/u,
    },
    {
      name: 'future independent role',
      processRole: 'api',
      message: /independent role entrypoints are deferred to P2-C/u,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const result = runEntrypoint({
        processRole: scenario.processRole,
        mediaDirectory,
      });
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;

      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, output);
      assert.match(output, scenario.message);
      assert.match(output, /\[P2BTestGuard\] active/u);
      assert.doesNotMatch(output, /\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/u);
      assert.doesNotMatch(output, /p2b-entrypoint-secret/u);
      assert.doesNotMatch(output, /\[DB\]|\[Cron\]|Backend Server/u);
      assert.equal(existsSync(mediaDirectory), false);
    });
  }
});
