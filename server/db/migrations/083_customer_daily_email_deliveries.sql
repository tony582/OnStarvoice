-- Each selected report version has one immutable email destination and snapshot.
CREATE TABLE customer_daily_email_deliveries (
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
  FOREIGN KEY (tenant_id,report_id) REFERENCES customer_daily_reports(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX customer_daily_email_deliveries_queued ON customer_daily_email_deliveries(created_at) WHERE status='queued';
