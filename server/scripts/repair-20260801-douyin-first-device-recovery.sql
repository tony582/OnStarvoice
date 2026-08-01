\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE repair_items (
  item_id UUID PRIMARY KEY,
  ordinal INTEGER NOT NULL,
  keyword TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO repair_items (item_id, ordinal, keyword) VALUES
  ('178183ee-5e4e-46f0-ac52-1d8f2b41589e', 6, 'ibuick'),
  ('b991c31b-63cd-4170-8c58-895292bf256e', 7, '别克远控'),
  ('e9dbe7ec-6b03-4a08-9b18-3a309fa7d4bd', 8, '别克APP');

-- Lock the known parent, source, recovery, template, schedule and item rows in
-- deterministic order. Any changed precondition aborts the whole transaction.
SELECT task.id
FROM capture_tasks task
WHERE task.id IN (
  'ad9383dd-3c1f-429e-8cd6-bee20d5499b6',
  '2384ca54-bb53-4596-94b8-869e89962f4d',
  'ffa0bef6-2930-459c-a357-2e00166cd314',
  '5d82f911-bbec-429f-b6e3-c038f775166b'
)
ORDER BY task.id
FOR UPDATE;

SELECT item.id
FROM capture_task_items item
WHERE item.id IN (SELECT item_id FROM repair_items)
ORDER BY item.id
FOR UPDATE;

SELECT schedule.id
FROM capture_orchestration_schedules schedule
WHERE schedule.id = 'd120e285-3904-4437-acbd-9c6e3d4a9ce9'
FOR UPDATE;

DO $preflight$
DECLARE
  tenant_uuid CONSTANT UUID := '457e5851-93eb-4446-84e5-eb6ddb871e65';
  parent_uuid CONSTANT UUID := 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6';
  source_uuid CONSTANT UUID := '2384ca54-bb53-4596-94b8-869e89962f4d';
  recovery_uuid CONSTANT UUID := 'ffa0bef6-2930-459c-a357-2e00166cd314';
  template_uuid CONSTANT UUID := '5d82f911-bbec-429f-b6e3-c038f775166b';
  schedule_uuid CONSTANT UUID := 'd120e285-3904-4437-acbd-9c6e3d4a9ce9';
  repair_event CONSTANT TEXT :=
    'orchestration_historical_first_device_recovery_reconciled_v0372';
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capture_task_events event
    WHERE event.tenant_id = tenant_uuid
      AND event.task_id = parent_uuid
      AND event.event_type = repair_event
  ) THEN
    RAISE EXCEPTION 'Douyin first device recovery repair was already applied';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_tasks parent
    WHERE parent.id = parent_uuid
      AND parent.tenant_id = tenant_uuid
      AND parent.task_type = 'capture_orchestration'
      AND parent.status = 'needs_action'
      AND parent.orchestration_revision = 4
      AND parent.orchestration_schedule_id = schedule_uuid
  ) THEN
    RAISE EXCEPTION 'Douyin parent precondition changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_tasks source
    WHERE source.id = source_uuid
      AND source.tenant_id = tenant_uuid
      AND source.parent_task_id = parent_uuid
      AND source.task_type = 'unattended_keyword_capture'
      AND source.status = 'superseded'
      AND source.origin_agent_id =
        'c6fbcd8a-5bd0-4254-a51b-7e53ba1eda57'::uuid
      AND source.metadata->>'recoveryTaskId' =
        '20163c79-0a97-46e2-a1c3-68d480ea61d2'
  ) THEN
    RAISE EXCEPTION 'Douyin source execution precondition changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_tasks recovery
    WHERE recovery.id = recovery_uuid
      AND recovery.tenant_id = tenant_uuid
      AND recovery.parent_task_id IS NULL
      AND recovery.client_task_id =
        '20163c79-0a97-46e2-a1c3-68d480ea61d2'
      AND recovery.task_type = 'unattended_keyword_capture'
      AND recovery.status = 'completed'
      AND recovery.origin_agent_id =
        'c6fbcd8a-5bd0-4254-a51b-7e53ba1eda57'::uuid
      AND recovery.metadata->>'parentRequestId' = source_uuid::text
      AND recovery.metadata->>'cloudAssigned' = 'true'
  ) THEN
    RAISE EXCEPTION 'Douyin recovery execution precondition changed';
  END IF;

  IF (
    SELECT count(*)
    FROM capture_task_items item
    JOIN repair_items repair ON repair.item_id = item.id
    WHERE item.tenant_id = tenant_uuid
      AND item.task_id = parent_uuid
      AND item.execution_task_id = source_uuid
      AND item.assigned_agent_id =
        'c6fbcd8a-5bd0-4254-a51b-7e53ba1eda57'::uuid
      AND item.assignment_revision = 1
      AND item.attempt_count = 1
      AND item.ordinal = repair.ordinal
      AND item.keyword = repair.keyword
      AND item.status IN ('retryable', 'needs_action')
  ) <> 3 THEN
    RAISE EXCEPTION 'Douyin unfinished item precondition changed';
  END IF;

  IF (
    SELECT count(*)
    FROM capture_tasks recovery
    CROSS JOIN LATERAL jsonb_array_elements(
      recovery.checkpoint->'keywordResults'
    ) result
    JOIN repair_items repair ON repair.keyword = result->>'keyword'
    WHERE recovery.id = recovery_uuid
      AND recovery.tenant_id = tenant_uuid
      AND result->>'status' = 'completed'
      AND COALESCE(result->>'finishedAt', '') <> ''
  ) <> 3 THEN
    RAISE EXCEPTION 'Douyin recovery result evidence changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM capture_orchestration_schedules schedule
    WHERE schedule.id = schedule_uuid
      AND schedule.tenant_id = tenant_uuid
      AND schedule.template_task_id = template_uuid
      AND schedule.last_run_task_id = parent_uuid
      AND schedule.status = 'completed'
      AND schedule.last_run_status = 'needs_action'
  ) THEN
    RAISE EXCEPTION 'Douyin schedule precondition changed';
  END IF;
