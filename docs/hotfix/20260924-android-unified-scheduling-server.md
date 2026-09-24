# 手机节点并入普通调度 · 服务端交付（20260924）

分支 `codex/feat-android-unified-scheduling-20260924`。本文覆盖契约 `20260924-android-unified-scheduling-design.md` §2（执行模型），只改 `server/**` 与 `tests/**`。

## 一、行为总览

手机（`agentKind='android_mobile'`）成为普通抖音关键词搜索节点：

- **run = 子任务（`execution_task_id`）**：`taskIdentity()` 的 `discoveryRunId/taskId` 改用 `item.execution_task_id`，`parent = item.task_id`。旧独立 run（`execution_task_id=task_id`）语义不变，因此存量数据与既有契约不受影响。
- **poll 领取两类工作项**（同事务、`FOR UPDATE ... SKIP LOCKED`、先 `lockAgent` 拿执行槽）：
  1. **已分配项**（固定分配 / 旧独立 run）：`item.assigned_agent_id=本机` 且 `execution_task_id` 指向 workflow=mobile、未停止、非弹性的子任务、`status IN (pending,retryable)`，parent 未停止；直接在既有子任务上开新 attempt（不新建子任务）。
  2. **弹性池项**：编排 parent `elastic_pool`、抖音、未停止、`item_type='keyword'`、`status IN (pending,retryable)`、`attempt_count<3`、无未结束 execution、无本机安全码栅栏，且 `pinnedAgentId=本机` 或（无 pinned 且 `eligibleAgentIds` 含本机）；命中后**新建 1 词的 mobile 子任务**并绑定，然后开 attempt。
  - 命中后统一走 `claimBoundItem`：首领时把子任务 `deadlineAt=now+batchMs`，建 attempt（`parent_task_id=item.task_id, execution_task_id=子任务`），项置 `running`，`assignment_revision+1`、`request_hash` 重算。
  - **手机永不建 create 命令**。
- **同机 retryable 再领带 `resumeAuthorized:true`**：`claimBoundItem` 检查“上一 attempt 是本机 且 项为 retryable”或显式 resume 标记。
- **固定分配（scheduler + 手动 dispatch）**：agent 为手机时建一个 mobile 子任务（含该组全部词、`distributionMode='fixed_batch'`、无命令），组内项置 `pending`+`execution_task_id=子任务`+`assigned_agent_id`，随后由 poll 第 1 类逐词领取。`agentFailure`/`agentCompatibilityFailure` 对手机改判（要求 `mobileSearchDiscoveryV1`、抖音在 allowed/supported、单段无负面巡查非近一月，不再要求 `remoteTaskCreate` 等浏览器能力）。
- **完成投影**：`deviceIdle=false` → `needs_action + deviceHeld`；`deviceIdle=true` 且成功 → `completed`；`deviceIdle=true` 且中断/待处理且**属编排子任务**且 `attempt_count<3` 且 parent 未停 → `retryable`，否则 `needs_action`；停止（子任务或 parent）→ `canceled`。子任务 `rollup` 后对编排子任务调 `refreshOrchestrationParentTask` 同步 parent 进度/状态。
- **停止传播**：编排 parent 停止（`POST /orchestrations/:id/stop`）对手机子任务置 `metadata.stopRequested=true`，无设备占用当场 `canceled`、占用则保留待手机确认；`control()`（poll/renew）同时看子任务与 parent 的停止标记（`stopRequested/operatorStopped/stopPending/stopCommandId`），手机据此停采并回执，随后经 complete/close 结算。
- **节点信息**：poll 体新增可选 `reason`、`probe`（有界），写入 `capabilities.readyForSearch/deviceReason/deviceProbe(+At)`；`GET /overview` 本就含全部 active/paused 节点（含手机）并透出 `capabilities`；`GET /android/runs/:id` 对编排子任务 id 也返回 run/items/candidates/events（items 改按 `execution_task_id` 关联）。
- **硬隔离**：手机弹性领取只圈 `item_type='keyword'` + 抖音 + eligible/pinned；浏览器 `dispatchNextElasticWorkItem` 仍在 `:7185` 对手机 early-return，且手机在采时项为 `running` → 浏览器被 `status` 栅栏挡住，无法领取；`crossDeviceRetryAgentSupportsTask` 对手机保留 `return false`（手机不收命令）。

## 二、改动文件

服务端：

