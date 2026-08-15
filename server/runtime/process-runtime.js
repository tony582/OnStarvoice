import { closeDb, probeDbReadiness } from '../db/init.js';
import { prepareCompatibilityProcess } from './compatibility-process.js';
import { prepareIndependentProcess } from './independent-process.js';
import { createProcessHealth } from './process-health.js';
import { drainProcessBackgroundWork } from './process-background-work.js';

const RUNTIME_ROLES = new Set(['all', 'api', 'scheduler', 'ai-media']);
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function shutdownTimeout(value = process.env.PROCESS_SHUTDOWN_TIMEOUT_MS) {
  const candidate = value === undefined ? DEFAULT_SHUTDOWN_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_TIMER_DELAY_MS) {
    throw new TypeError('PROCESS_SHUTDOWN_TIMEOUT_MS must be a positive integer');
  }
  return candidate;
}

async function defaultStartApi(options) {
  const { startApiRuntime } = await import('./api-runtime.js');
  return startApiRuntime(options);
}

async function defaultStartScheduler(options) {
  const { startSchedulerRuntime } = await import('./scheduler-runtime.js');
  return startSchedulerRuntime(options);
}

async function defaultStartAiMedia(options) {
  const { startAiMediaRuntime } = await import('./ai-media-runtime.js');
  return startAiMediaRuntime(options);
}

const DEFAULT_RUNTIME_STARTERS = Object.freeze({
  api: defaultStartApi,
  scheduler: defaultStartScheduler,
  'ai-media': defaultStartAiMedia,
});
const DEFAULT_BACKGROUND_WORK = Object.freeze({
  drain: drainProcessBackgroundWork,
});

function rolesForProcess(role) {
  return role === 'all' ? ['scheduler', 'ai-media', 'api'] : [role];
}

async function stopStartedRuntime(runtime, options) {
  try {
    runtime.stopNewWork?.();
    if (typeof runtime.drain === 'function') return await runtime.drain(options);
    if (typeof runtime.stop === 'function') return await runtime.stop(options);
  } catch (error) {
    return { drained: false, error };
  }
  return { drained: true };
}

/**
 * Start one compatibility or independent process role.
 *
 * This module owns lifecycle ordering but not OS signals. Callers must keep
 * lock-loss fail-fast and invoke stop() for normal SIGINT/SIGTERM shutdown.
 */
