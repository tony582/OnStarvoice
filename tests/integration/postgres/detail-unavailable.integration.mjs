import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {normalizeRecord} from '../../../server/routes/sync.js';
import {buildSyncInput} from '../../../utils/platform/sync-router.js';
import {upsertCapturedRecord} from '../../../server/services/record-store.js';
import {normalizeDetailAvailability, unavailableDetailPayload} from '../../../utils/capture/detail-availability.js';

test('unavailable keyword detail persists across devices with tenant, timestamp and full-content protection', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool();
  const tenants = [];
  let server;
  t.after(async () => {
    if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    try {await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);} finally {await closePool();}
  });
  const codes = [];
  for (let i = 0; i < 2; i++) {
    const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Unavailable ${randomUUID()}`])).rows[0];
    tenants.push(tenant.id);
    codes.push(`unavailable-${randomUUID()}`);
    await pool.query("INSERT INTO auth_codes(tenant_id,code,type,status,max_bindings) VALUES($1,$2,'permanent','active',10)", [tenant.id, codes[i]]);
  }
  server = await new Promise(resolve => {const s = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(s));});
  const endpoint = `http://127.0.0.1:${server.address().port}/api/sync/captured`;
  const id = '6aa1e9900000000012027610';
  const now = Date.now() - 10000;
  const record = {platform: 'xiaohongshu', external_id: id, record_type: 'keyword_notes',
    title: 'Vo83——你会不会为车联网买单', content: 'Search list excerpt', url: `https://www.xiaohongshu.com/explore/${id}`,
    payload: {items: [{noteId: id, title: 'Vo83——你会不会为车联网买单'}], detailCaptureStatus: 'failed', detailCaptureFailureCode: 'NOTE_CAPTURE_FAILED'}};
  const save = (value, tenantId = tenants[0]) => upsertCapturedRecord(value, {tenantId});
  const load = async () => (await pool.query('SELECT * FROM records WHERE tenant_id=$1 AND external_id=$2', [tenants[0], id])).rows[0];
  const query = async ({code = codes[0], platform = 'xiaohongshu', clientUuid = 'second-device'} = {}) => {
    const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code, clientUuid, platform, externalIds: [id]})});
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body;
  };
  const observation = {platform: 'xiaohongshu', externalId: id, code: 'TARGET_POST_UNAVAILABLE', status: 'page_unavailable',
    observedAt: new Date(now).toISOString(), evidence: ['xhs_unavailable_qr_layout']};

  await save(record);
  assert.deepEqual((await query()).unavailable, [], 'old generic failure must not be automatically reclassified');
  const wireInput = buildSyncInput({type: 'keyword_notes', platform: 'xiaohongshu', payload: unavailableDetailPayload(record.payload, observation)});
  const normalizedRecord = normalizeRecord(wireInput)[0];
  assert.equal(normalizedRecord.external_id, id);
  assert.equal(JSON.parse(normalizedRecord.payload).detailAvailability.externalId, id);
  await save(normalizedRecord);
  let stored = await load();
  assert.equal(stored.content_availability_status, 'page_unavailable');
  assert.equal(stored.payload.items[0].title, record.title);
  const nextDevice = await query();
  assert.equal(nextDevice.unavailable.length, 1);
  assert.ok(normalizeDetailAvailability(nextDevice.unavailable[0], {externalId: id}));
  assert.deepEqual(nextDevice.captured, []);
  assert.deepEqual((await query({code: codes[1]})).unavailable, []);
  assert.deepEqual((await query({platform: 'douyin'})).unavailable, []);
  await save(record); // Another old extension can still upload its generic failure.
  assert.equal((await load()).content_availability_status, 'page_unavailable');
  assert.equal((await query()).unavailable.length, 1);

  const fullPayload = {items: record.payload.items, detailCaptureStatus: 'done', detailCaptureFinishedAt: now + 1000,
    detailPayload: {noteId: id, content: 'Full captured content'}};
  await save({...record, content: 'Full captured content', payload: fullPayload});
  assert.equal((await load()).content_availability_status, 'available');
  assert.deepEqual((await query()).unavailable, []);
  assert.deepEqual((await query()).captured, [id]);
  // A late upload of older unavailable evidence cannot overturn a newer successful capture.
  await save({...record, payload: unavailableDetailPayload(record.payload, observation)});
  assert.equal((await load()).content_availability_status, 'available');
  const deleted = {...observation, status: 'deleted', evidence: ['xhs_deleted_copy'], observedAt: new Date(now + 2000).toISOString()};
  await save({...record, payload: unavailableDetailPayload(record.payload, deleted)});
  stored = await load();
  assert.equal(stored.content_availability_status, 'deleted');
  assert.equal(stored.payload.detailCaptureStatus, 'done', 'deletion must not erase saved full detail');
  assert.equal(stored.payload.detailPayload.content, 'Full captured content');
  const deletedQuery = await query();
  assert.equal(deletedQuery.unavailable[0].status, 'deleted');
  assert.deepEqual(deletedQuery.captured, []);
  assert.deepEqual(deletedQuery.items, []);

  await pool.query("UPDATE records SET content_availability_status='page_unavailable',content_availability_checked_at=now()-interval '25 hours' WHERE id=$1", [stored.id]);
  assert.deepEqual((await query()).unavailable, [], 'temporary web restriction is not cached forever');
  // Unknown evidence and a different target cannot make a row unavailable.
  await save({...record, payload: unavailableDetailPayload(record.payload, {...observation, externalId: 'wrong'})});
  assert.deepEqual((await query()).unavailable, []);
  await save({...record, payload: unavailableDetailPayload(record.payload, {...observation, evidence: ['NOTE_CAPTURE_FAILED']})});
  assert.deepEqual((await query()).unavailable, []);
});
