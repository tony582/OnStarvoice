# 0.4.15 与手机 Runner 0.2.2 合并发布记录（20260925）

分支 `codex/release-v0415-android-stability-20260925`，合并提交 `68c32ba`，基线为生产 `aff8fc9`（09-24 22:53 部署的手机并入普通调度版本）。本次把两条 hotfix 一起上线：

- `dcec6cb`（`codex/hotfix-xhs-assist-residue-20260924`）：Extension 0.4.15，回收停止后残留的采集辅助、自动搜索不再沿用小红书 AI 搜索页、时间筛选失败带原因后缀。说明见 [20260924-xhs-assist-residue-and-time-filter.md](20260924-xhs-assist-residue-and-time-filter.md)。
- `0ade11e`、`5cb5f91`（`codex/hotfix-android-stability-20260925`）：Runner 0.2.2，视频正文只点“展开”、连续 5 张异常才停词、本机诊断、双击启动器选 Node 24；服务端回执统计加 `skippedCards`，后台文案调整。说明见 [20260925-android-stability.md](20260925-android-stability.md)。

两条线自 `79ca6a9` 起改动的文件互不重叠；已核对合并结果恰为两边改动之和。无数据库迁移。

## 验证

| 项目 | 结果 |
| --- | --- |
| CI（合并分支，run 36084715803） | 5/5 通过（Tests and builds、Production Node 18、PostgreSQL 14/16 × Node 18/24） |
| CI（单独分支） | 手机分支通过；小红书分支只在 `runners/android/test/daemon-integration.test.mjs:77` 失败，与 `79ca6a9` 上 09-24 的失败相同，是基线已知时序问题，已由 `e08f868` 修复并包含在合并分支内 |
| Runner 全套（Node 24.12.0，串行） | 177/177；模块边界 87 个模块，最大 296 行 |
| Extension 目标套件 + 更新清单（Node 24 / Node 18.20.8） | 1008/1008 / 1008/1008 |
| 服务端与后台相关（android、capture-discovery、ops-control、调度展示） | Node 24 与 Node 18 各 119/119 |
| 生产 Node 18 语法检查（改动的 8 个 JS 文件） | 通过 |
| Admin `tsc -b && vite build` | 通过 |
| Extension 包 | `StarVoice-extension-v0.4.15-20260924.zip`，SHA-256 `d7422afc9aab6c6e27971a19d7e89537b87cd2420c19875913e3660182fe50af`；102 个文件与合并提交源码逐字节一致 |
| 部署脚本 | 在模拟生产目录中验证：预检通过、文件漂移时拒绝且不改任何文件、正常发布、重复执行被拒绝、重启后健康检查失败自动回滚 |

## 发布（2026-09-25，Asia/Shanghai）

### 手机 Runner（手机电脑）

- 10:12 旧 Runner 0.2.1（PID 17069，`runtime-0.2.1-7bf253b`）空闲，无在途任务；发送 SIGINT 后 2 秒停稳，设备锁已释放，待上传事件为 0。
- 升级前备份本机状态库：`StarVoice-Android/backups/runner-0.2.1-before-0.2.2-20260925T1012.sqlite`。
- 用 `runtime-0.2.2-5cb5f91/launcher/StarVoice 手机采集.command` 启动 0.2.2（PID 78267，Node 24.12.0，状态目录仍为 `state-829d89`）；启动后 `readyForSearch=true`，抖音在前台。

### 服务端与 Admin（47.103.125.200）

- 预检：生产上要替换的 4 个服务端文件和 Admin `index.html` 与 `aff8fc9` 构建逐字节一致；0.4.15 包此前未发布。
- 10:39:21 完成切换并重启 PM2 `onstarvoice`，新 PID 436241；`health/ready`、`health/live` 通过。
- 替换文件：`server/public/about.html`、`server/routes/update-manifest.js`、`server/services/ops-control.js`、`server/services/android-control/recovery.js`、`web/admin/dist/index.html`；新增 Admin 资源 5 个（按内容哈希命名，只增不删）；`public-downloads/` 新增 0.4.15 包。
- 部署后经公网核对：`/api/update-manifest` 为 `latestVersion 0.4.15`（`minSupportedVersion` 仍为 0.3.51，不强制升级），下载地址返回的包 SHA-256 与上面一致且 manifest 为 0.4.15；`/admin/` 返回新首页并能取到新脚本；`/changelog` 中 0.4.15 标为最新。
- 重启后日志：节点心跳、手机轮询、AI 中转请求均恢复。错误日志中的 `DB_CAPACITY_UNAVAILABLE`（数据库排队超时）为长期存在的现象（累计 5766 条），部署后 74 秒内新增 1 条，与平时一致；本次改动的文件不访问数据库。

发布材料、备份与前后对比：`/opt/onstarvoice-private/releases/v0415-android-stability-68c32ba-20260925/`（`backup/server/…`、`backup/admin/index.html`、`before-*`/`after-*`、`runtime.json`）。

## 发布时发现的情况

- 10:39:19 手机电脑 USB-C 2 号口上的手机（坚果 SDM845，即 DE106）断开，6 秒后同一口接入 Brother HL-2260D 打印机（macOS 内核日志）。Runner 随后报 `device_missing`，不会领任务。手机重新插回并确认 USB 调试授权后，Runner 会自动恢复就绪，无需重启。
- Runner 本机状态里的 `controlError` 只在出错时写入、成功后不清空：服务端重启窗口留下的 `cloud_http_502`（0.2.1 时常驻的 `cloud_timeout` 同理）会一直显示，不代表当前仍在失败。

## 后续

1. 各浏览器节点在任务结束或停稳后手动重载 Extension 到 0.4.15，成都机器优先；验收项见 0.4.15 说明「发布与回滚」第 4 条。
2. 手机插回后，跑完一晚执行 `node cli.mjs diagnose --state-dir ../state-829d89 --hours 12`，重点看 `expandOutcome` 和点击坐标是否需要校准。

## 回滚

- 服务端与 Admin：用发布目录 `backup/server/` 下的 4 个文件和 `backup/admin/index.html` 覆盖回原位置，再 `pm2 restart onstarvoice`。新增的 Admin 资源和 0.4.15 包不被旧文件引用，可保留。
- 手机 Runner：关闭 0.2.2 窗口（自动停稳），双击 `runtime-0.2.1-7bf253b/launcher/StarVoice 手机采集.command`（其 `launcher.json` 同样指向 `state-829d89`）；旧启动器可能解析到 Node 16 而报版本不符，此时在终端进入该目录执行 `nvm use 24 && node cli.mjs up --state-dir ../state-829d89`。状态库一般无需恢复。
- Extension：节点改回加载 0.4.14 包（`StarVoice-extension-v0.4.14-20260923.zip`）并重载。
