import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool,closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {customerDailyBusinessPeriod} from '../../../server/services/customer-daily-business-period.js';
import {previousWorkingDate} from '../../../server/services/china-work-calendar.js';
import {buildCustomerDailyMetricEvidence} from '../../../server/services/customer-daily-metric-evidence.js';
import {collectCustomerDailyReport} from '../../../server/services/customer-daily-report-data.js';
import {normalizeRecord} from '../../../server/routes/sync.js';
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
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const period=customerDailyBusinessPeriod(previousWorkingDate(today));
  const at=(offset)=>new Date(new Date(period.periodStart).getTime()+offset*3600000).toISOString();
  const oldAt=new Date(new Date(period.monthStart).getTime()-86400000).toISOString();
  async function record({tenantId=tenantA,title='测试原帖',created=at(1),published=at(-48),sentiment='negative',triage='unhandled',businessVisibility='eligible',type='single_note',relevance='relevant'}={}) {
    const id=randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result)
      VALUES($1,$2,'douyin',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11::jsonb)`,[id,tenantId,String(Math.floor(Math.random()*1e15)),title,`https://www.douyin.com/video/${String(Math.floor(Math.random()*1e15))}`,type,sentiment,created,published,businessVisibility,JSON.stringify({relevance})]);
    if(triage !== 'unhandled') await pool.query('INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)',[tenantId,id,triage]);
    return id;
  }
  const hot=await record({title:'真正高热负面',created:new Date(new Date(period.collectionStartAt).getTime()-3600000).toISOString()});
  const cold=await record({title:'低于门槛的当日冷处理',triage:'negative_cold'});
  const positive=await record({title:'进入客户清单的正向新帖',sentiment:'positive'});
  await record({title:'系统过滤不计客户监控',businessVisibility:'filtered_out'});
  await record({title:'无关内容不计客户监控',relevance:'irrelevant'});
  await record({sentiment:'neutral',triage:'reviewed_non_monitor'});
  const historicalCold=await record({title:'旧帖今天新标冷处理',created:oldAt,published:oldAt,triage:'negative_cold'});
  await record({tenantId:tenantB,title:'绝不能混入的客户B帖子'});
  await record({type:'blogger_profile'});
  await record({type:'official_content'});
  await record({created:period.collectionEndAt}); // the evening boundary belongs to the next working date
  async function observe(recordId,heat,when,{historicalMilliseconds=false,rawPayload={}}={}) {
    const raw={likes:heat,comments_count:0,collects:0,shares:0,capture_timestamp:when};
    const evidence=buildCustomerDailyMetricEvidence(raw,{preserved:false},new Date(when));
    // Match the persisted shape before numeric capture timestamps were accepted.
    // SQL projection must retain observedAt:null for safe historical recovery.
    if(historicalMilliseconds) Object.assign(evidence,{observedAt:null,timeSource:'ingested_at'});
    const payload={customerDailyMetricEvidence:evidence,...(historicalMilliseconds ? {captureTimestamp:String(Date.parse(when))} : {}),...rawPayload};
    await pool.query('INSERT INTO record_observations(tenant_id,record_id,captured_at,likes,comments_count,collects,shares,payload) VALUES($1,$2,$3,$4,0,0,0,$5::jsonb)',[tenantA,recordId,when,heat,JSON.stringify(payload)]);
  }
  await observe(hot,400,at(-20),{historicalMilliseconds:true});
  await observe(hot,320,at(3),{historicalMilliseconds:true});
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
  assert.equal(generated.snapshot.highHeat[0].comparisonText,'↓20%');
  assert.equal(generated.snapshot.highHeat[0].previousHeat,400);
  assert.deepEqual(new Set(generated.snapshot.coldMarked.map(row=>row.recordId)),new Set([cold,historicalCold]));
  assert.equal(generated.snapshot.coldMarked.find(row=>row.recordId===cold).isHistorical,false);
  assert.equal(generated.snapshot.coldMarked.find(row=>row.recordId===historicalCold).isHistorical,true);
  const duplicate=await (await request('/generate',{method:'POST',body:{date:period.reportDate,requestId:key}})).json();
  assert.equal(duplicate.report.id,generated.id);
  await pool.query("UPDATE records SET sentiment='neutral' WHERE id=$1",[positive]);
  const detail=await (await request(`/${generated.id}`)).json();
  assert.equal(detail.report.snapshot.summary.day.positive,1,'saved snapshot is immutable');
  assert.match(detail.text,/https:\/\/www.douyin.com/);
  assert.ok(!detail.html.includes('绝不能混入的客户B帖子'));
  assert.match(detail.messageHtml,/二、7天内热度值≥200的负面帖子/);
  assert.match(detail.messageText,/三、本期冷处理负面帖：2 条（含历史帖 1 条）/);
  assert.match(detail.html,/一、监控汇总（本期新增）/);
  assert.ok(!detail.messageHtml.includes('<table'));
  assert.ok(!detail.messageText.includes('MTD'));
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
  assert.equal(dayRow.getCell(7).value,0);
  assert.equal(dayRow.getCell(8).value,0);
  assert.equal(dayRow.getCell(9).value,0);
  const monthResponse = await request(`/calendar-month?month=${period.reportDate.slice(0,7)}`);
  assert.equal(monthResponse.status,200);
  const monthCalendar = (await monthResponse.json()).calendar;
  assert.equal(monthCalendar.days.find(day=>day.date===period.reportDate).latestReportId,newer.report.id);
  assert.equal((await request('/calendar-month?month=2026-99')).status,400);
  assert.equal((await request('/calendar-month?month=2027-01')).status,503);
  assert.equal((await request('/calendar-month?month=2026-09',{tenantId:tenantB})).status,403);
  assert.equal((await request(`/${generated.id}`,{tenantId:tenantB})).status,403);
  assert.equal((await request('/generate',{method:'POST',auth:viewerToken,body:{date:period.reportDate}})).status,403);
  assert.equal((await request(`/${generated.id}/send`,{method:'POST',auth:viewerToken})).status,403);
  assert.equal((await request(`/${generated.id}/email`,{method:'POST',auth:viewerToken})).status,403);
  assert.equal((await request(`/${generated.id}/email`,{method:'POST',tenantId:tenantB})).status,403);
  assert.equal((await request('/settings',{method:'PUT',body:{chatId:'oc_unauthorized'}})).status,403);
  assert.equal((await request(`/${generated.id}`,{auth:viewerToken})).status,200);
  assert.equal((await request('/generate',{method:'POST',body:{date:'2026-02-30'}})).status,400);
  const config=await (await request('/settings')).json();
  assert.equal(config.settings.autoEnabled,false);
  assert.equal('appSecret' in config.settings,false);
  assert.equal((await request(`/${generated.id}/send`,{method:'POST'})).status,400,'missing configuration never attempts network');
  assert.equal((await request(`/${generated.id}/email`,{method:'POST'})).status,409,'missing email configuration never queues mail');

  // A customer may already have changed the original working document: summary saves must leave it alone.
  await pool.query(`INSERT INTO customer_daily_documents (report_id,tenant_id,config,status,phase,document_id,document_url,progress)
    VALUES($1,$2,'{}','ready','ready','existing_customer_doc','https://example.feishu.cn/docx/existing_customer_doc','{"body":{"customerText":"客户已填写"}}')`,[generated.id,tenantA]);
  await pool.query(`INSERT INTO customer_daily_deliveries (id,tenant_id,report_id,target_key,config,status,message_id,sent_at)
    VALUES($1,$2,$3,'existing-group','{}','sent','existing_message',now())`,[randomUUID(),tenantA,generated.id]);
  const editKey=randomUUID();
  const edit={summary:{rows:{[period.reportDate]:{cold:0,comment:1,negativeProcess:0}}},requestId:editKey};
  const stale=await request(`/${generated.id}/summary`,{method:'POST',body:edit});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).error,'daily_summary_stale');
  const source=newer.report;
  await pool.query("UPDATE records SET sentiment='positive' WHERE id=$1",[positive]);
  const concurrent=await Promise.all([request(`/${source.id}/summary`,{method:'POST',body:edit}),request(`/${source.id}/summary`,{method:'POST',body:edit})]);
  const savedResponses=await Promise.all(concurrent.map(async response=>({status:response.status,body:await response.json()})));
  assert.ok(savedResponses.every(result=>result.status===200),JSON.stringify(savedResponses));
  const edited=savedResponses[0].body.report;
  assert.equal(savedResponses[1].body.report.id,edited.id,'one version per repeated request, including concurrent submissions');
  assert.equal(edited.version,3);
  assert.notEqual(edited.id,generated.id);
  assert.equal(edited.reportDate,generated.reportDate);
  assert.equal(edited.mode,generated.mode);
  assert.equal(edited.snapshot.assessedAt,source.snapshot.assessedAt,'editing counts is not a new data assessment');
  assert.deepEqual(edited.snapshot.systemSummary,source.snapshot.summary);
  assert.equal(edited.snapshot.summaryEdited,true);
  assert.equal(edited.snapshot.summaryEdit.sourceReportId,source.id);
  assert.equal(edited.snapshot.summaryEdit.actorId,writer.id);
  assert.equal(edited.snapshot.summary.day.comment,1);
  assert.equal(edited.snapshot.summary.day.negativeProcess,0);
  assert.equal(edited.snapshot.summary.day.negative,generated.snapshot.summary.day.negative);
  assert.equal(edited.snapshot.summary.day.positive,0,'editing an immutable source must not recollect later record corrections');
  assert.deepEqual(edited.snapshot.highHeat,generated.snapshot.highHeat);
  assert.deepEqual(edited.snapshot.coldMarked,generated.snapshot.coldMarked);
  assert.deepEqual((await (await request(`/${generated.id}`)).json()).report.snapshot.summary,generated.snapshot.summary);
  const originalDoc=(await pool.query('SELECT status,document_id,progress FROM customer_daily_documents WHERE report_id=$1',[generated.id])).rows[0];
  assert.equal(originalDoc.status,'ready');
  assert.equal(originalDoc.progress.body.customerText,'客户已填写');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM customer_daily_documents WHERE tenant_id=$1',[tenantA])).rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM customer_daily_deliveries WHERE tenant_id=$1',[tenantA])).rows[0].count,1,'summary saves do not enqueue messages');
  const conflict=await request(`/${source.id}/summary`,{method:'POST',body:{...edit,summary:{rows:{[period.reportDate]:{comment:0}}}}});
  assert.equal(conflict.status,409);
  assert.equal((await conflict.json()).error,'daily_summary_request_conflict');
  const distinctEdits=[
    {summary:{rows:{[period.reportDate]:{comment:0,negativeProcess:1}}},requestId:randomUUID()},
    {summary:{rows:{[period.reportDate]:{comment:0,negativeProcess:0}}},requestId:randomUUID()},
  ];
  const competing=await Promise.all(distinctEdits.map(body=>request(`/${edited.id}/summary`,{method:'POST',body})));
  const competingResults=await Promise.all(competing.map(async response=>({status:response.status,body:await response.json()})));
  assert.deepEqual(competingResults.map(result=>result.status).sort(),[200,409],JSON.stringify(competingResults));
  assert.equal(competingResults.find(result=>result.status===409).body.error,'daily_summary_stale');
  const revised=competingResults.find(result=>result.status===200).body.report;
  assert.equal(revised.version,4);
  assert.deepEqual(revised.snapshot.systemSummary,source.snapshot.summary,'the first system result survives repeated customer edits');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM customer_daily_reports WHERE tenant_id=$1',[tenantA])).rows[0].count,4,'the stale competing edit must not create another version');
  const originalReplay=await (await request(`/${source.id}/summary`,{method:'POST',body:edit})).json();
  assert.equal(originalReplay.report.id,edited.id,'a successful request still replays after newer edits exist');
  assert.equal((await request(`/${generated.id}/summary`,{method:'POST',auth:viewerToken,body:edit})).status,403);
  assert.equal((await request(`/${generated.id}/summary`,{method:'POST',tenantId:tenantB,body:edit})).status,403);
  assert.equal((await request(`/${randomUUID()}/summary`,{method:'POST',body:edit})).status,404);
  assert.equal((await request(`/${generated.id}/summary`,{method:'POST',body:{summary:{rows:{[period.reportDate]:{negativeProcess:-1}}},requestId:randomUUID()}})).status,400);
  assert.equal((await request(`/${generated.id}/summary`,{method:'POST',body:{summary:{rows:{[period.reportDate]:{sdb:4}}},requestId:randomUUID()}})).status,400);
  const png=await request(`/${edited.id}/summary.png`,{auth:viewerToken});
  assert.equal(png.status,200);
  assert.match(png.headers.get('content-type'),/^image\/png/);
  assert.equal(png.headers.get('cache-control'),'no-store');
  assert.ok(png.headers.get('content-disposition').includes(encodeURIComponent(`客户日报_${generated.reportDate}_汇总.png`)));
  assert.deepEqual(Buffer.from(await png.arrayBuffer()).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal((await request(`/${generated.id}/summary.png`,{tenantId:tenantB})).status,403);
  assert.equal((await request(`/${randomUUID()}/summary.png`)).status,404);

  await t.test('real observation projection preserves normalization precedence and the original null timestamp stamp', async () => {
    const outer=Date.parse(at(1)), list=Date.parse(at(2)), nested=Date.parse(at(3));
    const nestedItem={captureTimestamp:list,detailPayload:{captureTimestamp:nested,notNeeded:'discard me'}};
    const cases=[
      [{captureTimestamp:outer,items:[nestedItem]},nested],
      [{captureTimestamp:outer,detailPayload:{},items:[nestedItem]},list],
      ...[null,false,0,''].map(detailPayload=>[{captureTimestamp:outer,detailPayload,items:[nestedItem]},nested]),
      [{captureTimestamp:outer,detailPayload:'truthy',items:[nestedItem]},list],
      [{captureTimestamp:outer,items:[null,'ignored',nestedItem]},nested],
      [{captureTimestamp:outer,detailPayload:{captureTimestamp:0},items:[nestedItem]},outer],
      [{captureTimestamp:outer,detailPayload:{captureTimestamp:'invalid'},items:[nestedItem]},null],
      [{captureTimestamp:null,capture_timestamp:nested},null],
      [{captureTimestamp:at(3)},null],
    ];
    const expected=new Map();
    for(const [payload,time] of cases) {
      const id=await record({title:'观测投影边界测试'});
      if(time!==null) assert.equal(normalizeRecord({payload})[0].capture_timestamp,String(time));
      await observe(id,300,at(4),{historicalMilliseconds:true,rawPayload:{...payload,notNeeded:'discard me'}});
      expected.set(id,time===null ? null : new Date(time).toISOString());
    }
    let projected=[];
    const db={
      async queryAll(sql,values) {
        const rows=(await pool.query(sql,values)).rows;
        if(sql.includes('customer_daily:observations')) projected=rows;
        return rows;
      },
      async queryOne(sql,values) {return (await pool.query(sql,values)).rows[0]||null;},
    };
    const actual=await collectCustomerDailyReport({tenantId:tenantA,date:period.reportDate,now:new Date(period.assessedAt),businessPeriod:period,db});
    for(const [id,time] of expected) {
      const evidence=actual.evidence.heat.selected.find(item=>item.recordId===id)?.selected;
      assert.ok(evidence,id);
      assert.equal(evidence.comparable,time!==null,id);
      if(time!==null) assert.equal(evidence.observedAt,time,id);
      const row=projected.find(item=>item.record_id===id);
      assert.equal(row.payload.customerDailyMetricEvidence.observedAt,null,'null server stamp survives JSON projection');
      assert.ok(!JSON.stringify(row.payload).includes('discard me'),'projection must not return unneeded source fields');
    }
  });
});
