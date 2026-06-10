import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { getOfficialResponses, getRecordComments } from '../services/comment-workflow.js';

const router = Router();

async function ensureRecord(req, res) {
  const record = await queryOne(
    'SELECT id FROM records WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (!record) {
    res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    return false;
  }
  return true;
}

router.get('/:id/observations', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const observations = await queryAll(
      'SELECT * FROM record_observations WHERE record_id = $1 AND tenant_id = $2 ORDER BY captured_at DESC',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, observations });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/versions', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const versions = await queryAll(
      'SELECT * FROM record_versions WHERE record_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, versions });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/comments', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const comments = await getRecordComments(req.tenantId, req.params.id);
    const officialResponses = await getOfficialResponses(req.tenantId, req.params.id);
    return res.json({ ok: true, comments, officialResponses });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/official-response', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const status = String(req.body?.status || 'responded');
    const note = String(req.body?.note || '');
    const nextStatus = status === 'needs_followup' ? 'needs_followup' : 'responded';
    await withTransaction(async tx => {
      await tx.execute(`
        UPDATE records
        SET official_replied = true,
          official_response_status = $1,
          updated_at = now()
        WHERE id = $2 AND tenant_id = $3
      `, [nextStatus, req.params.id, req.tenantId]);
      await tx.execute(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, note, updated_at)
        VALUES ($1, $2, 'official_responded', 'normal', $3, $4, $5, now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET status = 'official_responded',
          owner_user_id = excluded.owner_user_id,
          owner_name = excluded.owner_name,
          note = excluded.note,
          updated_at = now()
      `, [req.tenantId, req.params.id, req.user?.id || null, req.actorName || '', note]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $3, 'record.official_response_marked', 'record', $4, $5::jsonb)
      `, [req.tenantId, req.user?.id || '', req.user?.id || null, req.params.id, JSON.stringify({ status: nextStatus, note })]);
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
