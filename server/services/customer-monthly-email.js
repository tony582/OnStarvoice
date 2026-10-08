import {createCustomerDailyEmailService, publicDailyEmailDelivery} from './customer-daily-email.js';
import {renderCustomerMonthlyReportHtml, renderCustomerMonthlyReportText, buildCustomerMonthlyReportWorkbook, buildCustomerMonthlyDetailWorkbook} from './customer-monthly-report-render.js';

export const MONTHLY_EMAIL_KIND = Object.freeze({table: 'customer_monthly_email_deliveries', reportTable: 'customer_monthly_reports', periodColumn: 'report_month',
  lock: 'monthly-email', messageIdPrefix: 'monthly-report', notFound: '月报不存在', notFoundCode: 'monthly_report_not_found',
  periodText: value => String(value).slice(0, 7), subject: ({tenantName, period, version}) => `${tenantName}舆情月报 · ${period} · v${version}`});

export const publicMonthlyEmailDelivery = publicDailyEmailDelivery;

/** The frozen snapshot carries its own detail rows, so the attachments match the saved version exactly. */
export async function buildMonthlyEmailMessage(snapshot) {
  const summary = await buildCustomerMonthlyReportWorkbook(snapshot).xlsx.writeBuffer();
  const detail = await buildCustomerMonthlyDetailWorkbook(snapshot).xlsx.writeBuffer();
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return {html: renderCustomerMonthlyReportHtml(snapshot, {email: true}), text: renderCustomerMonthlyReportText(snapshot),
    attachments: [
      {filename: `客户月报_${snapshot.reportMonth}_v${snapshot.version}.xlsx`, content: Buffer.from(summary), contentType: type},
      {filename: `客户月报明细_${snapshot.reportMonth}_v${snapshot.version}.xlsx`, content: Buffer.from(detail), contentType: type},
    ]};
}

export function createCustomerMonthlyEmailService(options = {}) {
  return createCustomerDailyEmailService({buildMessage: buildMonthlyEmailMessage, ...options, kind: MONTHLY_EMAIL_KIND});
}
