#!/usr/bin/env bash
#
# TenkStack installer -- first version.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/NoobBandi/TenkStack/main/install.sh)
#
# `bash <(...)`, not `curl | bash`. Piping puts the script on stdin, so every
# `read` in here would hit EOF immediately: the questions would scroll past with
# no way to answer, every answer would silently take its default, and nobody
# would know they had been asked. Process substitution leaves stdin as the
# terminal. If you copied a `curl | bash` line from somewhere, this is why it
# did not ask you anything.
#
# WHAT THIS DOES NOT DO
#
#   * It does not run as root. The console is a systemd *user* service, and a
#     thing that serves a web interface has no business owning the machine.
#     `sudo` is used for a few named jobs, each announced before it runs:
#     installing packages, adding your user to a group, the NVIDIA driver, and
#     -- only with --tls internal or --domain -- trusting Caddy's CA or letting
#     it bind :443.
#   * It does not `apt upgrade`. Refreshing the index is safe; upgrading every
#     package on somebody else's machine is not. In particular it would replace
#     `linux-firmware`, and a GuC firmware change is one of the ways an Intel
#     card stops working -- which is a bad thing for an installer to cause.
#   * It does not download models. That is tens of gigabytes and a choice; make
#     it from the catalogue page once this is running.
#   * It does not reboot you halfway. If a reboot is needed at all -- and for
#     Intel and AMD it never is -- it is the last line, after everything is
#     installed and every service is enabled, so the machine comes back up
#     finished rather than half-done.
#
# Written to be read before it is run. If you are about to pipe this into a
# shell, `--dry-run` prints every step without doing any of it.

set -Eeuo pipefail

# --------------------------------------------------------------------------
# What can be set from outside
# --------------------------------------------------------------------------

REPO_URL="${TENKSTACK_REPO:-https://github.com/NoobBandi/TenkStack.git}"
REPO_REF="${TENKSTACK_REF:-main}"

# Where the stack lives. Named for the project rather than for the machine it
# was first built on. Never left to the default in the binary: the unit files
# below write it out explicitly, so a change to that default cannot move an
# installation that is already running.
ROOT_DEFAULT="$HOME/tenkstack"
# The checkout, which is code rather than data and so sits apart from it.
CODE_DEFAULT="$HOME/dev/tenkstack"

CONSOLE_PORT="${CONSOLE_PORT:-8070}"
LLAMA_SWAP_PORT="${CONSOLE_LLAMA_SWAP_PORT:-8080}"

# Answers, filled in by the questions or by flags.
ROOT=""
CODE=""
FROM_SOURCE=false
# Where install.sh gets the console: one static binary per release, with the
# frontend inside it.
RELEASE_URL="${TENKSTACK_RELEASE:-https://github.com/NoobBandi/TenkStack/releases/latest/download}"
WANT_SEARXNG=""
# Answered in the questions unless --tls/--domain pre-answered it. "y" means
# TLS_MODE is internal or domain; --tls CERT,KEY is flag-only, since typing
# two paths at a prompt is worse than typing them on the command line.
WANT_TLS=""
SEARXNG_PORT="${CONSOLE_SEARXNG_PORT:-8090}"
# The console's database (internal/pgserver.Image; the same major version).
POSTGRES_IMAGE=docker.io/library/postgres:18-alpine
ASSUME_YES=false
DRY_RUN=false
# The terminal UI (`tenkstack setup`) asks the questions when it can: a
# terminal on both ends, and a binary to run it. --no-tui keeps the
# plain questions below.
NO_TUI=false
# Engines and ComfyUI cards to install once the console is up, as
# `tenkstack provision` takes them: comma-separated registry keys and PCI
# addresses. Empty unless chosen on the setup screen or given as flags.
ENGINES=""
COMFY_CARDS=""
# --uninstall takes the install apart again; --purge also deletes the
# install directory with the models in it, --keep-images leaves the
# container images.
UNINSTALL=false
# "install" or "uninstall", when the setup screens were asked.
ACTION=""
PURGE=false
KEEP_IMAGES=false

# How the console is reached from outside the machine. Caddy is the only
# thing that listens beyond loopback, and this decides what it does with TLS:
#
#   ""         plain HTTP on :8443. The default, because it works in every
#              environment including the ones where something else already
#              terminates TLS in front (Cloudflare Tunnel, Tailscale Serve, a
#              company ingress) and a second certificate would only fight it.
#   internal   Caddy mints its own CA. Right for an isolated LAN with no
#              domain. Every device that connects has to trust that CA once.
#   cert       A certificate and key from elsewhere -- a company CA, or one
#              obtained by hand.
#   domain     A public name: Caddy obtains a Let's Encrypt certificate on
#              its own and renews it. Needs :80 and :443 reachable from the
#              internet, which is the one thing this script cannot check.
TLS_MODE=""
TLS_CERT=""
TLS_KEY=""
DOMAIN=""
CONSOLE_TLS_PORT="${CONSOLE_TLS_PORT:-8443}"
API_PORT="${CONSOLE_API_PORT:-8000}"

# Findings, filled in by the survey.
OS_ID=""; OS_PRETTY=""
VENDORS=()
NEEDS_REBOOT=false
REBOOT_WHY=""
MISSING_PKGS=()
MISSING_GROUPS=()

# --------------------------------------------------------------------------
# Language
#
# Every message comes in Traditional Chinese and English, side by side at
# the place it is printed: `L "中文" "English"`. The language is --lang,
# then the choice on the first setup screen, then the locale.
# --------------------------------------------------------------------------

UI_LANG=""
__prev=""
for __a in "$@"; do
  case $__prev in --lang) UI_LANG=$__a ;; esac
  __prev=$__a
done
unset __a __prev
lang_of() {
  case ${1,,} in
    zh|zh-tw|zh_tw*|zh-hk|zh_hk*|zh-hant*|zh_hant*) echo zh-TW ;;
    en|en-*|en_*) echo en ;;
  esac
}
UI_LANG=$(lang_of "$UI_LANG")
LANG_GIVEN=false
if [[ -n $UI_LANG ]]; then LANG_GIVEN=true; else UI_LANG=$(lang_of "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"); fi
UI_LANG=${UI_LANG:-en}

