import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool} from '../../../server/db/pool.js';
import {queryOne,queryAll,execute,setSettings} from '../../../server/db/init.js';
import {applyCreatorRoster,processFollowedCreatorBackfill} from '../../../server/services/followed-creator-roster.js';
import {checkFollowedCreatorAlert,processFollowedCreatorAlerts} from '../../../server/services/followed-creator-alerts.js';
import {sealDailySecret} from '../../../server/services/customer-daily-report-config.js';
import {enqueueDueProfilePatrolTasks} from '../../../server/services/profile-patrol-dispatch.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {withTransaction} from '../../../server/db/init.js';
import {projectProfilePatrolSchedule} from '../../../server/services/followed-creator-schedule.js';
import {upsertCapturedRecord} from '../../../server/services/record-store.js';

test('PostgreSQL roster, matching, alert outbox and scheduler isolation',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();
  const tenant=(await queryOne('INSERT INTO tenants(name) VALUES($1) RETURNING id',[randomUUID()])).id;
  const oldFetch=globalThis.fetch;
  const oldKey=process.env.CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY;
  process.env.CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY='ab'.repeat(32);
  t.after(async()=>{
    globalThis.fetch=oldFetch;
    if (oldKey===undefined) delete process.env.CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY;
    else process.env.CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY=oldKey;
    await execute('DELETE FROM tenants WHERE id=$1',[tenant]);
    await closePool();
  });
  const entries=['active','paused'].map(status=>({input:{platform:'douyin',
    creatorLabel:status,url:`https://www.douyin.com/user/Sec_${status}`,status}}));
  assert.deepEqual((await applyCreatorRoster(tenant,entries,false)).map(r=>r.action),['create','create']);
  assert.deepEqual((await applyCreatorRoster(tenant,entries,true)).map(r=>r.action),['create','create']);
  assert.deepEqual((await applyCreatorRoster(tenant,entries,true)).map(r=>r.action),['update','update']);
  const subs=await queryAll('SELECT * FROM monitor_subscriptions WHERE tenant_id=$1 ORDER BY status',[tenant]);
  assert.equal(subs.length,2);
  assert.ok(subs.every(s=>!s.auto_patrol_enabled));
  await execute('UPDATE monitor_subscriptions SET next_run_at=now()-interval \'1 day\' WHERE tenant_id=$1',[tenant]);
  assert.deepEqual((await enqueueDueProfilePatrolTasks()).filter(r=>subs.some(s=>s.id===r.subscriptionId)),[]);
  const captured=await upsertCapturedRecord({
    platform:'douyin',record_type:'blogger_notes',title:'Review',external_id:'1234567890123456789',
    author_id:'Sec_active',author_name:'Active',url:'https://www.douyin.com/video/1234567890123456789',
  },{tenantId:tenant});
  const recordId=captured.id;
  assert.equal((await queryOne('SELECT followed_creator_subscription_id FROM records WHERE id=$1',[recordId])).followed_creator_subscription_id,subs[0].id);
  await processFollowedCreatorBackfill();
  assert.equal((await queryAll('SELECT id FROM followed_creator_alerts WHERE tenant_id=$1',[tenant])).length,0);

  const webhookUrl='https://open.feishu.cn/open-apis/bot/v2/hook/TestOnlyFake123';
  const target={channel:'webhook',
    webhookUrlEncrypted:sealDailySecret(webhookUrl,tenant,'followedCreatorWebhookUrl',process.env),
    webhookSecretEncrypted:sealDailySecret('fake',tenant,'followedCreatorWebhookSecret',process.env)};
  await setSettings({followed_creator_alerts_enabled:'true',followed_creator_alert_target:JSON.stringify(target)},tenant);
  const args={tenantId:tenant,recordId};
  await execute("UPDATE records SET ai_result = '{\"relevance\":\"irrelevant\"}' WHERE id=$1",[recordId]);
  await checkFollowedCreatorAlert({...args,relevance:'irrelevant'});
  assert.equal((await queryAll('SELECT id FROM followed_creator_alerts WHERE tenant_id=$1',[tenant])).length,0);
  await execute("UPDATE records SET ai_result = '{\"relevance\":\"relevant\"}' WHERE id=$1",[recordId]);
  await Promise.all(Array.from({length:3},()=>checkFollowedCreatorAlert({...args,relevance:'relevant'})));
  let sent=0;
  globalThis.fetch=async url=>{
    assert.equal(url,webhookUrl);
    sent++;
    throw new Error('simulated timeout after send');
  };
  await Promise.all([processFollowedCreatorAlerts(),processFollowedCreatorAlerts()]);
  await processFollowedCreatorAlerts();
  const queued=await queryAll('SELECT status,attempts FROM followed_creator_alerts WHERE tenant_id=$1',[tenant]);
  assert.deepEqual(queued,[{status:'ambiguous',attempts:1}]);
  assert.equal(sent,1);
});

