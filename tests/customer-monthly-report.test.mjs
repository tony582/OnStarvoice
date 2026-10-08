import assert from 'node:assert/strict';
import test from 'node:test';
import {collectCustomerMonthlyReport, customerMonthlyPeriod, buildCustomerMonthlySummary, selectCustomerMonthlyTopNegative} from '../server/services/customer-monthly-report-data.js';
import {renderCustomerMonthlyReportHtml, renderCustomerMonthlyReportText, buildCustomerMonthlyReportWorkbook, buildCustomerMonthlyDetailWorkbook, customerMonthlyReportTitle} from '../server/services/customer-monthly-report-render.js';
import {buildMonthlyEmailMessage, createCustomerMonthlyEmailService} from '../server/services/customer-monthly-email.js';
import {publicMonthlySnapshot} from '../server/services/customer-monthly-reports.js';

const ID = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const tenantId = ID(999);
const generatedAt = new Date('2026-10-08T03:00:00Z');
const published = (day, hour = 10) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`;
function post(n, patch = {}) {
  return {id: ID(n), platform: 'xiaohongshu', title: `帖子${n}`, url: `https://www.xiaohongshu.com/explore/${n}`, canonical_url: '', author_name: `作者${n}`,
    published_ts: published(n), first_seen_at: published(n, 12), record_type: 'single_note', business_visibility: 'eligible', sentiment: 'neutral',
    keyword: '安吉星', content_topic: 'onstar', likes: 10, comments_count: 2, collects: 1, shares: 0, status: 'reviewed', archived_at: null,
    feishu_table_no: '', admission_allowed: true, watched: false, ...patch};
}
function fakeDb(seed = {}) {
  const calls = [];
  return {calls,
    async queryOne(sql, params) {
      calls.push({sql, params});
      if (sql.includes('customer_monthly:tenant')) return seed.tenant === null ? null : {name: '测试客户'};
      if (sql.includes('customer_monthly:missing_published')) return {count: seed.missingPublished || 0};
      throw new Error(`Unexpected queryOne ${sql}`);
    },
    async queryAll(sql, params) {
      calls.push({sql, params});
      if (sql.includes('customer_monthly:posts')) return seed.posts || [];
      throw new Error(`Unexpected queryAll ${sql}`);
    },
  };
}
const posts = [
  post(1, {sentiment: 'positive'}),
  post(2, {sentiment: 'negative', status: 'negative_cold', likes: 250, comments_count: 40, collects: 10, shares: 5, content_topic: 'infotainment', platform: 'douyin'}),
  post(3, {sentiment: 'negative', status: 'negative_feishu', feishu_table_no: '26090301', likes: 190, comments_count: 20, collects: 0, shares: null, content_topic: 'wallpaper'}),
  post(4, {sentiment: 'negative', status: 'negative_comment', likes: 50, content_topic: null}),
  post(5, {status: 'reviewed_non_monitor', sentiment: 'negative', likes: 900}),
  post(6, {sentiment: '', content_topic: 'sentry'}),
  post(7, {sentiment: 'positive', status: 'negative_cold', content_topic: 'brand_app'}),
  post(8, {status: 'reviewed', archived_at: '2026-09-20T00:00:00Z'}),
  post(9, {admission_allowed: false}),
  post(10, {business_visibility: 'filtered_out'}),
  post(11, {record_type: 'comment'}),
  post(12, {status: 'future_status'}),
  post(13, {published_ts: '2026-08-31T23:59:59+08:00'}),
  post(14, {published_ts: '2026-10-01T00:00:00+08:00'}),
  post(15, {sentiment: 'negative', status: 'unhandled', likes: 300, url: 'javascript:alert(1)', canonical_url: '', content_topic: 'gm_customer_service', platform: 'weibo'}),
  post(16, {sentiment: 'neutral', content_topic: 'gm_other', watched: true}),
  post(1, {title: '同帖重复行'}),
];

test('monthly period is a Beijing calendar month; the current month is month-to-date and future months are rejected', () => {
  const september = customerMonthlyPeriod('2026-09', generatedAt);
  assert.deepEqual(september, {reportMonth: '2026-09', periodStart: '2026-08-31T16:00:00.000Z', periodEnd: '2026-09-30T16:00:00.000Z',
    cutoffAt: '2026-09-30T16:00:00.000Z', assessedAt: '2026-10-08T03:00:00.000Z', complete: true, mode: 'formal'});
  const october = customerMonthlyPeriod('2026-10', generatedAt);
  assert.equal(october.complete, false);
  assert.equal(october.mode, 'realtime');
  assert.equal(october.cutoffAt, '2026-10-08T03:00:00.000Z');
  assert.equal(customerMonthlyPeriod(undefined, generatedAt).reportMonth, '2026-10');
  assert.equal(customerMonthlyPeriod('2025-12', generatedAt).periodEnd, '2025-12-31T16:00:00.000Z');
  assert.throws(() => customerMonthlyPeriod('2026-11', generatedAt), {code: 'invalid_report_month'});
  for (const value of ['2026-9', '2026-13', '202609', 'abc']) assert.throws(() => customerMonthlyPeriod(value, generatedAt), {code: 'invalid_report_month'});
});

