import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createCustomerDailyEmailService} from '../../../server/services/customer-daily-email.js';

const {Pool}=createRequire(new URL('../../../server/package.json',import.meta.url))('pg');

function database(pool) {
  const api=connection=>({
    queryAll:async(sql,params=[])=>(await connection.query(sql,params)).rows,
    queryOne:async(sql,params=[])=>(await connection.query(sql,params)).rows[0] || null,
    execute:async(sql,params=[])=>connection.query(sql,params),
  });
  return {...api(pool),withTransaction:async callback=>{
    const client=await pool.connect();
    try {await client.query('BEGIN');const result=await callback(api(client));await client.query('COMMIT');return result;}
    catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }};
}

test('daily email PostgreSQL queue freezes reports and recipients, deduplicates workers and isolates tenants',async t=>{
  const target=validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const schema=`daily_email_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:target.rawUrl,max:1});
  let pool,created=false;
  t.after(async()=>{if(pool) await pool.end();if(created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
  assert.match((await admin.query('SELECT current_database() AS name')).rows[0].name,/^onstarvoice_(?:ci|test)(?:_|$)/);
  await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new Pool({connectionString:target.rawUrl,max:8,options:`-c search_path=${schema},public`});
  await pool.query('CREATE TABLE tenants(id UUID PRIMARY KEY)');
  for(const migration of ['081_customer_daily_reports','083_customer_daily_email_deliveries']) {
    await pool.query(await readFile(new URL(`../../../server/db/migrations/${migration}.sql`,import.meta.url),'utf8'));
  }
  await pool.query("CREATE TABLE audit_logs (tenant_id UUID,actor_type TEXT,actor_id TEXT,action TEXT,target_type TEXT,target_id TEXT,metadata JSONB)");
  const db=database(pool);

  async function fixture(subtest,{ready=true,sendResult}={}) {
    const tenantId=randomUUID(),reportId=randomUUID(),calls=[];
    await db.execute('INSERT INTO tenants(id) VALUES($1)',[tenantId]);
    subtest.after(()=>db.execute('DELETE FROM tenants WHERE id=$1',[tenantId]));
    const snapshot={id:reportId,version:1,tenantId,tenantName:'冻结客户',reportDate:'2026-09-09',summary:{day:{monitor:11}},warnings:[{blocking:true,message:'待处理'}]};
    await db.execute('INSERT INTO customer_daily_report_settings(tenant_id,config) VALUES($1,$2::jsonb)',[tenantId,JSON.stringify({emailRecipients:'a@example.test, b@example.test'})]);
    await db.execute("INSERT INTO customer_daily_reports(id,tenant_id,report_date,mode,version,request_key,snapshot) VALUES($1,$2,'2026-09-09','formal',1,$3,$4::jsonb)",[reportId,tenantId,randomUUID(),JSON.stringify(snapshot)]);
    let handler=sendResult || (async()=>({accepted:['a@example.test','b@example.test'],rejected:[],messageId:'smtp-accepted'}));
    const options={db,readiness:async id=>{assert.equal(id,tenantId);return {ready};},
      buildMessage:async saved=>({html:JSON.stringify(saved),text:saved.tenantName,attachments:[]}),
      send:async message=>{calls.push(message);return handler(message);}};
    return {tenantId,reportId,snapshot,calls,service:createCustomerDailyEmailService(options),restart:()=>createCustomerDailyEmailService(options),
      raw:()=>db.queryOne('SELECT * FROM customer_daily_email_deliveries WHERE tenant_id=$1 AND report_id=$2',[tenantId,reportId]),
      sendResult:next=>{handler=next;}};
  }

  await t.test('parallel enqueue and workers perform one SMTP call using the originally saved snapshot and recipient list',async subtest=>{
    const f=await fixture(subtest);
    const requests=await Promise.all(Array.from({length:5},()=>f.service.enqueue(f.tenantId,f.reportId)));
    assert.ok(requests.every(result=>result.status==='queued'));
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_email_deliveries WHERE tenant_id=$1',[f.tenantId])).count,1);
    const row=await f.raw();
    assert.deepEqual(row.snapshot,f.snapshot);
    await db.execute('UPDATE customer_daily_report_settings SET config=$2::jsonb WHERE tenant_id=$1',[f.tenantId,JSON.stringify({emailRecipients:'changed@example.test'})]);
    await db.execute("UPDATE customer_daily_reports SET snapshot=jsonb_set(snapshot,'{tenantName}','\"changed after enqueue\"') WHERE tenant_id=$1 AND id=$2",[f.tenantId,f.reportId]);
    const workers=await Promise.all([f.service.processOne(),f.restart().processOne()]);
    assert.equal(workers.filter(Boolean).length,1);
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].tenantId,f.tenantId);
    assert.equal(f.calls[0].to,'a@example.test, b@example.test');
    assert.equal(JSON.parse(f.calls[0].html).tenantName,'冻结客户');
    assert.equal((await f.service.delivery(f.tenantId,f.reportId)).status,'sent');
    assert.equal((await f.service.enqueue(f.tenantId,f.reportId)).status,'sent');
    assert.equal(await f.restart().processOne(),false);
    assert.equal(f.calls.length,1);
  });

  await t.test('explicit resends rotate identity once, retain receipts and reject stale replay after completion',async subtest=>{
    const f=await fixture(subtest);
    await f.service.enqueue(f.tenantId,f.reportId);await f.service.processOne();
    const first=await f.service.delivery(f.tenantId,f.reportId);
    assert.ok(first.sendId);
    await db.execute('UPDATE customer_daily_report_settings SET config=$2::jsonb WHERE tenant_id=$1',[f.tenantId,JSON.stringify({emailRecipients:'changed@example.test'})]);
    await Promise.all(Array.from({length:5},()=>f.service.enqueue(f.tenantId,f.reportId,{resendOf:first.sendId,actorId:'tester'})));
    await Promise.all([f.service.processOne(),f.restart().processOne()]);
    assert.equal(f.calls.length,2);
    assert.notEqual(f.calls[0].messageId,f.calls[1].messageId);
    assert.equal(f.calls[1].to,f.calls[0].to);
    await f.service.enqueue(f.tenantId,f.reportId,{resendOf:first.sendId});
    assert.equal(await f.service.processOne(),false);
    const second=await f.service.delivery(f.tenantId,f.reportId);
    assert.notEqual(second.sendId,first.sendId);
    await f.service.enqueue(f.tenantId,f.reportId,{resendOf:second.sendId});await f.service.processOne();
    assert.equal(f.calls.length,3);
    const history=await db.queryAll('SELECT metadata FROM audit_logs WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(history.length,2);assert.equal(history[0].metadata.previousDeliveryId,first.sendId);
    assert.equal(history[0].metadata.messageId,'smtp-accepted');
    await assert.rejects(f.service.enqueue(f.tenantId,f.reportId,{resendOf:'bad'}),{code:'daily_resend_invalid'});
  });

  await t.test('tenant boundaries hold for enqueue, reads and the composite foreign key',async subtest=>{
    const a=await fixture(subtest),b=await fixture(subtest);
    await a.service.enqueue(a.tenantId,a.reportId);
    await assert.rejects(b.service.enqueue(b.tenantId,a.reportId),{status:404});
    assert.equal((await b.service.delivery(b.tenantId,a.reportId)).status,'none');
    assert.equal((await b.service.deliveries(b.tenantId,[a.reportId])).size,0);
    await assert.rejects(db.execute("INSERT INTO customer_daily_email_deliveries(id,tenant_id,report_id,recipients,subject,snapshot) VALUES($1,$2,$3,'x@example.test','test','{}')",[randomUUID(),b.tenantId,a.reportId]),{code:'23503'});
    assert.equal(a.calls.length+b.calls.length,0);
  });

  await t.test('a definite failure can only retry explicitly and preserves its frozen destination',async subtest=>{
    const f=await fixture(subtest,{sendResult:async()=>{throw Object.assign(new Error('private auth detail'),{code:'EAUTH'});}});
    await f.service.enqueue(f.tenantId,f.reportId);
    await f.service.processOne();
    const failed=await f.service.delivery(f.tenantId,f.reportId);
    assert.equal(failed.status,'failed');assert.equal(failed.canRetry,true);assert.equal(failed.ambiguous,false);
    assert.equal(await f.restart().processOne(),false);
    f.sendResult(async()=>({accepted:['a@example.test','b@example.test'],rejected:[],messageId:'retried'}));
    await db.execute('UPDATE customer_daily_report_settings SET config=$2::jsonb WHERE tenant_id=$1',[f.tenantId,JSON.stringify({emailRecipients:'new@example.test'})]);
    await f.restart().enqueue(f.tenantId,f.reportId);
    await f.restart().processOne();
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].to,'a@example.test, b@example.test');
    assert.equal((await f.raw()).attempts,2);assert.equal((await f.raw()).status,'sent');
  });

  await t.test('partial delivery and interrupted leases remain ambiguous and cannot be resent by repeated clicks or restarts',async subtest=>{
    for(const phase of ['partial','expired']) {
      const f=await fixture(subtest,{sendResult:async()=>({accepted:['a@example.test'],rejected:['b@example.test']})});
      await f.service.enqueue(f.tenantId,f.reportId);
      if(phase==='partial') await f.service.processOne();
      else await db.execute("UPDATE customer_daily_email_deliveries SET status='working',claim_token=$3,claimed_at=now()-interval '11 minutes' WHERE tenant_id=$1 AND report_id=$2",[f.tenantId,f.reportId,randomUUID()]);
      await f.restart().recoverStale();
      const state=await f.service.delivery(f.tenantId,f.reportId);
      assert.equal(state.status,'failed');assert.equal(state.ambiguous,true);assert.equal(state.canRetry,false);
      await f.restart().enqueue(f.tenantId,f.reportId);
      assert.equal(await f.restart().processOne(),false);
      assert.equal(f.calls.length,phase==='partial' ? 1 : 0);
    }
  });

  await t.test('missing SMTP or daily recipients never creates an actionable delivery',async subtest=>{
    const f=await fixture(subtest,{ready:false});
    assert.equal((await f.service.configuration(f.tenantId)).emailReady,false);
    await assert.rejects(f.service.enqueue(f.tenantId,f.reportId),{code:'daily_email_not_configured'});
    assert.equal(await f.raw(),null);
    const missing=await fixture(subtest);
    await db.execute("UPDATE customer_daily_report_settings SET config='{}' WHERE tenant_id=$1",[missing.tenantId]);
    assert.equal((await missing.service.configuration(missing.tenantId)).emailReady,false);
    await assert.rejects(missing.service.enqueue(missing.tenantId,missing.reportId),{code:'daily_email_recipients_missing'});
    assert.equal(await missing.raw(),null);
    assert.equal(f.calls.length+missing.calls.length,0);
  });
});
