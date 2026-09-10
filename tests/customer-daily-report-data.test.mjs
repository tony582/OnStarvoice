import assert from 'node:assert/strict';
import test from 'node:test';
import {customerDailyBusinessPeriod} from '../server/services/customer-daily-business-period.js';
import {
  dailyPeriod, collectCustomerDailyReport, assessCustomerDailyObservation, parseCustomerDailyColdEvents, assessCustomerDailyCaptureReadiness,
  renderCustomerDailyReportHtml, renderCustomerDailyReportText, buildCustomerDailyReportWorkbook,
} from '../server/services/customer-daily-report-data.js';

const ID = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const tenantId = ID(999);
const now = new Date('2026-09-08T03:00:00Z');
const opts = {tenantId, now};
const d = (day, time = '03:00:00') => `2026-09-${String(day).padStart(2, '0')}T${time}Z`;
const fields = ['likes', 'comments_count', 'collects', 'shares'];
function record(n, patch = {}) {
  return {id: ID(n), first_seen_at: d(7), published_ts: d(7), record_type: 'single_note',
    sentiment: 'negative', status: 'unhandled', platform: 'xiaohongshu', title: `帖子${n}`,
    url: `https://www.xiaohongshu.com/explore/${n}`, business_visibility: 'eligible', ...patch};
}
function observation(n, heat, time, patch = {}) {
  const values = {likes: heat - 30, comments_count: 10, collects: 10, shares: 10};
  return {id: ID(n + 500), record_id: ID(n), captured_at: time, ...values,
    payload: {customerDailyMetricEvidence: {version: 1, observedAt: time, timeSource: 'capture_timestamp',
      metrics: Object.fromEntries(fields.map(k => [k, {value: values[k], measured: true, reason: 'observed'}])), allMeasured: true}}, ...patch};
}
function event(n, previous, next = 'negative_cold', patch = {}) {
  return {id: ID(n + 800), target_id: ID(n), created_at: d(7), action: 'record.triage_updated', metadata: {previousStatus: previous, nextStatus: next}, ...patch};
}
function fakeDb(seed = {}) {
  const calls = [];
  return {calls,
    async queryOne(sql, params) {
      calls.push({sql, params});
      if (sql.includes('customer_daily:tenant')) return {name: '测试客户'};
      if (sql.includes('customer_daily:missing_published')) return {count: seed.missingPublished || 0};
      if (sql.includes('customer_daily:audit_coverage')) return seed.coverage === null ? null : {applied_at: seed.coverage || d(1)};
      throw new Error(`Unexpected queryOne ${sql}`);
    },
    async queryAll(sql, params) {
      calls.push({sql, params});
      if (sql.includes('customer_daily:month')) return seed.month || [];
      if (sql.includes('customer_daily:heat_posts')) return seed.heatPosts || [];
      if (sql.includes('customer_daily:observations')) return seed.observations || [];
      if (sql.includes('customer_daily:cold_events')) return seed.events || [];
      if (sql.includes('customer_daily:cold_posts')) return seed.coldPosts || [];
      if (sql.includes('customer_daily:pending_capture')) return seed.pending || [];
      throw new Error(`Unexpected queryAll ${sql}`);
    },
  };
}

test('Shanghai report date defaults to yesterday; realtime ends now and rolls across month/year', () => {
  assert.deepEqual(dailyPeriod(undefined, now), {
    reportDate: '2026-09-07', periodStart: '2026-09-06T16:00:00.000Z', cutoffAt: '2026-09-07T16:00:00.000Z',
    assessedAt: now.toISOString(), monthStart: '2026-08-31T16:00:00.000Z', heatStart: '2026-08-31T16:00:00.000Z', mode: 'formal',
  });
  assert.equal(dailyPeriod('2026-09-08', now).cutoffAt, now.toISOString());
  assert.equal(dailyPeriod('2026-09-08', now).heatStart, '2026-09-01T03:00:00.000Z');
  assert.equal(dailyPeriod('2026-09-08', now).mode, 'realtime');
  assert.equal(dailyPeriod(undefined, '2026-08-31T16:00:00Z').reportDate, '2026-08-31');
  assert.equal(dailyPeriod(undefined, '2025-12-31T16:00:00Z').reportDate, '2025-12-31');
  for (const invalid of ['2026-02-30', '2026-9-7', 'junk', '2026-09-09']) assert.throws(() => dailyPeriod(invalid, now));
});

