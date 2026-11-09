#!/usr/bin/env bash
# Targeted release: configured recipients + multi-recipient WeChat forwarding.
# Usage: deploy.sh [--prepare-only] [ABSOLUTE_NEW_STAGE_DIRECTORY]
# A stage directory supplied by the caller must not already exist. Nothing is
# removed from an existing local directory. --prepare-only never contacts SSH.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)
TARGET=root@47.103.125.200
BASE=97583fabbdc772b1a9c00d2f8af8f04ff33de216
BASE_INDEX=65e1bec76f03602ac1a80a0d3370cbcfa946f192b759ef95702f17966fb7f32f
PREPARE_ONLY=0
if [ "${1:-}" = --prepare-only ]; then PREPARE_ONLY=1; shift; fi
[ "$#" -le 1 ] || { echo 'usage: deploy.sh [--prepare-only] [ABSOLUTE_NEW_STAGE_DIRECTORY]' >&2; exit 2; }

NEW=$(git -C "$ROOT" rev-parse --verify HEAD)
[[ "$NEW" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release commit' >&2; exit 1; }
[ "$NEW" != "$BASE" ] || { echo 'Commit the multi-recipient changes before preparing a release' >&2; exit 1; }
git -C "$ROOT" merge-base --is-ancestor "$BASE" "$NEW" || { echo 'Release does not descend from the verified baseline' >&2; exit 1; }
assert_clean() {
  [ -z "$(git -C "$ROOT" status --porcelain -- server web)" ] || {
    echo 'Server or web files have uncommitted changes; refusing to release' >&2; exit 1;
  }
}
assert_clean
SHA=${NEW:0:12}
REL=/opt/onstarvoice-private/releases/wechat-forward-multi-${SHA}-20261109

if [ "$#" -eq 1 ]; then
  STAGE=$1
  case "$STAGE" in /*) ;; *) echo 'Stage path must be absolute' >&2; exit 2;; esac
  case "$STAGE" in /|*/../*|*/..|*/./*|*/.|*$'\n'*|*$'\r'*) echo 'Unsafe stage path' >&2; exit 2;; esac
  [ ! -e "$STAGE" ] && [ ! -L "$STAGE" ] || { echo 'Stage directory already exists; choose a new directory' >&2; exit 1; }
  mkdir -m 700 "$STAGE"
else
  STAGE=$(mktemp -d "/private/tmp/wechat-forward-multi-${SHA}.XXXXXX")
fi
STAGE=$(cd "$STAGE" && pwd)
echo "Preparing $NEW in $STAGE"

FILES=(
  server/routes/admin.js
  server/routes/android-control.js
  server/services/android-control/service.js
  server/services/android-control/forward.js
)
mkdir "$STAGE/payload"
: > "$STAGE/manifest.txt"
for f in "${FILES[@]}"; do
  mkdir -p "$STAGE/payload/$(dirname "$f")"
  git -C "$ROOT" show "$NEW:$f" > "$STAGE/payload/$f"
  before=$(git -C "$ROOT" show "$BASE:$f" | shasum -a 256 | awk '{print $1}')
  after=$(shasum -a 256 "$STAGE/payload/$f" | awk '{print $1}')
  node --check "$STAGE/payload/$f"
  printf '%s %s %s\n' "$f" "$before" "$after" >> "$STAGE/manifest.txt"
done

npm --prefix "$ROOT/web/admin" run build > "$STAGE/admin-build.log" 2>&1 || {
  echo "Admin build failed; see $STAGE/admin-build.log" >&2; exit 1;
}
assert_clean
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$NEW" ] || { echo 'HEAD changed during the build' >&2; exit 1; }
DIST=$ROOT/web/admin/dist
[ -f "$DIST/index.html" ] || { echo 'Admin build has no index.html' >&2; exit 1; }
[ -z "$(find "$DIST" -type l -print -quit)" ] || { echo 'Admin build contains a symlink' >&2; exit 1; }
mkdir "$STAGE/payload/admin"
COPYFILE_DISABLE=1 cp -R "$DIST/." "$STAGE/payload/admin/"
(
  cd "$STAGE/payload/admin"
  find . -type f ! -name '._*' ! -name '.DS_Store' | sed 's#^\./##' | LC_ALL=C sort |
  while IFS= read -r a; do
    [[ "$a" =~ ^[A-Za-z0-9_./-]+$ ]] && [[ "$a" != *..* ]] || { echo "Unsafe asset filename: $a" >&2; exit 1; }
    printf '%s %s\n' "$a" "$(shasum -a 256 "$a" | awk '{print $1}')"
  done
) > "$STAGE/admin-manifest.txt"
printf '%s\n' "$BASE_INDEX" > "$STAGE/admin-index-base.sha256"
printf '{"commit":"%s","baselineCommit":"%s","baselineAdminIndexSha256":"%s","target":"%s","releaseDirectory":"%s"}\n' \
  "$NEW" "$BASE" "$BASE_INDEX" "$TARGET" "$REL" > "$STAGE/release.json"

# This script is also kept on the server for an explicit later rollback. It
# refuses to overwrite a different subsequent release, and retains new hashed
# assets so browsers that already loaded the new index can finish their reads.
cat > "$STAGE/rollback.sh" <<'ROLLBACK'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
REL=$(cd "$(dirname "$0")" && pwd)
LIVE=/opt/onstarvoice
DIST=$LIVE/web/admin/dist
LOCK=/opt/onstarvoice-private/releases/.wechat-forward-multi-deploy.lock
if [ "${1:-}" != --from-deploy ]; then
  mkdir "$LOCK" || { echo 'Another release holds the deployment lock' >&2; exit 1; }
  trap 'rmdir "$LOCK"' EXIT
fi
BASE_INDEX=$(cat "$REL/admin-index-base.sha256")
NEW_INDEX=$(awk '$1 == "index.html" {print $2}' "$REL/admin-manifest.txt")
while read -r f before after; do
  [ "$(sha256sum "$REL/backup/$f" | awk '{print $1}')" = "$before" ] || { echo "Invalid backup: $f" >&2; exit 1; }
  got=$(sha256sum "$LIVE/$f" | awk '{print $1}')
  [ "$got" = "$before" ] || [ "$got" = "$after" ] || { echo "Refusing to overwrite a later change: $f" >&2; exit 1; }
done < "$REL/manifest.txt"
[ "$(sha256sum "$REL/backup/index.html" | awk '{print $1}')" = "$BASE_INDEX" ] || { echo 'Invalid index backup' >&2; exit 1; }
got=$(sha256sum "$DIST/index.html" | awk '{print $1}')
[ "$got" = "$BASE_INDEX" ] || [ "$got" = "$NEW_INDEX" ] || { echo 'Refusing to overwrite a later Admin index' >&2; exit 1; }
while read -r f before after; do
  tmp=$(mktemp "$LIVE/$(dirname "$f")/.wechat-forward-rollback.XXXXXX")
  cp -p "$REL/backup/$f" "$tmp"
  [ "$(sha256sum "$tmp" | awk '{print $1}')" = "$before" ]
  mv -f "$tmp" "$LIVE/$f"
done < "$REL/manifest.txt"
tmp=$(mktemp "$DIST/.wechat-forward-rollback.XXXXXX")
cp -p "$REL/backup/index.html" "$tmp"
mv -f "$tmp" "$DIST/index.html"
pm2 restart onstarvoice-api > "$REL/rollback-api-restart.log" 2>&1
ready=0
for i in $(seq 1 30); do
  if curl --max-time 2 -fsS http://127.0.0.1:3002/api/health/ready > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'Rollback restored files, but API readiness failed; inspect rollback-api-restart.log' >&2; exit 1; }
while read -r f before after; do [ "$(sha256sum "$LIVE/$f" | awk '{print $1}')" = "$before" ]; done < "$REL/manifest.txt"
[ "$(sha256sum "$DIST/index.html" | awk '{print $1}')" = "$BASE_INDEX" ]
date -Is >> "$REL/rollback-applied"
echo "Rollback verified: $REL"
ROLLBACK
chmod 700 "$STAGE/rollback.sh"
bash -n "$STAGE/rollback.sh"
COPYFILE_DISABLE=1 tar -czf "$STAGE/payload.tgz" -C "$STAGE" \
  payload manifest.txt admin-manifest.txt admin-index-base.sha256 release.json rollback.sh
PAYLOAD_SHA=$(shasum -a 256 "$STAGE/payload.tgz" | awk '{print $1}')
printf '%s  payload.tgz\n' "$PAYLOAD_SHA" > "$STAGE/payload.sha256"
echo "Prepared: $STAGE (archive $PAYLOAD_SHA)"
[ "$PREPARE_ONLY" = 0 ] || exit 0

# The remote directory is new and the archive hash is checked before extraction.
ssh "$TARGET" "umask 077; test ! -e '$REL' && mkdir '$REL'"
scp -q "$STAGE/payload.tgz" "$TARGET:$REL/payload.tgz"
ssh "$TARGET" "REL='$REL' EXPECT_ARCHIVE_SHA='$PAYLOAD_SHA' bash -s" <<'REMOTE'
set -Eeuo pipefail
umask 077
LIVE=/opt/onstarvoice
DIST=$LIVE/web/admin/dist
LOCK=/opt/onstarvoice-private/releases/.wechat-forward-multi-deploy.lock
MUTATED=0
mkdir "$LOCK" || { echo 'Another release holds the deployment lock' >&2; exit 1; }
trap 'rmdir "$LOCK"' EXIT
failed() {
  code=$1
  trap - ERR HUP INT TERM
  if [ "$MUTATED" = 1 ]; then
    echo "Release failed; restoring the four server files and Admin index" >&2
    if ! bash "$REL/rollback.sh" --from-deploy > "$REL/automatic-rollback.log" 2>&1; then
      echo "AUTOMATIC ROLLBACK FAILED: inspect $REL/automatic-rollback.log" >&2
    else
      echo "Automatic rollback verified; see $REL/automatic-rollback.log" >&2
    fi
  fi
  exit "$code"
}
trap 'failed $?' ERR
trap 'failed 129' HUP
trap 'failed 130' INT
trap 'failed 143' TERM
cd "$REL"
[ "$(sha256sum payload.tgz | awk '{print $1}')" = "$EXPECT_ARCHIVE_SHA" ]
tar -xzf payload.tgz
bash -n rollback.sh
BASE_INDEX=$(cat admin-index-base.sha256)
[ "$(wc -l < manifest.txt | tr -d ' ')" = 4 ]
[ "$(sha256sum "$DIST/index.html" | awk '{print $1}')" = "$BASE_INDEX" ] || { echo 'Admin index changed since the verified baseline' >&2; exit 1; }
[ ! -e applied ] && [ ! -e backup ]

# Validate every staged payload and every existing target before any mutation.
while read -r f before after; do
  case "$f" in server/routes/admin.js|server/routes/android-control.js|server/services/android-control/service.js|server/services/android-control/forward.js) ;; *) echo "Unexpected server path: $f" >&2; exit 1;; esac
  [ "$(sha256sum "payload/$f" | awk '{print $1}')" = "$after" ]
  [ "$(sha256sum "$LIVE/$f" | awk '{print $1}')" = "$before" ] || { echo "Baseline changed: $f" >&2; exit 1; }
  node --check "payload/$f"
