-- Agent-first social-platform workload and safety health.
--
-- Usage is owned by the Agent that executed it, whether or not a social
-- account has been identified or manually attached.  Account rows and
-- bindings remain optional descriptive information and historical evidence.

ALTER TABLE social_account_usage_events
  ALTER COLUMN social_account_id DROP NOT NULL;

ALTER TABLE social_account_usage_events
  ADD COLUMN IF NOT EXISTS safety_verification BOOLEAN NOT NULL DEFAULT false;

-- Account association is descriptive and operator-controlled. Existing
-- Extension observations remain useful account information, but may no
-- longer replace an Agent's current account association automatically.
ALTER TABLE social_accounts
  ALTER COLUMN agent_binding_mode SET DEFAULT 'manual';

UPDATE social_accounts
SET agent_binding_mode = 'manual',
  updated_at = now()
WHERE agent_binding_mode <> 'manual';

-- Preserve safety signals already present in older event metadata.
UPDATE social_account_usage_events
SET safety_verification = true
WHERE safety_verification = false
  AND COALESCE(metadata::text, '') ~*
    'captcha|security[ _-]+verification|verification[ _-]+required|page[ _-]+challenge|platform[ _-]+safety[ _-]+block|risk[ _-]+control|login[ _-]+required|auth[ _-]+required|logged[ _-]+out|"(platformSafetyBlocked|platform_safety_blocked|securityBlocked|security_blocked|loginRequired|login_required)"[[:space:]]*:[[:space:]]*true|验证码|安全验证|安全限制|访问频繁|访问受限|风控|登录失效';

CREATE TABLE IF NOT EXISTS social_agent_daily_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('xiaohongshu', 'douyin', 'weibo')),
  usage_date DATE NOT NULL,
  searches INTEGER NOT NULL DEFAULT 0 CHECK (searches >= 0),
  enhancements INTEGER NOT NULL DEFAULT 0 CHECK (enhancements >= 0),
  capture_runs INTEGER NOT NULL DEFAULT 0 CHECK (capture_runs >= 0),
  captured_items INTEGER NOT NULL DEFAULT 0 CHECK (captured_items >= 0),
  failed_events INTEGER NOT NULL DEFAULT 0 CHECK (failed_events >= 0),
  safety_verifications INTEGER NOT NULL DEFAULT 0
    CHECK (safety_verifications >= 0),
  last_event_at TIMESTAMPTZ,
  last_safety_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, platform, usage_date),
  FOREIGN KEY (agent_id, tenant_id)
    REFERENCES capture_agents (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_social_agent_daily_usage_tenant_date
  ON social_agent_daily_usage (tenant_id, usage_date DESC, agent_id);

-- Rebuild the Agent/day projection from the append-only event ledger so
-- existing account-scoped history immediately appears in the new view.
INSERT INTO social_agent_daily_usage (
  tenant_id, agent_id, platform, usage_date,
  searches, enhancements, capture_runs, captured_items,
  failed_events, safety_verifications, last_event_at, last_safety_at
)
SELECT
  event.tenant_id,
  event.agent_id,
  event.platform,
  event.usage_date,
  SUM(event.searches)::integer,
  SUM(event.enhancements)::integer,
  SUM(event.capture_runs)::integer,
  SUM(event.captured_items)::integer,
  COUNT(*) FILTER (WHERE event.succeeded = false)::integer,
  COUNT(*) FILTER (WHERE event.safety_verification = true)::integer,
  MAX(event.occurred_at),
  MAX(event.occurred_at) FILTER (WHERE event.safety_verification = true)
FROM social_account_usage_events event
GROUP BY event.tenant_id, event.agent_id, event.platform, event.usage_date
ON CONFLICT (tenant_id, agent_id, platform, usage_date)
DO UPDATE SET
  searches = EXCLUDED.searches,
  enhancements = EXCLUDED.enhancements,
  capture_runs = EXCLUDED.capture_runs,
  captured_items = EXCLUDED.captured_items,
  failed_events = EXCLUDED.failed_events,
  safety_verifications = EXCLUDED.safety_verifications,
  last_event_at = EXCLUDED.last_event_at,
  last_safety_at = EXCLUDED.last_safety_at,
  updated_at = now();

COMMENT ON TABLE social_agent_daily_usage IS
  'Daily Agent workload in Asia/Shanghai; a new date row makes the UI reset at 00:00 without deleting history';

COMMENT ON COLUMN social_account_usage_events.social_account_id IS
  'Optional descriptive account identity; Agent usage persists when no account is bound';

COMMENT ON COLUMN social_accounts.agent_binding_mode IS
  'Account association is optional descriptive information; manual is the default and prevents heartbeat-driven reassignment';
