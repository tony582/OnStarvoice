import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('triage reads isolate reporting capacity and transaction settings from ordinary database work', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const settings = {PG_POOL_MAX: '3', PG_DATABASE_INSTANCE_COUNT: '1', PG_CRITICAL_CONCURRENCY: '1', PG_GENERAL_CONCURRENCY: '1', PG_REPORTING_CONCURRENCY: '1'};
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  // Import after setting the budget: query.js creates its category gates once.
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {queryOne, getDbExecutionSnapshot} = await import('../../../server/db/query.js');
  const {queryTriageAll, queryTriageOne} = await import('../../../server/services/record-triage-query.js');
  t.after(async () => {
    await closePool();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  assert.deepEqual(getDbExecutionSnapshot().budget, {processMax: 3, critical: 1, general: 1, reporting: 1});
  const pool = getPool();
  const sessionSql = `SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS read_only,
    current_setting('jit') AS jit, current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout`;
  // A known session setting makes SET LOCAL leakage observable, even when the
  // database's own default has JIT disabled. The single idle client is reused.
  const initialClient = await pool.connect();
  let baseline;
  try {
    await initialClient.query("SET jit = 'on'");
    baseline = (await initialClient.query(sessionSql)).rows[0];
  } finally { initialClient.release(); }
  assert.equal(baseline.read_only, 'off');
  assert.equal(baseline.jit, 'on');

  await t.test('parameterized all/one reads retain row counts and enable only transaction-local safeguards', async () => {
    const literal = "中文 ' quoted $1 ; SELECT 999 --";
    const rows = await queryTriageAll(`SELECT value, label FROM (VALUES ($1::integer, $2::text), ($3::integer, $4::text)) AS fixture(value, label)
      WHERE value >= $5::integer ORDER BY value`, [3, literal, 7, '第二条', 3]);
    assert.deepEqual(rows, [{value: 3, label: literal}, {value: 7, label: '第二条'}]);
    assert.deepEqual(await queryTriageOne('SELECT $1::integer AS total, $2::text AS label', [10, literal]), {total: 10, label: literal});
    assert.deepEqual(await queryTriageAll('SELECT 1 WHERE false'), []);
    assert.equal(await queryTriageOne('SELECT 1 WHERE false'), null);
    const scoped = await queryTriageOne(sessionSql);
    assert.deepEqual(scoped, {pid: baseline.pid, read_only: 'on', jit: 'off', statement_timeout: '10s', lock_timeout: '500ms'});
    assert.deepEqual(await queryOne(sessionSql), baseline, 'COMMIT restores all settings on the very same pooled connection');
    assert.equal(getDbExecutionSnapshot().categories.reporting.active, 0);
  });

  await t.test('SQL errors roll back the same connection and release the reporting slot', async () => {
    await assert.rejects(queryTriageOne('SELECT 1 / $1::integer AS invalid', [0]), {code: '22012'});
    const after = await queryOne(sessionSql);
    assert.deepEqual(after, baseline, 'a reused connection is neither in an aborted transaction nor left with JIT off/read-only settings');
    assert.equal(getDbExecutionSnapshot().categories.reporting.active, 0);
    assert.equal(getDbExecutionSnapshot().categories.reporting.queued, 0);
    assert.deepEqual(await queryTriageOne('SELECT $1::integer AS recovered', [42]), {recovered: 42});
    assert.deepEqual(await queryOne(sessionSql), baseline);
  });

  await t.test('a slow reporting read and a queued triage read leave general SELECT capacity available', async () => {
    let slowFinished = false;
    const slow = queryTriageOne('/* triage_reporting_slow_integration */ SELECT pg_sleep($1::double precision), 11 AS result', [2])
      .finally(() => { slowFinished = true; });
    // Settle every promise even if an assertion fails, so no query survives the
    // test or races the pool cleanup.
    const pending = [slow];
    try {
      const deadline = Date.now() + 1000;
      let sleeping = false;
      while (Date.now() < deadline && !slowFinished) {
        const state = await queryOne(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query LIKE '%triage_reporting_slow_integration%'
            AND state = 'active' AND wait_event = 'PgSleep') AS sleeping`);
        if (state.sleeping) { sleeping = true; break; }
        await delay(10);
      }
      assert.equal(sleeping, true, 'the reporting query is actually sleeping in PostgreSQL, not merely scheduled in JavaScript');
      const queued = queryTriageOne('SELECT $1::text AS queued_result', ['after-slow']);
      pending.push(queued);
      const during = getDbExecutionSnapshot();
      assert.equal(during.categories.reporting.active, 1);
      assert.equal(during.categories.reporting.queued, 1);
      assert.equal(during.categories.general.active, 0);
      const ordinary = await queryOne('SELECT $1::text AS ordinary_result, current_setting(\'transaction_read_only\') AS read_only', ['general-ready']);
      assert.deepEqual(ordinary, {ordinary_result: 'general-ready', read_only: 'off'});
      assert.equal(slowFinished, false, 'general work completes while reporting is occupied');
      assert.equal((await slow).result, 11);
      assert.deepEqual(await queued, {queued_result: 'after-slow'}, 'the helper waits beyond the default reporting gate deadline and resumes normally');
    } finally { await Promise.allSettled(pending); }
    const after = getDbExecutionSnapshot();
    for (const category of ['reporting', 'general']) {
      assert.equal(after.categories[category].active, 0);
      assert.equal(after.categories[category].queued, 0);
    }
  });
});
