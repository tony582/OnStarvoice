import { Router } from 'express';
import { queryAll, queryOne, execute, withTransaction, getAllSettings, setSettings, getDefaultTenantId } from '../db/init.js';
import { requireAdmin, requirePlatformAdmin } from '../middleware/auth.js';
import { serializeRecords } from '../services/record-store.js';
import { hashPassword, normalizeEmail } from '../services/auth-service.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(requireAdmin);

const AUTH_CODE_TYPES = new Set(['trial', 'annual', 'permanent']);
const AUTH_CODE_STATUSES = new Set(['active', 'expired', 'frozen']);
const MAX_AUTH_CODE_BINDINGS = 10000;

class AuthCodeValidationError extends Error {
  constructor(message, error = 'invalid_request') {
    super(message);
    this.name = 'AuthCodeValidationError';
    this.error = error;
  }
}

class AuthCodeConflictError extends Error {
  constructor(message, error = 'binding_limit_below_usage') {
    super(message);
    this.name = 'AuthCodeConflictError';
    this.error = error;
  }
}

function parseAuthCodeMaxBindings(value, fallback = 3) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUTH_CODE_BINDINGS) {
    throw new AuthCodeValidationError(`设备上限必须是 1-${MAX_AUTH_CODE_BINDINGS} 的整数`, 'invalid_max_bindings');
  }
  return parsed;
}

function parseAuthCodeDurationDays(value, fallback = 7) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 36500) {
    throw new AuthCodeValidationError('有效天数必须是 1-36500 的整数', 'invalid_duration_days');
  }
  return parsed;
}

function parseAuthCodeExpiry(value, { allowNull = false } = {}) {
  if (value === null || String(value ?? '').trim() === '') {
    if (allowNull) return null;
    throw new AuthCodeValidationError('请选择有效的到期日', 'invalid_expires_at');
  }

  const raw = String(value).trim();
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    // 手工选择的是自然日：按北京时间当天 23:59:59 到期，而不是当天 00:00。
    ? new Date(`${raw}T23:59:59.999+08:00`)
    : new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new AuthCodeValidationError('到期日格式不正确', 'invalid_expires_at');
  }
  return expiresAt;
}

function defaultAuthCodeExpiry(type, durationDays) {
  if (type === 'permanent') return null;
  const expiresAt = new Date();
  if (type === 'trial') {
    const days = durationDays === undefined
      ? 7
      : parseAuthCodeDurationDays(durationDays);
    expiresAt.setDate(expiresAt.getDate() + days);
  } else {
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  }
  return expiresAt;
}

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

