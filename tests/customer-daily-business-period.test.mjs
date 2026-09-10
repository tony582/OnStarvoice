import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  collectionBoundary,
  dailyBusinessCalendar,
  customerDailyBusinessPeriod,
} from '../server/services/customer-daily-business-period.js';
import {nextDailySendAt} from '../server/services/customer-daily-report-config.js';

const at = (date, time) => `${date}T${time}+08:00`;
const belongsTo = (instant, period) => Date.parse(instant) >= Date.parse(period.collectionStartAt)
  && Date.parse(instant) < Date.parse(period.collectionCutoffAt);

test('September 9 evening and September 10 morning belong to the September 10 report', () => {
  const period = customerDailyBusinessPeriod('2026-09-10', at('2026-09-10', '10:00:00'));
  assert.equal(period.reportDate, '2026-09-10');
  assert.equal(period.collectionStartAt, '2026-09-09T10:00:00.000Z');
  assert.equal(period.collectionEndAt, '2026-09-10T10:00:00.000Z');
  assert.equal(period.collectionCutoffAt, '2026-09-10T02:00:00.000Z');
  assert.equal(belongsTo(at('2026-09-09', '22:44:00'), period), true);
  assert.equal(belongsTo(at('2026-09-10', '08:30:00'), period), true);
  assert.equal(belongsTo(at('2026-09-09', '17:59:59.999'), period), false);
  assert.equal(belongsTo(at('2026-09-10', '10:00:00'), period), false);
});

test('18:00 is included only in the next workday and repeated generation cannot expand a closed collection window', () => {
  const onBoundary = customerDailyBusinessPeriod('2026-09-10', at('2026-09-10', '18:00:00'));
  const later = customerDailyBusinessPeriod('2026-09-10', at('2026-09-11', '11:00:00'));
  const next = customerDailyBusinessPeriod('2026-09-11', at('2026-09-11', '11:00:00'));
  assert.equal(onBoundary.collectionCutoffAt, '2026-09-10T10:00:00.000Z');
  assert.equal(later.collectionCutoffAt, onBoundary.collectionCutoffAt);
  assert.equal(later.collectionCutoffAt, next.collectionStartAt);
  const before = at('2026-09-10', '17:59:59.999');
  const boundary = at('2026-09-10', '18:00:00');
  assert.equal([later, next].filter(period => belongsTo(before, period)).length, 1);
  assert.equal(belongsTo(before, later), true);
  assert.equal([later, next].filter(period => belongsTo(boundary, period)).length, 1);
  assert.equal(belongsTo(boundary, next), true);
});

test('Monday collection covers Friday 18:00 through Monday 18:00, including all weekend arrivals', () => {
  const period = customerDailyBusinessPeriod('2026-09-14', at('2026-09-14', '20:00:00'));
  assert.equal(period.previousWorkDate, '2026-09-11');
  assert.equal(period.collectionStartAt, '2026-09-11T10:00:00.000Z');
  assert.equal(period.collectionCutoffAt, '2026-09-14T10:00:00.000Z');
  for (const instant of [at('2026-09-11', '18:00:00'), at('2026-09-12', '00:00:00'), at('2026-09-13', '23:59:59'), at('2026-09-14', '17:59:59')]) assert.equal(belongsTo(instant, period), true, instant);
  assert.equal(period.handlingStartAt, '2026-09-11T16:00:00.000Z');
});

test('September 20 working Sunday receives Saturday backlog separately from Monday', () => {
  const sunday = customerDailyBusinessPeriod('2026-09-20', at('2026-09-21', '10:00:00'));
  const monday = customerDailyBusinessPeriod('2026-09-21', at('2026-09-21', '10:00:00'));
  assert.equal(sunday.previousWorkDate, '2026-09-18');
  assert.equal(sunday.collectionStartAt, '2026-09-18T10:00:00.000Z');
  assert.equal(sunday.collectionEndAt, '2026-09-20T10:00:00.000Z');
  assert.equal(monday.previousWorkDate, '2026-09-20');
  assert.equal(monday.collectionStartAt, sunday.collectionCutoffAt);
  assert.equal(belongsTo(at('2026-09-19', '10:00:00'), sunday), true);
  assert.equal(belongsTo(at('2026-09-19', '10:00:00'), monday), false);
});

