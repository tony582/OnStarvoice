import crypto from 'node:crypto';
import pg from 'pg';

import {
  execute as dbExecute,
  getAllSettings,
  queryOne as dbQueryOne,
  withTransaction as dbWithTransaction,
} from '../db/init.js';
import {createDrainController} from '../runtime/drain-controller.js';
import {
  normalizeOpsControlSettings,
  resolveOpsControlActionsGlobalEnabled,
  resolveOpsControlGlobalEnabled,
  runOpsControlTenantObservation,
} from './ops-control.js';

const {Client} = pg;

export const OPS_CONTROL_WAKEUP_CHANNEL = 'ops_control_wakeup';
export const OPS_CONTROL_WAKEUP_LEASE_SECONDS = 120;
export const OPS_CONTROL_WAKEUP_BATCH_LIMIT = 50;
export const OPS_CONTROL_WAKEUP_HEARTBEAT_MS = 60_000;
export const OPS_CONTROL_WAKEUP_RECONNECT_MS = 2_000;
const OPS_CONTROL_WAKEUP_RETRY_MAX_MS = 5 * 60 * 1000;
const OPS_CONTROL_WAKEUP_RETENTION_DAYS = 7;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeLog(logger, method, message) {
  try {
    logger?.[method]?.(message);
  } catch {
    // Event delivery and durable queue state do not depend on logging.
  }
}

export async function enqueueOpsControlWakeup({
  tenantId,
  reason,
  sourceType = 'system',
  sourceId = '',
  dedupeKey = '',
  availableAt = new Date(),
  payload = {},
  replaceAvailable = false,
  queryOne = dbQueryOne,
} = {}) {
  const row = await queryOne(`
    SELECT enqueue_ops_control_wakeup(
      $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8
    ) AS id
  `, [
    tenantId,
    text(reason, 120),
    text(sourceType, 80) || 'system',
    text(sourceId, 240),
    text(dedupeKey, 320),
    new Date(availableAt).toISOString(),
    JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
    replaceAvailable === true,
  ]);
  return row?.id || null;
}

export async function claimOpsControlWakeups({
  now = new Date(),
  limit = OPS_CONTROL_WAKEUP_BATCH_LIMIT,
  leaseSeconds = OPS_CONTROL_WAKEUP_LEASE_SECONDS,
  claimToken = crypto.randomUUID(),
  withTransaction = dbWithTransaction,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(200, integer(limit, 50)));
  const boundedLeaseSeconds = Math.max(30, Math.min(900, integer(leaseSeconds, 120)));
  const wakeups = await withTransaction(tx => tx.queryAll(`
    WITH due AS (
      SELECT wakeup.id
      FROM ops_control_wakeups wakeup
      WHERE wakeup.processed_at IS NULL
        AND wakeup.available_at <= $1
        AND (
          wakeup.claim_token IS NULL
          OR wakeup.lease_expires_at <= $1
        )
      ORDER BY wakeup.available_at, wakeup.id
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    UPDATE ops_control_wakeups wakeup
    SET claim_token = $3::uuid,
      claimed_at = $1,
      lease_expires_at = $1::timestamptz + ($4::int * interval '1 second'),
      attempt_count = wakeup.attempt_count + 1,
      last_error = '',
      updated_at = $1
    FROM due
    WHERE wakeup.id = due.id
    RETURNING wakeup.*
  `, [
    new Date(now).toISOString(),
    boundedLimit,
    claimToken,
    boundedLeaseSeconds,
  ]));
  return Object.freeze({claimToken, wakeups});
}

export async function completeOpsControlWakeups({
  ids,
  claimToken,
  now = new Date(),
  execute = dbExecute,
} = {}) {
  const normalizedIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger);
  if (normalizedIds.length === 0) return 0;
  const result = await execute(`
    UPDATE ops_control_wakeups
    SET processed_at = $3,
      claim_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error = '',
      updated_at = $3
    WHERE id = ANY($1::bigint[])
      AND claim_token = $2::uuid
      AND processed_at IS NULL
  `, [normalizedIds, claimToken, new Date(now).toISOString()]);
  return integer(result?.changes);
}

