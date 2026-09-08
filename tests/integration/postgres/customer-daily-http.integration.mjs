import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool,closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {dailyPeriod} from '../../../server/services/customer-daily-report-data.js';
import {buildCustomerDailyMetricEvidence} from '../../../server/services/customer-daily-metric-evidence.js';
const require = createRequire(new URL('../../../server/package.json',import.meta.url));
const ExcelJS = require('exceljs');

test('customer daily HTTP uses real first-ingest/observation/audit SQL, immutable versions, Excel and tenant RBAC', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();
  const pool = getPool();
  const tenantIds=[], userIds=[];
  const originalFetch=globalThis.fetch;
  let server;
  t.after(async()=>{
    globalThis.fetch=originalFetch;
    if(server) await new Promise(resolve=>server.close(resolve));
    if(userIds.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[userIds]);
    if(tenantIds.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenantIds]);
    await closePool();
  });
  const tenantA=(await pool.query("INSERT INTO tenants(name) VALUES($1) RETURNING id",[`日报测试 ${randomUUID()}`])).rows[0].id;
  const tenantB=(await pool.query("INSERT INTO tenants(name) VALUES($1) RETURNING id",[`隔离客户 ${randomUUID()}`])).rows[0].id;
  tenantIds.push(tenantA,tenantB);
  const period=dailyPeriod();
  const at=(offset)=>new Date(new Date(period.periodStart).getTime()+offset*3600000).toISOString();
  const oldAt=new Date(new Date(period.monthStart).getTime()-86400000).toISOString();
  async function record({tenantId=tenantA,title='测试原帖',created=at(1),published=at(-48),sentiment='negative',triage='unhandled',businessVisibility='eligible',type='single_note'}={}) {
    const id=randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result)
      VALUES($1,$2,'douyin',$3,$4,$5,$6,$7,$8,$8,$9,$10,'{"relevance":"irrelevant"}')`,[id,tenantId,String(Math.floor(Math.random()*1e15)),title,`https://www.douyin.com/video/${String(Math.floor(Math.random()*1e15))}`,type,sentiment,created,published,businessVisibility]);
    if(triage !== 'unhandled') await pool.query('INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)',[tenantId,id,triage]);
    return id;
  }
  const hot=await record({title:'真正高热负面',created:at(-50)});
  const cold=await record({title:'低于门槛的当日冷处理',triage:'negative_cold'});
  const positive=await record({title:'AI无关但仍属SDB的新帖',sentiment:'positive',businessVisibility:'filtered_out'});
  await record({sentiment:'neutral',triage:'reviewed_non_monitor'});
  const historicalCold=await record({title:'旧帖今天新标冷处理',created:oldAt,published:oldAt,triage:'negative_cold'});
  await record({tenantId:tenantB,title:'绝不能混入的客户B帖子'});
  await record({type:'blogger_profile'});
  await record({type:'official_content'});
  await record({created:period.cutoffAt}); // midnight belongs to the next date
  async function observe(recordId,heat,when) {
    const raw={likes:heat,comments_count:0,collects:0,shares:0,capture_timestamp:when};
    const evidence=buildCustomerDailyMetricEvidence(raw,{preserved:false},new Date(when));
    await pool.query('INSERT INTO record_observations(tenant_id,record_id,captured_at,likes,comments_count,collects,shares,payload) VALUES($1,$2,$3,$4,0,0,0,$5::jsonb)',[tenantA,recordId,when,heat,JSON.stringify({customerDailyMetricEvidence:evidence})]);
  }
  await observe(hot,400,at(-20));
  await observe(hot,320,at(3));
  await observe(hot,900,period.cutoffAt); // must not leak into yesterday's heat
  await observe(cold,85,at(3));
  for(const [recordId,previousStatus] of [[cold,'unhandled'],[historicalCold,'unhandled'],[historicalCold,'negative_cold']]) await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
    VALUES($1,'system','daily-test','record.triage_updated','record',$2,$3::jsonb,$4)`,[tenantA,recordId,JSON.stringify({previousStatus,nextStatus:'negative_cold'}),at(4)]);

  async function user(role) {
    const email=`daily-${randomUUID()}@integration.invalid`;
    const id=(await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'日报测试',$2,'active',false,'',false) RETURNING id",[email,hashPassword('daily-test-password')])).rows[0].id;
    userIds.push(id);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'active')",[id,tenantA,role]);
    return {id,email};
  }
  const writer=await user('tenant_analyst');
  const viewer=await user('tenant_viewer');
  const app=createApp({logger:{log(){},error(){}}});
  server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  const base=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(input,options)=>{
    assert.equal(new URL(input).origin,base,'no real Feishu or other external request is allowed');
    return originalFetch(input,options);
  };
  async function login(person) {
    const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:person.email,password:'daily-test-password'})});
    assert.equal(response.status,200);
    return (await response.json()).token;
  }
  const token=await login(writer), viewerToken=await login(viewer);
  async function request(path,{method='GET',body,tenantId=tenantA,auth=token}={}) {
    return fetch(`${base}/api/customer-daily-reports${path}`,{method,headers:{authorization:`Bearer ${auth}`,'x-tenant-id':tenantId,'content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
  }
  const key=randomUUID();
  const response=await request('/generate',{method:'POST',body:{date:period.reportDate,requestId:key}});
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  const generated=result.report;
  assert.equal(generated.reportDate,period.reportDate);
  assert.equal(generated.snapshot.summary.day.monitor,3);
  assert.equal(generated.snapshot.summary.day.sdb,2);
  assert.equal(generated.snapshot.summary.day.positive,1);
  assert.equal(generated.snapshot.summary.day.cold,1);
  assert.equal(generated.snapshot.summary.day.inProgress,null);
  assert.equal(generated.snapshot.summary.mtd.processed,null);
  assert.deepEqual(generated.snapshot.highHeat.map(row=>row.recordId),[hot]);
  assert.equal(generated.snapshot.highHeat[0].heat,320);
  assert.match(generated.snapshot.highHeat[0].comparisonText,/20/);
  assert.deepEqual(new Set(generated.snapshot.coldMarked.map(row=>row.recordId)),new Set([cold,historicalCold]));
  const duplicate=await (await request('/generate',{method:'POST',body:{date:period.reportDate,requestId:key}})).json();
  assert.equal(duplicate.report.id,generated.id);
  await pool.query("UPDATE records SET sentiment='neutral' WHERE id=$1",[positive]);
  const detail=await (await request(`/${generated.id}`)).json();
  assert.equal(detail.report.snapshot.summary.day.positive,1,'saved snapshot is immutable');
  assert.match(detail.text,/https:\/\/www.douyin.com/);
  assert.ok(!detail.html.includes('绝不能混入的客户B帖子'));
  const newer=await (await request('/generate',{method:'POST',body:{date:period.reportDate,requestId:randomUUID()}})).json();
  assert.equal(newer.report.version,2);
  assert.equal(newer.report.snapshot.summary.day.positive,0);
  const excel=await request(`/${generated.id}/excel`);
  assert.equal(excel.status,200);
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await excel.arrayBuffer()));
  assert.equal(workbook.worksheets.length,3);
  const sheet=workbook.worksheets[0];
  const dayRow=sheet.getRows(1,sheet.rowCount).find(row=>row.getCell(2).value===3 && row.getCell(3).value===2);
  assert.ok(dayRow);
  assert.equal(dayRow.getCell(7).value,null);
  assert.equal(dayRow.getCell(8).value,null);
  assert.equal((await request(`/${generated.id}`,{tenantId:tenantB})).status,403);
  assert.equal((await request('/generate',{method:'POST',auth:viewerToken,body:{date:period.reportDate}})).status,403);
  assert.equal((await request(`/${generated.id}/send`,{method:'POST',auth:viewerToken})).status,403);
  assert.equal((await request('/settings',{method:'PUT',body:{chatId:'oc_unauthorized'}})).status,403);
  assert.equal((await request(`/${generated.id}`,{auth:viewerToken})).status,200);
  assert.equal((await request('/generate',{method:'POST',body:{date:'2026-02-30'}})).status,400);
  const config=await (await request('/settings')).json();
  assert.equal(config.settings.autoEnabled,false);
  assert.equal('appSecret' in config.settings,false);
  assert.equal((await request(`/${generated.id}/send`,{method:'POST'})).status,400,'missing configuration never attempts network');
});
