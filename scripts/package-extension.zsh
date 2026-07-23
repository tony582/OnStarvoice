#!/bin/zsh
set -euo pipefail

if (( $# > 1 )); then
  print -u2 "用法: scripts/package-extension.zsh [输出 zip 路径]"
  exit 1
fi

script_dir=${0:A:h}
repo_root=${script_dir:h}
build_dir="$repo_root/extension-build"
output_path=${1:-"$repo_root/StarVoice-extension.zip"}
package_stage=$(mktemp -d "${TMPDIR:-/tmp}/starvoice-extension-package.XXXXXX")
package_file="$package_stage/StarVoice-extension.zip"

cleanup() {
  rm -rf "$package_stage"
}
trap cleanup EXIT INT TERM

# Customer packages are always rebuilt from the production target. This makes
# it impossible for a preceding local test sync to leak localhost into a zip.
zsh "$script_dir/sync-extension-build.zsh" production

runtime_config="$build_dir/utils/runtime-config.js"
if [[ ! -f "$runtime_config" ]] ||
  ! grep -Fq '"production"' "$runtime_config" ||
  ! grep -Fq 'https://voice.minilife.online' "$runtime_config" ||
  grep -Eq 'https?://(localhost|127\.0\.0\.1)' "$runtime_config"; then
  print -u2 "扩展运行配置不是安全的生产目标，已停止打包"
  exit 1
fi

(
  cd "$build_dir"
  zip -q -r "$package_file" .
)

if unzip -p "$package_file" utils/runtime-config.js |
  grep -Eq 'https?://(localhost|127\.0\.0\.1)'; then
  print -u2 "扩展包仍包含本地 API 地址，已停止交付"
  exit 1
fi

mkdir -p "${output_path:h}"
mv -f "$package_file" "$output_path"
print "StarVoice production extension package: $output_path"
