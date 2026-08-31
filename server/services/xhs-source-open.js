import crypto from 'node:crypto';
import { withTransaction } from '../db/init.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const XHS_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/u;
const SOURCE_OPEN_ACTIVE_STATUSES = Object.freeze([
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
]);

function text(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function requestError(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, details);
  return error;
}

export function normalizeXhsContentId(value) {
  const normalized = text(value, 100);
  return XHS_CONTENT_ID_PATTERN.test(normalized) ? normalized : '';
}

export function xhsCanonicalIdentityUrl(value) {
  const contentId = normalizeXhsContentId(value);
  return contentId
    ? `https://www.xiaohongshu.com/explore/${contentId}`
    : '';
}

export function buildXhsSourceOpenSearchQueries(record = {}, externalId = '') {
  const candidates = [
    record.title,
    record.keyword,
    record.author_name,
    externalId,
  ];
  const seen = new Set();
  const queries = [];
  for (const candidate of candidates) {
    const normalized = text(candidate, 200).replace(/\s+/gu, ' ');
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    queries.push(normalized);
    // Two bounded searches keep the command inside the two-minute lease while
    // covering both the exact title and the original collection keyword.
    if (queries.length >= 2) break;
  }
  return queries;
}

export function redactXhsRecordNavigation(record = {}) {
  if (text(record.platform, 40).toLowerCase() !== 'xiaohongshu') {
    return record;
  }
  const canonicalUrl = xhsCanonicalIdentityUrl(record.external_id);
  return {
    ...record,
    // A Xiaohongshu xsec_token is a short-lived browser/search capability,
    // never a durable management-console href. The stable URL is identity only.
    url: '',
    canonical_url: canonicalUrl,
    source_open_mode: 'agent_refresh',
    source_open_available: Boolean(canonicalUrl),
  };
}

function publicSourceOpenTask(row = {}) {
  const status = text(row.status, 80) || 'pending';
  const result = row.command_result && typeof row.command_result === 'object'
    ? row.command_result
    : {};
  const error = row.error && typeof row.error === 'object' ? row.error : {};
  return {
    taskId: text(row.id, 100),
    recordId: text(row.record_id || row.metadata?.recordId, 100),
    status,
    state: status === 'completed'
      ? 'opened'
      : ['failed', 'needs_action', 'canceled', 'skipped', 'superseded'].includes(status)
        ? 'failed'
        : 'queued',
    message: text(row.message || result.message || error.message, 1000),
    reason: text(result.reason || error.code, 120),
    agent: {
      id: text(row.agent_id || row.assigned_agent_id, 100),
      name: text(row.agent_name, 240),
    },
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    finishedAt: row.finished_at || null,
  };
}

async function loadSourceOpenTask(tx, tenantId, taskId, recordId = '') {
  const normalizedTaskId = text(taskId, 100).toLowerCase();
  const normalizedRecordId = text(recordId, 100).toLowerCase();
  if (!UUID_PATTERN.test(normalizedTaskId)) return null;
  return tx.queryOne(`
    SELECT task.id, task.status, task.message, task.error, task.metadata,
      task.assigned_agent_id, task.created_at, task.updated_at, task.finished_at,
      task.metadata->>'recordId' AS record_id,
      agent.id AS agent_id, agent.display_name AS agent_name,
      command.result AS command_result
    FROM capture_tasks task
    LEFT JOIN capture_agents agent
      ON agent.id = task.assigned_agent_id
      AND agent.tenant_id = task.tenant_id
    LEFT JOIN LATERAL (
      SELECT source_command.result
      FROM capture_agent_commands source_command
      WHERE source_command.tenant_id = task.tenant_id
        AND source_command.task_id = task.id
        AND source_command.command_type = 'create'
      ORDER BY source_command.created_at DESC, source_command.id DESC
      LIMIT 1
    ) command ON true
    WHERE task.id = $1 AND task.tenant_id = $2
      AND task.task_type = 'xiaohongshu_source_open'
      AND ($3 = '' OR task.metadata->>'recordId' = $3)
  `, [normalizedTaskId, tenantId, normalizedRecordId]);
}

export async function getXhsSourceOpenTask({tenantId, recordId, taskId}) {
  return withTransaction(async tx => {
    const row = await loadSourceOpenTask(tx, tenantId, taskId, recordId);
    return row ? publicSourceOpenTask(row) : null;
  });
}

