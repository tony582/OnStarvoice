import crypto from 'node:crypto';
import {Router} from 'express';
import {queryAll, queryOne, withTransaction} from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  captureAgentOnline,
  findCaptureAgentExecutionSlotBlocker,
  lockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  sanitizeCloudStructuredObject,
} from '../services/capture-cloud.js';
import {aggregateParentTaskItems} from '../services/capture-orchestration.js';
import {
  getContentPatrolPostTimeline,
  getNegativePatrolAnalytics,
  getNegativePatrolPostTimeline,
} from '../services/negative-patrol-analytics.js';

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXTERNAL_ID_PATTERN = /^[a-z0-9_-]{5,200}$/iu;
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const ANALYTICS_PLATFORMS = new Set([
  '',
  'xiaohongshu',
  'douyin',
  'weibo',
]);
const ANALYTICS_STATUSES = new Set([
  '',
  'available',
  'unavailable',
  'baseline_pending',
]);
const MAX_CANDIDATES = 100;
const NEGATIVE_PATROL_REASSIGNABLE_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'retryable',
  'needs_action',
  'failed',
]);
const NEGATIVE_PATROL_ACTIVE_CHILD_STATUSES =
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES;
const NEGATIVE_PATROL_TERMINAL_ATTEMPT_STATUSES = [
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
];

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

function normalizeAnalyticsPeriod(query = {}) {
  const endValue = text(query.periodEnd || query.end, 40);
  const startValue = text(query.periodStart || query.start, 40);
  const periodEnd = endValue ? new Date(endValue) : new Date();
  const periodStart = startValue
    ? new Date(startValue)
    : new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    periodStart >= periodEnd
  ) {
    return {failure: requestError(
      'invalid_period',
      'periodStart 必须早于 periodEnd，且两者均为有效日期',
    )};
  }
  if (periodEnd.getTime() - periodStart.getTime() > 366 * 24 * 60 * 60 * 1000) {
    return {failure: requestError(
      'period_too_large',
      '单次舆情巡查分析最多查询 366 天',
    )};
  }
  const rawKeywords = Array.isArray(query.keywords)
    ? query.keywords
    : String(query.keywords || '').split(',');
  const keywords = [...new Set(rawKeywords
    .map(keyword => text(keyword, 200))
    .filter(Boolean))].slice(0, 100);
  const platform = text(query.platform, 40).toLowerCase();
  if (!ANALYTICS_PLATFORMS.has(platform)) {
    return {failure: requestError(
      'invalid_analytics_platform',
      'platform 仅支持 xiaohongshu、douyin 或 weibo',
    )};
  }
  const status = text(query.status, 40).toLowerCase();
  if (status === 'high_risk') {
    return {failure: requestError(
      'unsupported_analytics_status',
      '当前缺少可靠的统一风险等级字段，暂不支持高风险筛选',
    )};
  }
  if (!ANALYTICS_STATUSES.has(status)) {
    return {failure: requestError(
      'invalid_analytics_status',
      'status 仅支持 available、unavailable 或 baseline_pending',
    )};
  }
  return {periodStart, periodEnd, keywords, platform, status};
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

  const rawPlatforms = Array.isArray(source.platforms)
    ? source.platforms
    : source.platform === 'mixed'
      ? [...SUPPORTED_PLATFORMS]
      : source.platform
      ? [source.platform]
      : [];
  const platforms = [...new Set(rawPlatforms
    .map(value => text(value, 40).toLowerCase())
    .filter(Boolean))];
  if (
    platforms.length === 0 ||
    platforms.some(platform => !SUPPORTED_PLATFORMS.has(platform))
  ) {
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
      platform: platforms.length === 1 ? platforms[0] : 'mixed',
      platforms,
      query: text(source.query, 200),
      minInteractions,
      limit,
      timezone: 'Asia/Shanghai',
      sentiment: 'negative',
      excludePendingFalsePositive: true,
    },
  };
}

export function normalizeWatchedContentFilter(body = {}) {
  const source = safeJson(body);
  const rawPlatforms = Array.isArray(source.platforms)
    ? source.platforms
    : source.platform && source.platform !== 'mixed'
      ? [source.platform]
      : [...SUPPORTED_PLATFORMS];
  const platforms = [...new Set(rawPlatforms
    .map(value => text(value, 40).toLowerCase())
    .filter(Boolean))];
  if (
    platforms.length === 0 ||
    platforms.some(platform => !SUPPORTED_PLATFORMS.has(platform))
  ) {
    return {failure: requestError(
      'unsupported_platform',
      '关注内容巡查当前只支持小红书和抖音',
    )};
  }
  const limit = boundedInteger(source.limit, 100, 1, MAX_CANDIDATES);
  if (limit == null) {
    return {failure: requestError(
      'invalid_limit',
      `limit 必须是 1-${MAX_CANDIDATES} 的整数`,
    )};
  }
  return {
    filter: {
      platform: platforms.length === 1 ? platforms[0] : 'mixed',
      platforms,
      query: text(source.query, 200),
      limit,
      watchedOnly: true,
    },
  };
}

function xiaohongshuNoteIdFromPathname(pathname) {
  const directNoteMatch = String(pathname || '').match(
    /\/(?:explore|discovery\/item|note|video|search_result)\/([a-z0-9_-]+)(?:\/|$)/iu,
  );
  if (directNoteMatch?.[1]) return directNoteMatch[1];

  const profileNoteMatch = String(pathname || '').match(
    /\/user\/profile\/[a-z0-9_-]+\/([a-z0-9_-]+)(?:\/|$)/iu,
  );
  return profileNoteMatch?.[1] || '';
}

