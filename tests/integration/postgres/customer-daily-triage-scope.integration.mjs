import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {collectCustomerDailyReport} from '../../../server/services/customer-daily-report-data.js';
import {customerDailyBusinessPeriod} from '../../../server/services/customer-daily-business-period.js';

test('daily counts and heat share triage admission, manual relevance and watch boundaries', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();
  const client = await getPool().connect();
  t.after(async () => { await client.query('ROLLBACK'); client.release(); await closePool(); });
  await client.query('BEGIN');
  await client.query('SET LOCAL jit=off');
  const tenant = (await client.query("INSERT INTO tenants(name) VALUES('日报分诊范围回归') RETURNING id")).rows[0].id;
  const foreign = (await client.query("INSERT INTO tenants(name) VALUES('另一租户') RETURNING id")).rows[0].id;
  const period = customerDailyBusinessPeriod('2026-09-29',new Date('2026-09-29T15:15:00+08:00'));
  const db = {queryAll:async (sql,p)=>(await client.query(sql,p)).rows,queryOne:async (sql,p)=>(await client.query(sql,p)).rows[0]};
  const created = '2026-09-28T20:00:00+08:00',observed = '2026-09-29T08:00:00+08:00';
  async function post({keyword='别克哨兵',title='开哨兵拍到开门碰车',relevance='uncertain',manual=null,watched=false,archived=false,visibility='eligible',status='unhandled',published=created,first=created,tenantId=tenant,observationKeyword=keyword}={}) {
    const id=randomUUID();
    await client.query(`INSERT INTO records(id,tenant_id,external_id,platform,record_type,title,content,keyword,sentiment,ai_result,manual_overrides,business_visibility,created_at,first_seen_at,published_ts,url)
      VALUES($1::uuid,$2,$1::text,'xiaohongshu','single_note',$3,$3,$4,'negative',$5::jsonb,$6::jsonb,$7,$8,$8,$9,'https://www.xiaohongshu.com/explore/'||$1::text)`,
      [id,tenantId,title,keyword,JSON.stringify({relevance}),JSON.stringify(manual?{relevance:{value:manual,reason:'人工核验'}}:{}),visibility,first,published]);
    await client.query('INSERT INTO record_triage(tenant_id,record_id,status,archived_at) VALUES($1,$2,$3,$4)',[tenantId,id,status,archived?observed:null]);
    if(watched) await client.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)',[tenantId,id]);
    const metrics={likes:81,comments_count:158,collects:40,shares:0};
    const payload={customerDailyMetricEvidence:{version:1,allMeasured:true,observedAt:observed,timeSource:'capture_timestamp',metrics:Object.fromEntries(Object.entries(metrics).map(([k,value])=>[k,{value,measured:true,reason:'observed'}]))}};
    await client.query('INSERT INTO record_observations(tenant_id,record_id,keyword,captured_at,likes,comments_count,collects,shares,payload) VALUES($1,$2,$3,$4,81,158,40,0,$5::jsonb)',[tenantId,id,observationKeyword,observed,JSON.stringify(payload)]);
    return id;
  }
  const rejected = [
    await post({first:'2026-09-27T21:00:00+08:00'}),
    await post({relevance:'relevant',watched:true}),
    await post({keyword:'普通功能',observationKeyword:'别克哨兵'}),
    await post({keyword:'普通功能',relevance:'relevant',manual:'irrelevant'}),
    await post({keyword:'普通功能',relevance:'irrelevant'}),
    await post({title:'别克哨兵',relevance:'relevant',visibility:'filtered_out'}),
    await post({published:null}),
    await post({title:'别克哨兵',relevance:'relevant',tenantId:foreign}),
  ];
  const retained = [
    await post({title:'别克哨兵开门碰车记录',relevance:'relevant'}),
    await post({relevance:'irrelevant',manual:'relevant'}),
    await post({keyword:'普通功能'}),
    await post({keyword:'普通功能',relevance:'irrelevant',watched:true}),
    await post({title:'别克哨兵已归档',relevance:'relevant',archived:true}),
    await post({keyword:'普通功能',relevance:'relevant',manual:'irrelevant',watched:true}),
  ];
  const nonMonitor = await post({title:'别克哨兵已复核',relevance:'relevant',status:'reviewed_non_monitor'});
  const options={tenantId:tenant,db,businessPeriod:period,auditCoverageFrom:'2026-08-01T00:00:00Z'};
  const report=await collectCustomerDailyReport(options);
  assert.equal(report.summary.day.monitor,retained.length+1);
  assert.equal(report.summary.mtd.monitor,retained.length+1);
  assert.equal(report.summary.day.sdb,retained.length);
  assert.equal(report.summary.day.nonMonitor,1);
  assert.deepEqual(new Set(report.evidence.dayRecordIds),new Set([...retained,nonMonitor]));
  assert.deepEqual(new Set(report.evidence.monthRecords.map(row=>row.recordId)),new Set([...retained,nonMonitor]));
  assert.deepEqual(new Set(report.highHeat.map(row=>row.recordId)),new Set(retained));
  assert.ok(report.highHeat.every(row=>row.heat===279));
  assert.equal(report.evidence.heat.missingPublishedCount,0,'excluded sentinel does not create a report warning');
  assert.ok(rejected.every(id=>!JSON.stringify(report.evidence.monthRecords).includes(id)));
  const frozen=structuredClone(report);
  await client.query("UPDATE records SET manual_overrides='{}',ai_result='{}' WHERE id=$1",[retained[1]]);
  const regenerated=await collectCustomerDailyReport(options);
  assert.equal(regenerated.summary.day.monitor,report.summary.day.monitor-1);
  assert.equal(regenerated.highHeat.length,report.highHeat.length-1);
  assert.deepEqual(report,frozen,'new collection cannot mutate a prior report snapshot');
});
