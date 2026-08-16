#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadProcessTopology } from './check-process-topology.mjs';
import {
  assertP2ehLocalMinute1,
  assertP2ehLocalMinute5,
  assertP2ehLocalMinute10,
  inspectP2ehLocalCanary,
  seedP2ehLocalCanary,
  summarizeP2ehLocalAiLogs,
} from './lib/p2eh-local-canary.mjs';
import {
  P2ehLocalError,
  assertP2ehRoleLocks,
  assertPortsAvailable,
  assertPrivatePath,
  assertRunId,
  canBindPort,
  credentialSafeText,
  isolatedEnvironment,
  nginxConfig,
  parseLocalDatabaseUrl,
  pm2Ecosystem,
  preflightSandbox,
  runCommand as runSanitizedCommand,
  sandboxProfile,
  sha256File,
  waitFor as waitForCondition,
  writePrivateFile,
} from './lib/p2eh-local-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_COMMIT = 'a5faf6b0f80b080b371f0ee1ef657ab8b29fb707';
const V066_COMMIT = 'c47800f3184effc9e6ef05aedba9f37a81053886';
const LOCAL_PG_DATA_DIRECTORY = '/opt/homebrew/var/postgresql@17';
const PORTS = Object.freeze({
  ingress: 43030,
  api: 43031,
  scheduler: 43032,
  restoreApi: 43033,
  aiMedia: 43034,
});
const TOOLS = Object.freeze({
  git: '/usr/bin/git',
  tar: '/usr/bin/tar',
  sandboxExec: '/usr/bin/sandbox-exec',
  node18: '/Users/dulaidila/.nvm/versions/node/v18.20.8/bin/node',
  npm18: '/Users/dulaidila/.nvm/versions/node/v18.20.8/bin/npm',
  nginx: '/opt/homebrew/bin/nginx',
  psql: '/opt/homebrew/bin/psql',
  createdb: '/opt/homebrew/bin/createdb',
  dropdb: '/opt/homebrew/bin/dropdb',
  pgDump: '/opt/homebrew/bin/pg_dump',
  pgRestore: '/opt/homebrew/bin/pg_restore',
  pm2Cli: path.join(repositoryRoot, '.tmp-p2eh-tools/node_modules/pm2/bin/pm2'),
});
const GUARD_PATH = path.join(repositoryRoot, 'scripts/lib/p2eh-local-network-guard.mjs');
const USER_CACHE = path.join(os.homedir(), '.npm');
const ALLOWED_DIRTY_PATHS = new Set([
  '.claude/settings.local.json',
  'README.md',
  'deploy/DEPLOY.md',
  'docs/README.md',
  'docs/开发运行与生产发布手册.md',
  'docs/故障排查与验收清单.md',
  'docs/数据库与迁移说明.md',
  'docs/架构优化实施方案与计划.md',
  'docs/系统架构与稳定版交接手册.md',
  'scripts/lib/p2eh-local-canary.mjs',
  'scripts/lib/p2eh-local-network-guard.mjs',
  'scripts/lib/p2eh-local-runtime.mjs',
  'scripts/run-node-regression-tests.mjs',
  'scripts/run-postgres-integration-tests.mjs',
  'scripts/run-p2eh-local-rehearsal.mjs',
  'tests/integration/postgres/p2eh-local-canary.integration.mjs',
  'tests/p2eh-local-canary.test.mjs',
  'tests/p2eh-local-runtime.test.mjs',
]);
const STARTUP_TASK_IDS = Object.freeze([
  'publish-ts-backfill-v1',
  'opinion-analysis-stale-repair',
  'comment-promotion-reconcile',
  'comment-safety-semantic-reclassify-v1',
  'recent-media-backfill',
  'saicgm-scope-relabel-v3',
]);
const APP_ROLE_NAMES = Object.freeze(['all', 'api', 'scheduler', 'ai-media']);
const childClosePromises = new WeakMap();
let activeRehearsalAbortSignal;

function throwIfAborted() {
  if (activeRehearsalAbortSignal?.aborted) {
    fail(
      'P2EH_SIGNAL_RECEIVED',
      `Rehearsal interrupted by ${String(activeRehearsalAbortSignal.reason || 'signal')}.`,
    );
  }
}

function waitFor(check, options = {}) {
  return waitForCondition(check, {
    ...options,
    signal: activeRehearsalAbortSignal,
  });
}

function runCommand(command, args = [], options = {}) {
  return runSanitizedCommand(command, args, {
    ...options,
    signal: activeRehearsalAbortSignal,
  });
}

async function abortableDelay(delayMs) {
  throwIfAborted();
  let abortListener;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    if (!activeRehearsalAbortSignal) return;
    abortListener = () => {
      clearTimeout(timer);
      reject(new P2ehLocalError(
        'P2EH_SIGNAL_RECEIVED',
        `Rehearsal interrupted by ${String(activeRehearsalAbortSignal.reason || 'signal')}.`,
      ));
    };
    activeRehearsalAbortSignal.addEventListener('abort', abortListener, { once: true });
  }).finally(() => {
    if (activeRehearsalAbortSignal && abortListener) {
      activeRehearsalAbortSignal.removeEventListener('abort', abortListener);
    }
  });
}

