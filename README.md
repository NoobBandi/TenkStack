<p align="center">
  <img src="https://cdn.quantdense.com/tenkstack/tenkstack-banner.png"
       alt="TenkStack" width="820">
</p>

# TenkStack

A self-hosted control panel for a single-GPU home AI box. Built for an **Intel
Arc Pro B70** (Battlemage, 32 GB) running Linux with the `xe` driver, where the
usual CUDA-shaped tooling does not apply.

It replaced a GPUStack deployment. GPUStack is built for multi-node clusters,
and on one machine every one of its sharp edges — worker registration, the VRAM
estimator, the embedded gateway — was the cost of an architecture this box does
not have.

## What it does

- **Dashboard** — GPU power, VRAM, clock and tokens/sec, live; plus host CPU,
  memory and disk. GPU telemetry comes from `xpu-smi`, because llama-swap only
  probes for `nvidia-smi` and `rocm-smi` and reports nothing on Intel.
- **Chat** — streaming, with server-measured throughput, context-window usage,
  collapsible reasoning, image attachments and a composer that shades ``` code
  fences as you type. Sampling settings are seeded from the model's own
  llama-swap entry, so the config and the panel cannot disagree.
- **Runnable code** — HTML, SVG, React and Python blocks run in a panel beside
  the reply. React is transpiled in the frame rather than posted to a compiler
  service; Python is CPython on WebAssembly. Neither can reach the host, which
  is what the button is allowed to promise. Long blocks can be downloaded, named
  from the path the code declares for itself.
- **Models** — add, edit and remove models; optionally delete their weights from
  disk; spot orphaned files and interrupted downloads.
- **Catalog** — search Hugging Face and download GGUFs, segmented and resumable.
  Split uploads are listed as one model rather than as the fragments they
  arrive in, since no fragment is usable alone.
- **Image generation** — one row per ComfyUI instance, each with the GPU it was
  launched against, because that is fixed at start and therefore decides which
  card is free. Updates run through ComfyUI-Manager across every instance at
  once.
- **Files** — browse and fill ComfyUI's model, input and output folders.
  Uploads are chunked and resumable, streamed to disk rather than buffered, so a
  20 GB checkpoint is a transfer rather than a memory problem.
- **Users** — accounts, roles and API keys for an OpenAI-compatible endpoint.

## Architecture

```
Caddy ──┬── :8443 https  console (UI + API + /v1 proxy)
        ├── :8000 http   /v1 only, for clients that cannot trust a private CA
        └── :8444 https  ComfyUI, gated by forward_auth against the console
                │
   ┌────────────┴─────────────┐
   │                          │
FastAPI :8070            ComfyUI :8188
   │
