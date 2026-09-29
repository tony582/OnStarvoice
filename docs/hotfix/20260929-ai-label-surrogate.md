# AI 标注反复失败：孤立代理项与有界重试 hotfix（2026-09-29）

分支：`codex/hotfix-ai-label-surrogate-20260929`，基线 `d275b6f`（生产当前运行的是 `acbe77f` 的代码，`d275b6f` 只多一份发布记录）。**未提交、未推送、未部署。** 没有数据库迁移，没有新配置项。

## 现象

生产日志（只读取证，与 09-29 的发布无关，09-27 已在发生）：

- PM2 错误日志 `/root/.pm2/logs/onstarvoice-error.log` 有 1,562 行 `[AI] Label error for record <uuid>: invalid input syntax for type json`：同一条记录 `a52c85cb-abe9-41a5-850b-a933e4922e9d` 1,097 次，另有四条记录各 7 次。
- PostgreSQL 日志（09-20 至 09-29）有 1,090 条 `ERROR: invalid input syntax for type json`，`DETAIL: Unicode low surrogate must follow a high surrogate`，`CONTEXT` 形如 `...谁看谁心动\ud83e"`：写入的 JSON 里有一个字符串以半个 emoji 结尾。

## 根因

### 1. 半个 emoji 是怎么产生的

`String#slice` 按 UTF-16 code unit 截断。切点正好落在 emoji 的两半之间，就留下孤立代理项；`JSON.stringify` 把它写成 `\udXXX` 转义，PostgreSQL 的 `jsonb` 拒绝整个文档（SQLSTATE `22P02`），`records.ai_result` 的 UPDATE 整体回滚。文本列不受影响（node-pg 按 UTF-8 编码，孤立代理项静默变成 U+FFFD），只有 `jsonb` 会失败。

标注写入路径上找到的来源（本地在未修改的生产代码上全部复现，报错与生产一致：`22P02`、同样的 DETAIL、JSON 上下文以 `\ud83d"` 结尾）：

| 来源 | 位置 | 触发条件 |
| --- | --- | --- |
| 证据引文窗口 | `record-content-judgment.js` `findMainPostGmEvidence`：`slice(entityStart-25, entityEnd+60)` | 窗口边界落在 emoji 中间。**仅哨兵范围的记录**（`monitoringEvidence` 只对这类记录入库）。窗口是记录文本的纯函数，所以对同一条记录每次都失败，这就是 1,097 次的原因 |
| 实体本身 | 同文件 `sourceOffset` | NFKC 会把部分非 BMP 字母折成一个 BMP 字母（数学粗体/斜体/花体、方框拉丁字母，如 `𝓑𝓾𝓲𝓬𝓴`），归一化偏移落在原文一对代理项中间。即使引文完整，实体也会带孤立代理项，只修引文会漏掉这一路 |
| 模型引用 | 同文件 `findRecordMonitoringEvidence` | 模型引用停在半个 emoji 上，`includes()` 按 UTF-16 比较仍然通过，原样入库 |
| 理由与主题 | `ai-labeler.js` `normalizeRecordClassificationResult`：`slice(0,500)`、`slice(0,100)` | 模型输出较长且切点在 emoji 中间 |
| 监控意图 ID | `monitoring-intent.js` `boundedText`：`slice(0,200)` | 租户关键词第 200 个 code unit 落在 emoji 中间，会让该租户下**所有**记录写入失败 |
| 模型自己 | `...result` 原样展开进 `ai_result` | 模型回复里的 `\ud83e` 转义。任何截断函数都拦不住 |

### 2. 为什么会重复上千次

`labelRecord` 先调用付费模型，再写入。写入失败时事务回滚，什么都不留，返回 `null`。批处理 `labelPendingRecords`（cron `batch-ai-labeling`，每 10 分钟，`LIMIT 20`，`ORDER BY created_at DESC`）按 `ai_labeled_at IS NULL OR ai_result->>'relevance' IS NULL` 选记录，所以同一条记录每次都被再选一遍。1,097 ≈ 9 天 × 144 次 × 85%。

## 每次重试是否重复付费调用

**是。** 每次重试一次付费请求，没有任何缓存。按代码估算每次约 5.5k–14k 输入 token（系统提示词哨兵范围 12,080 字符，其他约 8.4k 字符；正文最多 8,000、逐字稿最多 6,000 个 code point），1,097 次约 6–15M 输入 token。**没有逐次用量记录**，实际金额请以模型服务商账单核对。另外每次失败还会：多写一次 `ai_failover_states` 的"成功"（浪费的调用被记为模型成功）、约 20 条数据库语句、一行 PostgreSQL ERROR 日志。

