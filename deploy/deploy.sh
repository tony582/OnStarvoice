#!/usr/bin/env bash
# StarVoice 一键部署到阿里云 ECS(与 minilife 同机,二级域名 voice.minilife.online)
# 用法:  bash deploy/deploy.sh [服务器IP]
# 默认 IP 47.103.125.200。需要:① 已配置到该机的 SSH(建议 SSH key 免密)
#                                ② 已在服务器建库 onstarvoice(见 DEPLOY.md)
#                                ③ 已填好 server/.env.production
#
# 进程拓扑由 deploy/process-topology.production.json 决定(当前为 split:
# onstarvoice-api / onstarvoice-scheduler / onstarvoice-ai-media 各 1 个进程),
# PM2 应用列表由 deploy/ecosystem.config.cjs 按该清单生成,每个进程显式带
# PROCESS_ROLE,不依赖 .env。回退到单进程兼容拓扑见 DEPLOY.md「拓扑回退」。
set -euo pipefail

SERVER="${1:-47.103.125.200}"
APP_DIR="/opt/onstarvoice"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOPOLOGY="$ROOT/deploy/process-topology.production.json"

# admin 构建需要 node>=18;本机默认是 v16,自动切到 nvm 的 v24
for NODE_BIN in "$HOME/.nvm/versions/node/v24.12.0/bin" "$HOME/.nvm/versions/node/v20"*/bin; do
  [ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH" && break
done

if [ ! -f "$ROOT/server/.env.production" ]; then
  echo "✗ 缺少 server/.env.production —— 请先从 deploy/onstarvoice.env.production.example 复制并填好"; exit 1
fi
PORT="$(grep -E '^PORT=' "$ROOT/server/.env.production" | tail -1 | cut -d= -f2- | tr -d '[:space:]')"
PORT="${PORT:-3002}"

echo "▶ 校验发布拓扑清单 $TOPOLOGY …"
node "$ROOT/scripts/check-process-topology.mjs" "$TOPOLOGY"

echo "▶ 使用 node $(node -v) 构建 admin 前端…"
( cd "$ROOT/web/admin" && npm run build )

echo "▶ 同步后端 + admin 产物 + images + 拓扑/PM2 配置到 $SERVER:$APP_DIR …"
ssh "root@$SERVER" "mkdir -p $APP_DIR/server $APP_DIR/deploy $APP_DIR/web/admin/dist $APP_DIR/images $APP_DIR/media/covers"
rsync -avz --delete --exclude node_modules --exclude '.env' "$ROOT/server/"          "root@$SERVER:$APP_DIR/server/"
rsync -avz --delete                                          "$ROOT/web/admin/dist/" "root@$SERVER:$APP_DIR/web/admin/dist/"
rsync -avz --delete                                          "$ROOT/images/"         "root@$SERVER:$APP_DIR/images/"
rsync -avz \
  "$ROOT/deploy/ecosystem.config.cjs" \
  "$ROOT/deploy/process-topology.production.json" \
  "$ROOT/deploy/process-topology.compatibility.json" \
  "root@$SERVER:$APP_DIR/deploy/"
scp "$ROOT/server/.env.production" "root@$SERVER:$APP_DIR/server/.env"
echo "▶ 收紧并校验生产环境文件权限…"
ssh "root@$SERVER" \
  "chown root:root '$APP_DIR/server/.env' && chmod 600 '$APP_DIR/server/.env' && test \"\$(stat -c '%a' '$APP_DIR/server/.env')\" = 600"

echo "▶ 远程安装依赖 + 迁移建表 + 按拓扑清单重建 PM2 进程…"
ssh "root@$SERVER" bash -s <<EOF
  set -e
  cd $APP_DIR/server
  npm install --omit=dev
  # 迁移只在这里跑一次(唯一的维护步骤);独立角色启动时只做只读核对,不跑迁移。
  node db/migrate.js

  # 先停掉所有 onstarvoice* 进程(包括旧的单进程 onstarvoice),等它们退出并释放
  # 数据库角色锁后,再按清单起新进程。两种拓扑绝不并存。
  for NAME in \$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s||'[]').map(p=>p.name).filter(n=>/^onstarvoice/.test(n)).join(' ')))"); do
    echo "  - 停止 \$NAME"
    pm2 delete "\$NAME"
  done
  pm2 start $APP_DIR/deploy/ecosystem.config.cjs --update-env
  pm2 save

  echo "▶ 等待 API 就绪(/api/health/ready)…"
  CODE=000
  for i in \$(seq 1 30); do
    CODE=\$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health/ready" || true)
    [ "\$CODE" = "200" ] && break
    sleep 2
  done
  if [ "\$CODE" != "200" ]; then
    echo "✗ API 未就绪(HTTP \$CODE),请查看 pm2 logs"
    pm2 status --no-color
    pm2 logs --lines 60 --nostream --no-color || true
    exit 1
  fi
  pm2 status --no-color
EOF

echo "✅ 部署完成 → https://voice.minilife.online"
echo "   (首次需先在服务器跑 certbot 申请证书,见 DEPLOY.md 步骤 4)"
