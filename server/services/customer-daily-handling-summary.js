import {isWorkingDate} from './china-work-calendar.js';

export const DAILY_HANDLING_SUMMARY_FORMAT = 'daily_handling_v3';
const SINGLE_ACTIONS = new Set(['record.triage_updated', 'record.ticket_created', 'record.official_response_marked']);
const STATUSES = new Set(['unhandled', 'replied', 'reviewed', 'reviewed_non_monitor', 'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold', 'negative_comment']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONE_OFFSET = 8 * 3600000;
const time = value => value == null || value === '' ? NaN : new Date(value).getTime();
const dateOf = value => new Date(time(value) + ZONE_OFFSET).toISOString().slice(0, 10);
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { /* Old malformed audit payload. */ } }
  return {};
};

export function customerDailyHandlingMonthStart(period) {
  return new Date(`${period.reportDate.slice(0, 7)}-01T00:00:00+08:00`).toISOString();
}

/** Only an audit entry containing both different statuses proves handling.
 * Notes, repeated settings, recapture and record_triage.updated_at are not events. */
export function parseCustomerDailyHandlingEvents(events = [], {tenantId} = {}) {
  const transitions = [];
  const malformed = new Set();
  for (const event of events) {
    if (tenantId && event.tenant_id && event.tenant_id !== tenantId) continue;
    if (event.target_type && event.target_type !== 'record') continue;
    const metadata = object(event.metadata);
    const add = (recordId, previousStatus, nextStatus) => {
      if (typeof previousStatus !== 'string' || !previousStatus.trim() || !STATUSES.has(nextStatus) || typeof recordId !== 'string' || !UUID.test(recordId) || !Number.isFinite(time(event.created_at))) {
        malformed.add(event.id);
        return;
      }
      if (previousStatus === nextStatus) return;
      // PostgreSQL returns UUID record IDs in lowercase, while an older audit
      // target can preserve the valid uppercase ID supplied in a route URL.
      transitions.push({recordId: recordId.toLowerCase(), eventId: event.id, handledAt: new Date(time(event.created_at)).toISOString(), previousStatus, nextStatus, action: event.action});
    };
    if (SINGLE_ACTIONS.has(event.action)) {
      add(event.target_id, metadata.previousStatus, metadata.nextStatus);
    } else if (event.action === 'record.triage_batch_updated') {
      // A batch editing only owner, priority or note intentionally has no status.
      if (metadata.status == null || metadata.status === '') continue;
      if (!Array.isArray(metadata.recordIds)) { malformed.add(event.id); continue; }
      const previous = object(metadata.previous);
      for (const recordId of new Set(metadata.recordIds)) add(recordId, object(previous[recordId]).status, metadata.status);
    }
  }
  transitions.sort((a, b) => time(a.handledAt) - time(b.handledAt) || String(a.eventId).localeCompare(String(b.eventId)) || a.recordId.localeCompare(b.recordId));
  return {transitions, malformed: [...malformed]};
}

/** Keep the last transition per post per Shanghai date, including older posts.
 * Handling MTD adds those daily counts; the separate collection MTD stays distinct. */
export function buildCustomerDailyHandlingSummary(records, transitions, period, count, {coverageFrom = null, malformedEventIds = []} = {}) {
  const monthStart = customerDailyHandlingMonthStart(period);
  const byRecord = new Map(records.map(record => [record.id, record]));
  const byDate = new Map();
  const monthly = new Map();
  const included = [];
  const ordered = [...transitions].sort((a, b) => time(a.handledAt) - time(b.handledAt) || String(a.eventId).localeCompare(String(b.eventId)) || a.recordId.localeCompare(b.recordId));
  for (const transition of ordered) {
    if (!byRecord.has(transition.recordId) || time(transition.handledAt) < time(monthStart) || time(transition.handledAt) >= time(period.cutoffAt)) continue;
    const date = dateOf(transition.handledAt);
    if (date > period.reportDate) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const record = {...byRecord.get(transition.recordId), status: transition.nextStatus};
    const entry = {record, transition};
    byDate.get(date).set(transition.recordId, entry);
    monthly.set(transition.recordId, entry);
    included.push(transition);
  }
  const rows = [];
  for (let day = 1; day <= Number(period.reportDate.slice(-2)); day++) {
    const date = `${period.reportDate.slice(0, 8)}${String(day).padStart(2, '0')}`;
    const entries = [...(byDate.get(date)?.values() || [])];
    const working = isWorkingDate(date);
    // Show real holiday handling as an ordinary date, omit an empty rest day.
    if (working || entries.length) rows.push({date, isWorkingDay: working, counts: count(entries.map(entry => entry.record))});
  }
  const coverageComplete = Number.isFinite(time(coverageFrom)) && time(coverageFrom) <= time(monthStart) && malformedEventIds.length === 0;
  return {
    summary: {format: DAILY_HANDLING_SUMMARY_FORMAT, dayDate: period.reportDate, rows,
      day: count([...(byDate.get(period.reportDate)?.values() || [])].map(entry => entry.record)),
      mtd: count([...byDate.values()].flatMap(entries => [...entries.values()].map(entry => entry.record))), mtdBasis: 'daily_sum',
      coverageFrom: Number.isFinite(time(coverageFrom)) ? new Date(time(coverageFrom)).toISOString() : null, coverageComplete},
    evidence: {source: 'audit_logs.status_transitions', timeZone: 'Asia/Shanghai', monthStart, cutoffAt: period.cutoffAt,
      coverageFrom: Number.isFinite(time(coverageFrom)) ? new Date(time(coverageFrom)).toISOString() : null, coverageComplete,
      malformedEventIds, transitions: included,
      dailyRecordIds: Object.fromEntries([...byDate].map(([date, entries]) => [date, [...entries.keys()]])),
      dailyLastTransitions: [...byDate].flatMap(([date, entries]) => [...entries.values()].map(entry => ({date, ...entry.transition}))),
      monthRecordIds: [...monthly.keys()],
      monthLastTransitions: [...monthly.values()].map(entry => entry.transition)},
  };
}
