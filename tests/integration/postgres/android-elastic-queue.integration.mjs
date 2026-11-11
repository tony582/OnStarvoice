import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

test('phone elastic queue skips temporary blockers without changing them and settles permanent refusals', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  // Register the real orchestration projector used by the HTTP application.
  const {refreshOrchestrationParentTask} = await import('../../../server/routes/capture-cloud.js');
  const {registerOrchestrationParentProjector} = await import('../../../server/services/android-control/parent-refresh.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {normalizeUnattendedNegativePatrolScope, loadUnattendedNegativePatrolCandidates} =
    await import('../../../server/services/unattended-negative-patrol.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;

  async function fixture(st) {
    const [{id: tenantId}] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`queue-${randomUUID()}`]);
    st.after(async () => {
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
    const deviceId = `test-${randomUUID()}`, sessionId = randomUUID();
    const registered = await service.register({code, clientUuid: randomUUID(), deviceId});
    const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
    const principal = {tenantId, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
    const poll = (extra = {}) => service.poll(principal, {sessionId, deviceId, readyForSearch: true,
      platforms: ['wechat_channels', 'douyin', 'wechat_articles'], features: ['wechat_articles', 'wechat_forward'], ...extra});
    return {tenantId, service, phone, poll};
  }

  async function parent(f, {platform = 'wechat_channels', keywords = [], planSnapshot = {}} = {}) {
    const id = randomUUID();
    const metadata = {distributionMode: 'elastic_pool', eligibleAgentIds: [f.phone.id], claimUnit: 'keyword',
      executionMode: 'one_time', planSnapshot: {platform, keywords, searchFilters: {sort: 'latest', publishTime: 'day'},
        keywordMaxDetectedItems: 20, ...planSnapshot}};
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,
      trigger_type,status,metadata,orchestration_revision) VALUES($1::uuid,$2,$1::text,'capture_orchestration',
      'keyword_orchestration','队列回归',$3,'cloud','manual','running',$4,1)`, [id, f.tenantId, platform, metadata]);
    for (const [ordinal, keyword] of keywords.entries()) {
      await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,'keyword','pending',0)`,
      [randomUUID(), f.tenantId, id, `keyword:${ordinal}`, ordinal, keyword, platform]);
    }
    return id;
  }

  async function patrol(f) {
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,content,author_name,url,
        keyword,sentiment,business_visibility,publish_time,created_at)
      VALUES($1,$2,'wechat_channels','keyword_notes','差评','承诺更新不履约 #别克','队列回归',
        'https://weixin.qq.com/sph/ARLmfj5VbT','别克车机升级','negative','eligible',
        to_char(now()-interval '1 day','YYYY-MM-DD HH24:MI:SS'),now()-interval '1 day') RETURNING *`, [f.tenantId, randomUUID()]);
    const scope = normalizeUnattendedNegativePatrolScope({tenantId: f.tenantId, platforms: ['wechat_channels'],
      keywords: ['别克车机升级'], runStartedAt: new Date().toISOString()});
    const candidates = await withTransaction(tx => loadUnattendedNegativePatrolCandidates(tx, {...scope, persistCandidates: true}));
    assert.ok(candidates.candidates.some(candidate => candidate.recordId === record.id));
    const parentId = await parent(f, {planSnapshot: {negativePatrol: {enabled: true, lookbackDays: 7}}});
    await query(`UPDATE capture_tasks SET metadata=metadata || jsonb_build_object('negativePatrolRun',$2::jsonb) WHERE id=$1`,
      [parentId, JSON.stringify(scope)]);
    const itemId = randomUUID();
    await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,
        record_id,external_id,url_snapshot,status,assignment_revision)
      VALUES($1,$2,$3,$4,0,'','wechat_channels','negative_post',$5,$6,$7,'pending',0)`,
    [itemId, f.tenantId, parentId, `negative:${record.id}`, record.id, record.external_id, record.url]);
    return {record, parentId, itemId};
  }

  // Full rows retain timestamps, revisions, counters and metadata. The phone's
  // permitted heartbeat update is intentionally outside the candidate snapshot.
  async function snapshot(f, parentId = null) {
    const result = {};
    for (const [table, predicate] of [
      ['capture_tasks', 'AND (id=$2::uuid OR parent_task_id=$2::uuid)'],
      ['capture_task_items', 'AND task_id=$2::uuid'],
      ['capture_task_item_attempts', 'AND parent_task_id=$2::uuid'],
      ['unattended_negative_patrol_state', ''],
    ]) {
      const filter = parentId && predicate ? predicate : '';
      const order = table === 'unattended_negative_patrol_state' ? 'platform,external_id' : 'id';
      result[table] = await query(`SELECT row_to_json(row) AS value FROM ${table} row
        WHERE tenant_id=$1 ${filter} ORDER BY ${order}`, filter ? [f.tenantId, parentId] : [f.tenantId]);
    }
    return result;
  }

  for (const platform of ['wechat_channels', 'douyin']) {
    await t.test(`a cooling first patrol does not block later ${platform} keyword work`, async st => {
      const f = await fixture(st), head = await patrol(f);
      await query(`UPDATE unattended_negative_patrol_state SET cooldown_until=now()+interval '1 hour' WHERE record_id=$1`, [head.record.id]);
      const later = await parent(f, {platform, keywords: ['安吉星']});
      const before = await snapshot(f, head.parentId);
      const {task} = await f.poll();
      assert.equal(task?.keyword, '安吉星');
      assert.equal(task.platform, platform);
      const [child] = await query('SELECT parent_task_id FROM capture_tasks WHERE id=$1', [task.identity.taskId]);
      assert.equal(child.parent_task_id, later);
      assert.deepEqual(await snapshot(f, head.parentId), before, 'even patrol-state upsert timestamps must roll back');
    });
  }

  for (const reason of ['cooldown', 'already_claimed', 'record_busy', 'content_execution_active']) {
    await t.test(`all candidates temporarily blocked by ${reason}: null and no candidate changes`, async st => {
      const f = await fixture(st), head = await patrol(f);
      let lock;
      if (reason === 'cooldown') {
        await query(`UPDATE unattended_negative_patrol_state SET cooldown_until=now()+interval '1 hour' WHERE record_id=$1`, [head.record.id]);
      } else if (reason === 'already_claimed') {
        await query(`UPDATE unattended_negative_patrol_state SET lease_item_id=$2,lease_execution_task_id=$3,
          lease_assignment_revision=1,lease_started_at=now() WHERE record_id=$1`, [head.record.id, randomUUID(), randomUUID()]);
      } else if (reason === 'content_execution_active') {
        const activeId = randomUUID();
        await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status)
          VALUES($1::uuid,$2,$1::text,'negative_post_patrol','negative_post_patrol','其他巡查','wechat_channels','cloud','manual','running')`,
        [activeId, f.tenantId]);
        await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,execution_task_id,item_key,ordinal,keyword,
            platform,item_type,record_id,external_id,status,assignment_revision)
          VALUES($1,$2,$3,$3,'active',0,'','wechat_channels','negative_post',$4,$5,'running',1)`,
        [randomUUID(), f.tenantId, activeId, head.record.id, head.record.external_id]);
      } else {
        lock = await pool.connect();
        await lock.query('BEGIN');
        await lock.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
          [f.tenantId, `wechat_channels:${head.record.external_id}`]);
      }
      try {
        const before = await snapshot(f);
        assert.equal((await f.poll()).task, null);
        assert.deepEqual(await snapshot(f), before);
      } finally {
        if (lock) { await lock.query('ROLLBACK'); lock.release(); }
      }
    });
  }

  await t.test('an unsupported article plan leaves no changes and does not block a later Channels keyword', async st => {
    const f = await fixture(st);
    const first = await parent(f, {platform: 'wechat_articles', keywords: ['不支持的筛选'],
      planSnapshot: {searchFilters: {contentType: 'video'}}});
    await parent(f, {keywords: ['可采集']});
    const before = await snapshot(f, first);
    assert.equal((await f.poll()).task?.keyword, '可采集');
    assert.deepEqual(await snapshot(f, first), before);
  });

  await t.test('one poll examines at most 20 candidates and leaves all temporary refusals untouched', async st => {
    const f = await fixture(st);
    const blocked = await parent(f, {platform: 'wechat_articles', keywords: Array.from({length: 20}, (_, i) => `待支持-${i}`),
      planSnapshot: {searchFilters: {contentType: 'video'}}});
    await parent(f, {keywords: ['第二十一项']});
    const before = await snapshot(f);
    assert.equal((await f.poll()).task, null, 'the 21st item is outside this bounded claim attempt');
    assert.deepEqual(await snapshot(f), before);
    await query("UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{planSnapshot,searchFilters}', '{}'::jsonb) WHERE id=$1", [blocked]);
    assert.equal((await f.poll()).task?.keyword, '待支持-0', 'the original ordinal ordering is retained');
  });

  await t.test('a forward whose share link disappeared fails and settles its parent before the later keyword is claimed', async st => {
    const f = await fixture(st);
    const [record] = await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
      VALUES($1,$2,'wechat_channels','keyword_notes','转发目标','https://weixin.qq.com/sph/ARLmfj5VbT') RETURNING id`, [f.tenantId, randomUUID()]);
    await query("INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients','文件传输助手')", [f.tenantId]);
    const queued = await f.service.forward(f.tenantId, {recordId: record.id, recipients: ['文件传输助手']});
    const forwardId = queued.forwards[0].id;
    await query("UPDATE records SET url='' WHERE id=$1", [record.id]);
    await query("UPDATE capture_task_items SET url_snapshot='' WHERE task_id=$1", [forwardId]);
    await parent(f, {keywords: ['正常关键词']});
    const claim = await f.poll();
    assert.equal(claim.task?.keyword, '正常关键词');
    const [item] = await query('SELECT * FROM capture_task_items WHERE task_id=$1', [forwardId]);
    assert.equal(item.status, 'failed');
    assert.equal(item.error.code, 'RECORD_SHARE_LINK_MISSING');
    assert.equal(item.execution_task_id, null);
    assert.equal(item.attempt_count, 0);
    const [settled] = await query('SELECT * FROM capture_tasks WHERE id=$1', [forwardId]);
    assert.equal(settled.status, 'completed_with_failures');
    assert.equal(settled.counts.failed, 1);
    assert.equal(settled.counts.settled, 1);
    assert.equal(settled.progress.percent, 100);
    assert.ok(settled.finished_at);
    const [event] = await query(`SELECT payload FROM capture_task_events WHERE task_id=$1 AND event_type='orchestration_status_changed'`, [forwardId]);
    assert.equal(event.payload.childTaskId, '', 'settlement must not invent a child execution');
  });

  for (const reason of ['record_missing', 'archived']) {
    await t.test(`permanent patrol refusal ${reason} settles the parent without creating a child`, async st => {
      const f = await fixture(st), head = await patrol(f);
      if (reason === 'record_missing') await query('UPDATE capture_task_items SET record_id=NULL WHERE id=$1', [head.itemId]);
      else await query(`INSERT INTO record_triage(tenant_id,record_id,archived_at) VALUES($1,$2,now())`, [f.tenantId, head.record.id]);
      assert.equal((await f.poll()).task, null);
      const [item] = await query('SELECT * FROM capture_task_items WHERE id=$1', [head.itemId]);
      assert.equal(item.status, 'skipped');
      assert.equal(item.metadata.skipReason, reason);
      assert.equal(item.execution_task_id, null);
      assert.equal(item.attempt_count, 0);
      const [settled] = await query('SELECT * FROM capture_tasks WHERE id=$1', [head.parentId]);
      assert.equal(settled.status, 'completed_with_warnings');
      assert.equal(settled.counts.skipped, 1);
      assert.equal(settled.progress.percent, 100);
      assert.ok(settled.finished_at);
      assert.equal((await query('SELECT id FROM capture_tasks WHERE parent_task_id=$1', [head.parentId])).length, 0);
    });
  }

  await t.test('a SQL failure during parent settlement rolls back the item and parent and is not treated as a temporary refusal', async st => {
    const f = await fixture(st), head = await patrol(f);
    await query('UPDATE capture_task_items SET record_id=NULL WHERE id=$1', [head.itemId]);
    await parent(f, {keywords: ['不能在异常后继续领取']});
    const before = await snapshot(f);
    // This test file runs in its own process. Fail after the real projector has
    // written, proving that the item and projection share the claim transaction.
    registerOrchestrationParentProjector(async (tx, input) => {
      await refreshOrchestrationParentTask(tx, input);
      await tx.queryOne('SELECT * FROM android_queue_intentionally_missing_relation');
    });
    try {
      await assert.rejects(f.poll(), {code: '42P01'});
      assert.deepEqual(await snapshot(f), before);
    } finally {
      registerOrchestrationParentProjector(refreshOrchestrationParentTask);
    }
    assert.equal((await f.poll()).task?.keyword, '不能在异常后继续领取');
    const [settled] = await query('SELECT status FROM capture_tasks WHERE id=$1', [head.parentId]);
    assert.equal(settled.status, 'completed_with_warnings');
  });
});
