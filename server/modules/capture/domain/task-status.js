/**
 * Cloud capture task state table.
 *
 * One place to read the status vocabulary that routes/capture-cloud.js used to
 * spread across twenty `new Set([...])` constants. Nothing here touches the
 * database or Express; the route module imports these sets unchanged, so this
 * is a pure move (first slice of the P3 "capture domain" extraction in
 * docs/架构优化实施方案与计划.md).
 *
 * Parent task statuses, in rough lifecycle order:
 *
 *   queued   : pending → assigned → dispatch_pending → dispatched → waiting_device
 *   active   : claimed → running → recovering → resume_requested
 *   attention: interrupted, needs_action, failed, completed_with_failures
 *   final    : completed, completed_with_warnings, canceled, skipped, superseded
 *
 * Work-item statuses add `retryable` (an item waiting for another Agent).
 *
 * Invariants (checked by tests/capture-task-status-table.test.mjs):
 *   - a final status is never remotely stoppable;
 *   - recoverable, dismissible and cross-device-retry source statuses are all
 *     subsets of the remotely stoppable set;
 *   - unstarted item statuses are a subset of cross-device-retry item statuses.
 */

/** Parent statuses an operator can ask to recover (重试/恢复). */
export const RECOVERABLE_STATUSES = new Set([
  'interrupted',
  'needs_action',
  'failed',
  'completed_with_failures',
]);

/** Parent statuses a remote stop command still makes sense for. */
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

/** Parent statuses after which a stop is a no-op. */
export const STOP_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'canceled',
  'skipped',
  'superseded',
]);

/** Attention roots an operator may dismiss without further action. */
export const DISMISSIBLE_ATTENTION_STATUSES = new Set([
  'failed',
  'completed_with_failures',
]);

/** Parent statuses that may be handed to a different Agent (换设备重试). */
export const CROSS_DEVICE_RETRY_SOURCE_STATUSES = new Set([
  'needs_action',
  'failed',
  'completed_with_failures',
]);

/** Follow-up task statuses that count as "still being handled automatically". */
export const AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES = new Set([
  'pending',
  'running',
]);

/** Work-item statuses eligible to be carried into a cross-device retry. */
export const CROSS_DEVICE_RETRY_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'retryable',
  'needs_action',
  'failed',
]);

/** Source statuses that count as settled when deciding whether a retry may start. */
export const CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
  'needs_action',
]);

/** Work-item statuses that never started executing on the source Agent. */
export const CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
]);

/** Task types that support cross-device retry at all. */
export const CROSS_DEVICE_RETRY_TASK_TYPES = new Set([
  'unattended_keyword_capture',
  'negative_post_patrol',
  'watched_content_patrol',
  'official_account_comment_patrol',
  'followed_creator_post_patrol',
  'official_account_post_discovery',
]);