END
$preflight$;

DO $repair$
DECLARE
  tenant_uuid CONSTANT UUID := '457e5851-93eb-4446-84e5-eb6ddb871e65';
  parent_uuid CONSTANT UUID := 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6';
  source_uuid CONSTANT UUID := '2384ca54-bb53-4596-94b8-869e89962f4d';
  recovery_uuid CONSTANT UUID := 'ffa0bef6-2930-459c-a357-2e00166cd314';
  template_uuid CONSTANT UUID := '5d82f911-bbec-429f-b6e3-c038f775166b';
  schedule_uuid CONSTANT UUID := 'd120e285-3904-4437-acbd-9c6e3d4a9ce9';
  agent_uuid CONSTANT UUID := 'c6fbcd8a-5bd0-4254-a51b-7e53ba1eda57';
  next_revision CONSTANT INTEGER := 5;
  repair RECORD;
  result JSONB;
  next_attempt INTEGER;
  request_hash_value TEXT;
  recovery_created_at TIMESTAMPTZ;
  recovery_started_at TIMESTAMPTZ;
  recovery_finished_at TIMESTAMPTZ;
BEGIN
  SELECT created_at, started_at, finished_at
  INTO recovery_created_at, recovery_started_at, recovery_finished_at
  FROM capture_tasks
  WHERE id = recovery_uuid AND tenant_id = tenant_uuid;

  UPDATE capture_tasks
  SET parent_task_id = parent_uuid,
    title = 'dou · 08/01 08:55 · 设备重试',
    trigger_type = 'orchestration_local_recovery',
    metadata = metadata || jsonb_build_object(
      'orchestrationChild', true,
      'parentTaskId', parent_uuid::text,
      'orchestrationRevision', next_revision,
      'itemIds', (
        SELECT jsonb_agg(item_id ORDER BY ordinal) FROM repair_items
      ),
      'localRecovery', true,
      'localRecoverySourceExecutionTaskId', source_uuid::text,
      'localRecoveryAdoptedAt', now(),
      'historicalRecoveryRepair', '2026-08-01-first-device-v0.3.72'
    ),
    updated_at = now(),
    source_updated_at = now()
  WHERE id = recovery_uuid
    AND tenant_id = tenant_uuid
    AND parent_task_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin recovery attach conflict';
  END IF;

  UPDATE capture_tasks
  SET metadata = metadata || jsonb_build_object(
      'recoveryClientTaskId', '20163c79-0a97-46e2-a1c3-68d480ea61d2',
      'recoveryTaskId', recovery_uuid::text,
      'localRecoveryAdoptedAt', now(),
      'historicalRecoveryRepair', '2026-08-01-first-device-v0.3.72'
    ),
    message = '设备端重试已归入同一无人值守父任务',
    updated_at = now(),
    source_updated_at = now()
  WHERE id = source_uuid
    AND tenant_id = tenant_uuid
    AND parent_task_id = parent_uuid
    AND status = 'superseded';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin source update conflict';
  END IF;

  FOR repair IN SELECT * FROM repair_items ORDER BY ordinal LOOP
    SELECT entry
    INTO result
    FROM capture_tasks recovery
    CROSS JOIN LATERAL jsonb_array_elements(
      recovery.checkpoint->'keywordResults'
    ) entry
    WHERE recovery.id = recovery_uuid
      AND recovery.tenant_id = tenant_uuid
      AND entry->>'keyword' = repair.keyword
      AND entry->>'status' = 'completed';
    IF result IS NULL THEN
      RAISE EXCEPTION 'missing completed recovery evidence for %', repair.keyword;
    END IF;

    request_hash_value := encode(digest(
      concat_ws(':', parent_uuid, source_uuid, recovery_uuid,
        repair.item_id, next_revision),
      'sha256'
    ), 'hex');

    UPDATE capture_task_item_attempts
    SET status = 'canceled',
      error = jsonb_build_object(
        'code', 'superseded_by_device_recovery',
        'message', '原尝试已由设备端成功恢复任务接替',
        'successorExecutionTaskId', recovery_uuid::text,
        'previousError', error
      ),
      finished_at = COALESCE(finished_at, recovery_created_at),
      updated_at = now()
    WHERE tenant_id = tenant_uuid
      AND item_id = repair.item_id
      AND execution_task_id = source_uuid
      AND assignment_revision = 1
      AND status IN ('retryable', 'needs_action');

    UPDATE capture_task_items
    SET status = 'completed',
      attempt_count = attempt_count + 1,
      assigned_agent_id = agent_uuid,
      execution_task_id = recovery_uuid,
      assignment_revision = next_revision,
      request_hash = request_hash_value,
      error = '{}'::jsonb,
      metadata = (metadata - 'checkpoint') || jsonb_build_object(
        'checkpoint', result,
        'localRecoverySourceExecutionTaskId', source_uuid::text,
        'historicalRecoveryRepair', '2026-08-01-first-device-v0.3.72'
      ),
      assigned_at = recovery_created_at,
      dispatched_at = recovery_created_at,
      started_at = COALESCE(recovery_started_at, recovery_created_at),
      finished_at = (result->>'finishedAt')::timestamptz,
      updated_at = now()
    WHERE id = repair.item_id
      AND tenant_id = tenant_uuid
      AND task_id = parent_uuid
      AND execution_task_id = source_uuid
      AND assignment_revision = 1
      AND attempt_count = 1
      AND status IN ('retryable', 'needs_action')
    RETURNING attempt_count INTO next_attempt;
    IF next_attempt IS NULL THEN
      RAISE EXCEPTION 'Douyin item update conflict for %', repair.keyword;
    END IF;

    INSERT INTO capture_task_item_attempts (
      id, tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, checkpoint, result, error,
      assigned_at, dispatched_at, started_at, finished_at
    ) VALUES (
      gen_random_uuid(), tenant_uuid, repair.item_id, parent_uuid, recovery_uuid,
      agent_uuid, next_attempt, next_revision, 'completed',
      request_hash_value, result,
      jsonb_build_object(
        'savedCount', COALESCE((result->>'savedCount')::integer, 0)
      ),
      '{}'::jsonb, recovery_created_at, recovery_created_at,
      COALESCE(recovery_started_at, recovery_created_at),
      (result->>'finishedAt')::timestamptz
    );
  END LOOP;

  IF (
    SELECT count(*)
    FROM capture_task_items item
    WHERE item.tenant_id = tenant_uuid
      AND item.task_id = parent_uuid
      AND item.status = 'completed'
  ) <> 13 THEN
    RAISE EXCEPTION 'Douyin parent is not exactly 13/13 completed after repair';
  END IF;

  UPDATE capture_tasks
  SET orchestration_revision = next_revision,
    status = 'completed',
    progress = jsonb_build_object('current', 13, 'total', 13, 'percent', 100),
    counts = jsonb_build_object(
      'total', 13,
      'pending', 0,
      'assigned', 0,
      'dispatchPending', 0,
      'dispatched', 0,
      'waitingDevice', 0,
      'running', 0,
      'retryable', 0,
      'needsAction', 0,
      'completed', 13,
      'completedWithWarnings', 0,
      'failed', 0,
      'skipped', 0,
      'canceled', 0,
      'settled', 13
    ),
    metadata = metadata || jsonb_build_object(
      'lastLocalRecoveryAt', now(),
      'lastLocalRecoverySourceExecutionTaskId', source_uuid::text,
      'lastLocalRecoveryTaskId', recovery_uuid::text,
      'historicalRecoveryRepair', '2026-08-01-first-device-v0.3.72'
    ),
    message = '多 Agent 关键词任务已全部完成',
    finished_at = recovery_finished_at,
    attention_dismissed_at = NULL,
    updated_at = now(),
    source_updated_at = now()
  WHERE id = parent_uuid
    AND tenant_id = tenant_uuid
    AND status = 'needs_action'
    AND orchestration_revision = 4;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin parent revision conflict';
  END IF;

  UPDATE capture_orchestration_schedules
  SET last_run_at = recovery_finished_at,
    last_run_status = 'completed',
    last_error = '{}'::jsonb,
    updated_at = now()
  WHERE id = schedule_uuid
    AND tenant_id = tenant_uuid
    AND template_task_id = template_uuid
    AND last_run_task_id = parent_uuid
    AND last_run_status = 'needs_action';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin schedule update conflict';
  END IF;

  UPDATE capture_tasks
  SET metadata = metadata || jsonb_build_object(
      'scheduleStatus', 'completed',
      'nextRunAt', '',
      'lastRunAt', recovery_finished_at::text,
      'lastRunStatus', 'completed',
      'lastRunTaskId', parent_uuid::text
    ),
    message = '上一轮多 Agent 无人值守任务已全部完成',
    updated_at = now(),
    source_updated_at = now()
  WHERE id = template_uuid
    AND tenant_id = tenant_uuid
    AND metadata->>'lastRunTaskId' = parent_uuid::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Douyin template update conflict';
  END IF;

  INSERT INTO capture_task_events (
    tenant_id, task_id, agent_id, event_type,
    actor_type, actor_id, actor_name, status, message, payload
  ) VALUES (
    tenant_uuid, parent_uuid, agent_uuid,
    'orchestration_historical_first_device_recovery_reconciled_v0372',
    'system', '', '0.3.72 发布修复', 'completed',
    '上午第一次设备端重试已合并回原无人值守父任务',
    jsonb_build_object(
      'sourceExecutionTaskId', source_uuid,
      'recoveryTaskId', recovery_uuid,
      'recoveryClientTaskId', '20163c79-0a97-46e2-a1c3-68d480ea61d2',
      'itemIds', (SELECT jsonb_agg(item_id ORDER BY ordinal) FROM repair_items),
      'revision', next_revision,
      'historicalRepair', true
    )
  );

  INSERT INTO capture_task_events (
    tenant_id, task_id, event_type, actor_type, actor_id,
    actor_name, status, message, payload
  ) VALUES (
    tenant_uuid, template_uuid,
    'orchestration_schedule_run_settled',
    'system', '', '0.3.72 发布修复', 'completed',
    '无人值守计划的一轮多 Agent 任务已完成历史恢复对账',
    jsonb_build_object(
      'runTaskId', parent_uuid,
      'runStatus', 'completed',
      'historicalRepair', true
    )
  );
END
$repair$;

COMMIT;
