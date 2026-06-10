CREATE TABLE IF NOT EXISTS official_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  profile_url TEXT NOT NULL DEFAULT '',
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  skip_content BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_official_accounts_tenant_platform
  ON official_accounts (tenant_id, platform, status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_accounts_tenant_platform_id
  ON official_accounts (tenant_id, platform, account_id)
  WHERE account_id <> '';

INSERT INTO official_accounts (tenant_id, platform, account_name, aliases)
SELECT t.id, p.platform, '安吉星OnStar', '["安吉星OnStar", "安吉星", "OnStar"]'::jsonb
FROM tenants t
CROSS JOIN (VALUES ('xiaohongshu'), ('weibo'), ('douyin')) AS p(platform)
WHERE NOT EXISTS (
  SELECT 1 FROM official_accounts oa
  WHERE oa.tenant_id = t.id
    AND oa.platform = p.platform
    AND oa.account_name = '安吉星OnStar'
);

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS official_replied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS official_response_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS negative_comment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_negative_comment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_risk_reopened_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_records_tenant_official_response
  ON records (tenant_id, official_response_status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_tenant_negative_comments
  ON records (tenant_id, negative_comment_count DESC, latest_negative_comment_at DESC);

CREATE TABLE IF NOT EXISTS record_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  external_comment_id TEXT NOT NULL DEFAULT '',
  parent_comment_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  author_avatar TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT '',
  ip_location TEXT NOT NULL DEFAULT '',
  floor_index INTEGER,
  is_official BOOLEAN NOT NULL DEFAULT false,
  is_negative BOOLEAN NOT NULL DEFAULT false,
  sentiment TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'none' CHECK (risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_record_comments_external
  ON record_comments (tenant_id, record_id, external_comment_id)
  WHERE external_comment_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_record_comments_hash
  ON record_comments (tenant_id, record_id, content_hash)
  WHERE content_hash <> '';
CREATE INDEX IF NOT EXISTS idx_record_comments_record_created
  ON record_comments (record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_comments_tenant_risk
  ON record_comments (tenant_id, is_negative, risk_level, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS official_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES record_comments(id) ON DELETE SET NULL,
  official_account_id UUID REFERENCES official_accounts(id) ON DELETE SET NULL,
  platform TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_responses_hash
  ON official_responses (tenant_id, record_id, content_hash)
  WHERE content_hash <> '';
CREATE INDEX IF NOT EXISTS idx_official_responses_record_created
  ON official_responses (record_id, created_at DESC);

ALTER TABLE record_triage DROP CONSTRAINT IF EXISTS record_triage_status_check;
ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_status_check
  CHECK (status IN ('unhandled', 'reviewing', 'issue_linked', 'official_responded', 'archived', 'false_positive'));
