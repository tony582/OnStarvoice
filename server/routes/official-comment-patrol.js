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
const MAX_POSTS = 20;
const MAX_COMMENTS_PER_POST = 100;
const DEFAULT_POSTS_LIMIT = 20;
const DEFAULT_COMMENTS_LIMIT = 50;
const MAX_WINDOW_DAYS = 30;
const WORKFLOW = 'official_account_comment_patrol';

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

function normalizeCalendarDate(value) {
  const candidate = String(value ?? '').trim();
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
  ) return '';
  return candidate;
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

function inclusiveDays(from, to) {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;
}

/**
 * The date window is intentionally mandatory at task execution time. When the
 * caller does not provide one, the explicit default is the latest seven
 * calendar days in Asia/Shanghai; no all-history patrol is available in V1.
 */
export function normalizeOfficialCommentPatrolFilter(body = {}, {now} = {}) {
  const source = safeJson(body);
  const officialAccountId = normalizedUuid(source.officialAccountId);
  if (!officialAccountId) {
    return {failure: requestError(
      'official_account_required',
      '请选择一个有效的官方账号',
    )};
  }
  const today = shanghaiCalendarDate(now instanceof Date ? now : new Date());
  const hasPublishDateFrom = Object.prototype.hasOwnProperty.call(
    source,
    'publishDateFrom',
  );
  const hasPublishDateTo = Object.prototype.hasOwnProperty.call(
    source,
    'publishDateTo',
  );
  const normalizedPublishDateFrom = normalizeCalendarDate(source.publishDateFrom);
  const normalizedPublishDateTo = normalizeCalendarDate(source.publishDateTo);
  if (
    (hasPublishDateFrom && !normalizedPublishDateFrom) ||
    (hasPublishDateTo && !normalizedPublishDateTo)
  ) {
    return {failure: requestError(
      'invalid_publish_date',
      '发布时间必须是有效日期，格式为 YYYY-MM-DD',
    )};
  }
  const publishDateFrom = normalizedPublishDateFrom || addDays(today, -6);
  const publishDateTo = normalizedPublishDateTo || today;
  if (publishDateFrom > publishDateTo) {
    return {failure: requestError(
      'invalid_publish_date_range',
      '发布时间开始日期不能晚于结束日期',
    )};
  }
  if (inclusiveDays(publishDateFrom, publishDateTo) > MAX_WINDOW_DAYS) {
    return {failure: requestError(
      'publish_date_range_too_large',
      `发布时间范围最多 ${MAX_WINDOW_DAYS} 天`,
    )};
  }
  const postsLimit = boundedInteger(
    source.postsLimit ?? source.limit,
    DEFAULT_POSTS_LIMIT,
    1,
    MAX_POSTS,
  );
  if (postsLimit == null) {
    return {failure: requestError(
      'invalid_posts_limit',
      `postsLimit 必须是 1-${MAX_POSTS} 的整数`,
    )};
  }
  const commentsLimit = boundedInteger(
    source.commentsLimit ?? source.commentsMaxDetectedItems,
    DEFAULT_COMMENTS_LIMIT,
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
      publishDateFrom,
      publishDateTo,
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

function officialAccountWhere(filter, recordIds = []) {
  const params = [
    filter.officialAccountId,
    filter.publishDateFrom,
    filter.publishDateTo,
  ];
  let where = `
    WHERE oa.id = $1::uuid
      AND oa.status = 'active'
      AND oa.platform IN ('xiaohongshu', 'douyin')
      AND r.platform = oa.platform
      AND r.published_ts IS NOT NULL
      AND r.published_ts >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND r.published_ts < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
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
        OR (
          NOT (
            (
              NULLIF(BTRIM(oa.platform_user_id), '') IS NOT NULL
              OR NULLIF(BTRIM(oa.account_no), '') IS NOT NULL
              OR NULLIF(BTRIM(oa.account_id), '') IS NOT NULL
            )
            AND (
              NULLIF(BTRIM(r.author_id), '') IS NOT NULL
              OR NULLIF(BTRIM(r.author_account_no), '') IS NOT NULL
            )
          )
          AND (
            (
              NULLIF(BTRIM(oa.account_name), '') IS NOT NULL
              AND r.author_name = oa.account_name
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(oa.aliases) = 'array'
                  THEN oa.aliases ELSE '[]'::jsonb END
              ) AS alias(value)
              WHERE NULLIF(BTRIM(alias.value), '') IS NOT NULL
                AND alias.value = r.author_name
            )
          )
        )
      )
  `;
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
  const {where, params} = officialAccountWhere(filter, recordIds);
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
  const totalRow = await executor.queryOne(`
    SELECT COUNT(*) AS total
    FROM records r
    JOIN official_accounts oa ON oa.id = $1::uuid AND oa.tenant_id = r.tenant_id
    ${where}
  `, params);
  // Preview only needs at most 20 valid direct links. Fetch a bounded surplus
  // because historic rows may contain an expired/share URL that is not safe to
  // dispatch to an extension.
  const queryLimit = recordIds.length > 0 ? recordIds.length : MAX_POSTS * 10;
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
        message: '候选作品仅来自已采集、发布时间明确且可验证详情链接的官方账号内容；评论为可访问样本。',
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
        req.body?.title || `官方账号评论巡查 · ${normalized.filter.publishDateFrom} 至 ${normalized.filter.publishDateTo}`,
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
        // 账号主页列表只用于发现候选作品，发布时间必须进入作品详情后核实。
        verifyPublishDateFromDetail: true,
      };
      const monitorSettings = sanitizeCloudStructuredObject({
        publishWindow: 'custom',
        publishDateFrom: normalized.filter.publishDateFrom,
        publishDateTo: normalized.filter.publishDateTo,
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
            publishDateFrom: normalized.filter.publishDateFrom,
            publishDateTo: normalized.filter.publishDateTo,
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
