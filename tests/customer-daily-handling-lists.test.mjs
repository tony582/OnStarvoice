import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCustomerDailyHandlingLists} from '../server/services/customer-daily-handling-lists.js';
import {parseCustomerDailyHandlingEvents, buildCustomerDailyNegativeHandlingSummary} from '../server/services/customer-daily-handling-summary.js';
import {collectionHandlingSnapshot} from './fixtures/customer-daily-v5.mjs';
import {renderCustomerDailyReportHtml, renderCustomerDailyReportText, buildCustomerDailyReportWorkbook} from '../server/services/customer-daily-report-render.js';
import {buildFeishuDailyDocumentPlan} from '../server/services/feishu-daily-report.js';
import {buildFeishuDailyPost, feishuDailyPostRequestBytes, FEISHU_DAILY_POST_MAX_BYTES} from '../server/services/feishu-daily-report-message.js';

const id = n => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
const at = (day, hour = 10) => `2026-09-${day}T${String(hour).padStart(2, '0')}:00:00+08:00`;
const period = {reportDate: '2026-09-28', periodStart: at(28, 0), handlingStartAt: at(26, 0), collectionStartAt: at(25, 18), cutoffAt: at(28, 18)};
const post = (n, status, sentiment = 'negative') => ({id: id(n), title: `帖子${n}`, status, sentiment, platform: 'douyin', url: `https://www.douyin.com/video/${n}`, first_seen_at: at(24)});
function event(n, record, previousStatus, nextStatus, day = 28, hour = 10, note = '') {
  return {id: id(n), action: 'record.triage_updated', target_type: 'record', target_id: record.id, created_at: at(day, hour), metadata: {previousStatus, nextStatus, note}};
}

test('reply notes stay within their handling episode, including same-status, batch-note-only and standalone supplements', () => {
  const positive = post(1, 'replied', 'positive'), neutral = post(2, 'replied', 'neutral'), negative = post(3, 'negative_comment');
  const events = [event(101, positive, 'unhandled', 'replied', 26, 10, '旧阶段回复'),
    event(102, positive, 'replied', 'reviewed', 26, 12),
    event(103, positive, 'reviewed', 'replied', 28, 9, '您没事就是认可~~\n注意安全哦😀'),
    event(104, positive, 'replied', 'replied', 28, 11, '同状态补充'),
    {id: id(105), action: 'record.triage_batch_updated', target_type: 'record', created_at: at(28, 12), metadata: {recordIds: [positive.id], status: null, note: '批量补充'}},
    {id: id(106), action: 'record.triage_batch_updated', target_type: 'record', created_at: at(28, 10), metadata: {recordIds: [neutral.id], status: 'replied', previous: {[neutral.id]: {status: 'unhandled'}}, note: '中性回复'}},
    event(107, negative, 'unhandled', 'negative_comment', 28, 10, '负面评论回复'),
  ];
  const notes = [{id: id(201), record_id: positive.id, body: '旧阶段补充', created_at: at(26, 11)},
    {id: id(202), record_id: positive.id, body: '新阶段补充\n第二行', created_at: at(28, 13)},
    {id: id(203), record_id: positive.id, body: '未来备注', created_at: period.cutoffAt}];
  const parsed = parseCustomerDailyHandlingEvents(events);
  const lists = buildCustomerDailyHandlingLists([positive, neutral, negative], parsed.transitions, events, notes, period);
  const current = lists.repliedMarked.find(row => row.eventId === id(103));
  assert.equal(current.replyContent, '您没事就是认可~~\n注意安全哦😀');
  assert.deepEqual(current.supplementalNotes.map(row => row.body), ['同状态补充', '批量补充', '新阶段补充\n第二行']);
  assert.equal(lists.repliedMarked.find(row => row.eventId === id(106)).replyContent, '中性回复');
  assert.equal(lists.commentMarked[0].replyContent, '负面评论回复');
  assert.equal(lists.repliedMarked.length, 2, 'the obsolete same-day reply superseded by review is excluded');
  assert.equal(lists.commentMarked.length, 1);
  const summary = buildCustomerDailyNegativeHandlingSummary([positive, neutral, negative], parsed.transitions, period).summary;
  assert.equal(summary.day.comment, lists.commentMarked.length);
});

