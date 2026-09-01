import {withTransaction} from '../../../db/init.js';
import {
  captureAgentFullHeartbeatOnline,
  findCaptureAgentExecutionSlotBlocker,
  normalizeRemoteTaskInput,
  tryLockCaptureAgentExecutionSlot,
} from '../../../services/capture-cloud.js';
import {
  aggregateParentTaskItems,
  hashOrchestrationRequest,
} from '../../../services/capture-orchestration.js';
import {
  HANDOFF_SOURCE_FINAL_STATUSES,
  RETRY_PENDING_PARENT_BLOCKED_STATUSES,
  agentCompatibilityFailure,
  createPendingOrchestrationRetryReconciler,
  deterministicRetryUuid,
  itemRequiresManualSafetyAction,
  pendingRetryLineage,
  pendingRetryMarkerSnapshot,
  publicPendingRetryItem,
  retryPendingInvalidationReason,
  retryPendingParentKey,
  retryPendingRowKey,
} from '../application/pending-orchestration-retry.js';
import {
  appendEvent,
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {
  crossDeviceRetryAgentDailyUsageEligible,
} from './postgres-cross-device-retry.js';

const RETRY_AGENT_SLOT_BLOCKING_STATUSES = [
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
];

export async function loadRetryAgentCandidates(
  executor,
  {tenantId, platform, agentIds = [], lock = false},
) {
  const restrictAgentIds = Array.isArray(agentIds) && agentIds.length > 0;
  return executor.queryAll(`
    SELECT ca.*,
      tenant.status AS tenant_status,
      ac.status AS auth_code_status,
      ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id,
      daily_usage.usage_date =
        (now() AT TIME ZONE 'Asia/Shanghai')::date AS today_usage_current,
      daily_usage.searches AS today_searches,
      daily_usage.failed_events AS today_failed_events,
      daily_usage.safety_verifications AS today_safety_verifications,
      daily_usage.last_event_at AS today_usage_last_event_at,
      current_social_account.daily_search_limit,
      current_social_account.health_status AS account_health_status,
      current_social_binding.last_login_state,
      (
        SELECT COUNT(*)::integer
        FROM capture_task_item_attempts recent_failure
        WHERE recent_failure.tenant_id = ca.tenant_id
          AND recent_failure.agent_id = ca.id
          AND recent_failure.updated_at > now() - interval '2 hours'
          AND recent_failure.status IN (
            'retryable', 'needs_action', 'failed', 'interrupted'
          )
          AND NOT (
            COALESCE(recent_failure.error::text, '') ~*
              'captcha|security.verification|login.required|safety.block'
          )
      ) AS recent_technical_failure_count,
      (
        SELECT COUNT(*)::integer
        FROM capture_tasks recent_success
        WHERE recent_success.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_success.assigned_agent_id,
            recent_success.origin_agent_id
          ) = ca.id
          AND recent_success.created_at > now() - interval '2 hours'
          AND recent_success.status IN ('completed', 'completed_with_warnings')
      ) AS recent_success_count,
      (
        SELECT MAX(recent_assignment.created_at)
        FROM capture_tasks recent_assignment
        WHERE recent_assignment.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_assignment.assigned_agent_id,
            recent_assignment.origin_agent_id
          ) = ca.id
      ) AS last_assignment_at
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    JOIN social_agent_daily_usage daily_usage
      ON daily_usage.tenant_id = ca.tenant_id
      AND daily_usage.agent_id = ca.id
      AND daily_usage.platform = $2
      AND daily_usage.usage_date =
        (now() AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN social_account_bindings current_social_binding
      ON current_social_binding.tenant_id = ca.tenant_id
      AND current_social_binding.agent_id = ca.id
      AND current_social_binding.platform = $2
      AND current_social_binding.status = 'current'
    LEFT JOIN social_accounts current_social_account
      ON current_social_account.tenant_id = ca.tenant_id
      AND current_social_account.id = current_social_binding.social_account_id
    WHERE ca.tenant_id = $1
      AND ($4::boolean = false OR ca.id = ANY($5::uuid[]))
      AND ca.status = 'active'
      AND tenant.status = 'active'
      AND ac.status = 'active'
      AND ab.id IS NOT NULL
      AND (ac.expires_at IS NULL OR ac.expires_at >= now())
      AND COALESCE(ca.last_full_heartbeat_at, ca.last_heartbeat_at) >=
        now() - interval '2 minutes'
      AND ca.capabilities->>'taskStateKnown' IS DISTINCT FROM 'false'
      AND daily_usage.last_event_at IS NOT NULL
      AND (
        current_social_account.daily_search_limit IS NULL OR
        current_social_account.daily_search_limit = 0 OR
        daily_usage.searches < current_social_account.daily_search_limit
      )
      AND NOT EXISTS (
        SELECT 1
        FROM capture_tasks active_task
        WHERE active_task.tenant_id = ca.tenant_id
          AND COALESCE(
            active_task.assigned_agent_id,
            active_task.origin_agent_id
          ) = ca.id
          AND active_task.task_type <> 'capture_orchestration'
          AND active_task.status = ANY($3::text[])
      )
      AND NOT EXISTS (
        SELECT 1
        FROM capture_agent_commands active_command
        WHERE active_command.tenant_id = ca.tenant_id
          AND active_command.agent_id = ca.id
          AND active_command.status IN ('pending', 'acknowledged')
          AND (
            active_command.expires_at IS NULL OR
            active_command.expires_at > now()
          )
      )
    ORDER BY
      CASE COALESCE(current_social_account.health_status, 'unknown')
        WHEN 'active' THEN 0
        WHEN 'unknown' THEN 1
        WHEN 'resting' THEN 2
        WHEN 'risk' THEN 3
        WHEN 'login_required' THEN 4
        ELSE 5
      END ASC,
      CASE COALESCE(current_social_binding.last_login_state, 'unknown')
        WHEN 'authenticated' THEN 0
        WHEN 'unknown' THEN 1
        ELSE 2
      END ASC,
      recent_technical_failure_count ASC,
      daily_usage.failed_events ASC,
      daily_usage.safety_verifications ASC,
      daily_usage.searches ASC,
      recent_success_count DESC,
      last_assignment_at ASC NULLS FIRST,
      COALESCE(ca.last_full_heartbeat_at, ca.last_heartbeat_at)
        DESC NULLS LAST,
      ca.id
    ${lock ? 'FOR UPDATE OF ca, daily_usage' : ''}
  `, [
    tenantId,
    platform,
    RETRY_AGENT_SLOT_BLOCKING_STATUSES,
    restrictAgentIds,
    restrictAgentIds ? agentIds : [],
  ]);
}

function parentSelect({lock = false} = {}) {
  return `
    SELECT id, tenant_id, client_task_id, parent_task_id,
      task_type, feature_key, title, platform, source, trigger_type,
      status, progress, checkpoint, counts, metadata, error, message,
      orchestration_revision, orchestration_schedule_id, scheduled_for,
      schedule_revision, attention_dismissed_at, created_at, updated_at
    FROM capture_tasks
    WHERE id = $1 AND tenant_id = $2 AND task_type = 'capture_orchestration'
    ${lock ? 'FOR UPDATE' : ''}
  `;
}

async function listParentItems(executor, tenantId, taskId, {lock = false} = {}) {
  return executor.queryAll(`
    SELECT item.id, item.task_id, item.item_key, item.ordinal, item.keyword,
      item.platform, item.item_type, item.status, item.attempt_count,
      item.assigned_agent_id, item.execution_task_id,
      item.assignment_revision, item.request_hash, item.error, item.metadata,
      item.assigned_at, item.dispatched_at, item.started_at, item.finished_at,
      item.created_at, item.updated_at,
      record.title AS source_record_title,
      record.content AS source_record_content,
      record.content_availability_status,
      record.content_availability_checked_at
    FROM capture_task_items item
    LEFT JOIN records record
      ON record.id = item.record_id
      AND record.tenant_id = item.tenant_id
    WHERE item.tenant_id = $1 AND item.task_id = $2
    ORDER BY item.id
    ${lock ? 'FOR UPDATE OF item' : ''}
  `, [tenantId, taskId]);
}

async function loadPendingRetryCandidates(
  executor,
  limit = 20,
  excludedItemIds = [],
) {
  return executor.queryAll(`
    SELECT item.id, item.tenant_id, item.task_id, item.item_key,
      item.ordinal, item.keyword, item.platform, item.item_type,
      item.status, item.attempt_count, item.assigned_agent_id,
      item.execution_task_id, item.assignment_revision, item.request_hash,
      item.error, item.metadata, item.assigned_at, item.dispatched_at,
      item.started_at, item.finished_at,
      parent.title AS parent_title,
      parent.platform AS parent_platform,
      parent.metadata AS parent_metadata,
      parent.orchestration_revision AS parent_revision
    FROM capture_task_items item
    JOIN capture_tasks parent
      ON parent.id = item.task_id
      AND parent.tenant_id = item.tenant_id
      AND parent.task_type = 'capture_orchestration'
    JOIN capture_tasks source_execution
      ON source_execution.id = item.execution_task_id
      AND source_execution.tenant_id = item.tenant_id
      AND source_execution.parent_task_id = item.task_id
    JOIN tenants tenant ON tenant.id = item.tenant_id
    WHERE item.status = 'retryable'
      AND item.metadata->>'retryPending' = 'true'
      AND tenant.status = 'active'
      AND source_execution.status = ANY($1::text[])
      AND NOT (parent.status = ANY($2::text[]))
      AND parent.metadata->>'operatorStopped' IS DISTINCT FROM 'true'
      AND parent.metadata->>'orchestrationTemplate' IS DISTINCT FROM 'true'
      AND parent.metadata->>'executionMode' IS DISTINCT FROM 'unattended_plan'
      AND NOT (item.id = ANY($3::uuid[]))
      AND NOT EXISTS (
        SELECT 1
        FROM capture_task_item_attempts active_attempt
        WHERE active_attempt.tenant_id = item.tenant_id
          AND active_attempt.item_id = item.id
          AND active_attempt.status IN (
            'assigned', 'dispatch_pending', 'dispatched',
            'waiting_device', 'running'
          )
      )
    ORDER BY
      COALESCE(
        item.metadata->>'retryWaitingLastCheckedAt',
        item.metadata->>'retryWaitingSince',
        item.updated_at::text
      ),
      item.tenant_id,
      item.task_id,
      item.ordinal,
      item.id
    LIMIT $4
  `, [
    [...HANDOFF_SOURCE_FINAL_STATUSES],
    RETRY_PENDING_PARENT_BLOCKED_STATUSES,
    excludedItemIds,
    limit,
  ]);
}

async function invalidateLockedPendingRetryMarker(tx, {
  preview,
  item,
  parent,
  reason,
}) {
  const marker = pendingRetryMarkerSnapshot(preview);
  const previewMetadata = safeJson(preview?.metadata);
  const requestHashJson = Object.prototype.hasOwnProperty.call(
    previewMetadata,
    'retryWaitingRequestHash',
  )
    ? JSON.stringify(previewMetadata.retryWaitingRequestHash)
    : null;
  const actionMetadata = {
    action: 'retry_pending_marker_invalidated',
    trigger: 'capture_orchestration_recovery_sweep',
    protocolVersion: 1,
    tenantId: preview.tenant_id,
    parentTaskId: preview.task_id,
    itemId: preview.id,
    reason,
    originalRequestKey: text(
      previewMetadata.retryWaitingRequestKey,
      100,
    ),
    originalRequestHash: text(
      previewMetadata.retryWaitingRequestHash,
      80,
    ),
    authorizedPlanHash: text(
      previewMetadata.retryWaitingPlanHash,
      80,
    ),
    authorizedParentRevision: Number(
      previewMetadata.retryWaitingParentRevision,
    ),
    expectedItemRevision: Number(preview.assignment_revision),
    expectedAttemptCount: Number(preview.attempt_count),
    sourceExecutionTaskId: String(preview.execution_task_id || ''),
  };
  const invalidated = await tx.queryOne(`
    UPDATE capture_task_items AS stale_item
    SET metadata = (
          SELECT COALESCE(
            jsonb_object_agg(retained.key, retained.value),
            '{}'::jsonb
          )
          FROM jsonb_each(stale_item.metadata) AS retained(key, value)
          WHERE retained.key <> 'retryPending'
            AND retained.key NOT LIKE 'retryWaiting%'
        ) || jsonb_build_object(
          'retryWaitingInvalidatedAt', now(),
          'retryWaitingInvalidatedReason', $1::text,
          'retryWaitingInvalidatedBy',
            'capture_orchestration_recovery_sweep',
          'retryWaitingInvalidatedMarker', $2::jsonb
        ),
      updated_at = now()
    WHERE stale_item.id = $3
      AND stale_item.tenant_id = $4
      AND stale_item.task_id = $5
      AND stale_item.status = 'retryable'
      AND stale_item.execution_task_id IS NOT DISTINCT FROM $6::uuid
      AND stale_item.assignment_revision = $7
      AND stale_item.attempt_count = $8
      AND stale_item.metadata->'retryWaitingRequestHash'
        IS NOT DISTINCT FROM $9::jsonb
      AND (
        SELECT COALESCE(
          jsonb_object_agg(current_marker.key, current_marker.value),
          '{}'::jsonb
        )
        FROM jsonb_each(stale_item.metadata)
          AS current_marker(key, value)
        WHERE current_marker.key = 'retryPending'
          OR current_marker.key LIKE 'retryWaiting%'
      ) = $2::jsonb
    RETURNING id, status, metadata
  `, [
    reason,
    JSON.stringify(marker),
    preview.id,
    preview.tenant_id,
    preview.task_id,
    preview.execution_task_id,
    Number(preview.assignment_revision),
    Number(preview.attempt_count),
    requestHashJson,
  ]);
  if (!invalidated) return false;
  await appendEvent(tx, {
    tenantId: preview.tenant_id,
    taskId: preview.task_id,
    eventType: 'orchestration_retry_pending_invalidated',
    actorType: 'system',
    actorId: 'retry_waiting_sweeper',
    actorName: '系统 · 等待重试状态校验',
    status: parent.status,
    message: '等待重试标记已失效，保留关键词业务状态并停止自动续接',
    payload: actionMetadata,
  });
  return true;
}

async function invalidatePreviewStalePendingRetries(tx, previews) {
  const stalePreviews = previews.filter(preview => {
    const previewParent = {
      id: preview.task_id,
      tenant_id: preview.tenant_id,
      title: preview.parent_title,
      platform: preview.parent_platform,
      metadata: safeJson(preview.parent_metadata),
      orchestration_revision: Number(preview.parent_revision || 0),
    };
    return Boolean(retryPendingInvalidationReason(preview, previewParent));
  });
  if (stalePreviews.length === 0) {
    return {
      staleCount: 0,
      invalidatedCount: 0,
      retainedCount: 0,
      reconciledParentCount: 0,
    };
  }

  // A cleanup transaction has no Agent lease. Lock every source first, then
  // every parent, then every item in stable tenant/id order. Returning after
  // this phase prevents a later Agent lock from inverting the dispatch order.
  const sources = [...new Map(stalePreviews.map(preview => [
    `${preview.tenant_id}:${preview.execution_task_id}`,
    preview,
  ])).values()].sort((left, right) =>
    `${left.tenant_id}:${left.execution_task_id}`.localeCompare(
      `${right.tenant_id}:${right.execution_task_id}`,
    )
  );
  for (const preview of sources) {
    await tx.queryOne(`
      /* retry_pending_invalidation_source_lock */
      SELECT id
      FROM capture_tasks
      WHERE id = $1 AND tenant_id = $2 AND parent_task_id = $3
      FOR UPDATE
    `, [preview.execution_task_id, preview.tenant_id, preview.task_id]);
  }

  const parentPreviews = [...new Map(stalePreviews.map(preview => [
    retryPendingParentKey(preview),
    preview,
  ])).values()].sort((left, right) =>
    retryPendingParentKey(left).localeCompare(retryPendingParentKey(right))
  );
  const parentByKey = new Map();
  for (const preview of parentPreviews) {
    const parent = await tx.queryOne(
      parentSelect({lock: true}),
      [preview.task_id, preview.tenant_id],
    );
    if (parent) parentByKey.set(retryPendingParentKey(preview), parent);
  }

  const itemPreviews = [...stalePreviews].sort((left, right) =>
    retryPendingRowKey(left).localeCompare(retryPendingRowKey(right))
  );
  const itemByKey = new Map();
  for (const preview of itemPreviews) {
    const item = await tx.queryOne(`
      SELECT id, tenant_id, task_id, item_key, ordinal, keyword, platform,
        item_type, status, attempt_count, assigned_agent_id,
        execution_task_id, assignment_revision, request_hash, error, metadata,
        assigned_at, dispatched_at, started_at, finished_at
      FROM capture_task_items
      WHERE id = $1 AND tenant_id = $2 AND task_id = $3
      FOR UPDATE
    `, [preview.id, preview.tenant_id, preview.task_id]);
    if (item) itemByKey.set(retryPendingRowKey(preview), item);
  }

  let invalidatedCount = 0;
  let retainedCount = 0;
  const invalidatedByParent = new Map();
  for (const preview of itemPreviews) {
    const item = itemByKey.get(retryPendingRowKey(preview));
    const parent = parentByKey.get(retryPendingParentKey(preview));
    const reason = retryPendingInvalidationReason(item, parent);
    if (!reason) {
      retainedCount += 1;
      continue;
    }
    const invalidated = await invalidateLockedPendingRetryMarker(tx, {
      preview,
      item,
      parent,
      reason,
    });
    if (invalidated) {
      invalidatedCount += 1;
      const parentKey = retryPendingParentKey(preview);
      const entry = invalidatedByParent.get(parentKey) || {
        itemIds: [],
        parent: parentByKey.get(parentKey),
      };
      entry.itemIds.push(preview.id);
      invalidatedByParent.set(parentKey, entry);
    } else retainedCount += 1;
  }

  let reconciledParentCount = 0;
  for (const {itemIds, parent} of invalidatedByParent.values()) {
    if (!parent || itemIds.length === 0) continue;
    const refreshedItems = await listParentItems(
      tx,
      parent.tenant_id,
      parent.id,
    );
    const remainingWaiting = refreshedItems
      .filter(candidate =>
        candidate.status === 'retryable' &&
        safeJson(candidate.metadata).retryPending === true
      )
      .map(publicPendingRetryItem);
    const aggregate = aggregateParentTaskItems(refreshedItems);
    const currentRevision = Number(parent.orchestration_revision || 0);
    const parentUpdate = await tx.queryOne(`
      UPDATE capture_tasks
      SET orchestration_revision = orchestration_revision + 1,
        status = $1,
        progress = $2::jsonb,
        counts = $3::jsonb,
        metadata = metadata || jsonb_build_object(
          'lastRetryWaiting', $4::jsonb,
          'lastRetryWaitingInvalidatedAt', now(),
          'lastRetryWaitingInvalidatedCount', $5::integer,
          'lastRetryWaitingInvalidatedItemIds', $6::jsonb
        ),
        message = CASE
          WHEN jsonb_array_length($4::jsonb) > 0
            THEN '部分等待重试授权已失效，其余仍在等待空闲 Agent'
          ELSE '等待重试授权已失效，请重新确认后再重试'
        END,
        finished_at = NULL,
        updated_at = now(),
        source_updated_at = now()
      WHERE id = $7 AND tenant_id = $8
        AND task_type = 'capture_orchestration'
        AND orchestration_revision = $9
      RETURNING id, status, orchestration_revision
    `, [
      aggregate.status,
      JSON.stringify(aggregate.progress),
      JSON.stringify(aggregate.counts),
      JSON.stringify(remainingWaiting),
      itemIds.length,
      JSON.stringify(itemIds),
      parent.id,
      parent.tenant_id,
      currentRevision,
    ]);
    if (!parentUpdate) {
      const error = new Error(
        'orchestration_retry_pending_invalidation_revision_conflict',
      );
      error.code =
        'orchestration_retry_pending_invalidation_revision_conflict';
      throw error;
    }
    await appendEvent(tx, {
      tenantId: parent.tenant_id,
      taskId: parent.id,
      eventType: 'orchestration_retry_pending_projection_reconciled',
      actorType: 'system',
      actorId: 'retry_waiting_sweeper',
      actorName: '系统 · 等待重试状态校验',
      status: parentUpdate.status,
      message: remainingWaiting.length > 0
        ? '失效等待项已移出自动队列，其余等待项继续排队'
        : '失效等待项已移出自动队列，父任务已恢复真实处理状态',
      payload: {
        action: 'retry_pending_projection_reconciled',
        trigger: 'capture_orchestration_recovery_sweep',
        protocolVersion: 1,
        tenantId: parent.tenant_id,
        parentTaskId: parent.id,
        invalidatedItemIds: itemIds,
        invalidatedCount: itemIds.length,
        remainingWaiting,
        previousRevision: currentRevision,
        revision: Number(parentUpdate.orchestration_revision),
      },
    });
    reconciledParentCount += 1;
  }
  return {
    staleCount: stalePreviews.length,
    invalidatedCount,
    retainedCount,
    reconciledParentCount,
  };
}

async function touchPendingRetryWaitingMarkers(tx, previews) {
  const checkedItemIds = [];
  for (const preview of previews) {
    const marker = pendingRetryMarkerSnapshot(preview);
    const previewMetadata = safeJson(preview?.metadata);
    const requestHashJson = Object.prototype.hasOwnProperty.call(
      previewMetadata,
      'retryWaitingRequestHash',
    )
      ? JSON.stringify(previewMetadata.retryWaitingRequestHash)
      : null;
    const touched = await tx.queryOne(`
      UPDATE capture_task_items AS waiting_item
      SET metadata = jsonb_set(
          waiting_item.metadata,
          '{retryWaitingLastCheckedAt}',
          to_jsonb(now()),
          true
        ),
        updated_at = now()
      WHERE waiting_item.id = $1
        AND waiting_item.tenant_id = $2
        AND waiting_item.task_id = $3
        AND waiting_item.status = 'retryable'
        AND waiting_item.execution_task_id IS NOT DISTINCT FROM $4::uuid
        AND waiting_item.assignment_revision = $5
        AND waiting_item.attempt_count = $6
        AND waiting_item.metadata->'retryWaitingRequestHash'
          IS NOT DISTINCT FROM $7::jsonb
        AND (
          SELECT COALESCE(
            jsonb_object_agg(current_marker.key, current_marker.value),
            '{}'::jsonb
          )
          FROM jsonb_each(waiting_item.metadata)
            AS current_marker(key, value)
          WHERE current_marker.key = 'retryPending'
            OR current_marker.key LIKE 'retryWaiting%'
        ) = $8::jsonb
      RETURNING id
    `, [
      preview.id,
      preview.tenant_id,
      preview.task_id,
      preview.execution_task_id,
      Number(preview.assignment_revision),
      Number(preview.attempt_count),
      requestHashJson,
      JSON.stringify(marker),
    ]);
    if (touched) checkedItemIds.push(touched.id);
  }
  return {checkedCount: checkedItemIds.length, checkedItemIds};
}

async function loadIdlePendingRetryAgent(tx, {tenantId, parent, lineage}) {
  const planSnapshot = safeJson(parent.metadata?.planSnapshot);
  const candidates = await loadRetryAgentCandidates(tx, {
    tenantId,
    platform: parent.platform,
    agentIds: lineage.preferredAgentId ? [lineage.preferredAgentId] : [],
  });
  const eligibleCandidates = candidates.filter(agent =>
    !agentCompatibilityFailure(agent, parent.platform, planSnapshot) &&
    captureAgentFullHeartbeatOnline(agent) &&
    crossDeviceRetryAgentDailyUsageEligible(agent)
  );
  for (const candidate of eligibleCandidates) {
    const savepoint = 'orchestration_retry_pending_agent';
    await tx.execute(`SAVEPOINT ${savepoint}`);
    try {
      const slotLocked = await tryLockCaptureAgentExecutionSlot(
        tx,
        tenantId,
        candidate.id,
      );
      if (!slotLocked) {
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
        continue;
      }
      const lockedCandidates = await loadRetryAgentCandidates(tx, {
        tenantId,
        platform: parent.platform,
        agentIds: [candidate.id],
        lock: true,
      });
      const locked = lockedCandidates[0] || null;
      const eligible = locked &&
        !agentCompatibilityFailure(locked, parent.platform, planSnapshot) &&
        captureAgentFullHeartbeatOnline(locked) &&
        crossDeviceRetryAgentDailyUsageEligible(locked);
      const blocker = eligible
        ? await findCaptureAgentExecutionSlotBlocker(tx, tenantId, locked.id)
        : {kind: 'ineligible'};
      if (!eligible || blocker) {
        await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
        continue;
      }
      await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
      return locked;
    } catch (error) {
      try {
        await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {}
      throw error;
    }
  }
  return null;
}

export async function dispatchOnePendingOrchestrationRetry(
  tx,
  {scanLimit = 20, excludedItemIds = []} = {},
) {
  const candidates = await loadPendingRetryCandidates(
    tx,
    scanLimit,
    excludedItemIds,
  );
  if (candidates.length === 0) return {kind: 'empty'};
  const staleCleanup = await invalidatePreviewStalePendingRetries(
    tx,
    candidates,
  );
  if (staleCleanup.staleCount > 0) {
    return {kind: 'stale', ...staleCleanup};
  }
  let waitingCount = 0;
  let staleCount = 0;
  const waitingPreviews = [];
  for (const preview of candidates) {
    const previewParent = {
      id: preview.task_id,
      tenant_id: preview.tenant_id,
      title: preview.parent_title,
      platform: preview.parent_platform,
      metadata: safeJson(preview.parent_metadata),
      orchestration_revision: Number(preview.parent_revision || 0),
    };
    const previewLineage = pendingRetryLineage(preview, previewParent);
    if (!previewLineage) {
      staleCount += 1;
      continue;
    }
    const targetAgent = await loadIdlePendingRetryAgent(tx, {
      tenantId: preview.tenant_id,
      parent: previewParent,
      lineage: previewLineage,
    });
    if (!targetAgent) {
      waitingCount += 1;
      waitingPreviews.push(preview);
      continue;
    }

    // Match the existing retry dispatch lock order: target Agent slot first,
    // source execution second, parent third, and the exact item last.
    const sourceTask = await tx.queryOne(`
      SELECT id, tenant_id, parent_task_id, status
      FROM capture_tasks
      WHERE id = $1 AND tenant_id = $2 AND parent_task_id = $3
      FOR UPDATE
    `, [
      previewLineage.sourceExecutionTaskId,
      preview.tenant_id,
      preview.task_id,
    ]);
    const parent = await tx.queryOne(
      parentSelect({lock: true}),
      [preview.task_id, preview.tenant_id],
    );
    const item = await tx.queryOne(`
      SELECT id, tenant_id, task_id, item_key, ordinal, keyword, platform,
        item_type, status, attempt_count, assigned_agent_id,
        execution_task_id, assignment_revision, request_hash, error, metadata,
        assigned_at, dispatched_at, started_at, finished_at
      FROM capture_task_items
      WHERE id = $1 AND tenant_id = $2 AND task_id = $3
      FOR UPDATE
    `, [preview.id, preview.tenant_id, preview.task_id]);
    const lineage = pendingRetryLineage(item, parent);
    const planSnapshot = safeJson(parent?.metadata?.planSnapshot);
    const invalidationReason = retryPendingInvalidationReason(item, parent) ||
      (
        lineage &&
        itemRequiresManualSafetyAction(item) &&
        lineage.safetyConfirmed !== true
          ? 'safety_confirmation_missing'
          : ''
      );
    if (invalidationReason) {
      const invalidated = await invalidateLockedPendingRetryMarker(tx, {
        preview,
        item,
        parent,
        reason: invalidationReason,
      });
      return {
        kind: 'stale',
        staleCount: 1,
        invalidatedCount: invalidated ? 1 : 0,
        retainedCount: invalidated ? 0 : 1,
      };
    }
    if (
      !sourceTask ||
      !parent ||
      !item ||
      !lineage ||
      RETRY_PENDING_PARENT_BLOCKED_STATUSES.includes(parent.status) ||
      safeJson(parent.metadata).operatorStopped === true ||
      lineage.requestKey !== previewLineage.requestKey ||
      lineage.requestHash !== previewLineage.requestHash ||
      lineage.sourceExecutionTaskId !== previewLineage.sourceExecutionTaskId ||
      lineage.itemRevision !== previewLineage.itemRevision ||
      lineage.attemptCount !== previewLineage.attemptCount ||
      !HANDOFF_SOURCE_FINAL_STATUSES.has(sourceTask.status) ||
      item.status !== 'retryable' ||
      agentCompatibilityFailure(targetAgent, parent.platform, planSnapshot)
    ) {
      return {
        kind: 'stale',
        staleCount: 1,
        invalidatedCount: 0,
        retainedCount: 1,
      };
    }
    const activeAttempt = await tx.queryOne(`
      SELECT id
      FROM capture_task_item_attempts
      WHERE tenant_id = $1 AND item_id = $2
        AND status IN (
          'assigned', 'dispatch_pending', 'dispatched',
          'waiting_device', 'running'
        )
      ORDER BY attempt_number DESC, id
      LIMIT 1
      FOR UPDATE
    `, [item.tenant_id, item.id]);
    if (activeAttempt) {
      return {
        kind: 'stale',
        staleCount: 1,
        invalidatedCount: 0,
        retainedCount: 1,
      };
    }

    const currentRevision = Number(parent.orchestration_revision || 0);
    const nextRevision = currentRevision + 1;
    const childTaskId = deterministicRetryUuid(
      'orchestration-retry-pending-task-v1',
      item.tenant_id,
      parent.id,
      item.id,
      lineage.sourceExecutionTaskId,
      lineage.itemRevision,
      lineage.attemptCount,
      lineage.requestKey,
    );
    const commandId = deterministicRetryUuid(
      'orchestration-retry-pending-command-v1',
      childTaskId,
    );
    const itemAttemptId = deterministicRetryUuid(
      'orchestration-retry-pending-attempt-v1',
      childTaskId,
      item.id,
    );
    const continuationRequestHash = hashOrchestrationRequest({
      action: 'retry_items_pending_continuation',
      tenantId: item.tenant_id,
      parentTaskId: parent.id,
      itemId: item.id,
      sourceExecutionTaskId: lineage.sourceExecutionTaskId,
      sourceAssignmentRevision: lineage.itemRevision,
      sourceAttemptCount: lineage.attemptCount,
      authorizedParentRevision: lineage.waitingParentRevision,
      claimedParentRevision: currentRevision,
      retryRequestKey: lineage.requestKey,
    });
    const childTaskInput = normalizeRemoteTaskInput({
      clientTaskId: childTaskId,
      title: `${parent.title} · ${text(item.keyword, 80)}重试`,
      executionMode: 'one_time',
      planSnapshot: {
        ...planSnapshot,
        enabled: true,
        autoLoop: false,
        maxRounds: 1,
        roundGapMin: 0,
        platform: parent.platform,
        keywords: [item.keyword],
      },
    });
    const childPlan = childTaskInput.planSnapshot;
    const actionMetadata = {
      action: 'retry_pending_auto_dispatch',
      trigger: 'capture_orchestration_recovery_sweep',
      protocolVersion: 1,
      originalRequestKey: lineage.requestKey,
      originalRequestHash: lineage.requestHash,
      authorizedPlanHash: lineage.planHash,
      continuationRequestKey: childTaskId,
      continuationRequestHash,
      tenantId: item.tenant_id,
      parentTaskId: parent.id,
      itemId: item.id,
      sourceExecutionTaskId: lineage.sourceExecutionTaskId,
      sourceAssignmentRevision: lineage.itemRevision,
      sourceAttemptCount: lineage.attemptCount,
      authorizedParentRevision: lineage.waitingParentRevision,
      claimedParentRevision: currentRevision,
      assignedParentRevision: nextRevision,
      agentId: targetAgent.id,
      shanghaiUsageDateCurrent: targetAgent.today_usage_current === true,
      todaySearches: Number(targetAgent.today_searches),
      dailySearchLimit: targetAgent.daily_search_limit === null
        ? null
        : Number(targetAgent.daily_search_limit),
    };
    const childMetadata = {
      remoteCreated: true,
      remoteRequestHash: continuationRequestHash,
      createCommandId: commandId,
      requestedByUserId: lineage.requestedByUserId || '',
      requestedByName: lineage.requestedByName,
      executionMode: 'one_time',
      planSnapshot: childPlan,
      orchestrationChild: true,
      parentTaskId: parent.id,
      orchestrationRevision: nextRevision,
      itemIds: [item.id],
      retryRequestHash: lineage.requestHash,
      retryRequestKey: lineage.requestKey,
      retryBatchSize: lineage.batchSize,
      retryDispatchOrdinal: lineage.dispatchOrdinal,
      retryDispatchedItemIds: [item.id],
      retryWaitingItems: [],
      retrySourceExecutionTaskIds: [lineage.sourceExecutionTaskId],
      retryConfirmedByUser: true,
      retrySafetyConfirmed: lineage.safetyConfirmed,
      retryAutoContinuation: true,
      retryContinuationRequestKey: childTaskId,
      retryContinuationRequestHash: continuationRequestHash,
      retryContinuationAction: actionMetadata,
    };
    const child = await tx.queryOne(`
      INSERT INTO capture_tasks (
        id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
        client_task_id, task_type, feature_key, title, platform,
        source, trigger_type, status, progress, checkpoint, counts,
        metadata, message, source_updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $4,
        $1::uuid::text, 'unattended_keyword_capture',
        'unattended_keyword_plan', $5, $6,
        'cloud', 'orchestration_retry', 'pending',
        $7::jsonb, $8::jsonb, $9::jsonb,
        $10::jsonb, '空闲 Agent 已释放，云端自动续接等待中的重试项', now()
      )
      RETURNING id, parent_task_id, assigned_agent_id, title, platform,
        status, progress, counts, metadata, created_at, updated_at
    `, [
      childTaskId,
      item.tenant_id,
      parent.id,
      targetAgent.id,
      childTaskInput.title,
      parent.platform,
      JSON.stringify({current: 0, total: 1, phase: 'queued'}),
      JSON.stringify({round: 1, keywordIndex: 0}),
      JSON.stringify({
        total: 1,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
      }),
      JSON.stringify(childMetadata),
    ]);
    const updatedItem = await tx.queryOne(`
      UPDATE capture_task_items
      SET status = 'dispatched',
        attempt_count = attempt_count + 1,
        assigned_agent_id = $1,
        execution_task_id = $2,
        assignment_revision = $3,
        request_hash = $4,
        error = '{}'::jsonb,
        metadata = (
          metadata - ARRAY[
            'retryPending', 'retryWaitingSince', 'retryWaitingRequestKey',
            'retryWaitingRequestHash', 'retryWaitingPlanHash',
            'retryWaitingReason',
            'retryWaitingAgentId', 'retryWaitingParentRevision',
            'retryWaitingItemRevision', 'retryWaitingAttemptCount',
            'retryWaitingSourceExecutionTaskId',
            'retryWaitingSafetyConfirmed', 'retryWaitingRequestedByUserId',
            'retryWaitingRequestedByName', 'retryWaitingBatchSize',
            'retryWaitingDispatchOrdinal', 'retryWaitingLastCheckedAt'
          ]::text[]
        ) || jsonb_build_object(
          'retrySourceExecutionTaskId', $5::uuid::text,
          'retryRequestKey', $6::uuid::text,
          'retryAutoContinuation', true,
          'retryContinuationRequestKey', $2::uuid::text,
          'retryContinuationRequestHash', $4::text,
          'retryContinuationAction', $7::jsonb
        ),
        assigned_at = now(),
        dispatched_at = now(),
        started_at = NULL,
        finished_at = NULL,
        updated_at = now()
      WHERE id = $8 AND tenant_id = $9 AND task_id = $10
        AND execution_task_id = $5
        AND assignment_revision = $11
        AND attempt_count = $12
        AND status = 'retryable'
        AND metadata->>'retryPending' = 'true'
        AND metadata->>'retryWaitingRequestKey' = $6::uuid::text
        AND metadata->>'retryWaitingRequestHash' = $13
        AND metadata->>'retryWaitingSourceExecutionTaskId' = $5::uuid::text
        AND metadata->>'retryWaitingParentRevision' = $14
        AND metadata->>'retryWaitingPlanHash' = $15
        AND metadata->>'retryWaitingItemRevision' = $11::text
        AND metadata->>'retryWaitingAttemptCount' = $12::text
      RETURNING id, attempt_count
    `, [
      targetAgent.id,
      child.id,
      nextRevision,
      continuationRequestHash,
      lineage.sourceExecutionTaskId,
      lineage.requestKey,
      JSON.stringify(actionMetadata),
      item.id,
      item.tenant_id,
      parent.id,
      lineage.itemRevision,
      lineage.attemptCount,
      lineage.requestHash,
      String(lineage.waitingParentRevision),
      lineage.planHash,
    ]);
    if (!updatedItem) {
      const error = new Error('orchestration_retry_pending_item_conflict');
      error.code = 'orchestration_retry_pending_item_conflict';
      throw error;
    }
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        id, tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, agent_display_name,
        attempt_number, assignment_revision, status,
        request_hash, checkpoint, result, error, dispatched_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, 'dispatched',
        $10, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
      )
    `, [
      itemAttemptId,
      item.tenant_id,
      item.id,
      parent.id,
      child.id,
      targetAgent.id,
      text(targetAgent.display_name, 240),
      Number(updatedItem.attempt_count),
      nextRevision,
      continuationRequestHash,
    ]);
    const itemAttemptBindings = [{
      itemId: item.id,
      attemptId: itemAttemptId,
      requestHash: continuationRequestHash,
      attemptNumber: Number(updatedItem.attempt_count),
      assignmentRevision: nextRevision,
      keyword: item.keyword,
    }];
    const command = await tx.queryOne(`
      INSERT INTO capture_agent_commands (
        id, tenant_id, agent_id, task_id, command_type, payload,
        requested_by_user_id, requested_by_name
      ) VALUES (
        $1, $2, $3, $4, 'create', $5::jsonb, $6, $7
      )
      RETURNING id, status, expires_at, created_at
    `, [
      commandId,
      item.tenant_id,
      targetAgent.id,
      child.id,
      JSON.stringify({
        taskId: child.id,
        clientTaskId: child.id,
        title: child.title,
        executionMode: 'one_time',
        platform: childPlan.platform,
        planSnapshot: childPlan,
        requestHash: continuationRequestHash,
        authCodeId: targetAgent.auth_code_id,
        authBindingId: targetAgent.auth_binding_id,
        orchestration: {
          parentTaskId: parent.id,
          revision: nextRevision,
          itemIds: [item.id],
          itemAttempts: itemAttemptBindings,
          retrySourceExecutionTaskIds: [lineage.sourceExecutionTaskId],
          retryParentRequestKey: lineage.requestKey,
        },
      }),
      lineage.requestedByUserId || null,
      '系统 · 等待重试自动续接',
    ]);

    const refreshedItems = await listParentItems(
      tx,
      item.tenant_id,
      parent.id,
    );
    const remainingWaiting = refreshedItems
      .filter(candidate =>
        candidate.status === 'retryable' &&
        safeJson(candidate.metadata).retryPending === true
      )
      .map(publicPendingRetryItem);
    const aggregate = aggregateParentTaskItems(refreshedItems);
    const parentUpdate = await tx.queryOne(`
      UPDATE capture_tasks
      SET orchestration_revision = orchestration_revision + 1,
        status = $1,
        progress = $2::jsonb,
        counts = $3::jsonb,
        metadata = metadata || jsonb_build_object(
          'lastRetryAt', now(),
          'lastRetryTaskIds', jsonb_build_array($4::uuid::text),
          'lastRetryRequestKey', $5::uuid::text,
          'lastRetryRequestHash', $6::text,
          'lastRetryAssignments', $7::jsonb,
          'lastRetryWaiting', $8::jsonb,
          'lastRetryAutoContinuationAt', now(),
          'lastRetryAutoContinuationAction', $9::jsonb
        ),
        message = CASE
          WHEN jsonb_array_length($8::jsonb) > 0
            THEN '空闲 Agent 已自动续接一个失败关键词，其余继续等待'
          ELSE '等待中的失败关键词已自动续接到空闲 Agent'
        END,
        finished_at = NULL,
        updated_at = now(),
        source_updated_at = now()
      WHERE id = $10 AND tenant_id = $11
        AND task_type = 'capture_orchestration'
        AND orchestration_revision = $12
      RETURNING id, orchestration_revision, status
    `, [
      aggregate.status,
      JSON.stringify(aggregate.progress),
      JSON.stringify(aggregate.counts),
      child.id,
      lineage.requestKey,
      lineage.requestHash,
      JSON.stringify([{
        itemId: item.id,
        agentId: targetAgent.id,
        taskId: child.id,
        automaticContinuation: true,
      }]),
      JSON.stringify(remainingWaiting),
      JSON.stringify(actionMetadata),
      parent.id,
      item.tenant_id,
      currentRevision,
    ]);
    if (!parentUpdate) {
      const error = new Error('orchestration_retry_pending_revision_conflict');
      error.code = 'orchestration_retry_pending_revision_conflict';
      throw error;
    }
    await tx.execute(`
      UPDATE capture_tasks
      SET metadata = jsonb_set(
        metadata,
        '{retryWaitingItems}',
        $1::jsonb,
        true
      ), updated_at = now()
      WHERE tenant_id = $2 AND parent_task_id = $3
        AND metadata->>'retryRequestKey' = $4::uuid::text
    `, [
      JSON.stringify(remainingWaiting),
      item.tenant_id,
      parent.id,
      lineage.requestKey,
    ]);
    await appendEvent(tx, {
      tenantId: item.tenant_id,
      taskId: child.id,
      agentId: targetAgent.id,
      eventType: 'orchestration_retry_pending_child_dispatched',
      actorType: 'system',
      actorId: 'retry_waiting_sweeper',
      actorName: '系统 · 等待重试自动续接',
      status: child.status,
      message: 'Agent 槽释放后，等待中的失败关键词已自动下发',
      payload: actionMetadata,
    });
    await appendEvent(tx, {
      tenantId: item.tenant_id,
      taskId: parent.id,
      agentId: targetAgent.id,
      eventType: 'orchestration_retry_pending_dispatched',
      actorType: 'system',
      actorId: 'retry_waiting_sweeper',
      actorName: '系统 · 等待重试自动续接',
      status: parentUpdate.status,
      message: remainingWaiting.length > 0
        ? '已自动续接一个等待项，其余继续等待空闲 Agent'
        : '所有等待项均已自动续接',
      payload: {
        ...actionMetadata,
        revision: Number(parentUpdate.orchestration_revision),
        commandId: command.id,
        remainingWaiting,
      },
    });
    return {
      kind: 'dispatched',
      tenantId: item.tenant_id,
      parentTaskId: parent.id,
      itemId: item.id,
      taskId: child.id,
      commandId: command.id,
      agentId: targetAgent.id,
      revision: Number(parentUpdate.orchestration_revision),
      remainingWaiting: remainingWaiting.length,
    };
  }
  const waitingCheck = waitingPreviews.length > 0
    ? await touchPendingRetryWaitingMarkers(tx, waitingPreviews)
    : {checkedCount: 0, checkedItemIds: []};
  return waitingCount > 0
    ? {kind: 'waiting_for_agent', waitingCount, ...waitingCheck, staleCount}
    : {kind: staleCount > 0 ? 'stale' : 'empty', waitingCount, staleCount};
}

export const reconcilePendingOrchestrationRetries =
  createPendingOrchestrationRetryReconciler({
    withTransaction,
    dispatchOnePendingRetry: dispatchOnePendingOrchestrationRetry,
  });
