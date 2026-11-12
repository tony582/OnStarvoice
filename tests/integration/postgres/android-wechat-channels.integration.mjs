import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
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

  for (const scenario of [
    {name: 'Channels capture', platform: 'wechat_channels', workflow: 'wechat_channels_mobile_capture', type: 'capture'},
    {name: 'article capture', platform: 'wechat_articles', workflow: 'wechat_articles_mobile_capture', type: 'capture'},
    {name: 'forward', platform: 'wechat_channels', workflow: 'wechat_channels_mobile_capture', type: 'wechat_forward'},
  ]) {
    await t.test(`${scenario.name} run details use the claimed child and current attempt; another tenant gets 404`, async st => {
      const f = await fixture(st), other = await fixture(st);
      const keyword = scenario.type === 'wechat_forward' ? '文件传输助手' : '安吉星 续费';
      let parentId;
      if (scenario.type === 'wechat_forward') {
        const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
          VALUES($1,'wxc_run_detail','wechat_channels','keyword_notes','转发详情回归','https://weixin.qq.com/sph/AsvBQklNxh') RETURNING id`, [f.tenantId]);
        await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients',$2)`, [f.tenantId, keyword]);
        const queued = await f.service.forward(f.tenantId, {recordId: record.id, recipients: [keyword]});
        parentId = queued.forwards[0].id;
      } else {
        parentId = await elasticParent(f.tenantId, {platform: scenario.platform, eligibleAgentIds: [f.phone.id], keywords: [keyword]});
      }
      const {task} = await f.poll({platforms: [scenario.platform], features: ['wechat_articles', 'wechat_forward']});
      assert.ok(task, 'use the real scheduler claim, not hand-written workflow metadata');
      const runId = task.identity.taskId;
      const [child] = await query('SELECT * FROM capture_tasks WHERE tenant_id=$1 AND id=$2', [f.tenantId, runId]);
      assert.equal(child.metadata.workflow, scenario.workflow);
      assert.equal(child.task_type, scenario.type);
      assert.equal(child.parent_task_id, parentId);
      assert.equal(task.identity.discoveryRunId, runId);
      assert.notEqual(runId, parentId, 'details identify the execution child, not its orchestration parent');

      const detail = await f.service.detail(f.tenantId, runId);
      assert.equal(detail.run.id, runId);
      assert.equal(detail.run.agentId, task.identity.agentId);
      assert.equal(detail.run.deviceId, task.deviceId);
      assert.equal(detail.run.status, 'running');
      assert.deepEqual(detail.run.keywords, [keyword]);
      assert.equal(detail.run.deadlineAt, task.deadlineAt);
      assert.deepEqual(detail.run.progress, {total: 1, completed: 0, needsAction: 0});
      assert.deepEqual(detail.run.candidateCounts, {total: 0, stored: 0, needsAction: 0});
      assert.deepEqual(detail.items, [{id: task.identity.itemId, keyword, status: 'running', attemptCount: 1,
        assignmentRevision: task.identity.assignmentRevision, reason: '', stats: null}]);
      assert.equal(detail.recovery.state, 'working');
      assert.equal(detail.recovery.deviceHeld, true);
      assert.equal(detail.recovery.canResume, false);
      // WeChat uploads whole posts; the Douyin discovery tables are legitimately empty.
      assert.deepEqual(detail.candidates, []);
      assert.deepEqual(detail.events, []);
      assert.deepEqual((await f.service.runs(f.tenantId)).runs.map(run => run.id), [runId]);
      assert.deepEqual((await other.service.runs(other.tenantId)).runs, []);
      await assert.rejects(f.service.detail(f.tenantId, parentId), {code: 'MOBILE_RUN_NOT_FOUND', status: 404});
      await assert.rejects(other.service.detail(other.tenantId, runId), {code: 'MOBILE_RUN_NOT_FOUND', status: 404});

      const stats = {links: 1, cards: 2, keywordElapsedMs: 1200};
      const reason = scenario.type === 'wechat_forward' ? 'forward_sent' : 'link_limit';
      await f.complete(task, {reason, checkpoint: {stats}});
      const completed = await f.service.detail(f.tenantId, runId);
      assert.equal(completed.run.status, 'completed');
      assert.deepEqual(completed.run.progress, {total: 1, completed: 1, needsAction: 0});
      assert.deepEqual(completed.items, [{id: task.identity.itemId, keyword, status: 'completed', attemptCount: 1,
        assignmentRevision: task.identity.assignmentRevision, reason, stats}]);
      assert.equal(completed.recovery.deviceHeld, false);
      assert.equal(completed.recovery.canResume, false);
    });
  }

  await t.test('run details and lists still reject unknown or missing mobile workflows', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['安吉星']});
    const {task} = await f.poll({platforms: ['wechat_channels']});
    await f.complete(task);
    // wechat_forward is a task type, not a supported workflow. Do not permit arbitrary wechat_* values.
    for (const workflow of ['wechat_forward', 'wechat_unknown_mobile_capture', null]) {
      await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{workflow}',$2::jsonb) WHERE id=$1`,
        [task.identity.taskId, JSON.stringify(workflow)]);
      await assert.rejects(f.service.detail(f.tenantId, task.identity.taskId), {code: 'MOBILE_RUN_NOT_FOUND', status: 404});
      assert.deepEqual((await f.service.runs(f.tenantId)).runs, []);
    }
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

  await t.test('a keyword with the App\'s 时长 / 范围 goes only to a Runner that names the feature, and carries both', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['安吉星'],
      planSnapshot: {searchFilters: {sort: 'likes', publishTime: 'all', contentType: 'all', videoDuration: 'under_5m', searchScope: 'viewed'}}});
    assert.equal((await f.poll({platforms: ['wechat_channels']})).task, null, 'an older Runner would search without them');
    const [older] = await query('SELECT capabilities FROM capture_agents WHERE id=$1', [f.phone.id]);
    assert.deepEqual(older.capabilities.runnerFeatures, []);
    const claim = await f.poll({platforms: ['wechat_channels'], features: ['wechat_search_filters']});
    assert.deepEqual(claim.task.filters, {sort: 'hot', publishWindowHours: null, duration: 'under_5m', scope: 'viewed'});
    const [phone] = await query('SELECT capabilities FROM capture_agents WHERE id=$1', [f.phone.id]);
    assert.deepEqual(phone.capabilities.runnerFeatures, ['wechat_search_filters']);
    await f.complete(claim.task);
    // A plan without them is unchanged for every Runner.
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['别克']});
    const plain = await f.poll({platforms: ['wechat_channels']});
    assert.deepEqual(plain.task.filters, {sort: 'latest', publishWindowHours: 24});
    await f.complete(plain.task);
  });

  await t.test('发到微信: only configured contacts, one queued forward per post and contact, claimed first by a Runner that can forward, never retried', async st => {
    const f = await fixture(st);
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,content,author_name,url,keyword,publish_time)
      VALUES($1,'wxc_forward_test','wechat_channels','keyword_notes','忍无可忍','忍无可忍，无须再忍！','萧枫-东莞新起点凯迪专修',
        'https://weixin.qq.com/sph/AsvBQklNxh','凯迪拉克车机升级','2026-11-05 12:00:01') RETURNING id`, [f.tenantId]);
    await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: ['金明Tony']}), {code: 'FORWARD_RECIPIENTS_NOT_CONFIGURED'});
    await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients',$2)`, [f.tenantId, '金明Tony\n文件传输助手']);
    st.after(() => query('DELETE FROM tenant_settings WHERE tenant_id=$1', [f.tenantId]));
    await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: ['别人']}), {code: 'FORWARD_RECIPIENT_NOT_ALLOWED'});
    await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: []}), {code: 'INVALID_FORWARD_RECIPIENT'});
    // A keyword already waiting does not hold the forwards back.
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['安吉星']});
    const {forwards} = await f.service.forward(f.tenantId, {recordId: record.id, recipients: ['金明Tony', '文件传输助手', '金明Tony'], userName: '测试员'});
    assert.deepEqual(forwards.map(item => [item.recipient, item.status]), [['金明Tony', 'pending'], ['文件传输助手', 'pending']]);
    const again = await f.service.forward(f.tenantId, {recordId: record.id, recipients: ['金明Tony']});
    assert.equal(again.forwards[0].id, forwards[0].id, 'the same post to the same contact is not queued twice');
    const listedNow = await f.service.forwards(f.tenantId, record.id);
    assert.deepEqual(listedNow.recipients, ['金明Tony', '文件传输助手']);
    const older = await f.poll({platforms: ['wechat_channels'], features: ['wechat_search_filters']});
    assert.equal(older.task.mode, 'keyword', 'a Runner that cannot forward takes the keyword instead');
    await f.complete(older.task);
    const claim = await f.poll({platforms: ['wechat_channels'], features: ['wechat_search_filters', 'wechat_forward']});
    assert.equal(claim.task.mode, 'forward');
    assert.equal(claim.task.keyword, '金明Tony');
    assert.deepEqual(claim.task.forwardTarget, {recordId: record.id, url: 'https://weixin.qq.com/sph/AsvBQklNxh', recipient: '金明Tony',
      title: '忍无可忍', author: '萧枫-东莞新起点凯迪专修', createtime: 1793851201});
    assert.deepEqual(claim.task.comments, {enabled: false, limit: 0});
    const [child] = await query('SELECT task_type FROM capture_tasks WHERE id=$1', [claim.task.identity.taskId]);
    assert.equal(child.task_type, 'wechat_forward');
    await f.complete(claim.task, {reason: 'forward_sent'});
    // The next contact fails: it stays failed, no second claim.
    const second = await f.poll({platforms: ['wechat_channels'], features: ['wechat_forward']});
    assert.equal(second.task.keyword, '文件传输助手');
    await f.complete(second.task, {status: 'needs_action', reason: 'forward_recipient_not_found'});
    const listed = (await f.service.forwards(f.tenantId, record.id)).forwards;
    assert.deepEqual(listed.map(item => [item.recipient, item.status, item.reason, item.errorCode]).sort(),
      [['文件传输助手', 'failed', 'forward_recipient_not_found', 'WECHAT_FORWARD_FAILED'], ['金明Tony', 'completed', 'forward_sent', '']]);
    assert.equal(listed[0].requestedBy, '测试员');
    assert.equal((await f.poll({platforms: ['wechat_channels'], features: ['wechat_forward']})).task, null);
    const [douyin] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
      VALUES($1,'dy1','douyin','keyword_notes','t','https://www.douyin.com/video/1') RETURNING id`, [f.tenantId]);
    await assert.rejects(f.service.forward(f.tenantId, {recordId: douyin.id, recipients: ['金明Tony']}), {code: 'RECORD_NOT_WECHAT_CHANNELS'});
  });

  await t.test('multi-contact forwards are atomic, tenant-scoped and de-duplicated under concurrent reversed selections', async st => {
    const f = await fixture(st);
    const other = await fixture(st);
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
      VALUES($1,'wxc_multi_forward','wechat_channels','keyword_notes','批量转发','https://weixin.qq.com/sph/AsvBQklNxh') RETURNING id`, [f.tenantId]);
    const recipients = Array.from({length: 20}, (_, i) => `接收人${String(i).padStart(2, '0')}`);
    await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients',$2),($3,'wechat_forward_recipients','其他租户联系人')`,
      [f.tenantId, recipients.join('\n'), other.tenantId]);
    await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: [recipients[0], '其他租户联系人']}),
      {code: 'FORWARD_RECIPIENT_NOT_ALLOWED'});
    await assert.rejects(f.service.forward(other.tenantId, {recordId: record.id, recipients: ['其他租户联系人']}), {code: 'RECORD_NOT_FOUND'});
    for (const invalid of [null, recipients[0], {}, [recipients[0], 123]]) {
      await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: invalid, recipient: recipients[0]}),
        {code: 'INVALID_FORWARD_RECIPIENT'});
    }
    assert.equal((await query('SELECT id FROM capture_task_items WHERE tenant_id=$1', [f.tenantId])).length, 0,
      'a rejected multi-contact request does not leave the allowed contacts queued');
    const [first, second] = await Promise.all([
      f.service.forward(f.tenantId, {recordId: record.id, recipients}),
      f.service.forward(f.tenantId, {recordId: record.id, recipients: [...recipients].reverse()}),
    ]);
    const byRecipient = result => Object.fromEntries(result.forwards.map(item => [item.recipient, item.id]));
    assert.deepEqual(byRecipient(first), byRecipient(second), 'opposite order concurrent requests share the same pending tasks');
    assert.equal((await query('SELECT id FROM capture_task_items WHERE tenant_id=$1', [f.tenantId])).length, 20);
    assert.deepEqual((await f.service.forwards(f.tenantId, record.id)).recipients, recipients);
    assert.deepEqual(await other.service.forwards(other.tenantId, record.id), {forwards: [], recipients: ['其他租户联系人']});

    // Completed history must not crowd out any of the 20 current contacts in the detail panel.
    await query(`UPDATE capture_task_items SET status='completed',finished_at=now() WHERE tenant_id=$1`, [f.tenantId]);
    await query(`UPDATE capture_tasks SET status='completed',finished_at=now() WHERE tenant_id=$1`, [f.tenantId]);
    const newest = await f.service.forward(f.tenantId, {recordId: record.id, recipients});
    const listed = await f.service.forwards(f.tenantId, record.id);
    assert.equal(listed.forwards.length, 20);
    assert.deepEqual(byRecipient(listed), byRecipient(newest));
    assert.ok(listed.forwards.every(item => item.status === 'pending'));
    // The previous single-recipient request field remains valid for already-open admin pages.
    const legacy = await f.service.forward(f.tenantId, {recordId: record.id, recipient: recipients[0]});
    assert.equal(legacy.forwards[0].id, byRecipient(newest)[recipients[0]]);
  });

  await t.test('HTTP settings validate contacts and new tenants never inherit another customer’s recipients', async st => {
    const f = await fixture(st);
    const {default: adminRouter} = await import('../../../server/routes/admin.js');
    const {createAndroidControlRouter} = await import('../../../server/routes/android-control.js');
    const {hashSessionToken} = await import('../../../server/services/auth-service.js');
    const {getDefaultTenantId} = await import('../../../server/db/init.js');
    const require = createRequire(new URL('../../../server/package.json', import.meta.url));
    const express = require('express'), app = express();
    const token = randomUUID();
    const [{id: userId}] = await query(`INSERT INTO users(email,name,password_hash,is_internal,global_role,must_change_password)
      VALUES($1,'Forward integration','not-a-login-password',true,'platform_admin',false) RETURNING id`, [`${randomUUID()}@example.invalid`]);
    st.after(() => query('DELETE FROM users WHERE id=$1', [userId]));
    await query(`INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [userId, hashSessionToken(token)]);
    app.use(express.json());
    app.use('/admin', adminRouter);
    app.use('/android', createAndroidControlRouter({enabledTenants: () => new Set([f.tenantId])}));
    app.use((error, _req, res, _next) => res.status(500).json({ok: false, error: error.code || 'test_server_error'}));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    st.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const request = async (path, {method = 'GET', body, tenantId = f.tenantId} = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {method,
        headers: {authorization: `Bearer ${token}`, 'x-tenant-id': tenantId, 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body)});
      return {status: response.status, payload: await response.json()};
    };
    assert.equal((await request('/admin/settings', {method: 'PUT', body: {wechat_forward_recipients: ' 金明Tony\r\n文件传输助手\n金明Tony'}})).status, 200);
    assert.equal((await query(`SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [f.tenantId]))[0].value,
      '金明Tony\n文件传输助手');
    for (const invalid of ['安全联系人\n坏"人', Array.from({length: 21}, (_, i) => `接收人${i}`).join('\n'), ['金明Tony']]) {
      assert.equal((await request('/admin/settings', {method: 'PUT', body: {wechat_forward_recipients: invalid}})).status, 400);
    }
    assert.equal((await query(`SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [f.tenantId]))[0].value,
      '金明Tony\n文件传输助手', 'an invalid settings save leaves the previous contact list intact');
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
      VALUES($1,'wxc_http_forward','wechat_channels','keyword_notes','HTTP 转发','https://weixin.qq.com/sph/AsvBQklNxh') RETURNING id`, [f.tenantId]);
    const queued = await request('/android/wechat-forwards', {method: 'POST', body: {recordId: record.id, recipients: ['金明Tony', '文件传输助手']}});
    assert.equal(queued.status, 200);
    assert.deepEqual(queued.payload.forwards.map(item => item.recipient), ['金明Tony', '文件传输助手']);
    const listed = await request(`/android/wechat-forwards?recordId=${record.id}`);
    assert.deepEqual(listed.payload.recipients, ['金明Tony', '文件传输助手']);
    assert.equal(listed.payload.forwards.length, 2);

    const defaultTenantId = await getDefaultTenantId();
    const [original] = await query(`SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [defaultTenantId]);
    st.after(async () => {
      if (original) await query(`UPDATE tenant_settings SET value=$2 WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [defaultTenantId, original.value]);
      else await query(`DELETE FROM tenant_settings WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [defaultTenantId]);
    });
    assert.equal((await request('/admin/settings', {method: 'PUT', tenantId: defaultTenantId,
      body: {wechat_forward_recipients: '默认客户联系人'}})).status, 200);
    const created = await request('/admin/tenants', {method: 'POST', body: {name: `forward-copy-${randomUUID()}`}});
    assert.equal(created.status, 200);
    st.after(() => query('DELETE FROM tenants WHERE id=$1', [created.payload.tenant.id]));
    assert.deepEqual(await query(`SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='wechat_forward_recipients'`, [created.payload.tenant.id]), []);

    // Tenant viewers can see configured choices and progress, but cannot send or edit the list.
    await query(`UPDATE users SET global_role='',is_internal=false WHERE id=$1`, [userId]);
    await query(`INSERT INTO user_memberships(user_id,tenant_id,role) VALUES($1,$2,'tenant_viewer')`, [userId, f.tenantId]);
    assert.equal((await request(`/android/wechat-forwards?recordId=${record.id}`)).status, 200);
    assert.equal((await request('/android/wechat-forwards', {method: 'POST', body: {recordId: record.id, recipients: ['金明Tony']}})).status, 403);
    assert.equal((await request('/admin/settings', {method: 'PUT', body: {wechat_forward_recipients: '别人'}})).status, 403);
  });

  await t.test('emoji, complete prefixes and replies keep separate stable ids through stored comment rows', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['安吉星']});
    const {task} = await f.poll({platforms: ['wechat_channels']});
    const reading = (author, content, parentIndex = null) => ({author, content, parentIndex,
      reply: parentIndex !== null, timeLabel: '1天前', location: '上海', likeCount: 0});
    const items = [reading('楼主甲A', '第一层内容不一样'), reading('同一个读者', '确实', 0),
      reading('楼主乙A', '第二层内容有区别'), reading('同一个读者', '确实', 2),
      reading('同一个读者', '👍👍'), reading('同一个读者', '😡😡'),
      reading('同一个读者', '别克君越真不错'), reading('同一个读者', '别克君越真不错，就是车机死机')];
    const preview = postEvent(task).preview;
    await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(task,
      {preview, comments: {status: 'captured', headerCount: 8, items}})]}, persist);
    const [first] = await query(`SELECT id,payload->'commentsCleanedItems' AS items FROM records WHERE tenant_id=$1`, [f.tenantId]);
    assert.equal(new Set(first.items.map(x => x.commentId)).size, 8);
    for (const c of first.items) await query(`INSERT INTO record_comments
      (tenant_id,record_id,platform,external_comment_id,parent_comment_id,author_name,content,floor_index,payload)
      VALUES($1,$2,'wechat_channels',$3,$4,$5,$6,$7,$8)`,
      [f.tenantId,first.id,c.commentId,c.parentCommentId,c.authorName,c.content,c.floorIndex,c]);
    const reordered = [reading('楼主乙B', items[2].content), reading('同一个读者', '确实', 0),
      reading('楼主甲B', items[0].content), reading('同一个读者', '确实', 2), items[5], items[4], items[7], items[6]];
    await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(task,
      {preview, comments: {status: 'captured', headerCount: 8, items: reordered}})]}, persist);
    const [again] = await query(`SELECT payload->'commentsCleanedItems' AS items FROM records WHERE id=$1`, [first.id]);
    assert.deepEqual(again.items.map(x => x.commentId), [2,3,0,1,5,4,7,6].map(i => first.items[i].commentId));
    assert.equal(again.items[1].parentCommentId, first.items[2].commentId);
    assert.equal(again.items[3].parentCommentId, first.items[0].commentId);
    assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1', [f.tenantId])).length, 1);
    await f.complete(task);
  });

  await t.test('a post captured again keeps its comment ids although OCR read the comments a little differently', async st => {
    const f = await fixture(st);
    await elasticParent(f.tenantId, {platform: 'wechat_channels', eligibleAgentIds: [f.phone.id], keywords: ['安吉星', '安吉星收费']});
    const first = await f.poll({platforms: ['wechat_channels']});
    const reading = (author, content) => ({author, location: '上海', timeLabel: '1天前', content, likeCount: 0, reply: false, parentIndex: null});
    const preview = {...postEvent(first.task).preview, nickname: '尼克杨开凯迪', createtime: Math.floor(Date.now() / 1000) - 7200};
    await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(first.task, {preview,
      comments: {status: 'captured', headerCount: 2, items: [reading('迷途懒猫心', '没有一滴油是白喝起'), reading('田纳西瓜皮', '安吉星也要付钱的，一天一块钱C')]}})]}, persist);
    const [stored] = await query(`SELECT payload->'commentsCleanedItems' AS items FROM records WHERE tenant_id=$1`, [f.tenantId]);
    await f.complete(first.task);
    // Next keyword, the same post: the badge after the name and the sticker at the end were read differently.
    const second = await f.poll({platforms: ['wechat_channels']});
    await f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [postEvent(second.task, {preview,
      comments: {status: 'captured', headerCount: 3, items: [reading('迷途懒猫凶', '没有一滴油是白喝起'),
        reading('田纳西瓜皮', '安吉星“也要付钱的，一天一块钱起'), reading('新来的', '安吉星好用')]}})]}, persist);
    const [again] = await query(`SELECT payload->'commentsCleanedItems' AS items FROM records WHERE tenant_id=$1`, [f.tenantId]);
    assert.deepEqual(again.items.slice(0, 2).map(item => item.commentId), stored.items.map(item => item.commentId));
    assert.ok(!stored.items.some(item => item.commentId === again.items[2].commentId), 'the new comment has its own id');
    await f.complete(second.task);
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
