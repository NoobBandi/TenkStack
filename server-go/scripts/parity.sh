#!/bin/bash
# Parity check for the Go port: the Python backend and the Go binary run side
# by side on a throwaway state directory, and every ported route is called on
# both. Grows with the port; a DIFF line is a bug in one of them.
#
#   server-go/scripts/parity.sh            builds the Go binary first
#   server-go/scripts/parity.sh path/to/bin
set -u
REPO=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
BIN=${1:-}
if [[ -z $BIN ]]; then
  BIN=$S/tenkstack
  (cd "$REPO/server-go" && go build -ldflags "-X main.version=$(sed -n 's/^version = "\(.*\)"/\1/p' ../server/pyproject.toml)" -o "$BIN" ./cmd/tenkstack) || exit 1
fi
mkdir -p "$S/state"
export CONSOLE_STATE_DIR=$S/state
( cd "$REPO/server" && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8072 --log-level warning ) > "$S/py.log" 2>&1 &
PY=$!
( cd "$REPO/server-go" && exec "$BIN" -listen 127.0.0.1:8071 ) > "$S/go.log" 2>&1 &
GO=$!
trap 'kill $PY $GO 2>/dev/null; wait $PY $GO 2>/dev/null; rm -rf "$S"' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8072/api/health >/dev/null && curl -sf http://127.0.0.1:8071/api/health >/dev/null && break; sleep 0.5; done

