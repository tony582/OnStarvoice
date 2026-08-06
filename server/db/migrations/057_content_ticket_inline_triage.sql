-- 057: 内容工单留在内容分诊，并关联客户外部 Excel 中的工单号码。
--
-- “已转工单”是内容的第五种处理模式。内容进入 ticketed 后仍保留在内容分诊，
-- 客户 Excel 中的工单号码只作为该模式的业务编号展示和搜索。

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS external_ticket_no TEXT NOT NULL DEFAULT '';

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_external_ticket_no_length;
ALTER TABLE tickets
  ADD CONSTRAINT tickets_external_ticket_no_length
  CHECK (char_length(external_ticket_no) <= 100);

-- 完成与忽略也属于工单过程事件；后续内容详情和导出只需读取同一条追加时间线。
ALTER TABLE ticket_notes DROP CONSTRAINT IF EXISTS ticket_notes_event_type_check;
ALTER TABLE ticket_notes
  ADD CONSTRAINT ticket_notes_event_type_check
  CHECK (event_type IN ('note', 'closed', 'reopened', 'done', 'dismissed'));

INSERT INTO ticket_notes (
  tenant_id, ticket_id, event_type, body,
  author_user_id, author_name, created_at
)
SELECT
  t.tenant_id,
  t.id,
  t.status,
  COALESCE(NULLIF(t.handle_note, ''), NULLIF(t.handle_result, ''), ''),
  t.handled_by_user_id,
  t.handled_by_name,
  COALESCE(t.handled_at, t.updated_at, now())
FROM tickets t
WHERE t.status IN ('done', 'dismissed')
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_notes tn
    WHERE tn.tenant_id = t.tenant_id
      AND tn.ticket_id = t.id
      AND tn.event_type = t.status
  );

-- 只要存在内容工单，当前处理模式就是“已转工单”。只更新 status；已有优先级、
-- 负责人、备注、归档字段和时间均原样保留。缺失的 record_triage 行按默认值补齐。
INSERT INTO record_triage (tenant_id, record_id, status)
SELECT DISTINCT t.tenant_id, t.source_record_id, 'ticketed'
FROM tickets t
JOIN records r
  ON r.tenant_id = t.tenant_id
 AND r.id = t.source_record_id
WHERE t.source_type = 'content'
  AND t.source_record_id IS NOT NULL
ON CONFLICT (tenant_id, record_id)
DO UPDATE SET status = excluded.status
WHERE record_triage.status IS DISTINCT FROM excluded.status;

-- 归档生命周期与内容工单状态双向对齐。只修 archived_*，不改处理模式、优先级、
-- 负责人、备注或其它分诊字段：只要仍有在途内容工单，内容就必须留在工作中。
UPDATE record_triage rt
SET archived_at = NULL,
    archived_by_user_id = NULL,
    archived_by_name = ''
WHERE rt.archived_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM tickets t
    WHERE t.tenant_id = rt.tenant_id
      AND t.source_type = 'content'
      AND t.source_record_id = rt.record_id
      AND t.status <> 'closed'
  );

-- 没有在途内容工单、但至少有一张已结案内容工单时补齐归档。若存在多张历史工单，
-- 以“审核时间 > 处理时间 > 工单更新时间”得到每张工单的归档时间，再确定性选择最新一张。
WITH latest_closed_content_ticket AS (
  SELECT DISTINCT ON (t.tenant_id, t.source_record_id)
    t.tenant_id,
    t.source_record_id,
    COALESCE(t.reviewed_at, t.handled_at, t.updated_at) AS archive_at,
    COALESCE(t.reviewed_by_user_id, t.handled_by_user_id) AS archive_user_id,
    COALESCE(
      NULLIF(t.reviewed_by_name, ''),
      NULLIF(t.handled_by_name, ''),
      NULLIF(t.created_by_name, ''),
      ''
    ) AS archive_name
  FROM tickets t
  WHERE t.source_type = 'content'
    AND t.source_record_id IS NOT NULL
    AND t.status = 'closed'
    AND NOT EXISTS (
      SELECT 1
      FROM tickets active
      WHERE active.tenant_id = t.tenant_id
        AND active.source_type = 'content'
        AND active.source_record_id = t.source_record_id
        AND active.status <> 'closed'
    )
  ORDER BY
    t.tenant_id,
    t.source_record_id,
    COALESCE(t.reviewed_at, t.handled_at, t.updated_at) DESC,
    t.updated_at DESC,
    t.created_at DESC,
    t.id DESC
)
INSERT INTO record_triage (
  tenant_id, record_id, status, priority, owner_user_id, owner_name,
  archived_at, archived_by_user_id, archived_by_name, updated_at
)
SELECT
  closed.tenant_id,
  closed.source_record_id,
  'ticketed',
  'normal',
  NULL,
  '',
  closed.archive_at,
  closed.archive_user_id,
  closed.archive_name,
  closed.archive_at
FROM latest_closed_content_ticket closed
JOIN records r
  ON r.tenant_id = closed.tenant_id
 AND r.id = closed.source_record_id
ON CONFLICT (tenant_id, record_id)
DO UPDATE SET
  archived_at = excluded.archived_at,
  archived_by_user_id = excluded.archived_by_user_id,
  archived_by_name = excluded.archived_by_name
WHERE record_triage.archived_at IS NULL;
