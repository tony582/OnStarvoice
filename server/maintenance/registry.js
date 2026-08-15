import { execute, queryAll } from '../db/init.js';
import { ensureBootstrapAdmin } from '../services/auth-service.js';
import { labelRecord } from '../services/ai-labeler.js';
import { backfillRecentCovers, backfillRecentImages } from '../services/media-store.js';
import { failStaleAnalyses } from '../services/opinion-analysis.js';
import { parsePublishTimestamp } from '../services/publish-date.js';

export const MAINTENANCE_TASK_IDS = Object.freeze({
  PUBLISH_TS_BACKFILL: 'publish-ts-backfill-v1',
  OPINION_ANALYSIS_STALE_REPAIR: 'opinion-analysis-stale-repair',
  COMMENT_PROMOTION_RECONCILE: 'comment-promotion-reconcile',
  COMMENT_SAFETY_RECLASSIFY: 'comment-safety-semantic-reclassify-v1',
  RECENT_MEDIA_BACKFILL: 'recent-media-backfill',
  SAICGM_SCOPE_RELABEL: 'saicgm-scope-relabel-v3',
  COMMENTS_WORKFLOW_BACKFILL: 'comments-workflow-backfill',
  LEGACY_SQLJS_IMPORT: 'legacy-sqljs-import',
  BOOTSTRAP_ADMIN: 'bootstrap-admin',
});

export const STARTUP_RECONCILE_TASK_IDS = Object.freeze([
  MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL,
  MAINTENANCE_TASK_IDS.OPINION_ANALYSIS_STALE_REPAIR,
  MAINTENANCE_TASK_IDS.COMMENT_PROMOTION_RECONCILE,
  MAINTENANCE_TASK_IDS.COMMENT_SAFETY_RECLASSIFY,
  MAINTENANCE_TASK_IDS.RECENT_MEDIA_BACKFILL,
  MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL,
]);

export const COMPATIBILITY_STARTUP_TASK_GROUPS = Object.freeze([
  Object.freeze({
    label: 'OpinionAnalysis',
    delayMs: 0,
    taskIds: Object.freeze([MAINTENANCE_TASK_IDS.OPINION_ANALYSIS_STALE_REPAIR]),
  }),
  Object.freeze({
    label: 'Reprocess',
    delayMs: 15_000,
    taskIds: Object.freeze([
      MAINTENANCE_TASK_IDS.COMMENT_PROMOTION_RECONCILE,
      MAINTENANCE_TASK_IDS.COMMENT_SAFETY_RECLASSIFY,
    ]),
  }),
  Object.freeze({
    label: 'MediaBackfill',
    delayMs: 25_000,
    taskIds: Object.freeze([MAINTENANCE_TASK_IDS.RECENT_MEDIA_BACKFILL]),
  }),
  Object.freeze({
    label: 'Relabel',
    delayMs: 25_000,
    taskIds: Object.freeze([MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL]),
  }),
]);

const DEFAULT_JOBS = Object.freeze({
  backfillRecentCovers,
  backfillRecentImages,
  ensureBootstrapAdmin,
  execute,
  failStaleAnalyses,
  labelRecord,
  parsePublishTimestamp,
  queryAll,
  async loadCommentWorkflow() {
    return import('../services/comment-workflow.js');
  },
  async runCommentsWorkflowBackfill() {
    const module = await import('../scripts/backfill-comments-workflow.js');
    return module.runCommentsWorkflowBackfill();
  },
  async runLegacySqljsImport() {
    const module = await import('../scripts/migrate-sqljs-to-postgres.js');
    return module.runLegacySqljsImport();
  },
});

function safeLog(logger, method, ...args) {
  try {
    logger?.[method]?.(...args);
  } catch {
    // Maintenance correctness must not depend on a custom logger.
  }
}

function resolveJobs(overrides) {
  if (overrides == null) return DEFAULT_JOBS;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('maintenance jobs must be an object when provided');
  }
  return Object.freeze({ ...DEFAULT_JOBS, ...overrides });
}

function defineTask({
  id,
  version = '1',
  kind,
  legacyMarker = null,
  requiresOfflineTopology = false,
  retryRequiresRestore = false,
  retryableFailureCodes = [],
  executionRoles = [],
  run,
}) {
  if (!Object.values(MAINTENANCE_TASK_IDS).includes(id)) {
    throw new TypeError(`Unknown maintenance task id: ${id}`);
  }
  if (kind !== 'once' && kind !== 'repeatable') {
    throw new TypeError(`Invalid maintenance task kind for ${id}`);
  }
  if (typeof run !== 'function') {
    throw new TypeError(`Maintenance task ${id} requires a run function`);
  }
  return Object.freeze({
    id,
    version,
    kind,
    legacyMarker,
    requiresOfflineTopology,
    retryRequiresRestore,
    retryableFailureCodes: Object.freeze([...retryableFailureCodes]),
    executionRoles: Object.freeze([...executionRoles]),
    run,
  });
}

async function runPublishTimestampBackfill(jobs) {
  const records = await jobs.queryAll('SELECT id, publish_time, created_at FROM records');
  for (const record of records) {
    const timestamp = String(record.publish_time || '').trim()
      ? jobs.parsePublishTimestamp(record.publish_time, record.created_at)
      : null;
    await jobs.execute(
      'UPDATE records SET published_ts = $2 WHERE id = $1',
      [record.id, timestamp],
    );
  }

  const leads = await jobs.queryAll(`
    SELECT cl.id, cl.captured_at, rc.published_at
    FROM comment_leads cl
    LEFT JOIN record_comments rc ON rc.id = cl.comment_id
  `);
  for (const lead of leads) {
    const timestamp = String(lead.published_at || '').trim()
      ? jobs.parsePublishTimestamp(lead.published_at, lead.captured_at)
      : null;
    await jobs.execute(
      'UPDATE comment_leads SET comment_published_ts = $2 WHERE id = $1',
      [lead.id, timestamp],
    );
  }

  return Object.freeze({ records: records.length, commentLeads: leads.length });
}

