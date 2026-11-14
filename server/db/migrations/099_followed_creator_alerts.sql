ALTER TABLE monitor_subscriptions
  ADD COLUMN creator_label text,
  ADD COLUMN account_no text,
  ADD COLUMN match_nicknames text[],
  ADD COLUMN alert_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_patrol_enabled boolean NOT NULL DEFAULT false;

UPDATE monitor_subscriptions SET auto_patrol_enabled = (status = 'active' AND COALESCE(account_url, '') <> '')
WHERE subject_type = 'creator';

CREATE UNIQUE INDEX monitor_creator_platform_identity
  ON monitor_subscriptions (tenant_id, platform, keyword)
  WHERE subject_type = 'creator' AND status <> 'deleted'
    AND platform IN ('douyin', 'xiaohongshu', 'weibo');

-- match_nicknames is written in normalized form by the roster API.
CREATE UNIQUE INDEX monitor_creator_channel_identity
  ON monitor_subscriptions (tenant_id, platform, (match_nicknames[1]))
  WHERE subject_type = 'creator' AND status <> 'deleted'
    AND platform = 'wechat_channels';

ALTER TABLE records ADD COLUMN followed_creator_subscription_id uuid
  REFERENCES monitor_subscriptions(id) ON DELETE SET NULL;
CREATE INDEX records_followed_creator ON records (tenant_id, followed_creator_subscription_id)
  WHERE followed_creator_subscription_id IS NOT NULL;

CREATE TABLE followed_creator_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id uuid REFERENCES records(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','ambiguous','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  channel text,
  target_key text,
  payload jsonb NOT NULL DEFAULT '{}',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, record_id)
);
CREATE INDEX followed_creator_alerts_due ON followed_creator_alerts (next_attempt_at)
  WHERE status IN ('pending','sending');

CREATE TABLE followed_creator_backfills (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  cursor_time timestamptz,
  cursor_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now()
);
