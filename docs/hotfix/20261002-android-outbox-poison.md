# 手机采集每个关键词秒失败：一条超长标题堵死上传队列 hotfix（2026-10-02）

分支：`codex/hotfix-android-outbox-poison-20261002`，基线 `main`（`686f359`）。Android Runner `0.2.6` → `0.2.7`，服务端一处校验上限，后台一处显示。没有数据库迁移，没有新配置项。**Runner 部分只需换本机运行目录即可生效；服务端部分需要部署后生效（部署情况见文末）。**

## 现象

2026-10-02 上午，调度中心「手机固定采集」每个关键词都显示「工作项已释放 · 恢复 第 1 次 · 等待空闲 Agent」，没有任何产出。手机本身正常：DE106 亮屏未锁、抖音 40.6.0 在前台、Appium 在、Runner `runtime-0.2.6-d68201d` 在线且 `controlError=null`。

本机只读取证：

- `diagnose --hours 2`：64 次运行全部 0 秒结束，原因都是 `needs_action:outbox_backlog`；`status` 显示 `pendingEvents: 100`。
- 状态库 `runner.sqlite`：99 条 `pending` + 1 条 `batched`。唯一未关闭的批次只有 1 条事件（关键词「别克哨兵」，2026-10-01 21:26:49 发现），它的 `titleHint` 长 2,807 个字符。此前所有已上传事件的标题最长 961。
- `network:delivery` 检查点是 `{"blocked":true,"failures":1,…}`，时间 2026-10-01 21:26:51；最后一条成功上传在 21:26:00。也就是说从那一刻起再没有上传过。
- 队列里同一篇作品还有 2 条（22:30、23:48 两轮「别克哨兵」再次发现），共 3 条超长事件。

## 根因

三处叠在一起：

1. **服务端上限比真实文案短。** `server/services/capture-discovery/validation.js` 把 `titleHint` 限在 2,000 字符，超长抛 `INVALID_TITLEHINT`（HTTP 400），而校验是整批做的，一条超长，整批 5 条一起被拒。Runner 0.2.4 起会点「展开」取全文，抖音图文的文案可以远超 2,000 字。
2. **Runner 把「内容被拒」当成「需要人来处理」。** `cloud/transport.mjs` 只把 429／5xx 视为可重试；`cloud/delivery.mjs` 对其余错误写入 `blocked:true` 并持久化，之后每一轮直接返回 `needs_action`，不再发任何请求，重启也不会解除。被拒的批次保持打开，后面的事件永远排在它后面。
3. **队列满了就拒绝一切新任务。** `core/budget.mjs` 在待上传 ≥ 100 条时抛 `outbox_backlog`。上传停住之后，采集继续往队列里放，攒到 100 条后每个关键词一开始就结束。

另外 Runner 丢弃了 400 的响应体，本机任何地方都看不到 `INVALID_TITLEHINT`，只能看到一个没有原因的 `blocked`。

**不能用「截断标题」来修。** `ui-binding.js` 的 `matchesUiBoundRecord` 在补详情入库时把 `titleHint` 与浏览器实际采到的标题／正文做**全文相等**比较（去空白后）。截断后的标题永远对不上，这条作品的详情会以 `DISCOVERY_DETAIL_IDENTITY_MISMATCH` 被拒。所以标题必须完整保存。

## 修复

| 文件 | 改动 |
| --- | --- |
| `server/services/capture-discovery/validation.js` | `titleHint` 上限 2,000 → 20,000（常量 `TITLE_HINT_MAX`，注明原因）。列类型是 `TEXT`，没有索引用到它；单批 5 条的请求体上限约 400 KB，远低于 JSON 请求体限制 |
| `runners/android/src/cloud/delivery.mjs` | 见下方规则。新增 `summarizeDelivery` 供窗口提示使用 |
| `runners/android/src/cloud/transport.mjs` | 非 2xx 响应读取响应体里的错误码（只接受 `^[A-Za-z0-9_]{1,80}$`，例如 `INVALID_TITLEHINT`），放进 `CloudRequestError.serverCode`。自由文本、HTML、超大响应一律得到 `null`，不会进入日志或状态 |
| `runners/android/src/storage/outbox.mjs`、`runner-store.mjs` | `unackedInBatch`、`dissolveBatch`（未回执的事件退回 `pending`，批次关闭）、`quarantineBatch`（事件标为 `rejected`，写本机标记 `{reason, at, quarantinedBy:'runner'}`，原始内容保留）、`listQuarantined`（只读、不含标题原文） |
| `runners/android/src/daemon/runtime.mjs`、`local-control.mjs`、`diagnose.mjs`、`cli/up-command.mjs` | `status` 增加 `deliveryBlocked`／`deliveryError`／`lastRefusal`；`diagnose` 增加 `quarantined` 列表；一键窗口在「上传被停住」或「有发现被拒收」时各打印一行 |
| `web/admin/.../DiscoveryCandidates.tsx` | 候选标题最多显示 3 行（悬停看全文），长文案不再把列表撑开 |

