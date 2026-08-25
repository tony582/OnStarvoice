-- Item-scoped durable recovery ledger for the unattended control plane.
-- All tenant and process-wide action gates are installed disabled. Guarded
-- recovery can only act after both gates are explicitly enabled.

-- Repeat the task identity contract here because the recovery ledger owns a
-- tenant-scoped composite foreign key. Migration 043 normally creates this
-- index first; IF NOT EXISTS keeps 074 independently self-describing and safe.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_tasks_id_tenant
  ON capture_tasks (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_agents_id_tenant
  ON capture_agents (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_task_items_id_tenant
  ON capture_task_items (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_task_item_attempts_id_tenant
  ON capture_task_item_attempts (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_task_attempts_id_tenant
  ON capture_task_attempts (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_agent_commands_id_tenant
  ON capture_agent_commands (id, tenant_id);

-- The task row is a replaceable current-state projection. Preserve the
-- normalized browser health on each task attempt so later recovery decisions
-- can use the evidence that belonged to that exact attempt.
ALTER TABLE capture_task_attempts
  ADD COLUMN IF NOT EXISTS app_version TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS health_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE capture_task_attempts
  DROP CONSTRAINT IF EXISTS capture_task_attempts_app_version_bounded_check;
ALTER TABLE capture_task_attempts
  ADD CONSTRAINT capture_task_attempts_app_version_bounded_check
  CHECK (char_length(app_version) <= 80);

ALTER TABLE capture_task_attempts
  DROP CONSTRAINT IF EXISTS capture_task_attempts_health_evidence_bounded_check;
ALTER TABLE capture_task_attempts
  ADD CONSTRAINT capture_task_attempts_health_evidence_bounded_check
  CHECK (
    jsonb_typeof(health_evidence) = 'object'
    AND pg_column_size(health_evidence) <= 4096
  );

-- Bind every sync observation produced inside a cloud capture to the exact
-- execution/item attempt. This is the durable business-result proof used by
-- the recovery verifier; client-provided ids are tenant-validated server-side.
ALTER TABLE record_observations
  ADD COLUMN IF NOT EXISTS capture_task_id UUID,
  ADD COLUMN IF NOT EXISTS capture_task_item_id UUID,
  ADD COLUMN IF NOT EXISTS capture_task_item_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS comment_workflow_status TEXT NOT NULL
    DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS comment_workflow_expected_count INTEGER NOT NULL
    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_workflow_processed_count INTEGER NOT NULL
    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_workflow_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS comment_workflow_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comment_workflow_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comment_workflow_updated_at TIMESTAMPTZ NOT NULL
    DEFAULT now();

-- PostgreSQL 14 cannot name target columns for SET NULL. The single-column
-- foreign keys clear only the optional lineage id; the composite constraints
-- remain tenant guards and deliberately perform no delete action.
ALTER TABLE record_observations
  DROP CONSTRAINT IF EXISTS record_observations_capture_task_id_fkey,
  DROP CONSTRAINT IF EXISTS record_observations_capture_task_item_id_fkey,
  DROP CONSTRAINT IF EXISTS record_observations_capture_task_item_attempt_id_fkey,
  DROP CONSTRAINT IF EXISTS record_observations_capture_task_tenant_fkey,
  DROP CONSTRAINT IF EXISTS record_observations_capture_item_tenant_fkey,
  DROP CONSTRAINT IF EXISTS record_observations_capture_attempt_tenant_fkey;

ALTER TABLE record_observations
  ADD CONSTRAINT record_observations_capture_task_id_fkey
    FOREIGN KEY (capture_task_id)
    REFERENCES capture_tasks (id)
    ON DELETE SET NULL,
  ADD CONSTRAINT record_observations_capture_task_item_id_fkey
    FOREIGN KEY (capture_task_item_id)
    REFERENCES capture_task_items (id)
    ON DELETE SET NULL,
  ADD CONSTRAINT record_observations_capture_task_item_attempt_id_fkey
    FOREIGN KEY (capture_task_item_attempt_id)
    REFERENCES capture_task_item_attempts (id)
    ON DELETE SET NULL,
  ADD CONSTRAINT record_observations_capture_task_tenant_fkey
    FOREIGN KEY (capture_task_id, tenant_id)
    REFERENCES capture_tasks (id, tenant_id)
    ON DELETE NO ACTION,
  ADD CONSTRAINT record_observations_capture_item_tenant_fkey
    FOREIGN KEY (capture_task_item_id, tenant_id)
    REFERENCES capture_task_items (id, tenant_id)
    ON DELETE NO ACTION,
  ADD CONSTRAINT record_observations_capture_attempt_tenant_fkey
    FOREIGN KEY (capture_task_item_attempt_id, tenant_id)
    REFERENCES capture_task_item_attempts (id, tenant_id)
    ON DELETE NO ACTION;

ALTER TABLE record_observations
  DROP CONSTRAINT IF EXISTS record_observations_comment_workflow_status_check;
ALTER TABLE record_observations
  ADD CONSTRAINT record_observations_comment_workflow_status_check
  CHECK (comment_workflow_status IN (
    'not_required', 'queued', 'running', 'persisted', 'failed'
  ));

ALTER TABLE record_observations
  DROP CONSTRAINT IF EXISTS record_observations_comment_workflow_counts_check;
ALTER TABLE record_observations
  ADD CONSTRAINT record_observations_comment_workflow_counts_check
  CHECK (
    comment_workflow_expected_count >= 0
    AND comment_workflow_processed_count >= 0
  );

CREATE INDEX IF NOT EXISTS idx_record_observations_capture_attempt
  ON record_observations (
    tenant_id, capture_task_item_attempt_id, captured_at DESC
  )
  WHERE capture_task_item_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_record_observations_capture_item
  ON record_observations (tenant_id, capture_task_item_id, captured_at DESC)
  WHERE capture_task_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_record_observations_comment_workflow_pending
  ON record_observations (
    comment_workflow_status, comment_workflow_updated_at, id
  )
  WHERE comment_workflow_status IN ('queued', 'running', 'failed');

CREATE TABLE IF NOT EXISTS capture_recovery_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_task_id UUID NOT NULL,
  item_id UUID NOT NULL,
  source_attempt_id UUID,
  source_execution_attempt_id UUID,
  stage TEXT NOT NULL DEFAULT 'unknown'
    CHECK (stage IN (
      'unknown', 'preflight', 'search_nav', 'search_ready', 'list_capture',
      'detail_queue', 'detail_capture', 'comments', 'local_durable_sync',
      'server_persisted', 'ai_settled'
    )),
  fault_class TEXT NOT NULL DEFAULT 'unknown'
    CHECK (fault_class IN (
      'unknown', 'extension_dom_contract', 'extension_runtime',
      'host_browser_pressure', 'network_local', 'platform_service',
      'server_sync_ai', 'platform_safety', 'agent_control_plane',
      'user_stop'
    )),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN (
      'ready', 'waiting_due', 'waiting_agent', 'verifying_collection',
      'verifying_postprocessing', 'resolved', 'waiting_human',
      'exhausted_window', 'stopped_by_user', 'failed'
    )),
  decision TEXT NOT NULL DEFAULT 'none'
    CHECK (decision IN (
      'none', 'observe', 'local_recovery', 'cross_agent_recovery',
      'platform_backoff', 'server_recovery', 'human_required',
      'stop'
    )),
  recovery_key TEXT NOT NULL CHECK (recovery_key ~ '^[0-9a-f]{64}$'),
  source_fingerprint TEXT NOT NULL
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_assignment_revision INTEGER NOT NULL DEFAULT 0
    CHECK (expected_assignment_revision >= 0),
  expected_attempt_number INTEGER NOT NULL DEFAULT 0
    CHECK (expected_attempt_number >= 0),
  recovery_task_id UUID,
  recovery_command_id UUID,
  recovery_agent_id UUID,
  dispatched_attempt_id UUID,
  dispatched_at TIMESTAMPTZ,
  window_ends_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_owner TEXT NOT NULL DEFAULT '',
  leased_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT NOT NULL DEFAULT '',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recovery_key),
  UNIQUE (tenant_id, source_fingerprint),
  UNIQUE (tenant_id, item_id, generation),
  CHECK (
    (lease_token IS NULL AND lease_owner = ''
      AND leased_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_owner <> ''
      AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT capture_recovery_intents_parent_tenant_fkey
    FOREIGN KEY (parent_task_id, tenant_id)
    REFERENCES capture_tasks (id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT capture_recovery_intents_item_tenant_fkey
    FOREIGN KEY (item_id, tenant_id)
    REFERENCES capture_task_items (id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT capture_recovery_intents_attempt_tenant_fkey
    FOREIGN KEY (source_attempt_id, tenant_id)
    REFERENCES capture_task_item_attempts (id, tenant_id)
    ON DELETE NO ACTION,
  CONSTRAINT capture_recovery_intents_execution_attempt_tenant_fkey
    FOREIGN KEY (source_execution_attempt_id, tenant_id)
    REFERENCES capture_task_attempts (id, tenant_id)
    ON DELETE NO ACTION,
  CONSTRAINT capture_recovery_intents_recovery_task_tenant_fkey
    FOREIGN KEY (recovery_task_id, tenant_id)
    REFERENCES capture_tasks (id, tenant_id)
    ON DELETE NO ACTION,
  CONSTRAINT capture_recovery_intents_recovery_agent_tenant_fkey
    FOREIGN KEY (recovery_agent_id, tenant_id)
    REFERENCES capture_agents (id, tenant_id)
    ON DELETE NO ACTION,
  CONSTRAINT capture_recovery_intents_recovery_command_tenant_fkey
    FOREIGN KEY (recovery_command_id, tenant_id)
    REFERENCES capture_agent_commands (id, tenant_id)
    ON DELETE NO ACTION,
  CONSTRAINT capture_recovery_intents_dispatched_attempt_tenant_fkey
    FOREIGN KEY (dispatched_attempt_id, tenant_id)
    REFERENCES capture_task_item_attempts (id, tenant_id)
    ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_capture_recovery_intents_due
  ON capture_recovery_intents (available_at, id)
  WHERE status IN (
    'ready', 'waiting_due', 'waiting_agent', 'verifying_collection',
    'verifying_postprocessing'
  );

CREATE INDEX IF NOT EXISTS idx_capture_recovery_intents_lease
  ON capture_recovery_intents (lease_expires_at, id)
  WHERE lease_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capture_recovery_intents_item_history
  ON capture_recovery_intents (tenant_id, item_id, generation DESC);

CREATE INDEX IF NOT EXISTS idx_capture_recovery_intents_tenant_status
  ON capture_recovery_intents (tenant_id, status, updated_at DESC);

-- Tenant enablement backfills only unresolved item states and advances with a
-- stable (created_at, id) cursor. Keep that scan index-scoped per tenant.
CREATE INDEX IF NOT EXISTS idx_capture_task_items_recovery_backfill
  ON capture_task_items (tenant_id, created_at, id)
  WHERE status IN ('retryable', 'needs_action', 'failed');

-- Keep recovery wakeups inert until the tenant explicitly joins the recovery
-- control plane. The process-wide gates are application state and cannot be
-- read safely from a database trigger; this tenant gate is the durable switch
-- that also makes an app-only rollback safe after it is turned off. Without
-- this wrapper, the pre-074 worker would consume recovery-specific wakeups as
-- ordinary OpsControl events and could enter its broader guarded allowlist.
CREATE OR REPLACE FUNCTION enqueue_capture_recovery_wakeup(
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
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenant_settings setting
    WHERE setting.tenant_id = p_tenant_id
      AND setting.key = 'ops_control_recovery_enabled'
      AND lower(btrim(setting.value)) IN ('1', 'true', 'on', 'yes')
  ) THEN
    RETURN NULL;
  END IF;

  RETURN enqueue_ops_control_wakeup(
    p_tenant_id,
    p_reason,
    p_source_type,
    p_source_id,
    p_dedupe_key,
    p_available_at,
    p_payload,
    p_replace_available
  );
END;
$$;

-- The browser heartbeat mirrors an item before this trigger runs. The trigger
-- only emits a durable, tenant-scoped hint; classification and idempotency stay
-- in the service layer. No record content or URL is copied into the wakeup.
CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN (
      'retryable', 'needs_action', 'failed', 'completed',
      'completed_with_warnings', 'canceled', 'skipped'
    ) THEN
      PERFORM enqueue_capture_recovery_wakeup(
        NEW.tenant_id,
        'capture_item_state_changed',
        'capture_task_item',
        NEW.id::text,
        'capture-recovery-item:' || NEW.id::text || ':'
          || NEW.assignment_revision::text || ':' || NEW.status,
        now(),
        jsonb_build_object(
          'taskId', NEW.task_id,
          'executionTaskId', NEW.execution_task_id,
          'status', NEW.status,
          'assignmentRevision', NEW.assignment_revision,
          'attemptCount', NEW.attempt_count
        ),
        false
      );
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status
    OR OLD.assignment_revision IS DISTINCT FROM NEW.assignment_revision
    OR OLD.error IS DISTINCT FROM NEW.error
  THEN
    IF NEW.status IN (
      'retryable', 'needs_action', 'failed', 'completed',
      'completed_with_warnings', 'canceled', 'skipped'
    ) THEN
      PERFORM enqueue_capture_recovery_wakeup(
        NEW.tenant_id,
        'capture_item_state_changed',
        'capture_task_item',
        NEW.id::text,
        'capture-recovery-item:' || NEW.id::text || ':'
          || NEW.assignment_revision::text || ':' || NEW.status,
        now(),
        jsonb_build_object(
          'taskId', NEW.task_id,
          'executionTaskId', NEW.execution_task_id,
          'status', NEW.status,
          'assignmentRevision', NEW.assignment_revision,
          'attemptCount', NEW.attempt_count
        ),
        false
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_item
  ON capture_task_items;
CREATE TRIGGER trg_ops_control_capture_recovery_item
AFTER INSERT OR UPDATE OF status, assignment_revision, error
ON capture_task_items
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_item();

-- Emit a slot hint only when the Agent actually crosses from stale/offline to
-- usable, changes capability/status, or a task/command releases its slot.
-- Routine heartbeats must not collapse an intent's deliberate backoff.
CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_agent_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_became_usable BOOLEAN := false;
  new_broadly_usable BOOLEAN := false;
  old_broadly_usable BOOLEAN := false;
BEGIN
  new_broadly_usable := NEW.status = 'active'
    AND NEW.last_heartbeat_at >= now() - interval '2 minutes'
    AND NEW.auth_code_id IS NOT NULL
    AND NEW.auth_binding_id IS NOT NULL
    AND NEW.capabilities @> '{
      "remoteTaskCreate": true,
      "remoteStop": true
    }'::jsonb;
  IF TG_OP = 'INSERT' THEN
    slot_became_usable := new_broadly_usable;
  ELSE
    old_broadly_usable := OLD.status = 'active'
      AND OLD.last_heartbeat_at >= now() - interval '2 minutes'
      AND OLD.auth_code_id IS NOT NULL
      AND OLD.auth_binding_id IS NOT NULL
      AND OLD.capabilities @> '{
        "remoteTaskCreate": true,
        "remoteStop": true
      }'::jsonb;
    slot_became_usable := new_broadly_usable AND (
      NOT old_broadly_usable
      OR OLD.auth_code_id IS DISTINCT FROM NEW.auth_code_id
      OR OLD.auth_binding_id IS DISTINCT FROM NEW.auth_binding_id
      OR (
        cardinality(OLD.allowed_platforms) > 0
        AND (
          cardinality(NEW.allowed_platforms) = 0
          OR EXISTS (
            SELECT 1
            FROM unnest(NEW.allowed_platforms) platform
            WHERE NOT (platform = ANY(OLD.allowed_platforms))
          )
        )
      )
      OR (
        lower(COALESCE(OLD.capabilities->>'negativePostPatrol', 'false'))
          <> 'true'
        AND lower(COALESCE(NEW.capabilities->>'negativePostPatrol', 'false'))
          = 'true'
      )
      OR (
        lower(COALESCE(OLD.capabilities->>'watchedContentPatrol', 'false'))
          <> 'true'
        AND lower(COALESCE(NEW.capabilities->>'watchedContentPatrol', 'false'))
          = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'followedCreatorPostPatrol',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'followedCreatorPostPatrol',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'officialAccountPostDiscovery',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'officialAccountPostDiscovery',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'officialAccountCommentPatrol',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'officialAccountCommentPatrol',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'officialAccountCommentPatrolProfileV1',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'officialAccountCommentPatrolProfileV1',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'officialAccountLatestPostsByCountV1',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'officialAccountLatestPostsByCountV1',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'remoteTargetedPostCaptureV1',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'remoteTargetedPostCaptureV1',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'remoteTaskEnhancementOptions',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'remoteTaskEnhancementOptions',
          'false'
        )) = 'true'
      )
      OR (
        lower(COALESCE(
          OLD.capabilities->>'remoteTaskKeywordPostLimit',
          'false'
        )) <> 'true'
        AND lower(COALESCE(
          NEW.capabilities->>'remoteTaskKeywordPostLimit',
          'false'
        )) = 'true'
      )
      OR CASE
        WHEN COALESCE(
          jsonb_typeof(OLD.capabilities->'supportedPlatforms'),
          'missing'
        ) <> 'array' THEN false
        WHEN jsonb_array_length(
          OLD.capabilities->'supportedPlatforms'
        ) = 0 THEN false
        WHEN COALESCE(
          jsonb_typeof(NEW.capabilities->'supportedPlatforms'),
          'missing'
        ) <> 'array' THEN true
        WHEN jsonb_array_length(
          NEW.capabilities->'supportedPlatforms'
        ) = 0 THEN true
        ELSE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            NEW.capabilities->'supportedPlatforms'
          ) platform
          WHERE NOT (
            OLD.capabilities->'supportedPlatforms' ? platform
          )
        )
      END
    );
  END IF;

  IF slot_became_usable
    AND EXISTS (
    SELECT 1
    FROM capture_recovery_intents intent
    WHERE intent.tenant_id = NEW.tenant_id
      AND intent.status = 'waiting_agent'
      AND intent.window_ends_at > now()
  ) THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_agent_slot_changed',
      'capture_recovery_agent_slot',
      NEW.id::text,
      'capture-recovery-agent-slot:' || NEW.tenant_id::text || ':'
        || NEW.id::text,
      now(),
      jsonb_build_object(
        'agentId', NEW.id,
        'status', NEW.status,
        'heartbeatAt', NEW.last_heartbeat_at
      ),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_agent_slot
  ON capture_agents;
CREATE TRIGGER trg_ops_control_capture_recovery_agent_slot
AFTER INSERT OR UPDATE OF status, last_heartbeat_at, capabilities,
  allowed_platforms, auth_code_id, auth_binding_id
ON capture_agents
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_agent_slot();

-- Tenant/auth recovery is also a slot-availability transition. These rows can
-- become usable without touching capture_agents, so emit the same per-Agent
-- hint only on a negative-to-positive entitlement transition.
CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_entitlement_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant_id UUID;
  target_auth_code_id UUID;
  transition_positive BOOLEAN := false;
  candidate_agent RECORD;
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    transition_positive := OLD.status IS DISTINCT FROM NEW.status
      AND OLD.status <> 'active'
      AND NEW.status = 'active';
    target_tenant_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'auth_codes' THEN
    transition_positive := NEW.status = 'active' AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR (
        OLD.expires_at IS NOT NULL
        AND OLD.expires_at <= now()
        AND (NEW.expires_at IS NULL OR NEW.expires_at > now())
      )
    );
    target_tenant_id := NEW.tenant_id;
    target_auth_code_id := NEW.id;
  END IF;

  IF NOT transition_positive OR NOT EXISTS (
    SELECT 1
    FROM capture_recovery_intents intent
    WHERE intent.tenant_id = target_tenant_id
      AND intent.status = 'waiting_agent'
      AND intent.window_ends_at > now()
  ) THEN
    RETURN NEW;
  END IF;

  FOR candidate_agent IN
    SELECT agent.id
    FROM capture_agents agent
    WHERE agent.tenant_id = target_tenant_id
      AND agent.status = 'active'
      AND (
        target_auth_code_id IS NULL
        OR agent.auth_code_id = target_auth_code_id
      )
    ORDER BY agent.id
  LOOP
    PERFORM enqueue_ops_control_wakeup(
      target_tenant_id,
      'capture_recovery_entitlement_restored',
      'capture_recovery_agent_slot',
      candidate_agent.id::text,
      'capture-recovery-agent-slot:' || target_tenant_id::text || ':'
        || candidate_agent.id::text,
      now(),
      jsonb_build_object(
        'agentId', candidate_agent.id,
        'trigger', CASE
          WHEN TG_TABLE_NAME = 'tenants' THEN 'tenant_reactivated'
          ELSE 'auth_code_reactivated'
        END
      ),
      true
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_tenant_slot
  ON tenants;
CREATE TRIGGER trg_ops_control_capture_recovery_tenant_slot
AFTER UPDATE OF status
ON tenants
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_entitlement_slot();

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_auth_slot
  ON auth_codes;
CREATE TRIGGER trg_ops_control_capture_recovery_auth_slot
AFTER UPDATE OF status, expires_at
ON auth_codes
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_entitlement_slot();

CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_released_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  released_agent_id UUID;
  released_reason TEXT := '';
  old_agent_id UUID;
  new_agent_id UUID;
  old_blocks BOOLEAN := false;
  new_blocks BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME = 'capture_tasks' THEN
    old_agent_id := COALESCE(OLD.assigned_agent_id, OLD.origin_agent_id);
    new_agent_id := COALESCE(NEW.assigned_agent_id, NEW.origin_agent_id);
    old_blocks := OLD.status IN (
      'pending', 'waiting_device', 'claimed', 'running', 'recovering',
      'resume_requested'
    ) AND old_agent_id IS NOT NULL;
    new_blocks := NEW.status IN (
      'pending', 'waiting_device', 'claimed', 'running', 'recovering',
      'resume_requested'
    ) AND new_agent_id IS NOT NULL;
    IF NOT old_blocks OR (new_blocks AND old_agent_id = new_agent_id) THEN
      RETURN NEW;
    END IF;
    released_agent_id := old_agent_id;
    released_reason := CASE
      WHEN new_blocks THEN 'task_reassigned'
      ELSE 'task_slot_released'
    END;
  ELSIF TG_TABLE_NAME = 'capture_agent_commands' THEN
    old_blocks := OLD.status IN ('pending', 'acknowledged');
    new_blocks := NEW.status IN ('pending', 'acknowledged');
    IF NOT old_blocks OR (new_blocks AND OLD.agent_id = NEW.agent_id) THEN
      RETURN NEW;
    END IF;
    released_agent_id := OLD.agent_id;
    released_reason := CASE
      WHEN new_blocks THEN 'command_reassigned'
      ELSE 'command_slot_released'
    END;
  END IF;

  IF released_agent_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM capture_recovery_intents intent
    WHERE intent.tenant_id = NEW.tenant_id
      AND intent.status = 'waiting_agent'
      AND intent.window_ends_at > now()
  ) THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_agent_slot_released',
      'capture_recovery_agent_slot',
      released_agent_id::text,
      'capture-recovery-agent-slot:' || NEW.tenant_id::text || ':'
        || released_agent_id::text,
      now(),
      jsonb_build_object(
        'agentId', released_agent_id,
        'trigger', released_reason
      ),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_task_slot
  ON capture_tasks;
CREATE TRIGGER trg_ops_control_capture_recovery_task_slot
AFTER UPDATE OF status, assigned_agent_id, origin_agent_id
ON capture_tasks
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_released_slot();

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_command_slot
  ON capture_agent_commands;
CREATE TRIGGER trg_ops_control_capture_recovery_command_slot
AFTER UPDATE OF status, agent_id
ON capture_agent_commands
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_released_slot();

-- A source-task stop must also stop the exact duty-recovery child, including
-- the small crash window before the service worker has projected its lineage.
-- Pending creates are canceled immediately; acknowledged/running work gets a
-- durable stop command that the Extension already knows how to execute.
CREATE OR REPLACE FUNCTION propagate_capture_recovery_user_stop(
  target_tenant_id UUID,
  target_intent_id UUID,
  source_stop_task_id UUID,
  source_stop_command_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  recovery_child RECORD;
  create_command RECORD;
  recovery_stop_command_id UUID;
  recovery_agent_id UUID;
  recovery_agent_status TEXT := '';
  recovery_agent_auth_code_id UUID;
  recovery_agent_auth_binding_id UUID;
  recovery_agent_tenant_status TEXT := '';
  recovery_agent_auth_code_status TEXT := '';
  recovery_agent_auth_code_expires_at TIMESTAMPTZ;
  recovery_agent_active_auth_binding_id UUID;
  targeted_attempt_id TEXT := '';
  targeted_stop BOOLEAN := false;
  cascade_stop_attempt_count INTEGER := 0;
  cascade_stop_check_count INTEGER := 0;
  cascade_stop_started_at TIMESTAMPTZ;
  cascade_stop_deadline_at TIMESTAMPTZ;
  cascade_stop_followup_at TIMESTAMPTZ;
  cascade_stop_backoff_seconds INTEGER := 60;
  previous_cascade_stop_state TEXT := '';
  next_cascade_stop_state TEXT := '';
  inserted_stop_command BOOLEAN := false;
  recovery_agent_lock_acquired BOOLEAN := false;
BEGIN
  SELECT child.id, child.assigned_agent_id, child.origin_agent_id,
    child.client_task_id, child.control_task_id, child.status,
    child.platform, child.metadata, child.task_type, child.attempt_number,
    intent.verification AS intent_verification
  INTO recovery_child
  FROM capture_tasks child
  JOIN capture_recovery_intents intent
    ON intent.id = target_intent_id
    AND intent.tenant_id = target_tenant_id
  WHERE child.tenant_id = target_tenant_id
    AND (
      child.id = intent.recovery_task_id
      OR (
        intent.recovery_task_id IS NULL
        AND child.id = intent.id
        AND child.parent_task_id = intent.parent_task_id
        AND child.metadata->>'dutyRecovery' = 'true'
        AND child.metadata->>'dutyRecoveryIntentId' = target_intent_id::text
        AND child.metadata->>'dutyRecoveryGeneration' =
          intent.generation::text
      )
    )
  ORDER BY
    CASE WHEN child.id = intent.recovery_task_id THEN 0 ELSE 1 END,
    child.created_at DESC,
    child.id DESC
  LIMIT 1
  FOR UPDATE;

  IF recovery_child.id IS NULL OR recovery_child.id = source_stop_task_id THEN
    RETURN;
  END IF;

  IF recovery_child.status IN (
      'completed', 'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'skipped', 'superseded'
    ) THEN
    UPDATE capture_recovery_intents intent
    SET verification = intent.verification || jsonb_build_object(
        'cascadeStopState', 'verified',
        'cascadeStopVerifiedAt', now()::text,
        'cascadeStopChildStatus', recovery_child.status,
        'cascadeStopChildTaskId', recovery_child.id
      ),
      updated_at = now()
    WHERE intent.id = target_intent_id
      AND intent.tenant_id = target_tenant_id;
    RETURN;
  END IF;

  targeted_stop := recovery_child.task_type IN (
    'negative_post_patrol',
    'watched_content_patrol',
    'official_account_comment_patrol',
    'followed_creator_post_patrol',
    'official_account_post_discovery'
  );
  IF COALESCE(
    recovery_child.intent_verification->>'cascadeStopAttemptCount',
    ''
  ) ~ '^[0-9]+$' THEN
    cascade_stop_attempt_count := (
      recovery_child.intent_verification->>'cascadeStopAttemptCount'
    )::integer;
  END IF;

  SELECT command.id, command.status, command.payload, command.result
  INTO create_command
  FROM capture_agent_commands command
  WHERE command.tenant_id = target_tenant_id
    AND command.task_id = recovery_child.id
    AND command.command_type = 'create'
  ORDER BY command.created_at DESC, command.id DESC
  LIMIT 1
  FOR UPDATE;

  IF (
    create_command.id IS NULL
    OR create_command.status IN ('pending', 'failed', 'expired')
  ) AND recovery_child.status IN ('pending', 'waiting_device')
  THEN
    UPDATE capture_agent_commands command
    SET status = 'expired',
      result = command.result || jsonb_build_object(
        'reason', 'source_stopped_before_recovery_dispatch',
        'sourceTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      ),
      finished_at = COALESCE(command.finished_at, now()),
      updated_at = now()
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND command.command_type IN ('create', 'resume')
      AND command.status IN ('pending', 'acknowledged');

    UPDATE capture_task_item_attempts attempt
    SET status = 'canceled',
      error = attempt.error || jsonb_build_object(
        'code', 'SOURCE_STOPPED_BY_USER',
        'sourceTaskId', source_stop_task_id
      ),
      finished_at = COALESCE(attempt.finished_at, now()),
      updated_at = now()
    WHERE attempt.tenant_id = target_tenant_id
      AND attempt.execution_task_id = recovery_child.id
      AND attempt.status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      );

    UPDATE capture_task_items item
    SET status = 'canceled',
      error = item.error || jsonb_build_object(
        'code', 'SOURCE_STOPPED_BY_USER',
        'sourceTaskId', source_stop_task_id
      ),
      metadata = item.metadata || jsonb_build_object(
        'operatorStopped', true,
        'dutyRecoveryCascadeStop', true
      ),
      finished_at = COALESCE(item.finished_at, now()),
      updated_at = now()
    WHERE item.tenant_id = target_tenant_id
      AND item.execution_task_id = recovery_child.id
      AND item.status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      );

    UPDATE capture_tasks child
    SET status = 'canceled',
      message = '原任务已由用户停止，值守恢复任务已在领取前取消',
      metadata = child.metadata || jsonb_build_object(
        'stoppedBeforeDispatch', true,
        'dutyRecoveryCascadeStop', true,
        'sourceStopTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      ),
      finished_at = COALESCE(child.finished_at, now()),
      updated_at = now()
    WHERE child.id = recovery_child.id
      AND child.tenant_id = target_tenant_id;

    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type, actor_type,
      actor_id, actor_name, status, message, payload
    ) VALUES (
      target_tenant_id,
      recovery_child.id,
      COALESCE(recovery_child.assigned_agent_id, recovery_child.origin_agent_id),
      'duty_recovery_stopped_before_dispatch',
      'system',
      'capture-recovery-agent',
      '值守 Agent',
      'canceled',
      '原任务已由用户停止，恢复任务已在设备领取前取消',
      jsonb_build_object(
        'intentId', target_intent_id,
        'sourceTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      )
    );
    UPDATE capture_recovery_intents intent
    SET verification = intent.verification || jsonb_build_object(
        'cascadeStopState', 'verified',
        'cascadeStopVerifiedAt', now()::text,
        'cascadeStopChildStatus', 'canceled',
        'cascadeStopChildTaskId', recovery_child.id,
        'cascadeStopMode', 'before_dispatch'
      ),
      updated_at = now()
    WHERE intent.id = target_intent_id
      AND intent.tenant_id = target_tenant_id;
    RETURN;
  END IF;

  UPDATE capture_agent_commands command
  SET status = 'expired',
    result = command.result || jsonb_build_object(
      'reason', 'superseded_by_source_user_stop',
      'sourceTaskId', source_stop_task_id,
      'sourceStopCommandId', source_stop_command_id,
      'supersededCreateWasAcknowledged',
        command.command_type = 'create' AND command.status = 'acknowledged'
    ) || jsonb_strip_nulls(jsonb_build_object(
      'supersededCreateCommandId', CASE
        WHEN command.command_type = 'create'
          AND command.status = 'acknowledged'
          THEN command.id
        ELSE NULL
      END
    )),
    finished_at = COALESCE(command.finished_at, now()),
    updated_at = now()
  WHERE command.tenant_id = target_tenant_id
    AND command.task_id = recovery_child.id
    AND command.command_type IN ('create', 'resume')
    AND command.status IN ('pending', 'acknowledged');

  SELECT COALESCE(attempt.client_attempt_id, '')
  INTO targeted_attempt_id
  FROM capture_task_attempts attempt
  WHERE attempt.tenant_id = target_tenant_id
    AND attempt.task_id = recovery_child.id
    AND attempt.attempt_number = recovery_child.attempt_number
  LIMIT 1;

  previous_cascade_stop_state := COALESCE(
    recovery_child.intent_verification->>'cascadeStopState',
    ''
  );
  IF COALESCE(
    recovery_child.intent_verification->>'cascadeStopCheckCount',
    ''
  ) ~ '^[0-9]+$' THEN
    cascade_stop_check_count := (
      recovery_child.intent_verification->>'cascadeStopCheckCount'
    )::integer;
  END IF;
  cascade_stop_check_count := cascade_stop_check_count + 1;
  BEGIN
    cascade_stop_started_at := NULLIF(
      recovery_child.intent_verification->>'cascadeStopStartedAt',
      ''
    )::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    cascade_stop_started_at := NULL;
  END;
  cascade_stop_started_at := COALESCE(cascade_stop_started_at, now());
  BEGIN
    cascade_stop_deadline_at := NULLIF(
      recovery_child.intent_verification->>'cascadeStopDeadlineAt',
      ''
    )::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    cascade_stop_deadline_at := NULL;
  END;
  cascade_stop_deadline_at := COALESCE(
    cascade_stop_deadline_at,
    cascade_stop_started_at + interval '5 minutes'
  );
  cascade_stop_backoff_seconds := CASE
    WHEN cascade_stop_check_count <= 1 THEN 60
    WHEN cascade_stop_check_count = 2 THEN 120
    WHEN cascade_stop_check_count = 3 THEN 240
    ELSE 300
  END;
  cascade_stop_followup_at := LEAST(
    cascade_stop_deadline_at,
    now() + make_interval(secs => cascade_stop_backoff_seconds)
  );

  IF now() >= cascade_stop_deadline_at THEN
    UPDATE capture_agent_commands command
    SET status = 'expired',
      result = command.result || jsonb_build_object(
        'reason', 'duty_recovery_stop_verification_deadline_exceeded',
        'intentId', target_intent_id
      ),
      finished_at = COALESCE(command.finished_at, now()),
      updated_at = now()
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged');

    UPDATE capture_recovery_intents intent
    SET verification = intent.verification || jsonb_build_object(
        'cascadeStopState', 'manual_required',
        'cascadeStopChildTaskId', recovery_child.id,
        'cascadeStopAttemptCount', cascade_stop_attempt_count,
        'cascadeStopCheckCount', cascade_stop_check_count,
        'cascadeStopStartedAt', cascade_stop_started_at::text,
        'cascadeStopDeadlineAt', cascade_stop_deadline_at::text,
        'cascadeStopCheckedAt', now()::text,
        'cascadeStopFailureReason', 'verification_deadline_exceeded'
      ),
      updated_at = now()
    WHERE intent.id = target_intent_id
      AND intent.tenant_id = target_tenant_id;
    IF previous_cascade_stop_state <> 'manual_required' THEN
      INSERT INTO capture_task_events (
        tenant_id, task_id, agent_id, event_type, actor_type,
        actor_id, actor_name, status, message, payload
      ) VALUES (
        target_tenant_id,
        recovery_child.id,
        COALESCE(recovery_child.assigned_agent_id, recovery_child.origin_agent_id),
        'duty_recovery_stop_needs_action',
        'system',
        'capture-recovery-agent',
        '值守 Agent',
        recovery_child.status,
        '恢复任务未在停止时限内终止，已转人工处理',
        jsonb_build_object(
          'intentId', target_intent_id,
          'attemptCount', cascade_stop_attempt_count,
          'checkCount', cascade_stop_check_count,
          'deadlineAt', cascade_stop_deadline_at,
          'sourceTaskId', source_stop_task_id
        )
      );
    END IF;
    RETURN;
  END IF;

  IF targeted_stop AND COALESCE(targeted_attempt_id, '') = '' THEN
    UPDATE capture_agent_commands command
    SET status = 'expired',
      result = command.result || jsonb_build_object(
        'reason', 'waiting_for_exact_recovery_attempt'
      ),
      finished_at = COALESCE(command.finished_at, now()),
      updated_at = now()
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged');

    UPDATE capture_recovery_intents intent
    SET verification = intent.verification || jsonb_build_object(
        'cascadeStopState', 'waiting_exact_attempt',
        'cascadeStopChildTaskId', recovery_child.id,
        'cascadeStopExpectedAttemptNumber', recovery_child.attempt_number,
        'cascadeStopAttemptCount', cascade_stop_attempt_count,
        'cascadeStopCheckCount', cascade_stop_check_count,
        'cascadeStopStartedAt', cascade_stop_started_at::text,
        'cascadeStopDeadlineAt', cascade_stop_deadline_at::text,
        'cascadeStopNextCheckAt', cascade_stop_followup_at::text,
        'cascadeStopCheckedAt', now()::text
      ),
      updated_at = now()
    WHERE intent.id = target_intent_id
      AND intent.tenant_id = target_tenant_id;
    PERFORM enqueue_ops_control_wakeup(
      target_tenant_id,
      'capture_recovery_stop_followup',
      'capture_recovery_intent',
      target_intent_id::text,
      'capture-recovery-intent:' || target_intent_id::text || ':cascade-stop',
      cascade_stop_followup_at,
      jsonb_build_object(
        'cascadeStop', true,
        'childTaskId', recovery_child.id,
        'state', 'waiting_exact_attempt',
        'checkCount', cascade_stop_check_count,
        'deadlineAt', cascade_stop_deadline_at
      ),
      true
    );
    IF previous_cascade_stop_state <> 'waiting_exact_attempt' THEN
      INSERT INTO capture_task_events (
        tenant_id, task_id, agent_id, event_type, actor_type,
        actor_id, actor_name, status, message, payload
      ) VALUES (
        target_tenant_id,
        recovery_child.id,
        COALESCE(recovery_child.assigned_agent_id, recovery_child.origin_agent_id),
        'duty_recovery_stop_waiting_attempt',
        'system',
        'capture-recovery-agent',
        '值守 Agent',
        recovery_child.status,
        '原任务已停止，等待恢复任务生成精确执行批次后下发停止',
        jsonb_build_object(
          'intentId', target_intent_id,
          'expectedAttemptNumber', recovery_child.attempt_number,
          'deadlineAt', cascade_stop_deadline_at
        )
      );
    END IF;
    RETURN;
  END IF;

  IF COALESCE(
    recovery_child.assigned_agent_id,
    recovery_child.origin_agent_id
  ) IS NOT NULL THEN
    SELECT pg_try_advisory_xact_lock(
      hashtext('capture_agent_execution_slot'),
      hashtext(
        target_tenant_id::text || ':' || COALESCE(
          recovery_child.assigned_agent_id,
          recovery_child.origin_agent_id
        )::text
      )
    )
    INTO recovery_agent_lock_acquired;
  END IF;

  IF recovery_agent_lock_acquired THEN
    SELECT ca.id, ca.status, ca.auth_code_id, ca.auth_binding_id,
      tenant.status AS tenant_status,
      auth_code.status AS auth_code_status,
      auth_code.expires_at AS auth_code_expires_at,
      binding.id AS active_auth_binding_id
    INTO recovery_agent_id, recovery_agent_status,
      recovery_agent_auth_code_id, recovery_agent_auth_binding_id,
      recovery_agent_tenant_status, recovery_agent_auth_code_status,
      recovery_agent_auth_code_expires_at,
      recovery_agent_active_auth_binding_id
    FROM capture_agents ca
    JOIN tenants tenant
      ON tenant.id = ca.tenant_id
    JOIN auth_codes auth_code
      ON auth_code.id = ca.auth_code_id
      AND auth_code.tenant_id = ca.tenant_id
    JOIN auth_bindings binding
      ON binding.id = ca.auth_binding_id
      AND binding.code_id = auth_code.id
    WHERE ca.tenant_id = target_tenant_id
      AND ca.id = COALESCE(
        recovery_child.assigned_agent_id,
        recovery_child.origin_agent_id
      )
    FOR SHARE OF ca, tenant, auth_code, binding;

    UPDATE capture_agent_commands command
    SET status = 'expired',
      result = command.result || jsonb_build_object(
        'reason', 'duty_recovery_stop_entitlement_changed'
      ),
      finished_at = COALESCE(command.finished_at, now()),
      updated_at = now()
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged')
      AND (
        recovery_agent_id IS NULL
        OR command.agent_id <> recovery_agent_id
        OR command.payload->>'authCodeId' IS DISTINCT FROM
          recovery_agent_auth_code_id::text
        OR command.payload->>'authBindingId' IS DISTINCT FROM
          recovery_agent_auth_binding_id::text
      );
  END IF;

  IF targeted_stop THEN
    UPDATE capture_agent_commands command
    SET status = 'expired',
      result = command.result || jsonb_build_object(
        'reason', 'stale_cascade_stop_attempt'
      ),
      finished_at = COALESCE(command.finished_at, now()),
      updated_at = now()
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged')
      AND COALESCE(command.payload->>'attemptId', '') <> targeted_attempt_id;
  END IF;

  SELECT command.id
  INTO recovery_stop_command_id
  FROM capture_agent_commands command
  WHERE command.tenant_id = target_tenant_id
    AND command.task_id = recovery_child.id
      AND recovery_agent_lock_acquired
      AND command.agent_id = recovery_agent_id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged')
      AND (command.expires_at IS NULL OR command.expires_at > now())
      AND command.payload->>'authCodeId' = recovery_agent_auth_code_id::text
      AND command.payload->>'authBindingId' =
        recovery_agent_auth_binding_id::text
      AND (
        NOT targeted_stop
        OR command.payload->>'attemptId' = targeted_attempt_id
      )
  ORDER BY command.created_at DESC, command.id DESC
  LIMIT 1
  FOR UPDATE;

  IF recovery_stop_command_id IS NOT NULL THEN
    UPDATE capture_agent_commands command
    SET expires_at = LEAST(command.expires_at, cascade_stop_deadline_at),
      updated_at = now()
    WHERE command.id = recovery_stop_command_id
      AND command.tenant_id = target_tenant_id;
  END IF;

  IF recovery_stop_command_id IS NULL
    AND cascade_stop_attempt_count >= 3
  THEN
    UPDATE capture_recovery_intents intent
    SET verification = intent.verification || jsonb_build_object(
        'cascadeStopState', 'manual_required',
        'cascadeStopChildTaskId', recovery_child.id,
        'cascadeStopAttemptCount', cascade_stop_attempt_count,
        'cascadeStopCheckCount', cascade_stop_check_count,
        'cascadeStopStartedAt', cascade_stop_started_at::text,
        'cascadeStopDeadlineAt', cascade_stop_deadline_at::text,
        'cascadeStopCheckedAt', now()::text
      ),
      updated_at = now()
    WHERE intent.id = target_intent_id
      AND intent.tenant_id = target_tenant_id;
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type, actor_type,
      actor_id, actor_name, status, message, payload
    ) VALUES (
      target_tenant_id,
      recovery_child.id,
      COALESCE(recovery_child.assigned_agent_id, recovery_child.origin_agent_id),
      'duty_recovery_stop_needs_action',
      'system',
      'capture-recovery-agent',
      '值守 Agent',
      recovery_child.status,
      '恢复任务连续停止失败，已转人工处理',
      jsonb_build_object(
        'intentId', target_intent_id,
        'attemptCount', cascade_stop_attempt_count,
        'sourceTaskId', source_stop_task_id
      )
    );
    RETURN;
  END IF;

  IF recovery_stop_command_id IS NULL
    AND recovery_agent_lock_acquired
    AND recovery_agent_id IS NOT NULL
    AND recovery_agent_status = 'active'
    AND recovery_agent_tenant_status = 'active'
    AND recovery_agent_auth_code_status = 'active'
    AND recovery_agent_active_auth_binding_id IS NOT NULL
    AND (
      recovery_agent_auth_code_expires_at IS NULL
      OR recovery_agent_auth_code_expires_at > now()
    )
  THEN
    INSERT INTO capture_agent_commands (
      tenant_id, agent_id, task_id, command_type, payload,
      requested_by_name, expires_at
    ) VALUES (
      target_tenant_id,
      recovery_agent_id,
      recovery_child.id,
      'stop',
      jsonb_strip_nulls(jsonb_build_object(
        'controlTaskId', COALESCE(
          NULLIF(recovery_child.control_task_id, ''),
          NULLIF(recovery_child.client_task_id, ''),
          recovery_child.id::text
        ),
        'previousStatus', recovery_child.status,
        'supersededCreateCommandId', CASE
          WHEN create_command.status = 'acknowledged'
            OR create_command.result->>'supersededCreateWasAcknowledged' = 'true'
            THEN create_command.id
          ELSE NULL
        END,
        'attemptId', NULLIF(targeted_attempt_id, ''),
        'authCodeId', recovery_agent_auth_code_id,
        'authBindingId', recovery_agent_auth_binding_id,
        'platform', recovery_child.platform,
        'dutyRecoveryIntentId', target_intent_id,
        'sourceTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      )),
      '值守 Agent · 用户停止联动',
      cascade_stop_deadline_at
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO recovery_stop_command_id;
    IF recovery_stop_command_id IS NOT NULL THEN
      cascade_stop_attempt_count := cascade_stop_attempt_count + 1;
      inserted_stop_command := true;
    END IF;
  END IF;

  IF recovery_stop_command_id IS NULL THEN
    SELECT command.id
    INTO recovery_stop_command_id
    FROM capture_agent_commands command
    WHERE command.tenant_id = target_tenant_id
      AND command.task_id = recovery_child.id
      AND recovery_agent_lock_acquired
      AND command.agent_id = recovery_agent_id
      AND command.command_type = 'stop'
      AND command.status IN ('pending', 'acknowledged')
      AND (command.expires_at IS NULL OR command.expires_at > now())
      AND command.payload->>'authCodeId' = recovery_agent_auth_code_id::text
      AND command.payload->>'authBindingId' =
        recovery_agent_auth_binding_id::text
      AND (
        NOT targeted_stop
        OR command.payload->>'attemptId' = targeted_attempt_id
      )
    ORDER BY command.created_at DESC, command.id DESC
    LIMIT 1;
  END IF;

  UPDATE capture_tasks child
  SET message = '原任务已由用户停止，正在停止值守恢复任务',
    metadata = (child.metadata - 'resumeCommandId' - 'resumePreviousStatus')
      || jsonb_strip_nulls(jsonb_build_object(
        'stopCommandId', recovery_stop_command_id,
        'stopPreviousStatus', recovery_child.status,
        'dutyRecoveryCascadeStop', true,
        'sourceStopTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      )),
    updated_at = now()
  WHERE child.id = recovery_child.id
    AND child.tenant_id = target_tenant_id;

  UPDATE capture_recovery_intents intent
  SET verification = intent.verification || jsonb_build_object(
      'cascadeStopState', CASE
        WHEN recovery_stop_command_id IS NULL THEN 'retry_wait'
        ELSE 'command_pending'
      END,
      'cascadeStopChildTaskId', recovery_child.id,
      'cascadeStopCommandId', recovery_stop_command_id,
      'cascadeStopAttemptCount', cascade_stop_attempt_count,
      'cascadeStopCheckCount', cascade_stop_check_count,
      'cascadeStopAttemptId', NULLIF(targeted_attempt_id, ''),
      'cascadeStopStartedAt', cascade_stop_started_at::text,
      'cascadeStopDeadlineAt', cascade_stop_deadline_at::text,
      'cascadeStopNextCheckAt', cascade_stop_followup_at::text,
      'cascadeStopCheckedAt', now()::text
    ),
    updated_at = now()
  WHERE intent.id = target_intent_id
    AND intent.tenant_id = target_tenant_id;

  next_cascade_stop_state := CASE
    WHEN recovery_stop_command_id IS NULL THEN 'retry_wait'
    ELSE 'command_pending'
  END;

  PERFORM enqueue_ops_control_wakeup(
    target_tenant_id,
    'capture_recovery_stop_followup',
    'capture_recovery_intent',
    target_intent_id::text,
    'capture-recovery-intent:' || target_intent_id::text || ':cascade-stop',
    cascade_stop_followup_at,
    jsonb_build_object(
      'cascadeStop', true,
      'childTaskId', recovery_child.id,
      'commandId', recovery_stop_command_id,
      'attemptCount', cascade_stop_attempt_count,
      'checkCount', cascade_stop_check_count,
      'deadlineAt', cascade_stop_deadline_at
    ),
    true
  );

  IF inserted_stop_command
    OR previous_cascade_stop_state <> next_cascade_stop_state
  THEN
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type, actor_type,
      actor_id, actor_name, status, message, payload
    ) VALUES (
      target_tenant_id,
      recovery_child.id,
      COALESCE(recovery_child.assigned_agent_id, recovery_child.origin_agent_id),
      'duty_recovery_stop_requested',
      'system',
      'capture-recovery-agent',
      '值守 Agent',
      recovery_child.status,
      CASE
        WHEN recovery_stop_command_id IS NULL
          THEN '原任务已由用户停止，恢复任务停止指令等待重试'
        ELSE '原任务已由用户停止，恢复任务停止指令已排队'
      END,
      jsonb_build_object(
        'intentId', target_intent_id,
        'commandId', recovery_stop_command_id,
        'attemptCount', cascade_stop_attempt_count,
        'checkCount', cascade_stop_check_count,
        'deadlineAt', cascade_stop_deadline_at,
        'sourceTaskId', source_stop_task_id,
        'sourceStopCommandId', source_stop_command_id
      )
    );
  END IF;
END;
$$;

-- A user-issued stop is a hard boundary. Absorb it in the recovery ledger in
-- the same transaction instead of waiting for a later observer cycle.
CREATE OR REPLACE FUNCTION stop_capture_recovery_intents_for_user_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  stopped_intent RECORD;
  stop_command_id TEXT := '';
  has_stop_command BOOLEAN := false;
  operator_stopped BOOLEAN := false;
  stopped_before_dispatch BOOLEAN := false;
  duty_recovery_intent_id TEXT := '';
BEGIN
  stop_command_id := lower(btrim(
    COALESCE(NEW.metadata->>'stopCommandId', '')
  ));
  has_stop_command := stop_command_id ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  operator_stopped := lower(btrim(
    COALESCE(NEW.metadata->>'operatorStopped', 'false')
  )) = 'true';
  stopped_before_dispatch := lower(btrim(
    COALESCE(NEW.metadata->>'stoppedBeforeDispatch', 'false')
  )) = 'true';
  IF NOT (
    has_stop_command
    OR operator_stopped
    OR stopped_before_dispatch
  )
    OR (TG_OP = 'UPDATE' AND (
      OLD.metadata->>'stopCommandId' IS NOT DISTINCT FROM
        NEW.metadata->>'stopCommandId'
      AND lower(btrim(COALESCE(OLD.metadata->>'operatorStopped', 'false'))) =
        lower(btrim(COALESCE(NEW.metadata->>'operatorStopped', 'false')))
      AND lower(btrim(COALESCE(OLD.metadata->>'stoppedBeforeDispatch', 'false'))) =
        lower(btrim(COALESCE(NEW.metadata->>'stoppedBeforeDispatch', 'false')))
    ))
  THEN
    RETURN NEW;
  END IF;

  duty_recovery_intent_id := lower(btrim(COALESCE(
    NEW.metadata->>'dutyRecoveryIntentId',
    ''
  )));
  IF lower(btrim(COALESCE(
    NEW.metadata->>'dutyRecoveryCascadeStop',
    'false'
  ))) = 'true' THEN
    RETURN NEW;
  END IF;
  IF NEW.id::text = duty_recovery_intent_id
    AND duty_recovery_intent_id ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    -- The recovery child uses the intent UUID as its task UUID. Absorb a
    -- direct operator stop in the ledger in this same task -> intent lock
    -- order; a queued worker is only responsible for stopping/reconciling the
    -- physical child, never for establishing the user-stop boundary.
    UPDATE capture_recovery_intents intent
    SET status = 'stopped_by_user',
      decision = 'stop',
      verification = intent.verification || jsonb_build_object(
        'reason', 'recovery_child_stopped_by_user',
        'stopCommandId', CASE
          WHEN has_stop_command THEN stop_command_id
          ELSE ''
        END,
        'operatorStopped', operator_stopped,
        'stoppedBeforeDispatch', stopped_before_dispatch,
        'observedAt', now()::text,
        'noBusinessAction', intent.action_count = 0
      ),
      last_error = '',
      resolved_at = now(),
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    WHERE intent.tenant_id = NEW.tenant_id
      AND intent.id = NEW.id
      AND intent.status NOT IN (
        'resolved', 'exhausted_window', 'stopped_by_user'
      );
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_child_stopped_by_user',
      'capture_recovery_scope_stop',
      duty_recovery_intent_id,
      'capture-recovery-scope-stop:intent:' || duty_recovery_intent_id,
      now(),
      jsonb_build_object(
        'scopeType', 'recovery_intent',
        'intentId', duty_recovery_intent_id,
        'childTaskId', NEW.id,
        'stopCommandId', CASE
          WHEN has_stop_command THEN stop_command_id
          ELSE ''
        END,
        'trigger', 'recovery_child_stop'
      ),
      true
    );
    RETURN NEW;
  END IF;

  FOR stopped_intent IN
    UPDATE capture_recovery_intents intent
    SET status = 'stopped_by_user',
      decision = 'stop',
      verification = intent.verification || jsonb_build_object(
        'reason', 'user_stop_command',
        'stopCommandId', CASE WHEN has_stop_command THEN stop_command_id ELSE '' END,
        'operatorStopped', operator_stopped,
        'stoppedBeforeDispatch', stopped_before_dispatch,
        'observedAt', now()::text,
        'noBusinessAction', true
      ),
      last_error = '',
      resolved_at = now(),
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    WHERE intent.tenant_id = NEW.tenant_id
      AND (
        intent.parent_task_id = NEW.id
        OR intent.recovery_task_id = NEW.id
        OR EXISTS (
          SELECT 1
          FROM capture_task_items stopped_item
          WHERE stopped_item.tenant_id = intent.tenant_id
            AND stopped_item.id = intent.item_id
            AND stopped_item.execution_task_id = NEW.id
        )
        OR EXISTS (
          SELECT 1
          FROM capture_task_attempts source_execution_attempt
          WHERE source_execution_attempt.tenant_id = intent.tenant_id
            AND source_execution_attempt.id = intent.source_execution_attempt_id
            AND source_execution_attempt.task_id = NEW.id
        )
        OR EXISTS (
          SELECT 1
          FROM capture_task_item_attempts source_item_attempt
          WHERE source_item_attempt.tenant_id = intent.tenant_id
            AND source_item_attempt.id = intent.source_attempt_id
            AND source_item_attempt.execution_task_id = NEW.id
        )
      )
      AND intent.status NOT IN (
        'resolved', 'exhausted_window', 'stopped_by_user'
      )
    RETURNING intent.id, intent.item_id, intent.recovery_task_id
  LOOP
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_stopped_by_user',
      'capture_recovery_intent',
      stopped_intent.id::text,
      'capture-recovery-intent:' || stopped_intent.id::text || ':stopped',
      now(),
      jsonb_build_object(
        'itemId', stopped_intent.item_id,
        'stopCommandId', CASE WHEN has_stop_command THEN stop_command_id ELSE '' END,
        'operatorStopped', operator_stopped,
        'stoppedBeforeDispatch', stopped_before_dispatch
      ),
      true
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stop_capture_recovery_intents_for_user_command
  ON capture_tasks;
CREATE TRIGGER trg_stop_capture_recovery_intents_for_user_command
AFTER INSERT OR UPDATE OF metadata
ON capture_tasks
FOR EACH ROW
EXECUTE FUNCTION stop_capture_recovery_intents_for_user_command();

-- Every transition into the absorbing user-stop state emits the same durable
-- cascade wake. This closes races where the verifier observes a removed
-- watch/subscription before the original scope-stop event is consumed.
CREATE OR REPLACE FUNCTION notify_capture_recovery_intent_stopped()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status = 'stopped_by_user'
    AND COALESCE(NEW.verification->>'cascadeStopState', '') NOT IN (
      'verified', 'manual_required'
    )
  THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_intent_stopped',
      'capture_recovery_intent',
      NEW.id::text,
      'capture-recovery-intent:' || NEW.id::text || ':cascade-stop',
      now(),
      jsonb_build_object(
        'itemId', NEW.item_id,
        'cascadeStop', true,
        'trigger', 'intent_stopped_by_user'
      ),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_capture_recovery_intent_stopped
  ON capture_recovery_intents;
CREATE TRIGGER trg_notify_capture_recovery_intent_stopped
AFTER UPDATE OF status
ON capture_recovery_intents
FOR EACH ROW
EXECUTE FUNCTION notify_capture_recovery_intent_stopped();

-- A later manual stop can settle a child after the automatic stop deadline.
-- Wake the exact intent when that child becomes terminal so the stop receipt
-- is reconciled from business/task state rather than remaining falsely manual.
CREATE OR REPLACE FUNCTION notify_capture_recovery_child_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  duty_recovery_intent_id TEXT := '';
BEGIN
  duty_recovery_intent_id := lower(btrim(COALESCE(
    NEW.metadata->>'dutyRecoveryIntentId',
    ''
  )));
  IF OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status IN (
      'completed', 'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'skipped', 'superseded'
    )
    AND NEW.id::text = duty_recovery_intent_id
    AND duty_recovery_intent_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_child_terminal',
      'capture_recovery_intent',
      duty_recovery_intent_id,
      'capture-recovery-intent:' || duty_recovery_intent_id || ':cascade-stop',
      now(),
      jsonb_build_object(
        'cascadeStop', true,
        'childTaskId', NEW.id,
        'childStatus', NEW.status,
        'trigger', 'recovery_child_terminal'
      ),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_capture_recovery_child_terminal
  ON capture_tasks;
CREATE TRIGGER trg_notify_capture_recovery_child_terminal
AFTER UPDATE OF status
ON capture_tasks
FOR EACH ROW
EXECUTE FUNCTION notify_capture_recovery_child_terminal();

-- Removing a watched-content intent is authoritative. Emit a durable scope
-- stop instead of locking the recovery ledger from this row trigger: the
-- dispatcher locks intent before watchlist, so doing both here would invert
-- that order and could deadlock a user request.
CREATE OR REPLACE FUNCTION stop_capture_recovery_for_watchlist_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capture_recovery_intents intent
    JOIN capture_task_items item
      ON item.id = intent.item_id
      AND item.tenant_id = intent.tenant_id
    WHERE intent.tenant_id = OLD.tenant_id
      AND item.item_type = 'watched_content'
      AND item.record_id = OLD.record_id
      AND intent.status NOT IN ('resolved', 'exhausted_window')
  ) THEN
    PERFORM enqueue_ops_control_wakeup(
      OLD.tenant_id,
      'capture_recovery_watchlist_intent_removed',
      'capture_recovery_scope_stop',
      OLD.record_id::text,
      'capture-recovery-scope-stop:watchlist:' || OLD.record_id::text,
      now(),
      jsonb_build_object(
        'scopeType', 'watchlist',
        'recordId', OLD.record_id,
        'trigger', 'watchlist_delete'
      ),
      true
    );
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_stop_capture_recovery_for_watchlist_delete
  ON record_watchlist;
CREATE TRIGGER trg_stop_capture_recovery_for_watchlist_delete
AFTER DELETE
ON record_watchlist
FOR EACH ROW
EXECUTE FUNCTION stop_capture_recovery_for_watchlist_delete();

-- Profile patrol is authorized by an active subscription. As above, defer
-- ledger/child locking to the durable worker to preserve one global lock order.
CREATE OR REPLACE FUNCTION stop_capture_recovery_for_subscription_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  scope_tenant_id UUID;
  scope_subscription_id UUID;
  scope_reason TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    scope_tenant_id := OLD.tenant_id;
    scope_subscription_id := OLD.id;
    scope_reason := 'profile_subscription_deleted';
  ELSE
    IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status = 'active' THEN
      RETURN NEW;
    END IF;
    scope_tenant_id := NEW.tenant_id;
    scope_subscription_id := NEW.id;
    scope_reason := 'profile_subscription_' || lower(COALESCE(NEW.status, 'inactive'));
  END IF;

  IF EXISTS (
    SELECT 1
    FROM capture_recovery_intents intent
    JOIN capture_task_items item
      ON item.id = intent.item_id
      AND item.tenant_id = intent.tenant_id
    WHERE intent.tenant_id = scope_tenant_id
      AND item.item_type = 'profile_subscription'
      AND lower(COALESCE(
        NULLIF(item.metadata->>'subscriptionId', ''),
        NULLIF(item.metadata->>'subscription_id', ''),
        item.external_id
      )) = scope_subscription_id::text
      AND intent.status NOT IN ('resolved', 'exhausted_window')
  ) THEN
    PERFORM enqueue_ops_control_wakeup(
      scope_tenant_id,
      'capture_recovery_subscription_intent_removed',
      'capture_recovery_scope_stop',
      scope_subscription_id::text,
      'capture-recovery-scope-stop:subscription:' || scope_subscription_id::text,
      now(),
      jsonb_build_object(
        'scopeType', 'profile_subscription',
        'subscriptionId', scope_subscription_id,
        'trigger', scope_reason
      ),
      true
    );
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_stop_capture_recovery_for_subscription_change
  ON monitor_subscriptions;
CREATE TRIGGER trg_stop_capture_recovery_for_subscription_change
AFTER UPDATE OF status OR DELETE
ON monitor_subscriptions
FOR EACH ROW
EXECUTE FUNCTION stop_capture_recovery_for_subscription_change();

-- If a worker crashes after the recovery child commits but before it records
-- the action, the item-state event may be consumed before the ledger catches
-- up. Once the failed recovery attempt is durably reconciled, emit one fresh
-- item event so the next generation can be created from the recorded action.
CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_next_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status = 'failed'
    AND NEW.action_count > 0
    AND NEW.dispatched_attempt_id IS NOT NULL
    AND COALESCE(
      NEW.verification->>'nextGenerationComesFromItemStateEvent',
      'false'
    ) = 'true'
  THEN
    PERFORM enqueue_ops_control_wakeup(
      NEW.tenant_id,
      'capture_recovery_next_generation',
      'capture_task_item',
      NEW.item_id::text,
      'capture-recovery-next-generation:' || NEW.id::text || ':'
        || NEW.generation::text,
      now(),
      jsonb_build_object(
        'intentId', NEW.id,
        'itemId', NEW.item_id,
        'dispatchedAttemptId', NEW.dispatched_attempt_id,
        'generation', NEW.generation
      ),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_next_generation
  ON capture_recovery_intents;
CREATE TRIGGER trg_ops_control_capture_recovery_next_generation
AFTER UPDATE OF status, verification, action_count, dispatched_attempt_id
ON capture_recovery_intents
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_next_generation();

INSERT INTO tenant_settings (tenant_id, key, value)
SELECT tenant.id, defaults.key, defaults.value
FROM tenants tenant
CROSS JOIN (VALUES
  ('ops_control_recovery_enabled', 'false'),
  ('ops_control_recovery_mode', 'observe')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- A tenant switch can be enabled while the process-wide recovery gate is off.
-- The durable root wakeup may be observed/consumed in that state; startup also
-- recreates it for every enabled tenant when the global gate later turns on.
CREATE OR REPLACE FUNCTION notify_ops_control_capture_recovery_enabled()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_enabled BOOLEAN := false;
  new_enabled BOOLEAN := false;
  old_mode TEXT := 'observe';
  new_mode TEXT := 'observe';
  wake_trigger TEXT := '';
BEGIN
  IF NEW.key NOT IN (
    'ops_control_recovery_enabled',
    'ops_control_recovery_mode'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.key = 'ops_control_recovery_enabled' THEN
    IF TG_OP = 'UPDATE' AND OLD.key = 'ops_control_recovery_enabled' THEN
      old_enabled := lower(btrim(COALESCE(OLD.value, '')))
        IN ('1', 'true', 'on', 'yes');
    END IF;
    new_enabled := lower(btrim(COALESCE(NEW.value, '')))
      IN ('1', 'true', 'on', 'yes');
    IF new_enabled AND NOT old_enabled THEN
      wake_trigger := 'tenant_enable';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.key = 'ops_control_recovery_mode' THEN
      old_mode := lower(btrim(COALESCE(OLD.value, 'observe')));
    END IF;
    new_mode := lower(btrim(COALESCE(NEW.value, 'observe')));
    IF new_mode = 'guarded' AND old_mode <> 'guarded' THEN
      wake_trigger := 'tenant_guarded';
    END IF;
  END IF;

  IF wake_trigger <> '' THEN
    -- A mode preference alone is not enablement. Route through the durable
    -- tenant gate so observe -> guarded cannot wake Recovery while the tenant
    -- switch remains off.
    PERFORM enqueue_capture_recovery_wakeup(
      NEW.tenant_id,
      'capture_recovery_backfill',
      'capture_recovery_backfill',
      NEW.tenant_id::text,
      'capture-recovery-backfill:root',
      now(),
      jsonb_build_object(
        'cursor', NULL,
        'trigger', wake_trigger,
        'observeOnly', wake_trigger <> 'tenant_guarded'
      ),
      false
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_control_capture_recovery_enabled
  ON tenant_settings;
CREATE TRIGGER trg_ops_control_capture_recovery_enabled
AFTER INSERT OR UPDATE OF key, value
ON tenant_settings
FOR EACH ROW
EXECUTE FUNCTION notify_ops_control_capture_recovery_enabled();

COMMENT ON TABLE capture_recovery_intents IS
  'Durable item recovery decisions with stage evidence. Migration 074 ships observe-only with all recovery gates disabled by default.';
