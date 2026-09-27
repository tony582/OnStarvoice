// 「结束并移到历史」: the operator exit for needs_action root tasks that have no
// live work left (docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md, F3).
//
// Eligibility is one recursive SQL over the root's subtree. It never runs the
// admission stop-fence SQL (captureTaskUnconfirmedLocalStopSql, ~275 ms) nor
// the slot blocker: the fence check here is the cheap part of the admission
// predicate, a strict superset of the real fence, so a tree that might still
// fence a node is always refused and must go through 「确认旧页面已停止」.
//
// Closing sends no device command and never touches discovery candidates,
// discovery demands or unattended_negative_patrol_state. It turns the root and
// its needs_action descendants, items and attempts terminal, keeps the
// original status/error under metadata.operatorClose, dismisses the attention
// row and records an event plus an audit log. An orchestration root is
// re-aggregated from its items (injected route projector) instead of being
// forced to failed, so counts and the schedule's last_run_status agree.

export const OPERATOR_CLOSE_EVENT = 'task_operator_closed';
export const OPERATOR_CLOSE_AUDIT_ACTION = 'capture_task.operator_closed';
export const OPERATOR_CLOSE_ROOT_MESSAGE = '已结束并移到历史（未重新采集）';
export const OPERATOR_CLOSE_CHILD_MESSAGE = '已由操作员结束（未重新采集）';
export const OPERATOR_CLOSE_ORCHESTRATION_MESSAGE =
  '已由操作员结束并移到历史；未完成的工作项已标记失败，已完成结果保留';
export const OPERATOR_CLOSE_EVENT_MESSAGE = '操作员结束任务并移到历史（未重新采集，未向设备发送指令）';
export const OPERATOR_CLOSE_SUCCESS_MESSAGE = '已结束并移到历史，采集结果已保留';
// docs/hotfix/20260927-unattended-self-heal.md (S4): the same close, run by the
// system for rows nobody can act on (mode 'automatic', actor type 'system').
export const OPERATOR_CLOSE_AUTOMATIC_ACTOR_NAME = '系统自动结算';
export const OPERATOR_CLOSE_AUTOMATIC_ROOT_MESSAGE = '系统已自动结束并移到历史（没有可继续的工作，未重新采集）';
export const OPERATOR_CLOSE_AUTOMATIC_CHILD_MESSAGE = '已由系统自动结束（未重新采集）';
export const OPERATOR_CLOSE_AUTOMATIC_ORCHESTRATION_MESSAGE =
  '系统已自动结束：用尽次数的工作项已标记失败，已完成结果保留';
export const OPERATOR_CLOSE_AUTOMATIC_EVENT_MESSAGE =
  '系统自动结算：任务已没有可继续的工作，结束并移到历史（未重新采集，未向设备发送指令）';
export const OPERATOR_CLOSE_MODES = Object.freeze(['single', 'bulk', 'automatic']);
export const OPERATOR_CLOSE_CLOSEABLE_STATUS = 'needs_action';
export const OPERATOR_CLOSED_TASK_STATUSES = Object.freeze(['failed', 'completed_with_failures']);
export const OPERATOR_CLOSE_MAX_BULK = 100;
export const OPERATOR_CLOSE_LOCK_TIMEOUT_MS = 2000;
const STANDALONE_MOBILE_WORKFLOW = 'douyin_mobile_discovery';
const STOP_FENCE_CODE = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED';

