import { Router } from 'express';
import { queryAll } from '../db/init.js';
import { requireTenantAccess } from '../middleware/auth.js';

const router = Router();

const HEAT_ORDER = `CASE heat_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

// 赛道大盘:每个关键词取最近一次赛道策略结果
router.get('/tracks', requireTenantAccess, async (req, res, next) => {
  try {
    const rows = await queryAll(`
      SELECT DISTINCT ON (keyword)
        id, keyword, platform, heat_level, cliff_drop_ratio, sample_count, direction_count, angle_count, payload, created_at
      FROM track_strategies
      WHERE tenant_id = $1
      ORDER BY keyword, created_at DESC
    `, [req.tenantId]);
    rows.sort((a, b) => {
      const order = { high: 1, medium: 2, low: 3 };
      return (order[a.heat_level] || 4) - (order[b.heat_level] || 4) || new Date(b.created_at) - new Date(a.created_at);
    });
    return res.json({ ok: true, tracks: rows });
  } catch (err) { return next(err); }
});

// 对标账号库:最近的对标分析
router.get('/benchmarks', requireTenantAccess, async (req, res, next) => {
  try {
    const rows = await queryAll(`
      SELECT id, keyword, platform, candidate_count, payload, created_at
      FROM benchmark_results
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.tenantId]);
    return res.json({ ok: true, benchmarks: rows });
  } catch (err) { return next(err); }
});

// 选题与扩词:最近的扩词分析
router.get('/keywords', requireTenantAccess, async (req, res, next) => {
  try {
    const rows = await queryAll(`
      SELECT DISTINCT ON (seed_keyword)
        id, seed_keyword, platform, keyword_count, payload, created_at
      FROM keyword_expansions
      WHERE tenant_id = $1
      ORDER BY seed_keyword, created_at DESC
    `, [req.tenantId]);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ ok: true, keywords: rows });
  } catch (err) { return next(err); }
});

export default router;
