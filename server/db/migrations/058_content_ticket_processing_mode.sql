-- 058: 修正已执行过早期 057 的环境，把内容工单恢复为第五种处理模式。
--
-- 057 在需求调整前曾把 ticketed 当作并行标记并还原为其它模式。迁移器按文件名
-- 记录执行状态，因此这里用独立的幂等迁移修正已登记 057 的测试或共享环境。
-- 仅更新 status；优先级、负责人、备注、归档字段和时间均保持不变。

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
