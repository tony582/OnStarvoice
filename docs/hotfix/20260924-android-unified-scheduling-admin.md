# 手机节点并入普通调度：后台（web/admin）交付（20260924）

分支 `codex/feat-android-unified-scheduling-20260924`。本文对应契约 `docs/hotfix/20260924-android-unified-scheduling-design.md` §3。

## 一句话结论

手机节点（`capabilities.agentKind='android_mobile'`）不再有独立「手机发现」弹窗；它作为一个抖音节点出现在执行节点列表、节点选择器和编排器里，只做抖音关键词搜索发现，并在任务详情/历史里展示「手机发现 → 补详情」进度、候选与停稳恢复。

## 改动文件清单

新增
- `web/admin/src/pages/dispatch/android-discovery/AndroidChildRunPanel.tsx`：可复用的手机发现详情块。给定 run id（编排子任务 = `execution_task_id`；旧独立 run = 任务 id）拉取 `GET /capture-cloud/android/runs/:id`，展示「手机发现 N · 待补详情 N · 已入库 N · 失败 N」四联计数、逐词状态、`RecoveryPanel` 停稳恢复，并可展开 `DiscoveryCandidates` 用既有重处理接口重跑候选。

修改
- `web/admin/src/pages/dispatch/DispatchPage.tsx`：删除 `businessTasks` 的 `workflow==='douyin_mobile_discovery'` 过滤、`operationalAgents` 的 `agentKind!=='android_mobile'` 过滤；移除工具栏的 `AndroidDiscoveryEntry` 及其 import（连带删掉不再使用的 `tenantId` 解构）。
- `web/admin/src/pages/dispatch/cloud-tasks/lib.ts`：新增 `isMobileAgent()`、`mobileReadinessLabel()`（`readyForSearch=true`→「可执行搜索」；否则按 `deviceReason` 映射 `douyin_not_foreground`/`device_locked`/`device_asleep`/`device_missing`/`appium_not_ready`，未知原因原样透传）。`agentAssignmentBlockReason()` 对手机跳过 `remoteTaskCreate`/`remoteUnattendedPlanWrite`，改为要求 `mobileSearchDiscoveryV1===true` 且开通抖音；`agentTaskTypeBlockReason()` 对手机只放行 `keyword`/`unattended_plan`，其余（各类巡查）返回「手机节点仅支持关键词搜索发现」。
- `web/admin/src/pages/dispatch/cloud-tasks/AgentRail.tsx`：执行节点行对手机加「手机」标识（Smartphone），在线时状态行追加就绪文案。
- `web/admin/src/pages/dispatch/cloud-tasks/AgentPicker.tsx`：节点选择项对手机加「手机」标识与就绪文案（离线显示「手机执行器离线」）；`manual_average`（平均下发手动采集）对手机返回「手机节点仅支持关键词搜索发现」。
- `web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx`：单节点关键词/无人值守（非巡查）选中手机时，配置步不再渲染浏览器专属的 `AgentTaskCreator`（其 create 命令手机不消费），而是渲染「手机节点通过统一编排下发」卡片，点击进入编排器（固定单节点、锁定选择）。`<AgentTaskCreator>` 仍只出现一次（满足既有测试计数）。
- `web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx`：`agentBlockReason()` 对手机：要求 `mobileSearchDiscoveryV1`；平台非抖音→「手机节点仅支持抖音搜索发现」；多段搜索（`searchPasses`）→「手机节点不支持多段搜索巡检」；负面巡查→「手机节点不支持负面巡查」。新增可选状态 `mobileKeywordMaxMinutes`（默认 15，范围 1–120），仅在选中手机（`mobileSelected`）时显示字段、计入 fingerprint、并随创建/计划更新 payload 下发；关键词上限沿用 1–300 不变。节点列表对手机加标识与就绪文案。
- `web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx`：新增 `mobileChildRuns`（识别 `execution_task_id` 指向 workflow=`douyin_mobile_discovery` / `feature_key`=`douyin_mobile_discovery` / `source`=`android_runner` 或子任务节点为手机的执行记录），在主报告上方渲染每个手机子任务的 `AndroidChildRunPanel`。
- `web/admin/src/pages/dispatch/cloud-tasks/TaskResultDetailWorkspace.tsx`：识别旧的独立手机发现 run（`workflow`/`feature_key`=`douyin_mobile_discovery` 或 `source`=`android_runner`，无父任务），用同一 `AndroidChildRunPanel`（run id = 任务本身 id）在历史详情里展示。
- `web/admin/src/pages/dispatch/android-discovery/api.ts`：只保留 `detail`/`reprocess` 与 `friendlyError`，删除 `capabilities`/`nodes`/`runs`/`create`/`stop`/`resume`（不再由后台调用）。
- `web/admin/src/pages/dispatch/android-discovery/types.ts`：删除不再使用的 `AndroidNode`、`CreateDiscoveryRun`。
- `web/admin/src/pages/dispatch/android-discovery/presentation.ts`：删除只服务旧弹窗的 `nodeStateLabel`、`canStopDiscovery`、`canResumeRun`；其余（`statusLabel`/`reasonLabel`/`durationLabel`/`runResultLabel`/`safeOriginalUrl` 及文案表）保留供任务详情复用。

