import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {processingRecordsSql, EXPORT_STATEMENT_TIMEOUT_MS} from '../../../server/routes/triage.js';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const ExcelJS = require('exceljs');

// docs/hotfix/20261009-triage-export-timeout.md: the export's 处理记录 column
// looked a record's status notes up with
//   al.target_id = r.id::text OR COALESCE(al.metadata->'recordIds','[]'::jsonb) ? r.id::text
// and re-read the tenant's whole audit_logs for every exported row until the
// 10 s reporting limit cancelled the statement. Migration 093 adds the two
// indexes that serve both sides of that OR; the statement text is unchanged.
const INDEXES = ['idx_audit_logs_tenant_target', 'idx_audit_logs_record_ids'];
// Enough audit history that a sequential scan is the expensive choice on every
// supported PostgreSQL (CI runs 14 and 16; production is 14.24 with 16k rows).
const FILLER_ROWS = 20000;

test('the export composes processing records per row through the 093 indexes and keeps its own statement limit', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  // Every statement_timeout the application sets, so the export's limit and the list's limit are both observable.
  const statementTimeouts = [];
  const originalConnect = pool.connect.bind(pool);
  const PATCHED = Symbol('patched');
  const observe = client => {
    if (!client || client[PATCHED]) return client;
    client[PATCHED] = true;
    const run = client.query.bind(client);
    client.query = (sql, params, ...rest) => {
      if (typeof sql === 'string' && sql.includes("set_config('statement_timeout'")) statementTimeouts.push(params[0]);
      return run(sql, params, ...rest);
    };
    return client;
  };
  pool.connect = callback => typeof callback === 'function'
    ? originalConnect((error, client, done) => callback(error, observe(client), done))
    : originalConnect().then(observe);

  const tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (tenants.length) {
      await pool.query('DELETE FROM audit_logs WHERE tenant_id=ANY($1::uuid[])', [tenants]);
      await pool.query('DELETE FROM records WHERE tenant_id=ANY($1::uuid[])', [tenants]);
    }
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (const name of ['export', 'other']) tenants.push((await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Export processing ${name} ${randomUUID()}`]))[0].id);
  const [tenant, otherTenant] = tenants;
  const email = `export-${randomUUID()}@integration.invalid`;
  const password = randomUUID();
  const [user] = await query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'导出测试员',$2,'active',false,'',false) RETURNING id", [email, hashPassword(password)]);
  users.push(user.id);
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [user.id, tenant]);

  // Five records; published_ts descends in this order so the export (sort=publish desc) lists them A..E.
  const ids = {};
  const names = ['single-and-note', 'batch-and-ticket', 'batch-only', 'no-progress', 'status-change-without-note'];
  for (const [index, name] of names.entries()) {
    ids[name] = randomUUID();
    await query(`INSERT INTO records(id,tenant_id,platform,external_id,title,record_type,created_at,first_seen_at,last_seen_at,published_ts,business_visibility,ai_result)
      VALUES($1,$2,'douyin',$3,$3,'keyword_notes','2026-09-08T22:00:00+08:00','2026-09-08T22:00:00+08:00','2026-09-11T12:00:00+08:00',$4,'eligible','{"relevance":"relevant"}')`,
    [ids[name], tenant, name, new Date(Date.parse('2026-09-08T12:00:00+08:00') - index * 3600_000).toISOString()]);
    await query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [tenant, ids[name]]);
  }
  async function audit(action, targetId, metadata, at, {tenantId = tenant, actorUserId = null, actorId = 'ops'} = {}) {
    await query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,actor_user_id,action,target_type,target_id,metadata,created_at)
      VALUES($1,'user',$2,$3,$4,'record',$5,$6::jsonb,$7)`, [tenantId, actorId, actorUserId, action, targetId, JSON.stringify(metadata), at]);
  }
  await audit('record.triage_updated', ids['single-and-note'], {previousStatus: 'unhandled', nextStatus: 'reviewed', note: '复核完成'}, '2026-09-09T10:00:00+08:00', {actorUserId: user.id});
  await audit('record.triage_updated', ids['single-and-note'], {previousStatus: 'reviewed', nextStatus: 'negative_cold'}, '2026-09-09T11:00:00+08:00', {actorUserId: user.id});
  await audit('record.triage_updated', ids['status-change-without-note'], {previousStatus: 'unhandled', nextStatus: 'reviewed', note: '   '}, '2026-09-09T10:30:00+08:00');
  await audit('record.triage_batch_updated', '', {status: 'negative_feishu', note: '批量转飞书', recordIds: [ids['batch-and-ticket'], ids['batch-only']],
    previous: {[ids['batch-and-ticket']]: {status: 'unhandled'}, [ids['batch-only']]: {status: 'unhandled'}}}, '2026-09-09T12:00:00+08:00');
  // Another tenant's note on the same record id never shows up.
  await audit('record.triage_updated', ids['single-and-note'], {previousStatus: 'unhandled', nextStatus: 'reviewed', note: '别的租户的备注'}, '2026-09-09T13:00:00+08:00', {tenantId: otherTenant});
  await query("INSERT INTO record_notes(tenant_id,record_id,body,author_name,created_at) VALUES($1,$2,'客户已回电','张三','2026-09-08T09:30:00+08:00')", [tenant, ids['single-and-note']]);
  const [ticket] = await query("INSERT INTO tickets(tenant_id,source_type,source_record_id,platform,title,status,external_ticket_no,created_at) VALUES($1,'content',$2,'douyin','t','closed','GD-7','2026-09-10T08:00:00+08:00') RETURNING id", [tenant, ids['batch-and-ticket']]);
  await query("INSERT INTO ticket_notes(tenant_id,ticket_id,body,author_name,event_type,created_at) VALUES($1,$2,'已派单','李四','note','2026-09-10T09:00:00+08:00'), ($1,$2,'','李四','closed','2026-09-11T09:00:00+08:00')", [tenant, ticket.id]);
  // Audit history of the tenant: single notes on other targets and batch notes whose recordIds point elsewhere.
  await query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
    SELECT $1, 'user', 'ops',
      CASE WHEN n % 2 = 0 THEN 'record.triage_updated' ELSE 'record.triage_batch_updated' END, 'record',
      CASE WHEN n % 2 = 0 THEN gen_random_uuid()::text ELSE '' END,
      CASE WHEN n % 2 = 0
        THEN jsonb_build_object('note', '历史备注 ' || n || ' ' || md5(n::text), 'previousStatus', 'unhandled', 'nextStatus', 'reviewed')
        ELSE jsonb_build_object('note', '历史批量备注 ' || n, 'status', 'reviewed',
          'recordIds', (SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1, 10)))
      END,
      '2026-01-01T00:00:00+08:00'::timestamptz + n * interval '1 minute'
    FROM generate_series(1, $2::integer) n`, [tenant, FILLER_ROWS]);
  // Production built the 093 indexes in bulk; VACUUM folds the GIN pending list
  // in and refreshes the statistics the planner costs the OR with.
  await query('VACUUM ANALYZE audit_logs');

  function scans(node, found = []) {
    const indexes = new Set();
    (function collect(child) {
      if (child['Index Name']) indexes.add(child['Index Name']);
      for (const next of child.Plans || []) if (!next['Relation Name']) collect(next);
    })(node);
    if (node['Relation Name']) found.push({type: node['Node Type'], relation: node['Relation Name'], indexes: [...indexes].sort()});
    for (const child of node.Plans || []) scans(child, found);
    return found;
  }

  await t.test('the status-note lookup is planned through both 093 indexes, never a sequential scan of audit_logs', async () => {
    const [row] = await query(`EXPLAIN (FORMAT JSON) SELECT ${processingRecordsSql('r')} AS processing_records FROM records r WHERE r.tenant_id = $1`, [tenant]);
    const audits = scans(row['QUERY PLAN'][0].Plan).filter(scan => scan.relation === 'audit_logs');
    assert.equal(audits.length, 1, JSON.stringify(audits));
    assert.notEqual(audits[0].type, 'Seq Scan', JSON.stringify(audits));
    assert.deepEqual(audits[0].indexes, [...INDEXES].sort(), JSON.stringify(audits));
  });

  server = await new Promise(resolve => { const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
  assert.equal(login.status, 200);
  const headers = {authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': tenant};
  const exportUrl = `${base}/api/triage/records/export?${new URLSearchParams({sort: 'publish', dir: 'desc'})}`;

  await t.test('每条内容的处理记录只含自己的备注、状态备注和工单过程，按时间排列', async () => {
    statementTimeouts.length = 0;
    const exported = await fetch(exportUrl, {headers});
    if (exported.status !== 200) assert.fail(`export ${exported.status}: ${await exported.text()}`);
    assert.deepEqual(statementTimeouts, [`${EXPORT_STATEMENT_TIMEOUT_MS}ms`], 'the export runs under its own statement limit');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values;
    const titleColumn = header.indexOf('标题'), processingColumn = header.indexOf('处理记录');
    assert.ok(titleColumn > 0 && processingColumn > 0, JSON.stringify(header));
    const byTitle = {};
    sheet.eachRow((row, number) => { if (number > 1) byTitle[row.getCell(titleColumn).text] = row.getCell(processingColumn).text; });
    assert.deepEqual(Object.keys(byTitle), names, 'sorted by publish time, newest first');
    assert.deepEqual(byTitle, {
      'single-and-note': '2026-09-08 09:30 张三 内容备注：客户已回电\n2026-09-09 10:00 导出测试员 状态备注：复核完成',
      'batch-and-ticket': '2026-09-09 12:00 ops 状态备注：批量转飞书\n2026-09-10 09:00 李四 工单 GD-7 处理进展：已派单\n2026-09-11 09:00 李四 工单 GD-7 结案',
      'batch-only': '2026-09-09 12:00 ops 状态备注：批量转飞书',
      'no-progress': '',
      'status-change-without-note': '',
    });
    statementTimeouts.length = 0;
    const list = await fetch(`${base}/api/triage/records?${new URLSearchParams({pageSize: '5'})}`, {headers});
    assert.equal(list.status, 200);
    assert.ok(statementTimeouts.length > 0 && statementTimeouts.every(value => value === '10000ms'), `the list keeps the shared 10 s limit: ${JSON.stringify(statementTimeouts)}`);
  });
});
