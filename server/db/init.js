import { runMigrations } from './migrate.js';
import { assertDbConnection, closePool } from './pool.js';
import { queryAll, queryOne, execute, withTransaction } from './query.js';
import { ensureBootstrapAdmin } from '../services/auth-service.js';

let initialized = false;
let defaultTenantId = null;

export async function initDb() {
  if (initialized) return true;
  await assertDbConnection();
  await runMigrations();
  await ensureBootstrapAdmin();
  initialized = true;
  console.log('[DB] PostgreSQL initialized');
  return true;
}

export function startAutoSave() {
  // PostgreSQL persists writes immediately. This remains as a no-op for old imports.
}

export async function closeDb() {
  await closePool();
  initialized = false;
  defaultTenantId = null;
  console.log('[DB] Connection pool closed');
}

export async function getDefaultTenantId() {
  if (defaultTenantId) return defaultTenantId;
  const tenant = await queryOne("SELECT id FROM tenants WHERE name = 'OnStar' ORDER BY created_at LIMIT 1");
  if (!tenant) throw new Error('Default tenant OnStar is missing. Run migrations first.');
  defaultTenantId = tenant.id;
  return defaultTenantId;
}

export async function getTenantByAuthCode(authCode) {
  if (!authCode) return null;
  return await queryOne(`
    SELECT ac.*, t.name AS tenant_name
    FROM auth_codes ac
    JOIN tenants t ON t.id = ac.tenant_id
    WHERE ac.code = $1
  `, [authCode]);
}

export async function getSetting(key, tenantId = null) {
  const resolvedTenantId = tenantId || await getDefaultTenantId();
  const row = await queryOne(
    'SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = $2',
    [resolvedTenantId, key]
  );
  return row?.value ?? '';
}

export async function setSetting(key, value, tenantId = null) {
  const resolvedTenantId = tenantId || await getDefaultTenantId();
  await execute(`
    INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `, [resolvedTenantId, key, String(value ?? '')]);
}

export async function getSettings(keys, tenantId = null) {
  const result = {};
  for (const key of keys) {
    result[key] = await getSetting(key, tenantId);
  }
  return result;
}

export async function setSettings(obj, tenantId = null) {
  const resolvedTenantId = tenantId || await getDefaultTenantId();
  await withTransaction(async tx => {
    for (const [key, value] of Object.entries(obj || {})) {
      await tx.execute(`
        INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (tenant_id, key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `, [resolvedTenantId, key, String(value ?? '')]);
    }
  });
}

export async function getAllSettings(tenantId = null) {
  const resolvedTenantId = tenantId || await getDefaultTenantId();
  const rows = await queryAll(
    'SELECT key, value FROM tenant_settings WHERE tenant_id = $1 ORDER BY key',
    [resolvedTenantId]
  );
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export {
  queryAll,
  queryOne,
  execute,
  withTransaction,
};