// Checked in this order; the first hit is the reason. The Admin has one text
// per reason (operator-close-presentation.mjs); keep both lists in step.
export const OPERATOR_CLOSE_REASONS = Object.freeze([
  'not_root',
  'interrupted',
  'status_not_closeable',
  'stop_fence',
  'stop_pending',
  'live_child',
  'live_command',
  'device_held',
  'live_item',
  'negative_patrol_needs_action',
  'active_discovery_demand',
]);
// Reasons an operator can act on; the Admin explains these on the card.
export const OPERATOR_CLOSE_EXPLAINED_REASONS = Object.freeze(
  OPERATOR_CLOSE_REASONS.filter(reason => !['not_root', 'status_not_closeable'].includes(reason)),
);
const LIVE_WORK_MESSAGE = '仍有进行中、排队或等待自动恢复的工作，结束后再处理';
// API messages; the Admin card uses the same text for the explained reasons.
export const OPERATOR_CLOSE_REASON_MESSAGES = Object.freeze({
  not_root: '子任务请在编排详情中处理，不能从主任务队列单独结束',
  interrupted: '任务被中断，节点上的旧页面可能仍在运行；请等节点结算，或先「继续」或「停止」',
  status_not_closeable: '只有状态为“需要处理”的主任务可以结束并移到历史',
  stop_fence: '包含未确认停止的旧采集页面：批次子任务请在节点上「确认旧页面已停止」，单独的任务请先「继续」或「停止」',
  stop_pending: LIVE_WORK_MESSAGE,
  live_child: LIVE_WORK_MESSAGE,
  live_command: LIVE_WORK_MESSAGE,
  device_held: '手机仍占用该任务，请先在手机页结束占用',
  live_item: LIVE_WORK_MESSAGE,
  negative_patrol_needs_action: '含需处理的负面巡查帖子，请先在批次详情里「恢复失败巡查」，否则这些帖子不会再被巡查',
  active_discovery_demand: '仍有手机发现作品在等待补详情',
});

// Descendant states that still own (or may still own) a browser, a phone or
// a pending decision. interrupted is here on purpose: it keeps the node's
// capture slot until the Extension settles it (CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES).
const LIVE_CHILD_STATUSES = Object.freeze([
  'pending', 'waiting_device', 'claimed', 'running', 'recovering',
  'interrupted', 'resume_requested', 'stop_requested',
]);
const LIVE_ITEM_STATUSES = Object.freeze([
  'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'running',
]);
const QUEUED_ITEM_STATUSES = Object.freeze(['pending', 'retryable']);
const STOP_FENCE_EXEMPT_TASK_STATUSES = Object.freeze([
  'canceled', 'completed', 'completed_with_warnings', 'skipped',
]);
const STOP_FENCE_EXEMPT_ITEM_STATUSES = Object.freeze([
  'completed', 'completed_with_warnings', 'skipped', 'canceled',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SQL_ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/u;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sqlList(values) {
  return values.map(value => `'${value}'`).join(', ');
}

export function normalizeOperatorCloseTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATOR_CLOSE_MAX_BULK) return null;
  if (value.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id))) return null;
  return [...new Set(value.map(id => id.toLowerCase()))].sort();
}

function sameInteger(recorded, current) {
  // A caller that did not select the column cannot contradict the marker.
  if (current === undefined) return true;
  const left = Number(recorded);
  return Number.isInteger(left) && left === Number(current ?? 0);
}

/**
 * True while the row is still in the state the operator closed it in: the
 * marker exists, the row is terminal-failed, and neither a new execution
 * (attempt_number) nor a re-dispatch of the batch (orchestration_revision,
 * bumped by 「重试失败关键词」 and promoted retries) happened since. A row a
 * late device report reopened, or one an operator retried, keeps the marker
 * only as audit and is no longer "closed".
 */
export function operatorClosedTask(row) {
  const marker = object(object(row).metadata).operatorClose;
  if (!text(object(marker).closedAt)) return false;
  if (!OPERATOR_CLOSED_TASK_STATUSES.includes(text(row.status, 80))) return false;
  return sameInteger(marker.attemptNumber, row.attempt_number) &&
    sameInteger(marker.orchestrationRevision, row.orchestration_revision);
}

/**
 * A work item 「结束并移到历史」 failed on purpose and nobody re-dispatched
 * since (a re-dispatch resets error or changes status). The operator said
 * "do not re-capture": only an explicit operator retry may run it again,
 * never an automatic cross-device scan, even after a partial 「重试失败关键词」
 * on the same batch cleared the root's dismissal.
 */
export function operatorClosedWorkItem(item) {
  const row = object(item);
  return text(row.status, 80) === 'failed' && object(row.error).operatorClosed === true;
}

