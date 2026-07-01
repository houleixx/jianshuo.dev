#!/usr/bin/env bash
# 首次开服 —— 在 VPS 上以 root 运行，幂等。装 Node20+Caddy、建 paint 用户/目录、
# 装 gpt-image-2-skill、装 systemd unit。密钥(.env / Caddyfile hash / auth.json)另放，不进 git。
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
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
caddy version

echo "▸ gpt-image-2-skill (npm 全局)"
npm i -g gpt-image-2-skill@latest
gpt-image-2-skill --version || true

echo "▸ user + dirs"
id -u paint >/dev/null 2>&1 || useradd --system --home /opt/paint --shell /usr/sbin/nologin paint
mkdir -p /opt/paint/data/jobs /opt/paint/data/results /opt/paint/data/inputs /opt/paint/.codex
chown -R paint:paint /opt/paint

echo "▸ systemd unit"
install -m 644 "$HERE/paint.service" /etc/systemd/system/paint.service
systemctl daemon-reload
systemctl enable paint >/dev/null

cat <<'NEXT'
✓ provisioned. 接下来（都不进 git）:
  1) 放 /opt/paint/.env (chmod 600, owner paint) —— 见 .env.example
  2) 拷 Codex 订阅: scp ~/.codex/auth.json root@vps:/opt/paint/.codex/auth.json
     chown paint:paint /opt/paint/.codex/auth.json && chmod 600 /opt/paint/.codex/auth.json
  3) 验证订阅可用: sudo -u paint CODEX_HOME=/opt/paint/.codex gpt-image-2-skill --json auth inspect
  4) Caddyfile 填 hash: caddy hash-password --plaintext '你的密码' → 写进 /etc/caddy/Caddyfile 的 paint 段 → systemctl reload caddy
  5) systemctl start paint
NEXT
