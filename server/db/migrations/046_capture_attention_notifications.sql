-- Durable outbox for task-center notifications that require a human to
-- complete a platform safety verification. Heartbeats only enqueue rows;
-- external delivery happens after the heartbeat transaction commits.
CREATE TABLE IF NOT EXISTS capture_attention_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_number >= 0),
  notification_type TEXT NOT NULL DEFAULT 'security_verification'
    CHECK (notification_type IN ('security_verification')),
  event_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'retry_wait',
      'sent', 'blocked_config', 'failed'
    )),
  recipient TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token UUID,
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_capture_attention_notifications_due
  ON capture_attention_notifications (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_capture_attention_notifications_task
  ON capture_attention_notifications (task_id, created_at DESC);
