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

（待补：部署时间、三进程状态、登录页实测。）
