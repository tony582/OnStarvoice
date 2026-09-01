-- One independent budget for a fail-closed, cross-account search-challenge
-- handoff. It is deliberately separate from technical attempt_count: a busy
-- browser or relay timeout must neither consume nor grant a safety handoff.
ALTER TABLE capture_task_items
  ADD COLUMN IF NOT EXISTS safety_handoff_count INTEGER NOT NULL DEFAULT 0
    CHECK (safety_handoff_count >= 0);

ALTER TABLE capture_recovery_intents
  ADD COLUMN IF NOT EXISTS safety_handoff_count INTEGER NOT NULL DEFAULT 0
    CHECK (safety_handoff_count >= 0),
  ADD COLUMN IF NOT EXISTS source_lineage_silent BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN capture_task_items.safety_handoff_count IS
  'Number of cross-account handoffs caused by an allowlisted search challenge; independent of attempt_count.';

COMMENT ON COLUMN capture_recovery_intents.safety_handoff_count IS
  'Snapshot of the source item safety handoff budget used by this recovery lineage.';

COMMENT ON COLUMN capture_recovery_intents.source_lineage_silent IS
  'Set true only when dispatch transaction proves the source lineage quiet; it is not proof of challenge resolution.';
