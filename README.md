# StarVoice 星语

StarVoice 是一套面向企业客户的多平台社交舆情采集、任务调度、智能研判与业务处置系统。系统由浏览器 Extension、云端服务、PostgreSQL、管理后台和独立数据看板组成，支持小红书、抖音等平台的内容采集、评论巡查、多 Agent 编排、负面帖子跟踪、官方账号评论巡查、社交账号负载管理以及工单闭环。

> 当前稳定基线：Extension `0.3.71`，数据库迁移至 `054_restore_iso_publish_timestamps.sql`。本文档描述的是当前 `main` 分支，不代表任何旧安装包或历史部署。
>
> “稳定基线”表示当前主链路已经形成可交接、可回归、可发布的版本锚点，不表示所有能力都已脱离 Beta。调度中心、多 Agent 接力、无人值守、平台风控识别和依赖页面 DOM 的采集仍需按客户环境逐项验收。

## 10 分钟重新接手

如果你第一次进入仓库，或隔了一段时间重新接手，按下面顺序操作：

1. 阅读 [文档总索引](docs/README.md)，确认你要处理的是 Extension、后台、服务端还是生产发布。
2. 阅读 [系统架构与稳定版交接手册](docs/系统架构与稳定版交接手册.md)，理解 Agent、任务、编排、租户和数据流。
3. 检查当前分支和工作区，任何已有未提交内容都默认属于当前开发者，不要清理或覆盖。
4. 本地开发先复制 `server/.env.example`，使用测试数据库和测试租户，不要直接连生产库。
5. 分别启动服务端与管理后台；需要验证独立看板时再启动 `web/dashboard`。
6. Extension 联调必须运行 `scripts/sync-extension-build.zsh local`，然后在浏览器扩展管理页重新加载 `extension-build/`。
7. 客户交付包只能通过 `scripts/package-extension.zsh` 生成；该脚本会重建并校验生产配置。
8. 修改任务、Agent、巡查或数据模型前，先阅读 [任务编排与状态模型](docs/任务编排与状态模型.md) 和 [数据库与迁移说明](docs/数据库与迁移说明.md)。
9. 发布前按 [开发运行与生产发布手册](docs/开发运行与生产发布手册.md) 完成备份、迁移、构建、重启、健康检查和冒烟验证。
10. 遇到异常先查 [故障排查与验收清单](docs/故障排查与验收清单.md)，不要用“清空任务”“强制迁移”或强制升级依赖作为第一反应。

## 系统组成

```text
客户浏览器
  └─ StarVoice Extension
       ├─ 平台页面解析与采集
       ├─ 本地任务账本与检查点
       ├─ Agent 心跳、命令领取与回执
       └─ 任务暗色运行页
              │ HTTPS
              ▼
StarVoice Node.js / Express 服务
  ├─ 登录、租户和权限
  ├─ 内容、评论、工单与报告 API
  ├─ 云端任务中心与多 Agent 编排
  ├─ 负面帖子、关注博主和官方账号评论巡查
  ├─ AI 筛选、舆情分析与通知
  └─ 静态管理后台、数据看板、媒体文件
              │
              ▼
PostgreSQL
  ├─ 业务内容与评论
  ├─ Agent、Command、Task、Attempt、Item、Event
  ├─ Orchestration、Allocation、Schedule
  ├─ Snapshot、舆情分析、社交账号用量
  └─ 工单、巡查和审计关联
```

## 核心概念

| 概念 | 含义 |
|---|---|
| 租户 | 数据、配置、Agent、任务和业务处置的隔离边界 |
| Agent | 一个浏览器配置文件中的一个 Extension 执行节点；真正的调度单元 |
| 设备 | 便于客户识别的展示分组；同一电脑可以有多个浏览器 Agent |
| Cloud Task | 一次浏览器侧采集执行的云端镜像 |
| Command | 云端发给指定 Agent 的持久化指令，如创建、继续、停止 |
| Work Item | 编排任务拆出的最小业务工作项，如一个关键词或一篇目标帖子 |
| Orchestration | 把一批工作项确定性地分配给一个或多个 Agent 的父任务 |
| Schedule | 一次性或无人值守任务的排期定义 |
| Snapshot | 帖子互动量、评论数和可用状态的只追加历史快照 |

