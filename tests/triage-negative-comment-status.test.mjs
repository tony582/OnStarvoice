import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const executable = text => text
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\n/gm, '')
  .replace(/^export default .*;$/gm, '')
  .replace(/^export /gm, '');
const tenantId = '00000000-0000-0000-0000-000000000001';
const recordIds = ['00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'];

function triageHarness() {
  let rows = recordIds.map(record_id => ({record_id, status: 'negative_cold', priority: 'normal', feishu_table_no: 'FS-1'}));
  let audits = [];
  const handlers = new Map();
  const router = {get() {}, post() {}, patch(path, ...callbacks) {handlers.set(path, callbacks.at(-1));}};
  const middleware = () => {};
  const context = vm.createContext({
    Router: () => router,
    requireTenantAccess: middleware, requireTenantWriter: middleware, requireSessionUser: middleware,
    getRecordLifecycle: async () => ({id: recordIds[0], archived_at: null}),
    getRecordLifecycles: async () => recordIds.map(id => ({id, archived_at: null})),
    withTransaction: async callback => {
      const pendingRows = structuredClone(rows);
      const pendingAudits = structuredClone(audits);
      const update = (row, status, priority, tableNo) => {
        if (status !== null) row.status = status;
        if (priority !== null) row.priority = priority;
        if (tableNo !== null) row.feishu_table_no = tableNo;
        return row;
      };
      const result = await callback({
        queryOne: async (sql, params) => {
          const row = pendingRows.find(item => item.record_id === params[1]);
          if (/SELECT \* FROM record_triage/.test(sql)) return structuredClone(row);
          assert.match(sql, /INSERT INTO record_triage/);
          return update(row, params[2], params[3], params[7]);
        },
        queryAll: async (sql, params) => {
          assert.equal(params[0], tenantId);
          const selected = pendingRows.filter(row => params[1].includes(row.record_id));
          if (/SELECT r.id AS record_id/.test(sql)) return structuredClone(selected);
          assert.match(sql, /INSERT INTO record_triage/);
          return selected.map(row => update(row, params[2], params[3], params[6]));
        },
        execute: async (sql, params) => {
          // A status selection may only append its normal audit event; there is
          // no comment-posting, ticket or patrol write in this path.
          assert.match(sql, /INSERT INTO audit_logs/);
          pendingAudits.push({sql, metadata: JSON.parse(params.at(-1))});
        },
      });
      rows = pendingRows;
      audits = pendingAudits;
      return result;
    },
  });
  vm.runInContext(executable(source('server/routes/triage.js')), context);
  return {
    context,
    rows: () => rows,
    audits: () => audits,
    async invoke(batch, body) {
      let result;
      let code = 200;
      const response = {status(value) {code = value; return this;}, json(value) {result = plain(value); return value;}};
      await handlers.get(batch ? '/records/batch' : '/records/:recordId')({
        tenantId, params: {recordId: recordIds[0]}, body,
        actorType: 'user', user: {id: tenantId}, actorName: '测试用户',
      }, response, error => {throw error;});
      return {code, result};
    },
  };
}

test('negative-comment single changes keep the usual audit and can transition back normally', async () => {
  const harness = triageHarness();
  let response = await harness.invoke(false, {status: 'negative_comment', note: '已在评论区留言'});
  assert.equal(response.code, 200);
  assert.equal(response.result.triage.status, 'negative_comment');
  assert.equal(response.result.triage.feishu_table_no, 'FS-1');
  assert.deepEqual(harness.audits().map(entry => [entry.metadata.previousStatus, entry.metadata.nextStatus, entry.metadata.note]), [
    ['negative_cold', 'negative_comment', '已在评论区留言'],
  ]);
  response = await harness.invoke(false, {priority: 'high'});
  assert.equal(response.result.triage.status, 'negative_comment');
  response = await harness.invoke(false, {status: 'reviewed'});
  assert.equal(response.result.triage.status, 'reviewed');
  assert.equal(harness.audits().at(-1).metadata.previousStatus, 'negative_comment');
});

