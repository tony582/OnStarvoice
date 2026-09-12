import assert from 'node:assert/strict';
import test from 'node:test';
import {createCustomerAssistantEmailService,CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE} from '../server/services/customer-assistant-email.js';

const reportId='11111111-1111-4111-8111-111111111111';
const context={tenantId:'tenant-a',chatId:'chat-a',senderId:'sender-a',requestId:'message-a',emailAllowed:true,email:'CLIENT@example.test'};
const clock=()=>new Date('2026-09-12T03:00:00Z');
const savedReport=()=>({report_date:'2026-09-11',version:2,snapshot:{tenantId:'tenant-a',tenantName:'客户\n测试',reportDate:'2026-09-11',version:2,summary:{day:{negative:3}}}});

function fixture({send = async()=>({accepted:['client@example.test'],rejected:[],messageId:'smtp-ok'}),buildMessage=async saved=>({html:'saved report',text:`version ${saved.version}`,attachments:[]}),ready=true,report=savedReport(),loseReceipt=false,authorize,tenantActive=true,settings={enabled:true,mode:'live',groups:[{chatId:'chat-a'}],members:[{chatId:'chat-a',openId:'sender-a',canEmail:true,email:'client@example.test'}]}}={}) {
  const rows=[],calls=[],writes=[];
  const db={
    async withTransaction(fn){return fn(db);},
    async queryOne(sql,params){
      if(sql.includes('pg_advisory_xact_lock')) return {};
      if(sql.includes('FROM customer_assistant_settings')) {assert.match(sql,/JOIN tenants t ON t.id=s.tenant_id AND t.status='active'/);calls.push(['authorization',...params]);return tenantActive ? {config:settings} : null;}
      if(sql.includes('FROM customer_daily_reports')) {calls.push(['report',...params]);return params[0]==='tenant-a'&&params[1]===reportId ? structuredClone(report) : null;}
      if(sql.includes('FROM customer_assistant_email_deliveries')&&sql.includes('request_id=$4')) return rows.find(row=>[row.tenant_id,row.chat_id,row.sender_id,row.request_id,row.report_id,row.recipient].every((value,i)=>value===params[i])) || null;
      if(sql.includes("WHERE status='queued'")) return structuredClone(rows.find(row=>row.status==='queued') || null);
      if(sql.includes("SET status='sent'")) {
        if(loseReceipt) throw new Error('database private failure');
        const row=rows.find(row=>row.tenant_id===params[0]&&row.id===params[1]&&row.claim_token===params[2]);
        if(!row) return null;Object.assign(row,{status:'sent',sent_at:params[4],message_id:params[3],ambiguous:false,claim_token:null});return {id:row.id};
      }
      throw new Error(`Unexpected read: ${sql}`);
    },
    async queryAll(sql,params) {
      if(sql.includes("WHERE status IN ('sent','failed') AND notified_at IS NULL")) return rows.filter(row=>['sent','failed'].includes(row.status)&&!row.notified_at).slice(0,params[0]);
      assert.match(sql,/WHERE status='working' AND claimed_at<\$1/);
      return rows.filter(row=>row.status==='working'&&row.claimed_at<params[0]).map(row=>{Object.assign(row,{status:'failed',ambiguous:true,claim_token:null,error_message:'发送结果待核实'});return structuredClone(row);});
    },
    async execute(sql,params) {
      writes.push(sql);
      if(sql.includes('INSERT INTO customer_assistant_email_deliveries')) {
        const [id,tenant_id,chat_id,sender_id,request_id,report_id,recipient,subject,snapshot]=params;
        rows.push({id,tenant_id,chat_id,sender_id,request_id,report_id,recipient,subject,snapshot:JSON.parse(snapshot),status:'queued',ambiguous:false,attempts:0});
      } else if(sql.includes("SET status='working'")) Object.assign(rows.find(row=>row.id===params[0]),{status:'working',claim_token:params[1],claimed_at:params[2]});
      else if(sql.includes("SET status='failed'")) {
        const row=rows.find(row=>row.id===params[1]&&row.claim_token===params[2]);if(row) Object.assign(row,{status:'failed',ambiguous:params[3],error_message:params[4],claim_token:null});
      } else throw new Error(`Unexpected mutation: ${sql}`);
      return {rowCount:1};
    },
  };
  const service=createCustomerAssistantEmailService({db,now:clock,authorize,readiness:async tenant=>{calls.push(['readiness',tenant]);return {ready};},buildMessage,send:async message=>{calls.push(['send',message]);return send(message);}});
  return {service,rows,calls,writes,db};
}

