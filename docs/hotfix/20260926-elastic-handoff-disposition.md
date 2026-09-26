# 「停止整个任务」后弹性批次停在「等待设备确认」：关键词子任务的 terminalDisposition 等不到终态通知

分支：`codex/hotfix-elastic-handoff-disposition-20260926`。基线：`5c9d4ae`（`codex/hotfix-needs-action-fence-20260925` 的头，发布包已备好、**尚未部署**）。生产当前为 `97b3765`（只改了 `server/services/android-control/leases.js`），与本修复不碰同一个文件。不新增数据库迁移，不动扩展和 Admin。

来源：`docs/hotfix/20260925-needs-action-fence.md`「评审中发现、本次不修的既有问题」一条。

## 现象

弹性批次里某个关键词先在节点 A 失败（或中断、需要处理），被普通弹性接力交给节点 B：A 的子任务置 `superseded`。之后运营点「停止整个任务」，批次里还有别的执行在跑，父任务先进入 `waiting_device`（“已停止新领取，等待设备确认当前执行轮次已停止”）。那些执行都停下后，父任务仍停在 `waiting_device`，永远不变成 `canceled`。

## 根因

- **写入**：弹性接力把旧执行置为 `superseded` 时写 `metadata.terminalDisposition='superseded'`、`terminalReason='elastic_retry_claimed'`（`server/routes/capture-cloud.js`，`dispatchNextElasticWorkItemWithinBudget`，约 8018）。
- **判定**：`refreshOrchestrationParentTask` 对 `operatorStopped` 的父任务统计“未结清”子任务（约 4595–4650）。子任务只要带 `terminalDisposition`（且不是 `stoppedBeforeDispatch`），就必须有与请求 id、attempt id、处置完全一致的 `terminalNoticeAcknowledgement`，否则一直算未结清。
- **终态通知只发给巡查类任务**：`claimPriorityAgentControl` 只为 `negative_post_patrol`、`watched_content_patrol`、`official_account_comment_patrol`、`followed_creator_post_patrol`、`official_account_post_discovery` 这 5 种任务类型下发通知（约 8680）。它要求节点上报 `negativePatrolTerminalReceiptV1`；扩展只回执收到的通知（`background.js` 的 `targetedPostTerminalNotice*`）。`unattended_keyword_capture`（浏览器关键词子任务）和 `capture`（手机关键词子任务）永远收不到通知，也就永远不会有回执。

所以对关键词子任务，这条规则是一个永远满足不了的条件。

### 同样会触发的写入点

| 位置 | 场景 | 写入 |
|---|---|---|
| `routes/capture-cloud.js` 约 8018 | 浏览器弹性接力 | `superseded` / `elastic_retry_claimed` |
| `routes/capture-cloud.js` 约 15873，`reconcileElasticCaptureLeases` | 弹性租约超时（节点离线或心跳超时）后回池 | 状态 `failed`，`revoked` 或 `superseded` / `elastic_agent_offline_timeout`、`elastic_task_heartbeat_timeout` |
| `services/android-control/leases.js` 约 133 | 手机领取弹性关键词，替换旧执行 | `superseded` / `android_elastic_claimed` |
| `services/keyword-node-coverage.js` 约 109 | 固定分配关键词覆盖跳过 | `superseded` 状态，`revoked` / `keyword_node_*` |

停止路径里已经按任务类型区分：停止指令过期（约 2340）只给这 5 种巡查类型写 `terminalDisposition`，停止失败（`targetedCompletion`）只给定向任务写；关键词子任务靠 `stopPending` 等待。上面这 4 处没有区分。

## 修法

**让父任务的结清规则只对会收到终态通知的 5 种任务类型要求回执**，其它任务类型带着 `terminalDisposition` 时按状态结清，与不带时完全一样。

不选“接力时不写 `terminalDisposition`”的原因：

1. 写入点有 4 处，其中 `leases.js` 是生产刚上线的 `97b3765` 改过的文件，改它会把两条 hotfix 线搅在一起。
2. 生产里已经带着这个字段的子任务不会消失。只改写入点的话，这些批次日后被停止照样卡住，还得再做一次数据修复。
3. 写入点的字段仍有别的读者（`evaluateIncompleteSequentialItemRepair` 用它跳过修复，见下表），不写反而改变那里的行为。

