import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {keywordRetrySourceReleased} from '../../../web/admin/src/pages/dispatch/cloud-tasks/retry-item-allocation.js';

// docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md
// F1: a retryable keyword whose untried pool nodes cannot claim it (09-27:
//     上海/火星 fenced by the batch's own needs_action children) opens to the
//     other pool nodes after a bounded wait, never to the last node again.
// F2: the same XHS time-filter failure K times settles the keyword as failed.
const TF = 'XHS_SEARCH_TIME_FILTER_UNVERIFIED';
const TECHNICAL = 'XHS_SEARCH_PAGE_TIMEOUT';
const TF_MESSAGE = '结果卡片 0/基线 20；等待 8 秒';
const SETTLED_MESSAGE = '多台节点都无法确认小红书时间筛选结果（可能该时段没有新内容或页面有变化），已停止自动重试；可稍后在批次里「重试失败关键词」';
const STOP_ERROR = {
  code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
  message: '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续',
};
const NAMES = ['上海', '北京', '成都', '重庆', '木星', '火星', '金星', '霸王龙'];
const capabilities = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, taskStateKnown: true,
  heartbeatDegraded: false, supportedPlatforms: ['xiaohongshu'],
};
const xhsPlan = keywords => ({
  enabled: true, platform: 'xiaohongshu', keywords, keywordMaxDetectedItems: 5,
  searchPasses: ['all'], searchFilters: {publishTime: 'day'},
  recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true},
});
const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();