function validPlatformUrl(platform, rawUrl, externalId) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (platform === 'xiaohongshu') {
      const noteId = xiaohongshuNoteIdFromPathname(pathname);
      if (
        !(
          hostname === 'xiaohongshu.com' ||
          hostname.endsWith('.xiaohongshu.com')
        ) ||
        noteId !== externalId
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
    filter.platforms || [filter.platform],
    filter.publishDateFrom,
    filter.publishDateTo,
    filter.minInteractions,
  ];
  let where = `
    WHERE r.tenant_id = $1
      AND r.platform = ANY($2::text[])
      AND r.sentiment = 'negative'
      AND r.record_type <> 'official_content'
      AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')
      AND r.content_availability_status NOT IN (
        'deleted',
        'page_unavailable'
      )
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

function watchedCandidateWhere(tenantId, filter, recordIds = []) {
  const params = [tenantId, filter.platforms || [filter.platform]];
  let where = `
    WHERE r.tenant_id = $1
      AND r.platform = ANY($2::text[])
      AND r.record_type NOT IN ('official_content', 'blogger_profile')
      AND r.content_availability_status NOT IN ('deleted', 'page_unavailable')
      AND r.external_id ~ '^[[:alnum:]_-]{5,200}$'
      AND EXISTS (
        SELECT 1
        FROM record_watchlist rw
        WHERE rw.tenant_id = r.tenant_id
          AND rw.record_id = r.id
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

async function loadWatchedCandidates(
  executor,
  tenantId,
  filter,
  {recordIds = [], lock = false} = {},
) {
  const {where, params} = watchedCandidateWhere(
    tenantId,
    filter,
    recordIds,
  );
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
      watch.watched_at, watch.watched_by_name,
      baseline.id AS baseline_observation_id,
      baseline.captured_at AS baseline_captured_at,
      baseline.likes AS baseline_likes,
      baseline.comments_count AS baseline_comments_count,
      baseline.collects AS baseline_collects,
      baseline.shares AS baseline_shares
    FROM records r
    JOIN record_watchlist watch
      ON watch.tenant_id = r.tenant_id AND watch.record_id = r.id
    LEFT JOIN LATERAL (
      SELECT ro.id, ro.captured_at, ro.likes, ro.comments_count,
        ro.collects, ro.shares
      FROM record_observations ro
      WHERE ro.tenant_id = r.tenant_id AND ro.record_id = r.id
      ORDER BY ro.captured_at DESC, ro.id DESC
      LIMIT 1
    ) baseline ON true
    ${where}
    ORDER BY watch.watched_at DESC, r.id
    LIMIT $${rowParams.length}
    ${lock ? 'FOR SHARE OF r, watch' : ''}
  `, rowParams);
  const candidates = rows.map(row => ({
    ...publicCandidate(row),
    watchedAt: row.watched_at,
    watchedByName: row.watched_by_name,
  }));
  return {
    rows,
    candidates,
    total: Number(totalRow?.total || 0),
    limited: Number(totalRow?.total || 0) > rows.length,
  };
}

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

export function negativePatrolItemReassignable(item = {}) {
  const targetResultAvailability = text(
    safeJson(safeJson(item.metadata).targetResult).availabilityStatus,
    80,
  ).toLowerCase();
  const availability = targetResultAvailability || text(
    item.content_availability_status ||
      item.contentAvailabilityStatus,
    80,
  ).toLowerCase();
  if (['deleted', 'page_unavailable'].includes(availability)) return false;
  return NEGATIVE_PATROL_REASSIGNABLE_ITEM_STATUSES.has(
    text(item.status, 80).toLowerCase(),
  );
}

export function normalizeNegativePatrolAgentIds(body = {}) {
  const source = safeJson(body);
  const rawAgentIds = Array.isArray(source.agentIds)
    ? source.agentIds
    : source.agentId
      ? [source.agentId]
      : [];
  const agentIds = [];
  const seen = new Set();
  for (const rawAgentId of rawAgentIds) {
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

export function allocateNegativePatrolCandidates(
  candidates = [],
  agentIds = [],
) {
  if (!Array.isArray(candidates) || !Array.isArray(agentIds)) {
    return {groups: [], assignments: []};
  }
  const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)));
  if (candidates.length === 0 || uniqueAgentIds.length === 0) {
    return {groups: [], assignments: []};
  }
  const baseSize = Math.floor(candidates.length / uniqueAgentIds.length);
  const remainder = candidates.length % uniqueAgentIds.length;
  const groups = [];
  const assignments = [];
  let cursor = 0;
  for (let index = 0; index < uniqueAgentIds.length; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    if (size === 0) continue;
    const groupCandidates = candidates.slice(cursor, cursor + size);
    const group = {
      agentId: uniqueAgentIds[index],
      candidates: groupCandidates,
      startOrdinal: cursor,
      endOrdinal: cursor + size - 1,
    };
    groups.push(group);
    groupCandidates.forEach((candidate, offset) => assignments.push({
      agentId: group.agentId,
      candidate,
      ordinal: cursor + offset,
    }));
    cursor += size;
  }
  return {groups, assignments};
}

async function loadCompatibleAgent(
  tx,
  tenantId,
  agentId,
  platform,
  {workflow = 'negative_post_patrol'} = {},
) {
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
  if (
    workflow === 'negative_post_patrol' &&
    capabilities.negativePostPatrol !== true
  ) {
    return {failure: requestError(
      'agent_negative_patrol_capability_missing',
      '目标执行节点版本尚不支持负面帖子巡查，请先升级扩展',
      409,
    )};
  }
  if (
    workflow === 'watched_content_patrol' &&
    capabilities.watchedContentPatrol !== true
  ) {
    return {failure: requestError(
      'agent_watched_content_patrol_capability_missing',
      '目标执行节点版本尚不支持关注内容巡查，请先升级扩展',
      409,
    )};
  }
  if (capabilities.remoteTargetedPostCaptureV1 !== true) {
    return {failure: requestError(
      'agent_targeted_post_capability_missing',
      '目标执行节点版本尚不支持云端逐帖采集，请先升级扩展',
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

async function loadCompatibleAgents(
  tx,
  tenantId,
  agentIds,
  platformOrPlatforms,
  {
    requireOnline = false,
    requireIdle = false,
    workflow = 'negative_post_patrol',
  } = {},
) {
  const platforms = [...new Set((Array.isArray(platformOrPlatforms)
    ? platformOrPlatforms
    : [platformOrPlatforms])
    .map(value => text(value, 40).toLowerCase())
    .filter(value => SUPPORTED_PLATFORMS.has(value)))];
  const byId = new Map();
  const coveredPlatforms = new Set();
  // Lock in a stable UUID order so concurrent task creation cannot deadlock
  // when the same Agent set is submitted in a different visual order.
  for (const agentId of [...agentIds].sort()) {
    if (requireIdle) {
      await lockCaptureAgentExecutionSlot(tx, tenantId, agentId);
    }
    let compatible = null;
    let lastFailure = null;
    for (const platform of platforms) {
      const candidate = await loadCompatibleAgent(
        tx,
        tenantId,
        agentId,
        platform,
        {workflow},
      );
      if (!candidate.failure) {
        compatible = candidate;
        break;
      }
      lastFailure = candidate.failure;
      // 平台不匹配可继续尝试清单中的另一个平台；能力或授权错误无需重复。
      if (![
        'agent_platform_mismatch',
        'agent_platform_unsupported',
      ].includes(candidate.failure.error)) {
        return candidate;
      }
    }
    if (!compatible) return {failure: lastFailure || requestError(
      'agent_platform_mismatch',
      '目标执行节点不能处理当前清单中的任何平台',
      409,
    )};
    if (
      requireOnline &&
      !captureAgentOnline(compatible.agent?.last_heartbeat_at)
    ) {
      return {failure: requestError(
        'agent_offline',
        `节点“${text(
          compatible.agent?.display_name ||
          compatible.agent?.client_label ||
          agentId,
          120,
        )}”当前离线，多节点巡查只分配给在线节点`,
        409,
        {agentId},
      )};
    }
    if (requireIdle) {
      const blocker = await findCaptureAgentExecutionSlotBlocker(
        tx,
        tenantId,
        agentId,
      );
      if (blocker) {
        return {failure: requestError(
          'agent_busy',
          `节点“${text(
            compatible.agent?.display_name ||
            compatible.agent?.client_label ||
            agentId,
            120,
          )}”当前仍有任务或远程指令占用，请选择空闲节点`,
          409,
          {
            agentId,
            blockingTaskId: blocker.task_id || blocker.id,
            blockingTaskStatus: blocker.status,
            blockerKind: blocker.kind,
          },
        )};
      }
    }
    const capabilities = safeJson(compatible.agent?.capabilities);
    const allowedPlatforms = Array.isArray(compatible.agent?.allowed_platforms)
      ? compatible.agent.allowed_platforms
      : [];
    const supportedPlatforms = normalizeCaptureAgentPlatforms(
      capabilities.supportedPlatforms,
    );
    for (const platform of platforms) {
      if (
        (allowedPlatforms.length === 0 || allowedPlatforms.includes(platform)) &&
        (supportedPlatforms.length === 0 || supportedPlatforms.includes(platform))
      ) {
        coveredPlatforms.add(platform);
      }
    }
    byId.set(agentId, compatible.agent);
  }
  const missingPlatforms = platforms.filter(platform => !coveredPlatforms.has(platform));
  if (missingPlatforms.length > 0) {
    return {failure: requestError(
      'agent_platform_coverage_missing',
      `已选执行节点未覆盖${missingPlatforms.map(platform =>
        platform === 'xiaohongshu' ? '小红书' : '抖音').join('、')}平台`,
      409,
      {missingPlatforms},
    )};
  }
  return {agents: agentIds.map(agentId => byId.get(agentId)).filter(Boolean)};
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
  agentIds = [],
  title,
  filter,
  recordIds,
  captureSettings,
  distributionMode = 'fixed_batch',
  workflow = 'negative_post_patrol',
}) {
  const normalizedAgentIds = Array.isArray(agentIds)
    ? agentIds.filter(Boolean)
    : [];
  const elasticPool = distributionMode === 'elastic_pool';
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow,
    protocolVersion: elasticPool
      ? 3
      : normalizedAgentIds.length > 1
        ? 2
        : 1,
    ...(elasticPool
      ? {
          distributionMode: 'elastic_pool',
          eligibleAgentIds: normalizedAgentIds,
        }
      : normalizedAgentIds.length > 1
      ? {agentIds: normalizedAgentIds}
      : {agentId: normalizedAgentIds[0] || ''}),
    title,
    filter,
    recordIds: [...recordIds].sort(),
    captureSettings,
  })).digest('hex');
}

async function createElasticPatrolTask(tx, {
  tenantId,
  requestKey,
  title,
  filter,
  candidates,
  agents,
  captureSettings,
  requestHash,
  actorId,
  actorName,
  workflow = 'negative_post_patrol',
  featureKey = 'negative_post_patrol',
  itemType = 'negative_post',
  triggerType = 'negative_patrol_elastic_pool',
  queuedMessage = '帖子保留在云端，等待弹性节点逐篇领取',
  openedMessage = '负面帖子已进入云端弹性队列',
  openedEventType = 'negative_patrol_elastic_pool_opened',
  auditAction = 'negative_patrol.create_elastic_pool',
}) {
  const selectedRecordIds = candidates.map(candidate => candidate.id);
  const eligibleAgentIds = agents.map(agent => agent.id);
  const recoveryPolicy = {
    allowIdleAgentHandoff: true,
    platformSafetyMode: 'manual_confirmed',
  };
  const metadata = {
    workflow,
    businessTaskType: workflow,
    protocolVersion: 3,
    multiAgent: true,
    allocationMode: 'elastic_pool',
    distributionMode: 'elastic_pool',
    cloudWorkQueue: true,
    claimUnit: itemType,
    remoteCreated: true,
    remoteRequestHash: requestHash,
    requestedByUserId: actorId || '',
    requestedByName: text(actorName, 240),
    filter,
    selectedRecordIds,
    selectedAgentIds: eligibleAgentIds,
    eligibleAgentIds,
    captureSettings,
    planSnapshot: {recoveryPolicy},
    recoveryPolicy,
  };
  const parent = await tx.queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, client_task_id, task_type, feature_key,
      title, platform, source, trigger_type, status,
      progress, checkpoint, counts, metadata, message,
      orchestration_revision, source_updated_at
    ) VALUES (
      $1::uuid, $2, $1::uuid::text, 'capture_orchestration',
      $8, $3, $4, 'cloud',
      $9, 'pending',
      $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb,
      $10,
      1, now()
    )
    RETURNING *
  `, [
    requestKey,
    tenantId,
    title,
    filter.platform,
    JSON.stringify({
      current: 0,
      total: candidates.length,
      percent: 0,
      phase: 'queued',
    }),
    JSON.stringify({
      total: candidates.length,
      assigned: 0,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      agents: agents.length,
    }),
    JSON.stringify(metadata),
    featureKey,
    triggerType,
    queuedMessage,
  ]);

  for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
    const candidate = candidates[ordinal];
    await tx.execute(`
      INSERT INTO capture_task_items (
        id, tenant_id, task_id, item_key, ordinal,
        platform, item_type, record_id, external_id, url_snapshot,
        status, assigned_agent_id, execution_task_id,
        assignment_revision, request_hash, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $11, $7, $8, $9,
        'pending', NULL, NULL,
        0, '', $10::jsonb
      )
    `, [
      crypto.randomUUID(),
      tenantId,
      parent.id,
      `record:${candidate.id}`,
      ordinal,
      candidate.platform,
      candidate.id,
      candidate.externalId,
      candidate.url,
      JSON.stringify({
        sourceRecord: {
          title: candidate.title,
          content: text(candidate.content, 1000),
          authorName: candidate.authorName,
          publishedAt: candidate.publishedAt,
          publishTime: candidate.publishTime,
          keyword: candidate.keyword,
          noteType: candidate.noteType,
        },
        baseline: candidate.baseline,
      }),
      itemType,
    ]);
  }

  await appendTaskEvent(tx, {
    tenantId,
    taskId: parent.id,
    agentId: null,
    actorId,
    actorName,
    status: parent.status,
    message: openedMessage,
    eventType: openedEventType,
    payload: {
      platform: filter.platform,
      candidateCount: candidates.length,
      eligibleAgentIds,
      claimUnit: itemType,
      requestHash,
    },
  });
  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, actor_user_id,
      action, target_type, target_id, metadata
    ) VALUES (
      $1, 'user', $2, $3,
      $6,
      'capture_task', $4, $5::jsonb
    )
  `, [
    tenantId,
    text(actorId, 240),
    actorId || null,
    parent.id,
    JSON.stringify({
      platform: filter.platform,
      candidateCount: candidates.length,
      eligibleAgentIds,
      requestHash,
    }),
    auditAction,
  ]);
  return {
    task: parent,
    commandId: null,
    commandIds: [],
    commandExpiresAt: null,
    agentOnline: agents.some(agent =>
      captureAgentOnline(agent.last_heartbeat_at),
    ),
    agentCount: agents.length,
    allocation: [],
    executions: [],
    existing: false,
  };
}

function patrolGroupRequestHash(parentRequestHash, agentId, recordIds) {
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow: 'negative_post_patrol',
    protocolVersion: 2,
    parentRequestHash,
    agentId,
    recordIds,
  })).digest('hex');
}

export function negativePatrolReassignmentRequestHash({
  orchestrationId,
  requestKey,
  expectedRevision,
  agentIds = [],
}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow: 'negative_post_patrol_reassignment',
    protocolVersion: 1,
    orchestrationId,
    requestKey,
    expectedRevision,
    agentIds,
  })).digest('hex');
}

export function negativePatrolReassignmentExistingRequestMatches(
  existing = {},
  requestHash = '',
) {
  const metadata = safeJson(existing.metadata);
  return (
    existing.task_type === 'negative_post_patrol' &&
    metadata.orchestrationChild === true &&
    Boolean(requestHash) &&
    metadata.reassignmentRequestHash === requestHash
  );
}

export function negativePatrolExistingRequestMatches(
  existing = {},
  requestHash = '',
) {
  const metadata = safeJson(existing.metadata);
  const negativePatrolTask =
    existing.task_type === 'negative_post_patrol' ||
    (
      existing.task_type === 'capture_orchestration' &&
      (
        existing.feature_key === 'negative_post_patrol' ||
        metadata.workflow === 'negative_post_patrol'
      )
    );
  return (
    negativePatrolTask &&
    Boolean(requestHash) &&
    metadata.remoteRequestHash === requestHash
  );
}

function watchedContentPatrolExistingRequestMatches(
  existing = {},
  requestHash = '',
) {
  const metadata = safeJson(existing.metadata);
  return (
    existing.task_type === 'capture_orchestration' &&
    (
      existing.feature_key === 'watched_content_patrol' ||
      metadata.workflow === 'watched_content_patrol'
    ) &&
    Boolean(requestHash) &&
    metadata.remoteRequestHash === requestHash
  );
}

async function createMultiAgentPatrolTask(tx, {
  tenantId,
  requestKey,
  title,
  filter,
  candidates,
  agents,
  captureSettings,
  requestHash,
  actorId,
  actorName,
}) {
  const {groups, assignments} = allocateNegativePatrolCandidates(
    candidates,
    agents.map(agent => agent.id),
  );
  if (groups.length < 2 || assignments.length !== candidates.length) {
    return {failure: requestError(
      'multi_agent_allocation_failed',
      '多节点巡查分配未覆盖全部帖子，请刷新后重试',
      409,
    )};
  }
  const selectedRecordIds = candidates.map(candidate => candidate.id);
  const allocation = groups.map(group => {
    const agent = agents.find(candidate => candidate.id === group.agentId);
    return {
      agentId: group.agentId,
      agentName: text(
        agent?.display_name || agent?.client_label || group.agentId,
        160,
      ),
      count: group.candidates.length,
      startOrdinal: group.startOrdinal,
      endOrdinal: group.endOrdinal,
    };
  });
  const metadata = {
    workflow: 'negative_post_patrol',
    businessTaskType: 'negative_post_patrol',
    protocolVersion: 2,
    multiAgent: true,
    allocationMode: 'balanced_contiguous',
    remoteCreated: true,
    remoteRequestHash: requestHash,
    requestedByUserId: actorId || '',
    requestedByName: text(actorName, 240),
    filter,
    selectedRecordIds,
    selectedAgentIds: agents.map(agent => agent.id),
    allocation,
    captureSettings,
  };
  const parent = await tx.queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, client_task_id, task_type, feature_key,
      title, platform, source, trigger_type, status,
      progress, checkpoint, counts, metadata, message,
      orchestration_revision, source_updated_at
    ) VALUES (
      $1::uuid, $2, $1::uuid::text, 'capture_orchestration',
      'negative_post_patrol', $3, $4, 'cloud',
      'negative_patrol_multi_agent', 'pending',
      $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb,
      '负面帖子已均衡分配，等待多个执行节点领取',
      1, now()
    )
    RETURNING *
  `, [
    requestKey,
    tenantId,
    title,
    filter.platform,
    JSON.stringify({
      current: 0,
      total: candidates.length,
      percent: 0,
      phase: 'queued',
    }),
    JSON.stringify({
      total: candidates.length,
      assigned: candidates.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      agents: groups.length,
    }),
    JSON.stringify(metadata),
  ]);

  const commands = [];
  const executionTasks = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const agent = agents.find(candidate => candidate.id === group.agentId);
    if (!agent) {
      return {failure: requestError(
        'multi_agent_allocation_failed',
        '多节点巡查分配引用了不存在的执行节点',
        409,
      )};
    }
    const childTaskId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const groupRecordIds = group.candidates.map(candidate => candidate.id);
    const groupRequestHash = patrolGroupRequestHash(
      requestHash,
      agent.id,
      groupRecordIds,
    );
    const itemIds = group.candidates.map(() => crypto.randomUUID());
    const childTitle = `${title} · ${groupIndex + 1}/${groups.length}`;
    const childMetadata = {
      workflow: 'negative_post_patrol',
      taskKind: 'negative_post_patrol',
      // Multi-Agent orchestration is a server-side v2 concern. Each browser
      // still receives the established targeted-post v1 protocol so existing
      // Extension runtimes can execute their exclusive slice.
      protocolVersion: 1,
      orchestrationChild: true,
      parentTaskId: parent.id,
      orchestrationRevision: 1,
      remoteCreated: true,
      remoteRequestHash: groupRequestHash,
      createCommandId: commandId,
      requestedByUserId: actorId || '',
      requestedByName: text(actorName, 240),
      filter,
      selectedRecordIds: groupRecordIds,
      itemIds,
      captureSettings,
    };
    const child = await tx.queryOne(`
      INSERT INTO capture_tasks (
        id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
        client_task_id, task_type, feature_key, title, platform,
        source, trigger_type, status, progress, checkpoint, counts,
        metadata, message, orchestration_revision, source_updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $4,
        $1::uuid::text, 'negative_post_patrol',
        'negative_post_patrol', $5, $6,
        'cloud', 'negative_patrol_multi_agent_child', 'pending',
        $7::jsonb, jsonb_build_object('targetIndex', 0),
        $8::jsonb, $9::jsonb,
        '已分配负面帖子，等待执行节点领取',
        1, now()
      )
      RETURNING *
    `, [
      childTaskId,
      tenantId,
      parent.id,
      agent.id,
      childTitle,
      filter.platform,
      JSON.stringify({
        current: 0,
        total: group.candidates.length,
        percent: 0,
        phase: 'queued',
      }),
      JSON.stringify({
        total: group.candidates.length,
        assigned: group.candidates.length,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
      }),
      JSON.stringify(childMetadata),
    ]);

    const targets = [];
    for (let offset = 0; offset < group.candidates.length; offset += 1) {
      const candidate = group.candidates[offset];
      const itemId = itemIds[offset];
      const ordinal = group.startOrdinal + offset;
      const itemMetadata = {
        sourceRecord: {
          title: candidate.title,
          content: text(candidate.content, 1000),
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
          'dispatched', $10, $11, 1, $12, now(), now(), $13::jsonb
        )
      `, [
        itemId,
        tenantId,
        parent.id,
        `record:${candidate.id}`,
        ordinal,
        candidate.platform,
        candidate.id,
        candidate.externalId,
        candidate.url,
        agent.id,
        child.id,
        groupRequestHash,
        JSON.stringify(itemMetadata),
      ]);
      await tx.execute(`
        INSERT INTO capture_task_item_attempts (
          id, tenant_id, item_id, parent_task_id,
          execution_task_id, agent_id, attempt_number,
          assignment_revision, status, request_hash,
          checkpoint, result, error, dispatched_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, 1,
          1, 'dispatched', $7,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
        )
      `, [
        crypto.randomUUID(),
        tenantId,
        itemId,
        parent.id,
        child.id,
        agent.id,
        groupRequestHash,
      ]);
      targets.push(candidateTarget(candidate, itemId));
    }

    const payload = {
      taskId: child.id,
      clientTaskId: child.id,
      parentTaskId: parent.id,
      title: child.title,
      executionMode: 'one_time',
      platform: child.platform,
      workflow: 'negative_post_patrol',
      taskKind: 'negative_post_patrol',
      protocolVersion: 1,
      targets,
      items: targets,
      captureSettings,
      requestHash: groupRequestHash,
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
      RETURNING id, status, expires_at, created_at
    `, [
      commandId,
      tenantId,
      agent.id,
      child.id,
      JSON.stringify(payload),
      actorId || null,
      text(actorName, 240),
    ]);
    commands.push(command);
    executionTasks.push({
      taskId: child.id,
      agentId: agent.id,
      agentName: text(
        agent.display_name || agent.client_label || agent.id,
        160,
      ),
      itemCount: targets.length,
      commandId: command.id,
    });
  }

  const commandIds = commands.map(command => command.id);
  const updatedParent = await tx.queryOne(`
    UPDATE capture_tasks
    SET metadata = metadata || jsonb_build_object(
        'createCommandIds', $1::jsonb,
        'executionTaskIds', $2::jsonb
      ),
      updated_at = now()
    WHERE id = $3 AND tenant_id = $4
    RETURNING *
  `, [
    JSON.stringify(commandIds),
    JSON.stringify(executionTasks.map(execution => execution.taskId)),
    parent.id,
    tenantId,
  ]);
  await appendTaskEvent(tx, {
    tenantId,
    taskId: parent.id,
    actorId,
    actorName,
    status: parent.status,
    message: '负面帖子已均衡拆分并分别下发多个执行节点',
    payload: {
      platform: filter.platform,
      candidateCount: candidates.length,
      agentCount: groups.length,
      allocation,
      commandIds,
      requestHash,
    },
  });
  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, actor_user_id,
      action, target_type, target_id, metadata
    ) VALUES (
      $1, 'user', $2, $3,
      'negative_patrol.create_multi_agent',
      'capture_task', $4, $5::jsonb
    )
  `, [
    tenantId,
    text(actorId, 240),
    actorId || null,
    parent.id,
    JSON.stringify({
      platform: filter.platform,
      candidateCount: candidates.length,
      agentCount: groups.length,
      allocation,
      requestHash,
    }),
  ]);
  return {
    task: updatedParent || parent,
    commandId: commandIds[0] || null,
    commandIds,
    commandExpiresAt: commands[0]?.expires_at || null,
    agentOnline: true,
    agentCount: groups.length,
    allocation,
    executions: executionTasks,
    existing: false,
  };
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
  eventType = 'negative_patrol_created',
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES (
      $1, $2, $3, $4,
      'user', $5, $6, $7, $8, $9::jsonb
    )
  `, [
    tenantId,
    taskId,
    agentId,
    eventType,
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
      const normalizedIds = normalizeRecordIds(req.body?.recordIds);
      if (normalizedIds.failure) {
        return sendRequestError(res, normalizedIds.failure);
      }
      const result = await loadCandidates(
        {queryAll, queryOne},
        req.tenantId,
        normalized.filter,
        {recordIds: normalizedIds.recordIds},
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
  '/watched-content/candidates/preview',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeWatchedContentFilter(req.body);
      if (normalized.failure) {
        return sendRequestError(res, normalized.failure);
      }
      const normalizedIds = normalizeRecordIds(req.body?.recordIds);
      if (normalizedIds.failure) {
        return sendRequestError(res, normalizedIds.failure);
      }
      const result = await loadWatchedCandidates(
        {queryAll, queryOne},
        req.tenantId,
        normalized.filter,
        {recordIds: normalizedIds.recordIds},
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

router.get(
  '/negative-patrol/analytics',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const normalized = normalizeAnalyticsPeriod(req.query);
      if (normalized.failure) {
        return sendRequestError(res, normalized.failure);
      }
      const negativePatrol = await getNegativePatrolAnalytics({
        tenantId: req.tenantId,
        periodStart: normalized.periodStart,
        periodEnd: normalized.periodEnd,
        keywords: normalized.keywords,
        platform: normalized.platform,
        status: normalized.status,
      });
      return res.json({ok: true, negativePatrol});
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/negative-patrol/posts/:recordId/timeline',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const recordId = normalizedUuid(req.params.recordId);
      if (!recordId) {
        return sendRequestError(res, requestError(
          'invalid_record_id',
          'recordId 必须是有效 UUID',
        ));
      }
      const timeline = await getNegativePatrolPostTimeline({
        tenantId: req.tenantId,
        recordId,
      });
      if (!timeline) {
        return res.status(404).json({
          ok: false,
          error: 'record_not_found',
          message: '未找到该舆情内容',
        });
      }
      // RecordDrawer consumes the timeline fields directly. Keep the nested
      // property as a compatibility alias for other API consumers.
      return res.json({ok: true, ...timeline, timeline});
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/content-patrol/posts/:recordId/timeline',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const recordId = normalizedUuid(req.params.recordId);
      if (!recordId) {
        return sendRequestError(res, requestError(
          'invalid_record_id',
          'recordId 必须是有效 UUID',
        ));
      }
      const timeline = await getContentPatrolPostTimeline({
        tenantId: req.tenantId,
        recordId,
      });
      if (!timeline) {
        return res.status(404).json({
          ok: false,
          error: 'record_not_found',
          message: '未找到该舆情内容',
        });
      }
      return res.json({ok: true, ...timeline, timeline});
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/watched-content/tasks',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeWatchedContentFilter(req.body);
      if (normalized.failure) {
        return sendRequestError(res, normalized.failure);
      }
      const normalizedIds = normalizeRecordIds(req.body?.recordIds);
      if (normalizedIds.failure) {
        return sendRequestError(res, normalizedIds.failure);
      }
      const normalizedAgents = normalizeNegativePatrolAgentIds(req.body);
      if (normalizedAgents.failure) {
        return sendRequestError(res, normalizedAgents.failure);
      }
      const agentIds = normalizedAgents.agentIds;
      if (agentIds.length === 0) {
        return sendRequestError(res, requestError(
          'watched_content_patrol_agents_required',
          '请至少选择一个执行节点',
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
      const title = text(req.body?.title || '关注内容巡查', 240);
      const captureSettings = sanitizeCloudStructuredObject(
        req.body?.captureSettings,
      );

      const result = await withTransaction(async tx => {
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['watched_content_patrol', requestKey],
        );
        const existing = await tx.queryOne(`
          SELECT *
          FROM capture_tasks
          WHERE id = $1::uuid AND tenant_id = $2
          FOR UPDATE
        `, [requestKey, req.tenantId]);
        if (existing) {
          const existingMetadata = safeJson(existing.metadata);
          const requestRecordIds = normalizedIds.recordIds.length > 0
            ? normalizedIds.recordIds
            : Array.isArray(existingMetadata.selectedRecordIds)
              ? existingMetadata.selectedRecordIds
              : [];
          const existingFilter = Object.keys(safeJson(existingMetadata.filter)).length
            ? safeJson(existingMetadata.filter)
            : normalized.filter;
          const requestHash = patrolRequestHash({
            workflow: 'watched_content_patrol',
            agentIds,
            title,
            filter: existingFilter,
            recordIds: requestRecordIds,
            captureSettings,
            distributionMode: 'elastic_pool',
          });
          if (!watchedContentPatrolExistingRequestMatches(
            existing,
            requestHash,
          )) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的任务请求',
              409,
            )};
          }
          return {
            task: existing,
            agentCount: Array.isArray(existingMetadata.eligibleAgentIds)
              ? existingMetadata.eligibleAgentIds.length
              : 0,
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

        const selection = await loadWatchedCandidates(
          tx,
          req.tenantId,
          normalized.filter,
          {recordIds: normalizedIds.recordIds, lock: true},
        );
        if (selection.candidates.length === 0) {
          return {failure: requestError(
            'watched_content_candidates_empty',
            '当前筛选条件下没有可巡查的已关注内容',
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
            '部分已选内容已取消关注、不可访问或不再符合平台条件，请刷新清单',
            409,
            {
              invalidRecordIds: normalizedIds.recordIds.filter(
                id => !selected.has(id),
              ),
            },
          )};
        }
        const requiredPlatforms = [...new Set(
          selection.candidates.map(candidate => candidate.platform),
        )];
        const filter = {
          ...normalized.filter,
          platform: requiredPlatforms.length === 1
            ? requiredPlatforms[0]
            : 'mixed',
          platforms: requiredPlatforms,
        };
        const selectedRecordIds = selection.candidates.map(
          candidate => candidate.id,
        );
        const requestHash = patrolRequestHash({
          workflow: 'watched_content_patrol',
          agentIds,
          title,
          filter,
          recordIds: selectedRecordIds,
          captureSettings,
          distributionMode: 'elastic_pool',
        });
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          agentIds,
          requiredPlatforms,
          {workflow: 'watched_content_patrol'},
        );
        if (compatible.failure) return {failure: compatible.failure};
        return createElasticPatrolTask(tx, {
          tenantId: req.tenantId,
          requestKey,
          title,
          filter,
          candidates: selection.candidates,
          agents: compatible.agents,
          captureSettings,
          requestHash,
          actorId: req.user?.id || '',
          actorName: req.actorName,
          workflow: 'watched_content_patrol',
          featureKey: 'watched_content_patrol',
          itemType: 'watched_content',
          triggerType: 'watched_content_elastic_pool',
          queuedMessage: '关注内容保留在云端，等待兼容节点逐篇领取',
          openedMessage: '关注内容已进入云端弹性队列',
          openedEventType: 'watched_content_patrol_elastic_pool_opened',
          auditAction: 'watched_content_patrol.create_elastic_pool',
        });
      });

      if (result.failure) {
        return sendRequestError(res, result.failure);
      }
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        task: result.task,
        agentCount: result.agentCount || 0,
        existing: result.existing,
        message: result.existing
          ? '相同请求已存在，已返回原任务状态'
          : `${result.task?.counts?.total || 0} 条关注内容已进入云端队列，兼容节点将按平台逐篇领取`,
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
      const normalizedAgents = normalizeNegativePatrolAgentIds(req.body);
      if (normalizedAgents.failure) {
        return sendRequestError(res, normalizedAgents.failure);
      }
      const agentIds = normalizedAgents.agentIds;
      const agentId = agentIds[0] || '';
      const mixedPlatform = normalized.filter.platforms.length > 1;
      const distributionMode =
        mixedPlatform || (
          req.body?.distributionMode === 'elastic_pool' && agentIds.length > 0
        )
          ? 'elastic_pool'
          : 'fixed_batch';
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
            agentIds,
            title,
            filter: normalized.filter,
            recordIds: requestRecordIds,
            captureSettings,
            distributionMode,
          });
          if (
            !negativePatrolExistingRequestMatches(existing, requestHash)
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
            commandIds: Array.isArray(existingMetadata.createCommandIds)
              ? existingMetadata.createCommandIds
              : existing.create_command_id
                ? [existing.create_command_id]
                : [],
            commandExpiresAt: existing.create_command_expires_at || null,
            agentOnline: existingMetadata.multiAgent === true
              ? true
              : existing.assigned_agent_id
              ? captureAgentOnline(existing.agent_last_heartbeat_at)
              : false,
            agentCount: Array.isArray(existingMetadata.selectedAgentIds)
              ? existingMetadata.selectedAgentIds.length
              : existing.assigned_agent_id
                ? 1
                : 0,
            allocation: Array.isArray(existingMetadata.allocation)
              ? existingMetadata.allocation
              : [],
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
          agentIds,
          title,
          filter: normalized.filter,
          recordIds: selectedRecordIds,
          captureSettings,
          distributionMode,
        });

        if (distributionMode === 'elastic_pool') {
          if (agentIds.length === 0) {
            return {failure: requestError(
              'negative_patrol_agents_required',
              '混合平台或弹性巡查请至少选择一个执行节点',
              409,
            )};
          }
          const requiredPlatforms = [...new Set(
            selection.candidates.map(candidate => candidate.platform),
          )];
          const compatible = await loadCompatibleAgents(
            tx,
            req.tenantId,
            agentIds,
            requiredPlatforms,
          );
          if (compatible.failure) return {failure: compatible.failure};
          return createElasticPatrolTask(tx, {
            tenantId: req.tenantId,
            requestKey,
            title,
            filter: normalized.filter,
            candidates: selection.candidates,
            agents: compatible.agents,
            captureSettings,
            requestHash,
            actorId: req.user?.id || '',
            actorName: req.actorName,
          });
        }

        if (agentIds.length > 1) {
          if (
            selection.candidates.length < agentIds.length
          ) {
            return {failure: requestError(
              'negative_patrol_candidates_fewer_than_agents',
              `当前选择 ${selection.candidates.length} 条帖子，少于 ${agentIds.length} 个执行节点；请减少节点或增加帖子`,
              409,
              {
                candidateCount: selection.candidates.length,
                agentCount: agentIds.length,
              },
            )};
          }
          const compatible = await loadCompatibleAgents(
            tx,
            req.tenantId,
            agentIds,
            normalized.filter.platform,
            {requireOnline: true},
          );
          if (compatible.failure) return {failure: compatible.failure};
          return createMultiAgentPatrolTask(tx, {
            tenantId: req.tenantId,
            requestKey,
            title,
            filter: normalized.filter,
            candidates: selection.candidates,
            agents: compatible.agents,
            captureSettings,
            requestHash,
            actorId: req.user?.id || '',
            actorName: req.actorName,
          });
        }

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
          distributionMode: 'fixed_batch',
          automaticRetryDisabled:
            req.body?.recoveryPolicy?.allowIdleAgentHandoff === false,
          remoteCreated: true,
          remoteRequestHash: requestHash,
          createCommandId: commandId || '',
          requestedByUserId: req.user?.id || '',
          requestedByName: text(req.actorName, 240),
          filter: normalized.filter,
          selectedRecordIds,
          selectedAgentIds: agent ? [agent.id] : [],
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
              content: text(candidate.content, 1000),
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
          commandIds: command?.id ? [command.id] : [],
          commandExpiresAt: command?.expires_at || null,
          agentOnline: agent
            ? captureAgentOnline(agent.last_heartbeat_at)
            : false,
          agentCount: agent ? 1 : 0,
          allocation: agent
            ? [{
                agentId: agent.id,
                agentName: text(
                  agent.display_name || agent.client_label || agent.id,
                  160,
                ),
                count: targets.length,
                startOrdinal: 0,
                endOrdinal: Math.max(0, targets.length - 1),
              }]
            : [],
          existing: false,
        };
      });

      if (result.failure) {
        return sendRequestError(res, result.failure);
      }
      const resultMetadata = safeJson(result.task?.metadata);
      const elasticPool =
        resultMetadata.distributionMode === 'elastic_pool';
      const message = result.existing
        ? '相同请求已存在，已返回原任务状态'
        : elasticPool
          ? `${result.task?.counts?.total || 0} 条帖子已进入云端队列，空闲节点将逐篇领取`
        : result.agentCount > 1
          ? `任务已均衡分配给 ${result.agentCount} 个在线节点`
        : result.task.assigned_agent_id
          ? result.agentOnline
            ? '任务已创建并下发，在线设备将领取执行'
            : '任务已创建并排队，设备上线后将自动领取'
          : '任务已创建，等待分配执行节点';
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        task: result.task,
        commandId: result.commandId,
        commandIds: result.commandIds || (
          result.commandId ? [result.commandId] : []
        ),
        commandExpiresAt: result.commandExpiresAt,
        agentOnline: result.agentOnline,
        agentCount: result.agentCount || 0,
        allocation: result.allocation || [],
        executions: result.executions || [],
        existing: result.existing,
        message,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/negative-patrol/orchestrations/:id/reassign',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const orchestrationId = normalizedUuid(req.params.id);
      if (!orchestrationId) {
        return sendRequestError(res, requestError(
          'invalid_orchestration_id',
          '负面巡查编排任务 ID 必须是有效 UUID',
        ));
      }
      const rawRequestKey = text(req.body?.requestKey, 100);
      const requestKey = normalizedUuid(rawRequestKey);
      if (!requestKey) {
        return sendRequestError(res, requestError(
          'invalid_request_key',
          'requestKey 必须是有效 UUID',
        ));
      }
      const expectedRevision = boundedInteger(
        req.body?.expectedRevision,
        null,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (expectedRevision == null) {
        return sendRequestError(res, requestError(
          'invalid_expected_revision',
          'expectedRevision 必须是大于 0 的整数',
        ));
      }
      const normalizedAgents = normalizeNegativePatrolAgentIds(req.body);
      if (normalizedAgents.failure) {
        return sendRequestError(res, normalizedAgents.failure);
      }
      const agentIds = normalizedAgents.agentIds;
      if (agentIds.length === 0) {
        return sendRequestError(res, requestError(
          'negative_patrol_reassignment_agents_required',
          '请至少选择一个在线执行节点',
        ));
      }
      const reassignmentRequestHash =
        negativePatrolReassignmentRequestHash({
          orchestrationId,
          requestKey,
          expectedRevision,
          agentIds,
        });

      const result = await withTransaction(async tx => {
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [
            `negative_post_patrol_reassignment:${orchestrationId}`,
            requestKey,
          ],
        );
        await tx.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          ['capture_orchestration_control', orchestrationId],
        );
        const parent = await tx.queryOne(`
          SELECT *
          FROM capture_tasks
          WHERE id = $1::uuid AND tenant_id = $2
        `, [orchestrationId, req.tenantId]);
        if (!parent) {
          return {failure: requestError(
            'negative_patrol_orchestration_not_found',
            '负面巡查编排任务不存在',
            404,
          )};
        }
        const parentMetadata = safeJson(parent.metadata);
        if (
          parent.task_type !== 'capture_orchestration' ||
          (
            parent.feature_key !== 'negative_post_patrol' &&
            parentMetadata.workflow !== 'negative_post_patrol'
          )
        ) {
          return {failure: requestError(
            'negative_patrol_orchestration_required',
            '只有负面巡查父任务可以重新分配未完成帖子',
            409,
          )};
        }

        const existingChildren = await tx.queryAll(`
          SELECT child.*,
            command.id AS create_command_id,
            command.status AS create_command_status,
            command.expires_at AS create_command_expires_at,
            agent.display_name AS agent_display_name,
            agent.client_label AS agent_client_label
          FROM capture_tasks child
          LEFT JOIN capture_agent_commands command
            ON command.id::text = child.metadata->>'createCommandId'
            AND command.task_id = child.id
            AND command.tenant_id = child.tenant_id
          LEFT JOIN capture_agents agent
            ON agent.id = child.assigned_agent_id
            AND agent.tenant_id = child.tenant_id
          WHERE child.tenant_id = $1
            AND child.parent_task_id = $2
            AND child.metadata->>'reassignmentRequestKey' = $3
          ORDER BY child.created_at, child.id
        `, [req.tenantId, parent.id, requestKey]);
        if (existingChildren.length > 0) {
          if (
            existingChildren.some(child =>
              !negativePatrolReassignmentExistingRequestMatches(
                child,
                reassignmentRequestHash,
              )
            )
          ) {
            return {failure: requestError(
              'idempotency_key_conflict',
              '该 requestKey 已用于不同的负面巡查重分配请求',
              409,
            )};
          }
          const allocation = existingChildren.map(child => {
            const metadata = safeJson(child.metadata);
            const stored = safeJson(metadata.reassignmentAllocation);
            const itemIds = Array.isArray(metadata.itemIds)
              ? metadata.itemIds
              : [];
            return {
              agentId: child.assigned_agent_id,
              agentName: text(
                stored.agentName ||
                  child.agent_display_name ||
                  child.agent_client_label ||
                  child.assigned_agent_id,
                160,
              ),
              count: itemIds.length,
              startOrdinal: Number(stored.startOrdinal || 0),
              endOrdinal: Number(
                stored.endOrdinal ??
                  Math.max(0, itemIds.length - 1),
              ),
            };
          });
          const executions = existingChildren.map(child => {
            const metadata = safeJson(child.metadata);
            const itemIds = Array.isArray(metadata.itemIds)
              ? metadata.itemIds
              : [];
            return {
              taskId: child.id,
              agentId: child.assigned_agent_id,
              agentName: text(
                child.agent_display_name ||
                  child.agent_client_label ||
                  child.assigned_agent_id,
                160,
              ),
              itemCount: itemIds.length,
              commandId:
                child.create_command_id ||
                text(metadata.createCommandId, 100) ||
                null,
            };
          });
          return {
            existing: true,
            orchestrationId: parent.id,
            revision: Number(
              existingChildren[0].orchestration_revision ||
                safeJson(existingChildren[0].metadata)
                  .orchestrationRevision ||
                expectedRevision + 1,
            ),
            eligibleCount: allocation.reduce(
              (sum, entry) => sum + entry.count,
              0,
            ),
            allocation,
            executions,
            message: '相同重分配请求已存在，已返回原执行任务',
          };
        }

        const currentRevision = Number(parent.orchestration_revision || 0);
        if (currentRevision !== expectedRevision) {
          return {failure: requestError(
            'revision_conflict',
            '负面巡查任务已被更新，请刷新后重新选择执行节点',
            409,
            {currentRevision},
          )};
        }
        const activeChild = await tx.queryOne(`
          SELECT id, status
          FROM capture_tasks
          WHERE tenant_id = $1
            AND parent_task_id = $2
            AND status = ANY($3::text[])
          ORDER BY created_at, id
          LIMIT 1
        `, [
          req.tenantId,
          parent.id,
          NEGATIVE_PATROL_ACTIVE_CHILD_STATUSES,
        ]);
        if (activeChild) {
          return {failure: requestError(
            'negative_patrol_reassignment_execution_active',
            '仍有负面巡查执行任务在运行或等待设备，请先停止后再重新分配',
            409,
            {
              blockingTaskId: activeChild.id,
              blockingTaskStatus: activeChild.status,
            },
          )};
        }

        // Keep the same lock order as Agent heartbeat/completion:
        // Agent rows (stable UUID order) -> task items -> parent revision CAS.
        // Reversing Agent/item locks can deadlock when a heartbeat settles an
        // old execution while an operator reassigns its unfinished items.
        const compatible = await loadCompatibleAgents(
          tx,
          req.tenantId,
          agentIds,
          Array.isArray(safeJson(parentMetadata.filter).platforms)
            ? safeJson(parentMetadata.filter).platforms
            : parent.platform,
          {requireOnline: true, requireIdle: true},
        );
        if (compatible.failure) return {failure: compatible.failure};
        const agents = compatible.agents;

        const items = await tx.queryAll(`
          SELECT item.*,
            record.content_availability_status,
            record.title AS record_title,
            record.published_ts AS record_published_at,
            record.note_type AS record_note_type
          FROM capture_task_items item
          JOIN records record
            ON record.id = item.record_id
            AND record.tenant_id = item.tenant_id
          WHERE item.tenant_id = $1
            AND item.task_id = $2
            AND item.item_type = 'negative_post'
            AND item.status = ANY($3::text[])
            AND record.content_availability_status NOT IN (
              'deleted',
              'page_unavailable'
            )
          ORDER BY item.ordinal, item.id
          FOR UPDATE OF item
        `, [
          req.tenantId,
          parent.id,
          [...NEGATIVE_PATROL_REASSIGNABLE_ITEM_STATUSES],
        ]);
        const eligibleItems = items.filter(negativePatrolItemReassignable);
        if (eligibleItems.length === 0) {
          return {failure: requestError(
            'negative_patrol_reassignment_empty',
            '没有可重新分配的未完成帖子；已完成、已删除或不可访问的帖子不会重复执行',
            409,
          )};
        }
        if (eligibleItems.length < agentIds.length) {
          return {failure: requestError(
            'negative_patrol_reassignment_items_fewer_than_agents',
            `当前只有 ${eligibleItems.length} 条帖子可重分配，少于 ${agentIds.length} 个执行节点`,
            409,
            {
              eligibleCount: eligibleItems.length,
              agentCount: agentIds.length,
            },
          )};
        }
        const sourceExecutionTaskIds = Array.from(new Set(
          eligibleItems
            .map(item => normalizedUuid(item.execution_task_id))
            .filter(Boolean),
        ));
        if (sourceExecutionTaskIds.length > 0) {
          const activeCommand = await tx.queryOne(`
            SELECT id, task_id, command_type, status
            FROM capture_agent_commands
            WHERE tenant_id = $1
              AND task_id = ANY($2::uuid[])
              AND status IN ('pending', 'acknowledged')
            ORDER BY created_at, id
            LIMIT 1
          `, [req.tenantId, sourceExecutionTaskIds]);
          if (activeCommand) {
            return {failure: requestError(
              'negative_patrol_reassignment_command_active',
              '原执行任务仍有待完成指令，请等待设备确认停止后重试',
              409,
              {
                commandId: activeCommand.id,
                taskId: activeCommand.task_id,
                commandType: activeCommand.command_type,
              },
            )};
          }
        }

        const {groups, assignments} = allocateNegativePatrolCandidates(
          eligibleItems,
          agents.map(agent => agent.id),
        );
        if (
          groups.length !== agents.length ||
          assignments.length !== eligibleItems.length
        ) {
          return {failure: requestError(
            'negative_patrol_reassignment_allocation_failed',
            '未完成帖子未能完整分配，请刷新后重试',
            409,
          )};
        }

        const nextRevision = currentRevision + 1;
        const captureSettings = sanitizeCloudStructuredObject(
          parentMetadata.captureSettings,
        );
        const filter = safeJson(parentMetadata.filter);
        const executionTasks = [];
        const commandIds = [];
        const allocation = [];

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          const group = groups[groupIndex];
          const agent = agents.find(entry => entry.id === group.agentId);
          if (!agent) {
            return {failure: requestError(
              'negative_patrol_reassignment_allocation_failed',
              '重分配引用了不存在的执行节点',
              409,
            )};
          }
          const childTaskId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          const itemIds = group.candidates.map(item => item.id);
          const groupRecordIds = group.candidates.map(item => item.record_id);
          const groupRequestHash = patrolGroupRequestHash(
            reassignmentRequestHash,
            agent.id,
            groupRecordIds,
          );
          const agentName = text(
            agent.display_name || agent.client_label || agent.id,
            160,
          );
          const childTitle =
            `${parent.title} · 重分配 ${groupIndex + 1}/${groups.length}`;
          const groupAllocation = {
            agentId: agent.id,
            agentName,
            count: itemIds.length,
            startOrdinal: group.startOrdinal,
            endOrdinal: group.endOrdinal,
          };
          const childMetadata = {
            workflow: 'negative_post_patrol',
            taskKind: 'negative_post_patrol',
            protocolVersion: 1,
            orchestrationChild: true,
            parentTaskId: parent.id,
            orchestrationRevision: nextRevision,
            remoteCreated: true,
            remoteRequestHash: groupRequestHash,
            createCommandId: commandId,
            requestedByUserId: req.user?.id || '',
            requestedByName: text(req.actorName, 240),
            filter,
            selectedRecordIds: groupRecordIds,
            itemIds,
            captureSettings,
            reassignment: true,
            reassignmentRequestKey: requestKey,
            reassignmentRequestHash,
            reassignmentAllocation: groupAllocation,
          };
          const child = await tx.queryOne(`
            INSERT INTO capture_tasks (
              id, tenant_id, parent_task_id,
              origin_agent_id, assigned_agent_id,
              client_task_id, task_type, feature_key, title, platform,
              source, trigger_type, status, progress, checkpoint, counts,
              metadata, message, orchestration_revision, source_updated_at
            ) VALUES (
              $1::uuid, $2, $3,
              $4, $4,
              $1::uuid::text, 'negative_post_patrol',
              'negative_post_patrol', $5, $6,
              'cloud', 'negative_patrol_reassignment', 'pending',
              $7::jsonb, jsonb_build_object('targetIndex', 0),
              $8::jsonb, $9::jsonb,
              '未完成负面帖子已重新分配，等待执行节点领取',
              $10, now()
            )
            RETURNING *
          `, [
            childTaskId,
            req.tenantId,
            parent.id,
            agent.id,
            childTitle,
            parent.platform,
            JSON.stringify({
              current: 0,
              total: itemIds.length,
              percent: 0,
              phase: 'queued',
            }),
            JSON.stringify({
              total: itemIds.length,
              assigned: itemIds.length,
              processed: 0,
              success: 0,
              failed: 0,
              skipped: 0,
            }),
            JSON.stringify(childMetadata),
            nextRevision,
          ]);

          const targets = [];
          for (const item of group.candidates) {
            const itemMetadata = safeJson(item.metadata);
            const sourceRecord = safeJson(itemMetadata.sourceRecord);
            const sourceExecutionTaskId = normalizedUuid(
              item.execution_task_id,
            );
            await tx.execute(`
              UPDATE capture_task_item_attempts
              SET status = 'canceled',
                error = jsonb_build_object(
                  'code', 'negative_patrol_reassigned',
                  'message', '该帖子已重新分配给新的执行任务',
                  'successorExecutionTaskId', $1::uuid::text,
                  'previousError', error
                ),
                finished_at = COALESCE(finished_at, now()),
                updated_at = now()
              WHERE tenant_id = $2
                AND item_id = $3
                AND execution_task_id = $4
                AND assignment_revision = $5
                AND status <> ALL($6::text[])
            `, [
              child.id,
              req.tenantId,
              item.id,
              sourceExecutionTaskId || null,
              Number(item.assignment_revision || 0),
              NEGATIVE_PATROL_TERMINAL_ATTEMPT_STATUSES,
            ]);
            const attemptSequence = await tx.queryOne(`
              SELECT COALESCE(MAX(attempt_number), 0) + 1
                AS next_attempt_number
              FROM capture_task_item_attempts
              WHERE tenant_id = $1 AND item_id = $2
            `, [req.tenantId, item.id]);
            const nextAttemptNumber = Math.max(
              1,
              Number(attemptSequence?.next_attempt_number || 1),
            );
            const updatedItem = await tx.queryOne(`
              UPDATE capture_task_items
              SET status = 'dispatched',
                attempt_count = $12,
                assigned_agent_id = $1,
                execution_task_id = $2,
                assignment_revision = $3,
                request_hash = $4,
                result_record_id = NULL,
                result_observation_id = NULL,
                error = '{}'::jsonb,
                metadata = (
                  metadata - 'checkpoint' - 'targetResult'
                ) || jsonb_build_object(
                  'reassignmentSourceExecutionTaskId', COALESCE($5::text, ''),
                  'reassignmentRequestKey', $6::uuid::text,
                  'reassignmentRevision', $3::integer
                ),
                assigned_at = now(),
                dispatched_at = now(),
                started_at = NULL,
                finished_at = NULL,
                updated_at = now()
              WHERE id = $7
                AND tenant_id = $8
                AND task_id = $9
                AND execution_task_id IS NOT DISTINCT FROM $5::uuid
                AND assignment_revision = $10
                AND status = ANY($11::text[])
                AND EXISTS (
                  SELECT 1
                  FROM records record
                  WHERE record.id = capture_task_items.record_id
                    AND record.tenant_id = capture_task_items.tenant_id
                    AND record.content_availability_status NOT IN (
                      'deleted',
                      'page_unavailable'
                    )
                )
              RETURNING id, attempt_count, assignment_revision
            `, [
              agent.id,
              child.id,
              nextRevision,
              groupRequestHash,
              sourceExecutionTaskId || null,
              requestKey,
              item.id,
              req.tenantId,
              parent.id,
              Number(item.assignment_revision || 0),
              [...NEGATIVE_PATROL_REASSIGNABLE_ITEM_STATUSES],
              nextAttemptNumber,
            ]);
            if (!updatedItem) {
              const conflict = new Error(
                'negative_patrol_reassignment_item_conflict',
              );
              conflict.code = 'negative_patrol_reassignment_item_conflict';
              throw conflict;
            }
            await tx.execute(`
              INSERT INTO capture_task_item_attempts (
                id, tenant_id, item_id, parent_task_id,
                execution_task_id, agent_id, attempt_number,
                assignment_revision, status, request_hash,
                checkpoint, result, error, dispatched_at
              ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7,
                $8, 'dispatched', $9,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
              )
            `, [
              crypto.randomUUID(),
              req.tenantId,
              item.id,
              parent.id,
              child.id,
              agent.id,
              Number(updatedItem.attempt_count),
              Number(updatedItem.assignment_revision),
              groupRequestHash,
            ]);
            targets.push(candidateTarget({
              id: item.record_id,
              externalId: item.external_id,
              url: item.url_snapshot,
              title: sourceRecord.title || item.record_title,
              publishedAt:
                sourceRecord.publishedAt || item.record_published_at,
              noteType: sourceRecord.noteType || item.record_note_type,
              baseline: safeJson(itemMetadata.baseline),
            }, item.id));
          }

          const payload = {
            taskId: child.id,
            clientTaskId: child.id,
            parentTaskId: parent.id,
            title: child.title,
            executionMode: 'one_time',
            platform: child.platform,
            workflow: 'negative_post_patrol',
            taskKind: 'negative_post_patrol',
            protocolVersion: 1,
            targets,
            items: targets,
            captureSettings,
            requestHash: groupRequestHash,
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
            RETURNING id, status, expires_at, created_at
          `, [
            commandId,
            req.tenantId,
            agent.id,
            child.id,
            JSON.stringify(payload),
            req.user?.id || null,
            text(req.actorName, 240),
          ]);
          commandIds.push(command.id);
          allocation.push(groupAllocation);
          executionTasks.push({
            taskId: child.id,
            agentId: agent.id,
            agentName,
            itemCount: targets.length,
            commandId: command.id,
          });
          await appendTaskEvent(tx, {
            tenantId: req.tenantId,
            taskId: child.id,
            agentId: agent.id,
            actorId: req.user?.id || '',
            actorName: req.actorName,
            status: child.status,
            message: '未完成负面帖子已重新分配给该执行节点',
            eventType: 'negative_patrol_reassignment_dispatched',
            payload: {
              parentTaskId: parent.id,
              requestKey,
              revision: nextRevision,
              itemIds,
              commandId: command.id,
              sourceExecutionTaskIds: Array.from(new Set(
                group.candidates
                  .map(item => normalizedUuid(item.execution_task_id))
                  .filter(Boolean),
              )),
            },
          });
        }

        const refreshedItems = await tx.queryAll(`
          SELECT status
          FROM capture_task_items
          WHERE tenant_id = $1 AND task_id = $2
          ORDER BY ordinal, id
        `, [req.tenantId, parent.id]);
        const aggregate = aggregateParentTaskItems(refreshedItems);
        const parentCounts = {
          ...aggregate.counts,
          agents: groups.length,
        };
        const updatedParent = await tx.queryOne(`
          UPDATE capture_tasks
          SET orchestration_revision = $1,
            status = $2,
            progress = $3::jsonb,
            counts = $4::jsonb,
            metadata = metadata || jsonb_build_object(
              'lastReassignmentAt', now(),
              'lastReassignmentRequestKey', $5::uuid::text,
              'lastReassignmentRequestHash', $6::text,
              'lastReassignmentAgentIds', $7::jsonb,
              'lastReassignmentItemCount', $8::integer,
              'executionTaskIds',
                COALESCE(metadata->'executionTaskIds', '[]'::jsonb)
                  || $9::jsonb,
              'createCommandIds',
                COALESCE(metadata->'createCommandIds', '[]'::jsonb)
                  || $10::jsonb
            ),
            message = '未完成负面帖子已重新分配，等待执行节点领取',
            finished_at = NULL,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $11
            AND tenant_id = $12
            AND task_type = 'capture_orchestration'
            AND orchestration_revision = $13
          RETURNING id, orchestration_revision, status
        `, [
          nextRevision,
          aggregate.status,
          JSON.stringify(aggregate.progress),
          JSON.stringify(parentCounts),
          requestKey,
          reassignmentRequestHash,
          JSON.stringify(agentIds),
          eligibleItems.length,
          JSON.stringify(executionTasks.map(entry => entry.taskId)),
          JSON.stringify(commandIds),
          parent.id,
          req.tenantId,
          currentRevision,
        ]);
        if (!updatedParent) {
          const conflict = new Error(
            'negative_patrol_reassignment_revision_conflict',
          );
          conflict.code = 'negative_patrol_reassignment_revision_conflict';
          throw conflict;
        }

        await appendTaskEvent(tx, {
          tenantId: req.tenantId,
          taskId: parent.id,
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: updatedParent.status,
          message: `已将 ${eligibleItems.length} 条未完成帖子重新分配给 ${groups.length} 个在线节点`,
          eventType: 'negative_patrol_reassigned',
          payload: {
            requestKey,
            requestHash: reassignmentRequestHash,
            previousRevision: currentRevision,
            revision: nextRevision,
            eligibleCount: eligibleItems.length,
            excludedTerminalStatuses: [
              'completed',
              'completed_with_warnings',
              'skipped',
              'canceled',
            ],
            excludedAvailabilityStatuses: [
              'deleted',
              'page_unavailable',
            ],
            allocation,
            executions: executionTasks,
          },
        });
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id,
            action, target_type, target_id, metadata
          ) VALUES (
            $1, 'user', $2, $3,
            'negative_patrol.reassign_unfinished',
            'capture_task', $4, $5::jsonb
          )
        `, [
          req.tenantId,
          text(req.user?.id || '', 240),
          req.user?.id || null,
          parent.id,
          JSON.stringify({
            requestKey,
            requestHash: reassignmentRequestHash,
            previousRevision: currentRevision,
            revision: nextRevision,
            eligibleCount: eligibleItems.length,
            agentIds,
            allocation,
            executions: executionTasks,
            sourceExecutionTaskIds,
          }),
        ]);

        return {
          existing: false,
          orchestrationId: parent.id,
          revision: nextRevision,
          eligibleCount: eligibleItems.length,
          allocation,
          executions: executionTasks,
          message: `已重新分配 ${eligibleItems.length} 条未完成帖子`,
        };
      });

      if (result.failure) {
        return sendRequestError(res, result.failure);
      }
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        existing: result.existing,
        orchestrationId: result.orchestrationId,
        revision: result.revision,
        eligibleCount: result.eligibleCount,
        allocation: result.allocation,
        allocations: result.allocation,
        executions: result.executions,
        message: result.message,
      });
    } catch (error) {
      if (
        [
          'negative_patrol_reassignment_item_conflict',
          'negative_patrol_reassignment_revision_conflict',
        ].includes(error?.code)
      ) {
        return sendRequestError(res, requestError(
          'revision_conflict',
          '负面巡查任务已被其他操作更新，请刷新后重试',
          409,
        ));
      }
      return next(error);
    }
  },
);

export const __negativePatrolRouteInternals = {
  normalizeAnalyticsPeriod,
};

export default router;
