import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCustomerDailyHandlingSummary, customerDailyHandlingMonthStart, parseCustomerDailyHandlingEvents} from '../server/services/customer-daily-handling-summary.js';
import {customerDailyBusinessPeriod} from '../server/services/customer-daily-business-period.js';

const id = n => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const tenantId = id(900);
const date = (day, time = '09:00:00') => `2026-09-${String(day).padStart(2, '0')}T${time}+08:00`;
const period = customerDailyBusinessPeriod('2026-09-14', date(14, '15:00:00'));
const event = (n, previousStatus, nextStatus, created_at = date(14), patch = {}) => ({id: id(n + 100), tenant_id: tenantId,
  action: 'record.triage_updated', target_type: 'record', target_id: id(n), created_at, metadata: {previousStatus, nextStatus}, ...patch});
const count = rows => ({monitor: rows.length, sdb: rows.filter(row => row.status !== 'reviewed_non_monitor').length,
  positive: rows.filter(row => row.status !== 'reviewed_non_monitor' && row.sentiment === 'positive').length,
  cold: rows.filter(row => row.status === 'negative_cold' && row.sentiment === 'negative').length,
  negativeProcess: rows.filter(row => row.status === 'negative_feishu' && row.sentiment === 'negative').length});
const records = [1, 2, 3].map(n => ({id: id(n), sentiment: n === 3 ? 'positive' : 'negative', status: 'negative_comment', first_seen_at: '2026-08-01T00:00:00Z'}));
const summarize = (events, options = {}) => {
  const parsed = parseCustomerDailyHandlingEvents(events, {tenantId});
  return buildCustomerDailyHandlingSummary(records, parsed.transitions, period, count,
    {coverageFrom: '2026-08-31T16:00:00Z', malformedEventIds: parsed.malformed, ...options});
};

test('all supported single actions require an actual state transition, excluding unchanged official response and notes', () => {
  const result = parseCustomerDailyHandlingEvents([
    event(1, 'unhandled', 'reviewed'),
    event(2, 'negative_cold', 'negative_feishu', date(14), {action: 'record.ticket_created'}),
    event(3, 'reviewed', 'negative_comment', date(14), {action: 'record.official_response_marked'}),
    event(1, 'reviewed', 'reviewed'),
    event(2, 'negative_feishu', 'negative_feishu', date(14), {action: 'record.ticket_created'}),
    event(3, 'reviewed', 'reviewed', date(14), {action: 'record.official_response_marked'}),
    event(1, 'unhandled', 'negative_cold', date(14), {action: 'record.note_added'}),
  ], {tenantId});
  assert.deepEqual(result.transitions.map(row => row.nextStatus), ['reviewed', 'negative_feishu', 'negative_comment']);
  assert.deepEqual(result.malformed, []);
});

test('batch status changes expand per record, ignore duplicate IDs and note-only batches, and flag missing previous state', () => {
  const batch = {id: id(800), action: 'record.triage_batch_updated', created_at: date(14), metadata: {
    status: 'negative_cold', recordIds: [id(1), id(1), id(2), id(3)], previous: {[id(1)]: {status: 'reviewed'}, [id(2)]: {status: 'negative_cold'}},
  }};
  const result = parseCustomerDailyHandlingEvents([batch, {...batch, id: id(801), metadata: {status: null, note: '补充说明', recordIds: [id(1)]}}]);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].recordId, id(1));
  assert.deepEqual(result.malformed, [id(800)]);
});

test('uppercase UUID audit targets match canonical records and batch previous states use their original keys', () => {
  const canonical = 'abcdef12-abcd-4abc-8abc-abcdef123456';
  const uppercase = canonical.toUpperCase();
  const parsed = parseCustomerDailyHandlingEvents([
    event(1, 'unhandled', 'negative_cold', date(11), {target_id: uppercase}),
    {id: id(800), action: 'record.triage_batch_updated', created_at: date(14), metadata: {
      status: 'negative_feishu', recordIds: [uppercase], previous: {[uppercase]: {status: 'negative_cold'}},
    }},
  ]);
  assert.deepEqual(parsed.transitions.map(row => row.recordId), [canonical, canonical]);
  assert.deepEqual(parsed.malformed, []);
  const {summary} = buildCustomerDailyHandlingSummary([{id: canonical, sentiment: 'negative'}], parsed.transitions, period, count);
  assert.equal(summary.day.monitor, 1);
  assert.equal(summary.day.negativeProcess, 1);
  assert.equal(summary.mtd.monitor, 2);
});

test('foreign tenants and non-record targets are excluded; invalid audit rows do not manufacture handling', () => {
  const rows = [event(1, 'unhandled', 'reviewed', date(14), {tenant_id: id(901)}),
    event(2, 'unhandled', 'reviewed', date(14), {target_type: 'comment'}),
    event(3, undefined, 'reviewed'), event(1, 'unhandled', 'invented_status'),
    event(2, 'unhandled', 'reviewed', 'not-a-date'),
    event(3, 'unhandled', 'reviewed', date(14), {target_id: [id(3)]})];
  const result = parseCustomerDailyHandlingEvents(rows, {tenantId});
  assert.equal(result.transitions.length, 0);
  assert.deepEqual(new Set(result.malformed), new Set([id(101), id(102), id(103)]));
});

