import crypto from 'crypto';

import {queryAll, withTransaction} from '../../../db/init.js';
import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  captureAgentOnline,
  findCaptureAgentExecutionSlotBlocker,
  lockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  normalizeRemoteTaskInput,
  sanitizeCloudStructuredObject,
} from '../../../services/capture-cloud.js';
import {
  aggregateParentTaskItems,
  checkpointEntryToItemStatus,
} from '../../../services/capture-orchestration.js';
import {
  AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT,
  CAPTURE_UUID_PATTERN as UUID_PATTERN,
  CROSS_DEVICE_RETRY_TASK_TYPES,
  ORCHESTRATION_ITEM_TERMINAL_STATUSES,
  appendEvent,
  buildSequentialSearchResumeCheckpoint,
  crossDeviceRetryItemNeedsManualSafety,
  orchestrationCheckpointEntries,
  orchestrationCheckpointInteger,
  orchestrationCheckpointTimestamp,
  orchestrationItemAttemptStatus,
  promotedRetryBusinessTaskType,
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {
  createAutomaticCaptureRetryReconciler,
} from '../application/automatic-recovery.js';
import {isProfilePatrolTask} from '../application/profile-patrol.js';
import {expireStaleCommands} from './postgres-command-reconciliation.js';

const CROSS_DEVICE_RETRY_SOURCE_STATUSES = new Set([
  'needs_action',
  'failed',
  'completed_with_failures',
]);
const AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES = new Set([
  'pending',
  'running',
]);
const CROSS_DEVICE_RETRY_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'retryable',
  'needs_action',
  'failed',
]);
const CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
  'needs_action',
]);
const CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
]);
const CROSS_DEVICE_RETRY_PERMANENT_CODES = new Set([
  'CONTENT_UNAVAILABLE',
  'INVALID_RECORD',
  'LINK_MISSING',
  'IDENTITY_MISMATCH',
  'DOUYIN_DETAIL_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_CONFLICT',
  'CANCELED',
  'DETAIL_CAPTURE_CANCELED',
  'USER_CANCELED',
]);

export function crossDeviceRetryTaskSupported(task = {}) {
  if (task.parent_task_id) return false;
  return CROSS_DEVICE_RETRY_TASK_TYPES.has(
    promotedRetryBusinessTaskType(task),
  );
}

function crossDeviceRetrySourceReady(task = {}, {automatic = false} = {}) {
  if (CROSS_DEVICE_RETRY_SOURCE_STATUSES.has(task.status)) return true;
  if (!automatic || !AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES.has(task.status)) {
    return false;
  }
  const metadata = safeJson(task.metadata);
  return Boolean(text(metadata.lastAutomaticRecoveryTaskId, 100));
}

export function classifyCaptureRecoveryDisposition(item = {}) {
  if (crossDeviceRetryItemNeedsManualSafety(item)) {
    return {kind: 'manual_current', automatic: false};
  }
  const status = text(item.status, 80).toLowerCase();
  if (
    Number(item.attempt_count || 0) >=
    AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT
  ) {
    return {kind: 'automatic_attempts_exhausted', automatic: false};
  }
  if (
    !item.started_at &&
    CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES.has(status)
  ) {
    return {kind: 'auto_handoff', automatic: true};
  }
  const error = safeJson(item.error);
  const checkpoint = safeJson(safeJson(item.metadata).checkpoint);
  const code = text(
    error.code || checkpoint.errorCode || checkpoint.error_code,
    100,
  ).toUpperCase();
  const category = text(
    error.category || checkpoint.errorCategory || checkpoint.error_category,
    100,
  ).toLowerCase();
  if (
    CROSS_DEVICE_RETRY_PERMANENT_CODES.has(code) ||
    ['invalid_record', 'link_missing', 'integrity_blocked', 'user_canceled']
      .includes(category)
  ) {
    return {kind: 'terminal_business_failure', automatic: false};
  }
  if (['retryable', 'needs_action', 'failed'].includes(status)) {
    return {kind: 'auto_retry_or_handoff', automatic: true};
  }
  return {kind: 'wait', automatic: false};
}

export function crossDeviceRetrySourceAgentIdsForItems(
  items = [],
  attempts = [],
) {
  const selectedItemIds = new Set(
    items.map(item => text(item?.id, 100).toLowerCase()).filter(Boolean),
  );
  return Array.from(new Set([
    ...items.map(item => item?.assigned_agent_id),
    ...attempts
      .filter(attempt => selectedItemIds.has(
        text(attempt?.item_id, 100).toLowerCase(),
      ))
      .map(attempt => attempt?.agent_id),
  ]
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value))));
}





export function crossDeviceRetryAgentSupportsTask(
  agent = {},
  task = {},
  commandPayload = {},
) {
  const capabilities = safeJson(agent.capabilities);
  if (capabilities.remoteTaskCreate !== true) return false;
  const platform = text(task.platform, 40).toLowerCase();
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  const supportedPlatforms = normalizeCaptureAgentPlatforms(
    capabilities.supportedPlatforms,
  );
  if (
    (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) ||
    (supportedPlatforms.length > 0 && !supportedPlatforms.includes(platform))
  ) {
    return false;
  }

  const taskType = promotedRetryBusinessTaskType(task);
  if (taskType === 'unattended_keyword_capture') {
    const metadata = safeJson(task.metadata);
    const planSnapshot = safeJson(
      metadata.planSnapshot || commandPayload.planSnapshot,
    );
    if (
      Object.keys(safeJson(planSnapshot.captureSettings)).length > 0 &&
      capabilities.remoteTaskEnhancementOptions !== true
    ) {
      return false;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        planSnapshot,
        'keywordMaxDetectedItems',
      ) &&
      capabilities.remoteTaskKeywordPostLimit !== true
    ) {
      return false;
    }
    return true;
  }

  if (capabilities.remoteTargetedPostCaptureV1 !== true) return false;
  if (taskType === 'negative_post_patrol') {
    return capabilities.negativePostPatrol === true;
  }
  if (taskType === 'watched_content_patrol') {
    return capabilities.watchedContentPatrol === true;
  }
  if (taskType === 'followed_creator_post_patrol') {
    return capabilities.followedCreatorPostPatrol === true;
  }
  if (taskType === 'official_account_post_discovery') {
    return capabilities.officialAccountPostDiscovery === true;
  }
  if (taskType === 'official_account_comment_patrol') {
    if (isProfilePatrolTask({...task, task_type: taskType}, commandPayload)) {
      return capabilities.officialAccountCommentPatrolProfileV1 === true &&
        capabilities.officialAccountLatestPostsByCountV1 === true;
    }
    return capabilities.officialAccountCommentPatrol === true;
  }
  return false;
}

