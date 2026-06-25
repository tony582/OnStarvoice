-- 027: 数据看板「关注主题」预设。
-- 客户分阶段关注的舆情内容不同(新车上市期 / 壁纸功能期 / 售后口碑期…),
-- 每个主题 = 一个命名 + 一组采集关键词;看板选中主题即按这组关键词收敛。
-- keywords 存 jsonb 字符串数组(与采集关键词 r.keyword 精确匹配,口径同内容分诊)。
-- gen_random_uuid() 由 001 的 pgcrypto 扩展提供。
CREATE TABLE IF NOT EXISTS focus_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_focus_topics_tenant ON focus_topics (tenant_id, sort_order, created_at);
