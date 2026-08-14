import crypto from 'node:crypto';
import {Router} from 'express';
import {getAllSettings, queryAll, withTransaction} from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  captureAgentOnline,
  sanitizeCloudStructuredObject,
} from '../services/capture-cloud.js';
import {
  PROFILE_PATROL_WORKFLOWS,
  loadCompatibleProfilePatrolAgent,
  materializeProfilePatrolTask,
  profilePatrolRequestHash,
} from '../services/profile-patrol-dispatch.js';

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SUBJECT_WORKFLOW = PROFILE_PATROL_WORKFLOWS;
const MAX_SUBSCRIPTIONS = 100;

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
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

function normalizeSubjectType(value, {required = false} = {}) {
  const normalized = text(value, 40).toLowerCase();
  if (Object.hasOwn(SUBJECT_WORKFLOW, normalized)) return normalized;
  return required ? '' : 'creator';
}

function normalizeSubscriptionIds(value) {
  if (!Array.isArray(value)) {
    return {failure: requestError(
      'subscription_ids_required',
      '请选择要扫描的关注账号',
    )};
  }
  const ids = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = normalizedUuid(rawId);
    if (!id) {
      return {failure: requestError(
        'invalid_subscription_id',
        '关注账号列表包含无效标识',
      )};
    }
    if (!seen.has(id)) ids.push(id);
    seen.add(id);
  }
  if (ids.length === 0 || ids.length > MAX_SUBSCRIPTIONS) {
    return {failure: requestError(
      'subscription_count_invalid',
      `一次请选择 1-${MAX_SUBSCRIPTIONS} 个关注账号`,
    )};
  }
  return {ids};
}

