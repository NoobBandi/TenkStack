#!/usr/bin/env bash
# Runs the Go tests with a throwaway PostgreSQL for the store tests:
#   scripts/test.sh [go test flags] [packages, default ./...]
# With CONSOLE_TEST_DATABASE_URL already set, that server is used instead.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib-pg.sh

if [[ -z ${CONSOLE_TEST_DATABASE_URL:-} ]]; then
  dir=$(mktemp -d)
  trap 'pg_discard; rm -rf "$dir"' EXIT
  pg_throwaway "$dir"
  export CONSOLE_TEST_DATABASE_URL=$PG_DSN
fi
# Flags alone (scripts/test.sh -count=1) still mean every package.
args=("$@")
pkgs=0
for a in "${args[@]}"; do [[ $a == -* ]] || pkgs=1; done
(( pkgs )) || args+=(./...)
go test "${args[@]}"
