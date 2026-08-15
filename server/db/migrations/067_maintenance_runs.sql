CREATE TABLE IF NOT EXISTS maintenance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('once', 'repeatable')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'adopted')),
  source TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  legacy_marker TEXT,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT NOT NULL DEFAULT '',
  error_summary TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT maintenance_runs_task_id_nonempty CHECK (btrim(task_id) <> ''),
  CONSTRAINT maintenance_runs_task_version_nonempty CHECK (btrim(task_version) <> ''),
  CONSTRAINT maintenance_runs_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT maintenance_runs_owner_id_nonempty CHECK (btrim(owner_id) <> ''),
  CONSTRAINT maintenance_runs_finished_state CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_maintenance_runs_once_completion
  ON maintenance_runs (task_id, task_version)
  WHERE run_kind = 'once' AND status IN ('succeeded', 'adopted');

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_task_started
  ON maintenance_runs (task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_status_started
  ON maintenance_runs (status, started_at DESC);

COMMENT ON TABLE maintenance_runs IS
  'Audited executions of explicit maintenance tasks; schema_migrations remains reserved for SQL files and legacy markers.';

COMMENT ON COLUMN maintenance_runs.legacy_marker IS
  'Historical non-SQL schema_migrations marker adopted without deleting or rewriting the legacy row.';
