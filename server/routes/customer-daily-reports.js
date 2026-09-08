import {Router} from 'express';
import {requireTenantAccess,requireTenantWriter,requireSessionUser,requireAdmin} from '../middleware/auth.js';
import {customerDailyReports} from '../services/customer-daily-reports.js';
import {renderCustomerDailyReportHtml,renderCustomerDailyReportText,buildCustomerDailyReportWorkbook} from '../services/customer-daily-report-data.js';

export function createCustomerDailyReportRouter(service = customerDailyReports) {
  const router = Router();
  router.use(requireTenantAccess,requireSessionUser);
  const handle = fn => async (req,res,next) => {
    try { await fn(req,res); }
    catch (error) {
      if (error.status || error.statusCode) return res.status(error.status || error.statusCode).json({ok:false,error:error.code || 'daily_report_error',message:error.message});
      return next(error);
    }
  };
  router.get('/settings',handle(async (req,res) => res.json({ok:true,settings:await service.settings(req.tenantId)})));
  router.put('/settings',requireAdmin,handle(async (req,res) => res.json({ok:true,settings:await service.saveSettings(req.tenantId,req.body)})));
  router.get('/',handle(async (req,res) => res.json({ok:true,reports:await service.list(req.tenantId,req.query.date)})));
  router.post('/generate',requireTenantWriter,handle(async (req,res) => res.json({ok:true,report:await service.generate(req.tenantId,{date:req.body?.date,requestId:req.body?.requestId})})));
  router.param('id',(req,res,next,id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? next() : res.status(404).json({ok:false,message:'日报不存在'}));
  router.get('/:id',handle(async (req,res) => {
    const report = await service.report(req.tenantId,req.params.id);
    if (!report) return res.status(404).json({ok:false,message:'日报不存在'});
    res.set('Cache-Control','no-store');
    return res.json({ok:true,report,html:renderCustomerDailyReportHtml(report.snapshot),text:renderCustomerDailyReportText(report.snapshot)});
  }));
  router.get('/:id/excel',handle(async (req,res) => {
    const report = await service.report(req.tenantId,req.params.id);
    if (!report) return res.status(404).json({ok:false,message:'日报不存在'});
    const workbook = await buildCustomerDailyReportWorkbook(report.snapshot);
    const buffer = await workbook.xlsx.writeBuffer();
    res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(`客户日报_${report.reportDate}_v${report.version}_系统原版.xlsx`)}`);
    res.set('Cache-Control','no-store');
    return res.send(Buffer.from(buffer));
  }));
  for (const action of ['document','send']) router.post(`/:id/${action}`,requireTenantWriter,handle(async (req,res) => {
    const report = await service.enqueue(req.tenantId,req.params.id,{send:action === 'send',allowIncomplete:req.body?.allowIncomplete === true,correction:action === 'send' && req.body?.correction === true});
    return res.status(202).json({ok:true,report});
  }));
  return router;
}

export default createCustomerDailyReportRouter();
