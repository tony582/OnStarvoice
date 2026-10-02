# 手机采集每个关键词秒失败：一条超长标题堵死上传队列 hotfix（2026-10-02）

分支：`codex/hotfix-android-outbox-poison-20261002`，基线 `main`（`686f359`）。Android Runner `0.2.6` → `0.2.7`，服务端一处校验上限、一处旧轮次事件的认定，后台一处显示。没有数据库迁移，没有新配置项。**Runner 部分只需换本机运行目录即可生效；服务端部分需要部署后生效（部署情况见文末）。**

## 现象

2026-10-02 上午，调度中心「手机固定采集」每个关键词都显示「工作项已释放 · 恢复 第 1 次 · 等待空闲 Agent」，没有任何产出。手机本身正常：DE106 亮屏未锁、抖音 40.6.0 在前台、Appium 在、Runner `runtime-0.2.6-d68201d` 在线且 `controlError=null`。

本机只读取证：

- `diagnose --hours 2`：64 次运行全部 0 秒结束，原因都是 `needs_action:outbox_backlog`；`status` 显示 `pendingEvents: 100`。
- 状态库 `runner.sqlite`：99 条 `pending` + 1 条 `batched`。唯一未关闭的批次只有 1 条事件（关键词「别克哨兵」，2026-10-01 21:26:49 发现），它的 `titleHint` 长 2,807 个字符。此前所有已上传事件的标题最长 961。
- `network:delivery` 检查点是 `{"blocked":true,"failures":1,…}`，时间 2026-10-01 21:26:51；最后一条成功上传在 21:26:00。也就是说从那一刻起再没有上传过。
- 队列里同一篇作品还有 2 条（22:30、23:48 两轮「别克哨兵」再次发现），共 3 条超长事件。
- 100 条待上传事件分属 5 个关键词的 10 个任务轮次。同一个工作项「别克哨兵」出现了 3 个不同的执行任务（分配版本 1、2、3），「至境哨兵」「凯迪拉克壁纸」也各有两轮：上传停住后，已跑完的关键词无法回报完成，服务端等到租约过期就把同一个词重新派发，手机又跑了一遍。

## 根因

三处叠在一起：

1. **服务端上限比真实文案短。** `server/services/capture-discovery/validation.js` 把 `titleHint` 限在 2,000 字符，超长抛 `INVALID_TITLEHINT`（HTTP 400），而校验是整批做的，一条超长，整批 5 条一起被拒。Runner 0.2.4 起会点「展开」取全文，抖音图文的文案可以远超 2,000 字。
2. **Runner 把「内容被拒」当成「需要人来处理」。** `cloud/transport.mjs` 只把 429／5xx 视为可重试；`cloud/delivery.mjs` 对其余错误写入 `blocked:true` 并持久化，之后每一轮直接返回 `needs_action`，不再发任何请求，重启也不会解除。被拒的批次保持打开，后面的事件永远排在它后面。
3. **队列满了就拒绝一切新任务。** `core/budget.mjs` 在待上传 ≥ 100 条时抛 `outbox_backlog`。上传停住之后，采集继续往队列里放，攒到 100 条后每个关键词一开始就结束。

另外 Runner 丢弃了 400 的响应体，本机任何地方都看不到 `INVALID_TITLEHINT`，只能看到一个没有原因的 `blocked`。

4. **第二道同样的坑：旧轮次的事件按条被拒。** 服务端 `lineage.js` 的 `loadLineage` 要求事件的任务等于工作项**当前**的执行任务（`item.execution_task_id = 事件的 taskId`）。工作项被重新派发后，上一轮的事件一律得到 `ATTEMPT_LINEAGE_MISMATCH`（HTTP 403）。而入库是逐条独立事务：一批 5 条里前两条已入库、第三条被拒，整个请求返回 403。Runner 同样会把它当成「需要人来处理」永久停住。本次事故的队列里约六成事件属于被重新派发过的旧轮次，只处理 400 的话，换上新版后队列会立刻再停一次。任何一次断网或 USB 断开超过租约时间，也会走到这条路上。

