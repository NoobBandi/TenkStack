# Notes for coding agents

TenkStack is one Go binary (the module is the repository root) with a React +
antd frontend in `web/` embedded into it, and `install.sh` for users. This
file is the short list of what a change has to respect. The long versions are
[CONTRIBUTING.md](CONTRIBUTING.md) — layout, conventions, checks, releases —
and [docs/adding-a-gpu-vendor.md](docs/adding-a-gpu-vendor.md) for porting a
new kind of card. A new inference engine is a record, described in
[internal/providers/engines/README.md](internal/providers/engines/README.md).

## Build and test

```bash
scripts/build.sh --web          # frontend, then the binary with it embedded: ./tenkstack
scripts/build.sh                # binary only, embedding whatever web/dist holds (may be stale)
scripts/test.sh                 # go test ./... with a throwaway PostgreSQL in Docker
scripts/test.sh -count=1 ./internal/llamaswap   # flags and packages pass through
go vet ./... && gofmt -l cmd internal

cd web
pnpm exec tsc -b                # type check only
pnpm build                      # check-frames, tsc -b, vite build
pnpm lint                       # oxlint
```

Plain `go test ./...` fails the database tests by design: they need
`CONSOLE_TEST_DATABASE_URL`, which `scripts/test.sh` provides. To run the
console from a checkout, `go run ./cmd/tenkstack -listen 127.0.0.1:8070`
(the port `pnpm dev` proxies to); next to an installed console, set
`CONSOLE_DATABASE_URL` to a database of its own or it refuses to start.

## Rules

- **English in code, Chinese in the UI.** Commit messages, comments, docs and
  log lines are English. Every string a user sees in the interface is
  Traditional Chinese; match the wording already used on that page.
- **Comments and commit messages say why**, not what the line does. A claim
  about hardware or an upstream behaviour carries the measurement, or is
  phrased as a guess.
- **Imports point down.** `internal/boundary/boundary_test.go` holds the table
  of which internal package may import which. Domain packages import only the
  shared leaves, never each other or `httpapi`; a new package needs a row
  there or the test fails.
- **Handlers are thin.** A handler in `internal/httpapi` decodes, calls a
  domain package and writes a type from `internal/api`; it does not open the
  database, run a subprocess or read a file itself.
- **Admin versus member.** Signing in lets someone use the machine: chat,
  load and unload models, manage their own password and API keys. Changing it
  for everyone — accounts, models and files on disk, settings, channels,
  ComfyUI's version, engines, benchmarks — is the administrator's. A handler
  says which with `s.owner(w, r)` (administrator only) or `s.caller(w, r)`
  (anyone signed in, told whether they are the administrator). Every
  administrator-only route is listed in `TestAuthorization` in
  `internal/httpapi/authz_test.go`, which checks a member gets 403; add a new
  one there in the same change. API keys work only on `/v1`, never `/api`.
- **No machine-specific values in code.** Ports, paths and device selectors
  come from `internal/ports`, `internal/paths` and the vendor records.
- **Verified means run.** An engine build's `verified:` or a vendor's
  `Comfy.Verified` becomes true only in a change that reports running it on
  that vendor's card.
