ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS agent_binding_mode TEXT NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  ALTER TABLE social_accounts
    ADD CONSTRAINT social_accounts_agent_binding_mode_check
    CHECK (agent_binding_mode IN ('auto', 'manual'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

COMMENT ON COLUMN social_accounts.agent_binding_mode IS
  'auto: Extension may add matching Agents; manual: admin-selected Agent set is authoritative';

UPDATE social_accounts account
SET agent_binding_mode = 'manual',
  updated_at = now()
WHERE account.identity_source = 'manual'
  OR EXISTS (
    SELECT 1
    FROM social_account_bindings binding
    WHERE binding.tenant_id = account.tenant_id
      AND binding.social_account_id = account.id
      AND binding.source = 'manual'
  );

WITH invalid_accounts AS (
  SELECT id, tenant_id
  FROM social_accounts
  WHERE (
    platform_account_id <> ''
    AND lower(platform_account_id) = ANY(
      ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
        'undefined', 'null']
    )
  )
  OR (
    account_handle <> ''
    AND lower(trim(leading '@' FROM account_handle)) = ANY(
      ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
        'undefined', 'null']
    )
  )
)
UPDATE social_account_bindings binding
SET status = 'historical',
  ended_at = now(),
  metadata = binding.metadata || jsonb_build_object(
    'invalidIdentityArchived', true,
    'invalidIdentityArchivedAt', now()
  ),
  updated_at = now()
FROM invalid_accounts invalid
WHERE binding.tenant_id = invalid.tenant_id
  AND binding.social_account_id = invalid.id
  AND binding.status = 'current';

UPDATE social_accounts
SET health_status = 'disabled',
  agent_binding_mode = 'manual',
  updated_at = now()
WHERE (
  platform_account_id <> ''
  AND lower(platform_account_id) = ANY(
    ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
      'undefined', 'null']
  )
)
OR (
  account_handle <> ''
  AND lower(trim(leading '@' FROM account_handle)) = ANY(
    ARRAY['self', 'me', 'my', 'profile', 'home', 'login',
      'undefined', 'null']
  )
);