export function opsControlWakeupRetryDelayMs(attemptCount) {
  const exponent = Math.min(6, Math.max(0, integer(attemptCount, 1) - 1));
  return Math.min(OPS_CONTROL_WAKEUP_RETRY_MAX_MS, 5_000 * (2 ** exponent));
}

export async function retryOpsControlWakeups({
  wakeups,
  claimToken,
  error,
  now = new Date(),
  execute = dbExecute,
} = {}) {
  const rows = Array.isArray(wakeups) ? wakeups : [];
  if (rows.length === 0) return 0;
  const attemptCount = Math.max(...rows.map(row => integer(row.attempt_count, 1)));
  const retryAt = new Date(new Date(now).getTime() + opsControlWakeupRetryDelayMs(attemptCount));
  const result = await execute(`
    UPDATE ops_control_wakeups
    SET available_at = $3,
      lease_expires_at = $3,
      last_error = $4,
      updated_at = $2
    WHERE id = ANY($1::bigint[])
      AND claim_token = $5::uuid
      AND processed_at IS NULL
  `, [
    rows.map(row => Number(row.id)),
    new Date(now).toISOString(),
    retryAt.toISOString(),
    text(error?.message || error, 2000),
    claimToken,
  ]);
  return integer(result?.changes);
}

export async function getNextOpsControlWakeupAt({queryOne = dbQueryOne} = {}) {
  const row = await queryOne(`
    SELECT MIN(
      CASE
        WHEN claim_token IS NULL THEN available_at
        ELSE GREATEST(available_at, lease_expires_at)
      END
    ) AS next_at
    FROM ops_control_wakeups
    WHERE processed_at IS NULL
  `);
  return row?.next_at ? new Date(row.next_at) : null;
}

export async function cleanupProcessedOpsControlWakeups({
  limit = 500,
  execute = dbExecute,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(5000, integer(limit, 500)));
  const result = await execute(`
    DELETE FROM ops_control_wakeups
    WHERE id IN (
      SELECT id
      FROM ops_control_wakeups
      WHERE processed_at < now() - ($1::int * interval '1 day')
      ORDER BY processed_at, id
      LIMIT $2
    )
  `, [OPS_CONTROL_WAKEUP_RETENTION_DAYS, boundedLimit]);
  return integer(result?.changes);
}

export function buildOpsControlEventWake(wakeups = []) {
  const rows = Array.isArray(wakeups) ? wakeups : [];
  const reasons = [...new Set(rows.map(row => text(row.reason, 120)).filter(Boolean))];
  const sourceTypes = [...new Set(rows.map(row => text(row.source_type, 80)).filter(Boolean))];
  return Object.freeze({
    reason: reasons.length === 1 ? reasons[0] : 'multiple_events',
    reasons: Object.freeze(reasons),
    sourceTypes: Object.freeze(sourceTypes),
    eventCount: rows.length,
    firstEventAt: rows
      .map(row => row.created_at)
      .filter(Boolean)
      .sort((left, right) => timestamp(left) - timestamp(right))[0] || null,
  });
}

export function shouldScheduleOpsControlFollowup(result) {
  if (result?.kind !== 'observed') return false;
  if (result.assessment?.summary?.consecutiveEvidence !== true) return true;
  if (integer(result.assessment?.summary?.activeTaskCount) > 0) return true;
  if (integer(result.activation?.activeCommandCount) > 0) return true;
  if (integer(result.activation?.pendingActionCount) > 0) return true;
  if (integer(result.actions?.pendingVerification) > 0) return true;
  return ['observing', 'progressing', 'recovering'].includes(
    text(result.assessment?.lifecycleStatus, 80),
  );
}

