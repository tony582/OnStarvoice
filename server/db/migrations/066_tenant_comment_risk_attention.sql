-- 评论是否进入默认舆情值守由租户独立配置。
-- 关闭只影响关注提醒与指挥中心展示，不停止评论采集、AI 标注或评论分诊。
INSERT INTO tenant_settings (tenant_id, key, value)
SELECT id, 'comment_risk_attention_enabled', 'true'
FROM tenants
ON CONFLICT (tenant_id, key) DO NOTHING;
