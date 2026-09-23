import {randomUUID} from 'node:crypto';
import {resumeError} from './recovery.js';
import {digest,fail,id,runInput,WORKFLOW} from './validation.js';
import {lockAgent,rollup,taskRow} from './repository.js';
import {cancelDiscoveryDemands} from '../capture-discovery/detail-lifecycle.js';
export async function createRun(tx,tenantId,body) {
  const input=runInput(body), requestId=id(body.requestId,'REQUEST_ID'), hash=digest(input);
  await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`android-create:${tenantId}:${requestId}`]);
  const previous=await tx.queryOne(`SELECT * FROM capture_tasks WHERE tenant_id=$1
    AND metadata->>'workflow'=$2 AND metadata->>'createRequestId'=$3`,[tenantId,WORKFLOW,requestId]);
  if (previous) {
    if (previous.metadata.createRequestHash !== hash) fail('CREATE_REQUEST_CONFLICT');
    return previous.id;
  }
  const agent=await lockAgent(tx,tenantId,input.agentId);
  const taskId=randomUUID();
  const metadata={workflow:WORKFLOW,agentKind:'android_mobile',deviceId:agent.capabilities.deviceId,
    filters:input.filters,budgets:input.budgets,keywords:input.keywords,deadlineAt:null,
    createRequestId:requestId,createRequestHash:hash};
  await tx.execute(`INSERT INTO capture_tasks(id,tenant_id,origin_agent_id,assigned_agent_id,task_type,feature_key,
    title,platform,source,trigger_type,status,metadata) VALUES($1,$2,$3,$3,'capture','douyin_mobile_discovery',
    $4,'douyin','android_runner','manual','pending',$5)`,[taskId,tenantId,agent.id,input.title,metadata]);
  for (const [ordinal,keyword] of input.keywords.entries()) await tx.execute(`INSERT INTO capture_task_items
    (tenant_id,task_id,item_key,platform,item_type,keyword,ordinal,assigned_agent_id,execution_task_id,metadata)
    VALUES($1,$2,$3,'douyin','keyword',$4,$5,$6,$2,$7)`,[tenantId,taskId,`keyword:${ordinal}`,keyword,ordinal,agent.id,{deviceHeld:false}]);
  return taskId;
}
export async function controlRun(tx,tenantId,taskId,action,body={}) {
  const preliminary=await tx.queryOne(`SELECT assigned_agent_id FROM capture_tasks WHERE id=$1 AND tenant_id=$2`,[taskId,tenantId]);
  if (!preliminary) fail('MOBILE_RUN_NOT_FOUND',404);
  await lockAgent(tx,tenantId,preliminary.assigned_agent_id);
  const task=await taskRow(tx,tenantId,taskId);
  const items=await tx.queryAll('SELECT * FROM capture_task_items WHERE task_id=$1 FOR UPDATE',[taskId]);
  if (action==='stop') {
    const scope=body.scope ?? 'discovery';
    if (!['discovery','batch'].includes(scope)) fail('INVALID_STOP_SCOPE',400);
    const metadata={...task.metadata,stopRequested:true,stopScope:task.metadata.stopScope==='batch'?'batch':scope,stopRequestedAt:new Date().toISOString()};
    await tx.execute('UPDATE capture_tasks SET metadata=$2,updated_at=now() WHERE id=$1',[taskId,metadata]);
    await tx.execute(`UPDATE capture_task_items SET status='canceled',updated_at=now(),finished_at=now()
      WHERE task_id=$1 AND metadata->>'deviceHeld' IS DISTINCT FROM 'true'
      AND status NOT IN ('completed','completed_with_warnings','canceled','skipped')`,[taskId]);
    if (scope==='batch') await cancelDiscoveryDemands(tx,{tenantId,runId:taskId});
  } else {
    const blockedBy=resumeError(task,items);
    if (blockedBy) fail(blockedBy);
    await tx.execute(`UPDATE capture_task_items SET status='retryable',metadata=metadata||'{"resumeAuthorized":true}'::jsonb,
      updated_at=now() WHERE task_id=$1 AND status IN ('needs_action','failed')`,[taskId]);
  }
  await rollup(tx,tenantId,taskId);
  return taskId;
}
