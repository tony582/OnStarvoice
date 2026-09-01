-- Durable immediate-alert delivery for incidents that cannot currently be
-- handled by a guarded action. Alerts reuse the tenant's operations digest
-- recipient, and stay separate from capture business state.

ALTER TABLE ops_control_incidents
  ADD COLUMN IF NOT EXISTS alert_delivery_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (alert_delivery_status IN (
      'ready', 'sending', 'sent', 'retry_wait',
      'blocked_config', 'failed', 'skipped'
    )),
  ADD COLUMN IF NOT EXISTS alert_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (alert_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS alert_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS alert_recipient TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alert_message_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alert_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alert_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alert_last_error TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ops_control_incidents_alert_delivery
  ON ops_control_incidents (
    tenant_id, alert_delivery_status, alert_next_attempt_at, first_seen_at
  )
  WHERE status = 'open'
    AND alert_delivery_status IN (
      'ready', 'retry_wait', 'blocked_config', 'failed'
    );
