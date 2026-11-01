# Contributing

TenkStack is one Go binary and one React page. Most changes are small, and the
ones that are not — a new GPU vendor, a new inference runtime — have their own
guides. This file is the rest: how to run it from a checkout, where things are,
and the few conventions the code actually follows.

## Running from a checkout

The installer is for users. A checkout runs without it:

```bash
# Everything at once — Go 1.27+ and Node 24+; pnpm is fetched through npx
# when it is not installed
scripts/build.sh --web           # builds web/dist, embeds it, writes ./tenkstack
./tenkstack -listen 127.0.0.1:8070

# Or the frontend on its own, with a dev server
cd web
pnpm install
pnpm dev           # :5173, proxying /api to 127.0.0.1:8070
cd ..
# ...and the backend straight from the tree, on the port the dev server expects
# (the binary's own default is 127.0.0.1:8071)
go run ./cmd/tenkstack -listen 127.0.0.1:8070
# serving a built frontend from disk instead of the embedded copy:
CONSOLE_WEB_DIST=web/dist go run ./cmd/tenkstack -listen 127.0.0.1:8070
```

`scripts/build.sh` without `--web` embeds whatever `web/dist` already holds and
refuses to build when there is none; a binary built after a frontend change
but without `--web` (or a fresh `pnpm build`) ships the old frontend.

The console sets up its own PostgreSQL on first start (a Docker container
under a systemd user unit; see the README's *The database*). On a machine
where an installed console already runs, give a checkout a database of its own
with `CONSOLE_DATABASE_URL`, or with a different `CONSOLE_AI_DIR` it refuses to
start rather than take over the installed one's unit. The installed console
also holds `127.0.0.1:8070`, so there the checkout needs another `-listen`
port, and `pnpm dev` the same port as its proxy target in `web/vite.config.ts`.

`--help` lists the flags. Every path the backend reads is an environment
variable with a default; the table in the README's *Where things live* lists
them. A bare checkout assumes `~/ai` as the root. Point `CONSOLE_AI_DIR`
somewhere else if your machine is laid out differently — nothing is created on
your behalf, and a missing directory is reported as missing rather than
silently made.

The backend needs `llama-swap` and, to do anything useful, a GPU with its
vendor's tooling (`xpu-smi`, `nvidia-smi`, `amd-smi` or `rocm-smi`; the AMD
path is unverified on real hardware). It starts without them and reports what
it cannot find.

## Layout

Each line below is the first sentence of the package's own doc comment,
shortened; the comment says more.

```
cmd/tenkstack/          wiring only: open the store, build the services, mount;
                        also the `setup`, `provision` and `backup` subcommands
internal/
  api/                  the wire types: every JSON body the frontend reads
  httpapi/              the HTTP surface: decode, call a domain package, encode;
                        comfy.go also holds the VRAM arbitration (makeRoom),
                        authz.go who may do what
  activity/             per-request history from llama-swap's own store, read-only
  auth/                 who is calling: a signed session cookie, or an API key
  backends/             which cards a configured llama-server can run a model on,
                        and installing the engines' launchers
  bench/                the benchmark suite (跑分) against one model, and its results
  blobs/                images on disk, addressed by their contents
  boundary/             the import-direction test
  catalog/              Hugging Face search and segmented downloads, GGUF or safetensors
  channels/             which ways in are open, as Caddy site blocks and binds
  chats/                conversation history
  comfy/                finds, creates and drives the ComfyUI instances, one per card
  containerhistory/     each container's CPU, memory and network, from cgroup and /proc
  containers/           lists and controls containers; cannot create, exec or remove
  files/                the file browser: declared roots and a deny list
  flags/                the launch flags a binary actually has, from its --help
  gguf/                 GGUF headers: metadata and the tensor directory
  gpu/                  the Provider interface, one subpackage per vendor
                        (intel/, nvidia/, amd/)
  gpuhistory/           a window of samples of every card
  hfmodel/              what a model's config.json says about it
  hftoken/              the owner's Hugging Face access token
  images/               re-encodes the image formats llama.cpp cannot decode
  journal/              one log stream: the systemd journal and `docker logs`
  llamaswap/            config.yaml round-trip, model entries, the client
  locations/            model locations, at most five, each a llama-swap macro
  network/              how this host can be reached: ports, addresses, units
  paths/                where everything lives, one environment variable each
  pgserver/             the console's own PostgreSQL: its unit, its socket, backups
  ports/                every port the console assumes, one environment variable each
  profile/              names the machine, model and engine the way a benchmark run records them
  providers/            the registry of inference engines; one directory each under
                        engines/ (see its README)
  quant/                bf16 safetensors into a smaller quantised copy, via auto-round
  registry/             what a container registry holds for an image: tags, digests
  release/              the update check against GitHub, and the binary swap
  sandbox/              the agent's Python, a gVisor container per conversation;
                        image/ is what that container is built from
  schema/               the benchmark's record format
  search/               SearXNG queries and page reading for the agent
  settings/             the console's own knobs, with their defaults in Specs
  setup/                the installer's interactive half: `tenkstack setup` and `provision`
  store/                opens PostgreSQL, applies migrations/, imports old SQLite data once
                        (storetest/ gives each test a schema of its own)
  system/               host CPU, memory and disk from /proc and statfs
  tuning/               a launch command read into a benchmark run's parameters
  users/                accounts and API keys
  vendors/              each kind of card, once: backend name, selector, images,
                        how a card reaches a container and is read back
  versions/             what is installed and running, each probe on its own
  visioncache/          sends an image to the model once, then its description
  webdist/              the built frontend, embedded by scripts/build.sh
scripts/build.sh        one static binary, version from VERSION; --web builds the frontend first
scripts/smoke.sh        starts a built binary and checks it, as CI does
scripts/test.sh         go test with a throwaway PostgreSQL (scripts/lib-pg.sh)
web/src/
  pages/                one file per page in the sidebar, plus the login page
  components/           shared pieces; ClientSnippets.tsx writes the client configs
  api.ts                every call to the backend, typed
docs/
  llama-swap-api.md     what llama-swap answers, as observed
  adding-a-gpu-vendor.md  how to port a new kind of card
install.sh              the user-facing installer
AGENTS.md               the short version of this file, for coding agents
SECURITY.md             reporting a vulnerability, and the security model
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

**Structure, checked by `scripts/test.sh`:**

- Imports point down: `httpapi` may import domain packages; domain packages
  import only the shared leaves, never each other or `httpapi`. The leaves are
  `api`, `schema`, `paths`, `ports`, `store`, `pgserver`, `vendors`,
  `webdist`, `locations`, `hfmodel`, `hftoken` and `providers`, and each
  domain package may import only the ones its row in the table names. When
  one domain needs another it declares an interface and `cmd` wires it. The
  table is in `internal/boundary/boundary_test.go`; a new package must be
  added there, and the test fails until it is.
- Who may call a route is decided in the handler, with `s.owner` (the
  administrator only) or `s.caller` (anyone signed in, told whether they are
  the administrator). A route that changes the machine for everyone is the
  administrator's, and `TestAuthorization` in `internal/httpapi/authz_test.go`
  lists every such route and checks a member gets 403; a new one goes in that
  list. API keys never reach `/api` at all — the middleware keeps them to
  `/v1`.
- A handler never opens the database, runs a subprocess or reads a file. It
  calls a domain package and writes an `api` type.
- No package-level mutable state. Caches, locks and running jobs live in a
  struct built once in `cmd`.
- Response shapes are defined in `internal/api`, not as maps in handlers.

## Checks

```bash
gofmt -l cmd internal             # prints nothing when everything is formatted
go vet ./... && scripts/test.sh   # go test, with a throwaway PostgreSQL in Docker

