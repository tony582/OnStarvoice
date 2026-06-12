CREATE TABLE IF NOT EXISTS comment_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES record_comments(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  lead_type TEXT NOT NULL DEFAULT 'other' CHECK (lead_type IN (
    'complaint', 'renewal_billing', 'app_issue', 'service_quality',
    'safety_privacy', 'brand_risk', 'other'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'following', 'resolved', 'ignored')),
  record_title TEXT NOT NULL DEFAULT '',
  record_url TEXT NOT NULL DEFAULT '',
  comment_author_name TEXT NOT NULL DEFAULT '',
  comment_author_id TEXT NOT NULL DEFAULT '',
  comment_ip_location TEXT NOT NULL DEFAULT '',
  comment_content TEXT NOT NULL DEFAULT '',
  comment_like_count INTEGER NOT NULL DEFAULT 0,
  matched_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL DEFAULT '',
  ai_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_leads_tenant_status
  ON comment_leads (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_leads_tenant_priority
  ON comment_leads (tenant_id, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_leads_tenant_platform
  ON comment_leads (tenant_id, platform, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_leads_record
  ON comment_leads (record_id, captured_at DESC);

INSERT INTO comment_leads (
  tenant_id, record_id, comment_id, platform, lead_type, priority, status,
  record_title, record_url, comment_author_name, comment_author_id,
  comment_ip_location, comment_content, comment_like_count,
  matched_keywords, reason, ai_result, captured_at, created_at, updated_at
)
SELECT
  rc.tenant_id,
  rc.record_id,
  rc.id,
  rc.platform,
  CASE
    WHEN rc.category IN ('safety_rescue', 'privacy') THEN 'safety_privacy'
    WHEN rc.category = 'app_issue' THEN 'app_issue'
    WHEN rc.category = 'renewal_billing' THEN 'renewal_billing'
    WHEN rc.category = 'service_quality' THEN 'service_quality'
    WHEN rc.category = 'brand_image' THEN 'brand_risk'
    WHEN rc.content ~ '(投诉|维权|差评)' THEN 'complaint'
    ELSE 'other'
  END,
  CASE
    WHEN rc.risk_level IN ('critical', 'high') THEN 'urgent'
    WHEN rc.risk_level = 'medium' THEN 'high'
    WHEN rc.like_count >= 20 THEN 'high'
    WHEN rc.risk_level = 'low' THEN 'normal'
    ELSE 'low'
  END,
  'new',
  COALESCE(NULLIF(r.title, ''), LEFT(r.content, 80), ''),
  r.url,
  rc.author_name,
  rc.author_id,
  rc.ip_location,
  rc.content,
  rc.like_count,
  CASE
    WHEN r.keyword <> '' THEN jsonb_build_array(r.keyword)
    ELSE '[]'::jsonb
  END,
  COALESCE(NULLIF(rc.ai_summary, ''), rc.ai_result->>'reason', '评论存在舆情跟进价值'),
  rc.ai_result,
  rc.last_seen_at,
  now(),
  now()
FROM record_comments rc
JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
WHERE rc.is_official = false
  AND (
    rc.is_negative = true
    OR rc.sentiment = 'negative'
    OR rc.risk_level IN ('low', 'medium', 'high', 'critical')
  )
ON CONFLICT (tenant_id, comment_id) DO NOTHING;
