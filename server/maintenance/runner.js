import pg from 'pg';

import { execute, queryOne } from '../db/query.js';
import {
  createMaintenanceTaskRegistry,
  getMaintenanceTask,
} from './registry.js';

const TASK_LOCK_NAMESPACE = 'onstarvoice:maintenance-task:v1';
const DEFAULT_DATABASE_URL = 'postgres://onstarvoice:onstarvoice@localhost:5432/onstarvoice';
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const MAX_ERROR_SUMMARY_LENGTH = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const { Client } = pg;

export class MaintenanceTaskError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MaintenanceTaskError';
    this.code = code;
  }
}

function errorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code.trim() : '';
  return candidate || 'MAINTENANCE_TASK_FAILED';
}

function errorSummary(error) {
  return String(error?.message || error || 'Maintenance task failed')
    .slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

function jsonSummary(value) {
  if (value === undefined) return '{}';
  const json = JSON.stringify(value);
  return json === undefined ? '{}' : json;
}

function positiveInteger(value, defaultValue, label) {
  const candidate = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return candidate;
}

function queryWithTimeout(client, text, values, queryTimeoutMillis) {
  return client.query({ text, values, query_timeout: queryTimeoutMillis });
}

export async function acquireMaintenanceTaskLock({
  task,
  databaseUrl = process.env.DATABASE_URL,
  connectionTimeoutMillis = process.env.PG_CONNECT_TIMEOUT_MS,
  queryTimeoutMillis = process.env.PG_QUERY_TIMEOUT_MS,
  createClient = options => new Client(options),
} = {}) {
  if (!task?.id || !task?.version) {
    throw new TypeError('task id and version are required for the maintenance lock');
  }
  if (typeof createClient !== 'function') {
    throw new TypeError('createClient must be a function');
  }
  const connectTimeout = positiveInteger(
    connectionTimeoutMillis,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    'connectionTimeoutMillis',
  );
  const queryTimeout = positiveInteger(
    queryTimeoutMillis,
    DEFAULT_QUERY_TIMEOUT_MS,
    'queryTimeoutMillis',
  );
  const client = createClient({
    connectionString: String(databaseUrl || DEFAULT_DATABASE_URL).trim(),
    application_name: `onstarvoice:maintenance-task:${task.id}:${process.pid}`,
    connectionTimeoutMillis: connectTimeout,
    keepAlive: true,
  });

  try {
    await client.connect();
    const result = await queryWithTimeout(
      client,
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
      [TASK_LOCK_NAMESPACE, `${task.id}:${task.version}`],
      queryTimeout,
    );
    if (result.rows[0]?.acquired !== true) {
      throw new MaintenanceTaskError(
        'MAINTENANCE_TASK_LOCK_UNAVAILABLE',
        `Maintenance task is already running: ${task.id}`,
      );
    }
  } catch (error) {
    try { await client.end(); } catch {}
    throw error;
  }

  let releasePromise;
  return Object.freeze({
    taskId: task.id,
    release() {
      releasePromise ||= (async () => {
        let unlockError = null;
        try {
          const result = await queryWithTimeout(
            client,
            'SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released',
            [TASK_LOCK_NAMESPACE, `${task.id}:${task.version}`],
            queryTimeout,
          );
          if (result.rows[0]?.released !== true) {
            unlockError = new MaintenanceTaskError(
              'MAINTENANCE_TASK_UNLOCK_FAILED',
              `Maintenance task lock was not held during release: ${task.id}`,
            );
          }
        } catch (error) {
          unlockError = error;
        }

        let closeError = null;
        try {
          await client.end();
        } catch (error) {
          closeError = error;
        }
        if (unlockError && closeError) {
          throw new AggregateError(
            [unlockError, closeError],
            `Maintenance task lock release and close failed: ${task.id}`,
          );
        }
        if (unlockError) throw unlockError;
        if (closeError) throw closeError;
      })();
      return releasePromise;
    },
  });
}

function defaultOwnerId(source) {
  return `onstarvoice:${source}:${process.pid}`;
}

export function createMaintenanceRunner({
  registry = createMaintenanceTaskRegistry(),
  findOne = queryOne,
  write = execute,
  acquireLock = acquireMaintenanceTaskLock,
} = {}) {
  async function completedRun(task) {
    return findOne(
      `SELECT id, status, result_summary, finished_at
       FROM maintenance_runs
       WHERE task_id = $1 AND task_version = $2
         AND run_kind = 'once' AND status IN ('succeeded', 'adopted')
       ORDER BY finished_at DESC
       LIMIT 1`,
      [task.id, task.version],
    );
  }

  async function interruptedRun(task) {
    if (!task.retryRequiresRestore) return null;
    return findOne(
      `SELECT id, status, error_code, error_summary, started_at, finished_at
       FROM maintenance_runs
       WHERE task_id = $1 AND task_version = $2
         AND run_kind = 'once'
         AND (
           status = 'running'
           OR (status = 'failed' AND NOT (error_code = ANY($3::text[])))
         )
       ORDER BY started_at DESC
       LIMIT 1`,
      [task.id, task.version, task.retryableFailureCodes || []],
    );
  }

  async function adoptLegacyMarker(task, { source, ownerId }) {
    if (!task.legacyMarker) return null;
    const marker = await findOne(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [task.legacyMarker],
    );
    if (!marker) return null;

    const adopted = await findOne(
      `INSERT INTO maintenance_runs (
         task_id, task_version, run_kind, status, source, owner_id,
         legacy_marker, result_summary, finished_at
       )
       VALUES ($1, $2, 'once', 'adopted', $3, $4, $5, $6::jsonb, now())
       ON CONFLICT DO NOTHING
       RETURNING id, status, result_summary, finished_at`,
      [
        task.id,
        task.version,
        source,
        ownerId,
        task.legacyMarker,
        jsonSummary({ adoptedLegacyMarker: task.legacyMarker }),
      ],
    );
    return adopted || completedRun(task);
  }

  async function ensureLegacyRollbackMarker(task) {
    if (!task.legacyMarker) return;
    await write(
      `INSERT INTO schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [task.legacyMarker],
    );
  }

  async function startRun(task, { source, ownerId }) {
    return findOne(
      `INSERT INTO maintenance_runs (
         task_id, task_version, run_kind, status, source, owner_id
       )
       VALUES ($1, $2, $3, 'running', $4, $5)
       RETURNING id, started_at`,
      [task.id, task.version, task.kind, source, ownerId],
    );
  }

  async function finishRun(runId, status, result = {}, error = null) {
    const update = await write(
      `UPDATE maintenance_runs
       SET status = $2,
           result_summary = $3::jsonb,
           error_code = $4,
           error_summary = $5,
           finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [
        runId,
        status,
        jsonSummary(result),
        error ? errorCode(error) : '',
        error ? errorSummary(error) : '',
      ],
    );
    const updatedRows = Number(update?.rowCount ?? update?.changes ?? 0);
    if (updatedRows !== 1) {
      throw new MaintenanceTaskError(
        'MAINTENANCE_AUDIT_UPDATE_FAILED',
        `Maintenance run audit update affected ${updatedRows} rows instead of one.`,
      );
    }
  }

  async function finishSuccessfulRun(runId, task, result = {}) {
    if (!task.legacyMarker) {
      await finishRun(runId, 'succeeded', result);
      return;
    }

    const completed = await findOne(
      `WITH finished AS (
         UPDATE maintenance_runs
         SET status = 'succeeded',
             result_summary = $2::jsonb,
             error_code = '',
             error_summary = '',
             finished_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING id
       ), rollback_marker AS (
         INSERT INTO schema_migrations (version)
         SELECT $3 FROM finished
         ON CONFLICT (version) DO NOTHING
         RETURNING version
       )
       SELECT count(*)::integer AS updated_rows
       FROM finished`,
      [runId, jsonSummary(result), task.legacyMarker],
    );
    const updatedRows = Number(completed?.updated_rows ?? 0);
    if (updatedRows !== 1) {
      throw new MaintenanceTaskError(
        'MAINTENANCE_AUDIT_UPDATE_FAILED',
        `Maintenance run audit update affected ${updatedRows} rows instead of one.`,
      );
    }
  }

  async function runTask(taskId, {
    source = 'cli',
    ownerId = defaultOwnerId(source),
    offlineConfirmed = false,
  } = {}) {
    const task = getMaintenanceTask(registry, taskId);
    if (task.requiresOfflineTopology
        && source !== 'compatibility-startup'
        && !offlineConfirmed) {
      throw new MaintenanceTaskError(
        'MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED',
        `Maintenance task requires all long-running processes to be stopped: ${task.id}`,
      );
    }

    const lock = await acquireLock({ task, source, ownerId });
    let taskError = null;
    try {
      if (task.kind === 'once') {
        const completed = await completedRun(task);
        if (completed) {
          await ensureLegacyRollbackMarker(task);
          return Object.freeze({
            taskId: task.id,
            status: 'skipped',
            previousStatus: completed.status,
            result: completed.result_summary || {},
          });
        }

        const adopted = await adoptLegacyMarker(task, { source, ownerId });
        if (adopted) {
          return Object.freeze({
            taskId: task.id,
            status: 'adopted',
            previousStatus: adopted.status,
            result: adopted.result_summary || {},
          });
        }

        const interrupted = await interruptedRun(task);
        if (interrupted) {
          throw new MaintenanceTaskError(
            'MAINTENANCE_TASK_RESTORE_REQUIRED',
            `Maintenance task ${task.id} previously ${interrupted.status}; restore the pre-task database backup before retrying.`,
          );
        }
      }

      const run = await startRun(task, { source, ownerId });
      let result;
      try {
        result = await task.run({ source, ownerId });
      } catch (error) {
        try {
          await finishRun(run.id, 'failed', {}, error);
        } catch (recordError) {
          throw new AggregateError(
            [error, recordError],
            `Maintenance task and failure audit both failed: ${task.id}`,
          );
        }
        throw error;
      }
      await finishSuccessfulRun(run.id, task, result || {});
      return Object.freeze({
        taskId: task.id,
        status: 'succeeded',
        result: result || {},
      });
    } catch (error) {
      taskError = error;
      throw error;
    } finally {
      try {
        await lock.release();
      } catch (releaseError) {
        if (taskError) {
          throw new AggregateError(
            [taskError, releaseError],
            `Maintenance task and lock release both failed: ${task.id}`,
          );
        }
        throw releaseError;
      }
    }
  }

  async function runTasks(taskIds, options = {}) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw new TypeError('taskIds must be a non-empty array');
    }
    const results = [];
    for (const taskId of taskIds) {
      results.push(await runTask(taskId, options));
    }
    return Object.freeze(results);
  }

  return Object.freeze({ registry, runTask, runTasks });
}