function abortCrossDeviceRetry(error, details = {}) {
  const failure = new Error(error);
  failure.code = 'cross_device_retry_transaction_abort';
  failure.crossDeviceRetryError = error;
  failure.details = details;
  throw failure;
}
function promotedRetryKeywordItemKey(keyword, ordinal) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(String(keyword || ''))
    .digest('hex')
    .slice(0, 12);
  return `keyword:${String(ordinal + 1).padStart(4, '0')}:${fingerprint}`;
}

function promotedRetryKeywordError(entry = {}) {
  const raw = entry.error;
  const error = raw && typeof raw === 'object'
    ? sanitizeCloudStructuredObject(raw)
    : text(raw, 1000)
      ? {message: text(raw, 1000)}
      : {};
  const code = text(entry.errorCode || entry.error_code, 100);
  const category = text(entry.errorCategory || entry.error_category, 100);
  return {
    ...error,
    ...(code ? {code} : {}),
    ...(category ? {category} : {}),
    ...(entry.securityBlocked === true ? {securityBlocked: true} : {}),
    ...(entry.requiresManualAction === true
      ? {requiresManualAction: true}
      : {}),
  };
}

async function synthesizePromotedKeywordItems(tx, task, sourceTaskId) {
  const metadata = safeJson(task.metadata);
  const command = await tx.queryOne(`
    SELECT payload
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [task.tenant_id, task.id]);
  const commandPayload = safeJson(command?.payload);
  const planSnapshot = safeJson(
    metadata.planSnapshot || commandPayload.planSnapshot,
  );
  const normalized = normalizeRemoteTaskInput({
    clientTaskId: task.id,
    title: task.title,
    executionMode: 'one_time',
    planSnapshot: {
      ...planSnapshot,
      platform: task.platform,
    },
  });
  const checkpointEntries = orchestrationCheckpointEntries(task);
  const checkpointByKeyword = new Map(
    checkpointEntries.map(entry => [text(entry.keyword, 120), entry]),
  );
  const keywords = normalized.planSnapshot.keywords.length > 0
    ? normalized.planSnapshot.keywords
    : checkpointEntries.map(entry => text(entry.keyword, 120)).filter(Boolean);
  if (keywords.length === 0) return {error: 'retry_items_unavailable'};

  const baseRevision = Math.max(1, Number(task.orchestration_revision || 0));
  const sourceAgentId = task.assigned_agent_id || task.origin_agent_id || null;
  for (let ordinal = 0; ordinal < keywords.length; ordinal += 1) {
    const keyword = keywords[ordinal];
    const entry = safeJson(checkpointByKeyword.get(keyword));
    const projected = Object.keys(entry).length > 0
      ? checkpointEntryToItemStatus(entry)
      : 'retryable';
    const error = promotedRetryKeywordError(entry);
    const manualSafety = crossDeviceRetryItemNeedsManualSafety({
      error,
      metadata: {checkpoint: entry},
    });
    const status = [
      'completed',
      'completed_with_warnings',
      'skipped',
      'canceled',
    ].includes(projected)
      ? projected
      : manualSafety
        ? 'needs_action'
        : 'retryable';
    const attemptCount = Math.max(
      1,
      orchestrationCheckpointInteger(entry.attemptCount),
    );
    const finishedAt = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(status)
      ? orchestrationCheckpointTimestamp(entry.finishedAt) || new Date().toISOString()
      : null;
    const item = await tx.queryOne(`
      INSERT INTO capture_task_items (
        id, tenant_id, task_id, item_key, ordinal, keyword,
        platform, item_type, status, attempt_count,
        assigned_agent_id, execution_task_id, assignment_revision,
        error, metadata, assigned_at, dispatched_at, started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'keyword', $8, $9,
        $10, $11, $12,
        $13::jsonb, $14::jsonb, $15, $15, $16, $17
      )
      ON CONFLICT (task_id, item_key) DO NOTHING
      RETURNING id
    `, [
      crypto.randomUUID(),
      task.tenant_id,
      task.id,
      promotedRetryKeywordItemKey(keyword, ordinal),
      ordinal,
      keyword,
      task.platform,
      status,
      attemptCount,
      sourceAgentId,
      sourceTaskId,
      baseRevision,
      JSON.stringify(error),
      JSON.stringify({checkpoint: entry, promotedFromSingleNodeTask: true}),
      task.started_at || task.created_at || new Date().toISOString(),
      Object.keys(entry).length > 0
        ? task.started_at || task.created_at || new Date().toISOString()
        : null,
      finishedAt,
    ]);
    if (!item) continue;
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        id, tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        checkpoint, result, error, assigned_at, dispatched_at,
        started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12::jsonb, $13, $13,
        $14, $15
      )
    `, [
      crypto.randomUUID(),
      task.tenant_id,
      item.id,
      task.id,
      sourceTaskId,
      sourceAgentId,
      attemptCount,
      baseRevision,
      orchestrationItemAttemptStatus(status),
      JSON.stringify(entry),
      JSON.stringify({savedCount: orchestrationCheckpointInteger(entry.savedCount)}),
      JSON.stringify(error),
      task.started_at || task.created_at || new Date().toISOString(),
      Object.keys(entry).length > 0
        ? task.started_at || task.created_at || new Date().toISOString()
        : null,
      finishedAt,
    ]);
  }
  return {planSnapshot: normalized.planSnapshot, commandPayload};
}

