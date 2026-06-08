import { queryOne, execute } from '../db/init.js';

/**
 * 扩展端鉴权中间件
 */
export function requireAuth(req, res, next) {
  const authCode = req.headers['x-auth-code'] || req.body?.authCode || req.body?.code || '';
  if (!authCode) {
    return res.status(401).json({ ok: false, error: 'missing_auth_code', message: '缺少激活码' });
  }

  const row = queryOne('SELECT * FROM auth_codes WHERE code = ?', [authCode]);

  if (!row) {
    return res.status(401).json({ ok: false, error: 'invalid_code', message: '激活码不存在' });
  }

  if (row.status === 'frozen') {
    return res.status(403).json({ ok: false, error: 'frozen', message: '激活码已被冻结，请联系管理员' });
  }

  if (row.status === 'expired' || (row.expires_at && new Date(row.expires_at) < new Date())) {
    if (row.status !== 'expired') {
      execute("UPDATE auth_codes SET status = 'expired' WHERE id = ?", [row.id]);
    }
    return res.status(403).json({ ok: false, error: 'expired', message: '激活码已过期，请续费或联系管理员获取新激活码' });
  }

  req.authCode = authCode;
  req.authCodeRow = row;
  next();
}

/**
 * 管理后台鉴权中间件
 */
export function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const token = req.headers['x-admin-token'] || req.cookies?.admin_token || '';

  if (token === adminPassword) return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [, password] = decoded.split(':');
    if (password === adminPassword) return next();
  }

  return res.status(401).json({ ok: false, error: 'unauthorized', message: '管理员密码错误' });
}
