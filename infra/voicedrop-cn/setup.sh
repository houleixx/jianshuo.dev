#!/usr/bin/env bash
# voicedrop.cn 备案接入点一键重建脚本(腾讯云那台机器随时可能释放——本目录就是全部真相)。
# 在一台全新 Ubuntu 上以 sudo 权限运行:安装 Caddy → 写入本目录的 Caddyfile → 起服务。
# 之后:1) 腾讯云防火墙/安全组放行 TCP 80 + 443;
#      2) Cloudflare 把 voicedrop.cn / www 的 A 记录指到新机器 IP(proxied=false):
#         curl -X PUT "https://api.cloudflare.com/client/v4/zones/206722cd14c10dbaa28f35e9d933e287/dns_records/<记录id>" \
#           -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
#           -d '{"type":"A","name":"voicedrop.cn","content":"<新IP>","proxied":false,"ttl":300}'
#      3) Caddy 会自动向 Let's Encrypt 签证书(80 端口 HTTP-01),几分钟内 HTTPS 就绪。
# 回滚(不要箱子了/箱子挂了):DNS 改回 CNAME → jianshuo-dev.pages.dev(proxied=true),
# 分享短链 voicedrop.cn/<id> 由 Pages functions/[token].js 兜底继续可用(整站映射会退化)。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v caddy >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
fi

sudo cp Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
echo "OK — 等 DNS 指过来后,Caddy 会自动完成 HTTPS。"
