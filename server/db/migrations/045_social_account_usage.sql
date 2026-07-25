CREATE TABLE IF NOT EXISTS social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL
    CHECK (platform IN ('xiaohongshu', 'douyin', 'weibo')),
  platform_account_id TEXT NOT NULL DEFAULT '',
  account_handle TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  registered_phone TEXT NOT NULL DEFAULT '',
  identity_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (identity_source IN ('manual', 'extension', 'placeholder')),
  health_status TEXT NOT NULL DEFAULT 'active'
    CHECK (health_status IN (
      'active', 'resting', 'risk', 'login_required', 'disabled', 'unknown'
    )),
  rest_until TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  daily_search_limit INTEGER NOT NULL DEFAULT 0
    CHECK (daily_search_limit >= 0),
  daily_enhancement_limit INTEGER NOT NULL DEFAULT 0
    CHECK (daily_enhancement_limit >= 0),
  daily_capture_limit INTEGER NOT NULL DEFAULT 0
    CHECK (daily_capture_limit >= 0),
  last_seen_at TIMESTAMPTZ,
  last_agent_id UUID REFERENCES capture_agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_social_accounts_platform_id
  ON social_accounts (tenant_id, platform, platform_account_id)
  WHERE platform_account_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_social_accounts_platform_handle
  ON social_accounts (tenant_id, platform, lower(account_handle))
  WHERE account_handle <> '';

CREATE INDEX IF NOT EXISTS idx_social_accounts_tenant_status
  ON social_accounts (tenant_id, health_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS social_account_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  social_account_id UUID NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('xiaohongshu', 'douyin', 'weibo')),
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'historical')),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'extension', 'placeholder')),
  last_login_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (last_login_state IN ('authenticated', 'logged_out', 'unknown')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, tenant_id)
    REFERENCES capture_agents (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (social_account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_social_account_current_agent_platform
  ON social_account_bindings (tenant_id, agent_id, platform)
  WHERE status = 'current';

CREATE INDEX IF NOT EXISTS idx_social_account_bindings_account_history
  ON social_account_bindings (
    tenant_id, social_account_id, first_seen_at DESC
  );

CREATE TABLE IF NOT EXISTS social_account_usage_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  social_account_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('xiaohongshu', 'douyin', 'weibo')),
  searches INTEGER NOT NULL DEFAULT 0 CHECK (searches >= 0),
  enhancements INTEGER NOT NULL DEFAULT 0 CHECK (enhancements >= 0),
  capture_runs INTEGER NOT NULL DEFAULT 0 CHECK (capture_runs >= 0),
  captured_items INTEGER NOT NULL DEFAULT 0 CHECK (captured_items >= 0),
  succeeded BOOLEAN NOT NULL DEFAULT true,
  occurred_at TIMESTAMPTZ NOT NULL,
  usage_date DATE NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, tenant_id)
    REFERENCES capture_agents (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (social_account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_social_account_usage_events_account_date
  ON social_account_usage_events (
    tenant_id, social_account_id, usage_date DESC, occurred_at DESC
  );

CREATE TABLE IF NOT EXISTS social_account_daily_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  social_account_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('xiaohongshu', 'douyin', 'weibo')),
  usage_date DATE NOT NULL,
  searches INTEGER NOT NULL DEFAULT 0 CHECK (searches >= 0),
  enhancements INTEGER NOT NULL DEFAULT 0 CHECK (enhancements >= 0),
  capture_runs INTEGER NOT NULL DEFAULT 0 CHECK (capture_runs >= 0),
  captured_items INTEGER NOT NULL DEFAULT 0 CHECK (captured_items >= 0),
  failed_events INTEGER NOT NULL DEFAULT 0 CHECK (failed_events >= 0),
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id, social_account_id, agent_id, usage_date
  ),
  FOREIGN KEY (agent_id, tenant_id)
    REFERENCES capture_agents (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (social_account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_social_account_daily_usage_tenant_date
  ON social_account_daily_usage (tenant_id, usage_date DESC);
