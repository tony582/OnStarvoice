# 手机节点并入普通调度：实施契约（20260924）

分支 `codex/feat-android-unified-scheduling-20260924`，基线 `a9e5cb1`（含 Runner 0.2.1 hotfix）。目标：手机（`agentKind='android_mobile'`）成为普通调度里的一个抖音节点，不再有单独的“手机发现”入口、1–2 词限制和固定数量上限；电脑侧一键启动。本文是服务端、后台、Runner 三条工作线的共同契约，改动前先读完。

用户已拍板：每词数量跟计划的“帖子上限”走（不填则翻到结果到底，仅保留每词时间兜底，默认 15 分钟）；旧弹窗下线并入普通页面；手机参与弹性节点池和固定分配（“平均下发手动采集”仍是浏览器扩展专属）。

## 1. 不变的部分

- 手机只做抖音**关键词搜索发现**（找链接），正文/作者/评论仍由浏览器节点通过既有 `discovered_post_capture` 补详情入库；候选、事件、入库回执、`detail-dispatch/lifecycle/projection` 链路不改语义。
- 四张共用表：`capture_agents / capture_tasks / capture_task_items / capture_task_item_attempts`；手机不读命令表，只走 `/api/capture-cloud/android/agent/{poll,renew,complete,close}`。
- Runner 的租约（90 s）、单动作 60 s、停稳日志、设备锁、`resumeAuthorized` 语义、`discoveryRunId===taskId` 校验都保留。
- 硬隔离：手机不能领浏览器专属任务（补详情、巡查、手动采集），浏览器不能领手机 run；两者可以执行**同一个**关键词工作项（它是平台无关的“搜索这个词”）。

## 2. 执行模型（服务端）

### 2.1 手机 run = 编排的子任务
浏览器领取关键词时服务端会建一个子 `capture_tasks`（`unattended_keyword_capture`）+ attempt + create 命令。手机领取时同样建**子任务**，但不建命令：

- 子任务：`task_type='capture'`，`feature_key='douyin_mobile_discovery'`，`metadata.workflow='douyin_mobile_discovery'`，`platform='douyin'`，`source='android_runner'`，`parent_task_id=<编排 parent>`，`orchestration_revision`，`assigned_agent_id/origin_agent_id=<手机>`，`metadata` 含 `deviceId, filters, budgets, deadlineAt, planSnapshot(裁成本子任务关键词), scheduleId/scheduledFor(若有)`。
- 工作项：编排 parent 的 `capture_task_items` 行，绑定 `execution_task_id=<子任务>`、`assigned_agent_id`、`assignment_revision+1`、`request_hash`、新 attempt（`parent_task_id=parent, execution_task_id=child`）。
- **run id = `execution_task_id`（子任务）**，parent = `item.task_id`。`services/android-control/*` 与 `capture-discovery/{lineage,state,management}.js` 里所有把 `item.task_id` 当 run 的地方改为 `execution_task_id`；旧的独立 run（`createRun`）里 `execution_task_id=task_id`，因此旧数据不受影响。`taskIdentity()` 的 `taskId/discoveryRunId` = 子任务 id。
- `currentAttempt()` 的校验从 `parent_task_id=$4 AND execution_task_id=$4` 改为 `attempt.execution_task_id=<run> AND attempt.parent_task_id=item.task_id`。

### 2.2 领取（poll）
`poll()` 在手机无持有项且 `readyForSearch=true` 时，按顺序找一条工作项（同一事务，`FOR UPDATE SKIP LOCKED`，仍先 `lockAgent`）：

1. **已分配给本机的项**（固定分配或旧独立 run）：`execution_task_id` 指向 workflow 为 mobile 的子任务、`assigned_agent_id=本机`、`status IN ('pending','retryable')`，子任务未停止。
2. **弹性池项**：parent `task_type='capture_orchestration'`，`status IN ('pending','running')`，`platform='douyin'`，`metadata.distributionMode='elastic_pool'`，`metadata.stopRequested/operatorStopped/stopPending` 均非 true，`item_type='keyword'`，`status IN ('pending','retryable')`，且（`metadata.pinnedAgentId=本机` 或（无 pinned 且 `metadata.eligibleAgentIds` 含本机））；沿用浏览器弹性领取的 attempt 上限（`attempt_count < 3`、同账号安全码栅栏、无未结束 execution）。命中后按 2.1 建子任务（1 个词）并绑定。
3. 本机对同一项的**再次**领取（`retryable` 且上一 attempt 是本机）自动带 `resumeAuthorized:true`（服务端已核对归属，这正是 Runner 要求的“调用方核对云端归属”）。

不领取的情形：planSnapshot 带多段 `searchPasses`、`negativePatrol.enabled`、`publishTime='month'`、平台非抖音。

