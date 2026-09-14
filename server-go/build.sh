#!/bin/bash
# Build the console as one static binary with the frontend inside it.
#
#   server-go/build.sh            embed the web/dist that is there, build
#   server-go/build.sh --web      build the frontend first (needs node)
#   GOARCH=arm64 server-go/build.sh   cross-compile
#
# The result is server-go/tenkstack. The version comes from VERSION at the
# repository root.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
REPO=$(cd .. && pwd)

if [[ ${1:-} == --web ]]; then
  (cd "$REPO/web" && npm ci --silent && npm run build --silent)
fi
if [[ ! -f $REPO/web/dist/index.html ]]; then
  echo "web/dist is not built; run with --web or build the frontend first" >&2
  exit 1
fi

# Copied rather than linked: go:embed does not follow symlinks or leave the
# module directory. PLACEHOLDER stays: it is the committed file that keeps
# the embed pattern valid on a checkout without a frontend build.
find internal/webdist/dist -mindepth 1 ! -name PLACEHOLDER -delete
cp -r "$REPO/web/dist/." internal/webdist/dist/

VERSION=$(tr -d '[:space:]' < "$REPO/VERSION")
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o tenkstack ./cmd/tenkstack
echo "built tenkstack $VERSION ($(go env GOOS)/$(go env GOARCH), $(du -h tenkstack | cut -f1))"
