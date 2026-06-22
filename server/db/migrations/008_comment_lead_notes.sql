-- 评论线索(舆情评论/销售客资)处理留痕:备注 + 处理人 + 处理时间
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS handled_by UUID;
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS handled_name TEXT NOT NULL DEFAULT '';
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;
