import { Router } from 'express';
import { queryAll } from '../db/init.js';
import { requireSessionUser, requireTenantAccess } from '../middleware/auth.js';
import { normalizeCustomTagKeyword } from '../services/record-custom-tags.js';

const router = Router();

router.use(requireTenantAccess, requireSessionUser);

router.get('/', async (req, res, next) => {
  try {
    const keyword = normalizeCustomTagKeyword(req.query.keyword);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
    const rows = await queryAll(`
      SELECT
        ct.id,
        ct.name,
        COUNT(rct.record_id)::int AS usage_count,
        ct.last_used_at
      FROM custom_tags ct
      LEFT JOIN record_custom_tags rct
        ON rct.tenant_id = ct.tenant_id
        AND rct.tag_id = ct.id
      WHERE ct.tenant_id = $1
        AND ($2 = '' OR strpos(ct.normalized_name, $2) > 0)
      GROUP BY ct.id, ct.name, ct.normalized_name, ct.last_used_at
      ORDER BY
        CASE
          WHEN $2 <> '' AND ct.normalized_name = $2 THEN 0
          WHEN $2 <> '' AND strpos(ct.normalized_name, $2) = 1 THEN 1
          ELSE 2
        END,
        COUNT(rct.record_id) DESC,
        ct.last_used_at DESC,
        ct.name ASC
      LIMIT $3
    `, [req.tenantId, keyword, limit]);

    return res.json({
      ok: true,
      tags: rows.map(row => ({
        id: row.id,
        name: row.name,
        usageCount: Number(row.usage_count || 0),
        lastUsedAt: row.last_used_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
