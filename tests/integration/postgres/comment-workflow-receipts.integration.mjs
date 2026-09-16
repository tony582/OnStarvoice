import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('comment receipt processing preserves PostgreSQL versions and releases patrol capacity', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {reprocessPendingCommentWorkflowReceipts: processReceipts} = await import('../../../server/services/comment-workflow.js');
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const drain = options => processReceipts({queuedGraceSeconds: 0, ...options});
  const budget = async () => (await pool.query(`SELECT pending_count, pending_bytes
    FROM comment_workflow_capacity_budget WHERE budget_key='global'`)).rows[0];

  async function fixture(st) {
    const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Receipt precision ${randomUUID()}`])).rows[0];
    st.after(() => pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    async function receipt({status = 'queued', timestamp = '2000-01-01T00:00:00.123456Z',
      leaseExpiresAt = null, nextRetryAt = null, retryCount = 0} = {}) {
      const record = (await pool.query(`INSERT INTO records(tenant_id, platform, external_id, title)
        VALUES($1, 'douyin', $2, '评论回执精度测试') RETURNING id`, [tenant.id, randomUUID()])).rows[0];
      return (await pool.query(`INSERT INTO record_observations(
          tenant_id, record_id, platform, payload, comment_workflow_status,
          comment_workflow_expected_count, comment_workflow_updated_at,
          comment_workflow_lease_expires_at, comment_workflow_next_retry_at,
          comment_workflow_retry_count
        ) VALUES($1, $2, 'douyin', $3, $4, 1, $5::timestamptz, $6, $7, $8)
        RETURNING *`, [tenant.id, record.id, JSON.stringify({commentsCleanedItems: [
        {content: '这是需要正常保存的评论内容', authorName: '回归测试用户'},
      ]}), status, timestamp, leaseExpiresAt, nextRetryAt, retryCount])).rows[0];
    }
    const observations = async () => (await pool.query(`SELECT * FROM record_observations
      WHERE tenant_id=$1 ORDER BY id`, [tenant.id])).rows;
    const comments = async () => (await pool.query(`SELECT * FROM record_comments
      WHERE tenant_id=$1 ORDER BY id`, [tenant.id])).rows;
    return {tenant, receipt, observations, comments};
  }

  await t.test('queued, expired-running and retry-due receipts persist with the default pg date parser', async st => {
    const f = await fixture(st);
    const before = await budget();
    const queued = await f.receipt();
    // Exercise the production parser: Date loses microseconds, while the
    // actual database version must survive the SELECT -> conditional UPDATE.
    assert.ok(queued.comment_workflow_updated_at instanceof Date);
    assert.equal(queued.comment_workflow_updated_at.toISOString(), '2000-01-01T00:00:00.123Z');
    await f.receipt({status: 'running', leaseExpiresAt: '2000-01-01T00:05:00Z', retryCount: 1});
    await f.receipt({status: 'failed', nextRetryAt: '2000-01-01T00:05:00Z', retryCount: 2,
      timestamp: '2000-01-01T08:00:00.649821+08:00'});
    await f.receipt({timestamp: '2000-01-01T00:00:00.123000Z'});
    assert.equal((await budget()).pending_count, before.pending_count + 4);
    assert.deepEqual(await drain(), {claimed: 4, persisted: 4, failed: 0});
    const rows = await f.observations();
    assert.ok(rows.every(row => row.comment_workflow_status === 'persisted'
      && row.comment_workflow_processed_count === 1
      && row.comment_workflow_claim_token === null
      && row.comment_workflow_lease_expires_at === null));
    assert.deepEqual(rows.map(row => row.comment_workflow_retry_count).sort(), [1, 1, 2, 3]);
    assert.equal((await f.comments()).length, 4);
    assert.deepEqual(await budget(), before);
    assert.deepEqual(await drain(), {claimed: 0, persisted: 0, failed: 0});
    assert.equal((await f.comments()).length, 4, 'A second drain must not duplicate comments');
  });

  await t.test('active leases, future retries and the queue grace period remain protected', async st => {
    const f = await fixture(st);
    await f.receipt({status: 'running', leaseExpiresAt: '2999-01-01T00:00:00Z'});
    await f.receipt({status: 'failed', nextRetryAt: '2999-01-01T00:00:00Z'});
    await f.receipt({timestamp: new Date().toISOString()});
    const before = await f.observations();
    assert.deepEqual(await drain({queuedGraceSeconds: 300}), {claimed: 0, persisted: 0, failed: 0});
    assert.deepEqual(await f.observations(), before);
    assert.equal((await f.comments()).length, 0);
  });

  await t.test('a newer receipt within the same millisecond fences out the stale candidate', async st => {
    const f = await fixture(st);
    const receipt = await f.receipt();
    const originalQuery = pool.query;
    let advanced = false;
    // All queries still execute on PostgreSQL. Synchronize a competing update
    // after the candidate SELECT, before the worker attempts to claim it.
    pool.query = async function(sql, ...args) {
      const result = await originalQuery.call(this, sql, ...args);
      if (!advanced && typeof sql === 'string' && sql.includes('FROM record_observations observation')
        && result.rows.some(row => row.observation_id === receipt.id)) {
        advanced = true;
        await originalQuery.call(this, `UPDATE record_observations
          SET comment_workflow_updated_at='2000-01-01T00:00:00.123457Z',
            payload=$2 WHERE id=$1`, [receipt.id, JSON.stringify({commentsCleanedItems: [
          {content: '这是更新后应该保存的评论内容', authorName: '回归测试用户'},
        ]})]);
      }
      return result;
    };
    try {
      assert.deepEqual(await drain(), {claimed: 0, persisted: 0, failed: 0});
    } finally {
      pool.query = originalQuery;
    }
    assert.equal(advanced, true, 'The competing database update must have occurred');
    assert.equal((await f.observations())[0].comment_workflow_retry_count, 0);
    assert.equal((await f.comments()).length, 0, 'Stale payload must not be persisted');
    assert.deepEqual(await drain(), {claimed: 1, persisted: 1, failed: 0});
    assert.equal((await f.comments())[0].content, '这是更新后应该保存的评论内容');
  });

  await t.test('backlog recovery retains the 25-receipt batch bound', async st => {
    const f = await fixture(st);
    for (let index = 0; index < 26; index += 1) await f.receipt();
    assert.deepEqual(await drain({limit: 1000}), {claimed: 25, persisted: 25, failed: 0});
    assert.equal((await f.observations()).filter(row => row.comment_workflow_status === 'queued').length, 1);
    assert.deepEqual(await drain(), {claimed: 1, persisted: 1, failed: 0});
    assert.equal((await f.comments()).length, 26);
  });

  await t.test('normal patrol admission resumes after receipt processing releases the high-water budget', async st => {
    const f = await fixture(st);
    const before = await budget();
    assert.equal(before.pending_count, 0, 'This integration suite requires an isolated empty receipt queue');
    const previousHighWater = process.env.NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT;
    process.env.NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT = '1';
    st.after(() => {
      if (previousHighWater === undefined) delete process.env.NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT;
      else process.env.NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT = previousHighWater;
    });
    const receipt = await f.receipt();
    const authCode = (await pool.query(`INSERT INTO auth_codes(tenant_id, code, status, expires_at)
      VALUES($1, $2, 'active', now()+interval '1 day') RETURNING id`,
    [f.tenant.id, `RECEIPT-${randomUUID()}`])).rows[0];
    const binding = (await pool.query(`INSERT INTO auth_bindings(code_id, fingerprint)
      VALUES($1, $2) RETURNING id`, [authCode.id, randomUUID()])).rows[0];
    const capabilities = {remoteTaskCreate: true, remoteTargetedPostCaptureV1: true,
      negativePostPatrol: true, negativePatrolTerminalReceiptV1: true,
      supportedPlatforms: ['douyin'], taskStateKnown: true};
    const agent = (await pool.query(`INSERT INTO capture_agents(tenant_id, client_uuid,
        display_name, browser_name, app_version, allowed_platforms, status,
        auth_code_id, auth_binding_id, capabilities,
        last_heartbeat_at, last_full_heartbeat_at, last_liveness_at)
      VALUES($1, $2, 'Receipt patrol node', 'Chrome', '0.4.7', ARRAY['douyin'], 'active',
        $3, $4, $5, now(), now(), now()) RETURNING *`,
    [f.tenant.id, randomUUID(), authCode.id, binding.id, JSON.stringify(capabilities)])).rows[0];
    await pool.query(`INSERT INTO capture_agent_tokens(agent_id, auth_code_id, auth_binding_id, token_hash)
      VALUES($1, $2, $3, $4)`, [agent.id, authCode.id, binding.id,
      createHash('sha256').update(randomUUID()).digest('hex')]);
    const parent = (await pool.query(`INSERT INTO capture_tasks(tenant_id, client_task_id,
        task_type, feature_key, platform, status, title, metadata, counts)
      VALUES($1, $2, 'capture_orchestration', 'negative_post_patrol', 'douyin', 'running',
        'Receipt capacity patrol', $3, '{"total":1}') RETURNING id`,
    [f.tenant.id, randomUUID(), JSON.stringify({workflow: 'negative_post_patrol',
      distributionMode: 'elastic_pool', perItemAdmissionV1: true,
      eligibleAgentIds: [agent.id], captureSettings: {}})])).rows[0];
    const item = (await pool.query(`INSERT INTO capture_task_items(tenant_id, task_id,
        item_key, item_type, record_id, external_id, platform, url_snapshot, status, ordinal, metadata)
      VALUES($1, $2, $3::text, 'negative_post', $3::uuid, '7000000000000000001', 'douyin',
        'https://www.douyin.com/video/7000000000000000001', 'pending', 0,
        '{"sourceRecord":{"title":"Receipt capacity patrol"}}') RETURNING id`,
    [f.tenant.id, parent.id, receipt.record_id])).rows[0];
    const claim = () => withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent, capabilities}));
    const blocked = await claim();
    assert.equal(blocked?.deferred, true);
    assert.equal(blocked?.reason, 'post_processing_count_high_water');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM capture_agent_commands WHERE tenant_id=$1',
      [f.tenant.id])).rows[0].n, 0);
    assert.deepEqual(await drain(), {claimed: 1, persisted: 1, failed: 0});
    assert.deepEqual(await budget(), before);
    const dispatched = await claim();
    assert.ok(dispatched?.commandId, JSON.stringify(dispatched));
    assert.equal(dispatched.itemId, item.id);
    const command = (await pool.query('SELECT * FROM capture_agent_commands WHERE id=$1',
      [dispatched.commandId])).rows[0];
    assert.equal(command.agent_id, agent.id);
    assert.equal(command.task_id, dispatched.childTaskId);
    assert.equal(command.payload.targets[0].itemId, item.id);
    assert.ok(command.admitted_at);
  });
});
