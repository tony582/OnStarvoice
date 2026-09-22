import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomerDailyReportWorkbook, renderCustomerDailyReportHtml, renderCustomerDailyReportText, renderCustomerDailyReportMessageHtml, renderCustomerDailyReportMessageText } from '../server/services/customer-daily-report-render.js';
import { customerDailySummaryRows, customerDailyPostComparison, customerDailyColdTitle, customerDailyPostStatus } from '../server/services/customer-daily-report-presentation.js';
import {collectionHandlingSnapshot} from './fixtures/customer-daily-v5.mjs';
import {buildFeishuDailyDocumentPlan} from '../server/services/feishu-daily-report.js';
import {buildFeishuDailyPost} from '../server/services/feishu-daily-report-message.js';

function fixture() {
  const counts = {monitor: 126, sdb: 112, positive: 16, neutral: 75, negative: 18, cold: 8, inProgress: null, processed: null};
  const post = {title: '客户讨论 <更新> & 服务', platform: 'xiaohongshu', url: 'https://example.test/post?a=1&b=2', heat: 320, comparisonText: '', observedAt: '2026-09-07T12:00:00Z', previousObservedAt: '2026-09-06T12:00:00Z', quality: 'legacy_unverified', timeSource: 'ingested_at', stale: true, status: 'unavailable'};
  return {tenantName: '示例客户', reportDate: '2026-09-07', mode: 'formal', cutoffAt: '2026-09-07T16:00:00Z', assessedAt: '2026-09-08T01:00:00Z', summary: {day: {...counts}, mtd: {...counts}}, highHeat: [post], coldMarked: [{...post, markedAt: '2026-09-07T11:00:00Z'}], warnings: [{message: '内部核对事项：观测质量与标记记录待确认', blocking: true}], evidence: {cold: {coverageComplete: false}}};
}

test('every report export displays Xiaohongshu visible heat without missing-share qualifiers', async () => {
  const snapshot = fixture();
  snapshot.highHeat[0] = {...snapshot.highHeat[0], heat: 215, heatIsLowerBound: true,
    missingMetrics: ['shares'], comparisonText: '↑25.7%'};
  const before = structuredClone(snapshot);
  const outputs = [renderCustomerDailyReportHtml(snapshot), renderCustomerDailyReportHtml(snapshot, {email: true}),
    renderCustomerDailyReportText(snapshot), renderCustomerDailyReportMessageHtml(snapshot), renderCustomerDailyReportMessageText(snapshot),
    JSON.stringify(buildFeishuDailyDocumentPlan(snapshot)),
    JSON.stringify(buildFeishuDailyPost({snapshot, documentUrl: 'https://example.test/doc', imageKey: 'img_test'}))];
  for (const value of outputs) {
    assert.ok(value.includes('热度 215'));
    assert.ok(!value.includes('至少'));
    assert.ok(!value.includes('分享数未取得'));
    assert.ok(value.includes('暂无可比数据'));
    assert.ok(!value.includes('25.7%'));
  }
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(reopened.getWorksheet('高热负面').getCell('D5').value, '215');
  assert.equal(reopened.getWorksheet('高热负面').getCell('E5').value, '暂无可比数据');
  assert.deepEqual(snapshot, before);
});

test('customer exports contain the summary and two linked lists, excluding operational notes and computed negative footer', async () => {
  const snapshot = fixture();
  const initial = structuredClone(snapshot);
  const html = renderCustomerDailyReportHtml(snapshot);
  const plain = renderCustomerDailyReportText(snapshot);
  for (const content of [html, plain]) {
    assert.match(content, /二、7天内热度值≥200的负面帖子/);
    assert.match(content, /三、本期冷处理负面帖：1 条/);
    assert.match(content, /热度 320｜较昨日 暂无对比/);
    assert.doesNotMatch(content, /实测|入库|数据说明|观测质量|标记时间|负面总数|系统生成版本|本日未更新|不可见/);
  }
  assert.match(html, /href="https:\/\/example.test\/post\?a=1&amp;b=2"/);
  assert.match(html, /客户讨论 &lt;更新&gt; &amp; 服务/);
  assert.match(plain, /https:\/\/example.test\/post\?a=1&b=2/);
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  assert.equal(workbook.getWorksheet('高热负面').columnCount, 5);
  assert.equal(workbook.getWorksheet('本期冷处理').columnCount, 3);
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    assert.doesNotMatch(cell.text, /内部核对事项|实测|入库|观测质量|标记时间|负面总数/);
  }));
  assert.equal(workbook.getWorksheet('高热负面').getCell('E5').value, '暂无对比');
  assert.equal(workbook.getWorksheet('本期冷处理').getCell('B5').value.hyperlink, snapshot.coldMarked[0].url);
  const serialized = await workbook.xlsx.writeBuffer();
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(serialized);
  assert.equal(reopened.getWorksheet('高热负面').getCell('B5').value.hyperlink, snapshot.highHeat[0].url);
  assert.deepEqual(snapshot, initial, 'rendering does not remove snapshot evidence or warnings');
});

