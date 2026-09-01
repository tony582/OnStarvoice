import assert from 'node:assert/strict';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {
  redactXhsRecordNavigation,
} from '../../../server/services/xhs-source-open.js';

test('Xiaohongshu API projection keeps a valid saved URL and stable canonical identity', () => {
  const noteId = '6a94c7c3000000002003b809';
  const url = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-token`;
  const projected = redactXhsRecordNavigation({
    platform: 'xiaohongshu',
    external_id: noteId,
    url,
    canonical_url: 'stale-value',
  });
  assert.equal(projected.url, url);
  assert.equal(projected.canonical_url, `https://www.xiaohongshu.com/explore/${noteId}`);
  assert.equal(projected.source_open_mode, 'stored_url');
  assert.equal(projected.source_open_available, true);
});

test('Xiaohongshu upsert preserves the latest complete captured URL separately from canonical identity', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });

  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {closePool, getPool} = await import('../../../server/db/pool.js');
  const {upsertCapturedRecord} = await import('../../../server/services/record-store.js');

  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`XHS Source URL Integration ${Date.now()} ${process.pid}`])).rows[0];
  t.after(async () => {
    try {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    } finally {
      await closePool();
    }
  });

  const noteId = '6a94c7c3000000002003b809';
  const canonicalUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  const firstFullUrl = `${canonicalUrl}?xsec_token=integration-token-first&xsec_source=pc_search`;
  const nextFullUrl = `${canonicalUrl}?xsec_token=integration-token-next&xsec_source=pc_search`;
  const loadRecord = async () => (await pool.query(`
    SELECT id, url, canonical_url, payload, seen_count
    FROM records
    WHERE tenant_id = $1
      AND platform = 'xiaohongshu'
      AND external_id = $2
  `, [tenant.id, noteId])).rows[0];
  const capturedRecord = (detailUrl, {detailStatus = 'done'} = {}) => ({
    external_id: noteId,
    platform: 'xiaohongshu',
    record_type: 'keyword_notes',
    title: 'XHS source URL integration record',
    content: 'Captured content',
    author_name: 'Integration author',
    // The normalizer must prefer the complete URL inside the capture payload
    // over this stable identity URL.
    url: canonicalUrl,
    payload: {
      keyword: 'integration',
      detailCaptureStatus: detailStatus,
      detailCaptureNoteUrl: detailUrl,
      items: [{
        noteId,
        url: detailUrl,
        noteUrl: detailUrl,
      }],
      detailPayload: {
        noteId,
        url: detailUrl,
      },
    },
  });

  const inserted = await upsertCapturedRecord(capturedRecord(firstFullUrl), {
    tenantId: tenant.id,
  });
  assert.equal(inserted.action, 'inserted');
  const afterInsert = await loadRecord();
  assert.equal(afterInsert.url, firstFullUrl);
  assert.equal(afterInsert.canonical_url, canonicalUrl);
  assert.equal(afterInsert.payload.items[0].url, firstFullUrl);

  const repeatedBare = await upsertCapturedRecord(
    capturedRecord(canonicalUrl, {detailStatus: 'not_started'}),
    {tenantId: tenant.id},
  );
  assert.equal(repeatedBare.action, 'updated');
  assert.equal(repeatedBare.id, inserted.id);
  const afterBareRepeat = await loadRecord();
  assert.equal(afterBareRepeat.url, firstFullUrl);
  assert.equal(afterBareRepeat.canonical_url, canonicalUrl);

  const refreshed = await upsertCapturedRecord(capturedRecord(nextFullUrl), {
    tenantId: tenant.id,
  });
  assert.equal(refreshed.action, 'updated');
  assert.equal(refreshed.id, inserted.id);
  const afterRefresh = await loadRecord();
  assert.equal(afterRefresh.url, nextFullUrl);
  assert.equal(afterRefresh.canonical_url, canonicalUrl);
  assert.equal(afterRefresh.payload.items[0].url, nextFullUrl);
  assert.equal(afterRefresh.seen_count, 3);
});
