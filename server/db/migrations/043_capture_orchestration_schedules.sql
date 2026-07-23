-- Cloud-owned unattended schedules for multi-Agent keyword orchestration.
--
-- A schedule is a durable template. Each due occurrence creates a fresh
-- capture_orchestration run and ordinary one-time child commands. It does not
-- overwrite the one local unattended plan stored by each Extension.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_tasks_id_tenant
  ON capture_tasks (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_agents_id_tenant
  ON capture_agents (id, tenant_id);

CREATE TABLE IF NOT EXISTS capture_orchestration_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_task_id UUID NOT NULL UNIQUE
    REFERENCES capture_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'canceled')),
  schedule_mode TEXT NOT NULL DEFAULT 'daily'
    CHECK (schedule_mode IN ('daily', 'custom_dates')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  start_time TEXT NOT NULL DEFAULT '09:00'
    CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  random_offset_min INTEGER NOT NULL DEFAULT 0
    CHECK (random_offset_min BETWEEN 0 AND 240),
  custom_dates DATE[] NOT NULL DEFAULT '{}',
  overlap_policy TEXT NOT NULL DEFAULT 'skip'
    CHECK (overlap_policy IN ('skip')),
  late_start_grace_min INTEGER NOT NULL DEFAULT 360
    CHECK (late_start_grace_min BETWEEN 1 AND 1440),
  allocation_mode TEXT NOT NULL DEFAULT 'balanced'
    CHECK (allocation_mode IN ('balanced')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at TIMESTAMPTZ,
  last_scheduled_for TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_run_task_id UUID REFERENCES capture_tasks(id) ON DELETE SET NULL,
  last_run_status TEXT NOT NULL DEFAULT '',
  last_error JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_orchestration_schedules_id_tenant
  ON capture_orchestration_schedules (id, tenant_id);

ALTER TABLE capture_orchestration_schedules
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedules_template_tenant_fkey;
ALTER TABLE capture_orchestration_schedules
  ADD CONSTRAINT capture_orchestration_schedules_template_tenant_fkey
  FOREIGN KEY (template_task_id, tenant_id)
  REFERENCES capture_tasks (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE capture_orchestration_schedules
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedules_last_run_tenant_fkey;
ALTER TABLE capture_orchestration_schedules
  ADD CONSTRAINT capture_orchestration_schedules_last_run_tenant_fkey
  FOREIGN KEY (last_run_task_id, tenant_id)
  REFERENCES capture_tasks (id, tenant_id)
  -- PostgreSQL 14 does not support a target-column list for SET NULL.
  -- The single-column FK declared above clears last_run_task_id; this
  -- composite guard only prevents a cross-tenant reference.
  ON DELETE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_capture_orchestration_schedules_due
  ON capture_orchestration_schedules (next_run_at, id)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS capture_orchestration_schedule_agents (
  schedule_id UUID NOT NULL
    REFERENCES capture_orchestration_schedules(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, agent_id),
  UNIQUE (schedule_id, ordinal)
);

ALTER TABLE capture_orchestration_schedule_agents
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedule_agents_schedule_tenant_fkey;
ALTER TABLE capture_orchestration_schedule_agents
  ADD CONSTRAINT capture_orchestration_schedule_agents_schedule_tenant_fkey
  FOREIGN KEY (schedule_id, tenant_id)
  REFERENCES capture_orchestration_schedules (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE capture_orchestration_schedule_agents
  DROP CONSTRAINT IF EXISTS capture_orchestration_schedule_agents_agent_tenant_fkey;
ALTER TABLE capture_orchestration_schedule_agents
  ADD CONSTRAINT capture_orchestration_schedule_agents_agent_tenant_fkey
  FOREIGN KEY (agent_id, tenant_id)
  REFERENCES capture_agents (id, tenant_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_capture_orchestration_schedule_agents_agent
  ON capture_orchestration_schedule_agents (tenant_id, agent_id, schedule_id);

ALTER TABLE capture_tasks
  ADD COLUMN IF NOT EXISTS orchestration_schedule_id UUID
    REFERENCES capture_orchestration_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_revision INTEGER,
  ADD COLUMN IF NOT EXISTS attention_dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attention_dismissed_by_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attention_dismissed_by_name TEXT NOT NULL DEFAULT '';

ALTER TABLE capture_tasks
  DROP CONSTRAINT IF EXISTS capture_tasks_orchestration_schedule_tenant_fkey;
ALTER TABLE capture_tasks
  ADD CONSTRAINT capture_tasks_orchestration_schedule_tenant_fkey
  FOREIGN KEY (orchestration_schedule_id, tenant_id)
  REFERENCES capture_orchestration_schedules (id, tenant_id)
  -- The single-column FK clears orchestration_schedule_id. Keep this
  -- PostgreSQL-14-compatible composite FK as the tenant boundary.
  ON DELETE NO ACTION;

ALTER TABLE capture_tasks
  DROP CONSTRAINT IF EXISTS capture_tasks_schedule_revision_check;
ALTER TABLE capture_tasks
  ADD CONSTRAINT capture_tasks_schedule_revision_check
  CHECK (schedule_revision IS NULL OR schedule_revision > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_orchestration_schedule_occurrence
  ON capture_tasks (tenant_id, orchestration_schedule_id, scheduled_for)
  WHERE orchestration_schedule_id IS NOT NULL
    AND scheduled_for IS NOT NULL
    AND task_type = 'capture_orchestration';

CREATE INDEX IF NOT EXISTS idx_capture_tasks_orchestration_schedule
  ON capture_tasks (orchestration_schedule_id, scheduled_for DESC)
  WHERE orchestration_schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capture_tasks_attention_visible
  ON capture_tasks (tenant_id, updated_at DESC)
  WHERE attention_dismissed_at IS NULL
    AND status IN (
      'interrupted', 'needs_action', 'failed', 'completed_with_failures'
    );
