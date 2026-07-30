import crypto from 'node:crypto';
import {withTransaction} from '../db/init.js';
import {
  captureAgentOnline,
  normalizeCaptureAgentPlatforms,
  sanitizeCloudStructuredObject,
} from './capture-cloud.js';

export const PROFILE_PATROL_WORKFLOWS = Object.freeze({
  creator: 'followed_creator_post_patrol',
  official: 'official_account_comment_patrol',
});

const PROFILE_PATROL_CAPABILITIES = Object.freeze({
  creator: 'followedCreatorPostPatrol',
  official: 'officialAccountCommentPatrolProfileV1',
});

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requestError(error, message, status = 400, details = {}) {
  return {error, message, status, details};
}

export function profilePatrolRequestHash({
  workflow,
  agentId,
  subscriptionIds,
  title,
  monitorSettings,
  captureSettings,
  scheduledFor = '',
}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow,
    protocolVersion: 1,
    agentId,
    subscriptionIds: [...subscriptionIds].sort(),
    title,
    monitorSettings,
    captureSettings,
    scheduledFor,
  })).digest('hex');
}

export async function loadCompatibleProfilePatrolAgent(
  tx,
  tenantId,
  agentId,
  platforms,
  subjectType,
) {
  const workflow = PROFILE_PATROL_WORKFLOWS[subjectType];
  const agent = await tx.queryOne(`
    SELECT ca.*, tenant.status AS tenant_status,
      ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    WHERE ca.id = $1::uuid AND ca.tenant_id = $2
    FOR UPDATE OF ca
  `, [agentId, tenantId]);
  if (!agent) {
    return {failure: requestError(
      'agent_not_found',
      '目标执行节点不存在于当前租户',
      404,
    )};
  }
  if (
    agent.tenant_status !== 'active' ||
    agent.status !== 'active' ||
    agent.auth_code_status !== 'active' ||
    !agent.active_auth_binding_id ||
    (agent.auth_code_expires_at &&
      new Date(agent.auth_code_expires_at) < new Date())
  ) {
    return {failure: requestError(
      'agent_unavailable',
      '目标执行节点授权已失效、已停用或不存在',
      409,
    )};
  }
  const capabilities = safeJson(agent.capabilities);
  const capability = PROFILE_PATROL_CAPABILITIES[subjectType];
  if (
    !workflow ||
    capabilities.remoteTaskCreate !== true ||
    capabilities.remoteTargetedPostCaptureV1 !== true ||
    capabilities[capability] !== true ||
    (subjectType === 'official' &&
      capabilities.officialAccountLatestPostsByCountV1 !== true)
  ) {
    return {failure: requestError(
      'agent_profile_scan_capability_missing',
      '目标执行节点版本尚不支持账号作品扫描，请先升级扩展',
      409,
    )};
  }
  const allowed = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  const supported = normalizeCaptureAgentPlatforms(
    capabilities.supportedPlatforms,
  );
  const incompatible = platforms.filter(platform =>
    (allowed.length > 0 && !allowed.includes(platform)) ||
    (supported.length > 0 && !supported.includes(platform)));
  if (incompatible.length > 0) {
    return {failure: requestError(
      'agent_platform_mismatch',
      `目标执行节点不支持：${incompatible.join('、')}`,
      409,
    )};
  }
  return {agent};
}

