import crypto from 'crypto';
import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  captureAgentOnline,
  findCaptureAgentExecutionSlotBlocker,
  lockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  normalizeRemoteTaskInput,
} from '../services/capture-cloud.js';
import {
  aggregateParentTaskItems,
  allocateKeywordWorkItems,
  computeNextOrchestrationRunAt,
  hashOrchestrationRequest,
  normalizeOrchestrationRequest,
} from '../services/capture-orchestration.js';
import {
  runCaptureOrchestrationScheduleNow,
} from '../services/capture-orchestration-scheduler.js';

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const HANDOFF_SOURCE_FINAL_STATUSES = new Set([
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
const RETRY_ITEM_STATUSES = new Set(['retryable', 'needs_action', 'failed']);
const ORCHESTRATION_STOPPABLE_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
  'failed',
  'completed_with_failures',
]);
const ORCHESTRATION_STOPPABLE_EXECUTION_STATUSES = [
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
  'failed',
  'completed_with_failures',
];

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function itemRequiresManualSafetyAction(item) {
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

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

function orchestrationRouteId(req, res) {
  const orchestrationId = normalizedUuid(req.params.id);
  if (orchestrationId) return orchestrationId;
  sendRequestError(res, requestError(
    'invalid_orchestration_id',
    '编排任务 ID 必须是有效 UUID',
  ));
  return '';
}

function keywordItemKey(keyword, ordinal) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(String(keyword || ''))
    .digest('hex')
    .slice(0, 12);
  return `keyword:${String(ordinal + 1).padStart(4, '0')}:${fingerprint}`;
}

function requestError(error, message, status = 400, details = {}) {
  return {error, message, status, details};
}

function sendRequestError(res, failure) {
  return res.status(failure.status || 400).json({
    ok: false,
    error: failure.error,
    message: failure.message,
    ...safeJson(failure.details),
  });
}

function normalizedAgentIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {failure: requestError(
      'agent_ids_required',
      '请至少选择一个执行节点',
    )};
  }
  const agentIds = [];
  const seen = new Set();
  for (const rawAgentId of value) {
    const agentId = normalizedUuid(rawAgentId);
    if (!agentId) {
      return {failure: requestError(
        'invalid_agent_id',
        '执行节点 ID 必须是有效 UUID',
      )};
    }
    if (seen.has(agentId)) {
      return {failure: requestError(
        'duplicate_agent_id',
        '同一个执行节点不能重复选择',
      )};
    }
    seen.add(agentId);
    agentIds.push(agentId);
  }
  if (agentIds.length > 50) {
    return {failure: requestError(
      'too_many_agents',
      '一次最多选择 50 个执行节点',
    )};
  }
  return {agentIds};
}

function normalizeCreateRequest(body) {
  try {
    const normalized = normalizeOrchestrationRequest({
      ...safeJson(body),
      requestKey: body?.requestKey || body?.clientTaskId,
    });
    const requestKey = normalizedUuid(normalized.requestKey);
    if (!requestKey) {
      return {failure: requestError(
        'invalid_request_key',
        'requestKey 必须是有效 UUID',
      )};
    }
    const remoteTaskInput = normalizeRemoteTaskInput({
      clientTaskId: requestKey,
      title: normalized.title,
      executionMode: normalized.executionMode,
      planSnapshot: {
        ...safeJson(normalized.taskInput),
        platform: normalized.platform,
        // normalizeRemoteTaskInput is also the child-command contract and is
        // intentionally capped at 30 keywords. Normalize the shared plan
        // options here, then restore the complete parent list below.
        keywords: normalized.keywords.slice(0, 30),
      },
    });
    if (!SUPPORTED_PLATFORMS.has(remoteTaskInput.planSnapshot.platform)) {
      return {failure: requestError(
        'unsupported_platform',
        '编排任务当前只支持小红书和抖音',
      )};
    }
    if (remoteTaskInput.planSnapshot.keywords.length === 0) {
      return {failure: requestError(
        'keywords_required',
        '请至少填写一个关键词',
      )};
    }
    const request = {
      ...normalized,
      requestKey,
      executionMode: normalized.executionMode,
      platform: normalized.platform,
      keywords: normalized.keywords,
      title: remoteTaskInput.title,
      taskInput: {
        ...remoteTaskInput,
        planSnapshot: {
          ...remoteTaskInput.planSnapshot,
          keywords: normalized.keywords,
        },
      },
    };
    return {request, requestHash: hashOrchestrationRequest(request)};
  } catch (error) {
    return {failure: requestError(
      text(error?.code, 120) || 'invalid_orchestration_request',
      text(error?.message, 1000) || '任务参数不完整或格式无效',
    )};
  }
}

function normalizeScheduleUpdate(body, orchestrationId) {
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return {failure: requestError(
      'invalid_expected_revision',
      'expectedRevision 必须是大于 0 的计划版本',
    )};
  }
  const rawDistributionMode = text(body?.distributionMode, 40).toLowerCase();
  if (!['fixed_batch', 'elastic_pool'].includes(rawDistributionMode)) {
    return {failure: requestError(
      'invalid_distribution_mode',
      '请选择固定分配或弹性节点池',
    )};
  }
  if (!text(body?.title, 240)) {
    return {failure: requestError(
      'title_required',
      '请填写任务名称',
    )};
  }
  const normalizedAgents = normalizedAgentIds(body?.agentIds);
  if (normalizedAgents.failure) return normalizedAgents;
  const normalized = normalizeCreateRequest({
    ...safeJson(body),
    requestKey: orchestrationId,
    executionMode: 'unattended_plan',
    distributionMode: rawDistributionMode,
    agentIds: normalizedAgents.agentIds,
  });
  if (normalized.failure) return normalized;
  return {
    expectedRevision,
    request: normalized.request,
    agentIds: normalizedAgents.agentIds,
  };
}

