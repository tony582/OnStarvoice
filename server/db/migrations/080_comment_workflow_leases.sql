-- Durable, attempt-fenced leases for comment post-processing. The observation
-- payload remains the replay source; these columns only coordinate workers.
ALTER TABLE record_observations
  ADD COLUMN IF NOT EXISTS source_ingestion_key TEXT,
  ADD COLUMN IF NOT EXISTS comment_workflow_claim_token UUID,
  ADD COLUMN IF NOT EXISTS comment_workflow_worker_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS comment_workflow_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comment_workflow_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_workflow_next_retry_at TIMESTAMPTZ;

ALTER TABLE record_observations
  DROP CONSTRAINT IF EXISTS record_observations_comment_workflow_retry_check;
ALTER TABLE record_observations
  ADD CONSTRAINT record_observations_comment_workflow_retry_check
  CHECK (
    comment_workflow_retry_count >= 0
    AND char_length(comment_workflow_worker_id) <= 200
  );

CREATE INDEX IF NOT EXISTS idx_record_observations_comment_workflow_lease
  ON record_observations (
    tenant_id,
    comment_workflow_status,
    comment_workflow_next_retry_at,
    comment_workflow_lease_expires_at,
    comment_workflow_updated_at,
    id
  )
  WHERE comment_workflow_status IN ('queued', 'running', 'failed');

-- Existing history stays untouched. New syncs with an exact capture item
-- attempt use this key so an HTTP retry after an unknown response reuses the
-- same durable observation and queue receipt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_observations_source_ingestion_key
  ON record_observations (tenant_id, source_ingestion_key)
  WHERE source_ingestion_key IS NOT NULL;

-- One small global budget row replaces a full backlog scan on every sync.
-- The row is locked in the same transaction as a queued observation insert;
-- the trigger below reserves/releases capacity transactionally and therefore
-- also rolls back with the observation write.
CREATE TABLE IF NOT EXISTS comment_workflow_capacity_budget (
  budget_key TEXT PRIMARY KEY,
  pending_count BIGINT NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (budget_key = 'global')
);

INSERT INTO comment_workflow_capacity_budget (
  budget_key, pending_count, pending_bytes, updated_at
)
SELECT 'global',
  COUNT(*)::bigint,
  COALESCE(SUM(pg_column_size(payload)), 0)::bigint,
  now()
FROM record_observations
WHERE comment_workflow_status IN ('queued', 'running', 'failed')
ON CONFLICT (budget_key) DO UPDATE
SET pending_count = excluded.pending_count,
  pending_bytes = excluded.pending_bytes,
  updated_at = now();

CREATE OR REPLACE FUNCTION maintain_comment_workflow_capacity_budget()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_count BIGINT := 0;
  new_count BIGINT := 0;
  old_bytes BIGINT := 0;
  new_bytes BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.comment_workflow_status IN (
    'queued', 'running', 'failed'
  ) THEN
    old_count := 1;
    old_bytes := pg_column_size(OLD.payload)::bigint;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.comment_workflow_status IN (
    'queued', 'running', 'failed'
  ) THEN
    new_count := 1;
    new_bytes := pg_column_size(NEW.payload)::bigint;
  END IF;

  IF old_count <> new_count OR old_bytes <> new_bytes THEN
    UPDATE comment_workflow_capacity_budget
    SET pending_count = GREATEST(0, pending_count + new_count - old_count),
      pending_bytes = GREATEST(0, pending_bytes + new_bytes - old_bytes),
      updated_at = now()
    WHERE budget_key = 'global';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_observation_comment_workflow_budget
  ON record_observations;
CREATE TRIGGER trg_record_observation_comment_workflow_budget
AFTER INSERT OR DELETE OR UPDATE OF comment_workflow_status, payload
ON record_observations
FOR EACH ROW
EXECUTE FUNCTION maintain_comment_workflow_capacity_budget();

-- A renewable database lease makes the processing concurrency limit apply
-- across API and ai-media processes, not only inside one Node.js process.
CREATE TABLE IF NOT EXISTS comment_workflow_processor_leases (
  lease_key TEXT PRIMARY KEY,
  claim_token UUID,
  worker_id TEXT NOT NULL DEFAULT '',
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lease_key = 'global'),
  CHECK (char_length(worker_id) <= 200)
);

INSERT INTO comment_workflow_processor_leases (lease_key)
VALUES ('global')
ON CONFLICT (lease_key) DO NOTHING;
