# 停止保护闭环：请原节点核对旧采集页面，确认后自动放行（0.4.16 设计与实现）

分支：`codex/hotfix-stop-fence-closure-20260925`（工作区 `OnStarvoice-hotfix-stop-fence-closure-20260925`）。基线：`f069fd7`，即生产 `68c32ba`（服务端、Admin、Extension 0.4.15、手机 Runner 0.2.2）加一条文档提交。

本文最初是设计稿（第 2 版，已按设计评审修订）。代码已按本文实现，并经过三轮对抗评审和一次集成（2026-09-25）。实现与设计不同的地方，以下一节「实现结果与集成验收」为准；正文各节只在关键处改成最终行为，其余保留设计原文。改动范围是服务端、Admin 和 Extension 0.4.16，不新增数据库迁移。文中行号以 `f069fd7` 为准，均为“约”值。

## 实现结果与集成验收（2026-09-25）

### 跨端契约（已逐项核对，三端一致）

| 项目 | 取值 |
|---|---|
| 能力 | `previousCaptureStopCheckV1: true`（`utils/cloud-task-agent.js` 心跳 `agent.capabilities`；服务端只看本次心跳上报的能力） |
| 心跳响应字段 | `stopFenceChecks: [{version:1, mode:'check'\|'release_only', checkId, taskId, requestId, attemptId, platform, fencedAt, expiresAt}]`，只对本次心跳声明了能力的节点出现（旧版本连字段都看不到） |
| 回执 | `POST /api/capture-cloud/agent/stop-fence-checks/:checkId/complete`，请求体 `{taskId, requestId, result}`；`result.version === 1`，`mode` 与下发一致；`release_only` 回执同样带 `version:1` 和三个标识 |
| 单页证据 / 角色 / 平台 | 与「协议」一节的表一致；runner 页用 `role:'runner'`、`evidence:'runner_closed'`、`platform:'extension'`；浏览器错误页不新增证据码，复用 `off_platform_observing` / `navigated_off_platform`，只在标题前加「浏览器错误页·」 |
| 放行记录 | 先例格式：`error.code = 'HISTORICAL_STOP_FENCE_RECONCILED'`、`originalCode`、原文案保留；`metadata.historicalStopFenceReconciliation = {at, reason, proofStatus, requestedBy, originalError, agentId, checkId, requestId, evidence, note, actorId}`；状态保持 `superseded`；事件 `historical_stop_fence_reconciled`，payload `{proofStatus, reason, originalError, checkId}`；`proofStatus` 取 `agent_confirmed` / `operator_confirmed` / `completed` |
| 后台接口 | `POST /api/capture-cloud/agents/:id/stop-fence/recheck`、`POST /api/capture-cloud/agents/:id/stop-fence/confirm`（`{confirmation:'确认旧页面已停止', expectedTaskIds, note?}`）；概览 `GET /overview` 的 `agents[].stop_fence` |
| 中文文案 | 原因码文案三端同表（服务端 `REASON_LABELS`、扩展 `STOP_FENCE_REASON_MESSAGES`、Admin `REASON_LABELS`）；阶段文案服务端与 Admin 同表 |

### 与设计不同的最终行为

服务端（`server/services/capture-stop-fence.js`、`server/routes/capture-cloud.js`）：

- **人工确认后暂不派新采集，直到节点释放本机执行锁（新增）。** 对 0.4.16 节点人工确认后，下一次完整心跳先下发 `release_only`；在节点回执释放之前，心跳不领取发现帖、弹性工作项，也不下发 `create`/`resume` 指令（`unattended_plan`、`source_open` 除外）。否则新任务会撞上绑定旧任务的本机锁，走 0.4.15 带刷新的旧锁清理或以 `CAPTURE_LOCK_CONFLICT` 收尾。
  - 已下发过的：从首次下发（`localRelease.firstOfferedAt`，与下发同一事务写入）起最多 10 分钟；回执失败按 3 分钟重发，窗口内继续暂停。
  - 从未下发过的：确认后节点的第一次完整心跳一律暂停（本次心跳就会下发它，所以带 `release_only` 的心跳永远不带新任务，无论节点离开多久）；此后最多到确认后 1 小时（`STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS`）。判断“第一次”用本次心跳写库前的上一次完整心跳时间，留 1 分钟时钟余量。
  - 预检只读两行：从未下发的里 `requestedAt` 最晚的一行、已下发的里 `firstOfferedAt` 最晚的一行。暂停判定随这两个时间单调，所以只要有一行在暂停，这两行里必有一行在暂停（集成修复：原实现读“从未下发优先的前 20 行”，节点有 23 行以上时会漏掉 10 分钟窗口内的已下发行，第二次心跳就把 `create` 和 `release_only` 一起发出）。
  - 应急开关关闭（`CAPTURE_STOP_FENCE_AUTO_CHECK=off`）时既不下发也不暂停；人工确认也不再生成 `localRelease`。
- **暂停期间如实告知（集成修复）。** `/overview` 的 `stop_fence` 新增 `local_release_holds_new_work`（与心跳同一判定，“上一次完整心跳”取库里当前值）；Admin 在这时不再写「不影响派发」，改为「节点释放本机执行锁后开始接单」，节点列表显示「已人工确认 · 等待节点释放本机执行锁」，任务分配选择器提示“分配后会排队，释放后执行”。确认接口对 0.4.16 节点的文案改为“已确认旧采集页面已停止（N 个任务已记录人工确认）；节点会在下次心跳时释放本机执行锁，释放后恢复接单”；暂停期间手动下发返回“任务已创建：节点正在按人工确认释放旧任务的本机执行锁，释放后自动领取”（排队规则本身不变，`queueBlockerReason` 仍为空）。
- **离站观察轮次不计失败（集成修复）。** 扩展对离开平台或停在浏览器错误页的页面要连续观察满 10 分钟才证明，此前每轮回 `off_platform_observing`（可重试、不需人工）。这类回执不再累加 `failureCount`，否则第 3 轮（约 6–8 分钟）就会升级为「需要到现场处理」并发 high 告警，几分钟后节点又自己放行。首轮下发满 30 分钟的升级规则照常兜底。`stop_fence_check_failed` 事件改为“同一升级周期内原因变化才写”（周期以 `firstIssuedAt` 划分，重新核对后重新计）。
- `summarizeAgentStopFence` 返回 `superseded_task_ids`（该节点全部已转交围栏 id，不受 20 条列表限制）；确认接口要求 `expectedTaskIds` 覆盖当前全部已转交围栏。
- 列表每个节点最多 200 行、租户最多 5000 行；同一节点内围栏行在前，本机释放行里从未下发的在前（心跳每次只取 6 行，重试中的旧行挤不掉新行）。
- 只给能按 `requestId` 定位本机记录的行生成 `localRelease`；没有 `checkId` 的异常待释放行在下发事务里标为 `expired`，预检不会永久为真。
- 重新核对在节点离线或心跳降级时签发的轮次，从真正下发时才开始计时和计升级周期，不会被记成 `check_timeout`。
- 回执：重复送达幂等、超过 96 KiB 返回 413、`57014/55P03/40P01` 返回 503 让扩展重发；`stop_fence_handoff` 事件的 `agent_id` 为空（避免外键锁等原节点心跳），原节点写在 `payload.sourceAgentId`。
- 重新核对在该节点全部已转交围栏都无法定位本机记录时返回 409 `agent_stop_fence_manual_only`。
- 执行槽判定的 `reason` 先判 `active_task`，再判围栏。

Extension 0.4.16（`background.js`、`content-v2.js`、`utils/cloud-task-agent.js`）：

- **心跳顺序改为：`release_only` 先于本轮指令执行**（最多等 15 秒，含等待正在进行的核对），核对项仍在指令之后后台执行。
- **浏览器错误页（决策表新增 8a）。** 自动恢复刷新落在 Chrome 网络错误页时，页面仍是平台 URL，`executeScript` 一律报 “Frame with ID 0 is showing error page”。探测识别这一错误（或 `chrome-error://`）后按“离开站点”处理：同一个 10 分钟连续观察窗口，先 `off_platform_observing`，满 10 分钟为 `navigated_off_platform`；归属页和未归属页一样。错误页本身不刷新、不关闭、不查询内容脚本。离站观察窗口改为在探测之后才清除（错误页保留窗口）。
- `release_only` 回执送达但未释放时不算终结，同一 `checkId` 在 60 秒后再次下发时重跑。
- 离站观察按 `${tabId}:${requestId}` 记，两个围栏请求共用一个页面时互不重置。
- 旧任务在本机已终态时，阶段二关闭它所有轮次（带轮次 id）的 runner 页，规则仍同 0.4.15 本地收口（checkpoint 未上报不关）。
- 测试文件名为 `tests/background-stop-confirmation.test.mjs`。

Admin：

- 确认按钮要求拿全已转交围栏 id（`confirmTaskIds.length >= superseded_count`），拿不全时置灰并说明原因。
- 确认对话框提交打开那一刻的快照 id；轮询出现快照外的新围栏或已不能确认时提示并禁用「确认放行」，围栏解除时对话框保留并说明。
- **对话框展示节点最新的核对结果（集成修复）。** 待处理页面和“节点最新状态”取最新一次轮询，不被快照盖住；打开后节点报告了新的待处理页面时标红提示；勾选后又出现新的待处理页面时，勾选自动失效，需看过后重新勾选。
- 未实现可选项：`OrchestrationResultReport` / `TaskCard` 对 `HISTORICAL_STOP_FENCE_RECONCILED` 的专门文案。

### 验收数据

环境：Node 18.20.8（生产版本）与 Node 24.12.0（`.nvmrc`）；服务端依赖经 scratch 只读解析垫片加载（共享 pnpm 仓缺包），`@resvg/resvg-js` 用桩；Admin 测试需要的 `typescript` 用 eas-cli 自带的 6.0.3（`NODE_PATH`）；PostgreSQL 17 一次性实例。基线为 `git archive f069fd7`，同样的命令、同样的垫片。

| 检查 | 本分支 | 基线 f069fd7 | 结论 |
|---|---|---|---|
| `node --check`（23 个改动的 .js/.mjs，Node 24 与 18） | 23/23 | – | 通过；`background.js`、`utils/cloud-task-agent.js` 按经典脚本（`vm.Script`）解析通过 |
| 完整回归 `scripts/run-node-regression-tests.mjs`，Node 24，不加垫片 | 1896 项，1806 过，90 失败 | 1813 项，1726 过，87 失败 | 本分支多出的 3 个失败是新增测试文件在无垫片时找不到 `pg` 包，与基线其余 86 个同类，均为环境问题 |
| 同上，加垫片 | 2708 项，2684 过，24 失败 | 2612 项，2589 过，23 失败 | 多出的 1 个是 `admin-stop-fence-panel` 缺 `typescript`，与基线其它 Admin 测试同类 |
| 同上，加垫片 + TypeScript | 2738 项，2720 过，18 失败 | 2639 项，2621 过，18 失败 | 失败名单逐项相同（resvg 桩下的 PNG、子进程缺 `dotenv` 的进程角色、缺 `extension-build/` 等） |
| Node 18：引用改动文件的 129 个测试文件 + `background-capture-lock` + `tests/capture/*` | 1886 项，1872 过，14 失败 | 124 个文件，1787 项，1773 过，14 失败 | 失败名单逐项相同 |
| PostgreSQL 集成全套（Node 18） | 319 项，302 过，17 失败 | 297 项，280 过，17 失败 | 失败名单逐项相同（子进程缺 `dotenv`/`pg`、CJS 缺 `exceljs`） |
| `stop-fence-closure.integration.mjs` | 21/21（20 个子测试） | – | 含集成新增的“23 行以上时暂停仍覆盖已下发行”“离站观察不升级” |
| `historical-stop-fence` / `manual-keyword-dispatch` / `keyword-account-coverage` / `ops-control` 集成 | 全过 | – | 不变量 10 的既有断言原样保留 |
| 服务端单测 `capture-stop-fence` / `server-capture-cloud-contract` / `ops-control` / `keyword-node-coverage` / `update-manifest` | 11/11、114/114、29/29、7/7、2/2 | – | |
| Admin 单测 `admin-stop-fence-presentation` / `-panel` / `-confirm-contract` / `cloud-task-center-wiring` | 24/24、4/4、2/2、21/21 | – | 确认契约测试随 `superseded_task_ids` 转绿 |
| 扩展 `background-capture-lock` + `background-stop-confirmation` + `tests/capture/*` + `cloud-task-agent`（Node 18，同步 `extension-build/` 后） | 1089/1089 | – | |
| Admin `tsc -b` + `vite build` | 通过 | – | 在 scratch 副本里用同一 `package-lock.json` 的 node_modules 跑（工作区的 `web/admin/node_modules` 指向空目录） |
| `scripts/check-admin-lint-baseline.mjs` | 281 个错误（上限 288） | 281 | 无新增 lint 问题；改动的 5 个 Admin 文件单独 eslint 为 0 |
| 反向验证（集成修复） | 10/10 被测试抓到 | – | 预检退回“前 20 行”、只读从未下发、离站计失败、事件去重退回、摘要去掉暂停字段、确认/下发文案退回、Admin 文案退回、对话框用快照证据、勾选不失效；改完逐字节还原。各领域此前各自做过反向验证（服务端、扩展、Admin），集成没有重跑 |
| 评审复现 | 23 行、30 行场景第二次心跳 `commands=[]`；离站/错误页场景不再出现 `needs_operator` | – | |

### 安装包

- `bash scripts/sync-extension-build.zsh production`：只写工作区内的 `extension-build/`（102 个文件），`bash scripts/check-extension-snapshot.zsh` 通过。
- `scripts/package-extension.zsh` 输出：`StarVoice-extension-v0.4.16-20260925.zip`（工作区根目录，已被 `.gitignore` 忽略），1,343,786 字节，SHA-256 `11034af13e592fc69af213b0ea3a4efff24d19b3a40e3ee2845d009e57f3eca4`。
- 包内 `manifest.json`（0.4.16）、`background.js`、`content-v2.js`、`content-loader.js`、`utils/cloud-task-agent.js` 与源码逐字节一致；`utils/runtime-config.js` 为生产地址。
- 打包日期与 `update-manifest.js`、`about.html` 的 2026-09-25 一致；若改日重新打包，这三处和 `tests/update-manifest.test.mjs` 的日期要一起改，并重新记录 SHA-256。

## 第 2 版修订要点

评审确认的问题及处理（细节见各节）：

