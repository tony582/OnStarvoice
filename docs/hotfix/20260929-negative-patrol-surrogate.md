# 负面巡查截断切开 emoji 致 jsonb 写入失败 hotfix（2026-09-29）

分支 `codex/hotfix-negative-patrol-surrogate-20260929`，叠在 `codex/hotfix-ai-label-surrogate-20260929`（`11c8ddc`）之上，复用它新增的 `server/utils/well-formed-text.js`。没有迁移、配置、扩展或 Admin 改动。已随 `codex/release-hotfixes-20260929`（`bb53e44`）于 2026-09-30 09:45:50 上线，发布记录见 `docs/hotfix/20260929-release-hotfixes.md`。

## 问题

两条巡查路径把帖子正文按 UTF-16 code unit 截到 1000，再作为 `jsonb` 写进巡查条目的 `metadata`。正文第 999/1000 个 code unit 正好是一个 emoji 时，截断留下半个 emoji（孤立代理项），`JSON.stringify` 写成 `\udXXX`，PostgreSQL 拒绝整个文档（`22P02`，DETAIL `Unicode low surrogate must follow a high surrogate`）。

| 路径 | 截断位置 | 写入 | 失败后果 |
| --- | --- | --- | --- |
| 手动下发 `POST /negative-patrol/tasks` | `routes/negative-patrol.js` 本地 `text()`（`sourceRecord.content`，原 :1401） | `jsonb_to_recordset($3::jsonb)` 整批 INSERT | 请求 500，同批其他帖子也不入队 |
| 无人值守计划（定时物化、run-now） | `unattended-negative-patrol.js` `publicCandidate`（原 :280） | `capture-orchestration-scheduler.js` `$10::jsonb` | 物化事务失败；定时路径由调度器把**整个无人值守计划自动暂停**（`last_run_status=scheduler_error`，模板任务 `needs_action`，关键词采集一起停）；run-now 返回 500 |

对同一条帖子是确定性的：只要它还在 7 天首次入库窗口内，恢复计划后下一轮会再次失败。

本机 PostgreSQL 17 实测：JSON 文本参数、对象参数、`jsonb_to_recordset` 都报 `22P02`；`$n::text`、`text[]`、`jsonb_build_object('k', $n::text)`、`to_jsonb($n::text)` 不报错，孤立代理项静默变成 U+FFFD。所以只有 `jsonb` 写入受影响。

## 修复

| 文件 | 改动 |
| --- | --- |
| `server/services/unattended-negative-patrol.js` | `content: truncateWellFormed(text(row.content), 1000)` |
| `server/routes/negative-patrol.js` | 本地 `text(value, limit)` 超长时改用 `truncateWellFormed`。同文件其余经它进 `jsonb` 的截断（标题 240、筛选词、节点名 160 等）一并修好 |

`truncateWellFormed` 在切点落在字符中间时整字丢弃。不含代理项的文本，截断结果与原来逐字节一致。

## 验证

| 项目 | 结果 |
| --- | --- |
| 新增 `tests/integration/postgres/negative-patrol-well-formed.integration.mjs`，未修改代码上运行 | 手动下发、run-now 各返回 500 `invalid input syntax for type json`；对照组（emoji 完整落在限内）通过，说明失败只来自截断 |
| 修复后 | 4/4 通过 |
| 相关 PostgreSQL 集成（`unattended-negative-patrol`、`negative-patrol-candidates`、`negative-patrol-fairness`、`negative-patrol-result-replay` 与新测试） | 69/69 |
| 相关单元（`well-formed-text`、`server-negative-patrol-route`、`watched-content-patrol`、`negative-patrol-multi-agent`、`unattended-negative-patrol`、`server-negative-patrol-analytics`、`negative-patrol-result-replay`） | 76/76 |

合并后的全量结果见发布记录 `docs/hotfix/20260929-release-hotfixes.md`。

## 同类问题审计（未处理，供后续 hotfix）

`server/` 里共 360 处 `slice/substring/substr`。两轮只读审计把每处截断追到实际写入点；能到 `jsonb` 的每一处由独立的第二个审计者尝试推翻；判为"不到 `jsonb`"的 52 处又做了一轮反向复核（只推翻 1 处：`ai-failover.js` 的模型名截断，来源是运维配置，实际风险为零）。

建议处理（按影响排序）：

1. **入口**：`server/app.js` 的 `express.json` 没有 reviver。加 `reviver: (_k, v) => typeof v === 'string' ? toWellFormed(v) : v` 一处覆盖所有请求体（body-parser 1.20.6 支持，已用探针验证合法 emoji 不受影响）。主要受益方是 `routes/sync.js` 的 `JSON.stringify(item)`（写 `records.payload`、`record_observations.payload`、`record_versions`，失败时整条入库事务回滚）：扩展自己会切出半个 emoji（`utils/capture-sync.js` 评论正文截 280 后拼 `...`，`textSnippet` 截 100，`titleSnippet`/`authorSnippet` 截 80）。服务端修，不需要节点重载扩展。
2. `services/capture-stop-fence.js` 的 `text()`：`pendingTabs[].title` 截 40（扩展也先截了 40），写入 `metadata.stopFenceCheck` 失败会让停稳回执 500 并整笔回滚，扩展重投同一内容，失败轮次的标签页证据丢失。已用 psql 复现。
3. `services/capture-cloud.js` 的 `text()` → `safeStructuredValue`（字符串截 2000、键截 80，36 个调用者）和 `routes/capture-cloud.js` 的 `text()`：失败回滚整个心跳事务。其中 `routes/capture-cloud.js` 派发巡查时 `text(sourceRecord.title, 1000)`：标题超过 1000 且 emoji 压在边界时，该节点每次心跳都失败。
4. `opinion-analysis.js` 的 `compact`/`cleanText`，`report-generator.js` 的 `compactText`、`buildInsightSamplePool`（标题截 80/160）、`collectTermsFromText`：剖析在两次付费模型调用后仍失败，报告写入失败。
5. `hit-analyzer.js` 的 `clean` 与兜底文案截断（点"分析"直接 500）、`relevance-prefilter.js` 的 `boundedText`（最多 40 条的整批事务回滚）、`comment-sales-judgment.js` 的 `text()`（整条记录的评论批次回滚并卡在队头）。
6. `customer-assistant-agent.js` 的 `plainText`、`customer-assistant-tools.js` 的 `clean`（低频）。

可达 `jsonb` 但文本短、受控或只影响单个请求，可以放后：`keyword-strategy` 的 `cleanText`（后台尽力写入）、`capture-attention-notifier`、`capture-stop-fence-release`、调度与编排的 `text()`、`ops-control`、`social-account-usage`、`profile-patrol-dispatch`、`capture-discovery/detail-projection`、`capture-local-closure-proof`、`official-comment-patrol`、`feedback.js` 复核备注、`admin.js` 中转节点名、`comment-workflow.js` 失败分支。

不需要修：只写 `text` 列或只进 HTTP 响应的截断。

不是截断造成、同样会失败的来源：模型回复本身带孤立代理项（主要写入点 `comment-workflow.js` 的 `ai_result`、`report-generator.js` 的报告快照），靠第 1 条的 reviver 或写入时用 `stringifyJsonWellFormed` 兜底。U+0000 会同时让 `jsonb`（22P05）和 `text` 参数（22021）失败，是另一类问题。
