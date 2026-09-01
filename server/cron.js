/**
 * 定时任务调度
 */

import cron from 'node-cron';
import { queryAll, getSetting } from './db/init.js';
import { labelPendingRecords } from './services/ai-labeler.js';
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from './services/report-generator.js';
import { processCaptureAttentionNotifications } from './services/capture-attention-notifier.js';
import { enqueueDueCaptureOrchestrations } from './services/capture-orchestration-scheduler.js';
import {enqueueDueProfilePatrolTasks} from './services/profile-patrol-dispatch.js';
import {compactOldCaptureTaskTechnicalHistory} from './services/capture-task-retention.js';
import {runOpsControlCycle} from './services/ops-control.js';
import {
  reconcileAutomaticCaptureRetries,
} from './routes/capture-cloud.js';
import {
  reconcilePendingOrchestrationRetries,
} from './routes/capture-orchestrations.js';
import {
  reconcilePendingCaptureCommands,
} from './modules/capture/infrastructure/postgres-command-reconciliation.js';
import {
  reconcileElasticCaptureLeases,
} from './modules/capture/infrastructure/postgres-lease-reconciliation.js';
import {createDrainController} from './runtime/drain-controller.js';

const DEFAULT_JOBS = Object.freeze({
  compactOldCaptureTaskTechnicalHistory,
  enqueueDueCaptureOrchestrations,
  enqueueDueProfilePatrolTasks,
  generateDailyReport,
  generateMonthlyReport,
  generateWeeklyReport,
  getSetting,
  labelPendingRecords,
  processCaptureAttentionNotifications,
  queryAll,
  reconcileAutomaticCaptureRetries,
  reconcileElasticCaptureLeases,
  reconcilePendingOrchestrationRetries,
  reconcilePendingCaptureCommands,
  runOpsControlCycle,
});

function safeLog(logger, method, ...args) {
  try {
    logger?.[method]?.(...args);
  } catch {
    // Runtime ownership and shutdown must not depend on a custom logger.
  }
}

function shanghaiNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    hhmm: `${map.hour}:${map.minute}`,
    weekday: new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))).getUTCDay(),
  };
}

async function runConfiguredReports(jobs) {
  const now = shanghaiNowParts();
  const tenants = await jobs.queryAll("SELECT id FROM tenants WHERE status = 'active'");

  for (const tenant of tenants) {
    const dailyEnabled = await jobs.getSetting('report_daily_enabled', tenant.id);
    const dailyTime = await jobs.getSetting('report_daily_time', tenant.id);
    if (dailyEnabled !== 'false' && (dailyTime || '09:00') === now.hhmm) {
      await jobs.generateDailyReport(tenant.id);
    }

    const weeklyEnabled = await jobs.getSetting('report_weekly_enabled', tenant.id);
    const weeklyDay = Number(await jobs.getSetting('report_weekly_day', tenant.id) || 1);
    const weeklyTime = await jobs.getSetting('report_weekly_time', tenant.id);
    if (weeklyEnabled !== 'false' && weeklyDay === now.weekday && (weeklyTime || '09:00') === now.hhmm) {
      await jobs.generateWeeklyReport(tenant.id);
    }

    const monthlyEnabled = await jobs.getSetting('report_monthly_enabled', tenant.id);
    const monthlyDay = Number(await jobs.getSetting('report_monthly_day', tenant.id) || 1);
    const monthlyTime = await jobs.getSetting('report_monthly_time', tenant.id);
    if (monthlyEnabled !== 'false' && monthlyDay === now.day && (monthlyTime || '09:00') === now.hhmm) {
      await jobs.generateMonthlyReport(tenant.id);
    }
  }
}

