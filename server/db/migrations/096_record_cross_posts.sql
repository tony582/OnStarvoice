-- Labels only: never collapse records or change reporting/triage counts.
CREATE TABLE IF NOT EXISTS record_cross_posts (
  tenant_id UUID NOT NULL,
  record_id UUID NOT NULL,
  group_id UUID NOT NULL,
  score DOUBLE PRECISION NOT NULL CHECK (score >= 0 AND score <= 1),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES records(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_record_cross_posts_tenant_group
  ON record_cross_posts (tenant_id, group_id);

CREATE TABLE IF NOT EXISTS record_cross_post_exclusions (
  tenant_id UUID NOT NULL,
  record_a UUID NOT NULL,
  record_b UUID NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_a, record_b),
  CHECK (record_a < record_b),
  FOREIGN KEY (tenant_id, record_a) REFERENCES records(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, record_b) REFERENCES records(tenant_id, id) ON DELETE CASCADE
);
