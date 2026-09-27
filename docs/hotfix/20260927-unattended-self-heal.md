# 无人值守自愈：旧页面停不下来时由节点自己收尾，能证明就自动放行（设计）

分支：`codex/hotfix-unattended-self-heal-20260927`（工作区 `OnStarvoice-hotfix-unattended-self-heal-20260927`）。发布基线：`31b51d1`（F1–F3 已于 09-27 上线；本分支已合入）。原始现场分析基于 `e791483`，当时节点均为 Extension 0.4.18。

本文记录设计与 09-27 接续修复后的实际行为。发布目标为 Extension 0.4.19；尚未部署，必须在全量回归、CI 5/5、发布回滚演练通过并取得用户同意后上线。

- **并行 hotfix**：`codex/hotfix-stuck-retry-cleanup-20260927`，内容为 F1 弹性重试轮超时后放宽、F2 同一小红书时间筛选失败满 K=3 次即判失败、F3 手动「结束并移到历史」、F3b 历史清理跳过。它的设计文档 `docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md`（下称「F3 文档」）已经写出，该修复已作为 `31b51d1` 独立上线；本次继续使用独立 hotfix 分支，不把第二个 XHS 时间筛选修复混入。**S4 建在 F3 之上**：判定和结算都用 F3 的 `loadOperatorCloseEligibility` 和 `closeOperatorAttentionRoot`，S4 只加自动触发的条件。衔接点见「与 F1–F3 的衔接」。
- **前序文档**：`docs/hotfix/20260925-stop-fence-closure.md`（下称「闭环文档」）和 `docs/hotfix/20260925-needs-action-fence.md`（下称「needs_action 文档」）。
- **行号**：以 `e791483` 为准，都是约数。
- **本版修订**（按评审意见）：
  - S4 改为复用 F3 的判定和结算，不再单独写一套；不改入库回执门槛；K1 不在产生时处理；候选查询改为带游标的廉价查询。
  - S2 不再关来源页，只关登记过的详情工作页；本机证明改用与闭环核对相同的全量扫描；换代时把锁标成不许刷新；runner 改为事件驱动退役；关 runner 与释放锁放进同一次锁操作；自停期间刷新心跳。
  - S3 补上「让节点重新核对」路由、快照归一化剥离和第二个预检调用者。

用户原话：“我可以人工确认，但是我做无人值守的初衷，就是不希望我时时刻刻盯着他，否则我要累死了。”

## 结论

- **卡住后检测并不慢。** 09-27 火星那次的“95 分钟”是整轮运行时长，前 81 分钟一直有进展。停在第 29/50 条的评论阶段后，看门狗 12 分 18 秒就触发了，和评论阶段 12 分钟的阈值一致。上海那次很可能是**误判**：预加载标签页的进度事件覆盖了阶段，看门狗改用 6 分钟的通用阈值，把一条仍在 10 分钟预算内的评论采集判成了卡住。
- **真正让人值班的是恢复里“停旧页面”这一步。**
  - 恢复时只拿两个裸标签页 id 去“取消 + 刷新 + 10 秒内等页面重新就绪”。偏偏停不下来的正是卡住或被节流的那一页，所以这一步大概率失败。
  - 失败后直接写 `needs_action / PREVIOUS_CAPTURE_STOP_UNCONFIRMED`：旧 runner、执行锁、工作页全留在原地，节点从此不接单，直到有人点。
  - 30 天里 47 个这样的任务，每一个都是靠人或靠后来的一次运行才解开，没有一个是自动解开的。锁住的时长从 1.4 小时到 154 小时不等。
- **本次改四件事：**
  - **S1**：评论阶段的阈值不再被旁路事件覆盖，给几个没有上限的等待加上上限，让下一次卡住能从服务端看出停在哪一步。
  - **S2**：恢复时节点只停自己的东西。先把绑定 R 的执行锁标成“不许刷新”，按请求 id 取消，关闭扩展为这一轮创建的详情工作页，再用与闭环核对相同的全量扫描规则证明旧页面已停；证明成立就继续自动恢复。证明不了时先在 `recovering` 里有限次重试（期间照常刷新心跳），仍不行才写 `needs_action`，并写明原因。整个过程不刷新任何平台页，不关来源页，不碰用户自己的标签页。
  - **S3**：服务端对「需要处理」的批次子任务围栏，也向有能力的节点下发自动核对；节点证明成立就按 needs_action 放行的语义自动放行。0.4.18 已经能处理这种核对，这一项只改服务端，可以先上。
  - **S4**：需处理里没人能处理的死行（补详情无入库回执、手动批次页被关、过期的手机独立运行、手机弹性批次用尽次数），由系统在各类宽限期之后，用 F3 的同一判定和同一结算例程（`mode:'automatic'`）结束并移到历史。带围栏码或人工必需标记的行永远不自动处理。

## 现场与证据

证据：`scratchpad/selfheal0927/fenced-evidence.jsonl`（生产只读导出：两例的 task/attempt/event，近 30 天 47 个围栏任务，以及它们的状态事件）；需处理数据来自 `scratchpad/idle0927/diag.out`。时间均为北京时间。

### 09-27 两例

| | 火星 `39b541f8`（别克哨兵，弹性批次 `408d1410` 子任务） | 上海 `6bd697a1`（ibuick，同一批次） |
|---|---|---|
| 开始运行 | 03:33 | 03:34:34 |
| 最后一次业务进展 | 04:54:14，`detail_comments_capturing`「标记 #29（第 29/50 条）：正在采集评论...」 | 03:38:06，`detail_item_prefetch_ready`「工作页 B 已加载下一条，等待当前采集完成」，current/total = 0/0 |
| 本机判定卡住 | 05:06:32（间隔 12 分 18 秒 = 评论阈值 12 分钟 + 1 分钟巡检） | 03:44:14（间隔 6 分 08 秒 = 通用阈值 6 分钟） |
| 判定时的内容进度 | `captureProgressAgeMs = null`，已没有内容中继在写进度 | 03:43:52 时 `captureProgressAgeMs = 123`，页面还在产出评论进度 |
| 服务端 `recovering` / `needs_action` | 05:08:28 / 05:08:47 | 03:44:14 / 03:44:31 |
| 人工放行 | 12:01:20（节点被挡 6 小时 53 分） | 12:01:07（8 小时 17 分） |
| 放行时本机状态 | `local_lock_absent`，关闭 runner 0 个，残留已回收 | 同左 |

放行时节点上已经没有绑定该请求的锁，也没有 runner，只剩采集辅助的残留。换句话说，这时旧页面是可以证明已经停了的，只是没有人（也没有机器）去问。

### 30 天：47 个围栏任务

- **每天的数量**（09-17 到 09-27）：4、1、2、1、3、6、10、9、6、3、2。全部是 `unattended_keyword_capture`，涉及 12 个节点：成都 7、北京 6、木星 6、重庆 5、上海 5……mac 和 Windows、Chrome 和 Edge 都有，是系统性问题，与节点无关。
- **触发原因**：
  - 采集业务长时间没有新进展：29
  - 运行页心跳中断：9
  - 运行页不存在或已被关闭：3
  - 运行页未在规定时间内领取任务：1
  - 服务端没收到 `recovering`，直接 `running→needs_action`：5
- **时段**：03–05 点 18 个，19–22 点 25 个，其它时段 4 个。
- **被挡在哪一次恢复**：42/47 是第一次自动恢复就被围栏挡住。从 `recovering` 到 `needs_action` 用了 6–97 秒，中位约 22 秒，正好是“刷新 10 秒 + 就绪 5 秒”这类超时的量级。
- **所有 47 行的文案一样**：“旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续”。这句话只由 `recoverUnattendedKeywordRunRequest` 写出（`background.js` 约 15293），`error.reason` 全部为空。
- **最后怎么解开的**：
  - 25 个是后来同一节点又完成了一次执行，事后按规则判定（完成 21 个、取消 4 个）
  - 1 个走 976a0c6 准入规则
  - 5 + 1 + 2 = 8 个由运营确认
  - 13 个被运营直接「停止」
  - **没有一个是自动解开的。** 从任务创建到解开：1.4–154 小时。
- **只有 `a656fc8e`（地球，09-25）跑过一次自动核对**：连续三轮都是 `tab_frozen`，对应一页 `about:blank`，也就是扩展自己建的详情工作页。三轮后上报人工，最后由运营放行。S2/S2' 关闭登记过的详情工作页，正好解决这种情况。

## 根因

### S1 为什么业务不动，为什么看起来检测慢

**1. 检测不慢。**

- 看门狗是 `assessUnattendedRunHealth`（`background.js` 约 14627）：通用阈值 `UNATTENDED_RUN_BUSINESS_STALL_MS = 6 分钟`（约 184），评论阶段 `UNATTENDED_RUN_COMMENT_STAGE_STALL_MS = 12 分钟`（约 190），巡检每 1 分钟一次。
- 火星在第 29 条的评论阶段停住，12 分 18 秒后触发，与阈值一致。
- 47 例里有 11 例在运行 45–117 分钟后才判定卡住，情况都和火星一样：已经跑到详情队列深处才停住，并不是检测晚了。

**2. 阶段被旁路事件覆盖，导致用错阈值（上海）。**

- `utils/capture-sync.js` 约 4484–4518 的 `onTransition` 里，预加载工作页和释放工作页的事件（`detail_item_prefetch_loading/ready`、`detail_worker_released`）只报 `runnerTabId`、`workerStates` 这些字段，不带 current/total，也不带前台当前阶段。它们会变成 `request.progress.phase`，于是：
  - 界面上显示 0/0；
  - 看门狗改用 6 分钟阈值，即使前台工作页 A 正在 `comments_capture`（`activeDetailItemContext.activeStage` 里有这个值，只是没有上报）。
- `assessUnattendedRunHealth` 和服务端 `keyword-node-coverage.js` 的 `stalledExecution`（约 40–55）都还检查 `progress.captureAction === 'captureComments'`，但这个字段在三处被丢掉了，所以这条分支是死代码：
  - 侧栏上报快照（`sidebar/sidebar-logic.js` 约 16075–16200）
  - `normalizeUnattendedRunProgress`（`background.js` 约 554）
  - 台账的 `normalizeProgress`（`utils/task-center.js` 约 266）

**3. 两次进度事件之间有等不到头的等待（火星的可能原因，无法从服务端证实）。**

- `chrome.scripting.executeScript` 没有超时，出现在 `probeDetailUnavailableInTab`（约 15559）、`probeDetailPreloadSafety` 的每轮循环（约 13391）、`waitForOpenedUrlInTab` 的可用性探测（约 13326）三处。这些循环只在两轮之间检查耗时，渲染进程挂住或后台工作页被冻结时就会永远等下去。
- `sendCaptureTraceBindingsToTab(sourceTabId)`（约 1160）每条作品要等两次（约 5064，以及评论后约 6180）。它向后台的搜索页转发 `updateListCaptureTraceBindings`，用的是默认 4 分钟中继超时，失败还会再重试一次；而结果本来就是尽力而为，调用方根本不看。
- 博主指标页的导航与工作页 B 的预加载共用一个 `navigationQueue`（`detail-prefetch-pipeline.js` 约 212–232、498–510），要排在预加载后面。
- 火星判定时没有中继在写内容进度，说明卡在评论中继之后或附近。节点诊断（`utils/diagnostics.js` 的 60 段环形记录）只存在节点本地，不上传，所以无法精确定位是哪一个等待。

**4. 单步最坏耗时超过看门狗阈值。**

- 评论中继的超时是 min(11 分钟, 10 分钟 + 30 秒) = 10.5 分钟（约 17536–17557）。
- 90 秒没有进展（`CONTENT_RELAY_STALLED`）时，`relayToContentWithRetry`（约 18063）会先取消，再刷新页面（最多约 45 秒），然后带着**完整的新预算**重试一次。
- 所以评论一步最坏要 12.75–21.6 分钟，超过 12 分钟阈值；默认 4 分钟的动作最坏 6.3–8.7 分钟，超过 6 分钟阈值。
- 本次不改这一点（见「S1 本次不做」）。S2 之后，一次误判的代价只是多一次恢复，不会再把节点挡住。

**5. 心跳中断的 9 例，推测原因（无数据证实）。** runner 心跳每 30 秒一次，上一次上报还没返回时会跳过这一拍（`reportInFlight`，约 15970–16010）。如果某个 `chrome.runtime.sendMessage` 卡在被阻塞的后台变更上，就会表现为“运行页心跳中断”，而页面其实还活着。

