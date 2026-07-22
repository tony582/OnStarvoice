-- 误报是独立的管理员复核反馈，不再是帖子处理模式。
-- 先恢复历史误报提交前的模式和备注，再从数据库约束中移除 false_positive。
ALTER TABLE record_triage
  DROP CONSTRAINT IF EXISTS record_triage_status_check;

WITH latest_feedback AS (
  SELECT DISTINCT ON (tenant_id, record_id)
    tenant_id,
    record_id,
    CASE
      WHEN original_values->>'triage_status' IN (
        'unhandled', 'reviewing', 'issue_linked', 'ticketed', 'official_responded', 'no_action'
      ) THEN original_values->>'triage_status'
      ELSE 'unhandled'
    END AS previous_status,
    COALESCE(original_values->>'triage_note', '') AS previous_note
  FROM record_feedback
  WHERE feedback_type = 'false_positive' AND record_id IS NOT NULL
  ORDER BY tenant_id, record_id, submitted_at DESC, id DESC
)
UPDATE record_triage rt
SET status = lf.previous_status,
  note = lf.previous_note,
  updated_at = now()
FROM latest_feedback lf
WHERE rt.tenant_id = lf.tenant_id
  AND rt.record_id = lf.record_id
  AND rt.status = 'false_positive';

UPDATE record_triage
SET status = 'unhandled',
  note = '',
  updated_at = now()
WHERE status = 'false_positive';

ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_status_check
  CHECK (status IN ('unhandled', 'reviewing', 'issue_linked', 'ticketed', 'official_responded', 'no_action'));
