# Contributing

TenkStack is one Go binary and one React page. Most changes are small, and the
ones that are not — a new GPU vendor, a new inference runtime — have their own
guides. This file is the rest: how to run it from a checkout, where things are,
and the few conventions the code actually follows.

## Running from a checkout

The installer is for users. A checkout runs without it:

```bash
# Frontend — Node 24+ and pnpm (the version web/package.json pins;
# `npx pnpm@<version>` works where pnpm is not installed)
cd web
pnpm install
pnpm build         # or pnpm dev for a dev server on :5173, proxying /api to :8070

# Backend — Go 1.27+, from the repository root
cd ..
scripts/build.sh                 # embeds web/dist, writes ./tenkstack
./tenkstack -listen 127.0.0.1:8070
# or, without embedding, straight from the tree:
CONSOLE_WEB_DIST=web/dist go run ./cmd/tenkstack
```

`--help` lists the flags. Every path the backend reads is an environment
variable with a default; the table in the README's *Where things live* lists
them. A bare checkout assumes `~/ai` as the root. Point `CONSOLE_AI_DIR`
somewhere else if your machine is laid out differently — nothing is created on
your behalf, and a missing directory is reported as missing rather than
silently made.

The backend needs `llama-swap` and, to do anything useful, a GPU with its
vendor's tooling (`xpu-smi`, `nvidia-smi`, `rocm-smi`). It starts without
them and reports what it cannot find.

## Layout

```
cmd/tenkstack/         wiring only: open the store, build the services, mount
internal/api/          every JSON body the frontend reads, and nothing else
internal/httpapi/      handlers: decode, call a domain package, encode;
                       comfy.go also holds the VRAM arbitration (makeRoom)
internal/auth users settings chats blobs   the console's own state
internal/gpu/          the Provider interface, one subpackage per vendor
internal/gpuhistory containerhistory journal   the pollers behind /api/stream
internal/llamaswap/    config.yaml round-trip, model entries, the client
internal/backends vendors containers comfy channels   the runtime layer -- see AGENTS.md
internal/catalog gguf files search visioncache images  the rest
internal/store paths ports   the leaves everything may import
internal/webdist/      the built frontend, embedded by scripts/build.sh
internal/boundary/     the import-direction test
scripts/build.sh       one static binary, version from VERSION
scripts/smoke.sh       starts a built binary and checks it, as CI does
web/src/
  pages/           one file per page in the sidebar
  components/      shared pieces; ClientSnippets.tsx writes the client configs
  api.ts           every call to the backend, typed
docs/
  llama-swap-api.md   what llama-swap answers, as observed
install.sh         the user-facing installer
AGENTS.md          how to add a GPU vendor, written for people and agents
```

## Conventions

**English for commit messages, comments and docs. Chinese for UI strings.**
The interface is Chinese; everything a contributor reads is English.

**Commit messages say why.** Read `git log` before writing one. The body
states the problem that existed, what was measured, and why this shape was
chosen over the obvious alternative. A message that only restates the diff is
not enough — the diff already says that.

**Measured, not remembered.** A claim about hardware, a driver, or an
upstream behaviour carries the number and how it was obtained, or it is
phrased as a guess. Several commits in the history exist only to replace a
remembered claim with a measured one; the help text in the GPU page went
through that twice.

