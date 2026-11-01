# Configuration

Everything here has a working default; set something only when your machine
differs. The installer writes the values it chose into
`~/.config/systemd/user/tenkstack-console.service`. To change one, use a
drop-in (`systemctl --user edit tenkstack-console`) rather than editing the
unit, then `systemctl --user restart tenkstack-console`.

## Paths

All paths derive from one root, `CONSOLE_AI_DIR`. The installer sets it to
`~/tenkstack` and writes it into the unit explicitly, so a running
installation never moves because a default changed. A bare checkout with
nothing set uses `~/ai`. The full list is in `internal/paths/paths.go`.

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_AI_DIR` | `~/ai` (installer: `~/tenkstack`) | The root everything below derives from |
| `CONSOLE_STATE_DIR` | `$CONSOLE_AI_DIR/ai-console` | The console's own state: `session.key`, `setup-token`, the database (`postgres/`, `backups/`), chat images (`blobs/`), `huggingface-token`, image build contexts (`sandbox/`, `quant/`) |
| `CONSOLE_DATABASE_URL` | unset | Use this PostgreSQL instead of setting one up |
| `CONSOLE_MODELS_DIR` | `$CONSOLE_AI_DIR/models` | The primary model location |
| `CONSOLE_LLAMA_SWAP_DIR` | `$CONSOLE_AI_DIR/llama-swap` | llama-swap, its `config.yaml` and the engine launchers |
| `CONSOLE_LLAMA_SWAP_CONFIG` | `$CONSOLE_LLAMA_SWAP_DIR/config.yaml` | |
| `CONSOLE_LLAMA_SWAP_BIN` | `$CONSOLE_LLAMA_SWAP_DIR/llama-swap` | Read for its version |
| `CONSOLE_LLAMA_SWAP_ACTIVITY` | `$CONSOLE_LLAMA_SWAP_DIR/activity.sqlite` | llama-swap's request history, opened read-only |
| `CONSOLE_LLAMA_CPP_DIR` | `$CONSOLE_AI_DIR/llama.cpp` | A native llama.cpp build, if any |
| `CONSOLE_COMFYUI_DIR` | `$CONSOLE_AI_DIR/comfyui` | ComfyUI's `storage-models/` and `storage-user/` |
| `CONSOLE_CADDY_DIR` | `$CONSOLE_AI_DIR/caddy` | The Caddyfile and the channel files the console switches |
| `CONSOLE_CADDY_BIN` | `~/.local/bin/caddy` | |
| `CONSOLE_ONEAPI_DIR` | `/opt/intel/oneapi` | Only shown on the version panel; absent is fine |

The console creates none of these. A missing directory is reported as
missing, so "not set up" never looks like "set up and empty".

Besides its state directory, the console writes to llama-swap's
`config.yaml` and the launchers beside it, Caddy's channel files, the model
locations, ComfyUI's storage, its own PostgreSQL unit under
`~/.config/systemd/user/`, and its own binary when updated from 關於.

## Ports

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_PORT` | `8070` | The console, on loopback behind Caddy |
| `CONSOLE_TLS_PORT` | `8443` | Caddy: the interface and `/v1` |
| `CONSOLE_API_PORT` | `8000` | Caddy: plain-HTTP `/v1` only |
| `CONSOLE_LLAMA_SWAP_PORT` | `8080` | llama-swap; `/v1` is proxied here |
| `CONSOLE_COMFYUI_PORT` | `8188` | The first loopback port of a ComfyUI instance |
| `CONSOLE_COMFYUI_COUNT` | `4` | How many ComfyUI instances, one port each |
| `CONSOLE_COMFYUI_PUBLIC_PORT` | `8444` | The first port Caddy serves ComfyUI on |

The installer writes the console, llama-swap, Caddy and SearXNG ports into
the unit. The ComfyUI ports keep their defaults unless set in a drop-in.

## Other settings

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_LISTEN` | `127.0.0.1:8071` | Where the binary serves; `-listen` overrides it, and the installed unit passes `-listen 127.0.0.1:$CONSOLE_PORT` |
| `CONSOLE_WEB_DIST` | unset | Serve the frontend from this directory instead of the embedded copy (same as `-web`) |
| `CONSOLE_SEARXNG_URL` | `http://127.0.0.1:8090` | Where the agent's searches go |
| `CONSOLE_FILE_ROOTS` | your home, plus `/mnt` and `/media` when not empty | What the file browser may reach besides the model and ComfyUI directories (always offered): `label=path` entries separated by `;`, with `ro:` before a path to make it read-only |
| `CONSOLE_FILE_DENY` | unset | Extra paths refused from every root, separated by `:`. Always refused: the state directory, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube` and a few more |
| `TENKSTACK_REPO` | `NoobBandi/TenkStack` | The GitHub repository the update check asks |
| `TENKSTACK_RELEASE_API` | `https://api.github.com` | The API it asks, for a mirror or a test server |

`install.sh` reads its own `TENKSTACK_REPO`, and there it is a git URL for
`--source`, not `owner/repo`.

## Model locations

Models can live in up to five directories. The primary is
`CONSOLE_MODELS_DIR`; add others under 設定 → 模型存放 → 存放位置. Each becomes
a llama-swap macro, `models-dir-2` to `models-dir-5`, so a model entry names
a file as `${models-dir-2}/owner/repo/file.gguf`. GGUF and safetensors each
have their own default download location, so llama.cpp and vLLM weights can
live on different disks.

## The database

Accounts, API keys, conversations and settings are in PostgreSQL, which the
console runs for itself. On first start it writes `tenkstack-postgres.service`,
a user unit running the official `postgres` image with its files in
`$CONSOLE_STATE_DIR/postgres`. The container has no network and the server
listens only on a unix socket that only the console's user can reach, so
there is no password to keep.

```bash
tenkstack backup              # writes $CONSOLE_STATE_DIR/backups/console-<time>.dump
docker exec -i tenkstack-postgres pg_restore -U tenkstack -d tenkstack --clean --if-exists < FILE
```

An install from before PostgreSQL imports its SQLite file on that first
start and keeps it as `console.sqlite.migrated-*`.
