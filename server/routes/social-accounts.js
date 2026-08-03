import { Router } from 'express';
import {
  queryAll,
  queryOne,
  withTransaction,
} from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {lockCaptureAgentExecutionSlot} from '../services/capture-cloud.js';
import { normalizeSocialPlatform } from '../services/social-account-usage.js';

const router = Router();
const HEALTH_STATUSES = new Set([
  'active',
  'resting',
  'risk',
  'login_required',
  'disabled',
  'unknown',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const AGENT_BINDING_MODES = new Set(['auto', 'manual']);

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function nonNegativeInteger(value, maximum = 1000000) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(maximum, parsed)
    : 0;
}

function uuid(value) {
  const candidate = text(value, 80);
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

function sendInvalidId(res, field = '账号') {
  return res.status(400).json({
    ok: false,
    error: 'invalid_id',
    message: `${field}标识格式不正确`,
  });
}

function optionalTimestamp(value) {
  const normalized = text(value, 100);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeAccountBody(body = {}) {
  const platform = normalizeSocialPlatform(body.platform);
  const healthStatus = HEALTH_STATUSES.has(body.healthStatus)
    ? body.healthStatus
    : 'active';
  return {
    platform,
    platformAccountId: text(body.platformAccountId, 240),
    accountHandle: text(body.accountHandle, 160),
    displayName: text(body.displayName, 160),
    registeredPhone: text(body.registeredPhone, 40),
    healthStatus,
    restUntil: optionalTimestamp(body.restUntil),
    notes: text(body.notes, 2000),
    dailySearchLimit: nonNegativeInteger(body.dailySearchLimit),
    dailyEnhancementLimit: nonNegativeInteger(
      body.dailyEnhancementLimit,
    ),
    dailyCaptureLimit: nonNegativeInteger(body.dailyCaptureLimit),
  };
}

function normalizeAgentIds(value) {
  if (!Array.isArray(value)) {
    return {error: '请明确提交 Agent 列表；空列表表示解绑全部'};
  }
  const source = value;
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const agentId = uuid(item);
    if (!agentId) return {error: 'Agent 标识格式不正确'};
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    result.push(agentId);
  }
  if (result.length > 100) return {error: '单个账号最多绑定 100 个 Agent'};
  return {agentIds: result.sort()};
}

function accountValidationError(account) {
  if (!account.platform) return '请选择账号平台';
  if (
    !account.displayName &&
    !account.accountHandle &&
    !account.platformAccountId
  ) {
    return '账号名称、账号或平台 ID 至少填写一项';
  }
  if (
    account.registeredPhone &&
    !/^[+()\d\s-]{5,40}$/u.test(account.registeredPhone)
  ) {
    return '注册手机号格式不正确';
  }
  return '';
}

async function bindAccountToAgent(
  tx,
  {
    tenantId,
    accountId,
    platform,
    agentId,
    source = 'manual',
  },
) {
  const normalizedAgentId = uuid(agentId);
  if (!normalizedAgentId) return {invalidAgentId: true};
  const agent = await tx.queryOne(`
    SELECT id
    FROM capture_agents
    WHERE id = $1 AND tenant_id = $2
      AND status IN ('active', 'paused')
    FOR UPDATE
  `, [normalizedAgentId, tenantId]);
  if (!agent) return {notFound: true};
  await tx.execute(`
    UPDATE social_account_bindings
    SET status = 'historical', ended_at = now(), updated_at = now()
    WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3
      AND status = 'current' AND social_account_id <> $4
  `, [tenantId, normalizedAgentId, platform, accountId]);
  const binding = await tx.queryOne(`
    INSERT INTO social_account_bindings (
      tenant_id, agent_id, social_account_id, platform, source,
      last_login_state
    ) VALUES ($1, $2, $3, $4, $5, 'unknown')
    ON CONFLICT (
      tenant_id, agent_id, platform
    ) WHERE status = 'current'
    DO UPDATE SET
      social_account_id = EXCLUDED.social_account_id,
      source = EXCLUDED.source,
      last_login_state = 'unknown',
      last_seen_at = now(),
      updated_at = now()
    RETURNING id, agent_id, social_account_id, platform, status
  `, [tenantId, normalizedAgentId, accountId, platform, source]);
  await tx.execute(`
    UPDATE social_accounts
    SET last_agent_id = $1, updated_at = now()
    WHERE id = $2 AND tenant_id = $3
  `, [normalizedAgentId, accountId, tenantId]);
  return {binding};
}

router.get(
  '/overview',
  requireTenantAccess,
  requireSessionUser,
  async (req, res, next) => {
    try {
      const days = Math.min(
        31,
        Math.max(1, Math.floor(Number(req.query.days) || 7)),
      );
      const [accounts, bindings, agents, usage] = await Promise.all([
        queryAll(`
          SELECT
            a.*,
            CASE
              WHEN a.health_status = 'resting'
                AND a.rest_until IS NOT NULL
                AND a.rest_until <= now()
                THEN 'active'
              ELSE a.health_status
            END AS effective_health_status
          FROM social_accounts a
          WHERE a.tenant_id = $1
            AND NOT (
              (
                a.platform_account_id <> ''
                AND lower(a.platform_account_id) = ANY(
                  ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
                    'undefined', 'null']
                )
              )
              OR (
                a.account_handle <> ''
                AND lower(trim(leading '@' FROM a.account_handle)) = ANY(
                ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
                  'undefined', 'null']
                )
              )
            )
          ORDER BY
            CASE a.health_status
              WHEN 'risk' THEN 0
              WHEN 'login_required' THEN 1
              WHEN 'resting' THEN 2
              WHEN 'unknown' THEN 3
              ELSE 4
            END,
            a.updated_at DESC
        `, [req.tenantId]),
        queryAll(`
          SELECT
            b.id, b.agent_id, b.social_account_id, b.platform,
            b.status, b.source, b.last_login_state, b.first_seen_at,
            b.last_seen_at, b.ended_at,
            ca.display_name AS agent_display_name,
            ca.host_label AS agent_host_label,
            ca.browser_name AS agent_browser_name,
            ca.operating_system AS agent_operating_system,
            ca.last_heartbeat_at AS agent_last_heartbeat_at,
            ca.status AS agent_status,
            (
              ca.status = 'active'
              AND ca.last_heartbeat_at >= now() - interval '2 minutes'
            ) AS agent_online
          FROM social_account_bindings b
          JOIN capture_agents ca
            ON ca.id = b.agent_id AND ca.tenant_id = b.tenant_id
          WHERE b.tenant_id = $1
          ORDER BY
            CASE b.status WHEN 'current' THEN 0 ELSE 1 END,
            b.last_seen_at DESC
        `, [req.tenantId]),
        queryAll(`
          SELECT
            ca.id, ca.display_name, ca.host_label, ca.client_label,
            ca.browser_name, ca.operating_system, ca.app_version,
            ca.allowed_platforms, ca.status, ca.last_heartbeat_at,
            (
              ca.status = 'active'
              AND ca.last_heartbeat_at >= now() - interval '2 minutes'
            ) AS online
          FROM capture_agents ca
          WHERE ca.tenant_id = $1
            AND ca.status IN ('active', 'paused')
          ORDER BY ca.host_label, ca.display_name, ca.created_at
        `, [req.tenantId]),
        queryAll(`
          SELECT
            du.social_account_id, du.agent_id, du.platform,
            du.usage_date::text AS usage_date,
            du.searches, du.enhancements,
            du.capture_runs, du.captured_items, du.failed_events,
            du.last_event_at
          FROM social_account_daily_usage du
          WHERE du.tenant_id = $1
            AND du.usage_date >= (
              (now() AT TIME ZONE 'Asia/Shanghai')::date - ($2::integer - 1)
            )
          ORDER BY du.usage_date DESC, du.last_event_at DESC
        `, [req.tenantId, days]),
      ]);

      const visibleAccountIds = new Set(accounts.map(account => account.id));
      const visibleBindings = bindings.filter(binding =>
        visibleAccountIds.has(binding.social_account_id),
      );
      const visibleUsage = usage.filter(row =>
        visibleAccountIds.has(row.social_account_id),
      );
      const bindingsByAccount = new Map();
      for (const binding of visibleBindings) {
        const list = bindingsByAccount.get(binding.social_account_id) || [];
        list.push(binding);
        bindingsByAccount.set(binding.social_account_id, list);
      }
      const usageByAccount = new Map();
      for (const row of visibleUsage) {
        const list = usageByAccount.get(row.social_account_id) || [];
        list.push(row);
        usageByAccount.set(row.social_account_id, list);
      }
      const enrichedAccounts = accounts.map(account => ({
        ...account,
        bindings: bindingsByAccount.get(account.id) || [],
        usage: usageByAccount.get(account.id) || [],
      }));
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
      }).format(new Date());
      const todayUsage = visibleUsage.filter(
        row => String(row.usage_date) === today,
      );
      const todayTotals = todayUsage.reduce(
        (totals, row) => ({
          searches: totals.searches + Number(row.searches || 0),
          enhancements:
            totals.enhancements + Number(row.enhancements || 0),
          captureRuns:
            totals.captureRuns + Number(row.capture_runs || 0),
          capturedItems:
            totals.capturedItems + Number(row.captured_items || 0),
        }),
        {
          searches: 0,
          enhancements: 0,
          captureRuns: 0,
          capturedItems: 0,
        },
      );
      return res.json({
        ok: true,
        days,
        today,
        accounts: enrichedAccounts,
        agents,
        summary: {
          accounts: accounts.length,
          boundAgents: new Set(
            visibleBindings
              .filter(binding => binding.status === 'current')
              .map(binding => binding.agent_id),
          ).size,
          needsAttention: accounts.filter(account =>
            ['risk', 'login_required'].includes(
              account.effective_health_status,
            ),
          ).length,
          resting: accounts.filter(account =>
            account.effective_health_status === 'resting',
          ).length,
          today: todayTotals,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const account = normalizeAccountBody(req.body);
      const validationError = accountValidationError(account);
      if (validationError) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_social_account',
          message: validationError,
        });
      }
      const rawAgentId = text(req.body?.agentId, 80);
      const agentId = uuid(rawAgentId);
      if (rawAgentId && !agentId) return sendInvalidId(res, 'Agent');
      const result = await withTransaction(async tx => {
        if (agentId) {
          const agent = await tx.queryOne(`
            SELECT id
            FROM capture_agents
            WHERE id = $1 AND tenant_id = $2
              AND status IN ('active', 'paused')
            FOR UPDATE
          `, [agentId, req.tenantId]);
          if (!agent) return {agentNotFound: true};
        }
        const created = await tx.queryOne(`
          INSERT INTO social_accounts (
            tenant_id, platform, platform_account_id, account_handle,
            display_name, registered_phone, identity_source,
            health_status, rest_until, notes,
            daily_search_limit, daily_enhancement_limit,
            daily_capture_limit, agent_binding_mode
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, 'manual',
            $7, $8, $9,
            $10, $11,
            $12, $13
          )
          RETURNING *
        `, [
          req.tenantId,
          account.platform,
          account.platformAccountId,
          account.accountHandle,
          account.displayName,
          account.registeredPhone,
          account.healthStatus,
          account.restUntil,
          account.notes,
          account.dailySearchLimit,
          account.dailyEnhancementLimit,
          account.dailyCaptureLimit,
          AGENT_BINDING_MODES.has(req.body?.agentBindingMode)
            ? req.body.agentBindingMode
            : 'manual',
        ]);
        let binding = null;
        if (agentId) {
          const bound = await bindAccountToAgent(tx, {
            tenantId: req.tenantId,
            accountId: created.id,
            platform: created.platform,
            agentId,
            source: created.agent_binding_mode === 'auto'
              ? 'extension'
              : 'manual',
          });
          if (bound.notFound) return {agentNotFound: true};
          binding = bound.binding;
        }
        return {account: created, binding};
      });
      if (result.agentNotFound) {
        return res.status(404).json({
          ok: false,
          error: 'agent_not_found',
          message: '执行节点不存在或已撤销',
        });
      }
      return res.status(201).json({ok: true, ...result});
    } catch (error) {
      if (error?.code === '23505') {
        return res.status(409).json({
          ok: false,
          error: 'social_account_exists',
          message: '相同平台账号 ID 或账号已经存在',
        });
      }
      return next(error);
    }
  },
);