## 修复

| 文件 | 改动 |
| --- | --- |
| `server/utils/well-formed-text.js`（新） | 共享工具：`isWellFormed`、`toWellFormed`、`splitsSurrogatePair`、`sliceWellFormed`、`truncateWellFormed`、`stringifyJsonWellFormed`。截断落在字符中间时**整字丢弃**（引文仍是原文的子串），输入里原有的孤立代理项换成 U+FFFD，限制仍按 UTF-16 code unit 计。干净输入走原生 `JSON.stringify`，行为、速度和可序列化的嵌套深度与原来一致 |
| `record-content-judgment.js` | `sourceOffset` 不再返回一对代理项中间的下标；实体与引文窗口用 `sliceWellFormed`；模型引用的 quote/entity 带孤立代理项时丢弃 |
| `ai-labeler.js` | 理由/主题限长用 `truncateWellFormed`；`ai_result` 序列化用 `stringifyJsonWellFormed`（最后一道防线，覆盖模型回复）；`sanitizePromptText` 改为调用同一实现；有界重试接入 `labelRecord` / `labelPendingRecords` |
| `monitoring-intent.js` | `boundedText` 用 `truncateWellFormed` |
| `ai-label-failure.js`（新） | 有界重试：错误分类、标记的读写、批次筛选 SQL |

## 有界重试规则（已获用户确认）

**计入**：会在同一条记录上重复出现的失败：PG 数据错误（SQLSTATE 22/23/54，含本次的 22P02、NUL、非数字 confidence）、模型回复不可用（无法解析、空结果、200 但不是 JSON）、提供商拒绝这条输入（HTTP 400/413/422）、JS 错误、没预料到的错误。
**不计入，与以前一样无限重试**（自己会好，或不是这条记录的错）：数据库忙/连接/锁/语句超时，提供商 429/5xx/超时/网络，AI 准入队列，中转离线，租户配置（401/402/403/404、端点无效、TLS、API key 含非法字符），结构或代码故障（42xxx、08P01…），没配置 API key，写入时输入已被改动。

| 项目 | 规则 |
| --- | --- |
| 预算 | 3 次计入的失败。第 1 次失败后等下一个批次（约 5 分钟），第 2 次失败后等 1 小时，第 3 次失败后**停放**。每条记录最多 3 次付费调用（此前 9 天 1,097 次） |
| 停放 | 批处理不再选它；记录保持未标注（显示"未判断"，不编造结果）；打一行日志 |
| 状态 | `records.ai_result.labelFailure`：`rules`、`attempts`、`parked`、`reason`、`code`、`lastAt`、`lastAtEpoch`、`nextAtEpoch`。只存错误码，不存错误消息（消息可能带请求文本或含 API key 的 URL）。不改 `updated_at`。标注成功会整体覆盖 `ai_result`，标记随之消失。`ai_result` 不是 JSON 对象（字符串、数组、JSON null）且没有标注结果的旧数据，标记会替换它，否则这类记录永远无法计数 |
| 自动复活（无需人工） | ① 强制重判（`labelRecord(id,{force:true})`，同步链路在重采后文本变化时使用）无视停放并**重新开始一份预算**；② 提高 `LABEL_FAILURE_RULES_VERSION`（以后动标注写入路径的 hotfix 顺手提一下），所有停放记录重新获得一份预算 |

`labelPendingRecords` 同时改为：每条记录单独 try/catch（此前 `labelRecord` 在 try 之前读库，数据库忙时抛出会让本批次剩下的记录全部被跳过），连续 3 次抛错则停止本批次（保留原来"数据库不应答时尽快停手"的效果）；第二个参数 `{label, pauseMs}` 供测试注入。空模型结果（`null/0/false/""`）以前静默返回并每批次重复付费，现在计入并写日志。

### 已知限制：系统性故障会把整个积压一起停放

规则假定失败只属于这条记录。如果提供商或配置故障让**所有**记录都以"计入"的方式失败超过约 1 小时（例如租户模型名写错，提供商对每条都回 400；或换了一个把 `confidence` 答成 `"high"` 的模型），整个积压会被停放，故障修好后它们**不会自己重试**，需要按下面的办法复活。

我曾额外加了一个"健康探测"（租户在这条记录上次失败之后有别的记录标注成功才停放）来缓解，评审用真实运行证明它只是把整批停放推迟到第 24 次（约 22 小时后），且让安静租户里的一条毒记录付费 24 次而不是 3 次，已经**去掉**，规则回到用户确认的原样。

