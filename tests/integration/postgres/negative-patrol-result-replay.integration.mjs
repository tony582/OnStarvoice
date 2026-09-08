import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('negative patrol result replays preserve real failures and exact assignment ownership', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {projectNegativePatrolSnapshot} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`Patrol replay ${Date.now()} ${process.pid}`])).rows[0];
  t.after(async () => {
    try { await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]); }
    finally { await closePool(); }
  });
  const agent = (await pool.query(`INSERT INTO capture_agents (
      tenant_id, client_uuid, client_label, browser_name
    ) VALUES ($1, $2, 'Patrol replay integration', 'Chrome') RETURNING *`,
  [tenant.id, randomUUID()])).rows[0];

  async function fixture() {
    const parent = (await pool.query(`INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key, status, metadata
      ) VALUES ($1, $2, 'capture_orchestration', 'negative_post_patrol', 'running', $3)
      RETURNING *`, [tenant.id, randomUUID(), JSON.stringify({
      workflow: 'negative_post_patrol', distributionMode: 'elastic_pool',
      eligibleAgentIds: [agent.id],
    })])).rows[0];
    const child = (await pool.query(`INSERT INTO capture_tasks (
        tenant_id, parent_task_id, assigned_agent_id, client_task_id,
        task_type, platform, status, orchestration_revision
      ) VALUES ($1, $2, $3, $4, 'negative_post_patrol', 'xiaohongshu', 'running', 3)
      RETURNING *`, [tenant.id, parent.id, agent.id, randomUUID()])).rows[0];
    const record = (await pool.query(`INSERT INTO records (
        tenant_id, external_id, platform, title
      ) VALUES ($1, $2, 'xiaohongshu', 'Patrol replay fixture') RETURNING *`,
    [tenant.id, randomUUID()])).rows[0];
    const item = (await pool.query(`INSERT INTO capture_task_items (
        tenant_id, task_id, execution_task_id, assigned_agent_id, item_key,
        record_id, external_id, status, assignment_revision, attempt_count
      ) VALUES ($1, $2, $3, $4, $5::text, $5::uuid, $6, 'dispatched', 3, 1) RETURNING *`,
    [tenant.id, parent.id, child.id, agent.id, record.id, record.external_id])).rows[0];
    const attempt = (await pool.query(`INSERT INTO capture_task_item_attempts (
        tenant_id, item_id, parent_task_id, execution_task_id, agent_id,
        attempt_number, assignment_revision, status
      ) VALUES ($1, $2, $3, $4, $5, 1, 3, 'dispatched') RETURNING *`,
    [tenant.id, item.id, parent.id, child.id, agent.id])).rows[0];
    const result = {
      itemId: item.id, recordId: record.id, externalId: record.external_id,
      ordinal: 1, status: 'failed',
      startedAt: '2026-09-08T03:21:38.000Z',
      finishedAt: '2026-09-08T03:22:35.000Z',
      error: {code: 'BLOGGER_METRICS_CAPTURE_FAILED', message: '博主补采超时'},
    };
    const snapshot = {status: 'needs_action', targetResults: [result]};
    const project = (nextSnapshot = snapshot, nextChild = child, nextAgent = agent) =>
      withTransaction(tx => projectNegativePatrolSnapshot(tx, nextAgent, nextChild, nextSnapshot));
    async function saved() {
      return {
        item: (await pool.query('SELECT *, xmin::text AS row_version FROM capture_task_items WHERE id=$1', [item.id])).rows[0],
        attempt: (await pool.query('SELECT *, xmin::text AS row_version FROM capture_task_item_attempts WHERE id=$1', [attempt.id])).rows[0],
        child: (await pool.query('SELECT * FROM capture_tasks WHERE id=$1', [child.id])).rows[0],
      };
    }
    return {parent, child, item, result, snapshot, project, saved};
  }

  await t.test('identical failures retain their error without item writes or business clock advancement', async () => {
    const f = await fixture();
    await f.project();
    const first = await f.saved();
    assert.equal(first.item.status, 'retryable');
    assert.equal(first.item.error.code, 'BLOGGER_METRICS_CAPTURE_FAILED');
    assert.equal(first.attempt.error.code, 'BLOGGER_METRICS_CAPTURE_FAILED');
    for (let replay = 0; replay < 2; replay += 1) {
      await f.project();
      const repeated = await f.saved();
      assert.deepEqual(repeated.item, first.item);
      assert.deepEqual(repeated.attempt, first.attempt);
      assert.deepEqual(repeated.child.business_progress_at, first.child.business_progress_at);
      assert.equal(repeated.child.metadata.targetResultProjection.projectedCount, 0);
    }
  });

  await t.test('an actual absent result still enters recovery with missing_target_result', async () => {
    const f = await fixture();
    await f.project({status: 'needs_action', targetResults: []});
    const saved = await f.saved();
    assert.equal(saved.item.error.code, 'missing_target_result');
    assert.equal(saved.item.metadata.checkpoint.missingTargetResult, true);
    assert.equal(saved.attempt.error.code, 'missing_target_result');
  });

  for (const field of ['recordId', 'externalId']) {
    await t.test(`a mismatched ${field} cannot masquerade as a verified replay`, async () => {
      const f = await fixture();
      const mismatched = {...f.result, [field]: randomUUID()};
      // Even an identical stored JSON blob is insufficient without its record identity.
      await pool.query(`UPDATE capture_task_items
        SET metadata = jsonb_build_object('targetResult', $2::jsonb) WHERE id=$1`,
      [f.item.id, JSON.stringify(mismatched)]);
      await f.project({status: 'needs_action', targetResults: [mismatched]});
      assert.equal((await f.saved()).item.error.code, 'missing_target_result');
    });
  }

  await t.test('a stale assignment revision cannot overwrite the current item or attempt', async () => {
    const f = await fixture();
    await f.project();
    await pool.query('UPDATE capture_task_items SET assignment_revision=4 WHERE id=$1', [f.item.id]);
    const before = await f.saved();
    await f.project();
    const after = await f.saved();
    assert.deepEqual(after.item, before.item);
    assert.deepEqual(after.attempt, before.attempt);
  });

  for (const changedOwner of ['execution', 'agent']) {
    await t.test(`a stale ${changedOwner} cannot reclaim a replayed result`, async () => {
      const f = await fixture();
      await f.project();
      await pool.query(`UPDATE capture_task_items SET ${changedOwner === 'execution'
        ? 'execution_task_id' : 'assigned_agent_id'}=NULL WHERE id=$1`, [f.item.id]);
      const before = await f.saved();
      await f.project();
      const after = await f.saved();
      assert.deepEqual(after.item, before.item);
      assert.deepEqual(after.attempt, before.attempt);
    });
  }

  await t.test('late results cannot reopen an operator-canceled parent', async () => {
    const f = await fixture();
    await pool.query("UPDATE capture_tasks SET status='canceled' WHERE id=$1", [f.parent.id]);
    const before = await f.saved();
    assert.equal(await f.project(), null);
    assert.deepEqual(await f.saved(), before);
  });
});
