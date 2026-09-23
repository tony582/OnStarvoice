const terminal=new Set(['completed','completed_with_warnings','completed_with_failures','failed','needs_action','canceled','skipped','superseded']);

// Targeted legacy patrols identify an existing record. Discovery deliberately
// has no input recordId; success is proved by the record-store receipt instead.
export async function projectDiscoveryTaskResult(tx,{tenantId,task,snapshot={}}) {
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
  const itemStatus=stored?'completed':canceled?'canceled':'needs_action';
  const taskStatus=canceled?status==='superseded'?'superseded':'canceled':stored?'completed':'needs_action';
  const error=stored?{}:{code:canceled?'detail_canceled':'detail_finished_without_ingestion',reportedStatus:status};
  await tx.execute(`UPDATE capture_task_items SET status=$3,result_record_id=$4,result_observation_id=$5,error=$6,
    finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
  [tenantId,candidate.item_id,itemStatus,candidate.record_id,candidate.observation_id,error]);
  await tx.execute(`UPDATE capture_task_item_attempts SET status=$3,error=$4,
    result=jsonb_build_object('recordId',$5::uuid,'observationId',$6::uuid),finished_at=COALESCE(finished_at,now()),updated_at=now()
    WHERE tenant_id=$1 AND item_id=$2 AND attempt_number=$7 AND assignment_revision=$8 AND execution_task_id=$9`,
  [tenantId,candidate.item_id,itemStatus,error,candidate.record_id,candidate.observation_id,candidate.attempt_count,candidate.assignment_revision,task.id]);
  if (!stored) {
    await tx.execute(`UPDATE capture_discovery_candidates SET status='failed',last_error=$3 WHERE tenant_id=$1 AND id=$2`,[tenantId,candidate.id,error]);
    await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='needs_action'
      WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active'`,[tenantId,candidate.id]);
  }
  return tx.queryOne(`UPDATE capture_tasks SET status=$3,error=$4,counts=$5,progress=$6,message=$7,
    finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
  [tenantId,task.id,taskStatus,error,{total:1,processed:1,success:stored?1:0,failed:stored?0:1},
    {current:1,total:1,percent:100,phase:taskStatus},stored?'手机发现作品已补齐详情并入库':canceled?'补详情已停止':'补详情结束但未取得入库回执，需要处理']);
}
