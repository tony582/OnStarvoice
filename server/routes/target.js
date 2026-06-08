import { Router } from 'express';
import { getDb, getSetting, setSetting } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/target
 * 读取同步配置
 */
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const config = {
    feishuAppToken: getSetting('feishu_app_token'),
    feishuTableId: getSetting('feishu_table_id'),
  };

  return res.json({ ok: true, config });
});

/**
 * PUT /api/target
 * 保存同步配置
 */
router.put('/', requireAuth, (req, res) => {
  const { feishuAppToken, feishuTableId } = req.body;

  if (feishuAppToken !== undefined) setSetting('feishu_app_token', feishuAppToken);
  if (feishuTableId !== undefined) setSetting('feishu_table_id', feishuTableId);

  return res.json({ ok: true });
});

export default router;
