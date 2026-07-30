-- Official-account comment operations need immutable per-patrol baselines and
-- an auditable queue for manual platform actions. A "pending" action is only a
-- decision/assignment; it never claims that Xiaohongshu or Douyin succeeded.

CREATE TABLE IF NOT EXISTS official_comment_patrol_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  official_account_id UUID NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  monitor_execution_id UUID REFERENCES monitor_executions(id) ON DELETE SET NULL,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  platform_comment_count INTEGER NOT NULL DEFAULT 0,
  sampled_comment_count INTEGER NOT NULL DEFAULT 0,
  positive_comment_count INTEGER NOT NULL DEFAULT 0,
  neutral_comment_count INTEGER NOT NULL DEFAULT 0,
  negative_comment_count INTEGER NOT NULL DEFAULT 0,
  unknown_comment_count INTEGER NOT NULL DEFAULT 0,
  high_risk_comment_count INTEGER NOT NULL DEFAULT 0,
  latest_comment_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_comment_snapshot_execution_record
  ON official_comment_patrol_snapshots (monitor_execution_id, record_id)
  WHERE monitor_execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_official_comment_snapshot_record_captured
  ON official_comment_patrol_snapshots (tenant_id, record_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_official_comment_snapshot_account_captured
  ON official_comment_patrol_snapshots (
    tenant_id,
    official_account_id,
    captured_at DESC
  );

CREATE TABLE IF NOT EXISTS official_comment_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES record_comments(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'delete_review',
    'reply',
    'like',
    'encourage_reply',
    'ignore',
    'ticket',
    'manual_complete'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'completed',
    'canceled',
    'failed'
  )),
  note TEXT NOT NULL DEFAULT '',
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_official_comment_action_pending
  ON official_comment_actions (tenant_id, comment_id, action_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_official_comment_actions_comment_updated
  ON official_comment_actions (tenant_id, comment_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_official_comment_actions_status_updated
  ON official_comment_actions (tenant_id, status, updated_at DESC);