| 问题 | 处理 |
|---|---|
| `unrelated_live_capture` 在 C 或 R 的其它请求仍在页面上时也能成立 | 内容脚本回报活动 id 列表；SW 新增在途中继登记表。只有页面上**没有**任何属于 R 的 id、且**每个** id 都能追溯到存活执行锁持有文档发起的中继时才成立；混合或无法追溯一律 `tab_busy_unattributed` |
| 同一加载期分支信任早于本次加载的文档；非同一加载期分支不探测就放行；运行期关系未知被当作“不同” | 取消“同一/非同一加载期”分支。所有平台页一律先过**文档年龄门槛**：早于本次加载的文档永远不作证明（`old_document_uninspectable`，需人工）；晚于本次加载的文档一律用内容脚本探测。`fenceAt` 不再参与判定 |
| 第 0 步只中止 C；其它在途中继会刷新、重注入、重发；超时被当作“无接收方” | 中止 R 名下全部在途中继（按登记表），并等它们归零后才判定；超时、`status==='loading'` 一律 `probe_failed` |
| 关 runner 与现有规则不一致，且早于证明 | 只关 R 已终态轮次的 runner，沿用 0.4.15 本地收口的判定、队列和 checkpoint 未上报不关的规则；两阶段：先扫其它页全部成立，才关 runner 并复扫 |
| 资源释放借用生命周期内的恢复助手 | 改用 0.4.15 迟到 END 的残留回收（`releaseResidualUnattendedCaptureAssist`，延后于存活请求、保留前台页），放进 `runCaptureTaskLifecycleOperation` |
| `boundToR` 会匹配到别的请求的锁 | 只认 `captureTaskId === 稳定 taskId` 或与围栏时记录的锁身份完全相等；不用持有页回退；持有文档存活或请求槽有非终态请求时不释放 |
| 可重试的失败永不升级，后台一直显示“稍后自动重试” | 连续 3 轮未通过或首轮下发满 30 分钟即升级为「需人工处理」，列出待处理页面；页面并行探测，截止时回报已查和未决页面 |
| 值守总览仍显示 0、没人被通知 | 新增值守事件 `capture_agent_stop_fence_blocked`（满 30 分钟 warning，需人工时 high，走现有告警），总览新增「待确认停止」计数；不需要迁移 |
| 后台看不出自动核对被关闭或心跳降级 | 新增 `auto_check_disabled`、`heartbeat_degraded` 两个阶段，由服务端统一计算 `phase` |
| 需人工的结果仍按指数退避；现场处理后要等很久 | 取消指数退避，所有未通过统一 3 分钟后重发 |
| 人工确认后节点本机仍留着绑定 R 的执行锁 | 对 0.4.16 节点，人工确认后再下发一条“仅释放”项，节点按精确身份释放本机锁和采集辅助，不需要证明 |
| 心跳预检会一直命中永远不下发的行 | 预检排除 `recoveryTaskId` 行；`976a0c6` 已隐式放行的行在下发事务里按先例格式补写记录，此后不再命中 |
| `fenceAt` 为空时放行过宽；`requestId` 为空的行也下发 | `fenceAt` 不再参与判定；`requestId` 为空的行不下发，按需人工处理 |
| 回执 409/404 以外的失败没有记录 | 除 429 外的 4xx 一律丢弃本次结果；服务端在绑定有效时把不合法结果记成 `invalid_result` 再返回 400 |
| 覆盖修复先于节点能自检上线，被挡节点会变多 | 覆盖修复单独在 0.4.16 普及之后发布 |

同时删去：指数退避、`document_replaced`、`sameRuntimeAsFence` 分支、`localFenceAt`。

## 背景

### 现象

2026-09-24 至 09-25，生产上有 5 个浏览器节点一直领不到任务：北京（09-24 20:42 起）、仙人掌、太空人、木星、地球（09-23 21:03 起）。最后是直接写数据库放行的。

北京的时间线（任务 `2ffe3308`）：

- 19:33 领取，开始运行。
- 20:16 业务停滞，自动恢复（第 2 轮）。
- 20:41 再次停滞。
- 20:41:54 扩展以 `needs_action` 收尾，`error.code = PREVIOUS_CAPTURE_STOP_UNCONFIRMED`，文案为“旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续”。
- 6 秒后弹性池把关键词交给别的节点，原任务变为 `superseded`。
- 此后该节点再也没有领到任务。

### 为什么会一直卡住

- **只有扩展会写这个码。** 写入点有三个：
  - runner 刷新接续（`claimUnattendedKeywordRun`，`background.js` 约 11917–11960）。
  - 待恢复任务启动（`launchPendingUnattendedRecovery`，约 12743–12762）。
  - 自动恢复（`recoverUnattendedKeywordRunRequest`，约 13093–13111，北京走的是这条）。

  三处都只存了文案，没有存哪个页面、用什么方法、为什么没停下。三处也都保留了本机执行锁。
- **服务端从心跳镜像这个码。** 围栏判定是 `captureTaskUnconfirmedLocalStopSql`（`server/services/capture-cloud.js` 约 1019–1081）：只要任务带这个码、状态不是取消或完成类、且没有 `recoveryTaskId`，该节点就被判为占用。
  - 用到它的地方：执行槽判定 `findCaptureAgentExecutionSlotBlocker`（约 1083）、弹性领取的公平判定（routes 约 7137）、心跳里的创建指令下发（约 9024–9036）、手动下发排队（约 11733–11745）。
  - 自动解除只有 `976a0c6` 一条规则：同节点、同平台、后来又真正启动并结束了一次采集。节点被挡住以后，这件事不可能发生。
- **弹性接力之后，没有任何路径通知原节点。**
  - `dispatchNextElasticWorkItem` 把原任务置为 `superseded`（约 7978–8010）。错误码保留，但原任务上不写任何事件。
  - 之后心跳镜像不再更新 `superseded` 行（约 6766）。
  - 后台「停止」「继续」都拒绝 `superseded` 任务（约 16521、15839）。这是对的：关键词已经归后继任务。
  - 停止指令不向 `superseded` 任务下发（约 9056–9065），整批停止也跳过它（`capture-orchestrations.js` 约 108–119）。
  - 父任务只按工作项汇总，所以父任务可以显示已完成，而原节点仍被挡住。
- **后台看起来一切正常。**
  - 节点列表显示「在线 · 执行中 0 · 排队 0」，概览查询里没有任何围栏字段（约 10441–10509）。
  - 挡住它的那条子任务在「执行中」「需处理」「历史」里都看不到，在批次详情里以绿色「已转入恢复任务」显示。
  - 手动下发时提示「请先继续或处理该节点的旧任务」，但这件事无法完成。
  - 值守总览的「恢复阻塞」写死为 0（`ops-control.js` 约 1314–1316）。
- **节点本机也没人再管。** 心跳里的 `retryCurrentTerminalUnattendedLocalClosure` 需要该轮次的 checkpoint flush 标记，被挡住的这一轮没有 runner，所以永远返回 `checkpoint_flush_not_ready`。
- **还有一条无证据放行。** 按节点覆盖（each_agent）时，`keyword-node-coverage.js` 约 104–111 把出错子任务改成 `superseded`，同时改写 `error.code`，围栏随之消失，没有任何停止证据。

### 已有的手工放行格式（先例）

2026-09-24 07:14 处理了 49 行，2026-09-25 处理了 5 行，都用同一种写法：

- `capture_tasks.error = error || {code:'HISTORICAL_STOP_FENCE_RECONCILED', originalCode:'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'}`，原文案保留。
- `metadata.historicalStopFenceReconciliation = {at, reason, proofStatus('completed'|'operator_confirmed'), requestedBy, originalError, …}`。
- `status` 保持 `superseded`。
- 另写一条 `capture_task_events`：`event_type='historical_stop_fence_reconciled'`、`actor_type='system'`、`status='superseded'`，payload 为 `{proofStatus, reason, originalError}`。

错误码变了，围栏 SQL 就不再命中。服务端、Web 和测试里没有代码读 `HISTORICAL_STOP_FENCE_RECONCILED`（已 grep）。本设计沿用这一格式，只新增 `proofStatus: 'agent_confirmed'`。

## 目标与不变量

用户要求逐条对应：

1. 「关键词转给了别的节点、整个任务都结束了，难道不跟这个节点说一声吗？」
   - 系统主动请原节点核对并停止旧页面。节点确认后自动放行。
   - 节点做不到时，把原因和待处理页面显示在后台，并通过值守告警通知到人。
   - 任何节点都不能在没人知道的情况下一直被挡住。
2. 后台提供「确认旧页面已停止」按钮，作为人工兜底：运营看过浏览器以后使用。
3. 「不要改完这个又出现其它问题」：
   - 围栏防的是同一浏览器配置里跑出两条采集管线，这层保护不削弱。
   - 0.4.14/0.4.15 节点不理解新协议，必须兼容。

不变量（实现和评审都按这份清单核对）：

1. 围栏判定不变。`captureTaskUnconfirmedLocalStopSql`、`captureTaskHasUnconfirmedLocalStop` 的文本不改，`976a0c6` 规则不改，`excludeTaskIds` 仍然绕不过围栏。创建、领取的准入只有一处变化：已放行的行不再命中。
2. 放行只有三条路：节点回执满足下文的证明条件（`agent_confirmed`）、运营显式确认（`operator_confirmed`）、`976a0c6` 原规则（本次只为它补写记录，`proofStatus: 'completed'`）。不按时间自动放行。
3. 只放行 `status = 'superseded'` 的围栏行。`needs_action`、`failed`、`interrupted` 等仍由节点负责，服务端不改它们，只在后台说明原因并指路（见「管理端」）。
4. 核对请求不写 `capture_agent_commands`。执行槽判定、接力 relay gate、指令过期清扫和停止触发器都不受影响。
5. 下发、回执和放行写 `metadata` 时都不更新 `updated_at`，因为 `976a0c6` 规则比较的是后续采集时间和 `historical_stop.updated_at`。
6. 节点核对中：
   - 不刷新、不导航、不丢弃任何标签页，不向任何页面注入内容脚本。
   - 不碰正在运行的任务：请求槽里的非终态请求、持有文档存活的执行锁。
   - 只对“页面上的全部活动都属于 R”的页面发带非空 `captureRequestId` 的精确停止。
   - 只关闭 R 已终态轮次的 runner 页，判定、队列、checkpoint 未上报不关，都与 0.4.15 本地收口相同。
   - 平台工作页只经由 0.4.15 的残留回收流程关闭（延后于存活请求、保留前台页）。
   - 早于本次扩展加载的平台页文档，永远不作为自动放行的证据。
7. 0.4.14/0.4.15 节点收不到任何新内容。
8. 不新增迁移。
9. 后台不因围栏禁用「分配任务」。服务端现有“排在围栏后面”的行为不变，只把原因说清楚。
10. 现有测试全部保持通过。其中 `tests/integration/postgres/historical-stop-fence.integration.mjs` 与 `manual-keyword-dispatch.integration.mjs` 里的围栏断言、`tests/ops-control.test.mjs` 对 `sourceClosureBlockedCount = 0` 的断言原样保留。
11. 被挡住的节点，最迟 30 分钟后在后台和值守总览里可见，并写明需要谁做什么；自动核对连续 3 轮未通过、或首轮下发满 30 分钟仍未放行，即升级为「需人工处理」。

## 方案总览

1. **交接时留痕。** 弹性接力把带围栏的原任务置为 `superseded` 时，在原任务上写事件 `stop_fence_handoff`：“关键词已转交其它节点；本节点旧采集页面尚未确认停止，暂不向本节点派发新任务”。
2. **心跳下发核对请求。** 原节点下一次完整心跳时，如果它声明了 `previousCaptureStopCheckV1`，且名下有 `superseded` 并仍命中围栏的任务，服务端就在响应里带上 `stopFenceChecks`。规则如下：
   - 每个任务同一时刻只有一个有效 `checkId`，10 分钟过期。
   - 核对没通过或过期未答，3 分钟后换新的 `checkId` 再发，直到解决。
   - 连续 3 轮未通过或首轮下发满 30 分钟，升级为需人工处理；后台和值守告警随之提示，重发照常继续。
3. **节点核对。** 节点检查所有相关页面，按下文决策表逐页给出证据。它最多做三件事：对只跑着 R 的页面发精确停止；其它页面全部成立后，关闭 R 已终态轮次的 runner 并复扫；全部证明后，按精确身份释放本机执行锁和采集辅助。然后发回执。
4. **回执处理。**
   - 通过：在同一个事务里写先例格式的放行记录（`proofStatus: 'agent_confirmed'`），写事件，唤醒等待节点的恢复意图。节点下一次心跳就能领任务。
   - 不通过：记录原因和待处理页面，围栏保留，3 分钟后重发，后台显示原因。
5. **旧节点。** 0.4.14/0.4.15 不下发。后台明确写“该版本不支持自动核对，请到这台电脑检查后点「确认旧页面已停止」”，值守告警按需人工处理。
6. **后台随时可以干预。** 「让节点重新核对」会换发新 `checkId` 并清零失败计数；「确认旧页面已停止」写 `operator_confirmed` 记录，对 0.4.16 节点再下发一条“仅释放本机执行锁”。两者都只对 `superseded` 围栏生效，并受写权限控制。

### 为什么不用新的 `command_type`，也不复用 `stop`

新增 `confirm_stop` 一类指令类型，有以下代价：

- **需要迁移。** `capture_agent_commands.command_type` 有 CHECK 约束，见 `032_cloud_capture_task_center.sql:168`、`033_cloud_remote_task_creation.sql:11-12`。
- **待处理的核对指令本身就会占住执行槽。**
  - `findCaptureAgentExecutionSlotBlocker` 把任何 `pending`/`acknowledged` 且未过期的指令都算作占用（`capture-cloud.js` 约 1111–1119）。围栏放行后，节点可能仍因核对指令本身领不到任务。
  - 接力 relay gate（routes 约 7426–7432）同理：执行任务上挂着一条待处理指令时，关键词无法转交。
  - 批次详情的 `blocking_command`、完成接口对未知类型写误导性的 `command_result_ignored`（约 9887–9895）、节点失效时的过期清扫只处理 resume/stop/create（约 2400–2420）、`expires_at` 默认 30 天，都要逐处加例外。通用的 pending 判断大约有 60 处。
- **复用 `stop` 更糟。**
  - `superseded` 任务只能走带 `terminalDisposition` 的优先通道下发。
  - 完成时会把任务改成 `canceled`，并取消 `execution_task_id` 关联的工作项和尝试（约 9767–9856）。
  - 写 `metadata.stopCommandId` 会触发 `074` 的 `stop_capture_recovery_intents_for_user_command`（约 1478–1660），把已转交关键词的值守恢复意图标成 `stopped_by_user`。
  - 旧扩展对不再当前的请求会直接回 `accepted:true 'already_terminal'`，什么都没停（`background.js` 约 10786–10808）。
  - 它还会和真正的「停止」撞上唯一索引 `uniq_capture_agent_commands_active`。

因此把“命令”做成心跳下发、专用接口回执的核对请求：

- 状态存在任务行的 `metadata.stopFenceCheck`（jsonb），无需迁移。
- 它不经过指令查询，所以不受创建围栏限制，节点被挡住时照样能收到。
- 它也不进入执行槽判定。
- 扩展只按字段名读心跳响应（约 7547–7612），旧版本即使收到这个字段也会忽略。

命名：能力 `previousCaptureStopCheckV1`，响应字段 `stopFenceChecks`，回执 `POST /api/capture-cloud/agent/stop-fence-checks/:checkId/complete`。

## 协议

### 能力声明

扩展 0.4.16 在心跳 `agent.capabilities` 里加 `previousCaptureStopCheckV1: true`（`utils/cloud-task-agent.js` 约 1179–1214）。服务端判定能力时，只看本次心跳上报的能力，与弹性派发的做法一致；后台接口看库里已存的 `capture_agents.capabilities`。

### 下发：心跳响应 `stopFenceChecks`

只在完整心跳里下发，且需同时满足：`taskStateKnown`、节点有效、能力为 `true`、应急开关未关闭。优先通道（`priorityControlOnly`）的响应不带这个字段。每次最多 3 条，两种模式：

```json
{
  "stopFenceChecks": [{
    "version": 1,
    "mode": "check | release_only",
    "checkId": "uuid",
    "taskId": "uuid",
    "requestId": "COALESCE(NULLIF(control_task_id,''), client_task_id)，非空",
    "attemptId": "最近一条 capture_task_attempts.client_attempt_id，否则 metadata.attemptIdentity，可为空，仅记录",
    "platform": "xiaohongshu",
    "fencedAt": "COALESCE(finished_at, handoffAt, updated_at)，仅记录",
    "expiresAt": "ISO"
  }]
}
```

- `check`：请节点核对旧页面，证明后释放本机资源并回执。
- `release_only`：运营已人工确认。节点不做证明，只关闭 R 已终态轮次的 runner、按精确身份释放本机执行锁和采集辅助，然后回执。

