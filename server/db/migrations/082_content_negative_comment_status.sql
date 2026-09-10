-- 082: 增加“负面-评论区留言”人工处理状态。
-- 仅扩展允许值，保留所有现有状态和历史记录；不触发评论发布或改变巡检规则。

ALTER TABLE record_triage
  DROP CONSTRAINT IF EXISTS record_triage_status_check;

ALTER TABLE record_triage
  ADD CONSTRAINT record_triage_status_check
  CHECK (status IN (
    'unhandled',
    'replied',
    'reviewed',
    'reviewed_non_monitor',
    'unavailable',
    'privacy_unreachable',
    'negative_feishu',
    'negative_cold',
    'negative_comment'
  ));
