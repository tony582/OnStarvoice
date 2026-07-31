-- The original official_accounts table started as a self-owned-content
-- exclusion list. Later, Extension registration added strong account identity
-- and a linked official monitor subscription. If a legacy name-only row and a
-- patrol-backed row describe the same tenant/platform/exact account name, keep
-- the patrol-backed row and merge the legacy exclusion settings into it.

CREATE TEMP TABLE official_account_legacy_merge ON COMMIT DROP AS
WITH canonical_candidates AS (
  SELECT account.id,
    account.tenant_id,
    account.platform,
    account.account_name,
    row_number() OVER (
      PARTITION BY account.tenant_id, account.platform, account.account_name
      ORDER BY
        (account.profile_url <> '') DESC,
        (account.platform_user_id <> '') DESC,
        (account.account_no <> '') DESC,
        account.updated_at DESC,
        account.id
    ) AS canonical_rank
  FROM official_accounts account
  WHERE account.status <> 'deleted'
    AND EXISTS (
      SELECT 1
      FROM monitor_subscriptions subscription
      WHERE subscription.tenant_id = account.tenant_id
        AND subscription.official_account_id = account.id
        AND subscription.subject_type = 'official'
        AND subscription.status <> 'deleted'
    )
),
canonical AS (
  SELECT *
  FROM canonical_candidates
  WHERE canonical_rank = 1
)
SELECT legacy.id AS legacy_id,
  canonical.id AS canonical_id
FROM official_accounts legacy
JOIN canonical
  ON canonical.tenant_id = legacy.tenant_id
  AND canonical.platform = legacy.platform
  AND canonical.account_name = legacy.account_name
  AND canonical.id <> legacy.id
WHERE legacy.status <> 'deleted'
  AND legacy.platform_user_id = ''
  AND legacy.account_no = ''
  AND legacy.account_id = ''
  AND legacy.profile_url = ''
  AND NOT EXISTS (
    SELECT 1
    FROM monitor_subscriptions subscription
    WHERE subscription.tenant_id = legacy.tenant_id
      AND subscription.official_account_id = legacy.id
      AND subscription.status <> 'deleted'
  );

UPDATE official_accounts canonical
SET aliases = (
    SELECT COALESCE(jsonb_agg(DISTINCT aliases.alias_value), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(canonical.aliases) = 'array'
            THEN canonical.aliases
          ELSE '[]'::jsonb
        END
      ) AS alias_value
      UNION ALL
      SELECT jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(legacy.aliases) = 'array'
            THEN legacy.aliases
          ELSE '[]'::jsonb
        END
      ) AS alias_value
      FROM official_account_legacy_merge mapping
      JOIN official_accounts legacy ON legacy.id = mapping.legacy_id
      WHERE mapping.canonical_id = canonical.id
    ) aliases
  ),
  skip_content = canonical.skip_content OR EXISTS (
    SELECT 1
    FROM official_account_legacy_merge mapping
    JOIN official_accounts legacy ON legacy.id = mapping.legacy_id
    WHERE mapping.canonical_id = canonical.id
      AND legacy.skip_content = true
  ),
  updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM official_account_legacy_merge mapping
  WHERE mapping.canonical_id = canonical.id
);

UPDATE official_responses response
SET official_account_id = mapping.canonical_id
FROM official_account_legacy_merge mapping
WHERE response.official_account_id = mapping.legacy_id;

UPDATE monitor_subscriptions subscription
SET official_account_id = mapping.canonical_id,
  updated_at = now()
FROM official_account_legacy_merge mapping
WHERE subscription.official_account_id = mapping.legacy_id;

UPDATE official_comment_patrol_snapshots snapshot
SET official_account_id = mapping.canonical_id
FROM official_account_legacy_merge mapping
WHERE snapshot.official_account_id = mapping.legacy_id;

UPDATE official_accounts legacy
SET status = 'deleted',
  updated_at = now()
FROM official_account_legacy_merge mapping
WHERE legacy.id = mapping.legacy_id;
