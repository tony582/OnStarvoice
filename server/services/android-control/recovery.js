// One policy for the resume mutation and its read-only UI preview.
export function resumeError(task, items, now = Date.now()) {
  if (task.metadata.stopRequested || items.some(item => item.metadata?.deviceHeld)) return 'STOP_OR_DEVICE_CLOSURE_REQUIRED';
  if (!['needs_action', 'interrupted'].includes(task.status)) return 'RUN_NOT_RESUMABLE';
  const deadline = Date.parse(task.metadata.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now) return 'RUN_DEADLINE_EXPIRED';
  return null;
}
export function deviceAvailability(agent, now = Date.now()) {
  const heartbeat = Date.parse(agent?.last_liveness_at);
  const online = Number.isFinite(heartbeat) && heartbeat > now - 120000;
  return {online, readyForSearch: online && agent?.status === 'active' && agent?.capabilities?.readyForSearch === true};
}
export function holdState(item, taskMetadata = {}, now = Date.now()) {
  if (!item?.metadata?.deviceHeld) return 'free';
  const lease = Date.parse(item.metadata.leaseUntil);
  if (item.metadata.completion || ['needs_action', 'failed', 'interrupted'].includes(item.status)
    || !Number.isFinite(lease) || lease <= now || Date.parse(taskMetadata.deadlineAt) <= now) return 'closure_required';
  return taskMetadata.stopRequested ? 'stopping' : 'working';
}
export function recoveryView(task, items, agent, now = Date.now()) {
  const device = deviceAvailability(agent, now);
  const held = items.filter(item => item.metadata?.deviceHeld);
  const closureRequired = held.some(item => holdState(item, task.metadata, now) === 'closure_required');
  const error = !agent || agent.status !== 'active' || agent.capabilities?.agentKind !== 'android_mobile'
    ? 'MOBILE_AGENT_NOT_FOUND' : resumeError(task, items, now);
  const deadline = Date.parse(task.metadata.deadlineAt);
  const closedTimes = items.flatMap(item => [item.metadata?.deviceClosedAt, item.metadata?.closure?.evidence?.verifiedAt])
    .map(value => Date.parse(value)).filter(Number.isFinite);
  const state = closureRequired ? 'closure_required' : task.metadata.stopRequested ? held.length ? 'stopping' : 'stopped'
    : held.length ? 'working' : error === 'MOBILE_AGENT_NOT_FOUND' ? 'node_unavailable'
      : error === 'RUN_DEADLINE_EXPIRED' ? 'deadline_expired'
      : !error ? device.readyForSearch ? 'ready' : 'waiting_device' : 'not_needed';
  return {state, canResume: !error, resumeError: error, deviceHeld: held.length > 0, closureRequired,
    deviceOnline: device.online, deviceReady: device.readyForSearch, checkedAt: new Date(now).toISOString(),
    remainingMs: Number.isFinite(deadline) ? Math.max(0, deadline - now) : null,
    lastClosedAt: closedTimes.length ? new Date(Math.max(...closedTimes)).toISOString() : null};
}
export function receiptStats(checkpoint) {
  const source = checkpoint?.runner?.stats;
  if (!source) return null;
  return Object.fromEntries(['links', 'cards', 'swipes', 'keywordElapsedMs', 'batchElapsedMs']
    .filter(key => Number.isFinite(source[key]) && source[key] >= 0).map(key => [key, source[key]]));
}
