# StarVoice 生产部署说明

本文只描述仓库当前可验证的部署方式。生产域名为
`https://voice.minilife.online`，应用服务器为 `47.103.125.200`，Express
监听 `3002`，PM2 进程名为 `onstarvoice`，部署目录为
`/opt/onstarvoice`。

> 更完整的开发、备份、发布、回滚和故障处理流程见
> [`../docs/开发运行与生产发布手册.md`](../docs/开发运行与生产发布手册.md)。
>
> **当前生产发布必须以该受控手册为准。仓库中的 `deploy/deploy.sh` 是旧库存脚本，只用于审计历史行为，不是获批生产入口；不要直接运行。** P2-B 当前只是尚未合并、未部署的 Draft PR #21 候选，以下角色说明不表示线上已经配置或部署。

## 1. 当前拓扑

```text
浏览器管理端 / Extension
          │ HTTPS
          ▼
voice.minilife.online
          │ Nginx 反向代理
          ▼
127.0.0.1:3002 / PM2:onstarvoice
          ├── PostgreSQL:onstarvoice
          ├── /opt/onstarvoice/media（运行时媒体）
          └── /opt/onstarvoice/web/admin/dist（管理端静态文件）
```

- StarVoice 与同机其他应用复用 Nginx、PostgreSQL 和 PM2，但使用独立端口、
  进程名、应用目录和数据库。
- 数据库中的租户数据依靠应用层 `tenant_id` 过滤；当前没有启用 PostgreSQL
  RLS，不能绕过应用直接向客户开放数据库连接。
- Extension 通过 Agent Token 接入，不使用管理端会话。一个浏览器配置文件
  对应一个独立 Agent。

### 1.1 端口口径

三个端口含义不同，排障和发布时不要混用：

- `3001`：本地完整联调约定端口。管理端、数据看板的 Vite 代理以及本地
  Extension 快照都以它为后端入口；
- `3000`：`server/index.js` 在没有设置 `PORT` 时的代码兜底值，只适合单独
  验证后端启动，不是完整联调口径；
- `3002`：生产 PM2 进程监听端口，由 Nginx 反向代理，不直接暴露给客户。

## 2. 首次部署前置条件

### 2.1 DNS

在 DNS 控制台创建：

| 类型 | 主机记录 | 值 |
|---|---|---|
| A | `voice` | `47.103.125.200` |

验证：

```bash
dig +short voice.minilife.online
```

### 2.2 PostgreSQL

新环境统一使用独立 PostgreSQL 登录角色 `onstarvoice`，数据库也命名为
`onstarvoice`。仅在角色和数据库都尚不存在时执行：

```bash
sudo -u postgres createuser --login --pwprompt onstarvoice
sudo -u postgres createdb --owner=onstarvoice onstarvoice
```

`--pwprompt` 会交互式读取密码，避免把数据库密码写进 Shell 历史。把同一密码
填写到 `DATABASE_URL`。

验证角色和数据库所有者：

```bash
sudo -u postgres psql -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname = 'onstarvoice';"
sudo -u postgres psql -tAc \
  "SELECT datname || ':' || pg_get_userbyid(datdba)
   FROM pg_database WHERE datname = 'onstarvoice';"
```

不要对已经运行的生产库重复建库、重置密码或改所有者。已有环境应先从受控的
`DATABASE_URL` 和上述只读查询确认真实角色；若历史环境使用其他独立角色，
后续命令中的 `onstarvoice` 必须整体替换为该角色，而不是为了匹配模板强行改库。
也不要把其他产品的数据库地址写入 StarVoice 的环境文件。

### 2.3 Nginx 与证书

仓库中的模板为 `deploy/voice.minilife.online.nginx.conf`。首次部署可执行：

```bash
scp deploy/voice.minilife.online.nginx.conf \
  root@47.103.125.200:/etc/nginx/sites-available/voice.minilife.online

ssh root@47.103.125.200 '
  ln -sf /etc/nginx/sites-available/voice.minilife.online \
    /etc/nginx/sites-enabled/voice.minilife.online
  nginx -t
  systemctl reload nginx
'
```

