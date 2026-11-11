import {randomUUID} from 'node:crypto';
import {digest,fail,id,identity,LEASE_MS,text} from './validation.js';
import {refreshOrchestrationParent,refreshOrchestrationParentById} from './parent-refresh.js';
import {claimPhonePatrolItem} from './patrol.js';
import {FORWARD_ITEM_TYPE,forwardTarget,WECHAT_FORWARD_FEATURE} from './forward.js';
import {heldItem,lockAgent,parentStopRequested,rollup,saveItemMetadata,taskRow} from './repository.js';
import {MOBILE_PLATFORMS,mobileCommentPlan,mobilePlanBlockReason,mobilePlatformForWorkflow,mobileRelevancePrefilterEnabled,
  mobileTaskBudgets,mobileTaskFilters,mobileWorkflowFor,trimMobilePlanSnapshot,WECHAT_SEARCH_FILTERS_FEATURE,WECHAT_ARTICLE_FEATURE,isWechatMobilePlatform} from './mobile-tasks.js';

// A phone attempt budget per work item (mirrors the browser elastic pool's
// bounded attempts). Manual-action safety endings fence the item for this phone.
export const MOBILE_ELASTIC_ATTEMPT_LIMIT = 3;
const MOBILE_SAFETY_ERROR_CODES = [
  'CAPTCHA_REQUIRED', 'LOGIN_REQUIRED', 'ACCOUNT_SECURITY_BLOCK',
  'PLATFORM_SAFETY_BLOCK', 'SECURITY_CHECK', 'SECURITY_BLOCKED',
];
const TERMINAL_EXECUTION_STATUSES = [
  'completed', 'completed_with_warnings', 'completed_with_failures',
  'failed', 'canceled', 'skipped', 'superseded', 'needs_action', 'interrupted',
];

