# 节点心跳与停止保护查询的读取开销（2026-09-29）

分支：`codex/hotfix-heartbeat-claim-load-20260929`，基线 `b89b181`。2026-09-29 12:50 核对：生产 `/opt/onstarvoice` 的 `server/services/capture-cloud.js`、`server/services/capture-stop-fence.js`、`server/routes/capture-cloud.js` 与 `b89b181` 的 SHA-256 完全一致（`codex/hotfix-dashboard-triage-load-20260929` 当时尚未提交、未上线）。

本批只新增一个数据库迁移（091，六个部分索引）、测试和一个只读测量脚本。不改任何 SQL 语句、Server 代码、Admin、Extension、Android Runner、依赖和环境配置。停止保护 SQL（`captureTaskUnconfirmedLocalStopSql`）逐字节不变，原有的 SHA-256 钉子测试不变。

## 现象

2026-09-20 至 09-29 的生产日志：

- 节点心跳里的「终止通知」查询在 2 秒处被取消 284 次。
- 节点执行槽锁 `pg_advisory_xact_lock` 等待超时 897 次；`SELECT id FROM capture_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE` 等待超时 156 次。
- nginx，09-28 全天：心跳 23,882 次成功、500 共 69 次、503 共 44 次；存活上报 20,020 次成功、500 共 55 次。500 集中在 03–05 点和 20–22 点。09-29 截至 12:52：心跳 500 共 32 次，存活上报 500 共 28 次。
- 平均每分钟约 17 次心跳、14 次存活上报。

## 取证方法

全部只读（2026-09-29 12:50–13:40，生产负载 0.2–0.4）。第 1、3 步已整理成 `scripts/diagnostics/heartbeat-claim-explain.mjs`：

```bash
node scripts/diagnostics/heartbeat-claim-explain.mjs --nodes=6 > explain.sql
```

在目标数据库上用 `psql -X -f explain.sql` 执行；每条语句跑两遍，看第二遍。

1. 用记录型执行器调用真实函数（`findCaptureAgentExecutionSlotBlocker`、`readStopFenceHeartbeatWork`、`listCaptureAgentStopFences`、`claimStopFenceCheckOffers`），从路由源码截取内联语句，得到与线上逐字相同的 SQL。
2. 本机对真实的 `/agent/heartbeat` 处理函数抓取一次心跳发出的全部语句，补齐调度领取路径。
3. 生产上在 `BEGIN READ ONLY` 事务里对每条 SELECT 执行 `EXPLAIN (ANALYZE, BUFFERS)`：去掉 `FOR UPDATE … SKIP LOCKED`，`plan_cache_mode = force_custom_plan`（与 node-postgres 的未命名语句一致），任务最多的 6 个节点加上停止保护记录最多的 6 个节点，每条语句跑两遍取第二遍。
4. 本机 PostgreSQL 17 用 9,000 行合成数据（堆 14 MB、连 TOAST 29 MB）复现计划形状并试验索引。生产是 PostgreSQL 14.24，本机数字只说明方向。

## 根因

### 1. 一次心跳是三个事务，都要同一把节点锁

| 事务 | 内容 | 语句上限 | 锁等待上限 |
| --- | --- | --- | --- |
| 优先控制 `claimPriorityAgentControl` | 节点锁、存活时间、终止通知、停止指令 | 2 秒 | 500 ms |
| 主事务 | 节点锁、任务快照入库、停止保护预检、补详情领取、弹性领取、指令下发 | 无 | 无 |
| 停止保护核对下发（有待办时） | 节点锁、隐式放行、六行列表 | 1.5 秒 | 500 ms |

`/agent/liveness` 也先取同一把节点锁，只等 500 ms。主事务没有语句上限，持锁期间要跑下面几条读取量很大的语句；数据库一忙，主事务拖过 500 ms，同一节点的存活上报和下一次心跳就在节点锁上超时。这两条路由只把通道占满映射成 503，锁等待超时（55P03）和语句超时（57014）直接成为 500。

父任务行锁超时来自 `/agent/commands/:id/complete`：它先锁批次父任务，而同批次其它节点的心跳、调度事务正持有该行。

### 2. 各语句的读取量（生产，空闲，缓存已热）

