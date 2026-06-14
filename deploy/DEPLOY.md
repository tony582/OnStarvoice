# StarVoice 部署到阿里云(voice.minilife.online)

与 minilife 同一台 ECS(`47.103.125.200`),复用其 node / PM2 / Nginx / PostgreSQL / Certbot。
StarVoice 作为**第二个 PM2 应用**跑在 **3002** 端口(minilife 占 3000),用**独立数据库** `onstarvoice`。

```
浏览器/插件 ──► https://voice.minilife.online ──(Nginx 443/80)──► 127.0.0.1:3002 (Express)
                                                                      └─ /admin 静态 + /api + /images
本地 PostgreSQL:库 minilife(minilife 用) / 库 onstarvoice(本项目用,数据隔离)
```

---

## 谁做什么

| 步骤 | 谁 | 说明 |
|---|---|---|
| 1. DNS 解析 | **你**(阿里云控制台) | 需要登录你的阿里云账号,我不能代登 |
| 2. 建数据库 | 你 / 我(若给免密 SSH) | 一条 SQL |
| 3. 填 .env.production | **你** | 里面是密钥(LLM/SMTP/DB 密码) |
| 4. Nginx + 证书 | 你 / 我(若给免密 SSH) | 放配置 + certbot |
| 5. 跑部署脚本 | 我(若给免密 SSH)/ 你 | `bash deploy/deploy.sh` |

> 我不会代输服务器/云账号密码。最顺的方式:你在本机配一把 **SSH key 免密**到该 ECS,之后步骤 2/4/5 我都能替你跑;DNS(步骤1)只能你点。

---

## 步骤

### 1. 阿里云 DNS(你来)
在阿里云「云解析 DNS」给 `minilife.online` 加一条记录:
- 记录类型 `A`,主机记录 `voice`,记录值 `47.103.125.200`
- 生效后 `ping voice.minilife.online` 应解析到该 IP

### 2. 建独立数据库(服务器上执行一次)
```bash
sudo -u postgres psql -c "CREATE DATABASE onstarvoice OWNER minilife;"
```
(沿用 minilife 的 PG 账号 minilife;库分开,数据互不影响。)

### 3. 准备生产环境变量(你来)
```bash
cp deploy/onstarvoice.env.production.example server/.env.production
# 编辑 server/.env.production:
#   - DATABASE_URL 的 PG 密码(与 minilife 的 .env 里一致)
#   - ADMIN_PASSWORD 设强密码
#   - LLM_* / SMTP_* / FEISHU_*  从本地 server/.env 抄过来
```
该文件已被 .gitignore,不会进仓库。

### 4. Nginx + HTTPS 证书(服务器上执行一次)
```bash
# 上传站点配置
scp deploy/voice.minilife.online.nginx.conf root@47.103.125.200:/etc/nginx/sites-available/voice.minilife.online
ssh root@47.103.125.200 '
  ln -sf /etc/nginx/sites-available/voice.minilife.online /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
  certbot --nginx -d voice.minilife.online --non-interactive --agree-tos -m 你的邮箱@xx.com
'
```
certbot 会自动补 443 + 80→443 跳转 + 自动续期。

### 5. 部署(本机执行,DNS 生效后)
```bash
bash deploy/deploy.sh 47.103.125.200
```
脚本做了:本机用 node v24 构建 admin → rsync 后端/admin产物/images → 远程 `npm install` + `node db/migrate.js` 建表 + `pm2 start index.js --name onstarvoice`。

### 6. 验证
```bash
curl -I https://voice.minilife.online            # 期望 200/301/302
curl https://voice.minilife.online/api/auth/me   # 期望 {"ok":false,...请先登录}(说明后端通)
```
浏览器打开 `https://voice.minilife.online` → 用 ADMIN_PASSWORD 登录。

### 7. 插件指向生产(已在代码层改好)
- `utils/api.js` 与 `manifest.json` 已加入 `voice.minilife.online`(放在 localhost 之后,开发机仍走本地)。
- 生产用:把扩展(本目录)重新打包为 .crx 或在 Chrome「加载已解压的扩展」装这个文件夹,采集即同步到云端。

---

## 日常更新
改完代码、合到 main 后,本机一条命令即可滚动更新:
```bash
bash deploy/deploy.sh
```
查看日志 / 状态:
```bash
ssh root@47.103.125.200 'pm2 logs onstarvoice --lines 30 --nostream; pm2 status'
```

## 注意
- **端口 3002**,勿与 minilife(3000)冲突。
- **数据库 onstarvoice 独立**,迁移只动本库,不影响 minilife。
- 部署脚本带 `--exclude .env`,不会覆盖服务器上的 minilife 配置;只动 `/opt/onstarvoice/`。
