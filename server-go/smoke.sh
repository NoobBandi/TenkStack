#!/bin/bash
# Check a built console binary before it is published: it reports the
# version expected, carries the setup protocol install.sh looks for before
# running its setup screens, and starts and serves the embedded frontend.
#
#   server-go/smoke.sh server-go/tenkstack [0.7.0]
#
# It starts the binary in an empty home, so nothing on the machine it runs
# on is read or changed.
set -euo pipefail

bin=$(readlink -f "$1")
want=${2:-}
fail() { echo "smoke: $*" >&2; exit 1; }

got=$("$bin" --version)
if [[ -n $want && $got != "$want" ]]; then fail "the binary says $got, expected $want"; fi
grep -qa "TENKSTACK_SETUP_PROTOCOL=1" "$bin" || fail "no setup protocol marker; install.sh would fall back to plain questions"

dir=$(mktemp -d)
pid=""
cleanup() { if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; fi; rm -rf "$dir"; }
trap cleanup EXIT
port=${SMOKE_PORT:-18071}
url="http://127.0.0.1:$port"
env -i HOME="$dir" PATH=/usr/bin:/bin CONSOLE_AI_DIR="$dir/ai" "$bin" -listen "127.0.0.1:$port" >"$dir/log" 2>&1 &
pid=$!

page=""
for _ in $(seq 50); do
  # Any answer will do here, a 404 included; what it is gets checked below.
  if page=$(curl -sS "$url/" 2>/dev/null); then break; fi
  kill -0 "$pid" 2>/dev/null || { cat "$dir/log" >&2; fail "the binary exited on start"; }
  sleep 0.2
done
[[ -n $page ]] || { cat "$dir/log" >&2; fail "nothing answered on $url"; }
# Something else on the port would answer too; the binary under test exits
# when it cannot bind, and logs where it listens when it can.
kill -0 "$pid" 2>/dev/null || { cat "$dir/log" >&2; fail "the binary exited; is $port taken?"; }
grep -q "listening on 127.0.0.1:$port" "$dir/log" || { cat "$dir/log" >&2; fail "the binary is not the one listening on $port"; }

# build.sh embeds web/dist; a binary built without it serves only the
# placeholder, which has no script.
asset=$(grep -o '/assets/index-[^"]*\.js' <<<"$page" | head -1 || true)
[[ -n $asset ]] || fail "the page has no frontend script; web/dist was not embedded"
curl -fsS -o /dev/null "$url$asset" || fail "the frontend script $asset is not served"

echo "smoke: $got starts, serves its frontend and speaks the setup protocol"
