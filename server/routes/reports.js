import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { generateReport, resendReport } from '../services/report-generator.js';

const router = Router();

router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const { type, limit = 50 } = req.query;
    const params = [req.tenantId];
    let where = 'WHERE tenant_id = $1';
    if (type) { params.push(type); where += ` AND report_type = $${params.length}`; }
    params.push(Math.min(100, Math.max(1, Number(limit))));
    const reports = await queryAll(
      `SELECT id, report_type, period_start, period_end, status, subject, generated_at, sent_at, error_message, created_at, updated_at
       FROM report_runs ${where}
       ORDER BY period_start DESC
       LIMIT $${params.length}`,
      params
    );
    return res.json({ ok: true, reports });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', requireTenantAccess, async (req, res, next) => {
  try {
    const report = await queryOne(
      'SELECT * FROM report_runs WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!report) return res.status(404).json({ ok: false, error: 'not_found', message: '报告不存在' });
    const snapshot = await queryOne(
      'SELECT data FROM report_snapshots WHERE report_run_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, report: { ...report, snapshot: snapshot?.data || null } });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/preview', requireTenantAccess, async (req, res, next) => {
  try {
    const report = await queryOne(
      'SELECT * FROM report_runs WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!report) return res.status(404).json({ ok: false, error: 'not_found', message: '报告不存在' });
    const snapshot = await queryOne(
      'SELECT data FROM report_snapshots WHERE report_run_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, report, snapshot: snapshot?.data || null, html: report.html });
  } catch (err) {
    return next(err);
  }
});

router.post('/generate', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { type = 'daily', send = false } = req.body;
    const report = await generateReport({ tenantId: req.tenantId, type, send: send !== false });
    return res.json({ ok: true, report });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/send', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const report = await resendReport(req.params.id, req.tenantId);
    if (!report) return res.status(404).json({ ok: false, error: 'not_found', message: '报告不存在' });
    return res.json({ ok: true, report });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/resend', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const report = await resendReport(req.params.id, req.tenantId);
    if (!report) return res.status(404).json({ ok: false, error: 'not_found', message: '报告不存在' });
    return res.json({ ok: true, report });
  } catch (err) {
    return next(err);
  }
});

export default router;
