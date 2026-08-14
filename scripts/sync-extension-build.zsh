#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(dirname -- "$script_dir")
build_dir="$repo_root/extension-build"
stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/starvoice-extension-build.XXXXXX")
build_target=${1:-production}

if (( $# > 1 )); then
  printf '%s\n' "用法: scripts/sync-extension-build.zsh [production|local]" >&2
  exit 1
fi

if [[ "$build_target" != "production" && "$build_target" != "local" ]]; then
  printf '%s\n' "未知扩展目标: $build_target（只支持 production 或 local）" >&2
  exit 1
fi

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT INT TERM

for source_file in manifest.json background.js content-loader.js content-v2.js; do
  if [[ ! -f "$repo_root/$source_file" ]]; then
    printf '%s\n' "缺少扩展入口文件: $source_file" >&2
    exit 1
  fi
  rsync -a "$repo_root/$source_file" "$stage_dir/$source_file"
done

for source_dir in images sidebar utils; do
  if [[ ! -d "$repo_root/$source_dir" ]]; then
    printf '%s\n' "缺少扩展源码目录: $source_dir" >&2
    exit 1
  fi
  mkdir -p "$stage_dir/$source_dir"
  rsync -a --delete --exclude '.DS_Store' "$repo_root/$source_dir/" "$stage_dir/$source_dir/"
done

if [[ "$build_target" == "local" ]]; then
  local_config="$repo_root/scripts/extension-runtime-config.local.js"
  if [[ ! -f "$local_config" ]]; then
    printf '%s\n' "缺少本地扩展配置: $local_config" >&2
    exit 1
  fi
  rsync -a "$local_config" "$stage_dir/utils/runtime-config.js"
fi

python_bin=${PYTHON_EXECUTABLE:-$(command -v python3 || true)}
if [[ -z "$python_bin" ]]; then
  printf '%s\n' "找不到 Python 3，无法校验 manifest.json" >&2
  exit 1
fi
"$python_bin" -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$stage_dir/manifest.json"

if find "$stage_dir" -type f \( -name '*.pem' -o -name '*.crx' -o -name '*.zip' -o -name '.env*' \) -print -quit | grep -q .; then
  printf '%s\n' "构建快照意外包含密钥、安装包或环境配置，已停止同步" >&2
  exit 1
fi

mkdir -p "$build_dir"
rsync -a --delete --delete-excluded --exclude '.DS_Store' "$stage_dir/" "$build_dir/"

if ! diff -qr "$stage_dir" "$build_dir" >/dev/null; then
  printf '%s\n' "扩展快照与源码 staging 不一致，已停止验收" >&2
  diff -qr "$stage_dir" "$build_dir" >&2 || true
  exit 1
fi

if find "$build_dir" -type f \( -name '*.pem' -o -name '*.crx' -o -name '*.zip' -o -name '.env*' -o -name '.DS_Store' \) -print -quit | grep -q .; then
  printf '%s\n' "构建快照包含禁止交付的文件，已停止验收" >&2
  exit 1
fi

file_count=$(find "$build_dir" -type f | wc -l | tr -d ' ')
printf '%s\n' "StarVoice extension snapshot synchronized: $build_dir ($file_count files, target=$build_target)"
if [[ "$build_target" == "local" ]]; then
  printf '%s\n' "注意: 当前 extension-build 仅供 localhost 联调；客户包必须使用 scripts/package-extension.zsh 生成。" >&2
fi
