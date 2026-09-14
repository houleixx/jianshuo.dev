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

- `src/server.ts` — localhost HTTP server. `POST /api/chat` runs `query()` and streams SSE;
  `GET /api/sessions` lists past conversations and `GET|DELETE /api/sessions/:id` reads/removes
  one (parsed from the SDK's on-disk transcripts under `$HOME/.claude/projects/`).
  `POST /api/book` / `/api/book/revise` charge, write an `inflight/<id>.json`, and hand the job
  to systemd (below) — the web process never runs a book itself.
- `src/book-launch.ts` — `systemd-run --user --unit=book-<jobId> … node dist/book-runner.js <inflight.json>`.
  Books run as transient units under the `claude-agent` user manager (`loginctl enable-linger`),
  in a different cgroup from `claude-agent.service`: deploy/restart/crash of the web process
  never kills a book. On startup the web process only re-launches inflight records whose unit
  is no longer active (VPS reboot, runner OOM).
- Concurrency: at most `MAX_CONCURRENT_BOOKS` (default 2) book/revise units run at once. New orders are
  written to `inflight/` with `attempts: 0` and a serialized pump (startup, every 30s, after each order)
  launches them oldest-first as slots free up; the 202 response carries `queued` / `queue_position`.
- `src/book-runner.ts` — one job per process: reads the inflight JSON, runs the three-leg engine
  (`src/book-engine.ts`: kimi → codex → claude), then does all the finishing itself
  (`src/bookmeta.ts`: R2 thread registry, refund, APNs, community post) and deletes the inflight file.
- `public/index.html` — single-file light-theme chat UI; tool calls render as expandable cards;
  left sidebar lists past sessions (click to reopen + resume, persists server-side across devices).
- `deploy/` — `provision.sh` (one-time), `claude-agent.service` (systemd), `Caddyfile`.
- `deploy.sh` — build + rsync + restart. Also syncs `skills/` → VPS `.claude/skills/` (with
  `--delete`, so this repo is the source of truth — edit skills here, not on the VPS).
- `skills/` — the agent's Claude Code skills (wjs-voicedrop*, writing-book, etc.), deployed
  to `/opt/claude-agent/.claude/skills/`.

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
./deploy.sh        # rebuild + sync + restart (safe while books are running)
```

## Books in flight

```bash
ssh root@66.42.45.128 "systemctl --user -M claude-agent@ list-units 'book-*' 'revise-*'"   # what is running
ssh root@66.42.45.128 "journalctl _SYSTEMD_USER_UNIT=book-<jobId>.service -f"                # one book's log
ssh root@66.42.45.128 "systemctl --user -M claude-agent@ stop book-<jobId>"                  # cancel one
ssh root@66.42.45.128 "ls /opt/claude-agent/inflight"                                        # the same list, as files
```

A stopped/cancelled book leaves its inflight file behind; the pump re-launches it within 30s (up to 2
attempts total), so delete the inflight file first if you really want it gone.

Caddy note: `systemctl reload caddy` can fail on this box with `Failed to set up mount namespacing:
/run/systemd/unit-root/tmp` (a systemd sandbox quirk, config is fine). Reload through the admin API instead:
`caddy reload --config /etc/caddy/Caddyfile`.

## Local dev

```bash
npm install
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' > .env   # or ANTHROPIC_API_KEY
WORKSPACE=$PWD/workspace npm run dev
# open http://127.0.0.1:8787  (no auth locally)
```