router.patch(
  '/:id',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const accountId = uuid(req.params.id);
      if (!accountId) return sendInvalidId(res);
      const account = normalizeAccountBody(req.body);
      const validationError = accountValidationError(account);
      if (validationError) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_social_account',
          message: validationError,
        });
      }
      const updated = await queryOne(`
        UPDATE social_accounts
        SET platform_account_id = $1,
          account_handle = $2,
          display_name = $3,
          registered_phone = $4,
          identity_source = CASE
            WHEN identity_source <> 'manual'
              AND (
                platform_account_id IS DISTINCT FROM $1
                OR account_handle IS DISTINCT FROM $2
                OR display_name IS DISTINCT FROM $3
              )
              THEN 'manual'
            ELSE identity_source
          END,
          health_status = $5,
          rest_until = $6,
          notes = $7,
          daily_search_limit = $8,
          daily_enhancement_limit = $9,
          daily_capture_limit = $10,
          updated_at = now()
        WHERE id = $11 AND tenant_id = $12
        RETURNING *
      `, [
        account.platformAccountId,
        account.accountHandle,
        account.displayName,
        account.registeredPhone,
        account.healthStatus,
        account.restUntil,
        account.notes,
        account.dailySearchLimit,
        account.dailyEnhancementLimit,
        account.dailyCaptureLimit,
        accountId,
        req.tenantId,
      ]);
      if (!updated) {
        return res.status(404).json({
          ok: false,
          error: 'social_account_not_found',
          message: '社交账号不存在',
        });
      }
      return res.json({ok: true, account: updated});
    } catch (error) {
      if (error?.code === '23505') {
        return res.status(409).json({
          ok: false,
          error: 'social_account_exists',
          message: '相同平台账号 ID 或账号已经存在',
        });
      }
      return next(error);
    }
  },
);

