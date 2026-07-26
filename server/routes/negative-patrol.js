import crypto from 'node:crypto';
import {Router} from 'express';
import {queryAll, queryOne, withTransaction} from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  captureAgentOnline,
  normalizeCaptureAgentPlatforms,
  sanitizeCloudStructuredObject,
} from '../services/capture-cloud.js';

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXTERNAL_ID_PATTERN = /^[a-z0-9_-]{5,200}$/iu;
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const MAX_CANDIDATES = 100;

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

function sendRequestError(res, failure) {
  return res.status(failure.status || 400).json({
    ok: false,
    error: failure.error,
    message: failure.message,
    ...safeJson(failure.details),
  });
}

function normalizeCalendarDate(value) {
  const candidate = text(value, 10);
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return candidate;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === '' || value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function normalizeRecordIds(value) {
  if (value == null) return {recordIds: []};
  if (!Array.isArray(value)) {
    return {failure: requestError(
      'invalid_record_ids',
      'recordIds 必须是帖子 ID 数组',
    )};
  }
  const recordIds = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = text(rawId, 100).toLowerCase();
    if (!UUID_PATTERN.test(id)) {
      return {failure: requestError(
        'invalid_record_id',
        'recordIds 中包含无效的帖子 ID',
      )};
    }
    if (seen.has(id)) continue;
    seen.add(id);
    recordIds.push(id);
    if (recordIds.length > MAX_CANDIDATES) {
      return {failure: requestError(
        'too_many_record_ids',
        `一次最多选择 ${MAX_CANDIDATES} 条帖子`,
      )};
    }
  }
  return {recordIds};
}

export function normalizeNegativePatrolFilter(body = {}) {
  const source = safeJson(body);
  const publishDateFrom = normalizeCalendarDate(source.publishDateFrom);
  const publishDateTo = normalizeCalendarDate(source.publishDateTo);
  if (!publishDateFrom || !publishDateTo) {
    return {failure: requestError(
      'publish_date_range_required',
      '发布时间范围为必填项，格式必须是 YYYY-MM-DD',
    )};
  }
  if (publishDateFrom > publishDateTo) {
    return {failure: requestError(
      'invalid_publish_date_range',
      '发布时间开始日期不能晚于结束日期',
    )};
  }

  const platform = text(source.platform, 40).toLowerCase();
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return {failure: requestError(
      'unsupported_platform',
      '负面帖子巡查当前只支持小红书和抖音',
    )};
  }

  const limit = boundedInteger(source.limit, 50, 1, MAX_CANDIDATES);
  if (limit == null) {
    return {failure: requestError(
      'invalid_limit',
      `limit 必须是 1-${MAX_CANDIDATES} 的整数`,
    )};
  }
  const minInteractions = boundedInteger(
    source.minInteractions,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (minInteractions == null) {
    return {failure: requestError(
      'invalid_min_interactions',
      'minInteractions 必须是非负整数',
    )};
  }

  return {
    filter: {
      publishDateFrom,
      publishDateTo,
      platform,
      query: text(source.query, 200),
      minInteractions,
      limit,
      timezone: 'Asia/Shanghai',
      sentiment: 'negative',
      excludePendingFalsePositive: true,
    },
  };
}