`requestId` 为空的行（例如被提升的克隆任务，`client_task_id` 为空，routes 约 12534–12556）不下发：节点无法定位本机记录。这类行在后台按需人工处理（见「管理端」）。

### 回执：`POST /api/capture-cloud/agent/stop-fence-checks/:checkId/complete`

鉴权用 `requireCaptureAgent`，请求体为 `{taskId, requestId, result}`。`result` 保持扁平，嵌套不超过 3 层。键名不含 session、token、auth…code、credential、cookie、password：服务端清洗器（`capture-cloud.js` 约 203–235）会把这类键打码。例如不用 `debugSessionPresent`。

```json
{
  "version": 1,
  "mode": "check",
  "checkId": "uuid", "taskId": "uuid", "requestId": "R",
  "accepted": true,
  "reason": "previous_capture_stopped",
  "retryable": false,
  "requiresOperator": false,
  "proofMethod": "browser_sweep",
  "requestKnown": true,
  "requestStatus": "needs_action",
  "requestActive": false,
  "attemptId": "本机记录的围栏轮次", "lockAttemptId": "执行锁上的轮次，可为空",
  "runtimeEpochOrigin": "browser_startup | extension_load | unknown",
  "runtimeStartedAt": "ISO",
  "fenceRuntime": "same | different | unknown",
  "captureRequestKnown": true,
  "sweepComplete": true, "sweptTabCount": 4, "unresolvedTabCount": 0,
  "relayInFlightCount": 0,
  "targets": [{
    "tabId": 123,
    "role": "runner | lock_holder | progress_tab | debug_source | group_source | group_worker | fence_target | relay_target | platform_tab",
    "evidence": "见下表",
    "platform": "xiaohongshu | douyin | weibo | extension | other",
    "documentState": "current_runtime | before_runtime | unknown",
    "overlayState": "running | backoff | completed | failed | cancelled | ''"
  }],
  "pendingTabIds": [],
  "pendingTabs": [{"tabId": 123, "platform": "xiaohongshu", "evidence": "old_document_uninspectable", "title": "页面标题，≤40 字"}],
  "runnerTabsClosed": 1,
  "scopedCancelSent": false,
  "lockReleased": true,
  "localLockBoundToRequest": false,
  "residueReleased": true,
  "localStopConfirmationAt": "ISO 或空",
  "checkedAt": "ISO", "durationMs": 2310,
  "message": "设备已确认旧采集页面已停止，已释放本机执行锁与采集辅助"
}
```

`fenceRuntime` 只作记录，不参与判定。`release_only` 回执只带 `mode`、三个标识、`accepted`、`reason`、`retryable`、`runnerTabsClosed`、`lockReleased`、`localLockBoundToRequest`、`residueReleased`、`checkedAt`、`message`。

单页证据（`targets[].evidence`）：

| evidence | 含义 | 算停止证据 |
|---|---|---|
| `tab_closed` | 按 id 归属于 R 的页面已不存在 | 是 |
| `tab_discarded` | 页面已被浏览器丢弃（无文档在跑） | 是 |
| `navigated_off_platform` | 归属页已离开采集脚本所在的站点，连续观察 ≥ 10 分钟 | 是 |
| `runner_closed` | R 已终态轮次的 runner 页已由本次核对关闭 | 是 |
| `content_idle` | 文档晚于本次加载，内容脚本回报没有任何采集在跑 | 是 |
| `content_absent` | 文档晚于本次加载、已加载完成，内容脚本不存在（“Receiving end does not exist”），且 R 名下在途中继为 0 | 是 |
| `content_canceled_settled` | 文档晚于本次加载，页面上的活动全部属于 R，已发精确停止并确认归零 | 是 |
| `unrelated_live_capture` | 文档晚于本次加载，页面上没有属于 R 的活动，且每个活动 id 都能追溯到存活执行锁持有文档发起的在途中继，未触碰 | 是（与本请求无关） |
| `off_platform_observing` | 已离开站点，但观察不足 10 分钟（往返缓存窗口） | 否，可重试 |
| `tab_frozen` | 页面被冻结，无法检查 | 否，可重试 |
| `probe_failed` | 页面加载中、读取文档时间失败、内容脚本超时或返回异常 | 否，可重试 |
| `tab_busy_unattributed` | 有采集在跑，但与 R 混在一起或无法追溯归属，未触碰 | 否，可重试 |
| `capture_still_active` | 已发精确停止，5 秒内未归零 | 否，可重试 |
| `runner_close_failed` | R 的 runner 页未能关闭 | 否，可重试 |
| `old_document_uninspectable` | 平台页文档早于本次扩展加载，无法区分旧脚本 | 否，需人工 |
| `source_identity_unverifiable` | 归属页是无法确认身份的扩展页，或是 R 的某个不认识轮次的 runner | 否，需人工 |

整体原因码（`result.reason`）及后台文案：

| reason | accepted | retryable | requiresOperator | 后台文案 |
|---|---|---|---|---|
| `previous_capture_stopped` | 是 | – | 否 | 节点已确认旧采集页面已停止 |
| `request_active` | 否 | 是 | 否 | 节点本机仍在运行该任务，稍后再核对 |
| `capture_still_active` | 否 | 是 | 否 | 已向旧采集发送精确停止信号，尚未结束，稍后自动复核 |
| `tab_busy_unattributed` | 否 | 是 | 否 | 页面上有无法归属的采集在运行，未做处理，稍后复核 |
| `off_platform_observing` | 否 | 是 | 否 | 旧页面已离开平台，观察满 10 分钟后确认 |
| `tab_frozen` / `probe_failed` | 否 | 是 | 否 | 页面暂时无法检查（冻结、加载中或无响应），稍后复核 |
| `checkpoint_reports_pending` | 否 | 是 | 否 | 旧任务还有进度未上报，暂不关闭其运行页，稍后复核 |
| `runner_close_failed` / `lock_holder_alive` / `local_release_failed` / `request_changed` | 否 | 是 | 否 | 本机运行页或执行锁未能释放，稍后复核 |
| `check_timeout` / `storage_unreadable` | 否 | 是 | 否 | 核对超时或本机状态读取失败，稍后复核 |
| `old_document_uninspectable` | 否 | 否 | 是 | 旧采集页面是扩展重载或升级前打开的，无法自动确认；请在该电脑关闭或刷新下列页面（或重启 Chrome），系统会在 3 分钟内自动复核 |
| `source_identity_unverifiable` | 否 | 否 | 是 | 无法确认旧采集页面身份，请在该电脑关闭下列页面，或检查后人工确认 |
| `proof_rejected`（服务端判） | 否 | 是 | 否 | 节点回执不满足放行条件 |
| `invalid_result`（服务端判） | 否 | 是 | 否 | 节点回执格式不正确，请升级扩展或人工确认 |
| `local_release_done` / `local_lock_absent`（仅释放） | 是 | – | 否 | 节点已释放本机执行锁 |

整体原因按“需人工优先，再按上表顺序”从单页证据归并。

### 回执的服务端响应

- `200 {ok:true, released:true, message}`：已放行。节点收到后立即补一次心跳。
- `200 {ok:true, released:true, idempotent:true}`：此前已放行（节点确认、人工确认或 `976a0c6`）。
- `200 {ok:true, released:false, nextIssueAt, message}`：已记录，围栏保留。
- `200 {ok:true, localRelease:'done'|'pending', message}`：`release_only` 的回执。
- `409 stop_fence_check_stale`：`checkId` 已过期或被替换，或任务已不在停止保护中。
- `409 stop_fence_check_request_mismatch`：`requestId` 与任务不符。
- `404 stop_fence_check_not_found`：任务不存在，或不属于该节点或租户。
- `400 invalid_stop_fence_check_result`：请求体不合法。绑定校验（下文第 1–7 步）已通过时，先把 `invalid_result` 记进 `lastResult` 再返回。
- `503 server_busy`：沿用完成接口的容量错误处理（约 10031–10046）。

扩展侧：除 429 外的任何 4xx（含 `requestJson` 把 404 统一成的 `endpoint_missing`，`cloud-task-agent.js` 约 1300–1309）都标记该 `checkId` 完成并丢弃结果；5xx、429 和网络错误保留缓存结果重发。

## 服务端

### 新模块 `server/services/capture-stop-fence.js`

纯函数与 SQL 助手集中放在这里，避免 `capture-cloud.js` 再膨胀。它从 `capture-cloud.js` 导入 `captureTaskUnconfirmedLocalStopSql`，只导入不修改。

- 常量：
  - `STOP_FENCE_CHECK_CAPABILITY = 'previousCaptureStopCheckV1'`、`STOP_FENCE_CODE`、`STOP_FENCE_RECONCILED_CODE = 'HISTORICAL_STOP_FENCE_RECONCILED'`。
  - `STOP_FENCE_PROOF_EVIDENCE`（上表 8 个“是”）、`STOP_FENCE_CONTENT_EVIDENCE`（`content_idle`、`content_absent`、`content_canceled_settled`、`unrelated_live_capture`）。
  - `STOP_FENCE_CHECK_TTL_MS = 10 min`、`STOP_FENCE_CHECK_RETRY_MS = 3 min`、`STOP_FENCE_OFFER_WRITE_THROTTLE_MS = 5 min`、`STOP_FENCE_OFFER_LIMIT = 3`。
  - `STOP_FENCE_ESCALATE_AFTER_FAILURES = 3`、`STOP_FENCE_ESCALATE_AFTER_MS = 30 min`、`STOP_FENCE_LOCAL_RELEASE_TTL_MS = 24 h`。
- `stopFenceAutoCheckEnabled(env = process.env)`：`CAPTURE_STOP_FENCE_AUTO_CHECK !== 'off'`。
- `normalizeStopFenceCheckResult(raw)`：按上面的结构做白名单。字符串截断（原因 80 字、文案 200 字、标题 40 字），`targets` ≤ 40（扩展先放非证明页），`pendingTabIds` ≤ 20 个正整数，`pendingTabs` ≤ 10，未知键丢弃。不合法时返回 `{ok:false, reason}`。
- `evaluateStopFenceProof(result, {checkId, taskId, requestId})`，返回 `{ok, reason}`。`ok` 需同时满足：
  - `version === 1`，`mode === 'check'`，三个标识都相等。
  - `accepted === true`，`reason === 'previous_capture_stopped'`，`proofMethod === 'browser_sweep'`。
  - `sweepComplete === true`，`unresolvedTabCount === 0`，`relayInFlightCount === 0`。
  - `requiresOperator === false`，`requestActive === false`，`localLockBoundToRequest === false`，`pendingTabIds` 为空。
  - 每个 `target.evidence` 都在 `STOP_FENCE_PROOF_EVIDENCE` 里；证据属于 `STOP_FENCE_CONTENT_EVIDENCE` 的，`documentState` 必须是 `current_runtime`；`sweptTabCount >= targets.length`。

  服务端无法独立验证页面状态，这一步只校验回执自洽、与本次下发绑定。旧版停止回执（`accepted:true`）一律不作证明。
- `stopFenceCheckEscalated(state, now)`：`lastResult.requiresOperator`、`failureCount >= 3`、或 `now - firstIssuedAt >= 30 min`（且未解决）任一成立。
- `listCaptureAgentStopFences(executor, tenantId, {agentId = null, onlySuperseded = false, includeLocalRelease = false, limit = 200})`：返回命中围栏的非编排任务行，数据源和准入用的是同一个 SQL。
  - 外层先按 `UPPER(COALESCE(error->>'code',''))='PREVIOUS_CAPTURE_STOP_UNCONFIRMED'` 预筛，再与 `captureTaskUnconfirmedLocalStopSql('task')` 取交，`kind = 'fence'`。
  - `includeLocalRelease` 时，另 UNION 已放行、`metadata->'stopFenceCheck'->'localRelease'->>'state' = 'pending'` 且未过期的行，`kind = 'local_release'`。
  - 返回列：`kind, id, parent_task_id, agent_id(COALESCE(assigned, origin)), status, platform, title, error, fenced_at, handoff_successor_task_id, request_id, attempt_id(LATERAL capture_task_attempts), stop_fence_check(metadata->'stopFenceCheck')`。
- `summarizeAgentStopFence(agentRow, rows, {now, autoCheckEnabled})`：按节点汇总，并算出唯一的 `phase`（见「让『为什么不派活』有答案」）。概览接口和值守采集都用它，管理端不再自己推断。
- `claimStopFenceCheckOffers(tx, {agent, now})`：心跳下发，算法见下。
- `recordStopFenceCheckResult(tx, {task, agent, result, verdict, now})`：记录未通过的结果，处理升级。
- `reconcileCaptureTaskStopFences(tx, {tenantId, agentId, taskIds, proofStatus, reason, requestedBy, actorType, actorId, actorName, checkId, evidence, note, requestLocalRelease})`：放行写入，见下。
- `rotateStopFenceChecks(tx, {tenantId, agentId, requestedByName, actorId})`：后台「让节点重新核对」。

### 任务上的核对状态 `metadata.stopFenceCheck`

```json
{
  "version": 1,
  "checkId": "uuid", "round": 1,
  "firstIssuedAt": "ISO", "issuedAt": "ISO", "expiresAt": "ISO",
  "requestedBy": "system | user", "requestedByName": "",
  "lastOfferedAt": "ISO", "offerCount": 3,
  "failureCount": 0, "nextIssueAt": null, "escalatedAt": null,
  "lastResult": {"checkId": "", "at": "", "accepted": false, "reason": "", "retryable": true,
                 "requiresOperator": false, "pendingTabCount": 0,
                 "pendingTabs": [{"platform": "", "evidence": "", "title": ""}], "message": ""},
  "resolvedAt": null, "resolution": null,
  "localRelease": null
}
```

`localRelease` 只在人工确认 0.4.16 节点后出现：`{checkId, state:'pending'|'done'|'expired', requestedAt, expiresAt, lastOfferedAt, nextIssueAt, lastResult}`。

写法一律是 `metadata = jsonb_set(metadata, '{stopFenceCheck}', $x::jsonb)`，不动 `updated_at`、`status` 和其它键。

- `073` 的任务唤醒触发器忽略子任务上只改 metadata 的更新。
- `074` 的空槽触发器只看状态和指派节点。
- `074:1478` 的停止触发器只看 `stopCommandId`、`operatorStopped`、`stoppedBeforeDispatch`。

以上都不会被触发。

### 心跳下发（`server/routes/capture-cloud.js` `/agent/heartbeat`）

1. 预检放在心跳主事务里，排在 `dispatchNextElasticWorkItem` 之后、指令查询之前（约 8952–8966）。条件是 `taskStateKnown && heartbeatCapabilities.previousCaptureStopCheckV1 === true && stopFenceAutoCheckEnabled()`，查询一次：

   ```sql
   SELECT EXISTS (
     SELECT 1 FROM capture_tasks
     WHERE tenant_id = $1
       AND (assigned_agent_id = $2 OR (assigned_agent_id IS NULL AND origin_agent_id = $2))
       AND status = 'superseded'
       AND (
         (UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
           AND NULLIF(metadata->>'recoveryTaskId', '') IS NULL)
         OR (UPPER(COALESCE(error->>'code', '')) = 'HISTORICAL_STOP_FENCE_RECONCILED'
           AND metadata->'stopFenceCheck'->'localRelease'->>'state' = 'pending')
       )
   )
   ```

   写法要能用上 `(assigned_agent_id, updated_at)` 索引。第一支与围栏 SQL 的基本条件一致（码、非终态、无 `recoveryTaskId`）；两者之差只剩 `976a0c6` 已隐式放行的行，由下面第 3 步补写记录，之后不再命中。第二支在 24 小时内必然转为 `done` 或 `expired`。所以预检为真只会是暂时的。