test('October 8 merges the whole National Day closure beginning September 30 at 18:00', () => {
  const period = customerDailyBusinessPeriod('2026-10-08', at('2026-10-08', '20:00:00'));
  assert.equal(period.previousWorkDate, '2026-09-30');
  assert.equal(period.collectionStartAt, '2026-09-30T10:00:00.000Z');
  assert.equal(period.collectionCutoffAt, '2026-10-08T10:00:00.000Z');
  assert.equal(period.handlingStartAt, '2026-09-30T16:00:00.000Z');
  for (let day = 1; day <= 7; day++) assert.equal(belongsTo(at(`2026-10-0${day}`, '12:00:00'), period), true);
  assert.equal(belongsTo(at('2026-09-30', '17:59:59'), period), false);
});

test('monthly collection ownership includes the preceding month evening, without overlapping the previous month', () => {
  const august = customerDailyBusinessPeriod('2026-08-31', at('2026-09-01', '12:00:00'));
  const september = customerDailyBusinessPeriod('2026-09-01', at('2026-09-01', '12:00:00'));
  const laterSeptember = customerDailyBusinessPeriod('2026-09-10', at('2026-09-10', '12:00:00'));
  assert.equal(september.monthStart, '2026-08-31T10:00:00.000Z');
  assert.equal(september.monthStart, august.collectionCutoffAt);
  assert.equal(september.monthStart, september.collectionStartAt);
  assert.equal(laterSeptember.monthStart, september.monthStart);
  assert.equal(belongsTo(at('2026-08-31', '18:00:00'), september), true);
  assert.equal(belongsTo(at('2026-08-31', '18:00:00'), august), false);
});

test('month-first holiday and make-up days choose the correct MTD start', () => {
  const october = customerDailyBusinessPeriod('2026-10-09', at('2026-10-09', '12:00:00'));
  assert.equal(october.monthStart, '2026-09-30T10:00:00.000Z');
  const march = customerDailyBusinessPeriod('2026-03-02', at('2026-03-02', '12:00:00'));
  assert.equal(march.monthStart, '2026-02-28T10:00:00.000Z');
  assert.equal(march.previousWorkDate, '2026-02-28');
});

test('January collection and frozen revision include the verified previous calendar year', () => {
  const period = customerDailyBusinessPeriod('2026-01-04', at('2026-01-04', '12:00:00'));
  assert.equal(period.monthStart, '2025-12-31T10:00:00.000Z');
  assert.equal(period.collectionStartAt, period.monthStart);
  assert.equal(period.calendarRevision, 'china-work-calendar-v1:cn-mainland-2025-20241112-v1+cn-mainland-2026-20251104-v1');
  assert.equal(period.reportBasis, 'customer_workday_v1');
  assert.equal(period.collectionBoundaryTime, '18:00');
});

test('heat and handling keep their natural-day cutoff independently of the 18:00 collection cutoff', () => {
  const sameDay = customerDailyBusinessPeriod('2026-10-08', at('2026-10-08', '20:00:00'));
  assert.equal(sameDay.periodStart, '2026-10-07T16:00:00.000Z');
  assert.equal(sameDay.cutoffAt, '2026-10-08T12:00:00.000Z');
  assert.equal(sameDay.heatStart, '2026-10-01T12:00:00.000Z');
  assert.equal(sameDay.collectionCutoffAt, '2026-10-08T10:00:00.000Z');
  const historical = customerDailyBusinessPeriod('2026-10-08', at('2026-10-10', '10:00:00'));
  assert.equal(historical.cutoffAt, '2026-10-08T16:00:00.000Z');
  assert.equal(historical.assessedAt, '2026-10-10T02:00:00.000Z');
  assert.equal(historical.heatStart, '2026-10-01T16:00:00.000Z');
});

test('future working dates and resting dates are rejected rather than generating misleading reports', () => {
  assert.throws(() => customerDailyBusinessPeriod('2026-09-11', at('2026-09-10', '12:00:00')), {code: 'daily_business_date_invalid', status: 400});
  assert.throws(() => customerDailyBusinessPeriod('2026-09-12', at('2026-09-14', '12:00:00')), error => error.code === 'daily_non_working_date' && error.status === 400 && error.message.includes('2026-09-14'));
  assert.throws(() => customerDailyBusinessPeriod('2026-10-01', at('2026-10-08', '12:00:00')), error => error.code === 'daily_non_working_date' && error.message.includes('2026-10-08'));
  assert.throws(() => customerDailyBusinessPeriod('2026-09-10', 'invalid'), {code: 'daily_business_date_invalid'});
});

