-- Durable event-driven wakeups for the operations control plane.
--
-- PostgreSQL NOTIFY provides low-latency delivery while this table remains the
-- source of truth across worker restarts, listener reconnects and deployments.

CREATE TABLE IF NOT EXISTS ops_control_wakeups (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'system',
  source_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(reason) BETWEEN 1 AND 120),
  CHECK (char_length(source_type) BETWEEN 1 AND 80),
  CHECK (char_length(source_id) <= 240),
  CHECK (char_length(dedupe_key) BETWEEN 1 AND 320),
  CHECK (
    (claim_token IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ops_control_wakeups_unclaimed_dedupe
  ON ops_control_wakeups (tenant_id, dedupe_key)
  WHERE processed_at IS NULL AND claim_token IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_control_wakeups_due
  ON ops_control_wakeups (available_at, id)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_control_wakeups_cleanup
  ON ops_control_wakeups (processed_at, id)
  WHERE processed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION enqueue_ops_control_wakeup(
  p_tenant_id UUID,
  p_reason TEXT,
  p_source_type TEXT DEFAULT 'system',
  p_source_id TEXT DEFAULT '',
  p_dedupe_key TEXT DEFAULT '',
  p_available_at TIMESTAMPTZ DEFAULT now(),
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_replace_available BOOLEAN DEFAULT false
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  wakeup_id BIGINT;
  normalized_dedupe_key TEXT;
BEGIN
  normalized_dedupe_key := COALESCE(
    NULLIF(btrim(p_dedupe_key), ''),
    btrim(p_source_type) || ':' || btrim(p_source_id) || ':' || btrim(p_reason)
  );

  INSERT INTO ops_control_wakeups (
    tenant_id, reason, source_type, source_id, dedupe_key,
    payload, available_at, created_at, updated_at
  ) VALUES (
    p_tenant_id,
    left(btrim(p_reason), 120),
    left(COALESCE(NULLIF(btrim(p_source_type), ''), 'system'), 80),
    left(COALESCE(p_source_id, ''), 240),
    left(normalized_dedupe_key, 320),
    COALESCE(p_payload, '{}'::jsonb),
    COALESCE(p_available_at, now()),
    now(),
    now()
  )
  ON CONFLICT (tenant_id, dedupe_key)
    WHERE processed_at IS NULL AND claim_token IS NULL
  DO UPDATE SET
    reason = excluded.reason,
    source_type = excluded.source_type,
    source_id = excluded.source_id,
    payload = ops_control_wakeups.payload || excluded.payload,
    available_at = CASE
      WHEN p_replace_available THEN excluded.available_at
      ELSE LEAST(ops_control_wakeups.available_at, excluded.available_at)
    END,
    last_error = '',
    updated_at = now()
  RETURNING id INTO wakeup_id;

  -- Notifications are delivered only after the surrounding transaction
  -- commits. The queue row therefore always exists before a worker can wake.
  PERFORM pg_notify('ops_control_wakeup', p_tenant_id::text);
  RETURN wakeup_id;
END;
$$;

CREATE OR REPLACE FUNCTION notify_ops_control_capture_task()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_eligible BOOLEAN := false;
  new_eligible BOOLEAN := false;
  wake_reason TEXT := '';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_eligible := OLD.parent_task_id IS NULL
      AND OLD.task_type IN (
        'capture_orchestration',
        'unattended_keyword_capture',
        'negative_post_patrol',
        'watched_content_patrol',
        'official_account_comment_patrol',
        'followed_creator_post_patrol',
        'official_account_post_discovery'
      )
      AND COALESCE(OLD.metadata->>'draft', 'false') <> 'true'
      AND COALESCE(OLD.metadata->>'orchestrationTemplate', 'false') <> 'true';
  END IF;

  new_eligible := NEW.parent_task_id IS NULL
    AND NEW.task_type IN (
      'capture_orchestration',
      'unattended_keyword_capture',
      'negative_post_patrol',
      'watched_content_patrol',
      'official_account_comment_patrol',
      'followed_creator_post_patrol',
      'official_account_post_discovery'
    )
    AND COALESCE(NEW.metadata->>'draft', 'false') <> 'true'
    AND COALESCE(NEW.metadata->>'orchestrationTemplate', 'false') <> 'true';

  IF TG_OP = 'INSERT' AND new_eligible THEN
    wake_reason := 'task_created';
  ELSIF TG_OP = 'UPDATE' AND NOT old_eligible AND new_eligible THEN
    wake_reason := 'task_activated';
  ELSIF TG_OP = 'UPDATE' AND old_eligible
    AND OLD.status IS DISTINCT FROM NEW.status THEN
    wake_reason := 'task_state_changed';
  END IF;

  IF wake_reason <> '' THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      wake_reason,
      'capture_task',
      NEW.id::text,
      'task:' || NEW.id::text,
      now(),
      jsonb_build_object(
        'taskType', NEW.task_type,
        'featureKey', NEW.feature_key,
        'previousStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE '' END,
        'status', NEW.status
      ),
      false
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_task_wakeup ON capture_tasks;
CREATE TRIGGER trg_ops_control_capture_task_wakeup
AFTER INSERT OR UPDATE OF status, metadata, parent_task_id, task_type
ON capture_tasks
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_task();

CREATE OR REPLACE FUNCTION notify_ops_control_capture_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      CASE WHEN TG_OP = 'INSERT' THEN 'command_created' ELSE 'command_state_changed' END,
      'capture_command',
      NEW.id::text,
      'command:' || NEW.id::text,
      now(),
      jsonb_build_object(
        'taskId', NEW.task_id,
        'commandType', NEW.command_type,
        'previousStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE '' END,
        'status', NEW.status
      ),
      false
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_command_wakeup
  ON capture_agent_commands;
CREATE TRIGGER trg_ops_control_capture_command_wakeup
AFTER INSERT OR UPDATE OF status
ON capture_agent_commands
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_command();

CREATE OR REPLACE FUNCTION notify_ops_control_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_schedule_id UUID;
  target_tenant_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_schedule_id := OLD.id;
    target_tenant_id := OLD.tenant_id;
  ELSE
    target_schedule_id := NEW.id;
    target_tenant_id := NEW.tenant_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE ops_control_wakeups
    SET processed_at = now(),
      last_error = 'schedule_inactive',
      updated_at = now()
    WHERE ops_control_wakeups.tenant_id = target_tenant_id
      AND dedupe_key = 'schedule-due:' || target_schedule_id::text
      AND processed_at IS NULL
      AND claim_token IS NULL;
    RETURN OLD;
  ELSIF NEW.status <> 'active' OR NEW.next_run_at IS NULL THEN
    UPDATE ops_control_wakeups
    SET processed_at = now(),
      last_error = 'schedule_inactive',
      updated_at = now()
    WHERE ops_control_wakeups.tenant_id = target_tenant_id
      AND dedupe_key = 'schedule-due:' || target_schedule_id::text
      AND processed_at IS NULL
      AND claim_token IS NULL;
  ELSE
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'schedule_due',
      'capture_schedule',
      NEW.id::text,
      'schedule-due:' || NEW.id::text,
      NEW.next_run_at,
      jsonb_build_object(
        'nextRunAt', NEW.next_run_at,
        'revision', NEW.revision,
        'platform', NEW.platform
      ),
      true
    );
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.last_run_status IS DISTINCT FROM NEW.last_run_status
    AND COALESCE(NEW.last_run_status, '') <> '' THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'schedule_state_changed',
      'capture_schedule',
      NEW.id::text,
      'schedule-state:' || NEW.id::text,
      now(),
      jsonb_build_object(
        'lastRunStatus', NEW.last_run_status,
        'lastRunTaskId', NEW.last_run_task_id,
        'scheduleStatus', NEW.status,
        'lastError', NEW.last_error
      ),
      false
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_schedule_wakeup
  ON capture_orchestration_schedules;
CREATE TRIGGER trg_ops_control_schedule_wakeup
AFTER INSERT OR UPDATE OF status, next_run_at, last_run_status OR DELETE
ON capture_orchestration_schedules
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_schedule();

-- Existing future schedules need durable timers even though their INSERT
-- happened before this trigger existed.
INSERT INTO ops_control_wakeups (
  tenant_id, reason, source_type, source_id, dedupe_key,
  payload, available_at, created_at, updated_at
)
SELECT
  schedule.tenant_id,
  'schedule_due',
  'capture_schedule',
  schedule.id::text,
  'schedule-due:' || schedule.id::text,
  jsonb_build_object(
    'nextRunAt', schedule.next_run_at,
    'revision', schedule.revision,
    'platform', schedule.platform
  ),
  schedule.next_run_at,
  now(),
  now()
FROM capture_orchestration_schedules schedule
WHERE schedule.status = 'active' AND schedule.next_run_at IS NOT NULL
ON CONFLICT (tenant_id, dedupe_key)
  WHERE processed_at IS NULL AND claim_token IS NULL
DO UPDATE SET
  payload = excluded.payload,
  available_at = excluded.available_at,
  updated_at = now();

-- Recover work that was already active when the migration was installed.
INSERT INTO ops_control_wakeups (
  tenant_id, reason, source_type, source_id, dedupe_key,
  payload, available_at, created_at, updated_at
)
SELECT DISTINCT ON (task.tenant_id)
  task.tenant_id,
  'migration_reconcile',
  'capture_task',
  task.id::text,
  'migration-reconcile',
  jsonb_build_object('taskId', task.id, 'status', task.status),
  now(),
  now(),
  now()
FROM capture_tasks task
WHERE task.parent_task_id IS NULL
  AND task.status IN (
    'pending', 'waiting_device', 'claimed', 'running',
    'recovering', 'resume_requested', 'stop_requested'
  )
  AND task.task_type IN (
    'capture_orchestration',
    'unattended_keyword_capture',
    'negative_post_patrol',
    'watched_content_patrol',
    'official_account_comment_patrol',
    'followed_creator_post_patrol',
    'official_account_post_discovery'
  )
  AND COALESCE(task.metadata->>'draft', 'false') <> 'true'
  AND COALESCE(task.metadata->>'orchestrationTemplate', 'false') <> 'true'
ORDER BY task.tenant_id, task.updated_at DESC, task.id
ON CONFLICT (tenant_id, dedupe_key)
  WHERE processed_at IS NULL AND claim_token IS NULL
DO NOTHING;
