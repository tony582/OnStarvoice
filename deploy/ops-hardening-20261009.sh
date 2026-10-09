#!/usr/bin/env bash
# 2026-10-09 运维加固,一次性安装到生产机(可重复执行,幂等):
#   1. 每日 02:30 数据库备份(deploy/backup/pg-nightly-backup.sh + /etc/cron.d)并立即跑第一轮
#   2. PM2 日志走系统 logrotate(deploy/logrotate-pm2.conf),清掉旧单进程攒下的 760 MB 日志
#   3. PostgreSQL 规划器参数按 1.6 GB 机器校正(effective_cache_size / random_page_cost / work_mem)
# 用法: bash deploy/ops-hardening-20261009.sh [服务器IP]   默认 47.103.125.200
set -euo pipefail

SERVER="${1:-47.103.125.200}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="/opt/onstarvoice-private"

echo "▶ 上传备份脚本 / cron / logrotate 配置到 $SERVER …"
ssh "root@$SERVER" "install -d -m 750 $PRIVATE/backups"
scp -q "$ROOT/deploy/backup/pg-nightly-backup.sh" "root@$SERVER:$PRIVATE/backups/pg-nightly-backup.sh"
scp -q "$ROOT/deploy/backup/onstarvoice-pg-backup.cron" "root@$SERVER:/etc/cron.d/onstarvoice-pg-backup"
scp -q "$ROOT/deploy/logrotate-pm2.conf" "root@$SERVER:/etc/logrotate.d/pm2-onstarvoice"

echo "▶ 远端安装并校验…"
ssh "root@$SERVER" bash -s <<'REMOTE'
set -euo pipefail
PRIVATE=/opt/onstarvoice-private
cd /tmp

echo "--- 1. 备份脚本与 cron ---"
chown root:root "$PRIVATE/backups/pg-nightly-backup.sh" /etc/cron.d/onstarvoice-pg-backup
chmod 750 "$PRIVATE/backups/pg-nightly-backup.sh"
chmod 644 /etc/cron.d/onstarvoice-pg-backup
bash -n "$PRIVATE/backups/pg-nightly-backup.sh"
install -d -o postgres -g postgres -m 750 "$PRIVATE/backups/db"
grep -E '^[0-9*]' /etc/cron.d/onstarvoice-pg-backup
systemctl is-active cron >/dev/null && echo "cron 服务: active"

echo "--- 2. PM2 日志轮转 ---"
chown root:root /etc/logrotate.d/pm2-onstarvoice && chmod 644 /etc/logrotate.d/pm2-onstarvoice
logrotate -d /etc/logrotate.d/pm2-onstarvoice 2>&1 | grep -E 'error|rotating pattern|log needs|log does not need' | head -6
if [ -f /root/.pm2/logs/onstarvoice-out.log ]; then
  echo "删除旧单进程输出日志 $(du -h /root/.pm2/logs/onstarvoice-out.log | cut -f1)"
  rm -f /root/.pm2/logs/onstarvoice-out.log
fi
if [ -f /root/.pm2/logs/onstarvoice-error.log ]; then
  echo "压缩保留旧单进程错误日志 $(du -h /root/.pm2/logs/onstarvoice-error.log | cut -f1)"
  gzip -9 -f /root/.pm2/logs/onstarvoice-error.log
fi
du -sh /root/.pm2/logs

echo "--- 3. PostgreSQL 规划器参数 ---"
sudo -u postgres psql -At <<'SQL'
select 'before: '||name||'='||setting||coalesce(unit,'') from pg_settings where name in ('effective_cache_size','random_page_cost','work_mem');
ALTER SYSTEM SET effective_cache_size = '768MB';
ALTER SYSTEM SET random_page_cost = 1.1;
ALTER SYSTEM SET work_mem = '8MB';
SELECT pg_reload_conf();
SQL
sleep 1
sudo -u postgres psql -Atc "select 'after:  '||name||'='||setting||coalesce(unit,'')||' (source='||source||')' from pg_settings where name in ('effective_cache_size','random_page_cost','work_mem')"

echo "--- 4. 立即跑第一轮备份(后台,低优先级;进度看 $PRIVATE/backups/db/backup.log) ---"
nohup "$PRIVATE/backups/pg-nightly-backup.sh" > "$PRIVATE/backups/db/first-run.log" 2>&1 &
sleep 2
tail -2 "$PRIVATE/backups/db/backup.log"
df -h / | tail -1
REMOTE

echo "✅ 运维加固已安装;首轮备份在后台进行,稍后用下面命令查看:"
echo "   ssh root@$SERVER 'tail -5 $PRIVATE/backups/db/backup.log; ls -la $PRIVATE/backups/db'"
