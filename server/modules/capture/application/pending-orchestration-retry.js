import crypto from 'crypto';

import {normalizeCaptureAgentPlatforms} from '../../../services/capture-cloud.js';
import {hashOrchestrationRequest} from '../../../services/capture-orchestration.js';
import {safeJson, text} from './control-outcome-projection.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const HANDOFF_SOURCE_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
]);

const HANDOFF_PLATFORM_SAFETY_CODES = new Set([
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_CAPTCHA_REQUIRED',
  'CAPTCHA_PAGE_DETECTED',
]);

export const RETRY_PENDING_PARENT_BLOCKED_STATUSES = [
  'completed',
  'completed_with_warnings',
  'canceled',
  'skipped',
  'superseded',
];

function requireDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

export function elasticQueueOwnsRetry(parent) {
  const metadata = safeJson(parent?.metadata);
  return metadata.distributionMode === 'elastic_pool';
}

export function itemRequiresManualSafetyAction(item) {
  const error = safeJson(item?.error);
  const checkpoint = safeJson(safeJson(item?.metadata).checkpoint);
  const code = text(
    error.code || checkpoint.errorCode || checkpoint.error_code,
    100,
  ).toUpperCase();
  return HANDOFF_PLATFORM_SAFETY_CODES.has(code) ||
    error.category === 'platform_safety_block' ||
    error.securityBlocked === true ||
    error.platformSafetyBlocked === true ||
    error.requiresManualAction === true ||
    checkpoint.securityBlocked === true ||
    checkpoint.platformSafetyBlocked === true ||
    checkpoint.requiresManualAction === true;
}

export function agentCompatibilityFailure(
  agent,
  platform,
  planSnapshot = {},
) {
  if (
    agent.tenant_status !== 'active' ||
    agent.status !== 'active' ||
    agent.auth_code_status !== 'active' ||
    !agent.active_auth_binding_id ||
    (
      agent.auth_code_expires_at &&
      new Date(agent.auth_code_expires_at) < new Date()
    )
  ) {
    return {
      code: 'agent_unavailable',
      message: '目标节点授权已失效、已停用或不存在',
    };
  }
  const capabilities = safeJson(agent.capabilities);
  if (capabilities.remoteTaskCreate !== true) {
    return {
      code: 'agent_capability_missing',
      message: '目标节点版本尚不支持云端创建任务，请先更新扩展',
    };
  }
  if (
    Object.hasOwn(planSnapshot, 'keywordMaxDetectedItems') &&
    capabilities.remoteTaskKeywordPostLimit !== true
  ) {
    return {
      code: 'agent_keyword_limit_capability_missing',
      message: '目标节点版本尚不支持指定帖子采集数量',
    };
  }
  if (
    Object.keys(safeJson(planSnapshot.captureSettings)).length > 0 &&
    capabilities.remoteTaskEnhancementOptions !== true
  ) {
    return {
      code: 'agent_enhancement_capability_missing',
      message: '目标节点版本尚不支持远程任务增强选项',
    };
  }
  if (
    Array.isArray(planSnapshot.searchPasses) &&
    planSnapshot.searchPasses.length > 1 &&
    capabilities.remoteSequentialSearchPassesV1 !== true
  ) {
    return {
      code: 'agent_sequential_search_capability_missing',
      message: '目标节点版本尚不支持同一关键词串行补充巡检，请先更新扩展',
    };
  }
  if (
    safeJson(planSnapshot.recoveryPolicy).singleRelayV1 === true &&
    capabilities.singleRelayV1 !== true
  ) {
    return {
      code: 'agent_single_relay_capability_missing',
      message: '目标节点版本尚不支持单次跨设备接力，请先更新扩展',
    };
  }
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) {
    return {
      code: 'agent_platform_mismatch',
      message: '目标节点未配置负责该任务平台',
    };
  }
  const supportedPlatforms = normalizeCaptureAgentPlatforms(
    capabilities.supportedPlatforms,
  );
  if (
    supportedPlatforms.length > 0 &&
    !supportedPlatforms.includes(platform)
  ) {
    return {
      code: 'agent_platform_unsupported',
      message: '目标节点当前版本不支持该任务平台',
    };
  }
  return null;
}

