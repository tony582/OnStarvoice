# 客户群 AI 助手开发交接

- 分支：`codex/hotfix-customer-group-assistant-20260912`
- 基线：`a38a7f5a8983636b9ab37525b75c9c4cbd26e0d2`（`a38a7f5`）
- 工作树：`/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-hotfix-customer-group-assistant-20260912`
- 状态：本地开发及验证完成，用户已授权与抖音空结果修复统一发布 v0.4.10。实际提交、部署与迁移结果以该版本发布清单和验收记录为准；真实飞书／邮件联调仍待完成。原 `OnStarvoice-2` 架构源码保持原状。

## 已实现范围

本版接入飞书应用机器人，仅处理授权客户群中授权成员 **@机器人发送的文本消息**。每个租户可绑定多个群；同一群不能同时绑定不同租户。普通微信、企业微信不在本次接入范围。

| 客户请求 | 业务工具 | 实际行为 |
| --- | --- | --- |
| 今天的日报给我一份 | `get_daily_report` | 读取已保存日报，优先返回已交付或已创建的飞书文档入口；未生成时明确告知，不自动重建。 |
| 今天有多少负面／只看抖音／列出明细 | `query_negative` | 查询当前租户内的有效监控主帖，返回数量、平台分布、有限明细、统计口径和截止时间。 |
| 把这份日报发我邮箱 | `email_daily_report` | 按当前成员的明确发信请求，将已有日报送入邮件队列；收件人来自服务端绑定，模型不能指定任意邮箱。 |

支持连续追问。群会话按租户、群、成员和话题隔离，读取最近两小时的上下文；话题追问从对应父回复衔接。追问仍需 @机器人。模型负责理解请求和选择工具，数据、权限与发送结果由业务服务确定，回复中的关键业务事实使用工具回执。

## 默认状态、入口与配置

默认 `enabled=false`、`mode=preview`、`useDailyApp=true`。关闭时不处理群请求；开启预览模式后可接收请求并记录结果，但不向群或邮箱发送。保存配置本身不发送消息。管理员聊天试用调用 `/preview`，即使配置为 `live` 也始终 `dryRun=true`。

- 真实后台：桌面端左下账号菜单 → **客户助手**，或 `/admin/?page=customer-assistant`。包含聊天试用、接入设置、最近消息；仅 `platform_admin`、`internal_operator` 可访问接口。
- UI 演示：开发服务器的 `/admin/?preview=customer-assistant`，本次本地入口为 `http://127.0.0.1:5184/admin/?preview=customer-assistant`。使用明确标注的模拟群、成员、数量和回复，**不访问真实后台、不调用真实模型**；保存仅在当前页面内有效。演示代码不进入生产构建。

配置按当前租户保存：

| 字段 | 用途 |
| --- | --- |
| `enabled`、`mode` | 总开关及 `preview`／`live` 运行模式。 |
| `useDailyApp` | 默认复用该租户日报交付设置中的飞书应用 ID、密钥。 |
| `appId`、`appSecret` | 不复用日报应用时填写独立应用凭据。 |
| `botOpenId` | 机器人身份，用于核对真正 @到的机器人。 |
| `verificationToken`、`encryptKey` | 飞书事件校验、签名验证及消息解密；启用前均须配置。 |
| `groups: [{chatId,name}]` | 授权客户群，最多 30 个。 |
| `members: [{chatId,openId,name,email,canEmail}]` | 按群绑定成员，最多 300 个；邮件权限默认关闭，开启时必须绑定并核实单个邮箱。 |

密钥加密保存，依赖现有 `CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY` 环境变量。GET 只返回 `hasAppSecret`／`hasVerificationToken`／`hasEncryptKey`，不回显秘密；UI 密钥留空保留原值。成员不能在提问中更改租户、身份或收件人。

模型复用后台当前租户的 DeepSeek 配置、交互请求准入和模型故障切换，调用 `/chat/completions`；该租户须配置可用的 DeepSeek provider。邮件复用现有租户 SMTP 及日报邮件正文、Excel 附件生成能力，不另建发件账号。工具调用和历史拼接遵循 [DeepSeek Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/) 与 [多轮对话](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/) 协议。

## 飞书事件与接口

应用需开启机器人能力，加入目标群，配置接收 @消息和回复消息所需权限，订阅 `im.message.receive_v1`。接入外部客户群时，还需开启应用对外共享、具备飞书要求的主体认证并完成发布审核，具体以 [飞书外部群机器人文档](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group) 为准。后台读取设置时返回该租户的 `callbackPath`：

