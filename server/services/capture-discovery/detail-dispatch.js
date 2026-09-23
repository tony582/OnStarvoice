import {randomUUID, createHash} from 'node:crypto';
import {findCaptureAgentExecutionSlotBlocker} from '../capture-cloud.js';
import {reconcileDiscoveryDetails} from './detail-lifecycle.js';

export const DISCOVERED_POST_WORKFLOW = 'discovered_post_capture';
export function canCaptureDiscoveredPost(agent, capabilities = agent?.capabilities || {}) {
  return agent?.status === 'active' && capabilities.agentKind !== 'android_mobile'
    && capabilities.discoveredPostCaptureV1 === true && capabilities.remoteTargetedPostCaptureV1 === true
    && capabilities.remoteTaskCreate === true && capabilities.remoteStop === true
    && agent.allowed_platforms?.includes('douyin') && capabilities.supportedPlatforms?.includes('douyin');
}
export async function dispatchDiscoveredPost(tx, {agent, capabilities = agent?.capabilities || {}} = {}) {
  const tenants = new Set(String(process.env.ANDROID_DISCOVERY_INGEST_TENANTS || '').split(',').map(v => v.trim()));
  if (!tenants.has(agent?.tenant_id) || !canCaptureDiscoveredPost(agent, capabilities)) return null;
  await reconcileDiscoveryDetails(tx, {tenantId:agent.tenant_id});
  if (await findCaptureAgentExecutionSlotBlocker(tx,agent.tenant_id,agent.id)) return null;
  const candidate = await tx.queryOne(`SELECT candidate.* FROM capture_discovery_candidates candidate
    WHERE candidate.tenant_id=$1 AND candidate.status='queued' AND EXISTS (
      SELECT 1 FROM capture_discovery_run_candidates demand WHERE demand.tenant_id=candidate.tenant_id
        AND demand.candidate_id=candidate.id AND demand.demand_status='active')
    ORDER BY candidate.first_seen_at,candidate.id LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED`, [agent.tenant_id]);
  if (!candidate) return null;
  const taskId=randomUUID(),itemId=randomUUID(),attemptId=randomUUID(),commandId=randomUUID();
  const workflow=DISCOVERED_POST_WORKFLOW;
  const requestHash=createHash('sha256').update(JSON.stringify({workflow,taskId,itemId,attemptId,
    candidateId:candidate.id,agentId:agent.id,externalId:candidate.external_id})).digest('hex');
  const target={candidateId:candidate.id,itemId,externalId:candidate.external_id,url:candidate.canonical_url,
    captureTaskItemAttemptId:attemptId,captureTaskItemRequestHash:requestHash,
    captureTaskItemAttemptNumber:1,captureTaskItemAssignmentRevision:1};
  const captureSettings={includeComments:true,includeBloggerMetrics:false,commentsMaxDetectedItems:50};
  const payload={taskId,clientTaskId:taskId,title:'手机发现作品补详情',platform:'douyin',workflow,
    taskKind:workflow,protocolVersion:1,executionMode:'one_time',targets:[target],captureSettings,
    requestHash,attemptIdentity:attemptId,authCodeId:agent.auth_code_id,authBindingId:agent.auth_binding_id,
    orchestration:{revision:1,itemIds:[itemId],itemAttempts:[{itemId,attemptId,requestHash,
      attemptNumber:1,assignmentRevision:1,externalId:candidate.external_id}]}};
  await tx.execute(`INSERT INTO capture_tasks(id,tenant_id,origin_agent_id,assigned_agent_id,client_task_id,
    task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision)
    VALUES($1,$2,$3,$3,$1::uuid::text,$4,$4,$5,'douyin','cloud','discovery_detail','pending',$6,1)`,
  [taskId,agent.tenant_id,agent.id,workflow,payload.title,{workflow,protocolVersion:1,remoteCreated:true,
    remoteRequestHash:requestHash,createCommandId:commandId,attemptIdentity:attemptId,
    candidateId:candidate.id,captureSettings,itemIds:[itemId]}]);
  await tx.execute(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,platform,item_type,
    external_id,url_snapshot,status,attempt_count,assigned_agent_id,execution_task_id,assignment_revision,
    request_hash,metadata,dispatched_at) VALUES($1,$2,$3,$4,'douyin','discovered_post',$9,
    $5,'dispatched',1,$6,$3,1,$7,$8,now())`,
  [itemId,agent.tenant_id,taskId,candidate.id,candidate.canonical_url,agent.id,requestHash,{candidateId:candidate.id},candidate.external_id]);
  await tx.execute(`INSERT INTO capture_task_item_attempts(id,tenant_id,item_id,parent_task_id,execution_task_id,
    agent_id,attempt_number,assignment_revision,status,request_hash,dispatched_at)
    VALUES($1,$2,$3,$4,$4,$5,1,1,'dispatched',$6,now())`,[attemptId,agent.tenant_id,itemId,taskId,agent.id,requestHash]);
  await tx.execute(`INSERT INTO capture_agent_commands(id,tenant_id,agent_id,task_id,command_type,payload,
    requested_by_name,expires_at) VALUES($1,$2,$3,$4,'create',$5,'手机候选补详情',now()+interval '2 minutes')`,
  [commandId,agent.tenant_id,agent.id,taskId,payload]);
  await tx.execute(`UPDATE capture_discovery_candidates SET status='capturing',detail_task_item_id=$1,last_error='{}'
    WHERE tenant_id=$2 AND id=$3`,[itemId,agent.tenant_id,candidate.id]);
  await tx.execute(`UPDATE capture_discovery_run_candidates SET detail_task_item_id=$1,is_detail_owner=(run_id=(SELECT run_id
      FROM capture_discovery_run_candidates WHERE tenant_id=$2 AND candidate_id=$3 AND demand_status='active' ORDER BY run_id LIMIT 1))
    WHERE tenant_id=$2 AND candidate_id=$3 AND demand_status='active'`,[itemId,agent.tenant_id,candidate.id]);
  return {taskId,itemId,commandId,candidateId:candidate.id};
}
