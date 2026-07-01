#!/usr/bin/env bash
# 本地 build → 同步到 VPS → 装 prod 依赖 → 重启。首次开服见 deploy/provision.sh。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/paint}"
cd "$(dirname "$0")"
echo "▸ build"; npm run build
echo "▸ test"; npm test
echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude data --exclude .codex --exclude '*.log' \
  dist public package.json package-lock.json deploy \
  "$VPS:$REMOTE/"
echo "▸ install + restart"
ssh "$VPS" "cd $REMOTE && npm ci --omit=dev && chown -R paint:paint $REMOTE/dist $REMOTE/public && systemctl restart paint && sleep 1 && systemctl --no-pager --lines=8 status paint | head -12"
echo "✓ deployed"