async function writeFinalEvidence(evidencePath, evidence) {
  if (evidence.status !== 'passed') {
    return writePrivateFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const pendingPath = `${evidencePath}.pending`;
  if (await exists(pendingPath)) {
    fail('P2EH_EVIDENCE_PENDING_EXISTS', `Refusing to overwrite pending evidence ${pendingPath}.`);
  }
  try {
    await writePrivateFile(pendingPath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assertPrivatePath(pendingPath);
    await rename(pendingPath, evidencePath);
    return evidencePath;
  } catch (error) {
    try { await rm(pendingPath, { force: true }); } catch {}
    throw error;
  }
}

function note(message) {
  process.stdout.write(`[P2EH-Local] ${message}\n`);
}

function fail(code, message, details = {}) {
  throw new P2ehLocalError(code, message, details);
}

function safeEnvironment(tempRoot) {
  return Object.freeze({
    PATH: [path.dirname(TOOLS.node18), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    HOME: path.join(tempRoot, 'home'),
    TMPDIR: path.join(tempRoot, 'tmp'),
    LANG: 'C',
    TZ: 'Asia/Shanghai',
  });
}

function databaseEnvironment(tempRoot, user) {
  return Object.freeze({
    ...safeEnvironment(tempRoot),
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: user,
    PGAPPNAME: 'onstarvoice:p2eh:orchestrator',
  });
}

function npmEnvironment(tempRoot) {
  return Object.freeze({
    ...safeEnvironment(tempRoot),
    NPM_CONFIG_CACHE: USER_CACHE,
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  });
}

function pm2Environment(tempRoot, pm2Home) {
  return Object.freeze({
    ...safeEnvironment(tempRoot),
    PM2_HOME: pm2Home,
    PM2_DISABLE_UPDATE_CHECK: '1',
    PM2_SILENT: 'true',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
}

function parseArguments(argv) {
  const flags = new Set(argv);
  const unknown = argv.filter(value => !['--execute', '--preflight-only', '--help'].includes(value));
  if (unknown.length) fail('P2EH_ARGUMENT_UNKNOWN', `Unknown argument: ${unknown[0]}`);
  return Object.freeze({
    execute: flags.has('--execute'),
    preflightOnly: flags.has('--preflight-only'),
    help: flags.has('--help'),
  });
}

function usage() {
  return [
    'P2-E-H local production-like topology rehearsal',
    '',
    '  node scripts/run-p2eh-local-rehearsal.mjs --preflight-only',
    '  node scripts/run-p2eh-local-rehearsal.mjs --execute',
    '',
    'This runner accepts only loopback services and exact onstarvoice_test_p2eh_* databases.',
    'It never connects to or deploys production.',
  ].join('\n');
}

function newRunId() {
  const timestamp = new Date().toISOString()
    .replace(/[-:TZ.]/gu, '')
    .slice(0, 14);
  return assertRunId(`local_${timestamp}_${randomBytes(3).toString('hex')}`);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertTools() {
  for (const [name, toolPath] of Object.entries(TOOLS)) {
    if (!path.isAbsolute(toolPath) || !await exists(toolPath)) {
      fail('P2EH_TOOL_MISSING', `Required local tool is missing: ${name}`);
    }
  }
  if (!await exists(GUARD_PATH)) fail('P2EH_GUARD_MISSING', 'Local network guard is missing.');
}

async function collectToolFacts(tempRoot) {
  const env = safeEnvironment(tempRoot);
  const [node, nginx, postgres] = await Promise.all([
    runCommand(TOOLS.node18, ['--version'], { env, label: 'Node version' }),
    runCommand(TOOLS.nginx, ['-v'], { env, label: 'Nginx version' }),
    runCommand(TOOLS.psql, ['--version'], { env, label: 'PostgreSQL client version' }),
  ]);
  const pm2Package = JSON.parse(await readFile(
    path.join(repositoryRoot, '.tmp-p2eh-tools/node_modules/pm2/package.json'),
    'utf8',
  ));
  return Object.freeze({
    node: node.stdout.trim(),
    nginx: (nginx.stdout || nginx.stderr).trim(),
    postgresClient: postgres.stdout.trim(),
    pm2: String(pm2Package.version || ''),
  });
}

async function assertRepositoryBoundary(commandEnv) {
  const head = await runCommand(TOOLS.git, ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    env: commandEnv,
    label: 'git head',
  });
  const harnessCommit = head.stdout.trim();
  const releaseInHarness = await runCommand(TOOLS.git, [
    'merge-base', '--is-ancestor', RELEASE_COMMIT, harnessCommit,
  ], {
    cwd: repositoryRoot,
    env: commandEnv,
    label: 'release commit ancestry in harness',
    allowExitCodes: [0, 1],
  });
  if (releaseInHarness.code !== 0) {
    fail('P2EH_HEAD_DRIFT', `Harness HEAD ${harnessCommit} does not descend from ${RELEASE_COMMIT}.`);
  }
  const originMain = await runCommand(TOOLS.git, ['rev-parse', 'origin/main'], {
    cwd: repositoryRoot,
    env: commandEnv,
    label: 'origin main',
  });
  const originMainCommit = originMain.stdout.trim();
  const releaseInOrigin = await runCommand(TOOLS.git, [
    'merge-base', '--is-ancestor', RELEASE_COMMIT, originMainCommit,
  ], {
    cwd: repositoryRoot,
    env: commandEnv,
    label: 'release commit ancestry in origin main',
    allowExitCodes: [0, 1],
  });
  if (releaseInOrigin.code !== 0) {
    fail('P2EH_BASE_DRIFT', 'origin/main no longer contains the frozen rehearsal release commit.');
  }
  const status = await runCommand(TOOLS.git, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    cwd: repositoryRoot,
    env: commandEnv,
    label: 'git status',
  });
  const dirtyPaths = status.stdout.split('\0').filter(Boolean).map(entry => entry.slice(3));
  const unexpected = dirtyPaths.filter(filePath => !ALLOWED_DIRTY_PATHS.has(filePath));
  if (unexpected.length) {
    fail('P2EH_WORKTREE_SCOPE_DRIFT', 'Unexpected worktree changes exist.', { unexpected });
  }
  return Object.freeze({
    releaseCommit: RELEASE_COMMIT,
    harnessCommit,
    originMainCommit,
    dirtyPaths,
  });
}

async function validateTopologyManifests() {
  const production = await loadProcessTopology(
    path.join(repositoryRoot, 'deploy/process-topology.production.json'),
  );
  const split = await loadProcessTopology(
    path.join(repositoryRoot, 'deploy/process-topology.split.candidate.json'),
    { requireDeployable: false },
  );
  if (production.topology !== 'compatibility' || production.totalInstances !== 1) {
    fail('P2EH_PRODUCTION_TOPOLOGY_DRIFT', 'Production manifest is not exactly one all process.');
  }
  if (split.topology !== 'split'
      || split.roleCounts.api !== 1
      || split.roleCounts.scheduler !== 1
      || split.roleCounts['ai-media'] !== 1) {
    fail('P2EH_SPLIT_TOPOLOGY_DRIFT', 'Split candidate is not exactly api+scheduler+ai-media.');
  }
  return { production, split };
}

async function loadPgClient() {
  const modulePath = path.join(repositoryRoot, 'server/node_modules/pg/lib/index.js');
  if (!await exists(modulePath)) {
    fail('P2EH_PG_DRIVER_MISSING', 'server/node_modules/pg is required for safe parameterized preflight.');
  }
  const pg = await import(pathToFileURL(modulePath).href);
  return pg.Client || pg.default?.Client;
}

async function withDatabase(Client, connectionString, applicationName, operation) {
  throwIfAborted();
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    keepAlive: true,
  });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function adminFacts(Client) {
  return withDatabase(
    Client,
    'postgresql://127.0.0.1:5432/postgres',
    'onstarvoice:p2eh:admin-preflight',
    async client => {
      const result = await client.query(`
        SELECT current_user AS current_user,
               inet_server_addr()::text AS server_address,
               inet_server_port() AS server_port,
               current_setting('server_version') AS server_version,
               current_setting('data_directory') AS data_directory,
               current_setting('listen_addresses') AS listen_addresses
      `);
      const row = result.rows[0];
      if (!['127.0.0.1', '127.0.0.1/32'].includes(row.server_address)
          || Number(row.server_port) !== 5432
          || path.resolve(row.data_directory || '') !== LOCAL_PG_DATA_DIRECTORY
          || row.listen_addresses !== 'localhost') {
        fail(
          'P2EH_POSTGRES_NOT_LOCAL_HOMEBREW',
          'PostgreSQL is not the expected local-only Homebrew service.',
          {
            address: row.server_address,
            port: row.server_port,
            dataDirectory: row.data_directory,
            listenAddresses: row.listen_addresses,
          },
        );
      }
      return row;
    },
  );
}

async function databaseExists(Client, databaseName) {
  return withDatabase(
    Client,
    'postgresql://127.0.0.1:5432/postgres',
    'onstarvoice:p2eh:database-check',
    async client => {
      const result = await client.query('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists', [databaseName]);
      return result.rows[0].exists === true;
    },
  );
}

async function createExactDatabase({ Client, databaseName, user, tempRoot }) {
  if (await databaseExists(Client, databaseName)) {
    fail('P2EH_DATABASE_ALREADY_EXISTS', `Refusing to reuse existing database ${databaseName}.`);
  }
  await runCommand(TOOLS.createdb, [
    '--host=127.0.0.1',
    '--port=5432',
    `--username=${user}`,
    `--owner=${user}`,
    '--encoding=UTF8',
    databaseName,
  ], {
    cwd: tempRoot,
    env: databaseEnvironment(tempRoot, user),
    label: `create ${databaseName}`,
  });
  if (!await databaseExists(Client, databaseName)) {
    fail('P2EH_DATABASE_CREATE_UNVERIFIED', `Database creation was not verified: ${databaseName}`);
  }
}

async function assertEmptyDatabase(Client, databaseUrl, databaseName, runId) {
  await withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:empty-check`, async client => {
    const facts = await client.query(`
      SELECT current_database() AS database_name,
             inet_server_addr()::text AS server_address,
             (SELECT count(*)::integer
              FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname <> 'information_schema'
                AND namespace.nspname NOT LIKE 'pg_%'
                AND relation.relkind IN ('r','p','v','m','S','f')) AS user_relations,
             (SELECT count(*)::integer
              FROM pg_locks
              WHERE locktype = 'advisory'
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS advisory_locks
    `);
    const row = facts.rows[0];
    if (row.database_name !== databaseName
        || !['127.0.0.1', '127.0.0.1/32'].includes(row.server_address)
        || row.user_relations !== 0
        || row.advisory_locks !== 0) {
      fail('P2EH_DATABASE_NOT_EMPTY', 'Dedicated rehearsal database is not empty and local.', row);
    }
  });
}

async function stageRelease({ commit, releaseRoot, tarPath, tempRoot }) {
  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  await runCommand(TOOLS.git, [
    '-C', repositoryRoot,
    'archive', '--format=tar', `--output=${tarPath}`, commit,
  ], {
    cwd: repositoryRoot,
    env: safeEnvironment(tempRoot),
    label: `archive ${commit.slice(0, 8)}`,
    timeoutMs: 60_000,
  });
  await chmod(tarPath, 0o600);
  await runCommand(TOOLS.tar, ['-xf', tarPath, '-C', releaseRoot], {
    cwd: tempRoot,
    env: safeEnvironment(tempRoot),
    label: `extract ${commit.slice(0, 8)}`,
    timeoutMs: 60_000,
  });
  for (const fileName of ['.env', '.env.production']) {
    if (await exists(path.join(releaseRoot, 'server', fileName))) {
      fail('P2EH_STAGE_SECRET_PRESENT', `Archive unexpectedly contains server/${fileName}.`);
    }
  }
  await runCommand(TOOLS.npm18, [
    'ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
  ], {
    cwd: path.join(releaseRoot, 'server'),
    env: npmEnvironment(tempRoot),
    label: `offline npm ci ${commit.slice(0, 8)}`,
    timeoutMs: 180_000,
  });
  return sha256File(tarPath);
}

async function assertStartupTaskInventory({
  releaseRoot,
  tempRoot,
  databaseUrl,
  emptyEnv,
  mediaDir,
  runId,
  guardPath,
}) {
  const registryPath = path.join(releaseRoot, 'server/maintenance/registry.js');
  const probePath = await writePrivateFile(
    path.join(tempRoot, 'harness/startup-task-inventory.mjs'),
    [
      'const registry = await import(process.argv[2]);',
      'const actual = [',
      '  registry.MAINTENANCE_TASK_IDS?.PUBLISH_TS_BACKFILL,',
      '  ...(registry.COMPATIBILITY_STARTUP_TASK_GROUPS || []).flatMap(group => group.taskIds || []),',
      '].filter(Boolean);',
      'process.stdout.write(`P2EH_STARTUP_TASKS=${JSON.stringify(actual)}\\n`);',
    ].join('\n'),
  );
  const outcome = await runNodeGuarded({
    scriptPath: probePath,
    args: [pathToFileURL(registryPath).href],
    cwd: path.join(releaseRoot, 'server'),
    env: maintenanceEnvironment({
      tempRoot,
      databaseUrl,
      emptyEnv,
      mediaDir,
      runId,
      pgAppName: `onstarvoice:p2eh:${runId}:inventory`,
    }),
    guardPath,
    label: 'frozen startup maintenance inventory',
  });
  const match = outcome.stdout.match(/^P2EH_STARTUP_TASKS=(\[[^\n]*\])$/mu);
  if (!match) fail('P2EH_STARTUP_TASK_INVENTORY_INVALID', 'Frozen release startup inventory probe returned invalid output.');
  const actual = JSON.parse(match[1]);
  if (JSON.stringify(actual) !== JSON.stringify(STARTUP_TASK_IDS)) {
    fail('P2EH_STARTUP_TASK_INVENTORY_DRIFT', 'Frozen release startup maintenance inventory changed.', {
      expected: STARTUP_TASK_IDS,
      actual,
    });
  }
  return actual;
}

function maintenanceEnvironment({ tempRoot, databaseUrl, emptyEnv, mediaDir, runId, pgAppName }) {
  return Object.freeze({
    ...isolatedEnvironment({
      tempRoot,
      databaseUrl,
      apiPort: PORTS.api,
      ingressPort: PORTS.ingress,
      role: 'maintenance',
      emptyEnvPath: emptyEnv,
      mediaDir,
      runId,
    }),
    TEST_DATABASE_URL: databaseUrl,
    MAINTENANCE_OFFLINE_CONFIRMED: '1',
    PGAPPNAME: pgAppName,
  });
}

async function runNodeGuarded({
  scriptPath,
  args = [],
  cwd,
  env,
  guardPath,
  label,
  timeoutMs = 120_000,
}) {
  throwIfAborted();
  if (!path.isAbsolute(String(guardPath || ''))) {
    fail('P2EH_GUARD_PATH_INVALID', `${label} requires an absolute guard snapshot.`);
  }
  const outcome = await runCommand(TOOLS.sandboxExec, [
    '-p', sandboxProfile(),
    TOOLS.node18,
    '--import', guardPath,
    scriptPath,
    ...args,
  ], { cwd, env, label, timeoutMs });
  const output = `${outcome.stdout}\n${outcome.stderr}`;
  if (!output.includes('[P2EHLocalGuard] active')) {
    fail('P2EH_GUARD_NOT_ACTIVE', `${label} did not activate the local network guard.`);
  }
  if (output.includes('BLOCKED_NONLOCAL_NETWORK')) {
    fail('P2EH_EXTERNAL_ATTEMPT', `${label} attempted non-loopback network access.`);
  }
  return outcome;
}

async function buildV066({ oldRelease, databaseUrl, emptyEnv, mediaDir, tempRoot, runId, guardPath }) {
  const env = maintenanceEnvironment({
    tempRoot,
    databaseUrl,
    emptyEnv,
    mediaDir,
    runId,
    pgAppName: `onstarvoice:p2eh:${runId}:v066-migrate`,
  });
  await runNodeGuarded({
    scriptPath: path.join(oldRelease, 'server/db/migrate.js'),
    cwd: path.join(oldRelease, 'server'),
    env,
    guardPath,
    label: 'v066 migration',
    timeoutMs: 180_000,
  });
}

async function runMaintenance({
  currentRelease,
  databaseUrl,
  emptyEnv,
  mediaDir,
  tempRoot,
  runId,
  guardPath,
  args,
  label,
}) {
  return runNodeGuarded({
    scriptPath: path.join(currentRelease, 'server/entrypoints/maintenance.js'),
    args,
    cwd: path.join(currentRelease, 'server'),
    env: maintenanceEnvironment({
      tempRoot,
      databaseUrl,
      emptyEnv,
      mediaDir,
      runId,
      pgAppName: `onstarvoice:p2eh:${runId}:maintenance-${args[0]}`,
    }),
    guardPath,
    label,
    timeoutMs: 180_000,
  });
}

async function migrationSnapshot(Client, databaseUrl, runId, { checksums = true } = {}) {
  return withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:migration-snapshot`, async client => {
    const columns = checksums ? ', checksum_sha256, checksum_recorded_at::text' : '';
    const result = await client.query(`
      SELECT version${columns}
      FROM schema_migrations
      WHERE version ~ '^[0-9]{3}_'
      ORDER BY version
    `);
    return result.rows;
  });
}

function assertV066Snapshot(rows) {
  if (rows.length !== 60 || rows.at(-1)?.version !== '066_tenant_comment_risk_attention.sql') {
    fail('P2EH_V066_BASELINE_INVALID', 'Old release did not create the exact 60-file v066 schema.');
  }
}

function assertCurrentSnapshot(rows) {
  if (rows.length !== 61 || rows.at(-1)?.version !== '067_maintenance_runs.sql') {
    fail('P2EH_V067_MISSING', 'Current schema is not at migration 067.');
  }
  const incomplete = rows.filter(row => !row.checksum_sha256 || !row.checksum_recorded_at);
  if (incomplete.length) fail('P2EH_CHECKSUM_INCOMPLETE', 'Migration checksum readiness is incomplete.');
}

async function disableScheduledReports(Client, databaseUrl, runId) {
  await withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:report-disable`, async client => {
    await client.query(`
      INSERT INTO tenant_settings (tenant_id, key, value)
      SELECT tenant.id, setting.key, 'false'
      FROM tenants tenant
      CROSS JOIN (VALUES
        ('report_daily_enabled'),
        ('report_weekly_enabled'),
        ('report_monthly_enabled')
      ) AS setting(key)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = 'false', updated_at = now()
    `);
  });
}

async function dumpDatabase({ databaseName, user, backupPath, tempRoot }) {
  await runCommand(TOOLS.pgDump, [
    '--host=127.0.0.1', '--port=5432', `--username=${user}`,
    '--format=custom', '--no-owner', '--no-acl', `--file=${backupPath}`, databaseName,
  ], {
    cwd: tempRoot,
    env: databaseEnvironment(tempRoot, user),
    label: `dump ${databaseName}`,
    timeoutMs: 180_000,
  });
  await chmod(backupPath, 0o600);
  await assertPrivatePath(backupPath);
  const listing = await runCommand(TOOLS.pgRestore, ['--list', backupPath], {
    cwd: tempRoot,
    env: databaseEnvironment(tempRoot, user),
    label: `verify dump ${databaseName}`,
    timeoutMs: 60_000,
  });
  if (!listing.stdout.includes('TABLE')) fail('P2EH_BACKUP_LIST_EMPTY', 'Backup manifest has no tables.');
  return Object.freeze({ sha256: await sha256File(backupPath), listLines: listing.stdout.split('\n').length });
}

async function restoreDatabase({ databaseName, user, backupPath, tempRoot }) {
  await runCommand(TOOLS.pgRestore, [
    '--host=127.0.0.1', '--port=5432', `--username=${user}`,
    '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
    `--dbname=${databaseName}`, backupPath,
  ], {
    cwd: tempRoot,
    env: databaseEnvironment(tempRoot, user),
    label: `restore ${databaseName}`,
    timeoutMs: 180_000,
  });
}

async function startNginx({ prefix, configPath, tempRoot }) {
  await runCommand(TOOLS.sandboxExec, [
    '-p', sandboxProfile(), TOOLS.nginx,
    '-p', `${prefix}/`, '-c', path.relative(prefix, configPath), '-t',
  ], {
    cwd: prefix,
    env: safeEnvironment(tempRoot),
    label: 'Nginx config test',
  });
  const stdoutHandle = await open(path.join(prefix, 'logs/launcher.out.log'), 'a', 0o600);
  const stderrHandle = await open(path.join(prefix, 'logs/launcher.err.log'), 'a', 0o600);
  const child = spawn(TOOLS.sandboxExec, [
    '-p', sandboxProfile(), TOOLS.nginx,
    '-p', `${prefix}/`, '-c', path.relative(prefix, configPath), '-g', 'daemon off;',
  ], {
    cwd: prefix,
    env: safeEnvironment(tempRoot),
    stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
  });
  childClosePromises.set(child, new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  }));
  await stdoutHandle.close();
  await stderrHandle.close();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new P2ehLocalError('P2EH_NGINX_EXITED', `Nginx exited during startup with code ${code}.`));
    });
  });
  return child;
}

async function waitForChildClose(child, timeoutMs = 10_000) {
  const closePromise = childClosePromises.get(child);
  if (!closePromise) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    fail('P2EH_CHILD_CLOSE_UNTRACKED', 'Child close lifecycle was not registered.');
  }
  let timer;
  try {
    await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new P2ehLocalError(
          'P2EH_CHILD_CLOSE_TIMEOUT',
          `Child ${child.pid || 'unknown'} did not close within ${timeoutMs}ms.`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopNginx(child) {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForChildClose(child, 3000);
    return true;
  }
  child.kill('SIGQUIT');
  try {
    await waitForChildClose(child, 10_000);
    return true;
  } catch (quitError) {
    child.kill('SIGTERM');
    try {
      await waitForChildClose(child, 3000);
      return true;
    } catch (termError) {
      child.kill('SIGKILL');
      try {
        await waitForChildClose(child, 3000);
        return true;
      } catch (killError) {
        fail('P2EH_NGINX_STOP_TIMEOUT', 'Nginx did not close after SIGQUIT, SIGTERM, and SIGKILL.', {
          pid: child.pid,
          quitError: quitError.message,
          termError: termError.message,
          killError: killError.message,
        });
      }
    }
  }
}

function appName(runId, role) {
  return `p2eh-${runId}-${role}`;
}

async function pm2Command({ args, tempRoot, pm2Home, label, timeoutMs = 30_000 }) {
  throwIfAborted();
  const command = args[0];
  if (!['start', 'stop', 'delete', 'jlist', 'kill'].includes(command)) {
    fail('P2EH_PM2_COMMAND_FORBIDDEN', `Forbidden PM2 command: ${command}`);
  }
  if (command === 'start') {
    const onlyIndex = args.indexOf('--only');
    if (onlyIndex < 0 || !args[onlyIndex + 1]) {
      fail('P2EH_PM2_ONLY_REQUIRED', 'PM2 start requires an exact --only allowlist.');
    }
  }
  if ((command === 'stop' || command === 'delete') && args.length < 2) {
    fail('P2EH_PM2_TARGET_REQUIRED', `PM2 ${command} requires exact app names.`);
  }
  return runCommand(TOOLS.node18, [TOOLS.pm2Cli, ...args], {
    cwd: tempRoot,
    env: pm2Environment(tempRoot, pm2Home),
    label,
    timeoutMs,
    captureLimit: 5 * 1024 * 1024,
  });
}

async function pm2List(context) {
  const result = await pm2Command({...context, args: ['jlist'], label: 'PM2 jlist'});
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch {
    fail('P2EH_PM2_LIST_INVALID', 'PM2 returned invalid process metadata.');
  }
  const prefix = `p2eh-${context.runId}-`;
  const apps = parsed.filter(app => String(app.name || '').startsWith(prefix));
  for (const app of apps) {
    if (app.pm2_env?.P2EH_FORBIDDEN_SENTINEL !== undefined) {
      fail('P2EH_PM2_ENV_LEAK', 'PM2 inherited a forbidden host sentinel.');
    }
  }
  return apps.map(app => Object.freeze({
    name: app.name,
    pid: Number(app.pid || 0),
    status: app.pm2_env?.status || '',
    exitCode: app.pm2_env?.exit_code,
  }));
}

async function startPm2Apps(context, names) {
  const exact = [...new Set(names)];
  if (exact.length !== names.length || exact.some(name => !name.startsWith(`p2eh-${context.runId}-`))) {
    fail('P2EH_PM2_APP_INVALID', 'PM2 app allowlist is not exact for this run.');
  }
  await pm2Command({
    ...context,
    args: ['start', context.ecosystemPath, '--only', exact.join(','), '--update-env'],
    label: `PM2 start ${exact.join(',')}`,
    timeoutMs: 60_000,
  });
}

async function stopDeletePm2Apps(context, names) {
  const present = new Set((await pm2List(context)).map(app => app.name));
  const targets = names.filter(name => present.has(name));
  if (!targets.length) return;
  await pm2Command({...context, args: ['stop', ...targets], label: `PM2 stop ${targets.join(',')}`, timeoutMs: 60_000});
  await pm2Command({...context, args: ['delete', ...targets], label: `PM2 delete ${targets.join(',')}`});
}

async function runtimeLog(tempRoot, role) {
  const streams = await runtimeLogStreams(tempRoot, role);
  return `${streams.out}\n${streams.err}`;
}

async function runtimeLogStreams(tempRoot, role) {
  const outPath = path.join(tempRoot, 'logs', `${role}.out.log`);
  const errPath = path.join(tempRoot, 'logs', `${role}.err.log`);
  return {
    out: await exists(outPath) ? await readFile(outPath, 'utf8') : '',
    err: await exists(errPath) ? await readFile(errPath, 'utf8') : '',
  };
}

function assertRuntimeLogSafe(log, role) {
  if (!log.includes('[P2EHLocalGuard] active')) {
    fail('P2EH_RUNTIME_GUARD_MISSING', `${role} did not activate the local guard.`);
  }
  if (log.includes('BLOCKED_NONLOCAL_NETWORK')) {
    fail('P2EH_RUNTIME_EXTERNAL_ATTEMPT', `${role} attempted non-loopback network access.`);
  }
  if (credentialSafeText(log) !== log) {
    fail('P2EH_RUNTIME_SECRET_LOG', `${role} log contains credential-like text.`);
  }
  if (/uncaught|unhandled|graceful shutdown timed out|\[Cron\] Batch labeling error:|\[AI\] Label error/iu.test(log)) {
    fail('P2EH_RUNTIME_SEVERE_LOG', `${role} emitted an unexpected severe runtime error.`);
  }
}

async function httpHealth(port, expectedRole) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
    signal: AbortSignal.timeout(2000),
  });
  const body = await response.json();
  if (response.status !== 200 || body.ok !== true || body.status !== 'ready' || body.role !== expectedRole) {
    fail('P2EH_READINESS_INVALID', `Readiness did not report role=${expectedRole}.`, { status: response.status, body });
  }
  return body;
}

async function waitForTopologyReady(context, roles, expectedHttpRole, { port = PORTS.ingress } = {}) {
  const names = roles.map(role => appName(context.runId, role));
  const apps = await waitFor(async () => {
    const rows = await pm2List(context);
    const byName = new Map(rows.map(row => [row.name, row]));
    return names.every(name => byName.get(name)?.status === 'online' && byName.get(name)?.pid > 0)
      ? names.map(name => byName.get(name))
      : false;
  }, { timeoutMs: 30_000, intervalMs: 300, label: `${roles.join('+')} PM2 online` });
  await waitFor(() => httpHealth(port, expectedHttpRole).catch(() => false), {
    timeoutMs: 30_000,
    intervalMs: 300,
    label: `${expectedHttpRole} readiness`,
  });
  for (const role of roles) {
    const expectedRuntimeRole = role === 'restore-api' ? 'api' : role;
    await waitFor(async () => {
      const log = await runtimeLog(context.tempRoot, role);
      return log.includes(`[ProcessRuntime] role=${expectedRuntimeRole} ready`) ? log : false;
    }, { timeoutMs: 30_000, intervalMs: 300, label: `${role} runtime ready log` });
    assertRuntimeLogSafe(await runtimeLog(context.tempRoot, role), role);
  }
  for (const app of apps) context.recordedPids.add(app.pid);
  return apps;
}

async function assertTopologyStable({
  context,
  roles,
  expectedHttpRole,
  Client,
  databaseUrl,
  expectedLockRole,
  port = PORTS.ingress,
}) {
  const expectedNames = roles.map(role => appName(context.runId, role)).sort();
  const apps = await pm2List(context);
  const actualNames = apps.map(app => app.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
      || apps.some(app => app.status !== 'online' || app.pid <= 0)) {
    fail('P2EH_TOPOLOGY_NOT_STABLE', 'PM2 topology changed during a rehearsal checkpoint.', {
      expectedNames,
      apps,
    });
  }
  await httpHealth(port, expectedHttpRole);
  for (const role of roles) {
    assertRuntimeLogSafe(await runtimeLog(context.tempRoot, role), role);
  }
  const locks = await roleLocks(Client, databaseUrl, context.runId);
  assertP2ehRoleLocks(locks, expectedLockRole);
  for (const app of apps) context.recordedPids.add(app.pid);
  return Object.freeze({
    apps: apps.map(app => ({ name: app.name, pid: app.pid, status: app.status })),
    locks: locks.map(row => ({
      pid: row.pid,
      applicationName: row.application_name,
      count: row.lock_count,
    })),
  });
}

async function roleLocks(Client, databaseUrl, runId) {
  return withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:lock-audit`, async client => {
    const result = await client.query(`
      SELECT activity.pid,
             activity.application_name,
             count(*)::integer AS lock_count
      FROM pg_locks locks
      JOIN pg_stat_activity activity ON activity.pid = locks.pid
      WHERE activity.datname = current_database()
        AND locks.locktype = 'advisory'
        AND locks.granted
      GROUP BY activity.pid, activity.application_name
      ORDER BY activity.application_name, activity.pid
    `);
    return result.rows;
  });
}

async function assertRuntimeReleased(Client, databaseUrl, runId, apiPort) {
  await waitFor(async () => {
    const rows = await roleLocks(Client, databaseUrl, runId);
    return rows.length === 0 ? true : false;
  }, { timeoutMs: 15_000, intervalMs: 250, label: 'all advisory locks released' });
  await waitFor(() => canBindPort(apiPort), { timeoutMs: 15_000, intervalMs: 250, label: `port ${apiPort} released` });
  await withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:session-audit`, async client => {
    const result = await client.query(`
      SELECT pid, application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
      ORDER BY pid
    `);
    if (result.rows.length) fail('P2EH_SESSIONS_NOT_RELEASED', 'Runtime database sessions remain.', { rows: result.rows });
  });
}

async function maintenanceLedger(Client, databaseUrl, runId) {
  return withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:ledger-audit`, async client => {
    const result = await client.query(`
      SELECT task_id, run_kind, status, source, count(*)::integer AS total
      FROM maintenance_runs
      WHERE task_id = ANY($1::text[])
      GROUP BY task_id, run_kind, status, source
      ORDER BY task_id, status, source
    `, [STARTUP_TASK_IDS]);
    return result.rows;
  });
}

function ledgerCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!['succeeded', 'adopted'].includes(row.status)) {
      fail('P2EH_MAINTENANCE_FAILED', `Maintenance task ${row.task_id} is ${row.status}.`);
    }
    counts.set(row.task_id, (counts.get(row.task_id) || 0) + row.total);
  }
  for (const taskId of STARTUP_TASK_IDS) {
    if (!counts.has(taskId)) fail('P2EH_MAINTENANCE_MISSING', `Maintenance task ${taskId} is missing.`);
  }
  return counts;
}

