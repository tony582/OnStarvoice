import assert from 'node:assert/strict';
import test from 'node:test';

import {
  P2EH_CREATOR_NO_AGENT_ERROR,
  assertP2ehLocalCheckpoint,
  assertP2ehLocalMinute1,
  assertP2ehLocalMinute5,
  assertP2ehLocalMinute10,
  createP2ehLocalCanaryPlan,
  inspectP2ehLocalCanary,
  seedP2ehLocalCanary,
  summarizeP2ehLocalAiLogs,
  validateP2ehLocalCanaryTarget,
} from '../scripts/lib/p2eh-local-canary.mjs';

const runId = 'run_20260816_001';
const databaseUrl = `postgresql://tester:secret@127.0.0.1:5432/onstarvoice_test_p2eh_${runId}`;
const restoreDatabaseUrl = `${databaseUrl}_restore`;
const schema = 'public';

function transactionUsing(query) {
  return async operation => operation(query);
}

function targetRow(overrides = {}) {
  return {
    rows: [{
      database_name: `onstarvoice_test_p2eh_${runId}`,
      server_address: '127.0.0.1',
      schema_exists: true,
      ...overrides,
    }],
  };
}

function validFingerprint(overrides = {}) {
  const fingerprint = {
    runId,
    lineage: {
      tenantExists: true,
      templateExists: true,
      scheduleExists: true,
      scheduleStatus: 'active',
      lastRunStatus: 'failed_template',
      errorCode: 'schedule_assignment_incomplete',
      lastRunAt: '2026-08-16T00:01:00.000Z',
      lastScheduledFor: '2026-08-16T00:00:00.000Z',
      runCount: 0,
    },
    creator: {
      exists: true,
      status: 'active',
      assignedAgentId: null,
      lastError: P2EH_CREATOR_NO_AGENT_ERROR,
      updatedAt: '2026-08-16T00:05:00.000Z',
    },
    counts: {
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
    },
  };
  return {
    ...fingerprint,
    ...overrides,
    lineage: {...fingerprint.lineage, ...overrides.lineage},
    creator: {...fingerprint.creator, ...overrides.creator},
    counts: {...fingerprint.counts, ...overrides.counts},
  };
}

test('plan uses deterministic exact runId markers and isolated identifiers', () => {
  const first = createP2ehLocalCanaryPlan({
    runId,
    schema,
    now: '2026-08-16T00:00:30.000Z',
  });
  const second = createP2ehLocalCanaryPlan({
    runId,
    schema,
    now: '2026-08-16T01:00:00.000Z',
  });

  assert.equal(first.runId, runId);
  assert.equal(first.dueAt, '2026-08-16T00:00:00.000Z');
  assert.equal(first.tenantId, second.tenantId);
  assert.equal(first.templateTaskId, second.templateTaskId);
  assert.equal(first.scheduleId, second.scheduleId);
  assert.equal(first.subscriptionId, second.subscriptionId);
  assert.match(first.tenantId, /^[0-9a-f-]{36}$/u);
});

test('target guard refuses production names, remote hosts, and arbitrary schemas', () => {
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: 'postgresql://localhost/onstarvoice',
      schema,
      runId,
    }),
    /localhost database named onstarvoice_ci/u,
  );
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: 'postgresql://db.example.com/onstarvoice_test_p2eh',
      schema,
      runId,
    }),
    /localhost database named onstarvoice_ci/u,
  );
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: databaseUrl,
      schema: 'tenant_live',
      runId,
    }),
    error => error.code === 'unsafe_schema',
  );
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: 'postgresql://localhost/onstarvoice_test_p2eh_another_run',
      schema,
      runId,
    }),
    error => error.code === 'database_run_id_mismatch',
  );
  assert.equal(
    validateP2ehLocalCanaryTarget({
      testDatabaseUrl: restoreDatabaseUrl,
      schema,
      runId,
      restore: true,
    }).databaseName,
    `onstarvoice_test_p2eh_${runId}_restore`,
  );
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: restoreDatabaseUrl,
      schema,
      runId,
    }),
    error => error.code === 'database_run_id_mismatch',
  );
  assert.throws(
    () => validateP2ehLocalCanaryTarget({
      testDatabaseUrl: `${databaseUrl}_restore_extra`,
      schema,
      runId,
      restore: true,
    }),
    error => error.code === 'database_run_id_mismatch',
  );
  assert.throws(
    () => createP2ehLocalCanaryPlan({runId: 'run-with-hyphen', schema}),
    error => error.code === 'invalid_run_id',
  );
});

