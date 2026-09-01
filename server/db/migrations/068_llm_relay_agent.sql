-- Tenant-scoped AI relay used only by the outbound Antigravity agent.
-- This deliberately does not reuse capture agents or capture task tables.

CREATE TABLE IF NOT EXISTS llm_relay_agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '本机 Antigravity',
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_llm_relay_agent_tokens_tenant_active
  ON llm_relay_agent_tokens (tenant_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS llm_relay_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'canceled')),
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  user_message TEXT NOT NULL DEFAULT '',
  request_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  agent_token_id UUID REFERENCES llm_relay_agent_tokens(id) ON DELETE SET NULL,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  expires_at TIMESTAMPTZ NOT NULL,
  leased_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(model) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_llm_relay_jobs_claim
  ON llm_relay_jobs (tenant_id, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_llm_relay_jobs_lease
  ON llm_relay_jobs (lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS idx_llm_relay_jobs_retention
  ON llm_relay_jobs (completed_at, created_at)
  WHERE status IN ('succeeded', 'failed', 'canceled');

INSERT INTO tenant_settings (tenant_id, key, value)
SELECT tenant.id, defaults.key, defaults.value
FROM tenants tenant
CROSS JOIN (VALUES
  ('llm_relay_mode', 'off'),
  ('llm_relay_model', 'gemini-3.7-flash-low')
) AS defaults(key, value)
ON CONFLICT (tenant_id, key) DO NOTHING;

COMMENT ON TABLE llm_relay_agent_tokens IS
  'Independent outbound AI-agent credentials; never valid for capture task APIs.';
COMMENT ON TABLE llm_relay_jobs IS
  'Short-lived AI prompt jobs. Prompt fields are cleared when a job reaches a terminal state.';
