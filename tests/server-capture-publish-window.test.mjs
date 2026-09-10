import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateCapturePublishWindow} from '../server/services/capture-publish-window.js';

const STARTED = '2026-09-10T04:00:31.556+08:00';
const CREATED = '2026-09-10T03:00:00+08:00';
const TS = Date.parse(STARTED);
function task(platform = 'xiaohongshu', window = 'day', patch = {}) {
  return {id: 'task-one', task_type: 'unattended_keyword_capture', platform, started_at: STARTED, created_at: CREATED,
    metadata: {executionMode: 'unattended_plan', planSnapshot: {platform, keywords: ['安吉星'], searchFilters: {publishTime: window}}}, ...patch};
}
function record(raw, patch = {}) {
  return {external_id: 'post-one', platform: 'xiaohongshu', record_type: 'keyword_notes', keyword: '安吉星', publish_time: raw,
    payload: {items: [{noteId: 'post-one', publishDateRaw: raw, publishDateSource: 'date_element', captureTimestamp: TS + 3600000}]}, ...patch};
}
function detailRecord(raw, captureTimestamp = TS + 3600000) {
  return record(raw, {payload: {detailPayload: {noteId: 'post-one', publishDateRaw: raw, publishTime: raw, captureTimestamp}}});
}
const evaluate = (raw, changes = {}) => evaluateCapturePublishWindow({record: record(raw), task: task(), ...changes});

test('the real unattended task shape applies only to explicitly time-bounded XHS and Douyin keyword results', () => {
  for (const platform of ['xiaohongshu', 'douyin']) {
    for (const window of ['day', 'week', 'month', 'halfyear']) {
      const result = evaluateCapturePublishWindow({record: record('2025-01-05', {platform}), task: task(platform, window)});
      assert.equal(result.applies, true);
      assert.equal(result.status, 'out_of_range');
      assert.equal(result.window, window);
      assert.equal(result.referenceTimestamp, TS);
      assert.equal(result.referenceSource, 'started_at');
      assert.equal(result.source, 'payload.items[0].publishDateRaw');
    }
  }
});

test('single posts, bloggers, patrol workflows, other platforms and unknown tasks preserve existing ingestion', () => {
  const cases = [
    {record: record('2025-01-05', {record_type: 'single_note'})},
    {record: record('2025-01-05', {record_type: 'blogger_profile'})},
    {record: record('2025-01-05', {platform: 'weibo'})},
    {task: null}, {task: task('douyin')},
    ...['negative_post_patrol', 'watched_content_patrol', 'followed_creator_patrol', 'official_comment_patrol'].map(workflow => ({task: task('xiaohongshu', 'day', {
      metadata: {...task().metadata, workflow},
    })})),
    {task: task('xiaohongshu', 'day', {task_type: 'capture', feature_key: 'capture.comments'})},
    {task: task('xiaohongshu', 'day', {task_type: 'capture', feature_key: 'unknown'})},
  ];
  for (const changes of cases) {
    const result = evaluate('2025-01-05', changes);
    assert.equal(result.applies, false, JSON.stringify(changes));
    assert.equal(result.status, 'not_applicable');
  }
  for (const window of ['all', '', null, undefined, 'halfYear', 'unknown']) {
    const value = task();
    value.metadata.planSnapshot.searchFilters.publishTime = window;
    const result = evaluate('2025-01-05', {task: value});
    assert.equal(result.status, 'not_applicable');
    assert.equal(result.reason, ['halfYear', 'unknown'].includes(window) ? 'time_window_unsupported' : 'time_window_unrestricted');
  }
});