### S2 为什么“停旧页面”会失败

恢复路径 `recoverUnattendedKeywordRunRequest`（约 15111）的顺序是“先换代，再停旧页面”：

1. 一次变更里写入新轮次 A2：`status='recovering'`，`previousAttemptId=A1`，`runnerTabId=null`，`recoveryWaitUntil = now + 60 秒`。
2. 立即调用 `stopUnattendedCaptureTargetsForRecovery([progress.runnerTabId, oldLock.holderTabId])`（约 15278）。
   - 这两个都是**裸标签页 id**，所以没有 `captureRequestId`，也没有给旧请求打中止标记，并且允许刷新页面。
   - 因此 `stopPreviousUnattendedCaptureForResume`（约 8705）永远用不上不刷新就能证明的 `content_capture_settled`，只能先发不限定请求的取消，再走 `reloadUnattendedCaptureTabAndConfirm`（约 8675）。
   - 刷新后的确认：10 秒内必须看到 loading→complete，然后注入 content-loader，再在 5 秒内收到 ping 回应。任何一步超时或出错、而标签页又还在，就判 `stop_unconfirmed`。
   - 逐个目标检查，遇到第一个失败就返回，后面的目标根本不看。
3. 失败时调用 `markUnattendedRecoveryStopUnconfirmed`（约 14834），写入 `needs_action`，然后返回。

这一步会失败的场景，正好就是卡住的场景：

- 页面刷新慢（深夜的小红书页面很重；窗口被遮挡或隐藏；Edge/Windows 的效率模式和睡眠标签页）
- 渲染进程挂住，就是那个采集卡住的页面
- 刷新后变成 Chrome 网络错误页，注入会失败
- ping 回应超过 5 秒
- `beforeunload` 弹窗

还有一种情况**必然**失败：BEGIN 绑定锁（约 18689）之前，锁的持有页是 runner 页本身（领取时占用，约 14045），`inspectUnattendedCaptureStopTarget`（约 8644）对扩展页返回 `source_identity_unverifiable`。

这一步本身还有三个问题：

- **可能刷新用户自己的页面。** `activateOrCreatePlatformTab`（约 17297）会复用任何已存在的平台标签页，优先当前窗口和活动页。启动时返回的 `created` 在两个调用处（约 14486、14999）都被丢弃了。
- **可能把旧采集复活。** 旧的 `captureRequestId` 没有被标为中止，旧中继会把刷新当成暂时错误，重新注入后把同一个采集请求再发进新文档（约 18108–18126）。
- **经常停错页面。** 上海最后一条进度来自预加载工作页 B，于是恢复去停 B 和来源页，而正在采集评论的工作页 A 没有被处理。

写入 `needs_action` 的那一刻，节点上还有这些东西没有确定或还活着：

1. 失败那一页的文档状态：可能是旧文档还活着、新文档在加载或没就绪、或者是错误页，代码分不清。
2. 第一个失败之后的目标：从来没检查。
3. A1 的 runner 页：还开着，仍是锁的 `holderDocumentId`，还在续锁。它只在上报（`attempt_mismatch`）和 BEGIN 时被挡住：侧栏的 `handleUnattendedRunRequestStorageChange`（`sidebar-logic.js` 约 3079）不处理轮次变化，中继入口 `onstarvoice:relay-to-content`（约 22443）也没有轮次围栏。所以在下一次上报被拒之前，它还能发起新的采集。
4. A1 在后台的在途中继：没有中止。
5. 工作页 A/B、Debug 会话、原生标签组：原样留着。
6. 绑定 R/A1 的执行锁：原样留着。
7. A1 的 checkpoint 上报队列（outbox）：持久在 `chrome.storage.local`，换代后会被拒（`attempt_mismatch`/`terminal`），并按终态拒绝从 outbox 丢弃（`utils/unattended-report-outbox.js`）。
8. A1 runner 内存里的流式上传队列（`streamingSyncQueue`）：尚未上传的部分。记录本身已写入本地数据池。

逐页证据 `stopFenceEvidence` 只存在本机，服务端的 `error.reason` 是空字符串，所以现在无法按个案判断到底是哪一步失败。

### 为什么失败之后只能等人

- 闭环文档的自动核对只对 `superseded` 行下发。服务端有五处写死了 `status='superseded'`：
  - 心跳预检 `readStopFenceHeartbeatWork`（`server/services/capture-stop-fence.js` 约 729）
  - 领取列表 `claimStopFenceCheckOffers` → `listCaptureAgentStopFences(onlySuperseded:true)`（约 1392、624）
  - 领取时的行锁（约 1402）
  - 回执 `completeStopFenceCheckReceipt`：状态不是 `superseded` 就回 409 stale（约 1717）
  - 重新核对 `rotateStopFenceChecks`（约 1842），以及它的路由 `/agents/:id/stop-fence/recheck`（`server/routes/capture-cloud.js` 约 11703–11735）
- 批次子任务的 `needs_action` 围栏只能由运营点「确认旧页面已停止」（needs_action 文档）；根任务要在节点上「继续」或「停止」。
- 节点被 `captureTaskUnconfirmedLocalStopSql` 挡在准入之外，直到有人处理。

## 目标与不变量

目标：

1. 节点能证明旧页面已停时，不等人。节点可以在恢复当场自己证明（S2），也可以事后回答服务端发起的核对（S3）。
2. 只有机器确实判断不了时才需要人，并且写清原因。例如：小红书登录页或安全页；用户自己的标签页正在忙，又无法证明；无法识别的锁持有者。
3. 需处理里不堆积没人能处理的行（S4）。

不变量（实现和评审逐条核对）：

1. **一个节点上永远只有一条采集流水线。** A2 只能在 A1 被证明已停之后启动，这和今天相同。0.4.19 另外加两道防线：中继入口的轮次围栏（后台强制），以及 runner 发现轮次变化后立即退役。
2. **只关扩展为该请求的旧轮次创建的标签页**，只有两种：
   - 本请求更早轮次的 runner 页，按 URL 同时带 R 和该轮次 id 认；
   - 登记表里 R 名下、不是当前轮次的**详情工作页**：由 `createDedicatedDetailRunnerTab` 建，并经后台用 `tabs.onCreated` 核实。

   来源平台页一律不关，即使是扩展新建的：它会被之后的请求、本地计划运行和用户复用，登记关系在复用后就不成立。用户的标签页、锁持有页、进度里记的页，只要不属于上面两种，一律不关。
3. **不刷新、不导航用户可能在用的平台页。**
   - 恢复路径里去掉 reload。新代码只发限定到 R 的取消、查询活动、关闭自己建的页。
   - 换代时把绑定 R 的执行锁标成 `allowReload:false`。于是其它读锁路径（侧栏打开、手动批次、定向单帖、云端指令、计划闹钟）遇到这把锁过期或持有文档消失时，也不会刷新它的持有页。
4. **围栏只在节点证明或运营确认之后解除。** S3 只认节点的核对回执。S2 的本机证明用与闭环核对相同的全量扫描规则（`sweepStopFenceBrowser` + `judgeStopFenceSweep`），不比 S3 弱。它发生在服务端写入围栏之前，这时服务端上的行是 `recovering`，不是围栏行。
5. **不加数据库迁移。**
6. **心跳等轮询路径不加重活。** 心跳预检只在已有的 `EXISTS` 里多一个 OR 分支。S2 只在恢复转换和每分钟一次的巡检里运行。S4 放在 cron 里，不跑约 275 ms 的围栏 SQL。
7. **旧节点行为不变。** 没有能力声明的节点收不到新的核对，概览仍是今天的阶段。
8. **S4 永远不碰带 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 的行，也不碰包含这种行的任务树**（F3 的 `stop_fence` 资格码）。围栏 SQL 把 `failed` 也当作未确认，把围栏行结算成失败只会让节点被挡得悄无声息。

## 方案总览

| 项 | 内容 | 主要位置 | 随哪次发布 |
|---|---|---|---|
| S1-1 | 旁路事件带上前台阶段；`captureAction`/`activeStage` 经三处归一化后保留 | `utils/capture-sync.js`、`sidebar/sidebar-logic.js`、`background.js`、`utils/task-center.js` | Extension 0.4.19 |
| S1-2 | `updateListCaptureTraceBindings` 改为尽力而为：10 秒、不取消、不刷新、不重试 | `background.js` `getContentRelayTimeoutMs`、`relayToContentWithRetry` | 0.4.19 |
| S1-3 | `executeScript` 探测加 10 秒上限 | `utils/capture-sync.js` 三处 | 0.4.19 |
| S1-4 | 可诊断：停止失败写 `error.reason`，进度带 `activeStage` | `background.js`、`utils/task-center.js` | 0.4.19 |
| S2 | 恢复时自停：锁标成不许刷新 → 围住 A1（runner 事件驱动退役）→ 限定取消 → 关登记过的详情工作页 → 全量扫描证明 → 在一次锁操作里关卡死的 runner 并释放锁 → 继续恢复；在 `recovering` 里有限次重试（每次刷新心跳），最后才写 `needs_action`（带原因） | `background.js`、`sidebar/sidebar-logic.js`、`utils/capture/detail-runner.js` | 0.4.19 |
| S2' | 节点核对（S3 的节点侧）里，登记表里 R 名下的详情工作页证据不成立时关闭，改报 `tab_closed` | `background.js` `confirmPreviousUnattendedStopForFenceCheck` | 0.4.19 |
| S2-srv | 覆盖调度把“正在自停”的恢复子任务视为有响应 | `server/services/keyword-node-coverage.js` | 服务端，先发 |
| S3 | 需要处理的批次子任务围栏也下发自动核对；证明成立按 needs_action 放行 | `server/services/capture-stop-fence.js`、`capture-stop-fence-release.js`、`capture-cloud.js`，`server/routes/capture-cloud.js` | **只改服务端，先发** |
| S4 | 死行自动结算：复用 F3 的判定和结算（`mode:'automatic'`），只加每类宽限期、人工必需标记和带游标的廉价候选查询；K4 产生时修正 | 新增 `server/services/capture-dead-attention.js`（候选与分类）、`server/routes/capture-cloud.js`（清扫入口）、`android-control/completion.js`、`server/cron.js` | 服务端，建在 F3 之上，同一发布 |

## S1 改动（随 0.4.19）

### S1-1 阈值跟随前台阶段

- `utils/capture-sync.js` `onTransition`（约 4484–4518）：`detail_item_prefetch_loading`、`detail_item_prefetch_ready`、`detail_worker_released` 三个事件都从 `activeDetailItemContext` 补上：
  - `current`、`total`：前台正在处理的序号和总数，替代现在的 0/0；
  - `activeStage`；
  - `captureAction`：`activeStage === 'comments_capture'` 时为 `'captureComments'`，否则**显式写成空串**，防止上一个事件的值被沿用。

  事件自己的 `recordId`（预加载的那条）保持不变。主评论事件 `detail_comments_capturing` 也补上 `captureAction` 和 `activeStage`。
- `captureAction`（最多 40 字，可为空）和 `activeStage`（最多 40 字）需要在三处保留下来：
  - 侧栏上报快照（`sidebar-logic.js` 约 16130）
  - `normalizeUnattendedRunProgress`（`background.js` 约 554，按原样重建，不与上一次合并）
  - `utils/task-center.js` 的 `normalizeProgress`（约 266）

  服务端 `normalizeCloudTaskSnapshot` 对 progress 是原样透传的结构化对象，所以不用改服务端，`keyword-node-coverage.js` 里原本是死代码的 `captureAction` 分支会自动生效。
- `assessUnattendedRunHealth`（约 14680）再加一个兜底条件：`progress.activeStage === 'comments_capture'` 也按评论阈值处理。
- 效果：上海这类“评论还在跑，却被 6 分钟阈值误判”的情况消失；真正卡住的仍会在 6 或 12 分钟、再加 1 分钟巡检内被发现。全局阈值不调。

### S1-2 尽力而为的覆盖层消息不再拖住流水线

- `getContentRelayTimeoutMs`（约 17536）：`updateListCaptureTraceBindings` 与 `ping` 等动作同样用 10 秒。
- `relayToContentWithRetry`（约 18063）：新增 `CONTENT_RELAY_BEST_EFFORT_ACTIONS = {'updateListCaptureTraceBindings'}`。这些动作只发一次，超时或出错直接抛给调用方，调用方本来就忽略结果。**不**调用 `cancelTimedOutContentCapture`，因为它带的是空 `captureRequestId`，在列表阶段会取消来源页上正在进行的列表采集；也不走停滞刷新和暂时错误重注入。
- 不让 runner 侧单方面限时。那样后台中继还会在登记表里挂最多 4 分钟以上，会拖住 S2 的“中继已清空”证明。