test('seed checks the real connection before writing exact marked canaries', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({sql, params});
    if (calls.length === 1) return targetRow();
    if (calls.length === 2) return {rows: [{
      tenant_ok: true,
      template_ok: true,
      schedule_ok: true,
      subscription_ok: true,
      tenant_inserted: true,
      template_inserted: true,
      schedule_inserted: true,
      subscription_inserted: true,
    }]};
    return {rows: [{
      tenant_ok: true,
      template_ok: true,
      schedule_ok: true,
      subscription_ok: true,
    }]};
  };

  const seeded = await seedP2ehLocalCanary({
    transaction: transactionUsing(query),
    testDatabaseUrl: databaseUrl,
    runId,
    schema,
    now: '2026-08-16T00:00:30.000Z',
  });

  assert.equal(calls.length, 3);
  assert.match(calls[1].sql, /"public"\.capture_orchestration_schedules/u);
  assert.match(calls[1].sql, /exact_tenant AS/u);
  assert.match(calls[1].sql, /FROM exact_template task/u);
  assert.match(calls[1].sql, /'fixed_batch'/u);
  assert.match(calls[1].sql, /'creator'/u);
  assert.equal(calls[1].params[5], runId);
  assert.equal(calls[2].params.length, 8);
  assert.equal(calls[2].params[5], runId);
  assert.equal(calls[2].params[6], seeded.subscriptionName);
  assert.deepEqual(seeded.inserted, {
    tenant: true,
    template: true,
    schedule: true,
    subscription: true,
  });
});

test('PostgreSQL inet text with an explicit loopback mask is accepted', async () => {
  let calls = 0;
  const seeded = await seedP2ehLocalCanary({
    transaction: transactionUsing(async () => {
      calls += 1;
      if (calls === 1) return targetRow({server_address: '127.0.0.1/32'});
      if (calls === 3) return {rows: [{
        tenant_ok: true,
        template_ok: true,
        schedule_ok: true,
        subscription_ok: true,
      }]};
      return {rows: [{
        tenant_ok: true,
        template_ok: true,
        schedule_ok: true,
        subscription_ok: true,
        tenant_inserted: true,
        template_inserted: true,
        schedule_inserted: true,
        subscription_inserted: true,
      }]};
    }),
    testDatabaseUrl: databaseUrl,
    runId,
    schema: 'public',
  });
  assert.equal(seeded.runId, runId);
});

test('seed refuses a query connected to another database before mutation', async () => {
  let calls = 0;
  await assert.rejects(
    seedP2ehLocalCanary({
      transaction: transactionUsing(async () => {
        calls += 1;
        return targetRow({database_name: 'onstarvoice_test_other'});
      }),
      testDatabaseUrl: databaseUrl,
      runId,
      schema,
    }),
    error => error.code === 'executor_target_mismatch',
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    seedP2ehLocalCanary({
      transaction: transactionUsing(async () => {
        calls += 1;
        return targetRow({server_address: '172.18.0.2'});
      }),
      testDatabaseUrl: databaseUrl,
      runId,
      schema,
    }),
    error => error.code === 'executor_target_mismatch',
  );
  assert.equal(calls, 1);
});