### 改动（只改一个服务端文件）

- `server/routes/capture-cloud.js`
  - `refreshOrchestrationParentTask` 的结清 SQL：`terminalDisposition` 分支加 `child.task_type IN (<5 种巡查类型>)`，列表与 `claimPriorityAgentControl` 下发通知的列表逐字一致。
  - 纯函数镜像 `operatorStoppedChildRequiresSettlement`：同样加 `TERMINAL_NOTICE_TASK_TYPES`。它只被单元测试使用；`task_type` 缺省时不在列表里，与库里 `NOT NULL DEFAULT 'capture'` 一致。
- 测试
  - `tests/integration/postgres/stop-fence-closure.integration.mjs` 新增 2 个子测试（见「验证」）。
  - `tests/server-capture-cloud-contract.test.mjs`：原「终态通知待回执」夹具补上它本来代表的 `task_type: 'negative_post_patrol'`；新增关键词子任务的判定断言；新增源码断言，要求结清 SQL、JS 常量与通知查询三处的任务类型列表完全一致，防止以后漂移。

### 不变的东西

- 巡查类子任务：带 `terminalDisposition` 仍然要等节点对确切的通知回执，集成测试用真实心跳走了一遍（先收到通知，父任务不动；回执后才结清）。
- 关键词子任务仍在跑（状态不是终态）或带 `stopPending` 时照样算未结清：状态规则和 `stopPending` 规则都没动。
- 停止保护（`PREVIOUS_CAPTURE_STOP_UNCONFIRMED` 准入）：`captureTaskUnconfirmedLocalStopSql` 只看子任务自身的错误码、状态和接力后继，不看父任务状态，也不看 `terminalDisposition`。批次结清不等于旧页面已停；集成测试确认被围栏的源节点在批次结清后仍被挡住。
- 写入点一个都没改，字段照写。

## terminalDisposition 的所有读者

| 位置 | 用途 | 本次 |
|---|---|---|
| `refreshOrchestrationParentTask` 结清 SQL（约 4610） | 本 bug | 改：只对 5 种巡查类型要求回执 |
| `operatorStoppedChildRequiresSettlement`（约 2954） | 上面 SQL 的纯函数镜像，仅测试使用 | 同步改 |
| `evaluateIncompleteSequentialItemRepair`（约 3904） | 带处置的子任务不做“虚假完成”修复 | 不变。字段照写，行为不变；被接力的子任务本来也因状态 `superseded`、`execution_task_id` 已换而被跳过 |
| `claimPriorityAgentControl` 回执 UPDATE（约 8556） | 按 `COALESCE(terminalDisposition, status)` 匹配回执 | 不变。关键词类型没有通知，也就没有回执 |
| `claimPriorityAgentControl` 通知查询（约 8633） | 只查 5 种巡查类型 | 不变；它的类型列表成为结清规则的依据 |
| 停止指令查询（约 8731） | 读指令 payload 里的 `terminalDisposition`，不是任务 metadata | 无关 |
| 停止指令完成（约 9945） | 成功时删除该字段 | 无关 |
| `capture-stop-fence*.js`、Admin、扩展 | 不读任务 metadata 里的这个字段 | 无关 |

`server/services/capture-stop-fence-release.js` 里“不写 `terminalDisposition`”那段注释的理由（关键词子任务会让停止的批次永远等下去）在本修复后不再成立，但“不写”本身仍然正确（放行不向节点发任何通知）。为了让发布包只含一个文件，注释没改。

## 验证

环境：Node 18.20.8；PostgreSQL 17.9 一次性实例（`initdb --locale=C`，`LC_ALL=C` 启动，`unix_socket_directories=''`，只监听 127.0.0.1）；`NODE_ENV=test`，`--test-concurrency=1`；`server/node_modules` 链到 `02e51be6663b` 锁文件对应的依赖目录。

新增集成子测试：

