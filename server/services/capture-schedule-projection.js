// Plans are durable configuration, not a page of recent executions. Read the
// schedule table independently so any number of newer tasks cannot hide them.
export async function loadCaptureScheduleTemplates(executor, tenantId) {
  return executor.queryAll(`
    SELECT t.*,
      schedule.id AS orchestration_schedule_id,
      t.metadata || jsonb_build_object(
        'orchestrationTemplate', true,
        'scheduleStatus', schedule.status,
        'scheduleArchivedAt', schedule.archived_at,
        'nextRunAt', schedule.next_run_at
      ) AS metadata
    FROM capture_orchestration_schedules schedule
    JOIN capture_tasks t
      ON t.id = schedule.template_task_id
      AND t.tenant_id = schedule.tenant_id
    WHERE schedule.tenant_id = $1
      AND t.task_type = 'capture_orchestration'
      AND t.parent_task_id IS NULL
    ORDER BY schedule.updated_at DESC, schedule.id DESC
  `, [tenantId]);
}
