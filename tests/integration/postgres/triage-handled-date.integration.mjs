import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {appendTriageDateFilters} from '../../../server/routes/triage.js';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const ExcelJS = require('exceljs');

test('handling dates use real single and batch transitions, Beijing days, deduplication and the same HTTP export scope', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL, databaseUrl:process.env.DATABASE_URL, requireDatabaseUrl:true});
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (let i=0;i<2;i++) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Handling test ${randomUUID()}`])).rows[0].id);
  const [tenant, otherTenant] = tenants;
  const ids = {};
  async function record(name, published='2026-09-08T12:00:00+08:00') {
    const id = randomUUID(); ids[name] = id;
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,record_type,created_at,first_seen_at,last_seen_at,published_ts,business_visibility,ai_result)
      VALUES($1,$2,'douyin',$3,$3,'keyword_notes','2026-09-08T22:00:00+08:00','2026-09-08T22:00:00+08:00','2026-09-11T12:00:00+08:00',$4,'eligible','{"relevance":"relevant"}')`, [id,tenant,name,published]);
    await pool.query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [tenant,id]);
    return id;
  }
  async function event(name, at, metadata, {action='record.triage_updated',tenantId=tenant,actor='user'}={}) {
    await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
      VALUES($1,$2,'integration',$3,'record',$4,$5::jsonb,$6)`, [tenantId,actor,action,ids[name] || '',JSON.stringify(metadata),at]);
  }
  const changed = {previousStatus:'unhandled',nextStatus:'reviewed'};
  for (const name of ['single','start','end','before','batch-changed','batch-same','note-only','same-status','old-unknown','ticket','cross-tenant','official-no-status-change']) await record(name);
  await record('published-today','2026-09-09T01:00:00+08:00');
  await event('single','2026-09-09T10:00:00+08:00',changed);
  await event('single','2026-09-09T12:00:00+08:00',{previousStatus:'reviewed',nextStatus:'negative_cold'});
  await event('single','2026-09-10T10:00:00+08:00',{previousStatus:'negative_cold',nextStatus:'reviewed'});
  await event('start','2026-09-09T00:00:00+08:00',changed,{actor:'auth_code'});
  await event('end','2026-09-10T00:00:00+08:00',changed);
  await event('before','2026-09-08T23:59:59.999+08:00',changed);
  await event('batch-changed','2026-09-09T08:00:00+08:00',{status:'reviewed',recordIds:[ids['batch-changed'],ids['batch-same']],previous:{[ids['batch-changed']]:{status:'unhandled'},[ids['batch-same']]:{status:'reviewed'}}},{action:'record.triage_batch_updated'});
  await event('note-only','2026-09-09T11:00:00+08:00',{previousStatus:'reviewed',nextStatus:'reviewed',note:'a new note'});
  await event('same-status','2026-09-09T11:00:00+08:00',{previousStatus:'reviewed',nextStatus:'reviewed'});
  await event('old-unknown','2026-09-09T11:00:00+08:00',{nextStatus:'reviewed'});
  await event('ticket','2026-09-09T11:00:00+08:00',{previousStatus:'unhandled',nextStatus:'negative_feishu'},{action:'record.ticket_created'});
  await event('official-no-status-change','2026-09-09T11:00:00+08:00',{previousStatus:'reviewed',nextStatus:'reviewed'},{action:'record.official_response_marked'});
  await event('single','2026-09-07T11:00:00+08:00',{previousStatus:'unhandled',nextStatus:'official_responded'},{action:'record.official_response_marked'});
  await event('cross-tenant','2026-09-09T11:00:00+08:00',changed,{tenantId:otherTenant});
  await event('published-today','2026-09-09T11:00:00+08:00',changed);
  const dates = {handledFrom:'2026-09-09',handledTo:'2026-09-09'};
  const expected = ['single','start','batch-changed','ticket','published-today'].map(name=>ids[name]).sort();
  // Explicitly vary the connection timezone; query boundaries must stay in Beijing.
  const client = await pool.connect();
  try {
    for (const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']) {
      await client.query("SELECT set_config('TimeZone',$1,false)",[zone]);
      const params=[tenant], where=appendTriageDateFilters('WHERE r.tenant_id=$1',params,dates);
      const rows=(await client.query(`SELECT r.id FROM records r ${where} ORDER BY r.id`,params)).rows;
      assert.deepEqual(rows.map(row=>row.id),expected,zone);
    }
    const params=[tenant], where=appendTriageDateFilters('WHERE r.tenant_id=$1',params,{handledFrom:'2026-09-07',handledTo:'2026-09-07'});
    assert.deepEqual((await client.query(`SELECT r.id FROM records r ${where}`,params)).rows.map(row=>row.id),[ids.single]);
  } finally {client.release();}
  const email=`handling-${randomUUID()}@integration.invalid`;
  const user=(await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Handling test',$2,'active',false,'',false) RETURNING id",[email,hashPassword('handling-test-password')])).rows[0].id;
  users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')",[user,tenant]);
  server=await new Promise(resolve=>{const instance=createApp({logger:{log(){},error(){}}}).listen(0,'127.0.0.1',()=>resolve(instance));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'handling-test-password'})});
  assert.equal(login.status,200);
  const headers={authorization:`Bearer ${(await login.json()).token}`,'x-tenant-id':tenant};
  async function list(filters) {
    const response=await fetch(`${base}/api/triage/records?${new URLSearchParams({queue:'triage',pageSize:'100',...filters})}`,{headers});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
  }
  const all=await list(dates);
  assert.equal(all.pagination.total,5);
  assert.deepEqual(all.records.map(row=>row.id).sort(),expected);
  const combined={...dates,publishFrom:'2026-09-08',publishTo:'2026-09-08'};
  const narrowed=await list(combined);
  assert.equal(narrowed.pagination.total,4);
  assert.ok(!narrowed.records.some(row=>row.id===ids['published-today']));
  assert.equal((await list({...combined,firstFrom:'2026-09-09',firstTo:'2026-09-09'})).pagination.total,0);
  const exported=await fetch(`${base}/api/triage/records/export?${new URLSearchParams({queue:'triage',...combined})}`,{headers});
  assert.equal(exported.status,200);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
  assert.equal(workbook.worksheets[0].rowCount,5);
  const exportedText=JSON.stringify(workbook.worksheets[0].getSheetValues());
  for (const name of ['single','start','batch-changed','ticket']) assert.ok(exportedText.includes(name));
  assert.ok(!exportedText.includes('published-today'));
  const denied=await fetch(`${base}/api/triage/records?${new URLSearchParams(dates)}`,{headers:{...headers,'x-tenant-id':otherTenant}});
  assert.equal(denied.status,403);
  for (const filters of [{handledFrom:'2026-02-30'}, {handledFrom:'2026-09-10',handledTo:'2026-09-09'}, {handledTo:'invalid'}]) {
    for (const route of ['/records','/records/export']) {
      const response=await fetch(`${base}/api/triage${route}?${new URLSearchParams(filters)}`,{headers});
      assert.equal(response.status,400);
      assert.equal((await response.json()).error,'invalid_handled_date_range');
    }
  }
});
