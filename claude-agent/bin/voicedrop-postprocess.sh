#!/usr/bin/env bash
# VoiceDrop 文章后处理轮询（VPS 版）。systemd: voicedrop-postprocess.timer 每 5 分钟。
# 「文章即事件」：挖矿侧零改动。廉价检查 = 一次 D1 REST 查询（curl，不装 wrangler）；
# 发现新文章才起 claude -p 跑 /wjs-voicedrop-post-processing <stem>。
# 状态：/opt/claude-agent/postprocess/{cursor,done/,fail/}（cursor 拨小可补历史）
# 密钥：/opt/claude-agent/.env（CLAUDE_CODE_OAUTH_TOKEN）+ postprocess.env（CF token/ids）
set -euo pipefail

BASE=/opt/claude-agent
STATE=$BASE/postprocess
LOG=$STATE/postprocess.log
source "$BASE/.env"
source "$BASE/postprocess.env"   # CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DB_ID
export CLAUDE_CODE_OAUTH_TOKEN

USER_SUB="users/anon-ae209ac53499d51d513425503bd134b0/"
MAX_PER_RUN=3
MAX_FAILS=3
mkdir -p "$STATE/done" "$STATE/fail"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 防重叠（systemd oneshot 本身不叠，这里防手动运行撞车）
exec 9>"$STATE/lock"
flock -n 9 || exit 0

# 游标：首跑初始化为现在（只处理未来的新文章）
[ -f "$STATE/cursor" ] || echo $(( $(date +%s) * 1000 )) > "$STATE/cursor"
CURSOR=$(cat "$STATE/cursor")

# 廉价检查：D1 REST 一条查询
ROWS=$(curl -sS -m 20 "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$D1_DB_ID/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data "{\"sql\":\"SELECT stem, created_ms FROM articles WHERE user_sub='$USER_SUB' AND created_ms > $CURSOR ORDER BY created_ms ASC LIMIT $MAX_PER_RUN\"}" \
  | node -e '
let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
  const j = JSON.parse(d);
  if (!j.success) { console.error(JSON.stringify(j.errors)); process.exit(3); }
  for (const r of j.result[0].results) console.log(r.created_ms + "\t" + r.stem);
});') || { log "WARN: d1 query failed"; exit 0; }
[ -z "$ROWS" ] && exit 0   # 没新文章，静默收工

while IFS=$'\t' read -r MS STEM; do
  [ -n "$STEM" ] || continue
  KEY=$(printf '%s' "$STEM" | sha1sum | cut -d' ' -f1)

  if [ -f "$STATE/done/$KEY" ]; then
    echo "$MS" > "$STATE/cursor"; continue
  fi

  FAILS=$(cat "$STATE/fail/$KEY" 2>/dev/null || echo 0)
  if [ "$FAILS" -ge "$MAX_FAILS" ]; then
    log "SKIP after $FAILS fails: $STEM"
    echo "skipped" > "$STATE/done/$KEY"; echo "$MS" > "$STATE/cursor"
    continue
  fi

  log "processing: $STEM"
  set +e
  claude -p "/wjs-voicedrop-post-processing $STEM" \
    --mcp-config "$STATE/mcp.json" --strict-mcp-config \
    --allowedTools "Read,Write,Edit,mcp__voicedrop" \
    --disallowedTools "mcp__voicedrop__publish_wechat,mcp__voicedrop__delete_article,mcp__voicedrop__share_to_community,mcp__voicedrop__unshare_from_community,mcp__voicedrop__xhs_pack,mcp__voicedrop__share_link,mcp__voicedrop__feed_coin,mcp__voicedrop__share_prompt,mcp__voicedrop__unshare_prompt,mcp__voicedrop__write_style,mcp__voicedrop__set_style_version,mcp__voicedrop__import_prompt,mcp__voicedrop__collect_style_sample" \
    >> "$LOG" 2>&1
  RC=$?
  set -e

  if [ $RC -eq 0 ]; then
    echo "$STEM" > "$STATE/done/$KEY"; rm -f "$STATE/fail/$KEY"
    echo "$MS" > "$STATE/cursor"
    log "done: $STEM"
  else
    echo $(( FAILS + 1 )) > "$STATE/fail/$KEY"
    log "FAIL (rc=$RC, attempt $(( FAILS + 1 ))/$MAX_FAILS): $STEM"
    break   # 游标不动，下一轮重试
  fi
done <<< "$ROWS"
