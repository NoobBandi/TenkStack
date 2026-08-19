<p align="center">
  <img src="https://cdn.quantdense.com/tenkstack/tenkstack-banner.png"
       alt="TenkStack" width="820">
</p>

# TenkStack

A self-hosted control panel for a home AI box. Built around an **Intel Arc Pro
B70** (Battlemage, 32 GB) on Linux with the `xe` driver, where the usual
CUDA-shaped tooling does not apply. A second card went in later — an NVIDIA RTX
3060 for image generation — so every surface reports per card rather than per
machine.

It replaced a GPUStack deployment. GPUStack is built for multi-node clusters,
and on one machine every one of its sharp edges — worker registration, the VRAM
estimator, the embedded gateway — was the cost of an architecture this box does
not have.

## What it does

- **Dashboard** — one block per GPU: power, VRAM, clock and tokens/sec, live,
  with needle-less gauges for host CPU, memory and disk beside them and a chart
  that switches cards from a dropdown. GPU telemetry comes from `xpu-smi` and
  `nvidia-smi` together, because llama-swap probes only for the latter and
  reports nothing on Intel.
- **Chat** — streaming, with server-measured throughput, context-window usage,
  image attachments and a composer that shades ``` code fences as you type.
  Sampling settings are seeded from the model's own llama-swap entry, so the
  config and the panel cannot disagree.
- **Agent** — the model runs Python to answer, up to eight steps, choosing what
  to do next from what came back, and searches the web the same way. One trace
  above the reply carries the working in the order it happened: each thought,
  each program, its output, its figures, and the pages a search actually read —
  a citation nobody can follow is decoration.
- **Previews** — HTML, SVG, React, Markdown and Python open in a panel beside
  the reply, HTML and Markdown as the document they describe rather than as
  source. React is transpiled in the frame instead of being posted to a compiler
  service; Python is CPython on WebAssembly. Nothing in a frame can reach the
  host, which is what the button is allowed to promise.
- **Models** — add, edit and remove models; optionally delete their weights from
  disk; spot orphaned files and interrupted downloads. One vision projector can
  serve several models, and each entry says which it is using.
- **Catalog** — search Hugging Face and download GGUFs, segmented and resumable,
  into per-repo folders so two publishers' identically named quants stay
  distinct. Split uploads are listed as one model rather than as the fragments
  they arrive in, since no fragment is usable alone. Any quant can be asked what
  it would generate at *on this card* before the download starts, worked out
  from the file's own header.
- **ComfyUI** — one row per instance, each with the GPU it was launched against,
  because that is fixed at start and therefore decides which card is free.
  Updates run through ComfyUI-Manager across every instance at once.
- **Files** — the whole disk rather than one application's folders: declared
  roots, a deny list the console cannot be talked out of, and previews for
  images, text, and weights — a GGUF or safetensors header is read in place, so
  a 20 GB file answers what it is without being moved. Uploads are chunked and
  resumable, streamed to disk rather than buffered.
- **Users** — accounts, roles and API keys for an OpenAI-compatible endpoint.

## Architecture

```
Caddy ──┬── :8443 https  console (UI + API + /v1 proxy)
        ├── :8000 http   /v1 only, for clients that cannot trust a private CA
        └── :8444 https  ComfyUI, gated by forward_auth against the console
                │
        FastAPI :8070 ──┬── llama-swap :8080 ──> llama-server (SYCL) per model
                        ├── ComfyUI :8188, one instance per GPU
                        └── SearXNG :8090, what the agent's searches go through
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

**Speed is estimated from the header, not from the file size.** Hugging Face
serves ranged requests on GGUF files, and a GGUF opens with a complete
description of itself: the architecture metadata, then a directory naming every
tensor with its shape and quantisation type. Eight megabytes of a twenty
gigabyte file is enough to answer how fast it would run, because generation is
bandwidth-bound — bytes read per token over what the card delivers, plus a fixed
cost per block. Two details separate that from `size / bandwidth`, and both are
counted from the tensor names: a mixture-of-experts model reads a fraction of
itself (Qwen3-30B-A3B Q4_K_M is 17.3 GiB of file but 1.95 GiB of reading, since
8 of its 128 experts run per token), and a hybrid model caches on a minority of
its layers (Qwen3.8-27B declares 65 blocks; 17 of them hold a KV cache). The
constants are measured on this card — 568 GB/s from the Q6_K mat-vec kernel,
9.8 ms per token of launch overhead — which matters because the B70 will not
report its own memory bandwidth to anything: `xpu-smi` answers with a −1
sentinel and Level Zero answers 64-bit at 2800 MHz, off by an order of
magnitude. The estimate lands on the model measured here to within 0.3%; where a
file is known to break the assumption, the row says so instead of carrying a
correction factor.

**Capabilities are measured, not declared.** Vision support is read from
llama-server's `/props`, because a `--mmproj` flag pointing at a missing file
still appears on the command line. Stopped models fall back to what the config
declares, and the response says which of the two it is.

**A sandboxed frame has no origin.** The frames that run code carry
`sandbox="allow-scripts"` and deliberately not `allow-same-origin`, so their
origin is opaque and every request they make arrives with `Origin: null`. That
one fact decides two designs: the agent's web search runs on the server, because
almost nothing accepts that origin, and the CJK font matplotlib needs is served
from a route outside `/api` with a wildcard — the one thing here that reveals
nothing by being readable from anywhere. Messages from a frame are checked with
`event.source === frame.contentWindow`, never `event.origin`, which is `"null"`
for any sandboxed frame including a hostile one.

**The documents injected into those frames are checked before every build.**
They are template literals, so an escape written the ordinary way arrives
changed: `\b` became a backspace inside a regex, and a joined `\n` became a real
newline that left an unterminated string. Neither is visible in the source,
because the source is valid JavaScript either way — the mistake exists only in
the string the browser is handed, which is where `npm run check:frames` looks.

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
- [SearXNG](https://github.com/searxng/searxng) on loopback, if the agent should
  be able to search. Optional: the tool is offered to the model only when the
  instance answers, so an absent one removes the capability rather than breaking
  the chat.
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

Three more live with the code that reads them rather than in `paths.py`, because
none of them names a single location: `CONSOLE_FILE_ROOTS` declares what the file
browser may reach (`label=path`, separated by `;`, `ro:` in front of a path to
refuse writes) and replaces the defaults rather than adding to them, since
narrowing the set is the only reason to write it; `CONSOLE_FILE_DENY` adds paths
that are refused from every root; and `CONSOLE_SEARXNG_URL` says where searches
go, defaulting to `http://127.0.0.1:8090`.

Authentication switches itself on once the first account exists — requiring a
login before any account is created would lock the owner out with no way back
in.

## Not included

Operational configuration lives outside this repository: the `Caddyfile`,
llama-swap's `config.yaml`, and the ComfyUI and SearXNG launch scripts all
contain host-specific addresses. The session signing key and the SQLite database holding
password hashes and API keys are excluded by `.gitignore` and must never be
committed.
