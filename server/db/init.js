import { runMigrations } from './migrate.js';
import {
  loadMigrationInventory,
  MigrationGovernanceError,
} from './migration-inventory.js';
import { assertDbConnection, closePool } from './pool.js';
import { queryAll, queryOne, execute, withTransaction } from './query.js';
import { ensureBootstrapAdmin } from '../services/auth-service.js';

let initialized = false;
let defaultTenantId = null;
let runtimeMigrationInventoryPromise = null;

async function runDefaultCompatibilityDatabaseMaintenance() {
  const { runCompatibilityDatabaseMaintenance } = await import(
    '../maintenance/compatibility-startup.js'
  );
  return runCompatibilityDatabaseMaintenance();
}

function runtimeMigrationInventory() {
  runtimeMigrationInventoryPromise ||= loadMigrationInventory().catch(error => {
    runtimeMigrationInventoryPromise = null;
    throw error;
  });
  return runtimeMigrationInventoryPromise;
}

function schemaError(code, message, details = {}, cause) {
  return new MigrationGovernanceError(code, message, {
    ...details,
    ...(cause ? { cause } : {}),
  });
}

async function resolveRequiredMigrations({
  requiredMigrations,
  requiredMigrationVersions,
} = {}) {
  if (requiredMigrations !== undefined) return requiredMigrations;

  const inventory = await runtimeMigrationInventory();
  if (requiredMigrationVersions === undefined) return inventory;
  if (!Array.isArray(requiredMigrationVersions)) {
    throw new TypeError('requiredMigrationVersions must be an array when provided');
  }
  const byVersion = new Map(inventory.map(migration => [migration.version, migration]));
  return requiredMigrationVersions.map(version => {
    const migration = byVersion.get(version);
    if (!migration) {
      throw schemaError(
        'DATABASE_SCHEMA_REQUIREMENT_UNKNOWN',
        `Required runtime migration is not in the repository inventory: ${version}`,
        { version },
      );
    }
    return migration;
  });
}

export async function initDb({
  migrate = runMigrations,
  databaseMaintenance = runDefaultCompatibilityDatabaseMaintenance,
  bootstrap = ensureBootstrapAdmin,
} = {}) {
  if (initialized) return true;
  if (typeof migrate !== 'function'
      || typeof databaseMaintenance !== 'function'
      || typeof bootstrap !== 'function') {
    throw new TypeError('migrate, databaseMaintenance, and bootstrap must be functions');
  }
  await migrate();
  await databaseMaintenance();
  await bootstrap();
  initialized = true;
  console.log('[DB] PostgreSQL initialized');
  return true;
}

/**
 * Connect an independent runtime role to an already prepared database.
 *
 * P2-D keeps migrations and bootstrap writes out of split API/Worker
 * entrypoints. The compatibility `all` entrypoint still uses initDb(), but its
 * schema work is now serialized and checksum-verified by the migration core.
 * Explicit maintenance remains the only path that may adopt legacy checksums.
 */
export async function assertRuntimeSchemaReady({
  requiredMigrations,
  requiredMigrationVersions,
  queryAppliedMigrations,
  queryAppliedVersions,
} = {}) {
  const required = await resolveRequiredMigrations({
    requiredMigrations,
    requiredMigrationVersions,
  });
  if (!Array.isArray(required) || required.length === 0) {
    throw schemaError(
      'DATABASE_SCHEMA_REQUIREMENTS_EMPTY',
      'No required runtime migrations were found.',
    );
  }
  for (const migration of required) {
    if (!migration
      || typeof migration.version !== 'string'
      || typeof migration.checksumSha256 !== 'string') {
      throw new TypeError('requiredMigrations must contain version and checksumSha256');
    }
  }

  const queryMigrations = queryAppliedMigrations || queryAppliedVersions || queryAll;
  let rows;
  try {
    rows = await queryMigrations(
      `SELECT version, checksum_sha256, checksum_recorded_at
       FROM schema_migrations
       WHERE version = ANY($1::text[])`,
      [required.map(migration => migration.version)],
    );
  } catch (error) {
    if (error?.code === '42703') {
      throw schemaError(
        'DATABASE_SCHEMA_CHECKSUMS_NOT_READY',
        'Database migration checksums have not been adopted.',
        {},
        error,
      );
    }
    if (error?.code === '42P01') {
      throw schemaError(
        'DATABASE_SCHEMA_NOT_READY',
        'Database migration metadata is missing.',
        {},
        error,
      );
    }
    throw error;
  }

  const applied = new Map(rows.map(row => [row.version, row]));
  const missing = required.filter(migration => !applied.has(migration.version));
  if (missing.length > 0) {
    throw schemaError(
      'DATABASE_SCHEMA_NOT_READY',
      `Database schema is missing ${missing.length} required migration(s); `
      + 'run the approved maintenance migration before starting split runtimes.',
      { missingMigrationCount: missing.length },
    );
  }

  const checksumMissing = required.filter(
    migration => !applied.get(migration.version)?.checksum_sha256
      || !applied.get(migration.version)?.checksum_recorded_at,
  );
  if (checksumMissing.length > 0) {
    throw schemaError(
      'DATABASE_SCHEMA_CHECKSUMS_NOT_READY',
      'Database migration checksums have not been adopted.',
      { missingChecksumCount: checksumMissing.length },
    );
  }

  const mismatched = required.filter(
    migration => applied.get(migration.version).checksum_sha256 !== migration.checksumSha256,
  );
  if (mismatched.length > 0) {
    throw schemaError(
      'DATABASE_MIGRATION_CHECKSUM_MISMATCH',
      'Applied migration checksum does not match the running release.',
      { mismatchedMigrationCount: mismatched.length },
    );
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
