# Contributing

TenkStack is one Go binary with a React frontend embedded in it, plus
`install.sh` for users. This file covers building it, the rules the code
follows, and what a pull request needs.

## Build and run

You need Go 1.27+, Node 24+ and Docker. pnpm is fetched through npx if it is
not installed.

```bash
scripts/build.sh --web               # build the frontend, then ./tenkstack with it embedded
./tenkstack -listen 127.0.0.1:8070
```

`scripts/build.sh` without `--web` embeds whatever `web/dist` already holds, so
after a frontend change always use `--web`.

For frontend work, run the dev server and the backend side by side:

```bash
cd web && pnpm install && pnpm dev   # :5173, proxies /api to 127.0.0.1:8070
go run ./cmd/tenkstack -listen 127.0.0.1:8070
```

On first start the console sets up its own PostgreSQL in Docker. If an
installed console already runs on the same machine, give your checkout its own
database with `CONSOLE_DATABASE_URL` and another `-listen` port; otherwise it
refuses to start rather than take over the installed one.

A checkout uses `~/ai` as its root. Set `CONSOLE_AI_DIR` if your layout
differs; [docs/configuration.md](docs/configuration.md) lists every variable.
The console starts without a GPU or llama-swap and reports what is missing.

## Checks

Run these before sending a change. CI runs the same on every push and pull
request.

```bash
gofmt -l cmd internal                # prints nothing when formatted
go vet ./...
scripts/test.sh                      # go test with a throwaway PostgreSQL

cd web
pnpm build                           # check-frames, type check, build
pnpm lint
cd ..

shellcheck -S warning install.sh scripts/*.sh
scripts/build.sh && scripts/smoke.sh ./tenkstack "$(cat VERSION)"
```

Plain `go test ./...` fails the database tests on purpose: they need the
database `scripts/test.sh` starts. It passes flags and packages through, for
example `scripts/test.sh -count=1 ./internal/llamaswap`.

`pnpm build` runs `check-frames` first. The code injected into the sandboxed
preview frames lives in template literals, where an escape such as `\b` or
`\n` silently changes meaning, so the assembled string is checked before
every build.

The Go tests cover the logic and the database. Anything that talks to a GPU,
a container or llama-swap has to be tried on real hardware; say what you ran
in the pull request.

## Code rules

- **English in code, Chinese in the interface.** Commit messages, comments,
  docs and logs are in English. Text a user sees in the console is
  Traditional Chinese; match the wording already on that page.
- **Explain why.** Comments and commit messages say why something is the way
  it is, not what the line does. Claims about hardware or upstream behaviour
  include the measurement, or are worded as a guess.
- **Imports point down.** Domain packages import only the shared leaf
  packages, never each other or `httpapi`. When one domain needs another, it
  declares an interface and `cmd/tenkstack` wires it.
  `internal/boundary/boundary_test.go` holds the allowed imports; a new package
  needs a row there.
- **Handlers are thin.** A handler in `internal/httpapi` decodes the request,
  calls a domain package and writes a type from `internal/api`. It does not
  open the database, run a process or read a file itself.
- **Every route says who may call it.** Use `s.owner(w, r)` for
  administrator-only routes and `s.caller(w, r)` for anyone signed in. Add
  every administrator-only route to `TestAuthorization` in
  `internal/httpapi/authz_test.go`. API keys only work on `/v1`.
- **No machine-specific values in code.** Ports, paths and device selectors
  come from `internal/ports`, `internal/paths` and the vendor records.
- **No package-level mutable state.** Caches, locks and jobs live in structs
  built once in `cmd/tenkstack`.

## Where things are

```
cmd/tenkstack/       wiring, plus the setup, provision and backup subcommands
internal/api/        every JSON type the frontend reads
internal/httpapi/    HTTP handlers; authz.go decides who may do what
internal/auth/       sessions, API keys and the first-account setup token
internal/llamaswap/  reads and writes llama-swap's config.yaml
internal/providers/  the inference engines, one directory each
internal/vendors/    each kind of GPU, once
internal/gpu/        telemetry, one subpackage per vendor
internal/sandbox/    the agent's Python sandbox
web/src/pages/       one file per page in the sidebar
web/src/api.ts       every backend call, typed
install.sh           the installer
```

Every package starts with a doc comment saying what it is for.

## Adding hardware or an engine

- **A GPU vendor** is one record in `internal/vendors/vendors.go` plus a
  telemetry provider in `internal/gpu/`. See
  [docs/adding-a-gpu-vendor.md](docs/adding-a-gpu-vendor.md).
- **An inference engine** is a directory with an `engine.yaml` and an icon,
  not code. See
  [internal/providers/engines/README.md](internal/providers/engines/README.md).
  For an engine that fits neither form described there, open an issue first.

## Pull requests

- One change per pull request.
- Say what you ran it on: the card, driver version, model, quantisation and
  the numbers. If you could not test a vendor path you touched, say so.
- Never commit anything from the install directory: `session.key`, database
  dumps or a machine's `config.yaml`.

## Releases

`VERSION` holds the version. To release, bump `VERSION`, commit, and push an
annotated tag `v<version>`; the tag message becomes the release notes. The
release workflow runs CI, builds the amd64 and arm64 binaries and publishes
them with `SHA256SUMS`. It refuses a tag that does not match `VERSION`.

A tag with a suffix such as `v0.7.0-rc1` becomes a pre-release, which installs
and update checks skip. Try one with
`TENKSTACK_RELEASE=https://github.com/NoobBandi/TenkStack/releases/download/v0.7.0-rc1`
before running `install.sh`.

## License

Contributions are accepted under the [Apache License 2.0](LICENSE)
(section 5), so there is no separate agreement to sign.
