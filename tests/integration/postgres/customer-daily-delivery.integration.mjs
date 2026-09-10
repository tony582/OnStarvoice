import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { createCustomerDailyReportService } from '../../../server/services/customer-daily-reports.js';
import { resolvedDailyConfig } from '../../../server/services/customer-daily-report-config.js';
import { FeishuDailyError } from '../../../server/services/feishu-daily-report.js';

const { Pool } = createRequire(new URL('../../../server/package.json', import.meta.url))('pg');
const ENV = { CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY: '58'.repeat(32) };
const AT = '2026-09-08T02:00:00.000Z';
const CONFIG = { appId: 'cli_integration', appSecret: 'fake-app-secret-one', folderToken: 'folder_integration',
  documentBaseUrl: 'https://integration.feishu.cn', editorType: 'openid', editorId: 'ou_customer', channel: 'app', chatId: 'oc_group_one', chatName: '客户群一' };

function scopedDatabase(pool) {
  const api = connection => ({
    queryAll: async (sql, params = []) => (await connection.query(sql, params)).rows,
    queryOne: async (sql, params = []) => (await connection.query(sql, params)).rows[0] || null,
    execute: async (sql, params = []) => {
      const result = await connection.query(sql, params);
      return { rowCount: result.rowCount, changes: result.rowCount, rows: result.rows };
    },
  });
  return { ...api(pool), withTransaction: async (callback, options = {}) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (options.isolationLevel === 'repeatable_read') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      if (options.statementTimeoutMs) await client.query("SELECT set_config('statement_timeout',$1,true)", [String(options.statementTimeoutMs)]);
      if (options.lockTimeoutMs) await client.query("SELECT set_config('lock_timeout',$1,true)", [String(options.lockTimeoutMs)]);
      const result = await callback(api(client));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } };
}

function fakeSnapshot({ tenantId, date, businessPeriod }, monitor) {
  assert.equal(businessPeriod?.reportDate, date, 'service must pass its frozen business period to collection');
  assert.equal(businessPeriod?.mode, 'formal');
  const period = businessPeriod;
  const counts = { monitor, sdb: monitor, positive: monitor, neutral: 0, negative: 0, cold: 0,
    nonMonitor: 0, unclassified: 0, inProgress: null, processed: null };
  return { schemaVersion: 1, tenantId, tenantName: '集成测试客户', ...period,
    summary: { day: counts, mtd: counts }, highHeat: [], coldMarked: [], warnings: [], evidence: { mock: true } };
}

