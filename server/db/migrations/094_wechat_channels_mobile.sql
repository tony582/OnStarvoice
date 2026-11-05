-- WeChat Channels (视频号) captured on Android phones (docs/hotfix/20261105-wechat-channels-mobile.md).
-- No records, tasks or schedules are created by applying this migration.

-- Durable upload receipts for phone-captured posts: one row per phone event, replayed as-is.
CREATE TABLE IF NOT EXISTS capture_mobile_post_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES capture_task_items(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES capture_task_item_attempts(id) ON DELETE RESTRICT,
  event_key UUID NOT NULL,
  upload_batch_id UUID NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  platform TEXT NOT NULL DEFAULT 'wechat_channels' CHECK (platform = 'wechat_channels'),
  external_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason TEXT NOT NULL DEFAULT '',
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  observation_id UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, event_key)
);
CREATE INDEX IF NOT EXISTS capture_mobile_post_receipts_batch
  ON capture_mobile_post_receipts (tenant_id, agent_id, upload_batch_id);
CREATE INDEX IF NOT EXISTS capture_mobile_post_receipts_task
  ON capture_mobile_post_receipts (tenant_id, task_id, received_at DESC);

-- Phone runs of the new workflow, as 087 indexed the Douyin discovery workflow.
CREATE INDEX IF NOT EXISTS capture_tasks_wechat_mobile_runs
  ON capture_tasks (tenant_id, created_at DESC)
  WHERE metadata->>'workflow' = 'wechat_channels_mobile_capture';

-- Existing phones may take WeChat Channels plans once their Runner reports WeChat ready.
UPDATE capture_agents
SET allowed_platforms = array_append(allowed_platforms, 'wechat_channels'), updated_at = now()
WHERE capabilities->>'agentKind' = 'android_mobile'
  AND NOT ('wechat_channels' = ANY(COALESCE(allowed_platforms, ARRAY[]::text[])));

-- Unattended negative patrol may rotate Channels posts too.
ALTER TABLE unattended_negative_patrol_state DROP CONSTRAINT IF EXISTS unattended_negative_patrol_state_platform_check;
ALTER TABLE unattended_negative_patrol_state
  ADD CONSTRAINT unattended_negative_patrol_state_platform_check
  CHECK (platform IN ('xiaohongshu', 'douyin', 'wechat_channels'));