### 2.3 固定分配
调度器 `materializeOccurrence` 与 `POST /orchestrations/:id/dispatch` 的 fixed_batch 分组：agent 为手机时，建一个手机子任务（workflow mobile，含该组全部词），把组内项绑定到子任务（`execution_task_id`、`assigned_agent_id`、`status='pending'`、`assignment_revision+1`、attempt 可在 poll 逐项领取时再建），不建 create 命令；随后由 2.2 第 1 类逐词领取。`agentFailure()` 对手机改为：租户/授权/绑定有效，`mobileSearchDiscoveryV1===true`，平台=抖音在 `allowed_platforms` 与 `supportedPlatforms`，计划无多段搜索、无负面巡查、`publishTime!=='month'`；不再要求 `remoteTaskCreate/remoteTaskKeywordPostLimit/remoteTaskEnhancementOptions`。

### 2.4 筛选与预算（发给 Runner 的 task）
`taskPayload` 形状不变：`{identity, deviceId, keyword, filters, budgets, deadlineAt, resumeAuthorized}`。

- `filters` 由 planSnapshot.searchFilters 映射：`{sort: 'comprehensive'|'latest'|'likes'|'comments'|'collects', publishTime: 'all'|'day'|'week'|'halfyear', contentType: 'all'|'image'|'video'}`；旧独立 run 的 `{sort, range:'day'}` 继续可发（Runner 兼容）。
- `budgets`：`maxLinks = planSnapshot.keywordMaxDetectedItems`（未设则 `0` = 不限）；`maxCards=0`、`maxSwipes=0`（不限，靠“结果到底/无新卡片”和时间兜底结束）；`keywordMs = (planSnapshot.mobileKeywordMaxMinutes ?? 15) * 60000`（服务端归一 1–120）；`batchMs = keywordMs × 组内词数 + 5 分钟`；`maxPending=100`。`runInput()` 里的 `v <= limits[k]` 上限校验删除，只校验非负整数。
- `deadlineAt`：子任务首次领取时 = now + batchMs（弹性 1 词 = keywordMs + 5 分钟）。租约仍 min(90 s, deadline)。

### 2.5 完成与回滚
- `complete()` 的项状态投影保留，并追加：设备已空闲（`deviceIdle=true`）且非终态成功时，若 `attempt_count < 3` 且 parent 未停止 → `retryable`（可被本机或其它合格节点再领），否则 `needs_action`；`deviceIdle=false` 仍 `needs_action + deviceHeld`。
- 子任务属于编排时，`rollup` 之后调用 `refreshOrchestrationParentTask`（`server/routes/capture-cloud.js:4491`，需导出或搬到 service）让 parent 进度/状态与浏览器子任务一致。
- 编排 parent 的停止（`POST /tasks/:id/stop`、orchestration stop）要把手机子任务一并置 `metadata.stopRequested=true`（复用 `controlRun(...,'stop')` 的语义，不再依赖 `remoteStop` 命令）；`control()` 在 poll/renew 时同时看子任务与 parent 的停止标记。
- `requireBrowserTaskControl` 对编排 parent 不再因为含手机子任务而拒绝。
- 服务端实现说明（20260924）：`retryable` 投影仅对编排子任务（`metadata.orchestrationChild`）生效；独立 `/android/runs`（`execution_task_id=task_id`）保留旧 `needs_action + 显式 resume` 语义，避免破坏既有独立 run 契约。编排 parent 停止在 `POST /orchestrations/:id/stop`（关键词编排的实际停止入口，非 `/tasks/:id/stop`）里处理手机子任务：置子任务 `metadata.stopRequested=true`，未持有设备的子任务当场 `canceled`，持有设备的保留待手机经 complete/close 确认；`requireBrowserTaskControl` 未改（编排 parent 的 workflow 非 mobile，本就放行，手机独立 run 仍拒绝）；`refreshOrchestrationParentTask` 已在 `server/routes/capture-cloud.js` 导出并由手机 complete 动态引入调用。`runInput` 的 `ONE_OR_TWO_KEYWORDS_REQUIRED` 落地为新码 `KEYWORDS_1_TO_300_REQUIRED`。

### 2.6 节点信息
- poll 请求体新增可选 `reason`（Runner 的 deviceReason）与 `probe`（`{foreground:{package,activity,launched}, checkedAt}`，有界）；服务端写入 `capabilities.readyForSearch/deviceReason/deviceProbeAt`。
- `GET /capture-cloud/overview` 的 agents 含手机节点（不过滤），带 `capabilities.agentKind/deviceId/readyForSearch/deviceReason`。
- `GET /capture-cloud/android/runs/:id` 继续可用，且对编排的手机子任务 id 也返回 `run/recovery/items/candidates/events`（后台在任务详情里用它显示“手机发现 → 补详情”进度）。`/android/capabilities`、`/nodes` 保留；`POST /android/runs` 保留兼容但后台不再调用，`ONE_OR_TWO_KEYWORDS_REQUIRED` 改为 1–300。

## 3. 后台（web/admin）