async function appendEvent(tx, {
  tenantId,
  taskId,
  agentId = null,
  eventType,
  actorId = '',
  actorName = '',
  status = '',
  message = '',
  payload = {},
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9::jsonb)
  `, [
    tenantId,
    taskId,
    agentId,
    eventType,
    text(actorId, 240),
    text(actorName, 240),
    text(status, 80),
    text(message, 2000),
    JSON.stringify(safeJson(payload)),
  ]);
}

function publicAgent(agent) {
  return {
    id: agent.id,
    display_name: agent.display_name,
    host_label: agent.host_label,
    browser_name: agent.browser_name,
    operating_system: agent.operating_system,
    app_version: agent.app_version,
    allowed_platforms: agent.allowed_platforms,
    capabilities: agent.capabilities,
    status: agent.status,
    last_heartbeat_at: agent.last_heartbeat_at,
    online: captureAgentOnline(agent.last_heartbeat_at),
  };
}

function publicParentItem(item) {
  const {
    source_record_title: sourceRecordTitle,
    source_record_content: sourceRecordContent,
    ...publicItem
  } = item;
  const metadata = safeJson(item.metadata);
  const sourceRecord = safeJson(metadata.sourceRecord);
  return {
    ...publicItem,
    metadata: {
      ...metadata,
      sourceRecord: {
        ...sourceRecord,
        title:
          text(sourceRecord.title, 500) || text(sourceRecordTitle, 500),
        content:
          text(sourceRecord.content, 1000) || text(sourceRecordContent, 1000),
      },
    },
  };
}

function agentCompatibilityFailure(agent, platform, planSnapshot = {}) {
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

async function loadCompatibleAgents(
  executor,
  tenantId,
  agentIds,
  platform,
  planSnapshot,
  {lock = false} = {},
) {
  const orderedForLock = lock
    ? [...agentIds].sort((left, right) => left.localeCompare(right))
    : agentIds;
  const agents = await executor.queryAll(`
    SELECT ca.*,
      tenant.status AS tenant_status,
      ac.status AS auth_code_status,
      ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    WHERE ca.tenant_id = $1
      AND ca.id = ANY($2::uuid[])
    ORDER BY ca.id
    ${lock ? 'FOR UPDATE OF ca' : ''}
  `, [tenantId, orderedForLock]);
  const byId = new Map(agents.map(agent => [String(agent.id), agent]));
  if (byId.size !== agentIds.length) {
    return {failure: requestError(
      'agent_not_found',
      '一个或多个执行节点不存在于当前租户',
      404,
    )};
  }
  for (const agentId of agentIds) {
    const agent = byId.get(agentId);
    const failure = agentCompatibilityFailure(agent, platform, planSnapshot);
    if (failure) {
      return {failure: requestError(
        failure.code,
        failure.message,
        409,
        {agentId},
      )};
    }
  }
  return {
    agents: agentIds.map(agentId => byId.get(agentId)),
    agentsById: byId,
  };
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

async function loadOrchestrationSchedule(executor, tenantId, scheduleId, {lock = false} = {}) {
  if (!scheduleId) return null;
  return executor.queryOne(`
    SELECT id, tenant_id, template_task_id, title, platform, status,
      schedule_mode, timezone, start_time, random_offset_min,
      ARRAY(
        SELECT scheduled_date::text
        FROM unnest(schedule.custom_dates) AS scheduled_date
        ORDER BY scheduled_date
      ) AS custom_dates,
      overlap_policy, late_start_grace_min, allocation_mode, revision,
      distribution_mode,
      plan_snapshot, next_run_at, last_scheduled_for, last_run_at,
      last_run_task_id, last_run_status, last_error, run_count,
      archived_at, archived_by_user_id, archived_by_name,
      archived_previous_status,
      created_at, updated_at
    FROM capture_orchestration_schedules schedule
    WHERE schedule.id = $1 AND schedule.tenant_id = $2
    ${lock ? 'FOR UPDATE' : ''}
  `, [scheduleId, tenantId]);
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

function mapAllocationGroups(allocation, items, agentsById) {
  const itemByOrdinal = new Map(
    items.map(item => [Number(item.ordinal), item]),
  );
  const allocationItems = Array.isArray(allocation?.items)
    ? allocation.items
    : [];
  const itemsByAgent = new Map();
  for (const entry of allocationItems) {
    const agentId = String(
      entry.agentId || entry.agent_id || entry.assignedAgentId || '',
    );
    if (!itemsByAgent.has(agentId)) itemsByAgent.set(agentId, []);
    const item = itemByOrdinal.get(Number(entry.ordinal));
    if (item) itemsByAgent.get(agentId).push(item);
  }
  return (Array.isArray(allocation?.groups) ? allocation.groups : []).map(
    group => {
      const agentId = String(group.agentId || group.agent_id || '');
      let groupItems = itemsByAgent.get(agentId) || [];
      if (groupItems.length === 0 && Array.isArray(group.ordinals)) {
        groupItems = group.ordinals
          .map(ordinal => itemByOrdinal.get(Number(ordinal)))
          .filter(Boolean);
      }
      groupItems.sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
      return {
        agentId,
        agent: publicAgent(agentsById.get(agentId)),
        itemIds: groupItems.map(item => item.id),
        keywords: groupItems.map(item => item.keyword),
        itemCount: groupItems.length,
      };
    },
  );
}

router.post(
  '/orchestrations',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeCreateRequest(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const {request, requestHash} = normalized;
      const result = await withTransaction(async tx => {
        // Preview creates a hidden draft so assignment can be reviewed against
        // stable item IDs. Explicit close deletes it immediately; this bounded
        // cleanup handles crashed tabs and abandoned offline sessions.
        await tx.execute(`
          DELETE FROM capture_tasks draft
          WHERE draft.tenant_id = $1
            AND draft.task_type = 'capture_orchestration'
            AND draft.orchestration_revision = 0
            AND draft.metadata->>'draft' = 'true'
            AND draft.created_at < now() - interval '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM capture_tasks child
              WHERE child.tenant_id = draft.tenant_id
                AND child.parent_task_id = draft.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM capture_task_items item
              WHERE item.tenant_id = draft.tenant_id
                AND item.task_id = draft.id
                AND (
                  item.status <> 'pending'
                  OR item.assigned_agent_id IS NOT NULL
                  OR item.execution_task_id IS NOT NULL
                )
            )
        `, [req.tenantId]);
        // A SELECT ... FOR UPDATE cannot lock a row that does not exist. Lock
        // the tenant/request-key namespace first so concurrent retries cannot
        // both pass the empty-key check and turn an idempotent request into a
        // PostgreSQL unique-violation 500.
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [String(req.tenantId), request.requestKey],
        );
        const existing = await tx.queryOne(
          parentSelect({lock: true}),
          [request.requestKey, req.tenantId],
        );
        if (existing) {
          const metadata = safeJson(existing.metadata);
          if (metadata.orchestrationRequestHash !== requestHash) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的编排任务请求',
              409,
            )};
          }
          const items = await listParentItems(
            tx,
            req.tenantId,
            existing.id,
          );
          return {parent: existing, items, existing: true};
        }
        const idCollision = await tx.queryOne(
          'SELECT id FROM capture_tasks WHERE id = $1::uuid',
          [request.requestKey],
        );
        if (idCollision) {
          return {failure: requestError(
            'idempotency_key_conflict',
            '该 requestKey 已被其他任务占用',
            409,
          )};
        }
        const planSnapshot = request.taskInput.planSnapshot;
        const total = request.keywords.length;
        const metadata = {
          orchestrationRequestHash: requestHash,
          draft: true,
          allocationMode: request.allocationMode || 'balanced',
          distributionMode: request.distributionMode || 'fixed_batch',
          executionMode: request.executionMode,
          planSnapshot,
          requestedByUserId: req.user?.id || '',
          requestedByName: text(req.actorName, 240),
        };
        const parent = await tx.queryOne(`
          INSERT INTO capture_tasks (
            id, tenant_id, client_task_id, task_type, feature_key,
            title, platform, source, trigger_type, status,
            progress, checkpoint, counts, metadata, message,
            orchestration_revision, source_updated_at
          ) VALUES (
            $1::uuid, $2, $1::uuid::text, 'capture_orchestration',
            'keyword_orchestration', $3, $4, 'cloud',
            'remote_orchestration', 'pending',
            $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb,
            $8, 0, now()
          )
          RETURNING id, tenant_id, client_task_id, parent_task_id,
            task_type, feature_key, title, platform, source, trigger_type,
            status, progress, checkpoint, counts, metadata, error, message,
            orchestration_revision, created_at, updated_at
        `, [
          request.requestKey,
          req.tenantId,
          request.title,
          request.platform,
          JSON.stringify({current: 0, total, phase: 'unassigned'}),
          JSON.stringify({
            total,
            assigned: 0,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          }),
          JSON.stringify(metadata),
          request.executionMode === 'unattended_plan'
            ? '多 Agent 无人值守计划已创建，等待确认分配'
            : '编排任务已创建，等待分配执行节点',
        ]);
        const items = [];
        for (let index = 0; index < request.keywords.length; index += 1) {
          const ordinal = index;
          const keyword = request.keywords[index];
          const item = await tx.queryOne(`
            INSERT INTO capture_task_items (
              id, tenant_id, task_id, item_key, ordinal, keyword,
              platform, item_type, status, metadata
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, 'keyword', 'pending', $8::jsonb
            )
            RETURNING id, task_id, item_key, ordinal, keyword,
              platform, item_type, status, attempt_count,
              assigned_agent_id, execution_task_id, assignment_revision,
              request_hash, error, metadata, assigned_at, dispatched_at,
              started_at, finished_at, created_at, updated_at
          `, [
            crypto.randomUUID(),
            req.tenantId,
            parent.id,
            keywordItemKey(keyword, ordinal),
            ordinal,
            keyword,
            request.platform,
            JSON.stringify({keyword, ordinal}),
          ]);
          items.push(item);
        }
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_created',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parent.status,
          message: request.executionMode === 'unattended_plan'
            ? '后台已创建多 Agent 无人值守计划草稿'
            : '后台已创建关键词编排任务',
          payload: {
            revision: 0,
            platform: parent.platform,
            keywordCount: items.length,
            allocationMode: metadata.allocationMode,
            distributionMode: metadata.distributionMode,
            executionMode: request.executionMode,
          },
        });
        return {parent, items, existing: false};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        existing: result.existing,
        orchestration: {
          ...result.parent,
          revision: Number(result.parent.orchestration_revision || 0),
        },
        items: result.items.sort(
          (left, right) => Number(left.ordinal) - Number(right.ordinal),
        ),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  '/orchestrations/:id/draft',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (!parent) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        const items = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
          {lock: true},
        );
        const children = await tx.queryAll(`
          SELECT id
          FROM capture_tasks
          WHERE tenant_id = $1 AND parent_task_id = $2
          ORDER BY id
          FOR UPDATE
        `, [req.tenantId, parent.id]);
        const stillDraft =
          parent.status === 'pending' &&
          Number(parent.orchestration_revision || 0) === 0 &&
          children.length === 0 &&
          items.length > 0 &&
          items.every(item =>
            item.status === 'pending' &&
            !item.assigned_agent_id &&
            !item.execution_task_id
          );
        if (!stillDraft) {
          return {failure: requestError(
            'orchestration_not_draft',
            '该编排任务已经下发或发生状态变化，不能作为草稿删除',
            409,
          )};
        }
        const deleted = await tx.queryOne(`
          DELETE FROM capture_tasks
          WHERE id = $1 AND tenant_id = $2
            AND task_type = 'capture_orchestration'
          RETURNING id
        `, [parent.id, req.tenantId]);
        return {deleted};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        orchestrationId: result.deleted.id,
        deleted: true,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/allocation-preview',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const normalizedAgents = normalizedAgentIds(req.body?.agentIds);
      if (normalizedAgents.failure) {
        return sendRequestError(res, normalizedAgents.failure);
      }
      const parent = await queryOne(
        parentSelect(),
        [orchestrationId, req.tenantId],
      );
      if (!parent) {
        return sendRequestError(res, requestError(
          'orchestration_not_found',
          '编排任务不存在',
          404,
        ));
      }
      const items = await listParentItems(
        {queryAll},
        req.tenantId,
        parent.id,
      );
      if (items.length === 0) {
        return sendRequestError(res, requestError(
          'orchestration_items_missing',
          '编排任务没有可分配的关键词',
          409,
        ));
      }
      if (items.some(item => item.execution_task_id || item.assigned_agent_id)) {
        return sendRequestError(res, requestError(
          'orchestration_already_dispatched',
          '编排任务已经下发，当前版本不支持重新分配',
          409,
        ));
      }
      const planSnapshot = safeJson(parent.metadata?.planSnapshot);
      const compatible = await loadCompatibleAgents(
        {queryAll},
        req.tenantId,
        normalizedAgents.agentIds,
        parent.platform,
        planSnapshot,
      );
      if (compatible.failure) {
        return sendRequestError(res, compatible.failure);
      }
      const allocation = allocateKeywordWorkItems({
        keywords: items
          .slice()
          .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
          .map(item => item.keyword),
        agentIds: normalizedAgents.agentIds,
        revision: Number(parent.orchestration_revision || 0),
      });
      if (
        parent.metadata?.distributionMode !== 'elastic_pool' &&
        allocation.groups.some(group => group.keywords.length > 30)
      ) {
        return sendRequestError(res, requestError(
          'insufficient_agents',
          '所选节点不足以承载全部关键词，请增加执行节点',
          409,
          {minimumAgentCount: Math.ceil(items.length / 30)},
        ));
      }
      return res.json({
        ok: true,
        orchestrationId: parent.id,
        revision: Number(parent.orchestration_revision || 0),
        platform: parent.platform,
        itemCount: items.length,
        groups: mapAllocationGroups(
          allocation,
          items,
          compatible.agentsById,
        ),
      });
    } catch (error) {
      return next(error);
    }
  },
);

function normalizeDispatch(body) {
  const expectedRevision = Number(body?.expectedRevision);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return {failure: requestError(
      'invalid_expected_revision',
      'expectedRevision 必须是非负整数',
    )};
  }
  if (!Array.isArray(body?.assignments) || body.assignments.length === 0) {
    return {failure: requestError(
      'assignments_required',
      '请提交每个关键词的执行节点分配',
    )};
  }
  const assignments = [];
  const seenItems = new Set();
  for (const rawAssignment of body.assignments) {
    const itemId = normalizedUuid(rawAssignment?.itemId);
    const agentId = normalizedUuid(rawAssignment?.agentId);
    if (!itemId || !agentId) {
      return {failure: requestError(
        'invalid_assignment',
        'itemId 和 agentId 必须是有效 UUID',
      )};
    }
    if (seenItems.has(itemId)) {
      return {failure: requestError(
        'duplicate_item_assignment',
        '同一个关键词不能重复分配',
      )};
    }
    seenItems.add(itemId);
    assignments.push({itemId, agentId});
  }
  let eligibleAgentIds = [];
  if (Object.hasOwn(safeJson(body), 'eligibleAgentIds')) {
    const normalizedEligible = normalizedAgentIds(body.eligibleAgentIds);
    if (normalizedEligible.failure) return normalizedEligible;
    eligibleAgentIds = normalizedEligible.agentIds;
  }
  return {expectedRevision, assignments, eligibleAgentIds};
}

function normalizeAttentionHandoff(body) {
  if (text(body?.action, 40) !== 'handoff') {
    return {failure: requestError(
      'invalid_attention_action',
      '当前接口只接受人工确认的 handoff 操作',
    )};
  }
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return {failure: requestError(
      'invalid_expected_revision',
      'expectedRevision 必须是正整数',
    )};
  }
  const requestKey = normalizedUuid(body?.requestKey);
  const sourceExecutionTaskId = normalizedUuid(body?.sourceExecutionTaskId);
  const targetAgentId = normalizedUuid(body?.targetAgentId);
  if (!requestKey || !sourceExecutionTaskId || !targetAgentId) {
    return {failure: requestError(
      'invalid_handoff_request',
      'requestKey、sourceExecutionTaskId 和 targetAgentId 必须是有效 UUID',
    )};
  }
  return {
    action: 'handoff',
    expectedRevision,
    requestKey,
    sourceExecutionTaskId,
    targetAgentId,
  };
}

function normalizeRetryItems(body) {
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return {failure: requestError(
      'invalid_expected_revision',
      'expectedRevision 必须是正整数',
    )};
  }
  const requestKey = normalizedUuid(body?.requestKey);
  const targetAgentId = normalizedUuid(body?.targetAgentId);
  const sourceItemIds = Array.isArray(body?.itemIds) ? body.itemIds : [];
  const itemIds = [];
  const seen = new Set();
  for (const rawItemId of sourceItemIds) {
    const itemId = normalizedUuid(rawItemId);
    if (!itemId) {
      return {failure: requestError(
        'invalid_retry_item_id',
        'itemIds 必须全部是有效 UUID',
      )};
    }
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    itemIds.push(itemId);
  }
  if (!requestKey || !targetAgentId || itemIds.length === 0) {
    return {failure: requestError(
      'invalid_retry_request',
      'requestKey、targetAgentId 和至少一个 itemId 必须有效',
    )};
  }
  if (itemIds.length > 30) {
    return {failure: requestError(
      'retry_keyword_capacity_exceeded',
      '一次最多重试 30 个关键词',
    )};
  }
  return {
    expectedRevision,
    requestKey,
    targetAgentId,
    itemIds,
    confirmSafety: body?.confirmSafety === true,
  };
}

router.post(
  '/orchestrations/:id/dispatch',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const normalized = normalizeDispatch(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const result = await withTransaction(async tx => {
        // Lock order is part of the dispatch contract: parent, then all items
        // by id, then all selected agents by id.
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (!parent) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        const currentRevision = Number(parent.orchestration_revision || 0);
        const parentExecutionMode =
          parent.metadata?.executionMode === 'unattended_plan'
            ? 'unattended_plan'
            : 'one_time';
        const items = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
          {lock: true},
        );
        if (currentRevision !== normalized.expectedRevision) {
          const distributionMode = text(
            parent.metadata?.distributionMode,
            40,
          ) || 'fixed_batch';
          const requestedAgentIds = [...new Set(
            normalized.eligibleAgentIds.length > 0
              ? normalized.eligibleAgentIds
              : normalized.assignments.map(assignment => assignment.agentId),
          )].sort();
          const committedEligibleAgentIds = Array.isArray(
            parent.metadata?.eligibleAgentIds,
          )
            ? parent.metadata.eligibleAgentIds.map(String).sort()
            : [];
          const requestedAgentByItem = new Map(
            normalized.assignments.map(assignment => [
              assignment.itemId,
              assignment.agentId,
            ]),
          );
          const elasticCommittedReplay =
            distributionMode === 'elastic_pool' &&
            currentRevision === normalized.expectedRevision + 1 &&
            items.length === normalized.assignments.length &&
            requestedAgentIds.length === committedEligibleAgentIds.length &&
            requestedAgentIds.every(
              (agentId, index) => agentId === committedEligibleAgentIds[index],
            );
          const fixedCommittedReplay =
            currentRevision === normalized.expectedRevision + 1 &&
            items.length === normalized.assignments.length &&
            items.every(item =>
              requestedAgentByItem.get(String(item.id)) ===
                String(item.assigned_agent_id || '') &&
              (
                parentExecutionMode === 'unattended_plan'
                  ? !item.execution_task_id && item.status === 'assigned'
                  : Boolean(item.execution_task_id)
              ) &&
              Number(item.assignment_revision || 0) === currentRevision
            );
          const exactCommittedReplay =
            elasticCommittedReplay || fixedCommittedReplay;
          if (exactCommittedReplay) {
            const schedule = parentExecutionMode === 'unattended_plan'
              ? await tx.queryOne(`
                  SELECT id, status, schedule_mode, timezone, start_time,
                    random_offset_min, custom_dates, distribution_mode,
                    next_run_at,
                    last_run_at, last_run_task_id, run_count, revision
                  FROM capture_orchestration_schedules
                  WHERE tenant_id = $1 AND template_task_id = $2
                `, [req.tenantId, parent.id])
              : null;
            const children = await tx.queryAll(`
              SELECT child.id, child.assigned_agent_id, child.status,
                child.metadata, ca.last_heartbeat_at,
                command.id AS command_id
              FROM capture_tasks child
              LEFT JOIN capture_agents ca
                ON ca.id = child.assigned_agent_id
                AND ca.tenant_id = child.tenant_id
              LEFT JOIN LATERAL (
                SELECT c.id
                FROM capture_agent_commands c
                WHERE c.tenant_id = child.tenant_id
                  AND c.task_id = child.id
                  AND c.command_type = 'create'
                ORDER BY c.created_at DESC, c.id DESC
                LIMIT 1
              ) command ON true
              WHERE child.tenant_id = $1 AND child.parent_task_id = $2
              ORDER BY child.created_at, child.id
            `, [req.tenantId, parent.id]);
            return {
              parent,
              existing: true,
              schedule,
              executions: children.map(child => {
                const childItems = items.filter(
                  item => String(item.execution_task_id) === String(child.id),
                );
                return {
                  taskId: child.id,
                  agentId: child.assigned_agent_id,
                  commandId: child.command_id,
                  itemIds: childItems.map(item => item.id),
                  keywords: childItems
                    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
                    .map(item => item.keyword),
                  status: child.status,
                  agentOnline: captureAgentOnline(child.last_heartbeat_at),
                };
              }),
            };
          }
          return {failure: requestError(
            'revision_conflict',
            '编排任务已被更新，请刷新后重新分配',
            409,
            {currentRevision},
          )};
        }
        if (items.length !== normalized.assignments.length) {
          return {failure: requestError(
            'assignment_coverage_mismatch',
            '必须为编排任务的每个关键词恰好分配一个执行节点',
            400,
          )};
        }
        const itemById = new Map(
          items.map(item => [String(item.id), item]),
        );
        for (const assignment of normalized.assignments) {
          if (!itemById.has(assignment.itemId)) {
            return {failure: requestError(
              'assignment_item_mismatch',
              '分配中包含不属于当前编排任务的关键词',
              400,
              {itemId: assignment.itemId},
            )};
          }
        }
        if (
          items.some(item =>
            item.status !== 'pending' ||
            item.assigned_agent_id ||
            item.execution_task_id
          )
        ) {
          return {failure: requestError(
            'orchestration_already_dispatched',
            '编排任务已经下发，当前版本不支持重新分配',
            409,
          )};
        }
        const distributionMode = parent.metadata?.distributionMode === 'elastic_pool'
          ? 'elastic_pool'
          : 'fixed_batch';
        const assignmentAgentIds = [...new Set(
          normalized.assignments.map(assignment => assignment.agentId),
        )];
        const agentIds = distributionMode === 'elastic_pool' &&
          normalized.eligibleAgentIds.length > 0
          ? normalized.eligibleAgentIds
          : assignmentAgentIds;
        const planSnapshot = safeJson(parent.metadata?.planSnapshot);
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          agentIds,
          parent.platform,
          planSnapshot,
          {lock: true},
        );
        if (compatible.failure) return {failure: compatible.failure};

        const assignmentsByAgent = new Map();
        for (const assignment of normalized.assignments) {
          if (!assignmentsByAgent.has(assignment.agentId)) {
            assignmentsByAgent.set(assignment.agentId, []);
          }
          assignmentsByAgent
            .get(assignment.agentId)
            .push(itemById.get(assignment.itemId));
        }
        for (const groupItems of assignmentsByAgent.values()) {
          groupItems.sort(
            (left, right) => Number(left.ordinal) - Number(right.ordinal),
          );
        }
        const oversizedGroup = distributionMode === 'fixed_batch'
          ? [...assignmentsByAgent.entries()].find(
              ([, groupItems]) => groupItems.length > 30,
            )
          : null;
        if (oversizedGroup) {
          return {failure: requestError(
            'agent_keyword_capacity_exceeded',
            '单个执行节点一次最多接收 30 个关键词',
            409,
            {
              agentId: oversizedGroup[0],
              keywordCount: oversizedGroup[1].length,
            },
          )};
        }

        const nextRevision = currentRevision + 1;
        if (parentExecutionMode === 'unattended_plan') {
          const scheduleId = crypto.randomUUID();
          const nextRunAt = computeNextOrchestrationRunAt(planSnapshot, {
            after: new Date(),
            seed: scheduleId,
          });
          if (!nextRunAt) {
            return {failure: requestError(
              'schedule_has_no_future_run',
              '无人值守计划没有未来可执行时间，请调整日期或开始时间',
              400,
            )};
          }
          const scheduleMode = planSnapshot.mode === 'custom_dates'
            ? 'custom_dates'
            : 'daily';
          const customDates = scheduleMode === 'custom_dates'
            ? String(planSnapshot.customDates || '')
              .split(/\r?\n/gu)
              .map(value => value.trim())
              .filter(Boolean)
            : [];
          const schedule = await tx.queryOne(`
            INSERT INTO capture_orchestration_schedules (
              id, tenant_id, template_task_id, title, platform, status,
              schedule_mode, timezone, start_time, random_offset_min,
              custom_dates, overlap_policy, late_start_grace_min,
              allocation_mode, distribution_mode, revision, plan_snapshot,
              next_run_at,
              created_by_user_id, created_by_name
            ) VALUES (
              $1, $2, $3, $4, $5, 'active',
              $6, 'Asia/Shanghai', $7, $8,
              $9::date[], 'skip', $10,
              'balanced', $11, 1, $12::jsonb, $13,
              $14, $15
            )
            RETURNING id, status, schedule_mode, timezone, start_time,
              random_offset_min, custom_dates, distribution_mode, next_run_at,
              last_run_at, last_run_task_id, run_count, revision
          `, [
            scheduleId,
            req.tenantId,
            parent.id,
            parent.title,
            parent.platform,
            scheduleMode,
            planSnapshot.startTime || '09:00',
            Number(planSnapshot.randomOffsetMin || 0),
            customDates,
            Number(planSnapshot.lateStartGraceMin || 360),
            distributionMode,
            JSON.stringify(planSnapshot),
            nextRunAt,
            req.user?.id || null,
            text(req.actorName, 240),
          ]);
          const orderedAgentIds = distributionMode === 'elastic_pool'
            ? [...agentIds]
            : [];
          const seenAgentIds = new Set(orderedAgentIds);
          if (distributionMode === 'fixed_batch') {
            for (const assignment of normalized.assignments) {
              if (seenAgentIds.has(assignment.agentId)) continue;
              seenAgentIds.add(assignment.agentId);
              orderedAgentIds.push(assignment.agentId);
            }
          }
          for (let index = 0; index < orderedAgentIds.length; index += 1) {
            await tx.execute(`
              INSERT INTO capture_orchestration_schedule_agents (
                schedule_id, tenant_id, agent_id, ordinal
              ) VALUES ($1, $2, $3, $4)
            `, [schedule.id, req.tenantId, orderedAgentIds[index], index]);
          }
          for (const assignment of normalized.assignments) {
            const updatedItem = await tx.queryOne(`
              UPDATE capture_task_items
              SET status = CASE
                    WHEN $1 = 'elastic_pool' THEN 'pending'
                    ELSE 'assigned'
                  END,
                assigned_agent_id = CASE
                  WHEN $1 = 'elastic_pool' THEN NULL
                  ELSE $2::uuid
                END,
                assignment_revision = $3,
                assigned_at = CASE
                  WHEN $1 = 'elastic_pool' THEN NULL
                  ELSE now()
                END,
                updated_at = now()
              WHERE id = $4 AND tenant_id = $5 AND task_id = $6
                AND status = 'pending'
                AND assigned_agent_id IS NULL
                AND execution_task_id IS NULL
              RETURNING id
            `, [
              distributionMode,
              assignment.agentId,
              nextRevision,
              assignment.itemId,
              req.tenantId,
              parent.id,
            ]);
            if (!updatedItem) {
              const conflict = new Error('orchestration_item_assignment_conflict');
              conflict.code = 'orchestration_item_assignment_conflict';
              throw conflict;
            }
          }
          const parentUpdate = await tx.queryOne(`
            UPDATE capture_tasks
            SET orchestration_revision = orchestration_revision + 1,
              orchestration_schedule_id = $1,
              schedule_revision = 1,
              status = 'pending',
              progress = $2::jsonb,
              counts = counts || $3::jsonb,
              metadata = (metadata - 'draft') || jsonb_build_object(
                'publishedAt', now(),
                'orchestrationTemplate', true,
                'scheduleId', $1::uuid::text,
                'scheduleStatus', 'active',
                'nextRunAt', $4::timestamptz::text,
                'distributionMode', $8::text,
                'eligibleAgentIds', $9::jsonb
              ),
              message = CASE
                WHEN $8 = 'elastic_pool'
                  THEN '弹性节点池无人值守计划已启用，工作项将在运行时动态领取'
                ELSE '多 Agent 无人值守计划已启用，等待下一次云端运行'
              END,
              updated_at = now(),
              source_updated_at = now()
            WHERE id = $5 AND tenant_id = $6
              AND task_type = 'capture_orchestration'
              AND orchestration_revision = $7
            RETURNING id, orchestration_revision, status,
              orchestration_schedule_id
          `, [
            schedule.id,
            JSON.stringify({
              current: 0,
              total: items.length,
              phase: 'scheduled',
              nextRunAt,
            }),
            JSON.stringify({
              total: items.length,
              assigned: distributionMode === 'elastic_pool' ? 0 : items.length,
            }),
            nextRunAt,
            parent.id,
            req.tenantId,
            currentRevision,
            distributionMode,
            JSON.stringify(orderedAgentIds),
          ]);
          if (!parentUpdate) {
            const conflict = new Error('orchestration_revision_conflict');
            conflict.code = 'orchestration_revision_conflict';
            throw conflict;
          }
          await appendEvent(tx, {
            tenantId: req.tenantId,
            taskId: parent.id,
            eventType: 'orchestration_schedule_created',
            actorId: req.user?.id || '',
            actorName: req.actorName,
            status: parentUpdate.status,
            message: distributionMode === 'elastic_pool'
              ? '弹性节点池无人值守计划已启用'
              : '多 Agent 无人值守计划已按确认分配启用',
            payload: {
              scheduleId: schedule.id,
              revision: parentUpdate.orchestration_revision,
              itemCount: items.length,
              agentIds: orderedAgentIds,
              nextRunAt,
              scheduleMode,
              distributionMode,
            },
          });
          return {
            parent: parentUpdate,
            schedule,
            executions: [],
          };
        }

        if (distributionMode === 'elastic_pool') {
          const eligibleAgentIds = [...agentIds].sort(
            (left, right) => left.localeCompare(right),
          );
          const parentUpdate = await tx.queryOne(`
            UPDATE capture_tasks
            SET orchestration_revision = orchestration_revision + 1,
              status = 'pending',
              progress = $1::jsonb,
              counts = counts || $2::jsonb,
              metadata = (metadata - 'draft') || jsonb_build_object(
                'publishedAt', now(),
                'distributionMode', 'elastic_pool',
                'eligibleAgentIds', $3::jsonb,
                'claimUnit', 'keyword'
              ),
              message = '关键词已进入云端队列，空闲节点将逐个领取',
              updated_at = now(),
              source_updated_at = now()
            WHERE id = $4 AND tenant_id = $5
              AND task_type = 'capture_orchestration'
              AND orchestration_revision = $6
            RETURNING id, orchestration_revision, status
          `, [
            JSON.stringify({
              current: 0,
              total: items.length,
              phase: 'queued',
            }),
            JSON.stringify({
              total: items.length,
              assigned: 0,
            }),
            JSON.stringify(eligibleAgentIds),
            parent.id,
            req.tenantId,
            currentRevision,
          ]);
          if (!parentUpdate) {
            const conflict = new Error('orchestration_revision_conflict');
            conflict.code = 'orchestration_revision_conflict';
            throw conflict;
          }
          await appendEvent(tx, {
            tenantId: req.tenantId,
            taskId: parent.id,
            eventType: 'orchestration_elastic_pool_opened',
            actorId: req.user?.id || '',
            actorName: req.actorName,
            status: parentUpdate.status,
            message: '关键词云端队列已开启，空闲节点将逐个领取',
            payload: {
              revision: parentUpdate.orchestration_revision,
              itemCount: items.length,
              eligibleAgentIds,
              claimUnit: 'keyword',
            },
          });
          return {
            parent: parentUpdate,
            executions: [],
          };
        }

        const executions = [];
        const sortedAgentIds = [...assignmentsByAgent.keys()].sort(
          (left, right) => left.localeCompare(right),
        );
        for (
          let groupIndex = 0;
          groupIndex < sortedAgentIds.length;
          groupIndex += 1
        ) {
          const agentId = sortedAgentIds[groupIndex];
          const agent = compatible.agentsById.get(agentId);
          const groupItems = assignmentsByAgent.get(agentId);
          const childTaskId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          const childTitle = sortedAgentIds.length === 1
            ? parent.title
            : `${parent.title} · ${groupIndex + 1}/${sortedAgentIds.length}`;
          const childTaskInput = normalizeRemoteTaskInput({
            clientTaskId: childTaskId,
            title: childTitle,
            executionMode: 'one_time',
            planSnapshot: {
              ...planSnapshot,
              enabled: true,
              platform: parent.platform,
              keywords: groupItems.map(item => item.keyword),
            },
          });
          const childRequestHash = hashOrchestrationRequest({
            parentTaskId: parent.id,
            revision: nextRevision,
            agentId,
            taskInput: childTaskInput,
          });
          const childPlan = childTaskInput.planSnapshot;
          const total =
            childPlan.keywords.length * Math.max(1, Number(childPlan.maxRounds) || 1);
          const childMetadata = {
            remoteCreated: true,
            remoteRequestHash: childRequestHash,
            createCommandId: commandId,
            requestedByUserId: req.user?.id || '',
            requestedByName: text(req.actorName, 240),
            executionMode: 'one_time',
            planSnapshot: childPlan,
            orchestrationChild: true,
            parentTaskId: parent.id,
            orchestrationRevision: nextRevision,
            itemIds: groupItems.map(item => item.id),
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
              'cloud', 'orchestration_dispatch', 'pending',
              $7::jsonb, $8::jsonb, $9::jsonb,
              $10::jsonb, '编排子任务已创建，等待目标设备领取', now()
            )
            RETURNING id, parent_task_id, assigned_agent_id, client_task_id,
              task_type, title, platform, status, progress, counts, metadata,
              created_at, updated_at
          `, [
            childTaskId,
            req.tenantId,
            parent.id,
            agentId,
            childTaskInput.title,
            parent.platform,
            JSON.stringify({current: 0, total, phase: 'queued'}),
            JSON.stringify({round: 1, keywordIndex: 0}),
            JSON.stringify({
              total,
              processed: 0,
              success: 0,
              failed: 0,
              skipped: 0,
            }),
            JSON.stringify(childMetadata),
          ]);
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
            req.tenantId,
            agentId,
            child.id,
            JSON.stringify({
              taskId: child.id,
              clientTaskId: child.id,
              title: child.title,
              executionMode: 'one_time',
              platform: childPlan.platform,
              planSnapshot: childPlan,
              requestHash: childRequestHash,
              authCodeId: agent.auth_code_id,
              authBindingId: agent.auth_binding_id,
              orchestration: {
                parentTaskId: parent.id,
                revision: nextRevision,
                itemIds: groupItems.map(item => item.id),
              },
            }),
            req.user?.id || null,
            text(req.actorName, 240),
          ]);
          for (const item of groupItems) {
            const updatedItem = await tx.queryOne(`
              UPDATE capture_task_items
              SET status = 'dispatched',
                attempt_count = attempt_count + 1,
                assigned_agent_id = $1,
                execution_task_id = $2,
                assignment_revision = $3,
                request_hash = $4,
                assigned_at = now(),
                dispatched_at = now(),
                updated_at = now()
              WHERE id = $5 AND tenant_id = $6 AND task_id = $7
                AND status = 'pending'
                AND assigned_agent_id IS NULL
                AND execution_task_id IS NULL
              RETURNING id
            `, [
              agentId,
              child.id,
              nextRevision,
              childRequestHash,
              item.id,
              req.tenantId,
              parent.id,
            ]);
            if (!updatedItem) {
              const conflict = new Error('orchestration_item_assignment_conflict');
              conflict.code = 'orchestration_item_assignment_conflict';
              throw conflict;
            }
            await tx.execute(`
              INSERT INTO capture_task_item_attempts (
                id, tenant_id, item_id, parent_task_id, execution_task_id,
                agent_id, agent_display_name,
                attempt_number, assignment_revision, status,
                request_hash, checkpoint, result, error, dispatched_at
              ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, 1, $8, 'dispatched',
                $9, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
              )
            `, [
              crypto.randomUUID(),
              req.tenantId,
              item.id,
              parent.id,
              child.id,
              agentId,
              text(agent.display_name, 240),
              nextRevision,
              childRequestHash,
            ]);
          }
          await appendEvent(tx, {
            tenantId: req.tenantId,
            taskId: child.id,
            agentId,
            eventType: 'orchestration_child_dispatched',
            actorId: req.user?.id || '',
            actorName: req.actorName,
            status: child.status,
            message: '编排子任务已向指定节点下发',
            payload: {
              parentTaskId: parent.id,
              revision: nextRevision,
              commandId: command.id,
              itemIds: groupItems.map(item => item.id),
              keywords: groupItems.map(item => item.keyword),
            },
          });
          executions.push({
            taskId: child.id,
            agentId,
            commandId: command.id,
            itemIds: groupItems.map(item => item.id),
            keywords: groupItems.map(item => item.keyword),
            status: child.status,
            agentOnline: captureAgentOnline(agent.last_heartbeat_at),
          });
        }
        const parentUpdate = await tx.queryOne(`
          UPDATE capture_tasks
          SET orchestration_revision = orchestration_revision + 1,
            status = 'pending',
            progress = $1::jsonb,
            counts = counts || $2::jsonb,
            metadata = (metadata - 'draft') || jsonb_build_object(
              'publishedAt', now()
            ),
            message = '编排任务已分配并下发到执行节点',
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $3 AND tenant_id = $4
            AND task_type = 'capture_orchestration'
            AND orchestration_revision = $5
          RETURNING id, orchestration_revision, status
        `, [
          JSON.stringify({
            current: 0,
            total: items.length,
            phase: 'dispatched',
          }),
          JSON.stringify({
            total: items.length,
            assigned: items.length,
          }),
          parent.id,
          req.tenantId,
          currentRevision,
        ]);
        if (!parentUpdate) {
          const conflict = new Error('orchestration_revision_conflict');
          conflict.code = 'orchestration_revision_conflict';
          throw conflict;
        }
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_dispatched',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parentUpdate.status,
          message: '编排任务已按确认方案下发',
          payload: {
            revision: parentUpdate.orchestration_revision,
            executionCount: executions.length,
            itemCount: items.length,
            executions,
          },
        });
        return {
          parent: parentUpdate,
          executions,
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        idempotent: result.existing === true,
        orchestrationId: result.parent.id,
        revision: Number(result.parent.orchestration_revision),
        status: result.parent.status,
        schedule: result.schedule || null,
        executions: result.executions,
      });
    } catch (error) {
      if (
        error?.code === 'orchestration_revision_conflict' ||
        error?.code === 'orchestration_item_assignment_conflict'
      ) {
        return sendRequestError(res, requestError(
          'dispatch_conflict',
          '编排任务在下发时发生并发更新，请刷新后重试',
          409,
        ));
      }
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/stop',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        // Negative-patrol reassignment has to lock Agent rows before items.
        // A parent-scoped advisory fence serializes it with operator stop and
        // prevents the two valid row-lock orders from deadlocking each other.
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['capture_orchestration_control', orchestrationId],
        );
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (!parent) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        const parentMetadata = safeJson(parent.metadata);
        if (parentMetadata.orchestrationTemplate === true) {
          return {failure: requestError(
            'orchestration_schedule_template_stop_unsupported',
            '这是无人值守计划模板，请使用暂停计划；停止全部只终止具体运行批次',
            409,
          )};
        }

        const loadExecutionTaskIds = async () => {
          const rows = await tx.queryAll(`
            SELECT id
            FROM capture_tasks
            WHERE tenant_id = $1
              AND parent_task_id = $2
              AND status = ANY($3::text[])
            ORDER BY id
          `, [
            req.tenantId,
            parent.id,
            ORCHESTRATION_STOPPABLE_EXECUTION_STATUSES,
          ]);
          return rows.map(row => row.id);
        };

        if (parent.status === 'canceled') {
          return {
            parent,
            existing: true,
            canceledItemCount: 0,
            executionTaskIds: await loadExecutionTaskIds(),
          };
        }
        if (!ORCHESTRATION_STOPPABLE_STATUSES.has(parent.status)) {
          return {failure: requestError(
            'orchestration_not_stoppable',
            '编排任务当前状态不能停止',
            409,
            {status: parent.status},
          )};
        }

        // Parent -> item is the same lock order used by dispatch/retry and
        // heartbeat projection. Once the parent is locked, no new handoff can
        // enter this orchestration while the operator stop is settling it.
        await listParentItems(tx, req.tenantId, parent.id, {lock: true});
        const canceledItems = await tx.queryAll(`
          UPDATE capture_task_items
          SET status = 'canceled',
            metadata = metadata || jsonb_build_object(
              'operatorStopped', true,
              'operatorStoppedAt', now()
            ),
            finished_at = COALESCE(finished_at, now()),
            updated_at = now()
          WHERE tenant_id = $1
            AND task_id = $2
            AND status NOT IN (
              'completed', 'completed_with_warnings', 'skipped', 'canceled'
            )
          RETURNING id
        `, [req.tenantId, parent.id]);
        await tx.execute(`
          UPDATE capture_task_item_attempts attempt
          SET status = 'canceled',
            finished_at = COALESCE(attempt.finished_at, now()),
            updated_at = now()
          FROM capture_task_items item
          WHERE item.id = attempt.item_id
            AND item.tenant_id = $1
            AND item.task_id = $2
            AND item.status = 'canceled'
            AND attempt.parent_task_id = $2
            AND attempt.status NOT IN (
              'completed', 'completed_with_warnings',
              'failed', 'skipped', 'canceled'
            )
        `, [req.tenantId, parent.id]);
        const settledItems = await tx.queryAll(`
          SELECT status
          FROM capture_task_items
          WHERE tenant_id = $1 AND task_id = $2
          ORDER BY ordinal, id
        `, [req.tenantId, parent.id]);
        const aggregate = aggregateParentTaskItems(settledItems);
        const stoppedAt = new Date().toISOString();
        const parentUpdate = await tx.queryOne(`
          UPDATE capture_tasks
          SET status = 'canceled',
            progress = $1::jsonb,
            counts = $2::jsonb,
            metadata = metadata || jsonb_build_object(
              'operatorStopped', true,
              'operatorStoppedAt', $3::text,
              'operatorStoppedByUserId', $4::text,
              'operatorStoppedByName', $5::text,
              'automaticRetryDisabled', true
            ),
            message = '任务已停止，已完成结果保留，未完成项不再自动接力',
            orchestration_revision = orchestration_revision + 1,
            attention_dismissed_at = COALESCE(attention_dismissed_at, now()),
            finished_at = COALESCE(finished_at, now()),
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $6 AND tenant_id = $7
          RETURNING id, status, progress, counts, metadata,
            orchestration_revision, finished_at
        `, [
          JSON.stringify({...aggregate.progress, phase: 'canceled'}),
          JSON.stringify(aggregate.counts),
          stoppedAt,
          text(req.user?.id, 240),
          text(req.actorName, 240),
          parent.id,
          req.tenantId,
        ]);
        const executionTaskIds = await loadExecutionTaskIds();

        if (
          parent.orchestration_schedule_id &&
          parentMetadata.orchestrationScheduleRun === true
        ) {
          const schedule = await tx.queryOne(`
            UPDATE capture_orchestration_schedules
            SET last_run_at = COALESCE(last_run_at, now()),
              last_run_status = 'canceled',
              last_error = '{}'::jsonb,
              updated_at = now()
            WHERE id = $1
              AND tenant_id = $2
              AND last_run_task_id = $3
            RETURNING template_task_id, status, next_run_at, last_run_at
          `, [
            parent.orchestration_schedule_id,
            req.tenantId,
            parent.id,
          ]);
          if (schedule) {
            await tx.execute(`
              UPDATE capture_tasks
              SET metadata = metadata || jsonb_build_object(
                  'scheduleStatus', $1::text,
                  'nextRunAt', COALESCE($2::timestamptz::text, ''),
                  'lastRunAt', COALESCE($3::timestamptz::text, ''),
                  'lastRunStatus', 'canceled',
                  'lastRunTaskId', $4::uuid::text
                ),
                message = '上一轮多 Agent 任务已停止，计划等待下一次运行',
                updated_at = now(),
                source_updated_at = now()
              WHERE id = $5 AND tenant_id = $6
            `, [
              schedule.status,
              schedule.next_run_at,
              schedule.last_run_at,
              parent.id,
              schedule.template_task_id,
              req.tenantId,
            ]);
          }
        }

        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_stopped',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: 'canceled',
          message: '运营人员已停止整个编排任务，未完成项不再自动接力',
          payload: {
            previousStatus: parent.status,
            revision: parentUpdate.orchestration_revision,
            canceledItemCount: canceledItems.length,
            executionTaskIds,
          },
        });
        return {
          parent: parentUpdate,
          existing: false,
          canceledItemCount: canceledItems.length,
          executionTaskIds,
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        existing: result.existing === true,
        status: 'canceled',
        revision: Number(result.parent.orchestration_revision || 0),
        canceledItemCount: result.canceledItemCount,
        executionTaskIds: result.executionTaskIds,
        message: result.existing
          ? '任务已经停止'
          : '整个任务已停止；已完成结果保留，未完成项不再自动接力',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  '/orchestrations/:id/schedule',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const normalized = normalizeScheduleUpdate(req.body, orchestrationId);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const result = await withTransaction(async tx => {
        const parentSnapshot = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (!parentSnapshot) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        if (
          !parentSnapshot.orchestration_schedule_id ||
          parentSnapshot.metadata?.orchestrationTemplate !== true
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '当前编排任务不是可编辑的无人值守计划',
            409,
          )};
        }

        // Match the scheduler and pause/resume lock order. A due occurrence
        // either materializes completely before this edit, or waits and sees
        // the new template; an already-created run is never rewritten.
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          parentSnapshot.orchestration_schedule_id,
          {lock: true},
        );
        if (!schedule) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '无人值守计划不存在',
            404,
          )};
        }
        if (schedule.archived_at) {
          return {failure: requestError(
            'orchestration_schedule_archived',
            '归档计划不能直接编辑，请先恢复为暂停状态',
            409,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (
          !parent ||
          String(parent.orchestration_schedule_id || '') !== String(schedule.id)
        ) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        if (!['active', 'paused', 'completed'].includes(schedule.status)) {
          return {failure: requestError(
            'orchestration_schedule_not_editable',
            '当前无人值守计划不能编辑',
            409,
          )};
        }
        const currentRevision = Number(schedule.revision || 0);
        if (currentRevision !== normalized.expectedRevision) {
          return {failure: requestError(
            'schedule_revision_conflict',
            '计划已被更新，请刷新后重新编辑',
            409,
            {currentRevision},
          )};
        }

        const {request, agentIds} = normalized;
        const planSnapshot = request.taskInput.planSnapshot;
        const distributionMode = request.distributionMode;
        const nextRunAt = computeNextOrchestrationRunAt(planSnapshot, {
          after: new Date(),
          seed: schedule.id,
        });
        if (!nextRunAt) {
          return {failure: requestError(
            'schedule_has_no_future_run',
            '无人值守计划没有未来可执行时间，请调整日期或开始时间',
            400,
          )};
        }
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          agentIds,
          request.platform,
          planSnapshot,
          {lock: true},
        );
        if (compatible.failure) return {failure: compatible.failure};

        const nextScheduleRevision = currentRevision + 1;
        const allocation = allocateKeywordWorkItems({
          keywords: request.keywords,
          agentIds,
          revision: nextScheduleRevision,
        });
        if (
          distributionMode === 'fixed_batch' &&
          allocation.groups.some(group => group.keywords.length > 30)
        ) {
          return {failure: requestError(
            'insufficient_agents',
            '固定分配时，所选节点不足以承载全部关键词，请增加执行节点',
            409,
            {minimumAgentCount: Math.ceil(request.keywords.length / 30)},
          )};
        }

        const existingItems = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
          {lock: true},
        );
        const usedTemplateItem = existingItems.find(item =>
          Number(item.attempt_count || 0) > 0 ||
          Boolean(item.execution_task_id) ||
          Boolean(item.dispatched_at) ||
          Boolean(item.started_at) ||
          Boolean(item.finished_at) ||
          !['pending', 'assigned'].includes(item.status)
        );
        const templateAttempt = await tx.queryOne(`
          SELECT attempt.id
          FROM capture_task_item_attempts attempt
          WHERE attempt.tenant_id = $1 AND attempt.parent_task_id = $2
          LIMIT 1
        `, [req.tenantId, parent.id]);
        if (usedTemplateItem || templateAttempt) {
          return {failure: requestError(
            'orchestration_template_items_not_editable',
            '计划模板的工作项已产生执行记录，不能直接改写，请联系管理员检查',
            409,
          )};
        }

        const previousAgentRows = await tx.queryAll(`
          SELECT agent_id
          FROM capture_orchestration_schedule_agents
          WHERE tenant_id = $1 AND schedule_id = $2
          ORDER BY ordinal, agent_id
          FOR UPDATE
        `, [req.tenantId, schedule.id]);
        const previousAgentIds = previousAgentRows.map(row => String(row.agent_id));
        const assignmentByKeyword = new Map(
          allocation.items.map(item => [item.keyword, item.assignedAgentId]),
        );
        const existingByKeyword = new Map(
          existingItems.map(item => [String(item.keyword || '').trim(), item]),
        );
        const retainedItemIds = new Set();
        for (let index = 0; index < request.keywords.length; index += 1) {
          const keyword = request.keywords[index];
          const existingItem = existingByKeyword.get(keyword);
          const assignedAgentId = distributionMode === 'fixed_batch'
            ? assignmentByKeyword.get(keyword) || null
            : null;
          const itemStatus = assignedAgentId ? 'assigned' : 'pending';
          const itemMetadata = JSON.stringify({keyword, ordinal: index});
          if (existingItem) {
            retainedItemIds.add(String(existingItem.id));
            await tx.execute(`
              UPDATE capture_task_items
              SET item_key = $1,
                ordinal = $2,
                keyword = $3,
                platform = $4,
                status = $5,
                assigned_agent_id = $6::uuid,
                execution_task_id = NULL,
                assignment_revision = $7,
                request_hash = '',
                error = '{}'::jsonb,
                metadata = $8::jsonb,
                assigned_at = CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
                dispatched_at = NULL,
                started_at = NULL,
                finished_at = NULL,
                updated_at = now()
              WHERE id = $9 AND tenant_id = $10 AND task_id = $11
            `, [
              keywordItemKey(keyword, index),
              index,
              keyword,
              request.platform,
              itemStatus,
              assignedAgentId,
              nextScheduleRevision,
              itemMetadata,
              existingItem.id,
              req.tenantId,
              parent.id,
            ]);
          } else {
            await tx.execute(`
              INSERT INTO capture_task_items (
                id, tenant_id, task_id, item_key, ordinal, keyword,
                platform, item_type, status, assigned_agent_id,
                assignment_revision, metadata, assigned_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, 'keyword', $8, $9::uuid,
                $10, $11::jsonb,
                CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END
              )
            `, [
              crypto.randomUUID(),
              req.tenantId,
              parent.id,
              keywordItemKey(keyword, index),
              index,
              keyword,
              request.platform,
              itemStatus,
              assignedAgentId,
              nextScheduleRevision,
              itemMetadata,
            ]);
          }
        }
        const removedItemIds = existingItems
          .map(item => String(item.id))
          .filter(itemId => !retainedItemIds.has(itemId));
        if (removedItemIds.length > 0) {
          await tx.execute(`
            DELETE FROM capture_task_items
            WHERE tenant_id = $1 AND task_id = $2
              AND id = ANY($3::uuid[])
          `, [req.tenantId, parent.id, removedItemIds]);
        }

        await tx.execute(`
          DELETE FROM capture_orchestration_schedule_agents
          WHERE tenant_id = $1 AND schedule_id = $2
        `, [req.tenantId, schedule.id]);
        for (let index = 0; index < agentIds.length; index += 1) {
          await tx.execute(`
            INSERT INTO capture_orchestration_schedule_agents (
              schedule_id, tenant_id, agent_id, ordinal
            ) VALUES ($1, $2, $3, $4)
          `, [schedule.id, req.tenantId, agentIds[index], index]);
        }

        const scheduleMode = planSnapshot.mode === 'custom_dates'
          ? 'custom_dates'
          : 'daily';
        const customDates = scheduleMode === 'custom_dates'
          ? String(planSnapshot.customDates || '')
            .split(/\r?\n/gu)
            .map(value => value.trim())
            .filter(Boolean)
          : [];
        const nextStatus = schedule.status === 'completed'
          ? 'active'
          : schedule.status;
        const updatedSchedule = await tx.queryOne(`
          UPDATE capture_orchestration_schedules
          SET title = $1,
            platform = $2,
            status = $3,
            schedule_mode = $4,
            start_time = $5,
            random_offset_min = $6,
            custom_dates = $7::date[],
            late_start_grace_min = $8,
            distribution_mode = $9,
            plan_snapshot = $10::jsonb,
            next_run_at = $11,
            last_error = '{}'::jsonb,
            revision = revision + 1,
            updated_at = now()
          WHERE id = $12 AND tenant_id = $13 AND revision = $14
          RETURNING id, revision, status
        `, [
          request.title,
          request.platform,
          nextStatus,
          scheduleMode,
          planSnapshot.startTime || '09:00',
          Number(planSnapshot.randomOffsetMin || 0),
          customDates,
          Number(planSnapshot.lateStartGraceMin || 360),
          distributionMode,
          JSON.stringify(planSnapshot),
          nextRunAt,
          schedule.id,
          req.tenantId,
          currentRevision,
        ]);
        if (!updatedSchedule) {
          const conflict = new Error('orchestration_schedule_revision_conflict');
          conflict.code = 'orchestration_schedule_revision_conflict';
          throw conflict;
        }

        const nextMetadata = {
          ...safeJson(parent.metadata),
          draft: undefined,
          executionMode: 'unattended_plan',
          allocationMode: 'balanced',
          distributionMode,
          eligibleAgentIds: agentIds,
          claimUnit: distributionMode === 'elastic_pool' ? 'keyword' : 'fixed_batch',
          planSnapshot,
          scheduleId: schedule.id,
          scheduleStatus: nextStatus,
          scheduleRevision: nextScheduleRevision,
          nextRunAt,
          orchestrationTemplate: true,
          updatedByUserId: req.user?.id || '',
          updatedByName: text(req.actorName, 240),
          planUpdatedAt: new Date().toISOString(),
        };
        delete nextMetadata.draft;
        const parentUpdate = await tx.queryOne(`
          UPDATE capture_tasks
          SET title = $1,
            platform = $2,
            orchestration_revision = orchestration_revision + 1,
            schedule_revision = $3,
            progress = $4::jsonb,
            counts = $5::jsonb,
            metadata = $6::jsonb,
            message = $7,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $8 AND tenant_id = $9
            AND task_type = 'capture_orchestration'
            AND orchestration_schedule_id = $10
          RETURNING id, title, platform, status, orchestration_revision,
            schedule_revision
        `, [
          request.title,
          request.platform,
          nextScheduleRevision,
          JSON.stringify({
            current: 0,
            total: request.keywords.length,
            phase: nextStatus === 'paused' ? 'paused' : 'scheduled',
            nextRunAt,
          }),
          JSON.stringify({
            total: request.keywords.length,
            assigned: distributionMode === 'fixed_batch'
              ? request.keywords.length
              : 0,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          }),
          JSON.stringify(nextMetadata),
          nextStatus === 'paused'
            ? '无人值守计划已保存，仍保持暂停'
            : distributionMode === 'elastic_pool'
              ? '无人值守计划已更新，下一轮将使用弹性节点池'
              : '无人值守计划已更新，下一轮将使用固定分配',
          parent.id,
          req.tenantId,
          schedule.id,
        ]);
        if (!parentUpdate) {
          const conflict = new Error('orchestration_schedule_parent_conflict');
          conflict.code = 'orchestration_schedule_parent_conflict';
          throw conflict;
        }

        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_schedule_updated',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parentUpdate.status,
          message: '无人值守计划已编辑；已生成的运行批次保持不变',
          payload: {
            scheduleId: schedule.id,
            previousRevision: currentRevision,
            revision: nextScheduleRevision,
            previous: {
              title: schedule.title,
              platform: schedule.platform,
              scheduleMode: schedule.schedule_mode,
              startTime: schedule.start_time,
              randomOffsetMin: schedule.random_offset_min,
              distributionMode: schedule.distribution_mode,
              keywordCount: existingItems.length,
              agentIds: previousAgentIds,
            },
            next: {
              title: request.title,
              platform: request.platform,
              scheduleMode,
              startTime: planSnapshot.startTime,
              randomOffsetMin: planSnapshot.randomOffsetMin,
              distributionMode,
              keywordCount: request.keywords.length,
              agentIds,
              nextRunAt,
            },
          },
        });
        const responseSchedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          schedule.id,
        );
        return {
          schedule: responseSchedule,
          parent: parentUpdate,
          itemCount: request.keywords.length,
          agentIds,
          reactivated: schedule.status === 'completed',
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        orchestrationId: result.parent.id,
        revision: Number(result.parent.orchestration_revision || 0),
        schedule: result.schedule,
        itemCount: result.itemCount,
        agentIds: result.agentIds,
        message: result.reactivated
          ? '计划已保存并重新启用；修改从下一次运行开始生效'
          : result.schedule.status === 'paused'
            ? '计划已保存并保持暂停；重新启用后按新设置运行'
            : '计划已保存；修改从下一次运行开始生效',
      });
    } catch (error) {
      if (
        error?.code === 'orchestration_schedule_revision_conflict' ||
        error?.code === 'orchestration_schedule_parent_conflict'
      ) {
        return sendRequestError(res, requestError(
          'schedule_update_conflict',
          '计划编辑时发生并发更新，请刷新后重试',
          409,
        ));
      }
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/schedule/pause',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        const parentSnapshot = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (!parentSnapshot) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        if (
          !parentSnapshot.orchestration_schedule_id ||
          parentSnapshot.metadata?.orchestrationTemplate !== true
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '当前编排任务不是无人值守计划',
            409,
          )};
        }
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          parentSnapshot.orchestration_schedule_id,
          {lock: true},
        );
        if (!schedule) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '无人值守计划不存在',
            404,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (
          !parent ||
          String(parent.orchestration_schedule_id || '') !== String(schedule.id)
        ) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        if (schedule.status === 'paused') {
          return {schedule, existing: true};
        }
        if (!['active'].includes(schedule.status)) {
          return {failure: requestError(
            'orchestration_schedule_not_pauseable',
            '当前无人值守计划不能暂停',
            409,
          )};
        }
        const updated = await tx.queryOne(`
          UPDATE capture_orchestration_schedules
          SET status = 'paused',
            revision = revision + 1,
            updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'active'
          RETURNING *
        `, [schedule.id, req.tenantId]);
        if (!updated) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        await tx.execute(`
          UPDATE capture_tasks
          SET metadata = metadata || jsonb_build_object(
              'scheduleStatus', 'paused',
              'scheduleRevision', $1::integer
            ),
            schedule_revision = $1,
            message = '多 Agent 无人值守计划已暂停，不会再生成新任务',
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [Number(updated.revision), parent.id, req.tenantId]);
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_schedule_paused',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parent.status,
          message: '多 Agent 无人值守计划已暂停',
          payload: {
            scheduleId: updated.id,
            revision: updated.revision,
            nextRunAt: updated.next_run_at,
          },
        });
        return {schedule: updated, existing: false};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        existing: result.existing === true,
        schedule: result.schedule,
        message: result.existing
          ? '计划已经暂停'
          : '计划已暂停，不会再生成新任务',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/schedule/archive',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        const parentSnapshot = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (
          !parentSnapshot ||
          !parentSnapshot.orchestration_schedule_id ||
          parentSnapshot.metadata?.orchestrationTemplate !== true
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '当前任务不是可归档的无人值守计划',
            parentSnapshot ? 409 : 404,
          )};
        }
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          parentSnapshot.orchestration_schedule_id,
          {lock: true},
        );
        if (!schedule) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '无人值守计划不存在',
            404,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (
          !parent ||
          String(parent.orchestration_schedule_id || '') !== String(schedule.id)
        ) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        if (schedule.archived_at) {
          return {schedule, existing: true};
        }
        const updated = await tx.queryOne(`
          UPDATE capture_orchestration_schedules
          SET archived_at = now(),
            archived_by_user_id = $1::uuid,
            archived_by_name = $2,
            archived_previous_status = status,
            status = 'canceled',
            next_run_at = NULL,
            revision = revision + 1,
            updated_at = now()
          WHERE id = $3 AND tenant_id = $4 AND archived_at IS NULL
          RETURNING *
        `, [req.user?.id || null, text(req.actorName, 240), schedule.id, req.tenantId]);
        if (!updated) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        await tx.execute(`
          UPDATE capture_tasks
          SET metadata = metadata || jsonb_build_object(
              'scheduleStatus', 'canceled',
              'scheduleRevision', $1::integer,
              'scheduleArchivedAt', $2::timestamptz::text,
              'scheduleArchivedBy', $3::text,
              'scheduleArchivedPreviousStatus', $4::text,
              'nextRunAt', NULL
            ),
            schedule_revision = $1,
            message = '计划已归档，不会再生成新任务；既有批次和结果保持不变',
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $5 AND tenant_id = $6
        `, [
          Number(updated.revision),
          updated.archived_at,
          updated.archived_by_name,
          updated.archived_previous_status,
          parent.id,
          req.tenantId,
        ]);
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_schedule_archived',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parent.status,
          message: '无人值守计划已归档，历史执行与采集结果保留',
          payload: {
            scheduleId: updated.id,
            revision: updated.revision,
            previousStatus: updated.archived_previous_status,
            activeRunsUnaffected: true,
          },
        });
        return {schedule: updated, existing: false};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        existing: result.existing === true,
        schedule: result.schedule,
        message: result.existing
          ? '计划已经在归档中'
          : '计划已归档；后续排期已停止，正在执行的批次和历史结果不受影响',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/schedule/restore',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        const parentSnapshot = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (
          !parentSnapshot ||
          !parentSnapshot.orchestration_schedule_id ||
          parentSnapshot.metadata?.orchestrationTemplate !== true
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '当前任务不是可恢复的无人值守计划',
            parentSnapshot ? 409 : 404,
          )};
        }
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          parentSnapshot.orchestration_schedule_id,
          {lock: true},
        );
        if (!schedule) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '无人值守计划不存在',
            404,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (
          !parent ||
          String(parent.orchestration_schedule_id || '') !== String(schedule.id)
        ) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        if (
          !schedule.archived_at &&
          !['completed', 'canceled'].includes(schedule.status)
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_archived',
            '该计划不在归档中',
            409,
          )};
        }
        const updated = await tx.queryOne(`
          UPDATE capture_orchestration_schedules
          SET status = 'paused',
            next_run_at = NULL,
            archived_at = NULL,
            archived_by_user_id = NULL,
            archived_by_name = '',
            archived_previous_status = NULL,
            revision = revision + 1,
            updated_at = now()
          WHERE id = $1 AND tenant_id = $2
            AND (archived_at IS NOT NULL OR status IN ('completed', 'canceled'))
          RETURNING *
        `, [schedule.id, req.tenantId]);
        if (!updated) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        await tx.execute(`
          UPDATE capture_tasks
          SET status = 'pending',
            metadata = (
              metadata
              - 'scheduleArchivedAt'
              - 'scheduleArchivedBy'
              - 'scheduleArchivedPreviousStatus'
            ) || jsonb_build_object(
              'scheduleStatus', 'paused',
              'scheduleRevision', $1::integer,
              'nextRunAt', NULL
            ),
            schedule_revision = $1,
            progress = progress || jsonb_build_object('phase', 'paused', 'nextRunAt', NULL),
            message = '计划已从归档恢复为暂停状态，请检查配置后重新启用',
            finished_at = NULL,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [Number(updated.revision), parent.id, req.tenantId]);
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_schedule_restored',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: 'pending',
          message: '无人值守计划已从归档恢复为暂停状态',
          payload: {
            scheduleId: updated.id,
            revision: updated.revision,
            restoredAs: 'paused',
          },
        });
        return {schedule: updated};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        schedule: result.schedule,
        message: '计划已恢复为暂停状态；检查配置后可重新启用',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/schedule/resume',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        const parentSnapshot = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (!parentSnapshot) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        if (
          !parentSnapshot.orchestration_schedule_id ||
          parentSnapshot.metadata?.orchestrationTemplate !== true
        ) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '当前编排任务不是无人值守计划',
            409,
          )};
        }
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          parentSnapshot.orchestration_schedule_id,
          {lock: true},
        );
        if (!schedule) {
          return {failure: requestError(
            'orchestration_schedule_not_found',
            '无人值守计划不存在',
            404,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (
          !parent ||
          String(parent.orchestration_schedule_id || '') !== String(schedule.id)
        ) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        if (schedule.status === 'active') {
          return {schedule, existing: true};
        }
        if (!['paused'].includes(schedule.status)) {
          return {failure: requestError(
            'orchestration_schedule_not_resumable',
            '当前无人值守计划不能重新启用',
            409,
          )};
        }
        const nextRunAt = computeNextOrchestrationRunAt(schedule.plan_snapshot, {
          after: new Date(),
          seed: schedule.id,
        });
        if (!nextRunAt) {
          return {failure: requestError(
            'schedule_has_no_future_run',
            '计划中已没有未来运行日期，请新建计划或调整日期',
            409,
          )};
        }
        const updated = await tx.queryOne(`
          UPDATE capture_orchestration_schedules
          SET status = 'active',
            next_run_at = $1,
            revision = revision + 1,
            last_error = '{}'::jsonb,
            updated_at = now()
          WHERE id = $2 AND tenant_id = $3 AND status = 'paused'
          RETURNING *
        `, [nextRunAt, schedule.id, req.tenantId]);
        if (!updated) {
          return {failure: requestError(
            'orchestration_schedule_conflict',
            '计划状态刚刚发生变化，请刷新后重试',
            409,
          )};
        }
        await tx.execute(`
          UPDATE capture_tasks
          SET status = 'pending',
            metadata = metadata || jsonb_build_object(
              'scheduleStatus', 'active',
              'scheduleRevision', $1::integer,
              'nextRunAt', $2::timestamptz::text
            ),
            schedule_revision = $1,
            progress = progress || jsonb_build_object(
              'phase', 'scheduled',
              'nextRunAt', $2::timestamptz::text
            ),
            message = '多 Agent 无人值守计划已重新启用，等待下一次云端运行',
            finished_at = NULL,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $3 AND tenant_id = $4
        `, [Number(updated.revision), nextRunAt, parent.id, req.tenantId]);
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_schedule_resumed',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: 'pending',
          message: '多 Agent 无人值守计划已重新启用',
          payload: {
            scheduleId: updated.id,
            revision: updated.revision,
            nextRunAt,
          },
        });
        return {schedule: updated, existing: false};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        existing: result.existing === true,
        schedule: result.schedule,
        message: result.existing
          ? '计划已经启用'
          : '计划已重新启用，将按下一次时间运行',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/schedule/run-now',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const requestKey = normalizedUuid(req.body?.requestKey);
      if (!requestKey) {
        return sendRequestError(res, requestError(
          'invalid_request_key',
          'requestKey 必须是有效 UUID',
        ));
      }
      const parent = await queryOne(
        parentSelect(),
        [orchestrationId, req.tenantId],
      );
      if (!parent) {
        return sendRequestError(res, requestError(
          'orchestration_not_found',
          '编排任务不存在',
          404,
        ));
      }
      if (
        !parent.orchestration_schedule_id ||
        parent.metadata?.orchestrationTemplate !== true
      ) {
        return sendRequestError(res, requestError(
          'orchestration_schedule_not_found',
          '当前编排任务不是无人值守计划',
          409,
        ));
      }
      const result = await runCaptureOrchestrationScheduleNow({
        tenantId: req.tenantId,
        scheduleId: parent.orchestration_schedule_id,
        requestKey,
        actorId: req.user?.id || '',
        actorName: req.actorName,
      });
      if (result.kind === 'idempotency_conflict') {
        return sendRequestError(res, requestError(
          'idempotency_conflict',
          'requestKey 已用于另一个无人值守计划',
          409,
        ));
      }
      if (result.kind === 'not_found') {
        return sendRequestError(res, requestError(
          'orchestration_schedule_not_found',
          '无人值守计划不存在',
          404,
        ));
      }
      if (result.kind === 'inactive') {
        return sendRequestError(res, requestError(
          'orchestration_schedule_inactive',
          '请先重新启用计划，再立即运行',
          409,
          {scheduleStatus: result.status},
        ));
      }
      if (result.kind === 'blocked_overlap') {
        return sendRequestError(res, requestError(
          'orchestration_schedule_overlap',
          '上一轮仍在执行或等待设备，不能重复启动',
          409,
          {activeRunTaskId: result.activeRunTaskId},
        ));
      }
      return res.status(result.idempotent ? 200 : 201).json({
        ok: true,
        idempotent: result.idempotent === true,
        orchestrationId,
        runTaskId: result.runTaskId,
        nextRunAt: result.nextRunAt || null,
        message: result.idempotent
          ? '这次立即运行请求已经创建过'
          : '已从云端立即启动一轮无人值守任务',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/retry-items',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const normalized = normalizeRetryItems(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const retryRequestHash = hashOrchestrationRequest({
        action: 'retry_items',
        orchestrationId,
        expectedRevision: normalized.expectedRevision,
        targetAgentId: normalized.targetAgentId,
        itemIds: [...normalized.itemIds].sort(),
        confirmSafety: normalized.confirmSafety,
      });
      const result = await withTransaction(async tx => {
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['capture_task_global_id', normalized.requestKey],
        );
        await lockCaptureAgentExecutionSlot(
          tx,
          req.tenantId,
          normalized.targetAgentId,
        );
        const existingTask = await tx.queryOne(`
          SELECT id, parent_task_id, assigned_agent_id, status, metadata
          FROM capture_tasks
          WHERE id = $1::uuid AND tenant_id = $2
          FOR UPDATE
        `, [normalized.requestKey, req.tenantId]);
        if (existingTask) {
          const existingMetadata = safeJson(existingTask.metadata);
          const exactReplay =
            String(existingTask.parent_task_id || '') === orchestrationId &&
            String(existingTask.assigned_agent_id || '') ===
              normalized.targetAgentId &&
            existingMetadata.retryRequestHash === retryRequestHash;
          if (!exactReplay) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的任务',
              409,
            )};
          }
          const command = await tx.queryOne(`
            SELECT id, status
            FROM capture_agent_commands
            WHERE tenant_id = $1 AND task_id = $2
              AND agent_id = $3 AND command_type = 'create'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `, [req.tenantId, existingTask.id, normalized.targetAgentId]);
          const items = await tx.queryAll(`
            SELECT id, keyword
            FROM capture_task_items
            WHERE tenant_id = $1 AND task_id = $2
              AND execution_task_id = $3
            ORDER BY ordinal, id
          `, [req.tenantId, orchestrationId, existingTask.id]);
          return {
            existing: true,
            revision: Number(existingMetadata.orchestrationRevision || 0),
            execution: {
              taskId: existingTask.id,
              agentId: existingTask.assigned_agent_id,
              commandId: command?.id || null,
              commandStatus: command?.status || '',
              status: existingTask.status,
              itemIds: items.map(item => item.id),
              keywords: items.map(item => item.keyword),
            },
          };
        }
        // Agent heartbeats lock a child execution before its parent. Resolve
        // and lock the selected source executions first so retry dispatch
        // cannot deadlock a late terminal heartbeat.
        const sourceTasks = await tx.queryAll(`
          SELECT source.id, source.status, source.assigned_agent_id
          FROM capture_tasks source
          WHERE source.tenant_id = $1
            AND source.parent_task_id = $2
            AND source.id IN (
              SELECT item.execution_task_id
              FROM capture_task_items item
              WHERE item.tenant_id = $1
                AND item.task_id = $2
                AND item.id = ANY($3::uuid[])
                AND item.execution_task_id IS NOT NULL
            )
          ORDER BY source.id
          FOR UPDATE
        `, [req.tenantId, orchestrationId, normalized.itemIds]);
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (!parent) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        const currentRevision = Number(parent.orchestration_revision || 0);
        if (currentRevision !== normalized.expectedRevision) {
          return {failure: requestError(
            'revision_conflict',
            '任务状态已更新，请刷新后重新选择失败项',
            409,
            {currentRevision},
          )};
        }
        if (
          parent.metadata?.orchestrationTemplate === true ||
          parent.metadata?.executionMode === 'unattended_plan'
        ) {
          return {failure: requestError(
            'retry_template_not_supported',
            '计划模板不能直接重试，请打开具体运行批次',
            409,
          )};
        }
        const items = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
          {lock: true},
        );
        const itemById = new Map(items.map(item => [String(item.id), item]));
        const retryItems = normalized.itemIds.map(itemId => itemById.get(itemId));
        if (retryItems.some(item => !item)) {
          return {failure: requestError(
            'retry_item_not_found',
            '一个或多个关键词不属于当前任务',
            404,
          )};
        }
        const ineligible = retryItems.filter(item =>
          !RETRY_ITEM_STATUSES.has(String(item.status || ''))
        );
        if (ineligible.length > 0) {
          return {failure: requestError(
            'retry_item_status_conflict',
            '只能重试失败、可重试或需处理的关键词',
            409,
            {itemIds: ineligible.map(item => item.id)},
          )};
        }
        const safetyItems = retryItems.filter(item =>
          itemRequiresManualSafetyAction(item)
        );
        if (safetyItems.length > 0 && !normalized.confirmSafety) {
          return {failure: requestError(
            'retry_requires_safety_confirmation',
            '部分关键词曾触发验证码或安全审核，请明确确认后再换设备重试',
            409,
            {itemIds: safetyItems.map(item => item.id)},
          )};
        }
        const sourceTaskIds = Array.from(new Set(
          retryItems.map(item => String(item.execution_task_id || '')).filter(Boolean),
        )).sort();
        if (
          sourceTasks.length !== sourceTaskIds.length ||
          sourceTasks.some(task => !HANDOFF_SOURCE_FINAL_STATUSES.has(task.status))
        ) {
          return {failure: requestError(
            'retry_source_not_settled',
            '原执行任务仍在运行，请先停止并等待设备确认结束',
            409,
          )};
        }

        const planSnapshot = safeJson(parent.metadata?.planSnapshot);
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          [normalized.targetAgentId],
          parent.platform,
          planSnapshot,
          {lock: true},
        );
        if (compatible.failure) return {failure: compatible.failure};
        const targetAgent = compatible.agentsById.get(normalized.targetAgentId);
        if (!captureAgentOnline(targetAgent.last_heartbeat_at)) {
          return {failure: requestError(
            'retry_target_offline',
            '目标 Agent 当前离线，请选择在线空闲节点',
            409,
          )};
        }
        const targetBusyTask = await findCaptureAgentExecutionSlotBlocker(
          tx,
          req.tenantId,
          normalized.targetAgentId,
        );
        if (targetBusyTask) {
          return {failure: requestError(
            'retry_target_busy',
            '目标 Agent 当前有执行中或排队任务，请选择空闲节点',
            409,
            {
              blockingTaskId: targetBusyTask.task_id || targetBusyTask.id,
              blockingTaskStatus: targetBusyTask.status,
              blockerKind: targetBusyTask.kind,
            },
          )};
        }

        retryItems.sort(
          (left, right) => Number(left.ordinal) - Number(right.ordinal),
        );
        const nextRevision = currentRevision + 1;
        const childTaskId = normalized.requestKey;
        const commandId = crypto.randomUUID();
        const childTaskInput = normalizeRemoteTaskInput({
          clientTaskId: childTaskId,
          title: `${parent.title} · 云端重试`,
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
        const childPlan = childTaskInput.planSnapshot;
        const total = childPlan.keywords.length;
        const childMetadata = {
          remoteCreated: true,
          remoteRequestHash: retryRequestHash,
          createCommandId: commandId,
          requestedByUserId: req.user?.id || '',
          requestedByName: text(req.actorName, 240),
          executionMode: 'one_time',
          planSnapshot: childPlan,
          orchestrationChild: true,
          parentTaskId: parent.id,
          orchestrationRevision: nextRevision,
          itemIds: retryItems.map(item => item.id),
          retryRequestHash,
          retryRequestKey: normalized.requestKey,
          retrySourceExecutionTaskIds: sourceTaskIds,
          retryConfirmedByUser: true,
          retrySafetyConfirmed: normalized.confirmSafety,
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
            $10::jsonb, '云端重试任务已创建，等待目标设备领取', now()
          )
          RETURNING id, parent_task_id, assigned_agent_id, title, platform,
            status, progress, counts, metadata, created_at, updated_at
        `, [
          childTaskId,
          req.tenantId,
          parent.id,
          normalized.targetAgentId,
          childTaskInput.title,
          parent.platform,
          JSON.stringify({current: 0, total, phase: 'queued'}),
          JSON.stringify({round: 1, keywordIndex: 0}),
          JSON.stringify({
            total,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          }),
          JSON.stringify(childMetadata),
        ]);
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
          req.tenantId,
          normalized.targetAgentId,
          child.id,
          JSON.stringify({
            taskId: child.id,
            clientTaskId: child.id,
            title: child.title,
            executionMode: 'one_time',
            platform: childPlan.platform,
            planSnapshot: childPlan,
            requestHash: retryRequestHash,
            authCodeId: targetAgent.auth_code_id,
            authBindingId: targetAgent.auth_binding_id,
            orchestration: {
              parentTaskId: parent.id,
              revision: nextRevision,
              itemIds: retryItems.map(item => item.id),
              retrySourceExecutionTaskIds: sourceTaskIds,
            },
          }),
          req.user?.id || null,
          text(req.actorName, 240),
        ]);

        for (const item of retryItems) {
          const updatedItem = await tx.queryOne(`
            UPDATE capture_task_items
            SET status = 'dispatched',
              attempt_count = attempt_count + 1,
              assigned_agent_id = $1,
              execution_task_id = $2,
              assignment_revision = $3,
              request_hash = $4,
              error = '{}'::jsonb,
              metadata = metadata || jsonb_build_object(
                'retrySourceExecutionTaskId', $5::uuid::text,
                'retryRequestKey', $6::uuid::text
              ),
              assigned_at = now(),
              dispatched_at = now(),
              started_at = NULL,
              finished_at = NULL,
              updated_at = now()
            WHERE id = $7 AND tenant_id = $8 AND task_id = $9
              AND execution_task_id IS NOT DISTINCT FROM $5
              AND assignment_revision = $10
              AND status IN ('retryable', 'needs_action', 'failed')
            RETURNING id, attempt_count
          `, [
            normalized.targetAgentId,
            child.id,
            nextRevision,
            retryRequestHash,
            item.execution_task_id,
            normalized.requestKey,
            item.id,
            req.tenantId,
            parent.id,
            Number(item.assignment_revision || 0),
          ]);
          if (!updatedItem) {
            const error = new Error('orchestration_retry_item_conflict');
            error.code = 'orchestration_retry_item_conflict';
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
            crypto.randomUUID(),
            req.tenantId,
            item.id,
            parent.id,
            child.id,
            normalized.targetAgentId,
            text(targetAgent.display_name, 240),
            Number(updatedItem.attempt_count),
            nextRevision,
            retryRequestHash,
          ]);
        }

        const refreshedItems = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
        );
        const aggregate = aggregateParentTaskItems(refreshedItems);
        const parentUpdate = await tx.queryOne(`
          UPDATE capture_tasks
          SET orchestration_revision = orchestration_revision + 1,
            status = $1,
            progress = $2::jsonb,
            counts = $3::jsonb,
            metadata = metadata || jsonb_build_object(
              'lastRetryAt', now(),
              'lastRetryTaskId', $4::uuid::text,
              'lastRetryRequestKey', $5::uuid::text,
              'lastRetryTargetAgentId', $6::uuid::text
            ),
            message = '失败关键词已从云端下发重试',
            finished_at = NULL,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $7 AND tenant_id = $8
            AND task_type = 'capture_orchestration'
            AND orchestration_revision = $9
          RETURNING id, orchestration_revision, status
        `, [
          aggregate.status,
          JSON.stringify(aggregate.progress),
          JSON.stringify(aggregate.counts),
          child.id,
          normalized.requestKey,
          normalized.targetAgentId,
          parent.id,
          req.tenantId,
          currentRevision,
        ]);
        if (!parentUpdate) {
          const error = new Error('orchestration_revision_conflict');
          error.code = 'orchestration_revision_conflict';
          throw error;
        }
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: child.id,
          agentId: normalized.targetAgentId,
          eventType: 'orchestration_retry_child_dispatched',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: child.status,
          message: '失败关键词重试已向目标 Agent 下发',
          payload: {
            parentTaskId: parent.id,
            revision: nextRevision,
            commandId: command.id,
            sourceExecutionTaskIds: sourceTaskIds,
            itemIds: retryItems.map(item => item.id),
            keywords: retryItems.map(item => item.keyword),
          },
        });
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_retry_dispatched',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parentUpdate.status,
          message: '失败关键词已在同一无人值守任务内重试',
          payload: {
            revision: parentUpdate.orchestration_revision,
            retryTaskId: child.id,
            targetAgentId: normalized.targetAgentId,
            sourceExecutionTaskIds: sourceTaskIds,
            itemIds: retryItems.map(item => item.id),
          },
        });
        return {
          existing: false,
          revision: Number(parentUpdate.orchestration_revision),
          execution: {
            taskId: child.id,
            agentId: normalized.targetAgentId,
            commandId: command.id,
            commandStatus: command.status,
            status: child.status,
            itemIds: retryItems.map(item => item.id),
            keywords: retryItems.map(item => item.keyword),
          },
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        idempotent: result.existing === true,
        action: 'retry_items',
        orchestrationId,
        revision: result.revision,
        execution: result.execution,
        message: result.existing
          ? '该失败项重试请求已经下发'
          : '失败关键词已在原无人值守任务中重新下发',
      });
    } catch (error) {
      if (
        error?.code === 'orchestration_revision_conflict' ||
        error?.code === 'orchestration_retry_item_conflict' ||
        error?.code === '23505'
      ) {
        return sendRequestError(res, requestError(
          'retry_conflict',
          '重试过程中任务发生并发更新，请刷新后重试',
          409,
        ));
      }
      return next(error);
    }
  },
);

router.post(
  '/orchestrations/:id/resolve-attention',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const normalized = normalizeAttentionHandoff(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const handoffRequestHash = hashOrchestrationRequest({
        action: normalized.action,
        orchestrationId,
        expectedRevision: normalized.expectedRevision,
        requestKey: normalized.requestKey,
        sourceExecutionTaskId: normalized.sourceExecutionTaskId,
        targetAgentId: normalized.targetAgentId,
      });
      const result = await withTransaction(async tx => {
        // requestKey is also a globally unique task ID. Serialize that global
        // namespace first, then reserve the target Agent execution slot before
        // taking task, parent, command or Agent row locks.
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['capture_task_global_id', normalized.requestKey],
        );
        await lockCaptureAgentExecutionSlot(
          tx,
          req.tenantId,
          normalized.targetAgentId,
        );
        const existingTask = await tx.queryOne(`
          SELECT id, tenant_id, parent_task_id, assigned_agent_id,
            status, metadata
          FROM capture_tasks
          WHERE id = $1::uuid AND tenant_id = $2
          FOR UPDATE
        `, [normalized.requestKey, req.tenantId]);
        if (existingTask) {
          const existingMetadata = safeJson(existingTask.metadata);
          const exactReplay =
            String(existingTask.parent_task_id || '') === orchestrationId &&
            String(existingTask.assigned_agent_id || '') ===
              normalized.targetAgentId &&
            existingMetadata.handoffRequestHash === handoffRequestHash &&
            existingMetadata.handoffSourceExecutionTaskId ===
              normalized.sourceExecutionTaskId;
          if (!exactReplay) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的任务',
              409,
            )};
          }
          const command = await tx.queryOne(`
            SELECT id, status, expires_at, created_at
            FROM capture_agent_commands
            WHERE tenant_id = $1 AND task_id = $2
              AND agent_id = $3 AND command_type = 'create'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `, [
            req.tenantId,
            existingTask.id,
            normalized.targetAgentId,
          ]);
          const items = await tx.queryAll(`
            SELECT id, keyword, ordinal
            FROM capture_task_items
            WHERE tenant_id = $1 AND task_id = $2
              AND execution_task_id = $3
            ORDER BY ordinal, id
          `, [req.tenantId, orchestrationId, existingTask.id]);
          return {
            existing: true,
            revision: Number(existingMetadata.orchestrationRevision || 0),
            sourceExecutionTaskId: normalized.sourceExecutionTaskId,
            execution: {
              taskId: existingTask.id,
              agentId: existingTask.assigned_agent_id,
              commandId: command?.id || null,
              commandStatus: command?.status || '',
              status: existingTask.status,
              itemIds: items.map(item => item.id),
              keywords: items.map(item => item.keyword),
            },
          };
        }
        // Snapshot projection and command completion lock the child before its
        // parent. Follow the same order so a handoff cannot deadlock a final
        // source heartbeat.
        const sourceTask = await tx.queryOne(`
          SELECT id, tenant_id, parent_task_id, assigned_agent_id,
            task_type, title, platform, status, metadata
          FROM capture_tasks
          WHERE id = $1 AND tenant_id = $2 AND parent_task_id = $3
          FOR UPDATE
        `, [
          normalized.sourceExecutionTaskId,
          req.tenantId,
          orchestrationId,
        ]);
        if (!sourceTask) {
          return {failure: requestError(
            'handoff_source_not_found',
            '原执行任务不存在或不属于当前编排任务',
            404,
          )};
        }
        const parent = await tx.queryOne(
          parentSelect({lock: true}),
          [orchestrationId, req.tenantId],
        );
        if (!parent) {
          return {failure: requestError(
            'orchestration_not_found',
            '编排任务不存在',
            404,
          )};
        }
        const currentRevision = Number(parent.orchestration_revision || 0);
        if (currentRevision !== normalized.expectedRevision) {
          return {failure: requestError(
            'revision_conflict',
            '编排任务已被更新，请刷新后重新确认接力',
            409,
            {currentRevision},
          )};
        }
        if (
          parent.metadata?.orchestrationTemplate === true ||
          parent.metadata?.executionMode === 'unattended_plan'
        ) {
          return {failure: requestError(
            'handoff_template_not_supported',
            '计划模板本身不能接力，请对具体运行批次执行接力',
            409,
          )};
        }
        if (sourceTask.status === 'superseded') {
          const sourceMetadata = safeJson(sourceTask.metadata);
          const hasRecoverySuccessor = Boolean(
            text(sourceMetadata.recoveryTaskId, 240) ||
            text(sourceMetadata.recoveryCommandId, 240),
          );
          return {failure: requestError(
            hasRecoverySuccessor
              ? 'handoff_source_recovery_active'
              : 'handoff_source_superseded',
            hasRecoverySuccessor
              ? '原设备已经创建恢复任务并继续执行，不能再把相同剩余关键词接力给其他节点'
              : '原执行任务已被其他任务替代，不能再次接力',
            409,
            {
              recoveryTaskId: text(sourceMetadata.recoveryTaskId, 240) || null,
            },
          )};
        }
        if (!HANDOFF_SOURCE_FINAL_STATUSES.has(sourceTask.status)) {
          return {failure: requestError(
            'handoff_source_not_settled',
            '请先停止原任务并等待设备确认停止，再发起接力',
            409,
            {sourceStatus: sourceTask.status},
          )};
        }
        const attentionEvidence = await tx.queryOne(`
          SELECT true AS found
          FROM (
            SELECT snapshot.id
            FROM capture_task_snapshots snapshot
            WHERE snapshot.tenant_id = $1
              AND snapshot.task_id = $2
              AND snapshot.status = 'needs_action'
            UNION ALL
            SELECT event.id
            FROM capture_task_events event
            WHERE event.tenant_id = $1
              AND event.task_id = $2
              AND event.status = 'needs_action'
            UNION ALL
            SELECT parent_event.id
            FROM capture_task_events parent_event
            WHERE parent_event.tenant_id = $1
              AND parent_event.task_id = $3
              AND parent_event.status = 'needs_action'
              AND parent_event.payload->>'childTaskId' = $2::uuid::text
          ) attention
          LIMIT 1
        `, [req.tenantId, sourceTask.id, parent.id]);
        if (!attentionEvidence) {
          return {failure: requestError(
            'handoff_requires_attention_state',
            '只有曾进入需人工处理状态的任务才能人工接力',
            409,
          )};
        }
        const activeSourceCommand = await tx.queryOne(`
          SELECT id, command_type, status
          FROM capture_agent_commands
          WHERE tenant_id = $1 AND task_id = $2
            AND status IN ('pending', 'acknowledged')
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE
        `, [req.tenantId, sourceTask.id]);
        if (activeSourceCommand) {
          return {failure: requestError(
            'handoff_source_command_pending',
            '原任务仍有待完成指令，请等待停止结果后重试',
            409,
            {
              commandId: activeSourceCommand.id,
              commandType: activeSourceCommand.command_type,
            },
          )};
        }

        const items = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
          {lock: true},
        );
        const sourceItems = items.filter(item =>
          String(item.execution_task_id || '') === String(sourceTask.id)
        );
        const safetyNeedsActionItems = sourceItems.filter(item =>
          Boolean(item.started_at) &&
          item.status === 'needs_action' &&
          itemRequiresManualSafetyAction(item)
        );
        const safetyNeedsActionIds = new Set(
          safetyNeedsActionItems.map(item => String(item.id)),
        );
        const unresolvedStartedItems = sourceItems.filter(item =>
          Boolean(item.started_at) &&
          ![
            'completed',
            'completed_with_warnings',
            'failed',
            'skipped',
            'canceled',
          ].includes(item.status) &&
          !safetyNeedsActionIds.has(String(item.id))
        );
        if (unresolvedStartedItems.length > 0) {
          return {failure: requestError(
            'handoff_source_has_unresolved_started_items',
            '原任务仍有已开始但未结算的关键词，请先保留结果或人工处理',
            409,
            {itemIds: unresolvedStartedItems.map(item => item.id)},
          )};
        }
        const eligibleItems = items.filter(item =>
          String(item.execution_task_id || '') === String(sourceTask.id) &&
          !item.started_at &&
          ![
            'completed',
            'completed_with_warnings',
            'failed',
            'skipped',
          ].includes(item.status)
        );
        if (eligibleItems.length === 0) {
          return {failure: requestError(
            'handoff_has_no_unstarted_items',
            '原任务没有可接力的未开始关键词；已开始的关键词不会跨设备迁移',
            409,
          )};
        }
        if (eligibleItems.length > 30) {
          return {failure: requestError(
            'handoff_keyword_capacity_exceeded',
            '一次接力最多下发 30 个未开始关键词',
            409,
            {keywordCount: eligibleItems.length},
          )};
        }

        const planSnapshot = safeJson(parent.metadata?.planSnapshot);
        const recoveryPolicy = safeJson(planSnapshot.recoveryPolicy);
        if (recoveryPolicy.allowIdleAgentHandoff === false) {
          return {failure: requestError(
            'handoff_disabled_by_task_policy',
            '该任务创建时未启用空闲 Agent 接力',
            409,
          )};
        }
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          [normalized.targetAgentId],
          parent.platform,
          planSnapshot,
          {lock: true},
        );
        if (compatible.failure) return {failure: compatible.failure};
        const targetAgent = compatible.agentsById.get(normalized.targetAgentId);
        if (
          normalized.targetAgentId ===
          String(sourceTask.assigned_agent_id || '')
        ) {
          return {failure: requestError(
            'handoff_target_same_as_source',
            '接力节点必须不同于原执行节点',
            409,
          )};
        }
        if (!captureAgentOnline(targetAgent.last_heartbeat_at)) {
          return {failure: requestError(
            'handoff_target_offline',
            '接力节点当前离线，请选择在线空闲节点',
            409,
          )};
        }
        const targetBusyTask = await findCaptureAgentExecutionSlotBlocker(
          tx,
          req.tenantId,
          normalized.targetAgentId,
        );
        if (targetBusyTask) {
          return {failure: requestError(
            'handoff_target_busy',
            '接力节点当前有执行中或排队任务，请选择空闲节点',
            409,
            {
              blockingTaskId: targetBusyTask.task_id || targetBusyTask.id,
              blockingTaskStatus: targetBusyTask.status,
              blockerKind: targetBusyTask.kind,
            },
          )};
        }

        for (const item of safetyNeedsActionItems) {
          const settledItem = await tx.queryOne(`
            UPDATE capture_task_items
            SET status = 'failed',
              error = jsonb_build_object(
                'code', 'handoff_source_security_item_failed',
                'message', '当前关键词触发平台安全验证，人工选择接力后按失败结算',
                'cause', error
              ),
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND task_id = $3
              AND execution_task_id = $4
              AND started_at IS NOT NULL
              AND status = 'needs_action'
            RETURNING id, error, finished_at
          `, [
            item.id,
            req.tenantId,
            parent.id,
            sourceTask.id,
          ]);
          if (!settledItem) {
            const conflict = new Error('orchestration_handoff_item_conflict');
            conflict.code = 'orchestration_handoff_item_conflict';
            throw conflict;
          }
          await tx.execute(`
            UPDATE capture_task_item_attempts
            SET status = 'failed',
              error = $1::jsonb,
              finished_at = COALESCE(finished_at, $2::timestamptz, now()),
              updated_at = now()
            WHERE tenant_id = $3
              AND item_id = $4
              AND execution_task_id = $5
              AND status NOT IN (
                'completed', 'completed_with_warnings',
                'failed', 'skipped', 'canceled'
              )
          `, [
            JSON.stringify(safeJson(settledItem.error)),
            settledItem.finished_at,
            req.tenantId,
            item.id,
            sourceTask.id,
          ]);
        }

        eligibleItems.sort(
          (left, right) => Number(left.ordinal) - Number(right.ordinal),
        );
        const nextRevision = currentRevision + 1;
        const childTaskId = normalized.requestKey;
        const commandId = crypto.randomUUID();
        const childTaskInput = normalizeRemoteTaskInput({
          clientTaskId: childTaskId,
          title: `${parent.title} · 接力`,
          executionMode: 'one_time',
          planSnapshot: {
            ...planSnapshot,
            enabled: true,
            platform: parent.platform,
            keywords: eligibleItems.map(item => item.keyword),
          },
        });
        const childPlan = childTaskInput.planSnapshot;
        const total =
          childPlan.keywords.length *
          Math.max(1, Number(childPlan.maxRounds) || 1);
        const childMetadata = {
          remoteCreated: true,
          remoteRequestHash: handoffRequestHash,
          createCommandId: commandId,
          requestedByUserId: req.user?.id || '',
          requestedByName: text(req.actorName, 240),
          executionMode: 'one_time',
          planSnapshot: childPlan,
          orchestrationChild: true,
          parentTaskId: parent.id,
          orchestrationRevision: nextRevision,
          itemIds: eligibleItems.map(item => item.id),
          handoffRequestHash,
          handoffRequestKey: normalized.requestKey,
          handoffSourceExecutionTaskId: sourceTask.id,
          handoffConfirmedByUser: true,
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
            'cloud', 'orchestration_handoff', 'pending',
            $7::jsonb, $8::jsonb, $9::jsonb,
            $10::jsonb, '人工确认接力任务已创建，等待目标设备领取', now()
          )
          RETURNING id, parent_task_id, assigned_agent_id, title, platform,
            status, progress, counts, metadata, created_at, updated_at
        `, [
          childTaskId,
          req.tenantId,
          parent.id,
          normalized.targetAgentId,
          childTaskInput.title,
          parent.platform,
          JSON.stringify({current: 0, total, phase: 'queued'}),
          JSON.stringify({round: 1, keywordIndex: 0}),
          JSON.stringify({
            total,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          }),
          JSON.stringify(childMetadata),
        ]);
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
          req.tenantId,
          normalized.targetAgentId,
          child.id,
          JSON.stringify({
            taskId: child.id,
            clientTaskId: child.id,
            title: child.title,
            executionMode: 'one_time',
            platform: childPlan.platform,
            planSnapshot: childPlan,
            requestHash: handoffRequestHash,
            authCodeId: targetAgent.auth_code_id,
            authBindingId: targetAgent.auth_binding_id,
            orchestration: {
              parentTaskId: parent.id,
              revision: nextRevision,
              itemIds: eligibleItems.map(item => item.id),
              handoffSourceExecutionTaskId: sourceTask.id,
            },
          }),
          req.user?.id || null,
          text(req.actorName, 240),
        ]);

        for (const item of eligibleItems) {
          await tx.execute(`
            UPDATE capture_task_item_attempts
            SET status = 'canceled',
              error = jsonb_build_object(
                'code', 'handed_off_after_source_settled',
                'message', '原执行任务已结束，该未开始关键词由人工确认转交'
              ),
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
            WHERE tenant_id = $1
              AND item_id = $2
              AND execution_task_id = $3
              AND status NOT IN (
                'completed', 'completed_with_warnings',
                'failed', 'skipped', 'canceled'
              )
          `, [req.tenantId, item.id, sourceTask.id]);
          const updatedItem = await tx.queryOne(`
            UPDATE capture_task_items
            SET status = 'dispatched',
              attempt_count = attempt_count + 1,
              assigned_agent_id = $1,
              execution_task_id = $2,
              assignment_revision = $3,
              request_hash = $4,
              error = '{}'::jsonb,
              metadata = metadata || jsonb_build_object(
                'handoffSourceExecutionTaskId', $5::uuid::text,
                'handoffRequestKey', $6::uuid::text
              ),
              assigned_at = now(),
              dispatched_at = now(),
              started_at = NULL,
              finished_at = NULL,
              updated_at = now()
            WHERE id = $7 AND tenant_id = $8 AND task_id = $9
              AND execution_task_id = $5
              AND assignment_revision = $10
              AND started_at IS NULL
              AND status NOT IN (
                'completed', 'completed_with_warnings',
                'failed', 'skipped'
              )
            RETURNING id, attempt_count
          `, [
            normalized.targetAgentId,
            child.id,
            nextRevision,
            handoffRequestHash,
            sourceTask.id,
            normalized.requestKey,
            item.id,
            req.tenantId,
            parent.id,
            Number(item.assignment_revision || 0),
          ]);
          if (!updatedItem) {
            const conflict = new Error('orchestration_handoff_item_conflict');
            conflict.code = 'orchestration_handoff_item_conflict';
            throw conflict;
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
            crypto.randomUUID(),
            req.tenantId,
            item.id,
            parent.id,
            child.id,
            normalized.targetAgentId,
            text(targetAgent.display_name, 240),
            Number(updatedItem.attempt_count),
            nextRevision,
            handoffRequestHash,
          ]);
        }
        await tx.execute(`
          UPDATE capture_tasks
          SET status = 'superseded',
            metadata = metadata || jsonb_build_object(
              'handoffSuccessorTaskId', $1::uuid::text,
              'handoffRequestKey', $2::uuid::text,
              'handoffSourcePreviousStatus', $3::text,
              'handedOffAt', now()
            ),
            message = '未开始关键词已转交新的执行节点，原任务已封存',
            finished_at = COALESCE(finished_at, now()),
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $4 AND tenant_id = $5
        `, [
          child.id,
          normalized.requestKey,
          sourceTask.status,
          sourceTask.id,
          req.tenantId,
        ]);

        const refreshedItems = await listParentItems(
          tx,
          req.tenantId,
          parent.id,
        );
        const aggregate = aggregateParentTaskItems(refreshedItems);
        const parentUpdate = await tx.queryOne(`
          UPDATE capture_tasks
          SET orchestration_revision = orchestration_revision + 1,
            status = $1,
            progress = $2::jsonb,
            counts = $3::jsonb,
            metadata = metadata || jsonb_build_object(
              'lastHandoffAt', now(),
              'lastHandoffSourceExecutionTaskId', $4::uuid::text,
              'lastHandoffSuccessorTaskId', $5::uuid::text,
              'lastHandoffRequestKey', $6::uuid::text
            ),
            message = '未开始关键词已由人工确认转交空闲节点',
            finished_at = NULL,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $7 AND tenant_id = $8
            AND task_type = 'capture_orchestration'
            AND orchestration_revision = $9
          RETURNING id, orchestration_revision, status
        `, [
          aggregate.status,
          JSON.stringify(aggregate.progress),
          JSON.stringify(aggregate.counts),
          sourceTask.id,
          child.id,
          normalized.requestKey,
          parent.id,
          req.tenantId,
          currentRevision,
        ]);
        if (!parentUpdate) {
          const conflict = new Error('orchestration_revision_conflict');
          conflict.code = 'orchestration_revision_conflict';
          throw conflict;
        }
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: sourceTask.id,
          agentId: sourceTask.assigned_agent_id,
          eventType: 'orchestration_handoff_source_closed',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: 'superseded',
          message: '原任务已终止，未开始关键词获准转交',
          payload: {
            parentTaskId: parent.id,
            successorTaskId: child.id,
            previousStatus: sourceTask.status,
            itemIds: eligibleItems.map(item => item.id),
            settledSourceItemIds: safetyNeedsActionItems.map(item => item.id),
          },
        });
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: child.id,
          agentId: normalized.targetAgentId,
          eventType: 'orchestration_handoff_child_dispatched',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: child.status,
          message: '人工确认的接力任务已向空闲节点下发',
          payload: {
            parentTaskId: parent.id,
            sourceExecutionTaskId: sourceTask.id,
            revision: nextRevision,
            commandId: command.id,
            itemIds: eligibleItems.map(item => item.id),
            keywords: eligibleItems.map(item => item.keyword),
            settledSourceItemIds: safetyNeedsActionItems.map(item => item.id),
          },
        });
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          eventType: 'orchestration_handoff_dispatched',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: parentUpdate.status,
          message: '未开始关键词已转交新的执行节点',
          payload: {
            revision: parentUpdate.orchestration_revision,
            sourceExecutionTaskId: sourceTask.id,
            successorTaskId: child.id,
            targetAgentId: normalized.targetAgentId,
            itemIds: eligibleItems.map(item => item.id),
            settledSourceItemIds: safetyNeedsActionItems.map(item => item.id),
          },
        });
        return {
          existing: false,
          revision: Number(parentUpdate.orchestration_revision),
          sourceExecutionTaskId: sourceTask.id,
          execution: {
            taskId: child.id,
            agentId: normalized.targetAgentId,
            commandId: command.id,
            commandStatus: command.status,
            status: child.status,
            itemIds: eligibleItems.map(item => item.id),
            keywords: eligibleItems.map(item => item.keyword),
          },
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        idempotent: result.existing === true,
        action: 'handoff',
        orchestrationId,
        revision: result.revision,
        sourceExecutionTaskId: result.sourceExecutionTaskId,
        execution: result.execution,
        message: result.existing
          ? '该接力请求已经下发'
          : '未开始关键词已转交空闲节点',
      });
    } catch (error) {
      if (
        error?.code === 'orchestration_revision_conflict' ||
        error?.code === 'orchestration_handoff_item_conflict' ||
        error?.code === '23505'
      ) {
        return sendRequestError(res, requestError(
          'handoff_conflict',
          '接力过程中任务发生并发更新，请刷新后重试',
          409,
        ));
      }
      return next(error);
    }
  },
);