// 新建租户(= 一个客户)。复制默认租户设置,使新客户开箱即用。
router.post('/tenants', requirePlatformAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: '租户名称不能为空' });
    }
    const defaultTenantId = await getDefaultTenantId();
    const tenant = await withTransaction(async tx => {
      const created = await tx.queryOne(
        'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, status, created_at',
        [name]
      );
      // 把默认租户(OnStar)的设置整套复制给新租户:LLM / SMTP / 阈值 / 报表计划等
      await tx.execute(
        `INSERT INTO tenant_settings (tenant_id, key, value)
         SELECT $1, key, value
         FROM tenant_settings
         WHERE tenant_id = $2
           -- 人工安全验证通知属于客户自己的收件地址，绝不能继承默认租户。
           AND key <> 'capture_attention_email_to'`,
        [created.id, defaultTenantId]
      );
      await tx.execute(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata)
         VALUES ($1::uuid, 'user', $2::text, 'tenant.created', 'tenant', $3::text, $4::jsonb)`,
        [created.id, String(req.user.id), String(created.id), JSON.stringify({ name })]
      );
      return created;
    });
    return res.json({ ok: true, tenant });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'tenant_exists', message: '同名租户已存在' });
    }
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
        VALUES ($1::uuid, 'user', $2::text, $3::uuid, 'user.created', 'user', $4::text, $5::jsonb)
      `, [tenantId || null, String(req.user.id), req.user.id, String(user.id), JSON.stringify({ email: normalizedEmail, isInternal: Boolean(isInternal), globalRole, role })]);
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
        VALUES ($1::uuid, 'user', $2::text, $3::uuid, 'user.updated', 'user', $4::text, $5::jsonb)
      `, [tenantId || null, String(req.user.id), req.user.id, String(req.params.id), JSON.stringify(req.body || {})]);
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
        VALUES ('user', $1::text, $2::uuid, 'user.password_reset', 'user', $3::text)
      `, [String(req.user.id), req.user.id, req.params.id]);
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
    const body = req.body || {};
    const {
      type = 'trial',
      ownerEmail = '',
      ownerName = '',
      maxBindings = 3,
      durationDays,
      notes = '',
      tenantId,
    } = body;
    if (!AUTH_CODE_TYPES.has(type)) {
      throw new AuthCodeValidationError('激活码类型不合法', 'invalid_auth_code_type');
    }
    const normalizedMaxBindings = parseAuthCodeMaxBindings(maxBindings);
    const hasManualExpiry = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
    const expiresAt = type === 'permanent'
      ? null
      : hasManualExpiry
        ? parseAuthCodeExpiry(body.expiresAt)
        : defaultAuthCodeExpiry(type, durationDays);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AuthCodeValidationError('到期日必须是今天或未来日期', 'invalid_expires_at');
    }

    const resolvedTenantId = tenantId || await getDefaultTenantId();
    const code = `OSV-${type.toUpperCase().slice(0, 1)}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const result = await execute(`
      INSERT INTO auth_codes (tenant_id, code, type, owner_email, owner_name, max_bindings, expires_at, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      resolvedTenantId,
      code,
      type,
      String(ownerEmail || '').trim(),
      String(ownerName || '').trim(),
      normalizedMaxBindings,
      expiresAt?.toISOString() || null,
      String(notes || '').trim(),
    ]);
    return res.json({
      ok: true,
      id: result.lastInsertRowid,
      code,
      maxBindings: normalizedMaxBindings,
      expiresAt: expiresAt?.toISOString() || null,
    });
  } catch (err) {
    if (err instanceof AuthCodeValidationError) {
      return res.status(400).json({ ok: false, error: err.error, message: err.message });
    }
    return next(err);
  }
});