cd web
pnpm build         # check-frames, then tsc -b, then vite build
pnpm lint          # oxlint

cd ..
shellcheck -S warning install.sh scripts/*.sh
scripts/build.sh && scripts/smoke.sh ./tenkstack "$(cat VERSION)"
```

Plain `go test ./...` fails the store-backed tests on purpose: they need
`CONSOLE_TEST_DATABASE_URL`, which `scripts/test.sh` sets after starting a
throwaway PostgreSQL in Docker (or uses, if it is already set). A missing
database is a failure rather than a skip, because a skipped store test reads
as a passing one. `scripts/test.sh` takes `go test` flags and packages:
`scripts/test.sh -count=1 ./internal/llamaswap`.

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main` and
every pull request, with a PostgreSQL service for the tests. `smoke.sh` starts
the built binary in an empty home and checks that it reports its version,
serves the embedded frontend and carries the setup protocol `install.sh` looks
for.

`check-frames` is not optional and is not a linter: the documents injected
into sandboxed frames are template literals, and an escape written the
ordinary way (`\b`, a joined `\n`) arrives in the browser changed. The source
is valid JavaScript either way, so only the assembled string can be checked,
and `pnpm build` refuses to proceed until it passes.

The Go tests cover the pure parts — the config round-trip, log
classification, the launcher script goldens, the search ranking, the engine
records — plus the database-backed stores and who may call what. Anything that talks to a
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
its name. [docs/adding-a-gpu-vendor.md](docs/adding-a-gpu-vendor.md) is the
complete guide: what to find out at a
shell first, the two records to implement, how to prove it works, and what a
pull request for one must report — tokens/sec on a named model at a stated
quantisation, because nothing else distinguishes a working port from one
that fell back to the CPU.

**A second llama.cpp build for a card that already has a vendor** is a
launcher, not a vendor: a macro in `config.yaml`, discovered by
`Store.Launchers` in `internal/llamaswap`.

**A different inference engine** is a record, not code: a directory under
`internal/providers/engines/` with an `engine.yaml` and an icon, the way
llama.cpp, vLLM and SGLang are. It appears on the 推論引擎 page, installs on
the cards it has a build for, and its models are edited on the 模型 page with
nothing else changed. [internal/providers/engines/README.md](internal/providers/engines/README.md)
describes the record and what a pull request for one must report. An engine
that fits neither of the two forms there (llama.cpp's, or an OpenAI-compatible
server of one folder of weights) is a code change: open an issue first.
Apple Silicon (MLX) is a port rather than an engine, for reasons the vendor
guide sets out.

## Pull requests

- One change per pull request, with the commit message written as above.
- Say what you ran and on what: the card, the driver version, the model and
  quantisation, and the numbers. A change that touches a vendor path you
  cannot test should say so rather than imply otherwise.
- Do not commit anything from under the install root: `session.key` and
  database dumps are already ignored, and `config.yaml` is one machine's.

Contributions are accepted under the repository's
[Apache License 2.0](LICENSE). Its section 5 covers this: anything you submit
is licensed under the same terms, and there is no separate agreement to sign.
