-- 064: 增加“隐私限制-无法触达”人工处理状态。
-- 该状态表示内容仍可见，但因用户隐私设置无法直接联系；与“已不可见”分开记录。

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
    'negative_cold'
  ));