test('saved summary values are rendered, explicit zero survives Excel round trip, and unknown handling cells remain blank', async () => {
  const snapshot = fixture();
  snapshot.summary.day.monitor = 130;
  snapshot.summary.day.inProgress = 0;
  snapshot.summary.mtd.processed = 7;
  assert.deepEqual(customerDailySummaryRows(snapshot), [
    ['9月7日', 130, 112, 16, 75, 8, 0, null], ['MTD', 126, 112, 16, 75, 8, null, 7],
  ]);
  assert.match(renderCustomerDailyReportText(snapshot), /9月7日\t130\t112\t16\t75\t8\t0\t/);
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  const buffer = await workbook.xlsx.writeBuffer();
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(buffer);
  const summary = reopened.getWorksheet('日报');
  assert.equal(summary.getCell('B6').value, 130);
  assert.equal(summary.getCell('G6').value, 0);
  assert.equal(summary.getCell('H6').value, null);
  assert.equal(summary.getCell('G7').value, null);
  assert.equal(summary.getCell('H7').value, 7);
});

test('comparison prefix is present once for unavailable, positive, negative, unchanged and zero-baseline comparisons', () => {
  for (const [input, expected] of [[undefined, '暂无对比'], ['', '暂无对比'], ['↓20%', '↓20%'], ['↑5%', '↑5%'], ['持平', '持平'], ['由0增至320', '由0增至320'], ['较昨日 ↑5%', '↑5%']]) {
    assert.equal(customerDailyPostComparison({comparisonText: input}), `较昨日 ${expected}`);
  }
});

test('copy body contains only the two link sections while document exports retain the summary table', () => {
  const snapshot = fixture();
  const html = renderCustomerDailyReportMessageHtml(snapshot);
  const text = renderCustomerDailyReportMessageText(snapshot);
  for (const content of [html, text]) {
    assert.match(content, /二、7天内热度值≥200的负面帖子/);
    assert.match(content, /三、本期冷处理负面帖：1 条/);
    assert.match(content, /TOP1/);
    assert.match(content, /example.test\/post/);
    assert.doesNotMatch(content, /<table|监控汇总|监控数量|MTD|内部核对事项|2026-09-07/);
  }
  assert.match(renderCustomerDailyReportHtml(snapshot), /<table/);
  assert.match(renderCustomerDailyReportText(snapshot), /一、监控汇总/);
});

test('current collection summary and historical handling are distinguished consistently without changing totals', async () => {
  const snapshot = fixture();
  snapshot.summary.day.cold = 0;
  const base = snapshot.coldMarked[0];
  snapshot.coldMarked = [{...base, title: '昨天采集今天冷处理', isHistorical: true},
    {...base, title: '本期采集本期冷处理', isHistorical: false}];
  for (const content of [renderCustomerDailyReportHtml(snapshot), renderCustomerDailyReportText(snapshot)]) {
    assert.match(content, /一、监控汇总（本期新增）/);
    assert.match(content, /三、本期冷处理负面帖：2 条（含历史帖 1 条）/);
    assert.equal((content.match(/【历史帖】/g) || []).length, 1);
    assert.doesNotMatch(content, /2026-09-07T11:00|入库时间|标记时间/);
  }
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(reopened.getWorksheet('日报').getCell('F6').value, 0);
  assert.equal(reopened.getWorksheet('日报').getCell('A2').value, '一、监控汇总（本期新增）');
  const cold = reopened.getWorksheet('本期冷处理');
  assert.equal(cold.getCell('A2').value, '三、本期冷处理负面帖：2 条（含历史帖 1 条）');
  assert.deepEqual(cold.getCell('B5').value, {text: '昨天采集今天冷处理【历史帖】', hyperlink: base.url});
  assert.deepEqual(cold.getCell('B6').value, {text: '本期采集本期冷处理', hyperlink: base.url});
});

