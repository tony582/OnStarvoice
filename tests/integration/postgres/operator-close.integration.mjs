import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md F3/F3b: every row
// kind the 09-27 需处理 queue held (补详情, standalone phone runs, sidebar
// 「提前」, phone/browser elastic batches) can be ended and moved to history
// when nothing is live, and nothing that could still fence a node, own a
// device or be recovered automatically is ever closed. Late device reports,
// local recovery and 「继续」 cannot resurrect a closed row.
const STOP_ERROR = {
  code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
  message: '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续',
};
const TECHNICAL_ERROR = {code: 'XHS_SEARCH_PAGE_TIMEOUT', message: '搜索页加载超时'};
const XHS_CAPABILITIES = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, taskStateKnown: true,
  heartbeatDegraded: false, supportedPlatforms: ['xiaohongshu'],
};
const DISCOVERY_CAPABILITIES = {
  remoteTaskCreate: true, remoteTargetedPostCaptureV1: true, remoteStop: true,
  discoveredPostCaptureV1: true, supportedPlatforms: ['douyin'], taskStateKnown: true,
};
const xhsPlan = keywords => ({
  enabled: true, platform: 'xiaohongshu', keywords, keywordMaxDetectedItems: 5,
  searchPasses: ['all'], searchFilters: {publishTime: 'day'},
  recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true},
});
const ROOT_MESSAGE = '已结束并移到历史（未重新采集）';
const ORCHESTRATION_MESSAGE = '已由操作员结束并移到历史；未完成的工作项已标记失败，已完成结果保留';
const CHILD_MESSAGE = '已由操作员结束（未重新采集）';

