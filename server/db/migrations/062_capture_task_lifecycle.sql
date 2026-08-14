-- Plan lifecycle and bounded technical-history retention.
--
-- Archiving a schedule is intentionally reversible and never deletes its
-- template, generated runs, task events, work items, or captured records.

ALTER TABLE capture_orchestration_schedules
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_by_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS archived_previous_status TEXT;

ALTER TABLE capture_orchestration_schedules
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedules_archived_previous_status_check;
ALTER TABLE capture_orchestration_schedules
  ADD CONSTRAINT capture_orchestration_schedules_archived_previous_status_check
  CHECK (
    archived_previous_status IS NULL
    OR archived_previous_status IN ('active', 'paused', 'completed', 'canceled')
  );

CREATE INDEX IF NOT EXISTS idx_capture_orchestration_schedules_archive
  ON capture_orchestration_schedules (tenant_id, archived_at DESC, updated_at DESC);

ALTER TABLE capture_tasks
  ADD COLUMN IF NOT EXISTS technical_compacted_at TIMESTAMPTZ;

-- Agent records can be soft-revoked or tenant-migrated, but their display
-- identity must remain readable in historical keyword-attempt reports even if
-- a later lifecycle migration nulls agent_id.
ALTER TABLE capture_task_item_attempts
  ADD COLUMN IF NOT EXISTS agent_display_name TEXT NOT NULL DEFAULT '';

UPDATE capture_task_item_attempts attempt
SET agent_display_name = agent.display_name
FROM capture_agents agent
WHERE attempt.agent_display_name = ''
  AND attempt.agent_id = agent.id
  AND attempt.tenant_id = agent.tenant_id;

CREATE OR REPLACE FUNCTION preserve_capture_task_item_attempt_agent_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.agent_display_name = '' AND NEW.agent_id IS NOT NULL THEN
    SELECT agent.display_name
    INTO NEW.agent_display_name
    FROM capture_agents agent
    WHERE agent.id = NEW.agent_id
      AND agent.tenant_id = NEW.tenant_id;
    NEW.agent_display_name := COALESCE(NEW.agent_display_name, '');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capture_task_item_attempt_agent_name
  ON capture_task_item_attempts;
CREATE TRIGGER trg_capture_task_item_attempt_agent_name
BEFORE INSERT OR UPDATE OF agent_id, agent_display_name
ON capture_task_item_attempts
FOR EACH ROW
EXECUTE FUNCTION preserve_capture_task_item_attempt_agent_name();

CREATE INDEX IF NOT EXISTS idx_capture_tasks_technical_compaction
  ON capture_tasks (finished_at, id)
  WHERE technical_compacted_at IS NULL
    AND parent_task_id IS NULL
    AND status IN (
      'completed', 'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'skipped', 'superseded'
    );
