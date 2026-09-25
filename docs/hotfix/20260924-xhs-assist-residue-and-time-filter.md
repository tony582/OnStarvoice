# 小红书 hotfix：停止后采集辅助残留（capture_task_relay_mismatch）与时间筛选未确认（XHS_SEARCH_TIME_FILTER_UNVERIFIED）

分支：`codex/hotfix-xhs-assist-residue-20260924`（工作区 `OnStarvoice-hotfix-xhs-assist-residue-20260924`）。基线：`79ca6a9`（Extension 0.4.14，扩展源码与各节点当前加载的 0.4.14 逐字节一致）。发布版本：0.4.15。本地提交，未推送、未部署，也没有在真实浏览器中验证。

## 现象

小红书弹性池任务逐日统计（生产库只读查询；— 表示本次诊断摘要没有给出该项，不代表为 0）：

| 日期 | 时间筛选未确认 | relay mismatch | stale_unattended_attempt | 完成 |
|---|---|---|---|---|
| 09-05 ~ 09-09 | 0 | — | — | 约 26/天 |
| 09-10 | 8（首次出现；时间筛选校验 `9506d5a` 于当天提交） | — | — | — |
| 09-11 ~ 09-21 | 本文未单列 | — | — | — |
| 09-22 | — | — | 114 | — |
| 09-23 | 18 | 29 | — | — |
| 09-24 | 41 | 49 | — | 6 |

- 09-22 报 `stale_unattended_attempt` 的 114 次，在 0.4.12（`c06c7cb`）之后变成 09-23 起的 `capture_task_relay_mismatch`（报错文本「列表采集子运行与当前采集辅助任务不一致」）。`c06c7cb` 只是把同一个残留暴露的位置后移了。
- 木星：19:53 运营停止任务（`USER_CANCELED`），下一个关键词在同一秒下发，随后连续 25 次 relay mismatch。
- 火星：09-24 09:09 批次以 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 收尾，约 10 小时后采集辅助会话仍挂在来源页上，连续 22 次 relay mismatch。
- 同一个残留也会让该页的手动采集失败：2026-09-23 16:04Z 有几次手动 `task_…` 运行报 `capture_task_relay_mismatch`。
- 成都：云端 runner 的时间筛选失败率为 16/17。当天在三台 Mac 上用手动平均下发跑同样的关键词，3/3 通过。该机器同时开着 4–6 个 Chrome 窗口（节点），互相抢 CPU。

## 根因

### A. 停止后采集辅助残留 → relay mismatch

旧任务留下的持久采集辅助会话（`chrome.debugger`）没有释放，一直挂在小红书来源页上。生产中见到两种触发：运营停止或取消运行中的任务（木星），以及以 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 收尾（火星）。

1. 新运行页的 BEGIN 撞上残留会话，后台抛出 `capture_task_debug_starvoice_active`（`background.js` 约 16606–16635 行）。
2. 运行页把它归入 `OPTIONAL_CAPTURE_ASSIST_SESSION_CODES`，按可选降级处理，批次继续。
3. 每次 `captureKeywordNotes` 列表中继（约 19711–19748 行）都会比对 `payload.taskId` 与残留会话的 `taskId`。两者不一致，中继被拒，报 `capture_task_relay_mismatch`。
4. 后台从不回收残留，原因有三：
   - `inspectCaptureTaskGroupLiveness`（约 15940–15967 行）对任何未分离的 Debug 会话都返回 `active:true`，所以 `releaseConfirmedStaleCaptureTaskGroupsForBegin`（约 16054–16112 行）一直保护它。
   - `performEndCaptureTask`（约 18000–18016 行）会直接忽略 attempt 围栏已经不是当前的 END，例如请求槽已换到下一个请求（`request_mismatch`）。
   - 因此旧会话只有在关闭该标签页、点调试条上的「取消」或重载扩展时才会释放。

在 `c06c7cb` 之前，同一个残留会让整批更早失败，报 `stale_unattended_attempt`。复现使用真实 `background.js` 加假 chrome，场景 S1–S4 都能复现上述链路。

### B. 时间筛选未确认

