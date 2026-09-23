-- Discovery is an audit/receipt ledger, not an automatic dispatch queue.
-- No records, tasks or schedules are created by applying this migration.
CREATE TABLE IF NOT EXISTS capture_discovery_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'douyin' CHECK (platform = 'douyin'),
  external_id TEXT NOT NULL CHECK (external_id ~ '^[0-9]{16,22}$'),
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_detail_adapter'
    CHECK (status IN ('awaiting_detail_adapter', 'queued', 'capturing', 'stored', 'already_exists', 'needs_review', 'failed')),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  detail_task_item_id UUID REFERENCES capture_task_items(id) ON DELETE SET NULL,
  last_error JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, platform, external_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS capture_discovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES capture_agents(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES capture_task_items(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES capture_task_item_attempts(id) ON DELETE RESTRICT,
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  event_key UUID NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  upload_batch_id UUID NOT NULL,
  upload_batch_hash TEXT NOT NULL CHECK (upload_batch_hash ~ '^[0-9a-f]{64}$'),
  keyword TEXT NOT NULL,
  requested_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_share_url TEXT NOT NULL DEFAULT '',
  title_hint TEXT NOT NULL DEFAULT '',
  author_hint TEXT NOT NULL DEFAULT '',
  publish_time_raw TEXT NOT NULL DEFAULT '',
  discovered_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_ref TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'link_unverified')),
  receipt_status TEXT NOT NULL DEFAULT 'accepted' CHECK (receipt_status = 'accepted'),
  receipt JSONB NOT NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('pending', 'resolved', 'needs_review', 'unresolvable')),
  resolution_attempts INTEGER NOT NULL DEFAULT 0 CHECK (resolution_attempts >= 0),
  next_retry_at TIMESTAMPTZ,
  resolution_error TEXT NOT NULL DEFAULT '',
  verified_external_id TEXT NOT NULL DEFAULT '',
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('normal', 'late_audit')),
  review_result TEXT NOT NULL DEFAULT '',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  UNIQUE (tenant_id, agent_id, event_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES capture_discovery_candidates(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_capture_discovery_receipts
  ON capture_discovery_events (tenant_id, agent_id, upload_batch_id, received_at);
CREATE INDEX IF NOT EXISTS idx_capture_discovery_events_task
  ON capture_discovery_events (tenant_id, task_id, received_at);

CREATE TABLE IF NOT EXISTS capture_discovery_run_candidates (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES capture_tasks(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL,
  detail_task_item_id UUID REFERENCES capture_task_items(id) ON DELETE SET NULL,
  first_event_id UUID NOT NULL,
  demand_status TEXT NOT NULL CHECK (demand_status IN ('active', 'fulfilled', 'canceled', 'needs_action')),
  is_detail_owner BOOLEAN NOT NULL DEFAULT false,
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, run_id, candidate_id),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES capture_discovery_candidates(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, first_event_id)
    REFERENCES capture_discovery_events(tenant_id, id) ON DELETE RESTRICT
);
