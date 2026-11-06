# 采集可靠性 0.4.30 上线记录

用户已批准部署。2026-11-06 13:16:34（北京时间），限定的服务端修复与扩展安装包发布成功。服务端锁顺序修复已生效；浏览器节点仍需升级扩展，才能使用阶段结果复用与有界增强重试。

## 发布身份与范围

- 分支：`codex/fix-capture-locks-enhancement-20261106`。
- 实际发布源码提交：`618125f6f2966a2aaa8429c2e38718833530758d`。后续文档、发布工具提交不改变本次发布的源码身份。
- [0.4.30 下载包](https://voice.minilife.online/downloads/StarVoice-extension-v0.4.30-20261106.zip)，1,447,785 字节，116 个文件。
- ZIP SHA-256：`61d05cc31029b6f05b1ffbb1929275876b418a5a5acdda213f8261af5fc18238`。
- 最低支持版本仍为 `0.3.51`，未阻断旧节点；旧版安装包保留。
- 仅替换下列 8 个服务端文件，重启 API 和 scheduler。未执行数据库迁移、依赖安装或配置变更。

```text
server/services/capture-health-schema.js
server/services/capture-cloud.js
server/services/capture-orchestration.js
server/services/capture-recovery-intents.js
server/routes/capture-cloud.js
server/services/ops-control.js
server/public/about.html
server/routes/update-manifest.js
```

扩展相较 0.4.29 新增 `utils/capture/enhancement-retry-session.js`，修改 `background.js`、`manifest.json`、`sidebar/sidebar-logic.js`、`utils/capture-sync.js`、`utils/capture/enhancement-retry.js`、`utils/unattended-keyword-run.js`，无文件删除。阶段复用、重试预算和耗尽原因上报均依赖更新后的扩展。

## 测试与上线验收

- 发布源码对应 [GitHub Actions 42166320432](https://github.com/tony582/OnStarvoice/actions/runs/42166320432) 的 5 组检查全部成功：tests/builds、生产 Node 24 兼容性、PG14/Node24.12.0、PG16/Node24.12.0、PG16/Node24。
- 本地完整 Node 回归 3,483/3,483；版本与下载相关检查 61/61；发布/回滚模拟 10/10。此前本地 PostgreSQL 时钟 fixture 失败及修正记录保留在[代码验证记录](20261106-capture-locks-enhancement.md)，修正已包含在本次绿色 CI 的源码中。
- 发布前无活动叶子采集任务、待处理命令或 Android 持有项；调度器停止后再次核验空闲才替换文件。未启动真实采集任务进行验收。
- API 与 scheduler 均输出本次启动的 `ProcessRuntime ... ready`，公开 readiness 返回 HTTP 200 / `ready`。
- 公开与本机 update-manifest 均为 0.4.30；公开下载 ZIP 的 SHA-256 与构建包一致。
- 上线后独立校验 8 个目标文件 SHA-256 与发布源码一致；281 个保护文件校验通过，包括生产环境配置、包描述、管理前端和当前 WeChat 热修复文件。
- API PID `1109317 → 1111450`，scheduler PID `1067187 → 1111474`；ai-media PID `1067152`、MiniLife PID `6225` 均未变化。运行时 Node `24.21.0`，进程环境与启动参数哈希未变化。

## 告警观察

API 重启后 stderr 曾写入 `DB_CAPACITY_UNAVAILABLE` / `general` / `queue_timeout`，最后写入时间为 13:16:51。该日志没有逐条时间戳，未记录发布前字节偏移，因此不把尾部所有历史报错计为本次新增，也不声称新错误为零。

13:19:08 的只读数据库快照：阻塞会话 0、运行超过 10 秒的查询 0、超过 30 秒的事务 0，其余 15 个连接均 idle。13:20:38–43 再次复核：API 与 scheduler 已稳定运行约 4 分钟、PID 未变化，API 错误日志大小与最后写入时间未变化，scheduler stderr 为空；阻塞、长查询和长事务仍均为 0，其余 11 个连接均 idle。数据库累计 deadlocks 两次均为 55，是历史累计值，这两个快照间没有新增。原始结果见本地 `postflight-final.json` 与 `db-postflight-final.json`。

独立代码复核未发现新连接泄漏：执行槽和事务连接均在 finally 释放，新锁顺序复用同一事务，命令回执仍走 critical 通道。general 队列超时发生于进程内执行槽排队，数据库有 idle 连接并不能排除该拥塞。现有证据不足以给重启后的短暂告警归因，保留为后续观测项。

短时健康验收不能证明后续采集错误率和尾部耗时已经下降；这些结果需要升级浏览器节点后的实际批次验证。

## 节点升级与验收边界

13:20 最终复核的最近 10 分钟活跃节点分布：17 个浏览器扩展仍为 0.4.29，1 个 Android 节点为 0.2.0。安装包发布不会自动升级现有扩展；Android 不在本次扩展升级范围。

旧浏览器可立即受益于服务端锁顺序修复，但不会执行新的阶段复用、10 分钟额外重试预算或新耗尽标记上报。未上报 `ENHANCEMENT_RETRY_EXHAUSTED` 的旧节点，不能视为已经受到完整的终止策略保护。

升级时应等待节点空闲且结果安全保存，在原扩展目录替换文件并重载，避免在同一浏览器并装第二份扩展。本次自动打开扩展管理页被浏览器安全策略拒绝，未通过替代通道绕过；本地已安装目录和远程节点均未自动更新。

10 分钟是首次额外增强重试开始后的累计窗口，不是首轮、整个关键词或批次的总时限。阶段缓存限于当前调用；浏览器刷新或崩溃发生在终态检查点保存前，仍可能重新进入采集。显式人工重试保留。真实小红书/抖音采集、下一轮耗时和错误率仍待节点升级后验收。

## 备份与证据

- 生产私有暂存与回执：`/opt/onstarvoice-private/releases/capture-reliability-618125f-20261106/`。
- 8 个替换文件的发布前副本：上述目录的 `backup/`，每个文件均按发布前 SHA-256 核验。
- 发布器持有排他发布锁，校验 CI 身份、基线、目标白名单与保护文件，逐文件保留权限并原子替换。失败时自动恢复本次改动；遇到外部并发变更则停止，不覆盖其他改动。回滚失败时保留新 ZIP，以免仍在服务的新 manifest 指向失效下载。本次发布成功，未触发回滚。
- 本地原始证据目录：`outputs/collection-release-20261106/`，含 `ci.json`、`release.json`、`published.json`、`postflight.json`、`db-postflight.json`、最终复核、包差异和测试日志。证据不包含环境变量明文。

本次未覆盖上传数量差异、评论空数据探测和 LLM 空轮询等后续优化。
