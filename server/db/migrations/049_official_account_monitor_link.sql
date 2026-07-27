ALTER TABLE official_accounts
  ADD COLUMN IF NOT EXISTS platform_user_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_no TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS uniq_official_accounts_tenant_platform_id;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_accounts_tenant_platform_id
  ON official_accounts (tenant_id, platform, account_id)
  WHERE account_id <> '' AND status <> 'deleted';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_accounts_tenant_platform_user_id
  ON official_accounts (tenant_id, platform, platform_user_id)
  WHERE platform_user_id <> '' AND status <> 'deleted';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_accounts_tenant_platform_account_no
  ON official_accounts (tenant_id, platform, account_no)
  WHERE account_no <> '' AND status <> 'deleted';

ALTER TABLE monitor_subscriptions
  ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'creator',
  ADD COLUMN IF NOT EXISTS official_account_id UUID
    REFERENCES official_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID
    REFERENCES capture_agents(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'monitor_subscriptions_subject_type_check'
      AND conrelid = 'monitor_subscriptions'::regclass
  ) THEN
    ALTER TABLE monitor_subscriptions
      ADD CONSTRAINT monitor_subscriptions_subject_type_check
      CHECK (subject_type IN ('creator', 'official'));
  END IF;
END
$$;

UPDATE monitor_subscriptions
SET subject_type = 'official',
  updated_at = now()
WHERE official_account_id IS NOT NULL
  AND subject_type <> 'official';

-- Link legacy official subscriptions only by the stable profile URL. Name
-- matching is deliberately excluded because different accounts can share a
-- display name.
WITH exact_profile_matches AS (
  SELECT DISTINCT ON (subscription.id)
    subscription.id AS subscription_id,
    account.id AS official_account_id
  FROM monitor_subscriptions subscription
  JOIN official_accounts account
    ON account.tenant_id = subscription.tenant_id
    AND account.platform = subscription.platform
    AND account.status <> 'deleted'
    AND account.profile_url <> ''
    AND account.profile_url = subscription.account_url
  WHERE subscription.subject_type = 'official'
    AND subscription.official_account_id IS NULL
  ORDER BY subscription.id, account.created_at, account.id
)
UPDATE monitor_subscriptions subscription
SET official_account_id = matched.official_account_id,
  updated_at = now()
FROM exact_profile_matches matched
WHERE subscription.id = matched.subscription_id;

-- Older official-account management saved only official_accounts. Materialize
-- the missing discovery subscription so those accounts appear in the dispatch
-- workflow without requiring the customer to register them again.
INSERT INTO monitor_subscriptions (
  tenant_id, name, keyword, platform, account_url, cadence_minutes,
  status, notify_on_negative, auth_code, next_run_at, subject_type,
  official_account_id
)
SELECT
  account.tenant_id,
  account.account_name,
  COALESCE(
    NULLIF(account.platform_user_id, ''),
    NULLIF(account.account_no, ''),
    NULLIF(account.account_id, ''),
    account.profile_url
  ),
  account.platform,
  account.profile_url,
  1440,
  CASE WHEN account.status = 'active' THEN 'active' ELSE 'paused' END,
  true,
  '',
  CASE WHEN account.status = 'active' THEN now() ELSE NULL END,
  'official',
  account.id
FROM official_accounts account
WHERE account.status <> 'deleted'
  AND account.profile_url <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM monitor_subscriptions subscription
    WHERE subscription.tenant_id = account.tenant_id
      AND subscription.platform = account.platform
      AND subscription.subject_type = 'official'
      AND subscription.status <> 'deleted'
      AND (
        subscription.official_account_id = account.id
        OR subscription.account_url = account.profile_url
      )
  );

-- Once an exact profile URL has an official discovery subscription, stop the
-- old creator scheduler from scanning the same account twice. Historical
-- executions stay linked to the creator subscription.
UPDATE monitor_subscriptions creator
SET status = 'paused',
  last_error = '',
  updated_at = now()
FROM official_accounts account
WHERE creator.tenant_id = account.tenant_id
  AND creator.platform = account.platform
  AND creator.subject_type = 'creator'
  AND creator.status = 'active'
  AND account.status <> 'deleted'
  AND account.profile_url <> ''
  AND creator.account_url = account.profile_url
  AND EXISTS (
    SELECT 1
    FROM monitor_subscriptions official
    WHERE official.tenant_id = account.tenant_id
      AND official.platform = account.platform
      AND official.subject_type = 'official'
      AND official.status <> 'deleted'
      AND (
        official.official_account_id = account.id
        OR official.account_url = account.profile_url
      )
  );

CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_tenant_subject
  ON monitor_subscriptions (tenant_id, subject_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_official_account
  ON monitor_subscriptions (official_account_id)
  WHERE official_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_assigned_agent
  ON monitor_subscriptions (assigned_agent_id, status, next_run_at)
  WHERE assigned_agent_id IS NOT NULL;

-- Old polling could create more than one pending execution. Settle redundant
-- rows before enforcing the invariant used by both manual and cron dispatch.
WITH ranked_active AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY subscription_id
      ORDER BY
        CASE WHEN status = 'running' THEN 0 ELSE 1 END,
        created_at,
        id
    ) AS active_rank
  FROM monitor_executions
  WHERE status IN ('pending', 'running')
)
UPDATE monitor_executions execution
SET status = 'cancelled',
  error_message = '重复待执行记录已由调度迁移合并',
  finished_at = COALESCE(execution.finished_at, now()),
  updated_at = now()
FROM ranked_active ranked
WHERE execution.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_monitor_executions_subscription_active
  ON monitor_executions (subscription_id)
  WHERE status IN ('pending', 'running');