### S1-3 `executeScript` 加上限

- 新增 `executeScriptWithTimeout(details, timeoutMs = 10_000)`，用 `Promise.race` 实现，超时返回 `null`。用在三处：
  - `probeDetailUnavailableInTab`（约 15559）
  - `probeDetailPreloadSafety` 每轮循环（约 13391）
  - `waitForOpenedUrlInTab` 的可用性探测（约 13326）
- 这三处原本就把 `null` 或异常当作“没就绪/未知”，已有的循环截止时间会接着生效。超时的 promise 留在后台，没有副作用。

### S1-4 可诊断

- 每次写 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 都带上 `error.reason`（原因码见 S2）。`utils/task-center.js` 的 `normalizeError` 已保留 `reason`（最多 160 字），服务端不用改。
- 进度里的 `activeStage` 随 S1-1 一起上报。下一次卡住时，服务端就能看出冻结在 `note_capture`、`blogger_metrics_capture`、`comments_capture` 还是 `commit_guard`。

### S1 本次不做

- **中继预算跨“停滞→刷新→重试”累计**：会改变所有中继（包括手动采集）的预算，需要专门回归。S2 之后误判的代价只是一次恢复，所以先不做。
- **9 例心跳中断**：`reportInFlight` 的假设先用 S1-4 的诊断数据验证。
- **博主指标导航和预加载共用队列**：先看 `activeStage=blogger_metrics_capture` 出现的频率再决定。
- **不调大全局阈值，也不用内容层的“还活着”信号去掩盖卡住。**
- 另外 45 例在哪一步停住，发布前用只读 SQL 分类（需要用户点名主机）：

```sql
SELECT a.task_id, a.attempt_number, a.status, a.progress->>'phase' phase,
  a.progress->>'current' cur, a.progress->>'total' tot, a.progress->>'message' msg,
  a.business_progress_at, a.heartbeat_at, a.app_version,
  a.health_evidence->'healthEvidence'->'runtime'->>'captureProgressAgeMs' cp_age,
  t.parent_task_id IS NULL AS root
FROM capture_task_attempts a JOIN capture_tasks t ON t.id = a.task_id
WHERE t.task_type = 'unattended_keyword_capture' AND t.created_at > now() - interval '11 days'
  AND coalesce(t.error->>'originalCode', t.error->>'code') = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
ORDER BY a.task_id, a.attempt_number;
```

`root` 这一列同时回答 S3 的一个问题：47 例里有多少是根任务（根任务不在 S3 范围内，只能靠 S2）。

## S2 恢复时自停（随 0.4.19）

### 流程

替换两个调用 `stopUnattendedCaptureTargetsForRecovery` 的地方：`recoverUnattendedKeywordRunRequest`（约 15278）和 `launchPendingUnattendedRecovery`（约 14916）。

**第 0 步：写下持久的意图，并把锁标成不许刷新。**

- `recoverUnattendedKeywordRunRequest` 在创建 A2 的同一次变更里写入：

  ```js
  request.recoverySelfStop = {
    v: 1,
    fromAttemptId: A1,
    lockIdentity: oldLock ? buildCaptureExecutionLockStopIdentity(oldLock) : null,
    captureRequestIds: [...],   // progress、Debug 会话、围栏证据、R 名下在途中继里的 id
    progressTabId,
    startedAt,
    tries: 0,
  }
  ```

- **锁标记**：这次变更之后、任何停止动作之前，在 `runCaptureExecutionLockOperation` 里重读存储的锁。如果它绑定 R（`captureTaskId==taskKey`，或与 `intent.lockIdentity` 相同），就原样写回，并加上 `allowReload:false` 和 `selfStopRequestId:R`。
  - `normalizeCaptureExecutionLock`（约 13306）今天只保留 id、owner、持有者等字段，会丢掉这两个字段。要改成保留 `allowReload === false` 和 `selfStopRequestId`。续租（约 13625，`...lock`）和绑定都经过它写回，所以标记会一直保留。
  - `stopPreviousUnattendedCaptureForResume` 已经支持 `allowReload:false`（约 8752）：持有页还在就返回 `stop_unconfirmed` 并保留锁，不刷新。
  - 所以无论 S2 中途失败、runner 被关、租约过期，还是之后写了 `needs_action`，经过 `readActiveCaptureExecutionLock` → `removeStaleCaptureExecutionLock` 的路径都不会刷新 R 的来源页。这些路径包括：侧栏打开时的 `onstarvoice:get-capture-lock`、手动批次 `isBusy`、定向单帖领取、云端指令处理、计划闹钟。
  - 这把锁最后由三条路径之一释放：第 5 步按精确身份释放；S3 核对里的 `releaseStopFenceLocalResources`；运营确认后的本机释放。
- **service worker 重启后**：巡检照常读到 `status='recovering' && recoveryPendingLaunch`，进入 `launchPendingUnattendedRecovery`，看到 `recoverySelfStop` 没有 `done`，就再跑一次（锁标记也再做一次）。这一步是幂等的，已经关掉的页会报 `tab_closed`。同一请求的自停尝试单飞：巡检发现上一次尝试还在进行就跳过。
- 读锁一律用 `readStoredCaptureExecutionLock`。`readActiveCaptureExecutionLock` 在租约过期时会走 `removeStaleCaptureExecutionLock` → `stopPreviousUnattendedCaptureForResume`，恢复路径不再走它。
- **终态转换**（安全页阻断、恢复次数用尽）当场自停一次，锁标记照做：
  - 终态写入时带 `runnerRetireAttemptId = 当前轮次`。这一轮的 runner 看到它就像换代一样立即退役（停锁心跳、冲刷上传、写回执，回执原因 `request_terminal`）；runner 自己写的终态不带这个字段，正常收尾不受影响。
  - 自停与自动恢复第一次尝试一样最多等 15 秒回执。R 已终态，它的 runner 不会再有正当工作，所以仍没有回执的（事件循环卡死）在全量扫描证明之后、同一次锁操作里关掉。
  - 成立就按精确身份释放锁和资源；不写围栏。
  - 不成立时请求仍是终态、不写围栏，锁带着标记留着（不刷新，读锁路径也不会释放它）。**监督闹钟每 3 分钟再试一次同样的终态自停**（`maybeRetryTerminalUnattendedSelfStop`，节奏记在 `storage.session`），直到成立或锁转交给新的领取者。带围栏码的 `needs_action` 不走这里，由 S3 与运营放行处理。
  - 评审前的版本在 runner 活着时一定失败，锁带着标记永远留着，定向单帖、云端指令、手动批次一直回 `capture_lock_busy`，而服务端以为节点空闲。

**第 1 步：围住 A1。每次尝试都做，开销很小。**

- (a) 对意图里的 id，以及当前 `listRequestRelays(R, taskKey)` 里的 id，逐个 `markCaptureRequestAborted`。这样 `relayToContentWithRetry` 的暂时错误重试和停滞刷新分支都会直接返回“已中止”，不会把 A1 的采集再发进任何文档。中止标记在内存里，service worker 重启后从意图重新标一遍。
- (b) 中继轮次围栏，放在 `onstarvoice:relay-to-content`（约 22443）：
  - 先用已有的 `buildContentRelayOwner(sender)` 解析 `runnerRequestId`/`runnerAttemptId`。
  - 对采集类动作（payload 带 `captureRequestId`，或是 `isListCaptureAction`），读一次请求槽。只要槽里不是“R、正好这一轮、非终态”，就抛出 `unattended_attempt_superseded`。
  - `ping`、`cancelCapture`、`inspectCaptureActivity` 和其它不带请求 id 的动作照常放行。没有轮次参数的旧版 runner 不围。
  - 每个采集中继多一次 `storage.local` 读取；这不是轮询路径。
- (c) runner **事件驱动退役**，放在侧栏的 `handleUnattendedRunRequestStorageChange`（约 3079）。这个函数现在遇到轮次不同就直接 return。改成：当 `request.id === activeUnattendedRunRequestId`、且轮次不再是本 runner 的轮次时，立即执行下面四步，不依赖流水线的 promise 结束（卡住的正是那个 promise）：
  1. `setCancelFlag(true)`、`stopRejectedUnattendedAttempt('attempt_superseded')`。**不**发不限定请求的全页取消。
  2. 停掉执行锁心跳，清空 `activeCaptureExecutionLockId` 和 `adoptedUnattendedCaptureExecutionLockId`。
     - 为什么：第 5 步释放锁之后，一个还在续锁的旧 runner 会续租失败，进入 `handleCaptureExecutionLockLost`（约 16541）。这时 `activeUnattendedRunRequestId` 可能已在本地清理时清空，它就会调用 `requestCaptureCancelSignal(relayTabId)` 发不限定请求的取消。拿不到中继页时，它会退到“当前窗口的活动页”，那可能是 A2 复用的来源页或用户的页。
  3. 前台最多等待 60 秒，后台继续等待采集流程退出并冲刷全部入队结果：
     - 对当前流水线的流式上传队列调用 `drain`。`streamingSyncQueue` 目前是流水线函数里的局部变量（约 8517），要登记到模块级引用才能从这里取到；
     - 等工作页 B 的预加载和 `navigationQueue` 在取消标志下退出，超时就不再等。
  4. 写**退役回执**：`chrome.storage.session['onstarvoice.unattendedAttemptRetired.v1.<R>.<A1>'] = {at, reason, heartbeatStopped: true, flushed, pendingUploads}`。
  - 卡住的流水线 promise 可以一直挂着：它之后的每一步都会先看到取消标志，采集类中继也会被 (b) 拒绝。
  - A1 的 checkpoint 上报在换代之后本来就会被 `attempt_mismatch` 拒绝并从 outbox 丢弃，与关不关页无关，所以退役不等它。
  - 没有退役回执不能证明上传安全。任何轮次、任何启动路径都保留该运行页和锁，后续自动核对继续等待。网络失败的已采结果每分钟重试；最终回执要求采集生产者已退出、全部上传收到确认。

**第 2 步：收集目标，按请求 id 取消（不刷新），用全量扫描判定。**

新增 `createRecoverySelfStopContext(request, intent, epoch)`，参照 `createStopFenceCheckContext`（约 10518），但 `terminalAttemptIds` 只包含 R 的**非当前**轮次（A1 和更早的轮次），**永远不包含 A2**。收集的目标（用于限定取消和关页判断）：

- 登记表（见第 3 步）里 `requestId=R`、`attemptId≠A2` 的条目；
- 绑定 R 的锁的持有页，按 `captureTaskId==taskKey` 或 `intent.lockIdentity` 判断：
  - 持有页是 R/A1 的 runner（按 URL 判断，BEGIN 之前就是这样）时，按 runner 处理，不再返回 `source_identity_unverifiable`；
- `intent.progressTabId`；
- Debug 会话的来源页和工作页，标签组的工作页，`getTrackedCaptureTaskWorkers`；
- R 名下在途中继的目标页。

对平台目标，用 R 的每个 id 调 `relayCancelToTabs(tabIds, {captureRequestId})`，**不发空 id**。

然后在 45 秒上限内，跑与 `confirmPreviousUnattendedStopForFenceCheck` 第一阶段相同的 `sweepStopFenceBrowser` 和 `judgeStopFenceSweep`：

- 扫描范围是全部平台页和 runner 页，不只是上面的目标清单；逐页规则 `evaluateStopFenceTab` 不变。
- 在自停上下文里，A1 和更早的轮次算终态轮次。R 的 A2 这时还没有页面，任何报 A2 的页都判 `request_changed`。
- 能作为证明的证据与闭环文档完全相同：
  - `tab_closed`、`tab_discarded`、`runner_closed`
  - `content_idle` / `content_absent` / `content_canceled_settled` / `unrelated_live_capture`（只限当前加载的文档）
  - 离开平台或 Chrome 错误页，持续观察满 10 分钟（沿用 `offPlatformSeen`）
- **任何一页不成立，都让这次尝试失败**，原因取 `mergeStopFenceReason`。不在目标清单里、冻结、探测失败、忙碌无法归属、扩展加载之前的旧文档，都算不成立。所以 S2 的本机证明与 S3 的核对是同一信任等级。
- 第 3 步关掉自己建的工作页后再复扫一次（`rescan:true`），以复扫结果为准。

