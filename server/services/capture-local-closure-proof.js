const LOCAL_CLOSURE_VERSION = 1;
const LOCAL_CLOSURE_MAX_AGE_MS = 30 * 60 * 1000;
const LOCAL_CLOSURE_FUTURE_SKEW_MS = 60 * 1000;

const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'cancelled',
  'skipped',
  'needs_action',
]);

function text(value, limit = 240) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback = -1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const parsed = timestamp(value);
  return parsed > 0 ? new Date(parsed).toISOString() : '';
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeCaptureLocalClosureEvidence(value = {}) {
  const source = object(value);
  const version = integer(source.version);
  const requestId = text(source.requestId || source.request_id);
  const attemptId = text(source.attemptId || source.attempt_id);
  const itemId = text(source.itemId || source.item_id, 100).toLowerCase();
  const itemAttemptId = text(
    source.itemAttemptId || source.item_attempt_id,
    100,
  ).toLowerCase();
  const attemptNumber = integer(
    source.attemptNumber ?? source.attempt_number,
  );
  const assignmentRevision = integer(
    source.assignmentRevision ?? source.assignment_revision,
  );
  const snapshotRevision = integer(
    source.snapshotRevision ?? source.snapshot_revision,
  );
  const terminalStatus = text(
    source.terminalStatus || source.terminal_status,
    80,
  ).toLowerCase();
  const terminalUpdatedAt = isoTimestamp(
    source.terminalUpdatedAt || source.terminal_updated_at,
  );
  const closedAt = isoTimestamp(source.closedAt || source.closed_at);
  const normalized = {
    version,
    requestId,
    attemptId,
    itemId,
    itemAttemptId,
    attemptNumber,
    assignmentRevision,
    snapshotRevision,
    terminalStatus,
    terminalUpdatedAt,
    closedAt,
    terminalLedgerConfirmed: source.terminalLedgerConfirmed === true,
    runnerTabCount: integer(source.runnerTabCount),
    platformTaskTabCount: integer(source.platformTaskTabCount),
    detailTaskTabCount: integer(source.detailTaskTabCount),
    ownedTaskTabCount: integer(source.ownedTaskTabCount),
    executionLockPresent:
      typeof source.executionLockPresent === 'boolean'
        ? source.executionLockPresent
        : null,
    debugSessionPresent:
      typeof source.debugSessionPresent === 'boolean'
        ? source.debugSessionPresent
        : null,
    taskSessionPresent:
      typeof source.taskSessionPresent === 'boolean'
        ? source.taskSessionPresent
        : null,
    taskOwnerPresent:
      typeof source.taskOwnerPresent === 'boolean'
        ? source.taskOwnerPresent
        : null,
    pendingCheckpointReportCount: integer(
      source.pendingCheckpointReportCount,
    ),
    businessUploadEvidenceKnown:
      source.businessUploadEvidenceKnown === true,
    streamingSyncDrainCompleted:
      source.streamingSyncDrainCompleted === true,
    streamingSyncEnabled:
      typeof source.streamingSyncEnabled === 'boolean'
        ? source.streamingSyncEnabled
        : null,
    streamingSyncEnqueuedCount: integer(
      source.streamingSyncEnqueuedCount,
    ),
    streamingSyncProcessedCount: integer(
      source.streamingSyncProcessedCount,
    ),
    streamingSyncSuccessCount: integer(
      source.streamingSyncSuccessCount,
    ),
    streamingSyncFailedCount: integer(
      source.streamingSyncFailedCount,
    ),
    streamingSyncSkippedCount: integer(
      source.streamingSyncSkippedCount,
    ),
    streamingSyncPendingCount: integer(
      source.streamingSyncPendingCount,
    ),
    streamingSyncActiveCount: integer(
      source.streamingSyncActiveCount,
    ),
    streamingSyncRemainingCount: integer(
      source.streamingSyncRemainingCount,
    ),
    streamingSyncBlocked:
      typeof source.streamingSyncBlocked === 'boolean'
        ? source.streamingSyncBlocked
        : null,
    streamingSyncCanceled:
      typeof source.streamingSyncCanceled === 'boolean'
        ? source.streamingSyncCanceled
        : null,
    capturedRecordCount: integer(source.capturedRecordCount),
  };
  const uploadCountsMatch = normalized.streamingSyncEnabled === true
    ? normalized.streamingSyncEnqueuedCount === normalized.capturedRecordCount &&
      normalized.streamingSyncProcessedCount ===
        normalized.streamingSyncEnqueuedCount &&
      normalized.streamingSyncSuccessCount ===
        normalized.streamingSyncEnqueuedCount
    : normalized.streamingSyncEnabled === false &&
      normalized.capturedRecordCount === 0 &&
      normalized.streamingSyncEnqueuedCount === 0 &&
      normalized.streamingSyncProcessedCount === 0 &&
      normalized.streamingSyncSuccessCount === 0;
  if (
    version !== LOCAL_CLOSURE_VERSION ||
    !requestId ||
    !attemptId ||
    !itemId ||
    !itemAttemptId ||
    attemptNumber < 1 ||
    assignmentRevision < 0 ||
    snapshotRevision < 0 ||
    !TERMINAL_STATUSES.has(terminalStatus) ||
    !terminalUpdatedAt ||
    !closedAt ||
    normalized.terminalLedgerConfirmed !== true ||
    normalized.runnerTabCount !== 0 ||
    normalized.platformTaskTabCount !== 0 ||
    normalized.detailTaskTabCount !== 0 ||
    normalized.ownedTaskTabCount !== 0 ||
    normalized.executionLockPresent !== false ||
    normalized.debugSessionPresent !== false ||
    normalized.taskSessionPresent !== false ||
    normalized.taskOwnerPresent !== false ||
    normalized.pendingCheckpointReportCount !== 0 ||
    normalized.businessUploadEvidenceKnown !== true ||
    normalized.streamingSyncDrainCompleted !== true ||
    normalized.streamingSyncFailedCount !== 0 ||
    normalized.streamingSyncSkippedCount !== 0 ||
    normalized.streamingSyncPendingCount !== 0 ||
    normalized.streamingSyncActiveCount !== 0 ||
    normalized.streamingSyncRemainingCount !== 0 ||
    normalized.streamingSyncBlocked !== false ||
    normalized.streamingSyncCanceled !== false ||
    !uploadCountsMatch
  ) {
    return null;
  }
  return Object.freeze(normalized);
}

