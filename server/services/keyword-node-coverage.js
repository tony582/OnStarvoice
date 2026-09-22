import {queryAll, withTransaction} from '../db/query.js';
import {aggregateParentTaskItems} from './capture-orchestration.js';
import {captureAgentLivenessOnline} from './capture-cloud.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACTIVE = new Set(['pending', 'claimed', 'running', 'recovering', 'waiting_device', 'interrupted', 'resume_requested']);
const FINISHED = new Set(['completed', 'completed_with_warnings', 'completed_with_failures', 'failed', 'skipped', 'canceled', 'superseded']);
const SETTLED_ITEMS = new Set(['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled']);
const RESPONSE_MS = 3 * 60 * 1000;
const PROGRESS_MS = 10 * 60 * 1000;
const object = value => value && typeof value === 'object' ? value : {};
const timestamp = value => Date.parse(String(value || '')) || 0;

export const KEYWORD_COVERAGE_SKIP_MESSAGES = Object.freeze({
  keyword_node_offline: '节点离线，本轮未覆盖；其他节点继续采集',
  keyword_node_unavailable: '节点不可用，本轮未覆盖；其他节点继续采集',
  keyword_node_no_response: '节点未及时响应采集任务，本轮未覆盖',
  keyword_node_no_progress: '节点持续没有采集进展，本轮未覆盖',
  keyword_node_failed: '该节点采集失败，本轮未覆盖，不再重复尝试',
  keyword_node_missing_result: '该节点已结束任务但未确认关键词结果，本轮未覆盖',
});

function coverageParent(parent) {
  const metadata = object(parent?.metadata);
  return parent?.task_type === 'capture_orchestration' &&
    ['pending', 'running', 'needs_action'].includes(parent.status) &&
    metadata.distributionMode === 'elastic_pool' &&
    metadata.draft !== true &&
    metadata.orchestrationTemplate !== true && metadata.operatorStopped !== true &&
    metadata.stopPending !== true &&
    (metadata.keywordCoverage === 'each_agent' || object(metadata.planSnapshot).keywordCoverage === 'each_agent');
}

function stalledExecution(child, now) {
  if (!child || !ACTIVE.has(child.status)) return '';
  const created = timestamp(child.created_at);
  const started = timestamp(child.started_at);
  const heartbeat = timestamp(child.heartbeat_at);
  // updated_at can move on empty heartbeats; it is not evidence of progress.
  if (now - Math.max(created, started, heartbeat) >= RESPONSE_MS) return 'keyword_node_no_response';
  const progressed = Math.max(created, started, timestamp(child.business_progress_at));
  const progress = object(child.progress);
  const phase = String(progress.phase || '').toLowerCase();
  const commentStage = phase === 'detail_comments_capturing' || phase.startsWith('comments_') ||
    String(progress.captureAction || '').toLowerCase() === 'capturecomments';
  // Comment detail requests can legitimately take ten minutes. Match the
  // Extension's existing twelve-minute allowance for that explicit stage.
  if (now - progressed >= (commentStage ? 12 * 60 * 1000 : PROGRESS_MS)) return 'keyword_node_no_progress';
  return '';
}

/** A pinned search is best effort, never a requirement to wait for a broken node. */
export function keywordCoverageSkipReason({parent, item, agent, child, nodeTasks = []}, now = Date.now()) {
  if (!coverageParent(parent) || item?.item_type !== 'keyword' ||
      !UUID.test(String(object(item.metadata).pinnedAgentId || '')) || SETTLED_ITEMS.has(item.status)) return '';
  if (!agent || agent.status !== 'active') return 'keyword_node_unavailable';
  if (!captureAgentLivenessOnline(agent, now)) return 'keyword_node_offline';
  if (['retryable', 'needs_action'].includes(item.status) ||
      ['failed', 'needs_action', 'interrupted', 'completed_with_failures'].includes(child?.status)) return 'keyword_node_failed';
  if (child) {
    if (FINISHED.has(child.status)) return 'keyword_node_missing_result';
    return stalledExecution(child, now);
  }
  // The node may be working through its other keywords. Healthy ongoing work
  // protects the remaining queue even when an individual word takes a while.
  const active = nodeTasks.filter(task => ACTIVE.has(task.status));
  const stalled = active.map(task => stalledExecution(task, now)).find(Boolean);
  if (stalled) return stalled;
  if (active.length > 0) return '';
  const lastFinished = Math.max(0, ...nodeTasks.map(task => timestamp(task.finished_at)));
  const anchor = Math.max(timestamp(parent.started_at), timestamp(parent.created_at),
    timestamp(object(parent.metadata).publishedAt), lastFinished);
  return now - anchor >= RESPONSE_MS ? 'keyword_node_no_response' : '';
}

