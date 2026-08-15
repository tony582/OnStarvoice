import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  maintenanceUsage,
  parseMaintenanceCommand,
  runMaintenanceCli,
} from '../server/maintenance/cli.js';
import { closeCsvImportResources } from '../server/scripts/import-extension-csv.js';
import { runCompatibilityDatabaseMaintenance } from '../server/maintenance/compatibility-startup.js';
import {
  COMPATIBILITY_STARTUP_TASK_GROUPS,
  createMaintenanceTaskRegistry,
  MAINTENANCE_TASK_IDS,
  STARTUP_RECONCILE_TASK_IDS,
} from '../server/maintenance/registry.js';
import {
  acquireMaintenanceTaskLock,
  createMaintenanceRunner,
} from '../server/maintenance/runner.js';

function quietLogger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

function fakeMaintenanceJobs(overrides = {}) {
  return {
    backfillRecentCovers: async () => 0,
    backfillRecentImages: async () => 0,
    ensureBootstrapAdmin: async () => ({ created: false, skipped: true }),
    execute: async () => ({ rowCount: 1 }),
    failStaleAnalyses: async () => 0,
    labelRecord: async () => {},
    parsePublishTimestamp: value => `parsed:${value}`,
    queryAll: async () => [],
    queryOne: async () => null,
    loadCommentWorkflow: async () => ({
      reprocessPendingComments: async () => 0,
      reclassifyComments: async () => ({ total: 0, changed: 0 }),
    }),
    runCommentsWorkflowBackfill: async () => ({ processed: 0 }),
    runLegacySqljsImport: async () => ({ skipped: true }),
    ...overrides,
  };
}

test('maintenance registry is a fixed allowlist with explicit startup ownership', () => {
  const registry = createMaintenanceTaskRegistry({
    jobs: fakeMaintenanceJobs(),
    logger: quietLogger(),
  });
  assert.deepEqual(Object.keys(registry).sort(), Object.values(MAINTENANCE_TASK_IDS).sort());
  assert.deepEqual(STARTUP_RECONCILE_TASK_IDS, [
    'publish-ts-backfill-v1',
    'opinion-analysis-stale-repair',
    'comment-promotion-reconcile',
    'comment-safety-semantic-reclassify-v1',
    'recent-media-backfill',
    'saicgm-scope-relabel-v3',
  ]);
  assert.equal(STARTUP_RECONCILE_TASK_IDS.includes('bootstrap-admin'), false);
  assert.equal(STARTUP_RECONCILE_TASK_IDS.includes('comments-workflow-backfill'), false);
  assert.equal(STARTUP_RECONCILE_TASK_IDS.includes('legacy-sqljs-import'), false);
  assert.equal(registry['comments-workflow-backfill'].requiresOfflineTopology, true);
  assert.equal(registry['legacy-sqljs-import'].requiresOfflineTopology, true);
  assert.equal(registry['legacy-sqljs-import'].kind, 'once');
  assert.equal(registry['legacy-sqljs-import'].retryRequiresRestore, true);
  assert.equal(registry['saicgm-scope-relabel-v3'].retryRequiresRestore, true);
  assert.deepEqual(
    registry['legacy-sqljs-import'].retryableFailureCodes,
    ['LEGACY_SQLJS_DATABASE_NOT_FOUND'],
  );
  assert.deepEqual(
    COMPATIBILITY_STARTUP_TASK_GROUPS.map(group => ({
      label: group.label,
      delayMs: group.delayMs,
      taskIds: [...group.taskIds],
    })),
    [
      {
        label: 'OpinionAnalysis',
        delayMs: 0,
        taskIds: ['opinion-analysis-stale-repair'],
      },
      {
        label: 'Reprocess',
        delayMs: 15_000,
        taskIds: [
          'comment-promotion-reconcile',
          'comment-safety-semantic-reclassify-v1',
        ],
      },
      {
        label: 'MediaBackfill',
        delayMs: 25_000,
        taskIds: ['recent-media-backfill'],
      },
      {
        label: 'Relabel',
        delayMs: 25_000,
        taskIds: ['saicgm-scope-relabel-v3'],
      },
    ],
  );
  assert.equal(
    registry[MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL].legacyMarker,
    'publish_ts_backfill_v1',
  );
  assert.equal(
    registry[MAINTENANCE_TASK_IDS.COMMENT_SAFETY_RECLASSIFY].legacyMarker,
    'comment_safety_semantic_reclassify_v1',
  );
  assert.equal(
    registry[MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL].legacyMarker,
    'relabel_saicgm_scope_v3',
  );
});

