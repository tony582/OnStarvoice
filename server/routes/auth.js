import { Router } from 'express';
import { execute, queryOne } from '../db/init.js';
import {
  createSession,
  getUserWithMemberships,
  normalizeEmail,
  revokeSession,
  verifyPassword,
} from '../services/auth-service.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();

function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    path: '/',
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    isInternal: user.is_internal,
    globalRole: user.global_role,
    mustChangePassword: user.must_change_password,
    memberships: (user.memberships || []).map(m => ({
      tenantId: m.tenant_id,
      tenantName: m.tenant_name,
      role: m.role,
      status: m.status,
    })),
  };
}

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: '请输入邮箱和密码' });
    }

    const row = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!row || row.status !== 'active' || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials', message: '邮箱或密码错误' });
    }

    const session = await createSession(row.id, req);
    await execute('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [row.id]);
    const user = await getUserWithMemberships(row.id);

    res.cookie('osv_session', session.token, sessionCookieOptions(session.expiresAt));
    return res.json({ ok: true, token: session.token, expiresAt: session.expiresAt, user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.cookies?.osv_session || '');
    await revokeSession(token);
    res.clearCookie('osv_session', { path: '/' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireUser, async (req, res) => {
  return res.json({ ok: true, user: publicUser(req.user) });
});

export default router;
