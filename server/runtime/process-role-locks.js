import pg from 'pg';

import { isProcessRole } from '../config/process-role.js';

const { Client } = pg;

const LOCK_NAMESPACE = 'onstarvoice:process-role:v1';
const DEFAULT_DATABASE_URL = 'postgres://onstarvoice:onstarvoice@localhost:5432/onstarvoice';
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_KEEPALIVE_INITIAL_DELAY_MS = 5000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ROLE_LOCKS = Object.freeze({
  all: Object.freeze(['scheduler', 'ai-media']),
  api: Object.freeze([]),
  scheduler: Object.freeze(['scheduler']),
  'ai-media': Object.freeze(['ai-media']),
  maintenance: Object.freeze([]),
});

const TRY_LOCK_SQL = `
  SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired
`;
const UNLOCK_SQL = `
  SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released
`;
const HEARTBEAT_SQL = `
  SELECT 1 AS process_role_lock_heartbeat
`;

export class ProcessRoleLockUnavailableError extends Error {
  constructor({ requestedRole, contendedRole, heldRoles = [] }) {
    super(`PostgreSQL process-role lock is already held: ${contendedRole}`);
    this.name = 'ProcessRoleLockUnavailableError';
    this.code = 'PROCESS_ROLE_LOCK_UNAVAILABLE';
    this.requestedRole = requestedRole;
    this.contendedRole = contendedRole;
    this.heldRoles = [...heldRoles];
  }
}