llama-swap :8080 ──> llama-server (SYCL) per model
```

Everything except Caddy binds to loopback, so the network cannot bypass
authentication. ComfyUI has no auth of its own; publishing it on `0.0.0.0`
would hand the GPU to anyone who can reach the host.

The backend is deliberately thin. llama-swap owns model lifecycle and ComfyUI
owns image generation; this process exists to merge their state with the GPU
telemetry neither can produce on Intel, to own the two jobs neither does at all
(downloads, accounts), and to serve the result over one SSE stream.

## Design notes worth knowing

**Model configuration is `llama-swap`'s `config.yaml`.** There is no management
API for adding models, but there is `-watch-config`, so the file *is* the
interface. It is written with `ruamel.yaml` in round-trip mode: the file carries
comments explaining the VRAM policy, and `safe_dump` would delete every one of
them on the first edit made through the UI. Rendered YAML is parsed back before
it replaces the real file — emptying a commented mapping makes ruamel print
orphaned comments above a bare `{}` at column zero, which is unparseable.

**Downloads are segmented.** A single TCP stream to Hugging Face's Xet CDN
measured ~8 MiB/s from Taiwan (60 ms RTT, heavy packet reordering); eight
streams to the *same* endpoint reached 41 MiB/s. The limit is the
bandwidth-delay product of one connection, not the server or the link.

**Capabilities are measured, not declared.** Vision support is read from
llama-server's `/props`, because a `--mmproj` flag pointing at a missing file
still appears on the command line. Stopped models fall back to what the config
declares, and the response says which of the two it is.

**Numbers come from the source that owns them.** Throughput is llama-server's
own `timings`, not tokens divided by browser wall-clock, which would include
network and queue time. Time-to-first-token is measured in the browser, because
that is the thing the user actually waits for.

## Requirements

- Intel GPU with the `xe` or `i915` driver, and `xpu-smi`
- `llama.cpp` built with the SYCL backend, and **oneDNN** — `GGML_SYCL_DNN`
  defaults to ON but silently compiles itself out when `find_package(DNNL)`
  fails, and a build without it loses the XMX attention path: measured here at
  254 t/s prefill against 291 at 32k context, generation unchanged. Two apt
  packages, not one: `intel-oneapi-dnnl` carries only the shared library, while
  the headers and `dnnl-config.cmake` are in `intel-oneapi-dnnl-devel`.
- [llama-swap](https://github.com/mostlygeek/llama-swap)
- [Caddy](https://caddyserver.com/) for TLS and the single entry point
- ComfyUI via [`yanwk/comfyui-boot:xpu`](https://github.com/YanWenKun/ComfyUI-Docker)
  (native PyTorch XPU; IPEX reached EOL in March 2026)
- Python 3.12+ and Node 24+

## Running it

```bash
# Backend
cd server
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8070

# Frontend
cd web
npm install
npm run build      # served by the backend from web/dist
npm run dev        # or a dev server on :5173, proxying /api to :8070
```

### Where things live

Every path the backend touches is an environment variable with a default, all
gathered in `server/app/paths.py`. The defaults describe one arrangement —
llama-swap, the models, llama.cpp, ComfyUI and Caddy side by side under `~/ai`
— and expand against whoever is running, so an unmodified checkout works for
any user with that layout.

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_AI_DIR` | `~/ai` | Everything below is derived from this |
| `CONSOLE_STATE_DIR` | `$CONSOLE_AI_DIR/ai-console` | Session key and SQLite; the only thing the console writes |
| `CONSOLE_MODELS_DIR` | `$CONSOLE_AI_DIR/models` | GGUF weights |
| `CONSOLE_LLAMA_SWAP_DIR` | `$CONSOLE_AI_DIR/llama-swap` | |
| `CONSOLE_LLAMA_SWAP_CONFIG` | `$CONSOLE_LLAMA_SWAP_DIR/config.yaml` | |
| `CONSOLE_LLAMA_SWAP_BIN` | `$CONSOLE_LLAMA_SWAP_DIR/llama-swap` | Read for its version |
| `CONSOLE_LLAMA_CPP_DIR` | `$CONSOLE_AI_DIR/llama.cpp` | Read for its commit |
| `CONSOLE_COMFYUI_DIR` | `$CONSOLE_AI_DIR/comfyui` | Holds `storage-models/`, `storage-user/` |
| `CONSOLE_CADDY_DIR` | `$CONSOLE_AI_DIR/caddy` | Channel files the console switches |
| `CONSOLE_CADDY_BIN` | `~/.local/bin/caddy` | Installed per-user, so not under the root above |
| `CONSOLE_ONEAPI_DIR` | `/opt/intel/oneapi` | Version panel only; absent is fine |

Only a layout that differs from that one needs any of them set. Nothing is
created — a missing directory is reported as missing, because turning "not set
up" into "set up and empty" hides the difference.

Authentication switches itself on once the first account exists — requiring a
login before any account is created would lock the owner out with no way back
in.

## Not included

Operational configuration lives outside this repository: the `Caddyfile`,
llama-swap's `config.yaml`, and the ComfyUI compose scripts all contain
host-specific addresses. The session signing key and the SQLite database holding
password hashes and API keys are excluded by `.gitignore` and must never be
committed.
