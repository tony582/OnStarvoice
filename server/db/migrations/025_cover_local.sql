-- 封面图落地:存我们自己下载的本地副本路径(/media/covers/<id>.<ext>)。
-- 平台封面是限时签名链接(小红书路径带时间戳、约1天过期),过期后图裂;
-- 入库时趁链接新鲜下载落地,列表/详情优先读本地副本,永不过期。
ALTER TABLE records ADD COLUMN IF NOT EXISTS cover_local TEXT NOT NULL DEFAULT '';