**不能用「截断标题」来修。** `ui-binding.js` 的 `matchesUiBoundRecord` 在补详情入库时把 `titleHint` 与浏览器实际采到的标题／正文做**全文相等**比较（去空白后）。截断后的标题永远对不上，这条作品的详情会以 `DISCOVERY_DETAIL_IDENTITY_MISMATCH` 被拒。所以标题必须完整保存。

## 修复

| 文件 | 改动 |
| --- | --- |
| `server/services/capture-discovery/validation.js` | `titleHint` 上限 2,000 → 20,000（常量 `TITLE_HINT_MAX`，注明原因）。列类型是 `TEXT`，没有索引用到它；单批 5 条的请求体上限约 400 KB，远低于 JSON 请求体限制 |
| `server/services/capture-discovery/lineage.js` | `loadLineage` 不再要求工作项当前的执行任务等于事件的任务。事件所属的尝试仍必须逐项对上（尝试号、租户、工作项、节点、执行任务、分配版本、请求哈希），所以伪造的尝试照旧 403；被重新派发过的旧尝试能被找到，由 `validateLineage` 判为迟到，按 `late_audit` 收下，不生成候选。这恢复了 09-24 并入统一调度（`7bf253b`）之前的行为，也是该函数注释和集成测试「old real attempt is audit only」写明的意图 |
| `runners/android/src/cloud/delivery.mjs` | 见下方规则。新增 `summarizeDelivery` 供窗口提示使用 |
| `runners/android/src/cloud/transport.mjs` | 非 2xx 响应读取响应体里的错误码（只接受 `^[A-Za-z0-9_]{1,80}$`，例如 `INVALID_TITLEHINT`），放进 `CloudRequestError.serverCode`。自由文本、HTML、超大响应一律得到 `null`，不会进入日志或状态 |
| `runners/android/src/storage/outbox.mjs`、`runner-store.mjs` | `unackedInBatch`、`dissolveBatch`（未回执的事件退回 `pending`，批次关闭）、`quarantineBatch`（事件标为 `rejected`，写本机标记 `{reason, at, quarantinedBy:'runner'}`，原始内容保留）、`listQuarantined`（只读、不含标题原文） |
| `runners/android/src/daemon/runtime.mjs`、`local-control.mjs`、`diagnose.mjs`、`cli/up-command.mjs` | `status` 增加 `deliveryBlocked`／`deliveryError`／`lastRefusal`／`refusedInARow`／`deliveryPausedUntil`；`diagnose` 增加 `quarantinedByReason`（按原因计数）和 `quarantined`（最近 20 条）；一键窗口在「上传被停住」或「有发现被拒收」时打印一行，同一原因连续出现时半小时内只打印一次 |
| `web/admin/.../DiscoveryCandidates.tsx` | 候选标题最多显示 3 行（悬停看全文），长文案不再把列表撑开 |

## Runner 上传规则（0.2.7）

| 服务端回应 | 0.2.6 | 0.2.7 |
| --- | --- | --- |
| 429／5xx／超时／网络错误 | 退避重试 | 不变 |
| 上传请求被 400／413／422 拒绝（请求内容被拒），或被 403 `ATTEMPT_LINEAGE_MISMATCH`／`DISCOVERY_TASK_MISMATCH` 拒绝（这条事件所属的轮次已被重新派发）；批次里有多条待回执 | 永久停住 | 先向服务端取回这一批已入库事件的回执，再把其余事件拆开逐条发送；逐条发完后恢复 5 条一批 |
| 同上，批次里只剩 1 条待回执 | 永久停住 | 这一条标为 `rejected` 留在本机，队列继续 |
| 401、其它 403（节点未授权、功能未开通、没有错误码）、404、409、查询回执被拒及其它不可重试错误 | 永久停住，无原因 | 仍然停住（这些是节点身份、授权或批次冲突，不是某一条事件的问题），但记下 `status`／`serverCode`／批次号／时间 |
| 重启后发现 0.2.6 留下的无原因 `blocked` | 永久停住 | 按新规则重试一次；仍被拒则按上面三行处理 |
| 连续 20 条被隔离，中间没有任何一条被收下 | — | 不再连续隔离，改为每 10 分钟只试 1 条（仍被拒就隔离这 1 条并继续等）。只要有一条被收下，计数清零、立即恢复全速 |

