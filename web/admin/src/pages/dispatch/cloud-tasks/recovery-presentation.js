const SUCCESS_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings']);
const SETTLED_ITEM_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);
const ACTIVE_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
]);
const FAILED_ITEM_STATUSES = new Set([
  'failed',
  'interrupted',
  'completed_with_failures',
]);

export function orchestrationItemStatusBucket(status) {
  const value = String(status || '');
  if (SUCCESS_ITEM_STATUSES.has(value)) return 'success';
  if (value === 'retryable') return 'automatic_recovery';
  if (value === 'needs_action') return 'manual';
  if (FAILED_ITEM_STATUSES.has(value)) return 'failed';
  if (ACTIVE_ITEM_STATUSES.has(value)) return 'active';
  return 'other';
}

export function summarizeOrchestrationItems(items = []) {
  const summary = {
    completed: 0,
    settled: 0,
    active: 0,
    automaticRecovery: 0,
    manual: 0,
    failed: 0,
  };
  for (const item of items) {
    const status = String(item?.status || '');
    const bucket = orchestrationItemStatusBucket(status);
    if (bucket === 'success') summary.completed += 1;
    if (bucket === 'active') summary.active += 1;
    if (bucket === 'automatic_recovery') summary.automaticRecovery += 1;
    if (bucket === 'manual') summary.manual += 1;
    if (bucket === 'failed') summary.failed += 1;
    if (SETTLED_ITEM_STATUSES.has(status)) summary.settled += 1;
  }
  return summary;
}

export function formatRecoveryCountdown({
  waitUntil,
  now,
  awaitingAgentReport = false,
} = {}) {
  const target = Number(waitUntil || 0);
  const current = Number(now || 0);
  const remainingSeconds = Math.max(0, Math.ceil((target - current) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const clock = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (target > current) return `${clock} 后检查`;
  return awaitingAgentReport
    ? '指令已下发，等待 Agent 回报'
    : '已到检查时间，等待服务端重新评估';
}