test('customer daily delivery persists ownership, checkpoints, schedules and tenant boundaries in PostgreSQL', async t => {
  const target = validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  const schema = `daily_delivery_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: target.rawUrl, max: 1 });
  let pool;
  let created = false;
  const originalFetch = globalThis.fetch;
  let outboundAttempts = 0;
  globalThis.fetch = async () => { outboundAttempts++; throw new Error('Outbound network is forbidden in delivery integration tests'); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    assert.equal(outboundAttempts, 0, 'all delivery I/O must use the injected mock client');
  });
  assert.match((await admin.query('SELECT current_database() AS name')).rows[0].name, /^onstarvoice_(?:ci|test)(?:_|$)/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  pool = new Pool({ connectionString: target.rawUrl, max: 12, options: `-c search_path=${schema},public` });
  await pool.query('CREATE TABLE tenants (LIKE public.tenants INCLUDING ALL)');
  await pool.query(await readFile(new URL('../../../server/db/migrations/081_customer_daily_reports.sql', import.meta.url), 'utf8'));
  const db = scopedDatabase(pool);

  async function fixture(subtest, { configured = true } = {}) {
    const tenant = await db.queryOne('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [`Daily delivery test ${randomUUID()}`]);
    subtest.after(() => db.execute('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const calls = [];
    const failures = {};
    let clock = new Date(AT);
    let monitor = 4;
    let warnings = [];
    const clientFactory = config => {
      const record = async (type, payload) => {
        calls.push({ type, config: { ...config }, ...payload });
        const failure = failures[type]?.shift();
        if (failure) throw failure;
      };
      return {
        createDocument: async ({ title }) => {
          const documentId = `doc_${randomUUID()}`;
          await record('create', { documentId, title });
          return { documentId, url: `${config.documentBaseUrl}/docx/${documentId}` };
        },
        writeDocument: async ({ documentId, snapshot, progress, onProgress }) => {
          assert.ok(!progress?.verified, 'permission progress must not be passed to the body adapter');
          await onProgress({ bodyPending: true });
          await record('write', { documentId, reportId: snapshot.id });
          const completed = { bodyDone: true };
          await onProgress(completed);
          return completed;
        },
        ensureEditable: async ({ documentId, progress, onProgress, verifyOnly }) => {
          if (verifyOnly) assert.equal(progress?.verified, true, 'send must reuse canonical permission checkpoint');
          else assert.ok(!progress?.bodyDone, 'body progress must not be passed to the permission adapter');
          await record(verifyOnly ? 'verify' : 'grant', { documentId });
          const result = { verified: true, editorId: config.editorId };
          if (onProgress) await onProgress(result);
          return { editable: true, retentionAllowed: true, progress: result };
        },
        sendReport: async ({ documentUrl, snapshot, uuid }) => {
          await record('send', { documentUrl, reportId: snapshot.id, uuid });
          return { messageId: `om_${uuid}` };
        },
      };
    };
    const options = { db, clientFactory, collect: args => ({ ...fakeSnapshot(args, monitor), warnings }), now: () => new Date(clock), env: ENV };
    const service = createCustomerDailyReportService(options);
    if (configured) {
      await service.saveSettings(tenant.id, CONFIG);
      await service.saveSettings(tenant.id, { customerEditVerified: true });
    }
    return { tenantId: tenant.id, service, calls, failures, clientFactory,
      restart: () => createCustomerDailyReportService(options), clock: value => { clock = new Date(value); },
      serviceWith: overrides => createCustomerDailyReportService({ ...options, ...overrides }),
      monitor: value => { monitor = value; }, counts: type => calls.filter(call => call.type === type).length,
      warnings: value => { warnings = value; },
      rawConfig: () => db.queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1', [tenant.id]) };
  }

  await t.test('immutable generated versions and concurrent idempotent request keys', async subtest => {
    const f = await fixture(subtest);
    const [first, duplicate] = await Promise.all([
      f.service.generate(f.tenantId, { date: '2026-09-07', requestId: 'same-request' }),
      f.service.generate(f.tenantId, { date: '2026-09-07', requestId: 'same-request' }),
    ]);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.reportDate, '2026-09-07');
    assert.equal(duplicate.reportDate, '2026-09-07');
    assert.equal(first.snapshot.reportDate, first.reportDate);
    assert.equal(first.version, 1);
    f.monitor(9);
    const changed = await f.service.generate(f.tenantId, { date: '2026-09-07', requestId: 'new-request' });
    assert.equal(changed.version, 2);
    assert.equal(changed.snapshot.summary.day.monitor, 9);
    assert.equal((await f.service.report(f.tenantId, first.id)).snapshot.summary.day.monitor, 4);
    const concurrent = await Promise.all([
      f.service.generate(f.tenantId, { date: '2026-09-04', requestId: 'concurrent-a' }),
      f.service.generate(f.tenantId, { date: '2026-09-04', requestId: 'concurrent-b' }),
    ]);
    assert.deepEqual(concurrent.map(r => r.version).sort(), [1, 2]);
    await assert.rejects(f.service.generate(f.tenantId, { date: '2026-09-04', requestId: 'same-request' }), /不同日期/);
    assert.equal(f.calls.length, 0);
  });

  await t.test('concurrent formal requests leave only the newest unsent owner; sent versions require correction', async subtest => {
    const f = await fixture(subtest);
    const a = await f.service.generate(f.tenantId, { requestId: 'formal-a' });
    const b = await f.service.generate(f.tenantId, { requestId: 'formal-b' });
    const results = await Promise.allSettled([
      f.service.enqueue(f.tenantId, a.id, { send: true }), f.service.enqueue(f.tenantId, b.id, { send: true }),
    ]);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code,'daily_delivery_stale');
    const active = await db.queryAll("SELECT report_id FROM customer_daily_deliveries WHERE tenant_id=$1 AND status='queued'",[f.tenantId]);
    assert.deepEqual(active.map(row=>row.report_id),[b.id]);
    await f.service.processDue();
    assert.equal(f.counts('send'),1);
    assert.equal(f.calls.find(call=>call.type==='send').reportId,b.id);
    const c = await f.service.generate(f.tenantId,{requestId:'formal-correction'});
    await assert.rejects(f.service.enqueue(f.tenantId,c.id,{send:true}),{code:'daily_delivery_correction_required'});
    assert.equal((await f.service.enqueue(f.tenantId,c.id,{send:true,correction:true})).id,c.id);
    await f.service.processDue();
    assert.equal(f.counts('send'),2);
    assert.equal((await db.queryOne('SELECT status FROM customer_daily_deliveries WHERE report_id=$1',[b.id])).status,'sent');
  });

  await t.test('a newer saved summary replaces every known-unsent state without rewriting the old document', async subtest => {
    for (const state of ['queued','retry_wait','needs_attention']) {
      const f = await fixture(subtest);
      const source = await f.service.generate(f.tenantId);
      await f.service.enqueue(f.tenantId,source.id,{send:true});
      await f.service.processDocument();
      if (state !== 'queued') {
        f.failures.send = [new FeishuDailyError('FEISHU_IMAGE_PERMISSION_MISSING','请启用上传图片权限',{needsAttention:state==='needs_attention',retryable:state==='retry_wait'})];
        await f.service.processMessage();
      }
      const before = await db.queryOne('SELECT document_id,progress FROM customer_daily_documents WHERE report_id=$1',[source.id]);
      assert.equal((await db.queryOne('SELECT status FROM customer_daily_deliveries WHERE report_id=$1',[source.id])).status,state);
      const edited = await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:2,inProgress:2},mtd:{positive:2,inProgress:2}}});
      assert.equal((await f.service.enqueue(f.tenantId,edited.id,{send:true})).id,edited.id);
      assert.equal((await db.queryOne('SELECT status FROM customer_daily_deliveries WHERE report_id=$1',[source.id])).status,'canceled');
      await f.service.processDue();
      assert.equal(f.calls.filter(call=>call.type==='send').at(-1).reportId,edited.id);
      assert.deepEqual(await db.queryOne('SELECT document_id,progress FROM customer_daily_documents WHERE report_id=$1',[source.id]),before);
      assert.equal(f.calls.filter(call=>call.type==='write' && call.reportId===source.id).length,1);
      assert.equal((await f.service.report(f.tenantId,edited.id)).snapshot.summary.day.inProgress,2);
    }
  });

  await t.test('replacement locks exclude message claims and only the edited version reaches the group', async subtest => {
    const f = await fixture(subtest);
    const source = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId,source.id,{send:true});
    await f.service.processDocument();
    const edited = await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:3,inProgress:1},mtd:{positive:3,inProgress:1}}});
    let locked, resume;
    const acquired = new Promise(resolve=>{locked=resolve;});
    const release = new Promise(resolve=>{resume=resolve;});
    const replacement = f.serviceWith({db:{...db,withTransaction:callback=>db.withTransaction(tx=>callback({...tx,queryAll:async(sql,params)=>{
      const result=await tx.queryAll(sql,params);
      if(sql.includes('FOR UPDATE OF d')) { locked(); await release; }
      return result;
    }}))}}).enqueue(f.tenantId,edited.id,{send:true});
    await acquired;
    try { assert.equal(await f.service.processMessage(),false); }
    finally { resume(); }
    await replacement;
    await f.service.processDue();
    assert.deepEqual(f.calls.filter(call=>call.type==='send').map(call=>call.reportId),[edited.id]);
  });

  await t.test('a worker that claims first blocks replacement; ambiguous or sent deliveries are never canceled', async subtest => {
    for (const state of ['working','ambiguous','sent']) {
      const f=await fixture(subtest);
      const source=await f.service.generate(f.tenantId);
      await f.service.enqueue(f.tenantId,source.id,{send:true});
      await f.service.processDocument();
      const edited=await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:3,inProgress:1},mtd:{positive:3,inProgress:1}}});
      let claimed, resume;
      const acquired=new Promise(resolve=>{claimed=resolve;});
      const release=new Promise(resolve=>{resume=resolve;});
      let worker;
      if(state==='working') {
        worker=f.serviceWith({clientFactory:config=>({...f.clientFactory(config),sendReport:async args=>{claimed();await release;return f.clientFactory(config).sendReport(args);}})}).processMessage();
        await acquired;
      } else {
        if(state==='ambiguous') f.failures.send=[new FeishuDailyError('FEISHU_RESULT_UNKNOWN','结果未知',{ambiguous:true})];
        await f.service.processMessage();
      }
      try { await assert.rejects(f.service.enqueue(f.tenantId,edited.id,{send:true}),{code:state==='sent'?'daily_delivery_correction_required':'daily_delivery_in_flight'}); }
      finally { if(worker) {resume();await worker;} }
      const old=await db.queryOne('SELECT status,ambiguous FROM customer_daily_deliveries WHERE report_id=$1',[source.id]);
      assert.equal(old.status,state==='ambiguous'?'needs_attention':'sent');
      assert.equal(old.ambiguous,state==='ambiguous');
      assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_deliveries WHERE report_id=$1',[edited.id])).count,0);
    }
  });

  await t.test('durable automatic occurrence and manual formal report share ownership', async subtest => {
    const f = await fixture(subtest);
    const manual = await f.service.generate(f.tenantId, { requestId: 'manual-owner' });
    await f.service.enqueue(f.tenantId, manual.id, { send: true });
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1", [f.tenantId]);
    await f.service.reserveOccurrences();
    await Promise.all([f.service.processOccurrences(), f.service.processOccurrences()]);
    await f.service.processDue();
    const occurrence = await db.queryOne('SELECT * FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(occurrence.report_id, manual.id);
    assert.equal(occurrence.status, 'enqueued');
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('send'), 1);
  });

  await t.test('automatic first delivery uses the latest customer-edited formal summary without collecting again', async subtest => {
    const f = await fixture(subtest);
    const source = await f.service.generate(f.tenantId,{requestId:'before-customer-edit'});
    const first = await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:3,inProgress:1},mtd:{positive:3,inProgress:1}},requestId:'customer-edit-one'});
    const latest = await f.service.saveSummary(f.tenantId,first.id,{summary:{day:{positive:2,inProgress:2},mtd:{positive:2,inProgress:2}},requestId:'customer-edit-two'});
    await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00'});
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1",[f.tenantId]);
    const automatic = f.serviceWith({collect:async()=>{throw new Error('Automatic delivery must not recalculate a saved customer summary');}});
    await automatic.processDue();
    const occurrence = await db.queryOne('SELECT status,report_id FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(occurrence.status,'enqueued');
    assert.equal(occurrence.report_id,latest.id);
    assert.equal(f.calls.find(call=>call.type==='send').reportId,latest.id);
    assert.equal(f.counts('send'),1);
    assert.equal((await f.service.report(f.tenantId,latest.id)).snapshot.summary.day.inProgress,2);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_reports WHERE tenant_id=$1',[f.tenantId])).count,3);
  });

  await t.test('automatic delivery replaces an older known-unsent version with the latest saved summary', async subtest => {
    for (const state of ['queued','retry_wait','needs_attention']) {
      const f=await fixture(subtest);
      const source=await f.service.generate(f.tenantId);
      await f.service.enqueue(f.tenantId,source.id,{send:true});
      await f.service.processDocument();
      if(state!=='queued') {
        f.failures.send=[new FeishuDailyError('FEISHU_IMAGE_PERMISSION_MISSING','上传权限未配置',{needsAttention:state==='needs_attention',retryable:state==='retry_wait'})];
        await f.service.processMessage();
      }
      const edited=await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:2,processed:2},mtd:{positive:2,processed:2}}});
      await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00'});
      await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1",[f.tenantId]);
      await f.serviceWith({collect:async()=>{throw new Error('Latest saved summary must be used without recollection');}}).processDue();
      const occurrence=await db.queryOne('SELECT report_id,status FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId]);
      assert.equal(occurrence.report_id,edited.id);
      assert.equal(occurrence.status,'enqueued');
      assert.equal((await db.queryOne('SELECT status FROM customer_daily_deliveries WHERE report_id=$1',[source.id])).status,'canceled');
      assert.equal(f.calls.filter(call=>call.type==='send').at(-1).reportId,edited.id);
      assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_reports WHERE tenant_id=$1',[f.tenantId])).count,2);
    }
  });

  await t.test('automatic reuse of a customer summary still respects its frozen incomplete-data gate', async subtest => {
    const f = await fixture(subtest);
    f.warnings([{code:'unclassified',message:'仍有待识别内容',blocking:true}]);
    const source = await f.service.generate(f.tenantId,{requestId:'incomplete-before-edit'});
    const edited = await f.service.saveSummary(f.tenantId,source.id,{summary:{day:{positive:3,inProgress:1},mtd:{positive:3,inProgress:1}},requestId:'incomplete-edited'});
    await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00'});
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1",[f.tenantId]);
    const automatic = f.serviceWith({collect:async()=>{throw new Error('Do not silently replace customer input or bypass its original warnings');}});
    await automatic.processDue();
    const occurrence = await db.queryOne('SELECT status,error_message,attempts FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(occurrence.status,'pending');
    assert.equal(occurrence.attempts,1);
    assert.match(occurrence.error_message,/待同步或待识别/);
    assert.equal(f.counts('create'),0);
    assert.equal(f.counts('send'),0);
    assert.equal((await f.service.report(f.tenantId,edited.id)).snapshot.summary.day.inProgress,1);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_reports WHERE tenant_id=$1',[f.tenantId])).count,2);
  });

  await t.test('today is formal immediately; later regeneration requires correction while the next workday has separate ownership', async subtest => {
    const f = await fixture(subtest);
    const today = await f.service.generate(f.tenantId, { date: '2026-09-08', requestId: 'today-formal' });
    assert.equal(today.mode, 'formal');
    assert.equal(today.snapshot.mode, 'formal');
    assert.equal(today.snapshot.collectionStartAt, '2026-09-07T10:00:00.000Z');
    assert.equal(today.snapshot.collectionCutoffAt, AT);
    await f.service.enqueue(f.tenantId, today.id, { send: true });
    await f.service.processDue();
    f.clock('2026-09-09T02:00:00Z');
    const regenerated = await f.service.generate(f.tenantId, { date: '2026-09-08', requestId: 'later-same-day' });
    assert.equal(regenerated.mode, 'formal');
    assert.notEqual(regenerated.id, today.id);
    await assert.rejects(f.service.enqueue(f.tenantId, regenerated.id, { send: true }), { code: 'daily_delivery_correction_required' });
    const next = await f.service.generate(f.tenantId, { requestId: 'next-workday' });
    assert.equal(next.reportDate, '2026-09-09');
    assert.equal(next.mode, 'formal');
    await f.service.enqueue(f.tenantId, next.id, { send: true });
    await f.service.processDue();
    assert.deepEqual(f.calls.filter(call => call.type === 'send').map(call => call.reportId), [today.id, next.id]);
    assert.equal((await f.service.report(f.tenantId, today.id)).snapshot.collectionCutoffAt, AT, 'later generation does not rewrite the delivered snapshot');
    assert.equal(f.counts('send'), 2);
  });

  await t.test('automatic occurrence records the actual manual owner when manual enqueue races automatic generation', async subtest => {
    const f = await fixture(subtest);
    const manual = await f.service.generate(f.tenantId, { requestId: 'manual-racing-auto' });
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1", [f.tenantId]);
    await f.service.reserveOccurrences();
    let notifyRead;
    let resumeRead;
    const readCompleted = new Promise(resolve => { notifyRead = resolve; });
    const continueRead = new Promise(resolve => { resumeRead = resolve; });
    const racing = f.serviceWith({ db: { ...db, queryOne: async (sql, params) => {
      const result = await db.queryOne(sql, params);
      if (sql.includes('FROM customer_daily_reports r JOIN customer_daily_deliveries d')) {
        assert.equal(result, null);
        notifyRead();
        await continueRead;
      }
      return result;
    } } });
    const automatic = racing.processOccurrences();
    await readCompleted;
    try { await f.service.enqueue(f.tenantId, manual.id, { send: true }); }
    finally { resumeRead(); }
    await automatic;
    await f.service.processDue();
    const occurrence = await db.queryOne('SELECT report_id,status FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(occurrence.report_id, manual.id);
    assert.equal(occurrence.status, 'enqueued');
    assert.equal(f.counts('send'), 1);
  });

  await t.test('one immutable document is shared across multiple group messages', async subtest => {
    const f = await fixture(subtest);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.service.processDue();
    await f.service.saveSettings(f.tenantId, { chatId: 'oc_group_two', chatName: '客户群二' });
    await f.service.saveSettings(f.tenantId, { customerEditVerified: true });
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.service.processDue();
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('write'), 1);
    const sends = f.calls.filter(call => call.type === 'send');
    assert.equal(sends.length, 2);
    assert.equal(new Set(sends.map(call => call.documentUrl)).size, 1);
    assert.deepEqual(sends.map(call => call.config.chatId).sort(), ['oc_group_one', 'oc_group_two']);
  });

  await t.test('concurrent restarted workers claim a document and its message only once', async subtest => {
    const f = await fixture(subtest);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await Promise.all([f.restart().processDue(), f.restart().processDue(), f.restart().processDue()]);
    assert.equal((await f.service.report(f.tenantId, report.id)).delivery.status, 'sent');
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('write'), 1);
    assert.equal(f.counts('send'), 1);
  });

  await t.test('known message failure retries only message with same UUID and preserves document', async subtest => {
    const f = await fixture(subtest);
    f.failures.send = [new FeishuDailyError('FEISHU_API_REJECTED', '模拟限流', { retryable: true })];
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.service.processDue();
    let delivery = await f.service.report(f.tenantId, report.id);
    assert.equal(delivery.delivery.status, 'retry_wait');
    assert.equal(delivery.delivery.ambiguous, false);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.service.processDue();
    delivery = await f.service.report(f.tenantId, report.id);
    assert.equal(delivery.delivery.status, 'sent');
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('write'), 1);
    assert.equal(f.counts('send'), 2);
    assert.equal(new Set(f.calls.filter(call => call.type === 'send').map(call => call.uuid)).size, 1);
  });

  await t.test('unknown create or send never automatically retries, including repeated user enqueue', async subtest => {
    for (const type of ['create', 'send']) {
      const f = await fixture(subtest);
      f.failures[type] = [new FeishuDailyError('FEISHU_RESULT_UNKNOWN', '模拟结果未知', { ambiguous: true })];
      const report = await f.service.generate(f.tenantId);
      await f.service.enqueue(f.tenantId, report.id, { send: true });
      await f.service.processDue();
      const current = await f.service.report(f.tenantId, report.id);
      assert.equal(current.delivery.status, 'needs_attention');
      assert.equal(current.delivery.ambiguous, true);
      assert.equal(current.delivery.canRetry, false);
      await f.service.enqueue(f.tenantId, report.id, { send: true });
      await f.restart().processDue();
      assert.equal(f.counts(type), 1);
    }
  });

  await t.test('expired working claim becomes attention without replaying create or send', async subtest => {
    const f = await fixture(subtest);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await db.execute("UPDATE customer_daily_documents SET status='working',phase='creating',claim_token=$2,claimed_at=now()-interval '20 minutes' WHERE report_id=$1", [report.id, randomUUID()]);
    await f.restart().processDue();
    const doc = await db.queryOne('SELECT status,ambiguous,claim_token FROM customer_daily_documents WHERE report_id=$1', [report.id]);
    assert.equal(doc.status, 'needs_attention');
    assert.equal(doc.ambiguous, true);
    assert.equal(doc.claim_token, null);
    assert.equal(f.calls.length, 0);
  });

  await t.test('expired message claim and a failed success checkpoint never replay a group send', async subtest => {
    for (const interrupted of ['expired_claim', 'failed_checkpoint']) {
      const f = await fixture(subtest);
      const report = await f.service.generate(f.tenantId);
      await f.service.enqueue(f.tenantId, report.id, { send: true });
      await f.service.processDocument();
      if (interrupted === 'expired_claim') {
        await db.execute("UPDATE customer_daily_deliveries SET status='working',claim_token=$2,claimed_at=now()-interval '20 minutes' WHERE report_id=$1", [report.id, randomUUID()]);
      } else {
        let failCheckpoint = true;
        const interruptedService = f.serviceWith({ db: { ...db, execute: async (sql, params) => {
          if (failCheckpoint && sql.includes("UPDATE customer_daily_deliveries SET status='sent'")) {
            failCheckpoint = false;
            throw new Error('Simulated local database checkpoint failure');
          }
          return db.execute(sql, params);
        } } });
        await interruptedService.processMessage();
      }
      await f.restart().processDue();
      const current = await f.service.report(f.tenantId, report.id);
      assert.equal(current.delivery.status, 'needs_attention');
      assert.equal(current.delivery.ambiguous, true);
      await f.service.enqueue(f.tenantId, report.id, { send: true });
      await f.restart().processDue();
      assert.equal(f.counts('send'), interrupted === 'expired_claim' ? 0 : 1);
      assert.equal(f.counts('write'), 1);
    }
  });

  await t.test('same-app secret rotation repairs existing document without replacing or rewriting it', async subtest => {
    const f = await fixture(subtest);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: false });
    await f.service.processDue();
    const original = (await f.service.report(f.tenantId, report.id)).delivery.documentId;
    await f.service.saveSettings(f.tenantId, { appSecret: 'fake-app-secret-two' });
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.service.processDue();
    assert.equal((await f.service.report(f.tenantId, report.id)).delivery.documentId, original);
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('write'), 1);
    assert.equal(f.calls.filter(call => call.type === 'verify').at(-1).config.appSecret, 'fake-app-secret-two');
    assert.equal(f.calls.filter(call => call.type === 'send').at(-1).config.appSecret, 'fake-app-secret-two');
  });

  await t.test('document owner/editor changes cannot silently rewrite or reassign already-created document', async subtest => {
    const f = await fixture(subtest);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id);
    await f.service.processDue();
    await f.service.saveSettings(f.tenantId, { editorId: 'ou_different_customer' });
    await f.service.saveSettings(f.tenantId, { customerEditVerified: true });
    await assert.rejects(f.service.enqueue(f.tenantId, report.id, { send: true }), error => error.code === 'daily_document_owner_changed');
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('write'), 1);
    assert.equal(f.counts('send'), 0);
  });

  await t.test('first enable begins next scheduled time; restart catches only dates missed since enable', async subtest => {
    const f = await fixture(subtest);
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    const first = await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(first.next_run_at.toISOString(), '2026-09-09T01:00:00.000Z');
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-09-11T02:00:00Z');
    const restarted = f.restart();
    for (let index = 0; index < 4; index++) await restarted.reserveOccurrences();
    const rows = await db.queryAll('SELECT report_date::text AS date FROM customer_daily_occurrences WHERE tenant_id=$1 ORDER BY report_date', [f.tenantId]);
    assert.deepEqual(rows.map(row => row.date), ['2026-09-09', '2026-09-10', '2026-09-11']);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-09-14T01:00:00.000Z');
    assert.equal(await restarted.reserveOccurrences(), 0);
    await restarted.processOccurrences();
    const generated = await db.queryAll(`SELECT o.report_date::text AS scheduled_date,r.report_date::text AS generated_date,r.snapshot->>'reportDate' AS snapshot_date
      FROM customer_daily_occurrences o JOIN customer_daily_reports r ON r.id=o.report_id AND r.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 ORDER BY o.report_date`, [f.tenantId]);
    assert.deepEqual(generated.map(row => row.generated_date), rows.map(row => row.date));
    for (const row of generated) assert.equal(row.snapshot_date, row.scheduled_date);
    await restarted.processDue();
    assert.equal(f.counts('send'), 3);
    await restarted.processDue();
    assert.equal(f.counts('send'), 3);
  });

  await t.test('PostgreSQL schedule reservations skip ordinary weekends and freeze Monday weekend coverage once', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-09-11T00:30:00Z');
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-09-11T02:00:00Z');
    assert.equal(await f.service.reserveOccurrences(), 1);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-09-14T01:00:00.000Z');
    for (const date of ['2026-09-12', '2026-09-13']) {
      f.clock(`${date}T02:00:00Z`);
      assert.equal(await f.restart().reserveOccurrences(), 0, date);
    }
    f.clock('2026-09-14T02:00:00Z');
    await Promise.all([f.restart().reserveOccurrences(), f.restart().reserveOccurrences()]);
    assert.equal(await f.service.reserveOccurrences(), 0);
    const occurrences = await db.queryAll('SELECT report_date::text AS date FROM customer_daily_occurrences WHERE tenant_id=$1 ORDER BY report_date', [f.tenantId]);
    assert.deepEqual(occurrences.map(row => row.date), ['2026-09-11', '2026-09-14']);
    await f.service.processDue();
    const reports = await db.queryAll('SELECT report_date::text AS date,mode,snapshot FROM customer_daily_reports WHERE tenant_id=$1 ORDER BY report_date', [f.tenantId]);
    assert.deepEqual(reports.map(row => row.date), ['2026-09-11', '2026-09-14']);
    assert.ok(reports.every(row => row.mode === 'formal' && row.snapshot.mode === 'formal'));
    assert.equal(reports[0].snapshot.collectionEndAt, reports[1].snapshot.collectionStartAt);
    assert.equal(reports[1].snapshot.collectionStartAt, '2026-09-11T10:00:00.000Z');
    assert.equal(reports[1].snapshot.collectionCutoffAt, '2026-09-14T02:00:00.000Z');
    assert.equal(reports[1].snapshot.handlingStartAt, '2026-09-11T16:00:00.000Z');
    assert.equal(f.counts('send'), 2);
    await f.restart().processDue();
    assert.equal(f.counts('send'), 2);
  });

  await t.test('PostgreSQL scheduling runs September 20 make-up Sunday and keeps Monday a separate occurrence', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-09-19T00:30:00Z');
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-09-20T01:00:00.000Z');
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-09-20T00:59:59Z');
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-09-20T01:00:00Z');
    assert.equal(await f.service.reserveOccurrences(), 1);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-09-21T01:00:00.000Z');
    await f.service.processDue();
    assert.equal(f.counts('send'), 1);
    f.clock('2026-09-21T02:00:00Z');
    await f.restart().processDue();
    const rows = await db.queryAll(`SELECT o.report_date::text AS date,o.status,r.snapshot
      FROM customer_daily_occurrences o JOIN customer_daily_reports r ON r.id=o.report_id AND r.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 ORDER BY o.report_date`, [f.tenantId]);
    assert.deepEqual(rows.map(row => row.date), ['2026-09-20', '2026-09-21']);
    assert.ok(rows.every(row => row.status === 'enqueued'));
    assert.equal(rows[0].snapshot.collectionStartAt, '2026-09-18T10:00:00.000Z');
    assert.equal(rows[0].snapshot.collectionEndAt, rows[1].snapshot.collectionStartAt);
    assert.equal(f.counts('send'), 2);
    await f.restart().processDue();
    assert.equal(f.counts('send'), 2);
  });

  await t.test('restart catches every missed workday across National Day without creating holiday reports or losing the holiday window', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-09-30T00:30:00Z');
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-10-10T02:00:00Z');
    const restarted = f.restart();
    let reserved = 0;
    for (let iteration = 0; iteration < 6; iteration++) reserved += await restarted.reserveOccurrences();
    assert.equal(reserved, 4);
    assert.equal(await restarted.reserveOccurrences(), 0);
    const dates = await db.queryAll('SELECT report_date::text AS date FROM customer_daily_occurrences WHERE tenant_id=$1 ORDER BY report_date', [f.tenantId]);
    assert.deepEqual(dates.map(row => row.date), ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-10']);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-10-12T01:00:00.000Z');
    await restarted.processDue();
    const reports = await db.queryAll(`SELECT o.report_date::text AS scheduled_date,o.status,r.report_date::text AS report_date,r.snapshot
      FROM customer_daily_occurrences o JOIN customer_daily_reports r ON r.id=o.report_id AND r.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 ORDER BY o.report_date`, [f.tenantId]);
    assert.equal(reports.length, 4);
    for (const row of reports) {
      assert.equal(row.status, 'enqueued');
      assert.equal(row.report_date, row.scheduled_date);
      assert.equal(row.snapshot.reportDate, row.scheduled_date);
      assert.equal(row.snapshot.mode, 'formal');
    }
    const holidayReport = reports.find(row => row.report_date === '2026-10-08').snapshot;
    assert.equal(holidayReport.collectionStartAt, '2026-09-30T10:00:00.000Z');
    assert.equal(holidayReport.collectionCutoffAt, '2026-10-08T10:00:00.000Z');
    assert.equal(holidayReport.monthStart, holidayReport.collectionStartAt);
    assert.equal(holidayReport.handlingStartAt, '2026-09-30T16:00:00.000Z');
    assert.equal(holidayReport.calendarRevision, 'china-work-calendar-v1:cn-mainland-2026-20251104-v1');
    for (let index = 1; index < reports.length; index++) assert.equal(reports[index - 1].snapshot.collectionEndAt, reports[index].snapshot.collectionStartAt);
    assert.equal(f.counts('send'), 4);
    await f.restart().processDue();
    assert.equal(f.counts('send'), 4);
  });

  await t.test('a legacy next-run timestamp inside a holiday advances to the next workday without losing its accumulated coverage', async subtest => {
    const f = await fixture(subtest);
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-10-01T01:00:00Z' WHERE tenant_id=$1", [f.tenantId]);
    f.clock('2026-10-07T02:00:00Z');
    assert.equal(await f.service.reserveOccurrences(), 1);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId])).count, 0);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at.toISOString(), '2026-10-08T01:00:00.000Z');
    assert.equal(await f.service.reserveOccurrences(), 0);
    f.clock('2026-10-08T02:00:00Z');
    await f.restart().processDue();
    const rows = await db.queryAll(`SELECT o.report_date::text AS date,o.status,r.snapshot
      FROM customer_daily_occurrences o JOIN customer_daily_reports r ON r.id=o.report_id AND r.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1`, [f.tenantId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, '2026-10-08');
    assert.equal(rows[0].status, 'enqueued');
    assert.equal(rows[0].snapshot.collectionStartAt, '2026-09-30T10:00:00.000Z');
    assert.equal(rows[0].snapshot.collectionCutoffAt, '2026-10-08T02:00:00.000Z');
    assert.equal(f.counts('send'), 1);
    await f.restart().processDue();
    assert.equal(f.counts('send'), 1);
  });

  await t.test('a reserved automatic occurrence freezes the collection boundary while public generation cannot inject one', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-09-08T00:30:00Z');
    await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00',collectionBoundaryTime:'18:00'});
    f.clock('2026-09-08T02:00:00Z');
    assert.equal(await f.service.reserveOccurrences(),1);
    await f.service.saveSettings(f.tenantId,{collectionBoundaryTime:'20:00'});
    const reserved = await db.queryOne('SELECT config FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(reserved.config.collectionBoundaryTime,'18:00');
    await f.restart().processDue();
    const automatic = await db.queryOne(`SELECT r.id,r.snapshot FROM customer_daily_occurrences o
      JOIN customer_daily_reports r ON r.id=o.report_id AND r.tenant_id=o.tenant_id WHERE o.tenant_id=$1`,[f.tenantId]);
    assert.equal(automatic.snapshot.collectionBoundaryTime,'18:00');
    assert.equal(automatic.snapshot.collectionStartAt,'2026-09-07T10:00:00.000Z');
    const publicReport = await f.service.generate(f.tenantId,{date:'2026-09-08',requestId:'manual-after-boundary-change',
      config:{collectionBoundaryTime:'12:00'},businessConfig:{collectionBoundaryTime:'12:00'},collectionBoundaryTime:'12:00'});
    assert.equal(publicReport.snapshot.collectionBoundaryTime,'20:00');
    assert.equal(publicReport.snapshot.collectionStartAt,'2026-09-07T12:00:00.000Z');
    assert.equal(f.service.generateWithBusinessConfig,undefined);
    assert.equal((await f.service.report(f.tenantId,automatic.id)).snapshot.collectionBoundaryTime,'18:00');
    assert.equal(f.counts('send'),1);
    await f.restart().processDue();
    assert.equal(f.counts('send'),1);
  });

  await t.test('missing next-year calendar preserves December 31 occurrence and does not block queued manual delivery', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-12-31T00:30:00Z');
    const manual = await f.service.generate(f.tenantId, {date:'2026-12-30',requestId:'year-end-manual'});
    await f.service.enqueue(f.tenantId,manual.id,{send:true});
    await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00'});
    f.clock('2026-12-31T02:00:00Z');
    await f.service.processDue();
    const occurrences = await db.queryAll('SELECT report_date::text AS date,status,report_id FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(occurrences.length,1);
    assert.equal(occurrences[0].date,'2026-12-31');
    assert.equal(occurrences[0].status,'enqueued');
    assert.equal((await f.service.report(f.tenantId,occurrences[0].report_id)).delivery.status,'sent');
    assert.equal((await f.service.report(f.tenantId,manual.id)).delivery.status,'sent');
    assert.equal(f.counts('send'),2);
    const stored = await db.queryOne('SELECT config,next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(stored.next_run_at.toISOString(),'2026-12-31T01:00:00.000Z','keep the durable retry cursor until the successor can be resolved');
    assert.equal(stored.config.calendarPending.year,2027);
    const visible = await f.service.settings(f.tenantId);
    assert.equal(visible.calendarPendingYear,2027);
    assert.match(visible.calendarError,/2027.*日历待更新/);
    assert.equal(visible.nextRunAt,null,'a retry cursor must not masquerade as the next send time');
    assert.equal(visible.lastAutomaticRun.date,'2026-12-31');
    assert.equal(visible.lastAutomaticRun.status,'enqueued');
    await f.restart().processDue();
    f.clock('2027-01-04T02:00:00Z');
    await f.restart().processDue();
    assert.equal(f.counts('send'),2);
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_occurrences WHERE tenant_id=$1',[f.tenantId])).count,1);
    await f.service.saveSettings(f.tenantId,{autoEnabled:false});
    assert.equal((await f.rawConfig()).config.calendarPending,undefined);
    assert.equal((await f.service.settings(f.tenantId)).calendarError,null);
  });

  await t.test('an unknown-year legacy cursor never fabricates an occurrence and leaves other tenant queues operational', async subtest => {
    const blocked = await fixture(subtest);
    const other = await fixture(subtest);
    const manual = await other.service.generate(other.tenantId,{requestId:'other-tenant-manual'});
    await other.service.enqueue(other.tenantId,manual.id,{send:true});
    await blocked.service.saveSettings(blocked.tenantId,{autoEnabled:true,sendTime:'09:00'});
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2027-01-01T01:00:00Z' WHERE tenant_id=$1",[blocked.tenantId]);
    blocked.clock('2027-01-04T02:00:00Z');
    // The worker is shared across tenants; every external effect remains the mock.
    await blocked.service.processDue();
    assert.equal((await db.queryOne('SELECT count(*)::int AS count FROM customer_daily_occurrences WHERE tenant_id=$1',[blocked.tenantId])).count,0);
    assert.equal((await blocked.service.settings(blocked.tenantId)).calendarPendingYear,2027);
    assert.equal((await other.service.report(other.tenantId,manual.id)).delivery.status,'sent');
    assert.equal(blocked.calls.filter(call=>call.type==='send' && call.reportId===manual.id).length,1);
    assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1',[blocked.tenantId])).next_run_at.toISOString(),'2027-01-01T01:00:00.000Z');
  });

  await t.test('a persisted waiting cursor resumes automatically once its year is present, retaining missed workdays without duplicates', async subtest => {
    const f = await fixture(subtest);
    f.clock('2026-09-11T00:30:00Z');
    await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'09:00'});
    // Model a cursor left by a previous runtime that lacked this now-loaded year.
    await db.execute("UPDATE customer_daily_report_settings SET config=jsonb_set(config,'{calendarPending}',$2::jsonb) WHERE tenant_id=$1",[f.tenantId,JSON.stringify({year:2026})]);
    f.clock('2026-09-14T02:00:00Z');
    assert.equal((await f.service.settings(f.tenantId)).calendarPendingYear,2026);
    await f.restart().processDue();
    assert.equal((await f.rawConfig()).config.calendarPending,undefined);
    assert.equal((await f.service.settings(f.tenantId)).calendarError,null);
    assert.equal((await f.service.settings(f.tenantId)).nextRunAt,'2026-09-14T01:00:00.000Z');
    await f.restart().processDue();
    const dates = await db.queryAll('SELECT report_date::text AS date,status FROM customer_daily_occurrences WHERE tenant_id=$1 ORDER BY report_date',[f.tenantId]);
    assert.deepEqual(dates.map(row=>row.date),['2026-09-11','2026-09-14']);
    assert.ok(dates.every(row=>row.status==='enqueued'));
    assert.equal(f.counts('send'),2);
    await f.restart().processDue();
    assert.equal(f.counts('send'),2);
    assert.equal((await f.service.settings(f.tenantId)).nextRunAt,'2026-09-15T01:00:00.000Z');
  });

  await t.test('ten calendar-blocked tenants cannot starve a new known-workday reservation behind the batch limit', async subtest => {
    for (let index=0;index<10;index++) {
      const f = await fixture(subtest);
      f.clock('2026-12-31T00:00:00Z');
      await f.service.saveSettings(f.tenantId,{autoEnabled:true,sendTime:'08:30'});
      await db.execute("UPDATE customer_daily_report_settings SET config=jsonb_set(config,'{calendarPending}',$2::jsonb) WHERE tenant_id=$1",[f.tenantId,JSON.stringify({year:2027})]);
    }
    const newest = await fixture(subtest);
    newest.clock('2026-12-31T00:30:00Z');
    await newest.service.saveSettings(newest.tenantId,{autoEnabled:true,sendTime:'09:00'});
    newest.clock('2026-12-31T02:00:00Z');
    assert.equal(await newest.service.reserveOccurrences(),10);
    const own = await db.queryAll('SELECT report_date::text AS date FROM customer_daily_occurrences WHERE tenant_id=$1',[newest.tenantId]);
    assert.deepEqual(own.map(row=>row.date),['2026-12-31']);
    assert.equal((await newest.service.settings(newest.tenantId)).calendarPendingYear,2027);
    assert.equal(newest.calls.length,0,'reservation alone must not contact Feishu');
  });

  await t.test('disabling automatic sends cancels pending or retry work, preserves manual work, and allows explicit manual recovery', async subtest => {
    for (const stage of ['pending_occurrence', 'queued_document', 'retry_message']) {
      const f = await fixture(subtest);
      await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
      await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1", [f.tenantId]);
      await f.service.reserveOccurrences();
      if (stage !== 'pending_occurrence') await f.service.processOccurrences();
      if (stage === 'retry_message') {
        f.failures.send = [new FeishuDailyError('FEISHU_API_REJECTED', '模拟限流', { retryable: true })];
        await f.service.processDue();
      }
      const automatic = await db.queryOne('SELECT report_id FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId]);
      const manual = await f.service.generate(f.tenantId, { date: '2026-09-04' });
      await f.service.enqueue(f.tenantId, manual.id, { send: true });
      const sentBeforeDisable = f.calls.filter(call => call.type === 'send' && call.reportId === automatic.report_id).length;
      await f.service.saveSettings(f.tenantId, { autoEnabled: false });
      await f.restart().processDue();
      assert.equal((await f.service.report(f.tenantId, manual.id)).delivery.status, 'sent');
      assert.equal(f.calls.filter(call => call.type === 'send' && call.reportId === automatic.report_id).length, sentBeforeDisable);
      assert.equal((await db.queryOne('SELECT next_run_at FROM customer_daily_report_settings WHERE tenant_id=$1', [f.tenantId])).next_run_at, null);
      if (automatic.report_id) {
        const delivery = await db.queryOne('SELECT status,automatic FROM customer_daily_deliveries WHERE report_id=$1', [automatic.report_id]);
        assert.equal(delivery.status, 'canceled');
        assert.equal(delivery.automatic, true);
        await f.service.enqueue(f.tenantId, automatic.report_id, { send: true });
        await f.restart().processDue();
        assert.equal((await f.service.report(f.tenantId, automatic.report_id)).delivery.status, 'sent');
        assert.equal(f.calls.filter(call => call.type === 'write' && call.reportId === automatic.report_id).length, 1);
      } else {
        assert.equal((await db.queryOne('SELECT status FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId])).status, 'canceled');
        assert.equal(f.counts('create'), 1, 'only the explicitly requested manual report creates a document');
      }
    }
  });

  await t.test('automatic occurrence reuses a sent manual version with its explicit incomplete-data decision', async subtest => {
    const f = await fixture(subtest);
    f.warnings([{ code: 'pending_data', blocking: true, message: '待处理内容' }]);
    const manual = await f.service.generate(f.tenantId);
    await assert.rejects(f.service.enqueue(f.tenantId, manual.id, { send: true }), error => error.code === 'daily_data_incomplete');
    await f.service.enqueue(f.tenantId, manual.id, { send: true, allowIncomplete: true });
    await f.service.processDue();
    await f.service.saveSettings(f.tenantId, { autoEnabled: true, sendTime: '09:00' });
    await db.execute("UPDATE customer_daily_report_settings SET next_run_at='2026-09-08T01:00:00Z' WHERE tenant_id=$1", [f.tenantId]);
    await f.restart().processDue();
    const occurrence = await db.queryOne('SELECT report_id,status,error_message FROM customer_daily_occurrences WHERE tenant_id=$1', [f.tenantId]);
    assert.equal(occurrence.report_id, manual.id);
    assert.equal(occurrence.status, 'enqueued');
    assert.equal(occurrence.error_message, null);
    assert.equal((await f.service.list(f.tenantId)).length, 1);
    assert.equal(f.counts('send'), 1);
    assert.equal(f.counts('write'), 1);
  });

  await t.test('explicit manual sending does not fabricate customer acceptance and still verifies permissions', async subtest => {
    const f = await fixture(subtest, { configured: false });
    await f.service.saveSettings(f.tenantId, CONFIG);
    assert.equal((await f.rawConfig()).config.customerEditVerified, false);
    const report = await f.service.generate(f.tenantId);
    await Promise.all([
      f.service.enqueue(f.tenantId, report.id, { send: true }),
      f.service.enqueue(f.tenantId, report.id, { send: true }),
    ]);
    await f.service.processDue();
    assert.equal((await f.service.report(f.tenantId, report.id)).delivery.status, 'sent');
    assert.equal(f.counts('create'), 1);
    assert.equal(f.counts('grant'), 1);
    assert.equal(f.counts('verify'), 1);
    assert.equal(f.counts('send'), 1);
    assert.deepEqual(f.calls.filter(call => ['grant','verify','send'].includes(call.type)).map(call => call.type), ['grant','verify','send']);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    await f.restart().processDue();
    assert.equal(f.counts('send'), 1, 'Repeated explicit requests must not duplicate the group message');
    const config = (await f.rawConfig()).config;
    assert.equal(config.customerEditVerified, false);
    assert.equal(config.autoEnabled, false);
  });

  await t.test('unverified manual delivery never sends when either permission grant or final verification fails', async subtest => {
    for (const phase of ['grant', 'verify']) {
      const f = await fixture(subtest, { configured: false });
      await f.service.saveSettings(f.tenantId, CONFIG);
      const report = await f.service.generate(f.tenantId);
      if (phase === 'verify') {
        await f.service.enqueue(f.tenantId, report.id);
        await f.service.processDue();
        assert.equal((await f.service.report(f.tenantId, report.id)).delivery.status, 'document_ready');
      }
      f.failures[phase] = [new FeishuDailyError('FEISHU_PERMISSION_REQUIRED', '客户编辑或留存权限验证失败', { needsAttention: true })];
      await f.service.enqueue(f.tenantId, report.id, { send: true });
      await f.service.processDue();
      const current = await f.service.report(f.tenantId, report.id);
      assert.equal(current.delivery.status, 'needs_attention');
      assert.match(current.delivery.error, /权限验证失败/);
      assert.equal((await f.service.list(f.tenantId))[0].delivery.status, 'needs_attention', 'A blocked document must take precedence over a still-queued message');
      assert.equal(f.counts('send'), 0);
      await f.restart().processDue();
      assert.equal(f.counts('send'), 0);
      assert.equal((await f.rawConfig()).config.customerEditVerified, false);
    }
  });

  await t.test('customer acceptance remains required to enable or enqueue automatic sending', async subtest => {
    const f = await fixture(subtest, { configured: false });
    await f.service.saveSettings(f.tenantId, CONFIG);
    const report = await f.service.generate(f.tenantId);
    await assert.rejects(f.service.saveSettings(f.tenantId, { autoEnabled: true }), { code: 'daily_customer_edit_verification_required' });
    await assert.rejects(f.service.enqueue(f.tenantId, report.id, { send: true, automatic: true }), { code: 'daily_customer_edit_verification_required' });
    assert.equal((await f.rawConfig()).config.autoEnabled, false);
    assert.equal((await f.rawConfig()).config.customerEditVerified, false);
    assert.equal(Number((await db.queryOne('SELECT count(*) FROM customer_daily_documents WHERE tenant_id=$1', [f.tenantId])).count), 0);
    assert.equal(Number((await db.queryOne('SELECT count(*) FROM customer_daily_deliveries WHERE tenant_id=$1', [f.tenantId])).count), 0);
    assert.equal(f.calls.length, 0);
  });

  await t.test('an already-queued automatic message with unverified frozen configuration is blocked again by the worker', async subtest => {
    const f = await fixture(subtest, { configured: false });
    await f.service.saveSettings(f.tenantId, CONFIG);
    const report = await f.service.generate(f.tenantId);
    await f.service.enqueue(f.tenantId, report.id, { send: true });
    // Simulate a legacy or interrupted automatic queue entry to exercise the
    // worker boundary independently from the enqueue/configuration boundaries.
    await db.execute('UPDATE customer_daily_deliveries SET automatic=true WHERE tenant_id=$1 AND report_id=$2', [f.tenantId, report.id]);
    await f.service.processDue();
    assert.equal(f.counts('send'), 0);
    assert.equal(f.counts('verify'), 0);
    assert.match((await f.service.report(f.tenantId, report.id)).delivery.error, /自动发送前/);
    assert.equal((await f.rawConfig()).config.customerEditVerified, false);
  });

  await t.test('tenant report/config isolation and composite delivery foreign keys hold', async subtest => {
    const a = await fixture(subtest);
    const b = await fixture(subtest);
    const report = await a.service.generate(a.tenantId, { requestId: 'tenant-key' });
    assert.equal(await b.service.report(b.tenantId, report.id), null);
    assert.deepEqual(await b.service.list(b.tenantId), []);
    await assert.rejects(b.service.enqueue(b.tenantId, report.id, { send: true }), error => error.status === 404);
    const independent = await b.service.generate(b.tenantId, { requestId: 'tenant-key' });
    assert.notEqual(independent.id, report.id);
    const configA = (await a.rawConfig()).config;
    assert.equal(JSON.stringify(configA).includes('fake-app-secret-one'), false);
    assert.equal(resolvedDailyConfig(configA, a.tenantId, ENV).appSecret, 'fake-app-secret-one');
    assert.throws(() => resolvedDailyConfig(configA, b.tenantId, ENV), /无法解密/);
    await assert.rejects(db.execute('INSERT INTO customer_daily_documents (report_id,tenant_id,config) VALUES ($1,$2,$3)', [report.id,b.tenantId,{}]), error => error.code === '23503');
    const visible = await a.service.settings(a.tenantId);
    assert.equal(visible.hasAppSecret, true);
    assert.equal(visible.appSecret, undefined);
    assert.equal(JSON.stringify(visible).includes('Encrypted'), false);
  });
});
