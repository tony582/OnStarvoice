-- UI-bound mobile observations are candidates, not independently verified records.
ALTER TABLE capture_discovery_events DROP CONSTRAINT capture_discovery_events_verification_check;
ALTER TABLE capture_discovery_events ADD CONSTRAINT capture_discovery_events_verification_check
  CHECK (verification IN ('verified', 'ui_bound', 'link_unverified'));
