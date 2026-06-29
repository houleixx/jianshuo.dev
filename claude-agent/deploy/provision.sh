#!/usr/bin/env bash
# First-time VPS provisioning — run AS ROOT on the VPS. Idempotent.
#   installs Node 20 + Caddy, creates the claude-agent user + dirs, installs the
#   systemd unit. Secrets (.env token, Caddyfile password hash) are placed
#   separately so they never live in git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▸ Node 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "▸ Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
caddy version

echo "▸ user + dirs"
id -u claude-agent >/dev/null 2>&1 || useradd --system --home /opt/claude-agent --shell /usr/sbin/nologin claude-agent
mkdir -p /opt/claude-agent/workspace
chown -R claude-agent:claude-agent /opt/claude-agent

echo "▸ systemd unit"
install -m 644 "$HERE/claude-agent.service" /etc/systemd/system/claude-agent.service
systemctl daemon-reload
systemctl enable claude-agent >/dev/null

echo "✓ provisioned. Next: place /opt/claude-agent/.env (chmod 600) and the hashed Caddyfile, then start."
