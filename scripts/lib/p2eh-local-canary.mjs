import crypto from 'node:crypto';

import {validatePostgresIntegrationTarget} from './postgres-integration-target.mjs';

export const P2EH_CREATOR_NO_AGENT_ERROR =
  '当前没有在线、空闲且支持该平台的执行节点，云端稍后会自动重试';

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_]{7,31}$/u;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requireValue(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function uuidFor(runId, kind) {
  const hex = crypto.createHash('sha256')
    .update(`onstarvoice:p2eh-local:${runId}:${kind}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-` +
    `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeRunId(value) {
  const runId = String(value || '');
  requireValue(
    RUN_ID_PATTERN.test(runId),
    'invalid_run_id',
    'runId must contain 8-32 lowercase letters, digits, or underscores.',
  );
  return runId;
}

function normalizeSchema(value) {
  const schema = String(value || 'public').trim();
  requireValue(
    schema === 'public',
    'unsafe_schema',
    'P2-E-HL canary requires public in its exact isolated run database.',
  );
  return schema;
}

function normalizeInstant(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  requireValue(!Number.isNaN(date.getTime()), 'invalid_time', 'now must be a valid timestamp.');
  return date.toISOString();
}

function queryFunction(query) {
  requireValue(typeof query === 'function', 'missing_query', 'A local PostgreSQL query function is required.');
  return query;
}

function transactionFunction(transaction) {
  requireValue(
    typeof transaction === 'function',
    'missing_transaction',
    'A local PostgreSQL transaction function is required for canary seeding.',
  );
  return transaction;
}

function rows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function bool(value) {
  return value === true || value === 't' || value === 'true' || value === 1;
}

function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function instant(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function createP2ehLocalCanaryPlan({runId, schema = 'public', now = new Date()} = {}) {
  const safeRunId = normalizeRunId(runId);
  const safeSchema = normalizeSchema(schema);
  const seededAt = normalizeInstant(now);
  return Object.freeze({
    runId: safeRunId,
    schema: safeSchema,
    seededAt,
    dueAt: new Date(new Date(seededAt).getTime() - 30_000).toISOString(),
    tenantId: uuidFor(safeRunId, 'tenant'),
    templateTaskId: uuidFor(safeRunId, 'orchestration-template'),
    scheduleId: uuidFor(safeRunId, 'orchestration-schedule'),
    subscriptionId: uuidFor(safeRunId, 'creator-subscription'),
    tenantName: `P2EH local ${safeRunId}`,
    subscriptionName: `P2EH local creator ${safeRunId}`,
  });
}

export function validateP2ehLocalCanaryTarget({
  testDatabaseUrl,
  databaseUrl = testDatabaseUrl,
  runId,
  schema = 'public',
  restore = false,
} = {}) {
  const safeRunId = normalizeRunId(runId);
  requireValue(
    typeof restore === 'boolean',
    'invalid_restore_target',
    'restore must be an explicit boolean.',
  );
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl,
    databaseUrl,
    requireDatabaseUrl: true,
  });
  const expectedDatabase = `onstarvoice_test_p2eh_${safeRunId}${restore ? '_restore' : ''}`;
  requireValue(
    target.databaseName === expectedDatabase,
    'database_run_id_mismatch',
    `P2-E-HL database must be exactly ${expectedDatabase}.`,
  );
  return {
    databaseName: target.databaseName,
    runId: safeRunId,
    schema: normalizeSchema(schema),
    restore,
  };
}

async function assertBoundLocalTarget(query, target) {
  const result = await query(
    `SELECT current_database() AS database_name,
       inet_server_addr()::text AS server_address,
       to_regnamespace($1) IS NOT NULL AS schema_exists`,
    [target.schema],
  );
  const row = rows(result)[0] || {};
  const address = row.server_address;
  const localAddress = address === null || address === undefined ||
    address === '127.0.0.1' || address === '127.0.0.1/32' ||
    address === '::1' || address === '::1/128';
  requireValue(
    row.database_name === target.databaseName && localAddress && bool(row.schema_exists),
    'executor_target_mismatch',
    'Injected query is not bound to the validated local test database and isolated schema.',
    {expectedDatabase: target.databaseName, actualDatabase: row.database_name, address},
  );
}

function seedSql(schema) {
  return `WITH seeded_tenant AS (
    INSERT INTO "${schema}".tenants (id, name, status, created_at, updated_at)
    VALUES ($1::uuid, $5, 'active', $7::timestamptz, $7::timestamptz)
    ON CONFLICT DO NOTHING RETURNING id, name
  ), exact_tenant AS (
    SELECT id FROM seeded_tenant
    UNION ALL
    SELECT id FROM "${schema}".tenants
    WHERE id = $1::uuid AND name = $5
  ), seeded_template AS (
    INSERT INTO "${schema}".capture_tasks (
      id, tenant_id, task_type, feature_key, title, platform, source,
      trigger_type, status, metadata, message, created_at, updated_at,
      source_updated_at
    )
    SELECT $2::uuid, $1::uuid, 'capture_orchestration', 'p2eh_local_canary',
      $10, 'xhs', 'p2eh_local_canary', 'schedule', 'pending', $9::jsonb,
      'P2-E-HL local cron canary', $7::timestamptz, $7::timestamptz,
      $7::timestamptz
    FROM exact_tenant tenant
    ON CONFLICT DO NOTHING RETURNING id, tenant_id, metadata
  ), exact_template AS (
    SELECT id FROM seeded_template
    UNION ALL
    SELECT id FROM "${schema}".capture_tasks
    WHERE id = $2::uuid AND tenant_id = $1::uuid
      AND metadata->>'p2ehRunId' = $6
  ), seeded_schedule AS (
    INSERT INTO "${schema}".capture_orchestration_schedules (
      id, tenant_id, template_task_id, title, platform, status, schedule_mode,
      timezone, start_time, random_offset_min, overlap_policy,
      late_start_grace_min, allocation_mode, revision, plan_snapshot,
      next_run_at, created_by_name, created_at, updated_at, distribution_mode
    )
    SELECT $3::uuid, $1::uuid, $2::uuid, $10, 'xhs', 'active', 'daily',
      'Asia/Shanghai', '00:00', 0, 'skip', 1440, 'balanced', 1, $9::jsonb,
      $8::timestamptz, 'P2-E-HL local canary', $7::timestamptz,
      $7::timestamptz, 'fixed_batch'
    FROM exact_template task
    ON CONFLICT DO NOTHING RETURNING id, tenant_id, template_task_id, plan_snapshot
  ), exact_schedule AS (
    SELECT id FROM seeded_schedule
    UNION ALL
    SELECT id FROM "${schema}".capture_orchestration_schedules
    WHERE id = $3::uuid AND tenant_id = $1::uuid
      AND template_task_id = $2::uuid
      AND plan_snapshot->>'p2ehRunId' = $6
  ), seeded_subscription AS (
    INSERT INTO "${schema}".monitor_subscriptions (
      id, tenant_id, name, keyword, platform, account_url, cadence_minutes,
      status, notify_on_negative, auth_code, next_run_at, last_error,
      subject_type, assigned_agent_id, created_at, updated_at
    )
    SELECT $4::uuid, $1::uuid, $11, $12, 'xhs', $13, 1440, 'active',
      false, '', $8::timestamptz, '', 'creator', NULL, $7::timestamptz,
      $7::timestamptz
    FROM exact_tenant tenant
    ON CONFLICT DO NOTHING RETURNING id, tenant_id, name, keyword
  ), exact_subscription AS (
    SELECT id FROM seeded_subscription
    UNION ALL
    SELECT id FROM "${schema}".monitor_subscriptions
    WHERE id = $4::uuid AND tenant_id = $1::uuid
      AND name = $11 AND keyword = $12
  )
  SELECT
    EXISTS (SELECT 1 FROM exact_tenant) AS tenant_ok,
    EXISTS (SELECT 1 FROM exact_template) AS template_ok,
    EXISTS (SELECT 1 FROM exact_schedule) AS schedule_ok,
    EXISTS (SELECT 1 FROM exact_subscription) AS subscription_ok,
    EXISTS (SELECT 1 FROM seeded_tenant) AS tenant_inserted,
    EXISTS (SELECT 1 FROM seeded_template) AS template_inserted,
    EXISTS (SELECT 1 FROM seeded_schedule) AS schedule_inserted,
    EXISTS (SELECT 1 FROM seeded_subscription) AS subscription_inserted`;
}

function verifySeedSql(schema) {
  return `SELECT
    EXISTS (SELECT 1 FROM "${schema}".tenants WHERE id = $1::uuid AND name = $5) AS tenant_ok,
    EXISTS (SELECT 1 FROM "${schema}".capture_tasks WHERE id = $2::uuid AND tenant_id = $1::uuid AND metadata->>'p2ehRunId' = $6) AS template_ok,
    EXISTS (SELECT 1 FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid AND tenant_id = $1::uuid AND template_task_id = $2::uuid AND plan_snapshot->>'p2ehRunId' = $6) AS schedule_ok,
    EXISTS (SELECT 1 FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid AND tenant_id = $1::uuid AND name = $7 AND keyword = $8) AS subscription_ok`;
}

export async function seedP2ehLocalCanary({
  transaction: injectedTransaction,
  testDatabaseUrl,
  databaseUrl = testDatabaseUrl,
  runId,
  schema,
  now = new Date(),
} = {}) {
  const transaction = transactionFunction(injectedTransaction);
  const target = validateP2ehLocalCanaryTarget({
    testDatabaseUrl,
    databaseUrl,
    runId,
    schema,
  });
  const plan = createP2ehLocalCanaryPlan({runId: target.runId, schema: target.schema, now});
  const marker = JSON.stringify({
    p2ehLocalCanary: true,
    p2ehRunId: plan.runId,
    seededAt: plan.seededAt,
  });
  const params = [
    plan.tenantId,
    plan.templateTaskId,
    plan.scheduleId,
    plan.subscriptionId,
    plan.tenantName,
    plan.runId,
    plan.seededAt,
    plan.dueAt,
    marker,
    `P2EH local schedule ${plan.runId}`,
    plan.subscriptionName,
    `p2eh-local-${plan.runId}`,
    `p2eh-local-canary://${plan.runId}`,
  ];
  const inserted = await transaction(async injectedQuery => {
    const query = queryFunction(injectedQuery);
    await assertBoundLocalTarget(query, target);
    const mutation = rows(await query(seedSql(plan.schema), params))[0] || {};
    requireValue(
      bool(mutation.tenant_ok) && bool(mutation.template_ok) &&
        bool(mutation.schedule_ok) && bool(mutation.subscription_ok),
      'seed_collision',
      'Canary identifiers collided with rows that do not carry the exact runId marker.',
    );
    const verificationParams = [
      plan.tenantId,
      plan.templateTaskId,
      plan.scheduleId,
      plan.subscriptionId,
      plan.tenantName,
      plan.runId,
      plan.subscriptionName,
      `p2eh-local-${plan.runId}`,
    ];
    const verification = rows(await query(
      verifySeedSql(plan.schema),
      verificationParams,
    ))[0] || {};
    requireValue(
      bool(verification.tenant_ok) && bool(verification.template_ok) &&
        bool(verification.schedule_ok) && bool(verification.subscription_ok),
      'seed_verification_failed',
      'Canary rows were not visible with their exact runId markers after seeding.',
    );
    return {
      tenant: bool(mutation.tenant_inserted),
      template: bool(mutation.template_inserted),
      schedule: bool(mutation.schedule_inserted),
      subscription: bool(mutation.subscription_inserted),
    };
  });
  return {
    ...plan,
    inserted,
  };
}

function inspectSql(schema) {
  return `SELECT
    EXISTS (SELECT 1 FROM "${schema}".tenants WHERE id = $1::uuid) AS tenant_exists,
    EXISTS (SELECT 1 FROM "${schema}".capture_tasks WHERE id = $2::uuid AND metadata->>'p2ehRunId' = $5) AS template_exists,
    EXISTS (SELECT 1 FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid AND plan_snapshot->>'p2ehRunId' = $5) AS schedule_exists,
    (SELECT status FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_status,
    (SELECT last_run_status FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_last_run_status,
    (SELECT last_error->>'code' FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_error_code,
    (SELECT last_run_at FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_last_run_at,
    (SELECT last_scheduled_for FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_last_scheduled_for,
    (SELECT run_count FROM "${schema}".capture_orchestration_schedules WHERE id = $3::uuid) AS schedule_run_count,
    EXISTS (SELECT 1 FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid AND subject_type = 'creator') AS creator_exists,
    (SELECT status FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid) AS creator_status,
    (SELECT assigned_agent_id FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid) AS creator_agent_id,
    (SELECT last_error FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid) AS creator_last_error,
    (SELECT updated_at FROM "${schema}".monitor_subscriptions WHERE id = $4::uuid) AS creator_updated_at,
    (SELECT COUNT(*) FROM "${schema}".capture_tasks WHERE tenant_id = $1::uuid AND id <> $2::uuid) AS extra_task_count,
    (SELECT COUNT(*) FROM "${schema}".capture_task_items WHERE tenant_id = $1::uuid) AS item_count,
    (SELECT COUNT(*) FROM "${schema}".capture_task_item_attempts WHERE tenant_id = $1::uuid) AS item_attempt_count,
    (SELECT COUNT(*) FROM "${schema}".capture_agent_commands WHERE tenant_id = $1::uuid) AS command_count,
    (SELECT COUNT(*) FROM "${schema}".capture_agents WHERE tenant_id = $1::uuid) AS agent_count,
    (SELECT COUNT(*) FROM "${schema}".monitor_executions WHERE tenant_id = $1::uuid) AS monitor_execution_count,
    (SELECT COUNT(*) FROM "${schema}".records) AS record_count,
    (SELECT COUNT(*) FROM "${schema}".records WHERE record_type NOT IN ('official_content', 'blogger_profile') AND (ai_labeled_at IS NULL OR ai_result->>'relevance' IS NULL)) AS pending_ai_count,
    (SELECT COUNT(*) FROM "${schema}".ai_failover_states) AS ai_failover_count,
    (SELECT COUNT(*) FROM "${schema}".relevance_prefilter_requests) AS prefilter_request_count`;
}

export async function inspectP2ehLocalCanary({
  query: injectedQuery,
  testDatabaseUrl,
  databaseUrl = testDatabaseUrl,
  runId,
  schema,
  restore = false,
} = {}) {
  const query = queryFunction(injectedQuery);
  const target = validateP2ehLocalCanaryTarget({
    testDatabaseUrl,
    databaseUrl,
    runId,
    schema,
    restore,
  });
  const plan = createP2ehLocalCanaryPlan({runId: target.runId, schema: target.schema});
  await assertBoundLocalTarget(query, target);
  const result = await query(inspectSql(plan.schema), [
    plan.tenantId,
    plan.templateTaskId,
    plan.scheduleId,
    plan.subscriptionId,
    plan.runId,
  ]);
  const row = rows(result)[0] || {};
  const fingerprint = {
    runId: plan.runId,
    lineage: {
      tenantExists: bool(row.tenant_exists),
      templateExists: bool(row.template_exists),
      scheduleExists: bool(row.schedule_exists),
      scheduleStatus: row.schedule_status || null,
      lastRunStatus: row.schedule_last_run_status || '',
      errorCode: row.schedule_error_code || '',
      lastRunAt: instant(row.schedule_last_run_at),
      lastScheduledFor: instant(row.schedule_last_scheduled_for),
      runCount: count(row.schedule_run_count),
    },
    creator: {
      exists: bool(row.creator_exists),
      status: row.creator_status || null,
      assignedAgentId: row.creator_agent_id || null,
      lastError: row.creator_last_error || '',
      updatedAt: instant(row.creator_updated_at),
    },
    counts: {
      extraTasks: count(row.extra_task_count),
      items: count(row.item_count),
      itemAttempts: count(row.item_attempt_count),
      commands: count(row.command_count),
      agents: count(row.agent_count),
      monitorExecutions: count(row.monitor_execution_count),
      records: count(row.record_count),
      pendingAi: count(row.pending_ai_count),
      aiFailovers: count(row.ai_failover_count),
      prefilterRequests: count(row.prefilter_request_count),
    },
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(fingerprint))
    .digest('hex');
  return {...fingerprint, digest};
}

export function summarizeP2ehLocalAiLogs(logs) {
  const text = Array.isArray(logs)
    ? logs.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')
    : String(logs || '');
  return {
    cycleStarts: (text.match(/\[Cron\] Running batch AI labeling\.\.\./gu) || []).length,
    emptyBatches: (text.match(/\[AI\] Batch labeled 0\/0 records/gu) || []).length,
    errors: (text.match(/\[Cron\] Batch labeling error:|\[AI\] Label error/gu) || []).length,
    labeledRecords: (text.match(/\[AI\] Record .* labeled:/gu) || []).length,
  };
}

function assertNoCaptureSideEffects(fingerprint) {
  requireValue(
    fingerprint.counts.extraTasks === 0 && fingerprint.counts.items === 0 &&
      fingerprint.counts.itemAttempts === 0 && fingerprint.counts.commands === 0,
    'unexpected_capture_side_effect',
    'Canary produced capture tasks, items, attempts, or commands.',
    fingerprint.counts,
  );
}

export function assertP2ehLocalMinute1(fingerprint) {
  requireValue(
    fingerprint?.lineage?.tenantExists && fingerprint.lineage.templateExists &&
      fingerprint.lineage.scheduleExists,
    'missing_orchestration_lineage',
    'The runId-marked template/schedule lineage is incomplete.',
  );
  requireValue(
    fingerprint.lineage.lastRunStatus === 'failed_template' &&
      fingerprint.lineage.errorCode === 'schedule_assignment_incomplete' &&
      fingerprint.lineage.lastRunAt && fingerprint.lineage.lastScheduledFor &&
      fingerprint.lineage.runCount === 0,
    'minute1_not_observed',
    'The one-minute scheduler has not safely advanced the empty template.',
    fingerprint.lineage,
  );
  assertNoCaptureSideEffects(fingerprint);
  return {ok: true, minute: 1, outcome: 'failed_template'};
}

export function assertP2ehLocalMinute5(fingerprint) {
  requireValue(
    fingerprint?.creator?.exists && fingerprint.creator.status === 'active' &&
      fingerprint.creator.assignedAgentId === null &&
      fingerprint.creator.lastError === P2EH_CREATOR_NO_AGENT_ERROR &&
      fingerprint.counts.agents === 0 &&
      fingerprint.counts.monitorExecutions === 0,
    'minute5_not_observed',
    'The five-minute creator patrol has not recorded the expected no-Agent state.',
    {creator: fingerprint?.creator, counts: fingerprint?.counts},
  );
  assertNoCaptureSideEffects(fingerprint);
  return {ok: true, minute: 5, outcome: 'creator_no_agent'};
}

export function assertP2ehLocalMinute10(fingerprint, {logs} = {}) {
  requireValue(
    fingerprint?.counts?.records === 0 && fingerprint.counts.pendingAi === 0 &&
      fingerprint.counts.aiFailovers === 0 &&
      fingerprint.counts.prefilterRequests === 0,
    'ai_database_not_empty',
    'The AI canary tenant is not an empty, side-effect-free workload.',
    fingerprint?.counts,
  );
  assertNoCaptureSideEffects(fingerprint);
  requireValue(
    fingerprint.counts.agents === 0 && fingerprint.counts.monitorExecutions === 0,
    'unexpected_runtime_side_effect',
    'The ten-minute canary observed an Agent or monitor execution.',
    fingerprint.counts,
  );
  const summary = summarizeP2ehLocalAiLogs(logs);
  requireValue(
    summary.cycleStarts > 0 && summary.emptyBatches > 0 &&
      summary.errors === 0 && summary.labeledRecords === 0,
    'minute10_not_observed',
    'The ten-minute empty AI cycle is missing or contains AI work/errors.',
    summary,
  );
  return {ok: true, minute: 10, outcome: 'empty_ai_cycle', logs: summary};
}

export function assertP2ehLocalCheckpoint({minute, fingerprint, logs} = {}) {
  if (minute === 1) return assertP2ehLocalMinute1(fingerprint);
  if (minute === 5) return assertP2ehLocalMinute5(fingerprint);
  if (minute === 10) return assertP2ehLocalMinute10(fingerprint, {logs});
  fail('invalid_checkpoint', 'P2-E-HL checkpoint must be minute 1, 5, or 10.');
}
