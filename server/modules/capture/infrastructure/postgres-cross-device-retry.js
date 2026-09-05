import crypto from 'crypto';

import {queryAll, withTransaction} from '../../../db/init.js';
import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  captureAgentFullHeartbeatOnline,
  findCaptureAgentExecutionSlotBlocker,
  normalizeCaptureAgentPlatforms,
  normalizeRemoteTaskInput,
  sanitizeCloudStructuredObject,
  tryLockCaptureAgentExecutionSlot,
} from '../../../services/capture-cloud.js';
import {
  aggregateParentTaskItems,
  checkpointEntryToItemStatus,
} from '../../../services/capture-orchestration.js';
import {
  evaluateCaptureSafetyHandoff,
} from '../../../services/capture-safety-handoff-policy.js';
import {
  captureResourceAgentIds,
} from '../../../services/capture-resource-policy.js';
import {
  AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT,
  CAPTURE_UUID_PATTERN as UUID_PATTERN,
  CROSS_DEVICE_RETRY_TASK_TYPES,
  ORCHESTRATION_ITEM_TERMINAL_STATUSES,
  appendEvent,
  buildSequentialSearchResumeCheckpoint,
  crossDeviceRetryItemNeedsManualSafety,
  expectedElasticKeywordSearches,
  isExplicitUserCancellationCode,
  isExplicitUserCancellationSnapshot,
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
import {
  expireStaleCommands,
} from './postgres-command-reconciliation.js';
import {
  loadVerifiedCaptureLocalClosureProof,
} from './postgres-local-closure-proof.js';
import {
  captureTaskResourcePolicy,
  reserveCaptureResourceAdmission,
} from './postgres-resource-admission.js';

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
const DUTY_RECOVERY_TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const DUTY_RECOVERY_SETTING_KEYS = Object.freeze([
  'ops_control_recovery_enabled',
  'ops_control_recovery_mode',
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

function dutyRecoveryGlobalActionsEnabled(env = process.env) {
  return DUTY_RECOVERY_TRUE_VALUES.has(
    text(env.OPS_CONTROL_RECOVERY_GLOBAL_ENABLED, 20).toLowerCase(),
  ) && DUTY_RECOVERY_TRUE_VALUES.has(
    text(env.OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED, 20).toLowerCase(),
  );
}
export function crossDeviceRetryTaskSupported(task = {}) {
  if (task.parent_task_id) return false;
  return CROSS_DEVICE_RETRY_TASK_TYPES.has(
    promotedRetryBusinessTaskType(task),
  );
}

function crossDeviceRetrySourceReady(
  task = {},
  {automatic = false, dutyRecovery = false} = {},
) {
  if (CROSS_DEVICE_RETRY_SOURCE_STATUSES.has(task.status)) return true;
  if (!automatic || !AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES.has(task.status)) {
    return false;
  }
  if (dutyRecovery) return true;
  const metadata = safeJson(task.metadata);
  return Boolean(text(metadata.lastAutomaticRecoveryTaskId, 100));
}

export function classifyCaptureRecoveryDisposition(
  item = {},
  {phase = 'fast'} = {},
) {
  const dutyRecovery = phase === 'duty';
  if (crossDeviceRetryItemNeedsManualSafety(item)) {
    return {kind: 'manual_current', automatic: false};
  }
  const status = text(item.status, 80).toLowerCase();
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
    dutyRecovery &&
    (
      CROSS_DEVICE_RETRY_PERMANENT_CODES.has(code) ||
      isExplicitUserCancellationCode(code) ||
      ['invalid_record', 'link_missing', 'integrity_blocked', 'user_canceled']
        .includes(category)
    )
  ) {
    return {kind: 'terminal_business_failure', automatic: false};
  }
  if (
    !dutyRecovery &&
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

export function crossDeviceRetrySafetyAgentIdsForItems(
  items = [],
  attempts = [],
) {
  const selectedItemIds = new Set(
    items.map(item => text(item?.id, 100).toLowerCase()).filter(Boolean),
  );
  const safetyAgentIds = [
    ...items
      .filter(item => crossDeviceRetryItemNeedsManualSafety(item))
      .map(item => item?.assigned_agent_id),
    ...attempts
      .filter(attempt => (
        selectedItemIds.has(text(attempt?.item_id, 100).toLowerCase())
        && crossDeviceRetryItemNeedsManualSafety({
          status: attempt?.status,
          error: safeJson(attempt?.error),
          metadata: {checkpoint: safeJson(attempt?.checkpoint)},
        })
      ))
      .map(attempt => attempt?.agent_id),
  ];
  return Array.from(new Set(
    safetyAgentIds
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
}

export function crossDeviceRetryAgentSupportsTask(
  agent = {},
  task = {},
  commandPayload = {},
) {
  const capabilities = safeJson(agent.capabilities);
  if (capabilities.taskStateKnown === false) return false;
  if (capabilities.remoteTaskCreate !== true) return false;
  const dutyRecoveryRequested =
    Object.keys(safeJson(commandPayload.dutyRecovery)).length > 0;
  if (dutyRecoveryRequested && (
    capabilities.remoteStop !== true ||
    capabilities.dutyRecoveryLineageV1 !== true
  )) return false;
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
      safeJson(planSnapshot.recoveryPolicy).singleRelayV1 === true &&
      capabilities.singleRelayV1 !== true
    ) {
      return false;
    }
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

export function crossDeviceRetryAgentDailyUsageEligible(
  agent = {},
  expectedSearches = 1,
) {
  const searches = Number(agent.today_searches);
  if (
    agent.today_usage_current !== true ||
    !Number.isInteger(searches) ||
    searches < 0
  ) {
    return false;
  }
  const rawSearchCost = Number(expectedSearches);
  const searchCost = Number.isFinite(rawSearchCost) && rawSearchCost >= 0
    ? Math.floor(rawSearchCost)
    : 1;

  const rawLimit = agent.daily_search_limit;
  if (rawLimit === null || rawLimit === undefined || rawLimit === '') {
    return true;
  }
  const limit = Number(rawLimit);
  return Number.isInteger(limit) &&
    limit >= 0 &&
    (limit === 0 || searches + searchCost <= limit);
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

function previewPromotedRetryKeywordItems(
  task,
  commandPayload = {},
  {automatic = false} = {},
) {
  const metadata = safeJson(task.metadata);
  const planSnapshot = safeJson(
    metadata.planSnapshot || safeJson(commandPayload).planSnapshot,
  );
  const normalized = normalizeRemoteTaskInput({
    clientTaskId: task.id,
    title: task.title,
    executionMode: 'one_time',
    planSnapshot: {...planSnapshot, platform: task.platform},
  });
  const checkpointEntries = orchestrationCheckpointEntries(task);
  const checkpointByKeyword = new Map(
    checkpointEntries.map(entry => [text(entry.keyword, 120), entry]),
  );
  const keywords = normalized.planSnapshot.keywords.length > 0
    ? normalized.planSnapshot.keywords
    : checkpointEntries.map(entry => text(entry.keyword, 120)).filter(Boolean);
  const retryItems = keywords.map((keyword, ordinal) => {
    const checkpoint = safeJson(checkpointByKeyword.get(keyword));
    const projected = Object.keys(checkpoint).length > 0
      ? checkpointEntryToItemStatus(checkpoint)
      : 'retryable';
    const error = promotedRetryKeywordError(checkpoint);
    const manualSafety = crossDeviceRetryItemNeedsManualSafety({
      error,
      metadata: {checkpoint},
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
    return {
      id: `preview:${ordinal}`,
      keyword,
      ordinal,
      status,
      error,
      metadata: {checkpoint, promotedFromSingleNodeTask: true},
    };
  }).filter(item => classifyCaptureRecoveryDisposition(item).automatic);
  return {
    planSnapshot: normalized.planSnapshot,
    retryItems: automatic ? retryItems.slice(0, 1) : retryItems,
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
  expectedSearches = 1,
) {
  const authExpired = agent?.auth_code_expires_at &&
    new Date(agent.auth_code_expires_at) < new Date();
  return Boolean(agent) &&
    agent.status === 'active' &&
    agent.tenant_status === 'active' &&
    agent.auth_code_status === 'active' &&
    Boolean(agent.active_auth_binding_id) &&
    !authExpired &&
    captureAgentFullHeartbeatOnline(agent) &&
    crossDeviceRetryAgentDailyUsageEligible(agent, expectedSearches) &&
    crossDeviceRetryAgentSupportsTask(agent, task, commandPayload);
}

async function findIdleCrossDeviceRetryAgents(tx, {
  tenantId,
  task,
  sourceAgentIds = [],
  commandPayload = {},
  safetyHandoffPolicy = null,
  expectedSearches = 1,
}) {
  const platform = text(task.platform, 40).toLowerCase();
  if (!['xiaohongshu', 'douyin', 'weibo'].includes(platform)) return [];
  const excludedIds = sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value));
  const taskMetadata = safeJson(task.metadata);
  const resourcePolicy = captureTaskResourcePolicy(task);
  const allowedAgentIds = captureResourceAgentIds({
    eligibleAgentIds: taskMetadata.eligibleAgentIds,
    resourcePolicy,
  });
  if (
    taskMetadata.distributionMode === 'elastic_pool' &&
    allowedAgentIds.length === 0
  ) {
    return [];
  }
  // Agent usage remains authoritative even when account identity is absent.
  // A current account contributes only its configured hard search limit.
  const candidates = await tx.queryAll(`
    SELECT ca.*, tenant.status AS tenant_status,
      ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id,
      COALESCE(
        daily_usage.usage_date =
          (now() AT TIME ZONE 'Asia/Shanghai')::date,
        true
      ) AS today_usage_current,
      COALESCE(daily_usage.searches, 0)::integer AS today_searches,
      daily_usage.last_event_at AS today_usage_last_event_at,
      current_social_account.daily_search_limit,
      current_social_account.platform_account_id,
      current_social_binding.last_login_state,
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
    LEFT JOIN social_agent_daily_usage daily_usage
      ON daily_usage.tenant_id = ca.tenant_id
      AND daily_usage.agent_id = ca.id
      AND daily_usage.platform = $5
      AND daily_usage.usage_date =
        (now() AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN social_account_bindings current_social_binding
      ON current_social_binding.tenant_id = ca.tenant_id
      AND current_social_binding.agent_id = ca.id
      AND current_social_binding.platform = $5
      AND current_social_binding.status = 'current'
    LEFT JOIN social_accounts current_social_account
      ON current_social_account.tenant_id = ca.tenant_id
      AND current_social_account.id =
        current_social_binding.social_account_id
    WHERE ca.tenant_id = $1
      AND ca.status = 'active'
      AND NOT (ca.id = ANY($2::uuid[]))
      AND (cardinality($6::uuid[]) = 0 OR ca.id = ANY($6::uuid[]))
      AND (
        current_social_account.daily_search_limit IS NULL OR
        current_social_account.daily_search_limit = 0 OR
        COALESCE(daily_usage.searches, 0) + $7::integer <=
          current_social_account.daily_search_limit
      )
    ORDER BY COALESCE(daily_usage.searches, 0) ASC,
      recent_technical_failure_count ASC,
      recent_success_count DESC,
      last_assignment_at ASC NULLS FIRST,
      ca.last_heartbeat_at DESC NULLS LAST,
      ca.id
  `, [
    tenantId,
    excludedIds,
    task.id,
    CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
    platform,
    allowedAgentIds,
    Math.max(0, Math.floor(Number(expectedSearches) || 0)),
  ]);
  return candidates.filter(agent => {
    const safetyEligible = !safetyHandoffPolicy ||
      evaluateCaptureSafetyHandoff({
        ...safetyHandoffPolicy,
        targetPlatformAccountId: agent.platform_account_id,
        targetLoginState: agent.last_login_state,
      }).automaticEligible === true;
    return crossDeviceRetryAgentEligible(
      agent,
      task,
      commandPayload,
      expectedSearches,
    ) &&
      safetyEligible &&
      Number(agent.active_task_count || 0) === 0 &&
      Number(agent.active_command_count || 0) === 0;
  });
}

async function lockIdleCrossDeviceRetryAgent(tx, {
  tenantId,
  candidates = [],
  task,
  sourceAgentIds = [],
  commandPayload = {},
  safetyHandoffPolicy = null,
  expectedSearches = 1,
}) {
  const platform = text(task.platform, 40).toLowerCase();
  const taskMetadata = safeJson(task.metadata);
  const resourcePolicy = captureTaskResourcePolicy(task);
  const allowedAgentIds = captureResourceAgentIds({
    eligibleAgentIds: taskMetadata.eligibleAgentIds,
    resourcePolicy,
  });
  const excludedIds = new Set(sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value)));
  for (const candidate of candidates) {
    const savepoint = 'capture_retry_agent_candidate';
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
      const locked = await tx.queryOne(`
        SELECT ca.*, tenant.status AS tenant_status,
          ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id,
          COALESCE(
            daily_usage.usage_date =
              (now() AT TIME ZONE 'Asia/Shanghai')::date,
            true
          ) AS today_usage_current,
          COALESCE(daily_usage.searches, 0)::integer AS today_searches,
          daily_usage.last_event_at AS today_usage_last_event_at,
          current_social_account.daily_search_limit,
          current_social_account.platform_account_id,
          current_social_binding.last_login_state
        FROM capture_agents ca
        JOIN tenants tenant ON tenant.id = ca.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        LEFT JOIN social_agent_daily_usage daily_usage
          ON daily_usage.tenant_id = ca.tenant_id
          AND daily_usage.agent_id = ca.id
          AND daily_usage.platform = $3
          AND daily_usage.usage_date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
        LEFT JOIN social_account_bindings current_social_binding
          ON current_social_binding.tenant_id = ca.tenant_id
          AND current_social_binding.agent_id = ca.id
          AND current_social_binding.platform = $3
          AND current_social_binding.status = 'current'
        LEFT JOIN social_accounts current_social_account
          ON current_social_account.tenant_id = ca.tenant_id
          AND current_social_account.id =
            current_social_binding.social_account_id
        WHERE ca.id = $1 AND ca.tenant_id = $2
          AND (cardinality($4::uuid[]) = 0 OR ca.id = ANY($4::uuid[]))
          AND (
            current_social_account.daily_search_limit IS NULL OR
            current_social_account.daily_search_limit = 0 OR
            COALESCE(daily_usage.searches, 0) + $5::integer <=
              current_social_account.daily_search_limit
          )
        FOR UPDATE OF ca
      `, [
        candidate.id,
        tenantId,
        platform,
        allowedAgentIds,
        Math.max(0, Math.floor(Number(expectedSearches) || 0)),
      ]);
      let eligible = !excludedIds.has(
        text(locked?.id, 100).toLowerCase(),
      ) && crossDeviceRetryAgentEligible(
        locked,
        task,
        commandPayload,
        expectedSearches,
      );
      if (eligible && safetyHandoffPolicy) {
        const lockedAccount = await tx.queryOne(`
          SELECT binding.last_login_state, account.platform_account_id
          FROM social_account_bindings binding
          JOIN social_accounts account
            ON account.tenant_id = binding.tenant_id
            AND account.id = binding.social_account_id
          WHERE binding.tenant_id = $1
            AND binding.agent_id = $2
            AND binding.platform = $3
            AND binding.status = 'current'
          FOR SHARE OF binding, account
        `, [tenantId, locked.id, platform]);
        eligible = evaluateCaptureSafetyHandoff({
          ...safetyHandoffPolicy,
          targetPlatformAccountId: lockedAccount?.platform_account_id,
          targetLoginState: lockedAccount?.last_login_state,
        }).automaticEligible === true;
      }
      const busy = eligible
        ? await findCaptureAgentExecutionSlotBlocker(
            tx,
            tenantId,
            locked.id,
            {excludeTaskIds: [task.id]},
          )
        : {kind: 'ineligible'};
      const resourceAdmission = eligible && !busy
        ? await reserveCaptureResourceAdmission(tx, {
            tenantId,
            parentTaskId: task.id,
            agent: locked,
            platform,
            resourcePolicy,
            expectedSearches,
          })
        : {allowed: false, reason: 'agent_busy'};
      if (
        !eligible ||
        busy ||
        !resourceAdmission.allowed
      ) {
        // Rolling back to the per-candidate savepoint releases both its row
        // lock and its transaction-level advisory lock before trying the next
        // idle browser. Locks acquired by the surrounding dispatch remain.
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

async function lockedCrossDeviceRetryAgentStillEligible(tx, {
  tenantId,
  agent,
  task,
  sourceAgentIds = [],
  commandPayload = {},
  safetyHandoffPolicy = null,
  expectedSearches = 1,
}) {
  const excludedIds = new Set(sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value)));
  if (
    excludedIds.has(text(agent?.id, 100).toLowerCase()) ||
    !crossDeviceRetryAgentEligible(
      agent,
      task,
      commandPayload,
      expectedSearches,
    )
  ) {
    return false;
  }
  if (safetyHandoffPolicy) {
    const lockedAccount = await tx.queryOne(`
      SELECT binding.last_login_state, account.platform_account_id
      FROM social_account_bindings binding
      JOIN social_accounts account
        ON account.tenant_id = binding.tenant_id
        AND account.id = binding.social_account_id
      WHERE binding.tenant_id = $1
        AND binding.agent_id = $2
        AND binding.platform = $3
        AND binding.status = 'current'
      FOR SHARE OF binding, account
    `, [tenantId, agent.id, text(task.platform, 40).toLowerCase()]);
    if (!evaluateCaptureSafetyHandoff({
      ...safetyHandoffPolicy,
      targetPlatformAccountId: lockedAccount?.platform_account_id,
      targetLoginState: lockedAccount?.last_login_state,
    }).automaticEligible) {
      return false;
    }
  }
  const busy = await findCaptureAgentExecutionSlotBlocker(
    tx,
    tenantId,
    agent.id,
    {excludeTaskIds: [task.id]},
  );
  if (busy) return false;
  const resourceAdmission = await reserveCaptureResourceAdmission(tx, {
    tenantId,
    parentTaskId: task.id,
    agent,
    platform: text(task.platform, 40).toLowerCase(),
    resourcePolicy: captureTaskResourcePolicy(task),
    expectedSearches,
  });
  return resourceAdmission.allowed === true;
}

async function loadCrossDeviceRetryItemSelection(tx, {
  tenantId,
  parentTaskId,
  automatic,
  itemScopeProvided = false,
  requestedItemIds = [],
  dutyRecovery = false,
  safetyHandoffPolicy = null,
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
  const scopedItems = itemScopeProvided
    ? items.filter(item => requestedItemIds.includes(
        text(item.id, 100).toLowerCase(),
      ))
    : items;
  if (itemScopeProvided && scopedItems.length !== requestedItemIds.length) {
    return {
      error: dutyRecovery
        ? 'duty_recovery_source_superseded'
        : 'retry_items_unavailable',
      details: dutyRecovery
        ? {code: 'RECOVERY_SOURCE_SUPERSEDED', reason: 'item_scope_changed'}
        : {},
      items,
      scopedItems,
      retryItems: [],
      sourceExecutionTaskIds: [],
    };
  }
  let retryItems = scopedItems.filter(
    item => safetyHandoffPolicy
      ? text(item.id, 100).toLowerCase() === requestedItemIds[0]
      : dutyRecovery
        ? classifyCaptureRecoveryDisposition(item, {phase: 'duty'}).automatic
        : classifyCaptureRecoveryDisposition(item).automatic,
  );
  let sourceExecutionPending = false;
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
        const sourceSettled = !executionTaskId ||
          CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES.has(
            sourceStatusById.get(executionTaskId),
          );
        if (!sourceSettled) sourceExecutionPending = true;
        return sourceSettled;
      })
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
      .slice(0, 1);
  }
  if (retryItems.length === 0) {
    if (dutyRecovery && sourceExecutionPending) {
      return {
        error: 'duty_recovery_source_execution_active',
        details: {code: 'SOURCE_EXECUTION_ACTIVE', waitingForSource: true},
        items,
        scopedItems,
        retryItems: [],
        sourceExecutionTaskIds: [],
      };
    }
    const hasManualSafetyItem = scopedItems.some(item =>
      (dutyRecovery
        ? classifyCaptureRecoveryDisposition(item, {phase: 'duty'})
        : classifyCaptureRecoveryDisposition(item)).kind === 'manual_current'
    );
    return {
      error: hasManualSafetyItem
        ? 'retry_requires_manual_safety_action'
        : scopedItems.length > 0
          ? 'retry_items_not_automatically_recoverable'
          : 'retry_items_unavailable',
      items,
      scopedItems,
      retryItems: [],
      sourceExecutionTaskIds: [],
    };
  }
  return {
    items,
    scopedItems,
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
    SELECT id, item_id, execution_task_id, agent_id, attempt_number,
      assignment_revision, status, request_hash, checkpoint, error,
      started_at, finished_at
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
    Number(item.safety_handoff_count || 0),
    text(item.request_hash, 100),
    JSON.stringify(safeJson(item.error)),
    JSON.stringify(safeJson(item.metadata)),
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
    text(attempt.execution_task_id, 100),
    text(attempt.request_hash, 100),
    JSON.stringify(safeJson(attempt.checkpoint)),
    JSON.stringify(safeJson(attempt.error)),
    attempt.started_at ? new Date(attempt.started_at).toISOString() : '',
    attempt.finished_at ? new Date(attempt.finished_at).toISOString() : '',
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
  const profileItems = [];
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
    const previousExecutionId = text(metadata.monitorExecutionId, 100);
    profileItems.push({
      index,
      item,
      subscriptionId,
      previousExecutionId: UUID_PATTERN.test(previousExecutionId)
        ? previousExecutionId
        : '',
    });
  }
  if (profileItems.length === 0) return {executionIdByItem};

  // Every Profile entry point now uses one blocking order: Agent slot/row,
  // then subscriptions in stable ID order, then prior executions in stable
  // ID order. This transaction already holds the Agent and retry lineage
  // fences before entering this function.
  const subscriptionIds = [...new Set(
    profileItems.map(entry => entry.subscriptionId),
  )].sort();
  const subscriptions = await tx.queryAll(`
      SELECT id, status
      FROM monitor_subscriptions
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE
    `, [tenantId, subscriptionIds]);
  if (
    subscriptions.length !== subscriptionIds.length ||
    subscriptions.some(subscription => subscription.status !== 'active')
  ) {
    return {error: 'retry_profile_subscription_unavailable'};
  }

  const previousExecutionIds = [...new Set(
    profileItems
      .map(entry => entry.previousExecutionId)
      .filter(Boolean),
  )].sort();
  const previousExecutions = previousExecutionIds.length > 0
    ? await tx.queryAll(`
        SELECT id, status
        FROM monitor_executions
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE
      `, [tenantId, previousExecutionIds])
    : [];
  const activePreviousExecutionIds = previousExecutions
    .filter(execution => ['pending', 'running'].includes(execution.status))
    .map(execution => execution.id);
  if (activePreviousExecutionIds.length > 0) {
    await tx.execute(`
      UPDATE monitor_executions
      SET status = 'failed',
        error_message =
          '原设备任务已结束，未完成账号已转交其他设备重试',
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        AND status IN ('pending', 'running')
    `, [tenantId, activePreviousExecutionIds]);
  }

  for (const entry of profileItems) {
    const execution = await tx.queryOne(`
      INSERT INTO monitor_executions (tenant_id, subscription_id, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (subscription_id)
        WHERE status IN ('pending', 'running')
      DO NOTHING
      RETURNING id
    `, [tenantId, entry.subscriptionId]);
    if (!execution) {
      return {error: 'retry_profile_execution_busy'};
    }
    executionIdByItem.set(String(entry.item.id), execution.id);
    targets[entry.index] = {
      ...targets[entry.index],
      subscriptionId: entry.subscriptionId,
      recordId: entry.subscriptionId,
      externalId: entry.subscriptionId,
      executionId: execution.id,
    };
  }
  return {executionIdByItem};
}
export async function dispatchCrossDeviceRetry(options = {}) {
  const {
    tenantId,
    taskId,
    requestKey,
    expectedRevision,
    actorType = 'system',
    requestedByUserId = '',
    requestedByName = '自动调度中心',
    automatic = false,
    recoveryPhase = 'fast',
    itemIds = null,
    dutyRecoveryIntentId = '',
    dutyRecoveryLeaseToken = '',
    dutyRecoveryGeneration = 0,
    expectedItemRevision,
    expectedSourceAttemptId,
    expectedAttemptNumber,
    allowPreviouslyAttemptedAgents = false,
    safetyHandoff = null,
  } = options;
  if (!['fast', 'duty'].includes(recoveryPhase)) {
    return {error: 'invalid_recovery_phase'};
  }
  const dutyRecovery = recoveryPhase === 'duty';
  const safetyHandoffRequested = safetyHandoff !== null &&
    safetyHandoff !== undefined;
  const safetyHandoffRequest = safeJson(safetyHandoff);
  const requestedItemIds = Array.isArray(itemIds)
    ? Array.from(new Set(
        itemIds
          .map(value => text(value, 100).toLowerCase())
          .filter(Boolean),
      ))
    : [];
  const itemScopeProvided = itemIds !== null && itemIds !== undefined;
  if (
    itemScopeProvided &&
    (
      !Array.isArray(itemIds) ||
      requestedItemIds.length !== itemIds.length ||
      requestedItemIds.some(value => !UUID_PATTERN.test(value))
    )
  ) {
    return {error: 'invalid_retry_item_scope'};
  }
  if (
    dutyRecovery &&
    (
      automatic !== true ||
      requestedItemIds.length !== 1 ||
      !UUID_PATTERN.test(text(tenantId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(taskId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(requestKey, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(dutyRecoveryIntentId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(dutyRecoveryLeaseToken, 100).toLowerCase()) ||
      text(dutyRecoveryIntentId, 100).toLowerCase() !==
        text(requestKey, 100).toLowerCase() ||
      !Number.isSafeInteger(Number(dutyRecoveryGeneration)) ||
      Number(dutyRecoveryGeneration) < 1 ||
      Number(dutyRecoveryGeneration) > 1 ||
      !Number.isSafeInteger(Number(expectedRevision)) ||
      Number(expectedRevision) < 0 ||
      !Number.isSafeInteger(Number(expectedItemRevision)) ||
      Number(expectedItemRevision) < 0 ||
      !Number.isSafeInteger(Number(expectedAttemptNumber)) ||
      Number(expectedAttemptNumber) < 0 ||
      typeof allowPreviouslyAttemptedAgents !== 'boolean' ||
      !(
        expectedSourceAttemptId == null ||
        text(expectedSourceAttemptId, 100) === '' ||
        UUID_PATTERN.test(text(expectedSourceAttemptId, 100).toLowerCase())
      )
    )
  ) {
    return {error: 'invalid_duty_recovery_request'};
  }
  if (!dutyRecovery && allowPreviouslyAttemptedAgents === true) {
    return {error: 'invalid_duty_recovery_request'};
  }
  if (
    safetyHandoffRequested &&
    (
      !dutyRecovery ||
      !Number.isSafeInteger(Number(safetyHandoffRequest.count)) ||
      Number(safetyHandoffRequest.count) < 0 ||
      safetyHandoffRequest.requireDistinctPlatformAccount !== true ||
      safetyHandoffRequest.requireSourceLineageQuiet !== true ||
      !text(safetyHandoffRequest.challengeCode, 100) ||
      !text(safetyHandoffRequest.sourcePlatformAccountId, 320) ||
      text(safetyHandoffRequest.sourceLoginState, 40).toLowerCase() !==
        'authenticated'
    )
  ) {
    return {error: 'invalid_duty_recovery_request'};
  }
  // Local-closure evidence is retained in the request for audit only. Source
  // execution/command settlement and assignment lineage are the dispatch
  // authority; missing browser telemetry is never a human-action boundary.
  const dutyIntentId = dutyRecovery
    ? text(dutyRecoveryIntentId, 100).toLowerCase()
    : '';
  const dutyGeneration = dutyRecovery
    ? Number(dutyRecoveryGeneration)
    : 0;
  const noIdleAgentResult = () => dutyRecovery
    ? {
        error: 'idle_compatible_agent_unavailable',
        code: 'NO_IDLE_AGENT',
        waitingForAgent: true,
      }
    : {error: 'idle_compatible_agent_unavailable'};
  const supersededResult = details => ({
    error: 'duty_recovery_source_superseded',
    code: 'RECOVERY_SOURCE_SUPERSEDED',
    superseded: true,
    ...details,
  });
  const itemAttemptEvidence = attempt => ({
    id: text(attempt?.id, 100).toLowerCase(),
    itemId: text(attempt?.item_id || attempt?.itemId, 100).toLowerCase(),
    executionTaskId: text(
      attempt?.execution_task_id || attempt?.executionTaskId,
      100,
    ).toLowerCase(),
    agentId: text(attempt?.agent_id || attempt?.agentId, 100).toLowerCase(),
    attemptNumber: Number(
      attempt?.attempt_number ?? attempt?.attemptNumber ?? 0,
    ),
    assignmentRevision: Number(
      attempt?.assignment_revision ?? attempt?.assignmentRevision ?? 0,
    ),
    status: text(attempt?.status, 80).toLowerCase(),
    requestHash: text(
      attempt?.request_hash || attempt?.requestHash,
      100,
    ).toLowerCase(),
  });
  const req = {
    tenantId,
    user: requestedByUserId ? {id: requestedByUserId} : null,
    actorName: requestedByName,
  };
  try {
    return await withTransaction(async tx => {
      let dutySafetyHandoffPolicy = null;
      let dutySourceItemFence = null;
      let dutySourceAttemptFence = null;
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
          replayMetadata.crossDeviceRetryRequestKey !== requestKey ||
          (
            dutyRecovery &&
            (
              replayMetadata.dutyRecovery !== true ||
              replayMetadata.dutyRecoveryIntentId !== dutyIntentId ||
              Number(replayMetadata.dutyRecoveryGeneration || 0) !==
                dutyGeneration ||
              !Array.isArray(replayMetadata.itemIds) ||
              replayMetadata.itemIds.length !== 1 ||
              text(replayMetadata.itemIds[0], 100).toLowerCase() !==
                requestedItemIds[0] ||
              (replayMetadata.safetyHandoff === true) !==
                safetyHandoffRequested
            )
          )
        ) {
          return {error: 'idempotency_key_conflict'};
        }
        const command = await tx.queryOne(`
          SELECT id, status, expires_at
          FROM capture_agent_commands
          WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `, [req.tenantId, replay.id]);
        const itemAttempts = await tx.queryAll(`
          SELECT id, item_id, execution_task_id, agent_id,
            attempt_number, assignment_revision, status, request_hash
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND execution_task_id = $2
            AND (
              cardinality($3::uuid[]) = 0 OR item_id = ANY($3::uuid[])
            )
          ORDER BY attempt_number, item_id, id
        `, [req.tenantId, replay.id, requestedItemIds]);
        const parent = await tx.queryOne(`
          SELECT id, status, orchestration_revision
          FROM capture_tasks
          WHERE tenant_id = $1 AND id = $2
        `, [req.tenantId, replay.parent_task_id]);
        return {
          existing: true,
          replayed: true,
          child: replay,
          command,
          agent: replay.assigned_agent_id
            ? {id: replay.assigned_agent_id}
            : null,
          parent,
          itemAttempts: itemAttempts.map(itemAttemptEvidence),
          itemCount: itemAttempts.length,
          targetAgentId: replay.assigned_agent_id || '',
          recovery: dutyRecovery
            ? {phase: 'duty', intentId: dutyIntentId, generation: dutyGeneration}
            : {phase: 'fast'},
        };
      }

      if (dutyRecovery) {
        if (!dutyRecoveryGlobalActionsEnabled()) {
          return {error: 'automatic_retry_disabled', code: 'RECOVERY_GATE_OFF'};
        }
        const recoverySettings = await tx.queryAll(`
          SELECT key, value
          FROM tenant_settings
          WHERE tenant_id = $1 AND key = ANY($2::text[])
          ORDER BY key
          FOR SHARE
        `, [req.tenantId, DUTY_RECOVERY_SETTING_KEYS]);
        const recoverySettingMap = Object.fromEntries(
          recoverySettings.map(row => [text(row.key, 120), text(row.value, 120)]),
        );
        if (
          !DUTY_RECOVERY_TRUE_VALUES.has(
            text(
              recoverySettingMap.ops_control_recovery_enabled,
              20,
            ).toLowerCase(),
          )
          || text(
            recoverySettingMap.ops_control_recovery_mode,
            20,
          ).toLowerCase() !== 'guarded'
        ) {
          return {error: 'automatic_retry_disabled', code: 'RECOVERY_GATE_OFF'};
        }
      }

      const initialTask = await tx.queryOne(`
        SELECT *
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
      `, [taskId, req.tenantId]);
      if (!initialTask) return {error: 'task_not_found'};
      if (
        dutyRecovery &&
        (
          ['canceled', 'skipped', 'superseded'].includes(initialTask.status) ||
          isExplicitUserCancellationSnapshot(initialTask, {
            status: initialTask.status,
            error: initialTask.error,
            metadata: initialTask.metadata,
          })
        )
      ) {
        return {
          error: 'retry_items_not_automatically_recoverable',
          code: 'SOURCE_STOPPED_BY_USER',
          stoppedByUser: true,
        };
      }
      if (dutyRecovery) {
        // Parent-scoped control paths are already serialized above. Claim the
        // durable recovery intent without locking the parent/item rows before
        // the target Agent slot; the task and source fences are re-read later.
        const durableIntent = await tx.queryOne(`
          SELECT id, parent_task_id, item_id, generation, created_at,
            status, action_count, recovery_task_id, dispatched_attempt_id,
            safety_handoff_count, source_lineage_silent,
            lease_token, lease_expires_at, available_at, window_ends_at,
            CASE
              WHEN verification->>'reuseEligibleAt' ~
                '^\\d{4}-\\d{2}-\\d{2}T'
              THEN (verification->>'reuseEligibleAt')::timestamptz
              ELSE created_at + interval '10 minutes'
            END AS reuse_eligible_at
          FROM capture_recovery_intents
          WHERE id = $1::uuid
            AND tenant_id = $2
            AND parent_task_id = $3::uuid
            AND item_id = $4::uuid
            AND generation = $5::integer
          FOR UPDATE
        `, [
          dutyIntentId,
          req.tenantId,
          taskId,
          requestedItemIds[0],
          dutyGeneration,
        ]);
        const actionClock = durableIntent ? await tx.queryOne(`
          WITH action_clock AS (
            SELECT clock_timestamp() AS action_time
          )
          SELECT action_time,
            $1::timestamptz > action_time AS lease_valid,
            $2::timestamptz <= action_time AS intent_due,
            $3::timestamptz > action_time AS window_open,
            $4::timestamptz <= action_time AS reuse_due
          FROM action_clock
        `, [
          durableIntent.lease_expires_at,
          durableIntent.available_at,
          durableIntent.window_ends_at,
          durableIntent.reuse_eligible_at,
        ]) : null;
        const durableLeaseMatches = Boolean(
          durableIntent
          && text(durableIntent.lease_token, 100).toLowerCase() ===
            text(dutyRecoveryLeaseToken, 100).toLowerCase()
        );
        if (durableIntent && actionClock?.window_open !== true) {
          return {
            error: 'recovery_window_ended',
            code: 'RECOVERY_WINDOW_ENDED',
          };
        }
        if (durableLeaseMatches && actionClock?.lease_valid !== true) {
          return {
            error: 'duty_recovery_lease_expired',
            code: 'RECOVERY_LEASE_EXPIRED',
          };
        }
        if (durableLeaseMatches && actionClock?.intent_due !== true) {
          return {
            error: 'duty_recovery_not_due',
            code: 'RECOVERY_INTENT_NOT_DUE',
          };
        }
        if (
          !durableIntent
          || !durableLeaseMatches
          || Number(durableIntent.action_count || 0) !== 0
          || durableIntent.recovery_task_id
          || durableIntent.dispatched_attempt_id
          || (
            safetyHandoffRequested &&
            (
              Number(durableIntent.safety_handoff_count || 0) !== 0 ||
              durableIntent.source_lineage_silent !== false
            )
          )
          || (
            !safetyHandoffRequested &&
            durableIntent.source_lineage_silent === true
          )
          || !['ready', 'waiting_due', 'waiting_agent'].includes(
            text(durableIntent.status, 80).toLowerCase(),
          )
        ) {
          return {error: 'invalid_duty_recovery_request'};
        }
        if (
          allowPreviouslyAttemptedAgents
          && actionClock.reuse_due !== true
        ) {
          return {
            error: 'duty_recovery_agent_reuse_not_due',
            code: 'AGENT_REUSE_BACKOFF_ACTIVE',
          };
        }
      }
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
      if (!crossDeviceRetrySourceReady(initialTask, {
        automatic,
        dutyRecovery,
      })) {
        return {error: 'task_not_settled_for_retry'};
      }
      if (Number(initialTask.orchestration_revision || 0) !== expectedRevision) {
        return {
          error: 'revision_conflict',
          currentRevision: Number(initialTask.orchestration_revision || 0),
        };
      }
      if (dutyRecovery) {
        const sourceItem = await tx.queryOne(`
          SELECT *
          FROM capture_task_items
          WHERE id = $1 AND tenant_id = $2 AND task_id = $3
        `, [requestedItemIds[0], req.tenantId, initialTask.id]);
        if (!sourceItem) {
          return supersededResult({reason: 'item_scope_changed'});
        }
        const currentSourceAttempt = await tx.queryOne(`
          SELECT id, item_id, execution_task_id, agent_id, attempt_number,
            assignment_revision, status, request_hash, checkpoint, error,
            started_at, finished_at
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND item_id = $2
          ORDER BY attempt_number DESC, created_at DESC, id DESC
          LIMIT 1
        `, [req.tenantId, sourceItem.id]);
        dutySourceItemFence = crossDeviceRetryItemFence([sourceItem]);
        dutySourceAttemptFence = currentSourceAttempt
          ? crossDeviceRetryAttemptFence([currentSourceAttempt])
          : [];
        const currentSourceAttemptId = text(
          currentSourceAttempt?.id,
          100,
        ).toLowerCase();
        const normalizedExpectedSourceAttemptId = text(
          expectedSourceAttemptId,
          100,
        ).toLowerCase();
        if (
          Number(sourceItem.assignment_revision || 0) !==
            Number(expectedItemRevision) ||
          currentSourceAttemptId !== normalizedExpectedSourceAttemptId ||
          Number(
            currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count ?? 0,
          ) !== Number(expectedAttemptNumber)
        ) {
          return supersededResult({
            reason: 'source_attempt_changed',
            currentItemRevision: Number(sourceItem.assignment_revision || 0),
            currentSourceAttemptId,
            currentAttemptNumber: Number(
              currentSourceAttempt?.attempt_number ??
                sourceItem.attempt_count ??
                0,
            ),
          });
        }
        const sourceAttemptNumber = Math.max(
          0,
          Number(currentSourceAttempt?.attempt_number) || 0,
          Number(sourceItem.attempt_count) || 0,
        );
        if (
          sourceAttemptNumber >= AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT
        ) {
          return {
            error: 'retry_items_not_automatically_recoverable',
            code: 'AUTOMATIC_ATTEMPT_LIMIT_REACHED',
            humanRequired: true,
          };
        }
        const sourceDisposition = classifyCaptureRecoveryDisposition(
          {
            ...sourceItem,
            error: {
              ...safeJson(sourceItem.error),
              ...safeJson(currentSourceAttempt?.error),
            },
            metadata: {
              ...safeJson(sourceItem.metadata),
              checkpoint: {
                ...safeJson(safeJson(sourceItem.metadata).checkpoint),
                ...safeJson(currentSourceAttempt?.checkpoint),
              },
            },
          },
          {phase: 'duty'},
        );
        if (safetyHandoffRequested) {
          const sourceAccount = await tx.queryOne(`
            SELECT binding.last_login_state, account.platform_account_id
            FROM social_account_bindings binding
            JOIN social_accounts account
              ON account.tenant_id = binding.tenant_id
              AND account.id = binding.social_account_id
            WHERE binding.tenant_id = $1
              AND binding.agent_id = $2
              AND binding.platform = $3
              AND binding.status = 'current'
            FOR SHARE OF binding, account
          `, [
            req.tenantId,
            currentSourceAttempt?.agent_id || sourceItem.assigned_agent_id,
            text(sourceItem.platform || initialTask.platform, 40).toLowerCase(),
          ]);
          const mergedError = {
            ...safeJson(sourceItem.error),
            ...safeJson(currentSourceAttempt?.error),
          };
          const mergedCheckpoint = {
            ...safeJson(safeJson(sourceItem.metadata).checkpoint),
            ...safeJson(currentSourceAttempt?.checkpoint),
          };
          const challengeCode = text(
            mergedError.code ||
              mergedCheckpoint.errorCode ||
              mergedCheckpoint.error_code,
            100,
          ).toUpperCase();
          if (
            Number(safetyHandoffRequest.count) !==
              Number(sourceItem.safety_handoff_count || 0) ||
            text(
              safetyHandoffRequest.sourcePlatformAccountId,
              320,
            ).toLowerCase() !== text(
              sourceAccount?.platform_account_id,
              320,
            ).toLowerCase() ||
            text(safetyHandoffRequest.challengeCode, 100).toUpperCase() !==
              challengeCode
          ) {
            return supersededResult({reason: 'safety_handoff_source_changed'});
          }
          const sourceAgentId = text(
            currentSourceAttempt?.agent_id || sourceItem.assigned_agent_id,
            100,
          ).toLowerCase();
          const localClosureProof = await loadVerifiedCaptureLocalClosureProof(
            tx,
            {
              tenantId: req.tenantId,
              executionTaskId: sourceItem.execution_task_id,
              sourceAgentId,
              itemId: sourceItem.id,
              itemAttemptId: currentSourceAttemptId,
              itemAttemptNumber:
                currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count,
              assignmentRevision: sourceItem.assignment_revision,
            },
          );
          const safetyDecision = evaluateCaptureSafetyHandoff({
            faultClass: 'platform_safety',
            challengeCode,
            platform: sourceItem.platform || initialTask.platform,
            businessTaskType: promotedRetryBusinessTaskType(initialTask),
            itemType: sourceItem.item_type,
            safetyHandoffCount: sourceItem.safety_handoff_count,
            sourcePlatformAccountId: sourceAccount?.platform_account_id,
            sourceLoginState: sourceAccount?.last_login_state,
            sourceLocalClosureProven: localClosureProof.proven === true,
          });
          if (!safetyDecision.automaticEligible) {
            return {
              error: 'retry_requires_manual_safety_action',
              code: 'HUMAN_REQUIRED',
              humanRequired: true,
              reason: safetyDecision.reason,
            };
          }
          dutySafetyHandoffPolicy = {
            faultClass: 'platform_safety',
            challengeCode,
            platform: sourceItem.platform || initialTask.platform,
            businessTaskType: promotedRetryBusinessTaskType(initialTask),
            itemType: sourceItem.item_type,
            safetyHandoffCount: sourceItem.safety_handoff_count,
            sourcePlatformAccountId: sourceAccount.platform_account_id,
            sourceLoginState: sourceAccount.last_login_state,
            sourceLocalClosureProven: localClosureProof.proven === true,
            sourceExecutionTaskId: sourceItem.execution_task_id,
            sourceAgentId,
            sourceItemId: sourceItem.id,
            sourceItemAttemptId: currentSourceAttemptId,
            sourceItemAttemptNumber: Number(
              currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count,
            ),
            sourceAssignmentRevision: Number(
              sourceItem.assignment_revision,
            ),
          };
        } else if (!sourceDisposition.automatic) {
          if (sourceDisposition.kind === 'manual_current') {
            return {
              error: 'retry_requires_manual_safety_action',
              code: 'HUMAN_REQUIRED',
              humanRequired: true,
            };
          }
          return {
            error: 'retry_items_not_automatically_recoverable',
            code: sourceDisposition.kind === 'terminal_business_failure'
              ? 'TERMINAL_BUSINESS_FAILURE'
              : 'ITEM_NOT_RECOVERABLE',
          };
        }
      }

      const sourceCommand = await tx.queryOne(`
        SELECT payload
        FROM capture_agent_commands
        WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [req.tenantId, initialTask.id]);
      const sourceCommandPayload = safeJson(sourceCommand?.payload);
      const previewBusinessTaskType = promotedRetryBusinessTaskType(initialTask);
      const previewParentMetadata = safeJson(initialTask.metadata);
      const previewParentPlanSnapshot = safeJson(
        previewParentMetadata.planSnapshot || sourceCommandPayload.planSnapshot,
      );
      const previewRetryDistributionMode =
        ['elastic_pool', 'fixed_batch'].includes(
          text(previewParentMetadata.distributionMode, 40),
        )
          ? text(previewParentMetadata.distributionMode, 40)
          : '';
      const previewElasticKeywordRetry =
        previewBusinessTaskType === 'unattended_keyword_capture' &&
        previewRetryDistributionMode === 'elastic_pool';
      const previewRetryPlanSnapshot = previewElasticKeywordRetry
        ? {
            ...previewParentPlanSnapshot,
            recoveryPolicy: {
              ...safeJson(previewParentPlanSnapshot.recoveryPolicy),
              singleRelayV1: true,
              disableAutomaticSearchRetry: true,
            },
          }
        : previewParentPlanSnapshot;
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
          itemScopeProvided,
          requestedItemIds,
          dutyRecovery,
          safetyHandoffPolicy: dutySafetyHandoffPolicy,
        });
        if (previewSelection.error) {
          abortCrossDeviceRetry(
            previewSelection.error,
            previewSelection.details,
          );
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

      const promotedPreview = (
        previewSelection ||
        previewBusinessTaskType !== 'unattended_keyword_capture'
      )
        ? null
        : previewPromotedRetryKeywordItems(
            initialTask,
            sourceCommandPayload,
            {automatic},
          );
      const previewRetryItems = previewSelection?.retryItems ||
        promotedPreview?.retryItems || [];
      const promotedPreviewPlanSnapshot =
        promotedPreview?.planSnapshot || previewRetryPlanSnapshot;
      const effectivePreviewRetryPlanSnapshot = previewElasticKeywordRetry
        ? {
            ...promotedPreviewPlanSnapshot,
            recoveryPolicy: {
              ...safeJson(promotedPreviewPlanSnapshot.recoveryPolicy),
              singleRelayV1: true,
              disableAutomaticSearchRetry: true,
            },
          }
        : promotedPreviewPlanSnapshot;
      const previewTaskForAgentSelection = previewElasticKeywordRetry
        ? {
            ...initialTask,
            metadata: {
              ...previewParentMetadata,
              planSnapshot: effectivePreviewRetryPlanSnapshot,
            },
          }
        : initialTask;
      const expectedPreviewRetrySearches =
        previewBusinessTaskType === 'unattended_keyword_capture'
          ? previewRetryItems.reduce((total, retryItem) => total +
              expectedElasticKeywordSearches({
                planSnapshot: effectivePreviewRetryPlanSnapshot,
                itemMetadata: retryItem.metadata,
                keyword: retryItem.keyword,
              }), 0)
          : 0;
      const previewAgentCompatibilityPayload = dutyRecovery
        ? {
            ...sourceCommandPayload,
            ...(previewElasticKeywordRetry
              ? {planSnapshot: effectivePreviewRetryPlanSnapshot}
              : {}),
            dutyRecovery: {intentId: dutyIntentId, protocolVersion: 1},
          }
        : {
            ...sourceCommandPayload,
            ...(previewElasticKeywordRetry
              ? {planSnapshot: effectivePreviewRetryPlanSnapshot}
              : {}),
          };

      const previewSourceExecutionTaskIds = previewSelection
        ? previewSelection.sourceExecutionTaskIds
        : [initialTask.id];
      const orderedPreviewSourceTaskIds = [
        ...previewSourceExecutionTaskIds,
      ].sort();
      const previewSourceTasks = orderedPreviewSourceTaskIds.length > 0
        ? await tx.queryAll(`
            SELECT id, status, metadata, started_at
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
        abortCrossDeviceRetry(
          dutyRecovery
            ? 'duty_recovery_source_execution_active'
            : 'retry_source_execution_active',
          dutyRecovery
            ? {code: 'SOURCE_EXECUTION_ACTIVE', waitingForSource: true}
            : {},
        );
      }

      // Candidate discovery is deliberately read-only. No task or item row is
      // locked until the selected Agent's execution slot and Agent row are held.
      const candidateAgents = await findIdleCrossDeviceRetryAgents(tx, {
        tenantId: req.tenantId,
        task: previewTaskForAgentSelection,
        sourceAgentIds: previewSourceAgentIds,
        commandPayload: previewAgentCompatibilityPayload,
        safetyHandoffPolicy: dutySafetyHandoffPolicy,
        expectedSearches: expectedPreviewRetrySearches,
      });
      const targetAgent = await lockIdleCrossDeviceRetryAgent(tx, {
        tenantId: req.tenantId,
        candidates: candidateAgents,
        task: previewTaskForAgentSelection,
        sourceAgentIds: previewSourceAgentIds,
        commandPayload: previewAgentCompatibilityPayload,
        safetyHandoffPolicy: dutySafetyHandoffPolicy,
        expectedSearches: expectedPreviewRetrySearches,
      });
      if (!targetAgent) {
        await expireStaleCommands(tx, req.tenantId, initialTask.id);
        return noIdleAgentResult();
      }

      // Snapshot projection and command completion lock execution children
      // before their parent. Lock only the preselected sources, in stable order,
      // before command expiry and the parent/item rows.
      const lockedSourceTasks = orderedPreviewSourceTaskIds.length > 0
        ? await tx.queryAll(`
            SELECT id, status, metadata, started_at
            FROM capture_tasks
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])
            ORDER BY id
            FOR UPDATE
          `, [req.tenantId, orderedPreviewSourceTaskIds])
        : [];
      if (!crossDeviceRetryFenceMatches(
        previewSourceTasks.map(source => [
          String(source.id),
          source.status,
          JSON.stringify(safeJson(source.metadata)),
          source.started_at ? new Date(source.started_at).toISOString() : '',
        ]),
        lockedSourceTasks.map(source => [
          String(source.id),
          source.status,
          JSON.stringify(safeJson(source.metadata)),
          source.started_at ? new Date(source.started_at).toISOString() : '',
        ]),
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
        !crossDeviceRetrySourceReady(task, {automatic, dutyRecovery})
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
      const parentMetadata = safeJson(parent.metadata);
      const parentPlanSnapshot = safeJson(parentMetadata.planSnapshot);
      const retryDistributionMode =
        ['elastic_pool', 'fixed_batch'].includes(
          text(parentMetadata.distributionMode, 40),
        )
          ? text(parentMetadata.distributionMode, 40)
          : '';
      const elasticKeywordRetry =
        businessTaskType === 'unattended_keyword_capture' &&
        retryDistributionMode === 'elastic_pool';
      const retryPlanSnapshot = elasticKeywordRetry
        ? {
            ...parentPlanSnapshot,
            recoveryPolicy: {
              ...safeJson(parentPlanSnapshot.recoveryPolicy),
              singleRelayV1: true,
              disableAutomaticSearchRetry: true,
            },
          }
        : parentPlanSnapshot;
      const retryTaskForAgentSelection = elasticKeywordRetry
        ? {
            ...parent,
            metadata: {
              ...parentMetadata,
              planSnapshot: retryPlanSnapshot,
            },
          }
        : parent;

      const lockedSelection = await loadCrossDeviceRetryItemSelection(tx, {
        tenantId: req.tenantId,
        parentTaskId: parent.id,
        automatic,
        itemScopeProvided,
        requestedItemIds,
        dutyRecovery,
        safetyHandoffPolicy: dutySafetyHandoffPolicy,
        lock: true,
      });
      if (lockedSelection.error) {
        abortCrossDeviceRetry(lockedSelection.error, lockedSelection.details);
      }
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
        if (activeSource) {
          abortCrossDeviceRetry(
            dutyRecovery
              ? 'duty_recovery_source_execution_active'
              : 'retry_source_execution_active',
            dutyRecovery
              ? {code: 'SOURCE_EXECUTION_ACTIVE', waitingForSource: true}
              : {},
          );
        }
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
        abortCrossDeviceRetry(
          dutyRecovery
            ? 'duty_recovery_source_command_active'
            : 'retry_source_command_active',
          dutyRecovery
            ? {code: 'SOURCE_COMMAND_ACTIVE', waitingForSource: true}
            : {},
        );
      }
      // Source execution and command settlement, together with exact item and
      // Attempt fences below, govern retry. Browser-local closure is telemetry.

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
      if (dutyRecovery) {
        const lockedDutySourceItem = retryItems.find(item =>
          text(item.id, 100).toLowerCase() === requestedItemIds[0]
        );
        const lockedDutySourceAttempt = await tx.queryOne(`
          SELECT id, item_id, execution_task_id, agent_id, attempt_number,
            assignment_revision, status, request_hash, checkpoint, error,
            started_at, finished_at
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND item_id = $2
          ORDER BY attempt_number DESC, created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `, [req.tenantId, requestedItemIds[0]]);
        if (
          !lockedDutySourceItem ||
          !crossDeviceRetryFenceMatches(
            dutySourceItemFence,
            crossDeviceRetryItemFence([lockedDutySourceItem]),
          ) ||
          !crossDeviceRetryFenceMatches(
            dutySourceAttemptFence,
            lockedDutySourceAttempt
              ? crossDeviceRetryAttemptFence([lockedDutySourceAttempt])
              : [],
          )
        ) {
          abortCrossDeviceRetry('duty_recovery_source_superseded', {
            code: 'RECOVERY_SOURCE_SUPERSEDED',
            reason: 'source_attempt_changed',
          });
        }
      }
      const lockedSourceAgentIds = crossDeviceRetrySourceAgentIdsForItems(
        retryItems,
        lockedAttempts,
      );
      const agentCompatibilityPayload = dutyRecovery
        ? {
            ...sourceCommandPayload,
            ...(elasticKeywordRetry
              ? {planSnapshot: retryPlanSnapshot}
              : {}),
            dutyRecovery: {intentId: dutyIntentId, protocolVersion: 1},
          }
        : {
            ...sourceCommandPayload,
            ...(elasticKeywordRetry
              ? {planSnapshot: retryPlanSnapshot}
              : {}),
          };
      const expectedRetrySearches =
        businessTaskType === 'unattended_keyword_capture'
          ? retryItems.reduce((total, retryItem) => total +
              expectedElasticKeywordSearches({
                planSnapshot: retryPlanSnapshot,
                itemMetadata: retryItem.metadata,
                keyword: retryItem.keyword,
              }), 0)
          : 0;
      if (!await lockedCrossDeviceRetryAgentStillEligible(tx, {
        tenantId: req.tenantId,
        agent: targetAgent,
        task: retryTaskForAgentSelection,
        sourceAgentIds: lockedSourceAgentIds,
        commandPayload: agentCompatibilityPayload,
        safetyHandoffPolicy: dutySafetyHandoffPolicy,
        expectedSearches: expectedRetrySearches,
      })) {
        return noIdleAgentResult();
      }

      // Agent/source/parent/item locks are now in canonical order. Finish the
      // profile authorization and execution-lineage preparation while those
      // fences remain held.
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

      const nextRevision = Number(parent.orchestration_revision || 0) + 1;
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        action: 'cross_device_retry',
        parentTaskId: parent.id,
        requestKey,
        expectedRevision,
        targetAgentId: targetAgent.id,
        itemIds: retryItems.map(item => item.id).sort(),
        recoveryPhase: dutyRecovery ? 'duty' : 'fast',
        dutyRecoveryIntentId: dutyIntentId,
        dutyRecoveryGeneration: dutyGeneration,
        safetyHandoff: Boolean(dutySafetyHandoffPolicy),
      })).digest('hex');
      const commandId = crypto.randomUUID();

      let commandPayload;
      let childPlan = {};
      let sequentialResumeCheckpoint = null;
      if (businessTaskType === 'unattended_keyword_capture') {
        const planSnapshot = retryPlanSnapshot;
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
            ...(retryDistributionMode
              ? {distributionMode: retryDistributionMode}
              : {}),
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
      if (dutyRecovery) {
        commandPayload.dutyRecovery = {
          intentId: dutyIntentId,
          generation: dutyGeneration,
          itemId: retryItems[0].id,
          sourceAttemptId: text(expectedSourceAttemptId, 100).toLowerCase(),
          sourceAssignmentRevision: Number(expectedItemRevision),
          sourceAttemptNumber: Number(expectedAttemptNumber),
        };
      }
      const childMetadata = {
        ...safeJson(parent.metadata),
        // A promoted parent may itself be a marked child. Do not inherit its
        // fence marker or stop settlement unless this successor earns it.
        requiresLocalClosureReuseFenceV1: undefined,
        stoppedBeforeDispatch: undefined,
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
        ...(dutyRecovery
          ? {
              dutyRecovery: true,
              dutyRecoveryIntentId: dutyIntentId,
              dutyRecoveryGeneration: dutyGeneration,
              dutyRecoverySourceItemId: retryItems[0].id,
              dutyRecoverySourceAttemptId:
                text(expectedSourceAttemptId, 100).toLowerCase(),
              dutyRecoverySourceAssignmentRevision:
                Number(expectedItemRevision),
              dutyRecoverySourceAttemptNumber: Number(expectedAttemptNumber),
            }
          : {}),
        ...(sequentialResumeCheckpoint
          ? {
              resumedSequentialSearch: true,
              resumeRound: sequentialResumeCheckpoint.round,
            }
          : {}),
        requestedByUserId: req.user?.id || '',
        requestedByName: text(req.actorName, 240),
      };
      if (dutyRecovery) {
        // Everything that can wait on another row/advisory lock has completed.
        // Re-check authority with PostgreSQL's wall clock immediately before
        // the first child/command write; aborting rolls back profile-renewal
        // preparation performed earlier in this transaction.
        const finalAgent = await tx.queryOne(`
          SELECT ca.*, tenant.status AS tenant_status,
            ac.status AS auth_code_status,
            ac.expires_at AS auth_code_expires_at,
            binding.id AS active_auth_binding_id,
            COALESCE(ca.last_full_heartbeat_at, ca.last_heartbeat_at) >=
              clock_timestamp() - interval '2 minutes'
              AND ca.capabilities->>'taskStateKnown' IS DISTINCT FROM 'false'
              AS heartbeat_fresh,
            (
              ac.expires_at IS NULL OR ac.expires_at > clock_timestamp()
            ) AS auth_not_expired,
            NOT EXISTS (
              SELECT 1
              FROM capture_tasks blocking_task
              WHERE blocking_task.tenant_id = ca.tenant_id
                AND COALESCE(
                  blocking_task.assigned_agent_id,
                  blocking_task.origin_agent_id
                ) = ca.id
                AND blocking_task.id <> ALL($3::uuid[])
                AND blocking_task.task_type <> 'capture_orchestration'
                AND blocking_task.status = ANY($4::text[])
            ) AND NOT EXISTS (
              SELECT 1
              FROM capture_agent_commands blocking_command
              WHERE blocking_command.tenant_id = ca.tenant_id
                AND blocking_command.agent_id = ca.id
                AND blocking_command.task_id <> ALL($3::uuid[])
                AND blocking_command.status IN ('pending', 'acknowledged')
                AND (
                  blocking_command.expires_at IS NULL
                  OR blocking_command.expires_at > clock_timestamp()
                )
            ) AS slot_clear
          FROM capture_agents ca
          JOIN tenants tenant ON tenant.id = ca.tenant_id
          JOIN auth_codes ac
            ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
          JOIN auth_bindings binding
            ON binding.id = ca.auth_binding_id AND binding.code_id = ac.id
          WHERE ca.id = $1::uuid AND ca.tenant_id = $2
          FOR SHARE OF ca, tenant, ac, binding
        `, [
          targetAgent.id,
          req.tenantId,
          [parent.id, ...sourceExecutionTaskIds],
          CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
        ]);
        if (
          !finalAgent
          || finalAgent.status !== 'active'
          || finalAgent.tenant_status !== 'active'
          || finalAgent.auth_code_status !== 'active'
          || finalAgent.heartbeat_fresh !== true
          || finalAgent.auth_not_expired !== true
          || finalAgent.slot_clear !== true
          || !crossDeviceRetryAgentSupportsTask(
            finalAgent,
            parent,
            commandPayload,
          )
        ) {
          abortCrossDeviceRetry('idle_compatible_agent_unavailable', {
            code: 'RECOVERY_AGENT_NO_LONGER_USABLE',
          });
        }
        if (dutySafetyHandoffPolicy) {
          const finalTargetAccount = await tx.queryOne(`
            SELECT binding.last_login_state, account.platform_account_id
            FROM social_account_bindings binding
            JOIN social_accounts account
              ON account.tenant_id = binding.tenant_id
              AND account.id = binding.social_account_id
            WHERE binding.tenant_id = $1
              AND binding.agent_id = $2
              AND binding.platform = $3
              AND binding.status = 'current'
            FOR SHARE OF binding, account
          `, [
            req.tenantId,
            targetAgent.id,
            text(parent.platform, 40).toLowerCase(),
          ]);
          const finalSafetyDecision = evaluateCaptureSafetyHandoff({
            ...dutySafetyHandoffPolicy,
            targetPlatformAccountId:
              finalTargetAccount?.platform_account_id,
            targetLoginState: finalTargetAccount?.last_login_state,
          });
          if (!finalSafetyDecision.automaticEligible) {
            abortCrossDeviceRetry('idle_compatible_agent_unavailable', {
              code: 'DISTINCT_AUTHENTICATED_ACCOUNT_UNAVAILABLE',
            });
          }
        }
        if (businessTaskType === 'watched_content_patrol') {
          const watchedIntent = await tx.queryOne(`
            SELECT watched.record_id
            FROM record_watchlist watched
            WHERE watched.tenant_id = $1
              AND watched.record_id = $2::uuid
            FOR SHARE
          `, [req.tenantId, retryItems[0].record_id]);
          if (!watchedIntent) {
            abortCrossDeviceRetry('duty_recovery_source_superseded', {
              code: 'WATCHLIST_INTENT_REMOVED',
            });
          }
        }
        const finalFence = await tx.queryOne(`
          SELECT
            lease_token = $3::uuid AS lease_matches,
            lease_expires_at > clock_timestamp() AS lease_valid,
            window_ends_at > clock_timestamp() AS window_open,
            status IN ('ready', 'waiting_due', 'waiting_agent') AS
              status_open,
            action_count = 0 AS action_budget_open,
            recovery_task_id IS NULL AND dispatched_attempt_id IS NULL AS
              lineage_open
          FROM capture_recovery_intents
          WHERE id = $1::uuid AND tenant_id = $2
        `, [dutyIntentId, req.tenantId, dutyRecoveryLeaseToken]);
        if (finalFence && finalFence.window_open !== true) {
          abortCrossDeviceRetry('recovery_window_ended', {
            code: 'RECOVERY_WINDOW_ENDED',
          });
        }
        if (
          !finalFence
          || finalFence.lease_matches !== true
          || finalFence.lease_valid !== true
          || finalFence.status_open !== true
          || finalFence.action_budget_open !== true
          || finalFence.lineage_open !== true
        ) {
          abortCrossDeviceRetry('duty_recovery_lease_expired', {
            code: 'RECOVERY_LEASE_EXPIRED',
          });
        }
      }
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

      const dispatchedItemAttempts = [];
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
        const dutyItemMetadata = dutyRecovery
          ? {
              dutyRecovery: true,
              dutyRecoveryIntentId: dutyIntentId,
              dutyRecoveryGeneration: dutyGeneration,
            }
          : {};
        const updatedItem = await tx.queryOne(`
          UPDATE capture_task_items
          SET status = 'dispatched',
            attempt_count = $1,
            assigned_agent_id = $2,
            execution_task_id = $3,
            assignment_revision = $4,
            request_hash = $5,
            safety_handoff_count = safety_handoff_count +
              CASE WHEN $15::boolean THEN 1 ELSE 0 END,
            result_record_id = NULL,
            result_observation_id = NULL,
            error = '{}'::jsonb,
            metadata = (metadata - 'checkpoint' - 'targetResult') ||
              jsonb_strip_nulls(jsonb_build_object(
                'crossDeviceRetrySourceExecutionTaskId', $6::uuid::text,
                'crossDeviceRetryRequestKey', $7::uuid::text,
                'monitorExecutionId', $8::text
              )) || $9::jsonb,
            assigned_at = now(), dispatched_at = now(),
            started_at = NULL, finished_at = NULL, updated_at = now()
          WHERE id = $10 AND tenant_id = $11 AND task_id = $12
            AND execution_task_id IS NOT DISTINCT FROM $6::uuid
            AND assignment_revision = $13
            AND status = ANY($14::text[])
            AND (
              NOT $15::boolean
              OR safety_handoff_count = 0
            )
          RETURNING id, execution_task_id, assigned_agent_id,
            attempt_count, safety_handoff_count,
            assignment_revision, status, request_hash
        `, [
          attemptNumber,
          targetAgent.id,
          child.id,
          nextRevision,
          requestHash,
          item.execution_task_id,
          requestKey,
          monitorExecutionId || null,
          JSON.stringify(dutyItemMetadata),
          item.id,
          req.tenantId,
          parent.id,
          Number(item.assignment_revision || 0),
          [...CROSS_DEVICE_RETRY_ITEM_STATUSES],
          Boolean(dutySafetyHandoffPolicy),
        ]);
        if (!updatedItem) {
          const conflict = new Error('cross_device_retry_item_conflict');
          conflict.code = 'cross_device_retry_item_conflict';
          throw conflict;
        }
        const itemAttemptId = crypto.randomUUID();
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
          itemAttemptId,
          req.tenantId,
          item.id,
          parent.id,
          child.id,
          targetAgent.id,
          attemptNumber,
          nextRevision,
          requestHash,
        ]);
        dispatchedItemAttempts.push({
          id: itemAttemptId,
          itemId: updatedItem.id,
          executionTaskId: updatedItem.execution_task_id,
          agentId: updatedItem.assigned_agent_id,
          attemptNumber,
          assignmentRevision: updatedItem.assignment_revision,
          status: updatedItem.status,
          requestHash: updatedItem.request_hash,
          safetyHandoffCount: updatedItem.safety_handoff_count,
        });
      }
      const itemAttemptBindings = dispatchedItemAttempts.map((attempt) => {
        const sourceItem = retryItems.find(
          item => String(item.id) === String(attempt.itemId),
        );
        return {
          itemId: attempt.itemId,
          attemptId: attempt.id,
          requestHash: attempt.requestHash,
          attemptNumber: attempt.attemptNumber,
          assignmentRevision: attempt.assignmentRevision,
          keyword: text(sourceItem?.keyword, 120),
          recordId: text(sourceItem?.record_id, 100),
          externalId: text(sourceItem?.external_id, 160),
        };
      });
      const attemptBindingByItemId = new Map(
        itemAttemptBindings.map(binding => [String(binding.itemId), binding]),
      );
      const bindTargetAttempt = target => {
        const source = safeJson(target);
        const binding = attemptBindingByItemId.get(String(source.itemId));
        return binding
          ? {
              ...source,
              captureTaskItemAttemptId: binding.attemptId,
              captureTaskItemRequestHash: binding.requestHash,
              captureTaskItemAttemptNumber: binding.attemptNumber,
              captureTaskItemAssignmentRevision: binding.assignmentRevision,
            }
          : source;
      };
      commandPayload = {
        ...commandPayload,
        itemAttempts: itemAttemptBindings,
        ...(Array.isArray(commandPayload.targets)
          ? {targets: commandPayload.targets.map(bindTargetAttempt)}
          : {}),
        ...(Array.isArray(commandPayload.items)
          ? {items: commandPayload.items.map(bindTargetAttempt)}
          : {}),
        ...(commandPayload.orchestration
          ? {
              orchestration: {
                ...safeJson(commandPayload.orchestration),
                itemAttempts: itemAttemptBindings,
              },
            }
          : {}),
        ...(dutyRecovery && itemAttemptBindings[0]
          ? {
              dutyRecovery: {
                ...safeJson(commandPayload.dutyRecovery),
                captureTaskItemAttemptId: itemAttemptBindings[0].attemptId,
                captureTaskItemRequestHash: itemAttemptBindings[0].requestHash,
              },
            }
          : {}),
      };
      await tx.execute(`
        UPDATE capture_agent_commands
        SET payload = $3::jsonb, updated_at = now()
        WHERE id = $1::uuid AND tenant_id = $2
      `, [command.id, req.tenantId, JSON.stringify(commandPayload)]);
      if (dutyRecovery) {
        const dutyAttempt = dispatchedItemAttempts[0];
        const boundIntent = await tx.queryOne(`
          UPDATE capture_recovery_intents
          SET status = 'verifying_collection',
            decision = 'cross_agent_recovery',
            recovery_task_id = $4::uuid,
            recovery_command_id = $5::uuid,
            recovery_agent_id = $6::uuid,
            dispatched_attempt_id = $7::uuid,
            dispatched_at = COALESCE(dispatched_at, clock_timestamp()),
            expected_assignment_revision = $8::integer,
            expected_attempt_number = $9::integer,
            safety_handoff_count = CASE
              WHEN $11::boolean THEN 1
              ELSE safety_handoff_count
            END,
            source_lineage_silent = false,
            action_count = GREATEST(action_count, 1),
            decision_payload = decision_payload || jsonb_build_object(
              'recoveryTaskId', $4::uuid,
              'recoveryCommandId', $5::uuid,
              'recoveryAgentId', $6::uuid,
              'dispatchedAttemptId', $7::uuid,
              'executionTaskId', $4::uuid,
              'generation', $10::integer,
              'safetyHandoff', $11::boolean,
              'safetyHandoffCount', CASE WHEN $11::boolean THEN 1 ELSE 0 END,
              'sourceLineageSilent', false,
              'dispatchBoundAtomically', true
            ),
            verification = verification || jsonb_build_object(
              'dispatchedAt', clock_timestamp()::text,
              'businessEvidenceRequired', true,
              'commandStateIsNotBusinessSuccess', true,
              'dispatchBoundAtomically', true
            ),
            last_error = '',
            updated_at = clock_timestamp()
          WHERE id = $1::uuid AND tenant_id = $2
            AND lease_token = $3::uuid
            AND lease_expires_at > clock_timestamp()
            AND window_ends_at > clock_timestamp()
            AND status IN ('ready', 'waiting_due', 'waiting_agent')
            AND recovery_task_id IS NULL
            AND dispatched_attempt_id IS NULL
            AND action_count = 0
          RETURNING id
        `, [
          dutyIntentId,
          req.tenantId,
          dutyRecoveryLeaseToken,
          child.id,
          command.id,
          targetAgent.id,
          dutyAttempt?.id,
          dutyAttempt?.assignmentRevision,
          dutyAttempt?.attemptNumber,
          dutyGeneration,
          Boolean(dutySafetyHandoffPolicy),
        ]);
        if (!boundIntent) {
          abortCrossDeviceRetry('duty_recovery_lease_expired', {
            code: 'RECOVERY_BIND_FENCE_REJECTED',
          });
        }
        await tx.execute(`
          SELECT enqueue_ops_control_wakeup(
            $1::uuid,
            'capture_recovery_dispatch_bound',
            'capture_recovery_intent',
            $2::text,
            'capture-recovery-intent:' || $2::text || ':dispatch-bound',
            clock_timestamp() + interval '2 minutes',
            jsonb_build_object(
              'itemId', $3::uuid,
              'recoveryTaskId', $4::uuid,
              'generation', $5::integer,
              'businessEvidenceRequired', true
            ),
            true
          )
        `, [
          req.tenantId,
          dutyIntentId,
          retryItems[0].id,
          child.id,
          dutyGeneration,
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
        ...(dutyRecovery
          ? {
              lastDutyRecoveryAt: new Date().toISOString(),
              lastDutyRecoveryTaskId: child.id,
              lastDutyRecoveryAgentId: targetAgent.id,
              lastDutyRecoveryIntentId: dutyIntentId,
              lastDutyRecoveryGeneration: dutyGeneration,
            }
          : {}),
        ...(automatic
          ? {
              lastAutomaticRecoveryAt: new Date().toISOString(),
              lastAutomaticRecoveryTaskId: child.id,
              ...(!dutyRecovery
                ? {
                    automaticRecoveryCount:
                      Math.max(
                        0,
                        Number(
                          safeJson(parent.metadata).automaticRecoveryCount,
                        ) || 0,
                      ) + 1,
                  }
                : {}),
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
          ...(dutyRecovery
            ? {
                recoveryPhase: 'duty',
                dutyRecoveryIntentId: dutyIntentId,
                dutyRecoveryGeneration: dutyGeneration,
              }
            : {}),
        },
      });
      return {
        existing: false,
        replayed: false,
        child,
        command,
        agent: targetAgent,
        parent: parentUpdate,
        itemAttempts: dispatchedItemAttempts,
        itemCount: retryItems.length,
        targetAgentId: targetAgent.id,
        recovery: dutyRecovery
          ? {phase: 'duty', intentId: dutyIntentId, generation: dutyGeneration}
          : {phase: 'fast'},
      };
    });
  } catch (error) {
    if (
      error?.crossDeviceRetryError ===
        'idle_compatible_agent_unavailable'
    ) {
      return noIdleAgentResult();
    }
    if (
      dutyRecovery &&
      error?.crossDeviceRetryError === 'duty_recovery_source_superseded'
    ) {
      return supersededResult(safeJson(error.details));
    }
    if (
      dutyRecovery &&
      [
        'duty_recovery_source_execution_active',
        'duty_recovery_source_command_active',
      ].includes(error?.crossDeviceRetryError)
    ) {
      return {
        error: error.crossDeviceRetryError,
        waitingForSource: true,
        ...safeJson(error.details),
      };
    }
    if (
      dutyRecovery &&
      error?.crossDeviceRetryError ===
        'retry_requires_manual_safety_action'
    ) {
      return {
        error: 'retry_requires_manual_safety_action',
        code: 'HUMAN_REQUIRED',
        humanRequired: true,
        reason:
          text(error?.details?.reason, 160) ||
          'safety_handoff_policy_rejected',
      };
    }
    throw error;
  }
}


async function listAutomaticCaptureRetryCandidates(
  normalizedLimit,
  {tenantId = '', taskIds = []} = {},
) {
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
      AND ($5::uuid IS NULL OR tenant_id = $5::uuid)
      AND (cardinality($6::uuid[]) = 0 OR id = ANY($6::uuid[]))
      AND (
        $7::boolean = false
        OR NOT EXISTS (
          SELECT 1
          FROM tenant_settings recovery_enabled
          JOIN tenant_settings recovery_mode
            ON recovery_mode.tenant_id = recovery_enabled.tenant_id
            AND recovery_mode.key = 'ops_control_recovery_mode'
          WHERE recovery_enabled.tenant_id = capture_tasks.tenant_id
            AND recovery_enabled.key = 'ops_control_recovery_enabled'
            AND LOWER(BTRIM(recovery_enabled.value)) = ANY($8::text[])
            AND LOWER(BTRIM(recovery_mode.value)) = 'guarded'
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
    tenantId || null,
    taskIds,
    dutyRecoveryGlobalActionsEnabled(),
    [...DUTY_RECOVERY_TRUE_VALUES],
  ]);
}

const reconcileAutomaticCaptureRetriesImpl =
  createAutomaticCaptureRetryReconciler({
    listCandidates: listAutomaticCaptureRetryCandidates,
    dispatchRetry: dispatchCrossDeviceRetry,
    createRequestKey: () => crypto.randomUUID(),
    formatErrorMessage: message => text(message, 240),
  });

function automaticCaptureRetryValidationError(error) {
  return {
    scanned: 0,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [],
    error,
  };
}

export async function reconcileAutomaticCaptureRetries(input = 10) {
  const options = input && typeof input === 'object' ? input : {limit: input};
  const normalizedLimit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const tenantId = text(options.tenantId, 100).toLowerCase();
  const taskIdInput = Array.isArray(options.taskIds) ? options.taskIds : [];
  const taskIds = Array.from(new Set(
    taskIdInput
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
  const maxDispatchesPerTask = Math.max(
    1,
    Math.min(30, Number(options.maxDispatchesPerTask) || 30),
  );
  const requestedByName = text(
    options.requestedByName || '自动调度中心',
    240,
  );
  if (tenantId && !UUID_PATTERN.test(tenantId)) {
    return automaticCaptureRetryValidationError('invalid_tenant_id');
  }
  if (Object.hasOwn(options, 'taskIds') && (
    !tenantId
    || taskIds.length === 0
    || taskIds.length !== taskIdInput.length
  )) {
    return automaticCaptureRetryValidationError('invalid_task_scope');
  }
  return reconcileAutomaticCaptureRetriesImpl({
    limit: normalizedLimit,
    tenantId,
    taskIds,
    maxDispatchesPerTask,
    requestedByName,
  });
}
