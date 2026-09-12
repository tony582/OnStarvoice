import assert from 'node:assert/strict';
import test from 'node:test';
import {createCustomerAssistantTools} from '../server/services/customer-assistant-tools.js';

const context = {tenantId:'tenant-a',chatId:'chat-a',senderId:'sender-a',requestId:'request-a'};
const now = () => new Date('2026-09-12T03:00:00Z');
const report = (id,version,delivery = {}) => ({id,version,reportDate:'2026-09-11',generatedAt:'2026-09-11T05:00:00Z',delivery,
  snapshot:{tenantId:'tenant-a',reportBasis:'customer_workday_v1',collectionStartAt:'2026-09-10T10:00:00Z',collectionEndAt:'2026-09-11T10:00:00Z',collectionCutoffAt:'2026-09-11T05:00:00Z',assessedAt:'2026-09-11T05:00:00Z',
    summary:{day:{monitor:10,sdb:9,negative:3,unclassified:1},mtd:{monitor:60,negative:12}},warnings:[{blocking:true,message:'internal tenant secret'}],secret:'not public'}});

function fixture(reports = []) {
  const calls = [];
  return {calls,tools:createCustomerAssistantTools({now,db:{},email:{enqueue:async()=>{throw new Error('unexpected email');}},dailyReports:{
    calendar:async(...args)=>{calls.push(['calendar',...args]);return {defaultReportDate:'2026-09-11',isWorkingDay:false,nextWorkingDate:'2026-09-14'};},
    list:async(...args)=>{calls.push(['list',...args]);return reports;},
    report:async(tenant,id)=>{calls.push(['report',tenant,id]);return reports.find(row=>row.id===id);},
    generate:async()=>{throw new Error('must never generate');},
  }})};
}

function reportingDb(queryOne) {
  return {
    queryOne:async()=>{throw new Error('negative queries must use the transaction client');},
    withTransaction:async(callback,options)=>{
      assert.deepEqual(options,{category:'reporting',readOnly:true,statementTimeoutMs:15000,lockTimeoutMs:1000,jitOff:true});
      return callback({queryOne});
    },
  };
}

test('missing report uses tenant workday calendar and never generates or sends',async()=>{
  const f=fixture();
  const result=await f.tools.executeTool('get_daily_report',{},context);
  assert.equal(result.status,'not_generated');assert.equal(result.reportDate,'2026-09-11');assert.equal(result.generated,false);
  assert.deepEqual(f.calls,[['calendar','tenant-a',undefined],['list','tenant-a','2026-09-11']]);
});

test('delivered document and summary retain one version when a newer draft exists',async()=>{
  const saved=report('sent',2,{status:'sent',documentUrl:'https://client.feishu.cn/docx/Document2'});
  const f=fixture([report('draft',3),saved,report('old',1,{status:'sent',documentUrl:'https://client.feishu.cn/docx/Document1'})]);
  const result=await f.tools.executeTool('get_daily_report',{date:'2026-09-11'},context);
  assert.equal(result.reportId,'sent');assert.equal(result.version,2);assert.equal(result.latestVersion,3);assert.equal(result.newerSnapshotAvailable,true);
  assert.equal(result.documentUrl,saved.delivery.documentUrl);assert.equal(result.summary.day.negative,3);assert.equal(result.scope.cutoffAt,'2026-09-11T05:00:00.000Z');
  assert.equal(result.incomplete,true);assert.doesNotMatch(JSON.stringify(result),/internal tenant secret|not public/);
});

test('ready document is reused; an unavailable or untrusted link falls back to a safe snapshot',async()=>{
  for(const [delivery,expected] of [[{status:'document_ready',documentUrl:'https://client.feishu.cn/docx/Document'},'feishu_document'],[{status:'sent',documentUrl:'https://attacker.test/docx/a'},'saved_snapshot'],[{status:'working',documentUrl:'https://client.feishu.cn/docx/Document'},'saved_snapshot']]) {
    const result=await fixture([report('one',1,delivery)]).tools.executeTool('get_daily_report',{},context);
    assert.equal(result.source,expected);if(expected==='saved_snapshot') assert.equal(result.documentUrl,null);
  }
});

test('a mismatched tenant report is rejected before exposing any summary',async()=>{
  const wrong=report('wrong',1);wrong.snapshot.tenantId='tenant-b';
  await assert.rejects(fixture([wrong]).tools.executeTool('get_daily_report',{},context),{code:'assistant_report_not_found'});
});

