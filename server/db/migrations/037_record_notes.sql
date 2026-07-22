-- 037: 内容级追加备注。与采集记录分表保存，重复采集不会覆盖客户填写的处理备注。
CREATE TABLE IF NOT EXISTS record_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT record_notes_body_check
    CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_record_notes_record_created
  ON record_notes (tenant_id, record_id, created_at DESC, id DESC);
