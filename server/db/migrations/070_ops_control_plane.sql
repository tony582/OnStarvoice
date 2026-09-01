-- Deterministic, observe-only operations control plane.
--
-- This slice records its own observations, conclusions and delivery audit. It
-- deliberately has no foreign key or write path that can mutate capture task,
-- item, attempt, command, record or AI queue state.

CREATE TABLE IF NOT EXISTS ops_control_system_state (
  component TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'running', 'healthy', 'degraded', 'failed')),
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK (mode IN ('observe')),
  cycle_sequence BIGINT NOT NULL DEFAULT 0 CHECK (cycle_sequence >= 0),
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_control_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK (mode IN ('observe')),
  lifecycle_status TEXT NOT NULL DEFAULT 'observing'
    CHECK (lifecycle_status IN ('observing', 'progressing', 'recovering', 'settled')),
  verdict TEXT NOT NULL DEFAULT 'pending'
    CHECK (verdict IN ('pending', 'healthy', 'degraded', 'blocked_manual', 'incident')),
  policy_version TEXT NOT NULL DEFAULT 'ops-observe-v1',
  runtime_baseline_version TEXT NOT NULL DEFAULT '0.3.91',
  expected_schedule_ids UUID[] NOT NULL DEFAULT '{}',
  expected_occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_occurrence_count >= 0),
  observed_occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_occurrence_count >= 0),
  snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_snapshot_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service_date),
  CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_ops_control_runs_tenant_updated
  ON ops_control_runs (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_control_runs_unsettled
  ON ops_control_runs (updated_at, tenant_id)
  WHERE lifecycle_status <> 'settled';

CREATE TABLE IF NOT EXISTS ops_control_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES ops_control_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_ops_control_snapshots_run_captured
  ON ops_control_snapshots (run_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ops_control_snapshots_tenant_captured
  ON ops_control_snapshots (tenant_id, captured_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ops_control_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ops_control_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'monitoring', 'resolved')),
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_ops_control_incidents_tenant_status
  ON ops_control_incidents (tenant_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ops_control_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ops_control_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  verdict TEXT NOT NULL
    CHECK (verdict IN ('pending', 'healthy', 'degraded', 'blocked_manual', 'incident')),
  subject TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (delivery_status IN (
      'ready', 'sending', 'sent', 'retry_wait',
      'blocked_config', 'failed', 'skipped'
    )),
  recipient TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service_date)
);

CREATE INDEX IF NOT EXISTS idx_ops_control_digests_delivery
  ON ops_control_digests (delivery_status, next_attempt_at, created_at)
  WHERE delivery_status IN ('ready', 'retry_wait');

-- Safe rollout defaults. The global environment switch and this tenant switch
-- must both permit observation. Email delivery has a separate opt-in.
INSERT INTO tenant_settings (tenant_id, key, value)
SELECT tenant.id, defaults.key, defaults.value
FROM tenants tenant
CROSS JOIN (VALUES
  ('ops_control_enabled', 'false'),
  ('ops_control_mode', 'observe'),
  ('ops_control_window_start', '05:30'),
  ('ops_control_window_end', '08:30'),
  ('ops_control_digest_time', '08:35'),
  ('ops_control_snapshot_gap_seconds', '25'),
  ('ops_control_stale_after_seconds', '300'),
  ('ops_control_ai_stale_after_seconds', '1200'),
  ('ops_control_digest_email_enabled', 'false'),
  ('ops_control_digest_email_to', '')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;
