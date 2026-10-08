import assert from 'node:assert/strict';
import test from 'node:test';
import {manualRecordAdmission, manualRecordAdmissionSql, recordTriageAdmission, recordTriageAdmissionSql, withRecordAdmissionFields} from '../server/services/record-triage-admission.js';
import {dailyReportDateFor, backfilledHandlingTime} from '../server/scripts/reconcile-customer-daily-scope.mjs';

const sentryPost = (overrides = {}) => ({id: 'post-1', keyword: '别克哨兵', title: '哨兵录像怎么导出', content: '有人知道吗', ai_result: {relevance: 'uncertain'}, manual_overrides: overrides});

test('the explicit customer admission override admits a sentry post without touching relevance', () => {
  const excluded = recordTriageAdmission(sentryPost());
  assert.equal(excluded.admitted, false);
  assert.equal(excluded.monitoring_evidence_status, 'needs_review');
  const included = recordTriageAdmission(sentryPost({triage_admission: {value: 'included', reason: '按 9 月日报对齐'}}));
  assert.equal(included.admitted, true);
  assert.equal(included.scoped, true);
  assert.equal(included.relevance, 'uncertain', 'relevance stays whatever AI or staff decided');
  assert.equal(included.monitoring_evidence_status, 'customer_included');
  assert.equal(manualRecordAdmission(sentryPost({triage_admission: 'included'})), 'included', 'a bare string value is accepted');
  assert.equal(manualRecordAdmission(sentryPost({triage_admission: {value: 'excluded'}})), '');
  assert.equal(recordTriageAdmission(sentryPost({triage_admission: {value: 'included'}, relevance: {value: 'relevant'}})).monitoring_evidence_status, 'manual_confirmed', 'a manual relevance decision still wins');
});

test('the admission SQL honours the override before the brand-evidence rule and the public record explains it', () => {
  assert.match(manualRecordAdmissionSql('r'), /manual_overrides->'triage_admission'->>'value'/);
  assert.ok(recordTriageAdmissionSql('r').startsWith(`(COALESCE(${manualRecordAdmissionSql('r')},false) OR NOT `));
  assert.throws(() => manualRecordAdmissionSql('r; DROP'), /Invalid record SQL alias/);
  const fromSql = withRecordAdmissionFields({...sentryPost({triage_admission: {value: 'included', reason: '按 9 月日报对齐'}}), admission_scoped: true, admission_allowed: true});
  assert.equal(fromSql.monitoring_evidence_status, 'customer_included');
  assert.deepEqual(fromSql.ai_result.monitoringEvidence.evidence, []);
  assert.equal(fromSql.ai_result.monitoringEvidence.status, 'customer_included');
  assert.equal(fromSql.ai_result.monitoringEvidence.reason, '按 9 月日报对齐');
  assert.equal(fromSql.admission_allowed, undefined, 'internal SQL flags are not exposed');
  const computed = withRecordAdmissionFields(sentryPost({triage_admission: {value: 'included'}}));
  assert.equal(computed.ai_result.monitoringEvidence.reason, '客户确认纳入内容分诊，不代表品牌证据成立');
});

test('reconcile dates follow the customer workday window and never precede the capture', () => {
  assert.equal(dailyReportDateFor('2026-08-31T13:21:32Z'), '2026-09-01', 'Monday evening belongs to Tuesday');
  assert.equal(dailyReportDateFor('2026-09-08T12:37:19Z'), '2026-09-09');
  assert.equal(dailyReportDateFor('2026-09-11T12:35:37Z'), '2026-09-14', 'Friday evening and the weekend belong to Monday');
  assert.equal(dailyReportDateFor('2026-09-12T20:00:00Z'), '2026-09-14');
  assert.equal(dailyReportDateFor('2026-09-14T06:41:41Z'), '2026-09-14', 'before the boundary stays on the same workday');
  assert.equal(dailyReportDateFor('2026-09-14T09:59:59Z'), '2026-09-14');
  assert.equal(dailyReportDateFor('2026-09-14T10:00:00Z'), '2026-09-15', 'the boundary itself opens the next window');
  assert.equal(dailyReportDateFor('2026-09-30T13:00:00Z'), '2026-10-08', 'the holiday carries into the next workday');
  assert.equal(dailyReportDateFor('2026-09-14T06:00:00Z', '20:00'), '2026-09-14');
  assert.equal(backfilledHandlingTime('2026-09-08T12:37:19Z', '2026-09-09'), '2026-09-09T01:30:00.000Z', '09:30 Beijing on the report date');
  assert.equal(backfilledHandlingTime('2026-09-24T01:04:55Z', '2026-09-24'), '2026-09-24T01:30:00.000Z');
  assert.equal(backfilledHandlingTime('2026-09-24T01:45:00Z', '2026-09-24'), '2026-09-24T01:55:00.000Z', 'captured after 09:30 is handled ten minutes later');
  assert.throws(() => dailyReportDateFor('not-a-date'), /invalid first_seen_at/);
});
