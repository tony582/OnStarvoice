import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPrivatePath,
  assertP2ehRoleLocks,
  assertRunId,
  credentialSafeText,
  isolatedEnvironment,
  nginxConfig,
  parseLocalDatabaseUrl,
  pm2Ecosystem,
  preflightSandbox,
  runCommand,
  waitFor,
  writePrivateFile,
} from '../scripts/lib/p2eh-local-runtime.mjs';

const runId = 'local_20260816_001';

test('run and database targets are exact, local, and query-free', () => {
  assert.equal(assertRunId(runId), runId);
  assert.throws(() => assertRunId('local-run'), /run id/u);
  const target = parseLocalDatabaseUrl(
    `postgresql://127.0.0.1:5432/onstarvoice_test_p2eh_${runId}`,
    { runId },
  );
  assert.equal(target.databaseName, `onstarvoice_test_p2eh_${runId}`);
  assert.throws(
    () => parseLocalDatabaseUrl('postgresql://db.example.com/onstarvoice_test_p2eh_local_20260816_001', { runId }),
    error => error.code === 'P2EH_DATABASE_NOT_LOOPBACK',
  );
  assert.throws(
    () => parseLocalDatabaseUrl(
      `postgresql://127.0.0.1/onstarvoice_test_p2eh_${runId}?host=example.com`,
      { runId },
    ),
    error => error.code === 'P2EH_DATABASE_URL_OPTIONS_FORBIDDEN',
  );
});

test('role-lock evidence rejects every unexpected advisory lock', () => {
  assert.doesNotThrow(() => assertP2ehRoleLocks([
    {application_name: 'onstarvoice:all:101', lock_count: 2},
  ], 'all'));
  assert.doesNotThrow(() => assertP2ehRoleLocks([
    {application_name: 'onstarvoice:ai-media:201', lock_count: 1},
    {application_name: 'onstarvoice:scheduler:202', lock_count: 1},
  ], 'split'));
  assert.doesNotThrow(() => assertP2ehRoleLocks([], 'none'));
  assert.throws(
    () => assertP2ehRoleLocks([
      {application_name: 'another-service:advisory-lock', lock_count: 1},
    ], 'all'),
    error => error.code === 'P2EH_UNEXPECTED_ADVISORY_LOCK',
  );
  assert.throws(
    () => assertP2ehRoleLocks([
      {application_name: 'onstarvoice:maintenance-task:repair:101', lock_count: 1},
    ], 'split'),
    error => error.code === 'P2EH_MAINTENANCE_LOCK_REMAINS',
  );
});

test('sanitized environment does not inherit the caller or external endpoints', () => {
  process.env.P2EH_SHOULD_NOT_LEAK = 'secret';
  const env = isolatedEnvironment({
    tempRoot: '/tmp/p2eh-safe',
    databaseUrl: `postgresql://127.0.0.1/onstarvoice_test_p2eh_${runId}`,
    apiPort: 43031,
    ingressPort: 43030,
    role: 'all',
    emptyEnvPath: '/tmp/p2eh-safe/empty.env',
    mediaDir: '/tmp/p2eh-safe/media',
    runId,
  });
  assert.equal(env.P2EH_SHOULD_NOT_LEAK, undefined);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PROCESS_ROLE, 'all');
  assert.equal(env.ALLOW_RESET_MIGRATIONS, '0');
  assert.match(env.LLM_API_ENDPOINT, /^http:\/\/127\.0\.0\.1:1/u);
  delete process.env.P2EH_SHOULD_NOT_LEAK;
});

