#!/usr/bin/env bash
# DSH remote-control worker self-setup (macOS / Linux).
#
#   bash scripts/worker-setup.sh                 # 默认：clone 仓库到 ~/dsh-remote-control，配置并启动 worker
#   bash scripts/worker-setup.sh --dry-run       # 只打印计划，不做任何修改
#   bash scripts/worker-setup.sh --status        # 查看当前 worker 状态
#   bash scripts/worker-setup.sh --stop          # 停止当前 worker
#
# 也可以在 B 上一条命令执行（公开仓库）：
#   curl -fsSL https://raw.githubusercontent.com/coderdeng/dsh-remote-control/main/scripts/worker-setup.sh | bash
#
# 脚本做的事：找 dsh 命令 → 准备 profile 和插件（clone 或 bundle 两种方式）→ 生成 token（或复用）
# → 选空闲端口 → 写 profile patch → 创建 workspace → 后台启动 worker → 等待 /v1/hello →
# 打印「配对码」（含 endpoint + token），把配对码发给 A 端 agent 即可完成配对。
set -euo pipefail

SCRIPT_LABEL="${BASH_SOURCE[0]:-worker-setup.sh}"
PROFILE="${PROFILE:-dsh-worker}"
PORT="${PORT:-7801}"
REPO_URL="${REPO_URL:-https://github.com/coderdeng/dsh-remote-control.git}"
CLONE_DIR="${CLONE_DIR:-$HOME/dsh-remote-control}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MODE="${MODE:-clone}"                 # clone | bundle
DSH_CMD="${DSH_CMD:-}"
TOKEN="${TOKEN:-}"
PROVIDER="${PROVIDER:-}"
MODEL="${MODEL:-}"
WORKSPACE="${WORKSPACE:-$HOME/dsh-work}"
PERMISSION_PRESET="${PERMISSION_PRESET:-danger-full-access}"
START=1
DRY_RUN=0
ACTION=setup

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)            PROFILE="$2"; shift 2 ;;
    --port)               PORT="$2"; shift 2 ;;
    --repo)               REPO_URL="$2"; shift 2 ;;
    --clone-dir)          CLONE_DIR="$2"; shift 2 ;;
    --dsh-home)           DSH_HOME="$2"; shift 2 ;;
    --mode)               MODE="$2"; shift 2 ;;
    --dsh)                DSH_CMD="$2"; shift 2 ;;
    --token)              TOKEN="$2"; shift 2 ;;
    --provider)           PROVIDER="$2"; shift 2 ;;
    --model)              MODEL="$2"; shift 2 ;;
    --workspace)          WORKSPACE="$2"; shift 2 ;;
    --permission-preset)  PERMISSION_PRESET="$2"; shift 2 ;;
    --no-start)           START=0; shift ;;
    --dry-run)            DRY_RUN=1; shift ;;
    --status)             ACTION=status; shift ;;
    --stop)               ACTION=stop; shift ;;
    -h|--help)            sed -n '2,20p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
STATE_DIR="$DSH_HOME/dsh-remote-control"
INFO="$STATE_DIR/worker.json"
LOG="$STATE_DIR/worker.log"
PAIR_FILE="$STATE_DIR/pairing.txt"

# ---------------------------------------------------------------- helpers ---
find_dsh() {
  if [ -n "$DSH_CMD" ]; then
    [ -x "$DSH_CMD" ] || [ -f "$DSH_CMD" ] || die "--dsh path is not executable: $DSH_CMD"
    printf '%s' "$DSH_CMD"; return
  fi
  if command -v dsh >/dev/null 2>&1; then command -v dsh; return; fi
  for candidate in \
    /Applications/*Harness*.app/Contents/Resources/runtime/cli/bin/dsh \
    "$HOME"/Applications/*Harness*.app/Contents/Resources/runtime/cli/bin/dsh \
    /opt/*harness*/resources/runtime/cli/bin/dsh \
    /usr/local/bin/dsh
  do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return; fi
  done
  die "could not find the dsh command. Put it on PATH, or pass --dsh <path>. Hint: find /Applications -maxdepth 6 -name dsh -path '*runtime/cli/bin*'"
}

