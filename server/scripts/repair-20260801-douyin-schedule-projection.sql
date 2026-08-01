\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The morning Douyin run was repaired before v0.3.72 started projecting
-- non-terminal parent statuses back to its schedule. Reconcile only that
-- known parent/template pair, with row locks and a replay guard.
SELECT task.id
FROM capture_tasks task
WHERE task.id IN (
  'ad9383dd-3c1f-429e-8cd6-bee20d5499b6',
  '5d82f911-bbec-429f-b6e3-c038f775166b'
)
ORDER BY task.id
FOR UPDATE;

SELECT schedule.id
FROM capture_orchestration_schedules schedule
WHERE schedule.id = 'd120e285-3904-4437-acbd-9c6e3d4a9ce9'
FOR UPDATE;

DO $repair$
DECLARE
  tenant_uuid CONSTANT UUID := '457e5851-93eb-4446-84e5-eb6ddb871e65';
  parent_uuid CONSTANT UUID := 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6';
  schedule_uuid CONSTANT UUID := 'd120e285-3904-4437-acbd-9c6e3d4a9ce9';
  template_uuid CONSTANT UUID := '5d82f911-bbec-429f-b6e3-c038f775166b';
  schedule_status TEXT;
  schedule_next_run_at TIMESTAMPTZ;
  schedule_last_run_at TIMESTAMPTZ;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capture_task_events event
    WHERE event.tenant_id = tenant_uuid
      AND event.task_id = template_uuid
      AND event.event_type =
        'orchestration_schedule_run_status_reconciled_v0372'
  ) THEN
    RAISE EXCEPTION 'Douyin schedule projection repair was already applied';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_tasks parent
    WHERE parent.id = parent_uuid
      AND parent.tenant_id = tenant_uuid
      AND parent.task_type = 'capture_orchestration'
      AND parent.orchestration_revision = 4
      AND parent.orchestration_schedule_id = schedule_uuid
      AND parent.status = 'needs_action'
      AND parent.message = '部分关键词工作项需要人工处理'
  ) THEN
    RAISE EXCEPTION 'Douyin parent orchestration precondition changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_tasks template
    WHERE template.id = template_uuid
      AND template.tenant_id = tenant_uuid
      AND template.status = 'completed'
      AND template.metadata->>'lastRunTaskId' = parent_uuid::text
      AND template.metadata->>'lastRunStatus' = 'pending'
  ) THEN
    RAISE EXCEPTION 'Douyin schedule template precondition changed';
  END IF;

  UPDATE capture_orchestration_schedules schedule
  SET last_run_status = 'needs_action',
    last_error = jsonb_build_object(
      'code', 'scheduled_run_needs_action',
      'message', '部分关键词工作项需要人工处理'
    ),
    updated_at = now()
  WHERE schedule.id = schedule_uuid
    AND schedule.tenant_id = tenant_uuid
    AND schedule.template_task_id = template_uuid
    AND schedule.last_run_task_id = parent_uuid
    AND schedule.status = 'completed'
    AND schedule.last_run_status = 'pending'
  RETURNING schedule.status, schedule.next_run_at, schedule.last_run_at
  INTO schedule_status, schedule_next_run_at, schedule_last_run_at;

  IF schedule_status IS NULL THEN
    RAISE EXCEPTION 'Douyin schedule projection update conflict';
  END IF;

  UPDATE capture_tasks
  SET metadata = metadata || jsonb_build_object(
      'scheduleStatus', schedule_status,
      'nextRunAt', COALESCE(schedule_next_run_at::text, ''),
      'lastRunAt', COALESCE(schedule_last_run_at::text, ''),
      'lastRunStatus', 'needs_action',
      'lastRunTaskId', parent_uuid::text
    ),
    message = '上一轮有待处理项，可在云端重试失败关键词',
    updated_at = now(),
    source_updated_at = now()
  WHERE id = template_uuid
    AND tenant_id = tenant_uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin schedule template update conflict';
  END IF;

  INSERT INTO capture_task_events (
    tenant_id, task_id, event_type, actor_type, actor_id,
    actor_name, status, message, payload
  ) VALUES (
    tenant_uuid, template_uuid,
    'orchestration_schedule_run_status_reconciled_v0372',
    'system', '', '0.3.72 发布修复', schedule_status,
    '上午无人值守计划状态已按父任务重新投影',
    jsonb_build_object(
      'runTaskId', parent_uuid,
      'runStatus', 'needs_action',
      'nextRunAt', schedule_next_run_at,
      'historicalRepair', true
    )
  );
END
$repair$;

COMMIT;
