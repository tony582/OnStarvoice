ALTER TABLE monitor_subscriptions
  ADD COLUMN patrol_retry_count smallint NOT NULL DEFAULT 0
    CHECK (patrol_retry_count BETWEEN 0 AND 2);

ALTER TABLE monitor_executions
  ADD COLUMN schedule_projected_at timestamptz;
