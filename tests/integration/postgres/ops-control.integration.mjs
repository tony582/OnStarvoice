import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, execute, queryAll, queryOne } from '../../../server/db/init.js';
import { runMigrations } from '../../../server/db/migrate.js';
import {
  maybeDeliverOpsControlIncidentAlerts,
  normalizeOpsControlSettings,
  runOpsControlCycle,
  runOpsControlTenantObservation,
} from '../../../server/services/ops-control.js';
import {runOpsControlGuardedActions} from '../../../server/services/ops-control-actions.js';

test('observe-only control plane reconciles a historical failure to final success in PostgreSQL', async () => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Ops Control Integration ${Date.now()}`]);

  try {
    const agent = await queryOne(`
      INSERT INTO capture_agents (
        tenant_id, client_uuid, client_label, display_name,
        browser_name, app_version, status, last_heartbeat_at
      ) VALUES (
        $1, $2, 'Chrome test', 'Chrome test',
        'Chrome', '0.3.93', 'active', $3
      )
      RETURNING id
    `, [tenant.id, `ops-agent-${Date.now()}`, '2026-08-24T00:00:30.000Z']);

    const template = await queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key,
        title, platform, source, trigger_type, status,
        progress, counts, metadata, source_updated_at, created_at, updated_at
      ) VALUES (
        $1, $2, 'capture_orchestration', 'keyword_orchestration',
        '晨间值守模板', 'xiaohongshu', 'cloud', 'orchestration_schedule', 'pending',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3, $3, $3
      )
      RETURNING id
    `, [tenant.id, `ops-template-${Date.now()}`, '2026-08-23T20:00:00.000Z']);

    const schedule = await queryOne(`
      INSERT INTO capture_orchestration_schedules (
        tenant_id, template_task_id, title, platform,
        status, schedule_mode, timezone, start_time,
        plan_snapshot, last_scheduled_for, last_run_status,
        created_at, updated_at
      ) VALUES (
        $1, $2, '晨间小红书', 'xiaohongshu',
        'active', 'daily', 'Asia/Shanghai', '06:30',
        '{}'::jsonb, $3, 'completed', $4, $4
      )
      RETURNING id
    `, [
      tenant.id,
      template.id,
      '2026-08-23T22:30:00.000Z',
      '2026-08-23T20:00:00.000Z',
    ]);

    const runTask = await queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, assigned_agent_id, client_task_id,
        task_type, feature_key, title, platform, source, trigger_type,
        status, progress, counts, metadata,
        progress_seq, business_progress_at, started_at, finished_at,
        orchestration_revision, orchestration_schedule_id, scheduled_for,
        source_updated_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        'capture_orchestration', 'keyword_orchestration', '晨间小红书 · 08/24 06:30',
        'xiaohongshu', 'cloud', 'orchestration_schedule',
        'completed', $4::jsonb, $5::jsonb, $6::jsonb,
        13, $7, $8, $9,
        1, $10, $11,
        $9, $8, $9
      )
      RETURNING id
    `, [
      tenant.id,
      agent.id,
      `ops-run-${Date.now()}`,
      JSON.stringify({current: 13, total: 13, phase: 'completed'}),
      JSON.stringify({completed: 13, total: 13}),
      JSON.stringify({orchestrationScheduleRun: true}),
      '2026-08-23T23:55:00.000Z',
      '2026-08-23T22:31:00.000Z',
      '2026-08-23T23:56:00.000Z',
      schedule.id,
      '2026-08-23T22:30:00.000Z',
    ]);
    await execute(`
      UPDATE capture_orchestration_schedules
      SET last_run_task_id = $2, updated_at = $3
      WHERE id = $1
    `, [schedule.id, runTask.id, '2026-08-23T23:56:00.000Z']);

    const item = await queryOne(`
      INSERT INTO capture_task_items (
        tenant_id, task_id, item_key, platform, item_type,
        status, ordinal, keyword, assigned_agent_id, execution_task_id,
        assignment_revision, attempt_count, started_at, finished_at,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'keyword:安吉星', 'xiaohongshu', 'keyword',
        'completed', 0, '安吉星', $3, $2,
        1, 2, $4, $5, $4, $5
      )
      RETURNING id
    `, [
      tenant.id,
      runTask.id,
      agent.id,
      '2026-08-23T22:31:00.000Z',
      '2026-08-23T23:56:00.000Z',
    ]);
    await execute(`
      INSERT INTO capture_task_item_attempts (
        tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        error, assigned_at, started_at, finished_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $3,
        $4, 1, 1, 'failed',
        '{"code":"UNATTENDED_SEARCH_BOOTSTRAP_FAILED"}'::jsonb,
        $5, $5, $6, $5, $6
      )
    `, [
      tenant.id,
      item.id,
      runTask.id,
      agent.id,
      '2026-08-23T22:31:00.000Z',
      '2026-08-23T22:32:00.000Z',
    ]);

    const record = await queryOne(`
      INSERT INTO records (
        tenant_id, external_id, platform, record_type,
        title, ai_result, ai_labeled_at, created_at, updated_at
      ) VALUES (
        $1, $2, 'xiaohongshu', 'single_note',
        'integration evidence', '{"relevance":"relevant"}'::jsonb,
        $3, $3, $3
      )
      RETURNING id
    `, [tenant.id, `ops-record-${Date.now()}`, '2026-08-23T23:50:00.000Z']);
    await execute(`
      INSERT INTO record_observations (
        tenant_id, record_id, platform, keyword, captured_at
      ) VALUES ($1, $2, 'xiaohongshu', '安吉星', $3)
    `, [tenant.id, record.id, '2026-08-23T23:50:00.000Z']);

    const settings = normalizeOpsControlSettings({
      ops_control_enabled: 'true',
      ops_control_window_start: '05:30',
      ops_control_window_end: '08:30',
      ops_control_digest_time: '08:35',
      ops_control_snapshot_gap_seconds: '25',
      ops_control_stale_after_seconds: '300',
      ops_control_ai_stale_after_seconds: '1200',
      ops_control_digest_email_enabled: 'false',
    }, {env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'}});

    const before = await queryOne(`
      SELECT
        (SELECT status FROM capture_tasks WHERE id = $1) AS task_status,
        (SELECT status FROM capture_task_items WHERE id = $2) AS item_status,
        (SELECT COUNT(*)::int FROM capture_task_item_attempts WHERE item_id = $2) AS attempt_count
    `, [runTask.id, item.id]);
    const first = await runOpsControlTenantObservation({
      tenantId: tenant.id,
      settings,
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    assert.equal(first.kind, 'observed');
    assert.equal(first.assessment.verdict, 'pending');
    assert.equal(first.sequence, 1);

    const second = await runOpsControlTenantObservation({
      tenantId: tenant.id,
      settings,
      now: new Date('2026-08-24T00:01:00.000Z'),
    });
    assert.equal(second.kind, 'observed');
    assert.equal(second.sequence, 2);
    assert.equal(second.assessment.lifecycleStatus, 'settled');
    assert.equal(second.assessment.verdict, 'healthy');
    assert.equal(second.assessment.summary.expectedScheduleCount, 1);
    assert.equal(second.assessment.summary.observedScheduleCount, 1);
    assert.equal(second.assessment.summary.recoveredItemCount, 1);
    assert.equal(second.assessment.summary.historicalFailureCount, 1);
    assert.equal(second.assessment.summary.observationCount, 1);
    assert.equal(second.assessment.summary.businessActionsExecuted, 0);

    await execute(`
      INSERT INTO tenant_settings (tenant_id, key, value)
      VALUES ($1, 'ops_control_enabled', 'true')
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value
    `, [tenant.id]);
    const cycle = await runOpsControlCycle({
      now: new Date('2026-08-24T00:02:00.000Z'),
      env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
      observeTenant: async ({tenantId}) => ({kind: 'outside_window', tenantId}),
    });
    assert.equal(cycle.status, 'healthy');
    assert.ok(cycle.skipped >= 1);
    assert.ok(cycle.results.some(row => row.tenantId === tenant.id));

    const guardedCycle = await runOpsControlCycle({
      now: new Date('2026-08-24T00:03:00.000Z'),
      env: {
        OPS_CONTROL_GLOBAL_ENABLED: 'true',
        OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'true',
      },
      observeTenant: async ({tenantId}) => ({kind: 'outside_window', tenantId}),
    });
    const guardedSystemState = await queryOne(`
      SELECT mode, details
      FROM ops_control_system_state
      WHERE component = 'scheduler'
    `);
    assert.equal(guardedCycle.status, 'healthy');
    assert.equal(guardedSystemState.mode, 'guarded');
    assert.equal(guardedSystemState.details.actionsGlobalEnabled, true);

    const [run, snapshots, incidents, digest, after] = await Promise.all([
      queryOne('SELECT * FROM ops_control_runs WHERE tenant_id = $1', [tenant.id]),
      queryAll('SELECT * FROM ops_control_snapshots WHERE tenant_id = $1 ORDER BY sequence', [tenant.id]),
      queryAll('SELECT * FROM ops_control_incidents WHERE tenant_id = $1', [tenant.id]),
      queryOne('SELECT * FROM ops_control_digests WHERE tenant_id = $1', [tenant.id]),
      queryOne(`
        SELECT
          (SELECT status FROM capture_tasks WHERE id = $1) AS task_status,
          (SELECT status FROM capture_task_items WHERE id = $2) AS item_status,
          (SELECT COUNT(*)::int FROM capture_task_item_attempts WHERE item_id = $2) AS attempt_count
      `, [runTask.id, item.id]),
    ]);
    assert.equal(run.runtime_baseline_version, '0.4.2');
    assert.equal(run.snapshot_count, 2);
    assert.equal(run.verdict, 'healthy');
    assert.equal(snapshots.length, 2);
    assert.equal(incidents.length, 0);
    assert.equal(digest.verdict, 'healthy');
    assert.deepEqual(after, before, 'observe-only control plane changed capture business state');
  } finally {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  }
});

test('night task activity automatically wakes and settles the control plane without manual force', async () => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Ops Task Wake Integration ${Date.now()}`]);

  try {
    await execute(`
      INSERT INTO tenant_settings (tenant_id, key, value)
      VALUES ($1, 'ops_control_enabled', 'true')
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value
    `, [tenant.id]);
    const task = await queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key,
        title, platform, source, trigger_type, status,
        progress, counts, metadata, progress_seq,
        business_progress_at, started_at, source_updated_at,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'capture_orchestration', 'keyword_orchestration',
        '夜间自动值守任务', 'douyin', 'cloud', 'manual', 'running',
        '{"current":1,"total":2}'::jsonb, '{"completed":1,"total":2}'::jsonb,
        '{}'::jsonb, 1,
        $3, $3, $3,
        $3, $3
      )
      RETURNING id
    `, [tenant.id, `ops-night-task-${Date.now()}`, '2026-08-24T12:00:00.000Z']);

    const firstCycle = await runOpsControlCycle({
      now: new Date('2026-08-24T12:01:00.000Z'),
      env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
    });
    const first = firstCycle.results.find(row => row.tenantId === tenant.id);
    assert.equal(first?.kind, 'observed');
    assert.equal(first?.activation?.kind, 'task_activity');
    assert.equal(first?.activation?.reason, 'active_task');
    assert.equal(first?.activation?.activeTaskCount, 1);
    assert.ok(firstCycle.taskActivatedCount >= 1);
    const firstSnapshot = await queryOne(`
      SELECT normalized
      FROM ops_control_snapshots
      WHERE tenant_id = $1
      ORDER BY sequence DESC
      LIMIT 1
    `, [tenant.id]);
    assert.equal(firstSnapshot.normalized.taskSummary.active, 1);
    assert.equal(firstSnapshot.normalized.tasks[0].id, task.id);

    await execute(`
      UPDATE capture_tasks
      SET status = 'completed', progress_seq = 2,
        progress = '{"current":2,"total":2,"phase":"completed"}'::jsonb,
        counts = '{"completed":2,"total":2}'::jsonb,
        business_progress_at = $2, heartbeat_at = $2,
        finished_at = $2, source_updated_at = $2, updated_at = $2
      WHERE id = $1
    `, [task.id, '2026-08-24T12:02:00.000Z']);
    const settledCycle = await runOpsControlCycle({
      now: new Date('2026-08-24T12:03:00.000Z'),
      env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
    });
    const settled = settledCycle.results.find(row => row.tenantId === tenant.id);
    assert.equal(settled?.kind, 'observed');
    assert.equal(settled?.activation?.kind, 'task_activity');
    assert.equal(settled?.activation?.reason, 'recent_task_settlement');
    assert.equal(settled?.assessment?.lifecycleStatus, 'settled');
    assert.equal(settled?.assessment?.verdict, 'healthy');

    const idleCycle = await runOpsControlCycle({
      now: new Date('2026-08-24T12:33:01.000Z'),
      env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
    });
    const idle = idleCycle.results.find(row => row.tenantId === tenant.id);
    assert.equal(idle?.kind, 'outside_window');
    assert.equal(idle?.activation?.kind, 'idle');
    assert.equal(idle?.activation?.shouldWake, false);
  } finally {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  }
});

test('guarded action ledger is idempotent and requires a later PostgreSQL-backed verification', async () => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Ops Guarded Integration ${Date.now()}`]);

  try {
    const run = await queryOne(`
      INSERT INTO ops_control_runs (
        tenant_id, service_date, window_start, window_end,
        mode, lifecycle_status, verdict, policy_version,
        runtime_baseline_version, snapshot_count, created_at, updated_at
      ) VALUES (
        $1, '2026-08-24', $2, $3,
        'guarded', 'recovering', 'degraded', 'ops-guarded-v1',
        '0.3.91', 2, $4, $4
      )
      RETURNING *
    `, [
      tenant.id,
      '2026-08-23T21:30:00.000Z',
      '2026-08-24T00:30:00.000Z',
      '2026-08-24T00:01:00.000Z',
    ]);
    const fingerprint = 'a'.repeat(64);
    const targetId = 'guarded-task-integration';
    await execute(`
      INSERT INTO ops_control_incidents (
        run_id, tenant_id, fingerprint, incident_type, severity,
        status, title, message, evidence,
        first_seen_at, last_seen_at, alert_next_attempt_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'final_task_failure', 'high',
        'open', '采集任务最终失败', '需要一次受控重试', $4::jsonb,
        $5, $5, $5, $5, $5
      )
    `, [
      run.id,
      tenant.id,
      fingerprint,
      JSON.stringify({taskId: targetId}),
      '2026-08-24T00:01:00.000Z',
    ]);
    await execute(`
      INSERT INTO ops_control_digests (
        run_id, tenant_id, service_date, verdict,
        subject, summary, payload, next_attempt_at, created_at, updated_at
      ) VALUES (
        $1, $2, '2026-08-24', 'degraded',
        'guarded integration', 'guarded integration', '{}'::jsonb,
        $3, $3, $3
      )
    `, [run.id, tenant.id, '2026-08-24T00:01:00.000Z']);

    const policy = {
      mode: 'guarded',
      actionsEnabled: true,
      actionAllowlist: ['capture_retry'],
      actionMaxPerRun: 3,
      actionMaxAttempts: 2,
      actionCooldownSeconds: 300,
      actionVerificationSeconds: 900,
    };
    const assessment = {
      summary: {consecutiveEvidence: true},
      incidents: [{
        type: 'final_task_failure',
        fingerprint,
        targetId,
        evidence: {taskId: targetId},
      }],
    };
    const failedSnapshot = {
      tasks: [{
        id: targetId,
        status: 'completed_with_failures',
        active: false,
        failedItemCount: 1,
        skippedItemCount: 0,
        needsActionItemCount: 0,
        recoveredItemCount: 0,
        progressSeq: 4,
        businessProgressAt: '2026-08-24T00:00:00.000Z',
      }],
      schedules: [],
      operations: {},
    };
    let handlerCalls = 0;
    const handlers = {
      capture_retry: async () => {
        handlerCalls += 1;
        return {dispatched: 1, failed: 0, manualOnly: 0};
      },
    };

    const first = await runOpsControlGuardedActions({
      tenantId: tenant.id,
      run,
      sequence: 2,
      snapshot: failedSnapshot,
      assessment,
      policy,
      now: new Date('2026-08-24T00:01:00.000Z'),
      handlers,
    });
    assert.equal(first.executed, 1);
    assert.equal(first.pendingVerification, 1);
    assert.equal(handlerCalls, 1);

    const replay = await runOpsControlGuardedActions({
      tenantId: tenant.id,
      run,
      sequence: 2,
      snapshot: failedSnapshot,
      assessment,
      policy,
      now: new Date('2026-08-24T00:01:30.000Z'),
      handlers,
    });
    assert.equal(replay.executed, 0);
    assert.equal(replay.pendingVerification, 1);
    assert.equal(handlerCalls, 1, 'same incident was executed twice');

    const recoveredSnapshot = {
      ...failedSnapshot,
      tasks: [{
        ...failedSnapshot.tasks[0],
        status: 'completed',
        failedItemCount: 0,
        recoveredItemCount: 1,
        progressSeq: 5,
        businessProgressAt: '2026-08-24T00:02:00.000Z',
      }],
    };
    const verified = await runOpsControlGuardedActions({
      tenantId: tenant.id,
      run,
      sequence: 3,
      snapshot: recoveredSnapshot,
      assessment: {summary: {consecutiveEvidence: true}, incidents: []},
      policy,
      now: new Date('2026-08-24T00:02:00.000Z'),
      handlers,
    });
    assert.equal(verified.verified, 1);
    assert.equal(verified.pendingVerification, 0);
    assert.equal(verified.verificationFailed, 0);
    assert.equal(handlerCalls, 1);

    const unhandledFingerprint = 'b'.repeat(64);
    await execute(`
      INSERT INTO ops_control_incidents (
        run_id, tenant_id, fingerprint, incident_type, severity,
        status, title, message, evidence,
        first_seen_at, last_seen_at, alert_next_attempt_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'ai_backlog_stalled', 'high',
        'open', 'AI 后处理队列未继续推进', '连续观察没有新完成量', '{}'::jsonb,
        $4, $4, $4, $4, $4
      )
    `, [run.id, tenant.id, unhandledFingerprint, '2026-08-24T00:02:00.000Z']);
    let alertCalls = 0;
    const alertPolicy = {
      ...policy,
      digestEmailEnabled: true,
      digestEmailTo: 'ops@example.test',
    };
    const alert = await maybeDeliverOpsControlIncidentAlerts({
      tenantId: tenant.id,
      run,
      policy: alertPolicy,
      assessment: {summary: {consecutiveEvidence: true}},
      now: new Date('2026-08-24T00:02:30.000Z'),
      sendEmail: async message => {
        alertCalls += 1;
        assert.equal(message.to, 'ops@example.test');
        assert.match(message.subject, /AI 后处理队列未继续推进/u);
        assert.match(message.html, /当前没有正在等待验收的自动恢复动作/u);
      },
    });
    assert.equal(alert.status, 'sent');
    assert.equal(alert.incidentCount, 1);
    assert.equal(alertCalls, 1);
    const alertReplay = await maybeDeliverOpsControlIncidentAlerts({
      tenantId: tenant.id,
      run,
      policy: alertPolicy,
      assessment: {summary: {consecutiveEvidence: true}},
      now: new Date('2026-08-24T00:03:00.000Z'),
      sendEmail: async () => { alertCalls += 1; },
    });
    assert.equal(alertReplay.status, 'idle');
    assert.equal(alertCalls, 1, 'same incident alert was sent twice');

    const [actions, persistedRun, digest, incidentAlerts] = await Promise.all([
      queryAll(`
        SELECT action_type, target_id, status, attempt_number,
          snapshot_before_sequence, snapshot_after_sequence,
          result, verification
        FROM ops_control_actions
        WHERE tenant_id = $1 AND run_id = $2
      `, [tenant.id, run.id]),
      queryOne('SELECT summary FROM ops_control_runs WHERE id = $1', [run.id]),
      queryOne('SELECT payload FROM ops_control_digests WHERE run_id = $1', [run.id]),
      queryAll(`
        SELECT fingerprint, alert_delivery_status, alert_attempt_count
        FROM ops_control_incidents
        WHERE run_id = $1
        ORDER BY fingerprint
      `, [run.id]),
    ]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action_type, 'capture_retry');
    assert.equal(actions[0].target_id, targetId);
    assert.equal(actions[0].status, 'verified');
    assert.equal(actions[0].attempt_number, 1);
    assert.equal(actions[0].snapshot_before_sequence, 2);
    assert.equal(actions[0].snapshot_after_sequence, 3);
    assert.equal(actions[0].result.dispatched, 1);
    assert.equal(actions[0].verification.recoveredAdvanced, true);
    assert.equal(persistedRun.summary.actions.verified, 1);
    assert.equal(digest.payload.actions.verified, 1);
    assert.deepEqual(incidentAlerts.map(row => ({
      fingerprint: row.fingerprint,
      status: row.alert_delivery_status,
      attempts: row.alert_attempt_count,
    })), [
      {fingerprint, status: 'ready', attempts: 0},
      {fingerprint: unhandledFingerprint, status: 'sent', attempts: 1},
    ]);
  } finally {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  }
});
