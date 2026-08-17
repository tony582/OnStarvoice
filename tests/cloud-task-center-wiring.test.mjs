import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(path) {
  return await readFile(resolve(repoRoot, path), "utf8");
}

async function readMigration(prefix) {
  const directory = resolve(repoRoot, "server/db/migrations");
  const filename = (await readdir(directory)).find(name => name.startsWith(prefix));
  assert.ok(filename, `missing ${prefix} migration`);
  return await readFile(resolve(directory, filename), "utf8");
}

test("server mounts the tenant cloud task center and agent endpoints", async () => {
  const [app, route, commandReconciliation] = await Promise.all([
    read("server/app.js"),
    read("server/routes/capture-cloud.js"),
    read("server/modules/capture/infrastructure/postgres-command-reconciliation.js"),
  ]);
  assert.match(app, /app\.use\('\/api\/capture-cloud', captureCloudRouter\)/u);
  assert.match(route, /router\.post\('\/agent\/liveness', requireCaptureAgent/u);
  assert.match(route, /router\.post\('\/agent\/heartbeat', requireCaptureAgent/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'\s*,\s*requireTenantAccess\s*,\s*requireSessionUser\s*,\s*requireTenantWriter/u);
  assert.match(route, /router\.post\('\/tasks\/:id\/resume', requireTenantAccess, requireSessionUser, requireTenantWriter/u);
  assert.match(route, /router\.post\('\/tasks\/:id\/stop', requireTenantAccess, requireSessionUser, requireTenantWriter/u);
  assert.match(commandReconciliation, /status IN \('pending', 'acknowledged'\)/u);
  assert.match(route, /t\.status = 'resume_requested'[\s\S]*t\.metadata->>'resumeCommandId' = c\.id::text/u);
  assert.match(route, /WHEN EXCLUDED\.attempt_number > capture_tasks\.attempt_number[\s\S]*THEN EXCLUDED\.progress_seq/u);
  assert.match(route, /jsonb_strip_nulls\(jsonb_build_object\([\s\S]*'resumeCommandId'/u);
  assert.match(commandReconciliation, /command_canceled_task_changed/u);
  assert.match(
    commandReconciliation,
    /c\.payload->>'authCodeId' = ca\.auth_code_id::text/u,
  );
  assert.match(
    commandReconciliation,
    /c\.payload->>'authBindingId' = ca\.auth_binding_id::text/u,
  );
  assert.match(commandReconciliation, /c\.payload->>'platform' = t\.platform/u);
});

test("agent credentials remain bound to an active code and active environment binding", async () => {
  const auth = await read("server/middleware/auth.js");
  assert.match(auth, /LEFT JOIN auth_bindings ab[\s\S]*ON ab\.id = cat\.auth_binding_id/u);
  assert.match(auth, /ca\.auth_code_id = cat\.auth_code_id/u);
  assert.match(auth, /ca\.auth_binding_id = cat\.auth_binding_id/u);
  assert.match(auth, /!agent\.active_auth_binding_id/u);
  assert.match(auth, /agent\.auth_code_status !== 'active'/u);
});

test("extension heartbeat and remote task controls are wired into the service worker lifecycle", async () => {
  const [background, sidebarHtml] = await Promise.all([
    read("background.js"),
    read("sidebar/sidebar.html"),
  ]);
  assert.match(background, /importScripts\('utils\/runtime-config\.js'\)/u);
  assert.match(background, /importScripts\('utils\/cloud-task-agent\.js'\)/u);
  assert.ok(
    background.indexOf("importScripts('utils/runtime-config.js')") <
      background.indexOf("importScripts('utils/cloud-task-agent.js')"),
  );
  assert.ok(
    sidebarHtml.indexOf('../utils/runtime-config.js') <
      sidebarHtml.indexOf('src="sidebar-logic.js"'),
  );
  assert.match(background, /CLOUD_TASK_AGENT_PERIOD_MINUTES = 1/u);
  assert.match(background, /syncCloudTaskAgentLiveness/u);
  assert.match(background, /cloudTaskAgentApi\.sendLiveness/u);
  assert.match(background, /syncCloudTaskAgentLiveness\(\{reason: 'cloud_agent_alarm'\}\)/u);
  assert.match(background, /manuallyRecoverUnattendedKeywordRun/u);
  assert.match(background, /cloudTaskAgentApi\.completeCommand/u);
  assert.match(background, /scheduleCloudTaskAgentSync\('task_ledger_changed'\)/u);
  assert.match(background, /CLOUD_TASK_AGENT_ACTIVE_THROTTLE_MS - \(Date\.now\(\) - cloudTaskAgentLastSyncAt\)/u);
  assert.match(background, /const degradedLastError = degradedHealth\.length > 0/u);
  assert.match(
    background,
    /lastError: \[reportedLastError, degradedLastError\][\s\S]*?\.join\('\s\|\s'\)/u,
  );
  assert.match(background, /const scopedPlan = taskStateKnown[\s\S]*?buildCloudScopedUnattendedPlan/u);
  assert.match(background, /unattendedPlan: scopedPlan/u);
  assert.match(background, /taskStateKnown,/u);
  assert.match(background, /unattendedPlanKnown: taskStateKnown/u);
  assert.match(background, /planScopeAgentId/u);
  assert.match(background, /commandType === 'create'/u);
  assert.match(background, /commandType === 'stop'/u);
  assert.match(background, /cancelUnattendedKeywordRunFromControl/u);
  assert.match(background, /onstarvoice:get-unattended-keyword-run-state/u);
  assert.match(background, /executionMode === 'unattended_plan'/u);
  assert.match(background, /summarizeCloudPlanSaveResult/u);
  assert.match(background, /cloudAgentStatus: 'onstarvoice\.cloudTaskAgentStatus'/u);
  assert.match(background, /clearReportedCloudTaskAgentError/u);
});

test("schema models agents, attempts, events, and durable remote commands", async () => {
  const migration = await read("server/db/migrations/032_cloud_capture_task_center.sql");
  for (const table of [
    "capture_agents",
    "capture_agent_tokens",
    "capture_tasks",
    "capture_task_attempts",
    "capture_task_events",
    "capture_agent_commands",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL DEFAULT \(now\(\) \+ interval '30 days'\)/u);
  assert.match(migration, /auth_code_id UUID NOT NULL REFERENCES auth_codes/u);
  assert.match(migration, /auth_binding_id UUID NOT NULL REFERENCES auth_bindings/u);
  assert.match(migration, /idx_capture_agent_commands_tenant_expires/u);
});

test("schema keeps accepted cloud task snapshots as append-only history", async () => {
  const migration = await read("server/db/migrations/034_capture_task_snapshot_history.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capture_task_snapshots/u);
  assert.match(migration, /snapshot_fingerprint TEXT NOT NULL/u);
  assert.match(migration, /UNIQUE \(task_id, snapshot_fingerprint\)/u);
  assert.match(migration, /source_updated_at TIMESTAMPTZ NOT NULL/u);
  assert.match(migration, /idx_capture_task_snapshots_task_source/u);
  assert.match(migration, /idx_capture_task_snapshots_tenant_received/u);
});

test("remote task creation persists the local plan mirror and a durable create command", async () => {
  const [route, migration] = await Promise.all([
    read("server/routes/capture-cloud.js"),
    readMigration("033_"),
  ]);

  assert.match(migration, /ALTER TABLE capture_agents[\s\S]*ADD COLUMN IF NOT EXISTS unattended_plan JSONB/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS unattended_plan_updated_at TIMESTAMPTZ/u);
  assert.match(migration, /ALTER TABLE capture_agent_commands[\s\S]*CHECK \(command_type IN \('resume', 'stop', 'create'\)\)/u);

  assert.match(route, /req\.body\?\.unattendedPlan/u);
  assert.match(route, /unattended_plan/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*normalizeRemoteTaskInput/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*remoteTaskCreate/u);
  assert.match(
    route,
    /Object\.keys\(safeJson\(body\.captureSettings\)\)\.length > 0[\s\S]*capabilities\.remoteTaskEnhancementOptions !== true/u,
  );
  assert.match(route, /agent_enhancement_capability_missing/u);
  assert.match(
    route,
    /hasKeywordMaxDetectedItems[\s\S]*Number\.isSafeInteger\(rawKeywordMaxDetectedItems\)[\s\S]*rawKeywordMaxDetectedItems <= 0[\s\S]*invalid_keyword_max_detected_items/u,
  );
  assert.match(
    route,
    /capabilities\.remoteTaskKeywordPostLimit !== true[\s\S]*agent_keyword_limit_capability_missing/u,
  );
  assert.match(route, /captureSettings:\s*plan\.captureSettings/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*INSERT INTO capture_tasks/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*INSERT INTO capture_agent_commands[\s\S]*'create'/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*planSnapshot/u);
  assert.match(route, /router\.post\(\s*'\/agents\/:id\/tasks'[\s\S]*createCommandId/u);
  assert.match(route, /remoteRequestHash/u);
  assert.match(route, /idempotency_key_conflict/u);
  assert.match(route, /request_key_required/u);
  assert.match(route, /if \(!normalizedInput\.clientTaskId\)/u);
  assert.match(route, /'localRequestId', capture_tasks\.metadata->'localRequestId'/u);
  assert.match(route, /'createCompletedAt', capture_tasks\.metadata->'createCompletedAt'/u);
  assert.match(route, /'createFailedAt', capture_tasks\.metadata->'createFailedAt'/u);
  assert.match(
    route,
    /ORDER BY CASE[\s\S]*WHEN c\.command_type = 'stop' THEN 0[\s\S]*WHEN c\.command_type = 'resume' THEN 1[\s\S]*WHEN c\.command_type = 'create'[\s\S]*c\.payload->>'executionMode' = 'unattended_plan' THEN 2[\s\S]*ELSE 3[\s\S]*END, c\.created_at ASC, c\.id ASC[\s\S]*LIMIT 10/u,
  );
  assert.match(route, /metadata->>'stopCommandId' = c\.id::text/u);
  assert.match(route, /stop_request_id_mismatch/u);
  assert.match(route, /superseded_by_stop[\s\S]*stopped_before_dispatch/u);
  assert.match(
    route,
    /supersededCreateCommandId:\s*activeCreate\.id/u,
  );
  assert.match(
    route,
    /stopOutcome = resolveStopCommandOutcome\([\s\S]*success = stopOutcome\.success/u,
  );
});

test("admin UI treats each browser as an independent Agent and exposes remote continue", async () => {
  const [page, rail, taskCard] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentRail.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx"),
  ]);
  assert.match(rail, /每个浏览器均为独立 Agent/u);
  assert.match(rail, /2 分钟无心跳即视为离线/u);
  assert.match(taskCard, /继续剩余任务/u);
  assert.match(taskCard, /上线后继续/u);
  assert.match(taskCard, /设备心跳：/u);
  assert.match(taskCard, /任务心跳：/u);
  assert.match(taskCard, /业务进展：/u);
  assert.match(taskCard, /orchestration \|\| resumable \|\| retryOnIdleAgent \|\| stoppable \|\| commandPending/u);
  assert.match(taskCard, /pending_command_expires_at/u);
  assert.match(taskCard, /pending_command_type/u);
  assert.match(page, /\/capture-cloud\/tasks\/' \+ task\.id \+ '\/stop/u);
  assert.match(taskCard, /上线后停止/u);
});

test("admin UI exposes guarded Agent deletion without a nested row button", async () => {
  const [page, rail] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentRail.tsx"),
  ]);
  assert.match(rail, /DropdownMenu\.Root/u);
  assert.match(rail, /管理节点 \$\{agent\.display_name\}/u);
  assert.match(rail, /删除节点/u);
  assert.match(rail, /<Dialog\.Root/u);
  assert.match(rail, /此操作不可直接恢复/u);
  assert.match(rail, /历史任务、采集结果和账号用量会保留/u);
  assert.match(rail, /激活码的环境名额不会自动释放/u);
  assert.match(rail, /节点仍在线，请先关闭该浏览器的 Extension/u);
  assert.doesNotMatch(rail, /window\.confirm/u);
  assert.match(page, /api\.delete<\{ message\?: string \}>\([\s\S]*`\/capture-cloud\/agents\/\$\{agent\.id\}`/u);
  assert.match(page, /onDeleteAgent=\{deleteAgent\}/u);
});

test("admin UI separates reversible tenant migration from destructive node retirement", async () => {
  const [page, rail] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentRail.tsx"),
  ]);

  const detachMenuStart = rail.indexOf('<DropdownMenu.Item onSelect={onDetach}');
  const retireMenuStart = rail.indexOf('<DropdownMenu.Item onSelect={onRetire}', detachMenuStart);
  assert.ok(detachMenuStart >= 0 && retireMenuStart > detachMenuStart);
  const detachMenu = rail.slice(detachMenuStart, retireMenuStart);
  assert.match(detachMenu, /移出当前租户/u);
  assert.match(detachMenu, /disabled=\{agent\.online\}/u);
  assert.doesNotMatch(detachMenu, /text-destructive/u);

  const detachDialogStart = rail.indexOf('function DetachAgentDialog');
  const retireDialogStart = rail.indexOf('function RetireAgentDialog', detachDialogStart);
  assert.ok(detachDialogStart >= 0 && retireDialogStart > detachDialogStart);
  const detachDialog = rail.slice(detachDialogStart, retireDialogStart);
  assert.match(detachDialog, /仅用于浏览器已经切换到其他租户或激活码/u);
  assert.match(detachDialog, /从当前租户的节点列表和新建任务选择中隐藏/u);
  assert.match(detachDialog, /现有等待任务与无人值守计划会终止/u);
  assert.match(detachDialog, /切回本租户并重新验证激活码，会恢复为可用节点/u);
  assert.match(detachDialog, /<Button size="sm" onClick=\{onConfirm\}/u);

  const detachActionStart = page.indexOf('const detachAgent =');
  const retireActionStart = page.indexOf('const retireAgent =', detachActionStart);
  assert.ok(detachActionStart >= 0 && retireActionStart > detachActionStart);
  const detachAction = page.slice(detachActionStart, retireActionStart);
  assert.match(
    detachAction,
    /`\/capture-cloud\/agents\/\$\{agent\.id\}\/retire`[\s\S]*confirmation: '移出当前租户'[\s\S]*reason: 'tenant_migrated'/u,
  );
  assert.match(page, /onDetachAgent=\{detachAgent\}/u);
  assert.match(
    page,
    /operationalAgents[\s\S]*agent\.status === 'active' \|\| agent\.status === 'paused'/u,
  );
  assert.match(page, /<CreateTaskDrawer agents=\{operationalAgents\}/u);
  assert.match(page, /<OrchestrationComposerDrawer[\s\S]*agents=\{operationalAgents\}/u);

  const retireDialogEnd = rail.indexOf('function AgentDetailPane', retireDialogStart);
  const retireDialog = rail.slice(retireDialogStart, retireDialogEnd);
  assert.match(retireDialog, /永久停用节点/u);
  assert.match(retireDialog, /确认永远不会再使用/u);
  assert.match(retireDialog, /换租户、普通离线和临时关机不要使用/u);
  assert.match(retireDialog, /以后重新验证也不能恢复/u);
  assert.match(retireDialog, /输入“永久停用”确认/u);
  assert.match(retireDialog, /confirmation !== '永久停用'/u);
  assert.doesNotMatch(retireDialog, /tenant_migrated/u);

  const retireAction = page.slice(retireActionStart, page.indexOf('if (loading && !overview)', retireActionStart));
  assert.match(
    retireAction,
    /`\/capture-cloud\/agents\/\$\{agent\.id\}\/retire`[\s\S]*confirmation: '永久停用'[\s\S]*reason: 'permanently_offline'/u,
  );
  assert.match(page, /onRetireAgent=\{retireAgent\}/u);
});

test("admin UI shows each node's local plan and capability-gates remote task creation", async () => {
  const [creator, summary] = await Promise.all([
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentTaskCreator.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/UnattendedPlanSummary.tsx"),
  ]);
  assert.match(summary, /本地无人值守计划/u);
  assert.match(creator, /unattended_plan/u);
  assert.match(creator, /function AgentTaskCreator/u);
  assert.match(creator, /新建关键词采集任务/u);
  assert.match(creator, /agent\.capabilities\?\.remoteTaskCreate === true/u);
  assert.match(creator, /\/capture-cloud\/agents\/\$\{agent\.id\}\/tasks/u);
  assert.match(creator, /pendingSubmission/u);
  assert.match(creator, /requestKey:\s*window\.crypto\.randomUUID\(\)/u);
  assert.match(creator, /当前扩展版本不支持云端新建任务，请升级扩展/u);
  assert.match(creator, /Agent 离线，任务会在云端排队，设备上线后自动领取/u);
  assert.match(creator, /executionMode/u);
  assert.match(creator, /'one_time' \| 'unattended_plan'/u);
  assert.match(creator, /remoteUnattendedPlanWrite/u);
  assert.match(creator, /agent\.capabilities\?\.remoteTaskEnhancementOptions === true/u);
  assert.match(creator, /agent\.capabilities\?\.remoteTaskKeywordPostLimit === true/u);
  assert.match(creator, /每个关键词最多采集帖子数/u);
  assert.match(
    creator,
    /remoteTaskKeywordPostLimit &&[\s\S]*!Number\.isSafeInteger\(keywordMaxDetectedItems\)[\s\S]*keywordMaxDetectedItems < 1/u,
  );
  assert.match(
    creator,
    /\.\.\.\(remoteTaskKeywordPostLimit && keywordLimitOverrideEnabled \? \{ keywordMaxDetectedItems \} : \{\}\)/u,
  );
  assert.match(creator, /任务会使用目标设备的本地设置/u);
  assert.match(creator, /const captureSettings:\s*CaptureEnhancementSettings \| undefined/u);
  assert.match(creator, /\.\.\.\(captureSettings \? \{ captureSettings \} : \{\}\)/u);
  assert.match(creator, /detailCommentsMaxDetectedItems/u);
  assert.match(creator, /当前扩展版本不支持为远程任务指定采集增强选项/u);
  assert.match(creator, /一次性/u);
  assert.match(creator, /无人值守/u);
});

test("admin UI creates one task draft and explicitly assigns it to a browser agent", async () => {
  const [page, lib] = await Promise.all([
    read("web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/lib.ts"),
  ]);

  assert.match(page, /export function CreateTaskDrawer/u);
  assert.match(page, /新建任务/u);
  assert.match(page, /任务类型/u);
  assert.match(page, /执行方式/u);
  assert.match(page, /选择节点/u);
  assert.match(page, /任务配置/u);
  assert.match(page, /<AgentPicker/u);
  assert.match(page, /setSelectedAgentIds/u);
  assert.match(page, /key=\{`\$\{selectedAgent\.id\}:\$\{mode\}:/u);
  assert.match(page, /agent=\{selectedAgent\}/u);
  assert.match(page, /节点离线时原地等待，不会自动转交/u);
  assert.match(lib, /Agent 已暂停，不能接收新任务/u);
  assert.match(lib, /客户端扩展版本过低，需升级后才能远程接单/u);
  assert.equal((page.match(/<AgentTaskCreator\b/gu) || []).length, 1,
    "the long task form must render only once inside the assignment drawer");
});

test("new fixed-node tasks explicitly disable automatic cross-device handoff", async () => {
  const [
    keywordCreator,
    negativeCreator,
    officialCreator,
    accountCreator,
    profileDispatch,
  ] = await Promise.all([
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentTaskCreator.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/NegativePatrolTaskCreator.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/OfficialCommentPatrolTaskCreator.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/AccountDiscoveryTaskCreator.tsx"),
    read("server/services/profile-patrol-dispatch.js"),
  ]);

  assert.match(keywordCreator, /distributionMode: 'fixed_batch'/u);
  assert.match(keywordCreator, /allowIdleAgentHandoff: false/u);
  assert.match(
    negativeCreator,
    /const elasticPool = multiAgent \|\| selectedPlatforms\.length > 1[\s\S]*allowIdleAgentHandoff: elasticPool/u,
  );
  assert.match(officialCreator, /allowIdleAgentHandoff: false/u);
  assert.match(accountCreator, /allowIdleAgentHandoff: false/u);
  assert.match(profileDispatch, /automaticRetryDisabled: automaticRetryDisabled === true/u);
  assert.match(profileDispatch, /allowIdleAgentHandoff: automaticRetryDisabled !== true/u);
});

test("multi-Agent handoff keeps unattended mode and selects platform-compatible agents only once", async () => {
  const [drawer, dispatch, composer, types] = await Promise.all([
    read("web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx"),
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/types.ts"),
  ]);

  assert.match(
    drawer,
    /onLaunchOrchestration\(\{[\s\S]*executionMode: mode,[\s\S]*agentIds: \[\],[\s\S]*lockExecutionMode: true,[\s\S]*minimumAgentCount: 2/u,
  );
  assert.doesNotMatch(drawer, /onLaunchOrchestration\(selectedAgentIds\)/u);
  assert.match(drawer, /平台和采集规则确定后只选一次节点/u);
  assert.match(dispatch, /setOrchestrationLaunchIntent\(launchIntent\)/u);
  assert.match(dispatch, /\{orchestrationLaunchIntent && \([\s\S]*initialExecutionMode=\{orchestrationLaunchIntent\.executionMode\}/u);
  assert.match(dispatch, /minimumAgentCount=\{orchestrationLaunchIntent\.minimumAgentCount\}/u);
  assert.match(types, /executionMode: OrchestrationExecutionMode/u);
  assert.match(composer, /setExecutionMode\(editMode \? 'unattended_plan' : initialExecutionMode\)/u);
  assert.match(composer, /已从上一步确定，无需重复选择/u);
  assert.match(composer, /validSelectedAgentIds\.length < requiredAgentCount/u);
  assert.doesNotMatch(composer, /keywords\.length < requiredAgentCount/u);
  assert.match(composer, /validSelectedAgentIds\.length < requiredAgentCount/u);
  assert.match(composer, /useState<DistributionMode>\('elastic_pool'\)/u);
  assert.match(composer, /eligibleAgentIds: validSelectedAgentIds/u);
  assert.match(composer, /eligibleAgentIds: \[\.\.\.validSelectedAgentIds\]\.sort\(\)/u);
  assert.match(composer, /至少 \{requiredAgentCount\} 个/u);
  assert.match(composer, /已移除不兼容节点/u);
  assert.match(drawer, /固定一个节点/u);
  assert.match(drawer, /弹性节点池（推荐）/u);
  assert.match(
    drawer,
    /\['keyword', 'unattended_plan', 'negative_patrol'\]\.includes\(taskType\)/u,
  );
  assert.match(composer, /一次领取 1 项/u);
  assert.match(composer, /创建指令 3 分钟未确认/u);
  assert.match(composer, /持续离线 10 分钟/u);
});

test("admin UI keeps the business task list newest-first and hides technical child jobs", async () => {
  const [page, lib] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/lib.ts"),
  ]);

  assert.match(lib, /function isBusinessVisibleTask/u);
  assert.match(lib, /type === 'unattended_plan_configuration'/u);
  assert.match(lib, /type === 'sync'/u);
  assert.match(lib, /task\.status === 'superseded'/u);
  assert.match(page, /\(overview\?\.tasks \|\| \[\]\)\.filter\(isBusinessVisibleTask\)/u);
  assert.match(page, /left\.created_at \|\| left\.updated_at/u);
  assert.match(page, /right\.created_at \|\| right\.updated_at/u);
  assert.match(page, /按创建时间倒序，新任务在最前/u);
});

test("admin UI can load and explicitly replace an existing unattended plan without polluting new one-time tasks", async () => {
  const page = await read("web/admin/src/pages/dispatch/cloud-tasks/AgentTaskCreator.tsx");
  const resetStart = page.indexOf("  const resetNewTaskForm = () => {");
  const resetEnd = page.indexOf("  const toggleNewTaskForm = () => {", resetStart);
  const toggleEnd = page.indexOf("  const editUnattendedPlan = () => {", resetEnd);
  const editEnd = page.indexOf("\n\n  if (!remoteTaskCreate)", toggleEnd);
  const submitStart = page.indexOf("  const submit = async", editEnd);
  const submitEnd = page.indexOf("\n\n  const disabled =", submitStart);

  assert.notEqual(resetStart, -1, "missing new-task reset helper");
  assert.notEqual(resetEnd, -1, "missing new-task toggle helper");
  assert.notEqual(toggleEnd, -1, "missing existing-plan edit callback");
  assert.notEqual(editEnd, -1, "cannot isolate existing-plan edit callback");
  assert.notEqual(submitStart, -1, "missing task submit callback");
  assert.notEqual(submitEnd, -1, "cannot isolate task submit callback");

  const resetSection = page.slice(resetStart, resetEnd);
  const toggleSection = page.slice(resetEnd, toggleEnd);
  const editSection = page.slice(toggleEnd, editEnd);
  const submitSection = page.slice(submitStart, submitEnd);

  // A configured plan exposes a dedicated edit entry instead of forcing users
  // to recreate it through the generic new-task form.
  assert.match(page, /hasConfiguredUnattendedPlan\(existingPlan\)/u);
  assert.match(page, /hasExistingPlan && \([\s\S]*onClick=\{editUnattendedPlan\}[\s\S]*修改现有无人值守计划/u);
  assert.match(page, /disabled=\{disabled \|\| !remoteUnattendedPlanWrite\}/u);

  // Editing is a plan replacement operation and must load every business field
  // represented by the mirrored plan before the form opens.
  assert.match(editSection, /setExecutionMode\('unattended_plan'\)/u);
  assert.match(editSection, /setPlatform\([\s\S]*existingPlan\.platform/u);
  assert.match(editSection, /setKeywordText\([\s\S]*existingPlan\.keywords[\s\S]*join\('\\n'\)/u);
  assert.match(editSection, /setSort\([\s\S]*existingPlan\.searchFilters\?\.sort/u);
  assert.match(editSection, /setPublishTime\([\s\S]*existingPlan\.searchFilters\?\.publishTime/u);
  assert.match(editSection, /setPlanMode\(configuredMode\)/u);
  assert.match(editSection, /setStartTime\(configuredStartTime\)/u);
  assert.match(editSection, /setRandomOffsetMin\([\s\S]*existingPlan\.randomOffsetMin/u);
  assert.match(editSection, /setCustomDates\(String\(existingPlan\.customDates \|\| ''\)\)/u);
  assert.match(editSection, /setMaxRounds\([\s\S]*existingPlan\.maxRounds/u);
  assert.match(editSection, /setRoundGapMin\([\s\S]*existingPlan\.roundGapMin/u);
  assert.match(editSection, /setKeywordMaxDetectedItems\(hasConfiguredLimit \? configuredLimit : 50\)/u);
  assert.match(editSection, /setKeywordLimitOverrideEnabled\(hasConfiguredLimit\)/u);
  assert.match(editSection, /setKeywordLimitDefaultedFromLegacyPlan\(!hasConfiguredLimit\)/u);
  assert.match(
    editSection,
    /const hasConfiguredCaptureSettings = Boolean\(captureSettings && Object\.keys\(captureSettings\)\.length > 0\)/u,
  );
  assert.match(editSection, /setCaptureSettingsOverrideEnabled\(hasConfiguredCaptureSettings\)/u);

  for (const setter of [
    "setEnhancementEnabled",
    "setAutoSyncAfterEnhancement",
    "setAiRelevancePrefilter",
    "setIncludeBloggerMetrics",
    "setLowFollowerHitFilter",
    "setLowFollowerHitThreshold",
    "setIncludeComments",
    "setCommentLimit",
    "setCommentLeadsFilter",
    "setSkipAlreadyEnhanced",
  ]) {
    assert.match(editSection, new RegExp(`${setter}\\([\\s\\S]*captureSettings`, "u"), `${setter} must load captureSettings`);
  }
  assert.match(editSection, /setEditingExistingPlan\(true\)[\s\S]*setOpen\(true\)/u);

  // The same create endpoint remains contract-compatible: edit mode submits an
  // unattended_plan payload, while the visible copy makes replacement explicit.
  assert.match(submitSection, /const taskInput = \{[\s\S]*executionMode,/u);
  assert.match(submitSection, /executionMode === 'unattended_plan' \? \{/u);
  assert.match(
    submitSection,
    /remoteTaskKeywordPostLimit && keywordLimitOverrideEnabled \? \{ keywordMaxDetectedItems \} : \{\}/u,
  );
  assert.match(
    submitSection,
    /remoteTaskEnhancementOptions && captureSettingsOverrideEnabled[\s\S]*\? \{[\s\S]*autoDetailCaptureAfterListCapture/u,
  );
  assert.match(submitSection, /api\.post<\{ message\?: string \}>\(`\/capture-cloud\/agents\/\$\{agent\.id\}\/tasks`/u);
  assert.match(submitSection, /editingExistingPlan[\s\S]*覆盖保存/u);
  assert.match(page, /正在修改该设备的现有无人值守计划/u);
  assert.match(page, /保存修改会覆盖当前设备计划/u);
  assert.match(page, /保存修改并覆盖原计划/u);

  // Legacy plans are tri-state: values absent from the mirror stay absent from
  // the replacement payload until the operator explicitly enables an override.
  assert.match(page, /checked=\{keywordLimitOverrideEnabled\}[\s\S]*setKeywordLimitOverrideEnabled\(event\.target\.checked\)/u);
  assert.match(page, /关闭时沿用目标设备当前的本地采集上限/u);
  assert.match(page, /本次保存不会写入帖子上限，也不会因为修改日期等其他字段而改成 50 条/u);
  assert.match(page, /checked=\{captureSettingsOverrideEnabled\}[\s\S]*setCaptureSettingsOverrideEnabled\(event\.target\.checked\)/u);
  assert.match(page, /关闭时沿用目标设备当前的本地采集增强设置/u);
  assert.match(page, /本次保存不会写入采集增强选项，也不会因为修改时间、日期等其他字段而关闭设备原有增强能力/u);

  // Entering the generic new-task path after editing resets every plan-derived
  // value, so a fresh one-time task keeps its independent defaults.
  assert.match(toggleSection, /resetNewTaskForm\(\)[\s\S]*setOpen\(true\)/u);
  assert.match(page, /onClick=\{\(\) => editingExistingPlan \? resetNewTaskForm\(\) : setExecutionMode\('one_time'\)\}/u);
  assert.match(resetSection, /setExecutionMode\('one_time'\)/u);
  assert.match(resetSection, /setPlatform\(availablePlatforms\[0\] \|\| ''\)/u);
  assert.match(resetSection, /setKeywordText\(''\)/u);
  assert.match(resetSection, /setSort\('comprehensive'\)/u);
  assert.match(resetSection, /setPublishTime\('all'\)/u);
  assert.match(resetSection, /setMaxRounds\(1\)/u);
  assert.match(resetSection, /setRoundGapMin\(10\)/u);
  assert.match(resetSection, /setPlanMode\('daily'\)/u);
  assert.match(resetSection, /setStartTime\('09:00'\)/u);
  assert.match(resetSection, /setRandomOffsetMin\(20\)/u);
  assert.match(resetSection, /setCustomDates\(''\)/u);
  assert.match(resetSection, /setKeywordMaxDetectedItems\(50\)/u);
  assert.match(resetSection, /setKeywordLimitOverrideEnabled\(true\)/u);
  assert.match(resetSection, /setEnhancementEnabled\(false\)/u);
  assert.match(resetSection, /setCaptureSettingsOverrideEnabled\(true\)/u);
  assert.match(resetSection, /setEditingExistingPlan\(false\)/u);
  assert.match(resetSection, /setKeywordLimitDefaultedFromLegacyPlan\(false\)/u);
});

test("admin task dates accept loose separators and normalize real calendar days", async () => {
  const page = await read("web/admin/src/pages/dispatch/cloud-tasks/lib.ts");
  const start = page.indexOf("function normalizeCloudTaskDate(");
  const end = page.indexOf("function localDateKey(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = vm.createContext({Date});
  const executableDateHelpers = page
    .slice(start, end)
    .replaceAll("export ", "")
    .replace("value: unknown = ''", "value = ''");
  vm.runInContext(
    `${executableDateHelpers}\nglobalThis.__normalizeDateList = normalizeCloudTaskDateList; globalThis.__shanghaiToday = shanghaiToday;`,
    context,
  );

  const normalized = context.__normalizeDateList(
    "2026-7-2, 2026/07/02; 2028/2/29 2026/2/29 2026-13-1 invalid",
  );
  assert.deepEqual(Array.from(normalized.dates), [
    "2026-07-02",
    "2028-02-29",
  ]);
  assert.deepEqual(Array.from(normalized.invalidDates), [
    "2026/2/29",
    "2026-13-1",
    "invalid",
  ]);
  assert.equal(
    context.__shanghaiToday(new Date("2026-08-02T16:30:00.000Z")),
    "2026-08-03",
  );
});

test("single and multi-Agent plans share a calendar-based multi-date picker", async () => {
  const [picker, single, multi] = await Promise.all([
    read("web/admin/src/pages/dispatch/cloud-tasks/ScheduledDatesPicker.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/AgentTaskCreator.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx"),
  ]);

  assert.match(single, /<ScheduledDatesPicker value=\{customDates\} onChange=\{setCustomDates\}/u);
  assert.match(multi, /<ScheduledDatesPicker[\s\S]*value=\{customDates\}/u);
  assert.doesNotMatch(single, /运行日期（每行一个）/u);
  assert.doesNotMatch(multi, /指定日期（每行一个）/u);
  assert.match(picker, /type="date"/u);
  assert.match(picker, /min=\{today\}/u);
  assert.match(picker, /nextDates\.join\('\\n'\)/u);
  assert.match(picker, /dates\.filter\(item => item !== date\)\.join\('\\n'\)/u);
  assert.match(picker, /dates\.length >= 400/u);
  assert.match(picker, /aria-live="polite"/u);
});

test("admin can move ended failures to history individually or in bulk", async () => {
  const [page, lib] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/lib.ts"),
  ]);

  assert.match(
    lib,
    /const DISMISSIBLE_ATTENTION_TASK_STATUSES = new Set\(\['failed', 'completed_with_failures'\]\)/u,
  );
  assert.match(lib, /function canDismissAttention/u);
  assert.match(lib, /!task\.attention_dismissed_at/u);
  assert.match(page, /\/capture-cloud\/tasks\/' \+ task\.id \+ '\/dismiss-attention'/u);
  assert.match(page, /\/capture-cloud\/tasks\/dismiss-terminal-attention/u);
  assert.match(page, /任务记录和采集结果都会保留/u);
  assert.match(page, /当前账号下所有已结束的失败任务/u);
  assert.match(page, /中断和仍需处理的任务不会被清理/u);
  assert.match(page, /清理已结束失败项/u);
  assert.match(page, /移到历史/u);
});

test("verify input and extension API origins are bounded before credentials are sent", async () => {
  const [verifyRoute, api, sidebar, storage, state, runtimeConfig, localRuntimeConfig, snapshotScript, checkScript, packageScript, serverPackage] = await Promise.all([
    read("server/routes/verify.js"),
    read("utils/api.js"),
    read("sidebar/sidebar-logic.js"),
    read("utils/storage.js"),
    read("sidebar/state.js"),
    read("utils/runtime-config.js"),
    read("scripts/extension-runtime-config.local.js"),
    read("scripts/sync-extension-build.zsh"),
    read("scripts/check-extension-snapshot.zsh"),
    read("scripts/package-extension.zsh"),
    read("server/package.json"),
  ]);
  assert.match(verifyRoute, /resolvedFingerprint\.length > 240/u);
  assert.match(verifyRoute, /resolvedUserAgent\.length > 1000/u);
  assert.doesNotMatch(api, /'http:\/\/localhost:3001'/u);
  assert.doesNotMatch(api, /'http:\/\/127\.0\.0\.1:3001'/u);
  assert.doesNotMatch(runtimeConfig, /http:\/\/localhost:3001/u);
  assert.match(runtimeConfig, /https:\/\/voice\.minilife\.online/u);
  assert.match(localRuntimeConfig, /http:\/\/localhost:3001/u);
  assert.match(snapshotScript, /build_target=\$\{1:-production\}/u);
  assert.match(snapshotScript, /extension-runtime-config\.local\.js/u);
  assert.match(snapshotScript, /^#!\/usr\/bin\/env bash/u);
  assert.match(checkScript, /^#!\/usr\/bin\/env bash/u);
  assert.doesNotMatch(snapshotScript, /\$\{0:A|\bprint\s+-u2\b/u);
  assert.doesNotMatch(checkScript, /\$\{0:A|\bprint\s+-u2\b/u);
  assert.match(packageScript, /bash "\$script_dir\/sync-extension-build\.zsh" production/u);
  assert.match(packageScript, /已停止打包/u);
  assert.match(JSON.parse(serverPackage).scripts.test, /^bash \.\.\/scripts\/check-extension-snapshot\.zsh/u);
  assert.match(sidebar, /function queueAuthVerification/u);
  assert.match(sidebar, /revision !== authCodeRevision/u);
  assert.match(sidebar, /旧验证结果已忽略/u);
  assert.match(sidebar, /expectedMutationId: requestMutationId/u);
  assert.match(storage, /locks\.request\('onstarvoice:auth-state'/u);
  assert.match(storage, /accepted: false, auth: current/u);
  assert.match(state, /changes\[STORAGE_KEY\.AUTH\]/u);
});

test("settled root tasks auto-recover while retaining the legacy manual fallback", async () => {
  const [page, card, lib] = await Promise.all([
    read("web/admin/src/pages/dispatch/DispatchPage.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx"),
    read("web/admin/src/pages/dispatch/cloud-tasks/lib.ts"),
  ]);
  assert.match(lib, /export function canRetryOnIdleAgent/u);
  assert.match(lib, /export function automaticIdleAgentRecoveryEnabled/u);
  assert.match(lib, /promotedRetryParent/u);
  assert.match(card, /系统正在选择兼容的空闲 Agent 自动重试/u);
  assert.match(card, /retryEligible && !safetyEvidence && !automaticRecoveryPending/u);
  assert.match(card, /换空闲设备重试/u);
  assert.match(card, /onRetryOnIdleAgent/u);
  assert.match(page, /retry-on-idle-agent/u);
  assert.match(page, /expectedRevision/u);
  assert.match(page, /重试结果仍汇总在这条原任务里/u);
});
