#!/usr/bin/env bash
# StarVoice 一键部署到阿里云 ECS(与 minilife 同机,二级域名 voice.minilife.online)
# 用法:  bash deploy/deploy.sh [服务器IP]
# 默认 IP 47.103.125.200。需要:① 已配置到该机的 SSH(建议 SSH key 免密)
#                                ② 已在服务器建库 onstarvoice(见 DEPLOY.md)
#                                ③ 已填好 server/.env.production
set -euo pipefail

SERVER="${1:-47.103.125.200}"
APP_DIR="/opt/onstarvoice"
APP_NAME="onstarvoice"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# admin 构建需要 node>=18;本机默认是 v16,自动切到 nvm 的 v24
for NODE_BIN in "$HOME/.nvm/versions/node/v24.12.0/bin" "$HOME/.nvm/versions/node/v20"*/bin; do
  [ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH" && break
done
echo "▶ 使用 node $(node -v) 构建 admin 前端…"
( cd "$ROOT/web/admin" && npm run build )

if [ ! -f "$ROOT/server/.env.production" ]; then
  echo "✗ 缺少 server/.env.production —— 请先从 deploy/onstarvoice.env.production.example 复制并填好"; exit 1
fi

echo "▶ 同步后端 + admin 产物 + images 到 $SERVER:$APP_DIR …"
ssh "root@$SERVER" "mkdir -p $APP_DIR/server $APP_DIR/web/admin/dist $APP_DIR/images $APP_DIR/media/covers"
rsync -avz --delete --exclude node_modules --exclude '.env' "$ROOT/server/"          "root@$SERVER:$APP_DIR/server/"
rsync -avz --delete                                          "$ROOT/web/admin/dist/" "root@$SERVER:$APP_DIR/web/admin/dist/"
rsync -avz --delete                                          "$ROOT/images/"         "root@$SERVER:$APP_DIR/images/"
scp "$ROOT/server/.env.production" "root@$SERVER:$APP_DIR/server/.env"

echo "▶ 远程安装依赖 + 迁移建表 + PM2 重启…"
ssh "root@$SERVER" bash -s <<EOF
  set -e
  cd $APP_DIR/server
  npm install --omit=dev
  node db/migrate.js
  pm2 delete $APP_NAME 2>/dev/null || true
  pm2 start index.js --name $APP_NAME --max-memory-restart 400M
  pm2 save
  pm2 status $APP_NAME --no-color | tail -3
EOF

echo "✅ 部署完成 → https://voice.minilife.online"
echo "   (首次需先在服务器跑 certbot 申请证书,见 DEPLOY.md 步骤 4)"
