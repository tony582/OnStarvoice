# 节点存活上报在执行槽锁上超时成 500（2026-10-09）

分支：`codex/hotfix-agent-liveness-lock-timeout-20261009`，基线 `main` `ce6ba02`（生产 2026-10-09 13:12 切成 api / scheduler / ai-media 三进程后的代码 `f649a42` 加文档提交；Server 内容与 main 相同）。只改 Server 一个文件 `server/routes/capture-cloud.js`，新增两个测试。不改数据库、环境变量、Admin、Extension、Android Runner。

## 现象

- 切拓扑后 api 进程日志约每 10 分钟一条（13:13:49、13:23:49）：

  ```text
  [Server] Unhandled error: error: canceling statement due to lock timeout (code 55P03)
      at async execute (server/db/query.js:199)
      at async lockCaptureAgentExecutionSlot (server/services/capture-cloud.js:1154)
      at async lockActiveCaptureAgentSession (server/routes/capture-cloud.js:785)
      at async withTransaction.category (server/routes/capture-cloud.js:9071)
  ```

  请求是 `POST /api/capture-cloud/agent/liveness`，客户端收到 500 `server_error`。
- nginx：切拓扑前整天 `/api/capture-cloud/agent/(liveness|heartbeat)` 每分钟 0–2 次 5xx。`docs/hotfix/20260929-heartbeat-claim-load.md` 记过同一件事：09-28 全天存活上报 500 共 55 次、心跳 500 共 69 次；09-20 至 09-29 节点执行槽锁 `pg_advisory_xact_lock` 等待超时 897 次。09-29 那批只建索引（091），当时决定「心跳、存活上报在锁等待超时和语句超时上仍返回 500」留作后续。本批就是这个后续。

## 根因

### 1. 存活上报和完整心跳由同一个闹钟同时发出，抢同一把节点锁

扩展 `background.js` 的 `CLOUD_TASK_AGENT_ALARM_NAME` 每 1 分钟触发一次（`CLOUD_TASK_AGENT_PERIOD_MINUTES = 1`），处理函数里先后、不等待地调用 `syncCloudTaskAgentLiveness()` 和 `syncCloudTaskAgent({force: true})`：存活上报和完整心跳是并发发出的两个请求。服务端两条路由都先取同一把事务级建议锁 `pg_advisory_xact_lock(hashtext('capture_agent_execution_slot'), hashtext('租户:节点'))`：

| 事务 | 锁等待上限 | 语句上限 | 持锁期间做的事 |
| --- | --- | --- | --- |
| 存活上报 `/agent/liveness` | 500 ms | 2 s | 节点行 `FOR UPDATE` 重读、写 `last_liveness_at` |
| 心跳·优先控制 `claimPriorityAgentControl` | 500 ms | 2 s | 写 `last_liveness_at`、终止通知、停止指令 |
| 心跳·主事务 | 无 | 无 | 任务快照入库（最多 50 条）、过期指令、社媒账号与用量事件、停止保护预检、补详情领取、弹性领取、指令下发 |

谁先拿到锁取决于两个请求到达 api 进程的先后。心跳主事务先拿到时，只要它跑过 500 ms（数据库忙、快照多、心跳带社媒用量事件时常见），同一节点的存活上报就在建议锁上等满 500 ms 被取消，55P03。两条路由的 `catch` 只把通道占满（`DbCapacityError`）映射成 503，55P03 和 57014 直接 `next(err)`，由 `app.js` 的兜底处理器记成「Unhandled error」并返回 500。

「约每 10 分钟一次、都在 :49 秒」与此一致：某一个节点的闹钟相位落在 :49，它的心跳大约每 10 次有 1 次超过 500 ms。不是调度进程的定时任务：cron 全部在整分 :00 触发；调度侧对节点锁也不是长持有——`dispatchCrossDeviceRetry` 用 `pg_try_advisory_xact_lock` 加 SAVEPOINT 试锁，拿不到就换候选；`reconcileElasticCaptureLeases`、`expireStaleCommands` 只锁任务行 `FOR UPDATE SKIP LOCKED`；`loadCompatibleProfilePatrolAgent` 每 5 分钟短持有。所以本批没有改调度进程。

