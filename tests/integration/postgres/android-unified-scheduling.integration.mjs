import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

// A phone joins ordinary douyin scheduling: it claims elastic-pool keyword items
// and fixed-batch assignments, materializes a child run bound to the item (run =
// execution_task_id), never receives a browser command, and stays isolated from
// browser-only work. All against a real, isolated PostgreSQL database.
test('phones participate in normal orchestration scheduling with hard isolation', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  const {runCaptureOrchestrationScheduleNow} = await import('../../../server/services/capture-orchestration-scheduler.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;

  async function fixture(st) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [randomUUID()]);
    st.after(async () => {
      await query('DELETE FROM capture_task_item_attempts WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_task_items WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_agent_commands WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_tasks WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    });
    const code = randomUUID();
    await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenantId, code]);
    const service = createAndroidControlService({enabledTenants: () => new Set([tenantId])});
    const registration = {code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const registered = await service.register(registration);
    const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
    const principal = {tenantId, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const poll = (extra = {}) => service.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true, ...extra});
    const complete = (task, extra = {}) => service.complete(principal, {requestId: randomUUID(), identity: task.identity, sessionId, status: 'completed', deviceIdle: true, ...extra});
    return {tenantId, service, phone, principal, sessionId, poll, complete, registration};
  }

  async function browserAgent(tenantId, {eligible = true} = {}) {
    const code = randomUUID();
    const [{id: codeId}] = await query("INSERT INTO auth_codes(tenant_id,code,status,expires_at) VALUES($1,$2,'active',now()+interval '1 day') RETURNING id", [tenantId, code]);
    const [{id: bindingId}] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id', [codeId, randomUUID()]);
    const capabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, singleRelayV1: true, taskStateKnown: true, supportedPlatforms: ['douyin']};
    const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
      VALUES($1,$2,'Browser test','active',ARRAY['douyin'],$3,$4,$5,now(),now(),now()) RETURNING *`, [tenantId, randomUUID(), codeId, bindingId, capabilities]);
    return {agent, capabilities};
  }

  async function elasticParent(tenantId, {eligibleAgentIds, keywords, planSnapshot = {}, status = 'running'}) {
    const parentId = randomUUID();
    const metadata = {
      distributionMode: 'elastic_pool', eligibleAgentIds, claimUnit: 'keyword', executionMode: 'one_time',
      planSnapshot: {
        platform: 'douyin', keywords,
        searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'},
        keywordMaxDetectedItems: 40, mobileKeywordMaxMinutes: 12,
        recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true},
        ...planSnapshot,
      },
    };
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
      VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','手机弹性','douyin','cloud','manual',$4,$3,1,$5::jsonb,'{}'::jsonb)`,
    [parentId, tenantId, metadata, status, JSON.stringify({total: keywords.length, assigned: 0})]);
    const items = [];
    for (const [ordinal, keyword] of keywords.entries()) {
      const [item] = await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,'douyin','keyword','pending',0) RETURNING *`, [randomUUID(), tenantId, parentId, `keyword:${ordinal}`, ordinal, keyword]);
      items.push(item);
    }
    return {parentId, items};
  }

  await t.test('elastic poll materializes a child run bound to the item with mapped filters/budgets and no command', async st => {
    const f = await fixture(st);
    const {parentId} = await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['别克壁纸']});
    const claim = await f.poll();
    assert.ok(claim.task, 'phone claims the elastic keyword');
    assert.equal(claim.task.keyword, '别克壁纸');
    // run = execution_task_id (child), parent = item.task_id.
    const [item] = await query('SELECT * FROM capture_task_items WHERE keyword=$1', ['别克壁纸']);
    assert.equal(item.task_id, parentId, 'item stays on the orchestration parent');
    assert.equal(item.execution_task_id, claim.task.identity.taskId, 'run id is the child execution task');
    assert.notEqual(claim.task.identity.taskId, parentId);
    assert.equal(item.status, 'running');
    // child is a mobile-workflow capture task with no create command.
    const [child] = await query('SELECT * FROM capture_tasks WHERE id=$1', [claim.task.identity.taskId]);
    assert.equal(child.metadata.workflow, 'douyin_mobile_discovery');
    assert.equal(child.parent_task_id, parentId);
    assert.equal(child.metadata.distributionMode, 'elastic_pool');
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [child.id])).length, 0, 'no browser command for a phone');
    // filters/budgets mapping.
    assert.deepEqual(claim.task.filters, {sort: 'latest', publishTime: 'day', contentType: 'video'});
    assert.equal(claim.task.budgets.maxLinks, 40);
    assert.equal(claim.task.budgets.keywordMs, 12 * 60000);
    assert.equal(claim.task.budgets.batchMs, 12 * 60000 + 300000);
    assert.equal(claim.task.budgets.maxCards, 0);
    // deadline = now + batchMs; lease bounded by 90s.
    assert.ok(Date.parse(claim.task.deadlineAt) > Date.now());
    assert.equal(Date.parse(claim.permit.leaseUntil) - Date.parse(claim.permit.serverTime), 90000);
    // parent projected to running; /android/runs/:id works for the child id.
    const [parent] = await query('SELECT status FROM capture_tasks WHERE id=$1', [parentId]);
    assert.equal(parent.status, 'running');
    const detail = await f.service.detail(f.tenantId, child.id);
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].keyword, '别克壁纸');
  });

  await t.test('phone completion updates the item and parent aggregate; clean completion settles', async st => {
    const f = await fixture(st);
    const {parentId} = await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['君越壁纸']});
    const claim = await f.poll();
    await f.complete(claim.task);
    const [item] = await query('SELECT * FROM capture_task_items WHERE keyword=$1', ['君越壁纸']);
    assert.equal(item.status, 'completed');
    const [parent] = await query('SELECT status FROM capture_tasks WHERE id=$1', [parentId]);
    assert.ok(['completed', 'completed_with_warnings'].includes(parent.status), `parent settled: ${parent.status}`);
  });

  await t.test('a device-idle interrupted attempt becomes retryable; the same phone re-claims with resumeAuthorized', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['安吉星壁纸']});
    const first = await f.poll();
    assert.equal(first.task.resumeAuthorized, false);
    await f.complete(first.task, {status: 'interrupted'});
    const [afterFirst] = await query('SELECT status,attempt_count FROM capture_task_items WHERE keyword=$1', ['安吉星壁纸']);
    assert.equal(afterFirst.status, 'retryable');
    const second = await f.poll();
    assert.ok(second.task, 're-claimable by the same phone');
    assert.equal(second.task.resumeAuthorized, true, 'same-phone retry carries resumeAuthorized');
    assert.notEqual(second.task.identity.attemptId, first.task.identity.attemptId);
  });

  await t.test('fixed-batch assignment: poll case 1 claims a pre-bound pending item without a new child', async st => {
    const f = await fixture(st);
    // Mirror what the scheduler / manual dispatch write for a phone fixed group.
    const {parentId, items} = await elasticParent(f.tenantId, {eligibleAgentIds: [], keywords: ['凯迪拉克壁纸', '雪佛兰壁纸'], planSnapshot: {}});
    await query("UPDATE capture_tasks SET metadata=metadata||jsonb_build_object('distributionMode','fixed_batch') WHERE id=$1", [parentId]);
    const childId = randomUUID();
    const childMetadata = {
      workflow: 'douyin_mobile_discovery', agentKind: 'android_mobile', deviceId: f.registration.deviceId,
      filters: {sort: 'comprehensive', publishTime: 'all', contentType: 'all'},
      budgets: {maxLinks: 0, maxCards: 0, maxSwipes: 0, keywordMs: 15 * 60000, batchMs: 15 * 60000 * 2 + 300000, maxPending: 100},
      keywords: ['凯迪拉克壁纸', '雪佛兰壁纸'], deadlineAt: null,
      orchestrationChild: true, parentTaskId: parentId, orchestrationRevision: 1, distributionMode: 'fixed_batch', claimUnit: 'fixed_batch',
    };
    await query(`INSERT INTO capture_tasks(id,tenant_id,parent_task_id,origin_agent_id,assigned_agent_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,progress,counts)
      VALUES($1::uuid,$2,$3,$4,$4,$1::text,'capture','douyin_mobile_discovery','手机固定','douyin','android_runner','orchestration_dispatch','pending',$5,'{}'::jsonb,'{}'::jsonb)`,
    [childId, f.tenantId, parentId, f.phone.id, childMetadata]);
    for (const item of items) {
      await query("UPDATE capture_task_items SET status='pending', assigned_agent_id=$1, execution_task_id=$2, assignment_revision=1 WHERE id=$3", [f.phone.id, childId, item.id]);
    }
    const childCountBefore = (await query("SELECT id FROM capture_tasks WHERE parent_task_id=$1 AND metadata->>'workflow'='douyin_mobile_discovery'", [parentId])).length;
    const claim = await f.poll();
    assert.ok(claim.task, 'phone claims its assigned fixed-batch keyword');
    assert.equal(claim.task.identity.taskId, childId, 'claims onto the pre-created fixed-batch child');
    const childCountAfter = (await query("SELECT id FROM capture_tasks WHERE parent_task_id=$1 AND metadata->>'workflow'='douyin_mobile_discovery'", [parentId])).length;
    assert.equal(childCountAfter, childCountBefore, 'no extra child is created for fixed-batch claims');
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [childId])).length, 0);
  });

  await t.test('hard isolation: a browser cannot claim a phone-held mobile item; a phone cannot claim an ineligible pool item', async st => {
    const f = await fixture(st);
    const {parentId} = await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['别克君越壁纸']});
    const claim = await f.poll();
    assert.ok(claim.task);
    // The item is now running under a mobile child. An eligible browser must not steal it.
    const {agent, capabilities} = await browserAgent(f.tenantId);
    await query("UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{eligibleAgentIds}',$2::jsonb) WHERE id=$1", [parentId, JSON.stringify([f.phone.id, agent.id])]);
    const browserClaim = await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent, capabilities}));
    assert.equal(browserClaim, null, 'browser cannot claim the phone-held mobile item');
    // A phone cannot claim an elastic item it is not eligible for.
    const other = randomUUID();
    await elasticParent(f.tenantId, {eligibleAgentIds: [other], keywords: ['雪佛兰君威壁纸']});
    // Complete the phone's held item so the phone is free to poll again.
    await f.complete(claim.task);
    const ineligible = await f.poll();
    assert.equal(ineligible.task, null, 'phone does not claim a pool item it is not eligible for');
  });

  await t.test('scheduler fixed-batch materialization creates a phone child with no command; the phone then claims it', async st => {
    const f = await fixture(st);
    // A fixed-batch schedule whose douyin keyword template is assigned to the phone.
    const templateId = randomUUID();
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
      VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','手机计划模板','douyin','cloud','orchestration_schedule','pending',$3::jsonb,1,'{}'::jsonb,'{}'::jsonb)`,
    [templateId, f.tenantId, JSON.stringify({orchestrationTemplate: true, distributionMode: 'fixed_batch'})]);
    const keywords = ['别克GL8壁纸', '昂科威壁纸'];
    for (const [ordinal, keyword] of keywords.entries()) {
      await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assigned_agent_id,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,'douyin','keyword','pending',$7,1)`, [randomUUID(), f.tenantId, templateId, `keyword:${ordinal}`, ordinal, keyword, f.phone.id]);
    }
    const scheduleId = randomUUID();
    const planSnapshot = {mode: 'daily', startTime: '09:00', maxRounds: 1, roundGapMin: 10, platform: 'douyin', keywords,
      searchFilters: {sort: 'comprehensive', publishTime: 'day', contentType: 'all'}, keywordMaxDetectedItems: 30, mobileKeywordMaxMinutes: 10};
    await query(`INSERT INTO capture_orchestration_schedules(id,tenant_id,template_task_id,title,platform,status,schedule_mode,timezone,start_time,random_offset_min,custom_dates,overlap_policy,late_start_grace_min,allocation_mode,distribution_mode,revision,plan_snapshot,next_run_at)
      VALUES($1,$2,$3,'手机计划','douyin','active','daily','Asia/Shanghai','09:00',0,ARRAY[]::date[],'skip',360,'balanced','fixed_batch',1,$4::jsonb,now())`,
    [scheduleId, f.tenantId, templateId, JSON.stringify(planSnapshot)]);
    const result = await runCaptureOrchestrationScheduleNow({tenantId: f.tenantId, scheduleId, requestKey: randomUUID()});
    assert.equal(result.kind, 'created', JSON.stringify(result));
    const [child] = await query(`SELECT * FROM capture_tasks WHERE tenant_id=$1 AND parent_task_id=$2 AND metadata->>'workflow'='douyin_mobile_discovery'`, [f.tenantId, result.runTaskId]);
    assert.ok(child, 'a mobile fixed-batch child was materialized');
    assert.equal(child.assigned_agent_id, f.phone.id);
    assert.equal(child.metadata.distributionMode, 'fixed_batch');
    assert.deepEqual(child.metadata.keywords.sort(), [...keywords].sort());
    assert.equal(child.metadata.budgets.keywordMs, 10 * 60000);
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [child.id])).length, 0, 'no create command for the phone child');
    // Its keyword items are bound to the child and pending.
    const boundItems = await query(`SELECT status FROM capture_task_items WHERE execution_task_id=$1`, [child.id]);
    assert.equal(boundItems.length, keywords.length);
    assert.ok(boundItems.every(item => item.status === 'pending'));
    // The phone claims one keyword through poll case 1 onto that child.
    const claim = await f.poll();
    assert.ok(claim.task);
    assert.equal(claim.task.identity.taskId, child.id);
    assert.ok(keywords.includes(claim.task.keyword));
  });

  await t.test('parent stop fences a phone child via control() reading the parent stop flag', async st => {
    const f = await fixture(st);
    const {parentId} = await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['安吉星车机壁纸']});
    const claim = await f.poll();
    assert.ok(claim.task);
    // Operator stops the orchestration parent (as the stop route sets it).
    await query("UPDATE capture_tasks SET metadata=metadata||jsonb_build_object('operatorStopped',true) WHERE id=$1", [parentId]);
    const renewed = await f.service.renew(f.principal, {identity: claim.task.identity, sessionId: f.sessionId, leaseId: claim.permit.leaseId});
    assert.equal(renewed.permit, null);
    assert.equal(renewed.control.reason, 'remote_stop');
    // A held phone that reports back while stopped is canceled.
    await f.complete(claim.task, {status: 'canceled', deviceIdle: true});
    const [item] = await query('SELECT status FROM capture_task_items WHERE keyword=$1', ['安吉星车机壁纸']);
    assert.equal(item.status, 'canceled');
  });

  await t.test('retries go to the fewest attempts first, and a keyword that ran out of attempts does not strand the rest', async st => {
    const f = await fixture(st);
    const {parentId} = await elasticParent(f.tenantId, {eligibleAgentIds: [f.phone.id], keywords: ['凯迪拉克壁纸', '别克车机壁纸', '君越车机壁纸']});
    const claimed = [];
    const attempt = async status => {
      const claim = await f.poll();
      assert.ok(claim.task, `the phone gets a keyword after ${claimed.join(' > ')}`);
      claimed.push(claim.task.keyword);
      await f.complete(claim.task, {status});
    };
    // The 09-24 night run: the first keyword failed again and again while the others waited behind it.
    await attempt('interrupted'); // 凯迪拉克壁纸, attempt 1
    await attempt('interrupted'); // 别克车机壁纸, attempt 1
    await attempt('completed'); // 君越车机壁纸
    await attempt('interrupted'); // 凯迪拉克壁纸, attempt 2
    await attempt('interrupted'); // 别克车机壁纸, attempt 2: fewer attempts go first
    await attempt('interrupted'); // 凯迪拉克壁纸, attempt 3: out of attempts
    const [exhausted] = await query('SELECT status,attempt_count FROM capture_task_items WHERE task_id=$1 AND keyword=$2', [parentId, '凯迪拉克壁纸']);
    assert.deepEqual([exhausted.status, exhausted.attempt_count], ['needs_action', 3]);
    const [blocked] = await query('SELECT status FROM capture_tasks WHERE id=$1', [parentId]);
    assert.equal(blocked.status, 'needs_action', 'the run reports the exhausted keyword');
    const resumed = await f.poll(); // 别克车机壁纸, attempt 3
    assert.equal(resumed.task?.keyword, '别克车机壁纸', 'the other keyword is still claimed from the needs_action run');
    const [working] = await query('SELECT status FROM capture_tasks WHERE id=$1', [parentId]);
    assert.equal(working.status, 'running', 'the run shows running while the phone works on it');
    claimed.push(resumed.task.keyword);
    await f.complete(resumed.task, {status: 'completed'});
    assert.deepEqual(claimed, ['凯迪拉克壁纸', '别克车机壁纸', '君越车机壁纸', '凯迪拉克壁纸', '别克车机壁纸', '凯迪拉克壁纸', '别克车机壁纸']);
    assert.equal((await f.poll()).task, null, 'nothing is left to claim');
    const [settled] = await query('SELECT status FROM capture_tasks WHERE id=$1', [parentId]);
    assert.equal(settled.status, 'needs_action');
  });
});
