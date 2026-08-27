ALTER TABLE capture_agents
  ADD COLUMN IF NOT EXISTS last_liveness_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_full_heartbeat_at TIMESTAMPTZ;

-- Before this migration last_heartbeat_at represented both the cheap online
-- lease and the full local-state reconciliation. Preserve the latest known
-- value as both kinds of evidence, then let the two routes advance them
-- independently.
UPDATE capture_agents
SET last_liveness_at = COALESCE(last_liveness_at, last_heartbeat_at),
  last_full_heartbeat_at = COALESCE(
    last_full_heartbeat_at,
    last_heartbeat_at
  )
WHERE last_heartbeat_at IS NOT NULL
  AND (
    last_liveness_at IS NULL
    OR last_full_heartbeat_at IS NULL
  );

CREATE INDEX IF NOT EXISTS idx_capture_agents_tenant_liveness
  ON capture_agents (tenant_id, last_liveness_at DESC);

CREATE INDEX IF NOT EXISTS idx_capture_agents_tenant_full_heartbeat
  ON capture_agents (tenant_id, last_full_heartbeat_at DESC);

COMMENT ON COLUMN capture_agents.last_liveness_at IS
  'Latest lightweight Agent liveness lease; does not prove local task state was reconciled.';

COMMENT ON COLUMN capture_agents.last_full_heartbeat_at IS
  'Latest task-state-complete heartbeat; auxiliary health warnings do not invalidate it.';

COMMENT ON COLUMN capture_agents.last_heartbeat_at IS
  'Legacy compatibility alias for last_full_heartbeat_at; liveness requests must not update it.';