test('day and MTD count customer-visible first inserts once and subtract customer non-monitor decisions', async () => {
  const month = [record(1, {sentiment: 'positive'}), record(2, {status: 'negative_cold'}),
    record(3, {sentiment: 'neutral', business_visibility: 'filtered_out'}), record(4, {status: 'reviewed_non_monitor'}),
    record(5, {first_seen_at: d(2), status: 'negative_cold'}),
    record(6, {first_seen_at: '2026-08-31T10:00:00Z'}),
    record(7, {first_seen_at: '2026-09-07T16:00:00Z'}),
    record(8, {record_type: 'official_content'}), record(9, {record_type: 'blogger_profile'}), record(10, {record_type: 'comment'}),
    record(11, {sentiment: '', business_visibility: 'deferred'}), record(1, {sentiment: 'positive'}),
    record(12,{relevance:'irrelevant'}),record(13,{relevance:'irrelevant',watched:true,sentiment:'neutral'})];
  const db = fakeDb({month});
  const report = await collectCustomerDailyReport({...opts, db});
  assert.deepEqual(report.summary.day, {monitor: 4, sdb: 3, positive: 1, neutral: 1, negative: 1, cold: 1, comment: 0, negativeProcess: 0, negativeOther: 0, nonMonitor: 1, unclassified: 0, inProgress: null, processed: null});
  assert.equal(report.summary.mtd.monitor, 5);
  assert.equal(report.summary.mtd.cold, 2);
  assert.equal(report.summary.mtd.sdb, report.summary.mtd.positive + report.summary.mtd.neutral + report.summary.mtd.negative + report.summary.mtd.unclassified);
  assert.equal(report.summary.day.monitor, report.summary.day.sdb + report.summary.day.nonMonitor);
  assert.ok(!report.warnings.some(w => w.code === 'unclassified' || w.code === 'audit_visible_posts_included'));
  assert.equal(report.evidence.firstSeenField, 'records.created_at');
  const query = db.calls.find(q => q.sql.includes('customer_daily:month'));
  assert.equal(query.params[0], tenantId);
  assert.match(query.sql, /r.business_visibility = 'eligible'/);
  assert.match(query.sql, /relevance.*IS DISTINCT FROM 'irrelevant'/);
  assert.match(query.sql, /daily_watched.tenant_id=r.tenant_id/);
});

test('morning new posts belong to today realtime and G corrections apply to yesterday without moving posts', async () => {
  const yesterday = record(1, {status: 'negative_cold'});
  const today = record(2, {first_seen_at: d(8, '01:00:00'), sentiment: 'positive'});
  const prior = await collectCustomerDailyReport({...opts, db: fakeDb({month: [yesterday, today]})});
  const realtime = await collectCustomerDailyReport({...opts, date: '2026-09-08', db: fakeDb({month: [yesterday, today]})});
  assert.equal(prior.summary.day.monitor, 1); assert.equal(prior.summary.day.cold, 1);
  assert.equal(realtime.summary.day.monitor, 1); assert.equal(realtime.summary.day.positive, 1);
  assert.equal(realtime.summary.mtd.monitor, 2);
  const corrected = await collectCustomerDailyReport({...opts, db: fakeDb({month: [{...yesterday, sentiment: 'positive'}, today]})});
  assert.equal(corrected.summary.day.cold, 0);
  assert.equal(corrected.summary.day.positive, 1);
  assert.ok(corrected.warnings.some(w => w.code === 'sentiment_status_conflict' && w.blocking));
  assert.equal(prior.summary.day.cold, 1, 'saved in-memory snapshot does not mutate');
});

