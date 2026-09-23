CREATE INDEX IF NOT EXISTS idx_capture_discovery_detail_queue
  ON capture_discovery_candidates (tenant_id,first_seen_at,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS idx_capture_discovery_active_demands
  ON capture_discovery_run_candidates (tenant_id,candidate_id) WHERE demand_status='active';
CREATE TABLE IF NOT EXISTS capture_discovery_reprocess_requests (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,request_id)
);