`XHS_SEARCH_TIME_FILTER_UNVERIFIED` 的校验代码自 `9506d5a`（09-10）起没有改过，与 `c06c7cb` 无关。它是多种原因共用的兜底码。真实原因存放在 `error.filterResult`，但在写入任何记录之前就被丢弃了：capture-sync 的关键词 catch 只保留 code、message 和 category，所以后台卡片和数据库里只有通用文案。页面脚本调用失败（无响应、中转失败或返回错误）也被整体归入这个码（`applySearchFiltersInTab`），无法区分。

成都机器（16/17 失败，同一天手动平均下发通过）的主因是搜索路由：

- 失败时刻的诊断导出里，页面类型是 `search_results`，但脱敏后的路径是 `/other`。`utils/diagnostics.js` 只把 `/search_result(?:/|$)` 记成 `/search_result`，其它都记成 `/other`。也就是说，标签页停在一个非标准的搜索路由上。
- 小红书网页版现在有 AI 搜索页（点点），路由是 `/search_result_ai`。`utils/platform/page-routing.js` 把任何路径里「包含」`/search_result` 的页面都算作搜索结果页。
- 两个自动搜索 URL 构造函数，capture-sync 的 `buildKeywordSearchUrl` 和侧栏的 `buildSidebarKeywordSearchUrl`，只要当前路径包含 `/search_result` 就复用当前 URL。标签页一旦落到 `/search_result_ai`，无人值守启动和之后每个关键词都留在 AI 布局上。
- AI 页的筛选面板和标准页不同，于是得到 `panel_not_opened`，报 `XHS_SEARCH_TIME_FILTER_UNVERIFIED`，而且只在这台机器上出现。
- 09-10 的现场记录（主仓库 `docs/xhs-capture-stability-plan-20260910.md`）已经记下「自动任务和手动搜索出现不同布局 … panel_not_opened … 沿用 /search_result_ai」，当时没有实施。

可能的次要因素（未证实）：同机开 4–6 个 Chrome 窗口、CPU 紧张时，筛选后等待结果刷新的 8 秒窗口（42 次轮询）可能偏短。0.4.15 不改这个窗口；失败文案里的卡片数和等待时长用来确认它是否真的是问题。

## 修复

Extension（0.4.15）。原因 A 是完整修复；原因 B 只做缩小后的范围：失败文案写明真实原因、自动搜索不再沿用 AI 搜索路由、证据模块只加诊断字段。评审中试过的 15 秒见证窗口已撤回，更大的时间筛选加固（full-v1）刻意没有发布，见下文「刻意没有发布的内容」。

### `background.js`（原因 A）

- 新增 `inspectUnattendedCaptureAssistResidue()`，用来判定一个会话是否为「可证明的残留」。
  - 只覆盖稳定 taskId `unattended-capture:<requestId>`。手动 `task_…`、巡查、定向帖和 `manual_batch` 保持原来的存活语义，不会被回收。
  - 判为残留的情况：请求槽为空（`request_absent`）、请求槽已换成别的请求（`request_mismatch`）、同一请求的会话轮次已被换走（`attempt_superseded`）、请求已终态且轮次已被换走（`request_terminal`）、请求已终态且停止确认已到 `source_stopped` / `runtime_released` 或已有本地收尾键（`request_terminal`）。
  - 以下情况一律按存活处理：
    - 执行锁仍绑定该 taskId（无论哪一轮、是否过期），原因 `execution_lock`。
    - 请求仍在运行且会话就是当前轮次（`unattended_run_request`）。执行锁已经丢失时也一样，例如租约过期、持有页消失或 runner 正在恢复；这时只有请求槽能证明它仍存活，与 0.4.14 行为一致。
    - 同一轮次终态但停止确认尚未落盘（`terminal_cleanup_pending`）。
    - 正在清理，以及任何无法判定的情况。读执行锁或请求槽出错时同样按存活处理（`residue_state_unreadable`），BEGIN、列表中继和迟到 END 的返回与 0.4.14 相同，不会变成运行时错误。
