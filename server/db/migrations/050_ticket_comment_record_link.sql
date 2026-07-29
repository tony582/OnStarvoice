-- 评论转工单时同时保留原始内容关联，避免评论线索删除后丢失巡查历史。
UPDATE tickets t
SET source_record_id = cl.record_id
FROM comment_leads cl
WHERE t.source_type = 'comment'
  AND t.source_comment_id = cl.id
  AND t.tenant_id = cl.tenant_id
  AND t.source_record_id IS NULL;
