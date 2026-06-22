-- 020_broaden_brand_scope.sql
-- 放宽相关性监控范围到「上汽通用」品牌家族。原 brand_business_context 只写了安吉星服务,
-- 导致别克/凯迪拉克内容(含车机壁纸)被 AI 判为"无安吉星业务 → irrelevant"。
-- 安吉星实际监控范围是整个上汽通用(别克/凯迪拉克/雪佛兰),壁纸/周边也在范围内。
UPDATE tenant_settings
SET value = '监控范围为上汽通用(SAIC-GM)整个品牌家族:安吉星(OnStar)及其所属的别克、凯迪拉克、雪佛兰。涵盖这些品牌的车型、车机系统与车机壁纸、车联网、安全救援、远程控制、续费、客服、官方与经销商动态、周边活动、车主体验等。凡涉及上述任一品牌或其产品、车机、周边的内容,均属监控范围。'
WHERE key = 'brand_business_context';
