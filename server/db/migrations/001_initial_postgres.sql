CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'trial' CHECK (type IN ('trial', 'annual', 'permanent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'frozen')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  max_bindings INTEGER NOT NULL DEFAULT 3,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS auth_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES auth_codes(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  record_type TEXT NOT NULL DEFAULT 'single_note',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  author_avatar TEXT NOT NULL DEFAULT '',
  author_fans INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  note_type TEXT NOT NULL DEFAULT '',
  likes INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  publish_time TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  blogger_profile_url TEXT NOT NULL DEFAULT '',
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  comments_text TEXT NOT NULL DEFAULT '',
  blogger_liked_collected INTEGER NOT NULL DEFAULT 0,
  blogger_account_type TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  audio_url TEXT NOT NULL DEFAULT '',
  video_duration TEXT NOT NULL DEFAULT '',
  comments_capture_status TEXT NOT NULL DEFAULT '',
  comments_total_captured INTEGER NOT NULL DEFAULT 0,
  capture_timestamp TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  sentiment TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  subcategory TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_confidence REAL NOT NULL DEFAULT 0,
  ai_labeled_at TIMESTAMPTZ,
  auth_code TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  latest_observation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_records_external_id
  ON records (tenant_id, platform, external_id)
  WHERE external_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_records_content_hash
  ON records (tenant_id, platform, content_hash)
  WHERE content_hash <> '';

CREATE INDEX IF NOT EXISTS idx_records_tenant_platform_created ON records (tenant_id, platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_tenant_sentiment_created ON records (tenant_id, sentiment, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_tenant_category_created ON records (tenant_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_tenant_last_seen ON records (tenant_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_tenant_keyword ON records (tenant_id, keyword);
CREATE INDEX IF NOT EXISTS idx_records_payload_gin ON records USING GIN (payload);
CREATE INDEX IF NOT EXISTS idx_records_ai_result_gin ON records USING GIN (ai_result);

CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  account_url TEXT NOT NULL DEFAULT '',
  cadence_minutes INTEGER NOT NULL DEFAULT 1440,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  notify_on_negative BOOLEAN NOT NULL DEFAULT true,
  auth_code TEXT NOT NULL DEFAULT '',
  last_cursor TEXT NOT NULL DEFAULT '',
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_due
  ON monitor_subscriptions (tenant_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS monitor_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES monitor_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  records_found INTEGER NOT NULL DEFAULT 0,
  new_records INTEGER NOT NULL DEFAULT 0,
  updated_records INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitor_executions_tenant_created
  ON monitor_executions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS record_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  monitor_execution_id UUID REFERENCES monitor_executions(id) ON DELETE SET NULL,
  source_auth_code TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  keyword TEXT NOT NULL DEFAULT '',
  rank_position INTEGER,
  likes INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  interaction_total INTEGER GENERATED ALWAYS AS (likes + comments_count + collects + shares) STORED,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_observations_record_captured
  ON record_observations (record_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_tenant_captured
  ON record_observations (tenant_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS record_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  before_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_record_versions_record_created
  ON record_versions (record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triage', 'in_progress', 'waiting', 'review', 'resolved', 'closed', 'ignored')),
  owner_name TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  cluster_key TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL DEFAULT '',
  primary_record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cluster_key)
);

CREATE INDEX IF NOT EXISTS idx_issues_tenant_status ON issues (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_tenant_severity ON issues (tenant_id, severity, updated_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('critical', 'warning', 'info')),
  reason TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  interaction_total INTEGER NOT NULL DEFAULT 0,
  notified BOOLEAN NOT NULL DEFAULT false,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_level ON alerts (tenant_id, level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_created ON alerts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_records_record ON issue_records (record_id);

CREATE TABLE IF NOT EXISTS issue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_name TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issue_events_issue_created ON issue_events (issue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'generated', 'sent', 'skipped', 'failed')),
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  generated_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, report_type, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_report_runs_tenant_type_period
  ON report_runs (tenant_id, report_type, period_start DESC);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_run_id UUID NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_data_gin ON report_snapshots USING GIN (data);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at DESC);

WITH default_tenant AS (
  INSERT INTO tenants (name)
  VALUES ('OnStar')
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id
)
INSERT INTO tenant_settings (tenant_id, key, value)
SELECT default_tenant.id, defaults.key, defaults.value
FROM default_tenant
CROSS JOIN (VALUES
  ('llm_provider', 'gemini'),
  ('llm_api_key', ''),
  ('llm_model', 'gemini-2.0-flash'),
  ('llm_api_endpoint', ''),
  ('smtp_host', ''),
  ('smtp_port', '465'),
  ('smtp_secure', 'true'),
  ('smtp_user', ''),
  ('smtp_pass', ''),
  ('email_from', ''),
  ('email_to', ''),
  ('alert_high_interaction_threshold', '500'),
  ('alert_negative_burst_count', '5'),
  ('alert_negative_burst_window_minutes', '60'),
  ('alert_high_danger_keywords', '安全,隐私,泄露,事故,召回,起火,失控,刹车失灵'),
  ('feishu_app_token', ''),
  ('feishu_table_id', ''),
  ('feishu_webhook_url', ''),
  ('report_daily_enabled', 'true'),
  ('report_daily_time', '09:00'),
  ('report_weekly_enabled', 'true'),
  ('report_weekly_day', '1'),
  ('report_weekly_time', '09:00'),
  ('report_monthly_enabled', 'true'),
  ('report_monthly_day', '1'),
  ('report_monthly_time', '09:00')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;
