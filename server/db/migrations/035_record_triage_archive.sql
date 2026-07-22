-- 内容分诊归档是独立生命周期，不复用处理模式 status。
ALTER TABLE record_triage
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE record_triage
  ADD COLUMN IF NOT EXISTS archived_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE record_triage
  ADD COLUMN IF NOT EXISTS archived_by_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_record_triage_tenant_archive
  ON record_triage (tenant_id, archived_at, updated_at DESC);