| 语句 | 触发 | 耗时 | 读取页数 | 原因 |
| --- | --- | --- | --- | --- |
| 停止保护预检 `readStopFenceHeartbeatWork` | 支持核对协议的节点每次完整心跳 | 10–44 ms | 3,000–8,500 | 对该节点全部 `superseded` 记录扫 4 遍（最大的节点 257 条、228 个堆页），每条都要读 `metadata` |
| 执行槽占用 `findCaptureAgentExecutionSlotBlocker` | 每次领取尝试 | 8–20 ms | 1,957 | 整表顺序扫描：没有可用的「租户 + 节点」索引 |
| 同上，节点带未放行的停止保护记录 | 同上 | 205–440 ms | 75,368 | 加上整个放行判定子查询 |
| 终止通知 | 支持终止回执的节点每次心跳 | 2–17 ms | 500–1,580 | 经 `idx_capture_tasks_agent_updated` 读出该节点历史上全部任务（最多 798 条、647 个堆页），真正的候选不超过 19 条 |
| 核对下发的六行列表 | 预检有待办时 | 217–274 ms | 约 79,000 | 放行判定子查询 |
| 隐式放行查询 | 同上 | 10 ms；带记录的节点 207 ms | 2,500–3,600；75,400 | 同上 |
| 全租户停止保护列表 | 调度中心每 15 秒、值守视图 | 288 ms | 102,139 | 同上 |
| 转任务排队原因 | `POST /agents/:id/tasks` | 1–2 ms；带记录的节点 206–220 ms | 330–660；73,400 | 同上 |
| 弹性领取候选 | 每次领取尝试 | 1–2 ms（规划 6–17 ms） | 131–137 | 不在本批范围 |
| 指令下发 | 每次完整心跳 | 0.3–0.7 ms（规划 5–11 ms） | 1 | 不在本批范围 |

放行判定子查询一次 73,403 页，构成：

| 部分 | 页数 | 耗时 |
| --- | --- | --- |
| `settled_runs`：顺序扫描 `capture_tasks`，9,043 行里 3,211 行通过 | 45,598 | 122 ms |
| `historical_stop`：顺序扫描，3,025 条 `superseded` 逐条读 `metadata` 两次，剩 7 条 | 25,220 | 66 ms |
| `stop_successor`：7 次探测，每次读出父批次全部子任务 | 1,511 | 3 ms |
| `confirmed_stops`：顺序扫描 `capture_agent_commands`，8,260 行里 425 行 | 1,074 | 3 ms |

### 3. 两个放大因素

- **`metadata` 每引用一次就解一次 TOAST。** 生产 `metadata` 中位数 2,346 字节，8,779 行里 5,978 行超过 2 KB，存放在行外。同一行在一条语句里被 `->>` 引用几次，就去 TOAST 表读几次。
- **列表语句总是先跑子查询。** 规划器按单行代价给并列条件排序，散列子查询的单行代价最低，排在「错误码等于停止保护码」之前。所以列表语句即使该节点一条停止保护记录都没有，也会把整个子查询跑一遍。执行槽占用语句把判定放在 `OR` 里，不会被重排，只有节点确有记录时才跑。

### 4. 为什么空闲时 2–17 ms 的语句会超过 2 秒

这一条是推断，没有直接测量（`track_io_timing` 关闭，未启用 sar 历史）：

- 主机 1.6 GB 内存，没有交换区，页缓存约 1.0 GB；`shared_buffers` 128 MB；`records` 连索引 792 MB。
- 08-20 起数据库缓存命中率 88.77%；开机以来平均每秒从磁盘读入 1.1 MB。
- 采集入库高峰时 `capture_tasks` 的堆页和 TOAST 页被挤出缓存。终止通知一次要读约 1,500 页，每页 1.3 ms 就是 2 秒。

因此本批的目标是减少每条语句读的页数，而不是调上限。

### 5. 其它事实

- `idx_capture_tasks_agent_active_load` 自统计重置（08-20）以来使用 0 次：它的状态条件缺 `waiting_device`、`interrupted`，证明不了执行槽占用语句的条件。
- `capture_tasks` 483,648 次更新里只有 6,860 次是 HOT 更新（`updated_at` 在两个索引里）。也就是几乎每次更新都要写全部索引，新增索引必须小。
- 带停止保护码的记录共 20 条：13 条 `canceled`（不占用节点），7 条 `superseded`，全部属于 4 个已迁出（`migrated`）的节点，最后更新在 09-02 至 09-13；其中 6 条按现行规则仍占用节点。它们不影响派发，但让全租户列表每次都要做 7 次接力任务探测。
- 已放行记录 59 条，当前没有待释放本机锁的记录。

