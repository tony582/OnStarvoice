# AI 与通知机制

本文说明 StarVoice 当前稳定版中 AI 能力、异步处理、人工介入提醒和邮件通知的真实运行方式。它面向开发、测试和运维人员，重点回答四个问题：

1. 哪些环节会调用 AI，哪些环节不会；
2. AI 失败后业务会继续、降级还是阻断；
3. “需要人工介入”如何被识别和通知；
4. 如何排查“AI 没介入”“分析一直转圈”“邮件没有收到”等问题。

> 稳定边界：AI 是舆情分类、相关性判断、评论精炼、图像文字识别和深度剖析的辅助能力，不是浏览器采集状态机的唯一判断来源。除明确标注为阻断的业务校验外，AI 超时或不可用不应让已经采集到的数据丢失。

---

## 1. 总体数据流

当前系统中的 AI 处理大致分为六条链路：

```text
Extension 列表采集
  └─ 可选：相关性前置筛选
       ├─ 高置信无关 → 跳过增强
       └─ 相关 / 不确定 / AI 异常 → 继续采集

采集结果同步到服务端
  ├─ 记录分类与舆情标签
  ├─ 评论规则入库
  │    └─ 后台 AI 精炼评论
  ├─ 负面记录自动触发深度剖析
  ├─ 图片文字识别
  └─ 视频/音频转写

采集状态与结构化异常
  └─ 安全验证识别
       ├─ 后台“需要处理”状态
       └─ 持久化邮件通知队列
```

这里有两个必须区分的概念：

- **采集是否完成**：由 Extension、云任务、工作项、尝试记录和服务端回写共同决定；
- **AI 是否完成**：由各 AI 子流程单独决定。AI 失败可能导致标签、精炼结果或剖析缺失，但不应伪造“采集失败”。

---

## 2. 配置来源与优先级

### 2.1 租户配置优先于环境变量

通用 LLM 配置按以下顺序读取：

1. 当前租户的数据库设置；
2. 服务端环境变量；
3. 代码中的安全默认值。

常用租户设置键：

| 设置键 | 用途 |
| --- | --- |
| `llm_provider` | LLM 提供商 |
| `llm_api_key` | LLM 密钥 |
| `llm_model` | 模型名称 |
| `llm_api_endpoint` | OpenAI-compatible 接口地址 |
| `dashscope_api_key` | 阿里云百炼 OCR/ASR 密钥 |
| `capture_attention_email_to` | 安全验证提醒收件人，可配置多个 |
| `smtp_host` / `smtp_port` / `smtp_secure` | 租户级 SMTP |
| `smtp_user` / `smtp_pass` | 租户级 SMTP 账号 |
| `email_from` | 发件人 |

对应环境变量见 [`server/.env.example`](../server/.env.example)。

### 2.2 支持的 LLM 提供商

| `LLM_PROVIDER` | 默认模型 | 默认接口 | 说明 |
| --- | --- | --- | --- |
| `gemini` | `gemini-2.0-flash` | Google Gemini 接口 | 原生 Gemini 调用 |
| `openai` | `gpt-4o-mini` | `https://api.openai.com/v1` | OpenAI-compatible |
| `deepseek` | `deepseek-chat` | `https://api.deepseek.com/v1` | OpenAI-compatible |
| `qianwen` | `qwen-turbo` | DashScope compatible-mode | OpenAI-compatible |

具体模型可通过租户配置或 `LLM_MODEL` 覆盖。不要把 API Key 写进前端、Extension 源码、构建产物或 Git 仓库。

### 2.3 配置变更后的生效范围

- 数据库中的租户设置通常会在后续请求读取时生效；
- 环境变量修改后需要重启服务进程；
- Extension 端是否启用“AI 精准筛选”，由任务配置决定；
- 一个租户配置正确，不代表另一个租户自动继承；
- 生产问题排查时必须同时确认“当前租户”和“当前 Agent”。

---

## 3. 相关性前置筛选

### 3.1 目的

相关性前置筛选用于在打开详情页之前，判断列表中的作品是否与当前关键词和业务范围明显无关。它的目标是减少无效详情页访问和风控暴露，而不是替代最终舆情判断。

