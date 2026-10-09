# 2026-10-09 运维加固：备份 / 日志 / 依赖 / PG 参数 / CI / 前端分包

> 分支 `chore/ops-hardening-20261009`（基于 `main@ce6ba02`，split 拓扑上线之后）。
> 范围是用户点选的 1、2、4、6、7、8 六项；第 3 项（机器升 4 GB 内存）需在阿里云操作，第 5 项（心跳存活 500）在另一会话处理。

## 1. 每日数据库备份（服务器侧，需用户执行 `deploy/ops-hardening-20261009.sh`）

- 现状：线上最近一份 dump 是 09-28，之后 11 天的发布都没有备份，也没有任何备份 cron；库 5150 MB，磁盘剩 13 GB，机器 2 核。
- 做法：`deploy/backup/pg-nightly-backup.sh` 安装到 `/opt/onstarvoice-private/backups/`，由 `/etc/cron.d/onstarvoice-pg-backup` 每天 02:30 以 root 运行：`nice/ionice` 低优先级 `pg_dump -Fc --no-owner --no-acl`，先写 `.part` 再改名；`pg_restore --list` 生成 `.toc` 清单作为可用性校验；最新 2 份永远保留、其余超过 3 天删除；剩余空间不足 2.5 GB 拒绝执行；日志 `backup.log` / `cron.log`。
- 未做：异地副本。机器上没有 ossutil/rclone，需要用户提供 OSS bucket 与 AccessKey 后在脚本末尾加一行上传。

## 2. 日志轮转与请求日志

- 现状：旧单进程 `onstarvoice-out.log` 攒到 760 MB、从未轮转；API 每分钟写约 100 行 `[REQ]`（全是 Agent 心跳）。
- 做法：`deploy/logrotate-pm2.conf` 安装为 `/etc/logrotate.d/pm2-onstarvoice`（daily / maxsize 50M / 保留 14 / 压缩 / copytruncate），走 Ubuntu 自带的 logrotate.timer，不装 pm2-logrotate 模块（省一个常驻进程的内存）；脚本会删掉 760 MB 旧日志、压缩保留旧错误日志。
- 代码：`server/app.js` 生产默认不再逐请求打印，`LOG_REQUESTS=1` 可临时打开（提交 46ed356）。

## 4. 依赖安全告警

- `npm audit fix`（非破坏性）：express 4.21.2→4.22.3、body-parser 1.20.8、qs 6.16.0、proxy-addr 2.0.8、brace-expansion 1.1.21，清掉严重级的 proxy-addr IPv4 映射 IPv6 信任绕过和 qs/body-parser 的 DoS（提交 24ce2f6，只动 package-lock）。
- **未修**：nodemailer 剩 5 条（9.1.1），所有修复版本都在 10.x，而 nodemailer 10 要求 Node ≥ 20，线上是 Node 18.20.8（已于 2025-04 EOL）。这几条都需要攻击者控制收件地址，而本系统收件人来自租户设置，暴露面低。根治是把线上 Node 升到 20/22，顺带也能升 nodemailer。

## 6. PostgreSQL 规划器参数（服务器侧，同上脚本）

- 现状：`effective_cache_size=5 GB`（机器总共 1.6 GB）、`random_page_cost=4`（机械盘默认，云盘应按 SSD）、`work_mem=4 MB`、`shared_buffers≈160 MB`。
- 做法：`ALTER SYSTEM` 写入 `postgresql.auto.conf` 并 `pg_reload_conf()`：`effective_cache_size=768MB`、`random_page_cost=1.1`、`work_mem=8MB`。不动 `shared_buffers`（需重启）。只影响执行计划估算，不改任何 SQL。

## 7. CI

- main 自 10-08 起红，最后只剩一个原因：月报页 `CustomerMonthlyReport.tsx` 在 effect 里同步 setState（2 条 `react-hooks/set-state-in-effect`）加一个未用的类型导入，而新文件的逐文件上限是 0。改法：把三处重置挪进异步 `load()` 内（序号守卫保证过期请求不碰状态），删掉未用导入（提交 cac3e35）。基线门禁：261 errors / 0 warnings（上限 288/0）。
- CI 原来只对 `main` 和 `codex/**` 触发，今天的 split 分支合并前没跑过 CI；现在加了 `refactor/**`、`fix/**`、`feat/**`、`chore/**`、`hotfix/**`。

## 8. 前端按页懒加载

