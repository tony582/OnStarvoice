import { startAiCronJobs } from '../cron.js';
import { execute, queryAll, queryOne } from '../db/init.js';
import { probeDeepSeekPrimaryModel, labelRecord } from '../services/ai-labeler.js';
import { runAiFailoverRecoverySweep } from '../services/ai-failover.js';
import { backfillRecentCovers, backfillRecentImages } from '../services/media-store.js';
import { failStaleAnalyses } from '../services/opinion-analysis.js';
import { createDrainController } from './drain-controller.js';

export const AI_MEDIA_RUNTIME_RESPONSIBILITIES = Object.freeze([
  'batch-ai-labeling',
  'configured-reports',
  'comment-ai-refinement',
  'ai-failover-recovery',
  // Owned by the single ai-media execution authority in both topologies. The
  // comment reprocess holds the database processor lease, the media backfill
  // is idempotent over a 24h window, and the stale sweep only touches analyses
  // that have not advanced for OPINION_ANALYSIS_STALE_AFTER_MINUTES.
  'comment-reprocess-and-safety-reclassify',
  'recent-media-backfill',
  'opinion-analysis-stale-sweep',
]);

export const COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES = Object.freeze([
  // Immediate "everything in flight died with this process" repair. Only true
  // when HTTP and AI share one process; split API restarts are covered by the
  // periodic stale sweep instead.
  'opinion-analysis-stale-repair',
  // Historical SAIC-GM relabel. Flag-guarded and tenant-wide; never re-run it
  // from an independent worker.
  'saicgm-scope-relabel',
]);

export const OPINION_ANALYSIS_STALE_SWEEP_INITIAL_DELAY_MS = 90_000;
export const OPINION_ANALYSIS_STALE_SWEEP_INTERVAL_MS = 5 * 60_000;
export const OPINION_ANALYSIS_STALE_AFTER_MINUTES = 30;

const DEFAULT_JOBS = Object.freeze({
  failStaleAnalyses,
  backfillRecentCovers,
  backfillRecentImages,
  runAiFailoverRecoverySweep,
  probeDeepSeekPrimaryModel,
  labelRecord,
  queryAll,
  queryOne,
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

  async function reprocessCommentsAndSafetyLabels() {
    const workflow = await jobs.loadCommentWorkflow();
    await workflow.reprocessPendingComments({ limit: 25 });

    const flag = 'comment_safety_semantic_reclassify_v1';
    const done = await jobs.queryOne(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [flag],
    );
    if (done) return;
    const stats = await workflow.reclassifyComments(null, {
      safetySemanticReviewCandidatesOnly: true,
      queueForAI: true,
    });
    await jobs.execute(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [flag],
    );
    safeLog(
      logger,
      'log',
      `[CommentSafety] 存量评论已重新排入 AI 语义分类:${stats.changed} 条`,
    );
  }

  async function backfillRecentMedia() {
    const [covers, images] = await Promise.all([
      jobs.backfillRecentCovers(),
      jobs.backfillRecentImages(),
    ]);
    if (covers) safeLog(logger, 'log', `[CoverStore] 启动回填:尝试 ${covers} 条封面落地`);
    if (images) safeLog(logger, 'log', `[ImageStore] 启动回填:尝试 ${images} 条正文图片落地`);
  }

  async function drainCommentAi() {
    const workflow = await jobs.loadCommentWorkflow();
    const receipts = await workflow.reprocessPendingCommentWorkflowReceipts({
      limit: 25,
    });
    if (receipts.persisted || receipts.failed) {
      safeLog(
        logger,
        'log',
        `[CommentReceipt] 持久化 ${receipts.persisted}，失败 ${receipts.failed}`,
      );
    }
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

  async function relabelSaicgmScope() {
    const flag = 'relabel_saicgm_scope_v3';
    const done = await jobs.queryAll(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [flag],
    );
    if (done.length) return;
    const records = await jobs.queryAll(
      "SELECT id FROM records WHERE ai_result->>'relevance' = 'irrelevant'",
    );
    if (records.length) {
      safeLog(logger, 'log', `[Relabel] 上汽通用范围放宽:重判 ${records.length} 条原判无关的记录`);
      for (const record of records) {
        try {
          await jobs.labelRecord(record.id, { force: true });
        } catch (error) {
          safeLog(logger, 'error', '[Relabel]', record.id, error?.message || error);
        }
      }
    }
    await jobs.execute(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [flag],
    );
    safeLog(logger, 'log', '[Relabel] 完成');
  }

  scheduleRecurring(20_000, 15_000, 'CommentRefine', drainCommentAi);
  scheduleRecurring(60_000, 60_000, 'AIFailover', checkAiFailoverRecovery);
  scheduleRecurring(
    15_000,
    60_000,
    'Reprocess',
    reprocessCommentsAndSafetyLabels,
  );
  schedule(25_000, () => runTracked('MediaBackfill', backfillRecentMedia));
  scheduleRecurring(
    OPINION_ANALYSIS_STALE_SWEEP_INITIAL_DELAY_MS,
    OPINION_ANALYSIS_STALE_SWEEP_INTERVAL_MS,
    'OpinionAnalysisSweep',
    () => jobs.failStaleAnalyses({
      olderThanMinutes: OPINION_ANALYSIS_STALE_AFTER_MINUTES,
    }),
  );

  // Compatibility-only: with HTTP and AI in one process, every analysis that
  // was pending/running at startup died with the previous process, so it is
  // safe to fail all of them immediately. The SAIC-GM relabel is a historical,
  // flag-guarded one-shot that must not be re-run from an independent worker.
  if (compatibilityMode) {
    void runTracked('OpinionAnalysis', () => jobs.failStaleAnalyses());
    schedule(25_000, () => runTracked('Relabel', relabelSaicgmScope));
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
