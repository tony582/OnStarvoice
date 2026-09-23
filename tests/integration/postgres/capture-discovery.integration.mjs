import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createDiscoveryRepository} from '../../../server/services/capture-discovery/repository.js';
import {createDiscoveryService} from '../../../server/services/capture-discovery/service.js';

test('discovery receipts and candidate ownership against isolated PostgreSQL', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {getDbExecutionSnapshot} = await import('../../../server/db/query.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const repository = createDiscoveryRepository();
  const service = createDiscoveryService({repository});
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;

  async function fixture(st) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [randomUUID()]);
    st.after(async () => {
      for (const table of ['capture_discovery_run_candidates', 'capture_discovery_events', 'capture_discovery_candidates']) {
        await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
      }
      await query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    });
    const [{id: authCodeId}] = await query(`INSERT INTO auth_codes(tenant_id,code) VALUES($1,$2) RETURNING id`, [tenantId, randomUUID()]);
    const [{id: authBindingId}] = await query(`INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id`, [authCodeId, randomUUID()]);
    const [{id: agentId}] = await query(`INSERT INTO capture_agents(tenant_id,auth_code_id,auth_binding_id,client_uuid,
      allowed_platforms,capabilities) VALUES($1,$2,$3,$4,ARRAY['douyin'],$5) RETURNING id`,
    [tenantId, authCodeId, authBindingId, randomUUID(), {agentKind: 'android_mobile', mobileSearchDiscoveryV1: true}]);
    const principal = {tenantId, authCodeId, authBindingId, agentId};
    const requestHash = 'a'.repeat(64);
    const [{id: taskId}] = await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,
      platform,status,metadata) VALUES($1,$2,$2,'douyin','running',$3) RETURNING id`,
    [tenantId, agentId, {workflow: 'douyin_mobile_discovery', deadlineAt: new Date(Date.now() + 600_000).toISOString()}]);
    const [{id: itemId}] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,platform,
      status,keyword,assigned_agent_id,execution_task_id,assignment_revision,request_hash,attempt_count)
      VALUES($1,$2,'kw-1','douyin','running','别克壁纸',$3,$2,1,$4,1) RETURNING id`,
    [tenantId, taskId, agentId, requestHash]);
    const [{id: attemptId}] = await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,
      execution_task_id,agent_id,assignment_revision,request_hash,status) VALUES($1,$2,$3,$3,$4,1,$5,'running') RETURNING id`,
    [tenantId, itemId, taskId, agentId, requestHash]);
    const event = {eventId: randomUUID(), discoveryRunId: taskId, taskId, itemId, attemptId,
      agentId, requestHash, assignmentRevision: 1, keyword: '别克壁纸', verification: 'verified',
      discoveredAt: new Date().toISOString(), rawShareUrl: 'https://www.douyin.com/video/7654321098765432109'};
    const batch = {uploadBatchId: randomUUID(), events: [event]};
    const ingest = (overrides = {}, target = service) => target.ingestBatch({principal,
      batch: {...batch, uploadBatchId: overrides.eventId && overrides.eventId !== event.eventId
        ? randomUUID() : batch.uploadBatchId, events: [{...event, ...overrides}]}});
    const rows = table => query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    return {principal, event, batch, ingest, rows, tenantId, taskId, itemId, agentId};
  }

  await t.test('receipt, candidate, run demand are durable with no task or record created', async st => {
    const f = await fixture(st);
    const {receipts: [r]} = await f.ingest();
    assert.equal(r.status, 'accepted');
    assert.equal(r.candidateStatus, 'queued');
    assert.equal((await f.rows('capture_discovery_candidates')).length, 1);
    const [demand] = await f.rows('capture_discovery_run_candidates');
    assert.equal(demand.demand_status, 'active');
    assert.equal(demand.is_detail_owner, false);
    assert.equal(demand.detail_task_item_id, null);
    assert.equal((await f.rows('records')).length, 0);
    assert.equal((await f.rows('capture_tasks')).length, 1);
    assert.deepEqual((await service.getReceipts({principal: f.principal, uploadBatchId: f.batch.uploadBatchId})).receipts, [r]);
  });

  await t.test('concurrent replay and distinct discoveries deduplicate without replacing provenance', async st => {
    const f = await fixture(st);
    const [a, b] = await Promise.all([f.ingest(), f.ingest()]);
    assert.deepEqual([a.receipts[0].status, b.receipts[0].status].sort(), ['accepted', 'duplicate']);
    assert.equal(a.receipts[0].receiptId, b.receipts[0].receiptId);
    await Promise.all([f.ingest({eventId: randomUUID()}), f.ingest({eventId: randomUUID()})]);
    assert.equal((await f.rows('capture_discovery_events')).length, 3);
    assert.equal((await f.rows('capture_discovery_candidates')).length, 1);
    assert.equal((await f.rows('capture_discovery_run_candidates')).length, 1);
  });

  await t.test('first durable receipt freezes batch membership even across concurrent requests', async st => {
    const f = await fixture(st);
    const changed = {...f.batch, events: [{...f.event, eventId: randomUUID()}]};
    const results = await Promise.allSettled([
      service.ingestBatch({principal: f.principal, batch: f.batch}),
      service.ingestBatch({principal: f.principal, batch: changed}),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BATCH_PAYLOAD_CONFLICT');
    const known = await service.getReceipts({principal: f.principal, uploadBatchId: f.batch.uploadBatchId});
    assert.equal(known.receipts.length, 1);
    assert.equal((await f.rows('capture_discovery_events')).length, 1);
  });

  await t.test('partially accepted frozen batches replay exactly; regrouping cannot hide receipts', async st => {
    const f = await fixture(st);
    const second = {...f.event, eventId: randomUUID(), rawShareUrl: 'https://www.douyin.com/video/7654321098765432110'};
    const batch = {...f.batch, events: [f.event, second]};
    const failing = createDiscoveryService({repository: {transaction(callback) {
      return repository.transaction(tx => callback({...tx, saveEvent: async (principal, event, ...rest) => {
        if (event.eventId === second.eventId) throw new Error('injected second-event failure');
        return tx.saveEvent(principal, event, ...rest);
      }}));
    }}});
    await assert.rejects(failing.ingestBatch({principal: f.principal, batch}), /second-event failure/);
    assert.equal((await service.getReceipts({principal: f.principal, uploadBatchId: batch.uploadBatchId})).receipts.length, 1);
    await assert.rejects(service.ingestBatch({principal: f.principal, batch: {...batch, events: [f.event]}}),
      {code: 'BATCH_PAYLOAD_CONFLICT', status: 409});
    await assert.rejects(service.ingestBatch({principal: f.principal,
      batch: {...batch, events: [f.event, {...second, titleHint: 'mutated while not yet committed'}]}}),
    {code: 'BATCH_PAYLOAD_CONFLICT', status: 409});
    await assert.rejects(service.ingestBatch({principal: f.principal,
      batch: {uploadBatchId: randomUUID(), events: [f.event]}}), {code: 'EVENT_BATCH_CONFLICT', status: 409});
    const replay = await service.ingestBatch({principal: f.principal, batch});
    assert.deepEqual(replay.receipts.map(receipt => receipt.status), ['duplicate', 'accepted']);
    const known = await service.getReceipts({principal: f.principal, uploadBatchId: batch.uploadBatchId});
    assert.equal(known.receipts.length, 2);
    assert.equal((await f.rows('capture_discovery_events')).length, 2);
  });

  await t.test('payload conflict cannot replace evidence, and accepted replay survives task completion', async st => {
    const f = await fixture(st);
    const original = (await f.ingest()).receipts[0];
    await assert.rejects(f.ingest({titleHint: 'changed'}), {code: 'EVENT_PAYLOAD_CONFLICT', status: 409});
    await query("UPDATE capture_tasks SET status='completed' WHERE id=$1", [f.taskId]);
    const duplicate = (await f.ingest()).receipts[0];
    assert.deepEqual(duplicate, {...original, status: 'duplicate'});
    assert.equal((await f.rows('capture_discovery_events'))[0].title_hint, '');
  });

  await t.test('old real attempt is audit only; invented attempt and foreign tenant are rejected', async st => {
    const f = await fixture(st);
    await query('UPDATE capture_task_items SET assignment_revision=2,attempt_count=2 WHERE id=$1', [f.itemId]);
    const receipt = (await f.ingest()).receipts[0];
    assert.equal(receipt.deliveryMode, 'late_audit');
    assert.equal(receipt.candidateId, null);
    assert.equal((await f.rows('capture_discovery_candidates')).length, 0);
    await assert.rejects(f.ingest({eventId: randomUUID(), attemptId: randomUUID()}), {code: 'ATTEMPT_LINEAGE_MISMATCH'});
    await assert.rejects(service.ingestBatch({principal: {...f.principal, tenantId: randomUUID()}, batch: f.batch}),
      {code: 'MOBILE_AGENT_NOT_AUTHORIZED'});
  });

  await t.test('stop intent and deadline block new candidate work without erasing evidence', async st => {
    const f = await fixture(st);
    await query(`UPDATE capture_tasks SET metadata=metadata||$2::jsonb WHERE id=$1`,
      [f.taskId, {stopCommandId: randomUUID()}]);
    assert.equal((await f.ingest()).receipts[0].deliveryMode, 'late_audit');
    await query(`UPDATE capture_tasks SET metadata=(metadata-'stopCommandId')||$2::jsonb WHERE id=$1`,
      [f.taskId, {deadlineAt: '2000-01-01T00:00:00Z'}]);
    assert.equal((await f.ingest({eventId: randomUUID()})).receipts[0].deliveryMode, 'late_audit');
    assert.equal((await f.rows('capture_discovery_run_candidates')).length, 0);
    assert.equal((await f.rows('capture_discovery_events')).length, 2);
  });

  await t.test('unverified clipboard and mismatched IDs stay reviewable; network resolves outside locks', async st => {
    const f = await fixture(st);
    assert.equal((await f.ingest({verification: 'link_unverified'})).receipts[0].candidateId, null);
    assert.equal((await f.ingest({eventId: randomUUID(), verifiedExternalId: '7000000000000000001'})).receipts[0].reason,
      'work_identity_mismatch');
    const resolverService = createDiscoveryService({repository, resolveShareUrl: async () => {
      assert.equal(getDbExecutionSnapshot().categories.general.active, 0);
      return f.event.rawShareUrl;
    }});
    assert.equal((await f.ingest({eventId: randomUUID(), rawShareUrl: 'https://v.douyin.com/Abcd/'}, resolverService))
      .receipts[0].candidateStatus, 'queued');
  });

  await t.test('a stop arriving during URL resolution wins before candidate persistence', async st => {
    const f = await fixture(st);
    let calls = 0;
    const resolverService = createDiscoveryService({repository, resolveShareUrl: async () => {
      calls += 1;
      await query(`UPDATE capture_tasks SET metadata=metadata||$2::jsonb WHERE id=$1`,
        [f.taskId, {stopCommandId: randomUUID()}]);
      return f.event.rawShareUrl;
    }});
    const input = {rawShareUrl: 'https://v.douyin.com/Stopped/'};
    assert.equal((await f.ingest(input, resolverService)).receipts[0].deliveryMode, 'late_audit');
    assert.equal((await f.ingest(input, resolverService)).receipts[0].status, 'duplicate');
    assert.equal(calls, 1, 'exact replay never retries network resolution');
    assert.equal((await f.rows('capture_discovery_candidates')).length, 0);
  });

  await t.test('same visible work remains separate across tenants and filtered records are not reinstated', async st => {
    const f = await fixture(st);
    const other = await fixture(st);
    const [record] = await query(`INSERT INTO records(tenant_id,platform,external_id,business_visibility)
      VALUES($1,'douyin','7654321098765432109','filtered_out') RETURNING id`, [f.tenantId]);
    const a = (await f.ingest()).receipts[0];
    const b = (await other.ingest()).receipts[0];
    assert.equal(a.recordId, record.id);
    assert.equal(a.recordVisibility, 'filtered_out');
    assert.equal(a.candidateStatus, 'already_exists');
    assert.equal(b.recordId, null);
    assert.notEqual(a.candidateId, b.candidateId);
    assert.equal((await f.rows('records'))[0].business_visibility, 'filtered_out');
    assert.equal((await f.rows('capture_discovery_run_candidates'))[0].demand_status, 'needs_action');
    assert.deepEqual((await service.getReceipts({principal: other.principal, uploadBatchId: f.batch.uploadBatchId})).receipts, []);
  });

  await t.test('later discoveries converge the same run to an externally stored record without reopening canceled demand', async st => {
    const f = await fixture(st);
    const first = (await f.ingest()).receipts[0];
    const [record] = await query(`INSERT INTO records(tenant_id,platform,external_id)
      VALUES($1,'douyin','7654321098765432109') RETURNING id`, [f.tenantId]);
    const second = (await f.ingest({eventId: randomUUID()})).receipts[0];
    assert.equal(second.candidateStatus, 'already_exists');
    let [demand] = await f.rows('capture_discovery_run_candidates');
    assert.equal(demand.record_id, record.id);
    assert.equal(demand.demand_status, 'fulfilled');
    assert.equal(demand.first_event_id, first.receiptId);
    await query("UPDATE capture_discovery_run_candidates SET demand_status='canceled' WHERE tenant_id=$1", [f.tenantId]);
    await f.ingest({eventId: randomUUID()});
    [demand] = await f.rows('capture_discovery_run_candidates');
    assert.equal(demand.demand_status, 'canceled');
    assert.equal(demand.first_event_id, first.receiptId);
  });

  await t.test('deleting a formal record clears stale stored markers on the next discovery', async st => {
    const f = await fixture(st);
    const [record] = await query(`INSERT INTO records(tenant_id,platform,external_id)
      VALUES($1,'douyin','7654321098765432109') RETURNING id`, [f.tenantId]);
    assert.equal((await f.ingest()).receipts[0].candidateStatus, 'already_exists');
    await query('DELETE FROM records WHERE id=$1', [record.id]);
    const receipt = (await f.ingest({eventId: randomUUID()})).receipts[0];
    assert.equal(receipt.candidateStatus, 'queued');
    assert.equal(receipt.recordId, null);
    const [candidate] = await f.rows('capture_discovery_candidates');
    const [demand] = await f.rows('capture_discovery_run_candidates');
    assert.equal(candidate.record_id, null);
    assert.equal(candidate.status, 'queued');
    assert.equal(demand.record_id, null);
    assert.equal(demand.demand_status, 'active');
  });

  await t.test('failed association rolls back event, receipt and candidate together', async st => {
    const f = await fixture(st);
    const failingService = createDiscoveryService({repository: {transaction(callback) {
      return repository.transaction(tx => callback({...tx, linkDemand: async () => {throw new Error('injected write failure');}}));
    }}});
    await assert.rejects(f.ingest({}, failingService), /injected write failure/);
    assert.equal((await f.rows('capture_discovery_candidates')).length, 0);
    assert.equal((await f.rows('capture_discovery_events')).length, 0);
  });

  await t.test('revoked binding and browser-only capability cannot ingest or inspect receipts', async st => {
    const f = await fixture(st);
    await f.ingest();
    await assert.rejects(service.getReceipts({principal: {...f.principal, authBindingId: randomUUID()},
      uploadBatchId: f.batch.uploadBatchId}), {code: 'MOBILE_AGENT_NOT_AUTHORIZED'});
    await query("UPDATE capture_agents SET capabilities='{}'::jsonb WHERE id=$1", [f.agentId]);
    await assert.rejects(service.getReceipts({principal: f.principal, uploadBatchId: f.batch.uploadBatchId}),
      {code: 'MOBILE_AGENT_NOT_AUTHORIZED'});
    await assert.rejects(f.ingest(), {code: 'MOBILE_AGENT_NOT_AUTHORIZED'});
  });
});