function validPlatformUrl(platform, rawUrl, externalId) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (platform === 'xiaohongshu') {
      if (
        !(
          hostname === 'xiaohongshu.com' ||
          hostname.endsWith('.xiaohongshu.com')
        ) ||
        !/\/(?:explore|discovery\/item)\//u.test(pathname) ||
        !pathname.includes(externalId)
      ) {
        return '';
      }
      if (
        parsed.searchParams.get('xsec_token') &&
        !parsed.searchParams.get('xsec_source')
      ) {
        parsed.searchParams.set('xsec_source', 'pc_search');
      }
      return parsed.toString();
    }
    if (platform === 'douyin') {
      if (
        !(
          hostname === 'douyin.com' ||
          hostname.endsWith('.douyin.com')
        ) ||
        !/\/(?:video|note)\//u.test(pathname) ||
        !pathname.includes(externalId)
      ) {
        return '';
      }
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

export function negativePatrolTargetUrl(record = {}) {
  const platform = text(record.platform, 40).toLowerCase();
  const externalId = text(record.external_id || record.externalId, 200);
  if (
    !SUPPORTED_PLATFORMS.has(platform) ||
    !EXTERNAL_ID_PATTERN.test(externalId)
  ) {
    return '';
  }
  const capturedUrl =
    validPlatformUrl(platform, text(record.url, 3000), externalId) ||
    validPlatformUrl(
      platform,
      text(record.canonical_url || record.canonicalUrl, 3000),
      externalId,
    );
  if (capturedUrl) return capturedUrl;
  if (platform === 'xiaohongshu') {
    return `https://www.xiaohongshu.com/explore/${encodeURIComponent(externalId)}`;
  }
  const contentType = text(record.note_type || record.noteType, 40).toLowerCase();
  const path = ['image', 'images', 'note', '图文'].includes(contentType)
    ? 'note'
    : 'video';
  return `https://www.douyin.com/${path}/${encodeURIComponent(externalId)}`;
}

function candidateWhere(tenantId, filter, recordIds = []) {
  const params = [
    tenantId,
    filter.platform,
    filter.publishDateFrom,
    filter.publishDateTo,
    filter.minInteractions,
  ];
  let where = `
    WHERE r.tenant_id = $1
      AND r.platform = $2
      AND r.sentiment = 'negative'
      AND r.record_type <> 'official_content'
      AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')
      AND NULLIF(BTRIM(r.publish_time), '') IS NOT NULL
      AND r.published_ts IS NOT NULL
      AND r.published_ts >= (
        $3::date::timestamp AT TIME ZONE 'Asia/Shanghai'
      )
      AND r.published_ts < (
        ($4::date::timestamp + INTERVAL '1 day')
          AT TIME ZONE 'Asia/Shanghai'
      )
      AND (r.likes + r.comments_count + r.collects + r.shares) >= $5
      AND r.external_id ~ '^[[:alnum:]_-]{5,200}$'
      AND NOT EXISTS (
        SELECT 1
        FROM record_feedback rf
        WHERE rf.tenant_id = r.tenant_id
          AND rf.record_id = r.id
          AND rf.feedback_type = 'false_positive'
          AND rf.review_status = 'pending'
      )
  `;
  if (filter.query) {
    params.push(`%${filter.query}%`);
    where += ` AND (
      r.title ILIKE $${params.length}
      OR r.content ILIKE $${params.length}
      OR r.author_name ILIKE $${params.length}
      OR r.keyword ILIKE $${params.length}
    )`;
  }
  if (recordIds.length > 0) {
    params.push(recordIds);
    where += ` AND r.id = ANY($${params.length}::uuid[])`;
  }
  return {where, params};
}

function publicCandidate(row) {
  const url = negativePatrolTargetUrl(row);
  const interactions =
    Number(row.likes || 0) +
    Number(row.comments_count || 0) +
    Number(row.collects || 0) +
    Number(row.shares || 0);
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.external_id,
    title: row.title,
    content: row.content,
    authorName: row.author_name,
    url,
    noteType: row.note_type,
    publishTime: row.publish_time,
    publishedAt: row.published_ts,
    keyword: row.keyword,
    sentiment: row.sentiment,
    interactions,
    metrics: {
      likes: Number(row.likes || 0),
      comments: Number(row.comments_count || 0),
      collects: Number(row.collects || 0),
      shares: Number(row.shares || 0),
    },
    baseline: {
      observationId: row.baseline_observation_id || null,
      capturedAt: row.baseline_captured_at || row.last_seen_at || null,
      metrics: {
        likes: Number(row.baseline_likes ?? row.likes ?? 0),
        comments: Number(
          row.baseline_comments_count ?? row.comments_count ?? 0,
        ),
        collects: Number(row.baseline_collects ?? row.collects ?? 0),
        shares: Number(row.baseline_shares ?? row.shares ?? 0),
      },
    },
  };
}