```text
POST /api/customer-assistant/feishu/{tenantId}
GET  /api/customer-assistant/settings
PUT  /api/customer-assistant/settings
POST /api/customer-assistant/preview
GET  /api/customer-assistant/activity
```

飞书事件订阅应填写部署后的 HTTPS 地址加 `callbackPath`。回调执行 URL 验证、签名及时间窗校验、解密、应用身份校验；只接受授权成员的群文本 @消息，按消息及事件 ID 去重后入队。正式回复落在原消息话题中。协议参考：[飞书接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。

**跨租户共用飞书应用仍有接入边界。** 本版回调按租户路径配置，未实现统一的跨租户事件分发。同一飞书应用只有一个事件订阅 URL 时，不能把多个租户的路径分别直接配置给它；需要统一入口按已核验的应用、群绑定分发，或使用独立应用。`useDailyApp=true` 只表示复用当前租户的日报凭据，不能据此宣称共享应用已自动支持多租户。

## 日报、统计与邮件口径

- **负面查询**按上海时区首次入库自然日统计，最多连续 31 天；使用当前有效情感，排除非监控内容、官方内容和评论记录，同帖复采不重复计数。包含待分析数及截止时间，不能解释为全网负面总量。
- **客户日报**沿用既有工作日、夜间归属切分、周末及节假日合并规则。未指定日期时由工作日日历选择默认日报日；它与“今天的自然日负面数量”不保证相同。
- 助手只读取日报，不重建、不覆盖客户修改。存在更新草稿时，优先保留已交付飞书文档的身份和版本。摘要来自系统保存快照；客户在飞书中的后续修改以原文档为准。
- 邮件冻结所选日报的系统保存版本、收件人及附件，**不包含客户之后在飞书文档中的修改**；邮件正文和回执说明这一点。发送前再次核对总开关、正式模式、群及成员邮箱授权。

邮件状态分别为：`preview` 仅预览；`queued` 等待发送；`sent` 表示 SMTP 确认接受，不能宣称已进入收件箱；`failed` 表示失败；`unknown` 表示发送结果不确定。同一请求重放不会再次排队；超时、中断或结果不确定时停止自动重试，由管理员核对后决定后续处理。正式请求的邮件终态通过原群消息回执通知；终态落库后、首次通知前发生中断，下轮调度会补发首次回执；已经尝试但未确认送达的通知不盲目重试。

## 存储、运行与验证

新增迁移 `server/db/migrations/084_customer_group_assistant.sql`，包含设置、会话、事件及邮件投递四张表，只在正式发布步骤中应用并核对登记。队列接入现有运行调度器，任务名 `customer-group-assistant`，每 5 秒处理一轮。发布须先应用迁移，再更新后端与管理前端；真实飞书接入、客户权限和邮件送达验收尚不能由 UI 演示替代。

已确认验证结果：

- 合并发布版在 Node 24.12.0 与生产同版 Node 18.20.8 下各 2,209／2,209 回归通过，生产 Extension 快照检查通过。
- 专项测试：Agent + 模型 31／31、业务工具 + 邮件 23／23、边界 8／8 通过；转述、总结和能力询问即使被模型强行调用邮件工具也不会执行发送。
- PostgreSQL 集成：新空库 `onstarvoice_test_assistant_final_20260912` 执行最终 084 完整迁移后，`customer-assistant.integration.mjs` 13／13 通过。
- 合并后完整 PostgreSQL 集成 182／182 通过，仅使用独立测试库。
- 后端 `check:syntax`、仓库 hygiene、管理前端构建通过。新 UI 定向 ESLint 零错误；管理前端 lint 基线保持既有 288 个错误、0 警告，无新增。
- 浏览器验证三类问题、连续对话、正式模式下试用仍不外发、切换成员清空会话、未授权邮件拒绝、绑定校验、最近消息和 390／320 像素窄屏布局。浏览器控制台 0 错误、0 警告。

复验命令（在本工作树根目录运行；数据库集成测试使用独立测试库配置）：

```sh
npm --prefix web/admin run build
node --test tests/customer-assistant-*.test.mjs tests/server-cron-runtime.test.mjs
npm --prefix server test
npm --prefix server run test:integration
```

UI 截图位于 `output/playwright/customer-assistant-email-preview.png`、`customer-assistant-settings-desktop.png`、`customer-assistant-chat-mobile.png`，均为演示数据。
