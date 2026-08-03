-- A browser profile that has moved to another tenant must disappear from the
-- old tenant's operational UI without losing its history or becoming
-- permanently revoked. Re-verifying an effective activation code for the old
-- tenant can move this tenant-scoped Agent back to active.
ALTER TABLE capture_agents
  DROP CONSTRAINT IF EXISTS capture_agents_status_check;

ALTER TABLE capture_agents
  ADD CONSTRAINT capture_agents_status_check
  CHECK (status IN ('active', 'paused', 'migrated', 'revoked'));
