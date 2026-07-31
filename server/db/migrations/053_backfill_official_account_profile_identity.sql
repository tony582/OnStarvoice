-- Some official subscriptions were converted from an existing creator
-- subscription without copying its stable profile identity into
-- official_accounts. Recover only IDs embedded in an exact platform profile
-- URL; never treat an arbitrary subscription keyword or display name as an ID.

WITH linked_profile_candidates AS (
  SELECT DISTINCT ON (account.id)
    account.id AS official_account_id,
    account.tenant_id,
    account.platform,
    CASE
      WHEN account.platform = 'douyin'
        AND subscription.account_url
          ~* '^https?://([^/]*\.)?douyin\.com/user/'
        THEN substring(
          split_part(subscription.account_url, '?', 1)
          FROM '/user/([[:alnum:]_.-]{5,240})'
        )
      WHEN account.platform = 'xiaohongshu'
        AND subscription.account_url
          ~* '^https?://([^/]*\.)?xiaohongshu\.com/user/profile/'
        THEN substring(
          split_part(subscription.account_url, '?', 1)
          FROM '/user/profile/([[:alnum:]_.-]{5,240})'
        )
      WHEN account.platform = 'weibo'
        AND subscription.account_url
          ~* '^https?://([^/]*\.)?weibo\.com/'
        THEN COALESCE(
          substring(
            split_part(subscription.account_url, '?', 1)
            FROM '/u/([0-9]{4,})'
          ),
          substring(
            split_part(subscription.account_url, '?', 1)
            FROM 'weibo\.com/([0-9]{4,})'
          )
        )
      ELSE ''
    END AS inferred_platform_user_id
  FROM official_accounts account
  JOIN monitor_subscriptions subscription
    ON subscription.tenant_id = account.tenant_id
    AND subscription.official_account_id = account.id
    AND subscription.subject_type = 'official'
    AND subscription.status <> 'deleted'
  WHERE account.status <> 'deleted'
    AND account.platform_user_id = ''
  ORDER BY
    account.id,
    (subscription.status = 'active') DESC,
    subscription.updated_at DESC,
    subscription.id
),
safe_candidates AS (
  SELECT *
  FROM linked_profile_candidates
  WHERE inferred_platform_user_id <> ''
    AND lower(inferred_platform_user_id) NOT IN (
      'self', 'me', 'my', 'profile', 'home', 'login', 'undefined', 'null'
    )
)
UPDATE official_accounts account
SET platform_user_id = candidate.inferred_platform_user_id,
  updated_at = now()
FROM safe_candidates candidate
WHERE account.id = candidate.official_account_id
  AND account.tenant_id = candidate.tenant_id
  AND account.platform = candidate.platform
  AND account.platform_user_id = ''
  AND NOT EXISTS (
    SELECT 1
    FROM official_accounts conflicting
    WHERE conflicting.tenant_id = account.tenant_id
      AND conflicting.platform = account.platform
      AND conflicting.id <> account.id
      AND conflicting.status <> 'deleted'
      AND conflicting.platform_user_id =
        candidate.inferred_platform_user_id
  );
