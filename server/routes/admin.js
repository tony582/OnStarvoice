import { Router } from 'express';
import { queryAll, queryOne, execute, withTransaction, getAllSettings, setSettings, getDefaultTenantId } from '../db/init.js';
import { requireAdmin, requirePlatformAdmin } from '../middleware/auth.js';
import { serializeRecords } from '../services/record-store.js';
import { hashPassword, normalizeEmail } from '../services/auth-service.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(requireAdmin);

function validGlobalRole(role) {
  return ['', 'platform_admin', 'internal_operator'].includes(role || '');
}

function validTenantRole(role) {
  return ['tenant_admin', 'tenant_analyst', 'tenant_viewer'].includes(role || '');
}

router.get('/tenants', async (req, res, next) => {
  try {
    const tenants = await queryAll('SELECT * FROM tenants ORDER BY created_at DESC');
    return res.json({ ok: true, tenants });
  } catch (err) {
    return next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const users = await queryAll(`
      SELECT
        u.id, u.email, u.name, u.status, u.is_internal, u.global_role,
        u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', um.id,
              'tenantId', um.tenant_id,
              'tenantName', t.name,
              'role', um.role,
              'status', um.status
            )
          ) FILTER (WHERE um.id IS NOT NULL),
          '[]'::json
        ) AS memberships
      FROM users u
      LEFT JOIN user_memberships um ON um.user_id = u.id
      LEFT JOIN tenants t ON t.id = um.tenant_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    return res.json({ ok: true, users });
  } catch (err) {
    return next(err);
  }
});

router.post('/users', requirePlatformAdmin, async (req, res, next) => {
  try {
    const {
      email,
      name = '',
      password = '',
      isInternal = false,
      globalRole = '',
      tenantId = '',
      role = 'tenant_viewer',
    } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: '邮箱和初始密码不能为空' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, error: 'weak_password', message: '初始密码至少 8 位' });
    }
    if (!validGlobalRole(globalRole)) {
      return res.status(400).json({ ok: false, error: 'invalid_role', message: '全局角色不合法' });
    }
    if (!isInternal && (!tenantId || !validTenantRole(role))) {
      return res.status(400).json({ ok: false, error: 'invalid_membership', message: '客户账号必须选择租户和角色' });
    }

    const result = await withTransaction(async tx => {
      const user = await tx.queryOne(`
        INSERT INTO users (email, name, password_hash, status, is_internal, global_role, must_change_password)
        VALUES ($1, $2, $3, 'active', $4, $5, true)
        RETURNING id
      `, [normalizedEmail, name || normalizedEmail, hashPassword(password), Boolean(isInternal), isInternal ? globalRole : '']);

      if (tenantId) {
        await tx.execute(`
          INSERT INTO user_memberships (user_id, tenant_id, role, status)
          VALUES ($1, $2, $3, 'active')
          ON CONFLICT (user_id, tenant_id)
          DO UPDATE SET role = excluded.role, status = 'active', updated_at = now()
        `, [user.id, tenantId, role]);
      }
      await tx.execute(`
        INSERT INTO password_events (user_id, actor_id, event_type, metadata)
        VALUES ($1, $2, 'created', $3::jsonb)
      `, [user.id, req.user.id, JSON.stringify({ email: normalizedEmail })]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $2, 'user.created', 'user', $3, $4::jsonb)
      `, [tenantId || null, req.user.id, user.id, JSON.stringify({ email: normalizedEmail, isInternal: Boolean(isInternal), globalRole, role })]);
      return user;
    });

    return res.json({ ok: true, id: result.id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'email_exists', message: '邮箱已存在' });
    }
    return next(err);
  }
});

