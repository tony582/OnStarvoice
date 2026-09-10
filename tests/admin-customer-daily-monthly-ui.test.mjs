import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isMonthlySummary, monthlyDraftFromRows, parseMonthlyDraft, sumMonthlyRows} from '../web/admin/src/pages/insights/CustomerDailyReport.summary.mjs';

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
});

test('the empty insights entry defaults to daily while explicit dashboard navigation remains available', () => {
  const insights = readFileSync(new URL('../web/admin/src/pages/InsightsPage.tsx', import.meta.url), 'utf8');
  assert.match(insights, /params\?\.tab === 'dashboard' \? 'dashboard'/u);
  assert.match(insights, /params\?\.tab === 'patrol' \? 'patrol' : 'daily'/u);
  const navigation = readFileSync(new URL('../web/admin/src/lib/navigation.tsx', import.meta.url), 'utf8');
  assert.match(navigation, /opinion: 'insights'/u);
  assert.match(navigation, /analytics: \{ page: 'insights', params: \{ tab: 'dashboard' \} \}/u);
});
