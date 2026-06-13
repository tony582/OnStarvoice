import { Router } from 'express';
import { queryAll, queryOne, execute } from '../db/init.js';
import { requireTenantAccess } from '../middleware/auth.js';
import { analyzeHit } from '../services/hit-analyzer.js';

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

// 爆款拆解:候选 = 已采集的高互动内容(直接用 records,不需新采集)
router.get('/hits', requireTenantAccess, async (req, res, next) => {
  try {
    const platform = String(req.query.platform || '');
    const params = [req.tenantId];
    let where = `WHERE r.tenant_id = $1 AND COALESCE(r.title, r.content) <> ''`;
    if (platform) { params.push(platform); where += ` AND r.platform = $${params.length}`; }
    const rows = await queryAll(`
      SELECT r.id, r.platform, r.title, r.content, r.author_name, r.cover_url, r.url,
        r.likes, r.comments_count, r.collects, r.shares, r.tags, r.sentiment, r.category, r.last_seen_at,
        (r.likes + r.comments_count + r.collects + r.shares) AS interaction,
        (ha.id IS NOT NULL) AS analyzed
      FROM records r
      LEFT JOIN hit_analyses ha ON ha.record_id = r.id AND ha.tenant_id = r.tenant_id
      ${where}
      ORDER BY interaction DESC
      LIMIT 60
    `, params);
    return res.json({ ok: true, hits: rows });
  } catch (err) { return next(err); }
});

// 拆解一条(已缓存则直接返回,否则算并缓存)
router.post('/hits/:recordId/analyze', requireTenantAccess, async (req, res, next) => {
  try {
    const record = await queryOne(`SELECT * FROM records WHERE id = $1 AND tenant_id = $2`, [req.params.recordId, req.tenantId]);
    if (!record) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });

    const cached = await queryOne(`SELECT payload, source FROM hit_analyses WHERE tenant_id = $1 AND record_id = $2`, [req.tenantId, req.params.recordId]);
    if (cached && !req.query.refresh) {
      return res.json({ ok: true, analysis: cached.payload, source: cached.source, cached: true });
    }

    const analysis = await analyzeHit(req.tenantId, record);
    await execute(`
      INSERT INTO hit_analyses (tenant_id, record_id, payload, source)
      VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (tenant_id, record_id) DO UPDATE SET payload = excluded.payload, source = excluded.source, created_at = now()
    `, [req.tenantId, req.params.recordId, JSON.stringify(analysis), analysis.source]);
    return res.json({ ok: true, analysis, source: analysis.source, cached: false });
  } catch (err) { return next(err); }
});

export default router;
