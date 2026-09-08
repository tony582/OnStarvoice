import assert from 'node:assert/strict';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('negative patrol SQL honors current sentiment, Shanghai dates and selected-record revalidation', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {
    normalizeNegativePatrolFilter,
    __negativePatrolRouteInternals: {loadCandidates},
  } = await import('../../../server/routes/negative-patrol.js');
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`Negative patrol SQL ${Date.now()} ${process.pid}`],
  )).rows[0];
  t.after(async () => {
    try { await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]); }
    finally { await closePool(); }
  });
  const fixtures = [
    {key: 'base-negative'},
    {key: 'manual-neutral', overrides: {sentiment: {value: 'neutral'}}},
    {key: 'manual-positive', overrides: {sentiment: 'positive'}},
    {key: 'manual-negative', sentiment: 'neutral', overrides: {sentiment: {value: 'negative'}}, staleAi: true},
    {key: 'manual-string', sentiment: 'positive', overrides: {sentiment: 'negative'}},
    {key: 'manual-invalid', overrides: {sentiment: {value: 'invalid'}}},
    {key: 'manual-irrelevant', overrides: {sentiment: 'negative', relevance: {value: 'irrelevant'}}},
    {key: 'at-start', published: '2026-09-06T16:00:00.000Z'},
    {key: 'before-start', published: '2026-09-06T15:59:59.999Z'},
    {key: 'at-end', published: '2026-09-07T16:00:00.000Z'},
  ];
  const ids = new Map();
  for (const fixture of fixtures) {
    const row = (await pool.query(`
      INSERT INTO records (
        tenant_id, external_id, platform, title, sentiment,
        manual_overrides, publish_time, published_ts, business_visibility, ai_result
      ) VALUES ($1, $2, 'douyin', $2, $3, $4::jsonb, '2026-09-07', $5,
        'eligible', $6::jsonb)
      RETURNING id
    `, [
      tenant.id, fixture.key, fixture.sentiment || 'negative',
      JSON.stringify(fixture.overrides || {}),
      fixture.published || '2026-09-07T04:00:00.000Z',
      JSON.stringify(fixture.staleAi ? {relevance: 'irrelevant'} : {}),
    ])).rows[0];
    ids.set(fixture.key, row.id);
  }
  const filter = normalizeNegativePatrolFilter({
    publishDateFrom: '2026-09-07', publishDateTo: '2026-09-07',
    platform: 'douyin', pageSize: 100,
  }).filter;
  const preview = await withTransaction(tx => loadCandidates(tx, tenant.id, filter));
  assert.deepEqual(
    preview.rows.filter(row => row.can_dispatch).map(row => row.external_id).sort(),
    ['at-start', 'base-negative', 'manual-negative', 'manual-string'],
  );
  assert.equal(preview.dispatchableCount, 4);
  assert.equal(preview.deferredCount, 2);
  assert.equal(preview.rows.find(row => row.external_id === 'manual-invalid').eligibility_code,
    'manual_sentiment_invalid');
  assert.equal(preview.rows.find(row => row.external_id === 'manual-irrelevant').eligibility_code,
    'manual_irrelevant');

  // A customer edit after preview must be visible to the exact selected-ID query.
  await pool.query(`UPDATE records SET manual_overrides = '{"sentiment":"neutral"}'
    WHERE id = $1`, [ids.get('base-negative')]);
  const selected = await withTransaction(tx => loadCandidates(tx, tenant.id, filter, {
    recordIds: [ids.get('base-negative'), ids.get('manual-negative')],
    lock: true, includeTotal: false,
  }));
  assert.deepEqual(selected.rows.map(row => row.external_id), ['manual-negative']);

  // Exercise the real stable cursor against 100 candidates with equal timestamps.
  await pool.query(`
    INSERT INTO records (tenant_id, external_id, platform, title, sentiment,
      publish_time, published_ts, business_visibility)
    SELECT $1, 'page-' || n, 'douyin', 'pagination-fixture', 'negative',
      '2026-09-07', '2026-09-07T04:00:00Z'::timestamptz, 'eligible'
    FROM generate_series(1, 100) n
  `, [tenant.id]);
  const firstFilter = {...filter, query: 'pagination-fixture', pageSize: 50};
  const first = await withTransaction(tx => loadCandidates(tx, tenant.id, firstFilter));
  const nextFilter = normalizeNegativePatrolFilter({
    publishDateFrom: '2026-09-07', publishDateTo: '2026-09-07',
    platform: 'douyin', query: 'pagination-fixture', pageSize: 50,
    cursor: first.nextCursor,
  }).filter;
  const second = await withTransaction(tx => loadCandidates(tx, tenant.id, nextFilter));
  assert.equal(first.total, 100);
  assert.equal(first.rows.length, 50);
  assert.equal(second.rows.length, 50);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 100);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});
