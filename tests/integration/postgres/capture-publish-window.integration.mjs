import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {upsertCapturedRecord} from '../../../server/services/record-store.js';
import {normalizeRecord} from '../../../server/routes/sync.js';
import {createApp} from '../../../server/app.js';
import {prefilterRelevanceBatch} from '../../../server/services/relevance-prefilter.js';

test('saved search windows guard ingestion without changing patrol or customer edits', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool();
  const tenantIds = [];
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    try {
      await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
    } finally { await closePool(); }
  });
  for (const label of ['own', 'foreign']) {
    tenantIds.push((await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Publish window ${label} ${randomUUID()}`])).rows[0].id);
  }
  const [tenantId, foreignTenantId] = tenantIds;
  const reference = '2026-09-09T20:00:31.556Z';
  const createTask = async ({platform = 'xiaohongshu', window = 'day',
    type = 'unattended_keyword_capture', tenant = tenantId, parent = null,
    omitPlan = false} = {}) => (await pool.query(`
      INSERT INTO capture_tasks (tenant_id, platform, task_type, metadata, started_at, parent_task_id)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *
    `, [tenant, platform, type, JSON.stringify({executionMode: 'one_time',
      ...(omitPlan ? {} : {planSnapshot: {platform, keywords: ['车机'], searchFilters: {publishTime: window}}})}),
      reference, parent])).rows[0];
  const xhsTask = await createTask();
  const dyTask = await createTask({platform: 'douyin'});
  let counter = 0;
  const body = (task, date, {id, detailDate, extraPayload = {}, syncType = 'keyword_notes'} = {}) => {
    counter += 1;
    const externalId = id || (task.platform === 'douyin' ? `76000000000000${counter}`
      : randomUUID().replaceAll('-', '').slice(0, 24));
    const payload = {platform: task.platform, keyword: '车机',
      captureTimestamp: Date.parse('2026-09-09T20:05:00Z'),
      items: [{noteId: externalId, title: '测试采集', publishTime: date,
        publishDateRaw: date, publishDateSource: 'date_element'}],
      ...(detailDate ? {detailCaptureStatus: 'done',
        detailPayload: {noteId: externalId, publishTime: detailDate,
          captureTimestamp: Date.parse('2026-09-09T20:05:00Z')}} : {}), ...extraPayload};
    return {syncType, captureTaskId: task.id, payload};
  };
  const save = (input, overrides = {}) => {
    const record = normalizeRecord(input)[0];
    return upsertCapturedRecord(record, {tenantId, captureTaskId: record.captureTaskId, ...overrides});
  };
  const getRecord = async id => (await pool.query('SELECT * FROM records WHERE id = $1', [id])).rows[0];
  const count = async table => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].count);

  await t.test('2025 and early 2026 posts from both platforms create only rejection evidence', async () => {
    const before = await count('records');
    const observations = await count('record_observations');
    for (const task of [xhsTask, dyTask]) {
      for (const date of ['2025-09-10', '2026-01-18T04:10:00Z']) {
        const result = await save(body(task, date));
        assert.equal(result.action, 'skipped');
        assert.equal(result.id, null);
        assert.equal(result.retryable, false);
      }
    }
    assert.equal(await count('records'), before);
    assert.equal(await count('record_observations'), observations);
    assert.equal(await count('capture_task_events'), 4);
  });

  await t.test('window comes from task, keeps exact cutoff, boundary-day precision and delayed sync', async () => {
    for (const date of ['2026-09-08T20:00:31.556Z', '2026-09-09', '2026-09-10']) {
      const result = await save(body(xhsTask, date));
      assert.equal(result.action, 'inserted');
      assert.equal((await getRecord(result.id)).business_visibility, 'eligible');
    }
    const rejected = await save(body(dyTask, '2026-09-08T20:00:31.555Z', {
      extraPayload: {publishTimeWindow: 'all', searchFilters: {publishTime: 'all'}},
    }));
    assert.equal(rejected.action, 'skipped');
    assert.equal(rejected.publishWindowCheck.referenceTimestamp, Date.parse(reference));
  });

  await t.test('missing dates are preserved as unverified and cannot be invented from a title', async () => {
    const input = body(xhsTask, '');
    input.payload.items[0].title = '9-10月活动，2025年经验';
    const result = await save(input);
    const row = await getRecord(result.id);
    assert.equal(row.publish_time, '');
    assert.equal(row.business_visibility, 'eligible');
    assert.equal(row.payload.serverPublishWindow.status, 'unverified');
  });

  await t.test('detail dates override a fresh list date and hide only this run’s new untouched record', async () => {
    const input = body(xhsTask, '');
    const initial = await save(input);
    const externalId = normalizeRecord(input)[0].external_id;
    const detail = body(xhsTask, '2026-09-10', {id: externalId, detailDate: '2025-09-10'});
    assert.equal((await save(detail)).action, 'skipped');
    const row = await getRecord(initial.id);
    assert.equal(row.business_visibility, 'filtered_out');
    assert.equal(row.publish_time, '2025-09-10');
    assert.equal(row.payload.serverPublishWindow.status, 'out_of_range');
    // An older pending checkpoint and an ordinary patrol must not resurrect it.
    await save(input);
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    const patrol = await createTask({type: 'negative_post_patrol'});
    await save(body(patrol, '2025-09-10', {id: externalId, syncType: 'single_note',
      extraPayload: {detailCaptureStatus: 'done'}}));
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    const outcome = await prefilterRelevanceBatch({tenantId, body: {
      requestId: randomUUID(), idempotencyKey: randomUUID(), taskId: xhsTask.id,
      runId: 'late-analysis', keywordRunId: 'late-analysis', platform: 'xiaohongshu',
      stage: 'list', keyword: '车机', promptVersion: 'prefilter-list-v1', mode: 'disabled',
      items: [{itemId: externalId, externalId, title: '车机测试内容'}],
    }});
    assert.equal(outcome.items[0].executionDisposition, 'collect_full');
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    const nextTask = await createTask();
    assert.equal((await save(body(nextTask, '2026-09-10', {id: externalId}))).action, 'skipped');
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    // Corrected detail evidence may replace the established date.
    await save(body(xhsTask, '2026-09-10', {id: externalId, detailDate: '2026-09-10'}));
    assert.equal((await getRecord(initial.id)).payload.serverPublishWindow.status, 'in_range');
  });

  await t.test('the actual detail raw date wins over a conflicting normalized list field', async () => {
    const input = body(dyTask, '');
    const initial = await save(input);
    const detail = body(dyTask, '2026-09-10', {id: normalizeRecord(input)[0].external_id});
    detail.payload.detailCaptureStatus = 'done';
    detail.payload.detailPayload = {noteId: normalizeRecord(input)[0].external_id, publishDateRaw: '2025-10-05'};
    assert.equal(normalizeRecord(detail)[0].record_type, 'keyword_notes');
    assert.equal((await save(detail)).action, 'skipped');
    assert.equal((await getRecord(initial.id)).publish_time, '2025-10-05');
  });

  await t.test('concurrent pending list, detail and analysis writes cannot resurrect an excluded post', async () => {
    const input = body(xhsTask, '');
    const initial = await save(input);
    const externalId = normalizeRecord(input)[0].external_id;
    await Promise.all([
      save(body(xhsTask, '', {id: externalId, detailDate: '2025-09-10'})),
      save(input),
      prefilterRelevanceBatch({tenantId, body: {
        requestId: randomUUID(), idempotencyKey: randomUUID(), taskId: xhsTask.id,
        platform: 'xiaohongshu', stage: 'list', keyword: '车机',
        promptVersion: 'prefilter-list-v1', mode: 'disabled',
        items: [{itemId: externalId, externalId, title: '车机测试内容'}],
      }}),
    ]);
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    assert.equal((await getRecord(initial.id)).payload.serverPublishWindow.status, 'out_of_range');
  });

  await t.test('pre-existing history, operator edits and independent observations are protected', async () => {
    const allTask = await createTask({window: 'all'});
    const priorInput = body(allTask, '2025-09-10');
    const prior = await save(priorInput);
    const priorBefore = await getRecord(prior.id);
    assert.equal((await save({...priorInput, captureTaskId: xhsTask.id})).action, 'skipped');
    assert.deepEqual(await getRecord(prior.id), priorBefore);
    for (const protection of ['manual', 'triage', 'observation']) {
      const input = body(xhsTask, '');
      const initial = await save(input);
      if (protection === 'manual') await pool.query(`UPDATE records SET manual_updated_at = now() WHERE id = $1`, [initial.id]);
      if (protection === 'triage') await pool.query(`INSERT INTO record_triage (tenant_id, record_id) VALUES ($1, $2)`, [tenantId, initial.id]);
      if (protection === 'observation') await pool.query(`INSERT INTO record_observations (tenant_id, record_id) VALUES ($1, $2)`, [tenantId, initial.id]);
      const before = await getRecord(initial.id);
      const detail = body(xhsTask, '', {id: normalizeRecord(input)[0].external_id, detailDate: '2025-09-10'});
      assert.equal((await save(detail)).action, 'skipped');
      assert.deepEqual(await getRecord(initial.id), before, protection);
    }
  });

  await t.test('unlimited searches, standalone notes, patrols and foreign task IDs retain their path', async () => {
    for (const task of [await createTask({window: 'all'}),
      await createTask({type: 'negative_post_patrol'}),
      await createTask({tenant: foreignTenantId})]) {
      const result = await save(body(task, '2025-09-10'));
      assert.equal(result.action, 'inserted');
    }
    assert.equal((await save(body(xhsTask, '2025-09-10', {syncType: 'single_note'}))).action, 'inserted');
    const noTask = body(xhsTask, '2025-09-10');
    delete noTask.captureTaskId;
    assert.equal((await save(noTask)).action, 'inserted');
  });

  await t.test('half-year and no-filter choices release only the earlier time exclusion', async () => {
    const halfyear = await createTask({window: 'halfyear'});
    const all = await createTask({window: 'all'});
    const noFilter = await createTask({omitPlan: true});
    await pool.query(`UPDATE capture_tasks SET metadata = $2::jsonb WHERE id = $1`, [noFilter.id,
      JSON.stringify({planSnapshot: {platform: 'xiaohongshu', keywords: ['车机']}})]);
    for (const [task, date] of [[halfyear, '2026-05-15'], [all, '2025-09-10'], [noFilter, '2025-09-10']]) {
      const input = body(xhsTask, '');
      const initial = await save(input);
      const externalId = normalizeRecord(input)[0].external_id;
      assert.equal((await save(body(xhsTask, '', {id: externalId, detailDate: date}))).action, 'skipped');
      assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
      const result = await save(body(task, date, {id: externalId}));
      assert.equal(result.action, 'updated');
      const row = await getRecord(initial.id);
      assert.equal(row.business_visibility, 'eligible');
      assert.notEqual(row.payload.serverPublishWindow.status, 'out_of_range');
    }
    assert.equal((await save(body(halfyear, '2026-05-15'))).action, 'inserted');
    assert.equal((await save(body(halfyear, '2026-01-15'))).action, 'skipped');
    assert.equal((await save(body(all, '2025-01-15'))).action, 'inserted');
    for (const date of ['05-15', '编辑于 05-15']) {
      const input = body(xhsTask, '');
      const initial = await save(input);
      const externalId = normalizeRecord(input)[0].external_id;
      assert.equal((await save(body(xhsTask, '', {id: externalId, detailDate: date}))).action, 'skipped');
      assert.equal((await getRecord(initial.id)).publish_time, '', 'a latest-possible bound is not a real publication time');
      assert.equal((await save(body(halfyear, '', {id: externalId, detailDate: date}))).action, 'updated');
      assert.equal((await getRecord(initial.id)).business_visibility, 'eligible');
    }
  });

  await t.test('a child uses its saved parent plan and cannot accept a forged server marker', async () => {
    const child = await createTask({parent: xhsTask.id, omitPlan: true});
    assert.equal((await save(body(child, '2025-09-10'))).action, 'skipped');
    const all = await createTask({window: 'all'});
    const result = await save(body(all, '', {extraPayload: {serverPublishWindow: {
      originTaskId: xhsTask.id, status: 'out_of_range'}}}));
    assert.equal((await getRecord(result.id)).payload.serverPublishWindow, undefined);
  });

  await t.test('a new standalone capture can reopen an old time exclusion but an old replay cannot', async () => {
    const input = body(xhsTask, '');
    const initial = await save(input);
    const externalId = normalizeRecord(input)[0].external_id;
    await save(body(xhsTask, '', {id: externalId, detailDate: '2025-09-10'}));
    const replay = body(xhsTask, '2025-09-10', {id: externalId});
    delete replay.captureTaskId;
    await save(replay);
    assert.equal((await getRecord(initial.id)).business_visibility, 'filtered_out');
    const latest = await getRecord(initial.id);
    replay.payload.captureTimestamp = latest.payload.serverPublishWindow.checkedAt + 1;
    await save(replay);
    assert.equal((await getRecord(initial.id)).business_visibility, 'eligible');
    assert.equal((await getRecord(initial.id)).payload.serverPublishWindow.status, 'not_applicable');
  });

  await t.test('stale attempt rejection runs before any date-exclusion audit or mutation', async () => {
    const before = await count('capture_task_events');
    await assert.rejects(save(body(xhsTask, '2025-09-10'), {
      captureTaskItemAttemptId: randomUUID(), captureTaskItemRequestHash: 'a'.repeat(64),
    }), {code: 'stale_attempt'});
    assert.equal(await count('capture_task_events'), before);
  });

  await t.test('single and mixed batch HTTP responses expose terminal exclusions without blocking valid rows', async () => {
    const authCode = `PUBLISH-WINDOW-${randomUUID()}`;
    await pool.query(`INSERT INTO auth_codes (tenant_id, code, type, status)
      VALUES ($1, $2, 'permanent', 'active')`, [tenantId, authCode]);
    server = await new Promise(resolve => {
      const listener = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(listener));
    });
    const request = async (path, input) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync${path}`, {
        method: 'POST', headers: {'X-Auth-Code': authCode,
          'Content-Type': 'application/json'}, body: JSON.stringify(input),
      });
      return {status: response.status, body: await response.json()};
    };
    const single = await request('', body(dyTask, '2025-09-10'));
    assert.equal(single.status, 422);
    assert.equal(single.body.reason, 'capture_publish_time_out_of_range');
    assert.equal(single.body.retryable, false);
    const mixed = await request('/batch', {records: [
      {...body(xhsTask, '2025-09-10'), id: 'outside'},
      {...body(dyTask, '2026-09-10', {extraPayload: {detailCaptureStatus: 'filtered'}}), id: 'inside'},
    ]});
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.data.excluded, 1);
    assert.equal(mixed.body.data.inserted, 1);
    const [excluded, inserted] = mixed.body.data.items;
    assert.equal(excluded.ok, false);
    assert.equal(excluded.action, 'skipped');
    assert.equal(excluded.backendRecordId, null);
    assert.equal(excluded.commentStats, undefined);
    assert.equal(inserted.ok, true);
  });
});
