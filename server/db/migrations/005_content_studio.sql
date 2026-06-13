-- 内容创意面(第二张脸)持久化:把扩展跑赛道策略/对标/扩词时,服务端算出的结果存下来,
-- 让"赛道大盘 / 对标账号库 / 选题扩词"从算完即弃变成可累积、可浏览。

-- 赛道策略结果(来自 /api/keyword-opportunity)
CREATE TABLE IF NOT EXISTS track_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  heat_level TEXT NOT NULL DEFAULT '',            -- high | medium | low
  cliff_drop_ratio REAL NOT NULL DEFAULT 0,        -- 前排断层比
  sample_count INTEGER NOT NULL DEFAULT 0,
  direction_count INTEGER NOT NULL DEFAULT 0,
  angle_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,       -- 完整 data(metrics/hotTopicDirections/recommendedAngles)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_track_strategies_tenant_created
  ON track_strategies (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_track_strategies_tenant_keyword
  ON track_strategies (tenant_id, keyword);

-- 对标账号分析结果(来自 /api/benchmark-discovery)
CREATE TABLE IF NOT EXISTS benchmark_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,       -- candidateAnalyses
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_tenant_created
  ON benchmark_results (tenant_id, created_at DESC);

-- 长尾扩词需求分析结果(来自 /api/keyword-analysis)
CREATE TABLE IF NOT EXISTS keyword_expansions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seed_keyword TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  keyword_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,       -- 完整扩词分析 data
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_keyword_expansions_tenant_created
  ON keyword_expansions (tenant_id, created_at DESC);