/** Lock child -> parent -> items, matching snapshot ingestion. Never wait on a live writer. */
export async function settleKeywordNodeCoverage(tx, {tenantId, parentTaskId}) {
  const children = await tx.queryAll(`SELECT * FROM capture_tasks
    WHERE tenant_id=$1 AND parent_task_id=$2 ORDER BY id FOR UPDATE SKIP LOCKED`, [tenantId, parentTaskId]);
  const parent = await tx.queryOne(`SELECT *, clock_timestamp() AS coverage_now FROM capture_tasks
    WHERE tenant_id=$1 AND id=$2 FOR UPDATE SKIP LOCKED`, [tenantId, parentTaskId]);
  if (!coverageParent(parent)) return {skipped: 0};
  const items = await tx.queryAll(`SELECT * FROM capture_task_items
    WHERE tenant_id=$1 AND task_id=$2 ORDER BY id FOR UPDATE`, [tenantId, parentTaskId]);
  const childrenById = new Map(children.map(child => [child.id, child]));
  // A claim/snapshot won the race. Retry this parent on a later maintenance tick.
  if (items.some(item => !SETTLED_ITEMS.has(item.status) && item.execution_task_id && !childrenById.has(item.execution_task_id))) return {skipped: 0};
  const pinned = items.filter(item => item.item_type === 'keyword' && UUID.test(String(object(item.metadata).pinnedAgentId || '')));
  const agentIds = [...new Set(pinned.map(item => item.metadata.pinnedAgentId))];
  if (agentIds.length === 0) return {skipped: 0};
  const agents = await tx.queryAll(`SELECT * FROM capture_agents WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [tenantId, agentIds]);
  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  const now = timestamp(parent.coverage_now);
  let skipped = 0;
  for (const item of pinned) {
    const agentId = item.metadata.pinnedAgentId;
    const child = childrenById.get(item.execution_task_id);
    const reason = keywordCoverageSkipReason({parent, item, child, agent: agentsById.get(agentId),
      nodeTasks: children.filter(task => task.assigned_agent_id === agentId)}, now);
    if (!reason) continue;
    const message = KEYWORD_COVERAGE_SKIP_MESSAGES[reason];
    const error = {code: reason, message, retryable: false, originalError: item.error};
    const serialized = JSON.stringify(error);
    if (child && !FINISHED.has(child.status)) {
      // Superseded tasks reject late snapshots. The assignment revision also
      // fences result ingestion; terminal notices tell a returning runner to stop.
      await tx.execute(`UPDATE capture_tasks SET status='superseded', error=$3::jsonb,
        message=$4, finished_at=now(), updated_at=now(),
        metadata=metadata || jsonb_build_object('terminalDisposition','revoked',
          'terminalReason',$5::text,'terminalDispositionAt',now()::text)
        WHERE tenant_id=$1 AND id=$2`, [tenantId, child.id, serialized, message, reason]);
    }
    if (child) {
      await tx.execute(`UPDATE capture_agent_commands SET status='expired', finished_at=now(), updated_at=now(),
        result=jsonb_build_object('reason',$3::text)
        WHERE tenant_id=$1 AND task_id=$2 AND status IN ('pending','acknowledged')`, [tenantId, child.id, reason]);
      await tx.execute(`UPDATE capture_task_item_attempts SET status='skipped',
        error=error || $4::jsonb, finished_at=COALESCE(finished_at,now()), updated_at=now()
        WHERE tenant_id=$1 AND item_id=$2 AND execution_task_id=$3 AND assignment_revision=$5
          AND status NOT IN ('completed','completed_with_warnings','failed','skipped','canceled')`,
      [tenantId, item.id, child.id, serialized, item.assignment_revision]);
    }
    await tx.execute(`UPDATE capture_task_items SET status='skipped', error=$3::jsonb,
      assignment_revision=assignment_revision+1, finished_at=now(), updated_at=now(),
      metadata=(metadata-'recovery') || jsonb_build_object('skipReason',$4::text,
        'keywordCoverageSkip',true,'retryPending',false,'automaticRetrySuppressed',true)
      WHERE tenant_id=$1 AND id=$2`, [tenantId, item.id, serialized, reason]);
    await tx.execute(`INSERT INTO capture_task_events (tenant_id,task_id,agent_id,event_type,
      actor_type,actor_name,status,message,payload)
      VALUES ($1,$2,$3,'keyword_node_coverage_skipped','system','云端调度器','skipped',$4,$5::jsonb)`,
    [tenantId, parentTaskId, agentsById.has(agentId) ? agentId : null, message, JSON.stringify({itemId: item.id, keyword: item.keyword, agentId,
      executionTaskId: child?.id || null, reason, previousStatus: item.status, previousError: item.error})]);
    item.status = 'skipped';
    skipped += 1;
  }
  if (skipped > 0) {
    const aggregate = aggregateParentTaskItems(items);
    if (aggregate.status === 'needs_action' && aggregate.counts.retryable > 0 && aggregate.counts.needsAction === 0) aggregate.status = 'running';
    await tx.execute(`UPDATE capture_tasks SET status=$3, counts=$4::jsonb, progress=$5::jsonb,
      finished_at=CASE WHEN $6 THEN now() ELSE NULL END, updated_at=now(),
      message=$7 WHERE tenant_id=$1 AND id=$2`, [tenantId, parentTaskId, aggregate.status,
    JSON.stringify(aggregate.counts), JSON.stringify(aggregate.progress), aggregate.terminal,
    aggregate.terminal ? '本轮已结束，部分节点未覆盖；已采集结果保留' : '不可用节点的本轮采集已跳过，其他节点继续执行']);
  }
  return {skipped};
}

export async function settleScheduleKeywordNodeCoverage(tx, {tenantId, scheduleId}) {
  const parents = await tx.queryAll(`SELECT id FROM capture_tasks
    WHERE tenant_id=$1 AND orchestration_schedule_id=$2
      AND task_type='capture_orchestration' AND status IN ('pending','running','needs_action')
      AND metadata->>'orchestrationTemplate' IS DISTINCT FROM 'true'
      AND metadata->>'draft' IS DISTINCT FROM 'true'
      AND metadata->>'distributionMode'='elastic_pool'
      AND (metadata->>'keywordCoverage'='each_agent' OR metadata #>> '{planSnapshot,keywordCoverage}'='each_agent')
    ORDER BY created_at,id LIMIT 50`, [tenantId, scheduleId]);
  for (const parent of parents) await settleKeywordNodeCoverage(tx, {tenantId, parentTaskId: parent.id});
}

export async function reconcileKeywordNodeCoverage({limit = 20, tenantId = '', parentTaskIds = []} = {}) {
  if ((tenantId && !UUID.test(tenantId)) || !Array.isArray(parentTaskIds) || parentTaskIds.length > 50 ||
      parentTaskIds.some(id => !UUID.test(String(id))) || (parentTaskIds.length && !tenantId)) throw new Error('Invalid keyword coverage maintenance scope');
  const parents = await queryAll(`SELECT parent.id,parent.tenant_id FROM capture_tasks parent
    WHERE parent.task_type='capture_orchestration' AND parent.status IN ('pending','running','needs_action')
      AND parent.metadata->>'orchestrationTemplate' IS DISTINCT FROM 'true'
      AND parent.metadata->>'draft' IS DISTINCT FROM 'true'
      AND parent.metadata->>'distributionMode'='elastic_pool'
      AND (parent.metadata->>'keywordCoverage'='each_agent' OR parent.metadata #>> '{planSnapshot,keywordCoverage}'='each_agent')
      AND ($1::uuid IS NULL OR parent.tenant_id=$1)
      AND (cardinality($2::uuid[])=0 OR parent.id=ANY($2::uuid[]))
      AND EXISTS (SELECT 1 FROM capture_task_items item WHERE item.tenant_id=parent.tenant_id AND item.task_id=parent.id
        AND item.item_type='keyword' AND item.metadata ? 'pinnedAgentId'
        AND item.status NOT IN ('completed','completed_with_warnings','failed','skipped','canceled'))
    ORDER BY parent.updated_at,parent.id LIMIT $3`, [tenantId || null, parentTaskIds, Math.min(50, Math.max(1, Number(limit) || 20))]);
  let skipped = 0;
  for (const parent of parents) {
    const result = await withTransaction(tx => settleKeywordNodeCoverage(tx, {tenantId: parent.tenant_id, parentTaskId: parent.id}));
    skipped += result.skipped;
  }
  return {scanned: parents.length, skipped};
}
