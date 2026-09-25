# 停稳锁闭环与手机 Runner controlError 合并发布记录（20260925）

分支 `codex/release-stopfence-android-20260925`，合并提交 `9b836f6`，基线为生产 `68c32ba`（+ 文档 `f069fd7`）。本次上线两条线：

- `5d7440c`（`codex/hotfix-stop-fence-closure-20260925`）：停稳锁闭环的服务端与后台部分。说明见 [20260925-stop-fence-closure.md](20260925-stop-fence-closure.md)。扩展 0.4.16 的代码在此提交中，但**不发布版本**：`manifest.json`、`update-manifest.js`、`about.html`、运维基线版本号保持 0.4.15，生产继续宣告 0.4.15。
- `407dbe2`、`45c049b`（`codex/hotfix-android-control-error-20260925`）：手机 Runner 恢复应答后清除残留的 `controlError`；空闲时控制轮询退避可增长、忙时保持首档。

同一 hotfix 分支上另有两个提交**本次不上线**：`17351b2`（关键词节点覆盖不再无证据放行，需等 each_agent 节点都升级 0.4.16）、`4ed2a99`（发布 0.4.16 版本，试点稳定后再发）。无数据库迁移。

## 验证

| 项目 | 结果 |
| --- | --- |
| CI（发布分支，run 36127693368） | 5/5 通过（Tests and builds、Production Node 18、PostgreSQL 14/16 × Node 18/24） |
| 老节点等价（临时库、真实路由、26 步场景，0.4.14/0.4.15 节点） | 心跳、派发、停止、恢复、巡查与 `f069fd7` 逐项一致；仅多出新增字段、人工放行接口与审计事件 |
| 生产只读实测（7344 条任务） | 0.4.16 节点心跳预检约 20 ms；租户级围栏列表约 255 ms；围栏判定 SQL 约 275 ms（线上已有）。据此撤下「重试候选排除被挡节点」，批次详情轮询与上线前相同 |
| 本地目标套件（Node 18） | 648/648；PostgreSQL 集成（stop-fence-closure、keyword-account-coverage、orchestration-retry-waiting）44/44 |
| Admin 构建 | `tsc -b && vite build` 通过；用同一工具链重建 `68c32ba` 与生产 11 个文件逐字节一致 |
| 部署脚本演练 | 模拟生产目录：预检通过；文件漂移、新文件已存在、宣告版本变化均拒绝；正常发布；重复执行拒绝；就绪失败、资源不符、重启中 SIGTERM 均自动回滚并删除新增文件 |
| 手机 Runner | Node 24 串行 182/182；新运行目录与 `runtime-0.2.2-5cb5f91` 仅 `src/daemon/runtime.mjs` 与一个测试文件不同 |

## 发布（2026-09-25，Asia/Shanghai）

### 服务端与 Admin（47.103.125.200）

- 预检：要替换的 5 个服务端文件与 `68c32ba` 逐字节一致，`server/services/capture-stop-fence.js` 不存在，Admin `index.html` 为 0.4.15 发布的版本，`/api/update-manifest` 为 0.4.15。
- 19:43:09 切换并重启 PM2 `onstarvoice`，新 PID 444668；`health/ready` 通过。
- 替换：`server/routes/capture-cloud.js`、`server/routes/capture-orchestrations.js`、`server/routes/negative-patrol.js`、`server/services/capture-cloud.js`、`server/services/ops-control.js`；新增 `server/services/capture-stop-fence.js`；Admin 新增 6 个哈希资源并切换 `index.html`（`8161b52f…`）。`public-downloads/` 与更新清单未改动。
- 部署后核对（约 3 分钟）：公网 `/api/update-manifest` 仍为 0.4.15，`/admin/` 200；错误日志自部署起**无新增行**，`DB_CAPACITY_UNAVAILABLE` 累计仍为 6736；12 个在线节点心跳在切换后 2 分钟内全部恢复。

发布材料与备份：`/opt/onstarvoice-private/releases/stopfence-android-9b836f6-20260925/`。

### 手机 Runner（本机）

- 19:45:55 旧 Runner（PID 78267，`runtime-0.2.2-5cb5f91`）空闲：无在途任务、待上传 0；SIGINT 后 2 秒停稳，`deviceClosureRequired=false`。
- 用 `runtime-0.2.2-45c049b/launcher/StarVoice 手机采集.command` 启动，新 PID 45749，状态目录仍为 `state-829d89`；启动后 `controlError` 为空（旧版会一直显示服务端重启留下的 `cloud_http_502`），手机息屏（`device_asleep`），亮屏解锁后自动就绪。

## 发布时发现的情况

- 本机 Chrome 在 13:59 重启后没有打开任何窗口（后台模式），成都、北京、上海、重庆等 Chrome 节点自约 14:00 起无心跳；霸王龙（Edge）自 13:52 起无心跳。与本次部署无关，重新打开对应配置的窗口即可恢复。

## 后续

1. 0.4.16 试点：扩展清单没有 `key`，解包加载时扩展 ID 由目录决定，换目录会变成一个全新节点。因此试点必须在该节点**原目录内**替换文件后重载（再重启浏览器）。本机所有 Chrome 配置共用主工作区 `extension-build/`，在这里换成 0.4.16 会让本机所有配置在下次重载时一起升级，不适合单节点试点；建议挑一台 Windows 节点原地替换。安装包：`StarVoice-extension-v0.4.16-20260925.zip`，SHA-256 `11034af13e592fc69af213b0ea3a4efff24d19b3a40e3ee2845d009e57f3eca4`。
2. 试点稳定后发布 `4ed2a99`（版本 0.4.16），各节点铺开后再发布 `17351b2`（覆盖修复）。

## 回滚

- 服务端与 Admin：用发布目录 `backup/` 下的 5 个文件和 `backup/admin/index.html` 覆盖回原位置，删除 `server/services/capture-stop-fence.js`，再 `pm2 restart onstarvoice`。已放行的记录保持不变（与手工放行同格式，有事件与审计）。只想停掉自动核对：`CAPTURE_STOP_FENCE_AUTO_CHECK=off` 后重启。
- 手机 Runner：关闭新 Runner 窗口（自动停稳），双击 `runtime-0.2.2-5cb5f91/launcher/StarVoice 手机采集.command`。