**Machine-specific values stay out of the code.** Ports, paths and device
selectors come from `internal/paths`, `internal/ports` and the vendor
records. The numbers this was tuned on belong in the commit message or in
[TenkStack-Host](https://github.com/NoobBandi/TenkStack-Host), not in a
string a user will see on a different card.

**Comments explain what the code cannot.** They are the record of why
something is the way it is — a driver quirk, a llama-swap behaviour, a
measurement. Do not add comments that restate the line below them.

**Structure, checked by `go test ./...`:**

- Imports point down: `httpapi` may import domain packages; domain packages
  import only the leaves (`api`, `store`, `paths`, `ports`, `vendors`), never
  each other or `httpapi`. When one domain needs another it declares an
  interface and `cmd` wires it. The table is in `internal/boundary`; a new
  package must be added there.
- A handler never opens the database, runs a subprocess or reads a file. It
  calls a domain package and writes an `api` type.
- No package-level mutable state. Caches, locks and running jobs live in a
  struct built once in `cmd`.
- Response shapes are defined in `internal/api`, not as maps in handlers.

## Checks

```bash
go vet ./... && go test ./...

cd web
pnpm build         # check-frames, then tsc -b, then vite build
pnpm lint          # oxlint

cd ..
shellcheck -S warning install.sh scripts/*.sh
scripts/build.sh && scripts/smoke.sh ./tenkstack "$(cat VERSION)"
```

CI (`.github/workflows/ci.yml`) runs all of these, plus `gofmt`, on every
push to `main` and every pull request. `smoke.sh` starts the built binary in
an empty home and checks that it reports its version, serves the embedded
frontend and carries the setup protocol `install.sh` looks for.

`check-frames` is not optional and is not a linter: the documents injected
into sandboxed frames are template literals, and an escape written the
ordinary way (`\b`, a joined `\n`) arrives in the browser changed. The source
is valid JavaScript either way, so only the assembled string can be checked,
and `pnpm build` refuses to proceed until it passes.

The Go tests cover the pure parts: the config round-trip, log classification,
the launcher script goldens, the search ranking. Anything that talks to a
card, a container or llama-swap is verified by running it against a real one;
say what you ran in the pull request.

## Releases

`VERSION` at the root is the version. A tag `v<version>` makes the release
workflow run CI, build `tenkstack-linux-amd64` and `-arm64` with the frontend
inside, smoke-test the amd64 one and attach them to the GitHub release, which
is where `install.sh` downloads from. Bump `VERSION`, commit, then push an
annotated tag: its message is the release notes, shown on the about page.
The workflow refuses a tag that does not match `VERSION` — a binary that
reports an older version than its tag would offer itself as an update
forever.

A tag with a suffix (`v0.7.0-rc1`) is published as a pre-release. GitHub's
*latest* skips it, so no install and no update check sees it; try it with
`TENKSTACK_RELEASE=https://github.com/NoobBandi/TenkStack/releases/download/v0.7.0-rc1`
before `install.sh`, or by downloading the binary. The final tag then goes
out as usual.

## Adding a GPU vendor or a runtime

**A vendor is one record** in `internal/vendors/vendors.go` plus a
telemetry provider under `internal/gpu/`, and nothing else learns
its name. [AGENTS.md](AGENTS.md) is the complete guide: what to find out at a
shell first, the two records to implement, how to prove it works, and what a
pull request for one must report — tokens/sec on a named model at a stated
quantisation, because nothing else distinguishes a working port from one
that fell back to the CPU.

**A second llama.cpp build for a card that already has a vendor** is a
launcher, not a vendor: a macro in `config.yaml`, discovered by
`Store.Launchers` in `internal/llamaswap`.

**A different inference server** (vLLM, MLX) is neither. The `/v1` proxy
would accept it, but the model form, the flag picker and the VRAM policy all
assume `llama-server`. Open an issue describing the runtime before writing
code; the runtime layer is the next thing to be factored out, and the shape
it takes should fit the second runtime rather than be guessed from the first.

## Pull requests

- One change per pull request, with the commit message written as above.
- Say what you ran and on what: the card, the driver version, the model and
  quantisation, and the numbers. A change that touches a vendor path you
  cannot test should say so rather than imply otherwise.
- Do not commit anything from under the install root: `session.key` and the
  SQLite database are already ignored, and `config.yaml` is one machine's.

Contributions are accepted under the repository's
[Apache License 2.0](LICENSE). Its section 5 covers this: anything you submit
is licensed under the same terms, and there is no separate agreement to sign.
