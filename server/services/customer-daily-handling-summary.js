import {isWorkingDate} from './china-work-calendar.js';

export const DAILY_HANDLING_SUMMARY_FORMAT = 'daily_handling_v3';
export const DAILY_COLLECTION_HANDLING_SUMMARY_FORMAT = 'daily_collection_handling_v5';
export const CUSTOMER_DAILY_NEGATIVE_HANDLING_FIELDS = Object.freeze(['cold', 'comment', 'negativeProcess', 'negativeOther']);
const NEGATIVE_FIELD = Object.freeze({negative_cold: 'cold', negative_comment: 'comment', negative_feishu: 'negativeProcess', unavailable: 'negativeOther', privacy_unreachable: 'negativeOther'});
const EXPLICIT_NEGATIVE_STATES = new Set(['negative_cold', 'negative_comment', 'negative_feishu']);
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

const emptyNegativeCounts = () => ({cold: 0, comment: 0, negativeProcess: 0, negativeOther: 0});
const negativeActionField = (transition, record, knownNegativePrevious = false) => {
  const field = NEGATIVE_FIELD[transition.nextStatus];
  return field === 'negativeOther' && record?.sentiment !== 'negative' && !EXPLICIT_NEGATIVE_STATES.has(transition.previousStatus) && !knownNegativePrevious ? null : field;
};

/** A daily row measures actions; a month counts each eligible post only once.
 * Current sentiment cannot erase an earlier action recorded in the audit log. */
export function buildCustomerDailyNegativeHandlingSummary(records, transitions, period, {coverageFrom = null, malformedEventIds = []} = {}) {
  const monthStart = customerDailyHandlingMonthStart(period);
  const byRecord = new Map(records.map(record => [String(record.id).toLowerCase(), record]));
  const byDate = new Map();
  const latest = new Map();
  const latestFields = new Map();
  const seen = new Set();
  const included = [];
  const ordered = [...transitions].sort((a, b) => time(a.handledAt) - time(b.handledAt) || String(a.eventId).localeCompare(String(b.eventId)) || String(a.recordId).localeCompare(String(b.recordId)));
  for (const transition of ordered) {
    const recordId = String(transition.recordId).toLowerCase();
    if (!byRecord.has(recordId) || !STATUSES.has(transition.nextStatus) || !transition.previousStatus || transition.previousStatus === transition.nextStatus ||
        !Number.isFinite(time(transition.handledAt)) || time(transition.handledAt) < time(monthStart) || time(transition.handledAt) >= time(period.cutoffAt)) continue;
    const date = dateOf(transition.handledAt);
    if (date > period.reportDate) continue;
    // A batch may contain equivalent UUIDs with different casing. The same
    // audit event/post pair is one action, even if the query/input repeats it.
    const key = `${transition.eventId}\u0000${recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized = {...transition, recordId};
    const previous = latest.get(recordId);
    const field = negativeActionField(normalized, byRecord.get(recordId), previous?.nextStatus === transition.previousStatus && Boolean(latestFields.get(recordId)));
    included.push(normalized);
    latest.set(recordId, normalized);
    latestFields.set(recordId, field);
    if (!byDate.has(date)) byDate.set(date, emptyNegativeCounts());
    if (field) byDate.get(date)[field]++;
  }
  const rows = [];
  for (let day = 1; day <= Number(period.reportDate.slice(-2)); day++) {
    const date = `${period.reportDate.slice(0, 8)}${String(day).padStart(2, '0')}`;
    rows.push({date, isWorkingDay: isWorkingDate(date), counts: {...(byDate.get(date) || emptyNegativeCounts())}});
  }
  const mtd = emptyNegativeCounts();
  for (const transition of latest.values()) {
    const field = latestFields.get(transition.recordId);
    if (field) mtd[field]++;
  }
  const coverageComplete = Number.isFinite(time(coverageFrom)) && time(coverageFrom) <= time(monthStart) && malformedEventIds.length === 0;
  return {
    summary: {dayDate: period.reportDate, rows, day: {...(byDate.get(period.reportDate) || emptyNegativeCounts())}, mtd,
      dailyBasis: 'status_transition_events', mtdBasis: 'distinct_records_last_status',
      coverageFrom: Number.isFinite(time(coverageFrom)) ? new Date(time(coverageFrom)).toISOString() : null, coverageComplete},
    evidence: {source: 'audit_logs.status_transitions', timeZone: 'Asia/Shanghai', monthStart, cutoffAt: period.cutoffAt,
      coverageFrom: Number.isFinite(time(coverageFrom)) ? new Date(time(coverageFrom)).toISOString() : null, coverageComplete,
      malformedEventIds: [...malformedEventIds], transitions: included,
      monthLastTransitions: [...latest.values()],
      monthExcludedRecordIds: [...latest.values()].filter(transition => !latestFields.get(transition.recordId)).map(transition => transition.recordId)},
  };
}

/** Overlay only four action columns; preserve the frozen collection baseline. */
export function buildCustomerDailyMixedSummary(collectionSummary, handlingSummary) {
  const rows = new Map(structuredClone(collectionSummary.rows).map(row => [row.date, row]));
  for (const handlingRow of handlingSummary.rows) {
    if (!rows.has(handlingRow.date)) rows.set(handlingRow.date, {date: handlingRow.date, isWorkingDay: handlingRow.isWorkingDay,
      counts: {monitor: 0, sdb: 0, positive: 0, neutral: 0, negative: 0, ...emptyNegativeCounts(), nonMonitor: 0, unclassified: 0, inProgress: null, processed: null}});
  }
  const handlingByDate = new Map(handlingSummary.rows.map(row => [row.date, row.counts]));
  for (const row of rows.values()) for (const field of CUSTOMER_DAILY_NEGATIVE_HANDLING_FIELDS) row.counts[field] = handlingByDate.get(row.date)?.[field] || 0;
  const mtd = structuredClone(collectionSummary.mtd);
  for (const field of CUSTOMER_DAILY_NEGATIVE_HANDLING_FIELDS) mtd[field] = handlingSummary.mtd[field];
  return {...structuredClone(collectionSummary), format: DAILY_COLLECTION_HANDLING_SUMMARY_FORMAT, mtdBasis: 'distinct_records',
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    day: structuredClone(rows.get(collectionSummary.dayDate).counts), mtd,
    negativeDailyBasis: handlingSummary.dailyBasis, negativeMtdBasis: handlingSummary.mtdBasis,
    handlingCoverageFrom: handlingSummary.coverageFrom, handlingCoverageComplete: handlingSummary.coverageComplete};
}
