import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, execute, queryOne} from '../../../server/db/init.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {
  enqueueXhsSourceOpen,
  getXhsSourceOpenTask,
} from '../../../server/services/xhs-source-open.js';

test('Xiaohongshu source-open prefers the source Agent and never persists xsec navigation', async t => {
  await runMigrations();
  const tenant = await queryOne(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`XHS source-open integration ${Date.now()}`]);
  t.after(async () => {
    await execute('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await closeDb();
  });

  async function createAgent(label) {
    const authCode = await queryOne(`
      INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now() + interval '1 day')
      RETURNING id
    `, [tenant.id, `XHS-${label}-${Date.now()}`]);
    const binding = await queryOne(`
      INSERT INTO auth_bindings (code_id, fingerprint)
      VALUES ($1, $2)
      RETURNING id
    `, [authCode.id, `xhs-${label}-${Date.now()}`]);
    return queryOne(`
      INSERT INTO capture_agents (
        tenant_id, client_uuid, display_name, browser_name,
        app_version, allowed_platforms, status, last_heartbeat_at,
        auth_code_id, auth_binding_id, capabilities
      ) VALUES (
        $1, $2, $3, 'Chrome',
        '0.4.0', ARRAY['xiaohongshu'], 'active', now(),
        $4, $5, $6::jsonb
      )
      RETURNING id, display_name
    `, [
      tenant.id,
      `xhs-${label}-${Date.now()}`,
      label,
      authCode.id,
      binding.id,
      JSON.stringify({
        taskStateKnown: true,
        remoteTaskCreate: true,
        xiaohongshuSourceOpenV1: true,
        supportedPlatforms: ['xiaohongshu'],
      }),
    ]);
  }

  const sourceAgent = await createAgent('重庆');
  await createAgent('成都');
  const record = await queryOne(`
    INSERT INTO records (
      tenant_id, external_id, platform, record_type,
      title, author_name, keyword, url, canonical_url
    ) VALUES (
      $1, '6a94c7c3000000002003b809', 'xiaohongshu', 'single_note',
      '昂科威Plus使用感受', '到处闲逛的CaptainNick', '功能使用',
      'https://www.xiaohongshu.com/explore/6a94c7c3000000002003b809',
      'https://www.xiaohongshu.com/explore/6a94c7c3000000002003b809'
    )
    RETURNING id
  `, [tenant.id]);
  const lineageTask = await queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key,
      title, platform, source, trigger_type, status
    ) VALUES (
      $1, $2, 'capture_orchestration', 'keyword_orchestration',
      'source lineage', 'xiaohongshu', 'cloud', 'manual', 'completed'
    )
    RETURNING id
  `, [tenant.id, `xhs-lineage-${Date.now()}`]);
  const item = await queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      record_id, external_id, status, assigned_agent_id,
      execution_task_id, attempt_count, assignment_revision
    ) VALUES (
      $1, $2, 'keyword:功能使用', 'xiaohongshu', 'keyword',
      $3, '6a94c7c3000000002003b809', 'completed', $4,
      $2, 1, 1
    )
    RETURNING id
  `, [tenant.id, lineageTask.id, record.id, sourceAgent.id]);
  const attempt = await queryOne(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      started_at, finished_at
    ) VALUES (
      $1, $2, $3, $3,
      $4, 1, 1, 'completed', now() - interval '1 minute', now()
    )
    RETURNING id
  `, [tenant.id, item.id, lineageTask.id, sourceAgent.id]);
  await execute(`
    INSERT INTO record_observations (
      tenant_id, record_id, platform, keyword,
      capture_task_id, capture_task_item_id,
      capture_task_item_attempt_id, captured_at
    ) VALUES (
      $1, $2, 'xiaohongshu', '功能使用',
      $3, $4, $5, now()
    )
  `, [tenant.id, record.id, lineageTask.id, item.id, attempt.id]);

  const created = await enqueueXhsSourceOpen({
    tenantId: tenant.id,
    recordId: record.id,
    requestedByName: 'integration',
  });
  assert.equal(created.state, 'queued');
  assert.equal(created.agent.id, sourceAgent.id);
  assert.equal(created.agent.name, '重庆');

  const persisted = await queryOne(`
    SELECT task.status, task.metadata, command.payload, command.result
    FROM capture_tasks task
    JOIN capture_agent_commands command
      ON command.task_id = task.id AND command.tenant_id = task.tenant_id
    WHERE task.id = $1 AND task.tenant_id = $2
  `, [created.taskId, tenant.id]);
  assert.equal(persisted.status, 'pending');
  assert.equal(persisted.metadata.sourceAgentPreferred, true);
  assert.equal(persisted.payload.executionMode, 'source_open');
  assert.equal(persisted.payload.externalId, '6a94c7c3000000002003b809');
  assert.deepEqual(persisted.payload.searchQueries, [
    '昂科威Plus使用感受',
    '功能使用',
  ]);
  assert.equal(persisted.payload.canonicalUrl, 'https://www.xiaohongshu.com/explore/6a94c7c3000000002003b809');
  assert.doesNotMatch(JSON.stringify(persisted), /xsec_token|xsec_source/iu);

  const reused = await enqueueXhsSourceOpen({
    tenantId: tenant.id,
    recordId: record.id,
    requestedByName: 'integration retry',
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.taskId, created.taskId);

  await execute(`
    UPDATE capture_agent_commands
    SET status = 'completed',
      result = '{"accepted":true,"reason":"source_opened","message":"opened"}'::jsonb,
      finished_at = now()
    WHERE task_id = $1 AND tenant_id = $2
  `, [created.taskId, tenant.id]);
  await execute(`
    UPDATE capture_tasks
    SET status = 'completed', finished_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [created.taskId, tenant.id]);
  const completed = await getXhsSourceOpenTask({
    tenantId: tenant.id,
    recordId: record.id,
    taskId: created.taskId,
  });
  assert.equal(completed.state, 'opened');
  assert.equal(completed.reason, 'source_opened');
  assert.equal('url' in completed, false);
});
