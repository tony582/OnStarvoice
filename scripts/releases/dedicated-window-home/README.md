# 专用采集窗口归位 Hotfix 0.4.22 发布器

本目录只保存发布器源码和本地模拟测试，不包含生产基线或可直接部署的 stage。发布基线必须是完整提交 `03a2278ea09eb85b15859744c24b36431c6fcdc4` / Extension `0.4.21`；新版本为 Extension `0.4.22`。Android Runner 保持 `0.2.6`，无需安装新版本。本发布器不操作浏览器或手机。

唯一允许写入的四个生产文件，固定顺序为：

1. `public-downloads/StarVoice-extension-v0.4.22-YYYYMMDD.zip`，新增。
2. `server/public/about.html`。
3. `server/services/ops-control.js`，仅允许 `OPS_CONTROL_RUNTIME_BASELINE_VERSION` 从 `0.4.21` 改为 `0.4.22`。
4. `server/routes/update-manifest.js`。

`release.json.files` 的排序不能改变这个顺序。不替换服务端采集代码，不安装依赖、不构建 Admin、不迁移或写数据库、不修改环境配置。数据库访问仅用于发布前的只读任务计数。生产运行时必须为 Node `18.20.8`、唯一在线 PM2 进程 `onstarvoice`、入口 `/opt/onstarvoice/server/index.js`。成功发布重启该进程一次；切换失败则恢复旧文件并再次重启验收。

## Stage 与只读基线证据

每次正式发布生成全新 stage，置于生产目录之外，例如 `/opt/onstarvoice-private/releases/dedicated-window-home-<short-sha>-20260928/`。目录、文件及父目录不能经过符号链接。

- 从本目录原样复制 `deploy.sh`、`deploy.mjs`；发布器没有额外模块依赖。
- `payload/` 只能包含上述四个文件。新 zip 必须尚不存在；三个元数据文件必须已有匹配旧摘要。
- `release.json` 记录完整 SHA、全部文件的新旧摘要、只读 guards 和 `.env` 摘要。摘要均为 SHA-256 小写十六进制；不得收集环境值。
- `ci.json` 使用 `gh run view <run-id> --json headSha,status,conclusion,jobs` 的原始结果，不手写生产成功证据。
- `SHA256SUMS` 包含 stage 所有初始文件（不含清单自身）；上传后先核对该清单。不得夹带旧 backup 或收据。

`release.json` 结构示例（占位摘要必须替换为经核实的证据）：

```json
{
  "baseHead": "03a2278ea09eb85b15859744c24b36431c6fcdc4",
  "sourceHead": "<40-character exact release commit SHA>",
  "version": "0.4.22",
  "androidVersion": "0.2.6",
  "previousZip": "StarVoice-extension-v0.4.21-20260928.zip",
  "zip": "StarVoice-extension-v0.4.22-20260928.zip",
  "environmentSha": "<verified baseline server/.env SHA-256>",
  "files": [
    {"path":"server/routes/update-manifest.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/public/about.html","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/services/ops-control.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"public-downloads/StarVoice-extension-v0.4.22-20260928.zip","oldSha":null,"newSha":"<new>"}
  ],
  "guards": [
    {"path":"server/index.js","sha":"<baseline>"},
    {"path":"server/app.js","sha":"<baseline>"},
    {"path":"server/package.json","sha":"<baseline>"},
    {"path":"server/package-lock.json","sha":"<baseline>"},
    {"path":"server/db/migrate.js","sha":"<baseline>"},
    {"path":"server/routes/capture-cloud.js","sha":"<baseline>"},
    {"path":"server/services/capture-cloud.js","sha":"<baseline>"},
    {"path":"server/services/capture-discovery/detail-dispatch.js","sha":"<baseline>"},
    {"path":"server/services/capture-discovery/detail-projection.js","sha":"<baseline>"},
    {"path":"server/services/capture-discovery/detail-timeout-cooldown.js","sha":"<baseline>"},
    {"path":"public-downloads/StarVoice-extension-v0.4.21-20260928.zip","sha":"<baseline>"},
    {"path":"web/admin/dist/index.html","sha":"<baseline>"}
  ]
}
```

以上 guards 仅为结构示例。完整清单还必须包含 `server/routes/` 和 `server/services/` 下全部 `.js`、`.mjs`、`.cjs`（排除本次两个允许替换的 JS 元数据文件），以及 `web/admin/dist/` 下全部文件。发布器同时比较完整文件清单和逐文件摘要；遗漏、新增或改动均拒绝。可追加其他只读 guards。旧摘要必须来自已核实的基线；不能用漂移后的现场值重生成以绕过拒绝。`environmentSha` 必填，并与发布前后 `.env`、PM2 环境摘要分别核对。

Admin 的 `._assets`、`._文件名` 等隐藏元数据仍须保留在磁盘 guards。HTTP 仅验证相对路径各段均不以 `.` 开头的公开文件，避免把 Express 不公开的元数据误当 HTTP 资源。正式发布在任何备份或切换前，先从本机和公网验证旧 zip、changelog 和全部公开 Admin 文件的 HTTP 摘要。

CI 必须对应完整 `sourceHead`，整体已完成且成功，恰有以下五个完成且成功的 job：

1. `Tests and builds`
2. `Production Node 18 compatibility`
3. `PostgreSQL 14 / Node 24.12.0 integration`
4. `PostgreSQL 16 / Node 18.20.8 integration`
5. `PostgreSQL 16 / Node 24.12.0 integration`

