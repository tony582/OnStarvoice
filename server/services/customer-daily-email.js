import {requeueDailySuccess,validateDailyResend} from './customer-daily-resend.js';
import {randomUUID} from 'node:crypto';
import {queryAll,queryOne,execute,withTransaction} from '../db/init.js';
import {sendTenantEmail,tenantEmailReadiness} from './email-notifier.js';
import {dailyError,normalizeDailyEmailRecipients} from './customer-daily-report-config.js';
import {renderCustomerDailyReportHtml,renderCustomerDailyReportText,buildCustomerDailyReportWorkbook} from './customer-daily-report-data.js';

const defaultDb = {queryAll,queryOne,execute,withTransaction};
const iso = value => value ? new Date(value).toISOString() : null;

export function publicDailyEmailDelivery(row) {
  if (!row) return {status:'none',canRetry:false,ambiguous:false};
  return {sendId:row.id,status:row.status,recipients:row.recipients,sentAt:iso(row.sent_at),error:row.error_message || null,
    ambiguous:!!row.ambiguous,canRetry:row.status === 'failed' && !row.ambiguous};
}

export async function buildDailyEmailMessage(snapshot) {
  const workbook = await buildCustomerDailyReportWorkbook(snapshot);
  const buffer = await workbook.xlsx.writeBuffer();
  return {html:renderCustomerDailyReportHtml(snapshot),text:renderCustomerDailyReportText(snapshot),
    attachments:[{filename:`客户日报_${snapshot.reportDate}_v${snapshot.version}.xlsx`,
      content:Buffer.from(buffer),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}]};
}

function definiteMailFailure(error) {
  if (error?.accepted?.length) return false;
  return ['SMTP_NOT_CONFIGURED','EMAIL_RECIPIENT_NOT_CONFIGURED','EAUTH','ECONNECTION','ETLS','EENVELOPE'].includes(error?.code)
    || (Number(error?.responseCode) >= 400 && Number(error?.responseCode) <= 599);
}

function safeEmailFailure(error,{sending = false} = {}) {
  const ambiguous = sending && !definiteMailFailure(error);
  const message = error?.code === 'SMTP_NOT_CONFIGURED' ? '邮件服务尚未配置，请联系管理员在设置中配置。'
    : error?.code === 'EAUTH' ? '邮件服务认证失败，请联系管理员检查发送账号。'
    : ambiguous ? '邮件发送结果尚未确认，已停止重试。请管理员核对发件记录后处理，避免重复发送。'
    : sending ? '邮件未发送成功，请检查邮件服务及收件人后重试。'
    : '邮件内容准备失败，请稍后重试。';
  return {ambiguous,message};
}

