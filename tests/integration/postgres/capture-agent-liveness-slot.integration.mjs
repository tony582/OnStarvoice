import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20261009-agent-liveness-lock-timeout.md: the Extension fires the
// liveness ping and the full heartbeat from the same one-minute alarm, so the
// ping used to wait for its own node's execution slot and fail with
// lock_timeout (55P03, an unhandled 500) whenever that heartbeat ran longer
// than 500 ms. The ping must never wait for the slot, and the timeouts that
// remain possible must be retryable 503s.
test('liveness never waits for the execution slot and reports busy channels as 503', async t => {
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
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
    [`Liveness slot ${randomUUID()}`]);
  t.after(async () => {
    try { await query('DELETE FROM tenants WHERE id=$1', [tenant.id]); }
    finally { await closePool(); }
  });
  const [agent] = await query(`INSERT INTO capture_agents(tenant_id, client_uuid, client_label,
      browser_name, app_version, status, last_heartbeat_at, last_full_heartbeat_at, last_liveness_at)
    VALUES($1, $2, 'Liveness integration', 'Chrome', '0.4.23', 'active',
      now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes')
    RETURNING *`, [tenant.id, `liveness-${randomUUID()}`]);
  // Authentication is covered separately; exercise the authenticated route
  // handler and its real PostgreSQL transaction, as the heartbeat tests do.
  const handler = router.stack.find(layer => layer.route?.path === '/agent/liveness')
    .route.stack.at(-1).handle;
  async function liveness() {
    const headers = {};
    let status = 200;
    let body;
    let failure;
    const startedAt = Date.now();
    await handler({captureAgent: agent, body: {reason: 'cloud_agent_alarm'}}, {
      set(name, value) { headers[name] = value; return this; },
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
    }, error => { failure = error; });
    return {status, body, headers, failure, elapsedMs: Date.now() - startedAt};
  }
  const livenessAt = async () =>
    (await query('SELECT last_liveness_at FROM capture_agents WHERE id=$1', [agent.id]))[0].last_liveness_at;
  const before = await livenessAt();

  // 1. Free slot: the ping records liveness exactly as before.
  const recorded = await liveness();
  assert.equal(recorded.failure, undefined);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.ok, true);
  assert.equal(recorded.body.livenessRecorded, true);
  assert.equal(+recorded.body.agent.fullHeartbeatAt, +agent.last_full_heartbeat_at);
  const first = await livenessAt();
  assert.ok(first > before, 'last_liveness_at advanced');

  const holder = await pool.connect();
  try {
    // 2. Another transaction of this node holds the execution slot (its full
    //    heartbeat): the ping answers at once instead of waiting for
    //    lock_timeout, and leaves the write to the holder.
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['capture_agent_execution_slot', `${tenant.id}:${agent.id}`]);
    const deferred = await liveness();
    assert.equal(deferred.failure, undefined, String(deferred.failure?.code || ''));
    assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
    assert.equal(deferred.body.ok, true);
    assert.equal(deferred.body.livenessRecorded, false);
    assert.equal(+deferred.body.agent.fullHeartbeatAt, +agent.last_full_heartbeat_at,
      'the committed row still fills the display fields');
    assert.ok(deferred.elapsedMs < 450,
      `answered without waiting for the 500 ms lock_timeout (${deferred.elapsedMs} ms)`);
    assert.equal(+(await livenessAt()), +first, 'nothing written while the slot is held');

    // 3. While the slot is held, the committed row still decides the answer:
    //    a retired node is refused, not told it is alive.
    await query(`UPDATE capture_agents SET status='revoked' WHERE id=$1`, [agent.id]);
    const retired = await liveness();
    assert.equal(retired.status, 403, JSON.stringify(retired.body));
    assert.equal(retired.body.error, 'agent_inactive');
    await query(`UPDATE capture_agents SET status='active' WHERE id=$1`, [agent.id]);
    await holder.query('ROLLBACK');

    // 4. The row itself locked by a transaction outside the slot protocol: the
    //    ping waits at most lock_timeout and answers a retryable 503 with
    //    Retry-After instead of reaching the unhandled-error handler.
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM capture_agents WHERE id=$1 FOR UPDATE', [agent.id]);
    const busy = await liveness();
    assert.equal(busy.failure, undefined, 'the lock timeout must not become next(err)');
    assert.equal(busy.status, 503, JSON.stringify(busy.body));
    assert.deepEqual(busy.body, {
      ok: false,
      error: 'server_busy',
      message: '关键心跳通道繁忙，请稍后重试',
      retryAfterMs: 1000,
    });
    assert.equal(busy.headers['Retry-After'], '1');
    await holder.query('ROLLBACK');
  } finally {
    holder.release();
  }

  // 5. Slot free again: the next ping records liveness.
  const again = await liveness();
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.livenessRecorded, true);
  assert.ok((await livenessAt()) > first, 'last_liveness_at advanced once the slot was free');
});