test('publish timestamp repair is owned by the registry without writing a legacy marker', async () => {
  const statements = [];
  const registry = createMaintenanceTaskRegistry({
    jobs: fakeMaintenanceJobs({
      queryAll: async sql => {
        if (/FROM records/u.test(sql)) {
          return [{ id: 'record-1', publish_time: '2026-01-02', created_at: 'fallback' }];
        }
        return [{ id: 'lead-1', published_at: '2026-01-03', captured_at: 'fallback' }];
      },
      execute: async (sql, params) => {
        statements.push({ sql, params });
        return { rowCount: 1 };
      },
    }),
    logger: quietLogger(),
  });

  const result = await registry[MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL].run();
  assert.deepEqual(result, { records: 1, commentLeads: 1 });
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].params, ['record-1', 'parsed:2026-01-02']);
  assert.deepEqual(statements[1].params, ['lead-1', 'parsed:2026-01-03']);
  assert.doesNotMatch(statements.map(item => item.sql).join('\n'), /schema_migrations/u);
});

test('blocking compatibility database maintenance runs only publish repair through the shared registry', async () => {
  const calls = [];
  const result = await runCompatibilityDatabaseMaintenance({
    jobs: fakeMaintenanceJobs(),
    logger: quietLogger(),
    async taskRunner(options) {
      calls.push(options);
      return { taskId: options.taskId, status: 'succeeded' };
    },
  });
  assert.equal(result.taskId, 'publish-ts-backfill-v1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'compatibility-startup');
  assert.equal(calls[0].task.id, 'publish-ts-backfill-v1');
});

test('partial SAIC-GM relabel failures fail the once task instead of marking success', async () => {
  const registry = createMaintenanceTaskRegistry({
    jobs: fakeMaintenanceJobs({
      queryAll: async () => [{ id: 'ok' }, { id: 'failed' }],
      labelRecord: async id => {
        if (id === 'failed') throw new Error('model unavailable');
      },
    }),
    logger: quietLogger(),
  });
  await assert.rejects(
    registry[MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL].run(),
    error => error.code === 'MAINTENANCE_TASK_PARTIAL_FAILURE',
  );
});

test('a failed SAIC-GM relabel cannot auto-retry during a later compatibility startup', async () => {
  let labelCalls = 0;
  let lockReleases = 0;
  const registry = createMaintenanceTaskRegistry({
    jobs: fakeMaintenanceJobs({
      queryAll: async () => [{ id: 'must-not-run' }],
      labelRecord: async () => { labelCalls += 1; },
    }),
    logger: quietLogger(),
  });
  const runner = createMaintenanceRunner({
    registry,
    findOne: async sql => {
      if (/status IN \('succeeded', 'adopted'\)/u.test(sql)) return null;
      if (/FROM schema_migrations/u.test(sql)) return null;
      if (/status = 'running'/u.test(sql)) {
        return { id: 'failed-saic-run', status: 'failed', error_code: 'MAINTENANCE_TASK_PARTIAL_FAILURE' };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    acquireLock: async () => ({
      async release() { lockReleases += 1; },
    }),
  });

  await assert.rejects(
    runner.runTask(MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL, {
      source: 'compatibility-startup',
    }),
    error => error.code === 'MAINTENANCE_TASK_RESTORE_REQUIRED',
  );
  assert.equal(labelCalls, 0);
  assert.equal(lockReleases, 1);
});

test('runner adopts a legacy marker without running or deleting the task', async () => {
  let taskCalls = 0;
  let lockReleases = 0;
  const writes = [];
  const task = Object.freeze({
    id: 'legacy-once',
    version: '1',
    kind: 'once',
    legacyMarker: 'legacy_marker_v1',
    requiresOfflineTopology: false,
    run: async () => { taskCalls += 1; },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async (sql, params) => {
      if (/FROM maintenance_runs/u.test(sql)) return null;
      if (/FROM schema_migrations/u.test(sql)) return { version: params[0] };
      if (/INSERT INTO maintenance_runs/u.test(sql)) {
        writes.push({ sql, params });
        return { id: 'adopted', status: 'adopted', result_summary: {} };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async () => { throw new Error('write should not be called'); },
    acquireLock: async () => ({
      async release() { lockReleases += 1; },
    }),
  });

  const result = await runner.runTask(task.id);
  assert.equal(result.status, 'adopted');
  assert.equal(taskCalls, 0);
  assert.equal(lockReleases, 1);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].sql, /DELETE|UPDATE schema_migrations/iu);
});

test('runner preserves the legacy rollback marker after a successful once task', async () => {
  const statements = [];
  let taskCalls = 0;
  const task = Object.freeze({
    id: 'bridged-once',
    version: '1',
    kind: 'once',
    legacyMarker: 'legacy_bridge_v1',
    requiresOfflineTopology: false,
    run: async () => {
      taskCalls += 1;
      return { changed: 1 };
    },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async (sql, params) => {
      statements.push({ sql, params });
      if (/FROM maintenance_runs/u.test(sql)) return null;
      if (/FROM schema_migrations/u.test(sql)) return null;
      if (/INSERT INTO maintenance_runs/u.test(sql)) return { id: 'run-bridge' };
      if (/WITH finished AS/u.test(sql)) return { updated_rows: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async () => { throw new Error('write should not be called'); },
    acquireLock: async () => ({ async release() {} }),
  });

  const result = await runner.runTask(task.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(taskCalls, 1);
  const atomicFinish = statements.find(item => /WITH finished AS/u.test(item.sql));
  assert.ok(atomicFinish);
  assert.match(atomicFinish.sql, /UPDATE maintenance_runs/u);
  assert.match(atomicFinish.sql, /rollback_marker AS/u);
  assert.match(atomicFinish.sql, /INSERT INTO schema_migrations/u);
  assert.deepEqual(atomicFinish.params, ['run-bridge', '{"changed":1}', 'legacy_bridge_v1']);
});

test('runner repairs a missing legacy rollback marker for a completed once task', async () => {
  const writes = [];
  let taskCalls = 0;
  const task = Object.freeze({
    id: 'completed-bridge',
    version: '1',
    kind: 'once',
    legacyMarker: 'legacy_completed_v1',
    requiresOfflineTopology: false,
    run: async () => { taskCalls += 1; },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async sql => {
      if (/FROM maintenance_runs/u.test(sql)) {
        return { id: 'completed', status: 'succeeded', result_summary: { changed: 1 } };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async (sql, params) => {
      writes.push({ sql, params });
      return { rowCount: 1 };
    },
    acquireLock: async () => ({ async release() {} }),
  });

  const result = await runner.runTask(task.id);
  assert.equal(result.status, 'skipped');
  assert.equal(taskCalls, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO schema_migrations/u);
  assert.deepEqual(writes[0].params, ['legacy_completed_v1']);
});

test('runner blocks a legacy import retry until its pre-task backup is restored', async () => {
  let taskCalls = 0;
  let lockReleases = 0;
  const task = Object.freeze({
    id: 'restore-before-retry',
    version: '1',
    kind: 'once',
    legacyMarker: null,
    requiresOfflineTopology: false,
    retryRequiresRestore: true,
    retryableFailureCodes: ['LEGACY_SQLJS_DATABASE_NOT_FOUND'],
    run: async () => { taskCalls += 1; },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async (sql, params) => {
      if (/status IN \('succeeded', 'adopted'\)/u.test(sql)) return null;
      if (/status = 'running'/u.test(sql)) {
        assert.deepEqual(params[2], ['LEGACY_SQLJS_DATABASE_NOT_FOUND']);
        return { id: 'failed-run', status: 'failed', error_code: 'IMPORT_FAILED' };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    acquireLock: async () => ({
      async release() { lockReleases += 1; },
    }),
  });

  await assert.rejects(
    runner.runTask(task.id),
    error => error.code === 'MAINTENANCE_TASK_RESTORE_REQUIRED',
  );
  assert.equal(taskCalls, 0);
  assert.equal(lockReleases, 1);

  const missingFileRetry = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async sql => {
      if (/status IN \('succeeded', 'adopted'\)/u.test(sql)) return null;
      if (/status = 'running'/u.test(sql)) return null;
      if (/INSERT INTO maintenance_runs/u.test(sql)) return { id: 'retry-run' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async () => ({ rowCount: 1 }),
    acquireLock: async () => ({ async release() {} }),
  });
  const retried = await missingFileRetry.runTask(task.id);
  assert.equal(retried.status, 'succeeded');
  assert.equal(taskCalls, 1);
});

test('runner records task failure and releases the task lock', async () => {
  const failure = new Error('repair failed');
  failure.code = 'REPAIR_FAILED';
  let lockReleases = 0;
  const updates = [];
  const task = Object.freeze({
    id: 'repeatable-repair',
    version: '1',
    kind: 'repeatable',
    legacyMarker: null,
    requiresOfflineTopology: false,
    run: async () => { throw failure; },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async sql => {
      if (/INSERT INTO maintenance_runs/u.test(sql)) return { id: 'run-1' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async (sql, params) => {
      updates.push({ sql, params });
      return { rowCount: 1 };
    },
    acquireLock: async () => ({
      async release() { lockReleases += 1; },
    }),
  });

  await assert.rejects(runner.runTask(task.id), failure);
  assert.equal(lockReleases, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'failed');
  assert.equal(updates[0].params[3], 'REPAIR_FAILED');
});

test('runner refuses to report business success when the success audit updates zero rows', async () => {
  let taskCalls = 0;
  const task = Object.freeze({
    id: 'audited-repair',
    version: '1',
    kind: 'repeatable',
    legacyMarker: null,
    requiresOfflineTopology: false,
    run: async () => {
      taskCalls += 1;
      return { changed: 1 };
    },
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    findOne: async sql => {
      if (/INSERT INTO maintenance_runs/u.test(sql)) return { id: 'run-zero' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    write: async () => ({ rowCount: 0 }),
    acquireLock: async () => ({ release: async () => {} }),
  });
  await assert.rejects(
    runner.runTask(task.id),
    error => error.code === 'MAINTENANCE_AUDIT_UPDATE_FAILED',
  );
  assert.equal(taskCalls, 1);
});

test('runner rejects offline tasks before acquiring a task lock', async () => {
  let lockCalls = 0;
  const task = Object.freeze({
    id: 'offline-repair',
    version: '1',
    kind: 'repeatable',
    legacyMarker: null,
    requiresOfflineTopology: true,
    run: async () => ({}),
  });
  const runner = createMaintenanceRunner({
    registry: Object.freeze({ [task.id]: task }),
    acquireLock: async () => {
      lockCalls += 1;
      return { release: async () => {} };
    },
  });
  await assert.rejects(
    runner.runTask(task.id),
    error => error.code === 'MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED',
  );
  assert.equal(lockCalls, 0);
});

test('task advisory lock uses a dedicated client and verifies unlock ownership', async () => {
  const events = [];
  const client = {
    async connect() { events.push('connect'); },
    async query(config) {
      events.push(config.text);
      if (/pg_try_advisory_lock/u.test(config.text)) return { rows: [{ acquired: true }] };
      return { rows: [{ released: true }] };
    },
    async end() { events.push('end'); },
  };
  const lock = await acquireMaintenanceTaskLock({
    task: { id: 'task-a', version: '1' },
    databaseUrl: 'postgresql://redacted.invalid/onstarvoice',
    createClient(options) {
      assert.match(options.application_name, /^onstarvoice:maintenance-task:task-a:/u);
      return client;
    },
  });
  await lock.release();
  await lock.release();
  assert.equal(events.filter(event => event === 'connect').length, 1);
  assert.equal(events.filter(event => /pg_try_advisory_lock/u.test(event)).length, 1);
  assert.equal(events.filter(event => /pg_advisory_unlock/u.test(event)).length, 1);
  assert.equal(events.filter(event => event === 'end').length, 1);
});

test('task advisory lock fails when PostgreSQL does not confirm unlock', async () => {
  const client = {
    async connect() {},
    async query(config) {
      if (/pg_try_advisory_lock/u.test(config.text)) return { rows: [{ acquired: true }] };
      return { rows: [{ released: false }] };
    },
    async end() {},
  };
  const lock = await acquireMaintenanceTaskLock({
    task: { id: 'task-b', version: '1' },
    createClient: () => client,
  });
  await assert.rejects(
    lock.release(),
    error => error.code === 'MAINTENANCE_TASK_UNLOCK_FAILED',
  );
});

test('CLI parser accepts only the fixed command grammar', () => {
  assert.deepEqual(parseMaintenanceCommand(['migrate']), {
    command: 'migrate',
    adoptLegacyChecksums: false,
  });
  assert.deepEqual(parseMaintenanceCommand(['migrate', '--adopt-v066-checksums']), {
    command: 'migrate',
    adoptLegacyChecksums: true,
  });
  assert.deepEqual(parseMaintenanceCommand(['run', 'recent-media-backfill']), {
    command: 'run',
    taskId: 'recent-media-backfill',
  });
  assert.throws(() => parseMaintenanceCommand(['migrate', '--directory', '/tmp/sql']));
  assert.throws(() => parseMaintenanceCommand(['run', 'task', '--file', '/tmp/repair.sql']));
  assert.throws(() => parseMaintenanceCommand(['unknown']));
  assert.doesNotMatch(maintenanceUsage(), /--file|--directory/u);
});

test('maintenance migrate passes the one explicit checksum-adoption flag', async () => {
  const calls = [];
  const result = await runMaintenanceCli({
    argv: ['migrate', '--adopt-v066-checksums'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    migrationCore: {
      async runMigrations(options) {
        calls.push(options);
        return { migrated: 1 };
      },
      async verifyMigrations() { throw new Error('not expected'); },
    },
    closeDatabase: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{ adoptLegacyChecksums: true }]);
});

test('production maintenance rejects a missing database URL before locks or database work', async () => {
  for (const [nodeEnv, databaseUrl] of [
    ['production', undefined],
    [' Production ', '   '],
  ]) {
    let migrationCalls = 0;
    let executionLockCalls = 0;
    let closeCalls = 0;
    const env = {
      NODE_ENV: nodeEnv,
      PROCESS_ROLE: 'maintenance',
    };
    if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
    const result = await runMaintenanceCli({
      argv: ['verify'],
      env,
      logger: quietLogger(),
      migrationCore: {
        async runMigrations() { migrationCalls += 1; },
        async verifyMigrations() { migrationCalls += 1; },
      },
      acquireExecutionLocks: async () => {
        executionLockCalls += 1;
        return { release: async () => {} };
      },
      closeDatabase: async () => { closeCalls += 1; },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.error.code, 'MAINTENANCE_DATABASE_URL_REQUIRED');
    assert.equal(migrationCalls, 0);
    assert.equal(executionLockCalls, 0);
    assert.equal(closeCalls, 0);
  }
});

test('production maintenance role mismatch fails before migration work', async () => {
  let migrationCalls = 0;
  let closeCalls = 0;
  const result = await runMaintenanceCli({
    argv: ['migrate'],
    env: { NODE_ENV: 'production', PROCESS_ROLE: 'all' },
    logger: quietLogger(),
    migrationCore: {
      async runMigrations() { migrationCalls += 1; },
      async verifyMigrations() {},
    },
    closeDatabase: async () => { closeCalls += 1; },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'PROCESS_ROLE_ENTRYPOINT_MISMATCH');
  assert.equal(migrationCalls, 0);
  assert.equal(closeCalls, 0);
});

test('offline CLI work requires confirmation and both execution-role locks', async () => {
  const registry = createMaintenanceTaskRegistry({
    jobs: fakeMaintenanceJobs(),
    logger: quietLogger(),
  });
  let executionLockCalls = 0;
  let executionLockReleases = 0;
  let runnerCalls = 0;
  let rejectedCloseCalls = 0;
  const runner = {
    async runTasks(taskIds, options) {
      runnerCalls += 1;
      assert.deepEqual(taskIds, STARTUP_RECONCILE_TASK_IDS);
      assert.equal(options.offlineConfirmed, true);
      return [];
    },
  };

  const rejected = await runMaintenanceCli({
    argv: ['startup-reconcile'],
    env: { NODE_ENV: 'production', PROCESS_ROLE: 'maintenance' },
    logger: quietLogger(),
    registry,
    runner,
    acquireExecutionLocks: async () => {
      executionLockCalls += 1;
      return { release: async () => {} };
    },
    closeDatabase: async () => { rejectedCloseCalls += 1; },
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.error.code, 'MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED');
  assert.equal(executionLockCalls, 0);
  assert.equal(rejectedCloseCalls, 0);

  const accepted = await runMaintenanceCli({
    argv: ['startup-reconcile'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      MAINTENANCE_OFFLINE_CONFIRMED: '1',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    registry,
    runner,
    migrationCore: {
      async runMigrations() { throw new Error('not expected'); },
      async verifyMigrations() { return { ready: true }; },
    },
    acquireExecutionLocks: async options => {
      executionLockCalls += 1;
      assert.equal(options.role, 'all');
      assert.equal(typeof options.onLockLost, 'function');
      return {
        async release() { executionLockReleases += 1; },
      };
    },
    closeDatabase: async () => {},
  });
  assert.equal(accepted.exitCode, 0);
  assert.equal(runnerCalls, 1);
  assert.equal(executionLockCalls, 1);
  assert.equal(executionLockReleases, 1);

  const failureEvents = [];
  const rejectedByChecksum = await runMaintenanceCli({
    argv: ['startup-reconcile'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      MAINTENANCE_OFFLINE_CONFIRMED: '1',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    registry,
    runner: {
      async runTasks() { failureEvents.push('runner'); },
    },
    migrationCore: {
      async runMigrations() { throw new Error('not expected'); },
      async verifyMigrations() {
        failureEvents.push('verify');
        const error = new Error('checksum mismatch');
        error.code = 'DATABASE_MIGRATION_CHECKSUM_MISMATCH';
        throw error;
      },
    },
    acquireExecutionLocks: async () => {
      failureEvents.push('lock');
      return {
        async release() { failureEvents.push('release'); },
      };
    },
    closeDatabase: async () => { failureEvents.push('close'); },
  });
  assert.equal(rejectedByChecksum.exitCode, 1);
  assert.equal(rejectedByChecksum.error.code, 'DATABASE_MIGRATION_CHECKSUM_MISMATCH');
  assert.deepEqual(failureEvents, ['lock', 'verify', 'close', 'release']);
});

test('help and parse errors do not initialize or close the database pool', async () => {
  let closeCalls = 0;
  let roleCalls = 0;
  const dependencies = {
    env: { NODE_ENV: 'production' },
    logger: quietLogger(),
    resolveRole: () => { roleCalls += 1; },
    closeDatabase: async () => { closeCalls += 1; },
  };
  const help = await runMaintenanceCli({ ...dependencies, argv: ['help'] });
  const invalid = await runMaintenanceCli({ ...dependencies, argv: ['unknown'] });
  assert.equal(help.exitCode, 0);
  assert.equal(invalid.exitCode, 2);
  assert.equal(roleCalls, 0);
  assert.equal(closeCalls, 0);
});

test('unknown allowlist task fails before execution locks or pool cleanup', async () => {
  let executionLockCalls = 0;
  let closeCalls = 0;
  const result = await runMaintenanceCli({
    argv: ['run', 'repair-from-user-path'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      MAINTENANCE_OFFLINE_CONFIRMED: '1',
    },
    logger: quietLogger(),
    acquireExecutionLocks: async () => {
      executionLockCalls += 1;
      return { release: async () => {} };
    },
    closeDatabase: async () => { closeCalls += 1; },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'MAINTENANCE_TASK_UNKNOWN');
  assert.equal(executionLockCalls, 0);
  assert.equal(closeCalls, 0);
});

test('database close failure changes a successful CLI command to non-zero and fail-fast exit', async () => {
  const exitCodes = [];
  const result = await runMaintenanceCli({
    argv: ['verify'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    migrationCore: {
      async runMigrations() {},
      async verifyMigrations() { return { ready: true }; },
    },
    closeDatabase: async () => { throw new Error('pool close failed'); },
    exitProcess: code => { exitCodes.push(code); },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.error.message, /pool close failed/u);
  assert.deepEqual(exitCodes, [1]);
});

test('offline CLI closes the database before releasing execution locks', async () => {
  const events = [];
  const result = await runMaintenanceCli({
    argv: ['startup-reconcile'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      MAINTENANCE_OFFLINE_CONFIRMED: '1',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    runner: {
      async runTasks() {
        events.push('run');
        return [];
      },
    },
    migrationCore: {
      async runMigrations() { throw new Error('not expected'); },
      async verifyMigrations() { events.push('verify'); },
    },
    acquireExecutionLocks: async () => {
      events.push('lock');
      return {
        async release() { events.push('release'); },
      };
    },
    closeDatabase: async () => { events.push('close'); },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, ['lock', 'verify', 'run', 'close', 'release']);
});

test('offline CLI retains execution locks on database close failure without masking the command error', async () => {
  const events = [];
  const commandError = new Error('task failed');
  const closeError = new Error('pool close failed');
  const result = await runMaintenanceCli({
    argv: ['startup-reconcile'],
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'maintenance',
      MAINTENANCE_OFFLINE_CONFIRMED: '1',
      DATABASE_URL: 'postgresql://redacted.invalid/onstarvoice',
    },
    logger: quietLogger(),
    runner: {
      async runTasks() {
        events.push('run');
        throw commandError;
      },
    },
    migrationCore: {
      async runMigrations() { throw new Error('not expected'); },
      async verifyMigrations() { events.push('verify'); },
    },
    acquireExecutionLocks: async () => {
      events.push('lock');
      return {
        async release() { events.push('release'); },
      };
    },
    closeDatabase: async () => {
      events.push('close');
      throw closeError;
    },
    exitProcess: code => { events.push(`exit:${code}`); },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.error instanceof AggregateError);
  assert.strictEqual(result.error.errors[0], commandError);
  assert.strictEqual(result.error.errors[1], closeError);
  assert.deepEqual(events, ['lock', 'verify', 'run', 'close', 'exit:1']);
});

test('CSV importer closes the database before releasing execution locks', async () => {
  const events = [];
  await closeCsvImportResources({
    closeDatabase: async () => { events.push('close'); },
    executionLock: {
      async release() { events.push('release'); },
    },
  });
  assert.deepEqual(events, ['close', 'release']);
});

test('CSV importer retains execution locks on close failure without masking the import error', async () => {
  const events = [];
  const importError = new Error('import failed');
  const closeError = new Error('pool close failed');
  await assert.rejects(
    closeCsvImportResources({
      closeDatabase: async () => {
        events.push('close');
        throw closeError;
      },
      executionLock: {
        async release() { events.push('release'); },
      },
      primaryError: importError,
    }),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], importError);
      assert.strictEqual(error.errors[1], closeError);
      assert.match(error.message, /import failed/u);
      assert.match(error.message, /pool close failed/u);
      return true;
    },
  );
  assert.deepEqual(events, ['close']);
});

test('maintenance schema, entrypoint, and package scripts preserve the transient CLI boundary', async () => {
  const [migration, entrypoint, packageText, cliSource] = await Promise.all([
    readFile(new URL('../server/db/migrations/067_maintenance_runs.sql', import.meta.url), 'utf8'),
    readFile(new URL('../server/entrypoints/maintenance.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/package.json', import.meta.url), 'utf8'),
    readFile(new URL('../server/maintenance/cli.js', import.meta.url), 'utf8'),
  ]);
  const packageConfig = JSON.parse(packageText);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS maintenance_runs/u);
  assert.match(migration, /run_kind = 'once' AND status IN \('succeeded', 'adopted'\)/u);
  assert.match(migration, /legacy_marker TEXT/u);
  assert.match(entrypoint, /runMaintenanceCli/u);
  assert.doesNotMatch(entrypoint, /runProcessEntrypoint|listen\(|startCron/u);
  assert.equal(packageConfig.scripts.maintenance, 'node entrypoints/maintenance.js');
  assert.equal(packageConfig.scripts.migrate, 'node entrypoints/maintenance.js migrate');
  assert.equal(
    packageConfig.scripts['migrate:legacy'],
    'node entrypoints/maintenance.js run legacy-sqljs-import',
  );
  assert.equal(
    packageConfig.scripts['comments:backfill'],
    'node entrypoints/maintenance.js run comments-workflow-backfill',
  );
  assert.doesNotMatch(cliSource, /migrationDirectory|--directory|--file/u);
});

test('operator data scripts stay behind the explicit maintenance boundary', async () => {
  const [adminSource, legacySource, commentsSource, csvImportSource, commentWorkflowSource] = await Promise.all([
    readFile(new URL('../server/scripts/create-platform-admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/scripts/migrate-sqljs-to-postgres.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/scripts/backfill-comments-workflow.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/scripts/import-extension-csv.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/comment-workflow.js', import.meta.url), 'utf8'),
  ]);

  assert.match(adminSource, /resolveEntrypointProcessRole/u);
  assert.match(adminSource, /expectedRole: 'maintenance'/u);
  assert.match(adminSource, /assertProductionDatabaseUrl/u);
  assert.match(adminSource, /connectRuntimeDb/u);
  assert.doesNotMatch(adminSource, /\binitDb\b/u);
  for (const [source, exportedJob] of [
    [legacySource, 'runLegacySqljsImport'],
    [commentsSource, 'runCommentsWorkflowBackfill'],
  ]) {
    assert.match(source, new RegExp(`export async function ${exportedJob}`, 'u'));
    assert.match(source, /Direct execution is disabled/u);
    assert.doesNotMatch(source, /connectRuntimeDb|\binitDb\b/u);
  }
  assert.match(legacySource, /ON CONFLICT \(id\) DO UPDATE/u);
  assert.match(legacySource, /LEGACY_SQLJS_DATABASE_NOT_FOUND/u);
  assert.match(legacySource, /localizeMedia: false/u);
  assert.match(commentsSource, /preserveExisting: true/u);
  assert.match(commentWorkflowSource, /if \(preserveExisting\)/u);
  assert.match(commentWorkflowSource, /else if \(!result\.preserved\) updated \+= 1/u);
  assert.match(csvImportSource, /expectedRole: 'maintenance'/u);
  assert.match(csvImportSource, /assertProductionDatabaseUrl/u);
  assert.match(csvImportSource, /MAINTENANCE_OFFLINE_CONFIRMED/u);
  assert.match(csvImportSource, /acquireProcessRoleLocks/u);
  assert.match(csvImportSource, /connectRuntimeDb/u);
  assert.match(csvImportSource, /localizeMedia: false/u);
  assert.doesNotMatch(csvImportSource, /\binitDb\b/u);
});
