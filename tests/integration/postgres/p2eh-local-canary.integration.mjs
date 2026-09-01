import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createP2ehLocalCanaryPlan,
  inspectP2ehLocalCanary,
  seedP2ehLocalCanary,
} from '../../../scripts/lib/p2eh-local-canary.mjs';
import {
  isAllowedPostgresIntegrationServerAddress,
  validatePostgresIntegrationTarget,
} from '../../../scripts/lib/postgres-integration-target.mjs';
import {loadMigrationInventory} from '../../../server/db/migration-inventory.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const requireFromServer = createRequire(path.join(repositoryRoot, 'server', 'package.json'));
const {Client, Pool} = requireFromServer('pg');

function quoteIdentifier(identifier) {
  assert.match(identifier, /^p2eh_canary_[a-f0-9]{24}$/u);
  return `"${identifier}"`;
}

function logicalCanaryUrl(rawUrl, runId) {
  const logicalUrl = new URL(rawUrl);
  logicalUrl.pathname = `/onstarvoice_test_p2eh_${runId}`;
  return logicalUrl.toString();
}

function rewritePublicCanarySql(sql, quotedSchema) {
  const rewritten = sql.replaceAll('"public".', `${quotedSchema}.`);
  assert.notEqual(rewritten, sql, 'expected a schema-qualified P2-E-HL canary query');
  assert.doesNotMatch(rewritten, /"public"\./u);
  return rewritten;
}