**第 3 步：只关登记过的详情工作页。**

- **登记表** `onstarvoice.ownedCaptureTabs.v1`，放在 `chrome.storage.session`：
  - 条目：`{tabId, requestId, attemptId, role: 'detail_worker', windowId, createdAt}`。只有这一种角色，来源平台页不登记。
  - 生命周期与标签页 id 相同：浏览器会话内 id 不会复用，扩展重载或浏览器重启时一并清空，所以不会出现过期的 id。
  - 写入：`utils/capture/detail-runner.js` 的 `createDedicatedDetailRunnerTab`（约 39）在 `chrome.tabs.create` 成功后，发送新消息 `onstarvoice:record-owned-capture-tab`（失败不影响流程）。后台这样处理：
    - 从 `sender.url` 解析 R 和轮次，不相信消息里自报的值；只接受无人值守 runner 页发来的消息。
    - **用 `tabs.onCreated` 核实**。后台在内存里保留最近 30 秒内创建的标签页：id、窗口、创建时间、创建时的 URL。只有同时满足以下条件才登记：
      - 该 id 在 15 秒内刚被创建；
      - 创建时是 `about:blank`（工作页固定以 `about:blank`、`active:false` 创建，见 `buildDedicatedRunnerTabCreateProperties`）；
      - 窗口与 runner 报的来源页是同一个；
      - 从没被登记过。
    - service worker 在创建和登记之间重启时，核实不了就不登记。这一页之后只按证据判断，不会被关。
    - 手动采集的侧栏页没有 runner 参数，不会登记。
  - `chrome.tabs.onRemoved` 删除条目，`chrome.tabs.onReplaced`（约 21662）迁移 id。
  - 工作页只属于建它的那条流水线：A2 和手动采集都会自己新建工作页，不会接手 R 的工作页。
- **关闭规则**：登记表里 `requestId=R`、`attemptId≠A2` 的 `detail_worker` 一律关闭，A2 会自己新建工作页。runner 页在第 4、5 步处理。来源页、锁持有页、进度页不关也不刷新。
- **关之前逐项复核**：
  - `chrome.tabs.get` 能取到；
  - URL（含 `pendingUrl`）是 `about:blank` 或平台站点（`STOP_FENCE_CONTENT_SCRIPT_HOSTS`）。用户把这一页导航去了别处的，不关，并删除条目；
  - 不是“聚焦窗口里的活动页且 2 分钟内被访问过”，以防用户正在看这一页；
  - 请求槽仍是 R/A2 且为 `recovering`；
  - 该页相关的 id 已中止。
- **证明**：`chrome.tabs.get` 在 5 秒内开始报 “No tab with id”。`chrome.tabs.remove` 的 promise 本身不算证明。关掉的页从登记表中删除。

**第 4 步：判断 A1 的 runner 怎么处理（只判断，不在这里关）。**

- runner 已经不存在：成立。
- runner 还在：必须同时有本轮精确退役回执、`heartbeatStopped:true`、`flushed:true`、`flushing!==true`、`pendingUploads:0`。
- 队列退役时先禁止继续采集，继续上传已经入队的结果；等待采集生产者退出，接住最后一条迟到记录。网络失败每分钟按原任务身份自动重试。失败计数不能当成上传确认。
- 没有回执或结果未结清：保留运行页和锁，S2 有界重试后进入 S3 持续核对；没有“第二次尝试强行关闭”的例外。
- 最终回执成立后才关闭精确 R/A1 运行页；不会关闭新轮次、其他任务或用户页面。

**第 5 步：确认中继清空，然后在一次锁操作里关 runner 并释放锁。**

- `waitForStopFenceRequestRelaysToDrain`（约 11121），5 秒内要降到 0。否则本次尝试以 `relays_not_drained` 失败，runner 和锁都不动。
- 然后执行 `runUnattendedRunnerTabLifecycle(() => runCaptureExecutionLockOperation(commit))`。
  - 生命周期在外、锁操作在内，与现有代码没有反向嵌套。
  - `commit` 里只能用不排队的锁读写。不能再调 `readStoredCaptureExecutionLock`、`releaseExactCaptureExecutionLockSnapshot` 这些排队版本，否则会自锁。
- `commit` 的三步：
  1. 重读存储的锁。不存在，跳到第 3 步。存在但不绑定 R、或与 `intent.lockIdentity` 不符：以 `lock_holder_unknown` 失败，什么都不关。
  2. 检查持有文档（`getCaptureExecutionLockHolderState`）。以下三种可以继续，其它情况以 `lock_holder_alive` 失败，什么都不关：
     - 已消失；
     - 是 A1 runner，且有退役回执；
     - 是第 4 步标记为“待关闭”的 A1 runner。这时先关掉它，5 秒内 `tabs.get` 报不存在才算；关不掉就以 `runner_close_failed` 失败，锁不动。
  3. 按精确身份删除锁。
  - 所有可能失败的证明都在进入 `commit` 之前完成，所以不会出现“runner 已关、锁还绑着 R”的中间状态。即使 `storage.local.remove` 本身出错，锁也带着 `allowReload:false`，不会走刷新清理。
- 然后调用 `releaseUnattendedCaptureTaskResourcesForRecovery`：关闭标签组工作页，断开 Debug 会话。
- 写入 `recoverySelfStop.done = {at, tries, closedTabIds, discardedTabIds, runnerClosed, runnerClosedWithoutReceipt, runnersRetained, retiredRunnersClosed, pendingUploads, targets: 摘要最多 20 条}`，接着走原来的等待和启动 A2。

**第 6 步：有限次重试（期间刷新心跳），最后才写 `needs_action`。**

- 证明不成立时，状态保持 `recovering`，并写入：
  - `tries+1`、`lastReason`、`recoveryWaitUntil = max(原值, now + 60 秒)`；
  - `heartbeatAt=now`、`progressSeq+1`、`updatedAt=now`。**不**刷新 `businessProgressAt`；
  - 进度阶段 `recovery_self_stop`，文案“正在确认旧采集页面已停止（第 n/5 次）”。

  每次尝试开始时也先写一次同样的心跳，所以两次心跳之间不超过“巡检 1 分钟 + 一次尝试最多约 70 秒”。
- **为什么要刷新心跳**：
  - 服务端快照的 `heartbeatAt` 就是请求的 `heartbeatAt`，今天只在恢复转换时写一次。
  - `keyword-node-coverage.js` 的 `stalledExecution` 对 each_agent 覆盖批次里固定节点的子任务，心跳超过 3 分钟（`RESPONSE_MS`）就判 `keyword_node_no_response`，把子任务改成 `superseded`。这时还没有围栏码。
  - 之后 S2 用尽、写 `needs_action` + 围栏码时，镜像的 WHERE（`status NOT IN ('superseded','canceled')`）会跳过这一行。围栏码到不了服务端，节点就被放进准入，而本机的旧页面并没有被证明已停。
  - 今天第一次恢复只等 60 秒；8 分钟的自停窗口会让这种情况变得常见。
- **服务端同时加一道（S2-srv，随服务端先发）**：`stalledExecution` 对 `status='recovering'` 且 `progress.phase='recovery_self_stop'` 的子任务，把响应时限放宽到自停预算加 3 分钟，即 11 分钟。此阶段仅检查响应，不套用 10 分钟业务进展时限；评论阶段覆盖调度等 15 分钟，为节点 12 分钟看门狗、巡检和镜像留出窗口。撤销后迟到的围栏只补写安全错误码，不恢复租约或工作项。F1 只处理 `retryable` 工作项，不看 `recovering` 子任务，不受影响。
- 下一次巡检（1 分钟一次）经 `launchPendingUnattendedRecovery` 再试。
- 上限：`UNATTENDED_RECOVERY_SELF_STOP_MAX_TRIES = 5`，并且从 `startedAt` 起不超过 `UNATTENDED_RECOVERY_SELF_STOP_BUDGET_MS = 8 分钟`。这个窗口要覆盖：
  - 中继 90 秒无活动的判定，加上被中止的停滞刷新；
  - 冻结页被 Chrome 丢弃；
  - 错误页离开平台满 10 分钟的观察。后者 8 分钟内观察不满，最后落到 S3 去等。
- 超出上限：`markUnattendedRecoveryStopUnconfirmed(request, message, evidence, reasonCode)`，写入 `needs_action`，`error.reason = 'self_stop:<原因>'`。锁保留，并带着 `allowReload:false`。此后由 S3 每 3 分钟核对一次。

**`launchPendingUnattendedRecovery` 的第二个停止点**（约 14905–14945）：用于手动恢复和云端接管这类没有意图的请求。在这里用锁和请求临时构造一个意图，同样先给锁打标记，然后只跑一次同样的自停，不重试。失败时保持今天的“本次恢复已暂停”，并补上原因码。

- **人工「继续」换了新请求 id**（`manuallyRecoverUnattendedKeywordRun` 以 `...current` 派生新请求）：新请求**不继承** `recoverySelfStop` 和 `runnerRetireAttemptId`。评审前新请求会接着旧请求已用尽的自停预算，一次失败就写围栏。
- 这时锁还属于旧请求 R_old。启动点从锁的 `captureTaskId`、自停标记 `selfStopRequestId` 和新请求的 `parentRequestId` 取出这些旧请求（去掉 R 自己，最多 3 个；连续两次「继续」时锁的绑定和标记可能分属两个旧请求），一并纳入范围：它们的 runner（带轮次参数）算候选、按它们自己的请求读退役回执，它们名下的中继与 Debug 会话、任务组也算进来。它们已不在请求槽里，runner 永远看不到换代，所以限时等待后仍没有回执的按“待关闭”关掉。评审前这里按新请求 id 找回执，已退役的 A1 runner 永远认不出来，`继续` 一直以 `lock_holder_alive` 失败，直到有人去机器上关掉旧 runner。

### 原因码（`error.reason`）

| 原因码 | 含义 | 之后的去向 |
|---|---|---|
| `self_stop:<闭环原因码>` | 全量扫描不成立，原因码取 `mergeStopFenceReason` 的结果：`capture_still_active`、`tab_busy_unattributed`、`tab_frozen`、`probe_failed`、`off_platform_observing`、`old_document_uninspectable`、`source_identity_unverifiable`、`request_changed`、`check_timeout`、`storage_unreadable` | S3 每 3 分钟核对。页面被 Chrome 丢弃、被关闭、恢复空闲，或离开平台满 10 分钟后，自动放行；`old_document_uninspectable`、`source_identity_unverifiable` 需人工。`tab_frozen` 与挂住的归属页在 0.4.19 已先丢弃再判定，仍出现说明是活动页 |
| `self_stop:close_failed` | 登记过的工作页关闭后仍然存在 | S3 |
| `self_stop:runner_close_failed` | 待关闭的 A1 runner 关不掉 | S3 |
| `self_stop:relays_not_drained` | R 名下的中继 5 秒内没降到 0 | S3 |
| `self_stop:lock_holder_unknown` | 锁不绑定 R 或身份不符，而且持有文档还活着 | S3 → 人工 |
| `self_stop:lock_holder_alive` | 锁的持有文档活着，既没有退役回执，也不是待关闭的 A1 runner | S3 |
| `self_stop:lock_release_failed` | 删除锁失败；锁仍绑定 R，并带 `allowReload:false` | S3 |

登记表缺失（例如 0.4.19 刚装、扩展刚重载）不单独算原因：这时没有“自己建的页”，只按证据判断。

### 冻结或挂住的页：丢弃，不刷新、不关（评审补充）

评审复现：R 自己的来源页被冻结（Edge 睡眠标签页、Chrome 冻结后台页）或渲染进程挂住时，S2 与节点核对都永远证明不了，0.4.18 的刷新原本能解开这种情况；另外，与 R 无关、只是冻结着的平台页（例如傍晚批次留下、已经睡眠的抖音页）会让每次自停都以 `tab_frozen` 失败。

- 全量扫描不成立后（S2 每次尝试、S2' 节点核对各一次），对下面两类页调用 `chrome.tabs.discard`，然后复扫，以复扫结果为准：
  - 当前可归属于 R 的冻结平台页；无归属证据的冻结页不处理；
  - 归属于 R 的平台页（锁持有页、进度页、R 的中继目标、任务组或 Debug 会话的页，以及 R 名下的 `about:blank` 工作页），探测文档或查询内容脚本**超时**（渲染进程挂住）。