## 修改

迁移 `server/db/migrations/091_capture_heartbeat_indexes.sql`，六个部分索引。索引条件逐字重复语句里已有的条件，规划器才能证明可用。

| 索引 | 服务的语句 | 本机大小（条目） |
| --- | --- | --- |
| `idx_capture_tasks_stop_fence_unconfirmed`：租户、节点、状态；条件是错误码等于停止保护码 | 执行槽占用的停止保护分支、列表、预检、隐式放行、`historical_stop` | 16 kB（122） |
| `idx_capture_tasks_stop_fence_local_release`：租户、节点；条件是已放行且本机释放待办 | 预检的三处读取、列表的本机释放分支 | 16 kB（7） |
| `idx_capture_tasks_agent_slot_blocking`：租户、节点、状态；条件是七个占用执行槽的状态 | 执行槽占用的在途任务分支 | 16 kB（30） |
| `idx_capture_tasks_terminal_notice`：租户、节点、最后时间、id；条件是五种巡查类型且已终止 | 终止通知 | 32 kB（216） |
| `idx_capture_tasks_settled_run_proof`：租户、状态、平台，附带节点与时间列；条件是 `settled_runs` 的五个静态条件 | `settled_runs`（只读索引，不再访问 `metadata`） | 464 kB（3,445） |
| `idx_capture_agent_commands_accepted_stop`：租户、任务、节点、完成时间；条件是已接受的停止回执 | `confirmed_stops` | 32 kB（152） |

写入代价：前四个索引只收录极少数行；`settled_run_proof` 只收录已结束的采集执行，结束后很少再更新。每次更新要多算几个索引条件，其中读 `metadata` 的条件排在类型、时间条件之后，运行中的任务不会走到。

本机实测（同一批行在有、无六个索引时各更新一次，先做检查点）：被某个新索引收录的行，每次更新多写 1 条索引记录，WAL 记录数约多 11%（每行约 8.1 条变为 9.0 条）；不被收录的行没有变化。

| 被更新的行 | 行数 | WAL 记录数（无索引 → 有索引） |
| --- | --- | --- |
| 运行中的任务 | 30 | 245 → 272 |
| 已结束的采集执行 | 200 | 1,625 → 1,801 |
| 已终止的巡查任务 | 72 | 579 → 651 |
| 其它已完成任务 | 200 | 1,655 → 1,605 |

## 效果

### 本机（PostgreSQL 17，9,000 行合成数据，25 个节点，同一份数据加索引前后）

| 语句 | 加索引前读取页数（中位 / 最大） | 加索引后（中位 / 最大） |
| --- | --- | --- |
| 执行槽占用 | 22,145 / 22,157 | 1,390 / 1,411 |
| 执行槽占用，节点没有停止保护记录 | 1,731 | 4 |
| 停止保护预检 | 275 / 367 | 74 / 143 |
| 隐式放行查询 | 20,775 / 20,805 | 1,386 / 1,413 |
| 六行列表 | 21,162 / 21,238 | 1,395 / 1,458 |
| 全租户列表 | 25,907 | 2,127 |
| 单节点列表 | 22,239 / 22,285 | 1,400 / 1,434 |
| 终止通知 | 416 / 753 | 35 / 85 |
| 转任务排队原因 | 20,459 / 20,474 | 1,393 / 1,414 |

合成数据里多数节点带停止保护记录、全租户有 68 条待判定记录，所以加索引后仍有约 1,400 页：几乎全部是接力任务探测。所有计划里不再有顺序扫描。

### 集成测试夹具（1,900 多行，6 个节点，6 条带停止保护码的记录）

全量集成测试里的一次运行：

| 语句 | 读取页数 | 禁用索引扫描时 |
| --- | --- | --- |
| 执行槽占用（节点带停止保护记录） | 59–60 | 12,512 |
| 执行槽占用（节点没有未放行记录） | 4 | 359 |
| 停止保护预检 | 8–13 | 1,616–1,828 |
| 列表（节点、六行、全租户） | 3–64 | 12,961–15,093 |
| 隐式放行查询 | 57 | 12,557 |
| 终止通知 | 2–3 | 356 |

