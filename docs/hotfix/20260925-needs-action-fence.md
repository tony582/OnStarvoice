# 「需要处理」的停止保护：批次子任务由后台确认放行，本机「继续」不再死路（设计与实现）

分支：`codex/hotfix-needs-action-fence-20260925`（工作区 `OnStarvoice-hotfix-needs-action-fence-20260925`）。基线：`2a99bb1`，即生产 `9b836f6`（2026-09-25 19:43 部署：停止保护闭环的服务端 + Admin，以及 Android controlError 修复）加一条文档提交。Extension 0.4.16 的代码已在树里但**未发布**：`manifest.json` 仍为 0.4.15，节点实际运行 0.4.14/0.4.15。

本文最初是设计稿。代码已按本文实现：服务端 + Admin、Extension 两个领域各经过两轮评审，并做了集成验收（2026-09-26）。实现与设计不同的地方以下一节「实现结果与集成验收」为准；正文只在关键处改成最终行为，其余保留设计原文。分两批发布：服务端 + Admin 先发（发布包见「发布包」）；Extension 部分并入 0.4.16 一起发布。不新增数据库迁移。前一份文档 `docs/hotfix/20260925-stop-fence-closure.md` 下称「闭环文档」。文中行号以 `2a99bb1` 为准，均为“约”值。

## 实现结果与集成验收（2026-09-26）

代码尚未提交（工作区改动，基线 `2a99bb1`）。发布包里的哈希就是下列文件当前的内容；提交时这些文件必须逐字节不变，`finalize.sh` 会逐项核对。

### 改动文件

| 领域 | 文件 | 内容 |
|---|---|---|
| 服务端 | `server/services/capture-stop-fence.js` | `stopFenceOperatorReleasable`、`stopFenceReleaseDisposition`、`stopFenceReleaseItemOutcome`、`stopFenceReleaseOutcomeSentence`、`STOP_FENCE_PARENT_TERMINAL_STATUSES`；列表 2 列；概览新字段；两条放行路径共用的 `buildStopFenceReleaseRecord`；阶段文案；导出 `appendStopFenceEvent`、`enqueueStopFenceReleaseWakeup`、`RECONCILED_EVENT_MESSAGES` |
| 服务端 | `server/services/capture-stop-fence-release.js`（新文件） | `releaseNeedsActionStopFences`、`readNeedsActionReleaseItemOutcome`、`recordNeedsActionStopFenceOutcome` |
| 服务端 | `server/routes/capture-cloud.js` | 确认接口、错误文案、本机接管守卫、远程「继续」守卫 |
| 服务端 | `server/routes/capture-orchestrations.js` | `stopFenceReleasedRetrySource` 三处（`retry-items`、待派重试扫描 SQL、加锁复核） |
| Admin | `web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs`、`.d.mts`、`StopFencePanel.tsx`、`OrchestrationDetailWorkspace.tsx` | 可放行任务、确认 id、文案、对话框、批次卡片 |
| Extension（随 0.4.16） | `background.js`、`sidebar/sidebar-logic.js` | 孤儿围栏轮次与归档来源的终局说明；侧栏中文说明 |
| 测试 | `tests/capture-stop-fence.test.mjs`、`tests/admin-stop-fence-{confirm-contract,panel,presentation}.test.mjs`、`tests/cloud-task-center-wiring.test.mjs`、`tests/background-capture-lock.test.mjs`、`tests/background-stop-confirmation.test.mjs`、`tests/integration/postgres/stop-fence-closure.integration.mjs` | 见「验收数据」 |

`manifest.json`、`server/routes/update-manifest.js`、`public-downloads/` 都没动。

### 跨端契约（集成逐项核对，三端一致）

| 项目 | 取值 |
|---|---|
| 概览字段 | `agents[].stop_fence.operator_confirmable_task_ids`（不受 20 条限制）、`operator_confirmable_count`；`tasks[].operator_confirmable`、`tasks[].release_disposition`（`return_to_pool` / `batch_retry` / `parent_stopped` / `unknown`）。`phase` 仍为 `task_action_required`。Admin 只认这些字段（`.d.mts` 同名），服务端不发时行为与之前完全一样 |
| 确认接口 | 请求体不变 `{confirmation:'确认旧页面已停止', expectedTaskIds, note?}`；Admin 发送 `confirmTaskIds` = 已转交 id（列出的 ∪ `superseded_task_ids`）∪ 可放行 id（列出的 ∪ `operator_confirmable_task_ids`）。响应新增 `needsActionTaskIds`、`itemOutcomes`；`requiresTaskAction[]` 每项加 `operatorConfirmable`、`skipReason`（`not_selected` / `command_in_flight` / `not_releasable` / `not_orchestration_child`）。Admin 直接显示服务端 `message` |
| 放行记录 | `status='superseded'`；`error.code='HISTORICAL_STOP_FENCE_RECONCILED'`、`originalCode='PREVIOUS_CAPTURE_STOP_UNCONFIRMED'`、原文案保留；`metadata.historicalStopFenceReconciliation` 为先例字段加 `releasedFromStatus:'needs_action'`、`itemOutcome`；`metadata.terminalReason='stop_fence_operator_released'`；**没有** `terminalDisposition`；事件 `historical_stop_fence_reconciled`（`actor_type='user'`，payload 加 `releasedFromStatus`、`itemOutcome`）；审计 `capture_agent.stop_fence_confirmed` 加 `needsActionTaskIds`、`itemOutcomes`、`skipped` |
| 工作项 | 错误码 `PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED`（不是围栏码，也不在 `ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES` 里）；弹性 → `retryable`（到预算 `failed`），固定分配 → `needs_action`，批次已停止 → 不动 |
| 本机释放（0.4.16） | 与 `superseded` 放行同一套：`stopFenceCheck.localRelease` → 心跳 `release_only`（期间暂停派发）→ 扩展关闭 R 的 runner、按精确身份释放锁，写 `stopFenceClosure` → 侧栏「继续」得到 `stop_fence_released_to_cloud` |
| 远程「继续」 | 服务端对带围栏的 `needs_action` 批次子任务返回 409 `task_stop_fence_operator_release_required`，不建指令。0.4.16 让已存在的 `resume` 指令以 `accepted:false` + `message` 完成；服务端把 `resume_requested` 改回 `needs_action`，`error` 不动（围栏码保留），任务重新可放行 |
| 中文文案 | 按钮名「确认旧页面已停止」在服务端阶段文案、409 文案、远程继续文案、Admin 面板/对话框、扩展侧栏说明里一致。Admin 说“节点侧栏点「继续」会报 checkpoint_flush_not_ready，或提示到后台处理”，对旧版（原始原因码）和 0.4.16（中文说明）都成立；对话框说“节点侧栏里该任务仍显示「需要处理」，不必再点「继续」”，与扩展行为一致 |

### 与设计不同的最终行为

服务端：

- 放行函数放在新文件 `server/services/capture-stop-fence-release.js`，发布包因此多一个新文件。
- **放行不写 `terminalDisposition` / `terminalDispositionAt`**（评审第 1 轮两位评审都发现）。见「放行写入」第 3 步。反向验证：把这两行加回去，集成子测试 21、28、29 失败（批次停在 `waiting_device`）。
- 只选了 `needs_action` 行、一行都没放行时不写审计：有在途指令返回 409 `agent_stop_fence_command_in_flight`（新错误码，文案“该节点待确认的任务正在执行后台指令（例如停止），请等指令完成后再确认”，带 `requiresTaskAction`）；否则返回 409 `agent_stop_fence_changed`。
- `itemOutcome` 多一个 `parentStopped`。`kind='none'` 且父任务没停时，去向句为“没有需要交回的未完成关键词，本次只解除停止保护”。
- 远程「继续」守卫随本批实现，与其它改动同在 `capture-cloud.js`。

Extension（随 0.4.16）：

- 平台页不算存活迹象：不再查 `request.runnerTabId`、`request.progress.runnerTabId`；runner 只按 URL 认，含 `pendingUrl`（见「改动」第 1 条）。
- 归档来源给终局说明（见「改动」第 1 条）；`source_local_closure_unverifiable` 有自己的永久文案（见第 3 条）。
- 残留边角（不改）：锁持有状态为 `unknown`（没有 `chrome.runtime.getContexts` 或锁没有 `holderDocumentId`）时退回看 `holderTabId`；runner 刷新接续类围栏里这可能正是平台页，结果保守地保持 `deferred`。

Admin：与设计一致。对话框另写“另有 N 个「需要处理」的批次任务未列出，本次确认一并放行”（`unlistedReleasableCount`）。

评审中发现、本次不修的既有问题：普通弹性接力置 `superseded` 的子任务（`terminalReason='elastic_retry_claimed'`，routes 约 8018）带 `terminalDisposition`，同样会让被「停止整个任务」的批次停在 `waiting_device`。评审在基线代码上复现过，与本次改动无关。

### 验收数据

环境：Node 18.20.8（生产）与 24.12.0；服务端依赖经 scratch 只读解析垫片（`register18.mjs`）加载，`@resvg/resvg-js` 用桩；Admin 测试的 `typescript` 来自 eas-cli（`NODE_PATH`）；PostgreSQL 17.9 一次性实例（`--locale=C`，只监听 127.0.0.1）。基线为 `git archive 2a99bb1`，候选为基线加工作区改动的副本，两边 `server/node_modules`、`web/admin/node_modules` 链接相同，命令相同。

| 检查 | 候选 | 基线 2a99bb1 | 结论 |
|---|---|---|---|
| `node --check`，Node 18 与 24 | 4 个服务端文件和 `stop-fence-presentation.mjs` 按模块通过；`background.js` 按经典脚本通过（manifest 的 service worker 不是模块）；`sidebar/sidebar-logic.js` 按模块通过（`sidebar.html` 用 `type="module"` 加载） | – | 通过 |
| 完整回归 `scripts/run-node-regression-tests.mjs` + 垫片，Node 24 | 2765 项，2747 过，18 失败 | 2738 项，2720 过，18 失败 | 失败名单逐项相同 |
| 同上，Node 18 | 2765 项，2747 过，18 失败 | 2738 项，2720 过，18 失败 | 失败名单逐项相同，且与 Node 24 相同 |
| PostgreSQL 集成全套（46 个文件，Node 18，`--test-concurrency=1`） | 328 项，311 过，17 失败 | 318 项，301 过，17 失败 | 失败名单逐项相同 |
| `stop-fence-closure.integration.mjs` | 30/30 子测试 | 20/20 | 新增 10 个子测试全过 |
| `historical-stop-fence.integration.mjs` | 21/21 | 21/21 | 不变 |
| Admin `tsc -b` + `vite build`（Node 24.12.0，vite 8.0.16） | 通过，index `a3c913d7…`，两次构建逐字节相同 | 对照构建与生产 `9b836f6` 的 dist 逐字节相同（index `8161b52f…`） | 工具链可复现 |

环境失败（四次完整回归相同，17 个名称，其中一个名称计了两次）：6 个整文件失败（`admin-navigation-public-filters`、`android-control-route`、`capture-discovery-route`、`capture/douyin-blogger-profile-scope`（工作区没有 `extension-build/`）、`customer-assistant-boundary`、`public-downloads`），7 个报表 PNG/SVG 测试（resvg 桩），4 个进程角色测试（子进程不带垫片）。与 2026-09-25 闭环发布前的环境失败名单相同。PostgreSQL 的 17 个失败：6 个整文件（`customer-daily-{delivery,email,http}`、`record-relevance-filter`、`record-triage-admission`、`triage-handled-date`）、5 个顶层测试（Android 任务控制、会话锁、客服助手、兼容入口、拆分进程）和其中 6 个子测试，原因都是子进程找不到 `pg`/`dotenv` 或 CJS 缺 `exceljs`。

改动相关的测试文件（Node 18 与 24 结果相同，候选 677/677，基线 650/650）：