test('same-post changes on a day use only the final transition; status and audit inputs are not mutated', () => {
  const events = [event(1, 'unhandled', 'negative_cold', date(14, '09:00:00')),
    event(1, 'negative_cold', 'negative_feishu', date(14, '10:00:00'), {id: id(500)}),
    event(1, 'negative_feishu', 'negative_feishu', date(14, '11:00:00'), {id: id(501)})];
  const before = JSON.stringify([events, records]);
  const {summary, evidence} = summarize(events.reverse());
  assert.equal(summary.day.monitor, 1);
  assert.equal(summary.day.cold, 0);
  assert.equal(summary.day.negativeProcess, 1);
  assert.equal(evidence.transitions.length, 2);
  assert.equal(evidence.monthLastTransitions[0].eventId, id(500));
  assert.equal(JSON.stringify([events.reverse(), records]), before);
});

test('handling MTD adds daily unique counts, including repeated handling of a previous-month post on separate days', () => {
  const {summary, evidence} = summarize([
    event(1, 'unhandled', 'negative_cold', date(11)),
    event(1, 'negative_cold', 'negative_feishu', date(14)),
    event(2, 'unhandled', 'negative_cold', date(14)),
  ]);
  assert.equal(summary.format, 'daily_handling_v3');
  assert.equal(summary.mtdBasis, 'daily_sum');
  assert.equal(summary.day.monitor, 2);
  assert.equal(summary.mtd.monitor, 3);
  assert.equal(summary.mtd.cold, 2);
  assert.equal(summary.mtd.negativeProcess, 1);
  assert.equal(evidence.monthRecordIds.length, 2, 'distinct monthly evidence is not the handling MTD');
});

test('Shanghai midnight and exact cutoff are independent from the collection boundary and Monday merge', () => {
  assert.equal(customerDailyHandlingMonthStart(period), '2026-08-31T16:00:00.000Z');
  assert.notEqual(period.monthStart, customerDailyHandlingMonthStart(period));
  const {summary} = summarize([
    event(1, 'unhandled', 'reviewed', '2026-08-31T15:59:59.999Z'),
    event(1, 'unhandled', 'negative_cold', '2026-08-31T16:00:00Z'),
    event(2, 'unhandled', 'negative_cold', '2026-09-13T15:59:59.999Z'),
    event(2, 'negative_cold', 'negative_feishu', '2026-09-13T16:00:00Z'),
    event(3, 'unhandled', 'reviewed', period.cutoffAt),
  ]);
  assert.equal(summary.rows.find(row => row.date === '2026-09-01').counts.monitor, 1);
  assert.equal(summary.rows.find(row => row.date === '2026-09-13').counts.monitor, 1);
  assert.equal(summary.day.monitor, 1);
  assert.equal(summary.day.negativeProcess, 1);
  assert.equal(summary.mtd.monitor, 3);
});

test('empty rest dates are omitted; actual weekend handling remains on its real date without moving to Monday', () => {
  const {summary} = summarize([event(1, 'unhandled', 'negative_cold', date(12))]);
  const saturday = summary.rows.find(row => row.date === '2026-09-12');
  assert.equal(saturday.isWorkingDay, false);
  assert.equal(saturday.counts.monitor, 1);
  assert.ok(!summary.rows.some(row => row.date === '2026-09-13'));
  assert.equal(summary.day.monitor, 0);
  assert.equal(summary.mtd.monitor, 1);
});

test('daily final non-monitor decision contributes to platform handling but not SDB, using current corrected sentiment', () => {
  const {summary} = summarize([event(1, 'negative_cold', 'reviewed_non_monitor'), event(3, 'unhandled', 'negative_cold')]);
  assert.equal(summary.day.monitor, 2);
  assert.equal(summary.day.sdb, 1);
  assert.equal(summary.day.positive, 1);
  assert.equal(summary.day.cold, 0, 'a corrected positive post cannot count as negative cold treatment');
});

test('coverage must cover the whole natural month and malformed events prevent a complete-zero claim', () => {
  assert.equal(summarize([]).summary.coverageComplete, true);
  assert.equal(summarize([], {coverageFrom: null}).summary.coverageComplete, false);
  assert.equal(summarize([], {coverageFrom: '2026-09-13T16:00:00Z'}).summary.coverageComplete, false);
  const incomplete = summarize([event(1, undefined, 'negative_cold')]);
  assert.equal(incomplete.summary.coverageComplete, false);
  assert.deepEqual(incomplete.evidence.malformedEventIds, [id(101)]);
  assert.equal(incomplete.summary.day.monitor, 0);
});
