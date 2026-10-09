# 内容分诊导出 500 与表头快捷筛选（2026-10-09）

分支：`fix/triage-export-and-header-filters-20261009`，基线 `main` `4581e2e`（生产 server 与后台静态都等于 main 的内容）。两件事一起发：导出语句超时的根治，和 10-02 改版时拿掉的表头快捷筛选。

## 一、导出报 500，前端提示「内容加载超时，请稍后重试。」

### 现象

后台「内容分诊」点「导出」，`GET /api/triage/records/export?…&sort=publish&dir=desc` 返回 500，响应体是 `{"error":"server_error","message":"canceling statement due to statement timeout"}`；前端 `triageLoadError` 把带 "timeout" 的文案翻成列表加载用的「内容加载超时」，把人引向刷新重试。

### 根因（本机 EXPLAIN ANALYZE 复现）

导出一条 SELECT 取最多 5,000 行，每行带一段「处理记录」相关子查询（内容备注、状态变更备注、工单过程三段 `UNION ALL` 后 `string_agg`）。其中状态备注那段的条件是

```sql
al.target_id = r.id::text OR COALESCE(al.metadata->'recordIds','[]'::jsonb) ? r.id::text
```

`audit_logs` 只有 `(tenant_id, created_at)` 和 `(actor_user_id, created_at)` 两个索引，OR 的两边都没有索引可走，规划器对每一行都顺序扫描整张 `audit_logs`。按生产量级造数（一个租户 3 万条可见内容、8.3 万条审计日志，其中 3.3 万条带备注的分诊记录）后，用真实路由抓到的语句原文做 `EXPLAIN (ANALYZE, BUFFERS)`：

| 运行 | 耗时 | 读取页数 | audit_logs 节点 |
| --- | --- | --- | --- |
| 现状，LIMIT 500 | 12.7 s | 160 万 | `Seq Scan on audit_logs`，每行过滤掉 82,997 条，loops=500 |
| 现状，LIMIT 5000 | 122.6 s | 1,418 万 | 同上，loops=5000 |
| 加两个索引，LIMIT 500 | 0.32 s | 21.7 万 | `Bitmap Heap Scan` ← `BitmapOr`（两个新索引各探一次） |
| 加两个索引，LIMIT 5000 | 0.57 s | 31.8 万 | 同上 |

读取量的 87% 都在那一段子查询上；`record_notes`、`tickets`/`ticket_notes`、`record_watchlist` 各自有索引，不是瓶颈。明细见 `docs/hotfix/evidence/triage-export-explain-20261009.json`。导出的 10 秒语句上限（`queryTriageAll`，reporting 类别）一到，PostgreSQL 取消语句，路由 `catch` 走 `next(err)` 变成 500。

列表页的「最近进展」LATERAL 子查询和详情页的活动流用的是同一个条件，只是每页只算几十行、没有触发超时；它们同样受益于下面的索引。

### 修复

1. **迁移 093 `server/db/migrations/093_audit_logs_record_lookup_indexes.sql`**：
   - `idx_audit_logs_tenant_target` — `btree (tenant_id, target_id)`，承接 `target_id = r.id::text`；
   - `idx_audit_logs_record_ids` — `GIN ((COALESCE(metadata->'recordIds','[]'::jsonb)))`，表达式与语句逐字相同，承接 `? r.id::text`。
   不改任何 SQL 语句文本。合成表上两个索引分别 6 MB / 2.5 MB，建索引 244 ms / 59 ms；`deploy.sh` 里 `node db/migrate.js` 用 `CREATE INDEX IF NOT EXISTS` 建，期间对 `audit_logs` 持 ShareLock（写审计会短暂等待，按生产表量级是秒级）。