- 丢弃销毁旧文档（包括里面卡着的采集），标签页留在标签栏，用户点开时才重新加载。丢弃后报 `tab_discarded`，扩展与服务端都已认它是证明，服务端不用改。
- 永远不丢：活动页（Chrome 本身也拒绝丢弃活动页）、runner 与扩展页、仍能应答的页（包括正在跑采集的页）、未归属且只是探测失败的页、早于本次加载的旧文档。丢之前重读标签页（冻结页要仍是冻结）和请求槽。
- 丢弃过的页记进 `done.discardedTabIds`。
- 剩余：R 的来源页是其窗口的**活动页**且挂住时，仍证明不了（Chrome 不丢弃活动页），只能等页面恢复或人工处理。

### 节点核对里也关登记过的工作页（S2'，S3 的节点侧）

`confirmPreviousUnattendedStopForFenceCheck`（约 11534）：

- 触发条件：第一阶段判定失败，而失败的页**全部**是登记表里 R 名下的 `detail_worker`，证据为 `tab_frozen`、`probe_failed`、`capture_still_active` 或 `tab_busy_unattributed`。
- 处理：用同一个关闭辅助函数关掉这些页，然后复扫。复核里“请求槽”一项改成“R 在本机已是终态”。
- 来源页即使证据不成立也不关。R 进入 `needs_action` 之后，计划闹钟可能已经把 R 的锁当作 `stale_unattended` 释放，并在同一来源页上启动了新的本地运行。
- 效果：这些页变成 `tab_closed`，服务端已经把它当作证明，不需要改服务端。`a656fc8e` 那一页冻结的 `about:blank` 就属于这种情况（前提是它是 0.4.19 建并登记的）。

### S2 不改的地方

- `stopPreviousUnattendedCaptureForResume`、`reloadUnattendedCaptureTabAndConfirm`、`removeStaleCaptureExecutionLock` 仍保留给其它调用者（租约过期清理、runner 刷新接续），恢复路径不再调用它们。R 的锁带着 `allowReload:false`，这些路径不会刷新 R 的来源页。其它流程的锁（手动采集、定向单帖）的刷新行为不变，作为已知风险另开后续处理。
- 0.4.16 核对的全量扫描规则不变，只增加上面 S2' 的“关登记过的工作页”。
- 手动采集、定向单帖、手机流程都不涉及。

## S3 需要处理的批次子任务围栏也自动核对（只改服务端，先发）

### 已核对：0.4.18 的节点核对不看服务端状态

- `normalizeStopFenceCheckOffer`（`background.js` 约 10343）只需要 `version`、`mode`、`checkId`、`taskId`、`requestId`。
- `readStopFenceRequestState`（约 10463）依次从请求槽、归档、台账读 R，`requestActive` 只取决于本机状态。`needs_action` 属于 `UNATTENDED_RUN_TERMINAL_STATUSES`（约 227），所以 `requestActive=false`。
- 自动恢复围栏的本机状态，正是闭环文档已经在证明的“典型围栏”：R 在本机是 `needs_action`，`attemptId=A2`，`previousAttemptId=A1`。`tests/background-stop-confirmation.test.mjs` 约 814 行就是用这个状态做的测试。
- `createStopFenceCheckContext` 把 A1、A2 都当作终态轮次；R 在本机已是终态，所以带任一轮次参数的 R 的 runner 都可以关。
- `releaseStopFenceLocalResources`（约 11235）要求请求槽仍是 R、终态、轮次属于 {A2, A1}，这个条件成立。
- 节点在回执**之前**已经在本机释放了锁、runner 和采集辅助，所以放行时不需要 `localRelease`，也不需要暂停派单。

因此自动恢复围栏在服务端是 `needs_action` 还是 `superseded`，对节点完全一样。09-27 两例之所以从没被核对过，只是因为服务端没有下发，下发了也会拒收回执。**S3 只改服务端，可以先于 0.4.19 上线。**

### 可自动核对的行

```text
status = 'needs_action'
AND parent_task_id IS NOT NULL
AND task_type = 'unattended_keyword_capture'
AND 带围栏码、没有 recoveryTaskId、request id 存在   -- 列表 SQL 已有的条件
```

也就是 `stopFenceOperatorReleasable(row)` 再加上 request id 存在。新增：

- `stopFenceNeedsActionAutoCheckable(row)`，以及对应的 SQL 片段 `STOP_FENCE_NEEDS_ACTION_AUTO_CHECK_SQL(alias)`；
- 开关 `CAPTURE_STOP_FENCE_AUTO_CHECK_NEEDS_ACTION`，默认开，设为 `off` 恢复成只核对 `superseded`；原有的 `CAPTURE_STOP_FENCE_AUTO_CHECK=off` 仍然关掉全部核对。两个开关合成一个函数 `stopFenceNeedsActionAutoCheckEnabled(env)`，写法与 `stopFenceAutoCheckEnabled` 相同。

根任务、`manual_batch`、`resume_requested` 行保持人工处理：根任务还能在节点上「继续」，改成 `superseded` 会丢掉节点之后对这次运行的上报。根任务的自愈靠 S2。

### 服务端改动

`server/services/capture-stop-fence.js`：

| 函数 | 改动 |
|---|---|
| `readStopFenceHeartbeatWork`（约 717） | `fence_pending` 的 `EXISTS` 改为 `status='superseded' OR ($3 AND <可核对的 needs_action 条件>)`。新参数 `includeNeedsActionChildren` **在函数内**默认取 `stopFenceNeedsActionAutoCheckEnabled()`，`$3` 总是绑定。所以三个调用者都不用改，也不会漏传：心跳（路由约 9045）、建任务路由（约 12358，只读 `holdNewWork`）、`hasStopFenceCheckWork`。筛选条件和扫描的行都不变：`needs_action` 本来就在部分索引 `idx_capture_tasks_agent_active_load` 之外 |
| `listCaptureAgentStopFences`（约 591） | 新选项 `includeNeedsActionChildren`：`($3 = false OR status='superseded' OR ($9 AND <条件>))`。只有领取时传入；概览和确认接口的列表保持原样 |
| `claimStopFenceCheckOffers`（约 1346） | 列表传 `includeNeedsActionChildren`；行锁改成 `status IN ('superseded','needs_action')`，SELECT 加上 `parent_task_id, task_type`，在 JS 里再判一次条件。976a0c6 那条隐式查询不动 |
| `completeStopFenceCheckReceipt`（约 1642） | SELECT 加 `parent_task_id, task_type`。可核对的 `needs_action` 行与 `superseded` 行一样，检查 `checkId`、有效期和宽限期，并用 `evaluateStopFenceProof`。证明成立时**不在这里写库**，而是返回 `receipt(200, {...}, {needsActionRelease: {taskId, checkId, evidence: stopFenceEvidenceSubset(result)}})` 交给路由。失败轮次照常走 `recordStopFenceCheckResult`，3 分钟后重试，3 轮或 30 分钟后上报人工 |
| `rotateStopFenceChecks`（约 1824） | 包含可核对的 `needs_action` 行 |
| `summarizeAgentStopFence`（约 835） | 节点有能力且两个开关都开时，令 `autoCheckRows = superseded ∪ 可核对的 needs_action 行`，阶段判定里原来用 `superseded` 的地方都改用它，`auto_checkable`/`check` 同样处理。于是这些节点的阶段变成 `awaiting_node`、`node_checking`、`node_retrying`、`needs_operator`、`offline`、`heartbeat_degraded`，不再是 `task_action_required`（后者 30 分钟后在 ops-control 里是高告警）。`operator_confirmable_task_ids` 不变，运营任何时候都还能手动确认。旧节点的 `autoCheckRows` 只含 `superseded`，阶段不变 |
| `stopFenceReasonLabel` | 新增 `command_in_flight`：“该任务正在执行后台指令，稍后复核” |

`server/services/capture-stop-fence-release.js`：

- `releaseNeedsActionStopFences` 增加参数，默认值就是现在的运营值：`proofStatus`、`reason`、`checkId`、`evidence`、`message`、`actorType`。
  - 节点证明时传：`proofStatus:'agent_confirmed'`、`reason:'agent_confirmed_needs_action_released'`、`message:'节点已确认旧采集页面已停止，本执行结束'`、`requestLocalRelease:false`。
- `recordNeedsActionStopFenceOutcome` 增加 `proofStatus`/`reason`。节点证明时，事件文案用 `RECONCILED_EVENT_MESSAGES.agent_confirmed()`，`actor_type='capture_agent'`。
- **保留** `terminalReason='stop_fence_operator_released'` 和工作项错误码 `PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED`：有三处按原值精确匹配（`capture-orchestrations.js` 的 `stopFenceReleasedRetrySource` 约 143、待派重试扫描 SQL 约 1777、`capture-cloud.js` 的接管守卫约 4166）。两种来源靠 `historicalStopFenceReconciliation.proofStatus` 区分。改名要连同这三处读者和测试一起改，本次不做。
- 仍然跳过有在途指令（`command_in_flight`）的行。回执路径遇到跳过时，记为一次可重试的失败，不放行。

`server/services/capture-cloud.js`：

- `normalizeCloudTaskSnapshot`（约 793）：在删除 `historyClearedAt` 的地方同时删除 `metadata.stopFenceCheck`，包括第一次插入在内，设备都不能写入或伪造核对轮次。F3 在同一处删除 `operatorClose`，两边合并时放在一起。

`server/routes/capture-cloud.js`：

- 把确认接口里交回工作项的循环（约 11882–11915：`lockOrchestrationParent` → `projectOrchestrationChildControlOutcome` → `readNeedsActionReleaseItemOutcome` → `recordNeedsActionStopFenceOutcome`）抽成 `handBackReleasedNeedsActionChildren(tx, {tenantId, agentId, released, proofStatus, actorType, actorId, actorName, itemMessage})`，确认接口和回执共用。
- 回执路由（约 9312）改成在同一个事务里：先 `completeStopFenceCheckReceipt`；如果结果带 `needsActionRelease`，就调用 `releaseNeedsActionStopFences(agent_confirmed…)` 和上面的辅助函数，工作项说明为“旧采集页面未能安全停止，节点已确认停止后交回批次”。
  - 加锁顺序：节点会话 → 子任务 → 父任务 → 工作项，与心跳投影和确认接口一致。
  - 响应体去掉内部字段，写 `released:true`，节点收到后会立即补一次心跳。
- **「让节点重新核对」路由** `/agents/:id/stop-fence/recheck`（约 11703–11735）：
  - 现在它只从 `superseded` 行里取 `checkable`，没有 `superseded` 行时返回 `agent_stop_fence_task_action_required`。而 Admin 的 `recheckState`（`stop-fence-presentation.mjs` 约 383）在 `awaiting_node`、`node_retrying`、`needs_operator` 阶段都给出可重新核对。所以只被 needs_action 子任务挡住的节点（09-27 两例都是）点这个按钮会一直得到 409。
  - 改成：`autoRows = rows.filter(row => row.kind === 'fence' && (row.status === 'superseded' || (stopFenceNeedsActionAutoCheckEnabled() && stopFenceNeedsActionAutoCheckable(row))))`。`autoRows` 为空时才返回原来的 409，`checkable` 从 `autoRows` 里取。
- `mirrorTaskSnapshot`（约 6565）：从节点快照的 metadata 里删掉 `stopFenceCheck`（约 6576）；在合并处（约 6683–6695）把 `stopFenceCheck` 加进保留键，和 `historyClearedAt` 的做法相同。否则节点送来一份更新的台账快照，就会抹掉进行中的核对轮次，导致回执变成 stale。

放行后的结果与运营放行的格式逐字段相同，只有来源不同：

- 行变为 `superseded`；`error.code='HISTORICAL_STOP_FENCE_RECONCILED'`，`originalCode` 保留；
- `historicalStopFenceReconciliation` 里 `proofStatus='agent_confirmed'`，带 `checkId` 和 `evidence`，`releasedFromStatus='needs_action'`，并有 `itemOutcome`；
- 工作项：弹性批次回到任务池（`retryable`，用完预算则 `failed`），固定分配变 `needs_action`（等「重试失败关键词」），批次已停止则不动；
- 没有 `localRelease`，也不暂停派单：节点在回执前已经释放了本机资源。

Admin 可以不改：`canConfirm` 已包含可放行数；新阶段的文案是通用的；「让节点重新核对」在补上路由和 `rotateStopFenceChecks` 之后可用。可选的小改：让 `pendingTabsFrom` 也取可核对的 `needs_action` 任务，面板上就能看到节点报告的待定页面。

### 成本

