# AI Console

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
  fences as you type.
- **Models** — add, edit and remove models; optionally delete their weights from
  disk; spot orphaned files and interrupted downloads.
- **Catalog** — search Hugging Face and download GGUFs, segmented and resumable.
- **Image generation** — ComfyUI queue, recent output and native UI, behind the
  console's login.
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
- `llama.cpp` built with the SYCL backend
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

Paths to the models directory, llama-swap config and state are currently
constants at the top of `server/app/*.py`. They assume `~/ai/...` and would need
changing for another host.

Authentication switches itself on once the first account exists — requiring a
login before any account is created would lock the owner out with no way back
in.

## Not included

Operational configuration lives outside this repository: the `Caddyfile`,
llama-swap's `config.yaml`, and the ComfyUI compose scripts all contain
host-specific addresses. The session signing key and the SQLite database holding
password hashes and API keys are excluded by `.gitignore` and must never be
committed.
