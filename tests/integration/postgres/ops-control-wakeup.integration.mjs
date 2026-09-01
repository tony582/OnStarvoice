import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, execute, queryOne} from '../../../server/db/init.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {
  claimOpsControlWakeups,
  enqueueOpsControlWakeup,
  openPostgresOpsControlListener,
  processOpsControlWakeupBatch,
  startOpsControlWakeupRuntime,
} from '../../../server/services/ops-control-wakeup.js';

async function waitFor(check, {timeoutMs = 3000, intervalMs = 20} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition was not satisfied within ${timeoutMs}ms: ${String(lastValue)}`);
}

async function createEnabledTenant(name) {
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [name]);
  await execute(`
    INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES
      ($1, 'ops_control_enabled', 'true'),
      ($1, 'ops_control_digest_email_enabled', 'false')
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = excluded.value, updated_at = now()
  `, [tenant.id]);
  return tenant;
}

test('task commits and due schedules wake the Agent immediately, with durable restart recovery', async () => {
  await runMigrations();
  await execute('DELETE FROM ops_control_wakeups');

  const env = {
    ...process.env,
    OPS_CONTROL_GLOBAL_ENABLED: 'true',
    OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'false',
  };
  const summaries = [];
  const runtime = startOpsControlWakeupRuntime({
    env,
    logger: {log() {}, error() {}},
    processBatch: async input => {
      const summary = await processOpsControlWakeupBatch(input);
      summaries.push(summary);
      return summary;
    },
  });
  let probe;
  let firstTenant;
  let scheduleTenant;

  try {
    await waitFor(() => runtime.snapshot().connected);
    firstTenant = await createEnabledTenant(`Ops Event Wake ${Date.now()}`);

    let resolveNotification;
    const notification = new Promise(resolve => { resolveNotification = resolve; });
    probe = await openPostgresOpsControlListener({
      env,
      onNotification: payload => {
        if (payload === firstTenant.id) resolveNotification(payload);
      },
    });

    const insertedAt = Date.now();
    const task = await queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key,
        title, platform, source, trigger_type, status,
        progress, counts, metadata, progress_seq,
        business_progress_at, started_at, source_updated_at,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'unattended_keyword_capture', 'unattended_keywords',
        '夜间事件驱动值守', 'douyin', 'cloud', 'manual', 'running',
        '{"current":0,"total":1}'::jsonb, '{"completed":0,"total":1}'::jsonb,
        '{}'::jsonb, 0,
        now(), now(), now(), now(), now()
      )
      RETURNING id
    `, [firstTenant.id, `ops-event-task-${Date.now()}`]);

    let notificationTimer;
    try {
      assert.equal(await Promise.race([
        notification,
        new Promise((_, reject) => {
          notificationTimer = setTimeout(
            () => reject(new Error('PostgreSQL notification was not delivered')),
            2000,
          );
        }),
      ]), firstTenant.id);
    } finally {
      clearTimeout(notificationTimer);
    }

    const processedTaskWakeup = await waitFor(() => queryOne(`
      SELECT id, reason, processed_at
      FROM ops_control_wakeups
      WHERE tenant_id = $1 AND source_type = 'capture_task' AND source_id = $2
      ORDER BY id DESC
      LIMIT 1
    `, [firstTenant.id, task.id]).then(row => row?.processed_at ? row : null));
    assert.equal(processedTaskWakeup.reason, 'task_created');
    assert.ok(Date.now() - insertedAt < 3000, 'task event fell back to periodic scanning');

    const taskSummary = await waitFor(() => summaries.find(summary =>
      summary.results?.some(result =>
        result.tenantId === firstTenant.id
        && result.result?.activation?.reason === 'task_created',
      ),
    ));
    const taskResult = taskSummary.results.find(result => result.tenantId === firstTenant.id);
    assert.equal(taskResult.result.kind, 'observed');
    assert.equal(taskResult.result.activation.kind, 'event_activity');
    assert.equal(taskResult.result.activation.activeTaskCount, 1);

    await probe.close();
    probe = null;
    await execute('DELETE FROM tenants WHERE id = $1', [firstTenant.id]);
    firstTenant = null;
    await execute('DELETE FROM ops_control_wakeups');

    scheduleTenant = await createEnabledTenant(`Ops Schedule Wake ${Date.now()}`);
    const template = await queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key,
        title, platform, source, trigger_type, status, metadata
      ) VALUES (
        $1, $2, 'capture_orchestration', 'keyword_orchestration',
        '夜间到点模板', 'xiaohongshu', 'cloud', 'orchestration_schedule',
        'pending', '{"orchestrationTemplate":true}'::jsonb
      )
      RETURNING id
    `, [scheduleTenant.id, `ops-schedule-template-${Date.now()}`]);
    const dueAt = new Date(Date.now() + 250);
    const schedule = await queryOne(`
      INSERT INTO capture_orchestration_schedules (
        tenant_id, template_task_id, title, platform,
        status, schedule_mode, timezone, start_time,
        plan_snapshot, next_run_at
      ) VALUES (
        $1, $2, '夜间到点调度', 'xiaohongshu',
        'active', 'daily', 'Asia/Shanghai', '22:30',
        '{}'::jsonb, $3
      )
      RETURNING id
    `, [scheduleTenant.id, template.id, dueAt.toISOString()]);

    const futureWakeup = await queryOne(`
      SELECT id, reason, available_at, processed_at
      FROM ops_control_wakeups
      WHERE tenant_id = $1 AND dedupe_key = $2
    `, [scheduleTenant.id, `schedule-due:${schedule.id}`]);
    assert.equal(futureWakeup.reason, 'schedule_due');
    assert.equal(futureWakeup.processed_at, null);
    assert.ok(new Date(futureWakeup.available_at).getTime() >= dueAt.getTime());

    const processedScheduleWakeup = await waitFor(() => queryOne(`
      SELECT processed_at
      FROM ops_control_wakeups
      WHERE id = $1
    `, [futureWakeup.id]).then(row => row?.processed_at ? row : null));
    assert.ok(processedScheduleWakeup.processed_at);
    const scheduleSummary = await waitFor(() => summaries.find(summary =>
      summary.results?.some(result =>
        result.tenantId === scheduleTenant.id
        && result.result?.activation?.reason === 'schedule_due',
      ),
    ));
    const scheduleResult = scheduleSummary.results.find(
      result => result.tenantId === scheduleTenant.id,
    );
    assert.equal(scheduleResult.result.kind, 'observed');
    assert.equal(scheduleResult.result.activation.kind, 'event_activity');
    assert.equal(scheduleResult.result.assessment.summary.expectedScheduleCount, 1);
    const scheduleSnapshot = await queryOne(`
      SELECT normalized
      FROM ops_control_snapshots
      WHERE tenant_id = $1
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `, [scheduleTenant.id]);
    assert.equal(scheduleSnapshot.normalized.scheduleSummary.dueUnmaterialized, 1);

    runtime.stopNewWork();
    assert.equal((await runtime.drain({timeoutMs: 3000})).drained, true);

    await execute('DELETE FROM ops_control_wakeups');
    const durableId = await enqueueOpsControlWakeup({
      tenantId: scheduleTenant.id,
      reason: 'restart_recovery_test',
      sourceType: 'integration_test',
      sourceId: schedule.id,
      dedupeKey: `restart:${schedule.id}`,
      availableAt: new Date('2026-08-24T12:00:00.000Z'),
    });
    const firstClaim = await claimOpsControlWakeups({
      now: new Date('2026-08-24T12:00:01.000Z'),
      leaseSeconds: 30,
      claimToken: 'a0000000-0000-4000-8000-000000000011',
    });
    assert.deepEqual(firstClaim.wakeups.map(row => row.id), [durableId]);
    assert.equal(firstClaim.wakeups[0].attempt_count, 1);

    const beforeLeaseExpiry = await claimOpsControlWakeups({
      now: new Date('2026-08-24T12:00:20.000Z'),
      leaseSeconds: 30,
      claimToken: 'a0000000-0000-4000-8000-000000000012',
    });
    assert.equal(beforeLeaseExpiry.wakeups.length, 0);

    const recoveredClaim = await claimOpsControlWakeups({
      now: new Date('2026-08-24T12:00:32.000Z'),
      leaseSeconds: 30,
      claimToken: 'a0000000-0000-4000-8000-000000000013',
    });
    assert.deepEqual(recoveredClaim.wakeups.map(row => row.id), [durableId]);
    assert.equal(recoveredClaim.wakeups[0].attempt_count, 2);
  } finally {
    if (probe) await probe.close();
    await runtime.stop({timeoutMs: 3000});
    if (firstTenant) await execute('DELETE FROM tenants WHERE id = $1', [firstTenant.id]);
    if (scheduleTenant) await execute('DELETE FROM tenants WHERE id = $1', [scheduleTenant.id]);
    await execute('DELETE FROM ops_control_wakeups');
    await closeDb();
  }
});