test('reply reclassification inherits original text and supplements without changing counts or crossing a reopened episode', () => {
  const record = post(1, 'negative_comment');
  const events = [event(101, record, 'unhandled', 'replied', 28, 10, '您方便时可按下车内蓝键，客服顾问帮您解答。'),
    event(102, record, 'replied', 'replied', 28, 11, '同状态补充😀'),
    event(103, record, 'replied', 'negative_comment', 28, 14)];
  const notes = [{id: id(201), record_id: record.id, body: '分类更正前的补充\n第二行', created_at: at(28, 12)}];
  const collect = () => buildCustomerDailyHandlingLists([record], parseCustomerDailyHandlingEvents(events).transitions, events, notes, period);
  const first = collect();
  assert.equal(first.commentMarked.length, 1); assert.equal(first.repliedMarked.length, 0);
  assert.equal(first.commentMarked[0].replyContent, events[0].metadata.note);
  assert.equal(first.commentMarked[0].replySourceEventId, id(101));
  assert.deepEqual(first.commentMarked[0].supplementalNotes.map(row => row.body), ['同状态补充😀', notes[0].body]);
  events[2].metadata.note = '客户明确填写了新回复';
  assert.equal(collect().commentMarked[0].replyContent, '客户明确填写了新回复');
  events.push(event(104, record, 'negative_comment', 'unhandled', 28, 15), event(105, record, 'unhandled', 'negative_comment', 28, 16));
  assert.equal(collect().commentMarked[0].replyContent, '');
  assert.deepEqual(collect().commentMarked[0].supplementalNotes, []);
});

test('batch reclassification supports both reply directions and keeps another post separate', () => {
  const records = [post(1, 'negative_comment'), post(2, 'replied', 'positive')];
  const events = [event(101, records[0], 'unhandled', 'replied', 27, 10, '第一条回复'),
    event(102, records[1], 'unhandled', 'negative_comment', 27, 11, '第二条回复'),
    {id: id(103), action: 'record.triage_batch_updated', created_at: at(28, 14), metadata: {recordIds: [records[0].id], status: 'negative_comment', previous: {[records[0].id]: {status: 'replied'}}, note: ''}},
    event(104, records[1], 'negative_comment', 'replied', 28, 14)];
  const result = buildCustomerDailyHandlingLists(records, parseCustomerDailyHandlingEvents(events).transitions, events, [], period);
  assert.deepEqual(result.commentMarked.map(row => row.replyContent), ['第一条回复']);
  assert.deepEqual(result.repliedMarked.map(row => row.replyContent), ['第二条回复']);
});

test('each natural handling date deduplicates posts, spans weekends/month boundaries, and keeps handling MTD distinct', () => {
  const record = post(1, 'negative_comment');
  const events = [event(101, record, 'unhandled', 'negative_comment', 26), event(102, record, 'negative_comment', 'negative_cold', 27),
    event(103, record, 'negative_cold', 'negative_comment', 28), event(104, record, 'negative_comment', 'negative_comment', 28, 12)];
  const parsed = parseCustomerDailyHandlingEvents([...events, events[0]]);
  const lists = buildCustomerDailyHandlingLists([record], parsed.transitions, events, [], period);
  const summary = buildCustomerDailyNegativeHandlingSummary([record], parsed.transitions, period).summary;
  assert.equal(lists.commentMarked.length, 2);
  assert.equal(summary.rows.filter(row => row.date >= '2026-09-26').reduce((sum, row) => sum + row.counts.comment, 0), 2);
  assert.equal(summary.day.comment, 1); assert.equal(summary.mtd.comment, 1);
  assert.equal(lists.coldMarked.length, 0);
  const unknown = {...record, first_seen_at: null};
  assert.equal(Object.hasOwn(buildCustomerDailyHandlingLists([unknown], parsed.transitions, events, [], period).commentMarked[0], 'isHistorical'), false);
  const nextMonth = {...period, reportDate: '2026-10-01', periodStart: '2026-09-30T16:00:00Z', handlingStartAt: at(28, 0), cutoffAt: '2026-10-01T10:00:00Z'};
  assert.equal(buildCustomerDailyHandlingLists([record], parsed.transitions, events, [], nextMonth).commentMarked.length, 1);
  assert.equal(buildCustomerDailyNegativeHandlingSummary([record], parsed.transitions, nextMonth).summary.mtd.comment, 0);
});

