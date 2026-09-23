import {digest,fail,id,json,text} from './validation.js';
import {currentAttempt} from './leases.js';
import {rollup,saveItemMetadata} from './repository.js';
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
  const status=task.metadata.stopRequested?'canceled':body.status;
  const itemStatus=body.deviceIdle ? status==='interrupted'?'needs_action':status : 'needs_action';
  const receipt={accepted:true,deviceHeld:!body.deviceIdle};
  const completion={requestId,hash,receipt};
  await tx.execute(`UPDATE capture_task_item_attempts SET status=$2,checkpoint=checkpoint||$3::jsonb,
    result=result||$4::jsonb,finished_at=now(),updated_at=now() WHERE id=$1`,
  [attempt.id,status,{runner:payload.checkpoint},{completion,reason:payload.reason}]);
  await saveItemMetadata(tx,item,{...item.metadata,deviceHeld:!body.deviceIdle,completion,
    reason:payload.reason,deviceClosedAt:body.deviceIdle?new Date().toISOString():null},itemStatus);
  await rollup(tx,principal.tenantId,task.id);
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
  await tx.execute(`UPDATE capture_task_item_attempts SET result=result||$2::jsonb,status=CASE WHEN status='running'
    THEN 'interrupted' ELSE status END,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$1`,[attempt.id,{closure}]);
  await saveItemMetadata(tx,item,{...item.metadata,deviceHeld:false,closure},task.metadata.stopRequested?'canceled':'needs_action');
  await rollup(tx,principal.tenantId,task.id);
  return {deviceHeld:false};
}
