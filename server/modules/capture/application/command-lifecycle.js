import {text} from './control-outcome-projection.js';

export const RECOVERABLE_STATUSES = new Set([
  'interrupted',
  'needs_action',
  'failed',
  'completed_with_failures',
]);

export const REMOTELY_STOPPABLE_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
  'failed',
  'completed_with_failures',
]);

export function stopFailureStatus(previousStatus) {
  const normalized = text(previousStatus, 80);
  if (normalized === 'resume_requested') return 'needs_action';
  return REMOTELY_STOPPABLE_STATUSES.has(normalized)
    ? normalized
    : 'needs_action';
}

function requireDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function normalizeTenantLimit(value) {
  return Math.max(1, Math.min(500, Number(value) || 100));
}

export function createPendingCaptureCommandReconciler({
  listPendingTenants,
  withTransaction,
  expireTenantCommands,
} = {}) {
  const listTenants = requireDependency(
    'listPendingTenants',
    listPendingTenants,
  );
  const runTransaction = requireDependency('withTransaction', withTransaction);
  const expireCommands = requireDependency(
    'expireTenantCommands',
    expireTenantCommands,
  );
  let pendingReconciliation = null;

  return async function reconcilePendingCaptureCommands({
    tenantLimit = 100,
  } = {}) {
    if (pendingReconciliation) return pendingReconciliation;
    const limit = normalizeTenantLimit(tenantLimit);
    const reconciliation = (async () => {
      const tenants = await listTenants(limit);
      let commandCount = 0;
      for (const tenant of tenants) {
        const reconciled = await runTransaction(tx =>
          expireCommands(tx, tenant.tenant_id)
        );
        commandCount += reconciled.length;
      }
      return {tenantCount: tenants.length, commandCount};
    })();
    pendingReconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (pendingReconciliation === reconciliation) {
        pendingReconciliation = null;
      }
    }
  };
}