router.post(
  '/:id/bindings',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const accountId = uuid(req.params.id);
      if (!accountId) return sendInvalidId(res);
      const agentId = uuid(req.body?.agentId);
      if (!agentId) return sendInvalidId(res, 'Agent');
      const result = await withTransaction(async tx => {
        await lockCaptureAgentExecutionSlot(
          tx,
          req.tenantId,
          agentId,
        );
        const account = await tx.queryOne(`
          SELECT id, platform
          FROM social_accounts
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `, [accountId, req.tenantId]);
        if (!account) return {accountNotFound: true};
        await tx.execute(`
          UPDATE social_accounts
          SET agent_binding_mode = 'manual', updated_at = now()
          WHERE id = $1 AND tenant_id = $2
        `, [account.id, req.tenantId]);
        return await bindAccountToAgent(tx, {
          tenantId: req.tenantId,
          accountId: account.id,
          platform: account.platform,
          agentId,
        });
      });
      if (result.accountNotFound) {
        return res.status(404).json({
          ok: false,
          error: 'social_account_not_found',
          message: '社交账号不存在',
        });
      }
      if (result.notFound) {
        return res.status(404).json({
          ok: false,
          error: 'agent_not_found',
          message: '执行节点不存在或已撤销',
        });
      }
      if (result.invalidAgentId) {
        return sendInvalidId(res, 'Agent');
      }
      return res.json({ok: true, binding: result.binding});
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  '/:id/bindings',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const accountId = uuid(req.params.id);
      if (!accountId) return sendInvalidId(res);
      const normalizedAgents = normalizeAgentIds(req.body?.agentIds);
      if (normalizedAgents.error) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_agent_ids',
          message: normalizedAgents.error,
        });
      }
      if (!AGENT_BINDING_MODES.has(req.body?.bindingMode)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_binding_mode',
          message: '请选择手动指定或自动识别',
        });
      }
      const bindingMode = req.body.bindingMode;
      const result = await withTransaction(async tx => {
        const currentAgentRows = await tx.queryAll(`
          SELECT agent_id
          FROM social_account_bindings
          WHERE tenant_id = $1
            AND social_account_id = $2
            AND status = 'current'
          ORDER BY agent_id
        `, [req.tenantId, accountId]);
        const affectedAgentIds = Array.from(new Set([
          ...normalizedAgents.agentIds,
          ...currentAgentRows.map(row => String(row.agent_id)),
        ])).sort();
        for (const affectedAgentId of affectedAgentIds) {
          await lockCaptureAgentExecutionSlot(
            tx,
            req.tenantId,
            affectedAgentId,
          );
        }
        const account = await tx.queryOne(`
          SELECT id, platform
          FROM social_accounts
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `, [accountId, req.tenantId]);
        if (!account) return {accountNotFound: true};

        const agents = normalizedAgents.agentIds.length > 0
          ? await tx.queryAll(`
              SELECT id, allowed_platforms
              FROM capture_agents
              WHERE tenant_id = $1
                AND id = ANY($2::uuid[])
                AND status IN ('active', 'paused')
              ORDER BY id
              FOR UPDATE
            `, [req.tenantId, normalizedAgents.agentIds])
          : [];
        if (agents.length !== normalizedAgents.agentIds.length) {
          return {agentNotFound: true};
        }
        const unsupportedAgent = agents.find(agent =>
          Array.isArray(agent.allowed_platforms) &&
          agent.allowed_platforms.length > 0 &&
          !agent.allowed_platforms.includes(account.platform),
        );
        if (unsupportedAgent) return {unsupportedAgent: true};

        await tx.execute(`
          UPDATE social_accounts
          SET agent_binding_mode = $1,
            updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [bindingMode, account.id, req.tenantId]);

        const bindingSource = bindingMode === 'manual'
          ? 'manual'
          : 'extension';
        await tx.execute(`
          UPDATE social_account_bindings
          SET status = 'historical',
            ended_at = now(),
            metadata = metadata || jsonb_build_object(
              'bindingModeAtUnbind', $5::text,
              'bindingChangedAt', now()
            ),
            updated_at = now()
          WHERE tenant_id = $1
            AND social_account_id = $2
            AND platform = $3
            AND status = 'current'
            AND NOT (agent_id = ANY($4::uuid[]))
        `, [
          req.tenantId,
          account.id,
          account.platform,
          normalizedAgents.agentIds,
          bindingMode,
        ]);

        for (const agentId of normalizedAgents.agentIds) {
          const bound = await bindAccountToAgent(tx, {
            tenantId: req.tenantId,
            accountId: account.id,
            platform: account.platform,
            agentId,
            source: bindingSource,
          });
          if (bound.notFound) return {agentNotFound: true};
        }

        const bindings = await tx.queryAll(`
          SELECT id, agent_id, social_account_id, platform, status, source
          FROM social_account_bindings
          WHERE tenant_id = $1
            AND social_account_id = $2
            AND status = 'current'
          ORDER BY first_seen_at, id
        `, [req.tenantId, account.id]);
        return {bindings, bindingMode};
      });
      if (result.accountNotFound) {
        return res.status(404).json({
          ok: false,
          error: 'social_account_not_found',
          message: '社交账号不存在',
        });
      }
      if (result.agentNotFound) {
        return res.status(404).json({
          ok: false,
          error: 'agent_not_found',
          message: '部分执行节点不存在或已撤销',
        });
      }
      if (result.unsupportedAgent) {
        return res.status(409).json({
          ok: false,
          error: 'agent_platform_unsupported',
          message: '所选 Agent 不支持该账号平台',
        });
      }
      return res.json({ok: true, ...result});
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  '/bindings/:id',
  requireTenantAccess,
  requireSessionUser,
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const bindingId = uuid(req.params.id);
      if (!bindingId) return sendInvalidId(res, '绑定');
      const binding = await withTransaction(async tx => {
        const candidate = await tx.queryOne(`
          SELECT id, agent_id, social_account_id
          FROM social_account_bindings
          WHERE id = $1 AND tenant_id = $2 AND status = 'current'
        `, [bindingId, req.tenantId]);
        if (!candidate) return null;
        await lockCaptureAgentExecutionSlot(
          tx,
          req.tenantId,
          candidate.agent_id,
        );
        await tx.queryOne(`
          SELECT id
          FROM social_accounts
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `, [candidate.social_account_id, req.tenantId]);
        const current = await tx.queryOne(`
          SELECT id, social_account_id
          FROM social_account_bindings
          WHERE id = $1 AND tenant_id = $2 AND status = 'current'
          FOR UPDATE
        `, [bindingId, req.tenantId]);
        if (!current) return null;
        await tx.execute(`
          UPDATE social_accounts
          SET agent_binding_mode = 'manual', updated_at = now()
          WHERE id = $1 AND tenant_id = $2
        `, [current.social_account_id, req.tenantId]);
        return await tx.queryOne(`
          UPDATE social_account_bindings
          SET status = 'historical',
            ended_at = now(),
            metadata = metadata || jsonb_build_object(
              'bindingModeAtUnbind', 'manual',
              'bindingChangedAt', now()
            ),
            updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'current'
          RETURNING id
        `, [bindingId, req.tenantId]);
      });
      if (!binding) {
        return res.status(404).json({
          ok: false,
          error: 'binding_not_found',
          message: '当前账号绑定不存在',
        });
      }
      return res.json({ok: true, bindingId: binding.id});
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
