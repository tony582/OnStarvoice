-- 015_reset_captured_data.sql
-- 一次性重置(测试期):清空所有「采集内容 + 派生数据」,供用更新后的扩展从头干净采集。
-- 由 migrate.js 在单个事务内执行,任一句失败则整体回滚。
--
-- 【清空】采集内容与派生:
--   records  —— 删除时按外键 ON DELETE CASCADE 自动连带清空:
--     record_comments(评论)、comment_leads(评论客资)、official_responses(官方响应)、
--     record_triage(分诊)、record_versions(版本)、record_observations(观测)、
--     hit_analyses(命中分析)、issue_records(议题-记录关联)
--   以下表通过 SET NULL / 独立 tenant 关联,记录删后会悬空,需显式清空:
--     tickets(工单)、alerts(预警)、issues+issue_events(议题聚类及事件)、
--     report_runs+report_snapshots(报告及快照)、benchmark_results(基线)、
--     monitor_executions(采集执行历史)
--
-- 【保留】账号与配置(绝不删):
--   tenants / users / user_memberships / user_sessions / auth_bindings / auth_codes /
--   password_events / tenant_settings / monitor_subscriptions(关键词监控配置) /
--   official_accounts(竞品账号配置) / track_strategies / keyword_expansions / audit_logs

-- 先删「不级联、删 records 后会悬空」的派生表(子表先于父表)
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
