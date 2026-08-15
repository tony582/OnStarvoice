import { resolveEntrypointProcessRole } from '../config/process-role.js';
import { closeDb } from '../db/init.js';
import { acquireProcessRoleLocks } from '../runtime/process-role-locks.js';
import {
  createMaintenanceTaskRegistry,
  getMaintenanceTask,
  MAINTENANCE_TASK_IDS,
  STARTUP_RECONCILE_TASK_IDS,
} from './registry.js';
import { createMaintenanceRunner, MaintenanceTaskError } from './runner.js';

const ENTRYPOINT = 'server/entrypoints/maintenance.js';

export class MaintenanceCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaintenanceCliUsageError';
    this.code = 'MAINTENANCE_CLI_USAGE';
  }
}

export function maintenanceUsage() {
  return [
    'Usage:',
    '  npm run maintenance -- migrate [--adopt-v066-checksums]',
    '  npm run maintenance -- verify',
    '  npm run maintenance -- run <task-id>',
    '  npm run maintenance -- startup-reconcile',
    '  npm run maintenance -- bootstrap-admin',
    '',
    'Production commands require an explicit non-empty DATABASE_URL.',
    'Tasks that touch runtime-owned data require MAINTENANCE_OFFLINE_CONFIRMED=1.',
    'Only task ids compiled into the maintenance registry are accepted.',
  ].join('\n');
}

export function assertProductionDatabaseUrl(env) {
  if (String(env?.NODE_ENV || '').trim().toLowerCase() !== 'production') return;
  if (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim()) return;
  throw new MaintenanceTaskError(
    'MAINTENANCE_DATABASE_URL_REQUIRED',
    'Production maintenance requires an explicit non-empty DATABASE_URL.',
  );
}

export function parseMaintenanceCommand(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const args = argv.map(value => String(value));
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    if (rest.length > 0) throw new MaintenanceCliUsageError('Help accepts no arguments.');
    return Object.freeze({ command: 'help' });
  }

  if (command === 'migrate') {
    if (rest.length === 0) {
      return Object.freeze({ command, adoptLegacyChecksums: false });
    }
    if (rest.length === 1 && rest[0] === '--adopt-v066-checksums') {
      return Object.freeze({ command, adoptLegacyChecksums: true });
    }
    throw new MaintenanceCliUsageError('migrate accepts only --adopt-v066-checksums.');
  }

  if (command === 'verify' || command === 'startup-reconcile' || command === 'bootstrap-admin') {
    if (rest.length > 0) {
      throw new MaintenanceCliUsageError(`${command} accepts no arguments.`);
    }
    return Object.freeze({ command });
  }

  if (command === 'run') {
    if (rest.length !== 1 || !rest[0].trim()) {
      throw new MaintenanceCliUsageError('run requires exactly one allowlisted task id.');
    }
    return Object.freeze({ command, taskId: rest[0].trim() });
  }

  throw new MaintenanceCliUsageError('Unknown maintenance command.');
}

let migrationModulePromise;
function loadMigrationModule() {
  migrationModulePromise ||= import('../db/migrate.js');
  return migrationModulePromise;
}

async function defaultRunMigrations(options) {
  const module = await loadMigrationModule();
  return module.runMigrations(options);
}

async function defaultVerifyMigrations(options) {
  const module = await loadMigrationModule();
  const verify = module.verifyMigrations
    || module.verifyMigrationState
    || module.verifyMigrationChecksums;
  if (typeof verify !== 'function') {
    const error = new Error('Migration verification is not available in the current migration core.');
    error.code = 'MIGRATION_VERIFY_UNAVAILABLE';
    throw error;
  }
  return verify(options);
}

const DEFAULT_MIGRATION_CORE = Object.freeze({
  runMigrations: defaultRunMigrations,
  verifyMigrations: defaultVerifyMigrations,
});

function safeLog(logger, method, ...args) {
  try {
    logger?.[method]?.(...args);
  } catch {
    // Exit status and cleanup must not depend on custom logging.
  }
}

function errorExitCode(error) {
  return error instanceof MaintenanceCliUsageError ? 2 : 1;
}

function cleanupFailure(outcome, error, label, logger) {
  safeLog(logger, 'error', `[Maintenance] ${label}: ${error?.message || error}`);
  const combinedError = outcome?.error
    ? new AggregateError([outcome.error, error], `Maintenance command and ${label} both failed`)
    : error;
  return {
    exitCode: 1,
    command: outcome?.command || null,
    error: combinedError,
  };
}

