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
# was first built on. Never left to the default in `paths.py`: the unit files
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
WANT_SEARXNG=""
WANT_COMFYUI=""
ASSUME_YES=false
DRY_RUN=false

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
OS_ID=""; OS_VER=""; OS_PRETTY=""
VENDORS=()
NEEDS_REBOOT=false
REBOOT_WHY=""
MISSING_PKGS=()
MISSING_GROUPS=()
SUDO_NEEDED=false

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

trap 'die "安裝在第 $LINENO 行中止了。" "上面最後一個 ==> 步驟是失敗的地方；修好之後重跑這個腳本，已經完成的部分會自動跳過。"' ERR

# `run` is the only way anything happens, so --dry-run has one place to be
# honoured rather than a check at every call site.
run() {
  if $DRY_RUN; then
    printf '  %s會執行:%s %s\n' "$C_DIM" "$C_OFF" "$*"
    return 0
  fi
  "$@"
}

as_root() {
  if $DRY_RUN; then
    printf '  %s會執行（sudo）:%s %s\n' "$C_DIM" "$C_OFF" "$*"
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
    skip "$prompt$default（未互動）"
    return
  fi
  read -r -p "  $prompt[$default] " answer || true
  printf -v "$__var" '%s' "${answer:-$default}"
}

ask_yn() {
  # ask_yn VAR "prompt" "y|n" -- honours an answer already set by a flag
  local __var=$1 prompt=$2 default=$3 answer=""
  if [[ -n "${!__var}" ]]; then skip "$prompt${!__var}（由參數決定）"; return; fi
  if $ASSUME_YES || [[ ! -t 0 ]]; then
    printf -v "$__var" '%s' "$default"
    skip "$prompt$default（未互動）"
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
  cat <<EOF
TenkStack installer

  --dir PATH          安裝目錄（預設 $ROOT_DEFAULT）
  --code PATH         程式碼 checkout（預設 $CODE_DEFAULT）
  --tls internal      Caddy 自簽 CA 做 HTTPS（隔離區網用；每台裝置要信任一次）
  --tls CERT,KEY      用你自己的憑證檔做 HTTPS
  --domain NAME       用公開網域，Let's Encrypt 自動簽（需要 80/443 對外可達）
                      三個都不給 = 純 HTTP :$CONSOLE_TLS_PORT，外面已有反向代理時選這個
  --searxng           裝 SearXNG（Docker，讓模型能上網搜尋）
  --no-searxng        不裝
  --comfyui           裝 ComfyUI（Docker，畫圖；映像很大）
  --no-comfyui        不裝
  --yes               全部用預設值，完全不問
  --dry-run           印出會做什麼，不執行任何動作
  --help

環境變數：TENKSTACK_REPO、TENKSTACK_REF、CONSOLE_PORT、CONSOLE_TLS_PORT、CONSOLE_API_PORT
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --dir)         ROOT=${2:?--dir 需要一個路徑}; shift 2 ;;
    --code)        CODE=${2:?--code 需要一個路徑}; shift 2 ;;
    --searxng)     WANT_SEARXNG=y; shift ;;
    --no-searxng)  WANT_SEARXNG=n; shift ;;
    --comfyui)     WANT_COMFYUI=y; shift ;;
    --no-comfyui)  WANT_COMFYUI=n; shift ;;
    --tls)
      case "${2:?--tls 需要 internal 或 CERT,KEY}" in
        internal) TLS_MODE=internal ;;
        *,*)      TLS_MODE=cert; TLS_CERT=${2%%,*}; TLS_KEY=${2#*,} ;;
        *)        die "不認得的 --tls 值：$2" "用 internal，或 憑證檔,金鑰檔。" ;;
      esac
      shift 2 ;;
    --domain)      DOMAIN=${2:?--domain 需要一個網域名稱}; TLS_MODE=domain; shift 2 ;;
    --yes|-y)      ASSUME_YES=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --help|-h)     usage; exit 0 ;;
    *)             die "不認得的參數：$1" "用 --help 看可用的參數。" ;;
  esac
done

# --------------------------------------------------------------------------
# ① Survey -- reads everything, changes nothing
# --------------------------------------------------------------------------