async function loadCandidates(
  executor,
  tenantId,
  filter,
  {recordIds = [], lock = false} = {},
) {
  const {where, params} = candidateWhere(tenantId, filter, recordIds);
  const totalRow = await executor.queryOne(`
    SELECT COUNT(*) AS total
    FROM records r
    ${where}
  `, params);
  const queryLimit = recordIds.length > 0 ? recordIds.length : filter.limit;
  const rowParams = [...params, queryLimit];
  const rows = await executor.queryAll(`
    SELECT
      r.id, r.platform, r.external_id, r.title, r.content,
      r.author_name, r.url, r.canonical_url, r.note_type,
      r.publish_time, r.published_ts, r.keyword, r.sentiment,
      r.likes, r.comments_count, r.collects, r.shares, r.last_seen_at,
      baseline.id AS baseline_observation_id,
      baseline.captured_at AS baseline_captured_at,
      baseline.likes AS baseline_likes,
      baseline.comments_count AS baseline_comments_count,
      baseline.collects AS baseline_collects,
      baseline.shares AS baseline_shares
    FROM records r
    LEFT JOIN LATERAL (
      SELECT ro.id, ro.captured_at, ro.likes, ro.comments_count,
        ro.collects, ro.shares
      FROM record_observations ro
      WHERE ro.tenant_id = r.tenant_id AND ro.record_id = r.id
      ORDER BY ro.captured_at DESC, ro.id DESC
      LIMIT 1
    ) baseline ON true
    ${where}
    ORDER BY r.published_ts DESC, r.id
    LIMIT $${rowParams.length}
    ${lock ? 'FOR SHARE OF r' : ''}
  `, rowParams);
  return {
    rows,
    candidates: rows.map(publicCandidate),
    total: Number(totalRow?.total || 0),
    limited: Number(totalRow?.total || 0) > rows.length,
  };
}

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

async function loadCompatibleAgent(tx, tenantId, agentId, platform) {
  if (!agentId) return {agent: null};
  const agent = await tx.queryOne(`
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
    WHERE ca.id = $1 AND ca.tenant_id = $2
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
    (
      agent.auth_code_expires_at &&
      new Date(agent.auth_code_expires_at) < new Date()
    )
  ) {
    return {failure: requestError(
      'agent_unavailable',
      '目标执行节点授权已失效、已停用或不存在',
      409,
    )};
  }
  const capabilities = safeJson(agent.capabilities);
  if (capabilities.remoteTaskCreate !== true) {
    return {failure: requestError(
      'agent_capability_missing',
      '目标执行节点版本尚不支持云端创建任务',
      409,
    )};
  }
  if (capabilities.negativePostPatrol !== true) {
    return {failure: requestError(
      'agent_negative_patrol_capability_missing',
      '目标执行节点版本尚不支持负面帖子巡查，请先升级扩展',
      409,
    )};
  }
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) {
    return {failure: requestError(
      'agent_platform_mismatch',
      '目标执行节点未配置负责该平台',
      409,
    )};
  }
  const supportedPlatforms = normalizeCaptureAgentPlatforms(
    capabilities.supportedPlatforms,
  );
  if (
    supportedPlatforms.length > 0 &&
    !supportedPlatforms.includes(platform)
  ) {
    return {failure: requestError(
      'agent_platform_unsupported',
      '目标执行节点当前版本不支持该平台',
      409,
    )};
  }
  return {agent};
}

function candidateTarget(candidate, itemId) {
  return {
    itemId,
    recordId: candidate.id,
    externalId: candidate.externalId,
    url: candidate.url,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    noteType: candidate.noteType,
    baseline: candidate.baseline,
  };
}

function patrolRequestHash({
  agentId,
  title,
  filter,
  recordIds,
  captureSettings,
}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow: 'negative_post_patrol',
    protocolVersion: 1,
    agentId: agentId || '',
    title,
    filter,
    recordIds: [...recordIds].sort(),
    captureSettings,
  })).digest('hex');
}

async function appendTaskEvent(tx, {
  tenantId,
  taskId,
  agentId = null,
  actorId,
  actorName,
  status,
  message,
  payload,
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES (
      $1, $2, $3, 'negative_patrol_created',
      'user', $4, $5, $6, $7, $8::jsonb
    )
  `, [
    tenantId,
    taskId,
    agentId,
    text(actorId, 240),
    text(actorName, 240),
    status,
    message,
    JSON.stringify(payload),
  ]);
}

