import { startAiCronJobs } from '../cron.js';
import { execute, queryAll } from '../db/init.js';
import { probeDeepSeekPrimaryModel, labelRecord } from '../services/ai-labeler.js';
import { runAiFailoverRecoverySweep } from '../services/ai-failover.js';
import { backfillRecentCovers, backfillRecentImages } from '../services/media-store.js';
import { failStaleAnalyses } from '../services/opinion-analysis.js';
import { startCompatibilityStartupMaintenance } from '../maintenance/compatibility-startup.js';
import { createDrainController } from './drain-controller.js';

export const AI_MEDIA_RUNTIME_RESPONSIBILITIES = Object.freeze([
  'batch-ai-labeling',
  'configured-reports',
  'comment-ai-refinement',
  'ai-failover-recovery',
]);

export const COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES = Object.freeze([
  'opinion-analysis-stale-repair',
  'comment-reprocess-and-safety-reclassify',
  'recent-media-backfill',
  'saicgm-scope-relabel',
]);

const DEFAULT_JOBS = Object.freeze({
  failStaleAnalyses,
  backfillRecentCovers,
  backfillRecentImages,
  runAiFailoverRecoverySweep,
  probeDeepSeekPrimaryModel,
  labelRecord,
  queryAll,
  execute,
  async loadCommentWorkflow() {
    return import('../services/comment-workflow.js');
  },
});

function safeLog(logger, method, ...args) {
  try {
    logger?.[method]?.(...args);
  } catch {
    // Lifecycle safety must not depend on custom logging.
  }
}
function resolveJobs(overrides) {
  if (overrides == null) return DEFAULT_JOBS;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('jobs must be an object when provided');
  }
  return Object.freeze({ ...DEFAULT_JOBS, ...overrides });
}

export function startAiMediaRuntime({
  logger = console,
  compatibilityMode = false,
  startCron = startAiCronJobs,
  jobs: jobOverrides,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createDrain = createDrainController,
  startCompatibilityMaintenance = startCompatibilityStartupMaintenance,
  maintenanceTaskRunner,
} = {}) {
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('setTimer and clearTimer must be functions');
  }
  const jobs = resolveJobs(jobOverrides);
  const drainController = createDrain({ setTimer, clearTimer });
  const cronRuntime = startCron({ logger });
  const timers = new Set();
  let stopping = false;

  function schedule(delayMs, callback) {
    if (stopping) return null;
    let handle;
    handle = setTimer(() => {
      timers.delete(handle);
      if (stopping) return;
      void callback();
    }, delayMs);
    timers.add(handle);
    return handle;
  }

  function runTracked(label, work) {
    return drainController.run(work).catch(error => {
      safeLog(logger, 'error', `[${label}] ${error?.message || error}`);
    });
  }

  function scheduleRecurring(initialDelayMs, intervalMs, label, work) {
    const runOnce = () => runTracked(label, work).finally(() => {
      if (!stopping) schedule(intervalMs, runOnce);
    });
    schedule(initialDelayMs, runOnce);
  }

  async function drainCommentAi() {
    const workflow = await jobs.loadCommentWorkflow();
    let total = 0;
    for (let index = 0; index < 30; index += 1) {
      const count = await workflow.refineCommentsWithAI({ limit: 300 });
      total += count;
      if (count === 0) break;
    }
    if (total) safeLog(logger, 'log', `[CommentRefine] 本轮 AI 精炼 ${total} 条评论`);
  }

  async function checkAiFailoverRecovery() {
    const result = await jobs.runAiFailoverRecoverySweep({
      probe: jobs.probeDeepSeekPrimaryModel,
    });
    if (result.probed || result.recovered) {
      safeLog(logger, 'info', '[AIFailover] recovery sweep', result);
    }
  }

  scheduleRecurring(20_000, 15_000, 'CommentRefine', drainCommentAi);
  scheduleRecurring(60_000, 60_000, 'AIFailover', checkAiFailoverRecovery);

  // Keep the legacy `all` schedule through an explicit Maintenance adapter.
  // Split AI/Media never invokes this adapter and therefore owns no one-shots.
  if (compatibilityMode) {
    startCompatibilityMaintenance({
      jobs,
      logger,
      schedule,
      runTracked,
      taskRunner: maintenanceTaskRunner,
    });
  }

  function stopNewWork() {
    if (stopping) return false;
    stopping = true;
    drainController.stopAccepting();
    cronRuntime.stop();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    return true;
  }

  async function drain(options = {}) {
    stopNewWork();
    const [cronResult, activityResult] = await Promise.all([
      cronRuntime.drain(options),
      drainController.waitForIdle(options),
    ]);
    cronRuntime.destroy();
    return Object.freeze({
      name: 'ai-media',
      drained: cronResult.drained && activityResult.drained,
      cron: cronResult,
      activity: activityResult,
    });
  }

  let stopPromise;
  function stop(options = {}) {
    stopPromise ||= drain(options);
    return stopPromise;
  }

  const responsibilities = compatibilityMode
    ? Object.freeze([
      ...AI_MEDIA_RUNTIME_RESPONSIBILITIES,
      ...COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES,
    ])
    : AI_MEDIA_RUNTIME_RESPONSIBILITIES;

  return Object.freeze({
    kind: 'ai-media',
    compatibilityMode,
    responsibilities,
    cronRuntime,
    stopNewWork,
    drain,
    stop,
    snapshot() {
      return Object.freeze({
        stopping,
        timers: timers.size,
        inFlight: drainController.inFlightCount,
        cron: cronRuntime.snapshot(),
      });
    },
  });
}
