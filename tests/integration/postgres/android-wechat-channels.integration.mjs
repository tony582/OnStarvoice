import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

// One phone, two apps: WeChat Channels keyword work goes only to a phone that reports WeChat ready, the
// phone uploads whole posts, and they land as formal records bound to the attempt. Real, isolated PostgreSQL.
test('WeChat Channels on a shared phone: claim by platform, post upload, receipts and isolation', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {normalizeRecord, syncNormalizedRecord} = await import('../../../server/routes/sync.js');
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const persist = async (body, context) => syncNormalizedRecord(normalizeRecord(body)[0], context);

  async function fixture(st) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [randomUUID()]);
    st.after(async () => {
      for (const table of ['capture_mobile_post_receipts', 'record_comments', 'record_observations']) {
        await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
      }
      await query('DELETE FROM records WHERE tenant_id=$1', [tenantId]);
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
    const complete = (task, extra = {}) => service.complete(principal, {requestId: randomUUID(), identity: task.identity, sessionId,
      status: 'completed', deviceIdle: true, ...extra});
    return {tenantId, service, phone, principal, poll, complete};
  }

  async function elasticParent(tenantId, {platform, eligibleAgentIds, keywords, planSnapshot = {}}) {
    const parentId = randomUUID();
    const metadata = {distributionMode: 'elastic_pool', eligibleAgentIds, claimUnit: 'keyword', executionMode: 'one_time',
      planSnapshot: {platform, keywords, searchFilters: {sort: 'comprehensive', publishTime: 'day', contentType: 'all'},
        keywordMaxDetectedItems: 20, recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true},
        captureSettings: {autoDetailCaptureAfterListCapture: true, includeCommentsOnDetailCapture: true, detailCommentsMaxDetectedItems: 30},
        ...planSnapshot}};
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
      VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','手机弹性',$5,'cloud','manual','running',$3,1,$4::jsonb,'{}'::jsonb)`,
    [parentId, tenantId, metadata, JSON.stringify({total: keywords.length, assigned: 0}), platform]);
    for (const [ordinal, keyword] of keywords.entries()) {
      await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,'keyword','pending',0)`, [randomUUID(), tenantId, parentId, `keyword:${ordinal}`, ordinal, keyword, platform]);
    }
    return parentId;
  }

  const postEvent = (task, overrides = {}) => ({eventKind: 'wechat_post', eventId: randomUUID(), ...task.identity,
    keyword: task.keyword, mode: 'keyword', rank: 1, capturedAt: new Date().toISOString(),
    card: {snippet: '通用品牌内 区别对待？承诺', author: '上海交通广播', timeLabel: '1小时', likeLabel: '423'},
    link: {shareUrl: 'https://weixin.qq.com/sph/ARLmfj5VbT'},
    preview: {description: '通用品牌内 区别对待？承诺更新不履约！#上汽通用 #别克', createtime: Math.floor(Date.now() / 1000) - 3600,
      nickname: `上海交通广播${task.identity.itemId.slice(0, 4)}`, avatarUrl: '', likeCountFmt: '262', favCountFmt: '423',
      forwardCountFmt: '405', commentCountFmt: '207', coverUrl: '', isImage: false, exportId: 'export/abc'},
    comments: {status: 'captured', headerCount: 2, items: [
      {author: '肿么肥四', location: '江苏', timeLabel: '2天前', content: '别克服务至于交付', likeCount: 31, reply: false, parentIndex: null},
      {author: 'A上海通', location: '上海', timeLabel: '1天前', content: '其他车企也一样', likeCount: null, reply: true, parentIndex: 0}]},
    ...overrides});

  await t.test('Channels work goes only to a phone that reports WeChat ready; Douyin work is unchanged', async st => {
    const f = await fixture(st);
    const wechatParent = await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['别克车机升级']});
    assert.equal((await f.poll()).task, null, 'a Runner without a platform list is a Douyin phone');
    assert.equal((await f.poll({platforms: ['douyin']})).task, null);
    const claim = await f.poll({platforms: ['douyin', 'wechat_channels']});
    assert.ok(claim.task);
    assert.equal(claim.task.platform, 'wechat_channels');
    assert.equal(claim.task.mode, 'keyword');
    assert.deepEqual(claim.task.filters, {sort: 'latest', publishWindowHours: 24});
    assert.deepEqual(claim.task.comments, {enabled: true, limit: 30});
    const [child] = await query('SELECT * FROM capture_tasks WHERE id=$1', [claim.task.identity.taskId]);
    assert.equal(child.platform, 'wechat_channels');
    assert.equal(child.metadata.workflow, 'wechat_channels_mobile_capture');
    assert.equal(child.parent_task_id, wechatParent);
    const [phone] = await query('SELECT capabilities, allowed_platforms FROM capture_agents WHERE id=$1', [f.phone.id]);
    assert.deepEqual(phone.capabilities.supportedPlatforms, ['douyin', 'wechat_channels']);
    assert.ok(phone.allowed_platforms.includes('wechat_channels'));
    await f.complete(claim.task);
    await elasticParent(f.tenantId, {platform: 'douyin', eligibleAgentIds: [f.phone.id], keywords: ['别克壁纸'],
      planSnapshot: {searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'}}});
    const douyin = await f.poll({platforms: ['douyin', 'wechat_channels']});
    assert.equal(douyin.task.platform, 'douyin');
    assert.deepEqual(douyin.task.filters, {sort: 'latest', publishTime: 'day', contentType: 'video'});
    assert.equal(douyin.task.comments, undefined);
  });

  await t.test('uploaded posts become records bound to the attempt; replays return the stored receipt', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['别克车机升级']});
    const claim = await f.poll({platforms: ['wechat_channels']});
    const event = postEvent(claim.task);
    const batch = {uploadBatchId: randomUUID(), events: [event]};
    const first = await f.service.posts(f.principal, batch, persist);
    assert.equal(first.receipts.length, 1);
    assert.equal(first.receipts[0].status, 'accepted');
    assert.ok(first.receipts[0].receiptId);
    const [record] = await query('SELECT * FROM records WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(record.platform, 'wechat_channels');
    assert.match(record.external_id, /^wxc_[a-f0-9]{24}$/u);
    assert.equal(record.keyword, '别克车机升级');
    assert.equal(record.url, 'https://weixin.qq.com/sph/ARLmfj5VbT');
    assert.equal(Number(record.likes), 423);
    assert.equal(Number(record.comments_count), 207);
    const observations = await query('SELECT * FROM record_observations WHERE tenant_id=$1 AND record_id=$2', [f.tenantId, record.id]);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].capture_task_item_attempt_id, claim.task.identity.attemptId);
    const replay = await f.service.posts(f.principal, batch, persist);
    assert.equal(replay.receipts[0].receiptId, first.receipts[0].receiptId);
    assert.equal((await f.service.postReceipts(f.principal, batch.uploadBatchId)).receipts.length, 1);
    await assert.rejects(f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [{...event, rank: 9}]}, persist),
      {code: 'EVENT_PAYLOAD_CONFLICT'});
    // The same post found again (another share link, new event) updates the same record.
    await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(claim.task,
      {link: {shareUrl: 'https://weixin.qq.com/sph/AftRlBVgPT'}, preview: {...event.preview, favCountFmt: '500'}})]}, persist);
    const records = await query('SELECT likes FROM records WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(records.length, 1);
    assert.equal(Number(records[0].likes), 500);
    await f.complete(claim.task);
  });

  await t.test('a post arriving after the keyword moved on is stored without the attempt binding; foreign attempts are refused', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['君越车机']});
    const first = await f.poll({platforms: ['wechat_channels']});
    await f.complete(first.task, {status: 'interrupted', reason: 'lease_expired'});
    const second = await f.poll({platforms: ['wechat_channels']});
    assert.notEqual(second.task.identity.attemptId, first.task.identity.attemptId);
    const late = await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(first.task)]}, persist);
    assert.equal(late.receipts[0].status, 'accepted');
    const [observation] = await query('SELECT capture_task_item_attempt_id FROM record_observations WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(observation.capture_task_item_attempt_id, null);
    await assert.rejects(f.service.posts(f.principal, {uploadBatchId: randomUUID(),
      events: [postEvent({...second.task, identity: {...second.task.identity, requestHash: 'f'.repeat(64)}})]}, persist),
    {code: 'ATTEMPT_LINEAGE_MISMATCH'});
    await f.complete(second.task);
  });

  // A negative Channels post from an earlier run, the plan's negative_post item and its rotation scope.
  async function patrolFixture(f, {url = 'https://weixin.qq.com/sph/ARLmfj5VbT'} = {}) {
    const {normalizeUnattendedNegativePatrolScope, loadUnattendedNegativePatrolCandidates} =
      await import('../../../server/services/unattended-negative-patrol.js');
    const {wechatExternalId} = await import('../../../server/services/android-control/posts.js');
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,content,author_name,url,
        keyword,sentiment,business_visibility,publish_time,created_at)
      VALUES($1,$2,'wechat_channels','keyword_notes','差评','承诺更新不履约 #别克','上海交通广播',$3,'别克车机升级','negative','eligible',
        '2026-11-03 10:01:41',now()-interval '1 day') RETURNING *`, [f.tenantId, wechatExternalId(1793671301, '上海交通广播'), url]);
    const scope = normalizeUnattendedNegativePatrolScope({tenantId: f.tenantId, platforms: ['wechat_channels'],
      keywords: ['别克车机升级'], runStartedAt: new Date().toISOString()});
    const candidates = await withTransaction(tx => loadUnattendedNegativePatrolCandidates(tx, {...scope, persistCandidates: true}));
    assert.equal(candidates.candidates.length, 1, JSON.stringify(candidates.summary));
    const parentId = await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: [],
      planSnapshot: {negativePatrol: {enabled: true, lookbackDays: 7}}});
    await query(`UPDATE capture_tasks SET metadata = metadata || jsonb_build_object('negativePatrolRun', $2::jsonb) WHERE id=$1`,
      [parentId, JSON.stringify(scope)]);
    const candidate = candidates.candidates[0];
    await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,record_id,external_id,
        url_snapshot,status,metadata,assignment_revision)
      VALUES($1,$2,$3,$4,0,'','wechat_channels','negative_post',$5,$6,$7,'pending',$8::jsonb,0)`,
    [randomUUID(), f.tenantId, parentId, `negative:wechat_channels:${candidate.externalId}`, candidate.recordId, candidate.externalId,
      candidate.url, JSON.stringify({unattendedNegativePatrol: true, sourceRecord: candidate.sourceRecord, baseline: candidate.baseline})]);
    return {record, parentId};
  }

  await t.test('a Channels negative post is patrolled by the phone; a bound result is a formal patrol success', async st => {
    const f = await fixture(st);
    const {record} = await patrolFixture(f);
    const claim = await f.poll({platforms: ['wechat_channels']});
    assert.equal(claim.task.mode, 'patrol');
    assert.equal(claim.task.keyword, '承诺更新不履约');
    assert.equal(claim.task.patrolTarget.url, 'https://weixin.qq.com/sph/ARLmfj5VbT');
    assert.equal(claim.task.patrolTarget.createtime, 1793671301);
    const [child] = await query('SELECT task_type FROM capture_tasks WHERE id=$1', [claim.task.identity.taskId]);
    assert.equal(child.task_type, 'negative_post_patrol');
    const event = postEvent(claim.task, {mode: 'patrol', rank: null,
      preview: {...postEvent(claim.task).preview, createtime: 1793671301, nickname: '上海交通广播', favCountFmt: '600'},
      comments: {status: 'disabled', headerCount: null, items: []}});
    const uploaded = await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [event]}, persist);
    assert.equal(uploaded.receipts[0].status, 'accepted');
    assert.equal(uploaded.receipts[0].recordId, record.id, 'the patrol result updates the original record');
    await f.complete(claim.task, {reason: 'patrol_preview'});
    const [item] = await query(`SELECT status, result_observation_id FROM capture_task_items WHERE item_type='negative_post' AND tenant_id=$1`, [f.tenantId]);
    assert.equal(item.status, 'completed');
    assert.ok(item.result_observation_id);
    const [state] = await query('SELECT last_success_at, failure_count, needs_action FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenantId]);
    assert.ok(state.last_success_at);
    assert.equal(state.needs_action, false);
    const [updated] = await query('SELECT likes FROM records WHERE id=$1', [record.id]);
    assert.equal(Number(updated.likes), 600);
  });

  await t.test('a patrol that finds nothing only cools the post down; it never marks it deleted', async st => {
    const f = await fixture(st);
    const {record, parentId} = await patrolFixture(f);
    const claim = await f.poll({platforms: ['wechat_channels']});
    await f.complete(claim.task, {reason: 'patrol_not_relocated'});
    const [item] = await query(`SELECT status, metadata FROM capture_task_items WHERE item_type='negative_post' AND tenant_id=$1`, [f.tenantId]);
    assert.equal(item.status, 'completed_with_warnings');
    assert.equal(item.metadata.patrolOutcome, 'patrol_not_relocated');
    const [state] = await query('SELECT failure_count, cooldown_until, needs_action, last_success_at FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(state.failure_count, 1);
    assert.ok(state.cooldown_until);
    assert.equal(state.needs_action, false);
    assert.equal(state.last_success_at, null);
    const [unchanged] = await query('SELECT content_availability_status FROM records WHERE id=$1', [record.id]);
    assert.notEqual(unchanged.content_availability_status, 'deleted');
    await query(`UPDATE unattended_negative_patrol_state SET failure_count=2, cooldown_until=NULL WHERE tenant_id=$1`, [f.tenantId]);
    // The next run of the plan: the same post is due again after its cooldown (the test reopens the run).
    await query(`UPDATE capture_task_items SET status='pending' WHERE item_type='negative_post' AND tenant_id=$1`, [f.tenantId]);
    await query(`UPDATE capture_tasks SET status='running' WHERE id=$1`, [parentId]);
    const again = await f.poll({platforms: ['wechat_channels']});
    assert.ok(again.task, JSON.stringify({again, items: await query(`SELECT status, attempt_count, assignment_revision, metadata->>'skipReason' AS skip,
      execution_task_id FROM capture_task_items WHERE tenant_id=$1`, [f.tenantId]),
    state: await query('SELECT * FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenantId])}));
    await f.complete(again.task, {reason: 'patrol_not_relocated'});
    const [stopped] = await query('SELECT failure_count, needs_action FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(stopped.failure_count, 3);
    assert.equal(stopped.needs_action, true, 'the third miss in a row stops the patrol of this post');
  });

  await t.test('a browser never claims Channels work', async st => {
    const f = await fixture(st);
    const code = randomUUID();
    const [{id: codeId}] = await query("INSERT INTO auth_codes(tenant_id,code,status,expires_at) VALUES($1,$2,'active',now()+interval '1 day') RETURNING id", [f.tenantId, code]);
    const [{id: bindingId}] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id', [codeId, randomUUID()]);
    const capabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, singleRelayV1: true, taskStateKnown: true, supportedPlatforms: []};
    const [browser] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
      VALUES($1,$2,'Browser test','active',ARRAY[]::text[],$3,$4,$5,now(),now(),now()) RETURNING *`, [f.tenantId, randomUUID(), codeId, bindingId, capabilities]);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [browser.id, f.phone.id], keywords: ['别克']});
    const dispatched = await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: browser, capabilities}));
    assert.equal(dispatched, null, 'no browser claim of Channels work');
    assert.equal((await query('SELECT id FROM capture_agent_commands WHERE tenant_id=$1', [f.tenantId])).length, 0);
  });
});