test('projected plans and database JSON metadata work, while client filters never override an authoritative plan', () => {
  const projected = task('xiaohongshu', 'day', {plan_snapshot: {platform: 'xiaohongshu', keywords: ['安吉星'], searchFilters: {publishTime: 'week'}}});
  assert.equal(evaluate('2026-09-05', {task: projected}).status, 'in_range');
  const explicitAll = {...projected, plan_snapshot: {searchFilters: {publishTime: 'all'}}};
  const spoofed = record('2025-01-05', {payload: {...record('2025-01-05').payload, searchFilters: {publishTime: 'day'}}});
  assert.equal(evaluate('2025-01-05', {task: explicitAll, record: spoofed}).status, 'not_applicable');
  assert.equal(evaluate('2025-01-05', {task: {...task(), metadata: JSON.stringify(task().metadata)}}).status, 'out_of_range');
  assert.equal(evaluate('2025-01-05', {record: {...record('2025-01-05'), payload: JSON.stringify(record('2025-01-05').payload)}}).status, 'out_of_range');
  for (const kind of [
    {task_type: 'capture_orchestration', feature_key: 'keyword_orchestration'},
    {task_type: 'capture', feature_key: 'capture.search'},
    {task_type: 'capture', execution_mode: 'keyword'},
    {task_type: 'search_capture'},
  ]) assert.equal(evaluate('2025-01-05', {task: {...task(), ...kind}}).applies, true);
});

test('the server keyword scope excludes unrelated manual results even when they carry the active task id', () => {
  for (const keyword of [undefined, '', '   ', '其他关键词', '安吉星 汽车']) {
    const result = evaluate('2025-01-05', {record: record('2025-01-05', {keyword})});
    assert.equal(result.status, 'not_applicable', String(keyword));
    assert.equal(result.applies, false);
  }
  assert.equal(evaluate('2025-01-05', {record: record('2025-01-05', {keyword: ' 安吉星 '})}).status, 'out_of_range');
  const legacy = task();
  delete legacy.metadata.planSnapshot.keywords;
  legacy.metadata.keywords = ['安吉星'];
  assert.equal(evaluate('2025-01-05', {task: legacy}).status, 'out_of_range');
  for (const keywords of [[], ['其他关键词'], null, '安吉星']) {
    const scoped = structuredClone(legacy);
    scoped.metadata.planSnapshot.keywords = keywords;
    assert.equal(evaluate('2025-01-05', {task: scoped}).status, 'not_applicable');
  }
  delete legacy.metadata.keywords;
  assert.equal(evaluate('2025-01-05', {task: legacy}).reason, 'task_keyword_mismatch');
});

test('exact timestamps use a fixed 24-hour cutoff rather than delayed upload time', () => {
  const cutoff = TS - 86400000;
  const boundary = new Date(cutoff).toISOString();
  const justOld = new Date(cutoff - 1).toISOString();
  const justNew = new Date(cutoff + 1).toISOString();
  for (const now of [STARTED, '2026-09-15T12:00:00+08:00']) {
    assert.equal(evaluate(boundary, {now}).status, 'in_range');
    assert.equal(evaluate(justOld, {now}).status, 'out_of_range');
    assert.equal(evaluate(justNew, {now}).status, 'in_range');
    assert.equal(evaluate(boundary, {now}).cutoffTimestamp, cutoff);
  }
  assert.equal(evaluate('2026-09-09 04:00:31.556').publishTimestamp, cutoff);
  assert.equal(evaluate('2026-09-08T20:00:31.556Z').publishTimestamp, cutoff);
  assert.equal(evaluate('2026-09-09T04:00:31.556+0800').publishTimestamp, cutoff);
});

test('date-only values retain the whole Shanghai boundary day even if a derived midnight value exists', () => {
  assert.equal(evaluate('2026-09-09').status, 'in_range');
  assert.equal(evaluate('2026-09-08').status, 'out_of_range');
  const result = evaluate('ignored', {record: record('2026-09-09', {payload: {
    items: [{publishDateRaw: '2026-09-09', publishDateSource: 'date_element', publishTime: '2026-09-09T00:00:00+08:00'}],
  }})});
  assert.equal(result.status, 'in_range');
  assert.equal(result.precision, 'day');
  assert.equal(result.publishTimestamp, Date.parse('2026-09-09T00:00:00+08:00'));
  assert.equal(result.publishEndTimestamp, Date.parse('2026-09-10T00:00:00+08:00'));
  const midnight = task('xiaohongshu', 'day', {started_at: '2026-09-10T00:00:00+08:00'});
  assert.equal(evaluate('2026-09-08', {task: midnight}).status, 'out_of_range');
  assert.equal(evaluate('2026-09-09', {task: midnight}).status, 'in_range');
});

