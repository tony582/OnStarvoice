import {operatorClosedTask} from '../capture-operator-close.js';
import {
  DISCOVERY_AUTO_REQUEUED_CODE,
  DISCOVERY_AUTO_RETRY_LIMIT,
  DISCOVERY_LATE_RECEIPT_GRACE_MS,
  discoveryAutoRetryCount,
  requeueDiscoveryCandidate,
  shouldAutoRetryDiscovery,
} from './auto-retry.js';

const terminal=new Set(['completed','completed_with_warnings','completed_with_failures','failed','needs_action','canceled','skipped','superseded']);

const projectionCodes=new Set(['detail_finished_without_ingestion','detail_canceled']);
const text=(value,limit=1500)=>typeof value==='string'?value.trim().slice(0,limit):'';
function failureSource(task,snapshot) {
  const inputs=[snapshot,task];
  for (const input of inputs) {
    const error=input.error||{};
    const projected=projectionCodes.has(error.code);
    const sourceCode=text(projected?error.sourceCode:error.code,160);
    const sourceMessage=text(projected?error.sourceMessage:error.message||error.reason);
    if (!sourceCode&&!sourceMessage) continue;
    const phase=text(projected?error.sourcePhase:error.phase||error.stage||input.progress?.phase||input.phase,160);
    return {...(sourceCode?{sourceCode}:{}),...(sourceMessage?{sourceMessage}:{}),
      ...(phase&&phase!=='unknown'?{sourcePhase:phase}:{})};
  }
  // Old agents can report only a failure message. Do not promote a generic
  // projection message (or a successful client report) into the original cause.
  for (const input of inputs) {
    if (projectionCodes.has(input.error?.code)||!['failed','needs_action','completed_with_failures','canceled','superseded'].includes(input.status)) continue;
    const sourceMessage=text(input.message);
    if (!sourceMessage) continue;
    const phase=text(input.progress?.phase||input.phase,160);
    return {sourceMessage,...(phase&&phase!=='unknown'?{sourcePhase:phase}:{})};
  }
  return {};
}

// Targeted legacy patrols identify an existing record. Discovery deliberately
// has no input recordId; success is proved by the record-store receipt instead.
export async function projectDiscoveryTaskResult(tx,{tenantId,task,snapshot={}}) {
  // An operator ended this row (「结束并移到历史」): a late snapshot must not reopen it.
  if (operatorClosedTask(task)) return null;
  const status=String(snapshot.status||task.status||'');
  if (!terminal.has(status)) return null;
  const candidate=await tx.queryOne(`SELECT candidate.*,item.id AS item_id,item.attempt_count,item.assignment_revision,
      observation.id AS observation_id FROM capture_discovery_candidates candidate
    JOIN capture_task_items item ON item.id=candidate.detail_task_item_id AND item.tenant_id=candidate.tenant_id
    LEFT JOIN record_observations observation ON observation.record_id=candidate.record_id
      AND observation.capture_task_id=item.execution_task_id AND observation.capture_task_item_id=item.id
    WHERE candidate.tenant_id=$1 AND candidate.id=$2 AND item.execution_task_id=$3
    ORDER BY observation.captured_at DESC NULLS LAST LIMIT 1 FOR UPDATE OF candidate,item`,
  [tenantId,task.metadata?.candidateId,task.id]);
  if (!candidate) return null;
  const stored=Boolean(candidate.record_id&&candidate.observation_id);
  const canceled=['canceled','superseded'].includes(task.status)||['canceled','superseded'].includes(status);
  const source=stored?{}:failureSource(task,snapshot);
  // Not stored and not stopped: hand the post to another browser instead of a
  // person, a bounded number of times. A completed snapshot without receipt
  // first waits for its late upload before another browser repeats the work.
  // Terminal snapshots are replayed, and the mirror rewrites the task's error
  // from each one first. A candidate still queued from this task's item was
  // already handed on: keep that outcome instead of requeueing (or
  // escalating) a second time.
  const alreadyRequeued=task.error?.code===DISCOVERY_AUTO_REQUEUED_CODE
    ||(candidate.status==='queued'&&discoveryAutoRetryCount(candidate)>0);
  const autoRetry=stored||canceled ? 0
    : alreadyRequeued ? Math.max(1,Math.floor(Number(task.error?.autoRetry))||discoveryAutoRetryCount(candidate)||1)
    : shouldAutoRetryDiscovery({candidate,sourceCode:source.sourceCode})
      ? await requeueDiscoveryCandidate(tx,{tenantId,candidate,agentId:task.assigned_agent_id,
          sourceCode:source.sourceCode||'detail_finished_without_ingestion',
          delayMs:source.sourceCode?0:DISCOVERY_LATE_RECEIPT_GRACE_MS})
      : 0;
  const itemStatus=stored?'completed':canceled?'canceled':autoRetry?'failed':'needs_action';
  const taskStatus=canceled?status==='superseded'?'superseded':'canceled':stored?'completed':autoRetry?'failed':'needs_action';
  const cause=source.sourceMessage
    ? `${source.sourceMessage}${source.sourceCode&&!source.sourceMessage.includes(source.sourceCode)?`（${source.sourceCode}）`:''}`
    : source.sourceCode||'';
  const message=stored?'手机发现作品已补齐详情并入库':canceled
    ? cause?`补详情已停止：${cause}`:'补详情已停止'
    : autoRetry
      ? `补详情未入库${cause?`：${cause}`:''}；已自动换节点重试（第 ${autoRetry}/${DISCOVERY_AUTO_RETRY_LIMIT} 次）`
      : cause?`补详情未入库：${cause}；尚未取得入库回执，需要处理`:'补详情结束但未取得入库回执，需要处理';
  // The stable code is a receipt/recovery contract. Keep the observed failure
  // separately so rendering it cannot change whether a late receipt is accepted.
  const error=stored?{}:{code:canceled?'detail_canceled':autoRetry?DISCOVERY_AUTO_REQUEUED_CODE:'detail_finished_without_ingestion',
    reportedStatus:status,...source,...(autoRetry?{autoRetry}:{}),...(cause||autoRetry?{message}:{})};
  await tx.execute(`UPDATE capture_task_items SET status=$3,result_record_id=$4,result_observation_id=$5,error=$6,
    finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
  [tenantId,candidate.item_id,itemStatus,candidate.record_id,candidate.observation_id,error]);
  await tx.execute(`UPDATE capture_task_item_attempts SET status=$3,error=$4,
    result=jsonb_build_object('recordId',$5::uuid,'observationId',$6::uuid),finished_at=COALESCE(finished_at,now()),updated_at=now()
    WHERE tenant_id=$1 AND item_id=$2 AND attempt_number=$7 AND assignment_revision=$8 AND execution_task_id=$9`,
  [tenantId,candidate.item_id,itemStatus,error,candidate.record_id,candidate.observation_id,candidate.attempt_count,candidate.assignment_revision,task.id]);
  if (!stored && !autoRetry) {
    await tx.execute(`UPDATE capture_discovery_candidates SET status='failed',last_error=$3 WHERE tenant_id=$1 AND id=$2`,[tenantId,candidate.id,error]);
    await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='needs_action'
      WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active'`,[tenantId,candidate.id]);
  }
  return tx.queryOne(`UPDATE capture_tasks SET status=$3,error=$4,counts=$5,progress=$6,message=$7,
    finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
  [tenantId,task.id,taskStatus,error,{total:1,processed:1,success:stored?1:0,failed:stored?0:1},
    {current:1,total:1,percent:100,phase:taskStatus},message]);
}