/** SQL twin of operatorClosedTask for a capture_tasks alias (constant cost). */
export function operatorClosedTaskSql(alias = 'task') {
  if (!SQL_ALIAS_PATTERN.test(alias)) throw new Error('invalid_task_alias');
  return `(NULLIF(${alias}.metadata->'operatorClose'->>'closedAt', '') IS NOT NULL
      AND ${alias}.status IN (${sqlList(OPERATOR_CLOSED_TASK_STATUSES)})
      AND ${alias}.metadata->'operatorClose'->>'attemptNumber' = ${alias}.attempt_number::text
      AND ${alias}.metadata->'operatorClose'->>'orchestrationRevision' = ${alias}.orchestration_revision::text)`;
}

/**
 * Work item transition. needs_action -> failed. A stopped standalone phone
 * run (root needs_action, item owned by the run itself) never claims its
 * pending/retryable items again without an operator resume, so closing it
 * cancels them like the phone's own stop does for unheld items.
 */
export function operatorCloseItemTransition(item = {}, {rootId = '', standaloneMobileRun = false} = {}) {
  const status = text(item.status, 80);
  if (status === 'needs_action') return 'failed';
  if (
    standaloneMobileRun &&
    QUEUED_ITEM_STATUSES.includes(status) &&
    String(item.task_id) === String(rootId) &&
    String(item.execution_task_id) === String(rootId)
  ) {
    return 'canceled';
  }
  return null;
}

export function operatorCloseAttemptTransition(status) {
  return ['needs_action', 'interrupted'].includes(text(status, 80)) ? 'failed' : null;
}

export function operatorCloseChildTransition(status) {
  return text(status, 80) === 'needs_action' ? 'failed' : null;
}

// The subtree of each requested root. The per-task facts are read from the
// same row the recursion already fetched (root by primary key, children by
// idx_capture_tasks_parent_created), so no second pass over capture_tasks.
// standalone_mobile marks a stopped phone run whose own queued words it never
// claims again (see live_item).
function treeNodeColumns(alias, {root}) {
  return `UPPER(COALESCE(${alias}.error->>'code', '')) = '${STOP_FENCE_CODE}'
      AND ${alias}.status NOT IN (${sqlList(STOP_FENCE_EXEMPT_TASK_STATUSES)})
      AND NULLIF(${alias}.metadata->>'recoveryTaskId', '') IS NULL AS task_stop_fence,
    COALESCE(
      ${alias}.metadata->>'stopPending' = 'true'
      OR ${alias}.metadata->>'legacyPackStopPending' = 'true'
      OR ${alias}.metadata->>'stopIdentityUnavailable' = 'true',
      false
    ) AS stop_pending,
    ${root ? 'false' : `${alias}.status IN (${sqlList(LIVE_CHILD_STATUSES)})`} AS live_child`;
}
const TREE_SQL = `WITH RECURSIVE task_tree AS (
  SELECT root.id AS root_id, root.id,
    COALESCE(root.metadata->>'workflow', '') = '${STANDALONE_MOBILE_WORKFLOW}' AS standalone_mobile,
    ${treeNodeColumns('root', {root: true})}
  FROM capture_tasks root
  WHERE root.tenant_id = $1 AND root.id = ANY($2::uuid[])
  UNION
  SELECT tree.root_id, child.id, tree.standalone_mobile,
    ${treeNodeColumns('child', {root: false})}
  FROM capture_tasks child
  JOIN task_tree tree ON child.parent_task_id = tree.id
  WHERE child.tenant_id = $1
)`;

/**
 * Map<rootId, {eligible, reason}> for the given ids of this tenant (unknown
 * or foreign ids are absent). One statement, no locks, no fence SQL: the
 * overview calls it for the page's attention roots, the close action calls
 * it again under the row locks.
 *
 * The recursion reads each task once; items, commands and demands are
 * LATERAL probes keyed by the node id (items by task_id, live commands by
 * the partial pending/acknowledged index, demands by primary key prefix).
 * The recursive CTE's row estimate is far too high, so plain joins would
 * hash the whole tenant's tasks and items instead of probing ~100 nodes.
 */