2. 预检为真时，主事务提交之后，另开一个短事务执行 `claimStopFenceCheckOffers`。该事务设 `statementTimeoutMs: 1500`、`lockTimeoutMs: 500`，用 try/catch 包住，出错只记日志，并返回 `stopFenceChecks: []`。这样心跳主流程和已领取的工作不受影响。
3. `claimStopFenceCheckOffers` 的步骤：
   1. `lockActiveCaptureAgentSession(tx, agent)`，节点已失效就返回空。
   2. **补写 `976a0c6` 记录**：取预检第一支命中、但不在 `listCaptureAgentStopFences` 结果里的行（最多 20 行），调用 `reconcileCaptureTaskStopFences(…, proofStatus:'completed', reason:'admission_rule_976a0c6', actorType:'system', requestedBy:'system')`，事件文案“该节点此后已在同平台完成采集，按既有规则确认旧页面已停止”。这些行在准入里早已不算围栏，这里只是把事实写下来。
   3. 用 `listCaptureAgentStopFences(tx, tenant, {agentId, onlySuperseded:true, includeLocalRelease:true, limit: 6})` 取 id，跳过 `request_id` 为空的行。
   4. `SELECT … WHERE id = ANY($ids) AND status='superseded' FOR UPDATE SKIP LOCKED`，按 id 排序，复核码未变。
   5. `kind='fence'` 的行按状态 `s` 处理：
      - 没有 `s` 或 `s.version !== 1`：签发第 1 轮。`checkId = crypto.randomUUID()`，`firstIssuedAt = issuedAt = now`，`expiresAt = now + 10min`。写事件 `stop_fence_check_requested`（系统），文案“已请求原节点核对并停止旧采集页面”。
      - 当前轮已答且未通过（`s.lastResult?.checkId === s.checkId`）：`now < s.nextIssueAt` 时不下发；到期则签发下一轮（新 `checkId`，`round+1`），本轮不写事件。
      - 当前轮过期未答（`now ≥ s.expiresAt`，无本轮回执）：`nextIssueAt` 为空时，`failureCount+1`、`lastResult = {reason:'check_timeout', …}`、`nextIssueAt = now + 3min`，本次不下发；到期后签发下一轮。
      - 当前轮有效：下发。距 `lastOfferedAt` 满 5 分钟才更新 `lastOfferedAt` 和 `offerCount`。
      - 每次写 `s` 时计算 `stopFenceCheckEscalated`；首次成立时写 `escalatedAt` 和事件 `stop_fence_check_escalated`，文案“节点自动核对未能完成，需要人工处理：{后台文案}”。
   6. `kind='local_release'` 的行：`now > localRelease.expiresAt` 时置 `state='expired'`，不下发；`now < nextIssueAt` 时不下发；否则以 `mode:'release_only'`、`checkId = localRelease.checkId` 下发（节流同上）。
   7. 返回下发项（合计不超过 3 条），放进心跳响应（约 9126–9156）的 `stopFenceChecks`。
4. 应急开关：环境变量 `CAPTURE_STOP_FENCE_AUTO_CHECK=off` 时跳过第 1–3 步，两种模式都不再下发。回执照常处理，人工确认不受影响，后台显示 `auto_check_disabled`。改完需要 `pm2 restart`，但不必重新部署。

### 回执处理（新路由，放在 `/agent/commands/:id/complete` 旁边，约 9172）

在同一个事务里完成：

1. 校验 `checkId` 和 `taskId` 为 UUID。
2. `lockActiveCaptureAgentSession(tx, agent)`，节点失效则返回 403 `agent_inactive`。
3. `SELECT … FROM capture_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE`。行不存在，或 `COALESCE(assigned_agent_id, origin_agent_id) ≠ agent.id`，返回 404。
4. `requestId ≠ COALESCE(NULLIF(control_task_id,''), client_task_id)`：返回 409 `request_mismatch`。
5. **`release_only` 回执**（`result.mode === 'release_only'`）：`s.localRelease?.checkId ≠ :checkId` 返回 409 `stale`。否则规整后记录：`accepted` 为真时 `state='done'`；否则保持 `pending`，`nextIssueAt = now + 3min`。返回 `localRelease`。只在状态变化时写事件 `stop_fence_local_release_done`。
6. 以下为 `check` 回执。`error.code` 已是 `HISTORICAL_STOP_FENCE_RECONCILED`：返回 200 `idempotent`。`status ≠ 'superseded'` 或码不是围栏码：返回 409 `stale`。
7. `s.checkId ≠ :checkId`，或 `now > s.expiresAt + 5min`：返回 409 `stale`。`attemptId` 只记录，不强制相等：自动恢复路径上，本机锁可能指向上一轮。
8. `normalizeStopFenceCheckResult`：不合法时按未通过记录（`reason='invalid_result'`，内部原因写进 `lastResult.message`），然后返回 400。
9. `evaluateStopFenceProof`：
   - 通过：`reconcileCaptureTaskStopFences(…, proofStatus:'agent_confirmed', reason:'agent_confirmed_previous_capture_stopped', requestedBy: 节点显示名, actorType:'capture_agent', checkId, evidence)`。
   - 节点报了 `accepted:true` 但校验不过：按未通过处理，`reason='proof_rejected'`，内部原因写进 `lastResult.message`。
   - 未通过：`recordStopFenceCheckResult` 写 `lastResult`（含 `pendingTabs`）、`failureCount+1`、`nextIssueAt = now + 3min`，并按上文计算升级。只有原因变化或第一次失败时才写事件 `stop_fence_check_failed`，文案为“节点核对未通过：{后台文案}”，payload `{checkId, reason, retryable, requiresOperator, pendingTabCount}`。

### 放行写入 `reconcileCaptureTaskStopFences`

```sql
UPDATE capture_tasks
SET error = error || jsonb_build_object(
      'code', 'HISTORICAL_STOP_FENCE_RECONCILED',
      'originalCode', 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'),
    metadata = jsonb_set(
      metadata || jsonb_build_object('historicalStopFenceReconciliation', $reconciliation::jsonb),
      '{stopFenceCheck}',
      COALESCE(metadata->'stopFenceCheck', '{}'::jsonb)
        || jsonb_build_object('resolvedAt', now()::text, 'resolution', $proofStatus::text)
        || CASE WHEN $requestLocalRelease::boolean
             THEN jsonb_build_object('localRelease', jsonb_build_object(
               'checkId', gen_random_uuid()::text, 'state', 'pending',
               'requestedAt', now()::text, 'expiresAt', (now() + interval '24 hours')::text))
             ELSE '{}'::jsonb END)
WHERE tenant_id = $1 AND id = ANY($2::uuid[])
  AND COALESCE(assigned_agent_id, origin_agent_id) = $3
  AND status = 'superseded'
  AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
RETURNING id, status, error, metadata->'historicalStopFenceReconciliation'->'originalError' AS original_error
```

（`gen_random_uuid()` 若在库里不可用，就由 JS 为每行生成后按 id 传入。）

- `historicalStopFenceReconciliation` 为 `{at, reason, proofStatus, requestedBy, originalError, agentId, checkId, requestId, evidence, note, actorId}`。前 5 项与先例同名同义。`originalError` 由 JS 在 UPDATE 前从已锁定的行里取得。`evidence` 是规整后的回执子集：`proofMethod, runtimeEpochOrigin, runtimeStartedAt, fenceRuntime, sweptTabCount, targets, lockReleased, residueReleased, checkedAt`。
- `requestLocalRelease` 只在人工确认、且节点已存能力含 `previousCaptureStopCheckV1` 时为真。
- 状态保持 `superseded`，`updated_at` 不变，工作项、尝试和父任务都不动，与先例一致。
- 每行写事件 `historical_stop_fence_reconciled`：
  - `status='superseded'`，payload 为 `{proofStatus, reason, originalError, checkId}`。
  - `actor_type` 分三种：节点确认为 `capture_agent`，运营确认为 `user`，`976a0c6` 补写为 `system`。
  - 文案分三种：“节点已确认旧采集页面已停止，解除停止保护”；“{操作人} 人工确认旧采集页面已停止，解除停止保护”；`976a0c6` 补写文案见上。
- 放行后补一次唤醒（`976a0c6` 补写不需要：准入早已不算它）。只改错误码不会触发 `074` 的空槽触发器，所以照抄该触发器（`074:720-736`）的写法：

  ```sql
  SELECT enqueue_ops_control_wakeup($1, 'capture_recovery_agent_slot_released',
    'capture_recovery_agent_slot', $2::text,
    'capture-recovery-agent-slot:' || $1::text || ':' || $2::text, now(),
    jsonb_build_object('agentId', $2, 'trigger', 'stop_fence_reconciled'), true)
  WHERE EXISTS (SELECT 1 FROM capture_recovery_intents
    WHERE tenant_id=$1 AND status='waiting_agent' AND window_ends_at > now())
  ```

  放行后，节点在下一次心跳就能领任务。

### 后台接口

两个接口都挂 `requireCriticalTenantAccess, requireSessionUser, requireTenantWriter, requireBrowserNodeControl`，所有错误都带中文 `message`。`api.ts` 在没有 message 时会显示原始错误码。

**`POST /api/capture-cloud/agents/:id/stop-fence/recheck`（让节点重新核对）**

- 事务里先 `lockCaptureAgentExecutionSlot(tx, tenant, agentId)`，再对该节点所有 `superseded`、`requestId` 非空的围栏行执行 `rotateStopFenceChecks`：
  - 新的 `checkId`，`round+1`，`firstIssuedAt=now`，`failureCount=0`，`nextIssueAt=null`，`escalatedAt=null`，`requestedBy='user'`。
  - 写事件 `stop_fence_check_requested`（`actor_type='user'`），文案“{操作人} 已请求原节点重新核对旧采集页面”。
  - 旧 `checkId` 的回执此后会得到 409 `stale`。
- 各种情况的返回：

| 情况 | 返回 | message |
|---|---|---|
| 节点能力缺 `previousCaptureStopCheckV1` | 409 `agent_stop_fence_check_unsupported` | “该节点扩展版本不支持自动核对（需升级到 0.4.16），请到该电脑检查后点「确认旧页面已停止」” |
| 应急开关已关闭 | 409 `agent_stop_fence_check_disabled` | “自动核对已在服务端关闭，请到该电脑检查后点「确认旧页面已停止」” |
| 没有围栏 | 409 `agent_stop_fence_absent` | “该节点当前没有待确认的旧采集页面” |
| 只有非 `superseded` 的围栏 | 409 `agent_stop_fence_task_action_required` | “该节点的停止保护来自仍需处理的任务，请在该任务上点「继续」或「停止」” |
| 节点离线 | 200 | “节点当前离线，上线后会自动核对” |
| 节点在线但状态上报不完整 | 200 | “节点状态上报不完整，恢复后才会核对；也可到该电脑检查后人工确认” |
| 否则 | 200 | “已请求节点重新核对旧采集页面，约 1 分钟内返回结果” |

  另有 `requestId` 为空的行时，追加“；其中 N 个任务无法定位节点本机记录，需人工确认”。
- 写 `audit_logs`，action 为 `capture_agent.stop_fence_recheck_requested`。

**`POST /api/capture-cloud/agents/:id/stop-fence/confirm`（确认旧页面已停止）**

- 请求体：`{confirmation: '确认旧页面已停止', expectedTaskIds: [...], note?: string(≤200)}`。确认串不对时返回 400 `agent_stop_fence_confirmation_required`，文案“请勾选确认后再提交”。
- 事务里先 `lockCaptureAgentExecutionSlot`，再用 `listCaptureAgentStopFences` 取该节点当前的围栏行：
  - 当前的 `superseded` 集合 ⊄ `expectedTaskIds`（出现了运营没看到的新围栏）：返回 409 `agent_stop_fence_changed`，文案“该节点的待确认任务已变化，请刷新后重新确认”。
  - 否则只放行当前集合，已被节点自动放行的自然略过。
  - `reconcileCaptureTaskStopFences(…, proofStatus:'operator_confirmed', reason:'operator_confirmed_previous_capture_stopped', requestedBy: req.actorName, actorType:'user', actorId: req.user.id, note, requestLocalRelease: 节点已存能力含 previousCaptureStopCheckV1)`。
  - 写 `audit_logs`，action 为 `capture_agent.stop_fence_confirmed`，payload `{taskIds, note}`。
- 非 `superseded` 的围栏行不动，在响应里以 `requiresTaskAction: [{id, title, status, parentTaskId}]` 列出。
- 成功文案：“已确认旧采集页面已停止，节点恢复接单（N 个任务已记录人工确认）”。
  - 0.4.16 节点追加“；节点会在下次心跳时释放本机执行锁”。
  - 旧版本节点追加“；该节点扩展版本较旧，如随后领任务报执行锁冲突，请在该电脑重启 Chrome”。
  - 有 `requiresTaskAction` 时追加“；另有 K 个仍需处理的任务，请在任务上点「继续」或「停止」”。

### 让「为什么不派活」有答案

- **概览接口 `GET /overview`**：在同一个报表事务里调用一次 `listCaptureAgentStopFences(tx, tenant, {includeLocalRelease: true, limit: 200})`，按节点分组，用 `summarizeAgentStopFence` 给 `agents[]` 加 `stop_fence`：

  ```json
  "stop_fence": null | {
    "phase": "见下表",
    "task_count": 1, "superseded_count": 1, "action_required_count": 0,
    "manual_only_task_count": 0, "local_release_pending_count": 0,
    "local_release_holds_new_work": false,
    "since": "最早 fenced_at", "auto_check_supported": true, "auto_check_enabled": true,
    "escalated": false, "escalated_at": null,
    "superseded_task_ids": ["该节点全部已转交围栏的 id，不受 20 条限制"],
    "tasks": [{"id", "parent_task_id", "title", "platform", "status", "fenced_at", "message",
               "handoff_successor_task_id", "auto_checkable",
               "check": null | {"check_id", "round", "first_issued_at", "issued_at", "expires_at",
                                "last_offered_at", "next_issue_at", "failure_count", "escalated_at",
                                "last_result": null | {"at", "accepted", "reason", "retryable",
                                                       "requires_operator", "pending_tab_count",
                                                       "pending_tabs", "message"}}}]
  }
  ```

  - 每个节点最多列 20 个任务。`auto_check_supported = capabilities->>'previousCaptureStopCheckV1' = 'true'`，`auto_check_enabled = stopFenceAutoCheckEnabled()`，`auto_checkable = superseded 且 request_id 非空`。
  - `phase` 由服务端按以下优先级计算，用到概览里已有的 `online` 与 `dispatch_ready`（routes 约 10490–10500）：

    | phase | 条件 |
    |---|---|
    | `task_action_required` | 没有 `superseded` 围栏，只有非 `superseded` 的 |
    | `manual_only` | `!auto_check_supported`，或有 `superseded` 围栏行 `auto_checkable=false` |
    | `auto_check_disabled` | `!auto_check_enabled` |
    | `offline` | `!online` |
    | `heartbeat_degraded` | `online && !dispatch_ready`（节点在线，但完整心跳过期或 `taskStateKnown=false`，收不到下发，routes 约 8830–8833） |
    | `needs_operator` | 任一行已升级 |
    | `node_retrying` | 当前轮未通过、未升级 |
    | `node_checking` | 当前轮已下发、未回执、未过期 |
    | `awaiting_node` | 其它 |
    | `local_release_pending` | 没有围栏行，只有待释放本机锁的行。围栏已解除；但在节点释放本机锁之前（最多到首次下发后 10 分钟，从未下发的最多到确认后 1 小时），心跳暂不派新采集，此时 `local_release_holds_new_work = true` |

  - 这条查询按租户只算一次，受现有 2 秒语句超时和 1 秒投影缓存保护。`976a0c6` 实测一次领取判定约 7–10 ms，这里同量级。
  - 管理端只认这个字段，不能自己按 `error.code` 推断围栏：`976a0c6` 隐式放行时不改码。
