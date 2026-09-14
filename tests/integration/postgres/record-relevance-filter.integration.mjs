import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { createApp } from '../../../server/app.js';
import { hashPassword } from '../../../server/services/auth-service.js';
import { recordRelevanceJudgment, recordRelevanceExportFields, recordRelevanceSql, recordRelevanceConfidenceBandSql } from '../../../server/services/record-relevance-filter.js';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const ExcelJS = require('exceljs');

test('relevance/confidence SQL matches JavaScript; HTTP list and Excel share filters without changing admission or tenant scope', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  const halfMinimum = `0.${'0'.repeat(323)}${5n ** 1075n}`;
  const scores = [0, 1, .92, .5, .595, .5949999999999999, .795, .7949999999999999, .7949999999999998,
    null, '', ' ', '\ufeff .92\u00a0', true, false, [], {}, 'NaN', 'Infinity', '-Infinity',
    '.795', '7.95e-1', '+0.595', '0x1', '0x0', '0x2', '0b1', '0b0', '0o1', '-0x0', '0x',
    '1.00000000000000001', '1.0000000000000002', '-0.01', '1e99999999999999999', '1e-99999999999999999',
    '-1e-99999999999999999', '0e99999999999999999', '-0e99999999999999999', '1e-323', '-1e-323',
    '1e-324', '-1e-324', '3e-324', '-3e-324', `-${halfMinimum}`, `-${halfMinimum}1`,
    `${'0'.repeat(10000)}.795`, `1${'0'.repeat(10000)}e-10001`, '1e-000000000000000000000001',
    '0.795junk', '0.7\n95', '0.7_95', '0,795', '０.７９５'];
  const parity = scores.map((score, index) => ({ name: String(index), ai_result: { relevance: 'relevant', relevanceConfidence: score } }));
  for (const relevance of [null, 'uncertain', 'irrelevant', 'bogus', ['relevant'], { value: 'relevant' }]) {
    parity.push({ name: `relevance:${JSON.stringify(relevance)}`, ai_result: { relevance, relevanceConfidence: .99 } });
  }
  for (const override of ['relevant', { value: 'uncertain' }, { value: 'irrelevant' }, { value: 'bogus' }, ['relevant'], null]) {
    parity.push({ name: `manual:${JSON.stringify(override)}`, ai_result: { relevance: 'relevant', relevanceConfidence: '1e999999' }, manual_overrides: { relevance: override } });
  }
  const actual = (await pool.query(`SELECT r.name, ${recordRelevanceSql()} AS relevance, ${recordRelevanceConfidenceBandSql()} AS band
    FROM jsonb_to_recordset($1::jsonb) AS r(name text, ai_result jsonb, manual_overrides jsonb)`, [JSON.stringify(parity)])).rows;
  for (const row of actual) {
    const expected = recordRelevanceJudgment(parity.find(item => item.name === row.name));
    assert.equal(row.relevance, expected.relevance, row.name);
    assert.equal(row.band, expected.confidenceBand, row.name);
  }
  t.diagnostic(`SQL/JS parity verified for ${actual.length} numeric, malformed and manual cases.`);

  for (let index = 0; index < 2; index++) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Relevance ${randomUUID()}`])).rows[0].id);
  const [tenant, foreignTenant] = tenants;
  const fixtures = [];
  async function record(title, ai_result = {}, manual_overrides = {}, extra = {}) {
    const value = { id: randomUUID(), tenant_id: tenant, platform: 'douyin', external_id: title, title, keyword: '普通监测', record_type: 'keyword_notes', business_visibility: 'eligible', ai_result, manual_overrides, ...extra };
    const columns = Object.keys(value);
    await pool.query(`INSERT INTO records(${columns.join(',')}) VALUES(${columns.map((_, index) => `$${index+1}`).join(',')})`, Object.values(value).map(item => item !== null && typeof item === 'object' ? JSON.stringify(item) : item));
    if (!Object.keys(extra).length) fixtures.push(value);
  }
  await record('AI相关高', { relevance: 'relevant', relevanceConfidence: .92, relevanceReason: 'AI原帖依据' });
  await record('AI无关高', { relevance: 'irrelevant', relevanceConfidence: .99 });
  await record('AI不足中', { relevance: 'uncertain', relevanceConfidence: '.595' });
  await record('AI相关低', { relevance: 'relevant', relevanceConfidence: 0 });
  await record('AI无关低', { relevance: 'irrelevant', relevanceConfidence: '.5949999999999999' });
  await record('AI无分', { relevance: 'relevant', relevanceConfidence: '' });
  await record('AI脏分', { relevance: 'uncertain', relevanceConfidence: '1e99999999' });
  await record('AI未判断有旧分', { relevanceConfidence: .99 });
  await record('AI非法判断', { relevance: 'bogus', relevanceConfidence: .99 });
  await record('人工相关', { relevance: 'irrelevant', relevanceConfidence: .99, relevanceReason: '旧AI依据' }, { relevance: { value: 'relevant', reason: '人工原帖依据' } });
  await record('人工无关', { relevance: 'relevant', relevanceConfidence: .99, relevanceReason: '旧AI依据' }, { relevance: 'irrelevant' });
  await record('人工不足', { relevance: 'relevant', relevanceConfidence: .99 }, { relevance: { value: 'uncertain' } });
  await record('人工非法用AI', { relevance: 'relevant', relevanceConfidence: '.795' }, { relevance: { value: 'bogus' } });
  await record('其它租户', { relevance: 'relevant', relevanceConfidence: .99 }, {}, { tenant_id: foreignTenant });
  await record('不符合业务范围', { relevance: 'relevant', relevanceConfidence: .99 }, {}, { business_visibility: 'filtered_out' });
  await record('已拦截哨兵缺车型', { relevance: 'relevant', relevanceConfidence: .99 }, {}, { keyword: '别克哨兵' });

  const email = `relevance-${randomUUID()}@integration.invalid`;
  users.push((await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Relevance reviewer',$2,'active',false,'',false) RETURNING id", [email, hashPassword('relevance-test-password')])).rows[0].id);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [users[0], tenant]);
  server = await new Promise(resolve => { const instance = createApp({ logger: { log() {}, error() {} } }).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'relevance-test-password' }) });
  assert.equal(login.status, 200);
  const headers = { authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': tenant };
  const selections = [
    ['', [], []], ['relevance=relevant', ['relevant'], []], ['relevance=unjudged', ['unjudged'], []],
    ['relevance=relevant,uncertain&relevanceConfidence=high,manual', ['relevant','uncertain'], ['high','manual']],
    ['relevance=irrelevant&relevanceConfidence=high', ['irrelevant'], ['high']],
    ['relevance=relevant&relevance=uncertain&relevanceConfidence=medium&relevanceConfidence=low', ['relevant','uncertain'], ['medium','low']],
    ['relevanceConfidence=missing', [], ['missing']], ['relevanceConfidence=manual', [], ['manual']],
    ['relevance=unjudged&relevanceConfidence=high', ['unjudged'], ['high']],
  ];
  for (const [query, relevance, confidence] of selections) {
    const expected = fixtures.filter(row => { const judgment = recordRelevanceJudgment(row); return (!relevance.length || relevance.includes(judgment.relevance)) && (!confidence.length || confidence.includes(judgment.confidenceBand)); });
    const response = await fetch(`${base}/api/triage/records?pageSize=100&${query}`, { headers });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.records.map(row => row.id).sort(), expected.map(row => row.id).sort(), query);
    assert.equal(Number(body.pagination.total), expected.length, query);
    const exported = await fetch(`${base}/api/triage/records/export?${query}`, { headers });
    assert.equal(exported.status, 200, query);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
    const sheet = workbook.worksheets[0], columns = sheet.getRow(1).values;
    const titles = [], byHeader = (row, name) => row.getCell(columns.indexOf(name)).value ?? '';
    assert.equal(columns.includes('相关度'), false);
    for (const name of ['相关性','AI置信度','判断来源','相关性依据']) assert.ok(columns.includes(name));
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const title = byHeader(row, '标题');
      titles.push(title);
      const value = recordRelevanceExportFields(expected.find(record => record.title === title));
      for (const [header, key] of [['相关性','relevance'],['AI置信度','relevance_confidence'],['判断来源','relevance_source'],['相关性依据','relevance_reason']]) assert.equal(byHeader(row, header), value[key], `${query}:${title}:${header}`);
    });
    assert.deepEqual(titles.sort(), expected.map(row => row.title).sort(), `export:${query}`);
  }
  for (const query of ['relevance=bad','relevance=','relevance=relevant,','relevanceConfidence=','relevanceConfidence=bad',`relevance=${encodeURIComponent("relevant') OR true--")}`, 'relevanceConfidence[bad]=high']) {
    for (const endpoint of ['records','records/export']) {
      const response = await fetch(`${base}/api/triage/${endpoint}?${query}`, { headers });
      assert.equal(response.status, 400, `${endpoint}:${query}`);
    }
  }
});