test('default report uses the current Shanghai workday or latest previous workday during closure', () => {
  for (const [now, expected] of [
    ['2026-09-09T16:30:00Z', '2026-09-10'],
    [at('2026-09-12', '09:00:00'), '2026-09-11'],
    [at('2026-09-20', '09:00:00'), '2026-09-20'],
    [at('2026-10-07', '09:00:00'), '2026-09-30'],
  ]) {
    assert.equal(dailyBusinessCalendar(undefined, now).defaultReportDate, expected);
    assert.equal(customerDailyBusinessPeriod(undefined, now).reportDate, expected);
  }
  const holiday = dailyBusinessCalendar('2026-10-01', at('2026-10-01', '09:00:00'));
  assert.equal(holiday.isWorkingDay, false);
  assert.equal(holiday.nextWorkingDate, '2026-10-08');
});

test('missing 2027 calendar fails explicitly for default selection, generation and future send scheduling', () => {
  const unavailable = error => error.code === 'CHINA_WORK_CALENDAR_UNAVAILABLE' && error.year === 2027;
  assert.throws(() => dailyBusinessCalendar(undefined, at('2027-01-04', '09:00:00')), unavailable);
  assert.throws(() => customerDailyBusinessPeriod(undefined, at('2027-01-04', '09:00:00')), unavailable);
  assert.throws(() => customerDailyBusinessPeriod('2027-01-04', at('2027-01-04', '09:00:00')), unavailable);
  assert.throws(() => nextDailySendAt('09:00', at('2026-12-31', '09:00:00')), unavailable);
});

test('automatic sends skip weekends and holidays but run on the official make-up days', () => {
  for (const [now, expected] of [
    [at('2026-09-11', '08:59:59'), '2026-09-11T01:00:00.000Z'],
    [at('2026-09-11', '09:00:00'), '2026-09-14T01:00:00.000Z'],
    [at('2026-09-19', '10:00:00'), '2026-09-20T01:00:00.000Z'],
    [at('2026-09-20', '09:00:00'), '2026-09-21T01:00:00.000Z'],
    [at('2026-09-24', '09:00:00'), '2026-09-28T01:00:00.000Z'],
    [at('2026-09-30', '09:00:00'), '2026-10-08T01:00:00.000Z'],
    [at('2026-10-09', '09:00:00'), '2026-10-10T01:00:00.000Z'],
    [at('2026-10-10', '09:00:00'), '2026-10-12T01:00:00.000Z'],
  ]) assert.equal(nextDailySendAt('09:00', now), expected, now);
});

test('a configured collection boundary moves both daily and monthly ownership consistently', () => {
  const config = {collectionBoundaryTime: '19:30'};
  const period = customerDailyBusinessPeriod('2026-09-01', at('2026-09-01', '21:00:00'), config);
  assert.equal(collectionBoundary(), '18:00');
  assert.equal(period.collectionStartAt, '2026-08-31T11:30:00.000Z');
  assert.equal(period.monthStart, period.collectionStartAt);
  assert.equal(period.collectionCutoffAt, '2026-09-01T11:30:00.000Z');
  assert.equal(dailyBusinessCalendar('2026-09-01', at('2026-09-01', '21:00:00'), config).collectionBoundaryTime, '19:30');
  for (const value of ['24:00', '18:60', '8:00', '18:00:00', '']) assert.throws(() => collectionBoundary({collectionBoundaryTime: value}), {code: 'daily_business_date_invalid'});
});

test('business periods and next-send dates are independent of the host timezone', () => {
  const periodUrl = new URL('../server/services/customer-daily-business-period.js', import.meta.url).href;
  const configUrl = new URL('../server/services/customer-daily-report-config.js', import.meta.url).href;
  const script = `const p = await import(${JSON.stringify(periodUrl)}); const c = await import(${JSON.stringify(configUrl)}); const report = p.customerDailyBusinessPeriod(undefined, '2026-09-19T16:30:00Z'); console.log(JSON.stringify([report.reportDate,report.collectionStartAt,report.collectionCutoffAt,c.nextDailySendAt('09:00','2026-09-19T16:30:00Z')]));`;
  for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: timezone}, encoding: 'utf8'}));
    assert.deepEqual(actual, ['2026-09-20', '2026-09-18T10:00:00.000Z', '2026-09-19T16:30:00.000Z', '2026-09-20T01:00:00.000Z'], timezone);
  }
});