# one request per server; the status goes to a file so the body stays a pipe
call() { local port=$1 m=$2 p=$3; shift 3
  curl -s -o "$S/body" -w '%{http_code}' -X "$m" "http://127.0.0.1:$port$p" "$@"; echo
  python3 -c 'import sys,json; d=open(sys.argv[1]).read()
try: print(json.dumps(json.loads(d),sort_keys=True,ensure_ascii=False))
except Exception: print(d[:200])' "$S/body"; }
FAILS=0
same() { local name=$1 a=$2 b=$3
  if [[ "$a" == "$b" ]]; then echo "SAME  $name: $(echo "$a" | tr '\n' ' ' | cut -c1-150)"
  else FAILS=$((FAILS+1)); echo "DIFF  $name"; echo "  py: $(echo "$a" | tr '\n' ' ' | cut -c1-200)"; echo "  go: $(echo "$b" | tr '\n' ' ' | cut -c1-200)"; fi; }
cmp() { local name=$1; shift; same "$name" "$(call 8072 "$@")" "$(call 8071 "$@")"; }
# Live readings differ between two processes, so only the shape is compared:
# every number becomes 0, every list of samples its first element.
shape() { python3 -c 'import sys,json
def norm(v):
    if isinstance(v,bool): return v
    if isinstance(v,(int,float)): return 0
    if isinstance(v,list): return [norm(v[0])] if v and isinstance(v[0],dict) else [norm(x) for x in v]
    if isinstance(v,dict): return {k:norm(x) for k,x in v.items()}
    return v
lines=sys.stdin.read().split("\n",1)
try: print(lines[0]); print(json.dumps(norm(json.loads(lines[1])),sort_keys=True,ensure_ascii=False))
except Exception: print("\n".join(lines))'; }
cmpshape() { local name=$1; shift; same "$name" "$(call 8072 "$@" | shape)" "$(call 8071 "$@" | shape)"; }
J='-H' ; JT='Content-Type: application/json'
echo "## before any account (enforcement off)"
cmp health GET /api/health
cmp version GET /api/version
cmp me-open GET /api/auth/me
cmp users-empty GET /api/users
cmp keys-empty GET /api/api-keys
# 422 bodies differ by design: FastAPI sends pydantic's array, Go a string the UI shows.
call 8071 POST /api/users -H "$JT" -d '{"username":"a","password":"abc"}' | tr '\n' ' '; echo
echo "## create the owner through PYTHON, then read on both"
curl -s -X POST http://127.0.0.1:8072/api/users -H "$JT" -d '{"username":"owner","password":"secret123","role":"admin"}' | head -c 200; echo
cmp users-list GET /api/users
cmp me-enforced-noauth GET /api/auth/me
cmp users-noauth GET /api/users
cmp login-bad POST /api/auth/login $J "$JT" -d '{"username":"owner","password":"nope"}'
echo "## login on PYTHON, use the cookie on GO (and vice versa)"
curl -s -c $S/py.jar -X POST http://127.0.0.1:8072/api/auth/login -H "$JT" -d '{"username":"owner","password":"secret123"}' -D $S/py.hdr >/dev/null
curl -s -c $S/go.jar -X POST http://127.0.0.1:8071/api/auth/login -H "$JT" -d '{"username":"owner","password":"secret123"}' -D $S/go.hdr >/dev/null
echo "py Set-Cookie: $(grep -i set-cookie $S/py.hdr | tr -d '\r' | sed 's/=[^;]*;/=<tok>;/')"
echo "go Set-Cookie: $(grep -i set-cookie $S/go.hdr | tr -d '\r' | sed 's/=[^;]*;/=<tok>;/')"
echo "py cookie -> go /api/auth/me: $(curl -s -b $S/py.jar http://127.0.0.1:8071/api/auth/me)"
echo "go cookie -> py /api/auth/me: $(curl -s -b $S/go.jar http://127.0.0.1:8072/api/auth/me)"
cmp me-session GET /api/auth/me -b $S/py.jar
echo "## api key minted on GO, verified on PYTHON"
KEY=$(curl -s -b $S/go.jar -X POST http://127.0.0.1:8071/api/api-keys -H "$JT" -d '{"user_id":1,"name":"t"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["secret"])')
echo "key prefix: ${KEY:0:17}…  len=${#KEY}"
cmp keys-list GET /api/api-keys -b $S/py.jar
cmp me-apikey GET /api/auth/me -H "Authorization: Bearer $KEY"
cmp me-xapikey GET /api/auth/me -H "X-Api-Key: $KEY"
cmp key-missing-uid POST /api/api-keys -b $S/py.jar $J "$JT" -d '{"name":"x"}'
cmp key-del-404 DELETE /api/api-keys/999 -b $S/py.jar
cmp user-del-404 DELETE /api/users/999 -b $S/py.jar
cmp pw-short POST /api/users/1/password -b $S/py.jar $J "$JT" -d '{"password":"ab"}'
cmp pw-ok POST /api/users/1/password -b $S/py.jar $J "$JT" -d '{"password":"newpass1"}'
cmp login-newpw POST /api/auth/login $J "$JT" -d '{"username":"owner","password":"newpass1"}'
cmp logout POST /api/auth/logout -b $S/py.jar
curl -s -b $S/py.jar -X POST http://127.0.0.1:8072/api/api-keys -H "$JT" -d '{"user_id":1,"name":"t2"}' >/dev/null
same key-del-ok "$(call 8072 DELETE /api/api-keys/1 -b $S/py.jar)" "$(call 8071 DELETE /api/api-keys/2 -b $S/py.jar)"
cmp dup-user POST /api/users -b $S/py.jar $J "$JT" -d '{"username":"owner","password":"secret123"}'
echo "## gpu (shapes; both pollers need a tick first)"
sleep 3
cmpshape gpu GET /api/gpu -b $S/py.jar
cmpshape gpu-history GET '/api/gpu/history?seconds=900&points=600' -b $S/py.jar
cmpshape gpu-devices GET /api/gpu/devices -b $S/py.jar
same gpu-bad-query "$(call 8072 GET '/api/gpu/history?seconds=abc' -b $S/py.jar | head -1)" "$(call 8071 GET '/api/gpu/history?seconds=abc' -b $S/py.jar | head -1)"   # status only, see the 422 note above
echo "## static"
for p in / /index.html /favicon.svg /assets/ /nope.js /api/nope; do
  printf '%-14s py=%s go=%s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} cc=%header{cache-control}' http://127.0.0.1:8072$p)" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} cc=%header{cache-control}' http://127.0.0.1:8071$p)"
done
A=$(ls $REPO/web/dist/assets | head -1)
printf '%-14s py=%s go=%s\n' "/assets/$A" "$(curl -s -o /dev/null -w '%{http_code} cc=%header{cache-control}' http://127.0.0.1:8072/assets/$A)" "$(curl -s -o /dev/null -w '%{http_code} cc=%header{cache-control}' http://127.0.0.1:8071/assets/$A)"
printf '%-14s py=%s go=%s\n' "/fonts/cjk.ttf" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' http://127.0.0.1:8072/fonts/cjk.ttf)" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' http://127.0.0.1:8071/fonts/cjk.ttf)"
printf '%-14s py=%s go=%s\n' "/../etc/passwd" "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8072/../etc/passwd')" "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8071/../etc/passwd')"

echo; if [[ $FAILS -eq 0 ]]; then echo "parity: all SAME"; else echo "parity: $FAILS DIFF"; fi
exit $FAILS