| 文件 | 候选 | 基线 |
|---|---|---|
| `capture-stop-fence` | 16/16 | 11/11 |
| `server-capture-cloud-contract`（围栏 SQL 文本逐字不变的断言保留） | 114/114 | 114/114 |
| `admin-stop-fence-confirm-contract` | 3/3 | 2/2 |
| `admin-stop-fence-panel` | 5/5 | 4/4 |
| `admin-stop-fence-presentation` | 29/29 | 24/24 |
| `cloud-task-center-wiring` | 21/21 | 21/21 |
| `background-capture-lock` | 329/329 | 316/316 |
| `background-stop-confirmation` | 57/57 | 55/55 |
| `unattended-keyword-run` | 28/28 | 28/28 |
| `capture-recovery-intents` | 44/44 | 44/44 |
| `server-capture-orchestration-route` | 29/29 | 29/29 |
| `update-manifest` | 2/2 | 2/2 |

`stop-fence-closure` 新增的 10 个集成子测试：旧节点放行弹性子任务、关键词回任务池；0.4.16 节点先释放本机锁再接新任务；固定分配子任务结束、关键词可「重试失败关键词」；弹性到接力上限按技术失败收尾且可重试；只放行显式选中且没有在途指令的批次子任务；本机续跑不接管已退回的关键词；远程「继续」拒绝带围栏的批次子任务、根任务照常；批次已停止时只解除围栏；放行后再停止整个任务，批次在其它执行停下后能结束；本机恢复接管的子任务按弹性父任务交回。

领域内的反向验证（集成没有重跑）：服务端把 `terminalDisposition` 写回去，3 个子测试失败；扩展三个变体（加回按标签页 id 认 runner、去掉归档分支、去掉 `pendingUrl`）分别有 3、2、1 个测试失败。

### 发布包（服务端 + Admin）

本地目录：`scratchpad/needsaction/stage/needs-action-fence-__COMMIT__-20260925/`（会话 scratch，`__COMMIT__` 是占位符）。生产目录：`/opt/onstarvoice-private/releases/needs-action-fence-<短 sha>-20260925`，锁文件 `/opt/onstarvoice-private/needs-action-fence-<短 sha>-release.lock`。

| 文件 | SHA-256 / 说明 |
|---|---|
| `server.tar.gz`（4 个文件，ustar，root 属主） | `edf6516512966a7990c3aa918433e6de402e1e0c8c8dc9357bd4b9b07a615898` |
| `admin-dist.tar.gz`（11 个文件） | `c9ceb43e36c78c7ff90535106141b8e17add931b08814cc58b763decdfdf6176` |
| `deploy.sh` | 见下；占位符未替换时拒绝运行 |
| `release-manifest.json` | 前置条件、文件哈希、验收摘要 |
| `admin-files.sha256`、`admin-source.sha256` | dist 各文件哈希；构建所用 `web/admin` 源码（158 个文件）的哈希 |
| `finalize.sh`（在 stage 上一级，不上传） | 见「上线顺序」第 2 步 |

替换的文件（前置条件 = 生产 `9b836f6` 的内容 → 新内容）：

| 文件 | 生产现值 | 新值 |
|---|---|---|
| `server/routes/capture-cloud.js` | `a799cbbc…af425` | `bc6012ca69d3524d743222ca1305c8a919e1cff27e9da87ce8092e174cccf545` |
| `server/routes/capture-orchestrations.js` | `fffac8b9…48874` | `2ffa4f96e8b79a421cbd8f5dcc4821d2b9153ff25324dc33a0fad2095378363b` |
| `server/services/capture-stop-fence.js` | `a1324184…7a97b` | `f292651b4a9fbee55bf14130294eb9f049de7fa2dc425eda4a646362fedc8703` |
| `server/services/capture-stop-fence-release.js` | 必须不存在 | `973ddc05a0af308ccc2bf6a325175ce604ab576e484dca561bc3f0f56f3ea1ae` |
| `web/admin/dist/index.html` | `8161b52f…72491` | `a3c913d77ae8d2caa258bbd8f173abff4384e3ec66a237e5e44303fb4f5ff1d9`（主脚本 `index-ReIv9uG5.js`） |

Admin 资源：新增 `ChinaMap-DjdZCOof.js`、`DesktopApp-DelPgcXx.js`、`MobileApp-DKfdAsxA.js`、`ThemeToggle-g8gpPr2h.js`、`index-ReIv9uG5.js`；`ThemeToggle-KozaqHdl.css`、`index-BVaxzkpi.css`、`officialCommentPatrolPreview-7eK_DOcv.js` 生产上已有且逐字节相同；`favicon.svg`、`icons.svg` 不变。旧资源一律保留。

`deploy.sh` 与 `9b836f6` 的脚本同构：`--check` 只读核对（两个包的哈希、生产 3 个文件和 Admin index 为 `9b836f6` 版本、新模块不存在、pm2 在线、健康检查、`/api/update-manifest` 仍为 0.4.15 且指向现有 zip）；部署时校验包内恰好这 15 个文件及各自哈希，Node `--check` 4 个服务端文件，备份，先加 Admin 资源，再切 index、先放新模块再替换 3 个文件，`pm2 restart onstarvoice`；之后核对进程确实重启、服务端文件与 Admin index 逐字节为本版、`/admin/` 与 8 个资源逐字节可取、update-manifest 与 `public-downloads` 不变。切换后任何失败或 INT/TERM/HUP 都自动回滚：恢复 3 个文件和 index、删除新模块、重启并等健康检查；新 Admin 资源保留但不被引用。

部署脚本模拟（模拟 `/opt/onstarvoice` = 生产 `9b836f6`：服务端取自 `2a99bb1`，Admin = `68c32ba` 的 dist 加保留的 `9b836f6` 资源和 index `8161b52f`；Node 18 真实加载整个 app，pm2 用替身；`sha256sum`、`find -printf`、`flock` 用 GNU 语义替身）：

| 场景 | 结果 |
|---|---|
| 未替换占位符的 stage | `--check` 和部署都退出 1，“release commit placeholder not set”，不建锁、不改任何文件 |
| 原样 `--check` | 通过，树不变 |
| 漂移：`capture-stop-fence.js`、`capture-orchestrations.js` 被改；`capture-cloud.js` 还是 `68c32ba`；新模块已存在；新模块是悬空链接；update-manifest 为 0.4.16；Admin index 为 `68c32ba`；pm2 停止 | 8 个场景 `--check` 与部署都拒绝，树不变，未重启 |
| 正常部署 | 退出 0；4 个服务端文件与 index 为新值；Node 18 加载新路由模块成功；`/admin/` 返回新 index；树的差异恰好是 3 个替换、1 个新增、index 和 5 个新资源；无残留临时文件 |
| 部署后重跑 | 拒绝（前置哈希不再匹配），树不变 |
| 按备份手工回滚 | 服务恢复，`--check` 重新通过；与原样相比只多 5 个未引用的新资源 |
| 自动回滚：重启后健康检查失败；某个新资源取回内容不符；重启时收到 SIGTERM、SIGHUP；routes 目录只读 | 均恢复为 `9b836f6`（只读场景提示“ROLLBACK INCOMPLETE，请人工检查”，实际文件未被替换），服务就绪；之后 `--check` 通过；再次部署因 `backup/` 已存在被拒 |
| 生产已有同名资源内容不同 | 切换前拒绝，未重启，服务端与 index 不变（已拷入的新资源不被引用） |
| 发布锁被占用 | 部署和 `--check` 都拒绝 |
| `finalize.sh` | 拒绝短 sha、拒绝不含 `2a99bb1` 的提交（`9b836f6`）、拒绝服务端文件不同的提交（`2a99bb1`）；模拟用的替换只改占位符 |

### 等 0.4.16 一起发布的扩展改动

本次只发服务端 + Admin，节点收不到任何新代码。以下扩展改动已在树里，随 0.4.16 发布：

- 本修复：`background.js` 的 `classifyOrphanedStopFenceAttempt`、`isStopFenceBlockedNeedsAction`、`describeStopFenceOperatorGuidance`、`UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX`、`inspectUnattendedCheckpointOutboxAttempt` 的 `anyAttempt` 选项、`prepareUnattendedManualRecoverySource` 的两个终局分支（孤儿围栏轮次、归档来源）、`manuallyRecoverUnattendedKeywordRun` 的 `final` / `message`、`summarizeCloudRecoveryResult` 优先取 `result.message`、恢复消息响应带 `message`；`sidebar/sidebar-logic.js` 的 `describeUnattendedRecoveryFailure` 和 warning 提示。
- 闭环文档的 0.4.16 扩展代码（`5d7440c`：`background.js`、`content-v2.js`、`utils/cloud-task-agent.js`），同样尚未发布。
- 发布 0.4.16 时：`manifest.json` 改为 0.4.16，`update-manifest.js`、`about.html`、`tests/update-manifest.test.mjs` 的日期一起改；`bash scripts/sync-extension-build.zsh production` 同步 `extension-build/`，`scripts/package-extension.zsh` 重新打包，记录新的 SHA-256。此前的 0.4.16 包（`11034af1…`）作废。

## 现场（2026-09-25，节点 金星，Chrome 扩展 0.4.14）

弹性批次 `e768a43f`（小红书~日常巡检-提前跑版本 · 09/25 20:05），仍在运行中。子任务 `1363ff0e`（`unattended_keyword_capture`，关键词「檐下秋意」，完成 8/20）：

| 时间 | 事件 |
|---|---|
| 20:36 | `running` |
| 21:40:47 | `recovering`，原因“运行页心跳中断” |
| 21:41:08 | `needs_action`，`error.code = PREVIOUS_CAPTURE_STOP_UNCONFIRMED`，文案“旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续”。没有接力，不是 `superseded` |

此后：

- 节点被准入挡住，不再接单。
- 后台 `StopFencePanel` 显示「旧采集页面未确认停止 · 请处理该任务」和“1 个旧任务仍待处理；停止或接力后本节点即可继续接单或进入自动核对 … 在任务或批次里点「继续」或「停止」”。「让节点重新核对」「确认旧页面已停止」两个按钮都置灰，这是闭环文档的设计：只有 `superseded` 围栏能放行。
- 节点侧栏任务中心显示「需要处理」，有「继续剩余任务」「跳过当前项」。点「继续」弹出“恢复任务失败: checkpoint_flush_not_ready”。

用户原话：“两边都操作不了”。

## 根因：两边都是死路

### 后台：放行只认 `superseded`，批次里也没有出口

- **设计假设不成立。** 闭环文档不变量 3 写明“只放行 `superseded` 行；`needs_action`/`failed`/`interrupted` 仍由节点负责”。前提是节点能自己「继续」或「停止」一个 `needs_action` 任务。对根任务成立，对批次子任务不成立（见下一节）。
- **代码位置：**
  - 确认接口 `POST /agents/:id/stop-fence/confirm`（`server/routes/capture-cloud.js` 约 11706–11832）只放行 `status='superseded'` 的行（约 11722）。一行都没有时返回 409 `agent_stop_fence_task_action_required`（约 11724–11730），`needs_action` 行只在 `requiresTaskAction` 里列出（`stopFenceRequiresTaskAction`，约 11598）。重新核对接口同样处理（约 11629–11637）。
  - `summarizeAgentStopFence`（`server/services/capture-stop-fence.js` 约 720）在没有 `superseded` 围栏时给出阶段 `task_action_required`（约 741）。
  - Admin：`canConfirm = blocking && supersededCount > 0 && …`（`stop-fence-presentation.mjs` 约 384）；`recheckState` 把 `task_action_required` 设为不可核对（约 335）；文案一律指向「继续」或「停止」（约 19–22、285–286；`StopFencePanel.tsx` 约 174）。
