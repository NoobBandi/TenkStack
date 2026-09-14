# Contributing

TenkStack is one FastAPI process and one React page. Most changes are small,
and the ones that are not — a new GPU vendor, a new inference runtime — have
their own guides. This file is the rest: how to run it from a checkout, where
things are, and the few conventions the code actually follows.

## Running from a checkout

The installer is for users. A checkout runs without it:

```bash
# Backend — Python 3.12+, uv
cd server
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8070

# Frontend — Node 24+
cd web
npm install
npm run build      # served by the backend from web/dist
npm run dev        # or a dev server on :5173, proxying /api to :8070
```

Every path the backend reads is an environment variable with a default; the
table in the README's *Where things live* lists them. A bare checkout assumes
`~/ai` as the root. Point `CONSOLE_AI_DIR` somewhere else if your machine is
laid out differently — nothing is created on your behalf, and a missing
directory is reported as missing rather than silently made.

The backend needs `llama-swap` and, to do anything useful, a GPU with its
vendor's tooling (`xpu-smi`, `nvidia-smi`, `rocm-smi`). It starts without
them and reports what it cannot find.

## Layout

```
server/app/
  main.py          routes, the /v1 proxy, VRAM arbitration (make_room_for)
  config.py        llama-swap's config.yaml, read and written round-trip
  backends.py      which launchers exist and which cards they can see
  vendors/         one file per GPU vendor -- see AGENTS.md
  gpu/             telemetry providers, one per vendor
  comfy.py         ComfyUI instances, one per card
  containers.py    docker survey; which container holds which card
  catalog.py       Hugging Face search and segmented downloads
  gguf.py          reads a GGUF header, local or ranged over HTTP
  files.py         the file browser, with its roots and deny list
  vision_cache.py  keeps images out of turns a draft model would choke on
  paths.py, ports.py   every path and port, from the environment
server-go/           the Go port of the backend, in progress -- see below
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
selectors come from `paths.py`, `ports.py` and the vendor records. The
numbers this was tuned on belong in the commit message or in
[TenkStack-Host](https://github.com/NoobBandi/TenkStack-Host), not in a
string a user will see on a different card.

**Comments explain what the code cannot.** The codebase is dense with them,
and they are the record of why something is the way it is — a driver quirk,
a llama-swap behaviour, a measurement. Match that density when you touch a
file; do not add comments that restate the line below them.

## Checks

```bash
cd web
npm run build      # check-frames, then tsc -b, then vite build
npm run lint       # oxlint
```

`check-frames` is not optional and is not a linter: the documents injected
into sandboxed frames are template literals, and an escape written the
ordinary way (`\b`, a joined `\n`) arrives in the browser changed. The source
is valid JavaScript either way, so only the assembled string can be checked,
and `npm run build` refuses to proceed until it passes.

There is no Python test suite yet. `server/tests/test_passages.py` is a
script, not a test. Changes to the backend are verified by running them
against a real llama-swap; say what you ran in the pull request.

## The Go port

The backend is being moved to Go under `server-go/`, one route at a time,
against the same SQLite file and the same wire format. The frontend does not
change. Until the port is complete the Python backend is what runs; do not
add features to it that the Go side would then have to catch up with.

```
server-go/
  cmd/tenkstack/     wiring only: open the store, build the services, mount
  internal/api/      every JSON body the frontend reads, and nothing else
  internal/httpapi/  handlers: decode, call a domain package, encode
  internal/auth/     sessions and API-key identity
  internal/users/    accounts and keys
  internal/llamaswap/  config.yaml, read and written without losing comments
  internal/store/    opens SQLite with the pragmas this workload needs
  internal/paths/    every location, from the environment
  internal/boundary/ the import-direction test
  scripts/parity.sh  runs both backends side by side and diffs each route
```

Rules, checked by `go test ./...`:

- Imports point down: `httpapi` may import domain packages; domain packages
  import only `api`, `store` and `paths`, never each other or `httpapi`. When
  one domain needs another it declares an interface and `cmd` wires it. The
  table is in `internal/boundary`; a new package must be added there.
- A handler never opens the database, runs a subprocess or reads a file. It
  calls a domain package and writes an `api` type.
- No package-level mutable state. Caches, locks and running jobs live in a
  struct built once in `cmd`.
- Response shapes are defined in `internal/api`, not as maps in handlers.
  `scripts/parity.sh` is the acceptance test: it runs the Python backend and
  the Go binary on a throwaway state directory and calls every ported route
  on both; a DIFF line is a bug in one of them.

```bash
cd server-go
go vet ./... && go test ./...
./scripts/parity.sh
```

## Adding a GPU vendor or a runtime

**A vendor is one file** in `server/app/vendors/`, and nothing else learns its
name. [AGENTS.md](AGENTS.md) is the complete guide: what to find out at a
shell first, the two records to implement, how to prove it works, and what a
pull request for one must report — tokens/sec on a named model at a stated
quantisation, because nothing else distinguishes a working port from one
that fell back to the CPU.

**A second llama.cpp build for a card that already has a vendor** is a
launcher, not a vendor: a macro in `config.yaml`, discovered by
`backends._launchers()`.

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
