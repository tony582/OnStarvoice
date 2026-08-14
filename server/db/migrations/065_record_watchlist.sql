-- 人工关注内容与采集结果分离保存：重新采集 records 时不能覆盖人工关注状态。
CREATE TABLE IF NOT EXISTS record_watchlist (
  tenant_id UUID NOT NULL,
  record_id UUID NOT NULL,
  watched_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  watched_by_name TEXT NOT NULL DEFAULT '',
  watched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_id),
  CONSTRAINT record_watchlist_record_fk
    FOREIGN KEY (tenant_id, record_id)
    REFERENCES records(tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_record_watchlist_tenant_watched_at
  ON record_watchlist (tenant_id, watched_at DESC, record_id);

-- 关注内容巡查与负面巡查共用云端逐条领取机制，但保留独立 item_type，
-- 便于调度、审计和后续统计严格区分两种业务来源。
CREATE INDEX IF NOT EXISTS idx_capture_task_items_watched_content_claim
  ON capture_task_items (tenant_id, task_id, ordinal, id)
  WHERE item_type = 'watched_content'
    AND status IN ('pending', 'retryable')
    AND attempt_count < 3;
