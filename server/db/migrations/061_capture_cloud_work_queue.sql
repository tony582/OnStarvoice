-- Elastic cloud work queue for keyword orchestration.
--
-- Existing schedules stay on fixed_batch. New elastic_pool schedules keep
-- work items cloud-owned until an eligible, idle Agent heartbeat claims one.
-- The create command is the short pre-start lease; execution_task_id and
-- assignment_revision fence late snapshots after a reassignment.

ALTER TABLE capture_orchestration_schedules
  ADD COLUMN IF NOT EXISTS distribution_mode TEXT NOT NULL DEFAULT 'fixed_batch';

ALTER TABLE capture_orchestration_schedules
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedules_distribution_mode_check;
ALTER TABLE capture_orchestration_schedules
  ADD CONSTRAINT capture_orchestration_schedules_distribution_mode_check
  CHECK (distribution_mode IN ('fixed_batch', 'elastic_pool'));

CREATE INDEX IF NOT EXISTS idx_capture_task_items_elastic_claim
  ON capture_task_items (tenant_id, task_id, ordinal, id)
  WHERE item_type = 'keyword'
    AND status IN ('pending', 'retryable')
    AND attempt_count < 3;

CREATE INDEX IF NOT EXISTS idx_capture_task_items_negative_claim
  ON capture_task_items (tenant_id, task_id, ordinal, id)
  WHERE item_type = 'negative_post'
    AND status IN ('pending', 'retryable')
    AND attempt_count < 3;

CREATE INDEX IF NOT EXISTS idx_capture_tasks_elastic_children_active
  ON capture_tasks (tenant_id, updated_at, id)
  WHERE parent_task_id IS NOT NULL
    AND status IN ('pending', 'claimed', 'running', 'recovering', 'waiting_device');