- **值守总览与告警**（`server/services/ops-control.js`，不需要迁移：`ops_control_incidents.incident_type` 是自由文本，`070:81`；告警投递已有，`072`）：
  - `collectOpsControlEvidence` 增加 `collectStopFences(database, tenantId, agents)`：调用 `listCaptureAgentStopFences` 和 `summarizeAgentStopFence`，证据为 `stopFences: [{agentId, displayName, phase, since, taskCount, escalated}]`，`normalizeOpsControlEvidence` 同步规整。
  - 摘要新增 `stopFenceBlockedAgentCount`（phase 不是 `local_release_pending` 的节点数）。`sourceClosureBlockedCount` 保持 0：它统计的是条目级本地收口标记，现有测试（`tests/ops-control.test.mjs` 约 536、795、892）锁定了它，含义也不同。
  - 新事件类型 `capture_agent_stop_fence_blocked`，每个节点一条（`targetId = agentId`），围栏持续满 30 分钟才产生：
    - `high`：phase 为 `manual_only`、`needs_operator`、`auto_check_disabled`、`heartbeat_degraded`、`task_action_required`。走现有告警邮件（high 及以上）。
    - `warning`：其它 phase（离线、等待、核对中、重试中）。
    - 标题“节点旧采集页面未确认停止，已暂停接单”；文案“{节点} 自 {since} 起不接新任务：{phase 文案}；请到「执行节点」处理”。
    - 不进 `ACTION_INCIDENT_MAP`，不触发任何自动动作。围栏解除后，下一轮不再出现，按现有逻辑自动关闭。
  - `OverviewPage.tsx`（约 261、277、328）与 `mobile/MobileApp.tsx`（约 466、472、515）：新增一项「待确认停止 N」（N > 0 时标红），首条事件为该类型时提示“节点旧页面未确认停止，已暂停接单”。「恢复阻塞」原样保留。
  - 值守观察只在值守窗口内运行；窗口外依靠后台节点面板。这一点写进面板说明。
- **执行槽判定**：`findCaptureAgentExecutionSlotBlocker`（`capture-cloud.js` 约 1098–1126）的结果多返回一列 `reason`，取值 `previous_capture_stop_unconfirmed` / `active_task` / `active_command`。这是纯新增列，判定条件不变。
- **手动下发排队**（routes 约 11733–11772、11900–11918）：
  - `queueBlocker` 查询多取 `CASE WHEN <围栏> THEN 'previous_capture_stop_unconfirmed' ELSE 'active_task' END AS reason`，写进 `metadata.queueBlocker.reason`。
  - 围栏原因时，任务文案为“目标节点旧采集页面尚未确认停止，新任务已排队”，接口文案为“任务已排队：该节点旧采集页面尚未确认停止，节点核对通过或管理员确认后自动执行”。
  - 其它原因的文案不变。
- **弹性接力留痕**：`dispatchNextElasticWorkItem` 里置 `superseded` 的 UPDATE（约 7982）改成带 `RETURNING id, UPPER(COALESCE(error->>'code',''))='PREVIOUS_CAPTURE_STOP_UNCONFIRMED' AS stop_fenced, COALESCE(assigned_agent_id, origin_agent_id) AS source_agent_id`。命中围栏时，在原任务上写事件 `stop_fence_handoff`，`agent_id` 取原节点。WHERE 条件和状态集合都不变。
- **手动接力和重试候选**（`server/routes/capture-orchestrations.js`）：
  - `loadRetryAgentCandidates`（约 644–760）增加 `AND ca.id NOT IN (SELECT COALESCE(fenced.assigned_agent_id, fenced.origin_agent_id) … WHERE fenced.tenant_id = $1 AND COALESCE(…) IS NOT NULL … AND ${captureTaskUnconfirmedLocalStopSql('fenced', '$1')})`。被围栏挡住的节点本来就领不到，这里只是不再把它列为“空闲”候选。子查询不引用外层节点行，整条查询只算一次围栏集合（hashed SubPlan）；写成按节点关联的 `NOT EXISTS` 时，计划器可能对每个候选节点各扫一遍 `capture_tasks`，而批次详情每 5 秒轮询一次、走 general 连接池。`IS NOT NULL` 不能省：节点删除后围栏行的两个节点 id 会被置空（`ON DELETE SET NULL`），`NOT IN` 碰到 NULL 会让所有节点都落选。
  - `handoff_target_busy`（约 6666–6676）按 `reason` 区分文案：“接力节点旧采集页面尚未确认停止，请选择其它节点，或先在执行节点中处理”。
  - `server/services/negative-patrol.js` 约 1204–1215 的忙碌文案同样按 `reason` 区分。

### 顺带堵住：关键词节点覆盖的无证据放行（单独一个提交，晚于 0.4.16 普及发布）

`server/services/keyword-node-coverage.js` 约 61–111：

- `keywordCoverageSkipReason` 增加原因 `keyword_node_stop_fenced`，放在 `keyword_node_no_response` 之前：节点被围栏挡住时，文案写明原因，不再报“无响应”。
- 置子任务为 `superseded` 时，如果子任务的 `error.code` 是围栏码，保留原 `error`，只把覆盖原因写进 `error.coverageReason`、`error.coverageMessage`。工作项和尝试的错误照旧写覆盖码。现有测试只断言工作项上的码（`keyword-account-coverage.integration.mjs` 154、225、252 行），不受影响。
- 效果：each_agent 批次里带围栏的子任务不再被悄悄放行，而是进入上面的核对闭环。

这一项单独一个提交，方便单独回滚。发布时机见「上线顺序」：在所有参与 each_agent 批次的节点都升级到 0.4.16 之前发布，会让只能人工确认的节点变多。

### 锁顺序与性能

- 所有新写入都遵循：节点槽锁（`lockActiveCaptureAgentSession` 或 `lockCaptureAgentExecutionSlot`）→ 任务行 `FOR UPDATE`（按 id 排序），与现有路径一致。不锁父任务和工作项。
- 弹性接力时，写原任务事件发生在领取方节点的事务里，那一行已被该 UPDATE 锁住，不会新增锁。
- 心跳只多一条带索引的 EXISTS。预检为真是暂时的（见上），只有名下确有围栏或待释放项的节点才多开一个短事务。概览多一条按租户的查询；值守采集每轮多一条同样的查询。

## Extension 0.4.16

### 能力与接口

- `utils/cloud-task-agent.js`：
  - `capabilities` 加 `previousCaptureStopCheckV1: true`。
  - 新增 `completeStopFenceCheck({checkId, taskId, requestId, result})`，POST 到上面的回执路由，写法照 `completeCommand`（约 1375–1409）。
  - 在 `root.OnStarvoiceCloudTaskAgent` 导出。
- `manifest.json` 升到 0.4.16。所需权限已有：`tabs`、`scripting`、`storage` 和平台 host 权限。

### 本次加载标识（runtimeEpoch）

- 新增 `ensureRuntimeEpoch()`。它读 `chrome.storage.session['onstarvoice.runtimeEpoch']`；没有时写 `{id: crypto.randomUUID(), startedAt: Date.now(), origin: 'unknown'}`，并记下“本 worker 创建了它”。service worker 启动时调用一次，围栏写入和核对前再各调用一次。
  - `storage.session` 在 service worker 重启后保留，扩展重载、升级、停用和浏览器重启时清空。所以同一个 `id` 等于“同一加载期”。
- `chrome.runtime.onStartup`（`background.js` 约 19069）里：本 worker 创建了当前标识时，把 `origin` 置为 `browser_startup`。`onInstalled`（约 19035）里同样置为 `extension_load`。
  - `browser_startup` 表示浏览器进程是随本次加载一起启动的，进程里不可能存在上一次加载留下的旧内容脚本。
- 读写失败时返回 `{known:false, origin:'unknown', startedAt: workerStartedAt}`。`workerStartedAt` 取模块加载时的 `Date.now()`，不早于真正的加载时间。
- **文档年龄门槛** `isDocumentFromCurrentRuntime(t, epoch)`：`origin === 'browser_startup'` 时恒为真；否则 `t > epoch.startedAt + 2s`。`startedAt` 偏晚只会让更多文档被判为“早于本次加载”，只会更保守。

### 在途中继登记表（新增，只登记不改行为）

- `inFlightContentRelays = new Map()`，键为每次中继生成的随机 key，值为 `{tabId, action, captureRequestId, taskId, senderTabId, senderDocumentId, runnerRequestId, runnerAttemptId, internal, startedAt}`。
- `relayToContentWithRetry(tabId, payload, owner = null)` 进入时登记，在现有 `finally`（约 15735–15744）里删除。刷新重发仍是同一条登记。
- `onstarvoice:relay-to-content`（约 20025–20180）调用时传 `owner`，取自 `sender`：`senderTabId = sender.tab?.id`、`senderDocumentId = sender.documentId`；`sender.url` 是本扩展页面时，解析 `unattendedRun`、`unattendedAttempt` 查询参数；`taskId` 取 `requestedTaskId`。
- 内部取消中继（约 4048、8393、17336）不传 `owner`，登记为 `internal: true`，不计入任何请求。
- 纯内存。service worker 重启会清空它，同时也终止了它登记的全部中继 promise，所以“登记表里没有”对 SW 一侧如实；重启前留在页面里的处理函数，则因无法追溯而按“无法归属”处理。
- 辅助函数：
  - `listRequestRelays(R, taskKey)`：`!internal && (runnerRequestId === R || taskId === taskKey)` 的条目。这包括不带 `captureRequestId` 的中继（例如 `applyBatchSearchFilters`，`capture-sync.js` 约 16264–16275）。
  - `findRelaysByCaptureRequestId(id)`。

### `content-v2.js`

`handleInspectCaptureActivity`（约 532–551）的返回新增两个字段，属于纯新增：

- `targetCount`：目标 id 的计数。
- `activeRequests: [{id, count}]`：`activeCaptureRequestCounts` 的全部条目，最多 20 条，id 截断到 200 字。

`waitForContentCaptureToSettle`（约 8335）只读原有字段，不受影响。晚于本次加载的文档里只会有 0.4.16 的内容脚本；万一缺这个字段，`activeCount > 0` 时按无法归属处理。

### 围栏写入时留证据（不改变行为）

`markUnattendedRecoveryStopUnconfirmed(request, message, evidence)` 增加第三个可选参数，调用处（约 12751、13102）传入；runner 刷新接续的写入点（约 11930–11948）同样处理。写入 `request.stopFenceEvidence`：

```json
{"version": 1, "at": "ISO(本机时钟)", "runtimeEpochId": "", "runtimeStartedAt": 0, "runtimeEpochOrigin": "",
 "captureRequestId": "request.progress.captureRequestId",
 "lockIdentity": "buildCaptureExecutionLockStopIdentity(lock)",
 "targets": [{"tabId": 1, "role": "progress_tab | lock_holder", "reason": "失败原因，≤80"}],
 "failedTabId": 1, "failedReason": ""}
```

停止目标、停止方法、状态迁移和返回值都不改。本次**不**把 `captureRequestId` 传进恢复路径的停止目标（约 12940–12943）：那样能减少围栏产生，但会改变恢复停止路径，另行评审。

### 心跳接入与去重

- `syncCloudTaskAgent` 先执行本轮的 `release_only` 项（`runStopFenceReleaseOnlyBeforeCommands`，最多等 15 秒），再执行 `response.commands`，之后调用 `void runStopFenceChecksFromHeartbeat(response.stopFenceChecks, credential)` 处理核对项，不阻塞本轮心跳。字段缺失或不是数组时直接跳过。
- 单飞：全局只允许一个核对在跑，每次最多处理一条，整体 45 秒截止。
- 本机去重存在 `chrome.storage.local['onstarvoice.stopFenceChecks']`：
  - 格式为 `{version:1, entries:{[checkId]:{taskId, requestId, mode, state:'running'|'done', result, posted, at, retryAt}}, offPlatformSeen:{['${tabId}:${requestId}']:{requestId, tabId, firstSeenAt}}}`。
  - `release_only` 回执送达但未释放（`accepted:false` 或服务端回 `localRelease:'pending'`）时记 `retryAt = now + 60s`，同一 `checkId` 再次下发且已过 `retryAt` 时重跑；其余已送达的一律跳过。
  - 保留最近 20 条；`offPlatformSeen` 超过 24 小时的清掉。
  - 同一 `checkId`：`running` 时跳过。`done` 且已送达时跳过。`done` 但没送达：结果不满 10 分钟就重发缓存结果；否则重新执行一次（每个 `checkId` 最多每 10 分钟一次）。
- 回执返回除 429 外的任何 4xx：标记 `done`、已送达，丢弃结果。
- 返回 `released:true` 时，置 `cloudTaskAgentSyncPending = true`，立即补一次心跳去领任务。

### 核对流程 `confirmPreviousUnattendedStopForFenceCheck(offer)`（`mode: 'check'`）

放在 `retryUnattendedLocalClosureCleanup`（约 9775）附近。记 `R = offer.requestId`，`taskKey = buildUnattendedCaptureTaskId(R)`。

**1. 只读收集本机状态**

- `slot = readUnattendedKeywordRunRequest()`。R 不在请求槽时，依次读归档（`readArchivedUnattendedKeywordRunRequest`）和台账，得到 `request`（可能为空）。
- `slot.id === R` 且 `!isTerminalUnattendedRunStatus(slot.status)` 时，直接回 `request_active`（可重试），不做任何动作。
- `epoch = ensureRuntimeEpoch()`；`fence = request?.stopFenceEvidence`；`fenceRuntime` 只作记录。
- R 的已终态轮次 `T_R = {request.attemptId, request.previousAttemptId}`，去掉空值。`offer.attemptId` 只记录，不用于关页或认锁。
- R 的已知采集 id `I_R = {request.progress.captureRequestId, fence.captureRequestId}` ∪ `listRequestRelays(R, taskKey)` 里的非空 `captureRequestId`。后者每次判定时按登记表实时重算，所以阶段一里 R 的 runner 新发起的中继也算在内。
- `lock = readStoredCaptureExecutionLock()`，只读。绝不调用 `readActiveCaptureExecutionLock`：它遇到过期锁会走带刷新的清理（约 11207–11257）。
- `boundToR`（严格）：`lock.owner === 'unattended_keyword_plan'`，且 `lock.captureTaskId === taskKey`，或 `fence.lockIdentity.id` 非空且 `captureExecutionLockMatchesStopIdentity(lock, fence.lockIdentity)`。**不**使用 `isCaptureExecutionLockOwnedByUnattendedAttempt`：它会按轮次 id 匹配到别的任务 id 的锁，也会按持有页回退（`background.js` 约 9543–9553）。

**2. 中止 R 的在途中继**

对 `I_R` 中每个 id 调 `markCaptureRequestAborted(id)`。这只是内存标记：带这些 id 的中继在下一个检查点返回，不再刷新、重注入或重发（`relayToContentWithRetry` 约 15669–15745）。

**3. 收集页面（全量扫描，`proofMethod = 'browser_sweep'`）**

范围是 `chrome.tabs.query({})` 里的三类页面：

- 采集脚本站点页：URL（`url || pendingUrl`）匹配 manifest 里 `content-loader.js` 的 `matches`（`www.xiaohongshu.com`、`www.douyin.com`、`v.douyin.com`、`weibo.com`、`www.weibo.com`、`s.weibo.com`，`manifest.json` 约 67–82）。其它能被 `detectPlatformFromUrl` 识别、但不在这份清单里的站点（例如裸域 `xiaohongshu.com`），我们的脚本跑不进去，只在按 id 归属于 R 时才检查。
- 按 id 归属于 R 的页面：`fence.targets`、`boundToR` 时的 `lock.holderTabId`、`request.progress.runnerTabId`、`request.runnerTabId`、Debug 会话源页、任务组的源页和工作页、`getTrackedCaptureTaskWorkers(taskKey)`、`listRequestRelays` 的 `tabId`。
- R 的 runner 页：`isUnattendedRunnerTabForRequest(tab, R, '')` 或 `isLegacyUnattendedRunnerTabForRequest(tab, R)`。

