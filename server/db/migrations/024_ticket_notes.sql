-- 024: 工单过程备注(就地处理留痕)。
-- 客服在抽屉里就地填写过程备注 → 一条一条追加到这张日志表;工单本身只记最终处理结果/结案。
-- gen_random_uuid() 由 001 的 pgcrypto 扩展提供,与 tickets 表主键默认一致。
CREATE TABLE IF NOT EXISTS ticket_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_user_id UUID,
  author_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes (ticket_id, created_at);