- 现状：桌面壳与手机壳把 22 个页面全部静态引入，登录后要先下一个 1.25 MB 的共享应用块；图表库又被入口预加载。
- 做法：`web/admin/src/lib/lazy-page.tsx` 的 `lazyPage(() => import('@/pages/X'), 'X')` 按页 `React.lazy + Suspense`，两个壳的 `PAGE_COMPONENTS` 标识符不变（源码合同测试照常通过）；`DispatchPage` 带 `surface` 属性用显式泛型透传（提交 b56e2d3）。
- Vite 8 底层是 rolldown，其 `manualChunks` 兼容层会把被匹配包的依赖一起拉进同组，`clsx`（recharts 的依赖，入口也用）因此进了图表桶，导致登录页预加载 300 KB 图表库；改用原生 `codeSplitting.groups` 并关掉 `includeDependenciesRecursively`（提交 ac324c1）。
- 结果（构建产物）：登录页需下载的 JS 840 KB → 556 KB；登录后桌面壳 24 KB + 首页 15 KB（原 1.25 MB + 50 KB）；最大的页面块是调度中心 475 KB，只在打开时加载；共 49 个块。

## 验证

- Node 回归（Node 24.12.0）：3284/3284。
- 隔离 PostgreSQL 集成：517/517（含 express 4.22 升级后的 HTTP 认证用例）。
- Admin lint 基线门禁通过；`tsc -b && vite build` 通过；读取两个壳源码的 12 个合同测试通过。

## 发布记录

| 时间 | 事件 |
|---|---|
| 13:47–13:51 | 另一会话误用旧版 deploy.sh 覆盖线上磁盘（内存中的三进程未受影响），随后用新版脚本从 `c561758` 重建恢复，详见 `20261009-triage-export-timeout.md`。本分支因此变基到 `c561758`，回归 3287/3287 |
| 13:55:16–13:55:46 | `bash deploy/deploy.sh 47.103.125.200`：清单预检 → 线上 27 键核对 → admin 构建 → rsync → `.env` 备份后覆盖 → 迁移无新项 → 按清单停三进程并重建 → readiness 200，退出 0 |
| 13:56 | 三进程 online、restarts 0（PID 813667/813668/813669）；scheduler/ai-media 日志各持本角色锁（backendPid 813712/813711），`pg_locks` advisory 2；三进程错误日志为空；api 日志 `[REQ]` 行数 0；`/api/health/ready` 本机与公网 200；11 台 Agent 3 分钟内有心跳；切换窗口 nginx 6 个 5xx |
| 13:56 | 线上 `web/admin/dist/index.html` 预加载 8 个块、不含 `vendor-charts`，共 49 个 JS 块；浏览器打开登录页正常 |

| 14:29:23–14:29:55 | 第二次发布（main `063eb00`）：api 内存上限 350→400M 生效，并带上另一会话的存活上报锁超时 hotfix `687d1fd`；14:42 观察 api 零 Unhandled/55P03、Agent 通道 299 次请求全部 200、整站零 5xx |

服务器侧三项（备份 cron + 首轮备份、PM2 logrotate + 删 760 MB 旧日志、PG 参数）由用户执行 `bash deploy/ops-hardening-20261009.sh 47.103.125.200`，本机自动模式不放行远程写入。

## 跟进：机器升级到 4 GiB（2026-10-09 14:45）

- 用户把轻量服务器升到 2 vCPU / 4 GiB / 系统盘 50 GiB，14:45:39 重启；三进程由 pm2 开机自启全部恢复（restarts 0），`/api/health/ready` 200，角色锁 2 把，12 台 Agent 在线。
- 用户已运行 `ops-hardening-20261009.sh`：cron、logrotate、PG 三参数（768MB / 1.1 / 8MB）均已落地，760 MB 旧日志已删。但**首轮备份失败**：`/opt/onstarvoice-private` 为 root 700，postgres 进不去 → `pg_dump: could not open output file … Permission denied`。
- 修正：备份默认改到数据盘 `/data/backups/postgres`（父目录 755，44 GB 空闲），保留 14 天；脚本启动时检查 postgres 可写、pg_dump 的 stderr 进日志。`deploy/ops-hardening-4gb-20261009.sh` 负责重装并立刻重跑首轮、把根分区从 40 GB 扩到 50 GB、PG 参数按 3.5 GiB 重算（`shared_buffers=768MB` 需重启，`--restart-postgres` 可选）。
- PM2 内存上限随 4 GiB 放回 api 400M / scheduler 300M / ai-media 400M（下次部署生效）。

### 4 GiB 跟进执行结果（2026-10-09 14:52–14:59，用户执行 `ops-hardening-4gb-20261009.sh --restart-postgres`）

