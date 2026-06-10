#!/usr/bin/env bash
# ==========================================================================
# machine-setup — 在新 Mac（Apple Silicon）上复刻王建硕的开发环境
#
#   bash setup.sh           # 全套，逐步确认
#   bash setup.sh --yes     # 全套，不再逐步确认
#   bash setup.sh brew      # 只跑某一步：brew / runtimes / npm / dotfiles / claude / extras
#
# 幂等：每步都可重复跑。密钥不在脚本里，见 env.example。
# ==========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
NODE_VERSION="22"          # nvm 默认 node 大版本（旧机器为 v22.22.3）

# --------------------------------------------------------------------------
# 自举：本脚本被单独 curl 下来跑时（身边没有 Brewfile 等配套文件），
# 先从 jianshuo.dev 镜像拉安装所需文件到 ~/code/machine-setup 再继续。
# 镜像由 publish-web.sh 在每次 commit 后自动同步，见 README「发布到 jianshuo.dev」。
#   curl -fsSL https://jianshuo.dev/setup/setup.sh | bash -s -- --yes
if [ ! -f "$HERE/Brewfile" ]; then
  MIRROR="https://jianshuo.dev/setup/machine-setup.tar.gz"
  printf "\033[1;36m==> 单文件模式：从 %s 自举安装文件到 ~/code/machine-setup\033[0m\n" "$MIRROR"
  mkdir -p "$HOME/code"
  curl -fsSL "$MIRROR" | tar -xz -C "$HOME/code"
  [ -f "$HOME/code/machine-setup/Brewfile" ] || { echo "!! 自举失败：镜像不完整"; exit 1; }
  # curl | bash 时 stdin 是管道：重新接回终端，不带 --yes 的交互确认才能用
  if [ -e /dev/tty ]; then
    exec bash "$HOME/code/machine-setup/setup.sh" "$@" </dev/tty
  else
    exec bash "$HOME/code/machine-setup/setup.sh" "$@"
  fi
fi

AUTO=0
[ "${1:-}" = "--yes" ] && { AUTO=1; shift; }
ONLY="${1:-all}"

