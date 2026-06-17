-- D 组:统一「已转工单」状态语义 + 评论复发回流
--
-- ① 语义统一:转工单后,内容此前存 issue_linked、评论存 following(还和销售「跟进」撞名)。
--    统一为 ticketed(已转工单),两表同名同义,且与销售 following / 旧问题聚类 issue_linked 解耦。
-- ② 复发:给 comment_leads 增加 last_risk_reopened_at,支撑评论二次发酵自动回到待处理。

-- record_triage: 允许 ticketed,并把工单派生的 issue_linked 迁移过去
ALTER TABLE record_triage DROP CONSTRAINT IF EXISTS record_triage_status_check;
ALTER TABLE record_triage ADD CONSTRAINT record_triage_status_check
  CHECK (status IN ('unhandled', 'reviewing', 'issue_linked', 'ticketed', 'official_responded', 'archived', 'false_positive'));
UPDATE record_triage SET status = 'ticketed' WHERE status = 'issue_linked';

-- comment_leads: 允许 ticketed;舆情(非销售)的 following → ticketed;销售 following 保持不动
ALTER TABLE comment_leads DROP CONSTRAINT IF EXISTS comment_leads_status_check;
ALTER TABLE comment_leads ADD CONSTRAINT comment_leads_status_check
  CHECK (status IN ('new', 'following', 'ticketed', 'resolved', 'ignored'));
UPDATE comment_leads SET status = 'ticketed' WHERE status = 'following' AND lead_type <> 'sales_intent';

-- 评论复发时间戳(镜像 records.last_risk_reopened_at)
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS last_risk_reopened_at TIMESTAMPTZ;