function canonicalProfileUrl(rawUrl, platform) {
  let parsed;
  try {
    parsed = new URL(text(rawUrl, 3000));
  } catch {
    return '';
  }
  const normalizedPlatform = text(platform, 40).toLowerCase();
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const base =
    normalizedPlatform === 'xiaohongshu'
      ? 'xiaohongshu.com'
      : normalizedPlatform === 'douyin'
        ? 'douyin.com'
        : normalizedPlatform === 'weibo'
          ? 'weibo.com'
          : '';
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    !base ||
    !(host === base || host.endsWith(`.${base}`))
  ) return '';
  const validPath =
    normalizedPlatform === 'xiaohongshu'
      ? /^\/user\/profile\/[A-Za-z0-9_-]+\/?$/iu.test(parsed.pathname)
      : normalizedPlatform === 'douyin'
        ? /^\/user\/[A-Za-z0-9._-]+\/?$/iu.test(parsed.pathname)
        : /^\/(?:u\/)?[A-Za-z0-9._-]+\/?$/iu.test(parsed.pathname);
  if (!validPath) return '';
  const allowedQueryKeys =
    normalizedPlatform === 'xiaohongshu'
      ? new Set(['xsec_token', 'xsec_source'])
      : new Set();
  for (const key of [...parsed.searchParams.keys()]) {
    if (!allowedQueryKeys.has(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  parsed.hostname = host;
  return parsed.toString();
}

function publicSubscription(row) {
  return {
    id: row.id,
    subjectType: row.subject_type || 'creator',
    platform: row.platform,
    name: row.name,
    accountUrl: row.account_url,
    platformBloggerId: row.keyword,
    status: row.status,
    cadenceMinutes: Number(row.cadence_minutes || 0),
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    lastError: row.last_error || '',
    assignedAgentId: row.assigned_agent_id || null,
  };
}

router.get(
  '/followed-creator-patrol/subscriptions',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const subjectType = normalizeSubjectType(req.query?.subjectType);
      if (req.query?.subjectType && !normalizeSubjectType(
        req.query.subjectType,
        {required: true},
      )) {
        return sendRequestError(res, requestError(
          'invalid_subject_type',
          'subjectType 仅支持 creator 或 official',
        ));
      }
      const rows = await queryAll(`
        SELECT *
        FROM monitor_subscriptions
        WHERE tenant_id = $1
          AND status = 'active'
          AND subject_type = $2
          AND COALESCE(account_url, '') <> ''
          AND platform IN ('xiaohongshu', 'douyin', 'weibo')
        ORDER BY created_at DESC, id
      `, [req.tenantId, subjectType]);
      return res.json({
        ok: true,
        subjectType,
        subscriptions: rows.map(publicSubscription),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/followed-creator-patrol/tasks',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const subjectType = normalizeSubjectType(
        req.body?.subjectType,
        {required: true},
      );
      if (!subjectType) {
        return sendRequestError(res, requestError(
          'subject_type_required',
          '请选择关注博主或官方账号',
        ));
      }
      const workflow = SUBJECT_WORKFLOW[subjectType];
      const normalizedIds = normalizeSubscriptionIds(req.body?.subscriptionIds);
      if (normalizedIds.failure) {
        return sendRequestError(res, normalizedIds.failure);
      }
      const agentId = normalizedUuid(req.body?.agentId);
      if (!agentId) {
        return sendRequestError(res, requestError(
          'agent_required',
          '请选择一个有效的执行节点',
        ));
      }
      const rawRequestKey = text(req.body?.requestKey, 100);
      const requestKey = rawRequestKey
        ? normalizedUuid(rawRequestKey)
        : crypto.randomUUID();
      if (!requestKey) {
        return sendRequestError(res, requestError(
          'invalid_request_key',
          'requestKey 必须是有效 UUID',
        ));
      }
      const title = text(
        req.body?.title ||
          (subjectType === 'official'
            ? '官方账号作品发现'
            : '关注博主作品扫描'),
        240,
      );
      const allSettings = await getAllSettings(req.tenantId);
      const monitorSettings = sanitizeCloudStructuredObject({
        publishWindow:
          req.body?.monitorSettings?.publishWindow ||
          allSettings.monitor_publishWindow ||
          '7d',
        likeThreshold:
          req.body?.monitorSettings?.likeThreshold ??
          allSettings.monitor_likeThreshold ??
          '0',
        observeWindowHours:
          req.body?.monitorSettings?.observeWindowHours ??
          allSettings.monitor_observeWindowHours ??
          '24',
        timezone:
          req.body?.monitorSettings?.timezone ||
          allSettings.monitor_timezone ||
          'Asia/Shanghai',
      });
      const captureSettings = sanitizeCloudStructuredObject({
        ...safeJson(req.body?.captureSettings),
        autoSyncAfterDetailCapture: true,
      });
      const hash = profilePatrolRequestHash({
        workflow,
        agentId,
        subscriptionIds: normalizedIds.ids,
        title,
        monitorSettings,
        captureSettings,
      });

      const result = await withTransaction(async tx => {
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [workflow, requestKey],
        );
        const existing = await tx.queryOne(`
          SELECT task.*, command.id AS create_command_id,
            command.expires_at AS create_command_expires_at,
            agent.last_heartbeat_at AS agent_last_heartbeat_at
          FROM capture_tasks task
          LEFT JOIN capture_agent_commands command
            ON command.id::text = task.metadata->>'createCommandId'
            AND command.task_id = task.id
            AND command.tenant_id = task.tenant_id
          LEFT JOIN capture_agents agent
            ON agent.id = task.assigned_agent_id
            AND agent.tenant_id = task.tenant_id
          WHERE task.id = $1::uuid AND task.tenant_id = $2
          FOR UPDATE OF task
        `, [requestKey, req.tenantId]);
        if (existing) {
          if (
            existing.task_type !== workflow ||
            safeJson(existing.metadata).remoteRequestHash !== hash
          ) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的任务请求',
              409,
            )};
          }
          return {
            task: existing,
            commandId: existing.create_command_id || null,
            commandExpiresAt: existing.create_command_expires_at || null,
            agentOnline: captureAgentOnline(
              existing.agent_last_heartbeat_at,
            ),
            existing: true,
          };
        }
        const requestKeyCollision = await tx.queryOne(`
          SELECT id
          FROM capture_tasks
          WHERE id = $1::uuid
          LIMIT 1
        `, [requestKey]);
        if (requestKeyCollision) {
          return {failure: requestError(
            'idempotency_key_conflict',
            '该 requestKey 已用于其他租户或任务请求',
            409,
          )};
        }
        const rows = await tx.queryAll(`
          SELECT *
          FROM monitor_subscriptions
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
          FOR UPDATE
        `, [req.tenantId, normalizedIds.ids]);
        const byId = new Map(rows.map(row => [String(row.id), row]));
        const subscriptions = normalizedIds.ids
          .map(id => byId.get(id))
          .filter(Boolean);
        if (subscriptions.length !== normalizedIds.ids.length) {
          return {failure: requestError(
            'subscription_selection_changed',
            '部分关注账号已不存在，请刷新后重试',
            409,
          )};
        }
        const invalid = subscriptions.filter(row =>
          row.status !== 'active' ||
          (row.subject_type || 'creator') !== subjectType ||
          !canonicalProfileUrl(row.account_url, row.platform));
        if (invalid.length > 0) {
          return {failure: requestError(
            'subscription_not_dispatchable',
            '部分账号角色、状态或主页链接不再符合扫描条件',
            409,
            {subscriptionIds: invalid.map(row => row.id)},
          )};
        }
        const activeExecutions = await tx.queryAll(`
          SELECT execution.subscription_id,
            execution.id,
            execution.status,
            EXISTS (
              SELECT 1
              FROM capture_task_items item
              WHERE item.tenant_id = execution.tenant_id
                AND item.metadata->>'monitorExecutionId' = execution.id::text
                AND item.status NOT IN (
                  'completed', 'completed_with_warnings', 'failed',
                  'skipped', 'canceled'
                )
            ) AS cloud_owned
          FROM monitor_executions execution
          WHERE execution.tenant_id = $1
            AND execution.subscription_id = ANY($2::uuid[])
            AND execution.status IN ('pending', 'running')
          FOR UPDATE OF execution
        `, [req.tenantId, normalizedIds.ids]);
        const busy = activeExecutions.filter(execution =>
          execution.status === 'running' || execution.cloud_owned === true);
        if (busy.length > 0) {
          return {failure: requestError(
            'subscription_execution_busy',
            '部分账号已有扫描正在等待或执行，请勿重复下发',
            409,
            {subscriptionIds: busy.map(row => row.subscription_id)},
          )};
        }
        const reusablePendingExecutionBySubscription = new Map();
        for (const execution of activeExecutions) {
          const subscriptionId = String(execution.subscription_id);
          if (
            execution.status === 'pending' &&
            execution.cloud_owned !== true &&
            !reusablePendingExecutionBySubscription.has(subscriptionId)
          ) {
            reusablePendingExecutionBySubscription.set(
              subscriptionId,
              execution.id,
            );
          }
        }
        const platforms = [...new Set(
          subscriptions.map(row => text(row.platform, 40).toLowerCase()),
        )];
        const compatible = await loadCompatibleProfilePatrolAgent(
          tx,
          req.tenantId,
          agentId,
          platforms,
          subjectType,
        );
        if (compatible.failure) return {failure: compatible.failure};
        const agent = compatible.agent;
        await tx.execute(`
          UPDATE monitor_subscriptions
          SET assigned_agent_id = $1,
            last_error = '',
            updated_at = now()
          WHERE tenant_id = $2
            AND id = ANY($3::uuid[])
        `, [agent.id, req.tenantId, normalizedIds.ids]);
        return {
          ...await materializeProfilePatrolTask(tx, {
            tenantId: req.tenantId,
            subjectType,
            agent,
            subscriptions: subscriptions.map(subscription => ({
              ...subscription,
              account_url: canonicalProfileUrl(
                subscription.account_url,
                subscription.platform,
              ),
            })),
            requestKey,
            title,
            monitorSettings,
            captureSettings,
            requestHash: hash,
            executionIdsBySubscription:
              reusablePendingExecutionBySubscription,
            triggerType: 'profile_scan_manual',
            requestedByUserId: req.user?.id || null,
            requestedByName: req.actorName,
            actorType: 'user',
            automaticRetryDisabled:
              req.body?.recoveryPolicy?.allowIdleAgentHandoff === false,
          }),
          existing: false,
        };
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        task: result.task,
        commandId: result.commandId,
        commandExpiresAt: result.commandExpiresAt,
        agentOnline: result.agentOnline,
        existing: result.existing,
        message: result.existing
          ? '相同请求已存在，已返回原任务状态'
          : result.agentOnline
            ? '任务已创建并下发，在线设备将领取执行'
            : '任务已创建并排队，设备上线后将自动领取',
      });
    } catch (error) {
      if (error?.status && error?.error) {
        return sendRequestError(res, requestError(
          error.error,
          error.message,
          error.status,
          error.subscriptionId
            ? {subscriptionIds: [error.subscriptionId]}
            : {},
        ));
      }
      return next(error);
    }
  },
);

export default router;
