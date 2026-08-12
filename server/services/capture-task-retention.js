import {withTransaction} from '../db/init.js';

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_BATCH_SIZE = 100;
const FINAL_TASK_STATUSES = [
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
];

function positiveInteger(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

/**
 * Compact high-frequency browser snapshots for old, terminal task trees.
 *
 * Durable business objects are deliberately outside this policy:
 * - capture_tasks rows and their current summary projection are preserved;
 * - capture_task_items and both attempt tables are preserved;
 * - capture_task_events remain append-only audit evidence;
 * - records and record_observations are never touched.
 *
 * For each task in a selected root tree, only the newest raw snapshot remains.
 * The root is marked after the entire tree is compacted, making the job
 * idempotent and safely retryable in bounded batches.
 */
export async function compactOldCaptureTaskTechnicalHistory({
  retentionDays = process.env.CAPTURE_TASK_TECHNICAL_RETENTION_DAYS,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const days = positiveInteger(retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const limit = positiveInteger(batchSize, DEFAULT_BATCH_SIZE, 500);
  return withTransaction(async tx => {
    const roots = await tx.queryAll(`
      SELECT root.id
      FROM capture_tasks root
      WHERE root.parent_task_id IS NULL
        AND root.status = ANY($1::text[])
        AND COALESCE(root.finished_at, root.updated_at) < now() - ($2::integer * interval '1 day')
        AND root.technical_compacted_at IS NULL
        AND NOT (
          root.task_type = 'capture_orchestration'
          AND root.metadata->>'orchestrationTemplate' = 'true'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM capture_tasks child
          WHERE child.parent_task_id = root.id
            AND child.status IN (
              'pending', 'waiting_device', 'claimed', 'running', 'recovering',
              'resume_requested'
            )
        )
      ORDER BY COALESCE(root.finished_at, root.updated_at), root.id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    `, [FINAL_TASK_STATUSES, days, limit]);
    if (roots.length === 0) {
      return {rootCount: 0, taskCount: 0, deletedSnapshotCount: 0, retentionDays: days};
    }
    const rootIds = roots.map(root => root.id);
    const taskRows = await tx.queryAll(`
      WITH RECURSIVE task_tree AS (
        SELECT root.id
        FROM capture_tasks root
        WHERE root.id = ANY($1::uuid[])

        UNION ALL

        SELECT child.id
        FROM capture_tasks child
        JOIN task_tree parent ON child.parent_task_id = parent.id
      )
      SELECT DISTINCT id
      FROM task_tree
      ORDER BY id
    `, [rootIds]);
    const taskIds = taskRows.map(task => task.id);
    const deleted = taskIds.length > 0
      ? await tx.queryOne(`
          WITH ranked AS (
            SELECT snapshot.id,
              row_number() OVER (
                PARTITION BY snapshot.task_id
                ORDER BY snapshot.source_updated_at DESC, snapshot.id DESC
              ) AS position
            FROM capture_task_snapshots snapshot
            WHERE snapshot.task_id = ANY($1::uuid[])
          ), deleted AS (
            DELETE FROM capture_task_snapshots snapshot
            USING ranked
            WHERE snapshot.id = ranked.id
              AND ranked.position > 1
            RETURNING snapshot.id
          )
          SELECT COUNT(*)::integer AS deleted_count FROM deleted
        `, [taskIds])
      : {deleted_count: 0};
    await tx.execute(`
      UPDATE capture_tasks root
      SET technical_compacted_at = now()
      WHERE root.id = ANY($1::uuid[])
        AND root.parent_task_id IS NULL
        AND root.technical_compacted_at IS NULL
    `, [rootIds]);
    return {
      rootCount: rootIds.length,
      taskCount: taskIds.length,
      deletedSnapshotCount: Number(deleted?.deleted_count || 0),
      retentionDays: days,
    };
  });
}