- **批次一侧同样拒绝：**
  - 弹性派发只领 `item.status IN ('pending','retryable')` 的工作项（routes 约 7397）。子任务是 `needs_action` 时，心跳投影把当前关键词的工作项写成 `needs_action` 并带上围栏码：`projectElasticKeywordRecoveryStatus` 的围栏分支（约 1258–1260）；未开始的工作项写成 `needs_action`，原因为 `blocked_by_prior_item` 等（约 6440–6453）。
  - `classifyCaptureRecoveryDisposition` 把带围栏码的工作项判为 `manual_current`（约 1109），不自动重试。
  - 父任务把 `needs_action` 当作非终态（`capture-orchestration.js` 约 898–950），整批永远结束不了。
  - 批次「重试失败关键词」返回 `retry_source_not_settled`（`capture-orchestrations.js` 约 5802；`HANDOFF_SOURCE_FINAL_STATUSES` 约 63–70 不含 `needs_action` 和 `superseded`）。「接力」返回 `handoff_source_not_settled`（约 6502）。
  - 批次里单个执行的「继续/停止」只在有安全验证证据时出现。
- **两个页面互相指路。** 批次详情写“请在「执行节点」中处理”（`OrchestrationDetailWorkspace.tsx` 约 2166），节点面板写“在任务或批次里点「继续」或「停止」”。
- **绕过界面调 API 也不行：**
  - 「继续」（`/tasks/:id/resume`，约 16053）会建一条 `resume` 指令，默认 30 天过期（`032_cloud_capture_task_center.sql:177`），任务变为 `resume_requested`（占用执行槽）。节点执行时报 `checkpoint_flush_not_ready`，结果标为 `deferred`，指令永不完成（`background.js` 约 7155–7170；0.4.14 `3043c9c`、0.4.15 `dcec6cb` 同样）。要等过期才恢复成 `needs_action`（约 2384–2410）。
  - 单任务「停止」（`/tasks/:id/stop`，约 16819）能用：节点取消请求、释放本机锁，服务端置 `canceled`，围栏随之解除。但工作项也被置为 `canceled`，关键词丢失，不回任务池（约 9910–9990）。界面不给弹性子任务单独的「停止」。
  - 「停止整个任务」**不停止**这个子任务。`ORCHESTRATION_STOPPABLE_EXECUTION_STATUSES`（`capture-orchestrations.js` 约 108–119，约 3821–3839 使用）不含 `needs_action`（只有 `negative_post_patrol` 例外），所以子任务既不发 `stop` 指令，也不算“保留中的执行”。它名下未完成的工作项在服务端直接被置为 `canceled`（约 4096–4112），父任务变为 `canceled`（有其它保留中的执行时为 `waiting_device`）。子任务仍是 `needs_action` + 围栏码，节点照样被挡。也就是说，这条路关键词丢了，节点也没放出来。

### 节点：flush 标记永远不会出现

调用链：

1. 侧栏「继续」发出 `onstarvoice:recover-unattended-keyword-run`（`background.js` 约 21925）。
2. `manuallyRecoverUnattendedKeywordRun`（约 15428）调用 `prepareUnattendedManualRecoverySource`（约 15345）。
3. 批次子任务带工作项身份（`resolveUnattendedClosureItemIdentities` 非空），于是走 `finalizeTerminalUnattendedAttemptExact`（约 12533）。
4. 它读取标记 `onstarvoice.unattendedLocalClosureReady.v1.<R>.<A>`。标记不存在时安排重试，并返回 `checkpoint_flush_not_ready`（约 12583–12599）。
5. 结果为 `deferred:true`。侧栏抛出原始原因码（`sidebar/sidebar-logic.js` 约 7189–7209），显示“恢复任务失败: checkpoint_flush_not_ready”。

**标记保护的是什么。**

- 含义：轮次 A 的运行页（runner）声明“本轮编排已结束，持久化的 checkpoint 上报队列（outbox）已清空，这一轮不会再有 checkpoint 写入”。
- 用途：只有在这之后，后台才关闭该 runner，并证明本地收口（`localClosureEvidence`，`pendingCheckpointReportCount = 0`）。服务端复用或接管该工作项前要这份证明（routes 约 4213–4229）。
- 写入者：只有认领了 A 的那个 runner 文档，在它的 `finally` 里经 `finalizeUnattendedLocalClosureAfterFlush` 写入（`sidebar-logic.js` 约 18361–18383、15642–15763）。

**现场的节点状态：**

- 21:40:47 的自动恢复新建了轮次 A2（`background.js` 约 15079–15117）。
- 停止旧页面失败（约 15125–15146），A2 从 `recovering` 直接变为 `needs_action`，从未被任何 runner 认领。终态请求的认领会被拒（约 13846）。
- 旧轮次 A1 的 runner 写 flush 意图时，会因 `attempt_superseded` 被拒。
- 所以 `(R, A2)` 的标记**结构上不可能出现**。「继续」「跳过当前项」永远得到 `checkpoint_flush_not_ready`，远程「继续」也一样。
- 同时，本机执行锁仍绑定 A1：owner 为 `unattended_keyword_plan`，持有文档是 A1 的 runner。Debug 会话和标签组也都保留着。
- 同类“孤儿轮次”还出现在三处：
  - runner 刷新接续：`claimUnattendedKeywordRun` 约 13931–13970。
  - 认领时的 `CAPTURE_LOCK_CONFLICT`：约 13905–13930。
  - `launchPendingUnattendedRecovery`：约 14771–14800。
- 本机唯一能走的出口是「停止 / 结束并保留」（`cancelUnattendedKeywordRunFromControl`），效果是取消，关键词不回池。
- 根任务没有工作项身份，`prepare` 直接返回 `ready:true`，「继续」可用。死路只存在于批次子任务。

### 为什么不能只改错误码

如果放行时只把错误码改成 `HISTORICAL_STOP_FENCE_RECONCILED`、状态仍保持 `needs_action`，会有三个问题：

- **下一次心跳就会把围栏写回来。**
  - 节点每次完整心跳都会重发最近 50 条本地运行记录（`utils/cloud-task-agent.js` 约 1100–1147），其中就有这一条 `needs_action`，带围栏码。
  - 心跳镜像 `mirrorTaskSnapshot` 对状态不是 `superseded`、`canceled` 的行，会覆盖 `status` 和 `error = EXCLUDED.error`（约 6617–6640、6743、6778），并替换 `metadata`（只保留白名单）。
  - 结果：围栏码回来，放行记录被抹掉。
- **工作项仍然卡着。** 它仍是 `needs_action`、带围栏码，不会被派发，也不会被重试，批次结束不了。
- **0.4.16 的本机释放用不上。** 待释放查询要求 `status='superseded'`（`LOCAL_RELEASE_PENDING_SQL`，约 456–464）。

`superseded` 是唯一合适的状态：

- 心跳写不进来：镜像的状态 CASE（约 6619）和 WHERE（约 6778）都跳过它；快照没被接受时，编排投影也不运行（约 6968）。
- 已有的 `localRelease` / `release_only` / 暂停派发逻辑可以原样复用。
- 弹性派发接受 `superseded` 的上一执行（约 7432）。派发自己置 `superseded` 的 UPDATE 不匹配已是 `superseded` 的行（约 7996–8010），所以不会补写 `handoffSuccessorTaskId`，也不会重复写 `stop_fence_handoff`。

## 目标与不变量

目标：

1. **后台。** 对这类任务，运营可以像处理 `superseded` 围栏一样点「确认旧页面已停止」：同一个确认对话框，同样的审计。确认后：
   - (a) 节点恢复接单。
   - (b) 未完成的关键词不丢：
     - 弹性批次：工作项回到任务池，状态 `retryable`，交给任何合格节点，与普通技术失败相同（到重试预算时与技术失败一样变为 `failed`，可在批次里重试）。
     - 固定分配批次：执行结束；工作项标为「需要处理」（去掉围栏码），运营可在批次里点「重试失败关键词」重跑。
     - 批次已结束或已被「停止整个任务」：关键词此前已被取消，确认只解除停止保护。
     - 回执、事件、审计按投影后的**实际**结果写，不按预判写。
   - 0.4.16 节点照 `superseded` 的做法，经 `release_only` 释放本机锁。
   - 0.4.14/0.4.15 节点：仍提示先重启 Chrome。
2. **扩展。** 侧栏「继续」遇到这类任务时，不再只弹 `checkpoint_flush_not_ready`，而是给出能照做的中文说明。本次不伪造标记，也不在本机续跑。

不变量（实现和评审逐条核对）：

1. 围栏判定不变：`captureTaskUnconfirmedLocalStopSql` / `captureTaskHasUnconfirmedLocalStop` 文本不改，`976a0c6` 规则不改。准入只多一处变化：已放行的行不再命中。
2. 不经运营确认就不放行 `needs_action` 围栏。节点不能证明，自动核对不覆盖，不按时间放行。
3. 放行范围只有一个谓词（见「可放行范围」）：
   - `status='needs_action'`、有 `parent_task_id`、`task_type='unattended_keyword_capture'`。
   - 带围栏码，无 `recoveryTaskId`。
   - 没有在途指令。
   - id 由运营**显式**放在 `expectedTaskIds` 里。

   根任务、`manual_batch`、`resume_requested`/`interrupted`/`failed` 的行和现在一样。
4. 放行即转 `superseded`，写入格式与 09-24/25 先例一致（`HISTORICAL_STOP_FENCE_RECONCILED` + `originalCode` + `historicalStopFenceReconciliation` + 事件 `historical_stop_fence_reconciled`）。之后心跳快照不能再改这一行。
5. 频繁轮询的路径不加新工作：
   - 心跳预检 `readStopFenceHeartbeatWork`、下发 `claimStopFenceCheckOffers`、弹性派发都不改。
   - 围栏列表只多 2 列：`task_type`，以及一个按主键取父任务状态的标量子查询。子查询被 `CASE` 限定为只对 `needs_action` 子任务行求值；心跳领取只列 `superseded` 行，不会进入它。
   - 概览和值守仍是一条查询。
   - 围栏 SQL（生产约 275 ms）不进入任何新路径。
6. 不刷新、不关闭任何标签页。扩展改动只读；不写合成标记。
7. 旧节点（0.4.14/0.4.15）收不到任何新内容；它们唯一多出来的是后台这条人工路径。
8. 不新增迁移。
9. 已有测试断言保持不变，包括闭环文档里“非 `superseded` 围栏不被确认”的集成测试。那两条测试用的都是根任务，仍然 409。

## 方案总览

1. **服务端。** 确认接口在运营显式选中时，放行批次子任务上的 `needs_action` 围栏。同一事务里：
   - 子任务转为 `superseded`，写先例格式的放行记录；对 0.4.16 节点同样生成 `localRelease`。
   - 按 `create_command_expired` 的先例（routes 约 2301–2311），调用 `projectOrchestrationChildControlOutcome` 把工作项交回批次。弹性还是固定分配由投影按父任务的 `distributionMode` 自己判定，与心跳投影同源。新错误码不带围栏码。
   - 投影后读出工作项的实际状态，据此写子任务文案、事件、审计和回执。
   - 「重试失败关键词」认可这种已放行的来源（固定分配，以及弹性到预算的）。
   - 另加两处小守卫：本机恢复不接管已放行的来源；远程「继续」拒绝这类任务并指路。
2. **Admin。** 按服务端新字段 `operator_confirmable_task_ids` 启用「确认旧页面已停止」，改说明和对话框。
3. **扩展（随 0.4.16）。** `prepareUnattendedManualRecoverySource` 遇到“孤儿围栏轮次”，并且整个请求 R（不只是孤儿轮次）都查不到存活的运行页、锁持有页、在途中继和未上报进度时，返回终局原因和中文说明，不再 `deferred`；侧栏把原因码翻成中文。

## 服务端

### 可放行范围