L() { if [[ $UI_LANG == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
  C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_B=""; C_OFF=""
fi

say()   { printf '%s\n' "$*"; }
step()  { printf '\n%s==>%s %s\n' "$C_B" "$C_OFF" "$*"; }
ok()    { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
skip()  { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }

# Errors say what to do next. A stack trace tells the reader what broke; it does
# not tell them what to try, and this is the one script they will meet before
# they know anything about the project.
die() {
  printf '\n  %s✗%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2
  if [[ $# -gt 1 ]]; then printf '    %s\n' "$2" >&2; fi
  exit 1
}

trap 'die "$(L "安裝在第 $LINENO 行中止了。" "The install stopped at line $LINENO.")" "$(L "上面最後一個 ==> 步驟是失敗的地方；修好之後重跑這個腳本，已經完成的部分會自動跳過。" "The last ==> step above is where it failed; fix that and run this script again, and whatever already finished is skipped.")"' ERR

# `run` is the only way anything happens, so --dry-run has one place to be
# honoured rather than a check at every call site.
run() {
  if $DRY_RUN; then
    printf '  %s%s:%s %s\n' "$C_DIM" "$(L 會執行 "would run")" "$C_OFF" "$*"
    return 0
  fi
  "$@"
}

as_root() {
  if $DRY_RUN; then
    printf '  %s%s:%s %s\n' "$C_DIM" "$(L "會執行（sudo）" "would run (sudo)")" "$C_OFF" "$*"
    return 0
  fi
  sudo "$@"
}

# --------------------------------------------------------------------------
# Questions
#
# All of them are asked in one place, before anything is installed. Past the
# confirmation this script does not stop to ask again -- an installer that goes
# quiet for ten minutes and then wants an answer is one people walk away from.
# --------------------------------------------------------------------------

ask() {
  # ask VAR "prompt" "default"
  local __var=$1 prompt=$2 default=$3 answer=""
  if $ASSUME_YES || [[ ! -t 0 ]]; then
    printf -v "$__var" '%s' "$default"
    skip "$prompt$default$(L "（未互動）" " (not interactive)")"
    return
  fi
  read -r -p "  ${prompt}[$default] " answer || true
  printf -v "$__var" '%s' "${answer:-$default}"
}

ask_yn() {
  # ask_yn VAR "prompt" "y|n" -- honours an answer already set by a flag
  local __var=$1 prompt=$2 default=$3 answer=""
  if [[ -n "${!__var}" ]]; then skip "$prompt${!__var}$(L "（由參數決定）" " (set by a flag)")"; return; fi
  if $ASSUME_YES || [[ ! -t 0 ]]; then
    printf -v "$__var" '%s' "$default"
    skip "$prompt$default$(L "（未互動）" " (not interactive)")"
    return
  fi
  local hint="[y/N]"
  if [[ $default == y ]]; then hint="[Y/n]"; fi
  read -r -p "  $prompt$hint " answer || true
  answer="${answer:-$default}"
  printf -v "$__var" '%s' "$([[ $answer =~ ^[Yy] ]] && echo y || echo n)"
}

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

usage() {
  if [[ $UI_LANG == en ]]; then
    cat <<EOF
TenkStack installer

  --lang en|zh-TW     language of the installer (default: asked first, else the locale)
  --dir PATH          install directory (default $ROOT_DEFAULT)
  --source            build from source instead of downloading a release (installs Go and Node)
  --code PATH         where the source goes with --source (default $CODE_DEFAULT)
  --tls internal      HTTPS with Caddy's own CA (an isolated LAN; each device trusts it once)
  --tls CERT,KEY      HTTPS with your own certificate
  --domain NAME       a public domain, certificate from Let's Encrypt (80/443 reachable)
                      none of the three = plain HTTP on :$CONSOLE_TLS_PORT, for a proxy in front
  --searxng           install SearXNG (Docker, loopback :$SEARXNG_PORT: web search for the models)
  --no-searxng        do not
  --engines LIST      inference engines to install once the console is up: llamacpp,vllm,sglang
  --comfyui LIST      PCI addresses of the cards to run ComfyUI on, e.g. 0000:0c:00.0
  --no-tui            ask plain questions instead of the setup screens
  --uninstall         remove the services, containers, images and system changes; keep the
                      install directory (models, settings, chats), so a reinstall picks it up
  --purge             with --uninstall: delete the install directory too, models included
  --keep-images       with --uninstall: leave the container images
  --yes               take every default, ask nothing
  --dry-run           print what would be done, do none of it
  --help

Environment: TENKSTACK_REPO, TENKSTACK_REF, CONSOLE_PORT, CONSOLE_TLS_PORT, CONSOLE_API_PORT
EOF
    return
  fi
  cat <<EOF
TenkStack 安裝程式

  --lang en|zh-TW     安裝程式的語言（預設：一開始先問，否則照系統語系）
  --dir PATH          安裝目錄（預設 $ROOT_DEFAULT）
  --source            從原始碼 build，不下載 release（會裝 Go 與 Node）
  --code PATH         --source 時程式碼放哪（預設 $CODE_DEFAULT）
  --tls internal      Caddy 自簽 CA 做 HTTPS（隔離區網用；每台裝置要信任一次）
  --tls CERT,KEY      用你自己的憑證檔做 HTTPS
  --domain NAME       用公開網域，Let's Encrypt 自動簽（需要 80/443 對外可達）
                      三個都不給 = 純 HTTP :$CONSOLE_TLS_PORT，外面已有反向代理時選這個
  --searxng           裝 SearXNG（Docker，loopback :$SEARXNG_PORT，讓模型能上網搜尋）
  --no-searxng        不裝
  --engines LIST      主控台啟動後要裝的推論引擎：llamacpp,vllm,sglang
  --comfyui LIST      要跑 ComfyUI 的顯示卡 PCI 位址，例如 0000:0c:00.0
  --no-tui            用一般問答，不用安裝畫面
  --uninstall         移除服務、容器、映像與系統設定；保留安裝目錄（模型、設定、對話），
                      之後重裝會沿用
  --purge             搭配 --uninstall：連安裝目錄一起刪掉，包含模型
  --keep-images       搭配 --uninstall：保留容器映像
  --yes               全部用預設值，完全不問
  --dry-run           印出會做什麼，不執行任何動作
  --help

環境變數：TENKSTACK_REPO、TENKSTACK_REF、CONSOLE_PORT、CONSOLE_TLS_PORT、CONSOLE_API_PORT
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --lang)        shift 2 ;;
    --dir)         ROOT=${2:?$(L "--dir 需要一個路徑" "--dir needs a path")}; shift 2 ;;
    --code)        CODE=${2:?$(L "--code 需要一個路徑" "--code needs a path")}; shift 2 ;;
    --source)      FROM_SOURCE=true; shift ;;
    --searxng)     WANT_SEARXNG=y; shift ;;
    --no-searxng)  WANT_SEARXNG=n; shift ;;
    --engines)     ENGINES=${2?$(L "--engines 需要引擎清單" "--engines needs a list of engines")}; shift 2 ;;
    --comfyui)     COMFY_CARDS=${2?$(L "--comfyui 需要顯示卡位址" "--comfyui needs card addresses")}; shift 2 ;;
    --no-tui)      NO_TUI=true; shift ;;
    --uninstall)   UNINSTALL=true; shift ;;
    --purge)       PURGE=true; shift ;;
    --keep-images) KEEP_IMAGES=true; shift ;;
    --tls)
      case "${2:?$(L "--tls 需要 internal 或 CERT,KEY" "--tls needs internal or CERT,KEY")}" in
        internal) TLS_MODE=internal ;;
        *,*)      TLS_MODE=cert; TLS_CERT=${2%%,*}; TLS_KEY=${2#*,} ;;
        *)        die "$(L "不認得的 --tls 值：$2" "Unknown --tls value: $2")" "$(L "用 internal，或 憑證檔,金鑰檔。" "Use internal, or cert-file,key-file.")" ;;
      esac
      shift 2 ;;
    --domain)      DOMAIN=${2:?$(L "--domain 需要一個網域名稱" "--domain needs a domain name")}; TLS_MODE=domain; shift 2 ;;
    --yes|-y)      ASSUME_YES=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --help|-h)     usage; exit 0 ;;
    *)             die "$(L "不認得的參數：$1" "Unknown option: $1")" "$(L "用 --help 看可用的參數。" "See --help for the options.")" ;;
  esac
done

# --------------------------------------------------------------------------
# ① Survey -- reads everything, changes nothing
# --------------------------------------------------------------------------

survey_os() {
  [[ -r /etc/os-release ]] || die "$(L "讀不到 /etc/os-release。" "Cannot read /etc/os-release.")" "$(L "這個腳本只支援 systemd 的 Linux 發行版。" "This script supports systemd Linux distributions only.")"
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID}"
  ok "$OS_PRETTY$(L "，核心 " ", kernel ")$(uname -r)"

  case "$OS_ID" in
    ubuntu|debian|pop|linuxmint) : ;;
    *) warn "$(L "沒有在 $OS_ID 上測過。套件安裝那幾步可能要你自己來。" "Not tested on $OS_ID. The package steps may need doing by hand.")" ;;
  esac

  if [[ $(id -u) -eq 0 ]]; then die "$(L "請不要用 root 跑這個腳本。" "Do not run this script as root.")" \
      "$(L "主控台是 systemd user service，用一般帳號跑。需要 sudo 的三個地方會分別提示。" "The console is a systemd user service run by an ordinary account. The few steps that need sudo say so.")"; fi
  command -v systemctl >/dev/null || die "$(L "找不到 systemctl。" "systemctl was not found.")" "$(L "這個腳本需要 systemd。" "This script needs systemd.")"
}

