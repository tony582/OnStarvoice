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
  const task = await tx.queryOne(`SELECT * FROM capture_tasks WHERE tenant_id=$1 AND id=$2
    AND metadata->>'workflow'=$3 FOR UPDATE`,[tenantId,taskId,WORKFLOW]);
  if (!task) fail('MOBILE_RUN_NOT_FOUND',404);
  return task;
}
export async function heldItem(tx, tenantId, agentId) {
  return tx.queryOne(`SELECT item.*, task.metadata AS task_metadata FROM capture_task_items item
    JOIN capture_tasks task ON task.id=item.task_id AND task.tenant_id=item.tenant_id
    WHERE item.tenant_id=$1 AND item.assigned_agent_id=$2 AND task.metadata->>'workflow'=$3
      AND item.metadata->>'deviceHeld'='true' ORDER BY item.created_at LIMIT 1 FOR UPDATE OF item`,[tenantId,agentId,WORKFLOW]);
}
export async function saveItemMetadata(tx, item, metadata, status = item.status) {
  await tx.execute(`UPDATE capture_task_items SET metadata=$2,status=$3,updated_at=now() WHERE id=$1`,[item.id,metadata,status]);
}
export async function rollup(tx, tenantId, taskId) {
  const task = await taskRow(tx,tenantId,taskId);
  const rows = await tx.queryAll('SELECT status,metadata FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal',[taskId]);
  const held = rows.some(r => r.metadata?.deviceHeld);
  const pending = rows.some(r => ['pending','retryable','waiting_device'].includes(r.status));
  const unfinished = rows.some(r => !['completed','completed_with_warnings','canceled','skipped'].includes(r.status));
  const blocked = rows.some(r => ['needs_action', 'failed'].includes(r.status));
  const status = held ? task.metadata.stopRequested || blocked ? 'interrupted' : 'running'
    : task.metadata.stopRequested ? 'canceled' : blocked ? 'needs_action' : pending ? 'pending' : unfinished ? 'needs_action' : 'completed';
  await tx.execute(`UPDATE capture_tasks SET status=$2,updated_at=now(),finished_at=CASE
    WHEN $2 IN ('completed','canceled') THEN now() ELSE NULL END WHERE id=$1`,[task.id,status]);
  return status;
}