最后一行是「全部被拒」的保险。服务端故障或版本不匹配时，如果把所有事件都隔离，关键词会照常跑完而后台什么也收不到，调度中心看不出异常。放慢之后待上传会攒到 100 条，关键词以 `outbox_backlog` 提前结束，和这次事故一样在调度中心显示失败，起到报警作用；服务端恢复后不需要人处理。这段时间每 10 分钟最多再隔离 1 条，内容都留在本机。上限 20 约等于一个关键词一轮的发现数，零星的坏事件不会触发。

拆批之前一定先取回执：服务端已经入库的事件如果换一个批次号重发，会得到 `EVENT_BATCH_CONFLICT`（409）。取回执失败（例如 503）时本轮不拆，批次原样保留到下一轮。已经拿到回执的事件在拆批时保持原样，不会重发。被隔离的事件不再计入待上传数，所以不会再触发 `outbox_backlog`，也不会卡住所属任务的完成回报（`flushCompletion` 只等本次任务仍在待上传的事件）。

## 验证

- Runner 新增 `test/outbox-poison-20261002.test.mjs`（14 项）：一批 7 条里 1 条被拒时只隔离这一条、其余 6 条全部上传（请求序列 5,1,1,1,1,1,2）；0.2.6 留下的 `blocked` 状态加一条 2,807 字事件 → 重试一次后隔离，后面的事件照常上传；拆批时已有回执的事件不重发；401／403／404／409 仍停住并记录原因，且不会自己重试；查询回执被拒不会隔离任何事件；旧轮次事件（批次中间 403）逐条隔离，且已入库的事件不会换批次重发；拒绝后取回执失败则本轮不拆；503 只退避、逐条模式保留；错误响应只取机器码；`status`／`diagnose`／窗口提示不含标题原文；重启后仍能说出停住的原因；服务端校验接受完整长文案；连续被拒到 20 条后每个暂停只试 1 条、暂停期间不发请求、服务端恢复后自动全速排空；被拒与被收下交替出现时不会触发放慢。
- Runner 全量（Node 24.12，串行）：224／224 通过。去掉「拆批前取回执」「403 按条拒收」「连续被拒放慢」任一处，对应的新增测试即失败。模块边界检查通过（90 个模块，最大 311 行）。
- 根目录回归（Node 24.12）：3,228／3,228 通过。独立工作目录里没有未纳入版本库的 `extension-build/`，需要先链接主工作区那一份；不链接时只有读取该目录的 `tests/capture/douyin-blogger-profile-scope.test.mjs` 失败，与本次改动无关。
- 服务端测试：`capture-discovery-backend`（2,807 字通过、20,001 字被拒；血缘查询不再绑定工作项当前的执行任务，但仍绑定尝试自己的执行任务、节点、分配版本和请求哈希）、`capture-discovery-ui-binding`（长文案全文匹配成功、截到 2,000 字则匹配失败）。
- 本机 PostgreSQL 17 隔离库 `onstarvoice_test_outbox_poison_20261002` 上的集成测试：`capture-discovery.integration` 新增「关键词被重新派发到新执行任务后，旧尝试的事件仍按迟到证据收下」，在未修改的服务端代码上以 `ATTEMPT_LINEAGE_MISMATCH` 失败（与生产一致），修改后 16／16 通过；同一用例确认旧尝试不能冒用新执行任务写入、当前尝试照常生成候选。相关的 `capture-discovery-detail`（21）、`capture-discovery-timeout-cooldown`（10）、`android-control`（16）、`android-unified-scheduling`（10）、`android-manual-dispatch-mobile`（1）全部通过。Runner 的 `control-plane.integration`（真实 HTTP 鉴权 + PostgreSQL 血缘 + SQLite Runner，只有手机界面是模拟的）通过。
- 后台：`tsc` 通过，lint 基线 280 ≤ 288。

