# Android 手机发现 hotfix：openCard 详情等待、领取前置检查与任务隔离（20260924）

分支：`codex/hotfix-douyin-android-opencard-20260924`。基线：`6c9f00d`（含 0.4.14 合并候选 `3043c9c`，生产 Runner 版本 `0.2.0-3043c9c`）。本轮只改独立 Android Runner（`runners/android/`）及其文档，不改服务端、Extension 与数据库；未连接生产手机重试，未改生产任务状态，未推送、未部署。

## 现象（生产 2026-09-24，UTC）

- 本机 Runner `state-829d89/runner.sqlite` 只读核对：09:58:00、09:58:14、09:58:31、09:58:46、09:59:02 五个**不同**新任务各在约 4.5 秒内以 `douyin_not_foreground` 结束，`cards=0`；期间 Runner、Appium 均在线，心跳正常。
- 10:01:10（昂科威壁纸）、10:20:01（安吉星车机壁纸）分别在 2 张卡片、1 个链接后 `device_timeout`；10:21:52（安吉星壁纸）打开第 1 张卡片后 `device_timeout`，0 个链接。停稳日志最后一次未完成动作均为 `openCard`。同一时段 昂科威PLUS壁纸（15 链接）、别克壁纸（9 链接）正常完成。
- 手机实际已进入 `com.ss.android.ugc.aweme/.detail.ultra.ui.UltraDetailActivity`，说明点击成功、详情已打开。

## 根因（代码级确认）

1. **详情等待被固定 15 秒截断，并折叠为 `device_timeout`。** `readVerifiedDetail()` 用 `ui.waitFor(tree => !!readDetail(tree))` 等待详情；`waitFor` 底层 `bounded()` 上限 15 秒，而单次层级读取在 DE106 上常需 5–7 秒（`read` 允许 10 秒），15 秒内通常只有 1–2 次读屏。作品视频/图文加载慢或详情控件晚出现时，等待在 15 秒到期，`bounded` 抛 `device_timeout` 并标记 `stopConfirmationRequired`。外层动作预算实际是 60 秒（`actionTimeoutMs`），前 45 秒被白白放弃；OperationGate 把任何错误都记为“未停稳”，触发停稳保护、关闭会话、上报 `needs_action`，操作员只能人工恢复。它与 Appium/ADB 失联、点击失败、作品身份不符共用同一个码，无法区分。
2. **领取前的就绪判断不看手机当前状态。** `profile-adapter.probe()` 只检查 ADB 在线、机型/版本和 Appium `/status`，每 30 秒缓存一次；抖音是否在前台、是否锁屏、是否息屏都不查。于是抖音退到后台时 Runner 仍以 `readyForSearch=true` 连续领取新任务，每个任务在 `inspect` 读屏时才因 `douyin_not_foreground` 失败，并留下一条 needs_action 记录（上面 5 连败即此）。
3. **`resume_authorization_required`。** 预算账本按 `discoveryRunId`+`itemId` 记账，新任务（新 UUID）不可能命中旧账本；服务端也只有显式“恢复”会带 `resumeAuthorized=true` 重派同一 item。本机 checkpoint 中所有 item 均为 `rev 1`（一个显式恢复为 `rev 2`），未保存过 `resume_authorization_required` 的结果（该错误在账本构造时抛出，不会写入 run checkpoint；`daemon:last-completion` 已被后续任务覆盖）。因此本机证据不足以判定它来自哪一次派发；能确认的是：同一 item 在**未**走“恢复”接口的情况下再次到达 Runner 才会出现该码，而服务端通用回收/改派路径已排除 `android_mobile`。本轮不改语义，改为把上一次 attempt、revision、状态与原因随错误带进完成回执，并让闭环证明只在 `operationId` 匹配时传给任务，杜绝跨任务污染；服务端 `capture_task_item_attempts.result` 中可直接看到下一次发生时的具体上下文。

## 修复

### 设备层（`runners/android/src/device/`）

