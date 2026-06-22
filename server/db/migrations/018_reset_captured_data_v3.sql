-- 018_reset_captured_data_v3.sql
-- 第三次一次性全量重置:抖音过采根治(douyin-comments.js 把候选正向圈进 comment-list)+
-- 评论入库链路修复全部就位后,清空所有采集数据,供用修好的扩展从头干净重采。
-- 由 migrate.js 在单事务内执行,任一句失败整体回滚。
--
-- 【清空】采集内容与派生(同 015/016):
--   records → ON DELETE CASCADE 连带清 record_comments / comment_leads / official_responses /
--     record_triage / record_versions / record_observations / hit_analyses / issue_records
--   以下需显式清:tickets / alerts / issues+issue_events / report_runs+report_snapshots /
--     benchmark_results / monitor_executions
-- 【保留】账号与配置:tenants / users / 登录会话 / tenant_settings /
--   monitor_subscriptions(关键词监控)/ official_accounts(竞品账号)/ track_strategies /
--   keyword_expansions / audit_logs

DELETE FROM tickets;
DELETE FROM alerts;
DELETE FROM issue_events;
DELETE FROM issue_records;
DELETE FROM issues;
DELETE FROM report_snapshots;
DELETE FROM report_runs;
DELETE FROM benchmark_results;
DELETE FROM monitor_executions;

DELETE FROM records;