test('minute and second labels keep a partially overlapping boundary interval instead of guessing omitted precision', () => {
  assert.equal(evaluate('2026-09-09 04:00').status, 'in_range');
  assert.equal(evaluate('2026-09-09 03:59').status, 'out_of_range');
  assert.equal(evaluate('2026-09-09 04:00:31').status, 'in_range');
  assert.equal(evaluate('2026-09-09 04:00:30').status, 'out_of_range');
  assert.equal(evaluate('2026-09-09 04:00:31.000').status, 'out_of_range');
  const minute = evaluate('2026-09-09 04:00');
  assert.equal(minute.precision, 'minute');
  assert.equal(minute.publishEndTimestamp - minute.publishTimestamp, 60000);
  const relative = evaluate('昨天 04:00', {record: record('昨天 04:00', {payload: {
    publishDateRaw: '昨天 04:00', publishDateSource: 'date_element', captureTimestamp: TS + 3600000,
  }})});
  assert.equal(relative.status, 'in_range');
  assert.equal(relative.precision, 'minute');
  const exactMinute = task('xiaohongshu', 'day', {started_at: '2026-09-10T04:01:00.000+08:00'});
  assert.equal(evaluate('2026-09-09 04:00', {task: exactMinute}).status, 'out_of_range');
  assert.equal(evaluate('2026-09-09 04:01', {task: exactMinute}).status, 'in_range');
});

test('week, 30-day month and six-calendar-month windows preserve boundaries including month-end leap years', () => {
  for (const [window, old, retained] of [['week', '2026-09-02', '2026-09-03'], ['month', '2026-08-10', '2026-08-11'], ['halfyear', '2026-03-09', '2026-03-10']]) {
    assert.equal(evaluate(old, {task: task('xiaohongshu', window)}).status, 'out_of_range');
    assert.equal(evaluate(retained, {task: task('xiaohongshu', window)}).status, 'in_range');
  }
  for (const [year, before, boundary] of [[2026, '2026-02-27', '2026-02-28'], [2024, '2024-02-28', '2024-02-29']]) {
    const plan = task('xiaohongshu', 'halfyear', {started_at: `${year}-08-31T12:00:00+08:00`});
    assert.equal(evaluate(before, {task: plan}).status, 'out_of_range');
    assert.equal(evaluate(boundary, {task: plan}).status, 'in_range');
  }
});

test('detail dates take priority over stale list dates and a differently normalized record field', () => {
  const result = evaluate('2026-09-10', {record: record('2026-09-10', {payload: {
    items: [{publishDateRaw: '2026-09-10'}], detailPayload: {noteId: 'post-one', publishTime: '2025-06-12 18:30'},
  }})});
  assert.equal(result.status, 'out_of_range');
  assert.equal(result.source, 'payload.detailPayload.publishTime');
  assert.equal(result.publishTimeRaw, '2025-06-12 18:30');
  const nested = record('2025-06-12', {payload: {items: [null, {publishDateRaw: '2025-06-12', detailPayload: {publishDateRaw: '2026-09-10'}}]}});
  assert.equal(evaluate('ignored', {record: nested}).status, 'in_range');
  assert.equal(evaluate('ignored', {record: nested}).source, 'payload.items[1].detailPayload.publishDateRaw');
  const invalidDetail = record('2025-06-12', {payload: {items: [{publishDateRaw: '2025-06-12'}], detailPayload: {publishTime: '编辑于 2026-09-10'}}});
  assert.equal(evaluate('ignored', {record: invalidDetail}).status, 'unverified');
  for (const publishTime of ['25小时前', '昨天']) {
    const detail = record('2025-01-05', {payload: {detailPayload: {publishTime, captureTimestamp: TS + 3600000}}});
    assert.equal(evaluate('ignored', {record: detail}).reason, 'detail_publish_time_not_absolute');
  }
  const wrongPost = record('2025-01-05', {payload: {detailPayload: {publishDateRaw: '2025-01-05', noteId: 'different-post'}}});
  assert.equal(evaluate('ignored', {record: wrongPost}).reason, 'publish_source_identity_mismatch');
  const rawPriority = record('2026-09-10', {payload: {publishTime: '2026-09-10', detailPayload: {publishDateRaw: '2025-01-05'}}});
  assert.equal(evaluate('ignored', {record: rawPriority}).publishTimeRaw, '2025-01-05');
});

