-- 舆情处理(全新 MECE 模块):统一处理状态机,独立于旧的分诊/评论/问题逻辑。
-- 状态(互斥、穷尽):pending 待处理 / doing 处理中 / done 已处理 / dismissed 已忽略
-- 内容(records)与评论(comment_leads)各自带一套独立的 opinion_* 字段,合并成"舆情项"。

ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_result TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_note TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_handled_by UUID;
ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_handled_name TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS opinion_handled_at TIMESTAMPTZ;

ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_result TEXT NOT NULL DEFAULT '';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_note TEXT NOT NULL DEFAULT '';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_handled_by UUID;
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_handled_name TEXT NOT NULL DEFAULT '';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS opinion_handled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_records_opinion ON records (tenant_id, opinion_state);
CREATE INDEX IF NOT EXISTS idx_comment_leads_opinion ON comment_leads (tenant_id, opinion_state);