export function deterministicRetryUuid(...parts) {
  const digits = crypto
    .createHash('sha256')
    .update(parts.map(part => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32)
    .split('');
  digits[12] = '5';
  digits[16] = ((Number.parseInt(digits[16], 16) & 0x3) | 0x8).toString(16);
  const hex = digits.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function inspectPendingRetryLineage(item, parent = null) {
  const metadata = safeJson(item?.metadata);
  const requestKey = normalizedUuid(metadata.retryWaitingRequestKey);
  const requestHash = text(metadata.retryWaitingRequestHash, 80).toLowerCase();
  const planHash = text(metadata.retryWaitingPlanHash, 80).toLowerCase();
  const sourceExecutionTaskId = normalizedUuid(
    metadata.retryWaitingSourceExecutionTaskId,
  );
  const preferredAgentId = normalizedUuid(metadata.retryWaitingAgentId);
  const rawPreferredAgentId = text(metadata.retryWaitingAgentId, 100);
  const waitingParentRevision = Number(metadata.retryWaitingParentRevision);
  const itemRevision = Number(metadata.retryWaitingItemRevision);
  const attemptCount = Number(metadata.retryWaitingAttemptCount);
  const currentItemRevision = Number(item?.assignment_revision);
  const currentAttemptCount = Number(item?.attempt_count);
  let invalidReason = '';
  if (metadata.retryPending !== true) {
    invalidReason = 'marker_not_pending';
  } else if (!requestKey) {
    invalidReason = 'request_key_invalid';
  } else if (!/^[0-9a-f]{64}$/u.test(requestHash)) {
    invalidReason = 'request_hash_invalid';
  } else if (!/^[0-9a-f]{64}$/u.test(planHash)) {
    invalidReason = 'plan_hash_invalid';
  } else if (!sourceExecutionTaskId) {
    invalidReason = 'source_execution_invalid';
  } else if (rawPreferredAgentId && !preferredAgentId) {
    invalidReason = 'preferred_agent_invalid';
  } else if (
    !Number.isSafeInteger(waitingParentRevision) ||
    waitingParentRevision < 1
  ) {
    invalidReason = 'authorized_parent_revision_invalid';
  } else if (!Number.isSafeInteger(itemRevision) || itemRevision < 0) {
    invalidReason = 'item_revision_invalid';
  } else if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    invalidReason = 'attempt_count_invalid';
  } else if (itemRevision !== currentItemRevision) {
    invalidReason = 'item_revision_changed';
  } else if (attemptCount !== currentAttemptCount) {
    invalidReason = 'attempt_count_changed';
  } else if (
    sourceExecutionTaskId !== String(item?.execution_task_id || '')
  ) {
    invalidReason = 'source_execution_changed';
  } else if (
    parent &&
    Number(parent.orchestration_revision || 0) < waitingParentRevision
  ) {
    invalidReason = 'parent_revision_regressed';
  } else if (
    parent &&
    hashOrchestrationRequest(safeJson(parent.metadata?.planSnapshot)) !==
      planHash
  ) {
    invalidReason = 'parent_plan_changed';
  }
  return {
    invalidReason,
    lineage: invalidReason
      ? null
      : {
          requestKey,
          requestHash,
          planHash,
          sourceExecutionTaskId,
          preferredAgentId,
          waitingParentRevision,
          itemRevision,
          attemptCount,
          safetyConfirmed: metadata.retryWaitingSafetyConfirmed === true,
          requestedByUserId: normalizedUuid(
            metadata.retryWaitingRequestedByUserId,
          ),
          requestedByName: text(metadata.retryWaitingRequestedByName, 240),
          batchSize: Math.max(1, Number(metadata.retryWaitingBatchSize) || 1),
          dispatchOrdinal: Math.max(
            0,
            Number(metadata.retryWaitingDispatchOrdinal) || 0,
          ),
        },
  };
}

export function pendingRetryLineage(item, parent = null) {
  return inspectPendingRetryLineage(item, parent).lineage;
}

export function pendingRetryMarkerSnapshot(item) {
  const metadata = safeJson(item?.metadata);
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) =>
      key === 'retryPending' || key.startsWith('retryWaiting')
    ),
  );
}