async function promoteSingleNodeTaskForRetry(tx, task) {
  const metadata = safeJson(task.metadata);
  if (
    task.task_type === 'capture_orchestration' ||
    metadata.promotedRetryParent === true
  ) {
    return {
      parent: task,
      businessTaskType: promotedRetryBusinessTaskType(task),
      sourceTaskId: text(metadata.promotedSourceExecutionTaskId, 100),
    };
  }
  const businessTaskType = promotedRetryBusinessTaskType(task);
  const sourceTaskId = crypto.randomUUID();
  const sourceMetadata = {
    ...metadata,
    orchestrationChild: true,
    parentTaskId: task.id,
    promotedSourceExecution: true,
    promotedAt: new Date().toISOString(),
  };
  await tx.execute(`
    INSERT INTO capture_tasks (
      id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, progress, checkpoint, counts,
      metadata, error, message, attempt_number, progress_seq,
      orchestration_revision, heartbeat_at, business_progress_at,
      started_at, finished_at, source_updated_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      '', $6, $7, $8, $9,
      $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
      $17::jsonb, $18::jsonb, $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27, $28, now()
    )
  `, [
    sourceTaskId,
    task.tenant_id,
    task.id,
    task.origin_agent_id,
    task.assigned_agent_id,
    task.control_task_id,
    businessTaskType,
    task.feature_key,
    `${text(task.title, 190)} · 原执行`,
    task.platform,
    task.source,
    task.trigger_type,
    task.status,
    JSON.stringify(safeJson(task.progress)),
    JSON.stringify(safeJson(task.checkpoint)),
    JSON.stringify(safeJson(task.counts)),
    JSON.stringify(sourceMetadata),
    JSON.stringify(safeJson(task.error)),
    task.message,
    Number(task.attempt_number || 0),
    Number(task.progress_seq || 0),
    Math.max(1, Number(task.orchestration_revision || 0)),
    task.heartbeat_at,
    task.business_progress_at,
    task.started_at,
    task.finished_at,
    task.source_updated_at,
    task.created_at,
  ]);
  await tx.execute(`
    UPDATE capture_task_items
    SET execution_task_id = $1, updated_at = now()
    WHERE tenant_id = $2 AND task_id = $3
      AND execution_task_id = $3
  `, [sourceTaskId, task.tenant_id, task.id]);
  await tx.execute(`
    UPDATE capture_task_item_attempts
    SET execution_task_id = $1, updated_at = now()
    WHERE tenant_id = $2 AND parent_task_id = $3
      AND execution_task_id = $3
  `, [sourceTaskId, task.tenant_id, task.id]);

  const existingItems = await tx.queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
  `, [task.tenant_id, task.id]);
  let keywordContract = {};
  if (
    businessTaskType === 'unattended_keyword_capture' &&
    Number(existingItems?.count || 0) === 0
  ) {
    keywordContract = await synthesizePromotedKeywordItems(
      tx,
      task,
      sourceTaskId,
    );
    if (keywordContract.error) return keywordContract;
  }

  const items = await tx.queryAll(`
    SELECT status
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY ordinal, id
  `, [task.tenant_id, task.id]);
  if (items.length === 0) return {error: 'retry_items_unavailable'};
  const aggregate = aggregateParentTaskItems(items);
  const parent = await tx.queryOne(`
    UPDATE capture_tasks
    SET task_type = 'capture_orchestration',
      assigned_agent_id = NULL,
      status = $1,
      progress = $2::jsonb,
      counts = $3::jsonb,
      metadata = metadata || jsonb_build_object(
        'promotedRetryParent', true,
        'promotedBusinessTaskType', $4::text,
        'promotedSourceExecutionTaskId', $5::uuid::text,
        'promotedAt', now(),
        'originalAssignedAgentId', COALESCE($6::uuid::text, ''),
        'planSnapshot', COALESCE($7::jsonb, metadata->'planSnapshot')
      ),
      message = '原任务已保留，未完成项正在准备由空闲设备重试',
      orchestration_revision = GREATEST(orchestration_revision, 1),
      finished_at = NULL,
      attention_dismissed_at = NULL,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $8 AND tenant_id = $9
      AND metadata->>'promotedRetryParent' IS DISTINCT FROM 'true'
    RETURNING *
  `, [
    aggregate.status,
    JSON.stringify(aggregate.progress),
    JSON.stringify(aggregate.counts),
    businessTaskType,
    sourceTaskId,
    task.assigned_agent_id || task.origin_agent_id || null,
    keywordContract.planSnapshot
      ? JSON.stringify(keywordContract.planSnapshot)
      : null,
    task.id,
    task.tenant_id,
  ]);
  return {
    parent,
    businessTaskType,
    sourceTaskId,
    commandPayload: keywordContract.commandPayload,
  };
}

function crossDeviceRetryAgentEligible(
  agent,
  task,
  commandPayload,
) {
  const authExpired = agent?.auth_code_expires_at &&
    new Date(agent.auth_code_expires_at) < new Date();
  return Boolean(agent) &&
    agent.status === 'active' &&
    agent.tenant_status === 'active' &&
    agent.auth_code_status === 'active' &&
    Boolean(agent.active_auth_binding_id) &&
    !authExpired &&
    captureAgentOnline(agent.last_heartbeat_at) &&
    crossDeviceRetryAgentSupportsTask(agent, task, commandPayload);
}

async function findIdleCrossDeviceRetryAgent(tx, {
  tenantId,
  task,
  sourceAgentIds = [],
  commandPayload = {},
}) {
  const excludedIds = sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value));
  const candidates = await tx.queryAll(`
    SELECT ca.*, tenant.status AS tenant_status,
      ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id,
      (
        SELECT COUNT(*)::integer
        FROM capture_tasks active_task
        WHERE active_task.tenant_id = ca.tenant_id
          AND COALESCE(
            active_task.assigned_agent_id,
            active_task.origin_agent_id
          ) = ca.id
          AND active_task.id <> $3
          AND active_task.task_type <> 'capture_orchestration'
          AND active_task.status = ANY($4::text[])
      ) AS active_task_count,
      (
        SELECT COUNT(*)::integer
        FROM capture_agent_commands active_command
        WHERE active_command.tenant_id = ca.tenant_id
          AND active_command.agent_id = ca.id
          AND active_command.status IN ('pending', 'acknowledged')
          AND (
            active_command.expires_at IS NULL OR
            active_command.expires_at > now()
          )
      ) AS active_command_count
      , (
        SELECT COUNT(*)::integer
        FROM capture_tasks recent_failure
        WHERE recent_failure.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_failure.assigned_agent_id,
            recent_failure.origin_agent_id
          ) = ca.id
          AND recent_failure.created_at > now() - interval '2 hours'
          AND recent_failure.status IN ('failed', 'completed_with_failures')
          AND NOT (
            COALESCE(recent_failure.error::text, '') ~*
              'captcha|security.verification|login.required|safety.block'
          )
      ) AS recent_technical_failure_count
      , (
        SELECT COUNT(*)::integer
        FROM capture_tasks recent_success
        WHERE recent_success.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_success.assigned_agent_id,
            recent_success.origin_agent_id
          ) = ca.id
          AND recent_success.created_at > now() - interval '2 hours'
          AND recent_success.status IN ('completed', 'completed_with_warnings')
      ) AS recent_success_count
      , (
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
    WHERE ca.tenant_id = $1
      AND ca.status = 'active'
      AND NOT (ca.id = ANY($2::uuid[]))
    ORDER BY recent_technical_failure_count ASC,
      recent_success_count DESC,
      last_assignment_at ASC NULLS FIRST,
      ca.last_heartbeat_at DESC NULLS LAST,
      ca.id
  `, [
    tenantId,
    excludedIds,
    task.id,
    CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  ]);
  const candidate = candidates.find(agent => {
    return crossDeviceRetryAgentEligible(agent, task, commandPayload) &&
      Number(agent.active_task_count || 0) === 0 &&
      Number(agent.active_command_count || 0) === 0;
  });
  return candidate || null;
}

async function lockIdleCrossDeviceRetryAgent(tx, {
  tenantId,
  candidate,
  task,
  sourceAgentIds = [],
  commandPayload = {},
}) {
  if (!candidate?.id) return null;
  await lockCaptureAgentExecutionSlot(tx, tenantId, candidate.id);
  const locked = await tx.queryOne(`
    SELECT ca.*, tenant.status AS tenant_status,
      ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    WHERE ca.id = $1 AND ca.tenant_id = $2
    FOR UPDATE OF ca
  `, [candidate.id, tenantId]);
  const excludedIds = new Set(sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value)));
  if (
    excludedIds.has(text(locked?.id, 100).toLowerCase()) ||
    !crossDeviceRetryAgentEligible(locked, task, commandPayload)
  ) {
    return null;
  }
  const busy = await findCaptureAgentExecutionSlotBlocker(
    tx,
    tenantId,
    locked.id,
    {excludeTaskIds: [task.id]},
  );
  return busy ? null : locked;
}

async function lockedCrossDeviceRetryAgentStillEligible(tx, {
  tenantId,
  agent,
  task,
  sourceAgentIds = [],
  commandPayload = {},
}) {
  const excludedIds = new Set(sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value)));
  if (
    excludedIds.has(text(agent?.id, 100).toLowerCase()) ||
    !crossDeviceRetryAgentEligible(agent, task, commandPayload)
  ) {
    return false;
  }
  const busy = await findCaptureAgentExecutionSlotBlocker(
    tx,
    tenantId,
    agent.id,
    {excludeTaskIds: [task.id]},
  );
  return !busy;
}

async function loadCrossDeviceRetryItemSelection(tx, {
  tenantId,
  parentTaskId,
  automatic,
  lock = false,
}) {
  const items = await tx.queryAll(`
    SELECT *
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
      AND status = ANY($3::text[])
    ORDER BY ordinal, id
    ${lock ? 'FOR UPDATE' : ''}
  `, [
    tenantId,
    parentTaskId,
    [...CROSS_DEVICE_RETRY_ITEM_STATUSES],
  ]);
  let retryItems = items.filter(
    item => classifyCaptureRecoveryDisposition(item).automatic,
  );
  if (automatic && retryItems.length > 0) {
    const executionTaskIds = Array.from(new Set(
      retryItems
        .map(item => text(item.execution_task_id, 100))
        .filter(Boolean),
    ));
    const sourceStates = executionTaskIds.length > 0
      ? await tx.queryAll(`
          SELECT id, status
          FROM capture_tasks
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        `, [tenantId, executionTaskIds])
      : [];
    const sourceStatusById = new Map(
      sourceStates.map(source => [String(source.id), source.status]),
    );
    retryItems = retryItems
      .filter(item => {
        const executionTaskId = text(item.execution_task_id, 100);
        return !executionTaskId ||
          CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES.has(
            sourceStatusById.get(executionTaskId),
          );
      })
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
      .slice(0, 1);
  }
  if (retryItems.length === 0) {
    const hasManualSafetyItem = items.some(item =>
      classifyCaptureRecoveryDisposition(item).kind === 'manual_current'
    );
    return {
      error: hasManualSafetyItem
        ? 'retry_requires_manual_safety_action'
        : items.length > 0
          ? 'retry_items_not_automatically_recoverable'
          : 'retry_items_unavailable',
      items,
      retryItems: [],
      sourceExecutionTaskIds: [],
    };
  }
  return {
    items,
    retryItems,
    sourceExecutionTaskIds: Array.from(new Set(
      retryItems
        .map(item => text(item.execution_task_id, 100))
        .filter(Boolean),
    )),
  };
}

async function loadCrossDeviceRetryAttempts(tx, tenantId, retryItems) {
  if (retryItems.length === 0) return [];
  return tx.queryAll(`
    SELECT id, item_id, agent_id, attempt_number, assignment_revision, status
    FROM capture_task_item_attempts
    WHERE tenant_id = $1
      AND item_id = ANY($2::uuid[])
      AND agent_id IS NOT NULL
    ORDER BY item_id, attempt_number, id
  `, [tenantId, retryItems.map(item => item.id)]);
}

function crossDeviceRetryItemFence(items) {
  return items.map(item => [
    text(item.id, 100),
    text(item.execution_task_id, 100),
    Number(item.assignment_revision || 0),
    Number(item.attempt_count || 0),
    text(item.assigned_agent_id, 100),
    text(item.status, 80),
  ]);
}

function crossDeviceRetryAttemptFence(attempts) {
  return attempts.map(attempt => [
    text(attempt.id, 100),
    text(attempt.item_id, 100),
    text(attempt.agent_id, 100),
    Number(attempt.attempt_number || 0),
    Number(attempt.assignment_revision || 0),
    text(attempt.status, 80),
  ]);
}

function crossDeviceRetryFenceMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function throwCrossDeviceRetryItemConflict() {
  const conflict = new Error('cross_device_retry_item_conflict');
  conflict.code = 'cross_device_retry_item_conflict';
  throw conflict;
}

function promotedRetryFallbackTarget(item = {}) {
  const metadata = safeJson(item.metadata);
  const sourceRecord = safeJson(metadata.sourceRecord);
  const subscriptionId = text(
    metadata.subscriptionId || item.external_id,
    240,
  );
  if (item.item_type === 'profile_subscription') {
    return {
      itemId: item.id,
      recordId: subscriptionId,
      externalId: subscriptionId,
      subscriptionId,
      accountUrl: item.url_snapshot,
      url: item.url_snapshot,
      title: metadata.accountName || sourceRecord.title || '',
      platform: item.platform,
    };
  }
  return {
    itemId: item.id,
    recordId: item.record_id || item.external_id,
    externalId: item.external_id,
    url: item.url_snapshot,
    title: sourceRecord.title || '',
    publishedAt: sourceRecord.publishedAt || '',
    noteType: sourceRecord.noteType || '',
    baseline: safeJson(metadata.baseline),
  };
}

async function loadPromotedRetryPayload(tx, tenantId, parent, items) {
  const executionTaskIds = Array.from(new Set([
    parent.id,
    ...items.map(item => text(item.execution_task_id, 100)).filter(Boolean),
  ]));
  const commands = await tx.queryAll(`
    SELECT task_id, payload
    FROM capture_agent_commands
    WHERE tenant_id = $1
      AND task_id = ANY($2::uuid[])
      AND command_type = 'create'
    ORDER BY created_at DESC, id DESC
  `, [tenantId, executionTaskIds]);
  const targetByItemId = new Map();
  for (const command of commands) {
    const payload = safeJson(command.payload);
    const targets = Array.isArray(payload.targets)
      ? payload.targets
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    for (const target of targets) {
      const itemId = text(target?.itemId || target?.item_id, 100).toLowerCase();
      if (UUID_PATTERN.test(itemId) && !targetByItemId.has(itemId)) {
        targetByItemId.set(itemId, sanitizeCloudStructuredObject(target));
      }
    }
  }
  return {
    basePayload: safeJson(commands[0]?.payload),
    targets: items.map(item => ({
      ...promotedRetryFallbackTarget(item),
      ...safeJson(targetByItemId.get(String(item.id))),
      itemId: item.id,
    })),
  };
}

async function renewProfileRetryExecutions(tx, tenantId, items, targets) {
  const executionIdByItem = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.item_type !== 'profile_subscription') continue;
    const metadata = safeJson(item.metadata);
    const subscriptionId = text(
      metadata.subscriptionId || item.external_id,
      100,
    ).toLowerCase();
    if (!UUID_PATTERN.test(subscriptionId)) {
      return {error: 'retry_profile_subscription_invalid'};
    }
    const subscription = await tx.queryOne(`
      SELECT id, status
      FROM monitor_subscriptions
      WHERE id = $1 AND tenant_id = $2
    `, [subscriptionId, tenantId]);
    if (!subscription || subscription.status !== 'active') {
      return {error: 'retry_profile_subscription_unavailable'};
    }
    const previousExecutionId = text(metadata.monitorExecutionId, 100);
    if (UUID_PATTERN.test(previousExecutionId)) {
      await tx.execute(`
        UPDATE monitor_executions
        SET status = 'failed',
          error_message = '原设备任务已结束，未完成账号已转交其他设备重试',
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('pending', 'running')
      `, [previousExecutionId, tenantId]);
    }
    const execution = await tx.queryOne(`
      INSERT INTO monitor_executions (tenant_id, subscription_id, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (subscription_id)
        WHERE status IN ('pending', 'running')
      DO NOTHING
      RETURNING id
    `, [tenantId, subscriptionId]);
    if (!execution) return {error: 'retry_profile_execution_busy'};
    executionIdByItem.set(String(item.id), execution.id);
    targets[index] = {
      ...targets[index],
      subscriptionId,
      recordId: subscriptionId,
      externalId: subscriptionId,
      executionId: execution.id,
    };
  }
  return {executionIdByItem};
}

export async function dispatchCrossDeviceRetry({
  tenantId,
  taskId,
  requestKey,
  expectedRevision,
  actorType = 'system',
  requestedByUserId = '',
  requestedByName = '自动调度中心',
  automatic = false,
} = {}) {
  const req = {
    tenantId,
    user: requestedByUserId ? {id: requestedByUserId} : null,
    actorName: requestedByName,
  };
  return await withTransaction(async tx => {
      await tx.execute(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['capture_task_global_id', requestKey],
      );
      // All orchestration control paths take this parent fence before Agent,
      // task, command or item row locks. It serializes retry, handoff, stop and
      // negative-patrol reassignment without changing their business filters.
      await tx.execute(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['capture_orchestration_control', taskId],
      );
      const replay = await tx.queryOne(`
        SELECT id, parent_task_id, assigned_agent_id, status, metadata
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [requestKey, req.tenantId]);
      if (replay) {
        const replayMetadata = safeJson(replay.metadata);
        if (
          String(replay.parent_task_id || '') !== taskId ||
          replayMetadata.crossDeviceRetryRequestKey !== requestKey
        ) {
          return {error: 'idempotency_key_conflict'};
        }
        return {existing: true, child: replay};
      }

      const initialTask = await tx.queryOne(`
        SELECT *
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
      `, [taskId, req.tenantId]);
      if (!initialTask) return {error: 'task_not_found'};
      const initialPlanSnapshot = safeJson(
        safeJson(initialTask.metadata).planSnapshot,
      );
      if (
        automatic &&
        (
          safeJson(initialTask.metadata).automaticRetryDisabled === true ||
          safeJson(initialPlanSnapshot.recoveryPolicy)
            .allowIdleAgentHandoff === false
        )
      ) {
        return {error: 'automatic_retry_disabled'};
      }
      if (!crossDeviceRetryTaskSupported(initialTask)) {
        return {error: 'task_cross_device_retry_unsupported'};
      }
      if (!crossDeviceRetrySourceReady(initialTask, {automatic})) {
        return {error: 'task_not_settled_for_retry'};
      }
      if (Number(initialTask.orchestration_revision || 0) !== expectedRevision) {
        return {
          error: 'revision_conflict',
          currentRevision: Number(initialTask.orchestration_revision || 0),
        };
      }

      const sourceCommand = await tx.queryOne(`
        SELECT payload
        FROM capture_agent_commands
        WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [req.tenantId, initialTask.id]);
      const previewBusinessTaskType = promotedRetryBusinessTaskType(initialTask);
      let previewSelection = null;
      let previewAttempts = [];
      let previewSourceAgentIds = [
        initialTask.assigned_agent_id,
        initialTask.origin_agent_id,
      ];
      if (initialTask.task_type === 'capture_orchestration') {
        previewSelection = await loadCrossDeviceRetryItemSelection(tx, {
          tenantId: req.tenantId,
          parentTaskId: initialTask.id,
          automatic,
        });
        if (previewSelection.error) {
          abortCrossDeviceRetry(previewSelection.error);
        }
        if (
          previewBusinessTaskType === 'unattended_keyword_capture' &&
          previewSelection.retryItems.length > 30
        ) {
          abortCrossDeviceRetry('retry_item_capacity_exceeded');
        }
        previewAttempts = await loadCrossDeviceRetryAttempts(
          tx,
          req.tenantId,
          previewSelection.retryItems,
        );
        previewSourceAgentIds = crossDeviceRetrySourceAgentIdsForItems(
          previewSelection.retryItems,
          previewAttempts,
        );
      }

      const previewSourceExecutionTaskIds = previewSelection
        ? previewSelection.sourceExecutionTaskIds
        : [initialTask.id];
      const orderedPreviewSourceTaskIds = [
        ...previewSourceExecutionTaskIds,
      ].sort();
      const previewSourceTasks = orderedPreviewSourceTaskIds.length > 0
        ? await tx.queryAll(`
            SELECT id, status
            FROM capture_tasks
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])
            ORDER BY id
          `, [req.tenantId, orderedPreviewSourceTaskIds])
        : [];
      if (
        previewSourceTasks.length !== orderedPreviewSourceTaskIds.length ||
        previewSourceTasks.some(source =>
          !CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES.has(source.status)
        )
      ) {
        abortCrossDeviceRetry('retry_source_execution_active');
      }

      // Candidate discovery is deliberately read-only. No task or item row is
      // locked until the selected Agent's execution slot and Agent row are held.
      const candidateAgent = await findIdleCrossDeviceRetryAgent(tx, {
        tenantId: req.tenantId,
        task: initialTask,
        sourceAgentIds: previewSourceAgentIds,
        commandPayload: safeJson(sourceCommand?.payload),
      });
      const targetAgent = await lockIdleCrossDeviceRetryAgent(tx, {
        tenantId: req.tenantId,
        candidate: candidateAgent,
        task: initialTask,
        sourceAgentIds: previewSourceAgentIds,
        commandPayload: safeJson(sourceCommand?.payload),
      });
      if (!targetAgent) {
        // The legacy path expired scoped commands before reporting that no
        // compatible Agent was available. Preserve that committed cleanup on
        // this normal-return branch without taking any later retry row locks.
        await expireStaleCommands(tx, req.tenantId, initialTask.id);
        return {error: 'idle_compatible_agent_unavailable'};
      }

      // Snapshot projection and command completion lock execution children
      // before their parent. Lock only the preselected sources, in stable order,
      // before command expiry and the parent/item rows.
      const lockedSourceTasks = orderedPreviewSourceTaskIds.length > 0
        ? await tx.queryAll(`
            SELECT id, status
            FROM capture_tasks
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])
            ORDER BY id
            FOR UPDATE
          `, [req.tenantId, orderedPreviewSourceTaskIds])
        : [];
      if (!crossDeviceRetryFenceMatches(
        previewSourceTasks.map(source => [String(source.id), source.status]),
        lockedSourceTasks.map(source => [String(source.id), source.status]),
      )) {
        throwCrossDeviceRetryItemConflict();
      }

      await expireStaleCommands(tx, req.tenantId, initialTask.id);
      const task = await tx.queryOne(`
        SELECT *
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [taskId, req.tenantId]);
      if (!task) return {error: 'task_not_found'};
      const lockedPlanSnapshot = safeJson(safeJson(task.metadata).planSnapshot);
      if (
        automatic &&
        (
          safeJson(task.metadata).automaticRetryDisabled === true ||
          safeJson(lockedPlanSnapshot.recoveryPolicy)
            .allowIdleAgentHandoff === false
        )
      ) {
        return {error: 'automatic_retry_disabled'};
      }
      if (
        !crossDeviceRetryTaskSupported(task) ||
        !crossDeviceRetrySourceReady(task, {automatic})
      ) {
        return {error: 'task_not_settled_for_retry'};
      }
      if (Number(task.orchestration_revision || 0) !== expectedRevision) {
        return {
          error: 'revision_conflict',
          currentRevision: Number(task.orchestration_revision || 0),
        };
      }
      if (task.task_type !== 'capture_orchestration') {
        await tx.queryAll(`
          SELECT id
          FROM capture_task_items
          WHERE tenant_id = $1 AND task_id = $2
          ORDER BY id
          FOR UPDATE
        `, [req.tenantId, task.id]);
      }
      const promoted = await promoteSingleNodeTaskForRetry(tx, task);
      if (promoted.error) abortCrossDeviceRetry(promoted.error);
      const parent = promoted.parent;
      const businessTaskType = promoted.businessTaskType;

      const lockedSelection = await loadCrossDeviceRetryItemSelection(tx, {
        tenantId: req.tenantId,
        parentTaskId: parent.id,
        automatic,
        lock: true,
      });
      if (lockedSelection.error) abortCrossDeviceRetry(lockedSelection.error);
      const retryItems = lockedSelection.retryItems;
      if (
        businessTaskType === 'unattended_keyword_capture' &&
        retryItems.length > 30
      ) {
        abortCrossDeviceRetry('retry_item_capacity_exceeded');
      }
      const sourceExecutionTaskIds = lockedSelection.sourceExecutionTaskIds;
      if (
        previewSelection &&
        !crossDeviceRetryFenceMatches(
          crossDeviceRetryItemFence(previewSelection.retryItems),
          crossDeviceRetryItemFence(retryItems),
        )
      ) {
        throwCrossDeviceRetryItemConflict();
      }
      if (previewSelection && !crossDeviceRetryFenceMatches(
        [...previewSourceExecutionTaskIds].sort(),
        [...sourceExecutionTaskIds].sort(),
      )) {
        throwCrossDeviceRetryItemConflict();
      }
      if (!previewSelection) {
        const activeSource = await tx.queryOne(`
          SELECT id, status
          FROM capture_tasks
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
            AND status <> ALL($3::text[])
          ORDER BY id
          LIMIT 1
        `, [
          req.tenantId,
          sourceExecutionTaskIds,
          [...CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES],
        ]);
        if (activeSource) abortCrossDeviceRetry('retry_source_execution_active');
      }
      const activeSourceCommand = await tx.queryOne(`
        SELECT id
        FROM capture_agent_commands
        WHERE tenant_id = $1
          AND task_id = ANY($2::uuid[])
          AND status IN ('pending', 'acknowledged')
        ORDER BY created_at, id
        LIMIT 1
      `, [req.tenantId, [parent.id, ...sourceExecutionTaskIds]]);
      if (activeSourceCommand) {
        abortCrossDeviceRetry('retry_source_command_active');
      }

      const lockedAttempts = await loadCrossDeviceRetryAttempts(
        tx,
        req.tenantId,
        retryItems,
      );
      if (previewSelection && !crossDeviceRetryFenceMatches(
        crossDeviceRetryAttemptFence(previewAttempts),
        crossDeviceRetryAttemptFence(lockedAttempts),
      )) {
        throwCrossDeviceRetryItemConflict();
      }
      const lockedSourceAgentIds = previewSelection
        ? crossDeviceRetrySourceAgentIdsForItems(retryItems, lockedAttempts)
        : previewSourceAgentIds;
      if (!await lockedCrossDeviceRetryAgentStillEligible(tx, {
        tenantId: req.tenantId,
        agent: targetAgent,
        task: parent,
        sourceAgentIds: lockedSourceAgentIds,
        commandPayload: safeJson(sourceCommand?.payload),
      })) {
        return {error: 'idle_compatible_agent_unavailable'};
      }

      const nextRevision = Number(parent.orchestration_revision || 0) + 1;
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        action: 'cross_device_retry',
        parentTaskId: parent.id,
        requestKey,
        expectedRevision,
        targetAgentId: targetAgent.id,
        itemIds: retryItems.map(item => item.id).sort(),
      })).digest('hex');
      const commandId = crypto.randomUUID();
      const payloadContract = await loadPromotedRetryPayload(
        tx,
        req.tenantId,
        parent,
        retryItems,
      );
      const renewedExecutions = await renewProfileRetryExecutions(
        tx,
        req.tenantId,
        retryItems,
        payloadContract.targets,
      );
      if (renewedExecutions.error) {
        abortCrossDeviceRetry(renewedExecutions.error);
      }

      let commandPayload;
      let childPlan = {};
      let sequentialResumeCheckpoint = null;
      if (businessTaskType === 'unattended_keyword_capture') {
        const planSnapshot = safeJson(safeJson(parent.metadata).planSnapshot);
        if (retryItems.length === 1) {
          sequentialResumeCheckpoint = buildSequentialSearchResumeCheckpoint({
            planSnapshot,
            itemMetadata: retryItems[0].metadata,
            keyword: retryItems[0].keyword,
          });
        }
        const normalized = normalizeRemoteTaskInput({
          clientTaskId: requestKey,
          title: `${parent.title} · 换设备重试`,
          executionMode: 'one_time',
          planSnapshot: {
            ...planSnapshot,
            enabled: true,
            autoLoop: false,
            maxRounds: 1,
            roundGapMin: 0,
            platform: parent.platform,
            keywords: retryItems.map(item => item.keyword),
          },
        });
        childPlan = normalized.planSnapshot;
        commandPayload = {
          taskId: requestKey,
          clientTaskId: requestKey,
          title: normalized.title,
          executionMode: 'one_time',
          platform: childPlan.platform,
          planSnapshot: childPlan,
          ...(sequentialResumeCheckpoint
            ? {checkpoint: sequentialResumeCheckpoint}
            : {}),
          requestHash,
          authCodeId: targetAgent.auth_code_id,
          authBindingId: targetAgent.auth_binding_id,
          orchestration: {
            parentTaskId: parent.id,
            revision: nextRevision,
            itemIds: retryItems.map(item => item.id),
            sourceExecutionTaskIds,
          },
        };
      } else {
        commandPayload = {
          ...payloadContract.basePayload,
          taskId: requestKey,
          clientTaskId: requestKey,
          parentTaskId: parent.id,
          title: `${parent.title} · 换设备重试`,
          executionMode: 'one_time',
          platform: parent.platform,
          workflow: businessTaskType,
          taskKind: businessTaskType,
          targets: payloadContract.targets,
          items: payloadContract.targets,
          requestHash,
          authCodeId: targetAgent.auth_code_id,
          authBindingId: targetAgent.auth_binding_id,
        };
      }
      const childMetadata = {
        ...safeJson(parent.metadata),
        promotedRetryParent: false,
        promotedBusinessTaskType: businessTaskType,
        workflow: businessTaskType,
        orchestrationChild: true,
        parentTaskId: parent.id,
        orchestrationRevision: nextRevision,
        remoteCreated: true,
        remoteRequestHash: requestHash,
        createCommandId: commandId,
        executionMode: 'one_time',
        ...(Object.keys(childPlan).length > 0 ? {planSnapshot: childPlan} : {}),
        itemIds: retryItems.map(item => item.id),
        crossDeviceRetry: true,
        crossDeviceRetryRequestKey: requestKey,
        crossDeviceRetrySourceExecutionTaskIds: sourceExecutionTaskIds,
        automaticRecovery: automatic,
        ...(sequentialResumeCheckpoint
          ? {
              resumedSequentialSearch: true,
              resumeRound: sequentialResumeCheckpoint.round,
            }
          : {}),
        requestedByUserId: req.user?.id || '',
        requestedByName: text(req.actorName, 240),
      };
      const child = await tx.queryOne(`
        INSERT INTO capture_tasks (
          id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
          client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, checkpoint, counts,
          metadata, message, orchestration_revision, source_updated_at
        ) VALUES (
          $1, $2, $3, $4, $4,
          $1::uuid::text, $5, $5, $6, $7,
          'cloud', 'cross_device_retry', 'pending', $8::jsonb,
          $9::jsonb, $10::jsonb, $11::jsonb,
          '未完成项已转交在线空闲设备，等待领取', $12, now()
        )
        RETURNING *
      `, [
        requestKey,
        req.tenantId,
        parent.id,
        targetAgent.id,
        businessTaskType,
        commandPayload.title,
        parent.platform,
        JSON.stringify({
          current: 0,
          total: retryItems.length,
          percent: 0,
          phase: 'queued',
        }),
        JSON.stringify(businessTaskType === 'unattended_keyword_capture'
          ? sequentialResumeCheckpoint || {round: 1, keywordIndex: 0}
          : {targetIndex: 0}),
        JSON.stringify({
          total: retryItems.length,
          assigned: retryItems.length,
          processed: 0,
          success: 0,
          failed: 0,
          skipped: 0,
        }),
        JSON.stringify(childMetadata),
        nextRevision,
      ]);
      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          id, tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, $4, 'create', $5::jsonb, $6, $7)
        RETURNING id, status, expires_at
      `, [
        commandId,
        req.tenantId,
        targetAgent.id,
        child.id,
        JSON.stringify(commandPayload),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);

      for (const item of retryItems) {
        const attempt = await tx.queryOne(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND item_id = $2
        `, [req.tenantId, item.id]);
        const attemptNumber = Math.max(
          Number(item.attempt_count || 0) + 1,
          Number(attempt?.next_attempt_number || 1),
        );
        const monitorExecutionId = renewedExecutions.executionIdByItem.get(
          String(item.id),
        );
        const updatedItem = await tx.queryOne(`
          UPDATE capture_task_items
          SET status = 'dispatched',
            attempt_count = $1,
            assigned_agent_id = $2,
            execution_task_id = $3,
            assignment_revision = $4,
            request_hash = $5,
            result_record_id = NULL,
            result_observation_id = NULL,
            error = '{}'::jsonb,
            metadata = (metadata - 'checkpoint' - 'targetResult') ||
              jsonb_strip_nulls(jsonb_build_object(
                'crossDeviceRetrySourceExecutionTaskId', $6::uuid::text,
                'crossDeviceRetryRequestKey', $7::uuid::text,
                'monitorExecutionId', $8::text
              )),
            assigned_at = now(), dispatched_at = now(),
            started_at = NULL, finished_at = NULL, updated_at = now()
          WHERE id = $9 AND tenant_id = $10 AND task_id = $11
            AND execution_task_id IS NOT DISTINCT FROM $6::uuid
            AND assignment_revision = $12
            AND status = ANY($13::text[])
          RETURNING id
        `, [
          attemptNumber,
          targetAgent.id,
          child.id,
          nextRevision,
          requestHash,
          item.execution_task_id,
          requestKey,
          monitorExecutionId || null,
          item.id,
          req.tenantId,
          parent.id,
          Number(item.assignment_revision || 0),
          [...CROSS_DEVICE_RETRY_ITEM_STATUSES],
        ]);
        if (!updatedItem) {
          const conflict = new Error('cross_device_retry_item_conflict');
          conflict.code = 'cross_device_retry_item_conflict';
          throw conflict;
        }
        await tx.execute(`
          INSERT INTO capture_task_item_attempts (
            id, tenant_id, item_id, parent_task_id, execution_task_id,
            agent_id, attempt_number, assignment_revision, status,
            request_hash, checkpoint, result, error, dispatched_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, 'dispatched',
            $9, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
          )
        `, [
          crypto.randomUUID(),
          req.tenantId,
          item.id,
          parent.id,
          child.id,
          targetAgent.id,
          attemptNumber,
          nextRevision,
          requestHash,
        ]);
      }
      const refreshedItems = await tx.queryAll(`
        SELECT status
        FROM capture_task_items
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY ordinal, id
      `, [req.tenantId, parent.id]);
      const aggregate = aggregateParentTaskItems(refreshedItems);
      const parentRetryMetadata = {
        lastCrossDeviceRetryAt: new Date().toISOString(),
        lastCrossDeviceRetryTaskId: child.id,
        lastCrossDeviceRetryAgentId: targetAgent.id,
        lastCrossDeviceRetryRequestKey: child.id,
        ...(automatic
          ? {
              automaticRecoveryCount:
                Math.max(
                  0,
                  Number(safeJson(parent.metadata).automaticRecoveryCount) || 0,
                ) + 1,
              lastAutomaticRecoveryAt: new Date().toISOString(),
              lastAutomaticRecoveryTaskId: child.id,
            }
          : {}),
      };
      const parentUpdate = await tx.queryOne(`
        UPDATE capture_tasks
        SET orchestration_revision = $1,
          status = $2, progress = $3::jsonb, counts = $4::jsonb,
          metadata = metadata || $5::jsonb,
          message = $6,
          finished_at = NULL, attention_dismissed_at = NULL,
          updated_at = now(), source_updated_at = now()
        WHERE id = $7 AND tenant_id = $8
          AND task_type = 'capture_orchestration'
          AND orchestration_revision = $9
        RETURNING id, status, orchestration_revision
      `, [
        nextRevision,
        aggregate.status,
        JSON.stringify(aggregate.progress),
        JSON.stringify(aggregate.counts),
        JSON.stringify(parentRetryMetadata),
        automatic
          ? '系统已把未完成项自动转交其他空闲设备'
          : '未完成项已在原任务内转交其他空闲设备重试',
        parent.id,
        req.tenantId,
        Number(parent.orchestration_revision || 0),
      ]);
      if (!parentUpdate) {
        const conflict = new Error('cross_device_retry_revision_conflict');
        conflict.code = 'cross_device_retry_revision_conflict';
        throw conflict;
      }
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: parent.id,
        agentId: targetAgent.id,
        eventType: 'cross_device_retry_dispatched',
        actorType,
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: parentUpdate.status,
        message: automatic
          ? '系统已自动选择在线空闲设备接管未完成项'
          : '未完成项已转交在线空闲设备，并保留在原任务中',
        payload: {
          retryTaskId: child.id,
          targetAgentId: targetAgent.id,
          itemIds: retryItems.map(item => item.id),
          sourceExecutionTaskIds,
          revision: parentUpdate.orchestration_revision,
          automatic,
        },
      });
      return {
        existing: false,
        child,
        command,
        agent: targetAgent,
        parent: parentUpdate,
        itemCount: retryItems.length,
      };
  });
}