在 `server/services/capture-stop-fence.js` 新增纯函数 `stopFenceOperatorReleasable(row)`，概览、确认接口和测试共用：

```js
row.kind === 'fence'
  && row.status === 'needs_action'
  && Boolean(row.parent_task_id)
  && row.task_type === 'unattended_keyword_capture'
```

围栏码、无 `recoveryTaskId`、非 `capture_orchestration` 这三条，已由 `listCaptureAgentStopFences` 的 WHERE 保证（约 476）。

不在范围内的：

- **根任务**：本机和后台的「继续」「停止」都可用。
- **`manual_batch`**：`task_type='capture'`（约 12195），从不带这个码。
- **`resume_requested`**：见「已知风险」。
- **`failed` / `interrupted`**：现场没出现，保持现状。

预计去向 `stopFenceReleaseDisposition(row)`（只用于放行前的展示，回执以实际结果为准）：

- 没有 `parent_state`：`'unknown'`。
- 父任务已终态，或 `operatorStopped === 'true'`：`'parent_stopped'`。终态集合与 `ORCHESTRATION_PARENT_TERMINAL_STATUSES`（routes 约 2895）相同，由单测对照 `orchestrationParentAcceptsProjection` 锁定。
- `distributionMode === 'elastic_pool'`：`'return_to_pool'`。
- 否则为 `'batch_retry'`。

依据是**父任务**的 `metadata.distributionMode`，与投影同源（routes 约 5731）。子任务自己的 `cloudWorkQueue`/`distributionMode` 不可靠：本机恢复接管的子任务走 `localRecovery` 白名单（约 6715–6727），不保留这两个键。

### 列表与概览字段（不加查询）

- `stopFenceRowSelect`（约 400）增加两列，不加 JOIN：

  ```sql
  ${alias}.task_type,
  CASE WHEN ${alias}.status = 'needs_action' AND ${alias}.parent_task_id IS NOT NULL THEN (
    SELECT jsonb_build_object(
      'status', parent.status,
      'distributionMode', parent.metadata->>'distributionMode',
      'operatorStopped', parent.metadata->>'operatorStopped')
    FROM capture_tasks parent
    WHERE parent.tenant_id = ${alias}.tenant_id AND parent.id = ${alias}.parent_task_id
  ) END AS parent_state
  ```

  子查询按主键取一行，只对 `needs_action` 子任务行求值。
- `summarizeAgentStopFence`：
  - 新增 `operator_confirmable_task_ids`（该节点全部可放行行的 id，不受 20 条限制）和 `operator_confirmable_count`。
  - `tasks[]` 每项新增 `operator_confirmable`、`release_disposition`（预计去向：`return_to_pool` / `batch_retry` / `parent_stopped` / `unknown`）。
  - **`phase` 不变**：只有这类行时仍为 `task_action_required`，仍在 `STOP_FENCE_OPERATOR_PHASES` 里，值守按 high 告警，这是对的，确实要人处理。
- `STOP_FENCE_PHASE_LABELS.task_action_required` 改为：“停止保护来自仍需处理的任务：批次任务请到该电脑检查后在「执行节点」点「确认旧页面已停止」，其它任务在任务上点「继续」或「停止」”。值守事件文案引用这条，不需要另改。
- 不改的：`readStopFenceHeartbeatWork`、`claimStopFenceCheckOffers`、回执、`rotateStopFenceChecks`。`needs_action` 行不进入自动核对。

### 放行写入 `releaseNeedsActionStopFences`

实现放在新文件 `server/services/capture-stop-fence-release.js`（`capture-stop-fence.js` 只加纯函数和共用的记录构造 `buildStopFenceReleaseRecord`）。三个函数，路由在前两个之间做投影：

- `releaseNeedsActionStopFences(tx, {tenantId, agentId, taskIds, requestedBy, actorId, actorName, note, requestLocalRelease, now})`，执行下面第 1–3 步。返回：
  - `released: [{id, parentTaskId, row}]`
  - `skipped: [{id, reason}]`
- `readNeedsActionReleaseItemOutcome(tx, {tenantId, parentTaskId, taskId, parentBefore})`：投影后读工作项实际结果（见确认接口第 6 步）。
- `recordNeedsActionStopFenceOutcome(tx, {tenantId, agentId, taskId, itemOutcome, originalError, actorType, actorId, actorName})`，执行第 4 步。

写入格式与 `reconcileCaptureTaskStopFences` 共用：把 `reconciliation` / `stopFenceCheck` 两个对象的构造抽成内部函数 `buildOperatorReleaseRecord(row, …)`，保证两条路径逐字段一致。步骤：

1. 复核并加锁（路由已经按 id 统一锁过，这里是同事务内的重入）：

   ```sql
   SELECT id, parent_task_id, task_type, status, error, metadata,
     client_task_id, control_task_id
   FROM capture_tasks
   WHERE tenant_id = $1 AND id = ANY($2::uuid[])
     AND COALESCE(assigned_agent_id, origin_agent_id) = $3
     AND status = 'needs_action'
     AND parent_task_id IS NOT NULL
     AND task_type = 'unattended_keyword_capture'
     AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
     AND NULLIF(metadata->>'recoveryTaskId', '') IS NULL
   ORDER BY id
   FOR UPDATE
   ```

2. 在途指令：

   ```sql
   SELECT DISTINCT task_id FROM capture_agent_commands
   WHERE tenant_id = $1 AND task_id = ANY($2::uuid[])
     AND status IN ('pending', 'acknowledged') AND expires_at > now()
   ```

   命中的行跳过，`reason='command_in_flight'`。例如运营刚点过「停止」：停止请求保持 `needs_action`，只在 metadata 写 `stopCommandId`（约 17039）。这时让停止先走完。

   这里只读、不锁指令行。建 `stop`/`resume` 指令的路由都先 `FOR UPDATE` 任务行（resume 约 16089，stop 约 16853），本事务已持有该行锁，不会并发新建；指令完成只会离开 `pending`，看到它就跳过，是保守的一侧。
3. 每行一个 UPDATE：

   ```sql
   UPDATE capture_tasks
   SET status = 'superseded',
     error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
       'code', 'HISTORICAL_STOP_FENCE_RECONCILED',
       'originalCode', 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'),
     message = $5,
     metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'historicalStopFenceReconciliation', $3::jsonb,
         'terminalReason', 'stop_fence_operator_released'),
       '{stopFenceCheck}', $4::jsonb),
     finished_at = COALESCE(finished_at, now()),
     updated_at = now()
   WHERE tenant_id = $1 AND id = $2
     AND status = 'needs_action'
     AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
   RETURNING id, parent_task_id, task_type, status, metadata
   ```

   - `historicalStopFenceReconciliation` 与现有字段相同：`{at, reason:'operator_confirmed_needs_action_released', proofStatus:'operator_confirmed', requestedBy, originalError, agentId, checkId:'', requestId, evidence:null, note, actorId}`。另加 `releasedFromStatus:'needs_action'`；`itemOutcome` 在第 4 步补写。
   - `stopFenceCheck` 为 `{...原有, resolvedAt, resolution:'operator_confirmed'}`。`requestLocalRelease && requestId` 时再加 `localRelease`，格式与现有完全相同（约 1100–1112）。
   - `message` 先写“已人工确认旧采集页面已停止，本执行结束”，第 4 步补上去向。
   - **不写 `terminalDisposition` / `terminalDispositionAt`**（与 `superseded` 放行一致；评审第 1 轮发现）。批次被「停止整个任务」后，`refreshOrchestrationParentTask` 把带 `terminalDisposition` 的子任务当作“等节点确认终态通知”，而关键词子任务永远收不到这种通知（只有定向巡查类任务会），批次会永远停在 `waiting_device`。放行只靠 `terminalReason` 标记：`stopFenceReleasedRetrySource`、待派重试扫描 SQL、本机接管守卫都只读它。
   - 与闭环文档不变量 5 的关系：那条不变量是为了让 `976a0c6` 规则比较 `historical_stop.updated_at`，只适用于仍带围栏码的行。这里同一条语句去掉了围栏码，而且这是一次真实的状态转换，与派发置 `superseded` 时一样更新 `updated_at`。
4. 路由投影完成后，`recordNeedsActionStopFenceOutcome` 按实际结果补写（该行已在本事务锁住）：
   - 子任务：`message` 追加去向句（见「关键词去向」），`metadata.historicalStopFenceReconciliation.itemOutcome` 写入结果对象。批次详情里执行卡片显示的是 `execution.message`，这一句也纠正了 `superseded` 的通用标签「已转入恢复任务」。
   - 事件 `historical_stop_fence_reconciled`：`actor_type='user'`，`status='superseded'`；payload 为 `{proofStatus:'operator_confirmed', reason, originalError, checkId:'', releasedFromStatus:'needs_action', itemOutcome}`；文案为“{操作人} 人工确认旧采集页面已停止，解除停止保护；该执行结束，”加同一句去向。
5. 有放行行时调用一次 `enqueueStopFenceReleaseWakeup`。状态变更本身也会触发 `074` 的空槽触发器，两者的去重键相同。

### 确认接口 `POST /agents/:id/stop-fence/confirm`

请求体不变：`{confirmation, expectedTaskIds, note?}`。在现有流程上改：

1. `loadStopFenceAdminAgent`（槽锁），然后 `listCaptureAgentStopFences`，与现在相同。
2. 分组：
   - `superseded` = kind fence 且状态为 `superseded`。
   - `releasable` = `stopFenceOperatorReleasable(row)`。
   - `selected` = `releasable` 中 id 在 `expectedTaskIds` 里的。
3. `superseded.length === 0 && selected.length === 0` 时，行为与现在相同：返回 `task_action_required`（带 `requiresTaskAction`）或 `absent`。旧 Admin 包不会发送 `needs_action` id，所以走的仍是这条原路径。
4. 仍要求 `superseded` ⊆ `expectedTaskIds`，否则返回 `agent_stop_fence_changed`。
5. 锁顺序：槽锁 → 对 `superseded ∪ selected` 的 id 执行一次 `SELECT … ORDER BY id FOR UPDATE` → 各自写入。
   - 先写 `reconcileCaptureTaskStopFences`（`superseded`），再写 `releaseNeedsActionStopFences`（`selected`）。
   - 两者的 `requestLocalRelease` 取值相同（能力 `previousCaptureStopCheckV1` 且应急开关开启）。
   - （最终实现）没有 `superseded` 行、所选的 `needs_action` 行又一行都没放行时，不写审计、直接返回：有 `command_in_flight` 的返回 409 `agent_stop_fence_command_in_flight`（带 `requiresTaskAction`），否则返回 409 `agent_stop_fence_changed`。
6. 对每个放行的子任务，按 `(parent_task_id, id)` 排序：

   ```js
   // 同事务重入，锁顺序仍是子任务 → 父任务；只为记下投影前的父任务状态。
   const parentBefore = await lockOrchestrationParent(tx, tenantId, row.parent_task_id);
   await projectOrchestrationChildControlOutcome(tx, {
     tenantId, childTask: row, agentId,
     status: 'needs_action',
     error: {
       code: 'PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED',
       originalCode: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
       message: '旧采集页面未能安全停止，已由管理员确认停止后交回批次',
     },
     actorType: 'user', actorId, actorName,
   });
   ```

   - 输入状态统一为 `needs_action`，由投影判定去向：弹性（父任务 `distributionMode='elastic_pool'`）经 `projectElasticKeywordRecoveryStatus` 变为 `retryable`，到预算为 `failed`（`technicalLimitReached` 时为 `needs_action`）；固定分配原样为 `needs_action`。路由不按子任务 metadata 预判。
   - 内部顺序是父任务 → 工作项 → 工作项尝试 → 刷新父任务，与心跳投影、`create_command_expired` 相同。父任务已终态时（`orchestrationParentAcceptsProjection` 为假）直接返回，不动工作项；子任务照样放行。
   - 投影后读实际结果（工作项已被投影的 UPDATE 锁住；新错误码只有这里写，所以命中的就是本次投影改动的行）：

     ```sql
     SELECT status, COUNT(*)::int AS count
     FROM capture_task_items
     WHERE tenant_id = $1 AND task_id = $2 AND execution_task_id = $3
       AND error->>'code' = 'PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED'
     GROUP BY status
     ```

   - 组成 `itemOutcome = {kind, retryable, failed, needsAction, parentStatus, operatorStopped, distributionMode}`，后三项取自 `parentBefore`。`kind` 的取值：
     - `returned_to_pool`：`retryable > 0`。
     - `retry_exhausted`：弹性，没有 `retryable`，有 `failed`/`needs_action`。
     - `batch_retry`：固定分配，有 `needs_action`。
     - `none`：一行都没动，原因是父任务已终态、已被「停止整个任务」，或没有未完成的工作项。
   - 调用 `recordNeedsActionStopFenceOutcome` 写文案、`itemOutcome` 和事件（见上一节第 4 步）。
