# 无人值守采集 hotfix：兜底启动采集辅助被误判为旧运行页（stale_unattended_attempt）

分支：`codex/hotfix-unattended-stale-attempt-20260922`。基线：已核对的生产提交 `a23fcc0de36323c6161fa431700ad1463354891a`（Extension 0.4.11，`extension-build/` 与该提交扩展源码逐文件一致，本机 Chrome 各 Profile 加载的即是该目录；0.4.11 版本号提交 `ebc76a7` 之后到 `a23fcc0` 之间没有扩展文件改动）。

## 现象

- 2026-09-22 晚间小红书批次 `54d648a6-3f31-43c0-b3a6-1f259875abc6`，Windows「木星」14 次、macOS「上海」1 次失败，报错 `无法启动浏览器采集辅助：旧无人值守运行页已失效，已忽略其采集辅助请求`，内部码 `stale_unattended_attempt`。
- 节点心跳正常；任务失败后重新分配，后续任务继续同样报错；调高重试次数无效。
- 后台失败记录保留完整错误文本，但 `error.code` 为空。

## 根因（代码级确认）

无人值守一个 request 使用稳定 Debug taskId `unattended-capture:<requestId>`，后台 `inspectUnattendedCaptureTaskAttempt()` 对该 taskId 的每次 BEGIN/END 都要求携带当前 `attemptId`：`current = requestMatches && incomingAttemptId && currentAttemptId && incomingAttemptId === currentAttemptId`。`currentAttemptId` 优先取执行锁上绑定的 `captureTaskAttemptId`，否则取 request 的 `attemptId`。**incomingAttemptId 为空时必然判为 stale**。

运行页（`sidebar-logic.js`）的链路：

1. `runUnattendedKeywordPlanRequest()` 通过 `startUnattendedCaptureTaskSession()` 启动采集辅助，带 `attemptId: requestAttemptId`。0.4.x 起采集辅助是可选项（`85f8d79`，2026-09-02）：遇到 `capture_task_debug_busy`、`capture_task_external_debugger_busy`、`debug_session_attach_failed`、`capture_task_group_create_failed` 等 `OPTIONAL_CAPTURE_ASSIST_SESSION_CODES` 时不抛错，返回 `degraded`，`unattendedCaptureTaskSessionStarted = false`，并上报阶段 `capture_assist_degraded`（小红书在导航前后各试一次，抖音在最终页试一次）。
2. 随后调用 `handleBatchKeywordCapture({captureTaskSessionStarted: false, unattendedAttemptId, ...})`。批量函数看到会话未启动，走兜底 `ensurePersistentCaptureTaskSession()`，再次对同一个稳定 taskId 发 BEGIN，**但这次没有传 `attemptId`**（该兜底自 2026-07-19 `9c1d480` 起就没有 attempt 概念，在采集辅助变成可选之前不可达）。
3. 后台按 `incomingAttemptId = ''` 判 `current = false`，抛 `stale_unattended_attempt`。`startCaptureAssistSessionStrict()` 把它包成 `无法启动浏览器采集辅助：<后台文案>`；该码不在可选降级集合里（属于身份栅栏），直接向上抛出，整批失败。这就是报错文本与「启动浏览器采集辅助」阶段来源；它没有 `采集辅助启动失败（code）：` 前缀，说明失败来自兜底调用而不是 `startUnattendedCaptureTaskSession()` 的包装。
4. `handleBatchKeywordCapture` 的 catch 把错误压成 `{ok:false, error: error.message}`（丢掉 `code`），运行页再 `throw new Error(batchRunResult.error)`，终态上报 `error.code` 为 `""`。服务端 `capture-cloud.js` 原本把 `STALE_UNATTENDED_ATTEMPT` 列为不计费的技术失败（`ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES`）并按技术接力上限处理；码丢失后按普通失败计费、改派，形成「重新分配后继续报错」。另外 `maybeClaimAndRunUnattendedKeywordPlan()` 的外层 catch 上报时同样不带 `code`。

用户给出的四种候选中，成立的是第 3 种的一个特例：不是恢复/切换时序不同步，而是同一运行页、同一 attempt 内的兜底 BEGIN 根本没带身份，被栅栏当成旧运行页。旧运行页迟到请求（第 1 种）和新页面携带旧身份（第 2 种）在本次报错文本上无法区分，但它们会走 `startUnattendedCaptureTaskSession()` 的包装前缀，与线上文本不符。

## 身份错位时序（用真实 `background.js` 复现，`tests/background-capture-lock.test.mjs`）

| 步骤 | requestId | taskId | incoming attemptId | current attemptId | runnerTabId | documentId | 执行锁归属 | 结果 |
|---|---|---|---|---|---|---|---|---|
| 运行页领取，锁 `unattended_keyword_plan` 由运行页文档持有 | `unattended-run-1` | — | — | request=`attempt-current` | 42 | `fallback-document-1` | holderTabId 41，未绑定 task | 领取成功 |
| 首次 BEGIN（带 attempt） | 同上 | `unattended-capture:unattended-run-1` | `attempt-current` | `attempt-current` | 42 | 同上 | 绑定 captureTaskId + attemptId | 接受，Debug 会话在 tab 41 |
| 兜底 BEGIN（0.4.11 不带 attempt） | 同上 | 同上 | **空** | `attempt-current`（来自锁绑定） | 42 | 同上 | 未变 | `stale_unattended_attempt`，`reason=attempt_missing` |
| 旧页面迟到 BEGIN（对照） | 同上 | 同上 | `attempt-old` | `attempt-current` | 40 | `old-runner-document` | 未绑定 | `stale_unattended_attempt`，`reason=attempt_mismatch`（保持拒绝） |

