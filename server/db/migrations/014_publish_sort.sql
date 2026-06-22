-- 发布时间排序:publish_time/published_at 是采集到的原始串(2026-06-01 / 3天前 / 空),无法直接排序。
-- 加规范化时间戳列,写入时由服务端解析填充;存量先回落采集时间兜底,保证排序即刻可用。
ALTER TABLE records ADD COLUMN IF NOT EXISTS published_ts TIMESTAMPTZ;
ALTER TABLE comment_leads ADD COLUMN IF NOT EXISTS comment_published_ts TIMESTAMPTZ;

UPDATE records SET published_ts = created_at WHERE published_ts IS NULL;
UPDATE comment_leads SET comment_published_ts = captured_at WHERE comment_published_ts IS NULL;

CREATE INDEX IF NOT EXISTS idx_records_tenant_published_ts ON records (tenant_id, published_ts DESC);
CREATE INDEX IF NOT EXISTS idx_comment_leads_tenant_published_ts ON comment_leads (tenant_id, comment_published_ts DESC);