# Vendors are read from PCI IDs, which need no driver -- the whole point is to
# work out what to install before anything is installed.
survey_cards() {
  local ids
  ids=$(lspci -nn 2>/dev/null | grep -iE 'vga|display|3d' || true)
  if [[ -z $ids ]]; then warn "$(L "看不到任何顯示卡。CPU 也能跑，只是很慢。" "No graphics card found. The CPU can run models too, slowly.")"; return; fi

  local seen=""
  while IFS= read -r line; do
    local vendor=""
    case "$line" in
      *\[8086:*) vendor=intel  ;;
      *\[10de:*) vendor=nvidia ;;
      *\[1002:*|*\[1022:*) vendor=amd ;;
    esac
    if [[ -z $vendor || $seen == *"|$vendor|"* ]]; then continue; fi
    seen="$seen|$vendor|"
    VENDORS+=("$vendor")
  done <<<"$ids"

  for v in "${VENDORS[@]}"; do
    local n; n=$(grep -ci "" <<<"$(grep -iE 'vga|display|3d' <<<"$ids")" || true)
    ok "$(L "偵測到 $v 顯示卡（$n 張顯示裝置）" "Found $v graphics ($n display devices)")"
  done
  if [[ ${#VENDORS[@]} -eq 0 ]]; then warn "$(L "顯示卡的廠商認不出來，會照純 CPU 安裝。" "The graphics vendor is not one this knows; installing for the CPU.")"; fi
}

# Which of the three needs anything installed at all. On a current kernel the
# answer for Intel and AMD is "nothing": their modules are in the mainline tree
# and load themselves. NVIDIA is the only one with a driver to install, and the
# only one that can require a reboot.
survey_drivers() {
  # Read once, matched as a string. `lsmod | grep -q` looks obvious and is
  # wrong under `set -o pipefail`: grep -q exits on the first match, lsmod dies
  # of SIGPIPE, and the pipeline reports 141 -- so a module that IS loaded is
  # reported as missing, on every Intel and AMD machine.
  local mods; mods=$(lsmod)
  for v in "${VENDORS[@]}"; do
    case $v in
      intel|amd)
        local mod=xe
        if [[ $v == amd ]]; then mod=amdgpu; fi
        if grep -qE "^($mod|i915)\b" <<<"$mods"; then
          ok "$(L "$v：核心模組已載入，沒有驅動要裝" "$v: kernel module loaded, no driver to install")"
        else
          warn "$(L "$v：核心模組沒有載入。$mod 在主線核心裡，通常代表韌體或核心參數的問題。" "$v: kernel module not loaded. $mod is in the mainline kernel, so this usually means firmware or a kernel parameter.")"
        fi
        if [[ ! -e /dev/dri ]]; then warn "$(L "沒有 /dev/dri，容器拿不到這張卡。" "No /dev/dri: containers cannot reach this card.")"; fi
        ;;
      nvidia)
        if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
          ok "$(L "nvidia：驅動已就緒" "nvidia: driver ready")"
        else
          MISSING_PKGS+=("nvidia-driver")
          NEEDS_REBOOT=true
          REBOOT_WHY="$(L "剛安裝 NVIDIA 驅動" "the NVIDIA driver was just installed")"
          if command -v mokutil >/dev/null && mokutil --sb-state 2>/dev/null | grep -qi enabled; then
            REBOOT_WHY="$REBOOT_WHY$(L "（Secure Boot 開著，開機時會要求輸入 MOK 密碼）" " (Secure Boot is on: the boot will ask for the MOK password)")"
          fi
          warn "$(L "nvidia：需要安裝驅動，而且會需要重新開機一次" "nvidia: the driver needs installing, and then one reboot")"
        fi
        if docker info 2>/dev/null | grep -q nvidia; then
          ok "$(L "nvidia-container-toolkit 已設定" "nvidia-container-toolkit is set up")"
        else
          MISSING_PKGS+=("nvidia-container-toolkit")
        fi
        ;;
    esac
  done
}

survey_deps() {
  local need=(git curl docker)
  for t in "${need[@]}"; do
    if command -v "$t" >/dev/null; then ok "$t"; else MISSING_PKGS+=("$t"); warn "$(L "缺 $t" "missing $t")"; fi
  done
  # uv and node are installed from their own upstreams rather than apt: the
  # distro versions are routinely too old, and this needs 3.12+ and Node 24+.
  # Go and Node are only for --source; a release install needs neither.
  if $FROM_SOURCE; then
    command -v go   >/dev/null && ok "go $(go version | awk '{print $3}')" || { MISSING_PKGS+=("go");   warn "$(L "缺 go（會裝到 $ROOT/go）" "missing go (goes to $ROOT/go)")"; }
    command -v node >/dev/null && ok "node $(node --version)" || { MISSING_PKGS+=("node"); warn "$(L "缺 node" "missing node")"; }
  fi
  command -v caddy >/dev/null && ok "caddy" || MISSING_PKGS+=("caddy")

  for g in docker render; do
    getent group "$g" >/dev/null || continue
    if id -nG | tr ' ' '\n' | grep -qx "$g"; then
      ok "$(L "已在 $g 群組" "already in group $g")"
    else
      MISSING_GROUPS+=("$g")
      warn "$(L "不在 $g 群組" "not in group $g")"
    fi
  done

  local free; free=$(df -BG --output=avail "$HOME" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [[ -n $free && $free -lt 40 ]]; then
    warn "$(L "家目錄只剩 ${free}G，模型權重通常要幾十 G。" "Only ${free}G free in the home directory; model weights usually take tens of GB.")"
  fi

  local listening; listening=$(ss -ltn 2>/dev/null || true)
  for p in "$CONSOLE_PORT" "$LLAMA_SWAP_PORT" "$CONSOLE_TLS_PORT" "$API_PORT"; do
    if grep -q ":$p " <<<"$listening"; then
      # A survey finding, not a failure, while nothing is being changed --
      # --dry-run on a machine that already runs this stack would otherwise
      # stop before printing the plan it was asked for.
      if $DRY_RUN; then
        warn "$(L "連接埠 $p 已經被佔用（dry-run，繼續）" "Port $p is in use (dry run, carrying on)")"
      else
        die "$(L "連接埠 $p 已經被佔用。" "Port $p is in use.")" "$(L "換一個（CONSOLE_PORT=…）或把佔用它的東西停掉。" "Pick another (CONSOLE_PORT=…) or stop what holds it.")"
      fi
    fi
  done
}

# --------------------------------------------------------------------------
# ② The plan, and one confirmation
# --------------------------------------------------------------------------

# What the answers imply. Runs after the questions, because the TLS mode and
# SearXNG are decided there -- the survey above only checks what is true of
# the machine before anyone has chosen anything.
check_choices() {
  case $TLS_MODE in
    cert)
      [[ -r $TLS_CERT ]] || die "$(L "讀不到憑證檔 $TLS_CERT" "Cannot read the certificate $TLS_CERT")" "$(L "--tls 要的是 憑證檔,金鑰檔。" "--tls takes cert-file,key-file.")"
      [[ -r $TLS_KEY  ]] || die "$(L "讀不到金鑰檔 $TLS_KEY" "Cannot read the key $TLS_KEY")"  "$(L "--tls 要的是 憑證檔,金鑰檔。" "--tls takes cert-file,key-file.")"
      ok "$(L "憑證" "certificate") $TLS_CERT" ;;
    domain)
      # Binding :80 and :443 without root needs a capability on the binary,
      # and that needs setcap. Everything else Caddy does runs unprivileged.
      command -v setcap >/dev/null || MISSING_PKGS+=("libcap2-bin")
      ok "$(L "網域 $DOMAIN（Let's Encrypt；80/443 要能從外面連到這台）" "domain $DOMAIN (Let's Encrypt; 80/443 must reach this machine from outside)")" ;;
    internal) ok "$(L "HTTPS，Caddy 自簽 CA（每台裝置要信任一次）" "HTTPS with Caddy's own CA (each device trusts it once)")" ;;
    "")       ok "$(L "純 HTTP（外層若有反向代理，由它負責 TLS）" "plain HTTP (a proxy in front, if any, does TLS)")" ;;
  esac

  local listening; listening=$(ss -ltn 2>/dev/null || true)
  local extra=()
  if [[ $TLS_MODE == domain ]]; then extra+=(80 443); fi
  if [[ $WANT_SEARXNG == y ]]; then extra+=("$SEARXNG_PORT"); fi
  for p in "${extra[@]}"; do
    if grep -q ":$p " <<<"$listening"; then
      if $DRY_RUN; then warn "$(L "連接埠 $p 已經被佔用（dry-run，繼續）" "Port $p is in use (dry run, carrying on)")"
      else die "$(L "連接埠 $p 已經被佔用。" "Port $p is in use.")" "$(L "換一個，或把佔用它的東西停掉。" "Pick another, or stop what holds it.")"; fi
    fi
  done
}