async function prepareMigratedSchema(pool, schema) {
  const quotedSchema = quoteIdentifier(schema);
  await pool.query(`CREATE SCHEMA ${quotedSchema}`);

  // Keep the extension outside the disposable schema. The real migrations still
  // execute unchanged below; their IF NOT EXISTS statement becomes a no-op.
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
  const migrations = await loadMigrationInventory();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
    for (const migration of migrations) await client.query(migration.sql);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function assertPhysicalTarget(client, target, schema) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
       inet_server_addr()::text AS server_address,
       to_regnamespace($1) IS NOT NULL AS schema_exists`,
    [schema],
  );
  const row = result.rows[0];
  assert.equal(row.database_name, target.databaseName);
  assert.equal(
    isAllowedPostgresIntegrationServerAddress({
      serverAddress: row.server_address,
      target,
    }),
    true,
    `unexpected PostgreSQL server address ${String(row.server_address)} for ` +
      `${target.databaseUrl.hostname}:${target.databaseUrl.port}/${target.databaseName}`,
  );
  assert.equal(row.schema_exists, true);
}

function boundCanaryQuery({client, target, schema, logicalDatabaseName, onSeedMutation}) {
  const quotedSchema = quoteIdentifier(schema);
  return async (sql, params = []) => {
    if (/current_database\(\) AS database_name/u.test(sql)) {
      await assertPhysicalTarget(client, target, schema);
      return {
        rows: [{
          database_name: logicalDatabaseName,
          server_address: '127.0.0.1',
          schema_exists: true,
        }],
      };
    }

    const result = await client.query(rewritePublicCanarySql(sql, quotedSchema), params);
    if (/^WITH seeded_tenant AS/u.test(sql.trim())) onSeedMutation?.(result.rows[0] || {});
    return result;
  };
}

function canaryExecutor({pool, target, schema}) {
  const query = async ({runId, operation}) => {
    const logicalUrl = logicalCanaryUrl(target.rawUrl, runId);
    const logicalDatabaseName = new URL(logicalUrl).pathname.slice(1);
    const client = await pool.connect();
    try {
      return await operation({
        logicalUrl,
        query: boundCanaryQuery({client, target, schema, logicalDatabaseName}),
      });
    } finally {
      client.release();
    }
  };

  const transaction = async ({runId, operation, onSeedMutation}) => {
    const logicalUrl = logicalCanaryUrl(target.rawUrl, runId);
    const logicalDatabaseName = new URL(logicalUrl).pathname.slice(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
      const result = await operation({
        logicalUrl,
        query: boundCanaryQuery({
          client,
          target,
          schema,
          logicalDatabaseName,
          onSeedMutation,
        }),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  const seed = ({runId, now, onSeedMutation}) => transaction({
    runId,
    onSeedMutation,
    operation: ({logicalUrl, query: transactionQuery}) => seedP2ehLocalCanary({
      transaction: callback => callback(transactionQuery),
      testDatabaseUrl: logicalUrl,
      databaseUrl: logicalUrl,
      runId,
      schema: 'public',
      now,
    }),
  });

  const inspect = runId => query({
    runId,
    operation: ({logicalUrl, query: inspectionQuery}) => inspectP2ehLocalCanary({
      query: inspectionQuery,
      testDatabaseUrl: logicalUrl,
      databaseUrl: logicalUrl,
      runId,
      schema: 'public',
    }),
  });

  return Object.freeze({inspect, seed});
}

async function exactCanaryCounts(pool, schema, plan) {
  const quotedSchema = quoteIdentifier(schema);
  const result = await pool.query(`SELECT
    (SELECT count(*)::integer FROM ${quotedSchema}.tenants WHERE id = $1::uuid) AS tenants,
    (SELECT count(*)::integer FROM ${quotedSchema}.capture_tasks WHERE id = $2::uuid) AS templates,
    (SELECT count(*)::integer FROM ${quotedSchema}.capture_orchestration_schedules WHERE id = $3::uuid) AS schedules,
    (SELECT count(*)::integer FROM ${quotedSchema}.monitor_subscriptions WHERE id = $4::uuid) AS subscriptions`, [
    plan.tenantId,
    plan.templateTaskId,
    plan.scheduleId,
    plan.subscriptionId,
  ]);
  return result.rows[0];
}

test('P2-E-HL canary seed is atomic and idempotent in real PostgreSQL', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 24);
  const schema = `p2eh_canary_${token}`;
  const applicationName = `p2eh-canary-${token}`;
  const pool = new Pool({
    connectionString: target.rawUrl,
    application_name: applicationName,
    max: 2,
  });

  t.after(async () => {
    const errors = [];
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      const namespace = await pool.query('SELECT to_regnamespace($1) AS namespace', [schema]);
      assert.equal(namespace.rows[0].namespace, null, 'P2-E-HL canary schema was not removed');
    } catch (error) {
      errors.push(error);
    }
    try { await pool.end(); } catch (error) { errors.push(error); }

    const verifier = new Client({
      connectionString: target.rawUrl,
      application_name: `${applicationName}-cleanup`,
    });
    try {
      await verifier.connect();
      const active = await verifier.query(`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity
        WHERE application_name = $1
      `, [applicationName]);
      assert.equal(active.rows[0].count, 0, 'P2-E-HL canary left a PostgreSQL session open');
    } catch (error) {
      errors.push(error);
    } finally {
      try { await verifier.end(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'P2-E-HL canary cleanup failed');
  });

  await prepareMigratedSchema(pool, schema);
  const executor = canaryExecutor({pool, target, schema});
  const now = '2026-08-16T00:00:30.000Z';
  const runId = `canary_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  const first = await executor.seed({runId, now});
  assert.deepEqual(first.inserted, {
    tenant: true,
    template: true,
    schedule: true,
    subscription: true,
  });

  const replay = await executor.seed({runId, now});
  assert.deepEqual(replay.inserted, {
    tenant: false,
    template: false,
    schedule: false,
    subscription: false,
  });

  const fingerprint = await executor.inspect(runId);
  assert.equal(fingerprint.runId, runId);
  assert.equal(fingerprint.lineage.tenantExists, true);
  assert.equal(fingerprint.lineage.templateExists, true);
  assert.equal(fingerprint.lineage.scheduleExists, true);
  assert.equal(fingerprint.lineage.scheduleStatus, 'active');
  assert.equal(fingerprint.creator.exists, true);
  assert.equal(fingerprint.creator.status, 'active');
  assert.deepEqual(fingerprint.counts, {
    extraTasks: 0,
    items: 0,
    itemAttempts: 0,
    commands: 0,
    agents: 0,
    monitorExecutions: 0,
    records: 0,
    pendingAi: 0,
    aiFailovers: 0,
    prefilterRequests: 0,
  });

  const collisionRunId = `collision_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const collisionSeed = await executor.seed({runId: collisionRunId, now});
  const collisionPlan = createP2ehLocalCanaryPlan({
    runId: collisionRunId,
    schema: 'public',
    now,
  });
  assert.deepEqual(collisionSeed.inserted, {
    tenant: true,
    template: true,
    schedule: true,
    subscription: true,
  });

  const quotedSchema = quoteIdentifier(schema);
  await pool.query(`DELETE FROM ${quotedSchema}.monitor_subscriptions WHERE id = $1::uuid`, [
    collisionPlan.subscriptionId,
  ]);
  await pool.query(`
    UPDATE ${quotedSchema}.capture_orchestration_schedules
    SET plan_snapshot = jsonb_build_object(
      'p2ehLocalCanary', true,
      'p2ehRunId', 'wrong_marker'
    )
    WHERE id = $1::uuid
  `, [collisionPlan.scheduleId]);
  const beforeCollision = await exactCanaryCounts(pool, schema, collisionPlan);
  assert.deepEqual(beforeCollision, {
    tenants: 1,
    templates: 1,
    schedules: 1,
    subscriptions: 0,
  });

  let tentativeSubscriptionInserted = false;
  await assert.rejects(
    executor.seed({
      runId: collisionRunId,
      now,
      onSeedMutation(row) {
        tentativeSubscriptionInserted = row.subscription_inserted === true;
      },
    }),
    error => error?.code === 'seed_collision',
  );
  assert.equal(
    tentativeSubscriptionInserted,
    true,
    'collision transaction did not exercise a partial write before rollback',
  );
  assert.deepEqual(await exactCanaryCounts(pool, schema, collisionPlan), beforeCollision);
  const marker = await pool.query(`
    SELECT plan_snapshot->>'p2ehRunId' AS run_id
    FROM ${quotedSchema}.capture_orchestration_schedules
    WHERE id = $1::uuid
  `, [collisionPlan.scheduleId]);
  assert.equal(marker.rows[0].run_id, 'wrong_marker');
});
