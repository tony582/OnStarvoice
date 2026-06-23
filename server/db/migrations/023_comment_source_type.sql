-- 023: record_comments.source_type —— 评论来源/KOE 标记
-- 作者名命中品牌/车型词(按租户 tenant_settings.koe_account_terms,安吉星=上汽通用全系车型)→ 'dealer'(疑似KOE)。
-- 空串表示未判定/普通 UGC。多租户:其它租户未配 koe_account_terms 则不命中,保持空。
ALTER TABLE record_comments ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT '';

-- 评论分诊按 KOE 过滤时,经 comment_leads.comment_id 关联到本列;主键已覆盖 join,这里给非空来源建部分索引。
CREATE INDEX IF NOT EXISTS idx_record_comments_source_type
  ON record_comments (tenant_id, source_type)
  WHERE source_type <> '';