- `inspectCaptureTaskGroupLiveness`：未分离的会话只在被证明为残留时返回 `active:false`，原因为 `residual_capture_assist`。
- BEGIN 阶段：`releaseConfirmedStaleCaptureTaskGroupsForBegin` 通过原有的有序释放流程回收残留，原因为 `residual_capture_assist_reclaimed`。释放时保留新任务的 `sourceTabId` 和执行锁持有的 Tab。
- 列表中继阶段：来源页上是另一任务的持久会话时，`reclaimResidualCaptureAssistForRelay()` 在 BEGIN/END 所用的同一生命周期队列里复核并释放残留，然后按无会话继续中继。存活会话仍按 `capture_task_relay_mismatch` 拒绝。
- 迟到的 END 本身仍被忽略，不结算也不取消。`releaseResidualCaptureAssistForStaleEnd()` 在此基础上顺手回收残留，规则如下：
  - 同一请求的旧轮次 END，只能释放仍绑定在它自己那一轮的会话，绝不碰新轮次的会话（`capture_assist_attempt_mismatch`）。
  - 请求槽里还有存活的后继时不释放（`successor_active`），交给后继自己的 BEGIN 或列表中继处理。
  - 真正关页之前再判定一次；此时如果冒出存活后继，一个工作页都不关。
  - 保留前台 Tab、锁持有 Tab，以及槽内请求的 runner 页和平台页。
  - 返回结果新增 `residualCaptureAssist` 字段。
- `releaseCaptureTaskResources` 新增 `preserveTabIds` 和关页前的 `resolveKeptWorkerTabIds`：新任务正在用的 Tab 即使出现在旧的工作页列表里，也不会被关闭。`reclaimSupersededUnattendedCaptureTaskForBegin` 会保留新轮次的来源 Tab。
- `onstarvoice:switch-platform-tab` 放进生命周期队列执行。这样回收途中关闭旧工作页时，runner 不会恰好把那个页选为来源。
- 回收只分离 Debug、清理标签组和旧工作页。它从不改动执行锁、请求或停止确认证据，也不会关闭、导航或刷新新任务正在用的来源页。
- 已回退的两项新增（第 3 轮评审证实会破坏不变量，最终代码里没有）：
  - `cancelUnattendedKeywordRunFromControl` 取消路径里的 `cleanupTerminalUnattendedRuntime` 调用。它在 runner 仍存活时刷新来源页，导致进行中的列表采集在写入停止证据之后又被当作新采集重发。
  - 心跳驱动的 `retryLeftoverTerminalUnattendedRuntimeRelease`。它会每分钟刷新卡住或被复用的页，可能关闭后续手动采集正在用的页，还会给锁仍存活的旧轮次写空的 `runtime_released`。
  - 回退的代价：云端停止后，如果旧请求一直留在请求槽里且没有停止确认，残留会保留到下一个无人值守请求占用请求槽，再由它的 BEGIN 或列表中继回收（见「已知遗留问题」）。

### `utils/capture-sync.js` 与 `sidebar/sidebar-logic.js`（原因 B：AI 搜索路由）

- 两个自动搜索 URL 构造函数只在当前路径正好是 `/search_result` 或 `/search_result/` 时复用该页参数。其它包含 search_result 的路由，包括 `/search_result_ai`、`/web/search_result`、`/search/result` 和 `/search_result/<笔记 ID>`，一律改用默认的标准搜索 URL，只带关键词，不带走该页参数。探索页、抖音和微博的构造结果不变。
- 无人值守启动（侧栏 `navigateActiveTabToKeywordSearchForPlan`，手动平均下发也走它）和批次里之后的每个关键词都经过这两个函数，所以都会打开标准搜索页。
- 所用标签页、搜索次数、筛选点击次数和顺序都不变。批次复用启动搜索页证据的规则也不变：启动页即使报告的是 AI 路由，本词也照旧复用，不额外再搜一次。

### `utils/capture-sync.js`（原因 B：失败写明真实原因）

- `applySearchFiltersInTab`：页面脚本或中转失败、抛错、内容返回空时，原因记为 `content_message_failed`，并在 `filterResult` 里保留原始错误码（至多 80 字）和截断后的文案（至多 200 字），便于在扩展内排查。错误码和各标志仍由 `createXhsSearchTimeFilterError` 决定。
- 关键词失败文案：只对 `XHS_SEARCH_TIME_FILTER_UNVERIFIED` 追加原因后缀，总长至多 160 字，例如 `无法确认小红书时间筛选及结果刷新已生效，已跳过本关键词（原因：未找到筛选面板；页面：AI 搜索页）`。
  - 后缀可以包含：原因（页面脚本调用失败、未找到筛选面板、时间选项未保持选中、筛选后结果未刷新、当前不是搜索页）、结果卡片数与基线卡片数、等待时长，以及页面种类（AI 搜索页或非标准搜索页）。
  - 中转或页面脚本的原始错误码不写进文案，只留在 `filterResult` 里。管理端的 `taskKeywordFailureKind`（`web/admin/src/pages/dispatch/cloud-tasks/lib.ts`）和其它几处会按错误文本给失败归类。集成时发现，上一版把错误码写进文案会改变归类：`RELOAD_REQUIRED` 因含 required 被判为安全拦截，`CONTENT_RELAY_TIMEOUT` 因含 timeout 被判为网络。现在后缀只含固定的中文说明、数字和「AI 搜索页」，管理端归类与 0.4.14 相同，有测试直接调用管理端的归类函数来锁定这一点。
  - 其它错误的文案原样保留。`errorCode`、`errorCategory`、`fatal`、`stopBatch`、`retryable` 等上报给服务端的字段都不变。这段文案会进入批次结果、逐词回调和无人值守 checkpoint 的 `entry.error`。

