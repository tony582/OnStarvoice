-- Keep the short bootstrap-congestion lookback bounded as attempt history grows.
-- The partial index covers only terminal technical outcomes considered by the
-- elastic dispatcher; error-code filtering remains a small two-minute scan.

CREATE INDEX IF NOT EXISTS idx_capture_task_item_attempts_tenant_failure_recent
  ON capture_task_item_attempts (tenant_id, updated_at DESC)
  WHERE status IN ('retryable', 'needs_action', 'failed');
