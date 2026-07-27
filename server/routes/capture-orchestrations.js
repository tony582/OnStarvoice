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
const HANDOFF_TARGET_BUSY_STATUSES = [
  'pending',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'needs_action',
  'resume_requested',
];
const HANDOFF_PLATFORM_SAFETY_CODES = new Set([
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_CAPTCHA_REQUIRED',
  'CAPTCHA_PAGE_DETECTED',
]);

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
      plan_snapshot, next_run_at, last_scheduled_for, last_run_at,
      last_run_task_id, last_run_status, last_error, run_count,
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
      if (allocation.groups.some(group => group.keywords.length > 30)) {
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
  return {expectedRevision, assignments};
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
          const requestedAgentByItem = new Map(
            normalized.assignments.map(assignment => [
              assignment.itemId,
              assignment.agentId,
            ]),
          );
          const exactCommittedReplay =
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
          if (exactCommittedReplay) {
            const schedule = parentExecutionMode === 'unattended_plan'
              ? await tx.queryOne(`
                  SELECT id, status, schedule_mode, timezone, start_time,
                    random_offset_min, custom_dates, next_run_at,
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
        const agentIds = [...new Set(
          normalized.assignments.map(assignment => assignment.agentId),
        )];
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
        const oversizedGroup = [...assignmentsByAgent.entries()].find(
          ([, groupItems]) => groupItems.length > 30,
        );
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
              allocation_mode, revision, plan_snapshot, next_run_at,
              created_by_user_id, created_by_name
            ) VALUES (
              $1, $2, $3, $4, $5, 'active',
              $6, 'Asia/Shanghai', $7, $8,
              $9::date[], 'skip', $10,
              'balanced', 1, $11::jsonb, $12,
              $13, $14
            )
            RETURNING id, status, schedule_mode, timezone, start_time,
              random_offset_min, custom_dates, next_run_at,
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
            JSON.stringify(planSnapshot),
            nextRunAt,
            req.user?.id || null,
            text(req.actorName, 240),
          ]);
          const orderedAgentIds = [];
          const seenAgentIds = new Set();
          for (const assignment of normalized.assignments) {
            if (seenAgentIds.has(assignment.agentId)) continue;
            seenAgentIds.add(assignment.agentId);
            orderedAgentIds.push(assignment.agentId);
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
              SET status = 'assigned',
                assigned_agent_id = $1,
                assignment_revision = $2,
                assigned_at = now(),
                updated_at = now()
              WHERE id = $3 AND tenant_id = $4 AND task_id = $5
                AND status = 'pending'
                AND assigned_agent_id IS NULL
                AND execution_task_id IS NULL
              RETURNING id
            `, [
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
                'nextRunAt', $4::timestamptz::text
              ),
              message = '多 Agent 无人值守计划已启用，等待下一次云端运行',
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
              assigned: items.length,
            }),
            nextRunAt,
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
            eventType: 'orchestration_schedule_created',
            actorId: req.user?.id || '',
            actorName: req.actorName,
            status: parentUpdate.status,
            message: '多 Agent 无人值守计划已按确认分配启用',
            payload: {
              scheduleId: schedule.id,
              revision: parentUpdate.orchestration_revision,
              itemCount: items.length,
              agentIds: orderedAgentIds,
              nextRunAt,
              scheduleMode,
            },
          });
          return {
            parent: parentUpdate,
            schedule,
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
                agent_id, attempt_number, assignment_revision, status,
                request_hash, checkpoint, result, error, dispatched_at
              ) VALUES (
                $1, $2, $3, $4, $5,
                $6, 1, $7, 'dispatched',
                $8, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
              )
            `, [
              crypto.randomUUID(),
              req.tenantId,
              item.id,
              parent.id,
              child.id,
              agentId,
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
        const targetBusyTask = await tx.queryOne(`
          SELECT id, status
          FROM capture_tasks
          WHERE tenant_id = $1
            AND COALESCE(assigned_agent_id, origin_agent_id) = $2
            AND task_type <> 'capture_orchestration'
            AND status = ANY($3::text[])
          ORDER BY created_at, id
          LIMIT 1
        `, [
          req.tenantId,
          normalized.targetAgentId,
          HANDOFF_TARGET_BUSY_STATUSES,
        ]);
        if (targetBusyTask) {
          return {failure: requestError(
            'handoff_target_busy',
            '接力节点当前有执行中或排队任务，请选择空闲节点',
            409,
            {
              blockingTaskId: targetBusyTask.id,
              blockingTaskStatus: targetBusyTask.status,
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
            normalized.targetAgentId,
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
        const agents = await tx.queryAll(`
          SELECT DISTINCT ON (ca.id)
            ca.id, ca.display_name, ca.host_label, ca.browser_name,
            ca.operating_system, ca.app_version, ca.allowed_platforms,
            ca.capabilities, ca.status, ca.last_heartbeat_at
          FROM capture_agents ca
          JOIN capture_task_items item
            ON item.assigned_agent_id = ca.id
            AND item.tenant_id = ca.tenant_id
          WHERE item.tenant_id = $1 AND item.task_id = $2
          ORDER BY ca.id
        `, [req.tenantId, orchestration.id]);
        const attempts = await tx.queryAll(`
          SELECT attempt.*,
            item.ordinal, item.keyword, item.item_key
          FROM capture_task_item_attempts attempt
          JOIN capture_task_items item
            ON item.id = attempt.item_id
            AND item.tenant_id = attempt.tenant_id
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
        items: items.sort(
          (left, right) => Number(left.ordinal) - Number(right.ordinal),
        ),
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
