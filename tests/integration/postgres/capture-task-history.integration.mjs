import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createApp} from '../../../server/app.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {withTransaction} from '../../../server/db/init.js';
import {createSession} from '../../../server/services/auth-service.js';
import {normalizeCloudTaskSnapshot} from '../../../server/services/capture-cloud.js';
import {clearCaptureOverviewProjectionCache, mirrorTaskSnapshot} from '../../../server/routes/capture-cloud.js';

test('task history preserves business roots and clears only terminal visibility with durable results', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool();
  const tenantIds = [];
  const userIds = [];
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    try {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
    } finally {
      await closePool();
    }
  });
  const suffix = randomUUID();
  for (const name of ['A', 'B']) {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [`History ${name} ${suffix}`])).rows[0];
    tenantIds.push(tenant.id);
  }
  const [tenantId, foreignTenantId] = tenantIds;
  const sessions = {};
  for (const role of ['tenant_analyst', 'tenant_viewer']) {
    const user = (await pool.query(`
      INSERT INTO users (email, name, password_hash, must_change_password)
      VALUES ($1, $2, 'integration-only', false) RETURNING id
    `, [`history-${role}-${suffix}@integration.invalid`, role])).rows[0];
    userIds.push(user.id);
    await pool.query(`INSERT INTO user_memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')`, [user.id, tenantId, role]);
    sessions[role] = await createSession(user.id, {headers: {}});
  }
  server = await new Promise((resolve, reject) => {
    const listener = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/capture-cloud`;
  const request = async (path, {body, role = 'tenant_analyst', tenant = tenantId} = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${sessions[role].token}`,
        'X-Tenant-Id': tenant,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const payload = await response.json();
    return {status: response.status, body: payload};
  };
  const task = async ({type = 'capture', status = 'completed', parent = null, metadata = {}, tenant = tenantId, revision = 1, dismissed = false, agent = null, clientId = randomUUID()} = {}) => (await pool.query(`
    INSERT INTO capture_tasks (tenant_id, task_type, status, title, parent_task_id,
      metadata, orchestration_revision, attention_dismissed_at, finished_at,
      origin_agent_id, client_task_id, counts, checkpoint)
    VALUES ($1, $2, $3, $2 || ' ' || $4::text, $5, $6::jsonb, $7,
      CASE WHEN $8 THEN now() ELSE NULL END, now(), $9, $4,
      '{"saved":9999}', '{"rounds":[{"round":1,"status":"completed"}]}')
    RETURNING *
  `, [tenant, type, status, clientId, parent, JSON.stringify(metadata), revision, dismissed, agent])).rows[0];
  const morning = await task({type: 'capture_orchestration', metadata: {orchestrationScheduleRun: true, negativePatrolRun: {windowBasis: 'first_collected_at'}}});
  const revZero = await task({type: 'capture_orchestration', revision: 0});
  const roots = [morning, revZero];
  for (const type of ['unattended_keyword_capture', 'negative_post_patrol', 'watched_content_patrol', 'official_account_comment_patrol', 'followed_creator_post_patrol', 'official_account_post_discovery', 'search_capture', 'capture']) {
    roots.push(await task({type}));
  }
  roots.push(await task({status: 'failed', dismissed: true}));
  const child = await task({type: 'unattended_keyword_capture', parent: morning.id});
  const grandchild = await task({parent: child.id});
  const hidden = [
    child, grandchild,
    await task({type: 'capture_orchestration', metadata: {orchestrationTemplate: true}}),
    await task({type: 'capture_orchestration', revision: 0, metadata: {draft: true}}),
    await task({type: 'unattended_plan_configuration'}),
    await task({type: 'sync'}),
    await task({type: 'detail_sync'}),
    await task({status: 'superseded'}),
    await task({status: 'running'}),
    await task({status: 'needs_action'}),
    await task({status: 'failed'}),
  ];
  const foreign = await task({tenant: foreignTenantId});

  await t.test('NULL optional flags do not hide orchestration runs; history and count agree across types', async () => {
    const previous = (await pool.query(`SELECT NOT (task_type = 'capture_orchestration'
      AND ((orchestration_revision = 0 AND metadata->>'draft' = 'true')
        OR metadata->>'orchestrationTemplate' = 'true')) AS visible
      FROM capture_tasks WHERE id = $1`, [morning.id])).rows[0];
    assert.equal(previous.visible, null, 'reproduce the missing morning run without changing its data');
    const history = await request('/history?pageSize=100');
    assert.equal(history.status, 200);
    assert.deepEqual(new Set(history.body.tasks.map(row => row.id)), new Set(roots.map(row => row.id)));
    assert.equal(history.body.pagination.total, roots.length);
    const overview = await request('/overview?limit=100');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.summary.historyTasks, roots.length);
    assert.ok(overview.body.tasks.some(row => row.id === revZero.id));
    const page = await request('/history?pageSize=2&page=2');
    assert.equal(page.body.tasks.length, 2);
    assert.equal(page.body.pagination.total, roots.length);
    const filtered = await request(`/history?q=${encodeURIComponent(morning.client_task_id)}`);
    assert.deepEqual(filtered.body.tasks.map(row => row.id), [morning.id]);
  });

  const record = (await pool.query(`INSERT INTO records (tenant_id, platform, title) VALUES ($1, 'douyin', 'Durable result') RETURNING id`, [tenantId])).rows[0];
  const unrelatedRecord = (await pool.query(`INSERT INTO records (tenant_id, title) VALUES ($1, 'Unrelated result') RETURNING id`, [tenantId])).rows[0];
  await pool.query(`INSERT INTO record_observations (tenant_id, record_id, capture_task_id)
    VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5), ($1, $6, $7)`, [tenantId, record.id, morning.id, child.id, grandchild.id, unrelatedRecord.id, roots[2].id]);
  await pool.query(`INSERT INTO capture_task_events (tenant_id, task_id, event_type) VALUES ($1, $2, 'history_integration_evidence')`, [tenantId, morning.id]);

  await t.test('all task details use exact persisted observations, including descendants and unique records', async () => {
    const detail = await request(`/tasks/${morning.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.counts.saved, 9999);
    assert.deepEqual(detail.body.task.checkpoint.rounds, [{round: 1, status: 'completed'}]);
    assert.equal(detail.body.resultSummary.observationCount, 3);
    assert.equal(detail.body.resultSummary.recordCount, 1);
    assert.equal(detail.body.resultSummary.evidence, 'linked_record_observations');
    const results = await request(`/tasks/${morning.id}/results?pageSize=1`);
    assert.equal(results.status, 200);
    assert.equal(results.body.total, 1);
    assert.equal(results.body.records[0].id, record.id);
    assert.equal(results.body.records[0].observationCount, 3);
    assert.equal((await request(`/tasks/${morning.id}/results?page=2&pageSize=1`)).body.records.length, 0);
    assert.equal((await request(`/tasks/${foreign.id}`)).status, 404);
    assert.equal((await request(`/tasks/${foreign.id}/results`)).status, 404);
    assert.equal((await request('/tasks/not-a-uuid')).status, 400);
  });

  await t.test('clear requires writer, bounds and same-tenant complete root validation; mixed batches are atomic', async () => {
    assert.equal((await request('/history/clear', {body: {taskIds: [morning.id]}, role: 'tenant_viewer'})).status, 403);
    for (const taskIds of [[], ['not-a-uuid'], Array(101).fill(morning.id)]) {
      assert.equal((await request('/history/clear', {body: {taskIds}})).status, 400);
    }
    assert.equal((await request('/history/clear', {body: {taskIds: [morning.id, foreign.id]}})).status, 404);
    for (const row of hidden) {
      assert.equal((await request('/history/clear', {body: {taskIds: [morning.id, row.id]}})).status, 409, `${row.task_type}/${row.status} must not clear`);
    }
    const untouched = (await pool.query('SELECT metadata FROM capture_tasks WHERE id = $1', [morning.id])).rows[0];
    assert.equal(untouched.metadata.historyClearedAt, undefined);
  });

  await t.test('current work, live children and commands prevent clearing, while recovered historical children do not', async () => {
    const parent = await task({type: 'capture_orchestration'});
    const historical = await task({parent: parent.id, status: 'interrupted'});
    const item = (await pool.query(`INSERT INTO capture_task_items (tenant_id, task_id, item_key, status) VALUES ($1, $2, 'current', 'pending') RETURNING id`, [tenantId, parent.id])).rows[0];
    for (const status of ['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'running', 'retryable', 'needs_action']) {
      await pool.query('UPDATE capture_task_items SET status = $2 WHERE id = $1', [item.id, status]);
      assert.equal((await request('/history/clear', {body: {taskIds: [parent.id]}})).status, 409, status);
    }
    await pool.query("UPDATE capture_task_items SET status = 'completed' WHERE id = $1", [item.id]);
    await pool.query("UPDATE capture_tasks SET status = 'running' WHERE id = $1", [historical.id]);
    assert.equal((await request('/history/clear', {body: {taskIds: [parent.id]}})).status, 409);
    await pool.query("UPDATE capture_tasks SET status = 'needs_action' WHERE id = $1", [historical.id]);
    const agent = (await pool.query(`INSERT INTO capture_agents (tenant_id, client_uuid) VALUES ($1, $2) RETURNING id`, [tenantId, randomUUID()])).rows[0];
    const command = (await pool.query(`INSERT INTO capture_agent_commands (tenant_id, agent_id, task_id, command_type, status, expires_at)
      VALUES ($1, $2, $3, 'stop', 'pending', now() + interval '1 hour') RETURNING id`, [tenantId, agent.id, parent.id])).rows[0];
    assert.equal((await request('/history/clear', {body: {taskIds: [parent.id]}})).status, 409);
    await pool.query("UPDATE capture_agent_commands SET status = 'completed' WHERE id = $1", [command.id]);
    assert.equal((await request('/history/clear', {body: {taskIds: [parent.id]}})).status, 200);
    for (const status of ['needs_action', 'interrupted']) {
      const attentionRoot = await task({status, dismissed: true});
      assert.equal((await request('/history/clear', {body: {taskIds: [attentionRoot.id]}})).status, 409);
    }
  });

  await t.test('clear marks metadata only and preserves idempotent access to task, observations, records and events', async () => {
    const before = (await pool.query('SELECT * FROM capture_tasks WHERE id = $1', [morning.id])).rows[0];
    const countBefore = (await request('/history?pageSize=100')).body.pagination.total;
    assert.ok((await request('/overview?limit=100')).body.tasks.some(row => row.id === morning.id),
      'prime the overview cache before clearing to verify immediate invalidation');
    const clear = await request('/history/clear', {body: {taskIds: [morning.id, morning.id]}});
    assert.equal(clear.status, 200);
    assert.equal(clear.body.clearedCount, 1);
    assert.deepEqual(clear.body.clearedTaskIds, [morning.id]);
    const after = (await pool.query('SELECT * FROM capture_tasks WHERE id = $1', [morning.id])).rows[0];
    assert.ok(after.metadata.historyClearedAt);
    assert.equal(after.metadata.historyClearedBy, userIds[0]);
    const afterWithoutMark = {...after, metadata: {...after.metadata}};
    delete afterWithoutMark.metadata.historyClearedAt;
    delete afterWithoutMark.metadata.historyClearedBy;
    assert.deepEqual(afterWithoutMark, before, 'only the two visibility metadata keys may change');
    const repeated = await request('/history/clear', {body: {taskIds: [morning.id]}});
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body.alreadyClearedTaskIds, [morning.id]);
    assert.equal((await request('/history?pageSize=100')).body.pagination.total, countBefore - 1);
    const overview = await request('/overview?limit=100');
    assert.equal(overview.body.summary.historyTasks, countBefore - 1);
    assert.ok(!overview.body.tasks.some(row => row.id === morning.id));
    assert.equal((await request(`/tasks/${morning.id}`)).body.resultSummary.observationCount, 3);
    assert.equal((await request(`/tasks/${morning.id}/results`)).body.records[0].id, record.id);
    assert.equal((await request(`/tasks/${morning.id}/events`)).body.events.length, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM record_observations WHERE tenant_id = $1', [tenantId])).rows[0].count, 4);
  });

  await t.test('late device mirrors cannot erase or forge history-clear metadata', async () => {
    const agent = (await pool.query(`INSERT INTO capture_agents (tenant_id, client_uuid) VALUES ($1, $2) RETURNING *`, [tenantId, randomUUID()])).rows[0];
    const mirrored = await task({agent: agent.id});
    assert.equal((await request('/history/clear', {body: {taskIds: [mirrored.id]}})).status, 200);
    const before = (await pool.query('SELECT metadata FROM capture_tasks WHERE id = $1', [mirrored.id])).rows[0].metadata;
    const snapshot = normalizeCloudTaskSnapshot({id: mirrored.client_task_id, type: 'capture', status: 'completed', progressSeq: 2,
      updatedAt: new Date(Date.now() + 1000).toISOString(), metadata: {historyClearedAt: 'forged', historyClearedBy: 'forged', deviceProof: 'fresh'}});
    assert.equal(snapshot.metadata.historyClearedAt, undefined);
    const result = await withTransaction(tx => mirrorTaskSnapshot(tx, agent, snapshot));
    assert.equal(result.metadata.historyClearedAt, before.historyClearedAt);
    assert.equal(result.metadata.historyClearedBy, before.historyClearedBy);
    assert.equal(result.metadata.deviceProof, 'fresh');
    await pool.query("UPDATE capture_tasks SET status = 'running' WHERE id = $1", [mirrored.id]);
    clearCaptureOverviewProjectionCache();
    assert.ok((await request('/overview?limit=100')).body.tasks.some(row => row.id === mirrored.id),
      'clearing history must never hide a task that later becomes active');
    assert.equal((await request('/history/clear', {body: {taskIds: [mirrored.id]}})).status, 409);
    const fresh = await withTransaction(tx => mirrorTaskSnapshot(tx, agent, {...snapshot, clientTaskId: randomUUID(), metadata: {historyClearedAt: 'forged'}}));
    assert.equal(fresh.metadata.historyClearedAt, undefined);
  });
});
