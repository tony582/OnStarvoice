-- Tenant-scoped AI model failover state.
--
-- The configured API key and endpoint remain in tenant_settings. This table
-- stores only model names and health state so automatic switching never copies
-- or exposes credentials.
CREATE TABLE IF NOT EXISTS ai_failover_states (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  route TEXT NOT NULL DEFAULT 'primary'
    CHECK (route IN ('primary', 'backup')),
  primary_model TEXT NOT NULL,
  backup_model TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  failure_window_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_code TEXT NOT NULL DEFAULT '',
  last_failure_status INTEGER,
  last_failure_kind TEXT NOT NULL DEFAULT '',
  backup_since TIMESTAMPTZ,
  next_primary_probe_at TIMESTAMPTZ,
  recovery_probe_successes INTEGER NOT NULL DEFAULT 0
    CHECK (recovery_probe_successes >= 0),
  last_probe_at TIMESTAMPTZ,
  last_probe_succeeded BOOLEAN,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(primary_model) BETWEEN 1 AND 200),
  CHECK (char_length(backup_model) BETWEEN 1 AND 200),
  CHECK (primary_model <> backup_model),
  CHECK (
    last_failure_status IS NULL
    OR last_failure_status BETWEEN 100 AND 599
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_failover_states_recovery_probe
  ON ai_failover_states (next_primary_probe_at)
  WHERE route = 'backup';

-- Safe defaults: no tenant changes behavior until an operator explicitly
-- enables automatic failover. New tenants inherit these settings through the
-- existing default-tenant copy path.
INSERT INTO tenant_settings (tenant_id, key, value)
SELECT tenant.id, defaults.key, defaults.value
FROM tenants tenant
CROSS JOIN (VALUES
  ('llm_failover_enabled', 'false'),
  ('llm_failover_primary_model', ''),
  ('llm_failover_backup_model', 'deepseek-v4-pro'),
  ('llm_failover_failure_threshold', '3'),
  ('llm_failover_window_seconds', '120'),
  ('llm_failover_pending_threshold', '1'),
  ('llm_failover_recovery_probe_seconds', '300'),
  ('llm_failover_recovery_success_threshold', '2')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;
