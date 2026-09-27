// Automatic settlement of dead 需处理 roots (docs/hotfix/20260927-unattended-self-heal.md, S4).
//
// Some needs_action roots can never move again: a phone-discovered post whose
// detail capture ended without an ingestion receipt, a manual batch whose page
// was closed, a standalone phone run past its deadline, a phone batch whose
// keywords used up their attempts. Nobody can act on them, yet they stay in
// 需处理 forever. This module only decides WHICH roots to settle and WHEN; the
// judgement and the settlement are F3's 「结束并移到历史」
// (loadOperatorCloseEligibility / closeOperatorAttentionRoot, mode 'automatic',
// actor 'system'), so every F3 guard (late snapshots, late receipts, local
// recovery, resume, retry) covers these rows too.
//
// Never automatic: a stop fence anywhere in the tree (F3 `stop_fence`; only a
// node proof or an operator releases it), any manual-action or platform-safety
// mark on the rows that would be settled, live work (F3), and every root that
// is not one of the four kinds below. The sweep runs from cron every five
// minutes; it never runs the admission fence SQL.

import {queryAll as poolQueryAll, withTransaction as poolWithTransaction} from '../db/query.js';
import {
  OPERATOR_CLOSE_AUTOMATIC_ACTOR_NAME,
  closeOperatorAttentionRoot,
  loadOperatorCloseEligibility,
} from './capture-operator-close.js';
import {MOBILE_ELASTIC_ATTEMPT_LIMIT} from './android-control/leases.js';
import {MOBILE_MANUAL_ACTION_REASONS, WORKFLOW as MOBILE_WORKFLOW} from './android-control/validation.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STOP_FENCE_CODE = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED';
const DISCOVERED_POST_WORKFLOW = 'discovered_post_capture';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const DEAD_ATTENTION_KINDS = Object.freeze({
  // K1: phone-discovered post, detail capture without an ingestion receipt.
  discoveredPostDetail: 'discovered_post_detail',
  // K2: manual keyword batch (the controller never replays it).
  manualBatch: 'manual_batch',
  // K3: standalone phone run past its deadline (resume is refused).
  standaloneMobileRun: 'standalone_mobile_run',
  // K4: phone batch whose needs_action keywords all used up their attempts.
  mobileBatchExhausted: 'mobile_batch_exhausted',
});

// Named, logged per kind, so they can be tuned from production data.
export const DEAD_ATTENTION_GRACE_MS = Object.freeze({
  discoveredPostReportedFailed: 10 * MINUTE,
  // A completed report without a receipt: give a late upload a day to land.
  discoveredPostReportedCompleted: 24 * HOUR,
  discoveredPostCreateExpired: 30 * MINUTE,
  manualBatch: HOUR,
  standaloneMobileAfterDeadline: 30 * MINUTE,
  mobileBatchElastic: 6 * HOUR,
  // A fixed phone batch may still be picked up across devices for a day.
  mobileBatchFixed: 24 * HOUR,
});
// The shortest grace above; the candidate SQL never reads younger rows.
export const DEAD_ATTENTION_MIN_AGE_MS = 10 * MINUTE;
export const DEAD_ATTENTION_PAGE_LIMIT = 50;
export const DEAD_ATTENTION_LOCK_TIMEOUT_MS = 500;

// Codes that mean a person has to look at the platform (login walls,
// verification, rate limits). Union of the attention notifier, the elastic
// safety handoff and the phone safety codes.
export const DEAD_ATTENTION_SAFETY_CODES = Object.freeze([
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_CAPTCHA_REQUIRED',
  'CAPTCHA_PAGE_DETECTED',
  'PLATFORM_SAFETY_BLOCK',
  'SECURITY_VERIFICATION_REQUIRED',
  'XHS_SECURITY_BLOCK',
  'PAGE_CHALLENGE_BLOCK',
  'PAGE_CHALLENGE',
  'HTTP_429',
  'RATE_LIMITED',
  'CAPTCHA_REQUIRED',
  'LOGIN_REQUIRED',
  'AUTH_REQUIRED',
  'DOUYIN_LOGIN_REQUIRED',
  'XHS_LOGIN_REQUIRED',
  'ACCOUNT_SECURITY_BLOCK',
  'SECURITY_CHECK',
  'SECURITY_BLOCKED',
]);
const SAFETY_CATEGORIES = Object.freeze(['platform_safety_block', 'login_required', 'authentication_required']);

