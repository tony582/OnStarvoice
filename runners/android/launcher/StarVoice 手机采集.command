#!/bin/bash
# Double-click launcher for the StarVoice Android runner (macOS).
# It makes adb/node reachable, moves to the runner directory and runs the one-click `up` command.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# Prefer an nvm-managed node if one is installed; ignore if nvm is absent.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR/.." || { echo "找不到 Runner 目录"; exit 1; }

# Default state directory; a sibling launcher.json { "stateDir": "..." } overrides it.
STATE_DIR="$HOME/Library/Application Support/StarVoice Android/state"
if [ -f "$DIR/launcher.json" ]; then
  FROM_JSON="$(node -e 'try{const c=require(process.argv[1]);if(c&&c.stateDir)process.stdout.write(String(c.stateDir))}catch(e){}' "$DIR/launcher.json" 2>/dev/null)"
  [ -n "$FROM_JSON" ] && STATE_DIR="$FROM_JSON"
fi

echo "StarVoice 手机采集 — 状态目录：$STATE_DIR"
echo "（请保持手机解锁常亮、抖音已登录；首次运行会提示输入激活码，激活码不会被保存）"
exec node cli.mjs up --state-dir "$STATE_DIR"
