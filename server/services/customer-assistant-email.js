import {randomUUID} from 'node:crypto';
import {queryAll,queryOne,execute,withTransaction} from '../db/init.js';
import {sendTenantEmail,tenantEmailReadiness} from './email-notifier.js';
import {buildDailyEmailMessage} from './customer-daily-email.js';

const defaultDb = {queryAll,queryOne,execute,withTransaction};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE = '邮件使用系统保存的日报版本，包含可编辑 Excel 附件；不包含客户之后在飞书文档中的修改。';
const fail = (code,message,status = 400) => Object.assign(new Error(message),{code,status,safeMessage:message});
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const mask = value => { const [local,domain] = String(value || '').split('@'); return domain ? `${local.slice(0,1)}***@${domain}` : ''; };

function identity(context) {
  for (const key of ['tenantId','chatId','senderId','requestId']) {
    if (typeof context?.[key] !== 'string' || !context[key].trim() || context[key].length > 256 || /[\r\n\0]/.test(context[key])) {
      throw fail('assistant_context_invalid','机器人身份绑定不完整。',403);
    }
  }
  if (context.emailAllowed !== true) throw fail('assistant_email_forbidden','当前成员未开通日报邮件权限。',403);
  const recipient = typeof context.email === 'string' ? context.email.trim().toLowerCase() : '';
  if (recipient.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(recipient)) {
    throw fail('assistant_email_unbound','请管理员先绑定并核实您的单个收件邮箱。',403);
  }
  return recipient;
}

export function publicCustomerAssistantEmail(row) {
  return {id:row.id || null,deliveryId:row.id || null,status:row.ambiguous ? 'unknown' : row.status === 'working' ? 'queued' : row.status,
    reportId:row.report_id,reportDate:row.snapshot?.reportDate || null,version:row.snapshot?.version || null,
    recipientMasked:mask(row.recipient),ambiguous:!!row.ambiguous,sentAt:iso(row.sent_at),
    error:row.error_message || null,snapshotNotice:CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE};
}

function safeFailure(error,sending) {
  const definite = !error?.accepted?.length && (['SMTP_NOT_CONFIGURED','EMAIL_RECIPIENT_NOT_CONFIGURED','EAUTH','ECONNECTION','ETLS','EENVELOPE'].includes(error?.code)
    || (Number(error?.responseCode) >= 400 && Number(error?.responseCode) <= 599));
  const ambiguous = sending && !definite;
  return {ambiguous,message:ambiguous ? '邮件发送结果尚未确认，已停止重试。请管理员核对发件记录，避免重复发送。'
    : sending ? '邮件未发送成功，请管理员检查邮件服务及收件人。'
      : error?.code === 'ASSISTANT_EMAIL_AUTHORIZATION_CHANGED' ? '机器人已停用、改为预览模式或收件人授权已变化，未发送邮件。' : '邮件内容准备或发送授权核验失败，未发送邮件。'};
}

