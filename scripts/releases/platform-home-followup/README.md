# 任务收尾与手机补详情 Hotfix 0.4.21 发布器

本目录只保存发布器源码。发布前生成独立、不可覆盖的 stage，不能直接在源码目录执行。生产基线为 `d68201d` / Extension `0.4.20`；本次发布 Extension `0.4.21`、对应更新说明和下载包，以及手机发现补详情的服务端终态投影与超时冷却。Android Runner 保持 `0.2.6`，本轮无需更新；本发布器不操作手机或浏览器。

服务端严格限定七个文件：替换五个旧文件，新增冷却模块和一个 zip：

- `server/routes/update-manifest.js`
- `server/public/about.html`
- `server/services/ops-control.js`，仅允许 `OPS_CONTROL_RUNTIME_BASELINE_VERSION` 从 `0.4.20` 改为 `0.4.21`
- `server/services/capture-discovery/detail-dispatch.js`
- `server/services/capture-discovery/detail-projection.js`
- `server/services/capture-discovery/detail-timeout-cooldown.js`，新增
- `public-downloads/StarVoice-extension-v0.4.21-YYYYMMDD.zip`，新增

不安装依赖、不构建或替换 Admin、不运行迁移、不写数据库或环境配置。数据库访问仅用于发布前的只读任务计数闸门。生产仍为 Node `18.20.8`、PM2 `onstarvoice`、入口 `/opt/onstarvoice/server/index.js`。发布会重启该进程一次；失败回滚后再次重启并验收。

## Stage 文件与证据

- `deploy.sh`、`deploy.mjs`：从本目录原样复制。
- `payload/`：只包含上面的七个文件，不能夹带其他文件或符号链接。
- `release.json`：示例结构如下。所有摘要为 SHA-256 小写十六进制；`sourceHead` 为真实完整提交 SHA。旧摘要和 guards 必须来自已核实的生产基线，不能用现场漂移后的值重新生成以绕过拒绝。
- `ci.json`：`gh run view <run-id> --json headSha,status,conclusion,jobs` 的原始结果，必须对应 `sourceHead`。不得手写生产 CI 成功证据。
- `SHA256SUMS`：stage 所有初始文件（不含本清单）的摘要，上传后先运行 `sha256sum -c SHA256SUMS`。不得把旧 backup 或部署结果装入新 stage。

```json
{
  "baseHead": "d68201d",
  "sourceHead": "<40-character exact release commit SHA>",
  "version": "0.4.21",
  "androidVersion": "0.2.6",
  "previousZip": "StarVoice-extension-v0.4.20-20260928.zip",
  "zip": "StarVoice-extension-v0.4.21-20260928.zip",
  "environmentSha": "<production server/.env SHA-256; values must not be copied>",
  "files": [
    {"path":"server/routes/update-manifest.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/public/about.html","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/services/ops-control.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/services/capture-discovery/detail-dispatch.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/services/capture-discovery/detail-projection.js","oldSha":"<old>","newSha":"<new>"},
    {"path":"server/services/capture-discovery/detail-timeout-cooldown.js","oldSha":null,"newSha":"<new>"},
    {"path":"public-downloads/StarVoice-extension-v0.4.21-20260928.zip","oldSha":null,"newSha":"<new>"}
  ],
  "guards": [
    {"path":"server/index.js","sha":"<baseline>"},
    {"path":"server/app.js","sha":"<baseline>"},
    {"path":"server/package.json","sha":"<baseline>"},
    {"path":"server/package-lock.json","sha":"<baseline>"},
    {"path":"server/db/migrate.js","sha":"<baseline>"},
    {"path":"public-downloads/StarVoice-extension-v0.4.20-20260928.zip","sha":"<baseline>"},
    {"path":"web/admin/dist/index.html","sha":"<baseline>"}
  ]
}
```

`guards` 还必须逐一列出生产 `web/admin/dist/` 的**全部文件**，包含 assets 等子目录；发布器同时验证完整文件清单和各文件摘要，新增或遗漏文件均拒绝。可追加其他只读基线 guards。`environmentSha` 可选；正式 stage 应填写，既核对已记录的环境基线，又比较发布前后 `.env` 和 PM2 环境摘要。收据只保存摘要，不保存环境值。

磁盘守卫也包括现有 `._assets`、`._文件名` 等隐藏元数据；不能从 guards 中删除这些文件。HTTP 校验只请求相对路径各段均不以 `.` 开头的公开文件，与 Express 静态资源的 dotfile 边界一致。发布前已验证旧版 zip、changelog 及全部公开 Admin 文件的本机/公网 HTTP 摘要；已有不可访问或内容不符的公开资源会在任何切换前拒绝。

CI 必须已完成并成功，而且恰好包含以下五个成功 job（名称必须一致）：

1. `Tests and builds`
2. `Production Node 18 compatibility`
3. `PostgreSQL 14 / Node 24.12.0 integration`
4. `PostgreSQL 16 / Node 18.20.8 integration`
5. `PostgreSQL 16 / Node 24.12.0 integration`

未提交的本地演练可设 `rehearsalOnly: true` 并使用明确的模拟 CI 数据；这种 stage 永远不能用于生产。正式包必须重新按已通过 CI 的完整提交 SHA 生成。

## 本地演练

使用 Node `18.20.8`，给每个场景准备独立 stage 与基线镜像。镜像目录名必须以 `simulation-` 开头；stage 必须位于镜像外。路径及所有父目录不能经过符号链接（macOS 临时文件用 `/private/tmp/`）。`--simulate` 模拟 PM2、HTTP 和空闲计数，文件白名单、旧新摘要、完整备份、原子替换和回滚均走正式逻辑。