test('XHS list dates require an explicit date element source; detail dates and Douyin retain their own date contracts', () => {
  for (const publishDateSource of [undefined, '', 'unknown', 'author_line', 'content', 'title_guess']) {
    const item = {publishDateRaw: '2025-01-05', publishDateSource};
    assert.equal(evaluate('ignored', {record: record('2025-01-05', {payload: {items: [item]}})}).reason, 'publish_source_untrusted');
    assert.equal(evaluate('ignored', {record: record('2025-01-05', {payload: item})}).reason, 'publish_source_untrusted');
  }
  const noSource = {items: [{publishDateRaw: '2025-01-05'}]};
  assert.equal(evaluate('ignored', {record: record('2025-01-05', {platform: 'douyin', payload: noSource}), task: task('douyin')}).status, 'out_of_range');
  assert.equal(evaluate('ignored', {record: record('2025-01-05', {payload: {detailPayload: {publishDateRaw: '2025-01-05'}}})}).status, 'out_of_range');
});

test('relative times require captured-time evidence and never anchor to task start or delayed ingestion', () => {
  const captured = Date.parse('2026-09-10T12:00:00+08:00');
  const incoming = record('25小时前', {capture_timestamp: String(captured), payload: {items: [{publishDateRaw: '25小时前', publishDateSource: 'date_element'}]}});
  const result = evaluate('ignored', {record: incoming, now: '2026-09-15T12:00:00+08:00'});
  assert.equal(result.status, 'in_range', 'captured 25 hours ago is still newer than the fixed task cutoff');
  assert.equal(result.publishTimestamp, captured - 25 * 3600000);
  const old = {...incoming, payload: {items: [{publishDateRaw: '33小时前', publishDateSource: 'date_element'}]}};
  assert.equal(evaluate('ignored', {record: old}).status, 'out_of_range');
  const missing = record('33小时前', {payload: {publishDateRaw: '33小时前', publishDateSource: 'date_element'}});
  assert.equal(evaluate('ignored', {record: missing}).reason, 'relative_reference_missing');
  assert.equal(evaluate('ignored', {record: {...missing, capture_timestamp: '2025-01-01T00:00:00Z'}}).status, 'unverified');
});

test('relative calendar days are whole days and remain safe across capture midnight', () => {
  const plan = task('xiaohongshu', 'day', {started_at: '2026-09-10T23:59:00+08:00'});
  const observed = Date.parse('2026-09-11T00:01:00+08:00');
  const relative = raw => evaluate(raw, {task: plan, record: record(raw, {payload: {publishDateRaw: raw, publishDateSource: 'date_element', captureTimestamp: observed}})});
  assert.equal(relative('昨天').status, 'in_range');
  assert.equal(relative('2天前').status, 'in_range');
  assert.equal(relative('3天前').status, 'out_of_range');
  assert.equal(relative('昨天 00:05').precision, 'minute');
  assert.equal(relative('昨天 25:00').status, 'unverified');
});