### 2. 存活上报本来就不该等这把锁

路由上方的注释写明它的目的是「让在线租约独立于完整的状态对账，一次慢的快照、账号探测或指令不能让健康的浏览器在调度看来离线」。可它排在完整心跳后面等同一把锁，恰好在心跳慢的时候失败，违背了自己的目的。而持锁的心跳本身——优先控制事务和主事务——都会在提交时写 `last_liveness_at = now()`；在线判定窗口是 2 分钟（`captureAgentLivenessOnline`），闹钟是 1 分钟。所以锁被占的时候，这次上报没有任何需要写的东西。

### 3. 扩展对 500 和 503 的处理没有差别

扩展 `utils/cloud-task-agent.js` 的 `requestJson` 对所有非 2xx 都返回 `{ok: false, status, reason, message}`，不读响应里的 `retryAfterMs`；心跳失败走扩展自己的指数退避（`recordCloudTaskAgentFailure`，15 秒起、最长 5 分钟）；存活上报的返回值被丢弃，只在抛异常时打印。所以把 500 改成 503 不改变任何节点的行为，只改变 api 日志和 nginx 的状态码；新增的 `livenessRecorded` 字段扩展不读。不需要发扩展，节点不需要重载。

## 修改

1. `lockActiveCaptureAgentSession(executor, agent, {wait})`：新增 `wait: false`。用 `pg_try_advisory_xact_lock` 试锁，拿不到立即返回常量 `CAPTURE_AGENT_SESSION_BUSY`，不读不写。默认 `wait: true` 路径逐语句不变（阻塞锁 → `FOR UPDATE` 重读 → 授权码/绑定指纹核对），心跳、指令回执、停止保护回执等所有现有调用方不受影响。常量故意是真值，等待路径的调用方 `if (!currentAgent)` 判定撤销的写法不用改。
2. 新增 `readCommittedCaptureAgentSession`：同样的授权指纹核对，读已提交的行，不取建议锁、不取行锁，永远不等待。只用于回答，不用于决定任何写入。
3. `/agent/liveness`：改为 `{wait: false}`。锁被占 → 读已提交的行：已撤销或授权已变更仍 403 `agent_inactive`，否则 200 `livenessRecorded: false`（写入交给持锁者）；锁空闲 → 原样写 `last_liveness_at`，200 `livenessRecorded: true`。事务参数不变（critical、排队 500 ms、语句 2 s、锁等待 500 ms）：锁等待上限现在只兜 `FOR UPDATE` 行锁被锁协议之外的事务持有的情况。
4. 存活上报和心跳两条路由的 `catch` 改用共享的 `isCaptureAgentChannelBusyError` / `sendCaptureAgentChannelBusy`：`DbCapacityError`、55P03（锁等待超时）、57014（语句超时）、40P01（死锁牺牲者）→ 503 `server_busy`、`Retry-After`（`retryAfterMs` 下限 250 ms、默认 1000 ms，向上取整到秒），与 `/agent/commands/:id/complete`、`/agent/stop-fence-checks/:checkId/complete`、`/tasks/:id/stop` 三处现有写法相同；其它错误仍 `next(err)`。

## 没有改的

- 心跳主事务仍没有语句上限和锁等待上限（09-29 记录的待办）。本批之后它持锁变长只会让同一节点下一次心跳的优先控制事务 503 退避重试，不再影响存活上报。
- 扩展闹钟里存活上报和完整心跳同时发出的写法。服务端改成不等待后不需要动扩展。
- 调度进程的几处节点锁用法（见根因 1）。
- 三处现有的内联 503 映射没有改成共享函数，行为相同。

## 验证

