export function hasUnattendedNegativePatrol(planSnapshot) {
  return planSnapshot?.negativePatrol?.enabled === true;
}

export function hasFirstCollectedNegativePatrolWindow(run) {
  return run?.windowBasis === 'first_collected_at';
}

export const NEGATIVE_PATROL_STATUS_OPTIONS = [
  {value: 'unhandled', label: '待处理'},
  {value: 'replied', label: '已回复'},
  {value: 'reviewed', label: '已复核'},
  {value: 'reviewed_non_monitor', label: '已复核-非监控内容'},
  {value: 'unavailable', label: '已不可见'},
  {value: 'privacy_unreachable', label: '负面–隐私设置无法触达'},
  {value: 'negative_feishu', label: '负面-飞书表'},
  {value: 'negative_cold', label: '负面-冷处理'},
  {value: 'negative_comment', label: '负面-评论区留言'},
];

export const DEFAULT_NEGATIVE_PATROL_STATUSES = NEGATIVE_PATROL_STATUS_OPTIONS
  .map(option => option.value).filter(value => value !== 'reviewed_non_monitor');

export function negativePatrolTriageStatuses(planSnapshot) {
  const value = planSnapshot?.negativePatrol?.triageStatuses;
  // Only an absent historical setting gets the default. Explicit empty or
  // invalid settings stay empty/invalid and must be corrected before saving.
  if (value === undefined) return [...DEFAULT_NEGATIVE_PATROL_STATUSES];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(value => value === 'official_responded' ? 'replied' : value === 'false_positive' ? 'reviewed_non_monitor' : String(value)))];
}

export function validNegativePatrolStatuses(statuses) {
  return Array.isArray(statuses) && statuses.length > 0
    && statuses.every(status => NEGATIVE_PATROL_STATUS_OPTIONS.some(option => option.value === status));
}

export function negativePatrolStatusSummary(statuses) {
  return statuses.map(status => NEGATIVE_PATROL_STATUS_OPTIONS.find(option => option.value === status)?.label || status).join('、');
}

export function unattendedNegativePatrolRequest(enabled, executionMode, triageStatuses = DEFAULT_NEGATIVE_PATROL_STATUSES) {
  return enabled === true && executionMode === 'unattended_plan'
    ? {negativePatrol: {enabled: true, lookbackDays: 7, triageStatuses: [...triageStatuses]}}
    : {};
}

export function negativePatrolCapabilityAvailable(capabilities) {
  return capabilities?.remoteTargetedPostCaptureV1 === true &&
    capabilities?.negativePostPatrol === true &&
    capabilities?.negativePatrolTerminalReceiptV1 === true;
}
