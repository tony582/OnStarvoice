-- First production slice for keyword-task orchestration.
--
-- A parent capture_tasks row is the business task. Each initial dispatch creates
-- ordinary child capture_tasks rows (one per selected Agent) and sends the
-- existing `create` command with a disjoint keyword group. This migration does
-- not add claim leases, fencing tokens, or live running-item handoff.

ALTER TABLE capture_tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID
    REFERENCES capture_tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS orchestration_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE capture_tasks
  DROP CONSTRAINT IF EXISTS capture_tasks_orchestration_revision_check;
ALTER TABLE capture_tasks
  ADD CONSTRAINT capture_tasks_orchestration_revision_check
  CHECK (orchestration_revision >= 0);

ALTER TABLE capture_tasks
  DROP CONSTRAINT IF EXISTS capture_tasks_parent_not_self_check;
ALTER TABLE capture_tasks
  ADD CONSTRAINT capture_tasks_parent_not_self_check
  CHECK (parent_task_id IS NULL OR parent_task_id <> id);

CREATE INDEX IF NOT EXISTS idx_capture_tasks_parent_created
  ON capture_tasks (parent_task_id, created_at, id)
  WHERE parent_task_id IS NOT NULL;

-- The task center refreshes Agent load every 15 seconds. Keep the load
-- aggregate over root and orchestration-child tasks indexable without doing a
-- per-Agent history scan.
CREATE INDEX IF NOT EXISTS idx_capture_tasks_agent_active_load
  ON capture_tasks (
    tenant_id,
    (COALESCE(assigned_agent_id, origin_agent_id)),
    status
  )
  WHERE COALESCE(assigned_agent_id, origin_agent_id) IS NOT NULL
    AND status IN (
      'pending', 'claimed', 'running', 'recovering', 'resume_requested'
    );

ALTER TABLE capture_task_items
  ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS keyword TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID
    REFERENCES capture_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS execution_task_id UUID
    REFERENCES capture_tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignment_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE capture_task_items
  DROP CONSTRAINT IF EXISTS capture_task_items_status_check;
ALTER TABLE capture_task_items
  ADD CONSTRAINT capture_task_items_status_check
  CHECK (status IN (
    'pending', 'assigned', 'dispatch_pending', 'dispatched',
    'waiting_device', 'running', 'retryable', 'needs_action',
    'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
  ));

ALTER TABLE capture_task_items
  DROP CONSTRAINT IF EXISTS capture_task_items_ordinal_check;
ALTER TABLE capture_task_items
  ADD CONSTRAINT capture_task_items_ordinal_check
  CHECK (ordinal >= 0);

ALTER TABLE capture_task_items
  DROP CONSTRAINT IF EXISTS capture_task_items_assignment_revision_check;
ALTER TABLE capture_task_items
  ADD CONSTRAINT capture_task_items_assignment_revision_check
  CHECK (assignment_revision >= 0);

ALTER TABLE capture_task_items
  DROP CONSTRAINT IF EXISTS capture_task_items_request_hash_check;
ALTER TABLE capture_task_items
  ADD CONSTRAINT capture_task_items_request_hash_check
  CHECK (request_hash = '' OR request_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS idx_capture_task_items_agent_status
  ON capture_task_items (assigned_agent_id, status, ordinal)
  WHERE assigned_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capture_task_items_execution_task
  ON capture_task_items (execution_task_id, ordinal)
  WHERE execution_task_id IS NOT NULL;

-- Append-only item-attempt audit. assignment_revision records which allocation
-- produced an attempt, but is deliberately not a fencing or execution lease.
CREATE TABLE IF NOT EXISTS capture_task_item_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES capture_task_items(id) ON DELETE CASCADE,
  parent_task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  execution_task_id UUID REFERENCES capture_tasks(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_number > 0),
  assignment_revision INTEGER NOT NULL DEFAULT 0
    CHECK (assignment_revision >= 0),
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN (
      'assigned', 'dispatch_pending', 'dispatched', 'waiting_device',
      'running', 'interrupted', 'retryable', 'needs_action',
      'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
    )),
  request_hash TEXT NOT NULL DEFAULT ''
    CHECK (request_hash = '' OR request_hash ~ '^[0-9a-f]{64}$'),
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_capture_task_item_attempts_parent_created
  ON capture_task_item_attempts (parent_task_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_capture_task_item_attempts_execution
  ON capture_task_item_attempts (execution_task_id, created_at, id)
  WHERE execution_task_id IS NOT NULL;
