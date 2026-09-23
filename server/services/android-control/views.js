import {WORKFLOW,fail} from './validation.js';
import {deviceAvailability,holdState,recoveryView,receiptStats} from './recovery.js';
function run(row) {
  const metadata=row.metadata;
  return {id:row.id,title:row.title,status:row.status,agentId:row.assigned_agent_id,
    deviceId:metadata.deviceId,keywords:metadata.keywords,createdAt:row.created_at,deadlineAt:metadata.deadlineAt,
    stopRequested:metadata.stopRequested===true,stopScope:metadata.stopScope || '',
    progress:row.progress || {},candidateCounts:row.candidate_counts || {}};
}
const RUN_SQL=`SELECT task.*,agent.status AS agent_status,agent.capabilities AS agent_capabilities,
  agent.last_liveness_at AS agent_last_liveness_at,
  (SELECT jsonb_build_object('total',COUNT(*),'completed',COUNT(*) FILTER(WHERE status IN ('completed','completed_with_warnings')),
    'needsAction',COUNT(*) FILTER(WHERE status IN ('needs_action','failed'))) FROM capture_task_items WHERE task_id=task.id) AS progress,
  (SELECT jsonb_build_object('total',COUNT(*),'stored',COUNT(*) FILTER(WHERE demand_status='fulfilled'),
    'needsAction',COUNT(*) FILTER(WHERE demand_status='needs_action')) FROM capture_discovery_run_candidates WHERE run_id=task.id) AS candidate_counts
  FROM capture_tasks task LEFT JOIN capture_agents agent ON agent.id=task.assigned_agent_id AND agent.tenant_id=task.tenant_id
  WHERE task.tenant_id=$1 AND task.metadata->>'workflow'=$2`;
export async function listNodes(tx,tenantId) {
  const rows=await tx.queryAll(`SELECT agent.*,held.task_id AS active_run_id,held.metadata AS held_metadata,
    held.status AS held_status,held.task_metadata FROM capture_agents agent LEFT JOIN LATERAL
    (SELECT item.task_id,item.metadata,item.status,task.metadata AS task_metadata FROM capture_task_items item
      JOIN capture_tasks task ON task.id=item.task_id AND task.tenant_id=item.tenant_id
      WHERE item.tenant_id=agent.tenant_id AND item.assigned_agent_id=agent.id AND item.metadata->>'deviceHeld'='true'
      ORDER BY item.created_at LIMIT 1) held ON true
    WHERE agent.tenant_id=$1 AND agent.capabilities->>'agentKind'='android_mobile' ORDER BY agent.created_at DESC LIMIT 100`,[tenantId]);
  const now=Date.now();
  return {nodes:rows.map(row=>{
    const state=holdState({status:row.held_status,metadata:row.held_metadata},row.task_metadata || {},now);
    return {id:row.id,displayName:row.display_name,deviceId:row.capabilities.deviceId,status:row.status,
      ...deviceAvailability(row,now),lastHeartbeatAt:row.last_liveness_at,activeRunId:row.active_run_id,
      deviceHeld:state!=='free',holdState:state,
      holdReason:state==='closure_required' ? row.held_metadata?.reason ||
        (Date.parse(row.held_metadata?.leaseUntil)<=now?'lease_expired':'device_closure_required') : ''};
  })};
}
export async function listRuns(tx,tenantId) {
  return {runs:(await tx.queryAll(`${RUN_SQL} ORDER BY task.created_at DESC LIMIT 50`,[tenantId,WORKFLOW])).map(run)};
}
export async function runView(tx,tenantId,taskId) {
  const row=await tx.queryOne(`${RUN_SQL} AND task.id=$3`,[tenantId,WORKFLOW,taskId]);
  if (!row) fail('MOBILE_RUN_NOT_FOUND',404);
  const items=await tx.queryAll(`SELECT item.id,item.keyword,item.status,item.attempt_count,item.assignment_revision,item.metadata,item.error,
    attempt.checkpoint FROM capture_task_items item LEFT JOIN capture_task_item_attempts attempt
      ON attempt.item_id=item.id AND attempt.tenant_id=item.tenant_id
      AND attempt.assignment_revision=item.assignment_revision AND attempt.id::text=item.metadata->>'attemptId'
    WHERE item.tenant_id=$1 AND item.task_id=$2 ORDER BY item.ordinal`,[tenantId,taskId]);
  const candidates=await tx.queryAll(`SELECT c.id,c.external_id,c.canonical_url,c.status,d.demand_status,d.record_id,
    e.title_hint,e.author_hint,e.keyword,c.last_error,r.business_visibility,triage.status AS triage_status FROM capture_discovery_run_candidates d
    JOIN capture_discovery_candidates c ON c.id=d.candidate_id AND c.tenant_id=d.tenant_id
    JOIN capture_discovery_events e ON e.id=d.first_event_id AND e.tenant_id=d.tenant_id
    LEFT JOIN records r ON r.id=d.record_id AND r.tenant_id=d.tenant_id
    LEFT JOIN record_triage triage ON triage.record_id=r.id AND triage.tenant_id=r.tenant_id
    WHERE d.tenant_id=$1 AND d.run_id=$2 ORDER BY c.first_seen_at DESC LIMIT 100`,[tenantId,taskId]);
  const events=await tx.queryAll(`SELECT id,event_key,candidate_id,keyword,resolution_status,resolution_error,raw_share_url,delivery_mode,title_hint,received_at
    FROM capture_discovery_events WHERE tenant_id=$1 AND task_id=$2 ORDER BY received_at DESC LIMIT 100`,[tenantId,taskId]);
  const recovery=recoveryView(row,items,{status:row.agent_status,capabilities:row.agent_capabilities,last_liveness_at:row.agent_last_liveness_at});
  return {run:run(row),recovery,items:items.map(i=>({id:i.id,keyword:i.keyword,status:i.status,attemptCount:i.attempt_count,
    assignmentRevision:i.assignment_revision,reason:i.metadata.reason || i.error?.code || '',
    stats:receiptStats(i.checkpoint)})),
  candidates:candidates.map(c=>({id:c.id,externalId:c.external_id,canonicalUrl:c.canonical_url,status:c.status,
    demandStatus:c.demand_status,recordId:c.record_id,recordVisibility:c.business_visibility || null,triageStatus:c.triage_status || null,titleHint:c.title_hint,authorHint:c.author_hint,keyword:c.keyword,reason:c.last_error?.code || ''})),
  events:events.map(e=>({id:e.id,eventId:e.event_key,candidateId:e.candidate_id,keyword:e.keyword,resolutionStatus:e.resolution_status,resolutionError:e.resolution_error,
    rawShareUrl:e.raw_share_url,deliveryMode:e.delivery_mode,titleHint:e.title_hint,receivedAt:e.received_at}))};
}