c(){ printf "\033[1;36m==> %s\033[0m\n" "$*"; }
ok(){ printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m  ! %s\033[0m\n" "$*"; }
ask(){ [ "$AUTO" = 1 ] && return 0; read -r -p "  $1 [Y/n] " a; [ -z "$a" ] || [[ "$a" =~ ^[Yy] ]]; }
run(){ [ "$ONLY" = all ] || [ "$ONLY" = "$1" ]; }

# --------------------------------------------------------------------------
# 最早执行：从 iCloud 备份恢复 ~/.ssh 和 ~/code/.env（密钥不进 git/镜像，手动输密码解密）。
# 备份由「打 zip 存进 iCloud 重要文档」生成：ssh-backup-*.zip，密码自带。
# zip 内路径都相对 $HOME（.ssh/* 和 code/.env），unzip -d $HOME 一次性还原到位。
# 这步先跑：repos（git clone）才有 SSH key，且 .env 抢在 dotfiles 的占位符 seed 之前就位。
step_ssh(){
  run ssh || return 0
  c "恢复 SSH key + ~/code/.env（从 iCloud 加密备份）"
  if [ -f "$HOME/.ssh/id_ed25519" ]; then
    ok "~/.ssh/id_ed25519 已存在，跳过恢复"; return 0
  fi
  local dir="$HOME/Library/Mobile Documents/com~apple~CloudDocs/my/重要文档"
  # 取最新一个 ssh-backup-*.zip
  local zip; zip="$(ls -t "$dir"/ssh-backup-*.zip 2>/dev/null | head -1)"
  if [ -z "$zip" ]; then
    warn "iCloud 里没找到 ssh-backup-*.zip（可能还没同步下来 / 没登录 iCloud）。"
    echo "    晚点 key 到位后可单独重跑：bash setup.sh ssh"
    return 0
  fi
  ok "找到备份：$(basename "$zip")"
  local pw=""
  read -r -s -p "  输入 zip 密码（直接回车跳过）: " pw </dev/tty; echo
  [ -z "$pw" ] && { warn "未输密码，跳过 SSH 恢复"; return 0; }
  if unzip -oq -P "$pw" "$zip" -d "$HOME" 2>/dev/null; then
    chmod 700 "$HOME/.ssh" 2>/dev/null
    chmod 600 "$HOME"/.ssh/* 2>/dev/null   # 先全部收紧
    chmod 644 "$HOME"/.ssh/*.pub 2>/dev/null  # 再放开公钥
    ok "~/.ssh 已恢复并修正权限"
    if [ -f "$HOME/code/.env" ]; then
      chmod 600 "$HOME/code/.env" 2>/dev/null  # 含密钥，收紧
      ok "~/code/.env 已恢复（真实值，dotfiles 步骤的占位符会自动跳过）"
    fi
  else
    warn "解压失败（密码错？）。可单独重跑：bash setup.sh ssh"
  fi
}

# --------------------------------------------------------------------------
step_brew(){
  run brew || return 0
  c "Homebrew + Brewfile"
  if ! command -v brew >/dev/null 2>&1; then
    ask "未检测到 Homebrew，现在安装？" && \
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew 仍不可用（安装失败或被跳过）。常见原因：访问不了 raw.githubusercontent.com。"
    echo "    先把代理跑起来（或用国内镜像装 brew），然后重跑：bash setup.sh brew"
    return 0
  fi
  if ask "用 Brewfile 安装所有包（formulae/casks/uv/npm/vscode）？"; then
    brew bundle --file="$HERE/Brewfile" || warn "部分包失败，可重跑"
    ok "brew bundle 完成"
  fi
}

# --------------------------------------------------------------------------
step_runtimes(){
  run runtimes || return 0
  c "运行时：nvm + node + uv"
  export NVM_DIR="$HOME/.nvm"; mkdir -p "$NVM_DIR"
  [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
  if command -v nvm >/dev/null 2>&1 || type nvm >/dev/null 2>&1; then
    nvm install "$NODE_VERSION" && nvm alias default "$NODE_VERSION" && ok "node $(node -v 2>/dev/null) via nvm"
  else
    warn "nvm 还没加载，先 source ~/.zshrc 后再跑 'bash setup.sh runtimes'"
  fi
  if ! command -v uv >/dev/null 2>&1; then
    ask "安装 uv（Astral）？" && curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  ok "运行时就绪"
}

# --------------------------------------------------------------------------
step_npm(){
  run npm || return 0
  c "全局 npm 包（Brewfile 里的 npm 行已装一遍，这里兜底）"
  command -v npm >/dev/null 2>&1 || { warn "npm 不可用，先跑 runtimes"; return 0; }
  npm install -g \
    @earendil-works/pi-coding-agent \
    @openai/codex \
    ccglass \
    corepack 2>/dev/null && ok "全局 npm 包完成" || warn "部分 npm 包失败"
}

# --------------------------------------------------------------------------
backup(){ [ -e "$1" ] && cp "$1" "$1.bak.$(date +%s)" && warn "已备份 $1 → $1.bak.*"; }

step_dotfiles(){
  run dotfiles || return 0
  c "dotfiles：.zshrc / .zprofile / git / secrets"
  if ask "部署 .zshrc 和 .zprofile？（会先备份现有的）"; then
    backup "$HOME/.zshrc";    cp "$HERE/zshrc.template"    "$HOME/.zshrc"
    backup "$HOME/.zprofile"; cp "$HERE/zprofile.template" "$HOME/.zprofile"
    ok ".zshrc / .zprofile 已部署"
  fi
  # 占位符模板（已存在就不覆盖，免得抹掉填好的真实值）
  seed(){ [ -f "$2" ] && { ok "$2 已存在，跳过"; return; }; cp "$1" "$2"; warn "已生成 $2（占位符）——记得填真实值！"; }
  mkdir -p "$HOME/code"
  seed "$HERE/env.example"              "$HOME/code/.env"
  # git 身份：从 shellrc 读 GIT_USER_NAME / GIT_USER_EMAIL（只取值，不 source 整个文件）
  GIT_USER_NAME=$(grep '^export GIT_USER_NAME='  "$HERE/shellrc" | cut -d'"' -f2 || true)
  GIT_USER_EMAIL=$(grep '^export GIT_USER_EMAIL=' "$HERE/shellrc" | cut -d'"' -f2 || true)
  if [ -n "${GIT_USER_NAME:-}" ] && [[ "$GIT_USER_NAME" != 你的名字 ]]; then
    git config --global user.name  "$GIT_USER_NAME"
    git config --global user.email "$GIT_USER_EMAIL"
    ok "git 身份：$GIT_USER_NAME <$GIT_USER_EMAIL>"
  else
    warn "git 身份未设：在 shellrc 里设 GIT_USER_* 后重跑 dotfiles"
  fi
}

# --------------------------------------------------------------------------
step_claude(){
  run claude || return 0
  c "Claude Code：CLI + marketplaces + plugins"
  bash "$HERE/claude-setup.sh" "$AUTO"
}

# --------------------------------------------------------------------------
step_repos(){
  run repos || return 0
  c "克隆所有 GitHub 仓库（普通 → ~/code/，产品 → products/，网站 → websites/，外部 → external/）"
  # 前置检查：全新机器没有 SSH key，git@github.com 一个仓库都拉不下来
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
    warn "SSH 连不上 GitHub，跳过整个克隆步骤。配好 key 后单独重跑：bash setup.sh repos"
    echo "    方式 A（推荐）：从旧机器把整个 ~/.ssh/ 拷过来，然后："
    echo "      chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_* && chmod 644 ~/.ssh/*.pub"
    echo "    方式 B：本机新生成一把 key，加到 GitHub："
    echo "      ssh-keygen -t ed25519 -C \"你的邮箱\""
    echo "      pbcopy < ~/.ssh/id_ed25519.pub   # 已进剪贴板，贴到 https://github.com/settings/keys"
    echo "      （或先 gh auth login，再 gh ssh-key add ~/.ssh/id_ed25519.pub）"
    echo "    若 github.com 整个连不通：先装代理 app 并 proxy-on，再回来跑这步。"
    return 0
  fi
  # clone_into <父目录> <repo名> [org]（本地目录名与 repo 同名，org 默认 jianshuo）
  # products/ websites/ external/ 只是普通文件夹，不是 git repo
  clone_into(){
    local parent="$1" repo="$2" org="${3:-jianshuo}" rel
    rel="${parent#"$HOME"/code}"; rel="${rel#/}"; rel="${rel:+$rel/}$repo"
    mkdir -p "$parent"
    if [ -d "$parent/$repo/.git" ]; then
      ok "$rel 已存在，跳过"
    else
      ask "克隆 $org/$repo -> $rel?" && git clone "git@github.com:$org/$repo.git" "$parent/$repo" \
        && ok "克隆完成: $rel" || warn "跳过: $rel"
    fi
  }
  # 普通仓库 → ~/code/<name>
  for repo in machine-setup jianshuo-memory wechat-publish claude-skills; do
    clone_into "$HOME/code" "$repo"
  done
  # 产品仓库 → ~/code/products/<name>
  for repo in ccline ccglass cclight bdpan-finder Cathier Cathier-certs polysync; do
    clone_into "$HOME/code/products" "$repo"
  done
  # 网站仓库 → ~/code/websites/<domain>
  for repo in wangjianshuo.com home.wangjianshuo.com huixianju.cn inspirationlake.org maggiacito.com jianshuo.dev; do
    clone_into "$HOME/code/websites" "$repo"
  done
  # 外部组织仓库 → ~/code/external/<name>
  # 注意：baixing-cli 没有远端，只能从旧机器手动拷贝到 ~/code/external/baixing-cli
  clone_into "$HOME/code/external" "haojing" "baixing"
  clone_into "$HOME/code/external" "mira" "miravideo"
}

# --------------------------------------------------------------------------
step_extras(){
  run extras || return 0
  c "额外的独立二进制：xurl / ccline"
  if ! command -v xurl >/dev/null 2>&1; then
    warn "xurl 不是 brew 包（X 官方 CLI 的 arm64 二进制）。"
    echo "    去 https://github.com/xdevplatform/xurl/releases 下 darwin-arm64，"
    echo "    chmod +x 后放到 /opt/homebrew/bin/xurl"
  else ok "xurl 已在"; fi
  if [ ! -f "$HOME/.config/ccline/ccline.zsh" ]; then
    warn "ccline 未部署：它的二进制在 ~/.local/bin/ccline，配置在 ~/.config/ccline/。"
    echo "    从旧机器拷 ~/.local/bin/ccline 和 ~/.config/ccline/ 整个目录过来即可。"
  else ok "ccline 已在"; fi
}

# --------------------------------------------------------------------------
echo "================ machine-setup ($ONLY) ================"
step_ssh
step_brew
step_runtimes
step_npm
step_dotfiles
step_claude
step_repos
step_extras
echo
c "完成。接下来："
echo "  1) 填密钥：~/code/.env 已随 SSH 备份自动恢复；若是占位符版，照 env.example 填真实值"
echo "  2) 新开终端 / source ~/.zshrc"
echo "  3) 代理：装好本地代理 app 后重开终端即可（.zshrc 检测到 127.0.0.1:1087 在监听才启用代理）"
echo "  4) SSH key + ~/code/.env：开头那步会自动从 iCloud 的 ssh-backup-*.zip 恢复（提示输密码）。"
echo "     iCloud 没同步到/当时跳过了 → 同步好后单独重跑：bash setup.sh ssh"
echo "  5) 补克隆仓库：bash setup.sh repos（没 SSH key 时该步会自动跳过）"
echo "  6) claude /login 登录；gh auth login 登录 GitHub"