export function publicPendingRetryItem(item) {
  const metadata = safeJson(item?.metadata);
  return {
    itemId: item.id,
    keyword: item.keyword,
    status: 'retryable',
    reason: text(metadata.retryWaitingReason, 80) || 'no_idle_agent',
    ...(normalizedUuid(metadata.retryWaitingAgentId)
      ? {agentId: normalizedUuid(metadata.retryWaitingAgentId)}
      : {}),
  };
}

export function retryPendingRowKey(row) {
  return `${String(row?.tenant_id || '')}:${String(row?.id || '')}`;
}

export function retryPendingParentKey(row) {
  return `${String(row?.tenant_id || '')}:${String(
    row?.task_id || row?.id || '',
  )}`;
}

export function retryPendingInvalidationReason(item, parent) {
  if (!item || !parent || item.status !== 'retryable') return '';
  if (RETRY_PENDING_PARENT_BLOCKED_STATUSES.includes(parent.status)) {
    return 'parent_status_terminal';
  }
  const parentMetadata = safeJson(parent.metadata);
  if (parentMetadata.operatorStopped === true) return 'parent_operator_stopped';
  if (
    parentMetadata.orchestrationTemplate === true ||
    parentMetadata.executionMode === 'unattended_plan'
  ) {
    return 'parent_dispatch_mode_changed';
  }
  if (elasticQueueOwnsRetry(parent)) {
    return 'elastic_queue_retry_managed';
  }
  const inspection = inspectPendingRetryLineage(item, parent);
  if (
    inspection.lineage &&
    itemRequiresManualSafetyAction(item) &&
    inspection.lineage.safetyConfirmed !== true
  ) {
    return 'safety_confirmation_missing';
  }
  return inspection.invalidReason === 'marker_not_pending'
    ? ''
    : inspection.invalidReason;
}

function normalizeLimit(input) {
  const requested = typeof input === 'object' ? input.limit : input;
  const numeric = Number(requested);
  return Number.isFinite(numeric)
    ? Math.max(1, Math.min(100, Math.floor(numeric)))
    : 10;
}

export function createPendingOrchestrationRetryReconciler({
  withTransaction,
  dispatchOnePendingRetry,
} = {}) {
  const runTransaction = requireDependency('withTransaction', withTransaction);
  const dispatchOne = requireDependency(
    'dispatchOnePendingRetry',
    dispatchOnePendingRetry,
  );
  return async function reconcilePendingOrchestrationRetries(input = 10) {
    const limit = normalizeLimit(input);
    const summary = {
      inspected: 0,
      dispatched: 0,
      waitingForAgent: 0,
      stale: 0,
      invalidated: 0,
      failed: 0,
      results: [],
    };
    const excludedItemIds = new Set();
    for (let index = 0; index < limit; index += 1) {
      try {
        const result = await runTransaction(tx =>
          dispatchOne(tx, {
            scanLimit: Math.max(20, limit),
            excludedItemIds: [...excludedItemIds],
          })
        );
        if (result.kind === 'empty') break;
        summary.inspected += 1;
        summary.results.push(result);
        if (result.kind === 'dispatched') {
          summary.dispatched += 1;
          continue;
        }
        if (result.kind === 'waiting_for_agent') {
          summary.waitingForAgent += Number(result.waitingCount || 1);
          for (const itemId of result.checkedItemIds || []) {
            excludedItemIds.add(itemId);
          }
          if (Number(result.checkedCount || 0) > 0) continue;
          break;
        }
        summary.stale += Number(result.staleCount || 1);
        summary.invalidated += Number(result.invalidatedCount || 0);
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          kind: 'failed',
          error: text(error?.code || error?.message || error, 240),
        });
      }
    }
    return summary;
  };
}
