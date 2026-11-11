import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool,closePool} from '../../../server/db/pool.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {getCrossPosts} from '../../../server/services/cross-posts/store.js';

test('actual PG cross-posts, detail and triage lists agree on outside/eligible/reviewed/archived presentation', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const dir=await mkdtemp(join(tmpdir(),'sentry-display-'));
  const previous=process.env.SENTRY_ADMISSION_CONFIG_PATH;
  process.env.SENTRY_ADMISSION_CONFIG_PATH=join(dir,'activation.json');
  await writeFile(process.env.SENTRY_ADMISSION_CONFIG_PATH,JSON.stringify({SENTRY_SCOPE_RETIRED_AT:'2026-11-11T12:00:00Z'}));
  const {createApp}=await import('../../../server/app.js');
  await runMigrations();
  const pool=getPool();let server,tenant,user;
  t.after(async()=>{
    if(server)await new Promise(resolve=>server.close(resolve));
    if(user)await pool.query('DELETE FROM users WHERE id=$1',[user]);
    if(tenant)await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]);
    await closePool();await rm(dir,{recursive:true,force:true});
    if(previous===undefined)delete process.env.SENTRY_ADMISSION_CONFIG_PATH;else process.env.SENTRY_ADMISSION_CONFIG_PATH=previous;
  });
  tenant=(await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id',['Sentry display '+randomUUID()])).rows[0].id;
  const fixtures=[
    {name:'ordinary uncertain',relevance:'uncertain',expected:'unhandled'},
    {name:'watched irrelevant',relevance:'irrelevant',watched:true,expected:'watched_not_pending',reason:'已关注的无关内容保留在工作列表，不计入待处理数量'},
    {name:'AI irrelevant',relevance:'irrelevant',expected:'not_admitted',reason:'AI 判定无关'},
    {name:'manual irrelevant',relevance:'relevant',manual:{relevance:{value:'irrelevant'}},expected:'not_admitted',reason:'人工判定无关'},
    {name:'filtered out',visibility:'filtered_out',expected:'not_admitted',reason:'已被采集预筛排除'},
    {name:'deferred',visibility:'deferred',expected:'not_admitted',reason:'采集详情尚未完成'},
    {name:'legacy observed sentry',observed:'别克哨兵',relevance:'uncertain',expected:'not_admitted',reason:'历史内容未通过当时的准入规则'},
    {name:'legacy included',keyword:'别克哨兵',relevance:'uncertain',manual:{triage_admission:{value:'included'}},expected:'unhandled'},
    {name:'new sentry relevant',keyword:'别克哨兵',created:'2026-11-11T12:00:00Z',expected:'unhandled'},
    {name:'new observed uncertain',observed:'别克哨兵',created:'2026-11-11T12:00:01Z',relevance:'uncertain',expected:'unhandled'},
    {name:'reviewed excluded',status:'reviewed_non_monitor',relevance:'irrelevant',expected:'reviewed_non_monitor'},
    {name:'archived excluded',status:'reviewed',archived:true,visibility:'filtered_out',expected:'reviewed'},
  ];
  for(const [index,fixture] of fixtures.entries()){
    fixture.id=randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,title,keyword,business_visibility,ai_result,manual_overrides,created_at)
      VALUES($1::uuid,$2,$3,$1::text,'keyword_notes',$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [fixture.id,tenant,['douyin','xiaohongshu','wechat_channels'][index%3],fixture.name,fixture.keyword||'安吉星',fixture.visibility||'eligible',JSON.stringify({relevance:fixture.relevance||'relevant'}),JSON.stringify(fixture.manual||{}),fixture.created||'2026-11-01T00:00:00Z']);
    if(fixture.watched)await pool.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)',[tenant,fixture.id]);
    if(fixture.observed)await pool.query('INSERT INTO record_observations(record_id,tenant_id,keyword) VALUES($1,$2,$3)',[fixture.id,tenant,fixture.observed]);
    if(fixture.status)await pool.query('INSERT INTO record_triage(record_id,tenant_id,status,archived_at) VALUES($1,$2,$3,$4)',[fixture.id,tenant,fixture.status,fixture.archived?'2026-11-11T13:00:00Z':null]);
  }
  for(const fixture of fixtures)await pool.query('INSERT INTO record_cross_posts(tenant_id,record_id,group_id,score) VALUES($1,$2,$3,1)',[tenant,fixture.id,fixtures[0].id]);
  const members=(await getCrossPosts(tenant,fixtures[0].id)).members;
  assert.equal(members.length,fixtures.length);
  const email=`display-${randomUUID()}@integration.invalid`,password='Offline-display-123';
  user=(await pool.query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Display test',$2,'active',false,'',false) RETURNING id`,[email,hashPassword(password)])).rows[0].id;
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')",[user,tenant]);
  server=await new Promise((resolve,reject)=>{const app=createApp({logger:{log(){},error(){}}}).listen(0,'127.0.0.1');app.once('listening',()=>resolve(app));app.once('error',reject);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(login.status,200);
  const headers={authorization:`Bearer ${(await login.json()).token}`,'x-tenant-id':tenant};
  async function get(path){const response=await fetch(base+path,{headers});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;}
  await t.test('cross-post and full detail carry identical status/reason without inventing triage rows',async()=>{
    for(const fixture of fixtures){
      const member=members.find(row=>row.id===fixture.id),detail=(await get(`/api/opinion-analysis/records/${fixture.id}/detail`)).record;
      for(const row of [member,detail]){
        assert.equal(row.triage_display_status,fixture.expected,fixture.name);
        assert.equal(row.triage_display_reason,fixture.reason||'',fixture.name);
        assert.equal(row.triage_status,fixture.status||'unhandled',fixture.name);
      }
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM record_triage WHERE tenant_id=$1',[tenant])).rows[0].n,2);
  });
  await t.test('active list total exactly matches displayed pending records; manual included uncertain remains independent',async()=>{
    const list=await get('/api/triage/records?queue=active&pageSize=100');
    const expected=fixtures.filter(row=>row.expected==='unhandled'&&!row.watched).map(row=>row.id).sort();
    assert.deepEqual(list.records.map(row=>row.id).sort(),expected);
    assert.equal(list.pagination.total,4);
    const overview=await get('/api/workspace/overview?days=7');
    assert.deepEqual(overview.pendingRecords.map(row=>row.id).sort(),expected,'overview pending suggestions use exactly active queue scope');
    const watched=fixtures.find(row=>row.watched),triage=await get('/api/triage/records?queue=triage&pageSize=100');
    assert.equal(triage.records.find(row=>row.id===watched.id)?.triage_display_status,'watched_not_pending','watched irrelevant remains in the working list, outside active pending count');
    assert.ok(list.records.every(row=>row.triage_display_status==='unhandled'&&row.triage_display_reason===''));
    const included=fixtures.find(row=>row.name==='legacy included');
    assert.equal((await pool.query('SELECT ai_result->>\'relevance\' AS relevance FROM records WHERE id=$1',[included.id])).rows[0].relevance,'uncertain');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM record_triage WHERE record_id=$1',[included.id])).rows[0].n,0);
  });
});