async function listAutomaticCaptureRetryCandidates(normalizedLimit) {
  return queryAll(`
    SELECT id, tenant_id, status, orchestration_revision
    FROM capture_tasks
    WHERE parent_task_id IS NULL
      AND attention_dismissed_at IS NULL
      AND (
        status = ANY($1::text[])
        OR (
          status = ANY($2::text[])
          AND COALESCE(metadata->>'lastAutomaticRecoveryTaskId', '') <> ''
        )
      )
      AND updated_at > now() - interval '24 hours'
      AND COALESCE(metadata->>'orchestrationTemplate', 'false') <> 'true'
      AND COALESCE(metadata->>'distributionMode', '') <> 'elastic_pool'
      AND COALESCE(metadata->>'automaticRetryDisabled', 'false') <> 'true'
      AND COALESCE(
        metadata #>> '{planSnapshot,recoveryPolicy,allowIdleAgentHandoff}',
        'true'
      ) <> 'false'
      AND (
        task_type = ANY($3::text[])
        OR (
          task_type = 'capture_orchestration'
          AND COALESCE(
            NULLIF(metadata->>'promotedBusinessTaskType', ''),
            NULLIF(metadata->>'workflow', ''),
            CASE
              WHEN feature_key = ANY($3::text[]) THEN feature_key
              ELSE NULL
            END,
            'unattended_keyword_capture'
          ) = ANY($3::text[])
        )
      )
    ORDER BY
      CASE status WHEN 'needs_action' THEN 0 ELSE 1 END,
      updated_at,
      id
    LIMIT $4
  `, [
    [...CROSS_DEVICE_RETRY_SOURCE_STATUSES],
    [...AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES],
    [...CROSS_DEVICE_RETRY_TASK_TYPES],
    normalizedLimit,
  ]);
}

const reconcileAutomaticCaptureRetriesImpl =
  createAutomaticCaptureRetryReconciler({
    listCandidates: listAutomaticCaptureRetryCandidates,
    dispatchRetry: dispatchCrossDeviceRetry,
    createRequestKey: () => crypto.randomUUID(),
    formatErrorMessage: message => text(message, 240),
  });

export async function reconcileAutomaticCaptureRetries(limit = 10) {
  return reconcileAutomaticCaptureRetriesImpl(limit);
}