export async function enqueueXhsSourceOpen({
  tenantId,
  recordId,
  requestedByUserId = '',
  requestedByName = '',
}) {
  const normalizedRecordId = text(recordId, 100).toLowerCase();
  if (!UUID_PATTERN.test(normalizedRecordId)) {
    throw requestError('invalid_record_id', '内容ID无效', 400);
  }

  return withTransaction(async tx => {
    const record = await tx.queryOne(`
      SELECT id, platform, external_id, keyword, title, author_name
      FROM records
      WHERE id = $1 AND tenant_id = $2
      FOR SHARE
    `, [normalizedRecordId, tenantId]);
    if (!record) {
      throw requestError('record_not_found', '内容不存在或不属于当前工作区', 404);
    }
    if (text(record.platform, 40).toLowerCase() !== 'xiaohongshu') {
      throw requestError(
        'source_open_platform_unsupported',
        '当前实时刷新入口仅用于小红书内容',
        409,
      );
    }
    const externalId = normalizeXhsContentId(record.external_id);
    if (!externalId) {
      throw requestError(
        'source_open_identity_missing',
        '该内容缺少可核验的小红书笔记ID，无法实时定位',
        409,
      );
    }

    const existing = await tx.queryOne(`
      SELECT id
      FROM capture_tasks
      WHERE tenant_id = $1
        AND task_type = 'xiaohongshu_source_open'
        AND metadata->>'recordId' = $2
        AND status = ANY($3::text[])
        AND created_at >= now() - interval '3 minutes'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [tenantId, normalizedRecordId, SOURCE_OPEN_ACTIVE_STATUSES]);
    if (existing) {
      const active = await loadSourceOpenTask(
        tx,
        tenantId,
        existing.id,
        normalizedRecordId,
      );
      return {...publicSourceOpenTask(active), reused: true};
    }

    const agent = await tx.queryOne(`
      WITH source_agent AS (
        SELECT attempt.agent_id
        FROM record_observations observation
        JOIN capture_task_item_attempts attempt
          ON attempt.id = observation.capture_task_item_attempt_id
          AND attempt.tenant_id = observation.tenant_id
        WHERE observation.tenant_id = $1
          AND observation.record_id = $2
          AND observation.capture_task_item_attempt_id IS NOT NULL
        ORDER BY observation.captured_at DESC, observation.id DESC
        LIMIT 1
      )
      SELECT agent.id, agent.display_name, agent.auth_code_id,
        agent.auth_binding_id,
        (agent.id = source_agent.agent_id) AS source_agent_match
      FROM capture_agents agent
      JOIN tenants tenant
        ON tenant.id = agent.tenant_id AND tenant.status = 'active'
      JOIN auth_codes auth_code
        ON auth_code.id = agent.auth_code_id
        AND auth_code.tenant_id = agent.tenant_id
        AND auth_code.status = 'active'
        AND (auth_code.expires_at IS NULL OR auth_code.expires_at >= now())
      JOIN auth_bindings binding
        ON binding.id = agent.auth_binding_id
        AND binding.code_id = auth_code.id
      LEFT JOIN source_agent ON true
      WHERE agent.tenant_id = $1
        AND agent.status = 'active'
        AND COALESCE(agent.last_full_heartbeat_at, agent.last_heartbeat_at)
          >= now() - interval '2 minutes'
        AND agent.capabilities->>'taskStateKnown' IS DISTINCT FROM 'false'
        AND agent.capabilities->>'remoteTaskCreate' = 'true'
        AND agent.capabilities->>'xiaohongshuSourceOpenV1' = 'true'
        AND (
          cardinality(agent.allowed_platforms) = 0
          OR 'xiaohongshu' = ANY(agent.allowed_platforms)
        )
        AND (
          CASE
            WHEN jsonb_typeof(agent.capabilities->'supportedPlatforms') = 'array'
              THEN agent.capabilities->'supportedPlatforms'
            ELSE '[]'::jsonb
          END = '[]'::jsonb
          OR CASE
            WHEN jsonb_typeof(agent.capabilities->'supportedPlatforms') = 'array'
              THEN agent.capabilities->'supportedPlatforms'
            ELSE '[]'::jsonb
          END @> '["xiaohongshu"]'::jsonb
        )
        AND NOT EXISTS (
          SELECT 1
          FROM capture_tasks active_task
          WHERE active_task.tenant_id = agent.tenant_id
            AND COALESCE(
              active_task.assigned_agent_id,
              active_task.origin_agent_id
            ) = agent.id
            AND active_task.task_type <> 'capture_orchestration'
            AND active_task.status = ANY($3::text[])
        )
        AND NOT EXISTS (
          SELECT 1
          FROM capture_agent_commands active_command
          WHERE active_command.tenant_id = agent.tenant_id
            AND active_command.agent_id = agent.id
            AND active_command.status IN ('pending', 'acknowledged')
            AND active_command.expires_at > now()
        )
      ORDER BY
        CASE WHEN agent.id = source_agent.agent_id THEN 0 ELSE 1 END,
        COALESCE(agent.last_full_heartbeat_at, agent.last_heartbeat_at) DESC,
        agent.id
      LIMIT 1
      FOR UPDATE OF agent SKIP LOCKED
    `, [tenantId, normalizedRecordId, SOURCE_OPEN_ACTIVE_STATUSES]);
    if (!agent) {
      throw requestError(
        'source_open_agent_unavailable',
        '暂无已升级到 0.4.0 且在线空闲的小红书采集节点，请确认“重庆”等节点已更新扩展并完成心跳',
        409,
      );
    }

    const taskId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const searchQueries = buildXhsSourceOpenSearchQueries(record, externalId);
    const searchQuery = searchQueries[0] || externalId;
    const canonicalUrl = xhsCanonicalIdentityUrl(externalId);
    const metadata = {
      recordId: normalizedRecordId,
      externalId,
      canonicalUrl,
      sourceOpenVersion: 1,
      sourceAgentPreferred: agent.source_agent_match === true,
      createCommandId: commandId,
      requestedByUserId: text(requestedByUserId, 100),
      requestedByName: text(requestedByName, 240),
    };
    const task = await tx.queryOne(`
      INSERT INTO capture_tasks (
        id, tenant_id, origin_agent_id, assigned_agent_id, client_task_id,
        task_type, feature_key, title, platform, source, trigger_type,
        status, progress, checkpoint, counts, metadata, message,
        source_updated_at
      ) VALUES (
        $1, $2, $3, $3, $1::uuid::text,
        'xiaohongshu_source_open', 'xiaohongshu_source_open', $4,
        'xiaohongshu', 'admin', 'record_source_open',
        'pending', $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, $8,
        now()
      )
      RETURNING *
    `, [
      taskId,
      tenantId,
      agent.id,
      `实时打开：${text(record.title || externalId, 300)}`,
      JSON.stringify({current: 0, total: 1, percent: 0, phase: 'queued'}),
      JSON.stringify({total: 1, processed: 0, success: 0, failed: 0, skipped: 0}),
      JSON.stringify(metadata),
      `已交给 ${text(agent.display_name, 240) || '在线节点'} 刷新小红书原文链接`,
    ]);
    const payload = {
      taskId,
      clientTaskId: taskId,
      executionMode: 'source_open',
      workflow: 'xiaohongshu_source_open',
      protocolVersion: 1,
      platform: 'xiaohongshu',
      recordId: normalizedRecordId,
      externalId,
      canonicalUrl,
      searchQuery,
      searchQueries,
      title: text(record.title, 500),
      authorName: text(record.author_name, 240),
      authCodeId: agent.auth_code_id,
      authBindingId: agent.auth_binding_id,
    };
    await tx.execute(`
      INSERT INTO capture_agent_commands (
        id, tenant_id, agent_id, task_id, command_type, payload,
        requested_by_user_id, requested_by_name, expires_at
      ) VALUES (
        $1, $2, $3, $4, 'create', $5::jsonb, $6, $7,
        now() + interval '2 minutes'
      )
    `, [
      commandId,
      tenantId,
      agent.id,
      taskId,
      JSON.stringify(payload),
      UUID_PATTERN.test(text(requestedByUserId, 100)) ? requestedByUserId : null,
      text(requestedByName, 240),
    ]);
    await tx.execute(`
      INSERT INTO capture_task_events (
        tenant_id, task_id, agent_id, event_type, actor_type,
        actor_id, actor_name, status, message, payload
      ) VALUES (
        $1, $2, $3, 'source_open_created', 'user',
        $4, $5, 'pending', $6, $7::jsonb
      )
    `, [
      tenantId,
      taskId,
      agent.id,
      text(requestedByUserId, 100),
      text(requestedByName, 240),
      `已向 ${text(agent.display_name, 240) || '在线节点'} 下发实时打开请求`,
      JSON.stringify({recordId: normalizedRecordId, externalId, commandId}),
    ]);

    return publicSourceOpenTask({
      ...task,
      record_id: normalizedRecordId,
      agent_id: agent.id,
      agent_name: agent.display_name,
    });
  });
}