test('restoring a deleted subscription through the legacy HTTP route leaves auto patrol off',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();
  const tenant=(await queryOne('INSERT INTO tenants(name) VALUES($1) RETURNING id',[randomUUID()])).id;
  const email=`creator-${randomUUID()}@integration.invalid`;
  const password='creator-integration-example';
  const user=(await queryOne(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password)
    VALUES($1,'Creator integration',$2,'active',true,'platform_admin',false) RETURNING id`,[email, hashPassword(password)])).id;
  const server=await new Promise((resolve,reject)=>{
    const listener=createApp().listen(0,'127.0.0.1',()=>resolve(listener));
    listener.once('error',reject);
  });
  t.after(async()=>{
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await execute('DELETE FROM users WHERE id=$1',[user]);
    await execute('DELETE FROM tenants WHERE id=$1',[tenant]);
    await closePool();
  });
  const inserted=await queryOne(`INSERT INTO monitor_subscriptions(tenant_id,platform,keyword,name,account_url,status,auto_patrol_enabled,patrol_retry_count)
    VALUES($1,'douyin','restore_test','Restore test','https://www.douyin.com/user/restore_test','deleted',true,2) RETURNING id`, [tenant]);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(login.status,200);
  const restored=await fetch(base+'/monitor/subscriptions',{method:'POST',
    headers:{'content-type':'application/json','x-tenant-id':tenant,Cookie:login.headers.get('set-cookie').split(';')[0]},
    body:JSON.stringify({platform:'douyin',subjectType:'creator',keyword:'restore_test',accountUrl:'https://www.douyin.com/user/restore_test'})});
  assert.equal(restored.status,200);
  assert.equal((await restored.json()).data.restored,true);
  assert.deepEqual(await queryOne('SELECT status,auto_patrol_enabled,patrol_retry_count FROM monitor_subscriptions WHERE id=$1',[inserted.id]),
    {status:'active',auto_patrol_enabled:false,patrol_retry_count:0});

  // A due subscription without a usable node consumes the same bounded retry budget.
  await setSettings({monitor_runTimes:'00:00'},tenant);
  await execute("UPDATE monitor_subscriptions SET auto_patrol_enabled=true WHERE id=$1",[inserted.id]);
  for (const expected of [1,2]) {
    await execute("UPDATE monitor_subscriptions SET next_run_at=now()-interval '1 second' WHERE id=$1",[inserted.id]);
    const before=Date.now();
    const attempts=await enqueueDueProfilePatrolTasks();
    assert.equal(attempts.find(r=>r.subscriptionId===inserted.id)?.kind,'agent_unavailable');
    const step=await queryOne('SELECT patrol_retry_count,next_run_at FROM monitor_subscriptions WHERE id=$1',[inserted.id]);
    // Close to midnight, the next fixed slot correctly supersedes the retry.
    if (step.next_run_at.getTime() < before+30*60000) break;
    assert.equal(step.patrol_retry_count,expected);
    assert.ok(step.next_run_at.getTime()-before < 30*60000+10000);
  }
  await setSettings({monitor_runTimes:'10:00'},tenant);
  // The persistent counter must reset, not just the policy's projected value.
  await execute('UPDATE monitor_subscriptions SET auto_patrol_enabled=true,patrol_retry_count=2 WHERE id=$1',[inserted.id]);
  const execution=await queryOne(`INSERT INTO monitor_executions(tenant_id,subscription_id,status,finished_at)
    VALUES($1,$2,'succeeded','2026-11-14T02:43:00Z') RETURNING id`,[tenant,inserted.id]);
  await withTransaction(tx=>projectProfilePatrolSchedule(tx,tenant,[execution.id]));
  const row=await queryOne('SELECT patrol_retry_count,next_run_at FROM monitor_subscriptions WHERE id=$1',[inserted.id]);
  assert.equal(row.patrol_retry_count,0);
  assert.equal(row.next_run_at.toISOString(),'2026-11-15T02:00:00.000Z');
  await execute('UPDATE monitor_subscriptions SET patrol_retry_count=1 WHERE id=$1',[inserted.id]);
  await withTransaction(tx=>projectProfilePatrolSchedule(tx,tenant,[execution.id]));
  assert.equal((await queryOne('SELECT patrol_retry_count FROM monitor_subscriptions WHERE id=$1',[inserted.id])).patrol_retry_count,1);
});
