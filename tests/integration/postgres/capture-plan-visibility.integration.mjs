import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createApp} from '../../../server/app.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {createSession} from '../../../server/services/auth-service.js';
import {clearCaptureOverviewProjectionCache} from '../../../server/routes/capture-cloud.js';

test('plans remain visible beyond the recent-task limit without changing schedules', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  await runMigrations();
  const pool = getPool();
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const tenantIds = [];
  let userId;
  let server;
  t.after(async () => {
    clearCaptureOverviewProjectionCache();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    try {
      if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
      await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
    } finally {
      await closePool();
    }
  });
  for (const suffix of ['own', 'foreign']) {
    const [tenant] = await query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [
      `Plan visibility ${suffix} ${randomUUID()}`,
    ]);
    tenantIds.push(tenant.id);
  }
  const [tenantId, foreignTenantId] = tenantIds;
  const [user] = await query(`
    INSERT INTO users (email, name, password_hash, must_change_password)
    VALUES ($1, 'Plan reader', 'integration-only', false) RETURNING id
  `, [`plans-${randomUUID()}@integration.invalid`]);
  userId = user.id;
  await query(`INSERT INTO user_memberships (user_id, tenant_id, role, status)
    VALUES ($1, $2, 'tenant_viewer', 'active')`, [userId, tenantId]);
  const session = await createSession(userId, {headers: {}});
  const plan = async (title, status, tenant = tenantId, archived = false) => {
    const [template] = await query(`
      INSERT INTO capture_tasks (tenant_id, task_type, title, platform, status,
        orchestration_revision, metadata, created_at, updated_at)
      VALUES ($1, 'capture_orchestration', $2, 'douyin', 'pending', 1,
        '{"orchestrationTemplate":true}', now() - interval '200 days',
        now() - interval '200 days') RETURNING id
    `, [tenant, title]);
    const [schedule] = await query(`
      INSERT INTO capture_orchestration_schedules (tenant_id, template_task_id,
        title, platform, status, next_run_at, archived_at)
      VALUES ($1, $2, $3, 'douyin', $4,
        CASE WHEN $4 = 'active' THEN now() + interval '1 day' ELSE NULL END,
        CASE WHEN $5 THEN now() - interval '2 days' ELSE NULL END)
      RETURNING *
    `, [tenant, template.id, title, status, archived]);
    await query('UPDATE capture_tasks SET orchestration_schedule_id = $2 WHERE id = $1', [
      template.id, schedule.id,
    ]);
    return {templateId: template.id, schedule};
  };
  const ownPlans = [];
  for (const title of ['抖音提前跑', '小红书提前跑', '抖音日常', '小红书日常']) {
    ownPlans.push(await plan(title, 'active'));
  }
  ownPlans.push(await plan('Paused plan', 'paused'));
  ownPlans.push(await plan('Archived plan', 'canceled', tenantId, true));
  ownPlans.push(await plan('Ended plan', 'completed'));
  const foreignPlan = await plan('Foreign plan', 'active', foreignTenantId);
  await query(`INSERT INTO capture_tasks (tenant_id, task_type, title, status, finished_at)
    SELECT $1, 'capture', 'Recent task ' || sequence, 'completed', now()
    FROM generate_series(1, 350) sequence`, [tenantId]);
  const snapshot = () => query(`SELECT to_jsonb(s) AS schedule, to_jsonb(t) AS template
    FROM capture_orchestration_schedules s JOIN capture_tasks t ON t.id = s.template_task_id
    WHERE s.tenant_id = ANY($1::uuid[]) ORDER BY s.id`, [tenantIds]);
  const before = await snapshot();
  server = await new Promise((resolve, reject) => {
    const listener = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  const request = async (path, tenant = tenantId) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/capture-cloud${path}`, {
      headers: {Authorization: `Bearer ${session.token}`, 'X-Tenant-Id': tenant},
    });
    return {status: response.status, body: await response.json()};
  };

  await t.test('all plan states survive 350 newer tasks at default and explicit task limits', async () => {
    for (const [suffix, taskLimit] of [['', 100], ['?limit=10', 10], ['?limit=200', 200]]) {
      const result = await request(`/overview${suffix}`);
      assert.equal(result.status, 200);
      const plans = result.body.tasks.filter(row => row.metadata?.orchestrationTemplate);
      assert.deepEqual(new Set(plans.map(row => row.id)), new Set(ownPlans.map(row => row.templateId)));
      assert.equal(result.body.tasks.length - plans.length, taskLimit,
        'templates must not consume recent execution slots');
      assert.equal(new Set(result.body.tasks.map(row => row.id)).size, result.body.tasks.length);
      assert.equal(result.body.summary.historyTasks, 350);
      assert.ok(!result.body.tasks.some(row => row.id === foreignPlan.templateId));
    }
  });

  await t.test('plan lifecycle and next-run display come from the schedule, preserving detail identity', async () => {
    const result = await request('/overview');
    for (const {templateId, schedule} of ownPlans) {
      const row = result.body.tasks.find(task => task.id === templateId);
      assert.ok(row, `${schedule.title} must be available in Plans`);
      assert.equal(row.orchestration_schedule_id, schedule.id);
      assert.equal(row.metadata.scheduleStatus, schedule.status);
      assert.equal(Boolean(row.metadata.scheduleArchivedAt), Boolean(schedule.archived_at));
      if (schedule.next_run_at) {
        assert.equal(new Date(row.metadata.nextRunAt).getTime(), schedule.next_run_at.getTime());
      } else {
        assert.ok(!row.metadata.nextRunAt);
      }
    }
  });

  await t.test('plan reads retain tenant authorization, history and unchanged durable state', async () => {
    assert.equal((await request('/overview', foreignTenantId)).status, 403);
    const history = await request('/history?days=0');
    assert.equal(history.status, 200);
    assert.equal(history.body.pagination.total, 350);
    assert.deepEqual(await snapshot(), before);
    const [sideEffects] = await query(`SELECT
      (SELECT count(*) FROM capture_task_events WHERE tenant_id = ANY($1::uuid[])) AS events,
      (SELECT count(*) FROM capture_agent_commands WHERE tenant_id = ANY($1::uuid[])) AS commands`, [tenantIds]);
    assert.equal(Number(sideEffects.events), 0);
    assert.equal(Number(sideEffects.commands), 0);
  });
});