## 已知限制

- 上面两项（全部被拒时的保险、服务端收下旧轮次事件）最初留作待定，用户确认「按推荐来」后已在本分支实现。
- **放慢期间仍是「响」而不是「好」。** 待上传攒满后手机会像这次一样连续失败，直到服务端恢复。这是有意的：宁可显眼地失败，也不要悄悄丢。
- **一长串确实该拒的事件排空会很慢。** 超过 20 条连续被拒且各自都确实有问题时，之后每 10 分钟只排掉 1 条。服务端收下旧轮次事件之后，这种情况预计不会再出现；Runner 自身产生大量无效事件属于代码缺陷，需要发新版。
- **放慢期间已完成的关键词仍可能被重复派发。** 完成回报要等本次任务的事件发完，上传放慢时租约会过期，服务端会把同一个词再派一次（每个词最多 3 次）。这是原有规则，本次未改。
- 409（`EVENT_PAYLOAD_CONFLICT`／`EVENT_BATCH_CONFLICT`／`BATCH_PAYLOAD_CONFLICT`）仍按整队列停住处理。按现在的拆批顺序不会由 Runner 自己造成。
- 10-02 上午被隔离的 64 条都属于已经结束的任务轮次：3 条超长标题的，加上 61 条旧轮次的（当时服务端还不收）。这些内容留在本机不会丢，但不会再进入后台。对应的关键词在之后的轮次会重新搜到同样的作品；服务端部署前，那篇 2,807 字的作品每轮会再隔离 1 条。

## 部署与本机处置

### 本机手机（DE106，`829d89`）— 2026-10-02 已完成

| 时间 | 动作 |
| --- | --- |
| 11:08:38 | 确认 Runner 空闲（无任务、无待回报完成）后向 `runtime-0.2.6-d68201d`（PID 16495）发 SIGINT，2 秒内受控停止，`deviceClosureRequired=false` |
| 11:08 | 状态库备份为 `StarVoice-Android/backups/runner-0.2.6-before-0.2.7-4af82c1-20261002.sqlite`（完整性检查通过：1,323 已上传、1 待回执、99 待上传，`network:delivery` 为 `blocked`） |
| 11:08:59 | 用 `runtime-0.2.7-4af82c1/launcher` 的一键启动器启动（PID 32342）。运行目录由 `git archive 4af82c1 runners/android` 生成，`release-source.sha` 记录完整提交号，`launcher.json` 沿用原状态目录 |
| 11:09:00 | 第一轮上传：旧的 `blocked` 按新规则重试，服务端回 400 `INVALID_TITLEHINT`（第一次在本机看到真实错误码），那条 2,807 字事件被隔离，队列继续 |
| 11:17:33 | 队列排空：`pendingEvents=0`、`deliveryBlocked=false`，所有批次已关闭 |

100 条积压的去向：

| 结果 | 条数 | 说明 |
| --- | --- | --- |
| 隔离，`ATTEMPT_LINEAGE_MISMATCH` | 61 | 分配版本 1、2 的旧轮次：别克哨兵 8 + 24、至境哨兵 25、凯迪拉克壁纸 1 + 2、别克壁纸 1 |
| 隔离，`INVALID_TITLEHINT` | 3 | 同一篇 2,807 字作品在三轮「别克哨兵」里各出现一次 |
| 服务端收下，`late_audit` | 36 | 分配版本 3 的轮次：上汽通用客服 16、别克哨兵 16、至境哨兵 4。迟到证据只留作核对，不生成候选 |

换版后 Runner 在线、就绪、`controlError=null`，但直到 11:21 没有领到新任务：10:33 那一批的关键词在 10:33–10:40 已经各用完 3 次机会（每次都是 0 秒 `outbox_backlog`），按 `completion.js` 的规则应已标记失败（未查生产库确认）。需要重新下发一轮才会有新的采集。

### 服务端与后台

见本文件后续追加的记录。
