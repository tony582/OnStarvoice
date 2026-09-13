-- Keep human classification separate from repeated AI classification.
ALTER TABLE comment_leads
  ADD COLUMN IF NOT EXISTS manual_lead_type TEXT,
  ADD COLUMN IF NOT EXISTS manual_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE comment_leads DROP CONSTRAINT IF EXISTS comment_leads_manual_lead_type_check;
ALTER TABLE comment_leads ADD CONSTRAINT comment_leads_manual_lead_type_check CHECK (
  manual_lead_type IS NULL OR (
    manual_lead_type IN (
      'sales_intent', 'complaint', 'renewal_billing', 'app_issue',
      'service_quality', 'safety_privacy', 'brand_risk', 'other'
    ) AND btrim(manual_reason) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_comment_leads_tenant_id
  ON comment_leads (tenant_id, id);

CREATE TABLE IF NOT EXISTS comment_lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (btrim(action) <> ''),
  status_from TEXT,
  status_to TEXT,
  note TEXT NOT NULL DEFAULT '',
  actor_id UUID,
  actor_name TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES comment_leads(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comment_lead_activities_history
  ON comment_lead_activities (tenant_id, lead_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comment_lead_activities_legacy_note
  ON comment_lead_activities (tenant_id, lead_id) WHERE action = 'legacy_note';

-- Preserve both the original legacy column and its original recorded date.
INSERT INTO comment_lead_activities (
  tenant_id, lead_id, action, note, actor_id, actor_name, metadata, created_at
)
SELECT tenant_id, id, 'legacy_note', note, handled_by, handled_name,
  jsonb_build_object('legacy', true), COALESCE(handled_at, updated_at, created_at)
FROM comment_leads
WHERE btrim(note) <> ''
ON CONFLICT (tenant_id, lead_id) WHERE action = 'legacy_note' DO NOTHING;
