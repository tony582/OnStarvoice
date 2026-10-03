import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlRouter} from '../../../server/routes/android-control.js';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

// The phone's card prefilter over real HTTP, real agent tokens and real
// PostgreSQL. The prefilter is injected through the service factory, so no model
// is ever called; the fake can hold its answer open to prove that the attempt
// transaction has committed (no agent slot or row lock) while the model works.
test('phone card prefilter follows the plan switch, fences attempts and holds no lock across the model call', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  // Loading the capture-cloud routes registers the orchestration parent projector.
  await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const both = {autoDetailCaptureAfterListCapture: true, enableAiRelevancePrefilter: true};
  const card = n => ({cardId: n.toString(16).padStart(64, '0'), title: `别克远控 第${n}条`, author: `作者${n}`});

  async function fixture(st, {realPrefilter = false} = {}) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`android-prefilter-${randomUUID()}`]);
    const code = randomUUID();
    await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenantId, code]);
    const calls = [];
    let gate = null;
    const prefilter = async args => {
      calls.push(args);
      if (gate) {gate.entered(); await gate.released;}
      return {ok: true, degraded: false, items: args.body.items.map((item, index) => ({itemId: item.itemId, status: 'ok',
        modelDecision: index === 0 ? 'keep' : 'skip', tenantRelevance: index === 0 ? 'relevant' : 'irrelevant',
        confidence: 0.99, protectedSignal: false, executionDisposition: index === 0 ? 'collect_full' : 'skip_full_capture',
        reason: '测试判定', queryMatch: 0, brandMatch: 0}))};
    };
    const hold = () => {
      let entered, release;
      const state = {entered: new Promise(resolve => {entered = resolve;}), release: () => release()};
      gate = {entered, released: new Promise(resolve => {release = resolve;})};
      return state;
    };
    const enabledTenants = () => new Set([tenantId]);
    const service = createAndroidControlService({enabledTenants, ...(realPrefilter ? {} : {prefilter})});
    async function phone() {
      const registration = {code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
      const registered = await service.register(registration);
      const [agent] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
      const principal = {tenantId, agentId: agent.id, authCodeId: agent.auth_code_id, authBindingId: agent.auth_binding_id};
      const sessionId = randomUUID();
      return {agent, principal, sessionId, token: registered.agent.token,
        poll: () => service.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true}),
        complete: (task, extra = {}) => service.complete(principal, {requestId: randomUUID(), identity: task.identity, sessionId,
          status: 'completed', deviceIdle: true, ...extra})};
    }
    const require = createRequire(new URL('../../../server/package.json', import.meta.url));
    const express = require('express'), app = express();
    app.use(express.json());
    app.use('/api/capture-cloud/android', createAndroidControlRouter({service, enabledTenants}));
    app.use((error, _req, res, _next) => res.status(500).json({ok: false, error: error.code || 'test_server_error'}));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    st.after(async () => {
      await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
      await query('DELETE FROM capture_task_item_attempts WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_task_items WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_agent_commands WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM capture_tasks WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM relevance_prefilter_decisions WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM relevance_prefilter_requests WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM tenant_settings WHERE tenant_id=$1', [tenantId]);
      await query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    });
    const send = async (token, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/capture-cloud/android/agent/prefilter`, {
        method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
      return {status: response.status, body: await response.json()};
    };
    return {tenantId, service, calls, hold, phone, send};
  }

  async function elasticParent(tenantId, {eligibleAgentIds, keywords, captureSettings}) {
    const parentId = randomUUID();
    const metadata = {distributionMode: 'elastic_pool', eligibleAgentIds, claimUnit: 'keyword', executionMode: 'one_time',
      planSnapshot: {platform: 'douyin', keywords, searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'all'},
        mobileKeywordMaxMinutes: 12, recoveryPolicy: {}, ...(captureSettings ? {captureSettings} : {})}};
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
      VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','手机预筛','douyin','cloud','manual','running',$3,1,$4::jsonb,'{}'::jsonb)`,
    [parentId, tenantId, metadata, JSON.stringify({total: keywords.length, assigned: 0})]);
    for (const [ordinal, keyword] of keywords.entries()) {
      await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,'douyin','keyword','pending',0)`, [randomUUID(), tenantId, parentId, `keyword:${ordinal}`, ordinal, keyword]);
    }
    return parentId;
  }

  await t.test('poll payload carries relevancePrefilter.enabled from the child plan snapshot', async st => {
    const f = await fixture(st);
    const a = await f.phone(), b = await f.phone();
    await elasticParent(f.tenantId, {eligibleAgentIds: [a.agent.id], keywords: ['别克远控'], captureSettings: both});
    const claimed = await a.poll();
    assert.deepEqual(claimed.task.relevancePrefilter, {enabled: true});
    const [child] = await query('SELECT metadata FROM capture_tasks WHERE id=$1', [claimed.task.identity.taskId]);
    assert.deepEqual(child.metadata.planSnapshot.captureSettings, both, 'the switch lives on the child task');
    assert.deepEqual((await a.poll()).task.relevancePrefilter, {enabled: true}, 'a held re-poll reports the same switch');

    await elasticParent(f.tenantId, {eligibleAgentIds: [b.agent.id], keywords: ['别克哨兵'],
      captureSettings: {...both, enableAiRelevancePrefilter: false}});
    assert.deepEqual((await b.poll()).task.relevancePrefilter, {enabled: false});
  });

  await t.test('a standalone run without a plan snapshot reports the switch off', async st => {
    const f = await fixture(st);
    const a = await f.phone();
    await f.service.create(f.tenantId, {requestId: randomUUID(), agentId: a.agent.id, keywords: ['别克壁纸']});
    const claimed = await a.poll();
    assert.deepEqual(claimed.task.relevancePrefilter, {enabled: false});
    const answer = await f.send(a.token, {identity: claimed.task.identity, requestId: randomUUID(), cards: [card(1)]});
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {ok: true, enabled: false, degraded: false, items: []});
    assert.equal(f.calls.length, 0, 'switch off never reaches the model');
  });

  await t.test('the route refuses another agent (403) and an attempt that is no longer current (409)', async st => {
    const f = await fixture(st);
    const a = await f.phone(), b = await f.phone();
    await elasticParent(f.tenantId, {eligibleAgentIds: [a.agent.id], keywords: ['别克远控'], captureSettings: both});
    const claimed = await a.poll();
    const body = {identity: claimed.task.identity, requestId: randomUUID(), cards: [card(1), card(2)]};
    const foreign = await f.send(b.token, body);
    assert.equal(foreign.status, 403);
    assert.deepEqual(foreign.body, {ok: false, error: 'AGENT_ID_MISMATCH', failOpen: true});
    const forged = await f.send(b.token, {...body, identity: {...body.identity, agentId: b.agent.id}});
    assert.equal(forged.status, 403);
    assert.deepEqual(forged.body, {ok: false, error: 'ATTEMPT_LINEAGE_MISMATCH', failOpen: true});

    // A finished attempt no longer holds the device.
    await a.complete(claimed.task);
    const released = await f.send(a.token, {...body, requestId: randomUUID()});
    assert.equal(released.status, 409);
    assert.deepEqual(released.body, {ok: false, error: 'STALE_ATTEMPT', failOpen: true});

    // A superseded attempt of the same run is not current any more.
    await f.service.create(f.tenantId, {requestId: randomUUID(), agentId: b.agent.id, keywords: ['别克壁纸']});
    const first = await b.poll();
    await b.complete(first.task, {status: 'interrupted'});
    const [{task_id: runId}] = await query('SELECT task_id FROM capture_task_items WHERE id=$1', [first.task.identity.itemId]);
    await f.service.resume(f.tenantId, runId);
    const second = await b.poll();
    assert.equal(second.task.identity.itemId, first.task.identity.itemId);
    assert.notEqual(second.task.identity.attemptId, first.task.identity.attemptId);
    const stale = await f.send(b.token, {identity: first.task.identity, requestId: randomUUID(), cards: [card(3)]});
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, {ok: false, error: 'STALE_ATTEMPT', failOpen: true});
    assert.equal(f.calls.length, 0, 'no refused call reaches the model');
  });

  await t.test('a valid call reaches the prefilter with the item keyword and holds no lock while it waits', async st => {
    const f = await fixture(st);
    const a = await f.phone();
    await elasticParent(f.tenantId, {eligibleAgentIds: [a.agent.id], keywords: ['别克远控'], captureSettings: both});
    const claimed = await a.poll();
    const {identity} = claimed.task;
    const requestId = randomUUID(), cards = [card(1), card(2), card(3)];
    const gate = f.hold();
    const pending = f.send(a.token, {identity, requestId, cards, keyword: '伪造关键词'});
    await gate.entered;
    try {
      // The model is "working": the agent slot and the item/attempt rows must be free.
      const renewed = await f.service.renew(a.principal, {identity, sessionId: a.sessionId, leaseId: claimed.permit.leaseId});
      assert.ok(renewed.permit, 'renew is not blocked behind the prefilter');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='500ms'");
        await client.query('SELECT id FROM capture_task_items WHERE id=$1 FOR UPDATE NOWAIT', [identity.itemId]);
        await client.query('SELECT id FROM capture_task_item_attempts WHERE id=$1 FOR UPDATE NOWAIT', [identity.attemptId]);
        await client.query('COMMIT');
      } finally {client.release();}
      assert.ok((await a.poll()).task, 'the held poll is not blocked either');
    } finally {gate.release();}
    const answer = await pending;
    assert.equal(answer.status, 200);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.enabled, true);
    assert.equal(answer.body.degraded, false);
    assert.deepEqual(answer.body.items.map(item => [item.cardId, item.executionDisposition]),
      [[cards[0].cardId, 'collect_full'], [cards[1].cardId, 'skip_full_capture'], [cards[2].cardId, 'skip_full_capture']]);
    assert.equal(f.calls.length, 1);
    const [{tenantId, body}] = f.calls;
    assert.equal(tenantId, f.tenantId);
    assert.equal(body.keyword, '别克远控', 'the keyword is the item keyword, not the phone-sent one');
    assert.equal(body.idempotencyKey, `android:${identity.attemptId}:${requestId}`);
    assert.equal(body.taskId, identity.taskId);
    assert.equal(body.runId, identity.discoveryRunId);
    assert.equal(body.keywordRunId, identity.itemId);
    assert.equal(body.mode, 'conservative');
    assert.deepEqual(body.items.map(item => [item.itemId, item.externalId]), cards.map(c => [c.cardId, '']));
  });

  // The real relevance prefilter, kept away from any model by the tenant's own
  // switch (the safest of server, tenant and request mode wins): the phone's
  // request shape must pass its validation, idempotency and decision write.
  await t.test('the real prefilter accepts the phone request, records the decisions and answers every card unjudged when off', async st => {
    const f = await fixture(st, {realPrefilter: true});
    await query(`INSERT INTO tenant_settings(tenant_id,key,value,updated_at) VALUES($1,'relevance_prefilter_mode','disabled',now())`, [f.tenantId]);
    const a = await f.phone();
    await elasticParent(f.tenantId, {eligibleAgentIds: [a.agent.id], keywords: ['别克远控'], captureSettings: both});
    const claimed = await a.poll();
    const {identity} = claimed.task;
    const requestId = randomUUID(), cards = [card(1), {...card(2), title: `${'长'.repeat(499)}😀尾巴`}];
    const body = {identity, requestId, cards};
    const answer = await f.send(a.token, body);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.enabled, true);
    assert.equal(answer.body.degraded, true);
    assert.deepEqual(answer.body.items.map(item => [item.cardId, item.status, item.executionDisposition]),
      cards.map(c => [c.cardId, 'model_error', 'collect_full']), 'nothing is skipped when the model is off');
    const rows = await query(`SELECT item_id, external_id, task_id, run_id, keyword_run_id, keyword, stage, platform
      FROM relevance_prefilter_decisions WHERE tenant_id=$1 ORDER BY item_title_excerpt`, [f.tenantId]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual([row.external_id, row.task_id, row.run_id, row.keyword_run_id, row.keyword, row.stage, row.platform],
        ['', identity.taskId, identity.discoveryRunId, identity.itemId, '别克远控', 'list', 'douyin']);
    }
    assert.deepEqual(rows.map(row => row.item_id).sort(), cards.map(c => c.cardId).sort());
    // The same request again is the stored answer, not a second decision.
    const replay = await f.send(a.token, body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.items, answer.body.items);
    assert.equal((await query('SELECT count(*)::int AS n FROM relevance_prefilter_decisions WHERE tenant_id=$1', [f.tenantId]))[0].n, 2);
  });
});
