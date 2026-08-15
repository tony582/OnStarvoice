import 'dotenv/config'; // Maintenance 导入迁移核心时仍需加载 server/.env。
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { setTimeout as delay } from 'node:timers/promises';
import { getPool } from './pool.js';
import {
  loadMigrationInventory,
  MigrationGovernanceError,
} from './migration-inventory.js';

const __filename = fileURLToPath(import.meta.url);

const MIGRATION_LOCK_NAMESPACE = 'onstarvoice:migrations:v1';
const MIGRATION_LOCK_NAME = 'global';
const DEFAULT_MIGRATION_LOCK_WAIT_MS = 60_000;
const DEFAULT_MIGRATION_LOCK_POLL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHECKSUM_RE = /^[a-f0-9]{64}$/u;
const TRY_MIGRATION_LOCK_SQL = `
  SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired
`;
const RELEASE_MIGRATION_LOCK_SQL = `
  SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released
`;

export async function listMigrationVersions({ includeReset = false } = {}) {
  const migrations = await loadMigrationInventory({ includeReset });
  return migrations.map(migration => migration.version);
}

function positiveInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  const parsed = typeof candidate === 'number'
    ? candidate
    : (/^[1-9]\d*$/u.test(String(candidate)) ? Number(candidate) : Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function migrationError(code, message, details = {}) {
  return new MigrationGovernanceError(code, message, details);
}

function resolveMigrationLockOptions({ lockWaitMs, lockPollMs } = {}) {
  return Object.freeze({
    waitMs: positiveInteger(
      lockWaitMs,
      process.env.MIGRATION_LOCK_WAIT_MS ?? DEFAULT_MIGRATION_LOCK_WAIT_MS,
      'lockWaitMs',
    ),
    pollMs: positiveInteger(
      lockPollMs,
      process.env.MIGRATION_LOCK_POLL_MS ?? DEFAULT_MIGRATION_LOCK_POLL_MS,
      'lockPollMs',
    ),
  });
}

/**
 * Acquire the one database-wide migration lock with a bounded wait.
 * No schema query or mutation may happen before this resolves.
 */
export async function acquireMigrationAdvisoryLock(client, {
  waitMs = DEFAULT_MIGRATION_LOCK_WAIT_MS,
  pollMs = DEFAULT_MIGRATION_LOCK_POLL_MS,
  now = Date.now,
  sleep = delay,
} = {}) {
  const boundedWaitMs = positiveInteger(waitMs, DEFAULT_MIGRATION_LOCK_WAIT_MS, 'waitMs');
  const boundedPollMs = positiveInteger(pollMs, DEFAULT_MIGRATION_LOCK_POLL_MS, 'pollMs');
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('now and sleep must be functions');
  }

  const deadline = now() + boundedWaitMs;
  do {
    const result = await client.query(
      TRY_MIGRATION_LOCK_SQL,
      [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_NAME],
    );
    if (result.rows[0]?.acquired === true) return true;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(boundedPollMs, remainingMs));
  } while (now() < deadline);

  throw migrationError(
    'DATABASE_MIGRATION_LOCK_TIMEOUT',
    'Timed out waiting for the PostgreSQL migration lock.',
    { lockWaitMs: boundedWaitMs },
  );
}

export async function releaseMigrationAdvisoryLock(client) {
  const result = await client.query(
    RELEASE_MIGRATION_LOCK_SQL,
    [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_NAME],
  );
  if (result.rows[0]?.released !== true) {
    throw migrationError(
      'DATABASE_MIGRATION_LOCK_RELEASE_FAILED',
      'PostgreSQL migration lock was not held during release.',
    );
  }
}

async function migrationTableColumns(client) {
  const relation = await client.query(
    'SELECT to_regclass($1) AS relation',
    ['schema_migrations'],
  );
  if (!relation.rows[0]?.relation) return null;

  const columns = await client.query(`
    SELECT attribute.attname AS name
    FROM pg_attribute attribute
    WHERE attribute.attrelid = to_regclass($1)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `, ['schema_migrations']);
  return new Set(columns.rows.map(row => row.name));
}

async function createMigrationTable(client) {
  await client.query(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum_sha256 TEXT,
      checksum_recorded_at TIMESTAMPTZ
    )
  `);
}

async function upgradeLegacyMigrationTable(client, columns, adoptLegacyChecksums) {
  const missingChecksumColumns = !columns.has('checksum_sha256')
    || !columns.has('checksum_recorded_at');
  if (!missingChecksumColumns) return;
  if (!adoptLegacyChecksums) {
    throw migrationError(
      'DATABASE_MIGRATION_CHECKSUMS_NOT_READY',
      'Legacy migration checksums require explicit v066 adoption.',
    );
  }
  await client.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
      ADD COLUMN IF NOT EXISTS checksum_recorded_at TIMESTAMPTZ
  `);
}

