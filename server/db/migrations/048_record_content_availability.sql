ALTER TABLE records
  ADD COLUMN IF NOT EXISTS content_availability_status TEXT
    NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS content_availability_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_availability_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS content_availability_evidence JSONB
    NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  ALTER TABLE records
    ADD CONSTRAINT records_content_availability_status_check
    CHECK (
      content_availability_status IN (
        'available',
        'deleted',
        'page_unavailable',
        'unknown'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS idx_records_tenant_content_availability
  ON records (tenant_id, content_availability_status, content_availability_checked_at DESC);

COMMENT ON COLUMN records.content_availability_status IS
  'Latest browser-observed post availability: available, deleted, page_unavailable, or unknown';
COMMENT ON COLUMN records.content_availability_checked_at IS
  'Timestamp of the latest browser availability observation';
COMMENT ON COLUMN records.content_availability_reason IS
  'Machine-readable reason for the latest availability observation';
COMMENT ON COLUMN records.content_availability_evidence IS
  'Sanitized browser evidence supporting the latest availability observation';
