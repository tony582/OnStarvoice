import {authorizePrincipal} from '../capture-discovery/lineage.js';
import {lockCaptureAgentExecutionSlot} from '../capture-cloud.js';
import {fail, WORKFLOW} from './validation.js';
export function createAndroidControlRepository({database} = {}) {
  return {async transaction(callback) {
    const db = database || await import('../../db/query.js');
    return db.withTransaction(callback, {category:'critical', statementTimeoutMs:3000,lockTimeoutMs:1000,idleInTransactionTimeoutMs:5000});
  }};
}
export async function lockAgent(tx, tenantId, agentId, principal) {
  await lockCaptureAgentExecutionSlot(tx, tenantId, agentId);
  if (principal) await authorizePrincipal(tx, principal);
  const agent = await tx.queryOne(`SELECT * FROM capture_agents WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tenantId,agentId]);
  if (!agent || agent.status !== 'active' || agent.capabilities?.agentKind !== 'android_mobile') fail('MOBILE_AGENT_NOT_FOUND',404);
  return agent;
}
export async function taskRow(tx, tenantId, taskId) {
  // The run is the child (execution) task: standalone runs use
  // execution_task_id = task_id, orchestration children carry the mobile
  // workflow on the child while the item lives on the orchestration parent.
  const task = await tx.queryOne(`SELECT * FROM capture_tasks WHERE tenant_id=$1 AND id=$2
    AND metadata->>'workflow'=$3 FOR UPDATE`,[tenantId,taskId,WORKFLOW]);
  if (!task) fail('MOBILE_RUN_NOT_FOUND',404);
  return task;
}
// Stop flags that must fence a phone: the child's own stop, and (for
// orchestration children) any parent stop signal. Kept in one place so poll,
// renew and control agree.
export function parentStopRequested(parentMetadata = {}) {
  return parentMetadata
    && (parentMetadata.stopRequested === true
      || parentMetadata.operatorStopped === true
      || parentMetadata.stopPending === true
      || parentMetadata.stopPending === 'true'
      || (typeof parentMetadata.stopCommandId === 'string' && parentMetadata.stopCommandId !== ''));
}
export async function heldItem(tx, tenantId, agentId) {
  return tx.queryOne(`SELECT item.*, child.metadata AS task_metadata,
      parent.metadata AS parent_metadata, parent.task_type AS parent_task_type
    FROM capture_task_items item
    JOIN capture_tasks child ON child.id=item.execution_task_id AND child.tenant_id=item.tenant_id
      AND child.metadata->>'workflow'=$3
    LEFT JOIN capture_tasks parent ON parent.id=item.task_id AND parent.tenant_id=item.tenant_id
      AND parent.id<>item.execution_task_id
    WHERE item.tenant_id=$1 AND item.assigned_agent_id=$2
      AND item.metadata->>'deviceHeld'='true' ORDER BY item.created_at LIMIT 1 FOR UPDATE OF item`,[tenantId,agentId,WORKFLOW]);
}
export async function saveItemMetadata(tx, item, metadata, status = item.status) {
  await tx.execute(`UPDATE capture_task_items SET metadata=$2,status=$3,updated_at=now() WHERE id=$1`,[item.id,metadata,status]);
}
export async function rollup(tx, tenantId, taskId) {
  // Aggregate the items the child (execution task) currently owns. Standalone
  // runs own their own items directly; orchestration children own the item(s)
  // bound to them by execution_task_id while the item row stays on the parent.
  const task = await taskRow(tx,tenantId,taskId);
  const rows = await tx.queryAll(`SELECT status,metadata FROM capture_task_items
    WHERE tenant_id=$1 AND execution_task_id=$2 ORDER BY ordinal`,[tenantId,taskId]);
  const elastic = task.metadata?.distributionMode === 'elastic_pool';
  const stopRequested = task.metadata.stopRequested === true;
  const held = rows.some(r => r.metadata?.deviceHeld);
  const blocked = rows.some(r => ['needs_action', 'failed'].includes(r.status));
  const retryable = rows.some(r => r.status === 'retryable');
  const pendingFresh = rows.some(r => ['pending', 'waiting_device'].includes(r.status));
  const unfinished = rows.some(r => !['completed','completed_with_warnings','canceled','skipped'].includes(r.status));
  let status;
  if (rows.length === 0) status = 'superseded';
  else if (held) status = stopRequested || blocked ? 'interrupted' : 'running';
  else if (stopRequested) status = 'canceled';
  else if (elastic) {
    // An elastic child is single-attempt: a retryable item settles the child as
    // 'interrupted' so the item is freed for a fresh claim by any eligible node.
    status = blocked ? 'needs_action' : retryable ? 'interrupted'
      : pendingFresh ? 'pending' : unfinished ? 'needs_action' : 'completed';
  } else {
    // Fixed-batch/standalone children keep a retryable item pending so the same
    // assigned phone re-claims it in place within the same child.
    status = blocked ? 'needs_action' : (pendingFresh || retryable) ? 'pending'
      : unfinished ? 'needs_action' : 'completed';
  }
  await tx.execute(`UPDATE capture_tasks SET status=$2,updated_at=now(),finished_at=CASE
    WHEN $2 IN ('completed','canceled','superseded') THEN now() ELSE NULL END WHERE id=$1`,[task.id,status]);
  return status;
}
