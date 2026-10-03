# 定时报告截断切开 emoji 致当天报告丢失 hotfix（2026-10-03）

分支 `codex/hotfix-report-surrogate-20261003`，基线 `main`（`dd2b027`，生产服务端 = `5fc6131`）。复用 `server/utils/well-formed-text.js`。没有迁移、配置、扩展、Runner 或 Admin 改动。**未部署。**

## 现象与取证（生产只读）

- PM2 错误日志里 2 条 `[Cron] Report scheduler error: invalid input syntax for type json`。
- PostgreSQL 日志对应两条：`2026-09-12 09:00:33` 与 `2026-09-13 09:00:36`，CONTEXT 都是 `…觉还好，副驾妹妹着实吓一跳\ud83e…`。半个 emoji 后面紧跟 `…`，正是报告 `compactText` 的形态（`text.slice(0, max - 1) + '…'`）。
- 安吉星日报恰好缺 `09-11`、`09-12` 两期：那两天 09:00 的报告整笔写入失败，当天报告没有生成，之后也不会补。
- 09-27 至 09-30 PostgreSQL 日志里 1,207 条同类错误都是 AI 标注那条记录（`…谁看谁心动\ud83e"`），09-30 已修，与报告无关。

## 根因

报告把仪表盘和邮件 HTML 连同统计一起写进 `report_runs.metadata`（`$8::jsonb`），统计另写 `report_snapshots.data`（`$3::jsonb`），都用 `JSON.stringify`。HTML 里的样本标题、摘要由 `compactText` 按 UTF-16 code unit 截断：仪表盘标题 74、42，摘要 132；邮件标题 76，摘要 160（本地探针实测，见测试）。切点落在 emoji 中间就留下孤立代理项，jsonb 拒绝整笔写入（`22P02`），当天报告丢失。

同一写入里还有两处会切出半个字符：

| 位置 | 截断 | 写到哪里 |
| --- | --- | --- |
| `collectTermsFromText` 话题标签 `#[^…]{2,24}` | 非 unicode 正则按 code unit 数 24 个，长标签可能停在 emoji 前半 | `stats.hotTerms` → `metadata` 和 `report_snapshots` |
| `buildInsightSamplePool` 标题 80、摘要 160 | `slice` | 报告研判提示词；舆情剖析与报告共用此池 |

## 修复（只改 `server/services/report-generator.js`）

| 位置 | 改动 |
| --- | --- |
| `compactText` | `truncateWellFormed(text, max - 1)` + `…`：切点在字符中间时整字丢弃 |
| 话题标签 | 匹配结果末尾是半个 emoji 时去掉那半个（不改正则，标签识别范围不变） |
| `buildInsightSamplePool` | 标题、摘要改 `truncateWellFormed` |
| 三个 `jsonb` 参数（`report_runs.metadata`、`report_snapshots.data`、重发审计日志） | `stringifyJsonWellFormed`，兜住模型研判文本等其它来源 |

不含代理项的文本，截断结果与原来逐字一致。

## 验证

| 项目 | 结果 |
| --- | --- |
| 新增 `tests/integration/postgres/report-well-formed.integration.mjs`，**未修改代码上运行** | 对照组通过；标题/摘要切在 emoji 中间报 `22P02`，CONTEXT `…题题题\ud83e…`（`$8`），与生产形态一致；话题标签一项同样报 `22P02` |
| 修复后 | 3/3（Node 18.20.8、24.12.0）；HTML 里切点处整字丢弃，`html` 文本列也没有 U+FFFD |
| 新增 `tests/report-generator-well-formed.test.mjs`（样本池整字截断、三个 `jsonb` 参数都走 `stringifyJsonWellFormed`、`compactText` 用整字截断），未修改代码上 2/2 失败 | 修复后 2/2 |
| 全量单元 `run-node-regression-tests.mjs` | Node 18.20.8：3256/3256；Node 24.12.0：3256/3256 |
| 全量 PostgreSQL 集成 `run-postgres-integration-tests.mjs`（全新库，PostgreSQL 17，Node 18.20.8，60 个文件） | 512/512 |

## 顺带发现（未处理，等用户决定）

查报告时发现的定时报告问题，比这次的 json 错误影响大得多，都没改：

1. **一个租户的邮件发不出去，就会挡住后面所有报告。** `runConfiguredReports` 按租户顺序依次生成日报、周报、月报；`generateReport` 发邮件失败（"报告收件人未配置"、"SMTP 未配置"）会抛出，整个循环中断。生产上安吉星没配收件人，每天 09:00 日报在它这里中断，结果：安吉星**从来没有生成过周报和月报**；东方航空、吉事桔香茶、鸿冠信息**从来没有生成过任何报告**（`report_runs` 里一条都没有）。安吉星 87 期日报全部是 `failed`（内容已生成、邮件没发）。
2. **09:00 那一分钟数据库忙，当天报告就跳过。** 调度每分钟查一遍所有租户的 15 个设置，只在时刻正好等于配置时间的那一分钟生成；那一分钟失败（日志里 230 次"数据库繁忙"、23 次连接超时）就不再补。
3. 舆情剖析 `opinion-analysis.js` 自己的 `compact`/`cleanText` 截断也会写进 jsonb，同类问题，属于另一个功能。

第 1 条修好后，三个从没收到过报告的租户会在 09:00 开始生成报告、并按各自 SMTP/收件人配置发邮件，属于对外行为变化，需要先确认。