### `content-v2.js`（原因 B）

- `applyBatchSearchFilters` 的 4 种返回都带上 `pageRoute`，取值为 `search_result`、`search_result_ai` 或 `other`。只回传路由种类，不含查询参数和关键词。文件其它部分没有改动。

### `utils/capture/xhs-search-filter-evidence.js`（原因 B：只加诊断字段）

- `waitForSettled` 的判定与 0.4.14 完全相同：默认 8 秒，固定 42 次轮询上限，接受条件不变。需要真实切换、就绪且连续 2 次一致；只在尾部追加、列表完全没变、复用原节点且 ID 相同但没有经过加载，这些情况都仍然不通过；空态正则也不变。
- 返回值新增有界诊断字段 `baselineCardCount`、`elapsedMs`（上限 600000）、`polls`，只用于失败说明，不参与判定。
- 与 0.4.14 做过差分：同一批随机事件序列跑 4 万次，判定、原因、签名、卡片数和结束时刻全部一致，0 处差异。用同一脚本测撤回前的 15 秒版本，能测出 10,727 处差异，说明脚本确实能发现改动。
- 已撤回的 15 秒见证窗口：评审期间曾把等待延长到 15 秒，8 秒后只接受笔记 ID 变化。评审证实这会放过旧列表：`result_ids_changed` 只表示可见 ID 序列与基线不同，同一批卡片重排、首卡被移除或隐藏都算。所以 8 秒后这些与筛选无关的变化会把未刷新的旧列表判为已筛选，而 0.4.14 对同样的场景判为未确认。再加「必须出现基线里没有的 ID」也挡不全：见证器最多读 64 张卡，卡片多于 64 张时首卡消失，第 65 张就会被当作新 ID。因此整体撤回延长，不在 0.4.15 里。

### 刻意没有发布的内容（full-v1 时间筛选加固）

本 hotfix 前期做过一版更大的时间筛选管线加固（full-v1），改动 `content-v2.js`、`utils/capture-sync.js`、`utils/capture/xhs-search-filter-evidence.js` 及其测试。它已整体放弃，这几个文件重置回基线后，只重新做了上面缩小后的改动。补丁留档（只作参考，不要重新应用）：`/private/tmp/claude-501/-Users-dulaidila--gemini-antigravity-scratch-OnStarvoice-2/f5d269c6-19d8-4dfc-9425-27e2046652af/scratchpad/hotfix/full-v1/full-v1.patch`。

没有发布的内容：

- 重置回「不限」再点目标项：原页重挂时，先在「发布时间」行切回「不限」并等刷新落定，再点目标时间项，让见证器看到一次真实切换。
- 筛选点击改序：时间筛选改为最先点，其它排序、类型筛选在后。
- 就绪门槛和页面级空态探测：开见证前要求基线可信（没有加载指示，且有结果卡或确认空态）；结果根节点不存在时，在整页范围内找空态和加载指示。另有原页无点击复核和 `not_ready` 原因。
- 放宽空态文案：空态文案后面跟着提示语（如「换个词试试吧」）也算确认空态。
- 重挂和空态放行：小红书重新挂载结果根节点的父节点后，跟随新根节点；已确认的空结果收窄时间后仍为空，就直接放行（`acceptConfirmedEmptyBaseline`）。