- `tests/server-capture-cloud-contract.test.mjs` 新增 2 项，全文件 121 / 121 通过（Node 24.12.0）：
  - 不等待路径：锁被占时只发出一条 `pg_try_advisory_xact_lock`，不读不写；拿到锁时与等待路径同样 `FOR UPDATE` 重读和授权核对，并且绝不发出阻塞锁；已提交读只有一条不带 `FOR UPDATE`、不带 advisory 的查询，撤销和授权不符都返回 null。
  - 路由源码：busy 判断在任何行读之前，已提交读在撤销判断和 `UPDATE capture_agents` 之前，`SET last_liveness_at = now()` 仍在，事务参数不变；两条路由的 `catch` 都是「共享映射 → `next(err)`」，不再各自判 `isDbCapacityError`。
  - 映射：四种错误为真、普通错误 / 23505 / 40001 / null 为假；`retryAfterMs` 的下限、默认值、`Retry-After` 向上取整；响应体字段。
- 新增 `tests/integration/postgres/capture-agent-liveness-slot.integration.mjs`（本机 PostgreSQL 17，真实路由处理函数、真实事务）：锁空闲时写入；另一个连接持有建议锁时 200 `livenessRecorded: false`、不等 lock_timeout、不写；持锁期间节点被撤销 → 403；行锁被锁协议之外的事务持有 → 等 500 ms 后 503 `server_busy` + `Retry-After: 1`、没有进 `next(err)`；锁释放后再次写入。
- 基线对照（同一个库、同一把被占的建议锁、同一个处理函数）：

  | 代码 | 耗时 | 结果 |
  | --- | --- | --- |
  | 基线 `ce6ba02` | 588 ms | 55P03 进了 `next(err)`，即生产看到的 Unhandled error 500 |
  | 本批 | 13 ms | 200 `livenessRecorded: false`，`fullHeartbeatAt` 来自已提交的行 |

- 全量回归（本机，Node 24.12.0）：Node 回归 3,286 / 3,286（21 秒）；PostgreSQL 全量集成 518 / 518（本机 PostgreSQL 17.9，库 `onstarvoice_test_agent_liveness_20261009`，5 分钟），其中经过 `lockActiveCaptureAgentSession` 的心跳、停止保护、指令回执集成测试全部通过。

## 发布与回退

- 发布内容：`server/routes/capture-cloud.js` 一个文件。没有迁移、没有环境变量，不改 Admin、Extension、Runner。三进程拓扑下 api 和 scheduler 都加载这个文件，走 `deploy.sh` 正常发布即可；跑之前先核对本机 `.env.production` 的键数（`docs/hotfix/20261009-triage-export-timeout.md` 记录的 10-09 事故）。
- 上线后核对：
  1. api 日志里不再出现 `canceling statement due to lock timeout` 的 Unhandled error。
  2. nginx 里 `/api/capture-cloud/agent/liveness` 的 5xx 应接近零（剩余的 503 只来自行锁或语句超时）；`/agent/heartbeat` 原来的 500 变成 503。
  3. 节点列表里没有节点因此掉线：持锁的心跳本来就写 `last_liveness_at`。
- 回退：换回上一版文件重启。没有数据变化。

## 发布记录（2026-10-09）

- 14:23 以 merge commit `063eb00` 并入 main（基于 `5d97534`，与分支 `687d1fd` 四个文件逐字节相同）；合并后 Node 回归 3289/3289、隔离库集成 518/518（含新增 `capture-agent-liveness-slot.integration.mjs`）。
- 14:29:23–14:29:55 由 `deploy/deploy.sh` 发布（与 api 内存上限 350→400M 同批），三进程 PID 815402/815403/815404 重建，切换窗口 nginx 14 个 502。
- 14:30–14:42 观察：api 错误日志 0 条 `Unhandled error`、0 条 55P03（仅 1 条慢投影告警）；nginx 上 `/agent/heartbeat` 152 次、`/agent/liveness` 147 次全部 200，整站 0 个 5xx（发布前 0–2 次/分钟）；三进程 68/67/57 MB、无重启；`pg_locks` advisory 2；12 台 Agent 心跳正常。
