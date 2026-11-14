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