2. **导出单独的语句上限 30 秒**（`EXPORT_STATEMENT_TIMEOUT_MS`）：`record-triage-query.js` 的 `queryTriageAll/One` 现在接受 `statementTimeoutMs` 覆盖，只有导出传了这个值；reporting 类别、只读事务、锁等待 500 ms、排队 3 秒都不变，列表仍是 10 秒。这是兜底，不是修复本体。
3. **导出失败的回答**（`exportFailureResponse`）：语句被取消（57014）→ 504 `export_timeout`「导出超时：当前筛选结果较多，请缩小时间范围或筛选条件后重试。」；数据库通道占满 → 503 `server_busy` 带 `Retry-After`，与列表一致；其它仍交给统一 500。
4. **前端**：`exportXlsx` 的失败提示改用 `exportFailureMessage`，直接转述服务端 message（「导出失败：…」），不再套 `triageLoadError` 的「内容加载超时」。
5. 把处理记录那段 SQL 提成 `processingRecordsSql(alias)` 供测试做 EXPLAIN；路由里拼出来的文本不变。

### 测试

- 新增 `tests/integration/postgres/triage-export-processing-records.integration.mjs`：先在没有 093 的库上跑过一次确认会红（规划器只走 `idx_audit_logs_tenant_created`），有 093 后：状态备注子查询的 `audit_logs` 节点必须经两个新索引、不得是顺序扫描；导出的「处理记录」逐条核对（内容备注 + 状态备注按时间排列、批量备注经 `recordIds` 命中、工单「处理进展」与「结案」、无备注为空、空白备注与别的租户的备注不出现）；导出语句上限 30 秒而列表仍是 10 秒（截获 `set_config('statement_timeout')`）。
- `record-triage-query.integration.mjs`：`statementTimeoutMs` 覆盖只改语句上限，提交后连接设置复原。
- 新增 `tests/triage-export-failure-response.test.mjs`：57014 → 504、容量错误 → 503 带重试、带 status 的错误透传、其它返回 null。
- `tests/admin-triage-load.test.mjs`：`exportFailureMessage` 的文案与 `exportXlsx` 的接线。

## 二、恢复表头快捷筛选

10-02 的改版（`08080f2`…`ba5c112`）把表头里的筛选控件拿掉了。这次把用户圈出的五列加回去，都只是入口，和上方筛选行里同名的筛选共用同一份 state：

| 表头 | 控件 | 共用的 state |
| --- | --- | --- |
| 情感 | `HeaderSingleFilter`（单选） | `sentiment` |
| AI 判断 | `PostIntentFilter header` + `PostRelevanceFilter header`（意图、相关性+置信度） | `intents` / `relevances` / `relevanceConfidences` |
| 风险信号 | `HeaderMultiFilter` | `risk` |
| 疑似身份 | `HeaderMultiFilter` | `identity` |
| 处理状态（固定列） | `HeaderMultiFilter`，菜单向左展开 | `triageStatuses` |

互动、评论、点赞、三个时间列仍只排序；平台、内容主题等不常用维度不进表头。触发器沿用表头的 11px 大写字体，激活才变主色并带数量角标，菜单是 Radix DropdownMenu（与 10-02 前的实现同源）；查询区两行无边框的布局不动，多选不锁页。

四个锁源码结构的契约测试（`admin-triage-list-ux-contract`、`admin-post-judgment`、`admin-record-activity-contract`、`admin-triage-modes-contract`）从「表头不放筛选器」改成「表头五个入口绑定同一份 state、表头不复用筛选行的 pill 组件」。

## 本机核对

