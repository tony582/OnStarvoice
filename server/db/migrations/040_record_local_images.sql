-- 正文图片和封面一样需要在采集链接有效期内落地，避免平台 CDN 地址过期后显示裂图。
ALTER TABLE records
  ADD COLUMN IF NOT EXISTS image_local_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
