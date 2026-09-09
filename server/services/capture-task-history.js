const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeHistoryClearTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || value.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id))) return null;
  return [...new Set(value.map(id => id.toLowerCase()))].sort();
}

// JSON flags are optional. Comparing a missing flag directly with 'true'
// inside NOT would produce SQL NULL and hide ordinary orchestration runs.
export function captureTaskHistoryEligibilitySql(alias = 't', {includeCleared = false} = {}) {
  if (alias !== 't') throw new Error('Unsupported history task SQL alias');
  return `${alias}.task_type NOT IN ('unattended_plan_configuration', 'sync')
    AND RIGHT(${alias}.task_type, 5) <> '_sync'
    AND ${alias}.status IN (
      'completed', 'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'skipped', 'interrupted', 'needs_action'
    )
    AND NOT (
      ${alias}.task_type = 'capture_orchestration'
      AND (
        (${alias}.orchestration_revision = 0 AND COALESCE(${alias}.metadata->>'draft', 'false') = 'true')
        OR COALESCE(${alias}.metadata->>'orchestrationTemplate', 'false') = 'true'
      )
    )
    AND NOT (
      ${alias}.status IN ('interrupted', 'needs_action', 'failed', 'completed_with_failures')
      AND ${alias}.attention_dismissed_at IS NULL
    )
    ${includeCleared ? '' : `AND NULLIF(${alias}.metadata->>'historyClearedAt', '') IS NULL`}`;
}

export const captureTaskResultTreeSql = `WITH RECURSIVE task_tree AS (
  SELECT id FROM capture_tasks WHERE id = $1 AND tenant_id = $2
  UNION
  SELECT child.id FROM capture_tasks child
  JOIN task_tree parent ON child.parent_task_id = parent.id
  WHERE child.tenant_id = $2
)`;

export async function readCaptureTaskResultSummary(executor, taskId, tenantId) {
  const row = await executor.queryOne(`${captureTaskResultTreeSql}
    SELECT COUNT(*)::integer AS observation_count,
      COUNT(DISTINCT observation.record_id)::integer AS record_count,
      MIN(observation.captured_at) AS first_captured_at,
      MAX(observation.captured_at) AS last_captured_at
    FROM record_observations observation
    JOIN task_tree task ON task.id = observation.capture_task_id
    WHERE observation.tenant_id = $2
  `, [taskId, tenantId]);
  return {
    observationCount: Number(row?.observation_count || 0),
    recordCount: Number(row?.record_count || 0),
    firstCapturedAt: row?.first_captured_at || null,
    lastCapturedAt: row?.last_captured_at || null,
    evidence: 'linked_record_observations',
    scope: 'task_tree',
  };
}
