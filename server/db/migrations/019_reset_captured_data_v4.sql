-- 019_reset_captured_data_v4.sql
-- 清掉"用旧扩展(抖音作用域修复未生效)采的过采脏数据"。扩展已 reload、作用域修复生效后,
-- 全量重置,供从头干净重采。由 migrate.js 在单事务内执行,任一句失败整体回滚。
-- 清空范围/保留范围同 015/016/018。

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
