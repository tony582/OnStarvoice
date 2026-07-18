-- AI 前置相关性筛选（第一期：列表文字判断）
--
-- 请求表承担幂等重放；决策表即使作品最终未保存，也保留租户级模型判断台账。
-- 不保存模型 Key、Cookie、页面令牌、评论或完整页面内容。

CREATE TABLE IF NOT EXISTS relevance_prefilter_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_body_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  model_provider TEXT NOT NULL DEFAULT 'deepseek',
  model_name TEXT NOT NULL DEFAULT '',
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT relevance_prefilter_requests_idempotency_length
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  CONSTRAINT relevance_prefilter_requests_hash_format
    CHECK (request_body_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT relevance_prefilter_requests_tenant_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT relevance_prefilter_requests_tenant_idempotency_key
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_requests_tenant_created
  ON relevance_prefilter_requests (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS relevance_prefilter_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefilter_request_id UUID NOT NULL,
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  keyword_run_id TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'list',
  item_id TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  item_title_excerpt TEXT NOT NULL DEFAULT '',
  item_author_excerpt TEXT NOT NULL DEFAULT '',
  normalized_keyword_hash TEXT NOT NULL,
  content_summary_hash TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL DEFAULT 1 CHECK (intent_version > 0),
  prompt_version TEXT NOT NULL,
  model_provider TEXT NOT NULL DEFAULT 'deepseek',
  model_name TEXT NOT NULL DEFAULT '',
  server_model_status TEXT NOT NULL
    CHECK (server_model_status IN ('ok', 'invalid_input', 'model_error', 'timeout')),
  model_decision TEXT
    CHECK (model_decision IS NULL OR model_decision IN ('keep', 'skip', 'need_detail')),
  decision_finality TEXT NOT NULL DEFAULT 'provisional'
    CHECK (decision_finality IN ('provisional', 'final')),
  execution_disposition TEXT NOT NULL DEFAULT 'collect_full'
    CHECK (execution_disposition IN ('collect_full', 'skip_full_capture', 'request_detail')),
  query_match NUMERIC(5,4) CHECK (query_match IS NULL OR (query_match >= 0 AND query_match <= 1)),
  brand_match NUMERIC(5,4) CHECK (brand_match IS NULL OR (brand_match >= 0 AND brand_match <= 1)),
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_mode TEXT NOT NULL DEFAULT 'shadow'
    CHECK (effective_mode IN ('disabled', 'shadow', 'conservative')),
  skip_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.9700
    CHECK (skip_threshold >= 0.9700 AND skip_threshold <= 1),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT relevance_prefilter_decisions_request_fk
    FOREIGN KEY (tenant_id, prefilter_request_id)
    REFERENCES relevance_prefilter_requests(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT relevance_prefilter_decisions_keyword_hash_format
    CHECK (normalized_keyword_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT relevance_prefilter_decisions_summary_hash_format
    CHECK (content_summary_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT relevance_prefilter_decisions_request_item_key
    UNIQUE (tenant_id, prefilter_request_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_decisions_task_keyword
  ON relevance_prefilter_decisions (tenant_id, task_id, run_id, keyword_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_decisions_item
  ON relevance_prefilter_decisions (tenant_id, platform, external_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_decisions_model_status
  ON relevance_prefilter_decisions (tenant_id, server_model_status, created_at DESC);

CREATE TABLE IF NOT EXISTS relevance_prefilter_cache (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'list',
  normalized_keyword_hash TEXT NOT NULL,
  content_summary_hash TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  prompt_version TEXT NOT NULL,
  model_provider TEXT NOT NULL DEFAULT 'deepseek',
  model_name TEXT NOT NULL,
  response_item JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  PRIMARY KEY (tenant_id, cache_key),
  CONSTRAINT relevance_prefilter_cache_key_format
    CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT relevance_prefilter_cache_keyword_hash_format
    CHECK (normalized_keyword_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT relevance_prefilter_cache_summary_hash_format
    CHECK (content_summary_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_cache_tenant_expiry
  ON relevance_prefilter_cache (tenant_id, expires_at);
