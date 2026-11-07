import {randomUUID} from 'node:crypto';
import {DiscoveryError} from './validation.js';
import {
  DISCOVERY_AUTO_REQUEUED_CODE,
  requeueDiscoveryCandidate,
  shouldAutoRetryDiscovery,
} from './auto-retry.js';

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

export async function reconcileDiscoveryDetails(tx,{tenantId,taskIds=null}) {
  const rows=await tx.queryAll(`SELECT task.id AS task_id,task.assigned_agent_id,task.status AS task_status FROM capture_tasks task WHERE task.tenant_id=$1
    AND ($2::uuid[] IS NULL OR task.id=ANY($2::uuid[]))
    AND task.task_type='discovered_post_capture' AND task.attention_dismissed_at IS NULL
    AND (task.status='pending' OR (task.status='needs_action' AND task.error->>'code'='detail_create_expired'))
    AND task.started_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM capture_task_attempts attempt WHERE attempt.tenant_id=task.tenant_id AND attempt.task_id=task.id)
    AND EXISTS(SELECT 1 FROM capture_agent_commands command WHERE command.tenant_id=task.tenant_id AND command.task_id=task.id
      AND command.id::text=task.metadata->>'createCommandId'
      AND command.payload->>'attemptIdentity'=task.metadata->>'attemptIdentity'
      AND command.command_type='create' AND command.status IN ('pending','acknowledged','expired') AND command.expires_at<now())
    AND EXISTS(SELECT 1 FROM capture_task_items item WHERE item.tenant_id=task.tenant_id AND item.task_id=task.id
      AND item.execution_task_id=task.id AND item.status='dispatched' AND item.started_at IS NULL)
    ORDER BY task.id LIMIT 20 FOR UPDATE OF task SKIP LOCKED`,[tenantId,taskIds]);
  const settled=[];
  for (const row of rows) {
    const candidate=await tx.queryOne(`SELECT candidate.id,candidate.detail_task_item_id,candidate.record_id,candidate.last_error FROM capture_discovery_candidates candidate
      JOIN capture_tasks task ON task.tenant_id=candidate.tenant_id AND task.metadata->>'candidateId'=candidate.id::text
      WHERE candidate.tenant_id=$1 AND task.id=$2 AND candidate.record_id IS NULL
      AND (candidate.status='capturing' OR (candidate.status='failed' AND candidate.last_error->>'code'='detail_create_expired'))
      FOR UPDATE OF candidate SKIP LOCKED`,[tenantId,row.task_id]);
    if (!candidate) continue;
    // Only the unstarted, current dispatch may expire. Preserve a reassigned
    // candidate, a running attempt, or a formal receipt that arrived meanwhile.
    const item=await tx.queryOne(`SELECT item.id,attempt.id AS attempt_id,attempt.attempt_number FROM capture_task_items item
      JOIN capture_tasks task ON task.id=item.execution_task_id AND task.tenant_id=item.tenant_id
      JOIN capture_task_item_attempts attempt ON attempt.tenant_id=item.tenant_id AND attempt.item_id=item.id
        AND attempt.id::text=task.metadata->>'attemptIdentity' AND attempt.execution_task_id=task.id
        AND attempt.attempt_number=item.attempt_count AND attempt.assignment_revision=item.assignment_revision
        AND attempt.request_hash=item.request_hash
      WHERE item.tenant_id=$1 AND item.id=$2 AND item.task_id=$3 AND item.execution_task_id=$3
        AND item.status='dispatched' AND attempt.status='dispatched'
        AND item.started_at IS NULL AND attempt.started_at IS NULL
        AND item.result_record_id IS NULL AND item.result_observation_id IS NULL
      FOR UPDATE OF item,attempt`,[tenantId,candidate.detail_task_item_id,row.task_id]);
    if (!item) continue;
    // The browser never acknowledged the job: give it to another browser
    // first; only a repeatedly unacknowledged post waits for a person. A
    // legacy needs_action row is only settled, never put back in the queue.
    const autoRetry=row.task_status==='pending'&&shouldAutoRetryDiscovery({candidate,sourceCode:'detail_create_expired'})
      ? await requeueDiscoveryCandidate(tx,{tenantId,candidate,agentId:row.assigned_agent_id,
          sourceCode:'detail_create_expired'})
      : 0;
    const status=autoRetry?'failed':'needs_action';
    const error=autoRetry
      ? {code:DISCOVERY_AUTO_REQUEUED_CODE,sourceCode:'detail_create_expired',autoRetry}
      : {code:'detail_create_expired'};
    await tx.execute(`UPDATE capture_task_items SET status=$3,error=$4,
      finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2`,[tenantId,item.id,status,error]);
    await tx.execute(`UPDATE capture_task_item_attempts SET status=$3,error=$4,
      finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2`,[tenantId,item.attempt_id,status,error]);
    if (!autoRetry) {
      await tx.execute(`UPDATE capture_discovery_candidates SET status='failed',last_error='{"code":"detail_create_expired"}'
        WHERE tenant_id=$1 AND id=$2`,[tenantId,candidate.id]);
      await tx.execute(`UPDATE capture_discovery_run_candidates SET demand_status='needs_action'
        WHERE tenant_id=$1 AND candidate_id=$2 AND demand_status='active'`,[tenantId,candidate.id]);
    }
    // Before the first heartbeat the task slot is still zero. Bind it to the
    // dispatched attempt so a late first report cannot reopen an operator close.
    await tx.execute(`UPDATE capture_tasks SET status=$4,error=$5,
      message=$6,counts='{"total":1,"processed":1,"success":0,"failed":1}',
      attempt_number=GREATEST(attempt_number,$3),
      finished_at=COALESCE(finished_at,now()),
      updated_at=CASE WHEN status='pending' THEN now() ELSE updated_at END
      WHERE tenant_id=$1 AND id=$2`,[tenantId,row.task_id,item.attempt_number,status,error,
      autoRetry?`补详情下发未确认；已自动换节点重试（第 ${autoRetry} 次）`:'补详情下发未确认']);
    settled.push(row.task_id);
  }
  return settled;
}
