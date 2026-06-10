import { execute, getDefaultTenantId, getTenantByAuthCode, queryOne } from '../db/init.js';
import { resolveSession } from '../services/auth-service.js';

const INTERNAL_ROLES = new Set(['platform_admin', 'internal_operator']);
const TENANT_WRITE_ROLES = new Set(['tenant_admin', 'tenant_analyst']);

function getSessionToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return req.cookies?.osv_session || req.headers['x-session-token'] || '';
}

function requestedTenantId(req) {
  return req.headers['x-tenant-id'] || req.query?.tenantId || req.body?.tenantId || '';
}

function activeMemberships(user) {
  return (user?.memberships || []).filter(m => m.status === 'active');
}

function userCanUseTenant(user, tenantId) {
  if (!user) return false;
  if (INTERNAL_ROLES.has(user.global_role)) return true;
  return activeMemberships(user).some(m => m.tenant_id === tenantId);
}

function tenantRoleFor(user, tenantId) {
  const membership = activeMemberships(user).find(m => m.tenant_id === tenantId);
  return membership?.role || '';
}

function firstTenantId(user) {
  return activeMemberships(user)[0]?.tenant_id || '';
}

export function isTenantWriter(req) {
  if (req.actorType === 'auth_code') return true;
  if (INTERNAL_ROLES.has(req.user?.global_role)) return true;
  return TENANT_WRITE_ROLES.has(req.tenantRole);
}

export function requireTenantWriter(req, res, next) {
  if (isTenantWriter(req)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden', message: '当前账号没有写入权限' });
}

export async function requireUser(req, res, next) {
  try {
    const resolved = await resolveSession(getSessionToken(req));
    if (!resolved) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: '请先登录' });
    }
    req.session = resolved.session;
    req.user = resolved.user;
    req.actorType = 'user';
    req.actorName = resolved.user.name || resolved.user.email;
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function requireTenantAccess(req, res, next) {
  try {
    const resolved = await resolveSession(getSessionToken(req));
    if (resolved) {
      req.session = resolved.session;
      req.user = resolved.user;
      req.actorType = 'user';
      req.actorName = resolved.user.name || resolved.user.email;

      let tenantId = requestedTenantId(req) || firstTenantId(resolved.user);
      if (!tenantId && INTERNAL_ROLES.has(resolved.user.global_role)) tenantId = await getDefaultTenantId();
      if (!tenantId || !userCanUseTenant(resolved.user, tenantId)) {
        return res.status(403).json({ ok: false, error: 'tenant_forbidden', message: '无权访问该租户' });
      }
      const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = $1 AND status <> $2', [tenantId, 'deleted']);
      if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found', message: '租户不存在' });
      req.tenantId = tenant.id;
      req.tenantName = tenant.name;
      req.tenantRole = tenantRoleFor(resolved.user, tenant.id);
      req.canCrossTenant = INTERNAL_ROLES.has(resolved.user.global_role);
      return next();
    }

    return requireAuth(req, res, next);
  } catch (err) {
    return next(err);
  }
}

/**
 * 扩展端 / 用户端鉴权中间件
 */
export async function requireAuth(req, res, next) {
  try {
    const authCode = req.headers['x-auth-code'] || req.body?.authCode || req.body?.code || '';
    if (!authCode) {
      return res.status(401).json({ ok: false, error: 'missing_auth_code', message: '缺少激活码' });
    }

    const row = await getTenantByAuthCode(authCode);

    if (!row) {
      return res.status(401).json({ ok: false, error: 'invalid_code', message: '激活码不存在' });
    }

    if (row.status === 'frozen') {
      return res.status(403).json({ ok: false, error: 'frozen', message: '激活码已被冻结，请联系管理员' });
    }

    if (row.status === 'expired' || (row.expires_at && new Date(row.expires_at) < new Date())) {
      if (row.status !== 'expired') {
        await execute("UPDATE auth_codes SET status = 'expired' WHERE id = $1", [row.id]);
      }
      return res.status(403).json({ ok: false, error: 'expired', message: '激活码已过期，请续费或联系管理员获取新激活码' });
    }

    req.authCode = authCode;
    req.authCodeRow = row;
    req.tenantId = row.tenant_id;
    req.tenantName = row.tenant_name;
    req.actorType = 'auth_code';
    req.actorName = authCode;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * 管理后台鉴权中间件
 */
export async function requireAdmin(req, res, next) {
  try {
    const resolved = await resolveSession(getSessionToken(req));
    if (!resolved) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: '请先登录管理员账号' });
    }
    if (!INTERNAL_ROLES.has(resolved.user.global_role)) {
      return res.status(403).json({ ok: false, error: 'forbidden', message: '需要内部管理权限' });
    }
    req.session = resolved.session;
    req.user = resolved.user;
    req.actorType = 'user';
    req.actorName = resolved.user.name || resolved.user.email;
    req.canCrossTenant = true;
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function requirePlatformAdmin(req, res, next) {
  return requireAdmin(req, res, err => {
    if (err) return next(err);
    if (req.user?.global_role !== 'platform_admin') {
      return res.status(403).json({ ok: false, error: 'forbidden', message: '需要平台管理员权限' });
    }
    return next();
  });
}
