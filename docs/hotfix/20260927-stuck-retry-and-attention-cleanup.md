# 弹性重试死等、时间筛选失败反复重搜、「需处理」无法清理 hotfix（20260927）

分支 `codex/hotfix-stuck-retry-cleanup-20260927`，基线 `e791483`（生产：服务端 `fe74ec5`，扩展 0.4.18 已公告，17 个节点都是 0.4.18）。只改服务端和 Admin，**不改扩展、不加迁移**。节点和手机 Runner 不用升级，旧节点不受影响。

**状态（2026-09-27）**：实现完成，两轮评审通过；集成验证通过；发布包已备好，**未推送、未部署**。代码提交是 `dab3773`，发布提交是本文所在的提交，它在 `dab3773` 之上只加了本文。部署需要用户在对话里点名生产主机。

本文前半部分是设计，写给实现和评审；按最终实现修订过，行号以 `e791483` 为准（`server/routes/capture-cloud.js` 简称 `cc.js`，`server/routes/capture-orchestrations.js` 简称 `co.js`）。后半部分是最终实现、验证、发布包、上线、回滚和运营操作：

- [最终实现](#最终实现与设计的差异和评审后追加的修复)
- [验证](#验证)
- [发布包](#发布包)
- [上线步骤](#上线步骤)
- [运营操作（上线后怎么点）](#运营操作上线后怎么点)

## 现场（2026-09-27 11:16，生产只读诊断）

诊断 SQL 和输出在 scratch `idle0927/diag.sql`、`diag.out`，整个事务回滚。

### 批次 408d1410「小红书~日常+负面巡检 · 09/27 03:30」

- `capture_orchestration`，`elastic_pool`，按关键词领取。池 `eligibleAgentIds` = 8 个小红书节点：上海、北京、成都、重庆、木星、火星、金星、霸王龙。状态 `needs_action`，最后更新 05:08:47。
- 工作项：16 个关键词完成，24 条负面帖子完成；5 个关键词 `retryable`，2 个关键词 `needs_action`。

| 关键词 | 状态 | 恢复 | 失败原因（每次都一样） | 本轮已试节点（按顺序） |
|---|---|---|---|---|
| 安吉星壁纸 | retryable | 7/16 | `XHS_SEARCH_TIME_FILTER_UNVERIFIED`「结果卡片 0/基线 20；等待 8 秒」 | 火星、成都、霸王龙、重庆、金星、北京、木星 |
| 上汽通用客服、月兔栖梦、君越壁纸、昂科威壁纸 | retryable | 6/16 | 同上 | 霸王龙/成都/重庆/金星/北京/木星 这 6 台 |
| 别克哨兵 | needs_action | — | `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`（火星） | 火星 |
| ibuick | needs_action | — | `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`（上海） | 上海 |

- 最后一次尝试是木星 04:12–04:30 逐个跑的，此后再没有任何领取。
- 各节点能否领取（b1）：
  - 上海、火星：被**本批次自己的**两个 needs_action 子任务挡住（停止保护，待确认停止）。它们正是这 5 个词本轮仅剩的未尝试节点：安吉星壁纸只剩上海，另外 4 个词剩上海和火星。
  - 其它 6 台：`items_exhausted`，本轮排除 5 个词（木星同时是来源节点）。
  - 另外 9 台在线节点只负责抖音或是手机（`platform, not_in_pool`）。
  - 没有槽位占用，没有长事务，没有竞争队列。

### 时间筛选失败的形态

- 这 5 个词每个都在 6–7 台不同节点上以同一形态失败：筛选后卡片 0 张，基线 20/27/29 张，8 秒超时。每个词此前都在某一台节点成功过一次（多为上海，保存 20 条）。
- 近 7 天的小红书关键词：确认为空的成功路径（`ok_confirmed_empty`）每天都是 0 次，从没走到过；时间筛选失败每天 8 → 18 → 31 次。24 小时内 42 次，涉及 7 台节点、8 个词。
- 扩展把这个错误标成非致命：`fatal`、`stopBatch`、`requiresManualAction` 都是 false，`category=filter_verification`（`createXhsSearchTimeFilterError`，`utils/capture/xhs-search-filter-evidence.js:162-173`）。服务端不认识这个码，按技术失败处理，所以是可重试的：一个词最多能在不同账号上搜 16 次，增加风控暴露。
- 大概率是小红书「一天内」在夜里的真实空结果页没被识别，或者结果容器被整个重挂。识别要拿真实 DOM 证据改扩展，**不在本次范围**；本次只在服务端止损。

### 「需处理」里的 24 条根任务，界面和 API 都移不走

| 类型 | 条数 | 情况 | 为什么没有出口 |
|---|---|---|---|
| `discovered_post_capture`「手机发现作品补详情」 | 11 | 均为 needs_action，`detail_finished_without_ingestion`，浏览器报 failed。候选 failed（1 条 already_exists），需求 needs_action，未请求停止 | 继续只接受 `unattended` 类型；换空闲设备不收这个类型；停止要求 `source='cloud'`；移到历史只收 failed/completed_with_failures |
| `capture`「抖音手机发现」（`android_runner`） | 8 | 09-24 17:42 的手机旧运行 | 同上，且手机 run 的截止时间已过，不能继续 |
| `capture`「提前」（`sidebar`） | 2 | `MANUAL_BATCH_PAGE_CLOSED`（火星、金星 09-24 21:11） | 同上 |
| `capture_orchestration` 手机批次 | 2 | 「手机」09-26 20:04 和「手机采集」09-26 12:24。工作项都是 needs_action 或 completed，没有手机占用 | 同上 |
| `capture_orchestration` 小红书批次 | 1 | 上面的 408d1410，仍有 retryable 工作项 | 同上 |

- 单条「移到历史」（`cc.js` 12845–12917）和批量「清理已结束失败项」（12919–12979）只收 `failed`/`completed_with_failures`（`DISMISSIBLE_ATTENTION_STATUSES`，169–172）。
- `/history/clear`（10533–10612）拒绝 needs_action 和 interrupted，而且整批全有或全无（最多 100 条）。历史页里有一条 09-08「负面帖子巡查」已取消的编排 8529ec28，树里还挂着一个未结束的工作项。所以「全选本页」整批失败。
- 没有删除接口，也没有过期机制。
- 用原始 API 停止补详情行会下发一个 stop：浏览器回答 not_found，这条 stop 反而挡住准入（风险），还会让迟到回执的恢复失效。

## 根因

### 1. 重试轮次在未尝试节点领不到时永远等下去

- 预算：`agent_attempt_limit` N = |eligibleAgentIds ∪ relayAgentIds| = 8（`elasticParentAgentAttemptLimit`，`cc.js` 1514–1532；领取 SQL 里有同样的一份，7370–7400）。预算 = N × `ELASTIC_TECHNICAL_RETRY_ROUNDS`(2) = 16（298、1666）。
- 领取只在完整 `/agent/heartbeat` 里做，每次心跳最多领 1 项：`dispatchNextElasticWorkItemWithinBudget`（7223 起，候选 SQL 7312–7591）。
  - **轮次排除**：最近 `MOD(attempt_count − manualRetryBaseAttemptCount, N)` 次尝试的节点不能领（7541–7561）。
  - **来源排除**：来源节点始终不能领（7562–7565）。
  - 所以第 2 轮只在 `attempt_count = N` 时才打开。
- `recovery.nextEvaluationAt`、`sourceAgentSameItemRetryAfter` 会写入（`buildElasticRecoveryMetadata`，1593–1713），但没有任何地方读。
- 停止保护在候选 SQL 之前就挡掉节点：`findCaptureAgentExecutionSlotBlocker` → `captureTaskUnconfirmedLocalStopSql`（`services/capture-cloud.js` 1019–1135，约 275 ms）。被挡的节点根本到不了候选 SQL。
- 结果：本轮只剩被停止保护挡住（或离线、暂停、一直忙）的节点没试过时，这个词没人能领，批次一直停在 needs_action。
- 「重试失败关键词」拒绝弹性池里 retryable 的工作项（`co.js` 5795–5804，`retry_items_managed_by_elastic_dispatcher`），人也插不上手。

### 2. 确定性的时间筛选失败被当成技术失败重试到 16 次

`projectElasticKeywordRecoveryStatus`（`cc.js` 1253–1306）只区分安全失败和技术失败。`XHS_SEARCH_TIME_FILTER_UNVERIFIED` 不是安全失败，`attempt_count < 16` 时一律是 `retryable`。这个失败在同一个词上跨节点重复出现，说明问题在页面或时段，不在节点，但服务端会一直换节点重搜。

### 3. 没有活可干的 needs_action 根任务没有出口

见上表。这些行没有进行中的子任务、工作项或指令，也没有能「继续」的路径，但所有出口都要求状态是 failed/completed_with_failures。

### 4. 历史清除全有或全无

`/history/clear` 对整批请求算一个 `blocked`，任何一行不能清就整批 409。

## 修复总览

| 编号 | 做什么 | 触发点 | 主要文件 |
|---|---|---|---|
| F1 | 交接超过 10 分钟没人领，本轮排除放宽到「除上一次执行的节点外，池内任意节点」 | 领取 SQL 里的常数谓词 | `cc.js` 领取 SQL；Admin 恢复卡文案 |
| F2 | 同一批次同一词在当前重试窗口内时间筛选失败满 K=3 次（重复节点也计次），或不同节点数达到 min(K, N)，结算为 failed | 失败投影时；存量工作项在领取时按批次一次性兜底 | `cc.js` 两处投影和领取；`co.js` 重试失败关键词 |
| F3 | 新操作「结束并移到历史」（单条和批量「清理无法继续的任务」），只收 needs_action 根 | 操作员手动 | 新服务 `capture-operator-close.js`；`cc.js` 新路由、overview、镜像保护、本地恢复接管和「继续」的防护；Admin |
| F3b | `/history/clear` 跳过不能清的行并逐行说明原因 | 操作员手动 | `cc.js`；Admin 历史页 |

新常量和环境变量（新文件 `server/services/capture-elastic-policy.js`，两个路由文件共用）：

| 名称 | 默认 | 环境变量（越界或非法时用默认值） |
|---|---|---|
| `elasticRoundRelaxAfterMs()` | 10 分钟 | `CAPTURE_ELASTIC_ROUND_RELAX_MINUTES`，整数，1–1440 |
| `elasticFilterVerificationLimit()` | 3 | `CAPTURE_FILTER_VERIFICATION_LIMIT`，整数，2–20 |
| `ELASTIC_FILTER_VERIFICATION_CODES` | `{'XHS_SEARCH_TIME_FILTER_UNVERIFIED'}` | 无，只收这一个码 |

两个函数调用时读取 `process.env`，写法与 `stopFenceAutoCheckEnabled(env)` 相同。改环境变量后重启进程即可调整，不用发版。

---

## F1：本轮排除超时放宽

### 规则

工作项同时满足下面两条时，本轮排除放宽：

- 状态为 `retryable`；
- 交接锚点早于 `now() − elasticRoundRelaxAfterMs()`。

放宽后，排除窗口从 `MOD(attempt_count − base, N)` 缩成 `LEAST(1, MOD(attempt_count − base, N))`：只排除最近一次尝试的节点。

其它条件一律不变：
- 来源排除 `item.assigned_agent_id IS DISTINCT FROM $2` 不变，所以同一节点不会连续两次跑同一个词；
- 16 次预算、池成员（eligible/relay）不变；
- 平台和能力门槛、安全失败的「同词同账号永久隔离」不变；
- 停止保护和槽位（`findCaptureAgentExecutionSlotBlocker`，每次心跳 1 次）不变；
- 源执行已释放、没有未结指令这两条也不变。

没到阈值时行为与现在完全一样。第 2 轮（`MOD = 0`）本来就不排除，`LEAST(1, 0) = 0`，不受影响。固定节点（pinned，N = 1）的 `MOD(x, 1) = 0`，也不受影响。

「没有未尝试节点领走」不用单独判断：一旦被领取，`attempt_count` 加 1，失败后重新写入交接锚点，计时从头开始。

### 交接锚点

锚点 = 下面三个值里**有效值的最大者**（`GREATEST`，忽略 NULL）；三个都没有时才用 `item.updated_at`：

1. `item.metadata.checkpoint.recovery.handoffReadyAt`（主投影路径写入，`buildElasticRecoveryMetadata` 1670）；
2. `item.error.recovery.handoffReadyAt`（活动关键词路径写入，6375–6378）；
3. `item.metadata.elasticRetryWaitingSince`（「重试失败关键词」弹性等待分支写入，`co.js` 6149）。

不能按顺序取第一个，因为旧锚点会留在工作项上：
- 「重试失败关键词」的等待分支（`co.js` 6132–6160）把工作项改回 retryable，不动 `error` 和 `metadata.checkpoint`；
- 直接下发分支（`co.js` 5975–6010）清空 `error`，但保留 `metadata.checkpoint`，之后活动关键词路径只写 `error.recovery`；
- F2 的领取兜底如果照搬 `...error`，也会留下旧的 `recovery`。

按顺序取会拿到 04:30 这类旧锚点，人工重试后立刻放宽，已经失败过的节点抢在未尝试节点之前领走。所以：
- 取最大值：同一工作项上最新的交接或人工等待起点才算数；
- 领取 UPDATE（8132–8160）在已有的 `metadata - 'checkpoint' - …` 里再删掉 `elasticRetryWaitingSince`（只写不读，删掉没有读者受影响），保证它只代表当前这次等待；
- 手机领取（`android-control/leases.js` 的 `claimBoundItem`）同样删掉 `elasticRetryWaitingSince` 和 `checkpoint.recovery`，所以混合的抖音池里手机试过一次后，浏览器的放宽计时也从头开始；
- F2 结算时删掉 `checkpoint.recovery` 和 `error.recovery`（见 F2）。

`handoffReadyAt` 对同一次失败的重复快照保持不变（`sameRecoveryAttempt`），`updated_at` 会被重复快照刷新，所以只作兜底。`nextEvaluationAt`（锚点 + 60 秒）不用；它和 `sourceAgentSameItemRetryAfter` 仍旧只写不读，本次不动。

### 领取 SQL 改动（`cc.js` 7312–7591，`dispatchNextElasticWorkItemWithinBudget`）

在 `agent_policy` 之后加一个 LATERAL，只读当前工作项行，不查别的表。锚点表达式由 `capture-elastic-policy.js` 的 `elasticRoundAnchorSql('item')` 生成，领取 SQL 和测试共用：

```sql
    CROSS JOIN LATERAL (
      SELECT item.status = 'retryable'
        AND COALESCE(
          GREATEST(
            CASE WHEN item.metadata #>> '{checkpoint,recovery,handoffReadyAt}' ~ <TS>
              THEN (item.metadata #>> '{checkpoint,recovery,handoffReadyAt}')::timestamptz END,
            CASE WHEN item.error #>> '{recovery,handoffReadyAt}' ~ <TS>
              THEN (item.error #>> '{recovery,handoffReadyAt}')::timestamptz END,
            CASE WHEN item.metadata ->> 'elasticRetryWaitingSince' ~ <TS>
              THEN (item.metadata ->> 'elasticRetryWaitingSince')::timestamptz END
          ),
          item.updated_at
        ) <= now() - ($14::integer * interval '1 millisecond') AS round_relaxed
    ) item_round
```

- `<TS>` = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'`。`handoffReadyAt` 是 `toISOString()`（`Z`），`elasticRetryWaitingSince` 是 `jsonb_build_object(now())`（带 `+08:00` 这类偏移），两种都要收。
- 先用正则校验再转换，所以格式不对的值不会让整条领取报错。CASE 分支里依赖列值的转换不会被提前求值。写进 JS 模板字符串时，`\.` 要写成 `\\.`。
- 轮次排除（7557–7561）改成：

```sql
          AND current_round_attempt.reverse_attempt_ordinal <= CASE
            WHEN item_round.round_relaxed THEN LEAST(1, <原 MOD 表达式>)
            ELSE <原 MOD 表达式>
          END
```

- SELECT 列表加 `item_round.round_relaxed`；参数 `$14 = elasticRoundRelaxAfterMs()`。
- 领取事件 `elastic_work_item_dispatched`（8228）的 payload 加 `roundExclusionRelaxed: candidate.round_relaxed === true`，供上线后核对。

### Admin 恢复卡文案（`OrchestrationDetailWorkspace.tsx` 806–866）

只用页面已经加载的数据，不新增查询：
- `detail.orchestration.metadata`（eligibleAgentIds 和 relayAgentIds）；
- `detail.attempts`（每个工作项的节点和 attempt_number）；
- 工作项上的三个锚点字段、`updated_at`、`manualRetryBaseAttemptCount`、`assigned_agent_id`；
- overview 里的节点，含 `online`、`active_task_count` 和停止保护（`stopFencedAgentIds`，542–545）。

放宽阈值由批次详情接口返回：`GET /orchestrations/:id` 的响应（`co.js` 7270–7295）加 `elasticPolicy: {roundRelaxAfterMs}`，是个常量，不查库。老服务端没有这个字段时，Admin 按 10 分钟算。

新纯函数 `summarizeElasticRoundWait({item, attempts, poolAgentIds, agents, fencedAgentIds, relaxAfterMs, now})` 放在 `recovery-presentation.js`（同步补 `.d.ts`），算法与服务端 SQL 一致：

1. `N = pinned ? 1 : clamp(|pool|, 1, 20)`，`base = manualRetryBaseAttemptCount || 0`，`window = mod(attempt_count − base, N)`。
2. 本轮已试 = 按 attempt_number 倒序的前 `window` 次尝试的节点；未尝试 = 池 − 本轮已试 − 来源节点。
3. 给未尝试节点逐个标注：待确认停止、离线、已暂停、忙碌、不负责该平台。
4. `relaxAt = 锚点 + relaxAfterMs`，锚点规则与服务端相同（三个字段的最大值，都没有时用 `updated_at`）。

文案（`window > 0` 且不是固定节点时，替换 859 行的通用句）：

- 未到时间：`本轮未尝试的节点：上海（待确认停止）、火星（待确认停止）；超过 10 分钟未领取将开放给其他节点（约 04:25 起，原节点木星除外）`
- 已到时间：`本轮未尝试的节点（上海：待确认停止）超过 10 分钟未领取，已开放给除原节点木星外的其他节点，等待空闲节点领取`
- `window = 0`：`本轮池内节点都已尝试，已进入下一轮：除原节点外的节点都可领取`

---

## F2：时间筛选确定性失败，满 K 次后结算为失败

### 规则

同时满足下面几条时，这个工作项结算为 `failed`，不再自动重试：

- 弹性池里的关键词工作项；
- 投影结果本该是 `retryable`；
- 本次失败码是 `XHS_SEARCH_TIME_FILTER_UNVERIFIED`（取自 `error.code` 或 `checkpoint.errorCode`）；
- 在当前重试窗口内（含本次上报），以这个码失败的**次数** ≥ K，**或**不同节点数 ≥ min(K, N)。

K = `elasticFilterVerificationLimit()`。N < 2（固定节点）时不启用，保持原行为。

为什么也按次数算：有了 F1，池里只剩 A、B 两台能领时（其它节点被停止保护挡住、离线或一直忙），放宽后会变成 A、B、A、B… 交替。只按不同节点数算，计数一直停在 2，可以一直搜到 16 次预算用完。在 F1 之前，这种情况是 0 次搜索、一直等。按次数算，A、B、A 第 3 次就结算。N ≥ K 时「不同节点数 ≥ K」本来就蕴含「次数 ≥ K」，第二个条件只在池小于 K 时起作用：池只有 2 台，两台各失败一次就结算，不做第 2 轮。

当前重试窗口 = `attempt_number > max(manualRetryBaseAttemptCount, filterVerificationBaseAttemptCount)`，后者见下文「重试失败关键词」。

其它失败码（技术、安全、临时）行为完全不变；时间筛选失败没到阈值也不变。

### 计数 SQL（`capture-elastic-policy.js`）

`(item_id, attempt_number)` 上有唯一索引，最多 16 行：

```sql
SELECT COUNT(*)::integer AS attempts,
  COUNT(DISTINCT attempt.agent_id)::integer AS agents,
  COALESCE(BOOL_OR(attempt.agent_id = $4::uuid), false) AS includes_reporter
FROM capture_task_item_attempts attempt
WHERE attempt.tenant_id = $1
  AND attempt.item_id = $2
  AND attempt.agent_id IS NOT NULL
  AND attempt.attempt_number > $3
  AND attempt.attempt_number IS DISTINCT FROM $5::integer
  AND UPPER(COALESCE(attempt.error->>'code', attempt.checkpoint->>'errorCode', '')) = $6
```

- 投影时：`$4` = 本次上报的节点，`$5` = 本次尝试的 `attempt_number`（`serverAttemptCount`）。本次尝试行此时还是旧状态，同一次失败还可能被重复快照投影多次，所以把它排除在 SQL 外，在 JS 里算 `attempts + 1`、`agents + (includes_reporter ? 0 : 1)`，重复投影不会多算。
- 领取兜底：`$4`、`$5` 传 NULL，不加 1。

### 接入点

1. **主投影**：`projectOrchestrationSnapshot`（6124–6150）。
   - 把 `error` 改成 `let`。
   - 算出 `status === 'retryable'` 后调用 `settleElasticFilterVerification(tx, {...})`。命中时 `status = 'failed'`，`error` 换成结算后的对象。
   - 后面的工作项 UPDATE（6153）和尝试行 UPDATE（6198）照常写入。`terminal` 为真，所以会写 `finished_at`；`buildElasticRecoveryMetadata` 对 failed 返回 `{}`，这条 UPDATE 整个替换 `metadata.checkpoint`，所以不留旧锚点。
2. **活动关键词投影**（6354–6364）：同样处理 `activeUnresolvedStatus`。这条路径的 UPDATE（6381 起）不一定替换 `metadata.checkpoint`，结算时额外 `#- '{checkpoint,recovery}'`。
3. **领取时兜底**：放在 `const nextCandidate = …`（7597）之后、负面帖子分支（7603）之前。
   - 只在候选是 `keyword` + `retryable`、并且 `candidate.item_error.code` 在码集合里时才进入；其它候选只多一次 JS 判断。
   - 进入后**按批次一次性结算**，不是一项一项来：
     - 一条语句锁住该父任务下所有 `item_type='keyword' AND status='retryable'` 且 `error.code` 在码集合里的工作项（按 id `FOR UPDATE SKIP LOCKED`，别的心跳正在领的项直接跳过，不等锁），用上面的计数（LATERAL，每项最多 16 行）逐项判断，达到阈值的改成 `failed`（条件带各自的 `assignment_revision`），同时 `metadata = metadata #- '{checkpoint,recovery}'`、`error = (error - 'recovery') || <结算字段>`，不留旧锚点；
     - 这些工作项的最近一次尝试行（`attempt_number = attempt_count AND status='retryable'`）改成 `failed`；
     - 有结算时 `refreshOrchestrationParentTask` 只调 1 次；每个结算的词写 1 条事件；
     - 候选本身没被结算时，照常往下走正常领取（同批次里被结算的别的项已在同一语句里处理）。候选被结算时才重新选候选，见下。
   - 结算后重新选候选：`return dispatchNextElasticWorkItemWithinBudget(tx, {…, slotChecked: true}, remainingSkipBudget − 1)`。
     - 新参数 `slotChecked`：为 true 时跳过函数开头的 `findCaptureAgentExecutionSlotBlocker`（内含约 275 ms 的停止保护 SQL）和 `recentRecoveryAttempt` 查询。这两项只决定「本节点这次心跳能不能领」，结果不进候选 SQL；本次心跳第一次调用已经判断过，同一事务里结算别的工作项不会改变这个节点的槽位。
     - 函数里其它递归（负面帖子「已归档跳过」、`nextCandidate`、跳过预算用完后的 targeted 回退）也一并传 `slotChecked: true`。结果不变，只是不再重复这两项查询。
     - 所以一次心跳里停止保护 SQL 最多跑 1 次，不管结算多少项。
   - 不建子任务、不发指令、不搜索。
   - 它只为存量工作项服务（上线时 408d1410 这 5 个词已有 6–7 次失败）。新工作项在投影时就结算了，不会走到这里。

结算后的 `error`（两条投影路径同样先删掉 `recovery`）：

```js
{
  ...errorWithoutRecovery,                    // 保留 code、category 等原字段
  message: '多台节点都无法确认小红书时间筛选结果（可能该时段没有新内容或页面有变化），已停止自动重试；可稍后在批次里「重试失败关键词」',
  originalMessage: error.message,
  automaticRetryStopped: true,
  automaticRetryStopReason: 'filter_verification_repeated',
  filterVerificationAttemptCount: attempts,
  filterVerificationAgentCount: agents,
  filterVerificationLimit: K,
}
```

不写 `recoveryLimitReached`。否则 Admin 会隐藏「前往“重试失败关键词”」（`OrchestrationDetailWorkspace.tsx` 1335）。

事件：父任务上写 `elastic_item_filter_verification_settled`。
- message：`关键词「X」时间筛选已失败 N 次（M 台节点），无法确认小红书时间筛选，已停止自动重试`
- payload：`{itemId, keyword, errorCode, attemptCount, agentCount, limit, settledAt: 'projection'|'claim'}`

### 父任务、计划、负面巡查的一致性

- 工作项结算后，由原有的 `refreshOrchestrationParentTask`（4531–4923）重算父任务：投影路径在函数末尾统一刷新（6556），领取兜底显式刷新一次。
  - 全部结算时 `aggregateParentTaskItems`（`services/capture-orchestration.js` 898–975）给出 `completed_with_failures`，写 `finished_at`；
  - 计划批次把 `last_run_status` 改为 `completed_with_failures`，`last_error.code` 为 `scheduled_run_settled_with_failures`，模板文案为「上一轮多 Agent 任务有失败项，计划仍会按下一次时间运行」（4798–4903）；
  - 带负面巡查的批次文案为「本轮关键词采集与负面巡查已结算」（4733–4738）。
- 负面帖子工作项有自己的领取和结算，F2 只作用于 `item_type='keyword'`，不碰它们。
- 408d1410 里还有 2 个 needs_action 的停止保护词，所以这 5 个词结算后批次仍是 needs_action。见「上线后会发生什么」。

### 「重试失败关键词」要能用

- 结算后工作项是 `failed`，在 `RETRY_ITEM_STATUSES` 里，不会再被 `retry_items_managed_by_elastic_dispatcher` 拒绝。源执行（木星的子任务）是 `completed_with_failures`，满足 `retry_source_not_settled` 的检查。
- 问题是：人工重试后，失败计数如果还按全部历史算，下一次时间筛选失败会立刻又结算，领取兜底也会把排队中的项直接结算掉。所以 `retry-items` 在两处写入重试窗口起点 `filterVerificationBaseAttemptCount = attempt_count`（更新前的值）：
  - 直接下发（`co.js` 5975–6010）：在 `jsonb_build_object('retrySourceExecutionTaskId', …)` 里加一项；
  - 弹性等待（`co.js` 6132–6160）：在 `jsonb_build_object('elasticRetryWaitingSince', …)` 里加一项。

  之后人工重试的这一次，以及随后的自动接力，重新拥有 K 次的窗口，16 次总预算不变。
- 等待分支里 F1 的锚点是刚写的 `elasticRetryWaitingSince`（取最大值），本轮没试过的节点（如上海）重新拥有 10 分钟的优先时间，之前失败过的节点不会立刻抢走。
- 「重试失败关键词」可以逐项指定节点（`assignments`）。本批次里上海曾成功过这几个词，运营可以直接指定它。
- 负面巡查的「恢复」（`co.js` 5445–5532）写的是 `manualRetryBaseAttemptCount`，F2 的窗口起点取两者较大值。
- 评审发现的缺口（已修，`7f2bcff`）：408d1410 结算后，Admin 会把「别克哨兵」「ibuick」也一起提交。它们的原执行仍是 needs_action（停止保护），服务端整单返回 409 `retry_source_not_settled`。Admin 现在用与服务端相同的来源闸门（`manualKeywordRetrySourceSettled`），只提交服务端会接受的词；原执行仍为需处理的词单独列出，提示先在「执行节点」「确认旧页面已停止」。

### 关于 K=3 的风险（发布前必须核对）

诊断 c2 里，「君越车机壁纸」24 小时内在北京、成都、重庆 3 台时间筛选失败，而在上海和北京成功。如果这些失败和上海的成功属于同一批次，K=3 会让这个词在上海之前就停下。发布前用下面的只读 SQL 回放近 7 天（小红书池是 8 台，N ≥ K，所以只看次数）：

```sql
-- 近 7 天：先有 ≥3 次时间筛选失败、之后又在同一工作项里成功的关键词（K=3 会误停的）
BEGIN READ ONLY;
WITH att AS (
  SELECT a.item_id, a.attempt_number, a.agent_id, a.status,
    UPPER(COALESCE(a.error->>'code', a.checkpoint->>'errorCode', '')) = 'XHS_SEARCH_TIME_FILTER_UNVERIFIED' AS tf
  FROM capture_task_item_attempts a
  JOIN capture_tasks p ON p.id = a.parent_task_id AND p.tenant_id = a.tenant_id
  WHERE a.tenant_id = '457e5851-93eb-4446-84e5-eb6ddb871e65'
    AND p.platform = 'xiaohongshu'
    AND a.created_at > now() - interval '7 days'
), ok AS (
  SELECT item_id, MIN(attempt_number) AS ok_at FROM att
  WHERE status IN ('completed', 'completed_with_warnings') GROUP BY item_id
), before_ok AS (
  SELECT ok.item_id, ok.ok_at,
    COUNT(*) FILTER (WHERE x.tf) AS tf_attempts_before_ok,
    COUNT(DISTINCT x.agent_id) FILTER (WHERE x.tf) AS tf_agents_before_ok
  FROM ok JOIN att x ON x.item_id = ok.item_id AND x.attempt_number < ok.ok_at
  GROUP BY ok.item_id, ok.ok_at
)
SELECT i.keyword, p.title, b.ok_at, b.tf_attempts_before_ok, b.tf_agents_before_ok
FROM before_ok b
JOIN capture_task_items i ON i.id = b.item_id
JOIN capture_tasks p ON p.id = i.task_id
WHERE b.tf_attempts_before_ok >= 3;
ROLLBACK;
```

有结果时把 K 调到结果里最大的 `tf_attempts_before_ok + 1`，通过 `CAPTURE_FILTER_VERIFICATION_LIMIT` 设置，不用改代码。去掉 `ok` 的限制、统计每个工作项超过 3 次之后的时间筛选失败次数，就能估算能省下多少次搜索。

---

## F3：「结束并移到历史」

### 资格（同一个函数，overview 显示时和执行前都用它判断）

新服务 `server/services/capture-operator-close.js`：
- 导出 `loadOperatorCloseEligibility(tx, tenantId, rootIds)`，返回 `Map<rootId, {eligible, reason}>`；
- 一条 SQL，对根任务做递归子树（同 `/history/clear` 的 `task_tree`，带 `root_id`）；
- **不调用** `captureTaskUnconfirmedLocalStopSql`，也不调用 `findCaptureAgentExecutionSlotBlocker`。

按顺序判断，命中第一条即不可结束，返回对应原因码：

| 原因码 | 条件 |
|---|---|
| `not_root` | 有 `parent_task_id` |
| `interrupted` | 根是 interrupted |
| `status_not_closeable` | 根状态不是 needs_action；或者是计划模板或草稿 |
| `stop_fence` | 树里有任务：`UPPER(error->>'code')='PREVIOUS_CAPTURE_STOP_UNCONFIRMED'`，状态不在 canceled/completed/completed_with_warnings/skipped 里，且没有 `recoveryTaskId`（即准入谓词里不贵的那部分，是真实停止保护的超集）；或者树里有工作项带这个码，且状态不是完成、跳过、取消 |
| `stop_pending` | 树里有任务的 `metadata.stopPending`、`legacyPackStopPending` 或 `stopIdentityUnavailable` 为 `'true'` |
| `live_child` | 除根以外，树里有任务状态为 pending、waiting_device、claimed、running、recovering、interrupted、resume_requested、stop_requested |
| `live_command` | 树里有 pending/acknowledged 且未过期的指令 |
| `device_held` | 树里有工作项的 `metadata.deviceHeld = 'true'` |
| `live_item` | 树里有工作项状态为 assigned、dispatch_pending、dispatched、waiting_device、running；或者带 `retryPending`；或者状态为 pending/retryable（例外：根是已停下的独立手机运行，见下） |
| `negative_patrol_needs_action` | 树里有 `metadata.unattendedNegativePatrol='true'` 且状态为 needs_action 的工作项 |
| `active_discovery_demand` | 树里任务作为 `run_id` 的 `capture_discovery_run_candidates` 中有 `demand_status='active'`（还有作品在等浏览器补详情） |

**不收 interrupted（与任务描述的范围不同，有意为之）**：`interrupted` 在 `CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES` 里（`services/capture-cloud.js` 997–1009），注释写明它要等正常结算证明扩展已停下才释放槽位。F3 把它改成 failed，节点就显得空闲，而旧页面可能还在跑。设备之后回报同一次执行在运行，也镜像不回来：镜像 WHERE（`cc.js` 6862–6874）拒绝同一 attempt 从终态回到 pending/claimed/running/recovering，槽位再也挡不住。所以 interrupted 的根返回 `interrupted`，interrupted 的子任务算 `live_child`。09-27 的 24 条里没有 interrupted。needs_action 不在槽位状态里，现有逻辑本来就认为它不占用浏览器，把它改成 failed 不改变槽位判断。

**负面巡查**：带 `unattendedNegativePatrol` 的工作项进入 needs_action 时，`unattended_negative_patrol_state.needs_action` 同时置 true（`cc.js` 5065、5277、5581）。领取 SQL 排除这种帖子（7439–7443），只有巡查成功或「恢复失败巡查」（`/negative-patrol/retry`，`co.js` 5445–5532）会清掉它。F3 如果把工作项改成 failed、把批次移进历史，这篇帖子会从以后所有无人值守负面巡查里静默消失，唯一的出口又在运营看不到的批次里。所以拒绝，让运营先在批次详情里「恢复失败巡查」。F3 不改 `unattended_negative_patrol_state`。

**独立手机运行例外**：根的 `metadata.workflow='douyin_mobile_discovery'`，工作项满足 `task_id = execution_task_id = 根`。这种运行的待领工作项只能在运行状态为 pending/running 时被领取（`android-control/leases.js` 的 `findAssignedCandidate`）。根已经是 needs_action，手机不会自己领取；只有运营点「继续」才会重新可领（截止时间已过的根本继续不了）。所以这些 pending/retryable 不算进行中，结束它等于运营放弃「继续」。

**停止保护**：F3 只动 needs_action 的行。带这个码的 needs_action 行一旦被改成 failed，停止保护照样生效（failed 不在准入谓词的豁免状态里），但「确认旧页面已停止」只接受 needs_action（`releaseNeedsActionStopFences`）。那样节点会被永久挡住，所以必须拒绝。superseded 且已经被后续执行证明停止的历史行（976a0c6 规则）也会被这个保守条件拦下，见「已知限制」。结束之后设备才回报这个码的情况，见「迟到回执、迟到快照」。

### 执行（`closeOperatorAttentionRoot(tx, {tenantId, rootId, actor, mode, refreshOrchestrationParent})`）

`refreshOrchestrationParent` 由路由注入，因为服务层不能 import 路由（`scripts/check-android-discovery-boundaries.mjs` 的约束，思路与 `android-control/parent-refresh.js` 相同）。每个根一个事务，`lockTimeoutMs: 2000`，超时返回 409 `task_busy`。

1. 不加锁读出子树 id。锁的顺序与心跳一致（先子任务后父任务，`co.js` 5702 的注释）：子任务按 id `FOR UPDATE` → 根 `FOR UPDATE` → 子树工作项按 id `FOR UPDATE`。
2. 根**仍处于结束状态**时，直接返回 `{idempotent: true}`。「仍处于结束状态」= `metadata.operatorClose.closedAt` 存在，且状态是 failed/completed_with_failures（服务里导出 `operatorClosedTask(row)` 和对应的 SQL 片段，下面的防护都用它）。只看 `operatorClose` 不够：行可能被设备迟到回报重新打开（见下），或者编排根被「重试失败关键词」重新打开，`operatorClose` 仍留在 metadata 里作审计。
3. 加锁后重新算资格；不可结束则回滚并返回原因。
4. 工作项（`task_id` 在树里）：
   - `needs_action` → `failed`；
   - 已停下的独立手机运行里的 pending/retryable → `canceled`：从没执行过，和手机自己的「停止」对未占用工作项的处理一致（`android-control/tasks.js` 38–41）；
   - 两种都写 `error = error || {operatorClosed: true, originalStatus, operatorClosedAt}` 和 `finished_at`；
   - 两种都 `assignment_revision = assignment_revision + 1`（与负面帖子「已归档跳过」、关键词覆盖结算相同），并删掉 `metadata.attemptId`、`metadata.leaseId`（手机工作项才有）。这样手机迟到的完成、续租、关闭上报在 `currentAttempt`（`leases.js` 214）里都不再是当前尝试，返回 `STALE_ATTEMPT`；浏览器本地恢复接管按 `assignment_revision` 连尝试行（`cc.js` 4210–4217），也连不上；
   - 其它状态不动。
5. 这些工作项里状态为 needs_action/interrupted 的尝试行 → `failed`，`error` 追加同样三个字段。
6. 状态为 needs_action 的子任务 → `failed`（interrupted 的子任务在资格里已被 `live_child` 挡掉）：
   - `message='已由操作员结束（未重新采集）'`，写 `finished_at`；
   - `metadata.operatorClose = {closedAt, closedBy, closedByUserId, originalStatus, originalError, originalMessage, attemptNumber, rootTaskId, mode}`。
7. 根：
   - **非编排根** → `failed`，写入同样的 `operatorClose`，`message='已结束并移到历史（未重新采集）'`，`finished_at = COALESCE(finished_at, now())`，`attention_dismissed_at/by_user_id/by_name` 填当前操作员，`error` 保持原样。
   - **编排根** → 调注入的 `refreshOrchestrationParentTask`（根已加锁）。
     - 此时所有工作项都已结束，聚合结果是 `completed_with_failures`；计划批次的 `last_run_status` 和模板文案同步更新，不另写一套。
     - 再写 `operatorClose`、`attention_dismissed_*`，`message` 改为「已由操作员结束并移到历史；未完成的工作项已标记失败，已完成结果保留」。
     - 刷新后如果不是终态（理论上不会发生），抛错回滚，原因 `live_item`。
     - 这里**有意不写 `failed`**：编排父任务的状态永远由工作项聚合得出。直接写 failed 会和计数（「手机」有 5 个完成项）、计划的 `last_run_status` 对不上。`completed_with_failures` 同样是终态，同样不能继续，同样在历史里。
8. 在根上写事件 `task_operator_closed`（actorType user，带操作员姓名）。payload：`{originalStatus, mode: 'single'|'bulk', closedChildTaskIds, failedItemCount, canceledItemCount, failedAttemptCount}`。另写一条 `audit_logs`：`action='capture_task.operator_closed'`，`target_type='capture_task'`，metadata 里有 `actorName`、`title`、`taskType`、`originalStatus` 和上面的计数，写法同 11071。
9. 返回后调用 `clearCaptureOverviewProjectionCache()`。

不做的事：不发任何设备指令，不碰 `capture_discovery_candidates`、`capture_discovery_run_candidates`、`unattended_negative_patrol_state`（有需处理的负面巡查帖子时整棵树被拒绝，见资格），不改 `historyClearedAt`，不触发需处理通知（`capture-attention-notifier.js` 只在进入 needs_action 时通知）。

### 各类行的结果

| 行 | 结束后 | 之后还能做什么 |
|---|---|---|
| 补详情（11） | 任务、工作项、尝试行都是 failed；候选仍是 failed/already_exists，需求仍是 needs_action，都不重新排队 | 手机批次里「重新处理」照常可用：它要求候选没有 record_id、不在 capturing、需求不是 canceled（`management.js` 113–123） |
| 抖音手机发现（8） | 运行 failed；needs_action 的词 failed，没开始的词 canceled；工作项 revision 加 1，`attemptId`/`leaseId` 清掉 | 手机「继续」返回 `RUN_NOT_RESUMABLE`；手机迟到的完成上报返回 `STALE_ATTEMPT`（`completion.js` 29，靠 revision 和 `attemptId`；资格里的 `device_held` 保证结束时没有手机占用） |
| 提前（2） | failed | 同一次执行迟到回报 needs_action/failed 被镜像保持挡住；回报停止保护码或 interrupted 时重新回到「需处理」（见下） |
| 手机/手机采集（2） | 父任务 `completed_with_failures`，子任务和 needs_action 的词都是 failed，工作项 revision 加 1 | 父任务已是终态，手机领取（`claimElasticItem` 只看 pending/running/needs_action）和浏览器领取都不会再选它；手机迟到上报 `STALE_ATTEMPT`；手机侧的父任务刷新遇到终态直接返回（`orchestrationParentAcceptsProjection`） |
| 408d1410 | **拒绝**：`stop_fence`（两个停止保护词）；F2 结算前还有 retryable 的词（`live_item`） | 由 F1、F2 和「确认旧页面已停止」收尾 |

### 迟到回执、迟到快照、本地恢复、「继续」都不会让任务复活成残留

- **补详情的迟到入库回执**：`recordDiscoveryIngestion`（`detail-receipt.js` 26–31）对 failed 的任务抛 `DISCOVERY_RECEIPT_NOT_CURRENT`（409），这是现有行为。记录不会入库，任务、候选、需求都不变，不会 500。这些行最晚一条也是 09-26 20:44 结束的，现在几乎不可能再有回执；真要补，就用「重新处理」。
- **补详情的迟到快照**：心跳镜像之后会调用 `projectDiscoveryTaskResult`（`cc.js` 4934–4936），它会把任务重新写回 needs_action。
  - 修法：`detail-projection.js` 开头加一行，任务仍处于结束状态时 `return null`（文件 38 行，远低于 350 行的模块上限）。
- **所有被结束的行（含「提前」这类侧边栏任务）的迟到快照**：`mirrorTaskSnapshot`（6565 起）会用快照覆盖 status、error 和 metadata。改四处，都是常数开销：
  1. 设备上报的 metadata 里删掉 `operatorClose`：`normalizeCloudTaskSnapshot`（`services/capture-cloud.js` 793–794，和 `historyClearedAt` 放在一起）和 `mirrorTaskSnapshot` 开头（6576–6577）两处。设备不能伪造也不能清掉它。
  2. 合并 metadata 时，像 `historyClearedAt` 那样保留 `operatorClose`（6684–6694）。
  3. status CASE 的第一个分支（6657 起，放在 superseded 分支之前）加「保持」分支：

     ```sql
     WHEN capture_tasks.metadata->'operatorClose'->>'attemptNumber' = EXCLUDED.attempt_number::text
       AND capture_tasks.status IN ('failed', 'completed_with_failures')
       AND EXCLUDED.status IN ('needs_action', 'failed', 'completed_with_failures')
       AND UPPER(COALESCE(EXCLUDED.error->>'code', '')) <> 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
       THEN capture_tasks.status
     ```

     只有「仍处于结束状态的行、同一次执行、重复回报需处理或失败、不带停止保护码」才保持 failed。其它情况照常走原来的 CASE：
     - 带停止保护码的回报：扩展对未结束的本地运行，会在**同一次执行**上改报 needs_action + `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`，不加 attemptNumber（`background.js` 14840–14866）。如果保持 failed，而 `error = EXCLUDED.error` 照写，就会出现带停止保护码的 failed 行：准入照样被它挡住（failed 不豁免），「确认旧页面已停止」只收 needs_action 子任务（`releaseNeedsActionStopFences`），检查协议只处理 superseded 行（`capture-stop-fence.js` 905/1258），节点被永久挡住。所以这类回报必须让行回到 needs_action。
     - interrupted：它是占槽位的状态，照常镜像，服务端才知道旧页面可能还在跑。
     - 新的执行（attemptNumber 变了）：照常镜像。
     - 同一次执行回报 pending/claimed/running/recovering：被现有 WHERE（6862–6874）拒绝，不会写入。这是现有规则，也正是 F3 不收 interrupted 的原因。
  4. 仍处于结束状态的根任务被镜像重新打开（没走第 3 条的保持分支）时，同一条 UPDATE 里清掉 `attention_dismissed_at`，让它之后能回到「需处理」，而不是藏在历史里挡着节点。与 `cc.js` 13267、15522 重新打开父任务时的做法相同：

     ```sql
     attention_dismissed_at = CASE
       WHEN capture_tasks.parent_task_id IS NULL
         AND capture_tasks.metadata ? 'operatorClose'
         AND capture_tasks.status IN ('failed', 'completed_with_failures')
         AND NOT (<第 3 条保持分支的四个条件>)
       THEN NULL ELSE capture_tasks.attention_dismissed_at END
     ```

     这覆盖停止保护码、interrupted、新的执行（先 running、后来再 needs_action 也看得见）等所有重新打开的情况。

  重新打开的行状态是 needs_action/interrupted，不再「处于结束状态」，所以下面的防护都不拦它，原有出口照常可用：
  - 批次子任务带停止保护码：节点页「确认旧页面已停止」能释放它（needs_action 子任务 + 这个码）。父任务已是终态，交回批次时工作项不动（`cc.js` 11877 注释：a stopped or finished batch -> untouched）。
  - 根任务：回到「需处理」卡片，带原来的「继续」「停止」；F3 资格返回 `stop_fence` 或 `interrupted`。
- **编排子任务的迟到快照**：父任务已是终态，`projectOrchestrationSnapshot` 在 `orchestrationParentAcceptsProjection` 处直接返回。子任务行本身受上面第 3、4 条约束。
- **浏览器本地「继续」接管**：`adoptLocalOrchestrationRecovery`（4097 起）会接管 retryable/needs_action/**failed** 的工作项，只要父任务不是 canceled/superseded，并按没变过的 `assignment_revision` 连尝试行。F3 之后工作项会被改成 dispatched，挂在终态父任务下，投影和刷新都直接返回，永远结不了，历史清除又因 `live_work` 拒绝它，成了新的残留。两道防护：
  - F3 给工作项 revision 加 1（上面第 4 步），源尝试行连不上；
  - 在父任务检查（4185–4192）里加一条：父任务或 `sourceTask` 仍处于结束状态时直接 `return task`，不接管。
- **后台「继续」**：`/tasks/:id/resume`（16228 起）的 `RECOVERABLE_STATUSES` 含 failed，unattended 子任务可以被继续。在停止保护检查（16274–16281）之后加：任务本身或它的父任务（这里已经读了父任务）仍处于结束状态时，返回 409 `task_operator_closed`，文案「该任务已结束并移到历史，不能继续；需要重采请在批次里「重试失败关键词」或重新下发」。
- **顺序补全修复**：`evaluateIncompleteSequentialItemRepair`（3910）会跳过 `attention_dismissed_at` 非空的父任务。

### 接口

- `POST /capture-cloud/tasks/:id/operator-close`
  - 中间件：`requireTenantAccess, requireSessionUser, requireTenantWriter`，与移到历史相同；viewer 返回 403。
  - 200：`{ok, task: {id, status, attention_dismissed_at}, idempotent, message: '已结束并移到历史，采集结果已保留'}`。
  - 404：`task_not_found`，别的租户的 id 也是 404。
  - 409：`{error: 'task_not_closeable', reason, message}`、`task_not_root`、`task_busy`。
- `POST /capture-cloud/tasks/:id/resume` 新增 409 `task_operator_closed`（见上「后台继续」）。
- `POST /capture-cloud/tasks/operator-close`，body `{taskIds: [1..100]}`
  - 按 id 排序后逐个处理，每个根一个事务；某个根失败不会回滚其它根。
  - 200：`{ok, closedTaskIds, alreadyClosedTaskIds, skipped: [{taskId, reason}], message}`。
  - Admin 只提交 overview 里标为可结束的 id，就是确认框里列出的那些。
- `GET /overview`（10614–10880）：在 tasks 查询之后，对本页里 `parent_task_id IS NULL`、状态为 needs_action/interrupted、`attention_dismissed_at IS NULL` 的行调用一次 `loadOperatorCloseEligibility`，每行附加 `operator_close: {eligible, reason}`。沿用 reporting 连接、2 秒语句超时和 1 秒缓存，不另开连接。

### Admin

- `lib.ts`：
  - `canOperatorClose(task)`：条件是根任务、状态为 needs_action、没有被移到历史、`operator_close?.eligible === true`；
  - `operatorCloseBlockedText(reason)`；
  - 保持 `DISMISSIBLE_ATTENTION_TASK_STATUSES` 不变：`cloud-task-center-wiring.test.mjs` 593 和 `server-capture-cloud-contract.test.mjs` 4513 断言了它。
- `types.ts`：`CloudTask.operator_close?: {eligible: boolean; reason: string}`；批次详情响应加 `elasticPolicy?`。
- `TaskCard.tsx`：
  - 可结束时显示按钮「结束并移到历史」，并计入 `hasActions`；
  - 手机端没有别的主操作时，把它作为主操作；
  - 不可结束且有原因时，在卡片底部用浅色小字显示一行原因。
- 原因文案：

| 原因 | 文案 |
|---|---|
| `stop_fence` | 包含未确认停止的旧采集页面：批次子任务请在节点上「确认旧页面已停止」，单独的任务请先「继续」或「停止」 |
| `interrupted` | 任务被中断，节点上的旧页面可能仍在运行；请等节点结算，或先「继续」或「停止」 |
| `live_item` / `live_child` / `live_command` / `stop_pending` | 仍有进行中、排队或等待自动恢复的工作，结束后再处理 |
| `negative_patrol_needs_action` | 含需处理的负面巡查帖子，请先在批次详情里「恢复失败巡查」，否则这些帖子不会再被巡查 |
| `device_held` | 手机仍占用该任务，请先在手机页结束占用 |
| `active_discovery_demand` | 仍有手机发现作品在等待补详情 |

- `DispatchPage.tsx`（405–437、720–727）：
  - 单条确认框：`结束「${title}」并移到历史？\n· 不会重新采集，也不会向设备发送任何指令；\n· 已采集的内容、运行结果和执行记录全部保留；\n· 未完成的工作项会标记为失败，原状态和原因记录在任务详情里。`
  - 补详情另加一句：`该作品仍可在对应手机批次里「重新处理」。`
  - 顶部横条：可结束数 > 0 或可移到历史数 > 0 时显示；按钮「清理无法继续的任务（N）」放在「清理已结束失败项」旁边。
  - 横条说明：`以下任务已经没有进行中的工作，但状态停在“需要处理”，可以结束并移到历史；仍在自动恢复、或需要先确认旧页面停止的任务会保留。`
  - 批量确认框：`将 N 个无法继续的任务结束并移到历史？不会重新采集，也不会给设备发指令；采集结果保留。`
  - 完成提示：`已结束 X 个任务并移到历史；Y 个未处理（原因…）`

### F3b：`/history/clear` 跳过不能清的行

`cc.js` 10533–10612 改为逐行判断：

- 原来整批一个 `blocked` 的递归 SQL，改成带 `root_id` 的树加 `SELECT DISTINCT root_id`，查询和成本都与现在相同。
- 能清的行照常只写 `historyClearedAt/By` 两个键；不能清的行放进 `skipped: [{taskId, reason}]`：
  - `not_found`：不存在或属于别的租户；
  - `not_root`；
  - `not_in_history`：业务上不可见、不在历史里，或者是 needs_action/interrupted；
  - `live_work`：树里有进行中的子任务、工作项或指令。
- HTTP 状态：
  - 有任何一行清掉或本来已清：200，带 `skipped`；
  - 全部 `not_found`：404；
  - 其余全部跳过：409 `task_not_clearable`，带 `skipped`。
  - 响应仍保留 `clearedTaskIds`、`alreadyClearedTaskIds`、`clearedCount`。
- `HistoryView.tsx` 137–155：
  - 有 `skipped` 时提示 `已移出 X 条；Y 条未移出：仍有未结束的工作或仍需处理`，并让被跳过的行保持勾选，方便看出是哪几条；
  - 409 时显示同样的原因。
- 8529ec28 这类已取消但树里有未结束工作项的行会被跳过（`live_work`）。本次不修它的数据。

---

## SQL 成本

| 路径 | 频率 | 新增开销 | 是否用到停止保护 SQL（约 275 ms） |
|---|---|---|---|
| F1 领取候选 | 每个节点每次完整心跳 1 次 | 对每个候选行多算一个布尔：3 次 JSON 取值、正则、类型转换、GREATEST，不查别的表 | 否。每次心跳仍只在候选之前调 1 次 `findCaptureAgentExecutionSlotBlocker`，与现在一样 |
| F2 投影 | 关键词投影为 retryable 且是时间筛选失败时（09-27 全天 31 次） | 1 次按索引的计数，最多 16 行 | 否 |
| F2 领取兜底 | 仅当候选是存量的时间筛选 retryable 项；每个批次一生最多结算 1 次 | 1 条按批次的锁定加计数（批次内每个候选词最多 16 行），1 次工作项 UPDATE、1 次尝试行 UPDATE、1 次父任务刷新；然后带 `slotChecked` 重选 1 次候选 | 否。递归调用带 `slotChecked: true`，不再跑 `findCaptureAgentExecutionSlotBlocker` 和 `recentRecoveryAttempt`；一次心跳里停止保护 SQL 最多 1 次 |
| 镜像保护 | 每条快照 | status CASE 多一个分支（JSON 键比较、状态和错误码比较），`attention_dismissed_at` 一个 CASE，metadata 合并多一个键 | 否 |
| F3 overview 资格 | overview 加载时（1 秒缓存，单飞） | 1 条递归 SQL，只对本页需处理、中断的根（生产 24 条）。子树按 `idx_capture_tasks_parent_created`，工作项按 `idx_capture_task_items_task_status`，指令按 `(task_id, agent_id, command_type)`，需求按主键前缀。生产规模是 24 个根、约 80 个子任务、约 90 个工作项，估计几毫秒 | 否。overview 里原有的 `listCaptureAgentStopFences` 不变 |
| F3 执行 | 人工操作 | 每个根一次同样的资格 SQL，加锁和 UPDATE | 否 |
| F3b 历史清除 | 人工操作 | 与现在相同的递归 SQL，改成按根分组 | 否 |

实现后在本机回放库上对 overview 资格 SQL 和领取 SQL 各跑一次 `EXPLAIN (ANALYZE, BUFFERS)`，数据按 24 个根、408d1410 规模的子树准备，结果贴到本文「验证」。验收线：资格 SQL 低于 20 ms；领取 SQL 与改动前相差不超过 1 ms。

## 测试

### 单元（`node scripts/run-node-regression-tests.mjs`，新文件自动被发现）

- 新 `tests/capture-elastic-policy.test.mjs`：
  - 两个环境变量的解析：默认值、合法值、0、负数、小数、超上限、非数字；
  - `elasticFilterVerificationSettlement`：满 3 次才结算；A、B、A 第 3 次结算（重复节点计次）；N=2 时两台各 1 次就结算；N=1 不启用；非时间筛选码不结算；重复投影同一次尝试不多算；
  - 结算后的 error 字段和原文案逐字一致，不含 `recovery`；
  - 窗口起点取 `manualRetryBaseAttemptCount` 和 `filterVerificationBaseAttemptCount` 的较大值；
  - 锚点（JS 版，与 `elasticRoundAnchorSql` 同规则）：取三个字段的最大值；旧的 `checkpoint.recovery` 早于 `elasticRetryWaitingSince` 或 `error.recovery` 时取新的；`+08:00` 偏移格式能解析；三个都没有才用 `updated_at`。
- `tests/server-capture-cloud-contract.test.mjs`：源码断言。
  - 领取 SQL 含 `item_round.round_relaxed`，锚点用 `GREATEST` 并含 `elasticRetryWaitingSince`，放宽分支是 `LEAST(1, …MOD…)`；
  - 领取 UPDATE 删掉 `elasticRetryWaitingSince`；
  - 来源排除 `agent_policy.agent_attempt_limit = 1 OR item.assigned_agent_id IS DISTINCT FROM $2::uuid` 原样保留；
  - `findCaptureAgentExecutionSlotBlocker` 和 `recentRecoveryAttempt` 在 `if (!slotChecked)` 里；函数里每一处递归调用 `dispatchNextElasticWorkItemWithinBudget` 都带 `slotChecked: true`；领取兜底不调 `captureTaskUnconfirmedLocalStopSql`；
  - 镜像保持分支在 ELSE 之前，含 `capture_tasks.status IN ('failed', 'completed_with_failures')` 和停止保护码排除，不含 `interrupted`；`attention_dismissed_at` 的重新打开 CASE；metadata 合并保留 `operatorClose`；
  - `normalizeCloudTaskSnapshot` 删掉 `operatorClose`；
  - `adoptLocalOrchestrationRecovery` 和 `/tasks/:id/resume` 引用 `operatorClosedTask`。
- 新 `tests/capture-operator-close.test.mjs`：原因码与 Admin 文案一一对应（含 `interrupted`、`negative_patrol_needs_action`）；`operatorClosedTask` 只在有 `operatorClose` 且状态为 failed/completed_with_failures 时为真；工作项、尝试行、子任务的状态转换表（纯函数部分）。
- `tests/web-orchestration-recovery-presentation.test.mjs`：`summarizeElasticRoundWait` 用 09-27 夹具（8 个池节点、a5 的尝试序列）。
  - 安吉星壁纸 → 未尝试只有上海（待确认停止）；上汽通用客服 → 上海、火星；
  - `relaxAt = 锚点 + 10 分钟`，到点后 `relaxed = true`；人工重试等待中的项用 `elasticRetryWaitingSince`，不用旧的 04:30；
  - `window = 0` 时给出第 2 轮文案；固定节点返回 null。
- `tests/cloud-task-center-wiring.test.mjs`：
  - DispatchPage 调用两个 operator-close 接口；
  - TaskCard 只在 `canOperatorClose` 时出现「结束并移到历史」；
  - 批量按钮「清理无法继续的任务」；
  - HistoryView 读取 `skipped`。

### PostgreSQL 集成（本机 PG17，`onstarvoice_test_stuckretry_<后缀>`，`NODE_ENV=test --test-concurrency=1`）

新 `tests/integration/postgres/elastic-stuck-retry.integration.mjs`，夹具照 `sequential-search-recovery.integration.mjs` 和 `historical-stop-fence.integration.mjs` 的写法（`claim()` 和 `mirror()` 用真实的 `dispatchNextElasticWorkItem`、`mirrorTaskSnapshot`）。`claim()` 用包一层的 tx：统计 SQL 文本里含 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 的查询次数，即停止保护 SQL 的执行次数。

1. **09-27 回放（F1）**
   - 8 个小红书节点，名字同生产。父任务是 elastic_pool、needs_action，eligibleAgentIds 为这 8 个。
   - 关键词 X 为 retryable，attempt_count=6，由霸王龙、成都、重庆、金星、北京、木星各失败一次。用中性技术码 `XHS_SEARCH_PAGE_TIMEOUT`，把 F1 和 F2 分开测。源执行是木星的，`completed_with_failures`；`handoffReadyAt = now − 5 分钟`。
   - 上海、火星：本批次里各有一个 needs_action 子任务，带 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`，另有「别克哨兵」「ibuick」两个 needs_action 工作项。
   - 断言：
     - 8 个节点都领不到。
     - 锚点改成 now − 9 分钟，仍领不到。
     - 改成 now − 11 分钟：木星领不到（来源）；成都领到，第 7 次尝试；事件 `roundExclusionRelaxed=true`；上海、火星仍被挡。
     - 成都随即失败，投影后 retryable，锚点刷新。
       - 成都和北京都领不到：成都是来源，不能连续两次；北京被 `MOD(7,8)=7` 排除，还没到放宽时间。
       - 到点后北京能领，成都仍不能。
     - 旧锚点：`checkpoint.recovery.handoffReadyAt = now − 60 分钟`、`elasticRetryWaitingSince = now − 1 分钟`（人工重试进了等待）→ 不放宽，成都领不到；等待超过 10 分钟后才放宽。`error.recovery` 比 `checkpoint.recovery` 新时同理。
     - 旧工作项三个锚点都没有时，用 `updated_at` 兜底放宽。
     - 预算用满 16 次后，放宽了也领不到。
     - `CAPTURE_ELASTIC_ROUND_RELAX_MINUTES=1` 生效。
2. **时间筛选 K=3（F2）**
   - 4 个节点，一个计划批次（带 schedule 行和负面巡查标记），关键词 A、B。
   - A 依次在节点 0、1 以时间筛选码失败，都是 retryable；B 完成。
   - A 在节点 2 失败：
     - 工作项和尝试行都是 failed，文案逐字一致，`filterVerificationAttemptCount=3`，工作项上没有 `checkpoint.recovery`、`error.recovery`；
     - 父任务 `completed_with_failures`，计划 `last_run_status=completed_with_failures`；
     - 有事件；节点 3 没有可领的项。
   - 节点 0、1、0 依次失败：第 3 次结算。池 = 2 时两台各 1 次就结算。
   - **两台交替**：8 节点的池，只有 A、B 能领（2 台被本批次的停止保护子任务挡住，4 台离线）。A、B 各失败 1 次；锚点拨到 11 分钟前，A 领到并失败 → 结算为 failed；B 领不到。整个过程时间筛选搜索共 3 次（≤ K）。
   - 技术码在 3 台失败，仍是 retryable（原行为）。
   - 对 A 调 `POST /orchestrations/:id/retry-items`：
     - 201；工作项带 `filterVerificationBaseAttemptCount=3`；
     - 指定节点 3 再以时间筛选码失败 → retryable，不是 failed；
     - 等待分支：没有空闲节点时回到 retryable，领取兜底**不会**把它结算掉；F1 锚点是 `elasticRetryWaitingSince`，不会立刻放宽。
   - 存量兜底：同一批次 5 个 retryable 工作项，各有 6–7 次时间筛选失败（09-27 形态），锚点早于 11 分钟。
     - 任一池内节点领取一次：5 个都结算为 failed，没有旧锚点；
     - 这次领取里停止保护 SQL 只执行 1 次，父任务刷新 1 次；
     - `capture_agent_commands`、子任务数都不变；
     - 返回 null；父任务因为还有停止保护词，仍是 needs_action。

新 `tests/integration/postgres/operator-close.integration.mjs`（F3、F3b）：

3. **补详情**：用 `capture-discovery-detail.integration.mjs` 的夹具造出 needs_action 的补详情。
   - overview 显示可结束；POST 后：
     - 任务 failed，已移到历史，`operatorClose.originalStatus=needs_action`；
     - 工作项、尝试行 failed，工作项 revision 加 1；候选、需求不变；
     - 有事件，有 `audit_logs`；
     - 再 POST 返回 200 且 `idempotent`。
   - 迟到入库（`f.store`）拒绝，`code=DISCOVERY_RECEIPT_NOT_CURRENT`，所有行不变。
   - 同一次执行回报 failed 快照：任务仍是 failed 且已移到历史，`operatorClose` 还在，工作项和候选不变。
   - 手机批次「重新处理」该候选：变成 queued/active。
4. **独立手机运行**：needs_action 的词加没开始的词，没有占用。
   - 可结束；结束后运行 failed，词分别是 failed 和 canceled，revision 加 1，没有 `attemptId`/`leaseId`；
   - 手机对原尝试迟到的 `complete()` 和 `closeDevice()` 都返回 `STALE_ATTEMPT`，行都不变；
   - 另造一个有占用的运行 → `device_held`，POST 返回 409。
5. **侧边栏 capture**（`MANUAL_BATCH_PAGE_CLOSED`）：
   - 结束后，同一次执行再回报 needs_action 或 failed（不带停止保护码）：仍是 failed、仍在历史；
   - 同一次执行回报 needs_action + `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`：变成 needs_action、带这个码，`attention_dismissed_at` 为空（回到需处理）；「继续」不返回 `task_operator_closed`；F3 资格为 `stop_fence`；
   - 同一次执行回报 interrupted：变成 interrupted，`findCaptureAgentExecutionSlotBlocker` 返回它（槽位被挡）；
   - 同一次执行回报 running：被现有 WHERE 拒绝，行不变；
   - 新 attempt 的 running 照常镜像，并清掉 `attention_dismissed_at`；
   - 伪造的 `operatorClose` 进不来，也清不掉。
6. **弹性批次**：
   - 「手机」形态：父任务 `completed_with_failures`，子任务和 needs_action 的词都是 failed；手机 `claimElasticItem` 和浏览器领取都拿不到；手机迟到 `complete()` 返回 `STALE_ATTEMPT`；计划批次时 `last_run_status` 同步更新。
   - 浏览器子任务迟到回报停止保护：结束后，子任务同一次执行回报 needs_action + 停止保护码 → 子任务 needs_action；节点确认旧页面已停止（真实路由）→ 子任务 superseded、停止保护解除、节点能领新批次的活；工作项仍是 failed。
   - 本地恢复接管：结束一个含 failed 子任务和 failed 工作项的浏览器弹性批次，再用 `parentRequestId` 指向该子任务的本地「继续」快照镜像 → 没有工作项被接管，工作项仍 failed，父任务仍 `completed_with_failures`。
   - 后台「继续」：对该子任务、对已结束的侧边栏根调 `/tasks/:id/resume` → 409 `task_operator_closed`，没有指令。
7. **拒绝**：
   - 有 retryable 工作项 → `live_item`；带停止保护的 needs_action 子任务或工作项 → `stop_fence`；
   - 用现有接口确认旧页面停止、工作项结束后 → 变成可结束；
   - pending 指令 → `live_command`；`stopPending` → `stop_pending`；active 需求 → `active_discovery_demand`；
   - 根是 interrupted → `interrupted`；子任务是 interrupted → `live_child`；
   - 有 needs_action 的 `unattendedNegativePatrol` 工作项 → `negative_patrol_needs_action`，`unattended_negative_patrol_state` 不变；「恢复失败巡查」后变成 `live_item`。
8. **权限与并发**：
   - viewer 403；别的租户 404；子任务 id `task_not_root`；
   - 两个并发 POST：一个结束，一个 `idempotent`；
   - 批量里混合各类行：结果和原因正确，其中一个根加锁超时不影响其它根。
9. **历史清除**：`[正常根, needs_action 根, 8529ec28 形态（已取消但有 pending 工作项）, 别租户 id]`。
   - 200，只清掉正常根；
   - `skipped` 原因依次为 `not_in_history`、`live_work`、`not_found`；
   - 全部被跳过时 409 并带 `skipped`；全部不存在时 404。

更新 `tests/integration/postgres/capture-task-history.integration.mjs` 167–177：原来混合请求整批 404/409 的断言，改成「正常根被清掉、其它行在 `skipped` 里」，子测试名改成 `…; mixed batches clear eligible roots and report the rest`。其余断言不变。

### 回归

- 全量单元：已知环境失败见 `docs/hotfix/20260926-release-hotfixes.md`。
- 全量 PG：`node scripts/run-postgres-integration-tests.mjs`，约 12 分钟。
- 边界：`node scripts/check-android-discovery-boundaries.mjs`。
- Admin：`npm run build`。

## 最终实现（与设计的差异和评审后追加的修复）

代码提交 `dab3773`，在 `e791483` 之上共 16 个提交。服务端 7 个文件（5 个修改、2 个新增），Admin 12 个文件，无迁移，扩展和手机 Runner 不动。

| 提交 | 内容 |
|---|---|
| `9a465dd` | 新模块 `capture-elastic-policy.js`：两个阈值、锚点 SQL、F2 结算规则、投影钩子和领取兜底 |
| `6d78634` | F1：领取 SQL 里的常数谓词；浏览器领取和手机领取都删掉旧锚点；领取事件带 `roundExclusionRelaxed`；批次详情返回 `elasticPolicy.roundRelaxAfterMs` |
| `6b2cdea` | F2：两条投影路径结算；领取兜底按批次一条语句（`SKIP LOCKED`）；事件 `elastic_item_filter_verification_settled`；「重试失败关键词」写 `filterVerificationBaseAttemptCount` |
| `4518aa5` | Admin 恢复卡：`summarizeElasticRoundWait`，说明本轮还有哪些节点没试、为什么领不到、几点开放 |
| `0149f05` | PG 回放：`elastic-stuck-retry.integration.mjs` |
| `7f2bcff`、`c732e71` | 评审第 1 轮：Admin「重试失败关键词」只提交服务端会接受的词，停止保护词单独提示 |
| `d1cc950` | F3b：`/history/clear` 逐行判断，返回 `skipped` |
| `996e01a` | F3 服务端：新服务 `capture-operator-close.js`、两个接口、overview 资格、镜像保持、本地恢复和「继续」的防护、补详情迟到快照不再重投影 |
| `cd4bf6f` | F3 Admin：卡片按钮、「清理无法继续的任务（N）」、不可结束原因、历史页跳过提示 |
| `8c7b9f6` | 资格 SQL 在生产规模下只走索引探测（0.5–0.8 ms），不再对整个租户做哈希连接 |
| `3a2c30c` | 评审第 1 轮：被「重试失败关键词」「恢复失败巡查」或人工交接重新打开的批次，清掉 `attention_dismissed_*` 和 `historyCleared*`，回到「需处理」 |
| `da30a95` | 评审第 2 轮：「结束并移到历史」结束的词（`error.operatorClosed`）不再被自动重试（cron、值守恢复）；手动「换设备重试」「重试失败关键词」仍可 |
| `a6264b2` | 评审第 2 轮：手机来源的词「重试失败关键词」返回 409 `retry_items_mobile_source`；`retry-items` 和等待重试派发（`loadIdlePendingRetryAgent`）不再选手机节点 |
| `9057952` | Admin：手机词不进重试列表，提示「手机采集的关键词不能在原批次里重试（手机不接收重试任务）；需要重采请新建手机采集批次」 |
| `dab3773` | 评审第 2 轮：从历史（移到历史、历史清除、结束并移到历史）被重新打开的固定批次写 `metadata.reopenedFromHistoryAt`，cron 自动重试扫描跳过它（常数开销的 jsonb 键判断） |

与上面设计相比的差异：

1. **服务端是 7 个文件，不是 6 个**：多了 `server/services/android-control/leases.js`。手机领取也要删掉 `elasticRetryWaitingSince` 和 `checkpoint.recovery`，否则混合的抖音池里手机试过之后，浏览器会按旧锚点立刻放宽（F1）。
2. **F3 不收 interrupted**：设计里已写明理由（interrupted 占着节点槽位）。任务描述里写的是 needs_action/interrupted。
3. **评审后追加的防护**，都只在 F3 或 F2 之后才可能出现，结束前的行为不变：
   - 408d1410 结算后，「重试失败关键词」不会因为两个停止保护词整单 409（`7f2bcff`）。
   - 结束后又被重试的批次再次需要处理时，会回到「需处理」，可以再次结束（`3a2c30c`）。
   - 结束的批次里被运营放弃的词，不会被 cron 自动「换设备重试」（`da30a95`、`dab3773`）。
   - 结束的手机批次不能「重试失败关键词」，因为手机不接收浏览器的重试指令；重采要新建手机批次（`a6264b2`、`9057952`）。
4. 新接口和响应：
   - `POST /api/capture-cloud/tasks/:id/operator-close`、`POST /api/capture-cloud/tasks/operator-close`（1–100 个 id，每个根一个事务）；
   - `GET /overview` 的 `tasks[].operator_close: {eligible, reason}`；
   - `GET /orchestrations/:id` 的 `elasticPolicy`；
   - `/history/clear` 的 `skipped: [{taskId, reason}]`；
   - 409 `task_operator_closed`（`/tasks/:id/resume`）和 409 `retry_items_mobile_source`（`retry-items`）。
5. 新写入的字段（旧代码都不读）：
   - 工作项 `error`：`automaticRetryStopped`、`automaticRetryStopReason`、`filterVerification*`、`operatorClosed`、`originalStatus`、`operatorClosedAt`；
   - 工作项 `metadata`：`filterVerificationBaseAttemptCount`；
   - 任务 `metadata`：`operatorClose`、`reopenedFromHistoryAt`。
6. 环境变量（都不设时即为默认值，本次发布不改 `.env`）：
   - `CAPTURE_ELASTIC_ROUND_RELAX_MINUTES`：1–1440，默认 10；
   - `CAPTURE_FILTER_VERIFICATION_LIMIT`：2–20，默认 3。

## 验证

所有结果都在本机得到。分支没有推送，所以 **CI 没有跑**；推送需要用户同意，CI 的 5 个作业是发布前提（见「上线步骤」）。

基线的做法：用 `git archive e791483` 解到 scratch `idle0927/base`，`server/node_modules`、`web/admin/node_modules` 链到与工作树相同的目标。本分支在工作树（`dab3773`）上跑。

| 项目 | 基线 `e791483` | 本分支 | 说明 |
|---|---|---|---|
| 全量单元，Node 24.12.0（`scripts/run-node-regression-tests.mjs`） | 2814 个，2813 通过，1 失败 | 2847 个，2846 通过，1 失败 | 唯一失败两边相同：`tests/capture/douyin-blogger-profile-scope.test.mjs`，读 `extension-build/` 报 ENOENT，属环境问题 |
| 全量单元，Node 18.20.8 | 2814 / 2813 / 1 | 2847 / 2846 / 1 | 同上 |
| 全量 PG，Node 18.20.8（`scripts/run-postgres-integration-tests.mjs`，本机 PG 17.9，新库 `onstarvoice_test_stuckretry_int`） | 390 / 390 | 413 / 413 | 无失败 |
| 全量 PG，Node 24.12.0（新库） | 390 / 390 | 413 / 413 | 无失败 |
| 手机 Runner 对真实控制面（`runners/android` 的 `test:integration`，Node 24） | 1 / 1 | 1 / 1 | `leases.js` 改动后仍通过 |
| 手机 Runner 单元（Node 24） | — | 195 / 195 | |
| 其它 | — | 通过 | 服务端每个 `.js` 在 Node 18 上 `node --check`；`check-android-discovery-boundaries`（87 个模块，最大 299 行）；Admin lint 基线 281 ≤ 288；仓库卫生；进程拓扑；`git diff --check e791483..dab3773` |

逐名比对：
- 基线的每个测试名在本分支都有，失败名单完全相同（各 1 个）。
- PG 里 `capture-task-history` 的混合批次子测试按 F3b 改了名，数量 8 → 8。
- 新增单元 33 个：`capture-elastic-policy` 10、`capture-operator-close` 11、`server-capture-cloud-contract` 114 → 118、`web-orchestration-recovery-presentation` 7 → 12、`web-keyword-retry-allocation` 3 → 5、`cloud-task-center-wiring` 21 → 22。
- 新增 PG 23 个：`elastic-stuck-retry` 10、`operator-close` 13。

SQL 成本（`EXPLAIN (ANALYZE, BUFFERS)`，本机）：

| 语句 | 数据 | 结果 |
|---|---|---|
| 领取候选 SQL | 408d1410 形态的批次 | 中位数 0.252 ms（去掉 F1 谓词）→ 0.401 ms（带 F1），验收线是差值不超过 1 ms |
| F3 资格 SQL | 24 个根、99 个树节点；租户里 14 万任务、16 万工作项、12 万指令 | 0.54 ms，只走索引探测，不调停止保护 SQL，不加锁 |

Admin 构建（`tsc -b && vite build`，Node 24.12.0，vite 8.0.16）：
- `node_modules` 从 `OnStarvoice-release-v048-20260910` 复制，两个提交的 `package-lock.json` 都是 `38d615a0…`。每次构建前清掉 `.tmp` 和 `.vite` 缓存。
- **对照构建 `e791483`**：index 为 `476f8e19c5fd6240453a0cc30ae9bc8004d0bf94b252c87d283a0ddaced87750`，资源与 `bc4622c` 发布包逐字节相同。生产 Admin 应当就是它：`b986d71` 和 0.4.18 两次发布都没改 Admin。部署脚本把它作为前置条件。
- **本分支**：构建两次，逐字节相同。index 为 `612432f1c4f7c5ee4d027e5bc7c4c58eaaad551ae73ec359dad17f3bb9ad7e2b`，主脚本 `index-0Eu4dgme.js`。
  - 新增 5 个资源：`ChinaMap-kmdDQWYs.js`、`DesktopApp-DNSqFZ9x.js`、`MobileApp-B3nUVZMh.js`、`ThemeToggle-w12QIEqI.js`、`index-0Eu4dgme.js`；
  - 3 个资源生产上已有且相同：`ThemeToggle-KozaqHdl.css`、`index-BVaxzkpi.css`、`officialCommentPatrolPreview-7eK_DOcv.js`；
  - `favicon.svg`、`icons.svg` 不变。

部署脚本演练（35 个场景）：
- **模拟的生产目录**：
  - 服务端为 `e791483`（即 `fe74ec5`）；
  - Admin 依次解入 `68c32ba`、`9b836f6`、`bc4622c` 三个包，index 为 `476f8e19`；
  - `public-downloads` 里放真实的 0.4.18 和 0.4.17 包。
- **运行方式**：真实应用在 Node 18.20.8 下运行，由一个 pm2 替身管理。curl 只放行 `127.0.0.1:3002`，并转到模拟端口。
- **所用的包**：模拟用的是 `finalize.sh --sim` 产出的包。它与正式发布包只差提交号这一个字符串。

| 场景 | 结果 |
|---|---|
| 原始状态 `--check` | 通过，目录不变 |
| 正常发布 | `--check` 通过；发布退出码 0，重启 1 次；5 个文件、2 个新模块、index 都是发布包里的版本 |
| 正常发布的核对项 | 探测接口 404 → 401 `missing_auth_code`；`/api/update-manifest` 前后逐字节相同（0.4.18）；0.4.18 包逐字节可下载；`public-downloads` 不变；`/admin/` 和 8 个资源逐字节相同；`pm_exec_path`、Node 版本前后一致 |
| 发布后再次运行 | 拒绝，目录不变；`--check` 失败（文件已是新版） |
| 按文档手动回滚 | 回到 `e791483` 的文件和 index `476f8e19`，探测 404，`--check` 再次通过；只多出 5 个未被引用的新资源 |
| 19 种漂移 | 全部拒绝（`--check` 和发布都退出 1），目录不变，发布目录没被用掉。漂移包括：<br>· 5 个被替换的文件各改一处；<br>· `keyword-node-coverage.js` 回到 `b986d71` 之前，`capture-stop-fence.js` 回到 `9b836f6`；<br>· 生产回到 0.4.17（文件和进程一致）；文件是 0.4.18 但进程仍宣告 0.4.17；<br>· 进程已经在跑本版本代码（文件被放回、没重启）；<br>· 新模块已存在，或是悬空链接；<br>· Admin index 是别的构建；<br>· 0.4.18 包缺失，或内容被改；`public-downloads` 是链接；<br>· 两个压缩包各被篡改；<br>· pm2 进程停着 |
| 锁被占用、参数错误 | 拒绝（退出 1、2），目录不变 |
| 切换前资源冲突（同名资源内容不同） | 切换前失败；代码和 index 不动，只留下已放入的新资源 |
| 11 种自动回滚 | 都回到 `e791483` 的文件和 index `476f8e19`，探测 404，服务就绪，`--check` 再次通过；发布目录拒绝再次运行。触发条件：<br>· 就绪检查失败、新代码启动即崩溃；<br>· 探测仍是 404、更新清单变了、新资源内容不对、重启后换了启动脚本路径；<br>· 重启时收到 SIGTERM、SIGHUP，或 Ctrl-C（SIGINT 发给整个进程组）；<br>· 回滚自己重启时又收到一次 SIGTERM；<br>· `routes` 目录只读，切换到一半失败 |

## 发布包

本机模板目录：scratch `idle0927/stage/stuck-retry-cleanup-__COMMIT__-20260927/`。同目录下还有两个本机脚本，不上传：
- `build-stage.sh`：从 `dab3773` 生成包；
- `finalize.sh`：核对发布提交，并生成正式目录。

生产发布目录：`/opt/onstarvoice-private/releases/stuck-retry-cleanup-<短提交号>-20260927/`。锁文件：`/opt/onstarvoice-private/stuck-retry-cleanup-<短提交号>-20260927.lock`。

| 文件 | SHA-256 |
|---|---|
| `server.tar.gz`（7 个服务端文件，ustar，属主 root） | `acd36641da796001d4d09ca2aad55f39899354238a95fbe3ef87ee1307389bc7` |
| `admin-dist.tar.gz`（`dist/`，11 个文件） | `2e8ec04076369fbc613b141c2a2e7a88ab49ef2a99125ee15af0db49dcb72817` |
| `server/routes/capture-cloud.js` | `9e80bc29f49689da54d82647f328ed87ededb2fd4487ef31257df20f19483128` |
| `server/routes/capture-orchestrations.js` | `0aef87e67737638d6f2afb5134b0f62dd5aee697703c1071625c0dcd12f0b19d` |
| `server/services/android-control/leases.js` | `cab39e5489702b59c3701679fbdfd17f7a25e428bf88e2e3cc81e3677f519513` |
| `server/services/capture-cloud.js` | `13ab2e8102cfd56d9d5a2a08384502ee0828acb29d581e386f298c9bc76b3bc8` |
| `server/services/capture-discovery/detail-projection.js` | `45c16aaa5cbe37e56882e15fd9f09424ec7768349e10b8f41d7171ddf00f1a21` |
| `server/services/capture-elastic-policy.js`（新增） | `23dd7b31e839e6a5bd77cac5c39f08e7af73438c76dd8dcbb4e6cbc05cfa60eb` |
| `server/services/capture-operator-close.js`（新增） | `46c2f391469afca90e49b3998c7a6ceb99b45199f8fb60c12c1e0a58047f2624` |
| `web/admin/dist/index.html` | `612432f1c4f7c5ee4d027e5bc7c4c58eaaad551ae73ec359dad17f3bb9ad7e2b` |

`deploy.sh` 和 `release-manifest.json` 由 `finalize.sh` 填入提交号后生成，哈希写在正式目录的 `local.sha256` 里。`deploy.sh` 钉住了上面所有哈希，`admin-files.sha256` 和 `admin-source.sha256`（160 个文件）随包附带。

前置条件（`bash deploy.sh --check` 只读核对，任何一条不满足都不改动任何文件）：

- 两个压缩包的哈希；
- 被替换的 5 个文件与 `e791483` 逐字节相同：
  - `capture-cloud.js`（路由）`3be625a2…`；
  - `capture-orchestrations.js` `2ffa4f96…`；
  - `leases.js` `c331fe2d…`；
  - `services/capture-cloud.js` `003e42cb…`；
  - `detail-projection.js` `f66ae266…`；
- 自上次整包部署（`9b836f6`）以来被替换过的另 6 个文件也必须是 `e791483` 的版本（只核对，不替换）：
  - `about.html`、`update-manifest.js`、`ops-control.js`：0.4.18；
  - `capture-stop-fence.js`、`capture-stop-fence-release.js`；
  - `keyword-node-coverage.js`（`b986d71`）；
- Admin index 为 `476f8e19…`；
- 两个新模块不存在，连悬空链接也不能有；
- `public-downloads` 是真实目录，里面的 `StarVoice-extension-v0.4.18-20260926.zip` 是普通文件，哈希为 `6faddb2e…`；
- pm2 `onstarvoice` 在线；`/api/health/ready` 返回 200；
- `/api/update-manifest` 宣告 0.4.18，下载地址指向上面的包，`minSupportedVersion` 为 0.3.51；
- 未登录 `POST /api/capture-cloud/tasks/operator-close` 返回 404，说明新路由还没上线。只有鉴权中间件会处理这个请求，不访问数据库。

部署顺序：
1. 新 Admin 资源（先写临时文件再改名；同名已有的必须逐字节相同）；
2. Admin index；
3. 两个新模块；
4. 5 个被替换的文件（每个都是临时文件加改名）；
5. `pm2 restart onstarvoice`。

发布后核对，任何一条失败都自动回滚：
- 30 秒内就绪，`live` 通过；
- pm2 确实重启了，启动脚本路径和 Node 版本不变；
- 磁盘上的文件就是本次发布的版本；
- 探测返回 401 `missing_auth_code`，说明重启后的进程加载了带两个新模块的 `capture-cloud.js`；
- `/api/update-manifest` 与发布前逐字节相同；0.4.18 包逐字节可下载；`public-downloads` 不变；
- `/admin/` 是新 index，8 个资源逐字节相同。

`finalize.sh <完整提交号>` 在生成正式目录前核对：
- 该提交包含 `e791483`；
- 它的 7 个服务端文件与包里的逐字节相同；
- 相对 `e791483`，它在 `server/`、`web/admin/` 下恰好只改了这 7 个服务端文件和 12 个 Admin 文件；
- 它的 `web/admin` 树与构建所用的源码完全一致（160 个文件，不多不少）。

生成正式目录时，只把 `deploy.sh` 和 `release-manifest.json` 里的 `__COMMIT__` 换成提交号，压缩包和其中所有哈希不变。

## 上线步骤

部署需要用户在对话里点名生产主机（`47.103.125.200`），见 memory「生产 SSH 要用户点名主机」。

1. **CI**（发布前提）：推送分支 `codex/hotfix-stuck-retry-cleanup-20260927`，等 5 个作业通过。推送需要用户同意。
2. **生成正式目录**（本机）：

   ```bash
   bash <scratch>/idle0927/stage/finalize.sh <本文所在提交的完整 sha>
   ```

   输出正式目录 `idle0927/stage/stuck-retry-cleanup-<短 sha>-20260927/` 和它的 `local.sha256`。
3. **上传**：

   ```bash
   scp -r <正式目录> root@47.103.125.200:/opt/onstarvoice-private/releases/
   ```

   然后在服务器上进入该目录，执行 `sha256sum -c local.sha256`。
4. **K=3 风险核对**（只读）：跑「关于 K=3 的风险」那段 SQL。
   - 有结果时，在 `/opt/onstarvoice/server/.env` 加 `CAPTURE_FILTER_VERIFICATION_LIMIT=<结果里最大的 tf_attempts_before_ok + 1>`，下一步的重启会让它生效；
   - 没有结果就不用设置。
5. **发布**：

   ```bash
   cd /opt/onstarvoice-private/releases/stuck-retry-cleanup-<短 sha>-20260927 && bash deploy.sh --check && bash deploy.sh
   ```

   - 建议白天、小红书夜间批次（03:30）之外发布。
   - 重启会断开节点连接，节点一般 2 分钟内恢复心跳（0.4.18 发布时 1 分 45 秒）。
6. **上线后核对**：
   - 先跑「上线后会发生什么」里的只读 SQL；
   - 看 pm2 错误日志有没有模块加载错误；
   - 看 `/overview` 里需处理行都带 `operator_close`。
7. **运营操作**：见下一节。

## 上线后会发生什么

1. **408d1410**（上线时锚点早已过了 10 分钟）：
   - 第一台空闲的小红书节点（上海、火星之外的任意一台）下一次完整心跳时，F1 放宽让它选中其中一个词。F2 兜底发现这个词已有 6–7 次时间筛选失败，于是按批次一次性把这 5 个词都结算为 failed，再带 `slotChecked` 重选候选。
   - 5 个词在同一次心跳里全部结算，停止保护 SQL 只跑 1 次，**不下发、不搜索**，节点随后领不到别的活。
   - 批次还有「别克哨兵」「ibuick」两个停止保护词，仍是 needs_action。F3 拒绝结束它，原因是 `stop_fence`，卡片上显示「暂不能结束并移到历史：包含未确认停止的旧采集页面…」。
2. **手机/手机采集、补详情、手机旧运行、提前**（共 23 条，都是 needs_action，没有 interrupted）：overview 按行给出能否结束。本机按 09-27 形态搭的回放里，这几类都能结束。只有一种例外：手机批次里还有作品在等浏览器补详情（active 需求），卡片会显示「仍有手机发现作品在等待补详情」。
3. **历史页**：「全选本页 → 清除」不再因为 8529ec28 整批失败，会提示「已移出 X 条；1 条未移出：仍有未结束的工作或仍需处理」，没移出的那条保持勾选。
4. **下一轮小红书夜间批次**：一个时间筛选失败的词最多搜 3 次（重复节点也计次），原来最多 16 次。时间筛选失败的次数、不同节点数仍可用诊断 c1–c6 观察。

上线后核对（只读）：

```sql
SELECT ordinal, keyword, status, attempt_count, error->>'automaticRetryStopReason' AS stop_reason,
  updated_at AT TIME ZONE 'Asia/Shanghai' AS updated_cst
FROM capture_task_items
WHERE task_id = '408d1410-97ee-49cd-af1a-dac05ec98d02' AND item_type = 'keyword' AND status <> 'completed'
ORDER BY ordinal;
-- 5 个词应为 failed / filter_verification_repeated，attempt_count 不变（6/7），error 里没有 recovery

SELECT count(*) FROM capture_tasks
WHERE parent_task_id = '408d1410-97ee-49cd-af1a-dac05ec98d02' AND created_at > '<部署时间>';
-- 应为 0

SELECT created_at AT TIME ZONE 'Asia/Shanghai', event_type, payload->>'keyword', payload->>'settledAt'
FROM capture_task_events
WHERE task_id = '408d1410-97ee-49cd-af1a-dac05ec98d02'
  AND event_type = 'elastic_item_filter_verification_settled';
-- 5 条，settledAt = claim
```

## 运营操作（上线后怎么点）

### 1. 先确认上线生效（不用点）

上线后几分钟内，批次「小红书~日常+负面巡检 · 09/27 03:30」的详情里，这 5 个词会变成「失败」：安吉星壁纸、上汽通用客服、月兔栖梦、君越壁纸、昂科威壁纸。失败原因为：

> 多台节点都无法确认小红书时间筛选结果（可能该时段没有新内容或页面有变化），已停止自动重试；可稍后在批次里「重试失败关键词」

这一步**不会**再搜索。批次仍停在「需要处理」，因为还有「别克哨兵」「ibuick」两个词在等确认旧页面停止。

建议**先上线、再做下面第 2 步**。如果先在火星、上海上确认停止，这两台会马上按旧逻辑去领这 5 个词（它们是本轮没试过的节点），最多再搜 9 次，夜里大概率还是同样失败。

### 2. 火星、上海：确认旧页面已停止

两台分别做一次：

1. 到那台电脑上，关掉或刷新所有小红书、抖音、微博采集页。最稳妥的做法是重启浏览器。
2. 后台打开「执行节点」→ 火星（或上海）。面板显示「旧采集页面未确认停止 · 需人工确认」。
3. 点「确认旧页面已停止」。对话框列出一条任务：
   - 火星：「别克哨兵」；
   - 上海：「ibuick」；
   - 状态都是「需要处理 · 预计：退回任务池」。
4. 勾选后确认。提示应为：

   > 已确认旧采集页面已停止（1 个任务已记录人工确认）；1 个未完成关键词已退回任务池，由其它节点接力；节点会在下次心跳时释放本机执行锁，释放后恢复接单

之后这两个词由别的小红书节点接力（原节点不会再领同一个词），两台节点恢复接单。

### 3. 09-27 批次收尾

「别克哨兵」「ibuick」跑完后，批次变成「部分失败」：5 个时间筛选词失败，其余完成。说明是「本轮关键词采集与负面巡查已结算」；计划的上次运行状态同步为部分失败，下一次 03:30 照常运行。

然后二选一：

- **要补这 5 个词**：
  - 在批次详情点「重试失败关键词」，建议白天做。可以逐个指定节点，上海此前在这几个词上成功过。
  - 人工重试会重新给每个词 3 次时间筛选的机会；又连续失败 3 次的话，会再次停下。
  - 列表里不会出现仍在等确认停止的词，面板会单独提示。
- **不补**：卡片上点「移到历史」，或者在「需处理」顶部点「清理已结束失败项」。

### 4. 清理「需处理」里没法继续的任务

「需处理」顶部会多一个按钮「清理无法继续的任务（N）」，每张能结束的卡片上也有「结束并移到历史」。点之前请看确认框：

- 不会重新采集，也不会向设备发任何指令；
- 已采集的内容、运行结果、执行记录全部保留；
- 未完成的工作项标记为失败，原状态和原因记在任务详情里；
- 补详情行结束后，作品仍可在对应手机批次里「重新处理」。

| 行 | 条数 | 上线后 | 说明 |
|---|---|---|---|
| 手机发现作品补详情 | 11 | 可结束 | 候选和需求都不变，不会重新排队 |
| 抖音手机发现（09-24 手机旧运行） | 8 | 可结束 | 手机没有占用时；没开始的词标为「已取消」，手机迟到的上报会被拒绝 |
| 提前（火星、金星 09-24 21:11） | 2 | 可结束 | 同一次执行再报需处理或失败，仍保持结束；报停止保护或中断时回到「需处理」 |
| 手机（09-26 20:04）、手机采集（09-26 12:24） | 2 | 可结束 | 结束后批次为「部分失败」，已完成的词保留。卡片提示「仍有手机发现作品在等待补详情」时，要等那条补详情结束；它若停在需处理，就是上面「补详情」里的一条，先结束它 |
| 小红书~日常+负面巡检 · 09/27 03:30 | 1 | 不可结束 | 按第 2、3 步收尾，变成「部分失败」后用「移到历史」 |

- 一次点「清理无法继续的任务」，只提交服务端判定能结束的行，最多 100 条。
- 完成提示为「已结束 X 个任务并移到历史」。状态刚好变了的行会列在「未处理」里，并给出原因。
- 卡片上显示「暂不能结束并移到历史：…」时，按那一行说的做，例如先「确认旧页面已停止」或「恢复失败巡查」。
- 结束的手机批次不能在原批次里「重试失败关键词」，需要重采请新建手机采集批次。

### 5. 历史页

「全选本页 → 清除」现在只跳过不能清的行，例如 09-08「负面帖子巡查」那条已取消、但树里还挂着未结束工作项的批次。其余照常清除。

提示为「已移出 X 条；Y 条未移出：仍有未结束的工作或仍需处理」，没移出的行保持勾选。

## 回滚

- **自动回滚**：发布中任何一步失败，或收到 INT/TERM/HUP，脚本都会自动回滚：
  - 从 `backup/` 恢复 5 个文件（仍是原内容的不动），删掉两个新模块，恢复 index；
  - 重启并等待就绪，报告探测结果（404 说明已回到旧代码）。
  - 回滚期间忽略后续信号。新 Admin 资源留着，没有被引用。
  - 发布目录之后拒绝再次运行，重试要用新的一份目录。
- **手动回滚**：

  ```bash
  cd /opt/onstarvoice-private/releases/stuck-retry-cleanup-<短 sha>-20260927 && for f in server/routes/capture-cloud.js server/routes/capture-orchestrations.js server/services/android-control/leases.js server/services/capture-cloud.js server/services/capture-discovery/detail-projection.js; do cp -p backup/$f /opt/onstarvoice/$f; done && rm -f /opt/onstarvoice/server/services/capture-elastic-policy.js /opt/onstarvoice/server/services/capture-operator-close.js && cp -p backup/admin/index.html /opt/onstarvoice/web/admin/dist/index.html && pm2 restart onstarvoice && curl -fsS http://127.0.0.1:3002/api/health/ready
  ```

  演练中，手动回滚后 `--check` 再次通过，只多出 5 个未被引用的新资源。
- **已写入的数据对旧代码无害**：
  - F2 结算的工作项是普通 failed，旧代码的「重试失败关键词」照常能用。多出来的 `error.automaticRetryStopped` 等字段和 `metadata.filterVerificationBaseAttemptCount`，旧代码都不读。
  - F3 结束的根是 failed/`completed_with_failures` 且已移到历史，旧代码把它们当普通历史显示。`metadata.operatorClose`、`metadata.reopenedFromHistoryAt`、`error.operatorClosed` 旧代码都不读。
  - 回滚后镜像不再保留 `operatorClose`，状态也不再保持。同一次执行若迟到回报，可能把行写回 needs_action，但镜像不会清掉 `attention_dismissed_at`，所以它不会回到「需处理」。这些行最新的也是 09-26 的，风险很低。
  - 回滚后没有「继续」和本地恢复接管的防护。F3 已给工作项 revision 加 1，本地恢复接管仍连不上尝试行；后台「继续」回到旧行为（旧代码本来就允许继续 failed 的子任务）。
  - 回滚后，结束的固定批次如果又被「重试失败关键词」重新打开，cron 会像以前一样扫描它；结束的手机批次又能提交「重试失败关键词」，但不会被执行。两者都要先有人操作才会出现。
  - F1 不落库，回滚后立即恢复严格的轮次排除。领取时多删的 `elasticRetryWaitingSince` 旧代码不读。
- **只想关掉某一项、不整体回滚**：
  - F1：设 `CAPTURE_ELASTIC_ROUND_RELAX_MINUTES=1440`，相当于 24 小时才放宽；
  - F2：设 `CAPTURE_FILTER_VERIFICATION_LIMIT=20`，次数条件超过 16 次预算，永远达不到；8 台的池，不同节点数条件是 `min(20, 8) = 8`，约等于原来的一整轮；
  - 改完重启进程。F3 不点就不会生效。

## 不变量核对

| 不变量 | 怎么保证 |
|---|---|
| F3 不释放停止保护 | 树里有未对账的 `PREVIOUS_CAPTURE_STOP_UNCONFIRMED`（任务或工作项）就拒绝；F3 从不改 superseded 行，也不改 error.code；结束后设备才回报这个码时，镜像不保持 failed，行回到 needs_action，「确认旧页面已停止」或卡片上的「继续」「停止」照常可用 |
| F3 不在没有证据时释放槽位 | 只收 needs_action（本来就不占槽位）；interrupted 的根和子任务都拒绝；结束后设备回报 interrupted 照常镜像，槽位重新挡住 |
| F3 之后不会产生新的残留 | 工作项 revision 加 1、清掉手机 `attemptId`/`leaseId`；本地恢复接管和后台「继续」拒绝仍处于结束状态的父任务或任务；有需处理的负面巡查帖子时拒绝 |
| F1 不让同一节点连续两次跑同一个词 | 来源排除原样保留；放宽后的窗口仍排除最近一次尝试的节点 |
| F1+F2 不增加搜索次数 | F2 按次数计，只剩两台交替时第 K 次就结算 |
| 心跳和轮询路径只加常数开销 | F1 是行内常数谓词；镜像保护是常数；F2 兜底每个批次一生一次、按批次一条语句；递归带 `slotChecked`，一次心跳停止保护 SQL 最多 1 次 |
| 没到阈值时行为不变 | F1 需要超过 10 分钟，F2 需要满 K 次（或池小于 K 时每台都失败），F3 需要人工操作；F3b 只把「整批失败」改成「跳过并说明」 |
| 租户隔离、只允许写权限、加行锁、幂等 | 见 F3「接口」「执行」 |
| F3 结束的东西不会被自动重新跑 | 结束的词带 `error.operatorClosed`，自动「换设备重试」跳过它；从历史被重新打开的固定批次带 `reopenedFromHistoryAt`，cron 不扫描；手机来源的词不能「重试失败关键词」，重试和等待重试派发都不选手机节点 |
| 被重新打开的批次不会藏起来 | 「重试失败关键词」「恢复失败巡查」、人工交接清掉 `attention_dismissed_*` 和 `historyCleared*`，再次需要处理时回到「需处理」，可以再结束 |

## 已知限制（本次不做）

- 扩展没识别出小红书「一天内」的真实空结果页，或者没识别出结果容器重挂，这个根因仍在。下个扩展版本要在失败时带回筛选后的 DOM 证据（空态文案、容器替换），再决定怎么识别。
- K=3 可能让本来第 4 台（例如上海）能成功的词提前停下。缓解：发布前回放 SQL、环境变量可调、「重试失败关键词」可以指定节点。
- F3 的停止保护判断比准入保守：superseded 且已被后续执行证明停止的历史行（976a0c6 规则）仍会让整棵树拒绝结束，而节点页不会为它显示确认按钮。当前 24 条里没有这种情况；以后遇到，先由停止保护检查协议对账，或单独做数据修复。
- 8529ec28（已取消但树里有未结束工作项）只是在历史清除时被跳过，数据本身不修。
- 结束后，批次子任务如果被设备回报成 interrupted（设备先报过需处理、后来又报中断，实际很少见），它会挡住节点槽位，而父任务已结束，后台「继续」会拒绝它。出口是扩展自己结算，或对它「停止」，与今天任何被中断的子任务相同。
- 「重试失败关键词」对每个候选节点都跑一次停止保护 SQL（`co.js` 5872，约 275 ms × 8 个小红书节点）。这是现有的人工路径，本次不改。
- `recovery.nextEvaluationAt`、`sourceAgentSameItemRetryAfter` 仍然只写不读。
- 值守恢复（ops_control 的 guarded 模式）仍可能对「结束并移到历史」之前就已失败、没有 `operatorClosed` 标记的词做一次换设备重试；cron 由 `reopenedFromHistoryAt` 挡住。
- 人工交接（resolve-attention）写 `reopenedFromHistoryAt` 的路径没有路由级 PG 测试；它与 `retry-items` 共用同一段 SQL（PG 测试覆盖），UPDATE 形状在 PG17 上用 EXPLAIN 核对过，单元测试钉住两处都带它。
- CI 没有跑（分支未推送），K=3 风险 SQL 没有在生产上跑，两项都在「上线步骤」里。
- 本机 PG 是 17.9；CI 用 14 和 16。