test('heat includes every qualifying post (including first capture), enforces exact 168h and >=200', async () => {
  const heatPosts = [record(1), record(2), record(3), record(4), record(5, {published_ts: '2026-08-31T16:00:00Z'}),
    record(6, {published_ts: '2026-08-31T15:59:59Z'}), record(7, {published_ts: '2026-09-07T16:00:00Z'}),
    record(8, {first_seen_at: '2026-09-07T16:00:00Z'}), record(9, {status: 'reviewed_non_monitor'}),
    record(10, {status: 'unavailable'})];
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts,
    observations: heatPosts.map((r, i) => observation(i + 1, [320, 85, 42, 200, 201, 900, 900, 900, 900, 250][i], d(7)))} )});
  assert.deepEqual(report.highHeat.map(p => p.heat), [320, 250, 201, 200]);
  assert.equal(report.highHeat.find(p => p.recordId === ID(10)).status, 'unavailable');
  assert.equal(report.highHeat[0].comparisonText, '暂无昨日数据');
  assert.equal(report.summary.day.monitor, 0, 'patrol heat does not affect first-insert summary');
});

test('daily comparisons use measured same-day endpoints, permit falls, and handle zero baseline', async () => {
  const today1 = observation(1, 320, d(7));
  const yesterday1 = observation(1, 400, d(6), {id: ID(601)});
  const zero = observation(2, 30, d(6), {id: ID(602)});
  for (const k of fields) { zero[k] = 0; zero.payload.customerDailyMetricEvidence.metrics[k].value = 0; }
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1), record(2)],
    observations: [today1, yesterday1, observation(2, 320, d(7)), zero]})});
  assert.equal(report.highHeat[0].comparisonText, '↓20%');
  assert.equal(report.highHeat[0].previousHeat, 400);
  assert.equal(report.highHeat[1].comparisonText, '由0增至320');
});

test('one-day observations never substitute task deltas, carry-forward values, next-midnight rows or old days', async () => {
  const old = observation(1, 500, d(6));
  const incomplete = observation(1, 700, d(7), {id: ID(701)});
  incomplete.payload.customerDailyMetricEvidence.allMeasured = false;
  incomplete.payload.customerDailyMetricEvidence.metrics.shares.measured = false;
  const midnight = observation(1, 900, '2026-09-07T16:00:00Z', {id: ID(702)});
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1)], observations: [incomplete, midnight, old]})});
  assert.equal(report.highHeat[0].heat, 500);
  assert.equal(report.highHeat[0].stale, true);
  assert.equal(report.highHeat[0].comparisonText, '暂无本日数据');
  assert.equal(report.highHeat[0].previousHeat, null);
});

test('observation quality permits explicit legacy totals but never legacy percentages or fabricated missing zero', () => {
  const legacy = observation(1, 320, d(7), {payload: {syncType: 'single_note', likes: 290, comments: 10, collects: 10, shares: 10}});
  const result = assessCustomerDailyObservation(legacy);
  assert.equal(result.heat, 320); assert.equal(result.quality, 'legacy_unverified'); assert.equal(result.comparable, false);
  assert.equal(assessCustomerDailyObservation({...legacy, payload: {likes: 290, comments: 10, collects: 10}}).heat, null);
  assert.equal(assessCustomerDailyObservation({...legacy, shares: null}).heat, null);
  const zeroPlaceholders = {...legacy, likes: 320, comments_count: 0, collects: 0, shares: 0,
    payload: {syncType: 'keyword_notes', likes: 320, comments: 0, collects: 0, shares: 0, displayMetricDimension: 'likes', displayMetricCount: 320}};
  assert.equal(assessCustomerDailyObservation(zeroPlaceholders).heat, null);
  const untrustedTime = observation(1, 320, d(7));
  untrustedTime.payload.customerDailyMetricEvidence.observedAt = d(8);
  assert.equal(assessCustomerDailyObservation(untrustedTime).comparable, false);
  assert.equal(assessCustomerDailyObservation(untrustedTime).timeSource, 'ingested_at');
  const mismatched = observation(1, 320, d(7)); mismatched.likes++;
  assert.equal(assessCustomerDailyObservation(mismatched).heat, null);
});

