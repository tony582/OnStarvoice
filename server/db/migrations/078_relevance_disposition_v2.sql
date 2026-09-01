-- StarVoice 0.4: two-stage relevance decisions and business visibility.
--
-- `records` remains the durable identity/audit store. `business_visibility`
-- controls whether a record may enter triage, patrol, lead and report views;
-- filtered/deferred records are therefore retained without polluting business
-- metrics or consuming downstream enhancement work.

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS business_visibility TEXT NOT NULL DEFAULT 'eligible',
  ADD COLUMN IF NOT EXISTS relevance_disposition_updated_at TIMESTAMPTZ;

ALTER TABLE records
  DROP CONSTRAINT IF EXISTS records_business_visibility_check;

ALTER TABLE records
  ADD CONSTRAINT records_business_visibility_check
  CHECK (business_visibility IN ('eligible', 'filtered_out', 'deferred'));

CREATE INDEX IF NOT EXISTS idx_records_tenant_business_visibility_created
  ON records (tenant_id, business_visibility, created_at DESC);

ALTER TABLE relevance_prefilter_decisions
  ADD COLUMN IF NOT EXISTS parent_decision_id UUID,
  ADD COLUMN IF NOT EXISTS business_visibility TEXT NOT NULL DEFAULT 'eligible',
  ADD COLUMN IF NOT EXISTS enhancement_state TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS disposition_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deferred_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sampled_full_capture BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE relevance_prefilter_decisions
  DROP CONSTRAINT IF EXISTS relevance_prefilter_decisions_execution_disposition_check,
  DROP CONSTRAINT IF EXISTS relevance_prefilter_decisions_business_visibility_check,
  DROP CONSTRAINT IF EXISTS relevance_prefilter_decisions_enhancement_state_check;

ALTER TABLE relevance_prefilter_decisions
  ADD CONSTRAINT relevance_prefilter_decisions_execution_disposition_check
    CHECK (execution_disposition IN (
      'collect_full',
      'skip_full_capture',
      'request_detail',
      'collect_minimal_detail',
      'defer_enhancement'
    )),
  ADD CONSTRAINT relevance_prefilter_decisions_business_visibility_check
    CHECK (business_visibility IN ('eligible', 'filtered_out', 'deferred')),
  ADD CONSTRAINT relevance_prefilter_decisions_enhancement_state_check
    CHECK (enhancement_state IN (
      'not_started',
      'minimal_captured',
      'full_capture',
      'skipped',
      'deferred'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_relevance_prefilter_decisions_tenant_id
  ON relevance_prefilter_decisions (tenant_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'relevance_prefilter_decisions_parent_fk'
      AND conrelid = 'relevance_prefilter_decisions'::regclass
  ) THEN
    ALTER TABLE relevance_prefilter_decisions
      ADD CONSTRAINT relevance_prefilter_decisions_parent_fk
      FOREIGN KEY (tenant_id, parent_decision_id)
      REFERENCES relevance_prefilter_decisions (tenant_id, id)
      ON DELETE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_decisions_parent
  ON relevance_prefilter_decisions (tenant_id, parent_decision_id, created_at DESC)
  WHERE parent_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_relevance_prefilter_decisions_deferred
  ON relevance_prefilter_decisions (tenant_id, deferred_until, created_at DESC)
  WHERE execution_disposition = 'defer_enhancement';

-- Only explicit legacy decisions are projected. Ambiguous historical rows stay
-- eligible so this migration cannot hide content by inference.
UPDATE records
SET business_visibility = 'filtered_out',
    relevance_disposition_updated_at = COALESCE(relevance_disposition_updated_at, updated_at, now())
WHERE business_visibility = 'eligible'
  AND (
    payload->>'detailCaptureStatus' = 'filtered'
    OR payload->'aiRelevancePrefilter'->>'executionDisposition' = 'skip_expensive'
    OR payload->'aiRelevancePrefilter'->>'modelExecutionDisposition' = 'skip_full_capture'
  );

UPDATE records
SET business_visibility = 'deferred',
    relevance_disposition_updated_at = COALESCE(relevance_disposition_updated_at, updated_at, now())
WHERE business_visibility = 'eligible'
  AND (
    payload->>'detailCaptureStatus' = 'deferred'
    OR payload->'aiRelevancePrefilter'->>'executionDisposition' = 'defer_enhancement'
    OR payload->'aiRelevancePrefilter'->>'modelExecutionDisposition' = 'defer_enhancement'
  );

COMMENT ON COLUMN records.business_visibility IS
  'eligible enters business views; filtered_out/deferred remain audit-visible only';
COMMENT ON COLUMN relevance_prefilter_decisions.parent_decision_id IS
  'detail-stage decision lineage to the latest list-stage decision for the same content';
