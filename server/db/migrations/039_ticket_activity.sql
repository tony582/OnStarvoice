-- 039: 工单过程记录增加事件类型。
-- 普通过程备注、结案和重开共用一条按时间追加的时间线，避免重开后丢失历史结案记录。
ALTER TABLE ticket_notes
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'note';

ALTER TABLE ticket_notes DROP CONSTRAINT IF EXISTS ticket_notes_event_type_check;
ALTER TABLE ticket_notes
  ADD CONSTRAINT ticket_notes_event_type_check
  CHECK (event_type IN ('note', 'closed', 'reopened'));

CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket_event
  ON ticket_notes (ticket_id, event_type, created_at);
