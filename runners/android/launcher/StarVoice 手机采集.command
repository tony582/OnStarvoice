#!/bin/bash
# Double-click launcher for the StarVoice Android runner (macOS).
# It makes adb/node reachable, moves to the runner directory and runs the one-click `up` command.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# Prefer an nvm-managed node if one is installed; ignore if nvm is absent.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
# The runner needs Node 24. A login profile can put an older node first on PATH even when nvm's
# default is 24, so pick an installed 24.x explicitly instead of trusting whatever `node` resolves to.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ] && command -v nvm >/dev/null 2>&1; then nvm use 24 >/dev/null 2>&1; fi
if [ "$(node_major)" -lt 24 ]; then
  for candidate in "$HOME"/.nvm/versions/node/v24*/bin /opt/homebrew/opt/node@24/bin; do
    if [ -x "$candidate/node" ]; then PATH="$candidate:$PATH"; break; fi
  done
fi
if [ "$(node_major)" -lt 24 ]; then
  echo "需要 Node.js 24（当前：$(node --version 2>/dev/null || echo 未安装)）。请安装 Node 24 后再双击启动。"
  read -r -p "按回车关闭窗口" _
  exit 1
fi

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
