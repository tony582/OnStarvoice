import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, mkdtemp, rm, writeFile, stat, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {articleExternalId, canonicalArticleUrl} from '../../../server/services/android-control/articles.js';
import {pngFixture} from '../../helpers/wechat-image-fixtures.mjs';

// Runs only against an explicitly isolated PostgreSQL database. Optional real-phone evidence is replayed
// with a newly issued test lease; body/comments/metrics and capture time remain the phone's actual values.
test('WeChat articles: phone capability, records, nullable observations, comments, patrol and durable receipts', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const mediaDir = await mkdtemp(join(tmpdir(), 'wechat-article-media-test-'));
  const previousMediaDir = process.env.MEDIA_DIR, previousFetch = globalThis.fetch;
  process.env.MEDIA_DIR = mediaDir;
  const mockedImages = new Map(), fetchedImages = [], unexpectedFetches = [];
  // Every fetch is intercepted for this entire test process, including detached media tasks.
  globalThis.fetch = async (url, options) => {
    const key = String(url); fetchedImages.push({url: key, options});
    if (!mockedImages.has(key)) { unexpectedFetches.push(key); throw new Error('Unmocked outbound request refused'); }
    return mockedImages.get(key)(options);
  };
  const {createAndroidControlService} = await import('../../../server/services/android-control/service.js');
  const {getProcessBackgroundWorkSnapshot} = await import('../../../server/runtime/process-background-work.js');
  const settleBackground = async () => {
    for (let i = 0; i < 500; i++) {
      if (!getProcessBackgroundWorkSnapshot().inFlight) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('local background jobs did not settle');
  };
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {normalizeRecord, syncNormalizedRecord} = await import('../../../server/routes/sync.js');
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {reprocessPendingCommentWorkflowReceipts} = await import('../../../server/services/comment-workflow.js');
  await runMigrations();
  const pool = getPool();
  t.after(async () => {
    try { await settleBackground(); await closePool(); assert.deepEqual(unexpectedFetches, []); }
    finally {
      globalThis.fetch = previousFetch;
      if (previousMediaDir === undefined) delete process.env.MEDIA_DIR; else process.env.MEDIA_DIR = previousMediaDir;
      await rm(mediaDir, {recursive: true, force: true});
    }
  });
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const persist = async (body, context) => syncNormalizedRecord(normalizeRecord(body)[0], context);
  const drain = async f => {
    for (let attempt = 0; attempt < 60; attempt++) {
      await reprocessPendingCommentWorkflowReceipts({queuedGraceSeconds: 0});
      const pending = await query(`SELECT comment_workflow_status AS status,comment_workflow_error AS error
        FROM record_observations WHERE tenant_id=$1 AND comment_workflow_status NOT IN ('not_required','persisted')`, [f.tenantId]);
      assert.ok(!pending.some(row => row.status === 'failed'), JSON.stringify(pending));
      if (!pending.length) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('comment receipt did not settle within 3 seconds');
  };
  const send = (f, event) => f.service.posts(f.principal, {uploadBatchId: randomUUID(), events: [event]}, persist);
  const metricKeys = ['read', 'like', 'share', 'recommend'];
  const iso = value => new Date(value).toISOString();
  const observationEvidence = row => ({captureTimestamp: row.payload.captureTimestamp,
    article: row.payload.wechatArticle, likes: row.likes, comments: row.comments_count,
    collects: row.collects, shares: row.shares, insertedAt: iso(row.captured_at)});
  function assertCapturedObservation(row, captured) {
    const article = row.payload.wechatArticle;
    assert.equal(row.payload.captureTimestamp, Date.parse(captured.capturedAt));
    assert.equal(article.capturedAt, iso(captured.article.capturedAt ?? captured.capturedAt));
    assert.equal(article.content, captured.article.content.normalize('NFC'));
    assert.equal(article.bodyStatus, captured.article.bodyStatus);
    assert.equal(article.comments.status, captured.comments.status);
    assert.equal(article.comments.capturedAt, iso(captured.comments.capturedAt ?? captured.capturedAt));
    for (const key of metricKeys) {
      assert.equal(article.metrics[key].value, captured.article.metrics?.[key]?.value ?? null);
      assert.equal(article.metrics[key].raw, captured.article.metrics?.[key]?.raw ?? '');
      assert.equal(article.metrics[key].source, captured.article.metrics?.[key]?.source ?? captured.article.source);
      assert.equal(article.metrics[key].capturedAt, iso(captured.article.metrics?.[key]?.capturedAt ?? captured.capturedAt));
    }
  }
  function refuseEvidenceImageDownloads(events) {
    const urls = new Set(events.flatMap(event => [event.article?.coverUrl, ...(event.article?.images ?? []).map(image => image.url)]).filter(Boolean));
    // These exact supplied URLs remain in evidence. Their download attempts receive an explicit local
    // failure; neither real qpic requests nor successful image-storage claims are allowed in replay.
    for (const url of urls) mockedImages.set(url, () => new Response('Offline evidence replay: download not performed', {status: 503}));
    return urls;
  }

  async function fixture(st, options = {}) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`article-test-${randomUUID()}`]);
    st.after(async () => {
      await settleBackground();
      for (const table of ['capture_mobile_post_receipts', 'record_comments', 'record_observations', 'records',
        'capture_task_item_attempts', 'capture_task_items', 'capture_agent_commands', 'capture_tasks']) {
        await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
      }
      await query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    });
    const code = randomUUID();
    await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenantId, code]);
    const service = createAndroidControlService({enabledTenants: () => new Set([tenantId]), ...options});
    const registration = {code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
    const registered = await service.register(registration);
    const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
    const principal = {tenantId, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const sessionId = randomUUID();
    const poll = (extra = {}) => service.poll(principal, {sessionId, deviceId: registration.deviceId, readyForSearch: true,
      platforms: ['wechat_articles'], features: ['wechat_articles'], ...extra});
    const complete = (task, extra = {}) => service.complete(principal, {requestId: randomUUID(), identity: task.identity, sessionId,
      status: 'completed', deviceIdle: true, ...extra});
    return {tenantId, service, phone, principal, poll, complete};
  }
  async function parent(f, {keywords = ['安吉星'], eligibleAgentIds = [f.phone.id], planSnapshot = {}} = {}) {
    const id = randomUUID();
    const metadata = {distributionMode: 'elastic_pool', eligibleAgentIds, claimUnit: 'keyword', executionMode: 'one_time',
      planSnapshot: {platform: 'wechat_articles', keywords, searchFilters: {sort: 'comprehensive', publishTime: 'all', contentType: 'all', searchScope: 'all'},
        keywordMaxDetectedItems: 20, recoveryPolicy: {disableAutomaticSearchRetry: true, singleRelayV1: true},
        captureSettings: {autoDetailCaptureAfterListCapture: true, includeCommentsOnDetailCapture: true, detailCommentsMaxDetectedItems: 30},
        ...planSnapshot}};
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
      VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','文章测试','wechat_articles','cloud','manual','running',$3,1,$4::jsonb,'{}'::jsonb)`,
    [id, f.tenantId, metadata, JSON.stringify({total: keywords.length, assigned: 0})]);
    for (const [ordinal, keyword] of keywords.entries()) {
      await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,'wechat_articles','keyword','pending',0)`, [randomUUID(), f.tenantId, id, `keyword:${ordinal}`, ordinal, keyword]);
    }
    return id;
  }
  const metric = value => ({raw: value == null ? '' : String(value), value, precision: value == null ? 'unknown' : 'displayed_integer'});
  const eventFor = (task, overrides = {}) => ({eventKind: 'wechat_article', eventId: randomUUID(), ...task.identity,
    mode: 'keyword', rank: 1, capturedAt: new Date().toISOString(),
    card: {snippet: '安吉星文章', author: '测试公众号', timeLabel: '昨天'},
    link: {shareUrl: 'https://mp.weixin.qq.com/s/article_test_0001?scene=1#wechat_redirect'},
    article: {title: '安吉星服务文章', content: '这是一篇完整的安吉星服务文章，正文即使关闭评论仍可采集。', account: '测试公众号', author: '作者甲',
      publishedAt: '2026-11-08 10:32', timeLabel: '2026年11月8日 10:32', timePrecision: 'minute', location: '上海',
      bodyStatus: 'complete', bodyReason: '', source: 'screen_ocr', contentType: 'article',
      metrics: {read: {raw: '1.2万', value: 12000, precision: 'abbreviated'}, like: metric(null), share: metric(null), recommend: metric(null)},
      bodyBlocks: [{type: 'text', text: '按阅读顺序的正文'}], images: [],
      evidence: {screens: 3, bodyEndObserved: true, overlapVerified: true, originalImagesCaptured: false}},
    comments: {status: 'unavailable', postingState: 'unknown', reason: 'comment_entry_not_visible', headerCount: null, items: []},
    ...overrides});
  const stored = async f => (await query('SELECT * FROM records WHERE tenant_id=$1', [f.tenantId]));
  async function imageRecord(f, urls, platform = 'wechat_articles') {
    const payload = {wechatArticle: {title: '本地图片测试', capturedAt: new Date().toISOString(), source: 'page_dom',
      images: urls.map(url => ({url, stored: false})), evidence: {originalImagesCaptured: false}}};
    const [row] = await query(`INSERT INTO records(tenant_id,external_id,platform,title,image_urls,payload)
      VALUES($1,$2,$3,'本地图片测试',$4::jsonb,$5::jsonb) RETURNING *`,
    [f.tenantId, randomUUID(), platform, JSON.stringify(urls), JSON.stringify(payload)]);
    return row;
  }

  await t.test('old phones and browsers cannot claim article work; new phone receives the separate workflow', async st => {
    const f = await fixture(st);
    await parent(f);
    assert.equal((await f.poll({features: []})).task, null, 'listing a platform without its feature is insufficient');
    assert.equal((await f.poll({features: ['wechat_search_filters'], platforms: ['wechat_channels']})).task, null);
    const claim = await f.poll();
    assert.equal(claim.task.platform, 'wechat_articles');
    assert.deepEqual(claim.task.comments, {enabled: true, limit: 30});
    const [child] = await query('SELECT metadata FROM capture_tasks WHERE id=$1', [claim.task.identity.taskId]);
    assert.equal(child.metadata.workflow, 'wechat_articles_mobile_capture');
    const heldOnOlder = await f.poll({features: []});
    assert.equal(heldOnOlder.task, null);
    assert.equal(heldOnOlder.control.reason, 'article_capability_missing');
    await f.complete(claim.task);
    const code = randomUUID();
    const [{id: codeId}] = await query("INSERT INTO auth_codes(tenant_id,code,status,expires_at) VALUES($1,$2,'active',now()+interval '1 day') RETURNING id", [f.tenantId, code]);
    const [{id: bindingId}] = await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id', [codeId, randomUUID()]);
    const capabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true, singleRelayV1: true, taskStateKnown: true, supportedPlatforms: []};
    const [browser] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
      VALUES($1,$2,'Browser test','active',ARRAY[]::text[],$3,$4,$5,now(),now(),now()) RETURNING *`, [f.tenantId, randomUUID(), codeId, bindingId, capabilities]);
    await parent(f, {eligibleAgentIds: [browser.id]});
    assert.equal(await withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: browser, capabilities})), null);
  });

  await t.test('article manual dispatch and daily scheduling require the feature and create phone children', async st => {
    const f = await fixture(st);
    const {createApp} = await import('../../../server/app.js');
    const {hashSessionToken} = await import('../../../server/services/auth-service.js');
    const {runCaptureOrchestrationScheduleNow} = await import('../../../server/services/capture-orchestration-scheduler.js');
    const token = randomUUID();
    const [{id: userId}] = await query(`INSERT INTO users(email,name,password_hash,is_internal,global_role,must_change_password)
      VALUES($1,'Article test','not-a-login-password',true,'platform_admin',false) RETURNING id`, [`${randomUUID()}@example.invalid`]);
    await query(`INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [userId, hashSessionToken(token)]);
    st.after(() => query('DELETE FROM users WHERE id=$1', [userId]));
    const server = await new Promise((resolve, reject) => {
      const listener = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
      listener.once('listening', () => resolve(listener)); listener.once('error', reject);
    });
    st.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const parentId = await parent(f);
    await query(`UPDATE capture_tasks SET status='pending',orchestration_revision=0,
      metadata=metadata||'{"distributionMode":"fixed_batch","draft":true}'::jsonb WHERE id=$1`, [parentId]);
    const items = await query('SELECT id FROM capture_task_items WHERE task_id=$1', [parentId]);
    const dispatch = async () => {
      // The sole real HTTP request targets this test's loopback listener; never follow a redirect.
      const response = await previousFetch(`http://127.0.0.1:${server.address().port}/api/capture-cloud/orchestrations/${parentId}/dispatch`, {
        method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant-id': f.tenantId},
        body: JSON.stringify({expectedRevision: 0, assignments: items.map(item => ({itemId: item.id, agentId: f.phone.id}))}),
      });
      return {status: response.status, body: await response.json()};
    };
    await f.poll({features: []});
    assert.ok((await dispatch()).status >= 400, 'old phone cannot receive an article assignment');
    await f.poll();
    const accepted = await dispatch();
    assert.ok([200, 201].includes(accepted.status), JSON.stringify(accepted.body));
    assert.equal(accepted.body.executions[0].commandId, null);
    const [manual] = await query(`SELECT * FROM capture_tasks WHERE parent_task_id=$1 AND metadata->>'workflow'='wechat_articles_mobile_capture'`, [parentId]);
    assert.equal(manual.platform, 'wechat_articles');
    assert.deepEqual(manual.metadata.comments, {enabled: true, limit: 30});
    const claim = await f.poll();
    assert.equal(claim.task.identity.taskId, manual.id);
    await f.complete(claim.task);

    const templateId = await parent(f, {keywords: ['安吉星计划']});
    await query(`UPDATE capture_tasks SET status='pending',metadata=metadata||'{"orchestrationTemplate":true,"distributionMode":"fixed_batch"}'::jsonb WHERE id=$1`, [templateId]);
    await query('UPDATE capture_task_items SET assigned_agent_id=$2,assignment_revision=1 WHERE task_id=$1', [templateId, f.phone.id]);
    const scheduleId = randomUUID();
    const plan = {mode: 'daily', startTime: '09:00', maxRounds: 1, roundGapMin: 10, platform: 'wechat_articles', keywords: ['安吉星计划'],
      searchFilters: {sort: 'likes', publishTime: 'all', contentType: 'all'}, keywordMaxDetectedItems: 3,
      captureSettings: {autoDetailCaptureAfterListCapture: true, includeCommentsOnDetailCapture: false}};
    await query(`INSERT INTO capture_orchestration_schedules(id,tenant_id,template_task_id,title,platform,status,schedule_mode,timezone,start_time,
      random_offset_min,custom_dates,overlap_policy,late_start_grace_min,allocation_mode,distribution_mode,revision,plan_snapshot,next_run_at)
      VALUES($1,$2,$3,'文章计划','wechat_articles','active','daily','Asia/Shanghai','09:00',0,ARRAY[]::date[],'skip',360,'balanced','fixed_batch',1,$4::jsonb,now())`,
    [scheduleId, f.tenantId, templateId, JSON.stringify(plan)]);
    const scheduled = await runCaptureOrchestrationScheduleNow({tenantId: f.tenantId, scheduleId, requestKey: randomUUID()});
    assert.equal(scheduled.kind, 'created', JSON.stringify(scheduled));
    const [daily] = await query(`SELECT * FROM capture_tasks WHERE parent_task_id=$1 AND metadata->>'workflow'='wechat_articles_mobile_capture'`, [scheduled.runTaskId]);
    assert.equal(daily.platform, 'wechat_articles');
    assert.deepEqual(daily.metadata.filters, {sort: 'hot', publishWindowHours: null});
    assert.deepEqual(daily.metadata.comments, {enabled: false, limit: 0});
    const dailyClaim = await f.poll();
    assert.equal(dailyClaim.task.identity.taskId, daily.id);
    await f.complete(dailyClaim.task);
  });

  await t.test('closed and unavailable comments still store full body; unknown counts stay null and receipts replay', async st => {
    const f = await fixture(st);
    await parent(f);
    const {task} = await f.poll();
    const event = eventFor(task, {comments: {status: 'closed', postingState: 'closed', reason: 'explicit_closed', headerCount: null, items: []}});
    const batch = {uploadBatchId: randomUUID(), events: [event]};
    const first = await f.service.posts(f.principal, batch, persist);
    assert.equal(first.receipts[0].status, 'accepted');
    const [record] = await stored(f);
    assert.equal(record.platform, 'wechat_articles');
    assert.equal(record.external_id, articleExternalId(event.link.shareUrl));
    assert.equal(record.url, canonicalArticleUrl(event.link.shareUrl));
    assert.equal(record.content, event.article.content);
    assert.equal(record.publish_time, '2026-11-08 10:32');
    assert.deepEqual([record.likes, record.comments_count, record.collects, record.shares], [null, null, null, null]);
    assert.equal(record.payload.wechatArticle.comments.status, 'closed');
    assert.equal(record.payload.wechatArticle.metrics.read.precision, 'abbreviated');
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, false);
    const [observation] = await query('SELECT * FROM record_observations WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(observation.capture_task_item_attempt_id, task.identity.attemptId);
    assert.deepEqual([observation.likes, observation.comments_count, observation.collects, observation.shares], [null, null, null, null]);
    const replay = await f.service.posts(f.principal, batch, persist);
    assert.equal(replay.receipts[0].receiptId, first.receipts[0].receiptId);
    assert.equal((await f.service.postReceipts(f.principal, batch.uploadBatchId)).receipts.length, 1);
    await assert.rejects(send(f, {...event, rank: 2}), {code: 'EVENT_PAYLOAD_CONFLICT'});
    await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients','文件传输助手')`, [f.tenantId]);
    await assert.rejects(f.service.forward(f.tenantId, {recordId: record.id, recipients: ['文件传输助手']}), {code: 'RECORD_NOT_WECHAT_CHANNELS'});
    await f.complete(task);
  });

  await t.test('cross-keyword recapture updates one record and preserves known body/counts while the new observation stays unknown', async st => {
    const f = await fixture(st);
    await parent(f, {keywords: ['安吉星', '安吉星服务']});
    const first = (await f.poll()).task;
    const initial = eventFor(first);
    initial.article.metrics.like = metric(12);
    initial.article.metrics.share = metric(0);
    initial.comments = {status: 'empty', postingState: 'open', reason: 'explicit_zero', headerCount: 0, items: []};
    assert.equal((await send(f, initial)).receipts[0].status, 'accepted');
    await f.complete(first);
    const second = (await f.poll()).task;
    const partial = eventFor(second);
    partial.article.content = '这是一篇';
    partial.article.bodyStatus = 'partial';
    partial.article.bodyReason = 'screen_budget';
    partial.link.shareUrl = 'https://mp.weixin.qq.com/s/article_test_0001?scene=2';
    await send(f, partial);
    const rows = await stored(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, initial.article.content);
    assert.equal(rows[0].likes, 12);
    assert.equal(rows[0].shares, 0);
    assert.equal(rows[0].payload.wechatArticle.bodyStatus, 'complete');
    assert.equal(rows[0].payload.wechatArticle.latestCapture.bodyStatus, 'partial');
    assert.equal(rows[0].payload.wechatArticle.latestCapture.metrics.like.value, null);
    const observations = await query('SELECT * FROM record_observations WHERE tenant_id=$1 ORDER BY captured_at', [f.tenantId]);
    assert.equal(observations.length, 2);
    assert.equal(observations[1].likes, null);
    assert.equal(observations[1].comments_count, null);
    assert.equal(observations[1].payload.wechatArticle.bodyStatus, 'partial');
    await f.complete(second);
  });

  await t.test('synthetic recaptures preserve prior metric/time evidence and a complete DOM body when the next body is partial', async st => {
    const f = await fixture(st);
    await parent(f, {keywords: ['离线合成首次', '离线合成重采']});
    const first = (await f.poll()).task, firstAt = iso(Date.now() - 120_000), secondAt = iso(Date.now() - 60_000);
    const initial = eventFor(first, {capturedAt: firstAt});
    Object.assign(initial.article, {source: 'page_dom', capturedAt: firstAt,
      content: '仅用于离线合成回归：第一次采集到的完整正文，第二次片段不得替换它。',
      metrics: {read: metric(1200), like: metric(12), share: metric(0), recommend: metric(null)}});
    const initialReceipt = (await send(f, initial)).receipts[0];
    assert.equal(initialReceipt.status, 'accepted');
    const [initialObservation] = await query('SELECT * FROM record_observations WHERE capture_task_item_attempt_id=$1', [first.identity.attemptId]);
    assertCapturedObservation(initialObservation, initial);
    const before = observationEvidence(initialObservation);
    await f.complete(first);
    const second = (await f.poll()).task;
    const partial = eventFor(second, {capturedAt: secondAt});
    Object.assign(partial.article, {source: 'page_dom', capturedAt: secondAt, content: '仅用于离线合成回归', bodyStatus: 'partial', bodyReason: 'content_limit',
      metrics: {read: metric(1500), like: metric(99), share: metric(0), recommend: metric(null)},
      evidence: {domContentObserved: true, bodyEndObserved: false, originalImagesCaptured: false}});
    partial.link.shareUrl = 'https://mp.weixin.qq.com/s/article_test_0001?scene=synthetic_second#tracked';
    const batch = {uploadBatchId: randomUUID(), events: [partial]};
    const receipt = (await f.service.posts(f.principal, batch, persist)).receipts[0];
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.recordId, initialReceipt.recordId);
    const [record] = await stored(f);
    assert.equal(record.content, initial.article.content);
    assert.equal(record.payload.wechatArticle.bodyStatus, 'complete');
    assert.equal(record.payload.wechatArticle.capturedAt, firstAt);
    assert.equal(record.payload.wechatArticle.latestCapture.bodyStatus, 'partial');
    assert.equal(record.payload.wechatArticle.latestCapture.capturedAt, secondAt);
    assert.equal(record.likes, 99);
    const [secondObservation] = await query('SELECT * FROM record_observations WHERE capture_task_item_attempt_id=$1', [second.identity.attemptId]);
    assertCapturedObservation(secondObservation, partial);
    assert.notEqual(secondObservation.id, initialObservation.id);
    const [unchanged] = await query('SELECT * FROM record_observations WHERE id=$1', [initialObservation.id]);
    assert.deepEqual(observationEvidence(unchanged), before);
    assert.equal((await f.service.posts(f.principal, batch, persist)).receipts[0].receiptId, receipt.receiptId);
    assert.equal((await query('SELECT id FROM record_observations WHERE tenant_id=$1', [f.tenantId])).length, 2);
    await f.complete(second);
    st.diagnostic(JSON.stringify({kind: 'synthetic_regression', recordId: record.id,
      first: {observationId: initialObservation.id, receiptId: initialReceipt.receiptId, eventCapturedAt: firstAt, likes: 12},
      second: {observationId: secondObservation.id, receiptId: receipt.receiptId, eventCapturedAt: secondAt, likes: 99},
      completeBodyPreserved: true, originalImagesDownloaded: false}));
  });

  await t.test('a synthetic complete but shorter DOM recapture updates the current body without rewriting the first observation', async st => {
    const f = await fixture(st);
    await parent(f, {keywords: ['离线合成完整旧稿', '离线合成完整短稿']});
    const first = (await f.poll()).task, initial = eventFor(first);
    initial.article.source = 'page_dom';
    initial.article.content = '离线合成旧稿：这是第一次读到的完整长正文，后续已确认完整的新稿可以更短。';
    assert.equal((await send(f, initial)).receipts[0].status, 'accepted');
    const [observation] = await query('SELECT * FROM record_observations WHERE capture_task_item_attempt_id=$1', [first.identity.attemptId]);
    const before = observationEvidence(observation);
    await f.complete(first);
    const second = (await f.poll()).task, shorter = eventFor(second);
    Object.assign(shorter.article, {source: 'page_dom', content: '离线合成完整短稿。', bodyStatus: 'complete'});
    const receipt = (await send(f, shorter)).receipts[0];
    assert.equal(receipt.status, 'accepted');
    const [record] = await stored(f);
    assert.equal(record.content, shorter.article.content);
    assert.equal(record.payload.wechatArticle.bodyStatus, 'complete');
    assert.equal(record.payload.wechatArticle.latestCapture.bodyStatus, 'complete');
    const [unchanged] = await query('SELECT * FROM record_observations WHERE id=$1', [observation.id]);
    assert.deepEqual(observationEvidence(unchanged), before);
    const [updated] = await query('SELECT * FROM record_observations WHERE capture_task_item_attempt_id=$1', [second.identity.attemptId]);
    assertCapturedObservation(updated, shorter);
    await f.complete(second);
    st.diagnostic(JSON.stringify({kind: 'synthetic_complete_shorter', recordId: record.id,
      oldCharacters: initial.article.content.length, newCharacters: shorter.article.content.length,
      firstObservationId: observation.id, secondObservationId: updated.id, latestBodyUpdated: true}));
  });

  await t.test('DOM body and ordered image URLs enter the existing record path while phone evidence stays separate', async st => {
    const {isAllowedMediaHost} = await import('../../../server/services/media-proxy.js');
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const imageUrls = ['https://mmbiz.qpic.cn/offline-fixture/first.png', 'https://mmbiz.qpic.cn/offline-fixture/second.png'];
    assert.ok(imageUrls.every(isAllowedMediaHost));
    for (const url of imageUrls) mockedImages.set(url, () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    const f = await fixture(st);
    await parent(f, {keywords: ['安吉星', '安吉星更新', '安吉星长图', '安吉星再巡查', '安吉星无图正文']});
    const first = (await f.poll()).task;
    const dom = eventFor(first);
    const bodyAt = new Date(Date.now()-60_000).toISOString(), phoneAt = new Date(Date.now()-30_000).toISOString();
    Object.assign(dom.article, {source: 'page_dom', capturedAt: bodyAt, timeSource: 'page_dom', content: '来自网页 DOM 的完整正文。',
      images: imageUrls.map((url, order) => ({url, alt: `图${order + 1}`, order, source: 'page_dom', stored: true, layer: order ? 'interactive' : 'visible'})),
      bodyBlocks: [{type: 'text', text: '来自网页 DOM 的完整正文。'}, ...imageUrls.map((url, order) => ({type: 'image', url, layer: order ? 'interactive' : 'visible'}))]});
    dom.article.metrics.like = {raw: '7', value: 7, source: 'screen_ocr', capturedAt: phoneAt};
    dom.article.metrics.read = {raw: '', value: null, source: 'page_dom', capturedAt: bodyAt};
    dom.comments = {status: 'captured', source: 'screen_ocr', capturedAt: phoneAt, postingState: 'open', headerCount: 1,
      items: [{author: '手机读者', content: '手机页尾真实可读留言', timeLabel: '昨天', likeCount: null, reply: false}]};
    const receipt = (await send(f, dom)).receipts[0];
    assert.equal(receipt.status, 'accepted');
    await drain(f);
    await settleBackground();
    const [record] = await stored(f);
    assert.deepEqual(record.image_urls, imageUrls);
    assert.equal(record.image_local_urls.length, 2, 'the real ingestion queue downloaded both locally mocked images');
    for (const entry of record.image_local_urls) assert.ok((await stat(join(mediaDir, entry.url.slice('/media/'.length)))).size > 0);
    assert.ok(fetchedImages.filter(item => imageUrls.includes(item.url)).every(item => item.options.headers.Referer === 'https://mp.weixin.qq.com/'));
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    assert.deepEqual({...record.payload.wechatArticle.evidence.imageStorage, checkedAt: null}, {expected: 2, stored: 2, checkedAt: null});
    assert.equal(record.payload.wechatArticle.source, 'page_dom');
    assert.equal(record.payload.wechatArticle.capturedAt, bodyAt);
    assert.equal(record.payload.wechatArticle.metrics.like.source, 'screen_ocr');
    assert.equal(record.payload.wechatArticle.metrics.like.capturedAt, phoneAt);
    assert.equal(record.payload.wechatArticle.metrics.read.value, null);
    assert.ok(record.payload.wechatArticle.images.every(image => image.stored && image.downloadEligible && image.localUrl.startsWith('/media/')));
    assert.deepEqual(record.payload.wechatArticle.images.map(image => image.layer), ['visible', 'interactive']);
    assert.deepEqual(record.payload.wechatArticle.bodyBlocks.filter(block => block.type === 'image').map(block => block.layer), ['visible', 'interactive']);
    const [{payload: capturedPayload}] = await query(`SELECT o.payload FROM record_observations o
      JOIN capture_mobile_post_receipts r ON r.observation_id=o.id WHERE r.id=$1`, [receipt.receiptId]);
    assert.equal(capturedPayload.wechatArticle.evidence.originalImagesCaptured, false, 'capture evidence is not rewritten after download');
    assert.deepEqual(capturedPayload.wechatArticle.images.map(image => image.layer), ['visible', 'interactive']);
    assert.deepEqual(capturedPayload.wechatArticle.bodyBlocks.filter(block => block.type === 'image').map(block => block.layer), ['visible', 'interactive']);
    const fetchedBeforeReuse = fetchedImages.length;
    await ensureRecordImagesLocal(receipt.recordId, imageUrls, 'wechat_articles');
    assert.equal(fetchedImages.length, fetchedBeforeReuse, 'verified existing files are reused');
    await rm(join(mediaDir, record.image_local_urls[0].url.slice('/media/'.length)));
    await ensureRecordImagesLocal(receipt.recordId, imageUrls, 'wechat_articles');
    assert.equal(fetchedImages.length, fetchedBeforeReuse + 1, 'a deleted local file is downloaded again rather than trusted');
    const [comment] = await query('SELECT payload FROM record_comments WHERE record_id=$1', [record.id]);
    assert.equal(comment.payload.source, 'screen_ocr');
    assert.equal(comment.payload.capturedAt, phoneAt);
    await f.complete(first);
    const second = (await f.poll()).task;
    const ocr = eventFor(second); ocr.article.content = '手机只看见一小段'; ocr.article.bodyStatus = 'partial';
    await send(f, ocr);
    const [updated] = await stored(f);
    assert.equal(updated.content, dom.article.content);
    assert.deepEqual(updated.image_urls, imageUrls);
    assert.equal(updated.payload.wechatArticle.source, 'page_dom');
    assert.equal(updated.payload.wechatArticle.capturedAt, bodyAt);
    assert.equal(updated.payload.wechatArticle.latestCapture.source, 'screen_ocr');
    const [latest] = await query('SELECT payload FROM record_observations WHERE capture_task_item_attempt_id=$1', [second.identity.attemptId]);
    assert.equal(latest.payload.wechatArticle.source, 'screen_ocr');
    assert.equal(latest.payload.wechatArticle.content, ocr.article.content);
    await f.complete(second);
    const third = (await f.poll()).task;
    const imageOnly = eventFor(third);
    Object.assign(imageOnly.article, {source: 'page_dom', content: '', images: dom.article.images,
      bodyBlocks: imageUrls.map(url => ({type: 'image', url})), bodyStatus: 'complete'});
    await send(f, imageOnly);
    const [imageRecord] = await stored(f);
    assert.equal(imageRecord.content, '', 'a verified image-only DOM body replaces stale textual content');
    assert.deepEqual(imageRecord.image_urls, imageUrls);
    await f.complete(third);
    const fourth = (await f.poll()).task;
    await send(f, eventFor(fourth));
    const [kept] = await stored(f);
    assert.equal(kept.content, '', 'even an OCR result marked complete cannot replace a complete DOM body');
    assert.equal(kept.payload.wechatArticle.source, 'page_dom');
    assert.equal(kept.payload.wechatArticle.latestCapture.source, 'screen_ocr');
    await f.complete(fourth);
    await ensureRecordImagesLocal(receipt.recordId, imageUrls, 'wechat_articles');
    await query('UPDATE records SET image_local_urls=$2::jsonb WHERE id=$1', [receipt.recordId,
      JSON.stringify([{source_url: imageUrls[0], source_hash: 'offline-placeholder', url: '/media/images/offline-placeholder.png'}])]);
    const fifth = (await f.poll()).task;
    const textOnly = eventFor(fifth); textOnly.article.source = 'page_dom';
    await send(f, textOnly);
    const [textRecord] = await stored(f);
    assert.deepEqual(textRecord.image_urls, []);
    assert.deepEqual(textRecord.image_local_urls, [], 'a replacement DOM body without images cannot keep a stale image gallery');
    await f.complete(fifth);
  });

  await t.test('decorative separators do not inflate expected images or rewrite the captured observation', async st => {
    const {ensureRecordImagesLocal, backfillRecentImages} = await import('../../../server/services/media-store.js');
    const f = await fixture(st), urls = ['separator.png', 'photo.png'].map(name => `https://mmbiz.qpic.cn/offline-fixture/decorative/${name}`);
    mockedImages.set(urls[0], () => new Response(pngFixture(1, 3), {headers: {'content-type': 'image/png'}}));
    mockedImages.set(urls[1], () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    await parent(f);
    const {task} = await f.poll(), event = eventFor(task);
    Object.assign(event.article, {source: 'page_dom', images: urls.map(url => ({url, source: 'page_dom', stored: false})),
      bodyBlocks: [{type: 'text', text: event.article.content}, ...urls.map(url => ({type: 'image', url}))]});
    const receipt = (await send(f, event)).receipts[0];
    assert.equal(receipt.status, 'accepted'); await settleBackground();
    let [record] = await stored(f);
    assert.deepEqual(record.image_urls, urls, 'original observed URLs remain evidence');
    assert.deepEqual(record.image_local_urls.map(image => image.source_url), [urls[1]]);
    assert.deepEqual(record.payload.wechatArticle.images[0].storageError, {code: 'decorative'});
    assert.equal(record.payload.wechatArticle.images[0].stored, false);
    assert.equal(record.payload.wechatArticle.images[1].stored, true);
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    assert.deepEqual({...record.payload.wechatArticle.evidence.imageStorage, checkedAt: null}, {expected: 1, stored: 1, checkedAt: null});
    const [observation] = await query(`SELECT o.* FROM record_observations o
      JOIN capture_mobile_post_receipts r ON r.observation_id=o.id WHERE r.id=$1`, [receipt.receiptId]);
    assert.equal(observation.payload.wechatArticle.images[0].storageError, undefined);
    assert.equal(observation.payload.wechatArticle.evidence.originalImagesCaptured, false);
    mockedImages.set(urls[0], () => new Response('', {status: 403}));
    await ensureRecordImagesLocal(record.id, urls, 'wechat_articles');
    [record] = await stored(f);
    assert.equal(record.payload.wechatArticle.evidence.imageStorage.expected, 1, 'later unknown failures do not erase measured separator evidence');
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    await f.complete(task);

    const decorativeOnly = await imageRecord(f, [urls[0]]);
    mockedImages.set(urls[0], () => new Response(pngFixture(1, 3), {headers: {'content-type': 'image/png'}}));
    await ensureRecordImagesLocal(decorativeOnly.id, [urls[0]], 'wechat_articles');
    const [empty] = await query('SELECT * FROM records WHERE id=$1', [decorativeOnly.id]);
    assert.deepEqual(empty.image_local_urls, []);
    assert.deepEqual({...empty.payload.wechatArticle.evidence.imageStorage, checkedAt: null}, {expected: 0, stored: 0, checkedAt: null});
    assert.equal(empty.payload.wechatArticle.evidence.originalImagesCaptured, false, 'zero substantive images cannot claim stored originals');

    const failedUrls = ['unknown.png', 'large.gif'].map(name => `https://mmbiz.qpic.cn/offline-fixture/decorative/${name}`);
    mockedImages.set(failedUrls[0], () => new Response('', {status: 403}));
    mockedImages.set(failedUrls[1], () => new Response('too large',
      {headers: {'content-type': 'image/gif', 'content-length': String(9 * 1024 * 1024)}}));
    const failed = await imageRecord(f, failedUrls);
    await ensureRecordImagesLocal(failed.id, failedUrls, 'wechat_articles');
    const beforeBackfill = fetchedImages.length;
    await backfillRecentImages();
    const retried = fetchedImages.slice(beforeBackfill).map(image => image.url);
    assert.ok(!retried.some(url => urls.includes(url)), 'complete substantive images and decorative-only records need no repeated backfill');
    assert.deepEqual(retried.filter(url => failedUrls.includes(url)), failedUrls, 'unknown and too-large failures remain eligible');

    // A new body revision replaces storage metadata; the old 0/0 summary must not suppress revalidation.
    await query(`UPDATE records SET payload=jsonb_set(payload,'{wechatArticle,images}',$2::jsonb) WHERE id=$1`,
      [decorativeOnly.id, JSON.stringify([{url: urls[0], stored: false}])]);
    mockedImages.set(urls[0], () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    await backfillRecentImages();
    const [revised] = await query('SELECT payload FROM records WHERE id=$1', [decorativeOnly.id]);
    assert.deepEqual({...revised.payload.wechatArticle.evidence.imageStorage, checkedAt: null}, {expected: 1, stored: 1, checkedAt: null});
    assert.equal(revised.payload.wechatArticle.evidence.originalImagesCaptured, true);
  });

  await t.test('WeChat image storage rejects placeholders, actual oversized streams and unsafe redirects, then revalidates reused files', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const f = await fixture(st);
    const prefix = 'https://mmbiz.qpic.cn/offline-fixture/validation/';
    const urls = ['valid.png', 'placeholder.png', 'html.png', 'oversized.png', 'redirect.png', 'truncated.png'].map(name => prefix + name);
    mockedImages.set(urls[0], () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    mockedImages.set(urls[1], () => new Response(Buffer.concat([pngFixture(20, 20), Buffer.alloc(2000)]), {headers: {'content-type': 'image/png'}}));
    mockedImages.set(urls[2], () => new Response('<html>not authorized</html>'.repeat(1000), {headers: {'content-type': 'image/png'}}));
    let emitted = 0;
    mockedImages.set(urls[3], () => new Response(new ReadableStream({pull(controller) {
      if (emitted++ === 32) controller.close(); else controller.enqueue(new Uint8Array(1024 * 1024));
    }}), {headers: {'content-type': 'image/png', 'content-length': '64'}}));
    mockedImages.set(urls[4], () => new Response('', {status: 302, headers: {location: 'https://private.example/forbidden'}}));
    mockedImages.set(urls[5], () => new Response(pngFixture().subarray(0, 24), {headers: {'content-type': 'image/png', 'content-length': '24'}}));
    const record = await imageRecord(f, urls);
    await ensureRecordImagesLocal(record.id, urls, 'wechat_articles');
    let [updated] = await stored(f);
    assert.equal(updated.image_local_urls.length, 1);
    assert.equal(updated.payload.wechatArticle.evidence.originalImagesCaptured, false);
    assert.equal(updated.payload.wechatArticle.evidence.imageStorage.expected, 6);
    assert.equal(updated.payload.wechatArticle.evidence.imageStorage.stored, 1);
    assert.deepEqual(updated.payload.wechatArticle.images[3].storageError,
      {code: 'too_large', maxBytes: 8 * 1024 * 1024, observedBytes: 9 * 1024 * 1024, source: 'stream'});
    assert.ok(updated.payload.wechatArticle.images.filter((_, index) => index !== 3).every(image => !image.storageError));
    assert.ok(!fetchedImages.some(item => item.url === 'https://private.example/forbidden'));
    assert.ok(emitted < 32, 'the byte limit cancels the oversized stream instead of buffering it to completion');
    assert.ok((await readdir(join(mediaDir, 'images'))).every(name => !name.endsWith('.part')));
    const localPath = join(mediaDir, updated.image_local_urls[0].url.slice('/media/'.length));
    await writeFile(localPath, pngFixture(20, 20));
    mockedImages.set(urls[0], () => new Response('', {status: 503}));
    emitted = 0;
    await ensureRecordImagesLocal(record.id, urls, 'wechat_articles');
    [updated] = await stored(f);
    assert.equal(updated.image_local_urls.length, 0, 'a corrupt/placeholder cached file is not trusted');
    assert.equal(updated.payload.wechatArticle.evidence.imageStorage.stored, 0);
  });

  await t.test('oversized image facts update only the current record and clear after a verified save, never rewriting capture evidence', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const f = await fixture(st), url = 'https://mmbiz.qpic.cn/offline-fixture/size-evidence.gif';
    const reportedBytes = Math.ceil(9.3 * 1024 * 1024);
    const failure = {code: 'too_large', maxBytes: 8 * 1024 * 1024, observedBytes: reportedBytes, source: 'content_length'};
    mockedImages.set(url, () => new Response('offline oversized-header fixture',
      {headers: {'content-type': 'image/gif', 'content-length': String(reportedBytes)}}));
    await parent(f);
    const {task} = await f.poll(), event = eventFor(task);
    Object.assign(event.article, {source: 'page_dom', images: [{url, source: 'page_dom', stored: false}],
      bodyBlocks: [{type: 'text', text: event.article.content}, {type: 'image', url}]});
    const receipt = (await send(f, event)).receipts[0];
    assert.equal(receipt.status, 'accepted'); await settleBackground();
    let [record] = await stored(f);
    assert.deepEqual(record.payload.wechatArticle.images[0].storageError, failure);
    assert.equal(record.payload.wechatArticle.images[0].stored, false);
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, false);
    assert.equal(record.payload.wechatArticle.evidence.imageStorage.stored, 0);
    const [observation] = await query('SELECT * FROM record_observations WHERE capture_task_item_attempt_id=$1', [task.identity.attemptId]);
    const before = observationEvidence(observation);
    assert.equal(observation.payload.wechatArticle.images[0].storageError, undefined);
    assert.equal(observation.payload.wechatArticle.evidence.originalImagesCaptured, false);
    mockedImages.set(url, () => new Response('', {status: 403}));
    await ensureRecordImagesLocal(record.id, [url], 'wechat_articles');
    [record] = await stored(f);
    assert.deepEqual(record.payload.wechatArticle.images[0].storageError, failure, 'an unknown later failure cannot erase the measured header fact');
    mockedImages.set(url, () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    await ensureRecordImagesLocal(record.id, [url], 'wechat_articles');
    [record] = await stored(f);
    assert.equal(record.payload.wechatArticle.images[0].stored, true);
    assert.equal(record.payload.wechatArticle.images[0].storageError, undefined);
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    const [unchanged] = await query('SELECT * FROM record_observations WHERE id=$1', [observation.id]);
    assert.deepEqual(observationEvidence(unchanged), before, 'localization facts belong to current storage, not historical capture observations');
    await f.complete(task);
  });

  await t.test('an old image job cannot overwrite a newer body revision or attach images that were removed', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const f = await fixture(st), url = 'https://mmecoa.qpic.cn/offline-fixture/slow.png';
    const row = await imageRecord(f, [url]);
    let releaseFetch, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    mockedImages.set(url, async () => {
      markStarted(); await new Promise(resolve => { releaseFetch = resolve; });
      return new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
    });
    const running = ensureRecordImagesLocal(row.id, [url], 'wechat_articles');
    await started;
    const newer = {...row.payload, wechatArticle: {...row.payload.wechatArticle, capturedAt: '2026-11-09T23:59:00.000Z',
      images: [], evidence: {originalImagesCaptured: false}}};
    await query("UPDATE records SET image_urls='[]'::jsonb,payload=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(newer)]);
    releaseFetch(); await running;
    const [record] = await stored(f);
    assert.deepEqual(record.image_local_urls, []);
    assert.deepEqual(record.payload, newer, 'the old job cannot replace the new body storage evidence');
  });

  await t.test('concurrent article jobs wait for the same record and reuse the completed image mapping', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const f = await fixture(st);
    const urls = ['https://mmbiz.qpic.cn/offline-fixture/concurrent-first.png', 'https://mmecoa.qpic.cn/offline-fixture/concurrent-second.png'];
    const row = await imageRecord(f, urls);
    let markStarted, releaseFetch, firstCalls = 0, secondCalls = 0;
    const started = new Promise(resolve => { markStarted = resolve; });
    mockedImages.set(urls[0], async () => {
      firstCalls++;
      if (firstCalls === 1) { markStarted(); await new Promise(resolve => { releaseFetch = resolve; }); }
      return new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
    });
    mockedImages.set(urls[1], () => {
      secondCalls++;
      return new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
    });
    const first = ensureRecordImagesLocal(row.id, urls, 'wechat_articles');
    await started;
    const second = ensureRecordImagesLocal(row.id, urls, 'wechat_articles');
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(firstCalls, 1, 'the second job must wait before reading/downloading the record');
    } finally { releaseFetch(); await Promise.all([first, second]); }
    const [record] = await stored(f);
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
    assert.equal(record.image_local_urls.length, 2);
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    assert.equal(record.payload.wechatArticle.evidence.imageStorage.stored, 2);
  });

  await t.test('article image limit is 100 while existing platform localization remains limited to 20', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const f = await fixture(st);
    const urls = Array.from({length: 100}, (_, index) => `https://mmbiz.qpic.cn/offline-fixture/many/${index}.png`);
    for (const url of urls) mockedImages.set(url, () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    const row = await imageRecord(f, urls);
    await ensureRecordImagesLocal(row.id, urls, 'wechat_articles');
    const [record] = await query('SELECT * FROM records WHERE id=$1', [row.id]);
    assert.equal(record.image_local_urls.length, 100);
    assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, true);
    const oldUrls = Array.from({length: 21}, (_, index) => `https://p3.douyinpic.com/offline-fixture/${index}.png`);
    for (const url of oldUrls) mockedImages.set(url, () => new Response(pngFixture(20, 20), {headers: {'content-type': 'image/png'}}));
    const oldRow = await imageRecord(f, oldUrls, 'douyin');
    await ensureRecordImagesLocal(oldRow.id, oldUrls, 'douyin');
    const [oldRecord] = await query('SELECT * FROM records WHERE id=$1', [oldRow.id]);
    assert.equal(oldRecord.image_local_urls.length, 20, 'old image count and small-image behavior remain unchanged');
  });

  await t.test('article OCR resolves the stored image and caches a strictly mocked OCR response', async st => {
    const {ensureRecordImagesLocal} = await import('../../../server/services/media-store.js');
    const {extractRecordImageText} = await import('../../../server/services/image-text-extraction.js');
    const f = await fixture(st), url = 'https://mmecoa.qpic.cn/offline-fixture/ocr.png';
    mockedImages.set(url, () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}}));
    const row = await imageRecord(f, [url]);
    await ensureRecordImagesLocal(row.id, [url], 'wechat_articles');
    for (const [key, value] of Object.entries({qwen_ocr_api_key: 'offline-test-key', qwen_ocr_model: 'qwen3.5-ocr',
      qwen_ocr_api_endpoint: 'https://ocr.example.test/compatible-mode/v1'})) {
      await query('INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,$2,$3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value', [f.tenantId, key, value]);
    }
    let ocrCalls = 0;
    mockedImages.set('https://ocr.example.test/compatible-mode/v1/chat/completions', options => {
      ocrCalls++;
      const request = JSON.parse(options.body), image = request.messages[0].content[1].image_url.url;
      assert.equal(image, `data:image/png;base64,${pngFixture().toString('base64')}`);
      return new Response(JSON.stringify({choices: [{message: {content: '本地模拟图中文字'}}]}), {headers: {'content-type': 'application/json'}});
    });
    const fetchCount = fetchedImages.filter(item => item.url === url).length;
    const options = {tenantId: f.tenantId, recordId: row.id, imageRef: url};
    const first = await extractRecordImageText(options), second = await extractRecordImageText(options);
    assert.equal(first.text, '本地模拟图中文字'); assert.equal(second.cached, true); assert.equal(ocrCalls, 1);
    assert.equal(fetchedImages.filter(item => item.url === url).length, fetchCount, 'OCR used the local file, not the remote URL');
    await assert.rejects(extractRecordImageText({...options, imageRef: 'https://mmecoa.qpic.cn/not-in-record.png'}), {code: 'image_not_found'});
  });

  await t.test('comments and replies are persisted with stable IDs; missing likes do not invent zero', async st => {
    const f = await fixture(st);
    await parent(f, {keywords: ['安吉星', '安吉星评论']});
    const comments = {status: 'captured', postingState: 'followers_only', headerCount: 2, items: [
      {author: '读者甲', content: '这篇服务说明写得很清楚', location: '上海', timeLabel: '昨天', likeCount: null, reply: false},
      {author: '公众号', content: '谢谢阅读', location: '上海', timeLabel: '昨天', likeCount: 0, reply: true, parentIndex: 0}]};
    const first = (await f.poll()).task;
    await send(f, eventFor(first, {comments}));
    await drain(f);
    const one = await query('SELECT * FROM record_comments WHERE tenant_id=$1 ORDER BY floor_index', [f.tenantId]);
    assert.equal(one.length, 2);
    assert.equal(one[0].like_count, null);
    assert.equal(one[1].like_count, 0);
    assert.equal(one[1].parent_comment_id, one[0].external_comment_id);
    await f.complete(first);
    const second = (await f.poll()).task;
    await send(f, eventFor(second, {comments}));
    await drain(f);
    const two = await query('SELECT id FROM record_comments WHERE tenant_id=$1 ORDER BY floor_index', [f.tenantId]);
    assert.deepEqual(two.map(row => row.id), one.map(row => row.id));
    await f.complete(second);
  });

  await t.test('T14 uncertain authors retain empty names, distinct place/date identities and immutable observation evidence', async st => {
    const {articleEvent} = await import('../../../runners/android/src/core/wechat-article-evidence.mjs');
    const f = await fixture(st);
    await parent(f, {keywords: ['安吉星', '安吉星留言复查']});
    const comments = {status: 'partial', postingState: 'followers_only', headerCount: 13, items: [
      {author: '', authorUncertain: true, content: '这个我觉得蛮正常', location: '上海', timeLabel: '2023年9月14日', likeCount: null},
      {author: '', authorUncertain: true, content: '这个我觉得蛮正常', location: '江苏', timeLabel: '2023年9月14日', likeCount: null},
      {author: '', authorUncertain: true, content: '这个我觉得蛮正常', location: '上海', timeLabel: '2023年9月15日', likeCount: 0},
      {author: '公众号', content: '作者回复', location: '上海', timeLabel: '2023年9月15日', likeCount: null, reply: true, parentIndex: 0},
      {author: '另一位读者', content: '另一个父留言', location: '上海', timeLabel: '2023年9月14日', likeCount: null},
      {author: '', authorUncertain: true, content: '收到', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 0},
      {author: '', authorUncertain: true, content: '收到', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 4},
      {author: '', authorUncertain: true, content: '缺少地区日期的同一句留言'},
      {author: '', authorUncertain: true, content: '缺少地区日期的同一句留言'},
      {author: '', authorUncertain: true, content: '回复缺少信息的父留言', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 7},
      {author: '', authorUncertain: true, content: '回复缺少信息的父留言', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 8},
      {author: '已知回复者', content: '已知作者的相同回复', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 7},
      {author: '已知回复者', content: '已知作者的相同回复', location: '上海', timeLabel: '2023年9月14日', reply: true, parentIndex: 8}]};
    const serialized = task => {
      const source = eventFor(task, {comments});
      return JSON.parse(JSON.stringify(articleEvent({task, card: source.card, rank: source.rank, shareUrl: source.link.shareUrl,
        article: source.article, comments: source.comments, capturedAt: Date.parse(source.capturedAt)})));
    };
    const first = (await f.poll()).task, firstEvent = serialized(first);
    const batch = {uploadBatchId: randomUUID(), events: [firstEvent]};
    const accepted = await f.service.posts(f.principal, batch, persist);
    assert.equal(accepted.receipts[0].status, 'accepted');
    await drain(f);
    const one = await query('SELECT * FROM record_comments WHERE tenant_id=$1 ORDER BY floor_index', [f.tenantId]);
    assert.equal(one.length, 13, 'distinct context, parent or uncertain occurrence must not collapse');
    assert.equal(new Set(one.map(row => row.external_comment_id)).size, 13);
    assert.equal(new Set(one.map(row => row.content_hash)).size, 13);
    for (const row of one.filter((_, index) => comments.items[index].authorUncertain === true)) {
      assert.equal(row.author_name, ''); assert.equal(row.payload.authorName, ''); assert.equal(row.payload.authorUncertain, true);
      assert.equal(row.content, comments.items[row.floor_index - 1].content); assert.equal(row.payload.source, 'screen_ocr');
      assert.equal(row.payload.capturedAt, firstEvent.comments.capturedAt);
    }
    assert.equal(one[0].like_count, null); assert.equal(one[2].like_count, 0);
    for (const [index, parentIndex] of [[3, 0], [5, 0], [6, 4], [9, 7], [10, 8], [11, 7], [12, 8]]) {
      assert.equal(one[index].parent_comment_id, one[parentIndex].external_comment_id);
    }
    assert.equal(Object.hasOwn(one[3].payload, 'authorUncertain'), false);
    for (const index of [11, 12]) {
      assert.equal(one[index].author_name, '已知回复者');
      assert.equal(Object.hasOwn(one[index].payload, 'authorUncertain'), false);
      assert.equal(Object.hasOwn(one[index].payload, 'uncertainArticleParent'), false);
    }
    const [record] = await stored(f);
    assert.deepEqual(record.payload.commentsCleanedItems.map(item => item.authorName), comments.items.map(item => item.author));
    const [observation] = await query('SELECT * FROM record_observations WHERE tenant_id=$1', [f.tenantId]);
    assert.deepEqual(observation.payload.commentsCleanedItems.map(item => item.authorUncertain === true), comments.items.map(item => item.authorUncertain === true));
    assert.deepEqual(observation.payload.commentsCleanedItems.map(item => item.authorName), comments.items.map(item => item.author));
    assert.ok(observation.payload.commentsCleanedItems.every(item => !Object.hasOwn(item, 'uncertainArticleParent')));
    assertCapturedObservation(observation, firstEvent);
    const evidenceBefore = structuredClone(observation.payload);
    const replay = await f.service.posts(f.principal, batch, persist);
    assert.equal(replay.receipts[0].receiptId, accepted.receipts[0].receiptId);
    assert.equal((await query('SELECT id FROM record_observations WHERE tenant_id=$1', [f.tenantId])).length, 1);
    await f.complete(first);
    const second = (await f.poll()).task, secondEvent = serialized(second);
    const later = await send(f, secondEvent);
    await drain(f);
    const two = await query('SELECT * FROM record_comments WHERE tenant_id=$1 ORDER BY floor_index', [f.tenantId]);
    assert.deepEqual(two.map(row => row.id), one.map(row => row.id), 'same place/date/text recapture updates the same rows');
    assert.deepEqual(two.map(row => row.parent_comment_id), one.map(row => row.parent_comment_id));
    assert.ok(two.every(row => row.seen_count > one.find(previous => previous.id === row.id).seen_count));
    const observations = await query('SELECT * FROM record_observations WHERE tenant_id=$1 ORDER BY id', [f.tenantId]);
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.find(row => row.id === observation.id).payload, evidenceBefore);
    assertCapturedObservation(observations.find(row => row.id !== observation.id), secondEvent);
    st.diagnostic(JSON.stringify({case: 'T14-author-uncertain', recordId: record.id, commentIds: two.map(row => row.id),
      externalCommentIds: two.map(row => row.external_comment_id), commentCount: two.length,
      parentIds: two.map(row => row.parent_comment_id), emptyAuthors: two.filter(row => row.author_name === '').length,
      observationIds: observations.map(row => row.id), receiptIds: [accepted.receipts[0].receiptId, later.receipts[0].receiptId],
      captureTimestamps: observations.map(row => row.payload.captureTimestamp), preservedOriginalObservation: true}));
    await f.complete(second);
  });

  await t.test('wrong attempts/tenants/platforms fail; late historical events keep a durable receipt and no false lease binding', async st => {
    const f = await fixture(st), other = await fixture(st);
    await parent(f);
    const first = (await f.poll()).task;
    await assert.rejects(send(f, {...eventFor(first), requestHash: 'f'.repeat(64)}), {code: 'ATTEMPT_LINEAGE_MISMATCH'});
    await assert.rejects(send(other, {...eventFor(first), agentId: other.phone.id}), {code: 'ATTEMPT_LINEAGE_MISMATCH'});
    const channel = {eventKind: 'wechat_post', ...first.identity, eventId: randomUUID(), capturedAt: new Date().toISOString(),
      link: {shareUrl: 'https://weixin.qq.com/sph/testabcd'}, preview: {createtime: Math.floor(Date.now()/1000)-100, nickname: '测试', description: 'wrong platform'}};
    await assert.rejects(send(f, channel), {code: 'ATTEMPT_LINEAGE_MISMATCH'});
    const event = eventFor(first);
    await f.complete(first, {status: 'interrupted', reason: 'lease_expired'});
    const second = (await f.poll()).task;
    assert.notEqual(second.identity.attemptId, first.identity.attemptId);
    assert.equal((await send(f, event)).receipts[0].status, 'accepted');
    const [observation] = await query('SELECT capture_task_item_attempt_id FROM record_observations WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(observation.capture_task_item_attempt_id, null);
    const outside = {...event, eventId: randomUUID(), capturedAt: new Date(Date.now()-3600_000).toISOString()};
    assert.equal((await send(f, outside)).receipts[0].reason, 'captured_outside_attempt');
    await f.complete(second);
  });

  await t.test('article prefilter uses the leased tenant, keyword and article platform', async st => {
    let seen;
    const f = await fixture(st, {prefilter: async input => { seen = input; return {items: []}; }});
    await parent(f, {planSnapshot: {captureSettings: {autoDetailCaptureAfterListCapture: true, enableAiRelevancePrefilter: true}}});
    const {task} = await f.poll();
    const response = await f.service.prefilter(f.principal, {requestId: randomUUID(), identity: task.identity,
      keyword: 'untrusted keyword', cards: [{cardId: 'a'.repeat(64), title: '文章标题', author: '公众号'}]});
    assert.equal(seen.tenantId, f.tenantId);
    assert.equal(seen.body.platform, 'wechat_articles');
    assert.equal(seen.body.keyword, '安吉星');
    assert.equal(response.items[0].executionDisposition, 'collect_full', 'missing model result fails open');
    await f.complete(task);
  });

  await t.test('a restricted article window rejects unknown time and minute/day intervals crossing its cutoff', async st => {
    const f = await fixture(st);
    await parent(f, {planSnapshot: {searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'all'}}});
    const {task} = await f.poll();
    const reference = new Date();
    reference.setUTCSeconds(30, 0);
    await query('UPDATE capture_tasks SET started_at=$2::timestamptz WHERE id=$1', [task.identity.taskId, reference.toISOString()]);
    const beijing = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
    const cutoff = beijing(reference.getTime() - 86400_000);
    for (const [precision, time] of [['unknown', ''], ['minute', cutoff], ['date', cutoff.slice(0, 10)]]) {
      const event = eventFor(task);
      Object.assign(event.article, {publishedAt: time, timePrecision: precision});
      const result = await send(f, event);
      assert.equal(result.receipts[0].status, 'rejected');
      assert.equal(result.receipts[0].reason, 'capture_publish_time_unverified');
    }
    assert.equal((await stored(f)).length, 0);
    const recent = eventFor(task);
    recent.article.publishedAt = beijing(reference.getTime() - 600_000);
    assert.equal((await send(f, recent)).receipts[0].status, 'accepted');
    await f.complete(task);
  });

  await t.test('negative article patrol revisits the canonical link and binds its observation to shared rotation state', async st => {
    const f = await fixture(st);
    const url = 'https://mp.weixin.qq.com/s/article_test_0001';
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,content,author_name,url,
      keyword,sentiment,business_visibility,publish_time,created_at)
      VALUES($1,$2,'wechat_articles','keyword_notes','安吉星服务文章','旧正文','测试公众号',$3,'安吉星','negative','eligible',
      '2026-11-08 10:32',now()-interval '1 day') RETURNING *`, [f.tenantId, articleExternalId(url), url]);
    const {normalizeUnattendedNegativePatrolScope, loadUnattendedNegativePatrolCandidates} = await import('../../../server/services/unattended-negative-patrol.js');
    const scope = normalizeUnattendedNegativePatrolScope({tenantId: f.tenantId, platforms: ['wechat_articles'], keywords: ['安吉星'], runStartedAt: new Date().toISOString()});
    const candidates = await withTransaction(tx => loadUnattendedNegativePatrolCandidates(tx, {...scope, persistCandidates: true}));
    assert.equal(candidates.candidates.length, 1);
    const parentId = await parent(f, {keywords: [], planSnapshot: {negativePatrol: {enabled: true, lookbackDays: 7}}});
    await query(`UPDATE capture_tasks SET metadata=metadata||jsonb_build_object('negativePatrolRun',$2::jsonb) WHERE id=$1`, [parentId, JSON.stringify(scope)]);
    const candidate = candidates.candidates[0];
    await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,record_id,external_id,
      url_snapshot,status,metadata,assignment_revision)
      VALUES($1,$2,$3,$4,0,'','wechat_articles','negative_post',$5,$6,$7,'pending',$8::jsonb,0)`,
    [randomUUID(), f.tenantId, parentId, `negative:wechat_articles:${candidate.externalId}`, candidate.recordId, candidate.externalId,
      candidate.url, JSON.stringify({unattendedNegativePatrol: true, sourceRecord: candidate.sourceRecord, baseline: candidate.baseline})]);
    assert.equal((await f.poll({features: []})).task, null);
    const {task} = await f.poll();
    assert.equal(task.mode, 'patrol');
    assert.equal(task.patrolTarget.platform, 'wechat_articles');
    assert.equal(task.patrolTarget.url, url);
    assert.equal(task.keyword, '安吉星服务文章');
    const result = await send(f, eventFor(task, {mode: 'patrol', rank: null}));
    assert.equal(result.receipts[0].recordId, record.id);
    await f.complete(task, {reason: 'patrol_preview'});
    const [item] = await query(`SELECT status,result_observation_id FROM capture_task_items WHERE tenant_id=$1 AND item_type='negative_post'`, [f.tenantId]);
    assert.equal(item.status, 'completed');
    assert.ok(item.result_observation_id);
    const [state] = await query('SELECT last_success_at, needs_action FROM unattended_negative_patrol_state WHERE tenant_id=$1', [f.tenantId]);
    assert.ok(state.last_success_at);
    assert.equal(state.needs_action, false);
  });

  await t.test('replays two real captures of the same links in one tenant', {
    skip: !process.env.WECHAT_ARTICLE_EVENT_FILES && 'Set WECHAT_ARTICLE_EVENT_FILES to comma-separated actual events.json paths (the same file may be replayed twice)',
  }, async st => {
    const paths = process.env.WECHAT_ARTICLE_EVENT_FILES.split(',').map(path => path.trim()).filter(Boolean);
    assert.ok(paths.length >= 2, 'at least two evidence files/attempts are required');
    const captures = [];
    for (const path of paths) {
      const bytes = await readFile(path), input = JSON.parse(bytes.toString('utf8'));
      const events = Array.isArray(input) ? input : input.events;
      assert.ok(Array.isArray(events) && events.length, 'each evidence file must contain actual captured events');
      assert.ok(events.every(event => event.eventKind === 'wechat_article' && Number.isFinite(Date.parse(event.capturedAt))));
      const links = events.map(event => canonicalArticleUrl(event.link?.shareUrl));
      assert.ok(links.every(Boolean));
      assert.equal(new Set(links).size, events.length, 'one file must contain one captured event per canonical link');
      captures.push({path, bytes, events, sha256: createHash('sha256').update(bytes).digest('hex')});
    }
    const urls = refuseEvidenceImageDownloads(captures.flatMap(capture => capture.events));
    const fetchStart = fetchedImages.length;
    const f = await fixture(st);
    await parent(f, {keywords: captures.map(() => '安吉星')});
    const attempts = new Set(), recordsByLink = new Map(), history = [], previousByLink = new Map();
    let repeatedLinks = 0, metricValueChanges = 0, protectedBodies = 0;
    for (const [captureIndex, capture] of captures.entries()) {
      const {task} = await f.poll();
      assert.ok(task, `file ${captureIndex + 1} must receive its own leased attempt`);
      assert.equal(task.identity.agentId, f.phone.id);
      assert.ok(!attempts.has(task.identity.attemptId)); attempts.add(task.identity.attemptId);
      // Historical evidence remains unchanged; only the isolated test lease window and identities move.
      const earliest = Math.min(...capture.events.map(event => Date.parse(event.capturedAt)));
      await query('UPDATE capture_task_item_attempts SET started_at=$2::timestamptz WHERE id=$1',
        [task.identity.attemptId, iso(earliest - 1000)]);
      const evidenceBefore = JSON.stringify(capture.events);
      for (let offset = 0; offset < capture.events.length; offset += 5) {
        const originals = capture.events.slice(offset, offset + 5);
        const batch = {uploadBatchId: randomUUID(), events: originals.map(event => ({...event, ...task.identity, eventId: randomUUID()}))};
        const first = await f.service.posts(f.principal, batch, persist);
        assert.equal(first.receipts.length, originals.length);
        await drain(f); await settleBackground();
        const replay = await f.service.posts(f.principal, batch, persist);
        assert.deepEqual(replay.receipts.map(receipt => receipt.receiptId), first.receipts.map(receipt => receipt.receiptId));
        assert.equal((await f.service.postReceipts(f.principal, batch.uploadBatchId)).receipts.length, originals.length);
        for (const [index, captured] of originals.entries()) {
          const receipt = first.receipts[index], url = canonicalArticleUrl(captured.link.shareUrl);
          assert.equal(receipt.status, 'accepted');
          const [record] = await query('SELECT * FROM records WHERE id=$1 AND tenant_id=$2', [receipt.recordId, f.tenantId]);
          assert.equal(record.url, url);
          assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1 AND url=$2', [f.tenantId, url])).length, 1);
          if (recordsByLink.has(url)) { repeatedLinks++; assert.equal(record.id, recordsByLink.get(url)); }
          else recordsByLink.set(url, record.id);
          const [observation] = await query(`SELECT o.* FROM record_observations o
            JOIN capture_mobile_post_receipts r ON r.observation_id=o.id WHERE r.id=$1 AND o.tenant_id=$2`, [receipt.receiptId, f.tenantId]);
          assert.ok(observation); assert.equal(observation.record_id, record.id);
          assert.equal(observation.capture_task_item_attempt_id, task.identity.attemptId);
          assert.ok(!history.some(item => item.id === observation.id), 'each file/link must create a new observation');
          assertCapturedObservation(observation, captured);
          const previous = previousByLink.get(url);
          if (previous) {
            metricValueChanges += metricKeys.some(key => previous.article.metrics[key].value !== observation.payload.wechatArticle.metrics[key].value) ? 1 : 0;
            const old = previous.recordArticle;
            const protect = (old.content || old.images?.length) && old.bodyStatus === 'complete'
              && (captured.article.bodyStatus !== 'complete' || (old.source === 'page_dom' && captured.article.source !== 'page_dom'));
            if (protect) {
              protectedBodies++;
              assert.equal(record.content, old.content);
              assert.equal(record.payload.wechatArticle.bodyStatus, 'complete');
              assert.equal(record.payload.wechatArticle.capturedAt, old.capturedAt);
            } else if (captured.article.bodyStatus === 'complete') {
              assert.equal(record.content, captured.article.content.normalize('NFC'), 'a complete newer DOM may legitimately be shorter');
            }
          }
          assert.equal(record.payload.wechatArticle.evidence.originalImagesCaptured, false);
          assert.equal((record.image_local_urls ?? []).length, 0, 'offline refusal cannot be claimed as image storage');
          assert.ok(record.payload.wechatArticle.images.every(image => image.stored === false && !image.localUrl));
          const comments = await query('SELECT content FROM record_comments WHERE tenant_id=$1 AND record_id=$2', [f.tenantId, record.id]);
          for (const item of captured.comments.items) assert.ok(comments.some(row => row.content === item.content.normalize('NFC').trim()));
          history.push({id: observation.id, evidence: observationEvidence(observation)});
          previousByLink.set(url, {article: observation.payload.wechatArticle, recordArticle: record.payload.wechatArticle});
          st.diagnostic(JSON.stringify({kind: 'real_capture_replay', capture: captureIndex + 1, file: capture.path, sha256: capture.sha256,
            tenantId: f.tenantId, agentId: f.phone.id, attemptId: task.identity.attemptId, url, recordId: record.id,
            observationId: observation.id, receiptId: receipt.receiptId,
            eventCapturedAt: iso(observation.payload.captureTimestamp), articleCapturedAt: observation.payload.wechatArticle.capturedAt,
            observationInsertedAt: iso(observation.captured_at),
            metrics: Object.fromEntries(metricKeys.map(key => [key, observation.payload.wechatArticle.metrics[key].value])),
            bodyStatus: captured.article.bodyStatus, imageDownloads: 'offline_refused'}));
        }
      }
      assert.equal(JSON.stringify(capture.events), evidenceBefore, 'replay cannot mutate the parsed source evidence');
      await f.complete(task);
      for (const original of history) {
        const [unchanged] = await query('SELECT * FROM record_observations WHERE id=$1', [original.id]);
        assert.deepEqual(observationEvidence(unchanged), original.evidence, 'later captures cannot rewrite prior observation metrics, times or body');
      }
    }
    assert.ok(repeatedLinks > 0, 'the supplied captures must share at least one canonical link');
    const records = await stored(f), observations = await query('SELECT id FROM record_observations WHERE tenant_id=$1', [f.tenantId]);
    const receipts = await query('SELECT id FROM capture_mobile_post_receipts WHERE tenant_id=$1', [f.tenantId]);
    const expectedObservations = captures.reduce((total, capture) => total + capture.events.length, 0);
    assert.equal(records.length, recordsByLink.size); assert.equal(observations.length, expectedObservations); assert.equal(receipts.length, expectedObservations);
    for (const capture of captures) assert.deepEqual(await readFile(capture.path), capture.bytes, 'original evidence file remains byte-identical');
    st.diagnostic(JSON.stringify({kind: 'real_capture_replay_summary', tenantId: f.tenantId, agentId: f.phone.id,
      files: captures.length, distinctEvidenceHashes: new Set(captures.map(capture => capture.sha256)).size,
      attempts: attempts.size, records: records.length, observations: observations.length, receipts: receipts.length,
      repeatedLinks, realMetricValueChangePairs: metricValueChanges, realBodyProtectionCases: protectedBodies,
      offlineImageRefusals: fetchedImages.slice(fetchStart).filter(item => urls.has(item.url)).length,
      liveImageDownloads: 0, sourceFilesUnchanged: true}));
  });

  await t.test('real phone evidence survives ingest and replay without replacing body, comments or metrics', {
    skip: !process.env.WECHAT_ARTICLE_EVENT_FILE && 'Set WECHAT_ARTICLE_EVENT_FILE to an actual phone events.json to run this acceptance step',
  }, async st => {
    const input = JSON.parse(await readFile(process.env.WECHAT_ARTICLE_EVENT_FILE, 'utf8'));
    const events = Array.isArray(input) ? input : input.events;
    assert.ok(Array.isArray(events) && events.length, 'evidence file must contain actual captured events');
    refuseEvidenceImageDownloads(events);
    const f = await fixture(st);
    await parent(f);
    const {task} = await f.poll();
    const times = events.map(event => Date.parse(event.capturedAt));
    assert.ok(times.every(Number.isFinite));
    // Fit only the isolated lease to historical evidence, never forge a new capture time.
    await query('UPDATE capture_task_item_attempts SET started_at=$2::timestamptz WHERE id=$1',
      [task.identity.attemptId, new Date(Math.min(...times)-1000).toISOString()]);
    for (const captured of events) {
      assert.equal(captured.eventKind, 'wechat_article');
      const event = {...captured, ...task.identity, eventId: randomUUID()};
      const batch = {uploadBatchId: randomUUID(), events: [event]};
      const first = await f.service.posts(f.principal, batch, persist);
      assert.equal(first.receipts[0].status, 'accepted');
      const [record] = await query('SELECT * FROM records WHERE id=$1', [first.receipts[0].recordId]);
      assert.equal(record.url, canonicalArticleUrl(captured.link.shareUrl));
      assert.equal(record.payload.wechatArticle.comments.status, captured.comments.status);
      assert.equal(record.payload.wechatArticle.latestCapture.bodyStatus, captured.article.bodyStatus);
      const [observation] = await query(`SELECT o.* FROM record_observations o JOIN capture_mobile_post_receipts r ON r.observation_id=o.id WHERE r.id=$1`, [first.receipts[0].receiptId]);
      assert.equal(observation.payload.wechatArticle.content, captured.article.content.normalize('NFC'));
      for (const key of ['read', 'like', 'share', 'recommend']) {
        assert.equal(observation.payload.wechatArticle.metrics[key].value, captured.article.metrics?.[key]?.value ?? null);
        assert.equal(observation.payload.wechatArticle.metrics[key].raw, captured.article.metrics?.[key]?.raw ?? '');
      }
      await drain(f);
      const comments = await query('SELECT content FROM record_comments WHERE tenant_id=$1 AND record_id=$2', [f.tenantId, record.id]);
      for (const item of captured.comments.items) assert.ok(comments.some(row => row.content === item.content.normalize('NFC').trim()));
      const replay = await f.service.posts(f.principal, batch, persist);
      assert.equal(replay.receipts[0].receiptId, first.receipts[0].receiptId);
      st.diagnostic(JSON.stringify({evidence: process.env.WECHAT_ARTICLE_EVENT_FILE, url: record.url,
        bodyStatus: captured.article.bodyStatus, commentsStatus: captured.comments.status,
        capturedComments: captured.comments.items.length, recordId: record.id, receiptId: first.receipts[0].receiptId}));
    }
    await f.complete(task);
  });
});
