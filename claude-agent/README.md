# claude-agent

A persistent web chat backed by the **Anthropic Claude Agent SDK**, running on the
Tokyo VPS and exposed at **https://lab.jianshuo.dev**. It runs the full
Claude Code agent loop (tools, bash, web) confined to a sandbox workspace, and
streams every tool call live to the browser.

Design spec: `../docs/superpowers/specs/2026-06-29-claude-agent-vps-design.md`

## Shape

```
browser ──HTTPS+password──▶ Caddy ──▶ Node (this) ──query()──▶ Claude Agent SDK
                                            └─ tools confined to /opt/claude-agent/workspace
```

- `src/server.ts` — localhost HTTP server, `POST /api/chat` runs `query()` and streams SSE.
- `public/index.html` — single-file light-theme chat UI; tool calls render as expandable cards.
- `deploy/` — `provision.sh` (one-time), `claude-agent.service` (systemd), `Caddyfile`.
- `deploy.sh` — build + rsync + restart.

## Auth

Uses `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription, no API billing). **Single-user
only** per Anthropic ToS — don't share the password. To go multi-user, swap to
`ANTHROPIC_API_KEY` in `.env`.

## First deploy

```bash
# 1. provision the box (once)
rsync -az deploy root@66.42.45.128:/opt/claude-agent/
ssh root@66.42.45.128 'bash /opt/claude-agent/deploy/provision.sh'

# 2. token (run locally; interactive browser login)
claude setup-token            # → paste into /opt/claude-agent/.env on the VPS (chmod 600)

# 3. password gate
ssh root@66.42.45.128 'caddy hash-password --plaintext "YOUR_PASSWORD"'   # → put hash in /etc/caddy/Caddyfile

# 4. DNS: lab.jianshuo.dev  A  66.42.45.128  (Cloudflare, DNS-only)

# 5. ship code + start
./deploy.sh
ssh root@66.42.45.128 'systemctl start claude-agent && systemctl reload caddy'
```

## Update

```bash
./deploy.sh        # rebuild + sync + restart
```

## Local dev

```bash
npm install
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' > .env   # or ANTHROPIC_API_KEY
WORKSPACE=$PWD/workspace npm run dev
# open http://127.0.0.1:8787  (no auth locally)
```
