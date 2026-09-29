import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// One reporting slot makes "the database is busy" a fact the test controls:
// while a slow reporting read holds the slot, every other reporting read
// waits and then meets the same capacity error production meets.
const settings = {
  PG_POOL_MAX: '5',
  PG_DATABASE_INSTANCE_COUNT: '1',
  PG_CRITICAL_CONCURRENCY: '1',
  PG_GENERAL_CONCURRENCY: '3',
  PG_REPORTING_CONCURRENCY: '1',
};

test('the task board, the sidebar counts and the content list stay usable while reporting reads are saturated', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  // Import after setting the budget: query.js creates its category gates once.
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {getDbExecutionSnapshot} = await import('../../../server/db/query.js');
  const {queryTriageOne} = await import('../../../server/services/record-triage-query.js');
  const {createApp} = await import('../../../server/app.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
  const {
    CAPTURE_OVERVIEW_LAST_GOOD_MAX_AGE_MS,
    clearCaptureOverviewProjectionCache,
    readLastGoodCaptureOverviewProjection,
  } = await import('../../../server/routes/capture-cloud.js');
  const {clearWorkspaceBadgesCache} = await import('../../../server/routes/workspace.js');

  await runMigrations();
  assert.equal(getDbExecutionSnapshot().budget.reporting, 1);
  const pool = getPool();

  // Every statement the server sends in this process, with its parameters:
  // "did it run" is then a fact instead of an inference from timing.
  const pg = createRequire(new URL('../../../server/package.json', import.meta.url))('pg');
  const sendQuery = pg.Client.prototype.query;
  const sent = [];
  pg.Client.prototype.query = function recordedQuery(...args) {
    if (typeof args[0] === 'string') sent.push({text: args[0], values: Array.isArray(args[1]) ? args[1] : []});
    return sendQuery.apply(this, args);
  };
  t.after(() => { pg.Client.prototype.query = sendQuery; });
  const sentWith = needle => sent.filter(query => query.text.includes(needle)
    || query.values.some(value => typeof value === 'string' && value.includes(needle)));
  const tenants = [];
  const users = [];
  const held = [];
  let server;
  t.after(async () => {
    await Promise.allSettled(held);
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  for (let index = 0; index < 2; index += 1) {
    tenants.push((await pool.query(
      'INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Dashboard load ${randomUUID()}`],
    )).rows[0].id);
  }
  const [tenant, quietTenant] = tenants;

  const recordIds = [];
  async function record(index, {status = null, sentiment = 'neutral'} = {}) {
    const id = randomUUID();
    const publishedAt = new Date(Date.UTC(2026, 8, 1 + index, 4)).toISOString();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,record_type,
        created_at,first_seen_at,last_seen_at,published_ts,business_visibility,ai_result,sentiment)
      VALUES($1,$2,'douyin',$3,$3,'keyword_notes',$4,$4,$4,$4,'eligible','{"relevance":"relevant"}',$5)`,
    [id, tenant, `load-${String(index).padStart(2, '0')}`, publishedAt, sentiment]);
    if (status) {
      await pool.query('INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)', [tenant, id, status]);
    }
    recordIds.push(id);
    return id;
  }
  // Newest first is load-06 .. load-00. Four are waiting, three were handled.
  for (let index = 0; index < 7; index += 1) {
    await record(index, {
      status: index % 2 === 1 ? 'reviewed' : null,
      sentiment: index < 2 ? 'negative' : 'neutral',
    });
  }
  const newestFirst = [...recordIds].reverse();

  const email = `dashboard-load-${randomUUID()}@integration.invalid`;
  const user = (await pool.query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password)
    VALUES($1,'Dashboard load',$2,'active',false,'',false) RETURNING id`, [email, hashPassword('dashboard-load-password')])).rows[0].id;
  users.push(user);
  for (const tenantId of tenants) {
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')", [user, tenantId]);
  }
  const task = (await pool.query(`INSERT INTO capture_tasks(tenant_id,task_type,status,title,client_task_id,platform)
    VALUES($1,'capture','failed','看板回退测试',$2,'douyin') RETURNING id`, [tenant, `dashboard-load-${randomUUID()}`])).rows[0].id;

  server = await new Promise(resolve => {
    const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({email, password: 'dashboard-load-password'}),
  });
  assert.equal(login.status, 200);
  const authorization = `Bearer ${(await login.json()).token}`;
  async function get(path, {tenantId = tenant, signal} = {}) {
    const response = await fetch(`${base}/api${path}`, {
      headers: {authorization, 'x-tenant-id': tenantId},
      signal,
    });
    return {status: response.status, headers: response.headers, body: await response.json()};
  }

  // Holds the only reporting slot inside PostgreSQL for `seconds`.
  async function saturateReporting(seconds) {
    const marker = `dashboard_load_hold_${randomUUID().replaceAll('-', '')}`;
    const holding = queryTriageOne(`/* ${marker} */ SELECT pg_sleep($1::double precision), 1 AS held`, [seconds]);
    held.push(holding.catch(() => undefined));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = (await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query LIKE $1 AND state = 'active' AND wait_event = 'PgSleep') AS sleeping`,
      [`%${marker}%`])).rows[0];
      if (state.sleeping) return holding;
      await delay(10);
    }
    throw new Error('the reporting slot was never held inside PostgreSQL');
  }
  async function reportingIdle() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const {active, queued} = getDbExecutionSnapshot().categories.reporting;
      if (active === 0 && queued === 0) return;
      await delay(20);
    }
    assert.fail('reporting reads did not drain');
  }

  await t.test('one statement returns the page and the total of the same filtered posts', async () => {
    const listStatements = () => sent.filter(query => /FROM records r\s+LEFT JOIN record_triage rt/u.test(query.text)).length;
    async function list(query, {statements = 1} = {}) {
      const before = listStatements();
      const result = await get(`/triage/records?${new URLSearchParams({queue: 'triage', sort: 'publish', dir: 'desc', ...query})}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(listStatements() - before, statements, `statements that evaluate the filter for ${JSON.stringify(query)}`);
      return result.body;
    }
    const seen = [];
    for (const [page, expectedCount] of [[1, 3], [2, 3], [3, 1]]) {
      const body = await list({page: String(page), pageSize: '3'});
      assert.deepEqual(body.pagination, {page, pageSize: 3, total: 7, totalPages: 3});
      assert.equal(body.records.length, expectedCount);
      for (const row of body.records) {
        assert.equal('matched_total' in row, false, 'the helper column is not part of the response');
        seen.push(row.id);
      }
    }
    assert.deepEqual(seen, newestFirst, 'pages are consecutive, complete and in the requested order');

    // The only read that evaluates the filter twice: an empty page that is not the first.
    const beyond = await list({page: '4', pageSize: '3'}, {statements: 2});
    assert.deepEqual(beyond.records, []);
    assert.deepEqual(beyond.pagination, {page: 4, pageSize: 3, total: 7, totalPages: 3},
      'an empty page beyond the last still reports the real total');

    const waiting = await list({status: 'unhandled', pageSize: '100'});
    assert.equal(waiting.pagination.total, 4);
    assert.deepEqual(waiting.records.map(row => row.id), newestFirst.filter((_, index) => index % 2 === 0));

    const negative = await list({sentiment: 'negative', pageSize: '1'});
    assert.deepEqual(negative.pagination, {page: 1, pageSize: 1, total: 2, totalPages: 2});
    assert.deepEqual(negative.records.map(row => row.id), [recordIds[1]]);

    const nothing = await list({keyword: `no-such-post-${randomUUID()}`});
    assert.deepEqual(nothing.records, []);
    assert.deepEqual(nothing.pagination, {page: 1, pageSize: 30, total: 0, totalPages: 0});

    const otherTenant = await get(`/triage/records?${new URLSearchParams({queue: 'triage'})}`, {tenantId: quietTenant});
    assert.equal(otherTenant.status, 200);
    assert.equal(otherTenant.body.pagination.total, 0, 'totals never cross tenants');
  });

  await t.test('a saturated database answers the content list with 503 server_busy, never 500', async () => {
    await reportingIdle();
    const holding = saturateReporting(4.5);
    const startedAt = Date.now();
    const busy = await get(`/triage/records?${new URLSearchParams({queue: 'triage'})}`);
    assert.equal(busy.status, 503);
    assert.equal(busy.body.ok, false);
    assert.equal(busy.body.error, 'server_busy');
    assert.equal(busy.body.message, '当前服务暂时繁忙，内容加载失败，请稍后重试。');
    assert.equal(busy.body.retryAfterMs, 3000);
    assert.equal(busy.headers.get('retry-after'), '3');
    assert.ok(Date.now() - startedAt >= 2900, 'the list waited its three seconds for a slot first');
    await (await holding);
    await reportingIdle();
    assert.equal((await get(`/triage/records?${new URLSearchParams({queue: 'triage'})}`)).status, 200);
  });

  await t.test('a read whose client left gives its slot back without running', async () => {
    await reportingIdle();
    const {isClientGoneError} = await import('../../../server/services/display-read-resilience.js');
    await assert.rejects(
      queryTriageOne('SELECT 1 / $1::integer AS never_run', [0], {clientGone: () => true}),
      error => isClientGoneError(error),
      'the statement would have failed with a division by zero had it run',
    );
    assert.equal(getDbExecutionSnapshot().categories.reporting.active, 0);
    assert.deepEqual(await queryTriageOne('SELECT $1::integer AS value', [7], {clientGone: () => false}), {value: 7});
    assert.deepEqual(await queryTriageOne('SELECT $1::integer AS value', [8]), {value: 8});

    // Over HTTP, through a real socket: the browser replaces a list request
    // that is still waiting for its slot. Once the slot frees, the abandoned
    // request takes it and gives it back without sending its statement.
    const abandonedKeyword = `abandoned-${randomUUID()}`;
    const keptKeyword = `kept-${randomUUID()}`;
    const holding = saturateReporting(1.5);
    const controller = new AbortController();
    const abandoned = get(`/triage/records?${new URLSearchParams({queue: 'triage', keyword: abandonedKeyword})}`, {signal: controller.signal});
    const deadline = Date.now() + 1000;
    while (getDbExecutionSnapshot().categories.reporting.queued === 0 && Date.now() < deadline) await delay(10);
    assert.equal(getDbExecutionSnapshot().categories.reporting.queued, 1);
    controller.abort();
    await assert.rejects(abandoned, {name: 'AbortError'});
    // A request that stays is queued behind it and must be served.
    const kept = get(`/triage/records?${new URLSearchParams({queue: 'triage', keyword: keptKeyword})}`);
    await (await holding);
    assert.equal((await kept).status, 200);
    await reportingIdle();
    assert.equal(sentWith(keptKeyword).length, 1, 'the control: a served list read is one recorded statement');
    assert.match(sentWith(keptKeyword)[0].text, /COUNT\(\*\) OVER \(\) AS matched_total/u);
    assert.deepEqual(sentWith(abandonedKeyword), [], 'the abandoned read never reached PostgreSQL');
    const next = await get(`/triage/records?${new URLSearchParams({queue: 'triage'})}`);
    assert.equal(next.status, 200);
    assert.equal(next.body.pagination.total, 7);
  });

  await t.test('sidebar counts are shared, recounted after a write and kept through a busy database', async () => {
    await reportingIdle();
    clearWorkspaceBadgesCache();
    const first = await get('/workspace/badges');
    assert.equal(first.status, 200);
    assert.equal(first.body.badges.triagePending, 4);
    assert.equal('stale' in first.body, false);

    // Another user's write: periodic reads may lag by the cache lifetime.
    await pool.query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [tenant, recordIds[0]]);
    const periodic = await get('/workspace/badges');
    assert.equal(periodic.body.badges.triagePending, 4, 'a periodic read reuses the recent counts');
    // The caller's own write: counted again, and that answer is the shared one.
    const afterWrite = await get('/workspace/badges?fresh=1');
    assert.equal(afterWrite.body.badges.triagePending, 3);
    assert.equal((await get('/workspace/badges')).body.badges.triagePending, 3);
    assert.equal((await get('/workspace/badges', {tenantId: quietTenant})).body.badges.triagePending, 0, 'counts never cross tenants');

    // Five pages asking at once with one reporting slot and nothing cached:
    // they share one count instead of queueing five.
    clearWorkspaceBadgesCache();
    const countsBefore = sentWith('AS triage_pending').length;
    const together = await Promise.all([1, 2, 3, 4, 5].map(() => get('/workspace/badges')));
    assert.deepEqual(together.map(result => result.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(together.map(result => result.body.badges.triagePending), [3, 3, 3, 3, 3]);
    assert.equal(sentWith('AS triage_pending').length - countsBefore, 1);
    await get('/workspace/badges');
    await get('/workspace/badges', {tenantId: quietTenant});
    assert.equal(sentWith('AS triage_pending').length - countsBefore, 2, 'one more for the other tenant, none for the cached one');

    // The page applies the answer to its latest request. A periodic read sent
    // while the recount after a write is still running must carry the recount,
    // not the counts cached before the write.
    await pool.query("UPDATE record_triage SET status='replied' WHERE tenant_id=$1 AND record_id=$2", [tenant, recordIds[0]]);
    await pool.query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [tenant, recordIds[2]]);
    const slowRecount = saturateReporting(1.2);
    const afterOwnWrite = get('/workspace/badges?fresh=1');
    const queuedDeadline = Date.now() + 1000;
    while (getDbExecutionSnapshot().categories.reporting.queued === 0 && Date.now() < queuedDeadline) await delay(10);
    const periodicDuringRecount = await get('/workspace/badges');
    assert.equal(periodicDuringRecount.body.badges.triagePending, 2, 'joined the recount instead of answering 3 from the cache');
    assert.equal((await afterOwnWrite).body.badges.triagePending, 2);
    await (await slowRecount);
    await reportingIdle();
    await pool.query('DELETE FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenant, recordIds[2]]);
    await pool.query("UPDATE record_triage SET status='reviewed' WHERE tenant_id=$1 AND record_id=$2", [tenant, recordIds[0]]);
    assert.equal((await get('/workspace/badges?fresh=1')).body.badges.triagePending, 3);

    await pool.query("UPDATE record_triage SET status='unhandled' WHERE tenant_id=$1 AND record_id=$2", [tenant, recordIds[0]]);
    const holding = saturateReporting(4.5);
    const stale = await get('/workspace/badges?fresh=1');
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.badges.triagePending, 3, 'the last complete counts, marked as such');
    assert.ok(stale.body.staleAgeMs >= 0);
    await (await holding);
    await reportingIdle();
    const recovered = await get('/workspace/badges?fresh=1');
    assert.equal('stale' in recovered.body, false);
    assert.equal(recovered.body.badges.triagePending, 4);

    // No counts to fall back to: the failure stays visible to the caller.
    clearWorkspaceBadgesCache();
    const holdingAgain = saturateReporting(4.5);
    const failed = await get('/workspace/badges');
    assert.equal(failed.status, 500);
    await (await holdingAgain);
    await reportingIdle();
  });

  await t.test('the task board serves its last complete projection, marked, while reads are saturated', async () => {
    await reportingIdle();
    clearCaptureOverviewProjectionCache({includeLastGood: true});
    assert.equal(CAPTURE_OVERVIEW_LAST_GOOD_MAX_AGE_MS, 90_000);

    // Nothing to fall back to yet: 503 with the message operators know.
    let holding = saturateReporting(2.5);
    const startedAt = Date.now();
    const busy = await get('/capture-cloud/overview');
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.body, {
      ok: false,
      error: 'server_busy',
      message: '任务看板查询繁忙，请稍后重试',
      retryAfterMs: 1500,
    });
    assert.equal(busy.headers.get('retry-after'), '2');
    assert.ok(Date.now() - startedAt >= 1400, 'the board waits a second and a half for a slot, not a quarter second');
    await (await holding);
    await reportingIdle();

    const fresh = await get('/capture-cloud/overview');
    assert.equal(fresh.status, 200);
    assert.equal('stale' in fresh.body, false);
    assert.deepEqual(fresh.body.tasks.map(row => row.id), [task]);
    assert.equal(fresh.body.summary.attentionTasks, 1);
    assert.ok(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100}));

    // The one-second cache has expired and a writer asked for fresh data.
    await pool.query("UPDATE capture_tasks SET status='canceled', finished_at=now() WHERE id=$1", [task]);
    clearCaptureOverviewProjectionCache();
    await delay(1100);
    holding = saturateReporting(2.5);
    // Both tenants ask while the slot is held; both give up after 1.5 seconds.
    const [stale, otherTenant] = await Promise.all([
      get('/capture-cloud/overview'),
      get('/capture-cloud/overview', {tenantId: quietTenant}),
    ]);
    assert.equal(stale.status, 200);
    assert.equal(stale.body.ok, true);
    assert.equal(stale.body.stale, true);
    assert.ok(stale.body.staleAgeMs >= 1000 && stale.body.staleAgeMs < CAPTURE_OVERVIEW_LAST_GOOD_MAX_AGE_MS);
    assert.equal(stale.body.retryAfterMs, 1500);
    assert.equal(stale.headers.get('retry-after'), '2');
    assert.equal(stale.body.tasks.find(row => row.id === task)?.status, 'failed', 'the last complete projection, not an invented one');
    assert.equal(stale.body.summary.attentionTasks, 1);

    assert.equal(otherTenant.status, 503, 'a tenant never receives another tenant\'s projection');
    assert.equal(otherTenant.body.error, 'server_busy');
    await (await holding);
    await reportingIdle();

    const recovered = await get('/capture-cloud/overview');
    assert.equal(recovered.status, 200);
    assert.equal('stale' in recovered.body, false);
    assert.equal(recovered.body.tasks.find(row => row.id === task)?.status, 'canceled');
    assert.equal(recovered.body.summary.attentionTasks, 0);
  });
});