export async function loadOperatorCloseEligibility(tx, tenantId, rootIds = []) {
  const ids = [...new Set((Array.isArray(rootIds) ? rootIds : [])
    .map(id => text(id, 100).toLowerCase())
    .filter(id => UUID_PATTERN.test(id)))];
  const result = new Map();
  if (ids.length === 0 || !text(tenantId, 100)) return result;
  const rows = await tx.queryAll(`${TREE_SQL}, node_flags AS (
      SELECT tree.root_id, tree.task_stop_fence, tree.stop_pending, tree.live_child, items.*, links.*
      FROM task_tree tree
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(BOOL_OR(
            UPPER(COALESCE(item.error->>'code', '')) = '${STOP_FENCE_CODE}'
            AND item.status NOT IN (${sqlList(STOP_FENCE_EXEMPT_ITEM_STATUSES)})
          ), false) AS item_stop_fence,
          COALESCE(BOOL_OR(item.metadata->>'deviceHeld' = 'true'), false) AS device_held,
          COALESCE(BOOL_OR(
            item.status IN (${sqlList(LIVE_ITEM_STATUSES)})
            OR COALESCE(item.metadata->>'retryPending' = 'true', false)
            OR (
              item.status IN (${sqlList(QUEUED_ITEM_STATUSES)})
              -- COALESCE: a queued item handed back to the pool has no
              -- execution_task_id, and NOT (NULL) would hide it as not live.
              AND NOT COALESCE(
                tree.standalone_mobile
                AND item.task_id = tree.root_id
                AND item.execution_task_id = tree.root_id,
                false
              )
            )
          ), false) AS live_item,
          COALESCE(BOOL_OR(
            item.metadata->>'unattendedNegativePatrol' = 'true'
            AND item.status = 'needs_action'
          ), false) AS negative_patrol_needs_action
        FROM capture_task_items item
        WHERE item.task_id = tree.id AND item.tenant_id = $1
      ) items
      CROSS JOIN LATERAL (
        SELECT
          EXISTS (
            SELECT 1 FROM capture_agent_commands command
            WHERE command.task_id = tree.id AND command.tenant_id = $1
              AND command.status IN ('pending', 'acknowledged')
              AND (command.expires_at IS NULL OR command.expires_at > now())
          ) AS live_command,
          EXISTS (
            SELECT 1 FROM capture_discovery_run_candidates demand
            WHERE demand.tenant_id = $1 AND demand.run_id = tree.id
              AND demand.demand_status = 'active'
          ) AS active_demand
      ) links
    ), root_flags AS (
      SELECT root_id,
        BOOL_OR(task_stop_fence OR item_stop_fence) AS stop_fence,
        BOOL_OR(stop_pending) AS stop_pending,
        BOOL_OR(live_child) AS live_child,
        BOOL_OR(live_command) AS live_command,
        BOOL_OR(device_held) AS device_held,
        BOOL_OR(live_item) AS live_item,
        BOOL_OR(negative_patrol_needs_action) AS negative_patrol_needs_action,
        BOOL_OR(active_demand) AS active_demand
      FROM node_flags
      GROUP BY root_id
    )
    SELECT root.id,
      CASE
        WHEN root.parent_task_id IS NOT NULL THEN 'not_root'
        WHEN root.status = 'interrupted' THEN 'interrupted'
        WHEN root.status <> '${OPERATOR_CLOSE_CLOSEABLE_STATUS}'
          OR COALESCE(root.metadata->>'orchestrationTemplate', 'false') = 'true'
          OR (
            root.task_type = 'capture_orchestration'
            AND root.orchestration_revision = 0
            AND COALESCE(root.metadata->>'draft', 'false') = 'true'
          )
          THEN 'status_not_closeable'
        WHEN COALESCE(flags.stop_fence, false) THEN 'stop_fence'
        WHEN COALESCE(flags.stop_pending, false) THEN 'stop_pending'
        WHEN COALESCE(flags.live_child, false) THEN 'live_child'
        WHEN COALESCE(flags.live_command, false) THEN 'live_command'
        WHEN COALESCE(flags.device_held, false) THEN 'device_held'
        WHEN COALESCE(flags.live_item, false) THEN 'live_item'
        WHEN COALESCE(flags.negative_patrol_needs_action, false)
          THEN 'negative_patrol_needs_action'
        WHEN COALESCE(flags.active_demand, false) THEN 'active_discovery_demand'
        ELSE ''
      END AS reason
    FROM capture_tasks root
    LEFT JOIN root_flags flags ON flags.root_id = root.id
    WHERE root.tenant_id = $1 AND root.id = ANY($2::uuid[])
  `, [tenantId, ids]);
  for (const row of rows) {
    const reason = text(row.reason, 80);
    result.set(String(row.id).toLowerCase(), {eligible: reason === '', reason});
  }
  return result;
}

