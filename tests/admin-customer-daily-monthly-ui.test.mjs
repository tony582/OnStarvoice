import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dailyPostStatusLabel, isHandlingSummary, isMonthlySummary, monthlyDraftFromRows, parseMonthlyDraft, sumMonthlyRows, visibleMonthlyRows} from '../web/admin/src/pages/insights/CustomerDailyReport.summary.mjs';

const counts = {monitor: 30, sdb: 25, positive: 3, neutral: 15, cold: 2, comment: 2, negativeProcess: 2, negativeOther: 1};
const rows = [
  {date: '2026-09-01', isWorkingDay: true, counts},
  {date: '2026-09-02', isWorkingDay: true, counts: {...counts, monitor: 40}},
  {date: '2026-09-05', isWorkingDay: false, counts: {...counts, monitor: 999}},
];

test('monthly drafts omit rest days and MTD recomputes from edited workdays', () => {
  const draft = monthlyDraftFromRows(rows);
  assert.equal(draft['2026-09-05'], undefined);
  draft['2026-09-01'].monitor = '60';
  assert.equal(sumMonthlyRows(rows, draft).monitor, 100);
  const body = parseMonthlyDraft(rows, {...draft, '2026-09-05': {monitor: '800'}});
  assert.equal(body.rows['2026-09-01'].monitor, 60);
  assert.equal(body.rows['2026-09-05'], undefined);
  assert.equal(body.mtd, undefined);
});

test('monthly inputs reject blank, fractional and unsafe counts before saving', () => {
  for (const invalid of ['', '-1', '1.5', '1e2', '9007199254740992']) {
    const draft = monthlyDraftFromRows(rows);
    draft['2026-09-01'].comment = invalid;
    assert.throws(() => parseMonthlyDraft(rows, draft), /2026-09-01.*评论区留言.*非负整数/u);
  }
});

test('legacy snapshot fields cannot be interpreted as the monthly disposition schema', () => {
  assert.equal(isMonthlySummary({schemaVersion: 1, summary: {day: counts, mtd: counts}}), false);
  assert.equal(isMonthlySummary({schemaVersion: 1, summary: {format: 'daily_disposition_v2', rows}}), false);
  assert.equal(isMonthlySummary({schemaVersion: 2, summary: {format: 'daily_disposition_v2', rows}}), true);
  assert.equal(isHandlingSummary({schemaVersion: 2, summary: {format: 'daily_disposition_v2', rows}}), false);
  assert.equal(isHandlingSummary({schemaVersion: 2, summary: {format: 'daily_handling_v3', rows}}), false);
  assert.equal(isHandlingSummary({schemaVersion: 3, summary: {format: 'daily_disposition_v2', rows}}), false);
  assert.equal(isHandlingSummary({schemaVersion: 3, summary: {format: 'daily_handling_v3', rows}}), true);
  assert.equal(isMonthlySummary({schemaVersion: 3, summary: {format: 'daily_handling_v3', rows}}), true);
  assert.equal(isMonthlySummary({schemaVersion: 3, summary: {format: 'daily_handling_v3'}}), false);
});

test('handling summaries omit empty rest days but preserve and edit actual handling on rest days', () => {
  const zero = Object.fromEntries(Object.keys(counts).map(field => [field, 0]));
  const handlingRows = [
    {date: '2026-09-04', isWorkingDay: true, counts: {...zero, monitor: 2, sdb: 2, cold: 2}},
    {date: '2026-09-05', isWorkingDay: false, counts: {...zero}},
    {date: '2026-09-06', isWorkingDay: false, counts: {...zero, monitor: 1, sdb: 1, cold: 1}},
    {date: '2026-09-07', isWorkingDay: true, counts: {...zero}},
  ];
  assert.deepEqual(visibleMonthlyRows(handlingRows, true).map(row => row.date), ['2026-09-04', '2026-09-06', '2026-09-07']);
  const draft = monthlyDraftFromRows(handlingRows, true);
  assert.equal(draft['2026-09-05'], undefined);
  assert.equal(draft['2026-09-06'].cold, '1');
  draft['2026-09-06'].monitor = '3';
  draft['2026-09-06'].cold = '3';
  const parsed = parseMonthlyDraft(handlingRows, draft, true);
  assert.equal(parsed.rows['2026-09-06'].monitor, 3);
  assert.equal(parsed.rows['2026-09-06'].cold, 3);
  assert.equal(sumMonthlyRows(handlingRows, draft, true).monitor, 5);
  assert.equal(sumMonthlyRows(handlingRows, null, true).monitor, 3);
  assert.deepEqual(visibleMonthlyRows(handlingRows).map(row => row.date), ['2026-09-04', '2026-09-07']);
});

test('handling on a rest day gets the same input validation as working days', () => {
  for (const invalid of ['', '-1', '1.5', '1e2', '9007199254740992']) {
    const draft = monthlyDraftFromRows(rows, true);
    draft['2026-09-05'].comment = invalid;
    assert.throws(() => parseMonthlyDraft(rows, draft, true), /2026-09-05.*评论区留言.*非负整数/u);
  }
});

test('high-heat post status labels show disposition and only attach a table number to Feishu status', () => {
  assert.equal(dailyPostStatusLabel({status: 'negative_cold'}), '冷处理');
  assert.equal(dailyPostStatusLabel({status: 'negative_comment'}), '评论区留言');
  assert.equal(dailyPostStatusLabel({status: 'negative_feishu', feishuTableNo: '  SGMW-210  '}), '飞书表 · SGMW-210');
  assert.equal(dailyPostStatusLabel({status: 'negative_cold', feishuTableNo: 'SGMW-210'}), '冷处理');
  assert.equal(dailyPostStatusLabel({status: 'negative_feishu'}), '飞书表');
  assert.equal(dailyPostStatusLabel({status: 'future_status'}), '状态待核对');
  assert.equal(dailyPostStatusLabel({}), '状态未记录');
});

test('the empty insights entry defaults to daily while explicit dashboard navigation remains available', () => {
  const insights = readFileSync(new URL('../web/admin/src/pages/InsightsPage.tsx', import.meta.url), 'utf8');
  assert.match(insights, /params\?\.tab === 'dashboard' \? 'dashboard'/u);
  assert.match(insights, /params\?\.tab === 'patrol' \? 'patrol' : 'daily'/u);
  const navigation = readFileSync(new URL('../web/admin/src/lib/navigation.tsx', import.meta.url), 'utf8');
  assert.match(navigation, /opinion: 'insights'/u);
  assert.match(navigation, /analytics: \{ page: 'insights', params: \{ tab: 'dashboard' \} \}/u);
});
