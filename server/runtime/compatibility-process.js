import { resolveProcessRole } from '../config/process-role.js';
import { initDb } from '../db/init.js';
import { acquireProcessRoleLocks } from './process-role-locks.js';

function warnAboutDefaultRole(logger, warning) {
  try {
    logger?.warn?.(`[ProcessRole] ${warning.message}`);
  } catch {
    // A custom logger must not decide whether startup is allowed.
  }
}

function logAcquiredLocks(logger, roleConfig, lockHandle) {
  const heldRoles = lockHandle.heldRoles.join(',');
  try {
    logger?.info?.(
      `[ProcessRole] role=${roleConfig.role} executionLocks=${heldRoles} `
      + `backendPid=${lockHandle.backendPid}`,
    );
  } catch {
    // Lock ownership is already established; logging is observational only.
  }
}

/**
 * Prepare the legacy all-in-one process without starting HTTP, Cron, repairs,
 * media backfills, or recurring AI work.
 *
 * P2-B deliberately acquires execution authority before initDb(), because
 * initDb() also owns migrations and startup backfills. Independent API/Worker
 * entrypoints remain a P2-C concern.
 */
export async function prepareCompatibilityProcess({
  env = process.env,
  logger = console,
  onLockLost,
  resolveRole = resolveProcessRole,
  acquireLocks = acquireProcessRoleLocks,
  initializeDatabase = initDb,
} = {}) {
  if (typeof onLockLost !== 'function') {
    throw new TypeError('onLockLost is required for the compatibility process');
  }

  const roleConfig = resolveRole({
    env,
    entrypoint: 'server/index.js',
    onWarning: warning => warnAboutDefaultRole(logger, warning),
  });
  const lockHandle = await acquireLocks({
    role: roleConfig.role,
    databaseUrl: env.DATABASE_URL,
    connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
    logger,
    onLockLost,
  });

  try {
    await initializeDatabase();
  } catch (error) {
    // No background responsibility has started yet, so releasing here cannot
    // overlap a replacement process with old work.
    await lockHandle.release();
    throw error;
  }

  logAcquiredLocks(logger, roleConfig, lockHandle);
  return Object.freeze({ roleConfig, lockHandle });
}
