-- Keep every freshness-accepted browser task snapshot as an append-only audit
-- record. capture_tasks and capture_task_attempts remain the fast current-state
-- projections; this table preserves the progress/checkpoint values they replace.
CREATE TABLE IF NOT EXISTS capture_task_snapshots (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES capture_task_attempts(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  client_task_id TEXT NOT NULL DEFAULT '',
  control_task_id TEXT NOT NULL DEFAULT '',
  client_attempt_id TEXT NOT NULL DEFAULT '',
  attempt_number INTEGER NOT NULL DEFAULT 0,
  progress_seq INTEGER NOT NULL DEFAULT 0,
  task_type TEXT NOT NULL DEFAULT 'capture',
  feature_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'extension',
  trigger_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT NOT NULL DEFAULT '',
  heartbeat_at TIMESTAMPTZ,
  business_progress_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, snapshot_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_capture_task_snapshots_task_source
  ON capture_task_snapshots (task_id, source_updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_capture_task_snapshots_tenant_received
  ON capture_task_snapshots (tenant_id, received_at DESC, id DESC);