本地演练可用 `rehearsalOnly: true` 和明确的模拟 CI 结果；这种 stage 禁止用于生产。正式包须从已通过 CI 的精确提交重新导出。

## 本地模拟

使用 Node `18.20.8`。本机现有路径为 `/Users/dulaidila/.nvm/versions/node/v18.20.8/bin/node`。测试自动在临时目录生成独立模拟基线和 stage，结束后删除，不访问生产或数据库：

```sh
/Users/dulaidila/.nvm/versions/node/v18.20.8/bin/node --test scripts/releases/dedicated-window-home/deploy.test.mjs
```

手工演练的镜像目录名必须以 `simulation-` 开头，stage 必须位于镜像之外。每个已切换场景使用新 stage；macOS 临时路径用 `/private/tmp/` 避免 `/tmp` 符号链接。

```sh
node deploy.mjs --simulate /private/tmp/simulation-check --check
node deploy.mjs --simulate /private/tmp/simulation-success
node deploy.mjs --simulate /private/tmp/simulation-mid-switch --fail=mid-switch
node deploy.mjs --simulate /private/tmp/simulation-readiness --fail=readiness
node deploy.mjs --simulate /private/tmp/simulation-busy --idle=busy
node deploy.mjs --simulate /private/tmp/simulation-held --idle=held
node deploy.mjs --simulate /private/tmp/simulation-unknown --idle=unknown
```

模拟 PM2、HTTP 和空闲计数不执行外部动作；白名单、摘要、完整备份、原子替换和回滚走正式逻辑。测试另外抽取真实生产 HTTP/空闲函数，用只读替身验证本机和公网检查、隐藏元数据边界、SQL 及超时。

正常场景退出 `0`，`deployed.json` 记录严格四文件顺序。`mid-switch` 在 zip 和 about 切换后故障；`readiness` 在四文件切换并首次重启后故障。二者退出 `1`，生成 `rollback.json` 且 `restored: true`，三个旧元数据、旧包、Admin、guards 和环境完全恢复，新包删除。基线漂移、额外文件、缺 guard、CI 不符均应在切换前拒绝。

## 经授权后的执行与空闲闸门

1. 核对完整发布 SHA、原始五项 CI 结果和 `sha256sum -c SHA256SUMS`。
2. 在 stage 运行 `bash deploy.sh --check`。该步骤只读且不要求任务空闲；验证范围、旧新摘要、完整 guards、旧清单 `0.4.21`、Node/PM2/环境、本机和公网 ready/live，以及旧包/changelog/Admin 的双源 HTTP 摘要。漂移即停止。
3. 外部主发布流程先取得 `activeTasks=0` 和 `androidHeldItems=0`，间隔至少 30 秒再确认双零，保留证据后执行 `bash deploy.sh`。发布器先完成只读 HTTP 预检，再取得独占锁、最终核对基线并立即读取最新双计数。通过之前不创建备份、不写入 payload、不重启。
4. 通过内部闸门后备份三个旧文件，按 zip → about → ops → manifest 原子替换，并以不带 `--update-env` 的 PM2 restart 重启。验证新 PID/启动时间、原 Node/入口/环境、全部新摘要、guards、`.env`、本机和公网 ready/live、更新清单 `0.4.22`、新 zip/changelog/Admin HTTP 摘要后才写 `deployed.json`。
5. 发生切换后错误即逆序恢复，删除本次新 zip，重启并核验旧清单 `0.4.21`、旧文件/包/HTTP/guards/环境/健康，写入 `rollback.json`。回滚存在未验证项会明确 `restored: false`，不得篡改原收据；外部并发修改会拒绝覆盖并报告。

内部计数沿用 0.4.21 口径：`activeTasks` 为分配节点五分钟内仍存活且状态在 claimed/running/recovering/resume_requested 的任务；`androidHeldItems` 为 Android 节点下 `deviceHeld=true` 的任务项。独立 Node 18 子进程使用服务端现有 pg/dotenv 和配置，执行 `BEGIN READ ONLY`、两条 COUNT、`ROLLBACK`，只输出时间和双计数。连接 3 秒、语句 3 秒、驱动查询 4 秒、整个子进程 15 秒硬截止，不输出连接错误或环境值。

任一计数非零：`IDLE GATE BUSY`、退出 `78`。结果未知、超时、不合法或过期：`IDLE GATE UNKNOWN`、退出 `1`。二者均无 backup、before/deployed/rollback 收据或重启；忙碌拒绝后的未使用 stage 可在后续重新证明空闲后再运行。`--fail` 与 `--idle` 只允许模拟模式，生产不能借此绕过闸门。

内部观察不能替代外部间隔 30 秒的双零证据，也不是数据库派发锁；通过后仍存在很短的接单竞态。本发布器不暂停接单或改任务状态，须在授权的空闲窗口执行。

## 收据与重复执行

`before.json`、`deployed.json`、`rollback.json` 均独占创建，不覆盖。stage 只要已有 backup 或任一收据，就在任何生产动作前拒绝重用；保留原文件、原备份和原故障原因。已成功和已回滚场景的重复执行均退出 `1`，不会再次重启或改写文件。重新发布必须建立经过审阅的新 stage。

before/deployed 收据保留最终双计数；deployed/rollback 收据保留实际切换顺序。常规可捕获错误和 TERM/INT/HUP 会触发回滚；断电或 SIGKILL 无法捕获。恢复时保留锁、stage 和备份，核对实际状态后处置，不能删锁后盲目重跑。

模拟不等同于生产 PM2、公网缓存或浏览器验收；服务器发布成功也不能证明已有浏览器已经升级。
