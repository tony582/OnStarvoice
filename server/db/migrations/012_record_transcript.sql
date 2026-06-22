-- 视频逐字稿:把抖音/小红书视频口播转写成文本,补齐"视频内容盲区",
-- 供 AI 情感/风险/关键词分析与报告使用。转写走阿里云百炼(DashScope)Paraformer 录音文件识别。
-- 因百炼只认公网 URL 且抖音直链有 Referer 防盗链+时效,转写时由 server 带 Referer 下载、
-- 临时公网托管后交百炼,故需记录状态机以便重试。

ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript TEXT NOT NULL DEFAULT '';
-- none(未转写) / pending(已排队) / processing(转写中) / done(完成) / failed(失败) / expired(直链已过期需重采) / no_media(无可转写视频)
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_lang TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_error TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_updated_at TIMESTAMPTZ;

-- 找"待转写/转写中"记录用(将来做自动重试/批量补转)
CREATE INDEX IF NOT EXISTS idx_records_transcript_status
  ON records (tenant_id, transcript_status)
  WHERE transcript_status IN ('pending', 'processing');