export async function runMaintenanceCli({
  argv = process.argv.slice(2),
  env = process.env,
  logger = console,
  resolveRole = resolveEntrypointProcessRole,
  migrationCore = DEFAULT_MIGRATION_CORE,
  registry = createMaintenanceTaskRegistry({ logger }),
  runner = null,
  closeDatabase = closeDb,
  acquireExecutionLocks = acquireProcessRoleLocks,
  exitProcess = code => process.exit(code),
} = {}) {
  let parsedCommand = null;
  let outcome = null;
  let executionLock = null;
  let databaseMayBeOpen = false;
  let databaseCloseFailed = false;
  try {
    parsedCommand = parseMaintenanceCommand(argv);
    if (parsedCommand.command === 'help') {
      safeLog(logger, 'log', maintenanceUsage());
      outcome = { exitCode: 0, command: 'help' };
    } else {
      resolveRole({
        env,
        expectedRole: 'maintenance',
        entrypoint: ENTRYPOINT,
        onWarning(warning) {
          safeLog(logger, 'warn', `[ProcessRole] ${warning.message}`);
        },
      });

      let selectedTask = null;
      const requiresOfflineTopology = parsedCommand.command === 'startup-reconcile'
        || (parsedCommand.command === 'run'
          && (selectedTask = getMaintenanceTask(registry, parsedCommand.taskId))
            .requiresOfflineTopology);
      const offlineConfirmed = env.MAINTENANCE_OFFLINE_CONFIRMED === '1';
      if (requiresOfflineTopology && !offlineConfirmed) {
        throw new MaintenanceTaskError(
          'MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED',
          'Offline maintenance requires MAINTENANCE_OFFLINE_CONFIRMED=1.',
        );
      }
      assertProductionDatabaseUrl(env);
      if (requiresOfflineTopology) {
        executionLock = await acquireExecutionLocks({
          role: 'all',
          databaseUrl: env.DATABASE_URL,
          applicationName: `onstarvoice:maintenance-offline:${process.pid}`,
          connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
          logger,
          onLockLost(details) {
            safeLog(
              logger,
              'error',
              `[Maintenance] lost offline execution authority (${details?.event || 'unknown'}); exiting.`,
            );
            exitProcess(1);
          },
        });
      }

      if (parsedCommand.command === 'migrate') {
        databaseMayBeOpen = true;
        const result = await migrationCore.runMigrations({
          adoptLegacyChecksums: parsedCommand.adoptLegacyChecksums,
        });
        safeLog(logger, 'log', '[Maintenance] migrations complete');
        outcome = { exitCode: 0, command: 'migrate', result };
      } else if (parsedCommand.command === 'verify') {
        databaseMayBeOpen = true;
        const result = await migrationCore.verifyMigrations();
        safeLog(logger, 'log', '[Maintenance] migration verification complete');
        outcome = { exitCode: 0, command: 'verify', result };
      } else {
        databaseMayBeOpen = true;
        await migrationCore.verifyMigrations();
        const activeRunner = runner || createMaintenanceRunner({ registry });
        const taskOptions = Object.freeze({
          source: 'cli',
          offlineConfirmed,
        });

        if (parsedCommand.command === 'run') {
          selectedTask ||= getMaintenanceTask(registry, parsedCommand.taskId);
          const result = await activeRunner.runTask(selectedTask.id, taskOptions);
          safeLog(logger, 'log', `[Maintenance] task ${selectedTask.id} ${result.status}`);
          outcome = { exitCode: 0, command: 'run', result };
        } else if (parsedCommand.command === 'startup-reconcile') {
          const result = await activeRunner.runTasks(STARTUP_RECONCILE_TASK_IDS, taskOptions);
          safeLog(logger, 'log', '[Maintenance] startup reconciliation complete');
          outcome = { exitCode: 0, command: 'startup-reconcile', result };
        } else {
          const taskId = MAINTENANCE_TASK_IDS.BOOTSTRAP_ADMIN;
          const result = await activeRunner.runTask(taskId, taskOptions);
          safeLog(logger, 'log', `[Maintenance] task ${taskId} ${result.status}`);
          outcome = { exitCode: 0, command: 'bootstrap-admin', result };
        }
      }
    }
  } catch (error) {
    const exitCode = errorExitCode(error);
    safeLog(logger, 'error', `[Maintenance] ${error?.code || 'FAILED'}: ${error?.message || error}`);
    if (error instanceof MaintenanceCliUsageError) safeLog(logger, 'error', maintenanceUsage());
    outcome = {
      exitCode,
      command: parsedCommand?.command || null,
      error,
    };
  } finally {
    if (databaseMayBeOpen) {
      try {
        await closeDatabase();
      } catch (error) {
        databaseCloseFailed = true;
        outcome = cleanupFailure(outcome, error, 'database close failed', logger);
      }
    }
    // Execution authority is the final shutdown fence. If the ordinary pool
    // cannot be proven closed, keep the session locks until fail-fast process
    // exit instead of allowing another runtime to start alongside this one.
    if (executionLock && !databaseCloseFailed) {
      try {
        await executionLock.release();
      } catch (error) {
        outcome = cleanupFailure(outcome, error, 'execution-lock release failed', logger);
      }
    }
  }
  if (databaseCloseFailed) exitProcess(1);
  return Object.freeze(outcome || { exitCode: 1, command: null });
}
