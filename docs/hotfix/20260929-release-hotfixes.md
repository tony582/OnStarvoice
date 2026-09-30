# 标注与负面巡查 emoji 截断修复合并发布（2026-09-30）

发布分支：`codex/release-hotfixes-20260929`，合并提交 `bb53e44`，基线 `acbe77f`（发布分支头 `d275b6f` 只多文档）。**生产当前运行的是 `bb53e44` 的 Server 代码，下一个 hotfix 以本分支为基线。**

合并了：

- `codex/hotfix-ai-label-surrogate-20260929`（`fb70c5b`，记录 `11c8ddc`）：标注写入不再切出半个 emoji；同一条记录反复失败时有界重试（3 次后停放）。设计见 `docs/hotfix/20260929-ai-label-surrogate.md`。
- `codex/hotfix-negative-patrol-surrogate-20260929`（`3eafde8`，记录 `5341ad2`）：负面巡查条目元数据不再切出半个 emoji。设计与同类问题审计见 `docs/hotfix/20260929-negative-patrol-surrogate.md`。
- `codex/hotfix-single-triage-review-20260929`（`1a988c0`）：`manual_overrides.triage_review.value = 'requested'` 的"信息不足"帖进入内容分诊。**这个文件 Codex 已于 2026-09-29 22:56 单独上线**（生产目录 `single-triage-review-1a988c0-20260929`，只替换 `record-triage-admission.js`，目标记录 `c70a2c2e` 已打标记）。合并进来是为了让发布分支与生产一致；本次发布包只核对它，不替换。

没有合并：`codex/hotfix-daily-triage-scope-20260929`（`0fdd69e`，日报取数口径统一），用户已决定推迟到下个月。

范围：Server 7 个文件（5 个替换、2 个新增），另核对 1 个已上线文件。没有数据库迁移，不改 Admin，不改扩展（节点不用重载），不改手机 Runner。

## 发布前核对

| 项目 | 结果 |
| --- | --- |
| 发布分支 CI（运行 36591505682） | 五项全部通过：`Tests and builds`、`Production Node 18 compatibility`、`PostgreSQL 14 / Node 24.12.0`、`PostgreSQL 16 / Node 24.12.0`、`PostgreSQL 16 / Node 18.20.8` |
| 合并后的树，Node 全量回归（Node 18.20.8，含 Admin 依赖与扩展快照） | 3,225 / 3,225 |
| 合并后的树，PostgreSQL 全量集成（本机 PostgreSQL 17，全新库） | 495 / 495（64 个文件） |
| 本机演练（模拟生产目录 = `acbe77f` + `1a988c0` 的分诊文件） | 预检通过；核对文件漂移、已上线文件被改回旧版、新模块已存在时都拒绝且不改任何东西；启动失败时自动恢复 5 个文件、删除新模块并重启成功；正常部署成功，同一目录再次执行被拒绝 |

发布包（`~/Documents/claude/releases/OnStarvoice-release-hotfixes-bb53e44-20260929/`，含生成器与演练脚本）：`server.tar.gz` `56dca6c2…`、`deploy.sh` `7f4f135f…`、`release-manifest.json` `8aaad127…`。

## 过程（Asia/Shanghai）

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 09-29 23:36 | 推送发布分支 | CI 五项通过 |
| 09-30 09:41 | 只读预检（用户在确认框中选择"部署到 47.103.125.200"） | 服务在线（PID 563332，重启 33 次）；发现 09-29 22:55:59 那次重启来自 Codex 的单条分诊发布，生产上 14:10 之后只有 `record-triage-admission.js` 被改过，内容与本分支一致 |
| 09:50 前 | 按生产现状重新出包与演练 | 该文件改为"已上线，按发布内容核对"，其余不变 |
| 09:45:34 | 部署前基线 | 进行中的采集任务 0，30 分钟内到期计划 0；PM2 错误日志 337,231 行（`Label error` 1,679 行、`invalid input syntax for type json` 1,209 行）；PostgreSQL 日志中该错误 490 条 |
| 09:45 | 上传，`sha256sum -c`，`bash deploy.sh --check` | 5 个待替换文件与 39 个核对文件是 `acbe77f` 的内容，已上线文件是发布内容，2 个新模块不存在，服务就绪 |
| 09:45:50 | `bash deploy.sh` | 退出码 0；新进程 PID 574642（重启 34 次），Node 18.20.8，角色 all，就绪；磁盘文件与本包一致；相关路由应答与部署前一致；扩展更新清单逐字节未变 |
| 09:46:12 | 部署后 22 秒 | PM2 错误日志、PostgreSQL 日志均无新增错误；17 个节点中 12 个已重连 |

生产发布目录：`/opt/onstarvoice-private/releases/release-hotfixes-bb53e44-20260929`（含 `backup/`、部署前后的健康与 PM2 状态、`pre-deploy-baseline.txt`）。

注：PostgreSQL 日志 09:46:32 有一条 `postgres@onstarvoice` 的 `invalid input syntax for type json`，来自我自己的只读核对语句写错（`COALESCE(jsonb, '-')`），不是应用产生的。

## 上线后核对（只读）

| 时间 | 项目 | 结果 |
| --- | --- | --- |
| 09:50:10 | 事故记录 `a52c85cb-abe9-41a5-850b-a933e4922e9d`（09-20 起反复 `22P02`，PM2 日志 1,679 行 `Label error`） | 部署后第一个标注批次即标注成功（`relevance = relevant`），没有 `labelFailure` 标记 |
| 09:50:38 | PM2 错误日志 | 部署后 0 行新增，没有 `Label error` / `Label parked` |
| 09:50:38 | PostgreSQL 日志 | 应用侧没有新的 ERROR（唯一一条是上面说明的我自己的查询） |
| 09:50:38 | 停放 / 失败标记 | 0 / 0 |
| 09:50:38 | PM2 | 在线，PID 574642，重启次数仍为 34 |
| 09:51:03 | 节点 | 部署前仍在联系的节点全部已重连（12 个，含手机 DE106）。另有 6 个 `Edge · macOS~` 节点（雪人、仙人掌、计算器、西瓜、太空人、霸王龙）最后联系在 09:42:15–09:42:22，早于部署开始 3 分半钟，与本次发布无关 |

## 回退

恢复 `backup/` 里的 5 个文件、删除 `server/services/ai-label-failure.js` 与 `server/utils/well-formed-text.js`、重启。没有数据需要回退：旧代码不认 `ai_result.labelFailure`，留着无害，下次标注成功会被覆盖。`record-triage-admission.js` 不属于本包，回退它见 Codex 的发布目录。

## 没有包含 / 后续

- 同类 `jsonb` 截断问题的修复优先级见 `docs/hotfix/20260929-negative-patrol-surrogate.md` 的"同类问题审计"。其中 `routes/capture-cloud.js` 派发巡查时的 `text(sourceRecord.title, 1000)`、`server/app.js` 请求体 reviver 两项等用户决定。
- 日报口径统一（`0fdd69e`）推迟到下个月。