router.patch('/users/:id', requirePlatformAdmin, async (req, res, next) => {
  try {
    const { status, name, isInternal, globalRole, tenantId, role, membershipStatus } = req.body || {};
    if (globalRole !== undefined && !validGlobalRole(globalRole)) {
      return res.status(400).json({ ok: false, error: 'invalid_role', message: '全局角色不合法' });
    }
    if (role !== undefined && !validTenantRole(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role', message: '租户角色不合法' });
    }

    const result = await withTransaction(async tx => {
      const updates = [];
      const params = [];
      const add = (field, value) => {
        params.push(value);
        updates.push(`${field} = $${params.length}`);
      };
      if (status !== undefined) add('status', status);
      if (name !== undefined) add('name', name);
      if (isInternal !== undefined) add('is_internal', Boolean(isInternal));
      if (globalRole !== undefined) add('global_role', globalRole);
      if (updates.length) {
        updates.push('updated_at = now()');
        params.push(req.params.id);
        await tx.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
      }

      if (tenantId && role) {
        await tx.execute(`
          INSERT INTO user_memberships (user_id, tenant_id, role, status)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, tenant_id)
          DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = now()
        `, [req.params.id, tenantId, role, membershipStatus || 'active']);
      } else if (tenantId && membershipStatus) {
        await tx.execute(
          'UPDATE user_memberships SET status = $1, updated_at = now() WHERE user_id = $2 AND tenant_id = $3',
          [membershipStatus, req.params.id, tenantId]
        );
      }

      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $2, 'user.updated', 'user', $3, $4::jsonb)
      `, [tenantId || null, req.user.id, req.params.id, JSON.stringify(req.body || {})]);
      return true;
    });
    return res.json({ ok: result });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id/reset-password', requirePlatformAdmin, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'weak_password', message: '新密码至少 8 位' });
    }
    const result = await withTransaction(async tx => {
      const updated = await tx.queryOne(`
        UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now()
        WHERE id = $2
        RETURNING id
      `, [hashPassword(password), req.params.id]);
      if (!updated) return null;
      await tx.execute(`
        UPDATE user_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL
      `, [req.params.id]);
      await tx.execute(`
        INSERT INTO password_events (user_id, actor_id, event_type, metadata)
        VALUES ($1, $2, 'reset', '{}'::jsonb)
      `, [req.params.id, req.user.id]);
      await tx.execute(`
        INSERT INTO audit_logs (actor_type, actor_id, actor_user_id, action, target_type, target_id)
        VALUES ('user', $1, $1, 'user.password_reset', 'user', $2)
      `, [req.user.id, req.params.id]);
      return updated;
    });
    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '用户不存在' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/auth-codes', async (req, res, next) => {
  try {
    const codes = await queryAll(`
      SELECT ac.*, t.name AS tenant_name,
        (SELECT COUNT(*) FROM auth_bindings ab WHERE ab.code_id = ac.id) as binding_count
      FROM auth_codes ac
      JOIN tenants t ON t.id = ac.tenant_id
      ORDER BY ac.created_at DESC
    `);
    return res.json({ ok: true, codes });
  } catch (err) {
    return next(err);
  }
});

router.post('/auth-codes', async (req, res, next) => {
  try {
    const { type = 'trial', ownerEmail = '', ownerName = '', maxBindings = 3, durationDays, notes = '', tenantId } = req.body;
    const resolvedTenantId = tenantId || await getDefaultTenantId();
    const code = `OSV-${type.toUpperCase().slice(0, 1)}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const expiresAt = new Date();
    if (type === 'trial') expiresAt.setDate(expiresAt.getDate() + (durationDays || 7));
    else if (type === 'annual') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setFullYear(expiresAt.getFullYear() + 100);

    const result = await execute(`
      INSERT INTO auth_codes (tenant_id, code, type, owner_email, owner_name, max_bindings, expires_at, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [resolvedTenantId, code, type, ownerEmail, ownerName, maxBindings, expiresAt.toISOString(), notes]);
    return res.json({ ok: true, id: result.lastInsertRowid, code, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    return next(err);
  }
});

router.patch('/auth-codes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, ownerEmail, ownerName, maxBindings, expiresAt, notes } = req.body;
    const updates = [];
    const params = [];
    const add = (field, value) => {
      params.push(value);
      updates.push(`${field} = $${params.length}`);
    };
    if (status !== undefined) add('status', status);
    if (ownerEmail !== undefined) add('owner_email', ownerEmail);
    if (ownerName !== undefined) add('owner_name', ownerName);
    if (maxBindings !== undefined) add('max_bindings', maxBindings);
    if (expiresAt !== undefined) add('expires_at', expiresAt);
    if (notes !== undefined) add('notes', notes);
    if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
    params.push(id);
    const result = await execute(`UPDATE auth_codes SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    return res.json({ ok: result.rowCount > 0 });
  } catch (err) {
    return next(err);
  }
});

router.post('/auth-codes/:id/renew', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { durationDays = 365 } = req.body;
    const code = await queryOne('SELECT * FROM auth_codes WHERE id = $1', [id]);
    if (!code) return res.json({ ok: false, message: '激活码不存在' });
    const baseDate = code.expires_at && new Date(code.expires_at) > new Date()
      ? new Date(code.expires_at) : new Date();
    baseDate.setDate(baseDate.getDate() + durationDays);
    await execute("UPDATE auth_codes SET expires_at = $1, status = 'active' WHERE id = $2", [baseDate.toISOString(), id]);
    return res.json({ ok: true, newExpiresAt: baseDate.toISOString() });
  } catch (err) {
    return next(err);
  }
});

router.get('/auth-codes/:id/bindings', async (req, res, next) => {
  try {
    const bindings = await queryAll(
      'SELECT * FROM auth_bindings WHERE code_id = $1 ORDER BY last_seen_at DESC',
      [req.params.id]
    );
    return res.json({ ok: true, bindings });
  } catch (err) {
    return next(err);
  }
});

router.delete('/auth-codes/:id/bindings/:bindingId', async (req, res, next) => {
  try {
    await execute('DELETE FROM auth_bindings WHERE id = $1 AND code_id = $2', [req.params.bindingId, req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/records', async (req, res, next) => {
  try {
    const { platform, sentiment, category, keyword, page = 1, pageSize = 50, startDate, endDate, sort = 'created_at', order = 'DESC' } = req.query;
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];

    let where = ' WHERE 1=1';
    const params = [];
    if (tenantId) { params.push(tenantId); where += ` AND tenant_id = $${params.length}`; }
    if (platform) { params.push(platform); where += ` AND platform = $${params.length}`; }
    if (sentiment) { params.push(sentiment); where += ` AND sentiment = $${params.length}`; }
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    if (keyword) {
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      where += ` AND (title ILIKE $${params.length - 2} OR content ILIKE $${params.length - 1} OR keyword ILIKE $${params.length})`;
    }
    if (startDate) { params.push(startDate); where += ` AND created_at >= $${params.length}`; }
    if (endDate) { params.push(endDate); where += ` AND created_at <= $${params.length}`; }

    const total = (await queryOne(`SELECT COUNT(*) as total FROM records${where}`, params)).total;

    const allowedSorts = ['created_at', 'last_seen_at', 'likes', 'comments_count', 'collects', 'shares', 'seen_count'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const limit = Math.min(200, Math.max(1, Number(pageSize)));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const records = await queryAll(
      `SELECT * FROM records${where} ORDER BY ${sortCol} ${sortOrder} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      ok: true,
      records: serializeRecords(records),
      pagination: { page: Number(page), pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const { days = 7 } = req.query;
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
    const since = new Date();
    since.setDate(since.getDate() - Number(days));
    const sinceStr = since.toISOString();
    const tenantWhere = tenantId ? ' AND tenant_id = $2' : '';
    const tenantParams = tenantId ? [sinceStr, tenantId] : [sinceStr];

    const totalRecords = (await queryOne(
      `SELECT COUNT(*) as n FROM records WHERE 1=1${tenantId ? ' AND tenant_id = $1' : ''}`,
      tenantId ? [tenantId] : []
    )).n;
    const recentRecords = (await queryOne(
      `SELECT COUNT(*) as n FROM records WHERE created_at >= $1${tenantWhere}`,
      tenantParams
    )).n;
    const sentimentDist = await queryAll(
      `SELECT sentiment, COUNT(*) as count FROM records WHERE created_at >= $1 AND sentiment <> ''${tenantWhere} GROUP BY sentiment`,
      tenantParams
    );
    const categoryDist = await queryAll(
      `SELECT category, COUNT(*) as count FROM records WHERE created_at >= $1 AND category <> ''${tenantWhere} GROUP BY category ORDER BY count DESC`,
      tenantParams
    );
    const platformDist = await queryAll(
      `SELECT platform, COUNT(*) as count FROM records WHERE created_at >= $1${tenantWhere} GROUP BY platform`,
      tenantParams
    );
    const recentAlerts = await queryAll(
      `SELECT level, COUNT(*) as count FROM alerts WHERE created_at >= $1${tenantWhere} GROUP BY level`,
      tenantParams
    );
    const topInteraction = await queryAll(
      `SELECT id, title, url, platform, likes, comments_count, collects, shares, sentiment, author_name
       FROM records
       WHERE created_at >= $1${tenantWhere}
       ORDER BY (likes + comments_count + collects + shares) DESC
       LIMIT 10`,
      tenantParams
    );
    const activeCodes = (await queryOne("SELECT COUNT(*) as n FROM auth_codes WHERE status = 'active'")).n;
    const openIssues = (await queryOne(
      `SELECT COUNT(*) as n FROM issues WHERE status NOT IN ('resolved', 'closed', 'ignored')${tenantId ? ' AND tenant_id = $1' : ''}`,
      tenantId ? [tenantId] : []
    )).n;

    return res.json({
      ok: true,
      stats: { totalRecords, recentRecords, sentimentDist, categoryDist, platformDist, recentAlerts, topInteraction, activeCodes, openIssues },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const { level, limit = 100 } = req.query;
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
    const params = [];
    let sql = `
      SELECT a.*, r.title as record_title, r.url as record_url, r.platform, i.status as issue_status
      FROM alerts a
      LEFT JOIN records r ON a.record_id = r.id
      LEFT JOIN issues i ON a.issue_id = i.id
      WHERE 1=1
    `;
    if (tenantId) { params.push(tenantId); sql += ` AND a.tenant_id = $${params.length}`; }
    if (level) { params.push(level); sql += ` AND a.level = $${params.length}`; }
    params.push(Number(limit));
    sql += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
    return res.json({ ok: true, alerts: await queryAll(sql, params) });
  } catch (err) {
    return next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || await getDefaultTenantId();
    const settings = await getAllSettings(tenantId);
    const masked = { ...settings };
    if (masked.llm_api_key) masked.llm_api_key = masked.llm_api_key.slice(0, 8) + '***';
    if (masked.smtp_pass) masked.smtp_pass = '***';
    return res.json({ ok: true, settings: masked, raw: settings, tenantId });
  } catch (err) {
    return next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || req.body.tenantId || await getDefaultTenantId();
    const { tenantId: _tenantId, ...settings } = req.body || {};
    await setSettings(settings, tenantId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/official-accounts', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || await getDefaultTenantId();
    const accounts = await queryAll(
      'SELECT * FROM official_accounts WHERE tenant_id = $1 AND status <> $2 ORDER BY platform, account_name',
      [tenantId, 'deleted']
    );
    return res.json({ ok: true, accounts, tenantId });
  } catch (err) {
    return next(err);
  }
});

router.put('/official-accounts', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || req.body?.tenantId || await getDefaultTenantId();
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    await withTransaction(async tx => {
      await tx.execute('DELETE FROM official_accounts WHERE tenant_id = $1', [tenantId]);
      for (const item of accounts) {
        const platform = String(item?.platform || '').trim();
        const accountName = String(item?.accountName || item?.account_name || '').trim();
        if (!platform || !accountName) continue;
        const aliases = Array.isArray(item?.aliases)
          ? item.aliases.map(alias => String(alias || '').trim()).filter(Boolean)
          : String(item?.aliases || '').split(',').map(alias => alias.trim()).filter(Boolean);
        await tx.execute(`
          INSERT INTO official_accounts (
            tenant_id, platform, account_name, account_id, profile_url, aliases, skip_content, status
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active')
        `, [
          tenantId,
          platform,
          accountName,
          String(item?.accountId || item?.account_id || '').trim(),
          String(item?.profileUrl || item?.profile_url || '').trim(),
          JSON.stringify(aliases),
          item?.skipContent !== false,
        ]);
      }
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $3, 'official_accounts.updated', 'tenant', $4, $5::jsonb)
      `, [tenantId, req.user?.id || '', req.user?.id || null, String(tenantId), JSON.stringify({ count: accounts.length })]);
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// 回溯重标:把历史上作者命中官方账号(精确名/别名/ID,且 skip_content)的内容
// 标为 official_content,使其退出舆情监测队列。匹配规则与 comment-workflow 的 matchesOfficialAccount 对齐。
router.post('/official-accounts/reclassify', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || req.body?.tenantId || await getDefaultTenantId();
    // 命中官方账号的 SQL 谓词(精确名/别名/ID,对齐 comment-workflow.matchesOfficialAccount)
    const matchSql = (rowAlias) => `EXISTS (
      SELECT 1 FROM official_accounts oa
      WHERE oa.tenant_id = ${rowAlias}.tenant_id AND oa.status = 'active'
        AND (COALESCE(oa.platform, '') = '' OR oa.platform = ${rowAlias}.platform)
        AND (
          (COALESCE(oa.account_id, '') <> '' AND oa.account_id = ${rowAlias}.author_id)
          OR oa.account_name = ${rowAlias}.author_name
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(oa.aliases) alias WHERE alias = ${rowAlias}.author_name)
        )
    )`;

    // ① 官方"发文" → official_content,退出舆情监测
    const excluded = (await execute(`
      UPDATE records r SET record_type = 'official_content', updated_at = now()
      WHERE r.tenant_id = $1 AND COALESCE(r.record_type, '') <> 'official_content'
        AND EXISTS (
          SELECT 1 FROM official_accounts oa
          WHERE oa.tenant_id = r.tenant_id AND oa.status = 'active' AND oa.skip_content = true
            AND (COALESCE(oa.platform,'')='' OR oa.platform = r.platform)
            AND ((COALESCE(oa.account_id,'')<>'' AND oa.account_id=r.author_id)
              OR oa.account_name=r.author_name
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(oa.aliases) a WHERE a=r.author_name))
        )
    `, [tenantId]))?.rowCount ?? 0;

    // ② 官方"回复评论" → 标记 is_official(中性,不计负面/客资)
    const officialReplies = (await execute(`
      UPDATE record_comments c
      SET is_official = true, is_negative = false, sentiment = 'neutral', risk_level = 'none', updated_at = now()
      WHERE c.tenant_id = $1 AND c.is_official IS DISTINCT FROM true AND ${matchSql('c')}
    `, [tenantId]))?.rowCount ?? 0;

    // ③ 为官方回复补 official_responses(供详情页"官方响应"展示;每条评论一条,去重)
    await execute(`
      INSERT INTO official_responses (tenant_id, record_id, comment_id, official_account_id, platform, account_id, account_name, content, published_at, content_hash)
      SELECT DISTINCT ON (c.id) c.tenant_id, c.record_id, c.id, oa.id, c.platform, c.author_id,
        COALESCE(NULLIF(c.author_name,''), oa.account_name), c.content, c.published_at, md5(c.id::text)
      FROM record_comments c
      JOIN official_accounts oa ON oa.tenant_id = c.tenant_id AND oa.status = 'active'
        AND (COALESCE(oa.platform,'')='' OR oa.platform = c.platform)
        AND ((COALESCE(oa.account_id,'')<>'' AND oa.account_id=c.author_id)
          OR oa.account_name=c.author_name
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(oa.aliases) a WHERE a=c.author_name))
      WHERE c.tenant_id = $1 AND c.is_official = true
        AND NOT EXISTS (SELECT 1 FROM official_responses orr WHERE orr.tenant_id = c.tenant_id AND orr.comment_id = c.id)
      ORDER BY c.id, oa.id
    `, [tenantId]);

    // ④ 把"被官方回复过"的内容标记状态(还有负面→需跟进,否则已响应)
    const repliedRecords = (await execute(`
      UPDATE records r
      SET official_replied = true,
        official_response_status = CASE WHEN r.negative_comment_count > 0 THEN 'needs_followup' ELSE 'responded' END,
        updated_at = now()
      WHERE r.tenant_id = $1 AND COALESCE(r.record_type,'') <> 'official_content'
        AND EXISTS (SELECT 1 FROM record_comments c WHERE c.tenant_id = r.tenant_id AND c.record_id = r.id AND c.is_official = true)
    `, [tenantId]))?.rowCount ?? 0;

    await execute(`
      INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES ($1, 'user', $2, $3, 'official_accounts.reclassified', 'tenant', $4, $5::jsonb)
    `, [tenantId, req.user?.id || '', req.user?.id || null, String(tenantId), JSON.stringify({ excluded, officialReplies, repliedRecords })]);

    return res.json({ ok: true, updated: excluded, excluded, officialReplies, repliedRecords });
  } catch (err) {
    return next(err);
  }
});

router.post('/login', (req, res) => {
  return res.json({ ok: true, message: '登录成功' });
});

export default router;
