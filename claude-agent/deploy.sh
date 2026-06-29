#!/usr/bin/env bash
# Build locally, sync to the VPS, reinstall prod deps, restart the service.
# First-time provisioning (node, caddy, user, dirs, units) is in deploy/provision.sh.
set -euo pipefail

VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/claude-agent}"

cd "$(dirname "$0")"
echo "▸ build"
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude workspace --exclude '*.log' \
  dist public package.json package-lock.json deploy \
  "$VPS:$REMOTE/"

echo "▸ install + restart"
ssh "$VPS" "cd $REMOTE && npm ci --omit=dev && systemctl restart claude-agent && sleep 1 && systemctl --no-pager --lines=8 status claude-agent | head -12"
echo "✓ deployed"
