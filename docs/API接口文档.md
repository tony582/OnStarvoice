# StarVoice 星语 API 接口文档

> 稳定版基线：Extension `0.3.67`，仓库提交 `4626d9e`，数据库迁移截至 `050_ticket_comment_record_link.sql`。
> 本文用于开发、联调、排障和交接，不替代路由源码。接口发生变化时，应同时更新对应路由、测试和本文。

## 1. 基址与服务边界

| 环境 | API 基址 | 管理后台 |
|---|---|---|
| 本地开发 | `http://localhost:3001/api` | `http://localhost:3001/admin/` |
| 生产 | `https://voice.minilife.online/api` | `https://voice.minilife.online/admin/` |

生产环境由 Nginx 终止 HTTPS，再转发到显式配置为 `3002` 的 Node 服务；仓库支持的本地联调端口为 `3001`。只有完全未提供 `PORT` 时，服务端代码才会回退到 `3000`，该回退值不作为本仓库的标准联调配置。除 `/api` 外，服务还提供：

- `/admin`：`web/admin/dist`；
- `/dashboard`：`web/dashboard/dist`；
- `/media`：持久化媒体目录；
- `/downloads`：客户下载包；
- `/api/health`：轻量健康检查。

当前项目没有自动生成的 OpenAPI 文件。需要确认字段、权限或边界行为时，以以下目录为准：

- `server/src/routes/`：HTTP 路由；
- `server/src/middleware/`：会话、租户、角色与 Agent 鉴权；
- `server/src/services/`：状态机、编排、同步和 AI 业务逻辑；
- `tests/server-*.test.mjs`、`tests/cloud-*.test.mjs`：关键契约。

## 2. 请求与响应约定

### 2.1 数据格式

- 正文通常使用 `Content-Type: application/json`；
- 成功结果通常为 JSON 对象或列表；
- 失败结果通常包含 `ok: false`、`error` 和/或 `message`；
- 历史接口并未完全统一响应外壳，调用方不得假设所有成功响应都包含 `ok: true`；
- 日期时间均按 ISO 8601 传输；业务日程默认使用 `Asia/Shanghai`。

### 2.2 常见 HTTP 状态码

| 状态码 | 含义 | 客户端处理 |
|---|---|---|
| `200` / `201` | 查询或创建成功 | 按返回状态刷新页面 |
| `400` | 参数不合法 | 展示具体字段错误，不自动重试 |
| `401` | 未登录、激活码或 Agent 令牌无效 | 重新登录/激活 |
| `403` | 无租户、角色或平台管理权限 | 不应通过前端隐藏来替代服务端校验 |
| `404` | 资源不存在或不属于当前租户 | 停止重试并刷新列表 |
| `409` | 幂等键冲突、状态冲突 | 保留原请求键，核对参数与当前状态 |
| `422` | 业务约束不满足 | 根据返回原因修正任务配置 |
| `429` | 频率或资源限制 | 指数退避，避免并发放大 |
| `500` | 服务端异常 | 记录 request/task ID，结合 PM2 日志排查 |

### 2.3 幂等与任务写回

云端任务和 Extension 写回必须遵守以下规则：

1. 创建任务时使用稳定的客户端请求 ID，网络超时重试时复用同一 ID；
2. 同一节点、同一 ID、同一规范化参数返回原任务；
3. 同一 ID 携带不同参数返回冲突，不能生成第二条业务任务；
4. Extension 写回携带执行尝试编号和递增进度序号；
5. 终态吸收迟到写回，旧尝试不能覆盖新尝试；
6. “进度 100%”不能单独判定成功，服务端以工作项状态聚合父任务状态。

## 3. 鉴权模型

项目存在三类身份，不能混用。

### 3.1 后台用户会话

用于管理后台和平台管理页面：

```http
Cookie: osv_session=<session-token>
```

也可由受控客户端使用：

```http
x-session-token: <session-token>
x-tenant-id: <tenant-id>
```

服务端会校验：

- 会话是否有效；
- 用户是否属于目标租户；
- 读写角色是否满足；
- 平台管理接口是否为平台管理员。

平台管理员仍使用正常登录会话，不存在通用的 `x-admin-token` 绕过机制。

### 3.2 Extension 激活码

历史同步、验证和部分兼容接口使用：

```http
x-auth-code: <activation-code>
```

激活码与租户、到期时间、最大设备绑定数和状态关联。不得把激活码写进日志、示例包、截图或 Git。

### 3.3 浏览器 Agent 令牌

浏览器 Profile 首次注册后，服务端签发独立 Agent 令牌：