- 备份：`/data/backups/postgres/onstarvoice-20261009-145405.dump` 974 MB，94 个表数据项，266 秒，`pg_restore --list` 校验通过；cron 已指向数据盘，保留 14 天。
- 根分区：growpart + resize2fs 在线扩容，40 GB → 49 GB（使用 53%）。
- PostgreSQL：`effective_cache_size=2GB`、`work_mem=16MB`、`maintenance_work_mem=256MB`、`random_page_cost=1.1` reload 生效；14:58:33 重启后 `shared_buffers=768MB`，`pending_restart=false`。重启让 scheduler / ai-media 的角色锁会话断开，两者按设计立即退出并由 PM2 拉起（各 restarts=1），15:02 核对 advisory 锁 2 把、api 未重启、`/api/health/ready` 200、12 台 Agent 在线。
- 脚本瑕疵：远端全部执行完后本机 ssh 没有退出（终端停在「3b」），手动中断即可；已给后台备份加 `setsid … < /dev/null`。

## 跟进：Node 18 → 24 与 nodemailer 10（2026-10-09）

- 线上 Node 18.20.8（NodeSource apt，2025-04 EOL）；Node 20 也已于 2026-04 EOL，目标定为 Node 24（与 `.nvmrc`、CI 一致）。同机 minilife（express 5 / pg / bcryptjs）与我们唯一的原生模块 `@resvg/resvg-js`（N-API 预编译）均兼容。
- `deploy/upgrade-node-24-20261009.sh`：保存 PM2 列表 → 下载 18.20.8 的 .deb 与旧源文件到 `/opt/onstarvoice-private/rollback/node18/` → 源切 `node_24.x` 并安装 → resvg 自检 → `pm2 update`（四个应用重启一次）→ 等 readiness/角色锁/minilife → `pm2 save`。脚本被本机自动模式判为「生产部署」拦截，由用户执行。
- 分支 `chore/node24-nodemailer10-20261009`（Node 24 上线后再合并部署，nodemailer 10 在 Node 18 上不能跑）：nodemailer 9.1.1 → 10.0.16（`npm audit --omit=dev` 归零）、`engines.node >= 20`、CI 的 Node 18 兼容任务与矩阵改为 Node 24。

### Node 24 升级执行记录与事故（2026-10-09 15:44–15:48）

- 15:44 用户运行 `upgrade-node-24-20261009.sh`：回滚材料落盘（`nodejs_18.20.8-1nodesource1_amd64.deb` + 旧源文件）、源切 `node_24.x`、安装 Node **24.21.0** / npm 11.19.0、resvg 自检通过。
- **事故**：第 4 步用 `pm2 update` 换守护进程。这台机器的 pm2 由 systemd 单元 `pm2-root` 管理（`Type=forking`，`ExecStop=pm2 kill`）；15:45:21 pm2 update 杀掉旧守护进程并拉起新进程、恢复应用，15:45:22 systemd 发现主 PID 退出即执行 ExecStop，把新守护进程连同刚恢复的四个应用一起杀掉（pm2.log：`pm2 has been killed by signal, dumping process list before exit`）。此后无任何应用在跑，脚本的 90 秒等待静默超时，第 5 步 `pm2 jlist` 又拉起一个空守护进程并因输出混入提示文本而 JSON 解析失败退出。
- **影响**：15:45:22–15:48:2x 全站不可用约 3 分钟，nginx 记录 132 个 502（含 minilife）；无数据影响。
- **恢复**（15:48:19–15:48:28）：`pm2 kill` 清掉空守护进程 → `systemctl start pm2-root`（`pm2 resurrect`，dump 是 ExecStop 前一刻写的、含四个应用）→ 四个应用在 Node 24.21.0 上 online、restarts 0，`/api/health/ready` 200、minilife 200、公网 200、角色锁 2、15:49 起零 5xx。随后 `pm2 save`，`pm2-root` enabled。
- **修正**：脚本第 4 步改为 `systemctl stop pm2-root` → `systemctl start pm2-root`，等待失败时打印 pm2 状态并以非零退出；头部注释写明教训。以后凡是 systemd 托管的 pm2，一律不用 `pm2 update`。
- 15:50:52–15:51:21 `deploy/deploy.sh` 发布 main `d5f4ded`（nodemailer 10.0.16、engines ≥ 20、worker 内存上限 300/400M）：服务器 `npm install` changed 1 package、0 vulnerabilities；三进程在 Node 24.21.0 上重建（切换窗口 4 个 502）。15:52 核对：四个应用 node=24.21.0、restarts 0、错误日志 0 行、无 DeprecationWarning；api/minilife/公网探针 200；角色锁 2；12 台 Agent 在线；`pm2-root` active+enabled；内存可用 1.8 GiB。
- 验证通过后合并 `chore/node24-nodemailer10-20261009`（nodemailer 10.0.16、engines ≥ 20、CI 改 Node 24）并以 deploy.sh 发布。
