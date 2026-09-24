import {digest,fail,id,json,text} from './validation.js';
import {currentAttempt,MOBILE_ELASTIC_ATTEMPT_LIMIT} from './leases.js';
import {refreshOrchestrationParent} from './parent-refresh.js';
import {parentStopRequested,rollup,saveItemMetadata} from './repository.js';
async function parentMetadataFor(tx,principal,task) {
  if (!task.metadata?.orchestrationChild || !task.parent_task_id) return null;
  const row=await tx.queryOne('SELECT metadata FROM capture_tasks WHERE id=$1 AND tenant_id=$2',[task.parent_task_id,principal.tenantId]);
  return row?.metadata || null;
}
export async function complete(tx,principal,body) {
  const requestId=id(body.requestId,'REQUEST_ID');
  const sessionId=id(body.sessionId,'SESSION_ID');
  if (!['completed','interrupted','needs_action','canceled'].includes(body.status) || typeof body.deviceIdle!=='boolean') fail('INVALID_COMPLETION',400);
  const payload={requestId,sessionId,status:body.status,deviceIdle:body.deviceIdle,
    reason:String(body.reason || '').slice(0,256),checkpoint:json(body.checkpoint)};
  const hash=digest(payload);
  const {task,item,attempt,current}=await currentAttempt(tx,principal,body.identity);
  if (attempt.result?.completion) {
    if (attempt.result.completion.requestId!==requestId || attempt.result.completion.hash!==hash) fail('COMPLETION_CONFLICT');
    return {...attempt.result.completion.receipt,duplicate:true};
  }
  if (attempt.checkpoint.sessionId!==sessionId) fail('SESSION_MISMATCH');
  if (attempt.result?.closure) {
    const receipt={accepted:true,deviceHeld:false,closed:true};
    await tx.execute('UPDATE capture_task_item_attempts SET result=result||$2::jsonb WHERE id=$1',
      [attempt.id,{completion:{requestId,hash,receipt}}]);
    return receipt;
  }
  if (!current) fail('STALE_ATTEMPT');
  const parentMetadata=await parentMetadataFor(tx,principal,task);
  const stopFlagged=task.metadata.stopRequested===true || parentStopRequested(parentMetadata);
  const status=stopFlagged?'canceled':body.status;
  const orchestrationChild=task.metadata?.orchestrationChild===true;
  // Item projection: a stop cancels; a still-held device needs manual closure; a
  // clean completion is terminal. For orchestration children an unfinished
  // device-idle attempt becomes retryable while budget remains and the parent is
  // not stopped, so the same phone or another eligible node can pick it up again.
  // Standalone runs keep the legacy needs_action projection and explicit resume.
  let itemStatus;
  if (status==='canceled') itemStatus='canceled';
  else if (!body.deviceIdle) itemStatus='needs_action';
  else if (status==='completed') itemStatus='completed';
  else if (orchestrationChild && item.attempt_count < MOBILE_ELASTIC_ATTEMPT_LIMIT && !stopFlagged) itemStatus='retryable';
  else itemStatus='needs_action';
  const receipt={accepted:true,deviceHeld:!body.deviceIdle};
  const completion={requestId,hash,receipt};
  await tx.execute(`UPDATE capture_task_item_attempts SET status=$2,checkpoint=checkpoint||$3::jsonb,
    result=result||$4::jsonb,finished_at=now(),updated_at=now() WHERE id=$1`,
  [attempt.id,status,{runner:payload.checkpoint},{completion,reason:payload.reason}]);
  await saveItemMetadata(tx,item,{...item.metadata,deviceHeld:!body.deviceIdle,completion,
    reason:payload.reason,deviceClosedAt:body.deviceIdle?new Date().toISOString():null,
    resumeAuthorized:itemStatus==='retryable'?false:item.metadata.resumeAuthorized===true},itemStatus);
  await rollup(tx,principal.tenantId,task.id);
  await refreshOrchestrationParent(tx,principal.tenantId,task,principal.agentId);
  return receipt;
}
export async function closeDevice(tx,principal,body) {
  const requestId=id(body.requestId,'REQUEST_ID'), evidence=json(body.evidence,4096);
  if (!['operator_takeover','independent_stop_check'].includes(evidence.method)) fail('CLOSURE_EVIDENCE_REQUIRED',400);
  text(evidence.evidenceId,'EVIDENCE_ID'); text(evidence.verifiedBy,'VERIFIED_BY');
  const verified=Date.parse(evidence.verifiedAt);
  const {task,item,attempt,current}=await currentAttempt(tx,principal,body.identity);
  const hash=digest({requestId,evidence});
  if (attempt.result?.closure) {
    if (attempt.result.closure.requestId!==requestId || attempt.result.closure.hash!==hash) fail('CLOSURE_CONFLICT');
    return {deviceHeld:false,duplicate:true};
  }
  if (!current) fail('STALE_ATTEMPT');
  if (!Number.isFinite(verified) || verified<Date.parse(attempt.started_at) || verified>Date.now()+5000) fail('INVALID_CLOSURE_TIME',400);
  const closure={requestId,hash,evidence};
  const parentMetadata=await parentMetadataFor(tx,principal,task);
  const stopFlagged=task.metadata.stopRequested===true || parentStopRequested(parentMetadata);
  await tx.execute(`UPDATE capture_task_item_attempts SET result=result||$2::jsonb,status=CASE WHEN status='running'
    THEN 'interrupted' ELSE status END,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$1`,[attempt.id,{closure}]);
  await saveItemMetadata(tx,item,{...item.metadata,deviceHeld:false,closure},stopFlagged?'canceled':'needs_action');
  await rollup(tx,principal.tenantId,task.id);
  await refreshOrchestrationParent(tx,principal.tenantId,task,principal.agentId);
  return {deviceHeld:false};
}