function compareFinalLedger(initialRows, finalRows) {
  const initial = ledgerCounts(initialRows);
  const final = ledgerCounts(finalRows);
  const kinds = new Map(finalRows.map(row => [row.task_id, row.run_kind]));
  for (const taskId of STARTUP_TASK_IDS) {
    const expected = kinds.get(taskId) === 'repeatable' ? initial.get(taskId) + 1 : initial.get(taskId);
    if (final.get(taskId) !== expected) {
      fail('P2EH_MAINTENANCE_REPLAY_INVALID', `Unexpected final all task count for ${taskId}.`);
    }
  }
}

async function alignBeforeCanary() {
  while (true) {
    const now = new Date();
    const secondsIntoTen = (now.getMinutes() % 10) * 60 + now.getSeconds();
    if (secondsIntoTen >= 553 && secondsIntoTen <= 557) return;
    let secondsUntilTarget = 555 - secondsIntoTen;
    if (secondsUntilTarget <= 0) secondsUntilTarget += 600;
    const waitMs = secondsUntilTarget * 1000 - now.getMilliseconds();
    note(`等待 ${Math.ceil(waitMs / 1000)} 秒对齐到 10 分钟边界前 45 秒，确保完整观察 1/5/10 分钟。`);
    await abortableDelay(waitMs);
  }
}