router.post(
  '/negative-patrol/candidates/preview',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeNegativePatrolFilter(req.body);
      if (normalized.failure) {
        return sendRequestError(res, normalized.failure);
      }
      const result = await loadCandidates(
        {queryAll, queryOne},
        req.tenantId,
        normalized.filter,
      );
      return res.json({
        ok: true,
        candidates: result.candidates,
        total: result.total,
        limited: result.limited,
        filter: normalized.filter,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/negative-patrol/tasks',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeNegativePatrolFilter(req.body);
      if (normalized.failure) {
        return sendRequestError(res, normalized.failure);
      }
      const normalizedIds = normalizeRecordIds(req.body?.recordIds);
      if (normalizedIds.failure) {
        return sendRequestError(res, normalizedIds.failure);
      }
      const rawAgentId = text(req.body?.agentId, 100);
      const agentId = rawAgentId ? normalizedUuid(rawAgentId) : '';
      if (rawAgentId && !agentId) {
        return sendRequestError(res, requestError(
          'invalid_agent_id',
          'agentId 必须是有效 UUID',
        ));
      }
      const rawRequestKey = text(req.body?.requestKey, 100);
      const requestKey = rawRequestKey
        ? normalizedUuid(rawRequestKey)
        : crypto.randomUUID();
      if (rawRequestKey && !requestKey) {
        return sendRequestError(res, requestError(
          'invalid_request_key',
          'requestKey 必须是有效 UUID',
        ));
      }
      const title = text(
        req.body?.title || `负面帖子巡查 · ${normalized.filter.publishDateFrom} 至 ${normalized.filter.publishDateTo}`,
        240,
      );
      const captureSettings = sanitizeCloudStructuredObject(
        req.body?.captureSettings,
      );

      const result = await withTransaction(async tx => {
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['negative_post_patrol', requestKey],
        );
        const existing = await tx.queryOne(`
          SELECT task.*,
            command.id AS create_command_id,
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
          const existingMetadata = safeJson(existing.metadata);
          const requestRecordIds = normalizedIds.recordIds.length > 0
            ? normalizedIds.recordIds
            : Array.isArray(existingMetadata.selectedRecordIds)
              ? existingMetadata.selectedRecordIds
              : [];
          const requestHash = patrolRequestHash({
            agentId,
            title,
            filter: normalized.filter,
            recordIds: requestRecordIds,
            captureSettings,
          });
          if (
            existing.task_type !== 'negative_post_patrol' ||
            existingMetadata.remoteRequestHash !== requestHash
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
            agentOnline: existing.assigned_agent_id
              ? captureAgentOnline(existing.agent_last_heartbeat_at)
              : false,
            existing: true,
          };
        }

        const globalCollision = await tx.queryOne(
          'SELECT id FROM capture_tasks WHERE id = $1::uuid',
          [requestKey],
        );
        if (globalCollision) {
          return {failure: requestError(
            'idempotency_key_conflict',
            '该 requestKey 已用于其他任务',
            409,
          )};
        }

        const selection = await loadCandidates(
          tx,
          req.tenantId,
          normalized.filter,
          {
            recordIds: normalizedIds.recordIds,
            lock: true,
          },
        );
        if (selection.candidates.length === 0) {
          return {failure: requestError(
            'negative_candidates_empty',
            '当前发布时间范围和筛选条件下没有可巡查的负面帖子',
            409,
          )};
        }
        if (
          normalizedIds.recordIds.length > 0 &&
          selection.candidates.length !== normalizedIds.recordIds.length
        ) {
          const selected = new Set(
            selection.candidates.map(candidate => candidate.id),
          );
          return {failure: requestError(
            'candidate_selection_changed',
            '部分已选帖子不再符合负面、发布时间、平台或链接条件，请刷新候选列表',
            409,
            {
              invalidRecordIds: normalizedIds.recordIds.filter(
                id => !selected.has(id),
              ),
            },
          )};
        }
        const selectedRecordIds = selection.candidates.map(
          candidate => candidate.id,
        );
        const requestHash = patrolRequestHash({
          agentId,
          title,
          filter: normalized.filter,
          recordIds: selectedRecordIds,
          captureSettings,
        });

        const compatible = await loadCompatibleAgent(
          tx,
          req.tenantId,
          agentId,
          normalized.filter.platform,
        );
        if (compatible.failure) return {failure: compatible.failure};
        const agent = compatible.agent;
        const commandId = agent ? crypto.randomUUID() : null;
        const itemStatus = agent ? 'dispatched' : 'pending';
        const taskStatus = agent ? 'pending' : 'waiting_device';
        const metadata = {
          workflow: 'negative_post_patrol',
          protocolVersion: 1,
          remoteCreated: true,
          remoteRequestHash: requestHash,
          createCommandId: commandId || '',
          requestedByUserId: req.user?.id || '',
          requestedByName: text(req.actorName, 240),
          filter: normalized.filter,
          selectedRecordIds,
          captureSettings,
        };
        const task = await tx.queryOne(`
          INSERT INTO capture_tasks (
            id, tenant_id, origin_agent_id, assigned_agent_id,
            client_task_id, task_type, feature_key, title, platform,
            source, trigger_type, status, progress, checkpoint, counts,
            metadata, message, orchestration_revision, source_updated_at
          ) VALUES (
            $1::uuid, $2, $3, $3,
            $1::uuid::text, 'negative_post_patrol',
            'negative_post_patrol', $4, $5,
            'cloud', 'negative_patrol_manual', $6,
            $7::jsonb, $8::jsonb, $9::jsonb,
            $10::jsonb, $11, $12, now()
          )
          RETURNING *
        `, [
          requestKey,
          req.tenantId,
          agent?.id || null,
          title,
          normalized.filter.platform,
          taskStatus,
          JSON.stringify({
            current: 0,
            total: selection.candidates.length,
            percent: 0,
            phase: agent ? 'queued' : 'unassigned',
          }),
          JSON.stringify({targetIndex: 0}),
          JSON.stringify({
            total: selection.candidates.length,
            assigned: agent ? selection.candidates.length : 0,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          }),
          JSON.stringify(metadata),
          agent
            ? '负面帖子巡查任务已创建，等待目标设备领取'
            : '负面帖子巡查任务已创建，等待分配执行节点',
          agent ? 1 : 0,
        ]);

        const targets = [];
        for (
          let ordinal = 0;
          ordinal < selection.candidates.length;
          ordinal += 1
        ) {
          const candidate = selection.candidates[ordinal];
          const itemId = crypto.randomUUID();
          const itemMetadata = {
            sourceRecord: {
              title: candidate.title,
              authorName: candidate.authorName,
              publishedAt: candidate.publishedAt,
              publishTime: candidate.publishTime,
              keyword: candidate.keyword,
              noteType: candidate.noteType,
            },
            baseline: candidate.baseline,
          };
          await tx.execute(`
            INSERT INTO capture_task_items (
              id, tenant_id, task_id, item_key, ordinal,
              platform, item_type, record_id, external_id, url_snapshot,
              status, assigned_agent_id, execution_task_id,
              assignment_revision, request_hash, assigned_at, dispatched_at,
              metadata
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, 'negative_post', $7, $8, $9,
              $10, $11, $12, $13, $14,
              CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END,
              CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END,
              $15::jsonb
            )
          `, [
            itemId,
            req.tenantId,
            task.id,
            `record:${candidate.id}`,
            ordinal,
            candidate.platform,
            candidate.id,
            candidate.externalId,
            candidate.url,
            itemStatus,
            agent?.id || null,
            agent ? task.id : null,
            agent ? 1 : 0,
            agent ? requestHash : '',
            JSON.stringify(itemMetadata),
          ]);
          if (agent) {
            await tx.execute(`
              INSERT INTO capture_task_item_attempts (
                id, tenant_id, item_id, parent_task_id,
                execution_task_id, agent_id, attempt_number,
                assignment_revision, status, request_hash,
                checkpoint, result, error, dispatched_at
              ) VALUES (
                $1, $2, $3, $4,
                $4, $5, 1,
                1, 'dispatched', $6,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
              )
            `, [
              crypto.randomUUID(),
              req.tenantId,
              itemId,
              task.id,
              agent.id,
              requestHash,
            ]);
          }
          targets.push(candidateTarget(candidate, itemId));
        }

        let command = null;
        if (agent) {
          const payload = {
            taskId: task.id,
            clientTaskId: task.id,
            title: task.title,
            executionMode: 'one_time',
            platform: task.platform,
            workflow: 'negative_post_patrol',
            taskKind: 'negative_post_patrol',
            protocolVersion: 1,
            targets,
            items: targets,
            captureSettings,
            requestHash,
            authCodeId: agent.auth_code_id,
            authBindingId: agent.auth_binding_id,
          };
          command = await tx.queryOne(`
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
            agent.id,
            task.id,
            JSON.stringify(payload),
            req.user?.id || null,
            text(req.actorName, 240),
          ]);
        }

        const eventMessage = agent
          ? '后台已向指定节点创建负面帖子巡查任务'
          : '后台已创建负面帖子巡查任务，等待分配执行节点';
        await appendTaskEvent(tx, {
          tenantId: req.tenantId,
          taskId: task.id,
          agentId: agent?.id || null,
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: task.status,
          message: eventMessage,
          payload: {
            commandId: command?.id || '',
            platform: task.platform,
            candidateCount: targets.length,
            publishDateFrom: normalized.filter.publishDateFrom,
            publishDateTo: normalized.filter.publishDateTo,
            requestHash,
          },
        });
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id,
            action, target_type, target_id, metadata
          ) VALUES (
            $1, 'user', $2, $3,
            'negative_patrol.create', 'capture_task', $4, $5::jsonb
          )
        `, [
          req.tenantId,
          text(req.user?.id || '', 240),
          req.user?.id || null,
          task.id,
          JSON.stringify({
            agentId: agent?.id || '',
            platform: task.platform,
            candidateCount: targets.length,
            publishDateFrom: normalized.filter.publishDateFrom,
            publishDateTo: normalized.filter.publishDateTo,
            requestHash,
          }),
        ]);
        return {
          task,
          commandId: command?.id || null,
          commandExpiresAt: command?.expires_at || null,
          agentOnline: agent
            ? captureAgentOnline(agent.last_heartbeat_at)
            : false,
          existing: false,
        };
      });

      if (result.failure) {
        return sendRequestError(res, result.failure);
      }
      const message = result.existing
        ? '相同请求已存在，已返回原任务状态'
        : result.task.assigned_agent_id
          ? result.agentOnline
            ? '任务已创建并下发，在线设备将领取执行'
            : '任务已创建并排队，设备上线后将自动领取'
          : '任务已创建，等待分配执行节点';
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        task: result.task,
        commandId: result.commandId,
        commandExpiresAt: result.commandExpiresAt,
        agentOnline: result.agentOnline,
        existing: result.existing,
        message,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
