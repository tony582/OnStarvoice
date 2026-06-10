import { Router } from 'express';
import { getSetting, setSetting } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const config = {
      feishuAppToken: await getSetting('feishu_app_token', req.tenantId),
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