| 项目 | 结果 |
| --- | --- |
| 单元回归 `run-node-regression-tests.mjs` | 3,274 个，3 个失败全部是 `main` 上已有的（`server-cron-runtime` 两个、`update-manifest` 的 Runner 版本 0.3.0 vs 0.3.2），`main` 的 CI 自 10-08 起同样红在这两处与后台 lint 基线（`CustomerMonthlyReport.tsx` 两处）；本分支没有新增失败 |
| PostgreSQL 集成（新测试 + record-triage-query + triage-handled-date + content-topic + record-relevance-filter + record-triage-admission + migrations） | 16 / 16 |
| 后台 `tsc -b`、`vite build` | 通过 |
| 后台 lint 基线 | 263 ≤ 288，但 `CustomerMonthlyReport.tsx` 2 处超出单文件上限，是 10-08 月报提交带入的，与本分支无关 |
| CI（`fix/**` 不触发，推了镜像分支 `codex/fix-triage-export-and-header-filters-20261009`，运行 37881305993） | PostgreSQL 14 / Node 24、PostgreSQL 16 / Node 18、PostgreSQL 16 / Node 24 三个集成任务全部通过（第一轮 37880422901 的计划断言在 4,000 行填充上被 PG14/16 规划器选了顺序扫描，改成 2 万行 + `VACUUM ANALYZE` 后通过）；两个单测任务红在 `main` 已有的三处（cron runtime 两条、Runner 版本断言），与本分支无关 |
| 本地预览（API 接 3 万条内容的合成库 + vite，一次性测试账号） | 表头情感→负面、处理状态→待处理、风险信号→有负评、疑似身份→4S店、意图→投诉/抱怨、相关性→相关逐个点开：列表请求依次带上 `sentiment/status/risk/identity/intent/relevance`，筛选行同名芯片同步变成激活态、表头触发器变主色并带数量，「清空筛选」一次全部复位；点「导出」对该租户（5,000 行）返回 200 |

## 发布

服务端有迁移和路由改动，后台有静态改动：走 `deploy/deploy.sh`（rsync server + 构建并 rsync admin dist + `node db/migrate.js` + PM2 重启）。回退：代码回到 `4581e2e` 重发；两个索引留着无害（也可 `DROP INDEX`）。

## 发布过程（Asia/Shanghai，2026-10-09）

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 11:3x | 只读预检 | 生产 `triage.js`、`record-triage-query.js`、`app.js` 的 SHA-256 与 `main` `4581e2e` 一致；PostgreSQL 14.24；`audit_logs` 16,067 行 / 15 MB，`records` 37,484 行；就绪检查正常（PID 782111，role=all） |
| 11:40 | `CREATE INDEX CONCURRENTLY` 建两个索引 | 649 ms / 47 ms，`indisvalid` 均为 t，896 kB / 848 kB |
| 11:42:10–11:42:40 | `bash deploy/deploy.sh 47.103.125.200` | 构建后台、rsync、`node db/migrate.js` 登记 093（索引已存在，`IF NOT EXISTS` 直接通过）、PM2 重启，脚本退出码 0 |
| 11:42:40–11:45:56 | **事故：服务起不来，公网 502 约 3 分钟** | 新进程循环崩溃：`PROCESS_ROLE must be explicitly set in production`。原因是 `deploy.sh` 把本机 `server/.env.production`（2026-07-28 的旧文件，18 个键）覆盖到了 `/opt/onstarvoice/server/.env`，而线上这个文件自 7 月以来在服务器上手工加过 9 个键（`PROCESS_ROLE=all`、`PG_GENERAL_WAIT_MS`、`OPS_CONTROL_*`、`CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY`、`ANDROID_DISCOVERY_INGEST_TENANTS`、`CAPTURE_FILTER_VERIFICATION_LIMIT`），最后一次改动是 09-27 17:38。nginx 在 11:42–11:45 共记录 136 个 502 |
| 11:45:56 | 恢复 | 从 09-28 发布目录保留的 `server-previous/.env`（与 09-27 17:38 的线上文件逐字节相同，27 个键）复制回 `/opt/onstarvoice/server/.env`，`pm2 restart onstarvoice --update-env`；就绪检查与公网健康恢复，PID 807090，role=all |
| 11:47 | 发布后核对 | 线上 `index.html`、`triage.js`、`record-triage-query.js`、`093_*.sql` 哈希与本分支一致；`schema_migrations` 含 093；只读 `EXPLAIN (ANALYZE, BUFFERS)` 最大租户（30,150 条内容）导出 5,000 行的处理记录子查询：`audit_logs` 走 `BitmapOr(idx_audit_logs_tenant_target, idx_audit_logs_record_ids)`，每行 0.012 ms，整句 3.96 s（冷缓存，含 records 的并行顺序扫描 0.8 s） |

### 事故结论与遗留

