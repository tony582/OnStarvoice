import assert from 'node:assert/strict';
import test from 'node:test';
import {withRecordTriageDisplay} from '../server/services/record-triage-display.js';
import {withRecordAdmissionFields} from '../server/services/record-triage-admission.js';
import {postJudgment} from '../web/admin/src/lib/post-judgment.ts';

test('display combines admission, business eligibility and effective relevance without changing handling status', () => {
  const record = {business_visibility:'eligible',record_type:'keyword_notes',triage_status:'unhandled'};
  for (const relevance of ['relevant','uncertain']) {
    assert.equal(withRecordTriageDisplay(record,{admitted:true,relevance}).triage_display_status,'unhandled');
  }
  const cases = [
    [record,{admitted:true,relevance:'irrelevant'},'AI 判定无关'],
    [record,{admitted:true,relevance:'irrelevant',manualRelevance:'irrelevant'},'人工判定无关'],
    [record,{admitted:false,scoped:true,relevance:'uncertain'},'历史内容未通过当时的准入规则'],
    [{...record,business_visibility:'filtered_out'},{admitted:true},'已被采集预筛排除'],
    [{...record,business_visibility:'deferred'},{admitted:true},'采集详情尚未完成'],
  ];
  for (const [input,admission,reason] of cases) {
    const result=withRecordTriageDisplay(input,admission);
    assert.equal(result.triage_display_status,'not_admitted');
    assert.equal(result.triage_display_reason,reason);
    assert.equal(result.triage_status,'unhandled');
  }
});

test('watched irrelevant content keeps its actual working-list state without bypassing business/admission', () => {
  const row={business_visibility:'eligible',is_watched:true};
  assert.equal(withRecordTriageDisplay(row,{admitted:true,relevance:'irrelevant'}).triage_display_status,'watched_not_pending');
  assert.equal(withRecordTriageDisplay(row,{admitted:false,relevance:'irrelevant'}).triage_display_status,'not_admitted');
  assert.equal(withRecordTriageDisplay({...row,business_visibility:'filtered_out'},{admitted:true,relevance:'irrelevant'}).triage_display_status,'not_admitted');
});

test('ordinary/new-sentry presentation does not repeat old AI brand-evidence requirement', () => {
  const row={ai_result:{relevance:'relevant',monitoringEvidence:{status:'needs_review',reason:'需要品牌证据'}}};
  assert.equal(postJudgment(row).monitoringReason,'需要品牌证据','legacy metadata remains visible');
  assert.equal(postJudgment({...row,monitoring_evidence_status:'not_applicable'}).monitoringReason,'');
});

test('reviewed and archived states remain unchanged even when current admission excludes them', () => {
  for (const record of [{triage_status:'reviewed'},{triage_status:'reviewed_non_monitor'},
    {triage_status:'unhandled',archived_at:'2026-11-11T10:00:00Z'}]) {
    const result=withRecordTriageDisplay({...record,business_visibility:'filtered_out'},{admitted:false,relevance:'irrelevant'});
    assert.equal(result.triage_display_status,record.triage_status);
    assert.equal(result.triage_display_reason,'');
  }
});

test('actual admission projection admits customer-included historical uncertain record but keeps unrelated irrelevant exclusion', () => {
  const record={business_visibility:'eligible',keyword:'别克哨兵',created_at:'2026-11-01T00:00:00Z',
    ai_result:{relevance:'uncertain'},manual_overrides:{triage_admission:{value:'included'}}};
  assert.equal(withRecordAdmissionFields(record).triage_display_status,'unhandled');
  assert.equal(withRecordAdmissionFields({...record,ai_result:{relevance:'irrelevant'}}).triage_display_status,'not_admitted');
  assert.equal(withRecordAdmissionFields({...record,manual_overrides:{}}).triage_display_status,'not_admitted');
});
