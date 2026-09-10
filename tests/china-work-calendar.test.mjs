import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CHINA_WORK_CALENDAR_TIMEZONE,
  ChinaWorkCalendarUnavailableError,
  isWorkingDate,
  nextWorkingDate,
  previousWorkingDate,
  calendarRevisionForRange,
} from '../server/services/china-work-calendar.js';

test('ordinary weekdays work and ordinary weekends merge into Monday', () => {
  for (const date of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) assert.equal(isWorkingDate(date), true);
  assert.equal(isWorkingDate('2026-09-12'), false);
  assert.equal(isWorkingDate('2026-09-13'), false);
  assert.equal(nextWorkingDate('2026-09-11'), '2026-09-14');
  assert.equal(nextWorkingDate('2026-09-12'), '2026-09-14');
  assert.equal(previousWorkingDate('2026-09-14'), '2026-09-11');
});

test('September 19 backlog belongs to the official Sunday make-up working day', () => {
  assert.equal(nextWorkingDate('2026-09-19'), '2026-09-20');
  assert.equal(isWorkingDate('2026-09-20'), true);
  assert.equal(nextWorkingDate('2026-09-20'), '2026-09-21');
  assert.equal(previousWorkingDate('2026-09-21'), '2026-09-20');
});

test('Mid-Autumn holiday merges September 25–27 into September 28', () => {
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27']) {
    assert.equal(isWorkingDate(date), false);
    assert.equal(nextWorkingDate(date), '2026-09-28');
  }
  assert.equal(previousWorkingDate('2026-09-28'), '2026-09-24');
});

test('National Day holiday merges October 1–7 into October 8', () => {
  for (let day = 1; day <= 7; day++) {
    const date = `2026-10-0${day}`;
    assert.equal(isWorkingDate(date), false);
    assert.equal(nextWorkingDate(date), '2026-10-08');
  }
  assert.equal(previousWorkingDate('2026-10-08'), '2026-09-30');
});

test('October 10 is a working Saturday and prevents Friday-to-Monday aggregation', () => {
  assert.equal(isWorkingDate('2026-10-10'), true);
  assert.equal(nextWorkingDate('2026-10-09'), '2026-10-10');
  assert.equal(nextWorkingDate('2026-10-10'), '2026-10-12');
  assert.equal(previousWorkingDate('2026-10-12'), '2026-10-10');
});

test('inclusive traversal includes a working anchor but still skips a resting anchor', () => {
  assert.equal(nextWorkingDate('2026-09-20', { inclusive: true }), '2026-09-20');
  assert.equal(previousWorkingDate('2026-09-20', { inclusive: true }), '2026-09-20');
  assert.equal(nextWorkingDate('2026-09-25', { inclusive: true }), '2026-09-28');
  assert.equal(previousWorkingDate('2026-09-25', { inclusive: true }), '2026-09-24');
  assert.equal(previousWorkingDate('2026-09-20'), '2026-09-18');
  assert.throws(() => nextWorkingDate('2026-09-20', { inclusive: 'false' }), TypeError);
});

test('2026 New Year crosses to verified 2025 data and resumes on January 4', () => {
  assert.equal(nextWorkingDate('2025-12-31'), '2026-01-04');
  assert.equal(previousWorkingDate('2026-01-01'), '2025-12-31');
  assert.equal(previousWorkingDate('2026-01-04'), '2025-12-31');
  assert.equal(isWorkingDate('2026-01-04'), true);
});