function validateAppliedMigrationRow(row, migration, adoptLegacyChecksums) {
  const checksum = row.checksum_sha256;
  const recordedAt = row.checksum_recorded_at;

  if (checksum == null) {
    if (recordedAt != null) {
      throw migrationError(
        'DATABASE_MIGRATION_CHECKSUM_METADATA_INVALID',
        `Migration checksum metadata is incomplete for ${migration.version}.`,
        { version: migration.version },
      );
    }
    if (!migration.legacyBaseline) {
      throw migrationError(
        'DATABASE_MIGRATION_CHECKSUM_MISSING',
        `Applied migration has no trusted checksum: ${migration.version}.`,
        { version: migration.version },
      );
    }
    if (!adoptLegacyChecksums) {
      throw migrationError(
        'DATABASE_MIGRATION_CHECKSUMS_NOT_READY',
        'Legacy migration checksums require explicit v066 adoption.',
        { version: migration.version },
      );
    }
    return 'adopt';
  }

  if (typeof checksum !== 'string' || !CHECKSUM_RE.test(checksum) || recordedAt == null) {
    throw migrationError(
      'DATABASE_MIGRATION_CHECKSUM_METADATA_INVALID',
      `Migration checksum metadata is invalid for ${migration.version}.`,
      { version: migration.version },
    );
  }
  if (checksum !== migration.checksumSha256) {
    throw migrationError(
      'DATABASE_MIGRATION_CHECKSUM_MISMATCH',
      `Applied migration checksum does not match ${migration.version}.`,
      { version: migration.version },
    );
  }
  return 'verified';
}

/**
 * Prepare and verify schema_migrations under the migration advisory lock.
 * Existing non-SQL maintenance markers remain untouched and checksum-free.
 */