export function createCustomerAssistantEmailService({db = defaultDb,send = sendTenantEmail,readiness = tenantEmailReadiness,buildMessage = buildDailyEmailMessage,authorize,now = () => new Date()} = {}) {
  const authorizeSend = authorize || (async context => {
    const settings = await db.queryOne(`SELECT s.config FROM customer_assistant_settings s
      JOIN tenants t ON t.id=s.tenant_id AND t.status='active' WHERE s.tenant_id=$1`,[context.tenantId]);
    const config = settings?.config;
    if (config?.enabled !== true || config.mode !== 'live' || !config.groups?.some(group => group.chatId === context.chatId)) return false;
    const member = config.members?.find(item => item.chatId === context.chatId && item.openId === context.senderId);
    return member?.canEmail === true && typeof member.email === 'string' && member.email.trim().toLowerCase() === context.email;
  });
  async function enqueue(context,reportId) {
    const recipient = identity(context);
    if (!UUID.test(reportId || '')) throw fail('assistant_report_invalid','日报标识无效。');
    const params = [context.tenantId,context.chatId,context.senderId,context.requestId,reportId,recipient];
    const readReport = async tx => {
      const report = await tx.queryOne('SELECT snapshot,report_date::text AS report_date,version FROM customer_daily_reports WHERE tenant_id=$1 AND id=$2',[context.tenantId,reportId]);
      if (!report) throw fail('assistant_report_not_found','当前客户下没有这份日报。',404);
      // The saved row, not caller input, supplies report identity and version.
      return {...report,snapshot:{...structuredClone(report.snapshot),tenantId:context.tenantId,id:reportId,reportDate:report.report_date,version:Number(report.version)}};
    };
    if (context.dryRun === true) {
      const report = await readReport(db);
      const ready = await readiness(context.tenantId);
      return {...publicCustomerAssistantEmail({status:'preview',report_id:reportId,recipient,snapshot:report.snapshot}),dryRun:true,emailReady:ready?.ready === true};
    }
    return db.withTransaction(async tx => {
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`assistant-email:${JSON.stringify(params)}`]);
      const report = await readReport(tx);
      const previous = await tx.queryOne(`SELECT * FROM customer_assistant_email_deliveries
        WHERE tenant_id=$1 AND chat_id=$2 AND sender_id=$3 AND request_id=$4 AND report_id=$5 AND recipient=$6`,params);
      // Event/tool retries never requeue even a definite failure. A new user request has a new identity.
      if (previous) return publicCustomerAssistantEmail(previous);
      if ((await readiness(context.tenantId))?.ready !== true) throw fail('assistant_email_not_configured','邮件服务尚未配置，请联系管理员。',409);
      const subject = `${String(report.snapshot.tenantName || '客户').replace(/[\r\n\0]/g,' ').slice(0,100)}舆情日报 · ${report.report_date} · v${report.version}`;
      const row = {id:randomUUID(),tenant_id:context.tenantId,chat_id:context.chatId,sender_id:context.senderId,request_id:context.requestId,
        report_id:reportId,recipient,subject,snapshot:report.snapshot,status:'queued',ambiguous:false};
      await tx.execute(`INSERT INTO customer_assistant_email_deliveries
        (id,tenant_id,chat_id,sender_id,request_id,report_id,recipient,subject,snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[row.id,...params.slice(0,4),reportId,recipient,subject,JSON.stringify(report.snapshot)]);
      return publicCustomerAssistantEmail(row);
    },{category:'reporting',statementTimeoutMs:15000,lockTimeoutMs:3000,jitOff:true});
  }

  const receipt = row => ({...publicCustomerAssistantEmail(row),tenantId:row.tenant_id,chatId:row.chat_id,senderId:row.sender_id,requestId:row.request_id});
  async function listUnnotifiedTerminal(limit = 10) {
    const size = Math.min(100,Math.max(1,Number.isInteger(limit) ? limit : 10));
    const rows = await db.queryAll(`SELECT * FROM customer_assistant_email_deliveries
      WHERE status IN ('sent','failed') AND notified_at IS NULL
      ORDER BY COALESCE(sent_at,updated_at),created_at,id LIMIT $1`,[size]);
    return rows.map(receipt);
  }
  async function recoverStale() {
    const cutoff = new Date(new Date(now()).getTime()-10*60*1000).toISOString();
    const rows = await db.queryAll(`UPDATE customer_assistant_email_deliveries SET status='failed',ambiguous=true,
      error_message='上次邮件发送中断，结果待核实；已停止重试，避免重复发送。',claim_token=NULL,updated_at=now()
      WHERE status='working' AND claimed_at<$1::timestamptz RETURNING *`,[cutoff]);
    return rows.map(receipt);
  }

  async function processOne() {
    const token = randomUUID();
    const row = await db.withTransaction(async tx => {
      const next = await tx.queryOne("SELECT * FROM customer_assistant_email_deliveries WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");
      if (!next) return null;
      await tx.execute("UPDATE customer_assistant_email_deliveries SET status='working',claim_token=$2,claimed_at=$3,attempts=attempts+1,error_message=NULL,updated_at=now() WHERE id=$1",[next.id,token,new Date(now()).toISOString()]);
      return next;
    },{category:'reporting',statementTimeoutMs:10000,lockTimeoutMs:1000,jitOff:true});
    if (!row) return null;
    let sending = false;
    try {
      const message = await buildMessage(structuredClone(row.snapshot));
      const content = {...message,html:`<p>${CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE}</p>${message.html || ''}`,text:`${CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE}\n\n${message.text || ''}`};
      if ((await authorizeSend({tenantId:row.tenant_id,chatId:row.chat_id,senderId:row.sender_id,requestId:row.request_id,email:row.recipient,reportId:row.report_id})) !== true) {
        throw Object.assign(new Error('Email authorization revoked'),{code:'ASSISTANT_EMAIL_AUTHORIZATION_CHANGED'});
      }
      sending = true;
      const result = await send({...content,tenantId:row.tenant_id,to:row.recipient,subject:row.subject,messageId:`<customer-assistant-${row.id}@starvoice.local>`});
      const addresses = values => new Set((Array.isArray(values) ? values : []).map(value => String(value?.address || value).toLowerCase()));
      const accepted = addresses(result?.accepted), rejected = addresses(result?.rejected);
      if (!accepted.has(row.recipient.toLowerCase()) || rejected.size) {
        throw Object.assign(new Error('Unconfirmed SMTP acceptance'),{code:!accepted.size && rejected.has(row.recipient.toLowerCase()) ? 'EENVELOPE' : 'ASSISTANT_EMAIL_UNCONFIRMED',accepted:[...accepted]});
      }
      const sentAt = new Date(now()).toISOString();
      const saved = await db.queryOne(`UPDATE customer_assistant_email_deliveries SET status='sent',message_id=$4,sent_at=$5,
        error_message=NULL,ambiguous=false,claim_token=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='working' RETURNING id`,[row.tenant_id,row.id,token,String(result.messageId || ''),sentAt]);
      if (!saved) throw new Error('Email receipt claim lost');
      return receipt({...row,status:'sent',ambiguous:false,sent_at:sentAt,error_message:null});
    } catch (error) {
      const failure = safeFailure(error,sending);
      await db.execute(`UPDATE customer_assistant_email_deliveries SET status='failed',ambiguous=$4,error_message=$5,claim_token=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='working'`,[row.tenant_id,row.id,token,failure.ambiguous,failure.message]);
      return receipt({...row,status:'failed',ambiguous:failure.ambiguous,error_message:failure.message});
    }
  }
  return {enqueue,processOne,recoverStale,listUnnotifiedTerminal};
}
