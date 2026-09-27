import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20260927-unattended-self-heal.md (S4): 需处理 roots nobody can
// act on are settled by the system through F3's 「结束并移到历史」 routine,
// after a grace per kind. Fences, manual-action and safety marks, live work
// and every other kind stay for a person. The sweep never runs the admission
// fence SQL.
const STOP_ERROR = {
  code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
  message: '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续',
};
const XHS_CAPABILITIES = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, singleRelayV1: true,
  taskStateKnown: true, heartbeatDegraded: false, supportedPlatforms: ['xiaohongshu'],
};
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('dead 需处理 roots settle automatically through the operator-close path', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {queryAll: poolQueryAll, withTransaction: poolWithTransaction} = await import('../../../server/db/query.js');
  const {createApp} = await import('../../../server/app.js');
  const {createSession} = await import('../../../server/services/auth-service.js');
  const {normalizeCloudTaskSnapshot} = await import('../../../server/services/capture-cloud.js');
  const {mirrorTaskSnapshot, reconcileDeadAttentionRoots} = await import('../../../server/routes/capture-cloud.js');
  const {resetDeadAttentionCursors} = await import('../../../server/services/capture-dead-attention.js');
  const {closeOperatorAttentionRoot} = await import('../../../server/services/capture-operator-close.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const server = await new Promise((resolve, reject) => {
    const listening = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    listening.once('error', reject);
    listening.once('listening', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await closePool();
  });
  const origin = `http://127.0.0.1:${server.address().port}/api/capture-cloud`;
  const quiet = {log() {}, error() {}};

  async function fixture(st) {
    resetDeadAttentionCursors();
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Dead attention ${randomUUID()}`]);
    const userIds = [];
    st.after(async () => {
      await query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    });
    const [code] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at,max_bindings)
      VALUES($1,$2,'active',now()+interval '1 day',50) RETURNING *`, [tenant.id, randomUUID()]);
    const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
      VALUES($1,'运营 值班','integration-only','active',false) RETURNING id`,
    [`dead-attention-${randomUUID()}@integration.invalid`]);
    userIds.push(user.id);
    await query(`INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')`,
      [user.id, tenant.id]);
    const session = await createSession(user.id, {headers: {}});
    async function request(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {authorization: `Bearer ${session.token}`, 'x-tenant-id': tenant.id,
          ...(body === undefined ? {} : {'content-type': 'application/json'})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      return {status: response.status, body: await response.json()};
    }
    async function addAgent(name, {platforms = ['xiaohongshu'], capabilities = XHS_CAPABILITIES} = {}) {
      const [binding] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,
        allowed_platforms,auth_code_id,auth_binding_id,capabilities,app_version,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES($1,$2,$3,'active',$4,$5,$6,$7,'0.4.18',now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), name, platforms, code.id, binding.id, capabilities]);
      return agent;
    }
    async function task({age = 2 * HOUR, ...overrides} = {}) {
      const data = {
        task_type: 'capture', status: 'needs_action', title: '提前', platform: 'xiaohongshu', source: 'sidebar',
        parent_task_id: null, origin_agent_id: null, client_task_id: randomUUID(), control_task_id: '',
        error: {}, metadata: {}, attempt_number: 1, orchestration_revision: 0, message: '',
        ...overrides,
      };
      const [row] = await query(`INSERT INTO capture_tasks(tenant_id,task_type,feature_key,status,title,platform,
        source,parent_task_id,origin_agent_id,assigned_agent_id,client_task_id,control_task_id,error,metadata,
        attempt_number,orchestration_revision,message,started_at,created_at,updated_at)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,now()-interval '3 days',
          now()-interval '3 days',now()-($16::integer * interval '1 millisecond')) RETURNING *`,
      [tenant.id, data.task_type, data.status, data.title, data.platform, data.source, data.parent_task_id,
        data.origin_agent_id, data.client_task_id, data.control_task_id, data.error, data.metadata,
        data.attempt_number, data.orchestration_revision, data.message, age]);
      return row;
    }
    async function item(parent, {status = 'needs_action', execution = null, agent = null, error = {}, metadata = {},
      attemptCount = 1, itemType = 'keyword', keyword = `词-${randomUUID().slice(0, 6)}`, attemptResult = {}} = {}) {
      const [row] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,
        status,ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count,assignment_revision,error,started_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT COUNT(*) FROM capture_task_items WHERE task_id=$2),$8,$9,$10,$11,1,$12,
          now()-interval '1 day') RETURNING *`,
      [tenant.id, parent.id, `${itemType}:${randomUUID()}`, itemType, keyword, parent.platform, status, metadata,
        agent?.id || null, execution?.id || null, attemptCount, error]);
      if (agent) {
        await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,
          agent_id,attempt_number,assignment_revision,status,error,result) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)`,
        [tenant.id, row.id, parent.id, execution?.id || null, agent.id, attemptCount,
          status === 'pending' ? 'assigned' : status, error, attemptResult]);
      }
      return row;
    }
    const discovered = (agent, error, age) => task({task_type: 'discovered_post_capture', platform: 'douyin',
      source: 'cloud', title: '手机发现作品补详情', origin_agent_id: agent.id, error, age,
      metadata: {workflow: 'discovered_post_capture', candidateId: randomUUID()}});
    const manualBatch = (agent, overrides = {}) => task({origin_agent_id: agent.id, title: '提前',
      error: {code: 'MANUAL_BATCH_PAGE_CLOSED', message: '批量采集页面已关闭'},
      metadata: {executionMode: 'manual_batch'}, ...overrides});
    const row = async id => (await query('SELECT * FROM capture_tasks WHERE id=$1', [id]))[0];
    const itemRow = async id => (await query('SELECT * FROM capture_task_items WHERE id=$1', [id]))[0];
    const events = (taskId, type) => query(`SELECT * FROM capture_task_events WHERE task_id=$1
      AND ($2::text IS NULL OR event_type=$2) ORDER BY id`, [taskId, type || null]);
    const sweep = (options = {}) => reconcileDeadAttentionRoots({tenantIds: [tenant.id], logger: quiet, ...options});
    let progressSeq = 10;
    async function mirror(agent, input) {
      progressSeq += 1;
      const now = new Date(Date.now() + progressSeq).toISOString();
      const snapshot = normalizeCloudTaskSnapshot({platform: 'xiaohongshu', taskType: 'capture', source: 'sidebar',
        title: '提前', attemptNumber: 1, progressSeq, createdAt: now, updatedAt: now, heartbeatAt: now, ...input});
      return withTransaction(tx => mirrorTaskSnapshot(tx, agent, snapshot));
    }
    return {tenant, request, addAgent, task, item, discovered, manualBatch, row, itemRow, events, sweep, mirror};
  }

  function assertAutomaticallyClosed(closed, {status = 'failed', dismissed = true} = {}) {
    assert.equal(closed.status, status);
    const marker = closed.metadata.operatorClose;
    assert.ok(marker?.closedAt, 'the F3 marker is written');
    assert.equal(marker.mode, 'automatic');
    assert.equal(marker.closedBy, '系统自动结算');
    assert.equal(marker.closedByUserId, '');
    if (dismissed) {
      assert.ok(closed.attention_dismissed_at, 'moved to history');
      assert.equal(closed.attention_dismissed_by_name, '系统自动结算');
      assert.equal(closed.attention_dismissed_by_user_id, null);
    } else {
      assert.equal(closed.attention_dismissed_at, null, 'stays in 需处理');
    }
  }

  await t.test('K1 补详情: a failed report settles after ten minutes; completed waits a day; needs_action and marks never', async st => {
    const f = await fixture(st);
    const browser = await f.addAgent('西瓜', {platforms: ['douyin']});
    const failed = {code: 'detail_finished_without_ingestion', reportedStatus: 'failed'};
    const young = await f.discovered(browser, failed, 5 * MINUTE);
    const due = await f.discovered(browser, failed, 11 * MINUTE);
    const dueItem = await f.item(due, {itemType: 'discovered_post', execution: due, agent: browser,
      error: failed});
    const completedYoung = await f.discovered(browser,
      {code: 'detail_finished_without_ingestion', reportedStatus: 'completed'}, 23 * HOUR);
    const completedOld = await f.discovered(browser,
      {code: 'detail_finished_without_ingestion', reportedStatus: 'completed_with_warnings'}, 25 * HOUR);
    const asked = await f.discovered(browser,
      {code: 'detail_finished_without_ingestion', reportedStatus: 'needs_action'}, 3 * HOUR);
    const marked = await f.discovered(browser, {...failed, requiresManualAction: true}, 3 * HOUR);
    const expired = await f.discovered(browser, {code: 'detail_create_expired'}, 31 * MINUTE);

    const result = await f.sweep();
    assert.equal(result.settled, 3, JSON.stringify(result));
    assert.deepEqual(result.kinds, {discovered_post_detail: 3});
    for (const id of [young.id, completedYoung.id, asked.id, marked.id]) {
      const untouched = await f.row(id);
      assert.equal(untouched.status, 'needs_action', id);
      assert.equal(untouched.attention_dismissed_at, null);
      assert.equal(untouched.metadata.operatorClose, undefined);
    }
    const closed = await f.row(due.id);
    assertAutomaticallyClosed(closed);
    assert.equal(closed.message, '系统已自动结束并移到历史（没有可继续的工作，未重新采集）');
    assert.equal(closed.error.code, 'detail_finished_without_ingestion', 'the original error stays');
    assert.equal(closed.metadata.operatorClose.originalError.reportedStatus, 'failed');
    const closedItem = await f.itemRow(dueItem.id);
    assert.equal(closedItem.status, 'failed');
    assert.equal(closedItem.error.operatorClosed, true);
    const [event] = await f.events(due.id, 'task_operator_closed');
    assert.equal(event.actor_type, 'system');
    assert.equal(event.actor_name, '系统自动结算');
    assert.equal(event.payload.mode, 'automatic');
    assert.equal(event.payload.kind, 'discovered_post_detail');
    assert.match(event.message, /^系统自动结算/u);
    const [audit] = await query(`SELECT * FROM audit_logs WHERE tenant_id=$1 AND action='capture_task.operator_closed'
      AND target_id=$2`, [f.tenant.id, due.id]);
    assert.equal(audit.actor_type, 'system');
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.metadata.kind, 'discovered_post_detail');
    assertAutomaticallyClosed(await f.row(completedOld.id));
    assertAutomaticallyClosed(await f.row(expired.id));

    // The same execution reporting failed again keeps it closed and in history.
    await f.mirror(browser, {id: due.client_task_id, taskType: 'discovered_post_capture', platform: 'douyin',
      workflow: 'discovered_post_capture', status: 'failed', error: failed});
    const held = await f.row(due.id);
    assert.equal(held.status, 'failed');
    assert.ok(held.attention_dismissed_at);
    assert.deepEqual(held.metadata.operatorClose, closed.metadata.operatorClose);

    // Rows the sweep refused can still be closed by an operator (F3).
    const manual = await f.request(`/tasks/${asked.id}/operator-close`, {});
    assert.equal(manual.status, 200, JSON.stringify(manual.body));
    assert.equal((await f.row(asked.id)).metadata.operatorClose.mode, 'single');
    assert.equal((await f.sweep()).settled, 0, 'nothing else to settle');
  });

  await t.test('K2 提前: settles after an hour; the same execution stays closed, a fence reopens it', async st => {
    const f = await fixture(st);
    const agent = await f.addAgent('金星');
    const clientId = randomUUID();
    const attemptId = randomUUID();
    const recent = await f.manualBatch(agent, {age: 30 * MINUTE});
    const old = await f.manualBatch(agent, {client_task_id: clientId, age: 61 * MINUTE});
    assert.equal((await f.sweep()).settled, 1);
    assert.equal((await f.row(recent.id)).status, 'needs_action');
    const closed = await f.row(old.id);
    assertAutomaticallyClosed(closed);
    await f.mirror(agent, {id: clientId, attemptId, status: 'needs_action',
      error: {code: 'MANUAL_BATCH_PAGE_CLOSED'}});
    const held = await f.row(old.id);
    assert.equal(held.status, 'failed', 'the same execution repeating needs_action stays closed');
    assert.ok(held.attention_dismissed_at);
    await f.mirror(agent, {id: clientId, attemptId, status: 'needs_action', error: STOP_ERROR});
    const fenced = await f.row(old.id);
    assert.equal(fenced.status, 'needs_action', 'a fence report reopens it');
    assert.equal(fenced.attention_dismissed_at, null, 'back in 需处理');
    assert.equal((await f.sweep()).settled, 0, 'a fenced root is never settled');
    assert.equal((await f.row(old.id)).status, 'needs_action');

    // Settled rows leave with the ordinary history clear.
    const other = await f.manualBatch(agent, {age: 2 * HOUR});
    assert.equal((await f.sweep()).settled, 1);
    const cleared = await f.request('/history/clear', {taskIds: [other.id]});
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.ok((await f.row(other.id)).metadata.historyClearedAt);
  });

  await t.test('K3 standalone phone run: past its deadline it settles; held phones and live runs do not', async st => {
    const f = await fixture(st);
    const phone = await f.addAgent('DE106', {platforms: ['douyin'], capabilities: {agentKind: 'android_mobile'}});
    const phoneRun = (deadlineMs, overrides = {}) => f.task({task_type: 'capture', platform: 'douyin',
      source: 'android_runner', title: '抖音手机发现', origin_agent_id: phone.id,
      metadata: {workflow: 'douyin_mobile_discovery', deadlineAt: new Date(Date.now() - deadlineMs).toISOString()},
      ...overrides});
    const expired = await phoneRun(31 * MINUTE);
    const failedWord = await f.item(expired, {execution: expired, agent: phone, attemptCount: 1,
      metadata: {deviceHeld: false, reason: 'invalid_ui_source'}});
    const queuedWord = await f.item(expired, {status: 'pending', execution: expired});
    const notYet = await phoneRun(-HOUR);
    await f.item(notYet, {execution: notYet, agent: phone});
    const held = await phoneRun(2 * HOUR);
    await f.item(held, {execution: held, agent: phone, metadata: {deviceHeld: true}});
    const login = await phoneRun(2 * HOUR);
    await f.item(login, {execution: login, agent: phone, metadata: {deviceHeld: false, reason: 'login_required'},
      attemptResult: {reason: 'login_required'}});

    const result = await f.sweep();
    assert.equal(result.settled, 1, JSON.stringify(result));
    const closed = await f.row(expired.id);
    assertAutomaticallyClosed(closed);
    const words = await Promise.all([f.itemRow(failedWord.id), f.itemRow(queuedWord.id)]);
    assert.deepEqual(words.map(word => word.status), ['failed', 'canceled']);
    assert.ok(words.every(word => word.assignment_revision === 2), 'late phone reports turn stale');
    for (const id of [notYet.id, held.id, login.id]) assert.equal((await f.row(id)).status, 'needs_action', id);
  });

  await t.test('K4 phone batch: used-up phone keywords settle after the grace and the batch stays in 需处理', async st => {
    const f = await fixture(st);
    const phone = await f.addAgent('DE106', {platforms: ['douyin'], capabilities: {agentKind: 'android_mobile'}});
    async function phoneBatch({distributionMode = 'elastic_pool', age = 7 * HOUR, reason = 'invalid_ui_source',
      attemptCount = 3} = {}) {
      const parent = await f.task({task_type: 'capture_orchestration', platform: 'douyin', source: 'cloud',
        title: '手机 · 09/26 20:04', attempt_number: 0, orchestration_revision: 1, age,
        metadata: {distributionMode, claimUnit: 'keyword', eligibleAgentIds: [phone.id]}});
      const child = await f.task({task_type: 'capture', platform: 'douyin', source: 'android_runner',
        parent_task_id: parent.id, origin_agent_id: phone.id, age,
        metadata: {workflow: 'douyin_mobile_discovery', orchestrationChild: true, parentTaskId: parent.id,
          distributionMode}});
      const used = await f.item(parent, {execution: child, agent: phone, attemptCount,
        metadata: {deviceHeld: false, reason}, attemptResult: {reason}});
      const done = await f.item(parent, {status: 'completed', execution: child});
      await query('UPDATE capture_tasks SET updated_at=now()-($2::integer * interval \'1 millisecond\') WHERE id=$1',
        [parent.id, age]);
      return {parent, child, used, done};
    }
    const elastic = await phoneBatch();
    const young = await phoneBatch({age: 5 * HOUR});
    const fixed = await phoneBatch({distributionMode: 'fixed_batch', age: 7 * HOUR});
    const login = await phoneBatch({reason: 'login_or_challenge_required'});
    const budgetLeft = await phoneBatch({attemptCount: 2});

    const result = await f.sweep();
    assert.equal(result.settled, 1, JSON.stringify(result));
    assert.deepEqual(result.kinds, {mobile_batch_exhausted: 1});
    const closed = await f.row(elastic.parent.id);
    assertAutomaticallyClosed(closed, {status: 'completed_with_failures', dismissed: false});
    assert.equal(closed.message, '系统已自动结束：用尽次数的工作项已标记失败，已完成结果保留');
    assert.equal((await f.itemRow(elastic.used.id)).status, 'failed');
    assert.equal((await f.itemRow(elastic.done.id)).status, 'completed');
    const child = await f.row(elastic.child.id);
    assert.equal(child.status, 'failed');
    assert.equal(child.message, '已由系统自动结束（未重新采集）');
    for (const batch of [young, fixed, login, budgetLeft]) {
      assert.equal((await f.row(batch.parent.id)).status, 'needs_action');
      assert.equal((await f.itemRow(batch.used.id)).status, 'needs_action');
    }
    // A fixed phone batch waits a day.
    await query(`UPDATE capture_tasks SET updated_at=now()-interval '25 hours' WHERE id=$1`, [fixed.parent.id]);
    assert.equal((await f.sweep()).settled, 1);
    assertAutomaticallyClosed(await f.row(fixed.parent.id), {status: 'completed_with_failures', dismissed: false});
    // 「清理已结束失败项」 moves them when the operator wants.
    const dismissed = await f.request('/tasks/dismiss-terminal-attention', {});
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.ok((await f.row(elastic.parent.id)).attention_dismissed_at);
  });

  await t.test('fences anywhere in the tree, safety marks and live work are never settled', async st => {
    const f = await fixture(st);
    const agent = await f.addAgent('成都');
    const phone = await f.addAgent('DE106', {platforms: ['douyin'], capabilities: {agentKind: 'android_mobile'}});
    const rootFence = await f.manualBatch(agent, {error: STOP_ERROR});
    const safety = await f.manualBatch(agent, {error: {code: 'XHS_SECURITY_BLOCK', message: '小红书安全验证'}});
    const itemFenced = await f.manualBatch(agent);
    await f.item(itemFenced, {execution: itemFenced, agent, error: STOP_ERROR});
    const itemSafety = await f.manualBatch(agent);
    await f.item(itemSafety, {execution: itemSafety, agent, error: {requiresManualAction: true}});
    const live = await f.manualBatch(agent);
    await f.item(live, {status: 'running', execution: live, agent});
    const parent = await f.task({task_type: 'capture_orchestration', platform: 'douyin', source: 'cloud',
      attempt_number: 0, orchestration_revision: 1, age: 7 * HOUR,
      metadata: {distributionMode: 'elastic_pool', claimUnit: 'keyword'}});
    const fencedChild = await f.task({task_type: 'unattended_keyword_capture', platform: 'douyin', source: 'cloud',
      parent_task_id: parent.id, origin_agent_id: agent.id, error: STOP_ERROR, age: 7 * HOUR});
    const phoneChild = await f.task({task_type: 'capture', platform: 'douyin', source: 'android_runner',
      parent_task_id: parent.id, origin_agent_id: phone.id, age: 7 * HOUR,
      metadata: {workflow: 'douyin_mobile_discovery', orchestrationChild: true}});
    await f.item(parent, {execution: phoneChild, agent: phone, attemptCount: 3, metadata: {reason: 'invalid_ui_source'}});
    await f.item(parent, {status: 'failed', execution: fencedChild, agent});
    await query(`UPDATE capture_tasks SET updated_at=now()-interval '7 hours' WHERE id=$1`, [parent.id]);

    const result = await f.sweep();
    assert.equal(result.settled, 0, JSON.stringify(result));
    for (const id of [rootFence.id, safety.id, itemFenced.id, itemSafety.id, live.id, parent.id]) {
      const untouched = await f.row(id);
      assert.equal(untouched.status, 'needs_action', id);
      assert.equal(untouched.metadata.operatorClose, undefined, id);
    }
    assert.equal((await f.row(fencedChild.id)).error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
  });

  await t.test('the cursor reaches a settleable root behind a full page of permanent ones, without the fence SQL', async st => {
    const f = await fixture(st);
    const browser = await f.addAgent('西瓜', {platforms: ['douyin']});
    const permanent = [];
    for (let index = 0; index < 60; index += 1) {
      permanent.push((await f.discovered(browser,
        {code: 'detail_finished_without_ingestion', reportedStatus: 'needs_action'}, 3 * HOUR)).id);
    }
    // One statement: all 60 share one updated_at, with microseconds. A
    // millisecond cursor would read the same first page forever.
    await query(`UPDATE capture_tasks SET updated_at = now() - interval '3 hours' - interval '123 microseconds'
      WHERE id = ANY($1::uuid[])`, [permanent]);
    const target = await f.manualBatch(await f.addAgent('木星'), {age: 2 * HOUR});
    const statements = [];
    const spyQueryAll = (sql, params) => { statements.push(sql); return poolQueryAll(sql, params); };
    const spyTransaction = (callback, options) => poolWithTransaction(tx => callback({
      ...tx,
      queryAll: (sql, params) => { statements.push(sql); return tx.queryAll(sql, params); },
      queryOne: (sql, params) => { statements.push(sql); return tx.queryOne(sql, params); },
      execute: (sql, params) => { statements.push(sql); return tx.execute(sql, params); },
    }), options);
    const spied = {queryAll: spyQueryAll, withTransaction: spyTransaction, limit: 50};
    const first = await f.sweep(spied);
    assert.equal(first.scanned, 50);
    assert.equal(first.settled, 0, 'the first page only holds permanent rows');
    assert.equal((await f.row(target.id)).status, 'needs_action');
    const second = await f.sweep(spied);
    assert.equal(second.settled, 1, JSON.stringify(second));
    assertAutomaticallyClosed(await f.row(target.id));
    const third = await f.sweep(spied);
    assert.equal(third.scanned, 50, 'a short page starts over from the beginning');
    assert.ok(statements.length > 0);
    assert.equal(statements.filter(sql => /confirmed_stops|settled_runs/u.test(sql)).length, 0,
      'the sweep never runs the admission fence SQL');
  });

  await t.test('a locked root is skipped and the switch turns the sweep off', async st => {
    const f = await fixture(st);
    const agent = await f.addAgent('北京');
    const target = await f.manualBatch(agent);
    const previous = process.env.CAPTURE_DEAD_ATTENTION_SWEEP;
    process.env.CAPTURE_DEAD_ATTENTION_SWEEP = 'off';
    try {
      const off = await f.sweep();
      assert.equal(off.disabled, true);
      assert.equal((await f.row(target.id)).status, 'needs_action');
    } finally {
      if (previous === undefined) delete process.env.CAPTURE_DEAD_ATTENTION_SWEEP;
      else process.env.CAPTURE_DEAD_ATTENTION_SWEEP = previous;
    }
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM capture_tasks WHERE id=$1 FOR UPDATE', [target.id]);
      const busy = await f.sweep();
      assert.equal(busy.busy, 1, JSON.stringify(busy));
      assert.equal(busy.settled, 0);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    assert.equal((await f.row(target.id)).status, 'needs_action', 'untouched while locked');
    assert.equal((await f.sweep()).settled, 1, 'settled on the next round');

    // The automatic conditions are judged again under the lock: a mark that
    // arrives between the read and the close refuses it.
    const late = await f.manualBatch(agent);
    const refused = await withTransaction(tx => closeOperatorAttentionRoot(tx, {
      tenantId: f.tenant.id, rootId: late.id, mode: 'automatic', actor: {type: 'system'},
      refreshOrchestrationParent: async () => {},
      verify: async () => 'manual_action_required',
    }));
    assert.deepEqual(refused, {error: 'task_not_closeable', reason: 'manual_action_required'});
    assert.equal((await f.row(late.id)).status, 'needs_action');
  });
});
