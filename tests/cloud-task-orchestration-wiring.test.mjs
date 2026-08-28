import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('accepted child snapshots project keyword checkpoints to their exact parent items', async () => {
  const route = await read('server/routes/capture-cloud.js');
  const projectStart = route.indexOf('async function projectOrchestrationSnapshot');
  const mirrorStart = route.indexOf('async function mirrorTaskSnapshot');
  assert.ok(projectStart >= 0);
  assert.ok(mirrorStart > projectStart);
  const projection = route.slice(projectStart, mirrorStart);

  assert.match(projection, /checkpointEntryToItemStatus\(entry\)/u);
  assert.match(projection, /task\.parent_task_id/u);
  assert.match(projection, /execution_task_id = \$8/u);
  assert.match(projection, /assigned_agent_id = \$9/u);
  assert.match(projection, /keyword = \$10/u);
  assert.match(projection, /capture_task_item_attempts/u);
  assert.match(projection, /entry\.errorCode \|\| entry\.error_code/u);
  assert.match(projection, /requiresManualAction/u);
  assert.match(projection, /refreshOrchestrationParentTask/u);
  assert.match(
    projection,
    /\['canceled', 'superseded'\]\.includes\(parent\.status\)/u,
  );
  assert.match(route, /'orchestrationChild', capture_tasks\.metadata->'orchestrationChild'/u);
  assert.match(route, /'parentTaskId', capture_tasks\.metadata->'parentTaskId'/u);

  const acceptedProjectionStart = route.indexOf(
    'const projectedNegativePatrolTask',
    mirrorStart,
  );
  assert.ok(acceptedProjectionStart >= 0);
  assert.match(
    route.slice(acceptedProjectionStart, acceptedProjectionStart + 800),
    /projectOrchestrationSnapshot\(tx, agent, task, snapshot\)/u,
  );
});

test('a device-side retry is adopted by the original orchestration parent', async () => {
  const [route, agent] = await Promise.all([
    read('server/routes/capture-cloud.js'),
    read('utils/cloud-task-agent.js'),
  ]);
  const adoptionStart = route.indexOf('async function adoptLocalOrchestrationRecovery');
  const adoptionEnd = route.indexOf('async function refreshOrchestrationParentTask', adoptionStart);
  assert.ok(adoptionStart >= 0 && adoptionEnd > adoptionStart);
  const adoption = route.slice(adoptionStart, adoptionEnd);
  assert.match(adoption, /snapshotMetadata\.parentRequestId/u);
  assert.match(adoption, /snapshotMetadata\.cloudAssigned !== true/u);
  assert.match(adoption, /sourceTask\.parent_task_id/u);
  assert.match(adoption, /status IN \('retryable', 'needs_action', 'failed'\)/u);
  assert.match(adoption, /parent_task_id = \$1/u);
  assert.match(adoption, /attempt_count = attempt_count \+ 1/u);
  assert.match(adoption, /INSERT INTO capture_task_item_attempts/u);
  assert.match(adoption, /orchestration_local_recovery_adopted/u);
  assert.match(
    adoption,
    /\['canceled', 'superseded'\]\.includes\(parent\.status\)/u,
  );
  assert.match(
    route,
    /task = await adoptLocalOrchestrationRecovery\(tx, agent, task, snapshot, \{\s*supportsLocalClosureReuseFenceV1,\s*\}\)/u,
  );
  assert.match(agent, /remoteOrchestrationRecoveryMergeV1: true/u);
});