test('legacy and unverified measurement times retain heat but show a brief comparison placeholder', async () => {
  const legacy = observation(1, 320, d(7), {payload: {syncType: 'single_note', likes: 290, comments: 10, collects: 10, shares: 10}});
  const unverifiedTime = observation(2, 320, d(7));
  unverifiedTime.payload.customerDailyMetricEvidence.observedAt = null;
  unverifiedTime.payload.customerDailyMetricEvidence.timeSource = 'ingested_at';
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1), record(2)],
    observations: [legacy, unverifiedTime, observation(1, 300, d(6)), observation(2, 300, d(6))]})});
  assert.deepEqual(report.highHeat.map(post => post.heat), [320, 320]);
  assert.deepEqual(new Set(report.highHeat.map(post => post.quality)), new Set(['legacy_unverified', 'measured_ingestion_time']));
  for (const post of report.highHeat) {
    assert.equal(post.comparisonText, '暂无可比数据');
    assert.equal(post.previousHeat, null);
    assert.equal(post.previousObservedAt, null);
  }
});

test('a fully measured decrease remains negative while a later guarded correction cannot replace it', async () => {
  const previous = observation(1, 500, d(6), {id: ID(600)});
  const measured = observation(1, 450, d(7, '10:00:00'), {id: ID(700)});
  const guarded = observation(1, 30, d(7, '12:00:00'), {id: ID(701)});
  guarded.payload.customerDailyMetricEvidence.allMeasured = false;
  guarded.payload.customerDailyMetricEvidence.metrics.comments_count = {value:null, measured:false, reason:'preserved'};
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1)], observations: [guarded, measured, previous]})});
  assert.equal(report.highHeat[0].heat, 450);
  assert.equal(report.highHeat[0].comparisonText, '↓10%');
  assert.equal(report.highHeat[0].previousHeat, 500);
  assert.equal(report.highHeat[0].observationId, measured.id);
});

test('observation timestamp rather than upload day governs day comparison', async () => {
  const delayed = observation(1, 320, d(7));
  delayed.payload.customerDailyMetricEvidence.observedAt = d(6);
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1)], observations: [delayed]})});
  assert.equal(report.highHeat[0].stale, true);
  assert.equal(report.highHeat[0].observedAt, new Date(d(6)).toISOString());
  assert.equal(report.highHeat[0].comparisonText, '暂无本日数据');
});

test('cold parser accepts true single and batch transitions; same state and missing prior state are not new', () => {
  const parsed = parseCustomerDailyColdEvents([event(1, 'unhandled'), event(2, 'negative_cold'),
    event(3, 'unhandled', 'replied'), event(4, undefined),
    {id: ID(900), action: 'record.triage_batch_updated', created_at: d(7), metadata: {status: 'negative_cold', recordIds: [ID(5), ID(6), ID(7)], previous: {[ID(5)]: {status: 'negative_feishu'}, [ID(6)]: {status: 'negative_cold'}}}},
  ]);
  assert.deepEqual(parsed.transitions.map(t => t.recordId), [ID(1), ID(5)]);
  assert.equal(parsed.malformed.length, 2);
});

test('cold list includes older posts, deduplicates reentry, excludes corrections and preserves audit evidence', async () => {
  const e1 = event(1, 'unhandled'); const e1again = event(1, 'replied', 'negative_cold', {id: ID(998), created_at: d(7, '04:00:00')});
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({month: [],
    events: [e1, e1again, event(2, 'unhandled'), event(3, 'unhandled'), event(4, 'unhandled', 'negative_cold', {created_at: '2026-09-07T16:00:00Z'})],
    coldPosts: [record(1, {first_seen_at: '2026-08-20T01:00:00Z', status: 'negative_cold'}), record(2, {status: 'replied'}), record(3, {status: 'negative_cold', sentiment: 'positive'}), record(4, {status: 'negative_cold'})]})});
  assert.equal(report.coldMarked.length, 1);
  assert.equal(report.coldMarked[0].eventId, e1again.id);
  assert.equal(report.coldMarked[0].isHistorical, true);
  assert.equal(report.summary.day.cold, 0);
  assert.deepEqual(report.evidence.cold.withdrawnRecordIds, [ID(2), ID(3)]);
  assert.equal(report.evidence.cold.transitions.length, 4);
  assert.equal(report.evidence.cold.coverageComplete, true);
});