async function observeWakeupTenant({
  tenantId,
  wakeups,
  now,
  env,
  getSettings = getAllSettings,
  observeTenant = runOpsControlTenantObservation,
} = {}) {
  if (!resolveOpsControlGlobalEnabled(env)) {
    return {result: {kind: 'global_disabled', tenantId}, policy: null};
  }
  const policy = normalizeOpsControlSettings(await getSettings(tenantId), {env});
  if (!policy.enabled) {
    return {result: {kind: 'disabled', tenantId}, policy};
  }
  const result = await observeTenant({
    tenantId,
    settings: policy,
    now,
    eventWake: buildOpsControlEventWake(wakeups),
  });
  return {result, policy};
}

export async function processOpsControlWakeupBatch({
  now = new Date(),
  env = process.env,
  claimWakeups = claimOpsControlWakeups,
  completeWakeups = completeOpsControlWakeups,
  retryWakeups = retryOpsControlWakeups,
  enqueueWakeup = enqueueOpsControlWakeup,
  observeTenant = observeWakeupTenant,
  cleanupWakeups = cleanupProcessedOpsControlWakeups,
} = {}) {
  const claimed = await claimWakeups({now});
  const wakeups = Array.isArray(claimed?.wakeups) ? claimed.wakeups : [];
  if (wakeups.length === 0) {
    return Object.freeze({claimed: 0, tenants: 0, observed: 0, failed: 0, results: []});
  }

  const byTenant = new Map();
  for (const wakeup of wakeups) {
    const tenantId = text(wakeup.tenant_id, 100);
    if (!byTenant.has(tenantId)) byTenant.set(tenantId, []);
    byTenant.get(tenantId).push(wakeup);
  }

  const results = [];
  let observed = 0;
  let failed = 0;
  let followups = 0;
  for (const [tenantId, tenantWakeups] of byTenant) {
    try {
      const outcome = await observeTenant({
        tenantId,
        wakeups: tenantWakeups,
        now: new Date(now),
        env,
      });
      const result = outcome?.result || outcome;
      const policy = outcome?.policy || null;
      if (result?.kind === 'observed') observed += 1;
      if (shouldScheduleOpsControlFollowup(result) && policy) {
        const delaySeconds = Math.max(25, integer(policy.snapshotGapSeconds, 25));
        await enqueueWakeup({
          tenantId,
          reason: 'observation_followup',
          sourceType: 'ops_control_run',
          sourceId: result.run?.id || '',
          dedupeKey: 'observation-followup',
          availableAt: new Date(new Date(now).getTime() + delaySeconds * 1000),
          payload: {
            previousSequence: integer(result.sequence),
            lifecycleStatus: result.assessment?.lifecycleStatus || '',
            verdict: result.assessment?.verdict || '',
          },
          replaceAvailable: true,
        });
        followups += 1;
      }
      await completeWakeups({
        ids: tenantWakeups.map(row => row.id),
        claimToken: claimed.claimToken,
        now,
      });
      results.push({tenantId, kind: result?.kind || 'unknown', result});
    } catch (error) {
      failed += 1;
      await retryWakeups({
        wakeups: tenantWakeups,
        claimToken: claimed.claimToken,
        error,
        now,
      });
      results.push({tenantId, kind: 'failed', error});
    }
  }

  try { await cleanupWakeups({limit: 500}); } catch {}
  const oldestCreatedAt = Math.min(
    ...wakeups.map(row => timestamp(row.created_at)).filter(value => value > 0),
  );
  return Object.freeze({
    claimed: wakeups.length,
    tenants: byTenant.size,
    observed,
    failed,
    followups,
    eventLatencyMs: Number.isFinite(oldestCreatedAt)
      ? Math.max(0, new Date(now).getTime() - oldestCreatedAt)
      : null,
    results,
  });
}

