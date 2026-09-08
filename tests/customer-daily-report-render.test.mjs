import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomerDailyReportWorkbook, renderCustomerDailyReportHtml, renderCustomerDailyReportText, renderCustomerDailyReportMessageHtml, renderCustomerDailyReportMessageText } from '../server/services/customer-daily-report-render.js';
import { customerDailySummaryRows, customerDailyPostComparison } from '../server/services/customer-daily-report-presentation.js';

function fixture() {
  const counts = {monitor: 126, sdb: 112, positive: 16, neutral: 75, negative: 18, cold: 8, inProgress: null, processed: null};
  const post = {title: '客户讨论 <更新> & 服务', platform: 'xiaohongshu', url: 'https://example.test/post?a=1&b=2', heat: 320, comparisonText: '', observedAt: '2026-09-07T12:00:00Z', previousObservedAt: '2026-09-06T12:00:00Z', quality: 'legacy_unverified', timeSource: 'ingested_at', stale: true, status: 'unavailable'};
  return {tenantName: '示例客户', reportDate: '2026-09-07', mode: 'formal', cutoffAt: '2026-09-07T16:00:00Z', assessedAt: '2026-09-08T01:00:00Z', summary: {day: {...counts}, mtd: {...counts}}, highHeat: [post], coldMarked: [{...post, markedAt: '2026-09-07T11:00:00Z'}], warnings: [{message: '内部核对事项：观测质量与标记记录待确认', blocking: true}], evidence: {cold: {coverageComplete: false}}};
}

test('customer exports contain the summary and two linked lists, excluding operational notes and computed negative footer', async () => {
  const snapshot = fixture();
  const initial = structuredClone(snapshot);
  const html = renderCustomerDailyReportHtml(snapshot);
  const plain = renderCustomerDailyReportText(snapshot);
  for (const content of [html, plain]) {
    assert.match(content, /二、7天内热度值≥200的负面帖子/);
    assert.match(content, /三、冷处理负面帖链接/);
    assert.match(content, /热度 320｜较昨日 暂无对比/);
    assert.doesNotMatch(content, /实测|入库|数据说明|观测质量|标记时间|负面总数|系统生成版本|本日未更新|不可见/);
  }
  assert.match(html, /href="https:\/\/example.test\/post\?a=1&amp;b=2"/);
  assert.match(html, /客户讨论 &lt;更新&gt; &amp; 服务/);
  assert.match(plain, /https:\/\/example.test\/post\?a=1&b=2/);
  const workbook = buildCustomerDailyReportWorkbook(snapshot);
  assert.equal(workbook.getWorksheet('高热负面').columnCount, 5);
  assert.equal(workbook.getWorksheet('新增冷处理').columnCount, 3);
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    assert.doesNotMatch(cell.text, /内部核对事项|实测|入库|观测质量|标记时间|负面总数/);
  }));
  assert.equal(workbook.getWorksheet('高热负面').getCell('E5').value, '暂无对比');
  assert.equal(workbook.getWorksheet('新增冷处理').getCell('B5').value.hyperlink, snapshot.coldMarked[0].url);
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
    assert.match(content, /三、冷处理负面帖链接/);
    assert.match(content, /TOP1/);
    assert.match(content, /example.test\/post/);
    assert.doesNotMatch(content, /<table|监控汇总|监控数量|MTD|内部核对事项|2026-09-07/);
  }
  assert.match(renderCustomerDailyReportHtml(snapshot), /<table/);
  assert.match(renderCustomerDailyReportText(snapshot), /一、监控汇总/);
});
