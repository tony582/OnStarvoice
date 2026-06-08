-- OnStarVoice 数据库 Schema

-- ==================== 激活码 ====================
CREATE TABLE IF NOT EXISTS auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  owner_email TEXT DEFAULT '',
  owner_name TEXT DEFAULT '',
  type TEXT DEFAULT 'trial' CHECK(type IN ('trial', 'annual', 'permanent')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'frozen')),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  max_bindings INTEGER DEFAULT 3,
  notes TEXT DEFAULT ''
);

-- 激活码绑定环境
CREATE TABLE IF NOT EXISTS auth_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES auth_codes(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  user_agent TEXT DEFAULT '',
  bound_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(code_id, fingerprint)
);

-- ==================== 采集记录 ====================
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  record_type TEXT NOT NULL DEFAULT 'single_note',
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  author_name TEXT DEFAULT '',
  author_id TEXT DEFAULT '',
  author_avatar TEXT DEFAULT '',
  author_fans INTEGER DEFAULT 0,
  url TEXT DEFAULT '',
  cover_url TEXT DEFAULT '',
  note_type TEXT DEFAULT '',
  likes INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  collects INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  publish_time TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  -- CSV 对齐新增字段
  blogger_profile_url TEXT DEFAULT '',
  image_urls TEXT DEFAULT '[]',
  comments_text TEXT DEFAULT '',
  blogger_liked_collected INTEGER DEFAULT 0,
  blogger_account_type TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  audio_url TEXT DEFAULT '',
  video_duration TEXT DEFAULT '',
  comments_capture_status TEXT DEFAULT '',
  comments_total_captured INTEGER DEFAULT 0,
  capture_timestamp TEXT DEFAULT '',
  payload JSON,
  -- AI 标签
  sentiment TEXT DEFAULT '',
  intent TEXT DEFAULT '',
  category TEXT DEFAULT '',
  subcategory TEXT DEFAULT '',
  source_type TEXT DEFAULT '',
  ai_summary TEXT DEFAULT '',
  ai_confidence REAL DEFAULT 0,
  ai_labeled_at TEXT,
  -- 元数据
  auth_code TEXT DEFAULT '',
  keyword TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_platform ON records(platform);
CREATE INDEX IF NOT EXISTS idx_records_sentiment ON records(sentiment);
CREATE INDEX IF NOT EXISTS idx_records_category ON records(category);
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
CREATE INDEX IF NOT EXISTS idx_records_external_id ON records(external_id);

-- ==================== 预警 ====================
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('critical', 'warning', 'info')),
  reason TEXT NOT NULL DEFAULT '',
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  url TEXT DEFAULT '',
  interaction_total INTEGER DEFAULT 0,
  notified INTEGER DEFAULT 0,
  notified_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);

-- ==================== 配置 ====================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ==================== 监控订阅 ====================
CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  keyword TEXT NOT NULL,
  platform TEXT DEFAULT '',
  account_url TEXT DEFAULT '',
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'deleted')),
  notify_on_negative INTEGER DEFAULT 1,
  auth_code TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ==================== 监控执行记录 ====================
CREATE TABLE IF NOT EXISTS monitor_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER REFERENCES monitor_subscriptions(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending',
  records_found INTEGER DEFAULT 0,
  new_records INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  error_message TEXT DEFAULT '',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- ==================== 初始配置 ====================
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('llm_provider', 'gemini'),
  ('llm_api_key', ''),
  ('llm_model', 'gemini-2.0-flash'),
  ('llm_api_endpoint', ''),
  ('smtp_host', ''),
  ('smtp_port', '465'),
  ('smtp_secure', 'true'),
  ('smtp_user', ''),
  ('smtp_pass', ''),
  ('email_from', ''),
  ('email_to', ''),
  ('alert_high_interaction_threshold', '500'),
  ('alert_negative_burst_count', '5'),
  ('alert_negative_burst_window_minutes', '60'),
  ('alert_high_danger_keywords', '安全,隐私,泄露,事故,召回,起火,失控,刹车失灵'),
  ('feishu_app_token', ''),
  ('feishu_table_id', ''),
  ('report_daily_enabled', 'true'),
  ('report_daily_time', '09:00'),
  ('report_weekly_enabled', 'true'),
  ('report_weekly_day', '1'),
  ('report_weekly_time', '09:00');