function schedulerDefinitions(jobs, logger) {
  return [
    {
      name: 'capture-task-retention',
      expression: '17 3 * * *',
      run: async () => {
        try {
          const result = await jobs.compactOldCaptureTaskTechnicalHistory();
          if (result.rootCount > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Capture task retention: ${result.rootCount} root task(s), ` +
              `${result.deletedSnapshotCount} raw snapshot(s) compacted`,
            );
          }
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Capture task retention error:', err.message);
        }
      },
    },
    {
      name: 'profile-patrol',
      expression: '*/5 * * * *',
      run: async () => {
        try {
          await jobs.reconcilePendingCaptureCommands();
          const results = await jobs.enqueueDueProfilePatrolTasks(20);
          const created = results.filter(result => result.kind === 'created').length;
          const attention = results.length - created;
          if (results.length > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Profile patrol: ${created} task(s) created, ` +
              `${attention} subscription(s) need attention`,
            );
          }
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Profile patrol enqueue error:', err.message);
        }
      },
    },
    {
      name: 'capture-orchestration-recovery',
      expression: '* * * * *',
      run: async () => {
        try {
          const reconciliation = await jobs.reconcilePendingCaptureCommands();
          if (reconciliation.commandCount > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Capture commands reconciled: ${reconciliation.commandCount}`,
            );
          }
          const results = await jobs.enqueueDueCaptureOrchestrations(20);
          const created = results.filter(result => result.kind === 'created').length;
          const skipped = results.length - created;
          if (results.length > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Multi-Agent schedules: ${created} run(s) created, ` +
              `${skipped} occurrence(s) advanced`,
            );
          }
          const elasticLeases = await jobs.reconcileElasticCaptureLeases(50);
          if (elasticLeases.requeued > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Elastic work queue: ${elasticLeases.requeued} stale item(s) requeued`,
            );
          }
          const pendingRetries =
            await jobs.reconcilePendingOrchestrationRetries(10);
          if (pendingRetries.dispatched > 0 || pendingRetries.failed > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Waiting retry continuation: ${pendingRetries.dispatched} dispatched, ` +
              `${pendingRetries.waitingForAgent} waiting for Agent, ` +
              `${pendingRetries.failed} failed`,
            );
          }
          // Transitional safety net: the selector excludes tenants whose new
          // duty Agent is globally enabled and in guarded action mode. Tenants
          // that have not crossed that gate retain the proven legacy handoff
          // instead of losing automatic recovery during a staged rollout.
          const recovery = await jobs.reconcileAutomaticCaptureRetries(10);
          if (recovery.dispatched > 0 || recovery.failed > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Capture fallback dispatch: ${recovery.dispatched} dispatched, ` +
              `${recovery.waitingForAgent} waiting for Agent, ` +
              `${recovery.manualOnly} manual-only, ${recovery.failed} failed`,
            );
          }
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Multi-Agent schedule/recovery error:', err.message);
        }
      },
    },
    {
      name: 'capture-attention-notifications',
      expression: '* * * * *',
      run: async () => {
        try {
          const result = await jobs.processCaptureAttentionNotifications(20);
          if (result.claimed > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Capture attention notifications: ${result.sent} sent, ` +
              `${result.retry_wait} retrying, ${result.blocked_config} blocked, ` +
              `${result.failed} failed, ${result.worker_error} worker error(s)`,
            );
          }
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Capture attention notification error:', err.message);
        }
      },
    },
    {
      name: 'ops-control-observer',
      // Event wakeups are the primary path. This bounded reconciliation scan
      // only recovers from a listener outage or an unexpected legacy writer.
      expression: '*/5 * * * *',
      run: async () => {
        try {
          const result = await jobs.runOpsControlCycle({logger});
          if (result.observed > 0 || result.failed > 0) {
            safeLog(
              logger,
              'log',
              `[Cron] Ops control: ${result.observed} tenant(s) observed, ` +
              `${result.failed} failed, ${result.incidentCount || 0} incident(s)`,
            );
          }
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Ops control error:', err.message);
        }
      },
    },
  ];
}

function aiDefinitions(jobs, logger) {
  return [
    {
      name: 'batch-ai-labeling',
      expression: '*/10 * * * *',
      run: async () => {
        safeLog(logger, 'log', '[Cron] Running batch AI labeling...');
        try {
          await jobs.labelPendingRecords(20);
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Batch labeling error:', err.message);
        }
      },
    },
    {
      name: 'configured-reports',
      expression: '* * * * *',
      run: async () => {
        try {
          await runConfiguredReports(jobs);
        } catch (err) {
          safeLog(logger, 'error', '[Cron] Report scheduler error:', err.message);
        }
      },
    },
  ];
}

function invokeTaskMethod(tasks, method, logger, groupName) {
  for (const task of tasks) {
    try {
      task?.[method]?.();
    } catch (error) {
      safeLog(
        logger,
        'error',
        `[Cron] ${groupName} task ${method} failed:`,
        error?.message || error,
      );
    }
  }
}