7. `requiresTaskAction` = 其余非 `superseded` 围栏行，每项加两个字段：
   - `operatorConfirmable`（是否属于 `releasable`）。
   - `skipReason`：`not_selected` / `command_in_flight` / `not_releasable`（复核时已不满足条件）/ `not_orchestration_child`。
8. 审计 `capture_agent.stop_fence_confirmed` 的 metadata 增加：`needsActionTaskIds`、`itemOutcomes: [{taskId, ...itemOutcome}]`、`skipped`。
9. 成功文案（N = 放行总数）。去向各句按 `itemOutcomes` 的实际计数汇总，计数为 0 的句子不写：
   - 开头不变：“已确认旧采集页面已停止（N 个任务已记录人工确认）”；没有待释放、也没有仍需处理的任务时写“…，节点恢复接单（…）”。
   - `retryable` 合计 k：“；k 个未完成关键词已退回任务池，由其它节点接力”。
   - 弹性 `failed`/`needs_action` 合计 m：“；m 个关键词已达自动接力上限，可在批次里点「重试失败关键词」”。
   - 固定分配 `needs_action` 合计 n：“；n 个未完成关键词已标为需处理，可在批次里点「重试失败关键词」”。
   - `kind='none'` 且父任务已终态或 `operatorStopped` 的 j 个任务：“；j 个任务所在批次已停止，未完成关键词已随批次取消，本次只解除停止保护”。
   - 本机释放和旧版本的后缀保持现状。旧节点的后缀是“；该节点扩展版本较旧，如随后领任务报执行锁冲突，请在该电脑重启 Chrome”。
   - 仍需处理的后缀保持现状；其中 `command_in_flight` 的改写为“另有 K 个任务正在执行后台指令，完成后再确认”。
10. 响应新增 `needsActionTaskIds`、`itemOutcomes`。
11. `STOP_FENCE_ADMIN_ERRORS.agent_stop_fence_task_action_required` 的文案改为：“该节点的停止保护来自仍需处理的任务：批次任务请刷新后在「确认旧页面已停止」里一并确认，其它任务请在任务上点「继续」或「停止」”。错误码不变。

确认后的效果：

- (a) 节点不再被挡。0.4.14/0.4.15 节点下一次心跳就能领任务。0.4.16 节点先收到 `release_only`；它回执之前，按现有暂停逻辑不派新采集。
- (b) 弹性关键词回到任务池（到预算的可在批次里重试）；固定分配关键词进入可重试状态；批次已停止的只解除围栏。

### 关键词去向（与普通技术失败一致）

**弹性**（父任务 `distributionMode='elastic_pool'`）。经 `projectElasticKeywordRecoveryStatus` 计算：

- 未到预算为 `retryable`，到预算为 `failed`（`technicalLimitReached` 时为 `needs_action`）。新错误码不在 `ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES` 里（约 555），这一轮计作一次尝试（它确实跑到了 8/20）。
- 到预算的工作项不再自动派发，文案写“已达自动接力上限，可在批次里点「重试失败关键词」”。`retry-items` 接受 `failed`/`needs_action`，只拒绝弹性队列自管的 `retryable`（约 5776）；来源检查按下文 `retrySourceSettled` 放行。
- 派发不要求本地收口证明（约 7224–7228）。另一个节点的下一次心跳就能领走。
- 同一关键词在本轮不会回到原节点：技术失败按“当前一轮”屏蔽原节点。例外是它是唯一合格节点（`pinnedAgentId`、each_agent）。
- 领取时来源已是 `superseded`，派发的置 `superseded` UPDATE 不匹配，所以没有 `handoffSuccessorTaskId`，也没有 `stop_fence_handoff` 事件。

**固定分配。** 该子任务所有非终态工作项（进行中和未开始的）都变为 `needs_action`，带新错误码。

- 父任务汇总为「需要处理」。
- 新错误码不触发 `itemRequiresManualSafetyAction`，所以重试不要求安全确认。
- Admin 的「重试失败关键词」对 `superseded` 来源本来就显示（`FINAL_EXECUTION_STATUSES`，`OrchestrationDetailWorkspace.tsx` 约 108）。服务端按下一节放行。

**批次已结束或已被「停止整个任务」。** 父任务已终态时投影直接返回；父任务因其它执行未确认而停在 `waiting_device`（`operatorStopped`）时，该子任务的工作项早已是 `canceled`，投影的 UPDATE 一行不中。两种情况 `kind='none'`，文案写“批次已停止，未完成关键词已随批次取消，本次只解除停止保护”，不写“退回任务池”。

### 「重试失败关键词」认可已放行的来源（固定分配，以及弹性到预算的）

`server/routes/capture-orchestrations.js` 新增：

```js
function retrySourceSettled(source) {
  if (HANDOFF_SOURCE_FINAL_STATUSES.has(source?.status)) return true;
  const metadata = safeJson(source?.metadata);
  return source?.status === 'superseded'
    && metadata.terminalReason === 'stop_fence_operator_released'
    && !text(metadata.handoffSuccessorTaskId, 240)
    && !text(metadata.recoveryTaskId, 240);
}
```

三处都要改，漏一处会出现“按钮在、点了报「原执行任务仍在运行」”：

1. `retry-items` 的来源查询（约 5697）加取 `source.metadata`；约 5802 的判断改为 `!retrySourceSettled(task)`。
2. 待派重试的扫描 SQL `loadPendingRetryCandidates`（约 1762）改为：

   ```sql
   AND (source_execution.status = ANY($1::text[])
     OR (source_execution.status = 'superseded'
       AND source_execution.metadata->>'terminalReason' = 'stop_fence_operator_released'
       AND COALESCE(source_execution.metadata->>'handoffSuccessorTaskId', '') = ''
       AND COALESCE(source_execution.metadata->>'recoveryTaskId', '') = ''))
   ```

   只在原查询里加一个 OR，不加查询。
3. 同一流程的加锁复核（约 2294 的查询加取 `metadata`，约 2353 改用 `retrySourceSettled`）。

不改的：

- 「接力」（约 6483）仍拒绝 `superseded` 来源。重试已经够用。
- 负面巡查恢复（约 5468）不在范围内。

### 本机恢复不接管已放行的来源

`adoptLocalOrchestrationRecovery`（routes 约 4078）在读出 `sourceMetadata` 后加一行：

```js
if (sourceTask.status === 'superseded'
  && sourceMetadata.terminalReason === 'stop_fence_operator_released') return task;
```

原因：没有记录后继时，`orchestrationRecoverySuccessorMatches` 视为匹配（约 702）。以后若有扩展版本在本机续跑，会把运营已退回任务池的工作项接管回来。只会有一个执行者，但与运营的决定相反。

### 远程「继续」拒绝这类任务（已随本批实现）

`/tasks/:id/resume`（约 16053）在建 `resume` 指令前增加判断：`task.parent_task_id && task.task_type === 'unattended_keyword_capture' && task.status === 'needs_action' && captureTaskHasUnconfirmedLocalStop(task)`。成立时返回：

- 409 `task_stop_fence_operator_release_required`。
- 文案“该任务的旧采集页面未确认停止，节点本机无法继续；请到该电脑检查后，在「执行节点」点「确认旧页面已停止」，未完成关键词会交回批次”。

这类指令任何版本都执行不了（旧版挂起 30 天，0.4.16 改后立即失败），而且会把任务变成不可放行的 `resume_requested`。判断只用已加载的行，不加查询。根任务不受影响。

### 锁顺序与性能

- 确认接口：槽锁 → 全部所选任务行（按 id）→ 各父任务（按 `parent_task_id`）→ 工作项 → 尝试。
  - 与心跳投影（子任务 → 父任务 → 工作项）和重试派发（槽 → 来源 → 父任务 → 工作项）同向。
  - 不在行锁之后取 `capture_orchestration_control` 咨询锁。
  - 弹性派发对父任务和工作项用 `SKIP LOCKED`，而这条工作项在本事务提交前是 `needs_action`，派发看不到它。不会死锁。
- 同节点的心跳 upsert 会等本事务提交。提交后该行已是 `superseded`，upsert 被 WHERE 过滤。
- 额外开销：
  - 确认接口不轮询，每次多一条指令查询，每个放行行多一次投影和一条工作项计数查询。
  - 围栏列表多 2 列（`task_type` 和按主键取父任务的子查询，只对 `needs_action` 子任务行求值）。
  - 待派重试扫描多一个 OR。
  - 心跳、预检、派发、`/overview` 的查询数都不变。

## 管理端

依据仍是 `/overview` 的 `agents[].stop_fence`。可放行性只看服务端字段 `operator_confirmable` / `operator_confirmable_task_ids`，不按状态自行推断。这样服务端没发新字段时（例如回滚），行为和现在完全一样，现有测试不用改。

**`stop-fence-presentation.mjs` 与 `.d.mts`：**

- 类型：`StopFenceTask` 加 `operator_confirmable?`、`release_disposition?`；`StopFence` 加 `operator_confirmable_task_ids?`、`operator_confirmable_count?`；`StopFenceNotice` 加 `releasableTasks`、`releasableCount`。
- 任务分组：`releasableTasks` = 非 `superseded` 且 `operator_confirmable === true` 的任务；`actionTasks` 只保留其余非 `superseded` 任务。
- 确认 id：
  - `confirmTaskIdsFrom` 拆成两部分：`supersededConfirmIds`（沿用现有逻辑）和 `releasableIds`（列出的 ∪ `operator_confirmable_task_ids`）。
  - `confirmTaskIds` = 两者之并。
  - 完整性检查只看 `supersededConfirmIds.length >= supersededCount`；不能用并集的长度判断，否则会掩盖缺失的 `superseded` id。
- `canConfirm = blocking && (supersededCount > 0 || releasableCount > 0) && supersededIdsComplete`。`canRecheck` 不变：`task_action_required` 仍不可核对。
- `task_action_required` 且 `releasableCount > 0` 时：
  - headline 为「旧采集页面未确认停止 · 需人工确认」，guidance 为「到该电脑检查后点「确认旧页面已停止」」。
  - detail：“N 个批次任务停在「需要处理」，节点本机已无法继续（节点侧栏点「继续」会报 checkpoint_flush_not_ready，或提示到后台处理）；请到这台电脑检查：关闭或刷新所有小红书、抖音、微博采集页（旧版本扩展最稳妥是重启 Chrome）后，点「确认旧页面已停止」。确认后这些任务结束，预计：{去向}”。
  - 去向按 `release_disposition` 写，标明“预计”：`return_to_pool` 为“未完成关键词退回任务池，由其它节点接力（已达接力上限的改为可在批次里重试）”，`batch_retry` 为“未完成关键词标为需处理，可在批次里「重试失败关键词」”，`parent_stopped` 为“所在批次已停止，关键词已取消，确认只解除停止保护”，`unknown` 为“未完成关键词按批次分配方式交回”。几种都有时各写一句。实际结果以确认后的回执为准。
  - 另有 K 个不可放行任务时，追加“；另有 K 个任务仍需在任务上点「继续」或「停止」”。
  - 这段对所有版本的节点都一样，不写“升级 0.4.16 后自动核对”：自动核对不覆盖这类任务。
  - `recheckHint` 改为“该节点的停止保护来自仍需处理的任务，不能自动核对；批次任务请到该电脑检查后点「确认旧页面已停止」”。