survey_os() {
  [[ -r /etc/os-release ]] || die "讀不到 /etc/os-release。" "這個腳本只支援 systemd 的 Linux 發行版。"
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_VER="${VERSION_ID:-}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID}"
  ok "$OS_PRETTY，核心 $(uname -r)"

  case "$OS_ID" in
    ubuntu|debian|pop|linuxmint) : ;;
    *) warn "沒有在 $OS_ID 上測過。套件安裝那幾步可能要你自己來。" ;;
  esac

  if [[ $(id -u) -eq 0 ]]; then die "請不要用 root 跑這個腳本。" \
      "主控台是 systemd user service，用一般帳號跑。需要 sudo 的三個地方會分別提示。"; fi
  command -v systemctl >/dev/null || die "找不到 systemctl。" "這個腳本需要 systemd。"
}

# Vendors are read from PCI IDs, which need no driver -- the whole point is to
# work out what to install before anything is installed.
survey_cards() {
  local ids
  ids=$(lspci -nn 2>/dev/null | grep -iE 'vga|display|3d' || true)
  if [[ -z $ids ]]; then warn "看不到任何顯示卡。CPU 也能跑，只是很慢。"; return; fi

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
    ok "偵測到 $v 顯示卡（$n 張顯示裝置）"
  done
  if [[ ${#VENDORS[@]} -eq 0 ]]; then warn "顯示卡的廠商認不出來，會照純 CPU 安裝。"; fi
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
          ok "$v：核心模組已載入，沒有驅動要裝"
        else
          warn "$v：核心模組沒有載入。$mod 在主線核心裡，通常代表韌體或核心參數的問題。"
        fi
        if [[ ! -e /dev/dri ]]; then warn "沒有 /dev/dri，容器拿不到這張卡。"; fi
        ;;
      nvidia)
        if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
          ok "nvidia：驅動已就緒"
        else
          MISSING_PKGS+=("nvidia-driver")
          NEEDS_REBOOT=true
          REBOOT_WHY="剛安裝 NVIDIA 驅動"
          if command -v mokutil >/dev/null && mokutil --sb-state 2>/dev/null | grep -qi enabled; then
            REBOOT_WHY="$REBOOT_WHY（Secure Boot 開著，開機時會要求輸入 MOK 密碼）"
          fi
          warn "nvidia：需要安裝驅動，而且會需要重新開機一次"
        fi
        if docker info 2>/dev/null | grep -q nvidia; then
          ok "nvidia-container-toolkit 已設定"
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
    if command -v "$t" >/dev/null; then ok "$t"; else MISSING_PKGS+=("$t"); warn "缺 $t"; fi
  done
  # uv and node are installed from their own upstreams rather than apt: the
  # distro versions are routinely too old, and this needs 3.12+ and Node 24+.
  command -v uv   >/dev/null && ok "uv"   || { MISSING_PKGS+=("uv");   warn "缺 uv"; }
  command -v node >/dev/null && ok "node $(node --version)" || { MISSING_PKGS+=("node"); warn "缺 node"; }
  command -v caddy >/dev/null && ok "caddy" || MISSING_PKGS+=("caddy")

  for g in docker render; do
    getent group "$g" >/dev/null || continue
    if id -nG | tr ' ' '\n' | grep -qx "$g"; then
      ok "已在 $g 群組"
    else
      MISSING_GROUPS+=("$g")
      warn "不在 $g 群組"
    fi
  done

  local free; free=$(df -BG --output=avail "$HOME" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [[ -n $free && $free -lt 40 ]]; then
    warn "家目錄只剩 ${free}G，模型權重通常要幾十 G。"
  fi

  case $TLS_MODE in
    cert)
      [[ -r $TLS_CERT ]] || die "讀不到憑證檔 $TLS_CERT" "--tls 要的是 憑證檔,金鑰檔。"
      [[ -r $TLS_KEY  ]] || die "讀不到金鑰檔 $TLS_KEY"  "--tls 要的是 憑證檔,金鑰檔。"
      ok "憑證 $TLS_CERT" ;;
    domain)
      # Binding :80 and :443 without root needs a capability on the binary,
      # and that needs setcap. Everything else Caddy does runs unprivileged.
      command -v setcap >/dev/null || MISSING_PKGS+=("libcap2-bin")
      ok "網域 $DOMAIN（Let's Encrypt；80/443 要能從外面連到這台）" ;;
    internal) ok "HTTPS，Caddy 自簽 CA" ;;
    "")       ok "純 HTTP（外層若有反向代理，由它負責 TLS）" ;;
  esac

  local listening; listening=$(ss -ltn 2>/dev/null || true)
  local want_ports=("$CONSOLE_PORT" "$LLAMA_SWAP_PORT" "$CONSOLE_TLS_PORT" "$API_PORT")
  if [[ $TLS_MODE == domain ]]; then want_ports+=(80 443); fi
  for p in "${want_ports[@]}"; do
    if grep -q ":$p " <<<"$listening"; then
      # A survey finding, not a failure, while nothing is being changed --
      # --dry-run on a machine that already runs this stack would otherwise
      # stop before printing the plan it was asked for.
      if $DRY_RUN; then
        warn "連接埠 $p 已經被佔用（dry-run，繼續）"
      else
        die "連接埠 $p 已經被佔用。" "換一個（CONSOLE_PORT=…）或把佔用它的東西停掉。"
      fi
    fi
  done
}

