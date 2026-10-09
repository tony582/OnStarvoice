#!/usr/bin/env bash
# StarVoice 生产库每日备份:pg_dump 自定义格式 + pg_restore --list 校验 + 按天数保留。
#
# 安装位置: /opt/onstarvoice-private/backups/pg-nightly-backup.sh(root:root 750)
# 触发:     /etc/cron.d/onstarvoice-pg-backup 每天 02:30 以 root 运行
# 产物:     /opt/onstarvoice-private/backups/db/onstarvoice-<时间戳>.dump(+ .toc 清单)
# 用法:     pg-nightly-backup.sh [保留天数]   默认 3(机器 40G 盘剩约 13G,一份约 1G)
#
# 恢复(到独立验证库,不要指向生产库):
#   createdb onstarvoice_restore_x && pg_restore --exit-on-error --no-owner --no-acl \
#     -d onstarvoice_restore_x /opt/onstarvoice-private/backups/db/onstarvoice-<时间戳>.dump
#
# 异地副本(OSS)尚未配置:需要 bucket 与 AccessKey,配好 ossutil 后在本脚本末尾追加
#   ossutil cp "$OUT" oss://<bucket>/onstarvoice/db/ 即可。
set -euo pipefail

DB="${PG_BACKUP_DB:-onstarvoice}"
# 默认落在 100 GB 数据盘 /data(与 2026-08-31 起已有的 /data/backups 同处);数据盘没挂时退回系统盘。
# 注意 pg_dump 以 postgres 身份写文件,目录的每一级父目录都要对 postgres 可进入(o+x)——
# 10-09 首轮备份就是因为 /opt/onstarvoice-private/backups 是 root 750 而失败。
if [ -z "${PG_BACKUP_DIR:-}" ]; then
  if mountpoint -q /data 2>/dev/null; then DIR=/data/backups/postgres; else DIR=/opt/onstarvoice-private/backups/db; fi
else
  DIR="$PG_BACKUP_DIR"
fi
KEEP_DAYS="${1:-${PG_BACKUP_KEEP_DAYS:-14}}"
MIN_FREE_BYTES="${PG_BACKUP_MIN_FREE_BYTES:-2684354560}"   # 2.5 GiB
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/$DB-$STAMP.dump"
LOG="$DIR/backup.log"

install -d -o postgres -g postgres -m 750 "$DIR"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
if ! sudo -u postgres test -w "$DIR"; then
  log "FAIL postgres cannot write $DIR (check o+x on every parent directory)"
  exit 1
fi

FREE_BYTES="$(df --output=avail -B1 "$DIR" | tail -1 | tr -d ' ')"
if [ "$FREE_BYTES" -lt "$MIN_FREE_BYTES" ]; then
  log "FAIL free space ${FREE_BYTES} bytes below ${MIN_FREE_BYTES}; not dumping"
  exit 1
fi

log "start db=$DB keep_days=$KEEP_DAYS free=$((FREE_BYTES / 1048576))MiB"
START_TS=$(date +%s)
# 低优先级运行,避免挤占白天采集;自定义格式自带压缩,可用 pg_restore 按表恢复。
if ! sudo -u postgres nice -n 19 ionice -c3 pg_dump -Fc --no-owner --no-acl -d "$DB" -f "$OUT.part" 2>>"$LOG"; then
  log "FAIL pg_dump exited non-zero (its stderr is above); partial file removed"
  rm -f "$OUT.part"
  exit 1
fi
mv "$OUT.part" "$OUT"
chown postgres:postgres "$OUT"
chmod 640 "$OUT"

# 校验:能完整列出 TOC 才算一份可用备份
if ! sudo -u postgres pg_restore --list "$OUT" > "$OUT.toc" 2>>"$LOG"; then
  log "FAIL pg_restore --list failed; kept as $OUT.bad for inspection"
  mv "$OUT" "$OUT.bad"
  rm -f "$OUT.toc"
  exit 1
fi
chown postgres:postgres "$OUT.toc"
SIZE="$(du -h "$OUT" | cut -f1)"
TABLES="$(grep -c 'TABLE DATA' "$OUT.toc" || true)"
log "ok $OUT size=$SIZE table_data_entries=$TABLES seconds=$(( $(date +%s) - START_TS ))"

# 保留策略:最新 2 份永远保留;其余超过 KEEP_DAYS 天的删除(dump 与 toc 一起)。
ls -1 "$DIR"/"$DB"-*.dump 2>/dev/null | sort | head -n -2 | while read -r old; do
  if [ -n "$(find "$old" -mtime +"$KEEP_DAYS" -print 2>/dev/null)" ]; then
    log "prune $old"
    rm -f "$old" "$old.toc"
  fi
done
log "done free=$(( $(df --output=avail -B1 "$DIR" | tail -1 | tr -d ' ') / 1048576 ))MiB dumps=$(ls -1 "$DIR"/"$DB"-*.dump 2>/dev/null | wc -l)"
