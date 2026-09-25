import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20260925-stop-fence-closure.md: a node fenced by
// PREVIOUS_CAPTURE_STOP_UNCONFIRMED after an elastic handoff is asked to
// verify its old page, and only a bound proof, an operator or the 976a0c6
// rule releases it. The admission fence itself never changes.
const STOP_ERROR = {
  code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
  message: '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续',
};
const legacyCapabilities = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, remoteManualKeywordBatchV1: true,
  taskStateKnown: true, heartbeatDegraded: false, supportedPlatforms: ['xiaohongshu'],
};
const v16Capabilities = {...legacyCapabilities, previousCaptureStopCheckV1: true};
const hex64 = () => createHash('sha256').update(randomUUID()).digest('hex');

test('stop-fence closure asks the source node, releases only on proof or operator, and keeps admission', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {
    findCaptureAgentExecutionSlotBlocker, hashCaptureAgentToken, makeCaptureAgentToken,
  } = await import('../../../server/services/capture-cloud.js');
  const {
    STOP_FENCE_LOCAL_RELEASE_HOLD_MS, STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS, hasStopFenceCheckWork,
    readStopFenceHeartbeatWork,
  } = await import('../../../server/services/capture-stop-fence.js');
  // The Admin derives the confirmation payload from /overview with this pure
  // module; driving it here pins the server/Admin contract end to end.
  const {agentStopFenceNotice} = await import(
    '../../../web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs');
  const {
    clearCaptureOverviewProjectionCache, dispatchNextElasticWorkItem,
  } = await import('../../../server/routes/capture-cloud.js');
  const {reconcilePendingOrchestrationRetries} = await import('../../../server/routes/capture-orchestrations.js');
  const {
    assessOpsControlSnapshots, buildOpsControlWindow, collectOpsControlEvidence,
    normalizeOpsControlEvidence, normalizeOpsControlSettings,
  } = await import('../../../server/services/ops-control.js');
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
  async function http(path, {method = 'POST', body, token, tenantId} = {}) {
    const response = await fetch(`${origin}/api/capture-cloud${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...(tenantId ? {'x-tenant-id': tenantId} : {}),
      },
      ...(method === 'GET' ? {} : {body: JSON.stringify(body || {})}),
    });
    return {status: response.status, body: await response.json()};
  }
  function withKillSwitch(callback) {
    const previous = process.env.CAPTURE_STOP_FENCE_AUTO_CHECK;
    process.env.CAPTURE_STOP_FENCE_AUTO_CHECK = 'off';
    return Promise.resolve().then(callback).finally(() => {
      if (previous === undefined) delete process.env.CAPTURE_STOP_FENCE_AUTO_CHECK;
      else process.env.CAPTURE_STOP_FENCE_AUTO_CHECK = previous;
    });
  }

  async function fixture(st, {nodes = 1, capabilities = v16Capabilities} = {}) {
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Stop fence closure ${randomUUID()}`]);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const [code] = await query(`INSERT INTO auth_codes(tenant_id,code,status,expires_at)
      VALUES($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, randomUUID()]);
    const agents = [];
    for (let index = 0; index < nodes; index++) {
      const nodeCapabilities = Array.isArray(capabilities) ? capabilities[index] : capabilities;
      const [binding] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,
        status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,app_version,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES($1,$2,$3,'active',ARRAY['xiaohongshu'],$4,$5,$6,'0.4.16',now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), `节点 ${index}`, code.id, binding.id, nodeCapabilities]);
      const token = makeCaptureAgentToken();
      await query(`INSERT INTO capture_agent_tokens(agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES($1,$2,$3,$4)`, [agent.id, code.id, binding.id, hashCaptureAgentToken(token)]);
      agents.push({...agent, token, capabilities: nodeCapabilities});
    }
    const sessions = {};
    for (const role of ['tenant_admin', 'tenant_viewer']) {
      const email = `stop-fence-${role}-${randomUUID()}@integration.invalid`;
      const password = 'stop-fence-integration-only';
      const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
        VALUES($1,$2,$3,'active',false) RETURNING id`, [email, `运营 ${role}`, hashPassword(password)]);
      st.after(() => query('DELETE FROM users WHERE id=$1', [user.id]));
      await query(`INSERT INTO user_memberships(user_id,tenant_id,role,status)
        VALUES($1,$2,$3,'active')`, [user.id, tenant.id, role]);
      const login = await fetch(`${origin}/api/auth/login`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
      assert.equal(login.status, 200);
      sessions[role] = {...(await login.json()), userId: user.id};
    }
    async function task(agent, overrides = {}) {
      const data = {
        task_type: 'unattended_keyword_capture', status: 'completed', error: {}, metadata: {},
        platform: 'xiaohongshu', parent_task_id: null, client_task_id: randomUUID(), control_task_id: '',
        title: '旧关键词采集', created_at: '2026-09-24T11:33:00Z', started_at: '2026-09-24T11:33:30Z',
        finished_at: '2026-09-24T12:41:54Z', updated_at: '2026-09-24T12:42:00Z',
        ...overrides,
      };
      const [row] = await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,
        client_task_id,control_task_id,title,task_type,status,error,metadata,platform,parent_task_id,
        created_at,started_at,finished_at,updated_at)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [tenant.id, agent?.id || null, data.client_task_id, data.control_task_id, data.title, data.task_type,
        data.status, data.error, data.metadata, data.platform, data.parent_task_id, data.created_at,
        data.started_at, data.finished_at, data.updated_at]);
      return row;
    }
    async function fenced(agent, overrides = {}) {
      const parent = await task(null, {task_type: 'capture_orchestration', status: 'completed'});
      const successor = await task(null, {parent_task_id: parent.id});
      return task(agent, {
        parent_task_id: parent.id, status: 'superseded', error: STOP_ERROR,
        metadata: {handoffSuccessorTaskId: successor.id, handoffAt: '2026-09-24 20:42:00+08'},
        ...overrides,
      });
    }
    const agentIndex = agent => agents.indexOf(agent);
    async function heartbeat(index = 0, {capabilities: override, tasks = []} = {}) {
      const agent = agents[index];
      const result = await http('/agent/heartbeat', {token: agent.token, body: {
        agent: {clientUuid: agent.client_uuid, appVersion: '0.4.16', capabilities: override || agent.capabilities},
        ...(tasks === null ? {} : {tasks}),
      }});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    }
    const receipt = (index, checkId, body) => http(
      `/agent/stop-fence-checks/${checkId}/complete`, {token: agents[index].token, body});
    const admin = (index, action, body = {}, role = 'tenant_admin') => http(
      `/agents/${agents[index].id}/stop-fence/${action}`,
      {token: sessions[role].token, tenantId: tenant.id, body});
    async function overview() {
      clearCaptureOverviewProjectionCache();
      const result = await http('/overview', {method: 'GET', token: sessions.tenant_admin.token, tenantId: tenant.id});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return new Map(result.body.agents.map(agent => [agent.id, agent]));
    }
    const row = async id => (await query('SELECT * FROM capture_tasks WHERE id=$1', [id]))[0];
    const check = async id => (await row(id)).metadata.stopFenceCheck;
    const events = (id, type) => query(`SELECT * FROM capture_task_events WHERE task_id=$1
      AND ($2::text IS NULL OR event_type=$2) ORDER BY id`, [id, type || null]);
    const patchCheck = (id, patch) => query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,
      '{stopFenceCheck}', (metadata->'stopFenceCheck') || $2::jsonb) WHERE id=$1`, [id, patch]);
    const blocker = (index = 0) => withTransaction(tx => findCaptureAgentExecutionSlotBlocker(
      tx, tenant.id, agents[index].id));
    return {tenant, agents, sessions, task, fenced, heartbeat, receipt, admin, overview, row, check,
      events, patchCheck, blocker, agentIndex};
  }

  const past = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  function proofBody(offer, overrides = {}) {
    return {
      taskId: offer.taskId,
      requestId: offer.requestId,
      result: {
        version: 1, mode: 'check', checkId: offer.checkId, taskId: offer.taskId,
        requestId: offer.requestId, accepted: true, reason: 'previous_capture_stopped',
        retryable: false, requiresOperator: false, proofMethod: 'browser_sweep',
        requestKnown: true, requestStatus: 'needs_action', requestActive: false,
        attemptId: offer.attemptId, runtimeEpochOrigin: 'browser_startup',
        runtimeStartedAt: past(20), fenceRuntime: 'different', captureRequestKnown: true,
        sweepComplete: true, sweptTabCount: 2, unresolvedTabCount: 0, relayInFlightCount: 0,
        targets: [
          {tabId: 11, role: 'progress_tab', evidence: 'tab_closed', platform: 'xiaohongshu', documentState: 'unknown'},
          {tabId: 12, role: 'platform_tab', evidence: 'content_idle', platform: 'xiaohongshu',
            documentState: 'current_runtime', overlayState: ''},
        ],
        pendingTabIds: [], pendingTabs: [], runnerTabsClosed: 0, scopedCancelSent: false,
        lockReleased: true, localLockBoundToRequest: false, residueReleased: true,
        checkedAt: past(0), durationMs: 1800, message: '设备已确认旧采集页面已停止',
        ...overrides,
      },
    };
  }
  function failureBody(offer, reason, overrides = {}) {
    return proofBody(offer, {
      accepted: false, reason, retryable: true, requiresOperator: false,
      sweepComplete: true, unresolvedTabCount: 0, targets: [], sweptTabCount: 0, ...overrides,
    });
  }

  await t.test('a capable node gets one bound check per round without touching updated_at', async st => {
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    assert.equal((await f.blocker())?.id, old.id, 'the fence holds the node before any check');
    const first = await f.heartbeat();
    assert.equal(first.stopFenceChecks.length, 1, JSON.stringify(first));
    const [offer] = first.stopFenceChecks;
    assert.equal(offer.version, 1);
    assert.equal(offer.mode, 'check');
    assert.equal(offer.taskId, old.id);
    assert.equal(offer.requestId, old.client_task_id);
    assert.equal(offer.platform, 'xiaohongshu');
    assert.ok(Date.parse(offer.expiresAt) > Date.now());
    const afterOffer = await f.row(old.id);
    assert.equal(afterOffer.updated_at.toISOString(), old.updated_at.toISOString(), 'updated_at is untouched');
    assert.equal(afterOffer.status, 'superseded');
    assert.deepEqual(afterOffer.error, STOP_ERROR);
    const state = afterOffer.metadata.stopFenceCheck;
    assert.equal(state.checkId, offer.checkId);
    assert.equal(state.round, 1);
    assert.equal(state.offerCount, 1);
    assert.equal(state.failureCount, 0);
    assert.equal((await f.events(old.id, 'stop_fence_check_requested')).length, 1);
    assert.equal((await f.blocker())?.id, old.id, 'offering a check never releases the fence');
    // The check is not a remote command and cannot occupy the slot.
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE agent_id=$1', [f.agents[0].id])).length, 0);

    const second = await f.heartbeat();
    assert.equal(second.stopFenceChecks.length, 1);
    assert.equal(second.stopFenceChecks[0].checkId, offer.checkId, 'the same round is re-offered');
    assert.deepEqual((await f.row(old.id)).metadata, afterOffer.metadata, 'no write within five minutes');
    assert.equal((await f.events(old.id)).length, 1, 'no new event within five minutes');
  });

  await t.test('old versions, incomplete heartbeats and the kill switch get nothing and write nothing', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: [legacyCapabilities, v16Capabilities]});
    const legacy = await f.fenced(f.agents[0]);
    const modern = await f.fenced(f.agents[1]);
    const legacyBeat = await f.heartbeat(0);
    assert.equal('stopFenceChecks' in legacyBeat, false, '0.4.15 never sees the field');
    assert.deepEqual((await f.row(legacy.id)).metadata, legacy.metadata);
    const incomplete = await f.heartbeat(1, {tasks: null});
    assert.deepEqual(incomplete.stopFenceChecks, []);
    const unknownState = await f.heartbeat(1, {capabilities: {...v16Capabilities, taskStateKnown: false}});
    assert.deepEqual(unknownState.stopFenceChecks, []);
    await withKillSwitch(async () => {
      assert.deepEqual((await f.heartbeat(1)).stopFenceChecks, []);
    });
    assert.deepEqual((await f.row(modern.id)).metadata, modern.metadata);
    assert.equal((await f.events(modern.id)).length, 0);
    assert.equal((await f.heartbeat(1)).stopFenceChecks.length, 1, 'switching back on resumes checks');
  });

  await t.test('a bound proof releases the node in the manual precedent format and wakes waiting recovery', async st => {
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    const keywords = ['安吉星', '别克'];
    const plan = {enabled: true, platform: 'xiaohongshu', keywords, keywordMaxDetectedItems: 5,
      searchPasses: ['all'], searchFilters: {publishTime: 'day'},
      recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
      'keyword_orchestration','xiaohongshu','pending','新批次',$3,'{"total":1}') RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', eligibleAgentIds: [f.agents[0].id], planSnapshot: plan}]);
    const [item] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,
      keyword,platform,status,ordinal,metadata) VALUES($1,$2,$3,'keyword',$3,'xiaohongshu','pending',0,$4)
      RETURNING *`, [f.tenant.id, parent.id, keywords[0], {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    await query(`INSERT INTO capture_recovery_intents(tenant_id,parent_task_id,item_id,status,
      recovery_key,source_fingerprint,window_ends_at) VALUES($1,$2,$3,'waiting_agent',$4,$5,now()+interval '1 hour')`,
    [f.tenant.id, parent.id, item.id, hex64(), hex64()]);

    const beat = await f.heartbeat();
    assert.equal(beat.commands.length, 0, 'the fenced node cannot claim before the proof');
    const [offer] = beat.stopFenceChecks;
    await query('DELETE FROM ops_control_wakeups WHERE tenant_id=$1', [f.tenant.id]);
    const released = await f.receipt(0, offer.checkId, proofBody(offer));
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.released, true);

    const after = await f.row(old.id);
    assert.equal(after.status, 'superseded', 'status is not rewritten');
    assert.equal(after.updated_at.toISOString(), old.updated_at.toISOString());
    assert.equal(after.error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.equal(after.error.originalCode, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    assert.equal(after.error.message, STOP_ERROR.message, 'original message kept');
    const reconciliation = after.metadata.historicalStopFenceReconciliation;
    assert.equal(reconciliation.proofStatus, 'agent_confirmed');
    assert.equal(reconciliation.reason, 'agent_confirmed_previous_capture_stopped');
    assert.deepEqual(reconciliation.originalError, STOP_ERROR);
    assert.equal(reconciliation.checkId, offer.checkId);
    assert.equal(reconciliation.requestId, old.client_task_id);
    assert.equal(reconciliation.evidence.proofMethod, 'browser_sweep');
    assert.equal(reconciliation.evidence.targets.length, 2);
    assert.equal(after.metadata.stopFenceCheck.resolution, 'agent_confirmed');
    assert.equal(after.metadata.handoffSuccessorTaskId, old.metadata.handoffSuccessorTaskId);
    const [event] = await f.events(old.id, 'historical_stop_fence_reconciled');
    assert.equal(event.actor_type, 'capture_agent');
    assert.equal(event.status, 'superseded');
    assert.equal(event.payload.proofStatus, 'agent_confirmed');
    assert.deepEqual(event.payload.originalError, STOP_ERROR);
    assert.equal(await f.blocker(), null, 'admission no longer counts the row');
    const [wakeup] = await query(`SELECT * FROM ops_control_wakeups WHERE tenant_id=$1 AND dedupe_key=$2`,
      [f.tenant.id, `capture-recovery-agent-slot:${f.tenant.id}:${f.agents[0].id}`]);
    assert.equal(wakeup?.payload?.trigger, 'stop_fence_reconciled');

    const next = await f.heartbeat();
    assert.equal(next.commands.length, 1, JSON.stringify(next));
    assert.equal(next.commands[0].command_type, 'create');
    assert.deepEqual(next.stopFenceChecks, []);

    const replay = await f.receipt(0, offer.checkId, proofBody(offer));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true, 'a released row answers idempotently');

    // A late snapshot still carrying the old error cannot re-raise the fence.
    await f.heartbeat(0, {tasks: [{id: old.client_task_id, controlTaskId: old.id, status: 'needs_action',
      taskType: 'unattended_keyword_capture', platform: 'xiaohongshu', title: old.title,
      error: STOP_ERROR, updatedAt: new Date().toISOString(), attemptNumber: 1}]});
    assert.equal((await f.row(old.id)).error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
  });

  await t.test('stale, foreign, mismatched and unproven receipts keep the fence and are recorded once', async st => {
    const f = await fixture(st, {nodes: 2});
    const other = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    let [offer] = (await f.heartbeat(0)).stopFenceChecks;
    const stale = await f.receipt(0, randomUUID(), proofBody(offer));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stop_fence_check_stale');
    assert.equal((await f.receipt(1, offer.checkId, proofBody(offer))).status, 404, 'another node');
    assert.equal((await other.receipt(0, offer.checkId, proofBody(offer))).status, 404, 'another tenant');
    const mismatch = await f.receipt(0, offer.checkId, {...proofBody(offer), requestId: 'another-request'});
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'stop_fence_check_request_mismatch');
    assert.equal((await f.check(old.id)).failureCount, 0, 'binding failures record nothing');

    const invalid = await f.receipt(0, offer.checkId, {...proofBody(offer), result: {...proofBody(offer).result, version: 2}});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_stop_fence_check_result');
    let state = await f.check(old.id);
    assert.equal(state.lastResult.reason, 'invalid_result');
    assert.equal(state.failureCount, 1);
    assert.equal((await f.receipt(0, offer.checkId, {...proofBody(offer), result: 'x'})).status, 400);
    assert.equal((await f.check(old.id)).failureCount, 1, 'a retried delivery is not a second failure');

    const nextRound = async () => {
      await f.patchCheck(old.id, {nextIssueAt: past(1)});
      const [fresh] = (await f.heartbeat(0)).stopFenceChecks;
      assert.notEqual(fresh.checkId, offer.checkId, 'each round has a fresh checkId');
      offer = fresh;
    };
    await nextRound();
    assert.equal((await f.check(old.id)).round, 2);
    const rejected = await f.receipt(0, offer.checkId, proofBody(offer, {
      targets: [{tabId: 21, evidence: 'tab_frozen', platform: 'xiaohongshu', documentState: 'unknown'}],
      sweptTabCount: 1,
    }));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.released, false);
    assert.ok(Date.parse(rejected.body.nextIssueAt) > Date.now());
    state = await f.check(old.id);
    assert.equal(state.lastResult.reason, 'proof_rejected');
    assert.match(state.lastResult.message, /evidence_not_proof:tab_frozen/u);
    assert.equal(state.failureCount, 2);
    assert.equal((await f.row(old.id)).error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');

    await nextRound();
    const pendingTabs = [{tabId: 31, platform: 'xiaohongshu', evidence: 'old_document_uninspectable', title: '小红书搜索'}];
    const operator = await f.receipt(0, offer.checkId, failureBody(offer, 'old_document_uninspectable', {
      retryable: false, requiresOperator: true, pendingTabIds: [31], pendingTabs,
    }));
    assert.equal(operator.status, 200);
    assert.match(operator.body.message, /重启 Chrome/u);
    state = await f.check(old.id);
    assert.equal(state.lastResult.requiresOperator, true);
    assert.equal(state.lastResult.pendingTabCount, 1);
    assert.equal(state.lastResult.pendingTabs[0].title, '小红书搜索');
    assert.ok(state.escalatedAt, 'an operator-only result escalates');
    await nextRound();
    await f.receipt(0, offer.checkId, failureBody(offer, 'old_document_uninspectable', {requiresOperator: true, pendingTabs}));
    const failedEvents = await f.events(old.id, 'stop_fence_check_failed');
    assert.deepEqual(failedEvents.map(event => event.payload.reason),
      ['invalid_result', 'proof_rejected', 'old_document_uninspectable'], 'only reason changes are logged');
    assert.equal((await f.events(old.id, 'stop_fence_check_escalated')).length, 1);
    assert.equal((await f.check(old.id)).failureCount, 4);

    await f.patchCheck(old.id, {expiresAt: past(20), lastResult: null});
    assert.equal((await f.receipt(0, offer.checkId, proofBody(offer))).status, 409, 'expired beyond grace');
    assert.equal((await f.blocker())?.id, old.id, 'nothing above released the node');
  });

  await t.test('failed and unanswered rounds retry after three minutes and escalate at three or thirty', async st => {
    const f = await fixture(st, {nodes: 2});
    const old = await f.fenced(f.agents[0]);
    const [first] = (await f.heartbeat(0)).stopFenceChecks;
    await f.receipt(0, first.checkId, failureBody(first, 'probe_failed'));
    assert.deepEqual((await f.heartbeat(0)).stopFenceChecks, [], 'no offer before nextIssueAt');
    assert.equal((await f.check(old.id)).checkId, first.checkId);
    await f.patchCheck(old.id, {nextIssueAt: past(1)});
    const [second] = (await f.heartbeat(0)).stopFenceChecks;
    assert.notEqual(second.checkId, first.checkId);
    let state = await f.check(old.id);
    assert.equal(state.round, 2);
    assert.equal(state.failureCount, 1);

    await f.patchCheck(old.id, {expiresAt: past(1)});
    assert.deepEqual((await f.heartbeat(0)).stopFenceChecks, [], 'an expired round is counted, not re-offered');
    state = await f.check(old.id);
    assert.equal(state.failureCount, 2);
    assert.equal(state.lastResult.reason, 'check_timeout');
    assert.equal(state.lastResult.checkId, second.checkId);
    assert.ok(Date.parse(state.nextIssueAt) > Date.now());
    assert.equal(state.escalatedAt, null);

    await f.patchCheck(old.id, {nextIssueAt: past(1)});
    const [third] = (await f.heartbeat(0)).stopFenceChecks;
    await f.patchCheck(old.id, {expiresAt: past(1)});
    await f.heartbeat(0);
    state = await f.check(old.id);
    assert.equal(state.round, 3);
    assert.equal(state.lastResult.checkId, third.checkId);
    assert.equal(state.failureCount, 3);
    assert.ok(state.escalatedAt, 'the third failed round escalates');
    assert.equal((await f.events(old.id, 'stop_fence_check_escalated')).length, 1);
    await f.patchCheck(old.id, {nextIssueAt: past(1)});
    assert.equal((await f.heartbeat(0)).stopFenceChecks.length, 1, 'retries continue after escalation');
    assert.equal((await f.events(old.id, 'stop_fence_check_escalated')).length, 1);

    const slow = await f.fenced(f.agents[1]);
    const [slowOffer] = (await f.heartbeat(1)).stopFenceChecks;
    await f.patchCheck(slow.id, {firstIssuedAt: past(31)});
    const [still] = (await f.heartbeat(1)).stopFenceChecks;
    assert.equal(still.checkId, slowOffer.checkId);
    assert.ok((await f.check(slow.id)).escalatedAt, 'a first round older than 30 minutes escalates');
    assert.equal((await f.events(slow.id, 'stop_fence_check_escalated')).length, 1);
  });

  await t.test('operator confirmation releases only what was seen and asks 0.4.16 to drop its local lock', async st => {
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    const held = await f.task(f.agents[0], {status: 'needs_action', error: STOP_ERROR, title: '仍待处理'});
    const viewer = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [old.id]}, 'tenant_viewer');
    assert.equal(viewer.status, 403);
    const missing = await f.admin(0, 'confirm', {expectedTaskIds: [old.id]});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'agent_stop_fence_confirmation_required');
    assert.ok(missing.body.message);
    const changed = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: []});
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, 'agent_stop_fence_changed');
    assert.equal((await f.row(old.id)).error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');

    const confirmed = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止',
      expectedTaskIds: [old.id], note: '已在现场关闭小红书页面'});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.taskIds, [old.id]);
    assert.deepEqual(confirmed.body.requiresTaskAction.map(task => task.id), [held.id]);
    assert.match(confirmed.body.message, /下次心跳时释放本机执行锁[\s\S]*仍需处理/u);
    const after = await f.row(old.id);
    assert.equal(after.error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.equal(after.metadata.historicalStopFenceReconciliation.proofStatus, 'operator_confirmed');
    assert.equal(after.metadata.historicalStopFenceReconciliation.note, '已在现场关闭小红书页面');
    assert.equal(after.metadata.stopFenceCheck.localRelease.state, 'pending');
    assert.equal(after.updated_at.toISOString(), old.updated_at.toISOString());
    const heldAfter = await f.row(held.id);
    assert.equal(heldAfter.status, 'needs_action', 'a non-superseded fence is never released here');
    assert.equal(heldAfter.error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    const [event] = await f.events(old.id, 'historical_stop_fence_reconciled');
    assert.equal(event.actor_type, 'user');
    assert.match(event.message, /人工确认旧采集页面已停止/u);
    const [audit] = await query(`SELECT * FROM audit_logs WHERE tenant_id=$1
      AND action='capture_agent.stop_fence_confirmed'`, [f.tenant.id]);
    assert.deepEqual(audit.metadata.taskIds, [old.id]);
    assert.equal(audit.metadata.note, '已在现场关闭小红书页面');
    assert.equal((await f.blocker())?.id, held.id, 'the needs_action task still holds the node');

    const beat = await f.heartbeat();
    assert.equal(beat.stopFenceChecks.length, 1);
    const [release] = beat.stopFenceChecks;
    assert.equal(release.mode, 'release_only');
    assert.equal(release.checkId, after.metadata.stopFenceCheck.localRelease.checkId);
    const done = await f.receipt(0, release.checkId, {taskId: old.id, requestId: old.client_task_id, result: {
      version: 1, mode: 'release_only', checkId: release.checkId, taskId: old.id,
      requestId: old.client_task_id, accepted: true, reason: 'local_release_done', retryable: false,
      runnerTabsClosed: 0, lockReleased: true, localLockBoundToRequest: true, residueReleased: true,
      checkedAt: new Date().toISOString(), message: '已释放本机执行锁',
    }});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.localRelease, 'done');
    assert.equal((await f.check(old.id)).localRelease.state, 'done');
    assert.equal((await f.events(old.id, 'stop_fence_local_release_done')).length, 1);
    assert.deepEqual((await f.heartbeat()).stopFenceChecks, []);

    const expiring = await f.fenced(f.agents[0]);
    await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [expiring.id]});
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,expiresAt}',
      to_jsonb($2::text)) WHERE id=$1`, [expiring.id, past(1)]);
    assert.deepEqual((await f.heartbeat()).stopFenceChecks, []);
    assert.equal((await f.check(expiring.id)).localRelease.state, 'expired');
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: f.tenant.id, agentId: f.agents[0].id})), false, 'nothing left to offer');

    const legacy = await fixture(st, {capabilities: legacyCapabilities});
    const legacyOld = await legacy.fenced(legacy.agents[0]);
    const legacyConfirmed = await legacy.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [legacyOld.id]});
    assert.equal(legacyConfirmed.status, 200);
    assert.match(legacyConfirmed.body.message, /重启 Chrome/u);
    assert.equal((await legacy.check(legacyOld.id)).localRelease, undefined, 'old versions never get a local release');
    assert.equal(await legacy.blocker(), null);
  });

  await t.test('a recheck starts a fresh epoch and is refused where it cannot help', async st => {
    const f = await fixture(st, {nodes: 2});
    const old = await f.fenced(f.agents[0]);
    const [offer] = (await f.heartbeat(0)).stopFenceChecks;
    await f.receipt(0, offer.checkId, failureBody(offer, 'old_document_uninspectable', {requiresOperator: true}));
    assert.ok((await f.check(old.id)).escalatedAt);
    assert.equal((await f.admin(0, 'recheck', {}, 'tenant_viewer')).status, 403);
    const recheck = await f.admin(0, 'recheck');
    assert.equal(recheck.status, 200, JSON.stringify(recheck.body));
    assert.match(recheck.body.message, /已请求节点重新核对/u);
    const state = await f.check(old.id);
    assert.notEqual(state.checkId, offer.checkId);
    assert.equal(state.failureCount, 0);
    assert.equal(state.escalatedAt, null);
    assert.equal(state.nextIssueAt, null);
    assert.equal(state.requestedBy, 'user');
    assert.equal(state.lastResult.reason, 'old_document_uninspectable', 'the last findings stay visible');
    const [requested] = (await f.events(old.id, 'stop_fence_check_requested')).filter(event => event.actor_type === 'user');
    assert.match(requested.message, /重新核对/u);
    assert.equal((await query(`SELECT id FROM audit_logs WHERE tenant_id=$1
      AND action='capture_agent.stop_fence_recheck_requested'`, [f.tenant.id])).length, 1);
    assert.equal((await f.receipt(0, offer.checkId, proofBody(offer))).status, 409, 'the replaced id is stale');
    const [fresh] = (await f.heartbeat(0)).stopFenceChecks;
    assert.equal(fresh.checkId, state.checkId, 'the new round is offered immediately');

    await withKillSwitch(async () => {
      const disabled = await f.admin(0, 'recheck');
      assert.equal(disabled.status, 409);
      assert.equal(disabled.body.error, 'agent_stop_fence_check_disabled');
    });
    const absent = await f.admin(1, 'recheck');
    assert.equal(absent.status, 409);
    assert.equal(absent.body.error, 'agent_stop_fence_absent');
    await query(`UPDATE capture_agents SET last_liveness_at=now()-interval '10 minutes',
      last_full_heartbeat_at=now()-interval '10 minutes', last_heartbeat_at=now()-interval '10 minutes'
      WHERE id=$1`, [f.agents[0].id]);
    const offline = await f.admin(0, 'recheck');
    assert.equal(offline.status, 200);
    assert.match(offline.body.message, /离线/u);

    const legacy = await fixture(st, {capabilities: legacyCapabilities});
    await legacy.fenced(legacy.agents[0]);
    const unsupported = await legacy.admin(0, 'recheck');
    assert.equal(unsupported.status, 409);
    assert.equal(unsupported.body.error, 'agent_stop_fence_check_unsupported');
    assert.match(unsupported.body.message, /0\.4\.16/u);
  });

  await t.test('non-superseded fences are never offered, answered or confirmed away', async st => {
    const f = await fixture(st);
    const held = await f.task(f.agents[0], {status: 'needs_action', error: STOP_ERROR});
    assert.deepEqual((await f.heartbeat()).stopFenceChecks, []);
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: f.tenant.id, agentId: f.agents[0].id})), false);
    const answer = await f.receipt(0, randomUUID(), proofBody({checkId: randomUUID(), taskId: held.id,
      requestId: held.client_task_id}));
    assert.equal(answer.status, 409);
    const confirm = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [held.id]});
    assert.equal(confirm.status, 409);
    assert.equal(confirm.body.error, 'agent_stop_fence_task_action_required');
    assert.deepEqual(confirm.body.requiresTaskAction.map(task => task.id), [held.id]);
    const recheck = await f.admin(0, 'recheck');
    assert.equal(recheck.body.error, 'agent_stop_fence_task_action_required');
    assert.equal((await f.row(held.id)).error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'task_action_required');
  });

  await t.test('an elastic handoff leaves a trace only when the source node is fenced', async st => {
    for (const fencedSource of [true, false]) {
      const f = await fixture(st, {nodes: 2});
      const plan = {enabled: true, platform: 'xiaohongshu', keywords: ['安吉星'], keywordMaxDetectedItems: 5,
        searchPasses: ['all'], searchFilters: {publishTime: 'day'},
        recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
      const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
        feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
        'keyword_orchestration','xiaohongshu','running','接力批次',$3,'{"total":1}') RETURNING *`,
      [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool',
        eligibleAgentIds: f.agents.map(agent => agent.id), planSnapshot: plan}]);
      const source = await f.task(f.agents[0], {parent_task_id: parent.id, status: 'needs_action',
        error: fencedSource ? STOP_ERROR : {code: 'SEARCH_FILTER_APPLICATION_FAILED'}});
      await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,
        status,ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count)
        VALUES($1,$2,'安吉星','keyword','安吉星','xiaohongshu','retryable',0,$3,$4,$5,1)`,
      [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true},
        f.agents[0].id, source.id]);
      const claim = await withTransaction(tx => dispatchNextElasticWorkItem(tx,
        {agent: f.agents[1], capabilities: v16Capabilities}));
      assert.ok(claim?.childTaskId, JSON.stringify(claim));
      assert.equal((await f.row(source.id)).status, 'superseded');
      const handoff = await f.events(source.id, 'stop_fence_handoff');
      assert.equal(handoff.length, fencedSource ? 1 : 0);
      if (fencedSource) {
        assert.equal(handoff[0].payload.sourceAgentId, f.agents[0].id);
        assert.equal(handoff[0].payload.successorTaskId, claim.childTaskId);
        assert.match(handoff[0].message, /暂不向本节点派发新任务/u);
        assert.equal((await f.blocker(0))?.id, source.id, 'the handoff never releases the source node');
        assert.equal((await f.heartbeat(0)).stopFenceChecks.length, 1, 'the source node is asked right away');
      }
    }
  });

  await t.test('the overview explains every fenced node with one server phase', async st => {
    const f = await fixture(st, {nodes: 4, capabilities: [v16Capabilities, legacyCapabilities, v16Capabilities, v16Capabilities]});
    const checked = await f.fenced(f.agents[0]);
    await f.fenced(f.agents[1]);
    await f.fenced(f.agents[3], {client_task_id: ''});
    // 976a0c6: node 2 later completed work on the same platform, so admission
    // already ignores its historical row and the overview must not list it.
    const parent = await f.task(null, {task_type: 'capture_orchestration'});
    const successor = await f.task(null, {parent_task_id: parent.id});
    const historical = await f.task(f.agents[2], {parent_task_id: parent.id, status: 'superseded', error: STOP_ERROR,
      metadata: {handoffSuccessorTaskId: successor.id}, updated_at: '2026-09-02T00:00:00Z'});
    await f.task(f.agents[2], {task_type: 'capture', created_at: '2026-09-03T00:00:00Z',
      started_at: '2026-09-03T00:01:00Z', finished_at: '2026-09-03T00:02:00Z', updated_at: '2026-09-03T00:03:00Z'});
    let agents = await f.overview();
    assert.equal(agents.get(f.agents[0].id).stop_fence.phase, 'awaiting_node');
    assert.equal(agents.get(f.agents[1].id).stop_fence.phase, 'manual_only');
    assert.equal(agents.get(f.agents[1].id).stop_fence.auto_check_supported, false);
    assert.equal(agents.get(f.agents[2].id).stop_fence, null, 'a 976a0c6 release is not a fence');
    assert.equal(agents.get(f.agents[3].id).stop_fence.phase, 'manual_only', 'an unlocatable request needs a person');
    assert.equal(agents.get(f.agents[3].id).stop_fence.tasks[0].auto_checkable, false);
    const fence = agents.get(f.agents[0].id).stop_fence;
    assert.equal(fence.task_count, 1);
    assert.equal(fence.superseded_count, 1);
    assert.equal(fence.auto_check_supported, true);
    assert.equal(fence.auto_check_enabled, true);
    assert.equal(fence.tasks[0].id, checked.id);
    assert.equal(fence.tasks[0].parent_task_id, checked.parent_task_id);
    assert.equal(fence.tasks[0].message, STOP_ERROR.message);
    assert.equal(fence.since, checked.finished_at.toISOString());
    await f.heartbeat(0);
    agents = await f.overview();
    assert.equal(agents.get(f.agents[0].id).stop_fence.phase, 'node_checking');
    assert.equal(agents.get(f.agents[0].id).stop_fence.tasks[0].check.round, 1);
    await withKillSwitch(async () => {
      assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'auto_check_disabled');
    });
    await query(`UPDATE capture_agents SET capabilities=capabilities || '{"taskStateKnown":false}'::jsonb WHERE id=$1`,
      [f.agents[0].id]);
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'heartbeat_degraded');
    await query(`UPDATE capture_agents SET last_liveness_at=now()-interval '10 minutes',
      last_full_heartbeat_at=now()-interval '10 minutes', last_heartbeat_at=now()-interval '10 minutes'
      WHERE id=$1`, [f.agents[0].id]);
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'offline');

    // The heartbeat of node 2 writes the 976a0c6 release down once.
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: f.tenant.id, agentId: f.agents[2].id})), true);
    assert.deepEqual((await f.heartbeat(2)).stopFenceChecks, []);
    const backfilled = await f.row(historical.id);
    assert.equal(backfilled.error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.equal(backfilled.metadata.historicalStopFenceReconciliation.proofStatus, 'completed');
    assert.equal(backfilled.metadata.historicalStopFenceReconciliation.reason, 'admission_rule_976a0c6');
    assert.equal(backfilled.updated_at.toISOString(), historical.updated_at.toISOString());
    assert.equal((await f.events(historical.id, 'historical_stop_fence_reconciled'))[0].actor_type, 'system');
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: f.tenant.id, agentId: f.agents[2].id})), false, 'the precheck stops matching');
    await f.heartbeat(2);
    assert.equal((await f.events(historical.id)).length, 1, 'recorded exactly once');

    // An unlocatable request is never offered; neither is a recovery-owned row.
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: f.tenant.id, agentId: f.agents[3].id})), false);
    assert.deepEqual((await f.heartbeat(3)).stopFenceChecks, []);
    const recovering = await fixture(st);
    const owned = await recovering.fenced(recovering.agents[0], {
      metadata: {recoveryTaskId: randomUUID(), handoffSuccessorTaskId: randomUUID()}});
    assert.equal(await withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: recovering.tenant.id, agentId: recovering.agents[0].id})), false);
    assert.deepEqual((await recovering.heartbeat()).stopFenceChecks, []);
    assert.deepEqual((await recovering.row(owned.id)).metadata, owned.metadata);
  });

  await t.test('manual dispatch names the fence instead of a generic busy node', async st => {
    const f = await fixture(st, {nodes: 2});
    const old = await f.fenced(f.agents[0]);
    // Retry candidates deliberately do not evaluate the fence (the detail poll
    // runs every 5 s in the general DB gate); the admin hides fenced nodes.
    const input = {requestKey: randomUUID(), executionMode: 'manual_batch', platform: 'xiaohongshu',
      keywords: ['安吉星'], keywordMaxDetectedItems: 5, searchFilters: {publishTime: 'day'}};
    const created = await http(`/agents/${f.agents[0].id}/tasks`, {token: f.sessions.tenant_admin.token,
      tenantId: f.tenant.id, body: input});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.queueBlockerReason, 'previous_capture_stop_unconfirmed');
    assert.match(created.body.message, /旧采集页面尚未确认停止/u);
    const queued = await f.row(input.requestKey);
    assert.equal(queued.metadata.queueBlocker.id, old.id);
    assert.equal(queued.metadata.queueBlocker.reason, 'previous_capture_stop_unconfirmed');
    assert.match(queued.message, /旧采集页面尚未确认停止/u);
    const busy = await f.blocker(0);
    assert.equal(busy.reason, 'previous_capture_stop_unconfirmed');
    assert.equal((await f.blocker(1)), null);
  });

  await t.test('duty evidence surfaces fenced nodes after thirty minutes without new automation', async st => {
    const f = await fixture(st, {nodes: 3, capabilities: [v16Capabilities, legacyCapabilities, v16Capabilities]});
    await f.fenced(f.agents[0]);
    await f.fenced(f.agents[1]);
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    await f.fenced(f.agents[2], {finished_at: recent, updated_at: recent});
    const now = new Date();
    const window = buildOpsControlWindow(now, normalizeOpsControlSettings({}));
    const evidence = await withTransaction(tx => collectOpsControlEvidence({tenantId: f.tenant.id, window, now, db: tx}));
    const byAgent = new Map(evidence.stopFences.map(row => [row.agentId, row]));
    assert.equal(byAgent.get(f.agents[0].id).phase, 'awaiting_node');
    assert.equal(byAgent.get(f.agents[1].id).phase, 'manual_only');
    assert.equal(byAgent.get(f.agents[2].id).phase, 'awaiting_node');
    const assessment = assessOpsControlSnapshots(null, normalizeOpsControlEvidence(evidence), {});
    assert.equal(assessment.summary.stopFenceBlockedAgentCount, 3);
    assert.equal(assessment.summary.sourceClosureBlockedCount, 0);
    const incidents = assessment.incidents.filter(row => row.type === 'capture_agent_stop_fence_blocked');
    assert.deepEqual(incidents.map(row => [row.targetId, row.severity]).sort(), [
      [f.agents[0].id, 'warning'],
      [f.agents[1].id, 'high'],
    ].sort(), 'the five-minute fence is not reported yet');
    const manual = incidents.find(row => row.severity === 'high');
    assert.equal(manual.title, '节点旧采集页面未确认停止，已暂停接单');
    assert.match(manual.message, /节点 1 自 09-24 20:41 起不接新任务[\s\S]*请到「执行节点」处理/u);
  });

  // Many rows: insert fenced tasks in one statement (no parent, so the
  // 976a0c6 rule can never release them implicitly).
  const bulkFences = (f, agent, count, {
    status = 'superseded', from = '2026-09-24T12:00:00Z', located = true,
  } = {}) => query(`
    INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,client_task_id,control_task_id,
      title,task_type,status,error,metadata,platform,created_at,started_at,finished_at,updated_at)
    SELECT $1, $2, $2, CASE WHEN $7::boolean THEN gen_random_uuid()::text ELSE '' END, '',
      '旧关键词采集 ' || n, 'unattended_keyword_capture',
      $3, $4::jsonb, '{}'::jsonb, 'xiaohongshu', $5::timestamptz, $5::timestamptz,
      $5::timestamptz + n * interval '1 minute', $5::timestamptz + n * interval '1 minute'
    FROM generate_series(1, $6::int) AS n
    RETURNING id`, [f.tenant.id, agent.id, status, STOP_ERROR, from, count, located]);
  const confirmFromOverview = async (f, index, agents) => {
    const notice = agentStopFenceNotice(agents.get(f.agents[index].id));
    assert.equal(notice.canConfirm, true, notice.confirmHint);
    return f.admin(index, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: notice.confirmTaskIds});
  };

  await t.test('the operator can confirm every superseded fence, however many rows the node holds', async st => {
    const f = await fixture(st, {nodes: 3});
    const crowded = await bulkFences(f, f.agents[0], 22);
    await bulkFences(f, f.agents[1], 20, {status: 'needs_action', from: '2026-09-24T08:00:00Z'});
    const late = await f.fenced(f.agents[1]);
    await bulkFences(f, f.agents[2], 205);
    let agents = await f.overview();
    const crowdedFence = agents.get(f.agents[0].id).stop_fence;
    assert.equal(crowdedFence.superseded_count, 22);
    assert.equal(crowdedFence.tasks.length, 20, 'the task list stays capped');
    assert.deepEqual([...crowdedFence.superseded_task_ids].sort(), crowded.map(row => row.id).sort());
    const hiddenFence = agents.get(f.agents[1].id).stop_fence;
    assert.equal(hiddenFence.tasks.some(task => task.id === late.id), false, 'twenty older held tasks fill the list');
    assert.deepEqual(hiddenFence.superseded_task_ids, [late.id]);
    assert.equal(agents.get(f.agents[2].id).stop_fence.superseded_task_ids.length, 200,
      'a node with many rows keeps its own first 200 and pushes nobody else out');

    const first = await confirmFromOverview(f, 0, agents);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.taskIds.length, 22);
    assert.equal(await f.blocker(0), null, 'the crowded node takes work again');
    const second = await confirmFromOverview(f, 1, agents);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.taskIds, [late.id]);
    assert.equal(second.body.requiresTaskAction.length, 20);
    assert.equal((await f.blocker(1))?.reason, 'previous_capture_stop_unconfirmed', 'held tasks still need an action');

    // Beyond the per-node cap the operator confirms what was listed, then the rest.
    let released = 0;
    for (let pass = 0; agents.get(f.agents[2].id).stop_fence?.superseded_count > 0; pass++) {
      assert.ok(pass < 2, 'two confirmations cover 205 rows');
      const confirmed = await confirmFromOverview(f, 2, agents);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      released += confirmed.body.taskIds.length;
      agents = await f.overview();
    }
    assert.equal(released, 205);
    assert.equal(await f.blocker(2), null);
    assert.equal((await query(`SELECT count(*)::int AS n FROM capture_tasks WHERE tenant_id=$1
      AND error->>'code'='PREVIOUS_CAPTURE_STOP_UNCONFIRMED' AND status='superseded'`, [f.tenant.id]))[0].n, 0);
  });

  await t.test('a recheck while the node is away starts its round when the node is actually asked', async st => {
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    await query(`UPDATE capture_agents SET last_liveness_at=now()-interval '10 minutes',
      last_full_heartbeat_at=now()-interval '10 minutes', last_heartbeat_at=now()-interval '10 minutes'
      WHERE id=$1`, [f.agents[0].id]);
    const recheck = await f.admin(0, 'recheck');
    assert.equal(recheck.status, 200, JSON.stringify(recheck.body));
    assert.match(recheck.body.message, /上线后会自动核对/u);
    const rotated = await f.check(old.id);
    assert.equal(rotated.lastOfferedAt, null);
    // The node stays away for 40 minutes.
    await f.patchCheck(old.id, {issuedAt: past(40), firstIssuedAt: past(40), expiresAt: past(30)});
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'offline');

    const [offer] = (await f.heartbeat()).stopFenceChecks;
    assert.ok(offer, 'the first heartbeat back is asked right away');
    assert.equal(offer.checkId, rotated.checkId);
    const state = await f.check(old.id);
    assert.equal(state.failureCount, 0, 'a round nobody was asked cannot time out');
    assert.equal(state.lastResult, null);
    assert.equal(state.escalatedAt, null);
    assert.ok(Date.parse(state.expiresAt) > Date.now() + 9 * 60_000, 'the round runs from the offer');
    assert.ok(Date.parse(state.firstIssuedAt) > Date.now() - 60_000, 'so does the escalation epoch');
    assert.equal(state.offerCount, 1);
    assert.deepEqual((await f.events(old.id)).map(event => event.event_type), ['stop_fence_check_requested']);
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'node_checking');
    const answer = await f.receipt(0, offer.checkId, proofBody(offer));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.released, true);
  });

  await t.test('after an operator confirmation new capture work waits for the node to drop its old lock', async st => {
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    const plan = {enabled: true, platform: 'xiaohongshu', keywords: ['安吉星'], keywordMaxDetectedItems: 5,
      searchPasses: ['all'], searchFilters: {publishTime: 'day'},
      recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
      'keyword_orchestration','xiaohongshu','pending','新批次',$3,'{"total":1}') RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', eligibleAgentIds: [f.agents[0].id], planSnapshot: plan}]);
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,
      keyword,platform,status,ordinal,metadata) VALUES($1,$2,'安吉星','keyword','安吉星','xiaohongshu','pending',0,$3)`,
    [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    assert.deepEqual((await f.heartbeat()).commands, [], 'the fence holds the node');
    const confirmed = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [old.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.localReleaseRequested, true);
    assert.doesNotMatch(confirmed.body.message, /节点恢复接单（/u, 'no promise of work before the lock is dropped');
    assert.match(confirmed.body.message, /下次心跳时释放本机执行锁，释放后恢复接单/u);
    assert.equal(await f.blocker(), null, 'admission is released at once');
    // Every operator-facing view says the node is held, not "does not affect dispatch".
    const heldView = (await f.overview()).get(f.agents[0].id);
    assert.equal(heldView.stop_fence.phase, 'local_release_pending');
    assert.equal(heldView.stop_fence.local_release_holds_new_work, true);
    assert.equal(agentStopFenceNotice(heldView).guidance, '节点释放本机执行锁后开始接单');

    const beat = await f.heartbeat();
    assert.deepEqual(beat.commands, [], 'no capture work in the heartbeat that carries the release');
    assert.equal(beat.elasticWorkItemClaimed, false);
    assert.deepEqual(beat.stopFenceChecks.map(offer => offer.mode), ['release_only']);
    const [release] = beat.stopFenceChecks;
    assert.ok((await f.check(old.id)).localRelease.firstOfferedAt);
    assert.deepEqual((await f.heartbeat()).commands, [], 'still waiting for the answer');
    const busy = await f.receipt(0, release.checkId, {taskId: old.id, requestId: old.client_task_id, result: {
      version: 1, mode: 'release_only', checkId: release.checkId, taskId: old.id,
      requestId: old.client_task_id, accepted: false, reason: 'lock_holder_alive', retryable: true,
      message: '本机执行锁仍被占用',
    }});
    assert.equal(busy.body.localRelease, 'pending');
    const retrying = await f.heartbeat();
    assert.deepEqual(retrying.commands, [], 'a failed release keeps new work away while it is retried');
    assert.deepEqual(retrying.stopFenceChecks, [], 'the retry waits three minutes');
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,nextIssueAt}',
      to_jsonb($2::text)) WHERE id=$1`, [old.id, past(1)]);
    assert.deepEqual((await f.heartbeat()).stopFenceChecks.map(offer => offer.checkId), [release.checkId]);
    const done = await f.receipt(0, release.checkId, {taskId: old.id, requestId: old.client_task_id, result: {
      version: 1, mode: 'release_only', checkId: release.checkId, taskId: old.id,
      requestId: old.client_task_id, accepted: true, reason: 'local_lock_absent', retryable: false,
      runnerTabsClosed: 0, lockReleased: false, localLockBoundToRequest: false, residueReleased: true,
      checkedAt: new Date().toISOString(), message: '本机没有绑定旧任务的执行锁',
    }});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const next = await f.heartbeat();
    assert.deepEqual(next.commands.map(command => command.command_type), ['create'], 'work resumes after the answer');
    assert.deepEqual(next.stopFenceChecks, []);

    // A node that never answers is not held beyond the bounded wait, and a
    // queued manual create waits the same way instead of being dropped.
    const g = await fixture(st);
    const silent = await g.fenced(g.agents[0]);
    assert.equal((await g.admin(0, 'confirm', {confirmation: '确认旧页面已停止',
      expectedTaskIds: [silent.id]})).status, 200);
    const input = {requestKey: randomUUID(), executionMode: 'manual_batch', platform: 'xiaohongshu',
      keywords: ['安吉星'], keywordMaxDetectedItems: 5, searchFilters: {publishTime: 'day'}};
    const created = await http(`/agents/${g.agents[0].id}/tasks`, {token: g.sessions.tenant_admin.token,
      tenantId: g.tenant.id, body: input});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.message, /节点正在按人工确认释放旧任务的本机执行锁，释放后自动领取/u,
      'the dispatch answer names the hold instead of "next heartbeat"');
    assert.equal(created.body.queueBlockerReason, '', 'the queueing rule itself is unchanged');
    const held = await g.heartbeat();
    assert.deepEqual(held.commands, []);
    assert.deepEqual(held.stopFenceChecks.map(offer => offer.mode), ['release_only']);
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,firstOfferedAt}',
      to_jsonb($2::text)) WHERE id=$1`, [silent.id, past(STOP_FENCE_LOCAL_RELEASE_HOLD_MS / 60_000 + 1)]);
    const resumed = await g.heartbeat();
    assert.deepEqual(resumed.commands.map(command => command.task_id), [input.requestKey]);
    assert.deepEqual(resumed.stopFenceChecks.map(offer => offer.mode), ['release_only'],
      'the release is still offered until it is answered or expires');
    const afterWindow = (await g.overview()).get(g.agents[0].id).stop_fence;
    assert.equal(afterWindow.local_release_holds_new_work, false, 'the views follow the bounded hold');
    assert.equal(agentStopFenceNotice({...g.agents[0], stop_fence: afterWindow}).guidance, '不影响派发');
  });

  await t.test('the heartbeat that first offers a release never carries new work, however late it comes', async st => {
    const confirmation = '确认旧页面已停止';
    const holdMinutes = STOP_FENCE_LOCAL_RELEASE_HOLD_MS / 60_000;
    async function elasticKeyword(f) {
      const plan = {enabled: true, platform: 'xiaohongshu', keywords: ['安吉星'], keywordMaxDetectedItems: 5,
        searchPasses: ['all'], searchFilters: {publishTime: 'day'},
        recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
      const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
        feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
        'keyword_orchestration','xiaohongshu','pending','新批次',$3,'{"total":1}') RETURNING *`,
      [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', eligibleAgentIds: [f.agents[0].id], planSnapshot: plan}]);
      await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,
        keyword,platform,status,ordinal,metadata) VALUES($1,$2,'安吉星','keyword','安吉星','xiaohongshu','pending',0,$3)`,
      [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    }
    const answer = (f, offer, accepted = true) => f.receipt(0, offer.checkId, {
      taskId: offer.taskId, requestId: offer.requestId, result: {
        version: 1, mode: 'release_only', checkId: offer.checkId, taskId: offer.taskId,
        requestId: offer.requestId, accepted, reason: accepted ? 'local_release_done' : 'lock_holder_alive',
        retryable: !accepted, lockReleased: accepted, localLockBoundToRequest: true, residueReleased: accepted,
        message: accepted ? '已释放本机执行锁' : '本机执行锁仍被占用',
      }});
    const setRequestedAt = (ids, at) => query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,
      '{stopFenceCheck,localRelease,requestedAt}', to_jsonb($2::text)) WHERE id = ANY($1::uuid[])`, [ids, at]);

    // Confirmed while the node was away. Back 15 minutes later (the reviewers'
    // repro: create and release_only arrived together) and three hours later
    // (past the never-offered bound): the first heartbeat back only releases.
    for (const awayMinutes of [15, 180]) {
      const f = await fixture(st);
      const old = await f.fenced(f.agents[0]);
      await elasticKeyword(f);
      assert.deepEqual((await f.heartbeat()).commands, [], 'the fence holds the node');
      await query(`UPDATE capture_agents SET last_liveness_at=now()-make_interval(mins => $2),
        last_full_heartbeat_at=now()-make_interval(mins => $2), last_heartbeat_at=now()-make_interval(mins => $2)
        WHERE id=$1`, [f.agents[0].id, awayMinutes + 5]);
      const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [old.id]});
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body.localReleaseRequested, true);
      await setRequestedAt([old.id], past(awayMinutes));
      const back = await f.heartbeat();
      assert.deepEqual(back.commands, [], `back after ${awayMinutes} min: no capture work beside the release`);
      assert.equal(back.elasticWorkItemClaimed, false);
      assert.deepEqual(back.stopFenceChecks.map(offer => offer.mode), ['release_only']);
      assert.ok((await f.check(old.id)).localRelease.firstOfferedAt, 'the offer starts the bounded window');
      assert.deepEqual((await f.heartbeat()).commands, [], 'still waiting for the answer');
      assert.equal((await answer(f, back.stopFenceChecks[0])).body.localRelease, 'done');
      assert.deepEqual((await f.heartbeat()).commands.map(command => command.command_type), ['create'],
        'work resumes once the old lock is dropped');
    }

    // A large confirmation is offered three rows per heartbeat. Rows not
    // offered yet keep holding past ten minutes after the confirmation, even
    // once the offered rows were answered.
    const g = await fixture(st);
    const rows = await bulkFences(g, g.agents[0], 5);
    await elasticKeyword(g);
    const confirmedAll = await g.admin(0, 'confirm', {confirmation, expectedTaskIds: rows.map(row => row.id)});
    assert.equal(confirmedAll.status, 200, JSON.stringify(confirmedAll.body));
    const first = await g.heartbeat();
    assert.deepEqual(first.commands, []);
    assert.equal(first.stopFenceChecks.length, 3);
    for (const offer of first.stopFenceChecks) assert.equal((await answer(g, offer)).body.localRelease, 'done');
    const rest = rows.map(row => row.id).filter(id => !first.stopFenceChecks.some(offer => offer.taskId === id));
    await setRequestedAt(rest, past(holdMinutes + 1));
    const second = await g.heartbeat();
    assert.deepEqual(second.commands, [], 'rows not offered yet still hold');
    assert.equal(second.elasticWorkItemClaimed, false);
    assert.deepEqual(second.stopFenceChecks.map(offer => offer.taskId).sort(), [...rest].sort());
    for (const offer of second.stopFenceChecks) assert.equal((await answer(g, offer)).body.localRelease, 'done');
    assert.deepEqual((await g.heartbeat()).commands.map(command => command.command_type), ['create']);

    // Six releases waiting for a retry never keep a new one from its first
    // offer: the claim reads never-offered releases first.
    const h = await fixture(st);
    const many = await bulkFences(h, h.agents[0], 7);
    assert.equal((await h.admin(0, 'confirm', {confirmation, expectedTaskIds: many.map(row => row.id)})).status, 200);
    const ordered = (await query('SELECT id FROM capture_tasks WHERE id = ANY($1::uuid[]) ORDER BY finished_at, id',
      [many.map(row => row.id)])).map(row => row.id);
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease}',
      (metadata #> '{stopFenceCheck,localRelease}') || $2::jsonb) WHERE id = ANY($1::uuid[])`,
    [ordered.slice(0, 6), {firstOfferedAt: past(2), lastOfferedAt: past(2), offerCount: 1, nextIssueAt: past(-2),
      lastResult: {accepted: false, reason: 'lock_holder_alive'}}]);
    const beat = await h.heartbeat();
    assert.deepEqual(beat.commands, []);
    assert.deepEqual(beat.stopFenceChecks.map(offer => offer.taskId), [ordered[6]]);

    // Bounded: a release the claim never manages to offer (say its short
    // transaction keeps failing) stops holding an hour after the
    // confirmation once the node has had a full heartbeat since; the first
    // heartbeat back from a long absence still holds.
    const k = await fixture(st);
    const stuck = await k.fenced(k.agents[0]);
    assert.equal((await k.admin(0, 'confirm', {confirmation, expectedTaskIds: [stuck.id]})).status, 200);
    await setRequestedAt([stuck.id], past(STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS / 60_000 + 1));
    const work = previousFullHeartbeatAt => withTransaction(tx => readStopFenceHeartbeatWork(tx, {
      tenantId: k.tenant.id, agentId: k.agents[0].id, previousFullHeartbeatAt}));
    assert.deepEqual(await work(new Date(Date.now() - 60_000)), {checkDue: true, holdNewWork: false});
    assert.deepEqual(await work(past(24 * 60)), {checkDue: true, holdNewWork: true});
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,expiresAt}',
      to_jsonb($2::text)) WHERE id=$1`, [stuck.id, past(1)]);
    assert.deepEqual(await work(past(24 * 60)), {checkDue: true, holdNewWork: false},
      'an expired release never holds, and is still claimed once to be closed');
  });

  await t.test('rows the node cannot locate never use up the heartbeat offer window', async st => {
    const f = await fixture(st);
    await bulkFences(f, f.agents[0], 6, {located: false, from: '2026-09-24T08:00:00Z'});
    const located = await f.fenced(f.agents[0]);
    const offers = (await f.heartbeat()).stopFenceChecks;
    assert.deepEqual(offers.map(offer => offer.taskId), [located.id], 'six older manual-only rows come first');
    assert.equal(offers[0].requestId, located.client_task_id);
  });

  await t.test('a confirmation never queues a local release that no heartbeat can deliver', async st => {
    const f = await fixture(st);
    const clone = await f.fenced(f.agents[0], {client_task_id: '', control_task_id: ''});
    const located = await f.fenced(f.agents[0]);
    const precheck = fx => withTransaction(tx => hasStopFenceCheckWork(tx,
      {tenantId: fx.tenant.id, agentId: fx.agents[0].id}));
    const agents = await f.overview();
    assert.equal(agents.get(f.agents[0].id).stop_fence.phase, 'manual_only');
    const confirmed = await confirmFromOverview(f, 0, agents);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual([...confirmed.body.taskIds].sort(), [clone.id, located.id].sort());
    assert.equal(confirmed.body.localReleaseRequested, true);
    assert.match(confirmed.body.message, /下次心跳时释放本机执行锁[\s\S]*其中 1 个任务无法定位节点本机记录/u);
    assert.equal((await f.check(clone.id)).localRelease, undefined, 'nothing the node could never be offered');
    assert.equal((await f.check(located.id)).localRelease.state, 'pending');
    const beat = await f.heartbeat();
    assert.deepEqual(beat.stopFenceChecks.map(offer => [offer.mode, offer.taskId]), [['release_only', located.id]]);
    const [release] = beat.stopFenceChecks;
    await f.receipt(0, release.checkId, {taskId: located.id, requestId: located.client_task_id, result: {
      version: 1, mode: 'release_only', checkId: release.checkId, taskId: located.id,
      requestId: located.client_task_id, accepted: true, reason: 'local_release_done', retryable: false,
      lockReleased: true, localLockBoundToRequest: true, residueReleased: true, message: '已释放',
    }});
    assert.equal(await precheck(f), false, 'the heartbeat precheck turns false once the release is answered');
    assert.deepEqual((await f.heartbeat()).stopFenceChecks, []);
    // A malformed pending release (no checkId) is closed once, never left pending.
    const malformed = await f.task(f.agents[0], {status: 'superseded',
      error: {...STOP_ERROR, code: 'HISTORICAL_STOP_FENCE_RECONCILED', originalCode: STOP_ERROR.code},
      metadata: {stopFenceCheck: {localRelease: {state: 'pending', requestedAt: past(1), expiresAt: past(-60)}}}});
    assert.equal(await precheck(f), true);
    assert.deepEqual((await f.heartbeat()).stopFenceChecks, []);
    assert.equal((await f.check(malformed.id)).localRelease.state, 'expired');
    assert.equal(await precheck(f), false);

    // With the kill switch on, a 0.4.16 node would never be offered the
    // release either: record the confirmation only, and say so.
    const g = await fixture(st);
    const old = await g.fenced(g.agents[0]);
    await withKillSwitch(async () => {
      const off = await g.admin(0, 'confirm', {confirmation: '确认旧页面已停止', expectedTaskIds: [old.id]});
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.localReleaseRequested, false);
      assert.doesNotMatch(off.body.message, /下次心跳/u);
      assert.match(off.body.message, /自动核对已在服务端关闭[\s\S]*重启 Chrome/u);
    });
    assert.equal((await g.check(old.id)).localRelease, undefined);
    assert.equal(await precheck(g), false);
    assert.deepEqual((await g.heartbeat()).stopFenceChecks, []);
    assert.equal(await g.blocker(), null);
  });

  await t.test('the hold covers offered releases however many never-offered ones stopped holding', async st => {
    // Reviewer repro: 23 releases confirmed while the node was away for more
    // than an hour. The first heartbeat back offers three; the second one must
    // still hold for those three, although the twenty never offered stopped
    // holding (the node has heartbeated since and the hour has passed).
    const unofferedMinutes = STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS / 60_000;
    const f = await fixture(st);
    const rows = await bulkFences(f, f.agents[0], 23);
    const plan = {enabled: true, platform: 'xiaohongshu', keywords: ['安吉星'], keywordMaxDetectedItems: 5,
      searchPasses: ['all'], searchFilters: {publishTime: 'day'},
      recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts) VALUES($1,$2,'capture_orchestration',
      'keyword_orchestration','xiaohongshu','pending','新批次',$3,'{"total":1}') RETURNING *`,
    [f.tenant.id, randomUUID(), {distributionMode: 'elastic_pool', eligibleAgentIds: [f.agents[0].id], planSnapshot: plan}]);
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,
      keyword,platform,status,ordinal,metadata) VALUES($1,$2,'安吉星','keyword','安吉星','xiaohongshu','pending',0,$3)`,
    [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    const confirmed = await f.admin(0, 'confirm', {confirmation: '确认旧页面已停止',
      expectedTaskIds: rows.map(row => row.id)});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,requestedAt}',
      to_jsonb($2::text)) WHERE id = ANY($1::uuid[])`, [rows.map(row => row.id), past(unofferedMinutes + 5)]);
    await query(`UPDATE capture_agents SET last_liveness_at=now()-make_interval(mins => $2),
      last_full_heartbeat_at=now()-make_interval(mins => $2), last_heartbeat_at=now()-make_interval(mins => $2)
      WHERE id=$1`, [f.agents[0].id, unofferedMinutes + 10]);
    const back = await f.heartbeat();
    assert.deepEqual(back.commands, [], 'the first heartbeat back only releases');
    assert.equal(back.stopFenceChecks.length, 3);
    const second = await f.heartbeat();
    assert.deepEqual(second.commands, [], 'three releases offered a minute ago still hold');
    assert.equal(second.elasticWorkItemClaimed, false);
    assert.equal((await withTransaction(tx => readStopFenceHeartbeatWork(tx, {
      tenantId: f.tenant.id, agentId: f.agents[0].id, previousFullHeartbeatAt: new Date(),
    }))).holdNewWork, true, 'the precheck reads the latest offered release, not the first twenty rows');
    // Once every offered window has passed, the bounded hold ends.
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{stopFenceCheck,localRelease,firstOfferedAt}',
      to_jsonb($2::text)) WHERE id = ANY($1::uuid[])
      AND metadata #>> '{stopFenceCheck,localRelease,firstOfferedAt}' IS NOT NULL`,
    [rows.map(row => row.id), past(STOP_FENCE_LOCAL_RELEASE_HOLD_MS / 60_000 + 1)]);
    assert.equal((await withTransaction(tx => readStopFenceHeartbeatWork(tx, {
      tenantId: f.tenant.id, agentId: f.agents[0].id, previousFullHeartbeatAt: new Date(),
    }))).holdNewWork, false);
  });

  await t.test('an off-site page under observation never escalates before the node proves it', async st => {
    // Extension 0.4.16 proves a page that left the platform (or sits on a
    // Chrome error page) only after ten continuous minutes, so rounds before
    // that answer off_platform_observing. They are not failures.
    const f = await fixture(st);
    const old = await f.fenced(f.agents[0]);
    let [offer] = (await f.heartbeat()).stopFenceChecks;
    const pendingTabs = [{tabId: 20, platform: 'xiaohongshu', evidence: 'off_platform_observing',
      title: '浏览器错误页·小红书搜索页'}];
    for (let round = 1; round <= 4; round += 1) {
      const answered = await f.receipt(0, offer.checkId, failureBody(offer, 'off_platform_observing', {
        pendingTabIds: [20], pendingTabs, targets: [{tabId: 20, role: 'progress_tab',
          evidence: 'off_platform_observing', platform: 'xiaohongshu', documentState: 'unknown'}], sweptTabCount: 1,
      }));
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const state = await f.check(old.id);
      assert.equal(state.failureCount, 0, `round ${round}`);
      assert.equal(state.escalatedAt ?? null, null, `round ${round} does not escalate`);
      const view = (await f.overview()).get(f.agents[0].id).stop_fence;
      assert.equal(view.phase, 'node_retrying', `round ${round} is shown as retrying, not needs_operator`);
      assert.equal(view.escalated, false);
      await f.patchCheck(old.id, {nextIssueAt: past(1)});
      [offer] = (await f.heartbeat()).stopFenceChecks;
    }
    assert.deepEqual((await f.events(old.id, 'stop_fence_check_failed')).map(event => event.payload.reason),
      ['off_platform_observing'], 'logged once, not once per round');
    assert.equal((await f.events(old.id, 'stop_fence_check_escalated')).length, 0);
    const proved = await f.receipt(0, offer.checkId, proofBody(offer, {targets: [{tabId: 20, role: 'progress_tab',
      evidence: 'navigated_off_platform', platform: 'xiaohongshu', documentState: 'unknown'}], sweptTabCount: 1}));
    assert.equal(proved.body.released, true, JSON.stringify(proved.body));
    assert.equal(await f.blocker(), null);
  });
  // docs/hotfix/20260925-needs-action-fence.md: a batch child that the node
  // left in needs_action with the fence code can never be resumed there. The
  // operator releases it with the same confirmation, and its keywords go back
  // to the batch exactly like a technical failure.
  const RELEASED_ITEM_CODE = 'PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED';
  const batchPlan = {enabled: true, platform: 'xiaohongshu', keywordMaxDetectedItems: 5,
    searchPasses: ['all'], searchFilters: {publishTime: 'day'},
    recoveryPolicy: {singleRelayV1: true, disableAutomaticSearchRetry: true, requireVerifiedFilters: true}};
  const confirmation = '确认旧页面已停止';
  async function needsActionBatch(f, {
    index = 0, elastic = true, parentStatus = 'running', parentMetadata = {}, childMetadata = {},
    childStatus = 'needs_action', attemptCount = 1,
    items = [{keyword: '檐下秋意', status: 'needs_action', error: STOP_ERROR, started: true}],
  } = {}) {
    const agent = f.agents[index];
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
      feature_key,platform,status,title,metadata,counts,orchestration_revision) VALUES($1,$2,'capture_orchestration',
      'keyword_orchestration','xiaohongshu',$3,'小红书~日常巡检',$4,$5,1) RETURNING *`,
    [f.tenant.id, randomUUID(), parentStatus, {
      distributionMode: elastic ? 'elastic_pool' : 'fixed_batch',
      eligibleAgentIds: f.agents.map(row => row.id),
      planSnapshot: {...batchPlan, keywords: items.map(item => item.keyword)},
      ...parentMetadata,
    }, {total: items.length}]);
    const child = await f.task(agent, {parent_task_id: parent.id, status: childStatus, error: STOP_ERROR,
      title: `小红书~日常巡检 · ${items[0].keyword}`, control_task_id: randomUUID(), metadata: childMetadata});
    const itemRows = [];
    for (const [ordinal, spec] of items.entries()) {
      const count = spec.attemptCount ?? attemptCount;
      const [item] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,
        platform,status,ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count,assignment_revision,
        error,started_at) VALUES($1,$2,$3,'keyword',$4,'xiaohongshu',$5,$6,$7,$8,$9,$10,1,$11,$12) RETURNING *`,
      [f.tenant.id, parent.id, `keyword:${ordinal}:${spec.keyword}`, spec.keyword, spec.status, ordinal,
        {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true},
        agent.id, child.id, count, spec.error || {}, spec.started ? new Date() : null]);
      await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,
        agent_id,attempt_number,assignment_revision,status,error) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)`,
      [f.tenant.id, item.id, parent.id, child.id, agent.id, count,
        spec.status === 'running' ? 'running' : 'needs_action', spec.error || {}]);
      itemRows.push(item);
    }
    return {parent, child, items: itemRows};
  }
  const itemRow = async id => (await query('SELECT * FROM capture_task_items WHERE id=$1', [id]))[0];
  const confirmAudits = f => query(`SELECT * FROM audit_logs WHERE tenant_id=$1
    AND action='capture_agent.stop_fence_confirmed' ORDER BY created_at, id`, [f.tenant.id]);
  const adminHttp = (f, path, body = {}) => http(path,
    {token: f.sessions.tenant_admin.token, tenantId: f.tenant.id, body});
  const addUsage = (f, index) => query(`INSERT INTO social_agent_daily_usage(tenant_id,agent_id,platform,
    usage_date,searches,last_event_at) VALUES($1,$2,'xiaohongshu',(now() AT TIME ZONE 'Asia/Shanghai')::date,1,now())`,
  [f.tenant.id, f.agents[index].id]);
  const staleSnapshot = child => ({id: child.client_task_id, controlTaskId: child.id, status: 'needs_action',
    taskType: 'unattended_keyword_capture', platform: 'xiaohongshu', title: child.title, error: STOP_ERROR,
    updatedAt: new Date().toISOString(), attemptNumber: 1});
  // Another keyword of the same batch still running on node 1, which can be
  // stopped remotely.
  const remoteStopNodes = [legacyCapabilities, {...legacyCapabilities, remoteStop: true}];
  async function runningExecution(f, parent) {
    const running = await f.task(f.agents[1], {parent_task_id: parent.id, status: 'running', error: {},
      control_task_id: randomUUID(), finished_at: null});
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,status,
      ordinal,metadata,assigned_agent_id,execution_task_id,attempt_count,assignment_revision,started_at)
      VALUES($1,$2,'keyword:5:另一个','keyword','另一个','xiaohongshu','running',5,'{}'::jsonb,$3,$4,1,1,now())`,
    [f.tenant.id, parent.id, f.agents[1].id, running.id]);
    return running;
  }
  async function completeStop(f, index, taskId) {
    const [command] = await query(`SELECT * FROM capture_agent_commands WHERE task_id=$1
      AND command_type='stop' ORDER BY created_at DESC LIMIT 1`, [taskId]);
    assert.ok(command, 'a stop command exists for the running execution');
    const done = await http(`/agent/commands/${command.id}/complete`, {token: f.agents[index].token,
      body: {success: true, result: {accepted: true, requestId: command.payload.controlTaskId,
        attemptId: command.payload.attemptId || undefined, reason: 'stopped'}}});
    assert.equal(done.status, 200, JSON.stringify(done.body));
  }

  await t.test('an old node releases a needs_action batch child and its keyword returns to the pool', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const {parent, child, items: [item]} = await needsActionBatch(f);
    assert.equal((await f.blocker(0))?.id, child.id, 'the needs_action child holds the node');
    assert.deepEqual((await f.heartbeat(0)).commands, []);
    let fence = (await f.overview()).get(f.agents[0].id).stop_fence;
    assert.equal(fence.phase, 'task_action_required', 'it still needs a person');
    assert.deepEqual(fence.operator_confirmable_task_ids, [child.id]);
    assert.equal(fence.operator_confirmable_count, 1);
    assert.equal(fence.tasks[0].operator_confirmable, true);
    assert.equal(fence.tasks[0].release_disposition, 'return_to_pool');
    const notice = agentStopFenceNotice({...f.agents[0], stop_fence: fence});
    assert.equal(notice.canConfirm, true);
    assert.deepEqual(notice.confirmTaskIds, [child.id]);

    // An older Admin never sends the id: exactly the previous behaviour.
    const unselected = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: []});
    assert.equal(unselected.status, 409);
    assert.equal(unselected.body.error, 'agent_stop_fence_task_action_required');
    assert.match(unselected.body.message, /确认旧页面已停止/u);
    assert.equal(unselected.body.requiresTaskAction[0].operatorConfirmable, true);
    assert.equal(unselected.body.requiresTaskAction[0].skipReason, 'not_selected');
    assert.equal((await f.row(child.id)).status, 'needs_action');
    assert.equal((await itemRow(item.id)).status, 'needs_action');

    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: notice.confirmTaskIds,
      note: '已重启 Chrome'});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.taskIds, [child.id]);
    assert.deepEqual(confirmed.body.needsActionTaskIds, [child.id]);
    assert.equal(confirmed.body.localReleaseRequested, false);
    assert.deepEqual(confirmed.body.requiresTaskAction, []);
    assert.match(confirmed.body.message, /已确认旧采集页面已停止，节点恢复接单（1 个任务已记录人工确认）/u);
    assert.match(confirmed.body.message, /1 个未完成关键词已退回任务池，由其它节点接力/u);
    assert.match(confirmed.body.message, /重启 Chrome/u);
    const [outcome] = confirmed.body.itemOutcomes;
    assert.equal(outcome.taskId, child.id);
    assert.equal(outcome.kind, 'returned_to_pool');
    assert.equal(outcome.retryable, 1);
    assert.equal(outcome.distributionMode, 'elastic_pool');

    const after = await f.row(child.id);
    assert.equal(after.status, 'superseded');
    assert.equal(after.error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.equal(after.error.originalCode, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
    assert.equal(after.error.message, STOP_ERROR.message, 'original message kept');
    assert.ok(after.updated_at > child.updated_at, 'a real status transition');
    assert.equal(after.metadata.terminalReason, 'stop_fence_operator_released');
    assert.equal(after.metadata.terminalDisposition, undefined,
      'no terminal notice for a stopped batch to wait on');
    assert.equal(after.metadata.handoffSuccessorTaskId, undefined);
    const reconciliation = after.metadata.historicalStopFenceReconciliation;
    assert.equal(reconciliation.proofStatus, 'operator_confirmed');
    assert.equal(reconciliation.reason, 'operator_confirmed_needs_action_released');
    assert.equal(reconciliation.releasedFromStatus, 'needs_action');
    assert.deepEqual(reconciliation.originalError, STOP_ERROR);
    assert.equal(reconciliation.note, '已重启 Chrome');
    assert.equal(reconciliation.requestId, child.control_task_id);
    assert.equal(reconciliation.itemOutcome.kind, 'returned_to_pool');
    assert.equal(after.metadata.stopFenceCheck.resolution, 'operator_confirmed');
    assert.equal(after.metadata.stopFenceCheck.localRelease, undefined, 'old versions never get a local release');
    assert.match(after.message, /本执行结束；未完成关键词已退回任务池/u);
    const [event] = await f.events(child.id, 'historical_stop_fence_reconciled');
    assert.equal(event.actor_type, 'user');
    assert.equal(event.status, 'superseded');
    assert.equal(event.payload.releasedFromStatus, 'needs_action');
    assert.equal(event.payload.itemOutcome.kind, 'returned_to_pool');
    assert.match(event.message, /人工确认旧采集页面已停止，解除停止保护；该执行结束，未完成关键词已退回任务池/u);
    const [audit] = await confirmAudits(f);
    assert.deepEqual(audit.metadata.taskIds, [child.id]);
    assert.deepEqual(audit.metadata.needsActionTaskIds, [child.id]);
    assert.equal(audit.metadata.itemOutcomes[0].kind, 'returned_to_pool');
    assert.deepEqual(audit.metadata.skipped, []);

    const released = await itemRow(item.id);
    assert.equal(released.status, 'retryable');
    assert.equal(released.error.code, RELEASED_ITEM_CODE);
    assert.equal(released.execution_task_id, child.id);
    const attempts = await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1', [item.id]);
    assert.deepEqual(attempts.map(row => row.status), ['retryable']);
    assert.notEqual((await f.row(parent.id)).updated_at.toISOString(), parent.updated_at.toISOString(),
      'the parent was refreshed');
    assert.equal(await f.blocker(0), null, 'the node takes work again');
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence, null);

    // A late snapshot of the same run cannot bring the fence back.
    await f.heartbeat(0, {tasks: [staleSnapshot(child)]});
    const replayed = await f.row(child.id);
    assert.equal(replayed.status, 'superseded');
    assert.equal(replayed.error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.deepEqual(replayed.metadata.historicalStopFenceReconciliation, after.metadata.historicalStopFenceReconciliation);
    const replayedItem = await itemRow(item.id);
    assert.equal(replayedItem.status, 'retryable');
    assert.equal(replayedItem.error.code, RELEASED_ITEM_CODE);
    assert.equal(await f.blocker(0), null);

    // The source node never gets the same keyword back in this round; any
    // other node picks it up, and nothing records a handoff trace.
    assert.equal(await withTransaction(tx => dispatchNextElasticWorkItem(tx,
      {agent: f.agents[0], capabilities: legacyCapabilities})), null);
    const claim = await withTransaction(tx => dispatchNextElasticWorkItem(tx,
      {agent: f.agents[1], capabilities: legacyCapabilities}));
    assert.ok(claim?.childTaskId, JSON.stringify(claim));
    const claimed = await itemRow(item.id);
    assert.equal(claimed.assigned_agent_id, f.agents[1].id);
    assert.equal(claimed.execution_task_id, claim.childTaskId);
    const source = await f.row(child.id);
    assert.equal(source.status, 'superseded');
    assert.equal(source.metadata.handoffSuccessorTaskId, undefined);
    assert.equal((await f.events(child.id, 'stop_fence_handoff')).length, 0);

    // New keywords go to the released node on its next heartbeat.
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,status,
      ordinal,metadata) VALUES($1,$2,'keyword:9:新词','keyword','新词','xiaohongshu','pending',9,$3)`,
    [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    const next = await f.heartbeat(0);
    assert.deepEqual(next.commands.map(command => command.command_type), ['create'], JSON.stringify(next));
  });

  await t.test('a 0.4.16 node drops its lock before new work after a needs_action release', async st => {
    const f = await fixture(st, {nodes: 2});
    const {parent, child} = await needsActionBatch(f);
    await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,status,
      ordinal,metadata) VALUES($1,$2,'keyword:9:新词','keyword','新词','xiaohongshu','pending',9,$3)`,
    [f.tenant.id, parent.id, {singleRelayV1: true, searchPasses: ['all'], requireVerifiedFilters: true}]);
    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.localReleaseRequested, true);
    assert.match(confirmed.body.message, /退回任务池[\s\S]*下次心跳时释放本机执行锁，释放后恢复接单/u);
    assert.doesNotMatch(confirmed.body.message, /重启 Chrome/u);
    const localRelease = (await f.check(child.id)).localRelease;
    assert.equal(localRelease.state, 'pending');
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.phase, 'local_release_pending');

    const beat = await f.heartbeat(0);
    assert.deepEqual(beat.commands, [], 'no capture work beside the release');
    assert.deepEqual(beat.stopFenceChecks.map(offer => [offer.mode, offer.taskId, offer.requestId]),
      [['release_only', child.id, child.control_task_id]]);
    const done = await f.receipt(0, beat.stopFenceChecks[0].checkId, {taskId: child.id,
      requestId: child.control_task_id, result: {version: 1, mode: 'release_only',
        checkId: beat.stopFenceChecks[0].checkId, taskId: child.id, requestId: child.control_task_id,
        accepted: true, reason: 'local_release_done', retryable: false, lockReleased: true,
        localLockBoundToRequest: true, residueReleased: true, message: '已释放本机执行锁'}});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await f.check(child.id)).localRelease.state, 'done');
    const next = await f.heartbeat(0);
    assert.deepEqual(next.commands.map(command => command.command_type), ['create'], 'work resumes');
    assert.deepEqual(next.stopFenceChecks, []);
  });

  await t.test('a fixed-allocation child ends with its keywords ready for 重试失败关键词', async st => {
    const f = await fixture(st, {nodes: 3, capabilities: legacyCapabilities});
    const blocked = {code: 'blocked_by_prior_item', message: '前一个关键词需要处理'};
    const {parent, child, items} = await needsActionBatch(f, {elastic: false, items: [
      {keyword: '檐下秋意', status: 'running', error: {}, started: true},
      {keyword: '秋日车机', status: 'needs_action', error: blocked},
      {keyword: '安吉星', status: 'needs_action', error: blocked},
    ]});
    assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.tasks[0].release_disposition, 'batch_retry');
    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.match(confirmed.body.message, /3 个未完成关键词已标为需处理，可在批次里点「重试失败关键词」/u);
    assert.doesNotMatch(confirmed.body.message, /退回任务池/u);
    const [outcome] = confirmed.body.itemOutcomes;
    assert.equal(outcome.kind, 'batch_retry');
    assert.equal(outcome.needsAction, 3);
    for (const item of items) {
      const row = await itemRow(item.id);
      assert.equal(row.status, 'needs_action', item.keyword);
      assert.equal(row.error.code, RELEASED_ITEM_CODE);
    }
    assert.equal((await f.row(parent.id)).status, 'needs_action');
    assert.match((await f.row(child.id)).message, /可在批次里点「重试失败关键词」/u);
    assert.match((await f.events(child.id, 'historical_stop_fence_reconciled'))[0].message, /重试失败关键词/u);
    assert.equal((await confirmAudits(f))[0].metadata.itemOutcomes[0].kind, 'batch_retry');

    // Control: a source superseded by an ordinary handoff is still not settled.
    const other = await needsActionBatch(f, {index: 1, elastic: false, childStatus: 'superseded',
      childMetadata: {terminalReason: 'elastic_retry_claimed', handoffSuccessorTaskId: randomUUID()},
      items: [{keyword: '对照', status: 'needs_action', error: {code: 'SEARCH_FILTER_APPLICATION_FAILED'}}]});
    await query(`UPDATE capture_tasks SET error='{}'::jsonb WHERE id=$1`, [other.child.id]);
    const refused = await adminHttp(f, `/orchestrations/${other.parent.id}/retry-items`, {
      requestKey: randomUUID(), expectedRevision: 1, itemIds: [other.items[0].id]});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'retry_source_not_settled');

    // Only node 1 has usage today: one keyword is dispatched, two wait.
    await addUsage(f, 1);
    const retried = await adminHttp(f, `/orchestrations/${parent.id}/retry-items`, {
      requestKey: randomUUID(), expectedRevision: Number((await f.row(parent.id)).orchestration_revision),
      itemIds: items.map(item => item.id)});
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    const retryChildren = await query(`SELECT * FROM capture_tasks WHERE parent_task_id=$1
      AND metadata->>'retryRequestKey' IS NOT NULL`, [parent.id]);
    assert.equal(retryChildren.length, 1, JSON.stringify(retried.body));
    assert.equal(retryChildren[0].assigned_agent_id, f.agents[1].id);
    const waiting = await query(`SELECT * FROM capture_task_items WHERE task_id=$1
      AND metadata->>'retryPending'='true'`, [parent.id]);
    assert.equal(waiting.length, 2);
    assert.ok(waiting.every(row => row.execution_task_id === child.id));

    // The waiting-retry sweep and its locked recheck accept the released source.
    await addUsage(f, 2);
    const swept = await reconcilePendingOrchestrationRetries(1);
    assert.equal(swept.dispatched, 1, JSON.stringify(swept));
    assert.equal((await query(`SELECT * FROM capture_tasks WHERE parent_task_id=$1
      AND metadata->>'retryRequestKey' IS NOT NULL`, [parent.id])).length, 2);
  });

  await t.test('an elastic keyword at its relay budget fails like a technical failure and can be retried', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const {parent, child, items: [item]} = await needsActionBatch(f, {attemptCount: 4});
    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.match(confirmed.body.message, /1 个关键词已达自动接力上限，可在批次里点「重试失败关键词」/u);
    assert.doesNotMatch(confirmed.body.message, /退回任务池/u);
    assert.equal(confirmed.body.itemOutcomes[0].kind, 'retry_exhausted');
    assert.equal(confirmed.body.itemOutcomes[0].failed, 1);
    assert.equal((await itemRow(item.id)).status, 'failed');
    const after = await f.row(child.id);
    assert.match(after.message, /已达自动接力上限/u);
    assert.doesNotMatch(after.message, /退回任务池/u);
    const [event] = await f.events(child.id, 'historical_stop_fence_reconciled');
    assert.match(event.message, /已达自动接力上限/u);
    assert.doesNotMatch(event.message, /退回任务池/u);
    assert.equal((await confirmAudits(f))[0].metadata.itemOutcomes[0].kind, 'retry_exhausted');
    assert.equal(await withTransaction(tx => dispatchNextElasticWorkItem(tx,
      {agent: f.agents[1], capabilities: legacyCapabilities})), null, 'no automatic relay past the budget');
    await addUsage(f, 1);
    const retried = await adminHttp(f, `/orchestrations/${parent.id}/retry-items`, {
      requestKey: randomUUID(), expectedRevision: Number((await f.row(parent.id)).orchestration_revision),
      itemIds: [item.id]});
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.equal((await itemRow(item.id)).status, 'dispatched');
  });

  await t.test('only explicitly selected, command-free batch children are released', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    // A stop the operator just requested: let it finish first.
    const stopping = await needsActionBatch(f);
    await query(`INSERT INTO capture_agent_commands(tenant_id,agent_id,task_id,command_type,payload)
      VALUES($1,$2,$3,'stop','{}'::jsonb)`, [f.tenant.id, f.agents[0].id, stopping.child.id]);
    const busy = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [stopping.child.id]});
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.equal(busy.body.error, 'agent_stop_fence_command_in_flight');
    assert.equal(busy.body.requiresTaskAction[0].skipReason, 'command_in_flight');
    assert.equal((await f.row(stopping.child.id)).status, 'needs_action');
    assert.equal((await itemRow(stopping.items[0].id)).status, 'needs_action');
    assert.equal((await confirmAudits(f)).length, 0, 'nothing confirmed, nothing audited');
    await query(`UPDATE capture_agent_commands SET status='completed' WHERE task_id=$1`, [stopping.child.id]);

    // resume_requested is not releasable; a root needs_action task neither.
    const g = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const resuming = await needsActionBatch(g, {childStatus: 'resume_requested'});
    const root = await g.task(g.agents[0], {status: 'needs_action', error: STOP_ERROR});
    const view = (await g.overview()).get(g.agents[0].id).stop_fence;
    assert.deepEqual(view.operator_confirmable_task_ids, []);
    assert.ok(view.tasks.every(task => task.operator_confirmable === false && task.release_disposition === null));
    const refused = await g.admin(0, 'confirm', {confirmation, expectedTaskIds: [resuming.child.id, root.id]});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'agent_stop_fence_task_action_required');
    assert.deepEqual(refused.body.requiresTaskAction.map(task => task.skipReason),
      ['not_orchestration_child', 'not_orchestration_child']);
    assert.equal((await g.row(resuming.child.id)).status, 'resume_requested');
    assert.equal((await g.row(root.id)).status, 'needs_action');

    // Mixed with a superseded fence: every superseded id is still required.
    const h = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const handedOff = await h.fenced(h.agents[0]);
    const mixed = await needsActionBatch(h);
    const foreign = await needsActionBatch(h, {index: 1});
    const other = await fixture(st, {capabilities: legacyCapabilities});
    const otherTenant = await needsActionBatch(other);
    const missing = await h.admin(0, 'confirm', {confirmation, expectedTaskIds: [mixed.child.id]});
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error, 'agent_stop_fence_changed');
    assert.equal((await h.row(mixed.child.id)).status, 'needs_action');
    const both = await h.admin(0, 'confirm', {confirmation,
      expectedTaskIds: [handedOff.id, mixed.child.id, foreign.child.id, otherTenant.child.id]});
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual([...both.body.taskIds].sort(), [handedOff.id, mixed.child.id].sort());
    assert.deepEqual(both.body.needsActionTaskIds, [mixed.child.id]);
    assert.equal((await h.row(handedOff.id)).error.code, 'HISTORICAL_STOP_FENCE_RECONCILED');
    assert.equal((await h.row(handedOff.id)).status, 'superseded');
    assert.equal((await h.row(mixed.child.id)).status, 'superseded');
    assert.equal((await h.row(foreign.child.id)).status, 'needs_action', 'another node is untouched');
    assert.equal((await other.row(otherTenant.child.id)).status, 'needs_action', 'another tenant is untouched');
    assert.equal(await h.blocker(0), null);
    assert.equal((await h.blocker(1))?.id, foreign.child.id);
  });

  await t.test('a local continuation never takes back keywords an operator returned to the batch', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const {child, items: [item]} = await needsActionBatch(f);
    assert.equal((await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]})).status, 200);
    const localId = `local-recovery-${randomUUID()}`;
    await f.heartbeat(0, {tasks: [{id: localId, status: 'running', taskType: 'unattended_keyword_capture',
      platform: 'xiaohongshu', title: '檐下秋意 · 本机继续', updatedAt: new Date().toISOString(), attemptNumber: 1,
      metadata: {parentRequestId: child.client_task_id, cloudAssigned: true, keywords: ['檐下秋意']}}]});
    const local = (await query('SELECT * FROM capture_tasks WHERE client_task_id=$1', [localId]))[0];
    assert.ok(local, 'the snapshot itself was accepted');
    assert.equal(local.parent_task_id, null, 'not adopted into the batch');
    const unchanged = await itemRow(item.id);
    assert.equal(unchanged.status, 'retryable');
    assert.equal(unchanged.execution_task_id, child.id);
  });

  await t.test('remote resume refuses a fenced batch child and keeps working for root tasks', async st => {
    const f = await fixture(st, {capabilities: legacyCapabilities});
    const {child} = await needsActionBatch(f);
    const refused = await adminHttp(f, `/tasks/${child.id}/resume`, {mode: 'remaining'});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'task_stop_fence_operator_release_required');
    assert.match(refused.body.message, /「执行节点」点「确认旧页面已停止」/u);
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [child.id])).length, 0);
    assert.equal((await f.row(child.id)).status, 'needs_action');
    const root = await f.task(f.agents[0], {status: 'needs_action', error: STOP_ERROR,
      control_task_id: randomUUID()});
    const resumed = await adminHttp(f, `/tasks/${root.id}/resume`, {mode: 'remaining'});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.ok(resumed.body.commandId);
  });

  await t.test('a batch already stopped keeps its canceled keywords; the confirmation only lifts the fence', async st => {
    for (const retained of [false, true]) {
      const f = await fixture(st, {nodes: 2, capabilities: remoteStopNodes});
      const {parent, child, items: [item]} = await needsActionBatch(f);
      const running = retained ? await runningExecution(f, parent) : null;
      const stopped = await adminHttp(f, `/orchestrations/${parent.id}/stop`, {});
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      const parentAfterStop = await f.row(parent.id);
      assert.equal(parentAfterStop.status, retained ? 'waiting_device' : 'canceled');
      assert.equal(parentAfterStop.metadata.operatorStopped, true);
      assert.equal((await f.row(child.id)).status, 'needs_action', 'stopping the batch does not stop the child');
      assert.equal((await f.row(child.id)).error.code, 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED');
      assert.equal((await query(`SELECT id FROM capture_agent_commands WHERE task_id=$1`, [child.id])).length, 0);
      assert.equal((await itemRow(item.id)).status, 'canceled');
      assert.equal((await f.blocker(0))?.id, child.id, 'the node is still held');
      assert.equal((await f.overview()).get(f.agents[0].id).stop_fence.tasks[0].release_disposition, 'parent_stopped');

      const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.match(confirmed.body.message, /1 个任务所在批次已停止，未完成关键词已随批次取消，本次只解除停止保护/u);
      assert.doesNotMatch(confirmed.body.message, /退回任务池/u);
      const [outcome] = confirmed.body.itemOutcomes;
      assert.equal(outcome.kind, 'none');
      assert.equal(outcome.parentStatus, retained ? 'waiting_device' : 'canceled');
      assert.equal(outcome.operatorStopped, true);
      assert.equal((await f.row(child.id)).status, 'superseded');
      assert.match((await f.row(child.id)).message, /批次已停止，未完成关键词已随批次取消/u);
      assert.match((await f.events(child.id, 'historical_stop_fence_reconciled'))[0].message, /已随批次取消/u);
      assert.equal((await confirmAudits(f))[0].metadata.itemOutcomes[0].kind, 'none');
      assert.equal((await itemRow(item.id)).status, 'canceled');
      assert.equal(await f.blocker(0), null, 'the node takes work again');
      if (retained) {
        // The released child is no terminal notice the stop waits on.
        await completeStop(f, 1, running.id);
        assert.equal((await f.row(running.id)).status, 'canceled');
        assert.equal((await f.row(parent.id)).status, 'canceled',
          'the stopped batch settles once the other execution stopped');
      }
    }
  });

  await t.test('a batch stopped after a release settles once its other execution stops', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: remoteStopNodes});
    const {parent, child, items: [item]} = await needsActionBatch(f);
    const running = await runningExecution(f, parent);
    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.itemOutcomes[0].kind, 'returned_to_pool');
    const stopped = await adminHttp(f, `/orchestrations/${parent.id}/stop`, {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal((await f.row(parent.id)).status, 'waiting_device');
    assert.equal((await f.row(child.id)).status, 'superseded');
    assert.equal((await itemRow(item.id)).status, 'canceled', 'the returned keyword stops with the batch');
    await completeStop(f, 1, running.id);
    assert.equal((await f.row(parent.id)).status, 'canceled');
  });

  await t.test('a child adopted by a local recovery follows its elastic parent', async st => {
    const f = await fixture(st, {nodes: 2, capabilities: legacyCapabilities});
    const {parent, child, items: [item]} = await needsActionBatch(f, {childMetadata: {
      orchestrationChild: true, localRecovery: true, itemIds: [], localRecoverySourceExecutionTaskId: randomUUID()}});
    await query(`UPDATE capture_tasks SET metadata=metadata || jsonb_build_object('parentTaskId', $2::text,
      'itemIds', jsonb_build_array($3::text)) WHERE id=$1`, [child.id, parent.id, item.id]);
    const fence = (await f.overview()).get(f.agents[0].id).stop_fence;
    assert.equal(fence.tasks[0].release_disposition, 'return_to_pool', 'from the parent, not the child');
    const confirmed = await f.admin(0, 'confirm', {confirmation, expectedTaskIds: [child.id]});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.itemOutcomes[0].kind, 'returned_to_pool');
    assert.match(confirmed.body.message, /退回任务池/u);
    assert.equal((await itemRow(item.id)).status, 'retryable');
  });
});
