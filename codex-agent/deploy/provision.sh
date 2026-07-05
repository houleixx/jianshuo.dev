#!/usr/bin/env bash
# 首次开服 —— 在 VPS 上以 root 跑，幂等。
# Node/Caddy 这台机器已有（lab/paint 装的），这里只补 codex CLI、用户/组、凭证组权限、sudoers、unit。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▸ codex CLI"
command -v codex >/dev/null || npm i -g @openai/codex
codex --version

echo "▸ user"
id -u codex-agent >/dev/null 2>&1 || useradd --system --home /opt/codex-agent --shell /usr/sbin/nologin codex-agent

# 注意（2026-07-05 实机教训）：不要和 paint 共享 /opt/paint/.codex——
# gpt-image-2-skill 写的 auth.json（last_refresh 为 epoch 数字）codex CLI 解析不了
# （它要 RFC3339），谁刷新谁弄坏对方。codex-agent 用自己的独立登录：
#   ssh -t -L 1455:localhost:1455 root@VPS \
#     "sudo -u codex-agent CODEX_HOME=/opt/codex-agent/.codex HOME=/opt/codex-agent codex login"
#   然后在本机浏览器完成 OAuth（回调经端口转发落回 VPS）。

echo "▸ dirs"
mkdir -p /opt/codex-agent/workspace /opt/codex-agent/.codex
chown -R codex-agent:codex-agent /opt/codex-agent

echo "▸ sudoers 白名单（管 VPS 的爆炸半径就是这几行）"
cat > /etc/sudoers.d/codex-agent <<'EOF'
codex-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart paint, /usr/bin/systemctl restart claude-agent, /usr/bin/systemctl restart codex-agent, /usr/bin/systemctl restart caddy, /usr/bin/systemctl reload caddy, /usr/bin/systemctl status *, /usr/bin/journalctl *
EOF
chmod 440 /etc/sudoers.d/codex-agent
visudo -cf /etc/sudoers.d/codex-agent

echo "▸ systemd unit"
install -m 644 "$HERE/codex-agent.service" /etc/systemd/system/codex-agent.service
systemctl daemon-reload
systemctl enable codex-agent >/dev/null

echo "▸ Caddy 段（手动步骤）"
echo "  1) caddy hash-password --plaintext '<新密码>'"
echo "  2) 把 $HERE/Caddyfile.snippet 换上 hash 后追加进 /etc/caddy/Caddyfile"
echo "  3) systemctl reload caddy"
echo "▸ DNS（手动步骤）：Cloudflare 加 A 记录 codex.jianshuo.dev → 66.42.45.128（灰云）"
echo "✓ provisioned"