- `server/services/android-control/mobile-tasks.js`（新增）：无依赖纯函数——`mobileTaskFilters`（sort/publishTime/contentType 映射与兜底）、`mobileTaskBudgets`（maxLinks=帖子上限或 0；maxCards/maxSwipes=0；keywordMs=分钟×60000；batchMs=keywordMs×词数+5 分钟；maxPending=100）、`mobileKeywordMinutes/Ms`（1–120 归一，默认 15）、`trimMobilePlanSnapshot`、`mobilePlanBlockReason`（非抖音/多段/负面巡查/近一月）。
- `server/services/android-control/validation.js`：`runInput` 关键词 1–300（新码 `KEYWORDS_1_TO_300_REQUIRED`），预算删除上限校验、允许 0、仅校验非负整数与 `keywordMs>0`。
- `server/services/android-control/leases.js`：`taskIdentity` 改用 `execution_task_id`；`control()` 读子任务+parent 停止；`poll()` 重写为 held → 已分配（case 1）→ 弹性（case 2）→ `claimBoundItem`；新增 `findAssignedCandidate`、`claimElasticItem`、`claimBoundItem`、`refreshOrchestrationParent`（动态 import 路由层导出）、`persistHeartbeat`（写 reason/probe）；`currentAttempt` 校验改为 `execution_task_id=run AND parent_task_id=item.task_id`；`renew` 读 parent 停止；导出 `MOBILE_ELASTIC_ATTEMPT_LIMIT`。
- `server/services/android-control/repository.js`：`heldItem` 关联子任务（`execution_task_id`）取子任务/parent metadata；`rollup` 按 `execution_task_id` 聚合并区分弹性（retryable→`interrupted` 释放项）与固定/独立（retryable→`pending` 原机再领）；新增 `parentStopRequested`。
- `server/services/android-control/completion.js`：完成投影追加 retryable（仅编排子任务）；`complete`/`closeDevice` 读 parent 停止、结算后对编排子任务调 `refreshOrchestrationParent`。
- `server/services/android-control/views.js`：`RUN_SQL` 进度与 `runView` items 关联改用 `execution_task_id`，使 `/android/runs/:id` 支持编排子任务。
- `server/services/capture-discovery/lineage.js`：`loadLineage` 约束由 `parent_task_id=$5 AND item.task_id=$5` 改为 `parent_task_id=item.task_id AND item.execution_task_id=$5`（run=子任务；独立 run 仍成立）。
- `server/services/capture-orchestration.js`：`normalizeOrchestrationRequest` 的 `taskInput` 追加可选 `mobileKeywordMaxMinutes`（1–120，仅调用方设置时落地，保持既有 plan 哈希稳定）。
- `server/services/capture-orchestration-scheduler.js`：`agentFailure` 手机分支；`materializeOccurrence` 固定分配循环对手机走新 `materializeMobileFixedBatchChild`（建 mobile 子任务、绑项 pending、无命令）。
- `server/routes/capture-orchestrations.js`：`agentCompatibilityFailure` 手机分支；一次性固定分配 `POST /orchestrations/:id/dispatch` 循环对手机建 mobile 子任务（无命令）；`POST /orchestrations/:id/stop` 子任务循环对手机走停止传播分支（置 stopRequested、按是否占设备决定当场取消或保留）。
- `server/routes/capture-cloud.js`：`export` `refreshOrchestrationParentTask`（供 android-control 动态引入）；其余（弹性 early-return、overview、requireCaptureAgent/requireBrowserTaskControl、`crossDeviceRetryAgentSupportsTask` 对手机拒绝）核对无需改动。

测试：

- `tests/android-control-route.test.mjs`：更新 `runInput` 断言（1–300、无上限、0 合法、`keywordMs>0`）。
- `tests/android-mobile-tasks.test.mjs`（新增）：filters/budgets/分钟归一/plan 阻断/裁剪 纯函数覆盖。
- `tests/integration/postgres/android-unified-scheduling.integration.mjs`（新增）：弹性领取建子任务+映射+无命令、完成+parent 聚合、retryable 同机 resumeAuthorized、固定分配 case 1、隔离（浏览器领不到在采手机项、手机领不到非 eligible 项）、真调度器固定分配物化、parent 停止 control 栅栏。
- `tests/integration/postgres/android-manual-dispatch-mobile.integration.mjs`（新增）：真 HTTP `POST /orchestrations/:id/dispatch` 手机固定分配建无命令子任务并被 poll 领取。

