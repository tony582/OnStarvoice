# 看板、内容分诊 hotfix 与心跳索引合并发布（2026-09-29）

发布分支：`codex/release-dashboard-heartbeat-20260929`，合并提交 `acbe77f`，基线 `b89b181`。合并了：

- `codex/hotfix-dashboard-triage-load-20260929`（`450b6f6`，代码到 `4b22f60`）：设计见 `docs/hotfix/20260929-dashboard-triage-load.md`；
- `codex/hotfix-heartbeat-claim-load-20260929`（`cdd6893`）：设计见 `docs/hotfix/20260929-heartbeat-claim-load.md`。

两个分支没有共同文件。**生产当前版本是 `acbe77f`，下一个 hotfix 以它为基线。**

## 发布前核对

| 项目 | 结果 |
| --- | --- |
| 合并后的树，Node 全量回归（Node 18.20.8） | 3,191 / 3,191 |
| 合并后的树，PostgreSQL 全量集成（本机 PostgreSQL 17.9） | 466 / 466 |
| 发布分支 CI（运行 36528323692） | 五项全部通过：`Tests and builds`、`Production Node 18 compatibility`、`PostgreSQL 14 / Node 24.12.0`、`PostgreSQL 16 / Node 24.12.0`、`PostgreSQL 16 / Node 18.20.8` |
| 合并后的树与看板发布包清单 | 要替换的 6 个文件、新增的 2 个文件、预检核对的 12 个文件，SHA-256 全部一致 |

看板发布包没有重新生成：`server.tar.gz` `94f9cb35…`、`admin-dist.tar.gz` `e31f30d1…`、`deploy.sh` `56fe6328…`，与该包 `RELEASE.md` 记录的一致。

## 过程（Asia/Shanghai）

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 13:54:05 | 只读预检 | 负载 0.42；没有超过 30 秒的事务，没有自动清理在运行；生产文件仍是 `b89b181`；没有 091 的索引和登记 |
| 13:54:37–13:54:38 | `CREATE INDEX CONCURRENTLY` 六条 | 各用时 24–161 ms；六个索引有效；随后 `ANALYZE capture_tasks`、`capture_agent_commands` |
| 13:56 | 只读复核（`scripts/diagnostics/heartbeat-claim-explain.mjs`，12 个节点） | 所有语句经过新索引，没有顺序扫描；数字见心跳索引的设计文档 |
| 14:01 | 上传看板发布包到 `/opt/onstarvoice-private/releases/dashboard-triage-load-4b22f60-20260929` | `sha256sum -c SHA256SUMS` 通过；`deploy.sh --check` 通过 |
| 14:02 | 把 091 迁移文件放进 `/opt/onstarvoice/server/db/migrations/` | **`/api/health/ready` 变为 503**，`deploy.sh --check` 失败（见下） |
| 14:03:36 | 删除刚放入的迁移文件 | 就绪恢复 200；`deploy.sh --check` 通过 |
| 14:05:42 | 核对六个索引有效、定义与迁移一致后，向 `schema_migrations` 登记 `091_capture_heartbeat_indexes.sql` | 已登记；就绪 200 |
| 14:05:52 | 再次放入 091 迁移文件（SHA-256 `7a72a541…`） | 就绪保持 200；`deploy.sh --check` 通过 |
| 14:06:09 | 只读核对当前活动 | 没有执行中的任务，没有未完成的指令；9 个节点在线 |
| 14:06:36–14:06:44 | `bash deploy.sh` | 替换 6 个文件、新增 2 个、Admin index 换为 `3f6cfb73…`；重启一次，PID 531363 → 549985，重启计数 31 → 32，启动 3 秒后就绪 |

## 意外：迁移文件让就绪检查失败