- **心跳预检**：已有的 `EXISTS` 多一个 OR 分支，扫描的行不变，约 20 ms。
- **领取**：围栏 SQL 约 275 ms，每个有围栏的有能力节点每次心跳一次（约每分钟一次）。这和今天 `superseded` 围栏的单节点开销相同。能核对的节点变多了，但围栏从“挡 7–8 小时”缩短到“1–4 分钟内解除”，总开销反而下降。
- **测量**：`captureTaskUnconfirmedLocalStopSql` 本身不改。发布前在测试库里用 `EXPLAIN` 核对预检计划没有变化。

### 单独上 S3 能解决什么

节点上已经可以证明的围栏：本机没有锁、没有 runner，平台页空闲或已关闭。09-27 两例到 12:01 时就是这种状态。

解决不了的：R 自己建的页冻结、挂住或没有回应（例如 `a656fc8e`），以及扩展加载之前的旧文档。这些要等 0.4.19 的 S2' 或人工。能核对就不断核对，每 3 分钟一轮；3 轮失败或满 30 分钟后阶段转为 `needs_operator`，之后仍继续核对，所以页面后来被丢弃或被关闭时依然会自动放行。

## S4 死行自动结算（服务端，建在 F3 之上）

### 09-27 的需处理：24 个 `needs_action` 根任务

| 类 | 数量 | 来源 | 为什么是死行 | 规则（自动；运营随时可用 F3 手动结束） |
|---|---|---|---|---|
| K1 手机发现作品补详情 `detail_finished_without_ingestion` | 11 | `capture-discovery/detail-projection.js` 约 19–21，在镜像 → `projectNegativePatrolSnapshot` → `projectDiscoveryTaskResult` 时产生 | 候选已经是 `failed`，运营能在手机运行的候选列表里「重新处理」（会建**新**任务）；这一行不再有任何动作 | 清扫。`error.reportedStatus='failed'` 且没有人工或安全标记的，10 分钟后；报 `completed`/`completed_with_warnings` 但没有回执的，24 小时后；其它报告状态（如 `needs_action`）不自动处理 |
| K1b `detail_create_expired` | 0 | `detail-lifecycle.js` 约 59–76 | 同上 | 清扫：指令过期 30 分钟后 |
| K2 手动批次 `MANUAL_BATCH_PAGE_CLOSED` 等（`task_type='capture'`，`executionMode='manual_batch'`） | 2（火星、金星「提前」，09-24） | 扩展 `utils/manual-keyword-dispatch.js` 约 72、138 | 控制器按设计不会重放，没有任何操作适用，台账也不会再变化 | 清扫：1 小时后 |
| K3 手机独立运行（`android_runner`，`workflow='douyin_mobile_discovery'`） | 8（DE106，09-24 17:42） | `android-control/tasks.js` 约 6–30，由 rollup 汇总成 `needs_action` | 过了 `deadlineAt` 后「继续」会被拒（`RUN_DEADLINE_EXPIRED`）。没开始的词停在 `pending`/`retryable`，但根已是 `needs_action`，手机不会再领（F3 的“独立手机运行例外”） | 清扫：`deadlineAt < now − 30 分钟`；按 F3 结算，`needs_action` 的词为 `failed`，没开始的词为 `canceled` |
| K4 手机弹性批次用尽次数 | 2 个父任务（`21ec646b`、`031b4669`，共 17 个工作项） | `android-control/completion.js` 约 39–41：`attempt_count ≥ 3` 时写 `needs_action` | 领取只接受 `pending`/`retryable` 且次数 < 3 的项；定时下一轮会忽略 `needs_action` 项；父任务因此一直不结束 | **产生时**：用尽次数的编排子项改为 `failed`（与浏览器弹性用尽一致），登录或挑战类原因除外；清扫：存量弹性父任务 6 小时后，非弹性 24 小时后 |
| 小红书 03:30 批次 `408d1410` | 1 | 活着：5 个 `retryable`，2 个是围栏项 | 不是死行 | F3 判定为 `live_item`/`stop_fence`，S4 不碰；归 S3/F1/F2 |

这些行都不挡节点：`needs_action`/`failed` 不占执行槽，围栏 SQL 只认围栏码。S4 只是整理需处理，让这些行真正成为终态、可以清理。按今天的数据，如果 F3 判定都可结束、也没有人工必需标记，需处理会从 24 行降到 1 行（那个活着的批次）。上线前用 F3 的判定对生产只读核对一次。

K1–K3 都不触发通知：`capture-attention-notifier.js` 只通知安全类错误码。所以清扫的宽限期只影响它们在需处理里停留多久（K1 最多约 15 分钟）。

### 复用 F3 的判定与结算（S4 不另写一套）

- **判定**：F3 的 `loadOperatorCloseEligibility(tx, tenantId, rootIds)`。它是一条递归 SQL，不跑约 275 ms 的围栏 SQL，围栏用它的 `stop_fence` 廉价超集。它已经包含：
  - `interrupted`、`stop_fence`、`stop_pending`；
  - `live_child`、`live_command`、`device_held`；
  - `live_item`，含独立手机运行例外；
  - `negative_patrol_needs_action`、`active_discovery_demand`。
- **结算**：F3 的 `closeOperatorAttentionRoot(tx, {tenantId, rootId, actor: {type: 'system', name: '系统自动结算'}, mode: 'automatic', refreshOrchestrationParent})`。
  - 写的仍是 `metadata.operatorClose`（`mode:'automatic'`、`closedBy:'系统自动结算'`），所以 F3 的全部保护自动覆盖自动结算的行：
    - 镜像 status CASE 的“保持”分支，以及 `attention_dismissed_at` 的重新打开规则。K2 被节点同一次执行的 `needs_action` 快照翻回的问题由此解决：同一次执行重复报需处理或失败时保持 `failed`；带围栏码时回到 `needs_action` 并重新出现在需处理；
    - 设备快照剥掉 `operatorClose`、合并时保留；
    - `detail-projection.js` 对已结束的任务直接返回；
    - 本地恢复接管、后台「继续」的防护；
    - 事件 `task_operator_closed`（`actor_type='system'`，payload 里 `mode:'automatic'`，另加 `kind`），以及 `audit_logs`。
  - 不再有单独的 `metadata.attentionSettlement` 标记。
- **不改 `detail-receipt.js`**：结束之后迟到的入库回执，按现有规则被 `DISCOVERY_RECEIPT_NOT_CURRENT` 拒绝，与运营手动结束完全一样（F3 的集成测试不用改）。要补采就在手机批次里「重新处理」。K1 报 `completed` 的行给 24 小时宽限，就是为了让晚到的上传先落地。
- **S4 只加自动触发的条件**（手动结束不受这些限制）：
  - 每类的宽限期（见上表），也就是“最近还在动的行不碰”；
  - **人工必需标记**，只挡自动结算：
    - 根或树里的 `error.requiresManualAction`/`securityBlocked`；
    - `itemRequiresManualSafetyAction`（`capture-orchestrations.js` 约 171–186）；
    - 手机原因 `login_required`、`login_or_challenge_required`、`challenge_or_unknown`，来自 `item.metadata.reason` 或 `attempt.result.reason`；
  - K3 的 `deadlineAt` 条件。

### 清扫

- 入口 `reconcileDeadAttentionRoots({limit: 50})` 放在 `server/routes/capture-cloud.js`，与 `reconcileAutomaticCaptureRetries` 同处，同样由 `server/cron.js` 引用。由它把 `refreshOrchestrationParentTask` 注入 F3 的结算，因为服务层不能 import 路由（`scripts/check-android-discovery-boundaries.mjs`）。
- `server/services/capture-dead-attention.js` 只放候选 SQL、分类、宽限期和人工标记判断。
- `server/cron.js` 单独加一项 `dead-attention-settlement`，频率 `*/5 * * * *`。开关 `CAPTURE_DEAD_ATTENTION_SWEEP=off`。

每一轮：

1. **候选**：每个活跃租户一条查询，走 `idx_capture_tasks_tenant_status_updated`。廉价谓词全放在 SQL 里，根上带围栏码、带人工标记、不属于 K1–K4 的行在这里就排除，不会反复被读：

   ```sql
   SELECT t.id, t.task_type, t.updated_at, t.metadata, t.error
   FROM capture_tasks t
   WHERE t.tenant_id = $1 AND t.status = 'needs_action'
     AND t.parent_task_id IS NULL AND t.attention_dismissed_at IS NULL
     AND UPPER(COALESCE(t.error->>'code', '')) <> 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
     AND COALESCE(t.error->>'requiresManualAction', '') <> 'true'
     AND COALESCE(t.error->>'securityBlocked', '') <> 'true'
     AND t.updated_at < now() - interval '10 minutes'        -- 最短宽限期
     AND (
       (t.metadata->>'workflow' = 'discovered_post_capture'
         AND t.error->>'code' IN ('detail_finished_without_ingestion', 'detail_create_expired'))
       OR (t.task_type = 'capture' AND t.metadata->>'executionMode' = 'manual_batch')
       OR t.metadata->>'workflow' = 'douyin_mobile_discovery'
       OR (t.task_type = 'capture_orchestration' AND <手机编排：与 claimElasticItem 相同的判定>)
     )
     AND (t.updated_at, t.id) > ($2::timestamptz, $3::uuid)  -- 游标
   ORDER BY t.updated_at, t.id
   LIMIT $4
   ```

2. **游标**：按 `(updated_at, id)` 分页，每个租户在进程内记住上次看到的位置；这一页不满 `limit` 时，游标回到开头。所以永久不可结算的行（活着的批次、带人工标记的树、还没过宽限期的 K1）每轮最多被看一次，不会占住窗口让后面的行永远轮不到。进程重启后从头开始。
3. **判定**：对这一页调用一次 `loadOperatorCloseEligibility`（一条 SQL），再在 JS 里判每类宽限期、人工标记和 K3 的截止时间。
4. **结算**：每个可结算的根单独开一个短事务，`lock_timeout` 500 ms，冲突就跳过。`closeOperatorAttentionRoot` 加锁后会重新判定。
5. **成本**：每个租户一条按索引的候选查询，加一条 F3 判定查询（F3 估计几毫秒），不跑围栏 SQL。什么都不结算时，每 5 分钟就只有这两条查询。
6. 宽限期都用具名常量，每次结算都按 `kind` 打日志，以便后续调整。

### 产生时修正（只有 K4）

- **K4**：`completion.js` 约 40 行，编排子项用尽次数时写 `failed`。以下情况仍写 `needs_action`：原因是登录或挑战类；或者 `!body.deviceIdle`（设备被占用）。需要同步修改 `android-unified-scheduling.integration.mjs` 约 257–270 的断言。
  - 非弹性的手机编排在 24 小时内仍可能被 `reconcileAutomaticCaptureRetries` 跨设备接走，所以清扫对它们要等 `updated_at` 超过 24 小时后才处理。
- **K1 不在产生时处理**。心跳路径上多写一个字段看似便宜，但要同时照顾迟到回执、镜像保护和 F3 的结束语义，还会误伤报 `needs_action`（人要处理登录墙、平台验证）的行。统一走清扫，语义与手动结束一致。
- **K4 父任务要不要也移出需处理，交给用户决定。** 默认不移出，与浏览器 `completed_with_failures` 一致，而且已经有一键「清理已结束失败项」。
- **重试时清掉忽略标记**：批次「重试失败关键词」重新打开父任务时，要一并清掉 `attention_dismissed_at`。任务的「继续」和跨设备重试已经这样做了（约 13267、15522），编排的重试路由（约 6232–6260）还没有。否则被结束过的父任务重试后又失败，就不会再出现在需处理里。F3 也需要这一条，谁先落地谁做，另一边复用。

## 与 F1–F3 的衔接（交给集成者）

- **F1（弹性重试轮超时后放宽）**：
  - S2 会让子任务在 `recovering` 里最多多停 8 分钟。F1 只处理 `retryable` 工作项，不受影响。服务端覆盖调度由 S2-srv 放宽（`recovery_self_stop` 阶段 11 分钟），自停阶段不因业务进展年龄撤销；其他阶段仍有原有进度检查。
  - F1 如果把一个带围栏的子任务接力出去（把它转成 `superseded`），**不要**清掉它的围栏码和 `stopFenceCheck`：进行中的核对轮次会走现有的 `superseded` 路径收敛。
