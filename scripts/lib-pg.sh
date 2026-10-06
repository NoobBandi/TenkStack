# shellcheck shell=bash
# Sourced by test.sh and smoke.sh: a throwaway PostgreSQL on a unix socket.
#   pg_throwaway DIR   starts it with its files in DIR, waits, and sets PG_DSN
#   pg_discard         removes it again (safe to call when none was started)
# Call pg_throwaway directly, not in $(...): a subshell would keep PG_NAME
# to itself and pg_discard would have nothing to remove.
# The image is internal/pgserver's (TestImageIsTheSameEverywhere checks).
PG_IMAGE=docker.io/library/postgres:18-alpine
PG_NAME=""
PG_DSN=""

pg_throwaway() {
  local dir=$1
  PG_NAME=tenkstack-throwaway-pg-$$
  mkdir -p "$dir/data" "$dir/run"
  docker run -d --rm --name "$PG_NAME" --network none --user "$(id -u):$(id -g)" \
    -v "$dir/data:/var/lib/postgresql" -v "$dir/run:/var/run/postgresql" \
    -e POSTGRES_USER=tenkstack -e POSTGRES_DB=tenkstack -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" -c listen_addresses= -c fsync=off >/dev/null
  # -U: the container has no account for the uid it runs as, and pg_isready
  # without one makes "no attempt" rather than checking.
  local _
  for _ in $(seq 1 120); do
    docker exec "$PG_NAME" pg_isready -q -U tenkstack 2>/dev/null && break
    sleep 0.5
  done
  docker exec "$PG_NAME" pg_isready -q -U tenkstack || { docker logs "$PG_NAME" >&2; return 1; }
  # shellcheck disable=SC2034 # read by the script that sourced this one
  PG_DSN="host=$dir/run user=tenkstack dbname=tenkstack sslmode=disable"
}

pg_discard() {
  if [[ -n $PG_NAME ]]; then docker rm -f "$PG_NAME" >/dev/null 2>&1 || true; fi
}
