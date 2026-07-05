#!/usr/bin/env bash
# 本地 test+build → rsync → 重启。首次开服先跑 deploy/provision.sh。
# 零运行时依赖，VPS 上不需要 npm ci。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/codex-agent}"

cd "$(dirname "$0")"
echo "▸ test + build"
npm test
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude workspace --exclude sessions.json --exclude '*.log' \
  dist public package.json deploy \
  "$VPS:$REMOTE/"

echo "▸ restart"
ssh "$VPS" "systemctl restart codex-agent && sleep 1 && systemctl --no-pager status codex-agent | head -8"
echo "✓ deployed"
