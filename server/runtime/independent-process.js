import { resolveEntrypointProcessRole } from '../config/process-role.js';
import { closeDb, connectRuntimeDb } from '../db/init.js';
import { acquireProcessRoleLocks } from './process-role-locks.js';

const INDEPENDENT_RUNTIME_ROLES = new Set(['api', 'scheduler', 'ai-media']);

function warnAboutDefaultRole(logger, warning) {
  try {
    logger?.warn?.(`[ProcessRole] ${warning.message}`);
  } catch {
    // A custom logger must not decide whether startup is allowed.
  }
}

function logPreparedRole(logger, roleConfig, lockHandle) {
  const heldRoles = lockHandle.heldRoles.join(',') || 'none';
  try {
    logger?.info?.(
      `[ProcessRole] role=${roleConfig.role} executionLocks=${heldRoles} `
      + `backendPid=${lockHandle.backendPid ?? 'none'}`,
    );
  } catch {
    // Runtime ownership is already established; logging is observational only.
  }
}

/**
 * Prepare one P2-C independent process without registering HTTP, Cron, or AI
 * timers. Independent roles only verify an already-migrated database; they do
 * not run migrations or bootstrap writes before P2-D provides a maintenance
 * owner.
 */
export async function prepareIndependentProcess({
  expectedRole,
  entrypoint,
  env = process.env,
  logger = console,
  onLockLost,
  resolveRole = resolveEntrypointProcessRole,
  acquireLocks = acquireProcessRoleLocks,
  connectDatabase = connectRuntimeDb,
  closeDatabase = closeDb,
} = {}) {
  if (!INDEPENDENT_RUNTIME_ROLES.has(expectedRole)) {
    throw new TypeError('expectedRole must be api, scheduler, or ai-media');
  }
  if (typeof onLockLost !== 'function') {
    throw new TypeError('onLockLost is required for an independent process');
  }

  const roleConfig = resolveRole({
    env,
    expectedRole,
    entrypoint,
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
    await connectDatabase();
  } catch (error) {
    try { await closeDatabase(); } catch {}
    await lockHandle.release();
    throw error;
  }

  logPreparedRole(logger, roleConfig, lockHandle);
  return Object.freeze({ roleConfig, lockHandle });
}