router.patch('/auth-codes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const { status, ownerEmail, ownerName, maxBindings, notes } = body;
    if (status !== undefined && !AUTH_CODE_STATUSES.has(status)) {
      throw new AuthCodeValidationError('激活码状态不合法', 'invalid_auth_code_status');
    }
    const normalizedMaxBindings = maxBindings === undefined
      ? undefined
      : parseAuthCodeMaxBindings(maxBindings);
    const hasExpiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
    const normalizedExpiresAt = hasExpiresAt
      ? parseAuthCodeExpiry(body.expiresAt, { allowNull: true })
      : undefined;
    if (normalizedExpiresAt && normalizedExpiresAt.getTime() <= Date.now()) {
      throw new AuthCodeValidationError('到期日必须是今天或未来日期', 'invalid_expires_at');
    }

    const updated = await withTransaction(async tx => {
      const code = await tx.queryOne(
        'SELECT id, type, status FROM auth_codes WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!code) return null;
      if (hasExpiresAt && normalizedExpiresAt === null && code.type !== 'permanent') {
        throw new AuthCodeValidationError('试用或年付激活码必须设置到期日', 'invalid_expires_at');
      }

      if (normalizedMaxBindings !== undefined) {
        const bindingCount = Number((await tx.queryOne(
          'SELECT COUNT(*) AS count FROM auth_bindings WHERE code_id = $1',
          [id]
        ))?.count || 0);
        if (normalizedMaxBindings < bindingCount) {
          throw new AuthCodeConflictError(`设备上限不能低于当前已绑定数量 ${bindingCount}`);
        }
      }

      const updates = [];
      const params = [];
      const add = (field, value) => {
        params.push(value);
        updates.push(`${field} = $${params.length}`);
      };
      if (status !== undefined) add('status', status);
      if (ownerEmail !== undefined) add('owner_email', String(ownerEmail || '').trim());
      if (ownerName !== undefined) add('owner_name', String(ownerName || '').trim());
      if (normalizedMaxBindings !== undefined) add('max_bindings', normalizedMaxBindings);
      if (hasExpiresAt) {
        add('expires_at', normalizedExpiresAt?.toISOString() || null);
        // 管理员把到期日延后或改为永久时，自动恢复可用状态。
        if (status === undefined) add('status', 'active');
      }
      if (notes !== undefined) add('notes', String(notes || '').trim());
      if (updates.length === 0) {
        throw new AuthCodeValidationError('没有要更新的字段');
      }
      params.push(id);
      return tx.queryOne(
        `UPDATE auth_codes
         SET ${updates.join(', ')}
         WHERE id = $${params.length}
         RETURNING id, status, max_bindings, expires_at`,
        params
      );
    });
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'not_found', message: '激活码不存在' });
    }
    return res.json({ ok: true, authCode: updated });
  } catch (err) {
    if (err instanceof AuthCodeValidationError) {
      return res.status(400).json({ ok: false, error: err.error, message: err.message });
    }
    if (err instanceof AuthCodeConflictError) {
      return res.status(409).json({ ok: false, error: err.error, message: err.message });
    }
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
    if (settings.smtp_pass === '***') delete settings.smtp_pass;
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

function officialAccountText(value) {
  return String(value ?? '').trim();
}

function officialAccountAliases(value) {
  const aliases = Array.isArray(value)
    ? value
    : officialAccountText(value).split(',');
  return [...new Set(aliases.map(officialAccountText).filter(Boolean))];
}

function normalizeOfficialAccountInput(item = {}) {
  const hasAliases = Object.prototype.hasOwnProperty.call(item, 'aliases');
  return {
    id: officialAccountText(item.id),
    platform: officialAccountText(item.platform),
    accountName: officialAccountText(item.accountName || item.account_name),
    platformUserId: officialAccountText(item.platformUserId || item.platform_user_id),
    accountNo: officialAccountText(item.accountNo || item.account_no),
    legacyAccountId: officialAccountText(item.accountId || item.account_id),
    profileUrl: officialAccountText(item.profileUrl || item.profile_url),
    aliases: officialAccountAliases(item.aliases),
    hasAliases,
    skipContent: (item.skipContent ?? item.skip_content) !== false,
    status: ['active', 'disabled'].includes(officialAccountText(item.status))
      ? officialAccountText(item.status)
      : 'active',
  };
}

async function findOfficialAccountForAdminUpdate(tx, tenantId, input) {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(input.id)
  ) {
    const byId = await tx.queryOne(`
      SELECT *
      FROM official_accounts
      WHERE id = $1::uuid AND tenant_id = $2
      LIMIT 1
      FOR UPDATE
    `, [input.id, tenantId]);
    if (byId) return byId;
  }
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
    input.platform,
    input.platformUserId,
    input.accountNo,
    input.legacyAccountId,
    input.profileUrl,
    input.accountName,
  ]);
}

function officialAccountMonitorKeyword(account = {}) {
  return officialAccountText(
    account.platform_user_id ||
    account.account_no ||
    account.account_id ||
    account.account_name
  );
}

async function syncOfficialAccountMonitorSubscription(tx, tenantId, account) {
  if (!account?.id) return null;

  const profileUrl = officialAccountText(account.profile_url);
  const accountStatus = officialAccountText(account.status);
  const targetStatus = accountStatus === 'deleted'
    ? 'deleted'
    : accountStatus === 'active'
      ? 'active'
      : 'paused';
  let subscription = await tx.queryOne(`
    SELECT *
    FROM monitor_subscriptions
    WHERE tenant_id = $1
      AND subject_type = 'official'
      AND official_account_id = $2
    ORDER BY status = 'deleted', created_at DESC
    LIMIT 1
    FOR UPDATE
  `, [tenantId, account.id]);

  // Legacy official-account records may already have an unlinked monitor row.
  // A profile URL is a strong identity; account names are deliberately excluded.
  if (!subscription && profileUrl) {
    subscription = await tx.queryOne(`
      SELECT *
      FROM monitor_subscriptions
      WHERE tenant_id = $1
        AND platform = $2
        AND subject_type = 'official'
        AND account_url = $3
        AND (official_account_id IS NULL OR official_account_id = $4)
      ORDER BY status = 'deleted', created_at DESC
      LIMIT 1
      FOR UPDATE
    `, [tenantId, account.platform, profileUrl, account.id]);
  }

  const keyword = officialAccountMonitorKeyword(account);
  if (subscription) {
    return tx.queryOne(`
      UPDATE monitor_subscriptions
      SET name = $1,
        keyword = $2,
        platform = $3,
        account_url = CASE WHEN $4 <> '' THEN $4 ELSE account_url END,
        status = $5,
        subject_type = 'official',
        official_account_id = $6,
        next_run_at = CASE
          WHEN $5 = 'active' AND status <> 'active' THEN now()
          ELSE next_run_at
        END,
        updated_at = now()
      WHERE id = $7 AND tenant_id = $8
      RETURNING *
    `, [
      account.account_name,
      keyword,
      account.platform,
      profileUrl,
      targetStatus,
      account.id,
      subscription.id,
      tenantId,
    ]);
  }

  if (targetStatus !== 'active' || !profileUrl || !keyword) return null;
  return tx.queryOne(`
    INSERT INTO monitor_subscriptions (
      tenant_id, name, keyword, platform, account_url, cadence_minutes,
      status, notify_on_negative, auth_code, next_run_at, subject_type,
      official_account_id
    ) VALUES (
      $1, $2, $3, $4, $5, 1440,
      'active', true, '', now(), 'official', $6
    )
    RETURNING *
  `, [
    tenantId,
    account.account_name,
    keyword,
    account.platform,
    profileUrl,
    account.id,
  ]);
}

