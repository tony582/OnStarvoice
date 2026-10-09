/**
 * Attempt / failure code classes used by the elastic dispatcher and the
 * cross-device retry policy. Pure constants, moved verbatim out of
 * routes/capture-cloud.js; see task-status.js for the status side.
 *
 * The two safety-code sets (CROSS_DEVICE_RETRY_SAFETY_CODES and
 * AUTOMATIC_SEARCH_SAFETY_HANDOFF_CODES) deliberately stay in the route module
 * because they wrap lists owned by services/capture-health-schema.js and
 * services/capture-safety-handoff-policy.js; the domain layer must not depend
 * on services.
 */

/** The Agent could not take the work right now; the item is not charged an attempt. */
export const ELASTIC_AGENT_CAPACITY_CODES = new Set([
  'CAPTURE_TASK_GROUP_BUSY',
  'CAPTURE_TASK_CLEANUP_PENDING',
  'CAPTURE_TASK_DEBUG_BUSY',
  'CAPTURE_TASK_DEBUG_PREFLIGHT_UNAVAILABLE',
  'CAPTURE_TASK_DEBUG_PREFLIGHT_FAILED',
  'CAPTURE_TASK_DEBUG_STARVOICE_ACTIVE',
  'CAPTURE_TASK_EXTERNAL_DEBUGGER_BUSY',
  'CAPTURE_TASK_DEBUG_OWNERSHIP_UNKNOWN',
  'CAPTURE_LOCK_CONFLICT',
]);

/** Failures that do not consume one of the item's bounded attempts. */
export const ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES = new Set([
  ...ELASTIC_AGENT_CAPACITY_CODES,
  'CREATE_COMMAND_EXPIRED',
  'CREATE_AGENT_UNAVAILABLE',
  'UNATTENDED_BEGIN_FENCE_CHANGED',
  'STALE_UNATTENDED_ATTEMPT',
  'UNATTENDED_ATTEMPT_REPLACED',
  'UNATTENDED_STATUS_REPORT_TIMEOUT',
  'UNATTENDED_STATUS_REPORT_REJECTED',
  'UNATTENDED_RUNTIME_MESSAGE_TIMEOUT',
  'UNATTENDED_REQUEST_NOT_FOUND',
  'UNATTENDED_SEARCH_BOOTSTRAP_FAILED',
]);

/** Bootstrap failures that indicate a congested host rather than a broken item. */
export const ELASTIC_BOOTSTRAP_CONGESTION_CODES = new Set([
  'UNATTENDED_SEARCH_BOOTSTRAP_FAILED',
  'UNATTENDED_STATUS_REPORT_TIMEOUT',
  'UNATTENDED_RUNTIME_MESSAGE_TIMEOUT',
]);

/** The lease expired without the Agent reporting; the item goes back to the queue. */
export const ELASTIC_STALE_TASK_CODES = new Set([
  'ELASTIC_TASK_HEARTBEAT_TIMEOUT',
  'ELASTIC_AGENT_OFFLINE_TIMEOUT',
  'NEGATIVE_PATROL_START_TIMEOUT',
]);

/** Failures that no other Agent can fix; never retried across devices. */
export const CROSS_DEVICE_RETRY_PERMANENT_CODES = new Set([
  'CONTENT_UNAVAILABLE',
  'INVALID_RECORD',
  'LINK_MISSING',
  'IDENTITY_MISMATCH',
  'DOUYIN_DETAIL_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_CONFLICT',
  'CANCELED',
  'DETAIL_CAPTURE_CANCELED',
  'USER_CANCELED',
]);

/** The operator asked for the stop; not a failure to recover from. */
export const EXPLICIT_USER_CANCELLATION_CODES = new Set([
  'USER_CANCELED',
  'USER_CANCELLED',
  'USER_CANCEL_REQUESTED',
]);
