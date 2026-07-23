-- 客户按需提取内容图片文字。按图片内容哈希缓存，避免重复图片重复调用模型。
CREATE TABLE IF NOT EXISTS record_image_ocr (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  image_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT 'visible-text-v1',
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'done', 'failed')),
  text TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  is_truncated BOOLEAN NOT NULL DEFAULT false,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  error_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id, image_hash, model, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_record_image_ocr_record
  ON record_image_ocr (tenant_id, record_id, updated_at DESC);
