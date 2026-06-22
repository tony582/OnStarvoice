-- 016_reset_captured_data_v2.sql
-- 第二次一次性重置:修复"内容同步剔评论"(capture-sync 的 stripCommentCollectionsForContentSync)
-- 之后,清空所有采集数据,供用修好的扩展从头干净重采(这次评论会完整入 record_comments)。
-- 由 migrate.js 在单个事务内执行,任一句失败则整体回滚。
--
-- 【清空】采集内容与派生(同 015):
--   records —— ON DELETE CASCADE 连带清空 record_comments / comment_leads / official_responses /
--     record_triage / record_versions / record_observations / hit_analyses / issue_records
--   以下需显式清(SET NULL / 独立 tenant 关联):
--     tickets / alerts / issues+issue_events / report_runs+report_snapshots /
--     benchmark_results / monitor_executions
--
-- 【保留】账号与配置(绝不删):
--   tenants / users / user_memberships / user_sessions / auth_bindings / auth_codes /
--   password_events / tenant_settings / monitor_subscriptions / official_accounts /
--   track_strategies / keyword_expansions / audit_logs

DELETE FROM tickets;
DELETE FROM alerts;
DELETE FROM issue_events;
DELETE FROM issue_records;
DELETE FROM issues;
DELETE FROM report_snapshots;
DELETE FROM report_runs;
DELETE FROM benchmark_results;
DELETE FROM monitor_executions;

-- 最后删帖子;级联清空 评论/客资/分诊/版本/观测/命中分析/官方响应
DELETE FROM records;
