import { Router } from 'express';
import { getSetting, setSetting } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter, isTenantWriter } from '../middleware/auth.js';

const router = Router();

router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const rawToken = await getSetting('feishu_app_token', req.tenantId);
    // 飞书 token 只对 writer(扩展激活码 actorType=auth_code 恒 writer / 管理员)返原值供同步用;
    // 普通只读 viewer 返掩码,避免密钥被只读用户读出来(review 安全项 ④)。
    const config = {
      feishuAppToken: isTenantWriter(req) ? rawToken : rawToken ? '***' : '',
      feishuTableId: await getSetting('feishu_table_id', req.tenantId),
    };

    return res.json({ ok: true, config });
  } catch (err) {
    return next(err);
  }
});

router.put('/', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { feishuAppToken, feishuTableId } = req.body;

    if (feishuAppToken !== undefined) await setSetting('feishu_app_token', feishuAppToken, req.tenantId);
    if (feishuTableId !== undefined) await setSetting('feishu_table_id', feishuTableId, req.tenantId);

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
