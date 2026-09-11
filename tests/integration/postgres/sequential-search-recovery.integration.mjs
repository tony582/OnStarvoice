import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const keyword = '别克 OTA';
const capabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, taskStateKnown: true, supportedPlatforms: ['douyin']};

test('sequential recovery corrects durable states and really dispatches only the missing pass', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {dispatchNextElasticWorkItem, mirrorTaskSnapshot, repairIncompleteSequentialCompletions} =
    await import('../../../server/routes/capture-cloud.js');
  const {normalizeCloudTaskSnapshot} = await import('../../../server/services/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);

  async function fixture(st) {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Sequential recovery ${randomUUID()}`])).rows[0];
    st.after(() => pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const code = (await pool.query(`INSERT INTO auth_codes (tenant_id,code,status,expires_at)
      VALUES ($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, randomUUID()])).rows[0];
    const agents = [];
    for (let index = 0; index < 3; index++) {
      const binding = (await pool.query('INSERT INTO auth_bindings (code_id,fingerprint) VALUES ($1,$2) RETURNING id',
        [code.id, randomUUID()])).rows[0];
      const agent = (await pool.query(`INSERT INTO capture_agents (tenant_id,client_uuid,display_name,
        browser_name,app_version,allowed_platforms,status,auth_code_id,auth_binding_id,capabilities,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES ($1,$2,$3,'Chrome','0.4.8',ARRAY['douyin'],'active',$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), `Sequential node ${index}`, code.id, binding.id, JSON.stringify(capabilities)])).rows[0];
      agents.push(agent);
      await pool.query(`INSERT INTO capture_agent_tokens (agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES ($1,$2,$3,$4)`, [agent.id, code.id, binding.id, createHash('sha256').update(randomUUID()).digest('hex')]);
      await pool.query(`INSERT INTO social_agent_daily_usage (tenant_id,agent_id,platform,usage_date,searches,failed_events,safety_verifications)
        VALUES ($1,$2,'douyin',(now() AT TIME ZONE 'Asia/Shanghai')::date,0,0,0)`, [tenant.id, agent.id]);
    }
    const plan = {enabled: true, platform: 'douyin', keywords: [keyword], keywordMaxDetectedItems: 5,
      searchPasses: ['all', 'image'], recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true,
        requireVerifiedFilters: true}, searchFilters: {publishTime: 'day'}};
    const parent = (await pool.query(`INSERT INTO capture_tasks (tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts) VALUES ($1,$2,'capture_orchestration',
      'keyword_orchestration','douyin','pending','Sequential fixture',$3,'{"total":1}') RETURNING *`,
    [tenant.id, randomUUID(), JSON.stringify({distributionMode: 'elastic_pool', eligibleAgentIds: agents.map(a => a.id), planSnapshot: plan})])).rows[0];
    const item = (await pool.query(`INSERT INTO capture_task_items (tenant_id,task_id,item_key,item_type,
      keyword,platform,status,ordinal,metadata) VALUES ($1,$2,$3,'keyword',$3,'douyin','pending',0,$4) RETURNING *`,
    [tenant.id, parent.id, keyword, JSON.stringify({searchPasses: plan.searchPasses, singleRelayV1: true,
      requireVerifiedFilters: true, disableAutomaticSearchRetry: true})])).rows[0];
    const scope = {tenantId: tenant.id, parentTaskIds: [parent.id], itemIds: [item.id]};
    const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
    async function claim(index = 0) {
      return withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: agents[index], capabilities}));
    }
    async function mirror(claimed, {status = 'running', completed = [1], code: errorCode = '', seq = 1} = {}) {
      const command = await row('capture_agent_commands', claimed.commandId);
      const child = await row('capture_tasks', claimed.childTaskId);
      const now = new Date().toISOString();
      const snapshot = normalizeCloudTaskSnapshot({id: child.client_task_id, controlTaskId: child.id,
        attemptId: command.payload.attemptIdentity, attemptNumber: 1, status, platform: 'douyin',
        taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan',
        source: 'cloud', triggerType: 'orchestration', title: child.title,
        createdAt: child.created_at.toISOString(), updatedAt: now, startedAt: now,
        finishedAt: status === 'running' ? null : now, heartbeatAt: now, progressSeq: seq,
        progress: {keyword, roundCurrent: 2}, counts: {success: completed.length, total: 2},
        checkpoint: {round: 2, activeKeyword: keyword, activePhase: 'pending', keywordResults:
          completed.map(round => ({keyword, round, status: 'completed', savedCount: 0,
            attemptCount: 1, finishedAt: new Date(Date.now() - 60_000).toISOString()}))},
        error: errorCode ? {code: errorCode, message: '第二步启动失败'} : {},
        metadata: {planSnapshot: command.payload.planSnapshot}});
      const agent = agents.find(a => a.id === command.agent_id);
      const result = await withTransaction(tx => mirrorTaskSnapshot(tx, agent, snapshot));
      assert.equal(result.id, child.id);
      assert.equal(result.status, status);
      await pool.query(`UPDATE capture_agent_commands SET admitted_at=now()-interval '11 seconds' WHERE id=$1`, [command.id]);
      return result;
    }
    async function assertResume(claimed, agentIndex) {
      assert.ok(claimed?.commandId, `Expected actual command, got ${JSON.stringify(claimed)}`);
      const command = await row('capture_agent_commands', claimed.commandId);
      assert.equal(command.agent_id, agents[agentIndex].id);
      assert.equal(command.payload.checkpoint.round, 2);
      assert.deepEqual(command.payload.checkpoint.keywordResults.map(e => [e.round, e.status]), [[1, 'completed']]);
      assert.deepEqual(command.payload.planSnapshot.searchPasses, ['all', 'image']);
      assert.equal(command.payload.planSnapshot.searchFilters.publishTime, 'day');
      const attempt = (await pool.query('SELECT * FROM capture_task_item_attempts WHERE execution_task_id=$1', [claimed.childTaskId])).rows[0];
      assert.equal(attempt.item_id, item.id);
      assert.equal(attempt.agent_id, agents[agentIndex].id);
      assert.equal(attempt.assignment_revision, (await row('capture_task_items', item.id)).assignment_revision);
      return command;
    }
    return {tenant, agents, parent, item, scope, row, claim, mirror, assertResume};
  }

  await t.test('pending -> first pass -> failed second-step start -> retryable -> another Agent resumes step two', async st => {
    const f = await fixture(st);
    const first = await f.claim();
    assert.ok(first?.commandId, JSON.stringify(first));
    await f.mirror(first);
    assert.equal((await f.row('capture_task_items', f.item.id)).status, 'running');
    assert.equal((await f.row('capture_tasks', f.parent.id)).status, 'running');
    await f.mirror(first, {status: 'failed', code: 'stale_unattended_attempt', seq: 2});
    const item = await f.row('capture_task_items', f.item.id);
    assert.equal(item.status, 'retryable');
    assert.equal(item.error.code, 'stale_unattended_attempt');
    assert.equal(item.finished_at, null);
    assert.equal(item.metadata.elasticTechnicalAttemptCount, 1);
    assert.deepEqual(item.metadata.checkpoint.searchPassResults.map(e => e.round), [1]);
    const second = await f.claim(1);
    await f.assertResume(second, 1);
    await f.mirror(second, {status: 'completed', completed: [1, 2]});
    assert.equal((await f.row('capture_task_items', f.item.id)).status, 'completed');
    assert.equal((await f.row('capture_tasks', f.parent.id)).status, 'completed');
    assert.equal(await f.claim(2), null, 'complete results never dispatch again');
  });

  async function legacyFalseCompletion(f) {
    const first = await f.claim();
    await f.mirror(first, {status: 'failed', code: 'stale_unattended_attempt'});
    // Reproduce only the old projection defect, retaining the real failed child.
    await pool.query(`UPDATE capture_task_items SET status='completed',error='{}',
      finished_at=now()-interval '2 minutes',metadata=metadata || '{"elasticAttemptBudgetUsed":1,"elasticTechnicalAttemptCount":0}'::jsonb WHERE id=$1`, [f.item.id]);
    await pool.query(`UPDATE capture_task_item_attempts SET status='completed',error='{}',
      started_at=now()-interval '1 minute',finished_at=now()-interval '2 minutes' WHERE execution_task_id=$1`, [first.childTaskId]);
    await pool.query(`UPDATE capture_tasks SET status='completed',finished_at=now(),counts='{"total":1,"completed":1}' WHERE id=$1`, [f.parent.id]);
    return first;
  }

  await t.test('historical preview is read-only; reviewed apply fixes time and parent then normal claim resumes step two', async st => {
    const f = await fixture(st);
    await legacyFalseCompletion(f);
    const before = await f.row('capture_task_items', f.item.id);
    const preview = await repairIncompleteSequentialCompletions(f.scope);
    assert.equal(preview.applied, false);
    assert.equal(preview.results[0].nextStatus, 'retryable');
    assert.deepEqual(await f.row('capture_task_items', f.item.id), before);
    await assert.rejects(repairIncompleteSequentialCompletions({...f.scope, apply: true, expectedFingerprint: '0'.repeat(64)}), /preview changed/);
    assert.deepEqual(await f.row('capture_task_items', f.item.id), before);
    const result = await repairIncompleteSequentialCompletions({...f.scope, apply: true, expectedFingerprint: preview.fingerprint});
    assert.equal(result.repairedCount, 1);
    assert.equal((await f.row('capture_task_items', f.item.id)).finished_at, null);
    assert.equal((await f.row('capture_tasks', f.parent.id)).status, 'running');
    const priorAttempt = (await pool.query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [f.item.id])).rows[0];
    assert.equal(priorAttempt.status, 'retryable');
    assert.equal(priorAttempt.finished_at, null);
    assert.equal((await repairIncompleteSequentialCompletions(f.scope)).results.length, 0);
    const second = await f.claim(1);
    await f.assertResume(second, 1);
    const events = (await pool.query(`SELECT * FROM capture_task_events WHERE task_id=$1 AND event_type='incomplete_search_pass_completion_repaired'`, [f.parent.id])).rows;
    assert.equal(events.length, 1);
    assert.ok(events[0].payload.previousAttemptFinishedAt);
  });

  for (const mode of ['canceled', 'login', 'exhausted', 'complete', 'active_command']) {
    await t.test(`historical repair does not auto-dispatch ${mode} evidence`, async st => {
      const f = await fixture(st);
      const first = await legacyFalseCompletion(f);
      if (mode === 'canceled') await pool.query(`UPDATE capture_tasks SET metadata=metadata || '{"operatorStopped":true}' WHERE id=$1`, [f.parent.id]);
      if (mode === 'login') await pool.query(`UPDATE capture_tasks SET error='{"code":"LOGIN_REQUIRED","category":"login_required"}' WHERE id=$1`, [first.childTaskId]);
      if (mode === 'exhausted') {
        await pool.query('UPDATE capture_task_items SET attempt_count=6 WHERE id=$1', [f.item.id]);
        await pool.query('UPDATE capture_task_item_attempts SET attempt_number=6 WHERE item_id=$1', [f.item.id]);
      }
      if (mode === 'complete') await pool.query(`UPDATE capture_tasks SET checkpoint=jsonb_set(checkpoint,'{keywordResults}',
        (checkpoint->'keywordResults') || jsonb_build_array((checkpoint->'keywordResults'->0) || '{"round":2}'::jsonb)) WHERE id=$1`, [first.childTaskId]);
      if (mode === 'active_command') await pool.query(`UPDATE capture_agent_commands SET status='acknowledged' WHERE id=$1`, [first.commandId]);
      const preview = await repairIncompleteSequentialCompletions(f.scope);
      if (mode === 'login' || mode === 'exhausted') {
        assert.equal(preview.results[0].eligible, true);
        assert.notEqual(preview.results[0].nextStatus, 'retryable');
        await repairIncompleteSequentialCompletions({...f.scope, apply: true, expectedFingerprint: preview.fingerprint});
      } else assert.equal(preview.results[0].eligible, false);
      assert.equal(await f.claim(1), null);
    });
  }
});