test('old or partly classified snapshots show list totals without inventing a historical split', () => {
  const old = fixture();
  assert.equal(customerDailyColdTitle(old), '三、本期冷处理负面帖：1 条');
  assert.doesNotMatch(renderCustomerDailyReportText(old), /历史帖/);
  old.coldMarked.push({...old.coldMarked[0], isHistorical: true});
  assert.equal(customerDailyColdTitle(old), '三、本期冷处理负面帖：2 条');
  assert.equal(customerDailyColdTitle({coldMarked: [{isHistorical: false}]}), '三、本期冷处理负面帖：1 条');
  assert.equal(customerDailyColdTitle({coldMarked: []}), '三、本期冷处理负面帖：0 条');
});

function handlingFixture() {
  const source = fixture();
  const value = {monitor: 3, sdb: 2, positive: 1, neutral: 0, negative: 1, cold: 0, comment: 0, negativeProcess: 1, negativeOther: 0};
  source.schemaVersion = 3;
  source.summary = {format: 'daily_handling_v3', day: value, mtd: {...value, monitor: 6}, rows: [
    {date: '2026-09-05', isWorkingDay: false, counts: {...value, monitor: 0}},
    {date: '2026-09-06', isWorkingDay: false, counts: value},
    {date: '2026-09-07', isWorkingDay: true, counts: value},
  ]};
  source.collectionSummary = {format: 'daily_disposition_v2', day: {...value, monitor: 10}, mtd: {...value, monitor: 17}, rows: [
    {date: '2026-09-05', isWorkingDay: false, counts: {monitor: 0}},
    {date: '2026-09-07', isWorkingDay: true, counts: {...value, monitor: 10}},
  ]};
  source.highHeat = ['negative_cold', 'negative_comment', 'negative_feishu', undefined].map((status, i) => ({...source.highHeat[0], status, feishuTableNo: i === 2 ? 'FS-2026-08' : undefined}));
  return source;
}

test('v3 separates handling and collection counts, omits empty holidays, and exports actual high heat statuses', async () => {
  const source = handlingFixture();
  const saved = structuredClone(source);
  const html = renderCustomerDailyReportHtml(source);
  const text = renderCustomerDailyReportText(source);
  for (const output of [html, text]) {
    assert.ok(output.indexOf('每日舆情处理量') < output.indexOf('实际采集量'));
    assert.ok(output.indexOf('实际采集量') < output.indexOf('三、7天内'));
    assert.match(output, /冷处理/); assert.match(output, /评论区留言/);
    assert.match(output, /处理状态：飞书表 · FS-2026-08/); assert.match(output, /处理状态：状态未记录/);
    assert.doesNotMatch(output, /2026\/9\/5|休息日|休假|>休</);
    assert.match(output, /2026\/9\/6/);
  }
  assert.match(html, /colspan="4" scope="colgroup">负面/);
  assert.match(html, /本月处理累计/); assert.match(html, /本月采集去重累计/);
  assert.match(text, /MTD\t6\t/); assert.match(text, /MTD\t17\t/);
  const workbook = buildCustomerDailyReportWorkbook(source);
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet('日报');
  const mtd = [];
  sheet.eachRow(row => { if (row.getCell(1).value === 'MTD') mtd.push(row.getCell(2).value); });
  assert.deepEqual(mtd, [{formula: 'SUM(B6:B7)', result: 6}, 17], 'handling uses daily SUM with saved result; collection retains its distinct saved MTD');
  assert.ok(sheet.model.merges.includes('F4:I4'));
  assert.equal(sheet.getCell('A6').value, '2026/9/6');
  assert.equal(reopened.getWorksheet('高热负面').getCell('F7').value, '飞书表 · FS-2026-08');
  assert.deepEqual(source, saved);
});


test('v3 status labels distinguish missing and unknown states and attach numbers only to feishu handling', () => {
  assert.equal(customerDailyPostStatus({}), '状态未记录');
  assert.equal(customerDailyPostStatus({status: 'future_state'}), '状态待核对');
  assert.equal(customerDailyPostStatus({status: 'negative_feishu'}), '飞书表');
  assert.equal(customerDailyPostStatus({status: 'negative_feishu', feishuTableNo: '  FS-001\n'}), '飞书表 · FS-001');
  assert.equal(customerDailyPostStatus({status: 'negative_cold', feishuTableNo: 'old-number'}), '冷处理');
});

