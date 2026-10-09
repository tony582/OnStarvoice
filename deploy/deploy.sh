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
node "$ROOT/scripts/check-process-topology.mjs" "$ROOT/deploy/process-topology.compatibility.json" >/dev/null

# 10-09 事故:本机过期的 .env.production 覆盖了线上 .env(少 9 个键)→ 3 分钟 502。
# 发布前核对:线上 .env 里有的键,本地副本必须都有;缺任何一个就停。
echo "▶ 核对本地 .env.production 覆盖线上 .env 的全部键…"
REMOTE_KEYS="$(ssh "root@$SERVER" "test -f $APP_DIR/server/.env && cut -d= -f1 $APP_DIR/server/.env | grep -E '^[A-Z_]+$' | sort -u" || true)"
LOCAL_KEYS="$(cut -d= -f1 "$ROOT/server/.env.production" | grep -E '^[A-Z_]+$' | sort -u)"
MISSING_KEYS="$(comm -23 <(printf '%s\n' "$REMOTE_KEYS") <(printf '%s\n' "$LOCAL_KEYS") | grep -v '^$' || true)"
if [ -n "$MISSING_KEYS" ]; then
  echo "✗ 本地 server/.env.production 缺少线上 .env 已有的键,发布会把它们抹掉:"
  printf '    %s\n' $MISSING_KEYS
  echo "  请先把线上 /opt/onstarvoice/server/.env 的差异合回本地再发布。"
  exit 1
fi
echo "  线上 $(printf '%s\n' "$REMOTE_KEYS" | grep -c .) 键均在本地副本中(本地共 $(printf '%s\n' "$LOCAL_KEYS" | grep -c .) 键)"

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
# 覆盖前先在线上留一份带时间戳的备份(600),出问题可直接拷回。
ssh "root@$SERVER" "test -f $APP_DIR/server/.env && cp -p $APP_DIR/server/.env $APP_DIR/server/.env.before-deploy-\$(date +%Y%m%d-%H%M%S) && chmod 600 $APP_DIR/server/.env.before-deploy-* || true"
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

  # 先停掉两份清单里出现过的全部 StarVoice 进程(split 三进程 + 单进程 onstarvoice),
  # 等它们退出并释放数据库角色锁后,再按当前清单起新进程。两种拓扑绝不并存。
  # 只按清单里的名字删,不按前缀删,避免误伤同机其它 PM2 应用。
  KNOWN_NAMES="\$(node -e "
    const names = new Set();
    for (const f of ['$APP_DIR/deploy/process-topology.production.json', '$APP_DIR/deploy/process-topology.compatibility.json']) {
      for (const p of require(f).processes) names.add(p.name);
    }
    console.log([...names].join(' '));
  ")"
  RUNNING_NAMES="\$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s||'[]').map(p=>p.name).join(' ')))")"
  for NAME in \$KNOWN_NAMES; do
    case " \$RUNNING_NAMES " in
      *" \$NAME "*) echo "  - 停止 \$NAME"; pm2 delete "\$NAME" ;;
    esac
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
