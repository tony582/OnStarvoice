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
| 本地预览（API 接 3 万条内容的合成库 + vite，一次性测试账号） | 表头情感→负面、处理状态→待处理、风险信号→有负评、疑似身份→4S店、意图→投诉/抱怨、相关性→相关逐个点开：列表请求依次带上 `sentiment/status/risk/identity/intent/relevance`，筛选行同名芯片同步变成激活态、表头触发器变主色并带数量，「清空筛选」一次全部复位；点「导出」对该租户（5,000 行）返回 200 |

## 发布

服务端有迁移和路由改动，后台有静态改动：走 `deploy/deploy.sh`（rsync server + 构建并 rsync admin dist + `node db/migrate.js` + PM2 重启）。回退：代码回到 `4581e2e` 重发；两个索引留着无害（也可 `DROP INDEX`）。