test('zero records is a report; unknown historical audit coverage never claims certain zero cold events', async () => {
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({coverage: null})});
  assert.equal(report.summary.day.monitor, 0);
  assert.equal(report.summary.day.inProgress, null);
  assert.equal(report.evidence.cold.coverageComplete, false);
  assert.ok(renderCustomerDailyReportText(report).includes('暂未检出。'));
  assert.ok(!renderCustomerDailyReportText(report).includes('本期无冷处理负面帖子'));
  const complete = await collectCustomerDailyReport({...opts, db: fakeDb()});
  assert.ok(renderCustomerDailyReportText(complete).includes('本期无冷处理负面帖子'));
});

test('Monday cold list includes weekend changes and coverage must span the whole merged interval', async () => {
  const businessPeriod=customerDailyBusinessPeriod('2026-09-14','2026-09-14T03:00:00Z');
  const db=fakeDb({coverage:'2026-09-13T16:00:00Z',
    events:[event(1,'reviewed','negative_cold',{created_at:'2026-09-12T02:00:00Z'}),
      event(2,'reviewed','negative_cold',{created_at:'2026-09-13T02:00:00Z'})],
    coldPosts:[record(1,{status:'negative_cold',first_seen_at:'2026-09-12T01:00:00Z'}),record(2,{status:'negative_cold',first_seen_at:'2026-09-10T01:00:00Z'})]});
  const report=await collectCustomerDailyReport({...opts,db,businessPeriod});
  assert.equal(report.coldMarked.length,2);
  assert.equal(report.coldMarked.find(p=>p.recordId===ID(1)).isHistorical,false,'weekend arrival belongs to Monday collection cohort');
  assert.equal(report.coldMarked.find(p=>p.recordId===ID(2)).isHistorical,true);
  assert.equal(report.evidence.cold.coverageComplete,false,'coverage starting Monday cannot prove the entire weekend');
  assert.equal(db.calls.find(q=>q.sql.includes('customer_daily:cold_events')).params[1],'2026-09-11T16:00:00.000Z');
});

test('historical cold labels use the collection start boundary and do not guess missing first-ingest times', async () => {
  const businessPeriod=customerDailyBusinessPeriod('2026-09-14','2026-09-14T03:00:00Z');
  const posts=[
    record(1,{status:'negative_cold',first_seen_at:'2026-09-11T09:59:59.999Z'}),
    record(2,{status:'negative_cold',first_seen_at:businessPeriod.collectionStartAt}),
    record(3,{status:'negative_cold',first_seen_at:undefined}),
  ];
  const report=await collectCustomerDailyReport({...opts,businessPeriod,db:fakeDb({
    coldPosts:posts,events:posts.map((_,i)=>event(i+1,'reviewed','negative_cold',{created_at:'2026-09-14T01:00:00Z'})),
  })});
  assert.equal(report.coldMarked.find(p=>p.recordId===ID(1)).isHistorical,true);
  assert.equal(report.coldMarked.find(p=>p.recordId===ID(2)).isHistorical,false);
  assert.equal(Object.hasOwn(report.coldMarked.find(p=>p.recordId===ID(3)),'isHistorical'),false);
});

test('missing source links and unsettled keyword capture are visible blockers, heat gaps are not', async () => {
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({heatPosts: [record(1, {url: 'javascript:alert(1)'}), record(2)],
    observations: [observation(1, 320, d(7))], pending: [{id: ID(99), status: 'running'}], missingPublished: 3})});
  for (const code of ['source_link_missing', 'capture_not_settled']) assert.ok(report.warnings.some(w => w.code === code && w.blocking));
  for (const code of ['heat_missing', 'published_time_missing']) assert.ok(report.warnings.some(w => w.code === code && !w.blocking));
  assert.equal(report.highHeat[0].url, '');
});

