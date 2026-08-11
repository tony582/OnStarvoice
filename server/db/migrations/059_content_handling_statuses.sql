-- 059: 内容分诊改为客户维护的舆情处理状态。
-- 客户的飞书表负责工单闭环；本系统只记录当前状态与追加备注，不再以内容工单限制状态切换。

ALTER TABLE record_triage
  DROP CONSTRAINT IF EXISTS record_triage_status_check;

-- 将旧处理模式收敛到新口径。历史审计与工单记录继续保留，不删除过程证据。
UPDATE record_triage
SET status = CASE status
  WHEN 'unhandled' THEN 'unhandled'
  WHEN 'official_responded' THEN 'replied'
  WHEN 'ticketed' THEN 'negative_feishu'
  WHEN 'issue_linked' THEN 'negative_feishu'
  WHEN 'reviewing' THEN 'negative_cold'
  WHEN 'no_action' THEN 'reviewed_non_monitor'
  WHEN 'false_positive' THEN 'reviewed_non_monitor'
  WHEN 'archived' THEN 'reviewed_non_monitor'
  ELSE 'unhandled'
END,
updated_at = now()
WHERE status NOT IN (
  'unhandled',
  'replied',
  'reviewed',
  'reviewed_non_monitor',
  'unavailable',
  'negative_feishu',
  'negative_cold'
);

ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_status_check
  CHECK (status IN (
    'unhandled',
    'replied',
    'reviewed',
    'reviewed_non_monitor',
    'unavailable',
    'negative_feishu',
    'negative_cold'
  ));
