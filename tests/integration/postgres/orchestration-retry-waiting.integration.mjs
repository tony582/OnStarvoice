import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  closeDb,
  execute,
  queryAll,
  queryOne,
} from '../../../server/db/init.js';
import {getPool} from '../../../server/db/pool.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {
  reconcilePendingOrchestrationRetries,
} from '../../../server/routes/capture-orchestrations.js';
import {hashOrchestrationRequest} from '../../../server/services/capture-orchestration.js';

const PLAN_SNAPSHOT = Object.freeze({
  enabled: true,
  platform: 'douyin',
  keywordMaxDetectedItems: 5,
});

async function createAgent(tenantId, ordinal, {knownUsage = true} = {}) {
  const authCode = await queryOne(`
    INSERT INTO auth_codes (tenant_id, code, status, expires_at)
    VALUES ($1, $2, 'active', now() + interval '1 day')
    RETURNING id
  `, [tenantId, `RETRY-WAIT-${ordinal}-${crypto.randomUUID()}`]);
  const authBinding = await queryOne(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [authCode.id, `retry-wait-binding-${ordinal}-${crypto.randomUUID()}`]);
  const agent = await queryOne(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, browser_name,
      app_version, allowed_platforms, status, last_heartbeat_at,
      auth_code_id, auth_binding_id, capabilities
    ) VALUES (
      $1, $2, $3, 'Edge',
      '0.3.93', ARRAY['douyin'], 'active', now(),
      $4, $5, $6::jsonb
    )
    RETURNING id
  `, [
    tenantId,
    `retry-wait-agent-${ordinal}-${crypto.randomUUID()}`,
    `Retry waiting Agent ${ordinal}`,
    authCode.id,
    authBinding.id,
    JSON.stringify({
      remoteTaskCreate: true,
      remoteTaskKeywordPostLimit: true,
      supportedPlatforms: ['douyin'],
    }),
  ]);
  if (knownUsage) {
    await execute(`
      INSERT INTO social_agent_daily_usage (
        tenant_id, agent_id, platform, usage_date,
        searches, failed_events, safety_verifications, last_event_at
      ) VALUES (
        $1, $2, 'douyin',
        (now() AT TIME ZONE 'Asia/Shanghai')::date,
        1, 0, 0, now()
      )
    `, [tenantId, agent.id]);
  }
  return agent;
}

async function createExecutionTask({
  tenantId,
  parentId,
  agentId,
  title,
  status,
}) {
  return queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, feature_key, title, platform,
      source, trigger_type, status, metadata
    ) VALUES (
      $1, $2, $3, $3,
      $4, 'unattended_keyword_capture', 'unattended_keyword_plan',
      $5, 'douyin', 'cloud', 'orchestration_retry', $6, $7::jsonb
    )
    RETURNING id
  `, [
    tenantId,
    parentId,
    agentId,
    `retry-wait-execution-${crypto.randomUUID()}`,
    title,
    status,
    JSON.stringify({orchestrationChild: true, parentTaskId: parentId}),
  ]);
}