- `stopFenceConfirmDrift` 不用改：`confirmTaskIds` 已包含可放行 id。打开对话框后才出现的新可放行任务会被当作变化，禁止提交。

**`StopFencePanel.tsx`：**

- 任务列表中 `operator_confirmable` 的项，把红字改为：“节点本机无法继续该任务；检查后点「确认旧页面已停止」，确认后{按 `release_disposition` 的预计去向}。节点侧栏的「停止」「结束并保留」会放弃这些关键词。”
- 对话框：
  - 「待确认任务（supersededCount + releasableCount）」下，逐条列出可放行任务：“· 标题 · 平台 · 需要处理 · 预计：退回任务池 / 可在批次重试 / 批次已停止”。
  - 有可放行任务时，风险说明加一条：“「需要处理」的批次任务确认后即结束，未完成关键词按上述方式交回批次；节点侧栏里该任务仍显示「需要处理」，不必再点「继续」。”
  - 原有三条风险说明、必勾选项和备注都不变。
  - “另有 K 个仍需处理的任务”只统计 `actionTasks`。

**`OrchestrationDetailWorkspace.tsx`**（约 2166）：`stopFence.task.operator_confirmable` 时，把“请在「执行节点」中处理”改为“请在「执行节点」中点「确认旧页面已停止」”。放行后执行卡片显示服务端写入的 `execution.message`。`lib.ts` 的 `superseded: '已转入恢复任务'` 不改，它被多处测试锁定。

## Extension（随 0.4.16 发布）

### 不补写标记的原因

对 A2 自己，这个标记已经没有可保护的东西：A2 从未运行，也没有 outbox 行。但 A1 可能还没收尾（见下文判定）。即使 A1 已收尾，只绕过标记在运营确认之前仍不安全：

- 本地收口清理找不到 A2 的精确锁（锁在 A1 名下），最后要么落到永久的 `source_identity_unverifiable`，要么走会刷新或重注入页面的停止路径（`retryUnattendedLocalClosureCleanup` 约 11778 起）。
- 服务端接管本机恢复需要经过验证的收口证明。
- 服务端已在后台放行时，本机续跑还会和“退回任务池”冲突。

所以本次只把死路换成能照做的说明。

### 改动

1. **`background.js` `prepareUnattendedManualRecoverySource`**（约 15345）。`finalize` 调用保持不变，有标记时语义照旧。在“拿不到 `closureKey`”的分支里，若 `closure.reason === 'checkpoint_flush_not_ready'`，先调用新的只读函数 `classifyOrphanedStopFenceAttempt(request)`。
   - 孤儿轮次 A2 从未被认领，按 `(R, A2)` 查 runner 和 outbox 必然为空，证明不了什么。要排除的是旧轮次 A1：它的 runner 可能仍开着或已冻结，可能仍持有绑定 R 的锁，也可能还有没上报的 A1 outbox 行。所以除第一条外，下列检查都按**整个请求 R** 做，复用停止保护自检的判定（`createStopFenceCheckContext` 约 10368–10420 及其后的认锁函数）。
   - 下列条件全部成立时，返回 `{ready:false, final:true, reason, message, request}`：
     - 精确请求槽是 `(R, source.attemptId)`，`status === 'needs_action'`，`error.code === 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'`。
     - R 的任一轮次都没有 flush 意图（键前缀 `onstarvoice.unattendedFinalFlushIntent.v1.<R>.`）。前缀与 `sidebar-logic.js` 约 1231 相同，在 background 另定义同名常量，并加一致性断言。
     - 用 `createStopFenceCheckContext({requestId: R, checkId: '', taskId: ''}, {ok: true, request, requestSource: 'slot', requestActive: false})` 构造 `ctx`。这一步只建判定函数，没有副作用。
     - `chrome.tabs.query({})` 中没有 `ctx.isRequestRunnerTab(tab)` 的页面，即 R 任一轮次的 runner，含无轮次参数的旧式 runner；`tab.pendingUrl` 也按 URL 认，仍在加载的 runner 同样算存活。
     - **最终实现不查 `request.runnerTabId` / `request.progress.runnerTabId`**（评审第 1 轮发现）。`progress.runnerTabId` 是采集所在的平台页，正是停止失败、要运营检查的那一页；`release_only` 按设计也不关它。按标签页 id 认会让终局说明在放行前后都走不到，远程「继续」也一直挂起。runner 只按 URL 认。
     - `readStoredCaptureExecutionLock()` 读出的锁若满足 `isStopFenceLockBoundToRequest(lock, ctx)`，其持有文档必须已不在：`getCaptureExecutionLockHolderState(lock) === 'gone'`，或为 `'unknown'` 且 `stopFenceTabExists(lock.holderTabId)` 为假。规则与本机释放相同（约 11136–11146）。现场的锁绑定 R、持有文档是 A1 的 runner，就由这一条判定。
     - `listRequestRelays(R, ctx.taskKey)` 为空。
     - outbox 里 R 任一轮次都没有待报行。给 `inspectUnattendedCheckpointOutboxAttempt`（约 8800）加选项 `{anyAttempt: true}`，只比 `requestId`；要求 `known === true` 且 `pendingCount === 0`。现有调用不传此项，行为不变。不加这个选项的话，空 `attemptId` 什么都匹配不上，会得到假的 0。
   - 任一读取失败、结果未知或有存活迹象时，返回 `null`，保持原来的 `deferred` 行为。侧栏按第 3 条显示中文说明，把运营引到后台。
   - R 的 Debug 会话、标签组和采集辅助残留不算存活迹象：上面各项都干净时，已经没有东西在驱动它们，而 `release_only` 会清掉它们。也正因为如此，文案不声称“页面已关闭”。
   - `reason` / `message` 的取值：
     - 请求上已有 `stopFenceClosure`（后台确认后 0.4.16 `release_only` 成功时写入）：`stop_fence_released_to_cloud`，文案“后台已确认旧采集页面停止，该任务已结束，剩余关键词由后台处理，本机无需继续”。
     - 否则：`previous_capture_stop_requires_operator`，文案“本机无法自行确认旧采集页面已停止，「继续」不会生效。请到这台电脑检查旧采集页面后，在后台「执行节点」点「确认旧页面已停止」；确认后该任务结束，剩余关键词由后台交回批次”。
   - 函数只读：不写存储、不改请求槽、不碰标签页、不发心跳。几次读取不是原子的，最后重读请求槽，期间换了轮次或状态就返回 `null`。
   - **归档来源（最终实现新增）。** 放行后 0.4.16 节点领了新任务，R 被归档出请求槽。`prepareUnattendedManualRecoverySource` 的归档分支原本返回 `source_local_closure_unverifiable`（侧栏写“请稍后再试”，但永远不会成功）。现在来源是 `needs_action` + 围栏码时直接返回 `final:true`：有 `stopFenceClosure` 为 `stop_fence_released_to_cloud`，否则为 `previous_capture_stop_requires_operator`。这里不查存活迹象：归档副本回不到请求槽，这个分支只换文案、让远程 `resume` 以失败完成，不放行任何东西。不带围栏码的归档批次子任务仍返回 `source_local_closure_unverifiable`，保持 `deferred`。
   - 两个小函数 `isStopFenceBlockedNeedsAction`、`describeStopFenceOperatorGuidance` 由两处共用。
2. **`manuallyRecoverUnattendedKeywordRun`**（约 15437）：`deferred: sourcePreparation.final !== true`，并透传 `message`。
   - 远程 `resume` 指令（约 7155）因此不再挂起，而是以 `accepted:false` 完成。
   - `summarizeCloudRecoveryResult`（约 2531）优先取 `result.message`。
   - 服务端收到失败的 `resume` 回执时，把任务改回 `needs_action` 并写入这段文案（routes 约 9878–9905）。之后运营就能在后台确认放行。
   - 侧栏消息处理（约 21925）在响应里加上 `message`。
3. **`sidebar/sidebar-logic.js` `handleTaskCenterAction`**（约 7189–7209）：
   - 两个终局原因用 `showMessage(message, 'warning')` 显示，然后刷新列表，不再报“恢复任务失败”。
   - 通用原因也给中文：`checkpoint_flush_not_ready` 为“旧运行页还在收尾（进度未上报完），请稍后再试；持续出现时请在后台「执行节点」处理”；`source_local_closure_unverifiable`（只在来源已归档时出现，重试不会变）为“该任务已不是本机当前任务，本机无法继续；请在后台批次里处理”；其余 `source_local_closure_*` 为“本机尚未确认旧任务已收尾，请稍后再试”。其余原因照旧。映射抽成纯函数 `describeUnattendedRecoveryFailure`。

### 与 0.4.16 `release_only` 的关系

- 服务端对放行后的行下发的 `release_only`，扩展不用改就能处理：
  - `releaseStopFenceLocalResourcesForOperator`（约 11509–11546）只要求本机请求处于终态，而 `needs_action` 属于终态（约 223–231）。
  - 它关闭 R 各轮次的 runner 页，checkpoint 未上报时不关。
  - 按精确身份释放绑定 R 的锁和残留的采集辅助，写入 `stopFenceClosure`。
- `release_only` 不写 flush 标记，所以没有本次改动时，确认后「继续」仍会报 `checkpoint_flush_not_ready`。有了改动后，会提示“后台已确认旧采集页面停止…本机无需继续”。

### 不做

- 不写合成标记，不在本机从 checkpoint 续跑。以后要做，必须同时满足：
  - `stopFenceClosure` 存在，且 `(R,A)` 的停止确认为 `runtime_released`。
  - R 没有存活的 runner，没有 flush 意图，outbox 已知且为 0。
  - `listRequestRelays(R)` 为空，没有绑定 R 的锁。
  - 还要先和服务端“退回任务池”约定归属。
- 不修改「停止」「结束并保留」的语义。
- 不改 `finalize` 的重试定时器。它对孤儿轮次会一直空转，只产生唤醒噪声，见「已知风险」。

## 旧节点（0.4.14 / 0.4.15）

- 收不到任何新内容。能力未声明，没有 `localRelease`、`release_only`，也不暂停派发。
- 后台人工确认后，节点下一次心跳就可领任务。但本机执行锁仍绑定旧任务（A1），第一次领任务可能以 `CAPTURE_LOCK_CONFLICT` 收尾，或触发 0.4.15 带刷新的旧锁清理。所以对话框（“最稳妥是重启 Chrome”）、面板说明和确认接口的文案都保留“先重启 Chrome”。
- 侧栏里该任务仍显示「需要处理」，点「继续」仍弹原始的 `checkpoint_flush_not_ready`，无害，由后台文案解释。节点本地点「停止」「结束并保留」后上报的快照会被已冻结的行忽略，不影响后台。

## 测试

**服务端纯函数**（`tests/capture-stop-fence.test.mjs`）：

- `stopFenceOperatorReleasable` 的真值表：根任务、`manual_batch`（`task_type='capture'`）、`resume_requested`、`failed`、`superseded`、`local_release` 都为假。
- `stopFenceReleaseDisposition`：只看 `parent_state`（弹性、固定分配、`operatorStopped`、父任务终态、缺失）；子任务 metadata 里的 `cloudWorkQueue`/`distributionMode` 不影响结果。终态集合对每个状态与 `orchestrationParentAcceptsProjection` 结果一致。
- `summarizeAgentStopFence`：新字段正确；只有可放行行时 `phase` 仍为 `task_action_required`；`operator_confirmable_task_ids` 不受 20 条限制。
- `tests/server-capture-cloud-contract.test.mjs`：围栏 SQL 文本与基线逐字一致（已有断言，保留）。

