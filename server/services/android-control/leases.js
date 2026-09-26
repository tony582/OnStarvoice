import {randomUUID} from 'node:crypto';
import {digest,fail,id,identity,LEASE_MS,text,WORKFLOW} from './validation.js';
import {refreshOrchestrationParent} from './parent-refresh.js';
import {heldItem,lockAgent,parentStopRequested,rollup,saveItemMetadata,taskRow} from './repository.js';
import {mobilePlanBlockReason,mobileTaskBudgets,mobileTaskFilters,trimMobilePlanSnapshot} from './mobile-tasks.js';

// A phone attempt budget per work item (mirrors the browser elastic pool's
// bounded attempts). Manual-action safety endings fence the item for this phone.
export const MOBILE_ELASTIC_ATTEMPT_LIMIT = 3;
const MOBILE_SAFETY_ERROR_CODES = [
  'CAPTCHA_REQUIRED', 'LOGIN_REQUIRED', 'ACCOUNT_SECURITY_BLOCK',
  'PLATFORM_SAFETY_BLOCK', 'SECURITY_CHECK', 'SECURITY_BLOCKED',
];
const TERMINAL_EXECUTION_STATUSES = [
  'completed', 'completed_with_warnings', 'completed_with_failures',
  'failed', 'canceled', 'skipped', 'superseded', 'needs_action', 'interrupted',
];

