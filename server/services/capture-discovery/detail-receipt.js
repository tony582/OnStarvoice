import {projectDiscoveryTaskResult} from './detail-projection.js';
import {assertUiBoundIngestion} from './ui-binding.js';
import {DiscoveryError} from './validation.js';

// Runs in the very same transaction as records + observations. Existing strict
// attempt checks remain authoritative; this additionally fences mobile demand
// cancellation and prevents a different work from satisfying the candidate.
export async function recordDiscoveryIngestion(tx, context, lineage) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.captureTaskId||'')) return;
  const task=await tx.queryOne(`SELECT id,metadata,status,error FROM capture_tasks WHERE tenant_id=$1 AND id=$2
    AND metadata->>'workflow'='discovered_post_capture' FOR UPDATE`,
    [context.tenantId,context.captureTaskId]);
  if (task?.metadata?.workflow !== 'discovered_post_capture') return;
  if (!lineage || !context.captureTaskItemAttemptId || !context.captureTaskItemRequestHash) {
    throw new DiscoveryError('DISCOVERY_STRICT_LINEAGE_REQUIRED',409);
  }
  const candidate=await tx.queryOne(`SELECT * FROM capture_discovery_candidates
    WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[context.tenantId,task.metadata.candidateId]);
  const liveTask=task;
  const lateReceipt=task.error?.code==='detail_finished_without_ingestion';
  const demand=await tx.queryOne(`SELECT 1 FROM capture_discovery_run_candidates
    WHERE tenant_id=$1 AND candidate_id=$2 AND (demand_status IN ('active','fulfilled') OR ($3::boolean AND demand_status='needs_action')) LIMIT 1`,
  [context.tenantId,candidate?.id,lateReceipt]);
  if (!candidate || !demand || liveTask.metadata.stopRequested || liveTask.metadata.stopCommandId
      || ['canceled','failed','superseded'].includes(liveTask.status)
      || (liveTask.status==='needs_action'&&!lateReceipt)
      || candidate.detail_task_item_id !== lineage.capture_task_item_id
      || context.record.platform !== 'douyin' || context.record.external_id !== candidate.external_id) {
    throw new DiscoveryError('DISCOVERY_RECEIPT_NOT_CURRENT',409);
  }
  await assertUiBoundIngestion(tx,{tenantId:context.tenantId,candidateId:candidate.id,record:context.record});
  const record=await tx.queryOne('SELECT business_visibility FROM records WHERE tenant_id=$1 AND id=$2',
    [context.tenantId,context.recordId]);
  const demandStatus=record?.business_visibility === 'eligible'?'fulfilled':'needs_action';
  await tx.execute(`UPDATE capture_discovery_candidates SET status='stored',record_id=$3,last_error='{}'
    WHERE tenant_id=$1 AND id=$2`,[context.tenantId,candidate.id,context.recordId]);
  await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status=$3,record_id=$4
    WHERE tenant_id=$1 AND candidate_id=$2 AND (demand_status IN ('active','fulfilled') OR ($5::boolean AND demand_status='needs_action'))`,
  [context.tenantId,candidate.id,demandStatus,context.recordId,lateReceipt]);
  return lateReceipt?{tenantId:context.tenantId,task,snapshot:{status:'completed'}}:null;
}

export async function finishDiscoveryObservation(tx,recovery) {
  if (recovery) await projectDiscoveryTaskResult(tx,recovery);
}
