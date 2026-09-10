import {isWorkingDate, nextWorkingDate, previousWorkingDate, calendarRevisionForRange} from './china-work-calendar.js';

const DAY = 86400000;
export const DEFAULT_COLLECTION_BOUNDARY = '18:00';
const localDate = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const at = (date, time = '00:00') => new Date(`${date}T${time}:00+08:00`).toISOString();
const fail = (message, code = 'daily_business_date_invalid', status = 400) => Object.assign(new Error(message), {code, status});

export function collectionBoundary(config = {}) {
  const value = config.collectionBoundaryTime ?? DEFAULT_COLLECTION_BOUNDARY;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw fail('采集归属切分时间应为 HH:mm');
  return value;
}

export function dailyBusinessCalendar(date, now = new Date(), config = {}) {
  const today = localDate(now);
  const requested = date || today;
  const working = isWorkingDate(requested);
  const defaultReportDate = isWorkingDate(today) ? today : previousWorkingDate(today);
  return {defaultReportDate, isWorkingDay: working,
    nextWorkingDate: working ? requested : nextWorkingDate(requested),
    collectionBoundaryTime: collectionBoundary(config), revision: calendarRevisionForRange(requested, requested)};
}

/** Collection ownership follows the customer workday, independently of review time.
 * The full collection interval and calendar revision are frozen in every snapshot. */
export function customerDailyBusinessPeriod(date, now = new Date(), config = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw fail('生成时间无效');
  const today = localDate(now);
  const reportDate = date || dailyBusinessCalendar(undefined, now, config).defaultReportDate;
  if (!isWorkingDate(reportDate)) throw fail(`${reportDate}为休息日，采集内容并入${nextWorkingDate(reportDate)}日报。`, 'daily_non_working_date');
  if (reportDate > today) throw fail('不能生成未来工作日的日报');
  const boundary = collectionBoundary(config);
  const previousWorkDate = previousWorkingDate(reportDate);
  const firstWorkDate = nextWorkingDate(`${reportDate.slice(0, 7)}-01`, {inclusive: true});
  const monthPreviousWorkDate = previousWorkingDate(firstWorkDate);
  const calendarStart = monthPreviousWorkDate < previousWorkDate ? monthPreviousWorkDate : previousWorkDate;
  const periodStart = at(reportDate);
  const cutoffMs = Math.min(nowMs, new Date(periodStart).getTime() + DAY);
  const collectionStartAt = at(previousWorkDate, boundary);
  const collectionEndAt = at(reportDate, boundary);
  return {reportDate, mode: 'formal', periodStart, cutoffAt: new Date(cutoffMs).toISOString(),
    assessedAt: new Date(nowMs).toISOString(), heatStart: new Date(cutoffMs - 7 * DAY).toISOString(),
    monthStart: at(monthPreviousWorkDate, boundary),
    collectionStartAt, collectionEndAt,
    collectionCutoffAt: new Date(Math.min(nowMs, new Date(collectionEndAt).getTime())).toISOString(),
    collectionBoundaryTime: boundary, previousWorkDate,
    // Cold-treatment changes made during the intervening rest days are delivered together.
    handlingStartAt: new Date(new Date(at(previousWorkDate)).getTime() + DAY).toISOString(),
    calendarRevision: calendarRevisionForRange(calendarStart, reportDate),
    reportBasis: 'customer_workday_v1'};
}
