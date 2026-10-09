#!/usr/bin/env bash
# 2026-10-09 生产 Node 18.20.8 → Node 24(NodeSource apt 源),顺带让 PM2 守护进程与全部应用在新运行时上重启。
#
# 影响:同机四个 PM2 应用(onstarvoice-api/scheduler/ai-media + minilife)在 `pm2 update` 时一起重启一次,
#      约 10 秒;scheduler/ai-media 会重新拿角色锁。minilife 的依赖(express 5 / pg / bcryptjs)与 Node 24 兼容。
# 回滚:脚本先把当前 18.20.8 的 .deb 下载到 /opt/onstarvoice-private/rollback/node18/,
#      需要时 `dpkg -i 那个.deb && pm2 update` 即可回到 Node 18(apt 源文件也留了 .node18 备份)。
# 用法: bash deploy/upgrade-node-24-20261009.sh [服务器IP]
set -euo pipefail
SERVER="${1:-47.103.125.200}"

ssh "root@$SERVER" bash -s <<'REMOTE'
set -euo pipefail
cd /tmp
export DEBIAN_FRONTEND=noninteractive
ROLLBACK=/opt/onstarvoice-private/rollback/node18
SRC=/etc/apt/sources.list.d/nodesource.list

echo "--- 0. 升级前 ---"
echo "node=$(node -v) npm=$(npm -v) pm2=$(pm2 -v)"
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]"))console.log("  "+p.name.padEnd(24),p.pm2_env.status,"node="+p.pm2_env.node_version,"restarts="+p.pm2_env.restart_time)})'
printf 'api_ready=%s minilife=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/health/ready)" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)"
pm2 save >/dev/null && echo "pm2 进程列表已保存"

echo "--- 1. 留回滚材料(当前 .deb + 旧源文件) ---"
install -d -m 750 "$ROLLBACK"
cp -n "$SRC" "$ROLLBACK/nodesource.list.node18"
( cd "$ROLLBACK" && ls nodejs_18*.deb >/dev/null 2>&1 || apt-get download nodejs=18.20.8-1nodesource1 >/dev/null )
ls -la "$ROLLBACK" | awk 'NR>1{print "  "$5, $NF}'

echo "--- 2. 切换 NodeSource 源到 node_24.x 并安装 ---"
grep -q "node_18\.x" "$SRC" && sed -i 's#node_18\.x#node_24.x#' "$SRC"
cat "$SRC"
apt-get update -qq
apt-cache policy nodejs | sed -n 1,3p
apt-get install -y -qq nodejs >/dev/null
echo "node=$(node -v) npm=$(npm -v) ($(readlink -f "$(command -v node)"))"
case "$(node -v)" in v24.*) ;; *) echo "✗ node 不是 24.x,停止(PM2 未动)"; exit 1;; esac

echo "--- 3. 新运行时自检(resvg 原生模块 / pm2 可用) ---"
( cd /opt/onstarvoice/server && node -e "const {Resvg}=require('@resvg/resvg-js'); console.log('resvg ok', typeof Resvg)" )
pm2 -v

echo "--- 4. pm2 update:守护进程与全部应用在 Node 24 上重启 ---"
pm2 update 2>&1 | grep -E "PM2|Restarting|online|errored" | head -12
echo "等待 API 就绪、角色锁恢复、minilife 回应…"
for i in $(seq 1 45); do
  READY=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/health/ready || true)
  MINI=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
  LOCKS=$(sudo -u postgres psql -d onstarvoice -Atc "select count(*) from pg_locks where locktype='advisory'" 2>/dev/null || echo 0)
  if [ "$READY" = "200" ] && [ "$LOCKS" = "2" ] && [ "$MINI" != "000" ] && [ -n "$MINI" ]; then echo "恢复:api_ready=200 advisory_locks=2 minilife=$MINI(第 ${i} 次检查)"; break; fi
  sleep 2
done

echo "--- 5. 升级后 ---"
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]"))console.log("  "+p.name.padEnd(24),p.pm2_env.status,"node="+p.pm2_env.node_version,"restarts="+p.pm2_env.restart_time,"mem="+Math.round((p.monit.memory||0)/1048576)+"M")})'
pm2 save >/dev/null && echo "pm2 进程列表已按新运行时保存;开机自启单元: $(systemctl is-enabled pm2-root 2>/dev/null)"
for n in api scheduler ai-media; do f=$(ls -t /root/.pm2/logs/onstarvoice-$n-out*.log | head -1); echo "[$n] $(grep -hE '\[ProcessRole\] role=|HTTP listener ready|jobs started' "$f" | tail -2 | tr '\n' '|')"; done
sudo -u postgres psql -d onstarvoice -Atc "select 'agents_heartbeat_3m='||count(*) from capture_agents where last_heartbeat_at > now() - interval '3 minutes'"
echo "回滚命令(如需): dpkg -i $ROLLBACK/nodejs_18*.deb && cp $ROLLBACK/nodesource.list.node18 $SRC && pm2 update"
REMOTE
echo "✅ Node 升级脚本执行完毕"