async function createItemAttempt({
  tenantId,
  parentId,
  itemId,
  executionTaskId,
  agentId,
  attemptNumber,
  assignmentRevision,
  status,
}) {
  await execute(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, dispatched_at, started_at, finished_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      '', now(), now(),
      CASE WHEN $8 = ANY($9::text[]) THEN now() ELSE NULL END
    )
  `, [
    tenantId,
    itemId,
    parentId,
    executionTaskId,
    agentId,
    attemptNumber,
    assignmentRevision,
    status,
    ['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'],
  ]);
}

async function createWaitingItem({
  tenantId,
  parentId,
  agentId,
  ordinal,
  parentRevision,
  requestKey = crypto.randomUUID(),
  preferredAgentId = '',
  planHash = hashOrchestrationRequest(PLAN_SNAPSHOT),
  waitingSince = new Date().toISOString(),
}) {
  const source = await createExecutionTask({
    tenantId,
    parentId,
    agentId,
    title: `Settled source ${ordinal}`,
    status: 'failed',
  });
  const requestHash = crypto
    .createHash('sha256')
    .update(`retry-wait-${requestKey}`)
    .digest('hex');
  const itemRevision = Math.max(1, parentRevision - 1);
  const item = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, ordinal, keyword, platform,
      item_type, status, attempt_count, assigned_agent_id,
      execution_task_id, assignment_revision, request_hash,
      error, metadata, finished_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'douyin',
      'keyword', 'retryable', 1, $6,
      $7, $8, '', '{}'::jsonb, $9::jsonb, now()
    )
    RETURNING id
  `, [
    tenantId,
    parentId,
    `retry-wait-item-${ordinal}-${crypto.randomUUID()}`,
    ordinal,
    `retry-wait-keyword-${ordinal}`,
    agentId,
    source.id,
    itemRevision,
    JSON.stringify({
      retryPending: true,
      retryWaitingSince: waitingSince,
      retryWaitingRequestKey: requestKey,
      retryWaitingRequestHash: requestHash,
      retryWaitingPlanHash: planHash,
      retryWaitingReason: 'no_idle_agent',
      retryWaitingAgentId: preferredAgentId,
      retryWaitingParentRevision: parentRevision,
      retryWaitingItemRevision: itemRevision,
      retryWaitingAttemptCount: 1,
      retryWaitingSourceExecutionTaskId: source.id,
      retryWaitingSafetyConfirmed: false,
      retryWaitingRequestedByUserId: '',
      retryWaitingRequestedByName: 'Integration operator',
      retryWaitingBatchSize: 4,
      retryWaitingDispatchOrdinal: ordinal,
    }),
  ]);
  await createItemAttempt({
    tenantId,
    parentId,
    itemId: item.id,
    executionTaskId: source.id,
    agentId,
    attemptNumber: 1,
    assignmentRevision: itemRevision,
    status: 'failed',
  });
  return {item, requestHash, requestKey, source};
}