// run id = execution_task_id (the child/standalone task); parent = item.task_id.
export function taskIdentity(item,attemptId=item.metadata.attemptId) {
  const runId=item.execution_task_id;
  return {discoveryRunId:runId,taskId:runId,itemId:item.id,attemptId,
    assignmentRevision:item.assignment_revision,requestHash:item.request_hash,agentId:item.assigned_agent_id};
}
// metadata is the child (execution) task's; its trimmed plan snapshot carries the
// plan's capture switches, so a held re-poll reports the same flag as the claim.
export function taskPayload(item,metadata) {
  const platform=mobilePlatformForWorkflow(metadata.workflow);
  // A Channels patrol searches the start of the post's caption; its item itself has no keyword.
  return {identity:taskIdentity(item),deviceId:metadata.deviceId,keyword:metadata.mode==='patrol' ? metadata.searchQuery : item.keyword,
    filters:metadata.filters,budgets:metadata.budgets,deadlineAt:metadata.deadlineAt,
    resumeAuthorized:item.metadata.resumeAuthorized===true,
    relevancePrefilter:{enabled:mobileRelevancePrefilterEnabled(metadata.planSnapshot)},
    // 0.4.0: the platform tells the Runner which app runs the task; WeChat Channels carries its comment plan.
    platform,
    ...(isWechatMobilePlatform(platform) ? {mode:['patrol','forward'].includes(metadata.mode) ? metadata.mode : 'keyword',
      comments:metadata.comments || mobileCommentPlan(metadata.planSnapshot),
      ...(metadata.mode==='patrol' ? {patrolTarget:metadata.patrolTarget} : {}),
      ...(metadata.mode==='forward' ? {forwardTarget:metadata.forwardTarget} : {})} : {})};
}
function permit(item,metadata,now) {
  return {...taskIdentity(item),leaseId:item.metadata.leaseId,serverTime:new Date(now).toISOString(),
    leaseUntil:new Date(Math.min(now+LEASE_MS,Date.parse(metadata.deadlineAt))).toISOString()};
}
function control(item,metadata,parentMetadata,sessionId,now) {
  const reason=metadata.stopRequested||parentStopRequested(parentMetadata)?'remote_stop'
    :Date.parse(metadata.deadlineAt)<=now?'deadline_expired'
      :item.metadata.sessionId!==sessionId?'runner_session_changed'
        :Date.parse(item.metadata.leaseUntil)<=now?'lease_expired':item.metadata.completion?'device_closure_required':'';
  return reason ? {stopRequested:true,blocked:true,reason,identity:taskIdentity(item)} : null;
}
function boundProbe(probe) {
  if (!probe || typeof probe!=='object' || Array.isArray(probe)) return null;
  const fg=probe.foreground && typeof probe.foreground==='object' && !Array.isArray(probe.foreground) ? probe.foreground : {};
  return {foreground:{package:text2(fg.package,120),activity:text2(fg.activity,160),launched:fg.launched===true},
    checkedAt:text2(probe.checkedAt,40)};
}
function text2(value,max) {
  return typeof value==='string' ? value.slice(0,max) : '';
}
async function persistHeartbeat(tx,agent,ready,reason,probe,platforms,features=[]) {
  // runnerFeatures is what the admin reads to tell a phone that can apply 视频号 时长 / 范围 from an older one.
  const merge={readyForSearch:ready,readyPlatforms:platforms,runnerFeatures:features};
  // The apps this phone has run ready (union): plan checks read supportedPlatforms, so a phone that gained WeChat
  // becomes selectable for 视频号 plans after its first poll with the new Runner.
  const supported=[...new Set([...(Array.isArray(agent.capabilities?.supportedPlatforms)?agent.capabilities.supportedPlatforms:['douyin']),...platforms])]
    .filter(platform=>MOBILE_PLATFORMS.includes(platform));
  merge.supportedPlatforms=supported;
  if (reason) merge.deviceReason=reason; else merge.deviceReason='';
  const bounded=boundProbe(probe);
  if (bounded) {merge.deviceProbe=bounded; merge.deviceProbeAt=bounded.checkedAt || new Date().toISOString();}
  await tx.execute(`UPDATE capture_agents SET last_liveness_at=now(),last_full_heartbeat_at=now(),last_heartbeat_at=now(),
    capabilities=capabilities||$2::jsonb WHERE id=$1 AND (last_liveness_at IS NULL OR last_liveness_at < now()-interval '25 seconds'
    OR capabilities->>'readyForSearch' IS DISTINCT FROM $3 OR capabilities->>'deviceReason' IS DISTINCT FROM $4
    OR capabilities->'readyPlatforms' IS DISTINCT FROM $5::jsonb OR capabilities->'supportedPlatforms' IS DISTINCT FROM $6::jsonb
    OR capabilities->'runnerFeatures' IS DISTINCT FROM $7::jsonb)`,
  [agent.id,merge,String(ready),String(merge.deviceReason||''),JSON.stringify(platforms),JSON.stringify(supported),JSON.stringify(features)]);
}
async function findAssignedCandidate(tx,tenantId,agentId,workflows) {
  return tx.queryOne(`SELECT item.* FROM capture_task_items item
    JOIN capture_tasks child ON child.id=item.execution_task_id AND child.tenant_id=item.tenant_id
      AND child.metadata->>'workflow'=ANY($3::text[])
    LEFT JOIN capture_tasks parent ON parent.id=item.task_id AND parent.tenant_id=item.tenant_id
      AND parent.id<>item.execution_task_id
    WHERE item.tenant_id=$1 AND item.assigned_agent_id=$2
      AND child.metadata->>'stopRequested' IS DISTINCT FROM 'true'
      AND child.status IN ('pending','running')
      AND COALESCE(child.metadata->>'distributionMode','') <> 'elastic_pool'
      AND item.status IN ('pending','retryable')
      AND (parent.id IS NULL OR (
        parent.metadata->>'stopRequested' IS DISTINCT FROM 'true'
        AND parent.metadata->>'operatorStopped' IS DISTINCT FROM 'true'
        AND parent.metadata->>'stopPending' IS DISTINCT FROM 'true'
        AND COALESCE(parent.metadata->>'stopCommandId','')=''))
    ORDER BY child.created_at, item.ordinal LIMIT 1 FOR UPDATE OF item SKIP LOCKED`,[tenantId,agentId,workflows]);
}
// One keyword that runs out of attempts turns the run needs_action; its other keywords stay claimable,
// as in the browser elastic dispatch. Retries go to the fewest attempts first, so one failing keyword
// cannot use up all of its retries while the others wait behind it.
async function claimElasticItem(tx,principal,agent,now,platforms,wechatFilters=false,wechatForward=false) {
  const candidates=await tx.queryAll(`SELECT item.* FROM capture_task_items item
    JOIN capture_tasks parent ON parent.id=item.task_id AND parent.tenant_id=item.tenant_id
    WHERE item.tenant_id=$1
      AND parent.task_type='capture_orchestration'
      AND parent.status IN ('pending','running','needs_action')
      AND parent.platform=ANY($6::text[])
      AND COALESCE(parent.metadata->>'distributionMode','')='elastic_pool'
      AND parent.metadata->>'stopRequested' IS DISTINCT FROM 'true'
      AND parent.metadata->>'operatorStopped' IS DISTINCT FROM 'true'
      AND parent.metadata->>'stopPending' IS DISTINCT FROM 'true'
      AND COALESCE(parent.metadata->>'stopCommandId','')=''
      AND COALESCE(parent.metadata->>'orchestrationTemplate','false') <> 'true'
      AND (item.item_type='keyword' OR (parent.platform IN ('wechat_channels','wechat_articles') AND item.item_type IN ('negative_post','wechat_forward')))
      -- 「发到微信」 goes only to a Runner that can forward (0.4.6) and is tried once: a second try could send twice.
      AND (item.item_type<>'wechat_forward' OR (parent.platform='wechat_channels' AND $8::boolean AND item.attempt_count=0))
      AND item.platform=parent.platform
      AND item.status IN ('pending','retryable')
      AND item.attempt_count < $3
      AND (item.metadata->>'pinnedAgentId'=$2::text
        OR (COALESCE(item.metadata->>'pinnedAgentId','')=''
          AND parent.metadata @> jsonb_build_object('eligibleAgentIds', jsonb_build_array($2::text))))
      AND (item.execution_task_id IS NULL OR EXISTS (SELECT 1 FROM capture_tasks prev
        WHERE prev.id=item.execution_task_id AND prev.tenant_id=item.tenant_id AND prev.status=ANY($4::text[])))
      AND NOT EXISTS (SELECT 1 FROM capture_agent_commands cmd WHERE cmd.tenant_id=item.tenant_id
        AND cmd.task_id=item.execution_task_id AND cmd.status IN ('pending','acknowledged'))
      AND NOT EXISTS (SELECT 1 FROM capture_task_item_attempts sa WHERE sa.tenant_id=item.tenant_id
        AND sa.item_id=item.id AND sa.agent_id=$2::uuid
        AND (UPPER(COALESCE(sa.error->>'code',''))=ANY($5::text[])
          OR COALESCE(sa.error->>'requiresManualAction',sa.error->>'securityBlocked','false')='true'))
      AND COALESCE(jsonb_array_length(parent.metadata->'planSnapshot'->'searchPasses'),0) <= 1
      AND (parent.platform IN ('wechat_channels','wechat_articles') OR (
        COALESCE(parent.metadata->'planSnapshot'->'negativePatrol'->>'enabled','false') <> 'true'
        AND COALESCE(parent.metadata->'planSnapshot'->'searchFilters'->>'publishTime','all') <> 'month'))
      -- A 视频号 keyword with the App's 时长 / 范围 choices only goes to a Runner that applies them (0.4.5).
      AND ($7::boolean OR parent.platform<>'wechat_channels' OR item.item_type<>'keyword' OR (
        COALESCE(parent.metadata->'planSnapshot'->'searchFilters'->>'videoDuration','all') NOT IN ('under_5m','5_20m','over_20m')
        AND COALESCE(parent.metadata->'planSnapshot'->'searchFilters'->>'searchScope','all') NOT IN ('followed','viewed')))
    ORDER BY CASE WHEN item.item_type='wechat_forward' THEN 0 ELSE 1 END, CASE WHEN item.status='pending' THEN 0 ELSE 1 END,
      parent.created_at, item.attempt_count, item.ordinal, item.id
    FOR UPDATE OF item SKIP LOCKED LIMIT 20`,
  [principal.tenantId,agent.id,MOBILE_ELASTIC_ATTEMPT_LIMIT,TERMINAL_EXECUTION_STATUSES,MOBILE_SAFETY_ERROR_CODES,platforms,wechatFilters,wechatForward]);
  for (const item of candidates) {
    // Shared patrol eligibility may upsert rotation state before discovering a
    // cooldown/lease. A temporary refusal must leave that candidate unchanged.
    await tx.execute('SAVEPOINT android_elastic_candidate');
    try {
      const claimed=await claimElasticCandidate(tx,principal,agent,item);
      if (!claimed) await tx.execute('ROLLBACK TO SAVEPOINT android_elastic_candidate');
      await tx.execute('RELEASE SAVEPOINT android_elastic_candidate');
      if (claimed?.item) return claimed;
      // Permanent failed/skipped items have already projected their parent.
    } catch (error) {
      try {
        await tx.execute('ROLLBACK TO SAVEPOINT android_elastic_candidate');
        await tx.execute('RELEASE SAVEPOINT android_elastic_candidate');
      } catch {}
      throw error;
    }
  }
  return null;
}
async function claimElasticCandidate(tx,principal,agent,item) {
  const parent=await tx.queryOne('SELECT * FROM capture_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[item.task_id,principal.tenantId]);
  if (!parent || !['pending','running','needs_action'].includes(parent.status) || parentStopRequested(parent.metadata)) return null;
  const planSnapshot=parent.metadata?.planSnapshot || {};
  if (mobilePlanBlockReason(planSnapshot,parent.platform)) return null;
  const childId=randomUUID(), revision=item.assignment_revision+1;
  // A Channels negative post: lease it in the shared rotation state first (same rules as browser patrol).
  const patrolClaim=item.item_type==='negative_post'
    ? await claimPhonePatrolItem(tx,{tenantId:principal.tenantId,parent,item,childId,revision}) : null;
  if (patrolClaim?.status==='blocked') return null;
  if (patrolClaim?.status==='skipped') {
    await refreshOrchestrationParentById(tx,principal.tenantId,parent.id,agent.id);
    return {settled:true};
  }
  const patrol=patrolClaim?.metadata || null;
  // 「发到微信」: the post and the contact; a post whose link is gone fails at once instead of waiting.
  const forward=item.item_type===FORWARD_ITEM_TYPE ? await forwardTarget(tx,principal.tenantId,item) : null;
  if (item.item_type===FORWARD_ITEM_TYPE && !forward) {
    await tx.execute(`UPDATE capture_task_items SET status='failed',finished_at=now(),updated_at=now(),
      error=jsonb_build_object('code','RECORD_SHARE_LINK_MISSING') WHERE id=$1`,[item.id]);
    await refreshOrchestrationParentById(tx,principal.tenantId,parent.id,agent.id);
    return {settled:true};
  }
  const keywords=patrol ? [patrol.searchQuery] : [item.keyword];
  const workflow=mobileWorkflowFor(parent.platform);
  const childMetadata={workflow,agentKind:'android_mobile',deviceId:agent.capabilities.deviceId,
    filters:patrol || forward ? {sort:'all',publishWindowHours:null} : mobileTaskFilters(planSnapshot.searchFilters,parent.platform),
    budgets:mobileTaskBudgets(planSnapshot,1),
    ...(isWechatMobilePlatform(parent.platform) ? {comments:forward ? {enabled:false,limit:0} : mobileCommentPlan(planSnapshot)} : {}),
    ...(patrol || {}),
    ...(forward ? {mode:'forward',forwardTarget:forward} : {}),
    keywords,deadlineAt:null,planSnapshot:trimMobilePlanSnapshot(planSnapshot,keywords),
    orchestrationChild:true,parentTaskId:parent.id,orchestrationRevision:revision,
    distributionMode:'elastic_pool',claimUnit:'keyword',
    scheduleId:parent.orchestration_schedule_id||undefined,scheduledFor:parent.scheduled_for||undefined};
  await tx.execute(`INSERT INTO capture_tasks(id,tenant_id,parent_task_id,origin_agent_id,assigned_agent_id,
    client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,
    orchestration_revision,orchestration_schedule_id,scheduled_for,schedule_revision,source_updated_at)
    VALUES($1::uuid,$2,$3,$4,$4,$1::uuid::text,$13,$5,$6,$12,'android_runner','cloud','pending',$7,
    $8,$9,$10,$11,now())`,
  // A patrol child is a negative_post_patrol task, as the formal patrol success rules expect.
  [childId,principal.tenantId,parent.id,agent.id,workflow,`${parent.title} · ${String(patrol ? `巡查 ${patrol.searchQuery}` : item.keyword).slice(0,80)}`,childMetadata,
    revision,parent.orchestration_schedule_id||null,parent.scheduled_for||null,parent.schedule_revision||null,parent.platform,
    patrol ? 'negative_post_patrol' : forward ? 'wechat_forward' : 'capture']);
  if (item.execution_task_id && item.execution_task_id!==childId) {
    await tx.execute(`UPDATE capture_tasks SET status='superseded',metadata=metadata||jsonb_build_object(
      'handoffSuccessorTaskId',$1::uuid::text,'handoffReason','android_elastic_claimed','handoffAt',now()::text,
      'terminalDisposition','superseded','terminalReason','android_elastic_claimed'),
      finished_at=COALESCE(finished_at,now()),updated_at=now()
      WHERE id=$2 AND tenant_id=$3 AND status=ANY($4::text[])`,
    [childId,item.execution_task_id,principal.tenantId,TERMINAL_EXECUTION_STATUSES]);
  }
  const bound=await tx.queryOne(`UPDATE capture_task_items SET execution_task_id=$2,assigned_agent_id=$3,updated_at=now()
    WHERE id=$1 RETURNING *`,[item.id,childId,agent.id]);
  const child=await taskRow(tx,principal.tenantId,childId);
  return {item:bound,child};
}
// A claim starts a new handoff, as the browser elastic claim does: drop the previous
// wait anchors so the browser round-relax clock restarts when this attempt releases
// the item (docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md, F1).
function withoutHandoffAnchors(metadata) {
  const {elasticRetryWaitingSince:_waiting,...rest}=metadata || {};
  if (rest.checkpoint && typeof rest.checkpoint==='object' && 'recovery' in rest.checkpoint) {
    const {recovery:_recovery,...checkpoint}=rest.checkpoint;
    rest.checkpoint=checkpoint;
  }
  return rest;
}
async function claimBoundItem(tx,principal,agent,child,item,sessionId,now) {
  if (!child.metadata.deadlineAt) {
    child.metadata.deadlineAt=new Date(now+Number(child.metadata.budgets?.batchMs||0)).toISOString();
    await tx.execute('UPDATE capture_tasks SET metadata=$2,started_at=COALESCE(started_at,now()) WHERE id=$1',[child.id,child.metadata]);
  }
  if (Date.parse(child.metadata.deadlineAt)<=now) {
    await tx.execute(`UPDATE capture_task_items SET status='needs_action',error='{"code":"deadline_expired"}'::jsonb,
      finished_at=now(),updated_at=now() WHERE id=$1 AND status IN ('pending','retryable')`,[item.id]);
    await rollup(tx,principal.tenantId,child.id);
    await refreshOrchestrationParent(tx,principal.tenantId,child,agent.id);
    return {task:null,permit:null,control:{reason:'deadline_expired'}};
  }
  const lastAttempt=await tx.queryOne(`SELECT agent_id FROM capture_task_item_attempts
    WHERE tenant_id=$1 AND item_id=$2 ORDER BY attempt_number DESC,created_at DESC,id DESC LIMIT 1`,[principal.tenantId,item.id]);
  const resumeAuthorized=item.metadata.resumeAuthorized===true
    || (item.status==='retryable' && lastAttempt?.agent_id===agent.id);
  const attemptId=randomUUID(), revision=item.assignment_revision+1;
  const platform=mobilePlatformForWorkflow(child.metadata.workflow);
  const wechat=isWechatMobilePlatform(platform);
  // Douyin keeps its original request hash; a Channels attempt also binds its platform and comment plan.
  const hash=digest({taskId:child.id,itemId:item.id,keyword:item.keyword,filters:child.metadata.filters,budgets:child.metadata.budgets,revision,
    ...(wechat ? {platform,comments:child.metadata.comments || null} : {})});
  const metadata={...withoutHandoffAnchors(item.metadata),attemptId,deviceHeld:true,sessionId,leaseId:randomUUID(),completion:null,
    reason:'',closure:null,deviceClosedAt:null,resumeAuthorized,
    leaseUntil:new Date(Math.min(now+LEASE_MS,Date.parse(child.metadata.deadlineAt))).toISOString()};
  const updated=await tx.queryOne(`UPDATE capture_task_items SET assignment_revision=$2,attempt_count=attempt_count+1,
    request_hash=$3,status='running',metadata=$4,error='{}'::jsonb,finished_at=NULL,started_at=now(),updated_at=now()
    WHERE id=$1 RETURNING *`,[item.id,revision,hash,metadata]);
  await tx.execute(`INSERT INTO capture_task_item_attempts(id,tenant_id,item_id,parent_task_id,execution_task_id,agent_id,
    attempt_number,assignment_revision,status,request_hash,checkpoint,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,now())`,
  [attemptId,principal.tenantId,updated.id,updated.task_id,child.id,agent.id,updated.attempt_count,revision,hash,{sessionId,leaseId:metadata.leaseId}]);
  await tx.execute(`UPDATE capture_tasks SET status='running',heartbeat_at=now(),updated_at=now() WHERE id=$1`,[child.id]);
  await refreshOrchestrationParent(tx,principal.tenantId,child,agent.id);
  return {task:taskPayload(updated,child.metadata),permit:permit(updated,child.metadata,now),control:{}};
}
// The apps the Runner reports ready on this poll, limited to the phone's allowed platforms. A Runner before 0.4.0
// sends no list: when ready, it is a Douyin phone.
/** The optional abilities a Runner names in its poll (0.4.5+); unknown names are dropped. */
export function runnerFeatures(body) {
  const known=[WECHAT_SEARCH_FILTERS_FEATURE,WECHAT_FORWARD_FEATURE,WECHAT_ARTICLE_FEATURE];
  return Array.isArray(body?.features) ? [...new Set(body.features.filter(name=>known.includes(name)))] : [];
}
export function readyPlatforms(body,agent,ready) {
  if (!ready) return [];
  const allowed=Array.isArray(agent.allowed_platforms) && agent.allowed_platforms.length ? agent.allowed_platforms : ['douyin'];
  const reported=Array.isArray(body.platforms) ? body.platforms.filter(p=>typeof p==='string') : ['douyin'];
  return MOBILE_PLATFORMS.filter(platform=>reported.includes(platform) && allowed.includes(platform)
    && (platform !== 'wechat_articles' || runnerFeatures(body).includes(WECHAT_ARTICLE_FEATURE)));
}
export async function poll(tx,principal,body,now=Date.now()) {
  const sessionId=id(body.sessionId,'SESSION_ID');
  const agent=await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  if (text(body.deviceId,'DEVICE_ID',120)!==agent.capabilities.deviceId) fail('DEVICE_ID_MISMATCH',403);
  const ready=body.readyForSearch===true;
  const platforms=readyPlatforms(body,agent,ready);
  const features=runnerFeatures(body);
  await persistHeartbeat(tx,agent,ready,text2(body.reason,120),body.probe,platforms,features);
  const held=await heldItem(tx,principal.tenantId,agent.id);
  if (held) {
    const stopped=control(held,held.task_metadata,held.parent_metadata,sessionId,now);
    if (stopped) return {task:null,permit:null,control:stopped};
    if (mobilePlatformForWorkflow(held.task_metadata.workflow) === 'wechat_articles' && !features.includes(WECHAT_ARTICLE_FEATURE)) {
      return {task:null,permit:null,control:{stopRequested:true,blocked:true,reason:'article_capability_missing',identity:taskIdentity(held)}};
    }
    return {task:taskPayload(held,held.task_metadata),
      permit:{...permit(held,held.task_metadata,now),leaseUntil:held.metadata.leaseUntil},control:{}};
  }
  if (!ready || !platforms.length) return {task:null,permit:null,control:{reason:'device_not_ready'}};
  let item=await findAssignedCandidate(tx,principal.tenantId,agent.id,platforms.map(mobileWorkflowFor));
  let child;
  if (item) {
    child=await taskRow(tx,principal.tenantId,item.execution_task_id);
  } else {
    const claimed=await claimElasticItem(tx,principal,agent,now,platforms,features.includes(WECHAT_SEARCH_FILTERS_FEATURE),
      features.includes(WECHAT_FORWARD_FEATURE));
    if (!claimed) return {task:null,permit:null,control:{}};
    item=claimed.item; child=claimed.child;
  }
  return claimBoundItem(tx,principal,agent,child,item,sessionId,now);
}
export async function currentAttempt(tx,principal,input) {
  const ident=identity(input);
  if (ident.agentId!==principal.agentId) fail('AGENT_ID_MISMATCH',403);
  await lockAgent(tx,principal.tenantId,principal.agentId,principal);
  const task=await taskRow(tx,principal.tenantId,ident.taskId);
  const item=await tx.queryOne(`SELECT * FROM capture_task_items WHERE tenant_id=$1 AND id=$2 AND execution_task_id=$3 FOR UPDATE`,
    [principal.tenantId,ident.itemId,task.id]);
  if (!item) fail('ATTEMPT_LINEAGE_MISMATCH',403);
  const attempt=await tx.queryOne(`SELECT * FROM capture_task_item_attempts WHERE tenant_id=$1 AND id=$2 AND item_id=$3
    AND execution_task_id=$4 AND parent_task_id=$5 AND agent_id=$6 AND assignment_revision=$7 AND request_hash=$8 FOR UPDATE`,
  [principal.tenantId,ident.attemptId,ident.itemId,task.id,item.task_id,ident.agentId,ident.assignmentRevision,ident.requestHash]);
  if (!attempt) fail('ATTEMPT_LINEAGE_MISMATCH',403);
  return {ident,task,item,attempt,current:item.metadata.attemptId===attempt.id && item.assignment_revision===ident.assignmentRevision};
}
export async function renew(tx,principal,body,now=Date.now()) {
  const {task,item,current}=await currentAttempt(tx,principal,body.identity);
  if (!current || body.leaseId!==item.metadata.leaseId) fail('STALE_ATTEMPT');
  const parentMetadata=task.metadata?.orchestrationChild && task.parent_task_id
    ? (await tx.queryOne('SELECT metadata FROM capture_tasks WHERE id=$1 AND tenant_id=$2',[task.parent_task_id,principal.tenantId]))?.metadata
    : null;
  const stopped=control(item,task.metadata,parentMetadata,id(body.sessionId,'SESSION_ID'),now);
  if (stopped || !item.metadata.deviceHeld) return {permit:null,control:stopped || {stopRequested:true,reason:'attempt_closed'}};
  const granted=permit(item,task.metadata,now);
  await saveItemMetadata(tx,item,{...item.metadata,leaseUntil:granted.leaseUntil});
  await tx.execute('UPDATE capture_agents SET last_liveness_at=now() WHERE id=$1',[principal.agentId]);
  return {permit:granted,control:{}};
}
