function requireDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function normalizeCandidateLimit(value) {
  return Math.max(1, Math.min(50, Number(value) || 10));
}

function normalizeDispatchLimit(value) {
  return Math.max(1, Math.min(30, Number(value) || 30));
}

const MANUAL_ONLY_ERRORS = new Set([
  'retry_requires_manual_safety_action',
  'automatic_retry_disabled',
  'retry_items_not_automatically_recoverable',
]);

const CONFLICT_ERROR_CODES = new Set([
  'cross_device_retry_item_conflict',
  'cross_device_retry_revision_conflict',
]);

export function createAutomaticCaptureRetryReconciler({
  listCandidates,
  dispatchRetry,
  createRequestKey,
  formatErrorMessage,
} = {}) {
  const listRetryCandidates = requireDependency(
    'listCandidates',
    listCandidates,
  );
  const dispatchCandidateRetry = requireDependency(
    'dispatchRetry',
    dispatchRetry,
  );
  const nextRequestKey = requireDependency(
    'createRequestKey',
    createRequestKey,
  );
  const formatWorkerError = requireDependency(
    'formatErrorMessage',
    formatErrorMessage,
  );

  return async function reconcileAutomaticCaptureRetries(input = 10) {
    const options = input && typeof input === 'object' ? input : {limit: input};
    const candidateLimit = normalizeCandidateLimit(options.limit);
    const dispatchLimit = normalizeDispatchLimit(options.maxDispatchesPerTask);
    const requestedByName = options.requestedByName || '自动调度中心';
    const candidates = await listRetryCandidates(candidateLimit, options);
    const summary = {
      scanned: candidates.length,
      dispatched: 0,
      waitingForAgent: 0,
      manualOnly: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
    for (const candidate of candidates) {
      let expectedRevision = Number(candidate.orchestration_revision || 0);
      for (let allocation = 0; allocation < dispatchLimit; allocation += 1) {
        try {
          const result = await dispatchCandidateRetry({
            tenantId: candidate.tenant_id,
            taskId: candidate.id,
            requestKey: nextRequestKey(),
            expectedRevision,
            actorType: 'system',
            requestedByName,
            automatic: true,
          });
          if (!result?.error) {
            summary.dispatched += result.existing ? 0 : 1;
            expectedRevision = Number(
              result.parent?.orchestration_revision ?? expectedRevision,
            );
            summary.results.push({
              taskId: candidate.id,
              action: result.existing ? 'existing' : 'dispatched',
              retryTaskId: result.child?.id || '',
              itemCount: Number(result.itemCount || 0),
            });
            if (result.existing) break;
            continue;
          }
          if (result.error === 'idle_compatible_agent_unavailable') {
            summary.waitingForAgent += 1;
          } else if (MANUAL_ONLY_ERRORS.has(result.error)) {
            summary.manualOnly += 1;
          } else {
            summary.skipped += 1;
          }
          summary.results.push({
            taskId: candidate.id,
            action: result.error,
          });
          break;
        } catch (error) {
          if (
            error?.crossDeviceRetryError ||
            CONFLICT_ERROR_CODES.has(error?.code)
          ) {
            summary.skipped += 1;
            summary.results.push({
              taskId: candidate.id,
              action: error.crossDeviceRetryError || error.code,
            });
            break;
          }
          summary.failed += 1;
          summary.results.push({
            taskId: candidate.id,
            action: 'worker_error',
            message: formatWorkerError(error?.message),
          });
          break;
        }
      }
    }
    return summary;
  };
}