删除（旧弹窗世界，全部退役）
- `web/admin/src/pages/dispatch/android-discovery/AndroidDiscoveryEntry.tsx`
- `web/admin/src/pages/dispatch/android-discovery/AndroidDiscoveryPanel.tsx`
- `web/admin/src/pages/dispatch/android-discovery/CreateMobileRun.tsx`（含 1–2 词/固定 20 条上限）
- `web/admin/src/pages/dispatch/android-discovery/MobileRunDetail.tsx`
- `web/admin/src/pages/dispatch/android-discovery/useAndroidDiscovery.ts`

保留复用：`api.ts`(detail/reprocess)、`types.ts`、`presentation.ts`、`RecoveryPanel.tsx`、`DiscoveryCandidates.tsx`。

## UI 行为

- 执行节点区（AgentRail）、节点选择器（AgentPicker）、编排器节点列表：手机与电脑节点并列，带「手机」标识；在线时显示就绪文案（可执行搜索 / 抖音未在前台 / 需解锁 / 手机息屏 / 未连接 / 执行器未就绪 / 原样），离线沿用既有 2 分钟心跳规则（`agent.online`）。
- 新建任务向导：手机可选「关键词采集」「无人值守计划」；执行方式 `single`/`multi` 可选，`平均下发手动采集` 与所有巡查类型对手机禁用并注明「手机节点仅支持关键词搜索发现」。单节点手机走「配置手机搜索发现」按钮进编排器；多节点关键词本来就进编排器。
- 编排器：平台切到小红书或开启多段搜索/负面巡查时，手机自动落为不可选并给出原因（沿用 `keepCompatibleAgents` 去选与 `validSelectedAgentIds` 过滤）。选中手机后出现「手机每词最长时间（分钟）」（默认 15，1–120），仅此项为手机新增；关键词上限仍 1–300；分配预览/下发用 `validSelectedAgentIds`，天然接纳手机。
- 任务详情/历史：手机子任务与旧独立 run 用统一详情块展示四联计数、逐词状态、候选（可展开、可重处理，历史视图为只读）与停稳恢复面板。

## 命令与结果

在 worktree 根目录执行（`web/admin/node_modules` 缺失，已临时软链自 `OnStarvoice-release-v048-20260910/web/admin/node_modules`，其 `package.json` 与本 worktree 完全一致；收尾已删除软链）：

- `npm --prefix web/admin run build`（`tsc -b && vite build`）→ 通过（exit 0，`✓ built`）。
- `npx eslint <全部改动文件>` → 通过（exit 0，0 error 0 warning）。
- `node scripts/check-admin-lint-baseline.mjs` → 通过：`281 errors, 0 warnings（allowed ≤ 288 errors, ≤ 0 warnings）`，未新增 lint 债、无 per-file 回归。
- 触及 dispatch 的既有静态测试全部通过：
  - `node --test tests/cloud-task-center-wiring.test.mjs tests/cloud-task-orchestration-wiring.test.mjs`（29 pass / 0 fail），
  - `tests/admin-platform-safety-attention.test.mjs`、`tests/admin-official-comment-patrol-ui.test.mjs`、`tests/admin-mobile-monitor-dispatch-ux.test.mjs`（合计与前两者一并跑得 47 pass / 0 fail）。
  - 相关断言仍成立：`operationalAgents` 仍匹配 `agent.status === 'active' || agent.status === 'paused'`；`CreateTaskDrawer` 内 `<AgentTaskCreator` 仍恰好 1 处；编排器 `searchFilters` 结构、`1–300 个关键词` 文案未变。

## 尚存风险 / 依赖服务端契约

1. 手机发现详情块依赖服务端 §2.6：`GET /capture-cloud/android/runs/:childId` 需对**编排的手机子任务 id** 也返回 `{run, recovery, items, candidates, events}`。服务端尚未落地前，该块会显示 friendlyError 文案（不影响页面其余部分）。
2. 手机子任务识别依赖 overview/编排详情返回的 agent 带 `capabilities.agentKind`、以及子任务执行记录带 `feature_key`/`metadata.workflow`/`source`（当前服务端 `SELECT child.*` + `publicAgent` 已含这些字段；若服务端重构改了投影字段名需同步）。
3. 就绪文案依赖 overview agents 带 `capabilities.readyForSearch`/`deviceReason`（§2.6 服务端写入）；缺省时显示「手机未就绪」。
4. `mobileKeywordMaxMinutes` 仅在选中手机时下发，服务端负责归一 1–120（§2.4）；后台已做 1–120 整数校验。
5. 历史里的旧独立手机 run 详情块以只读方式复用（`writable={false}`，不显示重处理按钮），因为 `TaskResultDetailWorkspace` 无写权限上下文；编排详情内（实时）为可写、可重处理。
6. 单手机关键词经「配置手机搜索发现」进入编排器后，分配模式默认弹性池（1 个合格节点即该手机）；如需固定分配可在编排器内切换，二者对手机均由服务端 poll 领取（§2.2/§2.3）。
