# AI 前置筛选截断切开 emoji 致整批判断丢失 hotfix（2026-10-03）

分支 `codex/hotfix-prefilter-surrogate-20261003`，基线 `main`（`8fd8d74`；生产服务端 = `12d09bc`，10-03 12:28 手机卡片预筛上线，`8fd8d74` 只多一份记录）。最初基于 `5b7081b` 写成，卡片预筛上线后变基到 `8fd8d74`，没有冲突（卡片预筛没改 `relevance-prefilter.js`）。复用 `server/utils/well-formed-text.js`（09-29 AI 标注 hotfix 引入，已在生产）。没有迁移、配置、扩展、Runner 或 Admin 改动。**已于 2026-10-03 13:25:30 上线**（见文末「部署」）。

## 问题

`server/services/relevance-prefilter.js` 用 `boundedText`（`String(value).trim().slice(0, max)`）截模型输出：`reason` 截 1000，`evidence`、`missingSignals` 每条截 120；模型调用失败时把错误消息截 300 拼进兜底理由。切点落在 emoji 两半之间时留下孤立代理项，`persistPrefilterOutcome` 用 `JSON.stringify` 写 `jsonb` 参数，Node 写出 `\ud83d` 转义，PostgreSQL 拒绝（`22P02`，DETAIL `Unicode low surrogate must follow a high surrogate`）。

| 写入点 | 参数 |
| --- | --- |
| `relevance_prefilter_decisions.evidence` / `missing_signals` / `metadata` | `$29::jsonb` / `$30::jsonb` / `$35::jsonb` |
| `relevance_prefilter_cache.response_item` | `$12::jsonb` |
| `relevance_prefilter_requests.response_body` | `$5::jsonb` |

整个结果事务回滚 → `markPrefilterRequestFailed` → 浏览器路由 `POST /api/relevance/prefilter` 和手机卡片预筛路由 `POST /api/capture-cloud/android/agent/prefilter`（`android-control/prefilter.js` 调同一个 `prefilterRelevanceBatch`，日志 `[AndroidPrefilter] Unexpected failure`）都回 503 `PREFILTER_UNAVAILABLE`。扩展和手机都按 `failOpen` 继续采集/打开卡片（不会误跳过），但这一批（浏览器最多 40 条、手机最多 8 张卡片）的判断记录和缓存全部丢失，下次同样内容还要再付费调用一次模型。`reason` 列是 `text`，不会报错，只会静默变成 U+FFFD。

另一个同样落到 `$5` 的来源：请求里客户端自带的 `intent.targetEntity` 等数组按 80/100 截断后原样回显到 `response_body`。目前扩展和 Runner 都不发 `intent`，但接口接受。

## 修复

| 位置 | 改动 |
| --- | --- |
| `persistPrefilterOutcome` 五个 `jsonb` 参数 | `JSON.stringify` → `stringifyJsonWellFormed`（干净输入走原生路径、结果逐字节一致；只有带孤立代理项时才把它换成 U+FFFD） |
| 新增 `boundedModelText` | `truncateWellFormed`：切点在字符中间时整字丢弃。用于模型的 `reason`、`evidence`、`missingSignals`，兜底理由，以及两处错误消息截断 |
| `boundedText` | **不变**。请求字段（标题、作者、关键词、intent 等）参与 `contentSummaryHash`、`prefilterCacheKey` 和幂等 `request_body_hash`，改截法会让已有缓存失效、重试变成 `IDEMPOTENCY_CONFLICT`。这些字段里的半个字符由写入时的 `stringifyJsonWellFormed` 兜底（或在 `text` 列里变 U+FFFD） |

判定逻辑不变：`reason` 只参与"是否为空"的检查，截到 1000 时最少还剩 999 个 code unit；`decision`、`tenantRelevance`、分数、`itemId` 匹配都没动。

## 验证

