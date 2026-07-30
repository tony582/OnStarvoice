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
  sanitizeCloudStructuredObject,
} from '../services/capture-cloud.js';
import {
  loadCompatibleProfilePatrolAgent,
  materializeProfilePatrolTask,
  profilePatrolRequestHash,
} from '../services/profile-patrol-dispatch.js';
import {negativePatrolTargetUrl} from './negative-patrol.js';

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const MAX_POSTS = 100;
const MAX_COMMENTS_PER_POST = 100;
const DEFAULT_COMMENTS_LIMIT = 50;
const MAX_WORKBENCH_PAGE_SIZE = 50;
const WORKFLOW = 'official_account_comment_patrol';
const COMMENT_ACTION_TYPES = new Set([
  'delete_review',
  'reply',
  'like',
  'encourage_reply',
  'ignore',
  'ticket',
  'manual_complete',
]);
const COMMENT_ACTION_STATUSES = new Set([
  'pending',
  'completed',
  'canceled',
  'failed',
]);

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

function normalizedUuid(value) {
  const candidate = text(value, 100).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

function shanghaiCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const byType = Object.fromEntries(
    parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDays(calendarDate, delta) {
  const date = new Date(`${calendarDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === '' || value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return null;
  }
  return parsed;
}

function safeCount(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized)
    ? Math.max(0, Math.floor(normalized))
    : 0;
}

function ratio(part, total) {
  const denominator = safeCount(total);
  return denominator > 0
    ? Math.round((safeCount(part) / denominator) * 1000) / 10
    : 0;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function workbenchRiskTrend(row) {
  if (!row.previous_snapshot_at) return 'baseline';
  const currentRate = ratio(row.current_negative, row.current_sampled);
  const previousRate = ratio(row.previous_negative, row.previous_sampled);
  const negativeDelta =
    safeCount(row.current_negative) - safeCount(row.previous_negative);
  const rateDelta = Math.round((currentRate - previousRate) * 10) / 10;
  if (negativeDelta > 0 || rateDelta >= 0.5) return 'rising';
  if (negativeDelta < 0 || rateDelta <= -0.5) return 'falling';
  return 'stable';
}

function publicWorkbenchPost(row) {
  const current = {
    total: safeCount(row.current_sampled),
    positive: safeCount(row.current_positive),
    neutral: safeCount(row.current_neutral),
    negative: safeCount(row.current_negative),
    unknown: safeCount(row.current_unknown),
  };
  const previous = row.previous_snapshot_at
    ? {
        total: safeCount(row.previous_sampled),
        positive: safeCount(row.previous_positive),
        neutral: safeCount(row.previous_neutral),
        negative: safeCount(row.previous_negative),
        unknown: safeCount(row.previous_unknown),
      }
    : null;
  const negativeRate = ratio(current.negative, current.total);
  const previousNegativeRate = previous
    ? ratio(previous.negative, previous.total)
    : null;
  const engagement = {
    likes: safeCount(row.likes),
    comments: safeCount(row.platform_comments),
    shares: safeCount(row.shares),
  };
  return {
    id: row.id,
    title: row.title || row.content || '未命名作品',
    url: negativePatrolTargetUrl(row) || '',
    platform: row.platform,
    externalId: row.external_id,
    publishedAt: row.published_ts || null,
    publishTime: row.publish_time || '',
    officialAccount: {
      id: row.official_account_id,
      name: row.official_account_name,
      platform: row.platform,
    },
    coverage: {
      platformComments: safeCount(row.platform_comments),
      sampledComments: current.total,
      percent: safeCount(row.platform_comments) > 0
        ? Math.min(
            100,
            Math.round(
              (current.total / safeCount(row.platform_comments)) * 100,
            ),
          )
        : null,
      note: '平台显示数与本次可访问样本使用不同口径。',
    },
    engagement: {
      ...engagement,
      trend: row.previous_engagement_at
        ? {
            likes: engagement.likes - safeCount(row.previous_likes),
            comments:
              engagement.comments - safeCount(row.previous_platform_comments),
            shares: engagement.shares - safeCount(row.previous_shares),
            capturedAt: isoOrNull(row.previous_engagement_at),
          }
        : null,
    },
    sentiment: {
      ...current,
      negativeRate,
    },
    previousSentiment: previous
      ? {
          ...previous,
          negativeRate: previousNegativeRate,
        }
      : null,
    delta: previous
      ? {
          comments: current.total - previous.total,
          negative: current.negative - previous.negative,
          positive: current.positive - previous.positive,
          negativeRate:
            Math.round((negativeRate - previousNegativeRate) * 10) / 10,
        }
      : null,
    riskTrend: workbenchRiskTrend(row),
    todos: {
      negative: safeCount(row.negative_pending),
      positive: safeCount(row.positive_pending),
    },
    lastPatrolledAt:
      isoOrNull(row.latest_snapshot_at) ||
      isoOrNull(row.latest_comment_at),
    previousPatrolledAt: isoOrNull(row.previous_snapshot_at),
    patrolStatus: row.latest_snapshot_at
      ? 'completed'
      : safeCount(row.current_sampled) > 0
        ? 'sampled'
        : 'not_patrolled',
  };
}

function buildWorkbenchCte(tenantId, query = {}) {
  const params = [tenantId];
  const where = [
    'record.tenant_id = $1',
    "record.platform IN ('xiaohongshu', 'douyin')",
  ];
  const sort = query.sort === 'collected_desc'
    ? 'collected_desc'
    : 'published_desc';
  const platform = text(query.platform, 40).toLowerCase();
  if (SUPPORTED_PLATFORMS.has(platform)) {
    params.push(platform);
    where.push(`record.platform = $${params.length}`);
  }
  const officialAccountId = normalizedUuid(query.officialAccountId);
  if (officialAccountId) {
    params.push(officialAccountId);
    where.push(`account.id = $${params.length}::uuid`);
  }
  const search = text(query.search, 200);
  if (search) {
    params.push(`%${search}%`);
    where.push(`(
      COALESCE(record.title, '') ILIKE $${params.length}
      OR COALESCE(record.content, '') ILIKE $${params.length}
      OR COALESCE(account.account_name, '') ILIKE $${params.length}
    )`);
  }

  return {
    params,
    sort,
    sql: `
      WITH matched_posts AS (
        SELECT record.id, record.platform, record.external_id,
          record.note_type, record.title, record.content, record.url,
          record.canonical_url, record.publish_time, record.published_ts,
          record.likes, record.shares, record.latest_observation_id,
          record.comments_count AS platform_comments,
          account.id AS official_account_id,
          account.account_name AS official_account_name
        FROM records record
        JOIN LATERAL (
          SELECT candidate.id, candidate.account_name
          FROM official_accounts candidate
          WHERE candidate.tenant_id = record.tenant_id
            AND candidate.status = 'active'
            AND candidate.platform = record.platform
            AND (
              (
                NULLIF(BTRIM(candidate.platform_user_id), '') IS NOT NULL
                AND record.author_id = candidate.platform_user_id
              )
              OR (
                NULLIF(BTRIM(candidate.account_no), '') IS NOT NULL
                AND record.author_account_no = candidate.account_no
              )
              OR (
                NULLIF(BTRIM(candidate.account_id), '') IS NOT NULL
                AND (
                  record.author_id = candidate.account_id
                  OR record.author_account_no = candidate.account_id
                )
              )
            )
          ORDER BY candidate.updated_at DESC, candidate.id
          LIMIT 1
        ) account ON true
        WHERE ${where.join('\n          AND ')}
      ),
      comment_state AS (
        SELECT post.id,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
          )::integer AS sampled_comments,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND comment.sentiment = 'positive'
          )::integer AS positive_comments,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND comment.sentiment = 'neutral'
          )::integer AS neutral_comments,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND (
                comment.sentiment = 'negative'
                OR comment.is_negative = true
                OR comment.risk_level IN ('high', 'critical')
              )
          )::integer AS negative_comments,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND COALESCE(comment.sentiment, '') NOT IN (
                'positive', 'neutral', 'negative'
              )
              AND comment.is_negative = false
              AND comment.risk_level NOT IN ('high', 'critical')
          )::integer AS unknown_comments,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND (
                comment.sentiment = 'negative'
                OR comment.is_negative = true
                OR comment.risk_level IN ('high', 'critical')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM official_comment_actions action
                WHERE action.tenant_id = comment.tenant_id
                  AND action.comment_id = comment.id
                  AND action.status = 'completed'
                  AND action.action_type IN (
                    'reply', 'ignore', 'ticket', 'manual_complete'
                  )
              )
          )::integer AS negative_pending,
          COUNT(comment.id) FILTER (
            WHERE comment.is_official = false
              AND comment.sentiment = 'positive'
              AND NOT EXISTS (
                SELECT 1
                FROM official_comment_actions action
                WHERE action.tenant_id = comment.tenant_id
                  AND action.comment_id = comment.id
                  AND action.status = 'completed'
                  AND action.action_type IN (
                    'like', 'encourage_reply', 'ignore', 'manual_complete'
                  )
              )
          )::integer AS positive_pending,
          MAX(comment.last_seen_at) FILTER (
            WHERE comment.is_official = false
          ) AS latest_comment_at
        FROM matched_posts post
        LEFT JOIN record_comments comment
          ON comment.tenant_id = $1
          AND comment.record_id = post.id
        GROUP BY post.id
      ),
      post_state AS (
        SELECT post.*,
          COALESCE(latest.sampled_comment_count, state.sampled_comments, 0)
            AS current_sampled,
          COALESCE(latest.positive_comment_count, state.positive_comments, 0)
            AS current_positive,
          COALESCE(latest.neutral_comment_count, state.neutral_comments, 0)
            AS current_neutral,
          COALESCE(latest.negative_comment_count, state.negative_comments, 0)
            AS current_negative,
          COALESCE(latest.unknown_comment_count, state.unknown_comments, 0)
            AS current_unknown,
          COALESCE(state.negative_pending, 0) AS negative_pending,
          COALESCE(state.positive_pending, 0) AS positive_pending,
          state.latest_comment_at,
          latest.captured_at AS latest_snapshot_at,
          previous.captured_at AS previous_snapshot_at,
          COALESCE(previous.sampled_comment_count, 0) AS previous_sampled,
          COALESCE(previous.positive_comment_count, 0) AS previous_positive,
          COALESCE(previous.neutral_comment_count, 0) AS previous_neutral,
          COALESCE(previous.negative_comment_count, 0) AS previous_negative,
          COALESCE(previous.unknown_comment_count, 0) AS previous_unknown,
          previous_engagement.captured_at AS previous_engagement_at,
          previous_engagement.likes AS previous_likes,
          previous_engagement.comments_count AS previous_platform_comments,
          previous_engagement.shares AS previous_shares
        FROM matched_posts post
        LEFT JOIN comment_state state ON state.id = post.id
        LEFT JOIN LATERAL (
          SELECT snapshot.*
          FROM official_comment_patrol_snapshots snapshot
          WHERE snapshot.tenant_id = $1
            AND snapshot.record_id = post.id
          ORDER BY snapshot.captured_at DESC, snapshot.id DESC
          LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT snapshot.*
          FROM official_comment_patrol_snapshots snapshot
          WHERE snapshot.tenant_id = $1
            AND snapshot.record_id = post.id
            AND latest.id IS NOT NULL
            AND snapshot.id <> latest.id
          ORDER BY snapshot.captured_at DESC, snapshot.id DESC
          LIMIT 1
        ) previous ON true
        LEFT JOIN LATERAL (
          SELECT observation.likes, observation.comments_count,
            observation.shares, observation.captured_at
          FROM record_observations observation
          WHERE observation.tenant_id = $1
            AND observation.record_id = post.id
            AND post.latest_observation_id IS NOT NULL
            AND observation.id <> post.latest_observation_id
          ORDER BY observation.captured_at DESC, observation.id DESC
          LIMIT 1
        ) previous_engagement ON true
      ),
      filtered_posts AS (
        SELECT *
        FROM post_state
      )
    `,
  };
}

async function loadOfficialWorkbenchPost(tenantId, recordId) {
  if (!normalizedUuid(recordId)) return null;
  return queryOne(`
    SELECT record.id, record.platform, record.external_id, record.note_type,
      record.title, record.content, record.url, record.canonical_url,
      record.publish_time, record.published_ts,
      account.id AS official_account_id,
      account.account_name AS official_account_name
    FROM records record
    JOIN LATERAL (
      SELECT candidate.id, candidate.account_name
      FROM official_accounts candidate
      WHERE candidate.tenant_id = record.tenant_id
        AND candidate.status = 'active'
        AND candidate.platform = record.platform
        AND (
          (
            NULLIF(BTRIM(candidate.platform_user_id), '') IS NOT NULL
            AND record.author_id = candidate.platform_user_id
          )
          OR (
            NULLIF(BTRIM(candidate.account_no), '') IS NOT NULL
            AND record.author_account_no = candidate.account_no
          )
          OR (
            NULLIF(BTRIM(candidate.account_id), '') IS NOT NULL
            AND (
              record.author_id = candidate.account_id
              OR record.author_account_no = candidate.account_id
            )
          )
        )
      ORDER BY candidate.updated_at DESC, candidate.id
      LIMIT 1
    ) account ON true
    WHERE record.id = $1::uuid
      AND record.tenant_id = $2
    LIMIT 1
  `, [recordId, tenantId]);
}

/**
 * Official-account patrol is count based. Profile list publication dates are
 * not reliable enough to be used as a dispatch filter, so the caller chooses
 * how many of the account's latest posts to inspect.
 */
export function normalizeOfficialCommentPatrolFilter(body = {}) {
  const source = safeJson(body);
  const officialAccountId = normalizedUuid(source.officialAccountId);
  if (!officialAccountId) {
    return {failure: requestError(
      'official_account_required',
      '请选择一个有效的官方账号',
    )};
  }
  const hasPostsLimit =
    Object.prototype.hasOwnProperty.call(source, 'postsLimit') ||
    Object.prototype.hasOwnProperty.call(source, 'limit');
  const rawPostsLimit = source.postsLimit ?? source.limit;
  if (!hasPostsLimit || rawPostsLimit === '') {
    return {failure: requestError(
      'posts_limit_required',
      '请填写本次要巡查的最近作品数量',
    )};
  }
  const postsLimit = boundedInteger(
    rawPostsLimit,
    null,
    1,
    MAX_POSTS,
  );
  if (postsLimit == null) {
    return {failure: requestError(
      'invalid_posts_limit',
      `postsLimit 必须是 1-${MAX_POSTS} 的整数`,
    )};
  }
  const hasCommentsLimit =
    Object.prototype.hasOwnProperty.call(source, 'commentsLimit') ||
    Object.prototype.hasOwnProperty.call(source, 'commentsMaxDetectedItems');
  const rawCommentsLimit =
    source.commentsLimit ?? source.commentsMaxDetectedItems;
  if (!hasCommentsLimit || rawCommentsLimit === '') {
    return {failure: requestError(
      'comments_limit_required',
      '请填写每篇作品的评论加载上限',
    )};
  }
  const commentsLimit = boundedInteger(
    rawCommentsLimit,
    null,
    1,
    MAX_COMMENTS_PER_POST,
  );
  if (commentsLimit == null) {
    return {failure: requestError(
      'invalid_comments_limit',
      `commentsLimit 必须是 1-${MAX_COMMENTS_PER_POST} 的整数`,
    )};
  }
  const requestedPlatform = text(source.platform, 40).toLowerCase();
  if (requestedPlatform && !SUPPORTED_PLATFORMS.has(requestedPlatform)) {
    return {failure: requestError(
      'unsupported_platform',
      '官方账号评论巡查当前只支持小红书和抖音',
    )};
  }
  return {
    filter: {
      officialAccountId,
      postsLimit,
      commentsLimit,
      requestedPlatform,
      timezone: 'Asia/Shanghai',
    },
  };
}

async function loadOfficialAccount(executor, tenantId, accountId) {
  return executor.queryOne(`
    SELECT id, tenant_id, platform, account_name, platform_user_id, account_no,
      account_id, profile_url, aliases, status
    FROM official_accounts
    WHERE id = $1::uuid AND tenant_id = $2
    LIMIT 1
  `, [accountId, tenantId]);
}

function hasStrongOfficialIdentity(account) {
  return Boolean(
    text(account?.platform_user_id, 500) ||
    text(account?.account_no, 500) ||
    text(account?.account_id, 500)
  );
}

function officialAccountWhere(filter, recordIds = []) {
  const params = [filter.officialAccountId];
  let where = `
    WHERE oa.id = $1::uuid
      AND oa.status = 'active'
      AND oa.platform IN ('xiaohongshu', 'douyin')
      AND r.platform = oa.platform
      AND r.external_id ~ '^[[:alnum:]_-]{5,200}$'
      AND (
        (
          NULLIF(BTRIM(oa.platform_user_id), '') IS NOT NULL
          AND r.author_id = oa.platform_user_id
        )
        OR (
          NULLIF(BTRIM(oa.account_no), '') IS NOT NULL
          AND r.author_account_no = oa.account_no
        )
        OR (
          NULLIF(BTRIM(oa.account_id), '') IS NOT NULL
          AND (
            r.author_id = oa.account_id
            OR r.author_account_no = oa.account_id
          )
        )
      )
  `;
  if (filter.publishDateFrom && filter.publishDateTo) {
    params.push(filter.publishDateFrom, filter.publishDateTo);
    const fromIndex = params.length - 1;
    const toIndex = params.length;
    where += `
      AND r.published_ts IS NOT NULL
      AND r.published_ts >= ($${fromIndex}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND r.published_ts < (($${toIndex}::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
    `;
  }
  if (recordIds.length > 0) {
    params.push(recordIds);
    where += ` AND r.id = ANY($${params.length}::uuid[])`;
  }
  return {where, params};
}

function publicCandidate(row) {
  const url = negativePatrolTargetUrl(row);
  if (!url) return null;
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.external_id,
    title: row.title,
    url,
    publishedAt: row.published_ts,
    publishTime: row.publish_time,
    authorName: row.author_name,
    commentsCount: Number(row.comments_count || 0),
    commentsSampled: Number(row.comments_sampled || 0),
    negativeComments: Number(row.negative_comments || 0),
    lastPatrolledAt: row.last_patrolled_at || null,
    patrolStatus: row.patrol_status || 'not_patrolled',
    commentNote: '评论数据为可访问样本与本次入库结果，不代表平台全部评论。',
  };
}

async function loadCandidates(executor, tenantId, filter, {recordIds = [], lock = false} = {}) {
  const account = await loadOfficialAccount(executor, tenantId, filter.officialAccountId);
  if (!account || account.status !== 'active') {
    return {failure: requestError('official_account_not_found', '官方账号不存在或已停用', 404)};
  }
  if (!SUPPORTED_PLATFORMS.has(account.platform)) {
    return {failure: requestError(
      'unsupported_account_platform',
      '该官方账号的平台暂不支持评论巡查',
      409,
    )};
  }
  if (filter.requestedPlatform && filter.requestedPlatform !== account.platform) {
    return {failure: requestError(
      'official_account_platform_mismatch',
      '所选平台与官方账号的平台不一致',
    )};
  }
  if (!hasStrongOfficialIdentity(account)) {
    return {failure: requestError(
      'official_account_identity_required',
      '请先补全官方账号ID或账号号后再巡查',
      409,
    )};
  }
  const {where, params} = officialAccountWhere(filter, recordIds);
  const totalRow = await executor.queryOne(`
    SELECT COUNT(*) AS total
    FROM records r
    JOIN official_accounts oa ON oa.id = $1::uuid AND oa.tenant_id = r.tenant_id
    ${where}
  `, params);
  // Preview only needs a bounded number of valid direct links. Fetch a surplus
  // because historic rows may contain an expired/share URL that is not safe to
  // dispatch to an extension.
  const queryLimit = recordIds.length > 0
    ? recordIds.length
    : Math.min(MAX_POSTS * 10, Math.max(50, filter.postsLimit * 10));
  const rows = await executor.queryAll(`
    SELECT r.id, r.platform, r.external_id, r.title, r.url, r.canonical_url,
      r.note_type, r.publish_time, r.published_ts, r.author_name,
      r.comments_count,
      COALESCE(comment_summary.comments_sampled, 0) AS comments_sampled,
      COALESCE(comment_summary.negative_comments, 0) AS negative_comments,
      patrol_summary.last_patrolled_at,
      COALESCE(patrol_summary.patrol_status, 'not_patrolled') AS patrol_status
    FROM records r
    JOIN official_accounts oa ON oa.id = $1::uuid AND oa.tenant_id = r.tenant_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS comments_sampled,
        COUNT(*) FILTER (WHERE c.is_negative OR c.risk_level IN ('high', 'critical'))::int
          AS negative_comments,
        MAX(c.last_seen_at) AS last_patrolled_at,
        CASE WHEN COUNT(*) > 0 THEN 'sampled' ELSE 'not_patrolled' END AS patrol_status
      FROM record_comments c
      WHERE c.tenant_id = r.tenant_id AND c.record_id = r.id
    ) comment_summary ON true
    LEFT JOIN LATERAL (
      SELECT item.status AS patrol_status,
        COALESCE(item.finished_at, item.updated_at) AS last_patrolled_at
      FROM capture_task_items item
      JOIN capture_tasks task
        ON task.id = item.task_id
        AND task.tenant_id = item.tenant_id
        AND task.task_type = '${WORKFLOW}'
      WHERE item.tenant_id = r.tenant_id
        AND item.record_id = r.id
      ORDER BY item.updated_at DESC, item.id DESC
      LIMIT 1
    ) patrol_summary ON true
    ${where}
    ORDER BY r.published_ts DESC, r.id
    LIMIT $${params.length + 1}
    ${lock ? 'FOR SHARE OF r' : ''}
  `, [...params, queryLimit]);
  const validCandidates = rows.map(publicCandidate).filter(Boolean);
  const candidates = recordIds.length > 0
    ? validCandidates
    : validCandidates.slice(0, filter.postsLimit);
  return {
    account,
    candidates,
    total: Number(totalRow?.total || 0),
    limited: Number(totalRow?.total || 0) > candidates.length,
  };
}

router.get(
  '/official-comment-patrol/workbench',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const page = Math.max(1, safeCount(req.query.page) || 1);
      const pageSize = Math.min(
        MAX_WORKBENCH_PAGE_SIZE,
        Math.max(1, safeCount(req.query.pageSize) || 20),
      );
      const query = {
        platform: req.query.platform,
        officialAccountId: req.query.officialAccountId,
        sort: req.query.sort,
        search: req.query.search,
      };
      const workbench = buildWorkbenchCte(req.tenantId, query);
      const orderBy = workbench.sort === 'collected_desc'
        ? `COALESCE(latest_snapshot_at, latest_comment_at) DESC NULLS LAST,
          published_ts DESC NULLS LAST, id`
        : 'published_ts DESC NULLS LAST, id';
      const summary = await queryOne(`
        ${workbench.sql}
        SELECT
          COUNT(*)::integer AS total_posts,
          COUNT(DISTINCT official_account_id)::integer AS account_count,
          COUNT(*) FILTER (
            WHERE previous_snapshot_at IS NOT NULL
          )::integer AS compared_posts,
          COALESCE(SUM(
            CASE
              WHEN previous_snapshot_at IS NOT NULL
              THEN GREATEST(current_sampled - previous_sampled, 0)
              ELSE 0
            END
          ), 0)::integer AS new_comments,
          COALESCE(SUM(
            CASE
              WHEN previous_snapshot_at IS NOT NULL
              THEN GREATEST(current_negative - previous_negative, 0)
              ELSE 0
            END
          ), 0)::integer AS new_negative,
          COALESCE(SUM(current_negative), 0)::integer AS negative_comments,
          COALESCE(SUM(current_positive), 0)::integer AS positive_comments,
          COALESCE(SUM(negative_pending), 0)::integer AS negative_pending,
          COALESCE(SUM(positive_pending), 0)::integer AS positive_pending,
          COUNT(*) FILTER (
            WHERE previous_snapshot_at IS NOT NULL
              AND (
                current_negative > previous_negative
                OR (
                  CASE
                    WHEN current_sampled > 0
                    THEN current_negative::numeric / current_sampled
                    ELSE 0
                  END
                  -
                  CASE
                    WHEN previous_sampled > 0
                    THEN previous_negative::numeric / previous_sampled
                    ELSE 0
                  END
                ) >= 0.005
              )
          )::integer AS risk_rising_posts,
          MAX(latest_snapshot_at) AS latest_snapshot_at,
          MAX(previous_snapshot_at) AS previous_snapshot_at
        FROM filtered_posts
      `, workbench.params);
      const rowParams = [
        ...workbench.params,
        pageSize,
        (page - 1) * pageSize,
      ];
      const posts = await queryAll(`
        ${workbench.sql}
        SELECT *
        FROM filtered_posts
        ORDER BY ${orderBy}
        LIMIT $${rowParams.length - 1}
        OFFSET $${rowParams.length}
      `, rowParams);
      const accounts = await queryAll(`
        SELECT id, account_name, platform
        FROM official_accounts
        WHERE tenant_id = $1
          AND status = 'active'
          AND platform IN ('xiaohongshu', 'douyin')
        ORDER BY platform, account_name, id
      `, [req.tenantId]);
      const total = safeCount(summary?.total_posts);
      return res.json({
        ok: true,
        sort: workbench.sort,
        accounts: accounts.map(account => ({
          id: account.id,
          name: account.account_name,
          platform: account.platform,
        })),
        comparison: {
          scope: 'per_post_latest_two_valid_patrols',
          baselineOnly: safeCount(summary?.compared_posts) === 0,
          comparedPosts: safeCount(summary?.compared_posts),
          latestPatrolledAt: isoOrNull(summary?.latest_snapshot_at),
          previousPatrolledAt: isoOrNull(summary?.previous_snapshot_at),
          newComments: safeCount(summary?.new_comments),
          newNegative: safeCount(summary?.new_negative),
          negativeComments: safeCount(summary?.negative_comments),
          positiveComments: safeCount(summary?.positive_comments),
          negativePending: safeCount(summary?.negative_pending),
          positivePending: safeCount(summary?.positive_pending),
          riskRisingPosts: safeCount(summary?.risk_rising_posts),
        },
        posts: posts.map(publicWorkbenchPost),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
        message: '趋势按每篇帖子最近两次有效巡查快照计算；首次巡查只建立基线。',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/official-comment-patrol/posts/:id/comments',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const post = await loadOfficialWorkbenchPost(
        req.tenantId,
        req.params.id,
      );
      if (!post) {
        return res.status(404).json({
          ok: false,
          error: 'official_post_not_found',
          message: '未找到当前租户的官方账号帖子',
        });
      }
      const bucket = ['negative', 'positive', 'all'].includes(
        String(req.query.bucket || ''),
      )
        ? String(req.query.bucket)
        : 'negative';
      const page = Math.max(1, safeCount(req.query.page) || 1);
      const pageSize = Math.min(
        MAX_WORKBENCH_PAGE_SIZE,
        Math.max(1, safeCount(req.query.pageSize) || 20),
      );
      const snapshots = await queryAll(`
        SELECT *
        FROM official_comment_patrol_snapshots
        WHERE tenant_id = $1
          AND record_id = $2::uuid
        ORDER BY captured_at DESC, id DESC
        LIMIT 2
      `, [req.tenantId, post.id]);
      const previousPatrolledAt = snapshots[1]?.captured_at || null;
      const counts = await queryOne(`
        SELECT
          COUNT(*) FILTER (WHERE comment.is_official = false)::integer
            AS total,
          COUNT(*) FILTER (
            WHERE comment.is_official = false
              AND (
                comment.sentiment = 'negative'
                OR comment.is_negative = true
                OR comment.risk_level IN ('high', 'critical')
              )
          )::integer AS negative,
          COUNT(*) FILTER (
            WHERE comment.is_official = false
              AND comment.sentiment = 'positive'
          )::integer AS positive,
          COUNT(*) FILTER (
            WHERE comment.is_official = false
              AND (
                comment.sentiment = 'negative'
                OR comment.is_negative = true
                OR comment.risk_level IN ('high', 'critical')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM official_comment_actions action
                WHERE action.tenant_id = comment.tenant_id
                  AND action.comment_id = comment.id
                  AND action.status = 'completed'
                  AND action.action_type IN (
                    'reply', 'ignore', 'ticket', 'manual_complete'
                  )
              )
          )::integer AS negative_pending,
          COUNT(*) FILTER (
            WHERE comment.is_official = false
              AND comment.sentiment = 'positive'
              AND NOT EXISTS (
                SELECT 1
                FROM official_comment_actions action
                WHERE action.tenant_id = comment.tenant_id
                  AND action.comment_id = comment.id
                  AND action.status = 'completed'
                  AND action.action_type IN (
                    'like', 'encourage_reply', 'ignore', 'manual_complete'
                  )
              )
          )::integer AS positive_pending
        FROM record_comments comment
        WHERE comment.tenant_id = $1
          AND comment.record_id = $2::uuid
      `, [req.tenantId, post.id]);
      const bucketCondition = bucket === 'negative'
        ? `AND (
            comment.sentiment = 'negative'
            OR comment.is_negative = true
            OR comment.risk_level IN ('high', 'critical')
          )`
        : bucket === 'positive'
          ? `AND comment.sentiment = 'positive'`
          : '';
      const total = await queryOne(`
        SELECT COUNT(*)::integer AS total
        FROM record_comments comment
        WHERE comment.tenant_id = $1
          AND comment.record_id = $2::uuid
          AND comment.is_official = false
          ${bucketCondition}
      `, [req.tenantId, post.id]);
      const comments = await queryAll(`
        SELECT comment.*,
          lead.id AS lead_id,
          COALESCE((
            SELECT jsonb_agg(action_row ORDER BY action_row.updated_at DESC)
            FROM (
              SELECT action.id, action.action_type, action.status,
                action.note, action.actor_name, action.completed_at,
                action.created_at, action.updated_at
              FROM official_comment_actions action
              WHERE action.tenant_id = comment.tenant_id
                AND action.comment_id = comment.id
              ORDER BY action.updated_at DESC
              LIMIT 8
            ) action_row
          ), '[]'::jsonb) AS actions
        FROM record_comments comment
        LEFT JOIN comment_leads lead
          ON lead.tenant_id = comment.tenant_id
          AND lead.comment_id = comment.id
        WHERE comment.tenant_id = $1
          AND comment.record_id = $2::uuid
          AND comment.is_official = false
          ${bucketCondition}
        ORDER BY
          CASE comment.risk_level
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END,
          comment.like_count DESC,
          comment.last_seen_at DESC,
          comment.id
        LIMIT $3 OFFSET $4
      `, [
        req.tenantId,
        post.id,
        pageSize,
        (page - 1) * pageSize,
      ]);
      return res.json({
        ok: true,
        post: {
          id: post.id,
          title: post.title || post.content || '未命名作品',
          url: negativePatrolTargetUrl(post) || '',
          platform: post.platform,
          publishedAt: post.published_ts || null,
          officialAccount: {
            id: post.official_account_id,
            name: post.official_account_name,
          },
        },
        bucket,
        counts: {
          all: safeCount(counts?.total),
          negative: safeCount(counts?.negative),
          positive: safeCount(counts?.positive),
          negativePending: safeCount(counts?.negative_pending),
          positivePending: safeCount(counts?.positive_pending),
        },
        comparison: {
          latestPatrolledAt: isoOrNull(snapshots[0]?.captured_at),
          previousPatrolledAt: isoOrNull(previousPatrolledAt),
          baselineOnly: snapshots.length < 2,
        },
        comments: comments.map(comment => ({
          id: comment.id,
          authorName: comment.author_name || '未知用户',
          authorAvatar: comment.author_avatar || '',
          content: comment.content || '',
          likeCount: safeCount(comment.like_count),
          publishedAt: comment.published_at || null,
          ipLocation: comment.ip_location || '',
          sentiment: comment.sentiment || 'unknown',
          isNegative: Boolean(comment.is_negative),
          riskLevel: comment.risk_level || 'none',
          category: comment.category || '',
          summary: comment.ai_summary || '',
          firstSeenAt: isoOrNull(comment.first_seen_at),
          lastSeenAt: isoOrNull(comment.last_seen_at),
          isNewSincePrevious: previousPatrolledAt
            ? new Date(comment.first_seen_at) > new Date(previousPatrolledAt)
            : false,
          leadId: comment.lead_id || null,
          actions: Array.isArray(comment.actions) ? comment.actions : [],
        })),
        pagination: {
          page,
          pageSize,
          total: safeCount(total?.total),
          totalPages: Math.max(
            1,
            Math.ceil(safeCount(total?.total) / pageSize),
          ),
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/official-comment-patrol/comments/:id/actions',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const commentId = normalizedUuid(req.params.id);
      const actionType = text(req.body?.actionType, 40);
      if (!commentId || !COMMENT_ACTION_TYPES.has(actionType)) {
        return sendRequestError(res, requestError(
          'invalid_comment_action',
          '评论操作类型无效',
        ));
      }
      const requestedStatus = text(req.body?.status, 40);
      const status = COMMENT_ACTION_STATUSES.has(requestedStatus)
        ? requestedStatus
        : ['ignore', 'manual_complete'].includes(actionType)
          ? 'completed'
          : 'pending';
      const result = await withTransaction(async tx => {
        const comment = await tx.queryOne(`
          SELECT comment.id, comment.record_id, record.platform,
            record.external_id, record.note_type, record.url,
            record.canonical_url
          FROM record_comments comment
          JOIN records record
            ON record.id = comment.record_id
            AND record.tenant_id = comment.tenant_id
          WHERE comment.id = $1::uuid
            AND comment.tenant_id = $2
            AND comment.is_official = false
            AND EXISTS (
              SELECT 1
              FROM official_accounts account
              WHERE account.tenant_id = record.tenant_id
                AND account.status = 'active'
                AND account.platform = record.platform
                AND (
                  (
                    NULLIF(BTRIM(account.platform_user_id), '') IS NOT NULL
                    AND record.author_id = account.platform_user_id
                  )
                  OR (
                    NULLIF(BTRIM(account.account_no), '') IS NOT NULL
                    AND record.author_account_no = account.account_no
                  )
                  OR (
                    NULLIF(BTRIM(account.account_id), '') IS NOT NULL
                    AND (
                      record.author_id = account.account_id
                      OR record.author_account_no = account.account_id
                    )
                  )
                )
            )
          LIMIT 1
          FOR UPDATE OF comment
        `, [commentId, req.tenantId]);
        if (!comment) return null;
        const action = status === 'pending'
          ? await tx.queryOne(`
              INSERT INTO official_comment_actions (
                tenant_id, record_id, comment_id, action_type, status,
                note, actor_user_id, actor_name, metadata
              ) VALUES (
                $1, $2, $3, $4, 'pending',
                $5, $6, $7, $8::jsonb
              )
              ON CONFLICT (tenant_id, comment_id, action_type)
                WHERE status = 'pending'
              DO UPDATE SET
                note = excluded.note,
                actor_user_id = excluded.actor_user_id,
                actor_name = excluded.actor_name,
                metadata = official_comment_actions.metadata ||
                  excluded.metadata,
                updated_at = now()
              RETURNING *
            `, [
              req.tenantId,
              comment.record_id,
              comment.id,
              actionType,
              text(req.body?.note, 2000),
              req.user?.id || null,
              text(req.actorName || req.user?.name || req.user?.email, 240),
              JSON.stringify(
                sanitizeCloudStructuredObject(req.body?.metadata),
              ),
            ])
          : await tx.queryOne(`
              INSERT INTO official_comment_actions (
                tenant_id, record_id, comment_id, action_type, status,
                note, actor_user_id, actor_name, metadata, completed_at
              ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9::jsonb,
                CASE WHEN $5 = 'completed' THEN now() ELSE NULL END
              )
              RETURNING *
            `, [
              req.tenantId,
              comment.record_id,
              comment.id,
              actionType,
              status,
              text(req.body?.note, 2000),
              req.user?.id || null,
              text(req.actorName || req.user?.name || req.user?.email, 240),
              JSON.stringify(
                sanitizeCloudStructuredObject(req.body?.metadata),
              ),
            ]);
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id, action,
            target_type, target_id, metadata
          ) VALUES (
            $1, 'user', $2, $3, 'official_comment_action.create',
            'record_comment', $4, $5::jsonb
          )
        `, [
          req.tenantId,
          text(req.user?.id || '', 240),
          req.user?.id || null,
          comment.id,
          JSON.stringify({
            actionId: action.id,
            actionType,
            status,
            recordId: comment.record_id,
          }),
        ]);
        return {
          action,
          postUrl: negativePatrolTargetUrl(comment) || '',
        };
      });
      if (!result) {
        return res.status(404).json({
          ok: false,
          error: 'official_comment_not_found',
          message: '未找到当前官方帖子下的评论',
        });
      }
      return res.status(201).json({ok: true, ...result});
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  '/official-comment-patrol/actions/:id',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const actionId = normalizedUuid(req.params.id);
      const status = text(req.body?.status, 40);
      if (!actionId || !COMMENT_ACTION_STATUSES.has(status)) {
        return sendRequestError(res, requestError(
          'invalid_comment_action_status',
          '评论操作状态无效',
        ));
      }
      const action = await withTransaction(async tx => {
        const updated = await tx.queryOne(`
          UPDATE official_comment_actions
          SET status = $1,
            note = CASE
              WHEN $2::boolean THEN $3
              ELSE note
            END,
            completed_at = CASE
              WHEN $1 = 'completed' THEN COALESCE(completed_at, now())
              ELSE NULL
            END,
            updated_at = now()
          WHERE id = $4::uuid
            AND tenant_id = $5
          RETURNING *
        `, [
          status,
          Object.prototype.hasOwnProperty.call(req.body || {}, 'note'),
          text(req.body?.note, 2000),
          actionId,
          req.tenantId,
        ]);
        if (!updated) return null;
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id, action,
            target_type, target_id, metadata
          ) VALUES (
            $1, 'user', $2, $3, 'official_comment_action.update',
            'official_comment_action', $4, $5::jsonb
          )
        `, [
          req.tenantId,
          text(req.user?.id || '', 240),
          req.user?.id || null,
          updated.id,
          JSON.stringify({status, commentId: updated.comment_id}),
        ]);
        return updated;
      });
      if (!action) {
        return res.status(404).json({
          ok: false,
          error: 'comment_action_not_found',
          message: '评论操作记录不存在',
        });
      }
      return res.json({ok: true, action});
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/official-comment-patrol/accounts',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const accounts = await queryAll(`
        SELECT account.id, account.platform, account.account_name,
          account.platform_user_id, account.account_no, account.account_id,
          account.profile_url, account.aliases, account.status,
          subscription.id AS monitor_subscription_id
        FROM official_accounts account
        LEFT JOIN LATERAL (
          SELECT id
          FROM monitor_subscriptions
          WHERE tenant_id = account.tenant_id
            AND official_account_id = account.id
            AND subject_type = 'official'
            AND status <> 'deleted'
          ORDER BY
            CASE WHEN status = 'active' THEN 0 ELSE 1 END,
            updated_at DESC,
            id
          LIMIT 1
        ) subscription ON TRUE
        WHERE account.tenant_id = $1 AND account.status = 'active'
          AND account.platform IN ('xiaohongshu', 'douyin')
        ORDER BY account.platform, account.account_name, account.id
      `, [req.tenantId]);
      const today = shanghaiCalendarDate();
      const filterBase = {publishDateFrom: addDays(today, -6), publishDateTo: today, postsLimit: 5, commentsLimit: DEFAULT_COMMENTS_LIMIT, timezone: 'Asia/Shanghai'};
      const result = [];
      for (const account of accounts) {
        const loaded = await loadCandidates(
          {queryAll, queryOne},
          req.tenantId,
          {...filterBase, officialAccountId: account.id, requestedPlatform: account.platform},
        );
        if (loaded.failure) continue;
        const recentPosts = loaded.candidates.map(candidate => ({
          id: candidate.id,
          title: candidate.title,
          url: candidate.url,
          publishedAt: candidate.publishedAt,
          commentsCount: candidate.commentsCount,
          commentsSampled: candidate.commentsSampled,
          negativeComments: candidate.negativeComments,
          lastPatrolledAt: candidate.lastPatrolledAt,
          patrolStatus: candidate.patrolStatus,
        }));
        const latestPatrolPost = recentPosts.reduce((latest, post) => {
          if (!post.lastPatrolledAt) return latest;
          if (!latest?.lastPatrolledAt) return post;
          return post.lastPatrolledAt > latest.lastPatrolledAt ? post : latest;
        }, null);
        result.push({
          id: account.id,
          monitorSubscriptionId: account.monitor_subscription_id || null,
          accountName: account.account_name,
          platform: account.platform,
          platformUserId: account.platform_user_id,
          accountNo: account.account_no,
          profileUrl: account.profile_url,
          recentPosts,
          recentPostCount: loaded.total,
          lastPatrolledAt: latestPatrolPost?.lastPatrolledAt || null,
          lastPatrolStatus: latestPatrolPost?.patrolStatus || 'not_patrolled',
          riskCommentCount: recentPosts.reduce((sum, post) => sum + post.negativeComments, 0),
        });
      }
      return res.json({
        ok: true,
        accounts: result,
        range: {publishDateFrom: filterBase.publishDateFrom, publishDateTo: filterBase.publishDateTo, timezone: 'Asia/Shanghai'},
        message: '评论统计为已采集到的可访问样本，不代表平台全部评论。',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/official-comment-patrol/candidates/preview',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeOfficialCommentPatrolFilter(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const result = await loadCandidates({queryAll, queryOne}, req.tenantId, normalized.filter);
      if (result.failure) return sendRequestError(res, result.failure);
      return res.json({
        ok: true,
        account: {id: result.account.id, accountName: result.account.account_name, platform: result.account.platform},
        candidates: result.candidates,
        total: result.total,
        limited: result.limited,
        filter: {...normalized.filter, platform: result.account.platform},
        message: '候选作品按账号最近内容排序；评论为可访问样本。',
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/official-comment-patrol/tasks',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const normalized = normalizeOfficialCommentPatrolFilter(req.body);
      if (normalized.failure) return sendRequestError(res, normalized.failure);
      const agentId = normalizedUuid(req.body?.agentId);
      if (!agentId) return sendRequestError(res, requestError('agent_required', '请选择一个有效的执行节点'));
      const rawRequestKey = text(req.body?.requestKey, 100);
      const requestKey = rawRequestKey ? normalizedUuid(rawRequestKey) : crypto.randomUUID();
      if (!requestKey) return sendRequestError(res, requestError('invalid_request_key', 'requestKey 必须是有效 UUID'));
      const title = text(
        req.body?.title || `官方账号评论巡查 · 最近 ${normalized.filter.postsLimit} 篇`,
        240,
      );
      const requestedSettings = sanitizeCloudStructuredObject(req.body?.captureSettings);
      const captureSettings = {
        ...requestedSettings,
        includeComments: true,
        includeCommentsOnDetailCapture: true,
        autoSyncAfterDetailCapture: true,
        commentsMaxDetectedItems: normalized.filter.commentsLimit,
        skipAlreadyCapturedOnDetailCapture: false,
        // 官方账号巡查按主页最新顺序取 N 篇，不依赖列表中的发布日期。
        scanLatestPostsByCount: true,
      };
      const monitorSettings = sanitizeCloudStructuredObject({
        postsLimit: normalized.filter.postsLimit,
        timezone: normalized.filter.timezone,
      });

      const result = await withTransaction(async tx => {
        await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [WORKFLOW, requestKey]);
        const subscription = await tx.queryOne(`
          SELECT subscription.*, account.account_name,
            account.platform AS account_platform,
            account.profile_url AS official_profile_url,
            account.status AS official_account_status
          FROM official_accounts account
          JOIN monitor_subscriptions subscription
            ON subscription.tenant_id = account.tenant_id
            AND subscription.official_account_id = account.id
            AND subscription.subject_type = 'official'
            AND subscription.status = 'active'
          WHERE account.id = $1::uuid
            AND account.tenant_id = $2
            AND account.status = 'active'
            AND account.platform IN ('xiaohongshu', 'douyin')
            AND COALESCE(subscription.account_url, account.profile_url, '') <> ''
          ORDER BY subscription.updated_at DESC, subscription.id
          LIMIT 1
          FOR UPDATE OF subscription, account
        `, [normalized.filter.officialAccountId, req.tenantId]);
        if (!subscription) {
          return {failure: requestError(
            'official_account_profile_subscription_missing',
            '该官方账号尚未配置可执行的账号主页巡查计划，请先补充主页链接并启用账号',
            409,
          )};
        }
        const platform = text(
          subscription.account_platform || subscription.platform,
          40,
        ).toLowerCase();
        if (
          normalized.filter.requestedPlatform &&
          normalized.filter.requestedPlatform !== platform
        ) {
          return {failure: requestError(
            'official_account_platform_mismatch',
            '所选平台与官方账号的平台不一致',
          )};
        }
        subscription.name = text(
          subscription.account_name || subscription.name,
          240,
        );
        subscription.platform = platform;
        subscription.account_url = text(
          subscription.account_url || subscription.official_profile_url,
          3000,
        );
        const compatible = await loadCompatibleProfilePatrolAgent(
          tx,
          req.tenantId,
          agentId,
          [platform],
          'official',
        );
        if (compatible.failure) return {failure: compatible.failure};
        const requestHash = profilePatrolRequestHash({
          workflow: WORKFLOW,
          agentId,
          subscriptionIds: [subscription.id],
          title,
          monitorSettings,
          captureSettings,
        });
        const existing = await tx.queryOne(`
          SELECT task.*, command.id AS create_command_id,
            command.expires_at AS create_command_expires_at,
            agent.last_heartbeat_at AS agent_last_heartbeat_at
          FROM capture_tasks task
          LEFT JOIN capture_agent_commands command
            ON command.id::text = task.metadata->>'createCommandId'
            AND command.task_id = task.id AND command.tenant_id = task.tenant_id
          LEFT JOIN capture_agents agent ON agent.id = task.assigned_agent_id AND agent.tenant_id = task.tenant_id
          WHERE task.id = $1::uuid AND task.tenant_id = $2
          FOR UPDATE OF task
        `, [requestKey, req.tenantId]);
        if (existing) {
          const metadata = safeJson(existing.metadata);
          if (
            existing.task_type !== WORKFLOW ||
            metadata.remoteRequestHash !== requestHash
          ) {
            return {failure: requestError('idempotency_key_conflict', '该 requestKey 已用于不同的任务请求', 409)};
          }
          return {
            task: existing,
            commandId: existing.create_command_id || null,
            commandExpiresAt: existing.create_command_expires_at || null,
            agentOnline: captureAgentOnline(existing.agent_last_heartbeat_at),
            existing: true,
          };
        }
        const collision = await tx.queryOne('SELECT id FROM capture_tasks WHERE id = $1::uuid', [requestKey]);
        if (collision) return {failure: requestError('idempotency_key_conflict', '该 requestKey 已用于其他任务', 409)};
        const dispatched = await materializeProfilePatrolTask(tx, {
          tenantId: req.tenantId,
          subjectType: 'official',
          agent: compatible.agent,
          subscriptions: [subscription],
          requestKey,
          title,
          monitorSettings,
          captureSettings,
          requestHash,
          triggerType: 'official_comment_patrol_manual',
          requestedByUserId: req.user?.id || null,
          requestedByName: req.actorName,
        });
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata
          ) VALUES ($1, 'user', $2, $3, 'official_comment_patrol.create', 'capture_task', $4, $5::jsonb)
        `, [
          req.tenantId,
          text(req.user?.id || '', 240),
          req.user?.id || null,
          dispatched.task.id,
          JSON.stringify({
            agentId: compatible.agent.id,
            officialAccountId: normalized.filter.officialAccountId,
            monitorSubscriptionId: subscription.id,
            postsLimit: normalized.filter.postsLimit,
            commentsLimit: normalized.filter.commentsLimit,
            requestHash,
          }),
        ]);
        return {...dispatched, existing: false};
      });
      if (result.failure) return sendRequestError(res, result.failure);
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        task: result.task,
        commandId: result.commandId,
        commandExpiresAt: result.commandExpiresAt,
        agentOnline: result.agentOnline,
        existing: result.existing,
        message: result.existing ? '相同请求已存在，已返回原任务状态' : result.agentOnline ? '任务已创建并下发，在线设备将领取执行' : '任务已创建并排队，设备上线后将自动领取',
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
