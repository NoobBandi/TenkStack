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
  python3 -c 'import sys,json,os
def norm(v):  # 1.0 and 1 are the same number to every reader of this JSON
    if isinstance(v,float) and v.is_integer(): return int(v)
    if isinstance(v,list): return [norm(x) for x in v]
    if isinstance(v,dict): return {k:norm(x) for k,x in v.items()}
    return v
def strip(v):  # STRIP=key drops a top-level or per-row key that is a clock
    k=os.environ.get("STRIP")
    if not k: return v
    if isinstance(v,dict): v.pop(k,None)
    if isinstance(v,list):
        for x in v:
            if isinstance(x,dict): x.pop(k,None)
    return v
d=open(sys.argv[1]).read()
try: print(json.dumps(strip(norm(json.loads(d))),sort_keys=True,ensure_ascii=False))
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
# Strings differ too (log text, timestamps as text): compare types only.
keys() { python3 -c 'import sys,json
def norm(v):
    if isinstance(v,bool) or v is None: return v
    if isinstance(v,(int,float)): return 0
    if isinstance(v,str): return "s"
    if isinstance(v,list): return [norm(v[0])] if v else []
    if isinstance(v,dict): return {k:norm(x) for k,x in v.items()}
    return v
lines=sys.stdin.read().split("\n",1)
try: print(lines[0]); print(json.dumps(norm(json.loads(lines[1])),sort_keys=True))
except Exception: print("\n".join(lines))'; }
cmpkeys() { local name=$1; shift; same "$name" "$(call 8072 "$@" | keys)" "$(call 8071 "$@" | keys)"; }
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
same gpu-bad-query "$(call 8072 GET '/api/gpu/history?seconds=abc' -b $S/py.jar | sed -n 1p)" "$(call 8071 GET '/api/gpu/history?seconds=abc' -b $S/py.jar | sed -n 1p)"   # status only, see the 422 note above
echo "## logs, activity, containers, stream"
cmpkeys logs GET '/api/logs?limit=5' -b $S/py.jar
field() { python3 -c 'import sys,json; l=sys.stdin.read().split("\n",1); print(l[0]); print(json.dumps(json.loads(l[1])[sys.argv[1]],sort_keys=True,ensure_ascii=False))' "$1"; }
same logs-units "$(call 8072 GET '/api/logs?limit=1' -b $S/py.jar | field units)" "$(call 8071 GET '/api/logs?limit=1' -b $S/py.jar | field units)"
cmp activity GET '/api/activity?limit=5' -b $S/py.jar
cmp last-used GET /api/models/last-used -b $S/py.jar
cmpkeys containers-history GET /api/containers/history -b $S/py.jar
# Event types seen on both streams over the same eight seconds, while llama-swap
# is poked so a journal line is certain to arrive. downloads is not ported yet
# and only appears while one runs.
types() { grep '^data:' | python3 -c 'import sys,json; print(sorted({json.loads(l[5:])["type"] for l in sys.stdin} - {"downloads"}))'; }
curl -m 8 -sN -b $S/py.jar http://127.0.0.1:8072/api/stream > $S/py.stream & C1=$!
curl -m 8 -sN -b $S/py.jar http://127.0.0.1:8071/api/stream > $S/go.stream & C2=$!
for i in 1 2 3 4 5; do sleep 1; curl -s -o /dev/null http://127.0.0.1:8080/running; done
wait $C1 $C2 2>/dev/null
same stream-types "$(types < $S/py.stream)" "$(types < $S/go.stream)"
echo "## models (reads only; writes touch the live config)"
STRIP=created cmp models GET /api/models -b $S/py.jar   # llama-swap stamps `created` with the call time
MID=$(curl -s -b $S/py.jar http://127.0.0.1:8072/api/models | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')
cmp model-spec GET "/api/models/$MID/spec" -b $S/py.jar
cmp model-spec-404 GET /api/models/nope/spec -b $S/py.jar
cmp model-files GET "/api/models/$MID/files" -b $S/py.jar
cmp model-files-404 GET /api/models/nope/files -b $S/py.jar
cmp gguf-files GET /api/models/files -b $S/py.jar
cmp partials GET /api/files/partials -b $S/py.jar
GG=$(curl -s -b $S/py.jar http://127.0.0.1:8072/api/models/files | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["filename"])')
cmp recommended GET "/api/models/recommended?file=$GG" -b $S/py.jar
cmp recommended-escape GET '/api/models/recommended?file=../../etc/passwd' -b $S/py.jar
cmp recommended-404 GET '/api/models/recommended?file=nope.gguf' -b $S/py.jar
cmp model-delete-404 DELETE /api/models/nope -b $S/py.jar
cmp file-delete-409 DELETE "/api/files/$GG" -b $S/py.jar
same file-delete-escape "$(call 8072 DELETE '/api/files/../../etc/passwd' -b $S/py.jar | sed -n 1p)" "$(call 8071 DELETE '/api/files/../../etc/passwd' -b $S/py.jar | sed -n 1p)"
cmp partial-delete-notpart DELETE "/api/files/partials/$GG" -b $S/py.jar
same model-create-422 "$(call 8072 POST /api/models -b $S/py.jar $J "$JT" -d '{"id":"","model_file":"x.gguf"}' | sed -n 1p)" "$(call 8071 POST /api/models -b $S/py.jar $J "$JT" -d '{"id":"","model_file":"x.gguf"}' | sed -n 1p)"
echo "## chats (the state dir is throwaway, so writes are compared too)"
cmp chats-empty GET /api/chats -b $S/py.jar
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
BODY='{"model":"m","params":{"temperature":0.5},"messages":[{"role":"user","content":"hello there\nfriend","images":["'$PNG'"]},{"role":"assistant","content":"hi","usage":{"total_tokens":3},"model":"m","tool_calls":[{"id":"c1"}]}]}'
# Both write the same database, so the ids differ by design: py gets 1, go gets 2.
same chat-save "$(call 8072 POST /api/chats -b $S/py.jar $J "$JT" -d "$BODY" | sed -n 1p)" "$(call 8071 POST /api/chats -b $S/py.jar $J "$JT" -d "$(echo "$BODY" | sed 's/hello there/hello here/')" | sed -n 1p)"
STRIP=created_at cmp chat-get GET /api/chats/1 -b $S/py.jar
STRIP=updated_at cmp chat-get-2 GET /api/chats/2 -b $S/py.jar
DIG=$(curl -s -b $S/py.jar http://127.0.0.1:8072/api/chats/1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["messages"][0]["images"][0].split("/")[-1])')
same blob "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download} cc=%header{cache-control}' http://127.0.0.1:8072/api/blobs/$DIG -b $S/py.jar)" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download} cc=%header{cache-control}' http://127.0.0.1:8071/api/blobs/$DIG -b $S/py.jar)"
cmp blob-404 GET /api/blobs/0000000000000000000000000000000000000000000000000000000000000000 -b $S/py.jar
cmp chat-search GET '/api/chats?q=friend' -b $S/py.jar
cmp chat-patch PATCH /api/chats/1 -b $S/py.jar $J "$JT" -d '{"title":"renamed","pinned":true}'
cmp chat-patch-nothing PATCH /api/chats/1 -b $S/py.jar $J "$JT" -d '{}'
cmp chat-resave-404 POST /api/chats -b $S/py.jar $J "$JT" -d '{"id":999,"messages":[]}'
cmp chat-get-404 GET /api/chats/999 -b $S/py.jar
same chat-delete "$(call 8072 DELETE /api/chats/2 -b $S/py.jar)" "$(call 8071 DELETE /api/chats/1 -b $S/py.jar)"
cmp chat-delete-404 DELETE /api/chats/2 -b $S/py.jar
STRIP=created_at cmp chats-list GET /api/chats -b $S/py.jar
echo "## catalog (Hugging Face; the estimate reads one header over HTTP)"
cmpkeys catalog-search GET '/api/catalog/search?q=qwen3.6&limit=3' -b $S/py.jar
cmp catalog-files GET '/api/catalog/files?repo_id=unsloth/Qwen3.6-35B-A3B-GGUF' -b $S/py.jar
cmp catalog-files-404 GET '/api/catalog/files?repo_id=nope/nope' -b $S/py.jar
cmp catalog-estimate POST /api/catalog/estimate -b $S/py.jar $J "$JT" -d '{"repo_id":"unsloth/Qwen3.6-35B-A3B-GGUF","parts":["Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"],"size_bytes":0}'
cmp catalog-estimate-400 POST /api/catalog/estimate -b $S/py.jar $J "$JT" -d '{"repo_id":"x"}'
cmp catalog-estimate-502 POST /api/catalog/estimate -b $S/py.jar $J "$JT" -d '{"repo_id":"nope/nope","parts":["x.gguf"]}'
cmp catalog-downloads GET /api/catalog/downloads -b $S/py.jar
cmp catalog-download-400 POST /api/catalog/download -b $S/py.jar $J "$JT" -d '{"repo_id":"x"}'
cmp catalog-cancel POST /api/catalog/cancel -b $S/py.jar $J "$JT" -d '{"repo_id":"x","filename":"y"}'
echo "## file browser (owner only; a scratch folder in the home root)"
cmp fs-roots GET /api/fs/roots -b $S/py.jar
cmp fs-apikey GET '/api/fs?root=home' -H "Authorization: Bearer $KEY"
cmp fs-badroot GET '/api/fs?root=nope' -b $S/py.jar
cmp fs-escape GET '/api/fs?root=home&path=..' -b $S/py.jar
cmp fs-denied GET '/api/fs?root=home&path=.ssh' -b $S/py.jar
SCRATCH=tenkstack-parity-$$
# One scratch folder, made by py; go makes a sibling so the shape of a
# successful mkdir is compared too, then the sibling is dropped.
same fs-mkdir "$(call 8072 POST "/api/fs/folder?root=home&name=$SCRATCH" -b $S/py.jar)" "$(call 8071 POST "/api/fs/folder?root=home&name=$SCRATCH-go" -b $S/py.jar | sed "s/$SCRATCH-go/$SCRATCH/")"
rmdir ~/$SCRATCH-go
cmp fs-mkdir-exists POST "/api/fs/folder?root=home&name=$SCRATCH" -b $S/py.jar
printf 'hello\nworld\n' > ~/$SCRATCH/a.txt; cp ~/$SCRATCH/a.txt ~/$SCRATCH/a2.txt; mkdir ~/$SCRATCH/sub; printf 'x' > ~/$SCRATCH/.hidden
cmp fs-list GET "/api/fs?root=home&path=$SCRATCH" -b $S/py.jar
cmp fs-list-hidden GET "/api/fs?root=home&path=$SCRATCH&hidden=true&query=hid" -b $S/py.jar
cmp fs-size GET "/api/fs/size?root=home&path=$SCRATCH" -b $S/py.jar
cmp fs-locate GET "/api/fs/locate?path=~/$SCRATCH/a.txt" -b $S/py.jar
cmp fs-locate-missing GET "/api/fs/locate?path=/nope/nope" -b $S/py.jar
cmp fs-peek-text GET "/api/fs/peek?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar
cmp fs-peek-real-gguf GET "/api/fs/peek?root=home&path=$(dirname ai/models/$GG)&name=$(basename $GG)" -b $S/py.jar
same fs-raw "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %header{content-disposition} %header{accept-ranges} %header{content-security-policy}' "http://127.0.0.1:8072/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)" "$(curl -s -o /dev/null -w '%{http_code} %{content_type} %header{content-disposition} %header{accept-ranges} %header{content-security-policy}' "http://127.0.0.1:8071/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)"
same fs-raw-range "$(curl -s -H 'Range: bytes=2-4' -w ' %{http_code} %header{content-range}' "http://127.0.0.1:8072/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)" "$(curl -s -H 'Range: bytes=2-4' -w ' %{http_code} %header{content-range}' "http://127.0.0.1:8071/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)"
same fs-raw-416 "$(curl -s -o /dev/null -H 'Range: bytes=50-60' -w '%{http_code} %header{content-range}' "http://127.0.0.1:8072/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)" "$(curl -s -o /dev/null -H 'Range: bytes=50-60' -w '%{http_code} %header{content-range}' "http://127.0.0.1:8071/api/fs/raw?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar)"
cmp fs-thumb-415 GET "/api/fs/thumb?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar
cmp fs-text GET "/api/fs/text?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar
MT=$(curl -s -b $S/py.jar "http://127.0.0.1:8072/api/fs/text?root=home&path=$SCRATCH&name=a.txt" | python3 -c 'import sys,json; print(repr(json.load(sys.stdin)["mtime"]))')
cmp fs-text-stale POST "/api/fs/text?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar $J "$JT" -d '{"text":"new","mtime":1}'
same fs-text-write "$(call 8072 POST "/api/fs/text?root=home&path=$SCRATCH&name=a.txt" -b $S/py.jar $J "$JT" -d "{\"text\":\"one\\n\",\"mtime\":$MT}" | sed -n 1p)" "200"
same fs-rename "$(call 8072 POST "/api/fs/rename?root=home&path=$SCRATCH&name=a.txt&to=b.txt" -b $S/py.jar)" "$(call 8071 POST "/api/fs/rename?root=home&path=$SCRATCH&name=a2.txt&to=b2.txt" -b $S/py.jar | sed 's/b2/b/')"
cmp fs-rename-missing POST "/api/fs/rename?root=home&path=$SCRATCH&name=a.txt&to=c.txt" -b $S/py.jar
same fs-move "$(call 8072 POST "/api/fs/move?root=home&path=$SCRATCH&name=b.txt&to_root=home&to_path=$SCRATCH/sub" -b $S/py.jar)" "$(call 8071 POST "/api/fs/move?root=home&path=$SCRATCH&name=b2.txt&to_root=home&to_path=$SCRATCH/sub" -b $S/py.jar | sed 's/b2/b/')"
cmp fs-move-self POST "/api/fs/move?root=home&path=$SCRATCH&name=sub&to_root=home&to_path=$SCRATCH/sub" -b $S/py.jar
cmp fs-offset GET "/api/fs/offset?root=home&path=$SCRATCH&name=up.bin" -b $S/py.jar
same fs-upload-1 "$(printf 'abc' | call 8072 PUT "/api/fs/upload?root=home&path=$SCRATCH&name=up.bin&offset=0&total=6" -b $S/py.jar --data-binary @-)" "$(printf 'abc' | call 8071 PUT "/api/fs/upload?root=home&path=$SCRATCH&name=up2.bin&offset=0&total=6" -b $S/py.jar --data-binary @-)"
cmp fs-upload-bad-offset PUT "/api/fs/upload?root=home&path=$SCRATCH&name=up.bin&offset=1&total=6" -b $S/py.jar --data-binary 'x'
same fs-upload-2 "$(printf 'def' | call 8072 PUT "/api/fs/upload?root=home&path=$SCRATCH&name=up.bin&offset=3&total=6" -b $S/py.jar --data-binary @-)" "$(printf 'def' | call 8071 PUT "/api/fs/upload?root=home&path=$SCRATCH&name=up2.bin&offset=3&total=6" -b $S/py.jar --data-binary @-)"
cmp fs-offset-exists GET "/api/fs/offset?root=home&path=$SCRATCH&name=up.bin" -b $S/py.jar
cmp fs-delete-nonempty DELETE "/api/fs?root=home&name=$SCRATCH" -b $S/py.jar
cmp fs-delete-missing DELETE "/api/fs?root=home&path=$SCRATCH&name=zzz" -b $S/py.jar
same fs-delete "$(call 8072 DELETE "/api/fs?root=home&path=$SCRATCH&name=up.bin" -b $S/py.jar)" "$(call 8071 DELETE "/api/fs?root=home&path=$SCRATCH&name=up2.bin" -b $S/py.jar)"
rm -rf ~/$SCRATCH
echo "## search and the /v1 proxy"
cmp search-available GET /api/search/available -b $S/py.jar
cmp search-apikey GET '/api/search?q=x' -H "Authorization: Bearer $KEY"
cmpkeys search GET '/api/search?q=llama.cpp&limit=3' -b $S/py.jar
cmp search-read GET '/api/search/read?url=http://127.0.0.1:8090/' -b $S/py.jar
cmp search-read-query GET '/api/search/read?url=http://127.0.0.1:8090/&query=search%20engine' -b $S/py.jar
cmp search-read-bad GET '/api/search/read?url=ftp://x' -b $S/py.jar
STRIP=created cmp v1-models GET /v1/models -b $S/py.jar
same v1-unknown "$(call 8072 GET /v1/nope -b $S/py.jar | sed -n 1p)" "$(call 8071 GET /v1/nope -b $S/py.jar | sed -n 1p)"
echo "## comfyui and runtimes (reads and refusals only)"
cmp comfy-instances GET /api/comfyui/instances -b $S/py.jar
cmp comfy-config GET '/api/comfyui/config?port=8188' -b $S/py.jar
cmp comfy-config-apikey GET '/api/comfyui/config?port=8188' -H "Authorization: Bearer $KEY"
cmp comfy-badport POST '/api/comfyui/interrupt?port=9999' -b $S/py.jar
cmp comfy-interrupt POST '/api/comfyui/interrupt?port=8188' -b $S/py.jar
cmp runtimes GET /api/runtimes -b $S/py.jar
cmp runtimes-card-404 POST /api/runtimes/card -b $S/py.jar $J "$JT" -d '{"pci_bdf_address":"0000:ff:00.0","capability":"images","on":true}'
cmp runtimes-card-bad POST /api/runtimes/card -b $S/py.jar $J "$JT" -d '{"pci_bdf_address":"0000:0c:00.0","capability":"nope","on":true}'
cmp runtimes-comfy-bad POST /api/runtimes/comfy -b $S/py.jar $J "$JT" -d '{"name":"x","action":"nope"}'
cmp runtimes-comfy-remove-404 POST /api/runtimes/comfy -b $S/py.jar $J "$JT" -d '{"name":"comfyui-nope","action":"remove"}'
cmp runtimes-action-bad POST /api/runtimes/action -b $S/py.jar $J "$JT" -d '{"vendor":"intel","action":"nope"}'
cmp runtimes-action-enable-missing POST /api/runtimes/action -b $S/py.jar $J "$JT" -d '{"vendor":"nvidia","action":"enable"}'
cmp runtimes-action-install-unknown POST /api/runtimes/action -b $S/py.jar $J "$JT" -d '{"vendor":"nope","action":"install"}'
echo "## runtime: backends, containers, flags, config"
cmp backend-devices GET /api/backends/devices -b $S/py.jar
cmp runtime GET /api/runtime -b $S/py.jar
cmp runtime-control-404 POST /api/runtime/container -b $S/py.jar $J "$JT" -d '{"name":"no-such-container","verb":"restart"}'
cmp runtime-control-verb POST /api/runtime/container -b $S/py.jar $J "$JT" -d '{"name":"comfyui-xpu","verb":"rm"}'
cmp flags-llama GET /api/flags/llama-server -b $S/py.jar
cmp flags-llama-apikey GET /api/flags/llama-server -H "Authorization: Bearer $KEY"
cmp flags-comfy GET '/api/flags/comfyui?container=comfyui-xpu' -b $S/py.jar
cmp flags-comfy-bad GET '/api/flags/comfyui?container=nope' -b $S/py.jar
cmp config GET /api/config -b $S/py.jar
same config-put-bad-yaml "$(call 8072 PUT /api/config -b $S/py.jar $J "$JT" -d '{"raw":"a: [b"}' | sed -n 1p)" "$(call 8071 PUT /api/config -b $S/py.jar $J "$JT" -d '{"raw":"a: [b"}' | sed -n 1p)"
cmp config-put-not-string PUT /api/config -b $S/py.jar $J "$JT" -d '{"raw":5}'
echo "## network: channels, endpoints, network, machine, versions"
cmp channels GET /api/channels -b $S/py.jar
cmp channel-404 POST /api/channels/nope -b $S/py.jar $J "$JT" -d '{"enabled":true}'
cmp channel-scopes-400 POST /api/channels/api-http/scopes -b $S/py.jar $J "$JT" -d '{"scopes":"lan"}'
cmp channel-scopes-404 POST /api/channels/nope/scopes -b $S/py.jar $J "$JT" -d '{"scopes":["lan"]}'
cmp endpoints GET /api/endpoints -b $S/py.jar
cmp network GET /api/network -b $S/py.jar
cmp machine GET /api/machine -b $S/py.jar
cmp versions GET /api/versions -b $S/py.jar
echo "## settings and system"
cmp settings GET /api/settings -b $S/py.jar
cmp settings-set PUT /api/settings -b $S/py.jar $J "$JT" -d '{"agent_max_steps":12,"gpu_history_hours":3}'
cmp settings-back-to-default PUT /api/settings -b $S/py.jar $J "$JT" -d '{"agent_max_steps":8}'
cmp settings-unknown PUT /api/settings -b $S/py.jar $J "$JT" -d '{"nope":1}'
cmp settings-range PUT /api/settings -b $S/py.jar $J "$JT" -d '{"agent_max_steps":99}'
cmp settings-not-int PUT /api/settings -b $S/py.jar $J "$JT" -d '{"agent_max_steps":"abc"}'
cmp settings-api-key-denied PUT /api/settings -H "Authorization: Bearer $KEY" $J "$JT" -d '{"agent_max_steps":9}'
cmpshape system GET /api/system -b $S/py.jar
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