async function readTreeIds(tx, tenantId, rootId) {
  const rows = await tx.queryAll(`${TREE_SQL}
    SELECT id FROM task_tree ORDER BY id
  `, [tenantId, [rootId]]);
  return rows.map(row => String(row.id).toLowerCase());
}

function operatorCloseMarkerSql(alias, parameters) {
  // $closedBy, $closedByUserId, $rootTaskId, $mode are bound by the caller.
  const {closedBy, closedByUserId, rootTaskId, mode} = parameters;
  return `jsonb_build_object(
      'closedAt', now(),
      'closedBy', ${closedBy}::text,
      'closedByUserId', ${closedByUserId}::text,
      'originalStatus', ${alias}.status,
      'originalError', ${alias}.error,
      'originalMessage', ${alias}.message,
      'attemptNumber', ${alias}.attempt_number,
      'orchestrationRevision', ${alias}.orchestration_revision,
      'rootTaskId', ${rootTaskId}::text,
      'mode', ${mode}::text
    )`;
}

export class OperatorCloseNotTerminalError extends Error {
  constructor(status) {
    super('operator_close_parent_not_terminal');
    this.code = 'OPERATOR_CLOSE_NOT_TERMINAL';
    this.parentStatus = status;
  }
}

/**
 * Close one root inside the caller's transaction. Lock order matches the
 * heartbeat projection: descendants by id -> root -> subtree items by id ->
 * their attempts. Returns {task, idempotent, ...counts} or {error, reason}.
 *
 * S4 (docs/hotfix/20260927-unattended-self-heal.md) runs the same routine
 * with mode 'automatic' and actor {type: 'system'}: the same marker, guards,
 * events and audit, written as the system. `verify(tx, {root, items})` runs
 * after every lock and F3's own re-check and may refuse with a reason (the
 * automatic conditions, judged again on the locked rows). `dismissAttention`
 * false keeps an orchestration root in 需处理 (as completed_with_failures).
 * `eventPayload` adds fields (for example the settled kind) to the event and
 * the audit metadata.
 */
