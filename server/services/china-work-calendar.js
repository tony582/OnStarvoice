import { readFileSync } from 'node:fs';

export const CHINA_WORK_CALENDAR_TIMEZONE = 'Asia/Shanghai';
const DAY_MS = 86_400_000;

export class ChinaWorkCalendarUnavailableError extends Error {
  constructor(year) {
    super(`${year} 年工作日日历尚未配置，请更新官方节假日安排后重试`);
    this.name = 'ChinaWorkCalendarUnavailableError';
    this.code = 'CHINA_WORK_CALENDAR_UNAVAILABLE';
    this.status = 503;
    this.year = year;
  }
}

function parseDate(value) {
  const validShape = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = validShape ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
  if (!validShape || Number(value.slice(0, 4)) < 1 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    const error = new RangeError('工作日日期须为有效的 YYYY-MM-DD');
    error.code = 'INVALID_CALENDAR_DATE';
    error.status = 400;
    throw error;
  }
  return date;
}

function loadCalendar(year) {
  const value = JSON.parse(readFileSync(new URL(`../assets/calendar/china-holidays-${year}.json`, import.meta.url), 'utf8'));
  if (value.year !== year || value.timezone !== CHINA_WORK_CALENDAR_TIMEZONE || !value.revision || !value.sourceUrl || !value.documentNumber || !value.publishedAt) {
    throw new Error(`工作日日历元数据无效：${year}`);
  }
  const dates = (items) => {
    if (!Array.isArray(items)) throw new Error(`工作日日历日期列表无效：${year}`);
    const result = new Set();
    for (const item of items) {
      if (parseDate(item).getUTCFullYear() !== year || result.has(item)) throw new Error(`工作日日历日期重复或跨年：${year}`);
      result.add(item);
    }
    return result;
  };
  const offDays = dates(value.offDays);
  const workDays = dates(value.workDays);
  if ([...workDays].some(date => offDays.has(date))) throw new Error(`工作日日历放假与补班冲突：${year}`);
  return { revision: value.revision, offDays, workDays };
}

// Approved, versioned local snapshots only. An unknown year is never inferred
// from weekday rules or fetched from a network service during report creation.
const calendars = new Map([2025, 2026].map(year => [year, loadCalendar(year)]));

function calendarForYear(year) {
  const calendar = calendars.get(year);
  if (!calendar) throw new ChinaWorkCalendarUnavailableError(year);
  return calendar;
}

/** The input is a Shanghai civil date, not an instant. UTC arithmetic preserves
 * that date's weekday regardless of the server's timezone or daylight savings. */
export function isWorkingDate(value) {
  const date = parseDate(value);
  const calendar = calendarForYear(date.getUTCFullYear());
  if (calendar.workDays.has(value)) return true;
  if (calendar.offDays.has(value)) return false;
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
}

/** Month-view metadata comes from the same approved calendar as report ownership. */
export function workCalendarMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw Object.assign(new RangeError('日历月份须为 YYYY-MM'), {code: 'INVALID_CALENDAR_DATE', status: 400});
  }
  const first = parseDate(`${month}-01`);
  const calendar = calendarForYear(first.getUTCFullYear());
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Array.from({length: lastDay}, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const working = isWorkingDate(date);
    const kind = calendar.workDays.has(date) ? 'makeup' : calendar.offDays.has(date) ? 'holiday' : working ? 'workday' : 'weekend';
    let reportDate = working ? date : null;
    let calendarPending = false;
    if (!working) {
      try { reportDate = nextWorkingDate(date); }
      catch (error) {
        if (!(error instanceof ChinaWorkCalendarUnavailableError)) throw error;
        calendarPending = true;
      }
    }
    return {date, isWorkingDay: working, kind, reportDate, ...(calendarPending ? {calendarPending} : {})};
  });
  return {month, days, revision: `china-work-calendar-v1:${calendar.revision}`};
}

function adjacentWorkingDate(value, direction, inclusive) {
  if (typeof inclusive !== 'boolean') throw new TypeError('inclusive 必须为布尔值');
  const anchorIsWorking = isWorkingDate(value);
  if (inclusive && anchorIsWorking) return value;
  let date = parseDate(value);
  while (true) {
    date = new Date(date.getTime() + direction * DAY_MS);
    const candidate = date.toISOString().slice(0, 10);
    if (isWorkingDate(candidate)) return candidate;
  }
}

/** Returns the next strictly later working date unless inclusive is true. */
export function nextWorkingDate(value, { inclusive = false } = {}) {
  return adjacentWorkingDate(value, 1, inclusive);
}

/** Returns the previous strictly earlier working date unless inclusive is true. */
export function previousWorkingDate(value, { inclusive = false } = {}) {
  return adjacentWorkingDate(value, -1, inclusive);
}

/** Stable revision for all years touched by the inclusive civil-date range. */
export function calendarRevisionForRange(startDate, endDate) {
  const first = parseDate(startDate);
  const last = parseDate(endDate);
  if (first > last) {
    const error = new RangeError('工作日日历区间结束日期不能早于开始日期');
    error.code = 'INVALID_CALENDAR_RANGE';
    throw error;
  }
  const revisions = [];
  for (let year = first.getUTCFullYear(); year <= last.getUTCFullYear(); year++) {
    revisions.push(calendarForYear(year).revision);
  }
  return `china-work-calendar-v1:${revisions.join('+')}`;
}
