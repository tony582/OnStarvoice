import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const CUTOFF = '2026-11-11T11:12:13.456Z', BEFORE = '2026-11-11T11:12:13.455Z';
const KEYWORDS = ['别克哨兵', '至境哨兵', '凯迪拉克哨兵', '雪佛兰哨兵', '通用哨兵'];

test('created_at retirement boundary preserves historical admission and makes new sentry rows ordinary in real SQL and HTTP', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const directory = await mkdtemp(join(tmpdir(), 'sentry-pg-config-')), config = join(directory, 'sentry-admission.json');
  const originalConfig = process.env.SENTRY_ADMISSION_CONFIG_PATH, originalFetch = globalThis.fetch;
  await writeFile(config, JSON.stringify({SENTRY_SCOPE_RETIRED_AT: CUTOFF}));
  process.env.SENTRY_ADMISSION_CONFIG_PATH = config;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    assert.equal(url.hostname, '127.0.0.1', 'only the test HTTP server may be contacted');
    return originalFetch(input, options);
  };
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {recordTriageAdmission, recordTriageAdmissionSql, recordAdmissionSelectSql, recordEffectiveRelevanceSql,
    withRecordAdmissionFields, legacySentryAdmissionScopeSql} = await import('../../../server/services/record-triage-admission.js');
  const {createApp} = await import('../../../server/app.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
  await runMigrations();
  const pool = getPool(), tenants = [], users = [], fixtures = new Map();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  let server;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server) {server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));}
    try {
      if (users.length) await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      if (tenants.length) await query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    } finally {
      await closePool();
      if (originalConfig === undefined) delete process.env.SENTRY_ADMISSION_CONFIG_PATH; else process.env.SENTRY_ADMISSION_CONFIG_PATH = originalConfig;
      await rm(directory, {recursive: true, force: true});
    }
  });
  for (let n = 0; n < 2; n++) tenants.push((await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`sentry boundary ${randomUUID()}`]))[0].id);
  const [tenantId, foreignTenant] = tenants;
  async function record(name, {created_at = CUTOFF, keyword = '别克哨兵', relevance = 'uncertain', admitted = true,
    observed_keywords = [], manual_overrides = {}, owner = tenantId} = {}) {
    const id = randomUUID();
    await query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,title,content,keyword,created_at,
      updated_at,first_seen_at,last_seen_at,published_ts,business_visibility,ai_result,manual_overrides)
      VALUES($1::uuid,$2,'xiaohongshu',($1::uuid)::text,'keyword_notes','录像怎么导出','希望有人帮忙',$3,$4,
        '2026-11-12T00:00:00Z','2026-11-12T00:00:00Z','2026-11-12T00:00:00Z','2026-11-12T00:00:00Z','eligible',$5,$6)`,
    [id, owner, keyword, created_at, {relevance}, manual_overrides]);
    for (const observed of observed_keywords) await query('INSERT INTO record_observations(tenant_id,record_id,keyword) VALUES($1,$2,$3)', [owner, id, observed]);
    fixtures.set(id, {name, admitted, observed_keywords, owner}); return id;
  }
  for (const keyword of KEYWORDS) for (const relevance of ['relevant', 'uncertain', 'irrelevant']) {
    await record(`new-${keyword}-${relevance}`, {keyword, relevance, admitted: relevance !== 'irrelevant'});
  }
  for (const relevance of ['relevant', 'uncertain', 'irrelevant']) {
    await record(`ordinary-${relevance}`, {keyword: '安吉星', relevance, admitted: relevance !== 'irrelevant'});
  }
  const oldRelevant = await record('old-relevant', {created_at: BEFORE, relevance: 'relevant', admitted: false});
  const oldUncertain = await record('old-uncertain', {created_at: BEFORE, relevance: 'uncertain', admitted: false});
  const oldObserved = await record('old-observed-sentry', {created_at: BEFORE, keyword: '安吉星', observed_keywords: ['凯迪拉克哨兵'], admitted: false});
  const newObserved = await record('new-observed-sentry', {keyword: '安吉星', observed_keywords: ['凯迪拉克哨兵']});
  await record('new-manual-irrelevant', {manual_overrides: {relevance: 'irrelevant'}, admitted: false});
  await record('new-manual-relevant', {relevance: 'irrelevant', manual_overrides: {relevance: {value: 'relevant'}}});
  await record('old-included-but-irrelevant', {created_at: BEFORE, relevance: 'irrelevant', manual_overrides: {triage_admission: {value: 'included'}}, admitted: false});
  const foreign = await record('foreign-new', {owner: foreignTenant});
  const expected = () => [...fixtures].filter(([, value]) => value.owner === tenantId && value.admitted).map(([id]) => id).sort();
  const eligibleSql = `r.business_visibility='eligible' AND (${recordTriageAdmissionSql('r')}) AND ${recordEffectiveRelevanceSql('r')} <> 'irrelevant'`;
  const workIds = async () => (await query(`SELECT r.id FROM records r WHERE r.tenant_id=$1 AND ${eligibleSql} ORDER BY r.id`, [tenantId])).map(row => row.id);

  await t.test('SQL and JS agree for all five keywords, observed keywords and human relevance; ordinary irrelevant stays outside', async () => {
    const rows = await query(`SELECT r.*,${recordAdmissionSelectSql('r')} FROM records r WHERE r.tenant_id=$1 ORDER BY r.id`, [tenantId]);
    for (const row of rows) {
      const fixture = fixtures.get(row.id), js = recordTriageAdmission({...row, observed_keywords: fixture.observed_keywords});
      assert.equal(js.scoped, row.admission_scoped, fixture.name);
      assert.equal(js.admitted, row.admission_allowed, fixture.name);
      assert.equal(js.admitted && js.relevance !== 'irrelevant', fixture.admitted, fixture.name);
      const displayed = withRecordAdmissionFields(row);
      assert.equal(displayed.triage_display_status === 'unhandled', fixture.admitted, fixture.name);
      if (!row.admission_scoped) assert.equal(displayed.monitoring_evidence_status, 'not_applicable', fixture.name);
    }
    assert.deepEqual(await workIds(), expected());
    const [nullable] = await query(`SELECT ${legacySentryAdmissionScopeSql('r')} AS scoped FROM
      jsonb_populate_record(NULL::records,$1::jsonb) r`, [JSON.stringify({id: randomUUID(), tenant_id: tenantId, keyword: '别克哨兵', created_at: null})]);
    assert.equal(nullable.scoped, true, 'a missing created_at never retires the historical gate');
  });

  const email = `sentry-boundary-${randomUUID()}@integration.invalid`, password = 'local-sentry-boundary-password';
  const userId = (await query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password)
    VALUES($1,'sentry boundary',$2,'active',false,'',false) RETURNING id`, [email, hashPassword(password)]))[0].id;
  users.push(userId);
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [userId, tenantId]);
  server = await new Promise((resolve, reject) => {
    const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    instance.once('error', reject); instance.once('listening', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
  assert.equal(login.status, 200);
  const headers = {authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': tenantId};
  const list = async () => {
    const response = await fetch(`${base}/api/triage/records?queue=triage&pageSize=100`, {headers});
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };

  await t.test('real authenticated work list applies the outer irrelevant filter and keeps all unlisted history out', async () => {
    const result = await list();
    assert.deepEqual(result.records.map(row => row.id).sort(), expected());
    assert.equal(result.pagination.total, 14);
    assert.ok(result.records.every(row => row.triage_display_status === 'unhandled'));
    assert.ok(!result.records.some(row => [oldRelevant, oldUncertain, oldObserved, foreign].includes(row.id)));
    assert.equal(result.records.find(row => row.id === newObserved).monitoring_evidence_status, 'not_applicable');
    t.diagnostic(JSON.stringify({kind: 'sentry-retirement-before-overrides', cutoff: CUTOFF, admitted: result.pagination.total,
      blockedHistoricalDesignated: 2, blockedOtherHistorical: 1, newObservedSentryAdmitted: true}));
  });

  await t.test('only two explicitly included historical records enter, without triage rows or changed AI judgment', async () => {
    const designated = [oldRelevant, oldUncertain];
    const before = await query('SELECT id,ai_result,created_at FROM records WHERE tenant_id=$1 ORDER BY id', [tenantId]);
    const initial = await list();
    await query(`UPDATE records SET manual_overrides=manual_overrides || $1::jsonb WHERE tenant_id=$2 AND id=ANY($3::uuid[])`,
    [{triage_admission: {value: 'included', reason: '哨兵准入规则调整，用户指定纳入'}}, tenantId, designated]);
    for (const id of designated) fixtures.get(id).admitted = true;
    const result = await list();
    assert.equal(result.pagination.total, initial.pagination.total + 2);
    assert.deepEqual(result.records.map(row => row.id).sort(), expected());
    assert.ok(!result.records.some(row => row.id === oldObserved));
    for (const id of designated) {
      const row = result.records.find(row => row.id === id);
      assert.equal(row.triage_status, 'unhandled'); assert.equal(row.triage_display_status, 'unhandled');
    }
    assert.equal((await query('SELECT count(*) AS n FROM record_triage WHERE tenant_id=$1', [tenantId]))[0].n, 0);
    assert.deepEqual(await query('SELECT id,ai_result,created_at FROM records WHERE tenant_id=$1 ORDER BY id', [tenantId]), before);
    t.diagnostic(JSON.stringify({kind: 'sentry-retirement-after-two-overrides', before: initial.pagination.total, after: result.pagination.total,
      increase: 2, triageRowsCreated: 0, otherHistoricalAdmitted: 0}));
  });
});
