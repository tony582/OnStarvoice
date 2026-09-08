-- Persist first delivery admission independently from command acknowledgement.
-- Expiry alone never releases capacity because an offline response can arrive
-- after the server-side lease elapsed.
ALTER TABLE capture_agent_commands
  ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admission_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_request_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_result_hash TEXT;

ALTER TABLE capture_agent_commands
  DROP CONSTRAINT IF EXISTS capture_agent_commands_completion_result_hash_check;
ALTER TABLE capture_agent_commands
  ADD CONSTRAINT capture_agent_commands_completion_result_hash_check
  CHECK (
    completion_result_hash IS NULL
    OR completion_result_hash ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX IF NOT EXISTS idx_capture_commands_open_admission
  ON capture_agent_commands (admitted_at DESC, tenant_id, task_id)
  WHERE admitted_at IS NOT NULL AND admission_released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_capture_commands_tenant_admission_rate
  ON capture_agent_commands (tenant_id, admitted_at DESC)
  WHERE command_type = 'create' AND admitted_at IS NOT NULL;

-- Existing targeted patrol commands with a non-terminal execution are
-- conservatively treated as admitted during a rolling upgrade. The admission
-- guard separately detects multi-target legacy payloads and blocks new work.
UPDATE capture_agent_commands command
SET admitted_at = COALESCE(command.admitted_at, command.created_at)
FROM capture_tasks task
WHERE task.id = command.task_id
  AND task.tenant_id = command.tenant_id
  AND command.command_type = 'create'
  AND command.payload->>'workflow' = 'negative_post_patrol'
  AND command.admitted_at IS NULL
  AND task.status NOT IN (
    'completed', 'completed_with_warnings', 'completed_with_failures',
    'failed', 'canceled', 'skipped', 'superseded', 'needs_action'
  );

-- Keep every future negative-patrol delivery inside the per-post admission
-- protocol even if an older retry or orchestration caller is accidentally
-- reintroduced. Existing legacy packs are not rewritten by this trigger; the
-- heartbeat reconciliation below can still revoke or migrate them safely.
CREATE OR REPLACE FUNCTION enforce_negative_patrol_command_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_task_type TEXT := '';
  effective_workflow TEXT := '';
  target_count INTEGER := 0;
BEGIN
  IF NEW.command_type <> 'create' THEN RETURN NEW; END IF;

  SELECT task.task_type INTO linked_task_type
  FROM capture_tasks task
  WHERE task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id;
  effective_workflow := COALESCE(
    NULLIF(NEW.payload->>'workflow', ''),
    NULLIF(NEW.payload->>'taskKind', ''),
    linked_task_type,
    ''
  );
  IF effective_workflow <> 'negative_post_patrol' THEN RETURN NEW; END IF;

  target_count := GREATEST(
    CASE WHEN jsonb_typeof(NEW.payload->'targets') = 'array'
      THEN jsonb_array_length(NEW.payload->'targets') ELSE 0 END,
    CASE WHEN jsonb_typeof(NEW.payload->'items') = 'array'
      THEN jsonb_array_length(NEW.payload->'items') ELSE 0 END
  );
  IF NEW.admitted_at IS NULL OR target_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'capture_agent_commands_negative_patrol_admission_check',
      MESSAGE = 'negative patrol create commands require one target and admission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_negative_patrol_command_admission
  ON capture_agent_commands;
CREATE TRIGGER trg_enforce_negative_patrol_command_admission
BEFORE INSERT OR UPDATE OF command_type, payload, admitted_at, task_id
ON capture_agent_commands
FOR EACH ROW
EXECUTE FUNCTION enforce_negative_patrol_command_admission();


CREATE OR REPLACE FUNCTION release_capture_command_admission_on_task_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN (
    'completed', 'completed_with_warnings', 'completed_with_failures',
    'failed', 'canceled', 'skipped', 'superseded', 'needs_action'
  ) AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE capture_agent_commands
    SET admission_released_at = COALESCE(admission_released_at, now()),
      updated_at = now()
    WHERE tenant_id = NEW.tenant_id
      AND task_id = NEW.id
      AND admitted_at IS NOT NULL
      AND admission_released_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_capture_command_admission
  ON capture_tasks;

CREATE TRIGGER trg_release_capture_command_admission
AFTER UPDATE OF status ON capture_tasks
FOR EACH ROW
EXECUTE FUNCTION release_capture_command_admission_on_task_terminal();