为什么每次都扫全部站点页：扩展重载或 worker 重启后，内存里的任务组和工作页记录可能丢失，只查“已记录的页面”会漏掉旧的详情工作页。这就是 `sweepComplete` 的含义。

**4. 逐页判定（阶段一，并行）**

并发 6 页，每页探测 ≤ 3 秒、内容查询 ≤ 3 秒、精确停止复查 ≤ 5 秒。任何一页不成立都不放行。

| 顺序 | 条件 | 判定 | 允许的动作 |
|---|---|---|---|
| 1 | R 的 runner 页 | 轮次属于 `T_R`，或是 legacy runner 且 tab id 等于本机记录的 `runnerTabId`：留给阶段二，本阶段不判定。其它情况：`source_identity_unverifiable`（需人工） | 无 |
| 2 | 归属页 `chrome.tabs.get` 报不存在 | `tab_closed` | 无 |
| 3 | `tab.discarded === true` | `tab_discarded` | 无 |
| 4 | `tab.frozen === true` | `tab_frozen`（可重试） | 无 |
| 5 | `tab.status === 'loading'` | `probe_failed`（可重试） | 无 |
| 6 | 归属页现在不是采集脚本站点页、也不是本扩展页面 | 首次看到时记入 `offPlatformSeen`，返回 `off_platform_observing`；连续 ≥ 10 分钟仍离开，才是 `navigated_off_platform`。往返缓存最长约 10 分钟，按「后退」可恢复旧文档 | 无 |
| 7 | 归属页是本扩展页面，但不是 R 的 runner 页 | `source_identity_unverifiable`（需人工） | 无 |
| 8 | 采集脚本站点页：探测文档 | `chrome.scripting.executeScript({target:{tabId, frameIds:[0]}, func: () => ({t: performance.timeOrigin, o: document.querySelector('[data-osv-list-harvest-host="true"]')?.dataset?.state \|\| ''})})`，3 秒。失败或超时：`probe_failed` | 只读 |
| 8a | 探测被 Chrome 以“showing error page”（或 `chrome-error://`）拒绝：页面停在浏览器错误页 | 按第 6 行的离站观察处理（同一个 `${tabId}:${requestId}` 窗口），归属页与未归属页相同；标题前加「浏览器错误页·」 | 无 |
| 9 | 年龄门槛 | `!isDocumentFromCurrentRuntime(t, epoch)`：`old_document_uninspectable`（需人工），计入 `pendingTabIds`/`pendingTabs`；`o === 'running'` 时文案加一句“页面仍在自动滚动”。**不再查询内容脚本，无论它是否应答** | 无 |
| 10 | 查询内容脚本 | `chrome.tabs.sendMessage(tabId, {action:'inspectCaptureActivity'}, {frameId:0})`，3 秒：<br>• 错误信息是 “Receiving end does not exist” / “Could not establish connection”：`content_absent`（阶段末还要求 R 在途中继为 0）。<br>• 超时或其它错误：`probe_failed`。处理函数是同步的，超时说明页面主线程忙，不是“没有脚本”。<br>• `activeCount === 0`：`content_idle`。<br>• 记页面活动 id 集合为 `S`（取自 `activeRequests`；缺该字段视为全部无法归属）。`S ⊆ I_R`：先对 `S` 中每个 id 打中止标记，再发 `cancelCapture`，`captureRequestId` 取 `S` 中任一 id（非空；内容脚本的取消标志整页生效），每 500 ms 复查一次，最多 5 秒；归零为 `content_canceled_settled`，否则 `capture_still_active`。<br>• `S` 与 `I_R` 有交集但不被包含（R 与别的采集混在同一页）：`tab_busy_unattributed`，不发取消。<br>• `S ∩ I_R = ∅`：锁不 `boundToR`、`getCaptureExecutionLockHolderState(lock) === 'alive'`，且 `S` 中**每个** id 都能在登记表里找到 `senderDocumentId === lock.holderDocumentId`（或双方都有 tab id 时 `senderTabId === lock.holderTabId`）、且 `runnerRequestId ≠ R`、`taskId ≠ taskKey` 的在途中继：`unrelated_live_capture`，不触碰；否则 `tab_busy_unattributed` | 只允许第 10 行所述的精确停止 |

采集脚本站点页以外、也不归属于 R 的页面不检查。

**5. 等待 R 的在途中继归零**

每 250 ms 查一次 `listRequestRelays(R, taskKey)`，最多 5 秒。不为 0 时，整体回 `capture_still_active`（`relayInFlightCount` 为剩余数），不再往下做。归零后，本轮的 `content_absent` 才算证明。

**6. 截止与归并**

整体 45 秒截止。到点时停止发起新的页面检查，已查页面照常回报，未查完的计入 `unresolvedTabCount` 和 `pendingTabs`，整体回 `check_timeout`（可重试）。任何一页不成立，按“需人工优先”归并原因后回执，**不关 runner、不释放任何东西**。阶段一里唯一可能发生的动作，是对只跑着 R 的页面发出的精确停止。

**7. 阶段二：关闭 R 的 runner 页并复扫**

只有阶段一全部成立、且存在 R 的 runner 页时执行。新增 `closeStopFenceRunnerTabs(R, T_R)`，规则与 `inspectUnattendedLocalClosurePredicate` 的 `closeOwnedRunnerTabs`（约 9985–10029）相同：

- 整个过程在 `runUnattendedRunnerTabLifecycle` 里执行。
- 对每个要关的轮次，`inspectUnattendedCheckpointOutboxAttempt(R, attemptId)` 必须可读且 `pendingCount === 0`；否则回 `checkpoint_reports_pending`（可重试），不关。与现有规则一致：留着 runner 让它把 checkpoint 上报完。
- 每关一页前重读请求槽：槽里是 R 且非终态，或槽里 R 的轮次已不在 `T_R`，回 `request_changed`。
- 只关 `isUnattendedRunnerTabForRequest(tab, R, a)`（`a ∈ T_R`），或 legacy runner 且 tab id 等于本机记录的 `runnerTabId`；`chrome.tabs.get` 复核 URL 后 `chrome.tabs.remove`，再 `chrome.tabs.query` 确认已不在。失败为 `runner_close_failed`。

关闭后重做第 2–6 步（复扫时 R 的 runner 页必须已不存在）。复扫不通过就按原因回执：此时 runner 已关，但 R 已终态，关它本来就是正常收口要做的事；执行锁和采集辅助仍未释放。

**8. 本机释放（全部成立后）**

三步依次执行，不嵌套队列，每步开头都重读状态：

1. `runUnattendedRunMutation`：R 在请求槽里时，若已变为非终态或轮次不在 `T_R`，回 `request_changed`；否则 `persistUnattendedStopConfirmationWithinMutation(current, {stage:'source_stopped', method:'stop_fence_check', fingerprint:{taskId: taskKey, lock: boundLockIdentity, targetTabIds}})`。
2. `runCaptureTaskLifecycleOperation`：
   - 重读请求槽：有任何非终态请求时，不动锁，回 `local_release_failed`（可重试）。
   - 重读锁，按上文严格规则重算 `boundToR`。绑定 R 时：`getCaptureExecutionLockHolderState(lock)` 为 `alive`，或为 `unknown` 而 `lock.holderTabId` 对应的页面仍存在，回 `lock_holder_alive`；否则 `releaseExactCaptureExecutionLockSnapshot(lock)`，按完整身份比对后删除。比对失败就重读：已不再绑定 R，视为已释放；仍绑定 R，回 `local_release_failed`。
   - 绑定别的任务的锁：不触碰，`localLockBoundToRequest=false`。
   - 然后 `releaseResidualUnattendedCaptureAssist(taskKey, {deferToLiveRequest: true, preserveActiveTabs: true, preserveTabIds: <判为 unrelated_live_capture 的页面>, stage: 'stop_fence_check'})`：这是 0.4.15 迟到 END 的回收语义（约 17661–17740），会在关页前再判一次、保留前台页、锁持有页和槽内请求的页面，槽里冒出存活请求就一页不关。结果写进 `residueReleased`（`released` 或 `capture_assist_absent` 为真）；未回收不影响证明，残留由后续 BEGIN、中继或 END 照 0.4.15 回收。
   - 这里不再调用 `releaseUnattendedCaptureTaskResourcesForRecovery`：它没有关页前的复判，也不保留前台页，只适合在任务自己的生命周期里使用（约 17394–17398 的注释说明了原因）。
3. `runUnattendedRunMutation`：R 仍在请求槽里时写 `stage:'runtime_released'`，并写 `request.stopFenceClosure = {version:1, at, checkId, taskId, proofStatus:'agent_confirmed'}`。`status`、`error` 和 `message` 保持不变，与服务端先例相同。

R 已归档或本机未知时，第 1、3 步跳过，第 2 步照做。

最后按上面的结构生成回执并发送。

`needs_action` 的本地请求在请求槽里算终态，新的创建指令会照常替换它（`background.js` 约 6899–6921），所以不需要改本地状态。

### 仅释放流程（`mode: 'release_only'`）

运营已人工确认之后才会下发。不做页面证明，也不发任何取消：

1. R 在请求槽里且非终态：回 `request_active`（可重试）。
2. 第 7 步的 `closeStopFenceRunnerTabs`（checkpoint 未上报不关，规则相同）。
3. 第 8 步的三步释放，`method: 'stop_fence_operator_confirmed'`，`stopFenceClosure.proofStatus: 'operator_confirmed'`。
4. 回执：锁已释放为 `local_release_done`；本来就没有绑定 R 的锁为 `local_lock_absent`；其它为对应的可重试原因。服务端 3 分钟后重发，24 小时后过期。

这样人工确认之后，节点下一次领任务时不会再遇到绑定 R 的旧锁：否则 `readActiveCaptureExecutionLockUnsafe` 会走 `removeStaleCaptureExecutionLock → stopPreviousUnattendedCaptureForResume`（约 11207–11256），也就是当初失败的那次停止；再失败时锁保留，每次领取都以 `CAPTURE_LOCK_CONFLICT` 收尾。

### 核对路径禁止调用

核对与仅释放路径里绝不调用下列函数，测试用 spy 锁定：

- `chrome.tabs.reload`、`chrome.tabs.update`、`chrome.tabs.discard`
- `relayToContentWithRetry`：会重注入、刷新，并在 finally 里清进度。
- `sendContentMessageWithTimeout`：带 `captureRequestId` 时会抹掉在途 relay 的心跳记录。
- `stopUnattendedCaptureTargetsForRecovery`、`stopPreviousUnattendedCaptureForResume`、`reloadUnattendedCaptureTabAndConfirm`
- `readActiveCaptureExecutionLock`、`removeStaleCaptureExecutionLock`
- `ensureContentScriptReady`、`waitForContentScriptReady`、`cancelTimedOutContentCapture`
- `releaseUnattendedCaptureTaskResourcesForRecovery`
- `isCaptureExecutionLockOwnedByUnattendedAttempt`（用于认锁时）
- `retryUnattendedLocalClosureCleanup`：它的停止步骤带刷新。

另外两条限制：

- 任何 `cancelCapture` 必须带非空 `captureRequestId`。`content-v2.js` 对空 id 的取消会停掉页面上的一切（约 2181–2226）。
- 除 R 已终态轮次的 runner 页外，不直接关闭任何页面。

## 旧扩展（0.4.14 / 0.4.15）

- **它们会怎样处理未知指令。** 调查结论（`background.js` 约 7050–7058；0.4.14 的 `3043c9c` 同一位置逐行相同）：`create`/`stop`/`resume` 以外的 `command_type`，一律以 `success:false, accepted:false, reason:'unsupported_command', message:'当前扩展版本不支持该远程指令'` 完成，本机无任何副作用，也不延期。心跳响应里不认识的字段直接忽略，只读取具名字段（约 7547–7612）。
- **本设计里它们收不到任何东西。**
  - 核对请求不是指令。
  - 服务端只对本次心跳上报了 `previousCaptureStopCheckV1 === true` 的节点下发 `stopFenceChecks`（含仅释放项），后台「让节点重新核对」也按已存能力拒绝旧节点。
  - 即使旧节点在同一租户里和新节点混跑，服务端也不会误把 `unsupported_command` 当作“节点拒绝”：这条路径根本不存在。
- **不会自动给旧节点发 `stop`。** 旧扩展对 `needs_action` 请求的停止回 `accepted:true 'canceled'`，并不确认页面已停（约 10762–10774）；对非当前请求回 `already_terminal`；对 `superseded` 任务还会取消已转交的执行链并触发恢复意图停止。
- **旧节点的放行路径只有人工确认。** 后台在该节点上明确显示“该节点扩展为 0.4.x，不支持自动核对；请到这台电脑检查：关闭或刷新所有小红书、抖音、微博采集页（最稳妥是重启 Chrome）后，点「确认旧页面已停止」；升级到 0.4.16 后系统会自动核对”。「让节点重新核对」置灰，悬停时提示同样的内容。值守事件按 `high` 告警。
- **人工确认后旧节点本机的锁**：照 0.4.15 的方式处理（见「已知风险」第 5 条），所以提示里建议重启 Chrome。
- **升级建议（写进发布说明）。** 给当前被挡住的节点升级时，人本来就在这台电脑前：重载扩展后**重启 Chrome**。重启后本次加载标识为 `browser_startup`，所有平台页都能被检查，0.4.16 的第一次核对就能凭 `content_idle`、`content_absent` 或 `tab_closed` 通过，不必人工确认。只重载扩展而不重启时，重载前打开的平台页会被判为 `old_document_uninspectable`，需要关闭或刷新它们。

## 管理端

依据仍是 `/overview` 的 `agents[].stop_fence`，`phase` 由服务端算好，管理端不自行推断围栏或阶段。

- **新增 `web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs` 与 `.d.mts`**，只放纯函数：
  - `agentStopFenceNotice(agent, now = Date.now())` 返回 `null` 或 `{phase, headline, detail, guidance, sinceLabel, elapsedLabel, pendingTabs, canRecheck, recheckHint, canConfirm, supersededTasks, actionTasks, manualOnlyTasks}`。`now` 放在默认参数里，避免 react-hooks purity 报错。
  - `phase` 到文案（headline 前缀都是“旧采集页面未确认停止 · ”，`local_release_pending` 除外）：

    | phase | headline | 指引 |
    |---|---|---|
    | `task_action_required` | 请处理该任务 | 在任务或批次里点「继续」或「停止」 |
    | `manual_only` | 需人工确认 | 版本不支持自动核对，或任务无法定位本机记录；到该电脑检查后点「确认旧页面已停止」 |
    | `auto_check_disabled` | 自动核对已关闭 | 到该电脑检查后点「确认旧页面已停止」 |
    | `offline` | 节点上线后自动核对 | 长时间离线请检查该电脑，或检查后人工确认 |
    | `heartbeat_degraded` | 节点状态上报不完整 | 节点暂时收不到核对请求；检查该电脑的扩展状态，或检查后人工确认 |
    | `needs_operator` | 需要到现场处理 | 列出待处理页面（平台 · 标题 · 原因），“关闭或刷新这些页面（或重启 Chrome），系统会在 3 分钟内自动复核；也可检查后点「确认旧页面已停止」” |
    | `node_retrying` | 核对未通过，约 3 分钟后重试 | 显示原因和第几次 |
    | `node_checking` | 已请求节点核对 | – |
    | `awaiting_node` | 等待节点核对 | – |
    | `local_release_pending` | 已人工确认，等待节点释放本机执行锁 | `local_release_holds_new_work` 为真时「节点释放本机执行锁后开始接单」，否则「不影响派发」 |

  - `formatStopFenceElapsed(ms)`：输出“已等待 14 小时 / 2 天 3 小时”。不复用 `formatDate`，它超过 24 小时就退化成日期。
  - `stopFenceReasonLabel(reason)`：上文原因码到后台文案的映射。
  - `isExecutionStopFenced(executionId, agents)`：按 `stop_fence.tasks[].id` 判断。
  - 配套单测 `tests/admin-stop-fence-presentation.test.mjs`。