- 新增 `ui-wait.mjs`：`readUntil()` 在给定预算内反复读屏，每次读屏保留原 10 秒有界，**不会启动放不下的读屏**，预算耗尽即“已停稳”返回；`pause()` 可被停止信号打断。
- 重写 `douyin-detail.mjs`：`readVerifiedDetail()` 改用上述循环，只读不点（唯一例外仍是同作者视频的“展开”控件，展开后正文必须完全匹配）。结果区分：
  - `detail_identity_unverified`：详情已加载但是另一条作品（`stage: loaded/expanded`）；
  - `card_open_failed`：点击后连续两次读到已验证的搜索结果页（且 ≥1 秒）；
  - `detail_ui_not_ready`：预算内没有出现可读详情，附带读屏次数、耗时、预算、控件计数与当前 Activity；
  - `device_timeout`/`appium_*`/`aborted`/`douyin_not_foreground` 原样上抛，仍走停稳保护。
  以上三种精确错误标记 `deviceSettled: true`：它们在最后一次读屏返回后抛出，手机上没有在途命令。
- 新增 `douyin-foreground.mjs`：解析 `dumpsys window windows`（焦点窗口）、`dumpsys activity activities`（兜底）、`dumpsys window policy`（键盘锁）、`dumpsys power`（亮/息屏）；`createForegroundGuard().ensure()` 依次确认亮屏、未锁、抖音持有焦点，否则按 `device_asleep`/`device_locked`/`douyin_not_foreground` 报告。抖音不在前台且允许拉起时，只用审核过的组件 `com.ss.android.ugc.aweme/.main.MainActivity` 发 `am start -a MAIN -c LAUNCHER -n`，不带 `-S`、不 `pm clear`、不 reset；每 60 秒最多拉起一次，拉起后轮询前台最多 10 秒，并重新核对机型/API/抖音版本与前台包名。
- `adb.mjs` 新增 `windowFocus/resumedActivity/keyguardState/powerState/launchActivity`，全部只读或显式组件启动，命令均钉死序列号；大段 dump 在手机侧 `grep` 截取。`appium.mjs`/`ui-session.mjs` 新增 `currentActivity/currentPackage` 只作诊断。
- `profile-adapter.mjs`：`probe()` 每次都执行 ADB 在线、Appium `ready`、前台守卫（机型/版本 30 秒缓存）；`inspect()` 建会话前先做一次不拉起的前台核对；`openCard()` 把外层预算传给流程；新增 `recoverResults()`。

### 校准流程（`calibration/douyin-flow.mjs`）

- `openCard()`：`results()` 校验唯一卡片 → **只点击一次** → 用 `外层预算 − 已用时间 − 展开预留 11 秒 − 安全余量 3 秒`（限 10.5–40 秒）作为详情等待预算。60 秒动作内最坏路径约 57 秒结束，不再触发 gate 超时。
- `recoverResults()`：失败打开后读当前页；若不是已验证结果页，最多按两次返回键，但**绝不在抖音首页（搜索入口可见）按返回**；回到结果页后重新打开筛选面板读回全部分组（关键词、排序、时间、其余三/四组）再关闭。任何一步不成立则 `search_context_unverified`（已停稳）。

### 核心（`core/`）

- `operation-gate.mjs`：动作回调获得 `{budgetMs}`；`deviceSettled: true` 的错误与原 `loading_failed+safeToRetry` 一样正常闭合停稳标记，其余错误照旧记为未停稳。gate 超时后再抛出的“已停稳”错误不能清除不确定状态（有测试）。
- `discovery-runner.mjs`：`openCard` 抛出 `detail_ui_not_ready`/`detail_identity_unverified`/`card_open_failed` 且已停稳时，先经 gate 调 `recoverResults` 并用 `verifyContext` 核对 contextId、关键词、筛选，成功才跳过该作品继续；每个关键词最多跳过 3 个（跨 attempt 持久）。安全返回失败时结果原因保留精确的打开失败码，`details.recovery` 记录返回失败码；停止/租约/USB 类错误原样上报；gate 超时仍保留停稳保护。完成结果带 `details`（有界、无正文/作者），经 daemon 写入完成回执 `checkpoint.failure`。
- `budget.mjs`：`skippedCards` 计数入 checkpoint 与 `summary()`；`resume_authorization_required`/`terminal_item`/`fresh_attempt_required`/`item_definition_changed` 携带上一 attempt 的 id、revision、状态、原因。校验顺序与预算哈希不变，旧 checkpoint 兼容。

