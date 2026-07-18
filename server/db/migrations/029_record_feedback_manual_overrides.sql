-- 人工修正与误报反馈:
-- 1) records 保留人工身份覆盖和最近一次人工修改信息;
-- 2) record_feedback 作为可筛选、可复核、可导出的追加式反馈台账。

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS identity_override TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS manual_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS manual_updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_updated_name TEXT NOT NULL DEFAULT '';

ALTER TABLE records DROP CONSTRAINT IF EXISTS records_identity_override_check;
ALTER TABLE records
  ADD CONSTRAINT records_identity_override_check
  CHECK (identity_override IN ('', 'user', 'kol', 'dealer', 'koe', 'other'));

CREATE INDEX IF NOT EXISTS idx_records_tenant_identity_override
  ON records (tenant_id, identity_override)
  WHERE identity_override <> '';

CREATE TABLE IF NOT EXISTS record_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('false_positive', 'manual_correction')),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'reviewed', 'summarized', 'dismissed')),
  reason TEXT NOT NULL DEFAULT '',
  original_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  corrected_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_name TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_name TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT record_feedback_false_positive_reason_check
    CHECK (feedback_type <> 'false_positive' OR char_length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_record_feedback_tenant_status_created
  ON record_feedback (tenant_id, review_status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_record_feedback_tenant_type_created
  ON record_feedback (tenant_id, feedback_type, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_record_feedback_record_created
  ON record_feedback (record_id, submitted_at DESC)
  WHERE record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_record_feedback_submitter_created
  ON record_feedback (submitted_by_user_id, submitted_at DESC)
  WHERE submitted_by_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_record_feedback_pending_false_positive
  ON record_feedback (tenant_id, record_id)
  WHERE record_id IS NOT NULL
    AND feedback_type = 'false_positive'
    AND review_status = 'pending';
