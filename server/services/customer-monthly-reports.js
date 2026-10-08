import {randomUUID} from 'node:crypto';
import {queryAll, queryOne, execute, withTransaction} from '../db/init.js';
import {collectCustomerMonthlyReport, customerMonthlyPeriod} from './customer-monthly-report-data.js';
import {createCustomerMonthlyEmailService, publicMonthlyEmailDelivery} from './customer-monthly-email.js';
import {dailyError, publicDailyConfig} from './customer-daily-report-config.js';

const defaultDb = {queryAll, queryOne, execute, withTransaction};
const iso = value => value ? new Date(value).toISOString() : null;
const monthText = value => typeof value === 'string' ? value.slice(0, 7) : new Date(value).toISOString().slice(0, 7);
const REQUEST_ID = /^[a-zA-Z0-9:_-]{1,160}$/;

export function publicMonthlySnapshot(snapshot, {includeRecords = false} = {}) {
  if (!snapshot || includeRecords) return snapshot;
  const {records, ...rest} = snapshot;
  return {...rest, recordCount: Array.isArray(records) ? records.length : Number(rest.evidence?.recordCount) || 0};
}

export function createCustomerMonthlyReportService({db = defaultDb, collect = collectCustomerMonthlyReport, now = () => new Date(), emailOptions = {}} = {}) {
  const emailService = createCustomerMonthlyEmailService({...emailOptions, db});
  async function settings(tenantId) {
    // The monthly report mails the same customer recipients as the daily report.
    const row = await db.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1', [tenantId]);
    return {emailRecipients: publicDailyConfig(row?.config).emailRecipients, ...await emailService.configuration(tenantId)};
  }
  async function report(tenantId, id, {includeSnapshot = true, includeRecords = false} = {}) {
    const row = await db.queryOne(`SELECT id,report_month::text AS report_month,mode,version,generated_at${includeSnapshot ? ',snapshot' : ''} FROM customer_monthly_reports WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!row) return null;
    return {id: row.id, reportMonth: monthText(row.report_month), mode: row.mode, version: row.version, generatedAt: iso(row.generated_at),
      ...(includeSnapshot ? {snapshot: publicMonthlySnapshot(row.snapshot, {includeRecords})} : {}), emailDelivery: await emailService.delivery(tenantId, id)};
  }
  async function list(tenantId, month) {
    if (month) customerMonthlyPeriod(month, now());
    const rows = await db.queryAll(`SELECT id,report_month::text AS report_month,mode,version,generated_at FROM customer_monthly_reports
      WHERE tenant_id=$1 AND ($2::date IS NULL OR report_month=$2::date) ORDER BY report_month DESC,version DESC LIMIT 50`, [tenantId, month ? `${month}-01` : null]);
    const deliveries = await emailService.deliveries(tenantId, rows.map(row => row.id));
    return rows.map(row => ({id: row.id, reportMonth: monthText(row.report_month), mode: row.mode, version: row.version, generatedAt: iso(row.generated_at),
      emailDelivery: deliveries.get(row.id) || publicMonthlyEmailDelivery(null)}));
  }
  async function generate(tenantId, {month, requestId = randomUUID()} = {}) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw dailyError('生成请求标识无效');
    const generationTime = now();
    const period = customerMonthlyPeriod(month, generationTime);
    for (let retry = 0; retry < 3; retry++) {
      try {
        const id = await db.withTransaction(async tx => {
          await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`customer-monthly:${tenantId}:${period.reportMonth}`]);
          const previous = await tx.queryOne('SELECT id,report_month::text AS report_month FROM customer_monthly_reports WHERE tenant_id=$1 AND request_key=$2', [tenantId, requestId]);
          if (previous) {
            if (monthText(previous.report_month) !== period.reportMonth) throw dailyError('同一生成请求不能用于不同月份');
            return previous.id;
          }
          const snapshot = await collect({tenantId, month: period.reportMonth, now: generationTime, db: tx, period});
          const version = Number((await tx.queryOne('SELECT COALESCE(MAX(version),0)+1 AS version FROM customer_monthly_reports WHERE tenant_id=$1 AND report_month=$2', [tenantId, `${period.reportMonth}-01`])).version);
          const reportId = randomUUID();
          const frozen = {...snapshot, id: reportId, version};
          await tx.execute('INSERT INTO customer_monthly_reports (id,tenant_id,report_month,mode,version,request_key,snapshot,generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
            [reportId, tenantId, `${period.reportMonth}-01`, period.mode, version, requestId, JSON.stringify(frozen), frozen.assessedAt]);
          return reportId;
        }, {category: 'reporting', isolationLevel: 'repeatable_read', statementTimeoutMs: 120000, lockTimeoutMs: 1000, jitOff: true});
        return report(tenantId, id);
      } catch (error) {
        if (retry < 2 && ['40001', '23505', '55P03'].includes(error.code)) continue;
        throw error;
      }
    }
  }
  async function sendEmail(tenantId, id, options = {}) {
    await emailService.enqueue(tenantId, id, options);
    return report(tenantId, id);
  }
  async function processDue({limit = 5} = {}) {
    await emailService.recoverStale();
    let processed = 0;
    for (let i = 0; i < Math.min(10, Math.max(1, limit)); i++) {
      if (!await emailService.processOne()) break;
      processed++;
    }
    return {processed};
  }
  return {settings, report, list, generate, sendEmail, processDue};
}

export const customerMonthlyReports = createCustomerMonthlyReportService();
export const processCustomerMonthlyReports = options => customerMonthlyReports.processDue(options);