test('negative-comment batch changes need no Feishu number and preserve previous audit values', async () => {
  const harness = triageHarness();
  const response = await harness.invoke(true, {ids: recordIds, status: 'negative_comment', note: '批量记录'});
  assert.equal(response.code, 200);
  assert.equal(response.result.updated, 2);
  assert.deepEqual(harness.rows().map(row => row.status), ['negative_comment', 'negative_comment']);
  assert.deepEqual(harness.rows().map(row => row.feishu_table_no), ['FS-1', 'FS-1']);
  const audit = harness.audits()[0];
  assert.match(audit.sql, /record.triage_batch_updated/);
  assert.equal(audit.metadata.status, 'negative_comment');
  assert.equal(audit.metadata.note, '批量记录');
  assert.equal(audit.metadata.previous[recordIds[0]].status, 'negative_cold');
  assert.equal((await harness.invoke(true, {ids: recordIds, status: 'reviewed'})).code, 200);
  assert.deepEqual(harness.rows().map(row => row.status), ['reviewed', 'reviewed']);
});

test('new status is accepted by list and analytics filters while unknown values stay rejected', () => {
  const {context} = triageHarness();
  context.params = [];
  assert.match(vm.runInContext("appendStatusFilter('WHERE true', params, ['negative_comment', 'negative_cold'])", context), /= ANY\(\$1::text\[\]\)/);
  assert.deepEqual(plain(context.params), [['negative_comment', 'negative_cold']]);
  assert.throws(() => vm.runInContext("appendStatusFilter('WHERE true', [], 'negative_comment_typo')", context), /无效值/);
  assert.match(vm.runInContext('TRIAGE_CONTENT_CONDITION', context), /'negative_comment'/);
  const analytics = vm.createContext({});
  vm.runInContext(executable(source('server/services/analytics-drilldown.js')), analytics);
  assert.equal(vm.runInContext("isValidAnalyticsDrilldownSelection('status', 'negative_comment')", analytics), true);
  assert.equal(vm.runInContext("VALUE_LABELS.status.negative_comment", analytics), '负面-评论区留言');
  assert.match(vm.runInContext('STATUS_SQL', analytics), /'negative_comment'/);
});

test('migration 082 adds only the new value without updating existing statuses or automation', () => {
  const migration = source('server/db/migrations/082_content_negative_comment_status.sql');
  const previous = source('server/db/migrations/064_content_privacy_unreachable_status.sql');
  const values = text => [...text.slice(text.indexOf('CHECK (status IN')).matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(values(migration), [...values(previous), 'negative_comment']);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS record_triage_status_check/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|INSERT|TRIGGER)\b/);
});

test('monthly workbook includes the ninth status and keeps the explanation below all data rows', async () => {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  const ExcelJS = require('exceljs');
  const context = vm.createContext({
    ExcelJS,
    RELEVANT_RECORD_SQL: 'true', PUBLISHED_RECORD_PERIOD_SQL: 'r.published_ts >= $2 AND r.published_ts < $3',
    queryOne: async () => ({name: '测试租户'}),
    queryAll: async sql => {
      assert.match(sql, /'negative_comment'/);
      return [{id: recordIds[0], platform: 'xiaohongshu', sentiment: 'negative', handling_status: 'negative_comment', published_ts: '2026-09-10T00:00:00Z'}];
    },
  });
  vm.runInContext(executable(source('server/services/analytics-workbook.js')), context);
  const workbook = await vm.runInContext(`buildAnalyticsWorkbook({tenantId: '${tenantId}',
    periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-10-01T00:00:00Z'),
    generatedAt: new Date('2026-09-10T00:00:00Z'), periodLabel: '2026年9月'})`, context);
  const sheet = workbook.getWorksheet('月报主体');
  assert.equal(sheet.getCell('I19').value, '负面-评论区留言');
  assert.equal(sheet.getCell('J19').value.result, 1);
  assert.match(sheet.getCell('J19').value.formula, /COUNTIF\('内容分诊数据源'!.*I19\)/);
  assert.equal(sheet.getCell('I6').value.result, 1);
  assert.match(sheet.getCell('A20').value, /^说明：/);
  assert.equal(sheet.getCell('I19').isMerged, false);
  const data = workbook.getWorksheet('内容分诊数据源');
  const header = data.getRow(1).values;
  const statusColumn = header.findIndex(value => value === '处理模式');
  assert.equal(data.getRow(2).getCell(statusColumn).value, '负面-评论区留言');
  // Round-trip through a real XLSX buffer catches merge/serialization issues.
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(reopened.getWorksheet('月报主体').getCell('I19').value, '负面-评论区留言');
});