test('v4 exports one full collection table in grouped styling with frozen distinct MTD and high heat statuses', async () => {
  const source = handlingFixture();
  source.schemaVersion = 4;
  source.summary = {...source.collectionSummary, format: 'daily_collection_v4'};
  source.summary.rows.push({date: '2026-09-06', isWorkingDay: false, counts: {...source.summary.day, monitor: 5}});
  source.summary.rows.sort((a, b) => a.date.localeCompare(b.date));
  delete source.collectionSummary;
  const original = structuredClone(source);
  const html = renderCustomerDailyReportHtml(source), text = renderCustomerDailyReportText(source);
  for (const output of [html, text]) {
    for (const label of ['一、每日舆情处理量', '首次入库采集统计', '平台监控量', '本月去重累计', '走负面处理流程', '二、7天内热度值≥200的负面帖子', '三、本期冷处理负面帖', '处理状态：飞书表 · FS-2026-08']) assert.ok(output.includes(label));
    assert.doesNotMatch(output, /实际采集量|本月处理累计|本月采集去重累计|2026\/9\/5|休假|休息日/);
    assert.match(output, /2026\/9\/6/);
  }
  assert.equal((html.match(/<table\b/g) || []).length, 1);
  assert.match(html, /colspan="4" scope="colgroup">负面/);
  assert.equal((text.match(/MTD\t/g) || []).length, 1);
  assert.match(text, /MTD\t17\t/);
  const workbook = buildCustomerDailyReportWorkbook(source);
  const reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet('日报');
  assert.equal(sheet.getCell('A3').value, '首次入库采集统计');
  assert.equal(sheet.getCell('B4').value, '平台监控量');
  assert.ok(sheet.model.merges.includes('F4:I4'));
  const mtdRows = [];
  sheet.eachRow(row => { if (row.getCell(1).value === 'MTD') mtdRows.push(row); });
  assert.equal(mtdRows.length, 1);
  assert.equal(mtdRows[0].getCell(2).value, 17);
  for (let column = 2; column <= 9; column++) assert.equal(typeof mtdRows[0].getCell(column).value, 'number', 'every frozen collection MTD cell remains a value, never SUM');
  assert.equal(reopened.getWorksheet('高热负面').getCell('F7').value, '飞书表 · FS-2026-08');
  assert.deepEqual(source, original);
});

test('v5 exports collection columns alongside actual negative handling events and frozen distinct MTD', async () => {
  const source = collectionHandlingSnapshot(), original = structuredClone(source);
  const expected = [
    ['2026/9/12', 0, 0, 0, 0, 2, 3, 0, 0],
    ['2026/9/14', 280, 198, 65, 122, 0, 2, 9, 2],
    ['MTD', 1243, 932, 357, 515, 19, 2, 35, 5],
  ];
  assert.deepEqual(customerDailySummaryRows(source), expected);
  const html = renderCustomerDailyReportHtml(source), text = renderCustomerDailyReportText(source);
  for (const output of [html, text]) {
    for (const label of ['采集列按采集日期统计', '四项负面按实际处理日期计次数（含旧帖）', 'MTD 按帖去重', '本月去重累计', '处理状态：飞书表 · 202609-007']) assert.ok(output.includes(label));
    assert.match(output, /2026\/9\/12/);
    assert.doesNotMatch(output, /2026\/9\/13|首次入库采集统计|实际采集量|本月处理累计|>休</);
  }
  assert.equal((html.match(/<table\b/g) || []).length, 1);
  assert.match(html, /colspan="4" scope="colgroup">负面/);
  for (const row of expected) assert.ok(text.includes(row.join('\t')));
  const workbook = buildCustomerDailyReportWorkbook(source), reopened = new workbook.constructor();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet('日报'), actual = [];
  sheet.eachRow(row => {
    if (/^(2026\/|MTD$)/.test(String(row.getCell(1).value))) actual.push(Array.from({length: 9}, (_, i) => row.getCell(i + 1).value));
  });
  assert.deepEqual(actual, expected, 'all daily and MTD cells remain snapshot numbers; MTD never uses SUM');
  assert.match(sheet.getCell('A3').value, /按实际处理日期计次数/);
  assert.equal(sheet.getCell('B4').value, '平台监控量');
  assert.ok(sheet.model.merges.includes('F4:I4'));
  assert.equal(reopened.getWorksheet('高热负面').getCell('F5').value, '飞书表 · 202609-007');
  assert.deepEqual(source, original);
});
