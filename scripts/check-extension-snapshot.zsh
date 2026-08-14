#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(dirname -- "$script_dir")
snapshot_dir="$repo_root/extension-build"

bash "$script_dir/sync-extension-build.zsh" production

for source_file in manifest.json background.js content-loader.js content-v2.js; do
  diff -q "$repo_root/$source_file" "$snapshot_dir/$source_file" >/dev/null
done

for source_dir in images sidebar utils; do
  source_list=$(mktemp "${TMPDIR:-/tmp}/starvoice-source-list.XXXXXX")
  snapshot_list=$(mktemp "${TMPDIR:-/tmp}/starvoice-snapshot-list.XXXXXX")
  trap 'rm -f "$source_list" "$snapshot_list"' EXIT INT TERM

  (
    cd "$repo_root/$source_dir"
    find . -type f ! -name '.DS_Store' -print | LC_ALL=C sort
  ) > "$source_list"
  (
    cd "$snapshot_dir/$source_dir"
    find . -type f ! -name '.DS_Store' -print | LC_ALL=C sort
  ) > "$snapshot_list"

  diff -q "$source_list" "$snapshot_list" >/dev/null
  while IFS= read -r relative_file; do
    diff -q \
      "$repo_root/$source_dir/$relative_file" \
      "$snapshot_dir/$source_dir/$relative_file" >/dev/null
  done < "$source_list"

  rm -f "$source_list" "$snapshot_list"
  trap - EXIT INT TERM
done

if grep -n -E 'https?://(localhost|127\.0\.0\.1)(:|/|$)' "$snapshot_dir/utils/runtime-config.js" >/dev/null; then
  printf '%s\n' 'Extension production runtime config contains a localhost API origin.' >&2
  exit 1
fi

if ! grep -q 'https://voice\.minilife\.online' "$snapshot_dir/utils/runtime-config.js"; then
  printf '%s\n' 'Extension production snapshot is missing the approved API origin.' >&2
  exit 1
fi

if ! grep -q '"production"' "$snapshot_dir/utils/runtime-config.js"; then
  printf '%s\n' 'Extension production snapshot is missing its production target marker.' >&2
  exit 1
fi

printf '%s\n' "StarVoice extension delivery snapshot verified: $snapshot_dir"
