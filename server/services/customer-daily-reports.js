import { randomUUID } from 'node:crypto';
import {queryAll, queryOne, execute, withTransaction} from '../db/init.js';
import {collectCustomerDailyReport, dailyPeriod} from './customer-daily-report-data.js';
import {createFeishuDailyClient} from './feishu-daily-report.js';
import {DAILY_DEFAULTS, dailyError, mergeDailyConfig, publicDailyConfig, resolvedDailyConfig, openDailySecret, validateDailyConfig, dailyTargetKey, nextDailySendAt} from './customer-daily-report-config.js';

const defaultDb = {queryAll, queryOne, execute, withTransaction};
const iso = value => value ? new Date(value).toISOString() : null;
const dateText = value => typeof value === 'string' ? value.slice(0,10) : new Date(value).toISOString().slice(0,10);
const safeFailure = error => {
  // Only our adapter's deliberately safe, user-facing errors may cross the API boundary.
  if (error?.safeMessage) return String(error.safeMessage).slice(0,500);
  if (error?.code?.startsWith('daily_')) return String(error.message).slice(0,500);
  return error?.ambiguous ? '飞书操作结果尚未确认，已停止自动重试。请核对目标文档或群消息后处理。' : '日报交付暂未完成，请检查飞书应用、目录、编辑权限和群配置。';
};