router.put('/official-accounts', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || req.body?.tenantId || await getDefaultTenantId();
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    const savedAccounts = await withTransaction(async tx => {
      const keptIds = [];
      for (const item of accounts) {
        const input = normalizeOfficialAccountInput(item);
        if (!input.platform || !input.accountName) continue;
        const existing = await findOfficialAccountForAdminUpdate(tx, tenantId, input);
        let saved = null;
        if (existing) {
          saved = await tx.queryOne(`
            UPDATE official_accounts
            SET platform = $1,
              account_name = $2,
              platform_user_id = CASE WHEN $3 <> '' THEN $3 ELSE platform_user_id END,
              account_no = CASE WHEN $4 <> '' THEN $4 ELSE account_no END,
              account_id = CASE WHEN $5 <> '' THEN $5 ELSE account_id END,
              profile_url = CASE WHEN $6 <> '' THEN $6 ELSE profile_url END,
              aliases = CASE WHEN $7 THEN $8::jsonb ELSE aliases END,
              skip_content = $9,
              status = $10,
              updated_at = now()
            WHERE id = $11 AND tenant_id = $12
            RETURNING *
          `, [
            input.platform,
            input.accountName,
            input.platformUserId,
            input.accountNo,
            input.legacyAccountId,
            input.profileUrl,
            input.hasAliases,
            JSON.stringify(input.aliases),
            input.skipContent,
            input.status,
            existing.id,
            tenantId,
          ]);
        } else {
          saved = await tx.queryOne(`
            INSERT INTO official_accounts (
              tenant_id, platform, account_name, platform_user_id, account_no,
              account_id, profile_url, aliases, skip_content, status
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
            )
            RETURNING *
          `, [
            tenantId,
            input.platform,
            input.accountName,
            input.platformUserId,
            input.accountNo,
            input.legacyAccountId,
            input.profileUrl,
            JSON.stringify(input.aliases),
            input.skipContent,
            input.status,
          ]);
        }
        if (saved?.id) {
          keptIds.push(saved.id);
          await syncOfficialAccountMonitorSubscription(tx, tenantId, saved);
        }
      }
      if (keptIds.length > 0) {
        await tx.execute(`
          UPDATE official_accounts
          SET status = 'deleted', updated_at = now()
          WHERE tenant_id = $1
            AND NOT (id = ANY($2::uuid[]))
            AND status <> 'deleted'
        `, [tenantId, keptIds]);
      } else {
        await tx.execute(`
          UPDATE official_accounts
          SET status = 'deleted', updated_at = now()
          WHERE tenant_id = $1 AND status <> 'deleted'
        `, [tenantId]);
      }
      await tx.execute(`
        UPDATE monitor_subscriptions AS subscription
        SET status = 'deleted',
          updated_at = now()
        FROM official_accounts AS account
        WHERE account.id = subscription.official_account_id
          AND account.tenant_id = $1
          AND subscription.tenant_id = $1
          AND subscription.subject_type = 'official'
          AND account.status = 'deleted'
          AND subscription.status <> 'deleted'
      `, [tenantId]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $3, 'official_accounts.updated', 'tenant', $4, $5::jsonb)
      `, [
        tenantId,
        req.user?.id || '',
        req.user?.id || null,
        String(tenantId),
        JSON.stringify({ count: keptIds.length }),
      ]);
      return keptIds;
    });
    return res.json({ ok: true, count: savedAccounts.length });
  } catch (err) {
    return next(err);
  }
});

// 回溯重标:官方发文只接受强身份匹配；官方评论仅兼容双方均无强身份的旧名称数据。
router.post('/official-accounts/reclassify', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || req.body?.tenantId || await getDefaultTenantId();
    const commentAuthorMatchSql = (rowAlias, officialAlias = 'oa') => `(
      (
        COALESCE(${officialAlias}.platform_user_id, '') <> ''
        AND ${officialAlias}.platform_user_id = ${rowAlias}.author_id
      )
      OR (
        COALESCE(${officialAlias}.account_id, '') <> ''
        AND ${officialAlias}.account_id = ${rowAlias}.author_id
      )
      OR (
        COALESCE(${officialAlias}.platform_user_id, '') = ''
        AND COALESCE(${officialAlias}.account_no, '') = ''
        AND COALESCE(${officialAlias}.account_id, '') = ''
        AND COALESCE(${rowAlias}.author_id, '') = ''
        AND (
          (
            COALESCE(${officialAlias}.account_name, '') <> ''
            AND ${officialAlias}.account_name = ${rowAlias}.author_name
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(${officialAlias}.aliases) = 'array'
                  THEN ${officialAlias}.aliases
                ELSE '[]'::jsonb
              END
            ) alias
            WHERE alias = ${rowAlias}.author_name
          )
        )
      )
    )`;
    const commentMatchSql = (rowAlias) => `EXISTS (
      SELECT 1 FROM official_accounts oa
      WHERE oa.tenant_id = ${rowAlias}.tenant_id AND oa.status = 'active'
        AND (COALESCE(oa.platform, '') = '' OR oa.platform = ${rowAlias}.platform)
        AND ${commentAuthorMatchSql(rowAlias)}
    )`;

    // ① 官方"发文"只按强身份重标 → official_content,退出舆情监测
    const excluded = (await execute(`
      UPDATE records r SET record_type = 'official_content', updated_at = now()
      WHERE r.tenant_id = $1 AND COALESCE(r.record_type, '') <> 'official_content'
        AND EXISTS (
          SELECT 1 FROM official_accounts oa
          WHERE oa.tenant_id = r.tenant_id AND oa.status = 'active' AND oa.skip_content = true
            AND (COALESCE(oa.platform,'')='' OR oa.platform = r.platform)
            AND ((COALESCE(oa.platform_user_id,'')<>'' AND oa.platform_user_id=r.author_id)
              OR (COALESCE(oa.account_no,'')<>'' AND oa.account_no=r.author_account_no)
              OR (COALESCE(oa.account_id,'')<>'' AND (
                oa.account_id=r.author_id OR oa.account_id=r.author_account_no
              )))
        )
    `, [tenantId]))?.rowCount ?? 0;

    // ② 官方"回复评论" → 强身份优先；双方均无强身份时才兼容旧名称数据
    const officialReplies = (await execute(`
      UPDATE record_comments c
      SET is_official = true, is_negative = false, sentiment = 'neutral', risk_level = 'none', updated_at = now()
      WHERE c.tenant_id = $1 AND c.is_official IS DISTINCT FROM true AND ${commentMatchSql('c')}
    `, [tenantId]))?.rowCount ?? 0;

    // ③ 为官方回复补 official_responses(供详情页"官方响应"展示;每条评论一条,去重)
    await execute(`
      INSERT INTO official_responses (tenant_id, record_id, comment_id, official_account_id, platform, account_id, account_name, content, published_at, content_hash)
      SELECT DISTINCT ON (c.id) c.tenant_id, c.record_id, c.id, oa.id, c.platform, c.author_id,
        COALESCE(NULLIF(c.author_name,''), oa.account_name), c.content, c.published_at, md5(c.id::text)
      FROM record_comments c
      JOIN official_accounts oa ON oa.tenant_id = c.tenant_id AND oa.status = 'active'
        AND (COALESCE(oa.platform,'')='' OR oa.platform = c.platform)
        AND ${commentAuthorMatchSql('c')}
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

export {
  defaultAuthCodeExpiry,
  parseAuthCodeExpiry,
  parseAuthCodeMaxBindings,
};

export default router;
