import assert from 'node:assert/strict';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {collectCustomerDailyReport} from '../server/services/customer-daily-report-data.js';
import {customerDailyBusinessPeriod} from '../server/services/customer-daily-business-period.js';
import {MONTHLY_SUMMARY_FIELDS, monthlySummarySignature} from '../server/services/customer-daily-monthly-summary.js';
import {mergeCustomerDailySummary} from '../server/services/customer-daily-reports.js';
import {customerDailySummaryHeaders, customerDailySummaryRows} from '../server/services/customer-daily-report-presentation.js';
import {renderCustomerDailyReportHtml, renderCustomerDailyReportText, buildCustomerDailyReportWorkbook} from '../server/services/customer-daily-report-render.js';
import {renderCustomerDailySummaryPng, renderCustomerDailySummarySvg} from '../server/services/customer-daily-report-image.js';
import {buildFeishuDailyDocumentPlan, createFeishuDailyClient} from '../server/services/feishu-daily-report.js';

const HEADERS = ['舆情处理日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-负面处理流程', '负面-其他'];
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const instant = value => `${value}:00+08:00`;
const record = (n, seen, patch = {}) => ({id: id(n), first_seen_at: instant(seen), record_type: 'single_note',
  sentiment: 'negative', status: 'negative_cold', business_visibility: 'eligible', ...patch});
const countsFor = (snapshot, date) => snapshot.summary.rows.find(row => row.date === date).counts;

async function collect(date, records = [], {now = new Date(`${date}T19:00:00+08:00`)} = {}) {
  const businessPeriod = customerDailyBusinessPeriod(date, now);
  return collectCustomerDailyReport({tenantId: id(999), date, now, businessPeriod, db: {
    async queryOne(sql) {
      if (sql.includes('customer_daily:tenant')) return {name: '测试客户'};
      if (sql.includes('customer_daily:missing_published')) return {count: 0};
      if (sql.includes('customer_daily:audit_coverage')) return {applied_at: '2025-01-01T00:00:00Z'};
      throw new Error(`Unexpected queryOne ${sql}`);
    },
    async queryAll(sql) {
      if (sql.includes('customer_daily:month')) return records;
      if (/customer_daily:(heat_posts|cold_events|pending_capture)/.test(sql)) return [];
      throw new Error(`Unexpected queryAll ${sql}`);
    },
  }});
}

function assertMtdEqualsRows(snapshot) {
  for (const field of MONTHLY_SUMMARY_FIELDS) {
    assert.equal(snapshot.summary.mtd[field], snapshot.summary.rows.reduce((sum, row) => sum + row.counts[field], 0), field);
  }
}

test('nine exact headings expose disjoint negative handling buckets and count each post once', async () => {
  const time = '2026-09-10T12:00';
  const records = [
    record(1, time, {sentiment: 'positive', status: 'reviewed'}),
    record(2, time, {sentiment: 'neutral', status: 'reviewed'}),
    record(3, time), record(4, time, {status: 'negative_comment'}),
    record(5, time, {status: 'negative_feishu'}), record(6, time, {status: 'unavailable'}),
    record(7, time, {status: 'privacy_unreachable'}), record(8, time, {status: 'unhandled'}),
    record(9, time, {status: 'reviewed_non_monitor'}),
    record(10, time, {sentiment: 'positive', status: 'unavailable'}),
    record(11, time, {sentiment: 'neutral', status: 'privacy_unreachable'}),
    record(12, time, {sentiment: 'positive', status: 'negative_comment'}),
    record(13, time, {business_visibility: 'filtered_out'}), record(14, time, {record_type: 'official_content'}),
  ];
  const snapshot = await collect('2026-09-10', [...records, records[0], records[3]]);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.summary.format, 'daily_disposition_v2');
  assert.deepEqual(customerDailySummaryHeaders(snapshot), HEADERS);
  assert.equal(snapshot.summary.rows.length, 10);
  assert.deepEqual(MONTHLY_SUMMARY_FIELDS.map(field => snapshot.summary.day[field]), [12, 11, 3, 2, 1, 1, 1, 2]);
  assert.equal(snapshot.summary.day.negative, 6, 'unhandled negative remains classified, without inventing a handling category');
  assert.deepEqual(snapshot.summary.day, countsFor(snapshot, '2026-09-10'));
  assertMtdEqualsRows(snapshot);
});