- **`lib.ts` / `types.ts`**：`CloudAgent` 和 `OrchestrationCloudAgent` 加可选的 `stop_fence`。**不改** `agentAssignmentBlockReason` 和 `agentTaskTypeBlockReason`，保持“可分配，排在后面”。
- **新增 `StopFencePanel.tsx`**：只导出组件，满足 react-refresh。内含 `StopFencePanel` 和 `ReleaseStopFenceDialog`，用 Radix Dialog；AgentRail 禁止 `window.confirm`（`cloud-task-center-wiring.test.mjs:211`）。
  - **面板**：琥珀色、`role="alert"`，放在 `AgentDetailPane` 的 `last_error` / `blockReason` 之后（约 539–540）。`needs_operator`、`manual_only`、`auto_check_disabled`、`heartbeat_degraded` 用红色强调。
    - 说明文案：“关键词已转给其它节点。为防止同一浏览器里两条采集同时运行，在确认旧采集页面已停止前，暂不向该节点派发新任务。”
    - 列出每个任务：标题、平台、自何时起、状态、节点核对结果。有 `parent_task_id` 的，给「查看批次」链接，调用 DispatchPage 现有的 `setSelectedOrchestrationId`。
    - `task_action_required` 的任务写“该任务仍待处理，请在任务或批次里点「继续」或「停止」；停止或接力后本节点即可继续接单或进入自动核对”。
    - 按钮一「让节点重新核对」：以下情况置灰——`!writable`（提示“当前账号为只读权限”）、`manual_only`（提示升级说明）、`auto_check_disabled`、`node_checking`。离线时文案改为“节点上线后核对”。
    - 按钮二「确认旧页面已停止」：`!writable` 时置灰，打开对话框。
    - 两个按钮对手机节点（`isMobileAgent`）都隐藏。
  - **对话框**：
    - 标题「确认旧页面已停止」。
    - 列出节点名、待确认任务，以及最近一次核对列出的待处理页面。
    - 风险说明三条：“请先到这台电脑检查：没有仍在自动搜索或滚动的小红书、抖音、微博采集页（可直接关闭或刷新，最稳妥是重启 Chrome）”；“确认后系统立即恢复向该节点派发任务；如果旧页面仍在运行，同一浏览器里会有两条采集同时操作同一账号，可能触发平台风控”；“操作人和时间会记入任务事件与审计日志”。
    - 必勾选项“我已在该电脑检查，旧采集页面已停止或已关闭”，另有可选备注。勾选后「确认放行」才可点。
    - 错误留在对话框内显示，与 `RetireAgentDialog`（约 318–402）相同。
- **`AgentRail.tsx`**：
  - `AgentRow`（约 109–124）：名字旁加琥珀色 `ShieldAlert`（需人工的阶段用红色），状态行下加一行“待确认停止 · 暂不派新任务 · 已等待 X”，需人工时改为“待确认停止 · 需人工处理 · 已等待 X”。不用“暂停”，它已经表示节点状态 `paused`。
  - 头部（约 774）追加“ · 待确认停止 N”。
  - 「分配任务」保持可用，提示“分配后会排队，确认旧页面已停止后执行”。
- **`DispatchPage.tsx`**：
  - 在 `deleteAgent`、`retireAgent` 旁边（约 513–570）新增 `recheckStopFence(agent)` 和 `confirmStopFence(agent, expectedTaskIds, note)`。写法照现有：`agentActionId` → `api.post` → `setFeedback(result.message)` → `await load(true)`，并 rethrow 给对话框显示。
  - `onCreated`（约 749–753）保留服务端的“已排队”文案，不再覆盖成通用文案。
- **`AgentPicker.tsx`**：有 `stop_fence`（`local_release_pending` 除外）时，把离线提示（约 99–101）换成琥珀色的“等待确认旧页面已停止（已等待 X）；分配后会排队，确认后执行”。排序放在可用的在线节点之后（约 36–42），仍可选。
- **`OrchestrationComposerDrawer.tsx`**（约 1776–1791）：有围栏时，把“当前无执行任务 · 空闲时可领取”换成“暂不领取：等待确认旧页面已停止”。
- **`OrchestrationDetailWorkspace.tsx`**：
  - Agent 团队卡（约 2126–2145）中，`isExecutionStopFenced` 的执行：状态标签改为琥珀色“已转交 · 旧页面未确认停止”，下方注明“该节点暂不接单（自 20:41，已等待 X），请在「执行节点」中处理”。
  - `keywordRetryCandidates`（约 503–513）和 `handoffCandidates`（约 701–714）排除有围栏的节点。
  - 自动恢复面板无可用节点时，补一句“N 个节点等待确认旧页面已停止”。
  - 现有测试匹配的 `executionStatus(execution) === 'superseded'` 等写法保持不变。
- **值守总览**：见上文「值守总览与告警」，`OverviewPage.tsx` 与 `MobileApp.tsx` 各加一项计数和一条事件文案。
- **可选**：`OrchestrationResultReport.tsx:91-93` 和 `TaskCard.tsx:324` 把 `HISTORICAL_STOP_FENCE_RECONCILED` 显示为“旧页面停止已确认（节点核对 / 人工确认 / 后续采集）”。

## 版本与更新说明

照 0.4.15 的做法：

- `manifest.json`：0.4.16。
- `server/routes/update-manifest.js`：`latestVersion: '0.4.16'`，`releaseDate` 和下载名 `StarVoice-extension-v0.4.16-<日期>.zip` 用实际打包日期，`minSupportedVersion` 不变。0.4.16 说明两条，定稿时须与最终代码一致：
  - 旧采集页面停止后自动放行：节点因“旧采集页面未能安全停止”暂停接单时，系统会请节点核对旧页面，确认已停止后自动恢复接单。核对不刷新任何页面，最多对仍只跑着旧采集的页面发送精确停止信号，并关闭该任务自己的运行页；核对不通过时后台会说明原因和需要处理的页面。
  - 扩展重载或升级前打开的平台页面无法自动确认：升级后请重启 Chrome；否则需要在该电脑关闭或刷新这些页面后由系统再核对，或由管理员在后台点「确认旧页面已停止」。
- `server/public/about.html`：新增 0.4.16 条目，「最新」标记移到 0.4.16。
- `server/services/ops-control.js`：`OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.4.16'`。
- `tests/update-manifest.test.mjs`：同步检查两条说明的要点，且说明里不出现“刷新旧页面”“自动刷新”一类与实现相反的说法。
- 用 `scripts/sync-extension-build.zsh production` 同步 `extension-build/`，再用 `scripts/package-extension.zsh` 打包，并记录 SHA-256。包内 `background.js`、`content-v2.js`、`utils/cloud-task-agent.js`、`manifest.json` 须与源码逐字节一致。

## 测试

新增和修改的测试。已有测试不改断言：

- **服务端纯函数** `tests/capture-stop-fence.test.mjs`：
  - `normalizeStopFenceCheckResult` 的白名单和上限。
  - `evaluateStopFenceProof` 的逐项反例：每个“否”的 evidence、`requiresOperator`、`pendingTabIds`、`localLockBoundToRequest`、`requestActive`、`sweepComplete:false`、`unresolvedTabCount > 0`、`relayInFlightCount > 0`、内容类证据配 `before_runtime`、`mode:'release_only'`、版本或标识不符、旧版停止回执的形状。
  - `stopFenceCheckEscalated`：第 3 次失败、首轮满 30 分钟、`requiresOperator` 各自触发；重新核对后清零。
  - `summarizeAgentStopFence` 的 10 种 `phase` 与优先级。
- **`tests/server-capture-cloud-contract.test.mjs`**：执行槽判定多了 `reason` 列；围栏 SQL 文本与基线逐字一致（锁定不变量 1）。
- **新增 PostgreSQL 集成测试** `tests/integration/postgres/stop-fence-closure.integration.mjs`，参照 `historical-stop-fence.integration.mjs`。覆盖：
  1. 有能力的节点心跳，对 `superseded` 围栏行返回 1 条 `stopFenceChecks`：写 `metadata.stopFenceCheck` 和事件，`updated_at` 不变。5 分钟内再心跳，`checkId` 相同，无新写入、无新事件。
  2. 0.4.15 能力的节点、`taskStateKnown:false`、应急开关关闭：无下发、无写入。
  3. 有效回执：`error.code` 为 `HISTORICAL_STOP_FENCE_RECONCILED`，`originalCode` 与原文案保留；`historicalStopFenceReconciliation.proofStatus = 'agent_confirmed'`；事件存在；状态仍为 `superseded`；执行槽判定为空；下一次心跳领到弹性工作项，或收到排队的创建指令；有等待中的恢复意图时写入唤醒。
  4. 无效回执：`checkId` 错误或过期返回 409；其它节点或租户返回 404；`requestId` 不符返回 409；`accepted:true` 但带非证明证据时记为 `proof_rejected`，围栏保留；`requiresOperator` 被记录；原因不变时不重复写事件；结构不合法时先记 `invalid_result` 再返回 400。
  5. 未通过与过期：3 分钟内不下发，到期换新 `checkId`；过期未答同样计一次失败；第 3 次失败写 `escalatedAt` 和一次 `stop_fence_check_escalated`；首轮满 30 分钟同样升级。
  6. 已放行后再收到回执：幂等。
  7. 人工确认：写先例格式记录（`operator_confirmed`）和 `audit_logs`；`expectedTaskIds` 不含新围栏时返回 409；只读角色返回 403；缺确认串返回 400；`needs_action` 围栏行不动，并在 `requiresTaskAction` 里列出。0.4.16 节点写 `localRelease.state='pending'`，下一次心跳收到 `mode:'release_only'`，回执后为 `done`；旧节点不写 `localRelease`；24 小时未答置 `expired`。
  8. 重新核对：换新 `checkId`、清零失败和升级，旧 `checkId` 的回执返回 409；无能力、开关关闭返回 409；离线返回 200 和对应文案。
  9. `needs_action` 围栏任务从不下发，也不会被回执或人工确认放行。
  10. 弹性接力命中围栏时写 `stop_fence_handoff`；未命中时不写。
  11. 概览 `agents[].stop_fence` 的字段和 `phase`：包括 `auto_check_disabled`、`heartbeat_degraded`（`taskStateKnown=false`）、`manual_only`（`requestId` 为空）；无围栏节点为 `null`；`976a0c6` 已放行的行不出现。
  12. 手动下发的 `queueBlocker.reason` 和文案；重试候选排除有围栏的节点。
  13. 放行后，节点心跳里带旧错误码的快照不会重新立起围栏（`superseded` 行忽略快照）。
  14. 预检：带 `recoveryTaskId` 的围栏码行不命中、不开第二个事务；`976a0c6` 已隐式放行的行被补写 `proofStatus:'completed'` 记录一次，此后预检为假。
  15. `requestId` 为空的围栏行不下发。
  16. 值守：`collectOpsControlEvidence` 带出 `stopFences`；满 30 分钟产生 `capture_agent_stop_fence_blocked`，需人工阶段为 `high`；`stopFenceBlockedAgentCount` 正确；`sourceClosureBlockedCount` 仍为 0。
- **`tests/keyword-node-coverage.test.mjs` 与 `keyword-account-coverage.integration.mjs`**：带围栏的子任务保留原码，加 `coverageReason`；不带围栏的行为不变；新增原因 `keyword_node_stop_fenced`。
- **扩展**：新文件 `tests/background-stop-fence-check.test.mjs`，沿用 `tests/background-capture-lock.test.mjs` 的真实 `background.js` 加假 chrome 的写法；如果 harness 不便复用，就放进该文件。假 chrome 需补 `scripting.executeScript`、`storage.session`、`tabs.discarded/frozen/status`、`runtime.getContexts`、`onStartup`/`onInstalled`。场景：
  1. R 在请求槽里运行中：回 `request_active`，零副作用。
  2. 平台页文档早于本次加载（`extension_load` 标识）：回 `old_document_uninspectable`、`requiresOperator`、`pendingTabIds`，零关闭、零取消；即使该页内容脚本回报空闲也一样（同一加载期写的围栏也一样）。
  3. `browser_startup` 标识下，所有文档都通过年龄门槛，按内容查询判定。
  4. 晚于本次加载的文档：内容空闲放行；“Receiving end does not exist” 在 R 在途中继为 0 时放行；超时、`status==='loading'` 为 `probe_failed`。
  5. 页面上只有 R 的 id（C，或登记表归属 R 的其它 id）：先打中止标记，再发带非空 id 的取消，归零后放行；5 秒未归零回 `capture_still_active`。
  6. 页面上 R 的 id 与别的 id 混在一起：`tab_busy_unattributed`，不发取消。存活锁持有文档发起的中继能解释全部 id 时判 `unrelated_live_capture`；有一个 id 无法追溯（例如 SW 重启后登记表为空）就是 `tab_busy_unattributed`。
  7. R 名下有在途中继（含不带 id 的 `applyBatchSearchFilters`）：等待不归零时回 `capture_still_active`，不关 runner、不释放。
  8. 两阶段：阶段一有一页不成立时 runner 不关；阶段一通过后关 R 的精确轮次 runner 并复扫；checkpoint 未上报时不关 runner；R 的不认识轮次的 runner 回 `source_identity_unverifiable`；关闭前请求槽变为 R 的新轮次时回 `request_changed`。
  9. 认锁：`captureTaskId` 为稳定 taskId 或与围栏记录的锁身份完全一致才释放；轮次 id 相同但任务 id 不同的锁、持有页 id 碰巧等于旧 runner 的预留锁都不动；持有文档存活时回 `lock_holder_alive`；请求槽有非终态请求时不释放。
  10. 释放：按精确身份释放指向 `previousAttemptId` 的锁；停止确认依次写到 `source_stopped` 和 `runtime_released`；状态仍为 `needs_action`；采集辅助经 `releaseResidualUnattendedCaptureAssist` 回收，前台页和存活请求的页面不被关闭。
  11. 关闭、丢弃、冻结的页面；离开站点首次观察与满 10 分钟两种情况；裸域平台页不属于扫描范围，但归属页跳到裸域按离开站点处理。
  12. R 在本机未知：全量扫描规则不变；锁只在严格绑定 R 时释放。
  13. 仅释放：不发取消、不查内容脚本；关 runner、按精确身份释放锁、回收采集辅助；R 运行中回 `request_active`。
  14. 每个场景都断言：`chrome.tabs.reload`、`update`、`discard` 调用 0 次；「禁止调用」清单里的函数调用 0 次；没有空 id 的 `cancelCapture`；只关闭了 R 已终态轮次的 runner 页。
  15. 按 `checkId` 去重、单飞、45 秒截止（截止时回报已查与未决页面）；回执 400、403、404、409 时丢弃，5xx 与网络错误保留重发；`released:true` 后补一次心跳。
  16. 三个围栏写入点写了 `stopFenceEvidence`，其余字段和返回值与 0.4.15 相同。
  17. 在途中继登记：`relay-to-content` 按 `sender` 登记，内部取消中继标 `internal`，`finally` 后条目消失；中继行为与 0.4.15 相同。
  18. `tests/cloud-task-agent.test.mjs`（约 1049）：能力里有 `previousCaptureStopCheckV1: true`；`completeStopFenceCheck` 的请求形状正确。
  19. `content-v2.js` 的 `inspectCaptureActivity` 返回 `targetCount` 与 `activeRequests`。