export async function closeOperatorAttentionRoot(tx, {
  tenantId,
  rootId,
  actor = {},
  mode = 'single',
  refreshOrchestrationParent,
  verify = null,
  dismissAttention = true,
  eventPayload = {},
} = {}) {
  const scopedRootId = text(rootId, 100).toLowerCase();
  if (!UUID_PATTERN.test(scopedRootId)) return {error: 'task_not_found'};
  const closeMode = OPERATOR_CLOSE_MODES.includes(mode) ? mode : 'single';
  const automatic = closeMode === 'automatic';
  const actorType = automatic || actor.type === 'system' ? 'system' : 'user';
  const actorName = text(actor.name, 240) || (actorType === 'system' ? OPERATOR_CLOSE_AUTOMATIC_ACTOR_NAME : '');
  const actorUserId = actorType === 'system' ? '' : text(actor.userId, 100);
  const extraPayload = object(eventPayload);

  const treeIds = await readTreeIds(tx, tenantId, scopedRootId);
  if (treeIds.length === 0) return {error: 'task_not_found'};
  const childIds = treeIds.filter(id => id !== scopedRootId);
  if (childIds.length > 0) {
    await tx.queryAll(`
      SELECT id FROM capture_tasks
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE
    `, [tenantId, childIds]);
  }
  const root = await tx.queryOne(`
    SELECT * FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
    FOR UPDATE
  `, [tenantId, scopedRootId]);
  if (!root) return {error: 'task_not_found'};
  if (root.parent_task_id) return {error: 'task_not_root'};
  if (operatorClosedTask(root)) return {task: root, idempotent: true};
  // A descendant created between the unlocked read and the root lock would be
  // locked out of order; let the operator retry instead.
  const lockedTreeIds = await readTreeIds(tx, tenantId, scopedRootId);
  if (lockedTreeIds.join(',') !== treeIds.join(',')) return {error: 'task_busy'};
  const items = await tx.queryAll(`
    SELECT id, task_id, execution_task_id, status
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = ANY($2::uuid[])
    ORDER BY id
    FOR UPDATE
  `, [tenantId, treeIds]);

  const eligibility = (await loadOperatorCloseEligibility(tx, tenantId, [scopedRootId]))
    .get(scopedRootId);
  if (!eligibility?.eligible) {
    return {error: 'task_not_closeable', reason: eligibility?.reason || 'status_not_closeable'};
  }
  if (typeof verify === 'function') {
    const refused = text(await verify(tx, {root, items, treeIds}), 80);
    if (refused) return {error: 'task_not_closeable', reason: refused};
  }

  const standaloneMobileRun = object(root.metadata).workflow === STANDALONE_MOBILE_WORKFLOW;
  const failedItemIds = [];
  const canceledItemIds = [];
  for (const item of items) {
    const next = operatorCloseItemTransition(item, {rootId: scopedRootId, standaloneMobileRun});
    if (next === 'failed') failedItemIds.push(item.id);
    if (next === 'canceled') canceledItemIds.push(item.id);
  }
  const changedItemIds = [...failedItemIds, ...canceledItemIds];
  let failedAttemptCount = 0;
  if (changedItemIds.length > 0) {
    // A new revision (and no phone attemptId/leaseId) makes every late phone
    // completion/renewal/closure STALE_ATTEMPT and keeps a browser local
    // recovery from joining its source attempt row (both key on revision).
    await tx.execute(`
      UPDATE capture_task_items
      SET status = CASE WHEN id = ANY($3::uuid[]) THEN 'failed' ELSE 'canceled' END,
        error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
          'operatorClosed', true,
          'originalStatus', status,
          'operatorClosedAt', now()
        ),
        metadata = COALESCE(metadata, '{}'::jsonb) - 'attemptId' - 'leaseId',
        assignment_revision = assignment_revision + 1,
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    `, [tenantId, changedItemIds, failedItemIds]);
    const attempts = await tx.queryAll(`
      UPDATE capture_task_item_attempts
      SET status = 'failed',
        error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
          'operatorClosed', true,
          'originalStatus', status,
          'operatorClosedAt', now()
        ),
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])
        AND status IN ('needs_action', 'interrupted')
      RETURNING id
    `, [tenantId, changedItemIds]);
    failedAttemptCount = attempts.length;
  }

  const markerParameters = {
    closedBy: '$3', closedByUserId: '$4', rootTaskId: '$5', mode: '$6',
  };
  let closedChildTaskIds = [];
  if (childIds.length > 0) {
    const closedChildren = await tx.queryAll(`
      UPDATE capture_tasks
      SET status = 'failed',
        message = $7,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'operatorClose', ${operatorCloseMarkerSql('capture_tasks', markerParameters)}
        ),
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'needs_action'
      RETURNING id
    `, [tenantId, childIds, actorName, actorUserId, scopedRootId, closeMode,
      automatic ? OPERATOR_CLOSE_AUTOMATIC_CHILD_MESSAGE : OPERATOR_CLOSE_CHILD_MESSAGE]);
    closedChildTaskIds = closedChildren.map(row => row.id).sort();
  }

  let closedRoot;
  if (root.task_type === 'capture_orchestration') {
    if (typeof refreshOrchestrationParent !== 'function') {
      throw new TypeError('orchestration_parent_projector_required');
    }
    // The batch status always comes from its items: every unfinished item is
    // terminal now, so the aggregate is completed_with_failures (and the
    // schedule's last_run_status follows through the same projection).
    await refreshOrchestrationParent(tx, {
      tenantId,
      parentTaskId: scopedRootId,
      parent: root,
      actorType,
      actorId: actorUserId,
      actorName,
    });
    const refreshed = await tx.queryOne(`
      SELECT status FROM capture_tasks WHERE tenant_id = $1 AND id = $2
    `, [tenantId, scopedRootId]);
    if (!['completed', 'completed_with_warnings', 'completed_with_failures', 'failed', 'canceled', 'skipped']
      .includes(text(refreshed?.status, 80))) {
      throw new OperatorCloseNotTerminalError(refreshed?.status);
    }
    closedRoot = await tx.queryOne(`
      UPDATE capture_tasks
      SET message = $7,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'operatorClose', ${operatorCloseMarkerSql('capture_tasks', markerParameters)}
            || jsonb_build_object(
              'originalStatus', $8::text,
              'originalError', $9::jsonb,
              'originalMessage', $10::text
            )
        ),
        -- S4 keeps an automatically settled batch in 需处理 when asked to
        -- (completed_with_failures, like a browser batch with failures).
        attention_dismissed_at = CASE WHEN $11::boolean THEN now() ELSE attention_dismissed_at END,
        attention_dismissed_by_user_id = CASE WHEN $11::boolean THEN NULLIF($4, '')::uuid
          ELSE attention_dismissed_by_user_id END,
        attention_dismissed_by_name = CASE WHEN $11::boolean THEN $3 ELSE attention_dismissed_by_name END,
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `, [
      tenantId, scopedRootId, actorName, actorUserId, scopedRootId, closeMode,
      automatic ? OPERATOR_CLOSE_AUTOMATIC_ORCHESTRATION_MESSAGE : OPERATOR_CLOSE_ORCHESTRATION_MESSAGE,
      root.status, JSON.stringify(object(root.error)), text(root.message, 4000),
      dismissAttention !== false,
    ]);
  } else {
    closedRoot = await tx.queryOne(`
      UPDATE capture_tasks
      SET status = 'failed',
        message = $7,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'operatorClose', ${operatorCloseMarkerSql('capture_tasks', markerParameters)}
        ),
        finished_at = COALESCE(finished_at, now()),
        attention_dismissed_at = now(),
        attention_dismissed_by_user_id = NULLIF($4, '')::uuid,
        attention_dismissed_by_name = $3,
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = '${OPERATOR_CLOSE_CLOSEABLE_STATUS}'
      RETURNING *
    `, [tenantId, scopedRootId, actorName, actorUserId, scopedRootId, closeMode,
      automatic ? OPERATOR_CLOSE_AUTOMATIC_ROOT_MESSAGE : OPERATOR_CLOSE_ROOT_MESSAGE]);
  }
  if (!closedRoot) throw new OperatorCloseNotTerminalError(root.status);

  const counts = {
    closedChildTaskIds,
    failedItemCount: failedItemIds.length,
    canceledItemCount: canceledItemIds.length,
    failedAttemptCount,
  };
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, event_type, actor_type, actor_id, actor_name,
      status, message, payload
    ) VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8::jsonb)
  `, [
    tenantId, scopedRootId, OPERATOR_CLOSE_EVENT, actorUserId, actorName,
    closedRoot.status, automatic ? OPERATOR_CLOSE_AUTOMATIC_EVENT_MESSAGE : OPERATOR_CLOSE_EVENT_MESSAGE,
    JSON.stringify({...extraPayload, originalStatus: root.status, mode: closeMode, ...counts}),
    actorType,
  ]);
  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, actor_user_id,
      action, target_type, target_id, metadata
    ) VALUES ($1, $7, $2, NULLIF($3, '')::uuid, $4, 'capture_task', $5, $6::jsonb)
  `, [
    tenantId, actorUserId, actorUserId, OPERATOR_CLOSE_AUDIT_ACTION, scopedRootId,
    JSON.stringify({
      ...extraPayload,
      actorName,
      title: text(root.title, 240),
      taskType: text(root.task_type, 120),
      originalStatus: root.status,
      mode: closeMode,
      ...counts,
    }),
    actorType,
  ]);
  return {task: closedRoot, idempotent: false, originalStatus: root.status, ...counts};
}
