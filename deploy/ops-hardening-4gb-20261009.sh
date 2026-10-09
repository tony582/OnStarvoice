#!/usr/bin/env bash
# 2026-10-09 14:45 生产机升级到 2 vCPU / 4 GiB / 系统盘 50 GiB 之后的跟进(幂等,可重复执行):
#   1. 备份改到 100 GB 数据盘 /data/backups/postgres(首轮备份曾因 /opt/onstarvoice-private 对 postgres 不可进入而失败),
#      重装脚本与 cron,并立刻重跑一轮、等它出结果
#   2. 根分区从 40 GB 在线扩到整块 50 GB 系统盘(growpart + resize2fs,不停机)
#   3. PostgreSQL 参数按 3.5 GiB 可用内存重算:effective_cache_size 2GB、work_mem 16MB、
#      maintenance_work_mem 256MB、shared_buffers 768MB(后者需重启 PostgreSQL 才生效)
# 用法: bash deploy/ops-hardening-4gb-20261009.sh [服务器IP] [--restart-postgres]
#   --restart-postgres  立即重启 PostgreSQL 让 shared_buffers 生效(约 5–10 秒数据库不可用;
#                       scheduler/ai-media 会因角色锁会话断开而自行退出并由 PM2 拉起,脚本会等它们恢复)
set -euo pipefail

SERVER="47.103.125.200"
RESTART_PG=0
for arg in "$@"; do
  case "$arg" in
    --restart-postgres) RESTART_PG=1 ;;
    *) SERVER="$arg" ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="/opt/onstarvoice-private"

echo "▶ 上传更新后的备份脚本与 cron 到 $SERVER …"
scp -q "$ROOT/deploy/backup/pg-nightly-backup.sh" "root@$SERVER:$PRIVATE/backups/pg-nightly-backup.sh"
scp -q "$ROOT/deploy/backup/onstarvoice-pg-backup.cron" "root@$SERVER:/etc/cron.d/onstarvoice-pg-backup"

echo "▶ 远端执行…"
ssh "root@$SERVER" RESTART_PG="$RESTART_PG" bash -s <<'REMOTE'
set -euo pipefail
PRIVATE=/opt/onstarvoice-private
BK=/data/backups/postgres
cd /tmp

echo "--- 1. 备份目录移到数据盘并重跑首轮 ---"
mountpoint -q /data || { echo "✗ /data 未挂载,停止"; exit 1; }
chown root:root "$PRIVATE/backups/pg-nightly-backup.sh" /etc/cron.d/onstarvoice-pg-backup
chmod 750 "$PRIVATE/backups/pg-nightly-backup.sh"; chmod 644 /etc/cron.d/onstarvoice-pg-backup
bash -n "$PRIVATE/backups/pg-nightly-backup.sh"
install -d -o postgres -g postgres -m 750 "$BK"
sudo -u postgres test -w "$BK" && echo "postgres 可写 $BK"
grep -E '^(PG_BACKUP|[0-9*])' /etc/cron.d/onstarvoice-pg-backup
rmdir "$PRIVATE/backups/db" 2>/dev/null && echo "已移除空的旧备份目录 $PRIVATE/backups/db" || true
echo "开始首轮备份(低优先级,约 1 GB,通常 3–8 分钟)…"
# setsid + </dev/null:后台任务完全脱离这个 ssh 会话,否则会话结束后本机 ssh 可能一直等不到通道关闭
# (10-09 首次运行时远端早已跑完,本机 ssh 却挂到被 Ctrl+C)。
setsid nohup env PG_BACKUP_DIR="$BK" PG_BACKUP_KEEP_DAYS=14 "$PRIVATE/backups/pg-nightly-backup.sh" < /dev/null > "$BK/first-run.log" 2>&1 &
BK_PID=$!

echo "--- 2. 根分区扩到整块系统盘 ---"
BEFORE=$(df -BG --output=size / | tail -1 | tr -d ' G')
if growpart /dev/vda 3; then resize2fs /dev/vda3; else echo "(分区已是最大,跳过)"; fi
AFTER=$(df -BG --output=size / | tail -1 | tr -d ' G')
echo "根文件系统 ${BEFORE}G → ${AFTER}G"; df -h / | tail -1

echo "--- 3. PostgreSQL 参数按 4 GiB 机器重算 ---"
sudo -u postgres psql -At <<'SQL'
select 'before: '||name||'='||current_setting(name) from pg_settings where name in ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','random_page_cost');
ALTER SYSTEM SET effective_cache_size = '2GB';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
ALTER SYSTEM SET shared_buffers = '768MB';
ALTER SYSTEM SET random_page_cost = 1.1;
SELECT pg_reload_conf();
SQL
sleep 1
sudo -u postgres psql -Atc "select 'after:  '||name||'='||current_setting(name)||case when pending_restart then '  (待重启生效)' else '' end from pg_settings where name in ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','random_page_cost')"

if [ "${RESTART_PG:-0}" = "1" ]; then
  echo "--- 3b. 重启 PostgreSQL 让 shared_buffers 生效 ---"
  # 先等首轮备份结束,避免 pg_dump 被重启打断
  while kill -0 "$BK_PID" 2>/dev/null; do sleep 5; done
  systemctl restart postgresql
  sleep 3
  sudo -u postgres psql -Atc "select 'shared_buffers now='||current_setting('shared_buffers')"
  echo "等待 scheduler / ai-media 重新拿到角色锁、API 就绪…"
  for i in $(seq 1 30); do
    LOCKS=$(sudo -u postgres psql -d onstarvoice -Atc "select count(*) from pg_locks where locktype='advisory'" 2>/dev/null || echo 0)
    READY=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/health/ready || true)
    if [ "$LOCKS" = "2" ] && [ "$READY" = "200" ]; then echo "恢复:advisory_locks=2 ready=200(第 ${i} 次检查)"; break; fi
    sleep 2
  done
  pm2 status --no-color | grep -E "onstarvoice|minilife"
fi

echo "--- 4. 等首轮备份出结果(最多 10 分钟) ---"
for i in $(seq 1 60); do
  if ! kill -0 "$BK_PID" 2>/dev/null; then break; fi
  sleep 10
done
tail -4 "$BK/backup.log"
ls -la "$BK" | awk 'NR>1 && $5>1048576 {printf "  %8.0f MB  %s\n",$5/1048576,$NF}'
df -h /data | tail -1
REMOTE

echo "✅ 完成。日常检查:ssh root@$SERVER 'tail -3 /data/backups/postgres/backup.log; ls -la /data/backups/postgres | tail -3'"