test('elastic retry rounds relax after a bounded wait and repeated time-filter failures settle', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {normalizeCloudTaskSnapshot} = await import('../../../server/services/capture-cloud.js');
  const {dispatchNextElasticWorkItem, mirrorTaskSnapshot} = await import('../../../server/routes/capture-cloud.js');
  const {createAndroidControlService} = await import('../../../server/services/android-control/service.js');
  const {createApp} = await import('../../../server/app.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
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
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function fixture(st, {names = NAMES, platform = 'xiaohongshu'} = {}) {
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Elastic stuck retry ${randomUUID()}`]);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const [code] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at)
      VALUES($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, randomUUID()]);
    const agents = [];
    for (const name of names) {
      const [binding] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,
        status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,app_version,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES($1,$2,$3,'active',ARRAY[$4],$5,$6,$7,'0.4.18',now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), name, platform, code.id, binding.id, capabilities]);
      agents.push(agent);
    }
    const byName = name => {
      const agent = agents.find(row => row.display_name === name);
      assert.ok(agent, name);
      return agent;
    };
    const email = `stuck-retry-${randomUUID()}@integration.invalid`;
    const password = 'stuck-retry-integration-only';
    const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
      VALUES($1,'运营 值班',$2,'active',false) RETURNING id`, [email, hashPassword(password)]);
    st.after(() => query('DELETE FROM users WHERE id=$1', [user.id]));
    await query(`INSERT INTO user_memberships(user_id,tenant_id,role,status)
      VALUES($1,$2,'tenant_admin','active')`, [user.id, tenant.id]);
    const login = await fetch(`${origin}/api/auth/login`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
    assert.equal(login.status, 200);
    const session = await login.json();
    return {tenant, agents, byName, session};
  }

  async function adminPost(f, path, body) {
    const response = await fetch(`${origin}/api/capture-cloud${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${f.session.token}`,
        'x-tenant-id': f.tenant.id},
      body: JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  }

  async function adminGet(f, path) {
    const response = await fetch(`${origin}/api/capture-cloud${path}`, {
      headers: {authorization: `Bearer ${f.session.token}`, 'x-tenant-id': f.tenant.id},
    });
    return {status: response.status, body: await response.json()};
  }

  const row = async (table, id) => (await query(`SELECT * FROM ${table} WHERE id=$1`, [id]))[0];
  const itemRow = id => row('capture_task_items', id);

  async function batch(f, {keywords, status = 'needs_action', poolNames = NAMES, schedule = false,
    negativePatrolRun = false} = {}) {
    const metadata = {
      distributionMode: 'elastic_pool',
      eligibleAgentIds: poolNames.map(name => f.byName(name).id),
      planSnapshot: xhsPlan(keywords),
      ...(negativePatrolRun ? {negativePatrolRun: {timezone: 'Asia/Shanghai'}} : {}),
    };
    let scheduleId = null;
    if (schedule) {
      const [template] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,
        platform,status,title,metadata) VALUES($1,$2,'capture_orchestration','keyword_orchestration',
        'xiaohongshu','pending','小红书~日常+负面巡检',$3) RETURNING id`,
      [f.tenant.id, randomUUID(), {orchestrationTemplate: true, distributionMode: 'elastic_pool'}]);
      scheduleId = randomUUID();
      await query(`INSERT INTO capture_orchestration_schedules(id,tenant_id,template_task_id,title,platform,
        status,distribution_mode,plan_snapshot,next_run_at) VALUES($1,$2,$3,'小红书~日常+负面巡检',
        'xiaohongshu','active','elastic_pool',$4,now()+interval '1 day')`,
      [scheduleId, f.tenant.id, template.id, xhsPlan(keywords)]);
      metadata.orchestrationScheduleRun = true;
    }
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,
      platform,status,title,metadata,counts,orchestration_revision,orchestration_schedule_id)
      VALUES($1,$2,'capture_orchestration','keyword_orchestration','xiaohongshu',$3,
        '小红书~日常+负面巡检 · 09/27 03:30',$4,$5,1,$6) RETURNING *`,
    [f.tenant.id, randomUUID(), status, metadata, {total: keywords.length}, scheduleId]);
    if (scheduleId) {
      await query('UPDATE capture_orchestration_schedules SET last_run_task_id=$1,last_run_status=$2 WHERE id=$3',
        [parent.id, status, scheduleId]);
    }
    const items = [];
    for (const [ordinal, keyword] of keywords.entries()) {
      const [item] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,
        platform,status,ordinal,metadata) VALUES($1,$2,$3,'keyword',$4,'xiaohongshu','pending',$5,$6) RETURNING *`,
      [f.tenant.id, parent.id, `keyword:${ordinal}:${keyword}`, keyword, ordinal,
        {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
      items.push(item);
    }
    return {parent, items, scheduleId};
  }

  async function childTask(f, parent, agent, {status = 'completed_with_failures', error = {}} = {}) {
    const [child] = await query(`INSERT INTO capture_tasks(tenant_id,parent_task_id,origin_agent_id,assigned_agent_id,
      client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,error,metadata,
      started_at,finished_at) VALUES($1,$2,$3,$3,$4,'unattended_keyword_capture','unattended_keyword_plan',
      $5,'xiaohongshu','cloud','elastic_pool_claim',$6,$7,$8,now()-interval '2 hours',now()-interval '1 hour')
      RETURNING *`,
    [f.tenant.id, parent.id, agent.id, randomUUID(), `${parent.title} · 子任务`, status, error,
      {orchestrationChild: true, parentTaskId: parent.id}]);
    return child;
  }

  // Durable history of an item that already failed on `names` (in order).
  async function seedAttempts(f, parent, item, names, {code = TF, anchor = minutesAgo(5)} = {}) {
    let child;
    for (const [index, name] of names.entries()) {
      const agent = f.byName(name);
      child = await childTask(f, parent, agent);
      await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,
        agent_id,attempt_number,assignment_revision,status,error,checkpoint,started_at,finished_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6::integer,$6::integer,'retryable',$7,$8,now()-interval '2 hours',
          now()-interval '1 hour',now()-interval '3 hours'+($6::integer * interval '1 minute'))`,
      [f.tenant.id, item.id, parent.id, child.id, agent.id, index + 1,
        {code, message: TF_MESSAGE}, {errorCode: code, keyword: item.keyword}]);
    }
    const last = f.byName(names.at(-1));
    await query(`UPDATE capture_task_items SET status='retryable',attempt_count=$2,assignment_revision=$2,
      assigned_agent_id=$3,execution_task_id=$4,error=$5,started_at=now()-interval '2 hours',
      metadata=metadata || jsonb_build_object('elasticAttemptBudgetUsed',$2::integer,'checkpoint',$6::jsonb)
      WHERE id=$1`,
    [item.id, names.length, last.id, child.id, {code, message: TF_MESSAGE},
      {keyword: item.keyword, status: 'failed', errorCode: code,
        recovery: {state: 'released_for_handoff', attemptCurrent: names.length, sourceAgentId: last.id,
          handoffReadyAt: anchor, queuedAt: anchor}}]);
    return child;
  }

  // 09-27: a node whose earlier keyword of THIS batch reported an unconfirmed
  // stop; the admission fence keeps it from claiming anything.
  async function fence(f, parent, name, keyword) {
    const agent = f.byName(name);
    const child = await childTask(f, parent, agent, {status: 'needs_action', error: STOP_ERROR});
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,status,
      ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count,assignment_revision,error,started_at)
      VALUES($1,$2,$3,'keyword',$4,'xiaohongshu','needs_action',100 + $5,'{}'::jsonb,$6,$7,1,1,$8,now())`,
    [f.tenant.id, parent.id, `keyword:fenced:${keyword}`, keyword, NAMES.indexOf(name), agent.id, child.id, STOP_ERROR]);
    return child;
  }

  function recordingTx(tx, log) {
    const wrap = method => (sql, params) => {
      log.push(String(sql));
      return tx[method](sql, params);
    };
    return {...tx, query: wrap('query'), queryAll: wrap('queryAll'), queryOne: wrap('queryOne'), execute: wrap('execute')};
  }

  async function claim(f, name, log = null) {
    return withTransaction(tx => dispatchNextElasticWorkItem(log ? recordingTx(tx, log) : tx,
      {agent: f.byName(name), capabilities}));
  }

  async function report(f, claimed, {keyword, status = 'failed', code = TF, active = false} = {}) {
    const command = await row('capture_agent_commands', claimed.commandId);
    const child = await row('capture_tasks', claimed.childTaskId);
    const now = new Date().toISOString();
    const failed = status !== 'completed';
    const entry = {
      keyword, round: 1, status: failed ? 'failed' : 'completed', savedCount: failed ? 0 : 3,
      attemptCount: 1, finishedAt: now,
      ...(failed ? {errorCode: code, errorCategory: code === TF ? 'filter_verification' : 'technical',
        error: {code, message: TF_MESSAGE}} : {}),
    };
    const snapshot = normalizeCloudTaskSnapshot({
      id: child.client_task_id, controlTaskId: child.id,
      attemptId: command.payload.attemptIdentity || randomUUID(), attemptNumber: 1, status,
      platform: 'xiaohongshu', taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan',
      source: 'cloud', triggerType: 'orchestration', title: child.title,
      createdAt: child.created_at.toISOString(), updatedAt: now, startedAt: now, finishedAt: now,
      heartbeatAt: now, progressSeq: 1, progress: {keyword},
      counts: {success: failed ? 0 : 1, failed: failed ? 1 : 0, total: 1},
      checkpoint: active
        ? {round: 1, activeKeyword: keyword, errorCode: failed ? code : ''}
        : {round: 1, keywordResults: [entry]},
      error: failed ? {code, message: TF_MESSAGE} : {},
      metadata: {planSnapshot: command.payload.planSnapshot},
    });
    const agent = f.agents.find(candidate => candidate.id === command.agent_id);
    const mirrored = await withTransaction(tx => mirrorTaskSnapshot(tx, agent, snapshot));
    assert.equal(mirrored.id, child.id);
    return mirrored;
  }

  async function setAnchor(itemId, {checkpoint, error, waiting, updatedAt} = {}) {
    await query(`UPDATE capture_task_items SET
      metadata = CASE WHEN $2::text IS NULL THEN metadata #- '{checkpoint,recovery}'
        ELSE jsonb_set(metadata, '{checkpoint}', COALESCE(metadata->'checkpoint','{}'::jsonb)
          || jsonb_build_object('recovery', jsonb_build_object('handoffReadyAt', $2::text))) END,
      error = CASE WHEN $3::text IS NULL THEN error - 'recovery'
        ELSE error || jsonb_build_object('recovery', jsonb_build_object('handoffReadyAt', $3::text)) END
      WHERE id=$1`, [itemId, checkpoint ?? null, error ?? null]);
    await query(`UPDATE capture_task_items SET metadata = CASE WHEN $2::text IS NULL
        THEN metadata - 'elasticRetryWaitingSince'
        ELSE metadata || jsonb_build_object('elasticRetryWaitingSince', $2::text) END
      WHERE id=$1`, [itemId, waiting ?? null]);
    if (updatedAt) await query('UPDATE capture_task_items SET updated_at=$2 WHERE id=$1', [itemId, updatedAt]);
  }

  const dispatchedEvent = async childTaskId => (await query(`SELECT payload FROM capture_task_events
    WHERE task_id=$1 AND event_type='elastic_work_item_dispatched'`, [childTaskId]))[0]?.payload;

  // The 09-27 batch: keyword X failed on 6 nodes with a neutral technical code
  // (F1 only); 上海 and 火星 are the untried nodes, both fenced.
  async function replay0927(st) {
    const f = await fixture(st);
    const {parent, items: [item]} = await batch(f, {keywords: ['上汽通用客服']});
    await seedAttempts(f, parent, item, ['霸王龙', '成都', '重庆', '金星', '北京', '木星'],
      {code: TECHNICAL, anchor: minutesAgo(5)});
    await fence(f, parent, '火星', '别克哨兵');
    await fence(f, parent, '上海', 'ibuick');
    return {f, parent, item};
  }

  await t.test('F1 replay: untried fenced nodes keep the keyword waiting only for the relax window', async st => {
    const {f, parent, item} = await replay0927(st);
    for (const name of NAMES) assert.equal(await claim(f, name), null, `${name} before the window`);
    await setAnchor(item.id, {checkpoint: minutesAgo(9)});
    for (const name of NAMES) assert.equal(await claim(f, name), null, `${name} at 9 minutes`);

    await setAnchor(item.id, {checkpoint: minutesAgo(11)});
    assert.equal(await claim(f, '木星'), null, 'the source node never takes the keyword back-to-back');
    assert.equal(await claim(f, '上海'), null, 'a fenced node stays fenced');
    assert.equal(await claim(f, '火星'), null, 'a fenced node stays fenced');
    const chengdu = await claim(f, '成都');
    assert.ok(chengdu?.commandId, JSON.stringify(chengdu));
    assert.equal((await itemRow(item.id)).attempt_count, 7);
    const event = await dispatchedEvent(chengdu.childTaskId);
    assert.equal(event.roundExclusionRelaxed, true);
    assert.equal(event.attemptNumber, 7);

    await report(f, chengdu, {keyword: item.keyword, code: TECHNICAL});
    const afterFailure = await itemRow(item.id);
    assert.equal(afterFailure.status, 'retryable');
    assert.ok(Date.parse(afterFailure.metadata.checkpoint.recovery.handoffReadyAt) > Date.now() - 60_000,
      'a new failure writes a fresh anchor');
    assert.equal(await claim(f, '成都'), null, 'no back-to-back retry by the same node');
    assert.equal(await claim(f, '北京'), null, 'MOD(7, 8) still excludes 北京 before the window');
    await setAnchor(item.id, {checkpoint: minutesAgo(11)});
    assert.equal(await claim(f, '成都'), null, 'relaxed rounds still exclude the most recent node');
    const beijing = await claim(f, '北京');
    assert.ok(beijing?.commandId, JSON.stringify(beijing));
    assert.equal((await dispatchedEvent(beijing.childTaskId)).roundExclusionRelaxed, true);
    assert.equal((await row('capture_tasks', parent.id)).status !== 'completed', true);
  });

  await t.test('F1 anchors: the newest wait counts, malformed values fall back, budget and env still apply', async st => {
    const {f, item} = await replay0927(st);
    // A manual retry wait started a minute ago; the 60-minute-old projection
    // anchor must not open the round early.
    await setAnchor(item.id, {checkpoint: minutesAgo(60), waiting: minutesAgo(1)});
    assert.equal(await claim(f, '成都'), null);
    // jsonb_build_object(now()) writes a +08:00 offset, not Z.
    const shanghai = minutes => new Date(Date.now() - minutes * 60_000 + 8 * 3600_000)
      .toISOString().replace('Z', '+08:00');
    await setAnchor(item.id, {checkpoint: minutesAgo(60), waiting: shanghai(9)});
    assert.equal(await claim(f, '成都'), null, 'a +08:00 waiting start is parsed');
    await setAnchor(item.id, {checkpoint: minutesAgo(60), waiting: shanghai(11)});
    const relaxed = await claim(f, '成都');
    assert.ok(relaxed?.commandId, JSON.stringify(relaxed));
    const claimed = await itemRow(item.id);
    assert.equal(claimed.metadata.elasticRetryWaitingSince, undefined, 'the claim ends the waiting window');
    assert.equal(claimed.metadata.checkpoint, undefined);

    // An active-keyword anchor newer than the projection anchor wins as well.
    const e = await replay0927(st);
    await setAnchor(e.item.id, {checkpoint: minutesAgo(60), error: minutesAgo(1)});
    assert.equal(await claim(e.f, '成都'), null, 'error.recovery newer than checkpoint.recovery');
    await setAnchor(e.item.id, {checkpoint: minutesAgo(60), error: minutesAgo(12)});
    assert.ok((await claim(e.f, '成都'))?.commandId);

    // Legacy item without any anchor: updated_at is the fallback.
    const g = await replay0927(st);
    await setAnchor(g.item.id, {updatedAt: minutesAgo(1)});
    assert.equal(await claim(g.f, '成都'), null);
    await setAnchor(g.item.id, {updatedAt: minutesAgo(11)});
    assert.ok((await claim(g.f, '成都'))?.commandId);

    // Malformed anchors never break the claim statement.
    const h = await replay0927(st);
    await setAnchor(h.item.id, {checkpoint: '2026-02-30T00:00:00Z', error: '2026-13-45T99:00:00Z',
      waiting: 'not-a-time', updatedAt: minutesAgo(11)});
    assert.ok((await claim(h.f, '成都'))?.commandId, 'invalid anchors fall back to updated_at');

    // The 16-attempt budget still bounds a relaxed round.
    const k = await replay0927(st);
    await query(`UPDATE capture_task_items SET attempt_count=16,
      metadata=metadata || '{"elasticAttemptBudgetUsed":16}'::jsonb WHERE id=$1`, [k.item.id]);
    await setAnchor(k.item.id, {checkpoint: minutesAgo(60)});
    for (const name of NAMES) assert.equal(await claim(k.f, name), null, `${name} past the budget`);

    // CAPTURE_ELASTIC_ROUND_RELAX_MINUTES=1
    const m = await replay0927(st);
    await setAnchor(m.item.id, {checkpoint: minutesAgo(2)});
    assert.equal(await claim(m.f, '成都'), null);
    const previous = process.env.CAPTURE_ELASTIC_ROUND_RELAX_MINUTES;
    process.env.CAPTURE_ELASTIC_ROUND_RELAX_MINUTES = '1';
    try {
      assert.ok((await claim(m.f, '成都'))?.commandId);
    } finally {
      if (previous === undefined) delete process.env.CAPTURE_ELASTIC_ROUND_RELAX_MINUTES;
      else process.env.CAPTURE_ELASTIC_ROUND_RELAX_MINUTES = previous;
    }
  });

  await t.test('F2: the third time-filter failure settles the keyword and the scheduled batch', async st => {
    const f = await fixture(st, {names: ['节点 0', '节点 1', '节点 2', '节点 3']});
    const poolNames = ['节点 0', '节点 1', '节点 2', '节点 3'];
    const {parent, items: [a, b], scheduleId} = await batch(f, {keywords: ['安吉星壁纸', '君越壁纸'],
      status: 'pending', poolNames, schedule: true, negativePatrolRun: true});
    const first = await claim(f, '节点 0');
    assert.equal(first.itemId, a.id);
    await report(f, first, {keyword: a.keyword});
    assert.equal((await itemRow(a.id)).status, 'retryable');
    const other = await claim(f, '节点 1');
    assert.equal(other.itemId, b.id, 'fresh keywords go first');
    await report(f, other, {keyword: b.keyword, status: 'completed'});
    const second = await claim(f, '节点 1');
    assert.equal(second.itemId, a.id);
    await report(f, second, {keyword: a.keyword});
    assert.equal((await itemRow(a.id)).status, 'retryable', 'two failures keep retrying');
    const third = await claim(f, '节点 2');
    assert.equal(third.itemId, a.id);
    await report(f, third, {keyword: a.keyword});

    const settled = await itemRow(a.id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error.message, SETTLED_MESSAGE);
    assert.equal(settled.error.originalMessage, TF_MESSAGE);
    assert.equal(settled.error.code, TF);
    assert.equal(settled.error.automaticRetryStopReason, 'filter_verification_repeated');
    assert.equal(settled.error.filterVerificationAttemptCount, 3);
    assert.equal(settled.error.filterVerificationAgentCount, 3);
    assert.equal(settled.error.recoveryLimitReached, undefined);
    assert.equal(settled.error.recovery, undefined);
    assert.equal(settled.metadata.checkpoint.recovery, undefined);
    assert.ok(settled.finished_at);
    const [attempt] = await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1 AND attempt_number=3', [a.id]);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error.automaticRetryStopReason, 'filter_verification_repeated');

    const parentRow = await row('capture_tasks', parent.id);
    assert.equal(parentRow.status, 'completed_with_failures');
    assert.equal(parentRow.message, '本轮关键词采集与负面巡查已结算');
    const [schedule] = await query('SELECT * FROM capture_orchestration_schedules WHERE id=$1', [scheduleId]);
    assert.equal(schedule.last_run_status, 'completed_with_failures');
    assert.equal(schedule.last_error.code, 'scheduled_run_settled_with_failures');
    const events = await query(`SELECT * FROM capture_task_events WHERE task_id=$1
      AND event_type='elastic_item_filter_verification_settled'`, [parent.id]);
    assert.equal(events.length, 1);
    assert.equal(events[0].message, '关键词「安吉星壁纸」时间筛选已失败 3 次（3 台节点），无法确认小红书时间筛选，已停止自动重试');
    assert.deepEqual(events[0].payload, {itemId: a.id, keyword: a.keyword, errorCode: TF,
      attemptCount: 3, agentCount: 3, limit: 3, settledAt: 'projection'});
    assert.equal(await claim(f, '节点 3'), null, 'nothing left to search');

    // A repeated terminal snapshot of the same failure changes nothing.
    await report(f, third, {keyword: a.keyword});
    assert.equal((await itemRow(a.id)).status, 'failed');
    assert.equal((await query(`SELECT count(*)::int n FROM capture_task_events WHERE task_id=$1
      AND event_type='elastic_item_filter_verification_settled'`, [parent.id]))[0].n, 1);
  });

  await t.test('F2 counts repeated nodes, settles a two-node pool after one round, and ignores other codes', async st => {
    // 节点 0, 1, 0 (the active-keyword path reports the third failure).
    const f = await fixture(st, {names: ['节点 0', '节点 1', '节点 2', '节点 3']});
    const {items: [a]} = await batch(f, {keywords: ['月兔栖梦'], status: 'pending',
      poolNames: ['节点 0', '节点 1', '节点 2', '节点 3']});
    await report(f, await claim(f, '节点 0'), {keyword: a.keyword});
    await report(f, await claim(f, '节点 1'), {keyword: a.keyword});
    assert.equal(await claim(f, '节点 0'), null, 'still inside the round');
    await setAnchor(a.id, {checkpoint: minutesAgo(11)});
    const again = await claim(f, '节点 0');
    assert.equal(again.itemId, a.id);
    await report(f, again, {keyword: a.keyword, active: true});
    const settled = await itemRow(a.id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error.filterVerificationAttemptCount, 3);
    assert.equal(settled.error.filterVerificationAgentCount, 2);
    assert.equal(settled.metadata.checkpoint?.recovery, undefined);
    assert.equal(settled.error.recovery, undefined);

    // A pool of two: one failure per node.
    const g = await fixture(st, {names: ['节点 A', '节点 B']});
    const {items: [pair]} = await batch(g, {keywords: ['昂科威壁纸'], status: 'pending',
      poolNames: ['节点 A', '节点 B']});
    await report(g, await claim(g, '节点 A'), {keyword: pair.keyword});
    assert.equal((await itemRow(pair.id)).status, 'retryable');
    await report(g, await claim(g, '节点 B'), {keyword: pair.keyword});
    assert.equal((await itemRow(pair.id)).status, 'failed', 'no second round for the whole pool');

    // Technical failures on three nodes keep the original behavior.
    const h = await fixture(st, {names: ['节点 0', '节点 1', '节点 2', '节点 3']});
    const {items: [tech]} = await batch(h, {keywords: ['别克车机'], status: 'pending',
      poolNames: ['节点 0', '节点 1', '节点 2', '节点 3']});
    for (const name of ['节点 0', '节点 1', '节点 2']) {
      await report(h, await claim(h, name), {keyword: tech.keyword, code: TECHNICAL});
    }
    assert.equal((await itemRow(tech.id)).status, 'retryable');
  });

  await t.test('F1+F2: two claimable nodes alternating stop after three searches', async st => {
    const f = await fixture(st);
    const {items: [item]} = await batch(f, {keywords: ['安吉星壁纸'], status: 'running'});
    const {parent} = {parent: await row('capture_tasks', item.task_id)};
    await fence(f, parent, '上海', 'ibuick');
    await fence(f, parent, '火星', '别克哨兵');
    const searches = [];
    const a1 = await claim(f, '成都');
    searches.push(a1);
    await report(f, a1, {keyword: item.keyword});
    const b1 = await claim(f, '重庆');
    searches.push(b1);
    await report(f, b1, {keyword: item.keyword});
    assert.equal(await claim(f, '成都'), null);
    await setAnchor(item.id, {checkpoint: minutesAgo(11)});
    const a2 = await claim(f, '成都');
    assert.ok(a2?.commandId);
    searches.push(a2);
    await report(f, a2, {keyword: item.keyword});
    assert.equal((await itemRow(item.id)).status, 'failed');
    assert.equal(await claim(f, '重庆'), null);
    await setAnchor(item.id, {checkpoint: minutesAgo(30)});
    assert.equal(await claim(f, '重庆'), null);
    assert.equal(searches.length, 3);
    assert.equal((await query(`SELECT count(*)::int n FROM capture_agent_commands WHERE tenant_id=$1
      AND command_type='create'`, [f.tenant.id]))[0].n, 3, 'three time-filter searches in total');
  });

  await t.test('重试失败关键词 opens a new window: dispatch and elastic waiting both keep retrying', async st => {
    const f = await fixture(st, {names: ['节点 0', '节点 1', '节点 2', '节点 3']});
    const poolNames = ['节点 0', '节点 1', '节点 2', '节点 3'];
    const {parent, items: [a, b]} = await batch(f, {keywords: ['安吉星壁纸', '君越壁纸'], status: 'pending', poolNames});
    await report(f, await claim(f, '节点 0'), {keyword: a.keyword});
    await report(f, await claim(f, '节点 1'), {keyword: b.keyword, status: 'completed'});
    await report(f, await claim(f, '节点 1'), {keyword: a.keyword});
    await report(f, await claim(f, '节点 2'), {keyword: a.keyword});
    assert.equal((await itemRow(a.id)).status, 'failed');
    assert.equal((await row('capture_tasks', parent.id)).status, 'completed_with_failures');

    // No node has usage today: the retry waits in the elastic queue.
    const waitingResponse = await adminPost(f, `/orchestrations/${parent.id}/retry-items`, {
      requestKey: randomUUID(),
      expectedRevision: Number((await row('capture_tasks', parent.id)).orchestration_revision),
      itemIds: [a.id],
    });
    assert.equal(waitingResponse.status, 201, JSON.stringify(waitingResponse.body));
    const waiting = await itemRow(a.id);
    assert.equal(waiting.status, 'retryable');
    assert.equal(waiting.metadata.filterVerificationBaseAttemptCount, 3);
    assert.ok(waiting.metadata.elasticRetryWaitingSince);
    assert.equal(waiting.error.code, TF);
    assert.equal(waiting.error.message, TF_MESSAGE, 'the original failure is shown again');
    assert.equal(waiting.error.automaticRetryStopped, undefined);
    // A stale projection anchor must not open the round: the wait just began.
    await setAnchor(a.id, {checkpoint: minutesAgo(60), waiting: waiting.metadata.elasticRetryWaitingSince});
    assert.equal(await claim(f, '节点 0'), null, 'tried nodes wait for the relax window');
    // The claim-time backstop sees a new window and does not settle it.
    const retried = await claim(f, '节点 3');
    assert.equal(retried?.itemId, a.id, JSON.stringify(retried));
    assert.equal((await itemRow(a.id)).status, 'dispatched');
    await report(f, retried, {keyword: a.keyword});
    const afterRetry = await itemRow(a.id);
    assert.equal(afterRetry.status, 'retryable', 'one failure in the new window keeps retrying');
    assert.equal(afterRetry.error.automaticRetryStopped, undefined);

    // Direct dispatch: the retry lands on an idle node and fails once more.
    const g = await fixture(st, {names: ['节点 0', '节点 1', '节点 2', '节点 3']});
    const second = await batch(g, {keywords: ['安吉星壁纸'], status: 'pending', poolNames});
    const item = second.items[0];
    await report(g, await claim(g, '节点 0'), {keyword: item.keyword});
    await report(g, await claim(g, '节点 1'), {keyword: item.keyword});
    await report(g, await claim(g, '节点 2'), {keyword: item.keyword});
    assert.equal((await itemRow(item.id)).status, 'failed');
    await query(`INSERT INTO social_agent_daily_usage(tenant_id,agent_id,platform,usage_date,searches,last_event_at)
      VALUES($1,$2,'xiaohongshu',(now() AT TIME ZONE 'Asia/Shanghai')::date,1,now())`,
    [g.tenant.id, g.byName('节点 3').id]);
    const dispatched = await adminPost(g, `/orchestrations/${second.parent.id}/retry-items`, {
      requestKey: randomUUID(),
      expectedRevision: Number((await row('capture_tasks', second.parent.id)).orchestration_revision),
      itemIds: [item.id],
    });
    assert.equal(dispatched.status, 201, JSON.stringify(dispatched.body));
    const direct = await itemRow(item.id);
    assert.equal(direct.status, 'dispatched');
    assert.equal(direct.assigned_agent_id, g.byName('节点 3').id);
    assert.equal(direct.metadata.filterVerificationBaseAttemptCount, 3);
    const [command] = await query(`SELECT * FROM capture_agent_commands WHERE task_id=$1`, [direct.execution_task_id]);
    await report(g, {commandId: command.id, childTaskId: direct.execution_task_id}, {keyword: item.keyword});
    assert.equal((await itemRow(item.id)).status, 'retryable', 'the manual retry has its own K attempts');
  });

  await t.test('F2 backstop: legacy retryable keywords settle in one claim without searching', async st => {
    const f = await fixture(st);
    const keywords = ['安吉星壁纸', '上汽通用客服', '月兔栖梦', '君越壁纸', '昂科威壁纸'];
    const {parent, items} = await batch(f, {keywords, status: 'needs_action'});
    await seedAttempts(f, parent, items[0], ['火星', '成都', '霸王龙', '重庆', '金星', '北京', '木星'],
      {anchor: minutesAgo(60)});
    for (const item of items.slice(1)) {
      await seedAttempts(f, parent, item, ['霸王龙', '成都', '重庆', '金星', '北京', '木星'],
        {anchor: minutesAgo(60)});
    }
    await fence(f, parent, '火星', '别克哨兵');
    await fence(f, parent, '上海', 'ibuick');
    const count = async sql => (await query(sql, [f.tenant.id]))[0].n;
    const commandsBefore = await count('SELECT count(*)::int n FROM capture_agent_commands WHERE tenant_id=$1');
    const tasksBefore = await count('SELECT count(*)::int n FROM capture_tasks WHERE tenant_id=$1');

    const log = [];
    assert.equal(await claim(f, '成都', log), null, 'nothing is dispatched');
    assert.equal(log.filter(sql => sql.includes('PREVIOUS_CAPTURE_STOP_UNCONFIRMED')).length, 1,
      'the stop-fence SQL runs once per heartbeat');
    assert.equal(log.filter(sql => /SELECT status\s+FROM capture_task_items\s+WHERE task_id = \$1 AND tenant_id = \$2/u.test(sql)).length,
      1, 'the parent is refreshed once');
    assert.equal(await count('SELECT count(*)::int n FROM capture_agent_commands WHERE tenant_id=$1'), commandsBefore);
    assert.equal(await count('SELECT count(*)::int n FROM capture_tasks WHERE tenant_id=$1'), tasksBefore);

    for (const [index, item] of items.entries()) {
      const settled = await itemRow(item.id);
      assert.equal(settled.status, 'failed', item.keyword);
      assert.equal(settled.attempt_count, index === 0 ? 7 : 6);
      assert.equal(settled.error.message, SETTLED_MESSAGE);
      assert.equal(settled.error.originalMessage, TF_MESSAGE);
      assert.equal(settled.error.filterVerificationAttemptCount, index === 0 ? 7 : 6);
      assert.equal(settled.error.recovery, undefined);
      assert.equal(settled.metadata.checkpoint.recovery, undefined, 'no stale anchor survives');
      const [lastAttempt] = await query(`SELECT * FROM capture_task_item_attempts WHERE item_id=$1
        ORDER BY attempt_number DESC LIMIT 1`, [item.id]);
      assert.equal(lastAttempt.status, 'failed');
    }
    const events = await query(`SELECT * FROM capture_task_events WHERE task_id=$1
      AND event_type='elastic_item_filter_verification_settled' ORDER BY payload->>'keyword'`, [parent.id]);
    assert.equal(events.length, 5);
    assert.ok(events.every(event => event.payload.settledAt === 'claim'));
    assert.equal((await row('capture_tasks', parent.id)).status, 'needs_action',
      'the two fenced keywords still need 确认旧页面已停止');
    // A later heartbeat has nothing to settle or claim.
    const again = [];
    assert.equal(await claim(f, '北京', again), null);
    assert.equal(again.filter(sql => sql.includes('PREVIOUS_CAPTURE_STOP_UNCONFIRMED')).length, 1);
  });

  await t.test('09-27 after F2: the admin retry list leaves out fenced keywords and the server accepts it', async st => {
    const f = await fixture(st);
    const keywords = ['安吉星壁纸', '上汽通用客服', '月兔栖梦', '君越壁纸', '昂科威壁纸'];
    const {parent, items} = await batch(f, {keywords, status: 'needs_action'});
    await seedAttempts(f, parent, items[0], ['火星', '成都', '霸王龙', '重庆', '金星', '北京', '木星'],
      {anchor: minutesAgo(60)});
    for (const item of items.slice(1)) {
      await seedAttempts(f, parent, item, ['霸王龙', '成都', '重庆', '金星', '北京', '木星'],
        {anchor: minutesAgo(60)});
    }
    await fence(f, parent, '火星', '别克哨兵');
    await fence(f, parent, '上海', 'ibuick');
    assert.equal(await claim(f, '成都'), null);
    for (const item of items) assert.equal((await itemRow(item.id)).status, 'failed', item.keyword);

    // What OrchestrationDetailWorkspace submits: keyword items in a retry
    // status whose source passes keywordRetrySourceReleased (elastic pool).
    const detail = await adminGet(f, `/orchestrations/${parent.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body).slice(0, 400));
    const executionById = new Map(detail.body.executions.map(execution => [String(execution.id), execution]));
    const retryStatus = item => item.item_type === 'keyword' &&
      ['retryable', 'needs_action', 'failed'].includes(item.status);
    const adminItems = detail.body.items.filter(item => retryStatus(item) && keywordRetrySourceReleased({
      item, execution: executionById.get(String(item.execution_task_id)), elasticPool: true,
    }));
    assert.deepEqual(adminItems.map(item => item.keyword).sort(), [...keywords].sort(),
      'the fenced 别克哨兵/ibuick wait for 确认旧页面已停止 instead');
    assert.ok(adminItems.every(item => item.status === 'failed'), 'no automatic recovery hides the button');

    // Before the fix the admin also sent the needs_action keywords whose
    // source is fenced; the server refuses the whole request.
    const withFenced = detail.body.items.filter(item => retryStatus(item) &&
      executionById.has(String(item.execution_task_id)));
    assert.equal(withFenced.length, keywords.length + 2);
    const refused = await adminPost(f, `/orchestrations/${parent.id}/retry-items`, {
      requestKey: randomUUID(), expectedRevision: Number(detail.body.orchestration.revision),
      itemIds: withFenced.map(item => item.id),
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'retry_source_not_settled', JSON.stringify(refused.body));

    const accepted = await adminPost(f, `/orchestrations/${parent.id}/retry-items`, {
      requestKey: randomUUID(), expectedRevision: Number(detail.body.orchestration.revision),
      itemIds: adminItems.map(item => item.id),
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    for (const item of items) {
      assert.ok(['retryable', 'dispatched'].includes((await itemRow(item.id)).status), item.keyword);
    }
    const fencedItems = await query(`SELECT status FROM capture_task_items WHERE task_id=$1
      AND item_key LIKE 'keyword:fenced:%'`, [parent.id]);
    assert.deepEqual(fencedItems.map(item => item.status), ['needs_action', 'needs_action']);
  });

  await t.test('a phone claim drops stale anchors so a mixed pool restarts the relax window', async st => {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [randomUUID()]);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [tenantId]));
    const authCode = randomUUID();
    await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenantId, authCode]);
    const service = createAndroidControlService({enabledTenants: () => new Set([tenantId])});
    const registration = {code: authCode, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const registered = await service.register(registration);
    const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
    const principal = {tenantId, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const browserCapabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, singleRelayV1: true,
      taskStateKnown: true, supportedPlatforms: ['douyin']};
    const browsers = [];
    for (const name of ['浏览器 0', '浏览器 1']) {
      const [{id: codeId}] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at)
        VALUES($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenantId, randomUUID()]);
      const [{id: bindingId}] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [codeId, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,
        allowed_platforms,auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,
        last_liveness_at) VALUES($1,$2,$3,'active',ARRAY['douyin'],$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenantId, randomUUID(), name, codeId, bindingId, browserCapabilities]);
      browsers.push(agent);
    }
    const planSnapshot = {platform: 'douyin', keywords: ['别克君越壁纸'],
      searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'},
      keywordMaxDetectedItems: 40, mobileKeywordMaxMinutes: 12,
      recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true}};
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,title,
      platform,source,trigger_type,status,metadata,orchestration_revision,counts)
      VALUES($1,$2,'capture_orchestration','keyword_orchestration','手机弹性','douyin','cloud','manual','running',$3,1,
        '{"total":1}') RETURNING *`,
    [tenantId, randomUUID(), {distributionMode: 'elastic_pool', claimUnit: 'keyword', executionMode: 'one_time',
      eligibleAgentIds: [phone.id, ...browsers.map(agent => agent.id)], planSnapshot}]);
    const [source] = await query(`INSERT INTO capture_tasks(tenant_id,parent_task_id,origin_agent_id,assigned_agent_id,
      client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,error,metadata,finished_at)
      VALUES($1,$2,$3,$3,$4,'unattended_keyword_capture','unattended_keyword_plan','浏览器首轮','douyin','cloud',
        'elastic_pool_claim','failed','{"code":"DOUYIN_SEARCH_TIMEOUT"}',$5,now()-interval '1 hour') RETURNING *`,
    [tenantId, parent.id, browsers[0].id, randomUUID(), {orchestrationChild: true, parentTaskId: parent.id}]);
    const stale = minutesAgo(60);
    const [item] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,
      item_type,status,attempt_count,assigned_agent_id,execution_task_id,assignment_revision,error,metadata,started_at)
      VALUES($1,$2,'keyword:0',0,'别克君越壁纸','douyin','keyword','retryable',1,$3,$4,1,
        '{"code":"DOUYIN_SEARCH_TIMEOUT"}',$5,now()-interval '1 hour') RETURNING *`,
    [tenantId, parent.id, browsers[0].id, source.id,
      {checkpoint: {recovery: {handoffReadyAt: stale}}, elasticRetryWaitingSince: stale}]);
    await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,agent_id,
      attempt_number,assignment_revision,status,error) VALUES($1,$2,$3,$4,$5,1,1,'retryable','{"code":"DOUYIN_SEARCH_TIMEOUT"}')`,
    [tenantId, item.id, parent.id, source.id, browsers[0].id]);

    const claimed = await service.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true});
    assert.ok(claimed.task, JSON.stringify(claimed));
    const held = await itemRow(item.id);
    assert.equal(held.metadata.elasticRetryWaitingSince, undefined);
    assert.equal(held.metadata.checkpoint?.recovery, undefined);
    await service.complete(principal, {requestId: randomUUID(), identity: claimed.task.identity, sessionId,
      status: 'interrupted', deviceIdle: true});
    assert.equal((await itemRow(item.id)).status, 'retryable');
    const browserClaim = index => withTransaction(tx => dispatchNextElasticWorkItem(tx,
      {agent: browsers[index], capabilities: browserCapabilities}));
    assert.equal(await browserClaim(0), null, 'the round (phone, 浏览器 0) is not relaxed by old anchors');
    const untried = await browserClaim(1);
    assert.equal(untried?.itemId, item.id, JSON.stringify(untried));
  });
});