export function createCustomerDailyEmailService({db = defaultDb,send = sendTenantEmail,readiness = tenantEmailReadiness,buildMessage = buildDailyEmailMessage} = {}) {
  async function configuration(tenantId) {
    const row = await db.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1',[tenantId]);
    const recipients = normalizeDailyEmailRecipients(row?.config?.emailRecipients || '');
    if (!recipients) return {emailReady:false,emailConfigError:'日报收件人尚未配置，请联系管理员在设置中填写。'};
    const smtp = await readiness(tenantId);
    return {emailReady:!!smtp.ready,emailConfigError:smtp.ready ? null : '邮件服务尚未配置，请联系管理员在设置中配置。'};
  }

  async function delivery(tenantId,reportId) {
    return publicDailyEmailDelivery(await db.queryOne('SELECT id,status,recipients,sent_at,error_message,ambiguous FROM customer_daily_email_deliveries WHERE tenant_id=$1 AND report_id=$2',[tenantId,reportId]));
  }

  async function deliveries(tenantId,reportIds) {
    if (!reportIds.length) return new Map();
    const rows = await db.queryAll('SELECT id,report_id,status,recipients,sent_at,error_message,ambiguous FROM customer_daily_email_deliveries WHERE tenant_id=$1 AND report_id=ANY($2::uuid[])',[tenantId,reportIds]);
    return new Map(rows.map(row => [row.report_id,publicDailyEmailDelivery(row)]));
  }

  async function enqueue(tenantId,reportId,{resendOf,actorId} = {}) {
    validateDailyResend(resendOf);
    await db.withTransaction(async tx => {
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`daily-email:${tenantId}:${reportId}`]);
      const report = await tx.queryOne('SELECT snapshot,report_date::text AS report_date,version FROM customer_daily_reports WHERE tenant_id=$1 AND id=$2',[tenantId,reportId]);
      if (!report) throw dailyError('日报不存在',404,'daily_report_not_found');
      const previous = await tx.queryOne('SELECT * FROM customer_daily_email_deliveries WHERE tenant_id=$1 AND report_id=$2 FOR UPDATE',[tenantId,reportId]);
      if (previous?.status === 'sent' && resendOf) {
        if (!(await readiness(tenantId)).ready) throw dailyError('邮件服务尚未配置。',409,'daily_email_not_configured');
        await requeueDailySuccess(tx,{table:'customer_daily_email_deliveries',tenantId,reportId,resendOf,actorId});
        return;
      }
      if (previous && !(previous.status === 'failed' && !previous.ambiguous)) return;
      if (!(await readiness(tenantId)).ready) throw dailyError('邮件服务尚未配置，请联系管理员在设置中配置。',409,'daily_email_not_configured');
      if (previous) {
        // Retry the exact frozen recipient list and report version; config edits
        // never redirect a delivery that the user already requested.
        await tx.execute("UPDATE customer_daily_email_deliveries SET status='queued',error_message=NULL,claim_token=NULL,claimed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,previous.id]);
        return;
      }
      const stored = await tx.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1',[tenantId]);
      const recipients = normalizeDailyEmailRecipients(stored?.config?.emailRecipients || '');
      if (!recipients) throw dailyError('日报收件人尚未配置，请联系管理员在设置中填写。',409,'daily_email_recipients_missing');
      const tenantName = String(report.snapshot.tenantName || '客户').replace(/[\r\n]/g,' ').slice(0,100);
      const subject = `${tenantName}舆情日报 · ${report.report_date} · v${report.version}`;
      await tx.execute(`INSERT INTO customer_daily_email_deliveries (id,tenant_id,report_id,recipients,subject,snapshot)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[randomUUID(),tenantId,reportId,recipients,subject,JSON.stringify(report.snapshot)]);
    },{category:'reporting',statementTimeoutMs:15000,lockTimeoutMs:3000,jitOff:true});
    return delivery(tenantId,reportId);
  }

  async function recoverStale() {
    await db.execute(`UPDATE customer_daily_email_deliveries SET status='failed',ambiguous=true,
      error_message='上次邮件发送中断，发送结果待核实；已停止重试，避免重复发送。',claim_token=NULL,updated_at=now()
      WHERE status='working' AND claimed_at<now()-interval '10 minutes'`);
  }

  async function processOne() {
    const token = randomUUID();
    const row = await db.withTransaction(async tx => {
      const next = await tx.queryOne("SELECT * FROM customer_daily_email_deliveries WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");
      if (!next) return null;
      await tx.execute("UPDATE customer_daily_email_deliveries SET status='working',claim_token=$2,claimed_at=now(),attempts=attempts+1,error_message=NULL,updated_at=now() WHERE id=$1",[next.id,token]);
      return next;
    },{category:'reporting',statementTimeoutMs:10000,lockTimeoutMs:1000,jitOff:true});
    if (!row) return false;
    let sending = false;
    try {
      const message = await buildMessage(structuredClone(row.snapshot));
      // The worker sends only the saved snapshot, destination and tenant context.
      sending = true;
      const result = await send({...message,tenantId:row.tenant_id,to:row.recipients,subject:row.subject,
        messageId:`<daily-report-${row.id}@starvoice.local>`});
      const expected = row.recipients.split(',').map(value => value.trim().toLowerCase());
      const accepted = new Set((Array.isArray(result?.accepted) ? result.accepted : []).map(value => String(value?.address || value).toLowerCase()));
      if (!expected.every(address => accepted.has(address)) || result?.rejected?.length) {
        // Partial acceptance cannot be retried as a group without duplicates.
        const rejected = new Set((Array.isArray(result?.rejected) ? result.rejected : []).map(value => String(value?.address || value).toLowerCase()));
        const code = accepted.size ? 'DAILY_EMAIL_PARTIAL' : expected.every(address => rejected.has(address)) ? 'EENVELOPE' : 'DAILY_EMAIL_UNCONFIRMED';
        throw Object.assign(new Error('Mail acceptance incomplete'),{code});
      }
      await db.execute("UPDATE customer_daily_email_deliveries SET status='sent',message_id=$4,sent_at=now(),error_message=NULL,ambiguous=false,claim_token=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='working'",[row.tenant_id,row.id,token,String(result.messageId || '')]);
    } catch (error) {
      const failure = safeEmailFailure(error,{sending});
      await db.execute("UPDATE customer_daily_email_deliveries SET status='failed',ambiguous=$4,error_message=$5,claim_token=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='working'",[row.tenant_id,row.id,token,failure.ambiguous,failure.message]);
    }
    return true;
  }
  return {configuration,delivery,deliveries,enqueue,recoverStale,processOne};
}