test('other official 2025 and 2026 holiday and make-up dates are retained', () => {
  for (const date of ['2025-01-01', '2025-01-28', '2025-02-04', '2025-04-04', '2025-05-05', '2025-06-02', '2025-10-08', '2026-02-15', '2026-02-23', '2026-04-06', '2026-05-05', '2026-06-19']) assert.equal(isWorkingDate(date), false, date);
  for (const date of ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11', '2026-02-14', '2026-02-28', '2026-05-09']) assert.equal(isWorkingDate(date), true, date);
});

test('local snapshots retain official source, document number and publication lineage', () => {
  const calendar2025 = JSON.parse(readFileSync(new URL('../server/assets/calendar/china-holidays-2025.json', import.meta.url), 'utf8'));
  const calendar2026 = JSON.parse(readFileSync(new URL('../server/assets/calendar/china-holidays-2026.json', import.meta.url), 'utf8'));
  assert.equal(calendar2025.documentNumber, '国办发明电〔2024〕12号');
  assert.equal(calendar2025.publishedAt, '2024-11-12');
  assert.equal(calendar2026.documentNumber, '国办发明电〔2025〕7号');
  assert.equal(calendar2026.publishedAt, '2025-11-04');
  for (const calendar of [calendar2025, calendar2026]) {
    assert.equal(new URL(calendar.sourceUrl).origin, 'https://www.gov.cn');
    assert.equal(calendar.timezone, CHINA_WORK_CALENDAR_TIMEZONE);
    assert.ok(calendar.revision);
  }
});

test('revision identifies all calendar years used by an inclusive range', () => {
  assert.equal(calendarRevisionForRange('2026-01-01', '2026-12-31'), 'china-work-calendar-v1:cn-mainland-2026-20251104-v1');
  assert.equal(calendarRevisionForRange('2026-09-25', '2026-09-28'), calendarRevisionForRange('2026-10-01', '2026-10-08'));
  assert.equal(calendarRevisionForRange('2025-12-31', '2026-01-04'), 'china-work-calendar-v1:cn-mainland-2025-20241112-v1+cn-mainland-2026-20251104-v1');
  assert.throws(() => calendarRevisionForRange('2026-09-28', '2026-09-25'), { code: 'INVALID_CALENDAR_RANGE' });
});

test('missing 2027 calendar is identifiable and never falls back to weekday guesses', () => {
  const unavailable = error => error instanceof ChinaWorkCalendarUnavailableError && error.code === 'CHINA_WORK_CALENDAR_UNAVAILABLE' && error.year === 2027;
  assert.throws(() => isWorkingDate('2027-01-04'), unavailable);
  assert.throws(() => nextWorkingDate('2026-12-31'), unavailable);
  assert.throws(() => previousWorkingDate('2027-01-01'), unavailable);
  assert.throws(() => calendarRevisionForRange('2026-12-31', '2027-01-01'), unavailable);
  assert.throws(() => previousWorkingDate('2025-01-01'), { code: 'CHINA_WORK_CALENDAR_UNAVAILABLE', year: 2024 });
});

test('calendar inputs reject invalid dates, timestamps and implicit conversion', () => {
  for (const value of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-09-00', '2026-9-01', ' 2026-09-01', '2026-09-01T00:00:00+08:00', '', '0000-01-01', null, undefined, 20260910, new Date('2026-09-10')]) {
    assert.throws(() => isWorkingDate(value), { code: 'INVALID_CALENDAR_DATE' });
    assert.throws(() => nextWorkingDate(value), { code: 'INVALID_CALENDAR_DATE' });
    assert.throws(() => previousWorkingDate(value), { code: 'INVALID_CALENDAR_DATE' });
    assert.throws(() => calendarRevisionForRange(value, '2026-09-10'), { code: 'INVALID_CALENDAR_DATE' });
  }
});

test('Shanghai civil dates behave identically under UTC, Los Angeles and Shanghai hosts without network', () => {
  const moduleUrl = new URL('../server/services/china-work-calendar.js', import.meta.url).href;
  const source = `globalThis.fetch = () => { throw new Error('Calendar must remain offline'); }; const c = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([c.nextWorkingDate('2026-09-19'), c.previousWorkingDate('2026-09-28'), c.nextWorkingDate('2025-12-31'), c.isWorkingDate('2026-10-10')]));`;
  for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(actual), ['2026-09-20', '2026-09-24', '2026-01-04', true], timezone);
  }
});
