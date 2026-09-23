import {randomUUID} from 'node:crypto';
import {DiscoveryError} from './validation.js';

// Global lock order matches browser mirroring: detail task -> candidate -> item.
// The caller already owns the mobile run lock. Never lock a detail task while
// holding its candidate: a concurrent browser snapshot holds the task first.
export async function cancelDiscoveryDemands(tx, {tenantId,runId}) {
  const tasks=await tx.queryAll(`SELECT task.*,agent.auth_code_id,agent.auth_binding_id,item.id AS item_id
    FROM capture_discovery_run_candidates demand JOIN capture_discovery_candidates candidate
      ON candidate.id=demand.candidate_id AND candidate.tenant_id=demand.tenant_id
    JOIN capture_task_items item ON item.id=candidate.detail_task_item_id
    JOIN capture_tasks task ON task.id=item.execution_task_id AND task.tenant_id=item.tenant_id
    JOIN capture_agents agent ON agent.id=task.assigned_agent_id
    WHERE demand.tenant_id=$1 AND demand.run_id=$2 AND demand.demand_status='active'
    ORDER BY task.id FOR UPDATE OF task`,[tenantId,runId]);
  const tasksByItem=new Map(tasks.map(task=>[task.item_id,task]));
  const candidates=await tx.queryAll(`SELECT candidate.* FROM capture_discovery_candidates candidate
    JOIN capture_discovery_run_candidates demand ON demand.candidate_id=candidate.id AND demand.tenant_id=candidate.tenant_id
    WHERE demand.tenant_id=$1 AND demand.run_id=$2 AND demand.demand_status='active'
    ORDER BY candidate.id FOR UPDATE OF candidate`,[tenantId,runId]);
  const stopped=[];
  for (const candidate of candidates) {
    const task=tasksByItem.get(candidate.detail_task_item_id);
    if ((candidate.detail_task_item_id||null)!==(task?.item_id||null)) throw new DiscoveryError('DISCOVERY_ASSIGNMENT_CHANGED',409);
    await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='canceled',is_detail_owner=false
      WHERE tenant_id=$1 AND run_id=$2 AND candidate_id=$3 AND demand_status='active'`,[tenantId,runId,candidate.id]);
    const demand=await tx.queryOne(`SELECT 1 FROM capture_discovery_run_candidates
      WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active' LIMIT 1`,[tenantId,candidate.id]);
    if (demand) {
      await tx.execute(`UPDATE capture_discovery_run_candidates SET is_detail_owner=(run_id=(SELECT run_id
        FROM capture_discovery_run_candidates WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active' ORDER BY run_id LIMIT 1))
        WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active'`,[tenantId,candidate.id]);
      continue;
    }
    await tx.execute(`UPDATE capture_discovery_candidates SET status=CASE WHEN record_id IS NULL THEN 'needs_review' ELSE status END,
      last_error=jsonb_build_object('code','all_demands_canceled') WHERE tenant_id=$1 AND id=$2`,[tenantId,candidate.id]);
    if (!task || ['completed','completed_with_warnings','canceled','failed','superseded','needs_action'].includes(task.status)) continue;
    const command=await tx.queryOne(`SELECT id,status FROM capture_agent_commands WHERE tenant_id=$1 AND task_id=$2
      AND command_type='create' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[tenantId,task.id]);
    // Even pending creates can be in flight; physical stop needs browser ack.
    const stopId=randomUUID();
    await tx.execute(`UPDATE capture_agent_commands SET status='failed',finished_at=now(),updated_at=now(),
      result='{"code":"all_demands_canceled"}' WHERE tenant_id=$1 AND task_id=$2 AND command_type='create'
      AND status IN ('pending','acknowledged')`,[tenantId,task.id]);
    if (!task.metadata?.stopCommandId) {
      const payload={taskId:task.id,clientTaskId:task.client_task_id,platform:'douyin',workflow:'discovered_post_capture',
        authCodeId:task.auth_code_id,authBindingId:task.auth_binding_id,targetAttemptId:task.metadata?.attemptIdentity||''};
      await tx.execute(`INSERT INTO capture_agent_commands(id,tenant_id,agent_id,task_id,command_type,payload,
        requested_by_name,expires_at) VALUES($1,$2,$3,$4,'stop',$5,'停止手机发现批次',now()+interval '1 day')`,
      [stopId,tenantId,task.assigned_agent_id,task.id,payload]);
      await tx.execute(`UPDATE capture_tasks SET metadata=metadata||$3::jsonb,message='停止补详情，等待设备确认',updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[tenantId,task.id,{stopRequested:true,stopCommandId:stopId}]);
    }
    stopped.push({taskId:task.id,createStatus:command?.status||'',awaitingDeviceStop:true});
  }
  return {canceledDemands:candidates.length,stopped};
}

export async function reconcileDiscoveryDetails(tx,{tenantId}) {
  const rows=await tx.queryAll(`SELECT task.id AS task_id FROM capture_tasks task WHERE task.tenant_id=$1
    AND task.task_type='discovered_post_capture' AND task.status='pending'
    AND EXISTS(SELECT 1 FROM capture_agent_commands command WHERE command.task_id=task.id
      AND command.command_type='create' AND command.expires_at<now())
    ORDER BY task.id LIMIT 20 FOR UPDATE OF task SKIP LOCKED`,[tenantId]);
  for (const row of rows) {
    const candidate=await tx.queryOne(`SELECT candidate.id FROM capture_discovery_candidates candidate
      JOIN capture_task_items item ON item.id=candidate.detail_task_item_id WHERE candidate.tenant_id=$1
      AND candidate.status='capturing' AND item.execution_task_id=$2 FOR UPDATE OF candidate SKIP LOCKED`,[tenantId,row.task_id]);
    if (!candidate) continue;
    await tx.execute(`UPDATE capture_discovery_candidates SET status='failed',last_error='{"code":"detail_create_expired"}'
      WHERE tenant_id=$1 AND id=$2`,[tenantId,candidate.id]);
    await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='needs_action'
      WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active'`,[tenantId,candidate.id]);
    await tx.execute(`UPDATE capture_tasks SET status='needs_action',error='{"code":"detail_create_expired"}',
      message='补详情下发未确认',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`,[tenantId,row.task_id]);
  }
}