export async function prepareMigrationTracker(
  client,
  migrations,
  { adoptLegacyChecksums = false } = {},
) {
  if (typeof adoptLegacyChecksums !== 'boolean') {
    throw new TypeError('adoptLegacyChecksums must be a boolean');
  }
  const migrationByVersion = new Map(
    migrations.map(migration => [migration.version, migration]),
  );

  await client.query('BEGIN');
  try {
    const columns = await migrationTableColumns(client);
    if (columns === null) await createMigrationTable(client);
    else await upgradeLegacyMigrationTable(client, columns, adoptLegacyChecksums);

    const result = await client.query(`
      SELECT version, applied_at, checksum_sha256, checksum_recorded_at
      FROM schema_migrations
      ORDER BY version
    `);
    const applied = new Set(result.rows.map(row => row.version));
    const toAdopt = [];

    for (const row of result.rows) {
      const migration = migrationByVersion.get(row.version);
      if (!migration) continue;
      if (validateAppliedMigrationRow(row, migration, adoptLegacyChecksums) === 'adopt') {
        toAdopt.push(migration);
      }
    }

    for (const migration of toAdopt) {
      const updated = await client.query(`
        UPDATE schema_migrations
        SET checksum_sha256 = $2,
            checksum_recorded_at = now()
        WHERE version = $1
          AND checksum_sha256 IS NULL
          AND checksum_recorded_at IS NULL
      `, [migration.version, migration.checksumSha256]);
      if (updated.rowCount !== 1) {
        throw migrationError(
          'DATABASE_MIGRATION_CHECKSUM_ADOPTION_CONFLICT',
          `Migration checksum adoption raced for ${migration.version}.`,
          { version: migration.version },
        );
      }
    }

    await client.query('COMMIT');
    return Object.freeze({
      applied,
      adoptedVersions: Object.freeze(toAdopt.map(migration => migration.version)),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function applySchemaMigrations(client, migrations, applied) {
  const appliedVersions = [];
  for (const migration of migrations) {
    if (migration.kind !== 'schema' || applied.has(migration.version)) continue;

    console.log(`[DB] Applying migration ${migration.version}`);
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(`
        INSERT INTO schema_migrations (
          version,
          checksum_sha256,
          checksum_recorded_at
        ) VALUES ($1, $2, now())
      `, [migration.version, migration.checksumSha256]);
      await client.query('COMMIT');
      applied.add(migration.version);
      appliedVersions.push(migration.version);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    }
  }
  return appliedVersions;
}

function attachSecondaryError(primaryError, secondaryError) {
  if (!primaryError || !secondaryError) return;
  try { primaryError.migrationLockReleaseError = secondaryError; } catch {}
}

async function finishMigrationClient(client, { lockAcquired, operationError }) {
  let releaseError = null;
  if (lockAcquired) {
    try {
      await releaseMigrationAdvisoryLock(client);
    } catch (error) {
      releaseError = error;
    }
  }

  try {
    client.release(releaseError || undefined);
  } catch (error) {
    releaseError ||= error;
  }

  if (releaseError && operationError) {
    attachSecondaryError(operationError, releaseError);
    return operationError;
  }
  return releaseError || operationError;
}

/** Read-only verification used by the explicit Maintenance CLI. */
export async function verifyMigrations({ lockWaitMs, lockPollMs } = {}) {
  const lockOptions = resolveMigrationLockOptions({ lockWaitMs, lockPollMs });
  const migrations = await loadMigrationInventory({ includeReset: true });
  const pool = getPool();
  const client = await pool.connect();
  let lockAcquired = false;
  let operationError = null;
  let result;

  try {
    await acquireMigrationAdvisoryLock(client, {
      waitMs: lockOptions.waitMs,
      pollMs: lockOptions.pollMs,
    });
    lockAcquired = true;

    const columns = await migrationTableColumns(client);
    if (columns === null) {
      throw migrationError(
        'DATABASE_SCHEMA_NOT_READY',
        'Database migration metadata is missing.',
      );
    }
    if (!columns.has('checksum_sha256') || !columns.has('checksum_recorded_at')) {
      throw migrationError(
        'DATABASE_MIGRATION_CHECKSUMS_NOT_READY',
        'Legacy migration checksums require explicit v066 adoption.',
      );
    }

    const rows = await client.query(`
      SELECT version, applied_at, checksum_sha256, checksum_recorded_at
      FROM schema_migrations
      ORDER BY version
    `);
    const migrationByVersion = new Map(
      migrations.map(migration => [migration.version, migration]),
    );
    const applied = new Set(rows.rows.map(row => row.version));
    for (const row of rows.rows) {
      const migration = migrationByVersion.get(row.version);
      if (migration) validateAppliedMigrationRow(row, migration, false);
    }

    const missing = migrations.filter(
      migration => migration.kind === 'schema' && !applied.has(migration.version),
    );
    if (missing.length > 0) {
      throw migrationError(
        'DATABASE_SCHEMA_NOT_READY',
        `Database schema is missing ${missing.length} required migration(s).`,
        { missingMigrationCount: missing.length },
      );
    }

    result = Object.freeze({
      verifiedVersions: Object.freeze(
        migrations
          .filter(migration => applied.has(migration.version))
          .map(migration => migration.version),
      ),
    });
  } catch (error) {
    operationError = error;
  } finally {
    operationError = await finishMigrationClient(client, {
      lockAcquired,
      operationError,
    });
  }

  if (operationError) throw operationError;
  return result;
}

export async function runMigrations({
  adoptLegacyChecksums = false,
  lockWaitMs,
  lockPollMs,
} = {}) {
  if (typeof adoptLegacyChecksums !== 'boolean') {
    throw new TypeError('adoptLegacyChecksums must be a boolean');
  }
  if (process.env.ALLOW_RESET_MIGRATIONS === '1') {
    throw migrationError(
      'DATABASE_RESET_MIGRATIONS_DISABLED',
      'Automatic reset migrations are disabled; use an approved maintenance workflow.',
    );
  }

  const lockOptions = resolveMigrationLockOptions({ lockWaitMs, lockPollMs });

  // Reset files are loaded only so an already-recorded historical reset can be
  // checksum-verified. applySchemaMigrations() never executes them.
  const migrations = await loadMigrationInventory({ includeReset: true });
  const pool = getPool();
  const client = await pool.connect();
  let lockAcquired = false;
  let operationError = null;
  let result;

  try {
    await acquireMigrationAdvisoryLock(client, {
      waitMs: lockOptions.waitMs,
      pollMs: lockOptions.pollMs,
    });
    lockAcquired = true;
    const tracker = await prepareMigrationTracker(client, migrations, {
      adoptLegacyChecksums,
    });
    const appliedVersions = await applySchemaMigrations(
      client,
      migrations,
      tracker.applied,
    );

    result = Object.freeze({
      appliedVersions: Object.freeze(appliedVersions),
      adoptedVersions: tracker.adoptedVersions,
    });
  } catch (error) {
    operationError = error;
  } finally {
    operationError = await finishMigrationClient(client, {
      lockAcquired,
      operationError,
    });
  }

  if (operationError) throw operationError;
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  console.error(
    '[DB] DATABASE_MIGRATION_DIRECT_ENTRYPOINT_DISABLED: '
    + 'use PROCESS_ROLE=maintenance npm run maintenance -- migrate',
  );
  process.exitCode = 2;
}