一个物理电脑并不等于一个 Agent。Chrome、Edge、不同浏览器 Profile 各自安装并激活 Extension 后，都会成为独立 Agent；同一浏览器 Profile 的多个窗口仍共享同一个 Agent 和采集锁。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `server/` | Express 服务、API、数据库迁移、定时任务和后台处理 |
| `web/admin/` | 主管理后台：舆情工作台、调度中心、社交账号、分析与处置 |
| `web/dashboard/` | 独立数据看板 |
| `sidebar/`、`background.js`、`content-*.js`、`utils/` | Extension 源码 |
| `extension-build/` | Extension 的实际交付快照；客户加载和打包均以此为准 |
| `scripts/` | Extension 快照同步、客户包生成和辅助脚本 |
| `deploy/` | 生产发布脚本、Nginx 示例和生产环境变量示例 |
| `tests/` | 服务契约、任务编排、Extension 运行链和业务回归测试 |
| `docs/` | 架构、业务、运行、发布和排障文档 |
| `images/` | 产品和 Extension 使用的静态资源 |

## 本地快速启动

### 1. 服务端

```bash
cd server
cp .env.example .env
npm install
npm run migrate
npm run dev
```

默认服务端端口为 `3001`。请确保 `DATABASE_URL` 指向本地或明确授权的测试数据库。

### 2. 管理后台

```bash
cd web/admin
npm install
npm run dev
```

### 3. 独立数据看板

```bash
cd web/dashboard
npm install
npm run dev
```

### 4. Extension 本地联调

在仓库根目录执行：

```bash
scripts/sync-extension-build.zsh local
```

然后在 `chrome://extensions` 或 Edge 扩展管理页选择“加载已解压的扩展程序”，目录指向 `extension-build/`。源码变化后必须重新同步并 Reload；直接修改 `extension-build/` 会在下次同步时被覆盖。

## 构建、测试与交付

常用门禁：

```bash
cd web/admin && npm run build && npm run lint
cd web/dashboard && npm run build && npm run lint
find tests -name '*.test.mjs' -print0 | xargs -0 node --test
```

更完整的分层测试和发布门禁见 [开发运行与生产发布手册](docs/开发运行与生产发布手册.md)。

生成客户 Extension：

```bash
scripts/package-extension.zsh
```

该命令会重新构建生产快照、拒绝 `localhost` 配置并生成 `StarVoice-extension.zip`。不要把仓库根目录、源码目录或历史 CRX 当作当前客户包。

## 生产基线

- 生产域名：`https://voice.minilife.online`
- Nginx 上游：`127.0.0.1:3002`
- PM2 应用名：`onstarvoice`
- 服务目录：`/opt/onstarvoice`
- PostgreSQL 数据库：`onstarvoice`
- 管理后台：`/admin`
- 独立看板：`/dashboard`
- 健康检查：`/api/health`

现有 `deploy/deploy.sh` 不是原子发布：它只构建主管理后台，不构建独立 Dashboard；它不会自动创建生产备份，也会通过删除再启动 PM2 产生短暂中断。生产操作必须以 [开发运行与生产发布手册](docs/开发运行与生产发布手册.md) 为准。

## 文档入口

- [文档总索引](docs/README.md)
- [系统架构与稳定版交接手册](docs/系统架构与稳定版交接手册.md)
- [任务编排与状态模型](docs/任务编排与状态模型.md)
- [巡查业务工作流](docs/巡查业务工作流.md)
- [数据库与迁移说明](docs/数据库与迁移说明.md)
- [AI、账号识别与通知机制](docs/AI与通知机制.md)
- [API 接口文档](docs/API接口文档.md)
- [开发运行与生产发布手册](docs/开发运行与生产发布手册.md)
- [故障排查与验收清单](docs/故障排查与验收清单.md)
- [用户操作手册](docs/用户操作手册.md)
- [Extension 维护交接](docs/extension-maintenance-handoff.md)

## 稳定版边界

- 调度中心仍是 Beta 能力。多 Agent 分配、失败接力、无人值守和新巡查类型必须在目标平台、目标账号和目标 Extension 版本上完成受控验收后再扩大使用。
- 系统实现的是“云端保存业务状态和续跑”，不是迁移浏览器 Cookie、页面 DOM 或 Debugger 会话。
- Agent 离线时命令保留在云端，浏览器与 Extension 重新上线后再领取；无法唤醒关机电脑。
- 平台页面经常变化。采集成功必须以目标作品标识、云端写回和任务项状态为准，不能只凭“浏览器已打开详情页”判断。
- 列表页显示的发布时间可能不完整；官方账号巡查和严格日期过滤必须进入详情页确认。
- AI 超时、限流或失败不应阻塞原始采集数据落库；相关性筛选和舆情分析是两条独立链路。
- “帖子已删除”“筛选范围内没有内容”“搜索无结果”是业务结果，不应统一算作系统失败。
- 任何依赖安全扫描结果都必须带扫描日期、依赖链和实际暴露面，不能把历史数量当成永久结论，也不要直接执行强制升级。

## 商业软件

本项目为 StarVoice 商业产品。未经授权，不得复制、分发、部署或用于商业用途。

Copyright © 2026 StarVoice. All rights reserved.