### 守护进程（`daemon/runtime.mjs`）

- 空闲时**每次轮询前**都重新探测，删除 30 秒缓存；探测结果写入 `status.deviceProbe`（含前台包名/Activity、是否刚拉起、遮挡窗口名）。
- 任务以 `douyin_not_foreground`/`device_locked`/`device_asleep`/登录类/版本类原因结束时立即降级 `readyForSearch=false`，直到下一次探测通过。
- `closureProofFor()`：只有当 `daemon:closure-proof.operationId` 等于当前待确认停稳记录时才传给任务；旧证明不再随每个任务传递。
- Runner 版本 0.2.1（`setup` 注册上报同步）。

## 测试

新增 `runners/android/test/open-card-recovery.test.mjs`、`device-foreground.test.mjs`、`daemon-readiness.test.mjs`，并在 `core-control`、`core-budget` 追加用例；`device-profile` 中的详情夹具从 `waitFor` 改为 `read`，断言不变。覆盖题述要求：

| 要求 | 用例 |
| --- | --- |
| 点击成功、前两次读屏未就绪、随后成功：只点一次、正常采集 | `a detail that becomes readable after two not-ready reads…` |
| 详情已开但始终无法验证：精确错误、不误采、不再点击 | `an open detail that never verifies reports detail_ui_not_ready…`、`…lease-bounded action budget…` |
| 能安全返回时单个异常作品不终止关键词 | `one abnormal work is skipped after a proven safe return…` |
| 无法确认安全返回时保留 device closure | `an unproven safe return keeps the precise reason and the device closure protection` |
| 抖音不在前台不领取；恢复前台后才领取 | `Douyin outside the foreground blocks claiming; only a fresh passing probe…` |
| 新任务不继承 `resume_authorization_required` | `a readiness failure at inspect demotes the runner…next new run starts clean`、`resume faults name the earlier attempt…`、`a retained closure proof reaches a task only for the pending operation it names` |
| 身份不匹配、停止、租约、USB、闭环既有用例 | 原 118 项全部保留 |

结果（Node 24.12.0）：

- Runner 全套 `npm --prefix runners/android test`：143 项，串行 143/143 通过；默认并行一次出现 `expired upload window…`（60 ms 截止窗口）时序失败，与 0.4.14 发布单记录的并行时序敏感现象一致，单文件三次复跑 12/12 通过。
- 模块边界：84 个模块通过，最大 278 行（`daemon/runtime.mjs`），上限 350。
- 服务端相关：`tests/android-control-route`、`android-recovery`、`capture-discovery-runner-contract`、`capture-discovery-ui-binding` 在 Node 24 与生产同版 Node 18.20.8 各 18/18 通过（服务端代码未改，仅回归契约）。
- `node --check` 全部改动模块通过；未改动 TypeScript 模块，未运行 Admin 构建。

## 尚存风险

- 前台/锁屏解析依据 Android 8.1 通用 `dumpsys` 格式与用户提供的 Activity 记录编写，**未在 DE106 实机验证**。若锤子 OS 输出格式不同：键盘锁按“未知”处理并回退到焦点窗口判断；焦点与 `mResumedActivity` 都解析不出时，Runner 会报 `douyin_not_foreground` 并停止领取（保守），`status.deviceProbe` 会显示原因，需要用真机 dump 补一次校准。
- `com.ss.android.ugc.aweme/.main.MainActivity` 为抖音常规入口，未在 40.6.0 实机核对；若类名不存在，`am start` 报错会被识别为 `app_launch_failed`，Runner 不领取，需人工把抖音切到前台。
- 息屏后 Runner 报 `device_asleep` 且不会唤醒/解锁手机；试点手机应保持充电常亮。
- `resume_authorization_required` 的触发路径未能从本机证据定位，只补齐了诊断和隔离；下次出现请查服务端 attempt 结果中的 `failure.previousAttemptId/previousStatus`。
- 每次空闲轮询多 5–6 条 ADB/HTTP 只读命令（约 1–2 秒），对 5 秒轮询可接受，未做长时间实测。
- Appium `current_activity` 仅作诊断字段；跳过作品后不会自动重试该作品。