- 删除 `DispatchPage` 里对 `agentKind==='android_mobile'` 与 `workflow==='douyin_mobile_discovery'` 的过滤；`AndroidDiscoveryEntry` 弹窗从工具栏移除并删除不再使用的组件（`CreateMobileRun`、`AndroidDiscoveryPanel`、`useAndroidDiscovery` 等）；`DiscoveryCandidates`、`RecoveryPanel`、`presentation.ts` 可保留供任务详情复用。
- `agentAssignmentBlockReason/agentTaskTypeBlockReason`：手机节点不看 `remoteTaskCreate/remoteUnattendedPlanWrite`，要求 `mobileSearchDiscoveryV1`；只允许 `keyword` 类型（一次性与无人值守计划，执行方式 single/multi），`manual_average`、各类巡查对手机返回“手机节点仅支持关键词搜索发现”。
- 节点展示（`AgentRail`、`AgentPicker`、composer 节点列表）：手机带“手机”标识与就绪文案：`readyForSearch=true`→“可执行搜索”，否则按 `deviceReason` 映射（`douyin_not_foreground` 抖音未在前台 / `device_locked` 需解锁 / `device_asleep` 手机息屏 / `device_missing` 未连接 / `appium_not_ready` 执行器未就绪 / 其它原样），离线沿用 2 分钟规则。
- `OrchestrationComposerDrawer`：平台小红书→手机不可选并说明原因；抖音多段搜索或负面巡查→手机不可选；新增可选字段“手机每词最长时间（分钟）”默认 15（payload `mobileKeywordMaxMinutes`），仅在选了手机时显示；关键词上限沿用 1–300。
- 任务详情（`OrchestrationDetailWorkspace`）：手机子任务/工作项显示“手机发现 N、待补详情 N、已入库 N、失败 N”，展开可看候选并使用既有重处理接口；停稳/恢复状态复用 `RecoveryPanel`。
- `tsc -b` 与 `npm --prefix web/admin run build` 必须通过；改动组件跑 lint。

## 4. Runner（runners/android）

- `budgets` 允许 `0` 表示不限（`maxLinks/maxCards/maxSwipes/batchMs`）；`BudgetLedger` 的 `assertAllowed/beforeCard/beforeSwipe` 对 0 不设限；`keywordMs` 仍必须 >0。旧 checkpoint 兼容。
- `filters`：接受 `{sort, publishTime, contentType}` 与旧 `{sort, range:'day'}`；`profile-adapter.search()` 映射到已校准的抖音标签：sort→综合排序/最新发布/最多点赞/最多评论/最多收藏；publishTime→不限/一天内/一周内/半年内；contentType→不限/图文/视频；不支持的值抛 `unsupported_search_filters`。`douyin-flow.search()` 放开对应白名单，读回校验保持逐组核对。
- poll 请求体带 `reason` 与 `probe` 摘要。
- **一键启动**：`cli.mjs up --state-dir DIR`：① `adb start-server`；② 若 Appium `/status` 不可用则按 `connection.json` 的 `appiumLaunch`（`{node, entry, args, env:{JAVA_HOME, ANDROID_HOME, APPIUM_HOME}}`，setup 时从 `--appium-launch-file` 或本机 `~/.local/share/starvoice/android-toolchain/run-appium.sh` 推导写入）拉起子进程并等待就绪；③ 无 `connection.json` 时交互式提示输入激活码走 `setup`（激活码只读一次，不落盘）；④ 运行 daemon，终端每次探测变化打印一行人话状态（“手机已连接 / 抖音在前台 / 已上线，可在调度中心下发任务”或原因）；⑤ SIGINT/SIGTERM/窗口关闭 → 请求停止 → 等 daemon 结束 → 结束 Appium 子进程 → 打印停稳结果。`runners/android/launcher/StarVoice 手机采集.command`（macOS 双击，`chmod +x`）调用它；文档写清首次用法。不做常驻服务。
- 测试：预算 0=不限、筛选映射、`up` 的子进程编排（用假 Appium/adb）、首次注册提示；`npm --prefix runners/android test` 串行通过，边界检查通过。

## 5. 分工与纪律

| 线 | 目录 | 负责 |
| --- | --- | --- |
| 服务端 | `server/**`、`tests/**`（服务端测试） | 2.x 全部，含迁移（如需）、单元/隔离 PG 测试 |
| 后台 | `web/admin/**` | 3 全部 |
| Runner | `runners/android/**` | 4 全部 |

- 三线并行改同一 worktree，只改自己目录；契约有歧义先在本文档对应段落补一句再改代码，不要私改别线目录。
- 不 `git commit/checkout/stash/reset`，不推送，不部署，不碰生产（本机 `/Users/dulaidila/Documents/claude/StarVoice-Android` 及其 sqlite/进程只读）。
- 服务端测试需要依赖时用 `ln -s /private/tmp/onstarvoice-plan-visibility-20260924/server/node_modules server/node_modules`，完成后删除该符号链接。
- 每线结束交付：改动文件清单、行为说明、测试命令与结果、尚存风险，写入 `docs/hotfix/20260924-android-unified-scheduling-<server|admin|runner>.md`。