export async function recordOpsControlWakeupWorkerState({
  status,
  now = new Date(),
  env = process.env,
  details = {},
  error,
  execute = dbExecute,
} = {}) {
  const normalizedStatus = ['running', 'healthy', 'degraded', 'failed', 'disabled']
    .includes(status)
    ? status
    : 'degraded';
  const succeeded = ['healthy', 'disabled'].includes(normalizedStatus);
  const failed = ['degraded', 'failed'].includes(normalizedStatus);
  const at = new Date(now).toISOString();
  const mode = resolveOpsControlActionsGlobalEnabled(env) ? 'guarded' : 'observe';
  await execute(`
    INSERT INTO ops_control_system_state (
      component, status, mode, cycle_sequence,
      last_started_at, last_succeeded_at, last_failed_at,
      last_error_code, last_error, details, updated_at
    ) VALUES (
      'event_listener', $1, $2, 1,
      $3, $4, $5,
      $6, $7, $8::jsonb, $3
    )
    ON CONFLICT (component)
    DO UPDATE SET
      status = excluded.status,
      mode = excluded.mode,
      cycle_sequence = ops_control_system_state.cycle_sequence + 1,
      last_started_at = COALESCE(ops_control_system_state.last_started_at, excluded.last_started_at),
      last_succeeded_at = CASE
        WHEN $9::boolean THEN excluded.last_succeeded_at
        ELSE ops_control_system_state.last_succeeded_at
      END,
      last_failed_at = CASE
        WHEN $10::boolean THEN excluded.last_failed_at
        ELSE ops_control_system_state.last_failed_at
      END,
      last_error_code = excluded.last_error_code,
      last_error = excluded.last_error,
      details = ops_control_system_state.details || excluded.details,
      updated_at = excluded.updated_at
  `, [
    normalizedStatus,
    mode,
    at,
    succeeded ? at : null,
    failed ? at : null,
    failed ? text(error?.code || 'OPS_CONTROL_EVENT_LISTENER_DEGRADED', 200) : '',
    failed ? text(error?.message || error, 2000) : '',
    JSON.stringify({
      eventDriven: true,
      globalEnabled: resolveOpsControlGlobalEnabled(env),
      actionsGlobalEnabled: resolveOpsControlActionsGlobalEnabled(env),
      ...details,
    }),
    succeeded,
    failed,
  ]);
}

export async function openPostgresOpsControlListener({
  channel = OPS_CONTROL_WAKEUP_CHANNEL,
  env = process.env,
  onNotification,
  onError,
} = {}) {
  if (channel !== OPS_CONTROL_WAKEUP_CHANNEL) {
    throw new TypeError('Unsupported operations-control notification channel');
  }
  const client = new Client({
    connectionString: env.DATABASE_URL
      || 'postgres://onstarvoice:onstarvoice@localhost:5432/onstarvoice',
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS || 5000),
    application_name: 'onstarvoice_ops_control_wakeup',
  });
  let closing = false;
  const handleNotification = message => {
    if (!closing && message.channel === channel) onNotification?.(message.payload || '');
  };
  const handleError = error => {
    if (!closing) onError?.(error);
  };
  const handleEnd = () => {
    if (closing) return;
    const error = new Error('PostgreSQL operations-control listener ended unexpectedly');
    error.code = 'OPS_CONTROL_EVENT_LISTENER_ENDED';
    onError?.(error);
  };
  client.on('notification', handleNotification);
  client.on('error', handleError);
  client.on('end', handleEnd);
  try {
    await client.connect();
    await client.query(`LISTEN ${OPS_CONTROL_WAKEUP_CHANNEL}`);
  } catch (error) {
    closing = true;
    try { await client.end(); } catch {}
    client.removeListener('notification', handleNotification);
    client.removeListener('error', handleError);
    client.removeListener('end', handleEnd);
    throw error;
  }

  let closePromise;
  return Object.freeze({
    close() {
      closePromise ||= (async () => {
        closing = true;
        try { await client.query(`UNLISTEN ${OPS_CONTROL_WAKEUP_CHANNEL}`); } catch {}
        try { await client.end(); } catch {}
        client.removeListener('notification', handleNotification);
        client.removeListener('error', handleError);
        client.removeListener('end', handleEnd);
      })();
      return closePromise;
    },
  });
}

