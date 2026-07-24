-- 舆情剖析:话题级(追加留痕,仿 track_strategies —— 历史快照即价值,重跑=新行,可对比事件演化)
CREATE TABLE IF NOT EXISTS opinion_topic_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  focus_topic_id UUID REFERENCES focus_topics(id) ON DELETE SET NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_count INTEGER NOT NULL DEFAULT 0,
  analysis_source TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT 'topic-v1',
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opinion_topic_analyses_tenant_created
  ON opinion_topic_analyses (tenant_id, created_at DESC);

-- 单条级(唯一缓存,仿 hit_analyses)。input_hash 不进唯一键:读缓存时不一致 → 响应 stale:true
CREATE TABLE IF NOT EXISTS opinion_record_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis_source TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT 'record-v1',
  input_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_opinion_record_analyses_tenant_created
  ON opinion_record_analyses (tenant_id, created_at DESC);