## 三、迁移

**无新增迁移。** 全部走既有 `capture_agents.capabilities`、`capture_tasks.metadata`、`capture_task_items`（`execution_task_id/assigned_agent_id/assignment_revision/request_hash/attempt_count`）等已有列与 JSONB 字段；四张共用表结构不变。

## 四、测试命令与结果

依赖软链：`ln -s /private/tmp/onstarvoice-plan-visibility-20260924/server/node_modules server/node_modules`（完成后 `rm server/node_modules`）。隔离库：本机 `postgres://127.0.0.1:5432/onstarvoice_test`（`onstarvoice_test*` 名允许）。

单元（Node 24.12.0）：
```
node --test tests/android-control-route.test.mjs tests/android-recovery.test.mjs \
  tests/android-mobile-tasks.test.mjs tests/capture-discovery-runner-contract.test.mjs \
  tests/capture-discovery-ui-binding.test.mjs tests/capture-discovery-backend.test.mjs \
  tests/capture-discovery-detail.test.mjs tests/capture-discovery-route.test.mjs \
  tests/server-capture-orchestration.test.mjs tests/server-capture-orchestration-route.test.mjs \
  tests/cloud-task-orchestration-wiring.test.mjs tests/server-capture-cloud-contract.test.mjs
# 220/220 通过
```
单元（Node 18.20.8，子集）：85/85 通过。

隔离 PG 集成（`TEST_DATABASE_URL=DATABASE_URL=postgres://127.0.0.1:5432/onstarvoice_test`，`--test-concurrency=1`）：
```
node --test --test-concurrency=1 \
  tests/integration/postgres/android-control.integration.mjs \
  tests/integration/postgres/android-unified-scheduling.integration.mjs \
  tests/integration/postgres/android-manual-dispatch-mobile.integration.mjs \
  tests/integration/postgres/capture-discovery.integration.mjs
# Node 24：40/40 通过；Node 18.20.8（前三个 android 文件）：25/25 通过
```
回归（Node 24，确认浏览器流未破）：`manual-keyword-dispatch`、`orchestration-retry-waiting`、`capture-plan-visibility`、`sequential-search-recovery`、`keyword-account-coverage`、`capture-discovery`、`capture-discovery-detail`、`detail-unavailable`、`capture-heartbeat-legacy`、`negative-patrol-fairness`、`negative-patrol-result-replay`、`historical-stop-fence`、`unattended-negative-patrol` 全通过（含“generic task stop withdraws mixed queues”，即停止级联路径）。

全量 `node scripts/run-postgres-integration-tests.mjs`（Node 24，全部 `tests/integration/postgres/*.integration.mjs` 串行）：**355/355 通过，0 失败**（含新增两支 android 集成用例）。

## 五、尚存风险

- **锁序**：手机 complete 事务锁序为 执行槽→item→子任务→parent，与浏览器 dispatch 的 parent→item 反向；弹性领取与 refresh（弹性分支不锁 item）用 `SKIP LOCKED`/只读规避，且 android 事务 `lockTimeoutMs=1000`（超时映射 503 重试）；未做高并发压测，理论仍可能偶发锁超时重试。
- **停止确认**：占用设备的手机子任务在 parent 停止后依赖手机下一次 poll/renew 看到停止标记并回执/close 才结算；手机长时间离线时 parent 会停在 `waiting_device`（与浏览器占用子任务同类语义），需运营或 close 兜底。
- **固定分配组上限**：一次性固定分配仍沿用“单节点一次最多 30 词”的浏览器约束（未对手机放开），大批词请用弹性池。
- **overview 透出**：服务端 `/overview` 已含手机节点与 capabilities，`deviceReason` 文案映射与就绪展示是后台（web/admin §3）职责。
- **reason/probe 心跳合并**：`persistHeartbeat` 仅在 liveness 过期或 readyForSearch/deviceReason 变化时落库（避免每 5 秒写库），`deviceProbe` 明细随之更新，probe 可能滞后于最近一次相同状态的探测。
- **契约偏差（已在设计文档 §2.5 追加一行说明）**：`retryable` 投影仅对编排子任务生效，独立 `/android/runs` 保留旧 `needs_action + 显式 resume`；`ONE_OR_TWO_KEYWORDS_REQUIRED` 落地为 `KEYWORDS_1_TO_300_REQUIRED`。
