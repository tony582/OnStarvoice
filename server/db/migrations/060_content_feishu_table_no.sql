-- 060: “负面-飞书表”直接记录客户维护的飞书表号。
--
-- 飞书表号属于内容处置状态，不再依赖本系统的旧工单流程。历史内容工单号码
-- 会迁移到新字段；旧工单与过程记录继续保留，只作为历史证据读取。

ALTER TABLE record_triage
  ADD COLUMN IF NOT EXISTS feishu_table_no TEXT NOT NULL DEFAULT '';

ALTER TABLE record_triage
  DROP CONSTRAINT IF EXISTS record_triage_feishu_table_no_length;

ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_feishu_table_no_length
  CHECK (char_length(feishu_table_no) <= 100);

UPDATE record_triage rt
SET feishu_table_no = COALESCE((
  SELECT t.external_ticket_no
  FROM tickets t
  WHERE t.tenant_id = rt.tenant_id
    AND t.source_type = 'content'
    AND t.source_record_id = rt.record_id
    AND btrim(t.external_ticket_no) <> ''
  ORDER BY (t.status <> 'closed') DESC, t.created_at DESC, t.id DESC
  LIMIT 1
), '')
WHERE rt.status = 'negative_feishu'
  AND btrim(rt.feishu_table_no) = ''
  AND EXISTS (
    SELECT 1
    FROM tickets t
    WHERE t.tenant_id = rt.tenant_id
      AND t.source_type = 'content'
      AND t.source_record_id = rt.record_id
      AND btrim(t.external_ticket_no) <> ''
  );
