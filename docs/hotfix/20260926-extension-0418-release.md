# Extension 0.4.18 发布记录（20260926）

分支 `codex/release-extension-0418-20260926`，发布提交 `fe74ec5`，基线为生产 `b986d71`。本次发布包含：

- `606a443`（`codex/hotfix-targeted-post-runner-lost-20260926`）：定向作品任务的运行页关闭后，由后台代为结束任务、回报服务器并释放本机采集锁。说明见 [20260926-targeted-post-runner-lost.md](20260926-targeted-post-runner-lost.md)。
- `483cbf5`：合并手机 Runner 0.2.3–0.2.5（`4234478`、`be4c577`、`3d214e8`）。只改 `runners/android/`，手机已经在跑 0.2.5（`runtime-0.2.5-3d214e8`），服务器不用为它部署。说明见 [20260926-android-ui-recovery.md](20260926-android-ui-recovery.md) 和 [20260926-android-sparse-results.md](20260926-android-sparse-results.md)。
- `fe74ec5`：发布 Extension 0.4.18，改了以下四处：
  - `manifest.json` 的版本号；
  - `server/routes/update-manifest.js`：最新版本、下载地址和更新说明；
  - `server/public/about.html`：更新日志；
  - `server/services/ops-control.js`：运维基线。

`b986d71..fe74ec5` 中，除 Runner、文档和测试外只改了 5 个文件：

- `background.js`、`manifest.json`：打进扩展包。
- 上面三个服务端文件：由部署脚本替换。

无数据库迁移，Admin 不变。

## 验证

| 项目 | 结果 |
| --- | --- |
| CI（发布分支，run 36247249538） | 5/5 通过：Tests and builds、Production Node 18、PostgreSQL 14/16 × Node 18/24 |
| 更新清单与运维测试 | Node 24 和 Node 18.20.8 都是 31/31 |
| 后台与全量单元测试 | 见 `606a443` 的说明 |
| 扩展包 | `StarVoice-extension-v0.4.18-20260926.zip`，SHA-256 `6faddb2ed0e977178b0fd169560dedf927828d5fc5ddcdcd87c88d9f6d3bac36`，1348990 字节，102 个文件。<br>从发布提交的干净导出打包，与源码逐字节一致。<br>目标为 production（`https://voice.minilife.online`），不含密钥、安装包或环境文件 |
| 部署脚本演练（模拟生产目录，Node 18.20.8） | 只读预检、正常发布均通过。<br>文件漂移、0.4.18 包已存在、锁被占用时，拒绝且不改任何文件。<br>部署中收到 SIGTERM、重启后就绪检查失败时，自动回滚：恢复三份文件并重启，删除 0.4.18 包。回滚后预检再次通过 |
| 生产只读预检（22:04，`deploy.sh --check`） | 通过：包完整，三份文件与 `b986d71` 一致，`update-manifest` 仍为 0.4.17，0.4.18 包尚未发布，服务就绪 |

## 发布

### 本机节点 `extension-build/`（22:14 已完成）

主工作区的 `extension-build/` 已由 0.4.17 原地换成 0.4.18：

- **加载它的节点**：本机所有 Chrome 配置，以及 Edge 的 Profile 5（西瓜）和 Profile 3。
- **换之前**：确认目录与 0.4.17 包完全一致，即 `background.js`、`manifest.json` 与 `b986d71` 相同，其余 100 个文件与 0.4.18 包相同。然后整目录备份到 `extension-build.rollback-v0417-before-fe74ec5`，逐文件核对，共 102 个。
- **替换**：只换 `background.js` 和 `manifest.json`，每个文件先写临时文件再改名。换完与 0.4.18 包 `diff -r` 无差异。
- **侧栏页面和内容脚本**：两个版本逐字节相同，所以在节点重载之前，不会出现新旧文件混用。
- **生效方式**：各节点手动重载扩展后才生效。
  - 服务器还宣告 0.4.17 时，侧栏把已安装 0.4.18 视为最新，不会提示。
  - 运维快照暂时不把这些节点计入基线版本节点数（`baselineCurrent`），只影响计数，不触发任何动作。

### 服务端（待执行）

部署材料已上传到 `/opt/onstarvoice-private/releases/extension-0418-fe74ec5-20260926/`：

- `server.tar.gz`：SHA-256 `124deddb7bd8ffe06c25e80bef73ed34c67891b3ac0be95906f2d1f83737aa51`。
- `deploy.sh`：SHA-256 `a53295de7eea6047e602c521656ddf3ebfc3183390cd67f914b730bc1a483c3b`。

CI 通过后，本会话连不上生产 SSH：权限策略要求用户在对话里点名生产主机，所以正式部署还没有执行。执行方式：

```bash
ssh root@47.103.125.200 'cd /opt/onstarvoice-private/releases/extension-0418-fe74ec5-20260926 && bash deploy.sh --check && bash deploy.sh'
```

`deploy.sh` 依次执行以下步骤：

1. 重新预检并加锁。
2. 解包并逐文件核对哈希。
3. 备份三份文件。
4. 先放入 0.4.18 包，再原子替换三份文件，然后 `pm2 restart onstarvoice`。
5. 核对以下各项：
   - `health/ready`、`health/live` 通过；
   - 进程确实已重启；
   - 磁盘上的文件就是本次发布的版本；
   - `/api/update-manifest` 宣告 0.4.18；
   - 新包下载后与上面的 SHA-256 逐字节一致；
   - 0.4.17 包仍可下载；
   - `public-downloads/` 恰好多出新包一个文件；
   - `/changelog` 显示 0.4.18。
6. 最后经公网再下载一次新包比对，这一步只提示，不回滚。

任何一步失败都会自动回滚。

部署后另行查看：

- 错误日志自部署起的新增行，看有没有模块加载错误。`DB_CAPACITY_UNAVAILABLE` 以部署前的增速为准。
- 在线节点的心跳是否在 2 分钟内恢复。

## 节点重载

- 重载会中断该浏览器配置里正在跑的采集，请在节点空闲或停稳后进行。
- 西瓜优先。那条卡住的「手机发现作品补详情」（作品 7689644539300486906）在重载约 2 分钟后，会被自动结束为「已停止」并上报，不需要手动处理。
- 其他电脑上的节点：服务端部署后，用侧栏的更新提示或下载地址升级。

## 回滚

- **服务端**：
  - 部署失败时脚本自动回滚。
  - 手动回滚：用发布目录 `backup/server/…` 下的三份文件覆盖回原位，`pm2 restart onstarvoice`，确认就绪后删除 `public-downloads/StarVoice-extension-v0.4.18-20260926.zip`。
- **本机扩展**：

  ```bash
  rsync -a --delete extension-build.rollback-v0417-before-fe74ec5/ extension-build/
  ```

  在主工作区执行，然后逐个节点重载。
- **手机 Runner**：不受本次发布影响。回滚方法见 0.2.5 的说明。