export function startOpsControlWakeupRuntime({
  env = process.env,
  logger = console,
  openListener = openPostgresOpsControlListener,
  processBatch = processOpsControlWakeupBatch,
  getNextWakeupAt = getNextOpsControlWakeupAt,
  recordState = recordOpsControlWakeupWorkerState,
  createDrain = createDrainController,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => new Date(),
} = {}) {
  const drainController = createDrain({setTimer, clearTimer});
  const stateWrites = new Set();
  let accepting = true;
  let listener = null;
  let connecting = null;
  let closeListenerPromise = null;
  let dueTimer = null;
  let dueTimerAt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let drainPromise = null;
  let listenerFailurePromise = null;
  let stopPromise = null;
  let connectedAt = null;
  let lastNotificationAt = null;

  function writeState(input) {
    const pending = Promise.resolve(recordState({...input, env}))
      .catch(error => safeLog(
        logger,
        'error',
        `[OpsControlWakeup] state update failed: ${error?.message || error}`,
      ));
    stateWrites.add(pending);
    pending.finally(() => stateWrites.delete(pending));
    return pending;
  }

  function clearScheduledTimer(kind) {
    if (kind === 'due' && dueTimer !== null) {
      clearTimer(dueTimer);
      dueTimer = null;
      dueTimerAt = 0;
    }
    if (kind === 'reconnect' && reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    if (kind === 'heartbeat' && heartbeatTimer !== null) {
      clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function requestDrainAt(targetAt) {
    if (!accepting) return;
    const targetMs = Math.max(Date.now(), timestamp(targetAt));
    if (dueTimer !== null && dueTimerAt <= targetMs) return;
    clearScheduledTimer('due');
    dueTimerAt = targetMs;
    dueTimer = setTimer(() => {
      dueTimer = null;
      dueTimerAt = 0;
      void drainController.run(drainDueWakeups);
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, targetMs - Date.now())));
  }

  async function scheduleNextDueWakeup() {
    if (!accepting) return;
    try {
      const nextAt = await getNextWakeupAt();
      if (nextAt) requestDrainAt(nextAt);
    } catch (error) {
      safeLog(logger, 'error', `[OpsControlWakeup] next wakeup lookup failed: ${error?.message || error}`);
      requestDrainAt(new Date(Date.now() + OPS_CONTROL_WAKEUP_RECONNECT_MS));
    }
  }

  async function drainDueWakeups() {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      let aggregate = {claimed: 0, tenants: 0, observed: 0, failed: 0, followups: 0};
      while (accepting) {
        const summary = await processBatch({now: now(), env});
        aggregate = {
          claimed: aggregate.claimed + integer(summary.claimed),
          tenants: aggregate.tenants + integer(summary.tenants),
          observed: aggregate.observed + integer(summary.observed),
          failed: aggregate.failed + integer(summary.failed),
          followups: aggregate.followups + integer(summary.followups),
          eventLatencyMs: summary.eventLatencyMs ?? aggregate.eventLatencyMs ?? null,
        };
        if (integer(summary.claimed) < OPS_CONTROL_WAKEUP_BATCH_LIMIT) break;
      }
      if (aggregate.claimed > 0) {
        safeLog(
          logger,
          'log',
          `[OpsControlWakeup] ${aggregate.claimed} event(s), `
            + `${aggregate.observed} tenant observation(s), ${aggregate.failed} failed`,
        );
        await writeState({
          status: aggregate.failed > 0 ? 'degraded' : 'healthy',
          now: now(),
          details: {
            connected: Boolean(listener),
            connectedAt,
            lastNotificationAt,
            lastBatchAt: now().toISOString(),
            ...aggregate,
          },
        });
      }
      return aggregate;
    })().catch(async error => {
      safeLog(logger, 'error', `[OpsControlWakeup] drain failed: ${error?.message || error}`);
      await writeState({
        status: 'degraded',
        now: now(),
        error,
        details: {connected: Boolean(listener), connectedAt, lastNotificationAt},
      });
      requestDrainAt(new Date(Date.now() + OPS_CONTROL_WAKEUP_RECONNECT_MS));
      return {claimed: 0, failed: 1};
    }).finally(async () => {
      drainPromise = null;
      await scheduleNextDueWakeup();
    });
    return drainPromise;
  }

  function scheduleHeartbeat() {
    if (!accepting) return;
    clearScheduledTimer('heartbeat');
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      void writeState({
        status: listener ? 'healthy' : 'degraded',
        now: now(),
        error: listener ? null : new Error('PostgreSQL wakeup listener disconnected'),
        details: {connected: Boolean(listener), connectedAt, lastNotificationAt},
      });
      scheduleHeartbeat();
    }, OPS_CONTROL_WAKEUP_HEARTBEAT_MS);
  }

  function scheduleReconnect() {
    if (!accepting || reconnectTimer !== null) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect();
    }, OPS_CONTROL_WAKEUP_RECONNECT_MS);
  }

  function handleListenerFailure(error) {
    if (listenerFailurePromise) return listenerFailurePromise;
    listenerFailurePromise = (async () => {
      const staleListener = listener;
      listener = null;
      connectedAt = null;
      if (staleListener) {
        try { await staleListener.close(); } catch {}
      }
      await writeState({
        status: 'degraded',
        now: now(),
        error,
        details: {connected: false, lastNotificationAt},
      });
      scheduleReconnect();
    })().finally(() => {
      listenerFailurePromise = null;
    });
    return listenerFailurePromise;
  }

  function connect() {
    if (!accepting || listener || connecting) return connecting;
    connecting = Promise.resolve(openListener({
      channel: OPS_CONTROL_WAKEUP_CHANNEL,
      env,
      onNotification() {
        lastNotificationAt = now().toISOString();
        requestDrainAt(now());
      },
      onError(error) {
        void handleListenerFailure(error);
      },
    })).then(async opened => {
      if (!accepting) {
        await opened.close();
        return null;
      }
      listener = opened;
      connectedAt = now().toISOString();
      await writeState({
        status: 'healthy',
        now: now(),
        details: {connected: true, connectedAt, channel: OPS_CONTROL_WAKEUP_CHANNEL},
      });
      requestDrainAt(now());
      scheduleHeartbeat();
      return opened;
    }).catch(async error => {
      safeLog(logger, 'error', `[OpsControlWakeup] listener connect failed: ${error?.message || error}`);
      await writeState({
        status: 'degraded',
        now: now(),
        error,
        details: {connected: false},
      });
      scheduleReconnect();
      return null;
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  }

  void writeState({
    status: 'running',
    now: now(),
    details: {connected: false, channel: OPS_CONTROL_WAKEUP_CHANNEL},
  });
  void connect();

  function stopNewWork() {
    if (!accepting) return false;
    accepting = false;
    clearScheduledTimer('due');
    clearScheduledTimer('reconnect');
    clearScheduledTimer('heartbeat');
    drainController.stopAccepting();
    const activeListener = listener;
    listener = null;
    if (activeListener) closeListenerPromise = activeListener.close();
    return true;
  }

  async function drain(options = {}) {
    stopNewWork();
    if (connecting) await connecting;
    if (listenerFailurePromise) await listenerFailurePromise;
    if (closeListenerPromise) await closeListenerPromise;
    const result = await drainController.waitForIdle(options);
    await Promise.allSettled([...stateWrites]);
    return Object.freeze({name: 'ops-control-wakeup', ...result});
  }

  function stop(options = {}) {
    stopPromise ||= drain(options);
    return stopPromise;
  }

  return Object.freeze({
    kind: 'ops-control-wakeup',
    stopNewWork,
    drain,
    stop,
    snapshot() {
      return Object.freeze({
        accepting,
        connected: Boolean(listener),
        connectedAt,
        lastNotificationAt,
        inFlight: drainController.inFlightCount,
      });
    },
  });
}