- **管理端**：`tests/admin-stop-fence-presentation.test.mjs` 覆盖 10 种 `phase` 的文案、按钮可用性和时长格式。`tests/cloud-task-center-wiring.test.mjs` 增加断言：
  - AgentRail 用 `ReleaseStopFenceDialog`，不含 `window.confirm`。
  - DispatchPage 调用 `/stop-fence/recheck` 和 `/stop-fence/confirm`。
  - `agentAssignmentBlockReason` 不引用 `stop_fence`。
  - `OverviewPage.tsx` 与 `MobileApp.tsx` 读取 `stopFenceBlockedAgentCount` 和 `capture_agent_stop_fence_blocked`。
- **反向验证**：在临时副本里逐一去掉关键守卫，确认对应测试失败。要去掉的守卫：
  - `status='superseded'` 条件
  - `checkId` 比对
  - 不更新 `updated_at`
  - 扩展的请求运行中守卫
  - 文档年龄门槛
  - 混合活动不发取消、无法追溯不算无关
  - R 在途中继归零等待
  - 严格认锁（换回 `isCaptureExecutionLockOwnedByUnattendedAttempt`）
  - checkpoint 未上报不关 runner
  - 升级规则
- **运行方式**：
  - 按生产环境用 Node 18 跑，路径为 `/Users/dulaidila/.nvm/versions/node/v18.20.8/bin/node`。
  - 服务端依赖加载失败时，用 `…/scratchpad/hotfix/` 下的只读解析垫片。
  - 完整回归要与基线 `f069fd7` 逐项比对失败名单。
  - Admin 的 lint 和 `tsc -b && vite build` 只能在 CI 或临时目录 `npm ci` 后验证：工作区的 `web/admin/node_modules` 指向空目录。

## 上线顺序

1. **合入前**：按「建议的提交拆分」提交（覆盖修复、版本发布各单独一个提交），CI 通过（本地已按「验收数据」逐项比对基线，Admin 的 lint 与 `tsc -b && vite build` 以 CI 为准）。确认生产上要替换的服务端文件和 Admin `index.html` 与 `68c32ba` 逐字节一致。
2. **第一次发布：服务端 + Admin，不发版本。** 不含覆盖修复（`keyword-node-coverage.js` 保持基线），也不含版本发布（`update-manifest.js`、`about.html`、`ops-control.js` 的基线版本号与扩展 `manifest.json` 保持 0.4.15）：生产继续宣告 0.4.15，0.4.16 只在试点节点上手动加载已构建的安装包。
   - 为什么可以先发服务端：所有新行为都由本次心跳声明的 `previousCaptureStopCheckV1` 门控。此时节点都是 0.4.14/0.4.15，心跳不带该能力，所以服务端不下发 `stopFenceChecks`、不做人工确认后的派发暂停、不开第二个事务，派发与现在完全相同；人工确认对旧节点也不生成 `localRelease`。上线前核验（临时库、真实路由、26 步场景）逐项比对了 0.4.14/0.4.15 节点的心跳、派发、停止、恢复、巡查，与 `f069fd7` 一致。
   - 发布后立刻可见的变化：后台节点面板写明被挡原因和两个按钮；值守总览出现「待确认停止」计数，已挡满 30 分钟的节点产生 `capture_agent_stop_fence_blocked`（旧节点处于 `manual_only`，按 high 走告警邮件，这是预期的“通知到人”）；「确认旧页面已停止」对所有节点可用；手动下发和接力写明围栏原因。
   - 生产实测（2026-09-25，7344 条任务，只读 `EXPLAIN ANALYZE`）：0.4.16 节点每次心跳的预检约 20 ms；租户级围栏列表约 255 ms（`/overview` 走 reporting 闸口、值守至多每 25 秒一次）。围栏判定 SQL 本身约 275 ms（线上已有，领取时执行）。因此**重试候选不做围栏排除**（批次详情每 5 秒轮询、走 general 闸口，代价过高；后台已按 `/overview` 的 `stop_fence` 隐藏被挡节点）。
   - 发布后核对：`/api/update-manifest` 仍为 0.4.15；服务健康检查通过；错误日志中 `DB_CAPACITY_UNAVAILABLE` 增速与发布前同量级；旧节点心跳响应里没有 `stopFenceChecks` 字段；值守总览的 0.4.16 试点节点会被计为低于基线（预期，版本发布后恢复）。
3. **现有被挡节点**：可以人工确认（建议先在该电脑重启 Chrome；旧节点确认后本机锁仍按 0.4.15 处理），也可以等它升级后自动核对。
4. **先在一台空闲节点上装 0.4.16**：加载新包、重载扩展，然后**重启 Chrome**（重启后本次加载标识为 `browser_startup`，所有平台页都可检查）。
   - 确认它声明了能力：后台该节点有围栏时「让节点重新核对」可点、面板不再提示升级；或只读查询 `capture_agents.capabilities->>'previousCaptureStopCheckV1' = 'true'`。
   - 确认日常派发不受影响：没有围栏时照常领任务，心跳响应的 `stopFenceChecks` 为空数组。
   - **验证闭环（被挡节点会被主动询问，确认后自动放行）**：在这台节点上出现围栏时（自然发生，或在测试批次里运行中关掉 runner 页，让自动恢复以 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 收尾、关键词被接力），按时间顺序应看到：原任务事件 `stop_fence_handoff` →（下一次完整心跳，约 1 分钟）`stop_fence_check_requested` → 数分钟内 `historical_stop_fence_reconciled`，`payload.proofStatus = 'agent_confirmed'` → 该节点下一次心跳就领到任务。旧页面停在浏览器错误页或已离开平台时，要连续观察满 10 分钟，约 10–16 分钟放行，期间后台显示「核对未通过，约 3 分钟后重试」和原因，不会升级为「需要到现场处理」。
   - **验证后台说明与按钮**：围栏存在期间，节点列表显示「待确认停止 · 暂不派新任务 · 已等待 X」，面板显示原因（阶段文案、最近一次核对结果、待处理页面）和「让节点重新核对」「确认旧页面已停止」两个按钮；构造一次“只重载扩展不重启 Chrome”，应显示「需要到现场处理」并列出页面，刷新或关闭这些页面后 3 分钟内自动放行。
   - **验证人工确认路径**：对这台 0.4.16 节点点「确认旧页面已停止」，返回文案应含“节点会在下次心跳时释放本机执行锁，释放后恢复接单”；下一次心跳出现 `stop_fence_local_release_done`，随后领到任务；其间节点列表显示「已人工确认 · 等待节点释放本机执行锁」。
   - 节点诊断里没有核对路径的刷新记录。
5. **版本发布**：试点节点稳定后发布版本提交（`manifest.json`、`update-manifest.js`、`about.html`、`ops-control.js` 基线 → 0.4.16），重新打包并核对 SHA-256，然后**逐台铺开 0.4.16**（重载扩展后重启 Chrome），成都等多窗口机器放在最后。
6. **第二次发布：覆盖修复（提交 2）。** 条件是参与 each_agent 批次的节点在后台都显示支持自动核对。这样按节点覆盖不再无证据放行之后，产生的围栏都能自动核对，而不是全部落到人工确认上。

## 回滚

- **服务端和 Admin**：用发布目录里备份的文件覆盖回去，再 `pm2 restart onstarvoice`。
  - 已放行的行不回滚：它们与 09-24/25 手工放行同格式，并有事件和审计。
  - 新增的 `metadata.stopFenceCheck` 旧代码不读，无害。
  - 旧代码不再产生 `capture_agent_stop_fence_blocked`，已开的该类事件按现有逻辑在下一轮不再出现时关闭。
  - 旧服务端不再下发，0.4.16 节点也就不核对。回执路由不存在（404）时，扩展标记完成并丢弃。
- **只关闭自动核对**：设 `CAPTURE_STOP_FENCE_AUTO_CHECK=off`，再 `pm2 restart`。两种下发（核对、仅释放）和人工确认后的派发暂停同时停止；人工确认、展示和告警不受影响，后台显示“自动核对已关闭”，此时人工确认不再生成 `localRelease`，文案会提示必要时重启 Chrome。
- **扩展**：节点改回加载 0.4.15 包，再重载。能力消失，服务端停止下发，也不再对它做人工确认后的派发暂停，未答的核对自然过期；后台显示“需人工确认”。已生成但没人回答的 `localRelease` 留在任务 metadata 里，24 小时后不再列出，无害。本地新增的 `stopFenceEvidence`、`stopFenceClosure`、`onstarvoice.stopFenceChecks` 和 `onstarvoice.runtimeEpoch`，0.4.15 不读，无害。
- **覆盖修复**：是单独的提交和单独的发布，可以单独 revert。revert 后回到“按节点覆盖会无证据放行”的原行为。

## 已知风险与本次不做

已知风险：

1. **证据由扩展自报。** 服务端只能校验回执自洽、与本轮下发绑定，并把证据存档供审计。这与现有弹性接力信任本地收口证据的方式一致（`capture-local-closure-proof.js` 约 212–247）。
2. **往返缓存。** `navigated_off_platform` 要求连续离开站点满 10 分钟，已覆盖 Chrome 往返缓存的时长。对没有记录归属的页面，无法知道它此前是否是平台页，这是残余窗口：需要有人在这 10 分钟内按「后退」。
3. **时钟。** 文档时间与本次加载时间都取本机时钟，并留 2 秒余量。核对期间如果时钟被大幅回拨，可能误判。服务端时间不参与比较。
4. **内容脚本里不计数的处理函数。** `applyBatchSearchFilters` 等不带 `captureRequestId` 的动作不计入 `activeCount`。SW 一侧已等 R 名下的这类中继归零；但中继超时返回后，页面里的处理函数可能还会再跑几秒。它们是一次性动作，不会持续采集。
5. **旧节点人工确认后本机的锁。** 0.4.14/0.4.15 节点被人工确认后，本机指向 R 的执行锁仍按 0.4.15 的方式处理：下一次 `readActiveCaptureExecutionLock` 会走带刷新的清理（约 11207–11257），失败时锁保留、领到的任务以执行锁冲突收尾。所以对旧节点的提示里建议先重启 Chrome。0.4.16 节点由仅释放项处理，不经过这条路径。
6. **后台「停止」也会无证据放行。** 对 `needs_action` 围栏任务点「停止」，旧扩展和新扩展都会回 `accepted:true 'canceled'` 并释放锁，任务变为 `canceled` 后不再命中围栏，并不证明页面已停。这是现有行为，本次不改，只在面板文案里说明“停止即放弃该任务”。
7. **早于本次加载的平台页一律需要人工。** 这是有意的保守：新加载的内容脚本无法区分同一文档里是否还有旧脚本在滚动。代价是只重载扩展、不重启 Chrome 的节点，第一次围栏往往需要现场关闭或刷新页面。发布说明和后台提示都写明“升级后重启 Chrome”。
8. **冻结和卡住的页面。** 这类页面会反复得到 `tab_frozen` 或 `probe_failed`，3 轮后升级为需人工处理并告警，不会被放行，也不会无声卡住。停在浏览器错误页的页面不在此列：按离站观察满 10 分钟后自动证明（决策表 8a），约 10–16 分钟放行；观察轮次不计失败，只有观察满 30 分钟仍未放行才升级。
9. **值守窗口。** 值守观察只在配置的窗口内运行，窗口外的围栏只在后台节点面板里可见。
10. **人工确认后的派发暂停有上限，也有两处已知缺口。** 暂停最多到首次下发后 10 分钟，从未下发的最多到确认后 1 小时，之后节点照常领任务，与 0.4.15 相同（最坏情况是新任务以 `CAPTURE_LOCK_CONFLICT` 收尾）。缺口一：节点离开超过 1 小时、回来的第一次心跳里下发事务恰好失败（500 ms 锁等待或超时），第二次心跳可能同时带新任务和第一个 `release_only`。缺口二：一次确认超过 3 行、过了 1 小时仍有行没下发时，这些行会和新任务同一次心跳下发。两处都由扩展“`release_only` 先于本轮指令执行（最多等 15 秒）”和本机执行锁本身兜住。彻底堵住要么暂停到 24 小时过期（下发一直失败时节点会被挡一天，正是本次要解决的问题），要么在心跳主事务里写入（有锁顺序风险），本次都不做。
11. **节点离线超过 24 小时期间被人工确认。** `localRelease` 在下发前就过期，节点回来时不再收到 `release_only`，按 0.4.15 的方式处理本机锁。要改需另定 TTL 规则（例如从首次下发起算）。
12. **暂停期间只有后台节点面板和确认、下发文案会说明。** 值守总览的「待确认停止」计数和告警不包含处于派发暂停的节点：暂停最长约 1 小时，而告警要围栏满 30 分钟才发，计入会对刚确认的节点误报。
13. **浏览器重启后标签页 id 复用。** 离站观察记录按标签页 id 保存 24 小时；重启前的记录理论上可能匹配到新页面，让新页面跳过 10 分钟观察。往返缓存不跨重启，旧任务已终态、中继已中止，风险低。
14. **Admin 的 lint 与构建。** 本地是在 scratch 副本里用同一 `package-lock.json` 的依赖跑通的（工作区的 `web/admin/node_modules` 指向空目录），以 CI 为准。

本次不做：

- 新 `command_type` 或迁移。
- 按时间自动放行。
- 对 `needs_action` 等非 `superseded` 围栏做自动核对或放行。
- 恢复路径把 `captureRequestId` 传入停止目标，以减少围栏产生。
- 扩展上下文失效时，内容脚本自行停止采集（`content-v2.js` 约 98–121 处 `setCancelFlag`），让以后重载前的页面也能自证。
- 邮件以外的推送通知：`capture_attention_notifications.notification_type` 的 CHECK 只允许 `security_verification`，需要迁移。本次告警走值守事件。
- 节点侧在现场处理后主动请求复核：统一 3 分钟重发已足够。
- 在节点侧栏显示需人工处理的提示。

## 建议的提交拆分

1. `server`：`capture-stop-fence.js`、心跳下发（含 `976a0c6` 补写和仅释放项）、回执、后台两个接口、概览字段与 `phase`、原因展示、接力事件。
2. `server`：关键词节点覆盖不再无证据放行（单独提交，单独发布，可单独回滚）。
3. `extension 0.4.16`：本次加载标识、在途中继登记表、围栏证据、核对与仅释放流程、能力、`content-v2.js` 的 `targetCount` 与 `activeRequests`。
4. `admin`：展示函数、面板与对话框、节点列表、选择器、批次详情、值守总览计数。
5. `server`：值守事件 `capture_agent_stop_fence_blocked` 与 `stopFenceBlockedAgentCount`；版本与更新说明；本文档的实现结果和验证数据。

`manifest.json` 的版本号必须和版本发布（`update-manifest.js`、`about.html`、`tests/update-manifest.test.mjs`、`OPS_CONTROL_RUNTIME_BASELINE_VERSION`）放在同一个提交里：`tests/update-manifest.test.mjs` 要求 `manifest.version` 等于 `latestVersion`。如果先提交 0.4.16 的 `manifest.json`，却保留 0.4.15 的更新说明，`npm --prefix server test` 会失败。如果先发服务端和 Admin、暂不发布 0.4.16，这个提交里的 `manifest.json` 保持 0.4.15。灰度节点手动加载已打好的 0.4.16 安装包（SHA-256 见「安装包」）。不要从这个提交重新打包。