证书由服务器上的 Certbot 管理。申请前先确认 DNS 已生效：

```bash
ssh root@47.103.125.200 \
  'certbot --nginx -d voice.minilife.online --non-interactive --agree-tos -m YOUR_EMAIL'
```

### 2.4 生产环境变量

生产文件固定为本机 `server/.env.production`。它被 Git 忽略，发布脚本会将其
复制为远端 `/opt/onstarvoice/server/.env`。

```bash
cp deploy/onstarvoice.env.production.example server/.env.production
```

至少确认以下项目：

```dotenv
NODE_ENV=production
PORT=3002
PROCESS_ROLE=all
DATABASE_URL=postgres://onstarvoice:PASSWORD@127.0.0.1:5432/onstarvoice
CORS_ORIGINS=https://voice.minilife.online
ADMIN_PUBLIC_URL=https://voice.minilife.online/admin/
PUBLIC_BASE_URL=https://voice.minilife.online
MEDIA_DIR=/opt/onstarvoice/media
BOOTSTRAP_ADMIN_EMAIL=...
BOOTSTRAP_ADMIN_PASSWORD=...
LLM_PROVIDER=...
LLM_API_KEY=...
```

安全要求：

- 不把 `.env.production`、数据库密码、SMTP 密码或 AI API Key 提交到 Git。
- 已有平台管理员的数据库必须让 `BOOTSTRAP_ADMIN_EMAIL`、
  `BOOTSTRAP_ADMIN_PASSWORD`、`BOOTSTRAP_ADMIN_NAME` 保持为空。它们只允许在
  全新数据库首次创建平台管理员时临时填写；创建完成后立即清空并重新发布。
- 不要把模板占位邮箱或占位密码当成“未配置”。应用会把非空值视为真实凭据。
- 远端 `/opt/onstarvoice/server/.env` 必须归属 `root:root` 且权限为 `600`。
  当前部署脚本会在上传后强制设置并校验；手工上传时必须自行完成。
- `ALLOW_RESET_MIGRATIONS` 正常必须为 `0`。只有完成可恢复备份并明确审核
  reset 迁移后，才允许临时设为 `1`。
- 只有未来发布批次明确包含 P2-B 运行时代码时，才把 `PROCESS_ROLE=all` 作为新代码首次启动前的强制前置条件；仓库 topology JSON 只是期望清单，仍需独立核对真实 PM2 只有一个 `onstarvoice` 实例。
- `FEISHU_WEBHOOK_URL` 当前代码没有消费，不要误以为配置后会产生飞书通知。
  当前安全事件通知通道是 SMTP 邮件。

## 3. 每次发布前

发布脚本会直接同步代码、安装生产依赖、执行数据库迁移并重启 PM2。脚本
**不会自动创建生产备份，也不是零停机滚动发布**，所以发布前必须人工完成：

1. 确认待发布分支和提交范围；
2. 确认工作区没有误带密钥、调试文件或客户导出数据；
3. 在本地完成管理端构建和关键测试；
4. 备份数据库；
5. 如果修改迁移，审查尚未执行的 SQL；
6. 记录当前 Git 提交和可回退的远端应用版本。

本地检查：

```bash
git status --short
git rev-parse HEAD

cd web/admin
npm ci
npm run build
npm run lint
cd ../..

cd server
npm ci
npm audit --omit=dev
cd ..
```

`npm audit` 是风险清单，不是自动修复授权。不要在生产发布前运行
`npm audit fix --force`。

生产数据库备份示例：

```bash
ssh root@47.103.125.200 '
  set -e
  mkdir -p /opt/backups/onstarvoice
  backup=/opt/backups/onstarvoice/onstarvoice-$(date +%Y%m%d-%H%M%S).dump
  sudo -u postgres pg_dump --format=custom --no-owner --no-acl \
    onstarvoice > "$backup"
  test -s "$backup"
  chmod 600 "$backup"
  pg_restore --list "$backup" >/dev/null
  printf "%s\n" "$backup"
'
```

