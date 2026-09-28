// Narrow admission guard for browser detail jobs produced by Android discovery.
// Other workflows and other error categories keep their existing admission rules.
export const DETAIL_OPEN_TIMEOUT_CODE = 'TARGET_RUNNER_TAB_TIMEOUT';
export const DETAIL_OPEN_TIMEOUT_THRESHOLD = 3;
export const DETAIL_OPEN_TIMEOUT_WINDOW_MS = 15 * 60 * 1000;
export const DETAIL_OPEN_TIMEOUT_COOLDOWN_MS = 5 * 60 * 1000;
export const DETAIL_OPEN_TIMEOUT_QUERY_TIMEOUT_MS = 750;

export function discoveryDetailTimeoutCooldownMs(recentExecutions = [], now = Date.now()) {
  const executions = recentExecutions.slice(0, DETAIL_OPEN_TIMEOUT_THRESHOLD);
  const nowMs = new Date(now).getTime();
  if (executions.length !== DETAIL_OPEN_TIMEOUT_THRESHOLD || !Number.isFinite(nowMs)) return 0;
  const receivedTimes = [];
  for (const execution of executions) {
    // A late formal receipt can complete the task while the original timeout
    // remains in the original attempt evidence. That success resets the streak.
    if (!['failed', 'needs_action'].includes(execution.task_status)
        || execution.attempt_status !== 'failed'
        || execution.error_code !== DETAIL_OPEN_TIMEOUT_CODE) return 0;
    const receivedAt = execution.first_timeout_received_at == null
      ? NaN : new Date(execution.first_timeout_received_at).getTime();
    if (!Number.isFinite(receivedAt) || receivedAt > nowMs
        || nowMs - receivedAt > DETAIL_OPEN_TIMEOUT_WINDOW_MS) return 0;
    receivedTimes.push(receivedAt);
  }
  // The query returns newest execution first, once per task/strict attempt.
  // Repeated terminal heartbeats cannot move its first receipt time forward.
  return Math.max(0, receivedTimes[0] + DETAIL_OPEN_TIMEOUT_COOLDOWN_MS - nowMs);
}

export async function readDiscoveryDetailTimeoutCooldownMs(tx, {tenantId, agentId}) {
  // A failed optional history read must not abort the heartbeat transaction and
  // suppress unrelated keyword/patrol claims. A JS catch alone cannot recover
  // an aborted PostgreSQL transaction; keep this query inside its own savepoint.
  await tx.execute('SAVEPOINT discovery_detail_timeout_cooldown');
  try {
    const timeout = await tx.queryOne(`
      SELECT setting AS previous_timeout_ms,
        set_config('statement_timeout',
          (CASE WHEN setting::integer=0 THEN $1::integer
            ELSE LEAST(setting::integer,$1::integer) END)::text || 'ms', true)
      FROM pg_settings WHERE name='statement_timeout'
    `, [DETAIL_OPEN_TIMEOUT_QUERY_TIMEOUT_MS]);
    const executions = await tx.queryAll(`
    SELECT task.status AS task_status, attempt.status AS attempt_status,
      attempt.error->>'code' AS error_code, receipt.first_timeout_received_at,
      now() AS observed_at
    FROM (
      SELECT id, tenant_id, status, metadata, created_at
      FROM capture_tasks
      WHERE tenant_id=$1 AND assigned_agent_id=$2
        AND task_type='discovered_post_capture'
        AND created_at >= now() - ($3::bigint * interval '1 millisecond')
        AND updated_at >= now() - ($3::bigint * interval '1 millisecond')
      ORDER BY created_at DESC, id DESC LIMIT $4
    ) task
    LEFT JOIN LATERAL (
      SELECT id, status, error, client_attempt_id FROM capture_task_attempts
      WHERE tenant_id=$1 AND task_id=task.id AND agent_id=$2
        AND client_attempt_id=task.metadata->>'attemptIdentity'
        AND client_attempt_id<>''
      ORDER BY attempt_number DESC LIMIT 1
    ) attempt ON true
    LEFT JOIN LATERAL (
      SELECT MIN(received_at) AS first_timeout_received_at
      FROM capture_task_snapshots
      WHERE tenant_id=$1 AND task_id=task.id AND agent_id=$2
        AND attempt_id=attempt.id AND client_attempt_id=attempt.client_attempt_id
        AND status='failed' AND error->>'code'=$5
    ) receipt ON true
    ORDER BY task.created_at DESC, task.id DESC
  `, [tenantId, agentId, DETAIL_OPEN_TIMEOUT_WINDOW_MS,
    DETAIL_OPEN_TIMEOUT_THRESHOLD, DETAIL_OPEN_TIMEOUT_CODE]);
    await tx.queryOne("SELECT set_config('statement_timeout',$1,true)",
      [`${timeout.previous_timeout_ms}ms`]);
    return discoveryDetailTimeoutCooldownMs(executions, executions[0]?.observed_at);
  } catch {
    await tx.execute('ROLLBACK TO SAVEPOINT discovery_detail_timeout_cooldown');
    console.warn('[Capture discovery] Timeout history unavailable; retaining existing admission rules');
    return 0;
  } finally {
    await tx.execute('RELEASE SAVEPOINT discovery_detail_timeout_cooldown');
  }
}