后续可选（未做，需要确认）：把"租户的 `llm_*` 设置在这条记录上次失败之后被改动过"作为第三个复活条件（`tenant_settings.updated_at`），覆盖最常见的系统性原因（改模型名、换 key）而不需要人工；并在 `ops-control` 里单独统计停放数。

## 验证

（运行数字见文末"最终运行"）

| 验证 | 结果 |
| --- | --- |
| 未修改的生产代码复现 | 同样的 `22P02`、DETAIL 和 `\ud83d"` 上下文 |
| 新增测试在未修改代码上必须失败 | 记录内容判断 4+1 项、标注文本 2 项、集成 7 项全部失败；行为保持项在两边都通过 |
| 干净输入行为不变 | 旧代码与新代码在约 550 万次比较（全部测试夹具、别名词表、随机中英文文本）上输出逐字节一致，含键顺序 |
| 辅助函数对照 Node 24 原生 `toWellFormed` | 354,623 个字符串 0 处不一致；`slice/truncate` 237 万种 (起点, 终点, 限制) 组合按独立规约核对；`stringifyJsonWellFormed` 对 6 万个随机合法文档与 `JSON.stringify` 逐字节一致 |
| 真实写入路径随机压测（PostgreSQL 17.9） | 10 万个 `persistRecordClassification` 用例：旧代码 81,901 次 `22P02 … type json` 失败，新代码 0 次；剩余失败只有 NUL（22P05/22021）与非数字 confidence（22P02 `for type real`/22003），与本修复无关 |
| 重试循环端到端（桩模型，2.4 万条记录） | 旧代码留下 20,305 条未标注，第二轮又付费 20,305 次；新代码留下 1,311 条（同样只有 NUL 与非数字 confidence），第二轮付费恰好 1,311 次，已标注的没有再送模型 |
| 同一条毒记录连续 12 个批次的累计付费调用 | 旧代码 1,2,3,…,12；新代码 1,2,3,3,3,…,3 |
| 变异检查 | 故意破坏实现再跑测试：辅助函数与证据引文部分十余个变异全部被测试发现（过程中发现并补上了两处过弱的测试）；重试规则 32 个变异全部被测试发现 |
| 独立评审 | 两轮共 6 个只读评审：辅助函数差分测试、行为保持审计、写入路径随机压测（第一轮，均"可发"）；SQL 与数据安全、端到端运行（第二轮）、规则合理性（第二轮重跑）。评审发现的问题和处置见下 |

评审发现并已处理：

- 带 replacer 的序列化让可序列化的数组嵌套深度从约 5,270 降到约 2,190：改为干净输入走原生路径。
- 模型引用只有 entity 带孤立代理项时缺少测试；意图 ID 的集成断言过弱：已补。
- 我加的健康探测在 2 小时窗口内看不到故障，且只是推迟整批停放：已去掉。
- 非对象的 `ai_result` 无法写入标记（重试仍无界）：已修（无标注结果时替换，有标注结果时不动）。
- `EPIPE` 被当成 SQLSTATE 计入；非 ASCII API key 的请求头错误被当成记录的错：已修。
- 门闸用应用时钟、批次 SQL 用数据库时钟：门闸改用数据库时钟。
- 强制重判失败后的日志措辞、若干测试依赖共享库里没有其他待标注记录：已修，测试只操作自己创建的记录，并验证了库里有别的待标注记录时同样通过。
- 批次健康探测全表扫描：随探测一起去掉。

评审发现但**未处理**（记录在案）：

