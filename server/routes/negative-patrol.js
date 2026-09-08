import crypto from 'node:crypto';
import {Router} from 'express';
import {
  isDbCapacityError,
  queryAll,
  queryOne,
  withTransaction,
} from '../db/init.js';
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
  const submissionConflict = failure.error === 'idempotency_key_conflict';
  return res.status(failure.status || 400).json({
    ok: false,
    created: submissionConflict ? undefined : false,
    submissionState: submissionConflict
      ? 'conflict'
      : 'rejected_before_create',
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

function decodeCandidateCursor(value) {
  const raw = text(value, 1000);
  if (!raw) return {cursor: null};
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const publishedAt = text(decoded?.publishedAt, 80);
    const id = normalizedUuid(decoded?.id);
    const instant = new Date(publishedAt);
    if (!id || Number.isNaN(instant.getTime())) throw new Error('invalid');
    return {cursor: {publishedAt: instant.toISOString(), id}};
  } catch {
    return {failure: requestError(
      'invalid_candidate_cursor',
      '候选列表游标无效，请刷新后重试',
    )};
  }
}

function encodeCandidateCursor(row) {
  if (!row?.id || !row?.published_ts) return null;
  return Buffer.from(JSON.stringify({
    publishedAt: new Date(row.published_ts).toISOString(),
    id: row.id,
  }), 'utf8').toString('base64url');
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
  const pageSize = boundedInteger(
    source.pageSize,
    limit,
    1,
    MAX_CANDIDATES,
  );
  if (pageSize == null) {
    return {failure: requestError(
      'invalid_page_size',
      `pageSize 必须是 1-${MAX_CANDIDATES} 的整数`,
    )};
  }
  const normalizedCursor = decodeCandidateCursor(source.cursor);
  if (normalizedCursor.failure) return normalizedCursor;

  return {
    filter: {
      publishDateFrom,
      publishDateTo,
      platform: platforms.length === 1 ? platforms[0] : 'mixed',
      platforms,
      query: text(source.query, 200),
      minInteractions,
      limit,
      pageSize,
      cursor: normalizedCursor.cursor,
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
      AND (
        (
          NOT (COALESCE(r.manual_overrides, '{}'::jsonb) ? 'sentiment')
          AND LOWER(BTRIM(COALESCE(r.sentiment, ''))) = 'negative'
        )
        OR (
          COALESCE(r.manual_overrides, '{}'::jsonb) ? 'sentiment'
          AND LOWER(BTRIM(CASE
            WHEN jsonb_typeof(r.manual_overrides->'sentiment') = 'object'
              THEN r.manual_overrides->'sentiment'->>'value'
            ELSE r.manual_overrides->>'sentiment'
          END)) = 'negative'
        )
        OR (
          COALESCE(r.manual_overrides, '{}'::jsonb) ? 'sentiment'
          AND LOWER(BTRIM(COALESCE(CASE
            WHEN jsonb_typeof(r.manual_overrides->'sentiment') = 'object'
              THEN r.manual_overrides->'sentiment'->>'value'
            ELSE r.manual_overrides->>'sentiment'
          END, ''))) NOT IN ('negative', 'neutral', 'positive')
          AND LOWER(BTRIM(COALESCE(r.sentiment, ''))) = 'negative'
        )
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

function negativeCandidateQualificationSql(
  where,
  {includeBaseline = false, lock = false} = {},
) {
  return `
    WITH candidate_records AS (
      SELECT
        r.*,
        triage.archived_at,
        CASE
          WHEN jsonb_typeof(r.manual_overrides->'sentiment') = 'object'
            THEN r.manual_overrides->'sentiment'->>'value'
          ELSE r.manual_overrides->>'sentiment'
        END AS manual_sentiment_raw,
        COALESCE(r.manual_overrides, '{}'::jsonb) ? 'sentiment'
          AS manual_sentiment_present,
        CASE
          WHEN jsonb_typeof(r.manual_overrides->'relevance') = 'object'
            THEN r.manual_overrides->'relevance'->>'value'
          ELSE r.manual_overrides->>'relevance'
        END AS manual_relevance_raw,
        COALESCE(r.manual_overrides, '{}'::jsonb) ? 'relevance'
          AS manual_relevance_present,
        EXISTS (
          SELECT 1
          FROM record_feedback feedback
          WHERE feedback.tenant_id = r.tenant_id
            AND feedback.record_id = r.id
            AND feedback.feedback_type = 'false_positive'
            AND feedback.review_status = 'pending'
        ) AS false_positive_pending
        ${includeBaseline ? `,
          baseline.id AS baseline_observation_id,
          baseline.captured_at AS baseline_captured_at,
          baseline.likes AS baseline_likes,
          baseline.comments_count AS baseline_comments_count,
          baseline.collects AS baseline_collects,
          baseline.shares AS baseline_shares
        ` : ''}
      FROM records r
      LEFT JOIN record_triage triage
        ON triage.tenant_id = r.tenant_id AND triage.record_id = r.id
      ${includeBaseline ? `LEFT JOIN LATERAL (
        SELECT observation.id, observation.captured_at,
          observation.likes, observation.comments_count,
          observation.collects, observation.shares
        FROM record_observations observation
        WHERE observation.tenant_id = r.tenant_id
          AND observation.record_id = r.id
        ORDER BY observation.captured_at DESC, observation.id DESC
        LIMIT 1
      ) baseline ON true` : ''}
      ${where}
      ${lock ? 'FOR SHARE OF r' : ''}
    ), effective_records AS (
      SELECT candidate_records.*,
        LOWER(BTRIM(COALESCE(manual_sentiment_raw, '')))
          AS normalized_manual_sentiment,
        LOWER(BTRIM(COALESCE(manual_relevance_raw, '')))
          AS normalized_manual_relevance,
        CASE
          WHEN manual_sentiment_present THEN
            LOWER(BTRIM(COALESCE(manual_sentiment_raw, '')))
          ELSE LOWER(BTRIM(COALESCE(sentiment, '')))
        END AS effective_sentiment,
        CASE
          WHEN manual_sentiment_present AND
            LOWER(BTRIM(COALESCE(manual_sentiment_raw, ''))) IN (
              'negative', 'neutral', 'positive'
            ) THEN 'manual_override'
          WHEN manual_sentiment_present THEN 'manual_override_invalid'
          ELSE 'record'
        END AS sentiment_source
      FROM candidate_records
    ), qualified_records AS (
      SELECT effective_records.*,
        CASE
          WHEN manual_sentiment_present
            AND normalized_manual_sentiment NOT IN (
              'negative', 'neutral', 'positive'
            ) THEN false
          WHEN manual_relevance_present
            AND normalized_manual_relevance NOT IN (
              'relevant', 'irrelevant', 'uncertain'
            ) THEN false
          WHEN archived_at IS NOT NULL THEN false
          WHEN manual_relevance_present
            AND normalized_manual_relevance = 'irrelevant' THEN false
          WHEN record_type IN ('official_content', 'blogger_profile') THEN false
          WHEN content_availability_status IN (
            'deleted', 'page_unavailable'
          ) THEN false
          WHEN COALESCE(external_id, '') !~ '^[[:alnum:]_-]{5,200}$'
            THEN false
          WHEN false_positive_pending
            AND NOT (
              manual_sentiment_present
              AND normalized_manual_sentiment = 'negative'
            ) THEN false
          WHEN NOT (
            manual_sentiment_present
            AND normalized_manual_sentiment = 'negative'
          )
            AND NOT (
              manual_relevance_present
              AND normalized_manual_relevance IN ('relevant', 'uncertain')
            )
            AND (
              COALESCE(business_visibility, '') <> 'eligible'
              OR ai_result->>'relevance' = 'irrelevant'
            ) THEN false
          ELSE true
        END AS can_dispatch,
        CASE
          WHEN manual_sentiment_present
            AND normalized_manual_sentiment NOT IN (
              'negative', 'neutral', 'positive'
            ) THEN 'manual_sentiment_invalid'
          WHEN manual_relevance_present
            AND normalized_manual_relevance NOT IN (
              'relevant', 'irrelevant', 'uncertain'
            ) THEN 'manual_relevance_invalid'
          WHEN archived_at IS NOT NULL THEN 'archived'
          WHEN manual_relevance_present
            AND normalized_manual_relevance = 'irrelevant'
            THEN 'manual_irrelevant'
          WHEN record_type IN ('official_content', 'blogger_profile')
            THEN 'official_content'
          WHEN content_availability_status IN (
            'deleted', 'page_unavailable'
          ) THEN 'content_unavailable'
          WHEN COALESCE(external_id, '') !~ '^[[:alnum:]_-]{5,200}$'
            THEN 'source_unresolvable'
          WHEN false_positive_pending
            AND NOT (
              manual_sentiment_present
              AND normalized_manual_sentiment = 'negative'
            ) THEN 'false_positive_pending'
          WHEN NOT (
            manual_sentiment_present
            AND normalized_manual_sentiment = 'negative'
          )
            AND NOT (
              manual_relevance_present
              AND normalized_manual_relevance IN ('relevant', 'uncertain')
            )
            AND (
              COALESCE(business_visibility, '') <> 'eligible'
              OR ai_result->>'relevance' = 'irrelevant'
            ) THEN 'automatic_relevance_filtered'
          ELSE 'eligible'
        END AS eligibility_code
      FROM effective_records
    )
  `;
}

const ELIGIBILITY_REASON = Object.freeze({
  eligible: '可以下发',
  manual_sentiment_invalid: '人工情感格式异常，请先核对',
  manual_relevance_invalid: '人工相关性格式异常，请先核对',
  archived: '帖子已归档，暂不下发',
  manual_irrelevant: '帖子已被人工标记为无关',
  official_content: '官方内容不执行负面巡查',
  content_unavailable: '原帖已删除或不可访问',
  source_unresolvable: '无法定位原帖地址',
  false_positive_pending: '误报反馈待复核，暂不下发',
  automatic_relevance_filtered: '自动相关性判断暂缓下发',
});

function candidateEffectiveSentiment(row = {}) {
  if (row.manual_sentiment_present === true) {
    return text(
      row.effective_sentiment ?? row.manual_sentiment_raw,
      40,
    ).toLowerCase();
  }
  return text(row.effective_sentiment ?? row.sentiment, 40).toLowerCase();
}

export function publicNegativePatrolCandidate(
  row,
  {includeBaseline = true} = {},
) {
  const url = negativePatrolTargetUrl(row);
  const manualNegative = row.manual_sentiment_present === true &&
    text(
      row.normalized_manual_sentiment ?? row.manual_sentiment_raw,
      40,
    ).toLowerCase() === 'negative';
  const falsePositiveBlocks = row.false_positive_pending === true &&
    !manualNegative;
  const canDispatchFromQualification = row.can_dispatch == null
    ? Boolean(url)
    : row.can_dispatch === true && Boolean(url);
  const canDispatch = canDispatchFromQualification && !falsePositiveBlocks;
  const eligibilityCode = !url
    ? 'source_unresolvable'
    : falsePositiveBlocks
      ? 'false_positive_pending'
      : row.eligibility_code || 'eligible';
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
    effectiveSentiment: candidateEffectiveSentiment(row),
    sentimentSource: row.sentiment_source || 'record',
    canDispatch,
    dispatchable: canDispatch,
    eligible: canDispatch,
    eligibilityCode,
    eligibilityReason: ELIGIBILITY_REASON[eligibilityCode] ||
      '当前状态暂不允许下发',
    falsePositivePending: row.false_positive_pending === true,
    interactions,
    metrics: {
      likes: Number(row.likes || 0),
      comments: Number(row.comments_count || 0),
      collects: Number(row.collects || 0),
      shares: Number(row.shares || 0),
    },
    ...(includeBaseline
      ? {
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
        }
      : {}),
  };
}

async function loadCandidates(
  executor,
  tenantId,
  filter,
  {
    recordIds = [],
    lock = false,
    includeTotal = true,
    includeBaseline = true,
  } = {},
) {
  const {where, params} = candidateWhere(tenantId, filter, recordIds);
  const qualificationSql = negativeCandidateQualificationSql(where, {
    includeBaseline,
    lock,
  });
  const totalRow = includeTotal ? await executor.queryOne(`
      ${negativeCandidateQualificationSql(where)}
      SELECT COUNT(*) AS matched_count,
        COUNT(*) FILTER (WHERE can_dispatch) AS dispatchable_count,
        COUNT(*) FILTER (WHERE NOT can_dispatch) AS deferred_count
      FROM qualified_records
    `, params) : null;
  const queryLimit = recordIds.length > 0
    ? recordIds.length
    : filter.pageSize || filter.limit;
  const rowParams = [...params];
  let cursorWhere = '';
  if (recordIds.length === 0 && filter.cursor) {
    rowParams.push(filter.cursor.publishedAt, filter.cursor.id);
    cursorWhere = `WHERE (
      published_ts < $${rowParams.length - 1}::timestamptz
      OR (
        published_ts = $${rowParams.length - 1}::timestamptz
        AND id > $${rowParams.length}::uuid
      )
    )`;
  }
  rowParams.push(queryLimit + (recordIds.length > 0 ? 0 : 1));
  const loadedRows = await executor.queryAll(`
    ${qualificationSql}
    SELECT
      *
    FROM qualified_records
    ${cursorWhere}
    ORDER BY published_ts DESC, id
    LIMIT $${rowParams.length}
  `, rowParams);
  const hasMore = recordIds.length === 0 && loadedRows.length > queryLimit;
  const rows = hasMore ? loadedRows.slice(0, queryLimit) : loadedRows;
  const total = includeTotal
    ? Number(totalRow?.matched_count || 0)
    : rows.length;
  return {
    rows,
    candidates: rows.map(row => publicNegativePatrolCandidate(
      row,
      {includeBaseline},
    )),
    total,
    matchedCount: total,
    dispatchableCount: includeTotal
      ? Number(totalRow?.dispatchable_count || 0)
      : rows.filter(row => row.can_dispatch === true).length,
    deferredCount: includeTotal
      ? Number(totalRow?.deferred_count || 0)
      : rows.filter(row => row.can_dispatch !== true).length,
    pageCount: rows.length,
    nextCursor: hasMore ? encodeCandidateCursor(rows.at(-1)) : null,
    hasMore,
    limited: hasMore,
  };
}

function watchedCandidateWhere(tenantId, filter, recordIds = []) {
  const params = [tenantId, filter.platforms || [filter.platform]];
  let where = `
    WHERE r.tenant_id = $1
      AND r.platform = ANY($2::text[])
      AND r.record_type NOT IN ('official_content', 'blogger_profile')
      AND r.business_visibility = 'eligible'
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
    ...publicNegativePatrolCandidate(row),
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
    workflow === 'negative_post_patrol' &&
    capabilities.negativePatrolTerminalReceiptV1 !== true
  ) {
    return {failure: requestError(
      'agent_negative_patrol_terminal_receipt_capability_missing',
      '目标执行节点版本尚不支持负面巡查终态回执，请先升级扩展',
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
  distributionMode = 'elastic_pool',
  pinnedAssignments = [],
  allocation = [],
}) {
  const selectedRecordIds = candidates.map(candidate => candidate.id);
  const eligibleAgentIds = agents.map(agent => agent.id);
  const fixedPinned = distributionMode === 'fixed_batch';
  const pinnedByRecordId = new Map(
    pinnedAssignments.map(entry => [entry.recordId, entry.agentId]),
  );
  const recoveryPolicy = {
    allowIdleAgentHandoff: !fixedPinned,
    platformSafetyMode: 'manual_confirmed',
  };
  const metadata = {
    workflow,
    businessTaskType: workflow,
    protocolVersion: 3,
    multiAgent: true,
    allocationMode: fixedPinned ? 'fixed_pinned' : 'elastic_pool',
    distributionMode,
    cloudWorkQueue: true,
    serverPerItemDispatchV1: workflow === 'negative_post_patrol',
    perItemAdmissionV1: workflow === 'negative_post_patrol',
    claimUnit: itemType,
    remoteCreated: true,
    remoteRequestHash: requestHash,
    requestedByUserId: actorId || '',
    requestedByName: text(actorName, 240),
    filter,
    selectedRecordIds,
    selectedAgentIds: eligibleAgentIds,
    eligibleAgentIds,
    ...(allocation.length > 0 ? {allocation} : {}),
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
      assigned: fixedPinned ? candidates.length : 0,
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

  const itemRows = candidates.map((candidate, ordinal) => ({
    id: crypto.randomUUID(),
    itemKey: `record:${candidate.id}`,
    ordinal,
    platform: candidate.platform,
    recordId: candidate.id,
    externalId: candidate.externalId,
    urlSnapshot: candidate.url,
    itemType,
    metadata: {
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
      ...(fixedPinned
        ? {pinnedAgentId: pinnedByRecordId.get(candidate.id) || ''}
        : {}),
    },
  }));
  await tx.execute(`
    INSERT INTO capture_task_items (
      id, tenant_id, task_id, item_key, ordinal,
      platform, item_type, record_id, external_id, url_snapshot,
      status, assigned_agent_id, execution_task_id,
      assignment_revision, request_hash, metadata
    )
    SELECT
      input.id, $1, $2, input.item_key, input.ordinal,
      input.platform, input.item_type, input.record_id,
      input.external_id, input.url_snapshot,
      'pending', NULL, NULL, 0, '', input.metadata
    FROM jsonb_to_recordset($3::jsonb) AS input(
      id uuid,
      item_key text,
      ordinal integer,
      platform text,
      item_type text,
      record_id uuid,
      external_id text,
      url_snapshot text,
      metadata jsonb
    )
    ORDER BY input.ordinal
  `, [
    tenantId,
    parent.id,
    JSON.stringify(itemRows.map(row => ({
      id: row.id,
      item_key: row.itemKey,
      ordinal: row.ordinal,
      platform: row.platform,
      item_type: row.itemType,
      record_id: row.recordId,
      external_id: row.externalId,
      url_snapshot: row.urlSnapshot,
      metadata: row.metadata,
    }))),
  ]);

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
      distributionMode,
      allocation,
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
      distributionMode,
      allocation,
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
    allocation,
    executions: [],
    existing: false,
  };
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
      const result = await withTransaction(tx => loadCandidates(
        tx,
        req.tenantId,
        normalized.filter,
        {
          recordIds: normalizedIds.recordIds,
          includeTotal: true,
          includeBaseline: false,
        },
      ), {
        category: 'reporting',
        waitTimeoutMs: 250,
        statementTimeoutMs: 2000,
        lockTimeoutMs: 100,
        jitOff: true,
        isolationLevel: 'repeatable_read',
        readOnly: true,
      });
      return res.json({
        ok: true,
        candidates: result.candidates,
        records: result.candidates,
        total: result.total,
        matchedCount: result.matchedCount,
        dispatchableCount: result.dispatchableCount,
        eligibleCount: result.dispatchableCount,
        deferredCount: result.deferredCount,
        pageCount: result.pageCount,
        currentPageCount: result.pageCount,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        limited: result.limited,
        filter: normalized.filter,
      });
    } catch (error) {
      if (isDbCapacityError(error) || error?.code === '57014') {
        const retryAfterMs = Math.max(
          250,
          Number(error?.retryAfterMs) || 1000,
        );
        res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        return res.status(503).json({
          ok: false,
          error: 'server_busy',
          message: '负面帖子预览查询繁忙，请稍后重试',
          retryAfterMs,
        });
      }
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
        created: result.existing !== true,
        submissionState: 'confirmed',
        taskId: result.task.id,
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
      if (normalizedIds.recordIds.length === 0) {
        return sendRequestError(res, requestError(
          'negative_patrol_record_ids_required',
          '请先在预览中明确选择要巡查的帖子',
        ));
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
            includeTotal: false,
            includeBaseline: true,
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
        const deferredSelection = selection.candidates.filter(candidate =>
          candidate.canDispatch !== true,
        );
        if (deferredSelection.length > 0) {
          return {failure: requestError(
            'candidate_selection_changed',
            '部分已选帖子当前暂不能下发，请刷新候选列表',
            409,
            {
              invalidRecordIds: deferredSelection.map(candidate => candidate.id),
              invalidCandidates: deferredSelection.map(candidate => ({
                id: candidate.id,
                eligibilityCode: candidate.eligibilityCode,
                eligibilityReason: candidate.eligibilityReason,
                effectiveSentiment: candidate.effectiveSentiment,
                sentimentSource: candidate.sentimentSource,
              })),
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

        // The kill switch pauses creation. It must never fall back to the old
        // multi-target browser command because that path bypasses admission.
        if (process.env.NEGATIVE_PATROL_SERVER_PER_ITEM_DISABLED === 'true') {
          return {failure: requestError(
            'negative_patrol_dispatch_paused',
            '负面巡查下发暂时暂停，请稍后重试',
            503,
            {retryAfterMs: 10000},
          )};
        }
          if (agentIds.length === 0) {
            return {failure: requestError(
              'negative_patrol_agents_required',
              '请至少选择一个执行节点',
              409,
            )};
          }
          if (
            distributionMode === 'fixed_batch' &&
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

          const fixedAllocation = distributionMode === 'fixed_batch'
            ? allocateNegativePatrolCandidates(
                selection.candidates,
                compatible.agents.map(agent => agent.id),
              )
            : {groups: [], assignments: []};
          const allocation = fixedAllocation.groups.map(group => {
            const assignedAgent = compatible.agents.find(
              agent => agent.id === group.agentId,
            );
            return {
              agentId: group.agentId,
              agentName: text(
                assignedAgent?.display_name ||
                  assignedAgent?.client_label ||
                  group.agentId,
                160,
              ),
              count: group.candidates.length,
              startOrdinal: group.startOrdinal,
              endOrdinal: group.endOrdinal,
            };
          });
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
            distributionMode,
            pinnedAssignments: fixedAllocation.assignments.map(entry => ({
              recordId: entry.candidate.id,
              agentId: entry.agentId,
            })),
            allocation,
            triggerType: distributionMode === 'fixed_batch'
              ? 'negative_patrol_fixed_queue'
              : 'negative_patrol_elastic_pool',
            queuedMessage: distributionMode === 'fixed_batch'
              ? '帖子已固定到指定节点，等待服务器逐篇准入'
              : '帖子保留在云端，等待弹性节点逐篇领取',
            openedMessage: distributionMode === 'fixed_batch'
              ? '负面帖子已按固定节点进入逐帖队列'
              : '负面帖子已进入云端弹性队列',
            openedEventType: distributionMode === 'fixed_batch'
              ? 'negative_patrol_fixed_queue_opened'
              : 'negative_patrol_elastic_pool_opened',
            auditAction: distributionMode === 'fixed_batch'
              ? 'negative_patrol.create_fixed_queue'
              : 'negative_patrol.create_elastic_pool',
          });

      });

      if (result.failure) {
        return sendRequestError(res, result.failure);
      }
      const resultMetadata = safeJson(result.task?.metadata);
      const elasticPool =
        resultMetadata.distributionMode === 'elastic_pool';
      const fixedPerItemQueue =
        resultMetadata.serverPerItemDispatchV1 === true &&
        resultMetadata.distributionMode === 'fixed_batch';
      const message = result.existing
        ? '相同请求已存在，已返回原任务状态'
        : elasticPool
          ? `${result.task?.counts?.total || 0} 条帖子已进入云端队列，空闲节点将逐篇领取`
        : fixedPerItemQueue
          ? `${result.task?.counts?.total || 0} 条帖子已固定到指定节点，服务器将逐篇准入`
        : result.agentCount > 1
          ? `任务已均衡分配给 ${result.agentCount} 个在线节点`
        : result.task.assigned_agent_id
          ? result.agentOnline
            ? '任务已创建并下发，在线设备将领取执行'
            : '任务已创建并排队，设备上线后将自动领取'
          : '任务已创建，等待分配执行节点';
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        created: result.existing !== true,
        submissionState: 'confirmed',
        taskId: result.task.id,
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

          const previousRequestKey = text(
            parentMetadata.lastReassignmentRequestKey,
            100,
          );
          if (previousRequestKey === requestKey) {
            if (
              parentMetadata.lastReassignmentRequestHash !==
              reassignmentRequestHash
            ) {
              return {failure: requestError(
                'idempotency_key_conflict',
                '该 requestKey 已用于不同的负面巡查重分配请求',
                409,
              )};
            }
            const storedAllocation = Array.isArray(
              parentMetadata.lastReassignmentAllocation,
            ) ? parentMetadata.lastReassignmentAllocation : [];
            return {
              existing: true,
              orchestrationId: parent.id,
              revision: Number(parent.orchestration_revision || 0),
              eligibleCount: Number(
                parentMetadata.lastReassignmentItemCount || 0,
              ),
              allocation: storedAllocation,
              executions: [],
              message: '相同重分配请求已存在，已返回当前逐帖队列',
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
          if (parent.status === 'canceled') {
            return {failure: requestError(
              'negative_patrol_reassignment_stopped',
              '已停止的负面巡查不能重新分配',
              409,
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

          const compatible = await loadCompatibleAgents(
            tx,
            req.tenantId,
            agentIds,
            Array.isArray(safeJson(parentMetadata.filter).platforms)
              ? safeJson(parentMetadata.filter).platforms
              : parent.platform,
          );
          if (compatible.failure) return {failure: compatible.failure};
          const items = await tx.queryAll(`
            SELECT item.*, record.content_availability_status
            FROM capture_task_items item
            JOIN records record
              ON record.id = item.record_id
              AND record.tenant_id = item.tenant_id
            WHERE item.tenant_id = $1
              AND item.task_id = $2
              AND item.item_type = 'negative_post'
              AND item.status = ANY($3::text[])
              AND record.content_availability_status NOT IN (
                'deleted', 'page_unavailable'
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
              '没有可重新分配的未完成帖子',
              409,
            )};
          }
          if (eligibleItems.length < agentIds.length) {
            return {failure: requestError(
              'negative_patrol_reassignment_items_fewer_than_agents',
              `当前只有 ${eligibleItems.length} 条帖子可重分配，少于 ${agentIds.length} 个执行节点`,
              409,
              {eligibleCount: eligibleItems.length, agentCount: agentIds.length},
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
                {commandId: activeCommand.id, taskId: activeCommand.task_id},
              )};
            }
            await tx.execute(`
              UPDATE capture_tasks
              SET status = 'superseded',
                metadata = metadata || jsonb_build_object(
                  'terminalDisposition', 'superseded',
                  'terminalReason', 'negative_patrol_reassigned',
                  'terminalDispositionAt', now()::text
                ),
                message = '该执行轮次已被人工重新分配',
                finished_at = COALESCE(finished_at, now()),
                updated_at = now(),
                source_updated_at = now()
              WHERE tenant_id = $1
                AND id = ANY($2::uuid[])
                AND task_type = 'negative_post_patrol'
                AND status NOT IN ('completed', 'completed_with_warnings')
            `, [req.tenantId, sourceExecutionTaskIds]);
          }

          const {groups, assignments} = allocateNegativePatrolCandidates(
            eligibleItems,
            compatible.agents.map(agent => agent.id),
          );
          if (assignments.length !== eligibleItems.length) {
            return {failure: requestError(
              'negative_patrol_reassignment_allocation_failed',
              '未完成帖子未能完整分配，请刷新后重试',
              409,
            )};
          }
          const allocation = groups.map(group => {
            const assignedAgent = compatible.agents.find(
              agent => agent.id === group.agentId,
            );
            return {
              agentId: group.agentId,
              agentName: text(
                assignedAgent?.display_name ||
                  assignedAgent?.client_label ||
                  group.agentId,
                160,
              ),
              count: group.candidates.length,
              startOrdinal: group.startOrdinal,
              endOrdinal: group.endOrdinal,
            };
          });
          const assignmentRows = assignments.map(entry => ({
            item_id: entry.candidate.id,
            pinned_agent_id: entry.agentId,
          }));
          const itemIds = eligibleItems.map(item => item.id);
          await tx.execute(`
            UPDATE capture_task_item_attempts
            SET status = 'canceled',
              error = jsonb_build_object(
                'code', 'negative_patrol_reassigned_to_queue',
                'message', '该帖子已重新绑定到逐帖准入队列',
                'previousError', error
              ),
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
            WHERE tenant_id = $1
              AND item_id = ANY($2::uuid[])
              AND status <> ALL($3::text[])
          `, [
            req.tenantId,
            itemIds,
            NEGATIVE_PATROL_TERMINAL_ATTEMPT_STATUSES,
          ]);
          const updatedItems = await tx.queryAll(`
            UPDATE capture_task_items item
            SET status = 'pending',
              assigned_agent_id = NULL,
              execution_task_id = NULL,
              assignment_revision = item.assignment_revision + 1,
              request_hash = '',
              result_record_id = NULL,
              result_observation_id = NULL,
              error = '{}'::jsonb,
              metadata = (
                item.metadata - 'checkpoint' - 'targetResult' -
                'waitingForSourceClosure' - 'sourceClosureBlockedAt' -
                'sourceClosureBlockedReason' - 'sourceClosureBlockedAttemptId'
              ) || jsonb_build_object(
                'pinnedAgentId', assignment.pinned_agent_id,
                'reassignmentRequestKey', $2::uuid::text,
                'reassignmentRequestHash', $3::text,
                'reassignmentAt', now()::text
              ),
              assigned_at = NULL,
              dispatched_at = NULL,
              started_at = NULL,
              finished_at = NULL,
              updated_at = now()
            FROM jsonb_to_recordset($4::jsonb) AS assignment(
              item_id uuid,
              pinned_agent_id text
            )
            WHERE item.id = assignment.item_id
              AND item.tenant_id = $1
              AND item.task_id = $5
            RETURNING item.id
          `, [
            req.tenantId,
            requestKey,
            reassignmentRequestHash,
            JSON.stringify(assignmentRows),
            parent.id,
          ]);
          if (updatedItems.length !== eligibleItems.length) {
            const conflict = new Error(
              'negative_patrol_reassignment_item_conflict',
            );
            conflict.code = 'negative_patrol_reassignment_item_conflict';
            throw conflict;
          }

          const refreshedItems = await tx.queryAll(`
            SELECT status
            FROM capture_task_items
            WHERE tenant_id = $1 AND task_id = $2
            ORDER BY ordinal, id
          `, [req.tenantId, parent.id]);
          const aggregate = aggregateParentTaskItems(refreshedItems);
          const nextRevision = currentRevision + 1;
          const updatedParent = await tx.queryOne(`
            UPDATE capture_tasks
            SET orchestration_revision = $1,
              status = $2,
              progress = $3::jsonb,
              counts = $4::jsonb,
              metadata = metadata || jsonb_build_object(
                'serverPerItemDispatchV1', true,
                'perItemAdmissionV1', true,
                'distributionMode', 'fixed_batch',
                'allocationMode', 'fixed_pinned',
                'selectedAgentIds', $5::jsonb,
                'eligibleAgentIds', $5::jsonb,
                'allocation', $6::jsonb,
                'lastReassignmentAt', now(),
                'lastReassignmentRequestKey', $7::uuid::text,
                'lastReassignmentRequestHash', $8::text,
                'lastReassignmentAgentIds', $5::jsonb,
                'lastReassignmentItemCount', $9::integer,
                'lastReassignmentAllocation', $6::jsonb
              ),
              message = '未完成帖子已重新绑定，等待服务器逐篇准入',
              finished_at = NULL,
              updated_at = now(),
              source_updated_at = now()
            WHERE id = $10
              AND tenant_id = $11
              AND orchestration_revision = $12
            RETURNING id, orchestration_revision, status
          `, [
            nextRevision,
            aggregate.status,
            JSON.stringify(aggregate.progress),
            JSON.stringify({...aggregate.counts, agents: groups.length}),
            JSON.stringify(agentIds),
            JSON.stringify(allocation),
            requestKey,
            reassignmentRequestHash,
            eligibleItems.length,
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
            message: `已将 ${eligibleItems.length} 条未完成帖子重新绑定到逐帖队列`,
            eventType: 'negative_patrol_reassigned_to_queue',
            payload: {
              requestKey,
              requestHash: reassignmentRequestHash,
              previousRevision: currentRevision,
              revision: nextRevision,
              eligibleCount: eligibleItems.length,
              allocation,
            },
          });
          await tx.execute(`
            INSERT INTO audit_logs (
              tenant_id, actor_type, actor_id, actor_user_id,
              action, target_type, target_id, metadata
            ) VALUES (
              $1, 'user', $2, $3,
              'negative_patrol.reassign_per_item_queue',
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
            }),
          ]);
          return {
            existing: false,
            orchestrationId: parent.id,
            revision: nextRevision,
            eligibleCount: eligibleItems.length,
            allocation,
            executions: [],
            message: `已重新绑定 ${eligibleItems.length} 条未完成帖子，服务器将逐篇准入`,
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
  loadCandidates,
};

export default router;