test('missing sources, title guesses, edited timestamps and invalid calendar values cannot fall back to ingestion time', () => {
  for (const raw of ['', '9-10月旅游', '9-10', '12:05', '2025-02-29', '2026-02-30', '2026-13-01',
    '2026-01-32', '2026-1/2', '2025-01-05 团购活动', '2025-01-05T24:00:00Z',
    '2025-01-05T10:00:60Z', '2025-01-05T10:00:00+15:00', '编辑于 未知', '更新于 昨天']) {
    assert.equal(evaluate(raw).status, 'unverified', raw);
  }
  for (const payload of [{}, {title: '2025-01-05', content: '2025-01-05'}, {lastEditedAt: '2025-01-05'}, 'invalid json']) {
    assert.equal(evaluate('2025-01-05', {record: record('2025-01-05', {payload})}).reason, 'publish_source_missing');
  }
  assert.equal(evaluate('ignored', {record: record('2025-01-05', {payload: {publishDateRaw: '2025-01-05', publishDateSource: 'title_guess'}})}).reason, 'publish_source_untrusted');
  assert.equal(evaluate('ignored', {record: record('2025-01-05', {payload: {publishDateRaw: '2025-01-05', publishDateSource: 'date_element', noteId: 'different-post'}})}).reason, 'publish_source_identity_mismatch');
  assert.equal(evaluate('2030-01-01').reason, 'publish_time_future_or_invalid');
});

test('strict supported dates accept explicit publication prefixes and known location suffixes', () => {
  for (const raw of ['2025-01-05', '2025/1/5', '2025.1.5', '2025年1月5日', '发布于 2025-01-05 上海',
    '发布时间：2025-01-05 12:30', '发表于 2025-01-05 12:30:15']) {
    assert.equal(evaluate(raw).status, 'out_of_range', raw);
  }
  assert.equal(evaluate('2024-02-29').status, 'out_of_range');
  assert.equal(evaluate('ignored', {record: record('2026-09-09', {payload: {publishDateRaw: '2026-09-09', publishDateSource: 'date_element', publishTime: '2025-01-05'}})}).reason, 'publish_time_conflict');
});

test('a past yearless detail date is only an upper bound and never an inferred publication timestamp', () => {
  for (const raw of ['01-17', '02-12', '09-08']) {
    const result = evaluate(raw, {record: detailRecord(raw)});
    assert.equal(result.status, 'out_of_range', raw);
    assert.equal(result.reason, 'publish_year_upper_bound_before_window');
    assert.equal(result.upperBoundBasis, 'publish_yearless_date');
    assert.equal(result.upperBoundExclusive, true);
    assert.equal(result.publishTimestamp, null);
    assert.equal(result.publishEndTimestamp, null);
    assert.equal(result.publishTimeRaw, raw);
  }
  for (const raw of ['09-09', '09-10']) {
    const result = evaluate(raw, {record: detailRecord(raw)});
    assert.equal(result.status, 'unverified', raw);
    assert.equal(result.reason, 'publish_year_upper_bound_not_proven');
    assert.ok(result.upperBoundTimestamp > result.cutoffTimestamp);
  }
  for (const raw of ['09-11', '12-31', '02-29', '02-30', '13-01', '09-08 04:00', '09/08', '01-17 团购']) {
    const result = evaluate(raw, {record: detailRecord(raw)});
    assert.equal(result.status, 'unverified', raw);
    assert.equal(result.upperBoundTimestamp, null);
  }
  const missingCapture = detailRecord('01-17', null);
  missingCapture.payload.captureTimestamp = TS + 3600000;
  assert.equal(evaluate('01-17', {record: missingCapture}).upperBoundTimestamp, null, 'a list observation cannot date a later detail view');
});

