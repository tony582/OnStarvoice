import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDailyEmailMessage,createCustomerDailyEmailService} from '../server/services/customer-daily-email.js';
import {mergeDailyConfig,normalizeDailyEmailRecipients,publicDailyConfig} from '../server/services/customer-daily-report-config.js';
import {tenantEmailReadiness} from '../server/services/email-notifier.js';

function snapshot() {
  const counts={monitor:10,sdb:8,positive:2,neutral:3,negative:3,cold:1,inProgress:null,processed:null};
  return {id:'report-one',version:2,tenantId:'tenant-one',tenantName:'客户 <测试>',reportDate:'2026-09-09',mode:'formal',
    cutoffAt:'2026-09-09T16:00:00Z',assessedAt:'2026-09-10T02:00:00Z',summary:{day:{...counts},mtd:{...counts}},
    highHeat:[{title:'需要处理的原帖',url:'https://example.test/post',platform:'xiaohongshu',heat:300}],coldMarked:[],
    warnings:[{message:'内部检查信息',blocking:true}]};
}

test('daily email recipients are explicit, normalized, deduplicated and cannot inject headers',()=>{
  assert.equal(normalizeDailyEmailRecipients('first@example.test; SECOND@example.test\nfirst@example.test'),'first@example.test, SECOND@example.test');
  assert.equal(normalizeDailyEmailRecipients(''), '');
  for(const value of ['客户 <client@example.test>','a@example.test\nBcc:leak@example.test','https://example.test',42,Array.from({length:51},(_,i)=>`c${i}@example.test`).join(',')]) {
    assert.throws(()=>normalizeDailyEmailRecipients(value),{code:'daily_email_recipients_invalid'});
  }
  const config=mergeDailyConfig({}, {emailRecipients:'customer@example.test'},'tenant-one');
  assert.equal(publicDailyConfig(config).emailRecipients,'customer@example.test');
  assert.equal(config.autoEnabled,false);
  assert.equal(config.appSecretEncrypted,undefined,'email-only config needs no Feishu credentials');
  assert.equal(mergeDailyConfig(config,{emailReady:true,emailConfigError:'forged'},'tenant-one').emailReady,undefined);
});

test('email readiness uses this tenant and inspects configuration without opening a connection',async()=>{
  const calls=[];
  const values={smtp_host:'smtp.example.test',smtp_port:'465',smtp_user:'sender@example.test',smtp_pass:'private-password'};
  const readSetting=async(key,tenantId)=>{calls.push([key,tenantId]); return values[key];};
  assert.deepEqual(await tenantEmailReadiness('tenant-two',{readSetting,env:{}}),{ready:true});
  assert.ok(calls.every(([,tenantId])=>tenantId==='tenant-two'));
  values.smtp_pass='';
  assert.deepEqual(await tenantEmailReadiness('tenant-two',{readSetting,env:{}}),{ready:false});
  values.smtp_pass='private-password'; values.smtp_port='NaN';
  assert.deepEqual(await tenantEmailReadiness('tenant-two',{readSetting,env:{}}),{ready:false});
});

test('email contains the rendered saved report and an editable Excel attachment, without internal warnings',async()=>{
  const frozen=snapshot(), original=structuredClone(frozen);
  const message=await buildDailyEmailMessage(frozen);
  assert.match(message.html,/客户 &lt;测试&gt;/);
  assert.match(message.html,/https:\/\/example.test\/post/);
  assert.match(message.text,/需要处理的原帖/);
  assert.doesNotMatch(message.html+message.text,/内部检查信息/);
  assert.equal(message.attachments.length,1);
  assert.equal(message.attachments[0].filename,'客户日报_2026-09-09_v2.xlsx');
  assert.ok(Buffer.isBuffer(message.attachments[0].content));
  assert.equal(message.attachments[0].content.subarray(0,2).toString(),'PK');
  assert.deepEqual(frozen,original);
});

function workerFixture(send,{buildMessage=async saved=>({html:saved.tenantName,text:saved.tenantName,attachments:[]})}={}) {
  const row={id:'delivery-one',report_id:'report-one',tenant_id:'tenant-one',recipients:'a@example.test, b@example.test',subject:'已冻结的标题',snapshot:snapshot(),status:'queued',ambiguous:false,claim_token:null};
  const calls=[];
  const db={
    async queryOne(sql) { return sql.includes("WHERE status='queued'") && row.status==='queued' ? structuredClone(row) : null; },
    async execute(sql,params) {
      if(sql.includes("SET status='working'")) {row.status='working'; row.claim_token=params[1];}
      else if(sql.includes("SET status='sent'")) {if(row.claim_token===params[2]) {row.status='sent';row.message_id=params[3];row.claim_token=null;}}
      else if(sql.includes("SET status='failed'")) {if(row.claim_token===params[2]) {row.status='failed';row.ambiguous=params[3];row.error_message=params[4];row.claim_token=null;}}
      else throw new Error(`Unexpected write ${sql}`);
      return {rowCount:1};
    },
    async withTransaction(callback) {return callback(db);},
  };
  return {row,calls,service:createCustomerDailyEmailService({db,buildMessage,send:async message=>{calls.push(message);return send(message);}})};
}

test('a successful worker sends the frozen tenant, recipients, message and stable identity once',async()=>{
  const f=workerFixture(async()=>({accepted:['a@example.test','b@example.test'],rejected:[],messageId:'smtp-id'}));
  assert.equal(await f.service.processOne(),true);
  assert.equal(f.row.status,'sent');
  assert.equal(f.row.message_id,'smtp-id');
  assert.equal(f.calls[0].tenantId,'tenant-one');
  assert.equal(f.calls[0].to,'a@example.test, b@example.test');
  assert.equal(f.calls[0].subject,'已冻结的标题');
  assert.equal(f.calls[0].messageId,'<daily-report-delivery-one@starvoice.local>');
  assert.equal(await f.service.processOne(),false);
  assert.equal(f.calls.length,1);
});

test('partial acceptance, missing acceptance and post-send connection loss never claim success or auto-retry',async()=>{
  for(const send of [async()=>({accepted:['a@example.test'],rejected:['b@example.test']}),async()=>({messageId:'unconfirmed'}),async()=>{throw Object.assign(new Error('private server response'),{code:'ETIMEDOUT'});}]) {
    const f=workerFixture(send);
    await f.service.processOne();
    assert.equal(f.row.status,'failed');
    assert.equal(f.row.ambiguous,true);
    assert.match(f.row.error_message,/避免重复发送/);
    assert.doesNotMatch(f.row.error_message,/private server response/);
    assert.equal(await f.service.processOne(),false);
    assert.equal(f.calls.length,1);
  }
});

test('definite rejection and preparation errors remain failures with no automatic retry',async()=>{
  for(const send of [async()=>({accepted:[],rejected:['a@example.test','b@example.test']}),async()=>{throw Object.assign(new Error('smtp-private'),{code:'EAUTH'});}]) {
    const f=workerFixture(send);
    await f.service.processOne();
    assert.equal(f.row.status,'failed');
    assert.equal(f.row.ambiguous,false);
    assert.equal(await f.service.processOne(),false);
  }
  const f=workerFixture(async()=>{throw new Error('must not send');},{buildMessage:async()=>{throw new Error('bad workbook');}});
  await f.service.processOne();
  assert.equal(f.calls.length,0);
  assert.equal(f.row.status,'failed');
  assert.equal(f.row.ambiguous,false);
});