```sh
bash deploy.sh --simulate /private/tmp/simulation-check --check
bash deploy.sh --simulate /private/tmp/simulation-success
bash deploy.sh --simulate /private/tmp/simulation-mid-switch --fail=mid-switch
bash deploy.sh --simulate /private/tmp/simulation-after-code --fail=after-code
bash deploy.sh --simulate /private/tmp/simulation-readiness --fail=readiness
bash deploy.sh --simulate /private/tmp/simulation-busy --idle=busy
bash deploy.sh --simulate /private/tmp/simulation-held --idle=held
bash deploy.sh --simulate /private/tmp/simulation-unknown --idle=unknown
```

正常场景应成功退出并生成 `deployed.json`。三个切换故障场景均应退出 `1`，生成 `rollback.json` 且 `restored: true`，五个旧文件、Admin、环境及旧包逐一不变，新增模块和新包不存在。`after-code` 只有在两个旧代码文件均已替换后才触发，确保回滚确实覆盖二者。忙碌或手机仍持有任务退出 `78`；计数不明退出 `1`，均不创建 backup、before/deployed/rollback 收据，不写生产 payload，也不重启。另测试修改旧文件或 guard、追加 Admin 文件、CI SHA 不同或缺少 job，均须在写入前拒绝。`--fail` 和 `--idle` 只允许与 `--simulate` 一起使用，不能作为生产绕过参数。自带模拟测试使用 `node --test scripts/releases/platform-home-followup/deploy.test.mjs`（Node 18.20.8）。

## 经授权后的生产步骤

将 stage 放在 `/opt/onstarvoice-private/releases/platform-home-followup-<short-sha>-20260928/`。确认 stage 和生产目录均为真实目录，无符号链接。

1. 运行 `sha256sum -c SHA256SUMS`，核对已审阅的完整 SHA 和 CI 证据。
2. 运行 `bash deploy.sh --check`。此步骤只读，不查询或要求任务空闲，核对七文件范围、全部 oldSha/newSha/guards、完整 Admin 清单、旧更新清单 `0.4.20`、Node 18、PM2 入口、环境基线和本机健康，并从本机及公网验证旧包、changelog、全部公开 Admin 文件 HTTP 摘要。基线漂移即停止，不自动改写基线。
3. 外部主发布流程先核对 `activeTasks=0` 且 `androidHeldItems=0`，间隔至少 30 秒再次确认双零。保留这两次证据后运行 `bash deploy.sh`。发布器完成 HTTP 预检、取得独占锁并最后核对基线后，立刻再查询一次最新双计数；这一步通过之前不创建备份、不写入 payload、不重启。任何计数非零以 `IDLE GATE BUSY` 和退出码 `78` 拒绝；查询失败、超时、结果缺失或不合法以 `IDLE GATE UNKNOWN` 和退出码 `1` 拒绝。随后备份五个旧文件，并按发布器内部固定顺序原子替换：新增冷却模块 → 两个旧代码文件 → 新 zip → about/ops-control → update-manifest。`release.json.files` 的顺序不能改变此顺序。PM2 重启不带 `--update-env`。
4. 验收本机 ready/live、PM2 新 PID/启动时间与原 Node/入口/环境、七文件新摘要、完整 Admin guards、环境文件摘要。再从本机和公网分别核对 `0.4.21` 更新清单、扩展 zip HTTP SHA、`/changelog` HTML SHA、Admin 全部公开静态文件 HTTP SHA。更新说明必须标注 Extension `0.4.21` 和 Android Runner `0.2.6`。
5. 只有上述全部通过才生成 `deployed.json`。失败则逆序恢复已切换文件、移除本次新增冷却模块和 zip，再重启并验证旧清单 `0.4.20`、旧包 HTTP SHA、旧 changelog、Admin、环境和健康，生成 `rollback.json`。回滚不完整会明确报错；存在外部并发修改时拒绝覆盖，需人工调查。

内部空闲查询与主发布流程的计数口径一致：`activeTasks` 统计分配节点五分钟内仍存活且状态为 claimed/running/recovering/resume_requested 的任务；`androidHeldItems` 统计 Android 节点下 `deviceHeld=true` 的任务项。使用服务端已安装的 pg/dotenv 和配置，在独立 Node 18 子进程执行 `BEGIN READ ONLY`、两条 COUNT、`ROLLBACK`，只返回时间和双计数。连接限时 3 秒、每条语句 3 秒、驱动查询 4 秒、整个子进程 15 秒硬截止。连接和查询错误不会输出凭据或原始环境。

最后一次内部查询不能替代外部“间隔 30 秒双零”闸门，也不是暂停接单或数据库派发锁。查询通过到文件切换之间仍有很短的接单竞态；本发布器不停止任务、不修改任务状态。通过后不再执行耗时 HTTP 预检，仅做备份与逐文件摘要核对；生产仍需按授权的空闲发布窗口执行。

保留 stage、`backup/`、`before.json`、`deployed.json` 或 `rollback.json` 作为证据。before/deployed 收据保存最终空闲计数，deployed/rollback 收据保存实际已切换文件顺序。已使用的 stage 不可覆盖备份重跑。常规可捕获失败及 TERM/INT/HUP 会进入回滚；断电或 SIGKILL 无法由进程捕获，恢复时保留锁和备份，核对实际文件后按备份恢复，不删除锁后盲目重跑。

模拟不能代替真实 PM2、公网缓存/下载或浏览器和手机验收。服务端发布成功也不代表现有浏览器已升级或手机已安装新 Runner；这些须由主发布流程分别处理。
