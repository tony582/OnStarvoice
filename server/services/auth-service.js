import crypto from 'crypto';
import { execute, queryAll, queryOne, withTransaction } from '../db/query.js';

const HASH_ALGO = 'sha256';
const HASH_ITERATIONS = 210000;
const HASH_KEYLEN = 32;
const SESSION_DAYS = 14;

function pbkdf2(password, salt, iterations = HASH_ITERATIONS) {
  return crypto.pbkdf2Sync(password, salt, iterations, HASH_KEYLEN, HASH_ALGO).toString('base64');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = pbkdf2(password, salt);
  return `pbkdf2_${HASH_ALGO}$${HASH_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  const [scheme, iterationsRaw, salt, expected] = String(storedHash).split('$');
  if (scheme !== `pbkdf2_${HASH_ALGO}` || !iterationsRaw || !salt || !expected) return false;
  const actual = pbkdf2(password, salt, Number(iterationsRaw));
  if (Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function makeSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 86400000);
}

export async function getUserWithMemberships(userId) {
  const user = await queryOne(
    `SELECT id, email, name, status, is_internal, global_role, must_change_password, last_login_at, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) return null;
  const memberships = await queryAll(`
    SELECT um.id, um.tenant_id, um.role, um.status, t.name AS tenant_name
    FROM user_memberships um
    JOIN tenants t ON t.id = um.tenant_id
    WHERE um.user_id = $1
    ORDER BY t.name ASC
  `, [userId]);
  return { ...user, memberships };
}

export async function resolveSession(token) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await queryOne(`
    SELECT us.*, u.status AS user_status
    FROM user_sessions us
    JOIN users u ON u.id = us.user_id
    WHERE us.token_hash = $1
      AND us.revoked_at IS NULL
      AND us.expires_at > now()
      AND u.status = 'active'
  `, [tokenHash]);
  if (!session) return null;
  const user = await getUserWithMemberships(session.user_id);
  if (!user) return null;
  return { session, user };
}

export async function createSession(userId, req) {
  const token = makeSessionToken();
  const expiresAt = sessionExpiry();
  const ip = req.ip || req.socket?.remoteAddress || '';
  const userAgent = req.headers?.['user-agent'] || '';
  await execute(`
    INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [userId, hashSessionToken(token), ip, userAgent, expiresAt.toISOString()]);
  return { token, expiresAt };
}

export async function revokeSession(token) {
  if (!token) return false;
  const result = await execute(
    'UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashSessionToken(token)]
  );
  return result.rowCount > 0;
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

export async function ensureBootstrapAdmin() {
  const existing = await queryOne("SELECT id FROM users WHERE global_role = 'platform_admin' LIMIT 1");
  if (existing) return { created: false, skipped: false };

  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL || '');
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('[Auth] No platform admin exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD once to initialize the first account.');
    return { created: false, skipped: true };
  }
  if (password.length < 12) {
    console.warn('[Auth] BOOTSTRAP_ADMIN_PASSWORD is too short. Use at least 12 characters.');
    return { created: false, skipped: true };
  }
  const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Admin';
  const tenant = await queryOne("SELECT id FROM tenants WHERE name = 'OnStar' ORDER BY created_at LIMIT 1");
  if (!tenant) {
    console.warn('[Auth] Default tenant is missing. Bootstrap admin skipped.');
    return { created: false, skipped: true };
  }

  await withTransaction(async tx => {
    const user = await tx.queryOne(`
      INSERT INTO users (email, name, password_hash, status, is_internal, global_role, must_change_password)
      VALUES ($1, $2, $3, 'active', true, 'platform_admin', false)
      ON CONFLICT (email)
      DO UPDATE SET
        is_internal = true,
        global_role = 'platform_admin',
        status = 'active',
        updated_at = now()
      RETURNING id
    `, [email, name, hashPassword(password)]);

    await tx.execute(`
      INSERT INTO user_memberships (user_id, tenant_id, role, status)
      VALUES ($1, $2, 'tenant_admin', 'active')
      ON CONFLICT (user_id, tenant_id)
      DO UPDATE SET role = 'tenant_admin', status = 'active', updated_at = now()
    `, [user.id, tenant.id]);

    await tx.execute(`
      INSERT INTO password_events (user_id, event_type, metadata)
      VALUES ($1, 'created', $2::jsonb)
    `, [user.id, JSON.stringify({ bootstrap: true })]);
  });

  console.log(`[Auth] Bootstrap platform admin created: ${email}`);
  return { created: true, skipped: false };
}