- 直接原因：`deploy/deploy.sh` 无条件 `scp server/.env.production → /opt/onstarvoice/server/.env`，而本机那份自 07-28 起没有再同步过线上手工改动。此前几次发布走的是 Codex 的文件包发布器（不碰 `.env`），所以没有暴露。
- 本机 `server/.env.production`（主工作区与本工作树两份）仍是旧内容；自动模式拒绝我把线上文件拉回本机（凭据落盘），**下一次再跑 `deploy.sh` 之前必须先用线上的 `/opt/onstarvoice/server/.env` 更新本机这份文件**，或者改 `deploy.sh`（发布前备份线上 `.env`、本机副本键数少于线上时拒绝覆盖）——后者是行为变更，留给用户决定。
- 事故前后数据库没有任何数据变更；两个索引与迁移登记在事故前已完成。

## 追加：导出里的小红书链接（2026-10-09 下午）

用户问「导出文件里小红书的帖子链接为什么是空的」。`postUrl` 自 0.4.0（`ac90461`，08-31）起对小红书一律返回空：当时的结论是笔记链接携带的 `xsec_token` 短期、绑定采集账号，过期后打开报 300031，所以「不写进导出文件，只在后台经采集节点实时打开」。但 0.4.5 起后台列表的「原文」已经直接用存下来的带 token 链接（`validatedStoredXhsSourceUrl`：https 小红书域名、笔记 ID 与 `external_id` 一致、仍带 token），安吉星 18,007 条小红书内容里 18,006 条有这种链接、17,739 条可核验，所以后台能点、导出为空。用户选择「导出与后台原文一致」。

- `887ff22`：`postUrl` 对小红书改为 `validatedStoredXhsSourceUrl(r.url, r.external_id)`，不可核验的仍为空，其它平台不变；注释改成新规则。测试：`tests/triage-export-post-url.test.mjs`（先行失败：函数未导出），集成测试里加一条带 token 的小红书记录核对「帖子链接」列。
- 已知限制：这种链接和后台「原文」一样会随 token 过期失效（300031）。

### 发布过程与第二次事故

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 13:12 | （另一会话）发布拆分拓扑 `ce6ba02` | 生产变成 `onstarvoice-api` / `onstarvoice-scheduler` / `onstarvoice-ai-media` 三进程，`deploy.sh` 也换成按拓扑清单重建进程并核对 .env 键 |
| 13:47:48–13:48:08 | 我从仍基于 `a719347` 的工作树跑了**旧版** `deploy.sh` | `rsync --delete` 把 `/opt/onstarvoice/server` 覆盖成拆分前的代码（新增的 `server/modules/capture/domain/*` 被删、`index.js`/entrypoints/runtime 回到旧版），后台静态换成旧 main 的构建；`pm2 start index.js --name onstarvoice` 起的单进程因 scheduler 角色锁被占而 errored（**没有出现双调度**），但被 `pm2 save` 存进了 dump。三个拆分进程仍在内存里跑新代码，公网未中断（nginx 在 13:47–13:51 共 8 个 502，来自两次重启） |
| 13:50:51–13:51:19 | 变基到 `ce6ba02` 后用**新版** `deploy.sh` 重发 | 拓扑清单校验通过；线上 27 键均在本地副本；先备份线上 `.env`（`.env.before-deploy-20261009-135106`）；按清单停掉三个进程和 errored 的 `onstarvoice`，再按 `ecosystem.config.cjs` 起三进程（PID 812690/812691/812697，13:51:14），API 就绪 |
| 13:52 | 核对 | `triage.js`、`capture-cloud.js`、`index.js`、`modules/capture/domain/task-status.js`、`ecosystem.config.cjs`、后台 `index.html` 哈希与 `887ff22` 一致；dump 只剩三进程；三进程错误日志为空；`main` 快进到 `887ff22` |

教训：部署前必须 `git fetch` 并确认分支包含 `origin/main`，尤其是同一天有别的会话在发布时；`deploy.sh` 的行为以仓库当前版本为准，不能沿用旧工作树里的脚本。
