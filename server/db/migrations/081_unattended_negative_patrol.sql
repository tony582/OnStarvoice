-- One rotation cursor per tenant/platform/post, shared by every unattended plan.
-- A reservation has no time-based expiry: offline work needs explicit terminal
-- evidence before another execution can own the same post.
CREATE TABLE IF NOT EXISTS unattended_negative_patrol_state (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu', 'douyin')),
  external_id TEXT NOT NULL,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  first_eligible_at TIMESTAMPTZ NOT NULL,
  last_eligible_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_success_item_id UUID,
  last_result_observation_id UUID REFERENCES record_observations(id) ON DELETE SET NULL,
  next_due_date DATE,
  cadence_days INTEGER NOT NULL DEFAULT 1 CHECK (cadence_days IN (1, 3, 7)),
  stable_success_count INTEGER NOT NULL DEFAULT 0 CHECK (stable_success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_failure_item_id UUID,
  last_failure_execution_task_id UUID,
  cooldown_until TIMESTAMPTZ,
  needs_action BOOLEAN NOT NULL DEFAULT false,
  lease_item_id UUID,
  lease_execution_task_id UUID,
  lease_assignment_revision INTEGER,
  lease_started_at TIMESTAMPTZ,
  last_withdrawal_reason TEXT NOT NULL DEFAULT '',
  last_withdrawal_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, platform, external_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES records(tenant_id, id)
    ON DELETE CASCADE,
  CHECK ((lease_item_id IS NULL AND lease_execution_task_id IS NULL
      AND lease_assignment_revision IS NULL AND lease_started_at IS NULL)
    OR (lease_item_id IS NOT NULL AND lease_execution_task_id IS NOT NULL
      AND lease_assignment_revision > 0 AND lease_started_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_unattended_negative_patrol_rotation
  ON unattended_negative_patrol_state
    (tenant_id, platform, next_due_date, last_success_at, first_eligible_at);
CREATE INDEX IF NOT EXISTS idx_unattended_negative_patrol_lease
  ON unattended_negative_patrol_state (tenant_id, lease_execution_task_id)
  WHERE lease_execution_task_id IS NOT NULL;

COMMENT ON TABLE unattended_negative_patrol_state IS
  'Rotation evidence only; never changes human triage, archive or watch state';