test('all output channels preserve replies, line breaks, emoji, links and handling dates without changing frozen legacy snapshots', async () => {
  const snapshot = {...collectionHandlingSnapshot(), handlingListsVersion: 1, repliedMarked: [{recordId: id(1), title: '<script>标题</script>', platform: 'douyin', url: 'https://www.douyin.com/video/1', markedAt: at(28, 9), replyContent: '=客户回复\n注意安全😀', supplementalNotes: [{body: '后补一\n后补二'}]}], commentMarked: [{recordId: id(2), title: '评论区留言', platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/2', markedAt: at(28, 10), replyContent: '', supplementalNotes: []}]};
  const before = structuredClone(snapshot);
  const text = renderCustomerDailyReportText(snapshot);
  assert.ok(text.includes('=客户回复\n注意安全😀')); assert.ok(text.includes('后补一\n后补二'));
  assert.match(text, /四、本期已回复帖子：1 条/); assert.match(text, /五、本期负面–评论区留言：1 条/);
  for (const email of [false, true]) {
    const html = renderCustomerDailyReportHtml(snapshot, {email});
    assert.ok(html.includes('=客户回复<br>注意安全😀')); assert.ok(html.includes('后补一<br>后补二'));
    assert.ok(html.includes('&lt;script&gt;标题')); assert.ok(!html.includes('<script>标题'));
    assert.match(html, /2026-09-28 09:00/);
  }
  const workbook = buildCustomerDailyReportWorkbook(snapshot), read = new workbook.constructor();
  await read.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = read.getWorksheet('本期已回复');
  assert.equal(sheet.getCell('D5').value, '=客户回复\n注意安全😀');
  assert.equal(sheet.getCell('D5').formula, undefined);
  assert.equal(sheet.getCell('E5').value, '后补一\n后补二');
  assert.equal(sheet.getCell('F5').value, '2026-09-28 09:00');
  assert.equal(sheet.getCell('B5').value.hyperlink, snapshot.repliedMarked[0].url);
  const plan = buildFeishuDailyDocumentPlan(snapshot);
  const docText = plan.batches.flatMap(batch => batch.descendants).flatMap(block => (block.text || block.heading2 || {}).elements || []).map(element => element.text_run?.content || '').join('\n');
  assert.ok(docText.includes('=客户回复\n注意安全😀')); assert.ok(docText.includes('后补一\n后补二'));
  const args = {snapshot, imageKey: 'img_test', documentUrl: 'https://example.feishu.cn/docx/report'};
  const group = buildFeishuDailyPost(args), groupText = group.zh_cn.content.flat().map(node => node.text || '').join('\n');
  assert.ok(groupText.includes('=客户回复\n注意安全😀')); assert.match(groupText, /未填写回复内容/);
  const long = buildFeishuDailyPost({...args, snapshot: {...snapshot, repliedMarked: [{...snapshot.repliedMarked[0], supplementalNotes: Array.from({length: 50}, () => ({body: '备注😀'.repeat(300)}))}]}});
  assert.ok(feishuDailyPostRequestBytes(long) <= FEISHU_DAILY_POST_MAX_BYTES);
  const longText = long.zh_cn.content.flat().map(node => node.text || '').join('\n');
  assert.match(longText, /另有 1 条本期已回复内容及回复备注/); assert.match(longText, /打开完整日报/);
  assert.deepEqual(snapshot, before);
  const legacy = collectionHandlingSnapshot();
  assert.equal(buildCustomerDailyReportWorkbook(legacy).worksheets.length, 3);
  assert.doesNotMatch(renderCustomerDailyReportText(legacy), /本期已回复|本期负面–评论区留言/);
});