- 同类 `jsonb` 写入还在别处，同样的截断加 `JSON.stringify`：无人值守负面巡查（`unattended-negative-patrol.js:280`、`routes/negative-patrol.js:1401`，一条记录就会让整批 `INSERT` 失败，已单独开任务）、舆情剖析 `opinion-analysis.js` 的 `compact`/`cleanText` 与两处 payload 写入（标注成功后自动触发，本修复会让它更容易被触达：负面帖的评论带 emoji 时会静默失败并白付一次模型费用）、评论分类（`comment-sales-judgment.js` 的 `text()`、`comment-workflow.js`）、`capture-stop-fence.js` 的标签页标题等。文本列不受影响，只有 `jsonb`。
- 模型回复里的 U+0000（NUL）仍会让写入失败（22021/22P05），现在由有界重试兜住，而不是修掉。
- `confidence` 非数字（22P02，消息是 `for type real`）与本次事故 SQLSTATE 相同，只有消息不同，按 SQLSTATE 报警会混淆。
- 停放的记录仍被其他"待标注"口径计入：`ops-control` 的 `ai_backlog_stalled`、`capture-recovery-intents` 的 `pending_record_ai_count`、`ai-failover` 的压力判断。这与以前一致（那条记录本来就永远待标注），但静默租户里 `ai_backlog_stalled` 可能一直亮，建议后续把停放数单独统计并从这些口径里排除。
- 强制重判会重新开始预算，`comments_enriched` 这类不改变提示词输入的触发也算。每次重采最多多付 3 次费用，上限取决于重采频率。
- 计入的分类不含"该输入让提供商稳定崩溃"（500）、"该输入让模型超过 40 秒"（超时）、"锁被长期持有"（55P03）：这些按"会自己好"处理，仍是无界重试，每次一次提供商调用（500 时 3 次）。
- 并发的两次失败可能只记一次计数，慢的旧尝试可能覆盖强制重判刚给的新预算：都需要同一条记录上两次模型调用重叠，影响是多付或早停放一次。
- 数据库层统一守卫（`server/db/query.js`）不在本次范围：它分不清 jsonb 参数和文本参数，是共享热路径。
- PostgreSQL 14 未在本机测试（本机只有 17）：用到的语句在 9.5–12 就有；PG14 请以 CI 的 14/16 矩阵为准。

## 发布注意

- **新文件必须进发布清单**：`server/utils/well-formed-text.js`、`server/services/ai-label-failure.js`。它们目前是未跟踪文件，三处生产模块已经 import 它们；只发已修改文件会在启动时 `ERR_MODULE_NOT_FOUND`。新增的测试也是未跟踪文件。
- 无迁移，无配置项。
- 回滚：恢复代码即可。旧代码不认 `labelFailure`，记录回到原来的循环，标记留在 `ai_result` 里无害，下次标注成功时被覆盖。
- 上线后核对（只读）：

```sql
-- 停放的记录
SELECT id, tenant_id, ai_result->'labelFailure'->>'reason' AS reason, ai_result->'labelFailure'->>'code' AS code,
       ai_result->'labelFailure'->>'attempts' AS attempts, ai_result->'labelFailure'->>'lastAt' AS last_at
FROM records
WHERE ai_result->'labelFailure'->>'parked' = 'true' AND ai_result->>'relevance' IS NULL
ORDER BY (ai_result->'labelFailure'->>'lastAtEpoch')::numeric DESC;
```

```bash
grep -E "Label (error|parked) for record" /root/.pm2/logs/onstarvoice-error.log | tail -50
```

  期望：事故记录 `a52c85cb-…` 在第一个批次里被标注（不再有新的报错），其余 `Label error` 行末带 `[原因, counted n/3]` 或 `[原因, not counted]`。

- 需要人工让停放的记录重新获得预算时（例如系统性故障修好之后）。**这是对生产数据的写操作，执行前需要确认**：

```sql
UPDATE records SET ai_result = ai_result - 'labelFailure'
WHERE tenant_id = '<租户 id>' AND ai_result ? 'labelFailure' AND ai_result->>'relevance' IS NULL;
```

## 最终运行

Node 18.20.8，本机 PostgreSQL 17.9（`onstarvoice_test_label_full_20260929`，全新库），最终代码：

| 项目 | 结果 |
| --- | --- |
| Node 全量回归（`node scripts/run-node-regression-tests.mjs`） | 3,184 项，3,176 通过，8 失败。8 个失败都是本机 worktree 的环境问题，与本次改动无关：`admin-comment-lead-judgment`、`admin-navigation-public-filters`、`admin-post-judgment`、`admin-record-original-url-contract`、`admin-stop-fence-panel`、`admin-triage-load`、`record-relevance-presentation-parity` 缺 `typescript`（没有 web/admin 依赖），`capture/douyin-blogger-profile-scope` 缺 `extension-build/` 快照 |
| PostgreSQL 全量集成（`node scripts/run-postgres-integration-tests.mjs`） | 491 / 491（63 个文件），含新增的 `label-record-well-formed`（6 个子用例）与 `label-failure-budget`（17 个子用例） |
| 新增单元测试 | `well-formed-text` 13、`ai-label-well-formed` 4、`ai-label-failure` 11，`record-content-judgment` 由 32 增至 37 |
| 其他门禁 | 全部 `server/**/*.js` 的 `node --check`、`git diff --check`、`check-repository-hygiene`、`check-process-topology` 通过 |
| 未运行 | PostgreSQL 14 与 Node 24（本机没有 PG14；CI 矩阵覆盖）；`npm test` 前置的扩展快照检查（本次不涉及扩展文件） |