放弃原因：每一轮评审都在这套改动里找到新的旧列表放行路径，或误报 0 条的路径。例如：切回「不限」发出的未筛选请求可能与迟到的首轮响应交错，未筛选列表会被当成筛选结果；空态放宽和空态到空态放行会把加载中的短暂空白页当成确认空态，本词直接按 0 条完成、不再重试；跟随重挂可能把缓存的未筛选列表读成刷新；改点击顺序本身也违反「不改筛选点击顺序」的约束。这些路径都违反「不接受未筛选或旧列表」和「不误报 0 条」的不变量，所以不在 0.4.15 里。筛选真正的误报只能等现场的原因数据回来后，再单独评审。

### 测试

- `tests/background-capture-lock.test.mjs` 新增 17 项，覆盖以下场景：
  - 后继的 BEGIN 或列表中继回收残留，包括 BEGIN 降级时。
  - 后继的 BEGIN 与列表中继并发到达同一残留来源页。两种先后顺序下，A 都只释放一次，B 的会话保持挂载，运行时里的会话指向 B。去掉中继回收的生命周期队列或队列内的会话复核，任何一个都会让这项失败。
  - 迟到 END 在有存活后继时让行，槽空时回收，保留前台 Tab，不关闭后继已经选作来源的旧工作页。
  - 旧轮次 END 不释放新轮次的会话。
  - 存活的手动会话、仍持有执行锁的会话、停止确认前的终态会话都不回收。
  - 本轮集成新增：请求仍在同一轮次运行但执行锁已丢失时，会话不被回收。外来的手动和无人值守列表中继仍报 relay mismatch，手动 BEGIN 仍报 `capture_task_debug_starvoice_active`，旧轮次和其它请求的迟到 END 都不释放它，工作页一个不关。把 `return verdict(false, 'unattended_run_request')` 改成 `true`，只有这一项失败，其余 315 项仍通过。
  - 本轮集成新增：残留判定读执行锁出错时，列表中继仍报 relay mismatch，迟到 END 仍是 ignored 且不释放（`residue_state_unreadable`）；存储恢复后，下一次迟到 END 照常回收。去掉这层兜底，只有这一项失败。
  - 云端停止不会在进行中的列表中继下刷新来源页。
- `tests/capture/xhs-search-filter-evidence.test.mjs` 新增 5 项，原有 15 项不变：
  - 默认仍是 8 秒窗口，并带诊断字段；显式传入更长的 `timeoutMs` 也被 42 次轮询封顶。
  - 时钟回拨时仍是 42 次轮询。
  - 诊断字段不影响判定。
  - 在 8 秒或之后才出现的列表变化一律不通过：同一批卡片重排、首卡移除、首卡隐藏、全新 ID、加载指示出现又消失、清空为空态。7.8 秒出现的新 ID 仍在 8 秒时通过，这是与 0.4.14 相同的边界。
  - 时间项已选中时在 8 秒结束。
- 新文件 `tests/capture/xhs-search-route-and-reason.test.mjs`，19 项：
  - 两个 URL 构造函数的路由规则，以及二者对同一输入结果一致。
  - 用真实的侧栏启动函数验证：来源页停在 AI 搜索页时，启动只导航一次，并且导航到标准搜索页。
  - 如实记录已知限制：启动就绪判定只看关键词，会接受 AI 路由；批次对启动证据照旧只复用一次，不增加搜索。
  - 之后的关键词从 AI 搜索页基址回到标准搜索页。
  - 各种失败原因的文案和长度上限，错误码与标志不变，原因一路写到 checkpoint 的 `entry.error`。任何中转错误码都不出现在文案里。
  - 本轮集成新增：直接调用管理端的 `taskKeywordFailureKind` 和 `PLATFORM_SAFETY_EVIDENCE_PATTERN`，确认每种后缀的归类都与无后缀的 0.4.14 文案相同（`other`，不是安全拦截），且后缀里除「AI 搜索页」外没有英文字母。放回上一版带错误码的文案，这一项和另外 4 项会失败。
  - 中转、内容、抛错和空返回都在 `filterResult` 里保留原始错误码与截断文案；已确认的小红书安全拦截照旧处理。
  - 内容脚本只回传脱敏的路由种类。
- 新测试都做过反向验证：在临时副本里去掉对应修复，相应测试会失败。

### 版本与更新说明