test('yearless upper bounds use the source observation year across New Year and ignore delayed upload time', () => {
  const newYearTask = task('xiaohongshu', 'day', {started_at: '2026-12-31T23:59:00+08:00'});
  const capture = Date.parse('2027-01-01T00:01:00+08:00');
  const january = evaluate('01-01', {task: newYearTask, record: detailRecord('01-01', capture)});
  assert.equal(january.status, 'unverified');
  assert.equal(january.upperBoundTimestamp, Date.parse('2027-01-02T00:00:00+08:00'));
  assert.equal(evaluate('12-31', {task: newYearTask, record: detailRecord('12-31', capture)}).upperBoundTimestamp, null);
  const input = {record: detailRecord('01-17'), task: task()};
  const original = evaluateCapturePublishWindow(input);
  assert.deepEqual(evaluateCapturePublishWindow({...input, now: '2027-09-10T00:00:00Z'}), original);
  const leapTask = task('xiaohongshu', 'day', {started_at: '2024-03-01T12:00:00+08:00'});
  const leapCapture = Date.parse('2024-03-01T13:00:00+08:00');
  assert.equal(evaluate('02-29', {task: leapTask, record: detailRecord('02-29', leapCapture)}).status, 'unverified');
  assert.equal(evaluate('02-28', {task: leapTask, record: detailRecord('02-28', leapCapture)}).status, 'out_of_range');
});

test('old edit dates prove expiry only as upper bounds; recent edits cannot prove recent publication', () => {
  for (const raw of ['编辑于 2025-05-16', '编辑于 05-30', '更新于 07-18', '编辑于 2025-05-16 上海']) {
    const result = evaluate(raw, {record: detailRecord(raw)});
    assert.equal(result.status, 'out_of_range', raw);
    assert.equal(result.reason, 'edited_upper_bound_before_window');
    assert.equal(result.publishTimestamp, null);
    assert.equal(result.publishEndTimestamp, null);
    assert.equal(result.upperBoundExclusive, true);
  }
  for (const raw of ['编辑于 2026-09-10', '编辑于 09-09', '编辑于 09-10']) {
    const result = evaluate(raw, {record: detailRecord(raw)});
    assert.equal(result.status, 'unverified', raw);
    assert.equal(result.reason, 'edited_upper_bound_not_proven');
    assert.ok(result.upperBoundTimestamp > result.cutoffTimestamp);
    assert.equal(result.publishTimestamp, null);
  }
  const cutoff = TS - 86400000;
  const atCutoff = `编辑于 ${new Date(cutoff).toISOString()}`;
  const beforeCutoff = `编辑于 ${new Date(cutoff - 1).toISOString()}`;
  assert.equal(evaluate(atCutoff, {record: detailRecord(atCutoff)}).status, 'unverified');
  assert.equal(evaluate(beforeCutoff, {record: detailRecord(beforeCutoff)}).status, 'out_of_range');
  assert.equal(evaluate('编辑于 2025-05-16').status, 'out_of_range', 'a dedicated list date element also supplies a reliable edit bound');
  assert.equal(evaluate('编辑于 05-30').status, 'unverified', 'yearless bounds are restricted to detail date evidence');
  const conflict = detailRecord('编辑于 2025-05-16');
  conflict.payload.detailPayload.publishTime = '2026-09-10';
  assert.equal(evaluate('ignored', {record: conflict}).reason, 'publish_time_conflict');
});

// Date fields and observation times preserved from the 23-record read-only
// incident replay on 2026-09-10. Content, authors and identifiers are omitted.
const INCIDENT_DATE_EVIDENCE = [
  ['编辑于 2025-05-16', 1788985868402], ['2025-08-07', 1788984927355],
  ['2025-08-26', 1788987650394], ['2025-08-26', 1788984683378],
  ['2025-10-24', 1788984627356], ['2025-11-10', 1788985946382],
  ['01-17', 1788985996405], ['01-20', 1788984346347], ['01-21', 1788987763413],
  ['01-21', 1788987706395], ['01-28', 1788984283347], ['02-12', 1788986058371],
  ['03-13', 1788986695401], ['03-17', 1788986118372], ['03-21', 1788984172353],
  ['05-03', 1788986410603], ['05-06', 1788984226349], ['05-25', 1788984399353],
  ['编辑于 05-30', 1788987596393], ['06-15', 1788986568398], ['07-11', 1788988119420],
  ['编辑于 07-18', 1788986636388], ['06-19', 1788984984637],
];