```http
Authorization: Bearer <agent-token>
```

该令牌只允许：

- 上报本 Agent 心跳；
- 领取分配给本 Agent 的命令；
- 上报本 Agent 的任务快照；
- 提交本 Agent 的命令执行结果。

Agent 令牌不能登录后台，也不能指定其他租户。激活码冻结、过期、绑定删除或 Agent 退役后，令牌立即失效。

## 4. 核心接口分组

### 4.1 登录与当前用户 `/api/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/login` | 登录并建立会话 |
| `POST` | `/logout` | 注销当前会话 |
| `GET` | `/me` | 当前用户、平台角色、租户与租户角色 |

登录后的后台请求应显式携带当前租户 ID。不要依赖前端当前页面替代租户隔离。

### 4.2 健康检查 `/api/health`

```http
GET /api/health
```

当前返回包含：

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptime": 12345
}
```

这里的 `version` 是服务健康字段，不是 Extension 版本，也不是可靠发布号。发布核验仍以 Git 提交、Extension manifest、前端资源哈希和 PM2 启动时间为准。

### 4.3 Extension 验证与数据同步

主要路由族：

- `/api/verify`：激活码验证；
- `/api/sync`：单条或批量采集数据同步；
- `/api/target`：对标监控数据；
- `/api/update-manifest`：Extension 更新清单；
- `/api/img`：图片代理；
- `/api/asr-media`：ASR 临时媒体访问。

同步示例：

```http
POST /api/sync/batch
x-auth-code: <activation-code>
Content-Type: application/json

{
  "records": [
    {
      "syncType": "single_note",
      "platform": "douyin",
      "payload": {
        "noteId": "7654321000000000000",
        "title": "示例标题",
        "publishTime": "2026-07-30T08:30:00+08:00",
        "commentsCleanedItems": []
      }
    }
  ]
}
```

入库大致经过：

1. 平台数据归一化；
2. 按租户、平台、作品标识幂等 upsert；
3. 互动量写入快照历史；
4. 评论快速入库；
5. 后台 AI 队列异步精炼评论与内容判断；
6. 更新工作台、巡查和报告的派生数据。

图片、评论或作者增强采集不会创建额外的业务任务卡片；它们属于同一采集任务的处理步骤。

### 4.4 云端任务中心 `/api/capture-cloud`

#### Agent 侧

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/agent/heartbeat` | 上报节点、能力、任务账本、计划镜像并领取命令 |
| `POST` | `/agent/commands/:id/complete` | 提交命令成功或失败结果 |

心跳可证明 Extension 最近可达，但不等于采集任务健康。后台同时区分：

- 设备心跳；
- 任务心跳；
- 真实业务进展时间。

#### 后台节点与任务

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/overview` | 节点、任务、计划和统计总览 |
| `PATCH` | `/agents/:id` | 修改节点名称、设备归组、负责平台等 |
| `DELETE` | `/agents/:id` | 删除允许删除的节点 |
| `POST` | `/agents/:id/retire` | 将不可再上线的节点退役 |
| `POST` | `/agents/:id/tasks` | 给单个 Agent 下发一次性任务或无人值守计划 |
| `DELETE` | `/agents/:id/unattended-plan` | 删除节点无人值守计划 |
| `POST` | `/tasks/:id/resume` | 从服务端检查点继续任务 |
| `POST` | `/tasks/:id/stop` | 停止或排队停止任务 |
| `POST` | `/tasks/:id/dismiss-attention` | 处理单条终态提醒 |
| `POST` | `/tasks/dismiss-terminal-attention` | 批量清理已结束失败提醒 |
| `GET` | `/tasks/:id/snapshots` | 追加式任务快照历史 |
| `GET` | `/tasks/:id/events` | 任务审计事件 |

单节点任务创建示例：

```http
POST /api/capture-cloud/agents/<agent-id>/tasks
x-session-token: <session-token>
x-tenant-id: <tenant-id>
Content-Type: application/json

{
  "clientTaskId": "b44c62a2-1ef8-40da-89ea-55b1d5b9a29d",
  "executionMode": "one_time",
  "platform": "xiaohongshu",
  "keywords": ["安吉星", "别克车机"],
  "sort": "latest",
  "publishTime": "week",
  "maxRounds": 1
}
```

无人值守计划使用相同入口，但 `executionMode` 为 `unattended_plan`，并携带每日或指定日期配置。保存计划不等于立即开始采集。

#### 多 Agent 编排

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/orchestrations` | 创建编排草稿 |
| `DELETE` | `/orchestrations/:id/draft` | 删除未下发草稿 |
| `POST` | `/orchestrations/:id/allocation-preview` | 预览关键词工作项分配 |
| `POST` | `/orchestrations/:id/dispatch` | 按确认方案创建真实子任务 |
| `POST` | `/orchestrations/:id/schedule/pause` | 暂停定期计划 |
| `POST` | `/orchestrations/:id/schedule/resume` | 恢复定期计划 |
| `POST` | `/orchestrations/:id/resolve-attention` | 人工处理或安排接力 |
| `GET` | `/orchestrations/:id` | 查询编排、工作项、Agent 与尝试 |

