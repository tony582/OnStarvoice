CREATE TABLE IF NOT EXISTS capture_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  auth_code_id UUID REFERENCES auth_codes(id) ON DELETE SET NULL,
  auth_binding_id UUID REFERENCES auth_bindings(id) ON DELETE SET NULL,
  client_uuid TEXT NOT NULL,
  client_label TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  host_label TEXT NOT NULL DEFAULT '',
  browser_name TEXT NOT NULL DEFAULT '',
  operating_system TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  allowed_platforms TEXT[] NOT NULL DEFAULT '{}',
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'revoked')),
  last_heartbeat_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS idx_capture_agents_tenant_heartbeat
  ON capture_agents (tenant_id, last_heartbeat_at DESC);

-- Keep a small token window per node so concurrent /verify responses cannot
-- leave the browser holding a token invalidated by response reordering.
CREATE TABLE IF NOT EXISTS capture_agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE CASCADE,
  auth_code_id UUID NOT NULL REFERENCES auth_codes(id) ON DELETE CASCADE,
  auth_binding_id UUID NOT NULL REFERENCES auth_bindings(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capture_agent_tokens_agent_created
  ON capture_agent_tokens (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS capture_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin_agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  assigned_agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  client_task_id TEXT NOT NULL DEFAULT '',
  control_task_id TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'capture',
  feature_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'extension',
  trigger_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'waiting_device', 'claimed', 'running', 'recovering',
      'interrupted', 'resume_requested', 'needs_action', 'completed',
      'completed_with_warnings', 'completed_with_failures', 'failed',
      'canceled', 'skipped', 'superseded'
    )),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT NOT NULL DEFAULT '',
  attempt_number INTEGER NOT NULL DEFAULT 0,
  progress_seq INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TIMESTAMPTZ,
  business_progress_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_tasks_agent_client_task
  ON capture_tasks (tenant_id, origin_agent_id, client_task_id)
  WHERE client_task_id <> '';
CREATE INDEX IF NOT EXISTS idx_capture_tasks_tenant_status_updated
  ON capture_tasks (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_tasks_agent_updated
  ON capture_tasks (assigned_agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS capture_task_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE RESTRICT,
  client_attempt_id TEXT NOT NULL DEFAULT '',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN (
      'claimed', 'running', 'recovering', 'completed',
      'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'interrupted'
    )),
  progress_seq INTEGER NOT NULL DEFAULT 0,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TIMESTAMPTZ,
  business_progress_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_capture_task_attempts_task_created
  ON capture_task_attempts (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_task_attempts_agent_heartbeat
  ON capture_task_attempts (agent_id, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS capture_task_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  item_type TEXT NOT NULL DEFAULT 'record',
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL DEFAULT '',
  url_snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  result_observation_id UUID REFERENCES record_observations(id) ON DELETE SET NULL,
  error JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_capture_task_items_task_status
  ON capture_task_items (task_id, status, created_at);

CREATE TABLE IF NOT EXISTS capture_task_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES capture_task_attempts(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capture_task_events_task_created
  ON capture_task_events (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS capture_agent_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('resume', 'stop')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'completed', 'failed', 'expired')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT NOT NULL DEFAULT '',
  acknowledged_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capture_agent_commands_agent_pending
  ON capture_agent_commands (agent_id, status, created_at)
  WHERE status IN ('pending', 'acknowledged');

CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_agent_commands_active
  ON capture_agent_commands (task_id, agent_id, command_type)
  WHERE status IN ('pending', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_capture_agent_commands_tenant_expires
  ON capture_agent_commands (tenant_id, expires_at)
  WHERE status IN ('pending', 'acknowledged');