test('September counts active triage posts by publish time with topic and platform breakdowns, frozen detail and top negatives', async () => {
  const db = fakeDb({posts, missingPublished: 2});
  const snapshot = await collectCustomerMonthlyReport({tenantId, month: '2026-09', now: generatedAt, db});
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.kind, 'customer_monthly_v1');
  assert.equal(snapshot.tenantName, '测试客户');
  assert.equal(snapshot.complete, true);
  const sql = db.calls.find(call => call.sql.includes('customer_monthly:posts'));
  assert.match(sql.sql, /r\.published_ts >= \$2::timestamptz AND r\.published_ts < \$3::timestamptz/);
  assert.match(sql.sql, /rt\.archived_at IS NULL/);
  assert.deepEqual(sql.params, [tenantId, '2026-08-31T16:00:00.000Z', '2026-09-30T16:00:00.000Z']);
  assert.deepEqual(snapshot.records.map(row => row.recordId), [1, 2, 3, 4, 5, 6, 7, 15, 16].map(ID), 'archived, unadmitted, filtered, comment, unknown status, other months and duplicates are out');
  assert.equal(snapshot.records.length, 9);
  const total = snapshot.summary.total;
  assert.deepEqual([total.monitor, total.sdb, total.nonMonitor, total.positive, total.neutral, total.negative, total.unclassified], [9, 8, 1, 2, 1, 4, 1]);
  assert.deepEqual([total.cold, total.comment, total.negativeProcess, total.negativeOther], [1, 1, 1, 0], 'cold counts only posts whose sentiment is still negative');
  assert.equal(snapshot.summary.rows.length, 30);
  assert.deepEqual(snapshot.summary.rows.filter(row => row.counts.monitor).map(row => [row.date, row.counts.monitor]),
    [['2026-09-01', 1], ['2026-09-02', 1], ['2026-09-03', 1], ['2026-09-04', 1], ['2026-09-05', 1], ['2026-09-06', 1], ['2026-09-07', 1], ['2026-09-15', 1], ['2026-09-16', 1]]);
  assert.deepEqual(snapshot.summary.byTopic.map(row => [row.topic, row.label, row.counts.monitor]),
    [['onstar', '安吉星', 2], ['infotainment', '车机', 1], ['wallpaper', '壁纸', 1], ['brand_app', '品牌APP', 1], ['sentry', '哨兵', 1], ['gm_customer_service', '上汽通用客服', 1], ['gm_other', '其它通用相关', 1], ['unclassified', '主题生成中', 1]]);
  assert.deepEqual(snapshot.summary.byPlatform.map(row => [row.label, row.counts.monitor]), [['小红书', 7], ['抖音', 1], ['微博', 1]]);
  assert.deepEqual(snapshot.topNegative.map(post => [post.recordId, post.heat, post.heatIsLowerBound]), [[ID(2), 305, false], [ID(15), 303, false], [ID(3), 210, true]], 'non-monitor negatives are excluded; a missing metric gives a lower bound');
  assert.equal(snapshot.topNegative[2].feishuTableNo, '26090301');
  assert.equal(snapshot.topNegative[1].url, '', 'unsafe links are dropped');
  const detail = snapshot.records.find(row => row.recordId === ID(3));
  assert.deepEqual([detail.publishedDate, detail.platformLabel, detail.topicLabel, detail.shares, detail.metricsKnown, detail.keyword, detail.authorName], ['2026-09-03', '小红书', '壁纸', null, false, '安吉星', '作者3']);
  assert.equal(snapshot.records.find(row => row.recordId === ID(16)).watched, true);
  assert.deepEqual(snapshot.warnings.map(warning => warning.code).sort(), ['heat_lower_bound', 'published_time_missing', 'sentiment_status_conflict', 'source_link_missing', 'topic_pending', 'unclassified'].sort());
  assert.equal(snapshot.warnings.find(warning => warning.code === 'published_time_missing').message, '本月采集入库的内容分诊帖子中2条缺少发布时间，无法按发帖时间归入月报。');
  assert.deepEqual(snapshot.evidence.conflictRecordIds, [ID(7)]);
  assert.equal(snapshot.evidence.dateField, 'records.published_ts');
  assert.equal(snapshot.evidence.recordCount, 9);
  const stripped = publicMonthlySnapshot(snapshot);
  assert.equal(stripped.records, undefined);
  assert.equal(stripped.recordCount, 9);
  assert.equal(publicMonthlySnapshot(snapshot, {includeRecords: true}).records.length, 9);
});

