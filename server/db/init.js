import { listMigrationVersions, runMigrations } from './migrate.js';
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

/**
 * Connect an independent runtime role to an already prepared database.
 *
 * P2-C deliberately keeps migrations and bootstrap writes out of the split
 * API/Worker entrypoints. The compatibility `all` entrypoint continues to use
 * initDb() until P2-D introduces a single, explicit maintenance owner.
 */
export async function assertRuntimeSchemaReady({
  requiredMigrationVersions,
  queryAppliedVersions = queryAll,
} = {}) {
  const required = requiredMigrationVersions || await listMigrationVersions();
  if (!Array.isArray(required) || required.length === 0) {
    const error = new Error('No required runtime migrations were found.');
    error.code = 'DATABASE_SCHEMA_REQUIREMENTS_EMPTY';
    throw error;
  }
  const rows = await queryAppliedVersions(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [required],
  );
  const applied = new Set(rows.map(row => row.version));
  const missing = required.filter(version => !applied.has(version));
  if (missing.length > 0) {
    const error = new Error(
      `Database schema is missing ${missing.length} required migration(s); `
      + 'run the approved maintenance migration before starting split runtimes.',
    );
    error.code = 'DATABASE_SCHEMA_NOT_READY';
    error.missingMigrationCount = missing.length;
    throw error;
  }
  return true;
}

export async function connectRuntimeDb({
  assertConnection = assertDbConnection,
  checkSchema = assertRuntimeSchemaReady,
} = {}) {
  await assertConnection();
  await checkSchema();
  console.log('[DB] PostgreSQL runtime connection ready');
  return true;
}

export async function probeDbReadiness({
  assertConnection = assertDbConnection,
  checkSchema = assertRuntimeSchemaReady,
} = {}) {
  await assertConnection();
  await checkSchema();
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