- `manifest.json` 改为 0.4.15。
- `server/routes/update-manifest.js`：`latestVersion` 改为 0.4.15，`releaseDate` 改为 2026-09-24，下载名为 `StarVoice-extension-v0.4.15-20260924.zip`。0.4.15 更新说明共 3 条，与最终代码一致：
  - 停止任务后不再残留采集辅助：旧采集辅助会在下一个无人值守任务启动或列表采集时释放；正在运行的任务以及手动、巡查任务的处理不变，不关闭、不刷新来源页。
  - 自动搜索不再误入小红书 AI 搜索页：停在 `/search_result_ai` 等非标准路由时改开标准搜索页 `/search_result`，搜索次数和筛选点击不变。
  - 时间筛选失败写明原因：列出可能的原因、卡片数、等待时长和所在页面；错误码、分类和处理方式不变，等待时间和校验规则与 0.4.14 相同。
- `server/public/about.html` 新增对应的 0.4.15 条目，「最新」标记移到 0.4.15。
- `server/services/ops-control.js` 的运行时基线改为 0.4.15。
- `tests/update-manifest.test.mjs` 同步修改：检查 3 条说明的标题和要点（下一个无人值守任务、`/search_result_ai`、页面脚本调用失败、等待时间和校验规则与 0.4.14 相同），并检查 0.4.15 说明和关于页里不出现已放弃方案或旧文案的说法（15 秒、20 秒、延长、重新挂载、复核、重挂、未就绪、无响应）。

## 未改动

- 错误码：`capture_task_relay_mismatch`、`capture_task_debug_starvoice_active`、`stale_unattended_attempt`、`XHS_SEARCH_TIME_FILTER_UNVERIFIED`、`SEARCH_FILTER_APPLICATION_FAILED` 等上报给服务端的码保持不变。服务端弹性池的分类、计费和改派都依赖这些码。只有人读的文案增加了有界的原因后缀，而且管理端按文案给出的失败归类也不变。
- 执行锁、attempt 围栏、`PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 和停止确认证据都没有放宽。分离 Debug 不作为内容管线已停止的证据。
- 运行页 `OPTIONAL_CAPTURE_ASSIST_SESSION_CODES` 的降级语义没有改动。手动、巡查、定向帖会话的存活判定也没有改动。
- 时间筛选校验的判定与 0.4.14 完全一致：等待时长、轮询上限、接受条件和空态正则都没有改，只多返回诊断字段。
- 使用哪个标签页、发起几次搜索、点几次筛选以及点击顺序都没有改动。
- 服务端业务逻辑、数据库结构和迁移没有改动。
- 已知遗留问题（另需单独评审）：
  - 请求被停止后，如果它一直留在请求槽里且没有停止确认（例如云端停止时列表采集正在进行），或者 runner 已消失且没有新请求占用请求槽，残留会话仍会挡住该页的手动和巡查采集，直到下一个无人值守请求的 BEGIN 或列表中继把它回收。这与基线行为一致。安全修复需要评审提出的受控方案：不刷新页面、有其它采集持锁时跳过、只处理同一轮次、保留仍在使用的页面。
  - 后继的 BEGIN 现在会回收已停止请求的残留会话，而该请求被取消的采集可能仍在同一页收尾。这个时序窗口在基线就存在，只是之前恰好被 Debug 会话挡住。
  - 启动就绪判定（`waitForActiveTabReady` / `waitForRuntimeSearchPage`）只比对关键词，不拒绝 `/search_result_ai`。如果小红书自己把标准搜索 URL 跳到 AI 页，本词仍会失败，只是文案会写明「页面：AI 搜索页」；不会额外搜索，也没有启动级的单独信号。
  - 几处路由判定口径不完全一致（内容脚本、capture-sync、侧栏对 `/search_result/<id>`、`/search_result//` 的归类不同）。这只影响失败文案里的页面标签，不影响搜索和校验。
  - 以下校验盲区本版没有处理。它们只会误报「未确认」，不会放过旧列表：小红书重新挂载结果根节点的父节点后，见证器读到已脱离文档的旧根节点；空结果文案后面带提示语；点击前结果为 0 张卡。
  - 不在已知列表里的证据原因（例如笔记 ID 变了，但到 8 秒仍没有连续两次一致）不写「原因」，但卡片数和等待时长照常写。
  - 中转或页面脚本的原始错误码只在扩展内的 `filterResult` 里，不上报服务端；现场只能看到「页面脚本调用失败」。
  - 0.4.14 原有的校验弱点本版没有改：8 秒窗口内，同一批卡片重排、首卡被移除或隐藏也算「笔记 ID 变化」，会被当作刷新证据。收紧它会改变 0.4.14 的判定，需要单独评审。