test('device recovery accepts the local client task id recorded by resume completion', async () => {
  const {orchestrationRecoverySuccessorMatches} = await import(
    `../server/routes/capture-cloud.js?recovery-identity=${Date.now()}`
  );
  const recoveryTask = {
    id: 'ffa0bef6-2930-459c-a357-2e00166cd314',
    client_task_id: '20163c79-0a97-46e2-a1c3-68d480ea61d2',
  };
  const lineageTasks = [{
    id: '2384ca54-bb53-4596-94b8-869e89962f4d',
    client_task_id: '2384ca54-bb53-4596-94b8-869e89962f4d',
  }];

  assert.equal(orchestrationRecoverySuccessorMatches({
    recordedSuccessorId: recoveryTask.client_task_id,
    recoveryTask,
    lineageTasks,
  }), true);
  assert.equal(orchestrationRecoverySuccessorMatches({
    recordedSuccessorId: recoveryTask.id,
    recoveryTask,
    lineageTasks,
  }), true);
  assert.equal(orchestrationRecoverySuccessorMatches({
    recordedSuccessorId: '99999999-9999-4999-8999-999999999999',
    recoveryTask,
    lineageTasks,
  }), false);
});

test('schedule status follows its latest run before and after terminal settlement', async () => {
  const route = await read('server/routes/capture-cloud.js');
  const refreshStart = route.indexOf('async function refreshOrchestrationParentTask');
  const refreshEnd = route.indexOf(
    'async function projectNegativePatrolSnapshot',
    refreshStart,
  );
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  const refresh = route.slice(refreshStart, refreshEnd);
  assert.match(
    refresh,
    /\['canceled', 'superseded'\]\.includes\(parent\.status\)/u,
  );
  assert.match(refresh, /last_run_status = \$2/u);
  assert.match(refresh, /scheduled_run_needs_action/u);
  assert.match(refresh, /orchestration_schedule_run_status_updated/u);
  assert.match(refresh, /WHEN \$7::boolean THEN COALESCE\(\$1::timestamptz, now\(\)\)/u);
  assert.doesNotMatch(
    refresh,
    /updated &&\s*aggregate\.terminal &&\s*parent\.status !== updated\.status/u,
  );
});

test('overview returns parent business tasks without exposing orchestration child jobs', async () => {
  const route = await read('server/routes/capture-cloud.js');
  const overviewStart = route.indexOf("router.get('/overview'");
  const overviewEnd = route.indexOf("router.patch('/agents/:id'", overviewStart);
  const overview = route.slice(overviewStart, overviewEnd);

  assert.match(overview, /AND t\.parent_task_id IS NULL/u);
  assert.match(
    overview,
    /task\.task_type !== 'capture_orchestration'[\s\S]*\? 'waiting_device'/u,
  );
});

