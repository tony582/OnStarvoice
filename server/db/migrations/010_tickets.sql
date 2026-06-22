-- 工单系统(舆情处理的核心):分诊团队【转工单】→ 客服团队处理 → 回执反馈给分诊确认。
-- 一条工单来自一个源(内容 records / 评论 comment_leads),字段做快照,工单独立于源存活。
--
-- 状态机:
--   分诊转单           → status='pending'   feedback_status='none'
--   客服开始处理        → status='doing'
--   客服处理完成        → status='done'      feedback_status='pending_review'(回到分诊待确认)
--   客服判定无需处理     → status='dismissed' feedback_status='pending_review'
--   分诊确认归档        → status='closed'    feedback_status='confirmed'
--   分诊打回重处理       → status='pending'   feedback_status='reopened'
--
-- 注:009 的 records/comment_leads.opinion_* 字段已弃用(被本工单模型取代),保留以免破坏线上数据。

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- 来源
  source_type TEXT NOT NULL CHECK (source_type IN ('content', 'comment')),
  source_record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  source_comment_id UUID REFERENCES comment_leads(id) ON DELETE SET NULL,

  -- 来源快照(工单独立展示,不随源变动)
  platform TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  item_text TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',

  -- 工单属性
  category TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'doing', 'done', 'dismissed', 'closed')),

  -- 指派(派给客服)
  assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_name TEXT NOT NULL DEFAULT '',

  -- 转单(分诊侧)
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  dispatch_note TEXT NOT NULL DEFAULT '',

  -- 处理(客服侧)
  handle_result TEXT NOT NULL DEFAULT '',
  handle_note TEXT NOT NULL DEFAULT '',
  handled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_by_name TEXT NOT NULL DEFAULT '',
  handled_at TIMESTAMPTZ,

  -- 回执(分诊确认侧)
  feedback_status TEXT NOT NULL DEFAULT 'none' CHECK (feedback_status IN ('none', 'pending_review', 'confirmed', 'reopened')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_name TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_feedback ON tickets (tenant_id, feedback_status);
CREATE INDEX IF NOT EXISTS idx_tickets_source_record ON tickets (tenant_id, source_record_id);
CREATE INDEX IF NOT EXISTS idx_tickets_source_comment ON tickets (tenant_id, source_comment_id);