export function normalizeCaptureLocalClosureEvidenceList(value = []) {
  const source = array(value);
  if (source.length === 0 || source.length > 30) return Object.freeze([]);
  const normalized = source.map(normalizeCaptureLocalClosureEvidence);
  if (normalized.some(entry => !entry)) return Object.freeze([]);
  const identities = new Set();
  for (const entry of normalized) {
    const identity = `${entry.itemId}:${entry.itemAttemptId}`;
    if (identities.has(identity)) return Object.freeze([]);
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

export function selectCaptureLocalClosureEvidence({
  evidence = {},
  evidences,
  expectedItemId = '',
  expectedItemAttemptId = '',
} = {}) {
  const normalizedItemId = text(expectedItemId, 100).toLowerCase();
  const normalizedItemAttemptId = text(
    expectedItemAttemptId,
    100,
  ).toLowerCase();
  if (!normalizedItemId || !normalizedItemAttemptId) return null;
  const pluralEvidenceProvided = evidences !== undefined && evidences !== null;
  if (pluralEvidenceProvided) {
    const normalizedEvidences = normalizeCaptureLocalClosureEvidenceList(
      evidences,
    );
    // Once a plural channel is present it is authoritative. Empty, oversized,
    // duplicate, or partly malformed arrays must not fall back to the legacy
    // first-item object, otherwise a damaged new-client report could still
    // authorize one item through the rolling-upgrade compatibility path.
    if (normalizedEvidences.length === 0) return null;
    const matches = normalizedEvidences.filter(entry =>
      entry.itemId === normalizedItemId &&
      entry.itemAttemptId === normalizedItemAttemptId
    );
    return matches.length === 1 ? matches[0] : null;
  }
  const legacy = normalizeCaptureLocalClosureEvidence(evidence);
  return legacy &&
    legacy.itemId === normalizedItemId &&
    legacy.itemAttemptId === normalizedItemAttemptId
    ? legacy
    : null;
}

export function verifyCaptureLocalClosureProof({
  evidence = {},
  expectedRequestId = '',
  expectedAttemptId = '',
  expectedItemId = '',
  expectedItemAttemptId = '',
  expectedAttemptNumber = 0,
  expectedAssignmentRevision = 0,
  expectedSnapshotRevision = 0,
  expectedAgentId = '',
  snapshotAgentId = '',
  snapshotStatus = '',
  snapshotReceivedAt = '',
  now = new Date(),
} = {}) {
  const normalized = normalizeCaptureLocalClosureEvidence(evidence);
  const nowMs = timestamp(now);
  const receivedAtMs = timestamp(snapshotReceivedAt);
  const closedAtMs = timestamp(normalized?.closedAt);
  const checks = Object.freeze({
    normalized: Boolean(normalized),
    request: Boolean(
      normalized &&
      normalized.requestId === text(expectedRequestId),
    ),
    attempt: Boolean(
      normalized &&
      normalized.attemptId === text(expectedAttemptId),
    ),
    item: Boolean(
      normalized &&
      normalized.itemId === text(expectedItemId, 100).toLowerCase(),
    ),
    itemAttempt: Boolean(
      normalized &&
      normalized.itemAttemptId ===
        text(expectedItemAttemptId, 100).toLowerCase(),
    ),
    attemptNumber: Boolean(
      normalized &&
      normalized.attemptNumber === integer(expectedAttemptNumber),
    ),
    assignmentRevision: Boolean(
      normalized &&
      normalized.assignmentRevision === integer(expectedAssignmentRevision),
    ),
    snapshotRevision: Boolean(
      normalized &&
      normalized.snapshotRevision === integer(expectedSnapshotRevision),
    ),
    agent: Boolean(
      text(expectedAgentId, 100).toLowerCase() &&
      text(expectedAgentId, 100).toLowerCase() ===
        text(snapshotAgentId, 100).toLowerCase(),
    ),
    terminalSnapshot: TERMINAL_STATUSES.has(
      text(snapshotStatus, 80).toLowerCase(),
    ),
    terminalStatusMatches: Boolean(
      normalized &&
      normalized.terminalStatus === text(snapshotStatus, 80).toLowerCase(),
    ),
    freshSnapshot: Boolean(
      nowMs > 0 &&
      receivedAtMs > 0 &&
      receivedAtMs <= nowMs + LOCAL_CLOSURE_FUTURE_SKEW_MS &&
      nowMs - receivedAtMs <= LOCAL_CLOSURE_MAX_AGE_MS,
    ),
    saneClosureClock: Boolean(
      normalized &&
      nowMs > 0 &&
      closedAtMs > 0 &&
      closedAtMs <= nowMs + LOCAL_CLOSURE_FUTURE_SKEW_MS &&
      closedAtMs <= receivedAtMs + LOCAL_CLOSURE_FUTURE_SKEW_MS,
    ),
  });
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  return Object.freeze({
    proven: failedChecks.length === 0,
    reason: failedChecks.length === 0
      ? 'authoritative_local_closure_proven'
      : 'source_local_closure_proof_unavailable',
    failedChecks: Object.freeze(failedChecks),
    checks,
    evidence: normalized,
  });
}

export const CAPTURE_LOCAL_CLOSURE_EVIDENCE_VERSION =
  LOCAL_CLOSURE_VERSION;
export const CAPTURE_LOCAL_CLOSURE_MAX_AGE_MS =
  LOCAL_CLOSURE_MAX_AGE_MS;