命令输出的路径就是本次恢复点。这里明确用 PostgreSQL 管理身份读取数据库，
避免远端系统用户 `root` 被误当成 PostgreSQL 角色。备份完成后还要记录文件
大小、校验值和当前 Git 提交；恢复演练应在非生产数据库上进行。

## 4. 旧库存脚本行为说明（禁止直接执行）

不要把本节当成可复制的生产发布步骤。当前受控发布、原子切换、完整回滚和验证流程只以 [`../docs/开发运行与生产发布手册.md`](../docs/开发运行与生产发布手册.md) 第 9–11 节为准。下面仅记录旧库存 `deploy/deploy.sh` 的实际行为，便于审计风险。

当前脚本实际执行顺序：

1. 把若干常见 Node.js 24/20 安装目录追加到 `PATH` 后构建 `web/admin`。
   这一步既不选择 Node 版本，也不验证实际命中的 `node`：若候选目录不存在，
   脚本会继续使用调用者当前 `PATH` 中的版本。因此发布前必须单独执行
   `command -v node` 和 `node --version`；脚本本身不保证 Node 24/20；
2. 校验 `server/.env.production` 存在；
3. 在远端创建后端、管理端、图片、媒体等目录；
4. 使用 `rsync --delete` 同步 `server/`，但排除 `node_modules` 和 `.env`；
5. 使用 `rsync --delete` 同步管理端 `dist/` 和仓库 `images/`；
6. 将 `.env.production` 复制为远端 `server/.env`，随后强制设置
   `root:root`、权限 `600` 并校验；校验失败则停止发布；
7. 远端执行 `npm install --omit=dev`；
8. 远端执行 `node db/migrate.js`；
9. 删除旧 PM2 进程，再启动新进程，内存上限为 `400M`；
10. 执行 `pm2 save`。

由此带来的边界：

- `pm2 delete` 到 `pm2 start` 之间会有短暂中断；
- 迁移成功但应用启动失败时，数据库不会自动回滚到发布前版本；
- `rsync --delete` 会删除目标代码目录中仓库已不存在的文件；
- 当前脚本不构建、不同步 `web/dashboard/dist/`；数据看板修改需要单独构建、
  备份旧产物、同步并验证，不能宣称随一键脚本发布；
- 持久化媒体应放在 `/opt/onstarvoice/media`，不要放在会被代码同步覆盖的
  临时目录；
- 发布脚本没有自动健康检查门禁，必须执行下一节的人工验证。

## 5. 发布后验证

### 5.1 进程与日志

```bash
ssh root@47.103.125.200 '
  pm2 status
  pm2 logs onstarvoice --lines 100 --nostream
  stat -c "%U:%G %a %n" /opt/onstarvoice/server/.env
'
```

确认：

- `onstarvoice` 状态为 `online`；
- 没有数据库认证、迁移、端口占用、模块缺失或循环重启错误；
- 环境文件输出为
  `root:root 600 /opt/onstarvoice/server/.env`；
- 启动日志中定时任务已注册。

### 5.2 健康与静态页面

```bash
curl --fail --silent --show-error \
  https://voice.minilife.online/api/health

curl --fail --silent --show-error --head \
  https://voice.minilife.online/admin/
```

### 5.3 数据库迁移

核对本次启动日志中的 migration 结果，再只读检查已登记版本。不要为了“验证幂等”在生产发布后再次执行 `node db/migrate.js`；该入口会运行尚未登记的迁移和既有回填，不是只读命令。

```bash
ssh root@47.103.125.200 \
  'sudo -u postgres psql -d onstarvoice -c \
  "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;"'
```

### 5.4 业务冒烟

至少验证：

1. 管理员能登录并切换到预期租户；
2. 调度中心能看到 Agent，在线状态符合两分钟心跳规则；
3. 创建一个低风险、少量关键词的一次性任务；
4. Extension 能领取命令、回传进度并完成；
5. 管理端能看到任务状态和采集结果；
6. 若本次修改涉及 AI、OCR、ASR 或邮件，分别执行一次受控样例。

## 6. 回滚

