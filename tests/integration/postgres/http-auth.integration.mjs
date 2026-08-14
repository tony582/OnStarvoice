import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { createApp } from '../../../server/app.js';
import { runMigrations } from '../../../server/db/migrate.js';
import { closePool, getPool } from '../../../server/db/pool.js';
import { hashPassword } from '../../../server/services/auth-service.js';

const PASSWORD = 'P2-http-integration-password';

function listenOnTemporaryPort(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function readJson(response) {
  assert.match(response.headers.get('content-type') || '', /application\/json/u);
  return response.json();
}

test('real HTTP authentication preserves tenant membership boundaries', async t => {
  const originalFetch = globalThis.fetch;
  const blockedOutboundUrls = [];
  let server;
  let pool;
  let userId;
  const tenantIds = [];
  t.after(async () => {
    const cleanupErrors = [];
    const attempt = async callback => {
      try {
        await callback();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    if (server) await attempt(() => closeServer(server));
    if (pool && userId) {
      await attempt(() => pool.query('DELETE FROM users WHERE id = $1', [userId]));
    }
    if (pool && tenantIds.length > 0) {
      await attempt(() => pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]));
    }
    await attempt(closePool);
    globalThis.fetch = originalFetch;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'P2 HTTP integration cleanup failed');
    }
  });

  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  await runMigrations();
  pool = getPool();
  const suffix = randomUUID();
  const tenantA = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
    [`P2 HTTP tenant A ${suffix}`],
  );
  const tenantAId = tenantA.rows[0].id;
  tenantIds.push(tenantAId);
  const tenantB = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
    [`P2 HTTP tenant B ${suffix}`],
  );
  const tenantBId = tenantB.rows[0].id;
  tenantIds.push(tenantBId);
  const email = `p2-http-${suffix}@integration.invalid`;
  const user = await pool.query(`
    INSERT INTO users (
      email, name, password_hash, status, is_internal, global_role, must_change_password
    )
    VALUES ($1, $2, $3, 'active', false, '', false)
    RETURNING id
  `, [email, 'P2 HTTP user', hashPassword(PASSWORD)]);
  userId = user.rows[0].id;
  await pool.query(`
    INSERT INTO user_memberships (user_id, tenant_id, role, status)
    VALUES ($1, $2, 'tenant_viewer', 'active')
  `, [user.rows[0].id, tenantAId]);
  await pool.query(`
    INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES
      ($1, 'feishu_app_token', 'tenant-a-secret'),
      ($1, 'feishu_table_id', 'tenant-a-table'),
      ($2, 'feishu_app_token', 'tenant-b-secret'),
      ($2, 'feishu_table_id', 'tenant-b-table')
  `, [tenantAId, tenantBId]);
  const tenantBCode = `P2-HTTP-${suffix}`;
  await pool.query(`
    INSERT INTO auth_codes (tenant_id, code, type, status, max_bindings)
    VALUES ($1, $2, 'permanent', 'active', 1)
  `, [tenantBId, tenantBCode]);

  const app = createApp({ logger: { log() {}, error() {} } });
  server = await listenOnTemporaryPort(app);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== baseUrl) {
      blockedOutboundUrls.push(url.href);
      throw new Error(`Unexpected outbound HTTP request: ${url.href}`);
    }
    return originalFetch(input, init);
  };

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await readJson(loginResponse);
  assert.equal(login.ok, true);
  assert.equal(typeof login.token, 'string');
  assert.ok(login.token.length >= 32);
  assert.equal(login.user.email, email);
  assert.deepEqual(login.user.memberships, [{
    tenantId: tenantAId,
    tenantName: tenantA.rows[0].name,
    role: 'tenant_viewer',
    status: 'active',
  }]);
  const setCookie = loginResponse.headers.get('set-cookie') || '';
  assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/iu);
  assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/iu);
  assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/iu);
  const sessionCookie = setCookie.split(';')[0] || '';
  assert.match(sessionCookie, /^osv_session=/u);
  assert.equal(sessionCookie.slice('osv_session='.length), login.token);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(meResponse.status, 200);
  const me = await readJson(meResponse);
  assert.equal(me.ok, true);
  assert.equal(me.user.id, login.user.id);
  assert.equal('password_hash' in me.user, false);

  const tenantAResponse = await fetch(`${baseUrl}/api/target`, {
    headers: {
      Authorization: `Bearer ${login.token}`,
      'x-tenant-id': tenantAId,
    },
  });
  assert.equal(tenantAResponse.status, 200);
  assert.deepEqual(await readJson(tenantAResponse), {
    ok: true,
    config: {
      feishuAppToken: '***',
      feishuTableId: 'tenant-a-table',
    },
  });

  const defaultTenantResponse = await fetch(`${baseUrl}/api/target`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  assert.equal(defaultTenantResponse.status, 200);
  assert.equal((await readJson(defaultTenantResponse)).config.feishuTableId, 'tenant-a-table');

  const forbiddenResponse = await fetch(`${baseUrl}/api/target`, {
    headers: {
      Authorization: `Bearer ${login.token}`,
      'x-tenant-id': tenantBId,
    },
  });
  assert.equal(forbiddenResponse.status, 403);
  const forbiddenBody = await readJson(forbiddenResponse);
  assert.deepEqual(forbiddenBody, {
    ok: false,
    error: 'tenant_forbidden',
    message: '无权访问该租户',
  });
  assert.equal(JSON.stringify(forbiddenBody).includes('tenant-b-secret'), false);
  assert.equal(JSON.stringify(forbiddenBody).includes('tenant-b-table'), false);

  const authCodeResponse = await fetch(`${baseUrl}/api/target`, {
    headers: {
      'x-auth-code': tenantBCode,
      'x-tenant-id': tenantAId,
    },
  });
  assert.equal(authCodeResponse.status, 200);
  assert.deepEqual(await readJson(authCodeResponse), {
    ok: true,
    config: {
      feishuAppToken: 'tenant-b-secret',
      feishuTableId: 'tenant-b-table',
    },
  });

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(await readJson(logoutResponse), { ok: true });
  const clearCookie = logoutResponse.headers.get('set-cookie') || '';
  assert.match(clearCookie, /^osv_session=;/u);
  assert.match(clearCookie, /(?:^|;\s*)Path=\/(?:;|$)/iu);

  const revokedResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(revokedResponse.status, 401);
  assert.equal((await readJson(revokedResponse)).error, 'unauthorized');
  assert.deepEqual(blockedOutboundUrls, []);
});
