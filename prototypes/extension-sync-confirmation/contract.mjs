// UNWIRED DESIGN PROTOTYPE. Not part of the Extension shipping allowlist.
// The caller must correlate real responses to operations before using this API.
// These in-memory signals do not enforce production retries or durable fencing.

const STAGES = new Set(['content', 'comment_leads']);
const REMOTE_STATES = new Set([
  'acknowledged_success', 'acknowledged_failure', 'unknown', 'not_sent',
]);

function isAcknowledged(remoteState) {
  return remoteState === 'acknowledged_success' ||
    remoteState === 'acknowledged_failure';
}

function requireIdentity(value, field) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty, exact string identity`);
  }
  return value;
}

function snapshotOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError('operations must be an array');
  }
  const seen = new Set();
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new TypeError('each operation must be an object');
    }
    const operationId = requireIdentity(operation.operationId, 'operationId');
    const recordId = requireIdentity(operation.recordId, 'recordId');
    if (seen.has(operationId)) throw new TypeError('duplicate operationId');
    seen.add(operationId);
    const {stage, remoteState} = operation;
    if (!STAGES.has(stage)) throw new TypeError('unsupported confirmation stage');
    if (!REMOTE_STATES.has(remoteState)) throw new TypeError('unsupported remote state');
    const remoteResult = operation.remoteResult ?? null;
    if (remoteResult !== null &&
        (typeof remoteResult !== 'object' || Array.isArray(remoteResult))) {
      throw new TypeError('remoteResult must be an object or null');
    }
    if (isAcknowledged(remoteState) && remoteResult === null) {
      throw new TypeError('an acknowledged operation requires remote evidence');
    }
    if (remoteState === 'not_sent' && remoteResult !== null) {
      throw new TypeError('an unsent operation cannot have a remote result');
    }
    try {
      return {operationId, recordId, stage, remoteState,
        remoteResult: structuredClone(remoteResult)};
    } catch {
      throw new TypeError('remoteResult must be independently cloneable evidence');
    }
  });
}

function describeCommitException(error) {
  // Evidence only: consumers must not infer network retry policy from this text.
  try {
    const message = typeof error === 'string' ? error : error?.message;
    if (typeof message === 'string' && message.trim()) return message.slice(0, 512);
  } catch {
    // A throwing message getter must not discard the already captured ACKs.
  }
  return 'The injected local commit threw without a usable message';
}

/**
 * Model one local-confirmation pass over explicitly classified operations.
 * No request is dispatched here. operationId is not a server idempotency key.
 * No ledger is persisted here. A returned ledger is not a recovery guarantee.
 */
export async function confirmSyncOperations({operations, commit} = {}) {
  if (typeof commit !== 'function') {
    throw new TypeError('commit must be an injected function');
  }
  // Validate and snapshot the WHOLE batch before the first side effect or await.
  // A failure on B must not erase C-E, which may already be remotely acknowledged.
  const snapshots = snapshotOperations(operations);
  const ledger = snapshots.map((operation) => ({
    ...operation, localState: 'not_attempted', localError: null,
  }));
  let stoppedAtOperationId = null;

  for (let index = 0; index < snapshots.length; index += 1) {
    const operation = snapshots[index];
    if (!isAcknowledged(operation.remoteState)) continue;
    const entry = ledger[index];
    try {
      // The injected adapter cannot mutate the retained remote evidence.
      const confirmed = await commit(structuredClone(operation));
      if (confirmed === true) {
        entry.localState = 'confirmed';
        continue;
      }
      entry.localState = 'unconfirmed';
      entry.localError = {
        code: 'LOCAL_COMMIT_NOT_CONFIRMED',
        message: 'The local commit did not return true; remote evidence is retained',
      };
    } catch (error) {
      entry.localState = 'unconfirmed';
      entry.localError = {
        code: 'LOCAL_COMMIT_EXCEPTION',
        message: describeCommitException(error),
      };
    }
    stoppedAtOperationId = entry.operationId;
    break;
  }

  const count = (predicate) => ledger.filter(predicate).length;
  const requiresReconciliation = ledger.some((entry) =>
    entry.remoteState === 'unknown' ||
    (isAcknowledged(entry.remoteState) && entry.localState !== 'confirmed'),
  );
  return {
    schemaVersion: 1,
    operations: ledger,
    stoppedAtOperationId,
    requiresReconciliation,
    // A proposed consumer requirement, NOT a switch in the existing runtime.
    // false is not permission to replay confirmed or unconditionally retry failed work.
    blockAutomaticReplay: requiresReconciliation,
    totals: {
      operationCount: ledger.length,
      remoteSuccessCount: count((entry) => entry.remoteState === 'acknowledged_success'),
      remoteFailureCount: count((entry) => entry.remoteState === 'acknowledged_failure'),
      remoteUnknownCount: count((entry) => entry.remoteState === 'unknown'),
      notSentCount: count((entry) => entry.remoteState === 'not_sent'),
      localConfirmedCount: count((entry) => entry.localState === 'confirmed'),
      localUnconfirmedCount: count((entry) => entry.localState === 'unconfirmed'),
      localNotAttemptedCount: count((entry) => entry.localState === 'not_attempted'),
    },
  };
}
