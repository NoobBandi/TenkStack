#!/bin/bash
# Full diff of one route between the Python backend and the Go binary, for
# when parity.sh says DIFF and the truncated line does not say where.
#   server-go/scripts/diffroute.sh '/api/models'
set -u
REPO=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
BIN=$S/tenkstack
(cd "$REPO/server-go" && go build -ldflags "-X main.version=$(sed -n 's/^version = "\(.*\)"/\1/p' ../server/pyproject.toml)" -o "$BIN" ./cmd/tenkstack) || exit 1
mkdir -p "$S/state"; export CONSOLE_STATE_DIR=$S/state
( cd "$REPO/server" && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8072 --log-level warning ) > "$S/py.log" 2>&1 &
PY=$!
( cd "$REPO/server-go" && exec "$BIN" -listen 127.0.0.1:8071 ) > "$S/go.log" 2>&1 &
GO=$!
trap 'kill $PY $GO 2>/dev/null; wait $PY $GO 2>/dev/null; rm -rf "$S"' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8072/api/health >/dev/null && curl -sf http://127.0.0.1:8071/api/health >/dev/null && break; sleep 0.5; done
sleep 3
pretty() { python3 -c 'import sys,json
def norm(v):
    if isinstance(v,float) and v.is_integer(): return int(v)
    if isinstance(v,list): return [norm(x) for x in v]
    if isinstance(v,dict): return {k:norm(x) for k,x in v.items()}
    return v
print(json.dumps(norm(json.load(sys.stdin)),sort_keys=True,ensure_ascii=False,indent=1))'; }
for p in "$@"; do
  echo "=== $p"
  diff <(curl -s "http://127.0.0.1:8072$p" | pretty) <(curl -s "http://127.0.0.1:8071$p" | pretty) && echo "identical"
done