### 生产预期与尚未验证的部分

- 每次心跳都会执行的三条语句（预检、执行槽占用、终止通知）：目前在用的节点都没有未放行的停止保护记录，预计各在几十页以内。
- 节点出现未放行的停止保护记录期间，它的执行槽占用语句要执行子查询；全租户列表只要租户里有带停止保护码的记录（目前 20 条）就要执行子查询。预计约 1,700 页，其中约 1,500 页是上面 7 条历史记录的接力任务探测。
- `settled_runs` 走只读索引时，两次清理之间被改动过的堆页仍要回表（每条一页，不解 TOAST）。实际页数取决于自动清理的节奏，需要上线后测量。
- PostgreSQL 14 会选用这些索引：CI 在 PostgreSQL 14 上通过了同一份计划测试（见「验证」）。这是测试夹具上的结果；生产数据上的计划要在建好索引后用测量脚本只读复核。

## 没有改的

- 停止保护 SQL 本身。把 `settled_runs` 改成逐行探测的写法已经做了原型：本机执行槽占用降到 4–28 页。生产只读核对（同一条语句里对每一行同时计算新旧两种写法）：三个租户 9,043 行，差异 0 行，没有 NULL 结果；带停止保护码的 20 行里两种写法都判定 6 行占用、14 行不占用。生产上只有 20 行带停止保护码，这份核对单独不足以作为证明，还需要随机数据的差分测试；逐行探测在没有索引时会让规划器估算代价过高而触发 JIT（976a0c6 的注释记录过）。本批不采用，留作后续。
- 接力任务探测。可以再加一个 `(parent_task_id, (id::text))` 索引，或随逐行探测改成按主键查找。它是一个覆盖全部子任务的索引，每次更新都要写，本批不加。
- 4 个已迁出节点上的 7 条历史记录。是否放行由运营决定。
- 锁等待超时和语句超时在心跳、存活上报上仍返回 500。
- 主事务没有语句上限。
- `idx_capture_tasks_agent_active_load`（从未使用）没有删除。
- `shared_buffers`、连接池配置。

## 验证

- 新增 `tests/capture-heartbeat-indexes.test.mjs`（6 项）：迁移只含 `CREATE INDEX IF NOT EXISTS`、没有 `CONCURRENTLY`；每个索引条件逐字出现在它服务的语句里；`settled_runs` 读取的列都由索引提供；占用执行槽的状态清单与 `CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES` 相同；测量脚本只含读取语句、没有行锁、在只读事务里执行。改动迁移的三种方式（少一列、少一个状态、条件多一层括号）都被测试拦下。
- 新增 `tests/integration/postgres/heartbeat-claim-indexes.integration.mjs`（4 项）：
  - 6 个节点（被占用、后续采集放行、停止回执放行、需处理子任务、本机释放待办、空闲）的准入、列表、预检、终止通知，与禁用全部索引扫描时的结果逐行相同；
  - 心跳核对下发把 976a0c6 规则已放行的记录落成已放行；
  - 每条语句的计划只经过 091 的索引，`settled_runs` 是只读索引扫描，没有顺序扫描；
  - 每条语句的读取页数低于上限，并且不到禁用索引扫描时的四分之一。
- 指定的三个集成测试（`stop-fence-closure`、`historical-stop-fence`、`unattended-self-heal`）：67 / 67。
- Node 全量回归（Node 18.20.8）：3,152 / 3,152。
- PostgreSQL 全量集成（Node 18.20.8，本机 PostgreSQL 17.9，库 `onstarvoice_test_heartbeat_claim_20260929`）：457 / 457。
- 在线建索引演练：在没有 091 的库上用下文的命令建出六个索引，全部有效；随后执行迁移文件，六条语句都报告「已存在，跳过」。
- CI（运行 36526823194，提交 `5083fba`）：`PostgreSQL 14 / Node 24.12.0`、`PostgreSQL 16 / Node 24.12.0`、`PostgreSQL 16 / Node 18.20.8` 三项集成和 `Production Node 18 compatibility` 通过。PostgreSQL 14 上的计划测试：

  | 语句 | 读取页数 | 禁用索引扫描时 |
  | --- | --- | --- |
  | 执行槽占用（节点带停止保护记录） | 62–63 | 12,022 |
  | 执行槽占用（节点没有未放行记录） | 10 | 281 |
  | 停止保护预检 | 8–11 | 1,284–1,413 |
  | 列表（节点、六行、全租户） | 3–59 | 12,383–14,432 |
  | 隐式放行查询 | 54 | 12,062 |
  | 终止通知 | 2–3 | 273 |