async function runCommentPromotionReconcile(jobs) {
  const workflow = await jobs.loadCommentWorkflow();
  const recovered = await workflow.reprocessPendingComments();
  return Object.freeze({ recovered: Number(recovered || 0) });
}

async function runCommentSafetyReclassify(jobs, logger) {
  const workflow = await jobs.loadCommentWorkflow();
  const stats = await workflow.reclassifyComments(null, {
    safetySemanticReviewCandidatesOnly: true,
    queueForAI: true,
  });
  safeLog(
    logger,
    'log',
    `[CommentSafety] 存量评论已重新排入 AI 语义分类:${stats.changed} 条`,
  );
  return Object.freeze({
    total: Number(stats.total || 0),
    changed: Number(stats.changed || 0),
  });
}

async function runRecentMediaBackfill(jobs, logger) {
  const [covers, images] = await Promise.all([
    jobs.backfillRecentCovers(),
    jobs.backfillRecentImages(),
  ]);
  if (covers) safeLog(logger, 'log', `[CoverStore] 启动回填:尝试 ${covers} 条封面落地`);
  if (images) safeLog(logger, 'log', `[ImageStore] 启动回填:尝试 ${images} 条正文图片落地`);
  return Object.freeze({
    covers: Number(covers || 0),
    images: Number(images || 0),
  });
}

async function runSaicgmScopeRelabel(jobs, logger) {
  const records = await jobs.queryAll(
    "SELECT id FROM records WHERE ai_result->>'relevance' = 'irrelevant'",
  );
  if (records.length) {
    safeLog(logger, 'log', `[Relabel] 上汽通用范围放宽:重判 ${records.length} 条原判无关的记录`);
  }

  const failures = [];
  for (const record of records) {
    try {
      await jobs.labelRecord(record.id, { force: true });
    } catch (error) {
      failures.push(error);
      safeLog(logger, 'error', '[Relabel]', record.id, error?.message || error);
    }
  }
  if (failures.length > 0) {
    const error = new AggregateError(
      failures,
      `SAIC-GM scope relabel failed for ${failures.length}/${records.length} record(s)`,
    );
    error.code = 'MAINTENANCE_TASK_PARTIAL_FAILURE';
    throw error;
  }

  safeLog(logger, 'log', '[Relabel] 完成');
  return Object.freeze({ relabeled: records.length });
}

/**
 * Build the fixed maintenance task allowlist.
 *
 * No task id, SQL, or filesystem path is accepted from outside this registry.
 */
export function createMaintenanceTaskRegistry({ jobs: overrides, logger = console } = {}) {
  const jobs = resolveJobs(overrides);
  const tasks = [
    defineTask({
      id: MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL,
      kind: 'once',
      legacyMarker: 'publish_ts_backfill_v1',
      requiresOfflineTopology: true,
      run: () => runPublishTimestampBackfill(jobs),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.OPINION_ANALYSIS_STALE_REPAIR,
      kind: 'repeatable',
      requiresOfflineTopology: true,
      executionRoles: ['ai-media'],
      run: async () => Object.freeze({ failed: Number(await jobs.failStaleAnalyses() || 0) }),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.COMMENT_PROMOTION_RECONCILE,
      kind: 'repeatable',
      requiresOfflineTopology: true,
      executionRoles: ['ai-media'],
      run: () => runCommentPromotionReconcile(jobs),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.COMMENT_SAFETY_RECLASSIFY,
      kind: 'once',
      legacyMarker: 'comment_safety_semantic_reclassify_v1',
      requiresOfflineTopology: true,
      executionRoles: ['ai-media'],
      run: () => runCommentSafetyReclassify(jobs, logger),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.RECENT_MEDIA_BACKFILL,
      kind: 'repeatable',
      requiresOfflineTopology: true,
      executionRoles: ['ai-media'],
      run: () => runRecentMediaBackfill(jobs, logger),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.SAICGM_SCOPE_RELABEL,
      kind: 'once',
      legacyMarker: 'relabel_saicgm_scope_v3',
      requiresOfflineTopology: true,
      retryRequiresRestore: true,
      executionRoles: ['ai-media'],
      run: () => runSaicgmScopeRelabel(jobs, logger),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.COMMENTS_WORKFLOW_BACKFILL,
      kind: 'repeatable',
      requiresOfflineTopology: true,
      executionRoles: ['ai-media'],
      run: () => jobs.runCommentsWorkflowBackfill(),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.LEGACY_SQLJS_IMPORT,
      kind: 'once',
      requiresOfflineTopology: true,
      retryRequiresRestore: true,
      retryableFailureCodes: ['LEGACY_SQLJS_DATABASE_NOT_FOUND'],
      executionRoles: ['scheduler', 'ai-media'],
      run: () => jobs.runLegacySqljsImport(),
    }),
    defineTask({
      id: MAINTENANCE_TASK_IDS.BOOTSTRAP_ADMIN,
      kind: 'repeatable',
      run: () => jobs.ensureBootstrapAdmin(),
    }),
  ];

  return Object.freeze(Object.fromEntries(tasks.map(task => [task.id, task])));
}

export function getMaintenanceTask(registry, taskId) {
  const normalized = typeof taskId === 'string' ? taskId.trim() : '';
  if (!normalized || !Object.hasOwn(registry, normalized)) {
    const error = new Error('Maintenance task is not in the fixed allowlist.');
    error.code = 'MAINTENANCE_TASK_UNKNOWN';
    throw error;
  }
  return registry[normalized];
}
