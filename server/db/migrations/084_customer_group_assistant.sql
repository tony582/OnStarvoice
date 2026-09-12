-- Opt-in customer group assistant. No existing delivery settings are changed.
CREATE TABLE customer_assistant_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE customer_assistant_sessions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,session_key)
);
CREATE TABLE customer_assistant_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_id TEXT,
  conversation_history JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dry_run BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','completed','failed','cancelled','reply_unknown')),
  reply TEXT,
  tool_results JSONB,
  error_message TEXT,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,message_id),
  UNIQUE(tenant_id,event_id)
);
CREATE INDEX customer_assistant_events_queue ON customer_assistant_events(created_at,id) WHERE status IN ('queued','working');
CREATE INDEX customer_assistant_events_session ON customer_assistant_events(tenant_id,session_key,created_at);
CREATE TABLE customer_assistant_email_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','failed','sent')),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  message_id TEXT,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  notified_at TIMESTAMPTZ,
  notification_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,chat_id,sender_id,request_id,report_id,recipient),
  FOREIGN KEY(tenant_id,report_id) REFERENCES customer_daily_reports(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX customer_assistant_email_queue ON customer_assistant_email_deliveries(created_at,id) WHERE status='queued';