**PostgreSQL 集成**（`tests/integration/postgres/stop-fence-closure.integration.mjs` 新增子测试。夹具参照约 587 的弹性接力用例：`capture_orchestration` 父任务 + 子任务 + 工作项 + 工作项尝试）：

1. **弹性子任务，旧节点。**
   - 概览：`phase='task_action_required'`，`operator_confirmable_task_ids=[child]`，`tasks[0].release_disposition='return_to_pool'`。
   - `expectedTaskIds=[]` 返回 409 `agent_stop_fence_task_action_required`，`requiresTaskAction[0].operatorConfirmable=true`，行不变。
   - `expectedTaskIds=[child]` 返回 200：
     - 文案匹配“退回任务池”和“重启 Chrome”。
     - 子任务为 `superseded`、`HISTORICAL_STOP_FENCE_RECONCILED`，`originalCode` 和原文案保留，`releasedFromStatus='needs_action'`，`terminalReason='stop_fence_operator_released'`，没有 `localRelease`。
     - 事件（`actor_type='user'`，payload `itemOutcome.kind='returned_to_pool'`）和审计（`needsActionTaskIds`、`itemOutcomes`）都已写入；响应 `itemOutcomes[0].retryable=1`。
     - 执行槽判定为空；工作项为 `retryable`，错误码 `PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED`；父任务已刷新。
2. **接力。** 另一节点 `dispatchNextElasticWorkItem` 领到该工作项。来源仍为 `superseded`，没有 `handoffSuccessorTaskId`，没有 `stop_fence_handoff` 事件。原节点在本轮领不到同一工作项。
3. **心跳不能改回。** 原节点心跳重发同一轮次的 `needs_action` + 围栏码快照，子任务和工作项都不变；围栏不回来。
4. **0.4.16 节点。** 写入 `localRelease.state='pending'`；下一次心跳 `stopFenceChecks=[{mode:'release_only'}]`，且 `create` 为空（暂停派发）；回执后变为 `done`，节点随后领到任务。
5. **固定分配子任务**（3 个工作项：1 个进行中、2 个 `blocked_by_prior_item`）。
   - 确认后：3 个工作项都为 `needs_action`、新错误码，父任务为 `needs_action`；`itemOutcome.kind='batch_retry'`，`needsAction=3`，文案、事件、审计都写“可在批次里点「重试失败关键词」”。
   - `retry-items` 用这 3 个 id 返回 200，并建出重试执行。
   - 待派重试的扫描和复核都接受该来源。
   - 对照组：一个按普通接力变为 `superseded` 的来源（`terminalReason='elastic_retry_claimed'`）仍然返回 409 `retry_source_not_settled`。
6. **范围之外。**
   - 根任务 `needs_action`：已有测试，原样通过。
   - 子任务带 `pending` 的 `stop` 指令：不放行，`skipReason='command_in_flight'`。
   - `resume_requested` 子任务：不可放行。
   - 混合情况：`superseded` 与可放行行同时存在时，漏带 `superseded` id 返回 409 `agent_stop_fence_changed`；全部带上则两类一起放行。
   - 其他节点、其他租户的 id 不受影响。
7. **预算。** 弹性工作项 `attempt_count` 达上限时，放行后为 `failed`（与技术失败相同）。`itemOutcome.kind='retry_exhausted'`；回执、子任务文案、事件、审计写“已达自动接力上限，可在批次里点「重试失败关键词」”，不含“退回任务池”。`retry-items` 用该工作项 id 返回 200。
8. **接管守卫。** 带 `parentRequestId` 指向已放行来源的本机恢复快照不会被接管，工作项不变。
9. **远程继续守卫（如随本批提交）。** 带围栏的 `needs_action` 子任务返回 409 `task_stop_fence_operator_release_required`，不建指令；根任务照常建指令。
10. **父任务已被「停止整个任务」。**
    - 先调用编排停止接口，断言：子任务仍是 `needs_action` + 围栏码，不在保留列表，没有 `stop` 指令；工作项为 `canceled`，父任务为 `canceled`；节点仍被准入挡住；概览 `release_disposition='parent_stopped'`。
    - 再确认放行：子任务为 `superseded`，工作项仍为 `canceled`，`itemOutcome.kind='none'`、`parentStatus='canceled'`；回执、文案、事件、审计写“批次已停止…已随批次取消”，不含“退回任务池”；节点恢复接单。
    - 变体：另有一个保留中的执行，父任务停在 `waiting_device`。断言相同，只是 `parentStatus='waiting_device'`、`operatorStopped=true`。
11. **本机恢复接管的子任务。** 子任务 metadata 为 `localRecovery` 白名单的形状（没有 `cloudWorkQueue`/`distributionMode`），父任务是弹性。概览 `release_disposition='return_to_pool'`；确认后工作项为 `retryable`，`itemOutcome.kind='returned_to_pool'`，文案写“退回任务池”。

**Admin**（`tests/admin-stop-fence-presentation.test.mjs`、`admin-stop-fence-panel`、`cloud-task-center-wiring`）：

- 有 `operator_confirmable`：`canConfirm` 为真，headline 为「需人工确认」，`confirmTaskIds` 含该 id，`releasableTasks` 正确，`canRecheck` 仍为假。
- 无该字段：与现有断言一致（第 101、247、286 行等不改）。
- `superseded` id 不全时仍不可确认，即使并上可放行 id 后总数够。
- 打开对话框后出现新的可放行 id：判为变化。
- 面板和对话框渲染可放行任务的文案，`release_disposition` 四个取值（含 `parent_stopped`、`unknown`）各有对应的“预计”文案；批次卡片文案随 `operator_confirmable` 切换。

**扩展**（`tests/background-capture-lock.test.mjs`，沿用 `seedTerminalUnattendedClosureCandidate`（约 817），**不**调用 `seedUnattendedLocalClosureReadyMarker`）：

1. 孤儿围栏轮次（`needs_action` + 围栏码 + 批次工作项），R 的证据都干净：锁仍绑定 R，但持有文档已不在；Debug 会话残留仍在。侧栏恢复返回 `ok:false`、`reason='previous_capture_stop_requires_operator'`、带 `message`，文案不含“已关闭”。
2. 请求上有 `stopFenceClosure`：返回 `stop_fence_released_to_cloud`。
3. **现场形状**：请求槽是 `(R,A2)`，A2 是孤儿；A1 的 runner 页仍开着（轮次参数为 A1），锁绑定 R，持有文档是存活的 A1 runner。结果保持 `deferred` + `checkpoint_flush_not_ready`，不返回终局原因。
4. 下列任一情况单独出现时也保持 `deferred`：
   - R 有旧式 runner（无轮次参数）。
   - R 的 runner 仍在加载（只有 `pendingUrl`）。
   - （最终实现）`request.runnerTabId` 或 `progress.runnerTabId` 的标签页仍在**不再**算存活迹象：平台页开着时放行前给 `previous_capture_stop_requires_operator`，放行后给 `stop_fence_released_to_cloud`。
   - 锁持有状态为 `unknown`，且持有标签页仍在。
   - R 有在途中继。
   - outbox 有 A1 的待报行，或 outbox 读取失败、行无法归属。
   - R 任一轮次存在 flush 意图。
5. `inspectUnattendedCheckpointOutboxAttempt` 不传 `anyAttempt` 时，结果与原来一致。
6. 远程 `resume`：证据干净时，指令以 `accepted:false` 完成，带终局原因和文案，不再 `deferred`。
7. 以上每个场景都断言：请求槽不变；锁不变；`tabs.create/reload/update/remove` 为 0；没有新的 runner；不写 `unattendedLocalClosureReady` 标记。
8. 已有的“有标记”“非批次任务”恢复测试保持通过。
9. 侧栏：终局原因显示 warning 和中文文案（如有现成 harness；否则把映射抽成纯函数单测）。

**反向验证**（在临时副本里逐一去掉，确认有测试失败，然后还原）：

- `parent_task_id` 条件（根任务会被放行）。
- `expectedTaskIds` 显式选择。
- 改为只改错误码、状态仍为 `needs_action`（第 3 条会失败）。
- 三处 `retrySourceSettled` 各去掉一处。
- 在途指令跳过。
- 接管守卫。
- 去向改回取子任务 metadata（集成第 11 条会失败）。
- 文案改回按预判写、不看投影结果（集成第 7、10 条会失败）。
- Admin 的 `superseded` 完整性改用并集长度。
- 扩展的 runner、锁持有、中继、outbox 条件各去掉一处；runner 和 outbox 改回只查 `(R,A2)`（扩展第 3 条会失败）。

**运行方式**同闭环文档：

- 生产同版 Node 18（`~/.nvm/versions/node/v18.20.8/bin/node`），加只读解析垫片（`--import …/register18.mjs`）。Admin 测试的 `typescript` 用 `NODE_PATH` 指向 eas-cli 自带的包。
- PostgreSQL 一次性实例（`LC_ALL=C initdb --locale=C`，`-c unix_socket_directories='' -c listen_addresses=127.0.0.1`，空闲端口），`TEST_DATABASE_URL`、`NODE_ENV=test`、`--test-concurrency=1`。
- 完整回归的失败名单与基线 `2a99bb1` 逐项比对。

## 上线顺序

1. **上线前只读核对（需用户点名主机）：**

   ```sql
   SELECT id, status, error->>'code', parent_task_id, task_type
   FROM capture_tasks WHERE id::text LIKE '1363ff0e%';
   SELECT id, status, metadata->>'distributionMode', metadata->>'operatorStopped'
   FROM capture_tasks WHERE id = '<上一条的 parent_task_id>';
   SELECT id, status, error->>'code', attempt_count, assigned_agent_id
   FROM capture_task_items WHERE execution_task_id = '<子任务 id>';
   SELECT id, command_type, status, expires_at
   FROM capture_agent_commands
   WHERE task_id = '<子任务 id>' AND status IN ('pending','acknowledged');
   ```

   预期：子任务 `needs_action` + 围栏码；父任务 `e768a43f` 仍在运行，`distributionMode='elastic_pool'`，没有 `operatorStopped`；工作项非终态（很可能是 `needs_action` + 围栏码，这一点是推断，以查询为准），`attempt_count` 未到预算；没有在途指令。
2. **提交**（见「建议的提交拆分」）并通过 CI。`server/`、`web/admin/` 下的 8 个文件必须与发布包构建时逐字节相同（哈希见「发布包」）；提交前若再改这些文件，要重建发布包。线上是 hotfix 线，不是主工作区。
3. **定稿发布包。** 在本机运行 `bash scratchpad/needsaction/stage/finalize.sh <完整 commit sha>`（取包含全部 8 个文件的那个提交）。它核对：该提交包含 `2a99bb1`；4 个服务端文件与包内逐字节相同；相对 `2a99bb1` 在 `server/`、`web/admin/` 下恰好只改了这 8 个文件；`web/admin` 与构建所用源码（`admin-source.sha256`）完全一致。通过后生成 `needs-action-fence-<短 sha>-20260925/`，把 `deploy.sh`、`release-manifest.json` 里的占位符换成 sha，并写 `local.sha256`。包和哈希都不变。
4. **第一次发布：服务端 + Admin。** 扩展、`manifest.json`、`update-manifest.js`、`public-downloads` 都不动。需要用户点名主机（上次是 47.103.125.200）：
   1. 把 `server.tar.gz`、`admin-dist.tar.gz`、`deploy.sh`、`release-manifest.json` 上传到 `/opt/onstarvoice-private/releases/needs-action-fence-<短 sha>-20260925/`，用 `local.sha256` 核对。
   2. `bash deploy.sh --check`：应输出 “preconditions OK: production matches 9b836f6, capture-stop-fence-release.js absent, update-manifest at 0.4.15”。失败时它会打印生产上的实际哈希，先查明原因，不要硬上。
   3. `bash deploy.sh`：成功时最后打印 `runtime.json` 和健康检查结果；失败时自动回滚到 `9b836f6` 并说明。
   4. 核对：健康检查通过；`/api/update-manifest` 仍为 0.4.15；pm2 `onstarvoice` 在线、错误日志没有新的模块加载错误；`/overview` 里金星的 `stop_fence.operator_confirmable_task_ids` 含 `1363ff0e`，`tasks[]` 里它的 `release_disposition` 为 `return_to_pool`；后台「执行节点」里金星的「确认旧页面已停止」可点，「让节点重新核对」仍置灰。
