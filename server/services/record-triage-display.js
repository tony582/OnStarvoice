// Presentation only: never create a triage row or change stored handling status.
// admission is supplied by the shared query-time/JS admission calculation.
export function withRecordTriageDisplay(record = {}, admission = {}) {
  const status = record.triage_status || 'unhandled';
  let reason = '';
  if (status === 'unhandled' && !record.archived_at) {
    if (['official_content', 'blogger_profile'].includes(record.record_type)) reason = '该内容类型不进入工作列表';
    else if (record.business_visibility === 'filtered_out') reason = '已被采集预筛排除';
    else if (record.business_visibility === 'deferred') reason = '采集详情尚未完成';
    else if (record.business_visibility && record.business_visibility !== 'eligible') reason = '未通过业务准入';
    else if (admission.relevance === 'irrelevant' && !record.is_watched) reason = admission.manualRelevance === 'irrelevant' ? '人工判定无关' : 'AI 判定无关';
    else if (admission.admitted === false) reason = admission.scoped ? '历史内容未通过当时的准入规则' : '未通过工作列表准入';
  }
  const watched = !reason && status === 'unhandled' && !record.archived_at && record.is_watched && admission.relevance === 'irrelevant';
  return {...record, triage_display_status: reason ? 'not_admitted' : watched ? 'watched_not_pending' : status,
    triage_display_reason: reason || (watched ? '已关注的无关内容保留在工作列表，不计入待处理数量' : '')};
}