test('all 23 incident dates are rejected for day; eleven March-through-July dates remain eligible for halfyear and all', () => {
  assert.equal(INCIDENT_DATE_EVIDENCE.length, 23);
  let rejectedDay = 0, rejectedHalfyear = 0, retainedHalfyear = 0;
  for (const [index, [raw, capture]] of INCIDENT_DATE_EVIDENCE.entries()) {
    const started_at = index === 22 ? '2026-09-10T04:11:31.057+08:00' : STARTED;
    const incoming = detailRecord(raw, capture);
    const original = structuredClone(incoming);
    const day = evaluate(raw, {record: incoming, task: task('xiaohongshu', 'day', {started_at})});
    assert.equal(day.status, 'out_of_range', `incident ${index}: ${raw}`);
    rejectedDay += 1;
    const halfyear = evaluate(raw, {record: incoming, task: task('xiaohongshu', 'halfyear', {started_at})});
    if (index < 12) {
      assert.equal(halfyear.status, 'out_of_range', raw);
      rejectedHalfyear += 1;
    } else {
      assert.equal(halfyear.status, 'unverified', raw);
      assert.ok(halfyear.upperBoundTimestamp > halfyear.cutoffTimestamp);
      retainedHalfyear += 1;
    }
    const unlimited = evaluate(raw, {record: incoming, task: task('xiaohongshu', 'all', {started_at})});
    assert.equal(unlimited.status, 'not_applicable');
    assert.equal(unlimited.reason, 'time_window_unrestricted');
    assert.deepEqual(incoming, original);
  }
  assert.deepEqual({rejectedDay, rejectedHalfyear, retainedHalfyear}, {rejectedDay: 23, rejectedHalfyear: 12, retainedHalfyear: 11});
  for (const raw of ['2026-03-10', '2026-03-13', '2026-05-30', '2026-07-18', '2026-09-10']) {
    assert.equal(evaluate(raw, {record: detailRecord(raw), task: task('xiaohongshu', 'halfyear')}).status, 'in_range', raw);
  }
});

test('reference falls back only to the task creation timestamp and is never synthesized from now', () => {
  const created = task('xiaohongshu', 'day', {started_at: null});
  const result = evaluate('2026-09-09 03:30', {task: created});
  assert.equal(result.referenceSource, 'created_at');
  assert.equal(result.referenceTimestamp, Date.parse(CREATED));
  assert.equal(result.status, 'in_range');
  assert.equal(evaluate('2026-09-09 03:30').status, 'out_of_range');
  assert.equal(evaluate('2025-01-05', {task: {...created, created_at: 'invalid'}, now: STARTED}).reason, 'task_reference_missing');
  assert.equal(evaluate('2025-01-05', {task: {...created, created_at: new Date(CREATED)}}).referenceTimestamp, Date.parse(CREATED));
});

test('date decisions are identical across server timezones and evaluation is pure', () => {
  const originalTimezone = process.env.TZ;
  const input = {record: record('2026-09-09 04:00:31.556'), task: task(), now: '2026-09-15T12:00:00+08:00'};
  const before = structuredClone(input);
  const expected = evaluateCapturePublishWindow(input);
  try {
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = timezone;
      assert.deepEqual(evaluateCapturePublishWindow(input), expected, timezone);
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  assert.deepEqual(input, before);
  const originalNow = Date.now;
  try {
    Date.now = () => {throw new Error('wall clock must not be consulted');};
    assert.equal(evaluate('2025-01-05').status, 'out_of_range');
  } finally {Date.now = originalNow;}
});