## 验证

以下数字均为本轮集成（2026-09-25）在最终代码上的实测。

- 语法：改动的 JS 和测试文件（`background.js`、`content-v2.js`、`utils/capture-sync.js`、`sidebar/sidebar-logic.js`、证据模块、`server/routes/update-manifest.js`、`server/services/ops-control.js` 和 4 个测试文件）在 Node 24.12.0 和 Node 18.20.8 上 `node --check` 均通过。`background.js` 按经典脚本（service worker）用 `vm.Script` 解析通过。
- 目标套件（`tests/background-capture-lock.test.mjs` 和 `tests/capture/*.test.mjs`）：Node 24.12.0 和 Node 18.20.8 均为 1006/1006 通过（基线 979 项；本轮集成新增 3 项）。
- 完整回归 `scripts/run-node-regression-tests.mjs`，Node 24.12.0，与基线 `79ca6a9`（`git archive` 导出到临时目录，按同样方式准备 `extension-build/` 和 `node_modules` 链接）逐项对比失败名单：
  - 直接运行：本分支 1811 项，1725 通过，86 失败；基线 1770 项，1684 通过，86 失败。两边失败名单逐条一致。
  - 加只读解析垫片：本分支 2483 项，2456 通过，27 失败；基线 2442 项，2415 通过，27 失败。两边失败名单逐条一致。
  - 失败全部来自环境缺包：`dotenv`、`express`、`pg`、`exceljs`、`typescript`、`node-cron`、`@resvg/resvg-js`（直接运行时），垫片下只剩 `dotenv`（由测试另起的服务端子进程报出）、`exceljs`、`typescript`、`@resvg/resvg-js`、`express`。
  - 垫片的作用：共享的 `server/node_modules` 链接失效，垫片只在包加载失败时，从完好的 `.pnpm` 仓库重新解析。
- Node 18.20.8，加垫片，跑 80 个测试文件（引用改动文件的 54 个，加上全部 `tests/capture/*.test.mjs` 和 `tests/background-capture-lock.test.mjs`）：本分支 1279 项，1277 通过，2 失败；基线同一组文件 1238 项，1236 通过，2 失败。失败都是 `process-role-runtimes` 和 `server-cron-runtime`，原因是缺少 `@resvg/resvg-js`，与基线一致。
- 反向验证（含前几轮评审做过的）：在临时副本里逐一去掉修复，对应测试都会失败。去掉的修复包括：中继回收的生命周期队列、队列内会话复核、侧栏 URL 构造修复、「请求仍在运行按存活处理」这条守卫、读存储出错时的兜底，以及加回「启动页在 AI 路由时不复用」和「错误码写进文案」。证据模块另做了变异验证：放回 15 秒延长（包括只放行新 ID 的变体）、只把默认值改成 15 秒、按 `timeoutMs` 推算轮询上限，新测试都会失败。
- 端到端复现（原因 A，真实 `background.js` 加假 chrome，真实云端建任务和停止命令）：木星场景在 4 种 END 时序下，后继任务 B 的 BEGIN 和列表采集都成功，A 的会话被回收，关页 0、刷新 0。停止后改由手动采集接续时，行为与 0.4.14 相同（仍被挡住，见已知遗留）。
- 快照与安装包：
  - `extension-build/` 已用 `TMPDIR=<临时目录> bash scripts/sync-extension-build.zsh production` 按源码重新同步，只写入本工作区的 `extension-build/`。`bash scripts/check-extension-snapshot.zsh` 通过：102 个文件，指向生产 API。
  - 已用 `TMPDIR=<临时目录> zsh scripts/package-extension.zsh <工作区>/output/release-0.4.15/StarVoice-extension-v0.4.15-20260924.zip` 重新打包，只写入本工作区的 `extension-build/` 和 `output/`。新包 1,321,427 字节，SHA-256 `d7422afc9aab6c6e27971a19d7e89537b87cd2420c19875913e3660182fe50af`。
  - 包里的 `background.js`、`content-v2.js`、`utils/capture-sync.js`、`utils/capture/xhs-search-filter-evidence.js`、`sidebar/sidebar-logic.js`、`manifest.json`（0.4.15）与源码逐字节一致；解压后 102 个文件与 `extension-build/` 完全相同；不含已放弃方案的标识 `describeXhsTimeFilterFailure`、`acceptConfirmedEmptyBaseline`。
  - 旧包（SHA-256 `d221cf16c78399c3a796d199ecb0c8151f374489348f4162cf79dc50c863f495`）是用已放弃方案打的，已被覆盖，不得使用。
  - 包名和更新说明沿用 2026-09-24 的日期（`releaseDate`、`downloadUrl` 一致），实际打包在 2026-09-25。
