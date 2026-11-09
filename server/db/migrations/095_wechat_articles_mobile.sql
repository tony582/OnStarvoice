-- WeChat articles are a separate phone capability; old runners never claim this workflow.
ALTER TABLE capture_mobile_post_receipts DROP CONSTRAINT IF EXISTS capture_mobile_post_receipts_platform_check;
ALTER TABLE capture_mobile_post_receipts ADD CONSTRAINT capture_mobile_post_receipts_platform_check
  CHECK (platform IN ('wechat_channels', 'wechat_articles'));

CREATE INDEX IF NOT EXISTS capture_tasks_wechat_articles_mobile_runs ON capture_tasks (tenant_id, created_at DESC)
  WHERE metadata->>'workflow' = 'wechat_articles_mobile_capture';

UPDATE capture_agents SET allowed_platforms = array_append(allowed_platforms, 'wechat_articles'), updated_at = now()
WHERE capabilities->>'agentKind' = 'android_mobile'
  AND NOT ('wechat_articles' = ANY(COALESCE(allowed_platforms, ARRAY[]::text[])));

ALTER TABLE unattended_negative_patrol_state DROP CONSTRAINT IF EXISTS unattended_negative_patrol_state_platform_check;
ALTER TABLE unattended_negative_patrol_state ADD CONSTRAINT unattended_negative_patrol_state_platform_check
  CHECK (platform IN ('xiaohongshu', 'douyin', 'wechat_channels', 'wechat_articles'));

-- Article pages omit some metrics. NULL represents not observed; a displayed 0 remains 0.
-- Existing rows and other platform write behavior are unchanged.
ALTER TABLE records ALTER COLUMN likes DROP NOT NULL, ALTER COLUMN comments_count DROP NOT NULL,
  ALTER COLUMN collects DROP NOT NULL, ALTER COLUMN shares DROP NOT NULL;
ALTER TABLE record_observations ALTER COLUMN likes DROP NOT NULL, ALTER COLUMN comments_count DROP NOT NULL,
  ALTER COLUMN collects DROP NOT NULL, ALTER COLUMN shares DROP NOT NULL;

ALTER TABLE record_comments ALTER COLUMN like_count DROP NOT NULL;
