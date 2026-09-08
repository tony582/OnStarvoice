-- Independent, immutable customer snapshots; never overwrite report_runs or customer documents.
CREATE TABLE customer_daily_reports (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('formal', 'realtime')),
  version INTEGER NOT NULL CHECK (version > 0),
  request_key TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, report_date, version),
  UNIQUE (tenant_id, request_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customer_daily_reports_history ON customer_daily_reports (tenant_id, report_date DESC, version DESC);

CREATE TABLE customer_daily_report_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}',
  next_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_daily_documents (
  report_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','retry_wait','needs_attention','ready')),
  phase TEXT NOT NULL DEFAULT 'create',
  document_id TEXT,
  document_url TEXT,
  progress JSONB NOT NULL DEFAULT '{}',
  allow_incomplete BOOLEAN NOT NULL DEFAULT false,
  manual_requested BOOLEAN NOT NULL DEFAULT false,
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,report_id) REFERENCES customer_daily_reports(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE customer_daily_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL,
  target_key TEXT NOT NULL,
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','retry_wait','needs_attention','sent','canceled')),
  automatic BOOLEAN NOT NULL DEFAULT false,
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_id TEXT,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,report_id,target_key),
  FOREIGN KEY (tenant_id,report_id) REFERENCES customer_daily_reports(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX customer_daily_documents_due ON customer_daily_documents (next_attempt_at) WHERE status IN ('queued','retry_wait');
CREATE INDEX customer_daily_deliveries_due ON customer_daily_deliveries (next_attempt_at) WHERE status IN ('queued','retry_wait');

-- A durable occurrence survives crashes between generation and enqueueing.
CREATE TABLE customer_daily_occurrences (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enqueued','needs_attention','canceled')),
  report_id UUID REFERENCES customer_daily_reports(id) ON DELETE CASCADE,
  error_message TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,report_date)
);