show_plan() {
  # Confirmed on the setup screens, which listed all of this already.
  if $CONFIRMED; then
    if $NEEDS_REBOOT; then warn "$(L "這次安裝結束後需要重新開機一次：$REBOOT_WHY" "One reboot is needed when this finishes: $REBOOT_WHY")"; fi
    if $DRY_RUN; then skip "$(L "--dry-run：以下只會印出，不會執行" "--dry-run: what follows is printed, not done")"; fi
    return
  fi
  step "$(L "計畫" "Plan")"
  local host; host=$(L "<這台>" "<this-machine>")
  say "  $(L "安裝目錄      " "Directory     ")$ROOT"
  if $FROM_SOURCE; then say "  $(L "程式碼        " "Source        ")$CODE$(L "（--source，本機 build）" " (--source, built here)")"; else say "  $(L "主控台        " "Console       ")$(L "$RELEASE_URL 的 release binary" "release binary from $RELEASE_URL")"; fi
  say "  $(L "顯示卡        " "Graphics      ")${VENDORS[*]:-$(L "（無）" "(none)")}"
  say "  $(L "推論引擎      " "Engines       ")${ENGINES:-$(L "（不裝，之後在「推論引擎」頁裝）" "(none now; the Engines page installs them later)")}"
  say "  ComfyUI       ${COMFY_CARDS:-$(L "（不裝）" "(none)")}"
  say "  SearXNG       $( [[ $WANT_SEARXNG == y ]] && L "裝，loopback :$SEARXNG_PORT" "yes, loopback :$SEARXNG_PORT" || L 不裝 no )"
  case $TLS_MODE in
    "")       say "  $(L "對外          " "Access        ")http://$host:$CONSOLE_TLS_PORT$(L "（無 TLS）" " (no TLS)")" ;;
    internal) say "  $(L "對外          " "Access        ")https://$host:$CONSOLE_TLS_PORT$(L "（自簽 CA，會跑 caddy trust）" " (own CA; runs caddy trust)")" ;;
    cert)     say "  $(L "對外          " "Access        ")https://$host:$CONSOLE_TLS_PORT（$TLS_CERT）" ;;
    domain)   say "  $(L "對外          " "Access        ")https://$DOMAIN$(L "（Let's Encrypt，會 setcap caddy）" " (Let's Encrypt; runs setcap on caddy)")" ;;
  esac
  if [[ ${#MISSING_PKGS[@]}   -gt 0 ]]; then say "  $(L "會安裝        " "Installs      ")${MISSING_PKGS[*]}"; fi
  if [[ ${#MISSING_GROUPS[@]} -gt 0 ]]; then say "  $(L "會加入群組    " "Joins groups  ")${MISSING_GROUPS[*]}"; fi
  if $NEEDS_REBOOT; then
    say ""
    warn "$(L "這次安裝結束後需要重新開機一次：$REBOOT_WHY" "One reboot is needed when this finishes: $REBOOT_WHY")"
    warn "$(L "重開機是最後一步。開機後服務會自己啟動，不用再跑這個腳本。" "The reboot is the last step. The services start on their own after it; this script need not run again.")"
  else
    say ""
    ok "$(L "不需要重新開機" "No reboot needed")"
  fi

  if [[ ${#MISSING_PKGS[@]} -gt 0 || ${#MISSING_GROUPS[@]} -gt 0 ]]; then
    say "  ${C_DIM}$(L "上面的安裝與群組變更會用到 sudo，其他步驟都以 $USER 身分執行。" "The installs and group changes above use sudo; everything else runs as $USER.")${C_OFF}"
  fi

  if $DRY_RUN; then say ""; skip "$(L "--dry-run：以下只會印出，不會執行" "--dry-run: what follows is printed, not done")"; fi
  if $ASSUME_YES || [[ ! -t 0 ]]; then return; fi
  local go=""
  read -r -p "  $(L "繼續？[Y/n] " "Go ahead? [Y/n] ")" go || true
  if [[ ${go:-y} =~ ^[Nn] ]]; then say "  $(L "取消了，什麼都沒有動。" "Cancelled. Nothing was changed.")"; exit 0; fi
}

# --------------------------------------------------------------------------
# ③ Install -- from here on it does not ask
# --------------------------------------------------------------------------

apt_install() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

install_deps() {
  if [[ ${#MISSING_PKGS[@]} -eq 0 ]]; then skip "$(L "相依都齊了" "every dependency is present")"; return; fi

  # Refresh the index, never upgrade. See the header.
  local apt_wanted=()
  for p in "${MISSING_PKGS[@]}"; do
    case $p in
      git|curl|libcap2-bin) apt_wanted+=("$p") ;;
    esac
  done
  if [[ ${#apt_wanted[@]} -gt 0 ]]; then
    as_root apt-get update -qq
    apt_install "${apt_wanted[@]}"
    ok "$(L "裝好 ${apt_wanted[*]}" "installed ${apt_wanted[*]}")"
  fi

  for p in "${MISSING_PKGS[@]}"; do
    case $p in
      docker)
        run bash -c 'curl -fsSL https://get.docker.com | sh'
        ok "$(L "裝好 docker" "installed docker")" ;;
      go)
        # A private copy under the install root, not a system package: the
        # distribution's Go is usually too old for the go.mod here.
        run bash -c "curl -fsSL 'https://go.dev/dl/$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1).linux-$(dpkg --print-architecture 2>/dev/null || echo amd64).tar.gz' | tar -xz -C '$ROOT'"
        ok "$(L "裝好 go（$ROOT/go/bin）" "installed go ($ROOT/go/bin)")" ;;
      node)
        run bash -c 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -'
        apt_install nodejs
        ok "$(L "裝好 node" "installed node")" ;;
      caddy)
        run mkdir -p "$HOME/.local/bin"
        run curl -fsSL -o "$HOME/.local/bin/caddy" \
            "https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)"
        run chmod +x "$HOME/.local/bin/caddy"
        ok "$(L "裝好 caddy" "installed caddy")" ;;
      nvidia-driver)
        if command -v ubuntu-drivers >/dev/null; then
          as_root ubuntu-drivers install
        else
          warn "$(L "這個發行版沒有 ubuntu-drivers；請自行安裝 NVIDIA 驅動後重跑。" "This distribution has no ubuntu-drivers; install the NVIDIA driver yourself and run this again.")"
        fi
        ok "$(L "裝好 NVIDIA 驅動（重開機後生效）" "installed the NVIDIA driver (active after the reboot)")" ;;
      nvidia-container-toolkit)
        run bash -c 'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
            | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg'
        run bash -c 'curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
            | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" \
            | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null'
        as_root apt-get update -qq
        apt_install nvidia-container-toolkit
        as_root nvidia-ctk runtime configure --runtime=docker
        as_root systemctl restart docker
        ok "$(L "裝好 nvidia-container-toolkit" "installed nvidia-container-toolkit")" ;;
    esac
  done
}

install_groups() {
  if [[ ${#MISSING_GROUPS[@]} -eq 0 ]]; then skip "$(L "群組都對了" "groups are right")"; return; fi
  for g in "${MISSING_GROUPS[@]}"; do
    as_root usermod -aG "$g" "$USER"
    ok "$(L "加入 $g 群組" "joined group $g")"
  done
  # A group is granted at login, so the session running this script still does
  # not have it. Not a reboot -- but the services must not be started before it
  # takes effect, which is why the reboot (or re-login) is at the end.
  NEEDS_REBOOT=true
  REBOOT_WHY="${REBOOT_WHY:-$(L "群組變更要重新登入才會生效" "group changes take effect at the next login")}"
}

fetch_code() {
  if [[ -d $CODE/.git ]]; then
    run git -C "$CODE" fetch --quiet origin "$REPO_REF"
    run git -C "$CODE" checkout --quiet "$REPO_REF"
    ok "$(L "更新 $CODE" "updated $CODE")"
  else
    run mkdir -p "$(dirname "$CODE")"
    run git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$CODE"
    ok "$(L "clone 到 $CODE" "cloned to $CODE")"
  fi
}

# The console is one static binary, the frontend inside it. A release is
# downloaded; --source builds the same thing here, which is what a checkout
# ahead of the last release needs.
fetch_console() {
  local bin="$ROOT/console/tenkstack" arch
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case $arch in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  run mkdir -p "$ROOT/console"

  if ! $FROM_SOURCE; then
    if run curl -fsSL -o "$bin.new" "$RELEASE_URL/tenkstack-linux-$arch"; then
      run chmod +x "$bin.new"
      run mv "$bin.new" "$bin"
      ok "$(L 主控台 console) $("$bin" -version 2>/dev/null || echo "($arch)")"
      return
    fi
    rm -f "$bin.new"
    die "$(L "下載不到 release binary（$RELEASE_URL/tenkstack-linux-$arch）。" "Could not download the release binary ($RELEASE_URL/tenkstack-linux-$arch).")" \
        "$(L "還沒有 release 的話用 --source 從原始碼 build。" "If there is no release yet, build from source with --source.")"
  fi

  fetch_code
  local go=go
  command -v go >/dev/null || go="$ROOT/go/bin/go"
  run bash -c "cd '$CODE' && PATH='$(dirname "$go"):$PATH' scripts/build.sh --web"
  run cp "$CODE/tenkstack" "$bin"
  ok "$(L "主控台 build 完成" "built the console")"
}

make_skeleton() {
  # The console deliberately creates nothing -- turning "not set up" into "set up
  # and empty" hides the difference -- so the directories are this script's job.
  for d in models llama-swap comfyui caddy/channels console; do
    run mkdir -p "$ROOT/$d"
  done
  ok "$(L "建好 $ROOT" "created $ROOT")"

  if [[ ! -x $ROOT/llama-swap/llama-swap ]]; then
    local tag arch
    tag=$(curl -sfL https://api.github.com/repos/mostlygeek/llama-swap/releases/latest \
          | grep -oP '"tag_name":\s*"\K[^"]+' || echo "")
    if [[ -z $tag ]]; then
      die "$(L "問不到 llama-swap 的最新版本。" "Could not find llama-swap's latest release.")" "$(L "檢查網路，或先手動放一份到 $ROOT/llama-swap/。" "Check the network, or put a copy in $ROOT/llama-swap/ by hand.")"
    fi
    arch=$([[ $(uname -m) == aarch64 ]] && echo arm64 || echo amd64)
    run bash -c "curl -sfL 'https://github.com/mostlygeek/llama-swap/releases/download/$tag/llama-swap_${tag#v}_linux_${arch}.tar.gz' \
        | tar -xz -C '$ROOT/llama-swap' llama-swap"
    ok "llama-swap $tag"
  else
    skip "$(L "llama-swap 已存在" "llama-swap is already there")"
  fi

  # A skeleton rather than a template full of models: an entry naming a GGUF
  # that is not on disk is a server that fails to start, and the catalogue page
  # writes real entries once there are weights to name.
  if [[ ! -e $ROOT/llama-swap/config.yaml ]]; then
    run bash -c "cat > '$ROOT/llama-swap/config.yaml' <<'YAML'
# Written by the TenkStack installer. The console rewrites this file from here on.
macros:
  models-dir: \"$ROOT/models\"

# No models yet. Download weights from the console's Catalog page, or add a model that points at files you already have.
models: {}

groups:
  large:
    swap: true
    exclusive: true
    members: []
  small:
    swap: false
    exclusive: false
    members: []
YAML"
    ok "$(L "llama-swap 設定骨架" "llama-swap config skeleton")"
  else
    skip "$(L "llama-swap 設定已存在，沒有覆蓋" "llama-swap config exists, left as it is")"
  fi
}

# The gateway. Everything else binds loopback; this is the one process that
# listens where other machines can reach it, and the console's channel
# switches edit the files under caddy/channels/ and ask this unit to reload.
# What is written here has to match what `internal/channels` expects:
# the unit is called `caddy`, the admin API is a unix socket so `caddy reload`
# works, channel files live in channels/ (on) or channels/disabled/ (off), and
# each channel imports a bind file the console generates.
write_caddy() {
  local dir="$ROOT/caddy"
  run mkdir -p "$dir/channels/binds" "$dir/channels/disabled"

  if [[ -e $dir/Caddyfile ]]; then
    skip "$(L "Caddyfile 已存在，沒有覆蓋（$dir/Caddyfile）" "Caddyfile exists, left as it is ($dir/Caddyfile)")"
    return
  fi

  # The names this machine answers to. Used for the site addresses in every
  # mode but `domain` -- with `tls internal` Caddy issues a certificate for
  # exactly the names listed, so a name missing here is a browser warning.
  # Resolved now rather than templated: the console re-resolves LAN and
  # Tailscale addresses itself whenever it rewrites a bind file.
  local host lan ts names
  host=$(hostname -f 2>/dev/null || hostname)
  lan=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)
  ts=$(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^tailscale/ {print $4}' | cut -d/ -f1 | head -1 || true)
  names="localhost 127.0.0.1 $host"
  [[ -n $lan && $lan != 127.* ]] && names="$names $lan"
  [[ -n $ts ]] && names="$names $ts"

  local scheme=https site_tls="" site_addr site_note=""
  case $TLS_MODE in
    "")       scheme=http; site_note=" Plain HTTP: TLS is done by a proxy in front, or not needed here." ;;
    internal) site_tls="	tls internal" ;;
    cert)     site_tls="	tls $TLS_CERT $TLS_KEY" ;;
  esac
  if [[ $TLS_MODE == domain ]]; then
    site_addr="https://$DOMAIN"
  else
    site_addr=$(for n in $names; do printf '%s://%s:%s, ' "$scheme" "$n" "$CONSOLE_TLS_PORT"; done)
    site_addr=${site_addr%, }
  fi

  run bash -c "cat > '$dir/Caddyfile' <<CADDY
# Written by the TenkStack installer. The console's own site is here; the switchable entrances are in channels/.
{
	# Unix socket rather than :2019, so caddy reload works and the console can
	# apply a channel change without dropping open connections.
	admin unix/{env.XDG_RUNTIME_DIR}/caddy-admin.sock
	skip_install_trust
	grace_period 3s
	# Each site says its own tls; the api-http channel handles its own redirect.
	auto_https disable_redirects
}

# The console.$site_note
$site_addr {
$site_tls
	encode zstd gzip
	reverse_proxy 127.0.0.1:$CONSOLE_PORT {
		flush_interval -1
	}
}

import channels/*.caddy
CADDY"

  # Plain-HTTP /v1 for clients that cannot trust a private CA. On by default:
  # it is the port the connection examples in the console point CLI tools at.
  # Everything but /v1 is sent to the console's own site.
  run bash -c "cat > '$dir/channels/api-http.caddy' <<CADDY
http://:$API_PORT {
	import binds/api-http.bind
	handle /v1* {
		reverse_proxy 127.0.0.1:$CONSOLE_PORT {
			flush_interval -1
		}
	}
	handle {
		redir $( [[ $TLS_MODE == domain ]] && printf 'https://%s' "$DOMAIN" || printf '%s://{host}:%s' "$scheme" "$CONSOLE_TLS_PORT" ){uri} permanent
	}
}
CADDY"

  # ComfyUI has no authentication of its own, so its channel is a snippet the
  # console instantiates once per instance it publishes: each site block
  # forward_auths against the console and only then proxies. The console
  # appends those blocks below this snippet; the file must exist for that.
  # \`tls internal\` here regardless of mode: ComfyUI is published under this
  # machine's own names, which no public CA would sign.
  run bash -c "cat > '$dir/channels/comfyui.caddy' <<CADDY
(comfyui-channel) {
	import binds/comfyui.bind
	tls internal
	forward_auth 127.0.0.1:$CONSOLE_PORT {
		uri /api/auth/me
		copy_headers Cookie Authorization X-Api-Key
		header_up -Connection
		header_up -Upgrade
	}
	reverse_proxy 127.0.0.1:{args[0]} {
		flush_interval -1
	}
}
CADDY"

  # Empty bind files: no \`bind\` directive means listen everywhere, which is
  # what a fresh install needs to be reachable at all. The console's
  # connections page narrows them to LAN or Tailscale.
  run touch "$dir/channels/binds/api-http.bind" "$dir/channels/binds/comfyui.bind"

  if ! $DRY_RUN; then
    "$HOME/.local/bin/caddy" validate --config "$dir/Caddyfile" --adapter caddyfile >/dev/null 2>&1 \
      || die "$(L "產生的 Caddyfile 沒有通過 caddy validate。" "The generated Caddyfile failed caddy validate.")" "$(L "看" "See") $HOME/.local/bin/caddy validate --config $dir/Caddyfile"
  fi
  ok "$(L "Caddy 設定" "Caddy config") (${TLS_MODE:-http})"
}

# What the TLS mode needs from root, done here so the plan could announce it.
trust_caddy() {
  case $TLS_MODE in
    internal)
      # Installs Caddy's local root into the system trust store, so browsers
      # and curl on this machine accept the certificate. Other devices import
      # the same file by hand; finish() prints where it is.
      as_root "$HOME/.local/bin/caddy" trust
      ok "caddy trust$(L "（這台機器信任自簽 CA）" " (this machine trusts the own CA)")" ;;
    domain)
      # A user service cannot open :80/:443. Granting the binary the one
      # capability it needs is narrower than running it as root.
      as_root setcap cap_net_bind_service=+ep "$HOME/.local/bin/caddy"
      ok "setcap$(L "（讓 caddy 以一般帳號綁 80/443）" " (lets caddy bind 80/443 as an ordinary user)")" ;;
  esac
}

# SearXNG, if asked for. The agent's web search goes through it, and the
# console offers the model that tool only when an instance answers on the
# configured address -- so an absent SearXNG removes a capability rather than
# breaking anything, which is why this is optional.
#
# A user unit that runs the container in the foreground, rather than
# `docker run --restart unless-stopped`: then "start everything" and "start
# after the re-login the docker group needs" are one mechanism, the one the
# other units already use, instead of docker and systemd each having an
# opinion about when this comes up. On loopback only: SearXNG has no
# authentication and is not something to publish.
write_searxng() {
  [[ $WANT_SEARXNG == y ]] || return 0
  local dir="$ROOT/searxng"
  run mkdir -p "$dir/config"
  # The secret signs SearXNG's own sessions. Generated once and kept in a
  # file the unit reads, never on a command line where `ps` would show it.
  if [[ ! -s $dir/env ]]; then
    run bash -c "umask 077; printf 'SEARXNG_SECRET=%s\n' \"\$(head -c 32 /dev/urandom | base64 -w0)\" > '$dir/env'"
    ok "SearXNG secret"
  else
    skip "$(L "SearXNG secret 已存在" "SearXNG secret already there")"
  fi
  local docker; docker=$(command -v docker || echo /usr/bin/docker)
  local unit="$HOME/.config/systemd/user/tenkstack-searxng.service"
  run mkdir -p "$(dirname "$unit")"
  run bash -c "cat > '$unit' <<UNIT
[Unit]
Description=SearXNG - web search for the TenkStack agent (loopback only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$dir/env
# A container left behind by an unclean stop would make the next run fail
# on the name; removing it first is what makes Restart= actually restart.
ExecStartPre=-$docker rm -f tenkstack-searxng
ExecStart=$docker run --rm --name tenkstack-searxng -p 127.0.0.1:$SEARXNG_PORT:8080 -v $dir/config:/etc/searxng -e SEARXNG_SECRET -e SEARXNG_BASE_URL=http://127.0.0.1:$SEARXNG_PORT/ docker.io/searxng/searxng:latest
ExecStop=$docker stop tenkstack-searxng
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT"
  ok "SearXNG unit（loopback :$SEARXNG_PORT）"
}

# Every unit this script owns, in start order. SearXNG only when asked for.
units() {
  local list=(tenkstack-llama-swap.service tenkstack-console.service caddy.service)
  if [[ $WANT_SEARXNG == y ]]; then list+=(tenkstack-searxng.service); fi
  printf '%s\n' "${list[@]}"
}

write_units() {
  local dir="$HOME/.config/systemd/user"
  run mkdir -p "$dir"

  # CONSOLE_AI_DIR is written out rather than left to the default in the binary.
  # An installation that is running must not move because a default changed in
  # a later version. The ports likewise: the console has to find llama-swap
  # and SearXNG where this script put them, and write the addresses Caddy
  # serves, even when they are not the defaults.
  run bash -c "cat > '$dir/tenkstack-console.service' <<UNIT
[Unit]
Description=TenkStack console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CONSOLE_AI_DIR=$ROOT
Environment=CONSOLE_PORT=$CONSOLE_PORT
Environment=CONSOLE_LLAMA_SWAP_PORT=$LLAMA_SWAP_PORT
Environment=CONSOLE_API_PORT=$API_PORT
Environment=CONSOLE_TLS_PORT=$CONSOLE_TLS_PORT
Environment=CONSOLE_SEARXNG_URL=http://127.0.0.1:$SEARXNG_PORT
ExecStart=$ROOT/console/tenkstack -listen 127.0.0.1:$CONSOLE_PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT"

  # Intel only: xpu-smi's firmware library opens /dev/mei1 on every start,
  # cannot as a non-root user, and says so twenty times per invocation via
  # syslog(). Sampled every two seconds per card that is 2.5 million journal
  # lines in three days. It cannot be filtered on the console's own unit --
  # journald applies LogFilterPatterns= to the system unit a cgroup belongs
  # to, which for every user service is user@<uid>.service and whose
  # properties come from PID 1, not from the user manager. So the filter is a
  # system drop-in on user@.service, which is the one place journald will
  # read it from. The patterns match nothing else. Needs systemd >= 253.
  if [[ " ${VENDORS[*]} " == *" intel "* ]]; then
    local dropin=/etc/systemd/system/user@.service.d
    if [[ -e $dropin/tenkstack-xpu-smi-log.conf ]]; then
      skip "$(L "xpu-smi 的 journal 過濾已在" "xpu-smi journal filter already there")"
    else
      as_root mkdir -p "$dropin"
      run bash -c "printf '%s\n' \
        '# Written by the TenkStack installer. Drops xpu-smi'\"'\"'s /dev/mei1 permission' \
        '# errors (twenty per invocation, via syslog) that a non-root console cannot' \
        '# avoid. Lives here because journald only reads LogFilterPatterns= from the' \
        '# system unit that owns the cgroup, which for user services is this one.' \
        '[Service]' \
        'LogFilterPatterns=~Cannot establish a handle to the Intel MEI driver' \
        'LogFilterPatterns=~IGSC:' \
        'LogFilterPatterns=~HECI init' \
        | sudo tee '$dropin/tenkstack-xpu-smi-log.conf' >/dev/null"
      as_root systemctl daemon-reload
      ok "$(L "xpu-smi 的 journal 過濾" "xpu-smi journal filter") (user@.service drop-in)"
    fi
  fi

  run bash -c "cat > '$dir/tenkstack-llama-swap.service' <<UNIT
[Unit]
Description=llama-swap - on-demand model swapping for llama.cpp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/llama-swap
ExecStart=$ROOT/llama-swap/llama-swap -config $ROOT/llama-swap/config.yaml -listen 127.0.0.1:$LLAMA_SWAP_PORT -watch-config
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT"
  # Named `caddy`, not `tenkstack-caddy`: that is the unit the console's
  # channel code reloads. Type=notify because Caddy reports readiness itself.
  run bash -c "cat > '$dir/caddy.service' <<UNIT
[Unit]
Description=Caddy - single entry point for TenkStack
After=network-online.target tenkstack-console.service
Wants=network-online.target

[Service]
Type=notify
WorkingDirectory=$ROOT/caddy
ExecStart=$HOME/.local/bin/caddy run --config $ROOT/caddy/Caddyfile
ExecReload=$HOME/.local/bin/caddy reload --config $ROOT/caddy/Caddyfile --force --address unix/%t/caddy-admin.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT"
  ok "$(L "寫好 systemd unit" "wrote the systemd units")"
}

# Enabled before anything is started, and before any reboot. That ordering is
# what makes "reboot last" work: the machine comes back with the stack already
# running, and this script never has to be resumed.
enable_units() {
  run systemctl --user daemon-reload
  # shellcheck disable=SC2046
  run systemctl --user enable --quiet $(units)
  ok "$(L "已註冊為開機啟動" "enabled at boot")"
  if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]]; then
    as_root loginctl enable-linger "$USER"
    ok "enable-linger$(L "（登出之後服務仍然繼續跑）" " (the services keep running after logout)")"
  else
    skip "$(L "linger 已開啟" "linger already on")"
  fi
}

start_and_verify() {
  if $NEEDS_REBOOT; then skip "$(L "需要重開機，服務等開機後自己啟動" "a reboot is needed; the services start after it")"; return; fi
  # The console sets up its own PostgreSQL on its first start (a container
  # under tenkstack-postgres.service, internal/pgserver). Pulling the image
  # here makes a failed pull this script's error, not a console that never
  # answers, and keeps the wait below about the console itself.
  run docker pull -q "$POSTGRES_IMAGE"
  ok "$(L "資料庫映像" "database image") $POSTGRES_IMAGE"
  # shellcheck disable=SC2046
  run systemctl --user start $(units)

  if $DRY_RUN; then return; fi

  if [[ $WANT_SEARXNG == y ]]; then
    # First start pulls the image, which is the slow part; the loop is long
    # for that reason and not because SearXNG itself is slow to come up.
    local n=0
    until curl -sfo /dev/null "http://127.0.0.1:$SEARXNG_PORT/"; do
      n=$((n + 1))
      if [[ $n -gt 180 ]]; then
        die "$(L "SearXNG 沒有回應。" "SearXNG did not answer.")" "$(L "看 journalctl --user -u tenkstack-searxng -n 50；映像是 docker.io/searxng/searxng。" "See journalctl --user -u tenkstack-searxng -n 50; the image is docker.io/searxng/searxng.")"
      fi
      sleep 1
    done
    ok "$(L "SearXNG 回應了（拉映像花了 ${n}s）" "SearXNG answered (pulling the image took ${n}s)")"
  fi
  # Two minutes: its first start also initialises the database and imports
  # what an older version kept in SQLite.
  local n=0
  until curl -sfo /dev/null "http://127.0.0.1:$CONSOLE_PORT/api/health"; do
    n=$((n + 1))
    if [[ $n -gt 120 ]]; then
      die "$(L "主控台起不來。" "The console did not start.")" "$(L "看 journalctl --user -u tenkstack-console -n 50 找原因。" "See journalctl --user -u tenkstack-console -n 50 for why.")"
    fi
    sleep 1
  done
  ok "$(L "主控台回應了" "the console answered")"

  # Through the gateway too, so "installed" means reachable and not merely
  # running. In domain mode the name resolves elsewhere and the certificate
  # is not issued until the first real request from the internet, so that one
  # is checked only as far as the unit being up.
  if [[ $TLS_MODE == domain ]]; then
    systemctl --user is-active --quiet caddy || die "$(L "Caddy 起不來。" "Caddy did not start.")" "$(L "看" "See") journalctl --user -u caddy -n 50."
    ok "$(L "Caddy 在跑（憑證會在第一次從外面連到 $DOMAIN 時申請）" "Caddy is running (the certificate is requested on the first outside request to $DOMAIN)")"
    return
  fi
  local scheme=https; [[ -z $TLS_MODE ]] && scheme=http
  n=0
  until curl -skfo /dev/null "$scheme://127.0.0.1:$CONSOLE_TLS_PORT/api/health"; do
    n=$((n + 1))
    if [[ $n -gt 15 ]]; then
      die "$(L "Caddy 沒有把主控台放出來。" "Caddy is not serving the console.")" "$(L "看" "See") journalctl --user -u caddy -n 50, $(L "或" "or") $HOME/.local/bin/caddy validate --config $ROOT/caddy/Caddyfile"
    fi
    sleep 1
  done
  ok "$(L "經 Caddy 也回應了" "it answers through Caddy too")"
}

finish() {
  local host url; host=$(hostname -f 2>/dev/null || hostname)
  case $TLS_MODE in
    domain) url="https://$DOMAIN" ;;
    "")     url="http://$host:$CONSOLE_TLS_PORT" ;;
    *)      url="https://$host:$CONSOLE_TLS_PORT" ;;
  esac
  step "$(L "完成" "Done")"
  if $NEEDS_REBOOT; then
    say "  $(L "還差一次重新開機：$REBOOT_WHY" "One reboot to go: $REBOOT_WHY")"
    say "  $(L "開機後服務會自己啟動，不需要再跑這個腳本。" "The services start on their own after it; this script need not run again.")"
    say ""
    say "  ${C_B}sudo reboot${C_OFF}"
    say ""
    say "  $(L "回來之後：" "Then: ")$url"
  else
    say "  $url"
    say "  ${C_DIM}$(L "（第一次進去是註冊畫面。第一個帳號建立之後才會開始要求登入。）" "(The first visit shows sign-up. Signing in is required once the first account exists.)")${C_OFF}"
  fi
  case $TLS_MODE in
    internal)
      say "  ${C_DIM}$(L "（自簽 CA。這台已經信任了；別台裝置要匯入這個檔案：" "(Own CA. This machine trusts it already; other devices import this file:")"
      say "    $HOME/.local/share/caddy/pki/authorities/local/root.crt$(L "）" ")")${C_OFF}" ;;
    "")
      say "  ${C_DIM}$(L "（純 HTTP：密碼和 API key 在網路上是明文。若這台會被區網以外連到，" "(Plain HTTP: passwords and API keys cross the network in the clear. If this is reachable beyond the LAN,")"
      say "    $(L "重跑並加 --tls internal 或 --domain，或在前面放一個負責 TLS 的代理。）" "run again with --tls internal or --domain, or put a TLS-terminating proxy in front.)")${C_OFF}" ;;
  esac
  say "  ${C_DIM}$(L "純 /v1 的 HTTP 入口在 :$API_PORT，給不信任私有 CA 的 CLI 工具用；連線頁可以關掉它。" "A plain-HTTP /v1 entrance is on :$API_PORT for CLI tools that do not trust a private CA; the Connections page can close it.")${C_OFF}"
  say ""
  say "  $(L "接下來在主控台裡：" "Next, in the console:")"
  say "    $(L "・「推論引擎」安裝或更新推論引擎" "- Engines: install or update inference engines")"
  say "    $(L "・「ComfyUI」在每張卡上開啟生圖" "- ComfyUI: turn on image generation per card")"
  say "    $(L "・「模型目錄」下載權重" "- Catalog: download weights")"
  if [[ $WANT_SEARXNG == y ]]; then
    say "    $(L "・搜尋已經接好：對話裡的 agent 可以上網查（SearXNG，只聽 127.0.0.1:$SEARXNG_PORT）" "- Search is wired up: the chat's agent can search the web (SearXNG, on 127.0.0.1:$SEARXNG_PORT only)")"
  else
    say "    $(L "・要讓模型能上網搜尋，重跑並加 --searxng" "- For web search, run this again with --searxng")"
  fi
}

# --------------------------------------------------------------------------
# --------------------------------------------------------------------------
# The setup screens
# --------------------------------------------------------------------------

# `tenkstack setup` shows the questions as screens, in two phases around the
# survey: first the language (and, when an install is found, install or
# uninstall), then -- with the survey's findings -- the install's choices,
# ending on the one confirmation. It runs from the release binary, fetched to
# a temporary directory: the same file the install puts in place later, so
# there is one thing to trust. When it cannot run, the plain questions below
# take over.
SETUP_BIN=""
SETUP_TMP=""
CONFIRMED=false

setup_ui_fetch() {
  if $NO_TUI || $ASSUME_YES || [[ ! -t 0 || ! -t 1 ]]; then return 1; fi
  local arch
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case $arch in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  SETUP_TMP=$(mktemp -d)
  trap 'rm -rf "$SETUP_TMP"' EXIT
  printf '\n  %s\n' "Loading the setup screens / 載入安裝畫面…"
  if ! curl -fsSL -o "$SETUP_TMP/tenkstack" "$RELEASE_URL/tenkstack-linux-$arch"; then return 1; fi
  # A release from before the setup screens would take `setup` for noise
  # and start serving, so it is recognised by a marker in the file rather
  # than by running it.
  if ! grep -qa "TENKSTACK_SETUP_PROTOCOL=1" "$SETUP_TMP/tenkstack"; then return 1; fi
  chmod +x "$SETUP_TMP/tenkstack"
  SETUP_BIN="$SETUP_TMP/tenkstack"
}

# Runs one phase; 0 answered, exits on a cancel, 1 when it could not run.
setup_ui_run() {
  local code=0
  if "$SETUP_BIN" setup --out "$SETUP_TMP/answers" "$@"; then code=0; else code=$?; fi
  case $code in
    0) return 0 ;;
    1) exit 0 ;;
    *) return 1 ;;
  esac
}

setup_ui_start() {
  local args=(--phase start)
  if $LANG_GIVEN; then args+=(--lang "$UI_LANG"); fi
  setup_ui_run "${args[@]}" || return 1
  # shellcheck disable=SC1091
  . "$SETUP_TMP/answers"
}

# What the survey found, for the confirmation to list every change.
write_facts() {
  local listening busy=() p
  listening=$(ss -ltn 2>/dev/null || true)
  for p in 80 443 "$SEARXNG_PORT"; do
    if grep -q ":$p " <<<"$listening"; then busy+=("$p"); fi
  done
  {
    printf 'MISSING_PKGS="%s"\nMISSING_GROUPS="%s"\n' "${MISSING_PKGS[*]}" "${MISSING_GROUPS[*]}"
    printf 'NEEDS_REBOOT="%s"\nREBOOT_WHY="%s"\n' "$NEEDS_REBOOT" "$REBOOT_WHY"
    printf 'HAVE_SETCAP="%s"\n' "$(command -v setcap >/dev/null && echo true || echo false)"
    printf 'LINGER="%s"\n' "$([[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) == yes ]] && echo true || echo false)"
    printf 'XPU_FILTER="%s"\n' "$([[ -e /etc/systemd/system/user@.service.d/tenkstack-xpu-smi-log.conf ]] && echo true || echo false)"
    printf 'INTEL="%s"\n' "$([[ " ${VENDORS[*]} " == *" intel "* ]] && echo true || echo false)"
    printf 'BUSY_PORTS="%s"\nSEARXNG_PORT="%s"\nCONSOLE_TLS_PORT="%s"\n' "${busy[*]}" "$SEARXNG_PORT" "$CONSOLE_TLS_PORT"
    printf 'HOST="%s"\nDRY_RUN="%s"\n' "$(hostname -f 2>/dev/null || hostname)" "$DRY_RUN"
  } > "$SETUP_TMP/facts"
}

setup_ui_install() {
  write_facts
  local args=(--phase install --lang "$UI_LANG" --facts "$SETUP_TMP/facts" --dir "${ROOT:-$ROOT_DEFAULT}")
  if [[ -n $ENGINES ]]; then args+=(--engines "$ENGINES"); fi
  if [[ -n $COMFY_CARDS ]]; then args+=(--comfyui "$COMFY_CARDS"); fi
  if [[ -n $WANT_SEARXNG ]]; then args+=(--searxng "$WANT_SEARXNG"); fi
  case $TLS_MODE in internal|domain) args+=(--tls "$TLS_MODE") ;; esac
  if [[ -n $DOMAIN ]]; then args+=(--domain "$DOMAIN"); fi
  setup_ui_run "${args[@]}" || return 1
  # A certificate given as a flag has no place on the screens; it survives them.
  local mode=$TLS_MODE cert=$TLS_CERT key=$TLS_KEY
  # shellcheck disable=SC1091
  . "$SETUP_TMP/answers"
  if [[ $mode == cert ]]; then TLS_MODE=cert; TLS_CERT=$cert; TLS_KEY=$key; fi
  CONFIRMED=true
}

# The plain path's first question, when neither --lang nor a screen said.
ask_language() {
  if $LANG_GIVEN || $ASSUME_YES || [[ ! -t 0 ]]; then return; fi
  local answer="" default=1
  [[ $UI_LANG == zh-TW ]] && default=2
  printf '\n  Language / 語言\n    1) English\n    2) 繁體中文\n'
  read -r -p "  [$default] " answer || true
  case ${answer:-$default} in 2) UI_LANG=zh-TW ;; *) UI_LANG=en ;; esac
}

# Engines and ComfyUI, installed by the console itself once it is up and
# before anyone has signed up -- until then it asks for no password.
provision() {
  if [[ -z $ENGINES && -z $COMFY_CARDS ]]; then return; fi
  step "$(L "⑧ 推論引擎與 ComfyUI" "⑧ Engines and ComfyUI")"
  if $NEEDS_REBOOT; then
    skip "$(L "要等重開機之後，到「推論引擎」與「ComfyUI」頁安裝" "after the reboot, install them from the Engines and ComfyUI pages")"
    return
  fi
  local args=(provision --api "http://127.0.0.1:$CONSOLE_PORT" --lang "$UI_LANG")
  if [[ -n $ENGINES ]]; then args+=(--engines "$ENGINES"); fi
  if [[ -n $COMFY_CARDS ]]; then args+=(--comfyui "$COMFY_CARDS"); fi
  run "$ROOT/console/tenkstack" "${args[@]}" \
    || warn "$(L "沒有全部裝好；之後可以在主控台的「推論引擎」與「ComfyUI」頁再裝。" "Not everything installed; the console's Engines and ComfyUI pages can finish it.")"
}

main() {
  local screens=false
  if setup_ui_fetch && setup_ui_start; then screens=true; else ask_language; fi
  # The screens offer to remove an install they found.
  if [[ $ACTION == uninstall ]]; then uninstall_main; return; fi

  step "$(L "① 盤點" "① Survey")"
  survey_os
  survey_cards
  survey_drivers
  survey_deps

  step "$(L "② 選項" "② Choices")"
  if $screens && setup_ui_install; then
    ROOT=${ROOT/#\~/$HOME}
    skip "$(L "已在安裝畫面選好" "chosen on the setup screens")"
    if [[ -n $TLS_MODE ]]; then WANT_TLS=y; fi
    if $FROM_SOURCE; then CODE="${CODE:-$CODE_DEFAULT}"; fi
    CODE="${CODE:-$CODE_DEFAULT}"
  else
  ask    ROOT "$(L "安裝目錄 " "Install directory ")" "${ROOT:-$ROOT_DEFAULT}"
  if $FROM_SOURCE; then ask CODE "$(L "程式碼放哪 " "Where the source goes ")" "${CODE:-$CODE_DEFAULT}"; else CODE="${CODE:-$CODE_DEFAULT}"; fi
  ask_yn WANT_SEARXNG "$(L "裝 SearXNG（讓模型能上網搜尋）？" "Install SearXNG (web search for the models)? ")" n
  # TLS: a flag pre-answers this the same way --searxng pre-answers the one
  # above. Otherwise two questions at most -- whether to encrypt, and if so
  # whether there is a public name for Let's Encrypt; no name means Caddy's
  # own CA. Plain HTTP is the default because a proxy in front is common and
  # a second certificate behind one only gets in its way.
  if [[ -n $TLS_MODE ]]; then
    WANT_TLS=y
    skip "HTTPS: ${TLS_MODE}$(L "（由參數決定）" " (set by a flag)")"
  else
    ask_yn WANT_TLS "$(L "要 HTTPS 嗎？（前面已有反向代理就選 n）" "HTTPS? (n when a proxy in front already does TLS) ")" n
    if [[ $WANT_TLS == y ]]; then
      ask DOMAIN "$(L "有公開網域嗎？留空就用 Caddy 自簽 CA " "A public domain? Empty uses Caddy's own CA ")" ""
      if [[ -n $DOMAIN ]]; then TLS_MODE=domain; else TLS_MODE=internal; fi
    fi
  fi
  fi
  check_choices

  show_plan

  step "$(L "③ 安裝相依" "③ Dependencies")"
  install_deps
  install_groups
  trust_caddy

  step "$(L "④ 取得主控台" "④ The console")"
  fetch_console

  step "$(L "⑤ 建立目錄與設定" "⑤ Directories and settings")"
  make_skeleton
  write_caddy
  write_searxng

  step "$(L "⑥ 註冊服務" "⑥ Services")"
  write_units
  enable_units

  step "$(L "⑦ 啟動" "⑦ Start")"
  start_and_verify

  provision

  finish
}

# --------------------------------------------------------------------------
# Uninstall
#
# Undoes what the install did, found on the machine rather than assumed: the
# install directory is read from the console's unit, containers are the ones
# with a mount under it, and a unit is only touched when it names it -- so a
# machine that also runs a Caddy or a ComfyUI of its own keeps them. The
# install directory itself is data (models, ComfyUI files, settings, chat
# history) and stays unless --purge; packages, groups and linger stay too,
# since other things may use them.
# --------------------------------------------------------------------------

installed_root() {
  local unit="$HOME/.config/systemd/user/tenkstack-console.service" line
  if [[ -n $ROOT ]]; then echo "$ROOT"; return; fi
  if [[ -r $unit ]]; then
    line=$(grep -m1 '^ExecStart=' "$unit" || true)
    line=${line#ExecStart=}; line=${line%% *}
    if [[ $line == */console/tenkstack ]]; then echo "${line%/console/tenkstack}"; return; fi
  fi
  echo "$ROOT_DEFAULT"
}

# Units of this install: those whose file names its directory.
own_units() {
  local dir="$HOME/.config/systemd/user" u
  for u in tenkstack-console tenkstack-postgres tenkstack-llama-swap tenkstack-searxng caddy; do
    if [[ -f $dir/$u.service ]] && grep -qF "$ROOT/" "$dir/$u.service"; then echo "$u.service"; fi
  done
  return 0
}

# Containers with a bind mount under the install directory: the engines,
# ComfyUI and SearXNG this install started, and nothing that only shares a name.
own_containers() {
  command -v docker >/dev/null || return 0
  local id
  for id in $(docker ps -aq 2>/dev/null || true); do
    docker inspect -f '{{.Name}}{{range .Mounts}} {{.Source}}{{end}}' "$id" 2>/dev/null || true
  done | awk -v root="$ROOT/" '{ for (i = 2; i <= NF; i++) if (index($i, root) == 1) { sub(/^\//, "", $1); print $1; break } }'
}

# Images those containers run, and the ones the launchers and the SearXNG unit
# name, which may have no container at the moment.
own_images() {
  local c
  {
    for c in "$@"; do docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true; done
    grep -ohE 'IMAGE="\$\{[A-Z_]+_IMAGE:-[^}"]+\}"' "$ROOT"/llama-swap/*.sh 2>/dev/null | sed -E 's/.*:-([^}]+)\}"/\1/' || true
    if [[ -f $HOME/.config/systemd/user/tenkstack-searxng.service ]] && grep -qF "$ROOT/" "$HOME/.config/systemd/user/tenkstack-searxng.service"; then
      echo docker.io/searxng/searxng:latest
    fi
  } | sort -u
  return 0
}

uninstall_main() {
  ROOT=$(installed_root)
  ROOT=${ROOT%/}
  local units containers images dropin=/etc/systemd/system/user@.service.d/tenkstack-xpu-smi-log.conf
  mapfile -t units < <(own_units)
  mapfile -t containers < <(own_containers)
  images=()
  if ! $KEEP_IMAGES && command -v docker >/dev/null; then mapfile -t images < <(own_images "${containers[@]}"); fi
  # The xpu-smi filter is a system file every full install writes along with
  # the console's unit; without that unit it is not this install's to remove.
  if [[ " ${units[*]} " != *" tenkstack-console.service "* ]]; then dropin=""; fi
  local trusted=false
  if [[ " ${units[*]} " == *" caddy.service "* ]] && grep -qs 'tls internal' "$ROOT/caddy/Caddyfile"; then trusted=true; fi

  if [[ ${#units[@]} -eq 0 && ${#containers[@]} -eq 0 && ! -d $ROOT ]]; then
    say "  $(L "這台機器上找不到 TenkStack（$ROOT）。沒有東西要移除。" "No TenkStack found on this machine ($ROOT). Nothing to remove.")"
    exit 0
  fi

  step "$(L "移除計畫" "Uninstall plan")"
  say "  $(L "安裝目錄      " "Directory     ")$ROOT"
  say "  $(L "服務          " "Services      ")${units[*]:-$(L "（無）" "(none)")}"
  say "  $(L "容器          " "Containers    ")${containers[*]:-$(L "（無）" "(none)")}"
  if $KEEP_IMAGES; then
    say "  $(L "映像          " "Images        ")$(L "保留（--keep-images）" "kept (--keep-images)")"
  else
    say "  $(L "映像          " "Images        ")${images[*]:-$(L "（無）" "(none)")}"
  fi
  if [[ -n $dropin && -f $dropin ]]; then say "  $(L "系統設定      " "System        ")$dropin$(L "（sudo）" " (sudo)")"; fi
  if $trusted; then say "  $(L "憑證信任      " "Trust         ")$(L "移除 Caddy 自簽 CA 的系統信任（sudo）" "untrust Caddy's own CA (sudo)")"; fi
  if $PURGE; then
    warn "$(L "--purge：整個 $ROOT 會被刪除，包含模型、ComfyUI 的檔案、設定與對話紀錄。" "--purge: all of $ROOT is deleted, models, ComfyUI files, settings and chats included.")"
  else
    say "  $(L "保留          " "Kept          ")$ROOT$(L "（模型、ComfyUI 檔案、設定、對話紀錄；只刪程式檔）" " (models, ComfyUI files, settings, chats; only the programs go)")"
  fi
  say "  ${C_DIM}$(L "系統套件、群組、linger 與 ~/.local/bin/caddy 都保留，其他程式可能也在用。" "Packages, groups, linger and ~/.local/bin/caddy stay; other things may use them.")${C_OFF}"
  if $DRY_RUN; then say ""; skip "$(L "--dry-run：以下只會印出，不會執行" "--dry-run: what follows is printed, not done")"; fi

  if ! $ASSUME_YES && [[ -t 0 ]]; then
    local go=""
    read -r -p "  $(L "移除？[y/N] " "Remove? [y/N] ")" go || true
    if [[ ! ${go:-n} =~ ^[Yy] ]]; then say "  $(L "取消了，什麼都沒有動。" "Cancelled. Nothing was changed.")"; exit 0; fi
    if $PURGE; then
      local typed=""
      read -r -p "  $(L "確定要刪掉模型？輸入安裝目錄的完整路徑：" "Delete the models too? Type the install directory's full path: ")" typed || true
      if [[ $typed != "$ROOT" ]]; then say "  $(L "路徑不符，取消了，什麼都沒有動。" "That is not the path. Cancelled; nothing was changed.")"; exit 0; fi
    fi
  fi

  step "$(L "移除" "Removing")"
  if [[ ${#units[@]} -gt 0 ]]; then
    run systemctl --user disable --now "${units[@]}" || true
    local u
    for u in "${units[@]}"; do run rm -f "$HOME/.config/systemd/user/$u"; done
    run systemctl --user daemon-reload
    ok "$(L "停止並移除服務" "stopped and removed the services")"
  fi
  if [[ ${#containers[@]} -gt 0 ]]; then
    if $DRY_RUN; then run docker rm -f "${containers[@]}"; else docker rm -f "${containers[@]}" >/dev/null; fi
    ok "$(L "移除容器" "removed the containers")"
  fi
  local img others
  for img in "${images[@]}"; do
    others=$(docker ps -aq --filter "ancestor=$img" 2>/dev/null || true)
    if [[ -n $others ]] && ! $DRY_RUN; then
      skip "$(L "$img 還有別的容器在用，保留" "$img is still used by another container; kept")"
      continue
    fi
    if $DRY_RUN; then run docker rmi "$img"; continue; fi
    if docker rmi "$img" >/dev/null 2>&1; then ok "$(L "移除映像" "removed image") $img"
    else skip "$(L "$img 移除不了，保留" "$img could not be removed; kept")"; fi
  done
  if $trusted && [[ -x $HOME/.local/bin/caddy ]]; then
    as_root "$HOME/.local/bin/caddy" untrust || warn "$(L "caddy untrust 失敗；可以之後自己跑一次" "caddy untrust failed; it can be run by hand later")"
    ok "caddy untrust"
  fi
  if [[ -n $dropin && -f $dropin ]]; then
    as_root rm -f "$dropin"
    as_root systemctl daemon-reload
    ok "$(L "移除 xpu-smi 的 journal 過濾" "removed the xpu-smi journal filter")"
  fi
  if $PURGE; then
    run rm -rf "$ROOT"
    ok "$(L "刪除 $ROOT" "deleted $ROOT")"
  elif [[ -d $ROOT ]]; then
    run rm -rf "$ROOT/console" "$ROOT/llama-swap/llama-swap" "$ROOT/go"
    ok "$(L "刪除程式檔；其餘保留在 $ROOT" "deleted the programs; the rest stays in $ROOT")"
  fi

  step "$(L "完成" "Done")"
  if ! $PURGE && [[ -d $ROOT ]]; then
    say "  $(L "$ROOT 還在。重跑安裝會沿用裡面的模型與設定；不要了就刪掉它，或加 --purge 重跑。" "$ROOT is still there. Installing again picks up its models and settings; delete it, or run again with --purge, if they are not wanted.")"
  fi
}

if $UNINSTALL; then ask_language; uninstall_main; else main "$@"; fi
