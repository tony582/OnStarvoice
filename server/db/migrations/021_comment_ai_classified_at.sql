-- 021: 评论入库与 AI 分类解耦。
-- 评论先以规则分类快速入库(立即可见),后台 refineCommentsWithAI 再批量 AI 精炼并回填。
-- ai_classified_at = NULL  → 待 AI 精炼(后台队列会捞它);
-- ai_classified_at 非 NULL → 已精炼(或官方评论规则即终判,无需 AI)。
ALTER TABLE record_comments ADD COLUMN IF NOT EXISTS ai_classified_at timestamptz;

-- 存量评论一律视为已分类,避免上线后后台把历史全量重判一遍。
UPDATE record_comments SET ai_classified_at = COALESCE(updated_at, created_at) WHERE ai_classified_at IS NULL;

-- 待精炼队列的部分索引(只索引 NULL 行,体积极小,后台轮询很快)。
CREATE INDEX IF NOT EXISTS idx_record_comments_ai_pending
  ON record_comments (tenant_id, record_id) WHERE ai_classified_at IS NULL;