// run id = execution_task_id (the child/standalone task); parent = item.task_id.
export function taskIdentity(item,attemptId=item.metadata.attemptId) {
  const runId=item.execution_task_id;
  return {discoveryRunId:runId,taskId:runId,itemId:item.id,attemptId,
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
function control(item,metadata,parentMetadata,sessionId,now) {
  const reason=metadata.stopRequested||parentStopRequested(parentMetadata)?'remote_stop'
    :Date.parse(metadata.deadlineAt)<=now?'deadline_expired'
      :item.metadata.sessionId!==sessionId?'runner_session_changed'
        :Date.parse(item.metadata.leaseUntil)<=now?'lease_expired':item.metadata.completion?'device_closure_required':'';
  return reason ? {stopRequested:true,blocked:true,reason,identity:taskIdentity(item)} : null;
}
function boundProbe(probe) {
  if (!probe || typeof probe!=='object' || Array.isArray(probe)) return null;
  const fg=probe.foreground && typeof probe.foreground==='object' && !Array.isArray(probe.foreground) ? probe.foreground : {};
  return {foreground:{package:text2(fg.package,120),activity:text2(fg.activity,160),launched:fg.launched===true},
    checkedAt:text2(probe.checkedAt,40)};
}
function text2(value,max) {
  return typeof value==='string' ? value.slice(0,max) : '';
}
async function persistHeartbeat(tx,agent,ready,reason,probe) {
  const merge={readyForSearch:ready};
  if (reason) merge.deviceReason=reason; else merge.deviceReason='';
  const bounded=boundProbe(probe);
  if (bounded) {merge.deviceProbe=bounded; merge.deviceProbeAt=bounded.checkedAt || new Date().toISOString();}
  await tx.execute(`UPDATE capture_agents SET last_liveness_at=now(),last_full_heartbeat_at=now(),last_heartbeat_at=now(),
    capabilities=capabilities||$2::jsonb WHERE id=$1 AND (last_liveness_at IS NULL OR last_liveness_at < now()-interval '25 seconds'
    OR capabilities->>'readyForSearch' IS DISTINCT FROM $3 OR capabilities->>'deviceReason' IS DISTINCT FROM $4)`,
  [agent.id,merge,String(ready),String(merge.deviceReason||'')]);
}
async function findAssignedCandidate(tx,tenantId,agentId) {
  return tx.queryOne(`SELECT item.* FROM capture_task_items item
    JOIN capture_tasks child ON child.id=item.execution_task_id AND child.tenant_id=item.tenant_id
      AND child.metadata->>'workflow'=$3
    LEFT JOIN capture_tasks parent ON parent.id=item.task_id AND parent.tenant_id=item.tenant_id
      AND parent.id<>item.execution_task_id
    WHERE item.tenant_id=$1 AND item.assigned_agent_id=$2
      AND child.metadata->>'stopRequested' IS DISTINCT FROM 'true'
      AND child.status IN ('pending','running')
      AND COALESCE(child.metadata->>'distributionMode','') <> 'elastic_pool'
      AND item.status IN ('pending','retryable')
      AND (parent.id IS NULL OR (
        parent.metadata->>'stopRequested' IS DISTINCT FROM 'true'
        AND parent.metadata->>'operatorStopped' IS DISTINCT FROM 'true'
        AND parent.metadata->>'stopPending' IS DISTINCT FROM 'true'
        AND COALESCE(parent.metadata->>'stopCommandId','')=''))
    ORDER BY child.created_at, item.ordinal LIMIT 1 FOR UPDATE OF item SKIP LOCKED`,[tenantId,agentId,WORKFLOW]);
}
// One keyword that runs out of attempts turns the run needs_action; its other keywords stay claimable,
// as in the browser elastic dispatch. Retries go to the fewest attempts first, so one failing keyword
// cannot use up all of its retries while the others wait behind it.
async function claimElasticItem(tx,principal,agent,now) {
  const item=await tx.queryOne(`SELECT item.* FROM capture_task_items item
    JOIN capture_tasks parent ON parent.id=item.task_id AND parent.tenant_id=item.tenant_id
    WHERE item.tenant_id=$1
      AND parent.task_type='capture_orchestration'
      AND parent.status IN ('pending','running','needs_action')
      AND parent.platform='douyin'
      AND COALESCE(parent.metadata->>'distributionMode','')='elastic_pool'
      AND parent.metadata->>'stopRequested' IS DISTINCT FROM 'true'
      AND parent.metadata->>'operatorStopped' IS DISTINCT FROM 'true'
      AND parent.metadata->>'stopPending' IS DISTINCT FROM 'true'
      AND COALESCE(parent.metadata->>'stopCommandId','')=''
      AND COALESCE(parent.metadata->>'orchestrationTemplate','false') <> 'true'
      AND item.item_type='keyword' AND item.platform='douyin'
      AND item.status IN ('pending','retryable')
      AND item.attempt_count < $3
      AND (item.metadata->>'pinnedAgentId'=$2::text
        OR (COALESCE(item.metadata->>'pinnedAgentId','')=''
          AND parent.metadata @> jsonb_build_object('eligibleAgentIds', jsonb_build_array($2::text))))
      AND (item.execution_task_id IS NULL OR EXISTS (SELECT 1 FROM capture_tasks prev
        WHERE prev.id=item.execution_task_id AND prev.tenant_id=item.tenant_id AND prev.status=ANY($4::text[])))
      AND NOT EXISTS (SELECT 1 FROM capture_agent_commands cmd WHERE cmd.tenant_id=item.tenant_id
        AND cmd.task_id=item.execution_task_id AND cmd.status IN ('pending','acknowledged'))
      AND NOT EXISTS (SELECT 1 FROM capture_task_item_attempts sa WHERE sa.tenant_id=item.tenant_id
        AND sa.item_id=item.id AND sa.agent_id=$2::uuid
        AND (UPPER(COALESCE(sa.error->>'code',''))=ANY($5::text[])
          OR COALESCE(sa.error->>'requiresManualAction',sa.error->>'securityBlocked','false')='true'))
      AND COALESCE(jsonb_array_length(parent.metadata->'planSnapshot'->'searchPasses'),0) <= 1
      AND COALESCE(parent.metadata->'planSnapshot'->'negativePatrol'->>'enabled','false') <> 'true'
      AND COALESCE(parent.metadata->'planSnapshot'->'searchFilters'->>'publishTime','all') <> 'month'
    ORDER BY CASE WHEN item.status='pending' THEN 0 ELSE 1 END, parent.created_at, item.attempt_count, item.ordinal, item.id
    FOR UPDATE OF item SKIP LOCKED LIMIT 1`,
  [principal.tenantId,agent.id,MOBILE_ELASTIC_ATTEMPT_LIMIT,TERMINAL_EXECUTION_STATUSES,MOBILE_SAFETY_ERROR_CODES]);
  if (!item) return null;
  const parent=await tx.queryOne('SELECT * FROM capture_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[item.task_id,principal.tenantId]);
  const planSnapshot=parent.metadata?.planSnapshot || {};
  if (mobilePlanBlockReason(planSnapshot,parent.platform)) return null;
  const keywords=[item.keyword];
  const childId=randomUUID(), revision=item.assignment_revision+1;
  const childMetadata={workflow:WORKFLOW,agentKind:'android_mobile',deviceId:agent.capabilities.deviceId,
    filters:mobileTaskFilters(planSnapshot.searchFilters),budgets:mobileTaskBudgets(planSnapshot,1),
    keywords,deadlineAt:null,planSnapshot:trimMobilePlanSnapshot(planSnapshot,keywords),
    orchestrationChild:true,parentTaskId:parent.id,orchestrationRevision:revision,
    distributionMode:'elastic_pool',claimUnit:'keyword',
    scheduleId:parent.orchestration_schedule_id||undefined,scheduledFor:parent.scheduled_for||undefined};
  await tx.execute(`INSERT INTO capture_tasks(id,tenant_id,parent_task_id,origin_agent_id,assigned_agent_id,
    client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,
    orchestration_revision,orchestration_schedule_id,scheduled_for,schedule_revision,source_updated_at)
    VALUES($1::uuid,$2,$3,$4,$4,$1::uuid::text,'capture',$5,$6,'douyin','android_runner','cloud','pending',$7,
    $8,$9,$10,$11,now())`,
  [childId,principal.tenantId,parent.id,agent.id,WORKFLOW,`${parent.title} · ${String(item.keyword).slice(0,80)}`,childMetadata,
    revision,parent.orchestration_schedule_id||null,parent.scheduled_for||null,parent.schedule_revision||null]);
  if (item.execution_task_id && item.execution_task_id!==childId) {
    await tx.execute(`UPDATE capture_tasks SET status='superseded',metadata=metadata||jsonb_build_object(
      'handoffSuccessorTaskId',$1::uuid::text,'handoffReason','android_elastic_claimed','handoffAt',now()::text,
      'terminalDisposition','superseded','terminalReason','android_elastic_claimed'),
      finished_at=COALESCE(finished_at,now()),updated_at=now()
      WHERE id=$2 AND tenant_id=$3 AND status=ANY($4::text[])`,
    [childId,item.execution_task_id,principal.tenantId,TERMINAL_EXECUTION_STATUSES]);
  }
  const bound=await tx.queryOne(`UPDATE capture_task_items SET execution_task_id=$2,assigned_agent_id=$3,updated_at=now()
    WHERE id=$1 RETURNING *`,[item.id,childId,agent.id]);
  const child=await taskRow(tx,principal.tenantId,childId);
  return {item:bound,child};
}
async function claimBoundItem(tx,principal,agent,child,item,sessionId,now) {
  if (!child.metadata.deadlineAt) {
    child.metadata.deadlineAt=new Date(now+Number(child.metadata.budgets?.batchMs||0)).toISOString();
    await tx.execute('UPDATE capture_tasks SET metadata=$2,started_at=COALESCE(started_at,now()) WHERE id=$1',[child.id,child.metadata]);
  }
  if (Date.parse(child.metadata.deadlineAt)<=now) {
    await tx.execute(`UPDATE capture_task_items SET status='needs_action',error='{"code":"deadline_expired"}'::jsonb,
      finished_at=now(),updated_at=now() WHERE id=$1 AND status IN ('pending','retryable')`,[item.id]);
    await rollup(tx,principal.tenantId,child.id);
    await refreshOrchestrationParent(tx,principal.tenantId,child,agent.id);
    return {task:null,permit:null,control:{reason:'deadline_expired'}};
  }
  const lastAttempt=await tx.queryOne(`SELECT agent_id FROM capture_task_item_attempts
    WHERE tenant_id=$1 AND item_id=$2 ORDER BY attempt_number DESC,created_at DESC,id DESC LIMIT 1`,[principal.tenantId,item.id]);
  const resumeAuthorized=item.metadata.resumeAuthorized===true
    || (item.status==='retryable' && lastAttempt?.agent_id===agent.id);
  const attemptId=randomUUID(), revision=item.assignment_revision+1;
  const hash=digest({taskId:child.id,itemId:item.id,keyword:item.keyword,filters:child.metadata.filters,budgets:child.metadata.budgets,revision});
  const metadata={...item.metadata,attemptId,deviceHeld:true,sessionId,leaseId:randomUUID(),completion:null,
    reason:'',closure:null,deviceClosedAt:null,resumeAuthorized,
    leaseUntil:new Date(Math.min(now+LEASE_MS,Date.parse(child.metadata.deadlineAt))).toISOString()};
  const updated=await tx.queryOne(`UPDATE capture_task_items SET assignment_revision=$2,attempt_count=attempt_count+1,
    request_hash=$3,status='running',metadata=$4,error='{}'::jsonb,finished_at=NULL,started_at=now(),updated_at=now()
    WHERE id=$1 RETURNING *`,[item.id,revision,hash,metadata]);
  await tx.execute(`INSERT INTO capture_task_item_attempts(id,tenant_id,item_id,parent_task_id,execution_task_id,agent_id,
    attempt_number,assignment_revision,status,request_hash,checkpoint,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,now())`,
  [attemptId,principal.tenantId,updated.id,updated.task_id,child.id,agent.id,updated.attempt_count,revision,hash,{sessionId,leaseId:metadata.leaseId}]);
  await tx.execute(`UPDATE capture_tasks SET status='running',heartbeat_at=now(),updated_at=now() WHERE id=$1`,[child.id]);
  await refreshOrchestrationParent(tx,principal.tenantId,child,agent.id);
  return {task:taskPayload(updated,child.metadata),permit:permit(updated,child.metadata,now),control:{}};
}
export async function poll(tx,principal,body,now=Date.now()) {
  const sessionId=id(body.sessionId,'SESSION_ID');
  const agent=await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  if (text(body.deviceId,'DEVICE_ID',120)!==agent.capabilities.deviceId) fail('DEVICE_ID_MISMATCH',403);
  const ready=body.readyForSearch===true;
  await persistHeartbeat(tx,agent,ready,text2(body.reason,120),body.probe);
  const held=await heldItem(tx,principal.tenantId,agent.id);
  if (held) {
    const stopped=control(held,held.task_metadata,held.parent_metadata,sessionId,now);
    if (stopped) return {task:null,permit:null,control:stopped};
    return {task:taskPayload(held,held.task_metadata),
      permit:{...permit(held,held.task_metadata,now),leaseUntil:held.metadata.leaseUntil},control:{}};
  }
  if (!ready) return {task:null,permit:null,control:{reason:'device_not_ready'}};
  let item=await findAssignedCandidate(tx,principal.tenantId,agent.id);
  let child;
  if (item) {
    child=await taskRow(tx,principal.tenantId,item.execution_task_id);
  } else {
    const claimed=await claimElasticItem(tx,principal,agent,now);
    if (!claimed) return {task:null,permit:null,control:{}};
    item=claimed.item; child=claimed.child;
  }
  return claimBoundItem(tx,principal,agent,child,item,sessionId,now);
}
export async function currentAttempt(tx,principal,input) {
  const ident=identity(input);
  if (ident.agentId!==principal.agentId) fail('AGENT_ID_MISMATCH',403);
  await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  const task=await taskRow(tx,principal.tenantId,ident.taskId);
  const item=await tx.queryOne(`SELECT * FROM capture_task_items WHERE tenant_id=$1 AND id=$2 AND execution_task_id=$3 FOR UPDATE`,
    [principal.tenantId,ident.itemId,task.id]);
  if (!item) fail('ATTEMPT_LINEAGE_MISMATCH',403);
  const attempt=await tx.queryOne(`SELECT * FROM capture_task_item_attempts WHERE tenant_id=$1 AND id=$2 AND item_id=$3
    AND execution_task_id=$4 AND parent_task_id=$5 AND agent_id=$6 AND assignment_revision=$7 AND request_hash=$8 FOR UPDATE`,
  [principal.tenantId,ident.attemptId,ident.itemId,task.id,item.task_id,ident.agentId,ident.assignmentRevision,ident.requestHash]);
  if (!attempt) fail('ATTEMPT_LINEAGE_MISMATCH',403);
  return {ident,task,item,attempt,current:item.metadata.attemptId===attempt.id && item.assignment_revision===ident.assignmentRevision};
}
export async function renew(tx,principal,body,now=Date.now()) {
  const {task,item,current}=await currentAttempt(tx,principal,body.identity);
  if (!current || body.leaseId!==item.metadata.leaseId) fail('STALE_ATTEMPT');
  const parentMetadata=task.metadata?.orchestrationChild && task.parent_task_id
    ? (await tx.queryOne('SELECT metadata FROM capture_tasks WHERE id=$1 AND tenant_id=$2',[task.parent_task_id,principal.tenantId]))?.metadata
    : null;
  const stopped=control(item,task.metadata,parentMetadata,id(body.sessionId,'SESSION_ID'),now);
  if (stopped || !item.metadata.deviceHeld) return {permit:null,control:stopped || {stopRequested:true,reason:'attempt_closed'}};
  const granted=permit(item,task.metadata,now);
  await saveItemMetadata(tx,item,{...item.metadata,leaseUntil:granted.leaseUntil});
  await tx.execute('UPDATE capture_agents SET last_liveness_at=now() WHERE id=$1',[principal.agentId]);
  return {permit:granted,control:{}};
}