# --------------------------------------------------------------------------
# ② The plan, and one confirmation
# --------------------------------------------------------------------------

show_plan() {
  step "計畫"
  say "  安裝目錄      $ROOT"
  say "  程式碼        $CODE"
  say "  顯示卡        ${VENDORS[*]:-（無）}"
  say "  SearXNG       $WANT_SEARXNG"
  say "  ComfyUI       $WANT_COMFYUI"
  case $TLS_MODE in
    "")       say "  對外          http://<這台>:$CONSOLE_TLS_PORT（無 TLS）" ;;
    internal) say "  對外          https://<這台>:$CONSOLE_TLS_PORT（自簽 CA，會跑 caddy trust）" ;;
    cert)     say "  對外          https://<這台>:$CONSOLE_TLS_PORT（$TLS_CERT）" ;;
    domain)   say "  對外          https://$DOMAIN（Let's Encrypt，會 setcap caddy）" ;;
  esac
  if [[ ${#MISSING_PKGS[@]}   -gt 0 ]]; then say "  會安裝        ${MISSING_PKGS[*]}"; fi
  if [[ ${#MISSING_GROUPS[@]} -gt 0 ]]; then say "  會加入群組    ${MISSING_GROUPS[*]}"; fi
  if [[ $TLS_MODE == internal || $TLS_MODE == domain ]]; then SUDO_NEEDED=true; fi
  if $NEEDS_REBOOT; then
    say ""
    warn "這次安裝結束後需要重新開機一次：$REBOOT_WHY"
    warn "重開機是最後一步。開機後服務會自己啟動，不用再跑這個腳本。"
  else
    say ""
    ok "不需要重新開機"
  fi

  if [[ ${#MISSING_PKGS[@]} -gt 0 || ${#MISSING_GROUPS[@]} -gt 0 ]]; then
    SUDO_NEEDED=true
    say "  ${C_DIM}上面的安裝與群組變更會用到 sudo，其他步驟都以 $USER 身分執行。${C_OFF}"
  fi

  if $DRY_RUN; then say ""; skip "--dry-run：以下只會印出，不會執行"; fi
  if $ASSUME_YES || [[ ! -t 0 ]]; then return; fi
  local go=""
  read -r -p "  繼續？[Y/n] " go || true
  if [[ ${go:-y} =~ ^[Nn] ]]; then say "  取消了，什麼都沒有動。"; exit 0; fi
}

# --------------------------------------------------------------------------
# ③ Install -- from here on it does not ask
# --------------------------------------------------------------------------

apt_install() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

install_deps() {
  if [[ ${#MISSING_PKGS[@]} -eq 0 ]]; then skip "相依都齊了"; return; fi

  # Refresh the index, never upgrade. See the header.
  local apt_wanted=()
  for p in "${MISSING_PKGS[@]}"; do
    case $p in
      git|curl) apt_wanted+=("$p") ;;
    esac
  done
  if [[ ${#apt_wanted[@]} -gt 0 ]]; then
    as_root apt-get update -qq
    apt_install "${apt_wanted[@]}"
    ok "裝好 ${apt_wanted[*]}"
  fi

  for p in "${MISSING_PKGS[@]}"; do
    case $p in
      docker)
        run bash -c 'curl -fsSL https://get.docker.com | sh'
        ok "裝好 docker" ;;
      uv)
        run bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
        ok "裝好 uv" ;;
      node)
        run bash -c 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -'
        apt_install nodejs
        ok "裝好 node" ;;
      caddy)
        run mkdir -p "$HOME/.local/bin"
        run curl -fsSL -o "$HOME/.local/bin/caddy" \
            "https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)"
        run chmod +x "$HOME/.local/bin/caddy"
        ok "裝好 caddy" ;;
      nvidia-driver)
        if command -v ubuntu-drivers >/dev/null; then
          as_root ubuntu-drivers install
        else
          warn "這個發行版沒有 ubuntu-drivers；請自行安裝 NVIDIA 驅動後重跑。"
        fi
        ok "裝好 NVIDIA 驅動（重開機後生效）" ;;
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
        ok "裝好 nvidia-container-toolkit" ;;
    esac
  done
}

install_groups() {
  if [[ ${#MISSING_GROUPS[@]} -eq 0 ]]; then skip "群組都對了"; return; fi
  for g in "${MISSING_GROUPS[@]}"; do
    as_root usermod -aG "$g" "$USER"
    ok "加入 $g 群組"
  done
  # A group is granted at login, so the session running this script still does
  # not have it. Not a reboot -- but the services must not be started before it
  # takes effect, which is why the reboot (or re-login) is at the end.
  NEEDS_REBOOT=true
  REBOOT_WHY="${REBOOT_WHY:-群組變更要重新登入才會生效}"
}

fetch_code() {
  if [[ -d $CODE/.git ]]; then
    run git -C "$CODE" fetch --quiet origin "$REPO_REF"
    run git -C "$CODE" checkout --quiet "$REPO_REF"
    ok "更新 $CODE"
  else
    run mkdir -p "$(dirname "$CODE")"
    run git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$CODE"
    ok "clone 到 $CODE"
  fi
}

build_console() {
  run bash -c "cd '$CODE/server' && uv sync --quiet"
  ok "後端相依"
  run bash -c "cd '$CODE/web' && npm ci --silent && npm run build --silent"
  ok "前端 build"
}

make_skeleton() {
  # `paths.py` deliberately creates nothing -- turning "not set up" into "set up
  # and empty" hides the difference -- so the directories are this script's job.
  for d in models llama-swap comfyui caddy/channels console; do
    run mkdir -p "$ROOT/$d"
  done
  ok "建好 $ROOT"

  if [[ ! -x $ROOT/llama-swap/llama-swap ]]; then
    local tag arch
    tag=$(curl -sfL https://api.github.com/repos/mostlygeek/llama-swap/releases/latest \
          | grep -oP '"tag_name":\s*"\K[^"]+' || echo "")
    if [[ -z $tag ]]; then
      die "問不到 llama-swap 的最新版本。" "檢查網路，或先手動放一份到 $ROOT/llama-swap/。"
    fi
    arch=$([[ $(uname -m) == aarch64 ]] && echo arm64 || echo amd64)
    run bash -c "curl -sfL 'https://github.com/mostlygeek/llama-swap/releases/download/$tag/llama-swap_${tag#v}_linux_${arch}.tar.gz' \
        | tar -xz -C '$ROOT/llama-swap' llama-swap"
    ok "llama-swap $tag"
  else
    skip "llama-swap 已存在"
  fi

  # A skeleton rather than a template full of models: an entry naming a GGUF
  # that is not on disk is a server that fails to start, and the catalogue page
  # writes real entries once there are weights to name.
  if [[ ! -e $ROOT/llama-swap/config.yaml ]]; then
    run bash -c "cat > '$ROOT/llama-swap/config.yaml' <<'YAML'
# 由 TenkStack 安裝腳本產生。之後主控台會改寫這個檔案。
macros:
  models-dir: \"$ROOT/models\"

# 還沒有模型。到主控台的「模型目錄」下載權重，或用「新增模型」指向已有的檔案。
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
    ok "llama-swap 設定骨架"
  else
    skip "llama-swap 設定已存在，沒有覆蓋"
  fi
}

# The gateway. Everything else binds loopback; this is the one process that
# listens where other machines can reach it, and the console's channel
# switches edit the files under caddy/channels/ and ask this unit to reload.
# What is written here has to match what `server/app/channels.py` expects:
# the unit is called `caddy`, the admin API is a unix socket so `caddy reload`
# works, channel files live in channels/ (on) or channels/disabled/ (off), and
# each channel imports a bind file the console generates.
write_caddy() {
  local dir="$ROOT/caddy"
  run mkdir -p "$dir/channels/binds" "$dir/channels/disabled"

  if [[ -e $dir/Caddyfile ]]; then
    skip "Caddyfile 已存在，沒有覆蓋（$dir/Caddyfile）"
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
    "")       scheme=http; site_note=" 純 HTTP：TLS 由外層代理負責，或這個環境不需要。" ;;
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
# 由 TenkStack 安裝腳本產生。主控台自己的站台在這裡；可開關的入口在 channels/。
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
      || die "產生的 Caddyfile 沒有通過 caddy validate。" "看 $HOME/.local/bin/caddy validate --config $dir/Caddyfile"
  fi
  ok "Caddy 設定（${TLS_MODE:-http}）"
}

# What the TLS mode needs from root, done here so the plan could announce it.
trust_caddy() {
  case $TLS_MODE in
    internal)
      # Installs Caddy's local root into the system trust store, so browsers
      # and curl on this machine accept the certificate. Other devices import
      # the same file by hand; finish() prints where it is.
      as_root "$HOME/.local/bin/caddy" trust
      ok "caddy trust（這台機器信任自簽 CA）" ;;
    domain)
      # A user service cannot open :80/:443. Granting the binary the one
      # capability it needs is narrower than running it as root.
      as_root setcap cap_net_bind_service=+ep "$HOME/.local/bin/caddy"
      ok "setcap（讓 caddy 以一般帳號綁 80/443）" ;;
  esac
}

write_units() {
  local dir="$HOME/.config/systemd/user"
  run mkdir -p "$dir"

  # CONSOLE_AI_DIR is written out rather than left to the default in paths.py.
  # An installation that is running must not move because a default changed in
  # a later version.
  run bash -c "cat > '$dir/tenkstack-console.service' <<UNIT
[Unit]
Description=TenkStack console backend (FastAPI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CODE/server
Environment=CONSOLE_AI_DIR=$ROOT
# --timeout-graceful-shutdown: uvicorn otherwise waits for every in-flight
# request, and the console's event streams never end on their own.
ExecStart=$CODE/server/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $CONSOLE_PORT --timeout-graceful-shutdown 5
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT"

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
  ok "寫好 systemd unit"
}

# Enabled before anything is started, and before any reboot. That ordering is
# what makes "reboot last" work: the machine comes back with the stack already
# running, and this script never has to be resumed.
enable_units() {
  run systemctl --user daemon-reload
  run systemctl --user enable --quiet tenkstack-console.service tenkstack-llama-swap.service caddy.service
  ok "已註冊為開機啟動"
  if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]]; then
    as_root loginctl enable-linger "$USER"
    ok "enable-linger（登出之後服務仍然繼續跑）"
  else
    skip "linger 已開啟"
  fi
}

start_and_verify() {
  if $NEEDS_REBOOT; then skip "需要重開機，服務等開機後自己啟動"; return; fi
  run systemctl --user start tenkstack-llama-swap.service tenkstack-console.service caddy.service

  if $DRY_RUN; then return; fi
  local n=0
  until curl -sfo /dev/null "http://127.0.0.1:$CONSOLE_PORT/api/health"; do
    n=$((n + 1))
    if [[ $n -gt 30 ]]; then
      die "主控台起不來。" "看 journalctl --user -u tenkstack-console -n 50 找原因。"
    fi
    sleep 1
  done
  ok "主控台回應了"

  # Through the gateway too, so "installed" means reachable and not merely
  # running. In domain mode the name resolves elsewhere and the certificate
  # is not issued until the first real request from the internet, so that one
  # is checked only as far as the unit being up.
  if [[ $TLS_MODE == domain ]]; then
    systemctl --user is-active --quiet caddy || die "Caddy 起不來。" "看 journalctl --user -u caddy -n 50。"
    ok "Caddy 在跑（憑證會在第一次從外面連到 $DOMAIN 時申請）"
    return
  fi
  local scheme=https; [[ -z $TLS_MODE ]] && scheme=http
  n=0
  until curl -skfo /dev/null "$scheme://127.0.0.1:$CONSOLE_TLS_PORT/api/health"; do
    n=$((n + 1))
    if [[ $n -gt 15 ]]; then
      die "Caddy 沒有把主控台放出來。" "看 journalctl --user -u caddy -n 50，或 $HOME/.local/bin/caddy validate --config $ROOT/caddy/Caddyfile"
    fi
    sleep 1
  done
  ok "經 Caddy 也回應了"
}

finish() {
  local host url; host=$(hostname -f 2>/dev/null || hostname)
  case $TLS_MODE in
    domain) url="https://$DOMAIN" ;;
    "")     url="http://$host:$CONSOLE_TLS_PORT" ;;
    *)      url="https://$host:$CONSOLE_TLS_PORT" ;;
  esac
  step "完成"
  if $NEEDS_REBOOT; then
    say "  還差一次重新開機：$REBOOT_WHY"
    say "  開機後服務會自己啟動，不需要再跑這個腳本。"
    say ""
    say "  ${C_B}sudo reboot${C_OFF}"
    say ""
    say "  回來之後：$url"
  else
    say "  $url"
    say "  ${C_DIM}（第一次進去是註冊畫面。第一個帳號建立之後才會開始要求登入。）${C_OFF}"
  fi
  case $TLS_MODE in
    internal)
      say "  ${C_DIM}（自簽 CA。這台已經信任了；別台裝置要匯入這個檔案："
      say "    $HOME/.local/share/caddy/pki/authorities/local/root.crt）${C_OFF}" ;;
    "")
      say "  ${C_DIM}（純 HTTP：密碼和 API key 在網路上是明文。若這台會被區網以外連到，"
      say "    重跑並加 --tls internal 或 --domain，或在前面放一個負責 TLS 的代理。）${C_OFF}" ;;
  esac
  say "  ${C_DIM}純 /v1 的 HTTP 入口在 :$API_PORT，給不信任私有 CA 的 CLI 工具用；連線頁可以關掉它。${C_OFF}"
  say ""
  say "  接下來在主控台裡："
  say "    ・「執行環境」開啟每張卡要不要跑模型"
  say "    ・「模型目錄」下載權重"
  if [[ $WANT_COMFYUI == y ]]; then say "    ・「ComfyUI」建立實例"; fi
}

# --------------------------------------------------------------------------
main() {
  step "① 盤點"
  survey_os
  survey_cards
  survey_drivers
  survey_deps

  step "② 選項"
  ask    ROOT "安裝目錄 " "${ROOT:-$ROOT_DEFAULT}"
  ask    CODE "程式碼放哪 " "${CODE:-$CODE_DEFAULT}"
  ask_yn WANT_SEARXNG "裝 SearXNG（讓模型能上網搜尋）？" n
  ask_yn WANT_COMFYUI "裝 ComfyUI（畫圖，映像很大）？" n

  show_plan

  step "③ 安裝相依"
  install_deps
  install_groups
  trust_caddy

  step "④ 取得程式碼"
  fetch_code
  build_console

  step "⑤ 建立目錄與設定"
  make_skeleton
  write_caddy

  step "⑥ 註冊服務"
  write_units
  enable_units

  step "⑦ 啟動"
  start_and_verify

  finish
}

main "$@"
