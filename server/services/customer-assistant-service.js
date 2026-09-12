import {randomUUID} from 'node:crypto';
import {queryOne,queryAll,execute,withTransaction} from '../db/init.js';
import {assistantError,mergeAssistantConfig,publicAssistantConfig,resolveAssistantCredentials,resolveAssistantMember} from './customer-assistant-config.js';
import {createAssistantFeishuClient,verifyFeishuAssistantEvent} from './customer-assistant-feishu.js';
import {createCustomerAssistantAgent} from './customer-assistant-agent.js';
import {createCustomerAssistantModel} from './customer-assistant-model.js';
import {createCustomerAssistantTools} from './customer-assistant-tools.js';
import {createCustomerAssistantEmailService} from './customer-assistant-email.js';
import {dailyBusinessCalendar} from './customer-daily-business-period.js';

const defaultDb={queryOne,queryAll,execute,withTransaction};
const transactionOptions={category:'reporting',statementTimeoutMs:15000,lockTimeoutMs:2000,jitOff:true};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso=value=>value?new Date(value).toISOString():null;

export function createCustomerAssistantService({db=defaultDb,makeModel=createCustomerAssistantModel,makeAgent=createCustomerAssistantAgent,
  makeFeishu=createAssistantFeishuClient,email=createCustomerAssistantEmailService({db}),tools=createCustomerAssistantTools({db,email}),now=()=>new Date(),env=process.env}={}) {
  const previewBusy=new Set();
  async function stored(tenantId) {
    const row=await db.queryOne(`SELECT s.config FROM tenants t LEFT JOIN customer_assistant_settings s ON s.tenant_id=t.id
      WHERE t.id=$1 AND t.status='active'`,[tenantId]);
    if(!row)throw assistantError('assistant_tenant_unavailable','客户项目不可用。',404);
    return row.config||{};
  }
  async function credentials(tenantId,config) {
    const daily=config.useDailyApp!==false?await db.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1',[tenantId]):null;
    return resolveAssistantCredentials(config,tenantId,daily?.config||{},env);
  }
  async function settings(tenantId){return publicAssistantConfig(await stored(tenantId));}
  async function saveSettings(tenantId,patch,actorId) {
    await db.withTransaction(async tx=>{
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer-assistant-settings']);
      const row=await tx.queryOne('SELECT config FROM customer_assistant_settings WHERE tenant_id=$1 FOR UPDATE',[tenantId]);
      const config=mergeAssistantConfig(row?.config||{},patch,tenantId,env);
      if(config.groups.length) {
        const conflict=await tx.queryOne(`SELECT s.tenant_id FROM customer_assistant_settings s,
          jsonb_array_elements(COALESCE(s.config->'groups','[]'::jsonb)) g
          WHERE s.tenant_id<>$1 AND g->>'chatId'=ANY($2::text[]) LIMIT 1`,[tenantId,config.groups.map(g=>g.chatId)]);
        if(conflict)throw assistantError('assistant_group_already_bound','该客户群已绑定其他项目，请核对后再保存。',409);
      }
      if(config.enabled) {
        const daily=config.useDailyApp!==false?await tx.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1',[tenantId]):null;
        const resolved=resolveAssistantCredentials(config,tenantId,daily?.config||{},env);
        if(!resolved.appId||!resolved.appSecret)throw assistantError('assistant_app_missing','请先配置可用的飞书应用。',409);
      }
      await tx.execute(`INSERT INTO customer_assistant_settings(tenant_id,config,updated_by) VALUES($1,$2::jsonb,$3)
        ON CONFLICT(tenant_id) DO UPDATE SET config=EXCLUDED.config,updated_by=EXCLUDED.updated_by,updated_at=now()`,[tenantId,JSON.stringify(config),actorId]);
    },transactionOptions);
    return settings(tenantId);
  }
  async function receive(tenantId,rawBody,headers) {
    if(!UUID.test(tenantId))throw assistantError('assistant_callback_invalid','飞书回调验证失败。',401);
    const config=await stored(tenantId);const auth=await credentials(tenantId,config);
    const event=verifyFeishuAssistantEvent({rawBody,headers,credentials:auth,now:new Date(now()).getTime()});
    if(event.challenge!==undefined)return {challenge:event.challenge};
    if(event.ignored||!config.enabled||!resolveAssistantMember(config,event.chatId,event.senderId))return {ok:true,ignored:true};
    const sessionKey=`group:${event.chatId}:${event.senderId}:${event.threadId?`thread:${event.threadId}`:'main'}`;
    await db.withTransaction(async tx=>{
      await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`assistant-admit:${tenantId}`]);
      const duplicate=await tx.queryOne('SELECT id FROM customer_assistant_events WHERE tenant_id=$1 AND (message_id=$2 OR event_id=$3)',[tenantId,event.messageId,event.eventId]);
      if(duplicate)return;
      // The first bot reply creates a thread. Seed it from that exact parent
      // response, never from another member or the current unrelated main chat.
      if(event.threadId) {
        const parent=await tx.queryOne(`SELECT conversation_history FROM customer_assistant_events WHERE tenant_id=$1 AND chat_id=$2 AND sender_id=$3
          AND (message_id=$4 OR thread_id=$5) AND conversation_history IS NOT NULL AND created_at>now()-interval '2 hours'
          ORDER BY created_at DESC LIMIT 1`,[tenantId,event.chatId,event.senderId,event.rootId||'',event.threadId]);
        if(parent)await tx.execute(`INSERT INTO customer_assistant_sessions(tenant_id,session_key,history) VALUES($1,$2,$3::jsonb)
          ON CONFLICT DO NOTHING`,[tenantId,sessionKey,JSON.stringify(parent.conversation_history)]);
      }
      const pressure=await tx.queryOne(`SELECT count(*)::int AS count FROM customer_assistant_events
        WHERE tenant_id=$1 AND created_at>now()-interval '1 minute'`,[tenantId]);
      if(pressure.count>=60)throw assistantError('assistant_rate_limited','当前提问较多，请稍后重试。',429);
      await tx.execute(`INSERT INTO customer_assistant_events(id,tenant_id,event_id,app_id,message_id,chat_id,sender_id,session_key,text,dry_run,requested_at,thread_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [randomUUID(),tenantId,event.eventId,auth.appId,event.messageId,event.chatId,event.senderId,sessionKey,event.text,config.mode!=='live',event.requestedAt,event.threadId||null]);
    },transactionOptions);
    return {ok:true};
  }
  async function history(tenantId,sessionKey) {
    const row=await db.queryOne("SELECT history FROM customer_assistant_sessions WHERE tenant_id=$1 AND session_key=$2 AND updated_at>now()-interval '2 hours'",[tenantId,sessionKey]);
    return Array.isArray(row?.history)?row.history:[];
  }
  async function runEvent(row,{preview=false}={}) {
    let mayHaveReplied=false;
    try {
      const config=await stored(row.tenant_id);const member=resolveAssistantMember(config,row.chat_id,row.sender_id);
      if((!preview&&!config.enabled)||!member)throw assistantError('assistant_permission_revoked','助手已停用或成员权限已撤销，未执行本次请求。',403);
      const requestedAt=new Date(row.requested_at||row.created_at||now());
      const age=new Date(now()).getTime()-requestedAt.getTime();
      if(!preview&&(age>15*60000||age< -60000))throw assistantError('assistant_request_expired','这条提问已过期，请重新提问以查询最新数据。',409);
      const dryRun=preview||row.dry_run||config.mode!=='live';
      const auth=preview?null:await credentials(row.tenant_id,config);
      if(auth&&auth.appId!==row.app_id)throw assistantError('assistant_app_changed','应用配置已变更，本次旧消息已停止处理。',409);
      const context={tenantId:row.tenant_id,chatId:row.chat_id,senderId:row.sender_id,requestId:row.message_id,requestedAt:requestedAt.toISOString(),
        emailAllowed:member.canEmail===true,email:member.email,dryRun};
      const executeBusinessTool=typeof tools==='function'?tools:tools.executeTool;
      const executeTool=(name,args,boundContext)=>{
        if(name==='query_negative'&&!args.dateFrom&&!args.dateTo)args={...args,dateFrom:new Date(requestedAt.getTime()+8*3600000).toISOString().slice(0,10)};
        if(name==='get_daily_report'&&!args.date)args={...args,date:dailyBusinessCalendar(undefined,requestedAt).defaultReportDate};
        return executeBusinessTool(name,args,boundContext);
      };
      const agent=makeAgent({model:makeModel({tenantId:row.tenant_id}),executeTool,now:()=>requestedAt});
      const result=await agent.run({text:row.text,history:await history(row.tenant_id,row.session_key),context,signal:AbortSignal.timeout(90000)});
      // Check the current membership and kill switch again after model work.
      const latest=await stored(row.tenant_id);
      if(!resolveAssistantMember(latest,row.chat_id,row.sender_id)||(!preview&&!latest.enabled))throw assistantError('assistant_permission_revoked','成员权限已变更，本次回复已停止。',403);
      const sendLive=!dryRun&&latest.mode==='live';
      const persisted=await db.withTransaction(async tx=>{
        const owned=await tx.queryOne(`UPDATE customer_assistant_events SET reply=$4,tool_results=$5::jsonb,status=$6,conversation_history=$7::jsonb,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='working' RETURNING id`,
        [row.tenant_id,row.id,row.claim_token,result.reply,JSON.stringify(result.toolResults),sendLive?'reply_unknown':'completed',JSON.stringify(result.history)]);
        if(!owned)return false;
        await tx.execute(`INSERT INTO customer_assistant_sessions(tenant_id,session_key,history) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(tenant_id,session_key) DO UPDATE SET history=EXCLUDED.history,updated_at=now()`,[row.tenant_id,row.session_key,JSON.stringify(result.history)]);
        return true;
      },transactionOptions);
      if(!persisted)throw assistantError('assistant_claim_lost','请求处理已结束，请重新提问。',409);
      if(sendLive) {
        mayHaveReplied=true;
        const sent=await makeFeishu(auth).reply(row.message_id,result.reply,row.id);
        const threadId=sent?.data?.thread_id;
        await db.execute("UPDATE customer_assistant_events SET status='completed',thread_id=COALESCE($3,thread_id),updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='reply_unknown'",[row.id,row.claim_token,
          typeof threadId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(threadId)?threadId:null]);
      }
      return {...result,dryRun};
    }catch(error){
      const message=error.safeMessage||'本次请求未完成，请稍后重试或联系管理员。';
      await db.execute(`UPDATE customer_assistant_events SET status=$3,error_message=$4,updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND status IN ('working','reply_unknown')`,[row.id,row.claim_token,mayHaveReplied?'reply_unknown':'failed',message]);
      if(preview)throw assistantError(error.code||'assistant_failed',message,error.status||502);
      return {error:message};
    }
  }
  async function preview(tenantId,{text,chatId,senderId,sessionId},actorId) {
    if(typeof text!=='string'||!text.trim()||text.length>4000)throw assistantError('assistant_text_invalid','请输入1至4000字的提问。');
    if(sessionId&&!UUID.test(sessionId))throw assistantError('assistant_session_invalid','试聊会话无效。');
    const config=await stored(tenantId);
    if(!resolveAssistantMember(config,chatId,senderId))throw assistantError('assistant_member_required','请先保存并选择已绑定的试聊成员。',403);
    const sid=sessionId||randomUUID();const sessionKey=`preview:${actorId}:${sid}:${chatId}:${senderId}`;
    const busyKey=`${tenantId}:${sessionKey}`;
    if(previewBusy.has(busyKey))throw assistantError('assistant_session_busy','上一条提问正在处理，请稍候。',409);
    previewBusy.add(busyKey);
    try {
      const row={id:randomUUID(),tenant_id:tenantId,app_id:'preview',message_id:`preview-${randomUUID()}`,chat_id:chatId,sender_id:senderId,
        session_key:sessionKey,text:text.trim(),dry_run:true,claim_token:randomUUID()};
      await db.execute(`INSERT INTO customer_assistant_events(id,tenant_id,event_id,app_id,message_id,chat_id,sender_id,session_key,text,dry_run,status,claim_token,claimed_at)
        VALUES($1,$2,$3,'preview',$3,$4,$5,$6,$7,true,'working',$8,now())`,[row.id,tenantId,row.message_id,chatId,senderId,sessionKey,row.text,row.claim_token]);
      const result=await runEvent(row,{preview:true});
      return {reply:result.reply,toolResults:result.toolResults,sessionId:sid,dryRun:true};
    }finally{previewBusy.delete(busyKey);}
  }
  async function processOne() {
    const row=await db.withTransaction(async tx=>{
      const next=await tx.queryOne(`SELECT e.* FROM customer_assistant_events e WHERE e.status='queued'
        AND NOT EXISTS(SELECT 1 FROM customer_assistant_events before WHERE before.tenant_id=e.tenant_id AND before.session_key=e.session_key
          AND (before.status='working' OR (before.status='queued' AND (before.created_at,before.id)<(e.created_at,e.id))))
        ORDER BY e.created_at,e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`);
      if(!next)return null;
      const token=randomUUID();await tx.execute("UPDATE customer_assistant_events SET status='working',claim_token=$2,claimed_at=now(),updated_at=now() WHERE id=$1",[next.id,token]);
      return {...next,claim_token:token};
    },transactionOptions);
    if(!row)return false;
    await runEvent(row);return true;
  }
  async function notifyEmail(delivery) {
    if(!delivery||!['sent','failed','unknown'].includes(delivery.status))return;
    const claimed=await db.queryOne(`UPDATE customer_assistant_email_deliveries SET notified_at=now()
      WHERE id=$1 AND notified_at IS NULL RETURNING id`,[delivery.id]);
    if(!claimed)return;
    try {
      const config=await stored(delivery.tenantId);
      if(!config.enabled||config.mode!=='live'||!resolveAssistantMember(config,delivery.chatId,delivery.senderId))return;
      const event=await db.queryOne('SELECT app_id,message_id FROM customer_assistant_events WHERE tenant_id=$1 AND message_id=$2 AND chat_id=$3 AND sender_id=$4 AND dry_run=false',
        [delivery.tenantId,delivery.requestId,delivery.chatId,delivery.senderId]);
      const auth=await credentials(delivery.tenantId,config);
      if(!event||auth.appId!==event.app_id)return;
      const text=delivery.status==='sent'?`${delivery.reportDate} 日报 v${delivery.version} 已交给邮件服务器，收件邮箱：${delivery.recipientMasked}。附件为系统保存版本，不包含飞书文档后续修改。`
        :delivery.status==='unknown'?'这份日报的邮件发送结果待核实，已停止自动重试，请管理员核对。':'这份日报未发送成功，请联系管理员检查邮件配置和成员权限。';
      await makeFeishu(auth).reply(event.message_id,text,`email:${delivery.id}`);
    }catch{
      await db.execute("UPDATE customer_assistant_email_deliveries SET notification_error='邮件结果通知未确认送达，未自动重试。' WHERE id=$1",[delivery.id]);
    }
  }
  async function processCycle() {
    await db.execute("UPDATE customer_assistant_events SET status='failed',error_message='上次处理已中断，请重新提问。',updated_at=now() WHERE status='working' AND claimed_at<now()-interval '10 minutes'");
    const stale=await email.recoverStale();
    for(const delivery of Array.isArray(stale)?stale:[])await notifyEmail(delivery);
    await processOne();
    await notifyEmail(await email.processOne());
    // A crash after SMTP settlement must not lose the first result notice.
    // notifyEmail claims each notice before sending, so uncertain notices are not retried.
    const pending=typeof email.listUnnotifiedTerminal==='function'?await email.listUnnotifiedTerminal(10):[];
    for(const delivery of pending)await notifyEmail(delivery);
    return {ok:true};
  }
  async function activity(tenantId) {
    return (await db.queryAll('SELECT id,status,created_at,reply,error_message,dry_run FROM customer_assistant_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',[tenantId]))
      .map(r=>({id:r.id,status:r.status,createdAt:iso(r.created_at),reply:r.reply,error:r.error_message,dryRun:r.dry_run}));
  }
  return {settings,saveSettings,receive,preview,activity,processOne,processCycle};
}
export const customerAssistantService=createCustomerAssistantService();
export const processCustomerAssistant=()=>customerAssistantService.processCycle();