- 现象：放入 091 迁移文件后，`/api/health/ready` 返回 503，`{"status":"not_ready","reason":"database_unavailable"}`；`/api/health/live` 和 `/api/health` 仍是 200，服务照常处理请求。
- 原因：就绪检查调用 `assertRuntimeSchemaReady`，它列出磁盘上的迁移文件，逐一核对是否已登记在 `schema_migrations`。文件在、登记不在，就判定数据库结构未就绪。
- 原计划的错误：计划里写的是「看板包的重启顺带登记 091」。但看板包的预检要求服务就绪，文件未登记时预检通不过，走不到重启。
- 影响：未就绪约 80 秒（14:02 至 14:03:36）。14:01:30 至 14:04:00 nginx 记录 200 共 214 次、304 共 22 次，没有 5xx。当天没有任何经 nginx 的请求访问过就绪接口；用它的只有发布脚本。
- 处理：先登记、再放文件。登记时迁移的全部效果（六个索引）已经存在，登记的这一行与迁移程序执行完文件后写入的那一行相同。之后的启动发现 091 已登记，不再执行迁移文件，也就不会在启动时对 `capture_tasks` 加锁。

以后带迁移的文件式发布：先让迁移生效并登记，再放迁移文件；或者放入文件后立刻执行 `node db/migrate.js`。不要让未登记的迁移文件留在生产的迁移目录里。

## 上线后核对

| 时间 | 项目 | 结果 |
| --- | --- | --- |
| 14:07:01 | 生产文件与 `acbe77f` 比对 | 8 个代码文件、迁移文件，以及未改动的 `capture-cloud.js`、`capture-stop-fence.js` 服务文件，SHA-256 全部一致 |
| 14:07:01 | 就绪、进程 | 200；`onstarvoice` 在线，内存 126 MB |
| 14:12:17 | nginx，14:06:30 之后 | 502 只出现在 14:06:39–14:06:40（重启的两秒）：心跳 2 次、存活上报 2 次、LLM 中转领取 2 次、徽标 1 次、处理进度 1 次。之后心跳 46 次、存活上报 44 次、徽标 5 次全部 200。没有 500、503 |
| 14:12:17 | PostgreSQL 日志，14:05 之后 | 没有与本次发布有关的错误。共 3 条：2 条是核对时一条只读查询的引号写错（14:09:50），1 条是发布前就反复出现的内容标注错误（见下） |
| 14:12:17 | PM2 错误日志 | 重启后只新增了同一条内容标注错误（14:10:09） |
| 14:10:04 | 索引使用次数 | `stop_fence_unconfirmed` 1,986、`agent_slot_blocking` 1,574、`stop_fence_local_release` 479、`terminal_notice` 148、`settled_run_proof` 45、`accepted_stop` 45 |
| 14:10:04 | 节点 | 2 分钟内有完整心跳的节点 9 个 |
| 14:10:04 | 迁移登记 | 最新为 `091_capture_heartbeat_indexes.sql` |

## 发布前就存在、与本次无关的问题

PM2 错误日志里反复出现 `[AI] Label error for record a52c85cb-abe9-41a5-850b-a933e4922e9d: invalid input syntax for type json`，PostgreSQL 的说明是 `Unicode low surrogate must follow a high surrogate`：写入的 JSON 里有半个表情符号（`\ud83e`）。同类错误 09-27 00:00 的日志里就有，本次发布前的 14:00 也在出现。应当是截断文本时切开了一个表情符号，需要单独处理。

## 还要观察的

空闲时的读取量已经降下来，但超时和 500 发生在采集高峰。对照 09-20 至 09-29 的数字（终止通知语句超时 284 次、节点锁等待超时 897 次、父任务行锁超时 156 次；09-28 心跳 500 共 69 次、存活上报 500 共 55 次），看 20–22 点和次日 03–05 点：

1. PostgreSQL 日志里被取消的语句和锁等待超时。
2. nginx 里 `/api/capture-cloud/agent/heartbeat`、`/api/capture-cloud/agent/liveness` 的 500，`/api/capture-cloud/overview` 的 503。
3. PM2 日志里 `[CaptureOverview] projection failed`、`slow projection`。

## 回退

两部分互不依赖，可以单独回退。

- 看板包：发布目录里有 `backup/`。恢复 6 个文件和 Admin index，删除 2 个新增文件，重启。没有数据需要回退。
- 索引：`DROP INDEX CONCURRENTLY` 六个索引。语句没有变，计划回到原状。迁移文件和登记保留。