test('18:00 boundaries are half-open and weekend collection appears only in the following Monday row', async () => {
  const records = [record(1, '2026-09-10T17:59'), record(2, '2026-09-10T18:00'),
    record(3, '2026-09-11T17:59'), record(4, '2026-09-11T18:00'),
    record(5, '2026-09-12T12:00'), record(6, '2026-09-13T12:00'),
    record(7, '2026-09-14T17:59'), record(8, '2026-09-14T18:00')];
  const friday = await collect('2026-09-11', records);
  const monday = await collect('2026-09-14', records);
  assert.equal(friday.summary.day.monitor, 2);
  assert.equal(friday.summary.mtd.monitor, 3);
  assert.equal(countsFor(monday, '2026-09-10').monitor, 1);
  assert.equal(countsFor(monday, '2026-09-11').monitor, 2);
  for (const date of ['2026-09-12', '2026-09-13']) {
    assert.equal(monday.summary.rows.find(row => row.date === date).isWorkingDay, false);
    assert.equal(countsFor(monday, date).monitor, 0);
    assert.deepEqual(customerDailySummaryRows(monday)[Number(date.slice(-2)) - 1].slice(1), Array(8).fill(null));
  }
  assert.equal(monday.summary.day.monitor, 4);
  assert.equal(monday.summary.mtd.monitor, 7);
  assertMtdEqualsRows(monday);
});

test('today before 18:00 includes only records already captured and does not fill the remaining window', async () => {
  const snapshot = await collect('2026-09-10', [record(1, '2026-09-09T18:00'),
    record(2, '2026-09-10T11:59'), record(3, '2026-09-10T12:00'), record(4, '2026-09-10T17:00')],
  {now: new Date('2026-09-10T12:00:00+08:00')});
  assert.equal(snapshot.summary.day.monitor, 2);
  assert.equal(snapshot.collectionCutoffAt, '2026-09-10T04:00:00.000Z');
  assertMtdEqualsRows(snapshot);
});

test('the official September 20 makeup workday owns Saturday data and its own pre-boundary collection', async () => {
  const snapshot = await collect('2026-09-21', [record(1, '2026-09-19T12:00'),
    record(2, '2026-09-20T17:59'), record(3, '2026-09-20T18:00')]);
  assert.equal(snapshot.summary.rows.find(row => row.date === '2026-09-20').isWorkingDay, true);
  assert.equal(countsFor(snapshot, '2026-09-19').monitor, 0);
  assert.equal(countsFor(snapshot, '2026-09-20').monitor, 2);
  assert.equal(countsFor(snapshot, '2026-09-21').monitor, 1);
  assert.equal(snapshot.summary.mtd.monitor, 3);
  assertMtdEqualsRows(snapshot);
});

test('month ownership carries the previous workday evening exactly once into the next month', async () => {
  const records = [record(1, '2026-08-31T17:59'), record(2, '2026-08-31T18:00'),
    record(3, '2026-09-01T17:59'), record(4, '2026-09-01T18:00')];
  const august = await collect('2026-08-31', records);
  const september = await collect('2026-09-01', records);
  assert.equal(august.summary.mtd.monitor, 1);
  assert.equal(september.summary.rows.length, 1);
  assert.equal(september.summary.day.monitor, 2);
  assert.deepEqual(september.evidence.dayRecordIds, [id(2), id(3)]);
  assert.equal(september.monthStart, '2026-08-31T10:00:00.000Z');
  assertMtdEqualsRows(september);
});

test('October holiday rows remain blank and all holiday records belong to October 8 including September carry-in', async () => {
  const records = [record(1, '2026-09-30T17:59'), record(2, '2026-09-30T18:00'),
    ...Array.from({length: 7}, (_, index) => record(index + 3, `2026-10-0${index + 1}T12:00`)),
    record(10, '2026-10-08T17:59'), record(11, '2026-10-08T18:00')];
  const snapshot = await collect('2026-10-08', records);
  assert.equal(snapshot.summary.rows.length, 8);
  for (const row of snapshot.summary.rows.slice(0, 7)) {
    assert.equal(row.isWorkingDay, false);
    assert.equal(row.counts.monitor, 0);
  }
  assert.equal(snapshot.summary.day.monitor, 9);
  assert.equal(snapshot.summary.mtd.monitor, 9);
  assert.equal(snapshot.monthStart, '2026-09-30T10:00:00.000Z');
  assertMtdEqualsRows(snapshot);
});

