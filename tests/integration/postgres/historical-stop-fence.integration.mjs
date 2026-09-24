import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const STOP_ERROR = {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'};
const capabilities = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, taskStateKnown: true,
  heartbeatDegraded: false, supportedPlatforms: ['xiaohongshu'],
};

test('historical stop fences require later local execution evidence without holding idle nodes forever', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {findCaptureAgentExecutionSlotBlocker} = await import('../../../server/services/capture-cloud.js');
  const {default: router, dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const query = async (sql, params = []) => (await getPool().query(sql, params)).rows;
  t.after(closePool);

  async function fixture(st, nodeCount = 1, oldTaskCount = 1) {
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Historical stop test ${randomUUID()}`]);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const [code] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at)
      VALUES($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, randomUUID()]);
    const agents = [];
    for (let index = 0; index < nodeCount; index++) {
      const [binding] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,
        status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES($1,$2,$3,'active',ARRAY['xiaohongshu'],$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), `Node ${index}`, code.id, binding.id, capabilities]);
      agents.push(agent);
      await query(`INSERT INTO capture_agent_tokens(agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES($1,$2,$3,$4)`, [agent.id, code.id, binding.id, createHash('sha256').update(randomUUID()).digest('hex')]);
    }
    async function task(agent, overrides = {}) {
      const data = {
        task_type: 'unattended_keyword_capture', status: 'completed', error: {}, metadata: {},
        platform: 'xiaohongshu', parent_task_id: null,
        created_at: '2026-09-01T00:00:00Z', started_at: '2026-09-01T00:01:00Z',
        finished_at: '2026-09-01T00:02:00Z', updated_at: '2026-09-01T00:03:00Z',
        ...overrides,
      };
      const [row] = await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,
        client_task_id,title,task_type,status,error,metadata,platform,parent_task_id,
        created_at,started_at,finished_at,updated_at)
        VALUES($1,$2,$2,$3,'Historical stop fixture',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [tenant.id, agent?.id || null, randomUUID(), data.task_type, data.status, data.error,
        data.metadata, data.platform, data.parent_task_id, data.created_at, data.started_at,
        data.finished_at, data.updated_at]);
      return row;
    }
    const parent = await task(null, {task_type: 'capture_orchestration'});
    const successor = await task(agents[0], {parent_task_id: parent.id});
    const oldTasks = [];
    for (let index = 0; index < oldTaskCount; index++) {
      oldTasks.push(await task(agents[index % nodeCount], {
        parent_task_id: parent.id, status: 'superseded', error: STOP_ERROR,
        metadata: {handoffSuccessorTaskId: successor.id}, updated_at: '2026-09-02T00:00:00Z',
      }));
    }
    const proofs = [];
    for (const agent of agents) proofs.push(await task(agent, {
      task_type: 'capture', created_at: '2026-09-03T00:00:00Z', started_at: '2026-09-03T00:01:00Z',
      finished_at: '2026-09-03T00:02:00Z', updated_at: '2026-09-03T00:03:00Z',
    }));
    const blocker = (index = 0) => withTransaction(tx => findCaptureAgentExecutionSlotBlocker(
      tx, tenant.id, agents[index].id, {excludeTaskIds: oldTasks.map(row => row.id)},
    ));
    async function stopReceipt(proof = proofs[0], agent = agents[0]) {
      const [command] = await query(`INSERT INTO capture_agent_commands(tenant_id,agent_id,task_id,
        command_type,status,result,created_at,finished_at)
        VALUES($1,$2,$3,'stop','completed',$4,$5,$6) RETURNING *`,
      [tenant.id, agent.id, proof.id, {accepted: true, state: 'completed', requestId: proof.client_task_id},
        '2026-09-03T00:01:30Z', '2026-09-03T00:02:00Z']);
      return command;
    }
    return {tenant, agents, task, parent, successor, oldTasks, proofs, blocker, stopReceipt};
  }

  await t.test('49 historical errors release all 8 nodes and their actual heartbeat create commands', async st => {
    const f = await fixture(st, 8, 49);
    // One node has a confirmed remote stop instead of a later successful run.
    await query("UPDATE capture_tasks SET status='canceled' WHERE id=$1", [f.proofs[7].id]);
    await f.stopReceipt(f.proofs[7], f.agents[7]);
    for (let index = 0; index < 8; index++) assert.equal(await f.blocker(index), null,
      `idle node ${index} must not inherit an old superseded stop error`);

    const keywords = Array.from({length: 8}, (_, index) => `测试词 ${index}`);
    const plan = {enabled: true, platform: 'xiaohongshu', keywords, keywordMaxDetectedItems: 5,
      searchPasses: ['all', 'image'], searchFilters: {publishTime: 'day'},
      recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
      'keyword_orchestration','xiaohongshu','pending','New scheduled batch',$3,'{"total":8}') RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', eligibleAgentIds: f.agents.map(a => a.id), planSnapshot: plan}]);
    for (let index = 0; index < keywords.length; index++) await query(`INSERT INTO capture_task_items(
      tenant_id,task_id,item_key,item_type,keyword,platform,status,ordinal,metadata)
      VALUES($1,$2,$3,'keyword',$3,'xiaohongshu','pending',$4,$5)`,
    [f.tenant.id, parent.id, keywords[index], index,
      {singleRelayV1: true, searchPasses: plan.searchPasses, requireVerifiedFilters: true}]);

    const heartbeat = router.stack.find(layer => layer.route?.path === '/agent/heartbeat').route.stack.at(-1).handle;
    const delivered = new Set();
    for (const agent of f.agents) {
      let payload, failure;
      await heartbeat({captureAgent: agent, body: {agent: {clientUuid: agent.client_uuid, capabilities}, tasks: []}},
        {status() {return this;}, set() {return this;}, json(value) {payload = value; return this;}},
        error => {failure = error;});
      if (failure) throw failure;
      assert.equal(payload.commands.length, 1, JSON.stringify(payload));
      assert.equal(payload.commands[0].command_type, 'create');
      delivered.add(payload.commands[0].id);
      assert.equal(await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent, capabilities})), null,
        'the newly assigned execution must still hold its node');
    }
    assert.equal(delivered.size, 8, 'one distinct command per node');
    const [history] = await query(`SELECT count(*)::int n FROM capture_tasks WHERE tenant_id=$1
      AND status='superseded' AND error->>'code'='PREVIOUS_CAPTURE_STOP_UNCONFIRMED'`, [f.tenant.id]);
    assert.equal(history.n, 49, 'admission must preserve the original error history');
  });

  const invalidCases = [
    ['a current unresolved stop', "UPDATE capture_tasks SET status='needs_action' WHERE id=$1", 'old'],
    ['a running execution', "UPDATE capture_tasks SET status='running' WHERE id=$1", 'old'],
    ['a pending stop', "UPDATE capture_tasks SET metadata=metadata || '{\"stopPending\":true}' WHERE id=$1", 'old'],
    ['a missing handoff', "UPDATE capture_tasks SET metadata='{}' WHERE id=$1", 'old'],
    ['an unrelated successor', "UPDATE capture_tasks SET parent_task_id=NULL WHERE id=$1", 'successor'],
    ['a missing successor', "UPDATE capture_tasks SET metadata='{\"handoffSuccessorTaskId\":\"missing\"}' WHERE id=$1", 'old'],
    ['a different platform', "UPDATE capture_tasks SET platform='douyin' WHERE id=$1", 'proof'],
    ['a configuration receipt', "UPDATE capture_tasks SET task_type='unattended_plan_configuration' WHERE id=$1", 'proof'],
    ['a parent summary', "UPDATE capture_tasks SET task_type='capture_orchestration' WHERE id=$1", 'proof'],
    ['a page-open receipt', "UPDATE capture_tasks SET metadata='{\"executionMode\":\"source_open\"}' WHERE id=$1", 'proof'],
    ['a run created before the stop error', "UPDATE capture_tasks SET created_at='2026-09-01T12:00:00Z' WHERE id=$1", 'proof'],
    ['a run started before the stop error', "UPDATE capture_tasks SET started_at='2026-09-01T12:00:00Z' WHERE id=$1", 'proof'],
    ['a run without a finish time', "UPDATE capture_tasks SET finished_at=NULL WHERE id=$1", 'proof'],
    ['a run finished before starting', "UPDATE capture_tasks SET finished_at='2026-09-02T12:00:00Z' WHERE id=$1", 'proof'],
    ['another unresolved stop', "UPDATE capture_tasks SET error='{\"code\":\"PREVIOUS_CAPTURE_STOP_UNCONFIRMED\"}' WHERE id=$1", 'proof'],
    ['an unconfirmed cancellation', "UPDATE capture_tasks SET status='canceled' WHERE id=$1", 'proof'],
    ['a failed execution', "UPDATE capture_tasks SET status='failed' WHERE id=$1", 'proof'],
    ['a later run still stopping', "UPDATE capture_tasks SET metadata='{\"stopPending\":true}' WHERE id=$1", 'proof'],
  ];
  for (const [label, sql, target] of invalidCases) await t.test(`${label} cannot release the stop fence`, async st => {
    const f = await fixture(st);
    const row = target === 'old' ? f.oldTasks[0] : target === 'successor' ? f.successor : f.proofs[0];
    await query(sql, [row.id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, label);
  });

  await t.test('evidence stays bound to its tenant, source node and acknowledged stop', async st => {
    const f = await fixture(st, 2);
    await query("UPDATE capture_tasks SET status='canceled' WHERE id=$1", [f.proofs[0].id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, 'another node completing work is not local proof');
    const other = await fixture(st);
    await query('UPDATE capture_tasks SET assigned_agent_id=$1,origin_agent_id=$1 WHERE id=$2',
      [f.agents[0].id, other.proofs[0].id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, 'another tenant cannot release the node');
    const receipt = await f.stopReceipt();
    assert.equal(await f.blocker(), null);
    await query("UPDATE capture_agent_commands SET result='{\"accepted\":false}' WHERE id=$1", [receipt.id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, 'a rejected stop is not proof');
    await query("UPDATE capture_agent_commands SET result='{\"accepted\":true}',agent_id=$2 WHERE id=$1",
      [receipt.id, f.agents[1].id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, 'the receipt must come from the source node');
  });

  await t.test('legacy origin-only executions qualify but reassigned executions do not', async st => {
    const f = await fixture(st, 2);
    await query('UPDATE capture_tasks SET assigned_agent_id=NULL WHERE id=$1', [f.proofs[0].id]);
    assert.equal(await f.blocker(), null, 'an origin-only local run remains valid evidence');
    await query('UPDATE capture_tasks SET assigned_agent_id=$1 WHERE id=$2', [f.agents[1].id, f.proofs[0].id]);
    assert.equal((await f.blocker())?.id, f.oldTasks[0].id, 'the actual assigned node takes precedence over origin');
  });
});
