import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeDb,
  execute,
  queryAll,
  queryOne,
  withTransaction,
} from '../../../server/db/init.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {
  claimCaptureRecoveryIntents,
  ingestCaptureRecoveryItem,
  processCaptureRecoveryIntentBatch,
  processCaptureRecoveryWakeups,
} from '../../../server/services/capture-recovery-intents.js';
import {enqueueOpsControlWakeup} from '../../../server/services/ops-control-wakeup.js';
import {
  lockCaptureAgentExecutionSlot,
  tryLockCaptureAgentExecutionSlot,
} from '../../../server/services/capture-cloud.js';
import {
  loadCompatibleProfilePatrolAgent,
} from '../../../server/services/profile-patrol-dispatch.js';
import {upsertCapturedRecord} from '../../../server/services/record-store.js';

test('guarded recovery ledger is tenant-scoped, attempt-aware and restart-safe in PostgreSQL', async t => {
  await runMigrations();

  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Capture Recovery Integration ${Date.now()}`]);
  t.after(async () => {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  });

  const indexes = await queryAll(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [[
    'uniq_capture_task_items_id_tenant',
    'uniq_capture_task_item_attempts_id_tenant',
    'uniq_capture_task_attempts_id_tenant',
    'uniq_capture_tasks_id_tenant',
  ]]);
  assert.deepEqual(indexes.map(row => row.indexname), [
    'uniq_capture_task_attempts_id_tenant',
    'uniq_capture_task_item_attempts_id_tenant',
    'uniq_capture_task_items_id_tenant',
    'uniq_capture_tasks_id_tenant',
  ]);
  const safetyColumns = await queryAll(`
    SELECT table_name, column_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'capture_task_items'
          AND column_name = 'safety_handoff_count')
        OR
        (table_name = 'capture_recovery_intents'
          AND column_name IN (
            'safety_handoff_count',
            'source_lineage_silent'
          ))
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(
    safetyColumns.map(row => [
      row.table_name,
      row.column_name,
      row.column_default,
      row.is_nullable,
    ]),
    [
      ['capture_recovery_intents', 'safety_handoff_count', '0', 'NO'],
      ['capture_recovery_intents', 'source_lineage_silent', 'false', 'NO'],
      ['capture_task_items', 'safety_handoff_count', '0', 'NO'],
    ],
  );

  const authCode = await queryOne(`
    INSERT INTO auth_codes (tenant_id, code, status, expires_at)
    VALUES ($1, $2, 'active', now() + interval '1 day')
    RETURNING id
  `, [tenant.id, `RECOVERY-${Date.now()}`]);
  const authBinding = await queryOne(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [authCode.id, `recovery-binding-${Date.now()}`]);
  const agent = await queryOne(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, browser_name,
      app_version, allowed_platforms, status, last_heartbeat_at,
      auth_code_id, auth_binding_id, capabilities
    ) VALUES (
      $1, $2, 'Recovery integration node', 'Edge',
      '0.3.93', ARRAY['douyin'], 'active', now(), $3, $4, $5::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    `recovery-agent-${Date.now()}`,
    authCode.id,
    authBinding.id,
    JSON.stringify({
      remoteTaskCreate: true,
      remoteStop: true,
      dutyRecoveryLineageV1: true,
      remoteTaskEnhancementOptions: true,
      remoteTaskKeywordPostLimit: true,
      supportedPlatforms: ['douyin'],
    }),
  ]);
  const windowEndsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const parent = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'keyword_orchestration',
      'Douyin duty recovery parent', 'douyin', 'cloud', 'manual', 'running',
      $3::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    `recovery-parent-${Date.now()}`,
    JSON.stringify({recoveryWindowEndsAt: windowEndsAt.toISOString()}),
  ]);
  const execution = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, origin_agent_id, assigned_agent_id, parent_task_id,
      client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, attempt_number,
      metadata, error
    ) VALUES (
      $1, $2, $2, $3,
      $4, 'unattended_keyword_capture', 'unattended_keywords',
      'Douyin child execution', 'douyin', 'extension', 'cloud', 'failed', 1,
      $5::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    agent.id,
    parent.id,
    `recovery-execution-${Date.now()}`,
    JSON.stringify({
      structuredTaskHealth: {
        version: 1,
        appVersion: '0.3.93',
        stage: 'detail_capture',
        phase: 'comments',
        progressObserved: {observed: true, sequence: 8, current: 3, total: 6},
        healthEvidence: {
          page: {platform: 'douyin', tabStatus: 'complete', frozen: false},
          network: {available: true, status: 'degraded', timeoutCount: 2},
          runtime: {eventLoopLagMs: 18, serviceWorkerRestartCount: 1},
        },
      },
    }),
  ]);
  const taskAttempt = await queryOne(`
    INSERT INTO capture_task_attempts (
      tenant_id, task_id, agent_id, client_attempt_id, attempt_number,
      app_version, health_evidence, status, progress_seq, error
    ) VALUES (
      $1, $2, $3, $4, 1,
      '0.3.93', $5::jsonb, 'failed', 8, '{}'::jsonb
    )
    RETURNING id, app_version, health_evidence, pg_column_size(health_evidence) AS health_size
  `, [
    tenant.id,
    execution.id,
    agent.id,
    `recovery-attempt-${Date.now()}`,
    JSON.stringify({
      version: 1,
      appVersion: '0.3.93',
      stage: 'detail_capture',
      phase: 'comments',
      progressObserved: {observed: true, sequence: 8, current: 3, total: 6},
      healthEvidence: {
        page: {platform: 'douyin', tabStatus: 'complete', frozen: false},
        network: {available: true, status: 'degraded', timeoutCount: 2},
        runtime: {eventLoopLagMs: 18, serviceWorkerRestartCount: 1},
      },
    }),
  ]);
  assert.equal(taskAttempt.app_version, '0.3.93');
  assert.ok(Number(taskAttempt.health_size) < 4096);

  await assert.rejects(
    execute(`
      INSERT INTO capture_task_attempts (
        tenant_id, task_id, agent_id, client_attempt_id,
        attempt_number, app_version, status
      ) VALUES ($1, $2, $3, $4, 2, $5, 'failed')
    `, [tenant.id, execution.id, agent.id, `oversize-${Date.now()}`, 'x'.repeat(81)]),
    /capture_task_attempts_app_version_bounded_check/u,
  );

  const item = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, error, metadata
    ) VALUES (
      $1, $2, 'keyword:integration', 'douyin', 'keyword',
      'failed', 3, $3, $4,
      1, '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [tenant.id, parent.id, agent.id, execution.id]);
  const itemWakeup = await queryOne(`
    SELECT source_type, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_task_item'
      AND source_id = $2
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, item.id]);
  assert.equal(
    itemWakeup,
    null,
    'default-off recovery must not emit wakeups consumable by pre-074 code',
  );

  await execute(`
    INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES ($1, 'ops_control_recovery_mode', 'guarded')
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = excluded.value, updated_at = now()
  `, [tenant.id]);
  assert.equal(await queryOne(`
    SELECT id
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_backfill'
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id]), null, 'guarded mode alone must not enable recovery');
  await execute(`
    UPDATE tenant_settings
    SET value = 'observe', updated_at = now()
    WHERE tenant_id = $1 AND key = 'ops_control_recovery_mode'
  `, [tenant.id]);

  await execute(`
    INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES ($1, 'ops_control_recovery_enabled', 'true')
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = excluded.value, updated_at = now()
  `, [tenant.id]);
  const activationBackfill = await queryOne(`
    SELECT source_type, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_backfill'
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id]);
  assert.equal(activationBackfill.source_type, 'capture_recovery_backfill');
  assert.equal(activationBackfill.source_id, tenant.id);
  assert.equal(activationBackfill.payload.trigger, 'tenant_enable');
  assert.equal(activationBackfill.payload.observeOnly, true);

  await execute(`
    UPDATE capture_task_items
    SET error = jsonb_build_object(
        'code', 'NETWORK_TIMEOUT',
        'category', 'network_local'
      ),
      updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, item.id]);
  const enabledItemWakeup = await queryOne(`
    SELECT source_type, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_task_item'
      AND source_id = $2
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, item.id]);
  assert.equal(enabledItemWakeup.source_type, 'capture_task_item');
  assert.equal(enabledItemWakeup.payload.status, 'failed');

  const first = await ingestCaptureRecoveryItem({
    tenantId: tenant.id,
    itemId: item.id,
  });
  assert.equal(first.kind, 'created');
  assert.equal(first.classification.stage, 'detail_capture');
  assert.equal(first.classification.faultClass, 'network_local');
  assert.equal(first.intent.generation, 1);
  assert.equal(first.intent.source_execution_attempt_id, taskAttempt.id);
  assert.equal(first.intent.evidence.health.appVersion, '0.3.93');
  assert.equal(first.intent.evidence.health.page.tabStatus, 'complete');
  assert.equal(first.intent.evidence.health.network.timeoutCount, 2);
  assert.equal(first.intent.evidence.health.runtime.eventLoopLagMs, 18);
  assert.equal(JSON.stringify(first.intent.evidence).includes('https://'), false);

  const replay = await ingestCaptureRecoveryItem({
    tenantId: tenant.id,
    itemId: item.id,
  });
  assert.equal(replay.kind, 'existing');
  assert.equal(replay.intent.id, first.intent.id);

  await execute(`
    UPDATE capture_tasks
    SET metadata = jsonb_set(
      metadata,
      '{recoveryWindowEndsAt}',
      to_jsonb($3::text),
      true
    )
    WHERE tenant_id = $1 AND id = $2
  `, [
    tenant.id,
    parent.id,
    new Date(windowEndsAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
  ]);

  const claimNow = new Date();
  const [claimA, claimB] = await Promise.all([
    claimCaptureRecoveryIntents({
      tenantId: tenant.id,
      intentIds: [first.intent.id],
      now: claimNow,
      leaseToken: 'a0000000-0000-4000-8000-000000000071',
      leaseOwner: 'integration-a',
    }),
    claimCaptureRecoveryIntents({
      tenantId: tenant.id,
      intentIds: [first.intent.id],
      now: claimNow,
      leaseToken: 'a0000000-0000-4000-8000-000000000072',
      leaseOwner: 'integration-b',
    }),
  ]);
  assert.equal(claimA.intents.length + claimB.intents.length, 1);
  assert.equal(claimA.deferred.length + claimB.deferred.length, 1);
  const deferred = [...claimA.deferred, ...claimB.deferred][0];
  assert.ok(new Date(deferred.retry_at).getTime() > claimNow.getTime());

  const catchup = await processCaptureRecoveryWakeups({
    tenantId: tenant.id,
    wakeups: [{source_type: 'capture_recovery_intent', source_id: first.intent.id}],
    now: new Date(claimNow.getTime() + 1000),
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    enqueueWakeup: enqueueOpsControlWakeup,
  });
  assert.equal(catchup.claimed, 0);
  assert.equal(catchup.deferred.length, 1);
  const leaseWakeup = await queryOne(`
    SELECT reason, available_at
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_intent'
      AND source_id = $2
      AND reason = 'capture_recovery_lease_due'
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, first.intent.id]);
  assert.equal(leaseWakeup.reason, 'capture_recovery_lease_due');
  assert.ok(new Date(leaseWakeup.available_at).getTime() >= new Date(deferred.retry_at).getTime());

  let latest;
  for (const revision of [2, 3]) {
    await execute(`
      UPDATE capture_task_items
      SET assignment_revision = $3,
        attempt_count = $3 + 2,
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
    `, [tenant.id, item.id, revision]);
    latest = await ingestCaptureRecoveryItem({tenantId: tenant.id, itemId: item.id});
    assert.equal(latest.kind, 'rebound_without_budget_consumption');
    assert.equal(latest.intent.generation, 1);
    assert.equal(
      new Date(latest.intent.window_ends_at).toISOString(),
      new Date(first.intent.window_ends_at).toISOString(),
      'later metadata cannot extend the first fixed recovery window',
    );
  }

  const observed = await processCaptureRecoveryWakeups({
    tenantId: tenant.id,
    wakeups: [{source_type: 'capture_recovery_intent', source_id: latest.intent.id}],
    now: new Date(new Date(latest.intent.available_at).getTime() + 1),
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    enqueueWakeup: enqueueOpsControlWakeup,
  });
  assert.equal(observed.claimed, 1);
  assert.equal(observed.observed, 1);
  assert.equal(observed.actionsExecuted, 0);
  const waiting = await queryOne(`
    SELECT status, decision, available_at, resolved_at
    FROM capture_recovery_intents
    WHERE id = $1
  `, [latest.intent.id]);
  assert.equal(waiting.status, 'waiting_due');
  assert.equal(waiting.decision, 'observe');
  assert.equal(waiting.resolved_at, null);
  assert.ok(new Date(waiting.available_at).getTime() >= windowEndsAt.getTime());

  await execute(`
    UPDATE capture_recovery_intents
    SET status = 'waiting_agent',
      available_at = now() + interval '30 minutes',
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [latest.intent.id, tenant.id]);
  await execute(`
    UPDATE capture_agents
    SET last_heartbeat_at = now() - interval '10 minutes', updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [agent.id, tenant.id]);
  await execute(`
    UPDATE capture_agents
    SET last_heartbeat_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [agent.id, tenant.id]);
  const agentSlotWakeup = await queryOne(`
    SELECT source_type, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id]);
  assert.equal(agentSlotWakeup.source_type, 'capture_recovery_agent_slot');
  assert.equal(agentSlotWakeup.source_id, agent.id);
  assert.equal(agentSlotWakeup.payload.agentId, agent.id);

  const guardedItem = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type, keyword,
      status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, error, metadata
    ) VALUES (
      $1, $2, $3, 'douyin', 'keyword', 'guarded integration',
      'failed', 3, $4, $5,
      12, $6::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    parent.id,
    `keyword:guarded:${Date.now()}`,
    agent.id,
    execution.id,
    JSON.stringify({code: 'CONTENT_RELAY_TIMEOUT', stage: 'detail_capture'}),
  ]);
  const guardedSourceAttempt = await queryOne(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, checkpoint, result, error, finished_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 3, 12, 'failed',
      '', '{}'::jsonb, '{}'::jsonb, $6::jsonb, now()
    )
    RETURNING id
  `, [
    tenant.id,
    guardedItem.id,
    parent.id,
    execution.id,
    agent.id,
    JSON.stringify({code: 'CONTENT_RELAY_TIMEOUT', stage: 'detail_capture'}),
  ]);
  const guardedIntent = await ingestCaptureRecoveryItem({
    tenantId: tenant.id,
    itemId: guardedItem.id,
  });
  assert.equal(guardedIntent.kind, 'created');
  assert.equal(guardedIntent.intent.source_attempt_id, guardedSourceAttempt.id);

  const guardedRequestHash = 'a'.repeat(64);
  let dispatchedAttemptId = '';
  let recoveryTaskId = '';
  const actionNow = new Date(
    new Date(guardedIntent.intent.available_at).getTime() + 1,
  );
  const guardedAction = await processCaptureRecoveryIntentBatch({
    tenantId: tenant.id,
    intentIds: [guardedIntent.intent.id],
    now: actionNow,
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async input => {
      assert.deepEqual(input.itemIds, [guardedItem.id]);
      assert.equal(input.expectedSourceAttemptId, guardedSourceAttempt.id);
      assert.equal(input.expectedAttemptNumber, 3);
      const recoveryTask = await queryOne(`
        INSERT INTO capture_tasks (
          tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
          client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, metadata, orchestration_revision
        ) VALUES (
          $1, $2, $3, $3,
          $4, 'unattended_keyword_capture', 'unattended_keywords',
          'Guarded recovery child', 'douyin',
          'cloud', 'cross_device_retry', 'pending', $5::jsonb, 13
        )
        RETURNING id
      `, [
        tenant.id,
        parent.id,
        agent.id,
        `guarded-child-${Date.now()}`,
        JSON.stringify({
          dutyRecovery: true,
          dutyRecoveryIntentId: input.dutyRecoveryIntentId,
          dutyRecoveryGeneration: input.dutyRecoveryGeneration,
          dutyRecoverySourceItemId: guardedItem.id,
          remoteRequestHash: guardedRequestHash,
        }),
      ]);
      recoveryTaskId = recoveryTask.id;
      const commandIdentity = await queryOne(
        'SELECT gen_random_uuid() AS id',
      );
      await execute(`
        INSERT INTO capture_agent_commands (
          id, tenant_id, agent_id, task_id, command_type, payload
        ) VALUES ($1, $2, $3, $4, 'create', '{}'::jsonb)
      `, [commandIdentity.id, tenant.id, agent.id, recoveryTask.id]);
      const updatedItem = await queryOne(`
        UPDATE capture_task_items
        SET status = 'dispatched',
          attempt_count = 4,
          assigned_agent_id = $3,
          execution_task_id = $4,
          assignment_revision = 13,
          request_hash = $5,
          error = '{}'::jsonb,
          updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND assignment_revision = 12
        RETURNING id, attempt_count, assignment_revision
      `, [
        tenant.id,
        guardedItem.id,
        agent.id,
        recoveryTask.id,
        guardedRequestHash,
      ]);
      const dispatchedAttempt = await queryOne(`
        INSERT INTO capture_task_item_attempts (
          tenant_id, item_id, parent_task_id, execution_task_id,
          agent_id, attempt_number, assignment_revision, status,
          request_hash, checkpoint, result, error, dispatched_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, 4, 13, 'dispatched',
          $6, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
        )
        RETURNING id
      `, [
        tenant.id,
        guardedItem.id,
        parent.id,
        recoveryTask.id,
        agent.id,
        guardedRequestHash,
      ]);
      dispatchedAttemptId = dispatchedAttempt.id;
      return {
        existing: false,
        child: {id: recoveryTask.id},
        command: {id: commandIdentity.id},
        agent: {id: agent.id},
        parent: {orchestration_revision: 13},
        itemAttempts: [{
          id: dispatchedAttempt.id,
          itemId: guardedItem.id,
          executionTaskId: recoveryTask.id,
          agentId: agent.id,
          attemptNumber: updatedItem.attempt_count,
          assignmentRevision: updatedItem.assignment_revision,
          requestHash: guardedRequestHash,
          status: 'dispatched',
        }],
      };
    },
  });
  assert.equal(guardedAction.actionsExecuted, 1);
  assert.equal(guardedAction.results[0].status, 'verifying_collection');
  const verifying = await queryOne(`
    SELECT status, decision, action_count, recovery_task_id,
      recovery_agent_id, dispatched_attempt_id, expected_attempt_number,
      expected_assignment_revision, available_at
    FROM capture_recovery_intents
    WHERE id = $1 AND tenant_id = $2
  `, [guardedIntent.intent.id, tenant.id]);
  assert.equal(verifying.status, 'verifying_collection');
  assert.equal(verifying.decision, 'cross_agent_recovery');
  assert.equal(verifying.action_count, 1);
  assert.equal(verifying.recovery_agent_id, agent.id);
  assert.equal(verifying.dispatched_attempt_id, dispatchedAttemptId);
  assert.equal(verifying.expected_attempt_number, 4);
  assert.equal(verifying.expected_assignment_revision, 13);

  const lineageProbe = async (label, context = {}) => {
    const externalId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const result = await upsertCapturedRecord({
      external_id: externalId,
      platform: 'douyin',
      record_type: 'single_note',
      title: `Recovery lineage ${label}`,
      content: `Recovery lineage ${label}`,
      author_name: 'Integration',
      author_id: 'integration-author',
      url: `https://www.douyin.com/video/${externalId}`,
      keyword: 'guarded integration',
      source_type: 'keyword_capture',
      payload: {detailCaptureStatus: 'done'},
    }, {
      tenantId: tenant.id,
      ...context,
    });
    return queryOne(`
      SELECT capture_task_id, capture_task_item_id,
        capture_task_item_attempt_id
      FROM record_observations
      WHERE tenant_id = $1 AND id = $2
    `, [tenant.id, result.observationId]);
  };
  const exactAgentContext = {
    captureTaskId: recoveryTaskId,
    captureAgentId: agent.id,
    captureAgentAuthCodeId: authCode.id,
    captureAgentAuthBindingId: authBinding.id,
  };
  const unauthenticatedLineage = await lineageProbe('no-agent-identity', {
    captureTaskId: recoveryTaskId,
    captureTaskItemAttemptId: dispatchedAttemptId,
    captureTaskItemRequestHash: guardedRequestHash,
  });
  assert.equal(unauthenticatedLineage.capture_task_id, null);
  assert.equal(unauthenticatedLineage.capture_task_item_attempt_id, null);

  const wrongAgentIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const wrongAgentLineage = await lineageProbe('wrong-agent', {
    ...exactAgentContext,
    captureAgentId: wrongAgentIdentity.id,
    captureTaskItemAttemptId: dispatchedAttemptId,
    captureTaskItemRequestHash: guardedRequestHash,
  });
  assert.equal(wrongAgentLineage.capture_task_id, null);
  assert.equal(wrongAgentLineage.capture_task_item_attempt_id, null);

  const missingAttemptLineage = await lineageProbe(
    'missing-attempt',
    exactAgentContext,
  );
  assert.equal(missingAttemptLineage.capture_task_id, null);
  assert.equal(missingAttemptLineage.capture_task_item_attempt_id, null);

  const wrongAttemptIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const wrongAttemptLineage = await lineageProbe('wrong-attempt', {
    ...exactAgentContext,
    captureTaskItemAttemptId: wrongAttemptIdentity.id,
    captureTaskItemRequestHash: guardedRequestHash,
  });
  assert.equal(wrongAttemptLineage.capture_task_id, null);
  assert.equal(wrongAttemptLineage.capture_task_item_attempt_id, null);

  const wrongHashLineage = await lineageProbe('wrong-hash', {
    ...exactAgentContext,
    captureTaskItemAttemptId: dispatchedAttemptId,
    captureTaskItemRequestHash: 'b'.repeat(64),
  });
  assert.equal(wrongHashLineage.capture_task_id, null);
  assert.equal(wrongHashLineage.capture_task_item_attempt_id, null);

  await execute(`
    UPDATE capture_recovery_intents
    SET status = 'waiting_due', updated_at = clock_timestamp()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, guardedIntent.intent.id]);
  const nonVerifyingLineage = await lineageProbe('not-verifying', {
    ...exactAgentContext,
    captureTaskItemAttemptId: dispatchedAttemptId,
    captureTaskItemRequestHash: guardedRequestHash,
  });
  assert.equal(nonVerifyingLineage.capture_task_id, null);
  assert.equal(nonVerifyingLineage.capture_task_item_attempt_id, null);
  await execute(`
    UPDATE capture_recovery_intents
    SET status = 'verifying_collection', updated_at = clock_timestamp()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, guardedIntent.intent.id]);

  const exactLineage = await lineageProbe('exact-attempt', {
    ...exactAgentContext,
    captureTaskItemAttemptId: dispatchedAttemptId,
    captureTaskItemRequestHash: guardedRequestHash,
  });
  assert.equal(exactLineage.capture_task_id, recoveryTaskId);
  assert.equal(exactLineage.capture_task_item_id, guardedItem.id);
  assert.equal(exactLineage.capture_task_item_attempt_id, dispatchedAttemptId);

  const finishedAt = new Date(actionNow.getTime() + 30_000).toISOString();
  await execute(`
    UPDATE capture_task_items
    SET status = 'completed',
      metadata = jsonb_build_object(
        'checkpoint', jsonb_build_object(
          'status', 'completed',
          'savedCount', 0,
          'noResults', true,
          'resultKind', 'no_matching_results',
          'candidateCount', 0,
          'scanComplete', true,
          'searchPassResults', jsonb_build_array(jsonb_build_object(
            'round', 1,
            'status', 'completed',
            'scanComplete', true
          )),
          'finishedAt', $3::text
        )
      ),
      finished_at = $3::timestamptz,
      updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, guardedItem.id, finishedAt]);
  await execute(`
    UPDATE capture_task_item_attempts
    SET status = 'completed',
      checkpoint = jsonb_build_object(
        'status', 'completed',
        'savedCount', 0,
        'noResults', true,
        'resultKind', 'no_matching_results',
        'candidateCount', 0,
        'scanComplete', true,
        'searchPassResults', jsonb_build_array(jsonb_build_object(
          'round', 1,
          'status', 'completed',
          'scanComplete', true
        )),
        'finishedAt', $3::text
      ),
      result = jsonb_build_object('savedCount', 0),
      finished_at = $3::timestamptz,
      updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, dispatchedAttemptId, finishedAt]);
  await execute(`
    UPDATE capture_recovery_intents
    SET available_at = clock_timestamp() - interval '1 second',
      updated_at = clock_timestamp()
    WHERE id = $1 AND tenant_id = $2
  `, [guardedIntent.intent.id, tenant.id]);
  const verified = await processCaptureRecoveryIntentBatch({
    tenantId: tenant.id,
    intentIds: [guardedIntent.intent.id],
    now: new Date(),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => assert.fail(
      'business verification must not dispatch another recovery',
    ),
  });
  assert.equal(verified.actionsExecuted, 0);
  assert.equal(verified.results[0].status, 'resolved');
  assert.equal(
    verified.results[0].verification.reason,
    'business_outcome_verified',
  );
  const verifiedLedger = await queryOne(`
    SELECT status, action_count, verification
    FROM capture_recovery_intents
    WHERE id = $1 AND tenant_id = $2
  `, [guardedIntent.intent.id, tenant.id]);
  assert.equal(verifiedLedger.status, 'resolved');
  assert.equal(verifiedLedger.action_count, 1);
  assert.equal(verifiedLedger.verification.businessOutcome.verified, true);

  await execute(`
    UPDATE capture_task_items
    SET assignment_revision = 4,
      attempt_count = 4,
      error = jsonb_build_object(
        'code', 'CONTENT_RELAY_TIMEOUT',
        'stage', 'comments'
      ),
      updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, item.id]);
  const reboundAfterNewFailure = await ingestCaptureRecoveryItem({
    tenantId: tenant.id,
    itemId: item.id,
  });
  assert.equal(reboundAfterNewFailure.kind, 'rebound_without_budget_consumption');
  assert.equal(reboundAfterNewFailure.intent.generation, 1);
  assert.equal(reboundAfterNewFailure.intent.action_count, 0);

  const stopIntentIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const stopIntentId = stopIntentIdentity.id;
  const stopChild = await queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, attempt_number, metadata
    ) VALUES (
      $1, $2, $3, $4, $4,
      $1::uuid::text, $1::uuid::text,
      'negative_post_patrol', 'negative_post_patrol',
      'Recovery stop integration child',
      'douyin', 'cloud', 'cross_device_retry', 'running', 1,
      jsonb_build_object(
        'dutyRecovery', true,
        'dutyRecoveryIntentId', $1::uuid::text,
        'dutyRecoveryGeneration', 1
      )
    )
    RETURNING id
  `, [stopIntentId, tenant.id, parent.id, agent.id]);
  const stopItem = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, error, metadata
    ) VALUES (
      $1, $2, $3, 'douyin', 'watched_content',
      'running', 1, $4, $5,
      1, '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    parent.id,
    `recovery-stop:${Date.now()}`,
    agent.id,
    stopChild.id,
  ]);
  const stopAttempt = await queryOne(`
    INSERT INTO capture_task_attempts (
      tenant_id, task_id, agent_id, client_attempt_id,
      attempt_number, status, progress_seq
    ) VALUES ($1, $2, $3, $4, 1, 'running', 1)
    RETURNING id, client_attempt_id
  `, [tenant.id, stopChild.id, agent.id, `stop-attempt-${Date.now()}`]);
  const acknowledgedCreate = await queryOne(`
    INSERT INTO capture_agent_commands (
      tenant_id, agent_id, task_id, command_type, status,
      payload, acknowledged_at
    ) VALUES (
      $1, $2, $3, 'create', 'acknowledged',
      jsonb_build_object(
        'authCodeId', $4::uuid,
        'authBindingId', $5::uuid,
        'platform', 'douyin'
      ),
      now()
    )
    RETURNING id
  `, [tenant.id, agent.id, stopChild.id, authCode.id, authBinding.id]);
  await execute(`
    INSERT INTO capture_recovery_intents (
      id, tenant_id, parent_task_id, item_id,
      stage, fault_class, status, decision,
      recovery_key, source_fingerprint,
      expected_assignment_revision, expected_attempt_number,
      recovery_task_id, recovery_command_id, recovery_agent_id,
      window_ends_at, action_count, verification, resolved_at
    ) VALUES (
      $1, $2, $3, $4,
      'detail_capture', 'network_local', 'stopped_by_user', 'stop',
      repeat('c', 64), repeat('d', 64),
      1, 1,
      $5, $6, $7,
      now() + interval '4 hours', 1, '{}'::jsonb, now()
    )
  `, [
    stopIntentId,
    tenant.id,
    parent.id,
    stopItem.id,
    stopChild.id,
    acknowledgedCreate.id,
    agent.id,
  ]);

  let releaseAgentSlot;
  let announceAgentSlot;
  const agentSlotHeld = new Promise(resolve => {
    announceAgentSlot = resolve;
  });
  const releaseAgentSlotPromise = new Promise(resolve => {
    releaseAgentSlot = resolve;
  });
  const slotHolder = withTransaction(async tx => {
    await tx.execute(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['capture_agent_execution_slot', `${tenant.id}:${agent.id}`],
    );
    announceAgentSlot();
    await releaseAgentSlotPromise;
  });
  await agentSlotHeld;
  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, stopIntentId, parent.id, 'integration-user-stop']);
  const lockedRetry = await queryOne(`
    SELECT verification
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, stopIntentId]);
  assert.equal(lockedRetry.verification.cascadeStopState, 'retry_wait');
  assert.equal(lockedRetry.verification.cascadeStopCheckCount, 1);
  assert.equal(await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2
      AND command_type = 'stop'
  `, [tenant.id, stopChild.id]).then(row => row.count), 0);
  releaseAgentSlot();
  await slotHolder;

  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, stopIntentId, parent.id, 'integration-user-stop']);
  const durableStop = await queryOne(`
    SELECT id, status, payload, expires_at
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2
      AND command_type = 'stop'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [tenant.id, stopChild.id]);
  assert.equal(durableStop.status, 'pending');
  assert.equal(durableStop.payload.attemptId, stopAttempt.client_attempt_id);
  assert.equal(durableStop.payload.authCodeId, authCode.id);
  assert.equal(durableStop.payload.authBindingId, authBinding.id);
  assert.equal(
    durableStop.payload.supersededCreateCommandId,
    acknowledgedCreate.id,
  );
  assert.ok(
    new Date(durableStop.expires_at).getTime() <= Date.now() + 5 * 60 * 1000,
  );
  const stopEventCount = await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM capture_task_events
    WHERE tenant_id = $1 AND task_id = $2
      AND event_type = 'duty_recovery_stop_requested'
  `, [tenant.id, stopChild.id]);
  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, stopIntentId, parent.id, 'integration-user-stop']);
  const repeatedStopEventCount = await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM capture_task_events
    WHERE tenant_id = $1 AND task_id = $2
      AND event_type = 'duty_recovery_stop_requested'
  `, [tenant.id, stopChild.id]);
  assert.equal(repeatedStopEventCount.count, stopEventCount.count);

  await execute(`
    UPDATE capture_recovery_intents
    SET verification = verification || jsonb_build_object(
      'cascadeStopDeadlineAt', (clock_timestamp() - interval '1 second')::text
    )
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, stopIntentId]);
  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, stopIntentId, parent.id, 'integration-user-stop']);
  const manualStop = await queryOne(`
    SELECT status, verification
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, stopIntentId]);
  assert.equal(manualStop.status, 'stopped_by_user');
  assert.equal(manualStop.verification.cascadeStopState, 'manual_required');
  assert.equal(await queryOne(`
    SELECT status
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, durableStop.id]).then(row => row.status), 'expired');

  await execute(`
    UPDATE capture_tasks
    SET status = 'canceled', finished_at = now(), updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, stopChild.id]);
  const terminalStopWake = await queryOne(`
    SELECT reason, source_type, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_intent'
      AND source_id = $2
      AND reason = 'capture_recovery_child_terminal'
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, stopIntentId]);
  assert.equal(terminalStopWake.payload.childStatus, 'canceled');
  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, stopIntentId, parent.id, 'integration-user-stop']);
  const verifiedStop = await queryOne(`
    SELECT verification
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, stopIntentId]);
  assert.equal(verifiedStop.verification.cascadeStopState, 'verified');

  const scopedIntentIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const scopedIntentId = scopedIntentIdentity.id;
  const scopedChild = await queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, attempt_number, metadata
    ) VALUES (
      $1, $2, $3, $4, $4,
      $1::uuid::text, $1::uuid::text,
      'unattended_keyword_capture', 'unattended_keywords',
      'Scoped stop integration child',
      'douyin', 'cloud', 'cross_device_retry', 'running', 1,
      jsonb_build_object(
        'dutyRecovery', true,
        'dutyRecoveryIntentId', $1::uuid::text,
        'dutyRecoveryGeneration', 1
      )
    )
    RETURNING id
  `, [scopedIntentId, tenant.id, parent.id, agent.id]);
  const scopedItem = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, error, metadata
    ) VALUES (
      $1, $2, $3, 'douyin', 'keyword',
      'running', 1, $4, $5,
      1, '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    parent.id,
    `recovery-scope-stop:${Date.now()}`,
    agent.id,
    scopedChild.id,
  ]);
  const scopedCreate = await queryOne(`
    INSERT INTO capture_agent_commands (
      tenant_id, agent_id, task_id, command_type, status,
      payload, acknowledged_at
    ) VALUES (
      $1, $2, $3, 'create', 'acknowledged',
      jsonb_build_object(
        'authCodeId', $4::uuid,
        'authBindingId', $5::uuid,
        'platform', 'douyin'
      ),
      now()
    )
    RETURNING id
  `, [tenant.id, agent.id, scopedChild.id, authCode.id, authBinding.id]);
  await execute(`
    INSERT INTO capture_recovery_intents (
      id, tenant_id, parent_task_id, item_id,
      stage, fault_class, status, decision,
      recovery_key, source_fingerprint,
      expected_assignment_revision, expected_attempt_number,
      recovery_task_id, recovery_command_id, recovery_agent_id,
      window_ends_at, action_count, verification
    ) VALUES (
      $1, $2, $3, $4,
      'detail_capture', 'network_local', 'failed',
      'cross_agent_recovery',
      repeat('e', 64), repeat('f', 64),
      1, 1,
      $5, $6, $7,
      now() + interval '4 hours', 1, '{}'::jsonb
    )
  `, [
    scopedIntentId,
    tenant.id,
    parent.id,
    scopedItem.id,
    scopedChild.id,
    scopedCreate.id,
    agent.id,
  ]);
  const scopedStopIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  await execute(`
    UPDATE capture_tasks
    SET metadata = metadata || jsonb_build_object(
        'stopCommandId', $3::uuid::text,
        'operatorStopped', true
      ),
      updated_at = clock_timestamp()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, scopedChild.id, scopedStopIdentity.id]);
  const immediatelyStopped = await queryOne(`
    SELECT status, decision, verification, lease_token
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, scopedIntentId]);
  assert.equal(immediatelyStopped.status, 'stopped_by_user');
  assert.equal(immediatelyStopped.decision, 'stop');
  assert.equal(
    immediatelyStopped.verification.reason,
    'recovery_child_stopped_by_user',
  );
  assert.equal(immediatelyStopped.lease_token, null);
  const queuedExactScopeStop = await queryOne(`
    SELECT payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_scope_stop'
      AND source_id = $2
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, scopedIntentId]);
  assert.equal(queuedExactScopeStop.payload.childTaskId, scopedChild.id);
  await execute(`
    UPDATE capture_task_items
    SET status = 'failed', attempt_count = 3, assignment_revision = 3,
      execution_task_id = $3,
      error = jsonb_build_object(
        'code', 'CONTENT_RELAY_TIMEOUT',
        'stage', 'detail_capture'
      ),
      updated_at = clock_timestamp()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, scopedItem.id, execution.id]);
  await execute(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, checkpoint, result, error, finished_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 3, 3, 'failed',
      '', '{}'::jsonb, '{}'::jsonb,
      jsonb_build_object(
        'code', 'CONTENT_RELAY_TIMEOUT',
        'stage', 'detail_capture'
      ),
      clock_timestamp()
    )
  `, [tenant.id, scopedItem.id, parent.id, execution.id, agent.id]);
  const stoppedReplay = await ingestCaptureRecoveryItem({
    tenantId: tenant.id,
    itemId: scopedItem.id,
  });
  assert.equal(stoppedReplay.kind, 'stopped_by_user');
  assert.equal(stoppedReplay.intent.id, scopedIntentId);
  assert.equal(await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND item_id = $2
  `, [tenant.id, scopedItem.id]).then(row => row.count), 1);
  const scopeStopResult = await processCaptureRecoveryWakeups({
    tenantId: tenant.id,
    wakeups: [{
      source_type: 'capture_recovery_scope_stop',
      source_id: scopedIntentId,
      payload: {
        scopeType: 'recovery_intent',
        intentId: scopedIntentId,
        childTaskId: scopedChild.id,
      },
    }],
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'false'},
    getSettings: async () => ({ops_control_recovery_enabled: 'false'}),
  });
  assert.equal(scopeStopResult.kind, 'disabled');
  assert.equal(scopeStopResult.scopeStop.stopped, 1);
  assert.equal(scopeStopResult.stopPropagation.propagated, 1);
  const scopedStopped = await queryOne(`
    SELECT status, verification
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, scopedIntentId]);
  assert.equal(scopedStopped.status, 'stopped_by_user');
  assert.equal(scopedStopped.verification.cascadeStopState, 'command_pending');

  const decoyIntentIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const decoyIntentId = decoyIntentIdentity.id;
  const decoyItem = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, error, metadata
    ) VALUES (
      $1, $2, $3, 'douyin', 'keyword',
      'failed', 3, $4, $5,
      1, jsonb_build_object(
        'code', 'CONTENT_RELAY_TIMEOUT',
        'stage', 'detail_capture'
      ), '{}'::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    parent.id,
    `recovery-decoy:${Date.now()}`,
    agent.id,
    execution.id,
  ]);
  await execute(`
    INSERT INTO capture_recovery_intents (
      id, tenant_id, parent_task_id, item_id,
      stage, fault_class, status, decision,
      recovery_key, source_fingerprint,
      expected_assignment_revision, expected_attempt_number,
      window_ends_at, verification
    ) VALUES (
      $1, $2, $3, $4,
      'detail_capture', 'network_local', 'waiting_agent',
      'cross_agent_recovery',
      repeat('1', 64), repeat('2', 64),
      1, 3,
      now() + interval '4 hours', '{}'::jsonb
    )
  `, [decoyIntentId, tenant.id, parent.id, decoyItem.id]);
  const decoyStopIdentity = await queryOne(
    'SELECT gen_random_uuid() AS id',
  );
  const decoyTask = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, attempt_number, metadata
    ) VALUES (
      $1, $2, $2,
      $3, $3, 'unattended_keyword_capture', 'unattended_keywords',
      'Unrelated recovery metadata decoy',
      'douyin', 'cloud', 'manual', 'running', 1,
      jsonb_build_object(
        'dutyRecovery', true,
        'dutyRecoveryIntentId', $4::uuid::text,
        'dutyRecoveryGeneration', 1,
        'stopCommandId', $5::uuid::text,
        'operatorStopped', true
      )
    )
    RETURNING id, status
  `, [
    tenant.id,
    agent.id,
    `recovery-decoy-task-${Date.now()}`,
    decoyIntentId,
    decoyStopIdentity.id,
  ]);
  const decoyLedger = await queryOne(`
    SELECT status, decision
    FROM capture_recovery_intents
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, decoyIntentId]);
  assert.equal(decoyLedger.status, 'waiting_agent');
  await execute(`
    SELECT propagate_capture_recovery_user_stop(
      $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [tenant.id, decoyIntentId, parent.id, 'decoy-stop']);
  assert.equal(await queryOne(`
    SELECT status
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, decoyTask.id]).then(row => row.status), 'running');
  assert.equal(await queryOne(`
    SELECT COUNT(*)::int AS count
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2
      AND command_type = 'stop'
  `, [tenant.id, decoyTask.id]).then(row => row.count), 0);

  await execute(`
    UPDATE ops_control_wakeups
    SET processed_at = now(), updated_at = now()
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
  `, [tenant.id, agent.id]);
  await execute(
    "UPDATE tenants SET status = 'paused', updated_at = now() WHERE id = $1",
    [tenant.id],
  );
  await execute(
    "UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1",
    [tenant.id],
  );
  const tenantRestoredWake = await queryOne(`
    SELECT reason, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, agent.id]);
  assert.equal(tenantRestoredWake.reason, 'capture_recovery_entitlement_restored');
  assert.equal(tenantRestoredWake.payload.trigger, 'tenant_reactivated');
  await execute(`
    UPDATE ops_control_wakeups
    SET processed_at = now(), updated_at = now()
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
  `, [tenant.id, agent.id]);
  await execute(
    "UPDATE auth_codes SET status = 'frozen' WHERE id = $1",
    [authCode.id],
  );
  await execute(
    "UPDATE auth_codes SET status = 'active' WHERE id = $1",
    [authCode.id],
  );
  const authRestoredWake = await queryOne(`
    SELECT reason, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, agent.id]);
  assert.equal(authRestoredWake.reason, 'capture_recovery_entitlement_restored');
  assert.equal(authRestoredWake.payload.trigger, 'auth_code_reactivated');
  await execute(`
    UPDATE ops_control_wakeups
    SET processed_at = now(), updated_at = now()
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
  `, [tenant.id, agent.id]);
  await execute(
    "UPDATE auth_codes SET status = 'frozen' WHERE id = $1",
    [authCode.id],
  );
  const replacementAuthCode = await queryOne(`
    INSERT INTO auth_codes (tenant_id, code, status, expires_at)
    VALUES ($1, $2, 'active', now() + interval '1 day')
    RETURNING id
  `, [tenant.id, `RECOVERY-REBOUND-${Date.now()}`]);
  const replacementAuthBinding = await queryOne(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [replacementAuthCode.id, `recovery-rebound-${Date.now()}`]);
  await execute(`
    UPDATE capture_agents
    SET auth_code_id = $2, auth_binding_id = $3, updated_at = now()
    WHERE tenant_id = $1 AND id = $4
  `, [
    tenant.id,
    replacementAuthCode.id,
    replacementAuthBinding.id,
    agent.id,
  ]);
  const reboundAgentWake = await queryOne(`
    SELECT reason, source_id, payload
    FROM ops_control_wakeups
    WHERE tenant_id = $1
      AND source_type = 'capture_recovery_agent_slot'
      AND source_id = $2
      AND processed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, [tenant.id, agent.id]);
  assert.equal(reboundAgentWake.reason, 'capture_recovery_agent_slot_changed');
  assert.equal(reboundAgentWake.payload.agentId, agent.id);

  const slotAgent = await queryOne(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, browser_name,
      app_version, allowed_platforms, status, last_heartbeat_at,
      auth_code_id, auth_binding_id, capabilities
    ) VALUES (
      $1, $2, 'Profile slot integration node', 'Edge',
      '0.3.93', ARRAY['douyin'], 'active', now(), $3, $4, $5::jsonb
    )
    RETURNING id
  `, [
    tenant.id,
    `profile-slot-agent-${Date.now()}`,
    replacementAuthCode.id,
    replacementAuthBinding.id,
    JSON.stringify({
      remoteTaskCreate: true,
      remoteStop: true,
      dutyRecoveryLineageV1: true,
      remoteTargetedPostCaptureV1: true,
      followedCreatorPostPatrol: true,
      supportedPlatforms: ['douyin'],
    }),
  ]);
  let releaseDutySlot;
  let signalDutySlotLocked;
  const dutySlotRelease = new Promise(resolve => {
    releaseDutySlot = resolve;
  });
  const dutySlotLocked = new Promise(resolve => {
    signalDutySlotLocked = resolve;
  });
  let dutyBlockerTaskId = '';
  const dutySlotOwner = withTransaction(async tx => {
    await lockCaptureAgentExecutionSlot(tx, tenant.id, slotAgent.id);
    const blocker = await tx.queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, origin_agent_id, assigned_agent_id,
        client_task_id, task_type, feature_key, title,
        platform, source, trigger_type, status, metadata
      ) VALUES (
        $1, $2, $2,
        $3, 'followed_creator_post_patrol',
        'followed_creator_post_patrol', 'Duty slot winner',
        'douyin', 'cloud', 'cross_device_retry', 'pending', '{}'::jsonb
      )
      RETURNING id
    `, [tenant.id, slotAgent.id, `duty-slot-${Date.now()}`]);
    dutyBlockerTaskId = blocker.id;
    signalDutySlotLocked();
    await dutySlotRelease;
  });
  await dutySlotLocked;
  const manualProfileAttempt = withTransaction(tx =>
    loadCompatibleProfilePatrolAgent(
      tx,
      tenant.id,
      slotAgent.id,
      ['douyin'],
      'creator',
    ));
  releaseDutySlot();
  await dutySlotOwner;
  const manualAfterDuty = await manualProfileAttempt;
  assert.equal(manualAfterDuty.failure.error, 'profile_scan_agent_busy');
  assert.equal(
    manualAfterDuty.failure.details.blockerTaskId,
    dutyBlockerTaskId,
  );
  await execute(`
    UPDATE capture_tasks
    SET status = 'canceled', finished_at = now(), updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, dutyBlockerTaskId]);

  let releaseManualSlot;
  let signalManualSlotLocked;
  const manualSlotRelease = new Promise(resolve => {
    releaseManualSlot = resolve;
  });
  const manualSlotLocked = new Promise(resolve => {
    signalManualSlotLocked = resolve;
  });
  const manualSlotOwner = withTransaction(async tx => {
    await lockCaptureAgentExecutionSlot(tx, tenant.id, slotAgent.id);
    signalManualSlotLocked();
    await manualSlotRelease;
  });
  await manualSlotLocked;
  const dutyCouldTakeManualSlot = await withTransaction(tx =>
    tryLockCaptureAgentExecutionSlot(tx, tenant.id, slotAgent.id));
  assert.equal(dutyCouldTakeManualSlot, false);
  releaseManualSlot();
  await manualSlotOwner;
});