错位发生在第 3 步：不是 request、锁或运行页变了，而是发起方丢了 attempt 身份。修复前后台没有把这些字段随错误返回，线上记录里无法直接看到；修复后每次拒绝都会带上上表字段。

## 修复

Extension（需发 0.4.12）：

- `sidebar/sidebar-logic.js`
  - `handleBatchKeywordCapture()` 的兜底 `ensurePersistentCaptureTaskSession()` 在无人值守下带 `attemptId: scopedUnattendedAttemptId` 与 `ownerRequired: false`（运行页不拥有无人值守任务生命周期，与主启动路径一致）。采集辅助仍不可用时按既有可选降级继续页面采集，不再整批失败。
  - 批量 catch 保留 `errorCode` / `errorDetails`；运行页重新抛出时恢复 `code` / `details`；外层领取失败上报补 `code` 与栅栏详情。
  - `capture_assist_degraded` 阶段消息带上降级原因码（例如 `浏览器采集辅助不可用（capture_task_debug_busy），已继续执行采集`），便于下次直接看到兜底之前发生了什么。
- `background.js`
  - 新增 `describeStaleUnattendedAttempt()` / `createStaleUnattendedAttemptError()`：BEGIN 两处拒绝与 END 的 ignored 结果都带有界身份详情（reason、requestId、incoming/current attemptId、后台当前 request 的 id/attempt/status/runnerTabId、锁 id/owner/holderId/holderDocumentId/holderTabId/绑定 task+attempt、sender tabId/documentId/请求 id、sourceTabId、时间），只含内部标识，不含页面内容。
  - 缺 attempt 的请求文案改为 `采集辅助请求缺少当前无人值守执行轮次标识，已按旧运行页拒绝`，错误码不变（`stale_unattended_attempt`），旧任务隔离与防重复执行逻辑未改。
- `utils/task-center.js`：`normalizeCaptureFenceErrorDetails()` 接受 `stale_unattended_attempt` 详情（UUID/文档 ID/tab id/枚举白名单过滤），任务台账、心跳上传与诊断导出保留这些字段。

Server（随本分支发布，不含迁移）：

- `capture-health-schema.js` 恢复分类允许列表新增 `stale_unattended_attempt`、`unattended_runner_mismatch`、`unattended_request_terminal`，恢复意图证据不再把它们折成 `UNKNOWN`。
- 版本 0.4.12：`manifest.json`、`update-manifest.js`（下载名 `StarVoice-extension-v0.4.12-20260922.zip`）、`about.html`、`ops-control.js` 基线。

未改动：后台栅栏判定条件、锁转移/续租/释放、恢复轮换 attempt 的逻辑、服务端计费/改派规则、数据库结构。

## 验证

- 新增后台回归 4 项（真实 `background.js` + 假 chrome）：不带 attempt 的兜底 BEGIN 被拒且带完整身份详情，同时现有 Debug 会话、锁绑定、request 状态不受影响，再带当前 attempt 的 BEGIN 仍被接受；旧 attempt 迟到 BEGIN 仍被拒（`attempt_mismatch`）；不属于当前 request 的 BEGIN 报 `request_mismatch` 并给出后台当前 request；不带 attempt 的 END 被忽略并带详情。
- 新增 sidebar 接线回归 3 项：兜底启动必须带 scoped attempt 且不绑定 owner；批量失败保留 code/details、运行页重抛恢复 code、外层上报带 code、降级阶段带原因码；批量 catch 代码块以可执行方式验证 `errorCode`/`errorDetails` 透传。
- 新增 normalizer 回归 1 项（只导出有界身份，剔除 cookie/正文/URL 等）、服务端允许列表 3 行、更新清单测试改为 0.4.12。
- `tests/capture` 目录 647 项通过；`tests/background-capture-lock.test.mjs` 全量通过；服务端 `update-manifest`、`capture-health-schema`、`server-sequential-search-completion`、`capture-recovery-intents` 通过。完整 Node 回归首轮 2524 项中 6 个 admin 测试文件因新工作区缺 typescript 依赖失败，链接依赖后第二轮完整回归 2556 项全部通过（Node 24.12.0）。
- `scripts/check-extension-snapshot.zsh` 通过；候选包 `StarVoice-extension-v0.4.12-20260922.zip`（99 文件，生产 API，SHA-256 `3484a6c17e043152928071a74615f95de0f2b9fd1f6bd93b692cb1537f0dcd4c`）仅生成在本工作区，没有替换设备已加载的 `extension-build/`。
- 未做：真实浏览器无人值守批次复跑（需要客户节点加载 0.4.12）；线上批次 `54d648a6…` 的服务端记录核对（本会话未授权访问生产库/主机）。

## 建议的线上交叉核对（无需改代码）

对批次 `54d648a6-3f31-43c0-b3a6-1f259875abc6` 的失败项，查看失败前最后一条进度阶段：若为 `capture_assist_degraded`（消息「浏览器采集辅助不可用，已继续执行采集」）紧接失败，即与本文根因一致；同一节点连续多项的降级原因很可能相同（Debug 被占用/外部调试器/组创建失败），0.4.12 会把原因码写进该阶段消息。

## 交付状态

代码已在本分支提交，未推送、未部署。发布需要：Server 文件（允许列表 + 版本/更新清单/关于页）、Extension 0.4.12 正式包与下载链接、各节点重新加载扩展。主项目目录仍停留在架构分支且未提交改动原样保留。