export async function startRoleProcess({
  expectedRole,
  entrypoint,
  env = process.env,
  logger = console,
  onLockLost,
  prepareCompatibility = prepareCompatibilityProcess,
  prepareIndependent = prepareIndependentProcess,
  runtimeStarters = DEFAULT_RUNTIME_STARTERS,
  createHealth = createProcessHealth,
  readinessProbe = probeDbReadiness,
  closeDatabase = closeDb,
  backgroundWork = DEFAULT_BACKGROUND_WORK,
} = {}) {
  if (!RUNTIME_ROLES.has(expectedRole)) {
    throw new TypeError('expectedRole must be all, api, scheduler, or ai-media');
  }
  if (typeof onLockLost !== 'function') {
    throw new TypeError('onLockLost is required');
  }

  const health = createHealth({
    role: expectedRole,
    readinessProbe,
    readinessFailureReason: 'database_unavailable',
  });
  const notifyLockLost = details => {
    health.markFailed?.('process_role_lock_lost');
    return onLockLost(details);
  };

  let preparation;
  const startedRuntimes = [];
  try {
    preparation = expectedRole === 'all'
      ? await prepareCompatibility({ env, logger, onLockLost: notifyLockLost })
      : await prepareIndependent({
        expectedRole,
        entrypoint,
        env,
        logger,
        onLockLost: notifyLockLost,
      });

    for (const runtimeRole of rolesForProcess(preparation.roleConfig.role)) {
      const starter = runtimeStarters[runtimeRole];
      if (typeof starter !== 'function') {
        throw new TypeError(`Missing runtime starter for role ${runtimeRole}`);
      }
      const runtime = await starter({
        env,
        logger,
        health,
        compatibilityMode: preparation.roleConfig.role === 'all',
      });
      startedRuntimes.push(runtime);
    }

    health.markReady?.();
    logger?.info?.(`[ProcessRuntime] role=${preparation.roleConfig.role} ready`);
  } catch (error) {
    health.markFailed?.('startup_failed');
    const rollbackResults = [];
    for (const runtime of [...startedRuntimes].reverse()) {
      rollbackResults.push(
        await stopStartedRuntime(runtime, { timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS }),
      );
    }
    let backgroundResult = { drained: true };
    const runtimesRolledBack = rollbackResults.every(result => result?.drained !== false);
    if (preparation && runtimesRolledBack) {
      try {
        backgroundResult = await backgroundWork.drain({
          timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
        });
      } catch (backgroundError) {
        backgroundResult = { drained: false, error: backgroundError };
      }
    }
    const rollbackDrained = runtimesRolledBack && backgroundResult?.drained !== false;
    if (preparation && rollbackDrained) {
      let databaseClosed = false;
      try {
        await closeDatabase();
        databaseClosed = true;
      } catch (closeError) {
        logger?.error?.(
          `[ProcessRuntime] startup rollback database close failed: ${closeError?.message || closeError}`,
        );
      }
      if (databaseClosed) {
        try { await preparation.lockHandle.release(); } catch (releaseError) {
          logger?.error?.(
            `[ProcessRuntime] startup rollback lock release failed: ${releaseError?.message || releaseError}`,
          );
        }
      }
    } else if (preparation) {
      logger?.error?.(
        '[ProcessRuntime] startup rollback did not drain; retaining database and role locks until process exit.',
      );
    }
    throw error;
  }

  let stopPromise;
  function stop({ reason = 'shutdown', timeoutMs } = {}) {
    stopPromise ||= (async () => {
      const boundedTimeout = shutdownTimeout(timeoutMs);
      health.markDraining?.(reason);

      for (const runtime of [...startedRuntimes].reverse()) {
        try { runtime.stopNewWork?.(); } catch (error) {
          logger?.error?.(`[ProcessRuntime] stop-new-work failed: ${error?.message || error}`);
        }
      }

      const drainResults = await Promise.all(
        [...startedRuntimes].reverse().map(async runtime => {
          try {
            if (typeof runtime.drain === 'function') {
              return await runtime.drain({ timeoutMs: boundedTimeout });
            }
            if (typeof runtime.stop === 'function') {
              return await runtime.stop({ timeoutMs: boundedTimeout });
            }
            return { drained: true };
          } catch (error) {
            logger?.error?.(`[ProcessRuntime] drain failed: ${error?.message || error}`);
            return { drained: false, error };
          }
        }),
      );

      const runtimesDrained = drainResults.every(result => result?.drained !== false);
      let backgroundResult = Object.freeze({ drained: false, skipped: true });
      if (runtimesDrained) {
        try {
          backgroundResult = await backgroundWork.drain({ timeoutMs: boundedTimeout });
        } catch (error) {
          backgroundResult = Object.freeze({ drained: false, error });
          logger?.error?.(
            `[ProcessRuntime] background drain failed: ${error?.message || error}`,
          );
        }
      }
      const allWorkDrained = runtimesDrained && backgroundResult?.drained !== false;
      let closeError = null;
      let releaseError = null;
      let lockRetained = !allWorkDrained;

      if (!allWorkDrained) {
        logger?.error?.(
          '[ProcessRuntime] runtime/background drain incomplete; retaining database and role locks until process exit.',
        );
      } else {
        try {
          await closeDatabase();
        } catch (error) {
          closeError = error;
          lockRetained = true;
          logger?.error?.(`[ProcessRuntime] database close failed: ${error?.message || error}`);
        }

        // Execution authority is deliberately released last, and only after
        // every source of new work is drained and the ordinary pool is closed.
        if (!closeError) {
          try {
            await preparation.lockHandle.release();
          } catch (error) {
            releaseError = error;
            lockRetained = true;
            logger?.error?.(`[ProcessRuntime] role-lock release failed: ${error?.message || error}`);
          }
        }
      }

      const drained = allWorkDrained && !closeError && !releaseError;
      if (drained) health.markStopped?.();
      else health.markFailed?.('shutdown_incomplete');
      return Object.freeze({
        role: preparation.roleConfig.role,
        drained,
        drainResults: Object.freeze(drainResults),
        backgroundResult,
        closeError,
        releaseError,
        lockRetained,
      });
    })();
    return stopPromise;
  }

  return Object.freeze({
    role: preparation.roleConfig.role,
    roleConfig: preparation.roleConfig,
    lockHandle: preparation.lockHandle,
    health,
    runtimes: Object.freeze([...startedRuntimes]),
    stop,
  });
}