- 同一次运行里 `Tests and builds` 第一次失败在 Android Runner 的计时测试「expired upload window closes interrupted while durable events retain their original identity」（`runners/android/test/daemon-integration.test.mjs`，任务期限只留 60 ms）。本批没有改 `runners/`，本机 Node 24.12.0 连跑 8 次都通过；重跑后通过，五项全部通过。
- 尚未做：生产上的建索引与复核。

## 发布与回退

发布内容：一个迁移文件。不需要替换 Server 代码。

1. **先在线建索引。** `deploy.sh` 在旧进程仍在服务时执行迁移，而迁移在事务里建索引会在建完之前挡住 `capture_tasks` 的写入。把迁移里的 `CREATE INDEX IF NOT EXISTS` 换成 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` 后交给 `psql` 逐条执行（不能加 `--single-transaction`，在线建索引不能放在事务里）：

   ```bash
   sed 's/^CREATE INDEX IF NOT EXISTS/CREATE INDEX CONCURRENTLY IF NOT EXISTS/' \
     server/db/migrations/091_capture_heartbeat_indexes.sql > create-indexes-online.sql
   ```
2. 核对六个索引都有效：

   ```sql
   SELECT c.relname, x.indisvalid, pg_size_pretty(pg_relation_size(c.oid))
   FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
   WHERE c.relname IN (
     'idx_capture_tasks_stop_fence_unconfirmed', 'idx_capture_tasks_stop_fence_local_release',
     'idx_capture_tasks_agent_slot_blocking', 'idx_capture_tasks_terminal_notice',
     'idx_capture_tasks_settled_run_proof', 'idx_capture_agent_commands_accepted_stop');
   ```

   在线建索引中途失败会留下无效索引，`IF NOT EXISTS` 会把它当成已存在。遇到 `indisvalid = false` 先 `DROP INDEX CONCURRENTLY` 再重建。
3. `ANALYZE capture_tasks; ANALYZE capture_agent_commands;`
4. 只读复核：重跑 `scripts/diagnostics/heartbeat-claim-explain.mjs` 生成的脚本，确认各语句的计划用到了新索引、读取页数下降。
5. 放入迁移文件。下次启动或部署时迁移发现索引已存在，只登记版本。

上线后核对：

1. `pg_stat_user_indexes` 里六个索引的 `idx_scan` 在增长。
2. PostgreSQL 日志里终止通知、停止保护列表被取消的次数，节点锁等待超时的次数。
3. nginx 日志里心跳和存活上报的 500 次数。

回退：`DROP INDEX CONCURRENTLY` 六个索引。语句没有变，计划回到现状。迁移文件如已登记，保留登记即可；需要重建时手工执行。

## 与看板、内容分诊 hotfix 的关系

`codex/hotfix-dashboard-triage-load-20260929`（分支头 `450b6f6`，代码到 `4b22f60`）同样基于 `b89b181`，改 Server 8 个文件和 Admin，没有迁移。2026-09-29 核对：

- 两个分支没有共同文件，合并没有冲突。
- 合并后的树（`450b6f6` + `5083fba`）：Node 全量回归 3,191 / 3,191，PostgreSQL 全量集成 466 / 466（Node 18.20.8，本机 PostgreSQL 17.9）。
- 合并后的树里，对方发布包要替换的 6 个文件、新增的 2 个文件和它核对的 12 个文件，SHA-256 与发布包 `release-manifest.json` 完全一致。也就是说合并不改变对方已经演练过的发布包。
- 对方 `deploy.sh` 的预检只核对它列出的文件和 Admin index。建索引、放入 091 迁移文件都不影响预检。
- 生产进程是 `compatibility`（角色 `all`），启动时执行迁移。091 迁移文件在场时，对方发布里的那一次重启会登记它；索引已经建好时迁移只登记版本。
- 两边互补：对方把看板的语句上限放宽到 5 秒并在繁忙时回退到最近一次完整结果；本批把看板里的停止保护列表从约 10 万页降下来。

建议同一个窗口发布，分两步，各自可以单独回退：

1. 本批：在线建六个索引，核对有效，`ANALYZE`，只读复核。不重启。回退是删索引。
2. 把 `server/db/migrations/091_capture_heartbeat_indexes.sql`（SHA-256 `7a72a5419c4afee922983aea4acc72c2f39970f14ea4bc9f46089af533f31e5e`）放进生产的迁移目录。
3. 对方发布包原样发布（`deploy.sh --check`，再 `deploy.sh`）。它的重启会登记 091。

不建议为了带上迁移文件重新出包：对方的包已经演练并记录了哈希，迁移文件不在它的核对范围内。

## 附：逐行探测写法（未采用）

原型，供后续评估。与现行写法的对应关系：`id NOT IN (已放行的 id)` 变为「本行不是已放行的行」（id 不会是 NULL，两种写法都只有真、假两个值）；分组后的 `MAX(x) > y` 变为「存在一行 x > y」；对停止回执汇总的左连接变为「存在一条回执」。接力任务仍按文本比较，前面的 uuid 比较只是让主键可用，并且被文本比较蕴含。

```sql
(UPPER(COALESCE(task.error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
    AND task.status NOT IN ('canceled', 'completed', 'completed_with_warnings', 'skipped')
    AND NULLIF(task.metadata->>'recoveryTaskId', '') IS NULL
    AND NOT (
      task.status = 'superseded'
      AND task.metadata->>'stopPending' IS DISTINCT FROM 'true'
      AND EXISTS (
        SELECT 1
        FROM capture_tasks stop_successor
        WHERE task.tenant_id = $1
          AND stop_successor.tenant_id = $1
          AND stop_successor.id = CASE
            WHEN task.metadata->>'handoffSuccessorTaskId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (task.metadata->>'handoffSuccessorTaskId')::uuid
          END
          AND stop_successor.parent_task_id = task.parent_task_id
          AND stop_successor.id <> task.id
          AND stop_successor.id::text = task.metadata->>'handoffSuccessorTaskId'
      )
      AND EXISTS (
        SELECT 1
        FROM capture_tasks stop_proof
        WHERE task.tenant_id = $1
          AND stop_proof.tenant_id = $1
          AND COALESCE(stop_proof.assigned_agent_id, stop_proof.origin_agent_id) =
            COALESCE(task.assigned_agent_id, task.origin_agent_id)
          AND stop_proof.platform = task.platform
          AND LEAST(stop_proof.created_at, stop_proof.started_at) > task.updated_at
          AND stop_proof.task_type IN ('capture', 'unattended_keyword_capture')
          AND COALESCE(stop_proof.metadata->>'executionMode', '') NOT IN ('source_open', 'unattended_plan')
          AND stop_proof.finished_at >= stop_proof.started_at
          AND stop_proof.metadata->>'stopPending' IS DISTINCT FROM 'true'
          AND UPPER(COALESCE(stop_proof.error->>'code', '')) <> 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
          AND (
            stop_proof.status IN ('completed', 'completed_with_warnings')
            OR (stop_proof.status = 'canceled' AND EXISTS (
              SELECT 1
              FROM capture_agent_commands stop_receipt
              WHERE stop_receipt.tenant_id = $1
                AND stop_receipt.task_id = stop_proof.id
                AND stop_receipt.agent_id =
                  COALESCE(stop_proof.assigned_agent_id, stop_proof.origin_agent_id)
                AND stop_receipt.command_type = 'stop' AND stop_receipt.status = 'completed'
                AND stop_receipt.result->>'accepted' = 'true'
                AND stop_receipt.finished_at >= stop_proof.started_at
            ))
          )
      )
    ))
```

生产核对用的语句形状（只读，对租户的每一行同时计算两种写法）：

```sql
WITH evaluated AS MATERIALIZED (
  SELECT task.id, <现行写法> AS baseline_value, <逐行探测写法> AS candidate_value
  FROM capture_tasks task
  WHERE task.tenant_id = $1
)
SELECT count(*) AS rows_compared,
  count(*) FILTER (WHERE baseline_value IS NULL OR candidate_value IS NULL) AS null_values,
  count(*) FILTER (WHERE baseline_value IS DISTINCT FROM candidate_value) AS differing_rows
FROM evaluated;
```
