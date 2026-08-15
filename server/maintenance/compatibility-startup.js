import {
  COMPATIBILITY_STARTUP_TASK_GROUPS,
  createMaintenanceTaskRegistry,
  MAINTENANCE_TASK_IDS,
} from './registry.js';
import { createMaintenanceRunner } from './runner.js';

/**
 * Blocking compatibility database maintenance.
 *
 * `initDb()` calls this after SQL migrations and before bootstrap/admin or any
 * runtime starts, preserving the historical publish timestamp repair order.
 */
export async function runCompatibilityDatabaseMaintenance({
  jobs,
  logger = console,
  taskRunner,
} = {}) {
  if (taskRunner != null && typeof taskRunner !== 'function') {
    throw new TypeError('taskRunner must be a function when provided');
  }
  const registry = createMaintenanceTaskRegistry({ jobs, logger });
  const taskId = MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL;
  if (taskRunner) {
    return taskRunner({
      taskId,
      task: registry[taskId],
      source: 'compatibility-startup',
    });
  }
  return createMaintenanceRunner({ registry }).runTask(taskId, {
    source: 'compatibility-startup',
  });
}

/**
 * Preserve the legacy `all` startup schedule while routing every historical
 * one-shot through the same audited maintenance registry used by the CLI.
 * Split roles never call this adapter.
 */
export function startCompatibilityStartupMaintenance({
  jobs,
  logger = console,
  schedule,
  runTracked,
  taskRunner,
} = {}) {
  if (typeof schedule !== 'function' || typeof runTracked !== 'function') {
    throw new TypeError('schedule and runTracked are required for compatibility maintenance');
  }
  if (taskRunner != null && typeof taskRunner !== 'function') {
    throw new TypeError('taskRunner must be a function when provided');
  }

  const registry = createMaintenanceTaskRegistry({ jobs, logger });
  const runner = taskRunner ? null : createMaintenanceRunner({ registry });

  async function runGroup(group) {
    const results = [];
    for (const taskId of group.taskIds) {
      const result = taskRunner
        ? await taskRunner({
            taskId,
            task: registry[taskId],
            source: 'compatibility-startup',
          })
        : await runner.runTask(taskId, { source: 'compatibility-startup' });
      results.push(result);
    }
    return Object.freeze(results);
  }

  for (const group of COMPATIBILITY_STARTUP_TASK_GROUPS) {
    const start = () => runTracked(group.label, () => runGroup(group));
    if (group.delayMs === 0) void start();
    else schedule(group.delayMs, start);
  }

  return Object.freeze({
    registry,
    groups: COMPATIBILITY_STARTUP_TASK_GROUPS,
  });
}