test('monthly edits accept only dated working-day quantities and calculate MTD without mutating the saved source', async () => {
  const snapshot = await collect('2026-09-14');
  const before = structuredClone(snapshot.summary);
  const patch = {rows: {
    '2026-09-01': {monitor: 10, sdb: 8, positive: 2, neutral: 1, cold: 1, comment: 1, negativeProcess: 1, negativeOther: 1},
    '2026-09-14': {monitor: 3, sdb: 3, comment: 2, negativeOther: 1},
  }};
  const result = mergeCustomerDailySummary(snapshot.summary, patch);
  assert.deepEqual(MONTHLY_SUMMARY_FIELDS.map(field => result.mtd[field]), [13, 11, 2, 1, 1, 3, 1, 2]);
  assert.deepEqual(result.day, result.rows.at(-1).counts);
  assert.deepEqual(snapshot.summary, before);
  assert.notEqual(monthlySummarySignature(result), monthlySummarySignature(before));
  for (const invalid of [null, [], {}, {day: {monitor: 1}}, {mtd: {monitor: 1}}, {rows: []}, {rows: {}},
    {rows: {'2026-09-12': {monitor: 1}}}, {rows: {'2026-09-15': {monitor: 1}}}, {rows: {'2026-08-31': {monitor: 1}}},
    {rows: {'2026-09-01': {negative: 1}}}, {rows: {'2026-09-01': {inProgress: 1}}}, {rows: {'2026-09-01': {}}},
    ...[-1, 0.1, null, '1', Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => ({rows: {'2026-09-01': {monitor: value}}})),
    {rows: {'2026-09-01': {sdb: 1}}}, {rows: {'2026-09-01': {monitor: 1, sdb: 1, positive: 1, comment: 1}}},
    {rows: {'2026-09-01': {monitor: Number.MAX_SAFE_INTEGER}, '2026-09-02': {monitor: 1}}},
  ]) assert.throws(() => mergeCustomerDailySummary(before, invalid), error => error.code === 'daily_summary_invalid', JSON.stringify(invalid));
});

test('legacy v1 summaries retain editable in-progress and processed fields and their eight-column exports', () => {
  const day = {monitor: 20, sdb: 20, positive: 3, neutral: 2, negative: 15, cold: 4, inProgress: null, processed: null};
  const before = {day: {...day}, mtd: {...day, monitor: 100, sdb: 100}};
  const edited = mergeCustomerDailySummary(before, {day: {inProgress: 0, processed: 5}, mtd: {inProgress: 10, processed: 8}});
  const snapshot = {schemaVersion: 1, reportDate: '2026-09-10', summary: edited};
  assert.deepEqual(customerDailySummaryHeaders(snapshot), ['日期', '监控数量', 'SDB范畴', '正向', '中性', '冷处理', '处理中', '已处理']);
  assert.deepEqual(customerDailySummaryRows(snapshot), [['9月10日', 20, 20, 3, 2, 4, 0, 5], ['MTD', 100, 100, 3, 2, 4, 10, 8]]);
  assert.equal(before.day.processed, null);
});