test('seed rolls a marker collision out of the transaction before verification', async () => {
  let calls = 0;
  let rolledBack = false;
  await assert.rejects(
    seedP2ehLocalCanary({
      transaction: async operation => {
        try {
          return await operation(async () => {
            calls += 1;
            if (calls === 1) return targetRow();
            return {rows: [{
              tenant_ok: true,
              template_ok: false,
              schedule_ok: false,
              subscription_ok: true,
              tenant_inserted: true,
            }]};
          });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
      testDatabaseUrl: databaseUrl,
      runId,
      schema,
    }),
    error => error.code === 'seed_collision',
  );
  assert.equal(calls, 2);
  assert.equal(rolledBack, true);
});

test('inspect returns normalized DB evidence and a stable digest', async () => {
  let calls = 0;
  let inspectionSql = '';
  const query = async sql => {
    calls += 1;
    if (calls === 1) return targetRow();
    inspectionSql = sql;
    return {rows: [{
      tenant_exists: true,
      template_exists: true,
      schedule_exists: true,
      schedule_status: 'active',
      schedule_last_run_status: 'failed_template',
      schedule_error_code: 'schedule_assignment_incomplete',
      schedule_last_run_at: new Date('2026-08-16T00:01:00.000Z'),
      schedule_last_scheduled_for: new Date('2026-08-16T00:00:00.000Z'),
      schedule_run_count: '0',
      creator_exists: true,
      creator_status: 'active',
      creator_agent_id: null,
      creator_last_error: P2EH_CREATOR_NO_AGENT_ERROR,
      creator_updated_at: new Date('2026-08-16T00:05:00.000Z'),
      extra_task_count: '0',
      item_count: '0',
      item_attempt_count: '0',
      command_count: '0',
      agent_count: '0',
      monitor_execution_count: '0',
      record_count: '0',
      pending_ai_count: '0',
      ai_failover_count: '0',
      prefilter_request_count: '0',
    }]};
  };

  const fingerprint = await inspectP2ehLocalCanary({
    query,
    testDatabaseUrl: databaseUrl,
    runId,
    schema,
  });
  assert.equal(fingerprint.lineage.lastRunAt, '2026-08-16T00:01:00.000Z');
  assert.equal(fingerprint.creator.lastError, P2EH_CREATOR_NO_AGENT_ERROR);
  assert.deepEqual(fingerprint.counts, validFingerprint().counts);
  assert.match(fingerprint.digest, /^[0-9a-f]{64}$/u);
  assert.match(inspectionSql, /SELECT COUNT\(\*\) FROM "public"\.records\) AS record_count/u);
});

test('inspect accepts only the exact restore database when explicitly requested', async () => {
  let calls = 0;
  const fingerprint = await inspectP2ehLocalCanary({
    query: async () => {
      calls += 1;
      if (calls === 1) return targetRow({database_name: `onstarvoice_test_p2eh_${runId}_restore`});
      return {rows: [{tenant_exists: true}]};
    },
    testDatabaseUrl: restoreDatabaseUrl,
    runId,
    schema,
    restore: true,
  });
  assert.equal(fingerprint.runId, runId);
  assert.equal(fingerprint.lineage.tenantExists, true);
});

test('minute 1 asserts failed_template lineage without capture side effects', () => {
  assert.deepEqual(assertP2ehLocalMinute1(validFingerprint()), {
    ok: true,
    minute: 1,
    outcome: 'failed_template',
  });
  assert.throws(
    () => assertP2ehLocalMinute1(validFingerprint({lineage: {lastRunStatus: ''}})),
    error => error.code === 'minute1_not_observed',
  );
  assert.throws(
    () => assertP2ehLocalMinute1(validFingerprint({counts: {commands: 1}})),
    error => error.code === 'unexpected_capture_side_effect',
  );
});

test('minute 5 asserts creator no-Agent state and no monitor execution', () => {
  assert.equal(assertP2ehLocalMinute5(validFingerprint()).outcome, 'creator_no_agent');
  assert.throws(
    () => assertP2ehLocalMinute5(validFingerprint({counts: {monitorExecutions: 1}})),
    error => error.code === 'minute5_not_observed',
  );
  assert.throws(
    () => assertP2ehLocalMinute5(validFingerprint({creator: {lastError: 'other'}})),
    error => error.code === 'minute5_not_observed',
  );
});

test('minute 10 requires an empty AI cycle and rejects hidden work or errors', () => {
  const logs = [
    '[Cron] Running batch AI labeling...',
    '[AI] Batch labeled 0/0 records',
  ];
  assert.deepEqual(summarizeP2ehLocalAiLogs(logs), {
    cycleStarts: 1,
    emptyBatches: 1,
    errors: 0,
    labeledRecords: 0,
  });
  assert.equal(assertP2ehLocalMinute10(validFingerprint(), {logs}).outcome, 'empty_ai_cycle');
  assert.equal(assertP2ehLocalCheckpoint({minute: 10, fingerprint: validFingerprint(), logs}).ok, true);
  assert.throws(
    () => assertP2ehLocalMinute10(validFingerprint({counts: {pendingAi: 1}}), {logs}),
    error => error.code === 'ai_database_not_empty',
  );
  assert.throws(
    () => assertP2ehLocalMinute10(validFingerprint({counts: {commands: 1}}), {logs}),
    error => error.code === 'unexpected_capture_side_effect',
  );
  assert.throws(
    () => assertP2ehLocalMinute10(validFingerprint({counts: {agents: 1}}), {logs}),
    error => error.code === 'unexpected_runtime_side_effect',
  );
  assert.throws(
    () => assertP2ehLocalMinute10(validFingerprint(), {
      logs: `${logs.join('\n')}\n[Cron] Batch labeling error: network should not run`,
    }),
    error => error.code === 'minute10_not_observed',
  );
});

test('checkpoint dispatcher accepts only the three rehearsal checkpoints', () => {
  assert.equal(assertP2ehLocalCheckpoint({minute: 1, fingerprint: validFingerprint()}).minute, 1);
  assert.equal(assertP2ehLocalCheckpoint({minute: 5, fingerprint: validFingerprint()}).minute, 5);
  assert.throws(
    () => assertP2ehLocalCheckpoint({minute: 3, fingerprint: validFingerprint()}),
    error => error.code === 'invalid_checkpoint',
  );
});
