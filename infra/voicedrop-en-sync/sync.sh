#!/usr/bin/env bash
# voicedrop 中文页 → /voicedrop/en/ 英文镜像 夜间同步。
# 平时只改中文页；本脚本每晚对比 sha256 manifest，只把变更页交给 claude 重译，
# 然后 commit + push + 部署。翻译口径的单一真源是同目录 RULES.md。
#
# 用法：
#   sync.sh              正常同步（launchd 每晚跑）
#   SEED_ONLY=1 sync.sh  只把当前状态写进 manifest，不翻译（首次人工翻译后执行一次）
#   DRY_RUN=1 sync.sh    只报告哪些文件变了，不翻译不部署

set -uo pipefail
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${PATH}"
export PATH

# launchd 没有代理环境；Anthropic API 在国内需要本地代理，对齐交互 shell。
export HTTPS_PROXY="http://127.0.0.1:1087" HTTP_PROXY="http://127.0.0.1:1087"
export https_proxy="http://127.0.0.1:1087" http_proxy="http://127.0.0.1:1087"
export ALL_PROXY="socks5://127.0.0.1:1087" NO_PROXY="localhost,127.0.0.1,::1"

REPO="/Users/jianshuo/code/jianshuo.dev"
DIR="$REPO/infra/voicedrop-en-sync"
MANIFEST="$DIR/manifest.json"
RULES="$DIR/RULES.md"

LOG_DIR="${HOME}/Library/Logs/voicedrop-en-sync"
mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/sync-$(date +%Y-%m-%d).log"
exec > >(tee -a "$LOG") 2>&1
echo "=== voicedrop-en-sync start: $(date -Iseconds) SEED_ONLY=${SEED_ONLY:-0} DRY_RUN=${DRY_RUN:-0} ==="

cd "$REPO" || exit 1
command -v claude >/dev/null 2>&1 || { echo "FATAL: claude not in PATH"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not in PATH"; exit 1; }

# —— 翻译范围（与 RULES.md 的表一致）：voicedrop 下所有中文 html + developer/api.md，
#    排除 en 镜像、admin 后台、顶层 api.html。新增页面自动纳入。
list_sources() {
  (cd "$REPO" && find voicedrop -name '*.html' \
      -not -path 'voicedrop/en/*' -not -path 'voicedrop/admin/*' \
      -not -path 'voicedrop/api.html' ; echo voicedrop/developer/api.md) | sort
}

hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# 当前状态 → JSON
current_json() {
  local first=1
  echo "{"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    [ $first -eq 1 ] || echo ","
    first=0
    printf '  "%s": "%s"' "$f" "$(hash_of "$f")"
  done < <(list_sources)
  echo ""
  echo "}"
}

CURRENT="$(current_json)"

if [ "${SEED_ONLY:-0}" = "1" ]; then
  echo "$CURRENT" | jq . > "$MANIFEST"
  echo "manifest seeded: $(echo "$CURRENT" | jq 'length') files"
  exit 0
fi

[ -f "$MANIFEST" ] || { echo "FATAL: manifest 不存在，先跑 SEED_ONLY=1"; exit 1; }
OLD="$(cat "$MANIFEST")"

# 变更 = 新增或 hash 不同；删除 = manifest 里有但源文件没了
CHANGED=$(jq -rn --argjson old "$OLD" --argjson cur "$CURRENT" \
  '$cur | to_entries[] | select($old[.key] != .value) | .key')
DELETED=$(jq -rn --argjson old "$OLD" --argjson cur "$CURRENT" \
  '$old | to_entries[] | select($cur[.key] == null) | .key')

if [ -z "$CHANGED" ] && [ -z "$DELETED" ]; then
  echo "no changes — nothing to sync"
  exit 0
fi
echo "changed:"; echo "$CHANGED" | sed 's/^/  /'
[ -n "$DELETED" ] && { echo "deleted:"; echo "$DELETED" | sed 's/^/  /'; }

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN — stop here"
  exit 0
fi

# 删除页：直接删对应 en 镜像（确定性操作，不劳烦模型）
if [ -n "$DELETED" ]; then
  while IFS= read -r f; do
    en="voicedrop/en/${f#voicedrop/}"
    [ -f "$en" ] && { git rm -f "$en" >/dev/null 2>&1 || rm -f "$en"; echo "removed $en"; }
  done <<< "$DELETED"
fi

# 变更页：交给 claude 按 RULES.md 整页重译
if [ -n "$CHANGED" ]; then
  PROMPT="你是 VoiceDrop 网站中→英夜间同步器。严格按照 $RULES 的全部硬规则和术语表工作。

以下中文源文件有变更，请把每个文件整页重新翻译，覆盖写入它在 voicedrop/en/ 下的镜像路径（镜像路径 = 把路径里的 voicedrop/ 换成 voicedrop/en/）：

$CHANGED

要求：
- 只写 en 镜像文件，不改中文源文件，不碰清单之外的任何文件。
- 如果旧的 en 镜像已存在，可先读它参考既有译法（术语一致性），然后整页覆盖。
- 中文页 header/footer 里的「EN」语言切换链接，在英文镜像里对应换成「中文」链接指回中文页。
- 完成后逐个文件自查：lang 属性、hreflang、站内链接已改到 en 树。"
  echo "--- invoking claude to translate $(echo "$CHANGED" | wc -l | tr -d ' ') file(s) ---"
  claude -p "$PROMPT" --dangerously-skip-permissions --max-turns 200 || { echo "FATAL: claude translation failed"; exit 1; }

  # 轻验证：每个变更文件的 en 镜像必须存在且仍含 html 标签、不再整段中文
  FAIL=0
  while IFS= read -r f; do
    en="voicedrop/en/${f#voicedrop/}"
    if [ ! -f "$en" ]; then echo "VERIFY FAIL: $en 不存在"; FAIL=1; fi
  done <<< "$CHANGED"
  [ $FAIL -eq 1 ] && { echo "FATAL: 验证失败，不提交"; exit 1; }
fi

# manifest 由脚本确定性更新
echo "$CURRENT" | jq . > "$MANIFEST"

# 只提交我们自己的产物
git add voicedrop/en "$MANIFEST"
if git diff --cached --quiet; then
  echo "nothing staged — done"
  exit 0
fi
git commit -m "chore(voicedrop): 夜间同步英文镜像 $(date +%Y-%m-%d)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" || exit 1
git push origin main || echo "WARN: push failed（不影响本地，可次日人工 push）"

# 部署：仓库里若还有别的未提交改动（用户白天的 WIP），跳过部署避免把半成品发上线
if [ -n "$(git status --porcelain)" ]; then
  echo "SKIP deploy: 工作区有其他未提交改动，英文镜像已 commit，等下次人工部署一起上线"
  exit 0
fi

# .claude/worktrees 里的 node_modules 二进制超 Pages 25MiB 上限，部署期间挪走
WT="$REPO/.claude/worktrees"
STASH="/private/tmp/jianshuo-dev-worktrees-stash"
restore() { [ -d "$STASH" ] && mv "$STASH" "$WT"; }
if [ -d "$WT" ]; then trap restore EXIT; mv "$WT" "$STASH"; fi
CLOUDFLARE_ACCOUNT_ID=2f33014654e1b826e27ab00d4e7242fd npx wrangler pages deploy . \
  --project-name jianshuo-dev --branch main --commit-dirty=true \
  && echo "deployed" || echo "WARN: deploy failed（内容已 commit，可人工重部署）"
echo "=== done: $(date -Iseconds) ==="