detect_lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [ -n "${ip:-}" ]; then printf '%s' "$ip"; return; fi
    done
  fi
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "${ip:-}" ]; then printf '%s' "$ip"; return; fi
  fi
  printf '127.0.0.1'
}

port_in_use() {
  p="$1"
  (echo > "/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1 && return 0
  return 1
}

pick_port() {
  p="$1"
  i=0
  while [ "$i" -lt 30 ]; do
    port_in_use "$p" || { printf '%s' "$p"; return; }
    p=$((p + 1)); i=$((i + 1))
  done
  die "no free port found from $1 to $(( p - 1 ))"
}

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

base64url() {
  base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
}

pairing_code() {
  # $1=name $2=endpoint $3=token
  json=$(printf '{"v":1,"n":"%s","e":"%s","t":"%s"}' "$1" "$2" "$3")
  printf 'dshrc1.%s' "$(printf '%s' "$json" | base64url)"
}

json_field() {
  # $1=file $2=field
  sed -n 's/.*"'"$2"'": *"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n1
}

pid_from_info() {
  [ -f "$INFO" ] || return 1
  pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$INFO" | head -n1)"
  [ -n "${pid:-}" ] || return 1
  printf '%s' "$pid"
}

# ------------------------------------------------------------ status/stop ---
if [ "$ACTION" = status ]; then
  if [ ! -f "$INFO" ]; then say "no worker info at $INFO (worker not set up yet)"; exit 0; fi
  say "worker info: $INFO"
  cat "$INFO"
  if [ -f "$PAIR_FILE" ]; then say ""; say "pairing code:"; cat "$PAIR_FILE"; fi
  pid="$(pid_from_info || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then say ""; say "process: running (pid $pid)"; else say ""; say "process: not running"; fi
  exit 0
fi
if [ "$ACTION" = stop ]; then
  pid="$(pid_from_info || true)"
  if [ -z "${pid:-}" ] || ! kill -0 "$pid" 2>/dev/null; then say "worker is not running"; exit 0; fi
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would stop pid $pid"; exit 0; fi
  kill "$pid" 2>/dev/null || true
  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  say "stopped worker (pid $pid)"
  exit 0
fi

# ------------------------------------------------------------------ setup ---
command -v git >/dev/null 2>&1 || [ "$MODE" = bundle ] || die "git is required for --mode clone (install git, or run with --mode bundle)"
command -v curl >/dev/null 2>&1 || die "curl is required (ship-time check / readiness probe)"

DSH="$(find_dsh)"
DSH_MAJOR="$("$DSH" --version 2>/dev/null || true)"
[ -n "$DSH_MAJOR" ] || die "dsh command did not report a version: $DSH"

# profile exists?
PROFILE_MISSING=0
[ -f "$PROFILE_DIR/package.json" ] || PROFILE_MISSING=1

# existing token / provider detection
if [ -z "$TOKEN" ] && [ -f "$PATCH" ]; then
  TOKEN="$(sed -n 's/^ *token: *//p' "$PATCH" | head -n1 | tr -d "'\"")"
fi
if [ -z "$TOKEN" ]; then TOKEN="$(gen_token)"; fi
[ "${#TOKEN}" -ge 16 ] || die "token must be at least 16 characters"

if [ -z "$PROVIDER" ]; then
  if grep -q 'deepseek-account-platform/default' "$DSH_HOME/.credentials.yaml" 2>/dev/null; then
    PROVIDER=deepseek-account
  else
    PROVIDER=deepseek-official
  fi
fi
if [ -z "$MODEL" ]; then MODEL=deepseek-flash; fi
if [ "$PROVIDER" = deepseek-official ]; then
  say "note: model route deepseek-official needs DEEPSEEK_API_KEY in B's DSH credentials/env;"
  say "      if B uses the DSH account login instead, re-run with --provider deepseek-account."
fi

# plugin source: clone repo (default) or install as bundle
USE_BUNDLE=0
if [ "$MODE" = bundle ]; then USE_BUNDLE=1; fi

FILE_URL=""
patch_needs_sdk=0
if [ "$USE_BUNDLE" = 0 ]; then
  if [ ! -f "$CLONE_DIR/lib/worker.js" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "[dry-run] would clone $REPO_URL -> $CLONE_DIR"
    else
      git clone "$REPO_URL" "$CLONE_DIR"
    fi
  else
    if [ "$DRY_RUN" = 0 ]; then
      git -C "$CLONE_DIR" pull --ff-only >/dev/null 2>&1 || warn "git pull failed in $CLONE_DIR (using the current checkout)"
    fi
  fi
  FILE_URL="file://$CLONE_DIR/lib/worker.js"
fi

if [ "$PROFILE_MISSING" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would initialize profile $PROFILE"
  else
    if [ "$USE_BUNDLE" = 1 ]; then
      "$DSH" plugin --profile "$PROFILE" add "git+$REPO_URL"
    else
      "$DSH" --profile "$PROFILE" --from-default-profile sdk --dump-config >/dev/null
    fi
  fi
fi
# sdk-template profiles need their stdio app rows disabled; base profiles don't have them
if [ "$USE_BUNDLE" = 0 ]; then
  if [ "$PROFILE_MISSING" = 1 ] || grep -q 'dsh-sdk-app' "$PROFILE_DIR/package.json" 2>/dev/null; then
    patch_needs_sdk=1
  fi
fi
if [ "$USE_BUNDLE" = 1 ] && [ -f "$PROFILE_DIR/package.json" ] && ! grep -q 'dsh-remote-control' "$PROFILE_DIR/package.json" 2>/dev/null; then
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would install bundle git+$REPO_URL"
  else
    "$DSH" plugin --profile "$PROFILE" add "git+$REPO_URL"
  fi
fi

# Re-running the script must not stack a second worker on another port: stop the
# previously started one first (its token is reused above, so pairing stays valid).
PREV_PID="$(pid_from_info || true)"
if [ -n "${PREV_PID:-}" ] && kill -0 "$PREV_PID" 2>/dev/null; then
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would stop previous worker (pid $PREV_PID)"
  else
    say "stopping previous worker (pid $PREV_PID)"
    kill "$PREV_PID" 2>/dev/null || true
    i=0
    while kill -0 "$PREV_PID" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
    kill -0 "$PREV_PID" 2>/dev/null && kill -9 "$PREV_PID" 2>/dev/null || true
  fi
fi

PORT="$(pick_port "$PORT")"
LAN_IP="$(detect_lan_ip)"
ENDPOINT="http://$LAN_IP:$PORT"
HOSTNAME_S="$(hostname 2>/dev/null || echo remote)"
CODE="$(pairing_code "$HOSTNAME_S" "$ENDPOINT" "$TOKEN")"

if [ "$USE_BUNDLE" = 1 ]; then
  WORKER_PATCH="$(cat <<EOF
# generated by worker-setup.sh (bundle mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ)
- id: remote-control
  disabled: false
  config:
    role: worker
    token: '$TOKEN'
    listenHost: '0.0.0.0'
    port: $PORT
    workspaceRoot: '$WORKSPACE'
    permissionPreset: $PERMISSION_PRESET
    provider: $PROVIDER
    model: $MODEL
EOF
)"
else
  SDK_ROWS=""
  if [ "$patch_needs_sdk" = 1 ]; then
    SDK_ROWS="- id: sdk-app-startup
  disabled: true
- id: sdk-jsonrpc-server
  disabled: true
- id: hmr
  disabled: true
"
  else
    SDK_ROWS="- id: remote-control
  disabled: true
"
  fi
  WORKER_PATCH="$(cat <<EOF
# generated by worker-setup.sh (clone mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ)
$SDK_ROWS
- insert:
    - id: remote-control-worker
      name: '$FILE_URL'
      config:
        role: worker
        token: '$TOKEN'
        listenHost: '0.0.0.0'
        port: $PORT
        workspaceRoot: '$WORKSPACE'
        permissionPreset: $PERMISSION_PRESET
        provider: $PROVIDER
        model: $MODEL
EOF
)"
fi

say "==> dsh        : $DSH"
say "==> dsh version: $DSH_MAJOR"
say "==> DSH_HOME   : $DSH_HOME"
say "==> profile    : $PROFILE ($([ "$PROFILE_MISSING" = 1 ] && echo 'will be created' || echo 'exists'))"
say "==> mode       : $([ "$USE_BUNDLE" = 1 ] && echo bundle || echo clone)"
say "==> endpoint   : $ENDPOINT"
say "==> model      : $PROVIDER/$MODEL"
say "==> workspace  : $WORKSPACE"
say ""

if [ "$DRY_RUN" = 1 ]; then
  say "----- [dry-run] profile patch that would be written to $PATCH -----"
  printf '%s\n' "$WORKER_PATCH"
  say "----- [dry-run] pairing code that would be printed -----"
  say "$CODE"
  say "----- [dry-run] no files were changed, worker was not started -----"
  exit 0
fi

mkdir -p "$PROFILE_DIR" "$STATE_DIR" "$WORKSPACE"
if [ -f "$PATCH" ] && [ -s "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak-$(date +%s)"
fi
printf '%s\n' "$WORKER_PATCH" > "$PATCH"
chmod 600 "$PATCH" 2>/dev/null || true

if [ "$START" = 1 ]; then
  : > "$LOG"
  nohup "$DSH" --profile "$PROFILE" >"$LOG" 2>&1 &
  NEW_PID=$!
  say "worker starting (pid $NEW_PID), log: $LOG"
  READY=0
  i=0
  while [ "$i" -lt 45 ]; do
    if curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/hello" >/dev/null 2>&1; then READY=1; break; fi
    sleep 1; i=$((i + 1))
  done
  if [ "$READY" != 1 ]; then
    warn "worker did not answer /v1/hello within 45s. Log tail:"
    tail -n 30 "$LOG" >&2 || true
    die "setup failed; fix the log above and re-run this script (it is idempotent)"
  fi
  # Prefer the worker's own facts (actual port/pairing code) when available.
  if [ -f "$INFO" ]; then
    REAL_CODE="$(json_field "$INFO" pairingCode)"
    REAL_PORT="$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$INFO" | head -n1)"
    if [ -n "${REAL_CODE:-}" ]; then CODE="$REAL_CODE"; fi
    if [ -n "${REAL_PORT:-}" ]; then PORT="$REAL_PORT"; ENDPOINT="http://$LAN_IP:$PORT"; fi
  fi
fi

mkdir -p "$STATE_DIR"
{
  say "hostname=$HOSTNAME_S"
  say "endpoint=$ENDPOINT"
  say "token=$TOKEN"
  say "pairing_code=$CODE"
  say "log=$LOG"
} > "$PAIR_FILE"
chmod 600 "$PAIR_FILE" 2>/dev/null || true

say ""
say "════════════════════════════════════════════════════════════════"
say " ✓ 远端 worker 已就绪"
say "   主机名   : $HOSTNAME_S"
say "   地址     : $ENDPOINT"
say "   配对码   : $CODE"
say ""
say " 把上面这行配对码发给 A 端 DSH 的 agent 即可（它包含 token，等同于密码，不要外传）："
say "   在 A 的聊天里说：把这条配对码配对成远端电脑：$CODE"
say ""
say " 日志     : $LOG"
say " 配对信息 : $PAIR_FILE"
say " 状态     : bash $SCRIPT_LABEL --status"
say " 停止     : bash $SCRIPT_LABEL --stop"
say "════════════════════════════════════════════════════════════════"

