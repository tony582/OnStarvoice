-- 旧版 archived 同时承担“无需操作”和“已归档”，迁移后彻底拆开：
-- status=no_action 仅表示处理模式，archived_at 仅表示是否归档。
ALTER TABLE record_triage
  DROP CONSTRAINT IF EXISTS record_triage_status_check;

UPDATE record_triage
SET archived_at = COALESCE(archived_at, updated_at, now()),
  archived_by_user_id = COALESCE(archived_by_user_id, owner_user_id),
  archived_by_name = CASE
    WHEN archived_by_name <> '' THEN archived_by_name
    ELSE owner_name
  END,
  status = 'no_action'
WHERE status = 'archived';

ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_status_check
  CHECK (status IN ('unhandled', 'reviewing', 'issue_linked', 'ticketed', 'official_responded', 'no_action', 'false_positive'));