- 未做：真实浏览器验证，包括真实停止后接续、真实小红书 AI 搜索页和多窗口高负载场景。

## 发布与回滚

实际行为改动只在 Extension 里。服务端只有 3 个版本文件变更：`server/routes/update-manifest.js`、`server/public/about.html`、`server/services/ops-control.js`。它们决定更新提示、关于页和运维基线，要生效需要部署服务端。没有数据库迁移。

1. 使用上面记录的包 `output/release-0.4.15/StarVoice-extension-v0.4.15-20260924.zip`，上传前核对 SHA-256 为 `d7422afc…50af`。如果评审后源码又有改动，必须重新运行 `scripts/package-extension.zsh` 并重新记录 SHA-256。
2. 先不要动服务端，也不要把包放到公开下载目录；先把包单独装到一个节点上验证。
3. 选一个空闲的小红书节点，确认它没有在途任务或已经停稳，再加载 0.4.15 并重载扩展。
4. 在该节点上验收：
   - 停止后不再残留：在批次中途停止一次无人值守任务，再下发下一个任务。新任务开始后，旧调试条（「StarVoice 星语」已开始调试此浏览器）应被释放，不会挡住下一次运行；后续关键词不再报 relay mismatch，来源页也没有被关闭或刷新。例外：停止后如果没有后继的无人值守任务，旧调试条可能保留到下一个无人值守任务开始，这属于已知遗留。
   - AI 搜索页被带回标准搜索页：让来源页停在小红书 AI 搜索页（地址含 `/search_result_ai`），再下发任务。自动搜索应打开 `/search_result`，时间筛选正常通过。
   - 失败卡片带原因：时间筛选失败时，失败卡片文案应带上「（原因：…）」后缀，可据此区分未找到筛选面板、筛选后结果未刷新、页面脚本调用失败；停在 AI 页时会写「页面：AI 搜索页」。失败卡片的归类（非安全拦截、非网络）应与 0.4.14 相同。
5. 单节点验收通过后，把包上传到下载目录，确认文件名与 `update-manifest.js` 中的 `downloadUrl` 一致，再逐台更新其余节点，成都机器优先。正在采集的节点要先确认任务结束或停稳，再重载扩展。
6. 最后部署服务端的 3 个版本文件：先备份，只替换这 3 个文件，然后重启 `onstarvoice`，确认 health、live、ready 都通过。之后的更新提示和运维基线会指向 0.4.15。如果先部署服务端，尚未升级的节点会在运维面板里显示为低于基线。

回滚：先停止新的下发，确认在途任务已停稳。然后把节点改回加载 0.4.14 包（`StarVoice-extension-v0.4.14-20260923.zip`）并重载扩展。如果服务端版本文件已经部署，用备份恢复这 3 个文件并重启。不需要清理数据或修改任务状态。

## 临时处置（节点升级前）

- 节点连续报「列表采集子运行与当前采集辅助任务不一致」时，在该 Chrome 窗口顶部的调试条上点「取消」，或者在扩展管理页重载 StarVoice，然后再下发任务。
- 升级前尽量不要在批次中途停止小红书任务。确实需要停止时，先按上一条清掉调试条，再下发下一个任务。
- 节点连续报「无法确认小红书时间筛选及结果刷新已生效」时，先看该节点小红书标签页的地址。如果含 `/search_result_ai`（AI 搜索页），把它改回小红书首页或标准搜索页 `/search_result`，再下发任务。
- 同一台机器同时开 4–6 个 Chrome 窗口、CPU 紧张时，时间筛选可能更容易超时。0.4.15 没有延长等待，所以升级前后都可以减少同机并发窗口数来缓解。如果升级后仍频繁出现「原因：筛选后结果未刷新」且等待 8 秒，再依据这些数据单独评估。
