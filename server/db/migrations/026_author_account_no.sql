-- 博主平台账号号:小红书号(数字,如 104522125) / 抖音号(handle,如 laonongwan)。
-- 来自采集增强进作者主页时提取(小红书号)或笔记 API 的 author.unique_id(抖音号),
-- 导出「用户ID」列优先用它(比主页URL里的内部ID更直观、可直接搜人)。
ALTER TABLE records ADD COLUMN IF NOT EXISTS author_account_no TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_records_author_account_no
  ON records (tenant_id, author_account_no) WHERE author_account_no <> '';