| 项目 | 结果 |
| --- | --- |
| 新增 `tests/integration/postgres/relevance-prefilter-well-formed.integration.mjs`，**未修改代码上运行** | 对照组通过；理由/证据切在 emoji 中间、模型自带孤立代理项、客户端 intent 截断、上游错误消息截断四项均报 `22P02 invalid input syntax for type json`（`$29` 与 `$5`），与线上路径一致 |
| 修复后 | 5/5（Node 18.20.8、24.12.0） |
| `tests/server-relevance-prefilter.test.mjs` 新增 3 项（模型文本整字截断且判定不变；请求字段截法不变；五个 `jsonb` 参数都走 `stringifyJsonWellFormed`），未修改代码上 2 项失败 | 修复后 23/23 |
| 全量单元 `run-node-regression-tests.mjs` | 变基前（`5b7081b` 上）Node 18.20.8 / 24.12.0 各 3243/3243；变基后（`8fd8d74` 上）各 3254/3254 |
| 全量 PostgreSQL 集成 `run-postgres-integration-tests.mjs`（全新库，PostgreSQL 17，Node 18.20.8） | 变基前 502/502（58 个文件）；变基后 508/508（59 个文件，含卡片预筛的 `android-card-prefilter.integration.mjs`） |

| 服务端发布脚本在模拟生产目录（`12d09bc` 的 `server/`，真实 Node 18 进程）上演练 5 种情形 | 只读预检通过；依赖模块被改、被替换文件被改都拒绝且不改任何东西；新进程起不来时恢复原文件、服务恢复就绪；正常部署后两个预筛路由和相邻路由对未带令牌请求的应答与部署前一致（401），同一发布目录第二次运行被拒 |

发布包与演练脚本：`~/Documents/claude/releases/OnStarvoice-prefilter-surrogate-server-20261003/`。只替换 `server/services/relevance-prefilter.js`；预检核对它和 8 个相关模块（`db/init.js`、`routes/android-control.js`、`routes/relevance-prefilter.js`、`ai-labeler.js`、`android-control/prefilter.js`、`android-control/service.js`、`monitoring-intent.js`、`utils/well-formed-text.js`）与 `12d09bc` 一致。回退：恢复发布目录 `backup/` 里的这一个文件并重启。没有数据需要回退。

## 线上排查（只读，需要点名主机）

- PM2 错误日志里搜 `invalid input syntax for type json`，前缀是 `[RelevancePrefilter] Unexpected backend failure:`（浏览器）或 `[AndroidPrefilter] Unexpected failure:`（手机）。
- 失败请求按天计数（其中也包含其它原因的失败）：

```sql
SELECT date_trunc('day', updated_at) AS day, count(*)
FROM relevance_prefilter_requests
WHERE status = 'failed'
GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

丢失的判断不需要回填：客户端当时已按 `failOpen` 完整采集，下次遇到同一内容会重新判断并写入缓存。

## 部署（2026-10-03，用户本会话已点名主机 47.103.125.200）

| 时间 | 步骤 | 结果 |
| --- | --- | --- |
| 13:24:40 | 只读核对生产 | PID 648108（12:28 起，重启 37 次，Node 18.20.8）；12:29 之后没有服务端文件被改过，12:28 之后改动的只有卡片预筛那次发布的文件；`relevance-prefilter.js` 与 `12d09bc` 一致（`9bbdca93…`）；进行中的采集任务 0（待执行 22）；前置筛选最近一次请求 05:20；近 7 天失败请求 2 条；PM2 错误日志里两个预筛路由的 `invalid input syntax for type json` 0 条（1,207 条是 09-29 已修的 AI 标注，2 条是 `[Cron] Report scheduler error`，另一个路径，未处理） |
| 13:25:2x | 上传发布目录 `/opt/onstarvoice-private/releases/prefilter-surrogate-5fc6131-20261003`，`SHA256SUMS` 核对，`bash deploy.sh --check` | 三个文件 OK；预检通过（1 个替换文件、8 个相关模块与 `12d09bc` 一致，服务就绪） |
| 13:25:28 | `bash deploy.sh` | 退出码 0；替换 `services/relevance-prefilter.js`（`1dc36e2d…`）；新进程 PID 650010（重启 38 次），13:25:30 起、就绪；浏览器预筛、手机预筛、手机领取、云端概览四个路由对未带令牌请求的应答与部署前一致（401）；扩展更新清单未变 |
| 13:26:33 | 部署后核对 | 部署前一小时内活跃的 18 个节点全部在重启后有心跳；进程未再重启；错误日志尾部只有重启后的数据库繁忙类老问题（`DB_CAPACITY_UNAVAILABLE`），没有预筛、模块加载或语法错误 |

生产服务端 = `5fc6131` 的内容；`main` 快进到 `5fc6131` 之后的记录提交，下个 hotfix 以 `main` 为基线。