function normalizeRole(role) {
  const normalized = typeof role === 'string' ? role.trim() : '';
  if (!isProcessRole(normalized) || !Object.hasOwn(ROLE_LOCKS, normalized)) {
    throw new TypeError(`Unsupported process role: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function parsePositiveInteger(value, defaultValue, label) {
  const candidate = value !== undefined ? value : defaultValue;
  const parsed = typeof candidate === 'number'
    ? candidate
    : (/^[1-9]\d*$/u.test(String(candidate)) ? Number(candidate) : Number.NaN);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseConnectionTimeoutMillis(value) {
  return parsePositiveInteger(
    value,
    process.env.PG_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    'connectionTimeoutMillis',
  );
}

function queryWithTimeout(client, text, values, queryTimeoutMillis) {
  return client.query({
    text,
    values,
    query_timeout: queryTimeoutMillis,
  });
}

function clearHeartbeatTimer(state) {
  if (!state.heartbeatTimer) return;
  clearTimeout(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function closeClientOnce(state, client) {
  state.closePromise ||= Promise.resolve()
    .then(() => client.end())
    .catch(() => {
      // A broken/closed PostgreSQL session has already released its locks.
    });
  return state.closePromise;
}

function logError(logger, message) {
  try {
    logger?.error?.(message);
  } catch {
    // Lock-loss handling must not depend on a custom logger staying healthy.
  }
}

function createNoopHandle(role) {
  const heldRoles = Object.freeze([]);
  let releasePromise;

  return Object.freeze({
    role,
    backendPid: null,
    heldRoles,
    release() {
      releasePromise ||= Promise.resolve();
      return releasePromise;
    },
  });
}

async function closeAfterFailedAcquisition(
  client,
  acquiredRoles,
  state,
  queryTimeoutMillis,
) {
  clearHeartbeatTimer(state);
  state.phase = 'releasing';
  for (const acquiredRole of [...acquiredRoles].reverse()) {
    try {
      await queryWithTimeout(
        client,
        UNLOCK_SQL,
        [LOCK_NAMESPACE, acquiredRole],
        queryTimeoutMillis,
      );
    } catch {
      // Closing the dedicated session below also releases every session lock.
      break;
    }
  }

  await closeClientOnce(state, client);
  state.phase = 'released';
}

function notifyLockLostOnce({
  state,
  role,
  heldRoles,
  backendPid,
  event,
  error,
  logger,
  onLockLost,
}) {
  if (state.phase === 'acquiring') {
    state.acquisitionLoss ||= { event, error };
    return;
  }
  if (state.phase !== 'held' || state.lockLostNotified) return;
  state.lockLostNotified = true;
  state.phase = 'lost';
  clearHeartbeatTimer(state);

  logError(logger, `[ProcessRoleLocks] PostgreSQL lock connection lost for role ${role}.`);

  try {
    const result = onLockLost?.({
      role,
      heldRoles: [...heldRoles],
      backendPid,
      event,
      error,
    });
    Promise.resolve(result).catch(() => {
      logError(logger, `[ProcessRoleLocks] onLockLost callback failed for role ${role}.`);
    });
  } catch {
    logError(logger, `[ProcessRoleLocks] onLockLost callback failed for role ${role}.`);
  }
}

function scheduleHeartbeat({
  state,
  client,
  role,
  acquiredRoles,
  getBackendPid,
  heartbeatIntervalMillis,
  queryTimeoutMillis,
  logger,
  onLockLost,
}) {
  if (state.phase !== 'held' || state.heartbeatTimer) return;

  state.heartbeatTimer = setTimeout(async () => {
    state.heartbeatTimer = null;
    if (state.phase !== 'held') return;

    try {
      await queryWithTimeout(client, HEARTBEAT_SQL, [], queryTimeoutMillis);
    } catch (error) {
      if (state.phase !== 'held') return;
      notifyLockLostOnce({
        state,
        role,
        heldRoles: acquiredRoles,
        backendPid: getBackendPid(),
        event: 'heartbeat',
        error,
        logger,
        onLockLost,
      });
      void closeClientOnce(state, client);
      return;
    }

    scheduleHeartbeat({
      state,
      client,
      role,
      acquiredRoles,
      getBackendPid,
      heartbeatIntervalMillis,
      queryTimeoutMillis,
      logger,
      onLockLost,
    });
  }, heartbeatIntervalMillis);
  state.heartbeatTimer.unref?.();
}

/**
 * Acquire the session advisory locks that fence a process role.
 *
 * Lock-owning roles use exactly one dedicated pg.Client. The returned release
 * function is idempotent. If PostgreSQL drops the lock-holding session before
 * a normal release, onLockLost is invoked at most once.
 */
export async function acquireProcessRoleLocks({
  role,
  databaseUrl,
  applicationName,
  connectionTimeoutMillis,
  queryTimeoutMillis,
  heartbeatIntervalMillis,
  keepAliveInitialDelayMillis,
  logger = console,
  onLockLost,
  createClient = options => new Client(options),
} = {}) {
  const normalizedRole = normalizeRole(role);
  const requiredLocks = ROLE_LOCKS[normalizedRole];
  if (onLockLost != null && typeof onLockLost !== 'function') {
    throw new TypeError('onLockLost must be a function when provided');
  }
  if (requiredLocks.length === 0) return createNoopHandle(normalizedRole);
  if (typeof onLockLost !== 'function') {
    throw new TypeError(`onLockLost is required for process role ${normalizedRole}`);
  }

  const connectionString = String(
    databaseUrl || process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  ).trim();
  const connectTimeout = parseConnectionTimeoutMillis(connectionTimeoutMillis);
  const queryTimeout = parsePositiveInteger(
    queryTimeoutMillis,
    DEFAULT_QUERY_TIMEOUT_MS,
    'queryTimeoutMillis',
  );
  const heartbeatInterval = parsePositiveInteger(
    heartbeatIntervalMillis,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    'heartbeatIntervalMillis',
  );
  const keepAliveInitialDelay = parsePositiveInteger(
    keepAliveInitialDelayMillis,
    DEFAULT_KEEPALIVE_INITIAL_DELAY_MS,
    'keepAliveInitialDelayMillis',
  );
  if (typeof createClient !== 'function') {
    throw new TypeError('createClient must be a function');
  }

  const client = createClient({
    connectionString,
    application_name: String(applicationName || '').trim()
      || `onstarvoice:${normalizedRole}:${process.pid}`,
    connectionTimeoutMillis: connectTimeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: keepAliveInitialDelay,
  });
  const acquiredRoles = [];
  const state = {
    phase: 'acquiring',
    acquisitionLoss: null,
    lockLostNotified: false,
    releasePromise: null,
    closePromise: null,
    heartbeatTimer: null,
  };
  let backendPid = null;

  client.on('error', error => {
    notifyLockLostOnce({
      state,
      role: normalizedRole,
      heldRoles: acquiredRoles,
      backendPid,
      event: 'error',
      error,
      logger,
      onLockLost,
    });
    if (state.phase === 'lost') void closeClientOnce(state, client);
  });
  client.on('end', () => {
    notifyLockLostOnce({
      state,
      role: normalizedRole,
      heldRoles: acquiredRoles,
      backendPid,
      event: 'end',
      error: null,
      logger,
      onLockLost,
    });
    if (state.phase === 'lost') void closeClientOnce(state, client);
  });

  try {
    await client.connect();
    backendPid = client.processID;

    for (const requiredRole of requiredLocks) {
      const result = await queryWithTimeout(
        client,
        TRY_LOCK_SQL,
        [LOCK_NAMESPACE, requiredRole],
        queryTimeout,
      );
      if (result.rows[0]?.acquired !== true) {
        const unavailable = new ProcessRoleLockUnavailableError({
          requestedRole: normalizedRole,
          contendedRole: requiredRole,
          heldRoles: acquiredRoles,
        });
        await closeAfterFailedAcquisition(
          client,
          acquiredRoles,
          state,
          queryTimeout,
        );
        throw unavailable;
      }
      acquiredRoles.push(requiredRole);
    }

    if (state.acquisitionLoss) {
      const connectionLost = new Error(
        `PostgreSQL lock connection was lost while acquiring role ${normalizedRole}`,
        { cause: state.acquisitionLoss.error || undefined },
      );
      connectionLost.code = 'PROCESS_ROLE_LOCK_CONNECTION_LOST';
      throw connectionLost;
    }
  } catch (error) {
    if (!(error instanceof ProcessRoleLockUnavailableError)) {
      await closeAfterFailedAcquisition(
        client,
        acquiredRoles,
        state,
        queryTimeout,
      );
    }
    throw error;
  }

  state.phase = 'held';
  const heldRoles = Object.freeze([...acquiredRoles]);
  scheduleHeartbeat({
    state,
    client,
    role: normalizedRole,
    acquiredRoles: heldRoles,
    getBackendPid: () => backendPid,
    heartbeatIntervalMillis: heartbeatInterval,
    queryTimeoutMillis: queryTimeout,
    logger,
    onLockLost,
  });

  const handle = {
    role: normalizedRole,
    backendPid,
    heldRoles,
    release() {
      if (state.releasePromise) return state.releasePromise;

      state.releasePromise = (async () => {
        const shouldUnlock = state.phase === 'held';
        state.phase = 'releasing';
        clearHeartbeatTimer(state);

        if (shouldUnlock) {
          for (const heldRole of [...heldRoles].reverse()) {
            try {
              await queryWithTimeout(
                client,
                UNLOCK_SQL,
                [LOCK_NAMESPACE, heldRole],
                queryTimeout,
              );
            } catch {
              // Ending the dedicated session is the final lock-release fence.
              break;
            }
          }
        }

        try {
          await closeClientOnce(state, client);
        } finally {
          state.phase = 'released';
        }
      })();

      return state.releasePromise;
    },
  };

  return Object.freeze(handle);
}