function startCronGroup({
  groupName,
  definitions,
  cronModule,
  logger,
}) {
  if (typeof cronModule?.schedule !== 'function') {
    throw new TypeError('cronModule.schedule must be a function');
  }

  const drainController = createDrainController();
  const tasks = [];
  let stopped = false;
  let destroyed = false;

  try {
    for (const definition of definitions) {
      const task = cronModule.schedule(
        definition.expression,
        () => drainController.run(definition.run),
        {
          name: `onstarvoice:${definition.name}`,
          noOverlap: true,
        },
      );
      tasks.push(task);
    }
  } catch (error) {
    drainController.stopAccepting();
    invokeTaskMethod(tasks, 'destroy', logger, groupName);
    throw error;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    drainController.stopAccepting();
    invokeTaskMethod(tasks, 'stop', logger, groupName);
    return true;
  }

  async function drain(options) {
    stop();
    const result = await drainController.waitForIdle(options);
    return Object.freeze({name: `cron:${groupName}`, ...result});
  }

  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    stop();
    invokeTaskMethod(tasks, 'destroy', logger, groupName);
    return true;
  }

  function snapshot() {
    return Object.freeze({
      groupName,
      stopped,
      destroyed,
      taskCount: tasks.length,
      inFlight: drainController.inFlightCount,
    });
  }

  return Object.freeze({
    groupName,
    tasks: Object.freeze([...tasks]),
    stop,
    drain,
    destroy,
    snapshot,
  });
}

function resolveJobs(overrides) {
  if (overrides == null) return DEFAULT_JOBS;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('jobs must be an object when provided');
  }
  return Object.freeze({...DEFAULT_JOBS, ...overrides});
}

export function startSchedulerCronJobs({
  cronModule = cron,
  logger = console,
  jobs: jobOverrides,
  announce = true,
} = {}) {
  const jobs = resolveJobs(jobOverrides);
  const runtime = startCronGroup({
    groupName: 'scheduler',
    definitions: schedulerDefinitions(jobs, logger),
    cronModule,
    logger,
  });
  if (announce) safeLog(logger, 'log', '[Cron] Scheduler jobs started');
  return runtime;
}

export function startAiCronJobs({
  cronModule = cron,
  logger = console,
  jobs: jobOverrides,
  announce = true,
} = {}) {
  const jobs = resolveJobs(jobOverrides);
  const runtime = startCronGroup({
    groupName: 'ai',
    definitions: aiDefinitions(jobs, logger),
    cronModule,
    logger,
  });
  if (announce) safeLog(logger, 'log', '[Cron] AI jobs started');
  return runtime;
}

function combineCronRuntimes(runtimes) {
  let stopped = false;
  let destroyed = false;

  function stop() {
    if (stopped) return false;
    stopped = true;
    for (const runtime of runtimes) runtime.stop();
    return true;
  }

  async function drain(options) {
    stop();
    const groups = await Promise.all(runtimes.map(runtime => runtime.drain(options)));
    return Object.freeze({
      name: 'cron:all',
      drained: groups.every(group => group.drained),
      timedOut: groups.some(group => group.timedOut),
      pending: groups.reduce((sum, group) => sum + group.pending, 0),
      groups: Object.freeze(groups),
    });
  }

  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    stop();
    for (const runtime of runtimes) runtime.destroy();
    return true;
  }

  function snapshot() {
    return Object.freeze({
      name: 'cron:all',
      stopped,
      destroyed,
      groups: Object.freeze(runtimes.map(runtime => runtime.snapshot())),
    });
  }

  return Object.freeze({
    groupName: 'all',
    runtimes: Object.freeze([...runtimes]),
    stop,
    drain,
    destroy,
    snapshot,
  });
}

export function startCronJobs(options = {}) {
  const logger = options.logger ?? console;
  const scheduler = startSchedulerCronJobs({...options, logger, announce: false});
  let ai;
  try {
    ai = startAiCronJobs({...options, logger, announce: false});
  } catch (error) {
    scheduler.destroy();
    throw error;
  }

  safeLog(logger, 'log', '[Cron] Scheduled jobs started');
  return combineCronRuntimes([scheduler, ai]);
}
