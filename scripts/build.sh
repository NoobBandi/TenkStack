#!/bin/bash
# Build the console as one static binary with the frontend inside it.
#
#   scripts/build.sh              embed the web/dist that is there, build
#   scripts/build.sh --web        build the frontend first (needs node; pnpm
#                                 is fetched through npx when not installed)
#   GOARCH=arm64 scripts/build.sh cross-compile
#
# The result is ./tenkstack at the repository root. The version comes from
# VERSION beside it.
set -euo pipefail
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
cd "$REPO"

if [[ ${1:-} == --web ]]; then
  # The pnpm package.json pins, through npx when pnpm is not installed:
  # npm comes with every Node, pnpm does not.
  pnpm=(pnpm)
  if ! command -v pnpm >/dev/null; then
    pnpm=(npx --yes "$(node -p 'require(process.argv[1]).packageManager' "$REPO/web/package.json")")
  fi
  (cd "$REPO/web" && "${pnpm[@]}" install --frozen-lockfile --silent && "${pnpm[@]}" --silent build)
fi
if [[ ! -f $REPO/web/dist/index.html ]]; then
  echo "web/dist is not built; run with --web or build the frontend first" >&2
  exit 1
fi

# Copied rather than linked: go:embed does not follow symlinks or leave the
# package directory. PLACEHOLDER stays: it is the committed file that keeps
# the embed pattern valid on a checkout without a frontend build.
find internal/webdist/dist -mindepth 1 ! -name PLACEHOLDER -delete
cp -r "$REPO/web/dist/." internal/webdist/dist/

VERSION=$(tr -d '[:space:]' < "$REPO/VERSION")
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o tenkstack ./cmd/tenkstack
echo "built tenkstack $VERSION ($(go env GOOS)/$(go env GOARCH), $(du -h tenkstack | cut -f1))"
