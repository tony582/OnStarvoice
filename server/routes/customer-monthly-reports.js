import {Router} from 'express';
import {requireTenantAccess, requireTenantWriter, requireSessionUser} from '../middleware/auth.js';
import {customerMonthlyReports} from '../services/customer-monthly-reports.js';
import {renderCustomerMonthlyReportHtml, renderCustomerMonthlyReportText, buildCustomerMonthlyReportWorkbook, buildCustomerMonthlyDetailWorkbook} from '../services/customer-monthly-report-render.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function createCustomerMonthlyReportRouter(service = customerMonthlyReports) {
  const router = Router();
  router.use(requireTenantAccess, requireSessionUser);
  const handle = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (error) {
      if (error.status || error.statusCode) return res.status(error.status || error.statusCode).json({ok: false, error: error.code || 'monthly_report_error', message: error.message});
      return next(error);
    }
  };
  const sendWorkbook = async (res, workbook, filename) => {
    const buffer = await workbook.xlsx.writeBuffer();
    res.set('Content-Type', XLSX);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.set('Cache-Control', 'no-store');
    return res.send(Buffer.from(buffer));
  };
  router.get('/settings', handle(async (req, res) => res.json({ok: true, settings: await service.settings(req.tenantId)})));
  router.get('/', handle(async (req, res) => res.json({ok: true, reports: await service.list(req.tenantId, req.query.month)})));
  router.post('/generate', requireTenantWriter, handle(async (req, res) => res.json({ok: true, report: await service.generate(req.tenantId, {month: req.body?.month, requestId: req.body?.requestId})})));
  router.param('id', (req, res, next, id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? next() : res.status(404).json({ok: false, message: '月报不存在'}));
  router.post('/:id/email', requireTenantWriter, handle(async (req, res) => {
    const report = await service.sendEmail(req.tenantId, req.params.id, {resendOf: req.body?.resendOf, actorId: req.user?.id});
    return res.status(202).json({ok: true, report});
  }));
  router.get('/:id', handle(async (req, res) => {
    const report = await service.report(req.tenantId, req.params.id);
    if (!report) return res.status(404).json({ok: false, message: '月报不存在'});
    res.set('Cache-Control', 'no-store');
    return res.json({ok: true, report, html: renderCustomerMonthlyReportHtml(report.snapshot), text: renderCustomerMonthlyReportText(report.snapshot)});
  }));
  router.get('/:id/excel', handle(async (req, res) => {
    const report = await service.report(req.tenantId, req.params.id, {includeRecords: true});
    if (!report) return res.status(404).json({ok: false, message: '月报不存在'});
    return sendWorkbook(res, buildCustomerMonthlyReportWorkbook(report.snapshot), `客户月报_${report.reportMonth}_v${report.version}.xlsx`);
  }));
  router.get('/:id/detail.xlsx', handle(async (req, res) => {
    const report = await service.report(req.tenantId, req.params.id, {includeRecords: true});
    if (!report) return res.status(404).json({ok: false, message: '月报不存在'});
    return sendWorkbook(res, buildCustomerMonthlyDetailWorkbook(report.snapshot), `客户月报明细_${report.reportMonth}_v${report.version}.xlsx`);
  }));
  return router;
}

export default createCustomerMonthlyReportRouter();