当前边界：

- 最多 `300` 个关键词；
- 最多 `50` 个 Agent；
- 使用确定性的连续、互斥、均衡切片；
- 各 Agent 工作项数之差不超过 `1`；
- 默认 `maxRounds=1`；
- 调度不会把验证码或明确风控任务自动迁移给其他账号继续冒险。

### 4.5 负面帖子巡查

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/capture-cloud/negative-patrol/candidates/preview` | 预览待巡查负面作品 |
| `POST` | `/capture-cloud/negative-patrol/tasks` | 创建单/多 Agent 负面巡查 |
| `POST` | `/capture-cloud/negative-patrol/orchestrations/:id/reassign` | 对未完成工作项重新分配 |
| `GET` | `/capture-cloud/negative-patrol/analytics` | 舆情巡查聚合数据 |
| `GET` | `/capture-cloud/negative-patrol/posts/:recordId/timeline` | 单帖声量与可用性时间线 |

业务约束：

- 首次巡查只建立基线，至少两个有效快照后才计算变化；
- 已删除或不可用作品保留历史，并写入可用性状态；
- 负面巡查不会自动转工单；
- 转工单必须由用户显式操作；
- 工单详情会继续读取原作品、评论、官方回复、快照与巡查记录。

### 4.6 官方账号评论巡查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/capture-cloud/official-comment-patrol/accounts` | 可巡查官方账号 |
| `POST` | `/capture-cloud/official-comment-patrol/candidates/preview` | 预览时间范围内作品 |
| `POST` | `/capture-cloud/official-comment-patrol/tasks` | 创建官方账号评论巡查 |

服务端要求官方账号配置真实主页链接。列表页日期仅用于候选发现，Extension 打开作品详情后重新核验精确发布时间。发布时间未知的作品不会自动纳入日期范围。

“每篇最多读取评论”表示本次从当前可见评论中读取的样本上限，不代表平台显示的评论总数。

### 4.7 关注博主巡查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/capture-cloud/followed-creator-patrol/subscriptions` | 可用关注博主订阅 |
| `POST` | `/capture-cloud/followed-creator-patrol/tasks` | 创建主页作品/评论巡查 |

关注博主与官方账号是两类业务对象。前者关注创作者动态，后者关注品牌自有账号作品下的评论；前端入口和任务类型必须保持分离。

### 4.8 内容分诊与记录

主要路由族：

- `/api/triage`：工作中、归档、批量处置和事件关联；
- `/api/records`：作品详情、版本、快照、评论、逐字稿、图片文字、官方回复；
- `/api/comments`：评论详情与评论操作；
- `/api/custom-tags`：租户自定义标签；
- `/api/feedback`：误判反馈与人工校正；
- `/api/opinion-analysis`：深度剖析与舆情分析。

常见记录接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/records/:id/comments` | 作品评论 |
| `GET` | `/records/:id/observations` | 搜索命中与发现观测 |
| `GET` | `/records/:id/versions` | 内容版本历史 |
| `GET` | `/records/:id/activity` | 处理与巡查活动 |
| `GET` | `/records/:id/manual-history` | 人工判断历史 |
| `GET` | `/records/:id/media-proxy` | 媒体代理 |
| `GET` | `/records/:id/image-text` | OCR 结果 |
| `GET` | `/records/:id/transcript` | 视频逐字稿 |
| `POST` | `/records/:id/transcribe` | 发起转写 |
| `POST` | `/records/:id/analyze-transcript` | 分析逐字稿 |
| `PATCH` | `/records/:id/official-response` | 标记官方已响应 |

内容列表常用筛选包括平台、情感、风险、处置状态、关键词、发布时间和排序。最终字段名以对应路由中的参数解析器为准。

### 4.9 工单 `/api/tickets`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/` | 用户显式转工单 |
| `GET` | `/` | 工单列表 |
| `GET` | `/dispatched` | 已转工单工作台 |
| `GET` | `/export` | 导出 |
| `GET` | `/assignees` | 可选处理人 |
| `GET` | `/:id/source` | 工单来源内容与关联巡查数据 |
| `POST` | `/:id/notes` | 追加处理记录 |
| `PATCH` | `/:id` | 更新状态、处理人等 |
| `PATCH` | `/:id/review` | 复核 |