test('waiting retry auto-dispatch is slot-aware, concurrent-safe and usage fail-closed', async t => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Retry waiting integration ${Date.now()}`]);
  t.after(async () => {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  });

  const agents = await Promise.all([
    createAgent(tenant.id, 1),
    createAgent(tenant.id, 2),
    createAgent(tenant.id, 3),
  ]);
  const parent = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, orchestration_revision,
      metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'keyword_orchestration',
      'Four items on three Agents', 'douyin', 'cloud', 'manual',
      'pending', 8, $3::jsonb
    )
    RETURNING id, orchestration_revision
  `, [
    tenant.id,
    `retry-wait-parent-${crypto.randomUUID()}`,
    JSON.stringify({
      executionMode: 'one_time',
      planSnapshot: PLAN_SNAPSHOT,
    }),
  ]);

  const activeItems = [];
  for (let index = 0; index < 3; index += 1) {
    const execution = await createExecutionTask({
      tenantId: tenant.id,
      parentId: parent.id,
      agentId: agents[index].id,
      title: `Active retry ${index + 1}`,
      status: 'pending',
    });
    const item = await queryOne(`
      INSERT INTO capture_task_items (
        tenant_id, task_id, item_key, ordinal, keyword, platform,
        item_type, status, attempt_count, assigned_agent_id,
        execution_task_id, assignment_revision, request_hash, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, 'douyin',
        'keyword', 'dispatched', 1, $6,
        $7, 8, '', '{}'::jsonb
      )
      RETURNING id
    `, [
      tenant.id,
      parent.id,
      `active-retry-item-${index}-${crypto.randomUUID()}`,
      index,
      `active-keyword-${index}`,
      agents[index].id,
      execution.id,
    ]);
    await createItemAttempt({
      tenantId: tenant.id,
      parentId: parent.id,
      itemId: item.id,
      executionTaskId: execution.id,
      agentId: agents[index].id,
      attemptNumber: 1,
      assignmentRevision: 8,
      status: 'dispatched',
    });
    activeItems.push({execution, item});
  }
  const fourth = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agents[0].id,
    ordinal: 3,
    parentRevision: 8,
  });

  const noCapacity = await reconcilePendingOrchestrationRetries(1);
  assert.equal(noCapacity.dispatched, 0);
  assert.equal(noCapacity.waitingForAgent, 1);
  const stillWaiting = await queryOne(`
    SELECT status, attempt_count, execution_task_id, metadata
    FROM capture_task_items
    WHERE id = $1 AND tenant_id = $2
  `, [fourth.item.id, tenant.id]);
  assert.equal(stillWaiting.status, 'retryable');
  assert.equal(stillWaiting.attempt_count, 1);
  assert.equal(stillWaiting.execution_task_id, fourth.source.id);
  assert.equal(stillWaiting.metadata.retryPending, true);

  await execute(`
    UPDATE capture_tasks SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[0].execution.id, tenant.id]);
  await execute(`
    UPDATE capture_task_items SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[0].item.id, tenant.id]);
  await execute(`
    UPDATE capture_task_item_attempts
    SET status = 'completed', finished_at = now()
    WHERE item_id = $1 AND tenant_id = $2
  `, [activeItems[0].item.id, tenant.id]);

  const released = await reconcilePendingOrchestrationRetries(2);
  assert.equal(released.dispatched, 1);
  const dispatchedFourth = await queryOne(`
    SELECT status, attempt_count, execution_task_id,
      assignment_revision, request_hash, metadata
    FROM capture_task_items
    WHERE id = $1 AND tenant_id = $2
  `, [fourth.item.id, tenant.id]);
  assert.equal(dispatchedFourth.status, 'dispatched');
  assert.equal(dispatchedFourth.attempt_count, 2);
  assert.equal(dispatchedFourth.assignment_revision, 9);
  assert.equal(dispatchedFourth.metadata.retryPending, undefined);
  assert.equal(dispatchedFourth.metadata.retryAutoContinuation, true);
  assert.match(dispatchedFourth.request_hash, /^[0-9a-f]{64}$/u);
  const fourthChildren = await queryAll(`
    SELECT id, metadata
    FROM capture_tasks
    WHERE tenant_id = $1 AND parent_task_id = $2
      AND metadata->>'retryAutoContinuation' = 'true'
      AND metadata->'itemIds' @> $3::jsonb
  `, [tenant.id, parent.id, JSON.stringify([fourth.item.id])]);
  assert.equal(fourthChildren.length, 1);
  assert.equal(fourthChildren[0].metadata.retryRequestKey, fourth.requestKey);
  assert.equal(fourthChildren[0].metadata.retryRequestHash, fourth.requestHash);
  const fourthAttempts = await queryAll(`
    SELECT id, attempt_number, assignment_revision, status, request_hash
    FROM capture_task_item_attempts
    WHERE tenant_id = $1 AND item_id = $2
    ORDER BY attempt_number
  `, [tenant.id, fourth.item.id]);
  assert.deepEqual(fourthAttempts.map(row => Number(row.attempt_number)), [1, 2]);
  const fourthCommand = await queryOne(`
    SELECT payload
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [tenant.id, fourthChildren[0].id]);
  const fourthBinding = fourthCommand.payload.orchestration.itemAttempts[0];
  assert.deepEqual(fourthBinding, {
    itemId: fourth.item.id,
    attemptId: fourthAttempts[1].id,
    requestHash: fourthAttempts[1].request_hash,
    attemptNumber: Number(fourthAttempts[1].attempt_number),
    assignmentRevision: Number(fourthAttempts[1].assignment_revision),
    keyword: 'retry-wait-keyword-3',
  });
  assert.equal(
    (await reconcilePendingOrchestrationRetries(1)).dispatched,
    0,
  );
  assert.equal(
    (await queryAll(`
      SELECT id FROM capture_tasks
      WHERE tenant_id = $1 AND parent_task_id = $2
        AND metadata->>'retryAutoContinuation' = 'true'
        AND metadata->'itemIds' @> $3::jsonb
    `, [tenant.id, parent.id, JSON.stringify([fourth.item.id])])).length,
    1,
  );
  assert.equal(
    (await queryOne(`
      SELECT status FROM capture_task_items
      WHERE id = $1 AND tenant_id = $2
    `, [activeItems[0].item.id, tenant.id])).status,
    'completed',
  );

  await execute(`
    UPDATE capture_tasks SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[1].execution.id, tenant.id]);
  await execute(`
    UPDATE capture_task_items SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[1].item.id, tenant.id]);
  await execute(`
    UPDATE capture_task_item_attempts
    SET status = 'completed', finished_at = now()
    WHERE item_id = $1 AND tenant_id = $2
  `, [activeItems[1].item.id, tenant.id]);
  const currentParent = await queryOne(`
    SELECT orchestration_revision
    FROM capture_tasks
    WHERE id = $1 AND tenant_id = $2
  `, [parent.id, tenant.id]);
  const concurrentItem = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agents[1].id,
    ordinal: 4,
    parentRevision: Number(currentParent.orchestration_revision),
  });
  const concurrentResults = await Promise.all([
    reconcilePendingOrchestrationRetries(1),
    reconcilePendingOrchestrationRetries(1),
  ]);
  assert.equal(
    concurrentResults.reduce((sum, result) => sum + result.dispatched, 0),
    1,
  );
  assert.equal(
    (await queryAll(`
      SELECT id FROM capture_tasks
      WHERE tenant_id = $1 AND parent_task_id = $2
        AND metadata->>'retryAutoContinuation' = 'true'
        AND metadata->'itemIds' @> $3::jsonb
    `, [tenant.id, parent.id, JSON.stringify([concurrentItem.item.id])])).length,
    1,
  );
  assert.equal(
    Number((await queryOne(`
      SELECT COUNT(*)::integer AS count
      FROM capture_task_item_attempts
      WHERE tenant_id = $1 AND item_id = $2 AND attempt_number = 2
    `, [tenant.id, concurrentItem.item.id])).count),
    1,
  );

  const unknownUsageAgent = await createAgent(
    tenant.id,
    4,
    {knownUsage: false},
  );
  await execute(`
    UPDATE capture_tasks SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[2].execution.id, tenant.id]);
  await execute(`
    UPDATE capture_task_items SET status = 'completed', finished_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [activeItems[2].item.id, tenant.id]);
  await execute(`
    UPDATE capture_task_item_attempts
    SET status = 'completed', finished_at = now()
    WHERE item_id = $1 AND tenant_id = $2
  `, [activeItems[2].item.id, tenant.id]);
  const unknownUsageParent = await queryOne(`
    UPDATE capture_tasks
    SET orchestration_revision = orchestration_revision + 1
    WHERE id = $1 AND tenant_id = $2
    RETURNING orchestration_revision
  `, [parent.id, tenant.id]);
  const unknownUsageItem = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: unknownUsageAgent.id,
    ordinal: 5,
    parentRevision: Number(unknownUsageParent.orchestration_revision),
    requestKey: crypto.randomUUID(),
    preferredAgentId: unknownUsageAgent.id,
  });
  const unknownUsage = await reconcilePendingOrchestrationRetries(1);
  assert.equal(unknownUsage.dispatched, 0);
  assert.ok(unknownUsage.waitingForAgent >= 1);
  const untouchedUnknown = await queryOne(`
    SELECT status, attempt_count, execution_task_id, metadata
    FROM capture_task_items
    WHERE id = $1 AND tenant_id = $2
  `, [unknownUsageItem.item.id, tenant.id]);
  assert.equal(untouchedUnknown.status, 'retryable');
  assert.equal(untouchedUnknown.attempt_count, 1);
  assert.equal(untouchedUnknown.execution_task_id, unknownUsageItem.source.id);
  assert.equal(untouchedUnknown.metadata.retryPending, true);
  assert.equal(
    Number((await queryOne(`
      SELECT COUNT(*)::integer AS count
      FROM capture_tasks
      WHERE tenant_id = $1 AND parent_task_id = $2
        AND assigned_agent_id = $3
        AND metadata->>'retryAutoContinuation' = 'true'
    `, [tenant.id, parent.id, unknownUsageAgent.id])).count),
    0,
  );
});

test('stale and unavailable queue heads cannot starve a later executable waiter', async t => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Retry waiting starvation ${Date.now()}`]);
  t.after(async () => {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  });
  const agents = await Promise.all([
    createAgent(tenant.id, 101),
    createAgent(tenant.id, 102),
  ]);
  const parent = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, orchestration_revision,
      metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'keyword_orchestration',
      'Starvation fence parent', 'douyin', 'cloud', 'manual',
      'pending', 4, $3::jsonb
    )
    RETURNING id, orchestration_revision
  `, [
    tenant.id,
    `retry-starvation-parent-${crypto.randomUUID()}`,
    JSON.stringify({executionMode: 'one_time', planSnapshot: PLAN_SNAPSHOT}),
  ]);
  const oldWaitingSince = new Date(Date.now() - 3_600_000).toISOString();
  const wrongPlanHash = hashOrchestrationRequest({
    ...PLAN_SNAPSHOT,
    keywordMaxDetectedItems: 99,
  });
  const staleItems = [];
  for (let index = 0; index < 21; index += 1) {
    staleItems.push(await createWaitingItem({
      tenantId: tenant.id,
      parentId: parent.id,
      agentId: agents[0].id,
      ordinal: index,
      parentRevision: 4,
      planHash: wrongPlanHash,
      waitingSince: oldWaitingSince,
    }));
  }
  const valid = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agents[0].id,
    ordinal: 21,
    parentRevision: 4,
    waitingSince: new Date(Date.now() - 1_800_000).toISOString(),
  });

  const bounded = await reconcilePendingOrchestrationRetries(3);
  assert.equal(bounded.invalidated, 21);
  assert.equal(bounded.dispatched, 1);
  assert.equal(bounded.inspected, 3);
  assert.equal(
    bounded.results.filter(result => result.reconciledParentCount === 1).length,
    2,
  );
  const reconciledParent = await queryOne(`
    SELECT status, orchestration_revision, progress, counts, metadata
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, parent.id]);
  assert.equal(reconciledParent.status, 'needs_action');
  assert.equal(Number(reconciledParent.orchestration_revision), 7);
  assert.equal(Number(reconciledParent.counts.retryable), 21);
  assert.equal(Number(reconciledParent.counts.retryWaiting), 0);
  assert.deepEqual(reconciledParent.metadata.lastRetryWaiting, []);
  const invalidatedRows = await queryAll(`
    SELECT id, status, attempt_count, execution_task_id, metadata
    FROM capture_task_items
    WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    ORDER BY ordinal, id
  `, [tenant.id, staleItems.map(entry => entry.item.id)]);
  assert.equal(invalidatedRows.length, 21);
  for (let index = 0; index < invalidatedRows.length; index += 1) {
    const row = invalidatedRows[index];
    assert.equal(row.status, 'retryable');
    assert.equal(Number(row.attempt_count), 1);
    assert.equal(row.execution_task_id, staleItems[index].source.id);
    assert.equal(row.metadata.retryPending, undefined);
    assert.equal(
      row.metadata.retryWaitingInvalidatedReason,
      'parent_plan_changed',
    );
    assert.ok(row.metadata.retryWaitingInvalidatedAt);
  }
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_item_attempts
    WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])
      AND attempt_number > 1
  `, [tenant.id, staleItems.map(entry => entry.item.id)])).count), 0);
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_events
    WHERE tenant_id = $1 AND task_id = $2
      AND event_type = 'orchestration_retry_pending_invalidated'
  `, [tenant.id, parent.id])).count), 21);
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_events
    WHERE tenant_id = $1 AND task_id = $2
      AND event_type = 'orchestration_retry_pending_projection_reconciled'
  `, [tenant.id, parent.id])).count), 2);
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_tasks
    WHERE tenant_id = $1 AND parent_task_id = $2
      AND metadata->>'retryAutoContinuation' = 'true'
      AND metadata->'itemIds' @> $3::jsonb
  `, [tenant.id, parent.id, JSON.stringify([valid.item.id])])).count), 1);
  assert.equal(
    (await reconcilePendingOrchestrationRetries(1)).dispatched,
    0,
  );

  const unavailableAgent = await createAgent(
    tenant.id,
    103,
    {knownUsage: false},
  );
  const currentRevision = Number((await queryOne(`
    SELECT orchestration_revision
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, parent.id])).orchestration_revision);
  const blockedHeads = [];
  for (let index = 0; index < 21; index += 1) {
    blockedHeads.push(await createWaitingItem({
      tenantId: tenant.id,
      parentId: parent.id,
      agentId: agents[0].id,
      ordinal: 100 + index,
      parentRevision: currentRevision,
      preferredAgentId: unavailableAgent.id,
      waitingSince: oldWaitingSince,
    }));
  }
  const executableBehindBlocked = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agents[0].id,
    ordinal: 121,
    parentRevision: currentRevision,
    waitingSince: new Date(Date.now() - 1_800_000).toISOString(),
  });
  const rotated = await reconcilePendingOrchestrationRetries(2);
  assert.equal(rotated.dispatched, 1);
  assert.ok(rotated.waitingForAgent >= 20);
  const blockedState = await queryAll(`
    SELECT status, attempt_count, metadata
    FROM capture_task_items
    WHERE tenant_id = $1 AND id = ANY($2::uuid[])
  `, [tenant.id, blockedHeads.map(entry => entry.item.id)]);
  assert.equal(blockedState.length, 21);
  assert.ok(blockedState.every(row =>
    row.status === 'retryable' &&
    Number(row.attempt_count) === 1 &&
    row.metadata.retryPending === true
  ));
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_tasks
    WHERE tenant_id = $1 AND parent_task_id = $2
      AND metadata->>'retryAutoContinuation' = 'true'
      AND metadata->'itemIds' @> $3::jsonb
  `, [
    tenant.id,
    parent.id,
    JSON.stringify([executableBehindBlocked.item.id]),
  ])).count), 1);
});

