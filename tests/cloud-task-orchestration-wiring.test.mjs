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
  assert.match(projection, /execution_task_id = \$9/u);
  assert.match(projection, /assigned_agent_id = \$10/u);
  assert.match(projection, /keyword = \$11/u);
  assert.match(projection, /capture_task_item_attempts/u);
  assert.match(projection, /entry\.errorCode \|\| entry\.error_code/u);
  assert.match(projection, /requiresManualAction/u);
  assert.match(projection, /refreshOrchestrationParentTask/u);
  assert.match(route, /'orchestrationChild', capture_tasks\.metadata->'orchestrationChild'/u);
  assert.match(route, /'parentTaskId', capture_tasks\.metadata->'parentTaskId'/u);

  const acceptedStart = route.indexOf('if (snapshotAccepted) {', mirrorStart);
  const acceptedEnd = route.indexOf('\n  }', acceptedStart);
  assert.ok(acceptedStart >= 0);
  assert.match(
    route.slice(acceptedStart, acceptedEnd + 4),
    /projectOrchestrationSnapshot\(tx, agent, task, snapshot\)/u,
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
  const [dispatchPage, taskCard, plansView, taskLib, composer, detail] = await Promise.all([
    read('web/admin/src/pages/dispatch/DispatchPage.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/PlansView.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/lib.ts'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx'),
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
  assert.match(composer, /当前分配预览已失效/u);
  assert.match(composer, /正在创建 \$\{new Set\(assignments/u);
  assert.match(composer, /<footer[\s\S]*aria-live="polite"[\s\S]*role="alert"[\s\S]*确认并分配/u);
  assert.match(composer, /'执行一次'/u);
  assert.match(composer, /'无人值守'/u);
  assert.match(composer, /platform,\s*\n\s*executionMode,/u);
  assert.match(composer, /maxRounds:\s*1/u);
  assert.match(composer, /roundGapMin:\s*10/u);
  assert.match(composer, /schedule:\s*\{/u);
  assert.match(composer, /'确认并启用计划'/u);
  assert.match(composer, /'确认并分配'/u);
  assert.match(composer, /不会覆盖设备 Extension 里已有的本地无人值守计划/u);
  assert.match(composer, /这里不会调用 AI/u);
  assert.match(composer, /1–300 个关键词/u);

  assert.match(detail, /detail\?\.items/u);
  assert.match(detail, /orchestration, executions, agents, attempts, schedule/u);
  assert.match(detail, /\/schedule\/\$\{action\}/u);
  assert.match(detail, /暂停计划/u);
  assert.match(detail, /重新启用/u);
  assert.match(detail, /每个计划时间，每个关键词执行 1 次/u);
  assert.match(detail, /任务遇到安全验证时/u);
  assert.match(detail, /接力只处理尚未开始的完整关键词/u);
});

test('API supports opt-in timeouts without changing every request', async () => {
  const api = await read('web/admin/src/lib/api.ts');

  assert.match(api, /timeoutMs\?: number/u);
  assert.match(api, /!fetchOptions\.signal[\s\S]*new AbortController/u);
  assert.match(api, /timeoutController\.abort\(\)/u);
  assert.match(api, /请求超时，云端暂未完成分配/u);
  assert.doesNotMatch(api, /timeoutMs\s*=\s*\d+/u);
});