当前稳定约束：

- 固定使用 DeepSeek 提供商；
- 单批最多 `40` 条；
- 只有无关置信度达到 `0.97` 及以上时，才允许跳过增强；
- 默认模型超时 `15` 秒；
- 默认单租户并发 `6`；
- 默认单租户每日最多判断 `5000` 项；
- 服务端模式默认为 `conservative`；
- 当前提示词版本为 `prefilter-list-v2`。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PREFILTER_SERVER_MODE` | `conservative` | 服务端安全模式 |
| `PREFILTER_MODEL_TIMEOUT_MS` | `15000` | 单次模型请求超时 |
| `PREFILTER_TENANT_CONCURRENCY` | `6` | 单租户并发上限 |
| `PREFILTER_DAILY_ITEM_LIMIT` | `5000` | 单租户每日条目额度 |

### 3.2 降级策略

以下情况均应**安全放行**，让 Extension 继续正常采集，而不是直接判定无关：

- API Key 未配置；
- 提供商不是 DeepSeek；
- 模型超时；
- 并发上限已满；
- 每日额度已用完；
- 模型返回格式不合法；
- 服务端暂时不可用；
- 判断置信度不足。

因此，“AI 精准筛选已开启”不等于每条作品一定会看到 AI 请求；缓存、额度、并发和安全放行都可能让任务继续执行。

### 3.3 排查步骤

1. 确认任务配置中确实开启 AI 精准筛选；
2. 确认当前租户 `llm_provider=deepseek`；
3. 确认当前租户存在有效 `llm_api_key`；
4. 查看服务端是否返回 `PREFILTER_CONCURRENCY_LIMIT`、`PREFILTER_DAILY_LIMIT` 或 `PREFILTER_UNAVAILABLE`；
5. 确认没有把“继续采集”误判成“AI 完全没运行”；
6. 用相关性前置筛选测试验证：

```bash
node --test tests/capture/ai-relevance-prefilter.test.mjs
node --test tests/server-relevance-prefilter.test.mjs
```

---

## 4. 记录分类与舆情标签

### 4.1 触发方式

采集记录入库后，服务端会对待处理记录进行 AI 分类。当前同时存在两种触发方式：

- 定时任务每 `10` 分钟处理一批，默认每批 `20` 条；
- 管理接口可手动触发一批分类。

当前记录分类提示词版本为：

```text
record-topic-v2
```

分类结果用于内容分诊、情感、主题、身份等展示。它不会改变原始采集内容，也不应覆盖人工编辑后的判断。

### 4.2 缺少 AI 配置时的行为

如果没有可用的 LLM 配置，或本轮请求失败：

- 原始记录仍保留；
- 记录可继续在后台被查看和处理；
- 未完成的 AI 字段保持待处理或使用规则结果；
- 后续定时批次可以重试。

不能把“没有 AI 标签”解释为“没有采集到内容”。

### 4.3 人工判断优先

后台“编辑判断”属于业务人员的人工结论。后续自动任务不得无条件覆盖人工确认结果。涉及误判修正时，应先核对：

- 当前记录是否已有人工判断；
- 是否强制执行了重新分类；
- 提示词版本是否发生变化；
- 记录的租户与品牌上下文是否正确。

---

## 5. 评论入库与 AI 精炼

### 5.1 两阶段处理

评论链路分为两个阶段：

1. **规则入库**：评论先从采集 payload 中写入数据库并立即可见；
2. **AI 精炼**：后台再补充情感、摘要、风险和其他结构化结果。

这项拆分的意义是：LLM 变慢或失败时，评论原文仍然可用。

### 5.2 服务启动后的自愈

服务启动时会：

- 延迟约 `15` 秒重新处理 payload 中尚未补入数据库的评论；
- 延迟约 `20` 秒启动 AI 精炼循环；
- 每轮最多执行 `30 × 300 = 9000` 条；
- 单轮结束后约 `15` 秒再次检查；
- 循环不重叠，避免同一进程中并发排空同一批积压。

这不是外部消息队列。进程重启时，内存中的当前调用会中断，但已入库评论和待精炼标记仍可由后续循环恢复。

### 5.3 数量含义

后台可能同时显示：

- 平台详情页声明的评论总数；
- 本次实际读取的评论数；
- 数据库去重后的评论数；
- AI 已精炼评论数；
- 风险评论数。

这些数值不是同一个口径。平台显示“评论 2,222”不代表当前任务读取了 2,222 条；任务上限、页面可见性、登录状态、平台懒加载和去重都会让实际入库数更少。

---

## 6. 舆情深度剖析

### 6.1 自动与手动触发

- 负面内容在满足品牌上下文和数据条件时，可自动触发深度剖析；
- 中性或正面内容通常由用户点击后触发；
- 同一记录的重复请求会尽量复用已有结果，避免重复消耗。

### 6.2 当前实现边界

深度剖析任务目前通过进程内异步执行启动，不是持久化作业队列。因此：

- API 可以先返回“正在分析”；
- Node 进程重启会中断尚未完成的分析；
- 服务启动时会把上一进程遗留的 `pending` / `running` 分析标记为 `failed`；
- 前端随后应展示可重试状态，而不是无限轮询；
- 不应承诺进程重启后自动从中间步骤续跑。

当页面出现“暂时无法读取舆情巡查”时，应依次检查：

1. 对应分析记录是否为 `failed`；
2. 服务是否在分析期间发生重启；
3. 当前租户 LLM 是否可用；
4. 输入记录是否仍存在；
5. 是否存在品牌上下文或数据字段缺失；
6. 服务端错误日志中的模型超时、格式错误或数据库错误。

相关回归测试：

```bash
node --test tests/server-opinion-analysis-auto.test.mjs
node --test tests/server-negative-patrol-analytics.test.mjs
```

---

## 7. 图片文字识别

图片文字识别与通用 LLM 分类是独立能力。当前优先使用 Qwen/DashScope 相关配置：

| 变量 | 用途 |
| --- | --- |
| `QWEN_OCR_API_KEY` | OCR 专用 Key |
| `QWEN_OCR_MODEL` | OCR 模型 |
| `QWEN_OCR_API_ENDPOINT` | OCR 接口地址 |
| `DASHSCOPE_API_KEY` | 没有 OCR 专用 Key 时的后备 Key |

如果当前通用 LLM 已配置为 Qianwen，也可能复用其 Key、模型和 endpoint。OCR 失败时应保留原图和原始记录，允许后续重新提取，不应删除原始素材。

验证：

```bash
node --test tests/server-image-text-extraction.test.mjs
node --test tests/server-record-image-text-contract.test.mjs
```

---

## 8. 音视频转写

当前转写使用 DashScope ASR。关键环境变量：

| 变量 | 默认/用途 |
| --- | --- |
| `DASHSCOPE_API_KEY` | ASR 鉴权 |
| `DASHSCOPE_ASR_ENDPOINT` | ASR 结果接口 |
| `DASHSCOPE_TASK_ENDPOINT` | 异步任务接口 |
| `DASHSCOPE_ASR_MODEL` | 默认 `paraformer-v2` |
| `ASR_STAGE_TTL_MS` | 临时媒体默认保留 15 分钟 |
| `PUBLIC_BASE_URL` | 供 DashScope 拉取媒体的公网地址 |

由于云端 ASR 需要拉取媒体，服务端会：

- 把待转写媒体放入短时临时区；
- 生成随机 token；
- 暂时通过 `/api/asr-media/...` 提供公网读取；
- 到期后清理临时文件；
- 不把该入口当作永久媒体地址。

生产必须配置可从公网访问的 HTTPS `PUBLIC_BASE_URL`。只配置 `localhost` 无法让云端模型回调读取。

---

## 9. 安全验证识别与人工介入

### 9.1 什么情况会触发

只有同时满足以下条件，才会进入结构化安全验证通知：

1. 云任务状态为 `needs_action`；
2. 当前快照状态也为 `needs_action`；
3. 快照、错误、进度或 checkpoint 中存在结构化安全证据。

当前识别的错误码包括：

```text
DOUYIN_SEARCH_SECURITY_CHALLENGE
PLATFORM_SAFETY_BLOCK
SECURITY_VERIFICATION_REQUIRED
XHS_SECURITY_BLOCK
PAGE_CHALLENGE
CAPTCHA_REQUIRED
```

以下错误被明确排除：

```text
DOUYIN_SEARCH_SERVICE_ABNORMAL
```

抖音“服务出现异常”可能是临时搜索异常或无结果，不应自动当作账号风控，也不应发送安全验证邮件。

### 9.2 为什么要求结构化证据

系统不能只凭页面包含“安全”“异常”之类文字就判断风控。必须由 Extension 或服务端产生明确字段，例如：

- `securityBlocked`
- `platformSafetyBlocked`
- `requiresManualAction`
- 对应的结构化错误码或错误类别

这可以减少普通内容、帖子标题或平台提示词造成的误报。

### 9.3 后台状态与邮件不是一回事

- 后台“需要处理”由云任务当前状态直接展示；
- 邮件通知通过独立的数据库队列异步发送；
- 后台能看到不代表邮件一定已发送；
- 邮件未配置不应阻止后台显示；
- 邮件失败不应自动停止用户进行人工验证和继续任务。

---

## 10. 邮件通知队列

### 10.1 队列行为

安全验证事件写入 `capture_attention_notifications` 表。关键行为：

- 使用租户、任务、尝试次数和安全错误码组成事件键；
- 同一事件键重复写入会被去重；
- worker 每分钟运行一次；
- 每轮默认领取 `20` 条，单批硬上限 `50`；
- 使用数据库锁和 claim token 防止多个 worker 重复发送；
- `processing` 超过 `10` 分钟会被后续 worker 重新领取；
- 最大投递次数为 `5` 次。

重试间隔：

1. 第一次失败后约 1 分钟；
2. 第二次失败后约 5 分钟；
3. 第三次失败后约 15 分钟；
4. 后续失败约 60 分钟。

### 10.2 队列状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待首次发送 |
| `processing` | 已被 worker 领取 |
| `retry_wait` | 临时失败，等待下一次重试 |
| `sent` | 已发送 |
| `blocked_config` | SMTP 或收件人配置缺失/无效 |
| `failed` | 已达到终止条件 |

### 10.3 收件人配置

租户设置 `capture_attention_email_to` 支持逗号、分号或换行分隔，去重后最多保留 `20` 个合法邮箱地址。

发信依赖：

- `capture_attention_email_to`；
- 有效 SMTP host、port、secure、user、pass；
- 有效 `email_from`；
- 可选 `ADMIN_PUBLIC_URL`，用于邮件中的后台任务链接。

邮件不包含平台验证码、Cookie 或登录凭据，只提供任务、Agent、关键词和人工介入入口等诊断信息。

### 10.4 当前未实现能力

当前稳定版没有实现以下通知渠道：

- 飞书机器人；
- 企业微信机器人；
- 短信；
- 电话；
- 浏览器系统推送。

不要配置一个未被代码读取的 Webhook 后就认为通知已生效。

---

## 11. 运营报表与普通邮件

除安全验证邮件外，系统还会按租户配置生成日报、周报和月报。定时器每分钟检查一次上海时区配置：

- 日报默认时间 `09:00`；
- 周报默认星期一 `09:00`；
- 月报默认每月 1 日 `09:00`；
- 可通过租户设置关闭或修改。

报表邮件与安全验证邮件共享 SMTP 基础设施，但触发条件、收件人语义和失败处理不同。排查时不要只确认“测试邮件能发”，还应确认对应租户的报表开关、时间和收件人。

---

## 12. 安全与隐私要求

1. API Key、SMTP 密码只存在服务端环境或租户加密/受控配置中；
2. 禁止把 `.env`、生产数据库备份和带 token 的临时地址提交到 Git；
3. 日志不得打印完整 API Key、SMTP 密码、Cookie 或平台登录凭据；
4. AI 输入应只包含完成业务判断所需内容；
5. ASR 临时媒体必须短时有效，不得长期公开；
6. 邮件中不发送验证码和账号密码；
7. 多租户排查必须携带正确租户上下文，不能跨租户读取配置；
8. 人工判断和工单状态不能被后台 AI 无条件覆盖。

---

## 13. 运维排查手册

### 13.1 AI 完全没有结果

检查顺序：

1. `/api/health` 是否正常；
2. 当前租户是否有 LLM 配置；
3. provider、model、endpoint 是否匹配；
4. API Key 是否有效且有额度；
5. 服务端能否访问模型 endpoint；
6. 是否只是异步队列尚未轮到；
7. 是否命中安全放行、缓存或人工结果保护；
8. PM2 日志是否出现超时或 JSON 解析错误。

### 13.2 相关性筛选看似没有运行

重点确认：

- 任务是否打开 AI 精准筛选；
- provider 是否为 DeepSeek；
- 是否超过每日额度；
- 是否触发并发限制；
- 是否因超时按设计安全放行；
- 作品是否已经增强过并被跳过。

### 13.3 评论有原文但没有 AI 标签

这通常表示规则入库成功、AI 精炼尚未完成。检查：

- 服务是否持续运行超过 20 秒；
- 日志是否出现 `[CommentRefine]`；
- LLM 是否超时；
- 评论是否已经标记为待精炼；
- 重启后自愈是否执行。

### 13.4 深度剖析一直转圈

检查服务是否重启过。当前分析是进程内异步任务，重启后旧任务应被标记失败并允许重试。若仍为运行中，应检查启动收尸逻辑和对应数据库记录。

### 13.5 后台显示需处理但没有邮件

检查：

1. 任务是否真的存在结构化安全证据；
2. `capture_attention_notifications` 是否创建记录；
3. 状态是否为 `blocked_config`；
4. `capture_attention_email_to` 是否有效；
5. SMTP 是否配置；
6. worker 是否每分钟执行；
7. 状态是否在 `retry_wait`；
8. 邮件服务商是否拒绝投递。

### 13.6 建议日志关键字

```text
[Cron]
[CommentRefine]
[Reprocess]
[OpinionAnalysis]
[CaptureAttention]
[Relabel]
[CoverStore]
[ImageStore]
```

---

## 14. 发布前验证清单

- [ ] 当前租户 LLM 配置完整，未把 Key 写进前端；
- [ ] DeepSeek 前置筛选能正常返回，也能在超时后安全放行；
- [ ] 一条新记录可以完成分类；
- [ ] 评论先入库、后精炼，不因 LLM 故障丢原文；
- [ ] 一条负面内容可以创建或重试深度剖析；
- [ ] OCR 失败时原图仍存在；
- [ ] ASR 临时链接从公网可访问且到期失效；
- [ ] 普通搜索异常不会触发安全验证邮件；
- [ ] 结构化验证码/安全挑战会进入 `needs_action`；
- [ ] 邮件通知可发送，配置缺失时进入 `blocked_config`；
- [ ] 同一安全事件不会重复发出多封邮件；
- [ ] PM2 重启后，旧的分析任务不会无限显示运行中；
- [ ] 人工修改的舆情判断未被自动覆盖。

建议运行：

```bash
node --test tests/capture/ai-relevance-prefilter.test.mjs
node --test tests/server-relevance-prefilter.test.mjs
node --test tests/capture-attention-notifier.test.mjs
node --test tests/admin-platform-safety-attention.test.mjs
node --test tests/server-opinion-analysis-auto.test.mjs
node --test tests/server-image-text-extraction.test.mjs
```

---

## 15. 稳定版结论

当前稳定版已经具备：

- 多租户 LLM 配置；
- DeepSeek 相关性前置筛选；
- 记录 AI 分类；
- 评论先入库后精炼；
- 负面内容深度剖析；
- OCR 和 ASR；
- 结构化安全验证识别；
- 数据库持久化邮件重试队列；
- 启动后的评论和分析状态自愈。

仍需明确接受的边界：

- AI 服务本身可能超时、限流或返回不稳定格式；
- 深度剖析仍是进程内异步执行，不是持久化任务队列；
- 评论 AI 精炼是最终一致，不是同步完成；
- 通知当前只有后台状态和 SMTP 邮件；
- AI 结果不能替代人工复核；
- 所有“自动”能力都受租户配置、额度、网络和平台页面状态影响。