- **F2（K=3 次同一时间筛选失败即判失败）**：按每次尝试的失败计数，不要只看 `item.error`。S3 放行会把 `item.error` 覆盖成 `PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED`，这不算时间筛选失败。
- **F3（手动「结束并移到历史」）**：
  - S4 直接调用 F3 的 `loadOperatorCloseEligibility` 和 `closeOperatorAttentionRoot`，不另写判定和结算。F3 需要支持：
    - `mode:'automatic'`，以及没有用户 id 的系统操作者；
    - 事件和 `audit_logs` 写 `actor_type='system'`，`operatorClose.mode='automatic'`；
    - payload 允许带 `kind`。

    其它不变。**编码前先告诉 F3 的实现者。**
  - **入库回执两边一致**：不改 `detail-receipt.js`。任何结束（手动或自动）之后的迟到回执都被 `DISCOVERY_RECEIPT_NOT_CURRENT` 拒绝，F3 的测试不改。
  - **提交顺序**：S4 的提交必须建在 F3 的提交之上。集成时先把 F3 分支合入，再实现 S4；本分支在 F3 落地前不实现 S4。
  - 编排重试时清掉 `attention_dismissed_at`：两边都需要，只做一次。
  - 带围栏的 `needs_action` 行：F3 返回 `stop_fence`，S4 不处理；出口只有 S3 核对或运营「确认旧页面已停止」。
- **S4 与 S3**：包含围栏行的任务树，S4 只能在 S3 之后处理，不能替代 S3。
- **可能冲突的文件**：
  - `server/routes/capture-cloud.js`：两边都会改，包括镜像保留键、`mirrorTaskSnapshot` 剥离、cron 入口；
  - `server/services/capture-cloud.js`：`normalizeCloudTaskSnapshot` 的剥离；F3 删 `operatorClose`，S3 删 `stopFenceCheck`；
  - `server/routes/capture-orchestrations.js`（F3）；
  - `server/cron.js`、`server/services/capture-stop-fence.js`、`server/services/keyword-node-coverage.js`。

## 发布拆分

### 服务端发布内容（本次与 0.4.19 同包准备，节点随后原地更新）

- `server/services/capture-stop-fence.js`
- `server/services/capture-stop-fence-release.js`
- `server/services/capture-cloud.js`：快照剥离 `stopFenceCheck`
- `server/services/keyword-node-coverage.js`：S2-srv
- `server/routes/capture-cloud.js`：回执、recheck 路由、`rotate`、镜像保留键、抽出的辅助函数、S4 清扫入口
- 新增 `server/services/capture-dead-attention.js`
- `server/services/android-control/completion.js`
- `server/cron.js`
- 可选：`server/routes/capture-orchestrations.js`（重试时清掉忽略标记）
- S4 依赖 F3 的 `server/services/capture-operator-close.js`，与 F3 同一发布
- Admin 不是必须的

上线后，0.4.18 节点上已有的和新产生的批次子任务 `needs_action` 围栏，会在下一次完整心跳时收到核对。

### 随 Extension 0.4.19

- `background.js`：S1-1/2/4、S2、S2'、锁标记（`normalizeCaptureExecutionLock` 保留 `allowReload`/`selfStopRequestId`）、中继轮次围栏、登记表和 `tabs.onCreated` 核实
- `sidebar/sidebar-logic.js`：S1-1 快照；轮次变化后事件驱动退役（停锁心跳、冲刷、写回执），`streamingSyncQueue` 模块级引用
- `utils/capture-sync.js`：S1-1、S1-3
- `utils/capture/detail-runner.js`：登记工作页
- `utils/task-center.js`：S1-1 字段

版本号、更新清单、中文更新日志、运行基线与测试统一为 0.4.19，使用 `scripts/package-extension.zsh` 打包；生产发布另经用户同意。

## 测试

### 扩展单测（`node --test`，用假的 `chrome.tabs`/`chrome.storage.session`；沿用 `tests/background-capture-lock.test.mjs` 的 harness，包括 `createdTabs`、`setReloadHook`、`setTabMessageHandler`）

新文件 `tests/background-recovery-self-stop.test.mjs`：

1. 登记过的工作页冻结：限定取消没有回应 → 关闭 → `tabs.get` 失败 → 复扫成立 → 按精确身份释放锁 → 60 秒后启动 A2。全程 `chrome.tabs.reload` 调用 0 次。
2. **用户的页和来源页永远不被关**：
   - 来源页（不论启动时 `created` 为真还是假）限定取消后仍报 R 的活动 → 不关、不刷新；5 次或 8 分钟后写 `needs_action`，`error.reason='self_stop:capture_still_active'`；A2 没有启动（`createdTabs` 为空）。
   - 不在目标清单里的冻结平台页 → 本次尝试失败（`self_stop:tab_frozen`），不关。
   - 登记表里的页被用户导航到非平台 URL → 不关，条目被删除。
   - 登记表里的页是聚焦窗口的活动页、2 分钟内被访问过 → 不关。
   - 核实不了的登记被拒绝：id 不是 15 秒内刚建的、创建时不是 `about:blank`、窗口不同、service worker 重启丢了创建记录、非 runner 页发来。
3. BEGIN 之前锁持有者是 R/A1 的 runner：按 runner 处理，不再是 `source_identity_unverifiable`；runner 写了退役回执时不关 runner，自停成立。
4. runner 卡住无回执：任何次数都不关、不删锁。只有收到采集结束、上传结清的精确回执才释放。A2 和其他请求的运行页不动。
5. **service worker 重启**：换代之后、自停之前清空内存（中继登记、中止标记、标签组、`tabs.onCreated` 记录），`storage.session` 登记表和请求槽里的意图保留 → 巡检重新自停 → 从意图重新打中止标记、重新打锁标记 → 成立后只启动一个 A2（绝不会有两个 runner）。
6. **事件驱动退役**：A1 runner 活着，流水线 promise 永不结束，流式上传队列非空 → 轮次变化后在 60 秒上限内 `drain`，停掉锁心跳，写回执（`flushed:true`）→ S2 不关 runner，释放锁 → 之后这个 runner 没有 `renew-capture-lock`，也没有 `requestCaptureCancelSignal` 调用（`handleCaptureExecutionLockLost` 不触发）。`drain` 超时时回执为 `flushed:false` 并带 `pendingUploads`。
7. **中继轮次围栏**：A1 runner 发 `captureComments`/列表采集被拒（`unattended_attempt_superseded`）；`ping`/`cancelCapture`/`inspectCaptureActivity` 放行；A2 runner 放行；没有轮次参数的旧版 runner 放行。
8. **中止标记**：自停之后，`relayToContentWithRetry` 的暂时错误和停滞刷新分支都返回“已中止”，同一个采集请求不会发进新文档。
9. `tabs.onReplaced` 迁移登记表条目；`tabs.onRemoved` 删除条目。
10. 终态转换（安全页、次数用尽）：写 `runnerRetireAttemptId`；runner 退役时按回执释放锁并随后关掉它；runner 卡死时限时等待后关掉；证明不了时锁带标记留着、不刷新，监督闹钟每 3 分钟补试，成立后释放；带围栏码的 `needs_action` 不补试。不写围栏，状态保持不变。
11. `launchPendingUnattendedRecovery` 第二个停止点（手动恢复）：只尝试一次，失败时文案不变，并带原因码。人工「继续」后新请求不继承自停意图；旧请求已退役的 runner 按它自己的回执认出、锁释放后关掉；旧请求未退役的 runner 保留并等待证据；其它请求的 runner 不动。
12. 可归属于 R 的冻结页与 R 挂住的后台页被丢弃后按 `tab_discarded` 成立；活动页、未归属的挂住页不丢弃；S2' 同样。
13. 已退役 runner：最终回执已到的在删锁后关掉；还在冲刷的在最终回执到达时关掉；锁持有者或当前轮次的 runner 不关。
12. **锁标记与刷新路径**：
    - S2 用尽后（runner 已被关、锁仍绑定 R 并带 `allowReload:false`），依次触发侧栏打开（`onstarvoice:get-capture-lock`）、手动批次 `isBusy`、计划闹钟 → `chrome.tabs.reload` 调用 0 次。
    - 续租之后 `allowReload` 仍为 `false`。
    - 在 `commit` 进行中注入 `get-capture-lock`：它被排到 `commit` 之后，看不到“runner 已关、锁还在”的状态。
13. **心跳**：每次尝试开始和结束都写 `heartbeatAt`，`progressSeq` 加 1，`businessProgressAt` 不变，`progress.phase='recovery_self_stop'`。
14. 修改已有测试 `automatic recovery never launches a replacement when the old capture cannot be stopped`（`background-capture-lock.test.mjs` 约 11087）：第一次失败时保持 `recovering`，用尽之后才写 `needs_action` 并带原因；“不启动替代”的断言保留。
15. `background-stop-confirmation.test.mjs`：
    - S2'：R 已终态，登记的 `detail_worker` 为 `tab_frozen` → 关闭 → `tab_closed` → 通过；不在登记表里的冻结页仍为 `tab_frozen`；证据不成立的来源页不关。
    - `the automatic-recovery fence records which pages failed…`（约 2225）的证据字段改成新的原因码。

S1 相关：

- `detail_item_prefetch_ready` 在前台处于 `comments_capture` 时，`captureAction='captureComments'`，current/total 不再是 0/0，7 分钟无进展不触发、13 分钟触发；前台不在评论阶段时，`captureAction` 为空，6 分钟触发。
- `captureAction`/`activeStage` 经三个归一化函数后仍保留。
- `executeScriptWithTimeout` 超时返回 `null`，循环按截止时间退出。
- `updateListCaptureTraceBindings` 10 秒超时，不发取消、不刷新、不重注入。

回归：`tests/background-capture-lock.test.mjs`、`background-stop-confirmation`、`unattended-keyword-run`、`capture-recovery-intents`、`cloud-task-center-wiring`、`update-manifest` 全部通过。约 1155、1197 行的刷新语义测试属于 `stopPreviousUnattendedCaptureForResume`，对没有标记的锁保持不变。

### 服务端单测

`tests/capture-stop-fence.test.mjs`：

- 判定函数与 SQL 片段；
- `summarizeAgentStopFence`：有能力的节点加上可核对的 `needs_action` 行 → 进入自动核对阶段；旧节点 → 阶段不变；开关关闭 → 阶段不变；根任务 `needs_action` → 仍为 `task_action_required`；
- `readStopFenceHeartbeatWork` 不传新参数时按开关取默认值，`$3` 总是绑定。

`tests/keyword-node-coverage.test.mjs`：`recovering` + `recovery_self_stop` 的子任务，心跳 10 分钟前 → 不判卡住，12 分钟前 → `keyword_node_no_response`；`recovering` 但阶段不是自停 → 仍按 3 分钟。

`tests/server-capture-cloud-contract.test.mjs`：保留“围栏 SQL 文本逐字不变”的断言；更新写死只核对 `superseded` 的 SQL 断言；`normalizeCloudTaskSnapshot` 删除 `stopFenceCheck`；recheck 路由用 `stopFenceNeedsActionAutoCheckable`。

### PostgreSQL 集成（Node 18，`--test-concurrency=1`，库 `onstarvoice_test_selfheal_*`）

`stop-fence-closure.integration.mjs` 新增子测试：

1. 有能力节点上 `needs_action` 的弹性批次子任务在下一次心跳收到核对；证明回执 → `superseded`/`HISTORICAL_STOP_FENCE_RECONCILED`、`proofStatus='agent_confirmed'`、`releasedFromStatus='needs_action'`、没有 `localRelease`；工作项变为 `retryable` 并带放行码；事件 `actor_type='capture_agent'`；下一次心跳该节点能接到新任务。
2. 固定分配子任务 → 工作项 `needs_action`，可以「重试失败关键词」；批次已停止 → 只解除围栏。
3. **没有证明就不放行**：`capture_still_active` 连续 3 轮 → `needs_operator`，行仍是 `needs_action` + 围栏码；之后一次证明回执仍能放行。
4. 有在途 `stop` 指令时，证明回执不放行，记为一次可重试的失败。
5. 运营确认与节点回执竞态：两种先后顺序都幂等，工作项只交回一次。
6. 镜像送来更新的快照后 `stopFenceCheck` 保留，回执不会变成 stale；节点第一次插入的快照里伪造的 `stopFenceCheck` 被剥掉。
7. **旧节点不受影响**：没有能力的节点不下发，阶段不变。开关 `CAPTURE_STOP_FENCE_AUTO_CHECK_NEEDS_ACTION=off` 时恢复只核对 `superseded`。
8. 节点自己的心跳不会把已放行的围栏带回来。**只有 needs_action 围栏的节点**，`POST /agents/:id/stop-fence/recheck` → 200，行上的 `checkId` 轮换；开关关闭时仍是原来的 409。
9. 保留 `non-superseded fences are never offered…`（约 569，根任务）不变。needs_action 文档里断言有能力节点批次子任务阶段为 `task_action_required` 的子测试，改成新的阶段。
10. **S2-srv**：each_agent 覆盖批次，固定节点的子任务处于 `recovering` + `recovery_self_stop`，心跳 5 分钟前 → `reconcileKeywordNodeCoverage` 不撤销；之后节点送来 `needs_action` + 围栏码 → 镜像接受，节点被准入挡住。

