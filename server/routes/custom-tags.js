import { Router } from 'express';
import { queryAll, withTransaction } from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  normalizeCustomTagId,
  normalizeCustomTagKeyword,
} from '../services/record-custom-tags.js';

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

router.delete('/:id', requireTenantWriter, async (req, res, next) => {
  try {
    const normalizedId = normalizeCustomTagId(req.params.id);
    if (!normalizedId.ok) {
      return res.status(400).json({
        ok: false,
        error: normalizedId.error,
        message: normalizedId.message,
      });
    }

    const actorUserId = req.user?.id || null;
    const result = await withTransaction(async tx => {
      const tag = await tx.queryOne(`
        SELECT id, name
        FROM custom_tags
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `, [req.tenantId, normalizedId.value]);
      if (!tag) return null;

      const usage = await tx.queryOne(`
        SELECT COUNT(*)::int AS affected_records
        FROM record_custom_tags
        WHERE tenant_id = $1 AND tag_id = $2
      `, [req.tenantId, tag.id]);
      const affectedRecords = Number(usage?.affected_records || 0);

      // FK ON DELETE CASCADE 仅解除该标签与所有内容的关联；
      // 不会删除内容记录，也不会影响其他标签。
      await tx.execute(`
        DELETE FROM custom_tags
        WHERE tenant_id = $1 AND id = $2
      `, [req.tenantId, tag.id]);

      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES ($1, 'user', $2, $3, 'custom_tag.deleted', 'custom_tag', $4, $5::jsonb)
      `, [
        req.tenantId,
        actorUserId || '',
        actorUserId,
        tag.id,
        JSON.stringify({
          tagName: tag.name,
          affectedRecords,
        }),
      ]);

      return {
        id: String(tag.id),
        name: String(tag.name),
        affectedRecords,
      };
    });

    if (!result) {
      return res.status(404).json({
        ok: false,
        error: 'tag_not_found',
        message: '标签不存在或已删除',
      });
    }
    return res.json({ok: true, tag: result, affectedRecords: result.affectedRecords});
  } catch (err) {
    return next(err);
  }
});

export default router;