test('operator close ends dead needs_action roots without releasing fences, live work or late receipts', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {createApp} = await import('../../../server/app.js');
  const {createSession} = await import('../../../server/services/auth-service.js');
  const {normalizeCloudTaskSnapshot, findCaptureAgentExecutionSlotBlocker} =
    await import('../../../server/services/capture-cloud.js');
  const {clearCaptureOverviewProjectionCache, dispatchNextElasticWorkItem, mirrorTaskSnapshot,
    reconcileAutomaticCaptureRetries, refreshOrchestrationParentTask} =
    await import('../../../server/routes/capture-cloud.js');
  const {RETRY_ITEMS_MOBILE_SOURCE_MESSAGE, reconcilePendingOrchestrationRetries} =
    await import('../../../server/routes/capture-orchestrations.js');
  const {loadOperatorCloseEligibility} = await import('../../../server/services/capture-operator-close.js');
  const {createAndroidControlService} = await import('../../../server/services/android-control/service.js');
  const {createDiscoveryRepository} = await import('../../../server/services/capture-discovery/repository.js');
  const {createDiscoveryService} = await import('../../../server/services/capture-discovery/service.js');
  const {createDiscoveryManagementService} = await import('../../../server/services/capture-discovery/management.js');
  const {dispatchDiscoveredPost} = await import('../../../server/services/capture-discovery/detail-dispatch.js');
  const {upsertCapturedRecord} = await import('../../../server/services/record-store.js');
  await import('../../../utils/cloud-task-agent.js');
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

  async function fixture(st) {
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Operator close ${randomUUID()}`]);
    const [foreign] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Operator close foreign ${randomUUID()}`]);
    const userIds = [];
    st.after(async () => {
      for (const table of ['capture_discovery_reprocess_requests', 'capture_discovery_run_candidates',
        'capture_discovery_events', 'capture_discovery_candidates']) {
        await query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [[tenant.id, foreign.id]]);
      }
      await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[tenant.id, foreign.id]]);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    });
    const [code] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at,max_bindings)
      VALUES($1,$2,'active',now()+interval '1 day',50) RETURNING *`, [tenant.id, randomUUID()]);
    const sessions = {};
    for (const role of ['tenant_admin', 'tenant_viewer']) {
      const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
        VALUES($1,$2,'integration-only','active',false) RETURNING id`,
      [`operator-close-${role}-${randomUUID()}@integration.invalid`, role === 'tenant_admin' ? '运营 值班' : '只读']);
      userIds.push(user.id);
      await query(`INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'active')`,
        [user.id, tenant.id, role]);
      sessions[role] = {...await createSession(user.id, {headers: {}}), userId: user.id};
    }
    async function request(path, {body, role = 'tenant_admin', tenantId = tenant.id} = {}) {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${sessions[role].token}`, 'x-tenant-id': tenantId,
          ...(body === undefined ? {} : {'content-type': 'application/json'}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      return {status: response.status, body: await response.json()};
    }
    async function addAgent(name, {platforms = ['xiaohongshu'], capabilities = XHS_CAPABILITIES, tenantId = tenant.id} = {}) {
      const [binding] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,
        allowed_platforms,auth_code_id,auth_binding_id,capabilities,app_version,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES($1,$2,$3,'active',$4,$5,$6,$7,'0.4.18',now(),now(),now()) RETURNING *`,
      [tenantId, randomUUID(), name, platforms, code.id, binding.id, capabilities]);
      return agent;
    }
    async function task(overrides = {}) {
      const data = {
        tenant_id: tenant.id, task_type: 'capture', status: 'needs_action', title: '提前',
        platform: 'xiaohongshu', source: 'sidebar', parent_task_id: null, origin_agent_id: null,
        client_task_id: randomUUID(), control_task_id: '', error: {}, metadata: {}, attempt_number: 1,
        orchestration_revision: 0, message: '',
        ...overrides,
      };
      const [row] = await query(`INSERT INTO capture_tasks(tenant_id,task_type,feature_key,status,title,platform,
        source,parent_task_id,origin_agent_id,assigned_agent_id,client_task_id,control_task_id,error,metadata,
        attempt_number,orchestration_revision,message,started_at)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,now()-interval '1 hour') RETURNING *`,
      [data.tenant_id, data.task_type, data.status, data.title, data.platform, data.source, data.parent_task_id,
        data.origin_agent_id, data.client_task_id, data.control_task_id, data.error, data.metadata,
        data.attempt_number, data.orchestration_revision, data.message]);
      return row;
    }
    async function batch({status = 'needs_action', platform = 'xiaohongshu', agents = [], metadata = {}, scheduleId = null} = {}) {
      return task({
        task_type: 'capture_orchestration', status, platform, source: 'cloud', title: '小红书~日常+负面巡检 · 09/27 03:30',
        attempt_number: 0, orchestration_revision: 1,
        metadata: {distributionMode: 'elastic_pool', claimUnit: 'keyword', eligibleAgentIds: agents.map(agent => agent.id),
          planSnapshot: xhsPlan(['君越壁纸']), ...metadata},
        ...(scheduleId ? {} : {}),
      });
    }
    async function child(parent, agent, {status = 'needs_action', error = TECHNICAL_ERROR, metadata = {}} = {}) {
      return task({
        task_type: 'unattended_keyword_capture', status, platform: parent.platform, source: 'cloud',
        parent_task_id: parent.id, origin_agent_id: agent.id, control_task_id: randomUUID(), error,
        title: `${parent.title} · 子任务`, metadata: {orchestrationChild: true, parentTaskId: parent.id, ...metadata},
      });
    }
    async function item(parent, {keyword = `词-${randomUUID().slice(0, 6)}`, status = 'needs_action', execution = null,
      agent = null, error = {}, metadata = {}, attemptCount = 1, revision = 1, attemptStatus, itemType = 'keyword',
      recordId = null} = {}) {
      const [row] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,
        status,ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count,assignment_revision,error,started_at,
        record_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT COUNT(*) FROM capture_task_items WHERE task_id=$2),$8,$9,$10,$11,$12,$13,
          now()-interval '1 hour',$14) RETURNING *`,
      [tenant.id, parent.id, `${itemType}:${randomUUID()}`, itemType, keyword, parent.platform, status, metadata,
        agent?.id || null, execution?.id || null, attemptCount, revision, error, recordId]);
      const attempt = attemptStatus === null || !agent ? null : (await query(`INSERT INTO capture_task_item_attempts(
        tenant_id,item_id,parent_task_id,execution_task_id,agent_id,attempt_number,assignment_revision,status,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tenant.id, row.id, parent.id, execution?.id || null, agent.id, attemptCount, revision,
        attemptStatus || (status === 'pending' ? 'assigned' : status), error]))[0];
      return {...row, attempt};
    }
    const row = async id => (await query('SELECT * FROM capture_tasks WHERE id=$1', [id]))[0];
    const itemRow = async id => (await query('SELECT * FROM capture_task_items WHERE id=$1', [id]))[0];
    const attemptRow = async id => (await query('SELECT * FROM capture_task_item_attempts WHERE id=$1', [id]))[0];
    const eligibility = async ids => {
      const map = await withTransaction(tx => loadOperatorCloseEligibility(tx, tenant.id, ids));
      return Object.fromEntries(ids.map(id => [id, map.get(id)?.reason ?? 'absent']));
    };
    async function overviewTask(id) {
      clearCaptureOverviewProjectionCache();
      const overview = await request('/overview?limit=200');
      assert.equal(overview.status, 200, JSON.stringify(overview.body));
      return overview.body.tasks.find(taskRow => taskRow.id === id);
    }
    const close = (id, role = 'tenant_admin') => request(`/tasks/${id}/operator-close`, {body: {}, role});
    const events = (taskId, type) => query(`SELECT * FROM capture_task_events WHERE task_id=$1
      AND ($2::text IS NULL OR event_type=$2) ORDER BY id`, [taskId, type || null]);
    const audits = targetId => query(`SELECT * FROM audit_logs WHERE tenant_id=$1
      AND action='capture_task.operator_closed' AND target_id=$2`, [tenant.id, targetId]);
    let progressSeq = 10;
    async function mirror(agent, input) {
      progressSeq += 1;
      const now = new Date(Date.now() + progressSeq).toISOString();
      const snapshot = normalizeCloudTaskSnapshot({
        platform: 'xiaohongshu', taskType: 'capture', source: 'sidebar', title: '提前',
        attemptNumber: 1, progressSeq, createdAt: now, updatedAt: now, heartbeatAt: now, ...input,
      });
      return withTransaction(tx => mirrorTaskSnapshot(tx, agent, snapshot));
    }
    return {tenant, foreign, code, sessions, request, addAgent, task, batch, child, item, row, itemRow,
      attemptRow, eligibility, overviewTask, close, events, audits, mirror};
  }

  function assertClosedMarker(closed, {originalStatus = 'needs_action', mode = 'single'} = {}) {
    const marker = closed.metadata.operatorClose;
    assert.ok(marker?.closedAt, 'operatorClose.closedAt is recorded');
    assert.equal(marker.originalStatus, originalStatus);
    assert.equal(marker.closedBy, '运营 值班');
    assert.equal(marker.mode, mode);
    assert.equal(marker.attemptNumber, closed.attempt_number);
    assert.equal(marker.orchestrationRevision, closed.orchestration_revision);
  }

  await t.test('补详情: closes without re-queueing, late receipt and late snapshot cannot reopen, 重新处理 still works', async st => {
    const f = await fixture(st);
    process.env.ANDROID_DISCOVERY_INGEST_TENANTS = f.tenant.id;
    const mobile = await f.addAgent('手机', {platforms: ['douyin'],
      capabilities: {agentKind: 'android_mobile', mobileSearchDiscoveryV1: true}});
    const browser = await f.addAgent('西瓜', {platforms: ['douyin'], capabilities: DISCOVERY_CAPABILITIES});
    const [run] = await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,platform,status,
      metadata,task_type,source) VALUES($1,$2,$2,'douyin','running',$3,'capture','android_runner') RETURNING *`,
    [f.tenant.id, mobile.id, {workflow: 'douyin_mobile_discovery', deadlineAt: new Date(Date.now() + 600000).toISOString()}]);
    const requestHash = 'a'.repeat(64);
    const [runItem] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,platform,status,keyword,
      assigned_agent_id,execution_task_id,assignment_revision,request_hash,attempt_count)
      VALUES($1,$2,'kw-1','douyin','running','别克壁纸',$3,$2,1,$4,1) RETURNING id`, [f.tenant.id, run.id, mobile.id, requestHash]);
    const [runAttempt] = await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,
      execution_task_id,agent_id,assignment_revision,request_hash,status) VALUES($1,$2,$3,$3,$4,1,$5,'running') RETURNING id`,
    [f.tenant.id, runItem.id, run.id, mobile.id, requestHash]);
    const principal = {tenantId: f.tenant.id, agentId: mobile.id, authCodeId: mobile.auth_code_id, authBindingId: mobile.auth_binding_id};
    const discovery = createDiscoveryService({repository: createDiscoveryRepository()});
    const receipt = (await discovery.ingestBatch({principal, batch: {uploadBatchId: randomUUID(), events: [{
      eventId: randomUUID(), discoveryRunId: run.id, taskId: run.id, itemId: runItem.id, attemptId: runAttempt.id,
      agentId: mobile.id, requestHash, assignmentRevision: 1, keyword: '别克壁纸', verification: 'verified',
      discoveredAt: new Date().toISOString(), rawShareUrl: 'https://www.douyin.com/video/7654321098765432109',
    }]}})).receipts[0];
    assert.equal(receipt.candidateStatus, 'queued');

    // A stopped phone run still owning an active demand is refused.
    await query("UPDATE capture_task_items SET status='completed' WHERE id=$1", [runItem.id]);
    await query("UPDATE capture_tasks SET status='needs_action' WHERE id=$1", [run.id]);
    assert.deepEqual(await f.eligibility([run.id]), {[run.id]: 'active_discovery_demand'});
    await query("UPDATE capture_tasks SET status='running' WHERE id=$1", [run.id]);

    const detail = await withTransaction(tx => dispatchDiscoveredPost(tx, {agent: browser}));
    assert.ok(detail?.commandId);
    const [command] = await query('SELECT * FROM capture_agent_commands WHERE id=$1', [detail.commandId]);
    assert.deepEqual(await f.eligibility([detail.taskId]), {[detail.taskId]: 'status_not_closeable'});
    async function mirrorDetail(status) {
      const now = new Date(Date.now() + 1000).toISOString();
      const payload = globalThis.OnStarvoiceCloudTaskAgent.buildHeartbeatPayload({runtime: {appVersion: '0.4.18'},
        ledger: {runs: []}, targetedPostRequest: {id: detail.taskId, taskId: detail.taskId, cloudCommandId: detail.commandId,
          attemptId: command.payload.attemptIdentity, attemptNumber: 1, workflow: 'discovered_post_capture',
          platform: 'douyin', status, targets: command.payload.targets, metadata: {candidateId: randomUUID(),
            workflow: 'forged', operatorClose: {closedAt: 'forged'}},
          progressSeq: 2, createdAt: now, updatedAt: now, startedAt: now, heartbeatAt: now}});
      return withTransaction(tx => mirrorTaskSnapshot(tx, browser, normalizeCloudTaskSnapshot(payload.tasks[0])));
    }
    const failedDetail = await mirrorDetail('completed');
    assert.equal(failedDetail.status, 'needs_action');
    assert.equal(failedDetail.error.code, 'detail_finished_without_ingestion');
    assert.equal(failedDetail.metadata.operatorClose, undefined, 'a device cannot mint the marker');
    assert.notEqual((await query('SELECT status FROM capture_agent_commands WHERE id=$1', [detail.commandId]))[0].status,
      'pending', 'the accepted snapshot settled the create command');

    const card = await f.overviewTask(detail.taskId);
    assert.deepEqual(card.operator_close, {eligible: true, reason: ''});
    const itemBefore = await f.itemRow(detail.itemId);
    const [candidateBefore] = await query('SELECT * FROM capture_discovery_candidates WHERE id=$1', [receipt.candidateId]);
    const [demandBefore] = await query('SELECT * FROM capture_discovery_run_candidates WHERE candidate_id=$1', [receipt.candidateId]);
    assert.equal(candidateBefore.status, 'failed');
    assert.equal(demandBefore.demand_status, 'needs_action');

    const closed = await f.close(detail.taskId);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.idempotent, false);
    assert.equal(closed.body.task.status, 'failed');
    assert.ok(closed.body.task.attention_dismissed_at);
    assert.equal(closed.body.message, '已结束并移到历史，采集结果已保留');
    const closedTask = await f.row(detail.taskId);
    assertClosedMarker(closedTask);
    assert.equal(closedTask.metadata.operatorClose.originalError.code, 'detail_finished_without_ingestion');
    assert.equal(closedTask.error.code, 'detail_finished_without_ingestion', 'the original error stays on the row');
    assert.equal(closedTask.message, ROOT_MESSAGE);
    assert.equal(closedTask.attention_dismissed_by_name, '运营 值班');
    const closedItem = await f.itemRow(detail.itemId);
    assert.equal(closedItem.status, 'failed');
    assert.equal(closedItem.assignment_revision, itemBefore.assignment_revision + 1);
    assert.equal(closedItem.error.operatorClosed, true);
    assert.equal(closedItem.error.originalStatus, 'needs_action');
    const [detailAttempt] = await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [detail.itemId]);
    assert.equal(detailAttempt.status, 'failed');
    assert.equal(detailAttempt.error.originalStatus, 'needs_action');
    const [candidateAfter] = await query('SELECT * FROM capture_discovery_candidates WHERE id=$1', [receipt.candidateId]);
    const [demandAfter] = await query('SELECT * FROM capture_discovery_run_candidates WHERE candidate_id=$1', [receipt.candidateId]);
    assert.deepEqual(candidateAfter, candidateBefore, 'the candidate is not re-queued');
    assert.deepEqual(demandAfter, demandBefore, 'the demand is not touched');
    assert.equal((await query(`SELECT count(*)::integer AS count FROM capture_agent_commands WHERE task_id=$1`,
      [detail.taskId]))[0].count, 1, 'no device command');
    const [event] = await f.events(detail.taskId, 'task_operator_closed');
    assert.equal(event.actor_name, '运营 值班');
    assert.deepEqual(event.payload, {originalStatus: 'needs_action', mode: 'single', closedChildTaskIds: [],
      failedItemCount: 1, canceledItemCount: 0, failedAttemptCount: 1});
    const [audit] = await f.audits(detail.taskId);
    assert.equal(audit.actor_user_id, f.sessions.tenant_admin.userId);
    assert.equal(audit.metadata.taskType, 'discovered_post_capture');
    assert.equal(audit.metadata.originalStatus, 'needs_action');
    assert.equal((await f.overviewTask(detail.taskId)).operator_close, undefined, 'a dismissed row is not evaluated');

    const repeated = await f.close(detail.taskId);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.idempotent, true);
    assert.equal((await f.events(detail.taskId, 'task_operator_closed')).length, 1);

    const [attempt] = await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [detail.itemId]);
    await assert.rejects(upsertCapturedRecord({platform: 'douyin', external_id: '7654321098765432109',
      url: 'https://www.douyin.com/video/7654321098765432109', record_type: 'single_note',
      title: '君越车机壁纸很有秋天的味道', author_name: '真实用户', author_id: 'person-123', content: '喜欢这张新壁纸'},
    {tenantId: f.tenant.id, captureTaskId: detail.taskId, captureAgentId: browser.id,
      captureAgentAuthCodeId: browser.auth_code_id, captureAgentAuthBindingId: browser.auth_binding_id,
      captureTaskItemAttemptId: attempt.id, captureTaskItemRequestHash: attempt.request_hash}),
    error => error.code === 'stale_attempt' && error.statusCode === 409);
    assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1', [f.tenant.id])).length, 0);

    const late = await mirrorDetail('failed');
    assert.equal(late.status, 'failed');
    const afterLate = await f.row(detail.taskId);
    assert.ok(afterLate.attention_dismissed_at, 'still in history');
    assert.deepEqual(afterLate.metadata.operatorClose, closedTask.metadata.operatorClose, 'marker kept, not forged');
    assert.equal(afterLate.message, ROOT_MESSAGE);
    assert.deepEqual(await f.itemRow(detail.itemId), closedItem, 'the projection does not reopen the item');
    assert.deepEqual((await query('SELECT * FROM capture_discovery_candidates WHERE id=$1', [receipt.candidateId]))[0],
      candidateBefore);

    const management = createDiscoveryManagementService();
    const reprocessed = await management.reprocess({tenantId: f.tenant.id, runId: run.id, requestId: randomUUID(),
      candidateIds: [receipt.candidateId]});
    assert.ok(reprocessed.results.some(result => result.status === 'queued'), JSON.stringify(reprocessed));
    assert.equal((await query('SELECT status FROM capture_discovery_candidates WHERE id=$1', [receipt.candidateId]))[0].status, 'queued');
    assert.equal((await query('SELECT demand_status FROM capture_discovery_run_candidates WHERE candidate_id=$1',
      [receipt.candidateId]))[0].demand_status, 'active');
    assert.equal((await f.row(detail.taskId)).status, 'failed', 'reprocess creates new work, never reopens the closed row');
  });

  await t.test('standalone phone run: needs_action words fail, unstarted words cancel, late phone reports are stale', async st => {
    const f = await fixture(st);
    const android = createAndroidControlService({enabledTenants: () => new Set([f.tenant.id])});
    const [phoneCode] = await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4) RETURNING *',
      [f.tenant.id, randomUUID()]);
    const registration = {code: phoneCode.code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const registered = await android.register(registration);
    const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
    const principal = {tenantId: f.tenant.id, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const poll = () => android.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true});
    const completion = (claimed, extra = {}) => ({requestId: randomUUID(), identity: claimed.task.identity, sessionId,
      status: 'completed', deviceIdle: true, ...extra});
    const evidence = () => ({requestId: randomUUID(), evidence: {method: 'operator_takeover', evidenceId: randomUUID(),
      verifiedBy: 'integration', verifiedAt: new Date().toISOString()}});

    const created = await android.create(f.tenant.id, {requestId: randomUUID(), agentId: phone.id});
    const runId = created.run.id;
    const claimed = await poll();
    assert.ok(claimed.task);
    const interrupted = completion(claimed, {status: 'interrupted'});
    await android.complete(principal, interrupted);
    assert.equal((await f.row(runId)).status, 'needs_action');
    const items = await query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [runId]);
    assert.deepEqual(items.map(row => row.status), ['needs_action', 'pending']);
    assert.deepEqual(await f.eligibility([runId]), {[runId]: ''}, 'a stopped run never claims its pending word again');

    const closed = await f.close(runId);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const run = await f.row(runId);
    assert.equal(run.status, 'failed');
    assertClosedMarker(run);
    const [failedItem, canceledItem] = await query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [runId]);
    assert.equal(failedItem.status, 'failed');
    assert.equal(canceledItem.status, 'canceled');
    assert.equal(canceledItem.error.originalStatus, 'pending');
    for (const [index, closedItem] of [failedItem, canceledItem].entries()) {
      assert.equal(closedItem.assignment_revision, items[index].assignment_revision + 1);
      assert.equal(closedItem.metadata.attemptId, undefined);
      assert.equal(closedItem.metadata.leaseId, undefined);
    }
    const attempt = await f.attemptRow(claimed.task.identity.attemptId);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error.originalStatus, 'interrupted');
    assert.equal((await f.events(runId, 'task_operator_closed'))[0].payload.canceledItemCount, 1);

    const snapshot = async () => ({run: await f.row(runId),
      items: await query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [runId]),
      attempts: await query('SELECT * FROM capture_task_item_attempts WHERE parent_task_id=$1 ORDER BY id', [runId])});
    const before = await snapshot();
    assert.equal((await android.complete(principal, interrupted)).duplicate, true, 'a replay returns the stored receipt');
    await assert.rejects(android.complete(principal, completion(claimed)), {code: 'COMPLETION_CONFLICT'});
    await assert.rejects(android.close(principal, {identity: claimed.task.identity, ...evidence()}), {code: 'STALE_ATTEMPT'});
    await assert.rejects(android.renew(principal, {identity: claimed.task.identity, sessionId, leaseId: claimed.permit.leaseId}),
      {code: 'STALE_ATTEMPT'});
    await assert.rejects(android.resume(f.tenant.id, runId), {code: 'RUN_NOT_RESUMABLE'});
    assert.equal((await poll()).task, null);
    assert.deepEqual(await snapshot(), before, 'late phone reports change nothing');

    // A run the server ended without a completion receipt: before the close the
    // same completion would still be current; after it the new revision fences it.
    const second = await android.create(f.tenant.id, {requestId: randomUUID(), agentId: phone.id, keywords: ['君越壁纸']});
    const held = await poll();
    assert.equal(held.task.identity.taskId, second.run.id);
    await query(`UPDATE capture_task_items SET status='needs_action',metadata=metadata||'{"deviceHeld":false}'::jsonb
      WHERE id=$1`, [held.task.identity.itemId]);
    await query("UPDATE capture_tasks SET status='needs_action' WHERE id=$1", [second.run.id]);
    assert.equal((await f.close(second.run.id)).status, 200);
    const secondBefore = await f.itemRow(held.task.identity.itemId);
    await assert.rejects(android.complete(principal, completion(held, {status: 'interrupted'})), {code: 'STALE_ATTEMPT'});
    assert.deepEqual(await f.itemRow(held.task.identity.itemId), secondBefore);
    assert.equal((await f.attemptRow(held.task.identity.attemptId)).status, 'running', 'the attempt row is not rewritten');

    const third = await android.create(f.tenant.id, {requestId: randomUUID(), agentId: phone.id, keywords: ['昂科威壁纸']});
    const occupying = await poll();
    await android.complete(principal, completion(occupying, {status: 'needs_action', deviceIdle: false}));
    assert.equal((await f.row(third.run.id)).status, 'interrupted');
    assert.deepEqual(await f.eligibility([third.run.id]), {[third.run.id]: 'interrupted'});
    await query("UPDATE capture_tasks SET status='needs_action' WHERE id=$1", [third.run.id]);
    const refused = await f.close(third.run.id);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'task_not_closeable');
    assert.equal(refused.body.reason, 'device_held');
    assert.match(refused.body.message, /手机仍占用该任务/u);
    assert.equal((await f.row(third.run.id)).status, 'needs_action');
  });

  await t.test('sidebar 「提前」: same-execution failures stay closed, fence/interrupted/new executions reopen it', async st => {
    const f = await fixture(st);
    // One node per closed row: a reopened fence on one row must not hide the
    // slot evidence of the next.
    async function closedSidebar(clientId = randomUUID()) {
      const agent = await f.addAgent(`节点 ${randomUUID().slice(0, 4)}`);
      const attemptId = randomUUID();
      const mirrored = await f.mirror(agent, {id: clientId, attemptId, status: 'needs_action',
        error: {code: 'MANUAL_BATCH_PAGE_CLOSED', message: '批量采集页面已关闭'}, metadata: {operatorClose: {closedAt: 'forged'}}});
      assert.equal(mirrored.status, 'needs_action');
      assert.equal(mirrored.metadata.operatorClose, undefined, 'a device cannot mint the marker');
      assert.deepEqual(await f.eligibility([mirrored.id]), {[mirrored.id]: ''});
      const closed = await f.close(mirrored.id);
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const row = await f.row(mirrored.id);
      assertClosedMarker(row);
      assert.equal(row.message, ROOT_MESSAGE);
      return {row, clientId, attemptId, agent};
    }

    const first = await closedSidebar();
    for (const status of ['needs_action', 'failed']) {
      await f.mirror(first.agent, {id: first.clientId, attemptId: first.attemptId, status,
        error: {code: 'MANUAL_BATCH_PAGE_CLOSED'}, metadata: {operatorClose: {closedAt: 'forged', attemptNumber: 9}}});
      const held = await f.row(first.row.id);
      assert.equal(held.status, 'failed', `${status} from the same execution keeps it closed`);
      assert.ok(held.attention_dismissed_at);
      assert.equal(held.message, ROOT_MESSAGE);
      assert.deepEqual(held.metadata.operatorClose, first.row.metadata.operatorClose, 'neither forged nor erased');
    }
    await f.mirror(first.agent, {id: first.clientId, attemptId: first.attemptId, status: 'needs_action', error: STOP_ERROR});
    const fenced = await f.row(first.row.id);
    assert.equal(fenced.status, 'needs_action');
    assert.equal(fenced.error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    assert.equal(fenced.attention_dismissed_at, null, 'back in 需处理');
    assert.ok(fenced.metadata.operatorClose, 'the marker stays for audit');
    assert.deepEqual(await f.eligibility([fenced.id]), {[fenced.id]: 'stop_fence'});
    const refused = await f.close(fenced.id);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, 'stop_fence');
    const resume = await f.request(`/tasks/${fenced.id}/resume`, {body: {mode: 'remaining'}});
    assert.notEqual(resume.body.error, 'task_operator_closed', 'a reopened root keeps its normal exits');
    assert.equal((await f.overviewTask(fenced.id)).operator_close.reason, 'stop_fence');

    const second = await closedSidebar();
    await f.mirror(second.agent, {id: second.clientId, attemptId: second.attemptId, status: 'interrupted'});
    const interrupted = await f.row(second.row.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.attention_dismissed_at, null);
    const blocker = await withTransaction(tx => findCaptureAgentExecutionSlotBlocker(tx, f.tenant.id, second.agent.id));
    assert.equal(blocker?.id, second.row.id, 'an interrupted report blocks the slot again');
    assert.deepEqual(await f.eligibility([second.row.id]), {[second.row.id]: 'interrupted'});

    const third = await closedSidebar();
    const sameRunning = await f.mirror(third.agent, {id: third.clientId, attemptId: third.attemptId, status: 'running'});
    assert.equal(sameRunning.status, 'failed', 'the same execution cannot report running again');
    assert.deepEqual(await f.row(third.row.id), third.row);
    const secondAttemptId = randomUUID();
    await f.mirror(third.agent, {id: third.clientId, attemptId: secondAttemptId, attemptNumber: 2, status: 'running'});
    const rerun = await f.row(third.row.id);
    assert.equal(rerun.status, 'running');
    assert.equal(rerun.attempt_number, 2);
    assert.equal(rerun.attention_dismissed_at, null, 'a new execution is visible again');
    await f.mirror(third.agent, {id: third.clientId, attemptId: secondAttemptId, attemptNumber: 2, status: 'failed'});
    const refailed = await f.row(third.row.id);
    assert.equal(refailed.status, 'failed');
    assert.equal(refailed.attention_dismissed_at, null, 'the new failure is not the closed one');
    const resumed = await f.request(`/tasks/${third.row.id}/resume`, {body: {mode: 'remaining'}});
    assert.notEqual(resumed.body.error, 'task_operator_closed');

    const fourth = await closedSidebar();
    const resumeClosed = await f.request(`/tasks/${fourth.row.id}/resume`, {body: {mode: 'remaining'}});
    assert.equal(resumeClosed.status, 409);
    assert.equal(resumeClosed.body.error, 'task_operator_closed');
    assert.match(resumeClosed.body.message, /已结束并移到历史，不能继续/u);
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [fourth.row.id])).length, 0);
  });

  await t.test('phone elastic batch: the parent aggregates to completed_with_failures and the schedule follows', async st => {
    const f = await fixture(st);
    const android = createAndroidControlService({enabledTenants: () => new Set([f.tenant.id])});
    const [phoneCode] = await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4) RETURNING *',
      [f.tenant.id, randomUUID()]);
    const registration = {code: phoneCode.code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const phone = (await query('SELECT * FROM capture_agents WHERE id=$1', [(await android.register(registration)).agent.id]))[0];
    const principal = {tenantId: f.tenant.id, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const poll = () => android.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true});
    const plan = {platform: 'douyin', keywords: ['别克壁纸', '君越壁纸'],
      searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'}, keywordMaxDetectedItems: 40,
      recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true}};
    const [template] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,platform,
      status,title,metadata) VALUES($1,$2,'capture_orchestration','keyword_orchestration','douyin','pending','手机',$3)
      RETURNING id`, [f.tenant.id, randomUUID(), {orchestrationTemplate: true, distributionMode: 'elastic_pool'}]);
    const scheduleId = randomUUID();
    await query(`INSERT INTO capture_orchestration_schedules(id,tenant_id,template_task_id,title,platform,status,
      distribution_mode,plan_snapshot,next_run_at) VALUES($1,$2,$3,'手机','douyin','active','elastic_pool',$4,
      now()+interval '1 day')`, [scheduleId, f.tenant.id, template.id, plan]);
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,title,platform,
      source,trigger_type,status,metadata,orchestration_revision,orchestration_schedule_id)
      VALUES($1,$2,'capture_orchestration','keyword_orchestration','手机 · 09/26 20:04','douyin','cloud','schedule',
        'running',$3,1,$4) RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', claimUnit: 'keyword', eligibleAgentIds: [phone.id],
      executionMode: 'one_time', orchestrationScheduleRun: true, planSnapshot: plan}, scheduleId]);
    await query('UPDATE capture_orchestration_schedules SET last_run_task_id=$1,last_run_status=$2 WHERE id=$3',
      [parent.id, 'running', scheduleId]);
    const [exhausted] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,
      item_type,status,attempt_count,assignment_revision) VALUES($1,$2,'keyword:0',0,'别克壁纸','douyin','keyword',
      'pending',2,2) RETURNING *`, [f.tenant.id, parent.id]);
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,
      attempt_count,assignment_revision,finished_at) VALUES($1,$2,'keyword:1',1,'君越壁纸','douyin','keyword','completed',
      1,1,now())`, [f.tenant.id, parent.id]);
    const claimed = await poll();
    assert.equal(claimed.task.keyword, '别克壁纸');
    const lastReport = {requestId: randomUUID(), identity: claimed.task.identity, sessionId, status: 'interrupted', deviceIdle: true};
    await android.complete(principal, lastReport);
    assert.equal((await f.itemRow(exhausted.id)).status, 'needs_action', 'third attempt used up the phone budget');
    assert.equal((await f.row(parent.id)).status, 'needs_action');
    const childId = claimed.task.identity.taskId;
    assert.equal((await f.row(childId)).status, 'needs_action');
    assert.deepEqual(await f.eligibility([parent.id]), {[parent.id]: ''});

    const closed = await f.close(parent.id);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const closedParent = await f.row(parent.id);
    assert.equal(closedParent.status, 'completed_with_failures', 'aggregated from items, not forced to failed');
    assertClosedMarker(closedParent);
    assert.equal(closedParent.message, ORCHESTRATION_MESSAGE);
    assert.ok(closedParent.finished_at);
    assert.equal(closedParent.counts.completed, 1);
    assert.equal(closedParent.counts.failed, 1);
    const closedChild = await f.row(childId);
    assert.equal(closedChild.status, 'failed');
    assert.equal(closedChild.message, CHILD_MESSAGE);
    assert.equal(closedChild.metadata.operatorClose.rootTaskId, parent.id);
    assert.equal((await f.itemRow(exhausted.id)).status, 'failed');
    const [schedule] = await query('SELECT * FROM capture_orchestration_schedules WHERE id=$1', [scheduleId]);
    assert.equal(schedule.last_run_status, 'completed_with_failures');
    assert.equal(schedule.last_error.code, 'scheduled_run_settled_with_failures');
    assert.equal((await f.row(template.id)).metadata.lastRunStatus, 'completed_with_failures');
    assert.deepEqual((await f.events(parent.id, 'task_operator_closed'))[0].payload.closedChildTaskIds, [childId]);

    const itemBefore = await f.itemRow(exhausted.id);
    assert.equal((await poll()).task, null, 'the phone finds nothing to claim');
    assert.equal((await android.complete(principal, lastReport)).duplicate, true);
    await assert.rejects(android.close(principal, {requestId: randomUUID(), identity: claimed.task.identity,
      evidence: {method: 'operator_takeover', evidenceId: randomUUID(), verifiedBy: 'integration',
        verifiedAt: new Date().toISOString()}}), {code: 'STALE_ATTEMPT'});
    assert.deepEqual(await f.itemRow(exhausted.id), itemBefore);
    const browser = await f.addAgent('西瓜', {platforms: ['douyin'], capabilities: {...XHS_CAPABILITIES, supportedPlatforms: ['douyin']}});
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{eligibleAgentIds}',$2::jsonb) WHERE id=$1`,
      [parent.id, JSON.stringify([phone.id, browser.id])]);
    assert.equal(await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: browser,
      capabilities: browser.capabilities})), null, 'the browser finds nothing to claim either');
  });

  await t.test('browser elastic batch: a late fence report reopens the child for 「确认旧页面已停止」 only', async st => {
    const f = await fixture(st);
    const [mars, jupiter] = [await f.addAgent('火星'), await f.addAgent('木星')];
    const parent = await f.batch({agents: [mars, jupiter]});
    const marsChild = await f.child(parent, mars);
    const kept = await f.item(parent, {keyword: '君越壁纸', status: 'completed', execution: marsChild, agent: mars});
    const stuck = await f.item(parent, {keyword: '昂科威壁纸', status: 'needs_action', execution: marsChild, agent: mars,
      error: TECHNICAL_ERROR});
    assert.deepEqual(await f.eligibility([parent.id]), {[parent.id]: ''});
    assert.equal((await f.close(parent.id)).status, 200);
    assert.equal((await f.row(parent.id)).status, 'completed_with_failures');
    assert.equal((await f.row(marsChild.id)).status, 'failed');
    assert.equal((await f.itemRow(kept.id)).status, 'completed');
    assert.equal((await f.attemptRow(stuck.attempt.id)).status, 'failed');

    const refused = await f.request(`/tasks/${marsChild.id}/resume`, {body: {mode: 'remaining'}});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'task_operator_closed');
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [marsChild.id])).length, 0);

    await f.mirror(mars, {id: marsChild.client_task_id, controlTaskId: marsChild.id, status: 'needs_action',
      taskType: 'unattended_keyword_capture', source: 'cloud', title: marsChild.title, error: STOP_ERROR});
    const reopened = await f.row(marsChild.id);
    assert.equal(reopened.status, 'needs_action');
    assert.equal(reopened.error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    assert.equal((await f.itemRow(stuck.id)).status, 'failed', 'the finished batch does not take the report');
    const blocker = await withTransaction(tx => findCaptureAgentExecutionSlotBlocker(tx, f.tenant.id, mars.id));
    assert.equal(blocker?.id, marsChild.id, 'the fence is effective again');

    const confirmed = await f.request(`/agents/${mars.id}/stop-fence/confirm`, {body: {
      confirmation: '确认旧页面已停止', expectedTaskIds: [marsChild.id]}});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal((await f.row(marsChild.id)).status, 'superseded');
    assert.equal(await withTransaction(tx => findCaptureAgentExecutionSlotBlocker(tx, f.tenant.id, mars.id)), null);
    assert.equal((await f.itemRow(stuck.id)).status, 'failed');
    assert.equal((await f.row(parent.id)).status, 'completed_with_failures');

    const next = await f.batch({status: 'pending', agents: [mars]});
    const fresh = await f.item(next, {keyword: '别克哨兵', status: 'pending', attemptCount: 0, revision: 0,
      metadata: {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}});
    const claim = await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: mars, capabilities: XHS_CAPABILITIES}));
    assert.ok(claim?.commandId, 'the released node takes new batch work');
    assert.equal((await f.itemRow(fresh.id)).assigned_agent_id, mars.id);
  });

  await t.test('browser elastic batch: a local continuation never adopts work from a closed batch', async st => {
    const f = await fixture(st);
    const jupiter = await f.addAgent('木星');
    async function settledBatch() {
      const parent = await f.batch({agents: [jupiter]});
      const failedChild = await f.child(parent, jupiter, {status: 'failed'});
      const failedItem = await f.item(parent, {keyword: '檐下秋意', status: 'failed', execution: failedChild,
        agent: jupiter, error: TECHNICAL_ERROR});
      const stuckChild = await f.child(parent, jupiter);
      await f.item(parent, {keyword: '月兔栖梦', status: 'needs_action', execution: stuckChild, agent: jupiter,
        error: TECHNICAL_ERROR});
      return {parent, failedChild, failedItem};
    }
    const local = source => f.mirror(jupiter, {id: `local-recovery-${randomUUID()}`, status: 'running',
      taskType: 'unattended_keyword_capture', source: 'extension', title: '檐下秋意 · 本机继续',
      metadata: {parentRequestId: source.client_task_id, cloudAssigned: true, keywords: ['檐下秋意']}});

    const closedBatch = await settledBatch();
    assert.equal((await f.close(closedBatch.parent.id)).status, 200);
    const itemBefore = await f.itemRow(closedBatch.failedItem.id);
    assert.equal(itemBefore.assignment_revision, closedBatch.failedItem.assignment_revision,
      'an already failed item keeps its revision, so only the closed-parent guard stops adoption');
    const refused = await local(closedBatch.failedChild);
    assert.equal(refused.parent_task_id, null, 'not adopted into the closed batch');
    assert.deepEqual(await f.itemRow(closedBatch.failedItem.id), itemBefore);
    assert.equal((await f.row(closedBatch.parent.id)).status, 'completed_with_failures');

    const control = await settledBatch();
    await query("UPDATE capture_task_items SET status='failed' WHERE task_id=$1", [control.parent.id]);
    await query("UPDATE capture_tasks SET status='completed_with_failures' WHERE id=$1", [control.parent.id]);
    const adopted = await local(control.failedChild);
    assert.equal(adopted.parent_task_id, control.parent.id, 'control: the same continuation is adopted without a close');
  });

  await t.test('refusals: live work, fences, commands, stop requests, interruptions and failed negative patrols', async st => {
    const f = await fixture(st);
    const [mars, jupiter] = [await f.addAgent('火星'), await f.addAgent('木星')];

    const retrying = await f.batch({agents: [mars]});
    const retryChild = await f.child(retrying, mars, {status: 'completed_with_failures'});
    await f.item(retrying, {status: 'retryable', execution: retryChild, agent: mars, error: TECHNICAL_ERROR});
    const queued = await f.batch({agents: [mars]});
    await f.item(queued, {status: 'needs_action', agent: mars, attemptStatus: null});
    await f.item(queued, {status: 'retryable', attemptStatus: null});
    const fencedChildBatch = await f.batch({agents: [mars, jupiter]});
    const fencedChild = await f.child(fencedChildBatch, mars, {error: STOP_ERROR});
    const fencedItem = await f.item(fencedChildBatch, {keyword: '别克哨兵', status: 'needs_action', execution: fencedChild,
      agent: mars, error: STOP_ERROR});
    const otherChild = await f.child(fencedChildBatch, jupiter);
    await f.item(fencedChildBatch, {keyword: '君越壁纸', status: 'needs_action', execution: otherChild, agent: jupiter,
      error: TECHNICAL_ERROR});
    const fencedItemBatch = await f.batch({agents: [jupiter]});
    await f.item(fencedItemBatch, {status: 'needs_action', agent: jupiter, error: STOP_ERROR, attemptStatus: null});
    const commanded = await f.task({origin_agent_id: jupiter.id});
    await query(`INSERT INTO capture_agent_commands(tenant_id,agent_id,task_id,command_type,status,expires_at)
      VALUES($1,$2,$3,'resume','pending',now()+interval '1 hour')`, [f.tenant.id, jupiter.id, commanded.id]);
    const stopping = await f.task({origin_agent_id: jupiter.id, metadata: {stopPending: true}});
    const interruptedRoot = await f.task({origin_agent_id: jupiter.id, status: 'interrupted'});
    const interruptedChildBatch = await f.batch({agents: [jupiter]});
    const interruptedChild = await f.child(interruptedChildBatch, jupiter, {status: 'interrupted'});
    await f.item(interruptedChildBatch, {status: 'needs_action', execution: interruptedChild, agent: jupiter});
    const templateRoot = await f.batch({metadata: {orchestrationTemplate: true}});
    const childRoot = await f.child(await f.batch({agents: [mars]}), mars);
    const reasons = await f.eligibility([retrying.id, queued.id, fencedChildBatch.id, fencedItemBatch.id, commanded.id,
      stopping.id, interruptedRoot.id, interruptedChildBatch.id, templateRoot.id, childRoot.id]);
    assert.deepEqual(reasons, {
      [retrying.id]: 'live_item',
      [queued.id]: 'live_item',
      [fencedChildBatch.id]: 'stop_fence',
      [fencedItemBatch.id]: 'stop_fence',
      [commanded.id]: 'live_command',
      [stopping.id]: 'stop_pending',
      [interruptedRoot.id]: 'interrupted',
      [interruptedChildBatch.id]: 'live_child',
      [templateRoot.id]: 'status_not_closeable',
      [childRoot.id]: 'not_root',
    });
    for (const [id, reason] of Object.entries(reasons).filter(([, value]) => value !== 'not_root')) {
      const response = await f.close(id);
      assert.equal(response.status, 409, `${reason} must be refused`);
      assert.equal(response.body.error, 'task_not_closeable');
      assert.equal(response.body.reason, reason);
    }
    assert.equal((await f.row(fencedChild.id)).status, 'needs_action', 'a refused close changes nothing');
    assert.equal((await f.events(fencedChildBatch.id, 'task_operator_closed')).length, 0);
    const card = await f.overviewTask(fencedChildBatch.id);
    assert.deepEqual(card.operator_close, {eligible: false, reason: 'stop_fence'});

    // The fence leaves through 「确认旧页面已停止」; once its keyword also ends
    // the batch becomes closeable.
    const confirmed = await f.request(`/agents/${mars.id}/stop-fence/confirm`, {body: {
      confirmation: '确认旧页面已停止', expectedTaskIds: [fencedChild.id]}});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal((await f.itemRow(fencedItem.id)).status, 'retryable', 'handed back to the pool');
    assert.deepEqual(await f.eligibility([fencedChildBatch.id]), {[fencedChildBatch.id]: 'live_item'});
    await query("UPDATE capture_task_items SET status='failed' WHERE id=$1", [fencedItem.id]);
    assert.equal((await f.row(fencedChildBatch.id)).status, 'needs_action');
    assert.deepEqual(await f.eligibility([fencedChildBatch.id]), {[fencedChildBatch.id]: ''});
    assert.equal((await f.close(fencedChildBatch.id)).status, 200);
    assert.equal((await f.row(fencedChild.id)).status, 'superseded', 'a superseded child is never rewritten');

    const [record] = await query(`INSERT INTO records(tenant_id,platform,external_id,title) VALUES($1,'xiaohongshu',$2,
      '负面帖子') RETURNING id`, [f.tenant.id, randomUUID()]);
    await query(`INSERT INTO unattended_negative_patrol_state(tenant_id,platform,external_id,record_id,first_eligible_at,
      last_eligible_at,needs_action,failure_count) SELECT $1,'xiaohongshu',external_id,id,now(),now(),true,2
      FROM records WHERE id=$2`, [f.tenant.id, record.id]);
    const patrol = await f.batch({agents: [jupiter], metadata: {negativePatrolRun: {timezone: 'Asia/Shanghai'}}});
    const patrolChild = await f.child(patrol, jupiter, {status: 'failed'});
    const patrolItem = await f.item(patrol, {status: 'needs_action', itemType: 'negative_post', execution: patrolChild,
      agent: jupiter, recordId: record.id, metadata: {unattendedNegativePatrol: true}});
    const stateBefore = (await query('SELECT * FROM unattended_negative_patrol_state WHERE record_id=$1', [record.id]))[0];
    assert.deepEqual(await f.eligibility([patrol.id]), {[patrol.id]: 'negative_patrol_needs_action'});
    const patrolRefused = await f.close(patrol.id);
    assert.equal(patrolRefused.body.reason, 'negative_patrol_needs_action');
    assert.match(patrolRefused.body.message, /恢复失败巡查/u);
    assert.deepEqual((await query('SELECT * FROM unattended_negative_patrol_state WHERE record_id=$1', [record.id]))[0],
      stateBefore);
    const recovered = await f.request(`/orchestrations/${patrol.id}/negative-patrol/retry`, {body: {
      itemIds: [patrolItem.id], expectedRevision: patrol.orchestration_revision}});
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal((await f.itemRow(patrolItem.id)).status, 'pending');
    assert.deepEqual(await f.eligibility([patrol.id]), {[patrol.id]: 'status_not_closeable'}, 'the batch runs again');
    await query("UPDATE capture_tasks SET status='needs_action' WHERE id=$1", [patrol.id]);
    assert.deepEqual(await f.eligibility([patrol.id]), {[patrol.id]: 'live_item'});
  });

  await t.test('roles, tenants, roots, concurrency and a bulk request with a busy root', async st => {
    const f = await fixture(st);
    const agent = await f.addAgent('金星');
    const root = await f.task({origin_agent_id: agent.id});
    assert.equal((await f.close(root.id, 'tenant_viewer')).status, 403);
    const [foreignRoot] = await query(`INSERT INTO capture_tasks(tenant_id,task_type,status,title) VALUES($1,'capture',
      'needs_action','foreign') RETURNING id`, [f.foreign.id]);
    const foreign = await f.close(foreignRoot.id);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, 'task_not_found');
    assert.equal((await f.close('not-a-uuid')).status, 404);
    const childRoot = await f.child(await f.batch({agents: [agent]}), agent);
    const notRoot = await f.close(childRoot.id);
    assert.equal(notRoot.status, 409);
    assert.equal(notRoot.body.error, 'task_not_root');
    assert.equal((await f.row(root.id)).status, 'needs_action');

    const raced = await Promise.all([f.close(root.id), f.close(root.id)]);
    assert.deepEqual(raced.map(response => response.status), [200, 200]);
    assert.deepEqual(raced.map(response => response.body.idempotent).sort(), [false, true]);
    assert.equal((await f.events(root.id, 'task_operator_closed')).length, 1);
    assert.equal((await f.audits(root.id)).length, 1);

    for (const taskIds of [[], ['not-a-uuid'], Array.from({length: 101}, () => randomUUID())]) {
      assert.equal((await f.request('/tasks/operator-close', {body: {taskIds}})).status, 400);
    }
    assert.equal((await f.request('/tasks/operator-close', {body: {taskIds: [root.id]}, role: 'tenant_viewer'})).status, 403);
    const eligible = await f.task({origin_agent_id: agent.id, title: 'A'});
    const busy = await f.task({origin_agent_id: agent.id, title: 'B'});
    const live = await f.batch({agents: [agent]});
    await f.item(live, {status: 'retryable', agent, error: TECHNICAL_ERROR});
    const fenced = await f.task({origin_agent_id: agent.id, error: STOP_ERROR});
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM capture_tasks WHERE id=$1 FOR UPDATE', [busy.id]);
      const bulk = await f.request('/tasks/operator-close', {body: {taskIds: [eligible.id, busy.id, live.id, fenced.id,
        foreignRoot.id, childRoot.id, root.id]}});
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      assert.deepEqual(bulk.body.closedTaskIds, [eligible.id]);
      assert.deepEqual(bulk.body.alreadyClosedTaskIds, [root.id]);
      const skipped = Object.fromEntries(bulk.body.skipped.map(skip => [skip.taskId, skip.reason]));
      assert.deepEqual(skipped, {[busy.id]: 'task_busy', [live.id]: 'live_item', [fenced.id]: 'stop_fence',
        [foreignRoot.id]: 'not_found', [childRoot.id]: 'not_root'});
      assert.match(bulk.body.message, /已结束 1 个任务并移到历史；5 个未处理/u);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal((await f.row(eligible.id)).status, 'failed', 'the busy root did not roll back the others');
    assert.equal((await f.events(eligible.id, 'task_operator_closed'))[0].payload.mode, 'bulk');
    assert.equal((await f.row(busy.id)).status, 'needs_action');
    const retried = await f.request('/tasks/operator-close', {body: {taskIds: [busy.id]}});
    assert.deepEqual(retried.body.closedTaskIds, [busy.id]);
  });

  await t.test('history clear skips rows that cannot leave and reports why', async st => {
    const f = await fixture(st);
    const normal = await f.task({status: 'completed'});
    const attention = await f.task({status: 'needs_action'});
    const canceled = await f.batch({status: 'canceled'});
    await f.item(canceled, {status: 'pending', attemptStatus: null});
    const [foreignRoot] = await query(`INSERT INTO capture_tasks(tenant_id,task_type,status,title) VALUES($1,'capture',
      'completed','foreign') RETURNING id`, [f.foreign.id]);
    const mixed = await f.request('/history/clear', {body: {taskIds: [normal.id, attention.id, canceled.id, foreignRoot.id]}});
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    assert.deepEqual(mixed.body.clearedTaskIds, [normal.id]);
    assert.equal(mixed.body.clearedCount, 1);
    assert.deepEqual(Object.fromEntries(mixed.body.skipped.map(skip => [skip.taskId, skip.reason])), {
      [attention.id]: 'not_in_history', [canceled.id]: 'live_work', [foreignRoot.id]: 'not_found'});
    assert.match(mixed.body.message, /已移出 1 条；3 条未移出：仍有未结束的工作或仍需处理/u);
    assert.ok((await f.row(normal.id)).metadata.historyClearedAt);
    for (const id of [attention.id, canceled.id]) assert.equal((await f.row(id)).metadata.historyClearedAt, undefined);
    const none = await f.request('/history/clear', {body: {taskIds: [attention.id, canceled.id, foreignRoot.id]}});
    assert.equal(none.status, 409);
    assert.equal(none.body.error, 'task_not_clearable');
    assert.equal(none.body.skipped.length, 3);
    const missing = await f.request('/history/clear', {body: {taskIds: [foreignRoot.id, randomUUID()]}});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'task_not_found');
    const again = await f.request('/history/clear', {body: {taskIds: [normal.id, attention.id]}});
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.alreadyClearedTaskIds, [normal.id]);
  });

  await t.test('a closed batch that 「重试失败关键词」 or 「恢复失败巡查」 reopens returns to 需处理, even after a history clear', async st => {
    const f = await fixture(st);
    const [mars, jupiter] = [await f.addAgent('火星'), await f.addAgent('木星')];
    // Offline pool: the retried keyword waits instead of being dispatched, so
    // the only change is the reopen itself.
    await query(`UPDATE capture_agents SET last_heartbeat_at=now()-interval '1 day',
      last_full_heartbeat_at=now()-interval '1 day',last_liveness_at=now()-interval '1 day' WHERE id = ANY($1::uuid[])`,
    [[mars.id, jupiter.id]]);
    const parent = await f.batch({agents: [mars, jupiter]});
    const marsChild = await f.child(parent, mars);
    await f.item(parent, {keyword: '君越壁纸', status: 'completed', execution: marsChild, agent: mars});
    const stuck = await f.item(parent, {keyword: '昂科威壁纸', status: 'needs_action', execution: marsChild, agent: mars,
      error: TECHNICAL_ERROR});
    assert.equal((await f.close(parent.id)).status, 200);
    const closed = await f.row(parent.id);
    assert.equal(closed.status, 'completed_with_failures');
    assert.ok(closed.attention_dismissed_at);
    const cleared = await f.request('/history/clear', {body: {taskIds: [parent.id]}});
    assert.deepEqual(cleared.body.clearedTaskIds, [parent.id], JSON.stringify(cleared.body));
    assert.ok((await f.row(parent.id)).metadata.historyClearedAt);

    const retried = await f.request(`/orchestrations/${parent.id}/retry-items`, {body: {
      requestKey: randomUUID(), expectedRevision: closed.orchestration_revision, itemIds: [stuck.id]}});
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    const reopened = await f.row(parent.id);
    assert.equal(reopened.orchestration_revision, closed.orchestration_revision + 1);
    assert.equal(reopened.attention_dismissed_at, null, 'the retried batch is no longer dismissed');
    assert.equal(reopened.attention_dismissed_by_user_id, null);
    assert.equal(reopened.attention_dismissed_by_name, '');
    assert.equal(reopened.metadata.historyClearedAt, undefined, 'nor cleared from history');
    assert.equal(reopened.metadata.historyClearedBy, undefined);
    assert.ok(reopened.metadata.operatorClose?.closedAt, 'the close marker stays as audit');
    const live = await f.overviewTask(parent.id);
    assert.ok(live, 'the live batch is on the overview');
    assert.deepEqual(live.operator_close, {eligible: false, reason: 'live_item'});

    // The retried keyword needs manual action again (e.g. a security block).
    await query("UPDATE capture_task_items SET status='needs_action' WHERE id=$1", [stuck.id]);
    await withTransaction(tx => refreshOrchestrationParentTask(tx, {tenantId: f.tenant.id, parentTaskId: parent.id}));
    const again = await f.row(parent.id);
    assert.equal(again.status, 'needs_action');
    assert.equal(again.attention_dismissed_at, null);
    const card = await f.overviewTask(parent.id);
    assert.equal(card?.status, 'needs_action', 'back in 需处理');
    assert.equal(card.attention_dismissed_at, null);
    assert.deepEqual(card.operator_close, {eligible: true, reason: ''}, 'and can be ended again');
    const history = await f.request('/history?page=1&pageSize=100');
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.tasks.some(row => row.id === parent.id), false, 'not listed in history');
    const reclosed = await f.close(parent.id);
    assert.equal(reclosed.status, 200, JSON.stringify(reclosed.body));
    assert.equal(reclosed.body.idempotent, false);
    const final = await f.row(parent.id);
    assert.equal(final.status, 'completed_with_failures');
    assert.ok(final.attention_dismissed_at);
    assert.equal(final.metadata.operatorClose.orchestrationRevision, reopened.orchestration_revision);
    assert.equal((await f.events(parent.id, 'task_operator_closed')).length, 2);

    // 恢复失败巡查 on a closed negative-patrol batch surfaces it the same way.
    const [record] = await query(`INSERT INTO records(tenant_id,platform,external_id,title) VALUES($1,'xiaohongshu',$2,
      '负面帖子') RETURNING id`, [f.tenant.id, randomUUID()]);
    await query(`INSERT INTO unattended_negative_patrol_state(tenant_id,platform,external_id,record_id,first_eligible_at,
      last_eligible_at,needs_action,failure_count) SELECT $1,'xiaohongshu',external_id,id,now(),now(),false,2
      FROM records WHERE id=$2`, [f.tenant.id, record.id]);
    const patrol = await f.batch({agents: [jupiter], metadata: {negativePatrolRun: {timezone: 'Asia/Shanghai'}}});
    const patrolChild = await f.child(patrol, jupiter, {status: 'failed'});
    const patrolItem = await f.item(patrol, {status: 'failed', itemType: 'negative_post', execution: patrolChild,
      agent: jupiter, recordId: record.id, metadata: {unattendedNegativePatrol: true}, attemptStatus: 'failed'});
    const patrolStuckChild = await f.child(patrol, jupiter);
    await f.item(patrol, {status: 'needs_action', execution: patrolStuckChild, agent: jupiter, error: TECHNICAL_ERROR});
    assert.equal((await f.close(patrol.id)).status, 200);
    const closedPatrol = await f.row(patrol.id);
    assert.ok(closedPatrol.attention_dismissed_at);
    assert.deepEqual((await f.request('/history/clear', {body: {taskIds: [patrol.id]}})).body.clearedTaskIds, [patrol.id]);
    const recovered = await f.request(`/orchestrations/${patrol.id}/negative-patrol/retry`, {body: {
      itemIds: [patrolItem.id], expectedRevision: closedPatrol.orchestration_revision}});
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const patrolReopened = await f.row(patrol.id);
    assert.equal(patrolReopened.status, 'running');
    assert.equal(patrolReopened.attention_dismissed_at, null);
    assert.equal(patrolReopened.metadata.historyClearedAt, undefined);
    assert.ok(await f.overviewTask(patrol.id), 'the recovered patrol is on the overview');
  });

  await t.test('a partial 「重试失败关键词」 on a closed fixed batch never lets the cron re-run the other closed keywords', async st => {
    const f = await fixture(st);
    const [mars, jupiter] = [await f.addAgent('火星'), await f.addAgent('木星')];
    // The source is offline and 木星 idle: without the guard the cron hands
    // every closed keyword with attempt_count < 2 to 木星.
    await query(`UPDATE capture_agents SET last_heartbeat_at=now()-interval '1 day',
      last_full_heartbeat_at=now()-interval '1 day',last_liveness_at=now()-interval '1 day' WHERE id=$1`, [mars.id]);
    const keywords = ['君越壁纸', '昂科威壁纸', '别克壁纸'];
    const parent = await f.batch({agents: [mars, jupiter], metadata: {distributionMode: 'fixed_batch',
      claimUnit: 'fixed_batch', planSnapshot: {enabled: true, platform: 'xiaohongshu', keywords,
        keywordMaxDetectedItems: 5, searchPasses: ['all'], searchFilters: {publishTime: 'day'}}}});
    const marsChild = await f.child(parent, mars);
    const items = [];
    for (const keyword of keywords) {
      items.push(await f.item(parent, {keyword, execution: marsChild, agent: mars, error: TECHNICAL_ERROR}));
    }
    const [retriedItem, ...closedItems] = items;
    assert.equal((await f.close(parent.id)).status, 200);
    const closed = await f.row(parent.id);
    assert.equal((await reconcileAutomaticCaptureRetries({tenantId: f.tenant.id, taskIds: [parent.id]})).scanned, 0,
      'a dismissed closed batch is not scanned');

    const retried = await f.request(`/orchestrations/${parent.id}/retry-items`, {body: {
      requestKey: randomUUID(), expectedRevision: closed.orchestration_revision, itemIds: [retriedItem.id]}});
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    // The one retried keyword finishes; the batch settles and is no longer dismissed.
    await query(`UPDATE capture_task_items SET status='completed', finished_at=now() WHERE id=$1`, [retriedItem.id]);
    await withTransaction(tx => refreshOrchestrationParentTask(tx, {tenantId: f.tenant.id, parentTaskId: parent.id}));
    const settled = await f.row(parent.id);
    assert.equal(settled.status, 'completed_with_failures');
    assert.equal(settled.attention_dismissed_at, null);
    const before = await Promise.all(closedItems.map(item => f.itemRow(item.id)));
    const childCount = async () => Number((await query(
      'SELECT COUNT(*)::integer AS n FROM capture_tasks WHERE parent_task_id=$1', [parent.id]))[0].n);
    const childrenBefore = await childCount();

    const automatic = await reconcileAutomaticCaptureRetries({tenantId: f.tenant.id, taskIds: [parent.id]});
    assert.equal(automatic.scanned, 1);
    assert.equal(automatic.dispatched, 0, JSON.stringify(automatic));
    assert.equal(automatic.waitingForAgent, 0, JSON.stringify(automatic));
    assert.deepEqual(await Promise.all(closedItems.map(item => f.itemRow(item.id))), before,
      'the keywords the operator ended stay failed and untouched');
    assert.equal(await childCount(), childrenBefore, 'no automatic retry child');
    assert.equal((await query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE agent_id=$1',
      [jupiter.id]))[0].n, 0, 'no command reaches the idle node');

    // An explicit 换设备重试 by the operator still re-runs them.
    const manual = await f.request(`/tasks/${parent.id}/retry-on-idle-agent`, {body: {
      requestKey: randomUUID(), expectedRevision: settled.orchestration_revision}});
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    assert.equal(manual.body.targetAgentId, jupiter.id);
    for (const item of closedItems) {
      const current = await f.itemRow(item.id);
      assert.equal(current.status, 'dispatched', item.keyword);
      assert.equal(current.assigned_agent_id, jupiter.id);
    }
  });

  await t.test('a phone batch closed with 「结束并移到历史」 refuses 「重试失败关键词」, and no retry is handed to a phone', async st => {
    const f = await fixture(st);
    const android = createAndroidControlService({enabledTenants: () => new Set([f.tenant.id])});
    const [phoneCode] = await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4) RETURNING *',
      [f.tenant.id, randomUUID()]);
    const registration = {code: phoneCode.code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const phone = (await query('SELECT * FROM capture_agents WHERE id=$1', [(await android.register(registration)).agent.id]))[0];
    const principal = {tenantId: f.tenant.id, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const poll = () => android.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true});
    const plan = {platform: 'douyin', keywords: ['别克壁纸', '君越壁纸'],
      searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'}, keywordMaxDetectedItems: 40,
      recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true}};
    // A phone that is idle, online and has searched today: the kind of node
    // retry-items used to pick.
    await query(`INSERT INTO social_agent_daily_usage(tenant_id,agent_id,platform,usage_date,searches,last_event_at)
      VALUES($1,$2,'douyin',(now() AT TIME ZONE 'Asia/Shanghai')::date,1,now())`, [f.tenant.id, phone.id]);
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,title,platform,
      source,trigger_type,status,metadata,orchestration_revision)
      VALUES($1,$2,'capture_orchestration','keyword_orchestration','手机采集','douyin','cloud','manual',
        'running',$3,1) RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', claimUnit: 'keyword', eligibleAgentIds: [phone.id],
      executionMode: 'one_time', planSnapshot: plan}]);
    const [exhausted] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,
      item_type,status,attempt_count,assignment_revision) VALUES($1,$2,'keyword:0',0,'别克壁纸','douyin','keyword',
      'pending',2,2) RETURNING *`, [f.tenant.id, parent.id]);
    const claimed = await poll();
    assert.equal(claimed.task.keyword, '别克壁纸');
    await android.complete(principal, {requestId: randomUUID(), identity: claimed.task.identity, sessionId,
      status: 'interrupted', deviceIdle: true});
    assert.equal((await f.itemRow(exhausted.id)).status, 'needs_action');
    assert.equal((await f.close(parent.id)).status, 200);
    const closed = await f.row(parent.id);
    assert.equal(closed.status, 'completed_with_failures');
    assert.equal((await f.row(claimed.task.identity.taskId)).status, 'failed', 'the phone child is settled');
    const itemBefore = await f.itemRow(exhausted.id);
    assert.equal(itemBefore.status, 'failed');

    await poll();
    const refused = await f.request(`/orchestrations/${parent.id}/retry-items`, {body: {
      requestKey: randomUUID(), expectedRevision: closed.orchestration_revision, itemIds: [exhausted.id]}});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'retry_items_mobile_source');
    assert.equal(refused.body.message, RETRY_ITEMS_MOBILE_SOURCE_MESSAGE);
    assert.deepEqual(refused.body.itemIds, [exhausted.id]);
    const after = await f.row(parent.id);
    assert.equal(after.status, 'completed_with_failures', 'the closed batch stays closed');
    assert.equal(after.orchestration_revision, closed.orchestration_revision);
    assert.ok(after.attention_dismissed_at, 'and stays in history');
    assert.deepEqual(await f.itemRow(exhausted.id), itemBefore);

    // A browser keyword of a douyin batch is not handed to that idle phone:
    // a create command is something the phone never reads.
    const browser = await f.addAgent('西瓜', {platforms: ['douyin'],
      capabilities: {...XHS_CAPABILITIES, supportedPlatforms: ['douyin']}});
    await query(`UPDATE capture_agents SET last_heartbeat_at=now()-interval '1 day',
      last_full_heartbeat_at=now()-interval '1 day',last_liveness_at=now()-interval '1 day' WHERE id=$1`, [browser.id]);
    const douyinBatch = await f.batch({platform: 'douyin', agents: [browser, phone],
      metadata: {distributionMode: 'fixed_batch', claimUnit: 'fixed_batch', planSnapshot: plan}});
    const browserChild = await f.child(douyinBatch, browser, {status: 'failed'});
    const browserItem = await f.item(douyinBatch, {keyword: '别克壁纸', status: 'failed', execution: browserChild,
      agent: browser, error: TECHNICAL_ERROR, attemptStatus: 'failed'});
    await poll();
    const handed = await f.request(`/orchestrations/${douyinBatch.id}/retry-items`, {body: {
      requestKey: randomUUID(), expectedRevision: douyinBatch.orchestration_revision, itemIds: [browserItem.id]}});
    assert.equal(handed.status, 201, JSON.stringify(handed.body));
    assert.deepEqual(handed.body.executions, [], 'waits for a browser instead');
    assert.equal((await f.itemRow(browserItem.id)).status, 'retryable');
    // The waiting-retry dispatcher does not pick the phone later either.
    await poll();
    await reconcilePendingOrchestrationRetries({limit: 20});
    const waiting = await f.itemRow(browserItem.id);
    assert.equal(waiting.status, 'retryable');
    assert.equal(waiting.metadata.retryPending, true, 'still waiting for a browser');
    assert.equal((await query('SELECT COUNT(*)::integer AS n FROM capture_agent_commands WHERE agent_id=$1',
      [phone.id]))[0].n, 0, 'no create command is queued for the phone');
  });
});