router.get(
  '/orchestrations/:id',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const orchestrationId = orchestrationRouteId(req, res);
      if (!orchestrationId) return;
      const result = await withTransaction(async tx => {
        // Keep the parent revision, item allocation, child tasks and attempt
        // audit in one database snapshot. Otherwise a concurrent dispatch can
        // return revision 0 alongside revision 1 children.
        await tx.execute(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
        );
        const orchestration = await tx.queryOne(
          parentSelect(),
          [orchestrationId, req.tenantId],
        );
        if (!orchestration) return null;
        const items = await listParentItems(
          tx,
          req.tenantId,
          orchestration.id,
        );
        const executions = await tx.queryAll(`
          SELECT child.*,
            ca.display_name AS agent_display_name,
            ca.host_label AS agent_host_label,
            ca.browser_name AS agent_browser_name,
            ca.operating_system AS agent_operating_system,
            ca.app_version AS agent_app_version,
            ca.status AS agent_status,
            ca.last_heartbeat_at AS agent_last_heartbeat_at,
            command.id AS command_id,
            command.status AS command_status,
            command.expires_at AS command_expires_at
          FROM capture_tasks child
          LEFT JOIN capture_agents ca
            ON ca.id = child.assigned_agent_id
            AND ca.tenant_id = child.tenant_id
          LEFT JOIN LATERAL (
            SELECT c.id, c.status, c.expires_at
            FROM capture_agent_commands c
            WHERE c.task_id = child.id
              AND c.tenant_id = child.tenant_id
              AND c.command_type = 'create'
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT 1
          ) command ON true
          WHERE child.tenant_id = $1
            AND child.parent_task_id = $2
          ORDER BY child.created_at, child.id
        `, [req.tenantId, orchestration.id]);
        const eligibleAgentIds = Array.isArray(
          safeJson(orchestration.metadata).eligibleAgentIds,
        )
          ? safeJson(orchestration.metadata).eligibleAgentIds
            .map(normalizedUuid)
            .filter(Boolean)
            .slice(0, 50)
          : [];
        const agents = await tx.queryAll(`
          SELECT
            ca.id, ca.display_name, ca.host_label, ca.browser_name,
            ca.operating_system, ca.app_version, ca.allowed_platforms,
            ca.capabilities, ca.status, ca.last_heartbeat_at
          FROM capture_agents ca
          WHERE ca.tenant_id = $1
            AND (
              ca.id = ANY($3::uuid[])
              OR EXISTS (
                SELECT 1
                FROM capture_task_items item
                WHERE item.tenant_id = ca.tenant_id
                  AND item.task_id = $2
                  AND item.assigned_agent_id = ca.id
              )
            )
          ORDER BY ca.id
        `, [req.tenantId, orchestration.id, eligibleAgentIds]);
        const attempts = await tx.queryAll(`
          SELECT attempt.*,
            COALESCE(NULLIF(attempt.agent_display_name, ''), ca.display_name, '')
              AS agent_display_name,
            item.ordinal, item.keyword, item.item_key
          FROM capture_task_item_attempts attempt
          JOIN capture_task_items item
            ON item.id = attempt.item_id
            AND item.tenant_id = attempt.tenant_id
          LEFT JOIN capture_agents ca
            ON ca.id = attempt.agent_id
            AND ca.tenant_id = attempt.tenant_id
          WHERE attempt.tenant_id = $1
            AND attempt.parent_task_id = $2
          ORDER BY item.ordinal, attempt.attempt_number, attempt.created_at
        `, [req.tenantId, orchestration.id]);
        const schedule = await loadOrchestrationSchedule(
          tx,
          req.tenantId,
          orchestration.orchestration_schedule_id,
        );
        return {orchestration, items, executions, agents, attempts, schedule};
      });
      if (!result) {
        return sendRequestError(res, requestError(
          'orchestration_not_found',
          '编排任务不存在',
          404,
        ));
      }
      const {orchestration, items, executions, agents, attempts, schedule} = result;
      return res.json({
        ok: true,
        orchestration: {
          ...orchestration,
          revision: Number(orchestration.orchestration_revision || 0),
        },
        items: items
          .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
          .map(publicParentItem),
        executions: executions.map(execution => ({
          ...execution,
          agent_online: captureAgentOnline(execution.agent_last_heartbeat_at),
        })),
        agents: agents.map(publicAgent),
        attempts,
        schedule,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
