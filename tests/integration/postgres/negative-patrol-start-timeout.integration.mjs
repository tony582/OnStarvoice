import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// docs/hotfix/20261007-negative-patrol-reconcile-livelock.md: on 2026-10-07
// three Windows nodes acknowledged their patrol create (a heartbeat snapshot
// showed it queued) and then never started it, while they kept heartbeating.
// Nothing released the work item for over six hours. A patrol still pending
// 15 minutes after dispatch now goes back to the queue for another node, and
// the stuck node's acknowledgement of that does not cancel the item.
const KEYWORD = '巡查未开始集成测试';
const CAPABILITIES = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, remoteTargetedPostCaptureV1: true,
  negativePostPatrol: true, negativePatrolTerminalReceiptV1: true,
  watchedContentPatrol: true, remoteStop: true, taskStateKnown: true,
  supportedPlatforms: ['douyin', 'xiaohongshu'],
};

test('a negative patrol that never starts goes back to the queue for another node', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {hashCaptureAgentToken, makeCaptureAgentToken} =
    await import('../../../server/services/capture-cloud.js');
  const {normalizeUnattendedNegativePatrolScope: normalizeScope} =
    await import('../../../server/services/unattended-negative-patrol.js');
  const {dispatchNextElasticWorkItem, reconcileElasticCaptureLeases} =
    await import('../../../server/routes/capture-cloud.js');
  const {createApp} = await import('../../../server/app.js');
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

  async function fixture(st) {
    const runStartedAt = new Date().toISOString();
    const [tenant] = await query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Patrol start timeout ${randomUUID()}`]);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const scope = normalizeScope({tenantId: tenant.id, platforms: ['douyin'],
      keywords: [KEYWORD], runStartedAt, timezone: 'Asia/Shanghai'});
    const [code] = await query(`INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now()+interval '1 day') RETURNING id`, [tenant.id, `PATROL-${randomUUID()}`]);
    const agents = [];
    for (const name of ['月球', '仙人掌']) {
      const [binding] = await query('INSERT INTO auth_bindings (code_id,fingerprint) VALUES ($1,$2) RETURNING id',
        [code.id, randomUUID()]);
      const [agent] = await query(`INSERT INTO capture_agents (
        tenant_id,client_uuid,display_name,browser_name,app_version,allowed_platforms,status,
        auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at
      ) VALUES ($1,$2,$3,'Edge','0.4.22',ARRAY['douyin'],'active',$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), name, code.id, binding.id, JSON.stringify(CAPABILITIES)]);
      const token = makeCaptureAgentToken();
      await query(`INSERT INTO capture_agent_tokens (agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES ($1,$2,$3,$4)`, [agent.id, code.id, binding.id, hashCaptureAgentToken(token)]);
      agents.push({...agent, token});
    }
    const [owner] = await query(`INSERT INTO capture_tasks (
      tenant_id,client_task_id,task_type,feature_key,platform,status,title,metadata,counts
    ) VALUES ($1,$2,'capture_orchestration','keyword_orchestration','douyin','pending','抖音~日常+负面巡检',$3,
      '{"total":0}') RETURNING *`,
    [tenant.id, randomUUID(), JSON.stringify({distributionMode: 'elastic_pool',
      eligibleAgentIds: agents.map(agent => agent.id), negativePatrolRun: {...scope, summary: {}},
      planSnapshot: {platform: 'douyin', keywords: [KEYWORD], keywordMaxDetectedItems: 2,
        maxRounds: 1, negativePatrol: {enabled: true, lookbackDays: 7}}})]);
    async function patrolItem(label, ordinal) {
      const externalId = `start_timeout_${randomUUID().replaceAll('-', '')}`;
      const yesterday = new Date(Date.parse(runStartedAt) - 24 * 60 * 60 * 1000).toISOString();
      const [record] = await query(`INSERT INTO records (
        tenant_id,external_id,platform,title,keyword,sentiment,publish_time,published_ts,
        created_at,business_visibility,manual_overrides,content_availability_status
      ) VALUES ($1,$2,'douyin',$3,$4,'negative',$5::text,$5::text::timestamptz,$5::text::timestamptz,
        'eligible','{}','unknown') RETURNING *`,
      [tenant.id, externalId, label, KEYWORD, yesterday]);
      const [item] = await query(`INSERT INTO capture_task_items (
        tenant_id,task_id,item_key,item_type,keyword,ordinal,platform,record_id,external_id,url_snapshot,status,metadata
      ) VALUES ($1,$2,$3,'negative_post','',$4,'douyin',$5,$6,$7,'pending',$8) RETURNING *`,
      [tenant.id, owner.id, `negative:douyin:${externalId}`, ordinal, record.id, externalId,
        `https://www.douyin.com/video/${externalId}`,
        JSON.stringify({unattendedNegativePatrol: true, sourceRecord: {title: label},
          captureSettings: {skipExistingPosts: false}})]);
      await query('UPDATE capture_tasks SET counts=jsonb_build_object($2::text, $3::int) WHERE id=$1',
        [owner.id, 'total', ordinal + 1]);
      return item;
    }
    async function claim(agent) {
      const [current] = await query('SELECT * FROM capture_agents WHERE id=$1', [agent.id]);
      return withTransaction(tx => dispatchNextElasticWorkItem(tx,
        {agent: current, capabilities: current.capabilities}));
    }
    // What production showed at 05:10: the node's heartbeat snapshot listed
    // the patrol as queued, which completed the create command, and then the
    // runner never started it.
    // (admitted_at is moved back past the global patrol admission spacing so
    // the next claim in the same test is not deferred by it.)
    async function acknowledgeCreateOnly(dispatch) {
      await query(`UPDATE capture_agent_commands
        SET status='completed', result=jsonb_build_object('source','task_snapshot_observed',
          'requestId', $2::text), updated_at=now(), admitted_at=now()-interval '11 seconds'
        WHERE id=$1`, [dispatch.commandId, dispatch.childTaskId]);
    }
    const dispatchedMinutesAgo = (childTaskId, minutes) => query(
      `UPDATE capture_tasks SET created_at=now()-make_interval(mins => $2::integer) WHERE id=$1`,
      [childTaskId, minutes]);
    const reconcile = () => reconcileElasticCaptureLeases({tenantId: tenant.id, parentTaskIds: [owner.id]});
    async function heartbeat(agent, body = {}) {
      const response = await fetch(`${origin}/api/capture-cloud/agent/heartbeat`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${agent.token}`},
        body: JSON.stringify({
          agent: {clientUuid: agent.client_uuid, appVersion: '0.4.22', capabilities: CAPABILITIES},
          tasks: [],
          ...body,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    }
    const row = async id => (await query('SELECT * FROM capture_tasks WHERE id=$1', [id]))[0];
    const itemRow = async id => (await query('SELECT * FROM capture_task_items WHERE id=$1', [id]))[0];
    return {tenant, agents, owner, patrolItem, claim, acknowledgeCreateOnly, dispatchedMinutesAgo,
      reconcile, heartbeat, row, itemRow};
  }

  await t.test('released after 15 minutes, its node is told, and another node takes the post', async st => {
    const f = await fixture(st);
    const [stuck, peer] = f.agents;
    const item = await f.patrolItem('别克君越车机不升级', 0);
    const dispatch = await f.claim(stuck);
    assert.equal(dispatch?.itemId, item.id, JSON.stringify(dispatch));
    await f.acknowledgeCreateOnly(dispatch);
    const queued = await f.row(dispatch.childTaskId);
    assert.equal(queued.status, 'pending');
    assert.equal(queued.started_at, null);

    await f.dispatchedMinutesAgo(dispatch.childTaskId, 14);
    assert.equal((await f.reconcile()).requeued, 0, 'a patrol queued for 14 minutes is left alone');
    assert.equal((await f.row(dispatch.childTaskId)).status, 'pending');
    assert.equal((await f.itemRow(item.id)).status, 'dispatched');

    await f.dispatchedMinutesAgo(dispatch.childTaskId, 16);
    assert.equal((await f.reconcile()).requeued, 1);
    const released = await f.row(dispatch.childTaskId);
    assert.equal(released.status, 'failed');
    assert.equal(released.error.code, 'negative_patrol_start_timeout');
    assert.equal(released.error.serverLeaseRevoked, false);
    assert.equal(released.metadata.terminalDisposition, 'superseded');
    assert.equal(released.metadata.terminalReason, 'negative_patrol_start_timeout');
    assert.equal(released.metadata.attemptIdentity, queued.metadata.attemptIdentity);
    assert.equal((await f.itemRow(item.id)).status, 'retryable');
    const [requeued] = await query(`SELECT payload FROM capture_task_events
      WHERE task_id=$1 AND event_type='elastic_work_item_requeued'`, [dispatch.childTaskId]);
    assert.equal(requeued.payload.timeoutCode, 'negative_patrol_start_timeout');
    assert.equal(requeued.payload.startTimeoutMinutes, 15);

    // The stuck node is still online: its next heartbeat carries the notice,
    // and the one after acknowledges it.
    const noticed = await f.heartbeat(stuck);
    const notice = {
      requestId: queued.control_task_id || queued.client_task_id,
      attemptId: queued.metadata.attemptIdentity,
      status: 'superseded',
    };
    assert.deepEqual(noticed.terminalNotices.map(({requestId, attemptId, status}) =>
      ({requestId, attemptId, status})), [notice]);
    assert.equal(noticed.terminalNotices[0].reason, 'negative_patrol_start_timeout');
    await f.heartbeat(stuck, {terminalNoticeAcks: [notice]});
    assert.equal((await f.row(dispatch.childTaskId)).status, 'superseded');
    assert.equal((await f.itemRow(item.id)).status, 'retryable',
      'the acknowledgement must not cancel the post before another node takes it');

    const relay = await f.claim(peer);
    assert.equal(relay?.itemId, item.id, JSON.stringify(relay));
    assert.notEqual(relay.childTaskId, dispatch.childTaskId);
    const relayed = await f.itemRow(item.id);
    assert.equal(relayed.status, 'dispatched');
    assert.equal(relayed.assigned_agent_id, peer.id);
    assert.equal(relayed.execution_task_id, relay.childTaskId);
    assert.equal((await f.row(dispatch.childTaskId)).status, 'superseded');
  });

  await t.test('a patrol that started, or whose create is still unacknowledged, is not touched', async st => {
    const f = await fixture(st);
    const [started, unacknowledged] = f.agents;
    const first = await f.patrolItem('已经开始的巡查', 0);
    const second = await f.patrolItem('创建指令未确认的巡查', 1);
    const running = await f.claim(started);
    assert.equal(running?.itemId, first.id, JSON.stringify(running));
    await f.acknowledgeCreateOnly(running);
    await query(`UPDATE capture_tasks SET status='running', started_at=now()-interval '20 minutes',
      heartbeat_at=now() WHERE id=$1`, [running.childTaskId]);
    await f.dispatchedMinutesAgo(running.childTaskId, 30);
    const waiting = await f.claim(unacknowledged);
    await query(`UPDATE capture_agent_commands SET admitted_at=now()-interval '11 seconds' WHERE id=$1`,
      [waiting.commandId]);
    assert.equal(waiting?.itemId, second.id, JSON.stringify(waiting));
    await f.dispatchedMinutesAgo(waiting.childTaskId, 30);
    // Pushed out so the create-ack expiry inside the heartbeat cannot act; the
    // rule under test is only for creates that were acknowledged.
    await query(`UPDATE capture_agent_commands SET expires_at=now()+interval '1 hour' WHERE id=$1`,
      [waiting.commandId]);

    assert.equal((await f.reconcile()).requeued, 0);
    assert.equal((await f.row(running.childTaskId)).status, 'running');
    assert.equal((await f.row(waiting.childTaskId)).status, 'pending');
    assert.equal((await f.itemRow(first.id)).status, 'dispatched');
    assert.equal((await f.itemRow(second.id)).status, 'dispatched');
  });
});