async function canaryQuery(Client, databaseUrl, runId, sql, params) {
  return withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:canary`, client => client.query(sql, params));
}

async function canaryTransaction(Client, databaseUrl, runId, operation) {
  return withDatabase(Client, databaseUrl, `onstarvoice:p2eh:${runId}:canary-seed`, async client => {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const result = await operation((sql, params) => client.query(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  });
}

async function rearmCanary(Client, databaseUrl, runId, seeded) {
  const armedAt = new Date().toISOString();
  const dueAt = new Date(Date.parse(armedAt) - 30_000).toISOString();
  await canaryTransaction(Client, databaseUrl, runId, async query => {
    const result = await query(`WITH schedule AS (
      UPDATE capture_orchestration_schedules
      SET next_run_at = $5::timestamptz,
          updated_at = $6::timestamptz
      WHERE id = $1::uuid
        AND tenant_id = $3::uuid
        AND plan_snapshot->>'p2ehRunId' = $4
      RETURNING id
    ), subscription AS (
      UPDATE monitor_subscriptions
      SET next_run_at = $5::timestamptz,
          last_error = '',
          updated_at = $6::timestamptz
      WHERE id = $2::uuid
        AND tenant_id = $3::uuid
        AND name = $7
        AND keyword = $8
      RETURNING id
    )
    SELECT (SELECT count(*)::integer FROM schedule) AS schedule_count,
           (SELECT count(*)::integer FROM subscription) AS subscription_count`, [
      seeded.scheduleId,
      seeded.subscriptionId,
      seeded.tenantId,
      runId,
      dueAt,
      armedAt,
      seeded.subscriptionName,
      `p2eh-local-${runId}`,
    ]);
    const row = result.rows[0] || {};
    if (row.schedule_count !== 1 || row.subscription_count !== 1) {
      fail('P2EH_CANARY_REARM_INVALID', 'Canary rearm did not update both exact runId rows.', row);
    }
  });
  return Object.freeze({ armedAt, dueAt });
}

async function waitForCanary({
  Client,
  databaseUrl,
  runId,
  minute,
  seededAt,
  minimumElapsedMs = minute * 60_000,
  logs,
  timeoutMs,
}) {
  const seededAtMs = Date.parse(seededAt);
  if (!Number.isFinite(seededAtMs)) {
    fail('P2EH_CANARY_SEEDED_AT_INVALID', 'Canary seededAt timestamp is invalid.');
  }
  const notBeforeMs = seededAtMs + minimumElapsedMs;
  let logBaseline;
  let logBaselineAt;
  return waitFor(async () => {
    if (Date.now() < notBeforeMs) return false;
    let checkpointLogs = '';
    if (minute === 10) {
      const currentLogs = await logs();
      if (logBaseline === undefined) {
        logBaseline = currentLogs;
        logBaselineAt = new Date().toISOString();
        return false;
      }
      const currentStreams = typeof currentLogs === 'object' && currentLogs !== null
        ? currentLogs
        : { out: String(currentLogs || ''), err: '' };
      const baselineStreams = typeof logBaseline === 'object' && logBaseline !== null
        ? logBaseline
        : { out: String(logBaseline || ''), err: '' };
      const delta = stream => String(currentStreams[stream] || '').startsWith(String(baselineStreams[stream] || ''))
        ? String(currentStreams[stream] || '').slice(String(baselineStreams[stream] || '').length)
        : String(currentStreams[stream] || '');
      checkpointLogs = `${delta('out')}\n${delta('err')}`;
    }
    const fingerprint = await inspectP2ehLocalCanary({
      query: (sql, params) => canaryQuery(Client, databaseUrl, runId, sql, params),
      testDatabaseUrl: databaseUrl,
      databaseUrl,
      runId,
      schema: 'public',
    });
    try {
      if (minute === 1) {
        assertP2ehLocalMinute1(fingerprint);
        const lastRunAtMs = Date.parse(fingerprint.lineage.lastRunAt);
        if (!Number.isFinite(lastRunAtMs) || lastRunAtMs < seededAtMs) return false;
      } else if (minute === 5) {
        assertP2ehLocalMinute5(fingerprint);
        const creatorUpdatedAtMs = Date.parse(fingerprint.creator.updatedAt);
        if (!Number.isFinite(creatorUpdatedAtMs) || creatorUpdatedAtMs < seededAtMs) return false;
      } else {
        assertP2ehLocalMinute10(fingerprint, { logs: checkpointLogs });
      }
      const observedAt = new Date().toISOString();
      return {
        fingerprint,
        seededAt,
        observedAt,
        elapsedMs: Date.parse(observedAt) - seededAtMs,
        aiLogBaselineAt: minute === 10 ? logBaselineAt : undefined,
        aiLogSummary: minute === 10 ? summarizeP2ehLocalAiLogs(checkpointLogs) : undefined,
      };
    } catch {
      return false;
    }
  }, { timeoutMs, intervalMs: 5000, label: `P2-E-HL minute ${minute} canary` });
}

async function restoreCanaryFingerprint({ Client, databaseUrl, runId, restore = false }) {
  return inspectP2ehLocalCanary({
    query: (sql, params) => canaryQuery(Client, databaseUrl, runId, sql, params),
    testDatabaseUrl: databaseUrl,
    databaseUrl,
    runId,
    schema: 'public',
    restore,
  });
}

async function terminateKnownDatabaseSessions(Client, databaseName, runId, recordedPids) {
  return withDatabase(
    Client,
    'postgresql://127.0.0.1:5432/postgres',
    'onstarvoice:p2eh:cleanup-audit',
    async client => {
      const result = await client.query(`
        SELECT pid, application_name
        FROM pg_stat_activity
        WHERE datname = $1
        ORDER BY pid
      `, [databaseName]);
      const known = [];
      const unknown = [];
      for (const row of result.rows) {
        const app = String(row.application_name || '');
        const pidSuffix = Number(app.split(':').at(-1));
        if (app.includes(runId) || recordedPids.has(pidSuffix)) known.push(row);
        else unknown.push(row);
      }
      if (unknown.length) {
        fail('P2EH_DATABASE_FOREIGN_SESSION', `Refusing to drop ${databaseName}; unknown sessions exist.`, { unknown });
      }
      for (const row of known) {
        await client.query('SELECT pg_terminate_backend($1)', [row.pid]);
      }
      return known.length;
    },
  );
}

async function dropExactDatabase({ Client, databaseName, user, tempRoot, runId, recordedPids }) {
  if (!await databaseExists(Client, databaseName)) return false;
  await terminateKnownDatabaseSessions(Client, databaseName, runId, recordedPids);
  await runCommand(TOOLS.dropdb, [
    '--host=127.0.0.1', '--port=5432', `--username=${user}`, databaseName,
  ], {
    cwd: tempRoot,
    env: databaseEnvironment(tempRoot, user),
    label: `drop ${databaseName}`,
  });
  if (await databaseExists(Client, databaseName)) {
    fail('P2EH_DATABASE_DROP_UNVERIFIED', `Database still exists after exact drop: ${databaseName}`);
  }
  return true;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function recordPm2DaemonPid(pm2Home, recordedPids) {
  const pidPath = path.join(pm2Home, 'pm2.pid');
  if (!await exists(pidPath)) return null;
  const pid = Number((await readFile(pidPath, 'utf8')).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    fail('P2EH_PM2_PID_INVALID', 'Isolated PM2 daemon pid file is invalid.');
  }
  recordedPids.add(pid);
  return pid;
}

async function assertRecordedProcessesGone(recordedPids) {
  await waitFor(() => (
    [...recordedPids].every(pid => !processIsAlive(pid))
  ), { timeoutMs: 10_000, intervalMs: 250, label: 'recorded local processes stopped' });
}

async function runRehearsal() {
  process.umask(0o077);
  const runId = newRunId();
  const tempParent = path.join(repositoryRoot, '.tmp', 'p2eh-local');
  const evidenceParent = path.join(repositoryRoot, '.tmp', 'p2eh-evidence');
  const tempRoot = path.join(tempParent, runId);
  const pm2Home = path.join('/tmp', `onstar_p2eh_${runId.slice(-6)}`);
  const primaryName = `onstarvoice_test_p2eh_${runId}`;
  const restoreName = `${primaryName}_restore`;
  const localUser = os.userInfo().username;
  const encodedUser = encodeURIComponent(localUser);
  const primaryUrl = `postgresql://${encodedUser}@127.0.0.1:5432/${primaryName}`;
  const restoreUrl = `postgresql://${encodedUser}@127.0.0.1:5432/${restoreName}`;
  parseLocalDatabaseUrl(primaryUrl, { runId });
  parseLocalDatabaseUrl(restoreUrl, { runId, restore: true });
  const evidencePath = path.join(evidenceParent, `${runId}.json`);
  const guardSnapshot = path.join(tempRoot, 'harness/p2eh-local-network-guard.mjs');
  const evidence = {
    formatVersion: 1,
    runId,
    kind: 'P2-E-HL local production-like substitute',
    productionTouched: false,
    startedAt: new Date().toISOString(),
    frozenCommit: RELEASE_COMMIT,
    v066Commit: V066_COMMIT,
    ports: PORTS,
    phases: [],
  };
  const recordedPids = new Set();
  let Client;
  let databaseUser;
  let emptyEnv;
  let primaryCreated = false;
  let restoreCreated = false;
  let nginxChild = null;
  let context = null;
  let tempRootCreated = false;
  let pm2HomeCreated = false;
  let evidenceParentCreated = false;
  let evidenceWritable = false;
  let cleanupSucceeded = false;
  let failure = null;
  const abortController = new AbortController();
  const signalHandlers = new Map();
  for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (!abortController.signal.aborted) {
        process.stderr.write(`[P2EH-Local] 收到 ${signalName}，先清理本轮精确资源再退出。\n`);
        abortController.abort(signalName);
      }
    };
    signalHandlers.set(signalName, handler);
    process.on(signalName, handler);
  }
  activeRehearsalAbortSignal = abortController.signal;

  try {
    await mkdir(tempParent, { recursive: true, mode: 0o700 });
    await assertPrivatePath(tempParent, { directory: true });
    await mkdir(evidenceParent, { recursive: true, mode: 0o700 });
    await assertPrivatePath(evidenceParent, { directory: true });
    evidenceParentCreated = true;
    if (await exists(evidencePath)) {
      fail('P2EH_EVIDENCE_EXISTS', `Refusing to overwrite existing evidence ${evidencePath}.`);
    }
    evidenceWritable = true;
    await mkdir(tempRoot, { recursive: false, mode: 0o700 });
    tempRootCreated = true;
    for (const directory of ['home', 'tmp', 'logs', 'media', 'backups', 'releases', 'harness']) {
      await mkdir(path.join(tempRoot, directory), { recursive: true, mode: 0o700 });
    }
    if (await exists(pm2Home)) {
      fail('P2EH_PM2_HOME_EXISTS', `Refusing to reuse existing PM2_HOME ${pm2Home}.`);
    }
    await mkdir(pm2Home, { mode: 0o700 });
    pm2HomeCreated = true;
    await assertPrivatePath(tempRoot, { directory: true });
    emptyEnv = await writePrivateFile(path.join(tempRoot, 'empty.env'), '');
    await writePrivateFile(guardSnapshot, await readFile(GUARD_PATH));
    evidence.harness = {
      runnerSha256: await sha256File(fileURLToPath(import.meta.url)),
      runtimeSha256: await sha256File(path.join(repositoryRoot, 'scripts/lib/p2eh-local-runtime.mjs')),
      canarySha256: await sha256File(path.join(repositoryRoot, 'scripts/lib/p2eh-local-canary.mjs')),
      guardSha256: await sha256File(guardSnapshot),
    };
    note(`runId=${runId}；只使用本机回环地址。`);
    await assertTools();
    evidence.tools = await collectToolFacts(tempRoot);
    evidence.repository = await assertRepositoryBoundary(safeEnvironment(tempRoot));
    const topology = await validateTopologyManifests();
    await assertPortsAvailable(Object.values(PORTS));
    const sandbox = await preflightSandbox({
      sandboxExec: TOOLS.sandboxExec,
      nodeBin: TOOLS.node18,
      networkGuardPath: guardSnapshot,
      loopbackPort: 5432,
    });
    evidence.preflight = { sandbox, topology: { production: topology.production.roleCounts, split: topology.split.roleCounts } };

    Client = await loadPgClient();
    const postgres = await adminFacts(Client);
    databaseUser = postgres.current_user;
    if (databaseUser !== localUser) {
      fail('P2EH_POSTGRES_USER_MISMATCH', 'PostgreSQL current_user differs from the local OS user.');
    }
    evidence.postgres = {
      version: postgres.server_version,
      address: postgres.server_address,
      port: postgres.server_port,
      dataDirectory: postgres.data_directory,
      listenAddresses: postgres.listen_addresses,
    };
    await createExactDatabase({ Client, databaseName: primaryName, user: databaseUser, tempRoot });
    primaryCreated = true;
    await assertEmptyDatabase(Client, primaryUrl, primaryName, runId);

    const currentRelease = path.join(tempRoot, 'releases/current');
    const oldRelease = path.join(tempRoot, 'releases/v066');
    note('从精确 Git 提交创建两个无 .env 的临时 release，并离线安装依赖。');
    evidence.archives = {
      current: await stageRelease({
        commit: RELEASE_COMMIT,
        releaseRoot: currentRelease,
        tarPath: path.join(tempRoot, 'current.tar'),
        tempRoot,
      }),
      v066: await stageRelease({
        commit: V066_COMMIT,
        releaseRoot: oldRelease,
        tarPath: path.join(tempRoot, 'v066.tar'),
        tempRoot,
      }),
    };
    evidence.startupTaskIds = await assertStartupTaskInventory({
      releaseRoot: currentRelease,
      tempRoot,
      databaseUrl: primaryUrl,
      emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      runId,
      guardPath: guardSnapshot,
    });

    note('构造真实 v066 数据库基线并验证 60 个迁移。');
    await buildV066({
      oldRelease,
      databaseUrl: primaryUrl,
      emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      tempRoot,
      runId,
      guardPath: guardSnapshot,
    });
    const v066Snapshot = await migrationSnapshot(Client, primaryUrl, runId, { checksums: false });
    assertV066Snapshot(v066Snapshot);
    const v066BackupPath = path.join(tempRoot, 'backups/v066.dump');
    const v066BackupEvidence = await dumpDatabase({
      databaseName: primaryName,
      user: databaseUser,
      backupPath: v066BackupPath,
      tempRoot,
    });
    await createExactDatabase({ Client, databaseName: restoreName, user: databaseUser, tempRoot });
    restoreCreated = true;
    await assertEmptyDatabase(Client, restoreUrl, restoreName, runId);
    await restoreDatabase({
      databaseName: restoreName,
      user: databaseUser,
      backupPath: v066BackupPath,
      tempRoot,
    });
    assertV066Snapshot(await migrationSnapshot(Client, restoreUrl, runId, { checksums: false }));
    await dropExactDatabase({
      Client,
      databaseName: restoreName,
      user: databaseUser,
      tempRoot,
      runId,
      recordedPids,
    });
    restoreCreated = false;
    evidence.v066Backup = { ...v066BackupEvidence, restoreVerified: true };

    note('以 Maintenance 角色显式采纳 v066 checksum，迁移到 067 并只读 verify。');
    await runMaintenance({
      currentRelease,
      databaseUrl: primaryUrl,
      emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      tempRoot,
      runId,
      guardPath: guardSnapshot,
      args: ['migrate', '--adopt-v066-checksums'],
      label: 'Maintenance checksum adoption and migration',
    });
    await runMaintenance({
      currentRelease,
      databaseUrl: primaryUrl,
      emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      tempRoot,
      runId,
      guardPath: guardSnapshot,
      args: ['verify'],
      label: 'Maintenance migration verify',
    });
    const currentSnapshot = await migrationSnapshot(Client, primaryUrl, runId);
    assertCurrentSnapshot(currentSnapshot);
    await disableScheduledReports(Client, primaryUrl, runId);

    const nginxPrefix = path.join(tempRoot, 'nginx');
    for (const directory of ['conf', 'logs', 'temp/client', 'temp/proxy']) {
      await mkdir(path.join(nginxPrefix, directory), { recursive: true, mode: 0o700 });
    }
    const nginxPath = await writePrivateFile(
      path.join(nginxPrefix, 'conf/nginx.conf'),
      nginxConfig({ prefix: nginxPrefix, ingressPort: PORTS.ingress, apiPort: PORTS.api }),
    );
    nginxChild = await startNginx({ prefix: nginxPrefix, configPath: nginxPath, tempRoot });

    const commonEnv = isolatedEnvironment({
      tempRoot,
      databaseUrl: primaryUrl,
      apiPort: PORTS.api,
      ingressPort: PORTS.ingress,
      role: 'all',
      emptyEnvPath: emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      runId,
    });
    const ecosystemPath = await writePrivateFile(
      path.join(tempRoot, 'ecosystem.config.json'),
      pm2Ecosystem({
        releaseRoot: currentRelease,
        sandboxExec: TOOLS.sandboxExec,
        sandboxProfileText: sandboxProfile(),
        nodeBin: TOOLS.node18,
        guardPath: guardSnapshot,
        commonEnv,
        tempRoot,
        runId,
        schedulerPort: PORTS.scheduler,
        aiMediaPort: PORTS.aiMedia,
        restoreDatabaseUrl: restoreUrl,
        restorePort: PORTS.restoreApi,
      }),
    );
    context = {
      runId,
      tempRoot,
      pm2Home,
      ecosystemPath,
      recordedPids,
    };

    process.env.P2EH_FORBIDDEN_SENTINEL = 'must-not-enter-pm2';
    const probeName = appName(runId, 'sandbox-probe');
    await startPm2Apps(context, [probeName]);
    await waitFor(async () => {
      const log = await runtimeLog(tempRoot, 'sandbox-probe');
      return /P2EH_PM2_SANDBOX_BLOCKED_(?:EPERM|EACCES)/u.test(log) ? log : false;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'PM2 sandbox inheritance log' });
    const probe = await waitFor(async () => {
      const apps = await pm2List(context);
      const current = apps.find(app => app.name === probeName);
      return current && current.status !== 'online' ? current : false;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'PM2 sandbox probe exit' });
    if (probe.status !== 'stopped' || probe.exitCode !== 0) {
      fail('P2EH_PM2_SANDBOX_PROBE_FAILED', 'PM2 sandbox probe did not exit cleanly.', { probe });
    }
    const probeLog = await runtimeLog(tempRoot, 'sandbox-probe');
    if (!/P2EH_PM2_SANDBOX_BLOCKED_(?:EPERM|EACCES)/u.test(probeLog)) {
      fail('P2EH_PM2_SANDBOX_NOT_INHERITED', 'PM2-managed probe did not inherit outbound blocking.');
    }
    evidence.pm2SandboxProbe = { status: probe.status, exitCode: probe.exitCode, blocked: true };
    await stopDeletePm2Apps(context, [probeName]);
    delete process.env.P2EH_FORBIDDEN_SENTINEL;

    note('阶段 1：PM2 单一 all，经 Nginx readiness 与双角色锁验证。');
    await startPm2Apps(context, [appName(runId, 'all')]);
    await waitForTopologyReady(context, ['all'], 'all');
    await alignBeforeCanary();
    const seeded = await seedP2ehLocalCanary({
      transaction: operation => canaryTransaction(Client, primaryUrl, runId, operation),
      testDatabaseUrl: primaryUrl,
      databaseUrl: primaryUrl,
      runId,
      schema: 'public',
    });
    if (Object.values(seeded.inserted).some(value => value !== true)) {
      fail('P2EH_CANARY_FIRST_SEED_NOT_FRESH', 'Fresh rehearsal database did not insert all canary rows.', seeded.inserted);
    }
    const replayedSeed = await seedP2ehLocalCanary({
      transaction: operation => canaryTransaction(Client, primaryUrl, runId, operation),
      testDatabaseUrl: primaryUrl,
      databaseUrl: primaryUrl,
      runId,
      schema: 'public',
    });
    if (Object.values(replayedSeed.inserted).some(value => value !== false)) {
      fail('P2EH_CANARY_REPLAY_NOT_IDEMPOTENT', 'Canary seed replay inserted duplicate rows.', replayedSeed.inserted);
    }
    await disableScheduledReports(Client, primaryUrl, runId);
    evidence.canaryIds = {
      tenantId: seeded.tenantId,
      scheduleId: seeded.scheduleId,
      subscriptionId: seeded.subscriptionId,
      seededAt: seeded.seededAt,
      inserted: seeded.inserted,
      replayInserted: replayedSeed.inserted,
    };
    const allMinute1 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 1,
      seededAt: seeded.seededAt,
      timeoutMs: 120_000,
      logs: async () => '',
    });
    const allMinute1Runtime = await assertTopologyStable({
      context,
      roles: ['all'],
      expectedHttpRole: 'all',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'all',
    });
    const initialLedger = await waitFor(async () => {
      const rows = await maintenanceLedger(Client, primaryUrl, runId);
      try { ledgerCounts(rows); return rows; } catch { return false; }
    }, { timeoutMs: 60_000, intervalMs: 1000, label: 'initial compatibility maintenance ledger' });
    const allMinute5 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 5,
      seededAt: seeded.seededAt,
      timeoutMs: 360_000,
      logs: async () => '',
    });
    const allMinute5Runtime = await assertTopologyStable({
      context,
      roles: ['all'],
      expectedHttpRole: 'all',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'all',
    });
    const allMinute10 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 10,
      seededAt: seeded.seededAt,
      timeoutMs: 660_000,
      logs: () => runtimeLogStreams(tempRoot, 'all'),
    });
    const allMinute10Runtime = await assertTopologyStable({
      context,
      roles: ['all'],
      expectedHttpRole: 'all',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'all',
    });
    evidence.phases.push({
      topology: 'all-initial',
      readinessRole: 'all',
      minute1Digest: allMinute1.fingerprint.digest,
      minute1ObservedAt: allMinute1.observedAt,
      minute1ElapsedMs: allMinute1.elapsedMs,
      minute5Digest: allMinute5.fingerprint.digest,
      minute5ObservedAt: allMinute5.observedAt,
      minute5ElapsedMs: allMinute5.elapsedMs,
      minute10Digest: allMinute10.fingerprint.digest,
      minute10ObservedAt: allMinute10.observedAt,
      minute10ElapsedMs: allMinute10.elapsedMs,
      minute10AiLogBaselineAt: allMinute10.aiLogBaselineAt,
      minute10AiLogSummary: allMinute10.aiLogSummary,
      minute1Runtime: allMinute1Runtime,
      minute5Runtime: allMinute5Runtime,
      minute10Runtime: allMinute10Runtime,
    });

    await stopDeletePm2Apps(context, [appName(runId, 'all')]);
    await assertRuntimeReleased(Client, primaryUrl, runId, PORTS.api);
    assertRuntimeLogSafe(await runtimeLog(tempRoot, 'all'), 'all');

    note('阶段 2：PM2 三进程 split；API 独占入口，两个 Worker 各持一把锁。');
    await startPm2Apps(context, APP_ROLE_NAMES.slice(1).map(role => appName(runId, role)));
    await waitForTopologyReady(context, APP_ROLE_NAMES.slice(1), 'api');
    if (!await canBindPort(PORTS.scheduler) || !await canBindPort(PORTS.aiMedia)) {
      fail('P2EH_WORKER_PORT_BOUND', 'A Worker unexpectedly opened an HTTP listener.');
    }
    assertP2ehRoleLocks(await roleLocks(Client, primaryUrl, runId), 'split');
    const splitArmed = await rearmCanary(Client, primaryUrl, runId, seeded);
    const splitMinute1 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 1,
      seededAt: splitArmed.armedAt,
      timeoutMs: 120_000,
      logs: async () => '',
    });
    const splitMinute1Runtime = await assertTopologyStable({
      context,
      roles: APP_ROLE_NAMES.slice(1),
      expectedHttpRole: 'api',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'split',
    });
    const splitMinute5 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 5,
      seededAt: splitArmed.armedAt,
      timeoutMs: 360_000,
      logs: async () => '',
    });
    const splitMinute5Runtime = await assertTopologyStable({
      context,
      roles: APP_ROLE_NAMES.slice(1),
      expectedHttpRole: 'api',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'split',
    });
    const splitMinute10 = await waitForCanary({
      Client,
      databaseUrl: primaryUrl,
      runId,
      minute: 10,
      seededAt: splitArmed.armedAt,
      minimumElapsedMs: 0,
      timeoutMs: 660_000,
      logs: () => runtimeLogStreams(tempRoot, 'ai-media'),
    });
    const splitMinute10Runtime = await assertTopologyStable({
      context,
      roles: APP_ROLE_NAMES.slice(1),
      expectedHttpRole: 'api',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'split',
    });
    const splitLedger = await maintenanceLedger(Client, primaryUrl, runId);
    if (JSON.stringify(splitLedger) !== JSON.stringify(initialLedger)) {
      fail('P2EH_SPLIT_RAN_COMPAT_MAINTENANCE', 'Split topology changed compatibility maintenance ledger.');
    }
    evidence.phases.push({
      topology: 'split',
      readinessRole: 'api',
      rearmedAt: splitArmed.armedAt,
      minute1Digest: splitMinute1.fingerprint.digest,
      minute1ObservedAt: splitMinute1.observedAt,
      minute1ElapsedMs: splitMinute1.elapsedMs,
      minute5Digest: splitMinute5.fingerprint.digest,
      minute5ObservedAt: splitMinute5.observedAt,
      minute5ElapsedMs: splitMinute5.elapsedMs,
      nextTenMinuteAiCycleDigest: splitMinute10.fingerprint.digest,
      nextTenMinuteAiCycleObservedAt: splitMinute10.observedAt,
      nextTenMinuteAiCycleElapsedMs: splitMinute10.elapsedMs,
      nextTenMinuteAiCycleLogBaselineAt: splitMinute10.aiLogBaselineAt,
      nextTenMinuteAiCycleLogSummary: splitMinute10.aiLogSummary,
      minute1Runtime: splitMinute1Runtime,
      minute5Runtime: splitMinute5Runtime,
      nextTenMinuteAiCycleRuntime: splitMinute10Runtime,
    });

    await stopDeletePm2Apps(context, [appName(runId, 'scheduler'), appName(runId, 'ai-media')]);
    await stopDeletePm2Apps(context, [appName(runId, 'api')]);
    await assertRuntimeReleased(Client, primaryUrl, runId, PORTS.api);
    for (const role of APP_ROLE_NAMES.slice(1)) assertRuntimeLogSafe(await runtimeLog(tempRoot, role), role);

    note('阶段 3：回切单一 all，验证锁、readiness 与一次/重复 Maintenance 语义。');
    await startPm2Apps(context, [appName(runId, 'all')]);
    await waitForTopologyReady(context, ['all'], 'all');
    assertP2ehRoleLocks(await roleLocks(Client, primaryUrl, runId), 'all');
    const finalLedger = await waitFor(async () => {
      const rows = await maintenanceLedger(Client, primaryUrl, runId);
      try { compareFinalLedger(initialLedger, rows); return rows; } catch { return false; }
    }, { timeoutMs: 60_000, intervalMs: 1000, label: 'final compatibility maintenance ledger' });
    const finalFingerprint = await restoreCanaryFingerprint({ Client, databaseUrl: primaryUrl, runId });
    const finalRuntime = await assertTopologyStable({
      context,
      roles: ['all'],
      expectedHttpRole: 'all',
      Client,
      databaseUrl: primaryUrl,
      expectedLockRole: 'all',
    });
    evidence.phases.push({
      topology: 'all-restored',
      readinessRole: 'all',
      canaryDigest: finalFingerprint.digest,
      ledgerRows: finalLedger.length,
      runtime: finalRuntime,
    });
    await stopDeletePm2Apps(context, [appName(runId, 'all')]);
    await assertRuntimeReleased(Client, primaryUrl, runId, PORTS.api);

    note('制作 v067+canary 备份，恢复到第二个精确空库并启动独立 API 验证。');
    const finalBackupPath = path.join(tempRoot, 'backups/final-v067.dump');
    evidence.finalBackup = await dumpDatabase({ databaseName: primaryName, user: databaseUser, backupPath: finalBackupPath, tempRoot });
    await createExactDatabase({ Client, databaseName: restoreName, user: databaseUser, tempRoot });
    restoreCreated = true;
    await assertEmptyDatabase(Client, restoreUrl, restoreName, runId);
    await restoreDatabase({ databaseName: restoreName, user: databaseUser, backupPath: finalBackupPath, tempRoot });
    await runMaintenance({
      currentRelease,
      databaseUrl: restoreUrl,
      emptyEnv,
      mediaDir: path.join(tempRoot, 'media'),
      tempRoot,
      runId,
      guardPath: guardSnapshot,
      args: ['verify'],
      label: 'restored database Maintenance verify',
    });
    assertCurrentSnapshot(await migrationSnapshot(Client, restoreUrl, runId));
    const restoredFingerprint = await restoreCanaryFingerprint({
      Client,
      databaseUrl: restoreUrl,
      runId,
      restore: true,
    });
    if (restoredFingerprint.digest !== finalFingerprint.digest) {
      fail('P2EH_RESTORE_CANARY_MISMATCH', 'Restored canary fingerprint differs from the source database.');
    }
    const restoreApp = appName(runId, 'restore-api');
    await startPm2Apps(context, [restoreApp]);
    await waitForTopologyReady(context, ['restore-api'], 'api', { port: PORTS.restoreApi });
    const restoreRuntime = await assertTopologyStable({
      context,
      roles: ['restore-api'],
      expectedHttpRole: 'api',
      Client,
      databaseUrl: restoreUrl,
      expectedLockRole: 'none',
      port: PORTS.restoreApi,
    });
    await stopDeletePm2Apps(context, [restoreApp]);
    await assertRuntimeReleased(Client, restoreUrl, runId, PORTS.restoreApi);
    evidence.restore = { verified: true, canaryDigest: restoredFingerprint.digest, runtime: restoreRuntime };

    evidence.functionalCompletedAt = new Date().toISOString();
    note('所有演练门禁通过，开始精确清理本轮资源。');
  } catch (error) {
    failure = error;
    evidence.status = 'failed';
    evidence.failedAt = new Date().toISOString();
    evidence.error = {
      code: error?.code || 'P2EH_FAILED',
      message: credentialSafeText(error?.message || String(error)),
      command: error?.details?.label || null,
      exitCode: error?.details?.outcome?.code ?? null,
      stderr: credentialSafeText(error?.details?.outcome?.stderr || '').slice(0, 8000),
    };
    evidence.runtimeDiagnostics = {};
    for (const role of [...APP_ROLE_NAMES, 'sandbox-probe', 'restore-api']) {
      try {
        const log = await runtimeLog(tempRoot, role);
        if (log.trim()) evidence.runtimeDiagnostics[role] = credentialSafeText(log).slice(-8000);
      } catch {}
    }
    for (const [name, relativePath] of Object.entries({
      nginxError: 'nginx/logs/error.log',
      nginxLauncher: 'nginx/logs/launcher.err.log',
    })) {
      try {
        const filePath = path.join(tempRoot, relativePath);
        if (await exists(filePath)) {
          evidence.runtimeDiagnostics[name] = credentialSafeText(await readFile(filePath, 'utf8')).slice(-8000);
        }
      } catch {}
    }
  } finally {
    activeRehearsalAbortSignal = undefined;
    delete process.env.P2EH_FORBIDDEN_SENTINEL;
    const cleanupErrors = [];
    let nginxStopped = !nginxChild;
    let processesStopped = false;
    let portsReleased = false;
    let pm2HomeRemoved = !pm2HomeCreated;
    let pm2DaemonStopped = !pm2HomeCreated || !context;
    let tempRootRemoved = !tempRootCreated;
    let primaryExists = primaryCreated;
    let restoreExists = restoreCreated;
    if (context) {
      const allNames = [
        ...APP_ROLE_NAMES.map(role => appName(runId, role)),
        appName(runId, 'restore-api'),
        appName(runId, 'sandbox-probe'),
      ];
      try {
        for (const app of await pm2List(context)) {
          if (app.pid > 0) recordedPids.add(app.pid);
        }
      } catch (error) { cleanupErrors.push(error); }
      try { await stopDeletePm2Apps(context, allNames); } catch (error) { cleanupErrors.push(error); }
    }
    if (nginxChild?.pid) recordedPids.add(nginxChild.pid);
    try {
      nginxStopped = await stopNginx(nginxChild);
    } catch (error) { cleanupErrors.push(error); }
    if (context && pm2HomeCreated) {
      let pm2PidRecorded = true;
      let pm2KillSucceeded = false;
      try {
        await recordPm2DaemonPid(pm2Home, recordedPids);
      } catch (error) {
        pm2PidRecorded = false;
        cleanupErrors.push(error);
      }
      try {
        await pm2Command({...context, args: ['kill'], label: 'PM2 isolated daemon shutdown'});
        pm2KillSucceeded = true;
      } catch (error) { cleanupErrors.push(error); }
      pm2DaemonStopped = pm2PidRecorded && pm2KillSucceeded;
    }
    try {
      await assertRecordedProcessesGone(recordedPids);
      processesStopped = true;
    } catch (error) { cleanupErrors.push(error); }
    if (pm2HomeCreated && processesStopped && pm2DaemonStopped) {
      try {
        const exactPm2Prefix = '/tmp/onstar_p2eh_';
        if (!path.resolve(pm2Home).startsWith(exactPm2Prefix)) {
          throw new Error('PM2_HOME escaped the exact cleanup prefix');
        }
        await rm(pm2Home, { recursive: true, force: false });
        pm2HomeCreated = false;
        pm2HomeRemoved = !await exists(pm2Home);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (Client && databaseUser) {
      try {
        restoreExists = await databaseExists(Client, restoreName);
      } catch (error) { cleanupErrors.push(error); }
      if (restoreExists) {
        try {
          await dropExactDatabase({ Client, databaseName: restoreName, user: databaseUser, tempRoot, runId, recordedPids });
          restoreCreated = false;
          restoreExists = await databaseExists(Client, restoreName);
        } catch (error) { cleanupErrors.push(error); }
      }
      try {
        primaryExists = await databaseExists(Client, primaryName);
      } catch (error) { cleanupErrors.push(error); }
      if (primaryExists) {
        try {
          await dropExactDatabase({ Client, databaseName: primaryName, user: databaseUser, tempRoot, runId, recordedPids });
          primaryCreated = false;
          primaryExists = await databaseExists(Client, primaryName);
        } catch (error) { cleanupErrors.push(error); }
      }
    }
    try {
      await assertPortsAvailable(Object.values(PORTS));
      portsReleased = true;
    } catch (error) { cleanupErrors.push(error); }
    if (tempRootCreated && processesStopped && pm2DaemonStopped && !primaryExists && !restoreExists) {
      const expectedPrefix = `${path.resolve(tempParent)}${path.sep}`;
      if (!path.resolve(tempRoot).startsWith(expectedPrefix)) {
        cleanupErrors.push(new Error('temporary root escaped the exact cleanup prefix'));
      } else {
        try {
          await rm(tempRoot, { recursive: true, force: false });
          tempRootCreated = false;
          tempRootRemoved = !await exists(tempRoot);
        } catch (error) { cleanupErrors.push(error); }
      }
    }
    cleanupSucceeded = cleanupErrors.length === 0
      && !primaryExists
      && !restoreExists
      && nginxStopped
      && processesStopped
      && portsReleased
      && pm2DaemonStopped
      && pm2HomeRemoved
      && tempRootRemoved;
    if (!cleanupSucceeded && cleanupErrors.length === 0) {
      cleanupErrors.push(new P2ehLocalError(
        'P2EH_CLEANUP_INCOMPLETE',
        'One or more local rehearsal resources could not be proven absent.',
      ));
    }
    if (cleanupErrors.length && !failure) failure = cleanupErrors[0];
    if (failure) {
      evidence.status = 'failed';
      evidence.failedAt ||= new Date().toISOString();
      evidence.error ||= {
        code: failure?.code || 'P2EH_FAILED',
        message: credentialSafeText(failure?.message || String(failure)),
        command: failure?.details?.label || null,
        exitCode: failure?.details?.outcome?.code ?? null,
        stderr: credentialSafeText(failure?.details?.outcome?.stderr || '').slice(0, 8000),
      };
    } else {
      evidence.status = 'passed';
      evidence.completedAt = new Date().toISOString();
    }
    evidence.cleanup = {
      databasesRemoved: !primaryExists && !restoreExists,
      nginxStopped,
      processesStopped,
      portsReleased,
      pm2DaemonStopped,
      pm2HomeRemoved,
      tempRootRemoved,
      errors: cleanupErrors.map(error => ({
        code: error?.code || 'CLEANUP_FAILED',
        message: credentialSafeText(error?.message || String(error)),
      })),
    };
    if (evidenceParentCreated && evidenceWritable) {
      try {
        await writeFinalEvidence(evidencePath, evidence);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
    for (const [signalName, handler] of signalHandlers) {
      process.removeListener(signalName, handler);
    }
  }

  if (failure) {
    note(`失败：${failure.code || 'P2EH_FAILED'}；证据 ${evidencePath}`);
    throw failure;
  }
  if (!cleanupSucceeded) fail('P2EH_CLEANUP_INCOMPLETE', `Cleanup incomplete; evidence at ${evidencePath}.`);
  note(`通过并完成清理。脱敏证据：${evidencePath}`);
  return evidencePath;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help || (!args.execute && !args.preflightOnly)) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  if (args.preflightOnly) {
    process.umask(0o077);
    const tempRoot = path.join(repositoryRoot, '.tmp', 'p2eh-preflight');
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    await assertTools();
    await assertRepositoryBoundary(safeEnvironment(tempRoot));
    await validateTopologyManifests();
    await assertPortsAvailable(Object.values(PORTS));
    await preflightSandbox({
      sandboxExec: TOOLS.sandboxExec,
      nodeBin: TOOLS.node18,
      networkGuardPath: GUARD_PATH,
      loopbackPort: 5432,
    });
    note('preflight 通过；未创建数据库、未启动 PM2/Nginx。');
    return;
  }
  await runRehearsal();
}

await main().catch(error => {
  process.stderr.write(`[P2EH-Local] ${error?.code || 'FAILED'}: ${credentialSafeText(error?.message || String(error))}\n`);
  process.exitCode = 1;
});