export function createCustomerDailyReportService({db = defaultDb, collect = collectCustomerDailyReport, clientFactory = createFeishuDailyClient, now = () => new Date(), env = process.env} = {}) {
  async function rawConfig(tenantId) {
    return (await db.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1', [tenantId]))?.config || {...DAILY_DEFAULTS};
  }
  async function settings(tenantId) {
    const row = await db.queryOne('SELECT config,next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1',[tenantId]);
    const latest = await db.queryOne('SELECT report_date::text AS date,status,error_message AS error FROM customer_daily_occurrences WHERE tenant_id=$1 ORDER BY report_date DESC LIMIT 1',[tenantId]);
    return {...publicDailyConfig(row?.config),nextRunAt:iso(row?.next_run_at),lastAutomaticRun:latest || null};
  }
  async function executionConfig(frozen,tenantId) {
    const current = await rawConfig(tenantId);
    const config = {...frozen};
    // Rotate credentials only within the frozen identity; never redirect a queued delivery.
    if (current.appId === frozen.appId && current.appSecretEncrypted) config.appSecretEncrypted=current.appSecretEncrypted;
    if (frozen.channel === 'webhook' && current.webhookSecretEncrypted && current.webhookUrlEncrypted
      && openDailySecret(current.webhookUrlEncrypted,tenantId,'webhookUrl',env) === openDailySecret(frozen.webhookUrlEncrypted,tenantId,'webhookUrl',env)) config.webhookSecretEncrypted=current.webhookSecretEncrypted;
    return resolvedDailyConfig(config,tenantId,env);
  }
  async function saveSettings(tenantId, patch) {
    return db.withTransaction(async tx => {
      await tx.execute('INSERT INTO customer_daily_report_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
      const row = await tx.queryOne('SELECT * FROM customer_daily_report_settings WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      const config = mergeDailyConfig(row.config, patch, tenantId, env);
      const nextRun = !config.autoEnabled ? null : (!row.config.autoEnabled || row.config.sendTime !== config.sendTime || !row.next_run_at) ? nextDailySendAt(config.sendTime, now()) : row.next_run_at;
      await tx.execute('UPDATE customer_daily_report_settings SET config=$2::jsonb,next_run_at=$3,updated_at=now() WHERE tenant_id=$1', [tenantId,JSON.stringify(config),nextRun]);
      if (!config.autoEnabled) {
        await tx.queryAll('SELECT report_id FROM customer_daily_documents WHERE tenant_id=$1 ORDER BY report_id FOR UPDATE',[tenantId]);
        await tx.execute("UPDATE customer_daily_occurrences SET status='canceled',error_message='自动发送已关闭' WHERE tenant_id=$1 AND status IN ('pending','needs_attention')",[tenantId]);
        await tx.execute("UPDATE customer_daily_deliveries SET status='canceled',error_message='自动发送已关闭；可手动发送选定版本。',updated_at=now() WHERE tenant_id=$1 AND automatic AND status IN ('queued','retry_wait','needs_attention')",[tenantId]);
        await tx.execute("UPDATE customer_daily_documents d SET status='needs_attention',error_message='自动发送已关闭；可手动生成或发送这份日报。' WHERE d.tenant_id=$1 AND NOT d.manual_requested AND d.status IN ('queued','retry_wait') AND NOT EXISTS (SELECT 1 FROM customer_daily_deliveries m WHERE m.tenant_id=d.tenant_id AND m.report_id=d.report_id AND m.status IN ('queued','retry_wait','working'))",[tenantId]);
      }
      return publicDailyConfig(config);
    });
  }
  async function report(tenantId, id, {includeSnapshot = true} = {}) {
    const row = await db.queryOne(`SELECT id,report_date::text AS report_date,mode,version,generated_at${includeSnapshot ? ',snapshot' : ''} FROM customer_daily_reports WHERE tenant_id=$1 AND id=$2`, [tenantId,id]);
    if (!row) return null;
    const doc = await db.queryOne('SELECT status,document_id,document_url,error_message,ambiguous FROM customer_daily_documents WHERE tenant_id=$1 AND report_id=$2', [tenantId,id]);
    const config = await rawConfig(tenantId);
    let targetKey = null;
    try { targetKey = dailyTargetKey(resolvedDailyConfig(config, tenantId, env)); } catch { /* Missing encryption key must not block reading snapshots. */ }
    const delivery = targetKey ? await db.queryOne('SELECT status,message_id,sent_at,error_message,ambiguous,config FROM customer_daily_deliveries WHERE tenant_id=$1 AND report_id=$2 AND target_key=$3', [tenantId,id,targetKey]) : null;
    const blockingDoc = doc && doc.status !== 'ready';
    const state = blockingDoc ? doc : delivery || doc;
    const status = state?.status === 'ready' ? 'document_ready' : state?.status === 'canceled' ? 'needs_attention' : state?.status || 'none';
    return {id:row.id,reportDate:dateText(row.report_date),mode:row.mode,version:row.version,generatedAt:iso(row.generated_at),...(includeSnapshot ? {snapshot:row.snapshot} : {}),delivery:{status,documentId:doc?.document_id,documentUrl:doc?.document_url,messageId:delivery?.message_id,sentAt:iso(delivery?.sent_at),error:state?.error_message,ambiguous:state?.ambiguous || false,canRetry:!!state && !state.ambiguous && !['working','sent'].includes(status),chatName:delivery?.config?.chatName || config.chatName || ''}};
  }
  async function list(tenantId, date) {
    if (date) dailyPeriod(date, now());
    const config = await rawConfig(tenantId);
    let targetKey=null;
    try { targetKey=dailyTargetKey(resolvedDailyConfig(config,tenantId,env)); } catch { /* Snapshots stay readable with missing credentials. */ }
    const rows = await db.queryAll(`SELECT r.id,r.report_date::text AS report_date,r.mode,r.version,r.generated_at,
      d.status AS document_status,d.document_id,d.document_url,d.error_message AS document_error,d.ambiguous AS document_ambiguous,
      m.status AS message_status,m.message_id,m.sent_at,m.error_message AS message_error,m.ambiguous AS message_ambiguous,m.config->>'chatName' AS chat_name
      FROM customer_daily_reports r LEFT JOIN customer_daily_documents d ON d.report_id=r.id AND d.tenant_id=r.tenant_id
      LEFT JOIN customer_daily_deliveries m ON m.report_id=r.id AND m.tenant_id=r.tenant_id AND m.target_key=$3
      WHERE r.tenant_id=$1 AND ($2::date IS NULL OR r.report_date=$2::date) ORDER BY r.report_date DESC,r.version DESC LIMIT 50`,[tenantId,date || null,targetKey]);
    return rows.map(row => {
      const blockingDoc=row.document_status && row.document_status !== 'ready';
      const rawStatus=blockingDoc ? row.document_status : row.message_status || row.document_status || 'none';
      const status=rawStatus === 'ready' ? 'document_ready' : rawStatus === 'canceled' ? 'needs_attention' : rawStatus;
      const ambiguous=Boolean(blockingDoc ? row.document_ambiguous : row.message_ambiguous || row.document_ambiguous);
      return {id:row.id,reportDate:row.report_date,mode:row.mode,version:row.version,generatedAt:iso(row.generated_at),delivery:{status,documentId:row.document_id,documentUrl:row.document_url,messageId:row.message_id,sentAt:iso(row.sent_at),error:blockingDoc ? row.document_error : row.message_error || row.document_error,ambiguous,canRetry:status !== 'none' && !ambiguous && !['working','sent'].includes(status),chatName:row.chat_name || config.chatName || ''}};
    });
  }
  async function generate(tenantId, {date,requestId = randomUUID()} = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(requestId)) throw dailyError('生成请求标识无效');
    const generationTime = now();
    const period = dailyPeriod(date,generationTime);
    for (let retry = 0; retry < 3; retry++) {
      try {
        const id = await db.withTransaction(async tx => {
          await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`customer-daily:${tenantId}:${period.reportDate}`]);
          const previous = await tx.queryOne('SELECT id,report_date::text AS report_date FROM customer_daily_reports WHERE tenant_id=$1 AND request_key=$2', [tenantId,requestId]);
          if (previous) {
            if (dateText(previous.report_date) !== period.reportDate) throw dailyError('同一生成请求不能用于不同日期');
            return previous.id;
          }
          const snapshot = await collect({tenantId,date:period.reportDate,now:generationTime,db:tx});
          const version = Number((await tx.queryOne('SELECT COALESCE(MAX(version),0)+1 AS version FROM customer_daily_reports WHERE tenant_id=$1 AND report_date=$2', [tenantId,period.reportDate])).version);
          const reportId = randomUUID();
          const frozen = {...snapshot,id:reportId,version};
          await tx.execute('INSERT INTO customer_daily_reports (id,tenant_id,report_date,mode,version,request_key,snapshot,generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [reportId,tenantId,period.reportDate,period.mode,version,requestId,JSON.stringify(frozen),frozen.assessedAt]);
          return reportId;
        }, {category:'reporting', isolationLevel:'repeatable_read', statementTimeoutMs:15000, lockTimeoutMs:1000, jitOff:true});
        return report(tenantId,id);
      } catch (error) {
        if (retry < 2 && ['40001','23505','55P03'].includes(error.code)) continue;
        throw error;
      }
    }
  }
  async function enqueue(tenantId,id,{send = false,allowIncomplete = false,correction = false,automatic = false,config: explicitConfig} = {}) {
    const row = await db.queryOne('SELECT snapshot,mode,report_date::text AS report_date FROM customer_daily_reports WHERE tenant_id=$1 AND id=$2', [tenantId,id]);
    if (!row) throw dailyError('日报不存在',404);
    const config = explicitConfig || await rawConfig(tenantId);
    validateDailyConfig(config,{send});
    if (!allowIncomplete && row.snapshot.warnings?.some(w => w.blocking)) throw dailyError('日报仍有待同步或待识别内容，请生成新版，或明确选择按当前数据交付。',409,'daily_data_incomplete');
    const resolved = resolvedDailyConfig(config,tenantId,env);
    const targetKey = dailyTargetKey(resolved);
    const queuedId = await db.withTransaction(async tx => {
      if (automatic) {
        const current = await tx.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1 FOR UPDATE',[tenantId]);
        if (current?.config.autoEnabled !== true) throw dailyError('自动发送已关闭',409,'daily_auto_disabled');
      }
      if (send && row.mode === 'formal') {
        await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`daily-delivery:${tenantId}:${row.report_date}:${targetKey}`]);
        const existing = await tx.queryOne(`SELECT d.report_id,d.status FROM customer_daily_deliveries d JOIN customer_daily_reports r ON r.tenant_id=d.tenant_id AND r.id=d.report_id
          WHERE d.tenant_id=$1 AND r.report_date=$2 AND r.mode='formal' AND d.target_key=$3 AND (d.status<>'canceled' OR d.ambiguous) ORDER BY r.version DESC LIMIT 1`,[tenantId,row.report_date,targetKey]);
        if (existing && existing.report_id !== id && (!correction || existing.status !== 'sent')) return existing.report_id;
      }
      const document = await tx.queryOne('SELECT * FROM customer_daily_documents WHERE tenant_id=$1 AND report_id=$2 FOR UPDATE',[tenantId,id]);
      if (document && ['appId','editorType','editorId'].some(key => document.config[key] !== config[key])) {
        throw dailyError('这份文档的应用或客户编辑者与当前配置不同。请保留原文档，按新配置生成新版后交付。',409,'daily_document_owner_changed');
      }
      await tx.execute(`INSERT INTO customer_daily_documents (report_id,tenant_id,config,allow_incomplete) VALUES ($1,$2,$3::jsonb,$4)
        ON CONFLICT (report_id) DO UPDATE SET status='queued', next_attempt_at=now(),error_message=NULL,config=CASE WHEN customer_daily_documents.document_id IS NULL THEN excluded.config ELSE customer_daily_documents.config END
        WHERE customer_daily_documents.status IN ('retry_wait','needs_attention') AND NOT customer_daily_documents.ambiguous`, [id,tenantId,JSON.stringify(config),allowIncomplete]);
      if (!automatic) await tx.execute('UPDATE customer_daily_documents SET manual_requested=true WHERE tenant_id=$1 AND report_id=$2',[tenantId,id]);
      if (send) await tx.execute(`INSERT INTO customer_daily_deliveries (id,tenant_id,report_id,target_key,config,automatic) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (tenant_id,report_id,target_key) DO UPDATE SET status='queued',next_attempt_at=now(),error_message=NULL,config=excluded.config
        WHERE customer_daily_deliveries.status IN ('retry_wait','needs_attention','canceled') AND NOT customer_daily_deliveries.ambiguous`, [randomUUID(),tenantId,id,targetKey,JSON.stringify(config),automatic]);
      if (send && !automatic) await tx.execute('UPDATE customer_daily_deliveries SET automatic=false WHERE tenant_id=$1 AND report_id=$2 AND target_key=$3',[tenantId,id,targetKey]);
      // Credential rotation may repair the same app's existing document without rewriting its content.
      if (document?.document_id && document.config.appId === config.appId && document.status !== 'working') await tx.execute("UPDATE customer_daily_documents SET config=jsonb_set(config,'{appSecretEncrypted}',$3::jsonb),updated_at=now() WHERE tenant_id=$1 AND report_id=$2",[tenantId,id,JSON.stringify(config.appSecretEncrypted)]);
      return id;
    });
    return report(tenantId,queuedId);
  }
  async function claim(table) {
    const key = table === 'customer_daily_documents' ? 'report_id' : 'id';
    const token = randomUUID();
    return db.queryOne(`UPDATE ${table} SET status='working',claim_token=$1,claimed_at=now(),updated_at=now(),attempts=attempts+1
      WHERE ${key}=(SELECT ${key} FROM ${table} WHERE status IN ('queued','retry_wait') AND next_attempt_at<=now()
      ${table === 'customer_daily_documents' ? "AND (manual_requested OR EXISTS (SELECT 1 FROM customer_daily_deliveries m WHERE m.report_id=customer_daily_documents.report_id AND m.tenant_id=customer_daily_documents.tenant_id AND m.status IN ('queued','retry_wait')))" : ''}
      ${table === 'customer_daily_deliveries' ? "AND EXISTS (SELECT 1 FROM customer_daily_documents d WHERE d.report_id=customer_daily_deliveries.report_id AND d.tenant_id=customer_daily_deliveries.tenant_id AND d.status='ready')" : ''}
      ORDER BY next_attempt_at,${key} FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token]);
  }
  async function failed(table,row,error) {
    const ambiguous = error?.ambiguous === true;
    const status = ambiguous || error?.needsAttention || row.attempts >= 5 ? 'needs_attention' : 'retry_wait';
    const key = table === 'customer_daily_documents' ? 'report_id' : 'id';
    await db.execute(`UPDATE ${table} SET status=$3,ambiguous=$4,error_message=$5,next_attempt_at=now()+($6 * interval '1 second'),claim_token=NULL,claimed_at=NULL,updated_at=now() WHERE ${key}=$1 AND claim_token=$2`, [row[key],row.claim_token,status,ambiguous,safeFailure(error),Math.min(3600,60 * 2 ** Math.min(row.attempts,6))]);
  }
  async function processDocument() {
    const row = await claim('customer_daily_documents');
    if (!row) return false;
    try {
      const data = await db.queryOne('SELECT snapshot FROM customer_daily_reports WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.report_id]);
      const config = await executionConfig(row.config,row.tenant_id);
      const client = clientFactory(config);
      const checkpoint = async (phase, progress) => {
        const updated = await db.queryOne('UPDATE customer_daily_documents SET phase=$3,progress=$4::jsonb,claimed_at=now(),updated_at=now() WHERE report_id=$1 AND claim_token=$2 RETURNING report_id', [row.report_id,row.claim_token,phase,JSON.stringify(progress)]);
        if (!updated) throw Object.assign(dailyError('文档操作占用已失效，请核实远端结果。',409),{ambiguous:true});
      };
      let documentId = row.document_id;
      if (!documentId) {
        await checkpoint('creating',row.progress);
        const document = await client.createDocument({title:`${data.snapshot.tenantName || '客户'} ${data.snapshot.reportDate}舆情日报 · v${data.snapshot.version}${data.snapshot.mode === 'realtime' ? ' · 实时' : ''}`});
        documentId = document.documentId;
        const updated = await db.queryOne("UPDATE customer_daily_documents SET document_id=$3,document_url=$4,phase='body',claimed_at=now(),updated_at=now() WHERE report_id=$1 AND claim_token=$2 RETURNING report_id",[row.report_id,row.claim_token,documentId,document.url]);
        if (!updated) throw Object.assign(new Error(),{ambiguous:true});
      }
      let progress = row.progress || {};
      if (!['permissions','ready'].includes(row.phase)) {
        const body = await client.writeDocument({documentId,snapshot:data.snapshot,progress:progress.body,onProgress:async next => { progress={...progress,body:next}; await checkpoint('body',progress); }});
        progress = {...progress,body};
        await checkpoint('permissions',progress || {});
      }
      await client.ensureEditable({documentId,progress:progress.permissions,onProgress:async next => { progress={...progress,permissions:next}; await checkpoint('permissions',progress); }});
      await db.execute("UPDATE customer_daily_documents SET status='ready',phase='ready',error_message=NULL,claim_token=NULL,claimed_at=NULL,updated_at=now() WHERE report_id=$1 AND claim_token=$2",[row.report_id,row.claim_token]);
    } catch (error) {
      if (!error.safeMessage && !error.code?.startsWith('daily_')) error.ambiguous = true;
      await failed('customer_daily_documents',row,error);
    }
    return true;
  }
  async function processMessage() {
    const row = await claim('customer_daily_deliveries');
    if (!row) return false;
    try {
      const data = await db.queryOne('SELECT r.snapshot,d.document_id,d.document_url,d.progress,d.config AS document_config FROM customer_daily_reports r JOIN customer_daily_documents d ON d.report_id=r.id AND d.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2',[row.tenant_id,row.report_id]);
      validateDailyConfig(row.config,{send:true});
      if (['editorType','editorId'].some(key => data.document_config[key] !== row.config[key])) throw dailyError('当前接收方与文档已授权客户不同，请先完成新接收方的文档交付配置。',409,'daily_document_owner_changed');
      const documentClient = clientFactory(await executionConfig(data.document_config,row.tenant_id));
      // Read permissions again immediately before each delivery; a prior success is not perpetual access.
      await documentClient.ensureEditable({documentId:data.document_id,progress:data.progress?.permissions,verifyOnly:true});
      const client = clientFactory(await executionConfig(row.config,row.tenant_id));
      const result = await client.sendReport({documentUrl:data.document_url,snapshot:data.snapshot,uuid:row.id});
      await db.execute("UPDATE customer_daily_deliveries SET status='sent',message_id=$3,sent_at=now(),error_message=NULL,claim_token=NULL,claimed_at=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2",[row.id,row.claim_token,result.messageId]);
    } catch (error) {
      if (!error.safeMessage && !error.code?.startsWith('daily_')) error.ambiguous = true;
      await failed('customer_daily_deliveries',row,error);
    }
    return true;
  }
  async function reserveOccurrences() {
    return db.withTransaction(async tx => {
      const rows = await tx.queryAll("SELECT s.* FROM customer_daily_report_settings s JOIN tenants t ON t.id=s.tenant_id AND t.status='active' WHERE s.config->>'autoEnabled'='true' AND s.next_run_at<=$1 ORDER BY s.next_run_at FOR UPDATE OF s SKIP LOCKED LIMIT 10",[now()]);
      for (const row of rows) {
        const due = new Date(row.next_run_at);
        const reportDate = new Date(due.getTime()+8*3600000-86400000).toISOString().slice(0,10);
        await tx.execute('INSERT INTO customer_daily_occurrences (id,tenant_id,report_date,config) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (tenant_id,report_date) DO NOTHING',[randomUUID(),row.tenant_id,reportDate,JSON.stringify(row.config)]);
        await tx.execute("UPDATE customer_daily_report_settings SET next_run_at=next_run_at+interval '1 day' WHERE tenant_id=$1",[row.tenant_id]);
      }
      return rows.length;
    });
  }
  async function processOccurrences() {
    const rows = await db.queryAll("SELECT o.*,o.report_date::text AS report_date FROM customer_daily_occurrences o JOIN tenants t ON t.id=o.tenant_id AND t.status='active' JOIN customer_daily_report_settings s ON s.tenant_id=o.tenant_id AND s.config->>'autoEnabled'='true' WHERE o.status='pending' AND o.next_attempt_at<=now() ORDER BY o.created_at LIMIT 5");
    for (const row of rows) {
      try {
        const targetKey = dailyTargetKey(resolvedDailyConfig(row.config,row.tenant_id,env));
        // A manually enqueued/sent formal report owns this date; a realtime report never does.
        const existing = await db.queryOne(`SELECT r.id FROM customer_daily_reports r JOIN customer_daily_deliveries d ON d.report_id=r.id AND d.tenant_id=r.tenant_id
          WHERE r.tenant_id=$1 AND r.report_date=$2 AND r.mode='formal' AND d.target_key=$3 AND (d.status<>'canceled' OR d.ambiguous) ORDER BY (d.status='sent') DESC,r.version DESC LIMIT 1`,[row.tenant_id,row.report_date,targetKey]);
        const generated = existing ? await report(row.tenant_id,existing.id) : await generate(row.tenant_id,{date:dateText(row.report_date),requestId:`auto:${row.id}:${row.attempts}`});
        // Existing delivery already carries the user's incomplete-data decision. Do not revoke it.
        const queued = existing ? generated : await enqueue(row.tenant_id,generated.id,{send:true,automatic:true,config:row.config});
        await db.execute("UPDATE customer_daily_occurrences SET status='enqueued',report_id=$2,error_message=NULL WHERE id=$1 AND status='pending'",[row.id,queued.id]);
      } catch (error) {
        const incomplete = error?.code === 'daily_data_incomplete';
        await db.execute("UPDATE customer_daily_occurrences SET status=$2,error_message=$3,attempts=attempts+1,next_attempt_at=now()+interval '10 minutes' WHERE id=$1 AND status='pending'",[row.id,incomplete && row.attempts < 17 ? 'pending' : 'needs_attention',safeFailure(error)]);
      }
    }
    return rows.length;
  }
  async function processDue({limit = 5} = {}) {
    // A process can die after a remote success. Expired claims are deliberately NOT replayed.
    for (const table of ['customer_daily_documents','customer_daily_deliveries']) await db.execute(`UPDATE ${table} SET status='needs_attention',ambiguous=true,error_message='上次操作中断，远端结果待核实；为避免重复交付，已停止自动重试。',claim_token=NULL,updated_at=now() WHERE status='working' AND claimed_at<now()-interval '10 minutes'`);
    await reserveOccurrences();
    await processOccurrences();
    let processed = 0;
    for (let i=0;i<Math.min(10,Math.max(1,limit));i++) {
      const document = await processDocument();
      const message = await processMessage();
      processed += Number(document)+Number(message);
      if (!document && !message) break;
    }
    return {processed};
  }
  return {settings,saveSettings,report,list,generate,enqueue,processDue,processDocument,processMessage,reserveOccurrences,processOccurrences};
}

export const customerDailyReports = createCustomerDailyReportService();
export const processCustomerDailyReports = options => customerDailyReports.processDue(options);
