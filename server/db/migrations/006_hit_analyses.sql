-- 爆款拆解:对已采集的高互动内容做 AI 反编译(钩子/标题公式/正文结构/标签策略/可复刻模板),缓存结果。
CREATE TABLE IF NOT EXISTS hit_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {hook,titleFormula,structure,tagStrategy,template,whyItWorks}
  source TEXT NOT NULL DEFAULT 'ai',                -- ai | rule_fallback
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_hit_analyses_tenant_created
  ON hit_analyses (tenant_id, created_at DESC);
