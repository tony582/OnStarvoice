import assert from 'node:assert/strict';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('legacy full heartbeat is not starved by unacknowledgeable targeted terminal notices', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {default: router} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`Legacy heartbeat acceptance ${Date.now()} ${process.pid}`])).rows[0];
  t.after(async () => {
    try { await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]); }
    finally { await closePool(); }
  });
  const agent = (await pool.query(`INSERT INTO capture_agents (
      tenant_id, client_uuid, client_label, browser_name, app_version,
      last_heartbeat_at, last_full_heartbeat_at
    ) VALUES ($1, $2, 'Legacy integration', 'Chrome', '0.4.5',
      now() - interval '10 minutes', now() - interval '10 minutes') RETURNING *`,
  [tenant.id, `legacy-heartbeat-${Date.now()}`])).rows[0];
  const task = (await pool.query(`INSERT INTO capture_tasks (
      tenant_id, assigned_agent_id, client_task_id, control_task_id,
      task_type, platform, title, status, finished_at, metadata
    ) VALUES ($1, $2, 'legacy-terminal-request', 'legacy-terminal-request',
      'negative_post_patrol', 'douyin', 'Historical canceled patrol', 'canceled', now(),
      '{"attemptIdentity":"legacy-terminal-attempt"}') RETURNING id`,
  [tenant.id, agent.id])).rows[0];
  // Authentication is covered separately; exercise the authenticated route
  // handler and its real PostgreSQL transactions against an old client payload.
  const handler = router.stack.find(layer => layer.route?.path === '/agent/heartbeat')
    .route.stack.at(-1).handle;
  async function heartbeat(capabilities = {}, terminalNoticeAcks = []) {
    let payload;
    let status = 200;
    let failure;
    await handler({captureAgent: agent, body: {
      agent: {clientUuid: agent.client_uuid, appVersion: '0.4.5',
        capabilities: {taskStateKnown: true, ...capabilities}},
      tasks: [], terminalNoticeAcks,
    }}, {
      status(value) { status = value; return this; },
      set() { return this; },
      json(value) { payload = value; return this; },
    }, error => { failure = error; });
    if (failure) throw failure;
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    return payload;
  }
  for (let i = 0; i < 2; i += 1) {
    const old = await heartbeat();
    assert.notEqual(old.priorityControlOnly, true);
    assert.deepEqual(old.terminalNotices, []);
    assert.equal(old.taskStateKnown, true);
    const saved = (await pool.query('SELECT last_full_heartbeat_at FROM capture_agents WHERE id=$1', [agent.id])).rows[0];
    assert.ok(saved.last_full_heartbeat_at > agent.last_full_heartbeat_at);
  }
  const current = await heartbeat({negativePatrolTerminalReceiptV1: true});
  assert.equal(current.priorityControlOnly, true);
  assert.equal(current.terminalNotices.length, 1);
  assert.equal(current.terminalNotices[0].requestId, 'legacy-terminal-request');
  const acknowledged = await heartbeat({negativePatrolTerminalReceiptV1: true}, [{
    requestId: 'legacy-terminal-request', attemptId: 'legacy-terminal-attempt', status: 'canceled',
  }]);
  assert.notEqual(acknowledged.priorityControlOnly, true);
  assert.deepEqual(acknowledged.terminalNotices, []);
  const settled = (await pool.query('SELECT metadata FROM capture_tasks WHERE id=$1', [task.id])).rows[0];
  assert.equal(settled.metadata.terminalNoticeAcknowledgement.attemptId, 'legacy-terminal-attempt');
});
