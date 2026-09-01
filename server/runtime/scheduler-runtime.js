import { startSchedulerCronJobs } from '../cron.js';
import {startOpsControlWakeupRuntime} from '../services/ops-control-wakeup.js';

export const SCHEDULER_RUNTIME_RESPONSIBILITIES = Object.freeze([
  'capture-task-retention',
  'profile-patrol-scheduling',
  'capture-orchestration-recovery',
  'capture-attention-notifications',
  'ops-control-observation-and-guarded-recovery',
  'ops-control-event-wakeup',
]);

export function startSchedulerRuntime({
  logger = console,
  startCron = startSchedulerCronJobs,
  startWakeups = startOpsControlWakeupRuntime,
} = {}) {
  const cronRuntime = startCron({ logger });
  let wakeupRuntime;
  try {
    wakeupRuntime = startWakeups({logger});
  } catch (error) {
    cronRuntime.destroy();
    throw error;
  }
  let stopped = false;
  let stopPromise;

  function stopNewWork() {
    if (stopped) return false;
    stopped = true;
    cronRuntime.stop();
    wakeupRuntime.stopNewWork?.();
    return true;
  }

  async function drain(options = {}) {
    stopNewWork();
    const [cronResult, wakeupResult] = await Promise.all([
      cronRuntime.drain(options),
      wakeupRuntime.drain(options),
    ]);
    cronRuntime.destroy();
    return Object.freeze({
      name: 'scheduler',
      drained: cronResult.drained && wakeupResult.drained,
      timedOut: cronResult.timedOut || wakeupResult.timedOut,
      pending: integer(cronResult.pending) + integer(wakeupResult.pending),
      cron: cronResult,
      wakeups: wakeupResult,
    });
  }

  function stop(options = {}) {
    stopPromise ||= drain(options);
    return stopPromise;
  }

  return Object.freeze({
    kind: 'scheduler',
    responsibilities: SCHEDULER_RUNTIME_RESPONSIBILITIES,
    cronRuntime,
    wakeupRuntime,
    stopNewWork,
    drain,
    stop,
  });
}

function integer(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
