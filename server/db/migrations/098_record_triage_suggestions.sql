-- Suggestions are labels; only an explicit triage action changes handling status.
CREATE TABLE IF NOT EXISTS record_triage_suggestions (
  tenant_id UUID NOT NULL,
  record_id UUID NOT NULL,
  suggestion TEXT NOT NULL CHECK (suggestion = 'non_monitor'),
  rule_version TEXT NOT NULL,
  reason JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reason) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('accepted', 'rejected', 'superseded')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, record_id, suggestion),
  FOREIGN KEY (tenant_id, record_id) REFERENCES records(tenant_id, id) ON DELETE CASCADE,
  CHECK ((resolved_at IS NULL AND resolution IS NULL AND resolved_by IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_record_triage_suggestions_open
  ON record_triage_suggestions (tenant_id, suggestion, record_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_record_triage_suggestions_resolved
  ON record_triage_suggestions (tenant_id, resolved_at DESC, resolution) WHERE resolved_at IS NOT NULL;