test('dry-run validates tenant/version and returns a masked preview without transaction or email',async()=>{
  const f=fixture();f.db.withTransaction=async()=>{throw new Error('preview must not transact');};
  const result=await f.service.enqueue({...context,dryRun:true},reportId);
  assert.equal(result.status,'preview');assert.equal(result.dryRun,true);assert.equal(result.version,2);assert.equal(result.emailReady,true);
  assert.equal(result.recipientMasked,'c***@example.test');assert.equal(result.id,null);assert.equal(f.writes.length,0);assert.equal(f.rows.length,0);
  assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);assert.match(result.snapshotNotice,/不包含客户之后在飞书/);
});

test('unbound, multi-address, forbidden or cross-tenant requests cannot enqueue',async()=>{
  const f=fixture();
  for(const patch of [{emailAllowed:false},{email:''},{email:'a@example.test,b@example.test'},{email:'a@example.test\r\nBcc:x@example.test'},{email:'客户 <a@example.test>'},{requestId:''}]) {
    await assert.rejects(f.service.enqueue({...context,...patch},reportId),error=>error.code.startsWith('assistant_'));
  }
  await assert.rejects(f.service.enqueue({...context,tenantId:'tenant-b'},reportId),{code:'assistant_report_not_found'});
  await assert.rejects(f.service.enqueue(context,'not-a-report'),{code:'assistant_report_invalid'});
  assert.equal(f.rows.length,0);assert.equal(f.calls.filter(([kind])=>kind==='readiness').length,0);
});

test('enqueue freezes report and single bound mailbox without changing existing daily recipients',async()=>{
  const report=savedReport(),f=fixture({report});
  const result=await f.service.enqueue(context,reportId);
  assert.equal(result.status,'queued');assert.equal(f.rows[0].recipient,'client@example.test');assert.doesNotMatch(f.rows[0].subject,/[\r\n]/);
  report.snapshot.summary.day.negative=999;assert.equal(f.rows[0].snapshot.summary.day.negative,3);
  assert.ok(f.writes.every(sql=>sql.includes('customer_assistant_email_deliveries')));
  assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);
});

test('event replay returns the same delivery and does not requeue a failed request',async()=>{
  const f=fixture();const first=await f.service.enqueue(context,reportId);
  assert.equal((await f.service.enqueue(context,reportId)).id,first.id);assert.equal(f.rows.length,1);
  Object.assign(f.rows[0],{status:'failed',ambiguous:false});
  assert.equal((await f.service.enqueue(context,reportId)).status,'failed');assert.equal(f.rows.length,1);
  const next=await f.service.enqueue({...context,requestId:'message-b'},reportId);assert.notEqual(next.id,first.id);assert.equal(f.rows.length,2);
});

test('different bound members/mailboxes receive independent deliveries for the same report',async()=>{
  const f=fixture();await f.service.enqueue(context,reportId);
  await f.service.enqueue({...context,senderId:'sender-b',email:'other@example.test'},reportId);
  assert.equal(f.rows.length,2);assert.notEqual(f.rows[0].recipient,f.rows[1].recipient);
});

test('successful worker sends frozen snapshot only once and returns source identity for receipt',async()=>{
  const f=fixture();const queued=await f.service.enqueue(context,reportId);const result=await f.service.processOne();
  assert.equal(result.status,'sent');assert.equal(result.id,queued.id);assert.equal(result.tenantId,'tenant-a');assert.equal(result.chatId,'chat-a');assert.equal(result.senderId,'sender-a');assert.equal(result.requestId,'message-a');
  const message=f.calls.find(([kind])=>kind==='send')[1];
  assert.equal(message.to,'client@example.test');assert.equal(message.tenantId,'tenant-a');assert.match(message.html,new RegExp(CUSTOMER_ASSISTANT_SNAPSHOT_NOTICE));
  assert.match(message.text,/version 2/);assert.equal(message.messageId,`<customer-assistant-${queued.id}@starvoice.local>`);
  assert.equal(await f.service.processOne(),null);assert.equal((await f.service.enqueue(context,reportId)).status,'sent');
  assert.equal(f.calls.filter(([kind])=>kind==='send').length,1);
});

