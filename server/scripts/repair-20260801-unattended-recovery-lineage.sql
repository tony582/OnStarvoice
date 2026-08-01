\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE repair_steps (
  step_order INTEGER PRIMARY KEY,
  parent_task_id UUID NOT NULL,
  item_id UUID NOT NULL,
  source_task_id UUID NOT NULL,
  recovery_task_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  parent_revision INTEGER NOT NULL,
  final_item_status TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO repair_steps VALUES
  (1, 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6', 'cadb7eba-ad44-4f12-b282-90ad82f99e5f', '1a8c3127-fab3-4a88-8ca2-766b22d0ee4f', 'a76e9bac-42c0-45d0-894a-afd4fca86cb1', 'a4a4ee39-ef6e-4d64-9196-199a814d4e4e', 2, 'failed'),
  (2, 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6', '2d4bf843-932c-4a98-98f8-9edc44437e89', 'df2673a7-3e84-4dfb-bdef-cdd2c6c19563', '9df13fe0-0a47-4a22-8718-597ae47889fe', '33e2bc8c-b956-4d67-9838-28d83cbed788', 3, 'completed'),
  (3, 'ad9383dd-3c1f-429e-8cd6-bee20d5499b6', 'cadb7eba-ad44-4f12-b282-90ad82f99e5f', 'a76e9bac-42c0-45d0-894a-afd4fca86cb1', '7d21b6a0-3bcb-4a90-ab64-7e01af1202b8', 'a4a4ee39-ef6e-4d64-9196-199a814d4e4e', 4, 'completed'),
  (4, '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505', '672bf77e-e058-49da-831e-6b45f2f2e67d', '9320aa6c-5218-4328-bc5d-07f6baced155', 'd83db031-66e7-456e-9adc-daa514478965', '9aaea4c0-7fcf-4208-a3c7-b530ce19a10f', 2, 'retryable'),
  (5, '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505', '672bf77e-e058-49da-831e-6b45f2f2e67d', 'd83db031-66e7-456e-9adc-daa514478965', '38495ac3-ff3e-4616-bc62-0af0d0400277', '9aaea4c0-7fcf-4208-a3c7-b530ce19a10f', 3, 'failed');

-- Lock every row in deterministic order before validating or changing it.
SELECT task.id
FROM capture_tasks task
WHERE task.id IN (
  SELECT parent_task_id FROM repair_steps
  UNION
  SELECT source_task_id FROM repair_steps
  UNION
  SELECT recovery_task_id FROM repair_steps
)
ORDER BY task.id
FOR UPDATE;

SELECT item.id
FROM capture_task_items item
WHERE item.id IN (SELECT item_id FROM repair_steps)
ORDER BY item.id
FOR UPDATE;

DO $preflight$
DECLARE
  tenant_uuid CONSTANT UUID := '457e5851-93eb-4446-84e5-eb6ddb871e65';
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capture_task_events
    WHERE tenant_id = tenant_uuid
      AND event_type = 'orchestration_historical_recovery_reconciled_v0372'
      AND task_id IN (
        'ad9383dd-3c1f-429e-8cd6-bee20d5499b6',
        '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505'
      )
  ) THEN
    RAISE EXCEPTION 'repair 20260801 unattended recovery lineage was already applied';
  END IF;

  IF (
    SELECT count(*)
    FROM capture_tasks parent
    WHERE parent.tenant_id = tenant_uuid
      AND parent.id IN (
        'ad9383dd-3c1f-429e-8cd6-bee20d5499b6',
        '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505'
      )
      AND parent.task_type = 'capture_orchestration'
      AND parent.orchestration_revision = 1
      AND parent.status = 'needs_action'
  ) <> 2 THEN
    RAISE EXCEPTION 'parent orchestration precondition changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_steps step
    LEFT JOIN capture_tasks recovery
      ON recovery.id = step.recovery_task_id
      AND recovery.tenant_id = tenant_uuid
    LEFT JOIN capture_tasks source
      ON source.id = step.source_task_id
      AND source.tenant_id = tenant_uuid
    LEFT JOIN capture_task_items item
      ON item.id = step.item_id
      AND item.tenant_id = tenant_uuid
      AND item.task_id = step.parent_task_id
    WHERE recovery.id IS NULL
      OR source.id IS NULL
      OR item.id IS NULL
      OR recovery.parent_task_id IS NOT NULL
      OR recovery.task_type <> 'unattended_keyword_capture'
      OR recovery.origin_agent_id <> step.agent_id
      OR source.origin_agent_id <> step.agent_id
      OR recovery.metadata->>'parentRequestId' <> source.client_task_id
      OR recovery.metadata->>'cloudAssigned' <> 'true'
      OR recovery.checkpoint->'keywordResults'->0->>'keyword' <> item.keyword
  ) THEN
    RAISE EXCEPTION 'recovery lineage precondition changed';
  END IF;

  IF (
    SELECT count(*)
    FROM capture_task_items item
    WHERE item.tenant_id = tenant_uuid
      AND (
        (
          item.id = 'cadb7eba-ad44-4f12-b282-90ad82f99e5f'
          AND item.execution_task_id = '1a8c3127-fab3-4a88-8ca2-766b22d0ee4f'
          AND item.status = 'failed'
          AND item.attempt_count = 2
          AND item.assignment_revision = 1
        )
        OR (
          item.id = '2d4bf843-932c-4a98-98f8-9edc44437e89'
          AND item.execution_task_id = 'df2673a7-3e84-4dfb-bdef-cdd2c6c19563'
          AND item.status = 'failed'
          AND item.attempt_count = 2
          AND item.assignment_revision = 1
        )
        OR (
          item.id = '672bf77e-e058-49da-831e-6b45f2f2e67d'
          AND item.execution_task_id = '9320aa6c-5218-4328-bc5d-07f6baced155'
          AND item.status = 'retryable'
          AND item.attempt_count = 1
          AND item.assignment_revision = 1
        )
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'keyword item precondition changed';
  END IF;
END
$preflight$;

DO $repair$
DECLARE
  tenant_uuid CONSTANT UUID := '457e5851-93eb-4446-84e5-eb6ddb871e65';
  step RECORD;
  parent_title TEXT;
  keyword_text TEXT;
  keyword_result JSONB;
  checkpoint_json JSONB;
  error_json JSONB;
  request_hash_value TEXT;
  recovery_created_at TIMESTAMPTZ;
  recovery_finished_at TIMESTAMPTZ;
  attempt_number_value INTEGER;
  parent_uuid UUID;
  total_count INTEGER;
  pending_count INTEGER;
  assigned_count INTEGER;
  dispatch_pending_count INTEGER;
  dispatched_count INTEGER;
  waiting_device_count INTEGER;
  running_count INTEGER;
  retryable_count INTEGER;
  needs_action_count INTEGER;
  completed_count INTEGER;
  warning_count INTEGER;
  failed_count INTEGER;
  skipped_count INTEGER;
  canceled_count INTEGER;
  settled_count INTEGER;
  parent_status TEXT;
  parent_terminal BOOLEAN;
  parent_message TEXT;
  schedule_template_id UUID;
  schedule_status TEXT;
  schedule_next_run_at TIMESTAMPTZ;
BEGIN
  FOR step IN SELECT * FROM repair_steps ORDER BY step_order LOOP
    SELECT parent.title, item.keyword,
      recovery.checkpoint->'keywordResults'->0,
      recovery.created_at, recovery.finished_at
    INTO parent_title, keyword_text, keyword_result,
      recovery_created_at, recovery_finished_at
    FROM capture_tasks parent
    JOIN capture_task_items item ON item.id = step.item_id
    JOIN capture_tasks recovery ON recovery.id = step.recovery_task_id
    WHERE parent.id = step.parent_task_id
      AND parent.tenant_id = tenant_uuid
      AND parent.orchestration_revision = step.parent_revision - 1
      AND item.tenant_id = tenant_uuid
      AND item.task_id = parent.id
      AND item.execution_task_id = step.source_task_id
      AND item.status IN ('retryable', 'needs_action', 'failed');

    IF keyword_result IS NULL THEN
      RAISE EXCEPTION 'step % no longer owns its expected keyword item', step.step_order;
    END IF;

    checkpoint_json := jsonb_strip_nulls(jsonb_build_object(
      'round', GREATEST(1, COALESCE((keyword_result->>'round')::integer, 1)),
      'index', GREATEST(0, COALESCE((keyword_result->>'index')::integer, 0)),
      'keyword', keyword_text,
      'status', keyword_result->>'status',
      'attemptCount', COALESCE((keyword_result->>'attemptCount')::integer, 0),
      'savedCount', COALESCE((keyword_result->>'savedCount')::integer, 0),
      'errorCode', NULLIF(keyword_result->>'errorCode', ''),
      'finishedAt', NULLIF(keyword_result->>'finishedAt', '')
    ));
    error_json := '{}'::jsonb;
    IF COALESCE(keyword_result->>'error', '') <> '' THEN
      error_json := jsonb_build_object('message', keyword_result->>'error');
    END IF;
    IF COALESCE(keyword_result->>'errorCode', '') <> '' THEN
      error_json := error_json || jsonb_build_object(
        'code', keyword_result->>'errorCode'
      );
    END IF;
    IF COALESCE(keyword_result->>'errorCategory', '') <> '' THEN
      error_json := error_json || jsonb_build_object(
        'category', keyword_result->>'errorCategory'
      );
    END IF;
    request_hash_value := encode(digest(
      concat_ws(':', step.parent_task_id, step.source_task_id,
        step.recovery_task_id, step.item_id, step.parent_revision),
      'sha256'
    ), 'hex');

    UPDATE capture_tasks
    SET parent_task_id = step.parent_task_id,
      title = left(parent_title || ' · 设备重试', 240),
      trigger_type = 'orchestration_local_recovery',
      metadata = metadata || jsonb_build_object(
        'orchestrationChild', true,
        'parentTaskId', step.parent_task_id::text,
        'orchestrationRevision', step.parent_revision,
        'itemIds', jsonb_build_array(step.item_id::text),
        'localRecovery', true,
        'localRecoverySourceExecutionTaskId', step.source_task_id::text,
        'localRecoveryAdoptedAt', now(),
        'historicalRecoveryRepair', '2026-08-01-v0.3.72'
      ),
      updated_at = now(),
      source_updated_at = now()
    WHERE id = step.recovery_task_id
      AND tenant_id = tenant_uuid
      AND parent_task_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step % recovery task attach conflict', step.step_order;
    END IF;

    UPDATE capture_tasks
    SET status = 'superseded',
      metadata = metadata || jsonb_build_object(
        'recoveryTaskId', step.recovery_task_id::text,
        'localRecoveryAdoptedAt', now(),
        'historicalRecoveryRepair', '2026-08-01-v0.3.72'
      ),
      message = '设备端重试已归入同一无人值守父任务',
      finished_at = COALESCE(finished_at, now()),
      updated_at = now(),
      source_updated_at = now()
    WHERE id = step.source_task_id
      AND tenant_id = tenant_uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step % source task update conflict', step.step_order;
    END IF;

    UPDATE capture_task_items
    SET status = step.final_item_status,
      attempt_count = attempt_count + 1,
      assigned_agent_id = step.agent_id,
      execution_task_id = step.recovery_task_id,
      assignment_revision = step.parent_revision,
      request_hash = request_hash_value,
      error = error_json,
      metadata = metadata || jsonb_build_object(
        'checkpoint', checkpoint_json,
        'localRecoverySourceExecutionTaskId', step.source_task_id::text,
        'historicalRecoveryRepair', '2026-08-01-v0.3.72'
      ),
      assigned_at = recovery_created_at,
      dispatched_at = recovery_created_at,
      started_at = COALESCE(started_at, recovery_created_at),
      finished_at = CASE
        WHEN step.final_item_status IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
        ) THEN COALESCE(
          NULLIF(keyword_result->>'finishedAt', '')::timestamptz,
          recovery_finished_at,
          now()
        )
        ELSE NULL
      END,
      updated_at = now()
    WHERE id = step.item_id
      AND tenant_id = tenant_uuid
      AND task_id = step.parent_task_id
      AND execution_task_id = step.source_task_id
      AND status IN ('retryable', 'needs_action', 'failed')
    RETURNING attempt_count INTO attempt_number_value;
    IF attempt_number_value IS NULL THEN
      RAISE EXCEPTION 'step % keyword item update conflict', step.step_order;
    END IF;

    INSERT INTO capture_task_item_attempts (
      id, tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, checkpoint, result, error,
      assigned_at, dispatched_at, started_at, finished_at
    ) VALUES (
      gen_random_uuid(), tenant_uuid, step.item_id, step.parent_task_id,
      step.recovery_task_id, step.agent_id, attempt_number_value,
      step.parent_revision, step.final_item_status, request_hash_value,
      checkpoint_json,
      jsonb_build_object(
        'savedCount', COALESCE((keyword_result->>'savedCount')::integer, 0)
      ),
      error_json, recovery_created_at, recovery_created_at,
      recovery_created_at,
      CASE
        WHEN step.final_item_status IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
        ) THEN COALESCE(
          NULLIF(keyword_result->>'finishedAt', '')::timestamptz,
          recovery_finished_at,
          now()
        )
        ELSE NULL
      END
    );

    UPDATE capture_tasks
    SET orchestration_revision = step.parent_revision,
      status = 'running',
      metadata = metadata || jsonb_build_object(
        'lastLocalRecoveryAt', now(),
        'lastLocalRecoverySourceExecutionTaskId', step.source_task_id::text,
        'lastLocalRecoveryTaskId', step.recovery_task_id::text,
        'historicalRecoveryRepair', '2026-08-01-v0.3.72'
      ),
      message = '设备端重试已归入本轮无人值守任务',
      finished_at = NULL,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = step.parent_task_id
      AND tenant_id = tenant_uuid
      AND orchestration_revision = step.parent_revision - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step % parent revision conflict', step.step_order;
    END IF;

    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES (
      tenant_uuid, step.parent_task_id, step.agent_id,
      'orchestration_local_recovery_adopted',
      'capture_agent', step.agent_id::text, '历史 Agent 恢复对账',
      'running', '设备端重试已合并到原无人值守任务',
      jsonb_build_object(
        'sourceExecutionTaskId', step.source_task_id,
        'recoveryTaskId', step.recovery_task_id,
        'revision', step.parent_revision,
        'itemIds', jsonb_build_array(step.item_id),
        'historicalRepair', true
      )
    );
  END LOOP;

  FOR parent_uuid IN
    SELECT DISTINCT parent_task_id FROM repair_steps ORDER BY parent_task_id
  LOOP
    SELECT
      count(*)::integer,
      count(*) FILTER (WHERE status = 'pending')::integer,
      count(*) FILTER (WHERE status = 'assigned')::integer,
      count(*) FILTER (WHERE status = 'dispatch_pending')::integer,
      count(*) FILTER (WHERE status = 'dispatched')::integer,
      count(*) FILTER (WHERE status = 'waiting_device')::integer,
      count(*) FILTER (WHERE status = 'running')::integer,
      count(*) FILTER (WHERE status = 'retryable')::integer,
      count(*) FILTER (WHERE status = 'needs_action')::integer,
      count(*) FILTER (WHERE status = 'completed')::integer,
      count(*) FILTER (WHERE status = 'completed_with_warnings')::integer,
      count(*) FILTER (WHERE status = 'failed')::integer,
      count(*) FILTER (WHERE status = 'skipped')::integer,
      count(*) FILTER (WHERE status = 'canceled')::integer,
      count(*) FILTER (WHERE status IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      ))::integer
    INTO total_count, pending_count, assigned_count,
      dispatch_pending_count, dispatched_count, waiting_device_count,
      running_count, retryable_count, needs_action_count,
      completed_count, warning_count, failed_count, skipped_count,
      canceled_count, settled_count
    FROM capture_task_items
    WHERE tenant_id = tenant_uuid AND task_id = parent_uuid;

    parent_terminal := total_count > 0 AND settled_count = total_count;
    parent_status := CASE
      WHEN parent_terminal AND failed_count > 0 THEN 'completed_with_failures'
      WHEN parent_terminal AND canceled_count > 0 THEN 'canceled'
      WHEN parent_terminal AND (warning_count > 0 OR skipped_count > 0)
        THEN 'completed_with_warnings'
      WHEN parent_terminal THEN 'completed'
      WHEN running_count > 0 THEN 'running'
      WHEN needs_action_count > 0 OR retryable_count > 0 THEN 'needs_action'
      WHEN assigned_count > 0 OR dispatch_pending_count > 0
        OR dispatched_count > 0 OR waiting_device_count > 0 THEN 'pending'
      ELSE 'pending'
    END;
    parent_message := CASE
      WHEN parent_status = 'running' THEN '多个执行节点正在处理关键词工作项'
      WHEN parent_status = 'needs_action' THEN '部分关键词工作项需要人工处理'
      WHEN parent_terminal THEN '多 Agent 关键词任务已结算'
      ELSE '关键词工作项已分配，等待执行节点处理'
    END;

    UPDATE capture_tasks
    SET status = parent_status,
      progress = jsonb_build_object(
        'current', settled_count,
        'total', total_count,
        'percent', CASE WHEN total_count = 0 THEN 0
          ELSE floor(settled_count * 100.0 / total_count)::integer END
      ),
      counts = jsonb_build_object(
        'total', total_count,
        'pending', pending_count,
        'assigned', assigned_count,
        'dispatchPending', dispatch_pending_count,
        'dispatched', dispatched_count,
        'waitingDevice', waiting_device_count,
        'running', running_count,
        'retryable', retryable_count,
        'needsAction', needs_action_count,
        'completed', completed_count,
        'completedWithWarnings', warning_count,
        'failed', failed_count,
        'skipped', skipped_count,
        'canceled', canceled_count,
        'settled', settled_count
      ),
      message = parent_message,
      finished_at = CASE WHEN parent_terminal THEN COALESCE(
        finished_at,
        (SELECT max(finished_at) FROM capture_task_items
          WHERE tenant_id = tenant_uuid AND task_id = parent_uuid),
        now()
      ) ELSE NULL END,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = parent_uuid AND tenant_id = tenant_uuid;

    INSERT INTO capture_task_events (
      tenant_id, task_id, event_type, actor_type, actor_id,
      actor_name, status, message, payload
    ) VALUES (
      tenant_uuid, parent_uuid,
      'orchestration_historical_recovery_reconciled_v0372',
      'system', '', '0.3.72 发布修复', parent_status,
      '上午设备端恢复分支已对账回原无人值守父任务',
      jsonb_build_object(
        'repair', '2026-08-01-v0.3.72',
        'terminal', parent_terminal,
        'settled', settled_count,
        'total', total_count
      )
    );
  END LOOP;

  UPDATE capture_orchestration_schedules schedule
  SET last_run_at = parent.finished_at,
    last_run_status = parent.status,
    last_error = jsonb_build_object(
      'code', 'scheduled_run_settled_with_failures',
      'message', parent.message
    ),
    updated_at = now()
  FROM capture_tasks parent
  WHERE schedule.tenant_id = tenant_uuid
    AND schedule.last_run_task_id = parent.id
    AND parent.id = '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505'
    AND parent.status = 'completed_with_failures'
  RETURNING schedule.template_task_id, schedule.status, schedule.next_run_at
  INTO schedule_template_id, schedule_status, schedule_next_run_at;

  IF schedule_template_id IS NULL THEN
    RAISE EXCEPTION 'xiaohongshu schedule settlement precondition changed';
  END IF;

  UPDATE capture_tasks
  SET metadata = metadata || jsonb_build_object(
      'scheduleStatus', schedule_status,
      'nextRunAt', COALESCE(schedule_next_run_at::text, ''),
      'lastRunStatus', 'completed_with_failures',
      'lastRunTaskId', '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505'
    ),
    message = '上一轮多 Agent 任务有失败项；可在云端重试失败关键词或立即再运行一轮',
    updated_at = now(),
    source_updated_at = now()
  WHERE id = schedule_template_id AND tenant_id = tenant_uuid;

  INSERT INTO capture_task_events (
    tenant_id, task_id, event_type, actor_type, actor_id,
    actor_name, status, message, payload
  ) VALUES (
    tenant_uuid, schedule_template_id,
    'orchestration_schedule_run_settled',
    'system', '', '0.3.72 发布修复', schedule_status,
    '无人值守计划的一轮多 Agent 任务已完成历史恢复对账',
    jsonb_build_object(
      'runTaskId', '8b9f2f29-71ba-46f9-903c-3ce5d4a2b505',
      'runStatus', 'completed_with_failures',
      'nextRunAt', schedule_next_run_at,
      'historicalRepair', true
    )
  );
END
$repair$;

COMMIT;
