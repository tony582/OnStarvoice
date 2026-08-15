import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_FILENAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/u;
const CHECKSUM_RE = /^[a-f0-9]{64}$/u;
const RESET_MIGRATION_RE = /(?:^|_)reset(?:_|\.)/u;
const BASELINE_FORMAT_VERSION = 1;
const BASELINE_ID = 'v066-main-c47800f';
const BASELINE_SOURCE_COMMIT = 'c47800f3184effc9e6ef05aedba9f37a81053886';
const BASELINE_LAST_VERSION = '066_tenant_comment_risk_attention.sql';
const BASELINE_LAST_NUMBER = 66;
const BASELINE_MIGRATION_COUNT = 65;

export const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');
export const DEFAULT_MIGRATION_BASELINE_PATH = join(
  __dirname,
  'migration-baseline-v066.json',
);

export class MigrationGovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationGovernanceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new MigrationGovernanceError(code, message, details);
}

function migrationKind(version) {
  return RESET_MIGRATION_RE.test(version) ? 'reset' : 'schema';
}

export function checksumMigration(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function validateBaselineDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('DATABASE_MIGRATION_BASELINE_INVALID', 'Migration baseline must be an object.');
  }
  if (value.formatVersion !== BASELINE_FORMAT_VERSION
    || value.baselineId !== BASELINE_ID
    || value.sourceCommit !== BASELINE_SOURCE_COMMIT
    || value.checksumAlgorithm !== 'sha256') {
    fail(
      'DATABASE_MIGRATION_BASELINE_INVALID',
      'Migration baseline metadata is invalid.',
    );
  }
  if (!Array.isArray(value.migrations)
    || value.migrations.length !== BASELINE_MIGRATION_COUNT) {
    fail(
      'DATABASE_MIGRATION_BASELINE_INVALID',
      'Migration baseline does not contain the frozen v066 inventory.',
    );
  }

  const seen = new Set();
  let previousVersion = '';
  const migrations = value.migrations.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('DATABASE_MIGRATION_BASELINE_INVALID', 'Migration baseline entry is invalid.');
    }
    const { version, kind, checksumSha256 } = entry;
    if (typeof version !== 'string' || !MIGRATION_FILENAME_RE.test(version)) {
      fail(
        'DATABASE_MIGRATION_BASELINE_INVALID',
        'Migration baseline contains an invalid version.',
      );
    }
    if (seen.has(version) || (previousVersion && version <= previousVersion)) {
      fail(
        'DATABASE_MIGRATION_BASELINE_INVALID',
        'Migration baseline versions must be unique and sorted.',
      );
    }
    if (kind !== migrationKind(version)) {
      fail(
        'DATABASE_MIGRATION_BASELINE_INVALID',
        `Migration baseline kind is invalid for ${version}.`,
        { version },
      );
    }
    if (typeof checksumSha256 !== 'string' || !CHECKSUM_RE.test(checksumSha256)) {
      fail(
        'DATABASE_MIGRATION_BASELINE_INVALID',
        `Migration baseline checksum is invalid for ${version}.`,
        { version },
      );
    }
    seen.add(version);
    previousVersion = version;
    return Object.freeze({ version, kind, checksumSha256 });
  });

  if (migrations.at(-1)?.version !== BASELINE_LAST_VERSION) {
    fail(
      'DATABASE_MIGRATION_BASELINE_INVALID',
      'Migration baseline does not end at v066.',
    );
  }

  return Object.freeze({
    formatVersion: value.formatVersion,
    baselineId: value.baselineId,
    sourceCommit: value.sourceCommit,
    checksumAlgorithm: value.checksumAlgorithm,
    migrations: Object.freeze(migrations),
  });
}

export async function loadMigrationBaseline({
  baselinePath = DEFAULT_MIGRATION_BASELINE_PATH,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    throw new MigrationGovernanceError(
      'DATABASE_MIGRATION_BASELINE_INVALID',
      'Migration baseline could not be read.',
      { cause: error },
    );
  }
  return validateBaselineDocument(parsed);
}

/**
 * Load the immutable migration inputs used by both the migrator and runtime
 * readiness checks. Checksums cover the exact bytes shipped in the release.
 */
export async function loadMigrationInventory({
  includeReset = false,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  baselinePath = DEFAULT_MIGRATION_BASELINE_PATH,
} = {}) {
  if (typeof includeReset !== 'boolean') {
    throw new TypeError('includeReset must be a boolean');
  }

  const [entries, baseline] = await Promise.all([
    readdir(migrationsDir, { withFileTypes: true }),
    loadMigrationBaseline({ baselinePath }),
  ]);
  const sqlEntries = entries
    .filter(entry => entry.name.endsWith('.sql'))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sqlEntries) {
    if (!entry.isFile() || !MIGRATION_FILENAME_RE.test(entry.name)) {
      fail(
        'DATABASE_MIGRATION_FILENAME_INVALID',
        `Invalid migration filename: ${entry.name}`,
        { version: entry.name },
      );
    }
  }

  const baselineByVersion = new Map(
    baseline.migrations.map(entry => [entry.version, entry]),
  );
  const inventory = [];
  const foundVersions = new Set();

  for (const entry of sqlEntries) {
    const version = entry.name;
    const kind = migrationKind(version);
    const contents = await readFile(join(migrationsDir, version));
    const checksumSha256 = checksumMigration(contents);
    const baselineEntry = baselineByVersion.get(version);

    if (Number(version.slice(0, 3)) <= BASELINE_LAST_NUMBER && !baselineEntry) {
      fail(
        'DATABASE_MIGRATION_BASELINE_INCOMPLETE',
        `Historical migration is not frozen in the v066 baseline: ${version}`,
        { version },
      );
    }
    if (baselineEntry
      && (baselineEntry.kind !== kind || baselineEntry.checksumSha256 !== checksumSha256)) {
      fail(
        'DATABASE_MIGRATION_BASELINE_MISMATCH',
        `Frozen migration differs from the v066 baseline: ${version}`,
        { version },
      );
    }

    foundVersions.add(version);
    inventory.push(Object.freeze({
      version,
      kind,
      checksumSha256,
      sql: contents.toString('utf8'),
      legacyBaseline: Boolean(baselineEntry),
    }));
  }

  const missingBaseline = baseline.migrations.find(
    entry => !foundVersions.has(entry.version),
  );
  if (missingBaseline) {
    fail(
      'DATABASE_MIGRATION_BASELINE_MISSING_FILE',
      `Frozen migration file is missing: ${missingBaseline.version}`,
      { version: missingBaseline.version },
    );
  }

  return Object.freeze(
    inventory.filter(migration => includeReset || migration.kind === 'schema'),
  );
}