test('a month in progress stops at the generation time and says so', async () => {
  const db = fakeDb({posts: [post(1, {published_ts: '2026-10-02T09:00:00+08:00'}), post(2, {published_ts: '2026-10-08T12:00:00+08:00'})]});
  const snapshot = await collectCustomerMonthlyReport({tenantId, month: '2026-10', now: generatedAt, db});
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.summary.rows.length, 8);
  assert.equal(snapshot.summary.total.monitor, 1, 'a post published after the generation time waits for the next version');
  assert.ok(snapshot.warnings.some(warning => warning.code === 'month_in_progress'));
  assert.match(customerMonthlyReportTitle(snapshot), /舆情月报 2026-10 · 截至10-08/);
  await assert.rejects(collectCustomerMonthlyReport({tenantId, month: '2026-09', now: generatedAt, db: fakeDb({tenant: null})}), {statusCode: 404});
});

test('summary helpers keep SDB arithmetic and heat ordering stable', () => {
  const period = customerMonthlyPeriod('2026-02', new Date('2026-03-05T00:00:00Z'));
  const summary = buildCustomerMonthlySummary([], period);
  assert.equal(summary.rows.length, 28);
  assert.equal(summary.byTopic.length, 7, 'the customer topics always appear, pending topics only when present');
  assert.deepEqual(summary.byPlatform, []);
  const ranked = selectCustomerMonthlyTopNegative([
    {recordId: 'b', sentiment: 'negative', status: 'unhandled', heat: 200, metricsKnown: true, publishedAt: '2026-02-02T00:00:00Z'},
    {recordId: 'a', sentiment: 'negative', status: 'unhandled', heat: 200, metricsKnown: true, publishedAt: '2026-02-03T00:00:00Z'},
    {recordId: 'c', sentiment: 'negative', status: 'unhandled', heat: 199, metricsKnown: true, publishedAt: '2026-02-03T00:00:00Z'},
    {recordId: 'd', sentiment: 'positive', status: 'unhandled', heat: 900, metricsKnown: true, publishedAt: '2026-02-03T00:00:00Z'},
  ], {limit: 5});
  assert.deepEqual(ranked.map(post => post.recordId), ['a', 'b'], 'threshold is inclusive; ties prefer the newer post');
});

test('HTML, text, Excel and the email carry the same tables, links and frozen detail without internal warnings', async () => {
  const snapshot = {...await collectCustomerMonthlyReport({tenantId, month: '2026-09', now: generatedAt, db: fakeDb({posts})}), id: 'report-1', version: 3, tenantName: '客户 <测试>'};
  const html = renderCustomerMonthlyReportHtml(snapshot);
  assert.match(html, /客户 &lt;测试&gt; · 舆情月报 2026-09/);
  for (const heading of ['一、月度舆情汇总（按发帖日期）', '二、内容主题分布', '三、平台分布', '四、本月热度值≥200的负面帖子']) assert.ok(html.includes(heading), heading);
  assert.match(html, /https:\/\/www\.xiaohongshu\.com\/explore\/2/);
  assert.match(html, /原帖链接待补/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<td>合计<\/td><td>9<\/td><td>8<\/td>/);
  assert.match(html, /<td>安吉星<\/td><td>2<\/td>/);
  assert.match(html, /热度 至少 210/);
  const text = renderCustomerMonthlyReportText(snapshot);
  assert.match(text, /发帖日期\t平台监控量\tSDB范畴/);
  assert.match(text, /合计\t9\t8\t2\t1\t1\t1\t1\t0/);
  assert.match(text, /TOP1：帖子2 — 抖音｜热度 305｜发布 2026-09-02｜处理状态：冷处理｜主题：车机/);
  assert.doesNotMatch(html + text, /缺少发布时间|情感结论与负面处理状态不一致/);
  const email = renderCustomerMonthlyReportHtml(snapshot, {email: true});
  assert.match(email, /<td style="font-family:[^"]*border:1px solid #bcc3cb/);
  const workbook = buildCustomerMonthlyReportWorkbook(snapshot);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['月报汇总', '内容主题', '平台分布', '高热负面帖', '数据说明']);
  const summarySheet = workbook.getWorksheet('月报汇总');
  assert.deepEqual(summarySheet.getRow(4).values.slice(1), ['发帖日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-走负面处理流程', '负面-其他']);
  assert.deepEqual(summarySheet.getRow(35).values.slice(1), ['合计', 9, 8, 2, 1, 1, 1, 1, 0]);
  assert.equal(workbook.getWorksheet('内容主题').getRow(5).getCell(1).value, '安吉星');
  assert.equal(workbook.getWorksheet('高热负面帖').getRow(4).getCell(8).value.hyperlink, 'https://www.xiaohongshu.com/explore/2');
  const detail = buildCustomerMonthlyDetailWorkbook(snapshot);
  const sheet = detail.getWorksheet('明细');
  assert.equal(sheet.rowCount, 3 + 9);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['序号', '发布时间', '平台', '标题', '作者', '情感', '处理状态', '内容主题', '采集关键词', '点赞', '评论', '收藏', '分享', '首次采集时间', '原帖链接']);
  assert.deepEqual(sheet.getRow(5).values.slice(1, 10), [2, '2026-09-02 10:00', '抖音', '帖子2', '作者2', '负面', '冷处理', '车机', '安吉星']);
  assert.equal(sheet.getRow(6).getCell(13).value, '', 'an unknown metric stays blank instead of zero');
  assert.equal(sheet.getRow(6).getCell(7).value, '飞书表 · 26090301');
  assert.equal(sheet.getRow(11).getCell(15).value, '原帖链接待补');
  const frozen = structuredClone(snapshot);
  const message = await buildMonthlyEmailMessage(snapshot);
  assert.deepEqual(message.attachments.map(item => item.filename), ['客户月报_2026-09_v3.xlsx', '客户月报明细_2026-09_v3.xlsx']);
  assert.ok(message.attachments.every(item => item.content.subarray(0, 2).toString() === 'PK'));
  assert.match(message.html, /舆情月报 2026-09/);
  assert.match(message.text, /二、内容主题分布/);
  assert.deepEqual(snapshot, frozen);
});