## Runner 上传规则（0.2.7）

| 服务端回应 | 0.2.6 | 0.2.7 |
| --- | --- | --- |
| 429／5xx／超时／网络错误 | 退避重试 | 不变 |
| 上传请求被 400／413／422 拒绝（请求内容被拒），批次里有多条待回执 | 永久停住 | 批次拆开，接下来逐条发送；逐条发完后恢复 5 条一批 |
| 上传请求被 400／413／422 拒绝，批次里只有 1 条待回执 | 永久停住 | 这一条标为 `rejected` 留在本机，队列继续 |
| 401／403／404／409、查询回执被拒及其它不可重试错误 | 永久停住，无原因 | 仍然停住（这些是节点身份、授权或批次冲突，不是某一条内容的问题），但记下 `status`／`serverCode`／批次号／时间 |
| 重启后发现 0.2.6 留下的无原因 `blocked` | 永久停住 | 按新规则重试一次；仍被拒则按上面三行处理 |

已经拿到回执的事件在拆批时保持原样，不会重发。被隔离的事件不再计入待上传数，所以不会再触发 `outbox_backlog`，也不会卡住所属任务的完成回报（`flushCompletion` 只等本次任务仍在待上传的事件）。

## 验证

- Runner 新增 `test/outbox-poison-20261002.test.mjs`（10 项）：一批 7 条里 1 条被拒时只隔离这一条、其余 6 条全部上传（请求序列 5,1,1,1,1,1,2）；0.2.6 留下的 `blocked` 状态加一条 2,807 字事件 → 重试一次后隔离，后面的事件照常上传；拆批时已有回执的事件不重发；401／403／404／409 仍停住并记录原因，且不会自己重试；查询回执被拒不会隔离任何事件；503 只退避、逐条模式保留；错误响应只取机器码；`status`／`diagnose`／窗口提示不含标题原文；重启后仍能说出停住的原因；服务端校验接受完整长文案。
- Runner 全量（Node 24.12，串行）：220／220 通过。模块边界检查通过（90 个模块，最大 311 行）。
- 根目录回归（Node 24.12）：3,227／3,227 通过。独立工作目录里没有未纳入版本库的 `extension-build/`，需要先链接主工作区那一份；不链接时只有读取该目录的 `tests/capture/douyin-blogger-profile-scope.test.mjs` 失败，与本次改动无关。
- 服务端测试：`capture-discovery-backend`（2,807 字通过、20,001 字被拒）、`capture-discovery-ui-binding`（长文案全文匹配成功、截到 2,000 字则匹配失败）。
- 后台：`tsc` 通过，lint 基线 280 ≤ 288。

## 已知限制（未在本次处理，供决定）

- **系统性拒收会逐条隔离。** 如果服务端因为版本不匹配等原因对所有事件都返回 400，0.2.7 会把它们逐条标为 `rejected`（内容都留在本机，可恢复），而不是像以前那样停住并很快表现为「每个词秒失败」。窗口和 `diagnose` 会持续提示，但调度中心上不如以前显眼。可选的加固：连续隔离达到某个数量后改为停住并报原因。未经确认没有加。
- **按条的 403／409** （例如 `ATTEMPT_LINEAGE_MISMATCH`）仍按整队列停住处理。目前没有观察到实际发生。
- 被隔离的 3 条事件属于已经结束的任务轮次，即使以后重新放回队列，按现有规则预计也只会被当作迟到证据保留（未实测）。该作品在下一轮「别克哨兵」会被重新发现；服务端上限放宽上线前，每轮会再隔离 1 条。

## 部署与本机处置

见本文件后续追加的记录。