迁移 `050_ticket_comment_record_link.sql` 使工单可以追溯评论与作品；工单详情还应保留相关互动快照和巡查时间线，而不是只复制转单时的一份静态数据。

### 4.10 社交账号与每日负载 `/api/social-accounts`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/overview` | 账号、绑定 Agent、今日搜索/增强/采集负载 |
| `POST` | `/` | 新建账号资料 |
| `PATCH` | `/:id` | 修改账号、手机号、名称、限额等 |
| `POST` | `/:id/bindings` | 添加 Agent 绑定 |
| `PUT` | `/:id/bindings` | 替换账号的绑定集合 |
| `DELETE` | `/bindings/:id` | 删除绑定 |

自动识别是尽力而为机制，可能受平台 DOM 和登录页面状态影响。人工绑定和人工账号信息是最终依据，Extension 心跳不能擅自把未选择的 Agent 重新绑定回来。

### 4.11 AI、OCR、ASR 与前置筛选

相关路由族：

- `/api/relevance/prefilter`：Extension 列表页前置相关性筛选；
- `/api/opinion-analysis`：深度剖析；
- `/api/asr-media`：ASR 临时媒体；
- `/api/records/:id/transcribe`：发起视频转写；
- `/api/records/:id/image-text`：OCR 结果。

Extension 前置筛选采用 fail-open：

1. 确定性规则先筛选；
2. 候选进入 DeepSeek 批处理；
3. 只有高置信度“不相关”才跳过；
4. 未配置 DeepSeek、超时、限流或服务异常时继续采集。

因此“勾选 AI 精准筛选”不保证每条作品都能看到 AI 请求；应结合任务事件、前置筛选账本和服务端日志判断是否实际调用。

### 4.12 其他后台路由族

| 路由族 | 用途 |
|---|---|
| `/api/admin` | 平台管理、租户、激活码、测试邮件、维护操作 |
| `/api/user` | 用户和成员相关操作 |
| `/api/issues` | 舆情事件 |
| `/api/reports` | 报告生成、预览和发送 |
| `/api/workspace` | 徽标、处理进度、工作台总览 |
| `/api/analytics` | 数据看板与分析 |
| `/api/content` | 内容创意工作区 |
| `/api/keyword-analysis` | 关键词分析 |
| `/api/keyword-opportunity` | 关键词机会 |
| `/api/benchmark-discovery` | 对标发现 |

这些模块的读请求要求有效租户访问；写请求通常还要求租户写角色。平台级操作额外要求平台管理员。

## 5. 调用示例

### 5.1 查询租户工作台

```http
GET /api/workspace/overview
x-session-token: <session-token>
x-tenant-id: <tenant-id>
```

### 5.2 查询任务快照

```http
GET /api/capture-cloud/tasks/<task-id>/snapshots?limit=100
x-session-token: <session-token>
x-tenant-id: <tenant-id>
```

默认返回最近快照，最大限制由服务端保护。重复快照按指纹去重，旧尝试不会进入有效当前态。

### 5.3 显式转工单

```http
POST /api/tickets
x-session-token: <session-token>
x-tenant-id: <tenant-id>
Content-Type: application/json

{
  "recordId": "<record-id>",
  "priority": "normal",
  "note": "已私信，需要持续跟踪"
}
```

## 6. 开发与发布校验

修改接口时至少完成：

1. 更新服务端路由和服务层；
2. 增加或调整契约测试；
3. 检查租户隔离、写权限和 Agent 身份；
4. 检查幂等、重试、迟到写回与终态吸收；
5. 更新管理后台或 Extension 调用方；
6. 更新本文及相关业务文档；
7. 执行迁移和构建验证。

建议验证：

```bash
find tests -name '*.test.mjs' -print0 | xargs -0 node --test
cd web/admin && npm run build
cd server && npm run migrate
```

Extension 相关接口还应执行：

```bash
scripts/sync-extension-build.zsh local
node tests/capture/extension-snapshot.browser.mjs
scripts/package-extension.zsh
```

生产发布流程和回滚要求见：

- [`开发运行与生产发布手册.md`](./开发运行与生产发布手册.md)
- [`数据库与迁移说明.md`](./数据库与迁移说明.md)
- [`故障排查与验收清单.md`](./故障排查与验收清单.md)
