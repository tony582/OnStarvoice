-- 022: 清空「安吉星」租户(457e5851)的采集与衍生数据,供发客户演示从零开始。
-- 仅清该租户 —— 其他租户(OnStar / 鸿冠信息 / 东方航空)一律不动。
-- 保留:租户、账号、官方号、监控订阅、品牌口径(tenant_settings)等配置,平台开箱即用。
-- 由 migrate.js 在单事务内执行,任一句失败整体回滚。删除按外键依赖顺序(子表先于父表,records 最后)。
DELETE FROM official_responses  WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM comment_leads       WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM record_comments     WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM alerts              WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM issue_records       WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM issue_events        WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM issues              WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM hit_analyses        WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM record_observations WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM record_triage       WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM tickets             WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM report_snapshots    WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM report_runs         WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM benchmark_results   WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM monitor_executions  WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
DELETE FROM records             WHERE tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65';