test('timeout, missing acceptance and post-send persistence failure are unknown and never retried',async()=>{
  for(const config of [{send:async()=>{throw Object.assign(new Error('SMTP private secret'),{code:'ETIMEDOUT'});}},{send:async()=>({messageId:'unconfirmed'})},{loseReceipt:true}]) {
    const f=fixture(config);await f.service.enqueue(context,reportId);const result=await f.service.processOne();
    assert.equal(result.status,'unknown');assert.equal(result.ambiguous,true);assert.doesNotMatch(result.error,/private|secret/);
    assert.equal(await f.service.processOne(),null);assert.equal((await f.service.enqueue(context,reportId)).status,'unknown');
    assert.equal(f.calls.filter(([kind])=>kind==='send').length,1);
  }
});

test('definite SMTP rejection and build failure stay failed without automatic retries',async()=>{
  for(const config of [{send:async()=>({accepted:[],rejected:['client@example.test']})},{send:async()=>{throw Object.assign(new Error('private'),{code:'EAUTH'});}},{buildMessage:async()=>{throw new Error('bad workbook');}}]) {
    const f=fixture(config);await f.service.enqueue(context,reportId);const result=await f.service.processOne();
    assert.equal(result.status,'failed');assert.equal(result.ambiguous,false);assert.equal(await f.service.processOne(),null);
    if(config.buildMessage) assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);
  }
});

test('stale working claims become unknown with source receipt and are not requeued',async()=>{
  const f=fixture();await f.service.enqueue(context,reportId);Object.assign(f.rows[0],{status:'working',claimed_at:'2026-09-12T02:49:00.000Z'});
  const recovered=await f.service.recoverStale();assert.equal(recovered.length,1);assert.equal(recovered[0].status,'unknown');assert.equal(recovered[0].requestId,'message-a');
  assert.equal(await f.service.processOne(),null);assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);
});

test('missing SMTP configuration rejects before creating a delivery',async()=>{
  const f=fixture({ready:false});await assert.rejects(f.service.enqueue(context,reportId),{code:'assistant_email_not_configured'});assert.equal(f.rows.length,0);
});

test('worker checks live current settings immediately before send and fails closed after revocation',async()=>{
  const good={enabled:true,mode:'live',groups:[{chatId:'chat-a'}],members:[{chatId:'chat-a',openId:'sender-a',canEmail:true,email:'client@example.test'}]};
  for(const patch of [{enabled:false},{mode:'preview'},{groups:[]},{members:[]},{members:[{chatId:'chat-a',openId:'sender-a',canEmail:false,email:'client@example.test'}]},{members:[{chatId:'chat-a',openId:'sender-a',canEmail:true,email:'changed@example.test'}]}]) {
    const settings=structuredClone(good),f=fixture({settings});await f.service.enqueue(context,reportId);Object.assign(settings,patch);
    const result=await f.service.processOne();assert.equal(result.status,'failed');assert.equal(result.ambiguous,false);assert.match(result.error,/未发送邮件/);
    assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);assert.equal(await f.service.processOne(),null);
  }
});

test('authorization can be injected and receives only frozen server identity',async()=>{
  const calls=[],f=fixture({authorize:async identity=>{calls.push(identity);return false;}});await f.service.enqueue(context,reportId);
  assert.equal((await f.service.processOne()).status,'failed');
  assert.deepEqual(calls,[{tenantId:'tenant-a',chatId:'chat-a',senderId:'sender-a',requestId:'message-a',email:'client@example.test',reportId}]);
  assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);
});

test('paused or deleted tenants cannot send previously queued email',async()=>{
  const f=fixture({tenantActive:false});await f.service.enqueue(context,reportId);
  const result=await f.service.processOne();assert.equal(result.status,'failed');assert.equal(result.ambiguous,false);
  assert.equal(f.calls.filter(([kind])=>kind==='send').length,0);
});

test('unnotified terminal deliveries are discoverable after restart and preserve unknown status and source identity',async()=>{
  const f=fixture();await f.service.enqueue(context,reportId);await f.service.processOne();
  const found=await f.service.listUnnotifiedTerminal();assert.equal(found.length,1);assert.equal(found[0].status,'sent');assert.equal(found[0].requestId,'message-a');
  Object.assign(f.rows[0],{status:'failed',ambiguous:true});assert.equal((await f.service.listUnnotifiedTerminal())[0].status,'unknown');
  f.rows[0].notified_at='2026-09-12T03:00:00Z';assert.deepEqual(await f.service.listUnnotifiedTerminal(),[]);
});