当前发布由文件同步、依赖安装、数据库迁移、删除旧 PM2 进程和启动新进程等
多个独立步骤组成，不在同一个事务内，因此**不是原子发布，也没有原子回滚**。
重新发布旧提交只能回退应用代码；它不会撤销已经执行的迁移，也不会删除发布
后的新写入。

回滚必须先判断是“仅应用代码问题”还是“迁移已改变数据结构/数据”。

### 6.1 仅回滚应用

当数据库迁移向后兼容时：

1. 按本次受控发布记录定位完整旧应用目录，不从一个 Git SHA 猜测限定生产树；
2. 按主发布手册在同一文件系统原子交换回完整旧目录，并用既有 PM2 配置重启；
3. 重新执行启动健康、数据库/迁移、认证、Agent/队列和业务冒烟；
4. 不运行旧库存 `deploy/deploy.sh`，避免 `rsync --delete`、依赖安装、迁移和 PM2 删除/重建扩大回滚范围。

### 6.2 数据库也需恢复

只有在确认新迁移不兼容、且接受恢复点之后数据丢失时，才恢复备份。数据库
降级必须走发布前备份恢复：推荐先停止新写入，恢复到新数据库并验证，再切换
`DATABASE_URL`；不要在未验证时直接覆盖唯一生产库。

恢复演练必须按主发布手册使用带 release ID 的唯一新验证库名，先只读确认该库不存在，再创建并恢复；若同名库已存在就停止，不自动 `dropdb`。不要把演练命令指向唯一生产库。

reset 迁移不会因 Git 回滚而自动撤销。涉及清空或重建数据的迁移必须依赖
发布前备份恢复。

数据库事故恢复还必须包含：冻结或记录新写入、保留故障现场、恢复到独立验证
库、用目标旧版本完成冒烟、经业务负责人确认恢复点后的数据损失、受控切换
`DATABASE_URL`，以及失败时切回原库。完整步骤见
[开发运行与生产发布手册：数据库降级](../docs/开发运行与生产发布手册.md#123-数据库降级)。

### 6.3 Dashboard 独立发布与回退

`deploy/deploy.sh` 不处理 `web/dashboard/dist/`。数据看板必须独立构建、备份
远端旧产物、同步、验证；出现问题时把已记录的备份目录原样恢复。可直接照做的
命令见
[开发运行与生产发布手册：Dashboard 独立发布](../docs/开发运行与生产发布手册.md#101-dashboard-独立发布)。

## 7. Extension 发布边界

后端部署不会自动更新已安装的 Extension。

- 本机联调前执行 `scripts/sync-extension-build.zsh local`，再在扩展管理页
  Reload；
- 客户包必须通过 `scripts/package-extension.zsh` 生成，脚本会重建并校验
  生产地址；
- 不要把开发态 `localhost` 包发给客户；
- 发布后核对 `manifest.json` 版本、生产 API 地址和权限变化；
- Agent Token 与激活码、租户和浏览器配置文件有关，不能在客户之间复用。

## 8. 常用运维命令

```bash
# 状态
ssh root@47.103.125.200 'pm2 status'

# 最近日志
ssh root@47.103.125.200 \
  'pm2 logs onstarvoice --lines 200 --nostream'

# 仅重启（没有同步代码和迁移）
ssh root@47.103.125.200 'pm2 restart onstarvoice'

# 查看监听端口
ssh root@47.103.125.200 'ss -ltnp | grep :3002'

# 数据库连通性
ssh root@47.103.125.200 \
  'sudo -u postgres psql -d onstarvoice -c "SELECT now();"'
```

## 9. 禁止事项

- 不在没有备份时执行 reset 迁移、批量删除或租户覆盖。
- 不使用 `git reset --hard`、直接覆盖 `.env` 或删除持久化媒体来“修复”
  发布问题。
- 不把 PM2 `online` 等同于业务健康；必须检查 `/api/health` 和关键流程。
- 不把迁移脚本可重复运行等同于所有迁移可逆。
- 不把一次依赖扫描结果长期当作现状；发布时重新运行扫描并按实际依赖链
  评估。
