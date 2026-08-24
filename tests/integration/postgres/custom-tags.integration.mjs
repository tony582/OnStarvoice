import assert from 'node:assert/strict';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('batch custom tags add and remove tenant-scoped relationships with per-record audit history', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });

  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {closePool, getPool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {
    applyRecordCustomTagBatch,
    validateCustomTagPatch,
  } = await import('../../../server/services/record-custom-tags.js');

  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query(`
    INSERT INTO tenants (name) VALUES ($1)
    ON CONFLICT (name) DO UPDATE SET status = 'active', updated_at = now()
    RETURNING id
  `, ['Batch Custom Tags Integration Tenant'])).rows[0];
  t.after(async () => {
    try {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    } finally {
      await closePool();
    }
  });

  const records = (await pool.query(`
    INSERT INTO records (tenant_id, external_id, platform, title)
    VALUES
      ($1, 'batch-tag-record-1', 'douyin', 'Batch tag record 1'),
      ($1, 'batch-tag-record-2', 'xiaohongshu', 'Batch tag record 2')
    RETURNING id
  `, [tenant.id])).rows;
  const recordIds = records.map(row => row.id);
  const addPatch = validateCustomTagPatch({addNames: ['晨间重点']});
  assert.equal(addPatch.ok, true);

  const added = await withTransaction(tx => applyRecordCustomTagBatch(tx, {
    tenantId: tenant.id,
    recordIds,
    patch: addPatch,
    actorName: 'Integration Agent',
  }));
  assert.equal(added.operation, 'add');
  assert.deepEqual(added.updatedIds, recordIds);
  assert.equal(added.unchangedIds.length, 0);
  assert.equal(added.limitIds.length, 0);

  const tag = (await pool.query(`
    SELECT id, name FROM custom_tags
    WHERE tenant_id = $1 AND normalized_name = '晨间重点'
  `, [tenant.id])).rows[0];
  assert.equal(tag.name, '晨间重点');
  const afterAdd = await pool.query(`
    SELECT record_id, tag_id FROM record_custom_tags
    WHERE tenant_id = $1 ORDER BY record_id
  `, [tenant.id]);
  assert.equal(afterAdd.rowCount, 2);
  assert.ok(afterAdd.rows.every(row => row.tag_id === tag.id));

  const removePatch = validateCustomTagPatch({removeTagIds: [tag.id]});
  assert.equal(removePatch.ok, true);
  const removed = await withTransaction(tx => applyRecordCustomTagBatch(tx, {
    tenantId: tenant.id,
    recordIds: [recordIds[0]],
    patch: removePatch,
    actorName: 'Integration Agent',
  }));
  assert.equal(removed.operation, 'remove');
  assert.deepEqual(removed.updatedIds, [recordIds[0]]);

  const [remaining, versions, audits] = await Promise.all([
    pool.query(`
      SELECT record_id FROM record_custom_tags
      WHERE tenant_id = $1 AND tag_id = $2
    `, [tenant.id, tag.id]),
    pool.query(`
      SELECT record_id, before_data, after_data FROM record_versions
      WHERE tenant_id = $1 AND changed_fields = ARRAY['custom_tags']::text[]
    `, [tenant.id]),
    pool.query(`
      SELECT target_id, metadata FROM audit_logs
      WHERE tenant_id = $1 AND action = 'record.custom_tags_updated'
    `, [tenant.id]),
  ]);
  assert.deepEqual(remaining.rows.map(row => row.record_id), [recordIds[1]]);
  assert.equal(versions.rowCount, 3);
  assert.equal(audits.rowCount, 3);
  assert.ok(audits.rows.every(row => row.metadata.batch === true));
});
