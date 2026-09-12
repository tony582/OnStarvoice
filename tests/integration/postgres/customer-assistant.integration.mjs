import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// Use the project's shared safety boundary; never fall back to an application database.
function target() {
  assert.equal(process.env.NODE_ENV,'test');
  const validated=validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  return {rawUrl:validated.rawUrl,databaseName:validated.databaseName};
}

function database(pool) {
  const api = connection => ({
    queryAll:async(sql,params=[]) => (await connection.query(sql,params)).rows,
    queryOne:async(sql,params=[]) => (await connection.query(sql,params)).rows[0] || null,
    execute:async(sql,params=[]) => connection.query(sql,params),
  });
  return {...api(pool),withTransaction:async callback => {
    const client=await pool.connect();
    try {await client.query('BEGIN');const result=await callback(api(client));await client.query('COMMIT');return result;}
    catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }};
}

test('customer assistant real PostgreSQL callbacks, tools, queues and authorization',{timeout:120000},async t => {
  const {rawUrl,databaseName}=target();
  const require=createRequire(new URL('../../../server/package.json',import.meta.url));
  const {Pool}=require('pg'),express=require('express');
  const pool=new Pool({connectionString:rawUrl,max:8});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {closePool}=await import('../../../server/db/pool.js');
  t.after(async()=>{await pool.end();await closePool();});
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,databaseName);
  await runMigrations();
  const db=database(pool);
  assert.ok(await db.queryOne("SELECT version FROM schema_migrations WHERE version='084_customer_group_assistant.sql'"));
  for(const table of ['customer_assistant_settings','customer_assistant_sessions','customer_assistant_events','customer_assistant_email_deliveries']) {
    assert.equal((await db.queryOne('SELECT to_regclass($1)::text AS name',[table])).name,table);
  }

  const {createCustomerAssistantService}=await import('../../../server/services/customer-assistant-service.js');
  const {createCustomerAssistantTools}=await import('../../../server/services/customer-assistant-tools.js');
  const {createCustomerAssistantEmailService}=await import('../../../server/services/customer-assistant-email.js');
  const {createCustomerDailyReportService}=await import('../../../server/services/customer-daily-reports.js');
  const {createCustomerAssistantWebhookRouter}=await import('../../../server/routes/customer-assistant.js');
  const fixed=()=>new Date('2026-09-12T03:00:00Z');
  const env={CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY:'a1'.repeat(32)};

  async function fixture(subtest,{mode='live',emailAllowed=true,instant='2026-09-12T03:00:00Z',defaultQueryDates=false}={}) {
    const fixed=()=>new Date(instant);
    const tenantId=randomUUID(),reportId=randomUUID(),suffix=randomUUID().replaceAll('-','');
    const chatId=`oc_${suffix}`,senderId=`ou_${suffix}`,botId='ou_assistant_test_bot';
    const appId='cli_assistant_test',verificationToken='assistant-test-verification',encryptKey='assistant-test-envelope';
    const mailbox=`client-${suffix}@example.test`,actorId=randomUUID();
    const calls={model:[],feishu:[],smtp:[],tools:[]};
    await db.execute('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,`Assistant integration ${suffix}`]);
    subtest.after(()=>db.execute('DELETE FROM tenants WHERE id=$1',[tenantId]));
    const counts={monitor:10,sdb:9,positive:2,neutral:3,negative:4,cold:1,inProgress:null,processed:null,unclassified:0};
    const snapshot={id:reportId,tenantId,tenantName:'测试客户保存版',version:2,reportDate:'2026-09-11',mode:'formal',reportBasis:'customer_workday_v1',
      collectionStartAt:'2026-09-10T10:00:00Z',collectionEndAt:'2026-09-11T10:00:00Z',collectionCutoffAt:'2026-09-11T10:00:00Z',
      cutoffAt:'2026-09-11T10:00:00Z',assessedAt:'2026-09-11T10:05:00Z',summary:{day:{...counts},mtd:{...counts}},highHeat:[],coldMarked:[],warnings:[]};
    await db.execute(`INSERT INTO customer_daily_reports(id,tenant_id,report_date,mode,version,request_key,snapshot)
      VALUES($1,$2,'2026-09-11','formal',2,$3,$4::jsonb)`,[reportId,tenantId,randomUUID(),JSON.stringify(snapshot)]);
    // Real configuration readiness is used. Only SMTP transport is replaced; it cannot open a connection.
    for(const [key,value] of Object.entries({smtp_host:'smtp.example.test',smtp_port:'465',smtp_user:'sender@example.test',smtp_pass:'fixture-not-a-real-password'})) {
      await db.execute('INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,$2,$3)',[tenantId,key,value]);
    }
    let smtpHandler=async message=>({accepted:[message.to],rejected:[],messageId:'mock-smtp-accepted'});
    const email=createCustomerAssistantEmailService({db,now:fixed,send:async message=>{calls.smtp.push(message);return smtpHandler(message);}});
    const dailyReports=createCustomerDailyReportService({db,now:fixed,env});
    const tools=createCustomerAssistantTools({db,dailyReports,email,now:fixed});
    const makeModel=()=>async ({messages})=>{
      calls.model.push(structuredClone(messages));
      const last=messages.at(-1);
      if(last.role==='tool') {
        const result=JSON.parse(last.content);calls.tools.push(result);
        return {role:'assistant',content:result.tool==='query_negative' ? `本次监控范围负面 ${result.total} 条，待分析 ${result.pendingAnalysis} 条，截至 ${result.cutoffAt}。`
          :result.tool==='get_daily_report' ? `日报 ${result.reportDate} v${result.version}，来源 ${result.source}。` : '已处理邮件请求。'};
      }
      const text=messages.findLast(message=>message.role==='user').content;
      const name=text.includes('邮件')?'email_daily_report':text.includes('日报')?'get_daily_report':'query_negative';
      const args=name==='email_daily_report'?{reportId}:name==='get_daily_report'?{date:'2026-09-11'}:defaultQueryDates?{}:{dateFrom:'2026-09-12',dateTo:'2026-09-12',limit:20};
      return {role:'assistant',content:'',tool_calls:[{id:`call_${randomUUID()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
    };
    const service=createCustomerAssistantService({db,email,tools,now:fixed,env,makeModel,
      makeFeishu:()=>({reply:async(...args)=>{calls.feishu.push(args);return {code:0,data:{message_id:`om_reply_${args[0]}`,thread_id:`omt_${args[0]}`}};}})});
    await service.saveSettings(tenantId,{enabled:true,mode,useDailyApp:false,appId,appSecret:'fixture-app-secret',botOpenId:botId,verificationToken,encryptKey,
      groups:[{chatId,name:'测试客户群'}],members:[{chatId,openId:senderId,name:'测试成员',email:mailbox,canEmail:emailAllowed}]},actorId);

    function signed(text='今天有多少负面',changes={}) {
      const messageId=changes.messageId||`om_${randomUUID().replaceAll('-','')}`;
      const payload={schema:'2.0',header:{event_id:changes.eventId||`ev_${randomUUID().replaceAll('-','')}`,event_type:'im.message.receive_v1',token:verificationToken,app_id:appId},
        event:{sender:{sender_type:'user',sender_id:{open_id:changes.senderId||senderId}},message:{message_id:messageId,chat_id:changes.chatId||chatId,chat_type:'group',message_type:'text',
          create_time:String(new Date(changes.requestedAt||fixed()).getTime()),...(changes.threadId?{thread_id:changes.threadId}:{}),...(changes.rootId?{root_id:changes.rootId}:{}),
          mentions:[{key:'@_user_1',id:{open_id:botId}}],content:JSON.stringify({text:`@_user_1 ${text}`})}}};
      const rawBody=Buffer.from(JSON.stringify(payload)),timestamp=String(Math.floor(fixed().getTime()/1000)),nonce=randomUUID();
      const headers={'content-type':'application/json','x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,
        'x-lark-signature':createHash('sha256').update(`${timestamp}${nonce}${encryptKey}`).update(rawBody).digest('hex')};
      return {rawBody,headers,messageId,payload};
    }
    const app=express();app.use('/callback',createCustomerAssistantWebhookRouter(service));
    const server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
    subtest.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
    const base=`http://127.0.0.1:${server.address().port}/callback`;
    const callback=async(event,destination=tenantId)=>{const response=await fetch(`${base}/${destination}`,{method:'POST',headers:event.headers,body:event.rawBody});return {status:response.status,body:await response.json()};};
    const context=requestId=>({tenantId,chatId,senderId,requestId,emailAllowed:true,email:mailbox,dryRun:false});
    return {tenantId,reportId,chatId,senderId,mailbox,actorId,calls,service,email,tools,snapshot,signed,callback,context,
      event:messageId=>db.queryOne('SELECT * FROM customer_assistant_events WHERE tenant_id=$1 AND message_id=$2',[tenantId,messageId]),
      smtpResult:handler=>{smtpHandler=handler;}};
  }

  async function record(tenantId,overrides={}) {
    const id=randomUUID();
    const row={platform:'douyin',sentiment:'negative',createdAt:'2026-09-12T01:00:00Z',visibility:'eligible',recordType:'single_note',relevance:'relevant',...overrides};
    await db.execute(`INSERT INTO records(id,tenant_id,external_id,platform,title,url,canonical_url,sentiment,created_at,business_visibility,record_type,ai_result,seen_count)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11::jsonb,$12)`,[id,tenantId,id,row.platform,`Fixture ${id}`,`https://example.test/post/${id}`,row.sentiment,row.createdAt,row.visibility,row.recordType,JSON.stringify({relevance:row.relevance}),row.seenCount||1]);
    if(row.triage) await db.execute('INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)',[tenantId,id,row.triage]);
    if(row.watched) await db.execute('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)',[tenantId,id]);
    return id;
  }

  await t.test('signed HTTP callback queues once, runs real negative SQL and replies once',async subtest=>{
    const f=await fixture(subtest),foreign=await fixture(subtest);
    const expected=[];
    expected.push(await record(f.tenantId,{seenCount:99}));
    expected.push(await record(f.tenantId,{platform:'xiaohongshu',createdAt:'2026-09-12T02:00:00Z'}));
    expected.push(await record(f.tenantId,{relevance:'irrelevant',watched:true}));
    await record(f.tenantId,{sentiment:''});await record(f.tenantId,{sentiment:'positive'});
    for(const excluded of [{visibility:'filtered_out'},{visibility:'deferred'},{recordType:'comment'},{recordType:'official_content'},{triage:'reviewed_non_monitor'},{relevance:'irrelevant'},{createdAt:'2026-09-11T15:59:59Z'},{createdAt:'2026-09-12T03:00:00Z'}]) await record(f.tenantId,excluded);
    await record(foreign.tenantId);
    const event=f.signed();const accepted=await f.callback(event);assert.equal(accepted.status,200);assert.equal((await f.event(event.messageId)).status,'queued');
    assert.equal(f.calls.model.length,0);assert.equal(f.calls.feishu.length,0);
    await Promise.all([f.callback(event),f.callback(event),f.service.processOne(),f.service.processOne()]);
    assert.equal((await f.event(event.messageId)).status,'completed');assert.equal(f.calls.model.length,2);assert.equal(f.calls.feishu.length,1);
    assert.match(f.calls.feishu[0][1],/负面 3 条/);assert.match(f.calls.feishu[0][1],/待分析 1 条/);
    const result=f.calls.tools.find(value=>value.tool==='query_negative');assert.equal(result.ok,true);assert.equal(result.total,3);assert.equal(result.monitored,5);assert.equal(result.pendingAnalysis,1);
    assert.deepEqual(result.details.map(item=>item.id).sort(),expected.sort());assert.equal(result.cutoffAt,'2026-09-12T03:00:00.000Z');
    assert.deepEqual(result.byPlatform.map(item=>[item.platform,item.negative]),[['douyin',2],['xiaohongshu',1]]);
    await f.callback(event);assert.equal(await f.service.processOne(),false);assert.equal(f.calls.model.length,2);assert.equal(f.calls.feishu.length,1);assert.equal(f.calls.smtp.length,0);
  });

  await t.test('invalid signature and other tenant group/member bindings never admit work',async subtest=>{
    const f=await fixture(subtest),other=await fixture(subtest);
    const invalid=f.signed();invalid.headers['x-lark-signature']='0'.repeat(64);assert.equal((await f.callback(invalid)).status,401);
    assert.equal((await f.callback(f.signed('今天有多少负面',{senderId:other.senderId}))).body.ignored,true);
    assert.equal((await f.callback(f.signed('今天有多少负面',{chatId:other.chatId}))).body.ignored,true);
    assert.equal((await f.callback(f.signed(),other.tenantId)).body.ignored,true);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_assistant_events WHERE tenant_id=ANY($1::uuid[])',[[f.tenantId,other.tenantId]])).count,0);
    await assert.rejects(other.service.saveSettings(other.tenantId,{groups:[{chatId:f.chatId}],members:[]},other.actorId),error=>['assistant_group_already_bound','assistant_settings_invalid'].includes(error.code));
    assert.equal(f.calls.model.length+other.calls.model.length,0);
  });

  await t.test('admin preview under live settings executes actual email tool but never delivers externally',async subtest=>{
    const f=await fixture(subtest);
    const result=await f.service.preview(f.tenantId,{text:'今天日报发我邮件',chatId:f.chatId,senderId:f.senderId},f.actorId);
    assert.equal(result.dryRun,true);assert.match(result.reply,/未发送邮件/);assert.equal(f.calls.tools[0].status,'preview');
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_assistant_email_deliveries WHERE tenant_id=$1',[f.tenantId])).count,0);
    assert.equal(f.calls.smtp.length,0);assert.equal(f.calls.feishu.length,0);
    const activity=await f.service.activity(f.tenantId);assert.equal(activity[0].status,'completed');assert.equal(activity[0].dryRun,true);
  });

  await t.test('preview-mode callback is stored and answered locally without Feishu or SMTP',async subtest=>{
    const f=await fixture(subtest,{mode:'preview'}),event=f.signed('今天日报发我邮件');
    await f.callback(event);await f.service.processCycle();
    assert.equal((await f.event(event.messageId)).status,'completed');assert.equal(f.calls.tools[0].status,'preview');
    assert.equal(f.calls.smtp.length,0);assert.equal(f.calls.feishu.length,0);
  });

  await t.test('bound email goes through actual agent, frozen Excel generation and persistent receipts once',async subtest=>{
    const f=await fixture(subtest),event=f.signed('今天日报发我邮件');await f.callback(event);await f.service.processCycle();
    assert.equal(f.calls.smtp.length,1);assert.equal(f.calls.feishu.length,2);assert.equal(f.calls.model.length,2);
    const message=f.calls.smtp[0];assert.equal(message.to,f.mailbox);assert.equal(message.tenantId,f.tenantId);assert.match(message.html,/不包含客户之后在飞书文档中的修改/);
    assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].content.subarray(0,2).toString(),'PK');
    const saved=await db.queryOne('SELECT * FROM customer_assistant_email_deliveries WHERE tenant_id=$1',[f.tenantId]);assert.equal(saved.status,'sent');assert.ok(saved.notified_at);assert.equal(saved.snapshot.version,2);
    assert.equal((await f.email.enqueue(f.context(event.messageId),f.reportId)).id,saved.id);
    await f.callback(event);await f.service.processCycle();assert.equal(f.calls.smtp.length,1);assert.equal(f.calls.feishu.length,2);
    assert.match(f.calls.feishu[1][1],/已交给邮件服务器/);
  });

  await t.test('a restart after SMTP success discovers and sends the first pending receipt without sending the email twice',async subtest=>{
    const f=await fixture(subtest),event=f.signed('今天日报发我邮件');await f.callback(event);
    await f.service.processOne();assert.equal(f.calls.feishu.length,1);assert.equal(f.calls.smtp.length,0);
    const sent=await f.email.processOne();assert.equal(sent.status,'sent');assert.equal(f.calls.smtp.length,1);
    assert.equal((await db.queryOne('SELECT notified_at FROM customer_assistant_email_deliveries WHERE id=$1',[sent.id])).notified_at,null);
    // Simulate the process ending before notifyEmail: only the durable terminal row remains to drive recovery.
    const pending=await f.email.listUnnotifiedTerminal();assert.equal(pending.length,1);assert.equal(pending[0].requestId,event.messageId);
    await f.service.processCycle();assert.equal(f.calls.feishu.length,2);assert.match(f.calls.feishu[1][1],/已交给邮件服务器/);
    assert.deepEqual(await f.email.listUnnotifiedTerminal(),[]);
    await f.service.processCycle();assert.equal(f.calls.feishu.length,2);assert.equal(f.calls.smtp.length,1);
  });

  await t.test('unauthorized email request fails at the agent gate and cross-tenant reports fail in the tool',async subtest=>{
    const f=await fixture(subtest,{emailAllowed:false}),other=await fixture(subtest);
    const event=f.signed('今天日报发我邮件');await f.callback(event);await f.service.processCycle();
    assert.equal(f.calls.smtp.length,0);assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_assistant_email_deliveries WHERE tenant_id=$1',[f.tenantId])).count,0);
    await assert.rejects(other.tools.executeTool('email_daily_report',{reportId:f.reportId},other.context('cross-tenant-request')),{code:'assistant_report_not_found'});
    await assert.rejects(db.execute(`INSERT INTO customer_assistant_email_deliveries(id,tenant_id,report_id,chat_id,sender_id,request_id,recipient,subject,snapshot)
      VALUES($1,$2,$3,'chat','sender','request','x@example.test','test','{}')`,[randomUUID(),other.tenantId,f.reportId]),{code:'23503'});
  });

  await t.test('kill switch, preview switch, revoked membership and paused tenant stop queued SMTP',async subtest=>{
    for(const change of ['disabled','preview','member','email','tenant']) {
      const f=await fixture(subtest);await f.email.enqueue(f.context(`kill-${change}`),f.reportId);
      if(change==='tenant') await db.execute("UPDATE tenants SET status='paused' WHERE id=$1",[f.tenantId]);
      else if(change==='disabled') await f.service.saveSettings(f.tenantId,{enabled:false},f.actorId);
      else if(change==='preview') await f.service.saveSettings(f.tenantId,{mode:'preview'},f.actorId);
      else await f.service.saveSettings(f.tenantId,{members:[{chatId:f.chatId,openId:f.senderId,canEmail:change!=='member',email:change==='email'?'changed@example.test':f.mailbox}]},f.actorId);
      const result=await f.email.processOne();assert.equal(result.status,'failed');assert.equal(result.ambiguous,false);assert.match(result.error,/未发送邮件/);
      assert.equal(f.calls.smtp.length,0);assert.equal(await f.email.processOne(),null);
    }
  });

  await t.test('parallel enqueue/workers freeze request destination and ambiguous SMTP never retries',async subtest=>{
    const f=await fixture(subtest);const context=f.context('parallel-request');
    const enqueued=await Promise.all(Array.from({length:4},()=>f.email.enqueue(context,f.reportId)));
    assert.equal(new Set(enqueued.map(result=>result.id)).size,1);
    const results=await Promise.all([f.email.processOne(),f.email.processOne()]);assert.equal(results.filter(Boolean).length,1);assert.equal(f.calls.smtp.length,1);
    const second=f.context('timeout-request');f.smtpResult(async()=>{throw Object.assign(new Error('private SMTP timeout'),{code:'ETIMEDOUT'});});
    await f.email.enqueue(second,f.reportId);const unknown=await f.email.processOne();assert.equal(unknown.status,'unknown');assert.equal(unknown.ambiguous,true);
    assert.equal((await f.email.enqueue(second,f.reportId)).status,'unknown');assert.equal(await f.email.processOne(),null);assert.equal(f.calls.smtp.length,2);
    const stale=f.context('stale-request');const queued=await f.email.enqueue(stale,f.reportId);
    await db.execute("UPDATE customer_assistant_email_deliveries SET status='working',claimed_at='2026-09-12T02:00:00Z' WHERE id=$1",[queued.id]);
    const recovered=await f.email.recoverStale();assert.equal(recovered.length,1);assert.equal(recovered[0].status,'unknown');assert.equal(await f.email.processOne(),null);assert.equal(f.calls.smtp.length,2);
  });

  await t.test('existing delivered report is read without generating or changing its customer document',async subtest=>{
    const f=await fixture(subtest);
    await db.execute(`INSERT INTO customer_daily_documents(report_id,tenant_id,status,document_id,document_url,config)
      VALUES($1,$2,'ready','fixture_document','https://client.feishu.cn/docx/fixture_document','{}')`,[f.reportId,f.tenantId]);
    const event=f.signed('今天日报给我一份');await f.callback(event);await f.service.processOne();
    assert.equal(f.calls.tools[0].reportId,f.reportId);assert.equal(f.calls.tools[0].source,'feishu_document');assert.equal(f.calls.tools[0].version,2);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_reports WHERE tenant_id=$1',[f.tenantId])).count,1);
    assert.equal(f.calls.smtp.length,0);assert.equal(f.calls.feishu.length,1);
  });

  await t.test('thread follow-up restores the exact parent conversation, excluding a later unrelated main message',async subtest=>{
    const f=await fixture(subtest);const parent=f.signed('首次查询今天负面');await f.callback(parent);await f.service.processOne();
    const first=await f.event(parent.messageId);assert.equal(first.thread_id,`omt_${parent.messageId}`);assert.ok(Array.isArray(first.conversation_history));
    const unrelated=f.signed('另一件事，日报给我一份');await f.callback(unrelated);await f.service.processOne();
    const follow=f.signed('这些负面有哪些',{rootId:parent.messageId,threadId:first.thread_id});await f.callback(follow);await f.service.processOne();
    const users=f.calls.model.at(-2).filter(message=>message.role==='user').map(message=>message.content);
    assert.ok(users.includes('首次查询今天负面'));assert.ok(users.includes('这些负面有哪些'));assert.ok(!users.includes('另一件事，日报给我一份'));
    assert.equal((await f.event(follow.messageId)).status,'completed');
  });

  await t.test('an unqualified today query crossing midnight uses the message date rather than worker date',async subtest=>{
    const f=await fixture(subtest,{instant:'2026-09-12T16:01:00Z',defaultQueryDates:true});
    const yesterday=await record(f.tenantId,{createdAt:'2026-09-12T15:58:00Z'});await record(f.tenantId,{createdAt:'2026-09-12T16:00:30Z'});
    const event=f.signed('今天有多少负面',{requestedAt:'2026-09-12T15:59:00Z'});await f.callback(event);await f.service.processOne();
    const result=f.calls.tools[0];assert.equal(result.ok,true);assert.equal(result.dateFrom,'2026-09-12');assert.equal(result.dateTo,'2026-09-12');assert.equal(result.total,1);
    assert.equal(result.details[0].id,yesterday);assert.equal(result.cutoffAt,'2026-09-12T16:00:00.000Z');
  });
});
