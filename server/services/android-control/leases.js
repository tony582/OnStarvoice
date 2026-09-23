import {randomUUID} from 'node:crypto';
import {digest,fail,id,identity,json,LEASE_MS,text,WORKFLOW} from './validation.js';
import {heldItem,lockAgent,rollup,saveItemMetadata,taskRow} from './repository.js';
export function taskIdentity(item,attemptId=item.metadata.attemptId) {
  return {discoveryRunId:item.task_id,taskId:item.task_id,itemId:item.id,attemptId,
    assignmentRevision:item.assignment_revision,requestHash:item.request_hash,agentId:item.assigned_agent_id};
}
function taskPayload(item,metadata) {
  return {identity:taskIdentity(item),deviceId:metadata.deviceId,keyword:item.keyword,
    filters:metadata.filters,budgets:metadata.budgets,deadlineAt:metadata.deadlineAt,
    resumeAuthorized:item.metadata.resumeAuthorized===true};
}
function permit(item,metadata,now) {
  return {...taskIdentity(item),leaseId:item.metadata.leaseId,serverTime:new Date(now).toISOString(),
    leaseUntil:new Date(Math.min(now+LEASE_MS,Date.parse(metadata.deadlineAt))).toISOString()};
}
function control(item,metadata,sessionId,now) {
  const reason=metadata.stopRequested?'remote_stop':Date.parse(metadata.deadlineAt)<=now?'deadline_expired'
    :item.metadata.sessionId!==sessionId?'runner_session_changed'
      :Date.parse(item.metadata.leaseUntil)<=now?'lease_expired':item.metadata.completion?'device_closure_required':'';
  return reason ? {stopRequested:true,blocked:true,reason,identity:taskIdentity(item)} : null;
}
export async function poll(tx,principal,body,now=Date.now()) {
  const sessionId=id(body.sessionId,'SESSION_ID');
  const agent=await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  if (text(body.deviceId,'DEVICE_ID',120)!==agent.capabilities.deviceId) fail('DEVICE_ID_MISMATCH',403);
  const ready=body.readyForSearch===true;
  await tx.execute(`UPDATE capture_agents SET last_liveness_at=now(),last_full_heartbeat_at=now(),last_heartbeat_at=now(),
    capabilities=capabilities||$2::jsonb WHERE id=$1 AND (last_liveness_at IS NULL OR last_liveness_at < now()-interval '25 seconds'
    OR capabilities->>'readyForSearch' IS DISTINCT FROM $3)`,[agent.id,{readyForSearch:ready},String(ready)]);
  let item=await heldItem(tx,principal.tenantId,agent.id);
  if (item) {
    const stopped=control(item,item.task_metadata,sessionId,now);
    if (stopped) return {task:null,permit:null,control:stopped};
    return {task:taskPayload(item,item.task_metadata),permit:{...permit(item,item.task_metadata,now),leaseUntil:item.metadata.leaseUntil},control:{}};
  }
  if (!ready) return {task:null,permit:null,control:{reason:'device_not_ready'}};
  const candidate=await tx.queryOne(`SELECT item.id,item.task_id FROM capture_task_items item
    JOIN capture_tasks task ON task.id=item.task_id AND task.tenant_id=item.tenant_id
    WHERE item.tenant_id=$1 AND item.assigned_agent_id=$2 AND task.metadata->>'workflow'=$3
      AND task.metadata->>'stopRequested' IS DISTINCT FROM 'true' AND task.status IN ('pending','running')
      AND item.status IN ('pending','retryable') ORDER BY task.created_at,item.ordinal LIMIT 1`,[principal.tenantId,agent.id,WORKFLOW]);
  if (!candidate) return {task:null,permit:null,control:{}};
  const task=await taskRow(tx,principal.tenantId,candidate.task_id);
  if (!task.metadata.deadlineAt) {
    task.metadata.deadlineAt=new Date(now+task.metadata.budgets.batchMs).toISOString();
    await tx.execute('UPDATE capture_tasks SET metadata=$2,started_at=now() WHERE id=$1',[task.id,task.metadata]);
  }
  if (Date.parse(task.metadata.deadlineAt)<=now) {
    await tx.execute(`UPDATE capture_task_items SET status='needs_action',error='{"code":"deadline_expired"}'::jsonb
      WHERE task_id=$1 AND status IN ('pending','retryable')`,[task.id]);
    await rollup(tx,principal.tenantId,task.id);
    return {task:null,permit:null,control:{reason:'deadline_expired'}};
  }
  item=await tx.queryOne('SELECT * FROM capture_task_items WHERE id=$1 FOR UPDATE',[candidate.id]);
  const attemptId=randomUUID(), revision=item.assignment_revision+1;
  const hash=digest({taskId:task.id,itemId:item.id,keyword:item.keyword,filters:task.metadata.filters,budgets:task.metadata.budgets,revision});
  const metadata={...item.metadata,attemptId,deviceHeld:true,sessionId,leaseId:randomUUID(),completion:null,
    reason:'',closure:null,deviceClosedAt:null,
    leaseUntil:new Date(Math.min(now+LEASE_MS,Date.parse(task.metadata.deadlineAt))).toISOString()};
  item=await tx.queryOne(`UPDATE capture_task_items SET assignment_revision=$2,attempt_count=attempt_count+1,
    request_hash=$3,status='running',metadata=$4,error='{}'::jsonb,finished_at=NULL,started_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[item.id,revision,hash,metadata]);
  await tx.execute(`INSERT INTO capture_task_item_attempts(id,tenant_id,item_id,parent_task_id,execution_task_id,agent_id,
    attempt_number,assignment_revision,status,request_hash,checkpoint,started_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7,'running',$8,$9,now())`,
  [attemptId,principal.tenantId,item.id,task.id,agent.id,item.attempt_count,revision,hash,{sessionId,leaseId:metadata.leaseId}]);
  await tx.execute(`UPDATE capture_tasks SET status='running',heartbeat_at=now(),updated_at=now() WHERE id=$1`,[task.id]);
  return {task:taskPayload(item,task.metadata),permit:permit(item,task.metadata,now),control:{}};
}
export async function currentAttempt(tx,principal,input) {
  const ident=identity(input);
  if (ident.agentId!==principal.agentId) fail('AGENT_ID_MISMATCH',403);
  await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  const task=await taskRow(tx,principal.tenantId,ident.taskId);
  const item=await tx.queryOne(`SELECT * FROM capture_task_items WHERE tenant_id=$1 AND task_id=$2 AND id=$3 FOR UPDATE`,[principal.tenantId,task.id,ident.itemId]);
  const attempt=await tx.queryOne(`SELECT * FROM capture_task_item_attempts WHERE tenant_id=$1 AND id=$2 AND item_id=$3
    AND parent_task_id=$4 AND execution_task_id=$4 AND agent_id=$5 AND assignment_revision=$6 AND request_hash=$7 FOR UPDATE`,
  [principal.tenantId,ident.attemptId,ident.itemId,ident.taskId,ident.agentId,ident.assignmentRevision,ident.requestHash]);
  if (!item || !attempt) fail('ATTEMPT_LINEAGE_MISMATCH',403);
  return {ident,task,item,attempt,current:item.metadata.attemptId===attempt.id && item.assignment_revision===ident.assignmentRevision};
}
export async function renew(tx,principal,body,now=Date.now()) {
  const {task,item,current}=await currentAttempt(tx,principal,body.identity);
  if (!current || body.leaseId!==item.metadata.leaseId) fail('STALE_ATTEMPT');
  const stopped=control(item,task.metadata,id(body.sessionId,'SESSION_ID'),now);
  if (stopped || !item.metadata.deviceHeld) return {permit:null,control:stopped || {stopRequested:true,reason:'attempt_closed'}};
  const granted=permit(item,task.metadata,now);
  await saveItemMetadata(tx,item,{...item.metadata,leaseUntil:granted.leaseUntil});
  await tx.execute('UPDATE capture_agents SET last_liveness_at=now() WHERE id=$1',[principal.agentId]);
  return {permit:granted,control:{}};
}