test('real generic capture, unattended children and keyword parents expose sync gaps without blocking patrol-only work', () => {
  const task = {id: ID(20), task_type: 'capture', feature_key: 'capture.search', status: 'running'};
  assert.deepEqual(assessCustomerDailyCaptureReadiness(task).reasons, ['capture_active']);
  const finishedUploadPending = {...task, status: 'completed', progress: {streamingSyncEvidenceKnown: true, streamingSyncDrainCompleted: false, streamingSyncRemainingCount: 2}};
  assert.ok(assessCustomerDailyCaptureReadiness(finishedUploadPending).reasons.includes('sync_incomplete'));
  const child = {...task, task_type: 'unattended_keyword_capture', status: 'completed', progress: {streamingSyncEnabled: true, streamingSyncEnqueuedUniqueCount: 8, streamingSyncSucceededUniqueCount: 6}};
  assert.ok(assessCustomerDailyCaptureReadiness(child).reasons.includes('sync_count_gap'));
  assert.equal(assessCustomerDailyCaptureReadiness({...task, metadata: {workflow: 'negative_post_patrol'}}), null);
  assert.equal(assessCustomerDailyCaptureReadiness({...task, feature_key: 'capture.comments'}), null);
  const parent = {...task, task_type: 'capture_orchestration', feature_key: 'keyword_orchestration', keyword_item_count: 10, unsettled_keyword_items: 0};
  assert.equal(assessCustomerDailyCaptureReadiness(parent), null, 'keyword completion is independent from an attached ongoing patrol');
  assert.ok(assessCustomerDailyCaptureReadiness({...parent, status: 'completed', unsettled_keyword_items: 2}).reasons.includes('keyword_items_incomplete'));
});

test('HTML, copy text and editable monthly workbook preserve counts, all links and external text safely', async () => {
  const injectedTitle = '=HYPERLINK("https://bad.example","<script>alert(1)</script>")';
  const rows = [1, 2, 3, 4].map(i => record(i, {status: 'negative_cold', title: i === 1 ? injectedTitle : `帖子${i}`}));
  const report = await collectCustomerDailyReport({...opts, db: fakeDb({month: rows, heatPosts: rows,
    observations: rows.map((r, i) => observation(i + 1, 320 - i, d(7))), events: rows.map((r, i) => event(i + 1, 'unhandled')), coldPosts: rows})});
  report.version = 2;
  const html = renderCustomerDailyReportHtml(report);
  const copied = renderCustomerDailyReportText(report);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('TOP4')); assert.ok(copied.includes('TOP4'));
  assert.ok(copied.includes('2026/9/7\t4\t4\t0\t0\t4\t0\t0\t0'));
  assert.doesNotMatch(copied, /复核及冷处理状态截至|观测质量|数据说明/);
  for (const row of rows) { assert.ok(copied.includes(row.url)); assert.ok(html.includes(row.url)); }
  const workbook = buildCustomerDailyReportWorkbook(report);
  assert.deepEqual(workbook.worksheets.map(s => s.name), ['日报', '高热负面', '本期冷处理']);
  const summary = workbook.getWorksheet('日报');
  assert.equal(summary.getCell('B11').value, 4);
  for (const cell of ['G11', 'H11', 'I11']) assert.equal(summary.getCell(cell).value, 0);
  assert.equal(summary.getCell('F4').value, '负面-冷处理');
  assert.equal(summary.getCell('H4').value, '负面-负面处理流程');
  assert.equal(summary.getCell('H4').isMerged, false);
  assert.deepEqual(summary.getCell('B12').value, {formula: 'SUM(B5:B11)', result: 4});
  assert.equal(workbook.getWorksheet('高热负面').getCell('B5').value.text, injectedTitle);
  assert.equal(workbook.getWorksheet('高热负面').getCell('B5').value.formula, undefined);
  assert.equal(workbook.getWorksheet('高热负面').getCell('B8').value.hyperlink, rows[3].url);
  assert.equal(workbook.getWorksheet('本期冷处理').getCell('B8').value.hyperlink, rows[3].url);
  const buffer = await workbook.xlsx.writeBuffer();
  const roundTrip = new workbook.constructor(); await roundTrip.xlsx.load(buffer);
  assert.equal(roundTrip.getWorksheet('日报').getCell('B11').value, 4);
  assert.equal(roundTrip.getWorksheet('日报').getCell('G11').value, 0);
  assert.equal(roundTrip.getWorksheet('高热负面').getCell('B5').value.text, injectedTitle);
});