5. **现场处置金星：**
   1. 在金星电脑上关闭所有小红书、抖音、微博采集页。0.4.14 最稳妥是重启 Chrome，本机锁仍绑定旧任务。
   2. 后台「执行节点」→ 金星 →「确认旧页面已停止」。对话框列出 `1363ff0e`「需要处理 · 预计：退回任务池」，勾选后确认放行。
   3. 预期：
      - 返回文案含“重启 Chrome”，去向句以实际结果为准：预期为“退回任务池”；工作项已到预算时为“已达自动接力上限”；批次在此前被停止时为“已随批次取消”。
      - 任务事件出现 `historical_stop_fence_reconciled`（`releasedFromStatus=needs_action`，`itemOutcome` 与回执一致）。
      - 「檐下秋意」的工作项变为 `retryable`（按预期），其它节点的下一次心跳领走。
      - 金星下一次心跳领到新任务；本批次的「檐下秋意」不会回到金星。
      - 批次 `e768a43f` 最终能结束。
   4. 金星侧栏该任务仍显示「需要处理」，不必再点。
6. **Extension 部分随 0.4.16 发布**（清单见「等 0.4.16 一起发布的扩展改动」）：
   - 合入扩展提交后，`bash scripts/sync-extension-build.zsh production` 同步 `extension-build/`，用 `scripts/package-extension.zsh` 重新打包。
   - 把新的 SHA-256 和打包日期更新到闭环文档「安装包」一节（改日打包时，`update-manifest.js`、`about.html`、`tests/update-manifest.test.mjs` 的日期一起改）。
   - 此前打好的 0.4.16 包（SHA-256 `11034af1…`）作废，不再用于灰度。
   - 试点节点验证：构造一次孤儿围栏轮次（运行中关掉 runner 页，并让自动恢复以 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 收尾）。侧栏「继续」应显示“…在后台「执行节点」点「确认旧页面已停止」”，小红书采集页开着也一样（平台页不算存活迹象）。对照：旧 runner 页仍开着（含仍在加载）、或锁持有页仍存活时，应仍显示“旧运行页还在收尾”。后台确认后，下一次心跳执行 `release_only`，侧栏「继续」显示“后台已确认旧采集页面停止…本机无需继续”。全程没有页面刷新。

## 回滚

- **服务端 + Admin：**
  - 部署过程中失败（包括健康检查不过、资源取回不符、INT/TERM/HUP）：`deploy.sh` 自动回滚，恢复 3 个文件和 Admin index、删除 `capture-stop-fence-release.js`、重启并等健康检查。新 Admin 资源保留但不被引用。
  - 部署成功后要回滚：在发布目录里执行

    ```bash
    cd /opt/onstarvoice-private/releases/needs-action-fence-<短 sha>-20260925
    for f in server/routes/capture-cloud.js server/routes/capture-orchestrations.js server/services/capture-stop-fence.js; do cp -p "backup/$f" "/opt/onstarvoice/$f"; done
    rm -f /opt/onstarvoice/server/services/capture-stop-fence-release.js
    cp -p backup/admin/index.html /opt/onstarvoice/web/admin/dist/index.html
    pm2 restart onstarvoice
    ```

    然后做健康检查；`bash deploy.sh --check` 重新输出 OK 即说明已回到 `9b836f6`（模拟验证过）。同一目录不能再次部署（`backup/` 已存在），要重发就重新定稿一个新目录。
  - 已放行的行不回滚。它们是 `superseded` + 先例格式，旧代码既不算围栏，也不接受心跳改写。
  - 已退回任务池的弹性工作项是普通的 `retryable`，照常派发。
  - 放行后为 `needs_action`/`failed` 的工作项（固定分配，或弹性到预算的）：旧代码的「重试失败关键词」会以 `retry_source_not_settled` 拒绝。这些关键词只能靠「停止整个任务」后另开批次重跑。回滚前先在批次里重试掉。
  - 远程继续守卫随之消失，恢复原行为。
- **只想关掉 `needs_action` 放行：** 回滚 Admin 即可：`cp -p backup/admin/index.html /opt/onstarvoice/web/admin/dist/index.html`（index 每次请求从磁盘读，不用重启；旧资源一直保留着）。旧 Admin 包不发送 `needs_action` id，服务端对未显式选中的行保持原行为。
- **Extension：** 打 0.4.16 包之前 revert 扩展提交即可。已发布后，节点改回加载上一个包；侧栏恢复显示原始原因码，无其它影响。

## 已知风险与本次不做

已知风险：

1. **放行 `needs_action` 只凭运营确认**，信任级别与 `superseded` 行的 `operator_confirmed` 相同。如果旧页面其实仍在运行，节点会在同一浏览器里接新任务，可能触发平台风控。退回的关键词在别的节点上跑，不与旧页面同机。对话框已写明风险。这修订了闭环文档的不变量 3，由本次的文档提交同步改写。
2. **`superseded` 但没有后继。** `lib.ts` 的通用标签「已转入恢复任务」对这种行不准确，依靠 `execution.message` 和事件说明。标签本身不改。
3. **旧节点本机锁。** 见上文「旧节点」一节，处理方法是先重启 Chrome。
4. **预算与固定节点。** 已到预算的工作项按技术失败收尾，变为 `failed`，不再自动重试；回执如实写明，可在批次里重试。`pinnedAgentId` / each_agent 的工作项只会回到原节点。
5. **`resume_requested` 行不可放行。** 已经有人经 API 点过「继续」的，旧节点会把指令挂起直到 30 天过期，这期间只能「停止」（关键词丢失）。远程继续守卫阻止新的这类行；0.4.16 扩展改动让已有指令立即以失败完成，任务回到 `needs_action`，然后可以放行。界面本来不给弹性子任务单独的「继续」。
6. **「重试失败关键词」的三处判断。** 漏改任何一处，会出现“按钮在、点了 409”，由集成测试第 5、7 条锁定。
7. **0.4.16 `release_only` 可能反复失败。** 旧 runner 页冻结、outbox 未清时回 `checkpoint_reports_pending`，持有文档存活时回 `lock_holder_alive`。暂停派发最长到首次下发后 10 分钟，之后照常派发，与 `superseded` 相同。
8. **`needs_action` 行不进入自动核对。** 0.4.16 节点上的这类行也要人工确认。扩展侧“孤儿轮次”的新文案会把运营引到后台。
9. **进行中关键词的部分进度。** A1 残留的 checkpoint 行会在请求终态后被丢弃，正在跑的那个关键词的部分进度可能丢失，与所有自动恢复相同。已完成的 8/20 是持久的。
10. **`finalize` 的重试定时器**对孤儿轮次会一直空转，直到 R 离开请求槽。只有唤醒噪声，没有副作用。
11. **现场工作项状态是推断的。** 它可能是 `running`。投影对任何非终态都适用，上线前以只读查询为准。
12. **扩展改动使已打好的 0.4.16 包作废**，必须重新同步 `extension-build/`、重新打包，并记录新的 SHA-256。
13. **预计去向只是展示。** 面板和对话框的去向来自放行前的父任务状态，不含预算，也可能在确认前被「停止整个任务」改变。回执、子任务文案、事件、审计一律按投影后的实际结果写。
14. **扩展判定偏保守。** 旧 runner 冻结但未关（或仍在加载）、锁持有页存活、outbox 有 A1 待报行时，侧栏仍是“旧运行页还在收尾”，远程「继续」仍会挂起。新建这类远程指令已由服务端守卫拦住；运营走后台确认即可。锁持有状态为 `unknown` 时退回看 `holderTabId`，runner 刷新接续类围栏里它可能正是平台页，同样保守地保持 `deferred`。
15. **既有问题：普通弹性接力的来源也会卡住被停止的批次。** 弹性接力置 `superseded` 的子任务（routes 约 8018）写了 `terminalDisposition='superseded'`，批次被「停止整个任务」后同样停在 `waiting_device`。评审在基线上复现过，与本次无关，本次不修。本次的放行不写 `terminalDisposition`，所以不会新增这类情况。
16. **发布包绑定当前内容。** 包里的哈希是工作区当前内容；提交时这 8 个文件若有任何改动，`finalize.sh` 会拒绝，需要重新构建 Admin 和发布包并重跑模拟。

本次不做：

- 根任务、`manual_batch`、`failed`/`interrupted` 围栏的放行（前者本机可继续可停止，后者从不带这个码）。
- 对 `needs_action` 围栏做节点自动核对（会给轮询路径加活）。
- 本机从 checkpoint 续跑、合成 flush 标记。
- 改变「停止」「结束并保留」的语义（仍然取消关键词）。
- 「接力」接受已放行的来源（重试已够用）。
- 让「停止整个任务」一并停止 `needs_action` 子任务。停止后遗留的围栏由本次的后台确认放行（集成第 10 条）。
- 负面巡查、定向内容等其它工作流的围栏（写入点只在无人值守关键词路径）。

## 建议的提交拆分

1. `server`（可先发）：
   - `server/services/capture-stop-fence.js`：`stopFenceOperatorReleasable`、`stopFenceReleaseDisposition`、`stopFenceReleaseItemOutcome`、`stopFenceReleaseOutcomeSentence`、列表 2 列、概览字段、共用的记录构造、阶段文案。
   - `server/services/capture-stop-fence-release.js`（新文件）：`releaseNeedsActionStopFences`、`readNeedsActionReleaseItemOutcome`、`recordNeedsActionStopFenceOutcome`。
   - `server/routes/capture-cloud.js`：确认接口、错误文案、本机接管守卫。
   - `server/routes/capture-orchestrations.js`：`stopFenceReleasedRetrySource` 三处。
   - 纯函数单测与集成测试 1–8、10、11。
2. `server`（建议，可单独回滚）：远程「继续」守卫及集成测试 9。守卫与第 1 项同在 `capture-cloud.js`，拆开需要按块暂存；发布包包含它，`finalize.sh` 要用包含全部改动的那个提交。
3. `admin`：
   - `stop-fence-presentation.mjs` / `.d.mts`、`StopFencePanel.tsx`、`OrchestrationDetailWorkspace.tsx` 批次卡片文案。
   - Admin 测试。
4. `extension`（随 0.4.16，不单独部署）：
   - `background.js`（`classifyOrphanedStopFenceAttempt`、`inspectUnattendedCheckpointOutboxAttempt` 的 `anyAttempt` 选项、`prepareUnattendedManualRecoverySource`、`manuallyRecoverUnattendedKeywordRun`、`summarizeCloudRecoveryResult`、恢复消息处理）、`sidebar/sidebar-logic.js`。
   - `tests/background-capture-lock.test.mjs`。
   - 不含 `manifest.json` 版本号变更，版本发布仍按闭环文档单独提交。
5. `docs`：
   - 本文（已补「实现结果与集成验收」、发布包、上线与回滚）。
   - 闭环文档不变量 3 与「本次不做」中关于 `needs_action` 的两句改为引用本文。