test('stale marker invalidation CAS preserves a concurrent valid refresh', async t => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Retry waiting CAS ${Date.now()}`]);
  t.after(async () => {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  });
  const agent = await createAgent(tenant.id, 201);
  const parent = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, orchestration_revision,
      metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'keyword_orchestration',
      'Concurrent marker CAS parent', 'douyin', 'cloud', 'manual',
      'pending', 7, $3::jsonb
    )
    RETURNING id, orchestration_revision
  `, [
    tenant.id,
    `retry-cas-parent-${crypto.randomUUID()}`,
    JSON.stringify({executionMode: 'one_time', planSnapshot: PLAN_SNAPSHOT}),
  ]);
  const stale = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agent.id,
    ordinal: 0,
    parentRevision: 7,
    planHash: hashOrchestrationRequest({...PLAN_SNAPSHOT, enabled: false}),
    waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
  });

  const lockClient = await getPool().connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query(`
      SELECT id FROM capture_tasks
      WHERE id = $1 AND tenant_id = $2 AND parent_task_id = $3
      FOR UPDATE
    `, [stale.source.id, tenant.id, parent.id]);
    await lockClient.query(`
      SELECT id FROM capture_tasks
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE
    `, [parent.id, tenant.id]);
    await lockClient.query(`
      SELECT id FROM capture_task_items
      WHERE id = $1 AND tenant_id = $2 AND task_id = $3
      FOR UPDATE
    `, [stale.item.id, tenant.id, parent.id]);

    const racingSweep = reconcilePendingOrchestrationRetries(1);
    const waitDeadline = Date.now() + 2_000;
    let blocked = false;
    while (Date.now() < waitDeadline) {
      const activity = await queryOne(`
        SELECT COUNT(*)::integer AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%retry_pending_invalidation_source_lock%'
      `);
      if (Number(activity.count) > 0) {
        blocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    const refreshedKey = crypto.randomUUID();
    const refreshedHash = crypto
      .createHash('sha256')
      .update(`retry-wait-refreshed-${refreshedKey}`)
      .digest('hex');
    const refreshedSince = new Date().toISOString();
    await lockClient.query(`
      UPDATE capture_task_items
      SET metadata = metadata || jsonb_build_object(
        'retryWaitingRequestKey', $1::uuid::text,
        'retryWaitingRequestHash', $2::text,
        'retryWaitingPlanHash', $3::text,
        'retryWaitingSince', $4::text
      ), updated_at = now()
      WHERE id = $5 AND tenant_id = $6 AND task_id = $7
    `, [
      refreshedKey,
      refreshedHash,
      hashOrchestrationRequest(PLAN_SNAPSHOT),
      refreshedSince,
      stale.item.id,
      tenant.id,
      parent.id,
    ]);
    await lockClient.query('COMMIT');
    const raced = await racingSweep;
    assert.equal(raced.invalidated, 0);
    assert.equal(raced.dispatched, 0);
    const refreshed = await queryOne(`
      SELECT status, attempt_count, execution_task_id, metadata
      FROM capture_task_items
      WHERE id = $1 AND tenant_id = $2
    `, [stale.item.id, tenant.id]);
    assert.equal(refreshed.status, 'retryable');
    assert.equal(Number(refreshed.attempt_count), 1);
    assert.equal(refreshed.execution_task_id, stale.source.id);
    assert.equal(refreshed.metadata.retryPending, true);
    assert.equal(refreshed.metadata.retryWaitingRequestKey, refreshedKey);
    assert.equal(refreshed.metadata.retryWaitingRequestHash, refreshedHash);
    assert.equal(refreshed.metadata.retryWaitingSince, refreshedSince);
    assert.equal(refreshed.metadata.retryWaitingInvalidatedAt, undefined);
    assert.equal(Number((await queryOne(`
      SELECT COUNT(*)::integer AS count
      FROM capture_task_events
      WHERE tenant_id = $1 AND task_id = $2
        AND event_type = 'orchestration_retry_pending_invalidated'
    `, [tenant.id, parent.id])).count), 0);
    assert.equal(
      (await reconcilePendingOrchestrationRetries(1)).dispatched,
      1,
    );
  } catch (error) {
    try { await lockClient.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    lockClient.release();
  }

  const currentRevision = Number((await queryOne(`
    SELECT orchestration_revision
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, parent.id])).orchestration_revision);
  const doubleSweepStale = await createWaitingItem({
    tenantId: tenant.id,
    parentId: parent.id,
    agentId: agent.id,
    ordinal: 1,
    parentRevision: currentRevision,
    planHash: hashOrchestrationRequest({...PLAN_SNAPSHOT, enabled: false}),
  });
  const concurrent = await Promise.all([
    reconcilePendingOrchestrationRetries(1),
    reconcilePendingOrchestrationRetries(1),
  ]);
  assert.equal(
    concurrent.reduce((sum, result) => sum + result.invalidated, 0),
    1,
  );
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_events
    WHERE tenant_id = $1 AND task_id = $2
      AND event_type = 'orchestration_retry_pending_invalidated'
      AND payload->>'itemId' = $3::uuid::text
  `, [tenant.id, parent.id, doubleSweepStale.item.id])).count), 1);
  const preservedBusinessState = await queryOne(`
    SELECT status, attempt_count, execution_task_id, metadata
    FROM capture_task_items
    WHERE tenant_id = $1 AND id = $2
  `, [tenant.id, doubleSweepStale.item.id]);
  assert.equal(preservedBusinessState.status, 'retryable');
  assert.equal(Number(preservedBusinessState.attempt_count), 1);
  assert.equal(
    preservedBusinessState.execution_task_id,
    doubleSweepStale.source.id,
  );
  assert.equal(preservedBusinessState.metadata.retryPending, undefined);
  assert.equal(Number((await queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_item_attempts
    WHERE tenant_id = $1 AND item_id = $2 AND attempt_number > 1
  `, [tenant.id, doubleSweepStale.item.id])).count), 0);
});
