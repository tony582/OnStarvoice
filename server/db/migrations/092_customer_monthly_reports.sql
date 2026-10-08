-- Customer monthly reports: immutable versions per tenant and month, counted by
-- post publish time inside the Content Triage scope. Email deliveries mirror
-- the daily report's one-row-per-version queue.
CREATE TABLE customer_monthly_reports (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_month DATE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('formal', 'realtime')),
  version INTEGER NOT NULL CHECK (version > 0),
  request_key TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, report_month, version),
  UNIQUE (tenant_id, request_key)
);
CREATE INDEX customer_monthly_reports_history ON customer_monthly_reports (tenant_id, report_month DESC, version DESC);

CREATE TABLE customer_monthly_email_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','failed','sent')),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  message_id TEXT,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,report_id),
  FOREIGN KEY (tenant_id,report_id) REFERENCES customer_monthly_reports(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX customer_monthly_email_deliveries_queued ON customer_monthly_email_deliveries(created_at) WHERE status='queued';
