import { Router } from 'express';

import { requireAuthCodeFirst, requireTenantWriter } from '../middleware/auth.js';
import { PrefilterRequestError, prefilterRelevanceBatch } from '../services/relevance-prefilter.js';

const router = Router();

router.post('/', requireAuthCodeFirst, requireTenantWriter, async (req, res) => {
  try {
    const result = await prefilterRelevanceBatch({
      tenantId: req.tenantId,
      body: req.body || {},
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PrefilterRequestError) {
      const retryAfterMs = Number(error.details?.retryAfterMs || 0);
      if (retryAfterMs > 0) res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        message: error.message,
        failOpen: true,
        retryAfterMs: retryAfterMs || undefined,
      });
    }
    console.error('[RelevancePrefilter] Unexpected backend failure:', error?.message || error);
    return res.status(503).json({
      ok: false,
      error: 'PREFILTER_UNAVAILABLE',
      message: 'AI 前置筛选暂不可用，请继续原采集流程',
      failOpen: true,
    });
  }
});

export default router;