新文件 `dead-attention-settlement.integration.mjs`（建在 F3 合入之后，夹具复用 F3 的 `operator-close.integration.mjs`）：

1. **K1** 报 `failed`：10 分钟内不动，之后被清扫。任务 `failed`，`operatorClose.mode='automatic'`，已移到历史。之后：
   - 迟到入库回执 → `DISCOVERY_RECEIPT_NOT_CURRENT`，所有行不变（与 F3 相同）；
   - 同一次执行的 `failed` 快照 → 仍是 `failed`、仍在历史。

   报 `completed` 无回执 → 24 小时内不动；报 `needs_action`、或带 `requiresManualAction` → 不自动处理，F3 手动可结束。
2. **K2** 满 1 小时 → 被清扫；之后节点同一次执行的 `needs_action` 快照 → 仍是 `failed`、仍在历史；带围栏码的快照 → 回到 `needs_action`，重新出现在需处理。
3. **K3**（带没开始的词，`pending`/`retryable`）过期满 30 分钟、没有占用 → 被清扫：运行 `failed`，`needs_action` 的词 `failed`，没开始的词 `canceled`，revision 加 1。有 `deviceHeld` → 不处理（`device_held`）；有 active 需求 → 不处理（`active_discovery_demand`）；未过期 → 不处理。
4. **K4** 用尽次数 → `failed`，父任务变为 `completed_with_failures`；登录或挑战原因、`!deviceIdle` → 仍为 `needs_action`；非弹性父任务 24 小时内不处理。
5. **带围栏的行（根任务、子任务、工作项）永远不被结算**；有安全标记的行不自动处理。
6. 结算后 `/history/clear` 接受这些行；重试父任务会清掉 `attention_dismissed_at`。
7. **游标**：先放 60 个永久不可结算的根（活着的批次、带人工标记的树），再放 1 个可结算的根 → 两轮清扫之内被结算。整轮清扫不调用 `captureTaskUnconfirmedLocalStopSql`（包一层 tx，统计含其特征片段的查询次数为 0）。
8. 锁冲突就跳过；关掉开关后什么都不做。

同步修改：`android-unified-scheduling.integration.mjs`（K4）。

### 完整回归

`node scripts/run-node-regression-tests.mjs` 和 `node scripts/run-postgres-integration-tests.mjs`，Node 18.20.8 与 24.12.0 都跑。与生产基线 `31b51d1` 的失败用例名逐项对比。先生成独立工作区的 `extension-build/` 并链接 TypeScript 依赖；实际基线 Node 18 为 2,851/2,851、PostgreSQL 为 413/413，没有环境失败豁免。

## 上线顺序与验证

1. **发服务端**（S3 + S2-srv + S4，与 F1–F3 同一发布）。生产前置条件：`fe74ec5`。部署需要用户点名主机。
   - 上线后 5 分钟内：K1（报 `failed`）、K2、K3、K4 的存量行被清扫（宽限期都已过），前提是 F3 判定为可结束、没有人工必需标记。
   - 有 `needs_action` 围栏的有能力节点，在下一次心跳收到核对。
   - 验证 SQL（只读）：

     ```sql
     -- 自动放行
     SELECT id, updated_at, metadata->'historicalStopFenceReconciliation'->>'proofStatus' proof,
       metadata->'historicalStopFenceReconciliation'->>'releasedFromStatus' src
     FROM capture_tasks WHERE error->>'code' = 'HISTORICAL_STOP_FENCE_RECONCILED'
       AND updated_at > now() - interval '1 day' ORDER BY updated_at DESC;

     -- 仍被挡住的
     SELECT id, status, metadata->'stopFenceCheck'->'lastResult'->>'reason' last_reason
     FROM capture_tasks WHERE error->>'code' = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
       AND status IN ('needs_action','superseded');

     -- S4 自动结算
     SELECT payload->>'kind' kind, count(*) FROM capture_task_events
     WHERE event_type = 'task_operator_closed' AND payload->>'mode' = 'automatic'
       AND created_at > now() - interval '1 day' GROUP BY 1;
     ```

   - 当晚观察 19–22 点和 03:30 两个时段：新围栏在几分钟内自动放行，或者上报 `needs_operator` 并附上待定页面。
2. **发 Extension 0.4.19**，由发布步骤完成：更新版本号、同步 `extension-build/`、打包；节点需要重载扩展。
   - **必须重启浏览器（发布门槛，逐台核对）**：只重载扩展时，运行标识的来源是 `extension_load`，重载之前加载的所有平台页都判 `old_document_uninspectable`（包括用户自己的第二个小红书/抖音页、只做过单页导航的来源页）。S2 的全量扫描会因此每次都失败，8 分钟后写 `needs_action / self_stop:old_document_uninspectable`，S3 的核对也证明不了，必须人工。重启浏览器后运行标识是 `browser_startup`，所有文档都算本次加载。17 台节点装完 0.4.19 后逐台重启浏览器；**之后每一次靠重载扩展安装的发布也一样**。核对方法：节点围栏证据里的 `runtimeEpochOrigin`；发布后按 `error.reason` 统计，`self_stop:old_document_uninspectable` 应为 0。
   - 后续可选（服务端，本次不做）：节点上报运行标识来源，后台对 `extension_load` 且有早于它的平台页的节点给出提醒。
   - 验证：新出现的 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 行都带 `error.reason='self_stop:*'`，数量应明显下降。进度里能看到 `recovery_self_stop` 阶段和 `activeStage`。按 `error.reason` 分布决定下一步。

## 回滚

- **服务端**：
  - 先用开关：`CAPTURE_STOP_FENCE_AUTO_CHECK_NEEDS_ACTION=off` 恢复只核对 `superseded`；`CAPTURE_DEAD_ATTENTION_SWEEP=off` 停止清扫。改环境变量需要重启 pm2。
  - 再按备份恢复文件。不涉及迁移。
  - 已自动放行的行格式与运营放行相同，所有读者都认，不需要回退。
  - 被 S4 结束的行与 F3 手动结束的行格式相同（`failed`/`completed_with_failures`，带 `operatorClose.mode='automatic'`，已移到历史），回滚后按 F3 文档的回滚说明处理。确实要恢复显示时，对 `operatorClose.mode='automatic'` 的行清空 `attention_dismissed_at`。
- **扩展**：重新发布 0.4.18，用发布步骤留下的 `extension-build.rollback-v0418-*` 备份。数据兼容：
  - 0.4.18 会忽略 `recoverySelfStop`：回滚那一刻正在自停的请求会走 0.4.18 的启动路径，也就是今天的停止方式；
  - 0.4.18 的 `normalizeCaptureExecutionLock` 会丢掉 `allowReload`/`selfStopRequestId`，带标记的锁回到今天的行为；
  - `error.reason` 无害；
  - `storage.session` 里的登记表和退役回执在扩展重载时自动清空。

## 已知风险与本次不做

- **S2 信任的是本机证明。** 如果证明有误，旧页面还在跑时 A2 就会启动。缓解措施：
  - 页面证明与闭环核对用同一套全量扫描规则，任何一页不成立都不放行；
  - 另外要求：R 的中继清空；R 的 id 已中止，并且中继入口有轮次围栏；A1 runner 已退役（心跳已停）或已关闭；登记过的工作页已关闭。
- **来源页冻结或挂住时**：来源页一律不关不刷新。0.4.19 只对可归属于 R 的冻结或挂住后台页做丢弃（见上），之后按 `tab_discarded` 成立。仍解不开的是：来源页是活动页且挂住（Chrome 不丢弃活动页）、早于本次加载的旧文档（发布门槛：重启浏览器）。上线后按 `error.reason` 统计 `self_stop:tab_frozen`、`self_stop:probe_failed`、`self_stop:old_document_uninspectable`，再决定要不要做更多。
- **丢弃范围**：仅可证明属于 R 的后台平台页，且已冻结或探测超时。未归属的冻结页和活动页均不丢弃。
- **无退役回执或未同步结果**：不关闭运行页，不释放锁；自动核对继续。浏览器自身崩溃或用户主动关页的持久上传补偿不在本次实现范围。
- **计划闹钟**：自停锁与没有精确释放证据的围栏都判阻塞；即使本机锁记录缺失，也不允许新任务覆盖该请求。
- **登记表覆盖不到的页**：0.4.19 刚装、扩展重载之前建的工作页，`tabs.onCreated` 核实不了的，或者 runner 登记消息丢失的。这些页只能靠证据判断，冻结就停在 S3。页面被 Chrome 丢弃（`tab_discarded`）或被用户关掉后，S3 会自动放行。
- **关掉正在采评论的工作页，会丢掉这一条已采的部分评论。** A2 会从 checkpoint 重新采这一条；已保存的记录不受影响。
- **恢复时限**：S2 开始每次尝试前检查 8 分钟预算，过期进入 S3。服务端自停阶段仅使用 11 分钟响应时限；超时撤销后，迟到围栏仍被保留，不能静默丢掉停止保护。
- **只上 S3、节点还是 0.4.18 时**，R 自己建的页如果冻结或挂住，仍要等 0.4.19 或人工处理。
- **`removeStaleCaptureExecutionLock` 仍会刷新锁持有页**（`stopPreviousUnattendedCaptureForResume`），但只对没有 `allowReload:false` 标记的锁，即手动采集、定向单帖等其它流程的锁。这是租约过期清理的既有行为，另开后续处理。
- **名称有误导**：`terminalReason='stop_fence_operator_released'` 和 `PREVIOUS_CAPTURE_STOP_OPERATOR_RELEASED` 也会用在节点证明的放行上。展示这些码的地方应改看 `proofStatus`。
- **固定分配的批次子任务被自动放行后**，关键词仍是 `needs_action`，要人点「重试失败关键词」。节点已经放开了，但关键词还要人。夜间的生产批次都是 `elastic_pool`，不受影响。
- **S4 宽限期**（10 分钟、24 小时、30 分钟、1 小时、过期后 30 分钟、6 小时、24 小时）是经验值，没有迟到回执的生产延迟数据。它们都是具名常量，每次结算按 `kind` 打日志。K1 自动结束之后的迟到回执会被拒绝（与 F3 手动结束相同），要补就「重新处理」。
- **需要用户决定**：K4 手机弹性父任务结算后，是否也移出需处理。默认不移出，与浏览器 `completed_with_failures` 一致。
- **本次不做**：
  - S1 的中继预算累计；
  - 心跳中断的根因（先收集 S1-4 的诊断数据）；
  - 节点诊断上传；
  - K1 按技术失败自动换一台浏览器重新补一次（可以用 `item_type='discovered_post'` 的工作项计数，不需要迁移）；
  - 把放行码改名。

## 建议的提交拆分

1. `docs: design unattended self-heal (S1–S4)`：本文。
2. `server: auto-check needs_action batch-child stop fences on capable nodes`：S3，包括判定、列表、领取、回执、recheck 路由、`rotate`、概览，放行函数参数化，路由辅助函数，快照剥离和镜像保留键，以及测试。
3. `server: keep self-stopping recovery children alive in keyword coverage`：S2-srv 及测试。
4. `server: auto-close dead attention roots through the operator-close path`：S4，建在 F3 的提交之上。包括候选与游标、每类宽限期和人工标记、cron 入口、K4 产生时修正、重试时清掉忽略标记，以及测试。
5. `extension: keep the comment-stage stall limit and bound best-effort waits`：S1-1 到 S1-3，以及测试。
6. `extension: fence superseded unattended attempts and record owned detail workers`：中继轮次围栏、侧栏事件驱动退役、登记表与 `tabs.onCreated` 核实、锁标记，以及测试。
7. `extension: self-stop the previous attempt on automatic recovery instead of reloading`：S2、S2'、原因码、心跳刷新，以及测试。

版本号更新（0.4.19）在发布步骤里另外提交。提交信息结尾统一写 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