test('HTML, TSV, SVG/PNG, Excel and native Feishu table present identical nine-column rows', async () => {
  const snapshot = await collect('2026-09-14');
  snapshot.summary = mergeCustomerDailySummary(snapshot.summary, {rows: {'2026-09-14': {
    monitor: 101, sdb: 97, positive: 11, neutral: 12, cold: 13, comment: 14, negativeProcess: 15, negativeOther: 16,
  }}});
  const rows = customerDailySummaryRows(snapshot);
  const expected = [HEADERS, ...rows].map(row => row.map(value => value === null ? '' : String(value)));
  const html = renderCustomerDailyReportHtml(snapshot);
  const htmlRows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(match => [...match[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map(cell => cell[1]));
  assert.deepEqual(htmlRows, expected);
  const tsv = renderCustomerDailyReportText(snapshot).split('\n').filter(line => /^(?:舆情处理日期|2026\/|MTD\t)/.test(line));
  assert.deepEqual(tsv, expected.map(row => row.join('\t')));
  const svg = renderCustomerDailySummarySvg(snapshot);
  assert.deepEqual([...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(match => match[1]), expected.flat().filter(Boolean));
  const png = renderCustomerDailySummaryPng(snapshot);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(width, 1642);
  assert.equal(height, 84 + 62 * rows.length + 2);
  const idat = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  assert.equal(inflateSync(Buffer.concat(idat)).length, height * (width * 4 + 1));
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet('日报');
  assert.equal(sheet.columnCount, 9);
  assert.deepEqual(sheet.getRow(4).values.slice(1), HEADERS);
  rows.forEach((values, index) => values.forEach((value, column) => {
    const cell = sheet.getCell(index + 5, column + 1);
    if (values[0] === 'MTD' && column > 0) {
      assert.equal(cell.value.result, value);
      const letter = String.fromCharCode(65 + column);
      assert.equal(cell.value.formula, `SUM(${letter}5:${letter}${index + 4})`);
    } else assert.equal(cell.value, value, cell.address);
  }));
  const plan = buildFeishuDailyDocumentPlan(snapshot);
  const all = plan.batches.flatMap(batch => batch.descendants);
  const table = all.find(block => block.block_type === 31);
  assert.equal(table.table.property.row_size, rows.length + 1);
  assert.equal(table.table.property.column_size, 9);
  assert.equal(table.table.property.column_width.length, 9);
  assert.deepEqual(plan.merges, []);
  const blocks = new Map(all.map(block => [block.block_id, block]));
  const cells = table.children.map(cellId => blocks.get(blocks.get(cellId).children[0]).text.elements[0].text_run.content);
  assert.deepEqual(cells, expected.flat());
});

test('a full-month Feishu plan stays within API descendant limits and can be written and resumed without duplicating rows', async () => {
  const snapshot = await collect('2026-08-31');
  const plan = buildFeishuDailyDocumentPlan(snapshot);
  assert.ok(plan.batches.length > 1);
  for (const batch of plan.batches) {
    assert.ok(batch.descendants.length <= 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 160000);
  }
  const root = {block_id: 'doc_one', block_type: 1, children: []};
  const blocks = [root];
  let progress, sequence = 0, calls = 0, posts = 0;
  const ok = data => ({status: 200, json: async () => ({code: 0, data})});
  const client = createFeishuDailyClient({appId: 'test_app', appSecret: 'test_secret', documentBaseUrl: 'https://example.feishu.cn'}, {minWriteIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls++;
      const path = new URL(url).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return {status: 200, json: async () => ({code: 0, tenant_access_token: 'test_token', expire: 7200})};
      if (options.method === 'GET' && path.endsWith('/blocks')) return ok({items: structuredClone(blocks), has_more: false});
      assert.equal(options.method, 'POST');
      assert.ok(path.endsWith('/descendant'));
      posts++;
      const body = JSON.parse(options.body);
      assert.ok(body.descendants.length <= 1000);
      const relations = body.descendants.map(block => ({temporary_block_id: block.block_id, block_id: `remote_${sequence++}`}));
      const ids = new Map(relations.map(item => [item.temporary_block_id, item.block_id]));
      root.children.push(...body.children_id.map(id => ids.get(id)));
      blocks.push(...body.descendants.map(block => ({...structuredClone(block), block_id: ids.get(block.block_id), children: block.children.map(child => ids.get(child))})));
      return ok({block_id_relations: relations});
    },
  });
  const write = () => client.writeDocument({documentId: 'doc_one', snapshot, progress, onProgress: async value => {progress = structuredClone(value);}});
  assert.equal((await write()).done, true);
  assert.equal(posts, plan.batches.length);
  const table = blocks.find(block => block.block_type === 31);
  assert.equal(table.table.property.row_size, 33);
  assert.equal(table.children.length, 33 * 9);
  const before = calls;
  assert.equal((await write()).done, true);
  assert.equal(calls, before, 'a completed document is neither read nor appended again');
});