export async function materializeProfilePatrolTask(tx, {
  tenantId,
  subjectType,
  agent,
  subscriptions,
  requestKey = crypto.randomUUID(),
  title,
  monitorSettings = {},
  captureSettings = {},
  requestHash = '',
  executionIdsBySubscription = new Map(),
  triggerType = 'profile_scan_manual',
  requestedByUserId = null,
  requestedByName = '',
  actorType = 'user',
  scheduledFor = '',
}) {
  const workflow = PROFILE_PATROL_WORKFLOWS[subjectType];
  if (!workflow) throw new Error(`Unsupported profile patrol subject: ${subjectType}`);
  const platforms = [...new Set(
    subscriptions.map(row => text(row.platform, 40).toLowerCase()),
  )];
  if (platforms.length > 1) {
    const error = new Error(
      '一次账号巡查只能分配同一平台的账号，请按平台分别创建任务',
    );
    error.status = 409;
    error.error = 'profile_scan_mixed_platform_not_supported';
    throw error;
  }
  const hash = requestHash || profilePatrolRequestHash({
    workflow,
    agentId: agent.id,
    subscriptionIds: subscriptions.map(row => row.id),
    title,
    monitorSettings,
    captureSettings,
    scheduledFor,
  });
  const commandId = crypto.randomUUID();
  const taskPlatform = platforms[0];
  const metadata = {
    workflow,
    subjectType,
    targetMode: 'profile',
    profileMode: true,
    protocolVersion: 1,
    remoteCreated: true,
    remoteRequestHash: hash,
    createCommandId: commandId,
    selectedSubscriptionIds: subscriptions.map(row => row.id),
    monitorSettings,
    captureSettings,
    scheduled: triggerType === 'profile_scan_schedule',
    scheduledFor: scheduledFor || null,
  };
  const resolvedExecutionsBySubscription = new Map();
  for (const subscription of subscriptions) {
    const existingExecutionId = executionIdsBySubscription.get(
      String(subscription.id),
    );
    if (existingExecutionId) {
      resolvedExecutionsBySubscription.set(
        String(subscription.id),
        existingExecutionId,
      );
      continue;
    }
    const execution = await tx.queryOne(`
      INSERT INTO monitor_executions (
        tenant_id, subscription_id, status
      ) VALUES ($1, $2, 'pending')
      ON CONFLICT (subscription_id)
        WHERE status IN ('pending', 'running')
      DO NOTHING
      RETURNING id
    `, [tenantId, subscription.id]);
    if (!execution) {
      const conflict = new Error('该账号已有扫描正在等待或执行，请勿重复下发');
      conflict.status = 409;
      conflict.error = 'subscription_execution_busy';
      conflict.subscriptionId = subscription.id;
      throw conflict;
    }
    resolvedExecutionsBySubscription.set(
      String(subscription.id),
      execution.id,
    );
  }
  const task = await tx.queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, origin_agent_id, assigned_agent_id, client_task_id,
      task_type, feature_key, title, platform, source, trigger_type,
      status, progress, checkpoint, counts, metadata, message,
      orchestration_revision, source_updated_at
    ) VALUES (
      $1::uuid, $2, $3, $3, $1::uuid::text,
      $4, $4, $5, $6, 'cloud', $7,
      'pending', $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12,
      1, now()
    )
    RETURNING *
  `, [
    requestKey,
    tenantId,
    agent.id,
    workflow,
    title,
    taskPlatform,
    triggerType,
    JSON.stringify({
      current: 0,
      total: subscriptions.length,
      percent: 0,
      phase: 'queued',
    }),
    JSON.stringify({targetIndex: 0}),
    JSON.stringify({
      total: subscriptions.length,
      assigned: subscriptions.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    }),
    JSON.stringify(metadata),
    triggerType === 'profile_scan_schedule'
      ? `${title}定时任务已创建，等待绑定设备领取`
      : `${title}任务已创建，等待目标设备领取`,
  ]);

  const targets = [];
  for (let ordinal = 0; ordinal < subscriptions.length; ordinal += 1) {
    const subscription = subscriptions[ordinal];
    const execution = {
      id: resolvedExecutionsBySubscription.get(String(subscription.id)),
    };
    const itemId = crypto.randomUUID();
    const accountUrl = text(subscription.account_url, 3000);
    await tx.execute(`
      INSERT INTO capture_task_items (
        id, tenant_id, task_id, item_key, ordinal, platform, item_type,
        external_id, url_snapshot, status, assigned_agent_id,
        execution_task_id, assignment_revision, request_hash,
        assigned_at, dispatched_at, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'profile_subscription',
        $7, $8, 'dispatched', $9, $3, 1, $10, now(), now(), $11::jsonb
      )
    `, [
      itemId,
      tenantId,
      task.id,
      `subscription:${subscription.id}`,
      ordinal,
      subscription.platform,
      subscription.id,
      accountUrl,
      agent.id,
      hash,
      JSON.stringify({
        subscriptionId: subscription.id,
        monitorExecutionId: execution.id,
        subjectType,
        accountName: subscription.name,
      }),
    ]);
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        id, tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        request_hash, checkpoint, result, error, dispatched_at
      ) VALUES (
        $1, $2, $3, $4, $4, $5, 1, 1, 'dispatched', $6,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
      )
    `, [
      crypto.randomUUID(),
      tenantId,
      itemId,
      task.id,
      agent.id,
      hash,
    ]);
    targets.push({
      itemId,
      recordId: subscription.id,
      externalId: subscription.id,
      subscriptionId: subscription.id,
      executionId: execution.id,
      platform: subscription.platform,
      accountUrl,
      url: accountUrl,
      title: subscription.name,
    });
  }

  const payload = {
    taskId: task.id,
    clientTaskId: task.id,
    title: task.title,
    executionMode: 'one_time',
    subjectType,
    targetMode: 'profile',
    profileMode: true,
    platform: taskPlatform,
    workflow,
    taskKind: workflow,
    protocolVersion: 1,
    targets,
    items: targets,
    monitorSettings,
    captureSettings,
    requestHash: hash,
    authCodeId: agent.auth_code_id,
    authBindingId: agent.auth_binding_id,
  };
  const command = await tx.queryOne(`
    INSERT INTO capture_agent_commands (
      id, tenant_id, agent_id, task_id, command_type, payload,
      requested_by_user_id, requested_by_name
    ) VALUES (
      $1, $2, $3, $4, 'create', $5::jsonb, $6, $7
    )
    RETURNING id, expires_at
  `, [
    commandId,
    tenantId,
    agent.id,
    task.id,
    JSON.stringify(payload),
    requestedByUserId,
    text(requestedByName, 240),
  ]);
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type, actor_type,
      actor_id, actor_name, status, message, payload
    ) VALUES (
      $1, $2, $3, 'profile_scan_created', $4,
      $5, $6, $7, $8, $9::jsonb
    )
  `, [
    tenantId,
    task.id,
    agent.id,
    actorType,
    text(requestedByUserId || '', 240),
    text(requestedByName, 240),
    task.status,
    triggerType === 'profile_scan_schedule'
      ? `云端调度器已为绑定节点创建${title}任务`
      : `后台已向指定节点创建${title}任务`,
    JSON.stringify({
      commandId: command.id,
      subjectType,
      subscriptionCount: subscriptions.length,
      requestHash: hash,
      scheduledFor: scheduledFor || null,
    }),
  ]);

  return {
    task,
    commandId: command.id,
    commandExpiresAt: command.expires_at,
    agentOnline: captureAgentOnline(agent.last_heartbeat_at),
  };
}

function profileMonitorSettings(rows) {
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return sanitizeCloudStructuredObject({
    publishWindow: settings.monitor_publishWindow || '7d',
    likeThreshold: settings.monitor_likeThreshold || '0',
    observeWindowHours: settings.monitor_observeWindowHours || '24',
    timezone: settings.monitor_timezone || 'Asia/Shanghai',
  });
}

export async function enqueueDueProfilePatrolTasks(limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return await withTransaction(async tx => {
    const subscriptions = await tx.queryAll(`
      SELECT ms.*
      FROM monitor_subscriptions ms
      WHERE ms.status = 'active'
        -- Official-account comment patrol is explicitly launched by the user
        -- because each run chooses its own post and comment limits. This
        -- legacy profile cron only schedules followed creators.
        AND ms.subject_type = 'creator'
        AND COALESCE(ms.account_url, '') <> ''
        AND ms.next_run_at <= now()
        AND NOT EXISTS (
          SELECT 1
          FROM monitor_executions execution
          WHERE execution.subscription_id = ms.id
            AND (
              execution.status = 'running'
              OR (
                execution.status = 'pending'
                AND EXISTS (
                  SELECT 1
                  FROM capture_task_items item
                  WHERE item.tenant_id = execution.tenant_id
                    AND item.metadata->>'monitorExecutionId' =
                      execution.id::text
                )
              )
            )
        )
      ORDER BY ms.next_run_at ASC, ms.id
      LIMIT $1
      FOR UPDATE OF ms SKIP LOCKED
    `, [safeLimit]);
    const results = [];
    const settingsByTenant = new Map();

    for (const subscription of subscriptions) {
      const assignedAgentId = text(subscription.assigned_agent_id, 100);
      if (!assignedAgentId) {
        const message = '该账号尚未绑定执行节点，定时扫描未创建';
        await tx.execute(`
          UPDATE monitor_subscriptions
          SET last_error = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [message, subscription.id, subscription.tenant_id]);
        results.push({
          kind: 'needs_agent',
          subscriptionId: subscription.id,
          message,
        });
        continue;
      }
      const subjectType = subscription.subject_type || 'creator';
      const compatible = await loadCompatibleProfilePatrolAgent(
        tx,
        subscription.tenant_id,
        assignedAgentId,
        [subscription.platform],
        subjectType,
      );
      if (compatible.failure) {
        const message = compatible.failure.message;
        await tx.execute(`
          UPDATE monitor_subscriptions
          SET last_error = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [message, subscription.id, subscription.tenant_id]);
        results.push({
          kind: 'agent_unavailable',
          subscriptionId: subscription.id,
          message,
        });
        continue;
      }
      if (!settingsByTenant.has(subscription.tenant_id)) {
        const rows = await tx.queryAll(`
          SELECT key, value
          FROM tenant_settings
          WHERE tenant_id = $1
            AND key IN (
              'monitor_publishWindow', 'monitor_likeThreshold',
              'monitor_observeWindowHours', 'monitor_timezone'
            )
        `, [subscription.tenant_id]);
        settingsByTenant.set(
          subscription.tenant_id,
          profileMonitorSettings(rows),
        );
      }
      const workflow = PROFILE_PATROL_WORKFLOWS[subjectType];
      const title = subjectType === 'official'
        ? `官方账号评论巡查 · ${subscription.name}`
        : `关注博主作品扫描 · ${subscription.name}`;
      const scheduledFor = new Date(subscription.next_run_at).toISOString();
      const captureSettings = sanitizeCloudStructuredObject(
        subjectType === 'official'
          ? {
              includeComments: true,
              includeCommentsOnDetailCapture: true,
              autoSyncAfterDetailCapture: true,
              commentsMaxDetectedItems: 50,
              skipAlreadyCapturedOnDetailCapture: false,
              verifyPublishDateFromDetail: true,
            }
          : {autoSyncAfterDetailCapture: true},
      );
      const monitorSettings = settingsByTenant.get(subscription.tenant_id);
      const requestKey = crypto.randomUUID();
      const requestHash = profilePatrolRequestHash({
        workflow,
        agentId: assignedAgentId,
        subscriptionIds: [subscription.id],
        title,
        monitorSettings,
        captureSettings,
        scheduledFor,
      });
      const reusableExecution = await tx.queryOne(`
        SELECT execution.id
        FROM monitor_executions execution
        WHERE execution.tenant_id = $1
          AND execution.subscription_id = $2
          AND execution.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM capture_task_items item
            WHERE item.tenant_id = execution.tenant_id
              AND item.metadata->>'monitorExecutionId' = execution.id::text
          )
        ORDER BY execution.created_at, execution.id
        LIMIT 1
        FOR UPDATE OF execution
      `, [subscription.tenant_id, subscription.id]);
      const executionIdsBySubscription = new Map();
      if (reusableExecution) {
        executionIdsBySubscription.set(
          String(subscription.id),
          reusableExecution.id,
        );
      }
      let dispatched;
      try {
        dispatched = await materializeProfilePatrolTask(tx, {
          tenantId: subscription.tenant_id,
          subjectType,
          agent: compatible.agent,
          subscriptions: [subscription],
          requestKey,
          title,
          monitorSettings,
          captureSettings,
          requestHash,
          executionIdsBySubscription,
          triggerType: 'profile_scan_schedule',
          requestedByName: '云端调度器',
          actorType: 'system',
          scheduledFor,
        });
      } catch (error) {
        if (error?.error === 'subscription_execution_busy') {
          results.push({
            kind: 'busy',
            subscriptionId: subscription.id,
            message: error.message,
          });
          continue;
        }
        throw error;
      }
      await tx.execute(`
        UPDATE monitor_subscriptions
        SET last_error = '', updated_at = now()
        WHERE id = $1 AND tenant_id = $2
      `, [subscription.id, subscription.tenant_id]);
      results.push({
        kind: 'created',
        subscriptionId: subscription.id,
        taskId: dispatched.task.id,
        agentOnline: dispatched.agentOnline,
      });
    }
    return results;
  });
}
