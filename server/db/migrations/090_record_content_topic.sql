-- Additive field: no history relabel, relevance or triage-status rewrite.
ALTER TABLE records ADD COLUMN IF NOT EXISTS content_topic TEXT;
ALTER TABLE records ADD CONSTRAINT records_content_topic_check CHECK (
  content_topic IS NULL OR content_topic IN (
    'onstar', 'infotainment', 'wallpaper', 'brand_app', 'sentry',
    'gm_customer_service', 'gm_other'
  )
);
CREATE INDEX IF NOT EXISTS idx_records_tenant_content_topic
  ON records (tenant_id, content_topic);