test('query uses one scoped statement and returns verified counts, cutoff and bounded safe details',async()=>{
  const calls=[];
  const db=reportingDb(async(sql,params)=>{calls.push([sql,params]);return {total:'8',monitored:'25',pending_analysis:'2',by_platform:[{platform:'douyin',negative:'8',pending_analysis:'2'}],details:[{id:'post-a',title:'line\n'.repeat(100),platform:'douyin',url:'javascript:alert(1)',created_at:'2026-09-11T16:30:00Z'}]};});
  const tools=createCustomerAssistantTools({db,now});
  const result=await tools.executeTool('query_negative',{platform:'douyin',limit:1},context);
  assert.equal(result.total,8);assert.equal(result.pendingAnalysis,2);assert.equal(result.details[0].url,null);assert.ok(result.details[0].title.length<=300);
  assert.equal(result.dateFrom,'2026-09-12');assert.equal(result.cutoffAt,'2026-09-12T03:00:00.000Z');assert.equal(calls.length,1);
  assert.deepEqual(calls[0][1],['tenant-a','2026-09-11T16:00:00.000Z','2026-09-12T03:00:00.000Z','douyin',1]);
  const sql=calls[0][0];
  for(const pattern of [/r.tenant_id=\$1/,/rt.tenant_id=r.tenant_id/,/w.tenant_id=r.tenant_id/,/business_visibility='eligible'/,/reviewed_non_monitor/,/IS DISTINCT FROM 'irrelevant' OR EXISTS/,/record_type NOT IN/,/LIMIT \$5/,/scoped AS MATERIALIZED/]) assert.match(sql,pattern);
  assert.doesNotMatch(sql,/tenant-a/);
});

test('historical natural-day range ends exclusively at midnight and accepts at most 31 inclusive days',async()=>{
  const calls=[];const tools=createCustomerAssistantTools({now,db:reportingDb(async(sql,params)=>{calls.push(params);return {};})});
  const result=await tools.executeTool('query_negative',{dateFrom:'2026-08-01',dateTo:'2026-08-31'},context);
  assert.equal(result.total,0);assert.equal(result.cutoffAt,'2026-08-31T16:00:00.000Z');
  await assert.rejects(tools.executeTool('query_negative',{dateFrom:'2026-08-01',dateTo:'2026-09-01'},context),{code:'assistant_range_invalid'});
  assert.equal(calls.length,1);
});

test('negative details preserve a safe saved source URL including its token before using the canonical fallback',async()=>{
  const saved='https://www.xiaohongshu.com/explore/post1?xsec_token=saved-test-token&xsec_source=pc_search';
  const canonical='https://www.xiaohongshu.com/explore/post1';
  const tools=createCustomerAssistantTools({now,db:reportingDb(async()=>({details:[
    {id:'one',url:saved,canonical_url:canonical},
    {id:'two',url:'javascript:alert(1)',canonical_url:canonical},
    {id:'three',url:'https://user:pass@example.test/post',canonical_url:'javascript:bad'},
  ]}))});
  const result=await tools.executeTool('query_negative',{},context);
  assert.equal(result.details[0].url,saved);assert.equal(result.details[1].url,canonical);assert.equal(result.details[2].url,null);
});

test('invalid dates, limits, injection fields and future ranges fail without touching the database',async()=>{
  const mustNotQuery=async()=>{throw new Error('must not query');};
  const tools=createCustomerAssistantTools({now,db:{queryOne:mustNotQuery,withTransaction:mustNotQuery}});
  for(const args of [{dateFrom:'2026-02-30'},{dateFrom:'2026-09-13'},{dateFrom:'2026-09-12',dateTo:'2026-09-11'},{platform:"douyin' OR true--"},{limit:0},{limit:21},{limit:1.5},{limit:'5'},{tenantId:'tenant-b'}]) {
    await assert.rejects(tools.executeTool('query_negative',args,context),error=>error.code.startsWith('assistant_'));
  }
  await assert.rejects(tools.executeTool('get_daily_report',{date:'2026-09-31'},context),{code:'assistant_date_invalid'});
  await assert.rejects(tools.executeTool('query_negative',{},{}),{code:'assistant_context_invalid'});
  await assert.rejects(tools.executeTool('run_sql',{sql:'DELETE'},context),{code:'assistant_tool_unsupported'});
});

test('a rejected reporting transaction propagates its error instead of returning zero counts',async()=>{
  const error=Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'});
  let calls=0;
  const tools=createCustomerAssistantTools({now,db:{withTransaction:async()=>{calls++;throw error;}}});
  await assert.rejects(tools.executeTool('query_negative',{},context),caught=>caught===error);
  assert.equal(calls,1);
});

test('email accepts only a report ID and delegates the unchanged server context',async()=>{
  const calls=[];const bound={...context,emailAllowed:true,email:'client@example.test',dryRun:true};
  const tools=createCustomerAssistantTools({db:{},email:{enqueue:async(...args)=>{calls.push(args);return {status:'preview'};}}});
  assert.equal((await tools.executeTool('email_daily_report',{reportId:'report-a'},bound)).status,'preview');
  assert.strictEqual(calls[0][0],bound);assert.equal(calls[0][1],'report-a');
  for(const args of [{reportId:'report-a',email:'other@example.test'},{reportId:'report-a',tenantId:'tenant-b'},{reportId:'report-a',dryRun:false}]) await assert.rejects(tools.executeTool('email_daily_report',args,bound),{code:'assistant_arguments_invalid'});
  assert.equal(calls.length,1);
});
