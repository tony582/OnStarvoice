import { startSchedulerCronJobs } from '../cron.js';

export const SCHEDULER_RUNTIME_RESPONSIBILITIES = Object.freeze([
  'capture-task-retention',
  'profile-patrol-scheduling',
  'capture-orchestration-recovery',
  'capture-attention-notifications',
  'ops-control-observation-and-guarded-recovery',
]);

export function startSchedulerRuntime({
  logger = console,
  startCron = startSchedulerCronJobs,
} = {}) {
  const cronRuntime = startCron({ logger });
  let stopPromise;

  function stopNewWork() {
    return cronRuntime.stop();
  }

  async function drain(options = {}) {
    const result = await cronRuntime.drain(options);
    cronRuntime.destroy();
    return result;
  }

  function stop(options = {}) {
    stopPromise ||= drain(options);
    return stopPromise;
  }

  return Object.freeze({
    kind: 'scheduler',
    responsibilities: SCHEDULER_RUNTIME_RESPONSIBILITIES,
    cronRuntime,
    stopNewWork,
    drain,
    stop,
  });
}