1. **普通弹性接力后停止整个任务**：真实调用 `dispatchNextElasticWorkItem`，让节点 1 接手节点 0 失败的关键词（走约 8018 的写入）。另一个关键词在节点 1 上运行时停止批次，父任务为 `waiting_device`；节点 1 完成停止指令后父任务必须为 `canceled`。分两个变体：源执行是普通技术失败；源执行带停止保护。后者在批次结清后源节点仍被挡住。
2. **只有会收到终态通知的类型才等回执**：手机领取（`capture` / `android_elastic_claimed`）、租约超时（`failed` / `revoked`）、覆盖跳过（`superseded` / `revoked`）三种关键词子任务在其它执行停下后结清。对照组 `negative_post_patrol` 在其它执行停下后仍为 `waiting_device`；心跳收到通知后仍不动；回执后结清。

| 检查 | 基线 `5c9d4ae` | 修复后 |
|---|---|---|
| `stop-fence-closure.integration.mjs` | 新增的 2 个子测试失败（父任务停在 `waiting_device`），原有 30 个通过 | 33/33 |
| `server-capture-cloud-contract.test.mjs` | – | 114/114 |
| 反向：只去掉 SQL 里的类型条件 | – | 源码一致性断言失败；2 个新集成子测试失败 |
| 反向：只去掉 JS 镜像里的类型条件 | – | 镜像单元测试失败 |

### 全量回归（修复后，Node 18.20.8）

| 检查 | 结果 |
|---|---|
| PostgreSQL 集成全套 `scripts/run-postgres-integration-tests.mjs`（50 个文件，`--test-concurrency=1`） | 388/388 通过 |
| 单元回归 `scripts/run-node-regression-tests.mjs` | 2772 项，2764 通过，8 失败。8 个都是整文件的环境失败：7 个缺 `typescript`（Admin 测试），1 个缺 `extension-build/`（`capture/douyin-blogger-profile-scope`）。在基线代码上同样 8/8 失败 |
| `node --check server/routes/capture-cloud.js` | 通过 |

补丁对生产线（`97b3765`，其 `capture-cloud.js` 与 `9b836f6` 相同，`a799cbbc…`）用 `git apply --check` 同样适用，只有行号偏移。

## 上线注意

- 发布包只替换 `server/routes/capture-cloud.js`。前置哈希取决于先上哪条：
  - `needs-action-fence` 先上：前置为 `bc6012ca69d3524d743222ca1305c8a919e1cff27e9da87ce8092e174cccf545`。
  - 本修复先上：需要在 `97b3765` 线上另打一个包（前置 `a799cbbc…`；补丁在该线上同样适用，见上文），之后 `needs-action-fence` 的前置哈希也要跟着改。
- **已经卡住的批次不会立刻自己恢复。** 父任务只在子任务事件（节点快照、指令完成、派发等）时刷新。上线后，下次这类事件会把它结清；若某个批次再也没有事件，需要一次人工触发的刷新（写库，需用户点名主机和授权）。只读排查语句：

```sql
SELECT parent.id, parent.title, parent.updated_at,
  COUNT(*) FILTER (WHERE child.metadata->>'terminalDisposition' IN ('canceled','revoked','superseded')
    AND child.task_type NOT IN ('negative_post_patrol','watched_content_patrol',
      'official_account_comment_patrol','followed_creator_post_patrol','official_account_post_discovery')
  ) AS keyword_children_with_disposition,
  COUNT(*) FILTER (WHERE child.status NOT IN ('completed','completed_with_warnings','completed_with_failures',
      'failed','canceled','skipped','superseded','needs_action')
    OR child.metadata->>'stopPending' = 'true'
    OR child.metadata->>'legacyPackStopPending' = 'true') AS still_active_children
FROM capture_tasks parent
JOIN capture_tasks child ON child.parent_task_id = parent.id AND child.tenant_id = parent.tenant_id
WHERE parent.task_type = 'capture_orchestration'
  AND parent.status = 'waiting_device'
  AND parent.metadata->>'operatorStopped' = 'true'
GROUP BY parent.id, parent.title, parent.updated_at
ORDER BY parent.updated_at;
```

`still_active_children = 0` 且 `keyword_children_with_disposition > 0` 的行，就是被本 bug 卡住、上线后可以结清的批次。