test('the monthly email queue uses its own tables, subject and message identity', async () => {
  const writes = [];
  const row = {id: 'delivery-m', report_id: 'report-m', tenant_id: tenantId, recipients: 'customer@example.test', subject: '冻结主题', snapshot: {tenantName: '客户'}, status: 'queued', ambiguous: false, claim_token: null};
  const tx = {
    async queryOne(sql, params) {
      writes.push({sql, params});
      if (sql.includes('pg_advisory_xact_lock')) return {};
      if (sql.includes('FROM customer_monthly_reports')) return {snapshot: {tenantName: '客户'}, period: '2026-09-01', version: 2};
      if (sql.includes('FROM customer_monthly_email_deliveries WHERE tenant_id=$1 AND report_id=$2 FOR UPDATE')) return null;
      if (sql.includes('FROM customer_monthly_email_deliveries WHERE tenant_id=$1 AND report_id=$2')) return row.status === 'queued' ? {id: row.id, status: 'queued', recipients: row.recipients, ambiguous: false} : null;
      if (sql.includes('FROM customer_daily_report_settings')) return {config: {emailRecipients: 'customer@example.test'}};
      if (sql.includes("WHERE status='queued'")) return row.status === 'queued' ? structuredClone(row) : null;
      throw new Error(`Unexpected queryOne ${sql}`);
    },
    async execute(sql, params) {
      writes.push({sql, params});
      if (sql.includes("SET status='working'")) { row.status = 'working'; row.claim_token = params[1]; }
      else if (sql.includes("SET status='sent'")) { row.status = 'sent'; row.message_id = params[3]; }
      return {rowCount: 1};
    },
  };
  const db = {...tx, async withTransaction(callback) { return callback(tx); }};
  const sent = [];
  const service = createCustomerMonthlyEmailService({db, readiness: async () => ({ready: true}), buildMessage: async () => ({html: 'h', text: 't', attachments: []}),
    send: async message => { sent.push(message); return {accepted: ['customer@example.test'], rejected: [], messageId: 'smtp-m'}; }});
  await service.enqueue(tenantId, 'report-m');
  const insert = writes.find(write => write.sql.includes('INSERT INTO customer_monthly_email_deliveries'));
  assert.ok(insert, 'queued into the monthly table');
  assert.equal(insert.params[4], '客户舆情月报 · 2026-09 · v2');
  assert.ok(writes.some(write => write.sql.includes('pg_advisory_xact_lock') && write.params[0] === `monthly-email:${tenantId}:report-m`));
  assert.ok(!writes.some(write => write.sql.includes('customer_daily_email_deliveries') || write.sql.includes('FROM customer_daily_reports')), 'never touches the daily queue');
  assert.equal(await service.processOne(), true);
  assert.equal(sent[0].messageId, '<monthly-report-delivery-m@starvoice.local>');
  assert.equal(row.status, 'sent');
});