test('production task center exposes real multi-Agent compose and detail flows', async () => {
  const [dispatchPage, taskCard, plansView, taskLib, composer, detail, sidebar] = await Promise.all([
    read('web/admin/src/pages/dispatch/DispatchPage.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/PlansView.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/lib.ts'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx'),
    read('sidebar/sidebar-logic.js'),
  ]);
  const page = [dispatchPage, taskCard, plansView, taskLib].join('\n');

  assert.match(page, /OrchestrationComposerDrawer/u);
  assert.match(page, /OrchestrationDetailWorkspace/u);
  assert.match(page, /多 Agent 编排/u);
  assert.match(page, /task\.parent_task_id \|\| task\.metadata\?\.orchestrationChild === true/u);
  assert.match(page, /task\.task_type === 'capture_orchestration'/u);
  assert.match(page, /查看编排/u);

  const createIndex = composer.indexOf("api.post<CreateResponse>('/capture-cloud/orchestrations'");
  const previewIndex = composer.indexOf('/allocation-preview', createIndex);
  const dispatchIndex = composer.indexOf('/dispatch', previewIndex);
  assert.ok(createIndex >= 0 && previewIndex > createIndex && dispatchIndex > previewIndex);
  assert.match(composer, /expectedRevision: preview\.revision/u);
  assert.match(composer, /assignments: assignments\.map/u);
  assert.match(composer, /\{ timeoutMs: 30_000 \}/u);
  assert.match(composer, /当前队列预览已失效/u);
  assert.match(composer, /正在创建云端工作队列/u);
  assert.match(composer, /<footer[\s\S]*aria-live="polite"[\s\S]*role="alert"[\s\S]*确认并创建队列/u);
  assert.match(composer, /'执行一次'/u);
  assert.match(composer, /'无人值守'/u);
  assert.match(composer, /platform,\s*\n\s*executionMode,/u);
  assert.match(composer, /maxRounds:\s*1/u);
  assert.match(composer, /roundGapMin:\s*10/u);
  assert.match(composer, /schedule:\s*\{/u);
  assert.match(composer, /'确认并启用计划'/u);
  assert.match(composer, /'确认并创建队列'/u);
  assert.match(composer, /不会覆盖设备 Extension 里已有的本地无人值守计划/u);
  assert.match(composer, /每个节点一次只领取一个/u);
  assert.match(composer, /1–300 个关键词/u);
  assert.match(composer, /editingPlan/u);
  assert.match(composer, /api\.patch<OrchestrationScheduleUpdateResult>/u);
  assert.match(composer, /expectedRevision: preview\.revision/u);
  assert.match(composer, /保存修改/u);
  assert.match(composer, /只影响下一次及之后生成的批次/u);
  assert.match(composer, /计划 ID、运行次数和历史记录全部保留/u);
  assert.match(composer, /'fixed_batch' as const/u);
  assert.match(composer, /'elastic_pool' as const/u);
  assert.match(composer, /巡检类型（受限组合）/u);
  assert.match(composer, /只允许 5 种路径/u);
  assert.match(composer, /每个关键词最多两次搜索/u);
  assert.match(composer, /图文与视频不能互相组合/u);
  assert.match(composer, /发布时间等其它筛选仍保持单选/u);
  assert.match(composer, /remoteSequentialSearchPassesV1/u);
  assert.match(composer, /searchPasses/u);
  assert.match(
    composer,
    /searchFilters:\s*\{[\s\S]*sort,[\s\S]*publishTime,[\s\S]*contentType:[\s\S]*searchScope,[\s\S]*distance:[\s\S]*videoDuration:/u,
  );
  assert.match(composer, /disableAutomaticSearchRetry: sequentialSearchEnabled/u);
  assert.match(composer, /requireVerifiedFilters: sequentialSearchEnabled/u);
  assert.match(composer, /一个关键词任务，由同一 Agent 串行完成/u);
  assert.match(composer, /每次搜索先采集列表、再增强本次新增内容/u);
  assert.match(sidebar, /plannedRounds = sequentialSearchEnabled[\s\S]*searchPasses\.length/u);
  assert.match(sidebar, /roundSearchFilters = activeSearchPass[\s\S]*contentType: activeSearchPass/u);
  assert.match(sidebar, /searchFilters: roundSearchFilters/u);
  assert.match(sidebar, /afterKeywordCapture: settings\.autoDetailCaptureAfterListCapture/u);
  assert.match(
    sidebar,
    /result\.canceled \|\|[\s\S]*result\.fatal \|\|[\s\S]*result\.recoveryRequired/u,
  );

  assert.match(detail, /detail\?\.items/u);
  assert.match(detail, /orchestration, executions, agents, attempts, schedule/u);
  assert.match(detail, /\/schedule\/\$\{action\}/u);
  assert.match(detail, /暂停计划/u);
  assert.match(detail, /重新启用/u);
  assert.match(detail, /每个计划时间，每个关键词执行 1 次/u);
  assert.match(detail, /每个关键词由同一 Agent/u);
  assert.match(detail, /任务遇到安全验证时/u);
  assert.match(detail, /接力只处理尚未开始的完整关键词/u);
  assert.match(detail, /\/retry-items/u);
  assert.match(detail, /回写当前父任务/u);
  assert.match(detail, /重试失败关键词/u);
  assert.match(detail, /keywordRetryAllocation/u);
  assert.match(detail, /detail\.retryCandidates/u);
  assert.match(detail, /自动分配预览/u);
  assert.match(detail, /逐项覆盖/u);
  assert.match(detail, /assignments,/u);
  assert.match(detail, /当前没有空闲兼容 Agent/u);
  assert.match(detail, /进入自动等待队列/u);
  assert.match(detail, /keywordRetryDispatchableCount > 0/u);
  assert.match(detail, /个现在接力/u);
  assert.match(detail, /槽位释放后自动接力/u);
  assert.match(detail, /buildKeywordRetryAssignments\(\{/u);
  assert.match(detail, /items: keywordRetryItems/u);
  assert.match(detail, /overrides: keywordRetryAgentOverrides/u);
  assert.doesNotMatch(
    detail,
    /keywordRetryAllocation\s*\.filter[\s\S]*agentId: allocation\.agent/u,
  );
  assert.match(detail, /allocation\.strictWaiting/u);
  assert.match(detail, /指定 Agent 当前不可用，将严格等待/u);
  assert.match(detail, /不会自动改派/u);
  assert.match(detail, /已指定 · 当前不可用（将严格等待）/u);
  assert.match(
    detail,
    /keywordRetryDispatchableCount > 0 && keywordRetryWaitingCount/u,
  );
  assert.doesNotMatch(detail, /keywordRetryTargetAgentId/u);
  assert.match(detail, /automaticKeywordRecoveryActive/u);
  assert.match(detail, /关键词自动尝试已耗尽/u);
  assert.match(detail, /页面不再把失败项误报为“正在自动恢复”/u);
  assert.match(detail, /当前任务已结算，不会继续自动分配/u);
  assert.match(detail, /\/schedule\/run-now/u);
  assert.match(detail, /立即运行/u);
  assert.match(detail, /onEditPlan\?\.\(detail\)/u);
  assert.match(detail, /编辑计划/u);
  assert.match(dispatchPage, /editingOrchestrationPlan/u);
  assert.match(dispatchPage, /onPlanUpdated/u);
  assert.match(
    detail,
    /\/capture-cloud\/orchestrations\/\$\{orchestrationId\}\/stop/u,
  );
  assert.match(detail, /canStopOrchestration/u);
  assert.match(detail, /patrolPathLabel/u);
  assert.match(detail, /同一 Agent/u);
  assert.match(detail, /不自动刷新补搜/u);
  assert.match(detail, /整个任务和自动接力已停止/u);
  assert.match(
    detail,
    /\['active', 'completed'\]\.includes\(schedule\.status\)/u,
  );
});

test('negative-patrol snapshots lock and fence an operator-stopped parent before item projection', async () => {
  const route = await read('server/routes/capture-cloud.js');
  const projectionStart = route.indexOf(
    'async function projectNegativePatrolSnapshot',
  );
  const projectionEnd = route.indexOf(
    'async function projectOrchestrationSnapshot',
    projectionStart,
  );
  assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
  const projection = route.slice(projectionStart, projectionEnd);
  const parentLock = projection.indexOf('lockOrchestrationParent(');
  const itemProjection = projection.indexOf('const itemOwnerTaskId');
  assert.ok(parentLock >= 0 && itemProjection > parentLock);
  assert.match(
    projection,
    /\['canceled', 'superseded'\]\.includes\(orchestrationParent\.status\)/u,
  );
  assert.match(projection, /parent: orchestrationParent/u);
});

test('automatic retry excludes parents explicitly stopped by an operator', async () => {
  const route = await read('server/routes/capture-cloud.js');
  assert.match(
    route,
    /REMOTELY_STOPPABLE_STATUSES[\s\S]*'waiting_device'/u,
  );
  assert.match(
    route,
    /safeJson\(initialTask\.metadata\)\.automaticRetryDisabled === true/u,
  );
  assert.match(
    route,
    /metadata->>'automaticRetryDisabled', 'false'\) <> 'true'/u,
  );
});

test('API supports opt-in timeouts without changing every request', async () => {
  const api = await read('web/admin/src/lib/api.ts');

  assert.match(api, /timeoutMs\?: number/u);
  assert.match(api, /!fetchOptions\.signal[\s\S]*new AbortController/u);
  assert.match(api, /timeoutController\.abort\(\)/u);
  assert.match(api, /请求超时，云端暂未完成分配/u);
  assert.doesNotMatch(api, /timeoutMs\s*=\s*\d+/u);
});
