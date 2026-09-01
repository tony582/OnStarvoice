-- Guarded action layer for the deterministic operations control plane.
--
-- Observation remains the default. Business actions require all three gates:
-- the global environment switch, tenant guarded mode, and an explicit action
-- allowlist. Every attempted mutation receives an idempotent durable ledger row
-- and must be verified by a later observation.

ALTER TABLE ops_control_system_state
  DROP CONSTRAINT IF EXISTS ops_control_system_state_mode_check;
ALTER TABLE ops_control_system_state
  ADD CONSTRAINT ops_control_system_state_mode_check
  CHECK (mode IN ('observe', 'guarded'));

ALTER TABLE ops_control_runs
  DROP CONSTRAINT IF EXISTS ops_control_runs_mode_check;
ALTER TABLE ops_control_runs
  ADD CONSTRAINT ops_control_runs_mode_check
  CHECK (mode IN ('observe', 'guarded'));

CREATE TABLE IF NOT EXISTS ops_control_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ops_control_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id UUID REFERENCES ops_control_incidents(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL
    CHECK (action_type IN (
      'capture_retry',
      'schedule_materialize',
      'command_reconcile',
      'elastic_requeue'
    )),
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN (
      'claimed', 'pending_verification', 'verified',
      'skipped', 'blocked', 'failed'
    )),
  attempt_number INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_number >= 1 AND attempt_number <= 5),
  idempotency_key TEXT NOT NULL
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  policy_version TEXT NOT NULL DEFAULT 'ops-guarded-v1',
  snapshot_before_sequence INTEGER NOT NULL CHECK (snapshot_before_sequence > 0),
  snapshot_after_sequence INTEGER,
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT NOT NULL DEFAULT '',
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,
  verification_due_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_control_actions_run_status
  ON ops_control_actions (run_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_control_actions_pending_verification
  ON ops_control_actions (verification_due_at, tenant_id, created_at)
  WHERE status = 'pending_verification';

INSERT INTO tenant_settings (tenant_id, key, value)
SELECT tenant.id, defaults.key, defaults.value
FROM tenants tenant
CROSS JOIN (VALUES
  ('ops_control_action_allowlist', ''),
  ('ops_control_action_max_per_run', '3'),
  ('ops_control_action_max_attempts', '2'),
  ('ops_control_action_cooldown_seconds', '300'),
  ('ops_control_action_verification_seconds', '900')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;
