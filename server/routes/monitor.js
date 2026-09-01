import { Router } from 'express';
import { queryOne, queryAll, execute, getAllSettings, setSettings, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { applyResolvedMetrics } from '../utils/metrics.js';
import {
  captureOfficialCommentPatrolSnapshots,
} from '../services/official-comment-patrol-analytics.js';
import {
  lockProfileDiscoverySubscriptionsForExecutions,
} from '../modules/capture/infrastructure/postgres-profile-discovery-work.js';

const router = Router();
const MONITOR_SETTING_KEYS = new Set([
  'publishWindow',
  'likeThreshold',
  'runTimes',
  'observeWindowHours',
  'timezone',
]);
const MONITOR_SUBJECT_TYPES = new Set(['creator', 'official']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RESERVED_PLATFORM_ACCOUNT_IDS = new Set([
  'self',
  'me',
  'my',
  'profile',
  'home',
  'login',
  'undefined',
  'null',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSubjectType(value, fallback = 'creator') {
  const normalized = normalizeText(value || fallback).toLowerCase();
  return MONITOR_SUBJECT_TYPES.has(normalized) ? normalized : '';
}

function normalizeAliases(value) {
  const aliases = Array.isArray(value)
    ? value
    : normalizeText(value).split(',');
  return [...new Set(aliases.map(normalizeText).filter(Boolean))];
}

function isUuid(value) {
  return UUID_PATTERN.test(normalizeText(value));
}

export function extractOfficialPlatformUserId(platformValue, profileUrlValue) {
  const platform = normalizeText(platformValue).toLowerCase();
  const profileUrl = normalizeText(profileUrlValue);
  const platformContract = {
    douyin: {
      hostname: 'douyin.com',
      pathname: /\/user\/([^/?#]+)/iu,
    },
    xiaohongshu: {
      hostname: 'xiaohongshu.com',
      pathname: /\/user\/profile\/([^/?#]+)/iu,
    },
    weibo: {
      hostname: 'weibo.com',
      pathname: /\/(?:u\/)?(\d{4,})\/?$/iu,
    },
  }[platform];
  if (!profileUrl || !platformContract) return '';

  let parsed;
  try {
    parsed = new URL(profileUrl);
  } catch {
    return '';
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== platformContract.hostname &&
    !hostname.endsWith(`.${platformContract.hostname}`)
  ) {
    return '';
  }

  const match = parsed.pathname.match(platformContract.pathname);
  if (!match?.[1]) return '';
  let accountId = '';
  try {
    accountId = normalizeText(decodeURIComponent(match[1]));
  } catch {
    accountId = normalizeText(match[1]);
  }
  if (
    accountId.length < 5 ||
    accountId.length > 240 ||
    !/^[a-z0-9._-]+$/iu.test(accountId) ||
    RESERVED_PLATFORM_ACCOUNT_IDS.has(accountId.toLowerCase())
  ) {
    return '';
  }
  return accountId;
}

function resolveHitsSince(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (range === 'today') return today;
  if (range === '30d') return new Date(Date.now() - 29 * 86400000);
  if (range === 'all') return null;
  return new Date(Date.now() - 6 * 86400000);
}

function normalizeMonitorSubscriptionRow(row = {}) {
  if (!row) return row;
  return {
    ...row,
    accountUrl: row.account_url || '',
    bloggerUrl: row.account_url || '',
    bloggerNameSnapshot: row.name || '',
    bloggerName: row.name || '',
    platformBloggerId: row.keyword || '',
    subjectType: row.subject_type || 'creator',
    officialAccountId: row.official_account_id || null,
    assignedAgentId: row.assigned_agent_id || null,
    hasOfficialRole: Boolean(row.has_official_role),
    attentionRequired: Boolean(row.attention_required),
    latestExecutionStatus: row.latest_execution_status || '',
    latestExecutionError: row.latest_execution_error || '',
    latestExecutionAt: row.latest_execution_at || null,
    notifyOnNegative: Boolean(row.notify_on_negative),
    cadenceMinutes: Number(row.cadence_minutes || 0),
    lastCursor: row.last_cursor || '',
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    lastError: row.last_error || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function resolveSubscriptionInput(body = {}) {
  const platform = normalizeText(body.platform);
  const accountUrl = normalizeText(
    body.accountUrl || body.bloggerUrl || body.profileUrl || body.authorUrl
  );
  const platformBloggerId = normalizeText(
    body.profileInternalId ||
    body.profile_internal_id ||
    body.platformBloggerId ||
    body.bloggerId ||
    body.authorId
  );
  const keyword = normalizeText(
    body.keyword || platformBloggerId || body.bloggerNameSnapshot || body.name || accountUrl
  );
  const name = normalizeText(
    body.displayName ||
    body.display_name ||
    body.name ||
    body.bloggerNameSnapshot ||
    body.bloggerName ||
    keyword
  );

  return {
    name,
    keyword,
    platform,
    accountUrl,
    notifyOnNegative: body.notifyOnNegative ?? 1,
    cadenceMinutes: Number(body.cadenceMinutes) || 1440,
    subjectType: normalizeSubjectType(body.subjectType || body.subject_type),
    assignedAgentId: isUuid(
      body.assignedAgentId || body.assigned_agent_id,
    )
      ? normalizeText(body.assignedAgentId || body.assigned_agent_id)
      : '',
  };
}

async function validateSubscriptionAgentBinding(tx, {
  tenantId,
  assignedAgentId,
  actorType,
  authCodeId = '',
}) {
  if (!assignedAgentId) return {agentId: null};
  const agent = await tx.queryOne(`
    SELECT agent.id
    FROM capture_agents agent
    JOIN tenants tenant
      ON tenant.id = agent.tenant_id
      AND tenant.status = 'active'
    JOIN auth_codes code
      ON code.id = agent.auth_code_id
      AND code.tenant_id = agent.tenant_id
      AND code.status = 'active'
      AND (code.expires_at IS NULL OR code.expires_at >= now())
    JOIN auth_bindings binding
      ON binding.id = agent.auth_binding_id
      AND binding.code_id = code.id
    WHERE agent.id = $1::uuid
      AND agent.tenant_id = $2
      AND agent.status = 'active'
      AND ($3 <> 'auth_code' OR code.id = $4::uuid)
    LIMIT 1
    FOR UPDATE OF agent
  `, [
    assignedAgentId,
    tenantId,
    actorType,
    authCodeId || null,
  ]);
  if (!agent) {
    return {
      failure: {
        status: 409,
        error: 'assigned_agent_binding_invalid',
        message: '当前扩展节点与账号登记不属于同一有效授权，请重新验证扩展',
      },
    };
  }
  return {agentId: agent.id};
}

function resolveOfficialIdentity(body = {}, subscription = {}) {
  const platform = normalizeText(body.platform || subscription.platform);
  const profileUrl = normalizeText(
    body.profileUrl ||
    body.profile_url ||
    body.accountUrl ||
    body.bloggerUrl ||
    subscription.account_url
  );
  const explicitPlatformUserId = normalizeText(
    body.platformUserId ||
    body.platform_user_id ||
    body.profileInternalId ||
    body.profile_internal_id ||
    body.platformBloggerId ||
    body.bloggerId ||
    body.authorId
  );
  return {
    platform,
    accountName: normalizeText(
      body.accountName ||
      body.account_name ||
      body.displayName ||
      body.display_name ||
      body.bloggerNameSnapshot ||
      body.bloggerName ||
      body.name ||
      subscription.name
    ),
    platformUserId:
      explicitPlatformUserId ||
      extractOfficialPlatformUserId(platform, profileUrl),
    accountNo: normalizeText(
      body.accountNo ||
      body.account_no ||
      body.authorAccountNo ||
      body.author_account_no
    ),
    legacyAccountId: normalizeText(body.accountId || body.account_id),
    profileUrl,
    aliases: normalizeAliases(body.aliases),
    avatarUrl: normalizeText(body.avatarUrl || body.avatar_url),
    skipContent: body.skipContent !== false && body.skip_content !== false,
  };
}

function mergeAliases(current, incoming) {
  let existing = current;
  if (typeof existing === 'string') {
    try {
      existing = JSON.parse(existing);
    } catch {
      existing = existing.split(',');
    }
  }
  return [...new Set([
    ...normalizeAliases(existing),
    ...normalizeAliases(incoming),
  ])];
}

async function findOfficialAccountForUpdate(tx, tenantId, identity) {
  return tx.queryOne(`
    SELECT *
    FROM official_accounts
    WHERE tenant_id = $1
      AND platform = $2
      AND (
        ($3 <> '' AND platform_user_id = $3)
        OR ($4 <> '' AND account_no = $4)
        OR ($5 <> '' AND account_id = $5)
        OR ($6 <> '' AND profile_url = $6)
        OR (
          $3 = '' AND $4 = '' AND $5 = '' AND $6 = ''
          AND $7 <> '' AND account_name = $7
        )
      )
    ORDER BY
      CASE
        WHEN $3 <> '' AND platform_user_id = $3 THEN 1
        WHEN $4 <> '' AND account_no = $4 THEN 2
        WHEN $5 <> '' AND account_id = $5 THEN 3
        WHEN $6 <> '' AND profile_url = $6 THEN 4
        ELSE 5
      END,
      status = 'deleted',
      created_at
    LIMIT 1
    FOR UPDATE
  `, [
    tenantId,
    identity.platform,
    identity.platformUserId,
    identity.accountNo,
    identity.legacyAccountId,
    identity.profileUrl,
    identity.accountName,
  ]);
}

async function markSubscriptionOfficial(tx, {
  tenantId,
  subscriptionId,
  body = {},
  actorType = 'system',
  actorId = '',
}) {
  const subscription = await tx.queryOne(`
    SELECT *
    FROM monitor_subscriptions
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
    FOR UPDATE
  `, [subscriptionId, tenantId]);
  if (!subscription) {
    return {failure: {status: 404, error: 'subscription_not_found', message: '关注账号不存在'}};
  }
  let sourceSubscription = subscription;

  const identity = resolveOfficialIdentity(body, subscription);
  if (!identity.platform || !identity.accountName) {
    return {
      failure: {
        status: 400,
        error: 'official_account_identity_required',
        message: '标记官方账号需要平台和账号名称',
      },
    };
  }
  let officialAccount = await findOfficialAccountForUpdate(tx, tenantId, identity);
  if (!officialAccount && subscription.official_account_id) {
    officialAccount = await tx.queryOne(`
      SELECT *
      FROM official_accounts
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
      FOR UPDATE
    `, [subscription.official_account_id, tenantId]);
  }
  if (
    !identity.platformUserId &&
    !identity.accountNo &&
    !identity.legacyAccountId &&
    !officialAccount?.platform_user_id &&
    !officialAccount?.account_no &&
    !officialAccount?.account_id
  ) {
    return {
      failure: {
        status: 400,
        error: 'official_account_strong_identity_required',
        message: '未从账号主页识别到稳定账号 ID，请重新打开账号主页后登记',
      },
    };
  }

  const aliases = mergeAliases(officialAccount?.aliases, identity.aliases);
  if (officialAccount) {
    officialAccount = await tx.queryOne(`
      UPDATE official_accounts
      SET platform = $1,
        account_name = $2,
        platform_user_id = CASE WHEN $3 <> '' THEN $3 ELSE platform_user_id END,
        account_no = CASE WHEN $4 <> '' THEN $4 ELSE account_no END,
        account_id = CASE WHEN $5 <> '' THEN $5 ELSE account_id END,
        profile_url = CASE WHEN $6 <> '' THEN $6 ELSE profile_url END,
        aliases = $7::jsonb,
        skip_content = $8,
        status = 'active',
        updated_at = now()
      WHERE id = $9 AND tenant_id = $10
      RETURNING *
    `, [
      identity.platform,
      identity.accountName,
      identity.platformUserId,
      identity.accountNo,
      identity.legacyAccountId,
      identity.profileUrl,
      JSON.stringify(aliases),
      identity.skipContent,
      officialAccount.id,
      tenantId,
    ]);
  } else {
    officialAccount = await tx.queryOne(`
      INSERT INTO official_accounts (
        tenant_id, platform, account_name, platform_user_id, account_no,
        account_id, profile_url, aliases, skip_content, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active')
      RETURNING *
    `, [
      tenantId,
      identity.platform,
      identity.accountName,
      identity.platformUserId,
      identity.accountNo,
      identity.legacyAccountId,
      identity.profileUrl,
      JSON.stringify(aliases),
      identity.skipContent,
    ]);
  }

  let linkedSubscription = subscription;
  let linkedSubscriptionCreated = false;
  if ((subscription.subject_type || 'creator') === 'official') {
    linkedSubscription = await tx.queryOne(`
      UPDATE monitor_subscriptions
      SET subject_type = 'official',
        official_account_id = $1,
        updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *
    `, [officialAccount.id, subscription.id, tenantId]);
  } else {
    linkedSubscription = await tx.queryOne(`
      SELECT *
      FROM monitor_subscriptions
      WHERE tenant_id = $1
        AND platform = $2
        AND subject_type = 'official'
        AND (
          official_account_id = $3
          OR ($4 <> '' AND keyword = $4)
          OR ($5 <> '' AND account_url <> '' AND account_url = $5)
          OR (
            $5 = ''
            AND COALESCE(account_url, '') = ''
            AND keyword = $6
          )
        )
      ORDER BY status = 'deleted', created_at DESC
      LIMIT 1
      FOR UPDATE
    `, [
      tenantId,
      subscription.platform,
      officialAccount.id,
      identity.platformUserId,
      identity.profileUrl || subscription.account_url,
      subscription.keyword,
    ]);

    if (linkedSubscription) {
      linkedSubscription = await tx.queryOne(`
        UPDATE monitor_subscriptions
        SET name = $1,
          keyword = $2,
          account_url = $3,
          notify_on_negative = $4,
          cadence_minutes = $5,
          status = CASE WHEN status = 'deleted' THEN 'active' ELSE status END,
          subject_type = 'official',
          official_account_id = $6,
          assigned_agent_id = COALESCE($7::uuid, assigned_agent_id),
          next_run_at = CASE WHEN status = 'deleted' THEN now() ELSE next_run_at END,
          updated_at = now()
        WHERE id = $8 AND tenant_id = $9
        RETURNING *
      `, [
        identity.accountName,
        subscription.keyword,
        identity.profileUrl || subscription.account_url,
        subscription.notify_on_negative,
        subscription.cadence_minutes,
        officialAccount.id,
        subscription.assigned_agent_id || null,
        linkedSubscription.id,
        tenantId,
      ]);
    } else {
      linkedSubscriptionCreated = true;
      linkedSubscription = await tx.queryOne(`
        INSERT INTO monitor_subscriptions (
          tenant_id, name, keyword, platform, account_url, cadence_minutes,
          status, notify_on_negative, auth_code, next_run_at, subject_type,
          official_account_id, assigned_agent_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          'active', $7, $8, now(), 'official', $9, $10
        )
        RETURNING *
      `, [
        tenantId,
        identity.accountName,
        subscription.keyword,
        subscription.platform,
        identity.profileUrl || subscription.account_url,
        subscription.cadence_minutes,
        subscription.notify_on_negative,
        subscription.auth_code,
        officialAccount.id,
        subscription.assigned_agent_id || null,
      ]);
    }
  }

  if (sourceSubscription.id !== linkedSubscription.id) {
    sourceSubscription = await tx.queryOne(`
      UPDATE monitor_subscriptions
      SET status = 'paused',
        last_error = '',
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [sourceSubscription.id, tenantId]);
  }

  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
    ) VALUES (
      $1, $2, $3, 'monitor_subscription.marked_official',
      'monitor_subscription', $4, $5::jsonb
    )
  `, [
    tenantId,
    actorType,
    actorId,
    String(linkedSubscription.id),
    JSON.stringify({
      officialAccountId: officialAccount.id,
      platform: officialAccount.platform,
      sourceSubscriptionId: subscription.id,
      creatorHistoryPreserved: subscription.id !== linkedSubscription.id,
      creatorSubscriptionPaused: sourceSubscription.status === 'paused',
    }),
  ]);

  return {
    subscription: linkedSubscription,
    sourceSubscription,
    officialAccount,
    linkedSubscriptionCreated,
  };
}

router.get('/subscriptions', requireTenantAccess, async (req, res, next) => {
  try {
    const { status = 'all', platform = '', subjectType = '' } = req.query;
    const normalizedSubjectType = subjectType
      ? normalizeSubjectType(subjectType, '')
      : '';
    if (subjectType && !normalizedSubjectType) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_subject_type',
        message: 'subjectType 仅支持 creator 或 official',
      });
    }
    const params = [req.tenantId];
    let sql = `
      SELECT ms.*,
        EXISTS (
          SELECT 1
          FROM monitor_subscriptions official
          WHERE official.tenant_id = ms.tenant_id
            AND official.platform = ms.platform
            AND official.subject_type = 'official'
            AND official.status = 'active'
            AND (
              (
                official.account_url <> ''
                AND ms.account_url <> ''
                AND official.account_url = ms.account_url
              )
              OR (
                COALESCE(official.account_url, '') = ''
                AND COALESCE(ms.account_url, '') = ''
                AND official.keyword = ms.keyword
              )
            )
        ) AS has_official_role,
        latest_execution.status AS latest_execution_status,
        latest_execution.error_message AS latest_execution_error,
        latest_execution.created_at AS latest_execution_at,
        (
          ms.status = 'active'
          AND ms.subject_type = 'creator'
          AND COALESCE(ms.account_url, '') <> ''
          AND latest_execution.status = 'failed'
          AND NOT EXISTS (
            SELECT 1
            FROM monitor_subscriptions official
            WHERE official.tenant_id = ms.tenant_id
              AND official.platform = ms.platform
              AND official.subject_type = 'official'
              AND official.status = 'active'
              AND official.account_url <> ''
              AND official.account_url = ms.account_url
          )
        ) AS attention_required
      FROM monitor_subscriptions ms
      LEFT JOIN LATERAL (
        SELECT execution.status, execution.error_message, execution.created_at
        FROM monitor_executions execution
        WHERE execution.tenant_id = ms.tenant_id
          AND execution.subscription_id = ms.id
        ORDER BY execution.created_at DESC, execution.id DESC
        LIMIT 1
      ) latest_execution ON true
      WHERE ms.tenant_id = $1
    `;
    // 监控中心只做对标监控:仅显示账号(博主)订阅(account_url 非空),过滤旧的关键词订阅
    sql += ` AND COALESCE(ms.account_url, '') <> ''`;
    if (status !== 'all') { params.push(status); sql += ` AND ms.status = $${params.length}`; }
    else { sql += ` AND ms.status <> 'deleted'`; } // 默认不显示已删除
    if (platform) { params.push(platform); sql += ` AND ms.platform = $${params.length}`; }
    if (normalizedSubjectType) {
      params.push(normalizedSubjectType);
      sql += ` AND ms.subject_type = $${params.length}`;
    }
    sql += ' ORDER BY ms.created_at DESC';
    const subscriptions = (await queryAll(sql, params)).map(normalizeMonitorSubscriptionRow);
    return res.json({
      ok: true,
      subscriptions,
      data: { items: subscriptions },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/subscriptions', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const input = resolveSubscriptionInput(req.body);
    if (!input.subjectType) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_subject_type',
        message: 'subjectType 仅支持 creator 或 official',
      });
    }
    if (!input.keyword) {
      return res.json({ ok: false, error: 'invalid_request', message: '账号 ID 或关键词不能为空' });
    }
    const rawAssignedAgentId = normalizeText(
      req.body?.assignedAgentId || req.body?.assigned_agent_id,
    );
    if (rawAssignedAgentId && !isUuid(rawAssignedAgentId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_assigned_agent_id',
        message: '执行节点 ID 无效',
      });
    }

    const result = await withTransaction(async tx => {
      const binding = await validateSubscriptionAgentBinding(tx, {
        tenantId: req.tenantId,
        assignedAgentId: input.assignedAgentId,
        actorType: req.actorType,
        authCodeId: req.authCodeRow?.id || '',
      });
      if (binding.failure) return {failure: binding.failure};

      const officialIdentity = input.subjectType === 'official'
        ? resolveOfficialIdentity(req.body, {
          platform: input.platform,
          name: input.name,
          account_url: input.accountUrl,
        })
        : null;
      const matchedOfficialAccount = officialIdentity
        ? await findOfficialAccountForUpdate(tx, req.tenantId, officialIdentity)
        : null;

      let subscription = await tx.queryOne(`
        SELECT *
        FROM monitor_subscriptions
        WHERE tenant_id = $1
          AND platform = $2
          AND subject_type = $5
          AND (
            ($6::uuid IS NOT NULL AND official_account_id = $6::uuid)
            OR ($7 <> '' AND keyword = $7)
            OR ($4 <> '' AND account_url <> '' AND account_url = $4)
            OR (
              $4 = ''
              AND COALESCE(account_url, '') = ''
              AND keyword = $3
            )
          )
        ORDER BY status = 'deleted', created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [
        req.tenantId,
        input.platform,
        input.keyword,
        input.accountUrl,
        input.subjectType,
        matchedOfficialAccount?.id || null,
        officialIdentity?.platformUserId || '',
      ]);
      if (!subscription && input.subjectType === 'official') {
        subscription = await tx.queryOne(`
          SELECT *
          FROM monitor_subscriptions
          WHERE tenant_id = $1
            AND platform = $2
            AND subject_type = 'creator'
            AND status <> 'deleted'
            AND (
              ($5 <> '' AND keyword = $5)
              OR ($4 <> '' AND account_url <> '' AND account_url = $4)
              OR (
                $4 = ''
                AND COALESCE(account_url, '') = ''
                AND keyword = $3
              )
            )
          ORDER BY status = 'active' DESC, created_at DESC
          LIMIT 1
          FOR UPDATE
        `, [
          req.tenantId,
          input.platform,
          input.keyword,
          input.accountUrl,
          officialIdentity?.platformUserId || '',
        ]);
      }

      let created = false;
      let restored = false;
      if (subscription?.status === 'deleted') {
        restored = true;
        subscription = await tx.queryOne(`
          UPDATE monitor_subscriptions
          SET status = 'active',
            name = $1,
            keyword = $2,
            account_url = $3,
            notify_on_negative = $4,
            cadence_minutes = $5,
            subject_type = $6,
            assigned_agent_id = COALESCE($7::uuid, assigned_agent_id),
            next_run_at = now(),
            updated_at = now()
          WHERE id = $8 AND tenant_id = $9
          RETURNING *
        `, [
          input.name || input.keyword,
          input.keyword,
          input.accountUrl,
          Boolean(input.notifyOnNegative),
          input.cadenceMinutes,
          input.subjectType,
          binding.agentId,
          subscription.id,
          req.tenantId,
        ]);
      } else if (!subscription) {
        created = true;
        subscription = await tx.queryOne(`
          INSERT INTO monitor_subscriptions (
            tenant_id, name, keyword, platform, account_url, notify_on_negative,
            cadence_minutes, auth_code, next_run_at, subject_type,
            assigned_agent_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10
          )
          RETURNING *
        `, [
          req.tenantId,
          input.name || input.keyword,
          input.keyword,
          input.platform,
          input.accountUrl,
          Boolean(input.notifyOnNegative),
          input.cadenceMinutes,
          req.authCode || '',
          input.subjectType,
          binding.agentId,
        ]);
      } else if (binding.agentId) {
        subscription = await tx.queryOne(`
          UPDATE monitor_subscriptions
          SET assigned_agent_id = $1,
            last_error = '',
            updated_at = now()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *
        `, [binding.agentId, subscription.id, req.tenantId]);
      }

      let officialAccount = null;
      if (input.subjectType === 'official') {
        const marked = await markSubscriptionOfficial(tx, {
          tenantId: req.tenantId,
          subscriptionId: subscription.id,
          body: req.body,
          actorType: req.actorType || 'user',
          actorId: req.user?.id || '',
        });
        if (marked.failure) {
          const error = new Error(marked.failure.message);
          Object.assign(error, marked.failure);
          throw error;
        }
        subscription = marked.subscription;
        officialAccount = marked.officialAccount;
        created = created || marked.linkedSubscriptionCreated;
      }

      return {subscription, officialAccount, created, restored};
    });
    if (result.failure) {
      return res.status(result.failure.status).json({
        ok: false,
        error: result.failure.error,
        message: result.failure.message,
      });
    }

    return res.json({
      ok: true,
      id: result.subscription.id,
      data: {
        created: result.created,
        restored: result.restored,
        item: normalizeMonitorSubscriptionRow(result.subscription),
        officialAccount: result.officialAccount,
      },
    });
  } catch (err) {
    if (err.status && err.error) {
      return res.status(err.status).json({
        ok: false,
        error: err.error,
        message: err.message,
      });
    }
    return next(err);
  }
});

router.post(
  '/subscriptions/:id/mark-official',
  requireTenantAccess,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_subscription_id',
          message: '关注账号 ID 无效',
        });
      }
      const result = await withTransaction(tx => markSubscriptionOfficial(tx, {
        tenantId: req.tenantId,
        subscriptionId: req.params.id,
        body: req.body,
        actorType: req.actorType || 'user',
        actorId: req.user?.id || '',
      }));
      if (result.failure) {
        return res.status(result.failure.status).json({
          ok: false,
          error: result.failure.error,
          message: result.failure.message,
        });
      }
      return res.json({
        ok: true,
        data: {
          item: normalizeMonitorSubscriptionRow(result.subscription),
          sourceItem: normalizeMonitorSubscriptionRow(result.sourceSubscription),
          officialAccount: result.officialAccount,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.patch('/subscriptions/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, name, keyword, platform, accountUrl, notifyOnNegative, cadenceMinutes } = req.body;
    const updates = [];
    const params = [];
    const add = (field, value) => {
      params.push(value);
      updates.push(`${field} = $${params.length}`);
    };

    if (status !== undefined) add('status', status);
    if (name !== undefined) add('name', name);
    if (keyword !== undefined) add('keyword', keyword);
    if (platform !== undefined) add('platform', platform);
    if (accountUrl !== undefined) add('account_url', accountUrl);
    if (notifyOnNegative !== undefined) add('notify_on_negative', Boolean(notifyOnNegative));
    if (cadenceMinutes !== undefined) add('cadence_minutes', Number(cadenceMinutes) || 1440);
    if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
    updates.push('updated_at = now()');
    params.push(id, req.tenantId);

    const subscription = await withTransaction(async tx => {
      const saved = await tx.queryOne(`
        UPDATE monitor_subscriptions
        SET ${updates.join(', ')}
        WHERE id = $${params.length - 1}
          AND tenant_id = $${params.length}
        RETURNING *
      `, params);
      if (!saved) return null;

      if (
        saved.subject_type === 'official' &&
        saved.official_account_id &&
        status === 'deleted'
      ) {
        // Extension deletion owns the official-account lifecycle. Retire the
        // account only after its final live official subscription is gone.
        await tx.execute(`
          UPDATE official_accounts account
          SET status = 'deleted',
            updated_at = now()
          WHERE account.id = $1
            AND account.tenant_id = $2
            AND NOT EXISTS (
              SELECT 1
              FROM monitor_subscriptions other
              WHERE other.tenant_id = account.tenant_id
                AND other.official_account_id = account.id
                AND other.subject_type = 'official'
                AND other.status <> 'deleted'
            )
        `, [saved.official_account_id, req.tenantId]);
      } else if (
        saved.subject_type === 'official' &&
        saved.official_account_id &&
        status === 'active'
      ) {
        await tx.execute(`
          UPDATE official_accounts
          SET status = 'active',
            updated_at = now()
          WHERE id = $1 AND tenant_id = $2
        `, [saved.official_account_id, req.tenantId]);
      }

      return saved;
    });
    return res.json({ ok: Boolean(subscription) });
  } catch (err) {
    return next(err);
  }
});

router.get('/executions', requireTenantAccess, async (req, res, next) => {
  try {
    const { subscriptionId, limit = 50 } = req.query;
    const params = [req.tenantId];
    let sql = 'SELECT * FROM monitor_executions WHERE tenant_id = $1';
    if (subscriptionId) { params.push(subscriptionId); sql += ` AND subscription_id = $${params.length}`; }
    params.push(Number(limit));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    return res.json({ ok: true, executions: await queryAll(sql, params) });
  } catch (err) {
    return next(err);
  }
});

router.get('/hits', requireTenantAccess, async (req, res, next) => {
  try {
    const {
      platform = '',
      subscriptionId = '',
      range = '7d',
      page = 1,
      pageSize = 30,
    } = req.query;

    const params = [req.tenantId];
    let where = `
      WHERE ro.tenant_id = $1
        AND ro.monitor_execution_id IS NOT NULL
    `;

    const since = resolveHitsSince(String(range));
    if (since) {
      params.push(since.toISOString());
      where += ` AND ro.captured_at >= $${params.length}`;
    }
    if (platform) {
      params.push(platform);
      where += ` AND r.platform = $${params.length}`;
    }
    if (subscriptionId) {
      params.push(subscriptionId);
      where += ` AND me.subscription_id = $${params.length}`;
    }

    const joins = `
      FROM record_observations ro
      JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
      LEFT JOIN monitor_executions me ON me.id = ro.monitor_execution_id AND me.tenant_id = ro.tenant_id
      LEFT JOIN monitor_subscriptions ms ON ms.id = me.subscription_id AND ms.tenant_id = ro.tenant_id
    `;
    const rankedCte = `
      WITH ranked_monitor_hits AS (
        SELECT
          ro.id AS observation_id,
          ro.captured_at,
          ro.keyword AS observation_keyword,
          ro.rank_position,
          ro.interaction_total AS observation_interaction,
          me.id AS execution_id,
          me.status AS execution_status,
          ms.id AS subscription_id,
          ms.name AS monitor_name,
          ms.keyword AS monitor_keyword,
          ms.account_url AS monitor_account_url,
          r.id AS record_id,
          r.platform,
          r.record_type,
          r.title,
          r.content,
          r.url,
          r.author_name,
          r.author_fans,
          r.keyword,
          r.likes,
          r.comments_count,
          r.collects,
          r.shares,
          r.payload AS record_payload,
          ro.payload AS observation_payload,
          r.sentiment,
          r.category,
          r.created_at,
          r.last_seen_at,
          CASE
            WHEN r.created_at >= ro.captured_at - interval '5 minutes'
              AND r.created_at <= ro.captured_at + interval '5 minutes'
            THEN true
            ELSE false
          END AS is_new_record,
          ROW_NUMBER() OVER (
            PARTITION BY ro.tenant_id, ro.record_id, me.subscription_id
            ORDER BY ro.captured_at DESC, ro.id DESC
          ) AS monitor_hit_rank
        ${joins}
        ${where}
      )
    `;

    const total = (await queryOne(`
      ${rankedCte}
      SELECT COUNT(*) AS total
      FROM ranked_monitor_hits
      WHERE monitor_hit_rank = 1
    `, params))?.total || 0;

    const limit = Math.min(100, Math.max(1, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const hits = await queryAll(`
      ${rankedCte}
      SELECT *
      FROM ranked_monitor_hits
      WHERE monitor_hit_rank = 1
      ORDER BY captured_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const normalizedHits = hits.map(applyResolvedMetrics);

    return res.json({
      ok: true,
      hits: normalizedHits,
      pagination: {
        page: Number(page),
        pageSize: limit,
        total: Number(total || 0),
        totalPages: Math.ceil(Number(total || 0) / limit),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/due', requireTenantAccess, async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const executions = await queryAll(`
      SELECT
        me.*,
        ms.name,
        ms.keyword,
        ms.platform,
        ms.account_url,
        ms.cadence_minutes,
        ms.last_cursor
      FROM monitor_executions me
      JOIN monitor_subscriptions ms ON ms.id = me.subscription_id
      WHERE me.tenant_id = $1
        AND me.status = 'pending'
        AND ms.status = 'active'
        AND COALESCE(ms.subject_type, 'creator') = 'creator'
        AND NOT EXISTS (
          SELECT 1
          FROM capture_task_items item
          WHERE item.tenant_id = me.tenant_id
            AND item.metadata->>'monitorExecutionId' = me.id::text
        )
      ORDER BY me.created_at ASC
      LIMIT $2
    `, [req.tenantId, limit]);

    return res.json({ ok: true, executions });
  } catch (err) {
    return next(err);
  }
});

router.post('/executions/:id/start', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await execute(`
      UPDATE monitor_executions
      SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM capture_task_items item
          WHERE item.tenant_id = monitor_executions.tenant_id
            AND item.metadata->>'monitorExecutionId' =
              monitor_executions.id::text
        )
      RETURNING id
    `, [req.params.id, req.tenantId]);
    return res.json({ ok: result.rowCount > 0, executionId: result.rows[0]?.id || null });
  } catch (err) {
    return next(err);
  }
});

router.post('/executions/:id/finish', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const {
      status = 'succeeded',
      recordsFound = 0,
      newRecords = 0,
      updatedRecords = 0,
      negativeCount = 0,
      errorMessage = '',
      nextCursor = '',
    } = req.body;

    const finalStatus = status === 'failed' ? 'failed' : 'succeeded';
    const result = await withTransaction(async tx => {
      await lockProfileDiscoverySubscriptionsForExecutions(
        tx,
        req.tenantId,
        [req.params.id],
      );
      const execution = await tx.queryOne(`
        UPDATE monitor_executions
        SET status = $1,
          records_found = $2,
          new_records = $3,
          updated_records = $4,
          negative_count = $5,
          error_message = $6,
          finished_at = now(),
          updated_at = now()
        WHERE id = $7 AND tenant_id = $8 AND status IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM capture_task_items item
            WHERE item.tenant_id = monitor_executions.tenant_id
              AND item.metadata->>'monitorExecutionId' =
                monitor_executions.id::text
          )
        RETURNING *
      `, [
        finalStatus,
        Number(recordsFound) || 0,
        Number(newRecords) || 0,
        Number(updatedRecords) || 0,
        Number(negativeCount) || 0,
        errorMessage || '',
        req.params.id,
        req.tenantId,
      ]);

      if (!execution) return null;

      await tx.execute(`
        UPDATE monitor_subscriptions
        SET last_run_at = now(),
          next_run_at = CASE
            WHEN $1 = 'succeeded' THEN now() + make_interval(mins => cadence_minutes)
            ELSE now() + interval '15 minutes'
          END,
          last_cursor = COALESCE(NULLIF($2, ''), last_cursor),
          last_error = $3,
          updated_at = now()
        WHERE id = $4 AND tenant_id = $5
      `, [finalStatus, nextCursor || '', finalStatus === 'failed' ? errorMessage : '', execution.subscription_id, req.tenantId]);

      if (finalStatus === 'succeeded') {
        await captureOfficialCommentPatrolSnapshots(
          tx,
          req.tenantId,
          execution.id,
        );
      }

      return execution;
    });

    return res.json({ ok: Boolean(result), execution: result });
  } catch (err) {
    return next(err);
  }
});

router.get('/settings', requireTenantAccess, async (req, res, next) => {
  try {
    const all = await getAllSettings(req.tenantId);
    const settings = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('monitor_')) {
        const plainKey = key.slice('monitor_'.length);
        if (MONITOR_SETTING_KEYS.has(plainKey)) settings[plainKey] = value;
        continue;
      }
      if (MONITOR_SETTING_KEYS.has(key)) settings[key] = value;
    }
    return res.json({ ok: true, settings });
  } catch (err) {
    return next(err);
  }
});

router.put('/settings', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const source = req.body?.settings && typeof req.body.settings === 'object'
      ? req.body.settings
      : req.body;
    const nextSettings = {};
    for (const [key, value] of Object.entries(source || {})) {
      const plainKey = String(key || '').startsWith('monitor_')
        ? String(key).slice('monitor_'.length)
        : String(key || '');
      if (!MONITOR_SETTING_KEYS.has(plainKey)) continue;
      nextSettings[`monitor_${plainKey}`] = Array.isArray(value)
        ? value.join(',')
        : value;
    }
    await setSettings(nextSettings, req.tenantId);
    return res.json({
      ok: true,
      settings: Object.fromEntries(
        Object.entries(nextSettings).map(([key, value]) => [
          key.slice('monitor_'.length),
          String(value ?? ''),
        ]),
      ),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/run-now', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { subscriptionId, platform = '', limit } = req.body;
    const subjectType = normalizeSubjectType(
      req.body?.subjectType || req.body?.subject_type,
      'creator',
    );
    if (!subjectType) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_subject_type',
        message: 'subjectType 仅支持 creator 或 official',
      });
    }
    if (subjectType !== 'creator') {
      return res.status(409).json({
        ok: false,
        error: 'official_subscription_requires_dispatch',
        message: '官方账号请在调度中心创建评论巡查任务',
      });
    }
    const params = [req.tenantId, subjectType];
    let sql = `
      SELECT *
      FROM monitor_subscriptions
      WHERE tenant_id = $1
        AND status = 'active'
        AND subject_type = $2
    `;

    if (subscriptionId) {
      params.push(subscriptionId);
      sql += ` AND id = $${params.length}`;
    }
    if (!subscriptionId && platform) {
      params.push(platform);
      sql += ` AND platform = $${params.length}`;
    }

    params.push(Math.min(50, Math.max(1, Number(limit) || 50)));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const subscriptions = await queryAll(sql, params);
    if (subscriptionId && subscriptions.length === 0) {
      return res.json({ ok: false, error: 'not_found', message: '订阅不存在' });
    }

    const items = [];
    for (const sub of subscriptions) {
      const existing = await queryOne(`
        SELECT id, status
        FROM monitor_executions
        WHERE tenant_id = $1
          AND subscription_id = $2
          AND status IN ('pending', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `, [req.tenantId, sub.id]);

      if (existing) {
        items.push({
          subscriptionId: sub.id,
          executionId: existing.id,
          platform: sub.platform,
          status: 'queued',
          queued: true,
          existing: true,
        });
        continue;
      }

      const result = await queryOne(`
        INSERT INTO monitor_executions (tenant_id, subscription_id, status)
        VALUES ($1, $2, 'pending')
        RETURNING id
      `, [req.tenantId, sub.id]);

      items.push({
        subscriptionId: sub.id,
        executionId: result.id,
        platform: sub.platform,
        status: 'queued',
        queued: true,
        existing: false,
      });
    }

    return res.json({
      ok: true,
      executionId: items[0]?.executionId || null,
      message: items.length > 0 ? `已创建 ${items.length} 个执行任务` : '暂无可执行监控项',
      data: {
        items,
        total: items.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
