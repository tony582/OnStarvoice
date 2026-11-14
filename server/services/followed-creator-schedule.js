// Tenant monitor_runTimes is stored as a comma-separated list in Asia/Shanghai.
export function nextCreatorPatrolTime(value, now = new Date()) {
  const times = String(value ?? '').split(',').map(s => s.trim())
    .filter(s => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(s)).sort();
  if (!times.length) times.push('10:00');
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  for (const time of times) {
    const candidate = new Date(`${day}T${time}:00+08:00`);
    if (candidate > now) return candidate;
  }
  return new Date(new Date(`${day}T${times[0]}:00+08:00`).getTime() + 86400000);
}

export function creatorPatrolNextRun({outcome, retryCount, runTimes, now = new Date()}) {
  const fixed = nextCreatorPatrolTime(runTimes, now);
  if (outcome === 'failed' && retryCount < 2) {
    const retry = new Date(now.getTime() + 30 * 60000);
    if (retry < fixed) return {nextRunAt: retry, retryCount: retryCount + 1};
  }
  return {nextRunAt: fixed, retryCount: 0};
}

// Claim the scheduling projection separately from execution completion: old
// Extensions may report completion before the task snapshot arrives.
export async function projectProfilePatrolSchedule(tx, tenantId, ids) {
  if (!ids.length) return;
  const executions = await tx.queryAll(`
    UPDATE monitor_executions e SET schedule_projected_at=now()
    WHERE e.tenant_id=$1 AND e.id=ANY($2::uuid[])
      AND e.schedule_projected_at IS NULL
      AND e.status IN ('succeeded','failed','cancelled')
    RETURNING e.id,e.status,e.finished_at,e.error_message,e.subscription_id,
      EXISTS(SELECT 1 FROM capture_task_items i JOIN capture_tasks t
        ON t.tenant_id=i.tenant_id AND t.id=i.task_id
        WHERE i.tenant_id=e.tenant_id AND i.metadata->>'monitorExecutionId'=e.id::text
          AND t.trigger_type='profile_scan_schedule') AS scheduled
  `, [tenantId, ids]);
  for (const execution of executions) {
    const subscription = await tx.queryOne(`SELECT * FROM monitor_subscriptions
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, execution.subscription_id]);
    if (!subscription) continue;
    const finishedAt = new Date(execution.finished_at || Date.now());
    if (subscription.last_run_at && new Date(subscription.last_run_at) > finishedAt) continue;
    let nextRunAt = subscription.next_run_at;
    let retryCount = subscription.patrol_retry_count;
    if (subscription.subject_type === 'creator') {
      if (execution.status === 'succeeded' || execution.scheduled) {
        const setting = await tx.queryOne("SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='monitor_runTimes'", [tenantId]);
        const outcome = execution.status === 'failed' && subscription.status === 'active' &&
          subscription.auto_patrol_enabled ? 'failed' : execution.status === 'succeeded' ? 'succeeded' : 'fixed';
        ({nextRunAt, retryCount} = creatorPatrolNextRun({
          outcome, retryCount, runTimes: setting?.value, now: finishedAt,
        }));
      }
    } else {
      const minutes = execution.status === 'failed' ? 15 : subscription.cadence_minutes;
      nextRunAt = new Date(finishedAt.getTime() + minutes * 60000);
    }
    await tx.execute(`UPDATE monitor_subscriptions SET last_run_at=$1,next_run_at=$2,
      patrol_retry_count=$3,last_error=$4,updated_at=now()
      WHERE tenant_id=$5 AND id=$6`,
    [finishedAt, nextRunAt, retryCount, execution.status === 'succeeded' ? '' : execution.error_message, tenantId, subscription.id]);
  }
}
