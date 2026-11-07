# 无人值守自愈 0.4.32 上线记录

用户批准「部署到 47.103.125.200」。2026-11-07 12:51:36（北京时间）服务端修复与扩展安装包发布成功。方案与实现见[方案](20261107-unattended-self-heal-plan.md)。

## 发布身份与范围

- 分支 `codex/feat-unattended-self-heal-20261106`，发布源码提交 `c06fdabf11646275b0232a1afe0add1a72c6be0d`。0.4.31 从未单独发布，其收尾修复包含在 0.4.32 里。
- [CI 42338687034](https://github.com/tony582/OnStarvoice/actions/runs/42338687034) 5/5 成功：tests/builds、生产 Node 24 兼容性、PG14/Node24.12.0、PG16/Node24.12.0、PG16/Node24。
- [0.4.32 下载包](https://voice.minilife.online/downloads/StarVoice-extension-v0.4.32-20261107.zip)：116 个文件，与发布提交逐字节一致。SHA-256 `1c6d05800e3cb42941039c893cdf3a84a7d03520be204e2eb9e98d05944a1b93`。
- 最低支持版本仍为 `0.3.51`，旧节点不受阻断。0.4.30 安装包保留。
- 发布工具 `scripts/releases/self-heal-0432/deploy.mjs`。新建 3 个文件，替换 11 个文件，重启 api 和 scheduler。未做数据库迁移、依赖安装或配置变更。

```text
新建  server/services/capture-agent-platform-health.js
新建  server/services/capture-keyword-repair.js
新建  server/services/capture-discovery/auto-retry.js
替换  server/services/capture-discovery/detail-dispatch.js
替换  server/services/capture-discovery/detail-lifecycle.js
替换  server/services/capture-discovery/detail-projection.js
替换  server/services/capture-discovery/detail-receipt.js
替换  server/services/capture-cloud.js
替换  server/routes/capture-cloud.js
替换  server/routes/sync.js
替换  server/app.js
替换  server/services/ops-control.js
替换  server/public/about.html
替换  server/routes/update-manifest.js
```

## 发布前核验

- 12:25 只读核对：11 个待替换文件的 SHA-256 与 0.4.30 发布源码 `618125f` 一致；3 个新文件和 0.4.32 安装包都不存在。
- 发布工具预检（12:50）与正式发布都核验了 279 个保护文件：生产环境配置、包描述、管理前端全部 273 个文件、0.4.30 安装包，以及 WeChat 热修复的两个文件。
- 发布前无活动叶子任务、无待处理命令、无 Android 持有项。scheduler 停止后再次核验空闲，才替换文件。

## 上线验收

- 公开 update-manifest 为 0.4.32；公开下载 ZIP 的 SHA-256 与构建包一致；公开健康检查返回 ok。
- api PID `1111450 → 1152329`，scheduler PID `1111474 → 1152352`，两者都输出本次启动的 `ProcessRuntime role=… ready`。ai-media（`1067152`）和 MiniLife（`6225`）未变化。
- 抽查的 5 个已发布文件哈希与发布内容一致，权限与同目录旧文件相同。
- API 错误日志最后写入时间仍是 08:58，早于发布，重启后没有新的错误输出；scheduler 错误日志为空。
- 12:53 数据库快照：阻塞会话 0，超过 30 秒的事务 0。当时有 3 条运行超过 10 秒的语句，12:54 复查时已为 0。

发布回执（before/check/published）保存在主工作区 `outputs/unattended-self-heal-20261106/release-receipts/`。

## 节点升级与验收边界

12:54 最近 15 分钟活跃的节点：16 个浏览器为 0.4.30，1 个为 0.4.29，1 个 Android 为 0.2.0。安装包发布不会自动升级扩展。

- **立即生效（服务端）**：坏节点按平台暂停自动领取；手机补详情自动换节点重试；数据库忙在服务端返回可重试的 `server_busy` / 503。
- **要升级到 0.4.32 才生效**：失败帖子换节点补采（旧节点不会领补采任务，等满 60 分钟后才允许旧节点兜底）、上传繁忙自动补传、退役回执不再重发。
- 上线时没有活动任务，新规则尚未在真实批次中触发。真实效果按方案验收：连续观察 3 轮日常巡检，「需要处理」只剩登录或验证码类，每个失败帖子都有去向。