test('generated Nginx and PM2 config remain loopback-only and exact-role', () => {
  const nginx = nginxConfig({ prefix: '/tmp/p2eh/nginx', ingressPort: 43030, apiPort: 43031 });
  assert.match(nginx, /listen 127\.0\.0\.1:43030/u);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:43031/u);
  assert.doesNotMatch(nginx, /voice\.minilife|47\.103\./u);

  const ecosystem = pm2Ecosystem({
    releaseRoot: '/tmp/p2eh/release',
    sandboxExec: '/usr/bin/sandbox-exec',
    sandboxProfileText: '(version 1)(allow default)',
    nodeBin: '/node18/bin/node',
    guardPath: '/tmp/p2eh/release/scripts/lib/p2eh-local-network-guard.mjs',
    commonEnv: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://127.0.0.1/db' },
    tempRoot: '/tmp/p2eh',
    runId,
    schedulerPort: 43032,
    aiMediaPort: 43034,
    restoreDatabaseUrl: 'postgresql://127.0.0.1/restore',
    restorePort: 43033,
  });
  const config = JSON.parse(ecosystem);
  assert.deepEqual(config.apps.slice(0, 4).map(app => app.name), [
    `p2eh-${runId}-all`,
    `p2eh-${runId}-api`,
    `p2eh-${runId}-scheduler`,
    `p2eh-${runId}-ai-media`,
  ]);
  assert.equal(config.apps.every(app => app.instances === 1 && app.autorestart === false), true);
  assert.equal(config.apps.every(app => app.script === '/usr/bin/sandbox-exec'), true);
});

test('credentials are redacted and private evidence files stay private', async t => {
  assert.equal(
    credentialSafeText('postgresql://user:password@127.0.0.1/db Authorization: Bearer abc.def'),
    'postgresql://[redacted]@127.0.0.1/db Authorization: [redacted]',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2eh-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = await writePrivateFile(path.join(root, 'evidence.txt'), 'safe');
  await assertPrivatePath(target);
});

test('real macOS sandbox allows loopback and blocks nonlocal outbound while Node guard blocks broad bind', {
  skip: process.platform !== 'darwin',
}, async () => {
  await preflightSandbox({
    sandboxExec: '/usr/bin/sandbox-exec',
    nodeBin: process.execPath,
    networkGuardPath: path.resolve('scripts/lib/p2eh-local-network-guard.mjs'),
    loopbackPort: 5432,
  });
});

test('Node network guard permits only an explicit loopback TCP listener with a string port', async () => {
  const script = [
    'const net=require("node:net");',
    'const server=net.createServer();',
    'server.listen("0","127.0.0.1",()=>{console.log("LOOPBACK_LISTEN_OK");server.close();});',
  ].join('');
  const result = await runCommand(process.execPath, [
    '--import', path.resolve('scripts/lib/p2eh-local-network-guard.mjs'),
    '-e', script,
  ], {
    env: {PATH: '/usr/bin:/bin', HOME: '/var/empty', TMPDIR: '/tmp', LANG: 'C', TZ: 'UTC'},
    label: 'loopback string-port guard probe',
  });
  assert.match(result.stdout, /LOOPBACK_LISTEN_OK/u);
  assert.match(result.stderr, /\[P2EHLocalGuard\] active/u);
});

test('command timeout waits for an uncooperative child to close after SIGKILL', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runCommand(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
    ], {
      env: {PATH: '/usr/bin:/bin', HOME: '/var/empty', TMPDIR: '/tmp', LANG: 'C', TZ: 'UTC'},
      timeoutMs: 250,
      label: 'uncooperative timeout fixture',
    }),
    error => error.code === 'P2EH_COMMAND_TIMEOUT'
      && error.details?.outcome?.signal === 'SIGKILL',
  );
  assert.ok(Date.now() - startedAt >= 900);
});

test('abort signal stops an uncooperative child before rejecting', async () => {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort('SIGTERM'), 250);
  await assert.rejects(
    runCommand(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
    ], {
      env: {PATH: '/usr/bin:/bin', HOME: '/var/empty', TMPDIR: '/tmp', LANG: 'C', TZ: 'UTC'},
      timeoutMs: 10_000,
      label: 'abort fixture',
      signal: controller.signal,
    }),
    error => error.code === 'P2EH_SIGNAL_RECEIVED'
      && error.details?.outcome?.signal === 'SIGKILL',
  );
  clearTimeout(abortTimer);
  const waitController = new AbortController();
  waitController.abort('SIGINT');
  await assert.rejects(
    waitFor(() => false, {signal: waitController.signal}),
    error => error.code === 'P2EH_SIGNAL_RECEIVED',
  );
});
