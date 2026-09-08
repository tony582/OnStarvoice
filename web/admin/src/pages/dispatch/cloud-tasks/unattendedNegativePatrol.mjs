export function hasUnattendedNegativePatrol(planSnapshot) {
  return planSnapshot?.negativePatrol?.enabled === true;
}

export function hasFirstCollectedNegativePatrolWindow(run) {
  return run?.windowBasis === 'first_collected_at';
}

export function unattendedNegativePatrolRequest(enabled, executionMode) {
  return enabled === true && executionMode === 'unattended_plan'
    ? {negativePatrol: {enabled: true, lookbackDays: 7}}
    : {};
}

export function negativePatrolCapabilityAvailable(capabilities) {
  return capabilities?.remoteTargetedPostCaptureV1 === true &&
    capabilities?.negativePostPatrol === true &&
    capabilities?.negativePatrolTerminalReceiptV1 === true;
}