export function deadAttentionSweepEnabled(env = process.env) {
  return String(env?.CAPTURE_DEAD_ATTENTION_SWEEP ?? '').trim().toLowerCase() !== 'off';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function flagged(value) {
  return value === true || value === 'true';
}

/** A manual-action or platform-safety mark on one error-like object. */
export function deadAttentionManualMark(error) {
  const value = object(error);
  return flagged(value.requiresManualAction) ||
    flagged(value.securityBlocked) ||
    flagged(value.platformSafetyBlocked) ||
    flagged(object(value.securityEvidence).confirmed) ||
    SAFETY_CATEGORIES.includes(text(value.category, 80).toLowerCase()) ||
    DEAD_ATTENTION_SAFETY_CODES.includes(text(value.code, 100).toUpperCase());
}

// SQL twin of deadAttentionManualMark for a jsonb expression; $safety binds
// DEAD_ATTENTION_SAFETY_CODES and $categories SAFETY_CATEGORIES.
function manualMarkSql(column, safety, categories) {
  return `(COALESCE(${column}->>'requiresManualAction', '') = 'true'
      OR COALESCE(${column}->>'securityBlocked', '') = 'true'
      OR COALESCE(${column}->>'platformSafetyBlocked', '') = 'true'
      OR COALESCE(${column}->'securityEvidence'->>'confirmed', '') = 'true'
      OR LOWER(COALESCE(${column}->>'category', '')) = ANY(${categories}::text[])
      OR UPPER(COALESCE(${column}->>'code', '')) = ANY(${safety}::text[]))`;
}

// Cheap, index-backed candidates of one tenant: needs_action roots of the
// four kinds, never fenced or manual-marked at the root, older than the
// shortest grace, after the cursor. Uses idx_capture_tasks_tenant_status_updated.
export const DEAD_ATTENTION_CANDIDATE_SQL = `
  SELECT t.id, t.task_type, t.platform, t.status, t.parent_task_id, t.updated_at,
    t.metadata, t.error,
    -- The cursor keeps PostgreSQL's microseconds: rows written by one
    -- statement share one updated_at, and a millisecond cursor would read
    -- the same page again forever.
    to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
  FROM capture_tasks t
  WHERE t.tenant_id = $1
    AND t.status = 'needs_action'
    AND t.parent_task_id IS NULL
    AND t.attention_dismissed_at IS NULL
    AND UPPER(COALESCE(t.error->>'code', '')) <> '${STOP_FENCE_CODE}'
    AND NOT ${manualMarkSql('t.error', '$5', '$6')}
    AND t.updated_at < now() - ($7::integer * interval '1 millisecond')
    AND (
      (t.task_type = '${DISCOVERED_POST_WORKFLOW}'
        AND t.metadata->>'workflow' = '${DISCOVERED_POST_WORKFLOW}'
        AND t.error->>'code' IN ('detail_finished_without_ingestion', 'detail_create_expired'))
      OR (t.task_type = 'capture' AND t.metadata->>'executionMode' = 'manual_batch')
      OR (t.task_type = 'capture' AND t.metadata->>'workflow' = '${MOBILE_WORKFLOW}')
      OR (t.task_type = 'capture_orchestration' AND t.platform = 'douyin'
        AND COALESCE(t.metadata->>'orchestrationTemplate', 'false') <> 'true')
    )
    AND ($2::timestamptz IS NULL OR (t.updated_at, t.id) > ($2::timestamptz, $3::uuid))
  ORDER BY t.updated_at, t.id
  LIMIT $4`;

/**
 * Per-root facts of the rows the settlement would touch, in one statement:
 * a manual-action / safety mark on an unfinished task of the tree or on a
 * needs_action work item (its error, checkpoint, phone reason or any of its
 * attempts), and for phone batches how many needs_action items there are and
 * how many of them are phone keywords that used up their attempts.
 */
export async function loadDeadAttentionTreeFlags(executor, tenantId, rootIds = []) {
  const ids = [...new Set((Array.isArray(rootIds) ? rootIds : [])
    .map(id => text(id, 100).toLowerCase())
    .filter(id => UUID.test(id)))];
  const result = new Map();
  if (ids.length === 0) return result;
  const rows = await executor.queryAll(`WITH RECURSIVE tree AS (
      SELECT root.id AS root_id, root.id, root.status, root.error
      FROM capture_tasks root
      WHERE root.tenant_id = $1 AND root.id = ANY($2::uuid[])
      UNION
      SELECT tree.root_id, child.id, child.status, child.error
      FROM capture_tasks child
      JOIN tree ON child.parent_task_id = tree.id
      WHERE child.tenant_id = $1
    ), node AS (
      SELECT tree.root_id,
        (tree.status NOT IN ('completed', 'completed_with_warnings', 'canceled', 'skipped', 'superseded')
          AND ${manualMarkSql('tree.error', '$5', '$6')}) AS task_manual,
        items.*
      FROM tree
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE item.status = 'needs_action')::int AS needs_action_items,
          COUNT(*) FILTER (
            WHERE item.status = 'needs_action'
              AND item.attempt_count >= $3
              AND EXISTS (
                SELECT 1 FROM capture_tasks execution
                WHERE execution.tenant_id = $1 AND execution.id = item.execution_task_id
                  AND execution.metadata->>'workflow' = '${MOBILE_WORKFLOW}'
              )
          )::int AS exhausted_mobile_items,
          COALESCE(BOOL_OR(item.status = 'needs_action' AND (
            ${manualMarkSql('item.error', '$5', '$6')}
            OR ${manualMarkSql("item.metadata->'checkpoint'", '$5', '$6')}
            OR LOWER(COALESCE(item.metadata->>'reason', '')) = ANY($4::text[])
            OR EXISTS (
              SELECT 1 FROM capture_task_item_attempts attempt
              WHERE attempt.tenant_id = $1 AND attempt.item_id = item.id
                AND (LOWER(COALESCE(attempt.result->>'reason', '')) = ANY($4::text[])
                  OR ${manualMarkSql('attempt.error', '$5', '$6')})
            )
          )), false) AS item_manual
        FROM capture_task_items item
        WHERE item.tenant_id = $1 AND item.task_id = tree.id
      ) items
    )
    SELECT root_id,
      BOOL_OR(task_manual OR item_manual) AS manual_required,
      COALESCE(SUM(needs_action_items), 0)::int AS needs_action_items,
      COALESCE(SUM(exhausted_mobile_items), 0)::int AS exhausted_mobile_items
    FROM node
    GROUP BY root_id
  `, [
    text(tenantId, 100), ids, MOBILE_ELASTIC_ATTEMPT_LIMIT, MOBILE_MANUAL_ACTION_REASONS,
    DEAD_ATTENTION_SAFETY_CODES, SAFETY_CATEGORIES,
  ]);
  for (const row of rows) {
    result.set(String(row.root_id).toLowerCase(), {
      manualRequired: row.manual_required === true,
      needsActionItems: Number(row.needs_action_items) || 0,
      exhaustedMobileItems: Number(row.exhausted_mobile_items) || 0,
    });
  }
  return result;
}

function discoveredPostGrace(error) {
  const code = text(error.code, 100);
  if (code === 'detail_create_expired') return DEAD_ATTENTION_GRACE_MS.discoveredPostCreateExpired;
  const reported = text(error.reportedStatus, 80);
  if (reported === 'failed') return DEAD_ATTENTION_GRACE_MS.discoveredPostReportedFailed;
  if (['completed', 'completed_with_warnings'].includes(reported)) {
    return DEAD_ATTENTION_GRACE_MS.discoveredPostReportedCompleted;
  }
  // needs_action and anything else: the device asked for a person.
  return null;
}

/**
 * Which kind a root is and whether the automatic settlement may close it now.
 * {kind, eligible, reason, dueAt}. F3's eligibility is judged separately.
 */
export function classifyDeadAttentionRoot(row = {}, flags = null, now = Date.now()) {
  const metadata = object(row.metadata);
  const error = object(row.error);
  const updatedMs = toMs(row.updated_at);
  const refuse = (reason, kind = '') => ({kind, eligible: false, reason, dueAt: null});
  if (row.parent_task_id || row.status !== 'needs_action') return refuse('not_candidate');
  if (text(error.code, 100).toUpperCase() === STOP_FENCE_CODE) return refuse('stop_fence');
  if (deadAttentionManualMark(error)) return refuse('manual_action_required');
  let kind = '';
  let dueMs = NaN;
  if (row.task_type === DISCOVERED_POST_WORKFLOW && metadata.workflow === DISCOVERED_POST_WORKFLOW &&
      ['detail_finished_without_ingestion', 'detail_create_expired'].includes(text(error.code, 100))) {
    kind = DEAD_ATTENTION_KINDS.discoveredPostDetail;
    const grace = discoveredPostGrace(error);
    if (grace === null) return refuse('reported_status_needs_person', kind);
    dueMs = updatedMs + grace;
  } else if (row.task_type === 'capture' && metadata.executionMode === 'manual_batch') {
    kind = DEAD_ATTENTION_KINDS.manualBatch;
    dueMs = updatedMs + DEAD_ATTENTION_GRACE_MS.manualBatch;
  } else if (row.task_type === 'capture' && metadata.workflow === MOBILE_WORKFLOW) {
    kind = DEAD_ATTENTION_KINDS.standaloneMobileRun;
    const deadlineMs = toMs(metadata.deadlineAt);
    if (!Number.isFinite(deadlineMs)) return refuse('deadline_unknown', kind);
    dueMs = Math.max(deadlineMs + DEAD_ATTENTION_GRACE_MS.standaloneMobileAfterDeadline,
      updatedMs + DEAD_ATTENTION_MIN_AGE_MS);
  } else if (row.task_type === 'capture_orchestration' && row.platform === 'douyin' &&
      metadata.orchestrationTemplate !== true && metadata.orchestrationTemplate !== 'true') {
    kind = DEAD_ATTENTION_KINDS.mobileBatchExhausted;
    const facts = object(flags);
    if (!(facts.needsActionItems > 0) || facts.exhaustedMobileItems !== facts.needsActionItems) {
      return refuse('not_exhausted_mobile_batch', kind);
    }
    dueMs = updatedMs + (metadata.distributionMode === 'elastic_pool'
      ? DEAD_ATTENTION_GRACE_MS.mobileBatchElastic
      : DEAD_ATTENTION_GRACE_MS.mobileBatchFixed);
  } else {
    return refuse('not_dead_kind');
  }
  if (!flags) return refuse('tree_unknown', kind);
  if (flags.manualRequired === true) return refuse('manual_action_required', kind);
  if (!Number.isFinite(dueMs)) return refuse('grace_unknown', kind);
  const dueAt = new Date(dueMs).toISOString();
  if (Number(now) < dueMs) return {kind, eligible: false, reason: 'grace_period', dueAt};
  return {kind, eligible: true, reason: '', dueAt};
}

// In-process cursor per tenant: a page that is not full starts over next
// time, so rows that can never be settled (live batches, manual marks, grace
// not over) are read at most once per round and never starve later rows.
// A restart starts from the beginning.
const cursors = new Map();

export function resetDeadAttentionCursors() {
  cursors.clear();
}

function lockBusy(error) {
  return ['55P03', '40P01'].includes(error?.code) || error?.code === 'OPERATOR_CLOSE_NOT_TERMINAL';
}

function logError(logger, message, error) {
  try {
    logger?.error?.(message, error?.code || '', error?.message || error);
  } catch {
    // A custom logger never stops the sweep.
  }
}

/**
 * One sweep over every active tenant (or the given ones). The candidate
 * read is one short read-only transaction per tenant (candidates, F3
 * eligibility, tree flags); every settlement is its own short transaction
 * that F3 locks and judges again, with the automatic conditions re-checked
 * on the locked rows.
 */
export async function sweepDeadAttentionRoots({
  limit = DEAD_ATTENTION_PAGE_LIMIT,
  tenantIds = null,
  refreshOrchestrationParent,
  queryAll = poolQueryAll,
  withTransaction = poolWithTransaction,
  now = () => Date.now(),
  logger = console,
  env = process.env,
} = {}) {
  const summary = {tenants: 0, scanned: 0, settled: 0, skipped: 0, busy: 0, failed: 0, kinds: {}};
  if (!deadAttentionSweepEnabled(env)) return {...summary, disabled: true};
  if (typeof refreshOrchestrationParent !== 'function') {
    throw new TypeError('orchestration_parent_projector_required');
  }
  const pageLimit = Math.max(1, Math.min(200, Number(limit) || DEAD_ATTENTION_PAGE_LIMIT));
  const tenants = Array.isArray(tenantIds)
    ? tenantIds.map(id => ({id}))
    : await queryAll("SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
  for (const tenant of tenants) {
    const tenantId = text(tenant.id, 100).toLowerCase();
    if (!UUID.test(tenantId)) continue;
    summary.tenants += 1;
    const cursor = cursors.get(tenantId) || null;
    let page;
    try {
      page = await withTransaction(async tx => {
        const rows = await tx.queryAll(DEAD_ATTENTION_CANDIDATE_SQL, [
          tenantId, cursor?.updatedAt || null, cursor?.id || null, pageLimit,
          DEAD_ATTENTION_SAFETY_CODES, SAFETY_CATEGORIES, DEAD_ATTENTION_MIN_AGE_MS,
        ]);
        if (rows.length === 0) return {rows, eligibility: new Map(), flags: new Map()};
        const ids = rows.map(row => row.id);
        return {
          rows,
          eligibility: await loadOperatorCloseEligibility(tx, tenantId, ids),
          flags: await loadDeadAttentionTreeFlags(tx, tenantId, ids),
        };
      }, {readOnly: true, statementTimeoutMs: 10_000});
    } catch (error) {
      // One tenant never stops the others; the next round reads it again.
      summary.failed += 1;
      logError(logger, `[dead-attention] candidate read failed tenant=${tenantId}:`, error);
      continue;
    }
    const {rows} = page;
    if (rows.length < pageLimit) cursors.delete(tenantId);
    else {
      const last = rows[rows.length - 1];
      cursors.set(tenantId, {updatedAt: last.cursor_updated_at, id: last.id});
    }
    summary.scanned += rows.length;
    for (const row of rows) {
      const id = String(row.id).toLowerCase();
      const eligibility = page.eligibility.get(id);
      const verdict = classifyDeadAttentionRoot(row, page.flags.get(id) || null, now());
      if (!verdict.eligible || !eligibility?.eligible) {
        summary.skipped += 1;
        continue;
      }
      let result;
      try {
        result = await withTransaction(tx => closeOperatorAttentionRoot(tx, {
          tenantId,
          rootId: id,
          actor: {type: 'system', name: OPERATOR_CLOSE_AUTOMATIC_ACTOR_NAME},
          mode: 'automatic',
          refreshOrchestrationParent,
          // K4 stays in 需处理 as completed_with_failures by default, like a
          // browser batch with failures (「清理已结束失败项」 moves it).
          dismissAttention: verdict.kind !== DEAD_ATTENTION_KINDS.mobileBatchExhausted,
          eventPayload: {kind: verdict.kind, dueAt: verdict.dueAt},
          // The automatic conditions, judged again on the locked rows.
          verify: async (lockedTx, {root}) => {
            const flags = (await loadDeadAttentionTreeFlags(lockedTx, tenantId, [id])).get(id) || null;
            const again = classifyDeadAttentionRoot(root, flags, now());
            if (!again.eligible) return again.reason || 'not_candidate';
            return again.kind === verdict.kind ? '' : 'kind_changed';
          },
        }), {lockTimeoutMs: DEAD_ATTENTION_LOCK_TIMEOUT_MS, statementTimeoutMs: 15_000});
      } catch (error) {
        if (lockBusy(error)) summary.busy += 1;
        else {
          // Rolled back; one root never stops the sweep.
          summary.failed += 1;
          logError(logger, `[dead-attention] settle failed task=${id} tenant=${tenantId}:`, error);
        }
        continue;
      }
      if (result?.error || result?.idempotent) {
        summary.skipped += 1;
        continue;
      }
      summary.settled += 1;
      summary.kinds[verdict.kind] = (summary.kinds[verdict.kind] || 0) + 1;
      logger?.log?.(`[dead-attention] settled ${verdict.kind} task=${id} tenant=${tenantId} ` +
        `items failed=${result.failedItemCount} canceled=${result.canceledItemCount}`);
    }
  }
  return summary;
}