done < manifest.txt
while read -r a sum; do
  [[ "$a" =~ ^[A-Za-z0-9_./-]+$ ]] && [[ "$a" != /* ]] && [[ "$a" != *..* ]]
  [ "$(sha256sum "payload/admin/$a" | awk '{print $1}')" = "$sum" ]
  [ "$a" = index.html ] && continue
  if [ -e "$DIST/$a" ]; then
    [ "$(sha256sum "$DIST/$a" | awk '{print $1}')" = "$sum" ] || { echo "Existing Admin asset differs: $a" >&2; exit 1; }
  fi
done < admin-manifest.txt
NEW_INDEX=$(awk '$1 == "index.html" {print $2}' admin-manifest.txt)
[[ "$NEW_INDEX" =~ ^[0-9a-f]{64}$ ]]
mkdir backup
while read -r f before after; do
  mkdir -p "backup/$(dirname "$f")"
  cp -p "$LIVE/$f" "backup/$f"
  [ "$(sha256sum "backup/$f" | awk '{print $1}')" = "$before" ]
done < manifest.txt
cp -p "$DIST/index.html" backup/index.html
[ "$(sha256sum backup/index.html | awk '{print $1}')" = "$BASE_INDEX" ]

# Publish verified new assets first; retain existing immutable assets unchanged.
: > new-admin-assets.txt
while read -r a sum; do
  [ "$a" = index.html ] && continue
  [ -e "$DIST/$a" ] && continue
  mkdir -p "$DIST/$(dirname "$a")"
  tmp=$(mktemp "$DIST/$(dirname "$a")/.wechat-forward-asset.XXXXXX")
  cp "payload/admin/$a" "$tmp"
  chmod 644 "$tmp"
  [ "$(sha256sum "$tmp" | awk '{print $1}')" = "$sum" ]
  # Hard-link creation fails instead of replacing a concurrently created asset.
  ln "$tmp" "$DIST/$a"
  rm "$tmp"
  printf '%s\n' "$a" >> new-admin-assets.txt
done < admin-manifest.txt

MUTATED=1
while read -r f before after; do
  tmp=$(mktemp "$LIVE/$(dirname "$f")/.wechat-forward-code.XXXXXX")
  cp "payload/$f" "$tmp"
  chmod --reference="backup/$f" "$tmp"
  chown --reference="backup/$f" "$tmp"
  [ "$(sha256sum "$tmp" | awk '{print $1}')" = "$after" ]
  mv -f "$tmp" "$LIVE/$f"
done < manifest.txt
pm2 restart onstarvoice-api > api-restart.log 2>&1
READY=0
for i in $(seq 1 30); do
  if curl --max-time 2 -fsS http://127.0.0.1:3002/api/health/ready > /dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = 1 ] || { echo 'API readiness failed' >&2; false; }
tmp=$(mktemp "$DIST/.wechat-forward-index.XXXXXX")
cp payload/admin/index.html "$tmp"
chmod --reference=backup/index.html "$tmp"
chown --reference=backup/index.html "$tmp"
[ "$(sha256sum "$tmp" | awk '{print $1}')" = "$NEW_INDEX" ]
mv -f "$tmp" "$DIST/index.html"
curl --max-time 10 -fsS http://127.0.0.1:3002/admin/ > admin-response.html
grep -q '<div id="root">' admin-response.html
curl --max-time 10 -fsS https://voice.minilife.online/api/health > public-health.json
while read -r f before after; do [ "$(sha256sum "$LIVE/$f" | awk '{print $1}')" = "$after" ]; done < manifest.txt
while read -r a sum; do [ "$(sha256sum "$DIST/$a" | awk '{print $1}')" = "$sum" ]; done < admin-manifest.txt
pm2 jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{for(const p of JSON.parse(s)){if(p.name.startsWith("onstarvoice")) console.log(p.name,p.pid,p.pm2_env.status);}})' > process-status.txt
date -Is > applied
MUTATED=0
echo "Applied and verified: $REL"
echo "Rollback command: bash $REL/rollback.sh"
cat process-status.txt
REMOTE
echo "Local release evidence: $STAGE"
